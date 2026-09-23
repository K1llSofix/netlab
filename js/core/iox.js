/* NetLab — Cisco IOx (размещение приложений на маршрутизаторе) и IoX IDE:
 *  • IOS: iox, interface VirtualPortGroup0, app-hosting appid … (app-vnic, guest-ipaddress,
 *    app-default-gateway, start), app-hosting install/activate/start/stop/deactivate/uninstall,
 *    show iox-service, show app-hosting list / detail;
 *  • IOx Local Manager (TCP 8443): программа «IoX IDE» на компьютере входит под пользователем
 *    с privilege 15, загружает пакет (package.yaml + файлы сайта) и управляет жизненным циклом;
 *  • запущенное веб-приложение отвечает по HTTP на своём гостевом адресе (http://адрес:порт). */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const LM_PORT = 8443;
  const STATES = ['DEPLOYED', 'ACTIVATED', 'RUNNING', 'STOPPED'];

  function cfg(dev) {
    if (!dev.iox) dev.iox = { enabled: false, apps: {}, pkgs: {} };
    return dev.iox;
  }

  /** Проверить манифест и файлы пакета. Возвращает нормализованный пакет или бросает Error. */
  function normPackage(appid, manifest, files) {
    const m = manifest || {};
    const port = Number(m.port || 8000);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Порт приложения в package.yaml: 1024–65535');
    const f = {};
    for (const [k, v] of Object.entries(files || {})) {
      const n = String(k).trim().toLowerCase().replace(/^\/+/, '');
      if (!/^[a-z0-9._-]{1,64}$/.test(n)) throw new Error('Имя файла «' + k + '»: латиница, цифры, «.», «-», «_»');
      f[n] = String(v).slice(0, 200000);
    }
    if (!f['index.html']) throw new Error('В пакете нет index.html');
    return { name: String(m.name || appid).slice(0, 40), version: String(m.version || '1.0').slice(0, 20), description: String(m.description || '').slice(0, 200), port, files: f };
  }

  /** Разобрать простой package.yaml (ключ: значение, вложенность по отступам не нужна). */
  function parseYaml(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line.replace(/#.*$/, ''));
      if (!m || m[2] === '') continue;
      out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  }

  /* ================= VirtualPortGroup ================= */

  IpNode.ifaceKinds.vpg = { removable: true, create: (dev, s) => dev.addIface(-1, String(s.name), null, 'vpg') };
  IpNode.ifaceUpHooks.vpg = function (f) { return !!(this.iox && this.iox.enabled) && f.adminUp; };
  IpNode.ifaceUpHooks.ioxguest = function () { return true; };

  IpNode.prototype.addVpg = function (n) {
    const name = 'VirtualPortGroup' + Number(n);
    let f = this.ifaceByName(name);
    if (!f) {
      f = this.addIface(-1, name, null, 'vpg');
      if (this.sortIfaces) this.sortIfaces();
    }
    this.net.markRouting();
    return f;
  };

  /* ================= жизненный цикл приложений ================= */

  function appCfg(dev, id) {
    const c = cfg(dev);
    if (!c.apps[id]) c.apps[id] = { vnic: null, guestIp: null, mask: null, gw: null, start: false, state: null };
    return c.apps[id];
  }

  /** Почему приложение не может быть активировано (или null). */
  function activateProblem(dev, id) {
    const c = cfg(dev);
    if (!c.enabled) return 'IOx не включён: выполните iox в режиме конфигурации';
    const a = c.apps[id];
    if (!a || !a.state) return 'Приложение ' + id + ' не установлено (app-hosting install)';
    if (!a.vnic) return 'Не задан сетевой интерфейс приложения: app-vnic gateway0 virtualportgroup 0 guest-interface 0';
    const vpg = dev.ifaceByName(a.vnic);
    if (!vpg || vpg.ip == null) return 'У ' + a.vnic + ' нет IP-адреса';
    if (a.guestIp == null) return 'Не задан guest-ipaddress';
    if (!U.sameNet(a.guestIp, vpg.ip, vpg.mask) || a.guestIp === vpg.ip) return 'guest-ipaddress ' + U.ipStr(a.guestIp) + ' должен быть в сети ' + U.cidr(U.net(vpg.ip, vpg.mask), vpg.mask) + ' интерфейса ' + a.vnic;
    return null;
  }

  function ioxAction(dev, id, action) {
    const c = cfg(dev);
    const a = c.apps[id];
    const st = a && a.state;
    switch (action) {
      case 'activate': {
        if (st !== 'DEPLOYED' && st !== 'STOPPED') return st ? 'Приложение уже ' + st : 'Приложение ' + id + ' не установлено';
        const why = activateProblem(dev, id);
        if (why) return why;
        a.state = 'ACTIVATED';
        break;
      }
      case 'start':
        if (st === 'DEPLOYED' || st === 'STOPPED') { const e = ioxAction(dev, id, 'activate'); if (e) return e; }
        else if (st !== 'ACTIVATED') return st === 'RUNNING' ? 'Приложение уже запущено' : 'Приложение ' + id + ' не установлено';
        a.state = 'RUNNING';
        break;
      case 'stop':
        if (st !== 'RUNNING') return 'Приложение не запущено';
        a.state = 'STOPPED';
        break;
      case 'deactivate':
        if (st !== 'ACTIVATED' && st !== 'STOPPED') return 'Сначала остановите приложение';
        a.state = 'DEPLOYED';
        break;
      case 'uninstall':
        if (!st) return 'Приложение ' + id + ' не установлено';
        if (st !== 'DEPLOYED') return 'Сначала остановите и деактивируйте приложение';
        a.state = null;
        a.pkg = null;
        break;
      default:
        return 'Неизвестное действие';
    }
    syncGuests(dev);
    dev.note('IOx: приложение ' + id + ' — ' + (a.state || 'удалено'), null, 'info');
    dev.net.emit('config', { dev });
    return null;
  }

  function ioxInstall(dev, id, pkgName) {
    const c = cfg(dev);
    if (!c.enabled) return 'IOx не включён: выполните iox в режиме конфигурации';
    const name = String(pkgName || '').replace(/^(flash|bootflash):/i, '').replace(/\.tar$/i, '');
    const pkg = c.pkgs[name];
    if (!pkg) return 'Пакет ' + pkgName + ' не найден во flash: (загрузите его из IoX IDE)';
    const a = appCfg(dev, id);
    if (a.state && a.state !== 'DEPLOYED') return 'Приложение ' + id + ' уже установлено и активно';
    a.pkg = name;
    a.state = 'DEPLOYED';
    dev.note('IOx: пакет ' + name + ' установлен как приложение ' + id, null, 'info');
    dev.net.emit('config', { dev });
    return null;
  }

  /** Гостевые адреса запущенных приложений — локальные адреса маршрутизатора, порты приложений слушают. */
  function syncGuests(dev) {
    const c = cfg(dev);
    dev.ifaces = dev.ifaces.filter((f) => f.kind !== 'ioxguest');
    const ports = new Set();
    for (const [id, a] of Object.entries(c.apps)) {
      if (a.state !== 'RUNNING' || !c.enabled || activateProblem(dev, id)) continue;
      const pkg = c.pkgs[a.pkg];
      if (!pkg) continue;
      const f = dev.addIface(-1, 'IOx:' + id, null, 'ioxguest');
      Object.assign(f, { ip: a.guestIp, mask: 0xFFFFFFFF, runtime: true, appid: id });
      ports.add(pkg.port);
    }
    if (dev.tcp) {
      for (const [port, fn] of [...dev.tcp.listeners]) if (fn.ioxApp && !ports.has(port)) dev.tcp.unlisten(port);
      for (const port of ports) {
        const accept = (conn) => serveApp(dev, conn, port);
        accept.ioxApp = true;
        dev.tcp.listen(port, accept);
      }
    }
    dev.net.markRouting();
  }

  function serveApp(dev, conn, port) {
    const c = cfg(dev);
    const f = dev.ifaces.find((x) => x.kind === 'ioxguest' && x.ip === conn.lip);
    const a = f && c.apps[f.appid];
    const pkg = a && c.pkgs[a.pkg];
    if (!pkg || pkg.port !== port) { conn.abort('Порт ' + port + ' на ' + U.ipStr(conn.lip) + ' закрыт'); return; }
    conn.h.onData = (d) => {
      if (!d || d.http !== 'GET') return;
      let path = String(d.path || '/').replace(/^\/+/, '').toLowerCase();
      if (!path) path = 'index.html';
      const body = pkg.files[path];
      if (body != null) conn.send({ http: 'RESP', status: 200, reason: 'OK', path, body, server: 'IOx app ' + f.appid });
      else conn.send({ http: 'RESP', status: 404, reason: 'Not Found', path, body: '<html><h2>404</h2><p>В приложении ' + f.appid + ' нет файла «' + path.replace(/[<>&"]/g, '') + '».</html>' });
      conn.close();
    };
  }

  /* ================= IOx Local Manager (для IoX IDE) ================= */

  function lmServe(dev, conn) {
    conn.h.onData = (d) => {
      if (!d || !d.ioxm) return;
      const reply = (x) => { conn.send(Object.assign({ ioxm: 'RESULT' }, x)); conn.close(); };
      const c = cfg(dev);
      if (!c.enabled) { reply({ ok: false, error: 'IOx не включён на ' + (dev.ios ? dev.ios.hostname : dev.name) + ' (команда iox)' }); return; }
      const u = dev.ios.users.find((x) => x.name === d.user);
      if (!u || !dev.checkUser(d.user, d.pass)) { reply({ ok: false, error: 'Неверное имя пользователя или пароль' }); return; }
      if ((u.priv || 1) < 15) { reply({ ok: false, error: 'Нужен пользователь с privilege 15 (username ' + u.name + ' privilege 15 …)' }); return; }
      if (d.ioxm === 'LIST') {
        reply({ ok: true, apps: Object.entries(c.apps).map(([id, a]) => ({ id, state: a.state, pkg: a.pkg, guestIp: a.guestIp != null ? U.ipStr(a.guestIp) : null, port: a.pkg && c.pkgs[a.pkg] ? c.pkgs[a.pkg].port : null })), pkgs: Object.keys(c.pkgs) });
        return;
      }
      if (d.ioxm === 'DEPLOY') {
        const id = String(d.appid || '');
        if (!/^[A-Za-z][\w-]{0,31}$/.test(id)) { reply({ ok: false, error: 'Имя приложения: латиница, цифры, «-», «_», начинается с буквы' }); return; }
        let pkg;
        try { pkg = normPackage(id, d.manifest, d.files); } catch (e) { reply({ ok: false, error: e.message }); return; }
        const a = c.apps[id];
        if (a && a.state && a.state !== 'DEPLOYED') { reply({ ok: false, error: 'Приложение ' + id + ' активно — остановите и деактивируйте его перед обновлением' }); return; }
        c.pkgs[id] = pkg;
        const err = ioxInstall(dev, id, id);
        reply(err ? { ok: false, error: err } : { ok: true });
        return;
      }
      if (d.ioxm === 'NETWORK') {
        const a = appCfg(dev, String(d.appid));
        const vpg = dev.ifaces.find((f) => f.kind === 'vpg' && f.ip != null);
        if (!vpg) { reply({ ok: false, error: 'На маршрутизаторе нет interface VirtualPortGroup0 с IP-адресом' }); return; }
        const ip = U.parseIp(String(d.guestIp || ''));
        if (ip == null || !U.sameNet(ip, vpg.ip, vpg.mask) || ip === vpg.ip) { reply({ ok: false, error: 'Гостевой адрес должен быть в сети ' + U.cidr(U.net(vpg.ip, vpg.mask), vpg.mask) }); return; }
        Object.assign(a, { vnic: vpg.name, guestIp: ip, mask: vpg.mask, gw: vpg.ip });
        dev.net.emit('config', { dev });
        reply({ ok: true });
        return;
      }
      if (d.ioxm === 'ACTION') {
        const err = ioxAction(dev, String(d.appid), String(d.action));
        reply(err ? { ok: false, error: err } : { ok: true });
        return;
      }
      reply({ ok: false, error: 'Неизвестный запрос' });
    };
  }

  IpNode.hooks.bind.push(function () {
    if (this.type !== 'router' || !this.tcp) return;
    this.tcp.listen(LM_PORT, (conn) => lmServe(this, conn));
    if (this.iox) syncGuests(this);
  });
  IpNode.hooks.runtime.push(function () {
    if (this.iox) {
      if (this.ifaces) this.ifaces = this.ifaces.filter((f) => f.kind !== 'ioxguest');
      // после перезагрузки запускаются только приложения с командой start
      for (const a of Object.values(this.iox.apps)) if (a.state === 'RUNNING' && !a.start) a.state = 'ACTIVATED';
    }
  });

  /** Клиент IoX IDE: один запрос к IOx Local Manager. cb({ok, error, …}). */
  IpNode.prototype.ioxRequest = function (host, user, pass, msg, cb) {
    return this.tcpRequest(host, LM_PORT, Object.assign({ user, pass }, msg), (d) => d && d.ioxm === 'RESULT', (r) => {
      if (!r.ok) { cb({ ok: false, error: r.code === 'refused' ? 'Маршрутизатор не отвечает на порту ' + LM_PORT + ' (IOx Local Manager)' : r.error }); return; }
      cb(r.data);
    });
  };

  /* ================= сохранение ================= */

  NS.deviceExt.push({
    key: 'iox',
    applies: (d) => d.type === 'router',
    save(d) {
      const c = d.iox;
      if (!c || (!c.enabled && !Object.keys(c.apps).length && !Object.keys(c.pkgs).length)) return null;
      const ip = (v) => (v == null ? null : U.ipStr(v));
      return {
        enabled: !!c.enabled,
        apps: Object.fromEntries(Object.entries(c.apps).map(([k, a]) => [k, { vnic: a.vnic, guestIp: ip(a.guestIp), mask: ip(a.mask), gw: ip(a.gw), start: !!a.start, state: a.state || null, pkg: a.pkg || null }])),
        pkgs: JSON.parse(JSON.stringify(c.pkgs)),
      };
    },
    load(d, c) {
      d.iox = null;
      if (!c) return;
      const ip = (v) => (v ? U.parseIp(v) : null);
      d.iox = { enabled: !!c.enabled, apps: {}, pkgs: {} };
      for (const [k, p] of Object.entries(c.pkgs || {})) { try { d.iox.pkgs[k] = normPackage(k, p, p.files); } catch (e) { /* пропускаем */ } }
      for (const [k, a] of Object.entries(c.apps || {})) {
        const state = STATES.includes(a.state) ? a.state : null;
        d.iox.apps[k] = { vnic: a.vnic || null, guestIp: ip(a.guestIp), mask: ip(a.mask), gw: ip(a.gw), start: !!a.start, state: state === 'RUNNING' && !a.start ? 'ACTIVATED' : state, pkg: a.pkg && d.iox.pkgs[a.pkg] ? a.pkg : null };
        if (!d.iox.apps[k].pkg) d.iox.apps[k].state = null;
      }
      if (d.tcp) syncGuests(d);
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;

  X.ifNames.push((dev, t) => {
    if (dev.type !== 'router') return null;
    const m = /^(?:virtualp[a-z]*|vpg)(\d+)$/i.exec(t);
    if (!m) return null;
    const name = 'VirtualPortGroup' + Number(m[1]);
    return { kind: 'named', name, create: (d) => d.addVpg(Number(m[1])), remove: (d) => { const f = d.ifaceByName(name); if (f) d.removeIface(f); } };
  });

  X.global.push((t) => /^(iox|app-hosting)$/i.test(t[0] || ''));

  X.modes.apphost = {
    prompt: () => '(config-app-hosting)#',
    tree: ['app-vnic gateway0 virtualportgroup 0 guest-interface 0', 'guest-ipaddress A.B.C.D netmask A.B.C.D', 'app-default-gateway A.B.C.D guest-interface 0', 'start'],
    run(dev, s, t, io, C) {
      const a = appCfg(dev, s.ctx);
      const neg = C.kw(t[0], 'no', 2);
      const w = neg ? t.slice(1) : t;
      if (C.kw(w[0], 'app-vnic', 5)) {
        if (neg) { C.withMutate(io, () => { a.vnic = null; }); return; }
        const vi = w.findIndex((x) => C.kw(x, 'virtualportgroup', 2));
        const n = vi > 0 ? Number(w[vi + 1]) : NaN;
        if (!Number.isInteger(n)) { C.incomplete(io); return; }
        C.withMutate(io, () => { a.vnic = 'VirtualPortGroup' + n; });
        const gi = w.findIndex((x) => C.kw(x, 'guest-ipaddress', 7));
        if (gi > 0) setGuest(w.slice(gi));
        return;
      }
      if (C.kw(w[0], 'guest-ipaddress', 7)) { if (neg) { C.withMutate(io, () => { a.guestIp = null; }); return; } setGuest(w); return; }
      if (C.kw(w[0], 'app-default-gateway', 5)) {
        const g = U.parseIp(w[1] || '');
        if (!neg && g == null) { C.incomplete(io); return; }
        C.withMutate(io, () => { a.gw = neg ? null : g; });
        return;
      }
      if (C.kw(w[0], 'start', 3)) {
        C.withMutate(io, () => { a.start = !neg; });
        if (!neg) { const e = a.state === 'RUNNING' ? null : ioxAction(dev, s.ctx, 'start'); if (e) io.out('% ' + e); }
        else if (a.state === 'RUNNING') ioxAction(dev, s.ctx, 'stop');
        return;
      }
      if (C.kw(w[0], 'app-resource', 5) || C.kw(w[0], 'name-server', 4) || C.kw(w[0], 'exit', 2)) return;
      C.invalid(io, w[0]);

      function setGuest(x) {
        const ipv = U.parseIp(x[1] || '');
        const ni = x.findIndex((y) => C.kw(y, 'netmask', 3));
        const mask = ni > 0 ? U.parseMask(x[ni + 1] || '') : null;
        if (ipv == null || mask == null) { C.incomplete(io); return; }
        C.withMutate(io, () => { a.guestIp = ipv; a.mask = mask; });
      }
    },
  };

  X.config.push((dev, s, a, neg, io, C) => {
    if (dev.type !== 'router') return false;
    if (C.kw(a[0], 'iox', 3) && a.length === 1) {
      const c = cfg(dev);
      C.withMutate(io, () => { c.enabled = !neg; });
      if (!neg) io.out('IOx service (CAF) is running\nIOx service (HA) is running\nIOx service (IOxman) is running\nIOx service (Sec storage) is running\nIOx service (Libvirtd) is running');
      else io.out('IOx services are stopped');
      syncGuests(dev);
      dev.net.markRouting();
      return true;
    }
    if (C.kw(a[0], 'app-hosting', 5) && C.kw(a[1], 'appid', 2)) {
      const id = a[2];
      if (!id || !/^[A-Za-z][\w-]{0,31}$/.test(id)) { C.incomplete(io); return true; }
      if (neg) {
        const c = cfg(dev);
        const x = c.apps[id];
        if (x && x.state) { io.out('% Приложение ' + id + ' установлено — сначала app-hosting uninstall appid ' + id); return true; }
        C.withMutate(io, () => { delete c.apps[id]; });
        return true;
      }
      C.withMutate(io, () => appCfg(dev, id));
      s.mode = 'apphost';
      s.ctx = id;
      return true;
    }
    return false;
  });

  X.exec.push((dev, s, t, io, line, C) => {
    if (s.mode !== 'exec' || !C.kw(t[0], 'app-hosting', 5)) return null;
    const act = (t[1] || '').toLowerCase();
    const ai = t.findIndex((x) => C.kw(x, 'appid', 2));
    const id = ai > 0 ? t[ai + 1] : null;
    if (!id) { C.incomplete(io); return { handled: true }; }
    let err;
    if (C.kw(act, 'install', 3)) {
      const pi = t.findIndex((x) => C.kw(x, 'package', 1));
      err = ioxInstall(dev, id, pi > 0 ? t[pi + 1] : '');
      if (!err) io.out('Installing package \'' + t[pi + 1] + '\' for \'' + id + '\'. Use \'show app-hosting list\' for progress.');
    } else if (['activate', 'start', 'stop', 'deactivate', 'uninstall'].some((x) => C.kw(act, x, 3))) {
      const a = ['activate', 'start', 'stop', 'deactivate', 'uninstall'].find((x) => C.kw(act, x, 3));
      err = ioxAction(dev, id, a);
      if (!err) io.out('' + id + ' ' + { activate: 'activated', start: 'started', stop: 'stopped', deactivate: 'deactivated', uninstall: 'uninstalled' }[a] + ' successfully');
      if (!err) io.out('Current state is: ' + (cfg(dev).apps[id] && cfg(dev).apps[id].state || 'UNINSTALLED'));
    } else { C.invalid(io, t[1]); return { handled: true }; }
    if (err) io.out('% ' + err);
    return { handled: true };
  });

  X.show.push((dev, s, a, io, C) => {
    if (dev.type !== 'router') return false;
    const c = cfg(dev);
    if (C.kw(a[0], 'iox-service', 3)) {
      const on = c.enabled ? 'Running' : 'Not Running';
      io.out('IOx Infrastructure Summary:');
      io.out('---------------------------');
      for (const x of ['IOx service (CAF)', 'IOx service (HA)', 'IOx service (IOxman)', 'IOx service (Sec storage)', 'Libvirtd']) io.out(C.pad(x, 28) + ': ' + on);
      io.out('IOx Local Manager (порт ' + LM_PORT + ') : ' + on);
      return true;
    }
    if (C.kw(a[0], 'app-hosting', 5)) {
      if (C.kw(a[1], 'detail', 2)) {
        const ai = a.findIndex((x) => C.kw(x, 'appid', 2));
        const list = ai > 0 ? [a[ai + 1]] : Object.keys(c.apps);
        for (const id of list) {
          const x = c.apps[id];
          if (!x) { io.out('% Приложение ' + id + ' не найдено'); continue; }
          const pkg = x.pkg && c.pkgs[x.pkg];
          io.out('App id                 : ' + id);
          io.out('Owner                  : iox');
          io.out('State                  : ' + (x.state || 'UNINSTALLED'));
          io.out('Application');
          io.out('  Type                 : docker');
          io.out('  Name                 : ' + (pkg ? pkg.name : '-'));
          io.out('  Version              : ' + (pkg ? pkg.version : '-'));
          io.out('  Description          : ' + (pkg ? pkg.description : ''));
          io.out('Network interfaces');
          io.out('   eth0: ' + (x.vnic || 'не задан') + ', IPv4 address: ' + (x.guestIp != null ? U.ipStr(x.guestIp) : '-') + ', порт приложения ' + (pkg ? pkg.port : '-'));
          const why = x.state ? activateProblem(dev, id) : null;
          if (why) io.out('Проблема: ' + why);
          io.out('');
        }
        return true;
      }
      io.out('App id                                   State');
      io.out('---------------------------------------------------------');
      for (const [id, x] of Object.entries(c.apps)) if (x.state) io.out(C.pad(id, 41) + x.state);
      return true;
    }
    return false;
  });

  X.running.global.push((dev) => {
    const c = dev.iox;
    if (!c) return [];
    const L = [];
    for (const [id, a] of Object.entries(c.apps)) {
      L.push('app-hosting appid ' + id);
      if (a.vnic) L.push(' app-vnic gateway0 virtualportgroup ' + a.vnic.replace(/\D+/g, '') + ' guest-interface 0');
      if (a.guestIp != null) L.push('  guest-ipaddress ' + U.ipStr(a.guestIp) + ' netmask ' + U.ipStr(a.mask));
      if (a.gw != null) L.push(' app-default-gateway ' + U.ipStr(a.gw) + ' guest-interface 0');
      if (a.start) L.push(' start');
      L.push('!');
    }
    return L;
  });
  X.running.tail.push((dev) => (dev.iox && dev.iox.enabled ? ['iox', '!'] : []));

  X.tree.config = (X.tree.config || []).concat(['iox', 'app-hosting appid WORD', 'interface virtualportgroup WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['app-hosting install appid WORD package WORD', 'app-hosting activate appid WORD', 'app-hosting start appid WORD', 'app-hosting stop appid WORD',
    'app-hosting deactivate appid WORD', 'app-hosting uninstall appid WORD', 'show iox-service', 'show app-hosting list', 'show app-hosting detail']);

  /* ================= описание пакетов ================= */

  const lmOf = (f) => {
    if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'TCP') return null;
    const s = f.payload.payload;
    return s && (s.sport === LM_PORT || s.dport === LM_PORT) && s.data && s.data.ioxm ? s.data : null;
  };
  const LM_TEXT = { LIST: 'список приложений', DEPLOY: 'загрузка пакета', NETWORK: 'сетевые настройки приложения', ACTION: 'управление приложением', RESULT: 'ответ' };
  P.register({
    protocols: { IOX: { label: 'IOx Local Manager', color: '#0f766e' } },
    classify: (f) => (lmOf(f) ? 'IOX' : null),
    summary(f) {
      const d = lmOf(f);
      if (!d) return null;
      return 'IOx LM (HTTPS ' + LM_PORT + '): ' + (LM_TEXT[d.ioxm] || d.ioxm) + (d.appid ? ' ' + d.appid : '') + (d.action ? ' — ' + d.action : '') + (d.ioxm === 'RESULT' ? (d.ok ? ' — успешно' : ' — ошибка: ' + d.error) : '') + ', ' + U.ipStr(f.payload.src) + ' → ' + U.ipStr(f.payload.dst);
    },
    extraLayers(f, out) {
      const d = lmOf(f);
      if (!d) return;
      const fields = [['Запрос', LM_TEXT[d.ioxm] || d.ioxm]];
      if (d.user) fields.push(['Пользователь', d.user], ['Пароль', '•••• (в HTTPS зашифрован)']);
      if (d.appid) fields.push(['Приложение', d.appid]);
      if (d.files) fields.push(['Файлы пакета', Object.keys(d.files).join(', ')]);
      out.push({ title: 'IOx Local Manager (REST поверх HTTPS)', fields });
    },
  });

  NS.iox = { LM_PORT, parseYaml, normPackage, action: ioxAction, install: ioxInstall, problem: activateProblem, cfg };
})(globalThis.NetLab = globalThis.NetLab || {});
