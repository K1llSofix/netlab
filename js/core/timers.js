/* NetLab — режим «реалистичные таймеры» (настройка схемы, по умолчанию выключен):
 *  STP 802.1D: порт, которому пора пересылать, проходит listening (15 с) и learning (15 с) — индикатор оранжевый;
 *  PortFast / portfast default — сразу forwarding; rapid-pvst — около 3 с (proposal / agreement);
 *  динамическая маршрутизация сходится не мгновенно: новая таблица вступает в силу через время, типичное для
 *  протокола (OSPF — 5 с, потеря соседа — 10 с; EIGRP — 3 / 5 с; RIP — 30 с), до этого действует прежняя. */
(function (NS) {
  'use strict';

  const FWD_DELAY = 1500; // 15 с
  const RSTP_SYNC = 300; // 3 с

  const enabled = (net) => !!(net && net.realTimers);

  function schedule(net, key, at, fn) {
    const t = net.rtTimers || (net.rtTimers = {});
    if (t[key] && t[key].at <= at) return;
    if (t[key]) t[key].h.cancel();
    t[key] = { at, h: net.timer(null, Math.max(1, at - net.time), () => { delete t[key]; fn(); }) };
  }

  /* ---------- STP: listening → learning → forwarding ---------- */

  const baseStp = NS.stp.compute;
  NS.stp.compute = function (net) {
    const changed = baseStp.call(this, net);
    const on = enabled(net);
    const now = net.time;
    let next = Infinity;
    for (const d of net.devices.values()) {
      if (d.type !== 'switch' || !d.ports) continue;
      const rapid = d.stpMode === 'rapid-pvst';
      d.ports.forEach((p) => {
        const wants = on && d.power && p.oper && p.stp !== 'blocking' && !p.routed && NS.Network.isData(p) && !p.radio;
        if (!wants) { p.stpPhase = null; p.stpReady = !on; return; }
        if (p.stpReady) return;
        const edge = !!p.portfast || (!!d.portfastDefault && p.mode === 'access');
        if (edge) { p.stpReady = true; p.stpPhase = null; return; }
        if (!p.stpPhase) p.stpSince = now;
        const total = rapid ? RSTP_SYNC : 2 * FWD_DELAY;
        const el = now - p.stpSince;
        if (el >= total) { p.stpReady = true; p.stpPhase = null; return; }
        p.stpPhase = rapid || el >= FWD_DELAY ? 'learning' : 'listening';
        next = Math.min(next, p.stpSince + (p.stpPhase === 'listening' ? FWD_DELAY : total));
        // пока порт не пересылает данные
        p.stp = 'blocking';
        if (p.stpV) for (const v of Object.keys(p.stpV)) p.stpV[v] = 'blocking';
      });
    }
    if (next < Infinity) schedule(net, 'stp', next, () => net.refreshTopology());
    return changed;
  };

  /* ---------- сходимость динамической маршрутизации ---------- */

  const sigOf = (routes) => (routes || []).map((r) => [r.type, r.sub || '', r.net, r.mask, r.nextHop, r.ifc ? r.ifc.name : ''].join('|')).sort().join(';');

  function delays(d) {
    const up = [];
    const down = [];
    const has = (o) => !!o && (!Array.isArray(o.networks) || o.networks.length > 0);
    if (has(d.ospf) || (d.ifaces || []).some((f) => f.ospfIf)) { up.push(500); down.push(1000); }
    if (has(d.eigrp)) { up.push(300); down.push(500); }
    if (d.rip && d.rip.networks && d.rip.networks.length) { up.push(3000); down.push(3000); }
    if (d.bgp && (d.bgp.asn || d.bgp.neighbors)) { up.push(3000); down.push(3000); }
    return { up: up.length ? Math.max(...up) : 300, down: down.length ? Math.max(...down) : 300 };
  }

  const baseRouting = NS.routing.compute;
  NS.routing.compute = function (net) {
    const r = baseRouting.apply(this, arguments);
    const on = enabled(net);
    for (const d of net.devices.values()) {
      if (!Array.isArray(d.dynRoutes)) continue;
      if (!on) { d.dynActive = null; d.dynActiveSig = undefined; d.dynPend = null; continue; }
      const sig = sigOf(d.dynRoutes);
      if (d.dynActiveSig === undefined) { d.dynActiveSig = sig; d.dynActive = d.dynRoutes; continue; }
      if (sig === d.dynActiveSig) { d.dynActive = d.dynRoutes; d.dynPend = null; continue; }
      if (!d.dynPend || d.dynPend.sig !== sig) {
        const lost = (d.dynActive || []).some((x) => !d.dynRoutes.some((y) => y.net === x.net && y.mask === x.mask));
        const dl = delays(d);
        d.dynPend = { sig, routes: d.dynRoutes, at: net.time + (lost ? dl.down : dl.up) };
        const dev = d;
        schedule(net, 'rt:' + d.id, d.dynPend.at, () => {
          if (!dev.dynPend) return;
          dev.dynActive = dev.dynPend.routes;
          dev.dynActiveSig = dev.dynPend.sig;
          dev.dynPend = null;
          net.markRouting();
          net.emit('topology');
        });
      }
      d.dynRoutes = d.dynActive || [];
    }
    return r;
  };

  NS.netExt.push({
    key: 'realTimers',
    save: (net) => (net.realTimers ? true : null),
    load(net, v) { net.realTimers = !!v; },
  });

  NS.timers = {
    set(net, on) {
      net.realTimers = !!on;
      for (const d of net.devices.values()) for (const p of d.ports || []) { p.stpReady = !on; p.stpPhase = null; }
      net.refreshTopology();
      net.markRouting();
      net.ensureRouting(); // текущая таблица — исходная точка сходимости
    },
    enabled,
  };
})(globalThis.NetLab = globalThis.NetLab || {});
