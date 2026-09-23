/* NetLab — конечные узлы: ПК, ноутбук, сервер, принтер, планшет.
 * Сменная сетевая карта (медь / оптика / Wi-Fi), брандмауэр узла, «Блокнот», настройки почтового клиента,
 * «Сообщения» (надёжная прямая доставка нескольким получателям с подтверждением),
 * службы сервера: DHCP, DNS, HTTP, почта (SMTP/POP3), TFTP. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;

  const MAIL_ACK_TIMEOUT = 300;
  const MAIL_TRIES = 3;
  const MAIL_BCAST_WINDOW = 250;

  class Host extends NS.IpNode {
    constructor(net, id, name, model, type) {
      super(net, id, type || 'pc', name, model);
      this.gateway = null;
      this.dns = null;
      this.defaultTtl = 128;
      this.useApipa = true;
      this.inbox = [];
      this.outbox = [];
      this.mailSeen = new Set();
      this.firewall = { enabled: false, rules: [] };
      this.files = [];
      this.email = { name: '', address: '', incoming: '', outgoing: '', user: '', password: '' };
      this.emailBox = [];
      this.wifi = { ssid: '', security: 'open', key: '' };
      this.dhcpd = null;
      this.dnsd = null;
      this.httpd = null;
      this.maild = null;
      this.tftpd = null;
      if (this.type === 'server') {
        this.dhcpd = new NS.DhcpService(this);
        this.dnsd = new NS.DnsService(this);
        this.httpd = new NS.HttpService(this);
        this.maild = new NS.EmailService(this);
        this.tftpd = new NS.TftpService(this);
      }
      this.syncIfaces();
      this.bindServices();
    }

    /** Единственный сетевой интерфейс узла (на порту сетевой карты; без карты — port -1). */
    get iface() { return this.ifaces[0]; }

    syncIfaces() {
      if (!this.ifaces) return;
      // IoT-пины (D0…, A0…) у одноплатного компьютера — не сетевая карта
      const idx = this.ports.findIndex((p) => NS.Network.isData(p) && p.media !== 'iot');
      if (!this.ifaces.length) this.addIface(idx, idx >= 0 ? this.ports[idx].name : 'нет сетевой карты');
      const f = this.ifaces[0];
      f.port = idx;
      f.name = idx >= 0 ? this.ports[idx].name : 'нет сетевой карты';
      this.ifaces.length = 1;
    }

    /** Сетевую карту сняли — интерфейс остаётся, но без порта. */
    portsChanged(map) {
      if (!this.ifaces || !this.ifaces.length) return;
      this.syncIfaces();
    }

    bindServices() {
      super.bindServices();
      this.udp.set(P.PORT_MAIL, (pkt, f, frame) => this.onMail(pkt, f, frame));
      this.udpErr.set(P.PORT_MAIL, (info) => this.onMailError(info));
      if (this.dhcpd) {
        this.udp.set(67, (pkt, f, frame) => {
          if (this.dhcpd.enabled) this.dhcpd.handle(pkt, f);
          else if (frame) this.drop(frame, 'Служба DHCP на сервере выключена');
        });
      }
      if (this.dnsd) {
        this.udp.set(53, (pkt, f, frame) => {
          if (this.dnsd.enabled) this.dnsd.handle(pkt, f);
          else this.portClosed(pkt, f, frame);
        });
      }
      if (this.httpd) this.httpd.bind();
      if (this.maild) this.maild.bind();
      if (this.tftpd) this.tftpd.bind();
    }

    /** Перепривязать службы после изменения настроек (включение/выключение HTTP, почты…). */
    rebindServices() { this.bindServices(); }

    reset() {
      super.reset();
      for (const m of this.outbox) {
        for (const it of m.items) {
          if (it.status === 'pending' || it.status === 'sending') {
            it.status = 'fail';
            it.text = 'Отправка прервана (устройство перезапущено)';
          }
        }
      }
    }

    staticRoutes() {
      return this.gateway != null ? [{ net: 0, mask: 0, nextHop: this.gateway, gateway: true }] : [];
    }

    onDhcpBound(f, d) {
      this.gateway = d.router || null;
      this.dns = d.dns || null;
    }

    onDhcpUnbound() {
      this.gateway = null;
      this.dns = null;
    }

    /* ---------- настройка ---------- */

    /** Статическая настройка. Все значения — числа или null. Бросает Error. */
    setStatic(ip, mask, gateway, dns) {
      const f = this.iface;
      if (ip != null) {
        const err = U.validateHostIp(ip, mask);
        if (err) throw new Error(err);
      }
      if (gateway != null) {
        if (ip == null) throw new Error('Сначала задайте IP-адрес');
        if (!U.sameNet(gateway, ip, mask)) throw new Error('Шлюз ' + U.ipStr(gateway) + ' не в сети ' + U.cidr(U.net(ip, mask), mask) + ' — пакеты не смогут до него дойти');
        if (gateway === ip) throw new Error('Шлюз не может совпадать с собственным адресом');
        if (!U.isHostAddress(gateway, mask)) throw new Error('Шлюз не может быть адресом сети или широковещательным');
      }
      this.stopDhcp();
      f.dhcp = false;
      this.dhcpStatus = '';
      this.gateway = gateway;
      this.dns = dns;
      f.ip = ip;
      f.mask = ip == null ? null : mask;
      this.addressChanged(f);
    }

    setDhcp() {
      const f = this.iface;
      f.dhcp = true;
      f.ip = null;
      f.mask = null;
      this.gateway = null;
      this.dns = null;
      this.addressChanged(f);
      this.startDhcp(f);
    }

    startDhcp(f) { super.startDhcp(f || this.iface); }

    setWifi(cfg) {
      NS.validateWifi(Object.assign({}, cfg, cfg.security === 'open' ? { key: undefined } : {}));
      Object.assign(this.wifi, cfg);
      this.net.refreshTopology();
    }

    /* ---------- брандмауэр узла ---------- */

    /** rule: {action: allow|deny, proto: ip|icmp|tcp|udp, remote, wc, port} */
    addFirewallRule(rule) {
      const r = {
        action: rule.action === 'deny' ? 'deny' : 'allow',
        proto: ['ip', 'icmp', 'tcp', 'udp'].includes(rule.proto) ? rule.proto : 'ip',
        remote: rule.remote == null ? 0 : rule.remote,
        wc: rule.wc == null ? 0xFFFFFFFF : rule.wc,
        port: rule.port == null || rule.port === '' ? null : Number(rule.port),
      };
      if (r.port != null && !(r.port >= 0 && r.port <= 65535)) throw new Error('Порт: 0–65535');
      this.firewall.rules.push(r);
    }

    /** Входящий пакет: причина отказа или null. Ответы на собственный трафик всегда пропускаются. */
    firewallCheck(pkt) {
      const fw = this.firewall;
      if (!fw || !fw.enabled) return null;
      const l4 = pkt.payload || {};
      if (pkt.proto === 'ICMP' && l4.type !== 'echo-request') return null;
      if ((pkt.proto === 'TCP' || pkt.proto === 'UDP') && l4.dport >= 49152) return null;
      if (pkt.proto === 'UDP' && l4.dport === 68) return null;
      if (pkt.proto === 'UDP' && l4.dport === P.PORT_MAIL && l4.data && l4.data.kind === 'ack') return null;
      if (pkt.proto === 'TCP' && !P.hasFlag(l4, 'SYN') && this.tcp && this.tcp.conns.has(pkt.src + ':' + l4.sport + ':' + l4.dport)) return null;
      for (const r of fw.rules) {
        if (r.proto !== 'ip' && r.proto !== pkt.proto.toLowerCase()) continue;
        if (!U.matchWild(pkt.src, r.remote, r.wc)) continue;
        if (r.port != null && (r.proto === 'tcp' || r.proto === 'udp') && l4.dport !== r.port) continue;
        return r.action === 'allow' ? null : 'Брандмауэр узла: запрещено правилом (' + r.proto + (r.port != null ? ' порт ' + r.port : '') + ')';
      }
      return 'Брандмауэр узла включён: для этого входящего трафика нет разрешающего правила';
    }

    /* ---------- «Блокнот» ---------- */

    saveFile(name, text) {
      const n = String(name || '').trim();
      if (!/^[\p{L}\p{N} _.-]{1,64}$/u.test(n)) throw new Error('Имя файла: буквы, цифры, пробел, «.», «-», «_»');
      const f = this.files.find((x) => x.name === n);
      if (f) f.text = String(text || '');
      else this.files.push({ name: n, text: String(text || '') });
    }

    deleteFile(name) { this.files = this.files.filter((f) => f.name !== name); }

    /* ---------- «Сообщения»: прямая доставка ---------- */

    /**
     * Отправить сообщение нескольким получателям.
     * to — массив строк: IP-адрес, DNS-имя или '*' (всем в своей подсети).
     * Каждому получателю — отдельная доставка с подтверждением и повторами.
     */
    sendMail(to, subject, body) {
      const targets = [];
      const seen = new Set();
      for (const raw of to) {
        const t = String(raw).trim();
        if (!t || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        targets.push(t);
      }
      if (!targets.length) throw new Error('Не указан ни один получатель');
      const msg = {
        id: this.net.counters.msg++,
        subject: String(subject || ''),
        body: String(body || ''),
        time: this.net.time,
        items: targets.map((t) => ({ target: t, ip: null, status: 'pending', text: 'Ожидание…', attempts: 0, timer: null, acks: null })),
      };
      this.outbox.unshift(msg);
      if (this.outbox.length > 100) this.outbox.length = 100;
      for (const it of msg.items) this.mailDeliver(msg, it);
      this.mailChanged(msg);
      return msg;
    }

    mailChanged(msg) { this.net.emit('mail-status', { dev: this, msg }); }

    mailFinish(msg, it, ok, text) {
      if (it.status === 'ok' || it.status === 'fail') return;
      if (it.timer) it.timer.cancel();
      it.timer = null;
      it.status = ok ? 'ok' : 'fail';
      it.text = text;
      this.mailChanged(msg);
    }

    mailPacket(msg, dst, bcast) {
      return P.ipv4(null, dst, 'UDP', P.udp(P.PORT_MAIL, P.PORT_MAIL, {
        kind: 'msg', id: msg.id, fromName: this.name, subject: msg.subject, body: msg.body, bcast: !!bcast,
      }), this.defaultTtl);
    }

    mailDeliver(msg, it) {
      if (it.target === '*') {
        const f = this.iface;
        if (f.ip == null) return this.mailFinish(msg, it, false, 'Нет IP-адреса');
        it.bcast = true;
        it.acks = [];
        it.ip = U.bcast(f.ip, f.mask);
        it.status = 'sending';
        it.text = 'Рассылка всем в подсети ' + U.cidr(U.net(f.ip, f.mask), f.mask) + '…';
        this.sendIp(this.mailPacket(msg, it.ip, true), { why: 'Сообщение всем в подсети', onError: (c, t) => this.mailFinish(msg, it, false, t) });
        it.timer = this.timer(MAIL_BCAST_WINDOW, () => {
          const n = it.acks.length;
          this.mailFinish(msg, it, n > 0, n > 0 ? 'Доставлено ' + n + ' получател' + (n === 1 ? 'ю' : 'ям') + ': ' + it.acks.join(', ') : 'Никто в подсети не ответил');
        });
        return;
      }
      it.status = 'sending';
      it.text = 'Определение адреса…';
      this.resolveName(it.target, (ip, err) => {
        if (it.status !== 'sending') return;
        if (ip == null) return this.mailFinish(msg, it, false, err || 'Не удалось определить адрес');
        it.ip = ip;
        this.mailAttempt(msg, it);
      });
    }

    mailAttempt(msg, it) {
      if (it.status !== 'sending') return;
      if (it.attempts >= MAIL_TRIES) return this.mailFinish(msg, it, false, 'Нет подтверждения от получателя (' + MAIL_TRIES + ' попытки)');
      it.attempts++;
      it.text = it.attempts === 1 ? 'Отправка…' : 'Повторная отправка (' + it.attempts + '/' + MAIL_TRIES + ')…';
      this.mailChanged(msg);
      this.sendIp(this.mailPacket(msg, it.ip, false), {
        why: 'Сообщение «' + (msg.subject || 'без темы') + '» для ' + it.target,
        onError: (c, t) => this.mailFinish(msg, it, false, t),
      });
      it.timer = this.timer(MAIL_ACK_TIMEOUT, () => this.mailAttempt(msg, it));
    }

    onMail(pkt, f, frame) {
      const d = pkt.payload.data || {};
      if (d.kind === 'msg') {
        const key = U.ipStr(pkt.src) + '#' + d.id;
        if (!this.mailSeen.has(key)) {
          this.mailSeen.add(key);
          const m = { key, from: String(d.fromName || ''), fromIp: pkt.src, subject: String(d.subject || ''), body: String(d.body || ''), time: this.net.time, read: false, bcast: !!d.bcast };
          this.inbox.unshift(m);
          if (this.inbox.length > 200) this.inbox.length = 200;
          this.note('Получено сообщение от ' + (m.from || U.ipStr(m.fromIp)), frame, 'accept');
          this.net.emit('mail', { dev: this, message: m });
        }
        const src = pkt.dst === U.BROADCAST_IP || this.isDirectedBcast(pkt.dst, f) ? f.ip : pkt.dst;
        this.sendIp(P.ipv4(src, pkt.src, 'UDP', P.udp(P.PORT_MAIL, P.PORT_MAIL, { kind: 'ack', id: d.id }), this.defaultTtl), { why: 'Подтверждаю получение сообщения' });
      } else if (d.kind === 'ack') {
        const msg = this.outbox.find((m) => m.id === d.id);
        if (!msg) return;
        let used = false;
        for (const it of msg.items) {
          if (it.status !== 'sending') continue;
          if (it.bcast) {
            const who = U.ipStr(pkt.src);
            if (!it.acks.includes(who)) it.acks.push(who);
            used = true;
          } else if (it.ip === pkt.src) {
            this.mailFinish(msg, it, true, 'Доставлено');
            used = true;
          }
        }
        if (used) {
          this.note('Подтверждение доставки от ' + U.ipStr(pkt.src), frame, 'accept');
          this.mailChanged(msg);
        }
      }
    }

    onMailError(info) {
      const o = info.original;
      const d = o && o.payload && o.payload.data;
      if (!d || d.kind !== 'msg') return;
      const msg = this.outbox.find((m) => m.id === d.id);
      if (!msg) return;
      for (const it of msg.items) {
        if (it.status !== 'sending' || it.ip !== o.dst) continue;
        let text;
        if (info.kind === 'time-exceeded') text = U.ipStr(info.from) + ': истёк TTL (возможна петля маршрутизации)';
        else if (info.code === 3) text = U.ipStr(info.from) + ': узел не принимает сообщения';
        else if (info.code === 13) text = U.ipStr(info.from) + ': запрещено списком доступа';
        else if (info.code === 0) text = U.ipStr(info.from) + ': нет маршрута до сети получателя';
        else text = U.ipStr(info.from) + ': получатель недоступен';
        this.mailFinish(msg, it, false, text);
      }
    }

    markAllRead() { for (const m of this.inbox) m.read = true; }

    unreadCount() {
      return this.inbox.reduce((n, m) => n + (m.read ? 0 : 1), 0) + this.emailBox.reduce((n, m) => n + (m.read ? 0 : 1), 0);
    }

    /* ---------- сохранение ---------- */

    serializeConfig() {
      const ip = (v) => (v == null ? null : U.ipStr(v));
      const c = {
        ifaces: this.serializeIfaces(),
        gateway: ip(this.gateway),
        dns: ip(this.dns),
        dhcpBound: !!(this.dhcpc && this.dhcpc.phase === 'bound'),
        dhcpServer: this.dhcpc && this.dhcpc.server ? U.ipStr(this.dhcpc.server) : null,
        inbox: this.inbox.map((m) => ({ from: m.from, fromIp: U.ipStr(m.fromIp), subject: m.subject, body: m.body, time: m.time, read: m.read, bcast: m.bcast })),
        outbox: this.outbox.map((m) => ({
          id: m.id, subject: m.subject, body: m.body, time: m.time,
          items: m.items.map((it) => ({ target: it.target, ip: ip(it.ip), status: it.status === 'ok' ? 'ok' : 'fail', text: it.status === 'ok' || it.status === 'fail' ? it.text : 'Отправка прервана' })),
        })),
        firewall: { enabled: this.firewall.enabled, rules: this.firewall.rules.map((r) => ({ action: r.action, proto: r.proto, remote: U.ipStr(r.remote), wc: U.ipStr(r.wc), port: r.port })) },
        files: this.files.map((f) => Object.assign({}, f)),
        email: Object.assign({}, this.email),
        emailBox: this.emailBox.map((m) => Object.assign({}, m)),
        wifi: Object.assign({}, this.wifi),
      };
      if (this.dhcpd) c.dhcpd = this.dhcpd.serialize();
      if (this.dnsd) c.dnsd = this.dnsd.serialize();
      if (this.httpd) c.httpd = this.httpd.serialize();
      if (this.maild) c.maild = this.maild.serialize();
      if (this.tftpd) c.tftpd = this.tftpd.serialize();
      return c;
    }

    loadConfig(c) {
      const f = this.iface;
      if (Array.isArray(c.ifaces) && c.ifaces[0]) this.loadIface(f, c.ifaces[0]);
      this.gateway = c.gateway ? U.parseIp(c.gateway) : null;
      this.dns = c.dns ? U.parseIp(c.dns) : null;
      this.dhcpc = null;
      if (f.dhcp) {
        if (c.dhcpBound && f.ip != null) {
          this.dhcpc = { ifc: f, phase: 'bound', xid: 0, timer: null, server: c.dhcpServer ? U.parseIp(c.dhcpServer) : null, router: this.gateway, dns: this.dns };
          this.dhcpStatus = 'Адрес получен от DHCP-сервера' + (this.dhcpc.server ? ' ' + U.ipStr(this.dhcpc.server) : '');
        } else {
          f.ip = null;
          f.mask = null;
          this.gateway = null;
          this.dns = null;
        }
      }
      this.inbox = (c.inbox || []).map((m) => ({ key: '', from: String(m.from || ''), fromIp: U.parseIp(m.fromIp) || 0, subject: String(m.subject || ''), body: String(m.body || ''), time: m.time || 0, read: !!m.read, bcast: !!m.bcast }));
      this.outbox = (c.outbox || []).map((m) => ({
        id: m.id, subject: String(m.subject || ''), body: String(m.body || ''), time: m.time || 0,
        items: (m.items || []).map((it) => ({ target: it.target, ip: it.ip ? U.parseIp(it.ip) : null, status: it.status === 'ok' ? 'ok' : 'fail', text: String(it.text || ''), attempts: 0, timer: null, acks: null })),
      }));
      const fw = c.firewall || {};
      this.firewall = { enabled: !!fw.enabled, rules: [] };
      for (const r of fw.rules || []) {
        this.firewall.rules.push({ action: r.action === 'deny' ? 'deny' : 'allow', proto: r.proto || 'ip', remote: U.parseIp(r.remote) || 0, wc: U.parseIp(r.wc) == null ? 0xFFFFFFFF : U.parseIp(r.wc), port: r.port == null ? null : Number(r.port) });
      }
      this.files = (c.files || []).map((x) => ({ name: String(x.name), text: String(x.text || '') }));
      this.email = Object.assign({ name: '', address: '', incoming: '', outgoing: '', user: '', password: '' }, c.email || {});
      this.emailBox = (c.emailBox || []).map((m) => Object.assign({}, m));
      this.wifi = Object.assign({ ssid: '', security: 'open', key: '' }, c.wifi || {});
      if (this.dhcpd) this.dhcpd.load(c.dhcpd);
      if (this.dnsd) this.dnsd.load(c.dnsd);
      if (this.httpd) this.httpd.load(c.httpd);
      if (this.maild) this.maild.load(c.maild);
      if (this.tftpd) this.tftpd.load(c.tftpd);
      this.bindServices();
    }
  }

  function hostClass(type, prefix, title) {
    class H extends Host {
      constructor(net, id, name, model) { super(net, id, name, model, type); }
    }
    H.namePrefix = prefix;
    H.title = title;
    NS.deviceTypes[type] = H;
    return H;
  }

  NS.Host = Host;
  NS.hostClass = hostClass;
  hostClass('pc', 'PC', 'Компьютер');
  hostClass('laptop', 'Laptop', 'Ноутбук');
  hostClass('server', 'Server', 'Сервер');
  hostClass('printer', 'Printer', 'Принтер');
  hostClass('tablet', 'Tablet', 'Планшет');
})(globalThis.NetLab = globalThis.NetLab || {});
