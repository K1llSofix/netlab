/* NetLab — Spanning Tree (802.1D), вычисляемый мгновенно по графу топологии.
 * Результат совпадает с тем, к чему сходится настоящий STP (корневой мост, root/designated/
 * alternate порты), но без 30–50 секунд ожидания, которые путают новичков. */
(function (NS) {
  'use strict';

  function portCost(b, i) {
    const s = NS.portSpeed ? NS.portSpeed(b.ports[i]) : b.ports[i].speed || 100;
    if (s >= 1000) return 4;
    if (s >= 100) return 19;
    return 100;
  }

  function cmpBid(a, b) {
    if (a.stpPriority !== b.stpPriority) return a.stpPriority - b.stpPriority;
    return a.baseMac < b.baseMac ? -1 : a.baseMac > b.baseMac ? 1 : 0;
  }

  NS.stp = {
    portCost,
    cmpBid,

    /** Пересчитать роли портов всех коммутаторов. Возвращает true, если изменилась блокировка. */
    compute(net) {
      const sw = [];
      for (const d of net.devices.values()) if (d.type === 'switch') sw.push(d);

      const prev = new Map();
      for (const b of sw) {
        b.ports.forEach((p, i) => {
          prev.set(b.id + ':' + i, p.stp === 'blocking');
          p.stp = null;
          p.stpRole = null;
        });
        b.stpInfo = null;
      }

      // Концентраторы, соединённые между собой, образуют один общий сегмент.
      const parent = new Map();
      const find = (x) => {
        while (parent.get(x) !== x) {
          parent.set(x, parent.get(parent.get(x)));
          x = parent.get(x);
        }
        return x;
      };
      for (const d of net.devices.values()) if (d.type === 'hub' && d.power) parent.set(d.id, d.id);
      for (const l of net.links.values()) {
        if (parent.has(l.a.dev) && parent.has(l.b.dev)) {
          const a = net.devices.get(l.a.dev);
          if (net.isPortOperational(a, l.a.port)) parent.set(find(l.a.dev), find(l.b.dev));
        }
      }

      const segs = new Map();
      const bports = new Map();
      for (const b of sw) {
        if (!b.power) continue;
        const list = [];
        bports.set(b.id, list);
        b.ports.forEach((p, i) => {
          if (p.routed || p.radio || !net.isPortOperational(b, i)) return;
          const pr = net.peer(b, i);
          if (!pr) return;
          let seg;
          if (pr.dev.type === 'switch') seg = 'L' + pr.link.id;
          else if (parent.has(pr.dev.id)) seg = 'H' + find(pr.dev.id);
          else seg = 'E' + b.id + ':' + i;
          if (!segs.has(seg)) segs.set(seg, []);
          segs.get(seg).push({ b, i });
          list.push({ i, seg });
        });
      }

      const visited = new Set();
      for (const start of sw) {
        if (!start.power || visited.has(start.id)) continue;
        const comp = [];
        const stack = [start];
        visited.add(start.id);
        while (stack.length) {
          const u = stack.pop();
          comp.push(u);
          for (const { seg } of bports.get(u.id)) {
            for (const { b } of segs.get(seg)) {
              if (!visited.has(b.id)) { visited.add(b.id); stack.push(b); }
            }
          }
        }

        let root = comp[0];
        for (const b of comp) if (cmpBid(b, root) < 0) root = b;

        // Дейкстра: стоимость пути до корня.
        const dist = new Map(comp.map((b) => [b.id, Infinity]));
        dist.set(root.id, 0);
        const done = new Set();
        for (;;) {
          let u = null;
          for (const b of comp) {
            if (done.has(b.id) || dist.get(b.id) === Infinity) continue;
            if (!u || dist.get(b.id) < dist.get(u.id) || (dist.get(b.id) === dist.get(u.id) && cmpBid(b, u) < 0)) u = b;
          }
          if (!u) break;
          done.add(u.id);
          for (const { seg } of bports.get(u.id)) {
            for (const { b: v, i: j } of segs.get(seg)) {
              if (v === u) continue;
              const c = dist.get(u.id) + portCost(v, j);
              if (c < dist.get(v.id)) dist.set(v.id, c);
            }
          }
        }

        // Назначенный порт каждого сегмента.
        const better = (b, i, c, j) => {
          const db = dist.get(b.id);
          const dc = dist.get(c.id);
          if (db !== dc) return db < dc;
          const r = cmpBid(b, c);
          if (r !== 0) return r < 0;
          return i < j;
        };
        const desig = new Map();
        for (const b of comp) {
          for (const { i, seg } of bports.get(b.id)) {
            const cur = desig.get(seg);
            if (!cur || better(b, i, cur.b, cur.i)) desig.set(seg, { b, i });
          }
        }

        for (const b of comp) {
          let rp = -1;
          let rk = null;
          if (b !== root) {
            for (const { i, seg } of bports.get(b.id)) {
              const d = desig.get(seg);
              if (d.b === b && d.i === i) continue;
              const k = { cost: dist.get(d.b.id) + portCost(b, i), bridge: d.b, dport: d.i, port: i };
              if (!rk || k.cost < rk.cost ||
                (k.cost === rk.cost && (cmpBid(k.bridge, rk.bridge) < 0 ||
                  (cmpBid(k.bridge, rk.bridge) === 0 && (k.dport < rk.dport || (k.dport === rk.dport && k.port < rk.port)))))) {
                rk = k;
                rp = i;
              }
            }
          }
          for (const { i, seg } of bports.get(b.id)) {
            const p = b.ports[i];
            const d = desig.get(seg);
            if (i === rp) { p.stpRole = 'root'; p.stp = 'forwarding'; }
            else if (d.b === b && d.i === i) { p.stpRole = 'designated'; p.stp = 'forwarding'; }
            else { p.stpRole = 'alternate'; p.stp = 'blocking'; }
          }
          b.stpInfo = {
            isRoot: b === root,
            rootName: root.name,
            rootMac: root.baseMac,
            rootPriority: root.stpPriority,
            cost: dist.get(b.id),
            rootPort: rp,
          };
        }
      }

      let changed = false;
      for (const b of sw) {
        b.ports.forEach((p, i) => {
          if (prev.get(b.id + ':' + i) !== (p.stp === 'blocking')) changed = true;
        });
      }
      return changed;
    },
  };
})(globalThis.NetLab = globalThis.NetLab || {});
