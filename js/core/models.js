/* NetLab — каталог моделей устройств и сменных модулей (как вкладка Physical в Packet Tracer).
 * Порт: { name, media: copper|fiber|serial|wireless|console|rs232, speed (Мбит/с), mdix (порт «как у коммутатора») } */
(function (NS) {
  'use strict';

  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

  const MODULES = {
    /* сетевые карты ПК и серверов */
    'PT-HOST-NM-1CFE': { kind: 'host', title: 'PT-HOST-NM-1CFE', desc: 'Один порт Fast Ethernet (медь, 10/100 Мбит/с). Установлен по умолчанию.', ports: [{ name: 'FastEthernet0', media: 'copper', speed: 100 }] },
    'PT-HOST-NM-1CGE': { kind: 'host', title: 'PT-HOST-NM-1CGE', desc: 'Один порт Gigabit Ethernet (медь, 10/100/1000 Мбит/с).', ports: [{ name: 'GigabitEthernet0', media: 'copper', speed: 1000 }] },
    'PT-HOST-NM-1FFE': { kind: 'host', title: 'PT-HOST-NM-1FFE', desc: 'Один оптический порт Fast Ethernet (100 Мбит/с). Нужен оптический кабель.', ports: [{ name: 'FastEthernet0', media: 'fiber', speed: 100 }] },
    'PT-HOST-NM-1FGE': { kind: 'host', title: 'PT-HOST-NM-1FGE', desc: 'Один оптический порт Gigabit Ethernet. Нужен оптический кабель.', ports: [{ name: 'GigabitEthernet0', media: 'fiber', speed: 1000 }] },
    WMP300N: { kind: 'host', title: 'WMP300N', desc: 'Беспроводной адаптер 2,4 ГГц (Wi-Fi 802.11n). Подключается к точке доступа или беспроводному маршрутизатору по SSID.', ports: [{ name: 'Wireless0', media: 'wireless', speed: 300 }] },
    /* ноутбук */
    'PT-LAPTOP-NM-1CFE': { kind: 'laptop', title: 'PT-LAPTOP-NM-1CFE', desc: 'Сетевая карта Fast Ethernet (медь) для ноутбука. Установлена по умолчанию.', ports: [{ name: 'FastEthernet0', media: 'copper', speed: 100 }] },
    'PT-LAPTOP-NM-1CGE': { kind: 'laptop', title: 'PT-LAPTOP-NM-1CGE', desc: 'Сетевая карта Gigabit Ethernet (медь) для ноутбука.', ports: [{ name: 'GigabitEthernet0', media: 'copper', speed: 1000 }] },
    'PT-LAPTOP-NM-1FFE': { kind: 'laptop', title: 'PT-LAPTOP-NM-1FFE', desc: 'Оптическая карта Fast Ethernet для ноутбука.', ports: [{ name: 'FastEthernet0', media: 'fiber', speed: 100 }] },
    WPC300N: { kind: 'laptop', title: 'WPC300N', desc: 'Беспроводной адаптер Wi-Fi 802.11n для ноутбука.', ports: [{ name: 'Wireless0', media: 'wireless', speed: 300 }] },
    /* модули маршрутизаторов ISR (слоты EHWIC) */
    'HWIC-2T': { kind: 'hwic', title: 'HWIC-2T', desc: 'Два последовательных (Serial) порта для WAN-каналов. Соединяются кабелем Serial DCE/DTE; на стороне DCE нужна команда clock rate.', ports: [{ name: 'Serial0/{s}/0', media: 'serial', speed: 1.544 }, { name: 'Serial0/{s}/1', media: 'serial', speed: 1.544 }] },
    'HWIC-1GE-SFP': { kind: 'hwic', title: 'HWIC-1GE-SFP', desc: 'Один оптический порт Gigabit Ethernet (SFP).', ports: [{ name: 'GigabitEthernet0/{s}/0', media: 'fiber', speed: 1000 }] },
  };

  const CONSOLE = { name: 'Console', media: 'console', speed: 0 };
  const RS232 = { name: 'RS 232', media: 'rs232', speed: 0 };

  const MODELS = {
    'PC-PT': {
      type: 'pc', title: 'Компьютер PC-PT', ports: [RS232],
      slots: [{ id: 'nic', kind: 'host', label: 'Слот сетевой карты', def: 'PT-HOST-NM-1CFE' }],
      attrs: { MTBF: 43800, cost: 1000, 'power source': 0, 'rack units': 3, wattage: 150 },
    },
    'Laptop-PT': {
      type: 'laptop', title: 'Ноутбук Laptop-PT', ports: [RS232],
      slots: [{ id: 'nic', kind: 'laptop', label: 'Слот сетевой карты', def: 'PT-LAPTOP-NM-1CFE' }],
      attrs: { MTBF: 43800, cost: 1200, 'power source': 0, 'rack units': 1, wattage: 65 },
    },
    'Server-PT': {
      type: 'server', title: 'Сервер Server-PT', ports: [],
      slots: [{ id: 'nic', kind: 'host', label: 'Слот сетевой карты', def: 'PT-HOST-NM-1CFE' }],
      attrs: { MTBF: 87600, cost: 4000, 'power source': 0, 'rack units': 2, wattage: 400 },
    },
    'Printer-PT': {
      type: 'printer', title: 'Принтер Printer-PT', ports: [],
      slots: [{ id: 'nic', kind: 'host', label: 'Слот сетевой карты', def: 'PT-HOST-NM-1CFE' }],
      attrs: { MTBF: 43800, cost: 300, 'power source': 0, 'rack units': 2, wattage: 90 },
    },
    'TabletPC-PT': {
      type: 'tablet', title: 'Планшет TabletPC-PT', ports: [{ name: 'Wireless0', media: 'wireless', speed: 300 }],
      slots: [], attrs: { MTBF: 43800, cost: 500, 'power source': 0, 'rack units': 0, wattage: 15 },
    },
    2911: {
      type: 'router', title: 'Маршрутизатор Cisco 2911', ios: true,
      ports: [0, 1, 2].map((i) => ({ name: 'GigabitEthernet0/' + i, media: 'copper', speed: 1000 })).concat([CONSOLE]),
      slots: range(4, (i) => ({ id: 'hwic' + i, kind: 'hwic', label: 'EHWIC ' + i, n: i, def: null })),
      attrs: { MTBF: 300000, cost: 6000, 'power source': 0, 'rack units': 2, wattage: 210 },
    },
    1941: {
      type: 'router', title: 'Маршрутизатор Cisco 1941', ios: true,
      ports: [0, 1].map((i) => ({ name: 'GigabitEthernet0/' + i, media: 'copper', speed: 1000 })).concat([CONSOLE]),
      slots: range(2, (i) => ({ id: 'hwic' + i, kind: 'hwic', label: 'EHWIC ' + i, n: i, def: null })),
      attrs: { MTBF: 300000, cost: 3000, 'power source': 0, 'rack units': 1, wattage: 110 },
    },
    'Router-PT': {
      type: 'router', title: 'Маршрутизатор Router-PT', ios: true,
      ports: [0, 1, 2, 3].map((i) => ({ name: 'GigabitEthernet0/' + i, media: 'copper', speed: 1000 })).concat([CONSOLE]),
      slots: [], attrs: { MTBF: 300000, cost: 4000, 'power source': 0, 'rack units': 2, wattage: 200 },
    },
    '2960-24TT': {
      type: 'switch', title: 'Коммутатор Cisco 2960-24TT', ios: true, l3: false,
      ports: range(24, (i) => ({ name: 'FastEthernet0/' + (i + 1), media: 'copper', speed: 100, mdix: true }))
        .concat([1, 2].map((i) => ({ name: 'GigabitEthernet0/' + i, media: 'copper', speed: 1000, mdix: true })), [CONSOLE]),
      slots: [], attrs: { MTBF: 300000, cost: 1500, 'power source': 0, 'rack units': 1, wattage: 75 },
    },
    '3560-24PS': {
      type: 'switch', title: 'Коммутатор 3-го уровня Cisco 3560-24PS', ios: true, l3: true,
      ports: range(24, (i) => ({ name: 'FastEthernet0/' + (i + 1), media: 'copper', speed: 100, mdix: true }))
        .concat([1, 2].map((i) => ({ name: 'GigabitEthernet0/' + i, media: 'copper', speed: 1000, mdix: true })), [CONSOLE]),
      slots: [], attrs: { MTBF: 300000, cost: 5000, 'power source': 0, 'rack units': 1, wattage: 370 },
    },
    'Hub-PT': {
      type: 'hub', title: 'Концентратор Hub-PT',
      ports: range(8, (i) => ({ name: 'Port' + i, media: 'copper', speed: 10, mdix: true })),
      slots: [], attrs: { MTBF: 300000, cost: 20, 'power source': 0, 'rack units': 2, wattage: 20 },
    },
    'AccessPoint-PT': {
      type: 'ap', title: 'Точка доступа AccessPoint-PT',
      ports: [{ name: 'Port 0', media: 'copper', speed: 100 }, { name: 'Port 1', media: 'wireless', speed: 300, radio: true }],
      slots: [], attrs: { MTBF: 100000, cost: 200, 'power source': 0, 'rack units': 1, wattage: 12 },
    },
    WRT300N: {
      type: 'wrouter', title: 'Беспроводной маршрутизатор WRT300N',
      ports: [{ name: 'Internet', media: 'copper', speed: 100 }]
        .concat(range(4, (i) => ({ name: 'Ethernet ' + (i + 1), media: 'copper', speed: 100, mdix: true })),
          [{ name: 'Wireless', media: 'wireless', speed: 300, radio: true }]),
      slots: [], attrs: { MTBF: 100000, cost: 150, 'power source': 0, 'rack units': 1, wattage: 15 },
    },
  };

  /** Модель по умолчанию для типа и «старая» модель для файлов первой версии. */
  const DEFAULT_MODEL = { pc: 'PC-PT', laptop: 'Laptop-PT', server: 'Server-PT', printer: 'Printer-PT', tablet: 'TabletPC-PT', router: '2911', switch: '2960-24TT', hub: 'Hub-PT', ap: 'AccessPoint-PT', wrouter: 'WRT300N' };
  const LEGACY_MODEL = Object.assign({}, DEFAULT_MODEL, { router: 'Router-PT' });

  NS.models = {
    MODELS,
    MODULES,
    DEFAULT_MODEL,
    LEGACY_MODEL,
    get(model) {
      const m = MODELS[model];
      if (!m) throw new Error('Неизвестная модель устройства: ' + model);
      return m;
    },
    module(id) { return MODULES[id] || null; },
    /** Модули, которые подходят к слоту данного типа. */
    modulesFor(kind) { return Object.keys(MODULES).filter((k) => MODULES[k].kind === kind); },
    /** Все модели данного типа устройства. */
    modelsOf(type) { return Object.keys(MODELS).filter((k) => MODELS[k].type === type && k !== 'Router-PT'); },
  };
})(globalThis.NetLab = globalThis.NetLab || {});
