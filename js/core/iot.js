/* NetLab — Интернет вещей (IoT), как в Packet Tracer:
 *  • умные устройства (лампа, вентилятор, дверь, окно, сирена, кофеварка, датчики движения, температуры, дыма)
 *    регистрируются на IoT-сервере по сети (TCP 1883) и принимают команды;
 *  • IoT-сервер — служба Server-PT или домашний шлюз Home Gateway DLC100 (192.168.25.1, admin/admin);
 *  • IoT Monitor на компьютере: список устройств, управление, правила «если… то…»;
 *  • платы MCU-PT и SBC-PT с пинами D0–D5, A0–A3, к которым IoT-кабелем подключаются компоненты
 *    (светодиод, зуммер, мотор, кнопка, переключатель, потенциометр, фото-, термо- и датчик движения);
 *    плата выполняет программу пользователя (вкладка «Программирование», см. script-rt.js). */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const M = NS.models;

  const PORT = 1883;
  const RETRY = 1000;

  /* ================= умные устройства: виды и свойства ================= */

  const onOff = (off, on) => ({ type: 'bool', labels: [off, on] });
  const KINDS = {
    lamp: { title: 'Умная лампа', model: 'Smart Lamp', props: { level: { type: 'enum', values: [0, 1, 2], labels: ['Выкл', 'Тускло', 'Вкл'], control: true, title: 'Свет' } } },
    fan: { title: 'Вентилятор', model: 'Smart Fan', props: { speed: { type: 'enum', values: [0, 1, 2], labels: ['Выкл', 'Медленно', 'Быстро'], control: true, title: 'Скорость' } } },
    door: { title: 'Дверь', model: 'Smart Door', props: { open: Object.assign(onOff('Закрыта', 'Открыта'), { control: true, title: 'Дверь' }), locked: Object.assign(onOff('Не заперта', 'Заперта'), { control: true, title: 'Замок' }) } },
    window: { title: 'Окно', model: 'Smart Window', props: { open: Object.assign(onOff('Закрыто', 'Открыто'), { control: true, title: 'Окно' }) } },
    siren: { title: 'Сирена', model: 'Siren', props: { on: Object.assign(onOff('Выкл', 'Вкл'), { control: true, title: 'Сирена' }) } },
    coffee: { title: 'Кофеварка', model: 'Coffee Maker', props: { brewing: Object.assign(onOff('Выкл', 'Варит кофе'), { control: true, title: 'Кофе' }) } },
    motion: { title: 'Датчик движения', model: 'Motion Detector', props: { detected: Object.assign(onOff('Нет движения', 'Движение!'), { sensor: true, title: 'Движение' }) } },
    temp: { title: 'Термометр', model: 'Temperature Monitor', props: { value: { type: 'number', min: -40, max: 80, unit: '°C', sensor: true, title: 'Температура' } } },
    smoke: { title: 'Датчик дыма', model: 'Smoke Detector', props: { level: { type: 'number', min: 0, max: 100, unit: '%', sensor: true, title: 'Дым' } } },
  };
  const INIT = { lamp: { level: 0 }, fan: { speed: 0 }, door: { open: false, locked: false }, window: { open: false }, siren: { on: false }, coffee: { brewing: false }, motion: { detected: false }, temp: { value: 22 }, smoke: { level: 0 } };

  const HOST_NIC = [{ id: 'nic', kind: 'host', label: 'Слот сетевой карты', def: 'PT-HOST-NM-1CFE' }];
  for (const [kind, k] of Object.entries(KINDS)) {
    M.MODELS[k.model] = { type: 'iot', thing: kind, title: k.title + ' (' + k.model + ')', ports: [], slots: HOST_NIC.map((s) => Object.assign({}, s)), attrs: { MTBF: 50000, cost: 80, 'power source': 0, 'rack units': 0, wattage: 5 } };
  }
  M.DEFAULT_MODEL.iot = 'Smart Lamp';

  /** Привести значение к типу свойства. Возвращает undefined, если значение недопустимо. */
  function coerce(meta, v) {
    if (!meta) return undefined;
    if (meta.type === 'bool') {
      if (v === true || v === 1 || /^(true|1|on|да|вкл|open)$/i.test(String(v))) return true;
      if (v === false || v === 0 || /^(false|0|off|нет|выкл|closed?)$/i.test(String(v))) return false;
      return undefined;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    if (meta.type === 'enum') return meta.values.includes(n) ? n : undefined;
    return Math.max(meta.min, Math.min(meta.max, Math.round(n * 10) / 10));
  }

  function propText(kind, prop, v) {
    const meta = KINDS[kind] && KINDS[kind].props[prop];
    if (!meta) return String(v);
    if (meta.type === 'bool') return meta.labels[v ? 1 : 0];
    if (meta.type === 'enum') return meta.labels[meta.values.indexOf(v)] || String(v);
    return v + ' ' + meta.unit;
  }

  /* ================= умное устройство (клиент IoT) ================= */

  class Thing extends NS.Host {
    constructor(net, id, name, model) {
      super(net, id, name, model, 'iot');
      this.thing = { kind: this.spec.thing || 'lamp', state: Object.assign({}, INIT[this.spec.thing || 'lamp']) };
      this.iot = { server: 'off', address: null, user: 'admin', pass: 'admin' };
      this.iotRt = { state: 'off', text: 'IoT-сервер не задан', conn: null, retry: null, server: null };
    }

    get kindInfo() { return KINDS[this.thing.kind]; }

    /** Изменить свойство (кнопка на устройстве, датчик, команда сервера). Возвращает текст ошибки или null. */
    thingSet(prop, value, from) {
      const meta = this.kindInfo.props[prop];
      const v = coerce(meta, value);
      if (v === undefined) return 'Недопустимое значение «' + value + '» для ' + prop;
      if (this.thing.kind === 'door' && prop === 'open' && v && this.thing.state.locked) return 'Дверь заперта — сначала отоприте';
      if (this.thing.kind === 'door' && prop === 'locked' && v && this.thing.state.open) return 'Нельзя запереть открытую дверь';
      if (this.thing.state[prop] === v) return null;
      this.thing.state[prop] = v;
      if (from === 'server') this.note('IoT: команда сервера — ' + this.kindInfo.title.toLowerCase() + ': ' + propText(this.thing.kind, prop, v), null, 'accept');
      this.iotSend({ iot: 'STATE', state: Object.assign({}, this.thing.state) });
      this.net.emit('config', { dev: this });
      return null;
    }

    iotSend(data) {
      const c = this.iotRt.conn;
      if (c && !c.done && this.iotRt.state === 'registered') c.send(data);
    }

    iotServerIp() {
      if (this.iot.server === 'gateway') return this.gateway;
      if (this.iot.server === 'remote') return this.iot.address;
      return null;
    }

    setIotServer(cfg) {
      const c = Object.assign({}, this.iot, cfg);
      if (!['off', 'gateway', 'remote'].includes(c.server)) throw new Error('Неверный режим сервера IoT');
      if (c.server === 'remote' && c.address == null) throw new Error('Укажите адрес удалённого IoT-сервера');
      this.iot = c;
      this.iotConnect();
    }

    iotStop(text) {
      const r = this.iotRt;
      if (r.retry) r.retry.cancel();
      const c = r.conn;
      this.iotRt = { state: 'off', text: text || '', conn: null, retry: null, server: null };
      if (c && !c.done && this.tcp && this.tcp.conns.get(c.key) === c) c.close();
    }

    iotConnect() {
      this.iotStop('');
      const f = this.iface;
      if (this.iot.server === 'off') { this.iotRt.text = 'IoT-сервер не задан'; this.net.emit('config', { dev: this }); return; }
      const ip = this.iotServerIp();
      if (!f || f.ip == null) { this.iotRt.state = 'failed'; this.iotRt.text = 'Нет IP-адреса'; this.net.emit('config', { dev: this }); return; }
      if (ip == null) { this.iotRt.state = 'failed'; this.iotRt.text = this.iot.server === 'gateway' ? 'Не задан шлюз (Home Gateway): получите адрес по DHCP' : 'Не задан адрес сервера'; this.net.emit('config', { dev: this }); return; }
      const r = this.iotRt;
      r.state = 'connecting';
      r.server = ip;
      r.text = 'Подключение к ' + U.ipStr(ip) + '…';
      r.conn = this.tcp.connect(ip, PORT, {
        onOpen: (c) => { if (c === this.iotRt.conn) c.send({ iot: 'REGISTER', name: this.name, kind: this.thing.kind, model: this.model, user: this.iot.user, pass: this.iot.pass, state: Object.assign({}, this.thing.state) }); },
        onData: (d, c) => { if (c === this.iotRt.conn) this.iotMsg(d); },
        onClose: (c) => { if (c === this.iotRt.conn) this.iotLost('сервер закрыл соединение'); },
        onError: (code, text, c) => { if (c === this.iotRt.conn) this.iotLost(text); },
      });
      this.net.emit('config', { dev: this });
    }

    iotLost(text) {
      const r = this.iotRt;
      if (r.state === 'registered') this.note('IoT: связь с сервером потеряна — ' + text, null, 'drop');
      r.conn = null;
      if (r.state !== 'failed' || !/отклонил/.test(r.text)) r.text = 'Не подключено: ' + text;
      r.state = 'failed';
      this.net.emit('config', { dev: this });
      if (this.iot.server !== 'off' && this.iface && this.iface.ip != null && this.ifaceUp(this.iface)) {
        r.retry = this.timer(RETRY, () => { if (this.iotRt === r && r.state === 'failed') this.iotConnect(); });
      }
    }

    iotMsg(d) {
      const r = this.iotRt;
      if (d.iot === 'REG-OK') {
        r.state = 'registered';
        r.text = 'Зарегистрировано на ' + U.ipStr(r.server);
        this.note('IoT: ' + this.name + ' зарегистрировано на сервере ' + U.ipStr(r.server), null, 'accept');
      } else if (d.iot === 'REG-FAIL') {
        r.state = 'failed';
        r.text = 'Сервер отклонил регистрацию: ' + d.text;
        const c = r.conn;
        if (c && !c.done) c.close();
      } else if (d.iot === 'SET') {
        this.thingSet(d.prop, d.value, 'server');
        return;
      } else return;
      this.net.emit('config', { dev: this });
    }

    onDhcpBound(f, d) { super.onDhcpBound(f, d); this.timer(2, () => this.iotConnect()); }
    setStatic(ip, mask, gateway, dns) { super.setStatic(ip, mask, gateway, dns); this.timer(2, () => this.iotConnect()); }
    reset() {
      super.reset();
      if (this.iotRt) { this.iotRt = { state: 'off', text: '', conn: null, retry: null, server: null }; this.timer(5, () => this.iotConnect()); }
    }
    onLinkChange(i, up) {
      super.onLinkChange(i, up);
      if (i !== (this.iface && this.iface.port)) return;
      if (!up) { this.iotStop('Нет связи'); this.net.emit('config', { dev: this }); } else if (this.iface.ip != null && !this.iface.dhcp) this.timer(5, () => this.iotConnect());
    }

    serializeConfig() {
      const c = super.serializeConfig();
      c.thing = { state: Object.assign({}, this.thing.state), iot: { server: this.iot.server, address: this.iot.address != null ? U.ipStr(this.iot.address) : null, user: this.iot.user, pass: this.iot.pass } };
      return c;
    }

    loadConfig(c) {
      super.loadConfig(c);
      const t = c.thing || {};
      const kind = this.spec.thing || 'lamp';
      this.thing = { kind, state: Object.assign({}, INIT[kind]) };
      for (const [k, v] of Object.entries(t.state || {})) { const x = coerce(KINDS[kind].props[k], v); if (x !== undefined) this.thing.state[k] = x; }
      const i = t.iot || {};
      this.iot = { server: ['off', 'gateway', 'remote'].includes(i.server) ? i.server : 'off', address: i.address ? U.parseIp(i.address) : null, user: String(i.user == null ? 'admin' : i.user), pass: String(i.pass == null ? 'admin' : i.pass) };
      if (this.iotRt) this.timer(5, () => this.iotConnect());
    }
  }
  Thing.namePrefix = 'IoT';
  Thing.title = 'Умное устройство';
  NS.deviceTypes.iot = Thing;
  NS.IotThing = Thing;

  /* ================= IoT-сервер ================= */

  const OPS = { '=': (a, b) => a === b, '!=': (a, b) => a !== b, '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b };

  /* Правило: { name, enabled, match: 'all' (И) | 'any' (ИЛИ), conds: [условие], actions: [{ thing, prop, value }] }.
   * Условие — свойство устройства { thing, prop, op, value } или расписание { type: 'time', from: 'ЧЧ:ММ', to: 'ЧЧ:ММ', days: [0..6] }
   * (по часам сервера; days пусто — каждый день, 0 — воскресенье). Старый формат { cond } тоже принимается. */
  const hm = (x) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(x == null ? '' : x).trim());
    return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const hmStr = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

  function normCond(c, name) {
    if (c && c.type === 'time') {
      const from = hm(c.from);
      const to = hm(c.to);
      if (from == null || to == null) throw new Error('Правило «' + name + '»: время укажите как ЧЧ:ММ');
      const days = Array.isArray(c.days) ? [...new Set(c.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
      return { type: 'time', from: hmStr(from), to: hmStr(to), days };
    }
    if (!c || !c.thing || !c.prop || !OPS[c.op]) throw new Error('Правило «' + name + '»: в условии укажите устройство, свойство и сравнение');
    return { thing: String(c.thing), prop: String(c.prop), op: c.op, value: c.value };
  }

  function normRule(r) {
    const name = String((r && r.name) || '').trim();
    if (!name) throw new Error('У правила должно быть имя');
    const list = Array.isArray(r.conds) ? r.conds : r.cond ? [r.cond] : [];
    if (!list.length) throw new Error('Правило «' + name + '»: добавьте хотя бы одно условие');
    const conds = list.map((c) => normCond(c, name));
    const actions = (r.actions || []).filter((a) => a && a.thing && a.prop).map((a) => ({ thing: String(a.thing), prop: String(a.prop), value: a.value }));
    if (!actions.length) throw new Error('Правило «' + name + '»: нет действий');
    return { name: name.slice(0, 40), enabled: r.enabled !== false, match: r.match === 'any' ? 'any' : 'all', conds, actions };
  }

  const condsOf = (r) => r.conds || (r.cond ? [r.cond] : []);
  const condText = (c) => (c.type === 'time' ? 'время ' + c.from + '–' + c.to + (c.days && c.days.length ? ' (' + c.days.map((d) => DAYS[d]).join(', ') + ')' : '') : c.thing + '.' + c.prop + ' ' + c.op + ' ' + c.value);
  const ruleText = (r) => condsOf(r).map(condText).join(r.match === 'any' ? ' ИЛИ ' : ' И ');

  /** Часы устройства: минуты от полуночи, день недели (0 — воскресенье), миллисекунды. */
  function clockOf(node) {
    const abs = Date.UTC(1993, 2, 1) + node.net.time * 10 + (node.clockOffset || 0);
    const d = new Date(abs);
    const min = d.getUTCHours() * 60 + d.getUTCMinutes();
    return { abs, min, day: d.getUTCDay(), text: hmStr(min) + ', ' + DAYS[d.getUTCDay()] };
  }

  function timeHolds(c, now) {
    const from = hm(c.from);
    const to = hm(c.to);
    const inRange = from === to ? true : from < to ? now.min >= from && now.min < to : now.min >= from || now.min < to;
    return inRange && (!c.days || !c.days.length || c.days.includes(now.day));
  }

  class IotService {
    constructor(node) {
      this.node = node;
      this.enabled = false;
      this.users = [{ user: 'admin', pass: 'admin' }];
      this.rules = [];
      this.things = new Map();
    }

    bind() {
      if (this.tcp !== this.node.tcp) { this.things = new Map(); this.tcp = this.node.tcp; } // устройство перезапущено
      if (!this.node.tcp) return;
      if (!this.enabled) {
        this.node.tcp.unlisten(PORT);
        for (const t of this.things.values()) if (!t.conn.done) t.conn.close();
        this.things = new Map();
        this.reschedule();
        return;
      }
      this.node.tcp.listen(PORT, (conn) => {
        conn.h = {
          onData: (d, c) => this.onMsg(c, d),
          onClose: (c) => this.dropConn(c),
          onError: (code, text, c) => this.dropConn(c),
        };
      });
      this.reschedule();
    }

    setEnabled(on) { this.enabled = !!on; this.bind(); this.node.net.emit('config', { dev: this.node }); }

    auth(user, pass) { return this.users.some((u) => u.user === String(user) && u.pass === String(pass)); }

    addUser(user, pass) {
      const u = String(user || '').trim();
      if (!/^[\w.@-]{1,32}$/.test(u)) throw new Error('Имя пользователя: латиница, цифры, «.», «-», «_», «@»');
      if (!String(pass || '')) throw new Error('Укажите пароль');
      this.users = this.users.filter((x) => x.user !== u).concat([{ user: u, pass: String(pass) }]);
    }

    removeUser(user) { this.users = this.users.filter((x) => x.user !== user); }

    thingByConn(conn) { for (const t of this.things.values()) if (t.conn === conn) return t; return null; }

    onMsg(conn, d) {
      if (!d || !d.iot) return;
      const node = this.node;
      const reply = (data) => { conn.send(data); conn.close(); };
      switch (d.iot) {
        case 'REGISTER': {
          if (!this.auth(d.user, d.pass)) {
            conn.send({ iot: 'REG-FAIL', text: 'неверные имя пользователя или пароль IoT-сервера' });
            node.note('IoT-сервер: отказ ' + d.name + ' — неверный логин/пароль', null, 'drop');
            return;
          }
          const old = this.things.get(d.name);
          if (old && old.conn !== conn && !old.conn.done) old.conn.close();
          this.things.set(String(d.name), { name: String(d.name), kind: d.kind, model: d.model, state: Object.assign({}, d.state), conn, ip: conn.rip, since: node.net.time });
          conn.send({ iot: 'REG-OK' });
          node.note('IoT-сервер: зарегистрировано «' + d.name + '» (' + (KINDS[d.kind] ? KINDS[d.kind].title : d.kind) + ', ' + U.ipStr(conn.rip) + ')', null, 'accept');
          this.evaluate();
          break;
        }
        case 'STATE': {
          const t = this.thingByConn(conn);
          if (!t) return;
          t.state = Object.assign({}, d.state);
          this.evaluate();
          break;
        }
        case 'LIST':
          if (!this.auth(d.user, d.pass)) { reply({ iot: 'DENIED', text: 'Неверное имя пользователя или пароль' }); return; }
          reply({ iot: 'LIST-OK', things: [...this.things.values()].map((t) => ({ name: t.name, kind: t.kind, model: t.model, state: Object.assign({}, t.state), ip: t.ip })), rules: JSON.parse(JSON.stringify(this.rules)), clock: clockOf(node).text });
          return;
        case 'SET': {
          if (!this.auth(d.user, d.pass)) { reply({ iot: 'DENIED', text: 'Неверное имя пользователя или пароль' }); return; }
          const t = this.things.get(String(d.thing));
          if (!t) { reply({ iot: 'ERR', text: 'Устройство «' + d.thing + '» не зарегистрировано' }); return; }
          const meta = KINDS[t.kind] && KINDS[t.kind].props[d.prop];
          if (!meta || !meta.control) { reply({ iot: 'ERR', text: 'Свойством «' + d.prop + '» нельзя управлять' }); return; }
          t.conn.send({ iot: 'SET', prop: d.prop, value: d.value });
          reply({ iot: 'SET-OK' });
          return;
        }
        case 'RULES': {
          if (!this.auth(d.user, d.pass)) { reply({ iot: 'DENIED', text: 'Неверное имя пользователя или пароль' }); return; }
          try {
            this.rules = (d.rules || []).map(normRule);
          } catch (e) { reply({ iot: 'ERR', text: e.message }); return; }
          reply({ iot: 'RULES-OK' });
          this.evaluate();
          break;
        }
        default:
          return;
      }
      node.net.emit('config', { dev: node });
    }

    dropConn(conn) {
      const t = this.thingByConn(conn);
      if (!t) return;
      this.things.delete(t.name);
      this.node.net.emit('config', { dev: this.node });
    }

    /** Условие: true / false; null — устройство не зарегистрировано или у него нет такого свойства. */
    condHolds(c, now) {
      if (c.type === 'time') return timeHolds(c, now);
      const t = this.things.get(c.thing);
      if (!t) return null;
      const meta = KINDS[t.kind] && KINDS[t.kind].props[c.prop];
      const want = coerce(meta, c.value);
      if (want === undefined || !(c.prop in t.state)) return null;
      return OPS[c.op](t.state[c.prop], want);
    }

    /** Правила: если условия выполнены (все — «И», хотя бы одно — «ИЛИ») — привести устройства в нужное состояние (команды SET).
     * Если несколько правил задают одно свойство, побеждает последнее в списке — иначе противоречащие правила переключали бы устройство бесконечно. */
    evaluate() {
      const now = clockOf(this.node);
      const want = new Map();
      for (const r of this.rules) {
        if (!r.enabled) continue;
        const res = condsOf(r).map((c) => this.condHolds(c, now));
        if (!res.length || !(r.match === 'any' ? res.some((x) => x === true) : res.every((x) => x === true))) continue;
        for (const a of r.actions) {
          const x = this.things.get(a.thing);
          if (!x) continue;
          const am = KINDS[x.kind] && KINDS[x.kind].props[a.prop];
          const v = coerce(am, a.value);
          if (v === undefined || !am.control) continue;
          want.set(a.thing + '\u0000' + a.prop, { x, r, prop: a.prop, v });
        }
      }
      for (const w of want.values()) {
        if (w.x.state[w.prop] === w.v) continue;
        this.node.note('IoT-сервер: правило «' + w.r.name + '» (' + ruleText(w.r) + ') → ' + w.x.name + ': ' + propText(w.x.kind, w.prop, w.v), null, 'info');
        w.x.conn.send({ iot: 'SET', prop: w.prop, value: w.v });
      }
      this.reschedule(now);
    }

    /** Расписание: один таймер на ближайшую границу интервала «время …–…» (без постоянного опроса). */
    reschedule(now) {
      if (this.sched) { this.sched.cancel(); this.sched = null; }
      if (!this.enabled || !this.node.tcp) return;
      const cur = ((now || clockOf(this.node)).abs % 86400000) / 60000;
      let best = null;
      for (const r of this.rules) {
        if (!r.enabled) continue;
        for (const c of condsOf(r)) {
          if (c.type !== 'time') continue;
          const marks = [hm(c.from), hm(c.to)];
          if (c.days && c.days.length) marks.push(0);
          for (const m of marks) {
            let d = m - cur;
            if (d <= 1e-9) d += 1440;
            if (best == null || d < best) best = d;
          }
        }
      }
      if (best == null) return;
      this.sched = this.node.timer(Math.ceil(best * 6000) + 1, () => { this.sched = null; this.evaluate(); });
    }

    /** Установить часы сервера (ЧЧ:ММ), дата не меняется. */
    setClock(text) {
      const m = hm(text);
      if (m == null) throw new Error('Время укажите как ЧЧ:ММ');
      const now = clockOf(this.node);
      this.node.clockOffset = (this.node.clockOffset || 0) + (m - now.min) * 60000 - (now.abs % 60000);
      this.evaluate();
      this.node.net.emit('config', { dev: this.node });
    }

    clock() { return clockOf(this.node).text; }

    serialize() {
      const o = { enabled: this.enabled, users: this.users.map((u) => Object.assign({}, u)), rules: JSON.parse(JSON.stringify(this.rules)) };
      if (this.node.clockOffset) o.clock = clockOf(this.node).abs; // показания часов на момент сохранения
      return o;
    }

    load(c) {
      if (!c) return;
      this.enabled = !!c.enabled;
      this.users = Array.isArray(c.users) ? c.users.filter((u) => u && u.user).map((u) => ({ user: String(u.user), pass: String(u.pass || '') })) : [];
      this.rules = [];
      for (const r of c.rules || []) { try { this.rules.push(normRule(r)); } catch (e) { /* пропускаем испорченное правило */ } }
      if (Number.isFinite(c.clock)) this.node.clockOffset = c.clock - (Date.UTC(1993, 2, 1) + this.node.net.time * 10);
      this.bind();
    }
  }
  NS.IotService = IotService;
  NS.iotRules = { normRule, ruleText, condText, clockOf, timeHolds, DAYS };

  IpNode.hooks.bind.push(function () {
    if (this.type === 'server' && !this.iotd) this.iotd = new IotService(this);
    if (this.iotd) this.iotd.bind();
  });

  NS.deviceExt.push({
    key: 'iotd',
    applies: (d) => !!d.iotd,
    save: (d) => d.iotd.serialize(),
    load(d, c) { if (c) d.iotd.load(c); },
  });

  /* ================= домашний шлюз Home Gateway DLC100 ================= */

  M.MODELS.DLC100 = {
    type: 'homegw', title: 'Домашний шлюз Home Gateway DLC100',
    ports: [{ name: 'Internet', media: 'copper', speed: 100 }]
      .concat([1, 2, 3, 4].map((i) => ({ name: 'Ethernet ' + i, media: 'copper', speed: 100, mdix: true })), [{ name: 'Wireless', media: 'wireless', speed: 300, radio: true }]),
    slots: [], attrs: { MTBF: 100000, cost: 120, 'power source': 0, 'rack units': 1, wattage: 15 },
  };
  M.DEFAULT_MODEL.homegw = 'DLC100';

  class HomeGateway extends NS.WirelessRouter {
    constructor(net, id, name, model) {
      super(net, id, name, model || 'DLC100');
      this.type = 'homegw';
      this.wifi.ssid = 'HomeGateway';
      this.iotd = new IotService(this);
      this.iotd.enabled = true;
      this.setLan(U.parseIp('192.168.25.1'), U.maskFromPrefix(24));
      this.bindServices();
    }
  }
  HomeGateway.namePrefix = 'Home Gateway';
  HomeGateway.title = 'Домашний шлюз IoT';
  NS.deviceTypes.homegw = HomeGateway;
  NS.HomeGateway = HomeGateway;

  /* ================= IoT Monitor на компьютере ================= */

  IpNode.prototype.iotRequest = function (server, msg, cb) {
    return this.tcpRequest(server, PORT, msg, (d) => d && ['LIST-OK', 'SET-OK', 'RULES-OK', 'DENIED', 'ERR'].includes(d.iot), (r) => {
      if (!r.ok) { cb({ ok: false, error: r.error }); return; }
      if (r.data.iot === 'DENIED' || r.data.iot === 'ERR') { cb({ ok: false, error: r.data.text }); return; }
      cb({ ok: true, data: r.data });
    });
  };
  IpNode.prototype.iotList = function (server, user, pass, cb) { return this.iotRequest(server, { iot: 'LIST', user, pass }, cb); };
  IpNode.prototype.iotControl = function (server, user, pass, thing, prop, value, cb) { return this.iotRequest(server, { iot: 'SET', user, pass, thing, prop, value }, cb); };
  IpNode.prototype.iotSaveRules = function (server, user, pass, rules, cb) { return this.iotRequest(server, { iot: 'RULES', user, pass, rules }, cb); };

  /* ================= платы и компоненты (IoT-кабель) ================= */

  const PINS = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'A0', 'A1', 'A2', 'A3'];
  const pinPorts = () => PINS.map((n) => ({ name: n, media: 'iot', speed: 0 }));

  M.MODELS['MCU-PT'] = { type: 'mcu', title: 'Микроконтроллер MCU-PT', ports: pinPorts(), slots: [], attrs: { MTBF: 50000, cost: 30, 'power source': 0, 'rack units': 0, wattage: 1 } };
  M.MODELS['SBC-PT'] = { type: 'sbc', title: 'Одноплатный компьютер SBC-PT', ports: pinPorts(), slots: HOST_NIC.map((s) => Object.assign({}, s)), attrs: { MTBF: 50000, cost: 60, 'power source': 0, 'rack units': 0, wattage: 5 } };
  Object.assign(M.DEFAULT_MODEL, { mcu: 'MCU-PT', sbc: 'SBC-PT', iotcomp: 'LED' });

  const COMPS = {
    LED: { kind: 'led', title: 'Светодиод', out: true },
    Buzzer: { kind: 'buzzer', title: 'Зуммер', out: true },
    Motor: { kind: 'motor', title: 'Мотор', out: true, analog: true },
    'Push Button': { kind: 'button', title: 'Кнопка', in: true },
    'Toggle Switch': { kind: 'switch', title: 'Переключатель', in: true },
    Potentiometer: { kind: 'pot', title: 'Потенциометр', in: true, analog: true, def: 512 },
    'Photo Sensor': { kind: 'photo', title: 'Фотодатчик', in: true, analog: true, def: 600 },
    'Temperature Sensor': { kind: 'tempsensor', title: 'Датчик температуры', in: true, analog: true, def: 512 },
    'Motion Sensor': { kind: 'pir', title: 'Датчик движения', in: true },
  };
  for (const [model, c] of Object.entries(COMPS)) {
    M.MODELS[model] = { type: 'iotcomp', comp: c.kind, title: c.title + ' (' + model + ')', ports: [{ name: 'IoT0', media: 'iot', speed: 0 }], slots: [], attrs: { MTBF: 50000, cost: 5, 'power source': 0, 'rack units': 0, wattage: 0.1 } };
  }

  class Component extends NS.Device {
    constructor(net, id, name, model) {
      super(net, id, 'iotcomp', name, model);
      this.info = Object.values(COMPS).find((c) => c.kind === this.spec.comp) || COMPS.LED;
      this.value = this.info.def || 0;
    }
    /** Цифровое значение (0/1) и аналоговое (0–1023). */
    reading() {
      const a = this.info.analog ? this.value : (this.value ? 1023 : 0);
      return { d: this.value >= (this.info.analog ? 512 : 1) ? 1 : 0, a };
    }
    serializeConfig() { return { value: this.value }; }
    loadConfig(c) { const v = Number(c && c.value); this.value = Number.isFinite(v) ? Math.max(0, Math.min(1023, v)) : this.info.def || 0; }
  }
  Component.namePrefix = 'Comp';
  Component.title = 'IoT-компонент';
  NS.deviceTypes.iotcomp = Component;

  function programOf(d) {
    if (!d.program) d.program = { code: DEFAULT_CODE };
    return d.program;
  }
  /** Программа платы: код, язык (js | python | blocks) и блоки визуального редактора; язык и блоки — только если заданы. */
  function saveProgram(p) {
    const o = { code: p.code };
    if (p.lang && p.lang !== 'js') o.lang = p.lang;
    if (p.blocks) o.blocks = JSON.parse(JSON.stringify(p.blocks));
    return o;
  }
  function loadProgram(c) {
    if (c && c.lang === 'js') delete c.lang;
    const p = { code: c && typeof c.code === 'string' ? c.code : DEFAULT_CODE };
    if (c && (c.lang === 'python' || c.lang === 'blocks')) p.lang = c.lang;
    if (c && c.blocks && typeof c.blocks === 'object') p.blocks = c.blocks;
    return p;
  }
  const DEFAULT_CODE = '// Мигание светодиодом на пине D0\n// Подключите «LED» IoT-кабелем к D0 и нажмите «Запустить»\n\nfunction setup() {\n  pinMode(0, OUTPUT);\n  Serial.println("Старт");\n}\n\nfunction loop() {\n  digitalWrite(0, HIGH);\n  delay(500);\n  digitalWrite(0, LOW);\n  delay(500);\n}\n';

  class Mcu extends NS.Device {
    constructor(net, id, name, model) {
      super(net, id, 'mcu', name, model);
      this.program = { code: DEFAULT_CODE };
      this.pinOut = {};
    }
    reset() { super.reset(); this.pinOut = {}; this.net.emit('program-stop', { dev: this }); }
    serializeConfig() { return { program: saveProgram(this.program) }; }
    loadConfig(c) { this.program = loadProgram(c && c.program); }
  }
  Mcu.namePrefix = 'MCU';
  Mcu.title = 'Микроконтроллер';
  NS.deviceTypes.mcu = Mcu;

  const Sbc = NS.hostClass('sbc', 'SBC', 'Одноплатный компьютер');
  NS.deviceExt.push({
    key: 'program',
    applies: (d) => d.type === 'sbc',
    save: (d) => saveProgram(programOf(d)),
    load(d, c) { d.program = loadProgram(c); },
  });
  IpNode.hooks.runtime.push(function () { if (this.type === 'sbc') { programOf(this); this.pinOut = {}; } });

  const IOT = {
    PORT,
    KINDS,
    COMPS,
    PINS,
    DEFAULT_CODE,
    coerce,
    propText,
    isBoard: (d) => !!d && (d.type === 'mcu' || d.type === 'sbc'),
    program: programOf,

    /** Компонент, подключённый к пину платы. */
    compAt(board, pin) {
      const i = board.portIndex(pin);
      if (i < 0) return null;
      const pr = board.net.peer(board, i);
      return pr && pr.dev.type === 'iotcomp' ? pr.dev : null;
    },

    /** Прочитать пин: 'digital' → 0/1, 'analog' → 0–1023. */
    read(board, pin, mode) {
      const c = IOT.compAt(board, pin);
      const out = board.pinOut && board.pinOut[pin];
      let r;
      if (c && c.info.in) r = c.reading();
      else if (out != null) r = { d: out > 0 ? 1 : 0, a: out };
      else r = { d: 0, a: 0 };
      return mode === 'digital' ? r.d : r.a;
    },

    /** Все входы платы для потока программы: { D0: {d, a}, … }. */
    inputs(board) {
      const o = {};
      for (const p of PINS) { const c = IOT.compAt(board, p); if (c && c.info.in) o[p] = c.reading(); }
      return o;
    },

    /** Записать в пин (0–1023): подключённый исполнительный компонент меняет состояние. */
    write(board, pin, value) {
      if (!board.power) return;
      if (!board.pinOut) board.pinOut = {};
      const v = Math.max(0, Math.min(1023, Math.round(Number(value) || 0)));
      if (board.pinOut[pin] === v) return;
      board.pinOut[pin] = v;
      const c = IOT.compAt(board, pin);
      if (c && c.info.out) {
        const nv = c.info.analog ? v : (v > 0 ? 1 : 0);
        if (c.value !== nv) { c.value = nv; board.net.emit('config', { dev: c }); }
      }
      board.net.emit('config', { dev: board });
    },

    /** Датчик изменил значение (пользователь нажал кнопку, покрутил потенциометр…). */
    setComp(c, value) {
      const v = Math.max(0, Math.min(1023, Math.round(Number(value) || 0)));
      c.value = c.info.analog ? v : (v > 0 ? 1 : 0);
      c.net.emit('config', { dev: c });
      const i = c.ports.findIndex((p) => p.media === 'iot');
      const pr = i >= 0 ? c.net.peer(c, i) : null;
      if (pr && IOT.isBoard(pr.dev)) c.net.emit('pins', { dev: pr.dev });
    },

    /** Плата для компонента (если подключён). */
    boardOf(c) {
      const pr = c.ports.length ? c.net.peer(c, 0) : null;
      return pr && IOT.isBoard(pr.dev) ? { board: pr.dev, pin: pr.dev.ports[pr.port].name } : null;
    },
  };
  NS.iot = IOT;
  NS.IotBoards = { Mcu, Sbc, Component };

  // выключили плату — выходы гаснут
  const setPower = NS.Network.prototype.setPower;
  NS.Network.prototype.setPower = function (dev, on) {
    const r = setPower.call(this, dev, on);
    if (dev && IOT.isBoard(dev) && !on) {
      for (const p of PINS) {
        const c = IOT.compAt(dev, p);
        if (c && c.info.out && c.value) { c.value = 0; this.emit('config', { dev: c }); }
      }
      dev.pinOut = {};
    }
    return r;
  };

  /* ================= описание пакетов ================= */

  const MSG = {
    REGISTER: (d) => 'регистрация «' + d.name + '» (' + (KINDS[d.kind] ? KINDS[d.kind].title : d.kind) + ')',
    'REG-OK': () => 'регистрация принята',
    'REG-FAIL': (d) => 'отказ: ' + d.text,
    STATE: (d) => 'состояние ' + Object.entries(d.state || {}).map(([k, v]) => k + '=' + v).join(', '),
    SET: (d) => (d.thing ? 'IoT Monitor: ' + d.thing + '.' : 'команда: ') + d.prop + ' = ' + d.value,
    LIST: () => 'IoT Monitor: список устройств',
    'LIST-OK': (d) => 'устройств: ' + (d.things || []).length,
    RULES: (d) => 'IoT Monitor: сохранить правила (' + (d.rules || []).length + ')',
    'RULES-OK': () => 'правила сохранены',
    'SET-OK': () => 'команда принята',
    DENIED: () => 'доступ запрещён',
    ERR: (d) => 'ошибка: ' + d.text,
  };
  const iotOf = (f) => {
    if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'TCP') return null;
    const s = f.payload.payload;
    return s && (s.sport === PORT || s.dport === PORT) && s.data && s.data.iot ? s.data : null;
  };
  P.register({
    protocols: { IOT: { label: 'IoT', color: '#7c3aed' } },
    classify: (f) => (iotOf(f) ? 'IOT' : null),
    summary(f) {
      const d = iotOf(f);
      if (!d) return null;
      return 'IoT: ' + (MSG[d.iot] ? MSG[d.iot](d) : d.iot) + ', ' + U.ipStr(f.payload.src) + ' → ' + U.ipStr(f.payload.dst);
    },
    extraLayers(f, out) {
      const d = iotOf(f);
      if (!d) return;
      const fields = [['Сообщение', d.iot], ['Смысл', MSG[d.iot] ? MSG[d.iot](d) : '']];
      if (d.user) fields.push(['Пользователь', d.user], ['Пароль', '••••']);
      out.push({ title: 'IoT (регистрация и управление, TCP ' + PORT + ')', fields });
    },
  });
})(globalThis.NetLab = globalThis.NetLab || {});
