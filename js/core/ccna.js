/* NetLab — команды CCNA 200-301, которых не хватало:
 *  show: interfaces description | ИФ counters | ИФ (L2-порт коммутатора) | ИФ switchport, ip access-lists, ip dhcp conflict, ssh,
 *        crypto key mypubkey rsa, processes cpu, memory, inventory, hosts, terminal, line, license, archive, boot, environment,
 *        platform, sdm prefer, errdisable recovery, mac address-table aging-time;
 *  exec: clear counters, dir [flash:];
 *  config: ip domain lookup | ip domain name, banner login, enable / username … algorithm-type scrypt|sha256 secret,
 *          maximum-paths, mtu / ip mtu, archive, config-register, boot system, ip cef, udld, mac address-table static | aging-time, sdm prefer. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const X = NS.cliIos.ext;
  const isIos = (d) => !!d.ios && d.type !== 'wrouter' && d.type !== 'asa';
  const pad = (s, n) => { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); };
  const padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
  const cfg = (d) => d.ccna || (d.ccna = {});
  /** Выполнить строку CLI в текущем сеансе (перевод новой записи команды в старую). */
  const redo = (dev, s, line, io) => NS.cliIos.exec(dev, s, line, io);

  function ifRows(dev) {
    const rows = [];
    for (const f of dev.ifaces || []) {
      if (f.runtime || f.kind === 'l2') continue;
      const p = f.port >= 0 ? dev.ports[f.port] : null;
      const admin = f.adminUp && (!p || p.adminUp !== false);
      const up = dev.ifaceUp(f);
      rows.push({ name: f.name, st: admin ? (up ? 'up' : 'down') : 'admin down', pr: up ? 'up' : 'down', desc: f.desc || '', p });
    }
    if (dev.type === 'switch') {
      dev.ports.forEach((p, i) => {
        if (!NS.Network.isData(p) || p.routed || p.radio) return;
        const up = dev.net.isPortOperational(dev, i);
        rows.push({ name: p.name, st: p.adminUp === false ? 'admin down' : up ? 'up' : 'down', pr: up ? 'up' : 'down', desc: (p.ccna && p.ccna.desc) || '', p });
      });
    }
    return rows;
  }

  function flashFiles(dev) {
    const img = (dev.ios && dev.ios.image) || (dev.type === 'switch' ? 'c2960-lanbasek9-mz.150-2.SE4.bin' : 'c2900-universalk9-mz.SPA.151-4.M4.bin');
    const L = [{ n: img, size: dev.type === 'switch' ? 4670455 : 33591768 }];
    if (dev.type === 'switch') L.push({ n: 'vlan.dat', size: 616 });
    if (dev.nvram && dev.nvram.text) L.push({ n: 'config.text', size: String(dev.nvram.text).length });
    return L;
  }

  X.show.unshift((dev, s, a, io, C) => {
    if (!isIos(dev)) return false;
    const w = a[0];
    if (C.kw(w, 'interfaces', 3)) {
      if (C.kw(a[1], 'description', 1)) {
        io.out(pad('Interface', 31) + pad('Status', 15) + pad('Protocol', 9) + 'Description');
        for (const r of ifRows(dev)) io.out(pad(C.shortIf(r.name), 31) + pad(r.st, 15) + pad(r.pr, 9) + r.desc);
        return true;
      }
      const last = a[a.length - 1];
      if (a.length >= 2 && C.kw(last, 'counters', 1)) {
        const name = a.slice(1, -1).join('');
        let rows = ifRows(dev).filter((r) => r.p);
        if (name) {
          const pr = C.parseIfName(dev, name);
          const port = pr && pr.port != null ? pr.port : -1;
          rows = rows.filter((r) => dev.ports.indexOf(r.p) === port);
          if (!rows.length) { C.invalid(io, name); return true; }
        }
        io.out(pad('Port', 17) + padL('InOctets', 15) + padL('InUcastPkts', 14) + padL('InMcastPkts', 14) + padL('InBcastPkts', 14));
        for (const r of rows) io.out(pad(C.shortIf(r.name), 17) + padL(r.p.rxBytes || 0, 15) + padL(r.p.rxPkts || 0, 14) + padL(0, 14) + padL(0, 14));
        io.out('');
        io.out(pad('Port', 17) + padL('OutOctets', 15) + padL('OutUcastPkts', 14) + padL('OutMcastPkts', 14) + padL('OutBcastPkts', 14));
        for (const r of rows) io.out(pad(C.shortIf(r.name), 17) + padL(r.p.txBytes || 0, 15) + padL(r.p.txPkts || 0, 14) + padL(0, 14) + padL(0, 14));
        return true;
      }
      return false;
    }
    if (C.kw(w, 'ip', 2) && C.kw(a[1], 'access-lists', 3)) { redo(dev, s, 'show access-lists' + (a[2] ? ' ' + a[2] : ''), io); return true; }
    if (C.kw(w, 'ip', 2) && C.kw(a[1], 'dhcp', 2) && C.kw(a[2], 'conflict', 1)) { io.out('IP address        Detection method   Detection time          VRF'); return true; }
    if (C.kw(w, 'ssh', 2)) { io.out('%No SSHv2 server connections running.'); return true; }
    if (C.kw(w, 'crypto', 2) && C.kw(a[1], 'key', 1)) {
      if (!dev.ios.rsa) return true;
      io.out('% Key pair was generated at: 00:00:00 UTC Mar 1 1993');
      io.out('Key name: ' + dev.ios.hostname + (dev.ios.domain ? '.' + dev.ios.domain : ''));
      io.out('Key type: RSA KEYS');
      io.out(' Storage Device: not specified');
      io.out(' Usage: General Purpose Key');
      io.out(' Key is not exportable.');
      io.out(' Key Data:');
      io.out('  30819F30 0D06092A 864886F7 0D010101 05000381 8D003081 89028181 00C3A1F2');
      return true;
    }
    if (C.kw(w, 'processes', 1)) {
      io.out('CPU utilization for five seconds: 0%/0%; one minute: 0%; five minutes: 0%');
      io.out(' PID Runtime(ms)     Invoked      uSecs   5Sec   1Min   5Min TTY Process');
      io.out('   1           0           5          0  0.00%  0.00%  0.00%   0 Chunk Manager');
      io.out('   2          10         413         24  0.00%  0.00%  0.00%   0 Load Meter');
      io.out('  54           0          48          0  0.00%  0.00%  0.00%   0 IP Input');
      return true;
    }
    if (C.kw(w, 'memory', 3)) {
      const tot = dev.type === 'switch' ? 65158508 : 422612504;
      io.out('                Head    Total(b)     Used(b)     Free(b)   Lowest(b)  Largest(b)');
      io.out('Processor   ' + padL('2A5A3E20', 8) + padL(tot, 12) + padL(Math.round(tot * 0.18), 12) + padL(Math.round(tot * 0.82), 12) + padL(Math.round(tot * 0.8), 12) + padL(Math.round(tot * 0.79), 12));
      io.out('      I/O   ' + padL('3E800000', 8) + padL(25165824, 12) + padL(5963784, 12) + padL(19202040, 12) + padL(19135496, 12) + padL(19157884, 12));
      return true;
    }
    if (C.kw(w, 'inventory', 2)) {
      const pid = dev.type === 'switch' ? 'WS-C' + dev.model : 'CISCO' + String(dev.model).replace(/-.*$/, '') + '/K9';
      io.out('NAME: "' + (dev.type === 'switch' ? '1' : dev.model + ' chassis') + '", DESCR: "' + (dev.type === 'switch' ? 'WS-C' + dev.model : dev.model + ' chassis') + '"');
      io.out('PID: ' + pid + ' , VID: V05 , SN: FTX' + String(dev.id).replace(/\D/g, '').padStart(8, '1'));
      return true;
    }
    if (C.kw(w, 'hosts', 2)) {
      io.out('Default domain is ' + (dev.ios.domain || 'not set'));
      io.out('Name/address lookup uses domain service');
      io.out('Name servers are ' + (dev.dns != null ? U.ipStr(dev.dns) : '255.255.255.255'));
      io.out('');
      io.out('Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate');
      io.out('       temp - temporary, perm - permanent');
      io.out('       NA - Not Applicable None - Not defined');
      io.out('');
      io.out('Host                      Port  Flags      Age Type   Address(es)');
      for (const [n, e] of dev.dnsCache || []) io.out(pad(n, 26) + pad('None', 6) + pad('(temp, OK)', 11) + pad('0', 4) + pad('IP', 7) + U.ipStr(e.ip));
      return true;
    }
    if (C.kw(w, 'terminal', 2)) {
      io.out('Line 0, Location: "", Type: ""');
      io.out('Length: 24 lines, Width: 80 columns');
      io.out('Baud rate (TX/RX) is 9600/9600, no parity, 2 stopbits, 8 databits');
      io.out('Status: PSI Enabled, Ready, Active, Automore On');
      io.out('History is enabled, history size is 10.');
      return true;
    }
    if (C.kw(w, 'line', 2)) {
      io.out('   Tty Typ     Tx/Rx    A Modem  Roty AccO AccI   Uses   Noise  Overruns   Int');
      io.out('*     0 CTY              -    -      -    -    -      0       0     0/0       -');
      for (let i = 0; i < 5; i++) io.out('   ' + padL(2 + i, 3) + ' VTY              -    -      -    -    -      0       0     0/0       -');
      return true;
    }
    if (C.kw(w, 'license', 3)) {
      io.out('Index 1 Feature: ' + (dev.type === 'switch' ? 'lanbase' : 'ipbasek9'));
      io.out('        Period left: Life time');
      io.out('        License Type: Permanent');
      io.out('        License State: Active, In Use');
      io.out('        License Count: Non-Counted');
      io.out('        License Priority: Medium');
      return true;
    }
    if (C.kw(w, 'archive', 2)) {
      const c = cfg(dev).archive;
      io.out('The maximum archive configurations allowed is ' + ((c && c.max) || 10) + '.');
      io.out('There are currently ' + (c && c.path ? 1 : 0) + ' archive configurations saved.');
      io.out('The next archive file will be named ' + (c && c.path ? c.path + '-1' : 'flash:-<timestamp>-0'));
      return true;
    }
    if (C.kw(w, 'boot', 3) || C.kw(w, 'bootvar', 5)) {
      io.out('BOOT variable = ' + (cfg(dev).boot || flashFiles(dev)[0].n.replace(/^/, 'flash:')) + ',12;');
      io.out('CONFIG_FILE variable does not exist');
      io.out('Configuration register is ' + (cfg(dev).confreg || '0x2102'));
      return true;
    }
    if (C.kw(w, 'environment', 3) || C.kw(w, 'env', 3)) { io.out('SYSTEM POWER is OK'); io.out('FAN is OK'); io.out('SYSTEM TEMPERATURE is OK'); io.out('All measured values are normal'); return true; }
    if (C.kw(w, 'platform', 3)) { io.out('Chassis type: ' + dev.model); io.out('Slot      Type                State                 Insert time (ago)'); io.out('0         ' + pad(dev.model, 20) + pad('ok', 22) + '00:10:00'); return true; }
    if (dev.type === 'switch' && C.kw(w, 'sdm', 2)) {
      io.out(' The current template is "' + (cfg(dev).sdm || 'default') + '" template.');
      io.out(' The selected template optimizes the resources in');
      io.out(' the switch to support this level of features for');
      io.out(' 0 routed interfaces and 255 VLANs.');
      if (cfg(dev).sdmNext) io.out(' On next reload, template will be "' + cfg(dev).sdmNext + '" template.');
      return true;
    }
    if (dev.type === 'switch' && C.kw(w, 'errdisable', 3) && C.kw(a[1], 'recovery', 1)) {
      const r = dev.errRecovery || {};
      io.out('ErrDisable Reason            Timer Status');
      io.out('-----------------            --------------');
      for (const c of ['bpduguard', 'psecure-violation', 'storm-control', 'dhcp-rate-limit', 'arp-inspection', 'udld', 'link-flap']) io.out(pad(c, 29) + ((r.causes && (r.causes.includes(c) || r.causes.includes('all'))) ? 'Enabled' : 'Disabled'));
      io.out('');
      io.out('Timer interval: ' + (r.interval || 300) + ' seconds');
      return true;
    }
    if (dev.type === 'switch' && (C.kw(w, 'mac', 1) || C.kw(w, 'mac-address-table', 4)) && a.some((x) => C.kw(x, 'aging-time', 1))) {
      io.out('Global Aging Time:  ' + (cfg(dev).macAging || 300));
      io.out('Vlan    Aging Time');
      io.out('----    ----------');
      return true;
    }
    return false;
  });

  // show interfaces ИФ на L2-порту коммутатора и show interfaces ИФ switchport
  X.show.unshift((dev, s, a, io, C) => {
    if (dev.type !== 'switch' || !C.kw(a[0], 'interfaces', 3) || a.length < 2) return false;
    const last = a[a.length - 1];
    const sw = C.kw(last, 'switchport', 2);
    if (sw && a.length === 2) return false;
    const name = (sw ? a.slice(1, -1) : a.slice(1)).join('');
    if (!sw && /^(trunk|status|description|counters|switchport)/i.test(name)) return false;
    const pr = C.parseIfName(dev, name);
    const i = pr && pr.port != null ? pr.port : -1;
    const p = dev.ports[i];
    if (!p || p.routed || (pr.kind && pr.kind !== 'port' && pr.kind !== 'named') || pr.sub != null) return false;
    if (sw) {
      // полный вывод show interfaces switchport — только нужный порт
      const lines = [];
      redo(dev, s, 'show interfaces switchport', { out: (l) => lines.push(String(l)), write() {}, clear() {}, done() {}, mutate: io.mutate });
      const short = C.shortIf(p.name);
      let on = false;
      for (const l of lines) {
        if (/^Name: /.test(l)) on = l === 'Name: ' + short;
        if (on) io.out(l);
      }
      return true;
    }
    const up = dev.net.isPortOperational(dev, i);
    const st = p.adminUp === false ? ['administratively down', 'down'] : up ? ['up', 'up'] : ['down', 'down'];
    io.out(p.name + ' is ' + st[0] + ', line protocol is ' + st[1] + (p.errDisabled ? ' (err-disabled)' : up ? ' (connected)' : ' (notconnect)'));
    io.out('  Hardware is ' + (p.speed >= 1000 ? 'Gigabit Ethernet' : 'Fast Ethernet') + ', address is ' + U.ciscoMac(p.mac) + ' (bia ' + U.ciscoMac(p.mac) + ')');
    if (p.ccna && p.ccna.desc) io.out('  Description: ' + p.ccna.desc);
    io.out('  MTU 1500 bytes, BW ' + Math.round(NS.portSpeed(p) * 1000) + ' Kbit/sec, DLY 100 usec,');
    io.out('     reliability 255/255, txload 1/255, rxload 1/255');
    io.out('  Encapsulation ARPA, loopback not set');
    io.out('  ' + (p.duplex === 'auto' || !p.duplex ? 'Full' : p.duplex[0].toUpperCase() + p.duplex.slice(1)) + '-duplex, ' + NS.portSpeed(p) + 'Mb/s, media type is 10/100/1000BaseTX');
    io.out('  ' + (p.rxPkts || 0) + ' packets input, ' + (p.rxBytes || 0) + ' bytes, 0 no buffer');
    io.out('     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored');
    io.out('  ' + (p.txPkts || 0) + ' packets output, ' + (p.txBytes || 0) + ' bytes, 0 underruns');
    io.out('     0 output errors, 0 collisions, 0 interface resets');
    return true;
  });

  X.exec.push((dev, s, t, io) => {
    if (!isIos(dev)) return null;
    const C = NS.cliIos.ctx;
    if (C.kw(t[0], 'clear', 3) && C.kw(t[1], 'counters', 1)) {
      for (const p of dev.ports) { p.txPkts = 0; p.txBytes = 0; p.rxPkts = 0; p.rxBytes = 0; }
      io.out('Clear "show interface" counters on all interfaces [confirm]');
      return { handled: true };
    }
    if (C.kw(t[0], 'dir', 3)) {
      if (s.mode !== 'exec') { C.invalid(io, t[0]); return { handled: true }; }
      const files = flashFiles(dev);
      io.out('Directory of flash:/');
      io.out('');
      files.forEach((f, i) => io.out(padL(i + 1, 5) + '  -rw-  ' + padL(f.size, 10) + '  <no date>  ' + f.n));
      const total = dev.type === 'switch' ? 64016384 : 255744000;
      io.out('');
      io.out(total + ' bytes total (' + (total - files.reduce((x, f) => x + f.size, 0)) + ' bytes free)');
      return { handled: true };
    }
    return null;
  });

  /* ---------- конфигурация ---------- */

  const ROUTER_MODES = /^(ospf|rip|eigrp|router|bgp|eigrp6|ospf6|rip6|rtr)/;

  X.config.unshift((dev, s, a, neg, io, C) => {
    if (!isIos(dev)) return false;
    const raw = (neg ? 'no ' : '') + a.join(' ');
    // новая запись: ip domain lookup / ip domain name X
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'domain', 6) && a[1].toLowerCase() === 'domain' && a[2]) {
      if (C.kw(a[2], 'lookup', 1)) { redo(dev, s, (neg ? 'no ' : '') + 'ip domain-lookup', io); return true; }
      if (C.kw(a[2], 'name', 1)) { redo(dev, s, (neg ? 'no ' : '') + 'ip domain-name ' + a.slice(3).join(' '), io); return true; }
    }
    // enable algorithm-type scrypt|sha256 secret X, username U [privilege N] algorithm-type T secret X
    if (!neg && (C.kw(a[0], 'enable', 2) || C.kw(a[0], 'username', 3)) && a.some((x) => C.kw(x, 'algorithm-type', 3))) {
      const k = a.findIndex((x) => C.kw(x, 'algorithm-type', 3));
      if (!/^(scrypt|sha256|md5)$/i.test(a[k + 1] || '')) { C.invalid(io, a[k + 1] || ''); return true; }
      redo(dev, s, a.slice(0, k).concat(a.slice(k + 2)).join(' '), io);
      return true;
    }
    // banner login
    if (C.kw(a[0], 'banner', 3) && C.kw(a[1], 'login', 1)) {
      if (neg) { C.withMutate(io, () => { cfg(dev).bannerLogin = ''; }); return true; }
      const rest = raw.replace(/^banner\s+\S+\s*/i, '');
      const d = rest[0];
      const end = d ? rest.indexOf(d, 1) : -1;
      if (!d || end < 0) { C.incomplete(io); return true; }
      C.withMutate(io, () => { cfg(dev).bannerLogin = rest.slice(1, end).trim(); });
      return true;
    }
    if (s.mode !== 'config') return false;
    if (C.kw(a[0], 'archive', 3)) { C.withMutate(io, () => { cfg(dev).archive = neg ? null : cfg(dev).archive || { path: null, max: 10, wm: false }; }); if (!neg) s.mode = 'archive'; return true; }
    if (C.kw(a[0], 'config-register', 3)) {
      if (!neg && !/^0x[0-9a-f]{1,4}$/i.test(a[1] || '')) { C.invalid(io, a[1] || ''); return true; }
      C.withMutate(io, () => { cfg(dev).confreg = neg ? null : a[1].toLowerCase(); });
      return true;
    }
    if (C.kw(a[0], 'boot', 3) && C.kw(a[1], 'system', 2)) { C.withMutate(io, () => { cfg(dev).boot = neg ? null : a.slice(2).join(' ').replace(/^flash\s+/, 'flash:'); }); return true; }
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'cef', 3)) { C.withMutate(io, () => { cfg(dev).noCef = !!neg; }); return true; }
    if (dev.type === 'router' && C.kw(a[0], 'errdisable', 3)) return true;
    if (dev.type === 'switch' && C.kw(a[0], 'udld', 2)) { C.withMutate(io, () => { cfg(dev).udld = neg ? null : C.kw(a[1], 'aggressive', 1) ? 'aggressive' : 'enable'; }); return true; }
    if (dev.type === 'switch' && C.kw(a[0], 'sdm', 2) && C.kw(a[1], 'prefer', 1)) {
      if (!a[2] && !neg) { C.incomplete(io); return true; }
      C.withMutate(io, () => { cfg(dev).sdmNext = neg ? 'default' : a[2]; });
      io.out('Changes to the running SDM preferences have been stored, but cannot take effect until the next reload.');
      io.out('Use \'show sdm prefer\' to see what SDM preference is currently active.');
      return true;
    }
    if (dev.type === 'switch' && (C.kw(a[0], 'mac', 3) || C.kw(a[0], 'mac-address-table', 4))) {
      const b = C.kw(a[0], 'mac-address-table', 4) ? ['mac', 'address-table'].concat(a.slice(1)) : a;
      if (!C.kw(b[1], 'address-table', 2)) return false;
      if (C.kw(b[2], 'aging-time', 1)) {
        const n = Number(b[3]);
        if (!neg && !(n === 0 || (n >= 10 && n <= 1000000))) { C.invalid(io, b[3] || ''); return true; }
        C.withMutate(io, () => { cfg(dev).macAging = neg ? null : n; });
        return true;
      }
      if (C.kw(b[2], 'static', 2)) {
        const mac = U.parseMac ? U.parseMac(b[3] || '') : null;
        const m = mac || parseCiscoMac(b[3]);
        const vi = b.findIndex((x) => C.kw(x, 'vlan', 1));
        const ii = b.findIndex((x) => C.kw(x, 'interface', 1));
        const vlan = Number(b[vi + 1]);
        if (!m) { C.invalid(io, b[3] || ''); return true; }
        if (!(vlan >= 1 && vlan <= 4094)) { C.incomplete(io); return true; }
        const list = cfg(dev).macStatic || (cfg(dev).macStatic = []);
        if (neg) { C.withMutate(io, () => { cfg(dev).macStatic = list.filter((x) => !(x.mac === m && x.vlan === vlan)); dev.macTable.delete(vlan + '|' + m); }); return true; }
        const pr = C.parseIfName(dev, b.slice(ii + 1).join(''));
        if (ii < 0 || !pr || pr.port == null) { C.incomplete(io); return true; }
        C.withMutate(io, () => { const x = { mac: m, vlan, port: pr.port }; cfg(dev).macStatic = list.filter((y) => !(y.mac === m && y.vlan === vlan)).concat([x]); applyStatic(dev); });
        return true;
      }
    }
    return false;
  });

  function parseCiscoMac(s) {
    const h = String(s || '').toLowerCase().replace(/[.:-]/g, '');
    if (!/^[0-9a-f]{12}$/.test(h)) return null;
    return h.toUpperCase().match(/../g).join(':');
  }

  /** Статические MAC-адреса: в таблице без старения. */
  function applyStatic(dev) {
    for (const x of (dev.ccna && dev.ccna.macStatic) || []) dev.macTable.set(x.vlan + '|' + x.mac, { mac: x.mac, vlan: x.vlan, port: x.port, time: Infinity, static: true });
  }
  if (NS.Switch) {
    const baseFlush = NS.Switch.prototype.flushMacTable;
    if (baseFlush) NS.Switch.prototype.flushMacTable = function () { const r = baseFlush.apply(this, arguments); applyStatic(this); return r; };
  }

  // maximum-paths в режимах router ospf / eigrp / rip (ECMP в NetLab не моделируется — значение сохраняется)
  X.routerCmd = (X.routerCmd || []).concat([(dev, s, a, neg, io, C) => {
    if (!C.kw(a[0], 'maximum-paths', 3) || !ROUTER_MODES.test(s.mode || '')) return false;
    const n = Number(a[1]);
    if (!neg && !(n >= 1 && n <= 32)) { C.invalid(io, a[1] || ''); return true; }
    C.withMutate(io, () => { const m = cfg(dev).maxPaths || (cfg(dev).maxPaths = {}); m[s.mode] = neg ? undefined : n; });
    return true;
  }]);

  X.modes.archive = {
    prompt: () => '(config-archive)#',
    tree: ['path WORD', 'write-memory', 'maximum WORD', 'time-period WORD'],
    run(dev, s, t, io, C) {
      const c = cfg(dev).archive;
      if (!c) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'path', 1)) { C.withMutate(io, () => { c.path = neg ? null : a[1]; }); return; }
      if (C.kw(a[0], 'write-memory', 1)) { C.withMutate(io, () => { c.wm = !neg; }); return; }
      if (C.kw(a[0], 'maximum', 1)) { const n = Number(a[1]); if (!neg && !(n >= 1 && n <= 14)) { C.invalid(io, a[1] || ''); return; } C.withMutate(io, () => { c.max = neg ? 10 : n; }); return; }
      if (C.kw(a[0], 'time-period', 1)) return;
      C.invalid(io, a[0]);
    },
  };

  X.global.push((t, s) => /^(archive|config-register|boot|udld|sdm)$/i.test(t[0] || '') || (/^mac$/i.test(t[0] || '') && s && s.mode !== 'if'));

  // mtu / ip mtu на интерфейсе, udld port
  /** Объекты для настроек: L3-интерфейс, иначе порт коммутатора. */
  const holders = (dev, targets, C) => targets.map((r) => C.ifaceOf(dev, r) || (r && r.port != null ? dev.ports[r.port] : null)).filter(Boolean);

  X.iface.unshift((dev, s, a, neg, io, refs, C) => {
    if (!isIos(dev)) return false;
    const targets = holders(dev, refs, C);
    // description на L2-порту коммутатора (у порта нет L3-интерфейса)
    if (dev.type === 'switch' && C.kw(a[0], 'description', 1)) {
      const text = neg ? '' : a.slice(1).join(' ');
      C.withMutate(io, () => {
        for (const r of refs) {
          const f = C.ifaceOf(dev, r);
          if (f) f.desc = text;
          else if (r && r.port != null) { const pp = dev.ports[r.port]; const o = pp.ccna || (pp.ccna = {}); o.desc = text || null; }
        }
      });
      return true;
    }
    if (C.kw(a[0], 'mtu', 2) || (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'mtu', 2))) {
      const v = Number(C.kw(a[0], 'mtu', 2) ? a[1] : a[2]);
      if (!neg && !(v >= 64 && v <= 9216)) { C.invalid(io, String(C.kw(a[0], 'mtu', 2) ? a[1] : a[2] || '')); return true; }
      const key = C.kw(a[0], 'mtu', 2) ? 'mtu' : 'ipMtu';
      C.withMutate(io, () => { for (const f of targets) { const o = f.ccna || (f.ccna = {}); o[key] = neg ? null : v; } });
      return true;
    }
    if (dev.type === 'switch' && C.kw(a[0], 'udld', 2)) {
      C.withMutate(io, () => { for (const f of targets) { const o = f.ccna || (f.ccna = {}); o.udld = neg ? null : C.kw(a[2], 'aggressive', 1) ? 'aggressive' : 'enable'; } });
      return true;
    }
    return false;
  });

  X.running.global.push((dev) => {
    const c = dev.ccna;
    if (!c || !isIos(dev)) return [];
    const L = [];
    if (c.boot) L.push('boot system ' + c.boot);
    if (c.confreg && c.confreg !== '0x2102') L.push('config-register ' + c.confreg);
    if (c.noCef) L.push('no ip cef');
    if (c.udld) L.push('udld ' + c.udld);
    if (c.macAging != null) L.push('mac address-table aging-time ' + c.macAging);
    for (const x of c.macStatic || []) L.push('mac address-table static ' + U.ciscoMac(x.mac) + ' vlan ' + x.vlan + ' interface ' + dev.ports[x.port].name);
    if (c.archive) {
      L.push('archive');
      if (c.archive.path) L.push(' path ' + c.archive.path);
      if (c.archive.wm) L.push(' write-memory');
      if (c.archive.max && c.archive.max !== 10) L.push(' maximum ' + c.archive.max);
    }
    if (c.bannerLogin) L.push('banner login ^C' + c.bannerLogin + '^C');
    if (L.length) L.push('!');
    return L;
  });
  X.running.iface.push((dev, f, p) => {
    const o = (f && f.ccna) || (p && p.ccna);
    if (!o) return [];
    const L = [];
    if (!f && o.desc) L.push(' description ' + o.desc);
    if (o.mtu) L.push(' mtu ' + o.mtu);
    if (o.ipMtu) L.push(' ip mtu ' + o.ipMtu);
    if (o.udld) L.push(' udld port' + (o.udld === 'aggressive' ? ' aggressive' : ''));
    return L;
  });

  NS.deviceExt.push({
    key: 'ccna',
    applies: isIos,
    save(d) {
      const ifs = {};
      for (const f of d.ifaces || []) if (f.ccna && Object.values(f.ccna).some((v) => v != null)) ifs[f.name] = f.ccna;
      const ports = {};
      (d.ports || []).forEach((p, i) => { if (p.ccna && Object.values(p.ccna).some((v) => v != null)) ports[i] = p.ccna; });
      const c = d.ccna ? Object.assign({}, d.ccna) : null;
      return c || Object.keys(ifs).length || Object.keys(ports).length ? { c, ifs, ports } : null;
    },
    load(d, x) {
      d.ccna = x && x.c ? Object.assign({}, x.c) : null;
      for (const f of d.ifaces || []) f.ccna = x && x.ifs && x.ifs[f.name] ? Object.assign({}, x.ifs[f.name]) : null;
      (d.ports || []).forEach((p, i) => { p.ccna = x && x.ports && x.ports[i] ? Object.assign({}, x.ports[i]) : null; });
      if (d.macTable) applyStatic(d);
    },
  });

  X.tree.exec = (X.tree.exec || []).concat(['show interfaces description', 'show ip access-lists', 'show processes cpu', 'show memory', 'show inventory', 'show hosts', 'show license', 'show boot', 'show archive', 'clear counters', 'dir']);
  X.tree.config = (X.tree.config || []).concat(['ip domain lookup', 'ip domain name WORD', 'banner login WORD', 'archive', 'config-register WORD', 'boot system WORD']);
})(globalThis.NetLab = globalThis.NetLab || {});
