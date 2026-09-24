/* NetLab UI — WAN: значки и палитра модемов, вышки сотовой связи, новых маршрутизаторов и коммутатора,
 * коаксиальный кабель, окна модема и вышки, переключатель 3G/4G на смартфоне. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;

  const lbl = (t) => h('label', null, t);
  const hint = (t) => h('div', { class: 'hint-box', style: { marginTop: '10px' } }, t);

  const ICONS = {
    modem: '<rect x="10" y="20" width="44" height="16" rx="4" fill="#1e293b"/>' +
      '<path d="M18 20l-3-8M46 20l3-8" stroke="#475569" stroke-width="2.4" stroke-linecap="round"/>' +
      [0, 1, 2, 3].map((i) => '<circle cx="' + (20 + i * 6) + '" cy="28" r="1.6" fill="' + (i < 3 ? '#4ade80' : '#facc15') + '"/>').join(''),
    celltower: '<path d="M32 6L22 44h4l6-22 6 22h4z" fill="none" stroke="#475569" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<path d="M25 30h14M27 22h10" stroke="#475569" stroke-width="2"/>' +
      '<path d="M20 12a15 15 0 0 0 0 16M44 12a15 15 0 0 1 0 16M15 8a22 22 0 0 0 0 24M49 8a22 22 0 0 1 0 24" stroke="#0284c7" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '<circle cx="32" cy="10" r="2.6" fill="#dc2626"/>',
  };
  const baseIcon = UI.deviceIcon;
  UI.deviceIcon = function (type, model) { return ICONS[type] || baseIcon(type, model); };
  UI.DEVICE_TYPES.push({ type: 'modem', label: 'Модем', short: 'Модем' }, { type: 'celltower', label: 'Вышка сотовой связи', short: 'Вышка' });

  const cat = (id) => UI.DEVICE_CATEGORIES.find((c) => c.id === id);
  if (cat('routers')) cat('routers').models.push('4331', '1841');
  if (cat('switches')) cat('switches').models.push('3650-24PS');
  if (cat('wan')) cat('wan').models.push('DSL-Modem-PT', 'Cable-Modem-PT', 'Cell-Tower');

  UI.CABLE_STYLE.coaxial = { color: '#0f766e', dash: null };
  const autoIdx = UI.CABLES.findIndex((c) => c.kind === 'phone');
  UI.CABLES.splice(autoIdx >= 0 ? autoIdx + 1 : UI.CABLES.length, 0, { kind: 'coaxial', label: 'Коаксиальный', hint: 'Кабельный модем (Port 0) → порт Coaxial облака Cloud-PT' });

  /* ---------- окна ---------- */

  DW.configBuilders.modem = DW.simpleConfig({
    items: [{ group: 'ПОРТЫ' }, { id: 'ports', label: 'Подключения' }],
    globalHint: (d) => (d.ports[0].media === 'coax'
      ? 'Кабельный модем: Port 0 — коаксиальный кабель к порту Coaxial облака провайдера, Port 1 — медный кабель к компьютеру или порту Internet домашнего роутера. Модем просто передаёт кадры между портами.'
      : 'DSL-модем: Port 0 — телефонный кабель к порту DSL облака провайдера, Port 1 — медный кабель к компьютеру или порту Internet домашнего роутера. Модем просто передаёт кадры между портами.'),
    render(sec, app, d, box) {
      box.append(DW.section('Подключения'), DW.form(...d.ports.flatMap((p, i) => [lbl(p.name), h('div', null, DW.peerText(app.net, d, i))])));
      return null;
    },
  });

  DW.configBuilders.celltower = DW.simpleConfig({
    items: [{ group: '3G/4G' }, { id: 'cell', label: 'Абоненты' }],
    globalHint: () => 'Вышка сотовой связи 3G/4G. Смартфоны с включённым 3G/4G (и без подключения к Wi-Fi) подключаются к ближайшей вышке в радиусе около ' + NS.Network.CELL_RANGE + ' точек схемы. Порт Ethernet0 — в сеть оператора: там нужен DHCP-сервер (или маршрутизатор с пулом) для абонентов.',
    render(sec, app, d, box) {
      const list = h('div');
      box.append(DW.section('Подключённые смартфоны'), list);
      return () => {
        const x = app.net.getDevice(d.id);
        UI.clear(list);
        const cl = x.wirelessClients();
        list.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Устройство'), h('th', null, 'IP-адрес')),
          cl.length ? cl.map((c) => h('tr', null, h('td', null, c.name), h('td', { class: 'mono' }, c.iface && c.iface.ip != null ? U.ipStr(c.iface.ip) : '—')))
            : h('tr', { class: 'empty' }, h('td', { colspan: 2 }, 'Нет абонентов в зоне покрытия'))));
      };
    },
  });

  // смартфон: 3G/4G
  DW.hostIfaceExtras = (DW.hostIfaceExtras || []).concat([(app, dev, box) => {
    if (dev.type !== 'smartphone') return null;
    const e = h('div', { class: 'err-text' });
    const st = h('div', { class: 'muted' });
    box.append(DW.section('Сотовая связь'), DW.form(lbl('3G/4G'), UI.toggle(dev.cellular !== false ? 'Включено' : 'Выключено', dev.cellular !== false, (on) => DW.apply(app, () => app.net.getDevice(dev.id).setCellular(on), e, true)), lbl('Сеть'), st, h('div', { class: 'full' }, e)),
      hint('Если смартфон не подключён к Wi-Fi, он использует ближайшую вышку сотовой связи (устройство Cell-Tower на схеме).'));
    return () => {
      const d = app.net.getDevice(dev.id);
      const r = app.net.wirelessStatus(d);
      st.textContent = r && r.ap ? (r.ap.type === 'celltower' ? '3G/4G: ' + r.ap.name : 'Wi-Fi: ' + r.ap.name) : 'нет связи';
    };
  }]);
})(globalThis.NetLab = globalThis.NetLab || {});
