/* NetLab — управление устройствами, как в IOS и Packet Tracer:
 *  • журнал IOS: сообщения %LINK-3-UPDOWN, %LINEPROTO-5-UPDOWN, %SYS-5-CONFIG_I, %OSPF-5-ADJCHG…
 *    в консоль, в буфер (show logging) и на Syslog-сервер (logging host, logging trap, service timestamps);
 *  • debug: ip packet, ip icmp, arp, ip rip, ip ospf adj, ip dhcp server, crypto isakmp, crypto ipsec; show debugging, undebug all;
 *  • NTP: ntp server / master / authenticate / authentication-key / trusted-key, show ntp status/associations;
 *  • службы Server-PT: SYSLOG (UDP 514), NTP (UDP 123), FTP (TCP 21, пользователи и права);
 *  • FTP-клиент: команда ftp на компьютере, copy running-config ftp: на маршрутизаторе и коммутаторе. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const SYSLOG_PORT = 514;
  const NTP_PORT = 123;
  const FTP_PORT = 21;
  const EPOCH = Date.UTC(1993, 2, 1);
  const SEV = ['emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging'];
  const absTime = (dev) => EPOCH + dev.net.time * 10 + (dev.clockOffset || 0);

  function sevOf(tok) {
    if (tok == null) return null;
    if (/^[0-7]$/.test(tok)) return Number(tok);
    const i = SEV.findIndex((x) => x.startsWith(String(tok).toLowerCase()));
    return i >= 0 ? i : null;
  }

  /* ================= журнал IOS ================= */

  function logCfg(dev) {
    if (!dev.logging) dev.logging = { on: true, buffered: 7, console: 7, trap: 6, hosts: [], timestamps: false, debugTimestamps: false };
    return dev.logging;
  }

  /** Строка в консоль устройства (терминал CLI и программа «Терминал» её покажут). */
  function consoleOut(dev, line) {
    if (!dev.consoleLines) dev.consoleLines = [];
    dev.consoleLines.push(line);
    if (dev.consoleLines.length > 300) dev.consoleLines.splice(0, dev.consoleLines.length - 300);
    dev.net.emit('ios-console', { dev, line });
  }

  function stamp(dev, on) { return on ? '*' + dev.clock().replace(/ UTC.*$/, '') + ': ' : ''; }

  /** Сообщение журнала IOS. */
  IpNode.prototype.iosLog = function (fac, sev, mnem, text) {
    if (!this.ios || !this.power) return;
    const c = logCfg(this);
    if (!c.on) return;
    const line = stamp(this, c.timestamps) + '%' + fac + '-' + sev + '-' + mnem + ': ' + text;
    if (!this.logBuf) this.logBuf = [];
    if (c.buffered != null && sev <= c.buffered) {
      this.logBuf.push(line);
      if (this.logBuf.length > 200) this.logBuf.shift();
    }
    if (c.console != null && sev <= c.console) consoleOut(this, line);
    if (sev <= c.trap) {
      for (const h of c.hosts) {
        this.sendIp(P.ipv4(null, h, 'UDP', P.udp(SYSLOG_PORT, SYSLOG_PORT, { syslog: true, sev, fac, mnem, text: line, host: this.ios.hostname }), this.defaultTtl), {
          why: 'Syslog: сообщение уровня ' + sev + ' (' + SEV[sev] + ') на сервер ' + U.ipStr(h),
        });
      }
    }
  };

  /** Отладочный вывод (debug …): только если отладка включена. */
  IpNode.prototype.debugOut = function (key, text) {
    if (!this.debugs || !this.debugs.has(key) || !this.power) return;
    const c = logCfg(this);
    const line = stamp(this, c.debugTimestamps) + text;
    if (!this.logBuf) this.logBuf = [];
    if (c.buffered === 7) { this.logBuf.push(line); if (this.logBuf.length > 200) this.logBuf.shift(); }
    consoleOut(this, line);
  };

  IpNode.hooks.runtime.push(function () {
    this.logBuf = [];
    this.consoleLines = [];
    this.debugs = new Set();
    this.ntpRt = { synced: false, peer: null, stratum: 16, tries: 0, timer: null, text: 'нет синхронизации' };
    if (this.ntp && this.ntp.servers.length) this.timer(30, () => ntpSync(this));
  });

  // интерфейсы: %LINK-3-UPDOWN и %LINEPROTO-5-UPDOWN
  const linkChange = IpNode.prototype.onLinkChange;
  IpNode.prototype.onLinkChange = function (i, up) {
    linkChange.call(this, i, up);
    const p = this.ports[i];
    if (this.ios && this.power && p && p.adminUp && NS.Network.isData(p) && !p.radio && p.media !== 'iot') {
      this.iosLog('LINK', 3, 'UPDOWN', 'Interface ' + p.name + ', changed state to ' + (up ? 'up' : 'down'));
      this.iosLog('LINEPROTO', 5, 'UPDOWN', 'Line protocol on Interface ' + p.name + ', changed state to ' + (up ? 'up' : 'down'));
    }
    if (up && this.ntp && this.ntp.servers.length && this.ntpRt && !this.ntpRt.synced && !this.ntpRt.timer) this.ntpRt.timer = this.timer(20, () => { this.ntpRt.timer = null; ntpSync(this); });
  };

  // shutdown: %LINK-5-CHANGED … administratively down
  const setAdmin = IpNode.prototype.setIfaceAdmin;
  IpNode.prototype.setIfaceAdmin = function (f, up) {
    const was = f.adminUp !== false;
    const phys = (f.kind === 'phys' || f.kind === 'routed') && this.ports[f.port];
    const wasOper = phys && this.net.isPortOperational(this, f.port);
    setAdmin.call(this, f, up);
    if (this.ios && this.power && was && !up) {
      this.iosLog('LINK', 5, 'CHANGED', 'Interface ' + f.name + ', changed state to administratively down');
      if (wasOper || f.kind === 'loop') this.iosLog('LINEPROTO', 5, 'UPDOWN', 'Line protocol on Interface ' + f.name + ', changed state to down');
    }
  };

  /* ================= debug ================= */

  const DEBUGS = [
    { key: 'ip packet', words: ['ip', 'packet'], group: 'IP', on: 'IP packet debugging is on' },
    { key: 'ip icmp', words: ['ip', 'icmp'], group: 'IP', on: 'ICMP packet debugging is on' },
    { key: 'arp', words: ['arp'], group: 'IP', on: 'ARP packet debugging is on' },
    { key: 'ip rip', words: ['ip', 'rip'], group: 'RIP', on: 'RIP protocol debugging is on' },
    { key: 'ip ospf', words: ['ip', 'ospf'], group: 'OSPF', on: 'OSPF adjacency events debugging is on' },
    { key: 'ip dhcp', words: ['ip', 'dhcp'], group: 'DHCP', on: 'DHCP server event debugging is on' },
    { key: 'ntp', words: ['ntp'], group: 'NTP', on: 'NTP events debugging is on' },
    { key: 'crypto isakmp', words: ['crypto', 'isakmp'], group: 'Cryptographic Subsystem', on: 'Crypto ISAKMP debugging is on' },
    { key: 'crypto ipsec', words: ['crypto', 'ipsec'], group: 'Cryptographic Subsystem', on: 'Crypto IPSEC debugging is on' },
  ];
  NS.debugs = DEBUGS;

  const pktLen = (pkt) => Math.max(20, P.sizeOf({ type: 'IPv4', payload: pkt }) - 18);
  const ifShort = (n) => (NS.cliIos && NS.cliIos.ctx ? NS.cliIos.ctx.shortIf(n) : n);

  IpNode.hooks.ipIn.push(function (f, pkt) {
    if (!this.debugs || !this.debugs.size) return false;
    const mine = this.hasIp(pkt.dst) || pkt.dst === U.BROADCAST_IP;
    if (mine) this.debugOut('ip packet', 'IP: s=' + U.ipStr(pkt.src) + ' (' + f.name + '), d=' + U.ipStr(pkt.dst) + ', len ' + pktLen(pkt) + ', rcvd 3');
    if (mine && pkt.proto === 'ICMP' && pkt.payload) {
      const m = pkt.payload;
      const t = { 'echo-request': 'echo', 'echo-reply': 'echo reply', 'time-exceeded': 'time exceeded', unreachable: 'dst (' + U.ipStr(pkt.dst) + ') host unreachable' }[m.type] || m.type;
      this.debugOut('ip icmp', 'ICMP: ' + t + ' rcvd, src ' + U.ipStr(pkt.src) + ', dst ' + U.ipStr(pkt.dst) + ', topology BASE, dscp 0 topoid 0');
    }
    return false;
  });

  IpNode.hooks.fwdOut.push(function (inIf, outIf, pkt) {
    if (this.debugs && this.debugs.has('ip packet')) this.debugOut('ip packet', 'IP: s=' + U.ipStr(pkt.src) + ' (' + inIf.name + '), d=' + U.ipStr(pkt.dst) + ' (' + outIf.name + '), len ' + pktLen(pkt) + ', forward');
  });

  IpNode.hooks.send.push(function (pkt) {
    if (!this.debugs || !this.debugs.size || this.hasIp(pkt.dst)) return false;
    const r = pkt.dst === U.BROADCAST_IP ? null : this.lookup(pkt.dst);
    this.debugOut('ip packet', 'IP: s=' + U.ipStr(pkt.src != null ? pkt.src : r && r.ifc ? r.ifc.ip : 0) + ' (local), d=' + U.ipStr(pkt.dst) + (r ? ' (' + r.ifc.name + ')' : '') + ', len ' + pktLen(pkt) + ', sending');
    if (pkt.proto === 'ICMP' && pkt.payload) {
      const t = { 'echo-request': 'echo', 'echo-reply': 'echo reply', 'time-exceeded': 'time exceeded', unreachable: 'dst (' + U.ipStr(pkt.dst) + ') host unreachable' }[pkt.payload.type] || pkt.payload.type;
      this.debugOut('ip icmp', 'ICMP: ' + t + ' sent, src ' + U.ipStr(pkt.src != null ? pkt.src : r && r.ifc ? r.ifc.ip : 0) + ', dst ' + U.ipStr(pkt.dst) + ', topology BASE, dscp 0 topoid 0');
    }
    return false;
  });

  const sendArp = IpNode.prototype.sendArp;
  IpNode.prototype.sendArp = function (f, op, senderIp, targetIp, dstMac, targetMac, why) {
    if (this.debugs && this.debugs.has('arp')) this.debugOut('arp', 'IP ARP: sent ' + (op === 'request' ? 'req' : 'rep') + ' src ' + U.ipStr(senderIp) + ' ' + U.ciscoMac(this.ifaceMac(f)) + ',\n                 dst ' + U.ipStr(targetIp) + ' ' + U.ciscoMac(targetMac || '00:00:00:00:00:00') + ' ' + f.name);
    return sendArp.call(this, f, op, senderIp, targetIp, dstMac, targetMac, why);
  };
  const onArp = IpNode.prototype.onArp;
  IpNode.prototype.onArp = function (f, a, frame) {
    if (this.debugs && this.debugs.has('arp') && a) this.debugOut('arp', 'IP ARP: rcvd ' + (a.op === 'request' ? 'req' : 'rep') + ' src ' + U.ipStr(a.senderIp) + ' ' + U.ciscoMac(a.senderMac) + ', dst ' + U.ipStr(a.targetIp) + ' ' + f.name);
    return onArp.call(this, f, a, frame);
  };

  if (NS.DhcpService) {
    const reply = NS.DhcpService.prototype.reply;
    NS.DhcpService.prototype.reply = function (pkt, f, d, pool, op, ip, serverId) {
      const n = this.node;
      if (n.debugs && n.debugs.has('ip dhcp')) {
        const mac = U.ciscoMac(d.chaddr);
        if (op === 'OFFER') n.debugOut('ip dhcp', 'DHCPD: Sending DHCPOFFER to client 01' + mac.replace(/\./g, '') + ' (' + U.ipStr(ip) + ').');
        else if (op === 'ACK') n.debugOut('ip dhcp', 'DHCPD: assigned IP address ' + U.ipStr(ip) + ' to client 01' + mac.replace(/\./g, '') + '.');
        else n.debugOut('ip dhcp', 'DHCPD: Sending DHCPNAK to client 01' + mac.replace(/\./g, '') + '.');
      }
      return reply.call(this, pkt, f, d, pool, op, ip, serverId);
    };
  }

  // соседи OSPF и обновления RIP — после пересчёта маршрутов
  if (NS.routing) {
    const compute = NS.routing.compute;
    NS.routing.compute = function (net) {
      const before = new Map();
      for (const d of net.devices.values()) {
        if (!d.ifaces) continue;
        before.set(d, { ospf: new Map((d.ospfNeighbors || []).map((n) => [n.id + '|' + n.ifname, n])), rip: JSON.stringify((d.dynRoutes || []).filter((r) => r.type === 'R').map((r) => [r.net, r.mask, r.metric, r.nextHop])) });
      }
      compute.call(this, net);
      if (NS.routing.afterCompute) for (const fn of NS.routing.afterCompute) fn(net, before);
      for (const d of net.devices.values()) {
        if (!d.ifaces || !d.ios || !d.power) continue;
        const b = before.get(d) || { ospf: new Map(), rip: '[]' };
        const now = new Map((d.ospfNeighbors || []).map((n) => [n.id + '|' + n.ifname, n]));
        const pid = d.ospf ? d.ospf.pid : 1;
        for (const [k, n] of now) {
          if (b.ospf.has(k)) continue;
          if (d.debugs && d.debugs.has('ip ospf')) {
            d.debugOut('ip ospf', 'OSPF: 2 Way Communication to ' + U.ipStr(n.id) + ' on ' + n.ifname + ', state 2WAY');
            d.debugOut('ip ospf', 'OSPF: Rcv DBD from ' + U.ipStr(n.id) + ' on ' + n.ifname + ' seq 0x' + (0x1000 + (n.id & 0xfff)).toString(16) + ' opt 0x00 flag 0x7 len 32  mtu 1500 state EXSTART');
            d.debugOut('ip ospf', 'OSPF: Exchange Done with ' + U.ipStr(n.id) + ' on ' + n.ifname);
            d.debugOut('ip ospf', 'OSPF: Synchronized with ' + U.ipStr(n.id) + ' on ' + n.ifname + ', state FULL');
          }
          d.iosLog('OSPF', 5, 'ADJCHG', 'Process ' + pid + ', Nbr ' + U.ipStr(n.id) + ' on ' + n.ifname + ' from LOADING to FULL, Loading Done');
        }
        for (const [k, n] of b.ospf) if (!now.has(k)) d.iosLog('OSPF', 5, 'ADJCHG', 'Process ' + pid + ', Nbr ' + U.ipStr(n.id) + ' on ' + n.ifname + ' from FULL to DOWN, Neighbor Down: Dead timer expired');
        if (d.debugs && d.debugs.has('ip rip') && d.rip) {
          const rip = (d.dynRoutes || []).filter((r) => r.type === 'R');
          if (JSON.stringify(rip.map((r) => [r.net, r.mask, r.metric, r.nextHop])) !== b.rip) {
            for (const f of d.ifaces) if (NS.routing.ripEnabled(d, f)) d.debugOut('ip rip', 'RIP: sending v' + (d.rip.version || 1) + ' update to ' + (d.rip.version === 2 ? '224.0.0.9' : '255.255.255.255') + ' via ' + f.name + ' (' + U.ipStr(f.ip) + ')');
            const byNh = new Map();
            for (const r of rip) { if (!byNh.has(r.nextHop)) byNh.set(r.nextHop, []); byNh.get(r.nextHop).push(r); }
            for (const [nh, list] of byNh) {
              d.debugOut('ip rip', 'RIP: received v' + (d.rip.version || 1) + ' update from ' + U.ipStr(nh) + ' on ' + list[0].ifc.name);
              for (const r of list) d.debugOut('ip rip', '      ' + U.cidr(r.net, r.mask) + ' via 0.0.0.0 in ' + r.metric + ' hops');
            }
          }
        }
      }
    };
  }

  /* ================= NTP-клиент на IOS ================= */

  function ntpCfg(dev) {
    if (!dev.ntp) dev.ntp = { servers: [], master: null, authenticate: false, keys: {}, trusted: [] };
    return dev.ntp;
  }

  function ntpSync(dev) {
    const c = dev.ntp;
    const rt = dev.ntpRt;
    if (!c || !c.servers.length || !rt || !dev.power) return;
    if (rt.pending) return;
    const port = dev.allocPort();
    let tries = 0;
    const order = c.servers.slice().sort((a, b) => (b.prefer ? 1 : 0) - (a.prefer ? 1 : 0));
    const finish = (ok, peer, stratum, text) => {
      if (rt.timerP) rt.timerP.cancel();
      dev.udp.delete(port);
      rt.pending = false;
      const was = rt.synced;
      rt.synced = ok;
      rt.peer = ok ? peer : null;
      rt.stratum = ok ? stratum + 1 : 16;
      rt.text = text;
      if (ok && !was) dev.iosLog('NTP', 5, 'PEERSYNC', 'NTP synced to peer ' + U.ipStr(peer));
      dev.net.emit('config', { dev });
    };
    rt.pending = true;
    dev.udp.set(port, (pkt) => {
      const d = pkt.payload.data || {};
      if (d.ntp !== 'reply') return;
      const s = c.servers.find((x) => x.ip === pkt.src);
      if (!s) return;
      if (c.authenticate) {
        const key = s.key != null ? c.keys[s.key] : null;
        if (key == null || !c.trusted.includes(s.key) || d.mac !== key || d.keyId !== s.key) {
          dev.debugOut('ntp', 'NTP: packet from ' + U.ipStr(pkt.src) + ' failed authentication');
          finish(false, null, 16, 'ответ ' + U.ipStr(pkt.src) + ' не прошёл проверку подлинности (ntp authentication-key / trusted-key)');
          return;
        }
      }
      dev.clockOffset = d.time - (EPOCH + dev.net.time * 10);
      dev.debugOut('ntp', 'NTP: synced to new peer ' + U.ipStr(pkt.src) + ', stratum ' + d.stratum);
      finish(true, pkt.src, d.stratum, 'синхронизировано с ' + U.ipStr(pkt.src));
    });
    const attempt = () => {
      if (++tries > 3) { finish(false, null, 16, 'NTP-сервер не отвечает'); return; }
      for (const s of order) {
        const data = { ntp: 'request', mode: 'client' };
        if (c.authenticate && s.key != null) { data.keyId = s.key; data.mac = c.keys[s.key]; }
        dev.sendIp(P.ipv4(null, s.ip, 'UDP', P.udp(port, NTP_PORT, data), dev.defaultTtl), { why: 'NTP: запрос времени у ' + U.ipStr(s.ip) });
      }
      rt.timerP = dev.timer(200, attempt);
    };
    attempt();
  }

  /** Ответить на NTP-запрос (Server-PT или маршрутизатор с ntp master / синхронизированный). */
  function ntpServe(dev, pkt, auth) {
    const d = pkt.payload.data || {};
    if (d.ntp !== 'request') return;
    const reply = { ntp: 'reply', mode: 'server', time: absTime(dev), stratum: auth.stratum };
    if (auth.enabled) {
      if (d.keyId !== auth.keyId || d.mac !== auth.key) return; // неверный ключ — не отвечаем
      reply.keyId = auth.keyId;
      reply.mac = auth.key;
    }
    dev.sendIp(P.ipv4(pkt.dst, pkt.src, 'UDP', P.udp(NTP_PORT, pkt.payload.sport, reply), dev.defaultTtl), { why: 'NTP: сообщаю время (stratum ' + auth.stratum + ')' });
  }

  IpNode.hooks.bind.push(function () {
    if (!this.ios || this.type === 'wrouter' || this.type === 'homegw') return;
    this.udp.set(NTP_PORT, (pkt, f, frame) => {
      const c = this.ntp;
      const rt = this.ntpRt;
      if (!c || !(c.master != null || (rt && rt.synced))) { this.portClosed(pkt, f, frame); return; }
      const d = pkt.payload.data || {};
      const key = d.keyId != null ? c.keys[d.keyId] : null;
      ntpServe(this, pkt, { stratum: c.master != null ? c.master : rt.stratum, enabled: d.keyId != null && key != null, keyId: d.keyId, key });
    });
  });

  /* ================= службы сервера: SYSLOG, NTP, FTP ================= */

  class SyslogService {
    constructor(node) { this.node = node; this.enabled = true; this.msgs = []; }
    bind() {
      this.node.udp.set(SYSLOG_PORT, (pkt, f, frame) => {
        if (!this.enabled) { this.node.portClosed(pkt, f, frame); return; }
        const d = pkt.payload.data || {};
        if (!d.syslog) return;
        this.msgs.push({ time: this.node.clock(), host: U.ipStr(pkt.src), text: String(d.text || '') });
        if (this.msgs.length > 300) this.msgs.splice(0, this.msgs.length - 300);
        this.node.net.emit('config', { dev: this.node });
      });
    }
    serialize() { return { enabled: this.enabled, msgs: this.msgs.slice(-200) }; }
    load(c) { if (!c) return; this.enabled = c.enabled !== false; this.msgs = Array.isArray(c.msgs) ? c.msgs.map((m) => ({ time: String(m.time || ''), host: String(m.host || ''), text: String(m.text || '') })) : []; }
  }

  class NtpService {
    constructor(node) { this.node = node; this.enabled = true; this.auth = false; this.keyId = 1; this.key = ''; }
    bind() {
      this.node.udp.set(NTP_PORT, (pkt, f, frame) => {
        if (!this.enabled) { this.node.portClosed(pkt, f, frame); return; }
        ntpServe(this.node, pkt, { stratum: 1, enabled: this.auth, keyId: this.keyId, key: this.key });
      });
    }
    serialize() { return { enabled: this.enabled, auth: this.auth, keyId: this.keyId, key: this.key }; }
    load(c) { if (!c) return; this.enabled = c.enabled !== false; this.auth = !!c.auth; this.keyId = Number(c.keyId) || 1; this.key = String(c.key || ''); }
  }

  const IOS_IMAGES = ['c1841-advipservicesk9-mz.124-15.T1.bin', 'c2900-universalk9-mz.SPA.151-4.M4.bin', 'c2960-lanbasek9-mz.150-2.SE4.bin', 'c3560-advipservicesk9-mz.122-37.SE1.bin'];

  class FtpService {
    constructor(node) {
      this.node = node;
      this.enabled = true;
      this.users = [{ user: 'cisco', pass: 'cisco', perms: 'rwdnl' }];
      this.files = new Map(IOS_IMAGES.map((n) => [n, 'IOS image (NetLab)']));
    }

    bind() {
      if (!this.node.tcp) return;
      if (!this.enabled) { this.node.tcp.unlisten(FTP_PORT); return; }
      this.node.tcp.listen(FTP_PORT, (conn) => {
        const st = { user: null };
        conn.send({ ftp: 220, text: 'Welcome to PT Ftp server' });
        conn.h.onData = (d) => this.onCmd(conn, st, d || {});
      });
    }

    addUser(user, pass, perms) {
      const u = String(user || '').trim();
      if (!/^[\w.@-]{1,32}$/.test(u)) throw new Error('Имя пользователя: латиница, цифры, «.», «-», «_», «@»');
      if (!String(pass || '')) throw new Error('Укажите пароль');
      const p = [...new Set(String(perms || 'rl').replace(/[^rwdnl]/g, ''))].join('') || 'rl';
      this.users = this.users.filter((x) => x.user !== u).concat([{ user: u, pass: String(pass), perms: p }]);
    }

    onCmd(conn, st, d) {
      const say = (code, text, extra) => conn.send(Object.assign({ ftp: code, text }, extra || {}));
      const can = (p) => st.user && st.user.perms.includes(p);
      switch (d.cmd) {
        case 'USER': {
          const u = this.users.find((x) => x.user === String(d.user) && x.pass === String(d.pass));
          if (!u) { say(530, 'Login incorrect.'); return; }
          st.user = u;
          say(230, 'Logged in');
          return;
        }
        case 'LIST':
          if (!st.user) { say(530, 'Not logged in.'); return; }
          if (!can('l')) { say(550, 'Permission denied (list).'); return; }
          say(226, 'Directory send OK.', { files: [...this.files.entries()].map(([n, v]) => ({ name: n, size: /\.bin$/.test(n) ? 4000000 + n.length * 12345 : v.length })) });
          return;
        case 'RETR':
          if (!st.user) { say(530, 'Not logged in.'); return; }
          if (!can('r')) { say(550, 'Permission denied (read).'); return; }
          if (!this.files.has(d.name)) { say(550, d.name + ': File not found.'); return; }
          say(226, 'Transfer complete.', { name: d.name, data: this.files.get(d.name) });
          return;
        case 'STOR':
          if (!st.user) { say(530, 'Not logged in.'); return; }
          if (!can('w')) { say(550, 'Permission denied (write).'); return; }
          if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(d.name || ''))) { say(553, 'Could not create file.'); return; }
          this.files.set(d.name, String(d.data || ''));
          say(226, 'Transfer complete.', { name: d.name });
          this.node.net.emit('config', { dev: this.node });
          return;
        case 'DELE':
          if (!st.user) { say(530, 'Not logged in.'); return; }
          if (!can('d')) { say(550, 'Permission denied (delete).'); return; }
          if (!this.files.delete(d.name)) { say(550, d.name + ': File not found.'); return; }
          say(250, 'Delete operation successful.');
          return;
        case 'RENAME':
          if (!st.user) { say(530, 'Not logged in.'); return; }
          if (!can('n')) { say(550, 'Permission denied (rename).'); return; }
          if (!this.files.has(d.from)) { say(550, d.from + ': File not found.'); return; }
          if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(d.to || ''))) { say(553, 'Bad file name.'); return; }
          this.files.set(d.to, this.files.get(d.from));
          this.files.delete(d.from);
          say(250, 'Rename successful.');
          return;
        case 'QUIT':
          say(221, 'Service closing control connection.');
          conn.close();
          return;
        default:
          say(502, 'Command not implemented.');
      }
    }

    serialize() { return { enabled: this.enabled, users: this.users.map((u) => Object.assign({}, u)), files: [...this.files.entries()] }; }
    load(c) {
      if (!c) return;
      this.enabled = c.enabled !== false;
      this.users = (c.users || []).filter((u) => u && u.user).map((u) => ({ user: String(u.user), pass: String(u.pass || ''), perms: String(u.perms || 'rl') }));
      this.files = new Map((c.files || []).map(([k, v]) => [String(k), String(v)]));
    }
  }

  NS.SyslogService = SyslogService;
  NS.NtpService = NtpService;
  NS.FtpService = FtpService;

  IpNode.hooks.bind.push(function () {
    if (this.type !== 'server') return;
    if (!this.syslogd) this.syslogd = new SyslogService(this);
    if (!this.ntpd) this.ntpd = new NtpService(this);
    if (!this.ftpd) this.ftpd = new FtpService(this);
    this.syslogd.bind();
    this.ntpd.bind();
    this.ftpd.bind();
  });

  /* ================= FTP-клиент ================= */

  /** Открыть FTP-сеанс. cb({ok, session, ip, banner, error}). session.cmd(msg, cb) — по очереди. */
  IpNode.prototype.ftpOpen = function (host, cb) {
    this.resolveName(host, (ip, err) => {
      if (ip == null) { cb({ ok: false, error: err || 'Unknown host' }); return; }
      const waiting = [];
      let banner = null;
      let opened = false;
      const session = {
        ip,
        conn: null,
        closed: false,
        cmd(msg, done) { if (session.closed) { done({ ftp: 421, text: 'Service not available, connection closed' }); return; } waiting.push(done); session.conn.send(msg); },
        close() { if (!session.closed && session.conn && !session.conn.done) session.conn.close(); session.closed = true; },
      };
      const fail = (text) => {
        session.closed = true;
        if (!opened) { opened = true; cb({ ok: false, error: text, ip }); return; }
        while (waiting.length) waiting.shift()({ ftp: 421, text });
      };
      session.conn = this.tcp.connect(ip, FTP_PORT, {
        onData: (d) => {
          if (d && d.ftp === 220 && !opened) { opened = true; banner = d.text; cb({ ok: true, session, ip, banner }); return; }
          const w = waiting.shift();
          if (w) w(d || {});
        },
        onClose: () => fail('Соединение закрыто сервером'),
        onError: (code, text) => fail(code === 'refused' ? 'Connection refused (FTP-служба выключена?)' : text),
      });
    });
  };

  /** Весь обмен за один раз: вход, команда, выход. cb({ok, reply, error}). */
  IpNode.prototype.ftpDo = function (host, user, pass, msg, cb) {
    this.ftpOpen(host, (r) => {
      if (!r.ok) { cb({ ok: false, error: r.error }); return; }
      const s = r.session;
      s.cmd({ cmd: 'USER', user, pass }, (a) => {
        if (a.ftp !== 230) { s.close(); cb({ ok: false, error: a.text || 'Login incorrect.' }); return; }
        s.cmd(msg, (b) => {
          s.cmd({ cmd: 'QUIT' }, () => {});
          cb(b.ftp >= 200 && b.ftp < 300 ? { ok: true, reply: b } : { ok: false, error: b.text, reply: b });
        });
      });
    });
  };

  /* ================= сохранение ================= */

  const ipS = (v) => (v == null ? null : U.ipStr(v));
  NS.deviceExt.push({
    key: 'logging',
    applies: (d) => !!d.ios && d.type !== 'wrouter' && d.type !== 'homegw',
    save(d) {
      const c = d.logging;
      const ntp = d.ntp;
      const out = {};
      const isDefault = c && c.on && c.buffered === 7 && c.console === 7 && c.trap === 6 && !c.hosts.length && !c.timestamps && !c.debugTimestamps;
      if (c && !isDefault) out.log = { on: c.on, buffered: c.buffered, console: c.console, trap: c.trap, hosts: c.hosts.map(U.ipStr), timestamps: c.timestamps, debugTimestamps: c.debugTimestamps };
      if (ntp && (ntp.servers.length || ntp.master != null || ntp.authenticate || Object.keys(ntp.keys).length)) {
        out.ntp = { servers: ntp.servers.map((s) => ({ ip: U.ipStr(s.ip), key: s.key, prefer: !!s.prefer })), master: ntp.master, authenticate: ntp.authenticate, keys: Object.assign({}, ntp.keys), trusted: ntp.trusted.slice() };
      }
      if (d.ftpUser != null || d.ftpPass != null) out.ftp = { user: d.ftpUser, pass: d.ftpPass };
      return Object.keys(out).length ? out : null;
    },
    load(d, c) {
      d.logging = null;
      d.ntp = null;
      d.ftpUser = null;
      d.ftpPass = null;
      if (!c) return;
      if (c.log) {
        const l = c.log;
        d.logging = { on: l.on !== false, buffered: l.buffered == null ? null : Number(l.buffered), console: l.console == null ? null : Number(l.console), trap: Number.isInteger(l.trap) ? l.trap : 6, hosts: (l.hosts || []).map(U.parseIp).filter((x) => x != null), timestamps: !!l.timestamps, debugTimestamps: !!l.debugTimestamps };
      }
      if (c.ntp) {
        const n = c.ntp;
        d.ntp = { servers: (n.servers || []).map((s) => ({ ip: U.parseIp(s.ip), key: s.key == null ? null : Number(s.key), prefer: !!s.prefer })).filter((s) => s.ip != null), master: n.master == null ? null : Number(n.master), authenticate: !!n.authenticate, keys: n.keys || {}, trusted: (n.trusted || []).map(Number) };
        if (d.ntp.servers.length && d.ntpRt && d.tcp) d.timer(30, () => ntpSync(d));
      }
      if (c.ftp) { d.ftpUser = c.ftp.user == null ? null : String(c.ftp.user); d.ftpPass = c.ftp.pass == null ? null : String(c.ftp.pass); }
    },
  });

  NS.deviceExt.push({
    key: 'mgmtd',
    applies: (d) => d.type === 'server',
    save: (d) => ({ syslog: d.syslogd ? d.syslogd.serialize() : null, ntp: d.ntpd ? d.ntpd.serialize() : null, ftp: d.ftpd ? d.ftpd.serialize() : null }),
    load(d, c) {
      if (!c) return;
      if (c.syslog && d.syslogd) d.syslogd.load(c.syslog);
      if (c.ntp && d.ntpd) d.ntpd.load(c.ntp);
      if (c.ftp && d.ftpd) { d.ftpd.load(c.ftp); d.ftpd.bind(); }
    },
  });

  /* ================= описание пакетов ================= */

  P.register({
    protocols: { SYSLOG: { label: 'Syslog', color: '#a855f7' }, NTP: { label: 'NTP', color: '#0891b2' }, FTP: { label: 'FTP', color: '#b45309' } },
    classify(f) {
      if (f.type !== 'IPv4' || !f.payload) return null;
      const p = f.payload;
      const l4 = p.payload || {};
      if (p.proto === 'UDP' && l4.data && l4.data.syslog) return 'SYSLOG';
      if (p.proto === 'UDP' && l4.data && l4.data.ntp) return 'NTP';
      if (p.proto === 'TCP' && (l4.sport === FTP_PORT || l4.dport === FTP_PORT) && l4.data != null) return 'FTP';
      return null;
    },
    summary(f) {
      if (f.type !== 'IPv4' || !f.payload) return null;
      const p = f.payload;
      const l4 = p.payload || {};
      const route = U.ipStr(p.src) + ' → ' + U.ipStr(p.dst);
      const d = l4.data;
      if (p.proto === 'UDP' && d && d.syslog) return 'Syslog: ' + d.text + ', ' + route;
      if (p.proto === 'UDP' && d && d.ntp) return 'NTP ' + (d.ntp === 'request' ? 'запрос времени' : 'ответ: ' + U.clockString(Math.round((d.time - EPOCH) / 10), 0) + ', stratum ' + d.stratum) + (d.keyId != null ? ' (ключ ' + d.keyId + ')' : '') + ', ' + route;
      if (p.proto === 'TCP' && (l4.sport === FTP_PORT || l4.dport === FTP_PORT) && d != null) {
        const t = d.cmd ? d.cmd + (d.name ? ' ' + d.name : d.user ? ' ' + d.user : '') : d.ftp + ' ' + (d.text || '');
        return 'FTP: ' + t + ', ' + route;
      }
      return null;
    },
    extraLayers(f, out) {
      if (f.type !== 'IPv4' || !f.payload) return;
      const p = f.payload;
      const d = p.payload && p.payload.data;
      if (!d) return;
      if (d.syslog) out.push({ title: 'Syslog (уровень 7)', fields: [['Уровень', d.sev + ' — ' + SEV[d.sev]], ['Источник', d.host], ['Сообщение', d.text]] });
      else if (d.ntp) out.push({ title: 'NTP (уровень 7)', fields: [['Режим', d.mode]].concat(d.time ? [['Время', U.clockString(Math.round((d.time - EPOCH) / 10), 0)], ['Stratum', String(d.stratum)]] : [], d.keyId != null ? [['Ключ', String(d.keyId) + ' (MD5)']] : []) });
      else if (p.proto === 'TCP' && (p.payload.sport === FTP_PORT || p.payload.dport === FTP_PORT)) out.push({ title: 'FTP (уровень 7)', fields: d.cmd ? [['Команда', d.cmd]].concat(d.user ? [['Пользователь', d.user], ['Пароль', '•••• (в FTP передаётся открытым текстом!)']] : [], d.name ? [['Файл', d.name]] : []) : [['Ответ', d.ftp + ' ' + (d.text || '')]] });
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;

  X.onConfigured = (dev, s) => {
    if (s.replay) return; // повтор сохранённой конфигурации, а не ввод пользователя
    dev.iosLog('SYS', 5, 'CONFIG_I', 'Configured from ' + (s.via === 'vty' ? 'vty0 (' + (s.remoteIp != null ? U.ipStr(s.remoteIp) : '') + ')' : 'console by console'));
  };

  X.global.push((t) => /^(logging|ntp)$/i.test(t[0] || '') || (/^ip$/i.test(t[0] || '') && /^ftp$/i.test(t[1] || '')));

  X.config.push((dev, s, a, neg, io, C) => {
    if (!dev.ios || dev.type === 'wrouter' || dev.type === 'homegw') return false;
    if (C.kw(a[0], 'service', 3) && C.kw(a[1], 'timestamps', 2)) {
      const c = logCfg(dev);
      const dbg = C.kw(a[2], 'debug', 1);
      C.withMutate(io, () => { if (dbg) c.debugTimestamps = !neg; else c.timestamps = !neg; });
      return true;
    }
    if (C.kw(a[0], 'logging', 3)) {
      const c = logCfg(dev);
      const w = a[1];
      const ipv = U.parseIp(w || '');
      if (ipv != null || C.kw(w, 'host', 1)) {
        const h = ipv != null ? ipv : U.parseIp(a[2] || '');
        if (h == null) { C.incomplete(io); return true; }
        C.withMutate(io, () => { c.hosts = c.hosts.filter((x) => x !== h); if (!neg) c.hosts.push(h); });
        return true;
      }
      if (C.kw(w, 'trap', 1)) {
        const lv = neg ? 6 : a[2] == null ? 6 : sevOf(a[2]);
        if (lv == null) { C.invalid(io, a[2]); return true; }
        C.withMutate(io, () => { c.trap = lv; });
        return true;
      }
      if (C.kw(w, 'buffered', 1) || C.kw(w, 'console', 1) || C.kw(w, 'monitor', 1)) {
        const key = C.kw(w, 'buffered', 1) ? 'buffered' : C.kw(w, 'console', 1) ? 'console' : null;
        const lvTok = a.slice(2).find((x) => sevOf(x) != null && !/^\d{3,}$/.test(x));
        if (key) C.withMutate(io, () => { c[key] = neg ? null : lvTok != null ? sevOf(lvTok) : 7; });
        return true;
      }
      if (C.kw(w, 'on', 2)) { C.withMutate(io, () => { c.on = !neg; }); return true; }
      if (C.kw(w, 'source-interface', 2) || C.kw(w, 'origin-id', 2) || C.kw(w, 'synchronous', 2)) return true;
      C.invalid(io, w);
      return true;
    }
    if (C.kw(a[0], 'ntp', 3)) {
      const c = ntpCfg(dev);
      const w = a[1];
      if (C.kw(w, 'server', 1)) {
        const ipv = U.parseIp(a[2] || '');
        if (ipv == null) { C.incomplete(io); return true; }
        const ki = a.findIndex((x) => C.kw(x, 'key', 1));
        const key = ki > 0 ? Number(a[ki + 1]) : null;
        C.withMutate(io, () => { c.servers = c.servers.filter((x) => x.ip !== ipv); if (!neg) c.servers.push({ ip: ipv, key: Number.isInteger(key) ? key : null, prefer: a.some((x) => C.kw(x, 'prefer', 1)) }); });
        if (!neg) { dev.ntpRt.synced = false; ntpSync(dev); }
        else if (dev.ntpRt.peer === ipv) Object.assign(dev.ntpRt, { synced: false, peer: null, stratum: 16 });
        return true;
      }
      if (C.kw(w, 'master', 1)) {
        const st = a[2] == null ? 8 : Number(a[2]);
        if (!neg && !(st >= 1 && st <= 15)) { C.invalid(io, a[2]); return true; }
        C.withMutate(io, () => { c.master = neg ? null : st; });
        return true;
      }
      if (C.kw(w, 'authenticate', 5)) { C.withMutate(io, () => { c.authenticate = !neg; }); if (c.servers.length) { dev.ntpRt.synced = false; ntpSync(dev); } return true; }
      if (C.kw(w, 'authentication-key', 5)) {
        const n = Number(a[2]);
        if (!Number.isInteger(n)) { C.incomplete(io); return true; }
        if (neg) { C.withMutate(io, () => { delete c.keys[n]; }); return true; }
        if (!C.kw(a[3], 'md5', 1) || !a[4]) { C.incomplete(io); return true; }
        C.withMutate(io, () => { c.keys[n] = a[4]; });
        return true;
      }
      if (C.kw(w, 'trusted-key', 2)) {
        const n = Number(a[2]);
        if (!Number.isInteger(n)) { C.incomplete(io); return true; }
        C.withMutate(io, () => { c.trusted = c.trusted.filter((x) => x !== n); if (!neg) c.trusted.push(n); });
        return true;
      }
      if (C.kw(w, 'update-calendar', 2) || C.kw(w, 'source', 2) || C.kw(w, 'peer', 2)) return true;
      C.invalid(io, w);
      return true;
    }
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'ftp', 2)) {
      if (C.kw(a[2], 'username', 1)) { C.withMutate(io, () => { dev.ftpUser = neg ? null : a[3] || null; }); return true; }
      if (C.kw(a[2], 'password', 1)) { C.withMutate(io, () => { dev.ftpPass = neg ? null : a.slice(a[3] === '0' ? 4 : 3).join(' ') || null; }); return true; }
      if (C.kw(a[2], 'source-interface', 2) || C.kw(a[2], 'passive', 2)) return true;
      C.invalid(io, a[2]);
      return true;
    }
    return false;
  });

  X.running.global.push((dev) => {
    const L = [];
    const c = dev.logging;
    if (c) {
      if (!c.on) L.push('no logging on');
      if (c.buffered == null) L.push('no logging buffered');
      else if (c.buffered !== 7) L.push('logging buffered 4096 ' + SEV[c.buffered]);
      if (c.console == null) L.push('no logging console');
      else if (c.console !== 7) L.push('logging console ' + SEV[c.console]);
      if (c.trap !== 6) L.push('logging trap ' + SEV[c.trap]);
      for (const h of c.hosts) L.push('logging host ' + U.ipStr(h));
      if (L.length) L.push('!');
    }
    const n = dev.ntp;
    if (n) {
      const M = [];
      for (const [k, v] of Object.entries(n.keys)) M.push('ntp authentication-key ' + k + ' md5 ' + v);
      if (n.authenticate) M.push('ntp authenticate');
      for (const k of n.trusted) M.push('ntp trusted-key ' + k);
      if (n.master != null) M.push('ntp master ' + n.master);
      for (const s of n.servers) M.push('ntp server ' + U.ipStr(s.ip) + (s.key != null ? ' key ' + s.key : '') + (s.prefer ? ' prefer' : ''));
      if (M.length) L.push(...M, '!');
    }
    if (dev.ftpUser != null) L.push('ip ftp username ' + dev.ftpUser);
    if (dev.ftpPass != null) L.push('ip ftp password ' + dev.ftpPass);
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (C.kw(a[0], 'logging', 3)) {
      const c = logCfg(dev);
      const lv = (v) => (v == null ? 'disabled' : 'level ' + SEV[v]);
      io.out('Syslog logging: ' + (c.on ? 'enabled' : 'disabled') + ' (0 messages dropped, 0 messages rate-limited, 0 flushes, 0 overruns, xml disabled, filtering disabled)');
      io.out('');
      io.out('    Console logging: ' + lv(c.console) + ', xml disabled, filtering disabled');
      io.out('    Monitor logging: level debugging, xml disabled, filtering disabled');
      io.out('    Buffer logging:  ' + lv(c.buffered) + ', ' + (dev.logBuf || []).length + ' messages logged, xml disabled, filtering disabled');
      io.out('    Logging Exception size (4096 bytes)');
      io.out('    Count and timestamp logging messages: disabled');
      io.out('');
      io.out('    Trap logging: level ' + SEV[c.trap] + ', ' + c.hosts.length + ' message lines logged');
      for (const h of c.hosts) io.out('        Logging to ' + U.ipStr(h) + '  (udp port 514, audit disabled, link up), 0 message lines logged, xml disabled, filtering disabled');
      io.out('');
      io.out('Log Buffer (4096 bytes):');
      io.out('');
      for (const l of dev.logBuf || []) io.out(l);
      return true;
    }
    if (C.kw(a[0], 'ntp', 3)) {
      const c = ntpCfg(dev);
      const rt = dev.ntpRt || { synced: false, stratum: 16 };
      if (C.kw(a[1], 'associations', 1)) {
        io.out('address         ref clock       st   when     poll    reach  delay          offset            disp');
        for (const sv of c.servers) {
          const on = rt.synced && rt.peer === sv.ip;
          io.out((on ? '*~' : ' ~') + C.pad(U.ipStr(sv.ip), 16) + C.pad(on ? '.LOCL.' : '.INIT.', 16) + C.pad(on ? String(rt.stratum - 1) : '16', 5) + C.pad(on ? '10' : '-', 9) + C.pad('64', 8) + C.pad(on ? '377' : '0', 7) + C.pad(on ? '1.00' : '0.00', 15) + C.pad(on ? '0.00' : '0.00', 18) + (on ? '0.12' : '16000.'));
        }
        io.out(' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured');
        return true;
      }
      if (C.kw(a[1], 'status', 1) || !a[1]) {
        if (c.master != null && !rt.synced) io.out('Clock is synchronized, stratum ' + c.master + ', reference is 127.127.1.1');
        else if (rt.synced) io.out('Clock is synchronized, stratum ' + rt.stratum + ', reference is ' + U.ipStr(rt.peer));
        else io.out('Clock is unsynchronized, stratum 16, no reference clock');
        io.out('nominal freq is 250.0000 Hz, actual freq is 249.9990 Hz, precision is 2**19');
        io.out('reference time is ' + dev.clock());
        io.out('clock offset is 0.00 msec, root delay is 0.00  msec');
        io.out('root dispersion is 0.02 msec, peer dispersion is 0.02 msec.');
        if (!rt.synced && c.servers.length) io.out('% ' + (rt.text || 'нет синхронизации'));
        return true;
      }
      C.invalid(io, a[1]);
      return true;
    }
    if (C.kw(a[0], 'debugging', 3)) {
      const on = DEBUGS.filter((x) => dev.debugs && dev.debugs.has(x.key));
      const groups = [...new Set(on.map((x) => x.group))];
      for (const g of groups) {
        io.out(g + ':');
        for (const x of on.filter((y) => y.group === g)) io.out('  ' + x.on);
      }
      return true;
    }
    return false;
  });

  function matchDebug(C, t) {
    return DEBUGS.find((d) => d.words.length <= t.length && d.words.every((w, i) => C.kw(t[i], w, Math.min(2, w.length))));
  }

  X.exec.push((dev, s, t, io, line, C) => {
    if (!dev.ios) return null;
    const priv = s.mode === 'exec';
    const offAll = (C.kw(t[0], 'undebug', 1) && (C.kw(t[1], 'all', 1) || !t[1])) || (C.kw(t[0], 'no', 2) && C.kw(t[1], 'debug', 2) && C.kw(t[2], 'all', 1));
    if (priv && offAll) {
      dev.debugs = new Set();
      io.out('All possible debugging has been turned off');
      return { handled: true };
    }
    if (priv && (C.kw(t[0], 'debug', 2) || C.kw(t[0], 'undebug', 1) || (C.kw(t[0], 'no', 2) && C.kw(t[1], 'debug', 2)))) {
      const off = !C.kw(t[0], 'debug', 2);
      const rest = C.kw(t[0], 'no', 2) ? t.slice(2) : t.slice(1);
      if (C.kw(rest[0], 'all', 1) && !off) { for (const d of DEBUGS) dev.debugs.add(d.key); io.out('This may severely impact network performance. Continue? (yes/[no]): yes'); io.out('All possible debugging has been turned on'); return { handled: true }; }
      const d = matchDebug(C, rest);
      if (!d) { if (!rest.length) C.incomplete(io); else C.invalid(io, rest[rest.length - 1]); return { handled: true }; }
      if (off) { dev.debugs.delete(d.key); io.out(d.on.replace(/ is on$/, ' is off')); } else { dev.debugs.add(d.key); io.out(d.on); }
      return { handled: true };
    }
    if (priv && C.kw(t[0], 'clear', 3) && C.kw(t[1], 'logging', 3)) {
      s.pending = { prompt: 'Clear logging buffer [confirm]', handle: (x) => { if (!x.trim() || /^y/i.test(x.trim())) dev.logBuf = []; return null; } };
      return { handled: true };
    }
    if (C.kw(t[0], 'terminal', 2) && (C.kw(t[1], 'monitor', 1) || (C.kw(t[1], 'no', 2) && C.kw(t[2], 'monitor', 1)))) return { handled: true };
    // copy … ftp: и copy ftp: …
    if (priv && C.kw(t[0], 'copy', 2)) {
      const toFtp = (C.kw(t[1], 'running-config', 3) || C.kw(t[1], 'startup-config', 3)) && /^ftp:?/i.test(t[2] || '');
      const fromFtp = /^ftp:?/i.test(t[1] || '') && (C.kw(t[2], 'running-config', 3) || C.kw(t[2], 'startup-config', 3));
      if (!toFtp && !fromFtp) return null;
      const lines = toFtp ? (C.kw(t[1], 'running-config', 3) ? NS.cliIos.runningConfig(dev) : dev.nvram ? dev.nvram.text : null) : null;
      if (toFtp && !lines) { io.out('%% Non-volatile configuration memory is not present'); return { handled: true }; }
      ftpDialog(dev, s, io, toFtp ? 'put' : C.kw(t[2], 'running-config', 3) ? 'run' : 'start', lines);
      return { handled: true };
    }
    return null;
  });

  function ftpDialog(dev, s, io, dir, lines) {
    const def = (dev.ios.hostname + '-confg').toLowerCase();
    s.pending = {
      prompt: 'Address or name of remote host []? ',
      handle: (a) => {
        const server = a.trim();
        s.pending = {
          prompt: (dir === 'put' ? 'Destination' : 'Source') + ' filename [' + def + ']? ',
          handle: (fn) => {
            const name = fn.trim() || def;
            let done = false;
            const job = { done: false, cancel() { done = true; job.finish(); io.done(); }, finish() { job.done = true; dev.jobs.delete(job); } };
            dev.jobs.add(job);
            const user = dev.ftpUser;
            const pass = dev.ftpPass;
            const end = () => { if (done) return; done = true; job.finish(); io.done(); };
            if (!user || pass == null) {
              io.out('%Error opening ftp://' + server + '/' + name + ' (Не заданы учётные данные: ip ftp username … и ip ftp password …)');
              end();
              return job;
            }
            if (dir === 'put') {
              const text = lines.join('\n');
              io.out('Writing ' + name + ' ');
              dev.ftpDo(server, user, pass, { cmd: 'STOR', name, data: text }, (r) => {
                if (done) return;
                io.out(r.ok ? '[OK - ' + text.length + ' bytes]' : '%Error opening ftp://' + server + '/' + name + ' (' + r.error + ')');
                if (r.ok) io.out(text.length + ' bytes copied');
                end();
              });
            } else {
              io.out('Accessing ftp://' + server + '/' + name + '...');
              dev.ftpDo(server, user, pass, { cmd: 'RETR', name }, (r) => {
                if (done) return;
                if (!r.ok) { io.out('%Error opening ftp://' + server + '/' + name + ' (' + r.error + ')'); end(); return; }
                const data = String(r.reply.data || '');
                io.out('[OK - ' + data.length + ' bytes]');
                const text = data.split('\n');
                if (dir === 'run') NS.cliIos.replayConfig(dev, text, io);
                else {
                  const tmp = dev.configState();
                  NS.cliIos.replayConfig(dev, text, io, true);
                  io.mutate(() => dev.saveNvram());
                  io.mutate(() => dev.applyConfigState(tmp));
                }
                end();
              });
            }
            return job;
          },
        };
        return null;
      },
    };
  }

  X.tree.config = (X.tree.config || []).concat(['logging host A.B.C.D', 'logging trap WORD', 'logging buffered', 'logging console', 'service timestamps log datetime msec',
    'ntp server A.B.C.D', 'ntp master WORD', 'ntp authenticate', 'ntp authentication-key WORD md5 WORD', 'ntp trusted-key WORD', 'ip ftp username WORD', 'ip ftp password WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show logging', 'show ntp status', 'show ntp associations', 'show debugging', 'debug ip packet', 'debug ip icmp', 'debug arp', 'debug ip rip',
    'debug ip ospf adj', 'debug ip dhcp server events', 'debug ntp events', 'undebug all', 'clear logging', 'copy running-config ftp:', 'copy startup-config ftp:', 'copy ftp: running-config', 'terminal monitor']);

  /* ================= командная строка ПК: ftp ================= */

  if (NS.cliHost) {
    const H = NS.cliHost;
    H.ext.help.push('  ftp <адрес|имя>                                          FTP-клиент (dir, get, put, delete, rename, quit)');
    H.ext.commands.ftp = (dev, s, args, io) => {
      const host = args[0];
      if (!host) { io.out('Использование: ftp <адрес сервера>'); return null; }
      io.out('Trying to connect...' + host);
      let finished = false;
      const job = { done: false, cancel() { if (sess) sess.close(); finish(); }, finish() { job.done = true; dev.jobs.delete(job); } };
      let sess = null;
      const finish = () => { if (finished) return; finished = true; job.finish(); io.done(); };
      dev.jobs.add(job);
      dev.ftpOpen(host, (r) => {
        if (finished) return;
        if (!r.ok) { io.out('%Error opening ftp://' + host + '/ (' + r.error + ')'); finish(); return; }
        sess = r.session;
        io.out('Connected to ' + U.ipStr(r.ip));
        io.out('220- ' + r.banner);
        s.pending = {
          prompt: 'Username:',
          handle: (user) => {
            io.out('331- Username ok, need password');
            s.pending = {
              prompt: 'Password:',
              mask: true,
              handle: (pass) => {
                const j2 = waitJob(dev, io);
                sess.cmd({ cmd: 'USER', user: user.trim(), pass }, (a) => {
                  if (a.ftp !== 230) { io.out(a.ftp + '- ' + (a.text || 'Login incorrect.')); sess.close(); j2.end(); return; }
                  io.out('230- Logged in');
                  io.out('(passive mode On)');
                  ftpPrompt(dev, s, io, sess, U.ipStr(r.ip));
                  j2.end();
                });
                return j2.job;
              },
            };
            return null;
          },
        };
        finish();
      });
      return job;
    };
  }

  function waitJob(dev, io) {
    let ended = false;
    const job = { done: false, cancel() { end(); }, finish() { job.done = true; dev.jobs.delete(job); } };
    const end = () => { if (ended) return; ended = true; job.finish(); io.done(); };
    dev.jobs.add(job);
    return { job, end };
  }

  function ftpPrompt(dev, s, io, sess, host) {
    s.pending = {
      prompt: 'ftp>',
      handle: (line) => {
        const t = line.trim().split(/\s+/).filter(Boolean);
        const cmd = (t[0] || '').toLowerCase();
        const again = () => ftpPrompt(dev, s, io, sess, host);
        if (!cmd) { again(); return null; }
        if (cmd === 'quit' || cmd === 'bye' || cmd === 'exit') {
          const w = waitJob(dev, io);
          sess.cmd({ cmd: 'QUIT' }, (a) => { io.out((a.ftp || 221) + '- ' + (a.text || 'Service closing control connection.')); sess.close(); w.end(); });
          return w.job;
        }
        if (cmd === 'help' || cmd === '?') {
          io.out('cd       delete   dir      get      help     passive  put      pwd      quit     rename');
          again();
          return null;
        }
        const w = waitJob(dev, io);
        const next = () => { if (sess.closed) io.out('Соединение с сервером закрыто.'); else again(); w.end(); };
        if (cmd === 'dir' || cmd === 'ls') {
          sess.cmd({ cmd: 'LIST' }, (a) => {
            if (a.ftp !== 226) io.out('%Error listing /ftp (' + a.text + ')');
            else {
              io.out('Listing /ftp directory from ' + host + ': ');
              (a.files || []).forEach((f, i) => io.out(String(i).padEnd(4) + ': ' + f.name.padEnd(46) + String(f.size).padStart(10)));
            }
            next();
          });
          return w.job;
        }
        if (cmd === 'get') {
          const name = t[1];
          if (!name) { io.out('Использование: get <файл>'); next(); return w.job; }
          io.out('Reading file ' + name + ' from ' + host + ': ');
          sess.cmd({ cmd: 'RETR', name }, (a) => {
            if (a.ftp !== 226) io.out('%Error ftp://' + host + '/' + name + ' (' + a.text + ')');
            else {
              const files = dev.files || (dev.files = []);
              const i = files.findIndex((f) => f.name === name);
              if (i >= 0) files[i].text = String(a.data || ''); else files.push({ name, text: String(a.data || '') });
              io.out('File transfer in progress...');
              io.out('');
              io.out('[Transfer complete - ' + String(a.data || '').length + ' bytes]');
              dev.net.emit('config', { dev });
            }
            next();
          });
          return w.job;
        }
        if (cmd === 'put') {
          const name = t[1];
          const f = name && (dev.files || []).find((x) => x.name === name);
          if (!f) { io.out('%Error opening ' + (name || '') + ' (Нет такого файла — создайте его в Text Editor)'); next(); return w.job; }
          io.out('Writing file ' + name + ' to ' + host + ': ');
          sess.cmd({ cmd: 'STOR', name, data: f.text }, (a) => {
            if (a.ftp !== 226) io.out('%Error ftp://' + host + '/' + name + ' (' + a.text + ')');
            else { io.out('File transfer in progress...'); io.out(''); io.out('[Transfer complete - ' + String(f.text).length + ' bytes]'); }
            next();
          });
          return w.job;
        }
        if (cmd === 'delete') {
          sess.cmd({ cmd: 'DELE', name: t[1] }, (a) => { io.out(a.ftp === 250 ? 'Deleting file ' + t[1] + ' from ' + host + ': ftp>' : '%Error ' + a.text); next(); });
          return w.job;
        }
        if (cmd === 'rename') {
          sess.cmd({ cmd: 'RENAME', from: t[1], to: t[2] }, (a) => { io.out(a.ftp === 250 ? 'Renaming ' + t[1] + ' to ' + t[2] : '%Error ' + a.text); next(); });
          return w.job;
        }
        if (cmd === 'pwd' || cmd === 'cd' || cmd === 'passive') { io.out(cmd === 'pwd' ? 'Remote directory: /ftp' : 'OK'); next(); return w.job; }
        io.out('Invalid or non supported command.');
        next();
        return w.job;
      },
    };
  }

  NS.mgmt = { SEV, logCfg, ntpCfg, ntpSync, consoleOut, absTime };
})(globalThis.NetLab = globalThis.NetLab || {});
