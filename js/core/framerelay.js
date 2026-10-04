/* NetLab — Frame Relay (как в Packet Tracer):
 *  облако Cloud-PT — коммутатор Frame Relay: порты Serial0–Serial3, на каждом свои DLCI, таблица PVC
 *  (Serial0 DLCI 102 ↔ Serial1 DLCI 201); LMI сообщает маршрутизатору его DLCI и их состояние;
 *  маршрутизатор: encapsulation frame-relay [ietf], frame-relay lmi-type, frame-relay map ip A DLCI [broadcast],
 *  подынтерфейсы point-to-point / multipoint с frame-relay interface-dlci, Inverse ARP (динамические карты);
 *  show frame-relay pvc | map | lmi; OSPF/EIGRP/RIP находят соседей через PVC. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const M = NS.models;
  const X = NS.cliIos.ext;
  const IpNode = NS.IpNode;
  const Cloud = NS.PhoneCloud;
  const ip = (x) => U.ipStr(x);

  const FR_PORTS = ['Serial0', 'Serial1', 'Serial2', 'Serial3'];
  M.MODELS['Cloud-PT'].ports = M.MODELS['Cloud-PT'].ports.concat(FR_PORTS.map((name) => ({ name, media: 'serial', speed: 1.544 })));

  const isFrPort = (p) => !!p && p.media === 'serial' && p.encap === 'frame-relay';

  /* ================= облако: коммутация по DLCI ================= */

  function frOf(cloud) { return cloud.fr || (cloud.fr = { ports: {}, conns: [] }); }

  function initCloudPorts(cloud) {
    for (const p of cloud.ports) if (FR_PORTS.includes(p.name)) { p.encap = 'frame-relay'; if (!p.clockRate) p.clockRate = 64000; }
  }

  const baseRecv = Cloud.prototype.receive;
  Cloud.prototype.receive = function (i, frame) {
    const p = this.ports[i];
    if (!p || !FR_PORTS.includes(p.name)) { baseRecv.call(this, i, frame); return; }
    if (!frame.fr) { this.drop(frame, 'Frame Relay: кадр без DLCI — на маршрутизаторе нужна encapsulation frame-relay'); return; }
    const out = route(this, p.name, frame.fr.dlci);
    if (!out) { this.drop(frame, 'Frame Relay: DLCI ' + frame.fr.dlci + ' на ' + p.name + ' не связан PVC в облаке'); return; }
    const j = this.portIndex(out.port);
    if (j < 0 || !this.net.isPortOperational(this, j)) { this.drop(frame, 'Frame Relay: порт ' + out.port + ' облака не подключён'); return; }
    this.send(j, Object.assign({}, frame, { fr: { dlci: out.dlci } }), 'Frame Relay: ' + p.name + ' DLCI ' + frame.fr.dlci + ' → ' + out.port + ' DLCI ' + out.dlci);
  };

  /** Куда ведёт (порт, DLCI) облака: { port, dlci } или null. */
  function route(cloud, port, dlci) {
    for (const c of frOf(cloud).conns) {
      if (c.a.port === port && c.a.dlci === dlci) return c.b;
      if (c.b.port === port && c.b.dlci === dlci) return c.a;
    }
    return null;
  }

  const baseNum = Cloud.prototype.numberOf;
  Cloud.prototype.numberOf = function (i) { return this.ports[i] && FR_PORTS.includes(this.ports[i].name) ? '' : baseNum.call(this, i); };

  // сохранение настроек облака
  const baseSer = Cloud.prototype.serializeConfig;
  Cloud.prototype.serializeConfig = function () {
    const c = baseSer ? baseSer.call(this) : {};
    if (this.fr && (Object.keys(this.fr.ports).length || this.fr.conns.length)) c.fr = JSON.parse(JSON.stringify({ ports: this.fr.ports, conns: this.fr.conns }));
    return c;
  };
  const baseLoad = Cloud.prototype.loadConfig;
  Cloud.prototype.loadConfig = function (c) {
    if (baseLoad) baseLoad.call(this, c);
    initCloudPorts(this);
    this.fr = c && c.fr ? { ports: c.fr.ports || {}, conns: c.fr.conns || [] } : { ports: {}, conns: [] };
  };

  const CloudApi = {
    addDlci(cloud, port, dlci, name) {
      dlci = Number(dlci);
      if (!FR_PORTS.includes(port)) throw new Error('Порт Frame Relay: ' + FR_PORTS.join(', '));
      if (!(Number.isInteger(dlci) && dlci >= 16 && dlci <= 1007)) throw new Error('DLCI: 16–1007');
      const pp = frOf(cloud).ports[port] || (frOf(cloud).ports[port] = { dlcis: [], lmi: 'cisco' });
      if (pp.dlcis.some((d) => d.dlci === dlci)) throw new Error('DLCI ' + dlci + ' на ' + port + ' уже есть');
      pp.dlcis.push({ dlci, name: String(name || '').trim() });
      pp.dlcis.sort((a, b) => a.dlci - b.dlci);
      cloud.net.markRouting();
    },
    removeDlci(cloud, port, dlci) {
      const pp = frOf(cloud).ports[port];
      if (pp) pp.dlcis = pp.dlcis.filter((d) => d.dlci !== Number(dlci));
      frOf(cloud).conns = frOf(cloud).conns.filter((c) => !((c.a.port === port && c.a.dlci === Number(dlci)) || (c.b.port === port && c.b.dlci === Number(dlci))));
      cloud.net.markRouting();
    },
    connect(cloud, aPort, aDlci, bPort, bDlci) {
      const has = (port, dlci) => ((frOf(cloud).ports[port] || {}).dlcis || []).some((d) => d.dlci === Number(dlci));
      if (!has(aPort, aDlci) || !has(bPort, bDlci)) throw new Error('Сначала добавьте оба DLCI на порты');
      if (route(cloud, aPort, Number(aDlci)) || route(cloud, bPort, Number(bDlci))) throw new Error('Один из DLCI уже связан');
      if (aPort === bPort) throw new Error('PVC соединяет разные порты облака');
      frOf(cloud).conns.push({ a: { port: aPort, dlci: Number(aDlci) }, b: { port: bPort, dlci: Number(bDlci) } });
      cloud.net.markRouting();
    },
    disconnect(cloud, i) { frOf(cloud).conns.splice(i, 1); cloud.net.markRouting(); },
    FR_PORTS,
  };

  /* ================= маршрутизатор: PVC, карты, Inverse ARP ================= */

  const frCfg = (f) => f.fr || (f.fr = { maps: [] });

  /** Облако на другом конце порта и имя его порта. */
  function cloudEnd(dev, i) {
    const pr = dev.net.peer(dev, i);
    return pr && pr.dev.type === 'cloud' && FR_PORTS.includes(pr.dev.ports[pr.port].name) ? { cloud: pr.dev, port: pr.dev.ports[pr.port].name } : null;
  }

  /** DLCI, которые облако объявило на этом порту (LMI). */
  function localDlcis(dev, i) {
    const e = cloudEnd(dev, i);
    if (!e || !dev.net.isPortOperational(dev, i)) return [];
    return ((frOf(e.cloud).ports[e.port] || {}).dlcis || []).map((d) => d.dlci);
  }

  /** Интерфейс маршрутизатора, которому принадлежит DLCI (подынтерфейс с interface-dlci или основной). */
  function ifaceForDlci(dev, i, dlci) {
    return dev.ifaces.find((x) => x.port === i && x.kind === 'sub' && x.dlci === dlci) || dev.ifaces.find((x) => x.port === i && x.kind === 'phys');
  }

  /** Состояние PVC: { status: ACTIVE|INACTIVE|DELETED, peer: { dev, port, f } }. */
  function pvc(dev, i, dlci) {
    const e = cloudEnd(dev, i);
    if (!e || !localDlcis(dev, i).includes(dlci)) return { status: 'DELETED' };
    const out = route(e.cloud, e.port, dlci);
    if (!out) return { status: 'INACTIVE' };
    const j = e.cloud.portIndex(out.port);
    const pr = j >= 0 ? dev.net.peer(e.cloud, j) : null;
    if (!pr || !pr.dev.power || !pr.dev.ifaces || !isFrPort(pr.dev.ports[pr.port]) || !dev.net.isPortOperational(pr.dev, pr.port)) return { status: 'INACTIVE' };
    const f = ifaceForDlci(pr.dev, pr.port, out.dlci);
    if (!f || !pr.dev.ifaceUp(f)) return { status: 'INACTIVE' };
    return { status: 'ACTIVE', peer: { dev: pr.dev, port: pr.port, f, dlci: out.dlci } };
  }

  /** Подынтерфейс Frame Relay «up», если его DLCI связан PVC с другим концом, где тоже Frame Relay (без проверки удалённого интерфейса). */
  function subUp(dev, f) {
    if (!dev.net.isPortOperational(dev, f.port) || !isFrPort(dev.ports[f.port]) || f.dlci == null) return false;
    const e = cloudEnd(dev, f.port);
    if (!e) return false;
    const out = route(e.cloud, e.port, f.dlci);
    if (!out || !localDlcis(dev, f.port).includes(f.dlci)) return false;
    const j = e.cloud.portIndex(out.port);
    const pr = j >= 0 ? dev.net.peer(e.cloud, j) : null;
    return !!pr && !!pr.dev.power && isFrPort(pr.dev.ports[pr.port]) && dev.net.isPortOperational(pr.dev, pr.port);
  }

  /** DLCI, которыми пользуется интерфейс f. */
  function dlcisOf(dev, f) {
    const i = f.port;
    const local = localDlcis(dev, i);
    if (f.kind === 'sub') return f.dlci != null ? [f.dlci] : [];
    const taken = new Set(dev.ifaces.filter((x) => x.port === i && x.kind === 'sub' && x.dlci != null).map((x) => x.dlci));
    const mapped = new Set(frCfg(f).maps.map((m) => m.dlci));
    return [...new Set(local.filter((d) => !taken.has(d)).concat([...mapped]))];
  }

  /** Карты Frame Relay интерфейса: статические и динамические (Inverse ARP). */
  function maps(dev, f) {
    const out = [];
    const cfg = frCfg(f);
    for (const m of cfg.maps) out.push({ ip: m.ip, dlci: m.dlci, broadcast: !!m.broadcast, dynamic: false, status: pvc(dev, f.port, m.dlci).status });
    if (f.kind === 'sub' && f.frType === 'point-to-point') return out;
    if (cfg.noInarp) return out;
    const statics = new Set(cfg.maps.map((m) => m.dlci));
    for (const d of dlcisOf(dev, f)) {
      if (statics.has(d)) continue;
      const s = pvc(dev, f.port, d);
      if (s.status === 'ACTIVE' && s.peer.f.ip != null && U.sameNet(s.peer.f.ip, f.ip || 0, f.mask || 0)) out.push({ ip: s.peer.f.ip, dlci: d, broadcast: true, dynamic: true, status: 'ACTIVE' });
    }
    return out;
  }

  function frIface(dev, f) { return !!f && f.port != null && isFrPort(dev.ports[f.port]) && (f.kind === 'phys' || f.kind === 'sub'); }

  // отправка: next hop → DLCI
  IpNode.hooks.egress.push(function (f, nh, pkt, opts) {
    if (!frIface(this, f)) return false;
    let dlci = null;
    if (f.kind === 'sub' && f.frType === 'point-to-point') dlci = f.dlci;
    else { const m = maps(this, f).find((x) => x.ip === nh); if (m) dlci = m.dlci; }
    if (pkt.dst === U.BROADCAST_IP) return true;
    if (dlci == null) {
      this.note('Frame Relay: нет карты для ' + ip(nh) + ' на ' + f.name + ' (frame-relay map ip … или Inverse ARP)', null, 'drop');
      if (opts && opts.onError) opts.onError('fr', 'Frame Relay: encapsulation failed — нет DLCI для ' + ip(nh));
      return true;
    }
    const frame = { src: null, dst: null, type: 'IPv4', vlan: null, payload: pkt, hops: 0, encap: 'FRAME-RELAY', fr: { dlci } };
    this.ifaceSend(f, frame, ((opts && opts.why) || 'Frame Relay') + ' · DLCI ' + dlci);
    return true;
  });

  // приём: DLCI → подынтерфейс
  const Router = NS.deviceTypes.router;
  const baseRouterRecv = Router.prototype.receive;
  Router.prototype.receive = function (i, frame) {
    const p = this.ports[i];
    if (frame && frame.fr && p && p.media === 'serial') {
      if (p.encap !== 'frame-relay') { this.drop(frame, 'Кадр Frame Relay на ' + p.name + ', а инкапсуляция ' + (p.encap || 'hdlc').toUpperCase() + ' — нужна encapsulation frame-relay'); return; }
      const f = ifaceForDlci(this, i, frame.fr.dlci);
      if (!f || !f.adminUp) { this.drop(frame, 'Интерфейс для DLCI ' + frame.fr.dlci + ' выключен'); return; }
      if (frame.type === 'IPv4') this.onIp(f, frame.payload, frame);
      return;
    }
    return baseRouterRecv.call(this, i, frame);
  };

  /** Для маршрутизации: точки на других концах PVC интерфейса f. */
  function reach(net, dev, f) {
    if (!frIface(dev, f)) return null;
    const points = new Set();
    for (const d of dlcisOf(dev, f)) {
      const s = pvc(dev, f.port, d);
      if (s.status !== 'ACTIVE') continue;
      const g = s.peer.f;
      points.add(s.peer.dev.id + '|' + g.port + '|' + (g.kind === 'sub' ? (g.dlci != null ? 'fr' + g.dlci : g.vlan) : 'u'));
    }
    return points;
  }

  /* ================= CLI ================= */

  // interface Serial0/0/0.102 point-to-point | multipoint
  X.config.unshift((dev, s, a, neg, io, C) => {
    if (!C.kw(a[0], 'interface', 3) || neg || a.length < 3) return false;
    const last = a[a.length - 1].toLowerCase();
    const type = 'point-to-point'.startsWith(last) && last.length >= 5 ? 'point-to-point' : 'multipoint'.startsWith(last) && last.length >= 5 ? 'multipoint' : null;
    if (!type) return false;
    NS.cliIos.exec(dev, s, 'interface ' + a.slice(1, -1).join(' '), io);
    const r = s.ifs && s.ifs[0];
    const f = r && C.ifaceOf(dev, r);
    if (f && f.kind === 'sub') C.withMutate(io, () => { if (f.frType && f.frType !== type) io.out('% Warning: cannot change link type'); else f.frType = type; });
    return true;
  });

  X.iface.unshift((dev, s, a, neg, io, refs, C) => {
    if (dev.type !== 'router') return false;
    const ifs = refs.map((r) => C.ifaceOf(dev, r)).filter(Boolean);
    const serial = (f) => dev.ports[f.port] && dev.ports[f.port].media === 'serial';
    if (C.kw(a[0], 'encapsulation', 3) && C.kw(a[1], 'frame-relay', 1)) {
      if (!ifs.every((f) => f.kind === 'phys' && serial(f))) { io.out('% Frame Relay настраивается на последовательном интерфейсе (interface serial0/0/0)'); return true; }
      C.withMutate(io, () => { for (const f of ifs) { const p = dev.ports[f.port]; p.encap = neg ? 'hdlc' : 'frame-relay'; p.frIetf = !neg && C.kw(a[2], 'ietf', 1); } dev.net.refreshTopology(); dev.net.markRouting(); });
      return true;
    }
    if (!C.kw(a[0], 'frame-relay', 3)) return false;
    const f = ifs[0];
    if (!f || !serial(f)) { io.out('% Команды frame-relay — для последовательного интерфейса или его подынтерфейса'); return true; }
    const sub = a[1];
    if (C.kw(sub, 'map', 1)) {
      const addr = U.parseIp(a[3] || '');
      const dlci = Number(a[4]);
      if (!C.kw(a[2], 'ip', 1) || addr == null) { C.invalid(io, a[3] || a[2] || ''); return true; }
      if (!(Number.isInteger(dlci) && dlci >= 16 && dlci <= 1007)) { if (a[4]) C.invalid(io, a[4]); else C.incomplete(io); return true; }
      if (f.kind === 'sub' && f.frType === 'point-to-point') { io.out('% frame-relay map не используется на подынтерфейсе point-to-point — задайте frame-relay interface-dlci'); return true; }
      C.withMutate(io, () => {
        const cfg = frCfg(f);
        cfg.maps = cfg.maps.filter((m) => m.ip !== addr);
        if (!neg) cfg.maps.push({ ip: addr, dlci, broadcast: a.slice(5).some((x) => C.kw(x, 'broadcast', 1)) });
        dev.net.markRouting();
      });
      return true;
    }
    if (C.kw(sub, 'interface-dlci', 3)) {
      const dlci = Number(a[2]);
      if (!neg && !(Number.isInteger(dlci) && dlci >= 16 && dlci <= 1007)) { if (a[2]) C.invalid(io, a[2]); else C.incomplete(io); return true; }
      if (f.kind !== 'sub') { io.out('% frame-relay interface-dlci задаётся на подынтерфейсе (interface serial0/0/0.102 point-to-point)'); return true; }
      const other = !neg && dev.ifaces.find((x) => x !== f && x.port === f.port && x.dlci === dlci);
      if (other) { io.out('% DLCI ' + dlci + ' уже назначен ' + other.name); return true; }
      C.withMutate(io, () => { f.dlci = neg ? null : dlci; dev.net.markRouting(); });
      return true;
    }
    if (C.kw(sub, 'lmi-type', 1)) {
      const t = ['cisco', 'ansi', 'q933a'].find((x) => C.kw(a[2], x, 1));
      if (!t && !neg) { C.invalid(io, a[2] || ''); return true; }
      C.withMutate(io, () => { frCfg(f).lmi = neg ? null : t; });
      return true;
    }
    if (C.kw(sub, 'inverse-arp', 2)) { C.withMutate(io, () => { frCfg(f).noInarp = !!neg; dev.net.markRouting(); }); return true; }
    C.invalid(io, sub || '');
    return true;
  });

  X.running.iface.push((dev, f) => {
    if (!f || !f.fr && f.dlci == null) return [];
    const L = [];
    if (f.dlci != null) L.push(' frame-relay interface-dlci ' + f.dlci);
    const c = f.fr || {};
    if (c.lmi) L.push(' frame-relay lmi-type ' + c.lmi);
    for (const m of c.maps || []) L.push(' frame-relay map ip ' + ip(m.ip) + ' ' + m.dlci + (m.broadcast ? ' broadcast' : ''));
    if (c.noInarp) L.push(' no frame-relay inverse-arp');
    return L;
  });

  const hexDlci = (d) => '0x' + d.toString(16).toUpperCase() + ',0x' + (((d >> 4) << 10) | ((d & 15) << 4)).toString(16).toUpperCase();

  X.show.push((dev, s, a, io, C) => {
    if (dev.type !== 'router' || !C.kw(a[0], 'frame-relay', 3)) return false;
    const ports = dev.ports.map((p, i) => i).filter((i) => isFrPort(dev.ports[i]));
    if (C.kw(a[1], 'pvc', 1)) {
      for (const i of ports) {
        const main = dev.ifaces.find((x) => x.port === i && x.kind === 'phys');
        const list = localDlcis(dev, i);
        const extra = dev.ifaces.filter((x) => x.port === i).flatMap((x) => (x.dlci != null ? [x.dlci] : []).concat(frCfg(x).maps.map((m) => m.dlci))).filter((d) => !list.includes(d));
        const all = [...new Set(list.concat(extra))].sort((x, y) => x - y);
        const st = all.map((d) => pvc(dev, i, d).status);
        io.out('');
        io.out('PVC Statistics for interface ' + main.name + ' (Frame Relay DTE)');
        io.out('');
        io.out('              Active     Inactive      Deleted       Static');
        io.out('  Local  ' + [st.filter((x) => x === 'ACTIVE').length, st.filter((x) => x === 'INACTIVE').length, st.filter((x) => x === 'DELETED').length, 0].map((n) => C.pad(String(n).padStart(10), 13)).join(''));
        io.out('');
        all.forEach((d, k) => {
          const f = ifaceForDlci(dev, i, d);
          io.out('DLCI = ' + d + ', DLCI USAGE = LOCAL, PVC STATUS = ' + st[k] + ', INTERFACE = ' + f.name);
          io.out('');
        });
      }
      return true;
    }
    if (C.kw(a[1], 'map', 1)) {
      for (const f of dev.ifaces.filter((x) => frIface(dev, x))) {
        const up = dev.ifaceUp(f) ? 'up' : 'down';
        if (f.kind === 'sub' && f.frType === 'point-to-point') {
          if (f.dlci != null) { io.out(f.name + ' (' + up + '): point-to-point dlci, dlci ' + f.dlci + '(' + hexDlci(f.dlci) + '), broadcast'); io.out('          status defined, ' + pvc(dev, f.port, f.dlci).status.toLowerCase()); }
          continue;
        }
        for (const m of maps(dev, f)) {
          io.out(f.name + ' (' + up + '): ip ' + ip(m.ip) + ' dlci ' + m.dlci + '(' + hexDlci(m.dlci) + '), ' + (m.dynamic ? 'dynamic' : 'static') + ',');
          io.out('              ' + (m.broadcast ? 'broadcast,' : '') + (dev.ports[f.port].frIetf ? '' : ' CISCO,') + ' status defined, ' + m.status.toLowerCase());
        }
      }
      return true;
    }
    if (C.kw(a[1], 'lmi', 1)) {
      for (const i of ports) {
        const main = dev.ifaces.find((x) => x.port === i && x.kind === 'phys');
        const ok = !!cloudEnd(dev, i) && dev.net.isPortOperational(dev, i);
        io.out('');
        io.out('LMI Statistics for interface ' + main.name + ' (Frame Relay DTE) LMI TYPE = ' + String(frCfg(main).lmi || 'cisco').toUpperCase());
        io.out('  Invalid Unnumbered info 0             Invalid Prot Disc 0');
        io.out('  Num Status Enq. Sent ' + (ok ? 42 : 12) + '         Num Status msgs Rcvd ' + (ok ? 42 : 0));
        io.out('  Num Update Status Rcvd 0              Num Status Timeouts ' + (ok ? 0 : 12));
      }
      return true;
    }
    return false;
  });

  X.tree.iface = (X.tree.iface || []).concat(['encapsulation frame-relay', 'frame-relay map ip A.B.C.D WORD broadcast', 'frame-relay interface-dlci WORD', 'frame-relay lmi-type cisco']);
  X.tree.exec = (X.tree.exec || []).concat(['show frame-relay pvc', 'show frame-relay map', 'show frame-relay lmi']);

  NS.deviceExt.push({
    key: 'fr',
    applies: (d) => d.type === 'router',
    save(d) {
      const o = {};
      for (const f of d.ifaces) {
        const e = {};
        if (f.fr && (f.fr.maps.length || f.fr.lmi || f.fr.noInarp)) e.fr = { maps: f.fr.maps.map((m) => ({ ip: ip(m.ip), dlci: m.dlci, broadcast: m.broadcast })), lmi: f.fr.lmi || null, noInarp: !!f.fr.noInarp };
        if (f.dlci != null) e.dlci = f.dlci;
        if (f.frType) e.type = f.frType;
        if (Object.keys(e).length) o[f.name] = e;
      }
      return Object.keys(o).length ? o : null;
    },
    load(d, c) {
      for (const f of d.ifaces) {
        const e = c && c[f.name];
        f.fr = e && e.fr ? { maps: (e.fr.maps || []).map((m) => ({ ip: U.parseIp(m.ip), dlci: Number(m.dlci), broadcast: !!m.broadcast })), lmi: e.fr.lmi || null, noInarp: !!e.fr.noInarp } : null;
        f.dlci = e && e.dlci != null ? Number(e.dlci) : null;
        f.frType = e && e.type ? e.type : null;
      }
    },
  });

  // порт облака: инкапсуляция Frame Relay и тактовая частота (облако — DCE)
  const baseAdd = NS.Network.prototype.addDevice;
  NS.Network.prototype.addDevice = function (type, opts) {
    const d = baseAdd.call(this, type, opts);
    if (d && d.type === 'cloud') initCloudPorts(d);
    return d;
  };

  NS.fr = { reach, maps, pvc, localDlcis, subUp, cloud: CloudApi, FR_PORTS };
})(globalThis.NetLab = globalThis.NetLab || {});
