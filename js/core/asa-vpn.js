/* NetLab — VPN на Cisco ASA (синтаксис ASA 8.4+):
 *  IPsec site-to-site: crypto ikev1 policy, crypto ikev1 enable, crypto ipsec ikev1 transform-set, crypto map … match address /
 *  set peer / set ikev1 transform-set, crypto map … interface, tunnel-group … type ipsec-l2l / ipsec-attributes → ikev1 pre-shared-key,
 *  twice NAT для исключения VPN-трафика из NAT: nat (inside,outside) source static A A destination static B B,
 *  sysopt connection permit-vpn (по умолчанию включено); show crypto isakmp sa / ipsec sa.
 *  Обмен IKE и ESP — общий движок vpn.js, так что ASA работает в паре с маршрутизатором IOS и с другим ASA. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const AX = NS.asaExt;
  const C = NS.cliIos.ctx;
  const kw = C.kw;
  const ip = (x) => U.ipStr(x);
  const Asa = NS.deviceTypes.asa;

  const cfg = (dev) => dev.crypto || (dev.crypto = { policies: [], keys: [], sets: {}, maps: {}, groups: {}, aaa: false });
  const vcfg = (dev) => dev.asaVpn || (dev.asaVpn = { ikeIf: [], tgs: {}, twice: [] });
  const mut = (io, fn) => C.withMutate(io, fn);
  const nameIf = (dev, n) => dev.ifaces.find((f) => f.nameif && f.nameif.toLowerCase() === String(n || '').toLowerCase()) || null;

  const ENC = { des: 'des', '3des': '3des', aes: 'aes', 'aes-192': 'aes 192', 'aes-256': 'aes 256' };
  const ENC_BACK = { des: 'des', '3des': '3des', aes: 'aes', 'aes 192': 'aes-192', 'aes 256': 'aes-256' };

  // crypto map: список доступа ASA
  Asa.prototype.cryptoMatch = function (mapName, pkt) {
    const entries = (cfg(this).maps[mapName] || []).slice().sort((a, b) => a.seq - b.seq);
    for (const e of entries) {
      if (!e.acl || e.peer == null) continue;
      const r = NS.asa.aclCheck(this, e.acl, pkt);
      if (r && r.permit && !r.implicit) return e;
    }
    return null;
  };

  const natHits = new WeakMap(); // правило twice NAT → срабатывания (не сохраняется)

  /** Twice NAT «source static A A destination static B B» — трафик не транслируется. → описание правила или null. */
  AX.natExempt = function (dev, inIf, outIf, p) {
    const objOk = (name, v) => { const o = dev.asa.objects[name]; return !!o && o.ip != null && U.net(v, o.mask) === U.net(o.ip, o.mask); };
    for (const r of (dev.asaVpn && dev.asaVpn.twice) || []) {
      if (r.in !== String(inIf.nameif).toLowerCase() || r.out !== String(outIf.nameif).toLowerCase()) continue;
      if (objOk(r.src, p.src) && objOk(r.dst, p.dst)) { natHits.set(r, (natHits.get(r) || 0) + 1); return r.src + ' → ' + r.dst; }
    }
    return null;
  };

  // show nat: раздел 1 — twice NAT, раздел 2 — object NAT
  AX.show.push((dev, s, a, io) => {
    if (!kw(a[0], 'nat', 3) || a[1]) return false;
    const tw = (dev.asaVpn && dev.asaVpn.twice) || [];
    if (tw.length) {
      io.out('Manual NAT Policies (Section 1)');
      tw.forEach((r, i) => {
        io.out((i + 1) + ' (' + r.in + ') to (' + r.out + ') source static ' + r.src + ' ' + r.src + '   destination static ' + r.dst + ' ' + r.dst + (r.flags.length ? ' ' + r.flags.join(' ') : ''));
        io.out('    translate_hits = ' + (natHits.get(r) || 0) + ', untranslate_hits = 0');
      });
      io.out('');
    }
    const auto = Object.entries(dev.asa.objects).filter(([, o]) => o.nat);
    if (auto.length) {
      const xl = dev.asaRt ? [...dev.asaRt.xlate.values()] : [];
      io.out('Auto NAT Policies (Section 2)');
      auto.forEach(([name, o], i) => {
        const to = o.nat.type === 'static' ? ip(o.nat.addr) : o.nat.addr != null ? ip(o.nat.addr) : 'interface';
        io.out((i + 1) + ' (' + o.nat.real + ') to (' + o.nat.mapped + ') source ' + o.nat.type + ' ' + name + ' ' + to);
        io.out('    translate_hits = ' + xl.filter((x) => x.obj === name).length + ', untranslate_hits = 0');
      });
    }
    if (!tw.length && !auto.length) io.out('No NAT policies configured');
    return true;
  });

  AX.modes['ikev1-policy'] = {
    prompt: '(config-ikev1-policy)#',
    run(dev, s, t, io) {
      const pol = cfg(dev).policies.find((x) => x.prio === s.ctx);
      if (!pol) return false;
      const neg = kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      const w = a[0];
      if (kw(w, 'authentication', 2)) { if (!kw(a[1], 'pre-share', 3) && !neg) { C.invalid(io, a[1] || ''); return true; } mut(io, () => { pol.auth = neg ? 'rsa-sig' : 'pre-share'; }); return true; }
      if (kw(w, 'encryption', 2)) { const e = ENC[String(a[1] || '').toLowerCase()]; if (!e && !neg) { C.invalid(io, a[1] || ''); return true; } mut(io, () => { pol.enc = neg ? '3des' : e; }); return true; }
      if (kw(w, 'hash', 2)) { const x = String(a[1] || '').toLowerCase(); if (!['sha', 'md5'].includes(x) && !neg) { C.invalid(io, a[1] || ''); return true; } mut(io, () => { pol.hash = neg ? 'sha' : x; }); return true; }
      if (kw(w, 'group', 2)) { const g = Number(a[1]); if (![1, 2, 5, 14, 19, 20, 21, 24].includes(g) && !neg) { C.invalid(io, a[1] || ''); return true; } mut(io, () => { pol.group = neg ? 2 : g; }); return true; }
      if (kw(w, 'lifetime', 2)) { const v = Number(a[1]); if (!(v >= 120) && !neg) { C.invalid(io, a[1] || ''); return true; } mut(io, () => { pol.lifetime = neg ? 86400 : v; }); return true; }
      return false;
    },
  };

  AX.modes['tg-ipsec'] = {
    prompt: '(config-tunnel-ipsec)#',
    run(dev, s, t, io) {
      const neg = kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (kw(a[0], 'ikev1', 3) && kw(a[1], 'pre-shared-key', 3)) {
        const peer = s.ctx;
        mut(io, () => {
          const c = cfg(dev);
          c.keys = c.keys.filter((k) => k.addr !== peer);
          if (!neg) c.keys.push({ addr: peer, key: String(a[2] || '') });
        });
        return true;
      }
      return false;
    },
  };

  AX.config.push((dev, s, t, neg, io) => {
    const a = neg ? t.slice(1) : t;
    const w = a[0];
    const c = cfg(dev);
    const v = vcfg(dev);
    if (kw(w, 'crypto', 3) && kw(a[1], 'ikev1', 5)) {
      if (kw(a[2], 'policy', 1)) {
        const prio = Number(a[3]);
        if (!(Number.isInteger(prio) && prio >= 1 && prio <= 65535)) { C.incomplete(io); return true; }
        if (neg) { mut(io, () => { c.policies = c.policies.filter((x) => x.prio !== prio); }); return true; }
        if (!c.policies.some((x) => x.prio === prio)) mut(io, () => { c.policies.push({ prio, enc: '3des', hash: 'sha', auth: 'rsa-sig', group: 2, lifetime: 86400 }); c.policies.sort((x, y) => x.prio - y.prio); });
        s.mode = 'ikev1-policy';
        s.ctx = prio;
        return true;
      }
      if (kw(a[2], 'enable', 2)) {
        const f = nameIf(dev, a[3]);
        if (!f) { io.out('ERROR: % Interface name ' + (a[3] || '') + ' not found'); return true; }
        mut(io, () => { v.ikeIf = v.ikeIf.filter((x) => x !== f.nameif.toLowerCase()); if (!neg) v.ikeIf.push(f.nameif.toLowerCase()); });
        return true;
      }
    }
    if (kw(w, 'crypto', 3) && kw(a[1], 'ipsec', 3) && kw(a[2], 'ikev1', 5) && kw(a[3], 'transform-set', 3)) {
      const name = a[4];
      if (!name) { C.incomplete(io); return true; }
      if (neg) { mut(io, () => { delete c.sets[name]; }); return true; }
      const esp = a.slice(5).map((x) => x.toLowerCase());
      if (!esp.length || !esp.every((x) => /^esp-/.test(x))) { io.out('ERROR: % укажите преобразования, например esp-aes esp-sha-hmac'); return true; }
      mut(io, () => { c.sets[name] = { esp, mode: 'tunnel' }; });
      return true;
    }
    if (kw(w, 'crypto', 3) && kw(a[1], 'map', 1)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return true; }
      if (kw(a[3], 'interface', 3)) {
        const f = nameIf(dev, a[4]);
        if (!f) { io.out('ERROR: % Interface name ' + (a[4] || '') + ' not found'); return true; }
        mut(io, () => { f.cryptoMap = neg ? null : name; });
        if (!neg && !v.ikeIf.includes(f.nameif.toLowerCase())) io.out('WARNING: crypto map is incomplete or IKEv1 is not enabled on ' + f.nameif + ' (crypto ikev1 enable ' + f.nameif + ')');
        return true;
      }
      const seq = Number(a[3]);
      if (!(Number.isInteger(seq) && seq >= 1 && seq <= 65535)) { C.incomplete(io); return true; }
      const list = c.maps[name] || (c.maps[name] = []);
      let e = list.find((x) => x.seq === seq);
      if (!e) { e = { seq, peer: null, ts: null, acl: null }; mut(io, () => list.push(e)); }
      if (kw(a[4], 'match', 1) && kw(a[5], 'address', 1)) {
        if (!neg && !dev.asa.acls[a[6]]) io.out('WARNING: access-list ' + (a[6] || '') + ' does not exist');
        mut(io, () => { e.acl = neg ? null : a[6]; });
        return true;
      }
      if (kw(a[4], 'set', 1) && kw(a[5], 'peer', 1)) {
        const p = U.parseIp(a[6] || '');
        if (p == null && !neg) { C.invalid(io, a[6] || ''); return true; }
        mut(io, () => { e.peer = neg ? null : p; });
        return true;
      }
      if (kw(a[4], 'set', 1) && kw(a[5], 'ikev1', 5) && kw(a[6], 'transform-set', 3)) {
        if (!neg && !c.sets[a[7]]) io.out('WARNING: transform-set ' + (a[7] || '') + ' does not exist');
        mut(io, () => { e.ts = neg ? null : a[7]; });
        return true;
      }
      if (kw(a[4], 'set', 1)) return true; // pfs, security-association lifetime — принимаются
      C.invalid(io, a[4] || '');
      return true;
    }
    if (kw(w, 'tunnel-group', 3)) {
      const peer = U.parseIp(a[1] || '');
      if (peer == null) { io.out('ERROR: % для site-to-site имя tunnel-group — адрес пира'); return true; }
      if (kw(a[2], 'type', 1)) {
        if (neg) { mut(io, () => { delete v.tgs[ip(peer)]; c.keys = c.keys.filter((k) => k.addr !== peer); }); return true; }
        if (!kw(a[3], 'ipsec-l2l', 7)) { C.invalid(io, a[3] || ''); return true; }
        mut(io, () => { v.tgs[ip(peer)] = { type: 'ipsec-l2l' }; });
        return true;
      }
      if (kw(a[2], 'ipsec-attributes', 6)) {
        if (!v.tgs[ip(peer)]) { io.out('ERROR: tunnel-group ' + ip(peer) + ' not found — сначала tunnel-group ' + ip(peer) + ' type ipsec-l2l'); return true; }
        s.mode = 'tg-ipsec';
        s.ctx = peer;
        return true;
      }
      if (kw(a[2], 'general-attributes', 3)) return true;
    }
    if (kw(w, 'nat', 3) && /^\(/.test(a[1] || '') && kw(a[2], 'source', 2)) {
      const m = /^\(([\w-]+),([\w-]+)\)$/.exec(a[1]);
      if (!m) { C.invalid(io, a[1]); return true; }
      const [, inN, outN] = m;
      if (!nameIf(dev, inN) || !nameIf(dev, outN)) { io.out('ERROR: % Interface name ' + (nameIf(dev, inN) ? outN : inN) + ' not found'); return true; }
      if (!kw(a[3], 'static', 2) || a[4] !== a[5] || !kw(a[6], 'destination', 3) || !kw(a[7], 'static', 2) || a[8] !== a[9]) {
        io.out('ERROR: % в NetLab поддерживается twice NAT для исключения VPN: nat (inside,outside) source static LAN LAN destination static REMOTE REMOTE');
        return true;
      }
      for (const o of [a[4], a[8]]) if (!dev.asa.objects[o]) { io.out('ERROR: % object ' + o + ' not found'); return true; }
      const r = { in: inN.toLowerCase(), out: outN.toLowerCase(), src: a[4], dst: a[8], flags: a.slice(10).filter((x) => /^(no-proxy-arp|route-lookup)$/i.test(x)).map((x) => x.toLowerCase()) };
      mut(io, () => { v.twice = v.twice.filter((x) => !(x.in === r.in && x.out === r.out && x.src === r.src && x.dst === r.dst)); if (!neg) v.twice.push(r); });
      return true;
    }
    if (kw(w, 'sysopt', 3) && kw(a[1], 'connection', 3) && kw(a[2], 'permit-vpn', 8)) { mut(io, () => { dev.asa.permitVpn = !neg; }); return true; }
    return false;
  });

  AX.running.push((dev) => {
    const L = [];
    const v = dev.asaVpn;
    const c = dev.crypto;
    if (v) for (const r of v.twice) L.push('nat (' + r.in + ',' + r.out + ') source static ' + r.src + ' ' + r.src + ' destination static ' + r.dst + ' ' + r.dst + (r.flags.length ? ' ' + r.flags.join(' ') : ''));
    if (dev.asa && dev.asa.permitVpn === false) L.push('no sysopt connection permit-vpn');
    if (c) {
      for (const [n, t] of Object.entries(c.sets)) L.push('crypto ipsec ikev1 transform-set ' + n + ' ' + t.esp.join(' '));
      for (const [n, list] of Object.entries(c.maps)) {
        for (const e of list.slice().sort((x, y) => x.seq - y.seq)) {
          if (e.acl) L.push('crypto map ' + n + ' ' + e.seq + ' match address ' + e.acl);
          if (e.peer != null) L.push('crypto map ' + n + ' ' + e.seq + ' set peer ' + ip(e.peer));
          if (e.ts) L.push('crypto map ' + n + ' ' + e.seq + ' set ikev1 transform-set ' + e.ts);
        }
        for (const f of dev.ifaces) if (f.cryptoMap === n && f.nameif) L.push('crypto map ' + n + ' interface ' + f.nameif);
      }
      if (v) for (const n of v.ikeIf) L.push('crypto ikev1 enable ' + n);
      for (const p of c.policies) {
        L.push('crypto ikev1 policy ' + p.prio, ' authentication ' + (p.auth === 'pre-share' ? 'pre-share' : 'rsa-sig'), ' encryption ' + (ENC_BACK[p.enc] || p.enc), ' hash ' + p.hash, ' group ' + p.group, ' lifetime ' + p.lifetime);
      }
    }
    if (v) {
      for (const [peer, tg] of Object.entries(v.tgs)) {
        L.push('tunnel-group ' + peer + ' type ' + tg.type);
        const k = c && c.keys.find((x) => ip(x.addr) === peer);
        if (k) L.push('tunnel-group ' + peer + ' ipsec-attributes', ' ikev1 pre-shared-key *****');
      }
    }
    return L;
  });

  AX.show.push((dev, s, a, io) => {
    if (!kw(a[0], 'crypto', 3)) return false;
    const ike = dev.ike || { p1: new Map(), sas: new Map() };
    if (kw(a[1], 'isakmp', 2) || kw(a[1], 'ikev1', 5)) {
      const list = [...ike.p1.values()].filter((x) => x.state === 'QM_IDLE' || x.state);
      io.out('');
      io.out('IKEv1 SAs:');
      io.out('');
      io.out('   Active SA: ' + list.length);
      io.out('    Rekey SA: 0 (A tunnel will report 1 Active and 1 Rekey SA during rekey)');
      io.out('Total IKE SA: ' + list.length);
      list.forEach((x, i) => {
        io.out('');
        io.out((i + 1) + '   IKE Peer: ' + ip(x.peer));
        io.out('    Type    : L2L             Role    : ' + (x.role === 'initiator' ? 'initiator' : 'responder'));
        io.out('    Rekey   : no              State   : ' + (x.state === 'QM_IDLE' ? 'MM_ACTIVE' : x.state));
      });
      return true;
    }
    if (kw(a[1], 'ipsec', 3)) {
      for (const [peer, sa] of ike.sas) {
        const f = dev.ifaceByName(sa.ifc);
        io.out('interface: ' + (f && f.nameif ? f.nameif : sa.ifc));
        io.out('    Crypto map tag: ' + sa.map + ', seq num: ' + (sa.entry ? sa.entry.seq : '?') + ', local addr: ' + ip(sa.local));
        io.out('');
        io.out('      current_peer: ' + ip(peer));
        io.out('');
        io.out('      #pkts encaps: ' + sa.encaps + ', #pkts encrypt: ' + sa.encaps + ', #pkts digest: ' + sa.encaps);
        io.out('      #pkts decaps: ' + sa.decaps + ', #pkts decrypt: ' + sa.decaps + ', #pkts verify: ' + sa.decaps);
        io.out('');
        io.out('    inbound esp sas:');
        io.out('      spi: 0x' + (sa.mySpi >>> 0).toString(16).toUpperCase() + ' (' + (sa.mySpi >>> 0) + ')');
        io.out('         transform: ' + (sa.transforms || []).join(' '));
        io.out('    outbound esp sas:');
        io.out('      spi: 0x' + (sa.peerSpi >>> 0).toString(16).toUpperCase() + ' (' + (sa.peerSpi >>> 0) + ')');
        io.out('');
      }
      if (!ike.sas.size) io.out('There are no ipsec sas');
      return true;
    }
    return false;
  });

  NS.deviceExt.push({
    key: 'asavpn',
    applies: (d) => d.type === 'asa',
    save(d) {
      const v = d.asaVpn;
      const out = {};
      if (v && (v.ikeIf.length || Object.keys(v.tgs).length || v.twice.length)) out.v = JSON.parse(JSON.stringify(v));
      if (d.asa && d.asa.permitVpn === false) out.noPermitVpn = true;
      const maps = {};
      for (const f of d.ifaces) if (f.cryptoMap) maps[f.name] = f.cryptoMap;
      if (Object.keys(maps).length) out.maps = maps;
      return Object.keys(out).length ? out : null;
    },
    load(d, c) {
      d.asaVpn = c && c.v ? { ikeIf: c.v.ikeIf || [], tgs: c.v.tgs || {}, twice: c.v.twice || [] } : null;
      if (d.asa) d.asa.permitVpn = !(c && c.noPermitVpn);
      for (const f of d.ifaces) if (c && c.maps && c.maps[f.name]) f.cryptoMap = c.maps[f.name];
    },
  });

  NS.cliAsa.tree.config.push('crypto ikev1 policy WORD', 'crypto ikev1 enable WORD', 'crypto ipsec ikev1 transform-set WORD esp-aes esp-sha-hmac', 'crypto map WORD WORD match address WORD',
    'crypto map WORD WORD set peer A.B.C.D', 'crypto map WORD WORD set ikev1 transform-set WORD', 'crypto map WORD interface WORD', 'tunnel-group A.B.C.D type ipsec-l2l', 'tunnel-group A.B.C.D ipsec-attributes',
    'nat (inside,outside) source static WORD WORD destination static WORD WORD');
  NS.cliAsa.tree.exec.push('show crypto isakmp sa', 'show crypto ipsec sa', 'show nat');
})(globalThis.NetLab = globalThis.NetLab || {});
