/* NetLab — фрагменты схемы и поиск:
 *  capture(net, ids) — выбранные устройства с настройками и кабелями между ними (для шаблонов и копирования);
 *  insert(net, frag, x, y, opts) — вставить фрагмент: новые устройства, те же кабели; адреса, уже занятые в схеме, сбрасываются;
 *  find(net, запрос) — поиск устройств по имени, модели, типу, IP, MAC, VLAN-имени и тексту заметок. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const VERSION = 1;

  function capture(net, ids) {
    const set = new Set(ids.filter((id) => net.getDevice(id)));
    const devs = [...set].map((id) => net.getDevice(id));
    if (!devs.length) return null;
    const minX = Math.min(...devs.map((d) => d.x));
    const minY = Math.min(...devs.map((d) => d.y));
    const index = new Map(devs.map((d, i) => [d.id, i]));
    const devices = devs.map((d) => {
      const data = JSON.parse(JSON.stringify(d.serialize()));
      for (const p of data.ports || []) delete p.mac;
      delete data.baseMac;
      if (data.config) { delete data.config.baseMac; data.config.inbox = []; data.config.outbox = []; if (data.config.dhcpd) data.config.dhcpd.leases = []; }
      data.dx = d.x - minX;
      data.dy = d.y - minY;
      delete data.id;
      return data;
    });
    const links = [];
    for (const l of net.links.values()) {
      if (l.wireless || !index.has(l.a.dev) || !index.has(l.b.dev)) continue;
      links.push({ a: index.get(l.a.dev), pa: l.a.port, b: index.get(l.b.dev), pb: l.b.port, cable: l.cable, dce: l.dce ? index.get(l.dce) : null });
    }
    return { v: VERSION, devices, links };
  }

  function freeName(net, name) {
    if (!net.findByName(name)) return name;
    const m = /^(.*?)(\d+)$/.exec(name);
    const base = m ? m[1] : name + '-';
    for (let i = m ? Number(m[2]) + 1 : 1; i < 100000; i++) if (!net.findByName(base + i)) return base + i;
    return name + '-' + Date.now();
  }

  /** Вставить фрагмент в точку (x, y) — левый верхний угол. → [id новых устройств]. */
  function insert(net, frag, x, y, opts) {
    if (!frag || !Array.isArray(frag.devices)) throw new Error('Шаблон повреждён');
    opts = opts || {};
    const used = new Set();
    for (const d of net.devices.values()) for (const f of d.ifaces || []) if (f.ip != null) used.add(f.ip);
    const created = [];
    for (const src of frag.devices) {
      const data = JSON.parse(JSON.stringify(src));
      const name = freeName(net, data.name || 'Device');
      const d = net.addDevice(data.type, { model: data.model, name, x: Math.round(x + (data.dx || 0)), y: Math.round(y + (data.dy || 0)) });
      const c = data.config || {};
      if (c.ifaces) for (const f of c.ifaces) { const a = U.parseIp(f.ip || ''); if (a != null && (used.has(a) || opts.clearIps)) { f.ip = null; f.mask = null; } }
      delete data.dx;
      delete data.dy;
      d.load(Object.assign({}, data, { name: d.name, x: d.x, y: d.y }));
      for (const f of d.ifaces || []) if (f.ip != null) used.add(f.ip);
      created.push(d);
    }
    for (const l of frag.links || []) {
      const a = created[l.a];
      const b = created[l.b];
      if (!a || !b) continue;
      try {
        const cable = l.cable === 'serial' ? (l.dce === l.b ? 'serial-dte' : 'serial-dce') : l.cable;
        net.connect(a.id, l.pa, b.id, l.pb, cable);
      } catch (e) { /* порт занят или модуль не установлен — кабель пропускается */ }
    }
    net.markRouting();
    return created.map((d) => d.id);
  }

  /** Поиск: → [{ id, name, what }] (что совпало), не больше limit. */
  function find(net, query, limit) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const macQ = q.replace(/[.:-]/g, '');
    for (const d of net.devices.values()) {
      let what = null;
      const nm = d.name.toLowerCase();
      let rank = nm === q ? 0 : nm.startsWith(q) ? 1 : 2;
      if (nm.includes(q)) what = d.model;
      else if (String(d.model).toLowerCase().includes(q) || String(d.type).toLowerCase() === q) what = d.model;
      if (!what) {
        const ifs = (d.ifaces || []).filter((x) => x.ip != null);
        const f = ifs.find((x) => U.ipStr(x.ip) === q) || ifs.find((x) => U.ipStr(x.ip).startsWith(q));
        if (f) { what = f.name + ' ' + U.cidr(f.ip, f.mask); if (U.ipStr(f.ip) === q) rank = 0; }
      }
      if (!what && macQ.length >= 4 && /^[0-9a-f]+$/.test(macQ)) {
        const p = (d.ports || []).find((x) => String(x.mac || '').toLowerCase().replace(/:/g, '').includes(macQ));
        if (p) what = p.name + ' MAC ' + U.ciscoMac(p.mac);
      }
      if (!what && d.vlans) {
        for (const [v, n] of d.vlans) if (String(n).toLowerCase().includes(q) || String(v) === q.replace(/^vlan\s*/, '')) { what = 'VLAN ' + v + ' ' + n; break; }
      }
      if (what) out.push({ id: d.id, name: d.name, what, kind: 'dev', rank });
    }
    for (const n of net.notes || []) if (String(n.text).toLowerCase().includes(q)) out.push({ id: n.id, name: 'Заметка', what: String(n.text).split('\n')[0].slice(0, 60), kind: 'note', rank: 3 });
    out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'ru', { numeric: true }));
    return out.slice(0, limit || 50);
  }

  NS.fragment = { capture, insert, VERSION };
  NS.search = { find };
})(globalThis.NetLab = globalThis.NetLab || {});
