/* NetLab — VPN: GRE-туннели (interface Tunnel), IPsec site-to-site (crypto isakmp policy/key,
 * transform-set, crypto map с ACL), удалённый доступ Easy VPN для программы «VPN» на ПК
 * (crypto isakmp client configuration group, ip local pool, пользователи XAUTH).
 * Переговоры IKE упрощены до одного обмена по UDP 500, но проверяются те же параметры, что в IOS. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const IKE_PORT = 500;
  const IKE_TIMEOUT = 200;
  const IKE_TRIES = 3;

  /* ================= общие пулы адресов (ip local pool) — также для PPPoE ================= */

  IpNode.prototype.localPools = function () {
    if (!this.pools) this.pools = {};
    return this.pools;
  };

  IpNode.prototype.setLocalPool = function (name, start, end) {
    if (!/^[\w.-]{1,32}$/.test(String(name || ''))) throw new Error('Имя пула: буквы, цифры, «-», «_», «.»');
    if (start == null || end == null || end < start) throw new Error('Неверный диапазон адресов пула');
    if (end - start > 4096) throw new Error('Слишком большой пул (до 4096 адресов)');
    this.localPools()[name] = { start, end };
  };

  /** Выдать адрес из пула; owner — кто получил (для освобождения). */
  IpNode.prototype.poolAlloc = function (name, owner) {
    const p = this.localPools()[name];
    if (!p) return null;
    if (!this.poolLeases.has(name)) this.poolLeases.set(name, new Map());
    const used = this.poolLeases.get(name);
    for (const [ip, o] of used) if (o === owner) return ip;
    for (let ip = p.start; ip <= p.end; ip++) {
      if (!used.has(ip)) { used.set(ip, owner); return ip; }
    }
    return null;
  };

  IpNode.prototype.poolFree = function (name, ip) {
    const used = this.poolLeases.get(name);
    if (used) used.delete(ip);
  };

  /* ================= GRE ================= */

  IpNode.prototype.addTunnel = function (n) {
    n = Number(n);
    if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new Error('Номер туннеля: 0–2147483647');
    const name = 'Tunnel' + n;
    let f = this.ifaceByName(name);
    if (!f) {
      f = this.addIface(-1, name, null, 'tunnel');
      f.tunnel = { src: null, dst: null };
      f.p2p = true;
      if (this.sortIfaces) this.sortIfaces();
    }
    this.net.markRouting();
    return f;
  };

  /** IP-адрес источника туннеля (из интерфейса или указанный явно). */
  IpNode.prototype.tunnelSrc = function (f) {
    const t = f.tunnel || {};
    if (t.src == null) return null;
    if (typeof t.src === 'number') return this.hasIp(t.src) ? t.src : null;
    const g = this.ifaceByName(t.src);
    return g && g.ip != null && this.ifaceUp(g) ? g.ip : null;
  };

  IpNode.ifaceKinds.tunnel = {
    removable: true,
    create(dev, s) {
      const f = dev.addIface(-1, String(s.name), null, 'tunnel');
      f.tunnel = { src: null, dst: null };
      f.p2p = true;
      return f;
    },
  };

  IpNode.ifaceUpHooks.tunnel = function (f) {
    if (this._tunCheck) return false; // туннель не может идти через туннель — защита от рекурсии
    const t = f.tunnel || {};
    if (t.dst == null || this.tunnelSrc(f) == null) return false;
    this._tunCheck = true;
    try {
      const r = this.lookup(t.dst);
      return !!r;
    } finally {
      this._tunCheck = false;
    }
  };

  IpNode.ifaceSenders.tunnel = function (f, pkt, why) {
    const outer = P.ipv4(this.tunnelSrc(f), f.tunnel.dst, 'GRE', { proto: 'IPv4', inner: pkt }, this.defaultTtl);
    return this.sendIp(outer, { why: 'GRE: пакет ' + U.ipStr(pkt.src) + ' → ' + U.ipStr(pkt.dst) + ' упакован в туннель ' + f.name + ' (к ' + U.ipStr(f.tunnel.dst) + ')' + (why ? ' · ' + why : '') });
  };

  IpNode.ipProtos.GRE = function (pkt, f, frame) {
    const t = this.ifaces.find((x) => x.kind === 'tunnel' && x.tunnel && x.tunnel.dst === pkt.src && this.tunnelSrc(x) === pkt.dst);
    if (!t || !this.ifaceUp(t)) {
      if (frame) this.drop(frame, 'GRE: нет туннеля с ' + U.ipStr(pkt.src) + ' (проверьте tunnel source/destination на обоих концах)');
      return;
    }
    const inner = pkt.payload && pkt.payload.inner;
    if (!inner) return;
    this.note('GRE: распакован пакет ' + U.ipStr(inner.src) + ' → ' + U.ipStr(inner.dst) + ' из ' + t.name, frame, 'accept');
    this.onIp(t, inner, frame);
  };

  IpNode.ifaceExt.push({
    key: 'tunnel',
    save(f) {
      if (f.kind !== 'tunnel' || !f.tunnel) return null;
      return { src: typeof f.tunnel.src === 'number' ? U.ipStr(f.tunnel.src) : f.tunnel.src, dst: f.tunnel.dst != null ? U.ipStr(f.tunnel.dst) : null };
    },
    load(f, d) {
      if (f.kind !== 'tunnel') return;
      f.tunnel = { src: null, dst: null };
      if (!d) return;
      const ipSrc = d.src ? U.parseIp(d.src) : null;
      f.tunnel.src = ipSrc != null ? ipSrc : d.src || null;
      f.tunnel.dst = d.dst ? U.parseIp(d.dst) : null;
    },
    crypto: null,
  });

  /* ================= IPsec: настройки ================= */

  function cfg(dev) {
    if (!dev.crypto) dev.crypto = { policies: [], keys: [], sets: {}, maps: {}, groups: {}, aaa: false };
    return dev.crypto;
  }

  const ENC = ['des', '3des', 'aes', 'aes 192', 'aes 256'];

  function defaultPolicy(prio) { return { prio, enc: 'des', hash: 'sha', auth: 'rsa-sig', group: 1, lifetime: 86400 }; }

  function samePolicy(a, b) { return a.enc === b.enc && a.hash === b.hash && a.auth === b.auth && a.group === b.group; }

  const newSpi = (dev) => (0x10000000 + ((dev.net.counters.xid++ * 2654435761) >>> 4)) >>> 0;

  /** Первая запись crypto map, ACL которой разрешает пакет. */
  IpNode.prototype.cryptoMatch = function (mapName, pkt) {
    const entries = (cfg(this).maps[mapName] || []).slice().sort((a, b) => a.seq - b.seq);
    for (const e of entries) {
      if (!e.acl || e.peer == null) continue;
      const acl = this.acls.get(e.acl);
      if (acl && acl.check(pkt).permit) return e;
    }
    return null;
  };

  IpNode.hooks.runtime.push(function () {
    this.poolLeases = new Map();
    this.ike = { sas: new Map(), bySpi: new Map(), pending: new Map(), failed: new Map(), p1: new Map(), connSeq: 0 };
    this.vpnClients = new Map();
    this._tunCheck = false;
  });

  /* ---------- IKE: фаза 1 (Main Mode, 6 сообщений) и фаза 2 (Quick Mode, 3 сообщения) ---------- */

  const keyFor = (dev, peer) => cfg(dev).keys.find((k) => k.addr === peer) || cfg(dev).keys.find((k) => k.addr === 0) || null;
  const polText = (p) => p.enc + '/' + p.hash + '/' + p.auth + '/DH' + p.group;
  const nonce = (dev) => ((dev.net.counters.xid++ * 2246822519) >>> 0).toString(16);
  /** «Хэш» pre-shared key вместе с nonce обеих сторон: сам ключ по сети не передаётся. */
  function psHash(key, a, b) {
    let h = 0x811c9dc5;
    const s = String(key) + '|' + a + '|' + b;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }
  const dbg = (dev, key, text) => { if (dev.debugOut) dev.debugOut(key, text); };

  /** ISAKMP SA (фаза 1) с пиром: у инициатора и ответчика — отдельные записи, как в IOS. */
  const p1Key = (peer, role) => (role === 'initiator' ? 'I' : 'R') + peer;
  function p1Ready(dev, peer) {
    for (const r of ['initiator', 'responder']) {
      const s = dev.ike.p1.get(p1Key(peer, r));
      if (s && s.state === 'QM_IDLE') return s;
    }
    return null;
  }
  function p1Drop(dev, peer) { dev.ike.p1.delete(p1Key(peer, 'initiator')); dev.ike.p1.delete(p1Key(peer, 'responder')); }
  function p1New(dev, peer, local, role, policy) {
    const s = { peer, local, role, policy, state: 'MM_SA_SETUP', connId: 1000 + (++dev.ike.connSeq), created: dev.net.time, iNonce: null, rNonce: null };
    dev.ike.p1.set(p1Key(peer, role), s);
    return s;
  }

  IpNode.prototype.ikeStart = function (f, entry, pkt, opts) {
    const peer = entry.peer;
    let pend = this.ike.pending.get(peer);
    if (pend) { if (pend.queue.length < 32) pend.queue.push({ pkt, opts, f }); return; }
    pend = { queue: [{ pkt, opts, f }], tries: 0, timer: null, mySpi: newSpi(this), entry, f, pkt, port: this.allocPort(), step: null, msg: null, why: '' };
    this.ike.pending.set(peer, pend);
    this.udp.set(pend.port, (reply) => this.ikeReply(peer, reply.payload.data || {}));
    if (p1Ready(this, peer)) this.ikePhase2(peer);
    else this.ikeMainMode(peer);
  };

  IpNode.prototype.ikeMainMode = function (peer) {
    const c = cfg(this);
    p1Drop(this, peer);
    dbg(this, 'crypto isakmp', 'ISAKMP:(0): beginning Main Mode exchange with ' + U.ipStr(peer));
    this.ikeStep(peer, 'MM1', { policies: c.policies.slice().sort((a, b) => a.prio - b.prio).map((p) => Object.assign({}, p)) },
      'IKE фаза 1 (Main Mode, 1/6): нужен защищённый канал к ' + U.ipStr(peer) + ' — предлагаю политики ISAKMP (' + (c.policies.map((p) => p.prio).join(', ') || 'нет') + ')');
  };

  IpNode.prototype.ikePhase2 = function (peer) {
    const pend = this.ike.pending.get(peer);
    if (!pend) return;
    const ts = (cfg(this).sets[pend.entry.ts] || {}).esp || [];
    dbg(this, 'crypto isakmp', 'ISAKMP:(' + (p1Ready(this, peer) || {}).connId + '):beginning Quick Mode exchange, M-ID of ' + pend.mySpi);
    this.ikeStep(peer, 'QM1', { spi: pend.mySpi, transforms: ts, proxy: { src: pend.pkt.src, dst: pend.pkt.dst } },
      'IKE фаза 2 (Quick Mode, 1/3): предлагаю transform-set ' + (ts.join(' ') || '(нет)') + ' для трафика ' + U.ipStr(pend.pkt.src) + ' → ' + U.ipStr(pend.pkt.dst) + ', мой SPI 0x' + pend.mySpi.toString(16));
  };

  /** Отправить очередное сообщение обмена (с повторами, пока не придёт ответ). */
  IpNode.prototype.ikeStep = function (peer, step, data, why) {
    const pend = this.ike.pending.get(peer);
    if (!pend) return;
    if (pend.timer) pend.timer.cancel();
    Object.assign(pend, { step, msg: Object.assign({ isakmp: step }, data), why, tries: 0, timer: null });
    this.ikeXmit(peer);
  };

  IpNode.prototype.ikeXmit = function (peer) {
    const pend = this.ike.pending.get(peer);
    if (!pend) return;
    pend.timer = null;
    if (++pend.tries > IKE_TRIES) {
      const s = this.ike.p1.get(p1Key(peer, 'initiator'));
      this.ikeFail(peer, 'Пир ' + U.ipStr(peer) + ' не отвечает на IKE (UDP 500)' + (pend.step !== 'MM1' ? ' — обмен остановился на ' + pend.step : ''), pend.step[0] === 'Q' ? 2 : 1);
      if (s && s.state !== 'QM_IDLE') p1Drop(this, peer);
      return;
    }
    dbg(this, 'crypto isakmp', 'ISAKMP:(0): sending packet to ' + U.ipStr(peer) + ' my_port 500 peer_port 500 (I) ' + pend.step + (pend.tries > 1 ? ' (retransmit)' : ''));
    this.sendIp(P.ipv4(pend.f.ip, peer, 'UDP', P.udp(pend.port, IKE_PORT, pend.msg), this.defaultTtl), {
      why: pend.why + (pend.tries > 1 ? ' — повторная отправка' : ''),
      onError: (code, text) => { p1Drop(this, peer); this.ikeFail(peer, 'Нет связи с пиром ' + U.ipStr(peer) + ': ' + text, 1); },
    });
    if (this.ike.pending.has(peer)) pend.timer = this.timer(IKE_TIMEOUT, () => this.ikeXmit(peer));
  };

  IpNode.prototype.ikeFail = function (peer, text, phase) {
    const pend = this.ike.pending.get(peer);
    if (!pend) return;
    if (pend.timer) pend.timer.cancel();
    this.udp.delete(pend.port);
    this.ike.pending.delete(peer);
    this.ike.failed.set(peer, { text, phase: phase || 1, time: this.net.time });
    this.note('IPsec: канал к ' + U.ipStr(peer) + ' не установлен — IKE фаза ' + (phase || 1) + ': ' + text, null, 'drop');
    dbg(this, 'crypto isakmp', 'ISAKMP:(0):' + (phase === 2 ? 'Quick Mode' : 'Main Mode') + ' with ' + U.ipStr(peer) + ' failed: ' + text);
    for (const q of pend.queue) if (q.opts && q.opts.onError) q.opts.onError('ipsec', 'IPsec: ' + text);
  };

  /** Ответы пира инициатору. */
  IpNode.prototype.ikeReply = function (peer, d) {
    const pend = this.ike.pending.get(peer);
    if (!pend) return;
    const ip = U.ipStr(peer);
    if (d.isakmp === 'NOTIFY') {
      if (d.code === 'no-sa' && !pend.restarted) { pend.restarted = true; this.ikeMainMode(peer); return; }
      if (d.phase !== 2) p1Drop(this, peer);
      this.ikeFail(peer, d.text, d.phase || 1);
      return;
    }
    const s = this.ike.p1.get(p1Key(peer, 'initiator'));
    if (d.isakmp === 'MM2' && pend.step === 'MM1') {
      const n = p1New(this, peer, pend.f.ip, 'initiator', d.policy);
      n.iNonce = nonce(this);
      dbg(this, 'crypto isakmp', 'ISAKMP:(0):Old State = IKE_I_MM1  New State = IKE_I_MM2 — policy ' + d.policy.prio + ' (' + polText(d.policy) + ') accepted by peer');
      this.ikeStep(peer, 'MM3', { group: d.policy.group, nonce: n.iNonce },
        'IKE фаза 1 (3/6): обмен ключами Диффи — Хеллмана (группа ' + d.policy.group + ') и случайными числами (nonce)');
      return;
    }
    if (d.isakmp === 'MM4' && pend.step === 'MM3' && s) {
      s.state = 'MM_KEY_EXCH';
      s.rNonce = d.nonce;
      const key = keyFor(this, peer);
      if (!key) {
        p1Drop(this, peer);
        this.ikeFail(peer, 'на ' + this.name + ' нет crypto isakmp key для адреса ' + ip, 1);
        return;
      }
      dbg(this, 'crypto isakmp', 'ISAKMP:(0):Old State = IKE_I_MM3  New State = IKE_I_MM4 — shared secret computed (SKEYID)');
      this.ikeStep(peer, 'MM5', { id: pend.f.ip, hash: psHash(key.key, s.iNonce, s.rNonce) },
        'IKE фаза 1 (5/6): аутентификация — мой адрес и хэш pre-shared key (уже зашифровано общим ключом)');
      return;
    }
    if (d.isakmp === 'MM6' && pend.step === 'MM5' && s) {
      s.state = 'QM_IDLE';
      this.note('IKE фаза 1 с ' + ip + ' завершена: ISAKMP SA установлен (политика ' + s.policy.prio + ': ' + polText(s.policy) + ')', null, 'accept');
      dbg(this, 'crypto isakmp', 'ISAKMP:(' + s.connId + '):SA authentication status: authenticated');
      dbg(this, 'crypto isakmp', 'ISAKMP:(' + s.connId + '):Old State = IKE_I_MM6  New State = IKE_P1_COMPLETE');
      this.ikePhase2(peer);
      return;
    }
    if (d.isakmp === 'QM2' && pend.step === 'QM1') {
      const p1 = p1Ready(this, peer);
      if (pend.timer) pend.timer.cancel();
      this.udp.delete(pend.port);
      this.ike.pending.delete(peer);
      this.ike.failed.delete(peer);
      const old = this.ike.sas.get(peer);
      if (old) this.ike.bySpi.delete(old.mySpi);
      const sa = { peer, local: pend.f.ip, ifc: pend.f.name, map: pend.f.cryptoMap, entry: pend.entry, mySpi: pend.mySpi, peerSpi: d.spi, policy: p1 ? p1.policy : d.policy, transforms: d.transforms, encaps: 0, decaps: 0, created: this.net.time, seqOut: 0 };
      this.ike.sas.set(peer, sa);
      this.ike.bySpi.set(sa.mySpi, sa);
      this.sendIp(P.ipv4(pend.f.ip, peer, 'UDP', P.udp(pend.port, IKE_PORT, { isakmp: 'QM3' }), this.defaultTtl), { why: 'IKE фаза 2 (3/3): подтверждаю — IPsec SA готов' });
      dbg(this, 'crypto ipsec', 'IPSEC(create_sa): sa created, (sa) sa_dest= ' + ip + ', sa_proto= 50, sa_spi= 0x' + (d.spi >>> 0).toString(16).toUpperCase() + ', sa_trans= ' + (d.transforms || []).join(' '));
      this.note('IPsec: защищённый канал с ' + ip + ' установлен (IKE фаза 2, SPI 0x' + sa.mySpi.toString(16) + ')', null, 'accept');
      for (const q of pend.queue) this.espSend(sa, q.pkt, q.opts);
    }
  };

  /** Ответчик IKE: фаза 1 — политика, ключ DH, аутентификация; фаза 2 — crypto map, transform-set, зеркальный ACL. */
  IpNode.prototype.ikeRespond = function (pkt, f) {
    const d = pkt.payload.data || {};
    const reply = (data, why) => this.sendIp(P.ipv4(pkt.dst, pkt.src, 'UDP', P.udp(IKE_PORT, pkt.payload.sport, data), this.defaultTtl), { why });
    const refuse = (text, phase, code) => {
      this.note('IKE: отказ ' + U.ipStr(pkt.src) + ' (фаза ' + (phase || 1) + ') — ' + text, null, 'drop');
      dbg(this, 'crypto isakmp', 'ISAKMP:(0):' + (phase === 2 ? 'Quick Mode' : 'Main Mode') + ' with ' + U.ipStr(pkt.src) + ' rejected: ' + text);
      reply({ isakmp: 'NOTIFY', text, phase: phase || 1, code }, 'IKE: отказ (фаза ' + (phase || 1) + ') — ' + text);
    };
    if (d.isakmp === 'CLIENT' || d.isakmp === 'CLIENT-BYE') { this.ezvpnRespond(pkt, f, d, reply, refuse); return; }
    const c = cfg(this);
    const peer = pkt.src;
    const s = this.ike.p1.get(p1Key(peer, 'responder'));
    switch (d.isakmp) {
      case 'MM1': {
        const mine = c.policies.slice().sort((a, b) => a.prio - b.prio);
        let policy = null;
        for (const theirs of d.policies || []) { policy = mine.find((m) => samePolicy(m, theirs)); if (policy) break; }
        if (!policy) { refuse('NO_PROPOSAL_CHOSEN — нет одинаковой crypto isakmp policy (шифрование, хэш, аутентификация, группа DH)', 1); return; }
        if (policy.auth !== 'pre-share') { refuse('в политике должна быть authentication pre-share', 1); return; }
        this.ike.p1.delete(p1Key(peer, 'responder'));
        p1New(this, peer, pkt.dst, 'responder', policy);
        dbg(this, 'crypto isakmp', 'ISAKMP:(0):Checking ISAKMP transform ' + policy.prio + ' against priority ' + policy.prio + ' policy');
        dbg(this, 'crypto isakmp', 'ISAKMP:(0):atts are acceptable. Next payload is 0');
        reply({ isakmp: 'MM2', policy }, 'IKE фаза 1 (2/6): принимаю политику ' + policy.prio + ' (' + polText(policy) + ')');
        return;
      }
      case 'MM3': {
        if (!s) return;
        if (!keyFor(this, peer)) { this.ike.p1.delete(p1Key(peer, 'responder')); refuse('на ' + this.name + ' нет crypto isakmp key для адреса ' + U.ipStr(peer), 1); return; }
        s.iNonce = d.nonce;
        s.rNonce = nonce(this);
        s.state = 'MM_KEY_EXCH';
        reply({ isakmp: 'MM4', group: s.policy.group, nonce: s.rNonce }, 'IKE фаза 1 (4/6): мой ключ Диффи — Хеллмана и nonce — теперь у обеих сторон общий секрет');
        return;
      }
      case 'MM5': {
        if (!s || !s.rNonce) return;
        const key = keyFor(this, peer);
        if (!key || psHash(key.key, s.iNonce, s.rNonce) !== d.hash) {
          this.ike.p1.delete(p1Key(peer, 'responder'));
          refuse('не совпадает pre-shared key (crypto isakmp key) — аутентификация не прошла', 1);
          return;
        }
        s.state = 'QM_IDLE';
        dbg(this, 'crypto isakmp', 'ISAKMP:(' + s.connId + '):SA authentication status: authenticated');
        this.note('IKE фаза 1 с ' + U.ipStr(peer) + ' завершена: ISAKMP SA установлен (политика ' + s.policy.prio + ')', null, 'accept');
        reply({ isakmp: 'MM6', id: pkt.dst, hash: psHash(key.key, s.rNonce, s.iNonce) }, 'IKE фаза 1 (6/6): пир аутентифицирован — ISAKMP SA установлен');
        return;
      }
      case 'QM1': {
        const p1 = p1Ready(this, peer);
        if (!p1) { refuse('нет ISAKMP SA с ' + U.ipStr(peer) + ' — сначала фаза 1', 2, 'no-sa'); return; }
        const inIf = this.ifaces.find((x) => x.ip === pkt.dst) || f;
        if (!inIf.cryptoMap) { refuse('на интерфейсе ' + inIf.name + ' не применена crypto map', 2); return; }
        const entry = (c.maps[inIf.cryptoMap] || []).find((e) => e.peer === peer);
        if (!entry) { refuse('в crypto map ' + inIf.cryptoMap + ' нет записи с set peer ' + U.ipStr(peer), 2); return; }
        const ts = (c.sets[entry.ts] || {}).esp || [];
        const theirTs = d.transforms || [];
        if (!ts.length || ts.join(' ') !== theirTs.join(' ')) { refuse('не совпадает transform-set (' + (ts.join(' ') || 'нет') + ' / ' + (theirTs.join(' ') || 'нет') + ')', 2); return; }
        const acl = this.acls.get(entry.acl);
        const mirror = d.proxy ? { src: d.proxy.dst, dst: d.proxy.src, proto: 'ICMP', payload: {} } : null;
        if (!acl || (mirror && !acl.check(Object.assign({}, mirror, { proto: 'IP' })).permit && !acl.check(mirror).permit)) {
          refuse('ACL ' + (entry.acl || '?') + ' в crypto map не зеркален ACL пира (match address)', 2);
          return;
        }
        const mySpi = newSpi(this);
        const sa = { peer, local: pkt.dst, ifc: inIf.name, map: inIf.cryptoMap, entry, mySpi, peerSpi: d.spi, policy: p1.policy, transforms: ts, encaps: 0, decaps: 0, created: this.net.time, seqOut: 0 };
        const old = this.ike.sas.get(peer);
        if (old) this.ike.bySpi.delete(old.mySpi);
        this.ike.sas.set(peer, sa);
        this.ike.bySpi.set(mySpi, sa);
        this.ike.failed.delete(peer);
        dbg(this, 'crypto ipsec', 'IPSEC(create_sa): sa created, (sa) sa_dest= ' + U.ipStr(peer) + ', sa_proto= 50, sa_spi= 0x' + (d.spi >>> 0).toString(16).toUpperCase() + ', sa_trans= ' + ts.join(' '));
        reply({ isakmp: 'QM2', spi: mySpi, transforms: ts }, 'IKE фаза 2 (2/3): принимаю transform-set ' + ts.join(' ') + ', мой SPI 0x' + mySpi.toString(16));
        return;
      }
      case 'QM3':
        this.note('IKE фаза 2 с ' + U.ipStr(peer) + ' завершена: IPsec SA готов', null, 'accept');
        return;
      default:
    }
  };

  IpNode.prototype.espSend = function (sa, pkt, opts) {
    sa.encaps++;
    const outer = P.ipv4(sa.local, sa.peer, 'ESP', { spi: sa.peerSpi, seq: ++sa.seqOut, transforms: sa.transforms, inner: pkt }, this.defaultTtl);
    return this.sendIp(outer, { why: 'IPsec: пакет ' + U.ipStr(pkt.src) + ' → ' + U.ipStr(pkt.dst) + ' зашифрован (ESP, SPI 0x' + (sa.peerSpi >>> 0).toString(16) + ')', onError: opts && opts.onError });
  };

  // шифрование на выходе интерфейса с crypto map
  IpNode.hooks.egress.push(function (f, nh, pkt, opts) {
    if (!f.cryptoMap || !this.crypto) return false;
    if (pkt.proto === 'ESP' || (pkt.proto === 'UDP' && pkt.payload && (pkt.payload.dport === IKE_PORT || pkt.payload.sport === IKE_PORT))) return false;
    const entry = this.cryptoMatch(f.cryptoMap, pkt);
    if (!entry) return false;
    const sa = this.ike.sas.get(entry.peer);
    if (sa) { this.espSend(sa, pkt, opts); return true; }
    this.ikeStart(f, entry, pkt, opts);
    return true;
  });

  IpNode.ipProtos.ESP = function (pkt, f, frame) {
    const esp = pkt.payload || {};
    // клиент Easy VPN
    if (this.vpn && this.vpn.state === 'up' && esp.spi === this.vpn.mySpi) {
      const vf = this.ifaces.find((x) => x.kind === 'vpn');
      this.note('VPN: расшифрован пакет от ' + U.ipStr(esp.inner.src), frame, 'accept');
      if (vf) this.onIp(vf, esp.inner, frame);
      return;
    }
    const sa = this.ike && this.ike.bySpi.get(esp.spi);
    if (!sa) { if (frame) this.drop(frame, 'IPsec: неизвестный SPI 0x' + (esp.spi >>> 0).toString(16) + ' — нет защищённого канала'); return; }
    sa.decaps++;
    const inner = esp.inner;
    this.note('IPsec: расшифрован пакет ' + U.ipStr(inner.src) + ' → ' + U.ipStr(inner.dst) + ' от ' + U.ipStr(pkt.src), frame, 'accept');
    if (sa.client) this.onIp(f, inner, frame);
    else this.onIp(f, inner, frame);
  };

  IpNode.hooks.bind.push(function () {
    if (this.type !== 'router') return;
    this.udp.set(IKE_PORT, (pkt, f, frame) => {
      if (!this.crypto) { this.portClosed(pkt, f, frame); return; }
      this.ikeRespond(pkt, f);
    });
  });

  /* ================= Easy VPN: сервер ================= */

  IpNode.prototype.ezvpnRespond = function (pkt, f, d, reply, refuse) {
    const c = cfg(this);
    if (d.isakmp === 'CLIENT-BYE') {
      for (const [vip, cl] of this.vpnClients) {
        if (cl.real === pkt.src && cl.peerSpi === d.spi) {
          this.vpnClients.delete(vip);
          this.ike.bySpi.delete(cl.mySpi);
          this.poolFree(cl.pool, vip);
        }
      }
      return;
    }
    const g = c.groups[d.group];
    if (!g) { refuse('группа «' + d.group + '» не настроена (crypto isakmp client configuration group)'); return; }
    if (g.key !== d.key) { refuse('неверный ключ группы (Group Key)'); return; }
    if (!this.checkUser(d.user, d.pass)) { refuse('неверный логин или пароль (XAUTH: username … password …)'); return; }
    if (!g.pool || !this.localPools()[g.pool]) { refuse('для группы не задан пул адресов (pool … и ip local pool …)'); return; }
    const owner = 'vpn:' + U.ipStr(pkt.src) + ':' + d.user;
    const vip = this.poolAlloc(g.pool, owner);
    if (vip == null) { refuse('в пуле ' + g.pool + ' закончились адреса'); return; }
    const mySpi = newSpi(this);
    const inIf = this.ifaces.find((x) => x.ip === pkt.dst) || f;
    const cl = { vip, real: pkt.src, local: pkt.dst, ifc: inIf, mySpi, peerSpi: d.spi, user: d.user, group: d.group, pool: g.pool, since: this.net.time, encaps: 0, decaps: 0, client: true };
    this.vpnClients.set(vip, cl);
    this.ike.bySpi.set(mySpi, { peer: pkt.src, local: pkt.dst, mySpi, peerSpi: d.spi, client: true, decaps: 0, encaps: 0, transforms: ['esp-aes', 'esp-sha-hmac'] });
    let nets = null;
    if (g.acl) {
      const acl = this.acls.get(g.acl);
      if (acl) nets = acl.entries.filter((e) => e.action === 'permit').map((e) => ({ net: U.ipStr(e.src), wc: U.ipStr(e.srcWc) }));
    }
    reply({ isakmp: 'CLIENT-OK', ip: vip, spi: mySpi, split: nets }, 'Easy VPN: пользователь ' + d.user + ' подключён, выдан адрес ' + U.ipStr(vip));
  };

  function toClient(node, cl, pkt) {
    cl.encaps++;
    node.sendIp(P.ipv4(cl.local, cl.real, 'ESP', { spi: cl.peerSpi, seq: cl.encaps, transforms: ['esp-aes', 'esp-sha-hmac'], inner: pkt }, node.defaultTtl), {
      why: 'Easy VPN: пакет для ' + U.ipStr(pkt.dst) + ' зашифрован и отправлен клиенту ' + U.ipStr(cl.real),
    });
  }

  IpNode.hooks.forward.push(function (pkt) {
    if (!this.vpnClients || !this.vpnClients.size) return false;
    const cl = this.vpnClients.get(pkt.dst);
    if (!cl) return false;
    const out = U.clone(pkt);
    out.ttl = pkt.ttl - 1;
    toClient(this, cl, out);
    return true;
  });

  IpNode.hooks.send.push(function (pkt) {
    if (this.vpnClients && this.vpnClients.size) {
      const cl = this.vpnClients.get(pkt.dst);
      if (cl) {
        if (pkt.src == null) pkt.src = cl.local;
        toClient(this, cl, pkt);
        return true;
      }
    }
    // клиент: весь трафик (или только сети split-tunnel) — через туннель
    const v = this.vpn;
    if (!v || v.state !== 'up' || pkt.dst === v.server || pkt.dst === U.BROADCAST_IP) return false;
    if (pkt.proto === 'ESP' || (pkt.proto === 'UDP' && pkt.payload && (pkt.payload.dport === IKE_PORT || pkt.payload.sport === IKE_PORT || pkt.payload.dport === 67 || pkt.payload.dport === 68))) return false;
    if (v.split && !v.split.some((n) => U.matchWild(pkt.dst, U.parseIp(n.net), U.parseIp(n.wc)))) return false;
    if (this.hasIp(pkt.dst)) return false;
    const inner = Object.assign({}, pkt, { src: pkt.src == null || pkt.src !== v.vip ? v.vip : pkt.src });
    v.encaps++;
    this.sendIp(P.ipv4(null, v.server, 'ESP', { spi: v.peerSpi, seq: v.encaps, transforms: ['esp-aes', 'esp-sha-hmac'], inner }, this.defaultTtl), {
      why: 'VPN: пакет ' + U.ipStr(inner.src) + ' → ' + U.ipStr(inner.dst) + ' зашифрован и отправлен на VPN-сервер ' + U.ipStr(v.server),
    });
    return true;
  });

  /* ================= Easy VPN: клиент (программа «VPN» на ПК) ================= */

  IpNode.ifaceUpHooks.vpn = function () { return !!this.vpn && this.vpn.state === 'up'; };

  /** Подключиться. cb({ok, ip, error}). */
  IpNode.prototype.vpnConnect = function (server, group, key, user, pass, cb) {
    if (this.vpn && this.vpn.state === 'up') this.vpnDisconnect();
    const srv = U.parseIp(server);
    if (srv == null) { cb({ ok: false, error: 'Укажите IP-адрес VPN-сервера' }); return; }
    const port = this.allocPort();
    const mySpi = newSpi(this);
    let tries = 0;
    let timer = null;
    let done = false;
    this.vpn = { state: 'connecting', server: srv, text: 'Подключение…' };
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) timer.cancel();
      this.udp.delete(port);
      if (!r.ok) this.vpn = { state: 'down', server: srv, text: r.error };
      cb(r);
    };
    this.udp.set(port, (pkt) => {
      const d = pkt.payload.data || {};
      if (d.isakmp === 'NOTIFY') { finish({ ok: false, error: 'Сервер отклонил подключение: ' + d.text }); return; }
      if (d.isakmp !== 'CLIENT-OK') return;
      this.vpn = { state: 'up', server: srv, vip: d.ip, mySpi, peerSpi: d.spi, user, group, split: d.split || null, encaps: 0, since: this.net.time, text: 'Подключено' };
      const f = this.addIface(-1, 'VPN', null, 'vpn');
      f.ip = d.ip;
      f.mask = 0xFFFFFFFF;
      f.runtime = true;
      this.net.emit('config', { dev: this });
      finish({ ok: true, ip: d.ip });
    });
    const attempt = () => {
      timer = null;
      if (done) return;
      if (++tries > IKE_TRIES) { finish({ ok: false, error: 'VPN-сервер ' + U.ipStr(srv) + ' не отвечает (UDP 500)' }); return; }
      this.sendIp(P.ipv4(null, srv, 'UDP', P.udp(port, IKE_PORT, { isakmp: 'CLIENT', group: String(group || ''), key: String(key || ''), user: String(user || ''), pass: String(pass || ''), spi: mySpi }), this.defaultTtl), {
        why: 'VPN-клиент: подключение к ' + U.ipStr(srv) + ' (группа ' + group + ', пользователь ' + user + ')',
        onError: (code, text) => finish({ ok: false, error: 'Нет связи с VPN-сервером: ' + text }),
      });
      if (!done) timer = this.timer(IKE_TIMEOUT, attempt);
    };
    attempt();
  };

  IpNode.prototype.vpnDisconnect = function () {
    const v = this.vpn;
    if (!v) return;
    if (v.state === 'up') this.sendIp(P.ipv4(null, v.server, 'UDP', P.udp(this.allocPort(), IKE_PORT, { isakmp: 'CLIENT-BYE', spi: v.mySpi }), this.defaultTtl), { why: 'VPN-клиент: отключаюсь' });
    this.ifaces = this.ifaces.filter((f) => f.kind !== 'vpn');
    this.vpn = { state: 'down', server: v.server, text: 'Отключено' };
    this.net.emit('config', { dev: this });
  };

  // после перезапуска туннеля нет
  IpNode.hooks.runtime.push(function () {
    if (this.ifaces) this.ifaces = this.ifaces.filter((f) => f.kind !== 'vpn');
    if (this.vpn) this.vpn = { state: 'down', server: this.vpn.server, text: 'Отключено' };
  });

  /* ================= сохранение ================= */

  IpNode.ifaceExt.push({
    key: 'cryptoMap',
    save(f) { return f.cryptoMap || null; },
    load(f, d) { f.cryptoMap = d || null; },
  });

  NS.deviceExt.push({
    key: 'crypto',
    applies: (d) => d.type === 'router',
    save(d) {
      const c = d.crypto;
      const pools = d.pools && Object.keys(d.pools).length ? Object.fromEntries(Object.entries(d.pools).map(([k, v]) => [k, { start: U.ipStr(v.start), end: U.ipStr(v.end) }])) : null;
      if (!c && !pools) return null;
      return {
        policies: c ? c.policies.map((p) => Object.assign({}, p)) : [],
        keys: c ? c.keys.map((k) => ({ key: k.key, addr: U.ipStr(k.addr) })) : [],
        sets: c ? JSON.parse(JSON.stringify(c.sets)) : {},
        maps: c ? Object.fromEntries(Object.entries(c.maps).map(([k, list]) => [k, list.map((e) => ({ seq: e.seq, peer: e.peer != null ? U.ipStr(e.peer) : null, ts: e.ts, acl: e.acl }))])) : {},
        groups: c ? JSON.parse(JSON.stringify(c.groups)) : {},
        pools,
      };
    },
    load(d, c) {
      d.crypto = null;
      d.pools = {};
      d.legacyAaa = !!(c && c.aaa); // файлы 1.2: aaa new-model хранился здесь (теперь — aaa.js)
      if (!c) return;
      if ((c.policies || []).length || (c.keys || []).length || Object.keys(c.sets || {}).length || Object.keys(c.maps || {}).length || Object.keys(c.groups || {}).length) {
        d.crypto = {
          policies: (c.policies || []).map((p) => Object.assign(defaultPolicy(p.prio), p)),
          keys: (c.keys || []).map((k) => ({ key: String(k.key), addr: U.parseIp(k.addr) || 0 })),
          sets: c.sets || {},
          maps: Object.fromEntries(Object.entries(c.maps || {}).map(([k, list]) => [k, (list || []).map((e) => ({ seq: Number(e.seq) || 10, peer: e.peer ? U.parseIp(e.peer) : null, ts: e.ts || null, acl: e.acl || null }))])),
          groups: c.groups || {},
        };
      }
      for (const [k, v] of Object.entries(c.pools || {})) {
        const s = U.parseIp(v.start);
        const e = U.parseIp(v.end);
        if (s != null && e != null) d.pools[k] = { start: s, end: e };
      }
    },
  });

  /* ================= описание пакетов ================= */

  const innerText = (p) => (p ? U.ipStr(p.src) + ' → ' + U.ipStr(p.dst) + ' ' + p.proto + (p.payload && p.payload.type ? ' ' + p.payload.type : '') : '');

  const ISA_PHASE = { MM1: '1 — Main Mode, сообщение 1 из 6', MM2: '1 — Main Mode, 2 из 6', MM3: '1 — Main Mode, 3 из 6', MM4: '1 — Main Mode, 4 из 6', MM5: '1 — Main Mode, 5 из 6', MM6: '1 — Main Mode, 6 из 6',
    QM1: '2 — Quick Mode, сообщение 1 из 3', QM2: '2 — Quick Mode, 2 из 3', QM3: '2 — Quick Mode, 3 из 3' };
  function isaText(d) {
    switch (d.isakmp) {
      case 'MM1': return 'фаза 1 (1/6): предложение политик ISAKMP';
      case 'MM2': return 'фаза 1 (2/6): выбрана политика ' + (d.policy ? d.policy.prio : '?');
      case 'MM3': return 'фаза 1 (3/6): ключ Диффи — Хеллмана и nonce';
      case 'MM4': return 'фаза 1 (4/6): ответный ключ DH и nonce';
      case 'MM5': return 'фаза 1 (5/6): аутентификация (зашифровано)';
      case 'MM6': return 'фаза 1 (6/6): пир аутентифицирован, ISAKMP SA готов';
      case 'QM1': return 'фаза 2 (1/3): предложение transform-set и SPI';
      case 'QM2': return 'фаза 2 (2/3): согласие и SPI ответчика';
      case 'QM3': return 'фаза 2 (3/3): подтверждение, IPsec SA готов';
      case 'NOTIFY': return 'отказ (фаза ' + (d.phase || 1) + '): ' + d.text;
      case 'CLIENT': return 'вход VPN-клиента (' + d.user + ')';
      case 'CLIENT-OK': return 'клиенту выдан адрес ' + U.ipStr(d.ip);
      case 'CLIENT-BYE': return 'VPN-клиент отключается';
      default: return String(d.isakmp);
    }
  }

  P.register({
    protocols: { GRE: { label: 'GRE', color: '#be185d' }, ESP: { label: 'IPsec ESP', color: '#b91c1c' }, ISAKMP: { label: 'ISAKMP (IKE)', color: '#9f1239' } },
    classify(f) {
      if (f.type !== 'IPv4' || !f.payload) return null;
      const p = f.payload;
      if (p.proto === 'GRE') return 'GRE';
      if (p.proto === 'ESP') return 'ESP';
      if (p.proto === 'UDP' && p.payload && (p.payload.dport === IKE_PORT || p.payload.sport === IKE_PORT) && p.payload.data && p.payload.data.isakmp) return 'ISAKMP';
      return null;
    },
    summary(f) {
      if (f.type !== 'IPv4' || !f.payload) return null;
      const p = f.payload;
      const route = U.ipStr(p.src) + ' → ' + U.ipStr(p.dst);
      if (p.proto === 'GRE') return 'GRE-туннель ' + route + ' (внутри: ' + innerText(p.payload.inner) + ')';
      if (p.proto === 'ESP') return 'IPsec ESP, SPI 0x' + (p.payload.spi >>> 0).toString(16) + ', ' + route + ' — данные зашифрованы';
      const d = p.proto === 'UDP' && p.payload && p.payload.data;
      if (d && d.isakmp) {
        return 'ISAKMP: ' + isaText(d) + ', ' + route;
      }
      return null;
    },
    extraLayers(f, out) {
      if (f.type !== 'IPv4' || !f.payload) return;
      const p = f.payload;
      if (p.proto === 'GRE') out.push({ title: 'GRE (инкапсуляция)', fields: [['Протокол внутри', 'IPv4'], ['Внутренний пакет', innerText(p.payload.inner)]] });
      else if (p.proto === 'ESP') {
        out.push({ title: 'ESP (IPsec)', fields: [['SPI', '0x' + (p.payload.spi >>> 0).toString(16)], ['Номер', String(p.payload.seq)], ['Преобразования', (p.payload.transforms || []).join(' ')], ['Содержимое', 'зашифровано — снаружи его не видно'], ['Внутри (видно только в NetLab)', innerText(p.payload.inner)]] });
      } else if (p.proto === 'UDP' && p.payload && p.payload.data && p.payload.data.isakmp) {
        const d = p.payload.data;
        const fields = [['Сообщение', d.isakmp], ['Смысл', isaText(d)]];
        if (ISA_PHASE[d.isakmp]) fields.push(['Фаза IKE', ISA_PHASE[d.isakmp]]);
        if (d.policy) fields.push(['Выбранная политика', d.policy.prio + ': ' + d.policy.enc + '/' + d.policy.hash + '/' + d.policy.auth + '/DH' + d.policy.group]);
        if (d.nonce) fields.push(['Ключ DH (группа ' + d.group + ') и nonce', d.nonce]);
        if (d.hash) fields.push(['Содержимое', 'зашифровано общим ключом фазы 1 (SKEYID_e): ID ' + U.ipStr(d.id) + ' и хэш pre-shared key']);
        if (d.spi != null && /^QM/.test(d.isakmp)) fields.push(['SPI', '0x' + (d.spi >>> 0).toString(16)]);
        if (d.proxy) fields.push(['Защищаемый трафик', U.ipStr(d.proxy.src) + ' → ' + U.ipStr(d.proxy.dst)]);
        if (d.policies) fields.push(['Политики', d.policies.map((x) => x.prio + ': ' + x.enc + '/' + x.hash + '/' + x.auth + '/DH' + x.group).join('; ')]);
        if (d.transforms) fields.push(['Transform-set', d.transforms.join(' ')]);
        if (d.key != null) fields.push(['Pre-shared key', '•••• (передаётся в виде хэша)']);
        if (d.text) fields.push(['Причина', d.text]);
        if (d.user) fields.push(['Пользователь', d.user], ['Группа', d.group]);
        out.push({ title: 'ISAKMP / IKE (уровень 7)', fields });
      }
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;

  X.ifNames.push((dev, t) => {
    const m = /^tu(?:n(?:n(?:e(?:l)?)?)?)?(\d+)$/i.exec(t);
    if (!m || dev.type !== 'router') return null;
    const name = 'Tunnel' + Number(m[1]);
    return { kind: 'named', name, create: (d) => d.addTunnel(Number(m[1])), remove: (d) => { const f = d.ifaceByName(name); if (f) d.removeIface(f); } };
  });

  // «crypto …» уже считается глобальной командой (кроме crypto map в режиме интерфейса)
  X.global.push((t) => /^aaa$/i.test(t[0] || '') || (/^ip$/i.test(t[0] || '') && /^local$/i.test(t[1] || '')));

  X.modes['crypto-isakmp'] = {
    prompt: () => '(config-isakmp)#',
    tree: ['encryption aes 256', 'encryption aes', 'encryption 3des', 'encryption des', 'hash sha', 'hash md5', 'authentication pre-share', 'group WORD', 'lifetime WORD'],
    run(dev, s, t, io, C) {
      const p = s.ctx;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      C.withMutate(io, () => {
        if (C.kw(a[0], 'encryption', 1)) {
          const v = (a[1] || '').toLowerCase() + (a[2] ? ' ' + a[2] : '');
          if (!ENC.includes(v)) throw new Error('Шифрование: des, 3des, aes, aes 192, aes 256');
          p.enc = neg ? 'des' : v;
        } else if (C.kw(a[0], 'hash', 1)) {
          const v = (a[1] || '').toLowerCase();
          if (!['sha', 'md5', 'sha256'].includes(v)) throw new Error('Хэш: sha, md5, sha256');
          p.hash = neg ? 'sha' : v;
        } else if (C.kw(a[0], 'authentication', 1)) {
          p.auth = neg ? 'rsa-sig' : (C.kw(a[1], 'pre-share', 1) ? 'pre-share' : 'rsa-sig');
        } else if (C.kw(a[0], 'group', 1)) {
          const g = Number(a[1]);
          if (![1, 2, 5, 14, 15, 16].includes(g)) throw new Error('Группа Диффи-Хеллмана: 1, 2, 5, 14, 15, 16');
          p.group = neg ? 1 : g;
        } else if (C.kw(a[0], 'lifetime', 1)) {
          p.lifetime = neg ? 86400 : Math.max(60, Number(a[1]) || 86400);
        } else throw new Error('Неизвестная команда политики ISAKMP');
      });
    },
  };

  X.modes['crypto-map'] = {
    prompt: () => '(config-crypto-map)#',
    tree: ['set peer A.B.C.D', 'set transform-set WORD', 'match address WORD', 'set pfs group5', 'reverse-route'],
    run(dev, s, t, io, C) {
      const e = s.ctx;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'set', 1) && C.kw(a[1], 'peer', 1)) { const ip = U.parseIp(a[2] || ''); if (ip == null && !neg) { C.invalid(io, a[2]); return; } C.withMutate(io, () => { e.peer = neg ? null : ip; }); return; }
      if (C.kw(a[0], 'set', 1) && C.kw(a[1], 'transform-set', 1)) { C.withMutate(io, () => { e.ts = neg ? null : a[2]; }); return; }
      if (C.kw(a[0], 'match', 1) && C.kw(a[1], 'address', 1)) { C.withMutate(io, () => { e.acl = neg ? null : a[2]; }); return; }
      if (C.kw(a[0], 'set', 1) || C.kw(a[0], 'reverse-route', 3) || C.kw(a[0], 'description', 1)) return;
      C.invalid(io, a[0]);
    },
  };

  X.modes['crypto-trans'] = { prompt: () => '(cfg-crypto-trans)#', tree: ['mode tunnel', 'mode transport'], run(dev, s, t, io, C) { if (!C.kw(t[0], 'mode', 1) && !C.kw(t[0], 'no', 2)) C.invalid(io, t[0]); } };

  X.modes['isakmp-group'] = {
    prompt: () => '(config-isakmp-group)#',
    tree: ['key WORD', 'pool WORD', 'acl WORD', 'dns A.B.C.D'],
    run(dev, s, t, io, C) {
      const g = s.ctx;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'key', 1)) { C.withMutate(io, () => { g.key = neg ? '' : String(a[1] || ''); }); return; }
      if (C.kw(a[0], 'pool', 1)) { C.withMutate(io, () => { g.pool = neg ? null : a[1]; }); return; }
      if (C.kw(a[0], 'acl', 1)) { C.withMutate(io, () => { g.acl = neg ? null : a[1]; }); return; }
      if (C.kw(a[0], 'dns', 1) || C.kw(a[0], 'domain', 2) || C.kw(a[0], 'save-password', 2) || C.kw(a[0], 'max-users', 2)) return;
      C.invalid(io, a[0]);
    },
  };

  X.config.push((dev, s, a, neg, io, C) => {
    const isR = dev.type === 'router';
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'local', 3) && C.kw(a[2], 'pool', 1)) {
      if (!isR) return false;
      if (neg) { C.withMutate(io, () => { delete dev.localPools()[a[3]]; }); return true; }
      const st = U.parseIp(a[4] || '');
      const en = U.parseIp(a[5] || '') || st;
      if (!a[3] || st == null) { C.incomplete(io); return true; }
      C.withMutate(io, () => dev.setLocalPool(a[3], st, en));
      return true;
    }
    if (!C.kw(a[0], 'crypto', 2) || !isR) return false;
    if (C.kw(a[1], 'key', 1)) return false; // crypto key generate rsa — встроенная команда
    const c = cfg(dev);
    if (C.kw(a[1], 'isakmp', 1)) {
      if (C.kw(a[2], 'policy', 1)) {
        const prio = Number(a[3]);
        if (!(prio >= 1 && prio <= 10000)) { C.incomplete(io); return true; }
        if (neg) { C.withMutate(io, () => { c.policies = c.policies.filter((p) => p.prio !== prio); }); return true; }
        let p = c.policies.find((x) => x.prio === prio);
        if (!p) C.withMutate(io, () => { p = defaultPolicy(prio); c.policies.push(p); });
        s.ctx = c.policies.find((x) => x.prio === prio);
        s.mode = 'crypto-isakmp';
        return true;
      }
      if (C.kw(a[2], 'key', 1)) {
        let i = 3;
        if (/^[06]$/.test(a[i] || '')) i++;
        const key = a[i];
        const ai = a.findIndex((x) => C.kw(x, 'address', 3));
        const addr = ai > 0 ? U.parseIp(a[ai + 1] || '') : null;
        if (!key || addr == null) { C.incomplete(io); return true; }
        C.withMutate(io, () => { c.keys = c.keys.filter((k) => k.addr !== addr); if (!neg) c.keys.push({ key, addr }); });
        return true;
      }
      if (C.kw(a[2], 'client', 1) && C.kw(a[3], 'configuration', 1) && C.kw(a[4], 'group', 1)) {
        const name = a[5];
        if (!name) { C.incomplete(io); return true; }
        if (neg) { C.withMutate(io, () => { delete c.groups[name]; }); return true; }
        if (!c.groups[name]) C.withMutate(io, () => { c.groups[name] = { key: '', pool: null, acl: null }; });
        s.ctx = c.groups[name];
        s.mode = 'isakmp-group';
        return true;
      }
      if (C.kw(a[2], 'profile', 1) || C.kw(a[2], 'enable', 1) || C.kw(a[2], 'identity', 1) || C.kw(a[2], 'keepalive', 1)) return true;
      C.invalid(io, a[2]);
      return true;
    }
    if (C.kw(a[1], 'ipsec', 1) && C.kw(a[2], 'transform-set', 1)) {
      const name = a[3];
      if (!name) { C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => { delete c.sets[name]; }); return true; }
      const esp = a.slice(4).map((x) => x.toLowerCase());
      if (!esp.length || esp.some((x) => !/^(esp|ah)-/.test(x))) { C.invalid(io, a[4] || ''); return true; }
      C.withMutate(io, () => { c.sets[name] = { esp, mode: 'tunnel' }; });
      s.ctx = c.sets[name];
      s.mode = 'crypto-trans';
      return true;
    }
    if (C.kw(a[1], 'ipsec', 1)) return true; // security-association lifetime и т.п.
    if (C.kw(a[1], 'map', 1) || C.kw(a[1], 'dynamic-map', 2)) {
      const name = a[2];
      const seq = Number(a[3]);
      if (!name) { C.incomplete(io); return true; }
      if (!Number.isInteger(seq)) return true; // crypto map NAME client authentication list … — принимаем
      if (neg) { C.withMutate(io, () => { c.maps[name] = (c.maps[name] || []).filter((e) => e.seq !== seq); if (!c.maps[name].length) delete c.maps[name]; }); return true; }
      if (!c.maps[name]) c.maps[name] = [];
      let e = c.maps[name].find((x) => x.seq === seq);
      if (!e) C.withMutate(io, () => { e = { seq, peer: null, ts: null, acl: null }; c.maps[name].push(e); });
      if (a.some((x) => C.kw(x, 'dynamic', 3))) return true;
      s.ctx = c.maps[name].find((x) => x.seq === seq);
      s.mode = 'crypto-map';
      if (!s.ctx.acl && io.out) io.out('% NOTE: This new crypto map will remain disabled until a peer', 'hint');
      if (!s.ctx.acl && io.out) io.out('        and a valid access list have been configured.', 'hint');
      return true;
    }
    C.invalid(io, a[1]);
    return true;
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    const ifs = targets.map((r) => C.ifaceOf(dev, r)).filter(Boolean);
    if (C.kw(a[0], 'crypto', 2) && C.kw(a[1], 'map', 1)) {
      if (!neg && !a[2]) { C.incomplete(io); return true; }
      if (!neg && !(cfg(dev).maps[a[2]])) { io.out('% Crypto map ' + a[2] + ' не существует — сначала crypto map ' + a[2] + ' 10 ipsec-isakmp'); return true; }
      C.withMutate(io, () => { for (const f of ifs) f.cryptoMap = neg ? null : a[2]; });
      if (!neg) io.out('%CRYPTO-6-ISAKMP_ON_OFF: ISAKMP is ON');
      return true;
    }
    if (C.kw(a[0], 'tunnel', 2)) {
      const f = ifs[0];
      if (!f || f.kind !== 'tunnel') { io.out('% Команды tunnel работают только на interface Tunnel'); return true; }
      if (C.kw(a[1], 'source', 1)) {
        if (neg) { C.withMutate(io, () => { f.tunnel.src = null; }); return true; }
        const ipv = U.parseIp(a[2] || '');
        if (ipv != null) { C.withMutate(io, () => { f.tunnel.src = ipv; }); return true; }
        const r = C.parseIfName(dev, a.slice(2).join(''));
        const g = r && C.ifaceOf(dev, r);
        if (!g) { C.invalid(io, a[2]); return true; }
        C.withMutate(io, () => { f.tunnel.src = g.name; });
        return true;
      }
      if (C.kw(a[1], 'destination', 1)) {
        if (neg) { C.withMutate(io, () => { f.tunnel.dst = null; }); return true; }
        const ipv = U.parseIp(a[2] || '');
        if (ipv == null) { C.invalid(io, a[2]); return true; }
        C.withMutate(io, () => { f.tunnel.dst = ipv; dev.net.markRouting(); });
        return true;
      }
      if (C.kw(a[1], 'mode', 1) || C.kw(a[1], 'key', 1)) return true;
      C.invalid(io, a[1]);
      return true;
    }
    return false;
  });

  X.running.iface.push((dev, f) => {
    if (!f) return [];
    const L = [];
    if (f.kind === 'tunnel' && f.tunnel) {
      if (f.tunnel.src != null) L.push(' tunnel source ' + (typeof f.tunnel.src === 'number' ? U.ipStr(f.tunnel.src) : f.tunnel.src));
      if (f.tunnel.dst != null) L.push(' tunnel destination ' + U.ipStr(f.tunnel.dst));
    }
    if (f.cryptoMap) L.push(' crypto map ' + f.cryptoMap);
    return L;
  });

  X.running.global.push((dev) => {
    const c = dev.crypto;
    const L = [];
    if (!c) return L;
    for (const p of c.policies.slice().sort((x, y) => x.prio - y.prio)) {
      L.push('crypto isakmp policy ' + p.prio);
      if (p.enc !== 'des') L.push(' encryption ' + p.enc);
      if (p.hash !== 'sha') L.push(' hash ' + p.hash);
      if (p.auth === 'pre-share') L.push(' authentication pre-share');
      if (p.group !== 1) L.push(' group ' + p.group);
      if (p.lifetime !== 86400) L.push(' lifetime ' + p.lifetime);
      L.push('!');
    }
    for (const k of c.keys) L.push('crypto isakmp key ' + k.key + ' address ' + U.ipStr(k.addr));
    for (const [name, g] of Object.entries(c.groups)) {
      L.push('!', 'crypto isakmp client configuration group ' + name);
      if (g.key) L.push(' key ' + g.key);
      if (g.pool) L.push(' pool ' + g.pool);
      if (g.acl) L.push(' acl ' + g.acl);
    }
    if (c.keys.length || Object.keys(c.groups).length) L.push('!');
    for (const [name, t] of Object.entries(c.sets)) L.push('crypto ipsec transform-set ' + name + ' ' + t.esp.join(' '));
    if (Object.keys(c.sets).length) L.push('!');
    for (const [name, list] of Object.entries(c.maps)) {
      for (const e of list.slice().sort((x, y) => x.seq - y.seq)) {
        L.push('crypto map ' + name + ' ' + e.seq + ' ipsec-isakmp');
        if (e.peer != null) L.push(' set peer ' + U.ipStr(e.peer));
        if (e.ts) L.push(' set transform-set ' + e.ts);
        if (e.acl) L.push(' match address ' + e.acl);
      }
      L.push('!');
    }
    return L;
  });

  X.running.tail.push((dev) => {
    const L = [];
    for (const [name, p] of Object.entries(dev.pools || {})) L.push('ip local pool ' + name + ' ' + U.ipStr(p.start) + ' ' + U.ipStr(p.end));
    if (L.length) L.push('!');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'crypto', 2)) return false;
    const c = dev.crypto || cfg(dev);
    if (C.kw(a[1], 'isakmp', 1) && (C.kw(a[2], 'sa', 1) || !a[2])) {
      io.out('IPv4 Crypto ISAKMP SA');
      io.out('dst             src             state          conn-id slot status');
      let id = 2001;
      for (const x of dev.ike.p1.values()) {
        const dst = x.role === 'initiator' ? x.peer : x.local;
        const src = x.role === 'initiator' ? x.local : x.peer;
        io.out(C.pad(U.ipStr(dst), 16) + C.pad(U.ipStr(src), 16) + C.pad(x.state, 15) + C.pad(String(x.connId), 8) + C.pad('0', 5) + 'ACTIVE');
      }
      for (const [peer, f] of dev.ike.failed) if (f.phase !== 2) io.out(C.pad(U.ipStr(peer), 16) + C.pad('', 16) + C.pad('MM_NO_STATE', 15) + C.pad('0', 8) + C.pad('0', 5) + 'ACTIVE (deleted)  ' + f.text);
      for (const cl of dev.vpnClients.values()) io.out(C.pad(U.ipStr(cl.local), 16) + C.pad(U.ipStr(cl.real), 16) + C.pad('QM_IDLE', 15) + C.pad(String(id++), 8) + C.pad('0', 5) + 'ACTIVE (EzVPN ' + cl.user + ' ' + U.ipStr(cl.vip) + ')');
      for (const [peer, f] of dev.ike.failed) if (f.phase === 2) io.out('% Фаза 1 с ' + U.ipStr(peer) + ' прошла, но фаза 2 (IPsec) не согласована: ' + f.text);
      return true;
    }
    if (C.kw(a[1], 'isakmp', 1) && C.kw(a[2], 'policy', 1)) {
      for (const p of c.policies.slice().sort((x, y) => x.prio - y.prio)) {
        io.out('Global IKE policy');
        io.out('Protection suite of priority ' + p.prio);
        io.out('        encryption algorithm:   ' + p.enc.toUpperCase());
        io.out('        hash algorithm:         ' + (p.hash === 'sha' ? 'Secure Hash Standard' : p.hash.toUpperCase()));
        io.out('        authentication method:  ' + (p.auth === 'pre-share' ? 'Pre-Shared Key' : 'Rivest-Shamir-Adleman Signature'));
        io.out('        Diffie-Hellman group:   #' + p.group);
        io.out('        lifetime:               ' + p.lifetime + ' seconds, no volume limit');
      }
      return true;
    }
    if (C.kw(a[1], 'ipsec', 1) && C.kw(a[2], 'sa', 1)) {
      for (const sa of dev.ike.sas.values()) {
        io.out('interface: ' + sa.ifc);
        io.out('    Crypto map tag: ' + sa.map + ', local addr ' + U.ipStr(sa.local));
        io.out('   current_peer ' + U.ipStr(sa.peer) + ' port 500');
        io.out('    PERMIT, flags={origin_is_acl,}');
        io.out('    #pkts encaps: ' + sa.encaps + ', #pkts encrypt: ' + sa.encaps + ', #pkts digest: ' + sa.encaps);
        io.out('    #pkts decaps: ' + sa.decaps + ', #pkts decrypt: ' + sa.decaps + ', #pkts verify: ' + sa.decaps);
        io.out('     local crypto endpt.: ' + U.ipStr(sa.local) + ', remote crypto endpt.:' + U.ipStr(sa.peer));
        io.out('     current outbound spi: 0x' + (sa.peerSpi >>> 0).toString(16).toUpperCase());
        io.out('');
      }
      if (!dev.ike.sas.size) io.out('No SAs found (защищённый канал ещё не установлен — отправьте трафик, подходящий под ACL crypto map)');
      for (const [peer, f] of dev.ike.failed) io.out('% С ' + U.ipStr(peer) + ' не согласована фаза ' + f.phase + ': ' + f.text);
      return true;
    }
    if (C.kw(a[1], 'session', 1)) {
      io.out('Crypto session current status');
      const peers = new Set([...dev.ike.sas.keys(), ...[...dev.ike.p1.values()].map((x) => x.peer), ...dev.ike.pending.keys(), ...dev.ike.failed.keys()]);
      for (const peer of peers) {
        const sa = dev.ike.sas.get(peer);
        const p1 = p1Ready(dev, peer) || dev.ike.p1.get(p1Key(peer, 'initiator')) || dev.ike.p1.get(p1Key(peer, 'responder'));
        const st = sa && p1 && p1.state === 'QM_IDLE' ? 'UP-ACTIVE' : sa ? 'UP-NO-IKE' : p1 && p1.state === 'QM_IDLE' ? 'UP-IDLE' : dev.ike.pending.has(peer) ? 'DOWN-NEGOTIATING' : 'DOWN';
        const ifc = sa ? sa.ifc : (dev.ifaces.find((x) => x.cryptoMap) || {}).name || '?';
        io.out('');
        io.out('Interface: ' + ifc);
        io.out('Session status: ' + st);
        io.out('Peer: ' + U.ipStr(peer) + ' port 500');
        if (p1) io.out('  IKEv1 SA: local ' + U.ipStr(p1.local) + '/500 remote ' + U.ipStr(peer) + '/500 ' + (p1.state === 'QM_IDLE' ? 'Active' : 'Negotiating (' + p1.state + ')'));
        if (sa) io.out('  IPSEC FLOW: crypto map ' + sa.map + ', ACL ' + (sa.entry && sa.entry.acl) + '\n        Active SAs: 2, origin: crypto map');
        const fl = dev.ike.failed.get(peer);
        if (fl) io.out('  % фаза ' + fl.phase + ' не согласована: ' + fl.text);
      }
      return true;
    }
    if (C.kw(a[1], 'map', 1)) {
      for (const [name, list] of Object.entries(c.maps)) {
        for (const e of list) {
          io.out('Crypto Map ' + name + ' ' + e.seq + ' ipsec-isakmp');
          io.out('        Peer = ' + (e.peer != null ? U.ipStr(e.peer) : '(не задан)'));
          io.out('        Extended IP access list ' + (e.acl || '(не задан)'));
          io.out('        Transform sets={ ' + (e.ts || '') + ' }');
          io.out('        Interfaces using crypto map ' + name + ': ' + dev.ifaces.filter((f) => f.cryptoMap === name).map((f) => f.name).join(', '));
        }
      }
      return true;
    }
    C.invalid(io, a[1]);
    return true;
  });

  X.exec.push((dev, s, t, io, line, C) => {
    if (s.mode !== 'exec' || !C.kw(t[0], 'clear', 3) || !C.kw(t[1], 'crypto', 2)) return null;
    // clear crypto isakmp — фаза 1; clear crypto sa — фаза 2 (IPsec SA)
    if (C.kw(t[2], 'isakmp', 1)) { dev.ike.p1.clear(); dev.ike.failed.clear(); return { handled: true }; }
    dev.ike.sas.clear();
    dev.ike.bySpi.clear();
    dev.ike.failed.clear();
    return { handled: true };
  });

  X.tree.config = (X.tree.config || []).concat(['crypto isakmp policy WORD', 'crypto isakmp key WORD address A.B.C.D', 'crypto isakmp client configuration group WORD',
    'crypto ipsec transform-set WORD esp-aes esp-sha-hmac', 'crypto map WORD WORD ipsec-isakmp', 'ip local pool WORD A.B.C.D A.B.C.D', 'aaa new-model', 'interface tunnel WORD']);
  X.tree.if = (X.tree.if || []).concat(['crypto map WORD', 'tunnel source WORD', 'tunnel destination A.B.C.D', 'tunnel mode gre ip']);
  X.tree.exec = (X.tree.exec || []).concat(['show crypto isakmp sa', 'show crypto isakmp policy', 'show crypto ipsec sa', 'show crypto map', 'show crypto session', 'clear crypto sa', 'clear crypto isakmp']);
})(globalThis.NetLab = globalThis.NetLab || {});
