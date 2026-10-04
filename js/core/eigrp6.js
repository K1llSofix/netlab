/* NetLab — EIGRP для IPv6: ipv6 router eigrp N (eigrp router-id, passive-interface, redistribute static|connected,
 * shutdown), ipv6 eigrp N на интерфейсе; соседи — по link-local адресам, составная метрика EIGRP (пропускная
 * способность + задержка), до 4 равноценных путей; маршруты D (AD 90) и EX (AD 170);
 * show ipv6 eigrp neighbors|topology|interfaces, show ipv6 route eigrp, %DUAL-5-NBRCHANGE. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const ip6 = NS.ip6;
  const R0 = NS.routing;
  const R2 = NS.routing2;
  const R6 = NS.routing6;
  const X = NS.cliIos.ext;
  const up = (v) => ip6.str(v, true);
  const isL3 = (dev) => dev.type === 'router' || (dev.type === 'switch' && dev.l3);

  function rid(d) {
    const c = d.eigrp6;
    if (!c) return 0;
    if (c.routerId != null) return c.routerId;
    const loops = d.ifaces.filter((f) => f.kind === 'loop' && f.ip != null && f.adminUp).map((f) => f.ip);
    if (loops.length) return Math.max(...loops);
    const ips = d.ifaces.filter((f) => f.ip != null && d.ifaceUp(f)).map((f) => f.ip);
    return ips.length ? Math.max(...ips) : 0;
  }
  const running = (d) => !!d.eigrp6 && !d.eigrp6.shutdown && rid(d) !== 0;
  const eigrpOn = (d, f) => (running(d) && f.v6r && f.v6r.eigrp === d.eigrp6.asn ? 'as' + d.eigrp6.asn : null);
  const passive = (d, f) => (d.eigrp6.passive || []).some((n) => n.toLowerCase() === f.name.toLowerCase());
  const metricOf = (d, f) => ({ bw: R2.ifBw(d, f), delay: R2.ifDelay(d, f) });
  const addHop = (m, d, f) => ({ bw: Math.min(m.bw, R2.ifBw(d, f)), delay: m.delay + R2.ifDelay(d, f) });

  function computeEigrp6(net, devs) {
    const edevs = devs.filter(running);
    const edges = R6.adjacencies6(net, edevs, eigrpOn, passive);
    const own = new Map();
    for (const d of edevs) {
      const m = new Map();
      for (const f of d.ifaces) {
        if (!eigrpOn(d, f) || !R6.on(f) || !d.ifaceUp(f)) continue;
        for (const a of R6.globals(f)) {
          const plen = a.plen;
          const n = ip6.net(a.addr, a.plen);
          m.set(R6.key6(n, plen), { net: n, plen, metric: metricOf(d, f), ext: false });
        }
      }
      for (const p of R6.redist6(d, d.eigrp6)) {
        const k = R6.key6(p.net, p.plen);
        if (!m.has(k)) m.set(k, { net: p.net, plen: p.plen, metric: { bw: 100000, delay: 10 }, ext: true });
      }
      own.set(d, m);
    }
    let tables = new Map(edevs.map((d) => [d, new Map()]));
    const topo = new Map(edevs.map((d) => [d, new Map()])); // все возможные пути — для show topology
    for (let round = 0; round < 20; round++) {
      const next = new Map(edevs.map((d) => [d, new Map()]));
      const nextTopo = new Map(edevs.map((d) => [d, new Map()]));
      for (const e of edges) {
        const R = e.from;
        const N = e.to;
        const nh = N.ll6(e.tIf);
        const adv = [];
        for (const p of own.get(N).values()) adv.push(p);
        for (const [k, list] of tables.get(N)) {
          if (own.get(N).has(k) || list.some((x) => x.ifc === e.tIf)) continue; // split horizon
          adv.push({ net: list[0].net, plen: list[0].plen, metric: list[0].m, ext: list[0].ext });
        }
        const t = next.get(R);
        for (const a of adv) {
          const k = R6.key6(a.net, a.plen);
          if (own.get(R).has(k) && !own.get(R).get(k).ext) continue;
          if (R.ifaces.some((f) => R6.on(f) && R.ifaceUp(f) && R6.globals(f).some((x) => x.plen === a.plen && ip6.net(x.addr, x.plen) === a.net))) continue;
          const m = addHop(a.metric, R, e.fIf);
          const comp = R2.composite(m);
          const route = { type: 'D', sub: a.ext ? 'EX' : '', ad: a.ext ? 170 : 90, metric: comp, m, rd: R2.composite(a.metric), net: a.net, plen: a.plen, nextHop: nh, ifc: e.fIf, from: N, ext: a.ext };
          const tp = nextTopo.get(R);
          if (!tp.has(k)) tp.set(k, []);
          tp.get(k).push(route);
          const cur = t.get(k);
          if (!cur || comp < cur[0].metric) t.set(k, [route]);
          else if (comp === cur[0].metric && cur.length < 4 && !cur.some((x) => x.nextHop === nh && x.ifc === e.fIf)) cur.push(route);
        }
      }
      const sig = (m) => [...m].map(([k, l]) => k + l.map((x) => x.metric + '@' + x.nextHop).join()).sort().join('|');
      const changed = edevs.some((d) => sig(tables.get(d)) !== sig(next.get(d)));
      tables = next;
      for (const [d, t] of nextTopo) topo.set(d, t);
      if (!changed) break;
    }
    for (const d of edevs) {
      d.eigrp6Neighbors = edges.filter((e) => e.from === d).map((e) => ({ ll: e.to.ll6(e.tIf), ifname: e.fIf.name, dev: e.to }));
      d.eigrp6Topo = topo.get(d);
    }
    const out = new Map();
    for (const d of edevs) out.set(d, [].concat(...tables.get(d).values()));
    return out;
  }

  function logChanges(net) {
    for (const d of net.devices.values()) {
      if (!d.ifaces || !d.iosLog || !d.power) continue;
      const now = new Map((d.eigrp6Neighbors || []).map((n) => [n.ll + '|' + n.ifname, n]));
      const prev = d._eigrp6Nb || new Map();
      const asn = d.eigrp6 ? d.eigrp6.asn : '';
      for (const [k, n] of now) if (!prev.has(k)) d.iosLog('DUAL', 5, 'NBRCHANGE', 'EIGRP-IPv6 ' + asn + ': Neighbor ' + up(n.ll) + ' (' + n.ifname + ') is up: new adjacency');
      for (const [k, n] of prev) if (!now.has(k)) d.iosLog('DUAL', 5, 'NBRCHANGE', 'EIGRP-IPv6 ' + (n.asn || asn) + ': Neighbor ' + up(n.ll) + ' (' + n.ifname + ') is down: interface down');
      d._eigrp6Nb = new Map([...now].map(([k, n]) => [k, Object.assign({ asn }, n)]));
    }
  }

  const baseCompute = R0.compute;
  R0.compute = function (net) {
    baseCompute.call(this, net);
    const devs = [...net.devices.values()].filter((d) => d.ifaces);
    for (const d of devs) { d.eigrp6Neighbors = []; d.eigrp6Topo = null; }
    const active = devs.filter(R6.routing6);
    if (active.some((d) => d.eigrp6)) {
      const res = computeEigrp6(net, active);
      for (const [d, routes] of res) d.dynRoutes6 = (d.dynRoutes6 || []).concat(routes);
    }
    logChanges(net);
  };

  /* ---------- команды ---------- */

  X.global.push((t) => /^ipv6$/i.test(t[0] || '') && /^router$/i.test(t[1] || '') && /^eigrp$/i.test(t[2] || ''));

  X.config.unshift((dev, s, a, neg, io, C) => {
    if (!isL3(dev) || !C.kw(a[0], 'ipv6', 4) || !C.kw(a[1], 'router', 6) || !C.kw(a[2], 'eigrp', 1)) return false;
    const asn = Number(a[3]);
    if (!(Number.isInteger(asn) && asn >= 1 && asn <= 65535)) { C.incomplete(io); return true; }
    if (neg) {
      C.withMutate(io, () => {
        if (dev.eigrp6 && dev.eigrp6.asn === asn) dev.eigrp6 = null;
        for (const f of dev.ifaces) if (f.v6r && f.v6r.eigrp === asn) delete f.v6r.eigrp;
        dev.net.markRouting();
      });
      return true;
    }
    if (!dev.v6cfg().routing) { io.out('% IPv6 routing not enabled'); return true; }
    if (dev.eigrp6 && dev.eigrp6.asn !== asn) { io.out('% В NetLab на устройстве один процесс EIGRP для IPv6 (уже запущен ' + dev.eigrp6.asn + ')'); return true; }
    if (!dev.eigrp6) C.withMutate(io, () => { dev.eigrp6 = { asn, routerId: null, passive: [], redist: [], shutdown: false }; dev.net.markRouting(); });
    if (!rid(dev)) io.out('% EIGRP-IPv6 ' + asn + ': router-id не выбран — задайте eigrp router-id (на устройстве нет IPv4-адресов)');
    s.mode = 'eigrp6';
    return true;
  });

  X.modes.eigrp6 = {
    prompt: () => '(config-rtr)#',
    tree: ['eigrp router-id A.B.C.D', 'passive-interface WORD', 'redistribute static', 'redistribute connected', 'shutdown', 'no shutdown'],
    run(dev, s, t, io, C) {
      const c = dev.eigrp6;
      if (!c) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'eigrp', 2) && C.kw(a[1], 'router-id', 1)) {
        const v = U.parseIp(a[2] || '');
        if (!neg && v == null) { C.invalid(io, a[2]); return; }
        C.withMutate(io, () => { c.routerId = neg ? null : v; dev.net.markRouting(); });
        return;
      }
      if (C.kw(a[0], 'shutdown', 2)) { C.withMutate(io, () => { c.shutdown = !neg; dev.net.markRouting(); }); return; }
      if (C.kw(a[0], 'passive-interface', 1)) {
        if (C.kw(a[1], 'default', 1)) { C.withMutate(io, () => { c.passive = neg ? [] : dev.ifaces.map((f) => f.name); dev.net.markRouting(); }); return; }
        const r = C.parseIfName(dev, a.slice(1).join(''));
        const f = r && C.ifaceOf(dev, r);
        if (!f) { io.out('% Интерфейс не найден'); return; }
        C.withMutate(io, () => { c.passive = c.passive.filter((x) => x !== f.name); if (!neg) c.passive.push(f.name); dev.net.markRouting(); });
        return;
      }
      if (C.kw(a[0], 'redistribute', 3)) {
        const src = ['static', 'connected'].find((x) => C.kw(a[1], x, 2));
        if (!src) { if (a[1]) io.out('% В NetLab в EIGRP для IPv6 передаются только static и connected'); else C.incomplete(io); return; }
        C.withMutate(io, () => { c.redist = c.redist.filter((x) => x !== src); if (!neg) c.redist.push(src); dev.net.markRouting(); });
        return;
      }
      if (C.kw(a[0], 'maximum-paths', 2) || C.kw(a[0], 'variance', 2) || C.kw(a[0], 'metric', 2) || C.kw(a[0], 'distance', 2)) return;
      C.invalid(io, a[0]);
    },
  };

  X.iface.unshift((dev, s, a, neg, io, targets, C) => {
    if (!C.kw(a[0], 'ipv6', 4) || !C.kw(a[1], 'eigrp', 1)) return false;
    const ifs = targets.map((r) => C.ifaceOf(dev, r));
    if (ifs.some((f) => !f)) { io.out('% Порт коммутатора работает на 2-м уровне. IPv6 настраивается на interface vlan или маршрутизируемом порту.'); return true; }
    const asn = Number(a[2]);
    if (!(Number.isInteger(asn) && asn >= 1)) { C.incomplete(io); return true; }
    if (!neg && !dev.v6cfg().routing) { io.out('% IPv6 routing not enabled'); return true; }
    if (!neg && dev.eigrp6 && dev.eigrp6.asn !== asn) { io.out('% В NetLab на устройстве один процесс EIGRP для IPv6 (уже запущен ' + dev.eigrp6.asn + ')'); return true; }
    C.withMutate(io, () => {
      if (!neg && !dev.eigrp6) dev.eigrp6 = { asn, routerId: null, passive: [], redist: [], shutdown: false };
      for (const f of ifs) { const r = R6.r6(f); if (neg) delete r.eigrp; else r.eigrp = asn; }
      dev.net.markRouting();
    });
    return true;
  });

  X.running.global.push((dev) => {
    const c = dev.eigrp6;
    if (!c) return [];
    const L = ['ipv6 router eigrp ' + c.asn];
    if (c.routerId != null) L.push(' eigrp router-id ' + U.ipStr(c.routerId));
    for (const n of c.passive) L.push(' passive-interface ' + n);
    for (const r of c.redist) L.push(' redistribute ' + r);
    if (c.shutdown) L.push(' shutdown');
    L.push('!');
    return L;
  });
  X.running.iface.push((dev, f) => (f && f.v6r && f.v6r.eigrp ? [' ipv6 eigrp ' + f.v6r.eigrp] : []));

  X.show.unshift((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'ipv6', 4)) return false;
    if (C.kw(a[1], 'protocols', 1) && dev.eigrp6) {
      dev.net.ensureRouting();
      const c = dev.eigrp6;
      io.out('IPv6 Routing Protocol is "eigrp ' + c.asn + '"');
      io.out('EIGRP-IPv6 Protocol for AS(' + c.asn + ')');
      io.out('  Metric weight K1=1, K2=0, K3=1, K4=0, K5=0');
      io.out('  Router-ID: ' + U.ipStr(rid(dev)) + (c.shutdown ? '  (shutdown)' : ''));
      io.out('  Interfaces:');
      for (const f of dev.ifaces) if (f.v6r && f.v6r.eigrp === c.asn) io.out('    ' + f.name + (passive(dev, f) ? ' (passive)' : ''));
      io.out('  Redistribution:');
      io.out(c.redist.length ? '    Redistributing protocol ' + c.redist.join(', ') : '    None');
      return false; // дальше — остальные протоколы IPv6
    }
    if (!C.kw(a[1], 'eigrp', 1)) return false;
    dev.net.ensureRouting();
    const c = dev.eigrp6;
    if (!c) { io.out('% EIGRP для IPv6 не запущен'); return true; }
    if (C.kw(a[2], 'neighbors', 1)) {
      io.out('EIGRP-IPv6 Neighbors for AS(' + c.asn + ')');
      io.out('H   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq');
      io.out('                                                   (sec)         (ms)       Cnt Num');
      (dev.eigrp6Neighbors || []).forEach((n, i) => {
        io.out(C.pad(String(i), 4) + 'Link-local address:     ' + C.pad(C.shortIf(n.ifname), 23) + C.pad('14', 5) + C.pad('00:02:13', 9) + C.pad('1', 7) + C.pad('100', 5) + C.pad('0', 3) + '5');
        io.out('    ' + up(n.ll));
      });
      return true;
    }
    if (C.kw(a[2], 'interfaces', 1)) {
      io.out('EIGRP-IPv6 Interfaces for AS(' + c.asn + ')');
      io.out('                        Xmit Queue   PeerQ        Mean   Pacing Time   Multicast    Pending');
      io.out('Interface        Peers  Un/Reliable  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes');
      for (const f of dev.ifaces) {
        if (!f.v6r || f.v6r.eigrp !== c.asn || passive(dev, f)) continue;
        const peers = (dev.eigrp6Neighbors || []).filter((n) => n.ifname === f.name).length;
        io.out(C.pad(C.shortIf(f.name), 17) + C.pad(String(peers), 7) + C.pad('0/0', 13) + C.pad('0/0', 13) + C.pad('1', 7) + C.pad('0/0', 14) + C.pad('50', 13) + '0');
      }
      return true;
    }
    if (C.kw(a[2], 'topology', 1)) {
      io.out('EIGRP-IPv6 Topology Table for AS(' + c.asn + ')/ID(' + U.ipStr(rid(dev)) + ')');
      io.out('Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,');
      io.out('       r - reply Status, s - sia Status');
      io.out('');
      const best = new Map();
      for (const r of dev.dynRoutes6 || []) if (r.type === 'D') { const k = R6.key6(r.net, r.plen); if (!best.has(k)) best.set(k, []); best.get(k).push(r); }
      for (const f of dev.ifaces) {
        if (!f.v6r || f.v6r.eigrp !== c.asn || !R6.on(f) || !dev.ifaceUp(f)) continue;
        for (const x of R6.globals(f)) {
          io.out('P ' + ip6.cidr(x.addr, x.plen, true) + ', 1 successors, FD is ' + R2.composite(metricOf(dev, f)));
          io.out('        via Connected, ' + f.name);
        }
      }
      for (const [k, list] of best) {
        const all = (dev.eigrp6Topo && dev.eigrp6Topo.get(k)) || list;
        io.out('P ' + ip6.cidr(list[0].net, list[0].plen, true) + ', ' + list.length + ' successors, FD is ' + list[0].metric);
        for (const r of all.slice().sort((x, y) => x.metric - y.metric)) {
          if (r.metric !== list[0].metric && r.rd >= list[0].metric) continue; // не feasible successor
          io.out('        via ' + up(r.nextHop) + ' (' + r.metric + '/' + r.rd + '), ' + r.ifc.name);
        }
      }
      return true;
    }
    C.invalid(io, a[2]);
    return true;
  });

  NS.deviceExt.push({
    key: 'eigrp6',
    applies: isL3,
    save(d) {
      const ifs = {};
      for (const f of d.ifaces || []) if (f.v6r && f.v6r.eigrp) ifs[f.name] = f.v6r.eigrp;
      if (!d.eigrp6 && !Object.keys(ifs).length) return null;
      const c = d.eigrp6;
      return { proc: c ? { asn: c.asn, routerId: c.routerId != null ? U.ipStr(c.routerId) : null, passive: c.passive.slice(), redist: c.redist.slice(), shutdown: !!c.shutdown } : null, ifaces: ifs };
    },
    load(d, c) {
      const p = c && c.proc;
      d.eigrp6 = p ? { asn: Number(p.asn), routerId: p.routerId ? U.parseIp(p.routerId) : null, passive: (p.passive || []).slice(), redist: (p.redist || []).slice(), shutdown: !!p.shutdown } : null;
      for (const f of d.ifaces || []) {
        const v = c && c.ifaces && c.ifaces[f.name];
        if (v) R6.r6(f).eigrp = Number(v); else if (f.v6r) delete f.v6r.eigrp;
      }
      if (d.net) d.net.markRouting();
    },
  });

  X.tree.config = (X.tree.config || []).concat(['ipv6 router eigrp WORD']);
  X.tree.if = (X.tree.if || []).concat(['ipv6 eigrp WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show ipv6 eigrp neighbors', 'show ipv6 eigrp topology', 'show ipv6 eigrp interfaces', 'show ipv6 route eigrp']);

  NS.eigrp6 = { computeEigrp6, rid };
})(globalThis.NetLab = globalThis.NetLab || {});
