/* NetLab — WAN и новые модели:
 *  • Cloud-PT: порты Ethernet, DSL и Coaxial — сеть провайдера, соединяющая DSL- и кабельных абонентов с Ethernet;
 *  • DSL-модем и кабельный модем (мосты «телефонная линия / коаксиал ↔ Ethernet»), кабель «Коаксиальный»;
 *  • вышка сотовой связи Cell-Tower: смартфоны с включённым 3G/4G подключаются к ближайшей вышке,
 *    если нет Wi-Fi; вышка — мост в проводную сеть (DHCP-сервер или маршрутизатор провайдера за ней);
 *  • маршрутизаторы 1841 и ISR 4331 (модули NIM-2T, NIM-ES2-4), коммутатор Catalyst 3650-24PS;
 *  • модуль HWIC-4ESW (и NIM-ES2-4): порты встроенного коммутатора маршрутизатора в VLAN,
 *    interface vlan N на маршрутизаторе, switchport access vlan, show vlan-switch. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const M = NS.models;
  const IpNode = NS.IpNode;
  const X = NS.cliIos.ext;
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const CONSOLE = { name: 'Console', media: 'console', speed: 0 };
  const ATTR = (cost, w) => ({ MTBF: 200000, cost, 'power source': 0, 'rack units': 1, wattage: w });

  /* ================= облако провайдера ================= */

  const BRIDGE = ['Ethernet', 'DSL', 'Coaxial'];
  M.MODELS['Cloud-PT'].title = 'Облако Cloud-PT (телефонная сеть и провайдер)';
  M.MODELS['Cloud-PT'].ports = M.MODELS['Cloud-PT'].ports.concat([
    { name: 'Ethernet', media: 'copper', speed: 100, mdix: true },
    { name: 'DSL', media: 'phone', speed: 8 },
    { name: 'Coaxial', media: 'coax', speed: 50 },
  ]);
  const Cloud = NS.PhoneCloud;
  const numberOf = Cloud.prototype.numberOf;
  Cloud.prototype.numberOf = function (i) { return BRIDGE.includes(this.ports[i].name) ? '' : numberOf.call(this, i); };
  const cloudRecv = Cloud.prototype.receive;
  Cloud.prototype.receive = function (i, frame) {
    const name = this.ports[i].name;
    if (!BRIDGE.includes(name)) { cloudRecv.call(this, i, frame); return; }
    let sent = 0;
    for (const t of BRIDGE) {
      if (t === name) continue;
      const j = this.portIndex(t);
      if (j >= 0 && this.net.isPortOperational(this, j) && this.send(j, frame, 'Сеть провайдера: ' + name + ' → ' + t)) sent++;
    }
    if (!sent) this.drop(frame, 'Сеть провайдера: к порту Ethernet облака ничего не подключено');
  };

  /* ================= модемы ================= */

  M.MODELS['DSL-Modem-PT'] = {
    type: 'modem', title: 'DSL-модем DSL-Modem-PT',
    ports: [{ name: 'Port 0', media: 'phone', speed: 8 }, { name: 'Port 1', media: 'copper', speed: 100, mdix: true }],
    slots: [], attrs: ATTR(80, 8),
  };
  M.MODELS['Cable-Modem-PT'] = {
    type: 'modem', title: 'Кабельный модем Cable-Modem-PT',
    ports: [{ name: 'Port 0', media: 'coax', speed: 50 }, { name: 'Port 1', media: 'copper', speed: 100, mdix: true }],
    slots: [], attrs: ATTR(90, 9),
  };
  M.DEFAULT_MODEL.modem = 'DSL-Modem-PT';

  class Modem extends NS.Device {
    constructor(net, id, name, model) { super(net, id, 'modem', name, model); }
    receive(i, frame) {
      const j = i === 0 ? 1 : 0;
      const kind = this.ports[0].media === 'coax' ? 'коаксиал' : 'телефонная линия (DSL)';
      if (!this.net.isPortOperational(this, j)) { this.drop(frame, 'Модем: порт ' + this.ports[j].name + ' не подключён'); return; }
      this.send(j, frame, i === 0 ? 'Модем: ' + kind + ' → Ethernet' : 'Модем: Ethernet → ' + kind);
    }
  }
  Modem.namePrefix = 'Modem';
  Modem.title = 'Модем';
  NS.deviceTypes.modem = Modem;
  NS.Modem = Modem;

  /* ================= сотовая связь ================= */

  M.MODELS['Cell-Tower'] = {
    type: 'celltower', title: 'Вышка сотовой связи Cell-Tower (3G/4G)',
    ports: [{ name: 'Ethernet0', media: 'copper', speed: 1000 }, { name: 'Cell0', media: 'wireless', speed: 100, radio: true }],
    slots: [], attrs: ATTR(20000, 900),
  };
  M.DEFAULT_MODEL.celltower = 'Cell-Tower';

  class CellTower extends NS.AccessPoint {
    constructor(net, id, name, model) {
      super(net, id, name, model || 'Cell-Tower');
      this.type = 'celltower';
      this.wifi = { ssid: '3G/4G', security: 'open', key: '', channel: 1, enabled: true };
    }
    /** Вышка не раздаёт Wi-Fi: к ней подключаются только смартфоны с включённым 3G/4G. */
    wlans() { return []; }
  }
  CellTower.namePrefix = 'CellTower';
  CellTower.title = 'Вышка сотовой связи';
  NS.deviceTypes.celltower = CellTower;

  IpNode.prototype.setCellular = function (on) { this.cellular = !!on; this.net.refreshTopology(); };
  IpNode.hooks.bind.push(function () { if (this.type === 'smartphone' && this.cellular === undefined) this.cellular = true; });
  NS.deviceExt.push({
    key: 'cell',
    applies: (d) => d.type === 'smartphone',
    save: (d) => (d.cellular === false ? { cellular: false } : null),
    load(d, c) { d.cellular = !(c && c.cellular === false); },
  });

  /* ================= модели маршрутизаторов и коммутатора ================= */

  M.MODULES['NIM-2T'] = { kind: 'nim', title: 'NIM-2T', desc: 'Два последовательных (Serial) порта для ISR 4000. Соединяются кабелем Serial DCE/DTE; на стороне DCE — clock rate.', ports: [{ name: 'Serial0/{s}/0', media: 'serial', speed: 1.544 }, { name: 'Serial0/{s}/1', media: 'serial', speed: 1.544 }] };
  M.MODULES['NIM-ES2-4'] = { kind: 'nim', title: 'NIM-ES2-4', desc: 'Встроенный коммутатор: 4 порта Gigabit Ethernet 2-го уровня. VLAN задаются командой switchport access vlan, адрес — на interface vlan N маршрутизатора.', ports: range(4, (i) => ({ name: 'GigabitEthernet0/{s}/' + i, media: 'copper', speed: 1000, mdix: true })) };
  M.MODULES['HWIC-4ESW'] = { kind: 'hwic', title: 'HWIC-4ESW', desc: 'Встроенный коммутатор: 4 порта Fast Ethernet 2-го уровня. Порты — в VLAN (switchport access vlan), адрес — на interface vlan N маршрутизатора.', ports: range(4, (i) => ({ name: 'FastEthernet0/{s}/' + i, media: 'copper', speed: 100, mdix: true })) };

  M.MODELS['1841'] = {
    type: 'router', title: 'Маршрутизатор Cisco 1841', ios: true,
    ports: [0, 1].map((i) => ({ name: 'FastEthernet0/' + i, media: 'copper', speed: 100 })).concat([CONSOLE]),
    slots: range(2, (i) => ({ id: 'hwic' + i, kind: 'hwic', label: 'HWIC ' + i, n: i, def: null })),
    attrs: ATTR(2000, 80),
  };
  M.MODELS['4331'] = {
    type: 'router', title: 'Маршрутизатор Cisco ISR 4331', ios: true,
    ports: [0, 1, 2].map((i) => ({ name: 'GigabitEthernet0/0/' + i, media: 'copper', speed: 1000 })).concat([CONSOLE]),
    slots: [1, 2].map((n) => ({ id: 'nim' + n, kind: 'nim', label: 'NIM ' + n, n, def: null })),
    attrs: ATTR(7000, 250),
  };
  M.MODELS['3650-24PS'] = {
    type: 'switch', title: 'Коммутатор 3-го уровня Cisco Catalyst 3650-24PS', ios: true, l3: true, poe: true,
    ports: range(24, (i) => ({ name: 'GigabitEthernet1/0/' + (i + 1), media: 'copper', speed: 1000, mdix: true }))
      .concat(range(4, (i) => ({ name: 'GigabitEthernet1/1/' + (i + 1), media: 'fiber', speed: 1000, mdix: true })), [CONSOLE]),
    slots: [], attrs: ATTR(9000, 390),
  };

  /* ================= встроенный коммутатор маршрутизатора (HWIC-4ESW, NIM-ES2-4) ================= */

  const ESW = new Set(['HWIC-4ESW', 'NIM-ES2-4']);
  const isEsw = (p) => !!p && ESW.has(p.module);
  const Router = NS.deviceTypes.router;
  const RP = Router.prototype;
  const shortIf = (n) => NS.cliIos.ctx.shortIf(n);

  const sync = RP.syncIfaces;
  RP.syncIfaces = function () {
    sync.call(this);
    if (!this.ifaces) return;
    // порты модуля-коммутатора — 2-го уровня: без собственного IP-интерфейса
    this.ifaces = this.ifaces.filter((f) => !(f.kind === 'phys' && isEsw(this.ports[f.port])));
    for (const p of this.ports) if (isEsw(p) && p.eswVlan == null) p.eswVlan = 1;
  };

  function eswMac(dev) { const p = dev.ports.find(isEsw); return p ? p.mac : null; }

  const ifMac = RP.ifaceMac;
  RP.ifaceMac = function (f) { return f && f.kind === 'svi' ? eswMac(this) : ifMac.call(this, f); };

  // interface vlan N маршрутизатора: работает, если есть порт этого VLAN во встроенном коммутаторе
  IpNode.ifaceUpHooks.svi = function (f) {
    return this.ports.some((p, j) => isEsw(p) && (p.eswVlan || 1) === f.vlan && this.net.isPortOperational(this, j));
  };

  function eswOut(dev, vlan, fromPort, frame, why) {
    const tbl = dev.eswTable || (dev.eswTable = new Map());
    if (!U.isMulticastMac(frame.dst)) {
      const j = tbl.get(vlan + '|' + frame.dst);
      if (j != null && j !== fromPort && dev.net.isPortOperational(dev, j)) return dev.send(j, frame, why);
    }
    let n = 0;
    dev.ports.forEach((p, j) => {
      if (j === fromPort || !isEsw(p) || (p.eswVlan || 1) !== vlan) return;
      if (dev.send(j, frame, why)) n++;
    });
    return n > 0;
  }

  const ifSend = RP.ifaceSend;
  RP.ifaceSend = function (f, frame, why) {
    if (!f || f.kind !== 'svi') return ifSend.call(this, f, frame, why);
    return eswOut(this, f.vlan, -1, Object.assign({}, frame, { vlan: null }), why || 'Кадр маршрутизатора в VLAN ' + f.vlan + ' (встроенный коммутатор)');
  };

  const recv = RP.receive;
  RP.receive = function (i, frame) {
    const p = this.ports[i];
    if (!isEsw(p)) { recv.call(this, i, frame); return; }
    if (frame.vlan != null) { this.drop(frame, 'Кадр с тегом 802.1Q на access-порту встроенного коммутатора ' + p.name); return; }
    const vlan = p.eswVlan || 1;
    const tbl = this.eswTable || (this.eswTable = new Map());
    if (!U.isMulticastMac(frame.src)) tbl.set(vlan + '|' + frame.src, i);
    const svi = this.ifaces.find((f) => f.kind === 'svi' && f.vlan === vlan);
    if (svi && frame.dst === eswMac(this)) { this.ipIngress(svi, frame); return; }
    if (U.isMulticastMac(frame.dst)) {
      if (svi) this.ipIngress(svi, frame);
      eswOut(this, vlan, i, frame, 'Встроенный коммутатор: широковещательный кадр — в порты VLAN ' + vlan);
      return;
    }
    if (!eswOut(this, vlan, i, frame, 'Встроенный коммутатор (' + p.module + '): кадр в VLAN ' + vlan)) this.drop(frame, 'Встроенный коммутатор: в VLAN ' + vlan + ' нет других активных портов');
  };

  if (!RP.setPortAdmin) {
    RP.setPortAdmin = function (i, up) {
      const p = this.ports[i];
      p.adminUp = !!up;
      if (up) p.errDisabled = false;
      this.net.refreshTopology();
    };
  }

  const serPort = RP.serializePort;
  RP.serializePort = function (p) {
    const o = serPort.call(this, p);
    if (isEsw(p) && (p.eswVlan || 1) !== 1) o.eswVlan = p.eswVlan;
    return o;
  };
  const loadPort = RP.loadPort;
  RP.loadPort = function (p, sp) {
    loadPort.call(this, p, sp);
    if (isEsw(p)) p.eswVlan = Number(sp.eswVlan) || 1;
  };

  IpNode.hooks.runtime.push(function () { if (this.type === 'router') this.eswTable = null; });

  // загрузка interface vlan маршрутизатора (у коммутатора — своя)
  IpNode.ifaceKinds.svi = { create: (dev, s) => { const f = dev.addIface(-1, String(s.name), Number(s.vlan), 'svi'); f.adminUp = true; return f; } };

  /* ---------- команды IOS ---------- */

  const hasEsw = (dev) => dev.type === 'router' && dev.ports.some(isEsw);

  X.ifNames.push((dev, t) => {
    if (!hasEsw(dev)) return null;
    const m = /^vl(?:a(?:n)?)?(\d+)$/i.exec(t);
    if (!m) return null;
    const v = Number(m[1]);
    if (!(v >= 1 && v <= 4094)) return null;
    return {
      kind: 'named',
      name: 'Vlan' + v,
      create: (d) => { const f = d.addIface(-1, 'Vlan' + v, v, 'svi'); f.adminUp = true; if (d.sortIfaces) d.sortIfaces(); d.net.markRouting(); return f; },
      remove: (d) => { const f = d.ifaceByName('Vlan' + v); if (f) d.removeIface(f); },
    };
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (dev.type !== 'router') return false;
    const ports = targets.filter((r) => r.kind === 'port' && r.sub == null && isEsw(dev.ports[r.port])).map((r) => r.port);
    if (!ports.length) return false;
    if (C.kw(a[0], 'switchport', 2)) {
      if (C.kw(a[1], 'access', 1) && C.kw(a[2], 'vlan', 1)) {
        const v = neg ? 1 : Number(a[3]);
        if (!(Number.isInteger(v) && v >= 1 && v <= 4094)) { C.incomplete(io); return true; }
        C.withMutate(io, () => { for (const i of ports) dev.ports[i].eswVlan = v; dev.eswTable = null; });
        dev.net.refreshTopology();
        dev.net.markRouting();
        return true;
      }
      if (C.kw(a[1], 'mode', 1)) {
        if (C.kw(a[2], 'trunk', 1)) { io.out('% В NetLab порты встроенного коммутатора (' + dev.ports[ports[0]].module + ') работают в режиме access'); return true; }
        return true;
      }
      return true;
    }
    if (C.kw(a[0], 'spanning-tree', 2) || C.kw(a[0], 'speed', 2) || C.kw(a[0], 'duplex', 2) || C.kw(a[0], 'description', 1)) return true;
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'address', 1)) { io.out('% ' + dev.ports[ports[0]].name + ' — порт встроенного коммутатора (2-й уровень). Адрес задаётся на interface vlan N.'); return true; }
    return false;
  });

  X.running.global.push((dev) => {
    if (!hasEsw(dev)) return [];
    const L = [];
    for (const p of dev.ports) {
      if (!isEsw(p)) continue;
      L.push('interface ' + p.name);
      if ((p.eswVlan || 1) !== 1) L.push(' switchport access vlan ' + p.eswVlan);
      if (!p.adminUp) L.push(' shutdown');
      L.push('!');
    }
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!hasEsw(dev) || !C.kw(a[0], 'vlan-switch', 6)) return false;
    const vl = new Map();
    for (const p of dev.ports) if (isEsw(p)) { const v = p.eswVlan || 1; if (!vl.has(v)) vl.set(v, []); vl.get(v).push(shortIf(p.name)); }
    if (!vl.has(1)) vl.set(1, []);
    io.out('VLAN Name                             Status    Ports');
    io.out('---- -------------------------------- --------- -------------------------------');
    for (const [v, ps] of [...vl.entries()].sort((x, y) => x[0] - y[0])) io.out(C.pad(String(v), 5) + C.pad(v === 1 ? 'default' : 'VLAN' + String(v).padStart(4, '0'), 33) + C.pad('active', 10) + ps.join(', '));
    return true;
  });

  X.tree.exec = (X.tree.exec || []).concat(['show vlan-switch', 'show vlan-switch brief']);

  NS.wan = { isEsw, eswOut, BRIDGE };
})(globalThis.NetLab = globalThis.NetLab || {});
