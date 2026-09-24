/* NetLab — базовое устройство (модель, слоты с модулями, атрибуты), концентратор и точка доступа Wi-Fi. */
(function (NS) {
  'use strict';

  const U = NS.util;

  function isSpecial(p) { return p.media === 'console' || p.media === 'rs232'; }

  /** Скорость порта с учётом настройки Bandwidth (auto — номинальная). */
  NS.portSpeed = function (p) {
    return p.bandwidth && p.bandwidth !== 'auto' ? Number(p.bandwidth) : p.speed;
  };

  class Device {
    constructor(net, id, type, name, model) {
      this.net = net;
      this.id = id;
      this.type = type;
      this.name = name;
      this.model = model || NS.models.DEFAULT_MODEL[type];
      this.spec = NS.models.get(this.model);
      this.x = 0;
      this.y = 0;
      this.power = true;
      this.epoch = 0;
      this.slots = (this.spec.slots || []).map((s) => Object.assign({}, s, { module: s.def || null }));
      this.attrs = Object.assign({}, this.spec.attrs);
      this.ports = [];
      this.rebuildPorts();
    }

    /* ---------- порты и модули ---------- */

    /** Порты модели: сначала встроенные сетевые, затем порты модулей, в конце консоль/RS-232. */
    portSpecs() {
      const out = this.spec.ports.filter((p) => !isSpecial(p)).map((p) => Object.assign({}, p));
      for (const s of this.slots) {
        const m = s.module && NS.models.module(s.module);
        if (!m) continue;
        for (const p of m.ports) out.push(Object.assign({}, p, { name: p.name.replace('{s}', String(s.n || 0)), module: s.module }));
      }
      for (const p of this.spec.ports) if (isSpecial(p)) out.push(Object.assign({}, p));
      return out;
    }

    makePort(ps) {
      const p = {
        name: ps.name, media: ps.media, speed: ps.speed, mdix: !!ps.mdix, radio: !!ps.radio, module: ps.module || null,
        mac: isSpecial(ps) ? null : this.net.allocMac(),
        adminUp: true, link: null, oper: false, stp: null, stpRole: null, bandwidth: 'auto', duplex: 'auto',
      };
      if (ps.media === 'serial') { p.clockRate = null; p.encap = 'hdlc'; }
      this.initPort(p);
      return p;
    }

    initPort() {}

    /** Пересобрать порты по модели и модулям. Существующие порты сохраняются. Возвращает карту старый→новый индекс. */
    rebuildPorts() {
      const old = this.ports;
      const byName = new Map(old.map((p) => [p.name, p]));
      const next = this.portSpecs().map((ps) => {
        const o = byName.get(ps.name);
        if (o && o.media === ps.media) {
          o.speed = ps.speed;
          o.module = ps.module || null;
          return o;
        }
        return this.makePort(ps);
      });
      const map = old.map((p) => next.indexOf(p));
      this.ports = next;
      this.portsChanged(map);
      return map;
    }

    portsChanged() {}

    portIndex(name) {
      const n = String(name).toLowerCase();
      return this.ports.findIndex((p) => p.name.toLowerCase() === n);
    }

    dataPorts() { return this.ports.filter((p) => NS.Network.isData(p)); }

    send(i, frame, why, excludeDev) { return this.net.transmit(this, i, frame, why, excludeDev); }
    timer(delay, fn) { return this.net.timer(this, delay, fn); }
    drop(frame, reason) { this.net.logDrop(this, frame, reason); }
    note(text, frame, kind) { this.net.logNote(this, text, frame, kind); }

    receive() {}
    onLinkChange() {}

    /** Перезапуск: все старые таймеры становятся недействительными (epoch). */
    reset() { this.epoch++; }
    destroy() { this.epoch++; }

    /** Время на часах устройства (как «Device Clock» в Packet Tracer). */
    clock() { return U.clockString(this.net.time, this.clockOffset || 0); }

    /* ---------- сохранение ---------- */

    serialize() {
      const modules = {};
      for (const s of this.slots) modules[s.id] = s.module;
      const out = {
        id: this.id,
        type: this.type,
        model: this.model,
        name: this.name,
        x: Math.round(this.x),
        y: Math.round(this.y),
        power: this.power,
        modules,
        attrs: Object.assign({}, this.attrs),
        ports: this.ports.map((p) => this.serializePort(p)),
        config: this.serializeConfig(),
      };
      if (this.nvram !== undefined) out.nvram = this.nvram;
      return out;
    }

    serializePort(p) {
      const o = { name: p.name, mac: p.mac, adminUp: p.adminUp };
      if (p.bandwidth !== 'auto') o.bandwidth = p.bandwidth;
      if (p.duplex !== 'auto') o.duplex = p.duplex;
      if (p.media === 'serial') { o.clockRate = p.clockRate; o.encap = p.encap; }
      return o;
    }

    serializeConfig() { return {}; }

    load(d) {
      this.name = d.name;
      this.x = Number(d.x) || 0;
      this.y = Number(d.y) || 0;
      this.power = d.power !== false;
      if (d.modules) {
        for (const s of this.slots) {
          if (!(s.id in d.modules)) continue;
          const m = d.modules[s.id];
          s.module = m && NS.models.module(m) && NS.models.module(m).kind === s.kind ? m : null;
        }
        this.rebuildPorts();
      }
      (d.ports || []).forEach((sp, i) => {
        if (!sp) return;
        let idx = sp.name ? this.portIndex(sp.name) : -1;
        if (idx < 0 && !sp.name) idx = i;
        if (idx >= 0) this.loadPort(this.ports[idx], sp);
      });
      if (d.attrs && typeof d.attrs === 'object') this.attrs = Object.assign({}, this.attrs, d.attrs);
      this.loadConfig(d.config || {});
      if (d.nvram !== undefined && this.nvram !== undefined) this.nvram = d.nvram;
    }

    loadPort(p, sp) {
      if (typeof sp.mac === 'string' && p.mac) p.mac = sp.mac;
      p.adminUp = sp.adminUp !== false;
      p.bandwidth = sp.bandwidth || 'auto';
      p.duplex = sp.duplex || 'auto';
      if (p.media === 'serial') {
        p.clockRate = Number(sp.clockRate) || null;
        p.encap = sp.encap === 'ppp' ? 'ppp' : 'hdlc';
      }
    }

    loadConfig() {}
  }

  /* ================= Концентратор ================= */

  class Hub extends Device {
    constructor(net, id, name, model) {
      super(net, id, 'hub', name, model);
    }

    receive(i, frame) {
      this.ports.forEach((p, j) => {
        if (j !== i && p.oper) this.send(j, frame, 'Концентратор повторяет сигнал во все остальные порты');
      });
    }
  }
  Hub.namePrefix = 'Hub';
  Hub.title = 'Концентратор';

  /* ================= Точка доступа ================= */

  class AccessPoint extends Device {
    constructor(net, id, name, model) {
      super(net, id, 'ap', name, model);
      this.wifi = { ssid: 'Default', security: 'open', key: '', channel: 6, enabled: true };
    }

    radioEnabled() { return this.power && this.wifi.enabled !== false; }

    radioIndex() { return this.ports.findIndex((p) => p.radio); }

    /** Мост между проводным портом и радио: клиенты Wi-Fi оказываются в одной сети с проводной частью. */
    receive(i, frame) {
      const radio = this.radioIndex();
      const wired = this.ports.findIndex((p) => !p.radio && NS.Network.isData(p));
      if (i === radio) {
        const client = this.clientByMac(frame.dst);
        if (client) {
          this.send(radio, frame, 'Точка доступа: получатель — беспроводной клиент ' + client.name);
          return;
        }
        const fromDev = this.clientByMac(frame.src);
        if (U.isMulticastMac(frame.dst)) {
          this.send(radio, frame, 'Точка доступа: широковещательный кадр — остальным клиентам Wi-Fi', fromDev ? fromDev.id : undefined);
        }
        if (wired >= 0 && this.ports[wired].oper) this.send(wired, frame, 'Точка доступа: кадр из Wi-Fi в проводную сеть');
      } else if (radio >= 0) {
        this.send(radio, frame, 'Точка доступа: кадр из проводной сети в Wi-Fi');
      }
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

    setWifi(cfg) {
      NS.validateWifi(cfg);
      Object.assign(this.wifi, cfg);
      this.net.refreshTopology();
    }

    serializeConfig() { return { wifi: Object.assign({}, this.wifi) }; }
    loadConfig(c) { if (c.wifi) Object.assign(this.wifi, c.wifi); }
  }
  AccessPoint.namePrefix = 'AccessPoint';
  AccessPoint.title = 'Точка доступа';

  /** Проверка настроек Wi-Fi (общая для точки доступа, маршрутизатора и клиентов). */
  NS.validateWifi = function (cfg) {
    if (cfg.ssid !== undefined) {
      const s = String(cfg.ssid);
      if (!s.trim() || s.length > 32) throw new Error('SSID: от 1 до 32 символов');
    }
    if (cfg.security !== undefined && cfg.security !== 'open' && cfg.security !== 'wpa2' && cfg.security !== 'wpa2-ent') throw new Error('Защита: open, wpa2 или wpa2-ent');
    if (cfg.security === 'wpa2' && cfg.key !== undefined && (String(cfg.key).length < 8 || String(cfg.key).length > 63)) {
      throw new Error('Ключ WPA2 (пароль сети): от 8 до 63 символов');
    }
    if (cfg.channel !== undefined && !(cfg.channel >= 1 && cfg.channel <= 11)) throw new Error('Канал: 1–11');
  };

  NS.Device = Device;
  NS.Hub = Hub;
  NS.AccessPoint = AccessPoint;
  NS.deviceTypes = NS.deviceTypes || {};
  NS.deviceTypes.hub = Hub;
  NS.deviceTypes.ap = AccessPoint;
})(globalThis.NetLab = globalThis.NetLab || {});
