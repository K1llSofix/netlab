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
    this.ike = { sas: new Map(), bySpi: new Map(), pending: new Map(), failed: new Map() };
    this.vpnClients = new Map();
    this._tunCheck = false;
  });

  /* ---------- IKE (упрощённый) ---------- */

  function ikeData(dev, entry, f, pkt, mySpi) {
    const c = cfg(dev);
    const key = c.keys.find((k) => k.addr === entry.peer || k.addr === 0);
    return {
      isakmp: 'NEGOTIATE', policies: c.policies.slice().sort((a, b) => a.prio - b.prio).map((p) => Object.assign({}, p)),
      key: key ? key.key : null, transforms: (c.sets[entry.ts] || {}).esp || [], spi: mySpi,
      proxy: { src: pkt.src, dst: pkt.dst },
    };
  }

  IpNode.prototype.ikeStart = function (f, entry, pkt, opts) {
    const peer = entry.peer;
    let pend = this.ike.pending.get(peer);
    if (pend) { if (pend.queue.length < 32) pend.queue.push({ pkt, opts, f }); return; }
    const mySpi = newSpi(this);
    pend = { queue: [{ pkt, opts, f }], tries: 0, timer: null, mySpi, entry, f, port: this.allocPort() };
    this.ike.pending.set(peer, pend);
    this.udp.set(pend.port, (reply) => this.ikeReply(peer, reply.payload.data || {}));
    const send = () => {
      pend.timer = null;
      if (!this.ike.pending.has(peer)) return;
      if (++pend.tries > IKE_TRIES) { this.ikeFail(peer, 'Пир ' + U.ipStr(peer) + ' не отвечает на IKE (UDP 500)'); return; }
      const data = ikeData(this, entry, f, pkt, mySpi);
      this.sendIp(P.ipv4(f.ip, peer, 'UDP', P.udp(pend.port, IKE_PORT, data), this.defaultTtl), {
        why: 'IKE (ISAKMP): нужен защищённый канал к ' + U.ipStr(peer) + ' — предлагаю политики и ключ',
        onError: (code, text) => this.ikeFail(peer, 'Нет связи с пиром ' + U.ipStr(peer) + ': ' + text),
      });
      if (this.ike.pending.has(peer)) pend.timer = this.timer(IKE_TIMEOUT, send);
    };
    send();
  };

  IpNode.prototype.ikeFail = function (peer, text) {
    const pend = this.ike.pending.get(peer);
    if (!pend) return;
    if (pend.timer) pend.timer.cancel();
    this.udp.delete(pend.port);
    this.ike.pending.delete(peer);
    this.ike.failed.set(peer, { text, time: this.net.time });
    this.note('IPsec: канал к ' + U.ipStr(peer) + ' не установлен — ' + text, null, 'drop');
    for (const q of pend.queue) if (q.opts && q.opts.onError) q.opts.onError('ipsec', 'IPsec: ' + text);
  };

  IpNode.prototype.ikeReply = function (peer, d) {
    const pend = this.ike.pending.get(peer);
    if (!pend) return;
    if (d.isakmp === 'NOTIFY') { this.ikeFail(peer, d.text); return; }
    if (d.isakmp !== 'OK') return;
    if (pend.timer) pend.timer.cancel();
    this.udp.delete(pend.port);
    this.ike.pending.delete(peer);
    this.ike.failed.delete(peer);
    const sa = { peer, local: pend.f.ip, ifc: pend.f.name, map: pend.f.cryptoMap, entry: pend.entry, mySpi: pend.mySpi, peerSpi: d.spi, policy: d.policy, transforms: d.transforms, encaps: 0, decaps: 0, created: this.net.time, seqOut: 0 };
    this.ike.sas.set(peer, sa);
    this.ike.bySpi.set(sa.mySpi, sa);
    this.note('IPsec: защищённый канал с ' + U.ipStr(peer) + ' установлен (IKE фаза 1 и 2, SPI 0x' + sa.mySpi.toString(16) + ')', null, 'accept');
    for (const q of pend.queue) this.espSend(sa, q.pkt, q.opts);
  };

  /** Ответчик IKE: проверить ключ, политики, crypto map и зеркальный ACL. */
  IpNode.prototype.ikeRespond = function (pkt, f) {
    const d = pkt.payload.data || {};
    const reply = (data, why) => this.sendIp(P.ipv4(pkt.dst, pkt.src, 'UDP', P.udp(IKE_PORT, pkt.payload.sport, data), this.defaultTtl), { why });
    const refuse = (text) => { this.note('IKE: отказ ' + U.ipStr(pkt.src) + ' — ' + text, null, 'drop'); reply({ isakmp: 'NOTIFY', text }, 'IKE: отказ — ' + text); };
    if (d.isakmp === 'CLIENT' || d.isakmp === 'CLIENT-BYE') { this.ezvpnRespond(pkt, f, d, reply, refuse); return; }
    if (d.isakmp !== 'NEGOTIATE') return;
    const c = cfg(this);
    const key = c.keys.find((k) => k.addr === pkt.src || k.addr === 0);
    if (!key) { refuse('на ' + this.name + ' нет crypto isakmp key для адреса ' + U.ipStr(pkt.src)); return; }
    if (key.key !== d.key) { refuse('не совпадает pre-shared key (crypto isakmp key)'); return; }
    const mine = c.policies.slice().sort((a, b) => a.prio - b.prio);
    let policy = null;
    for (const theirs of d.policies || []) { policy = mine.find((m) => samePolicy(m, theirs)); if (policy) break; }
    if (!policy) { refuse('NO_PROPOSAL_CHOSEN — нет одинаковой crypto isakmp policy (шифрование, хэш, аутентификация, группа DH)'); return; }
    if (policy.auth !== 'pre-share') { refuse('в политике должна быть authentication pre-share'); return; }
    const inIf = this.ifaces.find((x) => x.ip === pkt.dst) || f;
    if (!inIf.cryptoMap) { refuse('на интерфейсе ' + inIf.name + ' не применена crypto map'); return; }
    const entry = (c.maps[inIf.cryptoMap] || []).find((e) => e.peer === pkt.src);
    if (!entry) { refuse('в crypto map ' + inIf.cryptoMap + ' нет записи с set peer ' + U.ipStr(pkt.src)); return; }
    const ts = (c.sets[entry.ts] || {}).esp || [];
    const theirTs = d.transforms || [];
    if (!ts.length || ts.join(' ') !== theirTs.join(' ')) { refuse('не совпадает transform-set (' + (ts.join(' ') || 'нет') + ' / ' + (theirTs.join(' ') || 'нет') + ')'); return; }
    const acl = this.acls.get(entry.acl);
    const mirror = d.proxy ? { src: d.proxy.dst, dst: d.proxy.src, proto: 'ICMP', payload: {} } : null;
    if (!acl || (mirror && !acl.check(Object.assign({}, mirror, { proto: 'IP' })).permit && !acl.check(mirror).permit)) {
      refuse('ACL ' + (entry.acl || '?') + ' в crypto map не зеркален ACL пира (match address)');
      return;
    }
    const mySpi = newSpi(this);
    const sa = { peer: pkt.src, local: pkt.dst, ifc: inIf.name, map: inIf.cryptoMap, entry, mySpi, peerSpi: d.spi, policy, transforms: ts, encaps: 0, decaps: 0, created: this.net.time, seqOut: 0 };
    const old = this.ike.sas.get(pkt.src);
    if (old) this.ike.bySpi.delete(old.mySpi);
    this.ike.sas.set(pkt.src, sa);
    this.ike.bySpi.set(mySpi, sa);
    reply({ isakmp: 'OK', spi: mySpi, policy, transforms: ts }, 'IKE: согласовано (политика ' + policy.prio + ', ' + ts.join(' ') + ') — SA с ' + U.ipStr(pkt.src));
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
        aaa: c ? !!c.aaa : false,
        pools,
      };
    },
    load(d, c) {
      d.crypto = null;
      d.pools = {};
      if (!c) return;
      if ((c.policies || []).length || (c.keys || []).length || Object.keys(c.sets || {}).length || Object.keys(c.maps || {}).length || Object.keys(c.groups || {}).length || c.aaa) {
        d.crypto = {
          policies: (c.policies || []).map((p) => Object.assign(defaultPolicy(p.prio), p)),
          keys: (c.keys || []).map((k) => ({ key: String(k.key), addr: U.parseIp(k.addr) || 0 })),
          sets: c.sets || {},
          maps: Object.fromEntries(Object.entries(c.maps || {}).map(([k, list]) => [k, (list || []).map((e) => ({ seq: Number(e.seq) || 10, peer: e.peer ? U.parseIp(e.peer) : null, ts: e.ts || null, acl: e.acl || null }))])),
          groups: c.groups || {},
          aaa: !!c.aaa,
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
        const k = { NEGOTIATE: 'предложение политик и SA', OK: 'согласие, SA установлен', NOTIFY: 'отказ: ' + d.text, CLIENT: 'вход VPN-клиента (' + d.user + ')', 'CLIENT-OK': 'клиенту выдан адрес ' + U.ipStr(d.ip), 'CLIENT-BYE': 'VPN-клиент отключается' }[d.isakmp] || d.isakmp;
        return 'ISAKMP: ' + k + ', ' + route;
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
        const fields = [['Сообщение', d.isakmp]];
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
    if (C.kw(a[0], 'aaa', 3)) {
      if (!isR) return false;
      C.withMutate(io, () => { cfg(dev).aaa = !neg || !C.kw(a[1], 'new-model', 1); if (neg && C.kw(a[1], 'new-model', 1)) cfg(dev).aaa = false; });
      return true;
    }
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
    if (c && c.aaa) L.push('aaa new-model', '!');
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
      let id = 1001;
      for (const sa of dev.ike.sas.values()) io.out(C.pad(U.ipStr(sa.peer), 16) + C.pad(U.ipStr(sa.local), 16) + C.pad('QM_IDLE', 15) + C.pad(String(id++), 8) + C.pad('0', 5) + 'ACTIVE');
      for (const [peer, f] of dev.ike.failed) io.out(C.pad(U.ipStr(peer), 16) + C.pad('', 16) + C.pad('MM_NO_STATE', 15) + C.pad('0', 8) + C.pad('0', 5) + 'ACTIVE (deleted)  ' + f.text);
      for (const cl of dev.vpnClients.values()) io.out(C.pad(U.ipStr(cl.local), 16) + C.pad(U.ipStr(cl.real), 16) + C.pad('QM_IDLE', 15) + C.pad(String(id++), 8) + C.pad('0', 5) + 'ACTIVE (EzVPN ' + cl.user + ' ' + U.ipStr(cl.vip) + ')');
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
    dev.ike.sas.clear();
    dev.ike.bySpi.clear();
    dev.ike.failed.clear();
    return { handled: true };
  });

  X.tree.config = (X.tree.config || []).concat(['crypto isakmp policy WORD', 'crypto isakmp key WORD address A.B.C.D', 'crypto isakmp client configuration group WORD',
    'crypto ipsec transform-set WORD esp-aes esp-sha-hmac', 'crypto map WORD WORD ipsec-isakmp', 'ip local pool WORD A.B.C.D A.B.C.D', 'aaa new-model', 'interface tunnel WORD']);
  X.tree.if = (X.tree.if || []).concat(['crypto map WORD', 'tunnel source WORD', 'tunnel destination A.B.C.D', 'tunnel mode gre ip']);
  X.tree.exec = (X.tree.exec || []).concat(['show crypto isakmp sa', 'show crypto isakmp policy', 'show crypto ipsec sa', 'show crypto map', 'clear crypto sa']);
})(globalThis.NetLab = globalThis.NetLab || {});
