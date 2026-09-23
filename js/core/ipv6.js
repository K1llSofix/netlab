/* NetLab — IPv6: адреса (EUI-64, link-local, SLAAC), ICMPv6 (эхо, Neighbor Discovery, RS/RA),
 * маршрутизация (подключённые сети и статические маршруты), команды IOS и командной строки ПК.
 * Адреса внутри модели — BigInt, в файлах — строки. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const ND_TIMEOUT = 30;
  const ND_RETRIES = 3;
  const ND_AGE = 60000;
  const M128 = (1n << 128n) - 1n;

  /* ================= адреса ================= */

  const ip6 = {
    /** '2001:db8::1' → BigInt | null. */
    parse(s) {
      let t = String(s == null ? '' : s).trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
      if (!t || !/^[0-9a-f:]+$/i.test(t) || t.indexOf(':') < 0) return null;
      const dbl = t.split('::');
      if (dbl.length > 2) return null;
      const part = (x) => (x ? x.split(':') : []);
      const head = part(dbl[0]);
      const tail = dbl.length === 2 ? part(dbl[1]) : [];
      if (dbl.length === 1 && head.length !== 8) return null;
      if (dbl.length === 2 && head.length + tail.length > 7) return null;
      const groups = dbl.length === 2 ? head.concat(new Array(8 - head.length - tail.length).fill('0'), tail) : head;
      let v = 0n;
      for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        v = (v << 16n) | BigInt(parseInt(g, 16));
      }
      return v;
    },

    /** BigInt → сокращённая запись (RFC 5952). upper — как в выводе IOS. */
    str(v, upper) {
      if (v == null) return '';
      const g = [];
      for (let i = 7; i >= 0; i--) g.push(Number((v >> BigInt(i * 16)) & 0xffffn));
      let best = -1;
      let bestLen = 0;
      for (let i = 0; i < 8;) {
        if (g[i] !== 0) { i++; continue; }
        let j = i;
        while (j < 8 && g[j] === 0) j++;
        if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
        i = j;
      }
      const hx = (n) => n.toString(16);
      let out;
      if (best < 0) out = g.map(hx).join(':');
      else out = g.slice(0, best).map(hx).join(':') + '::' + g.slice(best + bestLen).map(hx).join(':');
      return upper ? out.toUpperCase() : out;
    },

    /** '2001:db8::1/64' → { addr, plen } | null. */
    parsePrefix(s) {
      const m = /^(.+)\/(\d{1,3})$/.exec(String(s || '').trim());
      if (!m) return null;
      const addr = ip6.parse(m[1]);
      const plen = Number(m[2]);
      if (addr == null || plen > 128) return null;
      return { addr, plen };
    },

    mask(plen) { return plen <= 0 ? 0n : (M128 << BigInt(128 - plen)) & M128; },
    net(a, plen) { return a & ip6.mask(plen); },
    sameNet(a, b, plen) { return ip6.net(a, plen) === ip6.net(b, plen); },
    cidr(a, plen, upper) { return ip6.str(ip6.net(a, plen), upper) + '/' + plen; },

    /** Идентификатор интерфейса EUI-64 из MAC (с инверсией бита U/L). */
    eui64(mac) {
      const b = String(mac || '00:00:00:00:00:00').split(':').map((x) => parseInt(x, 16) || 0);
      const bytes = [b[0] ^ 2, b[1], b[2], 0xff, 0xfe, b[3], b[4], b[5]];
      return bytes.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
    },
    linkLocal(mac) { return (0xfe80n << 112n) | ip6.eui64(mac); },
    isLinkLocal(a) { return a != null && (a >> 118n) === 0x3fan; },
    isMulticast(a) { return a != null && (a >> 120n) === 0xffn; },
    solicited(a) { return ip6.SOLICITED | (a & 0xffffffn); },
    mcastMac(a) {
      const x = a & 0xffffffffn;
      return '33:33:' + [24n, 16n, 8n, 0n].map((sh) => ((x >> sh) & 0xffn).toString(16).padStart(2, '0').toUpperCase()).join(':');
    },
  };
  ip6.ALL_NODES = ip6.parse('ff02::1');
  ip6.ALL_ROUTERS = ip6.parse('ff02::2');
  ip6.SOLICITED = ip6.parse('ff02::1:ff00:0');
  NS.ip6 = ip6;

  // Все места, печатающие адреса через ipStr (ping, tracert, журнал), понимают и IPv6.
  const ipStr4 = U.ipStr;
  U.ipStr = function (n) { return typeof n === 'bigint' ? ip6.str(n) : ipStr4(n); };

  P.ipv6 = function (src, dst, next, payload, hop) { return { src, dst, next, hop: hop || 64, payload }; };

  /* ================= состояние интерфейса и узла ================= */

  function v6(f) {
    if (!f.v6) f.v6 = { enabled: false, autoconfig: false, llManual: null, addrs: [], raRouter: null };
    return f.v6;
  }
  function on(f) { return !!f.v6 && (f.v6.enabled || f.v6.autoconfig || f.v6.addrs.length > 0 || f.v6.llManual != null); }

  const P6 = IpNode.prototype;

  P6.v6cfg = function () {
    if (!this.v6) this.v6 = { routing: false, routes: [], gw: null, dns: null };
    return this.v6;
  };

  /** Маршрутизирует ли узел IPv6 (ipv6 unicast-routing). */
  P6.forwarding6 = function () {
    return !!this.forwarding && this.v6cfg().routing && (this.type === 'router' || (this.type === 'switch' && this.l3));
  };

  /** MAC для EUI-64: свой у Ethernet, у serial — первого Ethernet-порта (как в IOS). */
  P6.euiMac = function (f) {
    const m = this.ifaceMac(f);
    if (m && !this.isSerial(f)) return m;
    const p = this.ports.find((x) => x.mac && (x.media === 'copper' || x.media === 'fiber' || x.media === 'wireless'));
    return p ? p.mac : '00:00:00:00:00:01';
  };

  P6.ll6 = function (f) {
    if (!on(f)) return null;
    return f.v6.llManual != null ? f.v6.llManual : ip6.linkLocal(this.euiMac(f));
  };

  P6.addrs6 = function (f) { return on(f) ? f.v6.addrs : []; };

  P6.hasIp6 = function (a) {
    return this.ifaces.some((f) => on(f) && this.ifaceUp(f) && (this.ll6(f) === a || f.v6.addrs.some((x) => x.addr === a)));
  };

  P6.v6iface = function () {
    return this.ifaces.find((f) => on(f) && this.ifaceUp(f) && f.kind !== 'loop') || null;
  };

  /** Адрес отправителя для пакета через f к dst. */
  P6.srcFor6 = function (f, dst) {
    if (!f || !on(f)) return null;
    if (ip6.isLinkLocal(dst) || (ip6.isMulticast(dst) && (dst >> 112n) === 0xff02n)) return this.ll6(f);
    const same = f.v6.addrs.find((a) => ip6.sameNet(a.addr, dst, a.plen));
    if (same) return same.addr;
    if (f.v6.addrs[0]) return f.v6.addrs[0].addr;
    for (const g of this.ifaces) if (on(g) && this.ifaceUp(g) && g.v6.addrs[0]) return g.v6.addrs[0].addr;
    return this.ll6(f);
  };

  /* ---------- настройка ---------- */

  function checkUnicast(addr) {
    if (addr == null) throw new Error('Неверный IPv6-адрес (пример: 2001:DB8:1::1)');
    if (addr === 0n) throw new Error('Адрес :: не может быть адресом интерфейса');
    if (ip6.isMulticast(addr)) throw new Error('Групповой (multicast) адрес FF00::/8 не может быть адресом интерфейса');
  }

  P6.addIp6 = function (f, addr, plen, eui) {
    if (!Number.isInteger(plen) || plen < 1 || plen > 128) throw new Error('Длина префикса IPv6: 1–128');
    if (eui) {
      if (plen !== 64) throw new Error('eui-64 работает только с префиксом /64');
      addr = ip6.net(addr, 64) | ip6.eui64(this.euiMac(f));
    }
    checkUnicast(addr);
    if (ip6.isLinkLocal(addr)) throw new Error('Link-local адрес задаётся командой ipv6 address FE80::… link-local');
    for (const g of this.ifaces) {
      if (g === f || !on(g)) continue;
      for (const a of g.v6.addrs) {
        if (a.origin === 'slaac') continue;
        if (ip6.sameNet(addr, a.addr, Math.min(plen, a.plen))) throw new Error('Префикс ' + ip6.cidr(addr, plen, true) + ' пересекается с интерфейсом ' + g.name);
      }
    }
    const st = v6(f);
    st.addrs = st.addrs.filter((a) => !(a.origin !== 'slaac' && ip6.sameNet(a.addr, addr, Math.min(plen, a.plen)) && a.addr === addr));
    st.addrs.push({ addr, plen, origin: 'manual', eui: !!eui });
    this.v6changed(f);
  };

  P6.removeIp6 = function (f, addr) {
    const st = v6(f);
    st.addrs = addr == null ? st.addrs.filter((a) => a.origin === 'slaac') : st.addrs.filter((a) => a.addr !== addr);
    this.v6changed(f);
  };

  P6.setLinkLocal6 = function (f, addr) {
    if (addr != null) {
      checkUnicast(addr);
      if (!ip6.isLinkLocal(addr)) throw new Error('Link-local адрес должен быть из FE80::/10');
    }
    v6(f).llManual = addr;
    this.v6changed(f);
  };

  P6.setIpv6Enable = function (f, yes) { v6(f).enabled = !!yes; this.v6changed(f); };

  P6.setAutoconfig6 = function (f, yes) {
    const st = v6(f);
    st.autoconfig = !!yes;
    if (!yes) { st.addrs = st.addrs.filter((a) => a.origin !== 'slaac'); st.raRouter = null; }
    this.v6changed(f);
  };

  P6.setIpv6Routing = function (yes) {
    if (yes && this.type !== 'router' && !(this.type === 'switch' && this.l3)) throw new Error('Маршрутизация IPv6 доступна на маршрутизаторе и коммутаторе 3560');
    this.v6cfg().routing = !!yes;
    for (const f of this.ifaces) if (on(f)) this.v6changed(f);
  };

  P6.addRoute6 = function (net, plen, nextHop, ifName) {
    if (net == null || !(plen >= 0 && plen <= 128)) throw new Error('Неверный префикс IPv6 (пример: 2001:DB8:2::/64)');
    if (ip6.net(net, plen) !== net) throw new Error('Префикс не совпадает с длиной (должно быть ' + ip6.cidr(net, plen, true) + ')');
    if (nextHop == null && !ifName) throw new Error('Укажите следующий переход или интерфейс');
    if (ifName && !this.ifaceByName(ifName)) throw new Error('Интерфейс ' + ifName + ' не найден');
    if (nextHop != null && ip6.isLinkLocal(nextHop) && !ifName) throw new Error('Для link-local следующего перехода укажите интерфейс: ipv6 route … GigabitEthernet0/0 FE80::2');
    const c = this.v6cfg();
    if (c.routes.some((r) => r.net === net && r.plen === plen && r.nextHop === nextHop && (r.ifName || null) === (ifName || null))) throw new Error('Такой маршрут уже есть');
    c.routes.push({ net, plen, nextHop: nextHop == null ? null : nextHop, ifName: ifName || null });
    this.net.emit('config', { dev: this });
  };

  P6.removeRoute6 = function (net, plen) {
    const c = this.v6cfg();
    const before = c.routes.length;
    c.routes = c.routes.filter((r) => !(r.net === net && r.plen === plen));
    return c.routes.length !== before;
  };

  /** Для ПК: статический адрес (addr/plen, шлюз) или автоматически (SLAAC). */
  P6.setIpv6Host = function (mode, addr, plen, gw) {
    const f = this.iface;
    if (!f) throw new Error('Нет сетевого интерфейса');
    const st = v6(f);
    st.enabled = true;
    if (mode === 'auto') {
      st.addrs = st.addrs.filter((a) => a.origin === 'slaac');
      st.autoconfig = true;
      this.v6cfg().gw = null;
    } else {
      st.autoconfig = false;
      st.raRouter = null;
      st.addrs = [];
      if (addr != null) {
        this.addIp6(f, addr, plen == null ? 64 : plen, false);
      }
      if (gw != null && !ip6.isLinkLocal(gw) && addr != null && !ip6.sameNet(gw, addr, plen == null ? 64 : plen)) throw new Error('Шлюз IPv6 должен быть в той же сети или link-local (FE80::…)');
      this.v6cfg().gw = gw == null ? null : gw;
    }
    this.v6changed(f);
  };

  P6.v6changed = function (f) {
    this.flush6(f);
    this.net.emit('config', { dev: this });
    if (!this.power || !this.ifaceUp(f) || !on(f)) return;
    if (this.forwarding6()) this.sendRA6(f, null);
    else if (f.v6.autoconfig) this.sendRS6(f);
  };

  /* ---------- маршрутизация ---------- */

  P6.connected6 = function (nh) {
    for (const f of this.ifaces) {
      if (!on(f) || !this.ifaceUp(f)) continue;
      if (f.v6.addrs.some((a) => ip6.sameNet(nh, a.addr, a.plen) && a.addr !== nh)) return f;
    }
    if (ip6.isLinkLocal(nh)) {
      for (const [, e] of this.nd6) if (e.addr === nh && this.ifaceUp(e.ifc)) return e.ifc;
      const ups = this.ifaces.filter((f) => on(f) && this.ifaceUp(f) && f.kind !== 'loop');
      if (ups.length === 1) return ups[0];
    }
    return null;
  };

  P6.gateway6 = function () {
    const f = this.iface || this.v6iface();
    if (!f || !on(f) || !this.ifaceUp(f)) return null;
    const c = this.v6cfg();
    if (c.gw != null) return { addr: c.gw, ifc: f };
    if (f.v6.autoconfig && f.v6.raRouter != null) return { addr: f.v6.raRouter, ifc: f };
    return null;
  };

  /** Маршрут: длиннейший префикс. {type, plen, net, ifc, nextHop}. */
  P6.lookup6 = function (dst, hintIfc) {
    if (ip6.isLinkLocal(dst)) {
      if (hintIfc && on(hintIfc) && this.ifaceUp(hintIfc)) return { type: 'C', plen: 64, net: ip6.net(dst, 64), ifc: hintIfc, nextHop: null };
      const f = this.connected6(dst);
      return f ? { type: 'C', plen: 64, net: ip6.net(dst, 64), ifc: f, nextHop: null } : null;
    }
    let best = null;
    const take = (r) => { if (!best || r.plen > best.plen || (r.plen === best.plen && r.ad < best.ad)) best = r; };
    for (const f of this.ifaces) {
      if (!on(f) || !this.ifaceUp(f)) continue;
      for (const a of f.v6.addrs) if (ip6.sameNet(dst, a.addr, a.plen)) take({ type: 'C', ad: 0, plen: a.plen, net: ip6.net(a.addr, a.plen), ifc: f, nextHop: null });
    }
    for (const r of this.v6cfg().routes) {
      if (ip6.net(dst, r.plen) !== r.net) continue;
      let via = null;
      if (r.ifName) {
        const f = this.ifaceByName(r.ifName);
        if (!f || !on(f) || !this.ifaceUp(f)) continue;
        via = { ifc: f, nextHop: r.nextHop };
      } else {
        const f = this.connected6(r.nextHop);
        if (!f) continue;
        via = { ifc: f, nextHop: r.nextHop };
      }
      take({ type: 'S', ad: 1, plen: r.plen, net: r.net, ifc: via.ifc, nextHop: via.nextHop });
    }
    if (!this.forwarding6()) {
      const gw = this.gateway6();
      if (gw) take({ type: 'S', ad: 1, plen: 0, net: 0n, ifc: gw.ifc, nextHop: gw.addr, gateway: true });
    }
    return best;
  };

  /** Таблица маршрутизации IPv6 (show ipv6 route). */
  P6.routingTable6 = function () {
    const rows = [];
    for (const f of this.ifaces) {
      if (!on(f) || !this.ifaceUp(f)) continue;
      for (const a of f.v6.addrs) {
        rows.push({ type: 'C', ad: 0, plen: a.plen, net: ip6.net(a.addr, a.plen), nextHop: null, ifname: f.name });
        rows.push({ type: 'L', ad: 0, plen: 128, net: a.addr, nextHop: null, ifname: f.name });
      }
    }
    for (const r of this.v6cfg().routes) {
      const f = r.ifName ? this.ifaceByName(r.ifName) : this.connected6(r.nextHop);
      rows.push({ type: 'S', ad: 1, plen: r.plen, net: r.net, nextHop: r.nextHop, ifname: f ? f.name : (r.ifName || ''), active: !!f && this.ifaceUp(f) });
    }
    const gw = !this.forwarding6() && this.gateway6();
    if (gw) rows.push({ type: 'S', ad: 1, plen: 0, net: 0n, nextHop: gw.addr, ifname: gw.ifc.name, active: true, gateway: true });
    return rows;
  };

  /* ---------- отправка ---------- */

  const ERR6 = { 'nd-fail': 'Узел не отвечает (нет ответа Neighbor Solicitation)', 'no-route': 'Нет IPv6-маршрута до узла', 'no-ip': 'У интерфейса нет IPv6-адреса', down: 'Интерфейс не активен', off: 'Устройство выключено' };

  P6.sendIp6 = function (pkt, opts) {
    opts = opts || {};
    const fail = (code) => { if (opts.onError) opts.onError(code, ERR6[code] || code); return false; };
    if (!this.power) return fail('off');
    if (this.hasIp6(pkt.dst)) {
      const f = this.ifaces.find((x) => on(x) && (this.ll6(x) === pkt.dst || x.v6.addrs.some((a) => a.addr === pkt.dst)));
      if (pkt.src == null) pkt.src = pkt.dst;
      this.timer(0, () => this.deliver6(pkt, f, null));
      return true;
    }
    if (ip6.isMulticast(pkt.dst)) {
      const f = opts.iface || this.v6iface();
      if (!f || !this.ifaceUp(f)) return fail('down');
      if (pkt.src == null) pkt.src = this.srcFor6(f, pkt.dst);
      this.sendFrame6(f, ip6.mcastMac(pkt.dst), pkt, opts.why);
      return true;
    }
    const r = this.lookup6(pkt.dst, opts.iface);
    if (!r) return fail(this.ifaces.some((f) => on(f)) ? 'no-route' : 'no-ip');
    if (pkt.src == null) pkt.src = this.srcFor6(r.ifc, pkt.dst);
    if (pkt.src == null) return fail('no-ip');
    this.resolve6(r.ifc, r.nextHop != null ? r.nextHop : pkt.dst, pkt, opts);
    return true;
  };

  P6.resolve6 = function (f, nh, pkt, opts) {
    if (this.isP2P(f)) { this.sendFrame6(f, null, pkt, opts.why); return; }
    const key = f.id + '|' + nh;
    const e = this.nd6.get(key);
    if (e && this.net.time - e.time < ND_AGE) { this.sendFrame6(f, e.mac, pkt, opts.why); return; }
    let pend = this.nd6pending.get(key);
    if (pend) { if (pend.queue.length < 64) pend.queue.push({ pkt, opts }); return; }
    pend = { ifc: f, addr: nh, queue: [{ pkt, opts }], tries: 0, timer: null };
    this.nd6pending.set(key, pend);
    this.ndAttempt6(key);
  };

  P6.ndAttempt6 = function (key) {
    const pend = this.nd6pending.get(key);
    if (!pend) return;
    const fail = (code) => {
      this.nd6pending.delete(key);
      for (const q of pend.queue) if (q.opts.onError) q.opts.onError(code, ERR6[code]);
    };
    if (!this.ifaceUp(pend.ifc)) return fail('down');
    if (pend.tries >= ND_RETRIES) {
      this.note('IPv6 ND: нет ответа от ' + ip6.str(pend.addr) + ' — пакеты отброшены', null, 'drop');
      return fail('nd-fail');
    }
    pend.tries++;
    const f = pend.ifc;
    const ns = P.ipv6(this.srcFor6(f, pend.addr), ip6.solicited(pend.addr), 'ICMPv6', { type: 'ns', target: pend.addr, mac: this.ifaceMac(f) }, 255);
    this.sendFrame6(f, ip6.mcastMac(ns.dst), ns, 'Neighbor Solicitation: у кого ' + ip6.str(pend.addr) + '?' + (pend.tries > 1 ? ' (попытка ' + pend.tries + ')' : ''));
    pend.timer = this.timer(ND_TIMEOUT, () => this.ndAttempt6(key));
  };

  P6.learn6 = function (addr, mac, f, router) {
    if (addr == null || addr === 0n || !mac) return;
    const key = f.id + '|' + addr;
    this.nd6.set(key, { addr, mac, ifc: f, time: this.net.time, router: !!router });
    const pend = this.nd6pending.get(key);
    if (pend) {
      this.nd6pending.delete(key);
      if (pend.timer) pend.timer.cancel();
      for (const q of pend.queue) this.sendFrame6(f, mac, q.pkt, q.opts.why);
    }
  };

  P6.sendFrame6 = function (f, mac, pkt, why) {
    if (IpNode.ifaceSenders[f.kind]) return false; // туннели и PPPoE переносят только IPv4
    if (this.isSerial(f)) {
      const p = this.ports[f.port];
      return this.ifaceSend(f, { src: null, dst: null, type: 'IPv6', vlan: null, payload: pkt, hops: 0, encap: (p.encap || 'hdlc').toUpperCase() }, why);
    }
    return this.ifaceSend(f, P.frame(this.ifaceMac(f), mac, 'IPv6', pkt, f.kind === 'sub' ? f.vlan : null), why);
  };

  P6.flush6 = function (f) {
    if (!this.nd6) return;
    for (const [k, e] of this.nd6) if (e.ifc === f) this.nd6.delete(k);
    for (const [k, pend] of this.nd6pending) {
      if (pend.ifc !== f) continue;
      this.nd6pending.delete(k);
      if (pend.timer) pend.timer.cancel();
      for (const q of pend.queue) if (q.opts.onError) q.opts.onError('down', ERR6.down);
    }
  };

  P6.nd6Entries = function () {
    const out = [];
    for (const e of this.nd6.values()) if (this.net.time - e.time < ND_AGE) out.push(e);
    return out;
  };

  P6.sendRA6 = function (f, dst) {
    if (!this.forwarding6() || !on(f)) return;
    const prefixes = f.v6.addrs.filter((a) => a.plen === 64 && a.origin !== 'slaac').map((a) => ({ net: ip6.net(a.addr, 64), plen: 64 }));
    const target = dst || ip6.ALL_NODES;
    const ra = P.ipv6(this.ll6(f), target, 'ICMPv6', { type: 'ra', mac: this.ifaceMac(f), prefixes }, 255);
    const why = 'Router Advertisement: я маршрутизатор' + (prefixes.length ? ', префикс ' + prefixes.map((x) => ip6.cidr(x.net, 64, true)).join(', ') : '');
    if (ip6.isMulticast(target)) this.sendFrame6(f, ip6.mcastMac(target), ra, why);
    else this.resolve6(f, target, ra, { why });
  };

  P6.sendRS6 = function (f) {
    if (!on(f) || !this.ifaceUp(f)) return;
    const rs = P.ipv6(this.ll6(f), ip6.ALL_ROUTERS, 'ICMPv6', { type: 'rs', mac: this.ifaceMac(f) }, 255);
    this.sendFrame6(f, ip6.mcastMac(ip6.ALL_ROUTERS), rs, 'Router Solicitation: есть ли маршрутизатор IPv6?');
  };

  /* ---------- приём ---------- */

  P6.isMine6 = function (dst, f) {
    if (dst === ip6.ALL_NODES) return true;
    if (dst === ip6.ALL_ROUTERS) return this.forwarding6();
    if ((dst >> 24n) === (ip6.SOLICITED >> 24n)) {
      const low = dst & 0xffffffn;
      if (((this.ll6(f) || 0n) & 0xffffffn) === low) return true;
      if (f.v6.addrs.some((a) => (a.addr & 0xffffffn) === low)) return true;
      return false;
    }
    return this.hasIp6(dst);
  };

  IpNode.ethertypes.IPv6 = function (f, frame) {
    const pkt = frame.payload;
    if (!on(f)) { this.drop(frame, 'IPv6 на интерфейсе ' + f.name + ' не включён'); return; }
    if (this.isMine6(pkt.dst, f)) { this.deliver6(pkt, f, frame); return; }
    if (this.forwarding6() && !ip6.isMulticast(pkt.dst) && !ip6.isLinkLocal(pkt.dst)) { this.forward6(pkt, f, frame); return; }
    this.drop(frame, ip6.isMulticast(pkt.dst) ? 'Групповой IPv6-пакет не для меня' : 'IPv6-пакет не для меня (получатель ' + ip6.str(pkt.dst) + ')');
  };

  P6.deliver6 = function (pkt, f, frame) {
    if (pkt.next !== 'ICMPv6') { if (frame) this.drop(frame, 'UDP и TCP поверх IPv6 в NetLab не поддерживаются'); return; }
    const m = pkt.payload;
    switch (m.type) {
      case 'echo-request': {
        const src = ip6.isMulticast(pkt.dst) ? this.srcFor6(f, pkt.src) : pkt.dst;
        this.sendIp6(P.ipv6(src, pkt.src, 'ICMPv6', P.echoReply(m.id, m.seq, m.size), this.defaultTtl), { iface: f, why: 'Эхо-ответ ICMPv6 на ping от ' + ip6.str(pkt.src) });
        break;
      }
      case 'echo-reply': {
        const h = this.icmpListeners.get(m.id);
        if (h) h({ kind: 'reply', from: pkt.src, seq: m.seq, ttl: pkt.hop });
        else if (frame) this.drop(frame, 'Эхо-ответ никто не ждёт');
        break;
      }
      case 'ns': {
        const mine = this.ll6(f) === m.target || f.v6.addrs.some((a) => a.addr === m.target);
        if (!mine) { if (frame) this.drop(frame, 'Neighbor Solicitation не для меня'); break; }
        if (pkt.src !== 0n) this.learn6(pkt.src, m.mac, f, false);
        const na = P.ipv6(m.target, pkt.src, 'ICMPv6', { type: 'na', target: m.target, mac: this.ifaceMac(f), router: this.forwarding6(), solicited: true }, 255);
        this.sendFrame6(f, m.mac, na, 'Neighbor Advertisement: ' + ip6.str(m.target) + ' — это я (' + this.ifaceMac(f) + ')');
        break;
      }
      case 'na':
        this.learn6(m.target, m.mac, f, m.router);
        break;
      case 'rs':
        if (!this.forwarding6()) { if (frame) this.drop(frame, 'Router Solicitation: я не маршрутизатор IPv6'); break; }
        if (pkt.src !== 0n) this.learn6(pkt.src, m.mac, f, false);
        this.sendRA6(f, null);
        break;
      case 'ra': {
        if (this.forwarding6()) break;
        this.learn6(pkt.src, m.mac, f, true);
        const st = v6(f);
        if (!st.autoconfig) break;
        st.raRouter = pkt.src;
        let changed = false;
        for (const pr of m.prefixes || []) {
          if (pr.plen !== 64) continue;
          const addr = pr.net | ip6.eui64(this.euiMac(f));
          if (st.addrs.some((a) => a.addr === addr)) continue;
          st.addrs = st.addrs.filter((a) => !(a.origin === 'slaac' && ip6.sameNet(a.addr, pr.net, 64)));
          st.addrs.push({ addr, plen: 64, origin: 'slaac' });
          changed = true;
          this.note('SLAAC: получен адрес ' + ip6.str(addr) + '/64, шлюз ' + ip6.str(pkt.src), null, 'accept');
        }
        if (changed) this.net.emit('config', { dev: this });
        break;
      }
      case 'unreachable':
      case 'time-exceeded': {
        const o = m.original;
        if (o && o.next === 'ICMPv6' && o.payload && o.payload.type === 'echo-request') {
          const h = this.icmpListeners.get(o.payload.id);
          if (h) h({ kind: m.type, code: m.code, from: pkt.src, seq: o.payload.seq });
        }
        break;
      }
      default: break;
    }
  };

  P6.icmp6Error = function (orig, type, code, f) {
    if (orig.next === 'ICMPv6' && orig.payload && orig.payload.type !== 'echo-request') return;
    if (orig.src == null || orig.src === 0n || ip6.isMulticast(orig.src)) return;
    const src = this.srcFor6(f, orig.src);
    const msg = { type, code, original: { src: orig.src, dst: orig.dst, next: orig.next, payload: U.clone(orig.payload) } };
    this.sendIp6(P.ipv6(src, orig.src, 'ICMPv6', msg, this.defaultTtl), { iface: f, why: type === 'time-exceeded' ? 'Hop Limit истёк — сообщаю отправителю' : 'Сообщаю отправителю: адрес IPv6 недоступен' });
  };

  P6.forward6 = function (pkt, f, frame) {
    if (pkt.hop <= 1) {
      this.icmp6Error(pkt, 'time-exceeded', 0, f);
      this.drop(frame, 'Hop Limit истёк — пакет IPv6 уничтожен');
      return;
    }
    const r = this.lookup6(pkt.dst);
    if (!r) {
      this.icmp6Error(pkt, 'unreachable', 0, f);
      this.drop(frame, 'Нет IPv6-маршрута до ' + ip6.str(pkt.dst));
      return;
    }
    const out = U.clone(pkt);
    out.hop = pkt.hop - 1;
    const why = r.type === 'C' ? 'Префикс ' + ip6.cidr(r.net, r.plen, true) + ' подключён напрямую → ' + r.ifc.name
      : 'Маршрут IPv6 ' + ip6.cidr(r.net, r.plen, true) + (r.nextHop != null ? ' через ' + ip6.str(r.nextHop, true) : '') + ' → ' + r.ifc.name;
    this.resolve6(r.ifc, r.nextHop != null ? r.nextHop : out.dst, out, { why, onError: () => this.icmp6Error(pkt, 'unreachable', 3, f) });
  };

  /* ---------- жизненный цикл ---------- */

  IpNode.hooks.runtime.push(function () {
    this.nd6 = new Map();
    this.nd6pending = new Map();
    if (!this.ifaces) return;
    // после включения питания ПК с автонастройкой снова спрашивают маршрутизатор
    for (const f of this.ifaces) {
      if (f.v6) { f.v6.addrs = f.v6.addrs.filter((a) => a.origin !== 'slaac'); f.v6.raRouter = null; }
      if (on(f) && f.v6.autoconfig) this.timer(5, () => this.sendRS6(f));
    }
  });

  const onLink = P6.onLinkChange;
  P6.onLinkChange = function (i, up) {
    onLink.call(this, i, up);
    for (const f of this.ifaces) {
      if (f.port !== i || !on(f)) continue;
      if (!up) { this.flush6(f); continue; }
      if (this.forwarding6()) this.timer(2, () => this.sendRA6(f, null));
      else if (f.v6.autoconfig) this.timer(2, () => this.sendRS6(f));
    }
  };

  const flushV4 = P6.flushIface;
  P6.flushIface = function (f, reason) { flushV4.call(this, f, reason); this.flush6(f); };

  /* ---------- сохранение ---------- */

  IpNode.ifaceExt.push({
    key: 'v6',
    save(f) {
      if (!f.v6 || !on(f)) return null;
      return {
        enabled: !!f.v6.enabled, autoconfig: !!f.v6.autoconfig, ll: f.v6.llManual != null ? ip6.str(f.v6.llManual) : null,
        addrs: f.v6.addrs.filter((a) => a.origin !== 'slaac').map((a) => ({ addr: ip6.str(a.addr), plen: a.plen, eui: !!a.eui })),
      };
    },
    load(f, d) {
      f.v6 = { enabled: false, autoconfig: false, llManual: null, addrs: [], raRouter: null };
      if (!d) return;
      f.v6.enabled = !!d.enabled;
      f.v6.autoconfig = !!d.autoconfig;
      f.v6.llManual = d.ll ? ip6.parse(d.ll) : null;
      for (const a of d.addrs || []) {
        const addr = ip6.parse(a.addr);
        if (addr != null && a.plen >= 1 && a.plen <= 128) f.v6.addrs.push({ addr, plen: a.plen, origin: 'manual', eui: !!a.eui });
      }
    },
  });

  NS.deviceExt.push({
    key: 'ipv6',
    applies: (d) => !!d.ifaces,
    save(d) {
      const c = d.v6cfg();
      if (!c.routing && !c.routes.length && c.gw == null && c.dns == null) return null;
      return {
        routing: !!c.routing, gw: c.gw != null ? ip6.str(c.gw) : null, dns: c.dns != null ? ip6.str(c.dns) : null,
        routes: c.routes.map((r) => ({ net: ip6.str(r.net), plen: r.plen, nextHop: r.nextHop != null ? ip6.str(r.nextHop) : null, ifName: r.ifName || null })),
      };
    },
    load(d, c) {
      d.v6 = { routing: false, routes: [], gw: null, dns: null };
      if (!c) return;
      d.v6.routing = !!c.routing;
      d.v6.gw = c.gw ? ip6.parse(c.gw) : null;
      d.v6.dns = c.dns ? ip6.parse(c.dns) : null;
      for (const r of c.routes || []) {
        const net = ip6.parse(r.net);
        if (net == null) continue;
        d.v6.routes.push({ net, plen: Number(r.plen) || 0, nextHop: r.nextHop ? ip6.parse(r.nextHop) : null, ifName: r.ifName || null });
      }
    },
  });

  // У компьютеров IPv6 включён по умолчанию (есть link-local адрес), как в Windows.
  if (NS.Host) {
    const sync = NS.Host.prototype.syncIfaces;
    NS.Host.prototype.syncIfaces = function () {
      sync.call(this);
      const f = this.iface;
      if (f && !f.v6) f.v6 = { enabled: true, autoconfig: false, llManual: null, addrs: [], raRouter: null };
    };
    const hostLoad = NS.Host.prototype.loadConfig;
    NS.Host.prototype.loadConfig = function (c) {
      hostLoad.call(this, c);
      const f = this.iface;
      if (f && f.v6 && !(c && Array.isArray(c.ifaces) && c.ifaces[0] && c.ifaces[0].v6)) f.v6.enabled = true;
    };
  }

  /* ================= описание пакетов ================= */

  const ICMP6 = {
    'echo-request': 'Эхо-запрос ICMPv6 (ping)', 'echo-reply': 'Эхо-ответ ICMPv6', ns: 'Neighbor Solicitation', na: 'Neighbor Advertisement',
    rs: 'Router Solicitation', ra: 'Router Advertisement', unreachable: 'Адрес недоступен', 'time-exceeded': 'Hop Limit истёк',
  };

  P.register({
    protocols: { ICMPv6: { label: 'ICMPv6', color: '#2563eb' }, NDP: { label: 'NDP (IPv6)', color: '#d97706' } },
    ethertypes: { IPv6: '0x86DD IPv6' },
    classify(f) {
      if (f.type !== 'IPv6') return null;
      const m = f.payload && f.payload.payload;
      return m && (m.type === 'ns' || m.type === 'na' || m.type === 'rs' || m.type === 'ra') ? 'NDP' : 'ICMPv6';
    },
    summary(f) {
      if (f.type !== 'IPv6') return null;
      const p = f.payload;
      const m = p.payload || {};
      const route = ip6.str(p.src) + ' → ' + ip6.str(p.dst);
      if (m.type === 'ns') return 'NDP: у кого ' + ip6.str(m.target) + '? (' + route + ')';
      if (m.type === 'na') return 'NDP: ' + ip6.str(m.target) + ' — это ' + m.mac;
      if (m.type === 'ra') return 'Router Advertisement' + ((m.prefixes || []).length ? ': префикс ' + m.prefixes.map((x) => ip6.cidr(x.net, x.plen)).join(', ') : '') + ', ' + route;
      return (ICMP6[m.type] || ('IPv6 ' + p.next)) + ', ' + route;
    },
    layers(f) {
      if (f.type !== 'IPv6') return null;
      const p = f.payload;
      const m = p.payload || {};
      const out = [P.l2Layer(f)];
      if (f.vlan != null) out.push({ title: '802.1Q (тег VLAN)', fields: [['VLAN ID', String(f.vlan)]] });
      out.push({ title: 'IPv6 (уровень 3)', fields: [['Источник', ip6.str(p.src)], ['Назначение', ip6.str(p.dst) + (ip6.isMulticast(p.dst) ? ' (групповой)' : '')], ['Hop Limit', String(p.hop)], ['Следующий заголовок', p.next]] });
      const fields = [['Тип', ICMP6[m.type] || m.type]];
      if (m.id !== undefined) fields.push(['Идентификатор', String(m.id)], ['Номер', String(m.seq)]);
      if (m.target != null) fields.push(['Искомый адрес', ip6.str(m.target)]);
      if (m.mac) fields.push(['MAC-адрес (опция)', m.mac]);
      if (m.type === 'na') fields.push(['Флаг Router', m.router ? 'да' : 'нет']);
      if (m.prefixes) fields.push(['Префиксы', m.prefixes.map((x) => ip6.cidr(x.net, x.plen)).join(', ') || '—']);
      if (m.original) fields.push(['Исходный пакет', ip6.str(m.original.src) + ' → ' + ip6.str(m.original.dst)]);
      out.push({ title: 'ICMPv6', fields });
      return out;
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;
  const up = (v) => ip6.str(v, true);

  X.global.push((t) => t[0] && /^ipv6$/i.test(t[0]) && /^(unicast-routing|route|host)$/i.test(t[1] || ''));

  X.config.push((dev, s, a, neg, io, C) => {
    if (!C.kw(a[0], 'ipv6', 4)) return false;
    if (C.kw(a[1], 'unicast-routing', 1)) { C.withMutate(io, () => dev.setIpv6Routing(!neg)); return true; }
    if (C.kw(a[1], 'route', 1)) {
      const pr = ip6.parsePrefix(a[2]);
      if (!pr) { C.invalid(io, a[2]); return true; }
      if (neg) {
        let found = false;
        C.withMutate(io, () => { found = dev.removeRoute6(pr.addr, pr.plen); });
        if (!found) io.out('% Такого маршрута нет.');
        return true;
      }
      let ifName = null;
      let nh = null;
      for (const x of a.slice(3)) {
        const v = ip6.parse(x);
        if (v != null) nh = v;
        else {
          const r = C.parseIfName(dev, x);
          const f = r && C.ifaceOf(dev, r);
          if (!f) { C.invalid(io, x); return true; }
          ifName = f.name;
        }
      }
      if (nh == null && !ifName) { C.incomplete(io); return true; }
      C.withMutate(io, () => dev.addRoute6(pr.addr, pr.plen, nh, ifName));
      return true;
    }
    if (C.kw(a[1], 'host', 1) || C.kw(a[1], 'cef', 2)) return true;
    C.invalid(io, a[1]);
    return true;
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (!C.kw(a[0], 'ipv6', 4)) return false;
    const ifs = targets.map((r) => C.ifaceOf(dev, r));
    if (ifs.some((f) => !f)) { io.out('% Порт коммутатора работает на 2-м уровне. IPv6-адрес задаётся на interface vlan или маршрутизируемом порту.'); return true; }
    const each = (fn) => C.withMutate(io, () => { for (const f of ifs) fn(f); });
    if (C.kw(a[1], 'enable', 2)) { each((f) => dev.setIpv6Enable(f, !neg)); return true; }
    if (C.kw(a[1], 'address', 1)) {
      if (C.kw(a[2], 'autoconfig', 2)) { each((f) => dev.setAutoconfig6(f, !neg)); return true; }
      if (neg && !a[2]) { each((f) => { dev.removeIp6(f, null); dev.setLinkLocal6(f, null); }); return true; }
      if (a[3] && C.kw(a[3], 'link-local', 1)) {
        const v = ip6.parse(a[2]);
        if (v == null) { C.invalid(io, a[2]); return true; }
        each((f) => dev.setLinkLocal6(f, neg ? null : v));
        return true;
      }
      const pr = ip6.parsePrefix(a[2]);
      if (!pr) { if (!a[2]) C.incomplete(io); else C.invalid(io, a[2]); return true; }
      const eui = !!a[3] && C.kw(a[3], 'eui-64', 1);
      if (neg) { each((f) => dev.removeIp6(f, eui ? ip6.net(pr.addr, 64) | ip6.eui64(dev.euiMac(f)) : pr.addr)); return true; }
      each((f) => dev.addIp6(f, pr.addr, pr.plen, eui));
      return true;
    }
    if (C.kw(a[1], 'nd', 2) || C.kw(a[1], 'ospf', 2) || C.kw(a[1], 'rip', 2)) return true;
    C.invalid(io, a[1]);
    return true;
  });

  X.running.global.push((dev) => (dev.v6 && dev.v6.routing ? ['ipv6 unicast-routing', '!'] : []));
  X.running.iface.push((dev, f) => {
    if (!f || !on(f)) return [];
    const L = [];
    if (f.v6.llManual != null) L.push(' ipv6 address ' + up(f.v6.llManual) + ' link-local');
    for (const a of f.v6.addrs) {
      if (a.origin === 'slaac') continue;
      L.push(' ipv6 address ' + (a.eui ? ip6.cidr(a.addr, 64, true) + ' eui-64' : up(a.addr) + '/' + a.plen));
    }
    if (f.v6.autoconfig) L.push(' ipv6 address autoconfig');
    if (f.v6.enabled && !f.v6.addrs.length && f.v6.llManual == null && !f.v6.autoconfig) L.push(' ipv6 enable');
    return L;
  });
  X.running.tail.push((dev) => (dev.v6 && dev.v6.routes.length
    ? dev.v6.routes.map((r) => 'ipv6 route ' + ip6.cidr(r.net, r.plen, true) + (r.ifName ? ' ' + r.ifName : '') + (r.nextHop != null ? ' ' + up(r.nextHop) : '')).concat('!')
    : []));

  function showBrief(dev, io) {
    for (const f of dev.ifaces) {
      if (f.runtime) continue;
      const upNow = dev.ifaceUp(f);
      const p = f.port >= 0 ? dev.ports[f.port] : null;
      const admin = f.adminUp && (!p || p.adminUp);
      io.out(C0.pad(f.name, 26) + '[' + (!admin ? 'administratively down' : upNow ? 'up' : 'down') + '/' + (upNow ? 'up' : 'down') + ']');
      if (!on(f)) { io.out('    unassigned'); continue; }
      io.out('    ' + up(dev.ll6(f)));
      for (const a of f.v6.addrs) io.out('    ' + up(a.addr));
    }
  }
  const C0 = NS.cliIos.ctx;

  X.show.push((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'ipv6', 4)) return false;
    if (C.kw(a[1], 'interface', 1)) {
      if (C.kw(a[2], 'brief', 1)) { showBrief(dev, io); return true; }
      const list = a[2] ? [C.ifaceOf(dev, C.parseIfName(dev, a.slice(2).join('')) || {})].filter(Boolean) : dev.ifaces.filter(on);
      for (const f of list) {
        io.out(f.name + ' is ' + (dev.ifaceUp(f) ? 'up' : 'down') + ', line protocol is ' + (dev.ifaceUp(f) ? 'up' : 'down'));
        if (!on(f)) { io.out('  IPv6 is disabled'); continue; }
        io.out('  IPv6 is enabled, link-local address is ' + up(dev.ll6(f)));
        io.out('  Global unicast address(es):');
        for (const x of f.v6.addrs) io.out('    ' + up(x.addr) + ', subnet is ' + ip6.cidr(x.addr, x.plen, true) + (x.origin === 'slaac' ? ' [EUI/CAL/PRE]' : x.eui ? ' [EUI]' : ''));
        io.out('  Joined group address(es):');
        io.out('    FF02::1');
        if (dev.forwarding6()) io.out('    FF02::2');
        io.out('    ' + up(ip6.solicited(dev.ll6(f))));
      }
      return true;
    }
    if (C.kw(a[1], 'route', 1)) {
      io.out('IPv6 Routing Table - ' + dev.routingTable6().length + ' entries');
      io.out('Codes: C - Connected, L - Local, S - Static');
      io.out('');
      for (const r of dev.routingTable6()) {
        io.out(r.type + '   ' + ip6.cidr(r.net, r.plen, true) + ' [' + r.ad + '/0]');
        io.out('     via ' + (r.nextHop != null ? up(r.nextHop) + (r.ifname ? ', ' + r.ifname : '') : r.ifname + (r.type === 'L' ? ', receive' : ', directly connected')));
      }
      return true;
    }
    if (C.kw(a[1], 'neighbors', 1)) {
      io.out('IPv6 Address                              Age Link-layer Addr State Interface');
      for (const e of dev.nd6Entries()) io.out(C.pad(up(e.addr), 42) + C.pad(String(Math.floor((dev.net.time - e.time) / 6000)), 4) + C.pad(U.ciscoMac(e.mac), 15) + C.pad('REACH', 6) + e.ifc.name);
      return true;
    }
    if (C.kw(a[1], 'protocols', 1)) { io.out('IPv6 Routing Protocol is "connected"'); io.out('IPv6 Routing Protocol is "static"'); return true; }
    C.invalid(io, a[1]);
    return true;
  });

  // ping ipv6 X / ping 2001:… / traceroute ipv6 X
  X.exec.push((dev, s, t, io, line, C) => {
    const isPing = C.kw(t[0], 'ping', 1);
    const isTrace = C.kw(t[0], 'traceroute', 3) || C.kw(t[0], 'tracert', 6);
    if (!isPing && !isTrace) return null;
    const args = t.slice(1).filter((x) => !/^ipv6$/i.test(x));
    const target = args.find((x) => ip6.parse(x) != null);
    if (!target && !t.slice(1).some((x) => /^ipv6$/i.test(x))) return null;
    if (!target) { io.out('% Укажите IPv6-адрес, например: ping ipv6 2001:DB8::1'); return { handled: true }; }
    return { handled: true, job: isPing ? C.iosPing(dev, args, io) : C.iosTraceroute(dev, [target], io) };
  });

  X.tree.config = (X.tree.config || []).concat(['ipv6 unicast-routing', 'ipv6 route WORD WORD']);
  X.tree.if = (X.tree.if || []).concat(['ipv6 address WORD', 'ipv6 address WORD eui-64', 'ipv6 address WORD link-local', 'ipv6 address autoconfig', 'ipv6 enable']);
  X.tree.exec = (X.tree.exec || []).concat(['show ipv6 interface brief', 'show ipv6 interface WORD', 'show ipv6 route', 'show ipv6 neighbors', 'ping ipv6 WORD', 'traceroute ipv6 WORD']);
  X.tree.user = (X.tree.user || []).concat(['show ipv6 interface brief', 'show ipv6 route', 'ping ipv6 WORD']);

  /* ================= командная строка ПК ================= */

  const H = NS.cliHost.ext;
  H.ipconfig.push((dev, f, all, io) => {
    if (!on(f)) return;
    const w = (s) => io.out(s);
    for (const a of f.v6.addrs) w('   IPv6-адрес. . . . . . . . . . . . : ' + ip6.str(a.addr) + (a.origin === 'slaac' ? ' (автонастройка)' : ''));
    w('   Локальный IPv6-адрес канала . . . : ' + ip6.str(dev.ll6(f)) + '%' + f.id);
    const gw = dev.gateway6();
    if (gw) w('   Основной шлюз (IPv6). . . . . . . : ' + ip6.str(gw.addr) + (ip6.isLinkLocal(gw.addr) ? '%' + f.id : ''));
  });
  H.commands.ipv6config = (dev, s, args, io) => {
    const f = dev.iface;
    io.out('');
    io.out('Настройка протокола IPv6');
    io.out('');
    if (!f || !on(f)) { io.out('IPv6 выключен.'); return null; }
    io.out('   Режим . . . . . . . . . . . . . . : ' + (f.v6.autoconfig ? 'автоматически (SLAAC)' : 'статически'));
    io.out('   Локальный IPv6-адрес канала . . . : ' + ip6.str(dev.ll6(f)));
    for (const a of f.v6.addrs) io.out('   IPv6-адрес. . . . . . . . . . . . : ' + ip6.str(a.addr) + '/' + a.plen);
    const gw = dev.gateway6();
    io.out('   Основной шлюз (IPv6). . . . . . . : ' + (gw ? ip6.str(gw.addr) : ''));
    if (f.v6.autoconfig && !gw) io.out('Маршрутизатор IPv6 не найден: нет ответа на Router Solicitation (нужен ipv6 unicast-routing на маршрутизаторе).', 'hint');
    return null;
  };
  H.help.push('  ipv6config                                               настройки IPv6');

  // ping/tracert по IPv6-адресу — те же команды; подсказки для ошибок IPv6
  NS.ip6Errors = ERR6;
})(globalThis.NetLab = globalThis.NetLab || {});
