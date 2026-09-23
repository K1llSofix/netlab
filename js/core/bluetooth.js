/* NetLab — Bluetooth: встроенный адаптер у ноутбука, планшета и смартфона, Bluetooth-колонка и гарнитура.
 * Поиск устройств в радиусе действия (по расстоянию на схеме), сопряжение по PIN, воспроизведение музыки
 * (профиль A2DP) и передача файлов между компьютерами (OBEX). Не IP: пакеты показываются в журнале событий. */
(function (NS) {
  'use strict';

  const P = NS.packets;
  const M = NS.models;

  /** Радиус действия (класс 2, ~10 м) в единицах схемы. */
  const RANGE = 260;
  const BT_TYPES = new Set(['laptop', 'tablet', 'smartphone', 'btspeaker', 'btheadset']);
  const AUDIO = new Set(['btspeaker', 'btheadset']);

  /* ================= модели ================= */

  M.MODELS['Smartphone-PT'] = {
    type: 'smartphone', title: 'Смартфон Smartphone-PT', ports: [{ name: 'Wireless0', media: 'wireless', speed: 300 }],
    slots: [], attrs: { MTBF: 30000, cost: 400, 'power source': 0, 'rack units': 0, wattage: 5 },
  };
  M.MODELS['BT-Speaker'] = { type: 'btspeaker', title: 'Bluetooth-колонка', ports: [], slots: [], attrs: { MTBF: 30000, cost: 60, 'power source': 0, 'rack units': 0, wattage: 10 } };
  M.MODELS['BT-Headset'] = { type: 'btheadset', title: 'Bluetooth-гарнитура', ports: [], slots: [], attrs: { MTBF: 30000, cost: 40, 'power source': 0, 'rack units': 0, wattage: 1 } };
  Object.assign(M.DEFAULT_MODEL, { smartphone: 'Smartphone-PT', btspeaker: 'BT-Speaker', btheadset: 'BT-Headset' });

  if (NS.hostClass) NS.hostClass('smartphone', 'Smartphone', 'Смартфон');

  /* ================= аудиоустройства ================= */

  class BtAudio extends NS.Device {
    constructor(net, id, name, model, type) {
      super(net, id, type, name, model);
      this.bt = { on: true, pin: '0000', paired: [] };
      this.btRt = { source: null, playing: null };
    }

    reset() { super.reset(); this.btRt = { source: null, playing: null }; }

    serializeConfig() { return { bt: { on: this.bt.on, pin: this.bt.pin, paired: this.bt.paired.slice() } }; }
    loadConfig(c) {
      const b = (c && c.bt) || {};
      this.bt = { on: b.on !== false, pin: /^\d{4,8}$/.test(String(b.pin || '')) ? String(b.pin) : '0000', paired: Array.isArray(b.paired) ? b.paired.map(String) : [] };
    }
  }

  function audioClass(type, prefix, title) {
    class A extends BtAudio {
      constructor(net, id, name, model) { super(net, id, name, model, type); }
    }
    A.namePrefix = prefix;
    A.title = title;
    NS.deviceTypes[type] = A;
    return A;
  }
  audioClass('btspeaker', 'Speaker', 'Bluetooth-колонка');
  audioClass('btheadset', 'Headset', 'Bluetooth-гарнитура');

  /* ================= общие функции ================= */

  const has = (d) => !!d && BT_TYPES.has(d.type);

  function cfg(d) {
    if (!d.bt) d.bt = { on: true, pin: '0000', paired: [] };
    if (!d.btRt) d.btRt = { source: null, playing: null, audio: null, received: [] };
    return d.bt;
  }

  const distance = (a, b) => Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
  const alive = (d) => has(d) && d.power && cfg(d).on;
  const inRange = (a, b) => distance(a, b) <= RANGE;

  function frame(op, from, to, extra) {
    return { type: 'BT', src: null, dst: null, vlan: null, payload: Object.assign({ op, from: from.name, to: to ? to.name : null }, extra || {}) };
  }

  function log(net, dev, text, f, kind) { net.logNote(dev, text, f, kind || 'info'); }

  const BT = {
    RANGE,
    has,
    isAudio: (d) => !!d && AUDIO.has(d.type),
    cfg,
    distance,
    inRange,

    /** Включить/выключить адаптер. */
    setOn(d, on) {
      cfg(d).on = !!on;
      if (!on) BT.dropAll(d, 'Bluetooth выключен');
      d.net.emit('config', { dev: d });
    },

    /** Устройства Bluetooth поблизости: [{dev, distance, paired}]. */
    scan(d) {
      if (!alive(d)) return [];
      const out = [];
      for (const o of d.net.devices.values()) {
        if (o === d || !alive(o) || !inRange(d, o)) continue;
        out.push({ dev: o, distance: Math.round(distance(d, o)), paired: cfg(d).paired.includes(o.id) });
      }
      out.sort((a, b) => a.distance - b.distance);
      log(d.net, d, 'Bluetooth: поиск устройств — найдено ' + out.length, frame('INQUIRY', d, null, { found: out.map((x) => x.dev.name) }));
      return out;
    },

    /** Сопряжение. Возвращает текст ошибки или null. */
    pair(d, o, pin) {
      if (!alive(d)) return 'Bluetooth на ' + d.name + ' выключен';
      if (!alive(o)) return o.name + ': Bluetooth выключен или нет питания';
      if (!inRange(d, o)) return o.name + ' вне радиуса действия Bluetooth (поднесите ближе)';
      const need = cfg(o).pin || '0000';
      if (BT.isAudio(o) && String(pin == null ? '0000' : pin) !== need) {
        log(d.net, d, 'Bluetooth: сопряжение с ' + o.name + ' отклонено — неверный PIN', frame('PAIR', d, o, { ok: false }), 'drop');
        return 'Неверный PIN-код (у колонок и гарнитур обычно 0000)';
      }
      for (const [a, b] of [[d, o], [o, d]]) if (!cfg(a).paired.includes(b.id)) cfg(a).paired.push(b.id);
      log(d.net, d, 'Bluetooth: ' + d.name + ' и ' + o.name + ' сопряжены', frame('PAIR', d, o, { ok: true }), 'accept');
      d.net.emit('config', { dev: d });
      d.net.emit('config', { dev: o });
      return null;
    },

    unpair(d, o) {
      for (const [a, b] of [[d, o], [o, d]]) {
        cfg(a).paired = cfg(a).paired.filter((x) => x !== b.id);
      }
      if (d.btRt.audio === o.id) BT.disconnectAudio(d);
      if (o.btRt && o.btRt.audio === d.id) BT.disconnectAudio(o);
      d.net.emit('config', { dev: d });
    },

    /** Подключить колонку/гарнитуру как аудиовыход. */
    connectAudio(d, o) {
      if (!BT.isAudio(o)) return o.name + ' — не аудиоустройство';
      if (!cfg(d).paired.includes(o.id)) return 'Сначала выполните сопряжение с ' + o.name;
      if (!alive(d) || !alive(o)) return 'Bluetooth выключен или нет питания';
      if (!inRange(d, o)) return o.name + ' вне радиуса действия';
      const busy = o.btRt.source && o.btRt.source !== d.id ? d.net.getDevice(o.btRt.source) : null;
      if (busy) return o.name + ' уже подключена к ' + busy.name;
      if (d.btRt.audio && d.btRt.audio !== o.id) BT.disconnectAudio(d);
      d.btRt.audio = o.id;
      o.btRt.source = d.id;
      log(d.net, d, 'Bluetooth A2DP: звук ' + d.name + ' выводится на ' + o.name, frame('A2DP-CONNECT', d, o), 'accept');
      d.net.emit('config', { dev: d });
      d.net.emit('config', { dev: o });
      return null;
    },

    disconnectAudio(d) {
      const o = d.btRt && d.btRt.audio ? d.net.getDevice(d.btRt.audio) : null;
      if (d.btRt) { d.btRt.audio = null; d.btRt.track = null; }
      if (o && o.btRt) { o.btRt.source = null; o.btRt.playing = null; d.net.emit('config', { dev: o }); }
    },

    /** Включить трек на подключённой колонке. */
    play(d, track) {
      const o = d.btRt && d.btRt.audio ? d.net.getDevice(d.btRt.audio) : null;
      if (!o) return 'Не подключено аудиоустройство Bluetooth';
      if (!alive(o) || !inRange(d, o)) { BT.disconnectAudio(d); return 'Связь с ' + o.name + ' потеряна'; }
      const t = String(track || 'Музыка').slice(0, 80);
      o.btRt.playing = { track: t, from: d.name, since: d.net.time };
      d.btRt.track = t;
      log(d.net, d, 'Bluetooth A2DP: ' + o.name + ' играет «' + t + '»', frame('A2DP-STREAM', d, o, { track: t }), 'accept');
      d.net.emit('config', { dev: o });
      d.net.emit('config', { dev: d });
      return null;
    },

    stop(d) {
      const o = d.btRt && d.btRt.audio ? d.net.getDevice(d.btRt.audio) : null;
      if (d.btRt) d.btRt.track = null;
      if (o && o.btRt) { o.btRt.playing = null; d.net.emit('config', { dev: o }); }
      d.net.emit('config', { dev: d });
    },

    /** Передать файл (OBEX) на сопряжённый компьютер/смартфон. */
    sendFile(d, o, file) {
      if (!file || !file.name) return 'Выберите файл';
      if (BT.isAudio(o) || !Array.isArray(o.files)) return o.name + ' не принимает файлы';
      if (!cfg(d).paired.includes(o.id)) return 'Сначала выполните сопряжение с ' + o.name;
      if (!alive(d) || !alive(o)) return 'Bluetooth выключен или нет питания';
      if (!inRange(d, o)) return o.name + ' вне радиуса действия';
      let name = String(file.name);
      const base = name;
      for (let i = 1; o.files.some((f) => f.name === name); i++) name = base.replace(/(\.[^.]*)?$/, (m) => ' (' + i + ')' + (m || ''));
      o.files.push({ name, text: String(file.text || '') });
      cfg(o);
      o.btRt.received = (o.btRt.received || []).concat([{ name, from: d.name, time: d.net.time }]).slice(-20);
      log(d.net, d, 'Bluetooth OBEX: файл «' + name + '» передан на ' + o.name, frame('OBEX-PUT', d, o, { file: name, size: String(file.text || '').length }), 'accept');
      d.net.emit('config', { dev: o });
      return null;
    },

    /** Разорвать всё у устройства. */
    dropAll(d, why) {
      if (!d.btRt) return;
      if (d.btRt.audio) BT.disconnectAudio(d);
      if (d.btRt.source) {
        const s = d.net.getDevice(d.btRt.source);
        if (s) BT.disconnectAudio(s);
      }
      if (why) log(d.net, d, 'Bluetooth: соединения разорваны — ' + why, null, 'info');
    },

    /** После перемещения устройств: разорвать соединения, которые вышли за радиус. */
    check(net) {
      let changed = false;
      for (const d of net.devices.values()) {
        if (!d.btRt || !d.btRt.audio) continue;
        const o = net.getDevice(d.btRt.audio);
        if (!o || !alive(d) || !alive(o) || !inRange(d, o)) {
          BT.disconnectAudio(d);
          log(net, d, 'Bluetooth: связь с ' + (o ? o.name : 'устройством') + ' потеряна (вне радиуса или выключено)', null, 'drop');
          changed = true;
        }
      }
      return changed;
    },
  };

  NS.bt = BT;

  // выключение и перезапуск разрывают соединения
  const setPower = NS.Network.prototype.setPower;
  NS.Network.prototype.setPower = function (dev, on) {
    if (!on && dev && dev.btRt) BT.dropAll(dev, null);
    return setPower.call(this, dev, on);
  };
  const remove = NS.Network.prototype.removeDevice;
  if (remove) {
    NS.Network.prototype.removeDevice = function (id) {
      const dev = this.getDevice(id);
      if (dev && dev.btRt) BT.dropAll(dev, null);
      const r = remove.call(this, id);
      for (const d of this.devices.values()) if (d.bt && d.bt.paired) d.bt.paired = d.bt.paired.filter((x) => x !== id);
      return r;
    };
  }

  NS.IpNode.hooks.runtime.push(function () {
    if (has(this)) {
      cfg(this);
      this.btRt = { source: null, playing: null, audio: null, received: [], track: null };
    }
  });

  NS.deviceExt.push({
    key: 'bt',
    applies: (d) => has(d),
    save(d) { const b = cfg(d); return { on: b.on, paired: b.paired.slice() }; },
    load(d, c) { d.bt = { on: !c || c.on !== false, pin: '0000', paired: c && Array.isArray(c.paired) ? c.paired.map(String) : [] }; },
  });

  /* ================= описание «пакетов» ================= */

  const OPS = { INQUIRY: 'поиск устройств', PAIR: 'сопряжение', 'A2DP-CONNECT': 'подключение аудио (A2DP)', 'A2DP-STREAM': 'поток звука (A2DP)', 'OBEX-PUT': 'передача файла (OBEX)' };
  P.register({
    protocols: { BT: { label: 'Bluetooth', color: '#1d4ed8' } },
    classify: (f) => (f.type === 'BT' ? 'BT' : null),
    summary(f) {
      if (f.type !== 'BT') return null;
      const d = f.payload || {};
      return 'Bluetooth: ' + (OPS[d.op] || d.op) + ' ' + d.from + (d.to ? ' → ' + d.to : '') + (d.track ? ' «' + d.track + '»' : '') + (d.file ? ' «' + d.file + '»' : '') + (d.ok === false ? ' — отказ' : '');
    },
    layers(f) {
      if (f.type !== 'BT') return null;
      const d = f.payload || {};
      const fields = [['Операция', OPS[d.op] || d.op], ['От', d.from]];
      if (d.to) fields.push(['Кому', d.to]);
      if (d.found) fields.push(['Найдено', d.found.join(', ') || 'ничего']);
      if (d.track) fields.push(['Трек', d.track]);
      if (d.file) fields.push(['Файл', d.file + ' (' + d.size + ' байт)']);
      fields.push(['Диапазон', '2,4 ГГц, ~10 м (класс 2)']);
      return [{ title: 'Bluetooth (не IP: радиоканал «точка-точка»)', fields }];
    },
  });
})(globalThis.NetLab = globalThis.NetLab || {});
