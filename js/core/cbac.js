/* NetLab — межсетевой экран IOS на основе состояний (CBAC) и система предотвращения вторжений IOS IPS.
 * CBAC: ip inspect name ИМЯ tcp|udp|icmp|http|ftp|smtp|dns|telnet, ip inspect ИМЯ in|out на интерфейсе,
 *   ip inspect audit-trail; для проверенного сеанса ответы проходят через входящий ACL (временное «окно»);
 *   show ip inspect sessions|all|name|interfaces.
 * IPS: ip ips name, ip ips config location, ip ips notify log, ip ips signature-category (category … retired),
 *   ip ips signature-definition (signature N M → status: retired/enabled, engine: event-action), ip ips ИМЯ in|out;
 *   show ip ips all, show ip ips signatures count; сообщение %IPS-4-SIGNATURE, deny-packet-inline отбрасывает пакет. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const IpNode = NS.IpNode;
  const X = NS.cliIos.ext;
  const isRouter = (d) => d.type === 'router';

  /* ================= CBAC ================= */

  const APPS = { http: ['TCP', 80], ftp: ['TCP', 21], smtp: ['TCP', 25], telnet: ['TCP', 23], dns: ['UDP', 53] };
  const PROTOS = ['tcp', 'udp', 'icmp'].concat(Object.keys(APPS));
  const TIMEOUT = { TCP: 360000, UDP: 3000, ICMP: 1000 }; // тиков: 3600 с, 30 с, 10 с

  function cbac(dev) { if (!dev.cbac) dev.cbac = { rules: {}, audit: false }; return dev.cbac; }
  const sessions = (dev) => { if (!dev.cbacRt) dev.cbacRt = new Map(); return dev.cbacRt; };

  function appOf(pkt) {
    const l4 = pkt.payload || {};
    if (pkt.proto === 'ICMP') return l4.type === 'echo-request' ? 'icmp' : null;
    if (pkt.proto !== 'TCP' && pkt.proto !== 'UDP') return null;
    for (const [n, [p, port]] of Object.entries(APPS)) if (p === pkt.proto && (l4.dport === port)) return n;
    return pkt.proto.toLowerCase();
  }
  const keyOf = (src, dst, proto, sp, dp) => proto + '|' + src + '|' + dst + '|' + sp + '|' + dp;
  const fwdKey = (pkt) => { const l4 = pkt.payload || {}; return keyOf(pkt.src, pkt.dst, pkt.proto, pkt.proto === 'ICMP' ? l4.id : l4.sport, pkt.proto === 'ICMP' ? 0 : l4.dport); };
  const revKey = (pkt) => {
    const l4 = pkt.payload || {};
    if (pkt.proto === 'ICMP') return l4.type === 'echo-reply' ? keyOf(pkt.dst, pkt.src, 'ICMP', l4.id, 0) : null;
    return keyOf(pkt.dst, pkt.src, pkt.proto, l4.dport, l4.sport);
  };

  function inspect(dev, name, pkt, f, dir) {
    const rule = cbac(dev).rules[name];
    if (!rule) return;
    const app = appOf(pkt);
    if (!app) return;
    const base = pkt.proto === 'ICMP' ? 'icmp' : pkt.proto.toLowerCase();
    if (!rule.includes(app) && !rule.includes(base)) return;
    const k = fwdKey(pkt);
    const S = sessions(dev);
    const now = dev.net.time;
    const old = S.get(k);
    if (old && now - old.last < TIMEOUT[pkt.proto]) { old.last = now; old.bytes += NS.packets.sizeOf({ type: 'IPv4', payload: pkt }); return; }
    const l4 = pkt.payload || {};
    S.set(k, { key: k, name, app, proto: pkt.proto, src: pkt.src, dst: pkt.dst, sport: pkt.proto === 'ICMP' ? 0 : l4.sport, dport: pkt.proto === 'ICMP' ? 0 : l4.dport, created: now, last: now, bytes: 0, iface: f ? f.name : '', dir });
    if (cbac(dev).audit && dev.iosLog) dev.iosLog('FW', 6, 'SESS_AUDIT_TRAIL_START', 'Start ' + app + ' session: initiator (' + U.ipStr(pkt.src) + ':' + (l4.sport || 0) + ') -- responder (' + U.ipStr(pkt.dst) + ':' + (l4.dport || 0) + ')');
    dev.note('CBAC (' + name + '): запомнен сеанс ' + app + ' ' + U.ipStr(pkt.src) + ' → ' + U.ipStr(pkt.dst) + ' — ответы пропустит входящий ACL', null, 'info');
  }

  /** Пакет — ответ в проверенном сеансе? */
  function isReturn(dev, pkt) {
    if (!dev.cbacRt || !dev.cbacRt.size) return false;
    const k = revKey(pkt);
    const s = k && dev.cbacRt.get(k);
    if (!s) return false;
    if (dev.net.time - s.last >= TIMEOUT[s.proto]) { dev.cbacRt.delete(k); return false; }
    s.last = dev.net.time;
    return true;
  }

  // проверка на входе интерфейса (ip inspect … in) — до ACL
  IpNode.hooks.ipIn.push(function (f, pkt) {
    if (!isRouter(this) || !f || !f.inspect || !f.inspect.in || this.hasIp(pkt.dst)) return false;
    inspect(this, f.inspect.in, pkt, f, 'in');
    return false;
  });
  // на выходе (ip inspect … out) — пересылаемые пакеты
  IpNode.hooks.fwdOut.push(function (f, outIfc, pkt) {
    if (!isRouter(this) || !outIfc || !outIfc.inspect || !outIfc.inspect.out) return;
    inspect(this, outIfc.inspect.out, pkt, outIfc, 'out');
  });
  // ответы в проверенных сеансах проходят через ACL
  const aclDenies0 = IpNode.prototype.aclDenies;
  IpNode.prototype.aclDenies = function (name, pkt) {
    if (isRouter(this) && isReturn(this, pkt)) return null;
    return aclDenies0.call(this, name, pkt);
  };

  /* ================= IOS IPS ================= */

  const SIGS = {
    '1102/0': { name: 'Impossible IP Packet', sev: 'high', rr: 100, cat: 'basic', test: (p) => p.src === p.dst },
    '1104/0': { name: 'IP Localhost Source Spoof', sev: 'high', rr: 100, cat: 'basic', test: (p) => (p.src >>> 24) === 127 },
    '2000/0': { name: 'ICMP Echo Reply', sev: 'informational', rr: 25, cat: 'advanced', test: (p) => p.proto === 'ICMP' && p.payload && p.payload.type === 'echo-reply' },
    '2001/0': { name: 'ICMP Host Unreachable', sev: 'informational', rr: 25, cat: 'advanced', test: (p) => p.proto === 'ICMP' && p.payload && p.payload.type === 'unreachable' },
    '2004/0': { name: 'ICMP Echo Req', sev: 'informational', rr: 25, cat: 'advanced', test: (p) => p.proto === 'ICMP' && p.payload && p.payload.type === 'echo-request' },
    '2005/0': { name: 'ICMP Time Exceeded for a Datagram', sev: 'informational', rr: 25, cat: 'advanced', test: (p) => p.proto === 'ICMP' && p.payload && p.payload.type === 'time-exceeded' },
    '3040/0': { name: 'TCP NULL Packet', sev: 'high', rr: 100, cat: 'basic', test: (p) => p.proto === 'TCP' && p.payload && !p.payload.flags },
    '5081/0': { name: 'WWW WinNT cmd.exe Access', sev: 'high', rr: 100, cat: 'basic', test: (p) => p.proto === 'TCP' && p.payload && p.payload.data && /cmd\.exe/i.test(String(p.payload.data.path || '')) },
  };

  function ips(dev) {
    if (!dev.ips) dev.ips = { names: [], location: '', notify: false, cats: {}, sigs: {} };
    return dev.ips;
  }

  /** Состояние сигнатуры с учётом категорий: { active, actions }. */
  function sigState(cfg, id) {
    const def = SIGS[id];
    let retired = true;
    if (cfg.cats.all && cfg.cats.all.retired != null) retired = cfg.cats.all.retired;
    const cat = 'ios_ips ' + def.cat;
    if (cfg.cats[cat] && cfg.cats[cat].retired != null) retired = cfg.cats[cat].retired;
    if (def.cat === 'basic' && cfg.cats['ios_ips advanced'] && cfg.cats['ios_ips advanced'].retired != null) retired = cfg.cats['ios_ips advanced'].retired && retired;
    const s = cfg.sigs[id] || {};
    if (s.retired != null) retired = s.retired;
    const enabled = s.enabled != null ? s.enabled : true;
    return { active: !retired && enabled, actions: s.actions && s.actions.length ? s.actions : ['produce-alert'] };
  }

  function ipsCheck(dev, f, dir, pkt) {
    const name = f && f.ips && f.ips[dir];
    if (!name || !dev.ips || !dev.ips.names.includes(name)) return null;
    const cfg = dev.ips;
    for (const [id, def] of Object.entries(SIGS)) {
      const st = sigState(cfg, id);
      if (!st.active || !def.test(pkt)) continue;
      const l4 = pkt.payload || {};
      const [sig, sub] = id.split('/');
      if (cfg.notify && st.actions.includes('produce-alert') && dev.iosLog) {
        dev.iosLog('IPS', 4, 'SIGNATURE', 'Sig:' + sig + ' Subsig:' + sub + ' Sev:' + def.rr + ' ' + def.name + ' [' + U.ipStr(pkt.src) + ':' + (l4.sport || 0) + ' -> ' + U.ipStr(pkt.dst) + ':' + (l4.dport || 0) + '] VRF:NONE RiskRating:' + def.rr);
      }
      if (st.actions.includes('deny-packet-inline') || st.actions.includes('deny-attacker-inline')) return { sig: id, def };
    }
    return null;
  }

  IpNode.hooks.ipIn.push(function (f, pkt, frame) {
    if (!isRouter(this) || !f || !f.ips || !f.ips.in) return false;
    const hit = ipsCheck(this, f, 'in', pkt);
    if (!hit) return false;
    if (frame) this.drop(frame, 'IOS IPS ' + f.ips.in + ': сигнатура ' + hit.sig + ' «' + hit.def.name + '» — пакет отброшен (deny-packet-inline)');
    return true;
  });
  IpNode.hooks.egress.push(function (f, nh, pkt) {
    if (!isRouter(this) || !f || !f.ips || !f.ips.out || this.hasIp(pkt.src)) return false;
    const hit = ipsCheck(this, f, 'out', pkt);
    if (!hit) return false;
    this.note('IOS IPS ' + f.ips.out + ': сигнатура ' + hit.sig + ' «' + hit.def.name + '» на выходе ' + f.name + ' — пакет ' + U.ipStr(pkt.src) + ' → ' + U.ipStr(pkt.dst) + ' отброшен', null, 'drop');
    return true;
  });

  /* ================= команды ================= */

  X.global.push((t, s) => /^ip$/i.test(t[0] || '') && /^(insp|ips)/i.test(t[1] || '') && s.mode !== 'if');

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isRouter(dev) || !C.kw(a[0], 'ip', 2)) return false;
    if (C.kw(a[1], 'inspect', 4)) {
      const c = cbac(dev);
      if (C.kw(a[2], 'audit-trail', 2)) { C.withMutate(io, () => { c.audit = !neg; }); return true; }
      if (C.kw(a[2], 'alert-off', 2) || C.kw(a[2], 'max-incomplete', 2) || C.kw(a[2], 'one-minute', 2) || C.kw(a[2], 'tcp', 2) || C.kw(a[2], 'udp', 2) || C.kw(a[2], 'dns-timeout', 2)) return true;
      if (!C.kw(a[2], 'name', 1)) { if (a[2]) C.invalid(io, a[2]); else C.incomplete(io); return true; }
      const name = a[3];
      if (!name) { C.incomplete(io); return true; }
      const proto = a[4] && PROTOS.find((p) => C.kw(a[4], p, p.length > 3 ? 3 : 1) && (p !== 'tcp' || /^t[c]?p?$/i.test(a[4])));
      if (neg && !a[4]) { C.withMutate(io, () => { delete c.rules[name]; }); return true; }
      if (!proto) { if (a[4]) C.invalid(io, a[4]); else C.incomplete(io); return true; }
      C.withMutate(io, () => {
        const r = c.rules[name] || (c.rules[name] = []);
        const i = r.indexOf(proto);
        if (neg) { if (i >= 0) r.splice(i, 1); if (!r.length) delete c.rules[name]; } else if (i < 0) r.push(proto);
      });
      return true;
    }
    if (C.kw(a[1], 'ips', 3)) {
      const c = ips(dev);
      if (C.kw(a[2], 'name', 1)) {
        if (!a[3]) { C.incomplete(io); return true; }
        C.withMutate(io, () => { c.names = c.names.filter((x) => x !== a[3]); if (!neg) c.names.push(a[3]); });
        return true;
      }
      if (C.kw(a[2], 'config', 1)) { C.withMutate(io, () => { c.location = neg ? '' : String(a[4] || ''); }); return true; }
      if (C.kw(a[2], 'notify', 1)) { if (C.kw(a[3], 'log', 1) || !a[3]) C.withMutate(io, () => { c.notify = !neg; }); return true; }
      if (C.kw(a[2], 'signature-category', 11)) { s.mode = 'ips-cat'; s.ips = {}; return true; }
      if (C.kw(a[2], 'signature-definition', 11)) { s.mode = 'ips-sigdef'; s.ips = {}; return true; }
      if (a[2]) C.invalid(io, a[2]); else C.incomplete(io);
      return true;
    }
    return false;
  });

  const bool = (w) => (/^t/i.test(w || '') ? true : /^f/i.test(w || '') ? false : null);

  X.modes['ips-cat'] = {
    prompt: () => '(config-ips-category)#',
    tree: ['category all', 'category ios_ips basic', 'category ios_ips advanced'],
    run(dev, s, t, io, C) {
      if (!C.kw(t[0], 'category', 2)) { C.invalid(io, t[0]); return; }
      const cat = t.slice(1).join(' ').toLowerCase();
      if (!['all', 'ios_ips basic', 'ios_ips advanced'].includes(cat)) { C.invalid(io, t[1]); return; }
      s.ips = { cat };
      s.mode = 'ips-catx';
    },
  };
  X.modes['ips-catx'] = {
    prompt: () => '(config-ips-category-action)#',
    parent: 'ips-cat',
    tree: ['retired true', 'retired false', 'enabled true', 'event-action produce-alert', 'event-action deny-packet-inline'],
    run(dev, s, t, io, C) {
      const c = ips(dev);
      const x = c.cats[s.ips.cat] || (c.cats[s.ips.cat] = {});
      if (C.kw(t[0], 'retired', 1)) { const v = bool(t[1]); if (v == null) { C.invalid(io, t[1]); return; } C.withMutate(io, () => { x.retired = v; }); return; }
      if (C.kw(t[0], 'enabled', 2)) { const v = bool(t[1]); if (v == null) { C.invalid(io, t[1]); return; } C.withMutate(io, () => { x.enabled = v; }); return; }
      if (C.kw(t[0], 'event-action', 2)) return;
      C.invalid(io, t[0]);
    },
  };
  X.modes['ips-sigdef'] = {
    prompt: () => '(config-sigdef)#',
    tree: ['signature 2004 0', 'signature 2000 0'],
    run(dev, s, t, io, C) {
      if (!C.kw(t[0], 'signature', 2)) { C.invalid(io, t[0]); return; }
      const id = String(t[1] || '') + '/' + String(t[2] || '0');
      if (!SIGS[id]) { io.out('%IPS: signature ' + (t[1] || '') + ' ' + (t[2] || '0') + ' не найдена в наборе сигнатур NetLab (есть: ' + Object.keys(SIGS).map((k) => k.replace('/', ' ')).join(', ') + ')'); return; }
      s.ips = { sig: id };
      s.mode = 'ips-sig';
    },
  };
  X.modes['ips-sig'] = {
    prompt: () => '(config-sigdef-sig)#',
    parent: 'ips-sigdef',
    tree: ['status', 'engine'],
    run(dev, s, t, io, C) {
      if (C.kw(t[0], 'status', 2)) { s.mode = 'ips-status'; return; }
      if (C.kw(t[0], 'engine', 2)) { s.mode = 'ips-engine'; return; }
      C.invalid(io, t[0]);
    },
  };
  const sigCfg = (dev, s) => { const c = ips(dev); return c.sigs[s.ips.sig] || (c.sigs[s.ips.sig] = {}); };
  X.modes['ips-status'] = {
    prompt: () => '(config-sigdef-status)#',
    parent: 'ips-sig',
    tree: ['retired false', 'retired true', 'enabled true', 'enabled false'],
    run(dev, s, t, io, C) {
      const x = sigCfg(dev, s);
      const k = C.kw(t[0], 'retired', 1) ? 'retired' : C.kw(t[0], 'enabled', 2) ? 'enabled' : null;
      if (!k) { C.invalid(io, t[0]); return; }
      const v = bool(t[1]);
      if (v == null) { if (t[1]) C.invalid(io, t[1]); else C.incomplete(io); return; }
      C.withMutate(io, () => { x[k] = v; });
    },
  };
  X.modes['ips-engine'] = {
    prompt: () => '(config-sigdef-engine)#',
    parent: 'ips-sig',
    tree: ['event-action produce-alert', 'event-action deny-packet-inline', 'event-action reset-tcp-connection'],
    run(dev, s, t, io, C) {
      if (!C.kw(t[0], 'event-action', 2)) { C.invalid(io, t[0]); return; }
      const act = ['produce-alert', 'deny-packet-inline', 'deny-attacker-inline', 'reset-tcp-connection'].find((x) => C.kw(t[1], x, 6));
      if (!act) { if (t[1]) C.invalid(io, t[1]); else C.incomplete(io); return; }
      const x = sigCfg(dev, s);
      C.withMutate(io, () => { x.actions = x.actions || []; if (!x.actions.includes(act)) x.actions.push(act); });
    },
  };

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (!isRouter(dev) || !C.kw(a[0], 'ip', 2)) return false;
    const which = C.kw(a[1], 'inspect', 4) ? 'inspect' : C.kw(a[1], 'ips', 3) ? 'ips' : null;
    if (!which) return false;
    const name = a[2];
    const dir = /^in$/i.test(a[3] || '') ? 'in' : /^out$/i.test(a[3] || '') ? 'out' : null;
    if (!name || !dir) { C.incomplete(io); return true; }
    if (!neg && which === 'inspect' && !(dev.cbac && dev.cbac.rules[name])) io.out('% Правило ip inspect name ' + name + ' ещё не создано — сеансы не будут проверяться', 'hint');
    const ifs = targets.map((r) => C.ifaceOf(dev, r)).filter(Boolean);
    C.withMutate(io, () => {
      for (const f of ifs) {
        f[which] = f[which] || {};
        if (neg) delete f[which][dir]; else f[which][dir] = name;
        if (!Object.keys(f[which]).length) delete f[which];
      }
    });
    if (which === 'ips' && !neg) io.out('%IPS-6-ENGINE_BUILDS_STARTED: ' + (dev.clock ? dev.clock().replace(/\.\d+ UTC.*$/, '') : ''));
    return true;
  });

  X.running.global.push((dev) => {
    if (!isRouter(dev)) return [];
    const L = [];
    const c = dev.cbac;
    if (c) {
      if (c.audit) L.push('ip inspect audit-trail');
      for (const [n, r] of Object.entries(c.rules)) for (const p of r) L.push('ip inspect name ' + n + ' ' + p);
    }
    const i = dev.ips;
    if (i) {
      if (i.location) L.push('ip ips config location ' + i.location);
      if (i.notify) L.push('ip ips notify log');
      for (const n of i.names) L.push('ip ips name ' + n);
    }
    if (L.length) L.push('!');
    return L;
  });
  X.running.iface.push((dev, f) => {
    if (!f || !isRouter(dev)) return [];
    const L = [];
    for (const k of ['inspect', 'ips']) if (f[k]) for (const d of ['in', 'out']) if (f[k][d]) L.push(' ip ' + k + ' ' + f[k][d] + ' ' + d);
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!isRouter(dev) || !C.kw(a[0], 'ip', 2)) return false;
    if (C.kw(a[1], 'inspect', 4)) {
      const c = cbac(dev);
      const S = sessions(dev);
      const list = [...S.values()].filter((x) => dev.net.time - x.last < TIMEOUT[x.proto]);
      const sess = () => {
        io.out('Established Sessions');
        for (const x of list) io.out(' Session ' + x.key.replace(/\|/g, '').slice(0, 8).toLowerCase() + ' (' + U.ipStr(x.src) + ':' + x.sport + ')=>(' + U.ipStr(x.dst) + ':' + x.dport + ') ' + x.app + ' SIS_OPEN');
        if (!list.length) io.out(' (нет сеансов)');
      };
      if (C.kw(a[2], 'sessions', 1)) { sess(); return true; }
      const cfgOut = () => {
        io.out('Session audit trail is ' + (c.audit ? 'enabled' : 'disabled'));
        io.out('Session alert is enabled');
        io.out('one-minute (sampling period) thresholds are [unlimited : unlimited] connections');
        io.out('tcp idle-time is 3600 sec -- udp idle-time is 30 sec -- icmp idle-time is 10 sec');
        for (const [n, r] of Object.entries(c.rules)) {
          if (C.kw(a[2], 'name', 1) && a[3] !== n) continue;
          io.out('Inspection Rule Configuration');
          io.out(' Inspection name ' + n);
          for (const p of r) io.out('    ' + p + ' alert is on audit-trail is ' + (c.audit ? 'on' : 'off') + ' timeout ' + (p === 'icmp' ? 10 : p === 'udp' || p === 'dns' ? 30 : 3600));
        }
      };
      const ifOut = () => {
        io.out('Interface Configuration');
        for (const f of dev.ifaces) {
          if (!f.inspect) continue;
          io.out(' Interface ' + f.name);
          io.out('  Inbound inspection rule is ' + (f.inspect.in || 'not set'));
          io.out('  Outgoing inspection rule is ' + (f.inspect.out || 'not set'));
        }
      };
      if (C.kw(a[2], 'name', 1) || C.kw(a[2], 'config', 1)) { cfgOut(); return true; }
      if (C.kw(a[2], 'interfaces', 1)) { ifOut(); return true; }
      cfgOut(); ifOut(); sess();
      return true;
    }
    if (C.kw(a[1], 'ips', 3)) {
      const c = ips(dev);
      const ids = Object.keys(SIGS);
      const active = ids.filter((id) => sigState(c, id).active);
      if (C.kw(a[2], 'signatures', 2)) {
        io.out('Cisco SDF release version S364.0');
        io.out('Trend SDF release version V0.0');
        io.out('');
        for (const id of active) { const d = SIGS[id]; const st = sigState(c, id); io.out(id.replace('/', ' ') + '  ' + d.name + '  sev=' + d.sev + '  action=' + st.actions.join(',')); }
        io.out('');
        io.out('Total Signatures: ' + ids.length);
        io.out('    Total Enabled Signatures: ' + active.length);
        io.out('    Total Retired Signatures: ' + (ids.length - active.length));
        return true;
      }
      io.out('IPS Signature File Configuration Status');
      io.out('    Configured Config Locations: ' + (c.location || '(не задано)'));
      io.out('    Last signature default load time: ' + (dev.clock ? dev.clock() : ''));
      io.out('');
      io.out('IPS Syslog and SDEE Notification Status');
      io.out('    Event notification through syslog is ' + (c.notify ? 'enabled' : 'disabled'));
      io.out('    Event notification through SDEE is disabled');
      io.out('');
      io.out('IPS Signature Status');
      io.out('    Total Active Signatures: ' + active.length);
      io.out('    Total Inactive Signatures: ' + (ids.length - active.length));
      io.out('');
      io.out('IPS Packet Scanning and Interface Status');
      io.out('    IPS Rule Configuration');
      for (const n of c.names) io.out('      IPS name ' + n);
      io.out('    Interface Configuration');
      for (const f of dev.ifaces) {
        if (!f.ips) continue;
        io.out('      Interface ' + f.name);
        io.out('        Inbound IPS rule is ' + (f.ips.in || 'not set'));
        io.out('        Outgoing IPS rule is ' + (f.ips.out || 'not set'));
      }
      return true;
    }
    return false;
  });

  X.exec.push((dev, s, t, io, line, C) => {
    if (!isRouter(dev) || !C.kw(t[0], 'clear', 3) || !C.kw(t[1], 'ip', 2) || !C.kw(t[2], 'inspect', 4)) return null;
    sessions(dev).clear();
    return { handled: true };
  });

  NS.deviceExt.push({
    key: 'cbac',
    applies: isRouter,
    save(d) {
      const o = {};
      if (d.cbac && (Object.keys(d.cbac.rules).length || d.cbac.audit)) o.cbac = JSON.parse(JSON.stringify(d.cbac));
      if (d.ips && (d.ips.names.length || Object.keys(d.ips.sigs).length || Object.keys(d.ips.cats).length || d.ips.location || d.ips.notify)) o.ips = JSON.parse(JSON.stringify(d.ips));
      const ifs = {};
      for (const f of d.ifaces || []) if (f.inspect || f.ips) ifs[f.name] = { inspect: f.inspect || null, ips: f.ips || null };
      if (Object.keys(ifs).length) o.ifaces = ifs;
      return Object.keys(o).length ? o : null;
    },
    load(d, c) {
      c = c || {};
      d.cbac = c.cbac ? { rules: c.cbac.rules || {}, audit: !!c.cbac.audit } : null;
      d.ips = c.ips ? Object.assign({ names: [], location: '', notify: false, cats: {}, sigs: {} }, c.ips) : null;
      for (const f of d.ifaces || []) {
        const v = c.ifaces && c.ifaces[f.name];
        if (v && v.inspect) f.inspect = Object.assign({}, v.inspect); else delete f.inspect;
        if (v && v.ips) f.ips = Object.assign({}, v.ips); else delete f.ips;
      }
    },
  });

  IpNode.hooks.runtime.push(function () { this.cbacRt = new Map(); });

  X.tree.config = (X.tree.config || []).concat(['ip inspect name WORD tcp', 'ip inspect name WORD udp', 'ip inspect name WORD icmp', 'ip inspect audit-trail',
    'ip ips name WORD', 'ip ips config location flash:WORD', 'ip ips notify log', 'ip ips signature-category', 'ip ips signature-definition']);
  X.tree.if = (X.tree.if || []).concat(['ip inspect WORD in', 'ip inspect WORD out', 'ip ips WORD in', 'ip ips WORD out']);
  X.tree.exec = (X.tree.exec || []).concat(['show ip inspect sessions', 'show ip inspect all', 'show ip ips all', 'show ip ips signatures count', 'clear ip inspect sessions']);

  NS.cbac = { SIGS, sigState };
})(globalThis.NetLab = globalThis.NetLab || {});
