/* NetLab — динамическая маршрутизация, часть 2: заменяет общий расчёт маршрутов и добавляет
 *  • EIGRP: соседи, составная метрика (пропускная способность + задержка), DUAL — successor и feasible
 *    successor, variance, passive-interface, ручная (ip summary-address eigrp) и авто-суммаризация с Null0;
 *  • OSPF: межзональные маршруты (O IA), внешние (O E2) из редистрибуции, суммаризация area … range на ABR;
 *  • редистрибуция между RIP, OSPF, EIGRP, BGP, static и connected (metric, default-metric, subnets);
 *  • BGP: eBGP и iBGP сессии (neighbor … remote-as, update-source, next-hop-self, ebgp-multihop),
 *    network … mask, AS_PATH и защита от петель, выбор лучшего пути, show ip bgp / summary.
 * Протоколы сходятся мгновенно, но по настоящим правилам. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const IpNode = NS.IpNode;
  const R0 = NS.routing;
  const { reach, ifaceCost, routerId, ospfArea, ripEnabled } = R0;

  /* ---------- общее ---------- */

  function pointKey(dev, f) {
    if (f.kind === 'svi') return dev.id + '|svi|' + f.vlan;
    return dev.id + '|' + f.port + '|' + (f.kind === 'sub' ? f.vlan : 'u');
  }
  function isPassive(cfg, f) { return !!cfg && (cfg.passive || []).some((n) => n.toLowerCase() === f.name.toLowerCase()); }

  function adjacencies(net, devs, enabled, cfgOf, directional) {
    const pts = [];
    for (const d of devs) {
      for (const f of d.ifaces) {
        if (f.kind === 'loop' || f.ip == null || !d.ifaceUp(f)) continue;
        const en = enabled(d, f);
        if (en === false || en == null) continue;
        pts.push({ dev: d, f, area: en, key: pointKey(d, f), reach: null });
      }
    }
    for (const p of pts) p.reach = reach(net, p.dev, p.f);
    const edges = [];
    for (const a of pts) {
      for (const b of pts) {
        if (a === b || a.dev === b.dev) continue;
        if (a.f.mask !== b.f.mask || !U.sameNet(a.f.ip, b.f.ip, a.f.mask)) continue;
        if (a.area !== b.area) continue;
        if (!a.reach.has(b.key)) continue;
        if (isPassive(cfgOf(b.dev), b.f)) continue;
        if (!directional && isPassive(cfgOf(a.dev), a.f)) continue;
        edges.push({ from: a.dev, fIf: a.f, to: b.dev, tIf: b.f });
      }
    }
    return edges;
  }

  const classfulMask = (ip) => U.classfulMask(ip);
  const major = (ip) => U.net(ip, classfulMask(ip));

  function hasDefault(dev) {
    return (dev.routes || []).some((r) => r.mask === 0 && r.net === 0);
  }

  /** Префиксы, которые устройство вносит в протокол proto редистрибуцией (из таблиц предыдущего шага). */
  function redistributed(dev, proto, prev) {
    const cfg = dev.redist && dev.redist[proto];
    if (!cfg || !cfg.length) return [];
    const out = [];
    const table = prev.get(dev) || [];
    for (const r of cfg) {
      let list = [];
      if (r.src === 'connected') {
        for (const f of dev.ifaces) if (f.ip != null && dev.ifaceUp(f)) list.push({ net: U.net(f.ip, f.mask), mask: f.mask });
      } else if (r.src === 'static') {
        for (const s of dev.routes || []) {
          if (s.mask === 0 && proto === 'ospf') continue; // в OSPF маршрут по умолчанию — только default-information originate
          list.push({ net: s.net, mask: s.mask });
        }
      } else {
        const t = { rip: 'R', ospf: 'O', eigrp: 'D', bgp: 'B' }[r.src];
        list = table.filter((x) => x.type === t && (r.src !== 'eigrp' || x.asn == null || r.id == null || x.asn === r.id) && x.ad !== 5).map((x) => ({ net: x.net, mask: x.mask }));
        const on = { rip: (f) => dev.rip && dev.rip.networks.length && ripEnabled(dev, f), ospf: (f) => dev.ospf && ospfArea(dev, f) != null, eigrp: (f) => eigrpEnabled(dev, f) }[r.src];
        if (on) {
          for (const f of dev.ifaces) {
            if (f.ip == null || !dev.ifaceUp(f) || !on(f)) continue;
            const x = { net: U.net(f.ip, f.mask), mask: f.mask };
            if (!list.some((y) => y.net === x.net && y.mask === x.mask)) list.push(x);
          }
        }
      }
      for (const x of list) {
        if (proto === 'ospf' && !r.subnets && x.mask !== classfulMask(x.net) && x.mask !== 0) continue;
        out.push(Object.assign({}, x, { rule: r }));
      }
    }
    return out;
  }

  /* ---------- RIP ---------- */

  function computeRip(net, devs, prev) {
    const rdevs = devs.filter((d) => d.rip && d.rip.networks.length);
    const edges = adjacencies(net, rdevs, (d, f) => (ripEnabled(d, f) ? 'rip' : null), (d) => d.rip, true);
    const out = new Map(rdevs.map((d) => [d, []]));
    const origin = new Map();
    for (const X of rdevs) {
      const nets = [];
      for (const f of X.ifaces) if (ripEnabled(X, f) && f.ip != null && X.ifaceUp(f)) nets.push({ net: U.net(f.ip, f.mask), mask: f.mask, metric: 0 });
      if (X.rip.defaultOriginate || (X.rip.defaultOriginateIfRoute && hasDefault(X))) nets.push({ net: 0, mask: 0, def: true, metric: 0 });
      for (const x of redistributed(X, 'rip', prev)) {
        const m = x.rule.metric != null ? x.rule.metric : X.redistDefaults && X.redistDefaults.rip != null ? X.redistDefaults.rip : x.rule.src === 'static' || x.rule.src === 'connected' ? 0 : null;
        if (m == null || m >= 16) continue;
        nets.push({ net: x.net, mask: x.mask, metric: m, ext: true });
      }
      origin.set(X, nets);
    }
    for (const R of rdevs) {
      const dist = new Map([[R, 0]]);
      const first = new Map();
      const q = [R];
      while (q.length) {
        const u = q.shift();
        for (const e of edges) {
          if (e.from !== u || dist.has(e.to)) continue;
          dist.set(e.to, dist.get(u) + 1);
          first.set(e.to, u === R ? { ifc: e.fIf, nh: e.tIf.ip } : first.get(u));
          q.push(e.to);
        }
      }
      const best = new Map();
      for (const [X, dx] of dist) {
        if (X === R) continue;
        const hop = first.get(X);
        for (const n of origin.get(X)) {
          const metric = dx + n.metric;
          if (metric > 15) continue;
          if (R.ifaces.some((f) => f.ip != null && R.ifaceUp(f) && f.mask === n.mask && U.net(f.ip, f.mask) === n.net)) continue;
          const key = n.net + '/' + n.mask;
          const cur = best.get(key);
          if (!cur || metric < cur.metric) best.set(key, { type: 'R', sub: n.def ? '*' : '', ad: 120, metric, net: n.net, mask: n.mask, nextHop: hop.nh, ifc: hop.ifc });
        }
      }
      out.set(R, [...best.values()]);
    }
    return out;
  }

  /* ---------- OSPF ---------- */

  function computeOspf(net, devs, prev) {
    const odevs = devs.filter((d) => d.ospf && d.ospf.networks.length);
    const edges = adjacencies(net, odevs, (d, f) => ospfArea(d, f), (d) => d.ospf, false);
    const out = new Map(odevs.map((d) => [d, []]));
    for (const d of odevs) {
      d.ospfRouterId = routerId(d);
      const mine = edges.filter((e) => e.from === d);
      d.ospfNeighbors = mine.map((e) => {
        const seg = edges.filter((x) => x.from === e.from && x.fIf === e.fIf).map((x) => x.to).concat([d]);
        const ids = seg.map((x) => routerId(x)).sort((a, b) => b - a);
        const rid = routerId(e.to);
        const p2p = seg.length === 2 && d.isSerial && d.isSerial(e.fIf);
        const role = p2p ? '-' : rid === ids[0] ? 'DR' : rid === ids[1] ? 'BDR' : 'DROTHER';
        return { id: rid, address: e.tIf.ip, ifname: e.fIf.name, state: 'FULL/' + role, area: ospfArea(d, e.fIf) };
      });
    }
    const areasOf = (X) => new Set(X.ifaces.map((f) => (f.kind === 'loop' ? (X.ospf.networks.find((n) => f.ip != null && U.matchWild(f.ip, n.net, n.wc)) || {}).area : ospfArea(X, f))).filter((a) => a != null));
    const ranges = [];
    for (const d of odevs) for (const g of d.ospfRanges || []) if ([...areasOf(d)].some((a) => String(a) === String(g.area))) ranges.push(g);
    for (const R of odevs) {
      const dist = new Map([[R, 0]]);
      const first = new Map();
      const done = new Set();
      for (;;) {
        let u = null;
        for (const [n, dv] of dist) if (!done.has(n) && (u === null || dv < dist.get(u))) u = n;
        if (!u) break;
        done.add(u);
        for (const e of edges) {
          if (e.from !== u) continue;
          const c = dist.get(u) + ifaceCost(u, e.fIf);
          if (!dist.has(e.to) || c < dist.get(e.to)) {
            dist.set(e.to, c);
            first.set(e.to, u === R ? { ifc: e.fIf, nh: e.tIf.ip } : first.get(u));
          }
        }
      }
      const myAreas = areasOf(R);
      const best = new Map();
      const put = (key, r) => { const cur = best.get(key); if (!cur || r.metric < cur.metric || (r.rank || 0) < (cur.rank || 0)) best.set(key, r); };
      for (const [X, dx] of dist) {
        if (X === R) continue;
        const hop = first.get(X);
        for (const f of X.ifaces) {
          if (f.ip == null || !X.ifaceUp(f)) continue;
          const area = f.kind === 'loop' ? (X.ospf.networks.find((n) => U.matchWild(f.ip, n.net, n.wc)) || {}).area : ospfArea(X, f);
          if (area == null) continue;
          let mask = f.kind === 'loop' ? 0xFFFFFFFF : f.mask;
          let n = U.net(f.ip, mask);
          const inter = !myAreas.has(area);
          // суммаризация на ABR: маршруты области заменяются диапазоном для других областей
          if (inter) {
            const rg = ranges.find((g) => String(g.area) === String(area) && U.sameNet(n, g.net, g.mask) && U.prefixFromMask(g.mask) <= U.prefixFromMask(mask));
            if (rg) { n = rg.net; mask = rg.mask; }
          }
          if (R.ifaces.some((g) => g.ip != null && R.ifaceUp(g) && g.mask === mask && U.net(g.ip, g.mask) === n)) continue;
          put(n + '/' + mask, { type: 'O', sub: inter ? 'IA' : '', rank: inter ? 1 : 0, ad: 110, metric: dx + ifaceCost(X, f), net: n, mask, nextHop: hop.nh, ifc: hop.ifc });
        }
        if (X.ospf.defaultOriginate && (X.ospf.defaultAlways || hasDefault(X))) {
          const cur = best.get('0/0');
          if (!cur || dx < cur.pathCost) best.set('0/0', { type: 'O', sub: '*E2', ad: 110, metric: 1, pathCost: dx, rank: 2, net: 0, mask: 0, nextHop: hop.nh, ifc: hop.ifc });
        }
        for (const x of redistributed(X, 'ospf', prev)) {
          if (R.ifaces.some((g) => g.ip != null && R.ifaceUp(g) && g.mask === x.mask && U.net(g.ip, g.mask) === x.net)) continue;
          const seed = x.rule.metric != null ? x.rule.metric : X.redistDefaults && X.redistDefaults.ospf != null ? X.redistDefaults.ospf : x.rule.src === 'bgp' ? 1 : 20;
          const key = x.net + '/' + x.mask;
          const cur = best.get(key);
          if (cur && (cur.rank || 0) < 2) continue;
          if (!cur || dx < cur.pathCost) best.set(key, { type: 'O', sub: x.rule.metricType === 1 ? 'E1' : 'E2', ad: 110, metric: x.rule.metricType === 1 ? seed + dx : seed, pathCost: dx, rank: 2, net: x.net, mask: x.mask, nextHop: hop.nh, ifc: hop.ifc });
        }
      }
      out.set(R, [...best.values()]);
    }
    return out;
  }

  /* ---------- EIGRP ---------- */

  const NULL0 = { name: 'Null0', kind: 'null', port: -1, ip: null, mask: null, adminUp: true, p2p: true, runtime: true };
  IpNode.ifaceUpHooks.null = () => true;
  IpNode.ifaceSenders.null = function (f, pkt) {
    this.note('Маршрут в Null0 (суммарный маршрут): пакет для ' + U.ipStr(pkt.dst) + ' отброшен — точного маршрута нет', null, 'drop');
    return true;
  };

  /** Пропускная способность (кбит/с) и задержка (десятки мкс) интерфейса, как в IOS. */
  function ifBw(d, f) {
    if (f.bwKbps) return f.bwKbps;
    if (f.kind === 'loop') return 8000000;
    if (f.kind === 'tunnel') return 100;
    if (f.kind === 'svi') return 1000000;
    const p = d.ports[f.port];
    if (!p) return 100000;
    return Math.max(1, Math.round((NS.portSpeed ? NS.portSpeed(p) : p.speed) * 1000));
  }
  function ifDelay(d, f) {
    if (f.delay != null) return f.delay;
    if (f.kind === 'loop') return 500;
    if (f.kind === 'tunnel') return 50000;
    if (f.kind === 'svi') return 1;
    const p = d.ports[f.port];
    if (!p) return 10;
    if (p.media === 'serial') return 2000;
    const s = NS.portSpeed ? NS.portSpeed(p) : p.speed;
    return s >= 1000 ? 1 : s >= 100 ? 10 : 100;
  }
  const composite = (m) => (m ? 256 * (Math.floor(1e7 / m.bw) + m.delay) : Infinity);

  function eigrpEnabled(d, f) {
    const c = d.eigrp;
    if (!c || f.ip == null) return false;
    return c.networks.some((n) => (n.wc != null ? U.matchWild(f.ip, n.net, n.wc) : major(f.ip) === major(n.net)));
  }

  /** Суммарные маршруты, которые устройство объявляет через интерфейс j (ручные и авто). */
  function summariesOn(d, j, known) {
    const out = [];
    for (const s of j.eigrpSum || []) if (s.asn === d.eigrp.asn) out.push({ net: s.net, mask: s.mask });
    if (d.eigrp.autoSummary && j.ip != null) {
      const seen = new Set();
      for (const k of known) {
        const m = major(k.net);
        const cm = classfulMask(k.net);
        if (k.mask <= cm && k.net === m) continue;
        if (m === major(j.ip) || seen.has(m)) continue;
        seen.add(m);
        out.push({ net: m, mask: cm, auto: true });
      }
    }
    return out;
  }

  function computeEigrp(net, devs, prev) {
    const out = new Map();
    const byAs = new Map();
    for (const d of devs) if (d.eigrp && d.eigrp.networks.length) { if (!byAs.has(d.eigrp.asn)) byAs.set(d.eigrp.asn, []); byAs.get(d.eigrp.asn).push(d); }
    for (const [asn, edevs] of byAs) {
      const edges = adjacencies(net, edevs, (d, f) => (eigrpEnabled(d, f) ? 'as' + asn : null), (d) => d.eigrp, false);
      for (const d of edevs) {
        d.eigrpNeighbors = edges.filter((e) => e.from === d).map((e) => ({ address: e.tIf.ip, ifname: e.fIf.name, dev: e.to }));
        out.set(d, []);
        d.eigrpTopo = [];
      }
      // пункты назначения: подключённые сети и внешние (редистрибуция)
      const dests = new Map();
      const addDest = (X, net0, mask, m, ext) => {
        const key = net0 + '/' + mask;
        if (!dests.has(key)) dests.set(key, { net: net0, mask, origin: new Map(), ext: false });
        const dd = dests.get(key);
        const cur = dd.origin.get(X);
        if (!cur || composite(m) < composite(cur.m)) dd.origin.set(X, { m, ext });
        if (ext) dd.ext = true;
      };
      for (const X of edevs) {
        for (const f of X.ifaces) {
          if (!eigrpEnabled(X, f) || !X.ifaceUp(f)) continue;
          const mask = f.kind === 'loop' ? f.mask : f.mask;
          addDest(X, U.net(f.ip, mask), mask, { bw: ifBw(X, f), delay: ifDelay(X, f) }, false);
        }
        for (const x of redistributed(X, 'eigrp', prev)) {
          const dm = x.rule.metricVec || (X.redistDefaults && X.redistDefaults.eigrp) || null;
          let m = null;
          if (dm) m = { bw: dm.bw, delay: Math.max(1, Math.round(dm.delay)) };
          else if (x.rule.src === 'static' || x.rule.src === 'connected') {
            const f = X.ifaces.find((g) => g.ip != null && X.ifaceUp(g) && U.sameNet(g.ip, x.net, g.mask)) || X.ifaces.find((g) => g.ip != null && X.ifaceUp(g));
            m = f ? { bw: ifBw(X, f), delay: ifDelay(X, f) } : null;
          }
          if (m) addDest(X, x.net, x.mask, m, true);
        }
      }
      const best = new Map(); // key → Map(dev → m)
      const nameOf = (x) => x.net + '/' + x.mask;
      const runDest = (key, dd, originOf) => {
        const b = new Map();
        for (const [X, o] of originOf) b.set(X, o.m);
        for (let it = 0; it < edevs.length + 2; it++) {
          let changed = false;
          for (const e of edges) {
            const R = e.from;
            const Nb = e.to;
            if (originOf.has(R)) continue;
            const mN = b.get(Nb);
            if (!mN || !allowed(Nb, e.tIf, dd)) continue;
            const cand = { bw: Math.min(mN.bw, ifBw(R, e.fIf)), delay: mN.delay + ifDelay(R, e.fIf) };
            if (composite(cand) < composite(b.get(R))) { b.set(R, cand); changed = true; }
          }
          if (!changed) break;
        }
        best.set(key, b);
        return b;
      };
      // объявление через интерфейс j соседом Nb: не отдаём подсеть, если она попадает в суммарный маршрут на j
      const knownAt = new Map();
      const allowed = (Nb, j, dd) => {
        const sums = summariesOn(Nb, j, knownAt.get(Nb) || []);
        return !sums.some((s) => U.prefixFromMask(s.mask) < U.prefixFromMask(dd.mask) && U.sameNet(dd.net, s.net, s.mask));
      };
      // сначала без суммаризации — чтобы знать, какие сети известны каждому маршрутизатору
      for (const [key, dd] of dests) {
        const b = runDest(key, dd, dd.origin);
        for (const [X] of b) { if (!knownAt.has(X)) knownAt.set(X, []); knownAt.get(X).push({ net: dd.net, mask: dd.mask }); }
      }
      for (const [key, dd] of dests) runDest(key, dd, dd.origin);
      // суммарные маршруты: появляются у соседей через интерфейс с суммаризацией
      const sumDests = new Map();
      for (const X of edevs) {
        for (const j of X.ifaces) {
          if (!eigrpEnabled(X, j) || !X.ifaceUp(j)) continue;
          for (const s of summariesOn(X, j, knownAt.get(X) || [])) {
            let m = null;
            for (const [key, dd] of dests) {
              if (!(U.prefixFromMask(s.mask) < U.prefixFromMask(dd.mask) && U.sameNet(dd.net, s.net, s.mask))) continue;
              const mm = (best.get(key) || new Map()).get(X);
              if (mm && composite(mm) < composite(m)) m = mm;
            }
            if (!m) continue;
            const key = s.net + '/' + s.mask;
            if (!sumDests.has(key)) sumDests.set(key, { net: s.net, mask: s.mask, origin: new Map(), sumAt: new Map(), ext: false });
            const sd = sumDests.get(key);
            if (!sd.origin.has(X) || composite(m) < composite(sd.origin.get(X).m)) sd.origin.set(X, { m, ext: false });
            if (!sd.sumAt.has(X)) sd.sumAt.set(X, new Set());
            sd.sumAt.get(X).add(j);
            // маршрут в Null0 у того, кто суммирует
            out.get(X).push({ type: 'D', sub: '', ad: 5, metric: composite(m), net: s.net, mask: s.mask, nextHop: null, ifc: NULL0, asn, summary: true });
          }
        }
      }
      for (const [key, sd] of sumDests) {
        // суммарный маршрут объявляется только через интерфейс с суммаризацией
        const b = new Map();
        for (const [X, o] of sd.origin) b.set(X, o.m);
        for (let it = 0; it < edevs.length + 2; it++) {
          let changed = false;
          for (const e of edges) {
            const R = e.from;
            const Nb = e.to;
            if (sd.origin.has(R)) continue;
            const mN = b.get(Nb);
            if (!mN) continue;
            if (sd.origin.has(Nb) && !(sd.sumAt.get(Nb) || new Set()).has(e.tIf)) continue;
            const cand = { bw: Math.min(mN.bw, ifBw(R, e.fIf)), delay: mN.delay + ifDelay(R, e.fIf) };
            if (composite(cand) < composite(b.get(R))) { b.set(R, cand); changed = true; }
          }
          if (!changed) break;
        }
        best.set(key, b);
        dests.set(key, { net: sd.net, mask: sd.mask, origin: sd.origin, ext: false, summary: true, sumAt: sd.sumAt });
      }
      // DUAL: successor, feasible successor, variance
      for (const R of edevs) {
        for (const [key, dd] of dests) {
          if (dd.origin.has(R)) continue;
          const b = best.get(key);
          const fdM = b && b.get(R);
          if (!fdM) continue;
          const FD = composite(fdM);
          const via = [];
          for (const e of edges) {
            if (e.from !== R) continue;
            const mN = b.get(e.to);
            if (!mN) continue;
            if (dd.summary) { if (dd.origin.has(e.to) && !(dd.sumAt.get(e.to) || new Set()).has(e.tIf)) continue; } else if (!allowed(e.to, e.tIf, dd)) continue;
            const m = { bw: Math.min(mN.bw, ifBw(R, e.fIf)), delay: mN.delay + ifDelay(R, e.fIf) };
            via.push({ e, metric: composite(m), rd: composite(mN) });
          }
          if (!via.length) continue;
          const variance = R.eigrp.variance || 1;
          const succ = via.filter((v) => v.metric === FD);
          const fs = via.filter((v) => v.metric !== FD && v.rd < FD);
          const used = succ.concat(fs.filter((v) => v.metric <= FD * variance)).slice(0, 4);
          if (R.ifaces.some((g) => g.ip != null && R.ifaceUp(g) && g.mask === dd.mask && U.net(g.ip, g.mask) === dd.net)) continue;
          for (const v of used) out.get(R).push({ type: 'D', sub: dd.ext && ![...dd.origin.values()].some((o) => !o.ext) ? 'EX' : '', ad: dd.ext && ![...dd.origin.values()].some((o) => !o.ext) ? 170 : 90, metric: v.metric, net: dd.net, mask: dd.mask, nextHop: v.e.tIf.ip, ifc: v.e.fIf, asn });
          R.eigrpTopo.push({ net: dd.net, mask: dd.mask, fd: FD, succ: succ.map((v) => ({ nh: v.e.tIf.ip, ifname: v.e.fIf.name, metric: v.metric, rd: v.rd })), fs: fs.map((v) => ({ nh: v.e.tIf.ip, ifname: v.e.fIf.name, metric: v.metric, rd: v.rd })), ext: dd.ext });
        }
        // свои сети — тоже в таблице топологии (FD по интерфейсу)
        for (const [, dd] of dests) {
          const o = dd.origin.get(R);
          if (o && !dd.summary) R.eigrpTopo.push({ net: dd.net, mask: dd.mask, fd: composite(o.m), succ: [], fs: [], connected: !o.ext, ext: o.ext });
        }
        R.eigrpTopo.sort((a, b) => a.net - b.net || b.mask - a.mask);
      }
    }
    return out;
  }

  /* ---------- BGP ---------- */

  function bgpSrc(R, n) {
    if (n.updateSource) {
      const f = R.ifaceByName(n.updateSource);
      return f && f.ip != null && R.ifaceUp(f) ? f.ip : null;
    }
    const r = R.lookup(n.ip);
    return r && r.ifc && r.ifc.ip != null ? r.ifc.ip : null;
  }

  function computeBgp(net, devs, igp) {
    const bdevs = devs.filter((d) => d.bgp && d.bgp.asn);
    const out = new Map(bdevs.map((d) => [d, []]));
    // сеансы
    const sessions = [];
    for (const R of bdevs) {
      R.bgpPeers = [];
      for (const n of R.bgp.neighbors) {
        const st = { n, state: 'Idle', peer: null, src: null, ebgp: n.remoteAs !== R.bgp.asn, text: '' };
        R.bgpPeers.push(st);
        if (n.shutdown) { st.state = 'Idle (Admin)'; continue; }
        const P = bdevs.find((d) => d !== R && d.power && d.hasIp(n.ip));
        const src = bgpSrc(R, n);
        st.src = src;
        if (!R.lookup(n.ip) || src == null) { st.state = 'Active'; st.text = 'нет маршрута до соседа'; continue; }
        if (!P) { st.state = 'Active'; st.text = 'на ' + U.ipStr(n.ip) + ' не запущен BGP'; continue; }
        const back = P.bgp.neighbors.find((x) => x.ip === src);
        if (!back) { st.state = 'Active'; st.text = 'у соседа нет neighbor ' + U.ipStr(src); continue; }
        if (n.remoteAs !== P.bgp.asn || back.remoteAs !== R.bgp.asn) { st.state = 'Idle'; st.text = 'неверный remote-as (у соседа AS ' + P.bgp.asn + ')'; continue; }
        if (back.shutdown) { st.state = 'Active'; continue; }
        if (!P.lookup(src)) { st.state = 'Active'; st.text = 'у соседа нет маршрута обратно'; continue; }
        if (st.ebgp && !n.multihop && !R.ifaces.some((f) => f.ip != null && R.ifaceUp(f) && U.sameNet(f.ip, n.ip, f.mask))) { st.state = 'Idle'; st.text = 'eBGP-сосед не на прямом канале (нужен ebgp-multihop)'; continue; }
        st.state = 'Established';
        st.peer = P;
        sessions.push({ R, P, st, n });
      }
    }
    // пути: собственные сети и редистрибуция
    const tables = new Map();
    for (const R of bdevs) {
      const t = new Map();
      for (const nw of R.bgp.networks) {
        const has = R.ifaces.some((f) => f.ip != null && R.ifaceUp(f) && U.net(f.ip, f.mask) === nw.net && f.mask === nw.mask) ||
          (R.routes || []).some((s) => s.net === nw.net && s.mask === nw.mask) || (R.dynRoutes || []).some((d) => d.net === nw.net && d.mask === nw.mask);
        if (!has) continue;
        t.set(nw.net + '/' + nw.mask, [{ net: nw.net, mask: nw.mask, nh: 0, asPath: [], origin: 'i', local: true, from: null, ebgp: false, metric: 0 }]);
      }
      // redistribute … в BGP: происхождение «?» (incomplete)
      for (const x of redistributed(R, 'bgp', igp || new Map())) {
        const key = x.net + '/' + x.mask;
        if (!t.has(key)) t.set(key, [{ net: x.net, mask: x.mask, nh: 0, asPath: [], origin: '?', local: true, from: null, ebgp: false, metric: x.rule.metric || 0 }]);
      }
      tables.set(R, t);
    }
    const bestOf = (list) => {
      if (!list || !list.length) return null;
      return list.slice().sort((a, b) => (b.local ? 1 : 0) - (a.local ? 1 : 0) || a.asPath.length - b.asPath.length ||
        'ie?'.indexOf(a.origin) - 'ie?'.indexOf(b.origin) || (b.ebgp ? 1 : 0) - (a.ebgp ? 1 : 0) || (a.fromId || 0) - (b.fromId || 0))[0];
    };
    for (let round = 0; round < 12; round++) {
      let changed = false;
      for (const s of sessions) {
        // P объявляет свои лучшие пути R
        const { R, P } = s;
        const back = P.bgpPeers.find((x) => x.peer === R && x.state === 'Established');
        if (!back) continue;
        const ebgp = R.bgp.asn !== P.bgp.asn;
        for (const [key, list] of tables.get(P)) {
          const b = bestOf(list);
          if (!b) continue;
          if (b.from === R) continue;
          if (!ebgp && !b.local && !b.ebgp) continue; // iBGP не пересылает пути, полученные по iBGP
          const asPath = ebgp ? [P.bgp.asn].concat(b.asPath) : b.asPath.slice();
          if (asPath.includes(R.bgp.asn)) continue;
          const nh = ebgp || back.n.nextHopSelf || b.local ? back.src : b.nh;
          const path = { net: b.net, mask: b.mask, nh, asPath, origin: b.origin, local: false, from: P, fromId: routerIdOf(P), ebgp, metric: ebgp ? 0 : b.metric };
          const t = tables.get(R);
          const cur = t.get(key) || [];
          const idx = cur.findIndex((x) => x.from === P);
          const sig = JSON.stringify([path.nh, path.asPath, path.origin]);
          if (idx >= 0 && JSON.stringify([cur[idx].nh, cur[idx].asPath, cur[idx].origin]) === sig) continue;
          if (idx >= 0) cur[idx] = path; else cur.push(path);
          t.set(key, cur);
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const R of bdevs) {
      R.bgpTable = tables.get(R);
      for (const [, list] of R.bgpTable) {
        const b = bestOf(list);
        for (const p of list) p.best = p === b;
        if (!b || b.local) continue;
        // следующий переход — через IGP
        const via = R.lookup(b.nh);
        if (!via || via.type === 'B') { b.inaccessible = true; continue; }
        out.get(R).push({ type: 'B', sub: '', ad: b.ebgp ? 20 : 200, metric: 0, net: b.net, mask: b.mask, nextHop: via.nextHop != null ? via.nextHop : b.nh, bgpNh: b.nh, ifc: via.ifc });
      }
    }
    return out;
  }

  function routerIdOf(d) {
    if (d.bgp && d.bgp.routerId != null) return d.bgp.routerId;
    const loops = d.ifaces.filter((f) => f.kind === 'loop' && f.ip != null).map((f) => f.ip);
    if (loops.length) return Math.max(...loops);
    const ips = d.ifaces.filter((f) => f.ip != null && d.ifaceUp(f)).map((f) => f.ip);
    return ips.length ? Math.max(...ips) : 0;
  }

  /* ---------- общий расчёт ---------- */

  function isRouting(dev) {
    return dev.power && dev.forwarding && dev.ifaces && (dev.rip || dev.ospf || dev.eigrp || dev.bgp);
  }

  R0.compute = function (net) {
    const devs = [...net.devices.values()].filter((d) => d.ifaces);
    for (const d of devs) { d.dynRoutes = []; d.ospfNeighbors = []; d.eigrpNeighbors = []; d.eigrpTopo = []; d.bgpPeers = []; }
    const active = devs.filter(isRouting);
    if (!active.length) return;
    let prev = new Map();
    const hasRedist = active.some((d) => d.redist && Object.values(d.redist).some((l) => l && l.length));
    const rounds = hasRedist ? 4 : 1;
    let lastSig = '';
    for (let k = 0; k < rounds; k++) {
      const rip = computeRip(net, active, prev);
      const ospf = computeOspf(net, active, prev);
      const eigrp = computeEigrp(net, active, prev);
      const tables = new Map();
      for (const d of active) {
        const r = (rip.get(d) || []).concat(ospf.get(d) || [], eigrp.get(d) || []);
        d.dynRoutes = r;
        tables.set(d, r);
      }
      // BGP — поверх IGP
      if (active.some((d) => d.bgp)) {
        const bgp = computeBgp(net, active, tables);
        for (const d of active) { d.dynRoutes = d.dynRoutes.concat(bgp.get(d) || []); tables.set(d, d.dynRoutes); }
      }
      const sig = JSON.stringify(active.map((d) => d.dynRoutes.map((r) => [r.type, r.net, r.mask, r.metric, r.nextHop])));
      prev = tables;
      if (sig === lastSig) break;
      lastSig = sig;
    }
  };

  /* ---------- сохранение ---------- */

  NS.deviceExt.push({
    key: 'routing2',
    applies: (d) => d.type === 'router' || d.type === 'switch',
    save(d) {
      const o = {};
      const ip = U.ipStr;
      if (d.eigrp) o.eigrp = Object.assign({}, d.eigrp, { networks: d.eigrp.networks.map((n) => ({ net: ip(n.net), wc: n.wc == null ? null : ip(n.wc) })), routerId: d.eigrp.routerId == null ? null : ip(d.eigrp.routerId) });
      if (d.bgp) o.bgp = { asn: d.bgp.asn, routerId: d.bgp.routerId == null ? null : ip(d.bgp.routerId), neighbors: d.bgp.neighbors.map((n) => Object.assign({}, n, { ip: ip(n.ip) })), networks: d.bgp.networks.map((n) => ({ net: ip(n.net), mask: ip(n.mask) })) };
      if (d.redist && Object.values(d.redist).some((l) => l.length)) o.redist = JSON.parse(JSON.stringify(d.redist));
      if (d.redistDefaults && Object.keys(d.redistDefaults).length) o.redistDefaults = JSON.parse(JSON.stringify(d.redistDefaults));
      if (d.ospfRanges && d.ospfRanges.length) o.ospfRanges = d.ospfRanges.map((r) => ({ area: r.area, net: ip(r.net), mask: ip(r.mask) }));
      return Object.keys(o).length ? o : null;
    },
    load(d, c) {
      d.eigrp = null;
      d.bgp = null;
      d.redist = { rip: [], ospf: [], eigrp: [], bgp: [] };
      d.redistDefaults = {};
      d.ospfRanges = [];
      if (!c) return;
      const P4 = U.parseIp;
      if (c.eigrp) d.eigrp = Object.assign({ asn: 1, networks: [], passive: [], autoSummary: false, variance: 1, routerId: null }, c.eigrp, { networks: (c.eigrp.networks || []).map((n) => ({ net: P4(n.net), wc: n.wc ? P4(n.wc) : null })).filter((n) => n.net != null), routerId: c.eigrp.routerId ? P4(c.eigrp.routerId) : null, passive: (c.eigrp.passive || []).slice() });
      if (c.bgp) d.bgp = { asn: Number(c.bgp.asn), routerId: c.bgp.routerId ? P4(c.bgp.routerId) : null, neighbors: (c.bgp.neighbors || []).map((n) => Object.assign({}, n, { ip: P4(n.ip) })).filter((n) => n.ip != null), networks: (c.bgp.networks || []).map((n) => ({ net: P4(n.net), mask: P4(n.mask) })).filter((n) => n.net != null && n.mask != null) };
      if (c.redist) for (const k of Object.keys(d.redist)) d.redist[k] = (c.redist[k] || []).slice();
      if (c.redistDefaults) d.redistDefaults = c.redistDefaults;
      if (c.ospfRanges) d.ospfRanges = c.ospfRanges.map((r) => ({ area: r.area, net: P4(r.net), mask: P4(r.mask) })).filter((r) => r.net != null);
      d.net.markRouting();
    },
  });

  IpNode.ifaceExt.push({
    key: 'eigrpIf',
    save(f) {
      const o = {};
      if (f.eigrpSum && f.eigrpSum.length) o.sum = f.eigrpSum.map((s) => ({ asn: s.asn, net: U.ipStr(s.net), mask: U.ipStr(s.mask) }));
      if (f.delay != null) o.delay = f.delay;
      return Object.keys(o).length ? o : null;
    },
    load(f, d) {
      f.eigrpSum = d && d.sum ? d.sum.map((s) => ({ asn: Number(s.asn), net: U.parseIp(s.net), mask: U.parseIp(s.mask) })) : [];
      f.delay = d && d.delay != null ? Number(d.delay) : null;
    },
  });

  NS.routing2 = { composite, ifBw, ifDelay, computeEigrp, computeBgp, NULL0, redistributed, routerIdOf };
})(globalThis.NetLab = globalThis.NetLab || {});
