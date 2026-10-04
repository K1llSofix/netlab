/* NetLab — SPAN (зеркалирование портов) на коммутаторе и анализатор трафика Sniffer-PT.
 * monitor session N source interface … [rx|tx|both] | source vlan V [rx], monitor session N destination interface … [encapsulation replicate],
 * no monitor session N|all, show monitor [session N]. Порт-получатель не участвует в коммутации: на него идут только копии.
 * Sniffer-PT захватывает все кадры, пришедшие на его порт (подключите его к порту-получателю SPAN или к концентратору),
 * и сохраняет захват в .pcap для Wireshark. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const M = NS.models;
  const Switch = NS.Switch;
  const X = NS.cliIos.ext;

  /* ================= SPAN ================= */

  const sessions = (dev) => dev.span || (dev.span = {});
  const isDst = (dev, j) => !!dev.span && Object.values(dev.span).some((s) => s.dst != null && s.dst === j);

  function mirror(dev, frame, vlan, dir, i, why) {
    if (!dev.span) return;
    for (const [n, s] of Object.entries(dev.span)) {
      if (s.dst == null || s.dst === i) continue;
      const bySrc = s.src.find((x) => x.port === i && (x.dir === 'both' || x.dir === dir));
      const byVlan = s.vlans.find((x) => x.vlan === vlan && (x.dir === 'both' || x.dir === dir));
      if (!bySrc && !byVlan) continue;
      const p = dev.ports[s.dst];
      if (!p || !p.oper) continue;
      const copy = Object.assign({}, frame, { vlan: s.replicate ? vlan : null, spanCopy: true });
      dev.send(s.dst, copy, 'SPAN (session ' + n + '): копия кадра ' + (dir === 'rx' ? 'принятого на ' : 'отправленного в ') + dev.ports[i].name + ' → ' + p.name + (why ? ' · ' + why : ''));
    }
  }

  Switch.ingress.push(function (i, port, vlan, frame) {
    if (!this.span) return true;
    if (isDst(this, i)) { this.drop(frame, 'SPAN: ' + port.name + ' — порт-получатель зеркала, входящий трафик не коммутируется'); return false; }
    if (!frame.spanCopy) mirror(this, frame, vlan, 'rx', i);
    return true;
  });

  const egress0 = Switch.prototype.egress;
  Switch.prototype.egress = function (j, vlan, frame, why) {
    if (this.span && isDst(this, j)) return false; // на порт-получатель — только копии
    const r = egress0.call(this, j, vlan, frame, why);
    if (r && this.span && !frame.spanCopy) mirror(this, frame, vlan, 'tx', j);
    return r;
  };

  function portsOf(dev, a, C) {
    // «fa0/1», «fa0/1 - 3», «fa0/1 , fa0/5», «fa0/1-3»
    const str = a.join(' ').replace(/\s*,\s*/g, ',');
    const out = [];
    for (const part of str.split(',')) {
      const m = /^(.*?)(\d+)\s*-\s*(\d+)$/.exec(part.trim());
      const names = m ? Array.from({ length: Math.max(0, Number(m[3]) - Number(m[2]) + 1) }, (_, k) => m[1] + (Number(m[2]) + k)) : [part.trim()];
      for (const nm of names) {
        const r = C.parseIfName(dev, nm);
        if (!r || r.kind !== 'port') return null;
        out.push(r.port);
      }
    }
    return out;
  }

  X.config.push((dev, s, a, neg, io, C) => {
    if (dev.type !== 'switch' || !C.kw(a[0], 'monitor', 3)) return false;
    if (!C.kw(a[1], 'session', 1)) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return true; }
    const S = sessions(dev);
    if (neg && C.kw(a[2], 'all', 1)) { C.withMutate(io, () => { dev.span = {}; }); return true; }
    const n = Number(a[2]);
    if (!(Number.isInteger(n) && n >= 1 && n <= 66)) { if (a[2]) C.invalid(io, a[2]); else C.incomplete(io); return true; }
    if (neg && !a[3]) { C.withMutate(io, () => { delete S[n]; }); return true; }
    const sess = () => S[n] || (S[n] = { src: [], vlans: [], dst: null, replicate: false });
    const rest = a.slice(4);
    let dir = 'both';
    const last = String(rest[rest.length - 1] || '').toLowerCase();
    if (['rx', 'tx', 'both'].includes(last)) { dir = last; rest.pop(); }
    if (C.kw(a[3], 'source', 2)) {
      if (C.kw(rest[0], 'interface', 1)) {
        const ports = portsOf(dev, rest.slice(1), C);
        if (!ports || !ports.length) { C.incomplete(io); return true; }
        const x = sess();
        if (!neg && ports.includes(x.dst)) { io.out('% Interface(s) ' + dev.ports[x.dst].name + ' already configured as monitor destinations'); return true; }
        C.withMutate(io, () => {
          x.src = x.src.filter((y) => !ports.includes(y.port));
          if (!neg) for (const p of ports) x.src.push({ port: p, dir });
        });
        return true;
      }
      if (C.kw(rest[0], 'vlan', 1)) {
        const vl = [...U.parseVlanList(rest.slice(1).join(''))];
        if (!vl.length) { C.incomplete(io); return true; }
        const x = sess();
        C.withMutate(io, () => { x.vlans = x.vlans.filter((y) => !vl.includes(y.vlan)); if (!neg) for (const v of vl) x.vlans.push({ vlan: v, dir }); });
        return true;
      }
      C.invalid(io, rest[0]);
      return true;
    }
    if (C.kw(a[3], 'destination', 1)) {
      if (!C.kw(rest[0], 'interface', 1)) { if (rest[0]) C.invalid(io, rest[0]); else C.incomplete(io); return true; }
      const rep = rest.findIndex((x) => C.kw(x, 'encapsulation', 1));
      const replicate = rep > 0 && C.kw(rest[rep + 1], 'replicate', 1);
      const ports = portsOf(dev, rest.slice(1, rep > 0 ? rep : undefined), C);
      if (!ports || ports.length !== 1) { C.incomplete(io); return true; }
      const x = sess();
      if (neg) { C.withMutate(io, () => { if (x.dst === ports[0]) x.dst = null; }); return true; }
      if (x.src.some((y) => y.port === ports[0])) { io.out('% Interface ' + dev.ports[ports[0]].name + ' already configured as monitor source'); return true; }
      C.withMutate(io, () => { x.dst = ports[0]; x.replicate = replicate; });
      dev.net.refreshTopology();
      return true;
    }
    C.invalid(io, a[3]);
    return true;
  });

  X.running.global.push((dev) => {
    if (dev.type !== 'switch' || !dev.span) return [];
    const L = [];
    for (const [n, x] of Object.entries(dev.span)) {
      const byDir = {};
      for (const y of x.src) (byDir[y.dir] = byDir[y.dir] || []).push(dev.ports[y.port].name);
      for (const [d, l] of Object.entries(byDir)) L.push('monitor session ' + n + ' source interface ' + l.join(' , ') + (d === 'both' ? '' : ' ' + d));
      for (const y of x.vlans) L.push('monitor session ' + n + ' source vlan ' + y.vlan + (y.dir === 'both' ? '' : ' ' + y.dir));
      if (x.dst != null) L.push('monitor session ' + n + ' destination interface ' + dev.ports[x.dst].name + (x.replicate ? ' encapsulation replicate' : ''));
    }
    if (L.length) L.push('!');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (dev.type !== 'switch' || !C.kw(a[0], 'monitor', 3)) return false;
    const only = C.kw(a[1], 'session', 1) && /^\d+$/.test(a[2] || '') ? a[2] : null;
    for (const [n, x] of Object.entries(dev.span || {})) {
      if (only && only !== n) continue;
      io.out('Session ' + n);
      io.out('---------');
      io.out(C.pad('Type', 23) + ': Local Session');
      io.out(C.pad('Source Ports', 23) + ':');
      io.out(C.pad('    RX Only', 23) + ': ' + (x.src.filter((y) => y.dir === 'rx').map((y) => C.shortIf(dev.ports[y.port].name)).join(',') || 'None'));
      io.out(C.pad('    TX Only', 23) + ': ' + (x.src.filter((y) => y.dir === 'tx').map((y) => C.shortIf(dev.ports[y.port].name)).join(',') || 'None'));
      io.out(C.pad('    Both', 23) + ': ' + (x.src.filter((y) => y.dir === 'both').map((y) => C.shortIf(dev.ports[y.port].name)).join(',') || 'None'));
      if (x.vlans.length) io.out(C.pad('Source VLANs', 23) + ': ' + x.vlans.map((y) => y.vlan).join(','));
      io.out(C.pad('Destination Ports', 23) + ': ' + (x.dst != null ? C.shortIf(dev.ports[x.dst].name) : 'None'));
      io.out(C.pad('    Encapsulation', 23) + ': ' + (x.replicate ? 'Replicate' : 'Native'));
      io.out(C.pad('          Ingress', 23) + ': Disabled');
      io.out('');
    }
    if (!Object.keys(dev.span || {}).length) io.out('No SPAN configuration is present in the system.');
    return true;
  });

  NS.deviceExt.push({
    key: 'span',
    applies: (d) => d.type === 'switch',
    save(d) {
      if (!d.span || !Object.keys(d.span).length) return null;
      const name = (i) => (d.ports[i] ? d.ports[i].name : null);
      return Object.fromEntries(Object.entries(d.span).map(([n, x]) => [n, { src: x.src.map((y) => ({ port: name(y.port), dir: y.dir })), vlans: x.vlans.slice(), dst: x.dst != null ? name(x.dst) : null, replicate: !!x.replicate }]));
    },
    load(d, c) {
      d.span = null;
      if (!c) return;
      d.span = {};
      const idx = (nm) => d.portIndex(nm);
      for (const [n, x] of Object.entries(c)) {
        d.span[n] = { src: (x.src || []).map((y) => ({ port: idx(y.port), dir: y.dir || 'both' })).filter((y) => y.port >= 0), vlans: (x.vlans || []).slice(), dst: x.dst ? idx(x.dst) : null, replicate: !!x.replicate };
        if (d.span[n].dst != null && d.span[n].dst < 0) d.span[n].dst = null;
      }
    },
  });

  X.tree.config = (X.tree.config || []).concat(['monitor session WORD source interface WORD', 'monitor session WORD source vlan WORD', 'monitor session WORD destination interface WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show monitor', 'show monitor session WORD']);

  /* ================= Sniffer-PT ================= */

  M.MODELS['Sniffer-PT'] = {
    type: 'sniffer', title: 'Анализатор трафика Sniffer-PT',
    ports: [{ name: 'FastEthernet0', media: 'copper', speed: 100 }],
    slots: [], attrs: { MTBF: 100000, cost: 500, 'power source': 0, 'rack units': 0, wattage: 20 },
  };
  M.DEFAULT_MODEL.sniffer = 'Sniffer-PT';

  const MAX_CAPTURE = 5000;

  class Sniffer extends NS.Device {
    constructor(net, id, name, model) {
      super(net, id, 'sniffer', name, model);
      this.capture = [];
      this.capturing = true;
      this.total = 0;
    }

    receive(i, frame) {
      if (!this.capturing || !this.power) return;
      this.total++;
      let copy;
      try { copy = JSON.parse(JSON.stringify(frame, (k, v) => (typeof v === 'bigint' ? { __big: v.toString(16) } : v)), (k, v) => (v && typeof v === 'object' && typeof v.__big === 'string' && Object.keys(v).length === 1 ? BigInt('0x' + v.__big) : v)); } catch (e) { copy = frame; }
      this.capture.push({ n: this.total, time: this.net.time, frame: copy });
      if (this.capture.length > MAX_CAPTURE) this.capture.shift();
      this.note('Sniffer: захвачен кадр ' + (NS.packets.classify ? NS.packets.classify(frame) : frame.type), frame, 'accept');
      this.net.emit('config', { dev: this });
    }

    clearCapture() { this.capture = []; this.total = 0; this.net.emit('config', { dev: this }); }
    setCapturing(on) { this.capturing = !!on; this.net.emit('config', { dev: this }); }
    pcap() { return NS.pcap.file(this.capture.map((x) => ({ time: x.time, frame: x.frame }))); }

    serializeConfig() { return this.capturing ? {} : { capturing: false }; }
    loadConfig(c) { this.capturing = !(c && c.capturing === false); this.capture = []; this.total = 0; }
  }
  Sniffer.namePrefix = 'Sniffer';
  Sniffer.title = 'Анализатор трафика';
  NS.deviceTypes.sniffer = Sniffer;
  NS.Sniffer = Sniffer;
})(globalThis.NetLab = globalThis.NetLab || {});
