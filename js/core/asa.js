/* NetLab — межсетевой экран Cisco ASA 5506-X.
 * Интерфейсы с nameif и security-level; трафик с более высокого уровня на более низкий разрешён, обратно — только
 * по access-group; ответы проходят по таблице соединений (conn). ICMP проверяется с состоянием, только если в
 * policy-map global_policy есть inspect icmp. Object NAT (dynamic interface — PAT, static), dhcpd, свой CLI ASA. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const C = NS.cliIos.ctx;
  const Router = NS.deviceTypes.router;
  const ip = U.ipStr;

  NS.models.MODELS.ASA5506 = {
    type: 'asa', title: 'Межсетевой экран Cisco ASA 5506-X', ios: true,
    ports: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ name: 'GigabitEthernet1/' + i, media: 'copper', speed: 1000 }))
      .concat([{ name: 'Management1/1', media: 'copper', speed: 1000 }, { name: 'Console', media: 'console', speed: 0 }]),
    slots: [], attrs: { MTBF: 300000, cost: 8000, 'power source': 0, 'rack units': 1, wattage: 60 },
  };
  NS.models.DEFAULT_MODEL.asa = 'ASA5506';

  const DEFAULT_INSPECT = ['dns', 'ftp', 'rsh', 'rtsp', 'esmtp', 'sqlnet', 'skinny', 'sunrpc', 'xdmcp', 'sip', 'netbios', 'tftp'];

  function defaultAsa() {
    return { objects: {}, acls: {}, groups: {}, inspect: DEFAULT_INSPECT.slice(), dhcpd: { ranges: {}, enabled: [], dns: [], domain: '' }, sameSec: false, mgmt: [] };
  }

  class Asa extends Router {
    constructor(net, id, name, model) {
      super(net, id, name, model || 'ASA5506');
      this.type = 'asa';
      this.ios.hostname = 'ciscoasa';
      this.asa = defaultAsa();
      for (const f of this.ifaces) {
        f.adminUp = false;
        const p = this.ports[f.port];
        if (p) p.adminUp = false;
      }
    }

    saveNvram() {
      this.nvram = { state: this.configState(), text: NS.cliAsa.runningConfig(this) };
    }
  }
  Asa.namePrefix = 'ASA';
  NS.deviceTypes.asa = Asa;
  NS.Asa = Asa;

  /* ================= политика безопасности ================= */

  const nameIf = (dev, n) => dev.ifaces.find((f) => f.nameif && f.nameif.toLowerCase() === String(n).toLowerCase()) || null;
  const secOf = (f) => (f.secLevel != null ? f.secLevel : 0);

  function ports(p) {
    const pl = p.payload || {};
    if (p.proto === 'ICMP') return [pl.id != null ? pl.id : 0, pl.id != null ? pl.id : 0];
    return [pl.sport || 0, pl.dport || 0];
  }
  function keyOf(p) { const [s, d] = ports(p); return p.proto + '|' + p.src + '|' + p.dst + '|' + s + '|' + d; }
  function revKeyOf(p) {
    if (p.proto === 'ICMP' && !(p.payload && p.payload.type === 'echo-reply')) return null;
    const [s, d] = ports(p);
    return p.proto + '|' + p.dst + '|' + p.src + '|' + d + '|' + s;
  }

  /** Адрес ACL/объекта: {any} | {net, mask}. */
  function addrMatch(dev, a, v) {
    if (!a || a.any) return true;
    if (a.object) {
      const o = dev.asa.objects[a.object];
      if (!o || o.ip == null) return false;
      return U.net(v, o.mask) === U.net(o.ip, o.mask);
    }
    return U.net(v, a.mask) === U.net(a.net, a.mask);
  }

  const SVC = { www: 80, http: 80, https: 443, ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, tftp: 69, pop3: 110, ntp: 123, snmp: 161 };

  function aclCheck(dev, name, p) {
    const acl = dev.asa.acls[name];
    if (!acl) return { permit: true, none: true };
    for (const e of acl) {
      if (e.remark) continue;
      if (e.proto !== 'ip' && e.proto !== p.proto.toLowerCase()) continue;
      if (!addrMatch(dev, e.src, p.src) || !addrMatch(dev, e.dst, p.dst)) continue;
      if (e.port != null && (p.proto === 'ICMP' || !p.payload || p.payload.dport !== e.port)) continue;
      if (e.icmpType && !(p.proto === 'ICMP' && p.payload && p.payload.type === e.icmpType)) continue;
      e.hits = (e.hits || 0) + 1;
      return { permit: e.action === 'permit', entry: e };
    }
    return { permit: false, implicit: true };
  }

  /** Правило NAT для пакета из inIf в outIf. */
  function natRule(dev, p, inIf, outIf) {
    const hits = [];
    for (const [name, o] of Object.entries(dev.asa.objects)) {
      if (!o.nat || o.ip == null) continue;
      if (o.nat.real.toLowerCase() !== inIf.nameif.toLowerCase() || o.nat.mapped.toLowerCase() !== outIf.nameif.toLowerCase()) continue;
      if (U.net(p.src, o.mask) !== U.net(o.ip, o.mask)) continue;
      hits.push({ name, o });
    }
    // порядок object NAT в ASA: сначала static, затем dynamic; внутри — более точный префикс
    hits.sort((x, y) => (x.o.nat.type === 'static' ? 0 : 1) - (y.o.nat.type === 'static' ? 0 : 1) || U.prefixFromMask(y.o.mask) - U.prefixFromMask(x.o.mask));
    return hits[0] || null;
  }

  function rt(dev) {
    if (!dev.asaRt) dev.asaRt = { conns: new Map(), xlate: new Map(), byReal: new Map(), nextPort: 1024, most: 0 };
    return dev.asaRt;
  }

  /** Трансляция источника (PAT на адрес интерфейса или static). Возвращает новый пакет. */
  function translateOut(dev, p, inIf, outIf) {
    const r = natRule(dev, p, inIf, outIf);
    if (!r) return { pkt: p };
    const st = rt(dev);
    const [sp] = ports(p);
    const realKey = p.proto + '|' + p.src + '|' + sp + '|' + outIf.nameif;
    let x = st.byReal.get(realKey);
    if (!x) {
      if (r.o.nat.type === 'static') {
        x = { proto: p.proto, realIp: p.src, realPort: sp, mappedIp: r.o.nat.addr, mappedPort: sp, realIf: inIf.nameif, mappedIf: outIf.nameif, flags: 's', time: dev.net.time, obj: r.name };
      } else {
        const mip = r.o.nat.addr != null ? r.o.nat.addr : outIf.ip;
        if (mip == null) return { pkt: p, fail: 'у интерфейса ' + outIf.nameif + ' нет адреса для NAT' };
        let mport = sp;
        while (st.xlate.has(p.proto + '|' + mip + '|' + mport)) mport = st.nextPort++;
        x = { proto: p.proto, realIp: p.src, realPort: sp, mappedIp: mip, mappedPort: mport, realIf: inIf.nameif, mappedIf: outIf.nameif, flags: 'ri', time: dev.net.time, obj: r.name };
      }
      st.xlate.set(x.proto + '|' + x.mappedIp + '|' + x.mappedPort, x);
      st.byReal.set(realKey, x);
    }
    x.time = dev.net.time;
    const out = U.clone(p);
    out.src = x.mappedIp;
    if (p.proto === 'ICMP') { if (out.payload && out.payload.id != null) out.payload.id = x.mappedPort; } else if (out.payload) out.payload.sport = x.mappedPort;
    return { pkt: out, x };
  }

  /** Обратная трансляция пакета, пришедшего на отображённый адрес. */
  function translateIn(dev, p) {
    const st = rt(dev);
    const pl = p.payload || {};
    const dport = p.proto === 'ICMP' ? pl.id : pl.dport;
    // динамическая трансляция ICMP обратно пропускает только эхо-ответы; запрос на адрес ASA — самому ASA
    let x = p.proto === 'ICMP' && pl.type !== 'echo-reply' ? null : st.xlate.get(p.proto + '|' + p.dst + '|' + dport);
    if (x && x.flags === 's') x = null;
    if (!x) {
      // static NAT: любой порт
      for (const y of st.xlate.values()) if (y.flags === 's' && y.mappedIp === p.dst) { x = y; break; }
      if (!x) {
        for (const o of Object.values(dev.asa.objects)) {
          if (o.nat && o.nat.type === 'static' && o.nat.addr === p.dst && o.ip != null) {
            x = { proto: p.proto, realIp: o.ip, realPort: null, mappedIp: p.dst, flags: 's', realIf: o.nat.real, mappedIf: o.nat.mapped, time: dev.net.time };
            break;
          }
        }
      }
    }
    if (!x) return null;
    x.time = dev.net.time;
    const out = U.clone(p);
    out.dst = x.realIp;
    if (x.flags !== 's') { if (p.proto === 'ICMP') { if (out.payload && out.payload.id != null) out.payload.id = x.realPort; } else if (out.payload) out.payload.dport = x.realPort; }
    return { pkt: out, x };
  }

  function log(dev, sev, id, text) { if (dev.iosLog) dev.iosLog('ASA', sev, String(id), text); }

  /** Обработка входящего IP-пакета на ASA. true — пакет обработан здесь. */
  function asaIngress(dev, f, pkt, frame) {
    if (pkt.dst === U.BROADCAST_IP || dev.isDirectedBcast(pkt.dst, f) || (pkt.dst >>> 28) === 14) return false;
    if (!f.nameif) { dev.drop(frame, 'ASA: у интерфейса ' + f.name + ' нет nameif — трафик не обрабатывается'); return true; }
    let p = pkt;
    let unnat = null;
    if (dev.hasIp(pkt.dst)) {
      const t = translateIn(dev, pkt);
      if (!t) {
        if (f.ip !== pkt.dst) { dev.drop(frame, 'ASA не отвечает на адрес другого интерфейса (' + ip(pkt.dst) + ') — только на адрес интерфейса, к которому подключён отправитель'); return true; }
        return false; // ping, DHCP, telnet к самому ASA
      }
      p = t.pkt;
      unnat = t.x;
    } else if (dev.asa && Object.values(dev.asa.objects).some((o) => o.nat && o.nat.type === 'static' && o.nat.addr === pkt.dst)) {
      const t = translateIn(dev, pkt);
      if (t) { p = t.pkt; unnat = t.x; }
    }
    const r = dev.lookup(p.dst);
    if (!r) { log(dev, 6, 110003, 'Routing failed to locate next hop for ' + p.proto.toLowerCase() + ' from ' + f.nameif + ':' + ip(p.src) + ' to ' + ip(p.dst)); dev.drop(frame, 'ASA: нет маршрута до ' + ip(p.dst)); return true; }
    const out = r.ifc;
    if (!out.nameif) { dev.drop(frame, 'ASA: у выходного интерфейса ' + out.name + ' нет nameif'); return true; }
    if (out === f) { dev.drop(frame, 'ASA: пакет вернулся бы в тот же интерфейс ' + f.nameif + ' (same-security-traffic intra-interface не включён)'); return true; }
    const st = rt(dev);
    const back = revKeyOf(p) && st.conns.get(revKeyOf(p));
    let why;
    if (back) {
      back.time = dev.net.time;
      back.bytes += 64;
      why = 'ASA: ответ в соединении ' + back.proto + ' ' + ip(back.src) + ' → ' + ip(back.dst);
    } else {
      const grp = dev.asa.groups[f.nameif.toLowerCase()];
      const icmpType = p.proto === 'ICMP' ? ' (type ' + (p.payload && p.payload.type === 'echo-reply' ? 0 : 8) + ', code 0)' : '';
      if (grp) {
        const res = aclCheck(dev, grp, p);
        if (!res.permit) {
          log(dev, 4, 106023, 'Deny ' + p.proto.toLowerCase() + ' src ' + f.nameif + ':' + ip(p.src) + ' dst ' + out.nameif + ':' + ip(p.dst) + icmpType + ' by access-group "' + grp + '"');
          dev.drop(frame, 'ASA: запрещено списком доступа ' + grp + ' (access-group на ' + f.nameif + ')' + (res.implicit ? ' — неявный deny в конце списка' : ''));
          return true;
        }
        why = 'ASA: разрешено access-list ' + grp;
      } else if (secOf(f) > secOf(out) || (secOf(f) === secOf(out) && dev.asa.sameSec)) {
        why = 'ASA: с уровня безопасности ' + secOf(f) + ' (' + f.nameif + ') на ' + secOf(out) + ' (' + out.nameif + ') — разрешено';
      } else {
        const same = secOf(f) === secOf(out);
        log(dev, 2, same ? 106016 : 106001, 'Deny inbound ' + p.proto.toLowerCase() + ' src ' + f.nameif + ':' + ip(p.src) + ' dst ' + out.nameif + ':' + ip(p.dst) + icmpType);
        dev.drop(frame, same
          ? 'ASA: одинаковый уровень безопасности ' + secOf(f) + ' — трафик между ' + f.nameif + ' и ' + out.nameif + ' запрещён (same-security-traffic permit inter-interface)'
          : 'ASA: с уровня ' + secOf(f) + ' (' + f.nameif + ') на более высокий ' + secOf(out) + ' (' + out.nameif + ') можно только по access-group' +
            (p.proto === 'ICMP' && p.payload && p.payload.type === 'echo-reply' ? '. Это эхо-ответ: без inspect icmp ASA не помнит ping изнутри' : ''));
        return true;
      }
      const stateful = p.proto === 'TCP' || p.proto === 'UDP' || (p.proto === 'ICMP' && p.payload && p.payload.type === 'echo-request' && dev.asa.inspect.includes('icmp'));
      if (stateful) {
        const k = keyOf(p);
        if (!st.conns.has(k)) {
          const [sp, dp] = ports(p);
          st.conns.set(k, { key: k, proto: p.proto, src: p.src, dst: p.dst, sport: sp, dport: dp, inIf: f.nameif, outIf: out.nameif, time: dev.net.time, bytes: 0 });
          st.most = Math.max(st.most, st.conns.size);
          log(dev, 6, p.proto === 'TCP' ? 302013 : p.proto === 'UDP' ? 302015 : 302020, 'Built ' + (secOf(f) >= secOf(out) ? 'outbound' : 'inbound') + ' ' + p.proto + ' connection for ' + f.nameif + ':' + ip(p.src) + ' to ' + out.nameif + ':' + ip(p.dst));
        }
        st.conns.get(k).bytes += 64;
      }
    }
    // исходящая трансляция (для ответов по unnat — обратная уже выполнена)
    let o = p;
    let natNote = '';
    if (!unnat) {
      const t = translateOut(dev, p, f, out);
      if (t.fail) { dev.drop(frame, 'ASA NAT: ' + t.fail); return true; }
      if (t.x) natNote = ' · NAT ' + ip(p.src) + ' → ' + ip(t.pkt.src) + (t.x.flags === 'ri' ? ' (PAT)' : '');
      o = t.pkt;
    } else {
      o = U.clone(p);
      natNote = ' · un-NAT ' + ip(pkt.dst) + ' → ' + ip(p.dst);
    }
    if (o === pkt) o = U.clone(pkt);
    const nh = r.nextHop != null ? r.nextHop : o.dst;
    dev.resolveAndSend(r.ifc, nh, o, { why: why + natNote + ' → ' + out.nameif, onError: () => dev.sendIcmpError(pkt, 'unreachable', 1, f) });
    return true;
  }

  IpNode.hooks.ipIn.unshift(function (f, pkt, frame) {
    if (this.type !== 'asa') return false;
    return asaIngress(this, f, pkt, frame);
  });

  IpNode.hooks.runtime.push(function () { if (this.type === 'asa') this.asaRt = null; });

  // proxy ARP: ASA отвечает за адреса static NAT на «внешнем» интерфейсе
  const onArpBase = IpNode.prototype.onArp;
  IpNode.prototype.onArp = function (f, a, frame) {
    if (this.type === 'asa' && a.op === 'request' && f.nameif && a.targetIp !== f.ip) {
      const o = Object.values(this.asa.objects).find((x) => x.nat && x.nat.type === 'static' && x.nat.addr === a.targetIp && x.nat.mapped.toLowerCase() === f.nameif.toLowerCase());
      if (o) {
        this.sendArp(f, 'reply', a.targetIp, a.senderIp, a.senderMac, a.senderMac, 'Proxy ARP: ' + ip(a.targetIp) + ' — адрес static NAT, отвечаю за него');
        return;
      }
    }
    onArpBase.call(this, f, a, frame);
  };

  /* ---------- dhcpd ---------- */

  function syncDhcp(dev) {
    const d = dev.asa.dhcpd;
    dev.dhcpd.pools = [];
    for (const n of d.enabled) {
      const f = nameIf(dev, n);
      const r = d.ranges[n];
      if (!f || f.ip == null || !r) continue;
      dev.dhcpd.setPool({ name: n, start: r.start, end: r.end, mask: f.mask, gateway: f.ip, dns: d.dns[0] != null ? d.dns[0] : null });
    }
    dev.dhcpd.enabled = dev.dhcpd.pools.length > 0;
  }

  /* ================= сохранение ================= */

  const addrSave = (a) => (!a ? null : a.any ? { any: true } : a.object ? { object: a.object } : { net: ip(a.net), mask: ip(a.mask) });
  const addrLoad = (a) => (!a ? { any: true } : a.any ? { any: true } : a.object ? { object: String(a.object) } : { net: U.parseIp(a.net) || 0, mask: U.parseIp(a.mask) || 0 });

  NS.deviceExt.push({
    key: 'asa',
    applies: (d) => d.type === 'asa',
    save(d) {
      const a = d.asa;
      return {
        objects: Object.fromEntries(Object.entries(a.objects).map(([k, o]) => [k, { kind: o.kind, ip: o.ip != null ? ip(o.ip) : null, mask: o.mask != null ? ip(o.mask) : null, nat: o.nat ? Object.assign({}, o.nat, { addr: o.nat.addr != null ? ip(o.nat.addr) : null }) : null }])),
        acls: Object.fromEntries(Object.entries(a.acls).map(([k, l]) => [k, l.map((e) => (e.remark ? { remark: e.remark } : { action: e.action, proto: e.proto, src: addrSave(e.src), dst: addrSave(e.dst), port: e.port, icmpType: e.icmpType || null }))])),
        groups: Object.assign({}, a.groups),
        inspect: a.inspect.slice(),
        dhcpd: { ranges: Object.fromEntries(Object.entries(a.dhcpd.ranges).map(([k, r]) => [k, { start: ip(r.start), end: ip(r.end) }])), enabled: a.dhcpd.enabled.slice(), dns: a.dhcpd.dns.map(ip), domain: a.dhcpd.domain },
        sameSec: a.sameSec,
        mgmt: a.mgmt.map((m) => ({ proto: m.proto, net: ip(m.net), mask: ip(m.mask), nameif: m.nameif })),
      };
    },
    load(d, c) {
      d.asa = defaultAsa();
      d.asaRt = null;
      if (!c) { syncDhcp(d); return; }
      for (const [k, o] of Object.entries(c.objects || {})) d.asa.objects[k] = { kind: o.kind || 'subnet', ip: o.ip ? U.parseIp(o.ip) : null, mask: o.mask ? U.parseIp(o.mask) : 0xFFFFFFFF, nat: o.nat ? Object.assign({}, o.nat, { addr: o.nat.addr ? U.parseIp(o.nat.addr) : null }) : null };
      for (const [k, l] of Object.entries(c.acls || {})) d.asa.acls[k] = (l || []).map((e) => (e.remark ? { remark: String(e.remark) } : { action: e.action === 'deny' ? 'deny' : 'permit', proto: e.proto || 'ip', src: addrLoad(e.src), dst: addrLoad(e.dst), port: e.port != null ? Number(e.port) : null, icmpType: e.icmpType || null, hits: 0 }));
      d.asa.groups = Object.assign({}, c.groups || {});
      if (Array.isArray(c.inspect)) d.asa.inspect = c.inspect.slice();
      if (c.dhcpd) {
        for (const [k, r] of Object.entries(c.dhcpd.ranges || {})) d.asa.dhcpd.ranges[k] = { start: U.parseIp(r.start), end: U.parseIp(r.end) };
        d.asa.dhcpd.enabled = (c.dhcpd.enabled || []).slice();
        d.asa.dhcpd.dns = (c.dhcpd.dns || []).map((x) => U.parseIp(x)).filter((x) => x != null);
        d.asa.dhcpd.domain = c.dhcpd.domain || '';
      }
      d.asa.sameSec = !!c.sameSec;
      d.asa.mgmt = (c.mgmt || []).map((m) => ({ proto: m.proto, net: U.parseIp(m.net), mask: U.parseIp(m.mask), nameif: m.nameif }));
      syncDhcp(d);
    },
  });

  IpNode.ifaceExt.push({
    key: 'asaIf',
    save(f) { return f.nameif ? { nameif: f.nameif, sec: secOf(f) } : null; },
    load(f, d) { f.nameif = d ? String(d.nameif) : null; f.secLevel = d ? Number(d.sec) : null; },
  });

  /* ================= CLI ASA ================= */

  const kw = C.kw;
  const pad = C.pad;

  function createSession(dev, opts) {
    return { mode: 'user', ifs: null, via: (opts && opts.via) || 'local', pending: null, remote: null, stage: null, history: [], closed: false, obj: null };
  }

  function prompt(dev, s) {
    if (s.pending) return s.pending.prompt;
    const n = dev.ios.hostname;
    return n + ({ user: '>', exec: '#', config: '(config)#', if: '(config-if)#', obj: '(config-network-object)#', pmap: '(config-pmap)#', pmapc: '(config-pmap-c)#', cmap: '(config-cmap)#' }[s.mode] || '#');
  }

  /** Имя интерфейса: g1/1, gi1/2, management1/1, m1/1. */
  function portByName(dev, str) {
    const t = String(str || '').replace(/\s+/g, '');
    const m = /^([a-z]+)([\d/]+)$/i.exec(t);
    if (!m) return null;
    const pre = m[1].toLowerCase();
    return dev.ifaces.find((f) => f.kind === 'phys' && f.name.toLowerCase().startsWith(pre) && f.name.replace(/^[A-Za-z]+/, '') === m[2]) || null;
  }

  function parseAddr(dev, a, i) {
    if (kw(a[i], 'any', 3) || kw(a[i], 'any4', 4)) return { v: { any: true }, n: 1 };
    if (kw(a[i], 'host', 1)) { const v = U.parseIp(a[i + 1] || ''); return v == null ? null : { v: { net: v, mask: 0xFFFFFFFF }, n: 2 }; }
    if (kw(a[i], 'object', 2)) { if (!a[i + 1] || !dev.asa.objects[a[i + 1]]) return { err: 'ERROR: specified object (' + (a[i + 1] || '') + ') does not exist' }; return { v: { object: a[i + 1] }, n: 2 }; }
    const n = U.parseIp(a[i] || '');
    const m = U.parseMask(a[i + 1] || '');
    if (n == null || m == null) return null;
    return { v: { net: U.net(n, m), mask: m }, n: 2 };
  }
  const addrStr = (a) => (!a || a.any ? 'any' : a.object ? 'object ' + a.object : a.mask === 0xFFFFFFFF ? 'host ' + ip(a.net) : ip(a.net) + ' ' + ip(a.mask));

  function aclLine(name, e) {
    if (e.remark) return 'access-list ' + name + ' remark ' + e.remark;
    return 'access-list ' + name + ' extended ' + e.action + ' ' + e.proto + ' ' + addrStr(e.src) + ' ' + addrStr(e.dst) + (e.port != null ? ' eq ' + (Object.keys(SVC).find((k) => SVC[k] === e.port && k !== 'http') || e.port) : '') + (e.icmpType ? ' ' + e.icmpType : '');
  }

  function runningConfig(dev) {
    const a = dev.asa;
    const L = [': Saved', ':', ': Hardware:   ASA5506, 4096 MB RAM, CPU Atom C2000 series 1250 MHz, 1 CPU (4 cores)', ':', 'ASA Version 9.8(1)', '!', 'hostname ' + dev.ios.hostname];
    if (dev.ios.enablePassword || dev.ios.enableSecret) L.push('enable password ' + U.secretHash(dev.ios.enablePassword || dev.ios.enableSecret).slice(3, 19) + ' encrypted');
    L.push('names', '!');
    for (const f of dev.ifaces.filter((x) => x.kind === 'phys')) {
      L.push('interface ' + f.name);
      const p = dev.ports[f.port];
      if (!f.adminUp || (p && !p.adminUp)) L.push(' shutdown');
      L.push(f.nameif ? ' nameif ' + f.nameif : ' no nameif');
      L.push(f.nameif ? ' security-level ' + secOf(f) : ' no security-level');
      if (f.dhcp) L.push(' ip address dhcp' + (f.setroute ? ' setroute' : ''));
      else L.push(f.ip != null ? ' ip address ' + ip(f.ip) + ' ' + ip(f.mask) : ' no ip address');
      L.push('!');
    }
    L.push('ftp mode passive');
    if (a.sameSec) L.push('same-security-traffic permit inter-interface');
    for (const [k, o] of Object.entries(a.objects)) {
      L.push('object network ' + k);
      if (o.ip != null) L.push(o.kind === 'host' ? ' host ' + ip(o.ip) : ' subnet ' + ip(o.ip) + ' ' + ip(o.mask));
    }
    for (const [k, l] of Object.entries(a.acls)) for (const e of l) L.push(aclLine(k, e));
    for (const [k, o] of Object.entries(a.objects)) {
      if (!o.nat) continue;
      L.push('object network ' + k, ' nat (' + o.nat.real + ',' + o.nat.mapped + ') ' + (o.nat.type === 'static' ? 'static ' + ip(o.nat.addr) : 'dynamic ' + (o.nat.addr != null ? ip(o.nat.addr) : 'interface')));
    }
    for (const [n, acl] of Object.entries(a.groups)) { const f = nameIf(dev, n); L.push('access-group ' + acl + ' in interface ' + (f ? f.nameif : n)); }
    for (const r of dev.routes) {
      const f = r.ifName ? dev.ifaceByName(r.ifName) : dev.ifaces.find((x) => x.ip != null && r.nextHop != null && U.sameNet(x.ip, r.nextHop, x.mask));
      L.push('route ' + (f && f.nameif ? f.nameif : '?') + ' ' + ip(r.net) + ' ' + ip(r.mask) + ' ' + (r.nextHop != null ? ip(r.nextHop) : '0.0.0.0') + ' ' + (r.ad || 1));
    }
    for (const m of a.mgmt) L.push(m.proto + ' ' + ip(m.net) + ' ' + ip(m.mask) + ' ' + m.nameif);
    const d = a.dhcpd;
    if (d.dns.length) L.push('dhcpd dns ' + d.dns.map(ip).join(' '));
    if (d.domain) L.push('dhcpd domain ' + d.domain);
    L.push('!');
    for (const [n, r] of Object.entries(d.ranges)) {
      L.push('dhcpd address ' + ip(r.start) + '-' + ip(r.end) + ' ' + n);
      if (d.enabled.includes(n)) L.push('dhcpd enable ' + n);
      L.push('!');
    }
    L.push('class-map inspection_default', ' match default-inspection-traffic', '!', 'policy-map global_policy', ' class inspection_default');
    for (const x of a.inspect) L.push('  inspect ' + x);
    L.push('!', 'service-policy global_policy global');
    for (const u of dev.ios.users) L.push('username ' + u.name + ' password ' + (u.secret ? u.pass.slice(3, 19) : U.secretHash(u.pass).slice(3, 19)) + ' encrypted' + (u.priv > 1 ? ' privilege ' + u.priv : ''));
    L.push(': end');
    return L;
  }

  function showRoute(dev, io) {
    dev.net.ensureRouting();
    const rows = dev.routingTable();
    const nm = (n) => { const f = dev.ifaceByName(n); return f && f.nameif ? f.nameif : n; };
    io.out('Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP');
    io.out('       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area');
    io.out('       * - candidate default, U - per-user static route, o - ODR');
    io.out('');
    const def = rows.find((r) => r.mask === 0 && r.type === 'S');
    io.out(def ? 'Gateway of last resort is ' + ip(def.nextHop) + ' to network 0.0.0.0' : 'Gateway of last resort is not set');
    io.out('');
    for (const r of rows) {
      const code = (r.type + (r.mask === 0 ? '*' : '')).padEnd(9);
      if (r.type === 'C' || r.type === 'L') io.out(code + ip(r.net) + ' ' + ip(r.mask) + ' is directly connected, ' + nm(r.ifname));
      else io.out(code + ip(r.net) + ' ' + ip(r.mask) + ' [' + r.ad + '/' + (r.metric || 0) + '] via ' + ip(r.nextHop) + ', ' + nm(r.ifname));
    }
  }

  function show(dev, s, a, io) {
    const w = a[0];
    if (kw(w, 'running-config', 3)) {
      const L = runningConfig(dev);
      if (a[1]) { const k = a[1].toLowerCase(); io.out(L.filter((l) => l.toLowerCase().startsWith(k) || l.toLowerCase().includes(' ' + k)).join('\n') || ''); return; }
      L.forEach((l) => io.out(l));
      return;
    }
    if (kw(w, 'startup-config', 3)) { if (!dev.nvram) { io.out('No Configuration'); return; } dev.nvram.text.forEach((l) => io.out(l)); return; }
    if (kw(w, 'version', 2)) {
      io.out('Cisco Adaptive Security Appliance Software Version 9.8(1)');
      io.out('Firepower Extensible Operating System Version 2.2(1.47)');
      io.out('');
      io.out(dev.ios.hostname + ' up ' + Math.floor(dev.net.time / 6000) + ' mins ' + Math.floor(dev.net.time / 100) % 60 + ' secs');
      io.out('');
      io.out('Hardware:   ASA5506, 4096 MB RAM, CPU Atom C2000 series 1250 MHz, 1 CPU (4 cores)');
      dev.ifaces.filter((f) => f.kind === 'phys').forEach((f, i) => io.out(' ' + i + ': Int: Internal-Data' + ' : address is ' + U.ciscoMac(dev.ifaceMac(f)) + ', irq 255   ' + f.name));
      io.out('');
      io.out('Licensed features for this platform:');
      io.out('Maximum Physical Interfaces       : Unlimited      perpetual');
      io.out('Inside Hosts                      : Unlimited      perpetual');
      io.out('Security Contexts                 : 2              perpetual');
      return;
    }
    if (kw(w, 'interface', 2) && kw(a[1], 'ip', 1) && kw(a[2], 'brief', 1)) {
      io.out('Interface                  IP-Address      OK? Method Status                Protocol');
      for (const f of dev.ifaces.filter((x) => x.kind === 'phys')) {
        const p = dev.ports[f.port];
        const admin = f.adminUp && (!p || p.adminUp);
        io.out(pad(f.name, 27) + pad(f.ip != null ? ip(f.ip) : 'unassigned', 16) + pad('YES', 4) + pad(f.dhcp ? 'DHCP' : f.ip != null ? 'manual' : 'unset', 7) + pad(!admin ? 'administratively down' : dev.ifaceUp(f) ? 'up' : 'down', 22) + (dev.ifaceUp(f) ? 'up' : 'down'));
      }
      return;
    }
    if (kw(w, 'nameif', 2)) {
      io.out('Interface                Name                     Security');
      for (const f of dev.ifaces) if (f.nameif) io.out(pad(f.name, 25) + pad(f.nameif, 25) + String(secOf(f)).padStart(3));
      return;
    }
    if (kw(w, 'route', 2)) { showRoute(dev, io); return; }
    if (kw(w, 'xlate', 1)) {
      const st = dev.asaRt || { xlate: new Map(), most: 0 };
      io.out(st.xlate.size + ' in use, ' + Math.max(st.xlate.size, st.most) + ' most used');
      io.out('Flags: D - DNS, e - extended, I - identity, i - dynamic, r - portmap,');
      io.out('       s - static, T - twice, N - net-to-net');
      for (const x of st.xlate.values()) {
        const idle = Math.floor((dev.net.time - x.time) / 100);
        if (x.flags === 's') io.out('NAT from ' + x.realIf + ':' + ip(x.realIp) + ' to ' + x.mappedIf + ':' + ip(x.mappedIp) + ' flags s idle 0:00:' + String(idle % 60).padStart(2, '0') + ' timeout 0:00:00');
        else io.out(x.proto + ' PAT from ' + x.realIf + ':' + ip(x.realIp) + '/' + x.realPort + ' to ' + x.mappedIf + ':' + ip(x.mappedIp) + '/' + x.mappedPort + ' flags ri idle 0:00:' + String(idle % 60).padStart(2, '0') + ' timeout 0:00:30');
      }
      return;
    }
    if (kw(w, 'conn', 2)) {
      const st = dev.asaRt || { conns: new Map(), most: 0 };
      io.out(st.conns.size + ' in use, ' + Math.max(st.conns.size, st.most) + ' most used');
      for (const c of st.conns.values()) {
        const idle = Math.floor((dev.net.time - c.time) / 100);
        io.out(c.proto + ' ' + c.outIf + '  ' + ip(c.dst) + ':' + c.dport + ' ' + c.inIf + '  ' + ip(c.src) + ':' + c.sport + ', idle 0:00:' + String(idle % 60).padStart(2, '0') + ', bytes ' + c.bytes + ', flags ' + (c.proto === 'TCP' ? 'UIO' : '-'));
      }
      return;
    }
    if (kw(w, 'access-list', 2)) {
      for (const [k, l] of Object.entries(dev.asa.acls)) {
        io.out('access-list ' + k + '; ' + l.filter((e) => !e.remark).length + ' elements; name hash: 0x' + (k.length * 2654435761 >>> 0).toString(16).slice(0, 8));
        l.forEach((e, i) => io.out(aclLine(k, e).replace('access-list ' + k + ' ', 'access-list ' + k + ' line ' + (i + 1) + ' ') + (e.remark ? '' : ' (hitcnt=' + (e.hits || 0) + ')')));
      }
      return;
    }
    if (kw(w, 'dhcpd', 2)) {
      if (kw(a[1], 'binding', 1)) {
        io.out('IP address       Client Identifier        Lease expiration        Type');
        for (const [mac, l] of dev.dhcpd.leases) io.out(pad(ip(l.ip), 17) + pad('01' + U.ciscoMac(mac).replace(/\./g, ''), 25) + pad('3600 seconds', 24) + 'Automatic');
        return;
      }
      for (const [n, r] of Object.entries(dev.asa.dhcpd.ranges)) io.out('dhcpd address ' + ip(r.start) + '-' + ip(r.end) + ' ' + n + (dev.asa.dhcpd.enabled.includes(n) ? '\ndhcpd enable ' + n : ''));
      return;
    }
    if (kw(w, 'logging', 3)) { for (const l of dev.logBuf || []) io.out(l); return; }
    if (kw(w, 'service-policy', 2)) {
      io.out('Global policy:');
      io.out('  Service-policy: global_policy');
      io.out('    Class-map: inspection_default');
      for (const x of dev.asa.inspect) io.out('      Inspect: ' + x + ', packet 0, lock fail 0, drop 0, reset-drop 0');
      return;
    }
    if (kw(w, 'clock', 2)) { io.out(U.clockString(dev.net.time, dev.clockOffset || 0)); return; }
    C.invalid(io, w);
  }

  function execCmd(dev, s, t, io) {
    const w = t[0];
    if (kw(w, 'show', 2)) { show(dev, s, t.slice(1), io); return null; }
    if (kw(w, 'ping', 1)) {
      const args = t.slice(1);
      if (args[0] && nameIf(dev, args[0])) args.shift();
      return C.iosPing(dev, args, io);
    }
    if (kw(w, 'traceroute', 3)) return C.iosTraceroute(dev, t.slice(1), io);
    if (s.mode === 'user') {
      if (kw(w, 'enable', 2)) {
        if (!dev.hasEnablePassword()) { s.pending = { prompt: 'Password: ', mask: true, handle: () => { s.mode = 'exec'; return null; } }; return null; }
        C.askPassword(s, io, (pw) => dev.checkEnable(pw), () => { s.mode = 'exec'; }, 'Invalid password');
        return null;
      }
      if (kw(w, 'exit', 3) || kw(w, 'quit', 1) || kw(w, 'logout', 4)) { if (s.via === 'vty') s.closed = true; else io.out('Logoff'); return null; }
      C.invalid(io, w);
      return null;
    }
    if (kw(w, 'configure', 4)) { s.mode = 'config'; return null; }
    if (kw(w, 'disable', 4)) { s.mode = 'user'; return null; }
    if (kw(w, 'exit', 3) || kw(w, 'quit', 1) || kw(w, 'logout', 4)) { if (s.via === 'vty') s.closed = true; else { s.mode = 'user'; io.out(''); io.out('Logoff'); } return null; }
    if ((kw(w, 'write', 2) && (!t[1] || kw(t[1], 'memory', 3))) || (kw(w, 'copy', 2) && kw(t[1], 'running-config', 3) && kw(t[2], 'startup-config', 3))) {
      io.mutate(() => dev.saveNvram());
      io.out('Building configuration...');
      io.out('Cryptochecksum: ' + (dev.net.time * 2654435761 >>> 0).toString(16).padStart(8, '0') + ' 3e1c5e2a 4c9d8f01 7b2a6c55');
      io.out('');
      io.out(runningConfig(dev).join('\n').length + ' bytes copied in 0.140 secs');
      io.out('[OK]');
      return null;
    }
    if (kw(w, 'write', 2) && kw(t[1], 'erase', 2)) { io.mutate(() => dev.eraseNvram()); io.out('[OK]'); return null; }
    if (kw(w, 'reload', 3)) { io.out('Proceed with reload? [confirm]'); io.mutate(() => dev.net.setPower(dev, false)); io.mutate(() => dev.net.setPower(dev, true)); return null; }
    if (kw(w, 'clear', 2)) {
      if (kw(t[1], 'xlate', 1) && dev.asaRt) { dev.asaRt.xlate.clear(); dev.asaRt.byReal.clear(); return null; }
      if (kw(t[1], 'conn', 2) && dev.asaRt) { dev.asaRt.conns.clear(); return null; }
      if (kw(t[1], 'access-list', 2)) { for (const l of Object.values(dev.asa.acls)) for (const e of l) e.hits = 0; return null; }
      if (kw(t[1], 'logging', 3)) { dev.logBuf = []; return null; }
      return null;
    }
    C.invalid(io, w);
    return null;
  }

  function mutate(io, fn) { return C.withMutate(io, fn); }

  function configCmd(dev, s, t, io) {
    const neg = kw(t[0], 'no', 2);
    const a = neg ? t.slice(1) : t;
    const w = a[0];
    const A = dev.asa;
    if (kw(w, 'hostname', 3)) { if (!a[1]) { C.incomplete(io); return; } mutate(io, () => dev.setHostname(a[1])); return; }
    if (kw(w, 'enable', 2) && kw(a[1], 'password', 1)) { mutate(io, () => { dev.setEnableSecret(null); dev.setEnablePassword(neg ? null : a[2] || null); }); return; }
    if (kw(w, 'username', 3)) {
      if (neg) { mutate(io, () => { dev.ios.users = dev.ios.users.filter((u) => u.name !== a[1]); }); return; }
      const pi = a.findIndex((x) => kw(x, 'password', 1));
      if (!a[1] || pi < 0 || !a[pi + 1]) { C.incomplete(io); return; }
      const pr = a.findIndex((x) => kw(x, 'privilege', 2));
      mutate(io, () => dev.setUser(a[1], a[pi + 1], true, pr > 0 ? Number(a[pr + 1]) || 1 : 2));
      return;
    }
    if (kw(w, 'interface', 3)) {
      const f = portByName(dev, a.slice(1).join(''));
      if (!f) { io.out('ERROR: % Invalid Hardware Interface'); return; }
      s.mode = 'if';
      s.ifs = [f];
      return;
    }
    if (kw(w, 'route', 2)) {
      const f = nameIf(dev, a[1]);
      const n = U.parseIp(a[2] || '');
      const m = U.parseMask(a[3] || '') != null ? U.parseMask(a[3]) : (a[3] === '0' ? 0 : null);
      const nh = U.parseIp(a[4] || '');
      const net0 = a[2] === '0' ? 0 : n;
      if (!f) { io.out('ERROR: % Interface name ' + (a[1] || '') + ' not found'); return; }
      if (net0 == null || m == null || (!neg && nh == null)) { C.incomplete(io); return; }
      if (neg) { mutate(io, () => dev.removeRoute(U.net(net0, m), m, nh)); return; }
      mutate(io, () => dev.addRoute(U.net(net0, m), m, nh, { ifName: f.name, ad: Number(a[5]) || 1 }));
      return;
    }
    if (kw(w, 'object', 2) && kw(a[1], 'network', 1)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return; }
      if (neg) { mutate(io, () => { delete A.objects[name]; }); return; }
      if (!A.objects[name]) mutate(io, () => { A.objects[name] = { kind: 'subnet', ip: null, mask: null, nat: null }; });
      s.mode = 'obj';
      s.obj = name;
      return;
    }
    if (kw(w, 'access-list', 2)) {
      const name = a[1];
      if (!name) { C.incomplete(io); return; }
      if (neg && !a[2]) { mutate(io, () => { delete A.acls[name]; }); return; }
      if (kw(a[2], 'remark', 1)) {
        const text = a.slice(3).join(' ');
        mutate(io, () => { if (neg) { A.acls[name] = (A.acls[name] || []).filter((x) => x.remark !== text); if (!A.acls[name].length) delete A.acls[name]; } else (A.acls[name] = A.acls[name] || []).push({ remark: text }); });
        return;
      }
      let i = 2;
      if (kw(a[i], 'extended', 1)) i++;
      const action = kw(a[i], 'permit', 1) ? 'permit' : kw(a[i], 'deny', 1) ? 'deny' : null;
      if (!action) { C.invalid(io, a[i]); return; }
      const proto = String(a[i + 1] || '').toLowerCase();
      if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) { if (!a[i + 1]) C.incomplete(io); else C.invalid(io, a[i + 1]); return; }
      i += 2;
      const src = parseAddr(dev, a, i);
      if (!src || src.err) { io.out(src && src.err ? src.err : 'ERROR: % Incomplete command'); return; }
      i += src.n;
      if (kw(a[i], 'eq', 2)) i += 2; // порт источника — не проверяем
      const dst = parseAddr(dev, a, i);
      if (!dst || dst.err) { io.out(dst && dst.err ? dst.err : 'ERROR: % Incomplete command'); return; }
      i += dst.n;
      let port = null;
      let icmpType = null;
      if (kw(a[i], 'eq', 2)) { const v = a[i + 1]; port = /^\d+$/.test(v || '') ? Number(v) : SVC[String(v || '').toLowerCase()] || null; if (port == null) { C.invalid(io, v); return; } }
      else if (proto === 'icmp' && a[i]) icmpType = { 'echo-reply': 'echo-reply', echo: 'echo-request' }[a[i].toLowerCase()] || null;
      const e = { action, proto, src: src.v, dst: dst.v, port, icmpType, hits: 0 };
      if (neg) { mutate(io, () => { A.acls[name] = (A.acls[name] || []).filter((x) => aclLine(name, x) !== aclLine(name, e)); if (!A.acls[name].length) delete A.acls[name]; }); return; }
      mutate(io, () => { (A.acls[name] = A.acls[name] || []).push(e); });
      return;
    }
    if (kw(w, 'access-group', 8)) {
      const acl = a[1];
      const ii = a.findIndex((x, i) => i >= 2 && kw(x, 'interface', 3));
      const f = ii > 0 ? nameIf(dev, a[ii + 1]) : null;
      if (!acl || !f) { io.out(ii > 0 && a[ii + 1] ? 'ERROR: % Interface name ' + a[ii + 1] + ' not found' : 'ERROR: % Incomplete command'); return; }
      if (kw(a[2], 'out', 3)) { io.out('% В NetLab поддерживаются только входящие access-group (in)'); return; }
      if (!neg && !A.acls[acl]) { io.out('ERROR: access-list <' + acl + '> does not exist'); return; }
      mutate(io, () => { if (neg) delete A.groups[f.nameif.toLowerCase()]; else A.groups[f.nameif.toLowerCase()] = acl; });
      return;
    }
    if (kw(w, 'policy-map', 3)) { if (a[1] !== 'global_policy') { io.out('% В NetLab — только policy-map global_policy'); return; } s.mode = 'pmap'; return; }
    if (kw(w, 'class-map', 3)) { s.mode = 'cmap'; return; }
    if (kw(w, 'service-policy', 3)) return;
    if (kw(w, 'dhcpd', 5)) {
      const d = A.dhcpd;
      if (kw(a[1], 'address', 1)) {
        const [s0, e0] = String(a[2] || '').split('-');
        const st = U.parseIp(s0 || '');
        const en = U.parseIp(e0 || '');
        const f = nameIf(dev, a[3]);
        if (!f) { io.out('ERROR: % Interface name ' + (a[3] || '') + ' not found'); return; }
        if (neg) { mutate(io, () => { delete d.ranges[f.nameif]; syncDhcp(dev); }); return; }
        if (st == null || en == null || en < st) { C.incomplete(io); return; }
        if (f.ip == null || !U.sameNet(st, f.ip, f.mask) || !U.sameNet(en, f.ip, f.mask)) { io.out('Address range subnet ' + ip(st) + ' or ' + ip(en) + ' not same as interface subnet ' + (f.ip != null ? ip(U.net(f.ip, f.mask)) : '0.0.0.0')); return; }
        mutate(io, () => { d.ranges[f.nameif] = { start: st, end: en }; syncDhcp(dev); });
        return;
      }
      if (kw(a[1], 'enable', 1)) {
        const f = nameIf(dev, a[2]);
        if (!f) { io.out('ERROR: % Interface name ' + (a[2] || '') + ' not found'); return; }
        if (!neg && !d.ranges[f.nameif]) { io.out('dhcpd enable ' + f.nameif + ' failed: no address range configured'); return; }
        mutate(io, () => { d.enabled = d.enabled.filter((x) => x !== f.nameif); if (!neg) d.enabled.push(f.nameif); syncDhcp(dev); });
        return;
      }
      if (kw(a[1], 'dns', 2)) { mutate(io, () => { d.dns = neg ? [] : a.slice(2).map((x) => U.parseIp(x)).filter((x) => x != null); syncDhcp(dev); }); return; }
      if (kw(a[1], 'domain', 2)) { mutate(io, () => { d.domain = neg ? '' : a[2] || ''; }); return; }
      if (kw(a[1], 'lease', 1) || kw(a[1], 'option', 1) || kw(a[1], 'auto_config', 2)) return;
      C.invalid(io, a[1]);
      return;
    }
    if (kw(w, 'same-security-traffic', 3)) { mutate(io, () => { A.sameSec = !neg && kw(a[2], 'inter-interface', 6); }); return; }
    if (kw(w, 'telnet', 2) || kw(w, 'ssh', 2) || kw(w, 'http', 2)) {
      if (kw(a[1], 'server', 1) || kw(a[1], 'timeout', 1) || kw(a[1], 'version', 1) || kw(a[1], 'key-exchange', 1)) return;
      const n = U.parseIp(a[1] || '');
      const m = U.parseMask(a[2] || '') != null ? U.parseMask(a[2]) : (a[2] === '0' ? 0 : null);
      const f = nameIf(dev, a[3]);
      if (n == null || m == null || !f) { C.incomplete(io); return; }
      const proto = w.toLowerCase().startsWith('te') ? 'telnet' : w.toLowerCase().startsWith('ss') ? 'ssh' : 'http';
      mutate(io, () => { A.mgmt = A.mgmt.filter((x) => !(x.proto === proto && x.net === U.net(n, m) && x.nameif === f.nameif)); if (!neg) A.mgmt.push({ proto, net: U.net(n, m), mask: m, nameif: f.nameif }); });
      return;
    }
    if (kw(w, 'icmp', 2) || kw(w, 'logging', 3) || kw(w, 'names', 5) || kw(w, 'ftp', 2) || kw(w, 'crypto', 2) || kw(w, 'aaa', 3) || kw(w, 'domain-name', 3) || kw(w, 'dns', 3) || kw(w, 'mtu', 3) || kw(w, 'timeout', 4) || kw(w, 'passwd', 4)) return;
    C.invalid(io, w);
  }

  function ifCmd(dev, s, t, io) {
    const neg = kw(t[0], 'no', 2);
    const a = neg ? t.slice(1) : t;
    const f = s.ifs[0];
    const w = a[0];
    if (kw(w, 'nameif', 2)) {
      if (neg) { mutate(io, () => { delete dev.asa.groups[(f.nameif || '').toLowerCase()]; f.nameif = null; f.secLevel = null; }); return; }
      const n = a[1];
      if (!n || !/^[A-Za-z][\w-]{0,47}$/.test(n)) { C.incomplete(io); return; }
      if (dev.ifaces.some((g) => g !== f && g.nameif && g.nameif.toLowerCase() === n.toLowerCase())) { io.out('ERROR: Name ' + n + ' is used by another interface'); return; }
      const lvl = n.toLowerCase() === 'inside' ? 100 : 0;
      mutate(io, () => { f.nameif = n; if (f.secLevel == null) f.secLevel = lvl; });
      io.out('INFO: Security level for "' + n + '" set to ' + secOf(f) + ' by default.');
      return;
    }
    if (kw(w, 'security-level', 2)) {
      const v = Number(a[1]);
      if (!neg && !(Number.isInteger(v) && v >= 0 && v <= 100)) { C.incomplete(io); return; }
      mutate(io, () => { f.secLevel = neg ? 0 : v; });
      if (dev.asaRt) dev.asaRt.conns.clear();
      return;
    }
    if (kw(w, 'ip', 2) && kw(a[1], 'address', 1)) {
      if (neg) { mutate(io, () => { f.dhcp = false; dev.setIfaceIp(f, null, null); }); return; }
      if (kw(a[2], 'dhcp', 1)) {
        mutate(io, () => { dev.setIfaceIp(f, null, null); f.dhcp = true; f.setroute = a.some((x) => kw(x, 'setroute', 1)); dev.startDhcp(f); });
        return;
      }
      const v = U.parseIp(a[2] || '');
      const m = U.parseMask(a[3] || '');
      if (v == null || m == null) { C.incomplete(io); return; }
      mutate(io, () => { f.dhcp = false; dev.setIfaceIp(f, v, m); syncDhcp(dev); });
      return;
    }
    if (kw(w, 'shutdown', 2)) { mutate(io, () => dev.setIfaceAdmin(f, neg)); return; }
    if (kw(w, 'description', 1) || kw(w, 'speed', 2) || kw(w, 'duplex', 2) || kw(w, 'mtu', 2)) return;
    if (kw(w, 'interface', 3) || kw(w, 'route', 2) || kw(w, 'object', 2) || kw(w, 'access-list', 2) || kw(w, 'access-group', 8) || kw(w, 'dhcpd', 5) || kw(w, 'hostname', 3)) { s.mode = 'config'; configCmd(dev, s, t, io); return; }
    C.invalid(io, w);
  }

  function objCmd(dev, s, t, io) {
    const o = dev.asa.objects[s.obj];
    const neg = kw(t[0], 'no', 2);
    const a = neg ? t.slice(1) : t;
    const w = a[0];
    if (!o) { s.mode = 'config'; return; }
    if (kw(w, 'host', 1)) { const v = U.parseIp(a[1] || ''); if (v == null) { C.incomplete(io); return; } mutate(io, () => Object.assign(o, { kind: 'host', ip: v, mask: 0xFFFFFFFF })); return; }
    if (kw(w, 'subnet', 1)) {
      const v = U.parseIp(a[1] || '');
      const m = U.parseMask(a[2] || '');
      if (v == null || m == null) { C.incomplete(io); return; }
      mutate(io, () => Object.assign(o, { kind: 'subnet', ip: U.net(v, m), mask: m }));
      return;
    }
    if (kw(w, 'nat', 3)) {
      if (neg) { mutate(io, () => { o.nat = null; }); if (dev.asaRt) { dev.asaRt.xlate.clear(); dev.asaRt.byReal.clear(); } return; }
      const m = /^\(([\w-]+),([\w-]+)\)$/.exec(a[1] || '');
      if (!m) { io.out('ERROR: % Invalid input: укажите (real_ifc,mapped_ifc), например nat (inside,outside) dynamic interface'); return; }
      const [, real, mapped] = m;
      if (!nameIf(dev, real) || !nameIf(dev, mapped)) { io.out('ERROR: % Interface name ' + (nameIf(dev, real) ? mapped : real) + ' not found'); return; }
      if (kw(a[2], 'dynamic', 1)) {
        const addr = kw(a[3], 'interface', 1) ? null : U.parseIp(a[3] || '');
        if (!kw(a[3], 'interface', 1) && addr == null) { C.incomplete(io); return; }
        mutate(io, () => { o.nat = { real, mapped, type: 'dynamic', addr }; });
        return;
      }
      if (kw(a[2], 'static', 1)) {
        const addr = U.parseIp(a[3] || '');
        if (addr == null) { C.incomplete(io); return; }
        mutate(io, () => { o.nat = { real, mapped, type: 'static', addr }; });
        return;
      }
      C.incomplete(io);
      return;
    }
    if (kw(w, 'description', 1) || kw(w, 'range', 1)) return;
    s.mode = 'config';
    configCmd(dev, s, t, io);
  }

  function pmapCmd(dev, s, t, io) {
    const neg = kw(t[0], 'no', 2);
    const a = neg ? t.slice(1) : t;
    if (s.mode === 'pmap' || kw(a[0], 'class', 2)) {
      if (kw(a[0], 'class', 2)) { if (a[1] !== 'inspection_default') { io.out('% В NetLab — только class inspection_default'); return; } s.mode = 'pmapc'; return; }
      if (kw(a[0], 'parameters', 3) || kw(a[0], 'description', 1)) return;
      s.mode = 'config';
      configCmd(dev, s, t, io);
      return;
    }
    if (kw(a[0], 'inspect', 3)) {
      const x = String(a[1] || '').toLowerCase();
      if (!x) { C.incomplete(io); return; }
      mutate(io, () => { dev.asa.inspect = dev.asa.inspect.filter((y) => y !== x); if (!neg) dev.asa.inspect.push(x); });
      if (neg && x === 'icmp' && dev.asaRt) for (const [k, c] of dev.asaRt.conns) if (c.proto === 'ICMP') dev.asaRt.conns.delete(k);
      return;
    }
    s.mode = 'config';
    configCmd(dev, s, t, io);
  }

  function execConfig(dev, s, line, io) {
    const t = C.tokenize(line);
    if (!t.length) return null;
    if (kw(t[0], 'end', 2)) { s.mode = 'exec'; s.ifs = null; return null; }
    if (kw(t[0], 'exit', 3)) { s.mode = s.mode === 'config' ? 'exec' : s.mode === 'pmapc' ? 'pmap' : 'config'; s.ifs = null; return null; }
    // ASA позволяет show и ping прямо в режиме конфигурации
    if (kw(t[0], 'show', 2) || kw(t[0], 'ping', 1) || kw(t[0], 'write', 2) || kw(t[0], 'copy', 2) || kw(t[0], 'clear', 2)) return execCmd(dev, Object.assign({}, s, { mode: 'exec' }), t, io);
    if (kw(t[0], 'do', 2)) return execCmd(dev, Object.assign({}, s, { mode: 'exec' }), t.slice(1), io);
    switch (s.mode) {
      case 'if': ifCmd(dev, s, t, io); break;
      case 'obj': objCmd(dev, s, t, io); break;
      case 'pmap': case 'pmapc': pmapCmd(dev, s, t, io); break;
      case 'cmap': if (!kw(t[0], 'match', 1)) { s.mode = 'config'; configCmd(dev, s, t, io); } break;
      default: configCmd(dev, s, t, io);
    }
    return null;
  }

  const TREE = {
    user: ['enable', 'exit', 'ping WORD', 'show version', 'show interface ip brief', 'show route'],
    exec: ['configure terminal', 'show running-config', 'show interface ip brief', 'show nameif', 'show route', 'show xlate', 'show conn', 'show access-list', 'show dhcpd binding', 'show service-policy', 'show logging', 'write memory', 'copy running-config startup-config', 'clear xlate', 'clear conn', 'ping WORD', 'disable', 'exit'],
    config: ['hostname WORD', 'interface WORD', 'route WORD A.B.C.D A.B.C.D A.B.C.D', 'object network WORD', 'access-list WORD extended permit icmp any any', 'access-group WORD in interface WORD',
      'policy-map global_policy', 'dhcpd address A.B.C.D-A.B.C.D WORD', 'dhcpd dns A.B.C.D', 'dhcpd enable WORD', 'same-security-traffic permit inter-interface', 'telnet A.B.C.D A.B.C.D WORD', 'enable password WORD', 'username WORD password WORD', 'end', 'exit'],
    if: ['nameif WORD', 'security-level WORD', 'ip address A.B.C.D A.B.C.D', 'ip address dhcp setroute', 'no shutdown', 'shutdown', 'exit'],
    obj: ['host A.B.C.D', 'subnet A.B.C.D A.B.C.D', 'nat (inside,outside) dynamic interface', 'nat (inside,outside) static A.B.C.D', 'exit'],
    pmap: ['class inspection_default', 'exit'],
    pmapc: ['inspect icmp', 'inspect http', 'inspect dns', 'no inspect icmp', 'exit'],
    cmap: ['match default-inspection-traffic', 'exit'],
  };

  NS.cliAsa = {
    createSession,
    prompt,
    runningConfig,
    exec(dev, s, line, io) {
      const t = C.tokenize(line);
      if (!t.length) return null;
      if (line.trim()) { s.history.push(line.trim()); if (s.history.length > 50) s.history.shift(); }
      if (/\?$/.test(line.trim())) {
        const pre = line.trim().replace(/\?$/, '').trim().toLowerCase();
        const list = (s.mode === 'exec' ? TREE.exec : TREE[s.mode] || TREE.exec).filter((l) => l.toLowerCase().startsWith(pre));
        (list.length ? list : ['% Unrecognized command']).forEach((l) => io.out('  ' + l));
        return null;
      }
      if (s.mode === 'user' || s.mode === 'exec') return execCmd(dev, s, t, io);
      return execConfig(dev, s, line, io);
    },
    complete(dev, s, line) {
      const list = TREE[s.mode] || TREE.exec;
      const m = list.filter((x) => x.toLowerCase().startsWith(line.trim().toLowerCase()));
      if (m.length === 1) return m[0].split(' ').filter((w) => !/^(WORD|A\.B\.C\.D)/.test(w)).join(' ') + ' ';
      return line;
    },
    tree: TREE,
  };

  NS.asa = { aclCheck, keyOf, revKeyOf, nameIf, syncDhcp, secOf, aclLine };
})(globalThis.NetLab = globalThis.NetLab || {});
