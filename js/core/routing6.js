/* NetLab — динамическая маршрутизация IPv6 и DHCPv6:
 *  • RIPng (ipv6 router rip, ipv6 rip NAME enable, default-information originate, redistribute);
 *  • OSPFv3 (ipv6 router ospf, ipv6 ospf PID area N, router-id, cost, passive-interface, O / OI / OE2);
 *  • DHCPv6-сервер на маршрутизаторе (ipv6 dhcp pool, ipv6 dhcp server, флаги M и O в RA):
 *    с сохранением состояния (адрес) и без него (только DNS и домен);
 *  • DHCPv6-клиент на компьютере (режим «Автоматически (DHCPv6)», ipconfig /renew6).
 * Соседи и маршруты вычисляются вместе с IPv4 (NS.routing.compute), следующий переход — link-local соседа. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const ip6 = NS.ip6;
  const R0 = NS.routing;
  const X = NS.cliIos.ext;
  const P6 = IpNode.prototype;
  const up = (v) => ip6.str(v, true);
  const ALL_DHCP = ip6.parse('ff02::1:2');
  const DHCP_RETRY = 100;
  const INF = 16;

  const on = (f) => !!f.v6 && (f.v6.enabled || f.v6.autoconfig || f.v6.dhcp || f.v6.addrs.length > 0 || f.v6.llManual != null);
  function r6(f) {
    if (!f.v6r) f.v6r = { rip: null, ripDefault: null, ospf: null, cost: null, dhcpServer: null, ndM: false, ndO: false };
    return f.v6r;
  }
  const globals = (f) => (f.v6 ? f.v6.addrs.filter((a) => !ip6.isLinkLocal(a.addr)) : []);
  const pfxOf = (f) => globals(f).map((a) => ({ net: ip6.net(a.addr, a.plen), plen: a.plen }));
  const key6 = (net, plen) => net.toString(16) + '/' + plen;

  function pointKey(dev, f) {
    if (f.kind === 'svi') return dev.id + '|svi|' + f.vlan;
    return dev.id + '|' + f.port + '|' + (f.kind === 'sub' ? f.vlan : 'u');
  }

  /** Соседство на канале: интерфейсы, видящие друг друга на 2-м уровне и включённые в одном «домене». */
  function adjacencies6(net, devs, enabled, passive) {
    const pts = [];
    for (const d of devs) {
      for (const f of d.ifaces) {
        if (f.kind === 'loop' || !on(f) || !d.ifaceUp(f)) continue;
        const en = enabled(d, f);
        if (en == null || en === false) continue;
        pts.push({ dev: d, f, dom: String(en), key: pointKey(d, f), reach: null });
      }
    }
    for (const p of pts) p.reach = R0.reach(net, p.dev, p.f);
    const edges = [];
    for (const a of pts) {
      for (const b of pts) {
        if (a === b || a.dev === b.dev || a.dom !== b.dom || !a.reach.has(b.key)) continue;
        if (passive && (passive(a.dev, a.f) || passive(b.dev, b.f))) continue;
        edges.push({ from: a.dev, fIf: a.f, to: b.dev, tIf: b.f });
      }
    }
    return edges;
  }

  const routing6 = (d) => d.power && d.ifaces && d.forwarding6 && d.forwarding6();

  /* ================= RIPng ================= */

  function ripOn(d, f) { return !!d.ripng && f.v6r && f.v6r.rip === d.ripng.name; }

  function redist6(d, cfg) {
    const out = [];
    for (const src of (cfg && cfg.redist) || []) {
      if (src === 'static') for (const r of d.v6cfg().routes) out.push({ net: r.net, plen: r.plen });
      if (src === 'connected') for (const f of d.ifaces) if (on(f) && d.ifaceUp(f)) for (const a of globals(f)) out.push({ net: ip6.net(a.addr, a.plen), plen: a.plen });
    }
    return out;
  }

  function computeRipng(net, devs) {
    const rdevs = devs.filter((d) => d.ripng);
    const edges = adjacencies6(net, rdevs, (d, f) => (ripOn(d, f) ? 'rip' : null));
    // объявления: свои сети (метрика 1), редистрибуция, маршрут по умолчанию на интерфейсе
    const tables = new Map(rdevs.map((d) => [d, new Map()]));
    const own = new Map();
    for (const d of rdevs) {
      const m = new Map();
      for (const f of d.ifaces) if (ripOn(d, f) && on(f) && d.ifaceUp(f)) for (const p of pfxOf(f)) m.set(key6(p.net, p.plen), p);
      for (const p of redist6(d, d.ripng)) if (!m.has(key6(p.net, p.plen))) m.set(key6(p.net, p.plen), p);
      own.set(d, m);
    }
    for (let round = 0; round < INF; round++) {
      let changed = false;
      const next = new Map(rdevs.map((d) => [d, new Map()]));
      for (const e of edges) {
        // R = e.from учится у N = e.to через свой интерфейс e.fIf
        const R = e.from;
        const N = e.to;
        const nh = N.ll6(e.tIf);
        const adv = [];
        for (const p of own.get(N).values()) adv.push({ net: p.net, plen: p.plen, metric: 1 });
        if (e.tIf.v6r && e.tIf.v6r.ripDefault) adv.push({ net: 0n, plen: 0, metric: 1 });
        for (const [k, list] of tables.get(N)) {
          if (own.get(N).has(k)) continue;
          if (list.some((x) => x.ifc === e.tIf)) continue; // split horizon
          if (e.tIf.v6r && e.tIf.v6r.ripDefault === 'only' && list[0].plen !== 0) continue;
          adv.push({ net: list[0].net, plen: list[0].plen, metric: list[0].metric });
        }
        const t = next.get(R);
        for (const a of adv) {
          const k = key6(a.net, a.plen);
          if (own.get(R).has(k) && a.plen !== 0) continue;
          if (R.ifaces.some((f) => on(f) && R.ifaceUp(f) && globals(f).some((x) => x.plen === a.plen && ip6.net(x.addr, x.plen) === a.net))) continue;
          const m = a.metric + 1;
          if (m >= INF) continue;
          const cur = t.get(k);
          const route = { type: 'R', sub: '', ad: 120, metric: m, net: a.net, plen: a.plen, nextHop: nh, ifc: e.fIf, from: N };
          if (!cur || m < cur[0].metric) t.set(k, [route]);
          else if (m === cur[0].metric && cur.length < 4 && !cur.some((x) => x.nextHop === nh && x.ifc === e.fIf)) cur.push(route);
        }
      }
      for (const d of rdevs) {
        const a = [...tables.get(d)].map(([k, l]) => k + l.map((x) => x.metric + '@' + x.nextHop).join()).sort().join('|');
        const b = [...next.get(d)].map(([k, l]) => k + l.map((x) => x.metric + '@' + x.nextHop).join()).sort().join('|');
        if (a !== b) changed = true;
      }
      for (const [d, t] of next) tables.set(d, t);
      if (!changed) break;
    }
    for (const d of rdevs) {
      d.ripngNeighbors = edges.filter((e) => e.from === d).map((e) => ({ ll: e.to.ll6(e.tIf), ifname: e.fIf.name, dev: e.to }));
    }
    const out = new Map();
    for (const d of rdevs) out.set(d, [].concat(...tables.get(d).values()));
    return out;
  }

  /* ================= OSPFv3 ================= */

  function ospf6Rid(d) {
    const c = d.ospf6;
    if (!c) return 0;
    if (c.routerId != null) return c.routerId;
    const loops = d.ifaces.filter((f) => f.kind === 'loop' && f.ip != null && f.adminUp).map((f) => f.ip);
    if (loops.length) return Math.max(...loops);
    const ips = d.ifaces.filter((f) => f.ip != null && d.ifaceUp(f)).map((f) => f.ip);
    return ips.length ? Math.max(...ips) : 0;
  }
  function ospfOn(d, f) { return d.ospf6 && f.v6r && f.v6r.ospf && f.v6r.ospf.pid === d.ospf6.pid ? f.v6r.ospf.area : null; }
  function cost6(d, f) { return f.v6r && f.v6r.cost != null ? f.v6r.cost : R0.ifaceCost(d, f); }
  const passive6 = (d, f) => !!d.ospf6 && (d.ospf6.passive || []).some((n) => n.toLowerCase() === f.name.toLowerCase());

  function computeOspf6(net, devs) {
    const odevs = devs.filter((d) => d.ospf6 && ospf6Rid(d));
    for (const d of devs) if (d.ospf6 && !ospf6Rid(d)) d.ospf6Neighbors = [];
    const edges = adjacencies6(net, odevs, ospfOn, passive6);
    const out = new Map(odevs.map((d) => [d, []]));
    for (const d of odevs) {
      d.ospf6Neighbors = edges.filter((e) => e.from === d).map((e) => {
        const seg = edges.filter((x) => x.from === d && x.fIf === e.fIf).map((x) => x.to).concat([d]);
        const ids = seg.map(ospf6Rid).sort((a, b) => b - a);
        const rid = ospf6Rid(e.to);
        const p2p = seg.length === 2 && d.isSerial && d.isSerial(e.fIf);
        return { id: rid, ll: e.to.ll6(e.tIf), ifname: e.fIf.name, dev: e.to, intfId: e.to.ifaces.indexOf(e.tIf) + 1, area: ospfOn(d, e.fIf), state: 'FULL/' + (p2p ? ' -' : rid === ids[0] ? 'DR' : rid === ids[1] ? 'BDR' : 'DROTHER') };
      });
    }
    const areasOf = (Xd) => new Set(Xd.ifaces.map((f) => (on(f) && Xd.ifaceUp(f) ? ospfOn(Xd, f) : null)).filter((a) => a != null).map(String));
    for (const R of odevs) {
      const dist = new Map([[R, 0]]);
      const first = new Map();
      const done = new Set();
      for (;;) {
        let u = null;
        for (const [n, dv] of dist) if (!done.has(n) && (u === null || dv < dist.get(u))) u = n;
        if (!u) break;
        done.add(u);
        for (const e of edges) {
          if (e.from !== u) continue;
          const c = dist.get(u) + cost6(u, e.fIf);
          if (!dist.has(e.to) || c < dist.get(e.to)) {
            dist.set(e.to, c);
            first.set(e.to, u === R ? { ifc: e.fIf, nh: e.to.ll6(e.tIf) } : first.get(u));
          }
        }
      }
      const mine = areasOf(R);
      const best = new Map();
      const put = (k, r) => { const cur = best.get(k); if (!cur || r.rank < cur.rank || (r.rank === cur.rank && r.metric < cur.metric)) best.set(k, r); };
      const connected = (net0, plen) => R.ifaces.some((g) => on(g) && R.ifaceUp(g) && globals(g).some((a) => a.plen === plen && ip6.net(a.addr, a.plen) === net0));
      for (const [Xd, dx] of dist) {
        if (Xd === R) continue;
        const hop = first.get(Xd);
        for (const f of Xd.ifaces) {
          const area = on(f) && Xd.ifaceUp(f) ? ospfOn(Xd, f) : null;
          if (area == null) continue;
          for (const a of globals(f)) {
            const plen = f.kind === 'loop' ? 128 : a.plen;
            const n = f.kind === 'loop' ? a.addr : ip6.net(a.addr, a.plen);
            if (connected(n, plen)) continue;
            const inter = !mine.has(String(area));
            put(key6(n, plen), { type: 'O', sub: inter ? 'I' : '', rank: inter ? 1 : 0, ad: 110, metric: dx + cost6(Xd, f), net: n, plen, nextHop: hop.nh, ifc: hop.ifc });
          }
        }
        const c = Xd.ospf6;
        if (c.defaultOriginate && (c.defaultAlways || Xd.v6cfg().routes.some((r) => r.plen === 0))) put(key6(0n, 0), { type: 'O', sub: 'E2', rank: 2, ad: 110, metric: 1, net: 0n, plen: 0, nextHop: hop.nh, ifc: hop.ifc });
        for (const p of redist6(Xd, c)) {
          if (p.plen === 0 || connected(p.net, p.plen)) continue;
          put(key6(p.net, p.plen), { type: 'O', sub: 'E2', rank: 2, ad: 110, metric: 20, net: p.net, plen: p.plen, nextHop: hop.nh, ifc: hop.ifc });
        }
      }
      out.set(R, [...best.values()]);
    }
    return out;
  }

  /* ================= расчёт и таблица ================= */

  function logChanges(net) {
    for (const d of net.devices.values()) {
      if (!d.ifaces || !d.iosLog || !d.power) continue;
      const now = new Map((d.ospf6Neighbors || []).map((n) => [n.id + '|' + n.ifname, n]));
      const prev = d._ospf6Nb || new Map();
      for (const [k, n] of now) if (!prev.has(k)) d.iosLog('OSPFv3', 5, 'ADJCHG', 'Process ' + d.ospf6.pid + ', Nbr ' + U.ipStr(n.id) + ' on ' + n.ifname + ' from LOADING to FULL, Loading Done');
      for (const [k, n] of prev) if (!now.has(k)) d.iosLog('OSPFv3', 5, 'ADJCHG', 'Process ' + (d.ospf6 ? d.ospf6.pid : n.pid) + ', Nbr ' + U.ipStr(n.id) + ' on ' + n.ifname + ' from FULL to DOWN, Neighbor Down: Interface down or detached');
      d._ospf6Nb = new Map([...now].map(([k, n]) => [k, Object.assign({ pid: d.ospf6 && d.ospf6.pid }, n)]));
    }
  }

  function compute6(net) {
    const devs = [...net.devices.values()].filter((d) => d.ifaces);
    for (const d of devs) { d.dynRoutes6 = []; d.ripngNeighbors = []; d.ospf6Neighbors = []; }
    const active = devs.filter(routing6);
    if (active.length) {
      const rip = computeRipng(net, active);
      const ospf = computeOspf6(net, active);
      for (const d of active) d.dynRoutes6 = (rip.get(d) || []).concat(ospf.get(d) || []);
    }
    logChanges(net);
  }

  const baseCompute = R0.compute;
  R0.compute = function (net) {
    baseCompute.call(this, net);
    compute6(net);
  };

  // изменения IPv6 — повод пересчитать маршруты
  for (const m of ['v6changed', 'setIpv6Routing', 'addRoute6', 'removeRoute6']) {
    const fn = P6[m];
    P6[m] = function (...args) {
      const r = fn.apply(this, args);
      if (this.net) this.net.markRouting();
      return r;
    };
  }

  const lookupBase = P6.lookup6;
  P6.lookup6 = function (dst, hintIfc) {
    if (this.net) this.net.ensureRouting();
    const best = lookupBase.call(this, dst, hintIfc);
    if (ip6.isLinkLocal(dst) || !this.dynRoutes6 || !this.dynRoutes6.length || !this.forwarding6()) return best;
    let dyn = null;
    for (const r of this.dynRoutes6) {
      if (ip6.net(dst, r.plen) !== r.net || !this.ifaceUp(r.ifc)) continue;
      if (!dyn || r.plen > dyn.plen || (r.plen === dyn.plen && r.ad < dyn.ad)) dyn = r;
    }
    if (!dyn) return best;
    if (!best || dyn.plen > best.plen || (dyn.plen === best.plen && dyn.ad < (best.ad == null ? 1 : best.ad))) return { type: dyn.type, ad: dyn.ad, plen: dyn.plen, net: dyn.net, ifc: dyn.ifc, nextHop: dyn.nextHop, sub: dyn.sub };
    return best;
  };

  const tableBase = P6.routingTable6;
  P6.routingTable6 = function () {
    if (this.net) this.net.ensureRouting();
    const rows = tableBase.call(this);
    for (const r of this.dynRoutes6 || []) {
      const st = rows.find((x) => x.type === 'S' && x.plen === r.plen && x.net === r.net);
      if (st && st.ad <= r.ad) continue;
      rows.push({ type: r.type, sub: r.sub, ad: r.ad, metric: r.metric, plen: r.plen, net: r.net, nextHop: r.nextHop, ifname: r.ifc.name });
    }
    return rows;
  };

  /* ================= DHCPv6 ================= */

  const MSG = { solicit: 'Solicit', advertise: 'Advertise', request: 'Request', reply: 'Reply', 'information-request': 'Information-Request' };
  const duidOf = (dev, f) => '0003000' + '1' + (dev.ifaceMac(f) || '').replace(/[:.]/g, '').toUpperCase();

  function send6(dev, f, dst, msg, why) {
    const src = dev.ll6(f);
    const client = msg.type === 'solicit' || msg.type === 'request' || msg.type === 'information-request';
    const pkt = P.ipv6(src, dst, 'UDP', { sport: client ? 546 : 547, dport: client ? 547 : 546, dhcp6: msg }, client ? 1 : 64);
    if (ip6.isMulticast(dst)) dev.sendFrame6(f, ip6.mcastMac(dst), pkt, why);
    else dev.resolve6(f, dst, pkt, { why });
  }

  /** Клиент: запустить обмен (stateful — Solicit, stateless — Information-Request). */
  P6.dhcp6Start = function (stateless) {
    const f = this.iface;
    if (!f || !on(f) || !this.ifaceUp(f) || !this.power) return;
    const c = this.dhcp6c || (this.dhcp6c = {});
    if (c.timer) c.timer.cancel();
    Object.assign(c, { state: stateless ? 'info' : 'solicit', xid: Math.floor(Math.random() * 0xffffff), tries: 0, timer: null, stateless: !!stateless, error: null });
    this.dhcp6Attempt();
  };

  P6.dhcp6Attempt = function () {
    const c = this.dhcp6c;
    const f = this.iface;
    if (!c || !f || c.state === 'bound' || c.state === 'idle') return;
    if (c.tries >= 3) {
      c.state = 'idle';
      c.error = 'нет ответа от DHCPv6-сервера';
      this.note('DHCPv6: сервер не ответил — адрес не получен', null, 'drop');
      this.net.emit('config', { dev: this });
      return;
    }
    c.tries++;
    const duid = duidOf(this, f);
    if (c.state === 'info') send6(this, f, ALL_DHCP, { type: 'information-request', xid: c.xid, duid }, 'DHCPv6 Information-Request: сообщите DNS-сервер и домен');
    else if (c.state === 'request') send6(this, f, ALL_DHCP, { type: 'request', xid: c.xid, duid, addr: c.offer, server: c.serverDuid }, 'DHCPv6 Request: прошу адрес ' + ip6.str(c.offer));
    else send6(this, f, ALL_DHCP, { type: 'solicit', xid: c.xid, duid }, 'DHCPv6 Solicit: есть ли DHCPv6-сервер?' + (c.tries > 1 ? ' (попытка ' + c.tries + ')' : ''));
    c.timer = this.timer(DHCP_RETRY, () => { c.timer = null; this.dhcp6Attempt(); });
  };

  P6.dhcp6Release = function () {
    const f = this.iface;
    if (this.dhcp6c && this.dhcp6c.timer) this.dhcp6c.timer.cancel();
    this.dhcp6c = { state: 'idle' };
    if (f && f.v6) f.v6.addrs = f.v6.addrs.filter((a) => a.origin !== 'dhcp');
    this.net.emit('config', { dev: this });
  };

  function clientRx(dev, f, pkt, m) {
    const c = dev.dhcp6c;
    if (!c || m.xid !== c.xid) { dev.note('DHCPv6 ' + MSG[m.type] + ': не мой запрос — пропускаю', null, 'drop'); return; }
    if (m.type === 'advertise' && c.state === 'solicit') {
      if (m.status === 'NoAddrsAvail' || m.addr == null) {
        if (c.timer) c.timer.cancel();
        c.state = 'idle';
        c.error = 'сервер не выдаёт адреса (в пуле нет address prefix)';
        dev.v6dns = m.dns || [];
        dev.v6domain = m.domain || '';
        dev.note('DHCPv6 Advertise: адресов нет (NoAddrsAvail)', null, 'drop');
        dev.net.emit('config', { dev });
        return;
      }
      if (c.timer) c.timer.cancel();
      c.state = 'request';
      c.offer = m.addr;
      c.serverDuid = m.server;
      c.tries = 0;
      dev.dhcp6Attempt();
      return;
    }
    if (m.type === 'reply' && (c.state === 'request' || c.state === 'info')) {
      if (c.timer) c.timer.cancel();
      c.timer = null;
      dev.v6dns = m.dns || [];
      dev.v6domain = m.domain || '';
      if (c.state === 'request' && m.addr != null) {
        const st = f.v6;
        st.addrs = st.addrs.filter((a) => a.origin !== 'dhcp');
        st.addrs.push({ addr: m.addr, plen: m.plen || 64, origin: 'dhcp' });
        c.lease = m.addr;
        c.server = pkt.src;
        dev.note('DHCPv6: получен адрес ' + ip6.str(m.addr) + (c.server ? ' от ' + ip6.str(c.server) : ''), null, 'accept');
      } else dev.note('DHCPv6: получены DNS ' + (m.dns || []).map((x) => ip6.str(x)).join(', ') + (m.domain ? ', домен ' + m.domain : ''), null, 'accept');
      c.state = 'bound';
      dev.net.emit('config', { dev });
    }
  }

  function serverRx(dev, f, pkt, m, frame) {
    const name = f.v6r && f.v6r.dhcpServer;
    const pool = name && dev.dhcp6Pools && dev.dhcp6Pools[name];
    if (!pool) { if (frame) dev.drop(frame, 'DHCPv6: пул «' + name + '» не создан (ipv6 dhcp pool ' + name + ')'); return; }
    const rt = dev.dhcp6Rt || (dev.dhcp6Rt = { bindings: new Map(), next: {} });
    const extra = { dns: pool.dns.slice(), domain: pool.domain || '' };
    const sduid = duidOf(dev, f);
    if (m.type === 'information-request') {
      send6(dev, f, pkt.src, Object.assign({ type: 'reply', xid: m.xid, server: sduid }, extra), 'DHCPv6 Reply: DNS ' + (extra.dns.map((x) => ip6.str(x)).join(', ') || 'не задан'));
      return;
    }
    if (!pool.prefix) {
      send6(dev, f, pkt.src, Object.assign({ type: m.type === 'solicit' ? 'advertise' : 'reply', xid: m.xid, server: sduid, status: 'NoAddrsAvail' }, extra), 'DHCPv6: в пуле ' + name + ' нет address prefix — адрес не выдаю');
      return;
    }
    let b = rt.bindings.get(m.duid);
    if (b && (b.pool !== name || ip6.net(b.addr, pool.prefix.plen) !== pool.prefix.net)) { rt.bindings.delete(m.duid); b = null; }
    if (!b) {
      const used = new Set([...rt.bindings.values()].map((x) => x.addr));
      for (const g of dev.ifaces) for (const a of (g.v6 ? g.v6.addrs : [])) used.add(a.addr);
      let n = rt.next[name] || 0;
      let addr;
      do { n++; addr = pool.prefix.net | BigInt(0x10 + n); } while (used.has(addr) && n < 0xffff);
      rt.next[name] = n;
      b = { duid: m.duid, addr, pool: name, ifname: f.name, ll: pkt.src, time: dev.net.time, state: 'offered' };
      rt.bindings.set(m.duid, b);
    }
    if (m.type === 'solicit') {
      send6(dev, f, pkt.src, Object.assign({ type: 'advertise', xid: m.xid, server: sduid, addr: b.addr, plen: pool.prefix.plen }, extra), 'DHCPv6 Advertise: предлагаю адрес ' + ip6.str(b.addr));
      return;
    }
    b.state = 'bound';
    b.time = dev.net.time;
    send6(dev, f, pkt.src, Object.assign({ type: 'reply', xid: m.xid, server: sduid, addr: b.addr, plen: pool.prefix.plen }, extra), 'DHCPv6 Reply: адрес ' + ip6.str(b.addr) + ' закреплён');
  }

  const isMineBase = P6.isMine6;
  P6.isMine6 = function (dst, f) {
    if (dst === ALL_DHCP) return this.forwarding6() && !!(f.v6r && f.v6r.dhcpServer);
    return isMineBase.call(this, dst, f);
  };

  const deliverBase = P6.deliver6;
  P6.deliver6 = function (pkt, f, frame) {
    if (pkt.next === 'UDP' && pkt.payload && pkt.payload.dhcp6) {
      const m = pkt.payload.dhcp6;
      if (pkt.payload.dport === 547 && this.forwarding6()) serverRx(this, f, pkt, m, frame);
      else if (pkt.payload.dport === 546 && !this.forwarding6()) clientRx(this, f, pkt, m);
      else if (frame) this.drop(frame, 'DHCPv6-сообщение не для меня');
      return;
    }
    deliverBase.call(this, pkt, f, frame);
    // RA на компьютере: шлюз для DHCPv6-режима, запрос адреса или DNS (флаги M и O)
    if (pkt.next === 'ICMPv6' && pkt.payload && pkt.payload.type === 'ra' && !this.forwarding6() && f.v6) {
      const m = pkt.payload;
      const c = this.dhcp6c;
      const busy = c && (c.state === 'solicit' || c.state === 'request' || c.state === 'info' || c.state === 'bound');
      if (f.v6.dhcp) {
        f.v6.raRouter = pkt.src;
        if (!busy) this.timer(1, () => this.dhcp6Start(false));
      } else if (f.v6.autoconfig && m.other && !busy) this.timer(1, () => this.dhcp6Start(true));
    }
  };

  const gwBase = P6.gateway6;
  P6.gateway6 = function () {
    const g = gwBase.call(this);
    if (g) return g;
    const f = this.iface;
    if (f && f.v6 && f.v6.dhcp && f.v6.raRouter != null && this.ifaceUp(f)) return { addr: f.v6.raRouter, ifc: f };
    return null;
  };

  // режим компьютера «Автоматически (DHCPv6)»
  const hostBase = P6.setIpv6Host;
  P6.setIpv6Host = function (mode, addr, plen, gw) {
    const f = this.iface;
    if (mode !== 'dhcp') {
      if (f && f.v6 && f.v6.dhcp) { f.v6.dhcp = false; this.dhcp6Release(); }
      return hostBase.call(this, mode, addr, plen, gw);
    }
    if (!f) throw new Error('Нет сетевого интерфейса');
    if (!f.v6) f.v6 = { enabled: true, autoconfig: false, llManual: null, addrs: [], raRouter: null };
    const st = f.v6;
    st.enabled = true;
    st.autoconfig = false;
    st.dhcp = true;
    st.raRouter = null;
    st.addrs = [];
    this.v6cfg().gw = null;
    this.dhcp6c = { state: 'idle' };
    this.v6changed(f);
    if (this.power && this.ifaceUp(f)) this.sendRS6(f);
  };

  IpNode.hooks.runtime.push(function () {
    this.dhcp6c = null;
    this.dhcp6Rt = null;
    this.v6dns = [];
    this.v6domain = '';
    if (!this.ifaces) return;
    for (const f of this.ifaces) if (f.v6 && f.v6.dhcp) this.timer(5, () => this.sendRS6(f));
  });

  const linkBase = P6.onLinkChange;
  P6.onLinkChange = function (i, upNow) {
    linkBase.call(this, i, upNow);
    for (const f of this.ifaces) {
      if (f.port !== i || !f.v6 || !f.v6.dhcp) continue;
      if (upNow) this.timer(2, () => this.sendRS6(f));
    }
  };

  /* ---------- пакеты DHCPv6 ---------- */

  P.register({
    protocols: { DHCPv6: { label: 'DHCPv6', color: '#0d9488' } },
    classify(f) { return f.type === 'IPv6' && f.payload && f.payload.next === 'UDP' && f.payload.payload && f.payload.payload.dhcp6 ? 'DHCPv6' : null; },
    summary(f) {
      if (!(f.type === 'IPv6' && f.payload && f.payload.next === 'UDP' && f.payload.payload && f.payload.payload.dhcp6)) return null;
      const m = f.payload.payload.dhcp6;
      return 'DHCPv6 ' + (MSG[m.type] || m.type) + (m.addr != null ? ': ' + ip6.str(m.addr) : '') + (m.status ? ' (' + m.status + ')' : '') + ', ' + ip6.str(f.payload.src) + ' → ' + ip6.str(f.payload.dst);
    },
    layers(f) {
      if (!(f.type === 'IPv6' && f.payload && f.payload.next === 'UDP' && f.payload.payload && f.payload.payload.dhcp6)) return null;
      const p = f.payload;
      const m = p.payload.dhcp6;
      const out = [P.l2Layer(f)];
      out.push({ title: 'IPv6 (уровень 3)', fields: [['Источник', ip6.str(p.src)], ['Назначение', ip6.str(p.dst) + (p.dst === ALL_DHCP ? ' (все DHCPv6-серверы и агенты)' : '')], ['Hop Limit', String(p.hop)], ['Следующий заголовок', 'UDP']] });
      out.push({ title: 'UDP (уровень 4)', fields: [['Порт источника', String(p.payload.sport)], ['Порт назначения', String(p.payload.dport)]] });
      const fields = [['Сообщение', MSG[m.type] || m.type], ['Transaction ID', '0x' + m.xid.toString(16).toUpperCase()]];
      if (m.duid) fields.push(['DUID клиента', m.duid]);
      if (m.addr != null) fields.push(['Адрес (IA_NA)', ip6.str(m.addr)]);
      if (m.status) fields.push(['Статус', m.status]);
      if (m.dns && m.dns.length) fields.push(['DNS-серверы', m.dns.map((x) => ip6.str(x)).join(', ')]);
      if (m.domain) fields.push(['Домен', m.domain]);
      out.push({ title: 'DHCPv6', fields });
      return out;
    },
  });

  /* ================= сохранение ================= */

  IpNode.ifaceExt.push({
    key: 'v6r',
    save(f) {
      const o = {};
      const r = f.v6r;
      if (f.v6 && f.v6.dhcp) o.dhcp = true;
      if (r) {
        if (r.rip) o.rip = r.rip;
        if (r.ripDefault) o.ripDefault = r.ripDefault;
        if (r.ospf) o.ospf = { pid: r.ospf.pid, area: r.ospf.area };
        if (r.cost != null) o.cost = r.cost;
        if (r.dhcpServer) o.dhcpServer = r.dhcpServer;
        if (r.ndM) o.ndM = true;
        if (r.ndO) o.ndO = true;
      }
      return Object.keys(o).length ? o : null;
    },
    load(f, d) {
      f.v6r = null;
      if (f.v6) f.v6.dhcp = false;
      if (!d) return;
      if (d.dhcp && f.v6) { f.v6.dhcp = true; f.v6.enabled = true; }
      const r = r6(f);
      r.rip = d.rip || null;
      r.ripDefault = d.ripDefault || null;
      r.ospf = d.ospf ? { pid: Number(d.ospf.pid), area: d.ospf.area } : null;
      r.cost = d.cost != null ? Number(d.cost) : null;
      r.dhcpServer = d.dhcpServer || null;
      r.ndM = !!d.ndM;
      r.ndO = !!d.ndO;
    },
  });

  NS.deviceExt.push({
    key: 'routing6',
    applies: (d) => d.type === 'router' || d.type === 'switch',
    save(d) {
      const o = {};
      if (d.ripng) o.ripng = { name: d.ripng.name, redist: d.ripng.redist.slice() };
      if (d.ospf6) o.ospf6 = { pid: d.ospf6.pid, routerId: d.ospf6.routerId != null ? U.ipStr(d.ospf6.routerId) : null, passive: d.ospf6.passive.slice(), redist: d.ospf6.redist.slice(), defaultOriginate: !!d.ospf6.defaultOriginate, defaultAlways: !!d.ospf6.defaultAlways };
      if (d.dhcp6Pools && Object.keys(d.dhcp6Pools).length) {
        o.pools = {};
        for (const [k, p] of Object.entries(d.dhcp6Pools)) o.pools[k] = { prefix: p.prefix ? ip6.cidr(p.prefix.net, p.prefix.plen) : null, dns: p.dns.map((x) => ip6.str(x)), domain: p.domain || '' };
      }
      return Object.keys(o).length ? o : null;
    },
    load(d, c) {
      d.ripng = null;
      d.ospf6 = null;
      d.dhcp6Pools = {};
      if (!c) return;
      if (c.ripng) d.ripng = { name: String(c.ripng.name), redist: (c.ripng.redist || []).slice() };
      if (c.ospf6) d.ospf6 = { pid: Number(c.ospf6.pid), routerId: c.ospf6.routerId ? U.parseIp(c.ospf6.routerId) : null, passive: (c.ospf6.passive || []).slice(), redist: (c.ospf6.redist || []).slice(), defaultOriginate: !!c.ospf6.defaultOriginate, defaultAlways: !!c.ospf6.defaultAlways };
      for (const [k, p] of Object.entries(c.pools || {})) {
        const pr = p.prefix ? ip6.parsePrefix(p.prefix) : null;
        d.dhcp6Pools[k] = { prefix: pr ? { net: ip6.net(pr.addr, pr.plen), plen: pr.plen } : null, dns: (p.dns || []).map((x) => ip6.parse(x)).filter((x) => x != null), domain: p.domain || '' };
      }
      if (d.net) d.net.markRouting();
    },
  });

  /* ================= Cisco IOS ================= */

  const isL3 = (dev) => dev.type === 'router' || (dev.type === 'switch' && dev.l3);

  X.global.push((t) => t[0] && /^ipv6$/i.test(t[0]) && (/^router$/i.test(t[1] || '') || (/^dhcp$/i.test(t[1] || '') && /^pool$/i.test(t[2] || ''))));

  X.config.unshift((dev, s, a, neg, io, C) => {
    if (!C.kw(a[0], 'ipv6', 4) || !isL3(dev)) return false;
    if (C.kw(a[1], 'router', 6)) {
      if (C.kw(a[2], 'rip', 1)) {
        const name = a[3];
        if (!name) { C.incomplete(io); return true; }
        if (neg) {
          C.withMutate(io, () => {
            if (dev.ripng && dev.ripng.name === name) dev.ripng = null;
            for (const f of dev.ifaces) if (f.v6r && f.v6r.rip === name) { f.v6r.rip = null; f.v6r.ripDefault = null; }
            dev.net.markRouting();
          });
          return true;
        }
        if (!dev.v6cfg().routing) { io.out('% IPv6 routing not enabled'); return true; }
        if (dev.ripng && dev.ripng.name !== name) { io.out('% В NetLab на устройстве один процесс RIPng (уже запущен «' + dev.ripng.name + '»)'); return true; }
        if (!dev.ripng) C.withMutate(io, () => { dev.ripng = { name, redist: [] }; dev.net.markRouting(); });
        s.mode = 'ripng';
        return true;
      }
      if (C.kw(a[2], 'ospf', 1)) {
        const pid = Number(a[3]);
        if (!(Number.isInteger(pid) && pid >= 1 && pid <= 65535)) { C.incomplete(io); return true; }
        if (neg) {
          C.withMutate(io, () => {
            if (dev.ospf6 && dev.ospf6.pid === pid) dev.ospf6 = null;
            for (const f of dev.ifaces) if (f.v6r && f.v6r.ospf && f.v6r.ospf.pid === pid) f.v6r.ospf = null;
            dev.net.markRouting();
          });
          return true;
        }
        if (!dev.v6cfg().routing) { io.out('% IPv6 routing not enabled'); return true; }
        if (dev.ospf6 && dev.ospf6.pid !== pid) { io.out('% В NetLab на устройстве один процесс OSPFv3 (уже запущен ' + dev.ospf6.pid + ')'); return true; }
        if (!dev.ospf6) C.withMutate(io, () => { dev.ospf6 = { pid, routerId: null, passive: [], redist: [], defaultOriginate: false, defaultAlways: false }; dev.net.markRouting(); });
        if (!ospf6Rid(dev)) io.out('%OSPFv3-4-NORTRID: OSPFv3 process ' + pid + ' could not pick a router-id,\nplease configure manually');
        s.mode = 'ospf6';
        return true;
      }
      if (C.kw(a[2], 'eigrp', 1)) { io.out('% EIGRP для IPv6 в NetLab не поддерживается — используйте OSPFv3 или RIPng.'); return true; }
      C.invalid(io, a[2]);
      return true;
    }
    if (C.kw(a[1], 'dhcp', 2) && C.kw(a[2], 'pool', 1)) {
      const name = a[3];
      if (!name) { C.incomplete(io); return true; }
      if (!dev.dhcp6Pools) dev.dhcp6Pools = {};
      if (neg) { C.withMutate(io, () => { delete dev.dhcp6Pools[name]; }); return true; }
      if (!dev.dhcp6Pools[name]) C.withMutate(io, () => { dev.dhcp6Pools[name] = { prefix: null, dns: [], domain: '' }; });
      s.mode = 'dhcp6pool';
      s.dhcp6pool = name;
      return true;
    }
    return false;
  });

  function redistCmd6(dev, cfg, a, neg, io, C) {
    const src = ['static', 'connected'].find((x) => C.kw(a[1], x, 2));
    if (!src) { if (a[1]) io.out('% В NetLab в IPv6 передаются только static и connected'); else C.incomplete(io); return; }
    C.withMutate(io, () => { cfg.redist = cfg.redist.filter((x) => x !== src); if (!neg) cfg.redist.push(src); dev.net.markRouting(); });
  }

  X.modes.ripng = {
    prompt: () => '(config-rtr)#',
    tree: ['redistribute static', 'redistribute connected', 'maximum-paths WORD'],
    run(dev, s, t, io, C) {
      const c = dev.ripng;
      if (!c) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'redistribute', 3)) { redistCmd6(dev, c, a, neg, io, C); return; }
      if (C.kw(a[0], 'maximum-paths', 2) || C.kw(a[0], 'distance', 2) || C.kw(a[0], 'timers', 2) || C.kw(a[0], 'split-horizon', 2) || C.kw(a[0], 'poison-reverse', 2)) return;
      C.invalid(io, a[0]);
    },
  };

  X.modes.ospf6 = {
    prompt: () => '(config-rtr)#',
    tree: ['router-id A.B.C.D', 'passive-interface WORD', 'default-information originate', 'default-information originate always', 'redistribute static', 'redistribute connected', 'log-adjacency-changes'],
    run(dev, s, t, io, C) {
      const c = dev.ospf6;
      if (!c) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      const w = a[0];
      if (C.kw(w, 'router-id', 2)) {
        const v = U.parseIp(a[1] || '');
        if (!neg && v == null) { C.invalid(io, a[1]); return; }
        C.withMutate(io, () => { c.routerId = neg ? null : v; dev.net.markRouting(); });
        return;
      }
      if (C.kw(w, 'passive-interface', 1)) {
        if (C.kw(a[1], 'default', 1)) { C.withMutate(io, () => { c.passive = neg ? [] : dev.ifaces.filter((f) => on(f)).map((f) => f.name); dev.net.markRouting(); }); return; }
        const r = C.parseIfName(dev, a.slice(1).join(''));
        const f = r && C.ifaceOf(dev, r);
        if (!f) { io.out('% Интерфейс не найден'); return; }
        C.withMutate(io, () => { c.passive = c.passive.filter((x) => x !== f.name); if (!neg) c.passive.push(f.name); dev.net.markRouting(); });
        return;
      }
      if (C.kw(w, 'default-information', 2)) {
        C.withMutate(io, () => { c.defaultOriginate = !neg; c.defaultAlways = !neg && a.some((x) => C.kw(x, 'always', 1)); dev.net.markRouting(); });
        return;
      }
      if (C.kw(w, 'redistribute', 3)) { redistCmd6(dev, c, a, neg, io, C); return; }
      if (C.kw(w, 'log-adjacency-changes', 1) || C.kw(w, 'auto-cost', 2) || C.kw(w, 'area', 2) || C.kw(w, 'timers', 2)) return;
      C.invalid(io, w);
    },
  };

  X.modes.dhcp6pool = {
    prompt: () => '(config-dhcpv6)#',
    tree: ['address prefix WORD', 'dns-server WORD', 'domain-name WORD'],
    run(dev, s, t, io, C) {
      const p = dev.dhcp6Pools && dev.dhcp6Pools[s.dhcp6pool];
      if (!p) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'address', 1) && C.kw(a[1], 'prefix', 1)) {
        if (neg) { C.withMutate(io, () => { p.prefix = null; }); return; }
        const pr = ip6.parsePrefix(a[2] || '');
        if (!pr) { C.invalid(io, a[2]); return; }
        if (pr.plen > 64) { io.out('% Длина префикса для адресов — не больше /64'); return; }
        C.withMutate(io, () => { p.prefix = { net: ip6.net(pr.addr, pr.plen), plen: pr.plen }; });
        return;
      }
      if (C.kw(a[0], 'dns-server', 1)) {
        const v = ip6.parse(a[1] || '');
        if (v == null) { C.invalid(io, a[1]); return; }
        C.withMutate(io, () => { p.dns = p.dns.filter((x) => x !== v); if (!neg) p.dns.push(v); });
        return;
      }
      if (C.kw(a[0], 'domain-name', 2)) { C.withMutate(io, () => { p.domain = neg ? '' : (a[1] || ''); }); return; }
      if (C.kw(a[0], 'prefix-delegation', 3) || C.kw(a[0], 'link-address', 1)) { io.out('% Делегирование префиксов в NetLab не поддерживается'); return; }
      C.invalid(io, a[0]);
    },
  };

  X.iface.unshift((dev, s, a, neg, io, targets, C) => {
    if (!C.kw(a[0], 'ipv6', 4) || !(C.kw(a[1], 'rip', 2) || C.kw(a[1], 'ospf', 2) || C.kw(a[1], 'dhcp', 2) || C.kw(a[1], 'nd', 2))) return false;
    const ifs = targets.map((r) => C.ifaceOf(dev, r));
    if (ifs.some((f) => !f)) { io.out('% Порт коммутатора работает на 2-м уровне. IPv6 настраивается на interface vlan или маршрутизируемом порту.'); return true; }
    const each = (fn) => C.withMutate(io, () => { for (const f of ifs) fn(r6(f), f); dev.net.markRouting(); });
    if (C.kw(a[1], 'rip', 2)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return true; }
      if (C.kw(a[3], 'enable', 1)) {
        if (!neg && !dev.v6cfg().routing) { io.out('% IPv6 routing not enabled'); return true; }
        if (!neg && dev.ripng && dev.ripng.name !== name) { io.out('% В NetLab на устройстве один процесс RIPng (уже запущен «' + dev.ripng.name + '»)'); return true; }
        if (!neg && !dev.ripng) dev.ripng = { name, redist: [] };
        each((r) => { r.rip = neg ? null : name; if (neg) r.ripDefault = null; });
        return true;
      }
      if (C.kw(a[3], 'default-information', 2)) {
        const only = C.kw(a[4], 'only', 1);
        each((r) => { r.ripDefault = neg ? null : only ? 'only' : 'originate'; });
        return true;
      }
      if (C.kw(a[3], 'metric-offset', 2) || C.kw(a[3], 'summary-address', 2)) return true;
      C.invalid(io, a[3]);
      return true;
    }
    if (C.kw(a[1], 'ospf', 2)) {
      if (C.kw(a[2], 'cost', 1)) {
        const v = Number(a[3]);
        if (!neg && !(Number.isInteger(v) && v >= 1 && v <= 65535)) { C.incomplete(io); return true; }
        each((r) => { r.cost = neg ? null : v; });
        return true;
      }
      const pid = Number(a[2]);
      if (Number.isInteger(pid) && C.kw(a[3], 'area', 1)) {
        const area = a[4];
        if (area == null) { C.incomplete(io); return true; }
        if (!neg && !dev.v6cfg().routing) { io.out('% IPv6 routing not enabled'); return true; }
        if (!neg && dev.ospf6 && dev.ospf6.pid !== pid) { io.out('% В NetLab на устройстве один процесс OSPFv3 (уже запущен ' + dev.ospf6.pid + ')'); return true; }
        if (!neg && !dev.ospf6) {
          dev.ospf6 = { pid, routerId: null, passive: [], redist: [], defaultOriginate: false, defaultAlways: false };
          if (!ospf6Rid(dev)) io.out('%OSPFv3-4-NORTRID: OSPFv3 process ' + pid + ' could not pick a router-id,\nplease configure manually');
        }
        const ar = /^\d+$/.test(area) ? Number(area) : area;
        each((r) => { r.ospf = neg ? null : { pid, area: ar }; });
        return true;
      }
      if (C.kw(a[2], 'hello-interval', 1) || C.kw(a[2], 'dead-interval', 1) || C.kw(a[2], 'priority', 1) || C.kw(a[2], 'network', 1)) return true;
      C.invalid(io, a[2]);
      return true;
    }
    if (C.kw(a[1], 'dhcp', 2)) {
      if (C.kw(a[2], 'server', 1)) {
        if (!neg && !a[3]) { C.incomplete(io); return true; }
        each((r) => { r.dhcpServer = neg ? null : a[3]; });
        return true;
      }
      if (C.kw(a[2], 'relay', 1)) { io.out('% DHCPv6 relay в NetLab не поддерживается: включите ipv6 dhcp server на маршрутизаторе этого сегмента.'); return true; }
      if (C.kw(a[2], 'client', 1)) { io.out('% DHCPv6-клиент на маршрутизаторе в NetLab не поддерживается.'); return true; }
      C.invalid(io, a[2]);
      return true;
    }
    // ipv6 nd …
    if (C.kw(a[2], 'managed-config-flag', 1)) { each((r) => { r.ndM = !neg; }); for (const f of ifs) if (dev.power && dev.ifaceUp(f)) dev.sendRA6(f, null); return true; }
    if (C.kw(a[2], 'other-config-flag', 2)) { each((r) => { r.ndO = !neg; }); for (const f of ifs) if (dev.power && dev.ifaceUp(f)) dev.sendRA6(f, null); return true; }
    return true;
  });

  X.running.iface.push((dev, f) => {
    if (!f || !f.v6r) return [];
    const r = f.v6r;
    const L = [];
    if (r.rip) L.push(' ipv6 rip ' + r.rip + ' enable');
    if (r.rip && r.ripDefault) L.push(' ipv6 rip ' + r.rip + ' default-information ' + r.ripDefault);
    if (r.ospf) L.push(' ipv6 ospf ' + r.ospf.pid + ' area ' + r.ospf.area);
    if (r.cost != null) L.push(' ipv6 ospf cost ' + r.cost);
    if (r.ndM) L.push(' ipv6 nd managed-config-flag');
    if (r.ndO) L.push(' ipv6 nd other-config-flag');
    if (r.dhcpServer) L.push(' ipv6 dhcp server ' + r.dhcpServer);
    return L;
  });

  X.running.tail.push((dev) => {
    const L = [];
    for (const [k, p] of Object.entries(dev.dhcp6Pools || {})) {
      L.push('ipv6 dhcp pool ' + k);
      if (p.prefix) L.push(' address prefix ' + ip6.cidr(p.prefix.net, p.prefix.plen, true) + ' lifetime 172800 86400');
      for (const d of p.dns) L.push(' dns-server ' + up(d));
      if (p.domain) L.push(' domain-name ' + p.domain);
      L.push('!');
    }
    if (dev.ripng) {
      L.push('ipv6 router rip ' + dev.ripng.name);
      for (const x of dev.ripng.redist) L.push(' redistribute ' + x);
      L.push('!');
    }
    const c = dev.ospf6;
    if (c) {
      L.push('ipv6 router ospf ' + c.pid);
      if (c.routerId != null) L.push(' router-id ' + U.ipStr(c.routerId));
      L.push(' log-adjacency-changes');
      for (const p of c.passive) L.push(' passive-interface ' + p);
      if (c.defaultOriginate) L.push(' default-information originate' + (c.defaultAlways ? ' always' : ''));
      for (const x of c.redist) L.push(' redistribute ' + x);
      L.push('!');
    }
    return L;
  });

  /* ---------- show ---------- */

  const CODES6 = ['IPv6 Routing Table - default - %N entries',
    'Codes: C - Connected, L - Local, S - Static, U - Per-user Static route',
    '       B - BGP, R - RIP, D - EIGRP, EX - EIGRP external',
    '       O - OSPF Intra, OI - OSPF Inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2',
    '       ND - Neighbor Discovery'];

  function showRoute6(dev, filter, io) {
    const all = dev.routingTable6();
    const rows = all.filter((r) => !filter || ({ rip: 'R', ospf: 'O', static: 'S', connected: 'C', local: 'L' }[filter]) === r.type || (filter === 'connected' && r.type === 'L'));
    CODES6.forEach((l) => io.out(l.replace('%N', String(all.length))));
    for (const r of rows) {
      const code = (r.type + (r.sub || '')).padEnd(3);
      io.out(code + ' ' + ip6.cidr(r.net, r.plen, true) + ' [' + r.ad + '/' + (r.metric != null ? r.metric : 0) + ']');
      io.out('     via ' + (r.nextHop != null ? up(r.nextHop) + (r.ifname ? ', ' + r.ifname : '') : r.ifname + (r.type === 'L' ? ', receive' : ', directly connected')));
    }
  }

  X.show.unshift((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'ipv6', 4)) return false;
    const w = a[1];
    if (C.kw(w, 'route', 1)) {
      const f = ['rip', 'ospf', 'static', 'connected', 'local'].find((x) => C.kw(a[2], x, 1));
      if (a[2] && !f) return false;
      showRoute6(dev, f, io);
      return true;
    }
    if (C.kw(w, 'protocols', 1)) {
      dev.net.ensureRouting();
      io.out('IPv6 Routing Protocol is "connected"');
      io.out('IPv6 Routing Protocol is "ND"');
      if (dev.ripng) {
        io.out('IPv6 Routing Protocol is "rip ' + dev.ripng.name + '"');
        io.out('  Interfaces:');
        for (const f of dev.ifaces) if (ripOn(dev, f)) io.out('    ' + f.name);
        io.out('  Redistribution:');
        io.out(dev.ripng.redist.length ? '    Redistributing protocol ' + dev.ripng.redist.join(', ') : '    None');
      }
      if (dev.ospf6) {
        io.out('IPv6 Routing Protocol is "ospf ' + dev.ospf6.pid + '"');
        io.out('  Router ID ' + U.ipStr(ospf6Rid(dev)));
        const areas = new Map();
        for (const f of dev.ifaces) { const ar = ospfOn(dev, f); if (ar != null) { if (!areas.has(String(ar))) areas.set(String(ar), []); areas.get(String(ar)).push(f.name); } }
        io.out('  Number of areas: ' + areas.size + ' normal, 0 stub, 0 nssa');
        io.out('  Interfaces (Area ' + [...areas.keys()].join(', ') + '):');
        for (const [ar, l] of areas) for (const n of l) io.out('    ' + n + ' (Area ' + ar + ')');
        io.out('  Redistribution:');
        io.out(dev.ospf6.redist.length ? '    Redistributing protocol ' + dev.ospf6.redist.join(', ') : '    None');
      }
      io.out('IPv6 Routing Protocol is "static"');
      return true;
    }
    if (C.kw(w, 'rip', 1)) {
      dev.net.ensureRouting();
      if (!dev.ripng) { io.out('% RIPng не запущен (ipv6 rip NAME enable на интерфейсе).'); return true; }
      if (C.kw(a[2], 'database', 1)) {
        io.out('RIP process "' + dev.ripng.name + '", local RIB');
        for (const r of (dev.dynRoutes6 || []).filter((x) => x.type === 'R')) {
          io.out(' ' + ip6.cidr(r.net, r.plen, true) + ', metric ' + r.metric + ', installed');
          io.out('     ' + r.ifc.name + '/' + up(r.nextHop) + ', expires in 172 secs');
        }
        return true;
      }
      if (C.kw(a[2], 'next-hops', 1)) {
        io.out(' RIP process "' + dev.ripng.name + '", Next Hops');
        for (const n of dev.ripngNeighbors || []) io.out('  ' + up(n.ll) + '/' + n.ifname + ' [' + (dev.dynRoutes6 || []).filter((r) => r.type === 'R' && r.nextHop === n.ll).length + ' paths]');
        return true;
      }
      io.out('RIP process "' + dev.ripng.name + '", port 521, multicast-group FF02::9, pid 62');
      io.out('     Administrative distance is 120. Maximum paths is 16');
      io.out('     Updates every 30 seconds, expire after 180');
      io.out('     Split horizon is on; poison reverse is off');
      io.out('     Default routes are ' + (dev.ifaces.some((f) => f.v6r && f.v6r.ripDefault) ? 'generated' : 'not generated'));
      io.out('     Default routes are not accepted');
      io.out('  Interfaces:');
      for (const f of dev.ifaces) if (ripOn(dev, f)) io.out('    ' + f.name);
      io.out('  Redistribution:');
      io.out(dev.ripng.redist.length ? '    Redistributing protocol ' + dev.ripng.redist.join(', ') : '    None');
      return true;
    }
    if (C.kw(w, 'ospf', 1)) {
      dev.net.ensureRouting();
      const c = dev.ospf6;
      if (!c) { io.out('% OSPFv3 не запущен (ipv6 ospf N area A на интерфейсе).'); return true; }
      if (C.kw(a[2], 'neighbor', 1)) {
        io.out('');
        io.out('Neighbor ID     Pri   State           Dead Time   Interface ID    Interface');
        for (const n of dev.ospf6Neighbors || []) io.out(C.pad(U.ipStr(n.id), 16) + C.pad('1', 6) + C.pad(n.state, 16) + C.pad('00:00:3' + (n.id % 10), 12) + C.pad(String(n.intfId), 16) + n.ifname);
        return true;
      }
      if (C.kw(a[2], 'interface', 1)) {
        if (C.kw(a[3], 'brief', 1)) {
          io.out('Interface    PID   Area            Intf ID    Cost  State Nbrs F/C');
          dev.ifaces.forEach((f, i) => {
            const ar = ospfOn(dev, f);
            if (ar == null) return;
            const nbs = (dev.ospf6Neighbors || []).filter((n) => n.ifname === f.name);
            const nb = nbs.length;
            const ids = nbs.map((n) => n.id).concat([ospf6Rid(dev)]).sort((x, y) => y - x);
            const role = ids[0] === ospf6Rid(dev) ? 'DR' : ids[1] === ospf6Rid(dev) ? 'BDR' : 'DROTH';
            io.out(C.pad(C.shortIf(f.name), 13) + C.pad(String(c.pid), 6) + C.pad(String(ar), 16) + C.pad(String(i + 1), 11) + C.pad(String(cost6(dev, f)), 6) + C.pad(!dev.ifaceUp(f) ? 'DOWN' : f.kind === 'loop' ? 'LOOP' : passive6(dev, f) || nb ? role : 'WAIT', 6) + nb + '/' + nb);
          });
          return true;
        }
        for (const f of dev.ifaces) {
          const ar = ospfOn(dev, f);
          if (ar == null) continue;
          io.out(f.name + ' is ' + (dev.ifaceUp(f) ? 'up' : 'down') + ', line protocol is ' + (dev.ifaceUp(f) ? 'up' : 'down'));
          io.out('  Link Local Address ' + up(dev.ll6(f)) + ', Interface ID ' + (dev.ifaces.indexOf(f) + 1));
          io.out('  Area ' + ar + ', Process ID ' + c.pid + ', Instance ID 0, Router ID ' + U.ipStr(ospf6Rid(dev)));
          io.out('  Network Type BROADCAST, Cost: ' + cost6(dev, f));
          if (passive6(dev, f)) io.out('  No Hellos (Passive interface)');
          io.out('  Neighbor Count is ' + (dev.ospf6Neighbors || []).filter((n) => n.ifname === f.name).length);
        }
        return true;
      }
      const rid = ospf6Rid(dev);
      io.out(' Routing Process "ospfv3 ' + c.pid + '" with ID ' + (rid ? U.ipStr(rid) : '0.0.0.0 (router-id не выбран — задайте router-id)'));
      io.out(' SPF schedule delay 5 secs, Hold time between two SPFs 10 secs');
      if (c.defaultOriginate) io.out(' It is an autonomous system boundary router');
      if (c.redist.length) io.out(' Redistributing External Routes from, ' + c.redist.join(', '));
      const areas = new Set(dev.ifaces.map((f) => ospfOn(dev, f)).filter((x) => x != null).map(String));
      io.out(' Number of areas in this router is ' + areas.size + '. ' + areas.size + ' normal 0 stub 0 nssa');
      for (const ar of areas) {
        io.out('    Area ' + (ar === '0' ? 'BACKBONE(0)' : ar));
        io.out('        Number of interfaces in this area is ' + dev.ifaces.filter((f) => String(ospfOn(dev, f)) === ar).length);
      }
      return true;
    }
    if (C.kw(w, 'dhcp', 2)) {
      const pools = dev.dhcp6Pools || {};
      const rt = dev.dhcp6Rt || { bindings: new Map() };
      if (C.kw(a[2], 'pool', 1)) {
        for (const [k, p] of Object.entries(pools)) {
          io.out('DHCPv6 pool: ' + k);
          if (p.prefix) io.out('  Address allocation prefix: ' + ip6.cidr(p.prefix.net, p.prefix.plen, true) + ' valid 172800 preferred 86400 (' + [...rt.bindings.values()].filter((b) => b.pool === k).length + ' in use, 0 conflicts)');
          for (const d of p.dns) io.out('  DNS server: ' + up(d));
          if (p.domain) io.out('  Domain name: ' + p.domain);
          io.out('  Active clients: ' + [...rt.bindings.values()].filter((b) => b.pool === k && b.state === 'bound').length);
        }
        if (!Object.keys(pools).length) io.out('% Пулов DHCPv6 нет');
        return true;
      }
      if (C.kw(a[2], 'binding', 1)) {
        for (const b of rt.bindings.values()) {
          io.out('Client: ' + up(b.ll));
          io.out('  DUID: ' + b.duid);
          io.out('  Interface : ' + b.ifname);
          io.out('  IA NA: IA ID 0x00060001, T1 43200, T2 69120');
          io.out('    Address: ' + up(b.addr));
          io.out('            preferred lifetime 86400, valid lifetime 172800');
        }
        return true;
      }
      if (C.kw(a[2], 'interface', 1)) {
        for (const f of dev.ifaces) {
          if (!f.v6r || !f.v6r.dhcpServer) continue;
          io.out(f.name + ' is in server mode');
          io.out('  Using pool: ' + f.v6r.dhcpServer);
          io.out('  Preference value: 0');
          io.out('  Hint from client: ignored');
          io.out('  Rapid-Commit: disabled');
        }
        return true;
      }
      C.invalid(io, a[2]);
      return true;
    }
    return false;
  });

  X.exec.push((dev, s, t, io, line, C) => {
    if (s.mode !== 'exec' || !C.kw(t[0], 'clear', 3) || !C.kw(t[1], 'ipv6', 4)) return null;
    if (C.kw(t[2], 'dhcp', 2) && C.kw(t[3], 'binding', 1)) { if (dev.dhcp6Rt) dev.dhcp6Rt.bindings.clear(); return { handled: true }; }
    if (C.kw(t[2], 'ospf', 1) || C.kw(t[2], 'rip', 1) || C.kw(t[2], 'route', 1)) { dev.net.markRouting(); return { handled: true }; }
    return null;
  });

  X.tree.config = (X.tree.config || []).concat(['ipv6 router rip WORD', 'ipv6 router ospf WORD', 'ipv6 dhcp pool WORD']);
  X.tree.if = (X.tree.if || []).concat(['ipv6 rip WORD enable', 'ipv6 rip WORD default-information originate', 'ipv6 ospf WORD area WORD', 'ipv6 ospf cost WORD', 'ipv6 dhcp server WORD', 'ipv6 nd managed-config-flag', 'ipv6 nd other-config-flag']);
  X.tree.exec = (X.tree.exec || []).concat(['show ipv6 protocols', 'show ipv6 route rip', 'show ipv6 route ospf', 'show ipv6 rip', 'show ipv6 rip database', 'show ipv6 ospf', 'show ipv6 ospf neighbor', 'show ipv6 ospf interface brief', 'show ipv6 dhcp pool', 'show ipv6 dhcp binding', 'show ipv6 dhcp interface']);

  /* ---------- командная строка ПК ---------- */

  NS.ip6ConfigLines = (NS.ip6ConfigLines || []).concat([(dev, f, io) => {
    if (dev.v6dns && dev.v6dns.length) io.out('   DNS-серверы (IPv6). . . . . . . . : ' + dev.v6dns.map((x) => ip6.str(x)).join(', '));
    if (dev.v6domain) io.out('   DNS-суффикс (DHCPv6). . . . . . . : ' + dev.v6domain);
    const c = dev.dhcp6c;
    if (f.v6.dhcp && c && c.error) io.out('DHCPv6: ' + c.error, 'hint');
  }]);

  const H = NS.cliHost.ext;
  H.before.push((dev, s, cmd, args, io) => {
    if (cmd !== 'ipconfig') return undefined;
    const a = (args[0] || '').toLowerCase();
    if (a !== '/renew6' && a !== '/release6') return undefined;
    const f = dev.iface;
    if (!f || !f.v6 || !f.v6.dhcp) { io.out('Для адаптера ' + (f ? f.name : '') + ' не включен DHCPv6 (режим IPv6 «Автоматически (DHCPv6)»).'); return null; }
    if (a === '/release6') { io.mutate(() => dev.dhcp6Release()); io.out('IPv6-адрес освобождён.'); return null; }
    io.mutate(() => { dev.dhcp6Release(); dev.dhcp6Start(false); });
    io.out('Запрос адреса у DHCPv6-сервера…');
    return null;
  });
  H.help.push('  ipconfig /renew6 | /release6                             адрес IPv6 по DHCPv6');

  NS.routing6 = { computeRipng, computeOspf6, ospf6Rid, compute6 };
})(globalThis.NetLab = globalThis.NetLab || {});
