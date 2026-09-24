/* NetLab — команды IOS для EIGRP, BGP, редистрибуции и суммаризации:
 * router eigrp / router bgp, redistribute (в RIP, OSPF, EIGRP, BGP), default-metric, area … range,
 * ip summary-address eigrp, delay; show ip eigrp neighbors|topology|interfaces, show ip bgp [summary|neighbors],
 * сообщения %DUAL-5-NBRCHANGE и %BGP-5-ADJCHANGE. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const R2 = NS.routing2;
  const X = NS.cliIos.ext;
  const ip = U.ipStr;

  function ensureRedist(dev) {
    if (!dev.redist) dev.redist = { rip: [], ospf: [], eigrp: [], bgp: [] };
    if (!dev.redistDefaults) dev.redistDefaults = {};
    return dev.redist;
  }

  const SRC = ['connected', 'static', 'rip', 'ospf', 'eigrp', 'bgp'];

  /** redistribute <src> [id] [metric …] [metric-type 1|2] [subnets] — разбор для протокола proto. */
  function parseRedist(C, a, proto) {
    const src = SRC.find((x) => C.kw(a[1], x, 2));
    if (!src) return { err: 'invalid', tok: a[1] };
    let i = 2;
    let id = null;
    if (['ospf', 'eigrp', 'bgp'].includes(src)) {
      id = Number(a[2]);
      if (!Number.isInteger(id)) return { err: 'incomplete' };
      i = 3;
    }
    const rule = { src, id, metric: null, metricVec: null, metricType: 2, subnets: false };
    for (; i < a.length; i++) {
      if (C.kw(a[i], 'metric-type', 7)) { rule.metricType = Number(a[++i]) === 1 ? 1 : 2; continue; }
      if (C.kw(a[i], 'metric', 1)) {
        if (proto === 'eigrp') {
          const v = a.slice(i + 1, i + 6).map(Number);
          if (v.length < 5 || v.some((x) => !Number.isFinite(x))) return { err: 'incomplete' };
          rule.metricVec = { bw: v[0], delay: v[1], rel: v[2], load: v[3], mtu: v[4] };
          i += 5;
        } else rule.metric = Number(a[++i]);
        continue;
      }
      if (C.kw(a[i], 'subnets', 1)) { rule.subnets = true; continue; }
    }
    return { rule };
  }

  function redistCmd(dev, proto, a, neg, io, C) {
    const r = parseRedist(C, a, proto);
    if (r.err === 'invalid') { C.invalid(io, r.tok); return; }
    if (r.err) { C.incomplete(io); return; }
    const list = ensureRedist(dev)[proto];
    const same = (x) => x.src === r.rule.src && (x.id || null) === (r.rule.id || null);
    C.withMutate(io, () => {
      const i = list.findIndex(same);
      if (neg) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = r.rule; else list.push(r.rule);
      dev.net.markRouting();
    });
    if (!neg && proto === 'ospf' && !r.rule.subnets && ['connected', 'static', 'eigrp', 'rip', 'bgp'].includes(r.rule.src)) io.out('% Only classful networks will be redistributed');
  }

  function redistLines(dev, proto) {
    const L = [];
    for (const x of (dev.redist && dev.redist[proto]) || []) {
      let s = ' redistribute ' + x.src + (x.id != null ? ' ' + x.id : '');
      if (x.metricVec) s += ' metric ' + [x.metricVec.bw, x.metricVec.delay, x.metricVec.rel, x.metricVec.load, x.metricVec.mtu].join(' ');
      else if (x.metric != null) s += ' metric ' + x.metric;
      if (proto === 'ospf' && x.metricType === 1) s += ' metric-type 1';
      if (x.subnets) s += ' subnets';
      L.push(s);
    }
    const d = dev.redistDefaults || {};
    if (proto === 'eigrp' && d.eigrp) L.push(' default-metric ' + [d.eigrp.bw, d.eigrp.delay, d.eigrp.rel, d.eigrp.load, d.eigrp.mtu].join(' '));
    if ((proto === 'rip' || proto === 'ospf') && d[proto] != null) L.push(' default-metric ' + d[proto]);
    return L;
  }

  /* ---------- router eigrp / router bgp ---------- */

  X.config.push((dev, s, a, neg, io, C) => {
    if (!(dev.type === 'router' || (dev.type === 'switch' && dev.l3))) return false;
    if (!C.kw(a[0], 'router', 3)) return false;
    if (C.kw(a[1], 'eigrp', 1)) {
      const n = Number(a[2]);
      if (!(Number.isInteger(n) && n >= 1 && n <= 65535)) { C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { if (dev.eigrp && dev.eigrp.asn === n) dev.eigrp = null; dev.net.markRouting(); }); return true; }
      if (dev.eigrp && dev.eigrp.asn !== n) { io.out('% В NetLab на устройстве может работать один процесс EIGRP (уже запущен router eigrp ' + dev.eigrp.asn + ')'); return true; }
      if (!dev.eigrp) C.withMutate(io, () => { dev.eigrp = { asn: n, networks: [], passive: [], autoSummary: false, variance: 1, routerId: null }; });
      s.mode = 'eigrp';
      return true;
    }
    if (C.kw(a[1], 'bgp', 1)) {
      const n = Number(a[2]);
      if (!(Number.isInteger(n) && n >= 1 && n <= 4294967295)) { C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { if (dev.bgp && dev.bgp.asn === n) dev.bgp = null; dev.net.markRouting(); }); return true; }
      if (dev.bgp && dev.bgp.asn !== n) { io.out('% BGP is already running; AS is ' + dev.bgp.asn); return true; }
      if (!dev.bgp) C.withMutate(io, () => { dev.bgp = { asn: n, routerId: null, neighbors: [], networks: [] }; });
      s.mode = 'bgp';
      return true;
    }
    return false;
  });

  function passiveCmd(dev, cfg, a, neg, io, C) {
    if (C.kw(a[1], 'default', 1)) {
      C.withMutate(io, () => { cfg.passive = neg ? [] : dev.ifaces.filter((f) => f.ip != null).map((f) => f.name); dev.net.markRouting(); });
      return;
    }
    const r = C.parseIfName(dev, a.slice(1).join(''));
    const f = r && C.ifaceOf(dev, r);
    if (!f) { io.out('% Интерфейс не найден'); return; }
    C.withMutate(io, () => { cfg.passive = cfg.passive.filter((x) => x !== f.name); if (!neg) cfg.passive.push(f.name); dev.net.markRouting(); });
  }

  X.modes.eigrp = {
    prompt: () => '(config-router)#',
    tree: ['network A.B.C.D', 'network A.B.C.D A.B.C.D', 'no auto-summary', 'auto-summary', 'passive-interface WORD', 'eigrp router-id A.B.C.D', 'variance WORD', 'redistribute static', 'redistribute connected', 'redistribute ospf WORD metric 10000 100 255 1 1500', 'default-metric 10000 100 255 1 1500'],
    run(dev, s, t, io, C) {
      const c = dev.eigrp;
      if (!c) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      const w = a[0];
      if (C.kw(w, 'network', 1)) {
        const n = U.parseIp(a[1] || '');
        if (n == null) { C.invalid(io, a[1]); return; }
        const wc = a[2] != null ? U.parseIp(a[2]) : null;
        if (a[2] != null && wc == null) { C.invalid(io, a[2]); return; }
        const netv = wc != null ? (n & ~wc) >>> 0 : U.net(n, U.classfulMask(n));
        C.withMutate(io, () => {
          c.networks = c.networks.filter((x) => !(x.net === netv && (x.wc || null) === (wc || null)));
          if (!neg) c.networks.push({ net: netv, wc });
          dev.net.markRouting();
        });
        if (!neg) kick(dev);
        return;
      }
      if (C.kw(w, 'auto-summary', 2)) { C.withMutate(io, () => { c.autoSummary = !neg; dev.net.markRouting(); }); return; }
      if (C.kw(w, 'passive-interface', 1)) { passiveCmd(dev, c, a, neg, io, C); return; }
      if (C.kw(w, 'eigrp', 1) && C.kw(a[1], 'router-id', 2)) {
        const v = U.parseIp(a[2] || '');
        if (!neg && v == null) { C.invalid(io, a[2]); return; }
        C.withMutate(io, () => { c.routerId = neg ? null : v; });
        return;
      }
      if (C.kw(w, 'variance', 1)) {
        const v = Number(a[1]);
        if (!neg && !(v >= 1 && v <= 128)) { C.invalid(io, a[1]); return; }
        C.withMutate(io, () => { c.variance = neg ? 1 : v; dev.net.markRouting(); });
        return;
      }
      if (C.kw(w, 'redistribute', 3)) { redistCmd(dev, 'eigrp', a, neg, io, C); return; }
      if (C.kw(w, 'default-metric', 2)) {
        const v = a.slice(1, 6).map(Number);
        if (!neg && (v.length < 5 || v.some((x) => !Number.isFinite(x)))) { C.incomplete(io); return; }
        C.withMutate(io, () => { ensureRedist(dev); if (neg) delete dev.redistDefaults.eigrp; else dev.redistDefaults.eigrp = { bw: v[0], delay: v[1], rel: v[2], load: v[3], mtu: v[4] }; dev.net.markRouting(); });
        return;
      }
      if (C.kw(w, 'metric', 1) || (C.kw(w, 'eigrp', 1) && C.kw(a[1], 'stub', 2)) || C.kw(w, 'maximum-paths', 2) || C.kw(w, 'distance', 2)) return;
      C.invalid(io, w);
    },
  };

  // первый расчёт после network — чтобы сразу появились сообщения о соседях
  function kick(dev) { dev.net.markRouting(); dev.net.ensureRouting(); }

  X.modes.bgp = {
    prompt: () => '(config-router)#',
    tree: ['neighbor A.B.C.D remote-as WORD', 'neighbor A.B.C.D update-source WORD', 'neighbor A.B.C.D next-hop-self', 'neighbor A.B.C.D ebgp-multihop WORD', 'neighbor A.B.C.D shutdown',
      'network A.B.C.D mask A.B.C.D', 'bgp router-id A.B.C.D', 'redistribute connected', 'redistribute static', 'redistribute ospf WORD'],
    run(dev, s, t, io, C) {
      const c = dev.bgp;
      if (!c) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      const w = a[0];
      if (C.kw(w, 'neighbor', 1)) {
        const nip = U.parseIp(a[1] || '');
        if (nip == null) { C.invalid(io, a[1]); return; }
        let n = c.neighbors.find((x) => x.ip === nip);
        const k = a[2];
        if (C.kw(k, 'remote-as', 1)) {
          const asn = Number(a[3]);
          if (neg) { C.withMutate(io, () => { c.neighbors = c.neighbors.filter((x) => x.ip !== nip); dev.net.markRouting(); }); return; }
          if (!Number.isInteger(asn)) { C.incomplete(io); return; }
          C.withMutate(io, () => { if (n) n.remoteAs = asn; else c.neighbors.push({ ip: nip, remoteAs: asn, updateSource: null, nextHopSelf: false, multihop: false, shutdown: false }); dev.net.markRouting(); });
          kick(dev);
          return;
        }
        if (!n) { io.out('% Specify remote-as or peer-group commands first'); return; }
        if (C.kw(k, 'update-source', 1)) {
          const r = C.parseIfName(dev, a.slice(3).join(''));
          const f = r && C.ifaceOf(dev, r);
          if (!neg && !f) { C.invalid(io, a[3]); return; }
          C.withMutate(io, () => { n.updateSource = neg ? null : f.name; dev.net.markRouting(); });
          return;
        }
        if (C.kw(k, 'next-hop-self', 1)) { C.withMutate(io, () => { n.nextHopSelf = !neg; dev.net.markRouting(); }); return; }
        if (C.kw(k, 'ebgp-multihop', 1)) { C.withMutate(io, () => { n.multihop = !neg; dev.net.markRouting(); }); return; }
        if (C.kw(k, 'shutdown', 1)) { C.withMutate(io, () => { n.shutdown = !neg; dev.net.markRouting(); }); kick(dev); return; }
        if (C.kw(k, 'description', 1) || C.kw(k, 'password', 1) || C.kw(k, 'timers', 1) || C.kw(k, 'activate', 1) || C.kw(k, 'route-map', 2) || C.kw(k, 'weight', 1)) return;
        C.invalid(io, k);
        return;
      }
      if (C.kw(w, 'network', 1)) {
        const n = U.parseIp(a[1] || '');
        if (n == null) { C.invalid(io, a[1]); return; }
        const mi = a.findIndex((x) => C.kw(x, 'mask', 1));
        const m = mi > 0 ? U.parseMask(a[mi + 1] || '') : U.classfulMask(n);
        if (m == null) { C.incomplete(io); return; }
        C.withMutate(io, () => {
          c.networks = c.networks.filter((x) => !(x.net === n && x.mask === m));
          if (!neg) c.networks.push({ net: U.net(n, m), mask: m });
          dev.net.markRouting();
        });
        return;
      }
      if (C.kw(w, 'bgp', 1) && C.kw(a[1], 'router-id', 2)) {
        const v = U.parseIp(a[2] || '');
        if (!neg && v == null) { C.invalid(io, a[2]); return; }
        C.withMutate(io, () => { c.routerId = neg ? null : v; dev.net.markRouting(); });
        return;
      }
      if (C.kw(w, 'redistribute', 3)) { redistCmd(dev, 'bgp', a, neg, io, C); return; }
      if (C.kw(w, 'bgp', 1) || C.kw(w, 'synchronization', 2) || C.kw(w, 'auto-summary', 2) || C.kw(w, 'address-family', 2) || C.kw(w, 'timers', 2)) return;
      C.invalid(io, w);
    },
  };

  // redistribute, default-metric и area … range внутри router rip / router ospf
  X.routerCmd = (X.routerCmd || []).concat([(dev, s, a, neg, io, C) => {
    const proto = s.mode === 'rip' ? 'rip' : 'ospf';
    if (C.kw(a[0], 'redistribute', 3)) { redistCmd(dev, proto, a, neg, io, C); return true; }
    if (C.kw(a[0], 'default-metric', 2)) {
      const v = Number(a[1]);
      if (!neg && !Number.isFinite(v)) { C.incomplete(io); return true; }
      C.withMutate(io, () => { ensureRedist(dev); if (neg) delete dev.redistDefaults[proto]; else dev.redistDefaults[proto] = v; dev.net.markRouting(); });
      return true;
    }
    if (proto === 'ospf' && C.kw(a[0], 'area', 1) && C.kw(a[2], 'range', 1)) {
      const n = U.parseIp(a[3] || '');
      const m = U.parseMask(a[4] || '');
      if (n == null || m == null) { C.incomplete(io); return true; }
      const area = U.parseIp(a[1]) != null && /\./.test(a[1]) ? U.parseIp(a[1]) : Number(a[1]);
      C.withMutate(io, () => {
        if (!dev.ospfRanges) dev.ospfRanges = [];
        dev.ospfRanges = dev.ospfRanges.filter((r) => !(String(r.area) === String(area) && r.net === n && r.mask === m));
        if (!neg) dev.ospfRanges.push({ area, net: U.net(n, m), mask: m });
        dev.net.markRouting();
      });
      return true;
    }
    return false;
  }]);

  X.running.ospf = (X.running.ospf || []).concat([(dev) => (dev.ospfRanges || []).map((r) => ' area ' + r.area + ' range ' + ip(r.net) + ' ' + ip(r.mask)).concat(redistLines(dev, 'ospf'))]);
  X.running.rip = (X.running.rip || []).concat([(dev) => redistLines(dev, 'rip')]);

  X.running.tail.push((dev) => {
    const L = [];
    const c = dev.eigrp;
    if (c) {
      L.push('router eigrp ' + c.asn);
      if (c.routerId != null) L.push(' eigrp router-id ' + ip(c.routerId));
      for (const p of c.passive) L.push(' passive-interface ' + p);
      for (const n of c.networks) L.push(' network ' + ip(n.net) + (n.wc != null ? ' ' + ip(n.wc) : ''));
      L.push(...redistLines(dev, 'eigrp'));
      if (c.variance !== 1) L.push(' variance ' + c.variance);
      L.push(c.autoSummary ? ' auto-summary' : ' no auto-summary');
      L.push('!');
    }
    const b = dev.bgp;
    if (b) {
      L.push('router bgp ' + b.asn);
      if (b.routerId != null) L.push(' bgp router-id ' + ip(b.routerId));
      L.push(' bgp log-neighbor-changes', ' no synchronization');
      for (const n of b.neighbors) {
        L.push(' neighbor ' + ip(n.ip) + ' remote-as ' + n.remoteAs);
        if (n.updateSource) L.push(' neighbor ' + ip(n.ip) + ' update-source ' + n.updateSource);
        if (n.multihop) L.push(' neighbor ' + ip(n.ip) + ' ebgp-multihop 255');
        if (n.nextHopSelf) L.push(' neighbor ' + ip(n.ip) + ' next-hop-self');
        if (n.shutdown) L.push(' neighbor ' + ip(n.ip) + ' shutdown');
      }
      for (const n of b.networks) L.push(' network ' + ip(n.net) + ' mask ' + ip(n.mask));
      L.push(...redistLines(dev, 'bgp'));
      L.push('!');
    }
    return L;
  });

  /* ---------- интерфейс: суммаризация EIGRP, delay ---------- */

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    const ifs = targets.map((r) => C.ifaceOf(dev, r)).filter(Boolean);
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'summary-address', 2)) {
      if (!C.kw(a[2], 'eigrp', 1)) { if (C.kw(a[2], 'rip', 1)) return true; C.invalid(io, a[2]); return true; }
      const asn = Number(a[3]);
      const n = U.parseIp(a[4] || '');
      const m = U.parseMask(a[5] || '');
      if (!Number.isInteger(asn) || n == null || m == null) { C.incomplete(io); return true; }
      C.withMutate(io, () => {
        for (const f of ifs) {
          f.eigrpSum = (f.eigrpSum || []).filter((x) => !(x.asn === asn && x.net === U.net(n, m) && x.mask === m));
          if (!neg) f.eigrpSum.push({ asn, net: U.net(n, m), mask: m });
        }
        dev.net.markRouting();
      });
      return true;
    }
    if (C.kw(a[0], 'delay', 2) && (dev.type === 'router' || dev.l3)) {
      const v = Number(a[1]);
      if (!neg && !(Number.isInteger(v) && v >= 1 && v <= 16777215)) { C.incomplete(io); return true; }
      C.withMutate(io, () => { for (const f of ifs) f.delay = neg ? null : v; dev.net.markRouting(); });
      return true;
    }
    if (C.kw(a[0], 'ip', 2) && (C.kw(a[1], 'hello-interval', 2) || C.kw(a[1], 'hold-time', 2) || C.kw(a[1], 'bandwidth-percent', 2)) && C.kw(a[2], 'eigrp', 1)) return true;
    return false;
  });

  X.running.iface.push((dev, f) => {
    if (!f) return [];
    const L = [];
    for (const x of f.eigrpSum || []) L.push(' ip summary-address eigrp ' + x.asn + ' ' + ip(x.net) + ' ' + ip(x.mask));
    if (f.delay != null) L.push(' delay ' + f.delay);
    return L;
  });

  /* ---------- show ---------- */

  const age = (dev) => '00:' + String(1 + Math.floor(dev.net.time / 6000) % 60).padStart(2, '0') + ':' + String(Math.floor(dev.net.time / 100) % 60).padStart(2, '0');

  X.show.push((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'ip', 1) || !dev.ifaces) return false;
    const w = a[1];
    if (C.kw(w, 'eigrp', 1)) {
      dev.net.ensureRouting();
      const c = dev.eigrp;
      if (!c) { io.out('% EIGRP не запущен (router eigrp N).'); return true; }
      if (C.kw(a[2], 'neighbors', 1)) {
        io.out('IP-EIGRP neighbors for process ' + c.asn);
        io.out('H   Address         Interface      Hold Uptime    SRTT   RTO   Q   Seq');
        io.out('                                   (sec)          (ms)        Cnt  Num');
        (dev.eigrpNeighbors || []).forEach((n, i) => io.out(C.pad(String(i), 4) + C.pad(ip(n.address), 16) + C.pad(C.shortIf(n.ifname), 15) + C.pad('14', 5) + C.pad(age(dev), 10) + C.pad('40', 7) + C.pad('1000', 6) + C.pad('0', 4) + String(10 + i)));
        return true;
      }
      if (C.kw(a[2], 'topology', 1)) {
        io.out('IP-EIGRP Topology Table for AS ' + c.asn + '/ID(' + ip(c.routerId != null ? c.routerId : R2.routerIdOf(dev)) + ')');
        io.out('');
        io.out('Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,');
        io.out('       r - Reply status');
        io.out('');
        for (const t of dev.eigrpTopo || []) {
          io.out('P ' + U.cidr(t.net, t.mask) + ', ' + Math.max(1, t.succ.length) + ' successors, FD is ' + t.fd);
          if (t.connected) {
            const f = dev.ifaces.find((g) => g.ip != null && U.net(g.ip, g.mask) === t.net && g.mask === t.mask);
            io.out('         via Connected, ' + (f ? f.name : '?'));
          } else if (!t.succ.length && t.ext) io.out('         via Redistributed (' + t.fd + '/0)');
          for (const v of t.succ) io.out('         via ' + ip(v.nh) + ' (' + v.metric + '/' + v.rd + '), ' + v.ifname);
          for (const v of t.fs) io.out('         via ' + ip(v.nh) + ' (' + v.metric + '/' + v.rd + '), ' + v.ifname + '   <- feasible successor');
        }
        return true;
      }
      if (C.kw(a[2], 'interfaces', 1)) {
        io.out('IP-EIGRP interfaces for process ' + c.asn);
        io.out('');
        io.out('                        Xmit Queue   Mean   Pacing Time   Multicast    Pending');
        io.out('Interface        Peers  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes');
        for (const f of dev.ifaces) {
          if (f.ip == null || !c.networks.some((n) => (n.wc != null ? U.matchWild(f.ip, n.net, n.wc) : U.net(f.ip, U.classfulMask(f.ip)) === U.net(n.net, U.classfulMask(n.net))))) continue;
          if (c.passive.includes(f.name)) continue;
          const peers = (dev.eigrpNeighbors || []).filter((n) => n.ifname === f.name).length;
          io.out(C.pad(C.shortIf(f.name), 17) + C.pad(String(peers), 7) + C.pad('0/0', 13) + C.pad('40', 7) + C.pad('0/1', 14) + C.pad('50', 13) + '0');
        }
        return true;
      }
      C.invalid(io, a[2]);
      return true;
    }
    if (C.kw(w, 'bgp', 1)) {
      dev.net.ensureRouting();
      const b = dev.bgp;
      if (!b) { io.out('% BGP not active'); return true; }
      const rid = R2.routerIdOf(dev);
      if (C.kw(a[2], 'summary', 1)) {
        io.out('BGP router identifier ' + ip(rid) + ', local AS number ' + b.asn);
        const n = dev.bgpTable ? dev.bgpTable.size : 0;
        io.out('BGP table version is ' + (n + 1) + ', main routing table version ' + (n + 1));
        io.out(n + ' network entries using ' + n * 132 + ' bytes of memory');
        io.out('');
        io.out('Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd');
        for (const p of dev.bgpPeers || []) {
          const pfx = p.state === 'Established' ? [...(dev.bgpTable || new Map()).values()].filter((l) => l.some((x) => x.from === p.peer)).length : null;
          io.out(C.pad(ip(p.n.ip), 16) + C.pad('4', 5) + C.pad(String(p.n.remoteAs), 6) + C.pad('12', 8) + C.pad('12', 10) + C.pad(String(n + 1), 5) + C.pad('0', 5) + C.pad('0', 5) + C.pad(p.state === 'Established' ? age(dev) : 'never', 9) + (p.state === 'Established' ? String(pfx) : p.state));
        }
        return true;
      }
      if (C.kw(a[2], 'neighbors', 1)) {
        for (const p of dev.bgpPeers || []) {
          io.out('BGP neighbor is ' + ip(p.n.ip) + ',  remote AS ' + p.n.remoteAs + ', ' + (p.ebgp ? 'external' : 'internal') + ' link');
          io.out('  BGP version 4, remote router ID ' + (p.peer ? ip(R2.routerIdOf(p.peer)) : '0.0.0.0'));
          io.out('  BGP state = ' + p.state + (p.state === 'Established' ? ', up for ' + age(dev) : ''));
          if (p.text) io.out('  Причина: ' + p.text);
          if (p.n.updateSource) io.out('  Update source: ' + p.n.updateSource);
          io.out('');
        }
        return true;
      }
      io.out('BGP table version is ' + ((dev.bgpTable ? dev.bgpTable.size : 0) + 1) + ', local router ID is ' + ip(rid));
      io.out('Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,');
      io.out('              r RIB-failure, S Stale');
      io.out('Origin codes: i - IGP, e - EGP, ? - incomplete');
      io.out('');
      io.out('   Network          Next Hop            Metric LocPrf Weight Path');
      const entries = [...(dev.bgpTable || new Map()).entries()].sort((x, y) => x[1][0].net - y[1][0].net);
      for (const [, list] of entries) {
        list.forEach((p, i) => {
          const flag = (p.inaccessible ? ' ' : '*') + (p.best && !p.inaccessible ? '>' : ' ') + (p.ebgp || p.local ? ' ' : 'i');
          io.out(flag + C.pad(i === 0 ? U.cidr(p.net, p.mask) : '', 17) + C.pad(p.local ? '0.0.0.0' : ip(p.nh), 20) + C.pad(String(p.metric || 0), 7) + C.pad(p.ebgp || p.local ? '' : '100', 7) + C.pad(p.local ? '32768' : '0', 7) + p.asPath.join(' ') + (p.asPath.length ? ' ' : '') + p.origin);
        });
      }
      return true;
    }
    if (C.kw(w, 'protocols', 1) && (dev.eigrp || dev.bgp)) {
      if ((dev.rip && dev.rip.networks.length) || dev.ospf) NS.cliIos.showProtocols(dev, io);
      const c = dev.eigrp;
      if (c) {
        io.out('Routing Protocol is "eigrp  ' + c.asn + '"');
        io.out('  Outgoing update filter list for all interfaces is not set');
        io.out('  Incoming update filter list for all interfaces is not set');
        io.out('  Default networks flagged in outgoing updates');
        io.out('  Default networks accepted from incoming updates');
        io.out('  EIGRP metric weight K1=1, K2=0, K3=1, K4=0, K5=0');
        io.out('  EIGRP maximum hopcount 100');
        io.out('  EIGRP maximum metric variance ' + c.variance);
        io.out('  Redistributing: eigrp ' + c.asn + ((dev.redist && dev.redist.eigrp) || []).map((x) => ', ' + x.src + (x.id != null ? ' ' + x.id : '')).join(''));
        io.out('  Automatic network summarization is ' + (c.autoSummary ? 'in effect' : 'not in effect'));
        io.out('  Maximum path: 4');
        io.out('  Routing for Networks: ');
        for (const n of c.networks) io.out('     ' + (n.wc != null ? U.cidr(n.net, (~n.wc) >>> 0) : ip(n.net)));
        if (c.passive.length) { io.out('  Passive Interface(s): '); for (const p of c.passive) io.out('    ' + p); }
        io.out('  Routing Information Sources: ');
        io.out('    Gateway         Distance      Last Update');
        for (const n of dev.eigrpNeighbors || []) io.out('    ' + C.pad(ip(n.address), 16) + C.pad('90', 14) + age(dev));
        io.out('  Distance: internal 90 external 170');
        io.out('');
      }
      if (dev.bgp) {
        io.out('Routing Protocol is "bgp ' + dev.bgp.asn + '"');
        io.out('  IGP synchronization is disabled');
        io.out('  Neighbor(s):');
        io.out('    Address          FiltIn FiltOut DistIn DistOut Weight RouteMap');
        for (const n of dev.bgp.neighbors) io.out('    ' + ip(n.ip));
        io.out('  Maximum path: 1');
        io.out('  Distance: external 20 internal 200 local 200');
      }
      return true;
    }
    return false;
  });

  X.exec.push((dev, s, t, io, line, C) => {
    if (s.mode !== 'exec' || !C.kw(t[0], 'clear', 3) || !C.kw(t[1], 'ip', 1)) return null;
    if (C.kw(t[2], 'bgp', 1) || C.kw(t[2], 'eigrp', 1) || C.kw(t[2], 'ospf', 1)) { dev.net.markRouting(); return { handled: true }; }
    return null;
  });

  /* ---------- сообщения о соседях EIGRP и BGP ---------- */

  NS.routing.afterCompute = (NS.routing.afterCompute || []).concat([(net) => {
    for (const d of net.devices.values()) {
      if (!d.ifaces || !d.ios || !d.power || !d.iosLog) continue;
      const nowE = new Set((d.eigrpNeighbors || []).map((n) => n.address + '|' + n.ifname));
      const prevE = d._eigrpNb || new Set();
      for (const k of nowE) if (!prevE.has(k)) { const [a, ifn] = k.split('|'); d.iosLog('DUAL', 5, 'NBRCHANGE', 'EIGRP-IPv4 ' + d.eigrp.asn + ': Neighbor ' + ip(Number(a)) + ' (' + ifn + ') is up: new adjacency'); }
      for (const k of prevE) if (!nowE.has(k)) { const [a, ifn] = k.split('|'); d.iosLog('DUAL', 5, 'NBRCHANGE', 'EIGRP-IPv4 ' + (d.eigrp ? d.eigrp.asn : '') + ': Neighbor ' + ip(Number(a)) + ' (' + ifn + ') is down: interface down'); }
      d._eigrpNb = nowE;
      const nowB = new Set((d.bgpPeers || []).filter((p) => p.state === 'Established').map((p) => String(p.n.ip)));
      const prevB = d._bgpNb || new Set();
      for (const k of nowB) if (!prevB.has(k)) d.iosLog('BGP', 5, 'ADJCHANGE', 'neighbor ' + ip(Number(k)) + ' Up');
      for (const k of prevB) if (!nowB.has(k)) d.iosLog('BGP', 5, 'ADJCHANGE', 'neighbor ' + ip(Number(k)) + ' Down');
      d._bgpNb = nowB;
    }
  }]);

  X.tree.config = (X.tree.config || []).concat(['router eigrp WORD', 'router bgp WORD']);
  X.tree.rip = (X.tree.rip || []).concat(['redistribute static', 'redistribute connected', 'redistribute ospf WORD metric WORD', 'redistribute eigrp WORD metric WORD', 'default-metric WORD']);
  X.tree.ospf = (X.tree.ospf || []).concat(['redistribute static subnets', 'redistribute connected subnets', 'redistribute eigrp WORD subnets', 'redistribute rip subnets', 'redistribute bgp WORD subnets', 'default-metric WORD', 'area WORD range A.B.C.D A.B.C.D']);
  X.tree.if = (X.tree.if || []).concat(['ip summary-address eigrp WORD A.B.C.D A.B.C.D', 'delay WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show ip eigrp neighbors', 'show ip eigrp topology', 'show ip eigrp interfaces', 'show ip bgp', 'show ip bgp summary', 'show ip bgp neighbors', 'show ip route eigrp', 'show ip route bgp', 'clear ip bgp *']);
})(globalThis.NetLab = globalThis.NetLab || {});
