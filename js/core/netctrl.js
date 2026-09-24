/* NetLab — сетевой контроллер (Network Controller, как APIC-EM в Packet Tracer):
 *  • REST API по HTTP: POST /api/v1/ticket (вход, service ticket), GET /api/v1/network-device[/count],
 *    GET /api/v1/host, GET/POST /api/v1/discovery — токен в заголовке X-Auth-Token;
 *  • обнаружение (Discovery): диапазон адресов опрашивается ping'ом, для ответивших устройств Cisco
 *    проверяются учётные данные CLI (username … secret …) → Managed или «Credential mismatch»;
 *    узлы — из ARP-таблиц управляемых устройств;
 *  • веб-страница с таблицами на http://<адрес контроллера>/.
 * Клиент: IpNode.httpRequest(method, url, {headers, body}, cb) — для программы «REST-клиент» на ПК. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const ip = U.ipStr;
  const MAX_RANGE = 256;

  NS.models.MODELS['NetworkController-PT'] = {
    type: 'netctrl', title: 'Сетевой контроллер Network Controller-PT',
    ports: [{ name: 'GigabitEthernet0', media: 'copper', speed: 1000 }],
    slots: [], attrs: { MTBF: 200000, cost: 15000, 'power source': 0, 'rack units': 1, wattage: 300 },
  };
  NS.models.DEFAULT_MODEL.netctrl = 'NetworkController-PT';

  /* ================= HTTP-клиент с методами, заголовками и телом ================= */

  /** HTTP-запрос. cb({ok, status, reason, body, json, error, url}). body — строка или объект (отправляется как JSON). */
  IpNode.prototype.httpRequest = function (method, url, opts, cb) {
    const u = IpNode.parseUrl(url);
    if (!u) { cb({ ok: false, error: 'Введите адрес, например http://192.168.1.10/api/v1/ticket' }); return null; }
    const path = u.path;
    const headers = Object.assign({}, (opts && opts.headers) || {});
    let body = opts ? opts.body : undefined;
    if (body != null && typeof body !== 'string') body = JSON.stringify(body);
    const hp = u.host + (u.port && u.port !== P.PORT_HTTP ? ':' + u.port : '');
    return this.tcpRequest(u.host, u.port || P.PORT_HTTP, { http: String(method || 'GET').toUpperCase(), path, host: u.host, headers, body: body == null ? null : String(body) }, (d) => d && d.http === 'RESP', (r) => {
      if (!r.ok) { cb({ ok: false, error: r.error, url: 'http://' + hp + path }); return; }
      let json = null;
      try { json = JSON.parse(r.data.body); } catch (e) { json = null; }
      cb({ ok: true, status: r.data.status, reason: r.data.reason, body: String(r.data.body || ''), json, headers: r.data.headers || {}, url: 'http://' + hp + path });
    });
  };

  /* ================= контроллер ================= */

  const Host = NS.Host;

  function hostOf(net, addr) {
    for (const d of net.devices.values()) if (d.ifaces && d.ifaces.some((f) => f.ip === addr)) return d;
    return null;
  }
  function platformOf(d) {
    const m = { router: 'CISCO' + String(d.model).replace(/-.*$/, ''), switch: 'WS-C' + d.model, asa: 'ASA5506', wlc: 'AIR-CT2504' }[d.type];
    return m || d.model;
  }
  function familyOf(d) { return { router: 'Routers', switch: 'Switches and Hubs', asa: 'Security', wlc: 'Wireless Controller' }[d.type] || 'Unified AP'; }

  class NetCtrl extends Host {
    constructor(net, id, name, model) {
      super(net, id, name, model || 'NetworkController-PT', 'netctrl');
      this.ctrl = { users: [{ user: 'admin', pass: 'cisco123' }], creds: [], discoveries: [] };
      this.ctrlRt = { tickets: new Map(), devices: new Map(), hosts: new Map(), tasks: 0 };
    }

    bindServices() {
      super.bindServices();
      if (!this.tcp) return;
      this.tcp.listen(P.PORT_HTTP, (conn) => {
        conn.h.onData = (d) => {
          if (!d || !d.http) return;
          const r = this.handleHttp(d, conn);
          conn.send(Object.assign({ http: 'RESP' }, r));
          conn.close();
        };
      });
    }

    /* ---------- настройки ---------- */

    setAdmin(user, pass) {
      if (!/^[\w.@-]{1,32}$/.test(String(user || ''))) throw new Error('Имя пользователя: латиница, цифры, «.», «-», «_»');
      if (String(pass || '').length < 4) throw new Error('Пароль: не короче 4 символов');
      this.ctrl.users = [{ user: String(user), pass: String(pass) }];
    }

    addCredential(user, pass, enable) {
      if (!String(user || '').trim()) throw new Error('Укажите имя пользователя CLI');
      this.ctrl.creds = this.ctrl.creds.filter((c) => c.user !== user).concat([{ user: String(user).trim(), pass: String(pass || ''), enable: String(enable || '') }]);
    }

    /** Запустить обнаружение по диапазону адресов «A.B.C.D-A.B.C.E» (или одному адресу). */
    discover(name, range, cb) {
      const [a, b] = String(range || '').split('-').map((x) => U.parseIp(x.trim()));
      if (a == null) throw new Error('Диапазон: 192.168.1.1-192.168.1.254');
      const end = b == null ? a : b;
      if (end < a) throw new Error('Конец диапазона меньше начала');
      if (end - a + 1 > MAX_RANGE) throw new Error('В NetLab диапазон — не больше ' + MAX_RANGE + ' адресов');
      if (this.iface.ip == null) throw new Error('У контроллера нет IP-адреса');
      const disc = { id: String(++this.ctrlRt.tasks), name: String(name || 'Discovery ' + this.ctrlRt.tasks), range: ip(a) + '-' + ip(end), status: 'In Progress', found: 0 };
      this.ctrl.discoveries = this.ctrl.discoveries.filter((x) => x.name !== disc.name).concat([disc]);
      const list = [];
      for (let v = a; v <= end; v++) if (!this.hasIp(v)) list.push(v >>> 0);
      let i = 0;
      let active = 0;
      const next = () => {
        while (active < 8 && i < list.length) {
          const target = list[i++];
          active++;
          this.ping(ip(target), {
            count: 1,
            timeout: 150,
            onEvent: (ev) => {
              if (ev.type !== 'done') return;
              active--;
              if (ev.received) { this.classify(target); disc.found++; }
              if (i >= list.length && active === 0) {
                disc.status = 'Complete';
                this.collectHosts();
                this.net.emit('config', { dev: this });
                if (cb) cb(disc);
              } else next();
            },
          });
        }
      };
      if (!list.length) { disc.status = 'Complete'; if (cb) cb(disc); return disc; }
      next();
      this.net.emit('config', { dev: this });
      return disc;
    }

    /** Ответившее устройство: сетевое (проверка учётных данных CLI) или конечный узел. */
    classify(addr) {
      const d = hostOf(this.net, addr);
      if (!d) return;
      if (!d.ios || d.type === 'wrouter') { this.ctrlRt.hosts.set(addr, { hostIp: addr, hostMac: d.iface ? d.ifaceMac(d.iface) : '', hostType: d.type === 'lap' ? 'wireless' : 'wired', name: d.name }); return; }
      const cur = [...this.ctrlRt.devices.values()].find((x) => x.devId === d.id);
      const credOk = this.ctrl.creds.some((c) => (d.checkUser ? d.checkUser(c.user, c.pass) : false));
      const rec = {
        devId: d.id, id: 'dev-' + d.id, hostname: d.ios.hostname, managementIpAddress: cur ? cur.managementIpAddress : addr,
        platformId: platformOf(d), family: familyOf(d), softwareVersion: d.type === 'asa' ? '9.8(1)' : '15.1', macAddress: d.ports.find((p) => p.mac) ? d.ports.find((p) => p.mac).mac : '',
        reachabilityStatus: 'Reachable', collectionStatus: credOk ? 'Managed' : 'Credential mismatch', upTime: Math.floor(this.net.time / 100) + ' s',
        interfaceCount: String(d.ifaces.filter((f) => !f.runtime).length),
      };
      this.ctrlRt.devices.set(rec.managementIpAddress, rec);
    }

    /** Узлы из ARP-таблиц управляемых устройств. */
    collectHosts() {
      for (const rec of this.ctrlRt.devices.values()) {
        if (rec.collectionStatus !== 'Managed') continue;
        const d = this.net.getDevice(rec.devId);
        if (!d || !d.arp) continue;
        for (const [addr, e] of d.arp) {
          const h = hostOf(this.net, addr);
          if (!h || h.ios) continue;
          this.ctrlRt.hosts.set(addr, { hostIp: addr, hostMac: e.mac, hostType: 'wired', name: h.name, connectedNetworkDeviceIpAddress: rec.managementIpAddress });
        }
      }
    }

    /* ---------- HTTP ---------- */

    handleHttp(d, conn) {
      const path = String(d.path || '/').split('?')[0].replace(/\/+$/, '') || '/';
      const json = (status, obj) => ({ status, reason: { 200: 'OK', 201: 'Created', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed' }[status], headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj, null, 2) });
      const hdr = (k) => { const h = d.headers || {}; const key = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase()); return key ? h[key] : null; };
      if (path === '/' || path === '/index.html') return { status: 200, reason: 'OK', body: this.dashboard() };
      if (!path.startsWith('/api/v1/')) return json(404, { response: { errorCode: 'NOT_FOUND', message: 'Resource not found: ' + path } });
      const res = path.slice('/api/v1/'.length);
      if (res === 'ticket') {
        if (d.http !== 'POST') return json(405, { response: { errorCode: 'METHOD', message: 'Use POST' } });
        let b = null;
        try { b = JSON.parse(d.body || '{}'); } catch (e) { return json(400, { response: { errorCode: 'BAD_REQUEST', message: 'Тело запроса — не JSON' } }); }
        const u = this.ctrl.users.find((x) => x.user === b.username && x.pass === b.password);
        if (!u) return json(401, { response: { errorCode: 'INVALID_CREDENTIALS', message: 'Invalid username or password', detail: 'Неверное имя пользователя или пароль' }, version: '1.0' });
        const t = 'ST-' + (1000 + this.ctrlRt.tickets.size) + '-' + Math.random().toString(36).slice(2, 10) + '-cas';
        this.ctrlRt.tickets.set(t, { user: u.user, time: this.net.time });
        return json(201, { response: { serviceTicket: t, idleTimeout: 1800, sessionTimeout: 21600 }, version: '1.0' });
      }
      const tok = hdr('X-Auth-Token');
      if (!tok || !this.ctrlRt.tickets.has(tok)) return json(401, { response: { errorCode: 'RBAC', message: 'Access denied: нет действительного X-Auth-Token (получите его POST /api/v1/ticket)' }, version: '1.0' });
      if (res === 'network-device' && d.http === 'GET') return json(200, { response: [...this.ctrlRt.devices.values()].map((x) => { const o = Object.assign({}, x); delete o.devId; o.managementIpAddress = ip(o.managementIpAddress); return o; }), version: '1.0' });
      if (res === 'network-device/count') return json(200, { response: this.ctrlRt.devices.size, version: '1.0' });
      if (res === 'host' && d.http === 'GET') return json(200, { response: [...this.ctrlRt.hosts.values()].map((x) => Object.assign({}, x, { hostIp: ip(x.hostIp), connectedNetworkDeviceIpAddress: x.connectedNetworkDeviceIpAddress != null ? ip(x.connectedNetworkDeviceIpAddress) : undefined })), version: '1.0' });
      if (res === 'host/count') return json(200, { response: this.ctrlRt.hosts.size, version: '1.0' });
      if (res === 'discovery' && d.http === 'GET') return json(200, { response: this.ctrl.discoveries.map((x) => Object.assign({}, x)), version: '1.0' });
      if (res === 'discovery' && d.http === 'POST') {
        let b = null;
        try { b = JSON.parse(d.body || '{}'); } catch (e) { return json(400, { response: { errorCode: 'BAD_REQUEST', message: 'Тело запроса — не JSON' } }); }
        try {
          const disc = this.discover(b.name, b.ipAddressList);
          return json(202, { response: { taskId: disc.id, url: '/api/v1/discovery/' + disc.id }, version: '1.0' });
        } catch (e) { return json(400, { response: { errorCode: 'BAD_REQUEST', message: e.message } }); }
      }
      return json(404, { response: { errorCode: 'NOT_FOUND', message: 'Resource not found: ' + path }, version: '1.0' });
    }

    dashboard() {
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const devs = [...this.ctrlRt.devices.values()];
      const hosts = [...this.ctrlRt.hosts.values()];
      return '<html><h2>Network Controller — ' + esc(this.name) + '</h2>' +
        '<p>Устройств: <b>' + devs.length + '</b>, узлов: <b>' + hosts.length + '</b>. REST API: POST /api/v1/ticket, GET /api/v1/network-device, GET /api/v1/host (заголовок X-Auth-Token).</p>' +
        '<h3>Сетевые устройства</h3><table border="1"><tr><th>Hostname</th><th>IP</th><th>Платформа</th><th>Состояние</th></tr>' +
        (devs.map((x) => '<tr><td>' + esc(x.hostname) + '</td><td>' + ip(x.managementIpAddress) + '</td><td>' + esc(x.platformId) + '</td><td>' + esc(x.collectionStatus) + '</td></tr>').join('') || '<tr><td colspan="4">Запустите обнаружение (Discovery)</td></tr>') + '</table>' +
        '<h3>Узлы</h3><table border="1"><tr><th>Имя</th><th>IP</th><th>MAC</th></tr>' +
        (hosts.map((x) => '<tr><td>' + esc(x.name) + '</td><td>' + ip(x.hostIp) + '</td><td>' + esc(x.hostMac) + '</td></tr>').join('') || '<tr><td colspan="3">—</td></tr>') + '</table></html>';
    }

    serializeConfig() {
      const c = super.serializeConfig();
      c.ctrl = JSON.parse(JSON.stringify(this.ctrl));
      return c;
    }

    loadConfig(c) {
      super.loadConfig(c);
      if (!this.ctrl) return;
      const x = (c && c.ctrl) || {};
      this.ctrl = { users: Array.isArray(x.users) && x.users.length ? x.users : [{ user: 'admin', pass: 'cisco123' }], creds: x.creds || [], discoveries: (x.discoveries || []).map((d) => Object.assign({}, d, { status: d.status === 'In Progress' ? 'Complete' : d.status })) };
    }
  }
  NetCtrl.namePrefix = 'Controller';
  NS.deviceTypes.netctrl = NetCtrl;
  NS.NetCtrl = NetCtrl;

  IpNode.hooks.runtime.push(function () { if (this.type === 'netctrl') this.ctrlRt = { tickets: new Map(), devices: new Map(), hosts: new Map(), tasks: 0 }; });
})(globalThis.NetLab = globalThis.NetLab || {});
