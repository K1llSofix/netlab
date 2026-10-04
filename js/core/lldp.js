/* NetLab — LLDP (IEEE 802.1AB) на маршрутизаторах и коммутаторах Cisco и CDP на отдельном порту:
 * lldp run (по умолчанию выключен, как в IOS), lldp transmit / lldp receive на интерфейсе,
 * show lldp, show lldp neighbors [detail], show lldp interface; no cdp enable на интерфейсе.
 * Как и CDP в NetLab, соседи вычисляются по кабелям: объявление приходит, если сосед передаёт LLDP
 * со своего порта, а этот порт его принимает. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const X = NS.cliIos.ext;
  const isIosDev = (d) => !!d.ios && (d.type === 'router' || d.type === 'switch');

  const lldpOn = (d) => isIosDev(d) && !!d.lldpRun && d.power;
  const caps = (d) => (d.type === 'router' || (d.spec && d.spec.l3) ? (d.type === 'router' ? 'R' : 'B,R') : 'B');
  const osLine = (d) => (d.type === 'router' ? 'Cisco IOS Software, ' + d.model + ' Software, Version 15.1(4)M4, RELEASE SOFTWARE (fc2)'
    : 'Cisco IOS Software, C' + String(d.model).replace(/-.*$/, '') + ' Software, Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)');

  /** Соседи LLDP устройства: [{ dev, localPort, remotePort, addrs, caps, vlan }]. */
  NS.lldpNeighbors = function (dev) {
    if (!lldpOn(dev)) return [];
    const out = [];
    dev.ports.forEach((p, i) => {
      if (!p.oper || p.media === 'wireless' || p.lldpRx === false) return;
      const pr = dev.net.peer(dev, i);
      if (!pr || !lldpOn(pr.dev)) return;
      const rp = pr.dev.ports[pr.port];
      if (rp.lldpTx === false || !rp.adminUp) return;
      const n = pr.dev;
      const addrs = (n.ifaces || []).filter((f) => f.ip != null && f.kind !== 'loop').map((f) => f.ip);
      out.push({ dev: n, localPort: p.name, remotePort: rp.name, addrs, caps: caps(n), vlan: rp.mode === 'access' ? rp.vlan : 1, mac: n.ports[pr.port].mac });
    });
    return out;
  };

  // CDP: сосед не виден, если CDP выключен на любом из двух портов (no cdp enable)
  const cdp0 = NS.cdpNeighbors;
  NS.cdpNeighbors = function (dev) {
    return cdp0(dev).filter((n) => {
      const lp = dev.ports.find((p) => p.name === n.localPort);
      const rp = n.dev.ports.find((p) => p.name === n.remotePort);
      return !(lp && lp.cdpOff) && !(rp && rp.cdpOff);
    });
  };

  /* ---------- команды ---------- */

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isIosDev(dev) || !C.kw(a[0], 'lldp', 3)) return false;
    if (C.kw(a[1], 'run', 1)) { C.withMutate(io, () => { dev.lldpRun = !neg; }); return true; }
    if (C.kw(a[1], 'timer', 1) || C.kw(a[1], 'holdtime', 1) || C.kw(a[1], 'reinit', 1)) return true;
    if (a[1]) C.invalid(io, a[1]); else C.incomplete(io);
    return true;
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (!isIosDev(dev)) return false;
    const ports = targets.filter((r) => r.kind === 'port' && r.sub == null).map((r) => r.port);
    if (C.kw(a[0], 'lldp', 3)) {
      const k = C.kw(a[1], 'transmit', 1) ? 'lldpTx' : C.kw(a[1], 'receive', 1) ? 'lldpRx' : null;
      if (!k) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return true; }
      C.withMutate(io, () => { for (const i of ports) { if (neg) dev.ports[i][k] = false; else delete dev.ports[i][k]; } });
      return true;
    }
    if (C.kw(a[0], 'cdp', 2) && C.kw(a[1], 'enable', 1)) {
      C.withMutate(io, () => { for (const i of ports) { if (neg) dev.ports[i].cdpOff = true; else delete dev.ports[i].cdpOff; } });
      return true;
    }
    return false;
  });

  X.running.global.push((dev) => (isIosDev(dev) && dev.lldpRun ? ['lldp run', '!'] : []));
  X.running.iface.push((dev, f, p) => {
    if (!p || !isIosDev(dev)) return [];
    const L = [];
    if (p.cdpOff) L.push(' no cdp enable');
    if (p.lldpTx === false) L.push(' no lldp transmit');
    if (p.lldpRx === false) L.push(' no lldp receive');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!isIosDev(dev) || !C.kw(a[0], 'lldp', 3)) return false;
    if (!dev.lldpRun) { io.out('% LLDP is not enabled'); return true; }
    const sh = (n) => C.shortIf(n);
    if (!a[1]) {
      io.out('');
      io.out('Global LLDP Information:');
      io.out('    Status: ACTIVE');
      io.out('    LLDP advertisements are sent every 30 seconds');
      io.out('    LLDP hold time advertised is 120 seconds');
      io.out('    LLDP interface reinitialisation delay is 2 seconds');
      return true;
    }
    if (C.kw(a[1], 'interface', 1)) {
      for (const p of dev.ports) {
        if (!NS.Network.isData(p)) continue;
        io.out('');
        io.out(p.name + ':');
        io.out('    Tx: ' + (p.lldpTx === false ? 'disabled' : 'enabled'));
        io.out('    Rx: ' + (p.lldpRx === false ? 'disabled' : 'enabled'));
        io.out('    Tx state: ' + (p.oper ? 'IDLE' : 'INIT'));
        io.out('    Rx state: ' + (p.oper ? 'WAIT FOR FRAME' : 'WAIT PORT OPER'));
      }
      return true;
    }
    if (!C.kw(a[1], 'neighbors', 1) && !C.kw(a[1], 'entry', 1)) { C.invalid(io, a[1]); return true; }
    const list = NS.lldpNeighbors(dev);
    if (C.kw(a[2], 'detail', 1) || C.kw(a[1], 'entry', 1)) {
      const only = C.kw(a[1], 'entry', 1) ? String(a[2] || '').toLowerCase() : null;
      let n0 = 0;
      for (const n of list) {
        if (only && n.dev.ios.hostname.toLowerCase() !== only) continue;
        n0++;
        io.out('------------------------------------------------');
        io.out('Chassis id: ' + U.ciscoMac(n.mac));
        io.out('Port id: ' + sh(n.remotePort));
        io.out('Port Description: ' + n.remotePort);
        io.out('System Name: ' + n.dev.ios.hostname);
        io.out('');
        io.out('System Description: ');
        io.out(osLine(n.dev));
        io.out('');
        io.out('Time remaining: 98 seconds');
        io.out('System Capabilities: ' + n.caps);
        io.out('Enabled Capabilities: ' + n.caps);
        io.out('Management Addresses:');
        if (n.addrs.length) for (const x of n.addrs) io.out('    IP: ' + U.ipStr(x));
        else io.out('    - not advertised');
        io.out('Auto Negotiation - supported, enabled');
        io.out('Physical media capabilities:');
        io.out('    100base-TX(FD)');
        io.out('Media Attachment Unit type: 16');
        io.out('Vlan ID: ' + n.vlan);
        io.out('');
      }
      io.out('Total entries displayed: ' + n0);
      return true;
    }
    io.out('Capability codes:');
    io.out('    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device');
    io.out('    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other');
    io.out('');
    io.out(C.pad('Device ID', 20) + C.pad('Local Intf', 15) + C.pad('Hold-time', 11) + C.pad('Capability', 16) + 'Port ID');
    for (const n of list) io.out(C.pad(n.dev.ios.hostname, 20) + C.pad(sh(n.localPort), 15) + C.pad('120', 11) + C.pad(n.caps, 16) + sh(n.remotePort));
    io.out('');
    io.out('Total entries displayed: ' + list.length);
    return true;
  });

  NS.deviceExt.push({
    key: 'lldp',
    applies: isIosDev,
    save(d) {
      const ports = {};
      for (const p of d.ports) {
        const o = {};
        if (p.lldpTx === false) o.tx = false;
        if (p.lldpRx === false) o.rx = false;
        if (p.cdpOff) o.cdp = false;
        if (Object.keys(o).length) ports[p.name] = o;
      }
      return d.lldpRun || Object.keys(ports).length ? { run: !!d.lldpRun, ports } : null;
    },
    load(d, c) {
      d.lldpRun = !!(c && c.run);
      for (const p of d.ports) {
        const o = (c && c.ports && c.ports[p.name]) || {};
        if (o.tx === false) p.lldpTx = false; else delete p.lldpTx;
        if (o.rx === false) p.lldpRx = false; else delete p.lldpRx;
        if (o.cdp === false) p.cdpOff = true; else delete p.cdpOff;
      }
    },
  });

  X.tree.config = (X.tree.config || []).concat(['lldp run']);
  X.tree.if = (X.tree.if || []).concat(['lldp transmit', 'lldp receive', 'cdp enable']);
  X.tree.exec = (X.tree.exec || []).concat(['show lldp', 'show lldp neighbors', 'show lldp neighbors detail', 'show lldp interface']);
})(globalThis.NetLab = globalThis.NetLab || {});
