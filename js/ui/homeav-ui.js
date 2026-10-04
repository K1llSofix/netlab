/* NetLab UI — ATA, аналоговый телефон, коаксиальный разветвитель и телевизор: значки, палитра, окна. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const DW = NS.dw;
  const h = UI.h;
  const HA = NS.homeav;

  const ICONS = {
    ata: '<rect x="8" y="16" width="48" height="20" rx="4" fill="#1f2937"/><rect x="12" y="20" width="8" height="3" rx="1" fill="#22c55e"/><rect x="23" y="20" width="8" height="3" rx="1" fill="#22c55e"/>' +
      '<text x="42" y="31" font-size="9" font-weight="700" text-anchor="middle" fill="#e5e7eb" font-family="Segoe UI, sans-serif">ATA</text><rect x="14" y="36" width="36" height="3" fill="#111827"/>',
    aphone: '<path d="M10 34h44l-4 10H14z" fill="#b91c1c"/><rect x="18" y="26" width="28" height="10" rx="3" fill="#dc2626"/>' +
      '<path d="M8 22c0-8 48-8 48 0v4c0 2-4 2-5 0l-2-4H15l-2 4c-1 2-5 2-5 0z" fill="#7f1d1d"/>' + [0, 1, 2].map((c) => '<circle cx="' + (27 + c * 5) + '" cy="31" r="1.3" fill="#fecaca"/>').join(''),
    splitter: '<rect x="18" y="14" width="28" height="20" rx="3" fill="#94a3b8" stroke="#475569" stroke-width="1.6"/>' +
      '<rect x="6" y="21" width="12" height="6" rx="1.5" fill="#d97706"/><rect x="46" y="15" width="12" height="6" rx="1.5" fill="#d97706"/><rect x="46" y="27" width="12" height="6" rx="1.5" fill="#d97706"/>' +
      '<text x="32" y="27" font-size="7" font-weight="700" text-anchor="middle" fill="#1f2937" font-family="Segoe UI, sans-serif">1:2</text>',
  };
  const tvIcon = (on, ch) => '<rect x="6" y="4" width="52" height="34" rx="3" fill="#111827"/>' +
    (on ? '<rect x="9" y="7" width="46" height="28" fill="#1d4ed8"/><path d="M9 35L24 20l9 9 7-6 15 12z" fill="#22c55e"/><circle cx="46" cy="14" r="4" fill="#fde047"/>' +
      '<text x="14" y="15" font-size="7" font-weight="700" fill="#fff" font-family="Segoe UI, sans-serif">' + ch + '</text>'
      : '<rect x="9" y="7" width="46" height="28" fill="#374151"/>' + [0, 1, 2, 3, 4, 5].map((i) => '<rect x="' + (9 + i * 7.7) + '" y="7" width="7.7" height="28" fill="' + ['#9ca3af', '#fde047', '#22d3ee', '#22c55e', '#e879f9', '#ef4444'][i] + '" opacity=".35"/>').join('')) +
    '<rect x="26" y="38" width="12" height="4" fill="#374151"/><rect x="18" y="42" width="28" height="3" rx="1.5" fill="#374151"/>';

  const baseIcon = UI.deviceIcon;
  UI.deviceIcon = function (type, model) {
    if (ICONS[type]) return ICONS[type];
    if (type === 'tv') return tvIcon(true, 1);
    return baseIcon(type, model);
  };
  const baseFor = UI.deviceIconFor;
  UI.deviceIconFor = function (d) {
    if (d.type === 'tv') return tvIcon(d.signal(), d.channel);
    return baseFor(d);
  };
  const baseStatus = UI.deviceStatusText;
  UI.deviceStatusText = function (d) {
    if (d.type === 'ata') {
      if (!d.power) return { text: 'нет питания', cls: 'warn' };
      return d.sccp.state === 'registered' ? { text: '☎ ' + (d.sccp.number || '—') + (d.handset() ? '' : ' · нет телефона'), cls: d.handset() ? 'ok' : 'warn' } : { text: d.sccp.state === 'registering' ? 'регистрация…' : 'не зарегистрирован', cls: 'warn' };
    }
    if (d.type === 'aphone') {
      const s = d.sccp;
      if (!d.ata()) return { text: 'нет линии', cls: 'warn' };
      if (!s || s.state !== 'registered') return { text: 'линия не готова', cls: 'warn' };
      return { text: '☎ ' + (s.number || '') + (s.call ? (s.call.state === 'connected' ? ' · разговор' : s.call.state === 'ringing' ? ' · звонок!' : ' · вызов') : ''), cls: 'ok' };
    }
    if (d.type === 'tv') return d.signal() ? { text: '📺 ' + d.channel + ' · ' + d.channelName(), cls: 'ok' } : { text: 'нет сигнала', cls: 'warn' };
    return baseStatus ? baseStatus(d) : null;
  };

  UI.DEVICE_TYPES.push(
    { type: 'ata', label: 'Аналоговый телефонный адаптер', short: 'ATA' },
    { type: 'aphone', label: 'Аналоговый телефон', short: 'Телефон' },
    { type: 'splitter', label: 'Коаксиальный разветвитель', short: 'Разветвитель' },
    { type: 'tv', label: 'Телевизор', short: 'ТВ' },
  );
  const cat = (id) => UI.DEVICE_CATEGORIES.find((c) => c.id === id);
  cat('end').models.push('Linksys-PAP2T', 'Analog-Phone-PT', 'TV-PT');
  cat('switches').models.push('IE-2000-8TC');
  cat('wireless').models.push('Meraki-MX64W', 'Meraki-MR33');
  if (cat('wan')) cat('wan').models.push('Coaxial-Splitter-PT');

  // вкладка «Телефон» ATA — настройки как у IP-телефона
  const phonePage = (DW.hostPages || []).find((p) => p.id === 'phone');
  if (phonePage) { const base = phonePage.applies; phonePage.applies = (d) => base(d) || d.type === 'ata'; }

  /* ---------- окна ---------- */

  function analogTab(app, id) {
    const st = app.deskState(id);
    const tab = {
      id: 'phone', label: 'Телефон', keep: true,
      render(body) {
        const info = h('div', { class: 'hint-box', style: { marginBottom: '8px' } });
        body.append(info);
        const live = DW.phoneWidget(app, id, () => { const d = app.net.getDevice(id); return d ? d.sccp : null; }, body, st);
        tab.live = () => { const d = app.net.getDevice(id); if (!d) return; info.textContent = d.lineText(); info.className = 'hint-box' + (d.sccp && d.sccp.state === 'registered' ? '' : ' warn'); live(); };
        tab.live();
      },
      live: null,
    };
    return tab;
  }

  function tvTab(app, id) {
    const tab = {
      id: 'tv', label: 'Экран', keep: true,
      render(body) {
        const screen = h('div', { class: 'tv-screen' });
        const btns = h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, HA.CHANNELS.map((n, i) => h('button', { class: 'btn outline small', onClick: () => { app.net.getDevice(id).setChannel(i + 1); tab.live(); } }, (i + 1) + ' ' + n)));
        body.append(screen, btns, h('div', { class: 'muted small', style: { marginTop: '8px' } }, 'Сигнал кабельного ТВ приходит по коаксиальному кабелю от облака провайдера (Cloud-PT, порт Coaxial), в том числе через разветвитель. Интернет по тому же кабелю — через кабельный модем.'));
        tab.live = () => {
          const d = app.net.getDevice(id);
          if (!d) return;
          UI.clear(screen);
          const on = d.signal();
          screen.className = 'tv-screen' + (on ? ' on' : '');
          screen.append(on ? h('div', null, h('div', { class: 'tv-ch' }, 'Канал ' + d.channel), h('div', { class: 'tv-name' }, d.channelName())) : h('div', { class: 'tv-ch' }, d.power ? 'Нет сигнала' : 'Выключен'));
        };
        tab.live();
      },
      live: null,
    };
    return tab;
  }

  UI.extraTabsFor = (UI.extraTabsFor || []).concat([(app, dev) => {
    if (!['aphone', 'tv', 'splitter', 'ata'].includes(dev.type)) return null;
    const phys = DW.physicalTab(app, dev.id);
    const attr = DW.attributesTab(app, dev.id);
    if (dev.type === 'aphone') return [phys, analogTab(app, dev.id), attr];
    if (dev.type === 'tv') return [phys, tvTab(app, dev.id), attr];
    if (dev.type === 'splitter') return [phys, attr];
    return [phys, DW.configTab(app, dev.id), attr];
  }]);
})(globalThis.NetLab = globalThis.NetLab || {});
