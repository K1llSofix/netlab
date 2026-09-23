/* NetLab — PPPoE: сервер доступа на маршрутизаторе (bba-group pppoe, interface Virtual-Template,
 * peer default ip address pool, ppp authentication chap/pap, pppoe enable group) и клиент на ПК
 * (программа «PPPoE Dialer»). Обнаружение PADI/PADO/PADR/PADS, LCP, CHAP/PAP, IPCP, сеанс PPPoE. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const TIMEOUT = 150;
  const TRIES = 3;

  /* ================= общее ================= */

  const pppFrame = (node, f, dstMac, sid, ppp, payload) => P.frame(node.ifaceMac(f), dstMac, 'PPPoE-S', { sid, ppp, payload }, f.kind === 'sub' ? f.vlan : null);
  const discFrame = (node, f, dstMac, data) => P.frame(node.ifaceMac(f), dstMac, 'PPPoE-D', data, f.kind === 'sub' ? f.vlan : null);

  /* ================= сервер ================= */

  function pppoeCfg(dev) {
    if (!dev.pppoe) dev.pppoe = { groups: {} };
    return dev.pppoe;
  }

  IpNode.prototype.addVirtualTemplate = function (n) {
    n = Number(n);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error('Номер Virtual-Template: 1–200');
    const name = 'Virtual-Template' + n;
    let f = this.ifaceByName(name);
    if (!f) {
      f = this.addIface(-1, name, null, 'vtemplate');
      f.vt = { unnumbered: null, pool: null, auth: null };
      if (this.sortIfaces) this.sortIfaces();
    }
    return f;
  };

  IpNode.ifaceKinds.vtemplate = {
    removable: true,
    create(dev, s) { const f = dev.addIface(-1, String(s.name), null, 'vtemplate'); f.vt = { unnumbered: null, pool: null, auth: null }; return f; },
  };
  IpNode.ifaceUpHooks.vtemplate = () => false; // шаблон — не рабочий интерфейс

  /** Адрес сервера для сеанса (ip unnumbered или адрес шаблона). */
  IpNode.prototype.vtAddress = function (vt) {
    if (vt.vt && vt.vt.unnumbered) {
      const g = this.ifaceByName(vt.vt.unnumbered);
      return g && g.ip != null ? g.ip : null;
    }
    return vt.ip;
  };

  IpNode.ifaceUpHooks.vaccess = function (f) {
    const s = this.pppoeSessions && this.pppoeSessions.get(f.sid);
    return !!s && s.state === 'up' && this.net.isPortOperational(this, f.port);
  };
  IpNode.ifaceSenders.vaccess = function (f, pkt, why) {
    const s = this.pppoeSessions.get(f.sid);
    if (!s) return false;
    return this.send(f.port, pppFrame(this, s.ifc, s.mac, s.sid, 'IP', pkt), why || 'PPPoE: пакет клиенту ' + U.ipStr(f.peer) + ' через ' + f.name);
  };

  IpNode.prototype.pppoeTeardown = function (sid, reason) {
    const s = this.pppoeSessions.get(sid);
    if (!s) return;
    this.pppoeSessions.delete(sid);
    this.ifaces = this.ifaces.filter((x) => !(x.kind === 'vaccess' && x.sid === sid));
    if (s.ip != null && s.pool) this.poolFree(s.pool, s.ip);
    this.note('PPPoE: сеанс ' + sid + ' закрыт' + (reason ? ' — ' + reason : ''), null, 'info');
    this.net.markRouting();
    this.net.emit('config', { dev: this });
  };

  /** Обнаружение на сервере: PADI → PADO, PADR → PADS, PADT. */
  function serverDiscovery(node, f, frame) {
    const d = frame.payload || {};
    const group = f.pppoeGroup;
    if (!group) { node.drop(frame, 'PPPoE не включён на ' + f.name + ' (pppoe enable group …)'); return; }
    const g = pppoeCfg(node).groups[group];
    if (!g) { node.drop(frame, 'bba-group ' + group + ' не настроена'); return; }
    if (d.code === 'PADI') {
      node.send(f.port, discFrame(node, f, frame.src, { code: 'PADO', ac: node.ios ? node.ios.hostname : node.name, service: d.service || '' }), 'PPPoE PADO: я сервер доступа ' + (node.ios ? node.ios.hostname : node.name));
    } else if (d.code === 'PADR') {
      const sid = node.pppoeNextSid++;
      node.pppoeSessions.set(sid, { sid, mac: frame.src, ifc: f, group, state: 'lcp', ip: null, pool: null, user: null, since: node.net.time });
      node.send(f.port, discFrame(node, f, frame.src, { code: 'PADS', sid }), 'PPPoE PADS: сеанс ' + sid + ' открыт');
    } else if (d.code === 'PADT') {
      node.pppoeTeardown(d.sid, 'клиент завершил сеанс');
    }
  }

  function serverSession(node, f, frame) {
    const m = frame.payload || {};
    const s = node.pppoeSessions.get(m.sid);
    if (!s) { node.drop(frame, 'PPPoE: неизвестный сеанс ' + m.sid); return; }
    const reply = (ppp, payload, why) => node.send(f.port, pppFrame(node, f, s.mac, s.sid, ppp, payload), why);
    const g = pppoeCfg(node).groups[s.group] || {};
    const vt = node.ifaceByName('Virtual-Template' + g.vt);
    const fail = (text) => {
      reply('LCP', { code: 'Terminate-Request', text }, 'PPP: разрываю соединение — ' + text);
      node.send(f.port, discFrame(node, f, s.mac, { code: 'PADT', sid: s.sid, text }), 'PPPoE PADT');
      node.pppoeTeardown(s.sid, text);
    };
    if (m.ppp === 'LCP' && m.payload.code === 'Configure-Request') {
      if (!vt) { fail('нет interface Virtual-Template' + g.vt + ' для bba-group ' + s.group); return; }
      const auth = vt.vt.auth || 'none';
      s.auth = auth;
      reply('LCP', { code: 'Configure-Ack', auth, mru: 1492 }, 'PPP LCP: параметры канала согласованы' + (auth !== 'none' ? ', проверка подлинности ' + auth.toUpperCase() : ''));
      if (auth === 'chap') {
        s.challenge = 'c' + node.net.counters.xid++;
        reply('CHAP', { code: 'Challenge', id: s.challenge, name: node.ios ? node.ios.hostname : node.name }, 'PPP CHAP Challenge: докажите, что знаете пароль');
      } else if (auth === 'none') {
        node.pppoeIpcp(s, vt, reply, fail);
      }
      return;
    }
    if ((m.ppp === 'CHAP' && m.payload.code === 'Response') || (m.ppp === 'PAP' && m.payload.code === 'Authenticate-Request')) {
      const ok = node.checkUser && node.checkUser(m.payload.user, m.payload.pass);
      if (!ok) {
        reply(m.ppp, { code: m.ppp === 'CHAP' ? 'Failure' : 'Authenticate-Nak', text: 'неверный логин или пароль' }, 'PPP ' + m.ppp + ': неверный логин или пароль');
        fail('проверка подлинности не пройдена (username … password … на маршрутизаторе)');
        return;
      }
      s.user = m.payload.user;
      reply(m.ppp, { code: m.ppp === 'CHAP' ? 'Success' : 'Authenticate-Ack' }, 'PPP ' + m.ppp + ': пользователь ' + s.user + ' опознан');
      node.pppoeIpcp(s, vt, reply, fail);
      return;
    }
    if (m.ppp === 'IPCP' && m.payload.code === 'Configure-Ack') {
      s.state = 'up';
      const k = [...node.pppoeSessions.keys()].indexOf(s.sid) + 1;
      const va = node.addIface(f.port, 'Virtual-Access' + (k || 1) + '.' + s.sid, null, 'vaccess');
      Object.assign(va, { runtime: true, p2p: true, sid: s.sid, ip: s.local, mask: 0xFFFFFFFF, peer: s.ip, peerMac: s.mac });
      node.note('PPPoE: клиент ' + (s.user || s.mac) + ' подключён, адрес ' + U.ipStr(s.ip), frame, 'accept');
      node.net.markRouting();
      node.net.emit('config', { dev: node });
      return;
    }
    if (m.ppp === 'IP') {
      const va = node.ifaces.find((x) => x.kind === 'vaccess' && x.sid === s.sid);
      if (!va || s.state !== 'up') { node.drop(frame, 'PPPoE: сеанс ещё не установлен'); return; }
      node.onIp(va, m.payload, frame);
      return;
    }
    if (m.ppp === 'LCP' && m.payload.code === 'Terminate-Request') node.pppoeTeardown(s.sid, 'клиент отключился');
  }

  IpNode.prototype.pppoeIpcp = function (s, vt, reply, fail) {
    const local = this.vtAddress(vt);
    if (local == null) { fail('у Virtual-Template нет адреса (ip unnumbered … или ip address …)'); return; }
    if (!vt.vt.pool) { fail('не задан пул: peer default ip address pool …'); return; }
    const ip = this.poolAlloc(vt.vt.pool, 'pppoe:' + s.sid);
    if (ip == null) { fail('пул ' + vt.vt.pool + ' пуст или не существует (ip local pool …)'); return; }
    s.ip = ip;
    s.pool = vt.vt.pool;
    s.local = local;
    reply('IPCP', { code: 'Configure-Nak', ip, peer: local, dns: this.dns || null }, 'PPP IPCP: назначаю клиенту адрес ' + U.ipStr(ip));
  };

  /* ================= клиент ================= */

  IpNode.ifaceUpHooks.pppoe = function (f) {
    return !!this.pppoeClient && this.pppoeClient.state === 'up' && this.net.isPortOperational(this, f.port);
  };
  IpNode.ifaceSenders.pppoe = function (f, pkt, why) {
    const c = this.pppoeClient;
    if (!c || c.state !== 'up') return false;
    const phys = this.ifaces.find((x) => x.port === f.port && x.kind === 'phys');
    return this.send(f.port, pppFrame(this, phys || f, c.acMac, c.sid, 'IP', pkt), why || 'PPPoE: пакет через сеанс ' + c.sid);
  };

  /** Подключиться. cb({ok, ip, error}). */
  IpNode.prototype.pppoeConnect = function (user, pass, cb) {
    if (this.pppoeClient && this.pppoeClient.state === 'up') this.pppoeDisconnect();
    const f = this.iface || this.ifaces.find((x) => x.kind === 'phys');
    if (!f || f.port < 0 || !this.ifaceUp(f) && !this.net.isPortOperational(this, f.port)) { cb({ ok: false, error: 'Сетевой интерфейс не подключён' }); return; }
    const c = { state: 'discovery', user: String(user || ''), pass: String(pass || ''), ifc: f, tries: 0, timer: null, cb, text: 'Поиск сервера доступа (PADI)…' };
    this.pppoeClient = c;
    const padi = () => {
      c.timer = null;
      if (c.state !== 'discovery') return;
      if (++c.tries > TRIES) { this.pppoeFinish({ ok: false, error: 'Сервер доступа PPPoE не ответил (нет PADO). Проверьте pppoe enable group … на маршрутизаторе.' }); return; }
      this.send(f.port, discFrame(this, f, U.BROADCAST_MAC, { code: 'PADI', service: '' }), 'PPPoE PADI: ищу сервер доступа' + (c.tries > 1 ? ' (попытка ' + c.tries + ')' : ''));
      c.timer = this.timer(TIMEOUT, padi);
    };
    padi();
  };

  IpNode.prototype.pppoeFinish = function (r) {
    const c = this.pppoeClient;
    if (!c) return;
    if (c.timer) { c.timer.cancel(); c.timer = null; }
    if (!r.ok) {
      c.state = 'down';
      c.text = r.error;
      this.ifaces = this.ifaces.filter((x) => x.kind !== 'pppoe');
    }
    const cb = c.cb;
    c.cb = null;
    if (cb) cb(r);
    this.net.emit('config', { dev: this });
  };

  IpNode.prototype.pppoeDisconnect = function () {
    const c = this.pppoeClient;
    if (!c) return;
    if (c.state === 'up' || c.state === 'session') {
      this.send(c.ifc.port, discFrame(this, c.ifc, c.acMac, { code: 'PADT', sid: c.sid }), 'PPPoE PADT: завершаю сеанс');
    }
    if (c.timer) c.timer.cancel();
    this.ifaces = this.ifaces.filter((x) => x.kind !== 'pppoe');
    this.pppoeClient = { state: 'down', text: 'Отключено' };
    this.net.markRouting();
    this.net.emit('config', { dev: this });
  };

  function clientDiscovery(node, f, frame) {
    const c = node.pppoeClient;
    const d = frame.payload || {};
    if (!c) return;
    if (d.code === 'PADO' && c.state === 'discovery') {
      if (c.timer) c.timer.cancel();
      c.acMac = frame.src;
      c.ac = d.ac;
      c.state = 'request';
      node.send(f.port, discFrame(node, f, frame.src, { code: 'PADR', service: '' }), 'PPPoE PADR: прошу открыть сеанс у ' + d.ac);
      c.timer = node.timer(TIMEOUT, () => node.pppoeFinish({ ok: false, error: 'Сервер не открыл сеанс (нет PADS)' }));
    } else if (d.code === 'PADS' && c.state === 'request') {
      if (c.timer) c.timer.cancel();
      c.sid = d.sid;
      c.state = 'session';
      node.send(f.port, pppFrame(node, f, c.acMac, c.sid, 'LCP', { code: 'Configure-Request', mru: 1492 }), 'PPP LCP: согласую параметры канала');
      c.timer = node.timer(TIMEOUT * 2, () => node.pppoeFinish({ ok: false, error: 'Нет ответа LCP/IPCP от сервера' }));
    } else if (d.code === 'PADT' && c.sid === d.sid) {
      const was = c.state;
      node.pppoeFinish({ ok: false, error: 'Сервер закрыл сеанс' + (d.text ? ': ' + d.text : '') });
      if (was === 'up') node.note('PPPoE: сервер закрыл сеанс', frame, 'drop');
    }
  }

  function clientSession(node, f, frame) {
    const c = node.pppoeClient;
    const m = frame.payload || {};
    if (!c || m.sid !== c.sid) { node.drop(frame, 'PPPoE: чужой сеанс'); return; }
    const send = (ppp, payload, why) => node.send(f.port, pppFrame(node, f, c.acMac, c.sid, ppp, payload), why);
    if (m.ppp === 'LCP' && m.payload.code === 'Configure-Ack') {
      if (m.payload.auth === 'pap') send('PAP', { code: 'Authenticate-Request', user: c.user, pass: c.pass }, 'PPP PAP: логин ' + c.user);
    } else if (m.ppp === 'CHAP' && m.payload.code === 'Challenge') {
      send('CHAP', { code: 'Response', id: m.payload.id, user: c.user, pass: c.pass }, 'PPP CHAP Response: пользователь ' + c.user);
    } else if ((m.ppp === 'CHAP' && m.payload.code === 'Failure') || (m.ppp === 'PAP' && m.payload.code === 'Authenticate-Nak')) {
      node.pppoeFinish({ ok: false, error: 'Неверное имя пользователя или пароль' });
    } else if (m.ppp === 'IPCP' && m.payload.code === 'Configure-Nak') {
      send('IPCP', { code: 'Configure-Ack', ip: m.payload.ip }, 'PPP IPCP: принимаю адрес ' + U.ipStr(m.payload.ip));
      c.state = 'up';
      c.ip = m.payload.ip;
      c.peer = m.payload.peer;
      c.text = 'Подключено';
      c.since = node.net.time;
      if (m.payload.dns != null && node.dns == null) node.dns = m.payload.dns;
      node.ifaces = node.ifaces.filter((x) => x.kind !== 'pppoe');
      const pf = node.addIface(f.port, 'PPPoE', null, 'pppoe');
      Object.assign(pf, { runtime: true, p2p: true, ip: c.ip, mask: 0xFFFFFFFF, peer: c.peer });
      node.net.markRouting();
      node.pppoeFinish({ ok: true, ip: c.ip });
    } else if (m.ppp === 'IP') {
      const pf = node.ifaces.find((x) => x.kind === 'pppoe');
      if (pf) node.onIp(pf, m.payload, frame);
    } else if (m.ppp === 'LCP' && m.payload.code === 'Terminate-Request') {
      node.pppoeFinish({ ok: false, error: 'Сервер разорвал соединение: ' + (m.payload.text || '') });
    }
  }

  IpNode.ethertypes['PPPoE-D'] = function (f, frame) {
    if (this.forwarding) serverDiscovery(this, f, frame);
    else clientDiscovery(this, f, frame);
  };
  IpNode.ethertypes['PPPoE-S'] = function (f, frame) {
    if (this.forwarding) serverSession(this, f, frame);
    else clientSession(this, f, frame);
  };

  IpNode.hooks.runtime.push(function () {
    this.pppoeSessions = new Map();
    this.pppoeNextSid = 1;
    if (this.ifaces) this.ifaces = this.ifaces.filter((x) => x.kind !== 'vaccess' && x.kind !== 'pppoe');
    if (this.pppoeClient) this.pppoeClient = { state: 'down', text: 'Отключено' };
  });

  // ПК с поднятым PPPoE: маршрут по умолчанию — через сеанс
  if (NS.Host) {
    const routes = NS.Host.prototype.staticRoutes;
    NS.Host.prototype.staticRoutes = function () {
      const pf = this.ifaces.find((x) => x.kind === 'pppoe');
      if (pf && this.ifaceUp(pf)) return [{ net: 0, mask: 0, nextHop: null, ifName: 'PPPoE', ad: 1, gateway: true }];
      return routes.call(this);
    };
  }

  /* ================= сохранение ================= */

  IpNode.ifaceExt.push({
    key: 'pppoe',
    save(f) {
      if (f.kind === 'vtemplate' && f.vt) return { unnumbered: f.vt.unnumbered, pool: f.vt.pool, auth: f.vt.auth };
      return f.pppoeGroup ? { group: f.pppoeGroup } : null;
    },
    load(f, d) {
      if (f.kind === 'vtemplate') {
        f.vt = { unnumbered: d && d.unnumbered || null, pool: d && d.pool || null, auth: d && d.auth || null };
        return;
      }
      f.pppoeGroup = d && d.group ? d.group : null;
    },
  });

  NS.deviceExt.push({
    key: 'pppoe',
    applies: (d) => d.type === 'router',
    save(d) { return d.pppoe && Object.keys(d.pppoe.groups).length ? { groups: JSON.parse(JSON.stringify(d.pppoe.groups)) } : null; },
    load(d, c) { d.pppoe = c && c.groups ? { groups: c.groups } : null; },
  });

  /* ================= описание пакетов ================= */

  const DISC = { PADI: 'PADI — поиск сервера доступа', PADO: 'PADO — предложение сервера', PADR: 'PADR — запрос сеанса', PADS: 'PADS — сеанс открыт', PADT: 'PADT — сеанс закрыт' };

  P.register({
    protocols: { PPPOE: { label: 'PPPoE', color: '#ca8a04' } },
    ethertypes: { 'PPPoE-D': '0x8863 PPPoE Discovery', 'PPPoE-S': '0x8864 PPPoE Session' },
    classify(f) {
      if (f.type === 'PPPoE-D') return 'PPPOE';
      if (f.type === 'PPPoE-S') {
        if (f.payload && f.payload.ppp === 'IP') return P.classify({ type: 'IPv4', payload: f.payload.payload });
        return 'PPPOE';
      }
      return null;
    },
    summary(f) {
      if (f.type === 'PPPoE-D') return 'PPPoE ' + (DISC[f.payload.code] || f.payload.code) + (f.payload.sid ? ' (сеанс ' + f.payload.sid + ')' : '');
      if (f.type === 'PPPoE-S') {
        const m = f.payload;
        if (m.ppp === 'IP') return 'PPPoE сеанс ' + m.sid + ': ' + P.summary({ type: 'IPv4', payload: m.payload, src: f.src, dst: f.dst });
        const p = m.payload || {};
        return 'PPP ' + m.ppp + ' ' + (p.code || '') + (p.user ? ' (' + p.user + ')' : '') + (p.ip != null ? ' ' + U.ipStr(p.ip) : '') + ', сеанс ' + m.sid;
      }
      return null;
    },
    layers(f) {
      if (f.type !== 'PPPoE-D' && f.type !== 'PPPoE-S') return null;
      const out = [P.l2Layer(f)];
      if (f.type === 'PPPoE-D') {
        const d = f.payload;
        const fields = [['Код', DISC[d.code] || d.code]];
        if (d.sid) fields.push(['Номер сеанса', String(d.sid)]);
        if (d.ac) fields.push(['Сервер доступа (AC-Name)', d.ac]);
        out.push({ title: 'PPPoE Discovery', fields });
        return out;
      }
      const m = f.payload;
      out.push({ title: 'PPPoE Session', fields: [['Номер сеанса', String(m.sid)], ['Протокол PPP', m.ppp]] });
      if (m.ppp === 'IP') {
        const inner = P.layers({ type: 'IPv4', payload: m.payload, src: f.src, dst: f.dst });
        return out.concat(inner.slice(1));
      }
      const p = m.payload || {};
      const fields = [['Сообщение', p.code || '']];
      if (p.user) fields.push(['Пользователь', p.user]);
      if (p.pass !== undefined) fields.push(['Пароль', m.ppp === 'PAP' ? '•••• (PAP передаёт пароль открыто!)' : '•••• (CHAP передаёт только хэш)']);
      if (p.ip != null) fields.push(['IP-адрес', U.ipStr(p.ip)]);
      if (p.auth) fields.push(['Проверка подлинности', p.auth]);
      if (p.text) fields.push(['Причина', p.text]);
      out.push({ title: 'PPP ' + m.ppp, fields });
      return out;
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;

  X.ifNames.push((dev, t) => {
    const m = /^(?:virtual-template|virtual-t|vi?r?t?u?a?l?-?template|vt)(\d+)$/i.exec(t);
    if (!m || dev.type !== 'router') return null;
    const name = 'Virtual-Template' + Number(m[1]);
    return { kind: 'named', name, create: (d) => d.addVirtualTemplate(Number(m[1])), remove: (d) => { const f = d.ifaceByName(name); if (f) d.removeIface(f); } };
  });

  X.global.push((t) => /^(bba-group|vpdn|vpdn-group)$/i.test(t[0] || ''));

  X.modes.bba = {
    prompt: () => '(config-bba-group)#',
    tree: ['virtual-template WORD', 'sessions per-mac limit WORD'],
    run(dev, s, t, io, C) {
      const g = s.ctx;
      if (C.kw(t[0], 'virtual-template', 1)) {
        const n = Number(t[1]);
        if (!(n >= 1)) { C.incomplete(io); return; }
        C.withMutate(io, () => { g.vt = n; });
        return;
      }
      if (C.kw(t[0], 'sessions', 1) || C.kw(t[0], 'no', 2)) return;
      C.invalid(io, t[0]);
    },
  };

  X.config.push((dev, s, a, neg, io, C) => {
    if (dev.type !== 'router') return false;
    if (C.kw(a[0], 'vpdn', 4) || C.kw(a[0], 'vpdn-group', 6)) return true;
    if (!C.kw(a[0], 'bba-group', 3)) return false;
    if (!C.kw(a[1], 'pppoe', 1) || !a[2]) { C.incomplete(io); return true; }
    const c = pppoeCfg(dev);
    if (neg) { C.withMutate(io, () => { delete c.groups[a[2]]; }); return true; }
    if (!c.groups[a[2]]) C.withMutate(io, () => { c.groups[a[2]] = { vt: 1 }; });
    s.ctx = c.groups[a[2]];
    s.mode = 'bba';
    return true;
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    const ifs = targets.map((r) => C.ifaceOf(dev, r)).filter(Boolean);
    if (C.kw(a[0], 'pppoe', 5) && C.kw(a[1], 'enable', 1)) {
      const gi = a.findIndex((x) => C.kw(x, 'group', 1));
      const g = gi > 0 ? a[gi + 1] : 'global';
      C.withMutate(io, () => { for (const f of ifs) f.pppoeGroup = neg ? null : g; });
      return true;
    }
    const vt = ifs[0] && ifs[0].kind === 'vtemplate' ? ifs[0] : null;
    if (C.kw(a[0], 'peer', 2) && C.kw(a[1], 'default', 1)) {
      if (!vt) { io.out('% Команда работает на interface Virtual-Template'); return true; }
      const pi = a.findIndex((x) => C.kw(x, 'pool', 1));
      C.withMutate(io, () => { vt.vt.pool = neg ? null : a[pi + 1] || null; });
      return true;
    }
    if (C.kw(a[0], 'ppp', 3) && C.kw(a[1], 'authentication', 1)) {
      if (!vt) return false;
      const m = (a[2] || '').toLowerCase();
      C.withMutate(io, () => { vt.vt.auth = neg ? null : m.startsWith('p') ? 'pap' : 'chap'; });
      return true;
    }
    if (vt && C.kw(a[0], 'ip', 2) && C.kw(a[1], 'unnumbered', 1)) {
      if (neg) { C.withMutate(io, () => { vt.vt.unnumbered = null; }); return true; }
      const r = C.parseIfName(dev, a.slice(2).join(''));
      const g = r && C.ifaceOf(dev, r);
      if (!g) { C.invalid(io, a[2]); return true; }
      C.withMutate(io, () => { vt.vt.unnumbered = g.name; });
      return true;
    }
    if (vt && (C.kw(a[0], 'mtu', 2) || C.kw(a[0], 'ppp', 3) || C.kw(a[0], 'keepalive', 2))) return true;
    return false;
  });

  X.running.iface.push((dev, f) => {
    if (!f) return [];
    const L = [];
    if (f.kind === 'vtemplate' && f.vt) {
      if (f.vt.unnumbered) L.push(' ip unnumbered ' + f.vt.unnumbered);
      if (f.vt.pool) L.push(' peer default ip address pool ' + f.vt.pool);
      if (f.vt.auth) L.push(' ppp authentication ' + f.vt.auth);
    }
    if (f.pppoeGroup) L.push(' pppoe enable group ' + f.pppoeGroup);
    return L;
  });
  X.running.global.push((dev) => {
    const c = dev.pppoe;
    if (!c) return [];
    const L = [];
    for (const [name, g] of Object.entries(c.groups)) L.push('bba-group pppoe ' + name, ' virtual-template ' + g.vt, '!');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'pppoe', 5)) return false;
    io.out('     ' + dev.pppoeSessions.size + ' session' + (dev.pppoeSessions.size === 1 ? '' : 's') + ' in LOCALLY_TERMINATED (PTA) State');
    io.out('');
    io.out('Uniq ID  PPPoE  RemMAC          Port                    VT  VA         State');
    io.out('           SID  LocMAC                                      VA-st      Type');
    for (const x of dev.pppoeSessions.values()) {
      const g = pppoeCfg(dev).groups[x.group] || {};
      const va = dev.ifaces.find((f) => f.kind === 'vaccess' && f.sid === x.sid);
      io.out(C.padL(String(x.sid), 7) + C.padL(String(x.sid), 7) + '  ' + C.pad(U.ciscoMac(x.mac), 16) + C.pad(x.ifc.name, 24) + C.pad(String(g.vt || ''), 4) + C.pad(va ? C.shortIf(va.name).replace('Virtual-Access', 'Vi') : '—', 11) + (x.state === 'up' ? 'PTA' : x.state.toUpperCase()));
      if (x.user) io.out('                 пользователь ' + x.user + ', адрес ' + U.ipStr(x.ip));
    }
    return true;
  });

  X.exec.push((dev, s, t, io, line, C) => {
    if (s.mode !== 'exec' || !C.kw(t[0], 'clear', 3) || !C.kw(t[1], 'pppoe', 5)) return null;
    for (const sid of [...dev.pppoeSessions.keys()]) {
      const x = dev.pppoeSessions.get(sid);
      dev.send(x.ifc.port, discFrame(dev, x.ifc, x.mac, { code: 'PADT', sid }), 'PPPoE PADT: сеанс сброшен администратором');
      dev.pppoeTeardown(sid, 'clear pppoe all');
    }
    return { handled: true };
  });

  X.tree.config = (X.tree.config || []).concat(['bba-group pppoe WORD', 'interface virtual-template WORD', 'vpdn enable']);
  X.tree.if = (X.tree.if || []).concat(['pppoe enable group WORD', 'peer default ip address pool WORD', 'ppp authentication chap', 'ppp authentication pap', 'ip unnumbered WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show pppoe session', 'clear pppoe all']);
})(globalThis.NetLab = globalThis.NetLab || {});
