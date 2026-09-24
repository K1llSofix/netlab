/* NetLab — контроллер беспроводной сети Cisco WLC 2504 и лёгкие точки доступа (LAP 3702i):
 *  • LAP получает адрес по DHCP, ищет контроллер (широковещательно в своей сети или по DHCP option 43),
 *    подключается по CAPWAP (UDP 5246) и получает от WLC список WLAN;
 *  • кадры клиентов идут туннелем CAPWAP (UDP 5247) на контроллер, а он передаёт их в проводную сеть
 *    в VLAN своей WLAN (порт коммутатора к WLC — транк);
 *  • WPA2-Enterprise: подключение клиента разрешается после проверки имени и пароля на RADIUS-сервере
 *    (на WLC или на WRT300N).
 * Настраивается через окно устройства (как веб-интерфейс WLC), без CLI. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const Host = NS.Host;
  const ip = U.ipStr;

  const CTRL = 5246;
  const DATA = 5247;
  const RETRY = 300;
  const ENT_RETRY = 3000;

  NS.models.MODELS['WLC-2504'] = {
    type: 'wlc', title: 'Контроллер беспроводной сети Cisco WLC 2504',
    ports: [1, 2, 3, 4].map((i) => ({ name: 'GigabitEthernet0/' + i, media: 'copper', speed: 1000 })).concat([{ name: 'Console', media: 'console', speed: 0 }]),
    slots: [], attrs: { MTBF: 200000, cost: 5000, 'power source': 0, 'rack units': 1, wattage: 50 },
  };
  NS.models.MODELS['3702i'] = {
    type: 'lap', title: 'Лёгкая точка доступа Cisco Aironet 3702i (LAP)',
    ports: [{ name: 'GigabitEthernet0', media: 'copper', speed: 1000 }, { name: 'Dot11Radio0', media: 'wireless', speed: 300, radio: true }],
    slots: [], attrs: { MTBF: 200000, cost: 900, 'power source': 0, 'rack units': 0, wattage: 16 },
  };
  NS.models.DEFAULT_MODEL.wlc = 'WLC-2504';
  NS.models.DEFAULT_MODEL.lap = '3702i';

  function capwap(dev, dst, sport, dport, data, why) {
    return dev.sendIp(P.ipv4(null, dst, 'UDP', P.udp(sport, dport, data), dev.defaultTtl), { why });
  }

  /* ================= контроллер ================= */

  class Wlc extends Host {
    constructor(net, id, name, model) {
      super(net, id, name, model || 'WLC-2504', 'wlc');
      this.useApipa = false;
      this.wlc = { wlans: [], radius: [] };
      this.wlcRt = { aps: new Map(), clients: new Map(), ent: new Map() };
      this.iface.dhcp = false;
      this.syncRadius();
    }

    bindServices() {
      super.bindServices();
      this.udp.set(CTRL, (pkt, f, frame) => this.onCtrl(pkt, f, frame));
      this.udp.set(DATA, (pkt, f, frame) => this.onData(pkt, f, frame));
    }

    /** Сети, которые контроллер раздаёт точкам доступа. */
    activeWlans() { return this.wlc.wlans.filter((w) => w.enabled !== false); }

    onCtrl(pkt, f, frame) {
      const d = pkt.payload.data || {};
      if (!d.capwap) return;
      const rt = this.wlcRt;
      if (d.capwap === 'discovery-request') {
        capwap(this, pkt.src, CTRL, pkt.payload.sport, { capwap: 'discovery-response', wlc: this.name, ip: this.iface.ip }, 'CAPWAP Discovery Response: я контроллер ' + this.name);
        return;
      }
      if (d.capwap === 'join-request') {
        rt.aps.set(pkt.src, { ip: pkt.src, name: d.ap, dev: d.devId, model: d.model, since: this.net.time });
        capwap(this, pkt.src, CTRL, pkt.payload.sport, { capwap: 'join-response', wlc: this.name, wlans: this.activeWlans().map((w) => Object.assign({}, w)) }, 'CAPWAP Join Response: точка ' + d.ap + ' подключена, передаю WLAN (' + this.activeWlans().length + ')');
        this.net.emit('config', { dev: this });
      }
    }

    /** Обновить WLAN на всех подключённых точках (после изменения настроек). */
    pushConfig() {
      for (const ap of this.wlcRt.aps.values()) {
        capwap(this, ap.ip, CTRL, CTRL, { capwap: 'config-update', wlans: this.activeWlans().map((w) => Object.assign({}, w)) }, 'CAPWAP Configuration Update: новые настройки WLAN для ' + ap.name);
      }
      this.net.refreshTopology();
    }

    wlanBySsid(ssid) { return this.wlc.wlans.find((w) => w.ssid === ssid) || null; }

    /** Кадр клиента из туннеля CAPWAP: в проводную сеть (VLAN WLAN) или другому беспроводному клиенту. */
    onData(pkt, f, frame) {
      const d = pkt.payload.data || {};
      if (d.capwap !== 'data' || !d.frame) return;
      const inner = d.frame;
      const w = this.wlanBySsid(d.ssid);
      if (!w) { if (frame) this.drop(frame, 'WLC: WLAN «' + d.ssid + '» не найдена'); return; }
      const vlan = w.vlan || null;
      this.wlcRt.clients.set(inner.src, { mac: inner.src, lap: pkt.src, ssid: w.ssid, vlan, time: this.net.time });
      const cl = this.wlcRt.clients.get(inner.dst);
      if (cl && cl.vlan === vlan && !U.isMulticastMac(inner.dst)) {
        this.tunnel(cl.lap, inner, cl.ssid, 'WLC: получатель — беспроводной клиент на ' + this.apName(cl.lap));
        return;
      }
      if (U.isMulticastMac(inner.dst)) this.tunnelBroadcast(inner, vlan, inner.src, pkt.src);
      const port = this.iface.port;
      this.send(port, Object.assign({}, inner, { vlan }), 'WLC: кадр клиента WLAN «' + w.ssid + '» → проводная сеть' + (vlan ? ' (VLAN ' + vlan + ', тег 802.1Q)' : ''));
    }

    apName(lapIp) { const a = this.wlcRt.aps.get(lapIp); return a ? a.name : ip(lapIp); }

    tunnel(lapIp, inner, ssid, why) {
      capwap(this, lapIp, DATA, DATA, { capwap: 'data', frame: inner, ssid }, why);
    }

    /** Широковещательный кадр — на все точки, где есть клиенты сетей этого VLAN. */
    tunnelBroadcast(inner, vlan, exceptMac, exceptLap) {
      const sent = new Set();
      for (const c of this.wlcRt.clients.values()) {
        if (c.vlan !== vlan || c.mac === exceptMac) continue;
        const k = c.lap + '|' + c.ssid;
        if (sent.has(k)) continue;
        sent.add(k);
        this.tunnel(c.lap, inner, c.ssid, 'WLC: широковещательный кадр VLAN ' + (vlan || 'управления') + ' → клиентам на ' + this.apName(c.lap));
      }
      void exceptLap;
    }

    receive(i, frame) {
      const tag = frame.vlan == null ? null : frame.vlan;
      const cl = this.wlcRt.clients.get(frame.dst);
      if (cl && cl.vlan === tag) {
        this.tunnel(cl.lap, Object.assign({}, frame, { vlan: null }), cl.ssid, 'WLC: кадр для беспроводного клиента → туннель CAPWAP на ' + this.apName(cl.lap));
        return;
      }
      if (U.isMulticastMac(frame.dst)) {
        this.tunnelBroadcast(Object.assign({}, frame, { vlan: null }), tag, frame.src, null);
        if (tag == null) super.receive(i, frame);
        return;
      }
      if (tag != null) { this.drop(frame, 'WLC: в VLAN ' + tag + ' нет такого беспроводного клиента (' + frame.dst + ')'); return; }
      super.receive(i, frame);
    }

    /* ---------- WPA2-Enterprise ---------- */

    syncRadius() {
      this.aaa = { newModel: true, login: {}, dot1x: null, radius: this.wlc.radius.map((r, i) => ({ name: 'R' + (i + 1), ip: r.ip, key: r.key, authPort: r.port || 1812 })), tacacs: [], radiusKey: null, tacacsKey: null };
    }

    /** Проверка клиента WPA2-Enterprise: 'ok' | 'pending' | 'fail'. peek — только узнать состояние. */
    entCheck(client, wlan, cfg, peek) {
      return entCheck(this, client, wlan, cfg, peek);
    }

    /* ---------- настройки ---------- */

    setWlan(w, oldSsid) {
      const ssid = String(w.ssid || '').trim();
      if (!ssid || ssid.length > 32) throw new Error('SSID: от 1 до 32 символов');
      const sec = w.security || 'open';
      NS.validateWifi({ ssid, security: sec, key: sec === 'wpa2' ? w.key : undefined });
      if (w.vlan != null && !(w.vlan >= 1 && w.vlan <= 4094)) throw new Error('VLAN: 1–4094');
      if (this.wlc.wlans.some((x) => x.ssid === ssid && x.ssid !== oldSsid)) throw new Error('WLAN «' + ssid + '» уже есть');
      if (sec === 'wpa2-ent' && !this.wlc.radius.length) throw new Error('Для WPA2-Enterprise сначала добавьте RADIUS-сервер (Security → RADIUS)');
      const rec = { id: 0, ssid, security: sec, key: sec === 'wpa2' ? String(w.key) : '', vlan: w.vlan || null, enabled: w.enabled !== false };
      const idx = this.wlc.wlans.findIndex((x) => x.ssid === (oldSsid || ssid));
      if (idx >= 0) { rec.id = this.wlc.wlans[idx].id; this.wlc.wlans[idx] = rec; } else { rec.id = Math.max(0, ...this.wlc.wlans.map((x) => x.id)) + 1; this.wlc.wlans.push(rec); }
      this.wlcRt.ent.clear();
      this.pushConfig();
    }

    removeWlan(ssid) {
      this.wlc.wlans = this.wlc.wlans.filter((x) => x.ssid !== ssid);
      this.pushConfig();
    }

    setRadius(list) {
      for (const r of list) { if (r.ip == null) throw new Error('Укажите адрес RADIUS-сервера'); if (!r.key) throw new Error('Укажите общий ключ (shared secret)'); }
      this.wlc.radius = list.map((r) => ({ ip: r.ip, key: String(r.key), port: r.port || 1812 }));
      this.syncRadius();
      this.wlcRt.ent.clear();
      this.net.refreshTopology();
    }

    serializeConfig() {
      const c = super.serializeConfig();
      c.wlc = { wlans: this.wlc.wlans.map((w) => Object.assign({}, w)), radius: this.wlc.radius.map((r) => ({ ip: ip(r.ip), key: r.key, port: r.port })) };
      return c;
    }

    loadConfig(c) {
      super.loadConfig(c);
      if (!this.wlc) return;
      const w = (c && c.wlc) || {};
      this.wlc.wlans = (w.wlans || []).map((x) => ({ id: Number(x.id) || 0, ssid: String(x.ssid), security: x.security || 'open', key: String(x.key || ''), vlan: x.vlan ? Number(x.vlan) : null, enabled: x.enabled !== false }));
      this.wlc.radius = (w.radius || []).map((r) => ({ ip: U.parseIp(r.ip), key: String(r.key || ''), port: Number(r.port) || 1812 })).filter((r) => r.ip != null);
      this.syncRadius();
    }
  }
  Wlc.namePrefix = 'WLC';
  NS.Wlc = Wlc;
  NS.deviceTypes.wlc = Wlc;

  /** Общая проверка WPA2-Enterprise для устройства-аутентификатора (WLC, WRT300N). */
  function entCheck(auth, client, wlan, cfg, peek) {
    if (!auth.entRt) auth.entRt = new Map();
    const key = client.id + '|' + wlan.ssid + '|' + (cfg.user || '') + '|' + (cfg.pass || '');
    const cur = auth.entRt.get(key);
    const now = auth.net.time;
    if (cur && (cur.state !== 'fail' || now - cur.time < ENT_RETRY)) return cur.state;
    if (peek) return cur ? cur.state : 'pending';
    if (!cfg.user) { auth.entRt.set(key, { state: 'fail', time: now }); return 'fail'; }
    const rec = { state: 'pending', time: now };
    auth.entRt.set(key, rec);
    auth.timer(0, () => {
      NS.aaa.radiusAuth(auth, { user: cfg.user, pass: cfg.pass || '' }, (r) => {
        rec.state = r.result === 'accept' ? 'ok' : 'fail';
        rec.time = auth.net.time;
        auth.note('WPA2-Enterprise: ' + cfg.user + ' — ' + (rec.state === 'ok' ? 'RADIUS разрешил подключение к «' + wlan.ssid + '»' : 'отказ (' + (r.text || 'Access-Reject') + ')'), null, rec.state === 'ok' ? 'accept' : 'drop');
        auth.net.refreshTopology();
      });
    });
    return 'pending';
  }
  NS.wlcEntCheck = entCheck;

  // WRT300N: WPA2-Enterprise через RADIUS-сервер, указанный в настройках Wi-Fi
  if (NS.WirelessRouter) {
    NS.WirelessRouter.prototype.entCheck = function (client, wlan, cfg, peek) {
      const r = this.wifi.radius;
      if (!r || r.ip == null) return 'fail';
      this.aaa = { newModel: true, login: {}, dot1x: null, radius: [{ name: 'R1', ip: r.ip, key: r.key, authPort: 1812 }], tacacs: [], radiusKey: null, tacacsKey: null };
      return entCheck(this, client, wlan, cfg, peek);
    };
  }

  /* ================= лёгкая точка доступа ================= */

  class Lap extends Host {
    constructor(net, id, name, model) {
      super(net, id, name, model || '3702i', 'lap');
      this.useApipa = false;
      this.iface.dhcp = true;
      this.lapRt = { state: 'idle', wlc: null, wlcDev: null, wlans: [], tries: 0, timer: null };
    }

    bindServices() {
      super.bindServices();
      this.udp.set(CTRL, (pkt, f, frame) => this.onCtrl(pkt, f, frame));
      this.udp.set(DATA, (pkt, f, frame) => this.onData(pkt, f, frame));
    }

    get joined() { return !!this.lapRt && this.lapRt.state === 'joined'; }

    serializeConfig() {
      const c = super.serializeConfig();
      if (this.lastWlc != null) c.lastWlc = ip(this.lastWlc);
      return c;
    }

    loadConfig(c) {
      super.loadConfig(c);
      this.lastWlc = c && c.lastWlc ? U.parseIp(c.lastWlc) : null;
      // после загрузки схемы адрес уже есть — сразу ищем контроллер
      if (this.lapRt && this.iface && this.iface.ip != null) this.timer(10, () => this.discover());
    }

    /** Точка доступа без адреса повторяет DHCP сама (сервер мог появиться позже, чем она включилась). */
    dhcpFail() {
      super.dhcpFail();
      const rt = this.lapRt;
      if (!rt) return;
      rt.dhcpTries = (rt.dhcpTries || 0) + 1;
      if (rt.dhcpTries <= 12 && this.iface.dhcp) this.timer(500, () => { if (this.iface.dhcp && this.iface.ip == null) this.startDhcp(); });
    }

    radioIndex() { return this.ports.findIndex((p) => p.radio); }

    radioEnabled() {
      if (!this.power || !this.joined) return false;
      const w = this.lapRt.wlcDev && this.net.getDevice(this.lapRt.wlcDev);
      return !!w && w.power;
    }

    /** WLAN, полученные от контроллера. */
    wlans() { return this.joined ? this.lapRt.wlans : []; }

    entCheck(client, wlan, cfg, peek) {
      const w = this.lapRt.wlcDev && this.net.getDevice(this.lapRt.wlcDev);
      return w && w.entCheck ? w.entCheck(client, wlan, cfg, peek) : 'fail';
    }

    addressChanged(f) {
      super.addressChanged(f);
      if (f.ip != null && this.power) this.timer(5, () => this.discover());
      else if (this.lapRt) { this.lapRt.state = 'idle'; this.net.refreshTopology(); }
    }

    /** CAPWAP Discovery: на адрес из option 43 или широковещательно в своей сети. */
    discover() {
      const f = this.iface;
      if (!f || f.ip == null || !this.power) return;
      const rt = this.lapRt;
      if (rt.timer) rt.timer.cancel();
      rt.state = 'discovery';
      rt.tries = (rt.tries || 0) + 1;
      const opt43 = this.dhcpc && this.dhcpc.phase === 'bound' && this.dhcpc.wlc != null ? this.dhcpc.wlc : null;
      const target = opt43 != null ? opt43 : this.lastWlc;
      const msg = { capwap: 'discovery-request', ap: this.name, model: this.model };
      if (target != null) capwap(this, target, CTRL, CTRL, msg, 'CAPWAP Discovery Request: контроллер ' + ip(target) + (opt43 != null ? ' (из DHCP option 43)' : ' (запомненный контроллер)'));
      else this.sendIp(P.ipv4(f.ip, U.BROADCAST_IP, 'UDP', P.udp(CTRL, CTRL, msg), this.defaultTtl), { iface: f, why: 'CAPWAP Discovery Request: есть ли контроллер WLC в моей сети? (широковещательно)' });
      rt.timer = this.timer(RETRY, () => { rt.timer = null; if (rt.state !== 'joined' && rt.tries < 20) this.discover(); });
      this.net.emit('config', { dev: this });
    }

    onCtrl(pkt, f, frame) {
      const d = pkt.payload.data || {};
      const rt = this.lapRt;
      if (d.capwap === 'discovery-response' && rt.state === 'discovery') {
        rt.state = 'join';
        rt.wlc = pkt.src;
        capwap(this, pkt.src, CTRL, CTRL, { capwap: 'join-request', ap: this.name, model: this.model, devId: this.id }, 'CAPWAP Join Request: прошу подключить меня к ' + (d.wlc || ip(pkt.src)));
        return;
      }
      if (d.capwap === 'join-response' || d.capwap === 'config-update') {
        if (d.capwap === 'join-response') {
          if (rt.timer) { rt.timer.cancel(); rt.timer = null; }
          rt.state = 'joined';
          rt.wlc = pkt.src;
          this.lastWlc = pkt.src;
          const w = [...this.net.devices.values()].find((x) => x.type === 'wlc' && x.hasIp(pkt.src));
          rt.wlcDev = w ? w.id : null;
          this.note('CAPWAP: точка доступа подключена к контроллеру ' + (d.wlc || ip(pkt.src)), null, 'accept');
        }
        rt.wlans = (d.wlans || []).map((x) => Object.assign({}, x));
        this.net.refreshTopology();
        this.net.emit('config', { dev: this });
        return;
      }
      if (frame && !d.capwap) this.drop(frame, 'Не CAPWAP-сообщение');
    }

    /** Кадр из туннеля — клиентам нужной WLAN. */
    onData(pkt, f, frame) {
      const d = pkt.payload.data || {};
      if (d.capwap !== 'data' || !d.frame) return;
      const inner = d.frame;
      const radio = this.radioIndex();
      const ssid = d.ssid;
      const src = inner.src;
      this.send(radio, inner, 'LAP: кадр из туннеля CAPWAP → клиентам WLAN «' + ssid + '»', (cd) => !!cd && !!cd.wifi && cd.wifi.ssid === ssid && !cd.ports.some((p) => p.mac === src));
    }

    receive(i, frame) {
      const p = this.ports[i];
      if (!p || !p.radio) { super.receive(i, frame); return; }
      if (!this.joined || this.lapRt.wlc == null) { this.drop(frame, 'LAP не подключена к контроллеру — кадр клиента некуда передать'); return; }
      const cl = this.clientByMac(frame.src);
      const ssid = cl && cl.wifi ? cl.wifi.ssid : null;
      capwap(this, this.lapRt.wlc, DATA, DATA, { capwap: 'data', frame: Object.assign({}, frame), ssid }, 'LAP: кадр клиента' + (cl ? ' ' + cl.name : '') + ' → туннель CAPWAP на контроллер');
    }

    clientByMac(mac) {
      const rp = this.ports[this.radioIndex()];
      if (!rp || !rp.wlinks) return null;
      for (const id of rp.wlinks) {
        const l = this.net.links.get(id);
        const d = l && this.net.getDevice(l.b.dev);
        if (d && d.ports[l.b.port].mac === mac) return d;
      }
      return null;
    }

    wirelessClients() {
      const rp = this.ports[this.radioIndex()];
      if (!rp || !rp.wlinks) return [];
      return [...rp.wlinks].map((id) => this.net.links.get(id)).filter(Boolean).map((l) => this.net.getDevice(l.b.dev)).filter(Boolean);
    }
  }
  Lap.namePrefix = 'LAP';
  NS.Lap = Lap;
  NS.deviceTypes.lap = Lap;

  NS.IpNode.hooks.runtime.push(function () {
    if (this.type === 'lap') {
      if (this.lapRt && this.lapRt.timer) this.lapRt.timer.cancel();
      this.lapRt = { state: 'idle', wlc: null, wlcDev: null, wlans: [], tries: 0, timer: null };
      if (this.iface && this.iface.ip != null && !this.iface.dhcp) this.timer(10, () => this.discover());
    }
    if (this.type === 'wlc') {
      this.wlcRt = { aps: new Map(), clients: new Map(), ent: new Map() };
      this.entRt = null;
    }
  });

  /* ---------- пакеты CAPWAP ---------- */

  const CAPWAP_NAMES = { 'discovery-request': 'Discovery Request', 'discovery-response': 'Discovery Response', 'join-request': 'Join Request', 'join-response': 'Join Response', 'config-update': 'Configuration Update', data: 'Data' };
  const isCapwap = (f) => f.type === 'IPv4' && f.payload && f.payload.proto === 'UDP' && f.payload.payload && (f.payload.payload.dport === CTRL || f.payload.payload.dport === DATA) && f.payload.payload.data && f.payload.payload.data.capwap;
  P.register({
    protocols: { CAPWAP: { label: 'CAPWAP', color: '#0891b2' } },
    classify(f) { return isCapwap(f) ? 'CAPWAP' : null; },
    summary(f) {
      if (!isCapwap(f)) return null;
      const d = f.payload.payload.data;
      if (d.capwap === 'data') return 'CAPWAP Data (' + (d.ssid || 'WLAN') + '): ' + (P.summary(d.frame) || d.frame.type);
      return 'CAPWAP ' + (CAPWAP_NAMES[d.capwap] || d.capwap) + ', ' + ip(f.payload.src) + ' → ' + ip(f.payload.dst);
    },
    extraLayers(f, out) {
      if (!isCapwap(f)) return;
      const d = f.payload.payload.data;
      const fields = [['Сообщение', CAPWAP_NAMES[d.capwap] || d.capwap]];
      if (d.ap) fields.push(['Точка доступа', d.ap]);
      if (d.wlc) fields.push(['Контроллер', d.wlc]);
      if (d.wlans) fields.push(['WLAN', d.wlans.map((w) => w.ssid + ' (' + (w.security === 'wpa2-ent' ? 'WPA2-Enterprise' : w.security === 'wpa2' ? 'WPA2-PSK' : 'open') + (w.vlan ? ', VLAN ' + w.vlan : '') + ')').join('; ') || '—']);
      if (d.frame) fields.push(['Внутренний кадр', d.frame.src + ' → ' + d.frame.dst + ' · ' + (P.summary(d.frame) || d.frame.type)]);
      out.push({ title: 'CAPWAP (туннель точки доступа)', fields });
    },
  });
})(globalThis.NetLab = globalThis.NetLab || {});
