/* NetLab — NetFlow: учёт потоков на интерфейсах маршрутизатора (ip flow ingress/egress),
 * кэш потоков (show ip cache flow), экспорт на коллектор по UDP (ip flow-export destination),
 * коллектор на ПК/сервере (программа Netflow Collector). */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const EXPORT_DELAY = 300; // тиков: активный тайм-аут экспорта (3 с модели)
  const MAX_FLOWS = 2000;
  const KEEP_RECORDS = 1000;

  function nfCfg(dev) {
    if (!dev.netflow) dev.netflow = { dest: null, port: 9996, version: 9, source: null };
    return dev.netflow;
  }

  function flowKey(pkt) {
    const l4 = pkt.payload || {};
    const sp = pkt.proto === 'TCP' || pkt.proto === 'UDP' ? l4.sport : 0;
    const dp = pkt.proto === 'TCP' || pkt.proto === 'UDP' ? l4.dport : pkt.proto === 'ICMP' ? 0 : 0;
    return { sp, dp };
  }

  const PROTO_NUM = { ICMP: 1, TCP: 6, UDP: 17, GRE: 47, ESP: 50 };

  /** Учесть пакет в кэше потоков. */
  IpNode.prototype.flowCount = function (inIf, outIf, pkt) {
    const { sp, dp } = flowKey(pkt);
    const key = [pkt.src, pkt.dst, pkt.proto, sp, dp, inIf ? inIf.name : '', outIf ? outIf.name : ''].join('|');
    let fl = this.flowCache.get(key);
    const bytes = P.sizeOf({ type: 'IPv4', payload: pkt }) - 18;
    if (!fl) {
      if (this.flowCache.size >= MAX_FLOWS) return;
      fl = { src: pkt.src, dst: pkt.dst, proto: pkt.proto, sport: sp, dport: dp, input: inIf ? inIf.name : '', output: outIf ? outIf.name : '', pkts: 0, bytes: 0, first: this.net.time, last: this.net.time, sentPkts: 0, sentBytes: 0 };
      this.flowCache.set(key, fl);
    }
    fl.pkts++;
    fl.bytes += bytes;
    fl.last = this.net.time;
    this.scheduleFlowExport();
  };

  IpNode.prototype.scheduleFlowExport = function () {
    const c = this.netflow;
    if (!c || c.dest == null || this.flowTimer) return;
    this.flowTimer = this.timer(EXPORT_DELAY, () => {
      this.flowTimer = null;
      this.exportFlows();
    });
  };

  /** Отправить коллектору потоки, по которым были новые пакеты. */
  IpNode.prototype.exportFlows = function () {
    const c = this.netflow;
    if (!c || c.dest == null) return 0;
    const recs = [];
    for (const fl of this.flowCache.values()) {
      const dp = fl.pkts - fl.sentPkts;
      if (dp <= 0) continue;
      recs.push({ src: U.ipStr(fl.src), dst: U.ipStr(fl.dst), proto: fl.proto, protoNum: PROTO_NUM[fl.proto] || 0, sport: fl.sport, dport: fl.dport, input: fl.input, output: fl.output, pkts: dp, bytes: fl.bytes - fl.sentBytes, first: fl.first, last: fl.last });
      fl.sentPkts = fl.pkts;
      fl.sentBytes = fl.bytes;
    }
    if (!recs.length) return 0;
    let src = null;
    if (c.source) {
      const f = this.ifaceByName(c.source);
      if (f && f.ip != null) src = f.ip;
    }
    this.flowStats.exported += recs.length;
    this.flowStats.packets++;
    this.sendIp(P.ipv4(src, c.dest, 'UDP', P.udp(this.allocPort(), c.port, { netflow: c.version, exporter: this.ios ? this.ios.hostname : this.name, seq: this.flowStats.packets, records: recs }), this.defaultTtl), {
      why: 'NetFlow v' + c.version + ': экспорт ' + recs.length + ' записей о потоках коллектору ' + U.ipStr(c.dest),
    });
    return recs.length;
  };

  IpNode.hooks.runtime.push(function () {
    this.flowCache = new Map();
    this.flowTimer = null;
    this.flowStats = { exported: 0, packets: 0 };
    this.collected = [];
  });

  IpNode.hooks.ipIn.push(function (f, pkt) {
    if (f.flow && f.flow.in && this.forwarding) this.flowCount(f, null, pkt);
    return false;
  });

  IpNode.hooks.fwdOut.push(function (inIf, outIf, pkt) {
    if (outIf.flow && outIf.flow.out) this.flowCount(inIf, outIf, pkt);
    // заполнить выходной интерфейс у потока, учтённого на входе
    if (inIf.flow && inIf.flow.in) {
      const { sp, dp } = flowKey(pkt);
      const k = [pkt.src, pkt.dst, pkt.proto, sp, dp, inIf.name, ''].join('|');
      const fl = this.flowCache.get(k);
      if (fl && !fl.output) fl.outputSeen = outIf.name;
    }
  });

  IpNode.ifaceExt.push({
    key: 'flow',
    save(f) { return f.flow && (f.flow.in || f.flow.out) ? { in: !!f.flow.in, out: !!f.flow.out } : null; },
    load(f, d) { f.flow = d ? { in: !!d.in, out: !!d.out } : null; },
  });

  NS.deviceExt.push({
    key: 'netflow',
    applies: (d) => d.type === 'router' || d.type === 'switch',
    save(d) {
      const c = d.netflow;
      if (!c || c.dest == null) return null;
      return { dest: U.ipStr(c.dest), port: c.port, version: c.version, source: c.source };
    },
    load(d, c) {
      d.netflow = null;
      if (!c || !c.dest) return;
      d.netflow = { dest: U.parseIp(c.dest), port: Number(c.port) || 9996, version: Number(c.version) === 5 ? 5 : 9, source: c.source || null };
    },
  });

  /* ================= коллектор ================= */

  /** Включить/выключить приём NetFlow на узле (ПК, сервер). */
  IpNode.prototype.setCollector = function (enabled, port) {
    const p = Number(port) || 9996;
    if (!(p >= 1 && p <= 65535)) throw new Error('Порт: 1–65535');
    const old = this.collector;
    if (old && old.port) this.udp.delete(old.port);
    this.collector = { enabled: !!enabled, port: p };
    this.bindCollector();
  };

  IpNode.prototype.bindCollector = function () {
    const c = this.collector;
    if (!c || !c.enabled) return;
    this.udp.set(c.port, (pkt, f, frame) => {
      const d = pkt.payload.data || {};
      if (!d.netflow) { this.portClosed(pkt, f, frame); return; }
      for (const r of d.records || []) {
        this.collected.push(Object.assign({ exporter: d.exporter, exporterIp: U.ipStr(pkt.src), version: d.netflow, time: this.net.time }, r));
      }
      if (this.collected.length > KEEP_RECORDS) this.collected.splice(0, this.collected.length - KEEP_RECORDS);
      this.note('NetFlow: получено записей: ' + (d.records || []).length + ' от ' + d.exporter, null, 'accept');
    });
  };

  IpNode.hooks.bind.push(function () { if (this.collector) this.bindCollector(); });

  NS.deviceExt.push({
    key: 'collector',
    applies: (d) => !!d.sendMail,
    save(d) { return d.collector && d.collector.enabled ? { enabled: true, port: d.collector.port } : null; },
    load(d, c) {
      d.collector = c ? { enabled: !!c.enabled, port: Number(c.port) || 9996 } : null;
      if (d.udp) d.bindCollector();
    },
  });

  /* ================= описание пакетов ================= */

  P.register({
    protocols: { NETFLOW: { label: 'NetFlow', color: '#7c3aed' } },
    classify(f) {
      if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'UDP') return null;
      const d = (f.payload.payload || {}).data;
      return d && d.netflow ? 'NETFLOW' : null;
    },
    summary(f) {
      if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'UDP') return null;
      const d = (f.payload.payload || {}).data;
      if (!d || !d.netflow) return null;
      return 'NetFlow v' + d.netflow + ' от ' + d.exporter + ': записей ' + (d.records || []).length + ', ' + U.ipStr(f.payload.src) + ' → ' + U.ipStr(f.payload.dst);
    },
    extraLayers(f, out) {
      if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'UDP') return;
      const d = (f.payload.payload || {}).data;
      if (!d || !d.netflow) return;
      const fields = [['Версия', String(d.netflow)], ['Экспортёр', d.exporter], ['Номер пакета', String(d.seq)], ['Записей', String((d.records || []).length)]];
      for (const r of (d.records || []).slice(0, 8)) fields.push([r.src + ' → ' + r.dst, r.proto + (r.dport ? ' :' + r.dport : '') + ', пакетов ' + r.pkts + ', байт ' + r.bytes]);
      out.push({ title: 'NetFlow (уровень 7)', fields });
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;
  X.global.push((t) => /^ip$/i.test(t[0] || '') && /^flow-export$/i.test(t[1] || ''));

  X.config.push((dev, s, a, neg, io, C) => {
    if (!C.kw(a[0], 'ip', 2) || !C.kw(a[1], 'flow-export', 6)) return false;
    const c = nfCfg(dev);
    if (C.kw(a[2], 'destination', 1)) {
      if (neg) { C.withMutate(io, () => { c.dest = null; }); return true; }
      const ip = U.parseIp(a[3] || '');
      const port = Number(a[4]);
      if (ip == null) { C.invalid(io, a[3]); return true; }
      if (!(port >= 1 && port <= 65535)) { C.incomplete(io); return true; }
      C.withMutate(io, () => { c.dest = ip; c.port = port; });
      return true;
    }
    if (C.kw(a[2], 'version', 1)) { C.withMutate(io, () => { c.version = Number(a[3]) === 5 ? 5 : 9; }); return true; }
    if (C.kw(a[2], 'source', 1)) {
      if (neg) { C.withMutate(io, () => { c.source = null; }); return true; }
      const r = C.parseIfName(dev, a.slice(3).join(''));
      const f = r && C.ifaceOf(dev, r);
      if (!f) { C.invalid(io, a[3]); return true; }
      C.withMutate(io, () => { c.source = f.name; });
      return true;
    }
    C.invalid(io, a[2]);
    return true;
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (!C.kw(a[0], 'ip', 2) || !C.kw(a[1], 'flow', 4) || C.kw(a[1], 'flow-export', 6)) return false;
    const dir = C.kw(a[2], 'ingress', 1) ? 'in' : C.kw(a[2], 'egress', 1) ? 'out' : null;
    if (!dir) { C.incomplete(io); return true; }
    C.withMutate(io, () => {
      for (const r of targets) {
        const f = C.ifaceOf(dev, r);
        if (!f) continue;
        if (!f.flow) f.flow = { in: false, out: false };
        f.flow[dir] = !neg;
      }
    });
    return true;
  });

  X.running.iface.push((dev, f) => {
    if (!f || !f.flow) return [];
    const L = [];
    if (f.flow.in) L.push(' ip flow ingress');
    if (f.flow.out) L.push(' ip flow egress');
    return L;
  });
  X.running.tail.push((dev) => {
    const c = dev.netflow;
    if (!c || c.dest == null) return [];
    const L = [];
    if (c.source) L.push('ip flow-export source ' + c.source);
    L.push('ip flow-export version ' + c.version);
    L.push('ip flow-export destination ' + U.ipStr(c.dest) + ' ' + c.port, '!');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'ip', 2) || !C.kw(a[1], 'flow', 4) && !C.kw(a[1], 'cache', 2)) return false;
    if (C.kw(a[1], 'cache', 2)) {
      const flows = [...dev.flowCache.values()];
      const pk = flows.reduce((x, f) => x + f.pkts, 0);
      io.out('IP packet size distribution (' + pk + ' total packets):');
      io.out('');
      io.out('IP Flow Switching Cache, 278544 bytes');
      io.out('  ' + flows.length + ' active, ' + (4096 - flows.length) + ' inactive, ' + flows.length + ' added');
      io.out('');
      io.out('SrcIf          SrcIPaddress    DstIf          DstIPaddress    Pr SrcP DstP  Pkts');
      const hex = (n) => (n || 0).toString(16).toUpperCase().padStart(4, '0');
      for (const f of flows) {
        io.out(C.pad(C.shortIf(f.input || 'Local'), 15) + C.pad(U.ipStr(f.src), 16) + C.pad(C.shortIf(f.output || f.outputSeen || 'Null'), 15) + C.pad(U.ipStr(f.dst), 16) +
          (PROTO_NUM[f.proto] || 0).toString(16).toUpperCase().padStart(2, '0') + ' ' + hex(f.sport) + ' ' + hex(f.dport) + ' ' + C.padL(f.pkts, 5));
      }
      return true;
    }
    if (C.kw(a[2], 'export', 1)) {
      const c = dev.netflow;
      io.out('Flow export v' + (c ? c.version : 9) + ' is ' + (c && c.dest != null ? 'enabled' : 'disabled') + ' for main cache');
      if (c && c.dest != null) {
        io.out('  Export source and destination details :');
        io.out('  VRF ID : Default');
        io.out('    Destination(1)  ' + U.ipStr(c.dest) + ' (' + c.port + ')' + (c.source ? ' source ' + c.source : ''));
      }
      io.out('  ' + dev.flowStats.exported + ' flows exported in ' + dev.flowStats.packets + ' udp datagrams');
      return true;
    }
    if (C.kw(a[2], 'interface', 1)) {
      for (const f of dev.ifaces) {
        if (!f.flow || (!f.flow.in && !f.flow.out)) continue;
        io.out(f.name);
        if (f.flow.in) io.out('  ip flow ingress');
        if (f.flow.out) io.out('  ip flow egress');
      }
      return true;
    }
    C.invalid(io, a[2]);
    return true;
  });

  X.exec.push((dev, s, t, io, line, C) => {
    if (s.mode !== 'exec' || !C.kw(t[0], 'clear', 3) || !C.kw(t[1], 'ip', 2) || !C.kw(t[2], 'flow', 4)) return null;
    dev.flowCache.clear();
    return { handled: true };
  });

  X.tree.config = (X.tree.config || []).concat(['ip flow-export destination A.B.C.D WORD', 'ip flow-export version WORD', 'ip flow-export source WORD']);
  X.tree.if = (X.tree.if || []).concat(['ip flow ingress', 'ip flow egress']);
  X.tree.exec = (X.tree.exec || []).concat(['show ip cache flow', 'show ip flow export', 'show ip flow interface', 'clear ip flow stats']);
})(globalThis.NetLab = globalThis.NetLab || {});
