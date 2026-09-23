/* NetLab — коммутируемый доступ (Dial-up): модем в ПК (модуль PT-HOST-NM-1AM), телефонная сеть
 * Cloud-PT с номерами на портах, звонок, проверка логина и пароля на принимающей стороне,
 * соединение PPP «точка-точка» с выдачей адреса (программа «Dial-up» на рабочем столе). */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const M = NS.models;

  const CALL_TIMEOUT = 300;

  /* ================= модели ================= */

  M.MODULES['PT-HOST-NM-1AM'] = { kind: 'host', title: 'PT-HOST-NM-1AM', desc: 'Аналоговый модем 56 кбит/с. Подключается телефонным кабелем к порту Modem облака Cloud-PT (телефонная сеть). Программа «Dial-up» на рабочем столе.', ports: [{ name: 'Modem0', media: 'phone', speed: 0.056 }] };
  M.MODULES['PT-LAPTOP-NM-1AM'] = { kind: 'laptop', title: 'PT-LAPTOP-NM-1AM', desc: 'Аналоговый модем для ноутбука (56 кбит/с).', ports: [{ name: 'Modem0', media: 'phone', speed: 0.056 }] };
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  M.MODELS['Cloud-PT'] = {
    type: 'cloud', title: 'Телефонная сеть Cloud-PT',
    ports: range(8, (i) => ({ name: 'Modem' + i, media: 'phone', speed: 0.056 })),
    slots: [], attrs: { MTBF: 100000, cost: 0, 'power source': 0, 'rack units': 0, wattage: 0 },
  };
  M.DEFAULT_MODEL.cloud = 'Cloud-PT';

  /* ================= телефонная сеть ================= */

  class PhoneCloud extends NS.Device {
    constructor(net, id, name, model) {
      super(net, id, 'cloud', name, model);
      this.numbers = {};
      this.ports.forEach((p, i) => { this.numbers[p.name] = '555' + String(1000 + i); });
      this.calls = new Map();
    }

    reset() { super.reset(); this.calls = new Map(); }

    numberOf(i) { return this.numbers[this.ports[i].name] || ''; }

    setNumber(portName, num) {
      const n = String(num || '').trim();
      if (n && !/^[0-9*#+]{2,15}$/.test(n)) throw new Error('Номер: 2–15 цифр');
      if (n && Object.entries(this.numbers).some(([k, v]) => k !== portName && v === n)) throw new Error('Номер ' + n + ' уже назначен другому порту');
      this.numbers[portName] = n;
    }

    reply(i, data, why) { this.send(i, { src: null, dst: null, type: 'MODEM', vlan: null, payload: data, hops: 0, encap: 'PSTN' }, why); }

    receive(i, frame) {
      const d = frame.payload || {};
      const peer = this.calls.get(i);
      switch (d.op) {
        case 'DIAL': {
          const j = this.ports.findIndex((p, k) => this.numberOf(k) === String(d.number));
          if (j < 0) { this.reply(i, { op: 'NO-CARRIER', text: 'Номер ' + d.number + ' не существует' }, 'Телефонная сеть: номер не найден'); return; }
          if (j === i) { this.reply(i, { op: 'BUSY', text: 'Это ваш собственный номер' }, 'Телефонная сеть: звонок самому себе'); return; }
          if (this.calls.has(j)) { this.reply(i, { op: 'BUSY', text: 'Абонент занят' }, 'Телефонная сеть: занято'); return; }
          if (!this.net.isPortOperational(this, j)) { this.reply(i, { op: 'NO-ANSWER', text: 'Абонент не отвечает (модем не подключён или выключен)' }, 'Телефонная сеть: нет ответа'); return; }
          this.calls.set(i, j);
          this.calls.set(j, i);
          this.reply(j, Object.assign({}, d, { op: 'RING', from: this.numberOf(i) }), 'Телефонная сеть: вызов ' + this.numberOf(i) + ' → ' + d.number);
          return;
        }
        case 'ANSWER':
        case 'REJECT':
        case 'DATA':
        case 'HANGUP':
          if (peer == null) { this.drop(frame, 'Нет активного звонка на ' + this.ports[i].name); return; }
          this.send(peer, frame, 'Телефонная сеть: передаю ' + (d.op === 'DATA' ? 'данные' : d.op) + ' по установленному соединению');
          if (d.op === 'REJECT' || d.op === 'HANGUP') { this.calls.delete(i); this.calls.delete(peer); }
          return;
        default:
          this.drop(frame, 'Неизвестный сигнал модема');
      }
    }

    onLinkChange(i, up) {
      if (up) return;
      const peer = this.calls.get(i);
      if (peer == null) return;
      this.calls.delete(i);
      this.calls.delete(peer);
      this.reply(peer, { op: 'HANGUP', text: 'Соединение прервано (линия отключена)' }, 'Телефонная сеть: абонент отключился');
    }

    serializeConfig() { return { numbers: Object.assign({}, this.numbers) }; }
    loadConfig(c) { if (c && c.numbers) Object.assign(this.numbers, c.numbers); }
  }
  PhoneCloud.namePrefix = 'Cloud';
  PhoneCloud.title = 'Телефонная сеть';
  NS.deviceTypes.cloud = PhoneCloud;
  NS.PhoneCloud = PhoneCloud;

  /* ================= модем в ПК ================= */

  if (NS.Host) {
    const sync = NS.Host.prototype.syncIfaces;
    NS.Host.prototype.syncIfaces = function () {
      sync.call(this);
      const f = this.iface;
      if (!f) return;
      const modem = f.port >= 0 && this.ports[f.port] && this.ports[f.port].media === 'phone';
      if (modem) { f.kind = 'dialup'; f.p2p = true; } else if (f.kind === 'dialup') { f.kind = 'phys'; f.p2p = false; }
    };
  }

  IpNode.ifaceUpHooks.dialup = function (f) {
    return !!this.dialup && this.dialup.state === 'up' && this.net.isPortOperational(this, f.port);
  };

  const modemFrame = (data) => ({ src: null, dst: null, type: 'MODEM', vlan: null, payload: data, hops: 0, encap: 'PPP' });

  IpNode.ifaceSenders.dialup = function (f, pkt, why) {
    return this.send(f.port, modemFrame({ op: 'DATA', payload: pkt }), why || 'Модем: пакет по коммутируемому каналу');
  };

  IpNode.prototype.dialinCfg = function () {
    if (!this.dialin) this.dialin = { enabled: false, ip: null, pool: null, users: [] };
    return this.dialin;
  };

  /** Позвонить. cb({ok, ip, error}). */
  IpNode.prototype.dial = function (number, user, pass, cb) {
    const f = this.iface;
    if (!f || f.kind !== 'dialup') { cb({ ok: false, error: 'В компьютере нет модема. Выключите его и поставьте модуль PT-HOST-NM-1AM на вкладке «Физический вид».' }); return; }
    if (!this.net.isPortOperational(this, f.port)) { cb({ ok: false, error: 'Модем не подключён к телефонной линии (телефонный кабель к Cloud-PT)' }); return; }
    if (this.dialup && this.dialup.state === 'up') this.hangup();
    const d = { state: 'dialing', number: String(number || ''), user: String(user || ''), cb, timer: null, text: 'Набор номера ' + number + '…' };
    this.dialup = d;
    this.send(f.port, modemFrame({ op: 'DIAL', number: d.number, user: d.user, pass: String(pass || '') }), 'Модем: набираю номер ' + d.number);
    d.timer = this.timer(CALL_TIMEOUT, () => this.dialFinish({ ok: false, error: 'Нет ответа (истекло время ожидания)' }));
  };

  IpNode.prototype.dialFinish = function (r) {
    const d = this.dialup;
    if (!d) return;
    if (d.timer) { d.timer.cancel(); d.timer = null; }
    if (!r.ok) { d.state = 'down'; d.text = r.error; }
    const cb = d.cb;
    d.cb = null;
    if (cb) cb(r);
    this.net.markRouting();
    this.net.emit('config', { dev: this });
  };

  IpNode.prototype.hangup = function () {
    const f = this.iface;
    if (this.dialup && (this.dialup.state === 'up' || this.dialup.state === 'dialing') && f && f.kind === 'dialup') {
      this.send(f.port, modemFrame({ op: 'HANGUP' }), 'Модем: кладу трубку');
    }
    this.dialLinkDown('Соединение завершено');
  };

  IpNode.prototype.dialLinkDown = function (text) {
    const f = this.iface;
    if (this.dialup && this.dialup.timer) this.dialup.timer.cancel();
    this.dialup = { state: 'down', text };
    if (f && f.kind === 'dialup' && !(this.dialin && this.dialin.enabled)) { f.ip = null; f.mask = null; }
    if (f) f.peer = null;
    this.flushIface(f, 'down');
    this.net.markRouting();
    this.net.emit('config', { dev: this });
  };

  IpNode.portReceivers.phone = function (i, frame) {
    const d = frame.payload || {};
    const f = this.iface;
    if (!f || f.port !== i) return;
    switch (d.op) {
      case 'RING': {
        const cfg = this.dialinCfg();
        const reject = (text) => this.send(i, modemFrame({ op: 'REJECT', text }), 'Модем: вызов отклонён — ' + text);
        if (!cfg.enabled) { reject('на этом компьютере не включён приём звонков (Dial-in)'); return; }
        if (!cfg.users.some((u) => u.user === d.user && u.pass === d.pass)) { reject('неверный логин или пароль'); return; }
        if (cfg.ip == null || cfg.pool == null) { reject('не заданы адреса для соединения'); return; }
        this.dialup = { state: 'up', number: d.from, user: d.user, text: 'Входящее соединение от ' + d.from, since: this.net.time };
        f.ip = cfg.ip;
        f.mask = 0xFFFFFFFF;
        f.peer = cfg.pool;
        this.send(i, modemFrame({ op: 'ANSWER', ip: cfg.pool, peer: cfg.ip }), 'Модем: снимаю трубку, звонящему выдан адрес ' + U.ipStr(cfg.pool));
        this.note('Dial-up: входящее соединение от ' + d.from + ' (' + d.user + ')', frame, 'accept');
        this.net.markRouting();
        this.net.emit('config', { dev: this });
        return;
      }
      case 'ANSWER': {
        const dd = this.dialup;
        if (!dd || dd.state !== 'dialing') return;
        dd.state = 'up';
        dd.text = 'Подключено к ' + dd.number;
        dd.since = this.net.time;
        f.ip = d.ip;
        f.mask = 0xFFFFFFFF;
        f.peer = d.peer;
        this.dialFinish({ ok: true, ip: d.ip, peer: d.peer });
        return;
      }
      case 'REJECT':
      case 'BUSY':
      case 'NO-CARRIER':
      case 'NO-ANSWER':
        if (this.dialup && this.dialup.state === 'dialing') this.dialFinish({ ok: false, error: d.text || d.op });
        return;
      case 'HANGUP':
        if (this.dialup && this.dialup.state === 'dialing') this.dialFinish({ ok: false, error: d.text || 'Соединение прервано' });
        else this.dialLinkDown(d.text || 'Удалённая сторона положила трубку');
        return;
      case 'DATA':
        if (!this.dialup || this.dialup.state !== 'up') { this.drop(frame, 'Модем: нет соединения'); return; }
        this.onIp(f, d.payload, frame);
        return;
      default:
        this.drop(frame, 'Модем: неизвестный сигнал');
    }
  };

  IpNode.hooks.runtime.push(function () {
    if (this.dialup) this.dialup = { state: 'down', text: 'Нет соединения' };
    const f = this.ifaces && this.ifaces[0];
    if (f && f.kind === 'dialup') { f.peer = null; if (!(this.dialin && this.dialin.enabled)) { f.ip = null; f.mask = null; } }
  });

  NS.deviceExt.push({
    key: 'dialin',
    applies: (d) => !!d.sendMail,
    save(d) {
      const c = d.dialin;
      if (!c || (!c.enabled && !c.users.length)) return null;
      return { enabled: !!c.enabled, ip: c.ip != null ? U.ipStr(c.ip) : null, pool: c.pool != null ? U.ipStr(c.pool) : null, users: c.users.map((u) => Object.assign({}, u)) };
    },
    load(d, c) {
      d.dialin = c ? { enabled: !!c.enabled, ip: c.ip ? U.parseIp(c.ip) : null, pool: c.pool ? U.parseIp(c.pool) : null, users: (c.users || []).map((u) => ({ user: String(u.user), pass: String(u.pass) })) } : null;
    },
  });

  /** Настроить приём звонков (Dial-in). */
  IpNode.prototype.setDialin = function (cfg) {
    const c = this.dialinCfg();
    if (cfg.ip !== undefined) c.ip = cfg.ip;
    if (cfg.pool !== undefined) c.pool = cfg.pool;
    if (cfg.enabled !== undefined) c.enabled = !!cfg.enabled;
    if (cfg.users) c.users = cfg.users;
    if (c.enabled && (c.ip == null || c.pool == null)) throw new Error('Укажите свой адрес и адрес для звонящего');
    if (c.enabled && c.ip === c.pool) throw new Error('Адреса сторон должны различаться');
  };

  /* ================= описание пакетов ================= */

  const OPS = { DIAL: 'набор номера', RING: 'входящий вызов', ANSWER: 'ответ, соединение установлено', REJECT: 'вызов отклонён', BUSY: 'занято', 'NO-CARRIER': 'нет несущей', 'NO-ANSWER': 'нет ответа', HANGUP: 'отбой', DATA: 'данные' };

  P.register({
    protocols: { MODEM: { label: 'Модем (PPP)', color: '#a16207' } },
    ethertypes: { MODEM: 'PSTN / PPP' },
    classify(f) {
      if (f.type !== 'MODEM') return null;
      if (f.payload && f.payload.op === 'DATA' && f.payload.payload) return P.classify({ type: 'IPv4', payload: f.payload.payload });
      return 'MODEM';
    },
    summary(f) {
      if (f.type !== 'MODEM') return null;
      const d = f.payload || {};
      if (d.op === 'DATA') return 'Модем: ' + P.summary({ type: 'IPv4', payload: d.payload });
      return 'Модем: ' + (OPS[d.op] || d.op) + (d.number ? ' ' + d.number : '') + (d.text ? ' — ' + d.text : '');
    },
    layers(f) {
      if (f.type !== 'MODEM') return null;
      const d = f.payload || {};
      const out = [{ title: 'Телефонная линия (PSTN), PPP', fields: [['Сигнал', OPS[d.op] || d.op]].concat(d.number ? [['Номер', d.number]] : [], d.user ? [['Пользователь', d.user]] : [], d.ip != null ? [['Выданный адрес', U.ipStr(d.ip)]] : []) }];
      if (d.op === 'DATA') return out.concat(P.layers({ type: 'IPv4', payload: d.payload }).slice(1));
      return out;
    },
  });
})(globalThis.NetLab = globalThis.NetLab || {});
