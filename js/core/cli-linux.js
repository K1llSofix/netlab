/* NetLab — Linux на компьютерах, ноутбуках и серверах (ОС выбирается в настройках узла, d.os = 'linux').
 * Оболочка bash: ip addr|link|route|neigh, ifconfig, route, arp, dhclient, ping, traceroute, nslookup / dig / host,
 * curl, wget, nc -z, ss / netstat, ssh / telnet, iptables (INPUT / OUTPUT, политики, state ESTABLISHED, REJECT),
 * tcpdump с фильтрами, systemctl / service для служб сервера, cat / echo (/etc/resolv.conf, файлы),
 * конвейеры | grep | head | tail | wc -l | sort. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const ip = (x) => U.ipStr(x);
  const HOSTS = ['pc', 'laptop', 'server'];
  const canLinux = (d) => !!d && HOSTS.includes(d.type) && typeof d.setStatic === 'function' && !d.ios;
  const isLinux = (d) => canLinux(d) && d.os === 'linux';
  const hostName = (d) => String(d.name || 'host').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
  const ifName = (d) => { const f = d.iface; const p = f && f.port >= 0 ? d.ports[f.port] : null; return p && p.radio ? 'wlan0' : 'eth0'; };
  const macOf = (d) => { const f = d.iface; const p = f && f.port >= 0 ? d.ports[f.port] : null; return p ? String(p.mac).toLowerCase() : '00:00:00:00:00:00'; };
  const pad = (s, n) => { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); };
  const padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
  const pfx = (m) => U.prefixFromMask(m);
  const PORT_NAMES = { 20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 67: 'bootps', 68: 'bootpc', 69: 'tftp', 80: 'http', 110: 'pop3', 161: 'snmp', 443: 'https', 514: 'syslog' };

  function tokenize(line) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
    return out;
  }
  /** Разбить по «|» вне кавычек. */
  function splitPipes(line) {
    const parts = [];
    let cur = '';
    let q = null;
    for (const c of line) {
      if (q) { if (c === q) q = null; cur += c; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '|') { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts.map((x) => x.trim());
  }

  function parseCidr(s) {
    if (!s) return null;
    if (s === '0/0' || s === 'anywhere') return { net: 0, mask: 0 };
    const [a, b] = String(s).split('/');
    const addr = U.parseIp(a);
    if (addr == null) return null;
    let mask = 0xffffffff;
    if (b != null) {
      if (/^\d+$/.test(b)) { const n = Number(b); if (n > 32) return null; mask = U.maskFromPrefix(n); } else { mask = U.parseMask(b); if (mask == null) return null; }
    }
    return { net: U.net(addr, mask), mask, addr };
  }
  const cidrStr = (c) => (c ? ip(c.net) + '/' + pfx(c.mask) : '0.0.0.0/0');

  /** Задание (job) для асинхронной команды: терминал ждёт io.done(), Ctrl+C вызывает cancel. */
  function mkJob(d, onCancel) {
    const j = {
      done: false,
      cancel(reason) { if (!j.done && onCancel) onCancel(reason); },
      finish() { if (j.done) return; j.done = true; if (d.jobs) d.jobs.delete(j); },
    };
    if (d.jobs) d.jobs.add(j);
    return j;
  }
  /** Запустить асинхронную операцию: start(finish, job). Если закончилась сразу — вернуть null. */
  function runAsync(d, io, start, onCancel) {
    let sync = true;
    let fin = false;
    const job = mkJob(d, (r) => { if (onCancel) onCancel(r); finish(); });
    function finish() { if (fin) return; fin = true; job.finish(); if (!sync) io.done(); }
    start(finish, job);
    sync = false;
    return fin ? null : job;
  }

  /* ================= iptables ================= */

  const CHAINS = ['INPUT', 'FORWARD', 'OUTPUT'];
  const TARGETS = ['ACCEPT', 'DROP', 'REJECT', 'LOG', 'RETURN'];
  const ICMP_TYPES = { 'echo-request': 'echo-request', 8: 'echo-request', 'echo-reply': 'echo-reply', 0: 'echo-reply', 'destination-unreachable': 'unreachable', 3: 'unreachable', 'time-exceeded': 'time-exceeded', 11: 'time-exceeded' };
  const ICMP_NUM = { 'echo-request': 8, 'echo-reply': 0, unreachable: 3, 'time-exceeded': 11 };

  function iptOf(d) {
    if (!d.ipt) d.ipt = { INPUT: { policy: 'ACCEPT', rules: [] }, FORWARD: { policy: 'ACCEPT', rules: [] }, OUTPUT: { policy: 'ACCEPT', rules: [] } };
    return d.ipt;
  }

  function flowKey(pkt, rev) {
    const l4 = pkt.payload || {};
    const [a, b] = rev ? [pkt.dst, pkt.src] : [pkt.src, pkt.dst];
    if (pkt.proto === 'ICMP') return 'I|' + a + '|' + b + '|' + (l4.id != null ? l4.id : '');
    if (pkt.proto === 'TCP' || pkt.proto === 'UDP') return pkt.proto + '|' + a + ':' + (rev ? l4.dport : l4.sport) + '|' + b + ':' + (rev ? l4.sport : l4.dport);
    return pkt.proto + '|' + a + '|' + b;
  }
  function ctState(d, pkt) {
    const l4 = pkt.payload || {};
    if (pkt.proto === 'ICMP' && l4.type && !/^echo/.test(l4.type)) return 'RELATED';
    const ct = d.iptCt;
    if (ct && (ct.has(flowKey(pkt, true)) || ct.has(flowKey(pkt)))) return 'ESTABLISHED';
    return 'NEW';
  }
  function ctRecord(d, pkt) {
    if (!d.iptCt) d.iptCt = new Map();
    const ct = d.iptCt;
    ct.set(flowKey(pkt), d.net.time);
    if (ct.size > 4000) ct.delete(ct.keys().next().value);
  }

  const portOk = (spec, v) => spec == null || (v != null && (Array.isArray(spec) ? v >= spec[0] && v <= spec[1] : v === spec));
  const ifOk = (spec, name) => !spec || spec === name || (spec.endsWith('+') && name.startsWith(spec.slice(0, -1)));

  function matchRule(r, pkt, chain, ifn, state) {
    const proto = String(pkt.proto || '').toLowerCase();
    if (r.p !== 'all' && r.p !== proto) return false;
    if (r.s && U.net(pkt.src || 0, r.s.mask) !== r.s.net) return false;
    if (r.d && U.net(pkt.dst || 0, r.d.mask) !== r.d.net) return false;
    if (chain === 'INPUT' && !ifOk(r.i, ifn)) return false;
    if (chain === 'OUTPUT' && !ifOk(r.o, ifn)) return false;
    const l4 = pkt.payload || {};
    if ((r.dport != null || r.sport != null || r.dports) && proto !== 'tcp' && proto !== 'udp') return false;
    if (!portOk(r.dport, l4.dport) || !portOk(r.sport, l4.sport)) return false;
    if (r.dports && !r.dports.includes(l4.dport)) return false;
    if (r.icmp && (proto !== 'icmp' || ICMP_TYPES[r.icmp] !== l4.type)) return false;
    if (r.state && !r.state.includes(state)) return false;
    return true;
  }

  function verdict(d, chain, pkt, ifn) {
    const c = iptOf(d)[chain];
    const state = ctState(d, pkt);
    for (let k = 0; k < c.rules.length; k++) {
      const r = c.rules[k];
      if (!matchRule(r, pkt, chain, ifn, state)) continue;
      r.pk = (r.pk || 0) + 1;
      r.by = (r.by || 0) + 84;
      if (r.j === 'LOG') { d.note('iptables LOG (' + chain + '): ' + pktText(pkt), null, 'info'); continue; }
      if (r.j === 'RETURN') break;
      return { j: r.j, n: k + 1, r };
    }
    c.pk = (c.pk || 0) + 1;
    c.by = (c.by || 0) + 84;
    return { j: c.policy, n: 0, r: null };
  }

  function pktText(pkt) {
    const l4 = pkt.payload || {};
    const pr = String(pkt.proto || '').toLowerCase();
    return pr + ' ' + ip(pkt.src || 0) + (l4.sport != null ? ':' + l4.sport : '') + ' → ' + ip(pkt.dst || 0) + (l4.dport != null ? ':' + l4.dport : '') + (pr === 'icmp' && l4.type ? ' (' + l4.type + ')' : '');
  }

  // INPUT: входящие пакеты узла
  IpNode.hooks.ipIn.push(function (f, pkt, frame) {
    if (!this.ipt || !isLinux(this)) return false;
    const v = verdict(this, 'INPUT', pkt, ifName(this));
    if (v.j === 'ACCEPT') { ctRecord(this, pkt); return false; }
    this.drop(frame, 'iptables: входящий пакет ' + pktText(pkt) + ' отброшен в цепочке INPUT ' + (v.n ? 'правилом ' + v.n + ' (-j ' + v.j + ')' : 'по политике ' + v.j));
    if (v.j === 'REJECT') this.sendIcmpError(pkt, 'unreachable', /prohib/.test((v.r && v.r.rw) || '') ? 13 : 3, f);
    return true;
  });
  // OUTPUT: пакеты, которые узел отправляет сам
  IpNode.hooks.send.push(function (pkt, opts) {
    if (!this.ipt || !isLinux(this)) return false;
    const p2 = pkt.src == null ? Object.assign({}, pkt, { src: this.iface && this.iface.ip != null ? this.iface.ip : 0 }) : pkt;
    const v = verdict(this, 'OUTPUT', p2, ifName(this));
    if (v.j === 'ACCEPT') { ctRecord(this, p2); return false; }
    this.note('iptables: исходящий пакет ' + pktText(p2) + ' отброшен в цепочке OUTPUT ' + (v.n ? 'правилом ' + v.n + ' (-j ' + v.j + ')' : 'по политике ' + v.j), null, 'drop');
    if (opts && opts.onError) opts.onError('iptables', 'Operation not permitted');
    return true;
  });

  function ruleSpec(r) {
    const a = [];
    if (r.s) a.push('-s', cidrStr(r.s));
    if (r.d) a.push('-d', cidrStr(r.d));
    if (r.i) a.push('-i', r.i);
    if (r.o) a.push('-o', r.o);
    if (r.p !== 'all') a.push('-p', r.p);
    if (r.state) a.push('-m', 'state', '--state', r.state.join(','));
    if (r.p === 'tcp' || r.p === 'udp') {
      if (r.dports) a.push('-m', 'multiport', '--dports', r.dports.join(','));
      else if (r.dport != null || r.sport != null) a.push('-m', r.p);
      if (r.sport != null) a.push('--sport', Array.isArray(r.sport) ? r.sport.join(':') : r.sport);
      if (r.dport != null) a.push('--dport', Array.isArray(r.dport) ? r.dport.join(':') : r.dport);
    }
    if (r.icmp) a.push('-m', 'icmp', '--icmp-type', ICMP_NUM[ICMP_TYPES[r.icmp]]);
    a.push('-j', r.j);
    if (r.rw) a.push('--reject-with', r.rw);
    return a.join(' ');
  }

  function parsePort(v) {
    if (v == null) return undefined;
    const m = /^(\d+)(?::(\d+))?$/.exec(String(v));
    if (m) { const a = Number(m[1]); if (a > 65535) return undefined; return m[2] != null ? [a, Number(m[2])] : a; }
    for (const [n, name] of Object.entries(PORT_NAMES)) if (name === v) return Number(n);
    return undefined;
  }

  function iptables(d, args, io, mutate) {
    const a = [];
    for (const x of args) {
      if (/^-[nvLSFZx]{2,}$/.test(x)) for (const c of x.slice(1)) a.push('-' + c);
      else a.push(x);
    }
    const bad = (x) => { io.out("Bad argument `" + x + "'"); io.out("Try `iptables -h' or 'iptables --help' for more information."); return null; };
    let cmd = null;
    let chain = null;
    let num = null;
    let policy = null;
    const o = { n: false, v: false, line: false };
    const r = { p: 'all' };
    const LONG = { '--append': '-A', '--insert': '-I', '--delete': '-D', '--replace': '-R', '--list': '-L', '--list-rules': '-S', '--flush': '-F', '--policy': '-P', '--zero': '-Z', '--new-chain': '-N', '--delete-chain': '-X' };
    for (let i = 0; i < a.length; i++) {
      let x = a[i];
      if (LONG[x]) x = LONG[x];
      switch (x) {
        case '-t': case '--table':
          if (a[i + 1] !== 'filter') { io.out('iptables: таблица «' + (a[i + 1] || '') + '» в NetLab не поддерживается — есть только filter (INPUT, OUTPUT, FORWARD).'); return null; }
          i++; break;
        case '-A': case '-I': case '-D': case '-R': case '-L': case '-S': case '-F': case '-P': case '-Z': case '-N': case '-X':
          cmd = x[1];
          if (a[i + 1] && !a[i + 1].startsWith('-')) chain = a[++i];
          if ('IDR'.includes(cmd) && /^\d+$/.test(a[i + 1] || '')) num = Number(a[++i]);
          if (cmd === 'P') policy = (a[++i] || '').toUpperCase();
          break;
        case '-p': case '--protocol': r.p = String(a[++i] || '').toLowerCase(); if (!['tcp', 'udp', 'icmp', 'all'].includes(r.p)) { io.out("iptables v1.8.9 (nf_tables): unknown protocol \"" + r.p + '" specified'); return null; } break;
        case '-s': case '--source': case '--src': r.s = parseCidr(a[++i]); if (!r.s) { io.out('iptables v1.8.9 (nf_tables): host/network `' + a[i] + "' not found"); return null; } break;
        case '-d': case '--destination': case '--dst': r.d = parseCidr(a[++i]); if (!r.d) { io.out('iptables v1.8.9 (nf_tables): host/network `' + a[i] + "' not found"); return null; } break;
        case '--dport': case '--destination-port': r.dport = parsePort(a[++i]); if (r.dport === undefined) return bad(a[i]); break;
        case '--sport': case '--source-port': r.sport = parsePort(a[++i]); if (r.sport === undefined) return bad(a[i]); break;
        case '--dports': r.dports = String(a[++i] || '').split(',').map(parsePort).filter((v) => typeof v === 'number'); break;
        case '-i': case '--in-interface': r.i = a[++i]; break;
        case '-o': case '--out-interface': r.o = a[++i]; break;
        case '-m': case '--match': i++; break;
        case '--state': case '--ctstate': r.state = String(a[++i] || '').toUpperCase().split(',').filter(Boolean); break;
        case '--icmp-type': r.icmp = a[++i]; if (!ICMP_TYPES[r.icmp]) { io.out('iptables v1.8.9 (nf_tables): Invalid ICMP type `' + r.icmp + "'"); return null; } break;
        case '-j': case '--jump': r.j = String(a[++i] || '').toUpperCase(); break;
        case '--reject-with': r.rw = a[++i]; break;
        case '-n': case '--numeric': o.n = true; break;
        case '-v': case '--verbose': o.v = true; break;
        case '-x': case '--exact': break;
        case '--line-numbers': o.line = true; break;
        case '-h': case '--help':
          io.out('iptables v1.8.9 (NetLab): iptables -[ACD] цепочка правило | -I цепочка [номер] правило | -D цепочка номер | -L [цепочка] [-n] [-v] [--line-numbers] | -S | -F [цепочка] | -P цепочка ACCEPT|DROP');
          io.out('Правило: -p tcp|udp|icmp, -s/-d адрес[/маска], --dport/--sport порт[:порт], -i/-o интерфейс, -m state --state NEW,ESTABLISHED,RELATED, --icmp-type echo-request, -j ACCEPT|DROP|REJECT|LOG');
          return null;
        default: return bad(a[i]);
      }
    }
    if (!cmd) { io.out('iptables v1.8.9 (nf_tables): no command specified'); io.out("Try `iptables -h' or 'iptables --help' for more information."); return null; }
    if (cmd === 'N' || cmd === 'X') { io.out('iptables: собственные цепочки в NetLab не поддерживаются — используйте INPUT, OUTPUT, FORWARD.'); return null; }
    if (chain && !CHAINS.includes(chain)) { io.out('iptables: No chain/target/match by that name.'); return null; }
    const T = iptOf(d);
    const chains = chain ? [chain] : CHAINS;
    if (cmd === 'L') { listRules(d, chains, o, io); return null; }
    if (cmd === 'S') {
      for (const c of chains) io.out('-P ' + c + ' ' + T[c].policy);
      for (const c of chains) for (const x of T[c].rules) io.out('-A ' + c + ' ' + ruleSpec(x));
      return null;
    }
    if (cmd === 'Z') { for (const c of chains) { T[c].pk = 0; T[c].by = 0; for (const x of T[c].rules) { x.pk = 0; x.by = 0; } } return null; }
    if (cmd === 'F') { mutate(() => { for (const c of chains) T[c].rules = []; }); return null; }
    if (cmd === 'P') {
      if (!chain) return bad('-P');
      if (policy !== 'ACCEPT' && policy !== 'DROP') { io.out('iptables: Bad policy name. Run `dmesg\' for more information.'); return null; }
      mutate(() => { T[chain].policy = policy; });
      return null;
    }
    if (!chain) { io.out('iptables v1.8.9 (nf_tables): no chain specified'); return null; }
    const list = T[chain].rules;
    if (cmd === 'D' && num != null) {
      if (num < 1 || num > list.length) { io.out('iptables: Index of deletion too big.'); return null; }
      mutate(() => list.splice(num - 1, 1));
      return null;
    }
    if (!r.j) { io.out('iptables v1.8.9 (nf_tables): no target specified (-j)'); return null; }
    if (!TARGETS.includes(r.j)) { io.out("iptables v1.8.9 (nf_tables): Couldn't load target `" + r.j + "':No such file or directory"); return null; }
    if ((r.dport != null || r.sport != null) && r.p !== 'tcp' && r.p !== 'udp') { io.out("iptables v1.8.9 (nf_tables): unknown option \"--dport\" (укажите -p tcp или -p udp)"); return null; }
    if (cmd === 'D') {
      const k = list.findIndex((x) => ruleSpec(x) === ruleSpec(r));
      if (k < 0) { io.out('iptables: Bad rule (does a matching rule exist in that chain?).'); return null; }
      mutate(() => list.splice(k, 1));
      return null;
    }
    if (cmd === 'R') {
      if (num == null || num < 1 || num > list.length) { io.out('iptables: Index of replacement too big.'); return null; }
      mutate(() => { list[num - 1] = r; });
      return null;
    }
    if (cmd === 'I') { const k = num == null ? 0 : Math.min(list.length, num - 1); mutate(() => list.splice(k, 0, r)); return null; }
    mutate(() => list.push(r));
    return null;
  }

  function listRules(d, chains, o, io) {
    const T = iptOf(d);
    const addr = (c) => (!c || c.mask === 0 ? (o.n ? '0.0.0.0/0' : 'anywhere') : pfx(c.mask) === 32 ? ip(c.net) : cidrStr(c));
    const port = (v) => (Array.isArray(v) ? v.join(':') : o.n ? v : PORT_NAMES[v] || v);
    chains.forEach((c, ci) => {
      if (ci) io.out('');
      io.out('Chain ' + c + ' (policy ' + T[c].policy + (o.v ? ' ' + (T[c].pk || 0) + ' packets, ' + (T[c].by || 0) + ' bytes' : '') + ')');
      io.out((o.line ? pad('num', 5) : '') + (o.v ? padL('pkts', 5) + ' ' + padL('bytes', 5) + ' ' : '') + pad('target', 11) + pad('prot', 5) + pad('opt', 4) + (o.v ? pad('in', 7) + pad('out', 7) : '') + pad('source', 21) + 'destination');
      T[c].rules.forEach((r, k) => {
        const extra = [];
        if (r.state) extra.push('state ' + r.state.join(','));
        if (r.dports) extra.push('multiport dports ' + r.dports.map(port).join(','));
        if (r.sport != null) extra.push(r.p + ' spt:' + port(r.sport));
        if (r.dport != null) extra.push(r.p + ' dpt:' + port(r.dport));
        if (r.icmp) extra.push('icmptype ' + ICMP_NUM[ICMP_TYPES[r.icmp]]);
        if (r.j === 'REJECT') extra.push('reject-with ' + (r.rw || 'icmp-port-unreachable'));
        io.out((o.line ? pad(k + 1, 5) : '') + (o.v ? padL(r.pk || 0, 5) + ' ' + padL(r.by || 0, 5) + ' ' : '') + pad(r.j, 11) + pad(r.p, 5) + pad('--', 4) + (o.v ? pad(r.i || '*', 7) + pad(r.o || '*', 7) : '') + pad(addr(r.s), 21) + pad(addr(r.d), 21) + extra.join(' '));
      });
    });
  }

  /* ================= tcpdump ================= */

  const baseRecv = IpNode.prototype.receive;
  IpNode.prototype.receive = function (i, frame) {
    if (this.taps && this.taps.size) for (const t of [...this.taps]) t(frame, 'in', i);
    return baseRecv.call(this, i, frame);
  };
  const baseTx = NS.Network.prototype.transmit;
  NS.Network.prototype.transmit = function (dev, portIdx, frame, why, ex) {
    if (dev && dev.taps && dev.taps.size) for (const t of [...dev.taps]) t(frame, 'out', portIdx);
    return baseTx.call(this, dev, portIdx, frame, why, ex);
  };

  function ts(ticks) {
    const ms = ticks * 10;
    const s = Math.floor(ms / 1000);
    return [Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':') + '.' + String((ms % 1000) * 1000).padStart(6, '0');
  }

  function addrsOf(f) {
    if (f.type === 'ARP' && f.payload) return [f.payload.senderIp, f.payload.targetIp];
    if (f.type === 'IPv4' && f.payload) return [f.payload.src, f.payload.dst];
    return [];
  }
  function portsOf(f) {
    const l4 = f.type === 'IPv4' && f.payload && (f.payload.proto === 'TCP' || f.payload.proto === 'UDP') ? f.payload.payload || {} : null;
    return l4 ? [l4.sport, l4.dport] : [];
  }

  /** Фильтр tcpdump: icmp, arp, tcp, udp, ip, ip6, [src|dst] host|net|port, and/or/not, скобки. */
  function compileFilter(tokens) {
    let i = 0;
    const peek = () => tokens[i];
    const next = () => tokens[i++];
    const prim = () => {
      let dir = null;
      let t = next();
      if (t === 'src' || t === 'dst') { dir = t; t = next(); }
      const pick = (arr) => (dir === 'src' ? [arr[0]] : dir === 'dst' ? [arr[1]] : arr);
      if (t === 'host') { const a = U.parseIp(next() || ''); if (a == null) throw new Error('host'); return (f) => pick(addrsOf(f)).includes(a); }
      if (t === 'net') { const c = parseCidr(next()); if (!c) throw new Error('net'); return (f) => pick(addrsOf(f)).some((x) => x != null && U.net(x, c.mask) === c.net); }
      if (t === 'port') { const p = parsePort(next()); if (typeof p !== 'number') throw new Error('port'); return (f) => pick(portsOf(f)).includes(p); }
      if (dir && t != null && U.parseIp(t) != null) { const a = U.parseIp(t); return (f) => pick(addrsOf(f)).includes(a); }
      if (dir) throw new Error(t || dir);
      const P4 = (proto) => (f) => f.type === 'IPv4' && f.payload && f.payload.proto === proto;
      const K = {
        icmp: P4('ICMP'), tcp: P4('TCP'), udp: P4('UDP'), arp: (f) => f.type === 'ARP', ip: (f) => f.type === 'IPv4', ip6: (f) => f.type === 'IPv6',
        icmp6: (f) => f.type === 'IPv6' && f.payload && f.payload.next === 'ICMPv6', stp: (f) => /STP|BPDU/.test(P.classify(f)),
      };
      if (K[t]) return K[t];
      if (t != null && U.parseIp(t) != null) { const a = U.parseIp(t); return (f) => addrsOf(f).includes(a); }
      throw new Error(t == null ? 'неожиданный конец' : t);
    };
    const factor = () => {
      const t = peek();
      if (t === 'not' || t === '!') { next(); const f = factor(); return (x) => !f(x); }
      if (t === '(') { next(); const f = expr(); if (next() !== ')') throw new Error(')'); return f; }
      return prim();
    };
    const term = () => {
      let f = factor();
      while (peek() === 'and' || peek() === '&&') { next(); const g = factor(); const h = f; f = (x) => h(x) && g(x); }
      return f;
    };
    function expr() {
      let f = term();
      while (peek() === 'or' || peek() === '||') { next(); const g = term(); const h = f; f = (x) => h(x) || g(x); }
      return f;
    }
    if (!tokens.length) return () => true;
    const f = expr();
    if (i < tokens.length) throw new Error(tokens[i]);
    return f;
  }

  function tcpFlags(l4) {
    let s = '';
    if (P.hasFlag(l4, 'SYN')) s += 'S';
    if (P.hasFlag(l4, 'FIN')) s += 'F';
    if (P.hasFlag(l4, 'RST')) s += 'R';
    if (P.hasFlag(l4, 'PSH') || l4.data != null) s += 'P';
    if (P.hasFlag(l4, 'ACK')) s += '.';
    return s || 'none';
  }

  function tdLine(frame, o) {
    const pn = (a, port) => ip(a) + (port != null ? '.' + (o.n ? port : PORT_NAMES[port] || port) : '');
    const eth = o.e ? String(frame.src || '').toLowerCase() + ' > ' + String(frame.dst || '').toLowerCase() + ', ethertype ' + (frame.type || '?') + ', length ' + P.sizeOf(frame) + ': ' : '';
    if (frame.type === 'ARP' && frame.payload) {
      const a = frame.payload;
      return eth + 'ARP, ' + (a.op === 'request' ? 'Request who-has ' + ip(a.targetIp) + ' tell ' + ip(a.senderIp) : 'Reply ' + ip(a.senderIp) + ' is-at ' + String(a.senderMac).toLowerCase()) + ', length 28';
    }
    if (frame.type === 'IPv4' && frame.payload) {
      const p = frame.payload;
      const l4 = p.payload || {};
      const len = Math.max(0, P.sizeOf(frame) - 34);
      const ttl = o.v ? ' (tos 0x0, ttl ' + (p.ttl || 64) + ', proto ' + p.proto + ')' : '';
      if (p.proto === 'ICMP') {
        const nm = { 'echo-request': 'echo request', 'echo-reply': 'echo reply', unreachable: ip(p.dst) + ' unreachable', 'time-exceeded': 'time exceeded in-transit' }[l4.type] || String(l4.type);
        return eth + 'IP' + ttl + ' ' + ip(p.src) + ' > ' + ip(p.dst) + ': ICMP ' + nm + (l4.id != null && /^echo/.test(l4.type) ? ', id ' + l4.id + ', seq ' + l4.seq : '') + ', length ' + len;
      }
      if (p.proto === 'TCP') {
        const app = l4.data != null ? ': ' + P.summary(frame) : '';
        return eth + 'IP' + ttl + ' ' + pn(p.src, l4.sport) + ' > ' + pn(p.dst, l4.dport) + ': Flags [' + tcpFlags(l4) + '], seq ' + (l4.seq || 0) + (P.hasFlag(l4, 'ACK') ? ', ack ' + (l4.ack || 0) : '') + ', length ' + (l4.data != null ? l4.len || len : 0) + app;
      }
      if (p.proto === 'UDP') return eth + 'IP' + ttl + ' ' + pn(p.src, l4.sport) + ' > ' + pn(p.dst, l4.dport) + ': ' + (/^(DHCP|DNS|TFTP|SNMP|SYSLOG)/i.test(P.classify(frame)) ? P.summary(frame) : 'UDP, length ' + len);
      return eth + 'IP' + ttl + ' ' + ip(p.src) + ' > ' + ip(p.dst) + ': ' + p.proto + ' ' + P.summary(frame);
    }
    if (frame.type === 'IPv6') return eth + 'IP6 ' + P.summary(frame);
    return eth + P.classify(frame) + ': ' + P.summary(frame);
  }

  function tcpdump(d, args, io) {
    const o = { n: false, e: false, v: false, c: 0, i: ifName(d) };
    const rest = [];
    for (let k = 0; k < args.length; k++) {
      const x = args[k];
      if (x === '-i') { o.i = args[++k]; continue; }
      if (x === '-c') { o.c = Number(args[++k]); if (!(o.c > 0)) { io.out('tcpdump: invalid packet count ' + args[k]); return null; } continue; }
      if (x === '-w' || x === '-r' || x === '-s') { io.out('tcpdump: ключ ' + x + ' в NetLab не нужен — для файла .pcap используйте Sniffer или кнопку «.pcap» в режиме «Симуляция».'); if (x !== '-s') return null; k++; continue; }
      if (/^-[nevqXAtl]+$/.test(x)) { if (x.includes('n')) o.n = true; if (x.includes('e')) o.e = true; if (x.includes('v')) o.v = true; continue; }
      if (x.startsWith('-')) { io.out('tcpdump: invalid option -- \'' + x.replace(/^-+/, '') + "'"); return null; }
      rest.push(...x.split(/(\(|\))/).filter(Boolean));
    }
    if (o.i !== 'any' && o.i !== ifName(d)) { io.out('tcpdump: ' + o.i + ': No such device exists'); io.out('(SIOCGIFHWADDR: No such device)'); return null; }
    let fn;
    try { fn = compileFilter(rest); } catch (e) { io.out('tcpdump: syntax error in filter expression: ' + e.message); return null; }
    if (!o.v) io.out('tcpdump: verbose output suppressed, use -v[v]... for full protocol decode');
    io.out('listening on ' + o.i + ', link-type EN10MB (Ethernet), snapshot length 262144 bytes');
    let got = 0;
    let seen = 0;
    let stopFn = null;
    const tap = (frame) => {
      seen++;
      let ok = false;
      try { ok = fn(frame); } catch (e) { ok = false; }
      if (!ok) return;
      got++;
      io.out(ts(d.net.time) + ' ' + tdLine(frame, o));
      if (o.c && got >= o.c && stopFn) d.timer(0, () => stopFn(false));
    };
    return runAsync(d, io, (finish) => {
      if (!d.taps) d.taps = new Set();
      d.taps.add(tap);
      stopFn = (cancelled) => {
        if (!d.taps.has(tap)) return;
        d.taps.delete(tap);
        if (cancelled) io.out('^C');
        io.out(got + ' packet' + (got === 1 ? '' : 's') + ' captured');
        io.out(seen + ' packet' + (seen === 1 ? '' : 's') + ' received by filter');
        io.out('0 packets dropped by kernel');
        finish();
      };
    }, () => stopFn && stopFn(true));
  }

  /* ================= ip, ifconfig, route, arp ================= */

  function linkState(d) {
    const f = d.iface;
    const p = f && f.port >= 0 ? d.ports[f.port] : null;
    const admin = !!p && p.adminUp !== false;
    const carrier = admin && d.net.isPortOperational(d, f.port);
    return { admin, carrier, p };
  }

  function ipAddr(d, io, o) {
    const f = d.iface;
    const n = ifName(d);
    const { admin, carrier } = linkState(d);
    const st = carrier ? 'UP' : 'DOWN';
    if (o.brief) {
      io.out(pad('lo', 17) + pad('UNKNOWN', 15) + '127.0.0.1/8 ::1/128');
      io.out(pad(n, 17) + pad(st, 15) + (f.ip != null ? ip(f.ip) + '/' + pfx(f.mask) : ''));
      return;
    }
    if (!o.dev || o.dev === 'lo') {
      io.out('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000');
      io.out('    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00');
      if (!o.link) { io.out('    inet 127.0.0.1/8 scope host lo'); io.out('       valid_lft forever preferred_lft forever'); }
    }
    if (!o.dev || o.dev === n) {
      const flags = admin ? (carrier ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<NO-CARRIER,BROADCAST,MULTICAST,UP>') : '<BROADCAST,MULTICAST>';
      io.out('2: ' + n + ': ' + flags + ' mtu 1500 qdisc ' + (carrier ? 'fq_codel' : 'noop') + ' state ' + st + ' group default qlen 1000');
      io.out('    link/ether ' + macOf(d) + ' brd ff:ff:ff:ff:ff:ff');
      if (!o.link && f.ip != null) {
        io.out('    inet ' + ip(f.ip) + '/' + pfx(f.mask) + ' brd ' + ip((U.net(f.ip, f.mask) | ~f.mask) >>> 0) + ' scope global ' + (f.dhcp ? 'dynamic ' : '') + n);
        io.out('       valid_lft forever preferred_lft forever');
      }
    }
  }

  function routeLines(d) {
    const f = d.iface;
    const n = ifName(d);
    const L = [];
    if (d.gateway != null) L.push('default via ' + ip(d.gateway) + ' dev ' + n + ' proto ' + (f.dhcp ? 'dhcp src ' + ip(f.ip) + ' metric 100' : 'static'));
    for (const r of d.routes || []) L.push(U.cidr(r.net, r.mask) + (r.nextHop != null ? ' via ' + ip(r.nextHop) : '') + ' dev ' + n);
    if (f.ip != null && linkState(d).carrier) L.push(U.cidr(U.net(f.ip, f.mask), f.mask) + ' dev ' + n + ' proto kernel scope link src ' + ip(f.ip));
    return L;
  }

  function setGateway(d, gw, io, mutate) {
    const f = d.iface;
    if (gw != null) {
      if (f.ip == null) { io.out('Error: Nexthop has invalid gateway.'); return; }
      if (!U.sameNet(gw, f.ip, f.mask)) { io.out('Error: Nexthop has invalid gateway.'); return; }
    }
    try { mutate(() => d.setStatic(f.ip, f.mask, gw, d.dns)); } catch (e) { io.out('RTNETLINK answers: ' + e.message); }
  }

  function setAddr(d, cidr, io, mutate) {
    const c = parseCidr(cidr);
    if (!c || !cidr.includes('/')) { io.out('Error: any valid prefix is expected rather than "' + (cidr || '') + '".'); return; }
    const gw = d.gateway != null && U.sameNet(d.gateway, c.addr, c.mask) ? d.gateway : null;
    try { mutate(() => d.setStatic(c.addr, c.mask, gw, d.dns)); } catch (e) { io.out('RTNETLINK answers: ' + e.message); }
  }

  function setLink(d, up, mutate) {
    const f = d.iface;
    if (!(f.port >= 0)) return;
    mutate(() => { d.ports[f.port].adminUp = up; d.net.refreshTopology(); });
  }

  function ipCmd(d, a, io, mutate) {
    let k = 0;
    const o = {};
    while (a[k] && a[k].startsWith('-')) {
      if (a[k] === '-br' || a[k] === '-brief') o.brief = true;
      k++;
    }
    const obj = a[k] || '';
    const sub = a[k + 1] || 'show';
    const rest = a.slice(k + 2);
    const devArg = () => { const i = rest.indexOf('dev'); return i >= 0 ? rest[i + 1] : null; };
    const checkDev = (x) => { if (x && x !== ifName(d) && x !== 'lo') { io.out('Cannot find device "' + x + '"'); return false; } return true; };
    const is = (w, full) => w && full.startsWith(w);
    if (!obj || obj === 'help') { io.out('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }'); io.out('where  OBJECT := { address | link | route | neigh }'); io.out('       OPTIONS := { -br[ief] }'); return; }
    if (is(obj, 'address') || obj === 'a') {
      if (is(sub, 'show') || sub === 'list' || sub === 'ls') { const x = devArg() || (rest[0] !== 'dev' ? rest[0] : null); if (!checkDev(x)) return; ipAddr(d, io, Object.assign(o, { dev: x })); return; }
      if (sub === 'add' || sub === 'replace') { if (!checkDev(devArg())) return; if (!devArg()) { io.out('Not enough information: "dev" argument is required.'); return; } setAddr(d, rest[0], io, mutate); return; }
      if (sub === 'del' || sub === 'delete') {
        const c = parseCidr(rest[0]);
        if (!c || d.iface.ip !== c.addr) { io.out('RTNETLINK answers: Cannot assign requested address'); return; }
        mutate(() => d.setStatic(null, null, null, d.dns));
        return;
      }
      if (sub === 'flush') { if (!checkDev(devArg() || rest[0])) return; mutate(() => d.setStatic(null, null, null, d.dns)); return; }
      io.out('Command "' + sub + '" is unknown, try "ip address help".');
      return;
    }
    if (is(obj, 'link') || obj === 'l') {
      if (is(sub, 'show') || sub === 'list') { ipAddr(d, io, Object.assign(o, { link: true, dev: rest[0] === 'dev' ? rest[1] : rest[0] || null })); return; }
      if (sub === 'set') {
        const x = rest[0] === 'dev' ? rest[1] : rest[0];
        if (!checkDev(x)) return;
        if (rest.includes('up')) setLink(d, true, mutate);
        else if (rest.includes('down')) setLink(d, false, mutate);
        else io.out('Error: either "dev" is duplicate, or "' + (rest[rest.length - 1] || '') + '" is a garbage.');
        return;
      }
      io.out('Command "' + sub + '" is unknown, try "ip link help".');
      return;
    }
    if (is(obj, 'route') || obj === 'r') {
      if (is(sub, 'show') || sub === 'list') { for (const l of routeLines(d)) io.out(l); return; }
      if (sub === 'get') {
        const t = U.parseIp(rest[0] || '');
        if (t == null) { io.out('Error: any valid address is expected rather than "' + (rest[0] || '') + '".'); return; }
        const r = d.lookup(t);
        if (!r) { io.out('RTNETLINK answers: Network is unreachable'); return; }
        io.out(ip(t) + (r.nextHop != null ? ' via ' + ip(r.nextHop) : '') + ' dev ' + ifName(d) + ' src ' + ip(d.iface.ip) + ' uid 0');
        io.out('    cache');
        return;
      }
      const via = rest.indexOf('via') >= 0 ? U.parseIp(rest[rest.indexOf('via') + 1] || '') : null;
      const dst = rest[0];
      if (sub === 'add' || sub === 'replace' || sub === 'append') {
        if (dst === 'default' || dst === '0.0.0.0/0') { if (via == null) { io.out('Error: Nexthop has invalid gateway.'); return; } setGateway(d, via, io, mutate); return; }
        const c = parseCidr(dst);
        if (!c) { io.out('Error: any valid prefix is expected rather than "' + (dst || '') + '".'); return; }
        if (via == null) { io.out('Error: в NetLab для маршрута нужен шлюз: ip route add ' + dst + ' via АДРЕС'); return; }
        try { mutate(() => d.addRoute(c.net, c.mask, via, {})); } catch (e) { io.out('RTNETLINK answers: ' + (/уже есть/.test(e.message) ? 'File exists' : e.message)); }
        return;
      }
      if (sub === 'del' || sub === 'delete') {
        if (dst === 'default' || dst === '0.0.0.0/0') { if (d.gateway == null) { io.out('RTNETLINK answers: No such process'); return; } setGateway(d, null, io, mutate); return; }
        const c = parseCidr(dst);
        let ok = false;
        if (c) mutate(() => { ok = d.removeRoute(c.net, c.mask, via); });
        if (!ok) io.out('RTNETLINK answers: No such process');
        return;
      }
      if (sub === 'flush') { mutate(() => { d.routes = []; d.net.markRouting(); }); return; }
      io.out('Command "' + sub + '" is unknown, try "ip route help".');
      return;
    }
    if (is(obj, 'neighbour') || is(obj, 'neighbor') || obj === 'n') {
      if (sub === 'flush') { d.clearArp(); return; }
      for (const [a2, e] of d.arp) io.out(ip(a2) + ' dev ' + ifName(d) + ' lladdr ' + String(e.mac).toLowerCase() + ' REACHABLE');
      return;
    }
    io.out('Object "' + obj + '" is unknown, try "ip help".');
  }

  function ifconfig(d, a, io, mutate) {
    const n = ifName(d);
    if (a[0] && a[0] !== n && a[0] !== 'lo' && a[0] !== '-a') { io.out(a[0] + ': error fetching interface information: Device not found'); return; }
    if (a[0] === n && a.length > 1) {
      if (a[1] === 'up' || a[1] === 'down') { setLink(d, a[1] === 'up', mutate); return; }
      const addr = U.parseIp(a[1]);
      const mi = a.indexOf('netmask');
      const mask = mi >= 0 ? U.parseMask(a[mi + 1] || '') : U.classfulMask ? U.classfulMask(addr) : 0xffffff00;
      if (addr == null || mask == null) { io.out(a[1] + ': Unknown host'); io.out('ifconfig: `--help\' gives usage information.'); return; }
      setAddr(d, ip(addr) + '/' + pfx(mask), io, mutate);
      return;
    }
    const f = d.iface;
    const { admin, carrier, p } = linkState(d);
    if (a[0] !== 'lo') {
      const flags = admin ? (carrier ? '4163<UP,BROADCAST,RUNNING,MULTICAST>' : '4099<UP,BROADCAST,MULTICAST>') : '4098<BROADCAST,MULTICAST>';
      if (admin || a[0] === '-a' || a[0] === n) {
        io.out(n + ': flags=' + flags + '  mtu 1500');
        if (f.ip != null) io.out('        inet ' + ip(f.ip) + '  netmask ' + ip(f.mask) + '  broadcast ' + ip((U.net(f.ip, f.mask) | ~f.mask) >>> 0));
        io.out('        ether ' + macOf(d) + '  txqueuelen 1000  (Ethernet)');
        io.out('        RX packets ' + ((p && p.rxPkts) || 0) + '  bytes ' + ((p && p.rxBytes) || 0));
        io.out('        TX packets ' + ((p && p.txPkts) || 0) + '  bytes ' + ((p && p.txBytes) || 0));
        io.out('');
      }
    }
    if (!a[0] || a[0] === 'lo' || a[0] === '-a') {
      io.out('lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536');
      io.out('        inet 127.0.0.1  netmask 255.0.0.0');
      io.out('        loop  txqueuelen 1000  (Local Loopback)');
      io.out('');
    }
  }

  function routeN(d, io) {
    const f = d.iface;
    const n = ifName(d);
    io.out('Kernel IP routing table');
    io.out(pad('Destination', 16) + pad('Gateway', 16) + pad('Genmask', 16) + 'Flags Metric Ref    Use Iface');
    const row = (dst, gw, mask, fl) => io.out(pad(dst, 16) + pad(gw, 16) + pad(mask, 16) + pad(fl, 6) + pad('0', 7) + pad('0', 7) + padL('0', 3) + ' ' + n);
    if (d.gateway != null) row('0.0.0.0', ip(d.gateway), '0.0.0.0', 'UG');
    for (const r of d.routes || []) row(ip(r.net), r.nextHop != null ? ip(r.nextHop) : '0.0.0.0', ip(r.mask), 'UG');
    if (f.ip != null && linkState(d).carrier) row(ip(U.net(f.ip, f.mask)), '0.0.0.0', ip(f.mask), 'U');
  }

  /* ================= ping, traceroute, DNS ================= */

  function ping(d, a, io) {
    let count = Infinity;
    let ttl = null;
    let size = 56;
    let interval = null;
    let quiet = false;
    let target = null;
    for (let k = 0; k < a.length; k++) {
      const x = a[k];
      if (x === '-c') { count = Number(a[++k]); if (!(count > 0)) { io.out('ping: invalid argument: \'' + a[k] + '\''); return null; } } else if (x === '-t') { ttl = Number(a[++k]); if (!(ttl >= 1 && ttl <= 255)) { io.out('ping: invalid argument: \'' + a[k] + '\': out of range: 0 <= value <= 255'); return null; } } else if (x === '-s') { size = Number(a[++k]); if (!(size >= 0 && size <= 65507)) { io.out('ping: invalid argument: \'' + a[k] + '\''); return null; } } else if (x === '-i') { interval = Math.max(1, Math.round(Number(a[++k]) * 100)); } else if (x === '-q') quiet = true;
      else if (x === '-W' || x === '-w' || x === '-I') k++;
      else if (x === '-4' || x === '-n' || x === '-O') { /* по умолчанию */ } else if (x.startsWith('-')) { io.out('ping: invalid option -- \'' + x.replace(/^-+/, '') + '\''); return null; } else target = x;
    }
    if (!target) { io.out('ping: usage error: Destination address required'); return null; }
    let shown = target;
    const t0 = d.net.time;
    const opts = {
      count, ttl, size,
      onEvent(ev) {
        switch (ev.type) {
          case 'resolve-fail': io.out('ping: ' + target + ': ' + (/DNS/.test(ev.text || '') ? 'Temporary failure in name resolution' : 'Name or service not known')); break;
          case 'start': shown = ev.name; io.out('PING ' + ev.name + ' (' + ip(ev.ip) + ') ' + size + '(' + (size + 28) + ') bytes of data.'); break;
          case 'reply': if (!quiet) io.out((size + 8) + ' bytes from ' + ip(ev.from) + ': icmp_seq=' + ev.seq + ' ttl=' + ev.ttl + ' time=' + (ev.rtt < 1 ? (0.3 + ((ev.seq * 37) % 60) / 100).toFixed(3) : ev.rtt.toFixed(2)) + ' ms'); break;
          case 'unreachable': if (!quiet) io.out('From ' + ip(ev.from) + ' icmp_seq=' + ev.seq + ' ' + (ev.code === 0 ? 'Destination Net Unreachable' : ev.code === 3 ? 'Destination Port Unreachable' : ev.code === 13 ? 'Packet filtered' : 'Destination Host Unreachable')); break;
          case 'ttl-expired': if (!quiet) io.out('From ' + ip(ev.from) + ' icmp_seq=' + ev.seq + ' Time to live exceeded'); break;
          case 'error':
            if (ev.code === 'iptables') io.out('ping: sendmsg: Operation not permitted');
            else if (ev.code === 'no-route') io.out('ping: connect: Network is unreachable');
            else if (ev.code === 'arp-fail') io.out('From ' + (d.iface.ip != null ? ip(d.iface.ip) : '0.0.0.0') + ' icmp_seq=' + ev.seq + ' Destination Host Unreachable');
            else if (ev.code === 'no-ip' || ev.code === 'down') io.out('ping: connect: Network is unreachable');
            else io.out('ping: ' + (ev.text || ev.code));
            break;
          case 'done': {
            if (ev.cancelled) io.out('^C');
            if (ev.sent > 0) {
              io.out('');
              io.out('--- ' + shown + ' ping statistics ---');
              io.out(ev.sent + ' packets transmitted, ' + ev.received + ' received, ' + Math.round((1 - ev.received / ev.sent) * 100) + '% packet loss, time ' + Math.max(0, (d.net.time - t0) * 10) + 'ms');
              if (ev.rtts.length) {
                const min = Math.min(...ev.rtts);
                const max = Math.max(...ev.rtts);
                const avg = ev.rtts.reduce((x, y) => x + y, 0) / ev.rtts.length;
                const mdev = Math.sqrt(ev.rtts.reduce((x, y) => x + (y - avg) ** 2, 0) / ev.rtts.length);
                io.out('rtt min/avg/max/mdev = ' + [min, avg, max, mdev].map((v) => v.toFixed(3)).join('/') + ' ms');
              }
            }
            io.done();
            break;
          }
          default: break;
        }
      },
    };
    if (interval) opts.interval = interval;
    return d.ping(target, opts);
  }

  function traceroute(d, a, io) {
    const target = a.filter((x) => !x.startsWith('-') && !/^\d+$/.test(x))[0] || null;
    const mi = a.indexOf('-m');
    const maxHops = mi >= 0 ? Number(a[mi + 1]) || 30 : 30;
    if (!target) { io.out('Usage: traceroute [ -m max_ttl ] host'); return null; }
    return d.traceroute(target, {
      maxHops,
      onEvent(ev) {
        if (ev.type === 'resolve-fail') { io.out(target + ': Name or service not known'); io.out('Cannot handle "host" cmdline arg `' + target + "' on position 1 (argc 1)"); return; }
        if (ev.type === 'start') { io.out('traceroute to ' + ev.name + ' (' + ip(ev.ip) + '), ' + ev.maxHops + ' hops max, 60 byte packets'); return; }
        if (ev.type === 'hop') {
          const who = ev.from != null ? ip(ev.from) + ' (' + ip(ev.from) + ')' : null;
          const times = ev.rtts.map((r) => (r == null ? '*' : r.toFixed(3) + ' ms')).join('  ');
          io.out(padL(ev.ttl, 2) + '  ' + (who ? who + '  ' + times + (ev.kind === 'unreachable' ? ' !H' : '') : ev.rtts.map(() => '*').join(' ')));
          return;
        }
        if (ev.type === 'done') { if (ev.cancelled) io.out('^C'); io.done(); }
      },
    });
  }

  function dnsCmd(d, cmd, a, io) {
    const short = a.includes('+short');
    const name = a.filter((x) => !x.startsWith('+') && !x.startsWith('-') && !x.startsWith('@'))[0];
    if (!name) { io.out(cmd === 'dig' ? '; <<>> DiG 9.18 <<>>' : 'Usage: ' + cmd + ' name'); return null; }
    const srv = d.dns != null ? ip(d.dns) : null;
    return runAsync(d, io, (finish) => {
      d.resolveName(name, (addr, err) => {
        if (cmd === 'host') io.out(addr != null ? name + ' has address ' + ip(addr) : err && /не задан DNS/.test(err) ? ';; connection timed out; no servers could be reached' : 'Host ' + name + ' not found: 3(NXDOMAIN)');
        else if (cmd === 'dig') {
          if (short) { if (addr != null) io.out(ip(addr)); } else {
            io.out('; <<>> DiG 9.18.24 <<>> ' + name);
            if (addr == null && (!srv || /время|timed|не ответ/i.test(err || ''))) { io.out(';; connection timed out; no servers could be reached'); } else {
              io.out(';; ->>HEADER<<- opcode: QUERY, status: ' + (addr != null ? 'NOERROR' : 'NXDOMAIN'));
              io.out('');
              io.out(';; QUESTION SECTION:');
              io.out(';' + name + '.\t\t\tIN\tA');
              if (addr != null) { io.out(''); io.out(';; ANSWER SECTION:'); io.out(name + '.\t\t300\tIN\tA\t' + ip(addr)); }
              io.out('');
              io.out(';; SERVER: ' + srv + '#53(' + srv + ') (UDP)');
            }
          }
        } else {
          io.out('Server:\t\t' + (srv || '127.0.0.53'));
          io.out('Address:\t' + (srv || '127.0.0.53') + '#53');
          io.out('');
          if (addr != null) { io.out('Non-authoritative answer:'); io.out('Name:\t' + name); io.out('Address: ' + ip(addr)); } else io.out(srv ? "** server can't find " + name + ': NXDOMAIN' : ';; connection timed out; no servers could be reached');
        }
        finish();
      });
    });
  }

  /* ================= curl, wget, nc ================= */

  function urlParts(u) {
    const p = IpNode.parseUrl(u);
    return p ? { host: p.host, port: p.port || (p.https ? 443 : 80), path: p.path, https: p.https } : null;
  }
  const CERT_EN = { 'self-signed': 'self-signed certificate', hostname: 'no alternative certificate subject name matches target host name', expired: 'certificate has expired', none: 'unable to get local issuer certificate' };
  function curlError(r, u) {
    const e = String(r.error || '');
    if (r.cert) return 'curl: (60) SSL certificate problem: ' + (CERT_EN[r.cert.code] || r.cert.text) + '\nMore details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it. To learn more about this situation and\nhow to fix it, please visit the web page mentioned above. (Или: curl -k — не проверять сертификат.)';
    if (/DNS|имен|не удалось найти|разреш/i.test(e)) return 'curl: (6) Could not resolve host: ' + u.host;
    if (/отказ|refused|RST|закрыт|не слушает|reset/i.test(e)) return 'curl: (7) Failed to connect to ' + u.host + ' port ' + u.port + ' after 3 ms: Couldn\'t connect to server';
    if (/время|timeout|ответ/i.test(e)) return 'curl: (28) Failed to connect to ' + u.host + ' port ' + u.port + ' after 3000 ms: Timeout was reached';
    if (/Operation not permitted|iptables/i.test(e)) return 'curl: (7) Failed to connect to ' + u.host + ' port ' + u.port + ': Operation not permitted';
    return 'curl: (7) Failed to connect to ' + u.host + ' port ' + u.port + ': ' + e;
  }

  function curl(d, a, io) {
    let method = null;
    const headers = {};
    let data = null;
    let head = false;
    let inc = false;
    let verbose = false;
    let insecure = false;
    let url = null;
    for (let k = 0; k < a.length; k++) {
      const x = a[k];
      if (x === '-X' || x === '--request') method = String(a[++k] || '').toUpperCase();
      else if (x === '-H' || x === '--header') { const hv = String(a[++k] || ''); const i = hv.indexOf(':'); if (i > 0) headers[hv.slice(0, i).trim()] = hv.slice(i + 1).trim(); } else if (x === '-d' || x === '--data' || x === '--data-raw') data = a[++k] || '';
      else if (x === '--json') { data = a[++k] || ''; headers['Content-Type'] = 'application/json'; headers.Accept = 'application/json'; } else if (x === '-u' || x === '--user') { const cred = a[++k] || ''; headers.Authorization = 'Basic ' + (typeof btoa === 'function' ? btoa(cred) : Buffer.from(cred).toString('base64')); } else if (x === '-I' || x === '--head') head = true;
      else if (x === '-i' || x === '--include') inc = true;
      else if (x === '-v' || x === '--verbose') verbose = true;
      else if (/^-[sSLkf]+$/.test(x) || x === '--silent' || x === '--insecure' || x === '--location') { if (x.includes('k') || x === '--insecure') insecure = true; } else if (x === '-o' || x === '--output') k++;
      else if (x.startsWith('-')) { io.out('curl: option ' + x + ': is unknown'); io.out("curl: try 'curl --help' or 'curl --manual' for more information"); return null; } else url = x;
    }
    if (!url) { io.out("curl: try 'curl --help' or 'curl --manual' for more information"); return null; }
    const u = urlParts(url);
    if (!u) { io.out('curl: (3) URL using bad/illegal format or missing URL'); return null; }
    method = method || (head ? 'HEAD' : data != null ? 'POST' : 'GET');
    if (data != null && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return runAsync(d, io, (finish) => {
      if (verbose) { io.out('*   Trying ' + u.host + ':' + u.port + '...'); }
      d.httpRequest(method === 'HEAD' ? 'GET' : method, url, { headers, body: data, insecure }, (r) => {
        if (!r.ok) { if (verbose && r.tls && r.tls.cert) io.out('* Server certificate: subject: CN=' + r.tls.cert.cn + '; issuer: ' + (r.tls.cert.issuer === 'self' ? 'CN=' + r.tls.cert.cn : 'CN=' + r.tls.cert.issuer)); io.out(curlError(r, u)); finish(); return; }
        if (verbose && r.tls) { io.out('* SSL connection using ' + r.tls.version + ' / ' + r.tls.cipher); io.out('* Server certificate: subject: CN=' + r.tls.cert.cn + '; issuer: ' + (r.tls.cert.issuer === 'self' ? 'CN=' + r.tls.cert.cn : 'CN=' + r.tls.cert.issuer)); if (r.tls.problem) io.out('* SSL certificate verify result: ' + (CERT_EN[r.tls.problem.code] || r.tls.problem.text) + ', continuing anyway.'); }
        const hdr = ['HTTP/1.1 ' + r.status + ' ' + (r.reason || ''), 'Server: ' + ((r.headers && r.headers.Server) || 'NetLab')];
        for (const [k, v] of Object.entries(r.headers || {})) if (k !== 'Server') hdr.push(k + ': ' + v);
        hdr.push('Content-Length: ' + String(r.body || '').length);
        if (verbose) {
          io.out('* Connected to ' + u.host + ' port ' + u.port);
          io.out('> ' + method + ' ' + u.path + ' HTTP/1.1');
          io.out('> Host: ' + u.host);
          for (const [k, v] of Object.entries(headers)) io.out('> ' + k + ': ' + v);
          io.out('>');
          for (const l of hdr) io.out('< ' + l);
          io.out('<');
        } else if (head || inc) { for (const l of hdr) io.out(l); io.out(''); }
        if (!head) for (const l of String(r.body || '').split('\n')) io.out(l);
        finish();
      });
    });
  }

  function wget(d, a, io) {
    const url = a.filter((x) => !x.startsWith('-'))[0];
    const insecure = a.includes('--no-check-certificate');
    if (!url) { io.out('wget: missing URL'); return null; }
    const u = urlParts(url);
    if (!u) { io.out(url + ': Invalid URL'); return null; }
    const file = (u.path.split('/').pop() || 'index.html').replace(/[^\w.-]+/g, '_') || 'index.html';
    return runAsync(d, io, (finish) => {
      io.out('--' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '--  ' + (u.https ? 'https' : 'http') + '://' + u.host + u.path);
      io.out('Connecting to ' + u.host + ':' + u.port + '... ');
      d.httpRequest('GET', url, { insecure }, (r) => {
        if (!r.ok && r.cert) {
          io.out('connected.');
          io.out('ERROR: cannot verify ' + u.host + '\'s certificate, issued by ‘CN=' + (r.tls && r.tls.cert ? (r.tls.cert.issuer === 'self' ? r.tls.cert.cn : r.tls.cert.issuer) : '?') + '’:');
          io.out('  ' + (r.cert.code === 'self-signed' ? 'Self-signed certificate encountered.' : r.cert.code === 'hostname' ? 'certificate common name doesn\'t match requested host name ‘' + u.host + '’.' : r.cert.code === 'expired' ? 'Issued certificate has expired.' : r.cert.text));
          io.out('To connect to ' + u.host + ' insecurely, use `--no-check-certificate\'.');
          finish();
          return;
        }
        if (!r.ok) { io.out('failed: ' + (r.error || 'Connection refused') + '.'); finish(); return; }
        const body = String(r.body || '');
        io.out('connected.');
        io.out('HTTP request sent, awaiting response... ' + r.status + ' ' + (r.reason || ''));
        if (r.status >= 400) { io.out(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ERROR ' + r.status + ': ' + (r.reason || '') + '.'); finish(); return; }
        io.out('Length: ' + body.length + ' [text/html]');
        io.out('Saving to: ‘' + file + '’');
        io.out('');
        try { d.saveFile(file, body); } catch (e) { /* имя не подошло — не сохраняем */ }
        io.out(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' (1.00 MB/s) - ‘' + file + '’ saved [' + body.length + '/' + body.length + ']');
        finish();
      });
    });
  }

  function nc(d, a, io) {
    const pos = a.filter((x) => !x.startsWith('-'));
    const zero = a.some((x) => /^-[a-zA-Z]*z/.test(x));
    const host = pos[0];
    const port = Number(pos[1]);
    if (!host || !(port > 0 && port < 65536)) { io.out('usage: nc [-zv] host port'); return null; }
    if (!zero) { io.out('nc: в NetLab поддерживается проверка порта: nc -zv ' + host + ' ' + port); return null; }
    let conn = null;
    return runAsync(d, io, (finish, job) => {
      d.resolveName(host, (addr) => {
        if (job.done) return;
        if (addr == null) { io.out('nc: getaddrinfo for host "' + host + '" port ' + port + ': Name or service not known'); finish(); return; }
        const timer = d.timer(300, () => { io.out('nc: connect to ' + host + ' port ' + port + ' (tcp) timed out: Operation now in progress'); if (conn) conn.close && conn.close(); finish(); });
        conn = d.tcp.connect(addr, port, {
          onOpen: () => { timer.cancel(); io.out('Connection to ' + host + ' ' + port + ' port [tcp/' + (PORT_NAMES[port] || '*') + '] succeeded!'); conn.close(); finish(); },
          onError: (code, text) => { timer.cancel(); io.out('nc: connect to ' + host + ' port ' + port + ' (tcp) failed: ' + (code === 'iptables' ? 'Operation not permitted' : /reset|RST|refus|отказ/i.test(String(code) + text) ? 'Connection refused' : 'No route to host')); finish(); },
          onClose: () => { finish(); },
        });
      });
    });
  }

  function ss(d, a, io, netstat) {
    const flags = a.join('');
    const tcpOnly = /t/.test(flags) && !/u/.test(flags);
    const udpOnly = /u/.test(flags) && !/t/.test(flags);
    const listenOnly = /l/.test(flags);
    const all = /a/.test(flags);
    if (netstat && /r/.test(flags)) { routeN(d, io); return; }
    const rows = [];
    const addr = (x, p) => (x == null ? '0.0.0.0' : ip(x)) + ':' + p;
    if (!udpOnly && d.tcp) {
      for (const port of [...d.tcp.listeners.keys()].sort((x, y) => x - y)) rows.push(['tcp', 'LISTEN', addr(null, port), '0.0.0.0:*']);
      if (!listenOnly) for (const c of d.tcp.list()) rows.push(['tcp', c.state === 'ESTABLISHED' ? 'ESTAB' : c.state, addr(c.lip, c.lport), addr(c.rip, c.rport)]);
    }
    if (!tcpOnly && d.udp && (listenOnly || all || /u/.test(flags))) for (const port of [...d.udp.keys()].filter((p) => p < 49152).sort((x, y) => x - y)) rows.push(['udp', 'UNCONN', addr(null, port), '0.0.0.0:*']);
    if (netstat) {
      io.out('Active Internet connections ' + (listenOnly ? '(only servers)' : '(servers and established)'));
      io.out(pad('Proto', 6) + pad('Recv-Q', 7) + pad('Send-Q', 7) + pad('Local Address', 24) + pad('Foreign Address', 24) + 'State');
      for (const r of rows) io.out(pad(r[0], 6) + padL('0', 6) + ' ' + padL('0', 6) + ' ' + pad(r[2], 24) + pad(r[3], 24) + (r[0] === 'tcp' ? (r[1] === 'ESTAB' ? 'ESTABLISHED' : r[1]) : ''));
      return;
    }
    io.out(pad('Netid', 6) + pad('State', 8) + pad('Recv-Q', 7) + pad('Send-Q', 7) + pad('Local Address:Port', 24) + 'Peer Address:Port');
    for (const r of rows) io.out(pad(r[0], 6) + pad(r[1], 8) + pad('0', 7) + pad('0', 7) + pad(r[2], 24) + r[3]);
  }

  /* ================= службы, файлы ================= */

  const UNITS = {
    apache2: ['httpd', 'The Apache HTTP Server'], httpd: ['httpd', 'The Apache HTTP Server'], nginx: ['httpd', 'A high performance web server'],
    bind9: ['dnsd', 'BIND Domain Name Server'], named: ['dnsd', 'BIND Domain Name Server'],
    'isc-dhcp-server': ['dhcpd', 'ISC DHCP IPv4 server'], dhcpd: ['dhcpd', 'ISC DHCP IPv4 server'], 'kea-dhcp4-server': ['dhcpd', 'Kea DHCPv4 Service'],
    postfix: ['maild', 'Postfix Mail Transport Agent'], dovecot: ['maild', 'Dovecot IMAP/POP3 email server'],
    'tftpd-hpa': ['tftpd', 'LSB: HPA\'s tftp server'], tftpd: ['tftpd', 'LSB: HPA\'s tftp server'],
  };

  function systemctl(d, verb, unit, io, mutate) {
    const u = String(unit || '').replace(/\.service$/, '');
    if (verb === 'list-units' || verb === 'list-unit-files' || !verb) {
      io.out(pad('UNIT', 30) + pad('LOAD', 7) + pad('ACTIVE', 9) + pad('SUB', 9) + 'DESCRIPTION');
      const seen = new Set();
      for (const [name, [key, desc]] of Object.entries(UNITS)) {
        if (!d[key] || seen.has(key)) continue;
        seen.add(key);
        io.out(pad(name + '.service', 30) + pad('loaded', 7) + pad(d[key].enabled ? 'active' : 'inactive', 9) + pad(d[key].enabled ? 'running' : 'dead', 9) + desc);
      }
      io.out(pad('ssh.service', 30) + pad('loaded', 7) + pad('inactive', 9) + pad('dead', 9) + 'OpenBSD Secure Shell server (NetLab: SSH-сервер есть только на сетевых устройствах)');
      return;
    }
    const map = UNITS[u];
    const svc = map && d[map[0]];
    if (!svc) { io.out((verb === 'status' ? 'Unit ' : 'Failed to ' + verb + ' ') + u + '.service' + (verb === 'status' ? ' could not be found.' : ': Unit ' + u + '.service not found.')); return; }
    if (verb === 'status' || verb === 'is-active') {
      if (verb === 'is-active') { io.out(svc.enabled ? 'active' : 'inactive'); return; }
      io.out((svc.enabled ? '● ' : '○ ') + u + '.service - ' + map[1]);
      io.out('     Loaded: loaded (/lib/systemd/system/' + u + '.service; ' + (svc.enabled ? 'enabled' : 'disabled') + '; preset: enabled)');
      io.out('     Active: ' + (svc.enabled ? 'active (running)' : 'inactive (dead)'));
      return;
    }
    const on = { start: true, restart: true, reload: true, enable: true, stop: false, disable: false }[verb];
    if (on === undefined) { io.out('Unknown command verb \'' + verb + '\'.'); return; }
    mutate(() => { svc.enabled = on; if (typeof svc.bind === 'function') svc.bind(); });
    if (verb === 'enable' || verb === 'disable') io.out((on ? 'Created symlink' : 'Removed') + ' /etc/systemd/system/multi-user.target.wants/' + u + '.service.');
  }

  function catFile(d, name, io) {
    const f = d.iface;
    const files = {
      '/etc/resolv.conf': () => ['# Generated by NetLab (IP Configuration → DNS)'].concat(d.dns != null ? ['nameserver ' + ip(d.dns)] : []),
      '/etc/hostname': () => [hostName(d)],
      '/etc/hosts': () => ['127.0.0.1\tlocalhost', '127.0.1.1\t' + hostName(d)],
      '/etc/os-release': () => ['PRETTY_NAME="NetLab Linux 1.4"', 'NAME="NetLab Linux"', 'VERSION_ID="1.4"', 'ID=netlab', 'ID_LIKE=debian'],
      '/proc/sys/net/ipv4/ip_forward': () => ['0'],
      '/etc/network/interfaces': () => ['auto lo', 'iface lo inet loopback', '', 'auto ' + ifName(d)].concat(f.dhcp ? ['iface ' + ifName(d) + ' inet dhcp'] : f.ip != null ? ['iface ' + ifName(d) + ' inet static', '    address ' + ip(f.ip) + '/' + pfx(f.mask)].concat(d.gateway != null ? ['    gateway ' + ip(d.gateway)] : []) : ['iface ' + ifName(d) + ' inet manual']),
    };
    if (files[name]) { for (const l of files[name]()) io.out(l); return; }
    const own = (d.files || []).find((x) => x.name === name.replace(/^(\.\/|~\/|\/root\/)/, ''));
    if (own) { for (const l of String(own.text).split('\n')) io.out(l); return; }
    io.out('cat: ' + name + ': No such file or directory');
  }

  function echo(d, line, io, mutate) {
    const m = /^echo\s+(-e\s+)?(.*?)\s*(>>?)\s*(\S+)\s*$/.exec(line);
    if (!m) { io.out(tokenize(line).slice(1).join(' ')); return; }
    const text = tokenize(m[2]).join(' ').replace(/\\n/g, '\n');
    const file = m[4];
    if (file === '/etc/resolv.conf') {
      const ns = /nameserver\s+(\S+)/.exec(text);
      const a = ns ? U.parseIp(ns[1]) : null;
      if (ns && a == null) { io.out('bash: неверный адрес DNS-сервера: ' + ns[1]); return; }
      const f = d.iface;
      mutate(() => { if (f.dhcp) d.dns = a; else d.setStatic(f.ip, f.mask, d.gateway, a); });
      return;
    }
    if (/^\/(etc|proc|sys)\//.test(file)) { io.out('bash: ' + file + ': Permission denied (в NetLab этот файл только для чтения)'); return; }
    const name = file.replace(/^(\.\/|~\/|\/root\/)/, '');
    const old = (d.files || []).find((x) => x.name === name);
    try { mutate(() => d.saveFile(name, m[3] === '>>' && old ? old.text + '\n' + text : text)); } catch (e) { io.out('bash: ' + file + ': ' + e.message); }
  }

  function dhclient(d, a, io, mutate) {
    const f = d.iface;
    if (a.includes('-r')) { mutate(() => d.setStatic(null, null, null, null)); io.out('Killed old client process'); return null; }
    const n = ifName(d);
    io.out('DHCPDISCOVER on ' + n + ' to 255.255.255.255 port 67 interval 3');
    mutate(() => d.setDhcp());
    return runAsync(d, io, (finish, job) => {
      let tries = 0;
      const poll = () => {
        if (job.done) return;
        const ph = d.dhcpc && d.dhcpc.phase;
        if (f.dhcp && f.ip != null && ph === 'bound') {
          const srv = d.dhcpc.server != null ? ip(d.dhcpc.server) : '?';
          io.out('DHCPOFFER of ' + ip(f.ip) + ' from ' + srv);
          io.out('DHCPREQUEST for ' + ip(f.ip) + ' on ' + n + ' to 255.255.255.255 port 67');
          io.out('DHCPACK of ' + ip(f.ip) + ' from ' + srv);
          io.out('bound to ' + ip(f.ip) + ' -- renewal in 43200 seconds.');
          finish();
          return;
        }
        if (ph === 'failed' || ++tries > 60) { io.out('No DHCPOFFERS received.'); io.out('No working leases in persistent database - sleeping.'); finish(); return; }
        d.timer(20, poll);
      };
      d.timer(5, poll);
    });
  }

  /* ================= оболочка ================= */

  const HELP = [
    'NetLab Linux — bash. Команды:',
    '  ip a | ip addr add 192.168.1.10/24 dev eth0 | ip link set eth0 up|down | ip r | ip route add default via 192.168.1.1 | ip neigh',
    '  ifconfig, route -n, arp -n, dhclient [-r], hostname [-I]',
    '  ping [-c N] адрес, traceroute адрес, nslookup | dig | host имя',
    '  curl [-I] [-X POST] [-H "k: v"] [-d данные] URL, wget URL, nc -zv адрес порт, ss -tuln, netstat -tuln | -rn',
    '  ssh пользователь@адрес, telnet адрес',
    '  iptables -L -n -v --line-numbers | -A INPUT -p tcp --dport 22 -j ACCEPT | -P INPUT DROP | -D INPUT 1 | -F | -S',
    '  tcpdump [-n] [-c N] [-e] [icmp | arp | tcp port 80 | host 192.168.1.1 and not port 22]   (Ctrl+C — стоп)',
    '  systemctl status|start|stop apache2 | bind9 | isc-dhcp-server | postfix | tftpd-hpa   (на сервере)',
    '  cat /etc/resolv.conf, echo "nameserver 8.8.8.8" > /etc/resolv.conf, ls, cat файл, uname -a, whoami, history, clear',
    '  конвейеры: … | grep слово | head -n 5 | tail | wc -l | sort',
  ];
  const COMMANDS = ['arp', 'cat', 'clear', 'curl', 'date', 'dhclient', 'dig', 'echo', 'exit', 'help', 'history', 'host', 'hostname', 'id', 'ifconfig', 'ip', 'iptables', 'iptables-save', 'ls', 'nc', 'netstat', 'nslookup', 'ping', 'pwd', 'route', 'service', 'ss', 'ssh', 'sudo', 'sysctl', 'systemctl', 'tcpdump', 'telnet', 'traceroute', 'uname', 'uptime', 'wget', 'whoami'];

  /** Фильтры конвейера: grep, head, tail, wc -l, sort. */
  function pipeIo(io, stages) {
    const st = stages.map((s) => {
      const t = tokenize(s);
      const c = t[0];
      if (c === 'grep') {
        const flags = t.slice(1).filter((x) => x.startsWith('-')).join('');
        const pat = t.slice(1).find((x) => !x.startsWith('-')) || '';
        let re;
        try { re = new RegExp(pat, flags.includes('i') ? 'i' : ''); } catch (e) { re = { test: (x) => x.includes(pat) }; }
        return { kind: 'grep', re, inv: flags.includes('v'), count: flags.includes('c'), n: 0 };
      }
      if (c === 'head' || c === 'tail') {
        const m = /-n\s*(\d+)|-(\d+)/.exec(t.slice(1).join(' '));
        return { kind: c, max: m ? Number(m[1] || m[2]) : 10, n: 0, buf: [] };
      }
      if (c === 'wc') return { kind: 'wc', n: 0 };
      if (c === 'sort') return { kind: 'sort', buf: [], rev: t.includes('-r') };
      if (c === 'uniq') return { kind: 'uniq', last: null };
      return { kind: 'bad', name: c };
    });
    const bad = st.find((x) => x.kind === 'bad');
    if (bad) return { error: bad.name + ': command not found' };
    const push = (k, line, cls) => {
      if (k >= st.length) { io.out(line, cls); return; }
      const s = st[k];
      if (s.kind === 'grep') { const hit = s.re.test(line) !== s.inv; if (hit) { s.n++; if (!s.count) push(k + 1, line, cls); } return; }
      if (s.kind === 'head') { if (s.n++ < s.max) push(k + 1, line, cls); return; }
      if (s.kind === 'tail' || s.kind === 'sort') { s.buf.push(line); return; }
      if (s.kind === 'wc') { s.n++; return; }
      if (s.kind === 'uniq') { if (line !== s.last) push(k + 1, line, cls); s.last = line; }
    };
    const flush = (k) => {
      for (let i = k; i < st.length; i++) {
        const s = st[i];
        if (s.kind === 'tail') { const b = s.buf.slice(-s.max); s.buf = []; for (const l of b) push(i + 1, l); }
        if (s.kind === 'sort') { const b = s.buf.slice().sort(); if (s.rev) b.reverse(); s.buf = []; for (const l of b) push(i + 1, l); }
        if (s.kind === 'wc') { push(i + 1, String(s.n)); s.n = 0; }
        if (s.kind === 'grep' && s.count) { push(i + 1, String(s.n)); s.n = 0; }
      }
    };
    let flushed = false;
    const end = () => { if (flushed) return; flushed = true; flush(0); };
    return { io: Object.assign({}, io, { out: (l, cls) => { for (const x of String(l).split('\n')) push(0, x, cls); }, done: () => { end(); io.done(); } }), end };
  }

  function exec(dev, s, line, io) {
    const raw = String(line).trim();
    if (!raw) return null;
    if (!s.history) s.history = [];
    s.history.push(raw);
    if (s.history.length > 200) s.history.shift();
    const parts = splitPipes(raw);
    let run = io;
    let end = null;
    if (parts.length > 1) {
      const p = pipeIo(io, parts.slice(1));
      if (p.error) { io.out(p.error); return null; }
      run = p.io;
      end = p.end;
    }
    const job = command(dev, s, parts[0], run);
    if (end && (!job || job.done)) end();
    return job;
  }

  function command(d, s, line, io) {
    let t = tokenize(line);
    while (t[0] === 'sudo' || t[0] === 'doas') t = t.slice(1);
    if (!t.length) return null;
    const cmd = t[0];
    const a = t.slice(1);
    const mutate = (fn) => io.mutate(fn);
    switch (cmd) {
      case 'help': HELP.forEach((l) => io.out(l)); return null;
      case 'clear': case 'reset': io.clear(); return null;
      case 'exit': case 'logout': io.out('logout'); io.out('(это локальный терминал — закройте окно, чтобы выйти)', 'hint'); return null;
      case 'history': s.history.forEach((h, i) => io.out(padL(i + 1, 5) + '  ' + h)); return null;
      case 'whoami': io.out('root'); return null;
      case 'id': io.out('uid=0(root) gid=0(root) groups=0(root)'); return null;
      case 'pwd': io.out('/root'); return null;
      case 'cd': return null;
      case 'ls': {
        if (a.includes('/etc')) { io.out('hostname  hosts  network  os-release  resolv.conf'); return null; }
        io.out((d.files || []).map((f) => f.name).join('  '));
        return null;
      }
      case 'hostname':
        if (a[0] === '-I') io.out(d.iface.ip != null ? ip(d.iface.ip) + ' ' : '');
        else if (a[0] && !a[0].startsWith('-')) io.out('hostname: в NetLab имя меняется на схеме (переименуйте устройство)');
        else io.out(hostName(d));
        return null;
      case 'hostnamectl': io.out(' Static hostname: ' + hostName(d)); io.out('Operating System: NetLab Linux 1.4'); io.out('          Kernel: Linux 6.1.0-netlab'); return null;
      case 'uname': io.out(a.includes('-a') ? 'Linux ' + hostName(d) + ' 6.1.0-netlab #1 SMP PREEMPT_DYNAMIC NetLab x86_64 GNU/Linux' : a.includes('-r') ? '6.1.0-netlab' : 'Linux'); return null;
      case 'date': io.out(new Date().toString()); return null;
      case 'uptime': { const m = Math.floor(d.net.time / 6000); io.out(' ' + new Date().toTimeString().slice(0, 8) + ' up ' + (m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : m + ' min') + ',  1 user,  load average: 0.00, 0.01, 0.00'); return null; }
      case 'cat': if (!a[0]) { io.out('cat: в NetLab нужен файл: cat /etc/resolv.conf'); return null; } for (const f of a) catFile(d, f, io); return null;
      case 'echo': echo(d, line.replace(/^\s*(sudo\s+)+/, ''), io, mutate); return null;
      case 'ip': ipCmd(d, a, io, mutate); return null;
      case 'ifconfig': ifconfig(d, a, io, mutate); return null;
      case 'route':
        if (a[0] === 'add' && a.includes('default')) { const gi = a.indexOf('gw'); setGateway(d, U.parseIp(a[gi + 1] || ''), io, mutate); return null; }
        if (a[0] === 'del' && a.includes('default')) { setGateway(d, null, io, mutate); return null; }
        routeN(d, io);
        return null;
      case 'arp':
        io.out(pad('Address', 25) + pad('HWtype', 8) + pad('HWaddress', 20) + pad('Flags Mask', 16) + 'Iface');
        for (const [a2, e] of d.arp) io.out(pad(ip(a2), 25) + pad('ether', 8) + pad(String(e.mac).toLowerCase(), 20) + pad('C', 16) + ifName(d));
        return null;
      case 'dhclient': return dhclient(d, a, io, mutate);
      case 'ping': return ping(d, a, io);
      case 'traceroute': case 'tracepath': return traceroute(d, a, io);
      case 'nslookup': case 'dig': case 'host': return dnsCmd(d, cmd, a, io);
      case 'curl': return curl(d, a, io);
      case 'wget': return wget(d, a, io);
      case 'nc': case 'ncat': case 'netcat': return nc(d, a, io);
      case 'ss': ss(d, a, io, false); return null;
      case 'netstat': ss(d, a, io, true); return null;
      case 'ssh': {
        let user = 'root';
        let host = null;
        for (let k = 0; k < a.length; k++) {
          if (a[k] === '-l') user = a[++k];
          else if (a[k] === '-p') k++;
          else if (!a[k].startsWith('-')) { const m = /^(?:([^@]+)@)?(.+)$/.exec(a[k]); if (m[1]) user = m[1]; host = m[2]; }
        }
        if (!host) { io.out('usage: ssh [-l login_name] [user@]hostname'); return null; }
        return NS.cliIos.startRemote(d, s, io, 'ssh', host, user);
      }
      case 'telnet': if (!a[0]) { io.out('usage: telnet host'); return null; } return NS.cliIos.startRemote(d, s, io, 'telnet', a[0], null);
      case 'iptables': return iptables(d, a, io, mutate);
      case 'iptables-save': {
        io.out('# Generated by iptables-save v1.8.9 (NetLab)');
        io.out('*filter');
        const T = iptOf(d);
        for (const c of CHAINS) io.out(':' + c + ' ' + T[c].policy + ' [0:0]');
        for (const c of CHAINS) for (const r of T[c].rules) io.out('-A ' + c + ' ' + ruleSpec(r));
        io.out('COMMIT');
        return null;
      }
      case 'tcpdump': return tcpdump(d, a, io);
      case 'systemctl': return systemctl(d, a[0], a[1], io, mutate), null;
      case 'service': return systemctl(d, a[1] || 'status', a[0], io, mutate), null;
      case 'sysctl': {
        const x = a.filter((y) => !y.startsWith('-'))[0] || '';
        if (/=/.test(x)) { io.out('sysctl: NetLab: компьютер не пересылает чужие пакеты — для маршрутизации используйте маршрутизатор'); return null; }
        if (!x || a.includes('-a')) { io.out('net.ipv4.ip_forward = 0'); io.out('net.ipv4.icmp_echo_ignore_all = 0'); return null; }
        io.out(x === 'net.ipv4.ip_forward' || x === 'net.ipv4.icmp_echo_ignore_all' ? x + ' = 0' : 'sysctl: cannot stat /proc/sys/' + x.replace(/\./g, '/') + ': No such file or directory');
        return null;
      }
      case 'apt': case 'apt-get': case 'yum': case 'dnf':
        io.out('E: NetLab: установка пакетов не нужна — всё нужное уже есть (help — список команд).');
        return null;
      case 'nano': case 'vi': case 'vim':
        io.out(cmd + ': редактор в терминале NetLab не поддерживается — используйте «Text Editor» на рабочем столе или echo "…" > файл');
        return null;
      default:
        io.out(cmd + ': command not found');
        return null;
    }
  }

  function complete(line) {
    const t = tokenize(line);
    if (t.length !== 1 || /\s$/.test(line)) return line;
    const c = COMMANDS.filter((x) => x.startsWith(t[0]));
    return c.length === 1 ? c[0] + ' ' : line;
  }

  /* ================= подключение к общей командной строке ================= */

  const C = NS.cli;
  const basePrompt = C.prompt;
  const baseExec = C.exec;
  const baseComplete = C.complete;
  C.prompt = function (dev, s) {
    if (isLinux(dev) && s && !s.remote && !s.pending) return 'root@' + hostName(dev) + ':~# ';
    return basePrompt.apply(this, arguments);
  };
  C.exec = function (dev, s, line, io) {
    if (!isLinux(dev) || s.remote || s.pending) return baseExec.apply(this, arguments);
    const safe = { out: io.out, write: io.write || ((t) => io.out(t)), clear: io.clear || (() => {}), done: io.done || (() => {}), mutate: io.mutate || ((fn) => fn()) };
    if (!dev.power) { safe.out('Устройство выключено.'); return null; }
    try { return exec(dev, s, line, safe); } catch (e) { console.error(e); safe.out('bash: внутренняя ошибка: ' + e.message); return null; }
  };
  if (baseComplete) {
    C.complete = function (dev, s, line) {
      if (isLinux(dev) && s && !s.remote && !s.pending) return complete(line);
      return baseComplete.apply(this, arguments);
    };
  }

  NS.deviceExt.push({
    key: 'linux',
    applies: canLinux,
    save(d) {
      if (d.os !== 'linux') return null;
      const T = d.ipt;
      const ser = (r) => Object.assign({}, r, { s: r.s ? cidrStr(r.s) : undefined, d: r.d ? cidrStr(r.d) : undefined, pk: undefined, by: undefined });
      return { os: 'linux', ipt: T ? Object.fromEntries(CHAINS.map((c) => [c, { policy: T[c].policy, rules: T[c].rules.map(ser) }])) : null };
    },
    load(d, c) {
      d.os = c && c.os === 'linux' ? 'linux' : undefined;
      d.ipt = null;
      d.iptCt = null;
      if (c && c.ipt) {
        const T = iptOf(d);
        for (const ch of CHAINS) {
          const x = c.ipt[ch];
          if (!x) continue;
          T[ch].policy = x.policy === 'DROP' ? 'DROP' : 'ACCEPT';
          T[ch].rules = (x.rules || []).map((r) => Object.assign({}, r, { s: r.s ? parseCidr(r.s) : undefined, d: r.d ? parseCidr(r.d) : undefined }));
        }
      }
    },
  });

  NS.linux = { isLinux, canLinux, ifName, hostName, verdict, compileFilter, tdLine, iptOf, setOs(d, os) { d.os = os === 'linux' ? 'linux' : undefined; } };
})(globalThis.NetLab = globalThis.NetLab || {});
