/* NetLab — резервирование шлюза (FHRP): HSRP (v1/v2), VRRP, GLBP.
 * Маршрутизаторы одного сегмента с одинаковой группой выбирают активного (приоритет, затем больший IP;
 * preempt, track интерфейсов, владелец адреса в VRRP). Активный отвечает на ARP за виртуальный IP
 * виртуальным MAC, принимает кадры на него и отвечает на ping; при смене активного он рассылает
 * gratuitous ARP — коммутаторы переучивают MAC, и компьютеры продолжают работать через тот же шлюз.
 * GLBP: AVG раздаёт компьютерам MAC разных AVF по кругу (балансировка), MAC упавшего AVF берёт на себя AVG.
 * HSRP для IPv6 (standby version 2, standby N ipv6 autoconfig | FE80::…): активный отвечает за виртуальный
 * link-local адрес и MAC 0005.73A0.0xxx и один посылает Router Advertisement — узлы берут шлюзом виртуальный адрес. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const PROTOS = ['hsrp', 'vrrp', 'glbp'];
  const hex = (n, w) => n.toString(16).padStart(w, '0').toUpperCase();
  const macOf = (s) => s.match(/../g).join(':');

  function vmac(proto, g, ver, fwd) {
    if (proto === 'hsrp') return ver === 2 ? macOf('00000C9FF' + hex(g, 3)) : macOf('00000C07AC' + hex(g & 255, 2));
    if (proto === 'vrrp') return macOf('00005E0001' + hex(g & 255, 2));
    return macOf('0007B400' + hex(g & 255, 2) + hex(fwd || 1, 2));
  }

  const ROLE = {
    hsrp: { active: 'Active', standby: 'Standby', other: 'Listen', fac: 'HSRP', mnem: 'STATECHANGE' },
    vrrp: { active: 'Master', standby: 'Backup', other: 'Backup', fac: 'VRRP', mnem: 'STATECHANGE' },
    glbp: { active: 'Active', standby: 'Standby', other: 'Listen', fac: 'GLBP', mnem: 'FWDSTATECHANGE' },
  };

  function pointKey(dev, f) {
    if (f.kind === 'svi') return dev.id + '|svi|' + f.vlan;
    return dev.id + '|' + f.port + '|' + (f.kind === 'sub' ? f.vlan : 'u');
  }

  /** Действующий приоритет с учётом track (упал отслеживаемый интерфейс — приоритет ниже). */
  function effPrio(dev, f, proto, c) {
    let p = c.prio;
    if (proto === 'vrrp' && c.ip === f.ip) return 255; // владелец адреса
    for (const t of c.track || []) {
      if (t.obj != null) { if (!(NS.track && NS.track.up(dev, t.obj))) p -= t.dec; continue; }
      const x = dev.ifaceByName(t.ifname);
      if (!x || !dev.ifaceUp(x)) p -= t.dec;
    }
    return Math.max(0, p);
  }

  function elect(net) {
    const cands = [];
    for (const d of net.devices.values()) {
      if (!d.ifaces || !d.power) continue;
      for (const f of d.ifaces) {
        if (!f.fhrp) continue;
        if (!f.fhrpRt) f.fhrpRt = { hsrp: {}, vrrp: {}, glbp: {} };
        for (const proto of PROTOS) {
          for (const [g, c] of Object.entries(f.fhrp[proto] || {})) {
            if (c.ip == null) continue;
            const up = f.ip != null && d.ifaceUp(f) && (f.kind !== 'phys' || !d.ports[f.port] || d.ports[f.port].adminUp);
            const rt = f.fhrpRt[proto][g] || (f.fhrpRt[proto][g] = { state: 'Init', since: net.time });
            if (!up) { if (rt.state !== 'Init') setState(d, f, proto, g, rt, 'Init'); rt.active = null; rt.standby = null; continue; }
            cands.push({ dev: d, f, proto, g: Number(g), c, rt, prio: effPrio(d, f, proto, c), key: pointKey(d, f), reach: null });
          }
        }
      }
    }
    // сегменты: кандидаты, видящие друг друга на 2-м уровне
    for (const x of cands) x.reach = NS.routing.reach(net, x.dev, x.f);
    const clusters = [];
    const used = new Set();
    for (const x of cands) {
      if (used.has(x)) continue;
      const cl = [x];
      used.add(x);
      for (let i = 0; i < cl.length; i++) {
        for (const y of cands) {
          if (used.has(y) || y.proto !== x.proto || y.g !== x.g) continue;
          if (cl[i].reach.has(y.key) || y.reach.has(cl[i].key)) { cl.push(y); used.add(y); }
        }
      }
      clusters.push(cl);
    }
    if (!net.glbpFwd) net.glbpFwd = new Map();
    for (const cl of clusters) {
      const proto = cl[0].proto;
      const g = cl[0].g;
      const preemptDefault = proto === 'vrrp';
      const rank = (a, b) => (b.prio - a.prio) || (b.f.ip - a.f.ip);
      const sorted = cl.slice().sort(rank);
      let active = sorted[0];
      const cur = cl.find((x) => x.rt.state === ROLE[proto].active);
      if (cur && cur !== active) {
        const pre = active.c.preempt != null ? active.c.preempt : preemptDefault;
        if (!pre && !(proto === 'vrrp' && active.prio === 255)) active = cur;
      }
      const rest = sorted.filter((x) => x !== active);
      const standby = rest[0] || null;
      const vip = active.c.ip != null ? active.c.ip : (cl.find((x) => x.c.ip != null) || {}).c.ip;
      // GLBP: номера AVF по порядку IP; MAC пропавших AVF берёт AVG
      let owners = null;
      if (proto === 'glbp') {
        const ck = 'glbp|' + g + '|' + vip;
        const reg = net.glbpFwd.get(ck) || new Map();
        const alive = new Set(cl.map((x) => x.dev.id + '|' + x.f.name));
        const byIp = cl.slice().sort((a, b) => a.f.ip - b.f.ip);
        for (const x of byIp) {
          const id = x.dev.id + '|' + x.f.name;
          if (![...reg.values()].includes(id) && reg.size < 4) reg.set(reg.size + 1, id);
        }
        owners = new Map();
        for (const [num, id] of reg) owners.set(num, alive.has(id) ? id : active.dev.id + '|' + active.f.name);
        net.glbpFwd.set(ck, reg);
      }
      for (const x of cl) {
        const want = x === active ? ROLE[proto].active : x === standby ? ROLE[proto].standby : ROLE[proto].other;
        x.rt.active = active.f.ip;
        x.rt.standby = standby ? standby.f.ip : null;
        x.rt.prio = x.prio;
        x.rt.members = cl.length;
        x.rt.vip = vip;
        x.rt.fwd = owners ? [...owners].filter(([, id]) => id === x.dev.id + '|' + x.f.name).map(([n]) => n) : null;
        x.rt.owners = owners ? [...owners] : null;
        if (x.rt.state !== want) setState(x.dev, x.f, proto, g, x.rt, want);
      }
    }
    // что принимает и за что отвечает каждый интерфейс
    for (const d of net.devices.values()) {
      if (!d.ifaces) continue;
      for (const f of d.ifaces) {
        const macs = new Set();
        const vips = new Map();
        if (f.fhrp && f.fhrpRt && d.power) {
          for (const proto of PROTOS) {
            for (const [g, rt] of Object.entries(f.fhrpRt[proto])) {
              const c = (f.fhrp[proto] || {})[g];
              if (!c) continue;
              const ver = f.fhrp.hsrpVer || 1;
              if (rt.state === ROLE[proto].active) {
                const m = vmac(proto, Number(g), ver, 1);
                if (proto !== 'glbp') macs.add(m);
                vips.set(rt.vip, { proto, g: Number(g), mac: m, rt });
              }
              if (proto === 'glbp') for (const n of rt.fwd || []) macs.add(vmac('glbp', Number(g), 1, n));
            }
          }
        }
        const old = f.fhrpMacs ? [...f.fhrpMacs].join() : '';
        f.fhrpMacs = macs;
        f.fhrpVips = vips;
        // новый владелец MAC сообщает о себе — коммутаторы переучивают таблицу
        for (const m of macs) if (!old.includes(m)) announce(d, f, m, [...vips.keys()][0] || (f.fhrpRt && Object.values(f.fhrpRt.glbp)[0] ? Object.values(f.fhrpRt.glbp)[0].vip : f.ip));
      }
    }
  }

  function setState(dev, f, proto, g, rt, st) {
    const from = rt.state;
    rt.state = st;
    rt.since = dev.net.time;
    rt.changes = (rt.changes || 0) + 1;
    if (dev.iosLog && from !== st) {
      const R = ROLE[proto];
      if (proto === 'glbp') dev.iosLog('GLBP', 6, 'STATECHANGE', NS.cliIos.ctx.shortIf(f.name) + ' Grp ' + g + ' state ' + from + ' -> ' + st);
      else dev.iosLog(R.fac, 6, R.mnem, NS.cliIos.ctx.shortIf(f.name) + ' Grp ' + g + ' state ' + from + ' -> ' + st);
    }
  }

  function announce(dev, f, mac, vip) {
    if (vip == null || !dev.power) return;
    const a = P.arp('reply', mac, vip, U.BROADCAST_MAC, vip);
    dev.timer(1, () => {
      if (!f.fhrpMacs || !f.fhrpMacs.has(mac)) return;
      dev.ifaceSend(f, P.frame(mac, U.BROADCAST_MAC, 'ARP', a, f.kind === 'sub' ? f.vlan : null), 'Gratuitous ARP: виртуальный адрес ' + U.ipStr(vip) + ' теперь у меня (' + mac + ')');
    });
  }

  // выборы — после пересчёта STP (порты и VLAN уже известны)
  const stpCompute = NS.stp.compute;
  NS.stp.compute = function (net) {
    const r = stpCompute.call(this, net);
    try { elect(net); elect6(net); } catch (e) { console.error(e); }
    return r;
  };

  /* ---------- приём, ARP, ping виртуального адреса ---------- */

  const ipIngress = IpNode.prototype.ipIngress;
  IpNode.prototype.ipIngress = function (f, frame) {
    if (f.fhrpMacs && f.fhrpMacs.has(frame.dst)) frame = Object.assign({}, frame, { dst: this.ifaceMac(f) });
    return ipIngress.call(this, f, frame);
  };

  const isForMe = IpNode.prototype.isForMe;
  IpNode.prototype.isForMe = function (ip, f) {
    if (isForMe.call(this, ip, f)) return true;
    return !!(f && f.fhrpVips && f.fhrpVips.has(ip));
  };

  const onArp = IpNode.prototype.onArp;
  IpNode.prototype.onArp = function (f, a, frame) {
    const v = a && a.op === 'request' && f.fhrpVips ? f.fhrpVips.get(a.targetIp) : null;
    if (!v || a.senderIp === a.targetIp) return onArp.call(this, f, a, frame);
    if (a.senderIp && f.ip != null && U.sameNet(a.senderIp, f.ip, f.mask)) this.learnArp(a.senderIp, a.senderMac, f);
    let mac = v.mac;
    if (v.proto === 'glbp') {
      // AVG раздаёт MAC разных AVF по кругу
      const list = (v.rt.owners || []).map(([n]) => n);
      v.rt.rr = ((v.rt.rr || 0) % Math.max(1, list.length)) + 1;
      mac = vmac('glbp', v.g, 1, list[v.rt.rr - 1] || 1);
    }
    const r = P.arp('reply', mac, a.targetIp, a.senderMac, a.senderIp);
    // GLBP: MAC AVF — только внутри ARP; кадр уходит от собственного адреса AVG, иначе коммутатор привяжет чужой MAC к нашему порту
    const src = v.proto === 'glbp' ? this.ifaceMac(f) : mac;
    this.ifaceSend(f, P.frame(src, a.senderMac, 'ARP', r, f.kind === 'sub' ? f.vlan : null),
      'ARP-ответ ' + ({ hsrp: 'HSRP', vrrp: 'VRRP', glbp: 'GLBP' }[v.proto]) + ': виртуальный шлюз ' + U.ipStr(a.targetIp) + ' — это ' + mac);
  };


  /* ================= HSRP для IPv6 (standby version 2, standby N ipv6 autoconfig) ================= */

  const ip6 = NS.ip6;
  const P6 = IpNode.prototype;
  const vmac6 = (g) => macOf('000573A0' + hex(g, 4));
  const vll6 = (g) => ip6.parse('fe80::5:73ff:fea0:' + g.toString(16));
  const cmp6 = (a, b) => (a > b ? 1 : a < b ? -1 : 0);

  function elect6(net) {
    const cands = [];
    for (const d of net.devices.values()) {
      if (!d.ifaces) continue;
      for (const f of d.ifaces) {
        f.hsrp6Vip = null;
        if (!d.power || !f.fhrp || f.fhrp.hsrpVer !== 2 || !d.ll6) continue;
        for (const [g, c] of Object.entries(f.fhrp.hsrp || {})) {
          if (c.ip6 == null) continue;
          if (!f.hsrp6Rt) f.hsrp6Rt = {};
          const rt = f.hsrp6Rt[g] || (f.hsrp6Rt[g] = { state: 'Init', since: net.time });
          const ok = !!f.v6 && d.ifaceUp(f) && d.forwarding6 && d.forwarding6() && (f.kind !== 'phys' || !d.ports[f.port] || d.ports[f.port].adminUp);
          if (!ok) { if (rt.state !== 'Init') setState(d, f, 'hsrp', g, rt, 'Init'); rt.active = null; rt.standby = null; continue; }
          cands.push({ dev: d, f, g: Number(g), c, rt, prio: effPrio(d, f, 'hsrp', c), key: pointKey(d, f), reach: NS.routing.reach(net, d, f), ll: d.ll6(f) });
        }
      }
    }
    const used = new Set();
    for (const x of cands) {
      if (used.has(x)) continue;
      const cl = [x];
      used.add(x);
      for (let i = 0; i < cl.length; i++) {
        for (const y of cands) {
          if (used.has(y) || y.g !== x.g) continue;
          if (cl[i].reach.has(y.key) || y.reach.has(cl[i].key)) { cl.push(y); used.add(y); }
        }
      }
      const sorted = cl.slice().sort((a, b) => (b.prio - a.prio) || cmp6(b.ll, a.ll));
      let active = sorted[0];
      const cur = cl.find((y) => y.rt.state === 'Active');
      if (cur && cur !== active && !active.c.preempt) active = cur;
      const standby = sorted.filter((y) => y !== active)[0] || null;
      for (const y of cl) {
        const want = y === active ? 'Active' : y === standby ? 'Standby' : 'Listen';
        Object.assign(y.rt, { active: active.ll, standby: standby ? standby.ll : null, prio: y.prio, vip: active.c.ip6 });
        const became = want === 'Active' && y.rt.state !== 'Active';
        if (y.rt.state !== want) setState(y.dev, y.f, 'hsrp', y.g, y.rt, want);
        if (want === 'Active') {
          const vip = y.c.ip6;
          const mac = vmac6(y.g);
          y.f.hsrp6Vip = y.f.hsrp6Vip || new Map();
          y.f.hsrp6Vip.set(vip, { g: y.g, mac });
          if (!y.f.fhrpMacs) y.f.fhrpMacs = new Set();
          y.f.fhrpMacs.add(mac);
          if (became) announce6(y.dev, y.f, y.g, vip);
        }
      }
    }
  }

  /** Новый активный: Neighbor Advertisement и Router Advertisement от виртуального адреса — коммутаторы и узлы переучиваются. */
  function announce6(dev, f, g, vip) {
    dev.timer(1, () => {
      if (!f.hsrp6Vip || !f.hsrp6Vip.has(vip) || !dev.power) return;
      const mac = vmac6(g);
      const na = P.ipv6(vip, ip6.ALL_NODES, 'ICMPv6', { type: 'na', target: vip, mac, router: true, solicited: false }, 255);
      dev.ifaceSend(f, P.frame(mac, ip6.mcastMac(ip6.ALL_NODES), 'IPv6', na, f.kind === 'sub' ? f.vlan : null), 'HSRP IPv6: виртуальный адрес ' + ip6.str(vip, true) + ' теперь у меня (' + mac + ')');
      dev.sendRA6(f, null);
    });
  }

  const isMine6 = P6.isMine6;
  P6.isMine6 = function (dst, f) {
    if (f && f.hsrp6Vip && f.hsrp6Vip.has(dst)) return true;
    return isMine6.call(this, dst, f);
  };

  const deliver6 = P6.deliver6;
  P6.deliver6 = function (pkt, f, frame) {
    const m = pkt.payload;
    if (f && f.hsrp6Vip && pkt.next === 'ICMPv6' && m && m.type === 'ns' && f.hsrp6Vip.has(m.target)) {
      const v = f.hsrp6Vip.get(m.target);
      if (pkt.src !== 0n) this.learn6(pkt.src, m.mac, f, false);
      const na = P.ipv6(m.target, pkt.src, 'ICMPv6', { type: 'na', target: m.target, mac: v.mac, router: true, solicited: true }, 255);
      this.ifaceSend(f, P.frame(v.mac, m.mac, 'IPv6', na, f.kind === 'sub' ? f.vlan : null), 'Neighbor Advertisement HSRP: виртуальный шлюз ' + ip6.str(m.target, true) + ' — это ' + v.mac);
      return;
    }
    return deliver6.call(this, pkt, f, frame);
  };

  // RA на интерфейсе с HSRP IPv6 посылает только активный — от виртуального адреса
  const sendRA6 = P6.sendRA6;
  P6.sendRA6 = function (f, dst) {
    const groups = f && f.fhrp && f.fhrp.hsrpVer === 2 ? Object.values(f.fhrp.hsrp || {}).filter((c) => c.ip6 != null) : [];
    if (!groups.length) return sendRA6.call(this, f, dst);
    if (!this.forwarding6() || !f.v6 || !f.hsrp6Vip || !f.hsrp6Vip.size) return;
    const [vip, v] = [...f.hsrp6Vip][0];
    const prefixes = f.v6.addrs.filter((a) => a.plen === 64 && a.origin !== 'slaac').map((a) => ({ net: ip6.net(a.addr, 64), plen: 64 }));
    const r = f.v6r || {};
    const ra = P.ipv6(vip, ip6.ALL_NODES, 'ICMPv6', { type: 'ra', mac: v.mac, prefixes, managed: !!r.ndM, other: !!r.ndO }, 255);
    this.ifaceSend(f, P.frame(v.mac, ip6.mcastMac(ip6.ALL_NODES), 'IPv6', ra, f.kind === 'sub' ? f.vlan : null),
      'Router Advertisement HSRP: шлюз — виртуальный ' + ip6.str(vip, true) + (prefixes.length ? ', префикс ' + prefixes.map((x) => ip6.cidr(x.net, 64, true)).join(', ') : ''));
  };

  /* ---------- сохранение ---------- */

  IpNode.ifaceExt.push({
    key: 'fhrp',
    save(f) {
      if (!f.fhrp) return null;
      const out = {};
      if (f.fhrp.hsrpVer === 2) out.hsrpVer = 2;
      for (const proto of PROTOS) {
        const gs = f.fhrp[proto] || {};
        if (!Object.keys(gs).length) continue;
        out[proto] = Object.fromEntries(Object.entries(gs).map(([g, c]) => [g, Object.assign({ ip: c.ip != null ? U.ipStr(c.ip) : null, prio: c.prio, preempt: c.preempt, track: (c.track || []).map((t) => Object.assign({}, t)), lb: c.lb || null },
          c.ip6 != null ? { ip6: c.auto6 ? 'autoconfig' : ip6.str(c.ip6) } : {})]));
      }
      return Object.keys(out).length ? out : null;
    },
    load(f, d) {
      f.fhrp = null;
      f.fhrpRt = null;
      if (!d) return;
      f.fhrp = { hsrpVer: d.hsrpVer === 2 ? 2 : 1, hsrp: {}, vrrp: {}, glbp: {} };
      for (const proto of PROTOS) {
        for (const [g, c] of Object.entries(d[proto] || {})) {
          f.fhrp[proto][g] = { ip: c.ip ? U.parseIp(c.ip) : null, prio: Number.isInteger(c.prio) ? c.prio : 100, preempt: c.preempt == null ? null : !!c.preempt, track: (c.track || []).map((t) => (t.obj != null ? { obj: Number(t.obj), dec: Number(t.dec) || 10 } : { ifname: String(t.ifname), dec: Number(t.dec) || 10 })), lb: c.lb || null };
          if (c.ip6) { f.fhrp[proto][g].ip6 = c.ip6 === 'autoconfig' ? vll6(Number(g)) : ip6.parse(c.ip6); f.fhrp[proto][g].auto6 = c.ip6 === 'autoconfig'; }
        }
      }
    },
  });

  IpNode.hooks.runtime.push(function () {
    if (this.ifaces) for (const f of this.ifaces) { f.fhrpRt = null; f.fhrpMacs = null; f.fhrpVips = null; f.hsrp6Rt = null; f.hsrp6Vip = null; }
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;

  function cfgOf(f, proto, g) {
    if (!f.fhrp) f.fhrp = { hsrpVer: 1, hsrp: {}, vrrp: {}, glbp: {} };
    if (!f.fhrp[proto][g]) f.fhrp[proto][g] = { ip: null, prio: 100, preempt: null, track: [], lb: null };
    return f.fhrp[proto][g];
  }

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    const w = a[0];
    const proto = C.kw(w, 'standby', 3) ? 'hsrp' : C.kw(w, 'vrrp', 4) ? 'vrrp' : C.kw(w, 'glbp', 4) ? 'glbp' : null;
    if (!proto) return false;
    const ifs = targets.map((r) => C.ifaceOf(dev, r)).filter(Boolean);
    if (!ifs.length || (dev.type === 'switch' && !dev.l3)) { io.out('% ' + w + ' работает на интерфейсах 3-го уровня маршрутизатора или коммутатора 3560'); return true; }
    if (proto === 'hsrp' && C.kw(a[1], 'version', 1)) {
      const v = Number(a[2]);
      if (!neg && v !== 1 && v !== 2) { C.invalid(io, a[2]); return true; }
      C.withMutate(io, () => { for (const f of ifs) { if (!f.fhrp) f.fhrp = { hsrpVer: 1, hsrp: {}, vrrp: {}, glbp: {} }; f.fhrp.hsrpVer = neg ? 1 : v; } });
      dev.net.refreshTopology();
      return true;
    }
    let g = 0;
    let rest = a.slice(1);
    if (/^\d+$/.test(a[1] || '')) { g = Number(a[1]); rest = a.slice(2); }
    else if (proto !== 'hsrp') { C.incomplete(io); return true; }
    const max = proto === 'hsrp' ? 4095 : 255;
    if (g > max) { C.invalid(io, a[1]); return true; }
    const cmd = rest[0];
    const apply = (fn) => { C.withMutate(io, () => { for (const f of ifs) fn(f, cfgOf(f, proto, g)); }); dev.net.refreshTopology(); };
    if (proto === 'hsrp' && C.kw(cmd, 'ipv6', 4)) {
      if (neg) { C.withMutate(io, () => { for (const f of ifs) if (f.fhrp && f.fhrp.hsrp[g]) delete f.fhrp.hsrp[g]; }); dev.net.refreshTopology(); return true; }
      if (ifs.some((f) => !f.fhrp || f.fhrp.hsrpVer !== 2)) { io.out('% HSRP для IPv6 работает только в версии 2 — сначала standby version 2'); return true; }
      const auto = C.kw(rest[1], 'autoconfig', 1);
      const v = auto ? vll6(g) : ip6.parse(rest[1] || '');
      if (v == null) { if (rest[1]) C.invalid(io, rest[1]); else C.incomplete(io); return true; }
      if (!auto && !ip6.isLinkLocal(v)) { io.out('% Виртуальный адрес HSRP IPv6 — link-local (FE80::…) или autoconfig'); return true; }
      apply((f, c) => { c.ip6 = v; c.auto6 = auto; });
      return true;
    }
    if (C.kw(cmd, 'ip', 2)) {
      if (neg) { C.withMutate(io, () => { for (const f of ifs) if (f.fhrp && f.fhrp[proto]) delete f.fhrp[proto][g]; }); dev.net.refreshTopology(); return true; }
      const ipv = U.parseIp(rest[1] || '');
      if (ipv == null) { C.incomplete(io); return true; }
      for (const f of ifs) {
        if (f.ip == null || !U.sameNet(ipv, f.ip, f.mask)) { io.out('% Address ' + U.ipStr(ipv) + ' in group ' + g + ' must be in the subnet of ' + f.name + (f.ip == null ? ' (сначала задайте ip address)' : '')); return true; }
      }
      apply((f, c) => { c.ip = ipv; });
      return true;
    }
    if (C.kw(cmd, 'priority', 2)) {
      const n = Number(rest[1]);
      if (!neg && !(n >= 1 && n <= 254)) { C.invalid(io, rest[1]); return true; }
      apply((f, c) => { c.prio = neg ? 100 : n; });
      return true;
    }
    if (C.kw(cmd, 'preempt', 2)) { apply((f, c) => { c.preempt = !neg; }); return true; }
    if (C.kw(cmd, 'track', 2) && /^\d+$/.test(rest[1] || '')) {
      // объект отслеживания (track N): standby 1 track 1 decrement 20
      const obj = Number(rest[1]);
      const dec = Number(rest[2] && C.kw(rest[2], 'decrement', 1) ? rest[3] : rest[2]) || 10;
      apply((f, c) => { c.track = (c.track || []).filter((t) => t.obj !== obj); if (!neg) c.track.push({ obj, dec }); });
      return true;
    }
    if (C.kw(cmd, 'track', 2)) {
      const r = C.parseIfName(dev, rest[1] || '');
      const tf = r && C.ifaceOf(dev, r);
      if (!tf) { C.invalid(io, rest[1]); return true; }
      const dec = Number(rest.find((x, i) => i > 1 && /^\d+$/.test(x)) || (rest[2] && C.kw(rest[2], 'decrement', 1) ? rest[3] : null) || 10);
      apply((f, c) => { c.track = (c.track || []).filter((t) => t.ifname !== tf.name); if (!neg) c.track.push({ ifname: tf.name, dec: dec || 10 }); });
      return true;
    }
    if (C.kw(cmd, 'load-balancing', 2) && proto === 'glbp') { apply((f, c) => { c.lb = neg ? null : (rest[1] || 'round-robin').toLowerCase(); }); return true; }
    if (C.kw(cmd, 'timers', 2) || C.kw(cmd, 'authentication', 2) || C.kw(cmd, 'name', 2) || C.kw(cmd, 'description', 2) || C.kw(cmd, 'weighting', 2) || C.kw(cmd, 'forwarder', 2)) return true;
    if (!cmd) { C.incomplete(io); return true; }
    C.invalid(io, cmd);
    return true;
  });

  X.running.iface.push((dev, f) => {
    if (!f || !f.fhrp) return [];
    const L = [];
    if (f.fhrp.hsrpVer === 2) L.push(' standby version 2');
    for (const [g, c] of Object.entries(f.fhrp.hsrp || {})) {
      const pre = g === '0' ? ' standby ' : ' standby ' + g + ' ';
      if (c.ip != null) L.push(pre + 'ip ' + U.ipStr(c.ip));
      if (c.ip6 != null) L.push(pre + 'ipv6 ' + (c.auto6 ? 'autoconfig' : ip6.str(c.ip6, true)));
      if (c.prio !== 100) L.push(pre + 'priority ' + c.prio);
      if (c.preempt) L.push(pre + 'preempt');
      for (const t of c.track || []) L.push(pre + 'track ' + (t.obj != null ? t.obj + ' decrement ' + t.dec : t.ifname + ' ' + t.dec));
    }
    for (const [g, c] of Object.entries(f.fhrp.vrrp || {})) {
      if (c.ip != null) L.push(' vrrp ' + g + ' ip ' + U.ipStr(c.ip));
      if (c.prio !== 100) L.push(' vrrp ' + g + ' priority ' + c.prio);
      if (c.preempt === false) L.push(' no vrrp ' + g + ' preempt');
      for (const t of c.track || []) L.push(' vrrp ' + g + ' track ' + (t.obj != null ? t.obj + ' decrement ' + t.dec : t.ifname + ' ' + t.dec));
    }
    for (const [g, c] of Object.entries(f.fhrp.glbp || {})) {
      if (c.ip != null) L.push(' glbp ' + g + ' ip ' + U.ipStr(c.ip));
      if (c.prio !== 100) L.push(' glbp ' + g + ' priority ' + c.prio);
      if (c.preempt) L.push(' glbp ' + g + ' preempt');
      if (c.lb) L.push(' glbp ' + g + ' load-balancing ' + c.lb);
    }
    return L;
  });

  const macDots = (m) => U.ciscoMac(m).toUpperCase().replace(/X/g, 'x');

  X.show.push((dev, s, a, io, C) => {
    const proto = C.kw(a[0], 'standby', 3) ? 'hsrp' : C.kw(a[0], 'vrrp', 4) ? 'vrrp' : C.kw(a[0], 'glbp', 4) ? 'glbp' : null;
    if (!proto || !dev.ifaces) return false;
    const brief = C.kw(a[1], 'brief', 1);
    const rows = [];
    for (const f of dev.ifaces) {
      if (!f.fhrp || !f.fhrp[proto]) continue;
      for (const [g, c] of Object.entries(f.fhrp[proto])) {
        const v6 = proto === 'hsrp' && c.ip6 != null;
        rows.push({ f, g, c, v6, rt: (v6 ? f.hsrp6Rt && f.hsrp6Rt[g] : f.fhrpRt && f.fhrpRt[proto][g]) || { state: 'Init' } });
      }
    }
    const who4 = (ip, f) => (ip == null ? 'unknown' : ip === f.ip ? 'local' : U.ipStr(ip));
    const who6 = (ll, f) => (ll == null ? 'unknown' : ll === dev.ll6(f) ? 'local' : ip6.str(ll, true));
    let cur = null;
    const who = (ip, f) => (cur && cur.v6 ? who6(ip, f) : who4(ip, f));
    const vipOf = (r) => (r.v6 ? ip6.str(r.c.ip6, true) : r.c.ip != null ? U.ipStr(r.c.ip) : 'unknown');
    if (proto === 'hsrp') {
      if (brief) {
        io.out('                     P indicates configured to preempt.');
        io.out('                     |');
        io.out('Interface   Grp  Pri P State    Active          Standby         Virtual IP');
        for (const r of rows) { cur = r; io.out(C.pad(C.shortIf(r.f.name), 12) + C.pad(r.g, 5) + C.pad(String(r.rt.prio != null ? r.rt.prio : r.c.prio), 4) + C.pad(r.c.preempt ? 'P' : '', 2) + C.pad(r.rt.state, 9) + C.pad(who(r.rt.active, r.f), 16) + C.pad(who(r.rt.standby, r.f), 16) + vipOf(r)); }
        return true;
      }
      for (const r of rows) {
        cur = r;
        const ver = r.f.fhrp.hsrpVer || 1;
        const vm = r.v6 ? vmac6(Number(r.g)) : vmac('hsrp', Number(r.g), ver);
        io.out(r.f.name + ' - Group ' + r.g + (ver === 2 ? ' (version 2)' : ''));
        io.out('  State is ' + r.rt.state);
        io.out('    ' + (r.rt.changes || 0) + ' state change' + (r.rt.changes === 1 ? '' : 's') + ', last state change ' + fmtAge(dev, r.rt.since));
        io.out('  Virtual IP address is ' + vipOf(r));
        io.out('  Active virtual MAC address is ' + macDots(vm));
        io.out('    Local virtual MAC address is ' + macDots(vm) + ' (v' + ver + (r.v6 ? ' IPv6' : '') + ' default)');
        io.out('  Hello time 3 sec, hold time 10 sec');
        io.out('    Next hello sent in 1.' + String(dev.net.time % 1000).padStart(3, '0') + ' secs');
        io.out('  Preemption ' + (r.c.preempt ? 'enabled' : 'disabled'));
        io.out('  Active router is ' + who(r.rt.active, r.f));
        io.out('  Standby router is ' + who(r.rt.standby, r.f) + (r.rt.standby != null && r.rt.standby !== r.f.ip ? ', priority ' + '' : ''));
        io.out('  Priority ' + (r.rt.prio != null ? r.rt.prio : r.c.prio) + ' (configured ' + r.c.prio + ')');
        for (const t of r.c.track || []) {
          if (t.obj != null) io.out('    Track object ' + t.obj + ' state ' + (NS.track && NS.track.up(dev, t.obj) ? 'Up' : 'Down') + ' decrement ' + t.dec);
          else io.out('    Track interface ' + t.ifname + ' state ' + (dev.ifaceUp(dev.ifaceByName(t.ifname) || {}) ? 'Up' : 'Down') + ' decrement ' + t.dec);
        }
        io.out('  Group name is hsrp-' + C.shortIf(r.f.name) + '-' + r.g + ' (default)');
      }
      return true;
    }
    if (proto === 'vrrp') {
      if (brief) {
        io.out('Interface          Grp Pri Time  Own Pre State   Master addr     Group addr');
        for (const r of rows) io.out(C.pad(C.shortIf(r.f.name), 19) + C.pad(r.g, 4) + C.pad(String(r.rt.prio != null ? r.rt.prio : r.c.prio), 4) + C.pad('3609', 6) + C.pad(r.c.ip === r.f.ip ? 'Y' : '', 4) + C.pad(r.c.preempt === false ? '' : 'Y', 4) + C.pad(r.rt.state, 8) + C.pad(r.rt.active != null ? U.ipStr(r.rt.active) : '-', 16) + (r.c.ip != null ? U.ipStr(r.c.ip) : '-'));
        return true;
      }
      for (const r of rows) {
        io.out(r.f.name + ' - Group ' + r.g);
        io.out('  State is ' + r.rt.state);
        io.out('  Virtual IP address is ' + (r.c.ip != null ? U.ipStr(r.c.ip) : 'unknown'));
        io.out('  Virtual MAC address is ' + macDots(vmac('vrrp', Number(r.g))));
        io.out('  Advertisement interval is 1.000 sec');
        io.out('  Preemption ' + (r.c.preempt === false ? 'disabled' : 'enabled'));
        io.out('  Priority is ' + (r.rt.prio != null ? r.rt.prio : r.c.prio) + (r.c.ip === r.f.ip ? ' (address owner)' : ''));
        io.out('  Master Router is ' + who(r.rt.active, r.f) + ', priority is ' + (r.rt.state === 'Master' ? (r.rt.prio != null ? r.rt.prio : r.c.prio) : 'unknown'));
      }
      return true;
    }
    if (brief) {
      io.out('Interface   Grp  Fwd Pri State    Address         Active router   Standby router');
      for (const r of rows) {
        io.out(C.pad(C.shortIf(r.f.name), 12) + C.pad(r.g, 5) + C.pad('-', 4) + C.pad(String(r.rt.prio != null ? r.rt.prio : r.c.prio), 4) + C.pad(r.rt.state, 9) + C.pad(r.c.ip != null ? U.ipStr(r.c.ip) : '-', 16) + C.pad(who(r.rt.active, r.f), 16) + who(r.rt.standby, r.f));
        for (const [n, id] of r.rt.owners || []) {
          const mine = id === dev.id + '|' + r.f.name;
          io.out(C.pad(C.shortIf(r.f.name), 12) + C.pad(r.g, 5) + C.pad(String(n), 4) + C.pad('-', 4) + C.pad(mine ? 'Active' : 'Listen', 9) + C.pad(macDots(vmac('glbp', Number(r.g), 1, n)), 16) + C.pad(mine ? 'local' : '-', 16) + '-');
        }
      }
      return true;
    }
    for (const r of rows) {
      io.out(r.f.name + ' - Group ' + r.g);
      io.out('  State is ' + r.rt.state);
      io.out('  Virtual IP address is ' + (r.c.ip != null ? U.ipStr(r.c.ip) : 'unknown'));
      io.out('  Active is ' + who(r.rt.active, r.f) + ', Standby is ' + who(r.rt.standby, r.f));
      io.out('  Priority ' + (r.rt.prio != null ? r.rt.prio : r.c.prio) + ' (default 100)');
      io.out('  Load balancing: ' + (r.c.lb || 'round-robin'));
      io.out('  There are ' + (r.rt.owners || []).length + ' forwarders (' + (r.rt.fwd || []).length + ' active)');
      for (const [n, id] of r.rt.owners || []) io.out('  Forwarder ' + n + ' — MAC ' + macDots(vmac('glbp', Number(r.g), 1, n)) + (id === dev.id + '|' + r.f.name ? ' (local)' : ''));
    }
    return true;
  });

  function fmtAge(dev, since) {
    const s = Math.max(0, Math.floor((dev.net.time - (since || 0)) / 100));
    return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  X.tree.if = (X.tree.if || []).concat(['standby WORD ip A.B.C.D', 'standby WORD priority WORD', 'standby WORD preempt', 'standby version 2', 'standby WORD track WORD WORD',
    'vrrp WORD ip A.B.C.D', 'vrrp WORD priority WORD', 'vrrp WORD preempt', 'glbp WORD ip A.B.C.D', 'glbp WORD priority WORD', 'glbp WORD preempt', 'glbp WORD load-balancing round-robin']);
  X.tree.exec = (X.tree.exec || []).concat(['show standby', 'show standby brief', 'show vrrp', 'show vrrp brief', 'show glbp', 'show glbp brief']);

  NS.fhrp = { vmac, elect, elect6, vmac6, vll6 };
})(globalThis.NetLab = globalThis.NetLab || {});
