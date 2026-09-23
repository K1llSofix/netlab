/* NetLab — общая «IOS-часть» маршрутизаторов и коммутаторов Cisco:
 * hostname, пароли (enable secret/password, service password-encryption), пользователи,
 * баннер, линии console/vty, SSH-ключи, CDP, часы и NVRAM (startup-config).
 * При включении питания/reload устройство загружает startup-config — несохранённое теряется, как в IOS. */
(function (NS) {
  'use strict';

  const U = NS.util;

  function defaultIos(dev) {
    return {
      hostname: dev.type === 'switch' ? 'Switch' : 'Router',
      enableSecret: null,
      enablePassword: null,
      encrypt: false,
      banner: '',
      domain: '',
      users: [],
      rsa: null,
      sshVer: 2,
      con: { password: null, login: 'none' },
      vty: { last: dev.type === 'switch' ? 15 : 4, password: null, login: 'line', transport: 'all', accessClass: null },
      cdp: true,
    };
  }

  const IosMixin = {
    iosInit() {
      this.ios = defaultIos(this);
      this.nvram = null;
      this.clockOffset = 0;
    },

    get hostname() { return this.ios.hostname; },

    setHostname(name) {
      const n = String(name || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(n)) throw new Error('Hostname: латиница, цифры, «-», «_», начинается с буквы');
      this.ios.hostname = n;
    },

    /* ---------- пароли ---------- */

    setEnableSecret(pw) { this.ios.enableSecret = pw == null ? null : U.secretHash(String(pw)); },
    setEnablePassword(pw) { this.ios.enablePassword = pw == null ? null : String(pw); },
    hasEnablePassword() { return !!(this.ios.enableSecret || this.ios.enablePassword); },
    checkEnable(pw) {
      if (this.ios.enableSecret) return U.secretHash(String(pw)) === this.ios.enableSecret;
      if (this.ios.enablePassword) return String(pw) === this.ios.enablePassword;
      return true;
    },

    setUser(name, pw, secret, priv) {
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(String(name))) throw new Error('Имя пользователя: латиница, цифры, «-», «_», «.»');
      this.ios.users = this.ios.users.filter((u) => u.name !== name);
      this.ios.users.push({ name: String(name), pass: secret ? U.secretHash(String(pw)) : String(pw), secret: !!secret, priv: priv || 1 });
    },

    checkUser(name, pw) {
      const u = this.ios.users.find((x) => x.name === name);
      if (!u) return false;
      return u.secret ? U.secretHash(String(pw)) === u.pass : u.pass === String(pw);
    },

    /** Можно ли подключиться по SSH: имя, домен, ключи RSA, пользователи. Возвращает причину или null. */
    sshProblem() {
      if (!this.ios.domain) return 'не задан ip domain-name';
      if (!this.ios.rsa) return 'не сгенерированы ключи RSA (crypto key generate rsa)';
      if (this.ios.vty.login !== 'local') return 'для SSH на линиях vty нужен login local';
      if (!this.ios.users.length) return 'не создан ни один пользователь (username … secret …)';
      return null;
    },

    /* ---------- NVRAM ---------- */

    /** Конфигурация, которую хранит NVRAM: настройки портов (без MAC) и всё остальное. */
    configState() {
      const config = this.serializeConfig();
      // динамика (выданные DHCP-адреса, адрес, полученный по DHCP, часы) в конфигурацию не входит
      if (config.dhcpd) delete config.dhcpd.leases;
      if (config.ios) delete config.ios.clockOffset;
      if (Array.isArray(config.ifaces)) for (const f of config.ifaces) if (f.dhcp) { f.ip = null; f.mask = null; }
      return {
        ports: this.ports.map((p) => {
          const o = Object.assign({}, this.serializePort(p));
          delete o.mac;
          return o;
        }),
        config,
      };
    },

    applyConfigState(st) {
      for (const sp of st.ports || []) {
        const i = this.portIndex(sp.name);
        if (i >= 0) this.loadPort(this.ports[i], sp);
      }
      this.loadConfig(st.config || {});
      this.net.markRouting();
    },

    /** Заводские настройки для этой модели с теми же модулями. */
    factoryState() {
      const tmp = new NS.Network();
      const fresh = new this.constructor(tmp, this.id, this.name, this.model);
      for (const s of fresh.slots) {
        const mine = this.slots.find((x) => x.id === s.id);
        s.module = mine ? mine.module : null;
      }
      fresh.rebuildPorts();
      if (fresh.syncIfaces) fresh.syncIfaces();
      return fresh.configState();
    },

    saveNvram() {
      this.nvram = { state: this.configState(), text: NS.ios && NS.ios.runningConfig ? NS.ios.runningConfig(this) : [] };
    },

    eraseNvram() { this.nvram = null; },

    /** Есть ли изменения, не сохранённые командой write / copy run start. */
    nvramDirty() {
      if (!this.nvram) return JSON.stringify(this.configState()) !== JSON.stringify(this.factoryState());
      return JSON.stringify(this.configState()) !== JSON.stringify(this.nvram.state);
    },

    /** При включении питания: загрузить startup-config (или заводские настройки). */
    onPowerOn() {
      this.applyConfigState(this.nvram ? this.nvram.state : this.factoryState());
      this.clockOffset = 0;
      this.net.emit('config', { dev: this });
    },

    /* ---------- сохранение ---------- */

    iosSerialize() {
      const s = JSON.parse(JSON.stringify(this.ios));
      s.clockOffset = this.clockOffset || 0;
      return s;
    },

    iosLoad(c) {
      const d = defaultIos(this);
      const src = c || {};
      this.ios = Object.assign(d, src, {
        con: Object.assign(d.con, src.con || {}),
        vty: Object.assign(d.vty, src.vty || {}),
        users: Array.isArray(src.users) ? src.users.map((u) => Object.assign({}, u)) : [],
      });
      delete this.ios.clockOffset;
      this.clockOffset = Number(src.clockOffset) || 0;
    },
  };

  /** Устройства Cisco по соседству через прямые кабели (для show cdp neighbors). */
  NS.cdpNeighbors = function (dev) {
    if (!dev.ios || !dev.ios.cdp || !dev.power) return [];
    const out = [];
    dev.ports.forEach((p, i) => {
      if (!p.oper || p.media === 'wireless') return;
      const pr = dev.net.peer(dev, i);
      if (!pr || !pr.dev.ios || !pr.dev.ios.cdp || !pr.dev.power) return;
      const n = pr.dev;
      const addrs = (n.ifaces || []).filter((f) => f.ip != null && f.kind !== 'loop').map((f) => f.ip);
      out.push({ dev: n, localPort: p.name, remotePort: n.ports[pr.port].name, platform: n.model, cap: n.type === 'router' ? 'R S I' : n.spec.l3 ? 'R S I' : 'S I', addrs });
    });
    return out;
  };

  NS.IosMixin = IosMixin;
  /** Подмешать IOS-часть в класс (через дескрипторы, чтобы геттеры не вычислялись заранее). */
  NS.applyIos = function (Cls) {
    Object.defineProperties(Cls.prototype, Object.getOwnPropertyDescriptors(IosMixin));
  };
})(globalThis.NetLab = globalThis.NetLab || {});
