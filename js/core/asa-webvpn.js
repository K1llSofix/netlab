/* NetLab — WebVPN (clientless SSL VPN) на Cisco ASA.
 *  Портал на HTTPS (443) интерфейсов из «webvpn → enable ИМЯ»: вход по username/password ASA, закладки из url-list
 *  групповой политики, доступ к внутренним веб-серверам через ASA (ASA сам запрашивает страницу и переписывает ссылки).
 *  CLI: webvpn → enable outside; url-list СПИСОК "Название" URL; group-policy ИМЯ internal / attributes →
 *  vpn-tunnel-protocol ssl-clientless, banner value …, webvpn → url-list value СПИСОК; username … attributes → vpn-group-policy;
 *  tunnel-group DefaultWEBVPNGroup general-attributes → default-group-policy; show vpn-sessiondb webvpn. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const AX = NS.asaExt;
  const C = NS.cliIos.ctx;
  const kw = C.kw;
  const IpNode = NS.IpNode;
  const ip = (x) => U.ipStr(x);
  const mut = (io, fn) => C.withMutate(io, fn);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nameIf = (dev, n) => dev.ifaces.find((f) => f.nameif && f.nameif.toLowerCase() === String(n || '').toLowerCase()) || null;

  const DEFAULT_TG = 'DefaultWEBVPNGroup';
  const DEFAULT_GP = 'DfltGrpPolicy';

  const wcfg = (dev) => dev.webvpn || (dev.webvpn = { ifs: [], lists: {}, gps: {}, userGp: {}, tgs: {} });
  const emptyCfg = (w) => !w || (!w.ifs.length && !Object.keys(w.lists).length && !Object.keys(w.gps).length && !Object.keys(w.userGp).length && !Object.keys(w.tgs).length);
  const rt = (dev) => dev.webvpnRt || (dev.webvpnRt = { sessions: new Map(), next: 1 });
  const newGp = () => ({ protocols: null, urlList: null, banner: null });

  /** Групповая политика пользователя: своя (vpn-group-policy) → DefaultWEBVPNGroup → DfltGrpPolicy. */
  function policyOf(dev, user) {
    const w = wcfg(dev);
    const tg = w.tgs[DEFAULT_TG];
    const name = w.userGp[user] || (tg && tg.gp) || DEFAULT_GP;
    return { name, gp: w.gps[name] || newGp() };
  }

  function log(dev, sev, id, text) { if (dev.iosLog) dev.iosLog('ASA', sev, String(id), text); }

  /* ================= страницы портала ================= */

  const page = (title, body) => '<html><head><title>' + esc(title) + '</title></head><body>' + body + '</body></html>';

  /** URL внутреннего ресурса → путь на ASA: /+CSCO+/http/10.0.3.10/index.html */
  function proxyPath(url) {
    const u = IpNode.parseUrl(String(url || '').trim());
    if (!u) return null;
    const def = u.https ? 443 : 80;
    return '/+CSCO+/' + (u.https ? 'https' : 'http') + '/' + u.host + (u.port && u.port !== def ? ':' + u.port : '') + u.path;
  }

  function loginPage(dev, msg) {
    return page('SSL VPN Service', '<h2>SSL VPN Service</h2>' +
      (msg ? '<p><font color="#dc2626"><b>' + esc(msg) + '</b></font></p>' : '<p>Войдите, чтобы получить доступ к ресурсам внутренней сети.</p>') +
      '<form action="/+webvpn+/index.html" method="post"><table>' +
      '<tr><td>USERNAME:</td><td><input name="username"></td></tr>' +
      '<tr><td>PASSWORD:</td><td><input type="password" name="password"></td></tr></table>' +
      '<p><input type="submit" value="Login"></p></form><hr><p><small>' + esc(dev.ios.hostname) + ' · Cisco Adaptive Security Appliance</small></p>');
  }

  function portalPage(dev, s, msg) {
    const { gp } = policyOf(dev, s.user);
    const bm = (gp.urlList && wcfg(dev).lists[gp.urlList]) || [];
    return page('SSL VPN Service', '<h2>SSL VPN Service</h2>' +
      '<p>Пользователь: <b>' + esc(s.user) + '</b> · <a href="/+webvpn+/webvpn_logout.html">Logout</a></p>' +
      (gp.banner ? '<blockquote>' + esc(gp.banner) + '</blockquote>' : '') +
      (msg ? '<p><font color="#dc2626">' + esc(msg) + '</font></p>' : '') +
      '<form action="/+webvpn+/go" method="post"><p>Address: <input name="url" value="http://"> <input type="submit" value="Browse"></p></form>' +
      '<h3>Web Bookmarks</h3>' + (bm.length ? '<ul>' + bm.map((b) => '<li><a href="' + esc(proxyPath(b.url)) + '">' + esc(b.name) + '</a> <small>' + esc(b.url) + '</small></li>').join('') + '</ul>' : '<p><i>Закладок нет — url-list в групповой политике не назначен.</i></p>'));
  }

  /** Ссылки и формы внутренней страницы → через портал ASA. */
  function rewrite(html, base) {
    const scheme = base.https ? 'https://' : 'http://';
    const host = base.host + (base.port && base.port !== (base.https ? 443 : 80) ? ':' + base.port : '');
    const map = (href) => {
      const t = String(href).trim();
      if (/^https?:\/\//i.test(t)) return proxyPath(t) || t;
      if (/^[a-z]+:/i.test(t) || t.startsWith('#')) return t;
      return proxyPath(scheme + host + '/' + t.replace(/^\/+/, '')) || t;
    };
    return String(html).replace(/\b(href|action)\s*=\s*(["'])(.*?)\2/gi, (m, attr, q, v) => attr + '="' + esc(map(v.replace(/&amp;/g, '&'))) + '"');
  }

  function framed(dev, s, url, inner, title) {
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(inner);
    return page(title || 'SSL VPN Service', '<div><b>Cisco SSL VPN</b> · <a href="/+webvpn+/portal.html">Home</a> · <a href="/+webvpn+/webvpn_logout.html">Logout</a> · <small>' + esc(url) + '</small></div><hr>' +
      (body ? body[1] : inner.replace(/<\/?(html|head)[^>]*>/gi, '').replace(/<title>[\s\S]*?<\/title>/i, '')));
  }

  function proxy(dev, s, url, reply) {
    const u = IpNode.parseUrl(url);
    if (!u) { reply(portalPage(dev, s, 'Неверный адрес: ' + url)); return; }
    dev.httpGet(url, (r) => {
      if (!r.ok) { reply(framed(dev, s, url, '<h3>Ресурс недоступен</h3><p>ASA не смог получить страницу: ' + esc(r.error) + '</p>')); return; }
      s.bytesTx += r.body.length;
      const title = (/<title>([\s\S]*?)<\/title>/i.exec(r.body) || [])[1];
      reply(framed(dev, s, url, rewrite(r.body, u), title ? title.trim() : null), r.status, r.reason);
    }, { insecure: true });
  }

  function handle(dev, f, conn, d, send) {
    const R = rt(dev);
    const path = String(d.path || '/').split('?')[0];
    const form = d.form || {};
    const tok = (/(?:^|;\s*)webvpn=(\w+)/.exec(d.cookie || '') || [])[1];
    const s = tok ? R.sessions.get(tok) : null;
    const reply = (body, status, reason, extra) => send(Object.assign({ status: status || 200, reason: reason || 'OK', body }, extra || {}));
    if (s) s.bytesRx += JSON.stringify(d).length;
    if (path === '/+webvpn+/index.html' && d.http === 'POST' && form.username != null) {
      const user = String(form.username || '').trim();
      const addr = ip(conn.rip);
      if (!user || !dev.checkUser(user, String(form.password || ''))) {
        log(dev, 6, 113015, 'AAA user authentication Rejected : reason = Invalid password : local database : user = ' + (user || '*****') + ' : user IP = ' + addr);
        reply(loginPage(dev, 'Login failed.'));
        return;
      }
      const { name, gp } = policyOf(dev, user);
      if (gp.protocols && !gp.protocols.includes('ssl-clientless')) {
        log(dev, 6, 716007, 'Group <' + name + '> User <' + user + '> IP <' + addr + '> WebVPN Unable to create session: vpn-tunnel-protocol не разрешает ssl-clientless');
        reply(loginPage(dev, 'Clientless (browser) SSL VPN access is not allowed.'));
        return;
      }
      const t = (dev.net.counters.xid++).toString(16) + Math.floor(dev.net.time).toString(16) + R.next;
      const sess = { user, gp: name, ip: conn.rip, iface: f.nameif, since: dev.net.time, index: R.next++, bytesTx: 0, bytesRx: 0 };
      R.sessions.set(t, sess);
      log(dev, 6, 113012, 'AAA user authentication Successful : local database : user = ' + user);
      log(dev, 6, 716001, 'Group <' + name + '> User <' + user + '> IP <' + addr + '> WebVPN session started.');
      dev.net.emit('config', { dev });
      reply(portalPage(dev, sess), 200, 'OK', { setCookie: 'webvpn=' + t });
      return;
    }
    if (!s) { reply(loginPage(dev)); return; }
    if (path.startsWith('/+webvpn+/webvpn_logout')) {
      R.sessions.delete(tok);
      log(dev, 4, 716002, 'Group <' + s.gp + '> User <' + s.user + '> IP <' + ip(s.ip) + '> WebVPN session terminated: User Requested.');
      dev.net.emit('config', { dev });
      reply(page('SSL VPN Service', '<h2>Logout</h2><p>Сеанс WebVPN завершён. <a href="/">Войти снова</a></p>'), 200, 'OK', { setCookie: '' });
      return;
    }
    if (path === '/+webvpn+/go' && form.url != null) {
      const pp = proxyPath(form.url);
      if (!pp || /^https?:\/\/?$/i.test(String(form.url).trim())) { reply(portalPage(dev, s, 'Введите адрес, например http://10.0.3.10')); return; }
      proxy(dev, s, String(form.url).trim().replace(/^(?!https?:\/\/)/i, 'http://'), reply);
      return;
    }
    const m = /^\/\+CSCO\+\/(https?)\/([^/]+)(\/.*)?$/i.exec(path);
    if (m) { proxy(dev, s, m[1].toLowerCase() + '://' + m[2] + (m[3] || '/'), reply); return; }
    reply(portalPage(dev, s));
  }

  function bindWeb(dev) {
    if (!dev.tcp) return;
    const cur = dev.tcp.listeners.get(443);
    if (cur && cur.asaWeb) dev.tcp.unlisten(443);
    const w = dev.webvpn;
    if (!w || !w.ifs.length) return;
    const accept = (conn) => {
      conn.h.onData = (d) => {
        if (!d || !d.http) return;
        const f = dev.ifaces.find((x) => x.ip != null && x.ip === conn.lip);
        if (!f || !f.nameif || !wcfg(dev).ifs.includes(f.nameif.toLowerCase())) { conn.close(); return; }
        let sent = false;
        handle(dev, f, conn, d, (r) => {
          if (sent) return;
          sent = true;
          conn.send(Object.assign({ http: 'RESP', path: d.path, server: 'Cisco ASA WebVPN' }, r));
          conn.close();
        });
      };
    };
    accept.asaWeb = true;
    dev.tcp.listen(443, NS.tls ? NS.tls.server(dev, accept) : accept);
  }
  IpNode.hooks.bind.push(function () { if (this.type === 'asa') bindWeb(this); });
  IpNode.hooks.runtime.push(function () { if (this.type === 'asa') this.webvpnRt = null; });

  /* ================= CLI ================= */

  AX.config.unshift((dev, s, t, neg, io) => {
    const a = neg ? t.slice(1) : t;
    const w = a[0];
    const W = wcfg(dev);
    if (kw(w, 'webvpn', 3) && !a[1]) {
      if (neg) { mut(io, () => { W.ifs = []; }); bindWeb(dev); return true; }
      s.mode = 'webvpn';
      return true;
    }
    if (kw(w, 'url-list', 5)) {
      const name = a[1];
      if (!name) { C.incomplete(io); return true; }
      if (neg && a.length === 2) { mut(io, () => { delete W.lists[name]; }); return true; }
      const url = a[a.length - 1];
      const title = a.slice(2, -1).join(' ').replace(/^"|"$/g, '');
      if (!title || !IpNode.parseUrl(url) || !/^https?:\/\//i.test(url)) { io.out('ERROR: формат: url-list ИМЯ "Название" http://адрес'); return true; }
      mut(io, () => {
        const l = W.lists[name] || (W.lists[name] = []);
        const i = l.findIndex((x) => x.name === title);
        if (neg) { if (i >= 0) l.splice(i, 1); if (!l.length) delete W.lists[name]; } else if (i >= 0) l[i].url = url; else l.push({ name: title, url });
      });
      return true;
    }
    if (kw(w, 'group-policy', 3)) {
      const name = a[1];
      if (!name) { C.incomplete(io); return true; }
      if (kw(a[2], 'internal', 3)) {
        mut(io, () => { if (neg) delete W.gps[name]; else if (!W.gps[name]) W.gps[name] = newGp(); });
        return true;
      }
      if (kw(a[2], 'attributes', 3)) {
        if (!W.gps[name] && name !== DEFAULT_GP) { io.out('ERROR: Group policy ' + name + ' does not exist — сначала group-policy ' + name + ' internal'); return true; }
        if (!W.gps[name]) mut(io, () => { W.gps[name] = newGp(); });
        s.mode = 'gp-attr';
        s.ctx = name;
        return true;
      }
      C.invalid(io, a[2] || '');
      return true;
    }
    if (kw(w, 'username', 3) && a[1] && kw(a[2], 'attributes', 3)) {
      if (!dev.ios.users.some((u) => u.name === a[1])) { io.out('ERROR: User ' + a[1] + ' does not exist — сначала username ' + a[1] + ' password …'); return true; }
      s.mode = 'user-attr';
      s.ctx = a[1];
      return true;
    }
    if (kw(w, 'tunnel-group', 3) && a[1] && U.parseIp(a[1]) == null) {
      const name = a[1];
      if (kw(a[2], 'type', 1)) {
        if (neg) { mut(io, () => { delete W.tgs[name]; }); return true; }
        if (!kw(a[3], 'remote-access', 3)) { io.out('ERROR: % tunnel-group с именем (не адресом) — тип remote-access'); return true; }
        mut(io, () => { if (!W.tgs[name]) W.tgs[name] = { gp: null }; });
        return true;
      }
      if (kw(a[2], 'general-attributes', 3) || kw(a[2], 'webvpn-attributes', 3)) {
        if (!W.tgs[name] && name !== DEFAULT_TG) { io.out('ERROR: tunnel-group ' + name + ' not found — сначала tunnel-group ' + name + ' type remote-access'); return true; }
        if (!W.tgs[name]) mut(io, () => { W.tgs[name] = { gp: null }; });
        s.mode = kw(a[2], 'general-attributes', 3) ? 'tg-general' : 'tg-webvpn';
        s.ctx = name;
        return true;
      }
    }
    return false;
  });

  AX.modes.webvpn = {
    prompt: '(config-webvpn)#',
    run(dev, s, t, io) {
      const neg = kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (kw(a[0], 'enable', 2)) {
        const f = nameIf(dev, a[1]);
        if (!f) { io.out('ERROR: % Interface name ' + (a[1] || '') + ' not found'); return true; }
        const n = f.nameif.toLowerCase();
        mut(io, () => { const W = wcfg(dev); W.ifs = W.ifs.filter((x) => x !== n); if (!neg) W.ifs.push(n); });
        bindWeb(dev);
        if (!neg) io.out('INFO: WebVPN and DTLS are enabled on \'' + f.nameif + '\'.');
        return true;
      }
      if (kw(a[0], 'anyconnect', 3) || kw(a[0], 'tunnel-group-list', 3) || kw(a[0], 'csd', 3) || kw(a[0], 'cache', 3)) return true;
      return false;
    },
  };

  AX.modes['gp-attr'] = {
    prompt: '(config-group-policy)#',
    run(dev, s, t, io) {
      const gp = wcfg(dev).gps[s.ctx];
      if (!gp) return false;
      const neg = kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (kw(a[0], 'vpn-tunnel-protocol', 5)) {
        const ok = ['ikev1', 'ikev2', 'l2tp-ipsec', 'ssl-client', 'ssl-clientless'];
        const list = a.slice(1).map((x) => x.toLowerCase());
        if (!neg && (!list.length || list.some((x) => !ok.includes(x)))) { io.out('ERROR: vpn-tunnel-protocol: ' + ok.join(' | ')); return true; }
        mut(io, () => { gp.protocols = neg ? null : list; });
        return true;
      }
      if (kw(a[0], 'banner', 3)) {
        mut(io, () => { gp.banner = neg || kw(a[1], 'none', 2) ? null : a.slice(kw(a[1], 'value', 2) ? 2 : 1).join(' ') || null; });
        return true;
      }
      if (kw(a[0], 'webvpn', 3)) { s.mode = 'gp-webvpn'; return true; }
      if (kw(a[0], 'dns-server', 3) || kw(a[0], 'split-tunnel-policy', 7) || kw(a[0], 'vpn-idle-timeout', 5) || kw(a[0], 'vpn-session-timeout', 5)) return true;
      return false;
    },
  };

  AX.modes['gp-webvpn'] = {
    prompt: '(config-group-webvpn)#',
    run(dev, s, t, io) {
      const gp = wcfg(dev).gps[s.ctx];
      if (!gp) return false;
      const neg = kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (kw(a[0], 'url-list', 5)) {
        if (neg || kw(a[1], 'none', 2)) { mut(io, () => { gp.urlList = null; }); return true; }
        if (!kw(a[1], 'value', 2) || !a[2]) { C.incomplete(io); return true; }
        if (!wcfg(dev).lists[a[2]]) io.out('WARNING: url-list ' + a[2] + ' не существует — закладок не будет');
        mut(io, () => { gp.urlList = a[2]; });
        return true;
      }
      if (kw(a[0], 'anyconnect', 3) || kw(a[0], 'file-browsing', 4) || kw(a[0], 'url-entry', 5)) return true;
      if (kw(a[0], 'exit', 3)) { s.mode = 'gp-attr'; return true; }
      return false;
    },
  };

  AX.modes['user-attr'] = {
    prompt: '(config-username)#',
    run(dev, s, t, io) {
      const neg = kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      const W = wcfg(dev);
      if (kw(a[0], 'vpn-group-policy', 5)) {
        if (!neg && !a[1]) { C.incomplete(io); return true; }
        if (!neg && !W.gps[a[1]] && a[1] !== DEFAULT_GP) { io.out('ERROR: Group policy ' + a[1] + ' does not exist'); return true; }
        mut(io, () => { if (neg) delete W.userGp[s.ctx]; else W.userGp[s.ctx] = a[1]; });
        return true;
      }
      if (kw(a[0], 'service-type', 3) || kw(a[0], 'vpn-tunnel-protocol', 5)) return true;
      return false;
    },
  };

  const tgMode = (prompt) => ({
    prompt,
    run(dev, s, t, io) {
      const tg = wcfg(dev).tgs[s.ctx];
      if (!tg) return false;
      const neg = kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (kw(a[0], 'default-group-policy', 3)) {
        if (!neg && !wcfg(dev).gps[a[1]] && a[1] !== DEFAULT_GP) { io.out('ERROR: Group policy ' + (a[1] || '') + ' does not exist'); return true; }
        mut(io, () => { tg.gp = neg ? null : a[1]; });
        return true;
      }
      if (kw(a[0], 'address-pool', 3) || kw(a[0], 'authentication-server-group', 5) || kw(a[0], 'group-alias', 7) || kw(a[0], 'group-url', 7)) return true;
      return false;
    },
  });
  AX.modes['tg-general'] = tgMode('(config-tunnel-general)#');
  AX.modes['tg-webvpn'] = tgMode('(config-tunnel-webvpn)#');

  AX.running.push((dev) => {
    const w = dev.webvpn;
    if (emptyCfg(w)) return [];
    const L = [];
    for (const [n, l] of Object.entries(w.lists)) for (const b of l) L.push('url-list ' + n + ' "' + b.name + '" ' + b.url);
    if (w.ifs.length) {
      L.push('webvpn');
      for (const n of w.ifs) { const f = nameIf(dev, n); L.push(' enable ' + (f ? f.nameif : n)); }
    }
    for (const [n, gp] of Object.entries(w.gps)) {
      if (n !== DEFAULT_GP) L.push('group-policy ' + n + ' internal');
      if (!gp.protocols && !gp.urlList && !gp.banner) continue;
      L.push('group-policy ' + n + ' attributes');
      if (gp.banner) L.push(' banner value ' + gp.banner);
      if (gp.protocols) L.push(' vpn-tunnel-protocol ' + gp.protocols.join(' '));
      if (gp.urlList) L.push(' webvpn', '  url-list value ' + gp.urlList);
    }
    for (const [u, gp] of Object.entries(w.userGp)) L.push('username ' + u + ' attributes', ' vpn-group-policy ' + gp);
    for (const [n, tg] of Object.entries(w.tgs)) {
      if (n !== DEFAULT_TG) L.push('tunnel-group ' + n + ' type remote-access');
      if (tg.gp) L.push('tunnel-group ' + n + ' general-attributes', ' default-group-policy ' + tg.gp);
    }
    return L;
  });

  AX.show.push((dev, s, a, io) => {
    if (!kw(a[0], 'vpn-sessiondb', 5)) return false;
    const R = rt(dev);
    const list = [...R.sessions.values()];
    if (!a[1] || kw(a[1], 'summary', 2)) {
      io.out('---------------------------------------------------------------------------');
      io.out('VPN Session Summary');
      io.out('---------------------------------------------------------------------------');
      io.out('                               Active : Cumulative : Peak Concur');
      io.out('Clientless VPN               : ' + String(list.length).padStart(6) + ' : ' + String(R.next - 1).padStart(10) + ' :');
      return true;
    }
    if (!kw(a[1], 'webvpn', 3)) { C.invalid(io, a[1]); return true; }
    io.out('');
    io.out('Session Type: WebVPN');
    io.out('');
    if (!list.length) { io.out('INFO: There are presently no active sessions of the type specified'); return true; }
    const pad = C.pad;
    for (const x of list) {
      const d = Math.floor((dev.net.time - x.since) / 100);
      io.out(pad('Username     : ' + x.user, 40) + 'Index        : ' + x.index);
      io.out('Public IP    : ' + ip(x.ip));
      io.out('Protocol     : Clientless');
      io.out('License      : AnyConnect Premium');
      io.out(pad('Encryption   : Clientless: (1)AES128', 40) + 'Hashing      : Clientless: (1)SHA256');
      io.out(pad('Bytes Tx     : ' + x.bytesTx, 40) + 'Bytes Rx     : ' + x.bytesRx);
      io.out(pad('Group Policy : ' + x.gp, 40) + 'Tunnel Group : ' + DEFAULT_TG);
      io.out('Duration     : ' + Math.floor(d / 3600) + 'h:' + String(Math.floor(d / 60) % 60).padStart(2, '0') + 'm:' + String(d % 60).padStart(2, '0') + 's');
      io.out('');
    }
    return true;
  });

  NS.deviceExt.push({
    key: 'webvpn',
    applies: (d) => d.type === 'asa',
    save: (d) => (emptyCfg(d.webvpn) ? null : JSON.parse(JSON.stringify(d.webvpn))),
    load(d, c) {
      d.webvpn = c ? { ifs: (c.ifs || []).map(String), lists: c.lists || {}, gps: c.gps || {}, userGp: c.userGp || {}, tgs: c.tgs || {} } : null;
      d.webvpnRt = null;
      bindWeb(d);
    },
  });

  NS.cliAsa.tree.config.push('webvpn', 'url-list WORD "WORD" WORD', 'group-policy WORD internal', 'group-policy WORD attributes', 'username WORD attributes',
    'tunnel-group DefaultWEBVPNGroup general-attributes');
  NS.cliAsa.tree.exec.push('show vpn-sessiondb', 'show vpn-sessiondb webvpn');
  Object.assign(NS.cliAsa.tree, {
    webvpn: ['enable WORD', 'exit'],
    'gp-attr': ['vpn-tunnel-protocol ssl-clientless', 'banner value WORD', 'webvpn', 'exit'],
    'gp-webvpn': ['url-list value WORD', 'url-list none', 'exit'],
    'user-attr': ['vpn-group-policy WORD', 'exit'],
    'tg-general': ['default-group-policy WORD', 'exit'],
  });

  NS.asaWebvpn = { proxyPath, rewrite, sessions: (dev) => [...rt(dev).sessions.values()], bind: bindWeb };
})(globalThis.NetLab = globalThis.NetLab || {});
