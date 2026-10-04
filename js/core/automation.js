/* NetLab — автоматизация сети:
 *  • программный доступ к CLI устройства по SSH / Telnet (как netmiko): IpNode.cliConnect → send / enable / config / close;
 *  • NS.automation.handle(dev, kind, args, cb) — запросы программ с ПК (вкладка «Программирование»):
 *    http (REST), ssh.connect / ssh.send / ssh.config / ssh.enable / ssh.prompt / ssh.close, ping;
 *  • RESTCONF на маршрутизаторе: ip http server / secure-server, ip http authentication local, restconf;
 *    ietf-interfaces (GET, PUT, PATCH, DELETE), Cisco-IOS-XE-native:native/hostname, ietf-restconf корень. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const IpNode = NS.IpNode;
  const X = NS.cliIos.ext;
  const TIMEOUT = 3000; // тиков (30 с модельного времени)

  /* ================= программный CLI-клиент ================= */

  /**
   * Подключиться к CLI устройства. o: { host, proto: 'ssh'|'telnet', username, password, secret }.
   * cb(err, client); client: send(cmd, cb(err, text)), enable(cb), config(cmds, cb), close(), prompt.
   */
  IpNode.prototype.cliConnect = function (o, cb) {
    const proto = o.proto === 'telnet' ? 'telnet' : 'ssh';
    let phase = 'login';
    let buf = [];
    let pending = null;
    let sentUser = false;
    let sentPass = 0;
    let sentSecret = false;
    let done = false;
    let closed = false;
    let timer = null;
    const arm = (what) => {
      if (timer) timer.cancel();
      timer = this.timer(TIMEOUT, () => {
        timer = null;
        const e = new Error('Нет ответа от ' + o.host + ' (' + what + ')');
        if (phase === 'login') finish(e);
        else if (pending) { const p = pending; pending = null; p(e); }
      });
    };
    const finish = (err) => {
      if (done) return;
      done = true;
      if (timer) { timer.cancel(); timer = null; }
      if (err) { closed = true; try { sess.close(); } catch (e) { /* уже закрыто */ } cb(err); } else cb(null, client);
    };
    const client = {
      prompt: '',
      get closed() { return closed; },
      send: (cmd, cb2) => {
        if (closed) { cb2(new Error('Сеанс закрыт')); return; }
        if (pending) { cb2(new Error('Предыдущая команда ещё выполняется')); return; }
        pending = cb2;
        buf = [];
        sentSecret = false;
        arm('команда «' + cmd + '»');
        sess.send(String(cmd));
      },
      close: () => { if (!closed) { closed = true; try { sess.send('exit'); sess.close(); } catch (e) { /* уже закрыто */ } } },
    };
    const sess = this.openRemote(proto, String(o.host), proto === 'ssh' ? String(o.username || '') : null, {
      onOutput: (lines) => { for (const l of lines) buf.push(String(l)); },
      onPrompt: (prompt) => {
        if (phase === 'login') {
          if (/username:\s*$/i.test(prompt)) {
            if (sentUser) { finish(new Error('Authentication failed: неверное имя пользователя или пароль')); return; }
            sentUser = true;
            sess.send(String(o.username || ''));
            return;
          }
          if (/password:\s*$/i.test(prompt)) {
            if (sentPass >= 1) { finish(new Error('Authentication failed: неверное имя пользователя или пароль')); return; }
            sentPass++;
            sess.send(String(o.password || ''), true);
            return;
          }
          if (/[>#]\s*$/.test(prompt)) { phase = 'ready'; client.prompt = prompt.trim(); buf = []; finish(null); }
          return;
        }
        if (/password:\s*$/i.test(prompt) && pending) {
          if (sentSecret || o.secret == null) { const p = pending; pending = null; sess.send(''); p(new Error('Нужен пароль enable (secret)')); return; }
          sentSecret = true;
          sess.send(String(o.secret), true);
          return;
        }
        client.prompt = prompt.trim();
        if (pending) {
          if (timer) { timer.cancel(); timer = null; }
          const p = pending;
          pending = null;
          p(null, buf.join('\n'));
          buf = [];
        }
      },
      onClose: (reason) => {
        closed = true;
        if (phase === 'login') finish(new Error(String(reason || 'Соединение закрыто').replace(/^%\s*/, '')));
        else if (pending) { const p = pending; pending = null; p(new Error(reason || 'Соединение закрыто')); }
      },
    });
    arm('вход');
    client.enable = (cb2) => {
      if (/#$/.test(client.prompt)) { cb2(null, ''); return; }
      client.send('enable', (e, t) => (e ? cb2(e) : /#$/.test(client.prompt) ? cb2(null, t) : cb2(new Error('Не удалось войти в привилегированный режим: ' + t))));
    };
    client.config = (cmds, cb2) => {
      const list = ['configure terminal'].concat((Array.isArray(cmds) ? cmds : String(cmds).split('\n')).map(String).filter((x) => x.trim()), ['end']);
      const out = [];
      const next = (i) => {
        if (i >= list.length) { cb2(null, out.join('\n')); return; }
        const before = client.prompt;
        client.send(list[i], (e, t) => {
          if (e) { cb2(e); return; }
          out.push(before + list[i]);
          if (t) out.push(t);
          next(i + 1);
        });
      };
      client.enable((e) => (e ? cb2(e) : next(0)));
    };
    return client;
  };

  /* ================= запросы программ ================= */

  function sessions(dev) { if (!dev.autoSess) dev.autoSess = { seq: 0, map: new Map() }; return dev.autoSess; }

  const HANDLERS = {
    http(dev, a, cb) {
      dev.httpRequest(a.method || 'GET', a.url, { headers: a.headers || {}, body: a.body, insecure: a.verify === false }, (r) => {
        if (!r.ok && r.cert) { cb(new Error('SSLError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: ' + r.cert.code + ' (' + r.cert.text + '). Для учебного стенда: verify=False')); return; }
        if (!r.ok) { cb(new Error('ConnectionError: ' + (r.error || 'нет соединения'))); return; }
        cb(null, { status: r.status, reason: r.reason, headers: r.headers || {}, body: r.body, url: r.url });
      });
    },
    'ssh.connect'(dev, a, cb) {
      dev.cliConnect({ host: a.host, proto: a.proto, username: a.username, password: a.password, secret: a.secret }, (e, c) => {
        if (e) { cb(e); return; }
        const S = sessions(dev);
        const sid = ++S.seq;
        S.map.set(sid, c);
        cb(null, { sid, prompt: c.prompt });
      });
    },
    'ssh.send'(dev, a, cb) { const c = sessions(dev).map.get(a.sid); if (!c) { cb(new Error('Сеанс закрыт')); return; } c.send(a.cmd, cb); },
    'ssh.enable'(dev, a, cb) { const c = sessions(dev).map.get(a.sid); if (!c) { cb(new Error('Сеанс закрыт')); return; } c.enable((e, t) => cb(e, e ? null : t)); },
    'ssh.config'(dev, a, cb) { const c = sessions(dev).map.get(a.sid); if (!c) { cb(new Error('Сеанс закрыт')); return; } c.config(a.cmds, cb); },
    'ssh.prompt'(dev, a, cb) { const c = sessions(dev).map.get(a.sid); cb(null, c ? c.prompt : ''); },
    'ssh.close'(dev, a, cb) { const S = sessions(dev); const c = S.map.get(a.sid); if (c) { c.close(); S.map.delete(a.sid); } cb(null, true); },
    ping(dev, a, cb) {
      const count = Math.max(1, Math.min(10, Number(a.count) || 1));
      dev.ping(String(a.host), { count, onEvent: (e) => { if (e.type === 'done') cb(null, { sent: count, received: e.received || 0 }); } });
    },
  };

  NS.automation = {
    /** Выполнить запрос программы от имени устройства dev. cb(err, result). */
    handle(dev, kind, args, cb) {
      const h = HANDLERS[kind];
      if (!h) { cb(new Error('Неизвестный запрос ' + kind)); return; }
      if (!dev || !dev.power) { cb(new Error('Устройство выключено')); return; }
      try { h(dev, args || {}, cb); } catch (e) { cb(e); }
    },
    closeAll(dev) { if (dev && dev.autoSess) { for (const c of dev.autoSess.map.values()) c.close(); dev.autoSess.map.clear(); } },
    /** Программа на ПК (вкладка «Программирование»): { lang, code }. */
    program(dev) { return dev.pcProg || { lang: 'python', code: '# Программа на Python: print(), requests, ConnectHandler, ping\nprint("Привет из NetLab")\n' }; },
    setProgram(dev, p) { dev.pcProg = { lang: p.lang === 'js' ? 'js' : 'python', code: String(p.code || '').slice(0, 100000) }; },
  };

  NS.deviceExt.push({
    key: 'pcprog',
    applies: (d) => !!d.sendMail,
    save: (d) => (d.pcProg ? Object.assign({}, d.pcProg) : null),
    load(d, c) { d.pcProg = c && typeof c.code === 'string' ? { lang: c.lang === 'js' ? 'js' : 'python', code: c.code } : null; },
  });

  /* ================= RESTCONF на маршрутизаторе ================= */

  const isR = (d) => d.type === 'router';
  const httpCfg = (d) => d.httpd || (d.httpd = { server: false, secure: false, authLocal: false, restconf: false });

  function b64dec(s) {
    try { return typeof atob === 'function' ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, 'base64').toString('utf8'); } catch (e) { return ''; }
  }

  function ifJson(dev, f) {
    const loop = f.kind === 'loop';
    const o = { name: f.name, description: f.desc || '', type: loop ? 'iana-if-type:softwareLoopback' : f.kind === 'tunnel' ? 'iana-if-type:tunnel' : 'iana-if-type:ethernetCsmacd', enabled: !!f.adminUp && (f.kind !== 'phys' || !dev.ports[f.port] || dev.ports[f.port].adminUp) };
    o['ietf-ip:ipv4'] = f.ip != null ? { address: [{ ip: U.ipStr(f.ip), netmask: U.ipStr(f.mask) }] } : {};
    o['ietf-ip:ipv6'] = {};
    return o;
  }

  function applyCli(dev, lines) {
    const errs = [];
    NS.cliIos.replayConfig(dev, lines, { out: (l) => { if (!NS.cliIos.isInfo(l) && /^%/.test(String(l))) errs.push(l); }, mutate: (fn) => fn() }, false);
    dev.net.emit('remote-change', { dev });
    return errs;
  }

  /** Обработка HTTP-запроса RESTCONF → { status, reason, body, headers }. */
  function restconf(dev, d) {
    const c = httpCfg(dev);
    const json = (status, obj, reason) => ({ status, reason: reason || { 200: 'OK', 201: 'Created', 204: 'No Content' }[status] || 'OK', headers: { 'Content-Type': 'application/yang-data+json' }, body: obj == null ? '' : JSON.stringify(obj, null, 2) });
    const err = (status, reason, msg) => ({ status, reason, headers: { 'Content-Type': 'application/yang-data+json' }, body: JSON.stringify({ 'ietf-restconf:errors': { error: [{ 'error-type': 'application', 'error-tag': reason.toLowerCase().replace(/ /g, '-'), 'error-message': msg || reason }] } }, null, 2) });
    const path = decodeURIComponent(String(d.path || '/').replace(/\/index\.html$/, '/'));
    if (!/^\/restconf/.test(path)) {
      return { status: 200, reason: 'OK', body: '<html><h3>Cisco IOS HTTP server — ' + dev.ios.hostname + '</h3><p>' + (c.restconf ? 'RESTCONF: /restconf/data/…' : 'RESTCONF выключен (команда restconf)') + '</p></html>' };
    }
    if (!c.restconf) return { status: 404, reason: 'Not Found', body: '' };
    // авторизация: Basic, пользователь privilege 15
    const auth = String((d.headers || {}).Authorization || (d.headers || {}).authorization || '');
    const m = /^Basic\s+(.+)$/i.exec(auth);
    const cred = m ? b64dec(m[1]) : '';
    const i = cred.indexOf(':');
    const user = i >= 0 ? cred.slice(0, i) : '';
    const pass = i >= 0 ? cred.slice(i + 1) : '';
    const u = dev.ios.users.find((x) => x.name === user);
    if (!u || !dev.checkUser(user, pass) || (u.priv || 1) < 15) return err(401, 'Unauthorized', 'access-denied: нужен пользователь с privilege 15 (username … privilege 15 secret …)');
    const method = String(d.http || 'GET').toUpperCase();
    let body = null;
    if (d.body) { try { body = JSON.parse(d.body); } catch (e) { return err(400, 'Bad Request', 'malformed-message: тело не JSON'); } }
    if (path === '/restconf' || path === '/restconf/') {
      return json(200, { 'ietf-restconf:restconf': { data: {}, operations: {}, 'yang-library-version': '2016-06-21' } });
    }
    const IFS = '/restconf/data/ietf-interfaces:interfaces';
    if (path === IFS || path === IFS + '/') {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      return json(200, { 'ietf-interfaces:interfaces': { interface: dev.ifaces.filter((f) => !f.runtime).map((f) => ifJson(dev, f)) } });
    }
    const mi = new RegExp('^' + IFS.replace(/[.]/g, '\\.') + '/interface=(.+)$').exec(path); // имя с «/»: как есть или %2F
    if (mi) {
      const name = mi[1];
      const f = dev.ifaceByName(name);
      if (method === 'GET') return f ? json(200, { 'ietf-interfaces:interface': ifJson(dev, f) }) : err(404, 'Not Found', 'data-missing: нет интерфейса ' + name);
      if (method === 'DELETE') {
        if (!f) return err(404, 'Not Found');
        if (f.kind !== 'loop' && f.kind !== 'tunnel') return err(400, 'Bad Request', 'физический интерфейс нельзя удалить');
        applyCli(dev, ['no interface ' + f.name]);
        return json(204, null);
      }
      if (method === 'PUT' || method === 'PATCH') {
        const x = body && (body['ietf-interfaces:interface'] || body.interface);
        if (!x) return err(400, 'Bad Request', 'нужно тело { "ietf-interfaces:interface": {…} }');
        const lines = ['interface ' + name];
        if (x.description != null) lines.push(' description ' + x.description);
        const v4 = x['ietf-ip:ipv4'] && x['ietf-ip:ipv4'].address && x['ietf-ip:ipv4'].address[0];
        if (v4) lines.push(' ip address ' + v4.ip + ' ' + v4.netmask);
        if (x.enabled != null) lines.push(x.enabled ? ' no shutdown' : ' shutdown');
        const created = !f;
        const errs = applyCli(dev, lines);
        if (!dev.ifaceByName(name)) return err(400, 'Bad Request', 'не удалось создать интерфейс ' + name + (errs.length ? ': ' + errs.join('; ') : ''));
        if (errs.length) return err(400, 'Bad Request', errs.join('; '));
        return json(created ? 201 : 204, null);
      }
      return err(405, 'Method Not Allowed');
    }
    const HN = '/restconf/data/Cisco-IOS-XE-native:native/hostname';
    if (path === HN) {
      if (method === 'GET') return json(200, { 'Cisco-IOS-XE-native:hostname': dev.ios.hostname });
      if (method === 'PUT' || method === 'PATCH') {
        const v = body && (body['Cisco-IOS-XE-native:hostname'] || body.hostname);
        if (!v) return err(400, 'Bad Request', 'нужно тело { "Cisco-IOS-XE-native:hostname": "…" }');
        applyCli(dev, ['hostname ' + v]);
        return json(204, null);
      }
      return err(405, 'Method Not Allowed');
    }
    if (path === '/restconf/data/Cisco-IOS-XE-native:native' && method === 'GET') {
      return json(200, { 'Cisco-IOS-XE-native:native': { version: '16.9', hostname: dev.ios.hostname, interface: dev.ifaces.filter((f) => !f.runtime).map((f) => ({ name: f.name, ip: f.ip != null ? U.ipStr(f.ip) + ' ' + U.ipStr(f.mask) : null })) } });
    }
    return err(404, 'Not Found', 'data-missing: ' + path);
  }

  function bindHttp(dev) {
    if (!isR(dev) || !dev.tcp) return;
    const c = dev.httpd;
    for (const port of [80, 443]) {
      const l = dev.tcp.listeners.get(port);
      if (l && l.iosHttp) dev.tcp.unlisten(port);
    }
    if (!c) return;
    const accept = (conn) => {
      conn.h.onData = (d) => {
        if (!d || !d.http) return;
        const r = restconf(dev, d);
        conn.send(Object.assign({ http: 'RESP', path: d.path, server: 'Cisco IOS' }, r));
        conn.close();
      };
    };
    accept.iosHttp = true;
    if (c.server) dev.tcp.listen(80, accept);
    if (c.secure) dev.tcp.listen(443, NS.tls ? NS.tls.server(dev, accept) : accept);
  }
  IpNode.hooks.bind.push(function () { if (this.type === 'router') bindHttp(this); });

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isR(dev)) return false;
    if (C.kw(a[0], 'restconf', 5)) { C.withMutate(io, () => { httpCfg(dev).restconf = !neg; }); if (!neg && !httpCfg(dev).secure && !httpCfg(dev).server) io.out('% RESTCONF работает поверх HTTP(S): включите ip http secure-server', 'hint'); return true; }
    if (!C.kw(a[0], 'ip', 2) || !C.kw(a[1], 'http', 4)) return false;
    const c = httpCfg(dev);
    if (C.kw(a[2], 'server', 1)) { C.withMutate(io, () => { c.server = !neg; }); bindHttp(dev); return true; }
    if (C.kw(a[2], 'secure-server', 2)) { C.withMutate(io, () => { c.secure = !neg; }); bindHttp(dev); return true; }
    if (C.kw(a[2], 'authentication', 2)) { C.withMutate(io, () => { c.authLocal = !neg && C.kw(a[3], 'local', 1); }); return true; }
    if (C.kw(a[2], 'port', 1) || C.kw(a[2], 'path', 2) || C.kw(a[2], 'access-class', 2) || C.kw(a[2], 'timeout-policy', 2)) return true;
    if (a[2]) C.invalid(io, a[2]); else C.incomplete(io);
    return true;
  });

  X.running.global.push((dev) => {
    const c = isR(dev) && dev.httpd;
    if (!c) return [];
    const L = [];
    if (c.server) L.push('ip http server');
    if (c.authLocal) L.push('ip http authentication local');
    if (c.secure) L.push('ip http secure-server');
    if (c.restconf) L.push('restconf');
    if (L.length) L.push('!');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!isR(dev) || !C.kw(a[0], 'ip', 2) || !C.kw(a[1], 'http', 4)) return false;
    const c = httpCfg(dev);
    io.out('HTTP server status: ' + (c.server ? 'Enabled' : 'Disabled'));
    io.out('HTTP server port: 80');
    io.out('HTTP server authentication method: ' + (c.authLocal ? 'local' : 'enable'));
    io.out('HTTP secure server status: ' + (c.secure ? 'Enabled' : 'Disabled'));
    io.out('HTTP secure server port: 443');
    io.out('RESTCONF: ' + (c.restconf ? 'enabled' : 'disabled'));
    return true;
  });

  NS.deviceExt.push({
    key: 'httpd',
    applies: isR,
    save: (d) => (d.httpd && (d.httpd.server || d.httpd.secure || d.httpd.restconf || d.httpd.authLocal) ? Object.assign({}, d.httpd) : null),
    load(d, c) { d.httpd = c ? { server: !!c.server, secure: !!c.secure, authLocal: !!c.authLocal, restconf: !!c.restconf } : null; bindHttp(d); },
  });

  X.tree.config = (X.tree.config || []).concat(['ip http server', 'ip http secure-server', 'ip http authentication local', 'restconf']);
  X.tree.exec = (X.tree.exec || []).concat(['show ip http server status']);

  NS.restconf = { handle: restconf };
})(globalThis.NetLab = globalThis.NetLab || {});
