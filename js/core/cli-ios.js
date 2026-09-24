/* NetLab — консоль Cisco IOS для маршрутизаторов и коммутаторов.
 * Режимы user / privileged / config / interface / line / router / dhcp / vlan / acl,
 * сокращения команд, «?» и Tab, пароли и вход (console, vty), NVRAM, reload, TFTP,
 * show-команды, running-config, который можно снова «прочитать» (copy tftp / copy start run). */
(function (NS) {
  'use strict';

  const U = NS.util;

  /* ================= помощники ================= */

  function tokenize(line) { return String(line).trim().split(/\s+/).filter(Boolean); }

  /** Сокращение ключевого слова: tok — префикс word длиной не меньше min. */
  function kw(tok, word, min) {
    if (!tok) return false;
    const t = tok.toLowerCase();
    return t.length >= (min || 1) && word.startsWith(t);
  }

  function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }
  function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
  function shortIf(name) {
    return String(name).replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^Serial/, 'Se').replace(/^Loopback/, 'Lo').replace(/^Vlan/, 'Vl');
  }
  function cdpIf(name) {
    return String(name).replace(/^GigabitEthernet/, 'Gig ').replace(/^FastEthernet/, 'Fas ').replace(/^Serial/, 'Ser ');
  }
  const ip = (v) => (v == null ? '' : U.ipStr(v));

  /* ================= расширения (IPv6, SNMP, NetFlow, VPN, PPPoE, VoIP, IoX…) ================= */

  /**
   * Новые подсистемы регистрируют здесь свои команды, режимы, show и строки running-config.
   * Обработчик возвращает true, если команда его.
   */
  const EXT = {
    config: [],   // (dev, s, a, neg, io, CTX) — глобальный режим
    iface: [],    // (dev, s, a, neg, io, targets, CTX) — режим интерфейса
    show: [],     // (dev, s, a, io, CTX) — show …
    exec: [],     // (dev, s, t, io, line, CTX) → {handled, job} | null — user/privileged
    global: [],   // (t, s) → true, если команда глобальная (из подрежима выйти в config)
    modes: {},    // имя → { prompt(dev, s) → '(config-xxx)#', run(dev, s, t, io, CTX), tree: [...], parent?: режим для exit }
    ifNames: [],  // (dev, str) → { kind: 'named', name, create(dev), remove(dev) } | null
    running: { global: [], iface: [], tail: [], line: [] }, // (dev[, f, port]) → строки; line: (dev, 'con'|'vty', cfg)
    tree: {},     // режим → дополнительные строки для «?»
    login: [],    // (dev, s, io, lineCfg, user, onOk, onDeny) → true, если вход обработан (AAA)
    line: [],     // (dev, s, a, neg, io, lineCfg, CTX) → true — команды режима line
  };

  /** Имя интерфейса: g0/0, gi0/0.10, fa0/1, s0/0/0, vlan 10, lo0, "gig 0/1". */
  function parseIfName(dev, str) {
    const t = String(str).trim().replace(/\s+/g, '');
    for (const fn of EXT.ifNames) {
      const r = fn(dev, t);
      if (r) return r;
    }
    let m = /^vl(?:a(?:n)?)?(\d+)$/i.exec(t);
    if (m) return { kind: 'vlan', vlan: Number(m[1]) };
    m = /^lo(?:o(?:p(?:b(?:a(?:c(?:k)?)?)?)?)?)?(\d+)$/i.exec(t);
    if (m) return { kind: 'loop', n: Number(m[1]) };
    m = /^([a-z]+)(\d+(?:\/\d+)*)(?:\.(\d+))?$/i.exec(t);
    if (!m) return null;
    const pfx = m[1].toLowerCase();
    for (let i = 0; i < dev.ports.length; i++) {
      const pm = /^([A-Za-z]+)([\d/]+)$/.exec(dev.ports[i].name);
      if (pm && pm[1].toLowerCase().startsWith(pfx) && pm[2] === m[2]) {
        return { kind: 'port', port: i, sub: m[3] != null ? Number(m[3]) : null };
      }
    }
    return null;
  }

  /* ================= running-config ================= */

  function pwLine(dev, pw) {
    return dev.ios.encrypt ? '7 ' + U.type7(pw) : pw;
  }

  function ifaceLines(dev, f) {
    const L = [];
    if (f.desc) L.push(' description ' + f.desc);
    if (f.kind === 'sub') L.push(f.vlan != null ? ' encapsulation dot1Q ' + f.vlan : '');
    if (f.dhcp) L.push(' ip address dhcp');
    else L.push(f.ip != null ? ' ip address ' + ip(f.ip) + ' ' + ip(f.mask) : ' no ip address');
    if (f.helper != null) L.push(' ip helper-address ' + ip(f.helper));
    if (f.aclIn) L.push(' ip access-group ' + f.aclIn + ' in');
    if (f.aclOut) L.push(' ip access-group ' + f.aclOut + ' out');
    if (f.nat) L.push(' ip nat ' + f.nat);
    return L.filter(Boolean);
  }

  function portLines(dev, p) {
    const L = [];
    if (p.media === 'serial') {
      if (p.encap === 'ppp') L.push(' encapsulation ppp');
      if (p.clockRate) L.push(' clock rate ' + p.clockRate);
    }
    if (p.bandwidth && p.bandwidth !== 'auto') L.push(' bandwidth ' + Math.round(p.bandwidth * 1000));
    if (p.duplex && p.duplex !== 'auto') L.push(' duplex ' + p.duplex);
    return L;
  }

  function switchPortLines(dev, p) {
    const L = [];
    if (p.routed) { L.push(' no switchport'); return L; }
    const cfg = p.cfgMode || p.mode;
    if (cfg !== 'access') {
      if (p.nativeVlan !== 1) L.push(' switchport trunk native vlan ' + p.nativeVlan);
      if (p.allowed !== 'all') L.push(' switchport trunk allowed vlan ' + p.allowed);
    }
    if (cfg !== 'trunk' && p.vlan !== 1) L.push(' switchport access vlan ' + p.vlan);
    if (cfg === 'trunk') {
      L.push(' switchport mode trunk');
    } else {
      if (cfg === 'access') L.push(' switchport mode access');
      else if (cfg === 'dynamic desirable') L.push(' switchport mode dynamic desirable');
      if (p.ps && (p.ps.enabled || p.ps.macs.length)) {
        if (p.ps.enabled) L.push(' switchport port-security');
        if (p.ps.max !== 1) L.push(' switchport port-security maximum ' + p.ps.max);
        if (p.ps.violation !== 'shutdown') L.push(' switchport port-security violation ' + p.ps.violation);
        if (p.ps.sticky) L.push(' switchport port-security mac-address sticky');
        for (const m of p.ps.macs) {
          if (m.sticky) L.push(' switchport port-security mac-address sticky ' + U.ciscoMac(m.mac));
          else if (m.manual) L.push(' switchport port-security mac-address ' + U.ciscoMac(m.mac));
        }
      }
    }
    if (p.nonegotiate) L.push(' switchport nonegotiate');
    if (p.chan) L.push(' channel-group ' + p.chan.group + ' mode ' + p.chan.mode);
    if (p.portfast) L.push(' spanning-tree portfast');
    if (p.bpduguard != null) L.push(' spanning-tree bpduguard ' + (p.bpduguard ? 'enable' : 'disable'));
    return L;
  }

  function runningConfig(dev) {
    const io = dev.ios;
    const ts = dev.logging && dev.logging.timestamps;
    const L = ['!', 'version 15.1', (ts ? '' : 'no ') + 'service timestamps log datetime msec', (dev.logging && dev.logging.debugTimestamps ? '' : 'no ') + 'service timestamps debug datetime msec'];
    if (io.encrypt) L.push('service password-encryption');
    else L.push('no service password-encryption');
    L.push('!', 'hostname ' + io.hostname, '!');
    if (io.enableSecret) L.push('enable secret 5 ' + io.enableSecret);
    if (io.enablePassword) L.push('enable password ' + pwLine(dev, io.enablePassword));
    if (io.enableSecret || io.enablePassword) L.push('!');
    if (dev.dhcpd && dev.type === 'router') {
      for (const r of dev.dhcpd.excluded) L.push('ip dhcp excluded-address ' + ip(r.from) + (r.to !== r.from ? ' ' + ip(r.to) : ''));
      if (dev.dhcpd.excluded.length) L.push('!');
      for (const p of dev.dhcpd.pools) {
        L.push('ip dhcp pool ' + p.name, ' network ' + ip(p.network) + ' ' + ip(p.mask));
        if (p.gateway != null) L.push(' default-router ' + ip(p.gateway));
        if (p.dns != null) L.push(' dns-server ' + ip(p.dns));
        if (p.tftp != null) L.push(' option 150 ip ' + ip(p.tftp));
        if (p.wlc != null) L.push(' option 43 hex f104.' + ((p.wlc >>> 0).toString(16).padStart(8, '0').match(/..../g).join('.')));
        L.push('!');
      }
      if (!dev.dhcpd.enabled) L.push('no service dhcp', '!');
    }
    if (dev.type === 'switch' && dev.ipRouting) L.push('ip routing', '!');
    if (io.domain) L.push('ip domain-name ' + io.domain);
    if (dev.dns != null) L.push('ip name-server ' + ip(dev.dns));
    for (const u of io.users) L.push('username ' + u.name + (u.priv > 1 ? ' privilege ' + u.priv : '') + (u.secret ? ' secret 5 ' + u.pass : ' password ' + pwLine(dev, u.pass)));
    if (io.users.length || io.domain) L.push('!');
    if (!io.cdp) L.push('no cdp run', '!');
    for (const fn of EXT.running.global) L.push(...fn(dev));
    if (dev.type === 'switch') {
      if (EXT.stpRunning) L.push(...EXT.stpRunning(dev));
      else {
        if (dev.stpPriority !== 32768) L.push('spanning-tree vlan 1 priority ' + dev.stpPriority);
        L.push('spanning-tree mode pvst', '!');
      }
      for (const [v, name] of [...dev.vlans.entries()].sort((a, b) => a[0] - b[0])) {
        if (v === 1) continue;
        L.push('vlan ' + v, ' name ' + name, '!');
      }
    }
    if (dev.type === 'router') {
      for (const f of dev.ifaces) {
        if (f.runtime) continue;
        L.push('interface ' + f.name);
        L.push(...ifaceLines(dev, f));
        for (const fn of EXT.running.iface) L.push(...fn(dev, f, f.kind === 'phys' ? dev.ports[f.port] : null));
        if (f.kind === 'phys') L.push(...portLines(dev, dev.ports[f.port]));
        if (!f.adminUp) L.push(' shutdown');
        L.push('!');
      }
    } else {
      dev.ports.forEach((p, i) => {
        if (!NS.Network.isData(p)) return;
        L.push('interface ' + p.name);
        L.push(...switchPortLines(dev, p));
        const rf = p.routed ? dev.ifaces.find((x) => x.kind === 'routed' && x.port === i) : null;
        if (rf) L.push(...ifaceLines(dev, rf));
        for (const fn of EXT.running.iface) L.push(...fn(dev, rf, p));
        L.push(...portLines(dev, p));
        if (!p.adminUp) L.push(' shutdown');
        L.push('!');
      });
      for (const f of dev.ifaces.filter((x) => x.kind === 'svi').sort((a, b) => a.vlan - b.vlan)) {
        L.push('interface ' + f.name, ...ifaceLines(dev, f));
        for (const fn of EXT.running.iface) L.push(...fn(dev, f, null));
        if (!f.adminUp) L.push(' shutdown');
        L.push('!');
      }
    }
    if (dev.ospf) {
      const o = dev.ospf;
      L.push('router ospf ' + o.pid);
      if (o.routerId != null) L.push(' router-id ' + ip(o.routerId));
      L.push(' log-adjacency-changes');
      for (const p of o.passive) L.push(' passive-interface ' + p);
      for (const n of o.networks) L.push(' network ' + ip(n.net) + ' ' + ip(n.wc) + ' area ' + n.area);
      if (o.defaultOriginate) L.push(' default-information originate' + (o.defaultAlways ? ' always' : ''));
      for (const fn of EXT.running.ospf || []) L.push(...fn(dev));
      L.push('!');
    }
    if (dev.rip && dev.rip.networks.length) {
      const r = dev.rip;
      L.push('router rip');
      if (r.version === 2) L.push(' version 2');
      for (const p of r.passive) L.push(' passive-interface ' + p);
      for (const n of r.networks) L.push(' network ' + ip(n));
      if (r.defaultOriginate) L.push(' default-information originate');
      if (!r.autoSummary) L.push(' no auto-summary');
      for (const fn of EXT.running.rip || []) L.push(...fn(dev));
      L.push('!');
    }
    if (dev.nat && !dev.nat.isEmpty()) L.push(...dev.nat.configLines());
    L.push('ip classless');
    for (const r of dev.routes) L.push('ip route ' + ip(r.net) + ' ' + ip(r.mask) + (r.ifName ? ' ' + r.ifName : '') + (r.nextHop != null ? ' ' + ip(r.nextHop) : '') + (r.ad && r.ad !== 1 ? ' ' + r.ad : ''));
    if (dev.type === 'switch' && dev.defaultGateway != null) L.push('ip default-gateway ' + ip(dev.defaultGateway));
    L.push('!');
    for (const a of dev.acls.values()) L.push(...a.configLines());
    if (dev.acls.size) L.push('!');
    for (const fn of EXT.running.tail) L.push(...fn(dev));
    if (io.rsa) L.push('ip ssh version ' + io.sshVer, '!');
    if (io.banner) L.push('banner motd ^C' + io.banner + '^C', '!');
    L.push('line con 0');
    if (io.con.password) L.push(' password ' + pwLine(dev, io.con.password));
    const aaaOn = !!(dev.aaa && dev.aaa.newModel);
    if (io.con.login === 'line' && !aaaOn) L.push(' login');
    if (io.con.login === 'local' && !aaaOn) L.push(' login local');
    for (const fn of EXT.running.line) L.push(...fn(dev, 'con', io.con));
    L.push('!');
    if (dev.type === 'router') L.push('line aux 0', '!');
    L.push('line vty 0 ' + io.vty.last);
    if (io.vty.accessClass) L.push(' access-class ' + io.vty.accessClass + ' in');
    if (io.vty.password) L.push(' password ' + pwLine(dev, io.vty.password));
    if (io.vty.login === 'line' && !aaaOn) L.push(' login');
    if (io.vty.login === 'local' && !aaaOn) L.push(' login local');
    for (const fn of EXT.running.line) L.push(...fn(dev, 'vty', io.vty));
    if (io.vty.transport !== 'all') L.push(' transport input ' + io.vty.transport);
    L.push('!', 'end');
    return L;
  }

  /* ================= сеансы ================= */

  function createSession(dev, opts) {
    opts = opts || {};
    const via = opts.via || 'local';
    // «Press RETURN» — только в окне консоли; vty ждёт приветствия клиента; программный доступ — сразу в user
    const stage = via === 'console' ? 'press-return' : via === 'vty' ? 'login' : null;
    return { mode: 'user', ifs: null, line: null, acl: null, pool: null, vlan: null, via, remoteIp: opts.remoteIp || null, pending: null, remote: null, stage, history: [], closed: false };
  }

  function prompt(dev, s) {
    if (s.remote) return s.remote.prompt || '';
    if (s.pending) return s.pending.prompt;
    if (s.stage) return '';
    const n = dev.ios.hostname;
    switch (s.mode) {
      case 'user': return n + '>';
      case 'exec': return n + '#';
      case 'config': return n + '(config)#';
      case 'if': {
        if (s.ifs && s.ifs.length > 1) return n + '(config-if-range)#';
        const r = s.ifs && s.ifs[0];
        return n + (r && r.sub != null ? '(config-subif)#' : '(config-if)#');
      }
      case 'line': return n + '(config-line)#';
      case 'rip': case 'ospf': return n + '(config-router)#';
      case 'pool': return n + '(dhcp-config)#';
      case 'vlan': return n + '(config-vlan)#';
      case 'acl': return n + (s.acl && s.acl.type === 'standard' ? '(config-std-nacl)#' : '(config-ext-nacl)#');
      default: return n + (EXT.modes[s.mode] ? EXT.modes[s.mode].prompt(dev, s) : '#');
    }
  }

  function invalid(io, tok) {
    io.out('% Invalid input detected' + (tok ? " at '" + tok + "'" : '') + '.');
    io.out('  (неизвестная команда — введите ? для подсказки)', 'hint');
  }
  function incomplete(io) { io.out('% Incomplete command.'); }

  function withMutate(io, fn) {
    try {
      io.mutate(fn);
      return true;
    } catch (e) {
      io.out('% ' + e.message);
      return false;
    }
  }

  /** Спросить пароль (до 3 попыток). check(pw) → bool. */
  function askPassword(s, io, check, onOk, failText, onFail) {
    let tries = 0;
    const ask = () => {
      s.pending = {
        prompt: 'Password: ',
        mask: true,
        handle: (pw) => {
          if (check(pw)) { onOk(); return null; }
          if (++tries < 3) { ask(); return null; }
          io.out(failText || '% Bad passwords');
          if (onFail) onFail();
          return null;
        },
      };
    };
    ask();
  }

  /** Вход на линию (console/vty) по её настройкам. user — уже известное имя (SSH). */
  function login(dev, s, io, lineCfg, user, onOk, onDeny) {
    for (const fn of EXT.login) if (fn(dev, s, io, lineCfg, user, onOk, onDeny)) return;
    if (lineCfg.login === 'local') {
      if (!dev.ios.users.length) { io.out('% Login invalid (не создано ни одного пользователя: username … secret …)'); if (onDeny) onDeny(); return; }
      let tries = 0;
      const askUser = () => {
        if (user) { askPw(user); return; }
        s.pending = { prompt: 'Username: ', handle: (u) => { askPw(u.trim()); return null; } };
      };
      const askPw = (u) => {
        s.pending = {
          prompt: 'Password: ',
          mask: true,
          handle: (pw) => {
            if (dev.checkUser(u, pw)) { s.user = u; onOk(); return null; }
            io.out('% Login invalid');
            io.out('');
            if (++tries < 3) { if (user) askPw(user); else askUser(); } else if (onDeny) onDeny();
            return null;
          },
        };
      };
      askUser();
      return;
    }
    if (lineCfg.login === 'line') {
      if (!lineCfg.password) {
        if (s.via === 'vty') { io.out('Password required, but none set'); if (onDeny) onDeny(); return; }
        onOk();
        return;
      }
      askPassword(s, io, (pw) => pw === lineCfg.password, onOk, '% Bad passwords', onDeny);
      return;
    }
    onOk();
  }

  function startConsole(dev, s, io) {
    s.stage = null;
    if (dev.ios.banner) { io.out(''); io.out(dev.ios.banner); io.out(''); }
    s.mode = 'user';
    const aaaCon = !!(dev.aaa && dev.aaa.newModel && (dev.ios.con.authList || dev.aaa.login.default));
    if (dev.ios.con.login !== 'none' || aaaCon) {
      io.out('User Access Verification');
      io.out('');
      login(dev, s, io, dev.ios.con, null, () => { s.mode = 'user'; }, () => { s.stage = 'press-return'; });
    }
  }

  function doEnable(dev, s, io) {
    if (!dev.hasEnablePassword()) {
      if (s.via === 'vty') { io.out('% No password set'); return; }
      s.mode = 'exec';
      return;
    }
    askPassword(s, io, (pw) => dev.checkEnable(pw), () => { s.mode = 'exec'; }, '% Bad secrets');
  }

  function doExit(dev, s, io) {
    if (s.via === 'vty') { s.closed = true; return; }
    s.mode = 'user';
    io.out('');
    io.out(dev.ios.hostname + ' con0 is now available');
    io.out('');
    io.out('Press RETURN to get started.');
    s.stage = 'press-return';
  }

  /* ================= show ================= */

  function ifStatus(dev, f) {
    const p = f.port >= 0 ? dev.ports[f.port] : null;
    if (!f.adminUp || (p && !p.adminUp)) return ['administratively down', 'down'];
    if (p && p.errDisabled) return ['down', 'down'];
    if (f.kind === 'loop') return ['up', 'up'];
    if (f.kind === 'svi') return dev.ifaceUp(f) ? ['up', 'up'] : ['down', 'down'];
    const phys = p && p.link && dev.power;
    const up = dev.ifaceUp(f);
    return [phys || up ? 'up' : 'down', up ? 'up' : 'down'];
  }

  function showIpRoute(dev, io, filter) {
    io.out('Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP');
    io.out('       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area');
    io.out('       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP');
    io.out('       * - candidate default, U - per-user static route, o - ODR');
    io.out('       P - periodic downloaded static route');
    io.out('');
    const rows = dev.routingTable().filter((r) => r.active && !r.shadowed);
    const def = rows.find((r) => r.mask === 0 && r.type !== 'C');
    io.out('Gateway of last resort is ' + (def ? (def.nextHop != null ? ip(def.nextHop) : 'directly connected via ' + def.ifname) + ' to network 0.0.0.0' : 'not set'));
    io.out('');
    for (const r of rows) {
      if (filter && ({ connected: 'C', static: 'S', ospf: 'O', rip: 'R', eigrp: 'D', bgp: 'B' }[filter]) !== r.type && !(filter === 'connected' && r.type === 'L')) continue;
      const star = r.mask === 0 && r.type !== 'C' ? '*' : '';
      const sub = r.sub && r.sub !== '*' ? r.sub.replace('*', '') : '';
      const code = (r.type + star + (sub ? (star ? '' : ' ') + sub : '')).padEnd(5);
      const net = U.cidr(r.net, r.mask);
      if (r.type === 'C' || r.type === 'L') io.out(code + '   ' + net + ' is directly connected, ' + r.ifname);
      else if (r.ifname === 'Null0') io.out(code + '   ' + net + ' is a summary, 00:00:' + String(10 + (dev.net.time % 40)).padStart(2, '0') + ', Null0');
      else if (r.type === 'S') io.out(code + '   ' + net + ' [' + r.ad + '/0] ' + (r.nextHop != null ? 'via ' + ip(r.nextHop) : 'is directly connected, ' + r.ifname));
      else io.out(code + '   ' + net + ' [' + r.ad + '/' + r.metric + '] via ' + ip(r.nextHop) + ', 00:00:' + String(10 + (dev.net.time % 40)).padStart(2, '0') + ', ' + r.ifname);
    }
  }

  function showIpIntBrief(dev, io) {
    io.out(pad('Interface', 27) + pad('IP-Address', 16) + pad('OK?', 4) + pad('Method', 7) + pad('Status', 22) + 'Protocol');
    const list = dev.type === 'router' ? dev.ifaces : dev.ports.map((p, i) => {
      if (!NS.Network.isData(p)) return null;
      return dev.ifaces.find((f) => f.kind === 'routed' && f.port === i) || { name: p.name, port: i, kind: 'l2', adminUp: p.adminUp, ip: null };
    }).filter(Boolean).concat(dev.ifaces.filter((f) => f.kind === 'svi'));
    for (const f of list) {
      let st;
      if (f.kind === 'l2') {
        const p = dev.ports[f.port];
        st = !p.adminUp ? ['administratively down', 'down'] : p.errDisabled ? ['down', 'down'] : dev.net.isPortOperational(dev, f.port) ? ['up', 'up'] : ['down', 'down'];
      } else st = ifStatus(dev, f);
      io.out(pad(f.name, 27) + pad(f.ip != null ? ip(f.ip) : 'unassigned', 16) + pad('YES', 4) + pad(f.dhcp ? 'DHCP' : f.ip != null ? 'manual' : 'unset', 7) + pad(st[0], 22) + st[1]);
    }
  }

  function showInterfaces(dev, io, name) {
    const list = [];
    if (name) {
      const r = parseIfName(dev, name);
      const f = r && ifaceOf(dev, r);
      if (!f) { io.out('% Invalid input detected'); return; }
      list.push(f);
    } else {
      list.push(...(dev.type === 'router' ? dev.ifaces : dev.ifaces.filter((f) => f.kind !== 'l2')));
      if (dev.type === 'switch') {
        dev.ports.forEach((p, i) => { if (NS.Network.isData(p) && !p.routed) list.push({ name: p.name, port: i, kind: 'l2', adminUp: p.adminUp, ip: null }); });
      }
    }
    for (const f of list) {
      const p = f.port >= 0 ? dev.ports[f.port] : null;
      let st;
      if (f.kind === 'l2') st = !p.adminUp ? ['administratively down', 'down'] : dev.net.isPortOperational(dev, f.port) ? ['up', 'up'] : ['down', 'down'];
      else st = ifStatus(dev, f);
      io.out(f.name + ' is ' + st[0] + ', line protocol is ' + st[1] + (p && p.errDisabled ? ' (err-disabled)' : st[1] === 'up' && f.kind !== 'loop' ? ' (connected)' : ''));
      const mac = f.kind === 'loop' ? null : f.kind === 'svi' ? dev.baseMac : p && p.mac;
      const hw = f.kind === 'loop' ? 'Loopback' : f.kind === 'svi' ? 'CPU Interface' : p.media === 'serial' ? 'HD64570' : p.speed >= 1000 ? 'CN Gigabit Ethernet' : 'Lance';
      io.out('  Hardware is ' + hw + (mac ? ', address is ' + U.ciscoMac(mac) + ' (bia ' + U.ciscoMac(mac) + ')' : ''));
      if (f.desc) io.out('  Description: ' + f.desc);
      if (f.ip != null) io.out('  Internet address is ' + U.cidr(f.ip, f.mask));
      const bw = f.kind === 'loop' ? 8000000 : p ? Math.round(NS.portSpeed(p) * 1000) : 1000000;
      io.out('  MTU 1500 bytes, BW ' + bw + ' Kbit, DLY 10 usec,');
      io.out('     reliability 255/255, txload 1/255, rxload 1/255');
      const enc = f.kind === 'sub' ? '802.1Q Virtual LAN, Vlan ID ' + f.vlan : p && p.media === 'serial' ? (p.encap || 'hdlc').toUpperCase() : f.kind === 'loop' ? 'LOOPBACK' : 'ARPA';
      io.out('  Encapsulation ' + enc + ', loopback not set');
      if (p && p.media === 'serial') io.out('  ' + (dev.isDce && dev.isDce(f.port) ? 'DCE' : 'DTE') + ' cable' + (p.clockRate ? ', clock rate ' + p.clockRate : ''));
      else if (p) io.out('  ' + (p.duplex === 'auto' ? 'Full' : p.duplex[0].toUpperCase() + p.duplex.slice(1)) + '-duplex, ' + (NS.portSpeed(p) >= 1000 ? '1000Mb/s' : NS.portSpeed(p) + 'Mb/s') + ', media type is ' + (p.media === 'fiber' ? 'SFP' : 'RJ45'));
    }
  }

  function showArp(dev, io) {
    io.out(pad('Protocol', 10) + pad('Address', 17) + pad('Age (min)', 10) + pad('Hardware Addr', 16) + pad('Type', 6) + 'Interface');
    for (const f of dev.ifaces) {
      if (f.ip != null && f.kind !== 'loop' && dev.ifaceMac(f)) io.out(pad('Internet', 10) + pad(ip(f.ip), 17) + pad('-', 10) + pad(U.ciscoMac(dev.ifaceMac(f)), 16) + pad('ARPA', 6) + f.name);
    }
    for (const r of dev.arpEntries()) io.out(pad('Internet', 10) + pad(ip(r.ip), 17) + pad('0', 10) + pad(U.ciscoMac(r.mac), 16) + pad('ARPA', 6) + r.ifname);
  }

  function showDhcpBinding(dev, io) {
    io.out('IP address       Client-ID/              Lease expiration        Type');
    io.out('                 Hardware address');
    for (const l of dev.dhcpd.leaseList()) io.out(pad(ip(l.ip), 17) + pad(U.ciscoMac(l.mac), 24) + pad('--', 24) + 'Automatic');
  }

  function showDhcpPool(dev, io) {
    if (!dev.dhcpd.pools.length) { io.out('Пулы DHCP не настроены.'); return; }
    for (const p of dev.dhcpd.pools) {
      const leased = dev.dhcpd.leaseList().filter((l) => l.pool === p.name).length;
      io.out('');
      io.out('Pool ' + p.name + ' :');
      io.out(' Utilization mark (high/low)    : 100 / 0');
      io.out(' Subnet size (first/next)       : 0 / 0');
      io.out(' Total addresses                : ' + (p.end - p.start + 1));
      io.out(' Leased addresses               : ' + leased);
      io.out(' Excluded addresses             : ' + dev.dhcpd.excluded.reduce((n, r) => n + (r.to - r.from + 1), 0));
      io.out(' Pending event                  : none');
      io.out('');
      io.out(' 1 subnet is currently in the pool');
      io.out(' Current index        IP address range                    Leased/Excluded/Total');
      io.out(' ' + pad(ip(p.start), 21) + pad(ip(p.start) + ' - ' + ip(p.end), 36) + leased + ' / 0 / ' + (p.end - p.start + 1));
    }
  }

  function showProtocols(dev, io) {
    if (dev.rip && dev.rip.networks.length) {
      const r = dev.rip;
      io.out('Routing Protocol is "rip"');
      io.out('Sending updates every 30 seconds, next due in 12 seconds');
      io.out('Invalid after 180 seconds, hold down 180, flushed after 240');
      io.out('Outgoing update filter list for all interfaces is not set');
      io.out('Incoming update filter list for all interfaces is not set');
      io.out('Redistributing: rip');
      io.out('Default version control: send version ' + (r.version === 2 ? '2' : '1') + ', receive ' + (r.version === 2 ? '2' : 'any version'));
      io.out('Automatic network summarization is ' + (r.autoSummary ? 'in effect' : 'not in effect'));
      io.out('Maximum path: 4');
      io.out('Routing for Networks:');
      for (const n of r.networks) io.out('\t' + ip(n));
      if (r.passive.length) { io.out('Passive Interface(s):'); for (const p of r.passive) io.out('\t' + p); }
      io.out('Routing Information Sources:');
      io.out('\tGateway         Distance      Last Update');
      const gws = [...new Set(dev.dynRoutes.filter((x) => x.type === 'R').map((x) => x.nextHop))];
      for (const g of gws) io.out('\t' + pad(ip(g), 16) + pad('120', 14) + '00:00:05');
      io.out('Distance: (default is 120)');
      io.out('');
    }
    if (dev.ospf) {
      const o = dev.ospf;
      io.out('Routing Protocol is "ospf ' + o.pid + '"');
      io.out('Outgoing update filter list for all interfaces is not set');
      io.out('Incoming update filter list for all interfaces is not set');
      io.out('Router ID ' + ip(NS.routing.routerId(dev)));
      const areas = new Set(o.networks.map((n) => n.area));
      io.out('Number of areas in this router is ' + areas.size + '. ' + areas.size + ' normal 0 stub 0 nssa');
      io.out('Maximum path: 4');
      io.out('Routing for Networks:');
      for (const n of o.networks) io.out('\t' + ip(n.net) + ' ' + ip(n.wc) + ' area ' + n.area);
      if (o.passive.length) { io.out('Passive Interface(s):'); for (const p of o.passive) io.out('\t' + p); }
      io.out('Routing Information Sources:');
      io.out('\tGateway         Distance      Last Update');
      for (const n of dev.ospfNeighbors || []) io.out('\t' + pad(ip(n.id), 16) + pad('110', 14) + '00:00:07');
      io.out('Distance: (default is 110)');
    }
    if (!(dev.rip && dev.rip.networks.length) && !dev.ospf) io.out('% Протоколы динамической маршрутизации не настроены (router rip / router ospf).', 'hint');
  }

  function showOspfNeighbor(dev, io) {
    if (!dev.ospf) { io.out('% OSPF не запущен (router ospf N).'); return; }
    dev.net.ensureRouting();
    io.out('');
    io.out(pad('Neighbor ID', 16) + pad('Pri', 6) + pad('State', 16) + pad('Dead Time', 12) + pad('Address', 16) + 'Interface');
    for (const n of dev.ospfNeighbors || []) {
      io.out(pad(ip(n.id), 16) + pad('1', 6) + pad(n.state, 16) + pad('00:00:3' + (dev.net.time % 10), 12) + pad(ip(n.address), 16) + n.ifname);
    }
  }

  function showCdp(dev, io, detail) {
    if (!dev.ios.cdp) { io.out('% CDP is not enabled'); return; }
    const list = NS.cdpNeighbors(dev);
    if (detail) {
      for (const n of list) {
        io.out('');
        io.out('Device ID: ' + n.dev.ios.hostname);
        io.out('Entry address(es): ');
        for (const a of n.addrs) io.out('  IP address : ' + ip(a));
        io.out('Platform: cisco ' + n.platform + ', Capabilities: ' + (n.cap.startsWith('R') ? 'Router' : 'Switch'));
        io.out('Interface: ' + n.localPort + ', Port ID (outgoing port): ' + n.remotePort);
        io.out('Holdtime: 160');
        io.out('');
        io.out('Version :');
        io.out('Cisco IOS Software, Version 15.1');
        io.out('');
        io.out('advertisement version: 2');
        io.out('Duplex: full');
        io.out('---------------------------');
      }
      return;
    }
    io.out('Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge');
    io.out('                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone');
    io.out(pad('Device ID', 17) + pad('Local Intrfce', 17) + pad('Holdtme', 11) + pad('Capability', 14) + pad('Platform', 11) + 'Port ID');
    for (const n of list) io.out(pad(n.dev.ios.hostname, 17) + pad(cdpIf(n.localPort), 17) + pad('160', 11) + pad(n.cap, 14) + pad(n.platform, 11) + cdpIf(n.remotePort));
  }

  function showMac(dev, io) {
    io.out('          Mac Address Table');
    io.out('-------------------------------------------');
    io.out('');
    io.out(pad('Vlan', 8) + pad('Mac Address', 19) + pad('Type', 12) + 'Ports');
    io.out(pad('----', 8) + pad('-----------', 19) + pad('--------', 12) + '-----');
    for (const e of dev.macEntries()) {
      const p = dev.ports[e.port];
      const st = p.ps && p.ps.macs.some((m) => m.mac === e.mac && m.sticky) ? 'STATIC' : 'DYNAMIC';
      io.out(pad(padL(e.vlan, 4), 8) + pad(U.ciscoMac(e.mac), 19) + pad(st, 12) + shortIf(p.name));
    }
  }

  function showVlan(dev, io) {
    io.out(pad('VLAN', 5) + pad('Name', 33) + pad('Status', 10) + 'Ports');
    io.out(pad('----', 5) + pad('--------------------------------', 33) + pad('---------', 10) + '-------------------------------');
    for (const [v, name] of [...dev.vlans.entries()].sort((a, b) => a[0] - b[0])) {
      const ports = dev.ports.filter((p) => NS.Network.isData(p) && !p.routed && p.mode === 'access' && p.vlan === v).map((p) => shortIf(p.name));
      const chunks = [];
      for (let i = 0; i < ports.length; i += 4) chunks.push(ports.slice(i, i + 4).join(', '));
      io.out(pad(v, 5) + pad(name, 33) + pad('active', 10) + (chunks[0] || ''));
      for (let i = 1; i < chunks.length; i++) io.out(' '.repeat(48) + chunks[i]);
    }
    for (const [v, n] of [[1002, 'fddi-default'], [1003, 'token-ring-default'], [1004, 'fddinet-default'], [1005, 'trnet-default']]) {
      io.out(pad(v, 5) + pad(n, 33) + 'act/unsup');
    }
    const missing = new Set(dev.ports.filter((p) => NS.Network.isData(p) && !p.routed && p.mode === 'access' && !dev.vlans.has(p.vlan)).map((p) => p.vlan));
    for (const v of missing) io.out('Внимание: порты назначены в VLAN ' + v + ', которого нет в базе VLAN — они не передают трафик.', 'hint');
  }

  function showIntStatus(dev, io) {
    io.out(pad('Port', 10) + pad('Name', 19) + pad('Status', 13) + pad('Vlan', 11) + pad('Duplex', 7) + pad('Speed', 7) + 'Type');
    dev.ports.forEach((p, i) => {
      if (!NS.Network.isData(p)) return;
      const st = p.errDisabled ? 'err-disabled' : !p.adminUp ? 'disabled' : dev.net.isPortOperational(dev, i) ? 'connected' : 'notconnect';
      io.out(pad(shortIf(p.name), 10) + pad('', 19) + pad(st, 13) + pad(p.routed ? 'routed' : p.mode === 'trunk' ? 'trunk' : p.vlan, 11) + pad('auto', 7) + pad('auto', 7) + (p.speed >= 1000 ? '10/100/1000BaseTX' : '10/100BaseTX'));
    });
  }

  function showTrunk(dev, io) {
    const tr = dev.ports.map((p, i) => ({ p, i })).filter((x) => NS.Network.isData(x.p) && !x.p.routed && x.p.mode === 'trunk');
    if (!tr.length) return;
    io.out(pad('Port', 10) + pad('Mode', 13) + pad('Encapsulation', 15) + pad('Status', 13) + 'Native vlan');
    for (const { p, i } of tr) io.out(pad(shortIf(p.name), 10) + pad('on', 13) + pad('802.1q', 15) + pad(dev.net.isPortOperational(dev, i) ? 'trunking' : 'not-trunking', 13) + p.nativeVlan);
    io.out('');
    io.out(pad('Port', 10) + 'Vlans allowed on trunk');
    for (const { p } of tr) io.out(pad(shortIf(p.name), 10) + (p.allowed === 'all' ? '1-1005' : p.allowed));
    io.out('');
    io.out(pad('Port', 10) + 'Vlans allowed and active in management domain');
    for (const { p } of tr) io.out(pad(shortIf(p.name), 10) + [...dev.vlans.keys()].filter((v) => U.vlanInList(p.allowed, v)).sort((a, b) => a - b).join(','));
  }

  function showStp(dev, io) {
    const s = dev.stpInfo;
    if (!s) { io.out('No spanning tree instance exists.'); return; }
    io.out('VLAN0001');
    io.out('  Spanning tree enabled protocol ieee');
    io.out('  Root ID    Priority    ' + (s.rootPriority + 1));
    io.out('             Address     ' + U.ciscoMac(s.rootMac));
    if (s.isRoot) io.out('             This bridge is the root');
    else {
      io.out('             Cost        ' + s.cost);
      io.out('             Port        ' + (s.rootPort + 1) + ' (' + dev.ports[s.rootPort].name + ')');
    }
    io.out('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec');
    io.out('');
    io.out('  Bridge ID  Priority    ' + (dev.stpPriority + 1) + '  (priority ' + dev.stpPriority + ' sys-id-ext 1)');
    io.out('             Address     ' + U.ciscoMac(dev.baseMac));
    io.out('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec');
    io.out('             Aging Time  20');
    io.out('');
    io.out(pad('Interface', 20) + pad('Role', 5) + pad('Sts', 4) + pad('Cost', 10) + pad('Prio.Nbr', 9) + 'Type');
    io.out(pad('-------------------', 20) + pad('----', 5) + pad('---', 4) + pad('---------', 10) + pad('--------', 9) + '--------------------------------');
    dev.ports.forEach((p, i) => {
      if (!p.stpRole) return;
      const role = p.stpRole === 'root' ? 'Root' : p.stpRole === 'designated' ? 'Desg' : 'Altn';
      io.out(pad(shortIf(p.name), 20) + pad(role, 5) + pad(p.stp === 'blocking' ? 'BLK' : 'FWD', 4) + pad(NS.stp.portCost(dev, i), 10) + pad('128.' + (i + 1), 9) + 'P2p');
    });
  }

  function showPortSecurity(dev, io, name) {
    if (name) {
      const r = parseIfName(dev, name);
      if (!r || r.kind !== 'port') { io.out('% Invalid input detected'); return; }
      const p = dev.ports[r.port];
      const ps = p.ps;
      io.out('Port Security              : ' + (ps.enabled ? 'Enabled' : 'Disabled'));
      io.out('Port Status                : ' + (p.errDisabled ? 'Secure-shutdown' : ps.enabled && p.oper ? 'Secure-up' : 'Secure-down'));
      io.out('Violation Mode             : ' + ps.violation[0].toUpperCase() + ps.violation.slice(1));
      io.out('Aging Time                 : 0 mins');
      io.out('Aging Type                 : Absolute');
      io.out('SecureStatic Address Aging : Disabled');
      io.out('Maximum MAC Addresses      : ' + ps.max);
      io.out('Total MAC Addresses        : ' + ps.macs.length);
      io.out('Configured MAC Addresses   : ' + ps.macs.filter((m) => m.manual).length);
      io.out('Sticky MAC Addresses       : ' + ps.macs.filter((m) => m.sticky).length);
      io.out('Last Source Address:Vlan   : ' + (ps.lastMac ? U.ciscoMac(ps.lastMac) + ':' + p.vlan : '0000.0000.0000:0'));
      io.out('Security Violation Count   : ' + ps.violations);
      return;
    }
    io.out('Secure Port MaxSecureAddr CurrentAddr SecurityViolation Security Action');
    io.out('               (Count)       (Count)          (Count)');
    io.out('--------------------------------------------------------------------');
    for (const p of dev.ports) {
      if (!p.ps || !p.ps.enabled) continue;
      io.out(pad(padL(shortIf(p.name), 11), 12) + pad(padL(p.ps.max, 8), 14) + pad(padL(p.ps.macs.length, 8), 12) + pad(padL(p.ps.violations, 10), 18) + p.ps.violation[0].toUpperCase() + p.ps.violation.slice(1));
    }
    io.out('----------------------------------------------------------------------');
  }

  function showVersion(dev, io) {
    const r = dev.type === 'router';
    const img = r ? (dev.model === '1941' ? 'C1900' : 'C2900') + ' Software (' + (dev.model === '1941' ? 'C1900' : 'C2900') + '-UNIVERSALK9-M)' : 'C' + dev.model.slice(0, 4) + ' Software (C' + dev.model.slice(0, 4) + '-LANBASEK9-M)';
    io.out('Cisco IOS Software, ' + img + ', Version 15.1(4)M4, RELEASE SOFTWARE (fc2)');
    io.out('Technical Support: http://www.cisco.com/techsupport');
    io.out('Copyright (c) 1986-2012 by Cisco Systems, Inc. (симулятор NetLab)');
    io.out('');
    io.out('ROM: System Bootstrap, Version 15.1(4)M4');
    io.out('');
    const mins = Math.floor(dev.net.time / 6000);
    io.out(dev.ios.hostname + ' uptime is ' + mins + ' minute' + (mins === 1 ? '' : 's'));
    io.out('System image file is "flash0:' + (r ? 'c2900-universalk9-mz.SPA.151-4.M4.bin' : 'c2960-lanbasek9-mz.150-2.SE4.bin') + '"');
    io.out('');
    io.out('cisco ' + dev.model + ' (revision 1.0) with 491520K/32768K bytes of memory.');
    const cnt = (m, pre) => dev.ports.filter((p) => p.media === m && p.name.startsWith(pre)).length;
    if (cnt('copper', 'Gigabit') + cnt('fiber', 'Gigabit')) io.out((cnt('copper', 'Gigabit') + cnt('fiber', 'Gigabit')) + ' Gigabit Ethernet interfaces');
    if (cnt('copper', 'Fast')) io.out(cnt('copper', 'Fast') + ' FastEthernet interfaces');
    if (cnt('serial', 'Serial')) io.out(cnt('serial', 'Serial') + ' Serial(sync/async) interfaces');
    io.out('DRAM configuration is 64 bits wide with parity disabled.');
    io.out('255K bytes of non-volatile configuration memory.');
    io.out('');
    io.out('Configuration register is 0x2102');
  }

  function showStartup(dev, io) {
    if (!dev.nvram) { io.out('startup-config is not present'); return; }
    const t = dev.nvram.text || [];
    io.out('Using ' + t.join('\n').length + ' bytes');
    t.forEach((l) => io.out(l));
  }

  function iosShow(dev, s, a, io) {
    const isR = dev.type === 'router';
    if (!a.length) { incomplete(io); return; }
    const w = a[0];
    for (const fn of EXT.show) if (fn(dev, s, a, io, CTX)) return;
    if (kw(w, 'running-config', 3)) {
      const L = runningConfig(dev);
      io.out('Building configuration...');
      io.out('');
      io.out('Current configuration : ' + L.join('\n').length + ' bytes');
      L.forEach((l) => io.out(l));
      return;
    }
    if (kw(w, 'startup-config', 3)) { showStartup(dev, io); return; }
    if (kw(w, 'version', 2)) { showVersion(dev, io); return; }
    if (kw(w, 'clock', 2)) { io.out((dev.ntpRt && dev.ntpRt.synced ? '' : '*') + dev.clock()); return; }
    if (kw(w, 'history', 2)) { s.history.slice(-20).forEach((l) => io.out('  ' + l)); return; }
    if (kw(w, 'users', 2)) {
      io.out('    Line       User       Host(s)              Idle       Location');
      io.out('*  0 ' + (s.via === 'vty' ? 'vty 0     ' : 'con 0     ') + pad(s.user || '', 11) + pad('idle', 21) + pad('00:00:00', 11) + (s.remoteIp ? ip(s.remoteIp) : ''));
      return;
    }
    if (kw(w, 'flash', 2) || kw(w, 'flash:', 2)) {
      io.out('System flash directory:');
      io.out('File  Length   Name/status');
      io.out('  3   33591768 ' + (isR ? 'c2900-universalk9-mz.SPA.151-4.M4.bin' : 'c2960-lanbasek9-mz.150-2.SE4.bin'));
      io.out('[33591768 bytes used, 221896232 available, 255488000 total]');
      return;
    }
    if (kw(w, 'cdp', 2)) {
      if (kw(a[1], 'neighbors', 1)) { showCdp(dev, io, kw(a[2], 'detail', 1)); return; }
      io.out('Global CDP information:');
      io.out('        Sending CDP packets every 60 seconds');
      io.out('        Sending a holdtime value of 180 seconds');
      io.out('        Sending CDPv2 advertisements is ' + (dev.ios.cdp ? 'enabled' : 'disabled'));
      return;
    }
    if (kw(w, 'access-lists', 2)) {
      const list = a[1] ? [dev.acls.get(a[1])].filter(Boolean) : [...dev.acls.values()];
      for (const acl of list) acl.showLines().forEach((l) => io.out(l));
      return;
    }
    if (kw(w, 'ip', 2)) {
      const b = a[1];
      if (kw(b, 'route', 2)) { showIpRoute(dev, io, a[2] && ['connected', 'static', 'ospf', 'rip'].find((x) => kw(a[2], x, 1))); return; }
      if (kw(b, 'interface', 3)) {
        if (kw(a[2], 'brief', 1)) { showIpIntBrief(dev, io); return; }
        showInterfaces(dev, io, a.slice(2).join(''));
        return;
      }
      if (kw(b, 'arp', 1)) { showArp(dev, io); return; }
      if (kw(b, 'protocols', 1)) { showProtocols(dev, io); return; }
      if (kw(b, 'ospf', 1)) {
        if (kw(a[2], 'neighbor', 1)) { showOspfNeighbor(dev, io); return; }
        if (!dev.ospf) { io.out('% OSPF не запущен.'); return; }
        io.out(' Routing Process "ospf ' + dev.ospf.pid + '" with ID ' + ip(NS.routing.routerId(dev)));
        io.out(' Number of areas in this router is ' + new Set(dev.ospf.networks.map((n) => n.area)).size);
        return;
      }
      if (kw(b, 'ssh', 2)) {
        const prob = dev.sshProblem();
        io.out(dev.ios.rsa ? 'SSH Enabled - version ' + (dev.ios.sshVer === 2 ? '2.0' : '1.99') : 'SSH Disabled - version 1.99');
        if (!dev.ios.rsa) io.out('%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).');
        io.out('Authentication timeout: 120 secs; Authentication retries: 3');
        if (prob) io.out('Подсказка: для входа по SSH ' + prob + '.', 'hint');
        return;
      }
      if (isR && kw(b, 'dhcp', 1)) {
        if (kw(a[2], 'binding', 1)) { showDhcpBinding(dev, io); return; }
        if (kw(a[2], 'pool', 1)) { showDhcpPool(dev, io); return; }
      }
      if (kw(b, 'nat', 1) && dev.nat) {
        if (kw(a[2], 'translations', 1)) { dev.nat.showLines().forEach((l) => io.out(l)); return; }
        if (kw(a[2], 'statistics', 1)) {
          io.out('Total translations: ' + (dev.nat.table.length + dev.nat.statics.length) + ' (' + dev.nat.statics.length + ' static, ' + dev.nat.table.filter((e) => e.type !== 'static').length + ' dynamic)');
          io.out('Outside Interfaces: ' + dev.ifaces.filter((f) => f.nat === 'outside').map((f) => f.name).join(', '));
          io.out('Inside Interfaces: ' + dev.ifaces.filter((f) => f.nat === 'inside').map((f) => f.name).join(', '));
          return;
        }
      }
    }
    if (kw(w, 'arp', 1)) { showArp(dev, io); return; }
    if (kw(w, 'controllers', 3) && isR) {
      const r = parseIfName(dev, a.slice(1).join(''));
      if (!r || r.kind !== 'port' || dev.ports[r.port].media !== 'serial') { io.out('% Укажите serial-интерфейс, например: show controllers serial 0/0/0'); return; }
      const p = dev.ports[r.port];
      io.out('Interface ' + p.name);
      io.out('Hardware is PowerQUICC MPC860');
      if (!p.link) io.out('No serial cable attached');
      else if (dev.isDce(r.port)) io.out('DCE V.35, ' + (p.clockRate ? 'clock rate ' + p.clockRate : 'no clock'));
      else io.out('DTE V.35 TX and RX clocks detected');
      return;
    }
    if (kw(w, 'interfaces', 3)) {
      if (!isR && kw(a[1], 'trunk', 1)) { showTrunk(dev, io); return; }
      if (!isR && kw(a[1], 'status', 1)) { showIntStatus(dev, io); return; }
      showInterfaces(dev, io, a.slice(1).join(''));
      return;
    }
    if (!isR) {
      if (kw(w, 'mac', 1) || kw(w, 'mac-address-table', 4)) { showMac(dev, io); return; }
      if (kw(w, 'vlan', 1)) { showVlan(dev, io); return; }
      if (kw(w, 'spanning-tree', 2)) { showStp(dev, io); return; }
      if (kw(w, 'port-security', 2)) {
        if (kw(a[1], 'interface', 1)) { showPortSecurity(dev, io, a.slice(2).join('')); return; }
        if (kw(a[1], 'address', 1)) {
          io.out('               Secure Mac Address Table');
          io.out('-----------------------------------------------------------------------------');
          io.out('Vlan    Mac Address       Type                          Ports   Remaining Age');
          for (const p of dev.ports) for (const m of (p.ps && p.ps.macs) || []) io.out(pad(p.vlan, 8) + pad(U.ciscoMac(m.mac), 18) + pad(m.sticky ? 'SecureSticky' : m.manual ? 'SecureConfigured' : 'SecureDynamic', 30) + shortIf(p.name));
          return;
        }
        showPortSecurity(dev, io, null);
        return;
      }
    }
    io.out("% Invalid input detected at '" + w + "'.");
  }

  /* ================= удалённые сеансы (telnet / ssh с устройства) ================= */

  /** Общий для ПК и IOS запуск удалённой консоли внутри сеанса s. */
  function startRemote(dev, s, io, proto, target, user) {
    let finished = false;
    const job = {
      done: false,
      cancel() { if (s.remote && s.remote.sess) s.remote.sess.close(); s.remote = null; finish(); },
      finish() { job.done = true; dev.jobs.delete(job); },
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      job.finish();
      io.done();
    };
    dev.jobs.add(job);
    // вывод удалённой стороны идёт в текущую команду терминала
    const outTo = () => (s.remote && s.remote.io) || io;
    const r0 = { sess: null, prompt: '', mask: false, waiting: true, onReady: null, io };
    s.remote = r0;
    const sess = dev.openRemote(proto, target, user, {
      onOutput: (lines) => { const o = outTo(); lines.forEach((l) => o.out(l)); },
      onPrompt: (p, mask) => {
        if (!s.remote) return;
        s.remote.prompt = p;
        s.remote.mask = mask;
        if (s.remote.waiting) { s.remote.waiting = false; const d = s.remote.onReady; s.remote.onReady = null; if (d) d(); }
        finish();
      },
      onClose: (reason) => {
        const o = outTo();
        const r = s.remote;
        s.remote = null;
        if (reason) o.out(reason);
        if (r && r.onReady) { const d = r.onReady; r.onReady = null; d(); }
        finish();
      },
    });
    r0.sess = sess;
    return job;
  }

  /** Строка в удалённый сеанс; job завершится, когда придёт следующий prompt. */
  function remoteLine(dev, s, line, io) {
    const r = s.remote;
    const job = {
      done: false,
      cancel() { r.sess.close(); },
      finish() { job.done = true; dev.jobs.delete(job); },
    };
    dev.jobs.add(job);
    r.io = io;
    r.waiting = true;
    r.onReady = () => { job.finish(); io.done(); };
    const sessOut = r.sess;
    // вывод удалённой стороны печатает обработчик onOutput, заданный в startRemote
    sessOut.send(line, r.mask);
    return job;
  }

  /* ================= выполнение команд ================= */

  function execCommon(dev, s, t, io, line) {
    for (const fn of EXT.exec) {
      const r = fn(dev, s, t, io, line, CTX);
      if (r) return r;
    }
    // команды, доступные и в user, и в privileged
    if (kw(t[0], 'enable', 2)) { if (s.mode === 'user') doEnable(dev, s, io); return { handled: true }; }
    if (kw(t[0], 'disable', 4)) { s.mode = 'user'; return { handled: true }; }
    if (kw(t[0], 'show', 2)) { iosShow(dev, s, t.slice(1), io); return { handled: true }; }
    if (kw(t[0], 'exit', 3) || kw(t[0], 'logout', 4) || kw(t[0], 'quit', 1)) { doExit(dev, s, io); return { handled: true }; }
    if (kw(t[0], 'ping', 1)) {
      if (!dev.ifaces.some((f) => f.ip != null)) { io.out('% Нет ни одного IP-адреса на устройстве — ping невозможен.'); return { handled: true }; }
      return { handled: true, job: iosPing(dev, t.slice(1), io) };
    }
    if (kw(t[0], 'traceroute', 3) || kw(t[0], 'tracert', 6)) return { handled: true, job: iosTraceroute(dev, t.slice(1), io) };
    if (kw(t[0], 'telnet', 3)) {
      if (!t[1]) { incomplete(io); return { handled: true }; }
      return { handled: true, job: startRemote(dev, s, io, 'telnet', t[1], null) };
    }
    if (kw(t[0], 'ssh', 3)) {
      const i = t.indexOf('-l');
      const user = i >= 0 ? t[i + 1] : null;
      const host = t.filter((x, k) => k > 0 && x !== '-l' && k !== i + 1).pop();
      if (!user || !host) { io.out('Использование: ssh -l <пользователь> <адрес>'); return { handled: true }; }
      return { handled: true, job: startRemote(dev, s, io, 'ssh', host, user) };
    }
    if (kw(t[0], 'terminal', 3)) return { handled: true };
    return null;
  }

  function iosPing(dev, args, io) {
    let target = null;
    let count = 5;
    for (let i = 0; i < args.length; i++) {
      if (kw(args[i], 'repeat', 2)) { count = parseInt(args[++i], 10); if (!(count > 0)) { invalid(io, args[i]); return null; } }
      else if (kw(args[i], 'source', 2)) i++;
      else if (!target) target = args[i];
    }
    if (!target) { incomplete(io); return null; }
    let started = false;
    return dev.ping(target, {
      count,
      onEvent(ev) {
        switch (ev.type) {
          case 'resolve-fail': io.out('% Unrecognized host or address, or protocol not running.'); break;
          case 'start':
            started = true;
            io.out('Type escape sequence to abort.');
            io.out('Sending ' + count + ', 100-byte ICMP Echos to ' + ip(ev.ip) + ', timeout is 2 seconds:');
            break;
          case 'reply': io.write('!'); break;
          case 'timeout': case 'error': io.write('.'); break;
          case 'unreachable': io.write(ev.code === 13 ? 'A' : 'U'); break;
          case 'ttl-expired': io.write('&'); break;
          case 'done':
            if (started) {
              io.out('');
              const pct = ev.sent ? Math.round((ev.received / ev.sent) * 100) : 0;
              let str = 'Success rate is ' + pct + ' percent (' + ev.received + '/' + ev.sent + ')';
              if (ev.rtts.length) {
                const min = Math.min(...ev.rtts);
                const max = Math.max(...ev.rtts);
                const avg = Math.round(ev.rtts.reduce((x, y) => x + y, 0) / ev.rtts.length);
                str += ', round-trip min/avg/max = ' + min + '/' + avg + '/' + max + ' ms';
              }
              io.out(str);
            }
            io.done();
            break;
          default: break;
        }
      },
    });
  }

  function iosTraceroute(dev, args, io) {
    const target = args[0];
    if (!target) { incomplete(io); return null; }
    return dev.traceroute(target, {
      onEvent(ev) {
        if (ev.type === 'resolve-fail') io.out('% Unrecognized host or address, or protocol not running.');
        else if (ev.type === 'start') {
          io.out('Type escape sequence to abort.');
          io.out('Tracing the route to ' + ip(ev.ip));
          io.out('');
        } else if (ev.type === 'hop') {
          const mark = ev.kind === 'unreachable' ? (ev.code === 0 ? '!N' : ev.code === 13 ? '!A' : '!H') : null;
          const cols = ev.rtts.map((r) => (r == null ? '*' : mark || r + ' msec')).join(' ');
          io.out(padL(ev.ttl, 3) + ' ' + (ev.from != null ? ip(ev.from) + ' ' : '') + cols);
        } else if (ev.type === 'done') io.done();
      },
    });
  }

  function iosExec(dev, s, t, io, line) {
    const c = execCommon(dev, s, t, io, line);
    if (c) return c.job || null;
    if (s.mode === 'user') {
      if (kw(t[0], 'configure', 4)) { io.out('% Сначала введите enable (привилегированный режим).'); return null; }
      invalid(io, t[0]);
      return null;
    }
    if (kw(t[0], 'configure', 4)) {
      if (t[1] && !kw(t[1], 'terminal', 1)) { invalid(io, t[1]); return null; }
      io.out('Enter configuration commands, one per line.  End with CNTL/Z.');
      s.mode = 'config';
      return null;
    }
    if (kw(t[0], 'clear', 3)) {
      if (kw(t[1], 'arp-cache', 1) || kw(t[1], 'arp', 1)) { dev.clearArp(); return null; }
      if (dev.flushMacTable && (kw(t[1], 'mac', 1) || kw(t[1], 'mac-address-table', 4))) { dev.flushMacTable(); return null; }
      if (dev.nat && kw(t[1], 'ip', 1) && kw(t[2], 'nat', 1)) { dev.nat.clearDynamic(); return null; }
      if (kw(t[1], 'port-security', 5)) { for (const p of dev.ports) if (p.ps) p.ps.macs = p.ps.macs.filter((m) => m.manual); return null; }
      invalid(io, t[1]);
      return null;
    }
    if (kw(t[0], 'clock', 2) && kw(t[1], 'set', 1)) {
      // clock set 10:30:00 15 March 2024
      const tm = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(t[2] || '');
      const day = Number(t[3]);
      const mon = U.MONTHS.findIndex((m) => kw(t[4], m, 3));
      const year = Number(t[5]);
      if (!tm || !(day >= 1 && day <= 31) || mon < 0 || !(year >= 1993 && year <= 2035)) { io.out('Использование: clock set чч:мм:сс день месяц год (например clock set 10:30:00 15 March 2024)'); return null; }
      const target = Date.UTC(year, mon, day, Number(tm[1]), Number(tm[2]), Number(tm[3]));
      dev.clockOffset = target - (Date.UTC(1993, 2, 1) + dev.net.time * 10);
      return null;
    }
    if ((kw(t[0], 'copy', 2) && kw(t[1], 'running-config', 3) && kw(t[2], 'startup-config', 3)) || (kw(t[0], 'write', 2) && (!t[1] || kw(t[1], 'memory', 1)))) {
      const save = () => {
        io.out('Building configuration...');
        io.mutate(() => dev.saveNvram());
        io.out('[OK]');
      };
      if (kw(t[0], 'write', 2)) { save(); return null; }
      s.pending = { prompt: 'Destination filename [startup-config]? ', handle: () => { save(); return null; } };
      return null;
    }
    if (kw(t[0], 'copy', 2) && kw(t[1], 'startup-config', 3) && kw(t[2], 'running-config', 3)) {
      if (!dev.nvram) { io.out('%% Non-volatile configuration memory is not present'); return null; }
      s.pending = {
        prompt: 'Destination filename [running-config]? ',
        handle: () => {
          const n = replayConfig(dev, dev.nvram.text || [], io);
          io.out(n + ' bytes copied');
          return null;
        },
      };
      return null;
    }
    if (kw(t[0], 'copy', 2) && (kw(t[1], 'running-config', 3) || kw(t[1], 'startup-config', 3)) && kw(t[2], 'tftp:', 2)) {
      const lines = kw(t[1], 'running-config', 3) ? runningConfig(dev) : (dev.nvram ? dev.nvram.text : null);
      if (!lines) { io.out('%% Non-volatile configuration memory is not present'); return null; }
      return tftpDialog(dev, s, io, 'put', lines);
    }
    if (kw(t[0], 'copy', 2) && kw(t[1], 'tftp:', 2) && (kw(t[2], 'running-config', 3) || kw(t[2], 'startup-config', 3))) {
      return tftpDialog(dev, s, io, kw(t[2], 'running-config', 3) ? 'run' : 'start');
    }
    if (kw(t[0], 'erase', 3) && (kw(t[1], 'startup-config', 3) || kw(t[1], 'nvram:', 2))) {
      s.pending = {
        prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]',
        handle: (a) => {
          if (a.trim() && !/^y/i.test(a.trim())) return null;
          io.mutate(() => dev.eraseNvram());
          io.out('[OK]');
          io.out('Erase of nvram: complete');
          return null;
        },
      };
      return null;
    }
    if (kw(t[0], 'reload', 3)) {
      const proceed = () => {
        s.pending = {
          prompt: 'Proceed with reload? [confirm]',
          handle: (a) => {
            if (a.trim() && !/^y/i.test(a.trim())) return null;
            io.out('');
            io.out('%SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.');
            io.mutate(() => { dev.net.setPower(dev, false); dev.net.setPower(dev, true); });
            s.mode = 'user';
            s.stage = 'press-return';
            if (s.via === 'vty') s.closed = true;
            io.out('');
            io.out('Press RETURN to get started!');
            return null;
          },
        };
      };
      if (dev.nvramDirty()) {
        s.pending = {
          prompt: 'System configuration has been modified. Save? [yes/no]:',
          handle: (a) => {
            const v = a.trim().toLowerCase();
            if (v.startsWith('y')) { io.out('Building configuration...'); io.mutate(() => dev.saveNvram()); io.out('[OK]'); }
            else if (!v.startsWith('n')) { io.out('% Please answer \'yes\' or \'no\'.'); return null; }
            proceed();
            return null;
          },
        };
      } else proceed();
      return null;
    }
    invalid(io, t[0]);
    return null;
  }

  /** Диалог copy … tftp: — адрес сервера, имя файла, передача. */
  function tftpDialog(dev, s, io, dir, lines) {
    let server = null;
    const job = {
      done: false,
      cancel() { job.finish(); io.done(); },
      finish() { job.done = true; dev.jobs.delete(job); },
    };
    const def = (dev.ios.hostname + '-confg').toLowerCase();
    s.pending = {
      prompt: 'Address or name of remote host []? ',
      handle: (a) => {
        server = a.trim();
        s.pending = {
          prompt: (dir === 'put' ? 'Destination' : 'Source') + ' filename [' + def + ']? ',
          handle: (fn) => {
            const name = fn.trim() || def;
            dev.jobs.add(job);
            dev.resolveName(server, (addr, err) => {
              if (job.done) return;
              if (addr == null) { io.out('%Error opening tftp://' + server + '/' + name + ' (' + (err || 'Unknown host') + ')'); job.finish(); io.done(); return; }
              if (dir === 'put') {
                io.write('Writing ' + name + '...');
                dev.tftp(addr, 'WRQ', name, lines.join('\n'), (r) => {
                  if (job.done) return;
                  io.out(r.ok ? '!!' : '');
                  io.out(r.ok ? '[OK - ' + lines.join('\n').length + ' bytes]' : '%Error opening tftp://' + ip(addr) + '/' + name + ' (' + r.error + ')');
                  job.finish();
                  io.done();
                });
              } else {
                io.out('Accessing tftp://' + ip(addr) + '/' + name + '...');
                dev.tftp(addr, 'RRQ', name, null, (r) => {
                  if (job.done) return;
                  if (!r.ok) io.out('%Error opening tftp://' + ip(addr) + '/' + name + ' (' + r.error + ')');
                  else {
                    const text = String(r.data || '').split('\n');
                    io.out('Loading ' + name + ' from ' + ip(addr) + ': !');
                    io.out('[OK - ' + String(r.data || '').length + ' bytes]');
                    if (dir === 'run') replayConfig(dev, text, io);
                    else {
                      const tmp = dev.configState();
                      replayConfig(dev, text, io, true);
                      io.mutate(() => dev.saveNvram());
                      io.mutate(() => dev.applyConfigState(tmp));
                    }
                  }
                  job.finish();
                  io.done();
                });
              }
            });
            return job;
          },
        };
        return null;
      },
    };
    return null;
  }

  /** Выполнить строки конфигурации (как при copy tftp running-config). Возвращает число байт. */
  /** Информационное сообщение IOS (%LINK-…, % Generating …), а не ошибка команды. */
  function isInfo(l) { return /^%[A-Za-z0-9_]+-\d|^% (Generating|Access VLAN does not exist|Voice VLAN does not exist|Login disabled|NOTE:)/.test(String(l)); }

  function replayConfig(dev, lines, io, quiet) {
    const s = createSession(dev, { via: 'local' });
    s.stage = null;
    s.replay = true;
    s.mode = 'config';
    let errors = 0;
    const sub = {
      out: (l) => { if (/^%/.test(l) && !isInfo(l)) { errors++; if (!quiet) io.out(l); } },
      write: () => {},
      clear: () => {},
      done: () => {},
      mutate: io.mutate,
    };
    io.mutate(() => {
      for (const raw of lines) {
        const l = String(raw).replace(/\r$/, '');
        const t = l.trim();
        // служебные строки шапки — только без отступа (« version 2» внутри router rip — настоящая команда)
        if (!t || t.startsWith('!') || /^(version |building|current configuration|no service timestamps|end$|using \d+)/i.test(l)) continue;
        if (s.mode !== 'config' && !/^\s/.test(l) && !/^(permit|deny|remark)/i.test(t)) s.mode = 'config';
        try { execConfigLine(dev, s, t, sub); } catch (e) { errors++; }
      }
    });
    if (errors && !quiet) io.out('% При применении конфигурации было ошибок: ' + errors, 'hint');
    return lines.join('\n').length;
  }

  /* ---------- config ---------- */

  function ifaceOf(dev, r) {
    if (r.kind === 'named') return dev.ifaceByName(r.name);
    if (r.kind === 'vlan') return dev.ifaces.find((f) => f.kind === 'svi' && f.vlan === r.vlan) || null;
    if (r.kind === 'loop') return dev.ifaceByName('Loopback' + r.n);
    if (r.sub != null) return dev.ifaceByName(dev.ports[r.port].name + '.' + r.sub);
    return dev.ifaces.find((f) => f.port === r.port && (f.kind === 'phys' || f.kind === 'routed')) || null;
  }

  function iosConfig(dev, s, t, io) {
    const isR = dev.type === 'router';
    const neg = kw(t[0], 'no', 2);
    const a = neg ? t.slice(1) : t;
    const w = a[0];
    for (const fn of EXT.config) if (fn(dev, s, a, neg, io, CTX)) return;

    if (kw(w, 'hostname', 3) && !neg) {
      if (!a[1]) { incomplete(io); return; }
      withMutate(io, () => dev.setHostname(a[1]));
      return;
    }

    if (kw(w, 'interface', 3)) {
      if (kw(a[1], 'range', 1)) {
        if (neg) { invalid(io, a[1]); return; }
        const rest = a.slice(2).join(' ');
        const list = [];
        for (const part of rest.split(',')) {
          const m = /^\s*([a-z]+)\s*(\d+)\/(\d+)\s*(?:-\s*(\d+))?\s*$/i.exec(part);
          if (!m) { invalid(io, part.trim()); return; }
          const last = m[4] != null ? Number(m[4]) : Number(m[3]);
          for (let k = Number(m[3]); k <= last; k++) {
            const r = parseIfName(dev, m[1] + m[2] + '/' + k);
            if (!r || r.kind !== 'port') { io.out('% Интерфейс ' + m[1] + m[2] + '/' + k + ' не найден'); return; }
            list.push(r);
          }
        }
        if (!list.length) { incomplete(io); return; }
        s.ifs = list;
        s.mode = 'if';
        return;
      }
      const name = a.slice(1).join('');
      if (!name) { incomplete(io); return; }
      const r = parseIfName(dev, name);
      if (!r) { io.out('% Invalid interface: ' + name); return; }
      if (neg) {
        if (r.kind === 'named') { withMutate(io, () => r.remove(dev)); return; }
        if (r.kind === 'vlan' && !isR) { withMutate(io, () => dev.removeSvi(r.vlan)); return; }
        const f = ifaceOf(dev, r);
        if (!f || (f.kind !== 'sub' && f.kind !== 'loop')) { io.out('% Удалить можно только подынтерфейс, loopback или interface vlan.'); return; }
        withMutate(io, () => dev.removeIface(f));
        return;
      }
      if (r.kind === 'named') {
        if (!dev.ifaceByName(r.name) && !withMutate(io, () => r.create(dev))) return;
      } else if (r.kind === 'vlan') {
        if (isR) { io.out('% Интерфейсы VLAN есть только у коммутатора. На маршрутизаторе используйте подынтерфейсы (interface g0/0.10).'); return; }
        if (!withMutate(io, () => dev.addSvi(r.vlan))) return;
      } else if (r.kind === 'loop') {
        if (!isR) { io.out('% Loopback-интерфейсы в NetLab есть только у маршрутизатора.'); return; }
        if (!withMutate(io, () => dev.addLoopback(r.n))) return;
      } else if (r.sub != null) {
        if (!isR) { io.out('% Подынтерфейсы есть только у маршрутизатора.'); return; }
        const full = dev.ports[r.port].name + '.' + r.sub;
        if (!dev.ifaceByName(full) && !withMutate(io, () => dev.addSubif(r.port, r.sub))) return;
      } else if (!NS.Network.isData(dev.ports[r.port])) {
        io.out('% Это консольный порт — его нельзя настраивать.');
        return;
      }
      s.ifs = [r];
      s.mode = 'if';
      return;
    }

    if (kw(w, 'ip', 2)) {
      const b = a[1];
      if (kw(b, 'route', 1)) {
        const net = U.parseIp(a[2] || '');
        const mask = U.parseMask(a[3] || '');
        if (neg) {
          if (net == null || mask == null) { invalid(io, a[2]); return; }
          let found = false;
          withMutate(io, () => { found = dev.removeRoute(net, mask, a[4] ? U.parseIp(a[4]) : null); });
          if (!found) io.out('% Такого маршрута нет.');
          return;
        }
        if (!a[4]) { incomplete(io); return; }
        if (net == null) { invalid(io, a[2]); return; }
        if (mask == null) { invalid(io, a[3]); return; }
        let nh = U.parseIp(a[4]);
        let ifName = null;
        let k = 5;
        if (nh == null) {
          const r = parseIfName(dev, a[4]);
          const f = r && ifaceOf(dev, r);
          if (!f) { invalid(io, a[4]); return; }
          ifName = f.name;
          if (a[5] && U.parseIp(a[5]) != null) { nh = U.parseIp(a[5]); k = 6; }
        }
        const ad = a[k] ? Number(a[k]) : 1;
        withMutate(io, () => dev.addRoute(net, mask, nh, { ifName, ad }));
        return;
      }
      if (kw(b, 'routing', 3)) {
        if (isR) { if (neg) io.out('% В NetLab маршрутизатор всегда маршрутизирует.'); return; }
        withMutate(io, () => dev.setIpRouting(!neg));
        return;
      }
      if (kw(b, 'default-gateway', 3) && !isR) {
        if (neg) { withMutate(io, () => { dev.defaultGateway = null; dev.net.markRouting(); }); return; }
        const g = U.parseIp(a[2] || '');
        if (g == null) { invalid(io, a[2]); return; }
        withMutate(io, () => { dev.defaultGateway = g; dev.net.markRouting(); });
        return;
      }
      if (kw(b, 'domain-name', 8) || (kw(b, 'domain', 3) && kw(a[2], 'name', 1))) {
        const v = kw(b, 'domain-name', 8) ? a[2] : a[3];
        withMutate(io, () => { dev.ios.domain = neg ? '' : String(v || '').toLowerCase(); });
        return;
      }
      if (kw(b, 'domain-lookup', 8)) return;
      if (kw(b, 'name-server', 2)) {
        withMutate(io, () => { dev.dns = neg ? null : U.parseIp(a[2] || ''); });
        return;
      }
      if (kw(b, 'ssh', 2)) {
        if (kw(a[2], 'version', 1)) withMutate(io, () => { dev.ios.sshVer = neg ? 2 : Number(a[3]) === 1 ? 1 : 2; });
        return;
      }
      if (kw(b, 'cef', 3) || kw(b, 'classless', 3) || kw(b, 'http', 3) || kw(b, 'subnet-zero', 3)) return;
      if (isR && kw(b, 'dhcp', 1)) {
        if (kw(a[2], 'pool', 1)) {
          const name = a[3];
          if (!name) { incomplete(io); return; }
          if (neg) { withMutate(io, () => dev.dhcpd.removePool(name)); return; }
          const existing = dev.dhcpd.pools.find((p) => p.name === name);
          s.pool = existing ? { name, committed: true } : { name, committed: false, gateway: null, dns: null };
          s.mode = 'pool';
          return;
        }
        if (kw(a[2], 'excluded-address', 1)) {
          const from = U.parseIp(a[3] || '');
          const to = a[4] ? U.parseIp(a[4]) : from;
          if (from == null || to == null) { invalid(io, a[3]); return; }
          if (neg) withMutate(io, () => { dev.dhcpd.excluded = dev.dhcpd.excluded.filter((r) => !(r.from === from && r.to === to)); });
          else withMutate(io, () => dev.dhcpd.addExcluded(from, to));
          return;
        }
      }
      if (kw(b, 'nat', 1) && dev.nat) { natConfig(dev, a.slice(2), neg, io); return; }
      if (kw(b, 'access-list', 3)) {
        const type = kw(a[2], 'standard', 1) ? 'standard' : kw(a[2], 'extended', 1) ? 'extended' : null;
        const name = a[3];
        if (!type || !name) { incomplete(io); return; }
        if (neg) { withMutate(io, () => dev.acls.delete(name)); return; }
        let acl = dev.acls.get(name);
        if (acl && acl.type !== type) { io.out('% Список ' + name + ' уже существует с другим типом'); return; }
        if (!acl) withMutate(io, () => { acl = new NS.AccessList(name, type); dev.acls.set(name, acl); });
        s.acl = acl;
        s.mode = 'acl';
        return;
      }
    }

    if (kw(w, 'access-list', 3)) {
      const num = a[1];
      const type = NS.AccessList.typeForNumber(num);
      if (!type) { io.out('% Номер списка: 1–99 (стандартный) или 100–199 (расширенный)'); return; }
      if (neg) { withMutate(io, () => dev.acls.delete(String(num))); return; }
      if (!a[2]) { incomplete(io); return; }
      withMutate(io, () => {
        let acl = dev.acls.get(String(num));
        if (!acl) { acl = new NS.AccessList(String(num), type); dev.acls.set(acl.name, acl); }
        acl.add(a.slice(2));
      });
      return;
    }

    if (kw(w, 'service', 3)) {
      if (kw(a[1], 'password-encryption', 3)) { withMutate(io, () => { dev.ios.encrypt = !neg; }); return; }
      if (isR && kw(a[1], 'dhcp', 1)) { withMutate(io, () => { dev.dhcpd.enabled = !neg; }); return; }
      if (kw(a[1], 'timestamps', 2)) return;
      invalid(io, a[1]);
      return;
    }

    if (kw(w, 'enable', 2)) {
      const kind = kw(a[1], 'secret', 1) ? 'secret' : kw(a[1], 'password', 1) ? 'password' : null;
      if (!kind) { incomplete(io); return; }
      if (neg) { withMutate(io, () => { if (kind === 'secret') dev.ios.enableSecret = null; else dev.ios.enablePassword = null; }); return; }
      let v = a[2];
      let lvl = null;
      if ((a[2] === '0' || a[2] === '5' || a[2] === '7') && a[3]) { lvl = a[2]; v = a[3]; }
      if (!v) { incomplete(io); return; }
      withMutate(io, () => {
        if (kind === 'secret') { if (lvl === '5') dev.ios.enableSecret = v; else dev.setEnableSecret(v); }
        else dev.setEnablePassword(lvl === '7' ? (U.type7decode(v) || v) : v);
      });
      if (kind === 'password' && dev.ios.enableSecret) io.out('% Внимание: задан enable secret — он имеет приоритет над enable password.', 'hint');
      return;
    }

    if (kw(w, 'username', 3)) {
      const name = a[1];
      if (!name) { incomplete(io); return; }
      if (neg) { withMutate(io, () => { dev.ios.users = dev.ios.users.filter((u) => u.name !== name); }); return; }
      let i = 2;
      let priv = 1;
      if (kw(a[i], 'privilege', 2)) { priv = Number(a[i + 1]) || 1; i += 2; }
      const kind = kw(a[i], 'secret', 1) ? 'secret' : kw(a[i], 'password', 1) ? 'password' : null;
      if (!kind) { incomplete(io); return; }
      let v = a[i + 1];
      let lvl = null;
      if ((v === '0' || v === '5' || v === '7') && a[i + 2]) { lvl = v; v = a[i + 2]; }
      if (!v) { incomplete(io); return; }
      withMutate(io, () => {
        if (kind === 'secret' && lvl === '5') {
          dev.ios.users = dev.ios.users.filter((u) => u.name !== name);
          dev.ios.users.push({ name, pass: v, secret: true, priv });
        } else dev.setUser(name, lvl === '7' ? (U.type7decode(v) || v) : v, kind === 'secret', priv);
      });
      return;
    }

    if (kw(w, 'banner', 3)) {
      if (neg) { withMutate(io, () => { dev.ios.banner = ''; }); return; }
      if (!kw(a[1], 'motd', 1)) { invalid(io, a[1]); return; }
      const raw = t.slice(neg ? 3 : 2).join(' ');
      let text = raw;
      if (raw.startsWith('^C')) text = raw.slice(2).replace(/\^C\s*$/, '');
      else if (raw.length) {
        const d = raw[0];
        const end = raw.indexOf(d, 1);
        text = end > 0 ? raw.slice(1, end) : raw.slice(1);
      }
      withMutate(io, () => { dev.ios.banner = text.trim(); });
      return;
    }

    if (kw(w, 'crypto', 2) && kw(a[1], 'key', 1)) {
      if (kw(a[2], 'zeroize', 1)) { withMutate(io, () => { dev.ios.rsa = null; }); return; }
      if (!kw(a[2], 'generate', 1)) { invalid(io, a[2]); return; }
      if (!dev.ios.domain) { io.out('% Please define a domain-name first.'); return; }
      const gen = (bits) => {
        if (!(bits >= 360 && bits <= 4096)) { io.out('% Размер ключа: 360–4096 бит'); return; }
        io.out('% Generating ' + bits + ' bit RSA keys, keys will be non-exportable...[OK]');
        withMutate(io, () => { dev.ios.rsa = bits; });
        if (bits < 768) io.out('% Для SSH версии 2 нужен ключ не меньше 768 бит.', 'hint');
      };
      const mi = a.findIndex((x) => kw(x, 'modulus', 3));
      if (mi >= 0 && a[mi + 1]) { gen(Number(a[mi + 1])); return; }
      io.out('The name for the keys will be: ' + dev.ios.hostname + '.' + dev.ios.domain);
      io.out('Choose the size of the key modulus in the range of 360 to 4096 for your');
      io.out('  General Purpose Keys. Choosing a key modulus greater than 512 may take');
      io.out('  a few minutes.');
      io.out('');
      s.pending = { prompt: 'How many bits in the modulus [512]: ', handle: (v) => { gen(Number(v.trim() || 512)); return null; } };
      return;
    }

    if (kw(w, 'cdp', 2) && kw(a[1], 'run', 1)) { withMutate(io, () => { dev.ios.cdp = !neg; }); return; }

    if (kw(w, 'line', 2)) {
      if (kw(a[1], 'console', 1)) { s.line = 'con'; s.mode = 'line'; return; }
      if (kw(a[1], 'vty', 1)) {
        const last = Number(a[3] != null ? a[3] : a[2]);
        if (!(last >= 0 && last <= 15)) { incomplete(io); return; }
        s.line = 'vty';
        s.mode = 'line';
        return;
      }
      if (kw(a[1], 'aux', 1)) { s.line = 'aux'; s.mode = 'line'; return; }
      invalid(io, a[1]);
      return;
    }

    if (kw(w, 'router', 3)) {
      if (kw(a[1], 'rip', 1)) {
        if (neg) { withMutate(io, () => { dev.rip = { networks: [], version: 1, autoSummary: true, passive: [], defaultOriginate: false }; dev.net.markRouting(); }); return; }
        if (!isR && !dev.l3) { io.out('% Динамическая маршрутизация доступна на маршрутизаторе или коммутаторе 3560.'); return; }
        s.mode = 'rip';
        return;
      }
      if (kw(a[1], 'ospf', 1)) {
        if (neg) { withMutate(io, () => { dev.ospf = null; dev.net.markRouting(); }); return; }
        if (!isR && !dev.l3) { io.out('% Динамическая маршрутизация доступна на маршрутизаторе или коммутаторе 3560.'); return; }
        if (!a[2]) { incomplete(io); return; }
        if (withMutate(io, () => dev.ospfEnable(a[2]))) s.mode = 'ospf';
        return;
      }
      if (kw(a[1], 'eigrp', 1) || kw(a[1], 'bgp', 1)) { io.out('% Динамическая маршрутизация доступна на маршрутизаторе или коммутаторе 3560.'); return; }
      invalid(io, a[1]);
      return;
    }

    if (!isR && kw(w, 'vlan', 1)) {
      if (!a[1]) { incomplete(io); return; }
      const vs = [];
      try { const set = U.parseVlanList(a[1]); if (set) vs.push(...set); } catch (e) { io.out('% ' + e.message); return; }
      if (neg) { withMutate(io, () => { for (const v of vs) dev.removeVlan(v); }); return; }
      if (withMutate(io, () => { for (const v of vs) if (!dev.vlans.has(v)) dev.addVlan(v); })) {
        s.vlan = vs[0];
        s.mode = 'vlan';
      }
      return;
    }

    if (!isR && kw(w, 'spanning-tree', 2)) {
      const i = a.findIndex((x) => kw(x, 'priority', 2));
      if (kw(a[1], 'mode', 1) || kw(a[1], 'portfast', 1)) return;
      if (i < 0 || !a[i + 1]) { if (neg) withMutate(io, () => dev.setStpPriority(32768)); else incomplete(io); return; }
      withMutate(io, () => dev.setStpPriority(neg ? 32768 : Number(a[i + 1])));
      return;
    }

    if (kw(w, 'clock', 2) || kw(w, 'logging', 3) || kw(w, 'ntp', 2) || kw(w, 'no', 2)) return;
    invalid(io, t[0]);
  }

  function natConfig(dev, a, neg, io) {
    // inside source static A B | inside source list N (pool P | interface X) [overload] | pool NAME A B netmask M
    if (kw(a[0], 'pool', 1)) {
      const name = a[1];
      if (neg) { withMutate(io, () => dev.nat.pools.delete(name)); return; }
      const start = U.parseIp(a[2] || '');
      const end = U.parseIp(a[3] || '');
      const mi = a.findIndex((x) => kw(x, 'netmask', 1) || kw(x, 'prefix-length', 1));
      const mask = mi >= 0 ? U.parseMask(a[mi + 1] || '') : null;
      if (!name || start == null || end == null || mask == null) { io.out('Использование: ip nat pool ИМЯ начало конец netmask маска'); return; }
      withMutate(io, () => dev.nat.addPool(name, start, end, mask));
      return;
    }
    if (!kw(a[0], 'inside', 1) || !kw(a[1], 'source', 1)) { invalid(io, a[0]); return; }
    if (kw(a[2], 'static', 1)) {
      const l = U.parseIp(a[3] || '');
      const g = U.parseIp(a[4] || '');
      if (l == null || g == null) { io.out('Использование: ip nat inside source static внутренний внешний'); return; }
      withMutate(io, () => { if (neg) dev.nat.removeStatic(l, g); else dev.nat.addStatic(l, g); });
      return;
    }
    if (kw(a[2], 'list', 1)) {
      const acl = a[3];
      if (!acl) { incomplete(io); return; }
      if (neg) { withMutate(io, () => dev.nat.removeRule(acl)); return; }
      const overload = a.some((x) => kw(x, 'overload', 1));
      if (kw(a[4], 'pool', 1)) { withMutate(io, () => dev.nat.addRule({ acl, pool: a[5], ifName: null, overload })); return; }
      if (kw(a[4], 'interface', 1)) {
        const r = parseIfName(dev, a.slice(5).filter((x) => !kw(x, 'overload', 1)).join(''));
        const f = r && ifaceOf(dev, r);
        if (!f) { io.out('% Интерфейс не найден'); return; }
        withMutate(io, () => dev.nat.addRule({ acl, pool: null, ifName: f.name, overload: true }));
        return;
      }
      incomplete(io);
      return;
    }
    invalid(io, a[2]);
  }

  function iosIf(dev, s, t, io) {
    const isR = dev.type === 'router';
    const neg = kw(t[0], 'no', 2);
    const a = neg ? t.slice(1) : t;
    const w = a[0];
    const targets = s.ifs;
    const each = (fn) => withMutate(io, () => { for (const r of targets) fn(r, ifaceOf(dev, r)); });
    const l3 = (r) => r.kind !== 'port' || r.sub != null || isR || dev.ports[r.port].routed;
    for (const fn of EXT.iface) if (fn(dev, s, a, neg, io, targets, CTX)) return;

    if (kw(w, 'shutdown', 2)) {
      each((r, f) => {
        if (f) dev.setIfaceAdmin(f, neg);
        else if (r.kind === 'port') dev.setPortAdmin(r.port, neg);
      });
      if (neg) {
        for (const r of targets) {
          const f = ifaceOf(dev, r);
          const name = f ? f.name : dev.ports[r.port].name;
          io.out('%LINK-5-CHANGED: Interface ' + name + ', changed state to ' + (dev.net.isPortOperational(dev, r.port) || (f && f.kind === 'loop') ? 'up' : 'down'));
        }
      }
      return;
    }
    if (kw(w, 'description', 1)) { each((r, f) => { if (f) f.desc = neg ? '' : t.slice(1).join(' '); }); return; }
    if (kw(w, 'speed', 2) || kw(w, 'duplex', 2) || kw(w, 'bandwidth', 2)) {
      each((r) => {
        if (r.kind !== 'port') return;
        const p = dev.ports[r.port];
        if (kw(w, 'duplex', 2)) p.duplex = neg ? 'auto' : ['half', 'full', 'auto'].find((x) => kw(a[1], x, 1)) || 'auto';
        else if (kw(w, 'bandwidth', 2)) p.bandwidth = neg ? 'auto' : Math.max(0.001, Number(a[1]) / 1000);
        else p.bandwidth = neg || kw(a[1], 'auto', 1) ? 'auto' : Number(a[1]) || 'auto';
      });
      dev.net.markRouting();
      return;
    }

    if (kw(w, 'ip', 2)) {
      const b = a[1];
      if (kw(b, 'address', 1)) {
        if (targets.some((r) => !l3(r))) { io.out('% Порт коммутатора работает на 2-м уровне. IP-адрес задаётся на interface vlan N' + (dev.l3 ? ' или после no switchport' : '') + '.'); return; }
        if (neg) { each((r, f) => dev.setIfaceIp(f, null, null)); return; }
        if (kw(a[2], 'dhcp', 1)) {
          each((r, f) => { f.dhcp = true; f.ip = null; f.mask = null; dev.addressChanged(f); dev.startDhcp(f); });
          return;
        }
        if (!a[3]) { incomplete(io); return; }
        const addr = U.parseIp(a[2]);
        const mask = U.parseMask(a[3]);
        if (addr == null) { invalid(io, a[2]); return; }
        if (mask == null) { io.out('% Неверная маска ' + a[3]); return; }
        each((r, f) => dev.setIfaceIp(f, addr, mask));
        return;
      }
      if (kw(b, 'helper-address', 1)) {
        if (neg) { each((r, f) => { if (f) f.helper = null; }); return; }
        const h = U.parseIp(a[2] || '');
        if (h == null) { invalid(io, a[2]); return; }
        each((r, f) => { if (f) f.helper = h; });
        return;
      }
      if (kw(b, 'access-group', 1)) {
        const name = a[2];
        const dir = kw(a[3], 'out', 1) ? 'out' : 'in';
        if (!name && !neg) { incomplete(io); return; }
        each((r, f) => { if (!f) return; if (dir === 'in') f.aclIn = neg ? null : name; else f.aclOut = neg ? null : name; });
        return;
      }
      if (kw(b, 'nat', 1)) {
        const role = kw(a[2], 'inside', 1) ? 'inside' : kw(a[2], 'outside', 1) ? 'outside' : null;
        if (!role) { incomplete(io); return; }
        if (!dev.nat) { io.out('% NAT в NetLab настраивается на маршрутизаторе.'); return; }
        each((r, f) => { if (f) f.nat = neg ? null : role; });
        return;
      }
      if (kw(b, 'ospf', 1) || kw(b, 'proxy-arp', 2)) {
        if (kw(b, 'proxy-arp', 2)) withMutate(io, () => { dev.proxyArp = !neg; });
        return;
      }
    }

    if (kw(w, 'encapsulation', 3)) {
      const r = targets[0];
      const f = ifaceOf(dev, r);
      if (kw(a[1], 'dot1q', 1)) {
        if (!f || f.kind !== 'sub') { io.out('% Encapsulation dot1Q задаётся на подынтерфейсе (например, interface g0/0.10).'); return; }
        each(() => dev.setSubifVlan(f, Number(a[2])));
        return;
      }
      if (kw(a[1], 'ppp', 1) || kw(a[1], 'hdlc', 1)) {
        each((rr) => dev.setEncapsulation(rr.port, kw(a[1], 'ppp', 1) ? 'ppp' : 'hdlc'));
        return;
      }
      invalid(io, a[1]);
      return;
    }

    if (kw(w, 'clock', 2) && kw(a[1], 'rate', 1)) {
      if (!isR) { invalid(io, w); return; }
      if (neg) { each((r) => dev.setClockRate(r.port, null)); return; }
      each((r) => dev.setClockRate(r.port, Number(a[2])));
      const r = targets[0];
      if (dev.ports[r.port] && dev.ports[r.port].media === 'serial' && !dev.isDce(r.port) && dev.ports[r.port].link) {
        io.out('% Этот конец кабеля — DTE: clock rate действует только на стороне DCE.', 'hint');
      }
      return;
    }

    if (!isR && kw(w, 'switchport', 2)) { switchportCmd(dev, s, a, neg, io, targets); return; }
    if (!isR && kw(w, 'spanning-tree', 2)) {
      if (kw(a[1], 'portfast', 1)) each((r) => { dev.ports[r.port].portfast = !neg; });
      return;
    }
    if (kw(w, 'cdp', 2) || kw(w, 'mls', 2)) return;
    invalid(io, t[0]);
  }

  function switchportCmd(dev, s, a, neg, io, targets) {
    const each = (fn) => withMutate(io, () => { for (const r of targets) if (r.kind === 'port') fn(r.port, dev.ports[r.port]); });
    if (!a[1]) {
      // switchport / no switchport
      if (neg && !dev.l3) { io.out('% Команда no switchport доступна только на коммутаторе 3-го уровня (3560).'); return; }
      each((i) => dev.setPortRouted(i, neg));
      return;
    }
    if (kw(a[1], 'mode', 1)) {
      const m = kw(a[2], 'trunk', 1) ? 'trunk' : kw(a[2], 'access', 1) ? 'access' : kw(a[2], 'dynamic', 1) ? (kw(a[3], 'desirable', 1) ? 'dynamic desirable' : kw(a[3], 'auto', 1) ? 'dynamic auto' : null) : null;
      if (!m && !neg) { if (kw(a[2], 'dynamic', 1)) incomplete(io); else invalid(io, a[2]); return; }
      each((i) => dev.setPortMode(i, neg ? 'dynamic auto' : m));
      return;
    }
    if (kw(a[1], 'access', 1) && kw(a[2], 'vlan', 1)) {
      if (neg) { each((i) => dev.setAccessVlan(i, 1)); return; }
      if (!a[3]) { incomplete(io); return; }
      const v = Number(a[3]);
      const fresh = !dev.vlans.has(v);
      if (each((i) => dev.setAccessVlan(i, v)) && fresh) io.out('% Access VLAN does not exist. Creating vlan ' + v);
      return;
    }
    if (kw(a[1], 'trunk', 1) && kw(a[2], 'native', 1)) {
      if (neg) { each((i) => dev.setNativeVlan(i, 1)); return; }
      each((i) => dev.setNativeVlan(i, Number(a[4])));
      return;
    }
    if (kw(a[1], 'trunk', 1) && kw(a[2], 'allowed', 1)) {
      if (neg) { each((i) => dev.setAllowedVlans(i, 'all')); return; }
      const op = a[4];
      if (kw(op, 'add', 1) || kw(op, 'remove', 1) || kw(op, 'except', 1)) {
        const list = a.slice(5).join('');
        each((i, p) => {
          const cur = p.allowed === 'all' ? new Set(Array.from({ length: 4094 }, (_, k) => k + 1)) : U.parseVlanList(p.allowed) || new Set();
          const set = U.parseVlanList(list) || new Set();
          if (kw(op, 'add', 1)) for (const v of set) cur.add(v);
          else if (kw(op, 'remove', 1)) for (const v of set) cur.delete(v);
          else { cur.clear(); for (let v = 1; v <= 4094; v++) if (!set.has(v)) cur.add(v); }
          const arr = [...cur].sort((x, y) => x - y);
          dev.setAllowedVlans(i, arr.length >= 4094 ? 'all' : compressVlans(arr) || '1');
        });
        return;
      }
      const list = a.slice(4).join('');
      if (!list) { incomplete(io); return; }
      each((i) => dev.setAllowedVlans(i, kw(list, 'all', 1) ? 'all' : list));
      return;
    }
    if (kw(a[1], 'port-security', 5)) {
      const b = a[2];
      if (!b) { each((i) => dev.setPortSecurity(i, { enabled: !neg })); return; }
      if (kw(b, 'maximum', 2)) { each((i) => dev.setPortSecurity(i, { max: neg ? 1 : Number(a[3]) })); return; }
      if (kw(b, 'violation', 1)) {
        const v = ['shutdown', 'restrict', 'protect'].find((x) => kw(a[3], x, 1));
        if (!v && !neg) { invalid(io, a[3]); return; }
        each((i) => dev.setPortSecurity(i, { violation: neg ? 'shutdown' : v }));
        return;
      }
      if (kw(b, 'mac-address', 1)) {
        if (kw(a[3], 'sticky', 1)) {
          if (a[4]) {
            const mac = cmac(a[4]);
            if (!mac) { invalid(io, a[4]); return; }
            each((i) => dev.addSecureMac(i, mac, true));
            return;
          }
          each((i) => dev.setPortSecurity(i, { sticky: !neg }));
          return;
        }
        const mac = cmac(a[3]);
        if (!mac) { invalid(io, a[3]); return; }
        each((i, p) => { if (neg) p.ps.macs = p.ps.macs.filter((m) => m.mac !== mac); else dev.addSecureMac(i, mac, false); });
        return;
      }
      invalid(io, b);
      return;
    }
    if (kw(a[1], 'nonegotiate', 2) || kw(a[1], 'voice', 2)) return;
    invalid(io, a[1]);
  }

  /** 0060.2f12.3456 или 00:60:2F:12:34:56 → 00:60:2F:12:34:56 */
  function cmac(s) {
    const h = String(s || '').replace(/[.:-]/g, '').toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(h)) return null;
    return h.match(/../g).join(':');
  }

  function compressVlans(arr) {
    const out = [];
    for (let i = 0; i < arr.length;) {
      let j = i;
      while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
      out.push(j > i ? arr[i] + '-' + arr[j] : String(arr[i]));
      i = j + 1;
    }
    return out.join(',');
  }

  function iosLine(dev, s, t, io) {
    const neg = kw(t[0], 'no', 2);
    const a = neg ? t.slice(1) : t;
    const L = s.line === 'con' ? dev.ios.con : s.line === 'vty' ? dev.ios.vty : null;
    if (!L) return; // line aux — принимаем молча
    for (const fn of EXT.line) if (fn(dev, s, a, neg, io, L, CTX)) return;
    if (kw(a[0], 'password', 2)) {
      if (neg) { withMutate(io, () => { L.password = null; }); return; }
      let v = a[1];
      if ((v === '0' || v === '7') && a[2]) v = v === '7' ? (U.type7decode(a[2]) || a[2]) : a[2];
      if (!v) { incomplete(io); return; }
      withMutate(io, () => { L.password = v; });
      return;
    }
    if (kw(a[0], 'login', 3)) {
      withMutate(io, () => { L.login = neg ? 'none' : kw(a[1], 'local', 1) ? 'local' : 'line'; });
      if (!neg && L.login === 'line' && !L.password && s.line === 'vty') io.out('% Login disabled on line, until \'password\' is set', 'hint');
      return;
    }
    if (kw(a[0], 'transport', 2) && kw(a[1], 'input', 1)) {
      if (s.line !== 'vty') { invalid(io, a[0]); return; }
      const opts = a.slice(2).map((x) => x.toLowerCase());
      let v = 'all';
      if (neg || opts.some((x) => kw(x, 'none', 1))) v = 'none';
      else if (opts.some((x) => kw(x, 'all', 1))) v = 'all';
      else if (opts.some((x) => kw(x, 'ssh', 1)) && opts.some((x) => kw(x, 'telnet', 1))) v = 'all';
      else if (opts.some((x) => kw(x, 'ssh', 1))) v = 'ssh';
      else if (opts.some((x) => kw(x, 'telnet', 1))) v = 'telnet';
      else { incomplete(io); return; }
      withMutate(io, () => { L.transport = neg ? 'all' : v; });
      return;
    }
    if (kw(a[0], 'access-class', 2)) {
      if (s.line !== 'vty') { invalid(io, a[0]); return; }
      withMutate(io, () => { L.accessClass = neg ? null : a[1] || null; });
      return;
    }
    if (kw(a[0], 'exec-timeout', 2) || kw(a[0], 'logging', 2) || kw(a[0], 'history', 2)) return;
    invalid(io, t[0]);
  }

  function iosRouter(dev, s, t, io) {
    const neg = kw(t[0], 'no', 2);
    const a = neg ? t.slice(1) : t;
    const w = a[0];
    for (const fn of EXT.routerCmd || []) if (fn(dev, s, a, neg, io, CTX)) return;
    if (s.mode === 'rip') {
      if (kw(w, 'network', 1)) {
        const n = U.parseIp(a[1] || '');
        if (n == null) { invalid(io, a[1]); return; }
        withMutate(io, () => dev.ripNetwork(n, neg));
        return;
      }
      if (kw(w, 'version', 1)) { withMutate(io, () => { dev.rip.version = neg ? 1 : Number(a[1]) === 2 ? 2 : 1; }); return; }
      if (kw(w, 'auto-summary', 2)) { withMutate(io, () => { dev.rip.autoSummary = !neg; }); return; }
      if (kw(w, 'passive-interface', 1)) {
        const r = parseIfName(dev, a.slice(1).join(''));
        const f = r && ifaceOf(dev, r);
        if (!f) { io.out('% Интерфейс не найден'); return; }
        withMutate(io, () => dev.setPassive('rip', f.name, !neg));
        return;
      }
      if (kw(w, 'default-information', 1)) { withMutate(io, () => { dev.rip.defaultOriginate = !neg; dev.net.markRouting(); }); return; }
      if (kw(w, 'redistribute', 3) || kw(w, 'timers', 2)) return;
      invalid(io, t[0]);
      return;
    }
    // OSPF
    if (kw(w, 'network', 1)) {
      const n = U.parseIp(a[1] || '');
      const wc = U.parseIp(a[2] || '');
      const ai = a.findIndex((x) => kw(x, 'area', 1));
      if (n == null || wc == null || ai < 0 || a[ai + 1] == null) { io.out('Использование: network адрес wildcard area номер (например: network 10.0.0.0 0.0.0.255 area 0)'); return; }
      withMutate(io, () => dev.ospfNetwork(n, wc, U.parseIp(a[ai + 1]) != null ? U.parseIp(a[ai + 1]) : a[ai + 1], neg));
      return;
    }
    if (kw(w, 'router-id', 2)) {
      const id = U.parseIp(a[1] || '');
      if (!neg && id == null) { invalid(io, a[1]); return; }
      withMutate(io, () => { dev.ospf.routerId = neg ? null : id; dev.net.markRouting(); });
      if (!neg) io.out('Reload or use "clear ip ospf process" command, for this to take effect', 'hint');
      return;
    }
    if (kw(w, 'passive-interface', 1)) {
      const r = parseIfName(dev, a.slice(1).join(''));
      const f = r && ifaceOf(dev, r);
      if (!f) { io.out('% Интерфейс не найден'); return; }
      withMutate(io, () => dev.setPassive('ospf', f.name, !neg));
      return;
    }
    if (kw(w, 'default-information', 1)) {
      withMutate(io, () => { dev.ospf.defaultOriginate = !neg; dev.ospf.defaultAlways = !neg && a.some((x) => kw(x, 'always', 2)); dev.net.markRouting(); });
      return;
    }
    if (kw(w, 'log-adjacency-changes', 1) || kw(w, 'auto-cost', 2) || kw(w, 'redistribute', 3)) return;
    invalid(io, t[0]);
  }

  function iosPool(dev, s, t, io) {
    const p = s.pool;
    const cur = () => dev.dhcpd.pools.find((x) => x.name === p.name);
    if (kw(t[0], 'network', 1)) {
      const net = U.parseIp(t[1] || '');
      const mask = U.parseMask(t[2] || '');
      if (net == null) { invalid(io, t[1]); return; }
      if (mask == null) { incomplete(io); return; }
      const old = cur();
      withMutate(io, () => {
        dev.dhcpd.setPool({
          name: p.name, start: U.net(net, mask) + 1, end: U.bcast(net, mask) - 1, mask,
          gateway: old ? old.gateway : p.gateway, dns: old ? old.dns : p.dns, tftp: old ? old.tftp : p.tftp || null,
        }, old ? p.name : undefined);
        p.committed = true;
      });
      return;
    }
    if (kw(t[0], 'default-router', 1) || kw(t[0], 'dns-server', 2)) {
      const isGw = kw(t[0], 'default-router', 1);
      const v = U.parseIp(t[1] || '');
      if (v == null) { invalid(io, t[1]); return; }
      const old = cur();
      if (!old) { if (isGw) p.gateway = v; else p.dns = v; return; }
      withMutate(io, () => dev.dhcpd.setPool(Object.assign({}, old, isGw ? { gateway: v } : { dns: v }), p.name));
      return;
    }
    if (kw(t[0], 'option', 1)) {
      // option 150 ip A.B.C.D — адрес TFTP-сервера (CME) для IP-телефонов
      if (t[1] === '43') {
        // option 43 hex f104.C0A8.0105 (тип f1, длина 4, адрес WLC) или option 43 ip A.B.C.D
        let v = null;
        if (kw(t[2], 'hex', 1)) { const hx = String(t[3] || '').replace(/\./g, '').toLowerCase(); const m = /^f1(0[48])([0-9a-f]{8})/.exec(hx); if (m) v = parseInt(m[2], 16) >>> 0; }
        else v = U.parseIp(t[kw(t[2], 'ip', 1) ? 3 : 2] || '');
        if (v == null) { io.out('% Option 43: hex f104.<адрес WLC в hex> (например f104.c0a8.0105 для 192.168.1.5) или ip A.B.C.D'); return; }
        const old43 = cur();
        if (!old43) { p.wlc = v; return; }
        withMutate(io, () => dev.dhcpd.setPool(Object.assign({}, old43, { wlc: v }), p.name));
        return;
      }
      if (t[1] !== '150') { if (/^\d+$/.test(t[1] || '')) return; invalid(io, t[1]); return; }
      const v = U.parseIp(t[kw(t[2], 'ip', 1) ? 3 : 2] || '');
      if (v == null) { incomplete(io); return; }
      const old = cur();
      if (!old) { p.tftp = v; return; }
      withMutate(io, () => dev.dhcpd.setPool(Object.assign({}, old, { tftp: v }), p.name));
      return;
    }
    if (kw(t[0], 'lease', 2) || kw(t[0], 'domain-name', 2)) return;
    invalid(io, t[0]);
  }

  function iosAcl(dev, s, t, io) {
    const acl = s.acl;
    let a = t;
    if (kw(a[0], 'no', 2)) {
      const seq = Number(a[1]);
      if (Number.isInteger(seq)) { withMutate(io, () => acl.removeSeq(seq)); return; }
      withMutate(io, () => { const txt = a.slice(1).join(' '); acl.entries = acl.entries.filter((e) => acl.entryText(e) !== txt); });
      return;
    }
    let seq = null;
    if (/^\d+$/.test(a[0])) { seq = Number(a[0]); a = a.slice(1); }
    withMutate(io, () => acl.add(a, seq));
  }

  function execConfigLine(dev, s, line, io) {
    const t = tokenize(line);
    if (!t.length) return null;
    if (kw(t[0], 'end', 2)) { s.mode = 'exec'; s.ifs = null; s.pool = null; s.acl = null; s.ctx = null; if (EXT.onConfigured) EXT.onConfigured(dev, s); return null; }
    if (kw(t[0], 'exit', 3)) {
      s.ctx = null;
      if (s.mode === 'config') { s.mode = 'exec'; if (EXT.onConfigured) EXT.onConfigured(dev, s); }
      else if (EXT.modes[s.mode] && EXT.modes[s.mode].parent) s.mode = EXT.modes[s.mode].parent; // вложенный подрежим: на уровень выше
      else {
        if (s.mode === 'pool' && s.pool && !s.pool.committed) io.out('% Пул «' + s.pool.name + '» не создан: не задана команда network.');
        s.mode = 'config';
      }
      s.ifs = null;
      s.pool = null;
      s.acl = null;
      return null;
    }
    if (kw(t[0], 'do', 2)) {
      const saved = s.mode;
      s.mode = 'exec';
      const job = iosExec(dev, s, t.slice(1), io, line);
      if (s.mode === 'exec') s.mode = saved;
      return job;
    }
    // Команды глобального режима работают и из подрежимов (как в IOS).
    const g = t[0];
    const globalCmd = kw(g, 'interface', 3) || kw(g, 'hostname', 3) || kw(g, 'router', 3) || kw(g, 'line', 2) || kw(g, 'access-list', 3) ||
      kw(g, 'username', 3) || kw(g, 'enable', 2) || kw(g, 'banner', 3) || kw(g, 'service', 3) || (kw(g, 'crypto', 2) && !(s.mode === 'if' && kw(t[1], 'map', 1))) ||
      (dev.type === 'switch' && kw(g, 'vlan', 1) && s.mode !== 'if') || EXT.global.some((fn) => fn(t, s)) ||
      (kw(g, 'ip', 2) && (kw(t[1], 'route', 1) || kw(t[1], 'routing', 3) || kw(t[1], 'access-list', 3) || kw(t[1], 'domain-name', 8) || (kw(t[1], 'nat', 1) && kw(t[2], 'inside', 1) && kw(t[3], 'source', 1)) || kw(t[1], 'nat', 1) && kw(t[2], 'pool', 1) || (kw(t[1], 'dhcp', 1) && s.mode !== 'if')));
    if (s.mode !== 'config' && globalCmd && !(s.mode === 'acl' && (kw(g, 'permit', 1) || kw(g, 'deny', 1)))) {
      if (s.mode === 'pool' && s.pool && !s.pool.committed) io.out('% Пул «' + s.pool.name + '» не создан: не задана команда network.');
      s.mode = 'config';
      s.ifs = null;
      s.pool = null;
      s.acl = null;
      s.ctx = null;
    }
    switch (s.mode) {
      case 'config': iosConfig(dev, s, t, io); break;
      case 'if': iosIf(dev, s, t, io); break;
      case 'line': iosLine(dev, s, t, io); break;
      case 'rip': case 'ospf': iosRouter(dev, s, t, io); break;
      case 'pool': iosPool(dev, s, t, io); break;
      case 'vlan':
        if (kw(t[0], 'name', 1)) { if (!t[1]) incomplete(io); else withMutate(io, () => dev.addVlan(s.vlan, t[1])); }
        else invalid(io, t[0]);
        break;
      case 'acl': iosAcl(dev, s, t, io); break;
      default:
        if (EXT.modes[s.mode]) EXT.modes[s.mode].run(dev, s, t, io, CTX);
        break;
    }
    return null;
  }

  /* ================= «?» и Tab ================= */

  const TREE = {
    user: ['enable', 'exit', 'logout', 'ping WORD', 'traceroute WORD', 'telnet WORD', 'ssh -l WORD WORD', 'show version', 'show clock', 'show ip interface brief', 'show ip route', 'show interfaces', 'show cdp neighbors', 'show users', 'terminal length 0'],
    exec: ['configure terminal', 'copy running-config startup-config', 'copy startup-config running-config', 'copy running-config tftp:', 'copy startup-config tftp:', 'copy tftp: running-config',
      'write memory', 'erase startup-config', 'reload', 'clear arp-cache', 'clear mac address-table', 'clear ip nat translation *', 'clear port-security all', 'clock set WORD WORD WORD WORD', 'disable',
      'show running-config', 'show startup-config', 'show ip route', 'show ip route connected', 'show ip route static', 'show ip route ospf', 'show ip route rip', 'show ip interface brief', 'show ip arp', 'show ip protocols', 'show ip ospf neighbor', 'show ip ssh',
      'show ip dhcp binding', 'show ip dhcp pool', 'show ip nat translations', 'show ip nat statistics', 'show arp', 'show access-lists', 'show cdp neighbors', 'show cdp neighbors detail',
      'show controllers serial WORD', 'show mac address-table', 'show vlan brief', 'show interfaces', 'show interfaces trunk', 'show interfaces status', 'show spanning-tree', 'show port-security', 'show port-security interface WORD', 'show port-security address', 'show history', 'show flash:'],
    config: ['hostname WORD', 'interface WORD', 'interface range WORD', 'interface vlan WORD', 'interface loopback WORD', 'ip route A.B.C.D A.B.C.D A.B.C.D', 'ip routing', 'ip default-gateway A.B.C.D', 'ip domain-name WORD', 'ip name-server A.B.C.D',
      'ip ssh version 2', 'ip dhcp pool WORD', 'ip dhcp excluded-address A.B.C.D A.B.C.D', 'ip nat inside source static A.B.C.D A.B.C.D', 'ip nat inside source list WORD interface WORD overload', 'ip nat inside source list WORD pool WORD overload',
      'ip nat pool WORD A.B.C.D A.B.C.D netmask A.B.C.D', 'ip access-list standard WORD', 'ip access-list extended WORD', 'access-list WORD permit LINE', 'access-list WORD deny LINE', 'router rip', 'router ospf WORD',
      'line console 0', 'line vty 0 WORD', 'enable secret WORD', 'enable password WORD', 'username WORD secret WORD', 'username WORD password WORD', 'service password-encryption', 'banner motd LINE', 'crypto key generate rsa',
      'cdp run', 'vlan WORD', 'spanning-tree vlan 1 priority WORD', 'no LINE', 'do LINE', 'exit', 'end'],
    if: ['ip address A.B.C.D A.B.C.D', 'ip address dhcp', 'ip helper-address A.B.C.D', 'ip access-group WORD in', 'ip access-group WORD out', 'ip nat inside', 'ip nat outside', 'shutdown', 'no shutdown', 'description LINE',
      'encapsulation dot1Q WORD', 'encapsulation ppp', 'encapsulation hdlc', 'clock rate WORD', 'bandwidth WORD', 'speed WORD', 'duplex full', 'switchport mode access', 'switchport mode trunk', 'switchport access vlan WORD',
      'switchport trunk native vlan WORD', 'switchport trunk allowed vlan WORD', 'switchport port-security', 'switchport port-security maximum WORD', 'switchport port-security violation shutdown',
      'switchport port-security violation restrict', 'switchport port-security violation protect', 'switchport port-security mac-address sticky', 'spanning-tree portfast', 'no switchport', 'exit', 'end', 'do LINE'],
    line: ['password WORD', 'login', 'login local', 'transport input ssh', 'transport input telnet', 'transport input all', 'transport input none', 'access-class WORD in', 'exec-timeout WORD', 'logging synchronous', 'exit', 'end'],
    rip: ['network A.B.C.D', 'version 2', 'no auto-summary', 'passive-interface WORD', 'default-information originate', 'exit', 'end'],
    ospf: ['network A.B.C.D A.B.C.D area WORD', 'router-id A.B.C.D', 'passive-interface WORD', 'default-information originate', 'default-information originate always', 'exit', 'end'],
    pool: ['network A.B.C.D A.B.C.D', 'default-router A.B.C.D', 'dns-server A.B.C.D', 'option 150 ip A.B.C.D', 'exit', 'end'],
    vlan: ['name WORD', 'exit', 'end'],
    acl: ['permit LINE', 'deny LINE', 'remark LINE', 'exit', 'end'],
  };

  function syntaxFor(s) {
    if (s.mode === 'exec') return TREE.user.concat(TREE.exec, EXT.tree.user || [], EXT.tree.exec || []);
    if (s.mode === 'user') return TREE.user.concat(EXT.tree.user || []);
    if (EXT.modes[s.mode]) return (EXT.modes[s.mode].tree || []).concat(['exit', 'end']);
    return (TREE[s.mode] || TREE.user).concat(EXT.tree[s.mode] || []);
  }

  /** Варианты для позиции после набранных слов. */
  function candidates(s, words, partial) {
    const out = new Map();
    for (const syn of syntaxFor(s)) {
      const toks = syn.split(' ');
      let ok = true;
      for (let i = 0; i < words.length; i++) {
        const tk = toks[i];
        if (!tk) { ok = false; break; }
        if (tk === 'LINE') break;
        if (tk === 'WORD' || tk === 'A.B.C.D') continue;
        if (!kw(words[i], tk.toLowerCase(), 1)) { ok = false; break; }
      }
      if (!ok) continue;
      const next = toks[words.length];
      if (!next) { out.set('<cr>', ''); continue; }
      if (next === 'LINE') { out.set('LINE', 'Текст'); continue; }
      if (next === 'WORD') { out.set('WORD', 'Имя, номер или значение'); continue; }
      if (next === 'A.B.C.D') { out.set('A.B.C.D', 'IP-адрес или маска'); continue; }
      if (!partial || next.toLowerCase().startsWith(partial.toLowerCase())) out.set(next, '');
    }
    return out;
  }

  function help(dev, s, line, io) {
    const text = line.replace(/\?$/, '');
    const words = tokenize(text);
    const partial = /\s$/.test(text) || !text ? '' : words.pop();
    const c = candidates(s, words, partial);
    if (!c.size) { io.out('% Unrecognized command'); return; }
    for (const [k, d] of c) io.out('  ' + pad(k, 22) + d);
  }

  /** Tab: дописать единственный вариант. */
  function complete(dev, s, line) {
    if (/\s$/.test(line) || !line.trim()) return line;
    const words = tokenize(line);
    const partial = words.pop();
    const c = [...candidates(s, words, partial).keys()].filter((k) => !/^(WORD|LINE|A\.B\.C\.D|<cr>)$/.test(k));
    if (c.length !== 1) return line;
    return line.slice(0, line.length - partial.length) + c[0] + ' ';
  }

  /* ================= точка входа ================= */

  function exec(dev, s, line, io) {
    if (s.stage === 'press-return') { startConsole(dev, s, io); return null; }
    if (s.stage === 'login') return null;
    if (/\?$/.test(line.trim()) && !s.pending) { help(dev, s, line.trim(), io); return null; }
    const t = tokenize(line);
    if (!t.length) return null;
    if (line.trim()) { s.history.push(line.trim()); if (s.history.length > 50) s.history.shift(); }
    if (s.mode === 'user' || s.mode === 'exec') return iosExec(dev, s, t, io, line);
    return execConfigLine(dev, s, line, io);
  }

  /* ================= серверы Telnet / SSH на устройстве ================= */

  NS.bindIosServices = function (dev) {
    if (!dev.ios || !dev.tcp || dev.type === 'wrouter' || dev.type === 'asa') return;
    for (const [port, proto] of [[NS.packets.PORT_TELNET, 'telnet'], [NS.packets.PORT_SSH, 'ssh']]) {
      dev.tcp.listen(port, (conn) => serveVty(dev, conn, proto));
    }
  };

  function serveVty(dev, conn, proto) {
    const vty = dev.ios.vty;
    const refuse = (text) => {
      conn.send({ term: 'out', lines: [text], close: true });
      conn.close();
    };
    if (vty.transport === 'none' || (vty.transport !== 'all' && vty.transport !== proto)) {
      refuse('% Connection refused by remote host (на линиях vty разрешено: transport input ' + vty.transport + ')');
      return;
    }
    if (proto === 'ssh' && !dev.ios.rsa) { refuse('% Connection refused by remote host (SSH выключен: не сгенерированы ключи RSA)'); return; }
    if (vty.accessClass) {
      const acl = dev.acls.get(vty.accessClass);
      if (acl && !acl.check({ src: conn.rip, dst: conn.lip, proto: 'TCP', payload: { sport: conn.rport, dport: conn.lport, flags: 'SYN' } }).permit) {
        refuse('% Connection refused by remote host (запрещено access-class ' + vty.accessClass + ')');
        return;
      }
    }
    const s = createSession(dev, { via: 'vty', remoteIp: conn.rip });
    s.stage = null;
    let buf = [];
    let flushTimer = null;
    const flush = (withPrompt) => {
      if (flushTimer) { flushTimer.cancel(); flushTimer = null; }
      if (s.closed) {
        conn.send({ term: 'out', lines: buf, close: true });
        buf = [];
        conn.close();
        return;
      }
      conn.send({ term: 'out', lines: buf, prompt: withPrompt ? prompt(dev, s) : null, mask: withPrompt ? !!(s.pending && s.pending.mask) : false });
      buf = [];
    };
    let inline = false;
    let busy = false;
    const io = {
      out: (l) => { if (inline) { inline = false; if (l === '') return; } buf.push(String(l)); if (busy && !flushTimer) flushTimer = dev.timer(5, () => flush(false)); },
      write: (x) => { if (inline && buf.length) buf[buf.length - 1] += x; else { buf.push(String(x)); inline = true; } if (busy && !flushTimer) flushTimer = dev.timer(5, () => flush(false)); },
      clear: () => {},
      done: () => { if (busy) { busy = false; flush(true); } },
      mutate: (fn) => { const r = fn(); dev.net.emit('remote-change', { dev }); return r; },
    };
    conn.h.onData = (d) => {
      if (!d) return;
      if (d.term === 'hello') {
        if (dev.ios.banner) buf.push('', dev.ios.banner, '');
        if (proto === 'ssh') {
          const prob = dev.sshProblem();
          if (prob) { buf.push('% SSH: ' + prob); s.closed = true; flush(false); return; }
          if (!d.user) { buf.push('% Укажите пользователя: ssh -l имя адрес'); s.closed = true; flush(false); return; }
          login(dev, s, io, { login: 'local' }, d.user, () => { s.mode = 'user'; }, () => { s.closed = true; });
        } else {
          buf.push('User Access Verification', '');
          login(dev, s, io, vty, null, () => { s.mode = 'user'; }, () => { s.closed = true; });
          if (vty.login === 'line' && !vty.password && !s.pending) s.closed = true;
        }
        flush(true);
        return;
      }
      if (d.term !== 'line') return;
      busy = true;
      let job = null;
      if (s.pending) {
        const p = s.pending;
        s.pending = null;
        job = p.handle(String(d.text)) || null;
      } else {
        job = exec(dev, s, String(d.text), io);
      }
      if (!job || job.done) { busy = false; flush(true); }
    };
  }

  /** Помощники для модулей-расширений. */
  const CTX = {
    kw, tokenize, pad, padL, shortIf, ip, invalid, incomplete, withMutate, parseIfName, ifaceOf,
    askPassword, login: (dev, s, io, lineCfg, user, onOk, onDeny) => login(dev, s, io, lineCfg, user, onOk, onDeny),
    iosPing: (dev, args, io) => iosPing(dev, args, io), iosTraceroute: (dev, args, io) => iosTraceroute(dev, args, io),
  };

  NS.cliIos = { createSession, prompt, exec, complete, help, runningConfig, parseIfName, replayConfig, startRemote, remoteLine, isInfo, ext: EXT, ctx: CTX, portLinesFor: switchPortLines, showProtocols };
  NS.ios = { runningConfig };
})(globalThis.NetLab = globalThis.NetLab || {});
