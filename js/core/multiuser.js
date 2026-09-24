/* NetLab — многопользовательский режим: облако Multiuser-PT соединяет схему с другой копией NetLab.
 * Кадр, ушедший в порт LinkN облака, передаётся по сети (TCP, настольная версия) облаку с тем же именем
 * в удалённой схеме (или указанному в настройке «Удалённое облако») и выходит из его порта LinkN.
 * NS.multiuser.transport(msg) задаёт интерфейс (desktop или тесты); входящие — NS.multiuser.deliver(net, msg). */
(function (NS) {
  'use strict';

  const M = NS.models;
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

  M.MODELS['Multiuser-PT'] = {
    type: 'mucloud', title: 'Многопользовательское облако Multiuser-PT',
    ports: range(8, (i) => ({ name: 'Link' + i, media: 'copper', speed: 100, mdix: true })),
    slots: [], attrs: { MTBF: 100000, cost: 0, 'power source': 0, 'rack units': 0, wattage: 0 },
  };
  M.DEFAULT_MODEL.mucloud = 'Multiuser-PT';

  /** BigInt (адреса IPv6) не переносится JSON — кодируем явно. */
  const encode = (frame) => JSON.parse(JSON.stringify(frame, (k, v) => (typeof v === 'bigint' ? { __big: v.toString(16) } : v)));
  const decode = (obj) => JSON.parse(JSON.stringify(obj), (k, v) => (v && typeof v === 'object' && typeof v.__big === 'string' && Object.keys(v).length === 1 ? BigInt('0x' + v.__big) : v));

  class MuCloud extends NS.Device {
    constructor(net, id, name, model) {
      super(net, id, 'mucloud', name, model);
      this.remote = ''; // имя облака в удалённой схеме (пусто — такое же, как у этого)
      this.stats = { out: 0, in: 0 };
    }

    receive(i, frame) {
      const mu = NS.multiuser;
      if (!mu.transport || !mu.connected()) { this.drop(frame, 'Многопользовательское облако: нет подключения к другой копии NetLab'); return; }
      this.stats.out++;
      mu.transport({ t: 'frame', to: this.remote || this.name, from: this.name, port: this.ports[i].name, frame: encode(frame) });
      this.note('Кадр отправлен в удалённую схему (' + (this.remote || this.name) + ' ' + this.ports[i].name + ')', frame, 'info');
    }

    inject(portName, frame, peer) {
      const i = this.portIndex(portName);
      if (i < 0) return false;
      if (!this.net.isPortOperational(this, i)) { this.drop(frame, 'Кадр из удалённой схемы: порт ' + portName + ' облака не подключён'); return false; }
      this.stats.in++;
      return this.send(i, Object.assign({}, frame, { hops: 0 }), 'Кадр из удалённой схемы' + (peer ? ' (' + peer + ')' : ''));
    }

    serializeConfig() { return this.remote ? { remote: this.remote } : {}; }
    loadConfig(c) { this.remote = c && c.remote ? String(c.remote) : ''; }
  }
  MuCloud.namePrefix = 'Multiuser';
  MuCloud.title = 'Многопользовательское облако';
  NS.deviceTypes.mucloud = MuCloud;

  NS.multiuser = {
    transport: null,              // (msg) → отправить всем подключённым копиям
    connected: () => false,
    /** Входящее сообщение из удалённой копии. */
    deliver(net, msg, peerName) {
      if (!msg || msg.t !== 'frame') return false;
      const clouds = [...net.devices.values()].filter((d) => d.type === 'mucloud');
      // облако, чьё имя совпадает с адресатом; если его нет — облако, настроенное на отправителя
      const c = clouds.find((d) => d.name === msg.to) || clouds.find((d) => d.remote && d.remote === msg.from);
      if (!c) return false;
      return c.inject(String(msg.port), decode(msg.frame), peerName);
    },
    encode,
    decode,
  };
})(globalThis.NetLab = globalThis.NetLab || {});
