/* NetLab — межсетевой экран на основе зон (Zone-Based Policy Firewall, IOS):
 * zone security, class-map type inspect (match protocol / match access-group), policy-map type inspect
 * (inspect | pass | drop), zone-pair security … service-policy, zone-member security на интерфейсах.
 * Правила: между интерфейсами без зон — как обычно; зона ↔ не зона — запрещено; одна зона — разрешено;
 * разные зоны — только по политике zone-pair; inspect запоминает сеанс и пропускает ответный трафик. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const IpNode = NS.IpNode;
  const X = NS.cliIos.ext;

  const PROTOS = {
    icmp: (p) => p.proto === 'ICMP',
    tcp: (p) => p.proto === 'TCP',
    udp: (p) => p.proto === 'UDP',
    http: (p) => p.proto === 'TCP' && port(p) === 80,
    https: (p) => p.proto === 'TCP' && port(p) === 443,
    dns: (p) => (p.proto === 'UDP' || p.proto === 'TCP') && port(p) === 53,
    ftp: (p) => p.proto === 'TCP' && port(p) === 21,
    telnet: (p) => p.proto === 'TCP' && port(p) === 23,
    ssh: (p) => p.proto === 'TCP' && port(p) === 22,
    smtp: (p) => p.proto === 'TCP' && port(p) === 25,
    pop3: (p) => p.proto === 'TCP' && port(p) === 110,
    tftp: (p) => p.proto === 'UDP' && port(p) === 69,
    ntp: (p) => p.proto === 'UDP' && port(p) === 123,
    snmp: (p) => p.proto === 'UDP' && port(p) === 161,
  };
  function port(p) { return p.payload && p.payload.dport; }

  function cfg(dev) {
    if (!dev.zbf) dev.zbf = { zones: {}, classes: {}, policies: {}, pairs: {} };
    return dev.zbf;
  }
  const active = (dev) => !!dev.zbf && Object.keys(dev.zbf.zones).length > 0;

  /** Ключ сеанса и обратный ключ. */
  function keyOf(p) {
    const pl = p.payload || {};
    if (p.proto === 'ICMP') return 'ICMP|' + p.src + '|' + p.dst + '|' + (pl.id != null ? pl.id : 0);
    return p.proto + '|' + p.src + '|' + p.dst + '|' + (pl.sport || 0) + '|' + (pl.dport || 0);
  }
  function revKeyOf(p) {
    const pl = p.payload || {};
    // обратно по ICMP-сеансу проходят только эхо-ответы (новый эхо-запрос снаружи — не ответ)
    if (p.proto === 'ICMP') return pl.type === 'echo-reply' ? 'ICMP|' + p.dst + '|' + p.src + '|' + (pl.id != null ? pl.id : 0) : null;
    return p.proto + '|' + p.dst + '|' + p.src + '|' + (pl.dport || 0) + '|' + (pl.sport || 0);
  }

  function classMatches(dev, c, p) {
    const hit = (r) => {
      if (r.kind === 'protocol') return !!(PROTOS[r.proto] && PROTOS[r.proto](p));
      if (r.kind === 'acl') { const acl = dev.acls.get(String(r.acl)); return !!acl && acl.check(p).permit; }
      return false;
    };
    if (!c.rules.length) return false;
    return c.match === 'all' ? c.rules.every(hit) : c.rules.some(hit);
  }

  /** Решение для транзитного пакета: { ok, why, session } */
  function decide(dev, p, inIf, outIf) {
    const zi = inIf.zone || null;
    const zo = outIf.zone || null;
    if (!zi && !zo) return { ok: true };
    const sess = dev.zbfSessions || (dev.zbfSessions = new Map());
    // ответ в рамках сеанса inspect
    const back = sess.get(revKeyOf(p));
    if (back) { back.pkts++; back.time = dev.net.time; return { ok: true, why: 'ответ в сеансе ' + back.pair }; }
    if (p.proto === 'ICMP' && p.payload && p.payload.original) {
      const o = p.payload.original;
      if (sess.get(keyOf(o))) return { ok: true, why: 'ICMP-ошибка по сеансу' };
    }
    if (!zi || !zo) return { ok: false, why: 'интерфейс ' + (zi ? outIf.name : inIf.name) + ' не входит ни в одну зону, а ' + (zi ? inIf.name : outIf.name) + ' — в зоне ' + (zi || zo) + ': трафик между зоной и «без зоны» запрещён' };
    if (zi === zo) return { ok: true };
    const z = dev.zbf;
    const pair = Object.entries(z.pairs).find(([, x]) => x.src === zi && x.dst === zo);
    if (!pair) return { ok: false, why: 'нет zone-pair ' + zi + ' → ' + zo + ': между зонами по умолчанию всё запрещено' };
    const [pname, pr] = pair;
    const pol = pr.policy && z.policies[pr.policy];
    if (!pol) return { ok: false, why: 'у zone-pair ' + pname + ' нет service-policy type inspect' };
    for (const e of pol) {
      const hit = e.cls === 'class-default' ? true : z.classes[e.cls] && classMatches(dev, z.classes[e.cls], p);
      if (!hit) continue;
      if (e.action === 'drop' || !e.action) {
        if (e.log && dev.iosLog) dev.iosLog('FW', 6, 'DROP_PKT', 'Dropping ' + p.proto.toLowerCase() + ' session ' + U.ipStr(p.src) + ' ' + U.ipStr(p.dst) + ' on zone-pair ' + pname + ' class ' + e.cls + ' with ip ident 0');
        return { ok: false, why: 'политика ' + pr.policy + ', класс ' + e.cls + ': drop' };
      }
      if (e.action === 'pass') return { ok: true, why: 'политика ' + pr.policy + ', класс ' + e.cls + ': pass (без сеанса)' };
      const k = keyOf(p);
      if (!sess.has(k)) sess.set(k, { key: k, src: p.src, dst: p.dst, proto: p.proto, sport: p.payload && (p.payload.sport != null ? p.payload.sport : p.payload.id), dport: p.payload && (p.payload.dport != null ? p.payload.dport : 0), pair: pname, cls: e.cls, policy: pr.policy, pkts: 0, time: dev.net.time, id: 1000 + sess.size });
      sess.get(k).pkts++;
      return { ok: true, why: 'политика ' + pr.policy + ', класс ' + e.cls + ': inspect — сеанс запомнен, ответы пропускаются' };
    }
    return { ok: false, why: 'политика ' + pr.policy + ': class-default — drop' };
  }

  IpNode.hooks.forward.push(function (pkt, f, frame) {
    if (!active(this) || this.type === 'asa') return false;
    const r = this.lookup(pkt.dst);
    if (!r) return false;
    const d = decide(this, pkt, f, r.ifc);
    if (d.ok) return false;
    this.drop(frame, 'Zone-Based Firewall: ' + d.why);
    return true;
  });

  // сброс сеансов при выключении
  IpNode.hooks.runtime.push(function () { this.zbfSessions = null; });

  /* ================= сохранение ================= */

  NS.deviceExt.push({
    key: 'zbf',
    applies: (d) => d.type === 'router',
    save(d) {
      const z = d.zbf;
      if (!z || (!Object.keys(z.zones).length && !Object.keys(z.classes).length && !Object.keys(z.policies).length && !Object.keys(z.pairs).length)) return null;
      return JSON.parse(JSON.stringify(z));
    },
    load(d, c) {
      d.zbf = c ? { zones: c.zones || {}, classes: c.classes || {}, policies: c.policies || {}, pairs: c.pairs || {} } : null;
    },
  });

  IpNode.ifaceExt.push({
    key: 'zone',
    save(f) { return f.zone || null; },
    load(f, d) { f.zone = d ? String(d) : null; },
  });

  /* ================= команды IOS ================= */

  const isR = (dev) => dev.type === 'router';

  X.global.push((t) => /^(zone|zone-pair|class-map|policy-map)$/i.test(t[0] || '') && !/^member$/i.test(t[1] || ''));

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isR(dev)) return false;
    const z = () => cfg(dev);
    if (C.kw(a[0], 'zone', 4) && C.kw(a[1], 'security', 1)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return true; }
      if (/^self$/i.test(name)) { io.out('% Зона self создаётся автоматически'); return true; }
      if (neg) {
        if (dev.ifaces.some((f) => f.zone === name)) { io.out('% Remove all interfaces from zone ' + name + ' first'); return true; }
        C.withMutate(io, () => { delete z().zones[name]; });
        return true;
      }
      if (!z().zones[name]) C.withMutate(io, () => { z().zones[name] = { desc: '' }; });
      s.mode = 'zbf-zone';
      s.zbfName = name;
      return true;
    }
    if (C.kw(a[0], 'zone-pair', 6) && C.kw(a[1], 'security', 1)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { delete z().pairs[name]; }); return true; }
      const si = a.findIndex((x) => C.kw(x, 'source', 1));
      const di = a.findIndex((x) => C.kw(x, 'destination', 1));
      const src = si > 0 ? a[si + 1] : null;
      const dst = di > 0 ? a[di + 1] : null;
      const ex = z().pairs[name];
      if (!ex && (!src || !dst)) { C.incomplete(io); return true; }
      for (const zn of [src, dst]) if (zn && !/^self$/i.test(zn) && !z().zones[zn]) { io.out('% Zone ' + zn + ' does not exist'); return true; }
      if (src && dst && src === dst) { io.out('% Source and destination zone must be different'); return true; }
      C.withMutate(io, () => { z().pairs[name] = Object.assign(ex || { policy: null }, src ? { src, dst } : {}); });
      s.mode = 'zbf-pair';
      s.zbfName = name;
      return true;
    }
    if (C.kw(a[0], 'class-map', 3)) {
      if (!C.kw(a[1], 'type', 1) || !C.kw(a[2], 'inspect', 1)) { io.out('% В NetLab поддерживается class-map type inspect (межсетевой экран на основе зон)'); return true; }
      let i = 3;
      let match = 'all';
      if (C.kw(a[i], 'match-any', 7)) { match = 'any'; i++; } else if (C.kw(a[i], 'match-all', 7)) i++;
      const name = a[i];
      if (!name) { C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { delete z().classes[name]; }); return true; }
      C.withMutate(io, () => { if (!z().classes[name]) z().classes[name] = { match, rules: [] }; else z().classes[name].match = match; });
      s.mode = 'zbf-cmap';
      s.zbfName = name;
      return true;
    }
    if (C.kw(a[0], 'policy-map', 3)) {
      if (!C.kw(a[1], 'type', 1) || !C.kw(a[2], 'inspect', 1)) { io.out('% В NetLab поддерживается policy-map type inspect (межсетевой экран на основе зон)'); return true; }
      const name = a[3];
      if (!name) { C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { delete z().policies[name]; }); return true; }
      if (!z().policies[name]) C.withMutate(io, () => { z().policies[name] = []; });
      s.mode = 'zbf-pmap';
      s.zbfName = name;
      return true;
    }
    if (C.kw(a[0], 'license', 3)) return true; // license boot module … securityk9 — принимаем
    return false;
  });

  X.modes['zbf-zone'] = {
    prompt: () => '(config-sec-zone)#',
    tree: ['description LINE'],
    run(dev, s, t, io, C) {
      const zn = cfg(dev).zones[s.zbfName];
      if (!zn) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'description', 1)) { C.withMutate(io, () => { zn.desc = neg ? '' : a.slice(1).join(' '); }); return; }
      C.invalid(io, a[0]);
    },
  };

  X.modes['zbf-pair'] = {
    prompt: () => '(config-sec-zone-pair)#',
    tree: ['service-policy type inspect WORD'],
    run(dev, s, t, io, C) {
      const pr = cfg(dev).pairs[s.zbfName];
      if (!pr) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'service-policy', 2)) {
        const name = a[a.length - 1];
        if (!neg && !C.kw(a[1], 'type', 1)) { C.incomplete(io); return; }
        if (!neg && !cfg(dev).policies[name]) { io.out('% Policy-map ' + name + ' does not exist'); return; }
        C.withMutate(io, () => { pr.policy = neg ? null : name; });
        return;
      }
      if (C.kw(a[0], 'description', 1)) return;
      C.invalid(io, a[0]);
    },
  };

  X.modes['zbf-cmap'] = {
    prompt: () => '(config-cmap)#',
    tree: ['match protocol icmp', 'match protocol http', 'match protocol tcp', 'match protocol udp', 'match protocol dns', 'match access-group WORD'],
    run(dev, s, t, io, C) {
      const c = cfg(dev).classes[s.zbfName];
      if (!c) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (!C.kw(a[0], 'match', 1)) { if (C.kw(a[0], 'description', 1)) return; C.invalid(io, a[0]); return; }
      let rule;
      if (C.kw(a[1], 'protocol', 1)) {
        const pn = String(a[2] || '').toLowerCase();
        if (!PROTOS[pn]) { if (!a[2]) C.incomplete(io); else C.invalid(io, a[2]); return; }
        rule = { kind: 'protocol', proto: pn };
      } else if (C.kw(a[1], 'access-group', 1)) {
        const acl = C.kw(a[2], 'name', 1) ? a[3] : a[2];
        if (!acl) { C.incomplete(io); return; }
        rule = { kind: 'acl', acl: String(acl) };
      } else { C.invalid(io, a[1]); return; }
      C.withMutate(io, () => {
        const same = (r) => r.kind === rule.kind && r.proto === rule.proto && r.acl === rule.acl;
        c.rules = c.rules.filter((r) => !same(r));
        if (!neg) c.rules.push(rule);
      });
    },
  };

  X.modes['zbf-pmap'] = {
    prompt: () => '(config-pmap)#',
    tree: ['class type inspect WORD', 'class class-default'],
    run(dev, s, t, io, C) {
      const pol = cfg(dev).policies[s.zbfName];
      if (!pol) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (!C.kw(a[0], 'class', 1)) { C.invalid(io, a[0]); return; }
      const name = C.kw(a[1], 'class-default', 7) ? 'class-default' : C.kw(a[1], 'type', 1) && C.kw(a[2], 'inspect', 1) ? a[3] : null;
      if (!name) { C.incomplete(io); return; }
      if (name !== 'class-default' && !cfg(dev).classes[name]) { io.out('% Class-map ' + name + ' does not exist'); return; }
      if (neg) { C.withMutate(io, () => { const i = pol.findIndex((e) => e.cls === name); if (i >= 0) pol.splice(i, 1); }); return; }
      C.withMutate(io, () => {
        if (!pol.some((e) => e.cls === name)) {
          const e = { cls: name, action: name === 'class-default' ? 'drop' : null, log: false };
          // class-default всегда последний
          const di = pol.findIndex((x) => x.cls === 'class-default');
          if (di >= 0 && name !== 'class-default') pol.splice(di, 0, e); else pol.push(e);
        }
      });
      s.mode = 'zbf-pmapc';
      s.zbfClass = name;
    },
  };

  X.modes['zbf-pmapc'] = {
    parent: 'zbf-pmap',
    prompt: () => '(config-pmap-c)#',
    tree: ['inspect', 'pass', 'drop', 'drop log'],
    run(dev, s, t, io, C) {
      const pol = cfg(dev).policies[s.zbfName];
      const e = pol && pol.find((x) => x.cls === s.zbfClass);
      if (!e) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      const act = ['inspect', 'pass', 'drop'].find((x) => C.kw(a[0], x, 1));
      if (act) { C.withMutate(io, () => { e.action = neg ? null : act; e.log = !neg && act === 'drop' && a.some((x) => C.kw(x, 'log', 1)); }); return; }
      if (C.kw(a[0], 'class', 1)) { s.mode = 'zbf-pmap'; X.modes['zbf-pmap'].run(dev, s, t, io, C); return; }
      C.invalid(io, a[0]);
    },
  };

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (!isR(dev) || !C.kw(a[0], 'zone-member', 6)) return false;
    if (!C.kw(a[1], 'security', 1)) { C.incomplete(io); return true; }
    const name = a[2];
    const ifs = targets.map((r) => C.ifaceOf(dev, r)).filter(Boolean);
    if (!neg && !name) { C.incomplete(io); return true; }
    if (!neg && !(dev.zbf && dev.zbf.zones[name])) { io.out('% Zone ' + name + ' does not exist'); return true; }
    C.withMutate(io, () => { for (const f of ifs) f.zone = neg ? null : name; });
    if (dev.zbfSessions) dev.zbfSessions.clear();
    return true;
  });

  X.running.global.push((dev) => {
    const z = dev.zbf;
    if (!z) return [];
    const L = [];
    for (const [k, c] of Object.entries(z.classes)) {
      L.push('class-map type inspect match-' + c.match + ' ' + k);
      for (const r of c.rules) L.push(r.kind === 'protocol' ? ' match protocol ' + r.proto : ' match access-group name ' + r.acl);
      L.push('!');
    }
    for (const [k, pol] of Object.entries(z.policies)) {
      L.push('policy-map type inspect ' + k);
      for (const e of pol) {
        L.push(e.cls === 'class-default' ? ' class class-default' : ' class type inspect ' + e.cls);
        if (e.action) L.push('  ' + e.action + (e.log ? ' log' : ''));
      }
      L.push('!');
    }
    for (const [k, zn] of Object.entries(z.zones)) {
      L.push('zone security ' + k);
      if (zn.desc) L.push(' description ' + zn.desc);
    }
    for (const [k, p] of Object.entries(z.pairs)) {
      L.push('zone-pair security ' + k + ' source ' + p.src + ' destination ' + p.dst);
      if (p.policy) L.push(' service-policy type inspect ' + p.policy);
    }
    if (Object.keys(z.zones).length || Object.keys(z.pairs).length) L.push('!');
    return L;
  });

  X.running.iface.push((dev, f) => (f && f.zone ? [' zone-member security ' + f.zone] : []));

  X.show.push((dev, s, a, io, C) => {
    if (!isR(dev)) return false;
    const z = dev.zbf || { zones: {}, classes: {}, policies: {}, pairs: {} };
    if (C.kw(a[0], 'zone', 4) && C.kw(a[1], 'security', 1)) {
      io.out('zone self');
      io.out('  Description: System defined zone');
      io.out('');
      for (const [k, zn] of Object.entries(z.zones)) {
        io.out('zone ' + k);
        if (zn.desc) io.out('  Description: ' + zn.desc);
        const mem = dev.ifaces.filter((f) => f.zone === k);
        if (mem.length) { io.out('  Member Interfaces:'); for (const f of mem) io.out('    ' + f.name); }
        io.out('');
      }
      return true;
    }
    if (C.kw(a[0], 'zone-pair', 6)) {
      for (const [k, p] of Object.entries(z.pairs)) {
        io.out('Zone-pair name ' + k);
        io.out('    Source-Zone ' + p.src + '  Destination-Zone ' + p.dst);
        io.out('    service-policy ' + (p.policy || 'not configured'));
      }
      return true;
    }
    if (C.kw(a[0], 'class-map', 3) && C.kw(a[1], 'type', 1)) {
      for (const [k, c] of Object.entries(z.classes)) {
        io.out(' Class Map type inspect match-' + c.match + ' ' + k + ' (id 1)');
        for (const r of c.rules) io.out('   Match ' + (r.kind === 'protocol' ? 'protocol ' + r.proto : 'access-group name ' + r.acl));
        io.out('');
      }
      return true;
    }
    if (C.kw(a[0], 'policy-map', 3) && C.kw(a[1], 'type', 1)) {
      if (C.kw(a[3], 'zone-pair', 6)) {
        const sess = dev.zbfSessions ? [...dev.zbfSessions.values()] : [];
        for (const [k, p] of Object.entries(z.pairs)) {
          if (!p.policy) continue;
          io.out('');
          io.out('policy exists on zp ' + k);
          io.out('  Zone-pair: ' + k);
          io.out('');
          io.out('  Service-policy inspect : ' + p.policy);
          for (const e of z.policies[p.policy] || []) {
            io.out('');
            io.out('    Class-map: ' + e.cls + ' (match-' + (e.cls === 'class-default' ? 'any' : (z.classes[e.cls] || {}).match) + ')');
            io.out('      ' + ({ inspect: 'Inspect', pass: 'Pass', drop: 'Drop' }[e.action] || 'Drop'));
            const list = sess.filter((x) => x.pair === k && x.cls === e.cls);
            if (e.action === 'inspect') {
              io.out('        Established Sessions');
              for (const x of list) io.out('         Session ' + x.id + ' (' + U.ipStr(x.src) + ':' + (x.sport || 0) + ')=>(' + U.ipStr(x.dst) + ':' + (x.dport || 0) + ') ' + x.proto.toLowerCase() + ' SIS_OPEN');
            }
          }
        }
        return true;
      }
      for (const [k, pol] of Object.entries(z.policies)) {
        io.out('  Policy Map type inspect ' + k);
        for (const e of pol) io.out('    Class ' + e.cls + '\n      ' + ({ inspect: 'Inspect', pass: 'Pass', drop: 'Drop' }[e.action] || 'Drop') + (e.log ? ' log' : ''));
      }
      return true;
    }
    return false;
  });

  X.exec.push((dev, s, t, io, line, C) => {
    if (s.mode !== 'exec' || !C.kw(t[0], 'clear', 3) || !C.kw(t[1], 'zone-pair', 6)) return null;
    if (dev.zbfSessions) dev.zbfSessions.clear();
    return { handled: true };
  });

  X.tree.config = (X.tree.config || []).concat(['zone security WORD', 'zone-pair security WORD source WORD destination WORD', 'class-map type inspect match-any WORD', 'policy-map type inspect WORD']);
  X.tree.if = (X.tree.if || []).concat(['zone-member security WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show zone security', 'show zone-pair security', 'show class-map type inspect', 'show policy-map type inspect', 'show policy-map type inspect zone-pair sessions']);

  NS.zbf = { decide, keyOf, revKeyOf, PROTOS, cfg };
})(globalThis.NetLab = globalThis.NetLab || {});
