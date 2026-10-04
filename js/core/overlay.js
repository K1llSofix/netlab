/* NetLab — наглядные слои на схеме (без DOM, для рисования и тестов):
 *  vlan — access-кабели цветом VLAN, транки пунктиром, несовпадение VLAN на концах — красным;
 *  stp  — корневой мост, заблокированные порты (кабель пунктиром), корневые порты;
 *  ospf — кабели цветом области OSPF, ABR / ASBR у маршрутизаторов;
 *  load — загрузка каналов по счётчикам портов (цвет и толщина по доле скорости).
 * compute(net, mode, state) → { links: Map(id → {color, width, dash, label, title}), devs: Map(id → {badge, color, title}), legend: [{color, text, dash}] } */
(function (NS) {
  'use strict';

  const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#a16207', '#7c3aed'];
  const vlanColor = (v) => (v === 1 ? '#64748b' : PALETTE[(Number(v) * 7) % PALETTE.length]);
  const areaColor = (a) => (String(a) === '0' ? '#2563eb' : PALETTE[(Number(String(a).replace(/\D/g, '')) * 5 + 1) % PALETTE.length]);

  const MODES = {
    vlan: 'VLAN и транки',
    stp: 'Связующее дерево (STP)',
    ospf: 'Области OSPF',
    load: 'Загрузка каналов',
  };

  const dp = (d, i) => (d.dataPort ? d.dataPort(i) : d.ports[i]);
  const isSwPort = (d, i) => d.type === 'switch' && d.ports[i] && !d.ports[i].routed;

  function ends(net, l) {
    const a = net.getDevice(l.a.dev);
    const b = net.getDevice(l.b.dev);
    return a && b ? [{ d: a, i: l.a.port }, { d: b, i: l.b.port }] : null;
  }

  function vlan(net) {
    const links = new Map();
    const devs = new Map();
    const used = new Set();
    let trunks = false;
    let bad = false;
    for (const l of net.links.values()) {
      if (l.wireless || l.cable === 'console') continue;
      const e = ends(net, l);
      if (!e) continue;
      const sw = e.filter((x) => isSwPort(x.d, x.i));
      if (!sw.length) continue;
      const ps = sw.map((x) => dp(x.d, x.i));
      if (ps.some((p) => p.mode === 'trunk')) {
        const allowed = ps.map((p) => (p.mode === 'trunk' ? p.allowed : null)).filter(Boolean);
        const lim = allowed.find((a) => a !== 'all');
        const native = ps.find((p) => p.mode === 'trunk').nativeVlan;
        const mismatch = sw.length === 2 && ps[0].mode !== ps[1].mode;
        links.set(l.id, { color: mismatch ? '#ef4444' : '#334155', width: 5, dash: '9 4', label: 'транк' + (lim ? ' ' + lim : '') + (native !== 1 ? ' · native ' + native : ''),
          title: mismatch ? 'На одном конце транк, на другом access' : 'Транк 802.1Q' + (lim ? ', разрешены VLAN ' + lim : ', все VLAN') + ', native VLAN ' + native });
        trunks = true;
        if (mismatch) bad = true;
        continue;
      }
      const vs = [...new Set(ps.map((p) => p.vlan))];
      if (vs.length > 1) {
        links.set(l.id, { color: '#ef4444', width: 4, label: 'VLAN ' + vs.join(' ≠ '), title: 'На концах кабеля разные access VLAN — кадры не пройдут' });
        bad = true;
        continue;
      }
      used.add(vs[0]);
      const name = sw[0].d.vlans && sw[0].d.vlans.get(vs[0]);
      links.set(l.id, { color: vlanColor(vs[0]), width: 4, label: 'VLAN ' + vs[0], title: 'Access VLAN ' + vs[0] + (name ? ' (' + name + ')' : '') });
    }
    for (const d of net.devices.values()) {
      const svis = (d.ifaces || []).filter((f) => f.kind === 'svi' && f.ip != null);
      if (svis.length && d.type === 'switch') devs.set(d.id, { badge: 'SVI ' + svis.map((f) => f.vlan).join(','), color: '#0f766e', title: 'Интерфейсы VLAN с адресами' });
      const subs = (d.ifaces || []).filter((f) => f.kind === 'sub' && f.vlan != null);
      if (subs.length) devs.set(d.id, { badge: 'dot1Q ' + subs.map((f) => f.vlan).join(','), color: '#0f766e', title: 'Подынтерфейсы (router-on-a-stick)' });
    }
    const legend = [...used].sort((x, y) => x - y).map((v) => ({ color: vlanColor(v), text: 'VLAN ' + v }));
    if (trunks) legend.push({ color: '#334155', dash: true, text: 'Транк' });
    if (bad) legend.push({ color: '#ef4444', text: 'Несовпадение' });
    return { links, devs, legend };
  }

  function stp(net) {
    const links = new Map();
    const devs = new Map();
    let blocked = false;
    for (const d of net.devices.values()) {
      if (d.type !== 'switch' || !d.stpInfo) continue;
      if (d.stpInfo.isRoot) devs.set(d.id, { badge: '★ Root', color: '#d97706', title: 'Корневой мост STP (приоритет ' + d.stpInfo.rootPriority + ')' });
      else devs.set(d.id, { badge: 'cost ' + d.stpInfo.cost, color: '#475569', title: 'Стоимость пути до корня ' + d.stpInfo.rootName + ': ' + d.stpInfo.cost });
    }
    for (const l of net.links.values()) {
      const e = ends(net, l);
      if (!e) continue;
      const sw = e.filter((x) => isSwPort(x.d, x.i));
      if (!sw.length) continue;
      const blk = sw.find((x) => x.d.ports[x.i].stp === 'blocking');
      if (blk) {
        links.set(l.id, { color: '#ef4444', width: 3, dash: '4 5', label: '✕ ' + blk.d.name + ' ' + blk.d.ports[blk.i].name, title: 'Порт ' + blk.d.ports[blk.i].name + ' на ' + blk.d.name + ' заблокирован STP (' + (blk.d.ports[blk.i].stpRole || 'alternate') + ')' });
        blocked = true;
        continue;
      }
      const both = sw.length === 2;
      const rootEnd = sw.find((x) => x.d.ports[x.i].stpRole === 'root');
      if (both) links.set(l.id, { color: '#16a34a', width: 5, label: rootEnd ? 'RP ' + rootEnd.d.name : '', title: 'Кабель входит в связующее дерево' + (rootEnd ? '; корневой порт ' + rootEnd.d.ports[rootEnd.i].name + ' на ' + rootEnd.d.name : '') });
    }
    const legend = [{ color: '#d97706', text: '★ корневой мост' }, { color: '#16a34a', text: 'дерево STP' }];
    if (blocked) legend.push({ color: '#ef4444', dash: true, text: 'заблокировано' });
    return { links, devs, legend };
  }

  function ospf(net) {
    const links = new Map();
    const devs = new Map();
    const areaOf = NS.routing && NS.routing.ospfArea;
    const areas = new Set();
    if (!areaOf) return { links, devs, legend: [] };
    const ifArea = (d, i) => {
      if (!d.ospf) return null;
      const f = (d.ifaces || []).find((x) => x.port === i && x.ip != null && (x.kind === 'phys' || x.kind === 'routed' || x.kind === 'sub'));
      return f ? areaOf(d, f) : null;
    };
    for (const l of net.links.values()) {
      const e = ends(net, l);
      if (!e) continue;
      const a = e.map((x) => ifArea(x.d, x.i));
      const set = a.filter((x) => x != null);
      if (!set.length) continue;
      if (set.length === 2 && String(set[0]) !== String(set[1])) {
        links.set(l.id, { color: '#ef4444', width: 4, label: 'area ' + set.join(' ≠ '), title: 'Разные области на концах канала — соседство OSPF не установится' });
        continue;
      }
      areas.add(String(set[0]));
      links.set(l.id, { color: areaColor(set[0]), width: 5, label: 'area ' + set[0], title: 'OSPF, область ' + set[0] + (set.length === 1 ? ' (OSPF только на одном конце)' : '') });
    }
    for (const d of net.devices.values()) {
      if (!d.ospf) continue;
      const my = new Set((d.ifaces || []).map((f) => areaOf(d, f)).filter((x) => x != null).map(String));
      const tags = [];
      if (my.size > 1) tags.push('ABR');
      if (d.redist && d.redist.ospf && d.redist.ospf.length) tags.push('ASBR');
      if (d.ospf.defaultOriginate) tags.push('ASBR');
      const rid = NS.routing.routerId ? NS.routing.routerId(d) : null;
      devs.set(d.id, { badge: [...new Set(tags)].join(' ') || 'area ' + [...my].join(','), color: my.size > 1 ? '#9333ea' : '#2563eb', title: 'OSPF' + (rid != null ? ', router-id ' + NS.util.ipStr(rid) : '') + ', области: ' + ([...my].join(', ') || '—') });
    }
    const legend = [...areas].sort().map((a) => ({ color: areaColor(a), text: 'area ' + a }));
    return { links, devs, legend };
  }

  const fmtRate = (bps) => (bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' Мбит/с' : bps >= 1e3 ? (bps / 1e3).toFixed(1) + ' кбит/с' : Math.round(bps) + ' бит/с');

  /** Загрузка: state = { t, bytes: Map(portKey → байты) } — прошлый замер (обновляется). */
  function load(net, state) {
    const links = new Map();
    const now = net.time;
    const prev = state && state.bytes ? state : null;
    const bytes = new Map();
    const dt = prev ? Math.max(1, now - prev.t) / 100 : 0;
    for (const l of net.links.values()) {
      const e = ends(net, l);
      if (!e) continue;
      let bps = 0;
      for (const x of e) {
        const k = x.d.id + ':' + x.i;
        const b = x.d.ports[x.i].txBytes || 0;
        bytes.set(k, b);
        if (prev && prev.bytes.has(k)) bps = Math.max(bps, ((b - prev.bytes.get(k)) * 8) / dt);
      }
      const speed = Math.min(...e.map((x) => x.d.ports[x.i].speed || 100)) * 1e6;
      const u = speed ? bps / speed : 0;
      const color = !bps ? '#94a3b8' : u < 0.3 ? '#16a34a' : u < 0.7 ? '#d97706' : '#dc2626';
      links.set(l.id, { color, width: bps ? 3 + Math.min(6, Math.log10(1 + bps) / 1.2) : 2, label: bps ? fmtRate(bps) : '', title: 'Передано: ' + fmtRate(bps) + (speed ? ' из ' + fmtRate(speed) + ' (' + (u * 100).toFixed(u < 0.01 ? 3 : 1) + '%)' : '') });
    }
    if (state) { state.t = now; state.bytes = bytes; }
    return { links, devs: new Map(), legend: [{ color: '#94a3b8', text: 'нет трафика' }, { color: '#16a34a', text: '< 30%' }, { color: '#d97706', text: '30–70%' }, { color: '#dc2626', text: '> 70%' }] };
  }

  function compute(net, mode, state) {
    if (mode === 'vlan') return vlan(net);
    if (mode === 'stp') return stp(net);
    if (mode === 'ospf') return ospf(net);
    if (mode === 'load') return load(net, state);
    return null;
  }

  NS.overlay = { MODES, compute, vlanColor, areaColor, fmtRate };
})(globalThis.NetLab = globalThis.NetLab || {});
