/* NetLab — безопасность IOS, часть 2:
 *  • уровни привилегий: privilege exec|configure|interface|line [all] level N <команда>, enable secret level N,
 *    enable N / disable N, show privilege; username … privilege N — вход сразу на свой уровень;
 *  • parser view (Role-Based CLI): enable view [ИМЯ], parser view, secret, commands … include [all], show parser view;
 *  • защита входа: login block-for … attempts … within …, login quiet-mode access-class, login on-failure / on-success log,
 *    show login [failures]; security passwords min-length;
 *  • IP Source Guard: ip verify source [port-security], ip source binding, show ip verify source;
 *  • storm-control broadcast|multicast|unicast level [pps|bps] …, storm-control action shutdown|trap, show storm-control. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const X = NS.cliIos.ext;
  const Switch = NS.Switch;
  const isIosDev = (d) => !!d.ios && (d.type === 'router' || d.type === 'switch');
  const isSw = (d) => d.type === 'switch';

  /* ================= уровни привилегий и parser view ================= */

  function privCfg(dev) {
    if (!dev.privCfg) dev.privCfg = { rules: [], secrets: {}, views: {} };
    return dev.privCfg;
  }
  const lvl = (s) => (s.priv != null ? s.priv : s.mode === 'user' ? 1 : 15);
  function setLevel(s, n) { s.priv = n >= 15 ? undefined : n; s.mode = n <= 1 ? 'user' : 'exec'; }

  const match = (words, cmd, kw) => {
    const n = Math.min(words.length, cmd.length);
    if (!n) return false;
    for (let i = 0; i < n; i++) if (!(kw(cmd[i], words[i], 1) || String(cmd[i]).toLowerCase() === String(words[i]).toLowerCase())) return false;
    return true;
  };

  // команды уровня 1 (как в user EXEC)
  const LEVEL1 = ['enable', 'disable', 'exit', 'logout', 'quit', 'ping', 'traceroute', 'telnet', 'ssh', 'terminal', 'connect'];
  const LEVEL1_SHOW = ['version', 'clock', 'users', 'privilege', 'history', 'interfaces', 'ip', 'cdp', 'lldp', 'arp', 'flash', 'sessions', 'hosts', 'ntp', 'parser', 'login'];
  function baseAllowed(t, kw) {
    if (LEVEL1.some((w) => kw(t[0], w, w === 'exit' ? 3 : 2))) return true;
    if (kw(t[0], 'show', 2)) {
      if (!t[1]) return true;
      if (kw(t[1], 'running-config', 3) || kw(t[1], 'startup-config', 3)) return false;
      return LEVEL1_SHOW.some((w) => kw(t[1], w, 2));
    }
    return false;
  }
  const modeOf = (s) => (s.mode === 'exec' || s.mode === 'user' ? 'exec' : s.mode === 'if' ? 'interface' : s.mode === 'line' ? 'line' : 'configure');

  X.authorize.push((dev, s, t, io, line, C) => {
    if (!isIosDev(dev) || s.pending) return true;
    const cfg = dev.privCfg;
    let mode = modeOf(s);
    let words = t;
    if (mode !== 'exec' && C.kw(t[0], 'do', 2)) { mode = 'exec'; words = t.slice(1); }
    if (mode !== 'exec' && (C.kw(words[0], 'exit', 3) || C.kw(words[0], 'end', 2))) return true;
    if (s.view && s.view !== 'root') {
      const v = cfg && cfg.views[s.view];
      if (mode === 'exec' && (['enable', 'disable', 'exit', 'logout', 'quit'].some((w) => C.kw(words[0], w, 2)) || (C.kw(words[0], 'show', 2) && C.kw(words[1], 'parser', 2)))) return true;
      if (v && v.cmds.some((c) => c.mode === mode && match(c.words, words, C.kw))) return true;
      io.out("% Invalid input detected at '^' marker.");
      io.out('  (команда не входит в parser view «' + s.view + '»)', 'hint');
      return false;
    }
    const L = lvl(s);
    if (L >= 15 || s.mode === 'user') return true;
    if (mode === 'exec' && baseAllowed(words, C.kw)) return true;
    if (cfg && cfg.rules.some((r) => r.mode === mode && r.level <= L && match(r.words, words, C.kw))) return true;
    io.out("% Invalid input detected at '^' marker.");
    io.out('  (команда недоступна на уровне привилегий ' + L + ')', 'hint');
    return false;
  });

  function enableView(dev, s, name, io, C) {
    if (!(dev.aaa && dev.aaa.newModel)) { io.out('% AAA must be configured.'); return; }
    const cfg = privCfg(dev);
    if (!name) {
      if (!dev.hasEnablePassword()) { io.out('% No password set'); return; }
      C.askPassword(s, io, (pw) => dev.checkEnable(pw), () => {
        s.view = 'root'; s.priv = undefined; s.mode = 'exec';
        io.out("%PARSER-6-VIEW_SWITCH: successfully set to view 'root'.");
      }, '% Bad secrets');
      return;
    }
    const v = cfg.views[name];
    if (!v || !v.secret) { io.out('% Invalid view name ' + name); return; }
    C.askPassword(s, io, (pw) => U.secretHash(String(pw)) === v.secret, () => {
      s.view = name; s.priv = undefined; s.mode = 'exec';
      io.out("%PARSER-6-VIEW_SWITCH: successfully set to view '" + name + "'.");
    }, '% Bad secrets');
  }

  X.exec.push((dev, s, t, io, line, C) => {
    if (!isIosDev(dev)) return null;
    if (C.kw(t[0], 'enable', 2)) {
      if (C.kw(t[1], 'view', 1)) { enableView(dev, s, t[2], io, C); return { handled: true }; }
      const n = t[1] != null ? Number(t[1]) : 15;
      if (t[1] != null && !(Number.isInteger(n) && n >= 0 && n <= 15)) { C.invalid(io, t[1]); return { handled: true }; }
      if (n <= lvl(s) && !s.view) { setLevel(s, n); return { handled: true }; }
      if (n === 15) {
        s.view = undefined;
        if (s.mode === 'user') { s.priv = undefined; return null; } // обычный enable
        if (!dev.hasEnablePassword()) { if (s.via === 'vty') io.out('% No password set'); else setLevel(s, 15); return { handled: true }; }
        C.askPassword(s, io, (pw) => dev.checkEnable(pw), () => setLevel(s, 15), '% Bad secrets');
        return { handled: true };
      }
      const sec = dev.privCfg && dev.privCfg.secrets[n];
      if (!sec) { io.out('% No password set'); return { handled: true }; }
      C.askPassword(s, io, (pw) => U.secretHash(String(pw)) === sec, () => { s.view = undefined; setLevel(s, n); }, '% Bad secrets');
      return { handled: true };
    }
    if (C.kw(t[0], 'disable', 4)) {
      const n = t[1] != null ? Number(t[1]) : 1;
      if (!(Number.isInteger(n) && n >= 0 && n <= 15)) { C.invalid(io, t[1]); return { handled: true }; }
      s.view = undefined;
      setLevel(s, Math.min(n, lvl(s)));
      return { handled: true };
    }
    if (C.kw(t[0], 'show', 2) && C.kw(t[1], 'privilege', 3)) { io.out('Current privilege level is ' + lvl(s)); return { handled: true }; }
    if (C.kw(t[0], 'show', 2) && C.kw(t[1], 'parser', 2) && C.kw(t[2], 'view', 1)) {
      const cfg = privCfg(dev);
      if (C.kw(t[3], 'all', 1)) {
        if (s.view !== 'root') { io.out('% Command is available only in root view'); return { handled: true }; }
        io.out('Views/SuperViews Present in System:');
        for (const n of Object.keys(cfg.views)) io.out(' ' + n);
        io.out('-------(*) represent superview-------');
        return { handled: true };
      }
      io.out(s.view ? "Current view is '" + s.view + "'" : 'No view is active ! Currently in Privilege Level Context');
      return { handled: true };
    }
    return null;
  });

  function parseCmdRule(a, i, C) {
    // [all] level N <cmd…>  |  [all] reset <cmd…>
    let all = false;
    if (C.kw(a[i], 'all', 2)) { all = true; i++; }
    if (C.kw(a[i], 'reset', 1)) return { reset: true, all, words: a.slice(i + 1) };
    if (!C.kw(a[i], 'level', 1)) return null;
    const level = Number(a[i + 1]);
    if (!(Number.isInteger(level) && level >= 0 && level <= 15)) return null;
    return { level, all, words: a.slice(i + 2) };
  }
  const MODES = { exec: 'exec', configure: 'configure', interface: 'interface', line: 'line' };
  const modeKw = (w, C) => Object.keys(MODES).find((m) => C.kw(w, m, 3));

  X.global.push((t) => /^(parser|security)$/i.test(t[0] || ''));

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isIosDev(dev)) return false;
    const cfg = privCfg(dev);
    if (C.kw(a[0], 'privilege', 4)) {
      const m = modeKw(a[1], C);
      if (!m) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return true; }
      const r = parseCmdRule(a, 2, C);
      if (!r || !r.words.length) { C.incomplete(io); return true; }
      const same = (x) => x.mode === m && x.words.join(' ').toLowerCase() === r.words.join(' ').toLowerCase();
      C.withMutate(io, () => {
        cfg.rules = cfg.rules.filter((x) => !same(x));
        if (!neg && !r.reset) cfg.rules.push({ mode: m, level: r.level, all: r.all, words: r.words });
      });
      return true;
    }
    // enable secret|password level N [0|5] X
    if (C.kw(a[0], 'enable', 2) && (C.kw(a[1], 'secret', 1) || C.kw(a[1], 'password', 1)) && C.kw(a[2], 'level', 1)) {
      const n = Number(a[3]);
      if (!(Number.isInteger(n) && n >= 1 && n <= 15)) { C.invalid(io, a[3]); return true; }
      if (neg) { C.withMutate(io, () => { delete cfg.secrets[n]; }); return true; }
      let pw = a[4];
      let hashed = false;
      if ((pw === '0' || pw === '5') && a[5] != null) { hashed = pw === '5'; pw = a[5]; }
      if (pw == null) { C.incomplete(io); return true; }
      if (!hashed && tooShort(dev, pw, io)) return true;
      C.withMutate(io, () => { cfg.secrets[n] = hashed ? pw : U.secretHash(String(pw)); });
      return true;
    }
    if (C.kw(a[0], 'parser', 3) && C.kw(a[1], 'view', 1)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return true; }
      if (s.view !== 'root') { io.out('% No view is active ! Currently in Privilege Level Context'); io.out('  (сначала: aaa new-model и enable view)', 'hint'); return true; }
      if (neg) { C.withMutate(io, () => { delete cfg.views[name]; }); return true; }
      if (!cfg.views[name]) {
        C.withMutate(io, () => { cfg.views[name] = { secret: null, cmds: [] }; });
        io.out("Report: Successfully created the parser view '" + name + "'");
      }
      s.mode = 'parser-view';
      s.ctx = name;
      return true;
    }
    return false;
  });

  X.modes['parser-view'] = {
    prompt: () => '(config-view)#',
    tree: ['secret WORD', 'commands exec include WORD', 'commands exec include all WORD', 'commands configure include WORD', 'commands interface include WORD'],
    run(dev, s, t, io, C) {
      const v = privCfg(dev).views[s.ctx];
      if (!v) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'secret', 1)) {
        let pw = a[1];
        let hashed = false;
        if ((pw === '0' || pw === '5') && a[2] != null) { hashed = pw === '5'; pw = a[2]; }
        if (neg) { C.withMutate(io, () => { v.secret = null; }); return; }
        if (pw == null) { C.incomplete(io); return; }
        C.withMutate(io, () => { v.secret = hashed ? pw : U.secretHash(String(pw)); });
        return;
      }
      if (C.kw(a[0], 'commands', 1)) {
        const m = modeKw(a[1], C);
        if (!m) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return; }
        if (!C.kw(a[2], 'include', 2) && !C.kw(a[2], 'include-exclusive', 9)) { C.invalid(io, a[2]); return; }
        let i = 3;
        let all = false;
        if (C.kw(a[i], 'all', 2)) { all = true; i++; }
        const words = a.slice(i);
        if (!words.length) { C.incomplete(io); return; }
        if (!v.secret) { io.out('% Password not set for view ' + s.ctx); return; }
        const same = (x) => x.mode === m && x.words.join(' ').toLowerCase() === words.join(' ').toLowerCase();
        C.withMutate(io, () => { v.cmds = v.cmds.filter((x) => !same(x)); if (!neg) v.cmds.push({ mode: m, all, words }); });
        return;
      }
      C.invalid(io, a[0]);
    },
  };

  /* ================= защита входа ================= */

  function loginCfg(dev) {
    if (!dev.loginSec) dev.loginSec = { blockFor: 0, attempts: 0, within: 0, quietAcl: null, logFail: false, logOk: false, delay: 0 };
    return dev.loginSec;
  }
  const loginRt = (dev) => { if (!dev.loginRt) dev.loginRt = { fails: [], total: 0, quietUntil: 0, timer: null }; return dev.loginRt; };
  const stamp = (dev) => (dev.clock ? dev.clock().replace(/\.\d+ UTC/, ' UTC') : '');
  const quiet = (dev) => !!dev.loginRt && dev.loginRt.quietUntil > dev.net.time;

  X.loginEvent.push((dev, s, ok, user) => {
    if (!isIosDev(dev)) return;
    const c = dev.loginSec;
    if (!c) return;
    const src = s.remoteIp != null ? U.ipStr(s.remoteIp) : '0.0.0.0';
    const port = s.via === 'vty' ? (s.proto === 'ssh' ? 22 : 23) : 0;
    const who = '[user: ' + (user || '') + '] [Source: ' + src + '] [localport: ' + port + ']';
    if (ok) {
      if (c.logOk && dev.iosLog) dev.iosLog('SEC_LOGIN', 5, 'LOGIN_SUCCESS', 'Login Success ' + who + ' at ' + stamp(dev));
      return;
    }
    const rt = loginRt(dev);
    rt.total++;
    if (c.logFail && dev.iosLog) dev.iosLog('SEC_LOGIN', 4, 'LOGIN_FAILED', 'Login failed ' + who + ' [Reason: Login Authentication Failed] at ' + stamp(dev));
    if (!c.blockFor || s.via !== 'vty') return;
    const now = dev.net.time;
    rt.fails = rt.fails.filter((x) => now - x < c.within * 100).concat([now]);
    if (rt.fails.length >= c.attempts && !quiet(dev)) {
      rt.quietUntil = now + c.blockFor * 100;
      rt.fails = [];
      if (dev.iosLog) dev.iosLog('SEC_LOGIN', 1, 'QUIET_MODE_ON', 'Still timeleft for watching failures is ' + c.within + ' secs, ' + who + ' [Reason: Login Authentication Failed] [ACL: ' + (c.quietAcl || 'sl_def_acl') + '] at ' + stamp(dev));
      if (rt.timer) rt.timer.cancel();
      rt.timer = dev.timer(c.blockFor * 100, () => {
        rt.timer = null;
        if (dev.iosLog) dev.iosLog('SEC_LOGIN', 5, 'QUIET_MODE_OFF', 'Quiet Mode is OFF, because block period timed out at ' + stamp(dev));
      });
    }
  });

  X.vtyGate.push((dev, conn) => {
    if (!isIosDev(dev) || !quiet(dev)) return null;
    const c = dev.loginSec;
    if (c.quietAcl) {
      const acl = dev.acls.get(c.quietAcl);
      if (acl && acl.check({ src: conn.rip, dst: conn.lip, proto: 'TCP', payload: { sport: conn.rport, dport: conn.lport, flags: 'SYN' } }).permit) return null;
    }
    const left = Math.ceil((dev.loginRt.quietUntil - dev.net.time) / 100);
    return '% Connection refused by remote host (login block-for: вход заблокирован ещё на ' + left + ' с после неудачных попыток)';
  });

  function tooShort(dev, pw, io) {
    const n = dev.minPassLen || 0;
    if (!n || String(pw).length >= n) return false;
    io.out('% Password too short - must be at least ' + n + ' characters. Password configuration failed');
    return true;
  }

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isIosDev(dev)) return false;
    if (C.kw(a[0], 'security', 3) && C.kw(a[1], 'passwords', 1)) {
      if (!C.kw(a[2], 'min-length', 1)) { if (a[2]) C.invalid(io, a[2]); else C.incomplete(io); return true; }
      const n = Number(a[3]);
      if (!neg && !(Number.isInteger(n) && n >= 0 && n <= 16)) { if (a[3]) C.invalid(io, a[3]); else C.incomplete(io); return true; }
      C.withMutate(io, () => { dev.minPassLen = neg ? 0 : n; });
      return true;
    }
    // проверка длины новых паролей (дальше команда выполняется как обычно)
    if (!neg && C.kw(a[0], 'enable', 2) && (C.kw(a[1], 'secret', 1) || C.kw(a[1], 'password', 1))) {
      const pw = (a[2] === '0' || a[2] === '5' || a[2] === '7') && a[3] != null ? (a[2] === '0' ? a[3] : null) : a[2];
      if (pw != null && tooShort(dev, pw, io)) return true;
      return false;
    }
    if (!neg && C.kw(a[0], 'username', 2)) {
      const i = a.findIndex((x, k) => k > 1 && (C.kw(x, 'secret', 1) || C.kw(x, 'password', 1)));
      if (i > 0) {
        const pw = (a[i + 1] === '0' || a[i + 1] === '5' || a[i + 1] === '7') && a[i + 2] != null ? (a[i + 1] === '0' ? a[i + 2] : null) : a[i + 1];
        if (pw != null && tooShort(dev, pw, io)) return true;
      }
      return false;
    }
    if (C.kw(a[0], 'login', 3)) {
      const c = loginCfg(dev);
      if (C.kw(a[1], 'block-for', 1)) {
        if (neg) { C.withMutate(io, () => { Object.assign(c, { blockFor: 0, attempts: 0, within: 0 }); }); return true; }
        const b = Number(a[2]);
        const at = a.findIndex((x) => C.kw(x, 'attempts', 1));
        const wi = a.findIndex((x) => C.kw(x, 'within', 1));
        const n = at > 0 ? Number(a[at + 1]) : NaN;
        const w = wi > 0 ? Number(a[wi + 1]) : NaN;
        if (!(b >= 1 && b <= 65535 && n >= 1 && n <= 65535 && w >= 1 && w <= 65535)) { C.incomplete(io); return true; }
        C.withMutate(io, () => { Object.assign(c, { blockFor: b, attempts: n, within: w }); });
        return true;
      }
      if (C.kw(a[1], 'quiet-mode', 1)) {
        if (!C.kw(a[2], 'access-class', 1)) { C.invalid(io, a[2]); return true; }
        C.withMutate(io, () => { c.quietAcl = neg ? null : a[3] || null; });
        return true;
      }
      if (C.kw(a[1], 'on-failure', 4)) { C.withMutate(io, () => { c.logFail = !neg; }); return true; }
      if (C.kw(a[1], 'on-success', 4)) { C.withMutate(io, () => { c.logOk = !neg; }); return true; }
      if (C.kw(a[1], 'delay', 1)) { C.withMutate(io, () => { c.delay = neg ? 0 : Number(a[2]) || 1; }); return true; }
      return false;
    }
    return false;
  });

  X.line.push((dev, s, a, neg, io) => (!neg && /^pas/i.test(a[0] || '') && a[1] != null && a[1] !== '7' ? tooShort(dev, a[1], io) : false));

  /* ================= IP Source Guard и storm-control (коммутатор) ================= */

  function ipsgPass(dev, i, port, frame) {
    if (!port.ipsg || port.snoopTrust || frame.type !== 'IPv4' || !frame.payload) return true;
    const pkt = frame.payload;
    const l4 = pkt.payload || {};
    if (pkt.src === 0 && pkt.proto === 'UDP' && l4.sport === 68 && l4.dport === 67) return true; // DHCP до получения адреса
    const bind = [];
    if (dev.snoopRt) for (const b of dev.snoopRt.bindings.values()) if (b.port === i) bind.push(b);
    for (const b of dev.ipsgStatic || []) if (b.port === port.name) bind.push(b);
    const ok = bind.some((b) => b.ip === pkt.src && (port.ipsg !== 'ip-mac' || String(b.mac).toLowerCase() === String(frame.src).toLowerCase()));
    if (ok) return true;
    dev.drop(frame, 'IP Source Guard: адрес ' + U.ipStr(pkt.src) + (port.ipsg === 'ip-mac' ? ' с MAC ' + frame.src : '') + ' не выдан порту ' + port.name + ' (нет привязки DHCP snooping или ip source binding)');
    return false;
  }

  const kindOf = (frame) => (U.isBroadcastMac(frame.dst) ? 'broadcast' : U.isMulticastMac(frame.dst) ? 'multicast' : 'unicast');
  const frameBytes = (frame) => Math.max(64, NS.packets.sizeOf(frame));

  function stormPass(dev, i, port, frame) {
    const sc = port.storm;
    if (!sc) return true;
    const k = kindOf(frame);
    const lim = sc[k];
    if (!lim) return true;
    if (!port.stormRt) port.stormRt = {};
    const now = dev.net.time;
    const r = port.stormRt[k] || (port.stormRt[k] = { start: now, pkts: 0, bytes: 0, blocked: false, last: 0 });
    if (now - r.start >= 100) { r.last = lim.unit === 'pps' ? r.pkts : lim.unit === 'bps' ? r.bytes * 8 : (r.bytes * 8) / ((port.speed || 100) * 1e6) * 100; Object.assign(r, { start: now, pkts: 0, bytes: 0, blocked: false }); }
    r.pkts++;
    r.bytes += frameBytes(frame);
    const level = lim.unit === 'pps' ? r.pkts : lim.unit === 'bps' ? r.bytes * 8 : (r.bytes * 8) / ((port.speed || 100) * 1e6) * 100;
    if (level <= lim.level && !r.blocked) return true;
    const first = !r.blocked;
    r.blocked = true;
    const sp = NS.cliIos.ctx ? NS.cliIos.ctx.shortIf(port.name) : port.name;
    if (sc.action === 'shutdown') {
      port.errDisabled = true;
      port.errReason = 'storm-control';
      if (dev.iosLog) dev.iosLog('PM', 4, 'ERR_DISABLE', 'storm-control error detected on ' + sp + ', putting ' + sp + ' in err-disable state');
      dev.drop(frame, 'Storm control: превышен порог ' + k + '-трафика на ' + port.name + ' — порт в err-disabled');
      dev.timer(0, () => dev.net.refreshTopology());
      return false;
    }
    if (first && sc.action === 'trap' && dev.iosLog) dev.iosLog('STORM_CONTROL', 3, 'FILTERED', 'A packet storm was detected on ' + sp + '. A packet filter action has been applied on the interface.');
    dev.drop(frame, 'Storm control: порог ' + k + '-трафика на ' + port.name + ' превышен — кадр отброшен до конца секунды');
    return false;
  }

  Switch.ingress.push(function (i, port, vlan, frame) {
    if (!stormPass(this, i, port, frame)) return false;
    return ipsgPass(this, i, port, frame);
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (!isSw(dev)) return false;
    const ports = targets.filter((r) => r.kind === 'port' && r.sub == null).map((r) => dev.ports[r.port]);
    if (C.kw(a[0], 'ip', 1) && C.kw(a[1], 'verify', 1)) {
      if (!C.kw(a[2], 'source', 1)) { if (a[2]) C.invalid(io, a[2]); else C.incomplete(io); return true; }
      const mode = C.kw(a[3], 'port-security', 1) ? 'ip-mac' : 'ip';
      C.withMutate(io, () => { for (const p of ports) { if (neg) delete p.ipsg; else p.ipsg = mode; } });
      return true;
    }
    if (C.kw(a[0], 'storm-control', 3)) {
      if (C.kw(a[1], 'action', 1)) {
        const act = C.kw(a[2], 'shutdown', 1) ? 'shutdown' : C.kw(a[2], 'trap', 1) ? 'trap' : null;
        if (!act && !neg) { if (a[2]) C.invalid(io, a[2]); else C.incomplete(io); return true; }
        C.withMutate(io, () => { for (const p of ports) { p.storm = p.storm || {}; if (neg) delete p.storm.action; else p.storm.action = act; } });
        return true;
      }
      const k = ['broadcast', 'multicast', 'unicast'].find((x) => C.kw(a[1], x, 1));
      if (!k) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { for (const p of ports) if (p.storm) { delete p.storm[k]; if (!Object.keys(p.storm).filter((x) => x !== 'action').length) delete p.storm; } }); return true; }
      if (!C.kw(a[2], 'level', 1)) { if (a[2]) C.invalid(io, a[2]); else C.incomplete(io); return true; }
      let unit = '%';
      let v = a[3];
      if (C.kw(a[3], 'pps', 1) || C.kw(a[3], 'bps', 1)) { unit = a[3].toLowerCase().startsWith('p') ? 'pps' : 'bps'; v = a[4]; }
      const m = /^(\d+(?:\.\d+)?)([kmg])?$/i.exec(String(v || ''));
      if (!m) { if (v) C.invalid(io, v); else C.incomplete(io); return true; }
      let level = Number(m[1]) * ({ k: 1e3, m: 1e6, g: 1e9 }[String(m[2] || '').toLowerCase()] || 1);
      if (unit === '%' && level > 100) { C.invalid(io, v); return true; }
      if (unit === '%') level = Math.round(level * 100) / 100;
      C.withMutate(io, () => { for (const p of ports) { p.storm = p.storm || {}; p.storm[k] = { unit, level }; } });
      return true;
    }
    return false;
  });

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isSw(dev) || !C.kw(a[0], 'ip', 1) || !C.kw(a[1], 'source', 2) || !C.kw(a[2], 'binding', 1)) return false;
    // ip source binding MAC vlan V IP interface IF
    const mac = String(a[3] || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    const vi = a.findIndex((x) => C.kw(x, 'vlan', 1));
    const ii = a.findIndex((x) => C.kw(x, 'interface', 1));
    const ipv = vi > 0 ? U.parseIp(a[vi + 2] || '') : null;
    const r = ii > 0 ? NS.cliIos.parseIfName(dev, a.slice(ii + 1).join('')) : null;
    const port = r && r.kind === 'port' ? dev.ports[r.port] : null;
    if (mac.length !== 12 || ipv == null || !port) { C.incomplete(io); return true; }
    const macStr = mac.match(/../g).join(':').toUpperCase();
    C.withMutate(io, () => {
      dev.ipsgStatic = (dev.ipsgStatic || []).filter((b) => !(b.mac === macStr && b.port === port.name));
      if (!neg) dev.ipsgStatic.push({ mac: macStr, vlan: Number(a[vi + 1]) || 1, ip: ipv, port: port.name });
    });
    return true;
  });

  X.running.iface.push((dev, f, p) => {
    if (!p || !isSw(dev)) return [];
    const L = [];
    if (p.ipsg) L.push(' ip verify source' + (p.ipsg === 'ip-mac' ? ' port-security' : ''));
    if (p.storm) {
      for (const k of ['broadcast', 'multicast', 'unicast']) {
        const x = p.storm[k];
        if (x) L.push(' storm-control ' + k + ' level ' + (x.unit === '%' ? x.level.toFixed(2) : x.unit + ' ' + x.level));
      }
      if (p.storm.action) L.push(' storm-control action ' + p.storm.action);
    }
    return L;
  });

  X.running.global.push((dev) => {
    if (!isIosDev(dev)) return [];
    const L = [];
    const c = dev.privCfg;
    if (dev.minPassLen) L.push('security passwords min-length ' + dev.minPassLen);
    if (c) for (const [n, h] of Object.entries(c.secrets)) L.push('enable secret level ' + n + ' 5 ' + h);
    const lc = dev.loginSec;
    if (lc) {
      if (lc.blockFor) L.push('login block-for ' + lc.blockFor + ' attempts ' + lc.attempts + ' within ' + lc.within);
      if (lc.quietAcl) L.push('login quiet-mode access-class ' + lc.quietAcl);
      if (lc.delay) L.push('login delay ' + lc.delay);
      if (lc.logFail) L.push('login on-failure log');
      if (lc.logOk) L.push('login on-success log');
    }
    for (const b of dev.ipsgStatic || []) L.push('ip source binding ' + U.ciscoMac(b.mac) + ' vlan ' + b.vlan + ' ' + U.ipStr(b.ip) + ' interface ' + b.port);
    if (c) {
      for (const r of c.rules) L.push('privilege ' + r.mode + (r.all ? ' all' : '') + ' level ' + r.level + ' ' + r.words.join(' '));
      for (const [n, v] of Object.entries(c.views)) {
        L.push('parser view ' + n);
        if (v.secret) L.push(' secret 5 ' + v.secret);
        for (const x of v.cmds) L.push(' commands ' + x.mode + ' include' + (x.all ? ' all' : '') + ' ' + x.words.join(' '));
        L.push('!');
      }
    }
    if (L.length && L[L.length - 1] !== '!') L.push('!');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!isIosDev(dev)) return false;
    if (C.kw(a[0], 'login', 3)) {
      const c = dev.loginSec || loginCfg(dev);
      const rt = loginRt(dev);
      if (C.kw(a[1], 'failures', 1)) {
        io.out('Total failed logins: ' + rt.total);
        return true;
      }
      io.out('     ' + (c.delay ? 'A login delay of ' + c.delay + ' seconds is applied.' : 'No login delay has been applied.'));
      io.out('     ' + (c.quietAcl ? 'Quiet-Mode access list ' + c.quietAcl + ' is applied.' : 'No Quiet-Mode access list has been configured.'));
      if (!c.blockFor) { io.out('     Router NOT enabled to watch for login Attacks'); return true; }
      io.out('     Router enabled to watch for login Attacks.');
      io.out('     If more than ' + c.attempts + ' login failures occur in ' + c.within + ' seconds or less,');
      io.out('     logins will be disabled for ' + c.blockFor + ' seconds.');
      if (quiet(dev)) {
        io.out('     Router presently in Quiet-Mode.');
        io.out('     Will remain in Quiet-Mode for ' + Math.ceil((rt.quietUntil - dev.net.time) / 100) + ' seconds.');
      } else {
        io.out('     Router presently in Normal-Mode.');
        io.out('     Current Watch Window');
        io.out('         Time remaining: ' + c.within + ' seconds.');
        io.out('         Login failures for current window: ' + rt.fails.filter((x) => dev.net.time - x < c.within * 100).length + '.');
      }
      io.out('     Total login failures: ' + rt.total + '.');
      return true;
    }
    if (!isSw(dev)) return false;
    if (C.kw(a[0], 'ip', 1) && C.kw(a[1], 'verify', 1) && C.kw(a[2], 'source', 1)) {
      io.out(C.pad('Interface', 11) + C.pad('Filter-type', 13) + C.pad('Filter-mode', 13) + C.pad('IP-address', 17) + C.pad('Mac-address', 19) + 'Vlan');
      io.out(C.pad('---------', 11) + C.pad('-----------', 13) + C.pad('-----------', 13) + C.pad('---------------', 17) + C.pad('-----------------', 19) + '----');
      dev.ports.forEach((p, i) => {
        if (!p.ipsg) return;
        const bind = [];
        if (dev.snoopRt) for (const b of dev.snoopRt.bindings.values()) if (b.port === i) bind.push(b);
        for (const b of dev.ipsgStatic || []) if (b.port === p.name) bind.push(b);
        const ft = p.ipsg === 'ip-mac' ? 'ip-mac' : 'ip';
        if (!bind.length) io.out(C.pad(C.shortIf(p.name), 11) + C.pad(ft, 13) + C.pad('active', 13) + C.pad('deny-all', 17) + C.pad('', 19) + (p.vlan || 1));
        for (const b of bind) io.out(C.pad(C.shortIf(p.name), 11) + C.pad(ft, 13) + C.pad('active', 13) + C.pad(U.ipStr(b.ip), 17) + C.pad(p.ipsg === 'ip-mac' ? U.ciscoMac(b.mac) : '', 19) + (b.vlan || 1));
      });
      return true;
    }
    if (C.kw(a[0], 'storm-control', 3)) {
      const k = ['broadcast', 'multicast', 'unicast'].find((x) => C.kw(a[2] || a[1], x, 1)) || 'broadcast';
      io.out(C.pad('Interface', 11) + C.pad('Filter State', 15) + C.pad('Upper', 13) + C.pad('Lower', 13) + 'Current');
      io.out(C.pad('---------', 11) + C.pad('-------------', 15) + C.pad('-----------', 13) + C.pad('-----------', 13) + '----------');
      for (const p of dev.ports) {
        const x = p.storm && p.storm[k];
        if (!x) continue;
        const r = p.stormRt && p.stormRt[k];
        const cur = r ? r.last || 0 : 0;
        const fmt = (v) => (x.unit === '%' ? v.toFixed(2) + '%' : Math.round(v) + ' ' + x.unit);
        io.out(C.pad(C.shortIf(p.name), 11) + C.pad(p.errDisabled && p.errReason === 'storm-control' ? 'Shutdown' : r && r.blocked ? 'Blocking' : 'Forwarding', 15) + C.pad(fmt(x.level), 13) + C.pad(fmt(x.level), 13) + fmt(cur));
      }
      return true;
    }
    return false;
  });

  /* ================= сохранение ================= */

  NS.deviceExt.push({
    key: 'sec2',
    applies: isIosDev,
    save(d) {
      const o = {};
      if (d.privCfg && (d.privCfg.rules.length || Object.keys(d.privCfg.secrets).length || Object.keys(d.privCfg.views).length)) o.priv = JSON.parse(JSON.stringify(d.privCfg));
      if (d.loginSec && Object.values(d.loginSec).some((v) => v)) o.login = Object.assign({}, d.loginSec);
      if (d.minPassLen) o.minLen = d.minPassLen;
      if (d.ipsgStatic && d.ipsgStatic.length) o.bindings = d.ipsgStatic.map((b) => Object.assign({}, b, { ip: U.ipStr(b.ip) }));
      const ports = {};
      for (const p of d.ports) {
        const x = {};
        if (p.ipsg) x.ipsg = p.ipsg;
        if (p.storm) x.storm = JSON.parse(JSON.stringify(p.storm));
        if (Object.keys(x).length) ports[p.name] = x;
      }
      if (Object.keys(ports).length) o.ports = ports;
      return Object.keys(o).length ? o : null;
    },
    load(d, c) {
      c = c || {};
      d.privCfg = c.priv ? { rules: c.priv.rules || [], secrets: c.priv.secrets || {}, views: c.priv.views || {} } : null;
      d.loginSec = c.login ? Object.assign({ blockFor: 0, attempts: 0, within: 0, quietAcl: null, logFail: false, logOk: false, delay: 0 }, c.login) : null;
      d.minPassLen = Number(c.minLen) || 0;
      d.ipsgStatic = (c.bindings || []).map((b) => Object.assign({}, b, { ip: U.parseIp(b.ip) }));
      for (const p of d.ports) {
        const x = (c.ports && c.ports[p.name]) || {};
        if (x.ipsg) p.ipsg = x.ipsg; else delete p.ipsg;
        if (x.storm) p.storm = x.storm; else delete p.storm;
      }
    },
  });

  X.tree.config = (X.tree.config || []).concat(['privilege exec level WORD LINE', 'enable secret level WORD WORD', 'parser view WORD', 'security passwords min-length WORD',
    'login block-for WORD attempts WORD within WORD', 'login quiet-mode access-class WORD', 'login on-failure log', 'login on-success log', 'ip source binding H.H.H vlan WORD A.B.C.D interface WORD']);
  X.tree.if = (X.tree.if || []).concat(['ip verify source', 'ip verify source port-security', 'storm-control broadcast level WORD', 'storm-control action shutdown', 'storm-control action trap']);
  X.tree.exec = (X.tree.exec || []).concat(['enable view', 'enable view WORD', 'show privilege', 'show parser view', 'show login', 'show login failures', 'show ip verify source', 'show storm-control']);

  NS.sec2 = { lvl, match };
})(globalThis.NetLab = globalThis.NetLab || {});
