/* NetLab — AAA: служба AAA на Server-PT (RADIUS UDP 1812, TACACS+ TCP 49), клиент AAA в IOS:
 * aaa new-model, aaa authentication login|dot1x, radius server / radius-server host, tacacs server / tacacs-server host,
 * login authentication на линиях, test aaa group, show aaa servers. Вход в консоль, Telnet и SSH проверяется
 * по списку методов (group radius → group tacacs+ → local …): отказ сервера окончателен, недоступность — переход к следующему методу. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const X = NS.cliIos.ext;

  const RADIUS_PORT = 1812;
  const TACACS_PORT = 49;
  const TIMEOUT = 100;
  const TRIES = 2;

  /** Упрощённый «MD5» для EAP-MD5 и CHAP в модели (одинаковый у клиента и сервера). */
  function md5sim(s) {
    let a = 0x811c9dc5;
    let b = 0x2545f491;
    for (const c of String(s)) {
      a = Math.imul(a ^ c.charCodeAt(0), 16777619) >>> 0;
      b = (Math.imul(b, 31) + c.charCodeAt(0)) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }

  /* ================= служба AAA на сервере ================= */

  class AaaService {
    constructor(node) {
      this.node = node;
      this.enabled = false;
      this.clients = []; // { name, ip, secret, type: 'radius'|'tacacs' }
      this.users = [];   // { user, pass }
      this.log = [];
    }

    bind() {
      this.node.udp.set(RADIUS_PORT, (pkt, f, frame) => this.onRadius(pkt, f, frame));
      if (!this.node.tcp) return;
      if (!this.enabled) { this.node.tcp.unlisten(TACACS_PORT); return; }
      this.node.tcp.listen(TACACS_PORT, (conn) => {
        conn.send({ tacacs: 'hello' });
        conn.h.onData = (d) => this.onTacacs(conn, d || {});
      });
    }

    addClient(name, ip, secret, type) {
      const n = String(name || '').trim();
      if (!n) throw new Error('Укажите имя клиента (NAS)');
      if (ip == null) throw new Error('Укажите IP-адрес клиента — адрес интерфейса маршрутизатора или коммутатора, с которого приходят запросы');
      if (!String(secret || '')) throw new Error('Укажите общий ключ (secret)');
      const t = type === 'tacacs' ? 'tacacs' : 'radius';
      this.clients = this.clients.filter((c) => c.name !== n).concat([{ name: n, ip, secret: String(secret), type: t }]);
    }

    addUser(user, pass) {
      const u = String(user || '').trim();
      if (!/^[\w.@-]{1,32}$/.test(u)) throw new Error('Имя пользователя: латиница, цифры, «.», «-», «_», «@»');
      if (!String(pass || '')) throw new Error('Укажите пароль');
      this.users = this.users.filter((x) => x.user !== u).concat([{ user: u, pass: String(pass) }]);
    }

    record(text) {
      this.log.push({ time: this.node.clock ? this.node.clock() : '', text });
      if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
      this.node.net.emit('config', { dev: this.node });
    }

    /** Проверить пользователя: пароль (PAP / TACACS+) или ответ EAP-MD5. */
    verify(d) {
      const u = this.users.find((x) => x.user === String(d.user || ''));
      if (!u) return { ok: false, why: 'нет пользователя ' + d.user };
      if (d.eap) return md5sim(d.eap.id + u.pass + d.eap.challenge) === d.eap.value ? { ok: true } : { ok: false, why: 'неверный пароль (EAP-MD5)' };
      return u.pass === String(d.pass || '') ? { ok: true } : { ok: false, why: 'неверный пароль' };
    }

    onRadius(pkt, f, frame) {
      const node = this.node;
      if (!this.enabled) { node.portClosed(pkt, f, frame); return; }
      const d = pkt.payload.data || {};
      if (d.radius !== 'Access-Request') return;
      const c = this.clients.find((x) => x.type === 'radius' && x.ip === pkt.src);
      if (!c) {
        this.record('RADIUS: запрос от неизвестного клиента ' + U.ipStr(pkt.src) + ' — отброшен');
        if (frame) node.drop(frame, 'RADIUS: ' + U.ipStr(pkt.src) + ' нет в списке клиентов AAA-сервера');
        return;
      }
      if (c.secret !== d.secret) {
        this.record('RADIUS: неверный общий ключ от ' + c.name + ' (' + U.ipStr(pkt.src) + ')');
        if (frame) node.drop(frame, 'RADIUS: неверный общий ключ (key) у клиента ' + c.name + ' — ответа не будет');
        return;
      }
      const r = this.verify(d);
      this.record('RADIUS ' + (r.ok ? 'Access-Accept' : 'Access-Reject') + ': ' + d.user + ' от ' + c.name + (r.ok ? '' : ' (' + r.why + ')'));
      const reply = { radius: r.ok ? 'Access-Accept' : 'Access-Reject', id: d.id };
      node.sendIp(P.ipv4(pkt.dst, pkt.src, 'UDP', P.udp(RADIUS_PORT, pkt.payload.sport, reply), node.defaultTtl),
        { why: 'RADIUS ' + reply.radius + ': пользователь ' + d.user + (r.ok ? ' прошёл проверку' : ' — ' + r.why) });
    }

    onTacacs(conn, d) {
      if (d.tacacs !== 'authen') return;
      const c = this.clients.find((x) => x.type === 'tacacs' && x.ip === conn.rip);
      if (!c) {
        this.record('TACACS+: подключение от неизвестного клиента ' + U.ipStr(conn.rip));
        conn.send({ tacacs: 'ERROR', text: 'unknown client' });
        conn.close();
        return;
      }
      if (c.secret !== d.secret) {
        this.record('TACACS+: неверный ключ от ' + c.name);
        conn.send({ tacacs: 'ERROR', text: 'bad key' });
        conn.close();
        return;
      }
      const r = this.verify(d);
      this.record('TACACS+ ' + (r.ok ? 'PASS' : 'FAIL') + ': ' + d.user + ' от ' + c.name + (r.ok ? '' : ' (' + r.why + ')'));
      conn.send({ tacacs: r.ok ? 'PASS' : 'FAIL' });
      conn.close();
    }

    serialize() {
      return { enabled: this.enabled, clients: this.clients.map((c) => Object.assign({}, c, { ip: U.ipStr(c.ip) })), users: this.users.map((u) => Object.assign({}, u)) };
    }

    load(c) {
      if (!c) return;
      this.enabled = !!c.enabled;
      this.clients = (c.clients || []).map((x) => ({ name: String(x.name), ip: U.parseIp(x.ip), secret: String(x.secret || ''), type: x.type === 'tacacs' ? 'tacacs' : 'radius' })).filter((x) => x.ip != null);
      this.users = (c.users || []).map((x) => ({ user: String(x.user), pass: String(x.pass || '') }));
    }
  }

  NS.AaaService = AaaService;

  IpNode.hooks.bind.push(function () {
    if (this.type !== 'server') return;
    if (!this.aaad) this.aaad = new AaaService(this);
    this.aaad.bind();
  });

  NS.deviceExt.push({
    key: 'aaad',
    applies: (d) => d.type === 'server',
    save(d) {
      const a = d.aaad;
      if (!a || (!a.enabled && !a.clients.length && !a.users.length)) return null;
      return a.serialize();
    },
    load(d, c) {
      if (!d.aaad) d.aaad = new AaaService(d);
      d.aaad.enabled = false;
      d.aaad.clients = [];
      d.aaad.users = [];
      d.aaad.load(c);
      if (d.udp) d.aaad.bind();
    },
  });

  /* ================= клиент AAA (IOS) ================= */

  function cfg(dev) {
    if (!dev.aaa) dev.aaa = { newModel: false, login: {}, dot1x: null, radius: [], tacacs: [], radiusKey: null, tacacsKey: null };
    return dev.aaa;
  }
  function stats(dev, key) {
    if (!dev.aaaStats) dev.aaaStats = new Map();
    if (!dev.aaaStats.has(key)) dev.aaaStats.set(key, { req: 0, acc: 0, rej: 0, timeouts: 0, up: true });
    return dev.aaaStats.get(key);
  }

  /** RADIUS: опросить серверы по очереди. req: { user, pass } или { user, eap }. cb({result: accept|reject|error, text, server}). */
  function radiusAuth(dev, req, cb) {
    const a = cfg(dev);
    const servers = a.radius.filter((s) => s.ip != null);
    if (!servers.length) { cb({ result: 'error', text: 'не задан ни один RADIUS-сервер (radius server …)' }); return; }
    let si = 0;
    const tryServer = () => {
      if (si >= servers.length) { cb({ result: 'error', text: 'RADIUS-серверы не отвечают' }); return; }
      const s = servers[si++];
      const key = s.key != null ? s.key : a.radiusKey;
      const st = stats(dev, 'radius|' + s.ip);
      const port = dev.allocPort();
      const id = Math.floor(Math.random() * 256);
      let tries = 0;
      let timer = null;
      let done = false;
      const finish = () => { done = true; if (timer) timer.cancel(); dev.udp.delete(port); };
      dev.udp.set(port, (pkt) => {
        const d = pkt.payload.data || {};
        if (done || pkt.src !== s.ip || d.id !== id) return;
        finish();
        st.up = true;
        if (d.radius === 'Access-Accept') { st.acc++; cb({ result: 'accept', server: s }); } else { st.rej++; cb({ result: 'reject', text: 'Authentication failed', server: s }); }
      });
      const send = () => {
        if (done) return;
        if (tries >= TRIES) {
          finish();
          st.timeouts++;
          st.up = false;
          if (dev.iosLog) dev.iosLog('RADIUS', 4, 'RADIUS_DEAD', 'RADIUS server ' + U.ipStr(s.ip) + ':' + (s.authPort || RADIUS_PORT) + ',' + ((s.authPort || RADIUS_PORT) + 1) + ' is not responding.');
          tryServer();
          return;
        }
        tries++;
        st.req++;
        const data = Object.assign({ radius: 'Access-Request', id, secret: key, nas: dev.name }, req.eap ? { user: req.user, eap: req.eap } : { user: req.user, pass: req.pass });
        const ok = dev.sendIp(P.ipv4(null, s.ip, 'UDP', P.udp(port, s.authPort || RADIUS_PORT, data), dev.defaultTtl), { why: 'RADIUS Access-Request: проверить пользователя ' + req.user + ' на ' + U.ipStr(s.ip) + (tries > 1 ? ' (повтор)' : '') });
        if (ok === false && tries === 1) { /* нет маршрута — сработает тайм-аут */ }
        timer = dev.timer(TIMEOUT, send);
      };
      send();
    };
    tryServer();
  }

  /** TACACS+: TCP 49, по очереди по серверам. */
  function tacacsAuth(dev, user, pass, cb) {
    const a = cfg(dev);
    const servers = a.tacacs.filter((s) => s.ip != null);
    if (!servers.length) { cb({ result: 'error', text: 'не задан ни один TACACS+-сервер (tacacs server …)' }); return; }
    if (!dev.tcp) { cb({ result: 'error', text: 'нет TCP' }); return; }
    let si = 0;
    const tryServer = () => {
      if (si >= servers.length) { cb({ result: 'error', text: 'TACACS+-серверы недоступны' }); return; }
      const s = servers[si++];
      const st = stats(dev, 'tacacs|' + s.ip);
      st.req++;
      let done = false;
      const fail = (text) => { if (done) return; done = true; st.timeouts++; st.up = false; if (dev.iosLog) dev.iosLog('TAC', 4, 'SERVERTIMEOUT', 'TACACS server ' + U.ipStr(s.ip) + ': ' + text); tryServer(); };
      const conn = dev.tcp.connect(s.ip, s.port || TACACS_PORT, {
        onData: (d) => {
          if (done || !d) return;
          if (d.tacacs === 'hello') { conn.send({ tacacs: 'authen', user, pass, secret: s.key != null ? s.key : a.tacacsKey }); return; }
          if (d.tacacs === 'ERROR') { fail(d.text || 'error'); return; }
          done = true;
          st.up = true;
          if (d.tacacs === 'PASS') { st.acc++; cb({ result: 'accept', server: s }); } else { st.rej++; cb({ result: 'reject', text: 'Authentication failed', server: s }); }
        },
        onClose: () => fail('connection closed'),
        onError: (code, text) => fail(code === 'refused' ? 'connection refused (служба AAA выключена?)' : text || code),
      });
    };
    tryServer();
  }

  /** Проверить пользователя по списку методов. lc — настройки линии (для метода line). */
  function authenticate(dev, methods, user, pass, lc, cb) {
    let i = 0;
    let lastErr = null;
    const next = () => {
      if (i >= methods.length) { cb({ result: 'reject', text: 'Authentication failed' + (lastErr ? ' (' + lastErr + ')' : '') }); return; }
      const m = methods[i++];
      if (m === 'local' || m === 'local-case') {
        if (!dev.ios.users.length) { lastErr = 'в локальной базе нет пользователей'; next(); return; }
        cb(dev.checkUser(user, pass) ? { result: 'accept', method: 'local' } : { result: 'reject', text: 'Login invalid', method: 'local' });
        return;
      }
      if (m === 'none') { cb({ result: 'accept', method: 'none' }); return; }
      if (m === 'enable') {
        if (!dev.hasEnablePassword()) { lastErr = 'не задан enable secret'; next(); return; }
        cb(dev.checkEnable(pass) ? { result: 'accept', method: 'enable' } : { result: 'reject', text: 'Authentication failed', method: 'enable' });
        return;
      }
      if (m === 'line') {
        if (!lc || !lc.password) { lastErr = 'на линии не задан password'; next(); return; }
        cb(pass === lc.password ? { result: 'accept', method: 'line' } : { result: 'reject', text: 'Authentication failed', method: 'line' });
        return;
      }
      const done = (r) => { if (r.result === 'error') { lastErr = r.text; next(); } else cb(Object.assign({ method: m }, r)); };
      if (m === 'group radius') { radiusAuth(dev, { user, pass }, done); return; }
      if (m === 'group tacacs+') { tacacsAuth(dev, user, pass, done); return; }
      next();
    };
    next();
  }

  NS.aaa = { md5sim, radiusAuth, tacacsAuth, authenticate, cfg };

  /** Задание (job) CLI, пока идёт проверка на сервере. */
  function mkJob(dev) {
    const job = {
      done: false,
      cancel() { job.finish(); },
      finish() { job.done = true; if (dev.jobs) dev.jobs.delete(job); },
    };
    if (dev.jobs) dev.jobs.add(job);
    return job;
  }

  // вход на линию при aaa new-model
  X.login.push((dev, s, io, lineCfg, user, onOk, onDeny) => {
    const a = dev.aaa;
    if (!a || !a.newModel) return false;
    const lc = s.via === 'vty' ? dev.ios.vty : dev.ios.con;
    const listName = lc.authList || 'default';
    let methods = a.login[listName];
    if (!methods) {
      if (listName !== 'default') {
        io.out('% AAA: список методов «' + listName + '» не задан (aaa authentication login ' + listName + ' …)');
        if (onDeny) onDeny();
        return true;
      }
      methods = ['local'];
    }
    let tries = 0;
    const retry = () => { if (++tries < 3) { if (user) askPw(user); else askUser(); } else if (onDeny) onDeny(); };
    const askUser = () => {
      if (user) { askPw(user); return; }
      s.pending = { prompt: 'Username: ', handle: (u) => { askPw(u.trim()); return null; } };
    };
    const askPw = (u) => {
      s.pending = {
        prompt: 'Password: ',
        mask: true,
        handle: (pw) => {
          // ответ local / none приходит сразу, RADIUS и TACACS+ — после обмена с сервером (задание CLI)
          let sync = true;
          let settled = false;
          const job = mkJob(dev);
          authenticate(dev, methods, u, pw, lc, (r) => {
            settled = true;
            if (r.result === 'accept') { s.user = u; onOk(); } else { io.out('% ' + (r.text || 'Authentication failed')); io.out(''); retry(); }
            job.finish();
            if (!sync) io.done();
          });
          sync = false;
          return settled ? null : job;
        },
      };
    };
    askUser();
    return true;
  });

  /* ---------- команды ---------- */

  const METHODS = [['group radius', 2], ['group tacacs+', 2], ['local', 1], ['local-case', 1], ['enable', 1], ['line', 1], ['none', 1]];
  function parseMethods(a, C) {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      if (C.kw(a[i], 'group', 1)) {
        const g = a[i + 1];
        if (C.kw(g, 'radius', 1)) out.push('group radius');
        else if (/^tacacs\+?$/i.test(g || '') || C.kw(g, 'tacacs+', 3)) out.push('group tacacs+');
        else return { err: g || '' };
        i++;
        continue;
      }
      const m = METHODS.find(([k, n]) => !k.startsWith('group') && C.kw(a[i], k, n));
      if (!m) return { err: a[i] };
      out.push(m[0]);
    }
    return { methods: out };
  }

  const isNas = (dev) => dev.type === 'router' || dev.type === 'switch';

  X.global.push((t) => /^(aaa|radius|tacacs|radius-server|tacacs-server)$/i.test(t[0] || ''));

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isNas(dev)) return false;
    const w = a[0];
    if (C.kw(w, 'aaa', 3)) {
      const c = cfg(dev);
      if (C.kw(a[1], 'new-model', 1)) { C.withMutate(io, () => { c.newModel = !neg; }); return true; }
      if (!c.newModel && !neg) { C.invalid(io, a[1]); io.out('  (сначала включите AAA: aaa new-model)', 'hint'); return true; }
      if (C.kw(a[1], 'authentication', 5)) {
        if (C.kw(a[2], 'login', 1)) {
          const name = a[3];
          if (!name) { C.incomplete(io); return true; }
          if (neg) { C.withMutate(io, () => { delete c.login[name]; }); return true; }
          const r = parseMethods(a.slice(4), C);
          if (r.err != null) { C.invalid(io, r.err); return true; }
          if (!r.methods.length) { C.incomplete(io); return true; }
          C.withMutate(io, () => { c.login[name] = r.methods; });
          return true;
        }
        if (C.kw(a[2], 'dot1x', 1)) {
          if (neg) { C.withMutate(io, () => { c.dot1x = null; }); return true; }
          const r = parseMethods(a.slice(4), C);
          if (r.err != null) { C.invalid(io, r.err); return true; }
          C.withMutate(io, () => { c.dot1x = r.methods.length ? r.methods : ['group radius']; });
          return true;
        }
        return true; // enable, ppp … — принимаем
      }
      if (C.kw(a[1], 'authorization', 5) || C.kw(a[1], 'accounting', 2) || C.kw(a[1], 'session-id', 2)) return true;
      if (C.kw(a[1], 'group', 1)) { io.out('% Группы серверов в NetLab не поддерживаются — используйте group radius или group tacacs+ (все настроенные серверы).'); return true; }
      C.invalid(io, a[1]);
      return true;
    }
    if (C.kw(w, 'radius', 6) && C.kw(a[1], 'server', 1)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return true; }
      const c = cfg(dev);
      if (neg) { C.withMutate(io, () => { c.radius = c.radius.filter((x) => x.name !== name); }); return true; }
      if (!c.radius.some((x) => x.name === name)) C.withMutate(io, () => { c.radius.push({ name, ip: null, key: null, authPort: 1812 }); });
      s.mode = 'aaa-radius';
      s.aaaServer = name;
      return true;
    }
    if (C.kw(w, 'tacacs', 6) && C.kw(a[1], 'server', 1)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return true; }
      const c = cfg(dev);
      if (neg) { C.withMutate(io, () => { c.tacacs = c.tacacs.filter((x) => x.name !== name); }); return true; }
      if (!c.tacacs.some((x) => x.name === name)) C.withMutate(io, () => { c.tacacs.push({ name, ip: null, key: null, port: TACACS_PORT }); });
      s.mode = 'aaa-tacacs';
      s.aaaServer = name;
      return true;
    }
    if (C.kw(w, 'radius-server', 8) || C.kw(w, 'tacacs-server', 8)) {
      const rad = /^r/i.test(w);
      const c = cfg(dev);
      const list = rad ? c.radius : c.tacacs;
      if (C.kw(a[1], 'key', 1)) {
        const k = a[2] === '0' || a[2] === '7' ? a[3] : a[2];
        C.withMutate(io, () => { if (rad) c.radiusKey = neg ? null : k || null; else c.tacacsKey = neg ? null : k || null; });
        return true;
      }
      if (C.kw(a[1], 'host', 1)) {
        const ipv = U.parseIp(a[2] || '');
        if (ipv == null) { C.invalid(io, a[2]); return true; }
        if (neg) { C.withMutate(io, () => { const l = list.filter((x) => !(x.legacy && x.ip === ipv)); if (rad) c.radius = l; else c.tacacs = l; }); return true; }
        const ki = a.findIndex((x) => C.kw(x, 'key', 1));
        const pi = a.findIndex((x) => C.kw(x, 'auth-port', 2) || C.kw(x, 'port', 1));
        const key = ki > 0 ? (a[ki + 1] === '0' || a[ki + 1] === '7' ? a[ki + 2] : a[ki + 1]) : null;
        C.withMutate(io, () => {
          const e = { name: null, legacy: true, ip: ipv, key: key || null };
          if (rad) e.authPort = pi > 0 ? Number(a[pi + 1]) || RADIUS_PORT : RADIUS_PORT; else e.port = pi > 0 ? Number(a[pi + 1]) || TACACS_PORT : TACACS_PORT;
          const l = list.filter((x) => !(x.legacy && x.ip === ipv)).concat([e]);
          if (rad) c.radius = l; else c.tacacs = l;
        });
        if (rad) io.out('Warning: The CLI will be deprecated soon');
        return true;
      }
      return true; // timeout, retransmit, deadtime …
    }
    return false;
  });

  function serverMode(kind) {
    return {
      prompt: () => (kind === 'radius' ? '(config-radius-server)#' : '(config-server-tacacs)#'),
      tree: kind === 'radius' ? ['address ipv4 A.B.C.D auth-port 1812 acct-port 1813', 'key WORD'] : ['address ipv4 A.B.C.D', 'key WORD', 'port WORD'],
      run(dev, s, t, io, C) {
        const c = cfg(dev);
        const e = (kind === 'radius' ? c.radius : c.tacacs).find((x) => x.name === s.aaaServer);
        if (!e) return;
        const neg = C.kw(t[0], 'no', 2);
        const a = neg ? t.slice(1) : t;
        if (C.kw(a[0], 'address', 1)) {
          if (neg) { C.withMutate(io, () => { e.ip = null; }); return; }
          if (!C.kw(a[1], 'ipv4', 4)) { C.invalid(io, a[1]); return; }
          const v = U.parseIp(a[2] || '');
          if (v == null) { C.invalid(io, a[2]); return; }
          const pi = a.findIndex((x) => C.kw(x, 'auth-port', 2));
          C.withMutate(io, () => { e.ip = v; if (kind === 'radius') e.authPort = pi > 0 ? Number(a[pi + 1]) || RADIUS_PORT : RADIUS_PORT; });
          return;
        }
        if (C.kw(a[0], 'key', 1)) {
          const k = a[1] === '0' || a[1] === '7' ? a[2] : a[1];
          if (!neg && !k) { C.incomplete(io); return; }
          C.withMutate(io, () => { e.key = neg ? null : k; });
          return;
        }
        if (kind === 'tacacs' && C.kw(a[0], 'port', 1)) { C.withMutate(io, () => { e.port = neg ? TACACS_PORT : Number(a[1]) || TACACS_PORT; }); return; }
        if (C.kw(a[0], 'timeout', 1) || C.kw(a[0], 'retransmit', 1) || C.kw(a[0], 'single-connection', 1) || C.kw(a[0], 'automate-tester', 2)) return;
        C.invalid(io, a[0]);
      },
    };
  }
  X.modes['aaa-radius'] = serverMode('radius');
  X.modes['aaa-tacacs'] = serverMode('tacacs');

  // line: login authentication LIST
  X.line.push((dev, s, a, neg, io, L, C) => {
    if (!C.kw(a[0], 'login', 3)) return false;
    if (C.kw(a[1], 'authentication', 1)) {
      if (!dev.aaa || !dev.aaa.newModel) { C.invalid(io, a[1]); io.out('  (сначала включите AAA: aaa new-model)', 'hint'); return true; }
      C.withMutate(io, () => { if (neg || !a[2] || a[2] === 'default') delete L.authList; else L.authList = a[2]; });
      return true;
    }
    return false;
  });

  X.running.global.push((dev) => {
    const c = dev.aaa;
    if (!c || !c.newModel) return [];
    const L = ['aaa new-model', '!'];
    for (const [k, m] of Object.entries(c.login)) L.push('aaa authentication login ' + k + ' ' + m.join(' '));
    if (c.dot1x) L.push('aaa authentication dot1x default ' + c.dot1x.join(' '));
    if (Object.keys(c.login).length || c.dot1x) L.push('!');
    return L;
  });

  X.running.tail.push((dev) => {
    const c = dev.aaa;
    if (!c) return [];
    const L = [];
    for (const e of c.radius) {
      if (e.legacy) L.push('radius-server host ' + U.ipStr(e.ip) + ' auth-port ' + (e.authPort || RADIUS_PORT) + (e.key ? ' key ' + e.key : ''));
      else {
        L.push('radius server ' + e.name);
        if (e.ip != null) L.push(' address ipv4 ' + U.ipStr(e.ip) + ' auth-port ' + (e.authPort || RADIUS_PORT) + ' acct-port ' + ((e.authPort || RADIUS_PORT) + 1));
        if (e.key) L.push(' key ' + e.key);
        L.push('!');
      }
    }
    if (c.radiusKey) L.push('radius-server key ' + c.radiusKey);
    for (const e of c.tacacs) {
      if (e.legacy) L.push('tacacs-server host ' + U.ipStr(e.ip) + (e.key ? ' key ' + e.key : ''));
      else {
        L.push('tacacs server ' + e.name);
        if (e.ip != null) L.push(' address ipv4 ' + U.ipStr(e.ip));
        if (e.key) L.push(' key ' + e.key);
        if (e.port && e.port !== TACACS_PORT) L.push(' port ' + e.port);
        L.push('!');
      }
    }
    if (c.tacacsKey) L.push('tacacs-server key ' + c.tacacsKey);
    if (c.radius.some((e) => e.legacy) || c.tacacs.some((e) => e.legacy) || c.radiusKey || c.tacacsKey) L.push('!');
    return L;
  });

  X.running.line.push((dev, which, L) => (L.authList ? [' login authentication ' + L.authList] : []));

  X.show.push((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'aaa', 3)) return false;
    const c = dev.aaa;
    if (C.kw(a[1], 'servers', 1)) {
      if (!c) return true;
      let id = 0;
      for (const [kind, list] of [['RADIUS', c.radius], ['TACACS+', c.tacacs]]) {
        for (const e of list) {
          if (e.ip == null) continue;
          const st = stats(dev, (kind === 'RADIUS' ? 'radius|' : 'tacacs|') + e.ip);
          io.out(kind + ': id ' + (++id) + ', priority ' + id + ', host ' + U.ipStr(e.ip) + (kind === 'RADIUS' ? ', auth-port ' + (e.authPort || RADIUS_PORT) + ', acct-port ' + ((e.authPort || RADIUS_PORT) + 1) : ''));
          io.out('     State: current ' + (st.up ? 'UP' : 'DEAD') + ', duration ' + Math.floor(dev.net.time / 100) + 's, previous duration 0s');
          io.out('     Authen: request ' + st.req + ', timeouts ' + st.timeouts + ', failover 0, retransmission ' + Math.max(0, st.timeouts));
          io.out('             Response: accept ' + st.acc + ', reject ' + st.rej + ', challenge 0');
        }
      }
      return true;
    }
    if (C.kw(a[1], 'method-lists', 1)) {
      if (!c || !c.newModel) { io.out('% AAA не включён (aaa new-model)'); return true; }
      io.out('authen queue=AAA_ML_AUTHEN_LOGIN');
      for (const [k, m] of Object.entries(c.login)) io.out('  name=' + k + ' valid=TRUE id=0 :state=ALIVE : ' + m.map((x) => x.replace('group ', '').toUpperCase()).join(' '));
      if (c.dot1x) { io.out('authen queue=AAA_ML_AUTHEN_DOT1X'); io.out('  name=default valid=TRUE id=0 :state=ALIVE : ' + c.dot1x.map((x) => x.replace('group ', '').toUpperCase()).join(' ')); }
      return true;
    }
    return false;
  });

  // test aaa group radius|tacacs+ USER PASS [legacy|new-code]
  X.exec.push((dev, s, t, io, line, C) => {
    if (s.mode !== 'exec' || !C.kw(t[0], 'test', 2) || !C.kw(t[1], 'aaa', 3)) return null;
    if (!C.kw(t[2], 'group', 1) || !t[3] || !t[4] || !t[5]) { C.incomplete(io); return { handled: true }; }
    const rad = C.kw(t[3], 'radius', 1);
    const tac = /^tacacs\+?$/i.test(t[3]);
    if (!rad && !tac) { C.invalid(io, t[3]); return { handled: true }; }
    io.out('Attempting authentication test to server-group ' + (rad ? 'radius' : 'tacacs+') + ' using ' + (rad ? 'radius' : 'tacacs+'));
    let sync = true;
    const job = mkJob(dev);
    const done = (r) => {
      if (r.result === 'accept') io.out('User was successfully authenticated.');
      else if (r.result === 'reject') io.out('User authentication request was rejected by server.');
      else io.out('No authoritative response from any server.' + (r.text ? ' (' + r.text + ')' : ''));
      job.finish();
      if (!sync) io.done();
    };
    if (rad) radiusAuth(dev, { user: t[4], pass: t[5] }, done); else tacacsAuth(dev, t[4], t[5], done);
    sync = false;
    return { handled: true, job: job.done ? null : job };
  });

  NS.deviceExt.push({
    key: 'aaa',
    applies: isNas,
    save(d) {
      const c = d.aaa;
      const lines = {};
      if (d.ios && d.ios.con && d.ios.con.authList) lines.con = d.ios.con.authList;
      if (d.ios && d.ios.vty && d.ios.vty.authList) lines.vty = d.ios.vty.authList;
      const any = c && (c.newModel || c.radius.length || c.tacacs.length || c.radiusKey || c.tacacsKey);
      if (!any && !Object.keys(lines).length) return null;
      const srv = (e) => Object.assign({}, e, { ip: e.ip != null ? U.ipStr(e.ip) : null });
      return { newModel: !!(c && c.newModel), login: c ? c.login : {}, dot1x: c ? c.dot1x : null, radius: c ? c.radius.map(srv) : [], tacacs: c ? c.tacacs.map(srv) : [], radiusKey: c ? c.radiusKey : null, tacacsKey: c ? c.tacacsKey : null, lines };
    },
    load(d, c) {
      d.aaa = null;
      d.aaaStats = null;
      if (d.ios && d.ios.con) delete d.ios.con.authList;
      if (d.ios && d.ios.vty) delete d.ios.vty.authList;
      if (!c && d.legacyAaa) { cfg(d).newModel = true; return; }
      if (!c) return;
      const srv = (e) => Object.assign({}, e, { ip: e.ip ? U.parseIp(e.ip) : null });
      d.aaa = { newModel: !!c.newModel, login: Object.assign({}, c.login || {}), dot1x: c.dot1x || null, radius: (c.radius || []).map(srv), tacacs: (c.tacacs || []).map(srv), radiusKey: c.radiusKey || null, tacacsKey: c.tacacsKey || null };
      if (c.lines && d.ios) {
        if (c.lines.con && d.ios.con) d.ios.con.authList = c.lines.con;
        if (c.lines.vty && d.ios.vty) d.ios.vty.authList = c.lines.vty;
      }
    },
  });

  X.tree.config = (X.tree.config || []).concat(['aaa new-model', 'aaa authentication login default group radius local', 'aaa authentication login default group tacacs+ local', 'aaa authentication dot1x default group radius',
    'radius server WORD', 'tacacs server WORD', 'radius-server host A.B.C.D key WORD', 'tacacs-server host A.B.C.D key WORD']);
  X.tree.line = (X.tree.line || []).concat(['login authentication WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show aaa servers', 'show aaa method-lists authentication', 'test aaa group radius WORD WORD legacy', 'test aaa group tacacs+ WORD WORD legacy']);

  /* ---------- пакеты ---------- */

  P.register({
    protocols: { RADIUS: { label: 'RADIUS', color: '#7c3aed' }, TACACS: { label: 'TACACS+', color: '#6d28d9' } },
    classify(f) {
      const p = f.type === 'IPv4' ? f.payload : null;
      if (!p || !p.payload) return null;
      if (p.proto === 'UDP' && p.payload.data && p.payload.data.radius) return 'RADIUS';
      if (p.proto === 'TCP' && (p.payload.sport === TACACS_PORT || p.payload.dport === TACACS_PORT)) return 'TACACS';
      return null;
    },
    summary(f) {
      const p = f.type === 'IPv4' ? f.payload : null;
      const d = p && p.proto === 'UDP' && p.payload && p.payload.data;
      if (!d || !d.radius) return null;
      return 'RADIUS ' + d.radius + (d.user ? ': ' + d.user : '') + ', ' + U.ipStr(p.src) + ' → ' + U.ipStr(p.dst);
    },
    extraLayers(f, out) {
      const p = f.type === 'IPv4' ? f.payload : null;
      const d = p && p.proto === 'UDP' && p.payload && p.payload.data;
      if (!d || !d.radius) return;
      const fields = [['Код', d.radius], ['Идентификатор', String(d.id)]];
      if (d.user) fields.push(['User-Name', d.user]);
      if (d.pass != null) fields.push(['User-Password', '(зашифрован общим ключом)']);
      if (d.eap) fields.push(['EAP-Message', 'EAP-MD5, ответ на вызов ' + d.eap.challenge]);
      if (d.nas) fields.push(['NAS', d.nas]);
      out.push({ title: 'RADIUS', fields });
    },
  });
})(globalThis.NetLab = globalThis.NetLab || {});
