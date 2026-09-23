/* NetLab — IP-узел: общий стек для ПК, серверов, маршрутизаторов и коммутаторов 3-го уровня.
 * ARP (с очередью пакетов, пока адрес разрешается — первый ping не теряется), proxy ARP,
 * IPv4, ICMP, UDP, TCP, маршрутизация (подключённые, статические, RIP/OSPF) с учётом
 * административного расстояния, serial-каналы, loopback, ACL, NAT, DHCP-клиент. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;

  const ARP_TIMEOUT = 30;
  const ARP_RETRIES = 3;
  const ARP_QUEUE = 64;
  const ARP_AGE = 60000;
  const DHCP_RETRY = 150;
  const DHCP_TRIES = 3;
  const PROBE_WAIT = 20;

  const ERR_TEXT = {
    'no-route': 'Нет маршрута до узла назначения',
    'no-ip': 'У интерфейса нет IP-адреса',
    'arp-fail': 'Заданный узел недоступен (нет ответа на ARP)',
    down: 'Интерфейс не активен (кабель, питание или shutdown)',
    off: 'Устройство выключено',
    queue: 'Очередь ожидания ARP переполнена',
  };

  const AD = { C: 0, L: 0, S: 1, O: 110, R: 120, D: 254 };

  class IpNode extends NS.Device {
    constructor(net, id, type, name, model) {
      super(net, id, type, name, model);
      this.ifaces = [];
      this.routes = [];
      this.dynRoutes = [];
      this.forwarding = false;
      this.proxyArp = true;
      this.defaultTtl = 128;
      this.ifSeq = 1;
      this.jobs = new Set();
      this.acls = new Map();
      this.nat = null;
      this.dhcpc = null;
      this.dhcpStatus = '';
      this.initRuntime();
    }

    initRuntime() {
      this.arp = new Map();
      this.pending = new Map();
      this.udp = new Map();
      this.udpErr = new Map();
      this.icmpListeners = new Map();
      this.nextPort = 49152;
      this.nextIcmpId = 1;
      this.conflict = null;
      this.probe = null;
      this.dnsCache = new Map();
      this.tcp = NS.TcpStack ? new NS.TcpStack(this) : null;
      if (this.nat) this.nat.clearDynamic();
    }

    bindServices() {
      this.udp.set(68, (pkt) => this.onDhcpClient(pkt));
    }

    reset() {
      super.reset();
      for (const j of [...this.jobs]) j.cancel('Устройство перезапущено');
      this.jobs.clear();
      if (this.tcp) this.tcp.abortAll('Устройство перезапущено');
      if (this.dhcpc && this.dhcpc.timer) this.dhcpc.timer.cancel();
      this.initRuntime();
      this.bindServices();
      // DHCP-клиент после перезапуска запрашивает адрес снова (сохранённый адрес остаётся до ответа)
      const f = this.dhcpIface();
      if (f && (!this.dhcpc || this.dhcpc.phase !== 'bound')) {
        this.dhcpc = null;
        this.startDhcp(f);
      }
    }

    destroy() {
      for (const j of [...this.jobs]) j.cancel('Устройство удалено');
      if (this.tcp) this.tcp.abortAll('Устройство удалено');
      super.destroy();
    }

    static errorText(code) { return ERR_TEXT[code] || String(code); }

    /** Порт переставлен/удалён при смене модуля — поправить индексы интерфейсов. */
    portsChanged(map) {
      if (!this.ifaces) return;
      this.ifaces = this.ifaces.filter((f) => {
        if (f.kind === 'loop' || f.kind === 'svi') return true;
        const ni = map[f.port];
        if (ni === undefined || ni < 0) return false;
        f.port = ni;
        return true;
      });
      this.syncIfaces();
    }

    /** Создать недостающие интерфейсы для портов (у каждого класса свои правила). */
    syncIfaces() {}

    /* ---------- интерфейсы ---------- */

    /** kind: phys | sub (802.1Q) | svi (коммутатор) | loop | routed (порт L3-коммутатора). */
    addIface(port, name, vlan, kind) {
      const f = {
        id: this.ifSeq++, name, kind: kind || 'phys', port, vlan: vlan == null ? null : vlan, ip: null, mask: null,
        adminUp: true, dhcp: false, helper: null, aclIn: null, aclOut: null, nat: null, desc: '',
      };
      this.ifaces.push(f);
      return f;
    }

    ifaceUp(f) {
      if (!f || !f.adminUp || !this.power) return false;
      if (f.kind === 'loop') return true;
      if (f.kind === 'sub' && f.vlan == null) return false;
      return this.net.isPortOperational(this, f.port);
    }

    ifaceMac(f) { return f.kind === 'loop' ? null : this.ports[f.port].mac; }
    isSerial(f) { return f.kind !== 'loop' && f.kind !== 'svi' && this.ports[f.port] && this.ports[f.port].media === 'serial'; }

    /** Отправить кадр через интерфейс (коммутатор переопределяет для SVI). */
    ifaceSend(f, frame, why) { return this.send(f.port, frame, why); }

    ifaceByName(name) {
      const n = String(name).toLowerCase();
      return this.ifaces.find((f) => f.name.toLowerCase() === n) || null;
    }

    firstAddressedIface() {
      return this.ifaces.find((f) => f.ip != null && f.kind !== 'loop' && this.ifaceUp(f)) || this.ifaces.find((f) => f.ip != null) || null;
    }

    hasIp(ip) { return this.ifaces.some((f) => f.ip === ip); }
    hasIpUp(ip) { return this.ifaces.some((f) => f.ip === ip && this.ifaceUp(f)); }

    isDirectedBcast(ip, f) {
      return !!f && f.ip != null && f.kind !== 'loop' && U.prefixFromMask(f.mask) < 31 && ip === U.bcast(f.ip, f.mask);
    }

    isForMe(ip, f) {
      return ip === U.BROADCAST_IP || this.hasIpUp(ip) || this.isDirectedBcast(ip, f);
    }

    /** Назначить адрес (ip/mask — числа, либо null чтобы снять адрес). Бросает Error. */
    setIfaceIp(f, ip, mask) {
      if (ip == null) {
        f.ip = null;
        f.mask = null;
      } else {
        if (f.kind === 'sub' && f.vlan == null) throw new Error('Сначала задайте VLAN подынтерфейса (encapsulation dot1Q)');
        const err = f.kind === 'loop' && U.prefixFromMask(mask) === 32 ? (ip >>> 24 === 0 ? 'Неверный адрес' : null) : U.validateHostIp(ip, mask);
        if (err) throw new Error(err);
        for (const g of this.ifaces) {
          if (g === f || g.ip == null) continue;
          if (U.sameNet(ip, g.ip, g.mask) || U.sameNet(g.ip, ip, mask)) {
            throw new Error('Сеть ' + U.cidr(U.net(ip, mask), mask) + ' пересекается с интерфейсом ' + g.name);
          }
        }
        f.ip = ip;
        f.mask = mask;
      }
      f.dhcp = false;
      this.addressChanged(f);
    }

    addressChanged(f) {
      this.flushIface(f, 'down');
      this.conflict = null;
      this.net.markRouting();
      if (f.ip != null && f.kind !== 'loop' && !this.isSerial(f) && this.ifaceUp(f)) this.sendGratuitous(f);
      this.net.emit('config', { dev: this });
    }

    setIfaceAdmin(f, up) {
      f.adminUp = !!up;
      // Физический интерфейс управляет портом целиком (как shutdown в IOS).
      if (f.kind === 'phys' || f.kind === 'routed') {
        const p = this.ports[f.port];
        p.adminUp = !!up;
        if (up) p.errDisabled = false;
      }
      if (!up) this.flushIface(f, 'down');
      this.net.refreshTopology();
    }

    flushIface(f, reason) {
      for (const [ip, e] of this.arp) if (e.ifc === f) this.arp.delete(ip);
      for (const [key, pend] of this.pending) {
        if (pend.ifc !== f) continue;
        this.pending.delete(key);
        if (pend.timer) pend.timer.cancel();
        for (const q of pend.queue) if (q.opts.onError) q.opts.onError(reason || 'down', ERR_TEXT[reason || 'down']);
      }
    }

    onLinkChange(i, up) {
      for (const f of this.ifaces) {
        if (f.port !== i || f.kind === 'loop' || f.kind === 'svi') continue;
        if (!up) this.flushIface(f, 'down');
        else if (f.ip != null && f.adminUp && !this.isSerial(f)) this.sendGratuitous(f);
        if (up && f.dhcp && (!this.dhcpc || this.dhcpc.phase === 'failed' || this.dhcpc.phase === 'wait-link')) this.startDhcp(f);
      }
    }

    allocPort() {
      const p = this.nextPort++;
      if (this.nextPort > 65535) this.nextPort = 49152;
      return p;
    }

    /* ---------- маршрутизация ---------- */

    /** Статические маршруты: {net, mask, nextHop|null, ifName|null, ad}. */
    staticRoutes() {
      const r = this.routes.slice();
      if (this.dhcpc && this.dhcpc.phase === 'bound' && this.dhcpc.router && this.forwarding) {
        r.push({ net: 0, mask: 0, nextHop: this.dhcpc.router, ad: 254, dhcp: true });
      }
      return r;
    }

    connectedIfaceFor(ip) {
      for (const f of this.ifaces) {
        if (f.ip != null && f.ip !== ip && f.kind !== 'loop' && this.ifaceUp(f) && U.sameNet(ip, f.ip, f.mask)) return f;
      }
      return null;
    }

    /** Разрешить следующий переход статического маршрута (в т.ч. рекурсивно). */
    resolveNextHop(nh, depth) {
      const f = this.connectedIfaceFor(nh);
      if (f) return { ifc: f, nextHop: nh };
      if (depth >= 3) return null;
      const r = this.lookup(nh, depth + 1, true);
      return r ? { ifc: r.ifc, nextHop: r.nextHop != null ? r.nextHop : nh } : null;
    }

    /** Поиск маршрута: длиннейший префикс, затем наименьшее административное расстояние. */
    lookup(dst, depth, noDefault) {
      depth = depth || 0;
      this.net.ensureRouting();
      let best = null;
      const take = (r) => {
        if (!best || r.prefix > best.prefix || (r.prefix === best.prefix && r.ad < best.ad)) best = r;
      };
      for (const f of this.ifaces) {
        if (f.ip == null || !this.ifaceUp(f)) continue;
        if (U.sameNet(dst, f.ip, f.mask)) take({ type: 'C', ad: 0, prefix: U.prefixFromMask(f.mask), net: U.net(f.ip, f.mask), mask: f.mask, ifc: f, nextHop: null });
      }
      for (const r of this.staticRoutes()) {
        if (U.net(dst, r.mask) !== r.net) continue;
        if (noDefault && r.mask === 0) continue;
        let via = null;
        if (r.ifName) {
          const f = this.ifaceByName(r.ifName);
          if (!f || !this.ifaceUp(f)) continue;
          via = { ifc: f, nextHop: r.nextHop != null ? r.nextHop : null };
        } else {
          via = this.resolveNextHop(r.nextHop, depth);
        }
        if (!via) continue;
        take({ type: 'S', ad: r.ad || 1, prefix: U.prefixFromMask(r.mask), net: r.net, mask: r.mask, ifc: via.ifc, nextHop: via.nextHop });
      }
      for (const r of this.dynRoutes) {
        if (U.net(dst, r.mask) !== r.net) continue;
        if (noDefault && r.mask === 0) continue;
        if (!this.ifaceUp(r.ifc)) continue;
        take(Object.assign({ prefix: U.prefixFromMask(r.mask) }, r));
      }
      return best;
    }

    /** Таблица маршрутизации для показа (как show ip route). */
    routingTable() {
      this.net.ensureRouting();
      const rows = [];
      for (const f of this.ifaces) {
        if (f.ip == null || !this.ifaceUp(f)) continue;
        rows.push({ type: 'C', ad: 0, metric: 0, net: U.net(f.ip, f.mask), mask: f.mask, nextHop: null, ifname: f.name, active: true });
        if (this.forwarding && U.prefixFromMask(f.mask) < 32) rows.push({ type: 'L', ad: 0, metric: 0, net: f.ip, mask: 0xFFFFFFFF, nextHop: null, ifname: f.name, active: true });
      }
      for (const r of this.staticRoutes()) {
        let via = null;
        if (r.ifName) {
          const f = this.ifaceByName(r.ifName);
          via = f && this.ifaceUp(f) ? { ifc: f } : null;
        } else via = this.resolveNextHop(r.nextHop, 0);
        rows.push({ type: 'S', ad: r.ad || 1, metric: 0, net: r.net, mask: r.mask, nextHop: r.nextHop, ifname: via ? via.ifc.name : (r.ifName || ''), active: !!via, gateway: !!r.gateway, dhcp: !!r.dhcp, exitOnly: !!r.ifName && r.nextHop == null });
      }
      for (const r of this.dynRoutes) {
        rows.push({ type: r.type, ad: r.ad, metric: r.metric, net: r.net, mask: r.mask, nextHop: r.nextHop, ifname: r.ifc.name, active: this.ifaceUp(r.ifc), sub: r.sub || '' });
      }
      // Неактивны маршруты, проигравшие по административному расстоянию тому же префиксу.
      for (const r of rows) {
        if (!r.active || r.type === 'C' || r.type === 'L') continue;
        const better = rows.find((o) => o !== r && o.active && o.net === r.net && o.mask === r.mask && o.ad < r.ad);
        if (better) r.shadowed = true;
      }
      rows.sort((a, b) => a.net - b.net || b.mask - a.mask || a.ad - b.ad);
      return rows;
    }

    addRoute(net, mask, nextHop, opts) {
      opts = opts || {};
      if (net == null) throw new Error('Неверный адрес сети');
      if (mask == null) throw new Error('Неверная маска');
      if (nextHop == null && !opts.ifName) throw new Error('Неверный адрес следующего перехода');
      if (U.net(net, mask) !== net) throw new Error('Адрес сети не соответствует маске (должно быть ' + U.ipStr(U.net(net, mask)) + ')');
      if (nextHop != null && this.hasIp(nextHop)) throw new Error('Следующий переход не может быть собственным адресом');
      if (opts.ifName && !this.ifaceByName(opts.ifName)) throw new Error('Интерфейс ' + opts.ifName + ' не найден');
      const ad = opts.ad || 1;
      if (!(ad >= 1 && ad <= 255)) throw new Error('Административное расстояние: 1–255');
      if (this.routes.some((r) => r.net === net && r.mask === mask && r.nextHop === nextHop && (r.ifName || null) === (opts.ifName || null))) throw new Error('Такой маршрут уже есть');
      this.routes.push({ net, mask, nextHop: nextHop == null ? null : nextHop, ifName: opts.ifName || null, ad });
      this.net.markRouting();
    }

    removeRoute(net, mask, nextHop) {
      const before = this.routes.length;
      this.routes = this.routes.filter((r) => !(r.net === net && r.mask === mask && (nextHop == null || r.nextHop === nextHop)));
      this.net.markRouting();
      return this.routes.length !== before;
    }

    /* ---------- отправка ---------- */

    /**
     * Отправить IP-пакет.
     * opts: { onError(code, text), iface (для широковещательных), dstMac, why }
     */
    sendIp(pkt, opts) {
      opts = opts || {};
      const fail = (code) => {
        if (opts.onError) opts.onError(code, ERR_TEXT[code]);
        return false;
      };
      if (!this.power) return fail('off');
      const dst = pkt.dst;

      if (this.hasIp(dst)) {
        const f = this.ifaces.find((x) => x.ip === dst);
        if (pkt.src == null) pkt.src = dst;
        this.timer(0, () => this.deliverLocal(pkt, f, null));
        return true;
      }

      if (dst === U.BROADCAST_IP) {
        const f = opts.iface || this.ifaces.find((x) => x.kind !== 'loop' && this.ifaceUp(x));
        if (!this.ifaceUp(f)) return fail('down');
        if (pkt.src == null) pkt.src = f.ip != null ? f.ip : 0;
        this.sendFrameIp(f, opts.dstMac || U.BROADCAST_MAC, pkt, opts.why || 'Широковещательный пакет');
        return true;
      }

      const r = this.lookup(dst);
      if (!r) {
        if (!this.ifaces.some((f) => f.ip != null)) return fail('no-ip');
        return fail('no-route');
      }
      const f = r.ifc;
      if (pkt.src == null) pkt.src = f.ip;
      if (r.type === 'C' && this.isDirectedBcast(dst, f)) {
        this.sendFrameIp(f, U.BROADCAST_MAC, pkt, opts.why || 'Широковещательный пакет в подсеть');
        return true;
      }
      this.resolveAndSend(f, r.nextHop != null ? r.nextHop : dst, pkt, opts);
      return true;
    }

    resolveAndSend(f, nh, pkt, opts) {
      if (this.isSerial(f)) {
        this.sendFrameIp(f, null, pkt, opts.why);
        return;
      }
      const e = this.arp.get(nh);
      if (e && e.ifc === f && this.net.time - e.time < ARP_AGE) {
        this.sendFrameIp(f, e.mac, pkt, opts.why);
        return;
      }
      const key = f.id + '|' + nh;
      let pend = this.pending.get(key);
      if (pend) {
        if (pend.queue.length >= ARP_QUEUE) {
          const old = pend.queue.shift();
          if (old.opts.onError) old.opts.onError('queue', ERR_TEXT.queue);
        }
        pend.queue.push({ pkt, opts });
        return;
      }
      pend = { ifc: f, ip: nh, queue: [{ pkt, opts }], tries: 0, timer: null };
      this.pending.set(key, pend);
      this.arpAttempt(key);
    }

    arpAttempt(key) {
      const pend = this.pending.get(key);
      if (!pend) return;
      const fail = (code) => {
        this.pending.delete(key);
        for (const q of pend.queue) if (q.opts.onError) q.opts.onError(code, ERR_TEXT[code]);
      };
      if (!this.ifaceUp(pend.ifc)) return fail('down');
      if (pend.tries >= ARP_RETRIES) {
        this.note('ARP: нет ответа от ' + U.ipStr(pend.ip) + ' — пакеты в очереди отброшены', null, 'drop');
        return fail('arp-fail');
      }
      pend.tries++;
      this.sendArp(pend.ifc, 'request', pend.ifc.ip, pend.ip, U.BROADCAST_MAC, U.ZERO_MAC,
        'Нужен MAC-адрес для ' + U.ipStr(pend.ip) + ' — ARP-запрос' + (pend.tries > 1 ? ' (попытка ' + pend.tries + ')' : ''));
      pend.timer = this.timer(ARP_TIMEOUT, () => this.arpAttempt(key));
    }

    sendFrameIp(f, dstMac, pkt, why) {
      if (this.isSerial(f)) {
        const p = this.ports[f.port];
        const frame = { src: null, dst: null, type: 'IPv4', vlan: null, payload: pkt, hops: 0, encap: (p.encap || 'hdlc').toUpperCase() };
        return this.ifaceSend(f, frame, why);
      }
      const frame = P.frame(this.ifaceMac(f), dstMac, 'IPv4', pkt, f.kind === 'sub' ? f.vlan : null);
      return this.ifaceSend(f, frame, why);
    }

    sendArp(f, op, senderIp, targetIp, dstMac, targetMac, why) {
      const mac = this.ifaceMac(f);
      const a = P.arp(op, mac, senderIp == null ? 0 : senderIp, targetMac, targetIp);
      return this.ifaceSend(f, P.frame(mac, dstMac, 'ARP', a, f.kind === 'sub' ? f.vlan : null), why);
    }

    sendGratuitous(f) {
      this.sendArp(f, 'request', f.ip, f.ip, U.BROADCAST_MAC, U.ZERO_MAC, 'Gratuitous ARP: сообщаю свой адрес ' + U.ipStr(f.ip));
    }

    learnArp(ip, mac, f) {
      this.arp.set(ip, { mac, ifc: f, time: this.net.time });
      const key = f.id + '|' + ip;
      const pend = this.pending.get(key);
      if (pend) {
        this.pending.delete(key);
        if (pend.timer) pend.timer.cancel();
        for (const q of pend.queue) this.sendFrameIp(f, mac, q.pkt, q.opts.why);
      }
    }

    arpEntries() {
      const now = this.net.time;
      const out = [];
      for (const [ip, e] of this.arp) if (now - e.time < ARP_AGE) out.push({ ip, mac: e.mac, ifname: e.ifc.name });
      out.sort((a, b) => a.ip - b.ip);
      return out;
    }

    clearArp() { this.arp.clear(); }

    /* ---------- приём ---------- */

    receive(i, frame) {
      const p = this.ports[i];
      if (p.media === 'serial') {
        const f = this.ifaces.find((x) => x.port === i && x.kind === 'phys');
        if (!f || !f.adminUp) { this.drop(frame, 'Интерфейс ' + p.name + ' выключен'); return; }
        if (frame.type === 'IPv4') this.onIp(f, frame.payload, frame);
        return;
      }
      const tag = frame.vlan == null ? null : frame.vlan;
      const f = this.ifaces.find((x) => x.port === i && (x.kind === 'sub' ? x.vlan != null && x.vlan === tag : (x.kind === 'phys' || x.kind === 'routed') && tag === null));
      if (!f) {
        this.drop(frame, tag != null ? 'Нет подынтерфейса для VLAN ' + tag + ' на ' + p.name : 'Нет интерфейса для этого кадра');
        return;
      }
      this.ipIngress(f, frame);
    }

    /** Кадр пришёл на интерфейс f (у коммутатора — на SVI). */
    ipIngress(f, frame) {
      if (!f.adminUp) {
        this.drop(frame, 'Интерфейс ' + f.name + ' выключен (shutdown)');
        return;
      }
      if (frame.dst !== this.ifaceMac(f) && !U.isBroadcastMac(frame.dst)) {
        this.drop(frame, 'Кадр адресован другому устройству (MAC ' + frame.dst + ')');
        return;
      }
      if (frame.type === 'ARP') this.onArp(f, frame.payload, frame);
      else if (frame.type === 'IPv4') this.onIp(f, frame.payload, frame);
      else this.drop(frame, 'Неизвестный протокол');
    }

    onArp(f, a, frame) {
      const myIp = f.ip;
      const myMac = this.ifaceMac(f);
      if (this.probe && a.senderIp === this.probe.ip && a.senderMac !== myMac) this.probe.conflict = true;

      if (myIp != null && a.senderIp === myIp && a.senderMac !== myMac) {
        this.conflict = { ip: myIp, mac: a.senderMac };
        this.net.emit('warn', { dev: this, text: this.name + ': конфликт IP-адресов — ' + U.ipStr(myIp) + ' уже использует ' + a.senderMac });
        this.note('Конфликт IP-адресов: ' + U.ipStr(myIp) + ' также у ' + a.senderMac, frame, 'drop');
        if (a.op === 'request') this.sendArp(f, 'reply', myIp, a.senderIp, a.senderMac, a.senderMac, 'Защита адреса: этот IP уже занят');
        return;
      }

      if (a.senderIp && myIp != null && U.sameNet(a.senderIp, myIp, f.mask)) {
        if (a.targetIp === myIp || this.arp.has(a.senderIp)) this.learnArp(a.senderIp, a.senderMac, f);
      }

      if (a.op !== 'request') return;
      if (myIp != null && a.targetIp === myIp && a.senderIp !== a.targetIp) {
        this.sendArp(f, 'reply', myIp, a.senderIp, a.senderMac, a.senderMac, 'ARP-ответ: ' + U.ipStr(myIp) + ' — это я (' + myMac + ')');
        return;
      }
      if (a.senderIp === a.targetIp) return;
      // Proxy ARP (включён на маршрутизаторах Cisco по умолчанию)
      if (this.forwarding && this.proxyArp && myIp != null && a.senderIp && U.sameNet(a.senderIp, myIp, f.mask) && !U.sameNet(a.targetIp, myIp, f.mask)) {
        const r = this.lookup(a.targetIp);
        if (r && r.ifc !== f) {
          this.sendArp(f, 'reply', a.targetIp, a.senderIp, a.senderMac, a.senderMac, 'Proxy ARP: отвечаю за ' + U.ipStr(a.targetIp) + ' (маршрут через ' + r.ifc.name + ')');
          return;
        }
      }
      this.drop(frame, 'ARP-запрос не для меня (ищут ' + U.ipStr(a.targetIp) + ')');
    }

    aclDenies(name, pkt) {
      const acl = this.acls.get(String(name));
      if (!acl) return null;
      const r = acl.check(pkt);
      return r.permit ? null : acl;
    }

    onIp(f, pkt, frame) {
      if (f.aclIn) {
        const acl = this.aclDenies(f.aclIn, pkt);
        if (acl) {
          this.drop(frame, 'Отброшено списком доступа ' + acl.name + ' (входящий на ' + f.name + ')');
          this.sendIcmpError(pkt, 'unreachable', 13, f);
          return;
        }
      }
      if (this.nat && f.nat === 'outside') {
        const t = this.nat.inbound(pkt);
        if (t) pkt = t;
      }
      if (this.firewallCheck) {
        const why = this.firewallCheck(pkt);
        if (why) { this.drop(frame, why); return; }
      }
      if (this.isForMe(pkt.dst, f)) {
        this.deliverLocal(pkt, f, frame);
        return;
      }
      if (this.forwarding) {
        this.forward(pkt, f, frame);
        return;
      }
      this.drop(frame, 'IP-пакет не для меня (получатель ' + U.ipStr(pkt.dst) + ')');
    }

    deliverLocal(pkt, f, frame) {
      if (pkt.proto === 'ICMP') {
        this.onIcmp(pkt, f, frame);
      } else if (pkt.proto === 'UDP') {
        const h = this.udp.get(pkt.payload.dport);
        if (h) h(pkt, f, frame);
        else this.portClosed(pkt, f, frame);
      } else if (pkt.proto === 'TCP') {
        if (this.tcp) this.tcp.onSegment(pkt, f, frame);
      }
    }

    /** Порт закрыт: ICMP port unreachable (кроме широковещательных пакетов). */
    portClosed(pkt, f, frame) {
      if (pkt.dst !== U.BROADCAST_IP && !this.isDirectedBcast(pkt.dst, f)) this.sendIcmpError(pkt, 'unreachable', 3, f);
      if (frame) this.drop(frame, 'UDP-порт ' + pkt.payload.dport + ' закрыт');
    }

    onIcmp(pkt, f, frame) {
      const m = pkt.payload;
      if (m.type === 'echo-request') {
        const bcast = pkt.dst === U.BROADCAST_IP || this.isDirectedBcast(pkt.dst, f);
        const src = bcast ? (f && f.ip) : pkt.dst;
        if (src == null || !pkt.src) return;
        this.sendIp(P.ipv4(src, pkt.src, 'ICMP', P.echoReply(m.id, m.seq, m.size), this.defaultTtl), { why: 'Эхо-ответ на ping от ' + U.ipStr(pkt.src) });
      } else if (m.type === 'echo-reply') {
        const h = this.icmpListeners.get(m.id);
        if (h) h({ kind: 'reply', from: pkt.src, seq: m.seq, ttl: pkt.ttl });
        else if (frame) this.drop(frame, 'Эхо-ответ никто не ждёт (ping уже завершён)');
      } else if (m.type === 'time-exceeded' || m.type === 'unreachable') {
        const o = m.original;
        if (!o) return;
        const info = { kind: m.type, code: m.code, from: pkt.src, original: o };
        if (o.proto === 'ICMP' && o.payload && o.payload.type === 'echo-request') {
          const h = this.icmpListeners.get(o.payload.id);
          if (h) h({ kind: m.type, code: m.code, from: pkt.src, seq: o.payload.seq });
        } else if (o.proto === 'UDP' && o.payload) {
          const h = this.udpErr.get(o.payload.sport);
          if (h) h(info);
        } else if (o.proto === 'TCP' && this.tcp) {
          this.tcp.onIcmpError(info);
        }
      }
    }

    /** ICMP-ошибка отправителю пакета orig. Никогда не отвечаем ошибкой на ошибку и на broadcast. */
    sendIcmpError(orig, type, code, f) {
      if (orig.proto === 'ICMP' && orig.payload && orig.payload.type !== 'echo-request') return;
      if (!orig.src || orig.src === U.BROADCAST_IP) return;
      const src = f && f.ip != null ? f.ip : null;
      const msg = { type, code, original: { src: orig.src, dst: orig.dst, proto: orig.proto, ttl: orig.ttl, payload: U.clone(orig.payload) } };
      const why = type === 'time-exceeded' ? 'TTL истёк — сообщаю отправителю'
        : 'Сообщаю отправителю: ' + ({ 0: 'сеть недоступна', 1: 'узел недоступен', 3: 'порт недоступен', 13: 'запрещено списком доступа' }[code] || 'недоступно');
      this.sendIp(P.ipv4(src, orig.src, 'ICMP', msg, this.defaultTtl), { why });
    }

    /* ---------- маршрутизация транзитных пакетов ---------- */

    forward(pkt, f, frame) {
      if (!pkt.src || pkt.dst === U.BROADCAST_IP) {
        this.drop(frame, 'Широковещательные пакеты не маршрутизируются');
        return;
      }
      if (pkt.ttl <= 1) {
        this.sendIcmpError(pkt, 'time-exceeded', 0, f);
        this.drop(frame, 'TTL истёк — пакет уничтожен');
        return;
      }
      const r = this.lookup(pkt.dst);
      if (!r) {
        this.sendIcmpError(pkt, 'unreachable', 0, f);
        this.drop(frame, 'Нет маршрута до ' + U.ipStr(pkt.dst));
        return;
      }
      if (r.type === 'C' && this.isDirectedBcast(pkt.dst, r.ifc)) {
        this.drop(frame, 'Направленная широковещательная рассылка не маршрутизируется');
        return;
      }
      let out = U.clone(pkt);
      out.ttl = pkt.ttl - 1;
      let natNote = '';
      if (this.nat && f.nat === 'inside' && r.ifc.nat === 'outside') {
        const before = out.src;
        const t = this.nat.outbound(out, r.ifc);
        if (t === false) {
          this.drop(frame, 'NAT: нет свободных внешних адресов в пуле');
          this.sendIcmpError(pkt, 'unreachable', 1, f);
          return;
        }
        if (t) {
          out = t;
          natNote = ' · NAT: ' + U.ipStr(before) + ' → ' + U.ipStr(out.src);
        }
      }
      if (r.ifc.aclOut) {
        const acl = this.aclDenies(r.ifc.aclOut, out);
        if (acl) {
          this.drop(frame, 'Отброшено списком доступа ' + acl.name + ' (исходящий на ' + r.ifc.name + ')');
          this.sendIcmpError(pkt, 'unreachable', 13, f);
          return;
        }
      }
      const why = (r.type === 'C'
        ? 'Сеть ' + U.cidr(r.net, r.mask) + ' подключена напрямую → ' + r.ifc.name
        : 'Маршрут ' + ({ S: 'статический', O: 'OSPF', R: 'RIP' }[r.type] || r.type) + ' ' + U.cidr(r.net, r.mask) +
          (r.nextHop != null ? ' через ' + U.ipStr(r.nextHop) : '') + ' → ' + r.ifc.name) + natNote;
      this.resolveAndSend(r.ifc, r.nextHop != null ? r.nextHop : out.dst, out, {
        why,
        onError: () => this.sendIcmpError(pkt, 'unreachable', 1, f),
      });
    }

    /* ---------- DHCP-клиент (ПК, а также `ip address dhcp` на маршрутизаторе) ---------- */

    dhcpIface() { return this.ifaces.find((f) => f.dhcp) || null; }

    stopDhcp() {
      if (this.dhcpc && this.dhcpc.timer) this.dhcpc.timer.cancel();
      this.dhcpc = null;
      this.probe = null;
    }

    startDhcp(f) {
      f = f || this.dhcpIface();
      if (!f || !f.dhcp) return;
      this.stopDhcp();
      if (f.ip != null) {
        f.ip = null;
        f.mask = null;
        this.flushIface(f, 'down');
        this.onDhcpUnbound(f);
        this.net.markRouting();
      }
      this.dhcpc = { ifc: f, xid: this.net.counters.xid++, phase: 'discover', tries: 0, timer: null, offer: null };
      this.dhcpStatus = 'Запрос адреса у DHCP-сервера…';
      this.net.emit('config', { dev: this });
      if (!this.ifaceUp(f)) {
        this.dhcpc.phase = 'wait-link';
        this.dhcpStatus = 'Ожидание подключения кабеля…';
        return;
      }
      this.dhcpDiscover();
    }

    dhcpSend(op, extra, why) {
      const f = this.dhcpc.ifc;
      const data = Object.assign({ op, xid: this.dhcpc.xid, chaddr: this.ifaceMac(f), giaddr: 0 }, extra || {});
      this.sendIp(P.ipv4(0, U.BROADCAST_IP, 'UDP', P.udp(68, 67, data), this.defaultTtl), { iface: f, why });
    }

    dhcpDiscover() {
      const c = this.dhcpc;
      if (!c) return;
      c.phase = 'discover';
      if (++c.tries > DHCP_TRIES) return this.dhcpFail();
      this.dhcpSend('DISCOVER', null, 'DHCP Discover: ищу DHCP-сервер' + (c.tries > 1 ? ' (попытка ' + c.tries + ')' : ''));
      c.timer = this.timer(DHCP_RETRY, () => this.dhcpDiscover());
    }

    dhcpRequest() {
      const c = this.dhcpc;
      if (!c) return;
      if (++c.tries > DHCP_TRIES) {
        c.tries = 0;
        return this.dhcpDiscover();
      }
      this.dhcpSend('REQUEST', { requested: c.offer.yiaddr, serverId: c.offer.serverId }, 'DHCP Request: прошу адрес ' + U.ipStr(c.offer.yiaddr));
      c.timer = this.timer(DHCP_RETRY, () => this.dhcpRequest());
    }

    onDhcpClient(pkt) {
      const c = this.dhcpc;
      const d = pkt.payload.data || {};
      if (!c || d.xid !== c.xid || d.chaddr !== this.ifaceMac(c.ifc)) return;
      if (d.op === 'OFFER' && c.phase === 'discover') {
        if (c.timer) c.timer.cancel();
        c.offer = d;
        c.phase = 'request';
        c.tries = 0;
        this.dhcpRequest();
      } else if (d.op === 'ACK' && c.phase === 'request') {
        if (c.timer) c.timer.cancel();
        c.phase = 'probe';
        this.probe = { ip: d.yiaddr, conflict: false };
        this.sendArp(c.ifc, 'request', 0, d.yiaddr, U.BROADCAST_MAC, U.ZERO_MAC, 'ARP-проба: не занят ли ' + U.ipStr(d.yiaddr) + '?');
        c.timer = this.timer(PROBE_WAIT, () => {
          const conflict = this.probe && this.probe.conflict;
          this.probe = null;
          if (conflict) {
            this.dhcpSend('DECLINE', { requested: d.yiaddr, serverId: d.serverId }, 'DHCP Decline: адрес ' + U.ipStr(d.yiaddr) + ' уже кем-то занят');
            c.phase = 'discover';
            c.tries = 0;
            c.timer = this.timer(20, () => this.dhcpDiscover());
          } else {
            this.dhcpBind(d);
          }
        });
      } else if (d.op === 'NAK' && (c.phase === 'request' || c.phase === 'discover')) {
        if (c.timer) c.timer.cancel();
        c.tries = 0;
        c.timer = this.timer(20, () => this.dhcpDiscover());
      }
    }

    dhcpBind(d) {
      const c = this.dhcpc;
      const f = c.ifc;
      f.ip = d.yiaddr;
      f.mask = d.mask;
      c.phase = 'bound';
      c.server = d.serverId;
      c.router = d.router || null;
      c.dns = d.dns || null;
      c.timer = null;
      this.dhcpStatus = 'Адрес получен от DHCP-сервера ' + U.ipStr(d.serverId);
      this.onDhcpBound(f, d);
      this.addressChanged(f);
      this.note('DHCP: получен адрес ' + U.cidr(f.ip, f.mask) + (d.router ? ', шлюз ' + U.ipStr(d.router) : ''), null, 'accept');
    }

    /** Ноутбук/ПК используют шлюз и DNS; маршрутизатор — маршрут по умолчанию (AD 254). */
    onDhcpBound() {}
    onDhcpUnbound() {}

    dhcpFail() {
      const f = this.dhcpc.ifc;
      this.dhcpc = { ifc: f, phase: 'failed', xid: 0, timer: null };
      if (this.useApipa) {
        const mac = this.ifaceMac(f).split(':');
        f.ip = U.parseIp('169.254.' + ((parseInt(mac[4], 16) % 254) + 1) + '.' + ((parseInt(mac[5], 16) % 254) + 1));
        f.mask = U.maskFromPrefix(16);
        this.dhcpStatus = 'DHCP-сервер не ответил — назначен временный адрес APIPA';
        this.addressChanged(f);
        this.note('DHCP: сервер не ответил, назначен APIPA ' + U.ipStr(f.ip), null, 'drop');
      } else {
        this.dhcpStatus = 'DHCP-сервер не ответил';
        this.net.emit('config', { dev: this });
      }
    }

    releaseDhcp() {
      const f = this.dhcpIface();
      if (!f) return false;
      if (this.dhcpc && this.dhcpc.phase === 'bound' && f.ip != null) {
        this.sendIp(P.ipv4(f.ip, this.dhcpc.server, 'UDP', P.udp(68, 67, { op: 'RELEASE', xid: this.dhcpc.xid, chaddr: this.ifaceMac(f), ciaddr: f.ip, giaddr: 0 }), this.defaultTtl), { why: 'DHCP Release: возвращаю адрес' });
      }
      this.stopDhcp();
      f.ip = null;
      f.mask = null;
      this.onDhcpUnbound(f);
      this.dhcpStatus = 'Адрес освобождён';
      this.addressChanged(f);
      return true;
    }

    /* ---------- сохранение ---------- */

    serializeIfaces() {
      const ip = (v) => (v == null ? null : U.ipStr(v));
      return this.ifaces.map((f) => ({
        name: f.name, kind: f.kind, port: f.port, pname: f.port >= 0 && this.ports[f.port] ? this.ports[f.port].name : null,
        vlan: f.vlan, sub: f.kind === 'sub', ip: ip(f.ip), mask: ip(f.mask), adminUp: f.adminUp, dhcp: f.dhcp, helper: ip(f.helper),
        aclIn: f.aclIn, aclOut: f.aclOut, nat: f.nat, desc: f.desc || '',
      }));
    }

    loadIface(f, s) {
      f.ip = s.ip ? U.parseIp(s.ip) : null;
      f.mask = s.mask ? U.parseMask(s.mask) : null;
      if (f.ip == null || f.mask == null) { f.ip = null; f.mask = null; }
      f.adminUp = s.adminUp !== false;
      f.dhcp = !!s.dhcp;
      f.helper = s.helper ? U.parseIp(s.helper) : null;
      f.aclIn = s.aclIn || null;
      f.aclOut = s.aclOut || null;
      f.nat = s.nat === 'inside' || s.nat === 'outside' ? s.nat : null;
      f.desc = String(s.desc || '');
    }

    /** Найти порт сохранённого интерфейса: по имени порта, затем по индексу. */
    savedPort(s) {
      if (s.pname) {
        const i = this.portIndex(s.pname);
        if (i >= 0) return i;
      }
      return Number.isInteger(s.port) && this.ports[s.port] ? s.port : -1;
    }

    serializeRoutes() {
      return this.routes.map((r) => ({ net: U.ipStr(r.net), mask: U.ipStr(r.mask), nextHop: r.nextHop == null ? null : U.ipStr(r.nextHop), ifName: r.ifName || null, ad: r.ad || 1 }));
    }

    loadRoutes(list) {
      this.routes = [];
      for (const r of list || []) {
        const net = U.parseIp(r.net);
        const mask = U.parseMask(r.mask);
        const nh = r.nextHop ? U.parseIp(r.nextHop) : null;
        if (net != null && mask != null && (nh != null || r.ifName)) this.routes.push({ net, mask, nextHop: nh, ifName: r.ifName || null, ad: r.ad || 1 });
      }
    }

    serializeAcls() { return [...this.acls.values()].map((a) => a.serialize()); }

    loadAcls(list) {
      this.acls = new Map();
      for (const a of list || []) {
        try { const acl = NS.AccessList.load(a); this.acls.set(acl.name, acl); } catch (e) { /* пропускаем испорченный список */ }
      }
    }
  }

  IpNode.ARP_TIMEOUT = ARP_TIMEOUT;
  IpNode.AD = AD;
  NS.IpNode = IpNode;
})(globalThis.NetLab = globalThis.NetLab || {});
