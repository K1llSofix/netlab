/* NetLab — динамическая маршрутизация RIP и OSPF.
 * Как и STP, протоколы «сходятся» мгновенно, но по настоящим правилам:
 *  • соседство образуется только между интерфейсами, которые реально видят друг друга на 2-м уровне
 *    (с учётом VLAN, транков, STP, концентраторов и Wi-Fi), в одной подсети, не passive, в одной области OSPF;
 *  • RIP — метрика в прыжках (до 15), OSPF — стоимость 100 Мбит/с ÷ пропускная способность;
 *  • loopback в OSPF объявляется как /32; default-information originate; DR/BDR для show ip ospf neighbor. */
(function (NS) {
  'use strict';

  const U = NS.util;

  function isRouting(dev) {
    return dev.power && dev.forwarding && dev.ifaces && (dev.rip || dev.ospf);
  }

  /* ---------- связность на 2-м уровне ---------- */

  function pointKey(dev, f) {
    if (f.kind === 'svi') return dev.id + '|svi|' + f.vlan;
    return dev.id + '|' + f.port + '|' + (f.kind === 'sub' ? f.vlan : 'u');
  }

  /** Все точки 3-го уровня, до которых доходит кадр, отправленный с интерфейса f устройства dev. */
  function reach(net, dev, f) {
    const seen = new Set();
    const points = new Set();
    const queue = [];

    const out = (d, port, tag, fromClient) => {
      const p = d.ports[port];
      if (!p || !p.oper || p.stp === 'blocking') return;
      if (p.radio) {
        for (const id of p.wlinks || []) {
          const l = net.links.get(id);
          if (l && l.b.dev !== fromClient) queue.push([l.b.dev, l.b.port, tag, null]);
        }
        return;
      }
      const pr = net.peer(d, port);
      if (pr) queue.push([pr.dev.id, pr.port, tag, d.id]);
    };

    const sviSpread = (sw, vlan, exceptPort) => {
      if (sw.ifaces && sw.ifaces.some((x) => x.kind === 'svi' && x.vlan === vlan && sw.ifaceUp(x))) points.add(sw.id + '|svi|' + vlan);
      sw.ports.forEach((q, j) => {
        if (j === exceptPort || !sw.portCarries || !sw.portCarries(q, vlan)) return;
        if (sw.stpBlocked && sw.stpBlocked(q, vlan)) return;
        const tag = q.mode === 'trunk' && vlan !== q.nativeVlan ? vlan : null;
        out(sw, j, tag, null);
      });
    };

    if (f.kind === 'svi') sviSpread(dev, f.vlan, -1);
    else out(dev, f.port, f.kind === 'sub' ? f.vlan : null, null);

    while (queue.length) {
      const [id, port, tag, fromDev] = queue.shift();
      const k = id + '|' + port + '|' + tag;
      if (seen.has(k)) continue;
      seen.add(k);
      const d = net.getDevice(id);
      if (!d || !d.power) continue;
      const p = d.ports[port];
      if (!p || !p.oper) continue;
      if (d.type === 'switch' || d.type === 'wrouter') {
        if (p.routed) { if (tag == null) points.add(id + '|' + port + '|u'); continue; }
        if (p.stp === 'blocking') continue;
        let vlan;
        if (p.radio) vlan = 1;
        else if (p.mode === 'trunk') {
          vlan = tag != null ? tag : p.nativeVlan;
          if (!U.vlanInList(p.allowed, vlan)) continue;
        } else {
          if (tag != null) continue;
          vlan = p.vlan;
        }
        if (d.vlans && !d.vlans.has(vlan)) continue;
        if (d.stpBlocked && d.stpBlocked(p, vlan)) continue;
        sviSpread(d, vlan, p.radio ? -1 : port);
        if (p.radio) {
          for (const wid of p.wlinks || []) {
            const l = net.links.get(wid);
            if (l && l.b.dev !== fromDev) queue.push([l.b.dev, l.b.port, null, null]);
          }
        }
      } else if (d.type === 'hub') {
        d.ports.forEach((q, j) => { if (j !== port) out(d, j, tag, null); });
      } else if (d.type === 'ap') {
        d.ports.forEach((q, j) => { if (j !== port || q.radio) out(d, j, tag, fromDev); });
      } else if (d.ifaces) {
        points.add(id + '|' + port + '|' + (tag == null ? 'u' : tag));
      }
    }
    return points;
  }

  /* ---------- общее ---------- */

  function ifaceCost(dev, f) {
    if (f.kind === 'loop') return 1;
    if (f.kind === 'svi') return 1;
    const p = dev.ports[f.port];
    const bw = p ? NS.portSpeed(p) : 100;
    return Math.max(1, Math.floor(100 / bw));
  }

  function hasDefault(dev) {
    return dev.staticRoutes().some((r) => r.mask === 0 && (r.ifName || dev.resolveNextHop(r.nextHop, 0)));
  }

  function routerId(dev) {
    if (dev.ospf && dev.ospf.routerId != null) return dev.ospf.routerId;
    const loops = dev.ifaces.filter((f) => f.kind === 'loop' && f.ip != null && f.adminUp).map((f) => f.ip);
    if (loops.length) return Math.max(...loops);
    const ips = dev.ifaces.filter((f) => f.ip != null && dev.ifaceUp(f)).map((f) => f.ip);
    return ips.length ? Math.max(...ips) : 0;
  }

  function ospfArea(dev, f) {
    if (!dev.ospf || f.ip == null || !dev.ifaceUp(f)) return null;
    for (const n of dev.ospf.networks) if (U.matchWild(f.ip, n.net, n.wc)) return n.area;
    return null;
  }

  function ripEnabled(dev, f) {
    if (!dev.rip || !dev.rip.networks.length || f.ip == null || !dev.ifaceUp(f)) return false;
    const cls = U.net(f.ip, U.classfulMask(f.ip));
    return dev.rip.networks.includes(cls);
  }

  function isPassive(cfg, f) { return !!cfg && (cfg.passive || []).some((n) => n.toLowerCase() === f.name.toLowerCase()); }

  /** Пары соседних интерфейсов для протокола. enabled(dev, f) → true/area; sameArea — проверять область. */
  function adjacencies(net, devs, enabled, cfgOf, directional) {
    const pts = [];
    for (const d of devs) {
      for (const f of d.ifaces) {
        if (f.kind === 'loop') continue;
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
        // a учится у b: b должен рассылать обновления через свой интерфейс (не passive)
        if (isPassive(cfgOf(b.dev), b.f)) continue;
        if (!directional && isPassive(cfgOf(a.dev), a.f)) continue;
        edges.push({ from: a.dev, fIf: a.f, to: b.dev, tIf: b.f });
      }
    }
    return edges;
  }

  /* ---------- RIP ---------- */

  function computeRip(net, devs) {
    const rdevs = devs.filter((d) => d.rip && d.rip.networks.length);
    const edges = adjacencies(net, rdevs, (d, f) => (ripEnabled(d, f) ? 'rip' : null), (d) => d.rip, true);
    const out = new Map(rdevs.map((d) => [d, []]));
    for (const R of rdevs) {
      // BFS: R учится у соседей, те — у своих соседей
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
        if (X === R || dx > 15) continue;
        const hop = first.get(X);
        const nets = [];
        for (const f of X.ifaces) {
          if (!ripEnabled(X, f)) continue;
          nets.push({ net: U.net(f.ip, f.mask), mask: f.mask });
        }
        if (X.rip.defaultOriginate || (X.rip.defaultOriginateIfRoute && hasDefault(X))) nets.push({ net: 0, mask: 0, def: true });
        for (const n of nets) {
          if (R.ifaces.some((f) => f.ip != null && R.ifaceUp(f) && f.mask === n.mask && U.net(f.ip, f.mask) === n.net)) continue;
          const key = n.net + '/' + n.mask;
          const cur = best.get(key);
          if (!cur || dx < cur.metric) best.set(key, { type: 'R', sub: n.def ? '*' : '', ad: 120, metric: dx, net: n.net, mask: n.mask, nextHop: hop.nh, ifc: hop.ifc });
        }
      }
      out.set(R, [...best.values()]);
    }
    return out;
  }

  /* ---------- OSPF ---------- */

  function computeOspf(net, devs) {
    const odevs = devs.filter((d) => d.ospf && d.ospf.networks.length);
    const edges = adjacencies(net, odevs, (d, f) => ospfArea(d, f), (d) => d.ospf, false);
    const out = new Map(odevs.map((d) => [d, []]));
    for (const d of odevs) {
      d.ospfRouterId = routerId(d);
      // Соседи и роли DR/BDR на сегменте (для show ip ospf neighbor)
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
      const best = new Map();
      for (const [X, dx] of dist) {
        if (X === R) continue;
        const hop = first.get(X);
        for (const f of X.ifaces) {
          if (f.ip == null || !X.ifaceUp(f)) continue;
          const area = f.kind === 'loop' ? (X.ospf.networks.find((n) => U.matchWild(f.ip, n.net, n.wc)) || {}).area : ospfArea(X, f);
          if (area == null) continue;
          const mask = f.kind === 'loop' ? 0xFFFFFFFF : f.mask;
          const n = U.net(f.ip, mask);
          if (R.ifaces.some((g) => g.ip != null && R.ifaceUp(g) && g.mask === mask && U.net(g.ip, g.mask) === n)) continue;
          const cost = dx + ifaceCost(X, f);
          const key = n + '/' + mask;
          const cur = best.get(key);
          if (!cur || cost < cur.metric) best.set(key, { type: 'O', sub: '', ad: 110, metric: cost, net: n, mask, nextHop: hop.nh, ifc: hop.ifc });
        }
        if (X.ospf.defaultOriginate && (X.ospf.defaultAlways || hasDefault(X))) {
          const cur = best.get('0/0');
          if (!cur || dx < cur.pathCost) best.set('0/0', { type: 'O', sub: '*E2', ad: 110, metric: 1, pathCost: dx, net: 0, mask: 0, nextHop: hop.nh, ifc: hop.ifc });
        }
      }
      out.set(R, [...best.values()]);
    }
    return out;
  }

  NS.routing = {
    reach,
    ifaceCost,
    routerId,
    ospfArea,
    ripEnabled,

    compute(net) {
      const devs = [...net.devices.values()].filter((d) => d.ifaces);
      for (const d of devs) { d.dynRoutes = []; d.ospfNeighbors = []; }
      const active = devs.filter(isRouting);
      if (!active.length) return;
      const rip = computeRip(net, active);
      const ospf = computeOspf(net, active);
      for (const d of active) {
        const r = (rip.get(d) || []).concat(ospf.get(d) || []);
        d.dynRoutes = r;
      }
    },
  };
})(globalThis.NetLab = globalThis.NetLab || {});
