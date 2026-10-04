/* NetLab — IP SLA и объекты отслеживания (track), как в IOS:
 *  ip sla N → icmp-echo АДРЕС [source-interface ИФ | source-ip IP], frequency С, timeout МС, threshold МС;
 *  ip sla schedule N [life forever|С] [start-time now|pending]; зонд — настоящий ping по модели сети;
 *  track N ip sla M [reachability|state]; track N interface ИФ line-protocol|ip routing; delay up|down С;
 *  ip route … track N — маршрут действует, пока объект Up (резервный маршрут с большим AD занимает его место);
 *  standby Г track N [decrement D] — HSRP понижает приоритет, когда объект Down;
 *  show ip sla statistics|configuration|summary, show track [N|brief], %TRACK-6-STATE. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const IpNode = NS.IpNode;
  const X = NS.cliIos.ext;
  const ip = (x) => U.ipStr(x);
  const isL3 = (d) => d.ios && (d.type === 'router' || d.type === 'switch');

  const slas = (d) => d.ipsla || (d.ipsla = new Map());
  const tracks = (d) => d.tracks || (d.tracks = new Map());
  const rtOf = (o) => o.rt || (o.rt = {});
  const hms = (ticks) => {
    const s = Math.max(0, Math.floor(ticks / 100));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':');
  };

  /* ================= зонды IP SLA ================= */

  function stopSla(e) {
    const rt = rtOf(e);
    if (rt.timer) { rt.timer.cancel(); rt.timer = null; }
  }

  function startSla(dev, id) {
    const e = slas(dev).get(id);
    if (!e) return;
    stopSla(e);
    if (!e.sched || !e.sched.now || e.target == null || !dev.power) return;
    const rt = rtOf(e);
    rt.started = dev.net.time;
    const tick = () => {
      rt.timer = null;
      if (slas(dev).get(id) !== e || !e.sched) return;
      if (e.sched.life != null && dev.net.time - rt.started >= e.sched.life * 100) { rt.expired = true; return; }
      probe(dev, e);
      rt.timer = dev.timer(Math.max(1, e.freq) * 100, tick);
    };
    rt.timer = dev.timer(1, tick);
  }

  function probe(dev, e) {
    const rt = rtOf(e);
    const t0 = dev.net.time;
    const done = (rc, rtt) => {
      rt.last = t0;
      rt.rc = rc;
      rt.rtt = rtt;
      if (rc === 'OK' || rc === 'Over threshold') rt.ok = (rt.ok || 0) + 1; else rt.fail = (rt.fail || 0) + 1;
      updateTracks(dev);
    };
    if (!dev.ifaces.some((f) => f.ip != null)) { done('No connection', null); return; }
    let finished = false;
    dev.ping(ip(e.target), {
      count: 1,
      timeout: Math.max(1, Math.round(e.timeout / 10)),
      onEvent: (ev) => {
        if (ev.type !== 'done' || finished) return;
        finished = true;
        if (ev.received > 0) {
          const ms = Math.max(1, Math.round(ev.rtts[0] || 0));
          done(e.threshold && ms > e.threshold ? 'Over threshold' : 'OK', ms);
        } else done('Timeout', null);
      },
    });
  }

  /* ================= объекты отслеживания ================= */

  /** Текущее «сырое» состояние объекта (без задержек delay). */
  function rawState(dev, t) {
    if (t.kind === 'iface') {
      const f = dev.ifaceByName(t.ifName);
      if (!f) return false;
      return t.what === 'routing' ? dev.ifaceUp(f) && f.ip != null : dev.ifaceUp(f);
    }
    const e = slas(dev).get(t.sla);
    const rc = e && e.rt ? e.rt.rc : null;
    return t.mode === 'state' ? rc === 'OK' : rc === 'OK' || rc === 'Over threshold';
  }

  /** Состояние объекта track id: true — Up. Нет такого объекта — Down. */
  function up(dev, id) {
    const t = dev.tracks && dev.tracks.get(Number(id));
    if (!t) return false;
    if (t.kind === 'iface') return rawState(dev, t); // интерфейс — сразу, без задержек
    const rt = rtOf(t);
    if (rt.state == null) rt.state = rawState(dev, t);
    return rt.state;
  }

  function setState(dev, id, t, v) {
    const rt = rtOf(t);
    if (rt.state === v) return;
    const was = rt.state;
    rt.state = v;
    rt.changes = (rt.changes || 0) + 1;
    rt.changed = dev.net.time;
    if (was != null) dev.iosLog('TRACK', 6, 'STATE', id + ' ' + what(t) + ' ' + (v ? 'Down -> Up' : 'Up -> Down'));
    dev.net.markRouting();
    if (NS.fhrp && NS.fhrp.elect) NS.fhrp.elect(dev.net);
  }

  /** Пересчитать объекты с учётом delay up/down (после зонда SLA или смены состояния интерфейса). */
  function updateTracks(dev) {
    if (!dev.tracks) return;
    for (const [id, t] of dev.tracks) {
      if (t.kind === 'iface') continue;
      const rt = rtOf(t);
      const v = rawState(dev, t);
      if (rt.state == null) { rt.state = v; continue; }
      if (v === rt.state) { if (rt.pend) { rt.pend.cancel(); rt.pend = null; } continue; }
      const delay = v ? t.delayUp : t.delayDown;
      if (!delay) { setState(dev, id, t, v); continue; }
      if (rt.pend) continue;
      rt.pend = dev.timer(delay * 100, () => { rt.pend = null; if (rawState(dev, t) === v) setState(dev, id, t, v); });
    }
  }

  function what(t) {
    if (t.kind === 'iface') return 'interface ' + t.ifName + ' ' + (t.what === 'routing' ? 'ip routing' : 'line-protocol');
    return 'ip sla ' + t.sla + ' ' + (t.mode === 'state' ? 'state' : 'reachability');
  }

  // маршрут с track действует, только пока объект Up
  const baseStatic = IpNode.prototype.staticRoutes;
  IpNode.prototype.staticRoutes = function () {
    const r = baseStatic.call(this);
    return r.some((x) => x.track != null) ? r.filter((x) => x.track == null || up(this, x.track)) : r;
  };

  // после включения / загрузки устройства — запустить зонды
  IpNode.hooks.bind.push(function () {
    if (!this.ipsla) return;
    for (const id of this.ipsla.keys()) startSla(this, id);
  });

  /* ================= команды ================= */

  X.global.push((t) => /^track$/i.test(t[0] || '') || (/^ip$/i.test(t[0] || '') && /^sla$/i.test(t[1] || '')));

  X.config.unshift((dev, s, a, neg, io, C) => {
    if (!isL3(dev)) return false;
    // ip sla schedule N …
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'sla', 3) && C.kw(a[2], 'schedule', 2)) {
      const id = Number(a[3]);
      const e = slas(dev).get(id);
      if (!e) { io.out('%Entry ' + (a[3] || '') + ' does not exist'); return true; }
      if (neg) { C.withMutate(io, () => { e.sched = null; stopSla(e); }); return true; }
      let life = 3600;
      let now = false;
      for (let i = 4; i < a.length; i++) {
        if (C.kw(a[i], 'life', 1)) { const v = a[++i]; life = C.kw(v, 'forever', 1) ? null : Number(v); if (life !== null && !(life > 0)) { C.invalid(io, v); return true; } } else if (C.kw(a[i], 'start-time', 1)) {
          const v = a[++i];
          if (C.kw(v, 'now', 1)) now = true; else if (C.kw(v, 'pending', 1)) now = false; else if (v) now = true; // время и after — как now
        } else if (C.kw(a[i], 'recurring', 1) || C.kw(a[i], 'ageout', 1)) { if (C.kw(a[i], 'ageout', 1)) i++; } else { C.invalid(io, a[i]); return true; }
      }
      C.withMutate(io, () => { e.sched = { life, now }; e.rt = {}; startSla(dev, id); });
      return true;
    }
    // ip sla N
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'sla', 3)) {
      const id = Number(a[2]);
      if (!(Number.isInteger(id) && id >= 1 && id <= 2147483647)) { if (a[2]) C.invalid(io, a[2]); else C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { const e = slas(dev).get(id); if (e) stopSla(e); slas(dev).delete(id); updateTracks(dev); }); return true; }
      const e = slas(dev).get(id);
      if (e && e.sched) { io.out('%Entry already running and cannot be modified (only can delete (no) and start over)'); io.out('%(check to make sure entry is not pending or scheduled to run)'); return true; }
      if (!e) C.withMutate(io, () => { slas(dev).set(id, { type: null, target: null, src: null, freq: 60, timeout: 5000, threshold: 5000, sched: null }); });
      s.mode = 'ipsla';
      s.ctx = { sla: id };
      return true;
    }
    // track N …
    if (C.kw(a[0], 'track', 2)) {
      const id = Number(a[1]);
      if (!(Number.isInteger(id) && id >= 1 && id <= 1000)) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { tracks(dev).delete(id); dev.net.markRouting(); }); return true; }
      let t = null;
      if (C.kw(a[2], 'ip', 1) && C.kw(a[3], 'sla', 1)) {
        const sla = Number(a[4]);
        if (!(sla >= 1)) { C.incomplete(io); return true; }
        t = { kind: 'sla', sla, mode: C.kw(a[5], 'state', 1) ? 'state' : 'reachability' };
      } else if (C.kw(a[2], 'interface', 1)) {
        const r = C.parseIfName(dev, a[3] || '');
        const f = r && C.ifaceOf(dev, r);
        if (!f) { C.invalid(io, a[3]); return true; }
        t = { kind: 'iface', ifName: f.name, what: C.kw(a[4], 'ip', 1) ? 'routing' : 'line' };
      } else if (!a[2]) {
        if (!tracks(dev).has(id)) { C.incomplete(io); return true; }
      } else { C.invalid(io, a[2]); return true; }
      if (t) {
        const old = tracks(dev).get(id);
        if (old) { t.delayUp = old.delayUp; t.delayDown = old.delayDown; }
        C.withMutate(io, () => { tracks(dev).set(id, t); rtOf(t).state = rawState(dev, t); dev.net.markRouting(); if (NS.fhrp && NS.fhrp.elect) NS.fhrp.elect(dev.net); });
      }
      s.mode = 'track';
      s.ctx = { track: id };
      return true;
    }
    return false;
  });

  X.modes.ipsla = {
    prompt: () => '(config-ip-sla)#',
    tree: ['icmp-echo A.B.C.D', 'icmp-echo A.B.C.D source-interface WORD', 'icmp-echo A.B.C.D source-ip A.B.C.D'],
    run(dev, s, t, io, C) {
      const e = slas(dev).get(s.ctx && s.ctx.sla);
      if (!e) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'icmp-echo', 1)) {
        const tg = U.parseIp(a[1] || '');
        if (tg == null) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return; }
        let src = null;
        if (C.kw(a[2], 'source-interface', 8)) {
          const r = C.parseIfName(dev, a[3] || '');
          const f = r && C.ifaceOf(dev, r);
          if (!f) { C.invalid(io, a[3]); return; }
          src = f.name;
        } else if (C.kw(a[2], 'source-ip', 8)) {
          const v = U.parseIp(a[3] || '');
          if (v == null) { C.invalid(io, a[3]); return; }
          src = ip(v);
        }
        C.withMutate(io, () => { e.type = 'icmp-echo'; e.target = tg; e.src = src; });
        s.mode = 'ipsla-echo';
        return;
      }
      C.invalid(io, a[0]);
    },
  };

  X.modes['ipsla-echo'] = {
    parent: 'ipsla',
    prompt: () => '(config-ip-sla-echo)#',
    tree: ['frequency WORD', 'timeout WORD', 'threshold WORD', 'tag WORD', 'request-data-size WORD', 'tos WORD'],
    run(dev, s, t, io, C) {
      const e = slas(dev).get(s.ctx && s.ctx.sla);
      if (!e) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      const num = (lo, hi) => { const v = Number(a[1]); if (!(Number.isInteger(v) && v >= lo && v <= hi)) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return null; } return v; };
      if (C.kw(a[0], 'frequency', 1)) { const v = neg ? 60 : num(1, 604800); if (v != null) C.withMutate(io, () => { e.freq = v; }); return; }
      if (C.kw(a[0], 'timeout', 2)) { const v = neg ? 5000 : num(0, 604800000); if (v != null) C.withMutate(io, () => { e.timeout = v; }); return; }
      if (C.kw(a[0], 'threshold', 2)) { const v = neg ? 5000 : num(0, 2147483647); if (v != null) C.withMutate(io, () => { e.threshold = v; }); return; }
      if (C.kw(a[0], 'tag', 2) || C.kw(a[0], 'request-data-size', 1) || C.kw(a[0], 'tos', 2) || C.kw(a[0], 'vrf', 1) || C.kw(a[0], 'verify-data', 1)) return;
      C.invalid(io, a[0]);
    },
  };

  X.modes.track = {
    prompt: () => '(config-track)#',
    tree: ['delay up WORD', 'delay down WORD', 'delay up WORD down WORD'],
    run(dev, s, t, io, C) {
      const tr = tracks(dev).get(s.ctx && s.ctx.track);
      if (!tr) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'delay', 1)) {
        let upV = neg ? 0 : tr.delayUp || 0;
        let downV = neg ? 0 : tr.delayDown || 0;
        for (let i = 1; i < a.length; i += 2) {
          const v = Number(a[i + 1]);
          if (!neg && !(Number.isInteger(v) && v >= 0 && v <= 180)) { C.invalid(io, a[i + 1]); return; }
          if (C.kw(a[i], 'up', 1)) upV = neg ? 0 : v; else if (C.kw(a[i], 'down', 1)) downV = neg ? 0 : v; else { C.invalid(io, a[i]); return; }
        }
        C.withMutate(io, () => { tr.delayUp = upV || 0; tr.delayDown = downV || 0; });
        return;
      }
      C.invalid(io, a[0]);
    },
  };

  X.running.global.push((dev) => {
    const L = [];
    for (const [id, e] of [...(dev.ipsla || new Map())].sort((x, y) => x[0] - y[0])) {
      L.push('ip sla ' + id);
      if (e.type === 'icmp-echo') {
        L.push(' icmp-echo ' + ip(e.target) + (e.src ? (U.parseIp(e.src) != null ? ' source-ip ' : ' source-interface ') + e.src : ''));
        if (e.threshold !== 5000) L.push(' threshold ' + e.threshold);
        if (e.timeout !== 5000) L.push(' timeout ' + e.timeout);
        if (e.freq !== 60) L.push(' frequency ' + e.freq);
      }
      if (e.sched) L.push('ip sla schedule ' + id + (e.sched.life == null ? ' life forever' : e.sched.life !== 3600 ? ' life ' + e.sched.life : '') + (e.sched.now ? ' start-time now' : ''));
    }
    for (const [id, t] of [...(dev.tracks || new Map())].sort((x, y) => x[0] - y[0])) {
      L.push('track ' + id + ' ' + what(t));
      if (t.delayUp || t.delayDown) L.push(' delay' + (t.delayUp ? ' up ' + t.delayUp : '') + (t.delayDown ? ' down ' + t.delayDown : ''));
    }
    if (L.length) L.push('!');
    return L;
  });

  /* ================= show ================= */

  X.show.push((dev, s, a, io, C) => {
    if (!isL3(dev)) return false;
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'sla', 3)) {
      const list = [...slas(dev)].sort((x, y) => x[0] - y[0]).filter(([id]) => !a[3] || String(id) === a[3]);
      if (C.kw(a[2], 'summary', 2)) {
        io.out('IPSLAs Latest Operation Summary');
        io.out('Codes: * active, ^ inactive, ~ pending');
        io.out('');
        io.out('ID           Type        Destination       Stats       Return      Last');
        io.out('                                           (ms)        Code        Run');
        io.out('-----------------------------------------------------------------------');
        for (const [id, e] of list) {
          const rt = e.rt || {};
          io.out(((e.sched && e.sched.now ? '*' : '~') + id).padEnd(13) + (e.type || '').padEnd(12) + (e.target != null ? ip(e.target) : '').padEnd(18) + (rt.rtt != null ? 'RTT=' + rt.rtt : '-').padEnd(12) + (rt.rc || 'Unknown').padEnd(12) + (rt.last != null ? hms(dev.net.time - rt.last) + ' ago' : '-'));
        }
        return true;
      }
      if (C.kw(a[2], 'configuration', 1)) {
        io.out('IP SLAs Infrastructure Engine-III');
        for (const [id, e] of list) {
          io.out('Entry number: ' + id);
          io.out('Type of operation to perform: ' + (e.type || 'not configured'));
          io.out('Target address/Source ' + (e.src && U.parseIp(e.src) == null ? 'interface' : 'address') + ': ' + (e.target != null ? ip(e.target) : '-') + '/' + (e.src || '0.0.0.0'));
          io.out('Operation timeout (milliseconds): ' + e.timeout);
          io.out('Threshold (milliseconds): ' + e.threshold);
          io.out('Schedule:');
          io.out('   Operation frequency (seconds): ' + e.freq);
          io.out('   Next Scheduled Start Time: ' + (e.sched ? (e.sched.now ? 'Start Time already passed' : 'Pending trigger') : 'Pending trigger'));
          io.out('   Life (seconds): ' + (e.sched && e.sched.life == null ? 'Forever' : e.sched ? e.sched.life : 3600));
          io.out('');
        }
        return true;
      }
      if (!a[2] || C.kw(a[2], 'statistics', 2)) {
        io.out('IPSLAs Latest Operation Statistics');
        io.out('');
        for (const [id, e] of list) {
          const rt = e.rt || {};
          io.out('IPSLA operation id: ' + id);
          io.out('        Latest RTT: ' + (rt.rtt != null ? rt.rtt + ' milliseconds' : 'NoConnection/Busy/Timeout'));
          io.out('Latest operation start time: ' + (rt.last != null ? hms(rt.last) : 'Unknown'));
          io.out('Latest operation return code: ' + (rt.rc || 'Unknown'));
          io.out('Number of successes: ' + (rt.ok || 0));
          io.out('Number of failures: ' + (rt.fail || 0));
          io.out('Operation time to live: ' + (!e.sched ? '0' : e.sched.life == null ? 'Forever' : Math.max(0, e.sched.life - Math.floor((dev.net.time - (rt.started || 0)) / 100)) + ' sec'));
          io.out('');
        }
        return true;
      }
      return false;
    }
    if (C.kw(a[0], 'track', 2)) {
      const all = [...tracks(dev)].sort((x, y) => x[0] - y[0]);
      if (C.kw(a[1], 'brief', 1)) {
        io.out('Track Type        Instance                   Parameter        State Last Change');
        for (const [id, t] of all) {
          const rt = t.rt || {};
          const inst = t.kind === 'iface' ? t.ifName : String(t.sla);
          const par = t.kind === 'iface' ? (t.what === 'routing' ? 'ip routing' : 'line-protocol') : t.mode;
          io.out(String(id).padEnd(6) + (t.kind === 'iface' ? 'interface' : 'ip sla').padEnd(12) + inst.padEnd(27) + par.padEnd(17) + (up(dev, id) ? 'Up' : 'Down').padEnd(6) + (rt.changed != null ? hms(dev.net.time - rt.changed) : '-'));
        }
        return true;
      }
      const sel = a[1] ? all.filter(([id]) => String(id) === a[1]) : all;
      if (a[1] && !sel.length) { io.out('% Track object ' + a[1] + ' does not exist'); return true; }
      for (const [id, t] of sel) {
        const rt = t.rt || {};
        const on = up(dev, id);
        io.out('Track ' + id);
        if (t.kind === 'iface') {
          io.out('  Interface ' + t.ifName + ' ' + (t.what === 'routing' ? 'ip routing' : 'line-protocol'));
          io.out('  ' + (t.what === 'routing' ? 'IP routing' : 'Line protocol') + ' is ' + (on ? 'Up' : 'Down'));
        } else {
          io.out('  IP SLA ' + t.sla + ' ' + t.mode);
          io.out('  ' + (t.mode === 'state' ? 'State' : 'Reachability') + ' is ' + (on ? 'Up' : 'Down'));
        }
        io.out('    ' + (rt.changes || 0) + ' change' + (rt.changes === 1 ? '' : 's') + ', last change ' + (rt.changed != null ? hms(dev.net.time - rt.changed) : 'never'));
        if (t.delayUp || t.delayDown) io.out('  Delay' + (t.delayUp ? ' up ' + t.delayUp + ' secs' : '') + (t.delayDown ? ' down ' + t.delayDown + ' secs' : ''));
        if (t.kind === 'sla') {
          const e = slas(dev).get(t.sla);
          const ert = (e && e.rt) || {};
          io.out('  Latest operation return code: ' + (ert.rc || 'Unknown'));
          if (ert.rtt != null) io.out('  Latest RTT (millisecs) ' + ert.rtt);
        }
        const by = [];
        const rs = (dev.routes || []).filter((r) => r.track === id).length;
        if (rs) by.push('Static IP Routing ' + rs);
        for (const f of dev.ifaces || []) {
          for (const [g, c] of Object.entries((f.fhrp && f.fhrp.hsrp) || {})) if ((c.track || []).some((x) => x.obj === id)) by.push('HSRP ' + f.name + ' ' + g);
        }
        if (by.length) { io.out('  Tracked by:'); for (const b of by) io.out('    ' + b); }
      }
      return true;
    }
    return false;
  });

  X.tree.config = (X.tree.config || []).concat(['ip sla WORD', 'ip sla schedule WORD life forever start-time now', 'track WORD ip sla WORD reachability', 'track WORD ip sla WORD state',
    'track WORD interface WORD line-protocol', 'ip route A.B.C.D A.B.C.D A.B.C.D track WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show ip sla statistics', 'show ip sla configuration', 'show ip sla summary', 'show track', 'show track brief']);

  /* ================= сохранение ================= */

  NS.deviceExt.push({
    key: 'ipsla',
    applies: isL3,
    save(d) {
      const s = [...(d.ipsla || new Map())].map(([id, e]) => ({ id, type: e.type, target: e.target != null ? ip(e.target) : null, src: e.src, freq: e.freq, timeout: e.timeout, threshold: e.threshold, sched: e.sched ? Object.assign({}, e.sched) : null }));
      const t = [...(d.tracks || new Map())].map(([id, x]) => ({ id, kind: x.kind, sla: x.sla, mode: x.mode, ifName: x.ifName, what: x.what, delayUp: x.delayUp || 0, delayDown: x.delayDown || 0 }));
      return s.length || t.length ? { sla: s, track: t } : null;
    },
    load(d, c) {
      if (d.ipsla) for (const e of d.ipsla.values()) stopSla(e);
      d.ipsla = new Map();
      d.tracks = new Map();
      if (!c) return;
      for (const e of c.sla || []) {
        d.ipsla.set(Number(e.id), { type: e.type || null, target: e.target ? U.parseIp(e.target) : null, src: e.src || null, freq: Number(e.freq) || 60, timeout: e.timeout != null ? Number(e.timeout) : 5000, threshold: e.threshold != null ? Number(e.threshold) : 5000, sched: e.sched ? { life: e.sched.life == null ? null : Number(e.sched.life), now: !!e.sched.now } : null });
      }
      for (const t of c.track || []) {
        const o = t.kind === 'iface' ? { kind: 'iface', ifName: String(t.ifName), what: t.what === 'routing' ? 'routing' : 'line' } : { kind: 'sla', sla: Number(t.sla), mode: t.mode === 'state' ? 'state' : 'reachability' };
        o.delayUp = Number(t.delayUp) || 0;
        o.delayDown = Number(t.delayDown) || 0;
        d.tracks.set(Number(t.id), o);
      }
      for (const id of d.ipsla.keys()) startSla(d, id);
    },
  });

  NS.track = { up, updateTracks, startSla };
})(globalThis.NetLab = globalThis.NetLab || {});
