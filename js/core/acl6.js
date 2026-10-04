/* NetLab — списки доступа IPv6:
 * ipv6 access-list NAME → [sequence N] permit|deny ipv6|icmp|tcp|udp ИСТОЧНИК НАЗНАЧЕНИЕ [eq ПОРТ | тип ICMPv6] [log];
 * адрес — any | host X | X/длина; в конце неявно: permit icmp any any nd-na, permit icmp any any nd-ns, deny ipv6 any any.
 * ipv6 traffic-filter NAME in|out на интерфейсе, show ipv6 access-list [NAME], счётчики совпадений. */
(function (NS) {
  'use strict';

  const ip6 = NS.ip6;
  const IpNode = NS.IpNode;
  const P6 = IpNode.prototype;
  const X = NS.cliIos.ext;

  const ICMP6_TYPES = { 'echo-request': 'echo-request', 'echo-reply': 'echo-reply', 'nd-ns': 'ns', 'nd-na': 'na', 'router-solicitation': 'rs', 'router-advertisement': 'ra', unreachable: 'unreachable', 'time-exceeded': 'time-exceeded' };
  const PROTOS = ['ipv6', 'icmp', 'tcp', 'udp'];
  const PORT_NAMES = { www: 80, http: 80, ftp: 21, telnet: 23, smtp: 25, pop3: 110, domain: 53, tftp: 69, ssh: 22, https: 443, snmp: 161, ntp: 123 };

  function lists(dev) { if (!dev.acl6) dev.acl6 = {}; return dev.acl6; }

  /** Разбор адреса: any | host X | X/len. Возвращает { spec, next } или null. */
  function addr(a, i) {
    const w = String(a[i] || '').toLowerCase();
    if (w === 'any') return { spec: { any: true }, next: i + 1 };
    if (w === 'host') {
      const x = ip6.parse(a[i + 1] || '');
      return x == null ? null : { spec: { addr: x, plen: 128 }, next: i + 2 };
    }
    const p = ip6.parsePrefix(a[i] || '');
    return p ? { spec: { addr: ip6.net(p.addr, p.plen), plen: p.plen }, next: i + 1 } : null;
  }
  const addrStr = (s) => (s.any ? 'any' : s.plen === 128 ? 'host ' + ip6.str(s.addr, true) : ip6.cidr(s.addr, s.plen, true));
  const addrOk = (s, v) => s.any || (v != null && ip6.sameNet(v, s.addr, s.plen));

  function parseEntry(a) {
    let i = 0;
    let seq = null;
    if (/^seq/i.test(a[0] || '')) { seq = Number(a[1]); i = 2; }
    const action = /^p/i.test(a[i] || '') ? 'permit' : /^d/i.test(a[i] || '') ? 'deny' : null;
    if (!action) return { err: a[i] };
    const proto = PROTOS.find((x) => x === String(a[i + 1] || '').toLowerCase());
    if (!proto) return { err: a[i + 1] };
    const s = addr(a, i + 2);
    if (!s) return { err: a[i + 2] || '' };
    const d = addr(a, s.next);
    if (!d) return { err: a[s.next] || '' };
    const e = { seq, action, proto, src: s.spec, dst: d.spec, hits: 0 };
    let k = d.next;
    if ((proto === 'tcp' || proto === 'udp') && /^eq$/i.test(a[k] || '')) {
      const port = Number(a[k + 1]) || PORT_NAMES[String(a[k + 1]).toLowerCase()];
      if (!port) return { err: a[k + 1] || '' };
      e.port = Number(port);
      k += 2;
    }
    if (proto === 'icmp' && a[k] && ICMP6_TYPES[String(a[k]).toLowerCase()]) { e.icmp = String(a[k]).toLowerCase(); k++; }
    if (/^log$/i.test(a[k] || '')) { e.log = true; k++; }
    if (a[k]) return { err: a[k] };
    return { e };
  }

  function entryStr(e) {
    return e.action + ' ' + e.proto + ' ' + addrStr(e.src) + ' ' + addrStr(e.dst) + (e.port ? ' eq ' + e.port : '') + (e.icmp ? ' ' + e.icmp : '') + (e.log ? ' log' : '');
  }

  function matches(e, pkt) {
    if (!addrOk(e.src, pkt.src) || !addrOk(e.dst, pkt.dst)) return false;
    if (e.proto === 'ipv6') return true;
    if (e.proto === 'icmp') return pkt.next === 'ICMPv6' && (!e.icmp || (pkt.payload && pkt.payload.type === ICMP6_TYPES[e.icmp]));
    const l4 = pkt.next === (e.proto === 'tcp' ? 'TCP' : 'UDP') ? pkt.payload : null;
    return !!l4 && (!e.port || l4.dport === e.port);
  }

  /** Проверить пакет списком: { permit, entry } (с неявными правилами в конце). */
  function check(list, pkt) {
    for (const e of list) {
      if (matches(e, pkt)) { e.hits++; return { permit: e.action === 'permit', entry: e }; }
    }
    const nd = pkt.next === 'ICMPv6' && pkt.payload && (pkt.payload.type === 'ns' || pkt.payload.type === 'na');
    return { permit: nd, entry: null };
  }

  function filter(dev, f, dir, pkt) {
    const name = f && f.v6acl && f.v6acl[dir];
    if (!name) return null;
    const list = lists(dev)[name];
    if (!list) return null;
    const r = check(list, pkt);
    return r.permit ? null : name + (r.entry ? ' (' + r.entry.action + ' ' + r.entry.proto + ')' : ' (неявный deny ipv6 any any)');
  }

  // входящий фильтр — до обработки пакета
  const in6 = IpNode.ethertypes.IPv6;
  IpNode.ethertypes.IPv6 = function (f, frame) {
    const pkt = frame.payload;
    const why = pkt && filter(this, f, 'in', pkt);
    if (why) {
      this.drop(frame, 'Отброшено списком доступа IPv6 ' + why + ', входящий на ' + f.name);
      if (!(pkt.next === 'ICMPv6' && pkt.payload && pkt.payload.type !== 'echo-request') && this.icmp6Error) this.icmp6Error(pkt, 'unreachable', 1, f);
      return;
    }
    return in6.call(this, f, frame);
  };

  // исходящий — для пересылаемых пакетов (как в IOS: свои пакеты маршрутизатора не фильтруются)
  const fwd6 = P6.forward6;
  P6.forward6 = function (pkt, f, frame) {
    if (pkt.hop > 1) {
      const r = this.lookup6(pkt.dst);
      const why = r && filter(this, r.ifc, 'out', pkt);
      if (why) {
        this.drop(frame, 'Отброшено списком доступа IPv6 ' + why + ', исходящий на ' + r.ifc.name);
        this.icmp6Error(pkt, 'unreachable', 1, f);
        return;
      }
    }
    return fwd6.call(this, pkt, f, frame);
  };

  /* ---------- команды ---------- */

  // раньше общего обработчика команд «ipv6 …» из ipv6.js
  X.config.unshift((dev, s, a, neg, io, C) => {
    if (dev.type !== 'router' && dev.type !== 'switch') return false;
    if (!C.kw(a[0], 'ipv6', 4) || !C.kw(a[1], 'access-list', 3)) return false;
    const name = a[2];
    if (!name) { C.incomplete(io); return true; }
    if (neg) { C.withMutate(io, () => { delete lists(dev)[name]; }); return true; }
    if (!lists(dev)[name]) C.withMutate(io, () => { lists(dev)[name] = []; });
    s.mode = 'acl6';
    s.ctx = name;
    return true;
  });

  X.modes.acl6 = {
    prompt: () => '(config-ipv6-acl)#',
    tree: ['permit ipv6 any any', 'deny ipv6 any any', 'permit icmp any any echo-request', 'permit tcp any any eq WORD', 'deny ipv6 X:X::X/WORD any', 'sequence WORD permit ipv6 any any'],
    run(dev, s, t, io, C) {
      const list = lists(dev)[s.ctx];
      if (!list) return;
      if (C.kw(t[0], 'no', 2)) {
        if (/^seq/i.test(t[1] || '')) { const n = Number(t[2]); C.withMutate(io, () => { const i = list.findIndex((e) => e.seq === n); if (i >= 0) list.splice(i, 1); }); return; }
        const r = parseEntry(t.slice(1));
        if (!r.e) { C.invalid(io, r.err); return; }
        C.withMutate(io, () => { const i = list.findIndex((e) => entryStr(e) === entryStr(r.e)); if (i >= 0) list.splice(i, 1); });
        return;
      }
      if (C.kw(t[0], 'remark', 3)) return;
      const r = parseEntry(t);
      if (!r.e) { C.invalid(io, r.err); return; }
      C.withMutate(io, () => {
        const e = r.e;
        if (e.seq == null) e.seq = (list.length ? Math.max(...list.map((x) => x.seq)) : 0) + 10;
        const i = list.findIndex((x) => x.seq === e.seq);
        if (i >= 0) list.splice(i, 1);
        list.push(e);
        list.sort((x, y) => x.seq - y.seq);
      });
    },
  };

  X.iface.unshift((dev, s, a, neg, io, targets, C) => {
    if (!C.kw(a[0], 'ipv6', 4) || !C.kw(a[1], 'traffic-filter', 2)) return false;
    const name = a[2];
    const dir = /^in$/i.test(a[3] || '') ? 'in' : /^out$/i.test(a[3] || '') ? 'out' : null;
    if (!dir || (!name && !neg)) { C.incomplete(io); return true; }
    const ifs = targets.map((r) => C.ifaceOf(dev, r)).filter(Boolean);
    C.withMutate(io, () => {
      for (const f of ifs) {
        f.v6acl = f.v6acl || {};
        if (neg) delete f.v6acl[dir]; else f.v6acl[dir] = name;
        if (!Object.keys(f.v6acl).length) delete f.v6acl;
      }
    });
    return true;
  });

  X.running.global.push((dev) => {
    const L = [];
    for (const [n, list] of Object.entries(dev.acl6 || {})) {
      L.push('ipv6 access-list ' + n);
      for (const e of list) L.push(' ' + entryStr(e));
      L.push('!');
    }
    return L;
  });
  X.running.iface.push((dev, f) => {
    if (!f || !f.v6acl) return [];
    return ['in', 'out'].filter((d) => f.v6acl[d]).map((d) => ' ipv6 traffic-filter ' + f.v6acl[d] + ' ' + d);
  });

  X.show.unshift((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'ipv6', 4) || !C.kw(a[1], 'access-list', 3)) return false;
    for (const [n, list] of Object.entries(dev.acl6 || {})) {
      if (a[2] && a[2] !== n) continue;
      io.out('IPv6 access list ' + n);
      for (const e of list) io.out('    ' + entryStr(e) + (e.hits ? ' (' + e.hits + ' match' + (e.hits > 1 ? 'es' : '') + ')' : '') + ' sequence ' + e.seq);
    }
    return true;
  });

  NS.deviceExt.push({
    key: 'acl6',
    applies: (d) => d.type === 'router' || d.type === 'switch',
    save(d) {
      const ls = d.acl6 && Object.keys(d.acl6).length ? Object.fromEntries(Object.entries(d.acl6).map(([n, l]) => [n, l.map(entryStr).map((x, i) => ({ seq: l[i].seq, text: x }))])) : null;
      const ifs = {};
      for (const f of d.ifaces || []) if (f.v6acl) ifs[f.name] = Object.assign({}, f.v6acl);
      return ls || Object.keys(ifs).length ? { lists: ls || {}, ifaces: ifs } : null;
    },
    load(d, c) {
      d.acl6 = {};
      for (const [n, l] of Object.entries((c && c.lists) || {})) {
        d.acl6[n] = [];
        for (const x of l) { const r = parseEntry(String(x.text).split(/\s+/)); if (r.e) { r.e.seq = x.seq; d.acl6[n].push(r.e); } }
      }
      for (const f of d.ifaces || []) {
        const v = c && c.ifaces && c.ifaces[f.name];
        if (v) f.v6acl = Object.assign({}, v); else delete f.v6acl;
      }
    },
  });

  X.tree.config = (X.tree.config || []).concat(['ipv6 access-list WORD']);
  X.tree.if = (X.tree.if || []).concat(['ipv6 traffic-filter WORD in', 'ipv6 traffic-filter WORD out']);
  X.tree.exec = (X.tree.exec || []).concat(['show ipv6 access-list']);

  NS.acl6 = { parseEntry, entryStr, check };
})(globalThis.NetLab = globalThis.NetLab || {});
