/* NetLab — домашние голос и ТВ (как в Packet Tracer):
 *  • ATA Linksys PAP2T — аналоговый телефонный адаптер: Ethernet к сети, регистрируется в Cisco CME по SCCP
 *    (как IP-телефон: адрес по DHCP, CME из option 150), порт Phone 1 — телефонным кабелем к аналоговому телефону;
 *  • аналоговый телефон — трубка на линии ATA: набор номера, ответ, отбой;
 *  • коаксиальный разветвитель — пассивно передаёт сигнал во все отводы (кабельный модем за ним тоже работает);
 *  • ТВ — показывает каналы, если коаксиалом (в т. ч. через разветвители) подключён к кабельной сети провайдера (Cloud-PT → Coaxial). */
(function (NS) {
  'use strict';

  const U = NS.util;
  const M = NS.models;
  const IpPhone = NS.IpPhone;
  const ATTR = (cost, w) => ({ MTBF: 100000, cost, 'power source': 0, 'rack units': 0, wattage: w });

  M.MODELS['Linksys-PAP2T'] = {
    type: 'ata', title: 'Аналоговый телефонный адаптер (ATA) Linksys PAP2T',
    ports: [{ name: 'Ethernet', media: 'copper', speed: 100 }, { name: 'Phone 1', media: 'phone', speed: 0 }],
    slots: [], attrs: ATTR(60, 5),
  };
  M.DEFAULT_MODEL.ata = 'Linksys-PAP2T';
  M.MODELS['Analog-Phone-PT'] = { type: 'aphone', title: 'Аналоговый телефон', ports: [{ name: 'Line', media: 'phone', speed: 0 }], slots: [], attrs: ATTR(25, 0) };
  M.DEFAULT_MODEL.aphone = 'Analog-Phone-PT';
  M.MODELS['Coaxial-Splitter-PT'] = {
    type: 'splitter', title: 'Коаксиальный разветвитель',
    ports: [{ name: 'Coaxial0', media: 'coax', speed: 50 }, { name: 'Coaxial1', media: 'coax', speed: 50 }, { name: 'Coaxial2', media: 'coax', speed: 50 }],
    slots: [], attrs: ATTR(10, 0),
  };
  M.DEFAULT_MODEL.splitter = 'Coaxial-Splitter-PT';
  M.MODELS['TV-PT'] = { type: 'tv', title: 'Телевизор TV-PT', ports: [{ name: 'Coaxial', media: 'coax', speed: 50 }], slots: [], attrs: ATTR(400, 120) };
  M.DEFAULT_MODEL.tv = 'TV-PT';

  /* ================= ATA ================= */

  class Ata extends IpPhone {
    constructor(net, id, name, model) {
      super(net, id, name, model);
      this.type = 'ata';
      this.adapter = true; // свой блок питания
    }

    /** Подключённый к порту Phone 1 аналоговый телефон (или null). */
    handset() {
      const pr = this.net.peer(this, 1);
      return pr && pr.dev.type === 'aphone' ? pr.dev : null;
    }

    learnVoiceVlan() { this.voiceVlan = null; return false; }

    // порт Phone 1 — аналоговая линия, кадры Ethernet туда не передаются
    receive(i, frame) {
      if (i !== 0) return;
      if (frame.vlan != null) { this.drop(frame, 'ATA: кадр с тегом 802.1Q отброшен (порт коммутатора к ATA — access)'); return; }
      const mine = frame.dst === this.ports[0].mac;
      if (mine || U.isMulticastMac(frame.dst)) NS.IpNode.prototype.receive.call(this, 0, frame);
      else this.drop(frame, 'Кадр адресован другому устройству (MAC ' + frame.dst + ')');
    }

    setAdapter(on) { super.setAdapter(on); }
  }
  Ata.namePrefix = 'ATA';
  Ata.title = 'ATA';
  NS.deviceTypes.ata = Ata;

  /* ================= аналоговый телефон ================= */

  class AnalogPhone extends NS.Device {
    constructor(net, id, name, model) { super(net, id, 'aphone', name, model); }

    /** ATA, к линии которого подключён телефон. */
    ata() {
      const pr = this.net.peer(this, 0);
      return pr && pr.dev.type === 'ata' && pr.port === 1 ? pr.dev : null;
    }

    /** SCCP-клиент ATA: трубка управляет вызовами линии. */
    get sccp() { const a = this.ata(); return a && a.power ? a.sccp : null; }

    lineText() {
      const a = this.ata();
      if (!a) return 'Нет линии: подключите телефонный кабель к порту Phone 1 адаптера ATA';
      if (!a.power) return 'ATA выключен';
      return a.sccp.state === 'registered' ? 'Линия готова, номер ' + (a.sccp.number || '—') : 'ATA: ' + (a.sccp.text || 'не зарегистрирован');
    }

    receive() { /* аналоговая линия — кадров нет */ }
    serializeConfig() { return {}; }
    loadConfig() {}
  }
  AnalogPhone.namePrefix = 'Phone';
  AnalogPhone.title = 'Аналоговый телефон';
  NS.deviceTypes.aphone = AnalogPhone;

  /* ================= коаксиальный разветвитель ================= */

  class Splitter extends NS.Device {
    constructor(net, id, name, model) { super(net, id, 'splitter', name, model); }
    get power() { return true; }
    set power(v) { /* пассивное устройство */ }
    receive(i, frame) {
      this.ports.forEach((p, j) => { if (j !== i && p.oper) this.send(j, frame, 'Разветвитель: сигнал во все отводы'); });
    }
    serializeConfig() { return {}; }
    loadConfig() {}
  }
  Splitter.namePrefix = 'Splitter';
  Splitter.title = 'Коаксиальный разветвитель';
  NS.deviceTypes.splitter = Splitter;

  /* ================= телевизор ================= */

  const CHANNELS = ['Первый учебный', 'Сети и люди', 'Кабель-ТВ', 'Новости IT', 'Спорт', 'Мультфильмы', 'Погода', 'Музыка'];

  class Tv extends NS.Device {
    constructor(net, id, name, model) {
      super(net, id, 'tv', name, model);
      this.channel = 1;
    }

    /** Есть ли сигнал кабельного ТВ: путь по коаксиалу (через разветвители) до порта Coaxial облака провайдера. */
    signal() {
      if (!this.power) return false;
      const seen = new Set([this.id]);
      const queue = [[this, 0]];
      while (queue.length) {
        const [d, i] = queue.shift();
        const pr = this.net.peer(d, i);
        if (!pr || seen.has(pr.dev.id)) continue;
        seen.add(pr.dev.id);
        const p = pr.dev.ports[pr.port];
        if (p.media !== 'coax') continue;
        if (pr.dev.type === 'cloud' && p.name === 'Coaxial') return !!pr.dev.power;
        if (pr.dev.type === 'splitter') pr.dev.ports.forEach((q, j) => { if (j !== pr.port && q.media === 'coax') queue.push([pr.dev, j]); });
      }
      return false;
    }

    channelName() { return CHANNELS[(this.channel - 1) % CHANNELS.length]; }
    setChannel(n) { const v = Math.max(1, Math.min(CHANNELS.length, Math.round(Number(n) || 1))); this.channel = v; this.net.emit('config', { dev: this }); }
    receive(i, frame) { this.drop(frame, 'Телевизор принимает только ТВ-сигнал, данные ему не нужны'); }
    serializeConfig() { return { channel: this.channel }; }
    loadConfig(c) { this.channel = Math.max(1, Math.min(CHANNELS.length, Number(c && c.channel) || 1)); }
  }
  Tv.namePrefix = 'TV';
  Tv.title = 'Телевизор';
  NS.deviceTypes.tv = Tv;

  /* ================= дополнительные модели ================= */

  const CONSOLE = { name: 'Console', media: 'console', speed: 0 };
  // промышленный коммутатор (DIN-рейка, шкаф автоматики): тот же IOS, что у 2960
  M.MODELS['IE-2000-8TC'] = {
    type: 'switch', title: 'Промышленный коммутатор Cisco IE-2000-8TC', ios: true, l3: false,
    ports: Array.from({ length: 8 }, (_, i) => ({ name: 'FastEthernet1/' + (i + 1), media: 'copper', speed: 100, mdix: true }))
      .concat([1, 2].map((i) => ({ name: 'GigabitEthernet1/' + i, media: 'copper', speed: 1000, mdix: true })), [CONSOLE]),
    slots: [], attrs: { MTBF: 500000, cost: 1800, 'power source': 0, 'rack units': 0, wattage: 18 },
  };
  // Cisco Meraki: шлюз безопасности MX и точка доступа MR (управляются через веб-интерфейс)
  M.MODELS['Meraki-MX64W'] = {
    type: 'wrouter', title: 'Шлюз безопасности Cisco Meraki MX64W',
    ports: [{ name: 'Internet', media: 'copper', speed: 1000 }]
      .concat(Array.from({ length: 4 }, (_, i) => ({ name: 'Ethernet ' + (i + 1), media: 'copper', speed: 1000, mdix: true })), [{ name: 'Wireless', media: 'wireless', speed: 866, radio: true }]),
    slots: [], attrs: { MTBF: 200000, cost: 700, 'power source': 0, 'rack units': 0, wattage: 20 },
  };
  M.MODELS['Meraki-MR33'] = {
    type: 'ap', title: 'Точка доступа Cisco Meraki MR33',
    ports: [{ name: 'Port 0', media: 'copper', speed: 1000 }, { name: 'Port 1', media: 'wireless', speed: 866, radio: true }],
    slots: [], attrs: { MTBF: 200000, cost: 450, 'power source': 0, 'rack units': 0, wattage: 11 },
  };

  NS.homeav = { Ata, AnalogPhone, Splitter, Tv, CHANNELS };
})(globalThis.NetLab = globalThis.NetLab || {});
