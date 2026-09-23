/* NetLab UI — иконки устройств (плоские, 64×48) и инструментов (24×24, линейные). */
(function (NS) {
  'use strict';

  const UI = NS.ui;

  function arrow(x1, y1, x2, y2, color, w) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const L = 4.2;
    const W = 2.8;
    const bx = x2 - Math.cos(a) * L;
    const by = y2 - Math.sin(a) * L;
    const px = -Math.sin(a) * W;
    const py = Math.cos(a) * W;
    const f = (n) => n.toFixed(1);
    return '<line x1="' + f(x1) + '" y1="' + f(y1) + '" x2="' + f(bx) + '" y2="' + f(by) + '" stroke="' + color + '" stroke-width="' + (w || 2) + '" stroke-linecap="round"/>' +
      '<path d="M' + f(x2) + ' ' + f(y2) + 'L' + f(bx + px) + ' ' + f(by + py) + 'L' + f(bx - px) + ' ' + f(by - py) + 'Z" fill="' + color + '"/>';
  }

  const DEV = {
    pc:
      '<rect x="10" y="3" width="44" height="31" rx="3.5" fill="#9aa8bb"/>' +
      '<rect x="13.5" y="6.5" width="37" height="24" rx="1.5" fill="#1d3b63"/>' +
      '<path d="M13.5 30.5V20l12-10 25 0v20.5z" fill="#28508a" opacity=".55"/>' +
      '<rect x="28" y="34" width="8" height="6" fill="#6b7a8f"/>' +
      '<rect x="18" y="40" width="28" height="4.5" rx="2.2" fill="#4a5a70"/>',
    laptop:
      '<rect x="12" y="4" width="40" height="28" rx="3" fill="#9aa8bb"/>' +
      '<rect x="15.5" y="7.5" width="33" height="21" rx="1.2" fill="#1d3b63"/>' +
      '<path d="M15.5 28.5V19l10-8.5h23v18z" fill="#28508a" opacity=".55"/>' +
      '<path d="M4 34H60L56 42.5H8Z" fill="#6b7a8f"/>' +
      '<rect x="26" y="35.6" width="12" height="2.2" rx="1.1" fill="#9aa8bb"/>',
    server:
      '<rect x="18" y="2" width="28" height="44" rx="3.5" fill="#4a5a70"/>' +
      '<rect x="21.5" y="6" width="21" height="8" rx="1.5" fill="#1f2a3a"/>' +
      '<rect x="21.5" y="17" width="21" height="8" rx="1.5" fill="#1f2a3a"/>' +
      '<rect x="21.5" y="28" width="21" height="8" rx="1.5" fill="#1f2a3a"/>' +
      '<rect x="24" y="9" width="9" height="2" rx="1" fill="#6b7a8f"/>' +
      '<rect x="24" y="20" width="9" height="2" rx="1" fill="#6b7a8f"/>' +
      '<rect x="24" y="31" width="9" height="2" rx="1" fill="#6b7a8f"/>' +
      '<circle cx="38.5" cy="10" r="1.7" fill="#22c55e"/>' +
      '<circle cx="38.5" cy="21" r="1.7" fill="#22c55e"/>' +
      '<circle cx="38.5" cy="32" r="1.7" fill="#f59e0b"/>' +
      '<rect x="21.5" y="39.5" width="21" height="3" rx="1.5" fill="#35445a"/>',
    switch:
      '<path d="M4 18L11 11H60L53 18Z" fill="#6aa7ff"/>' +
      '<path d="M53 18L60 11V31L53 38Z" fill="#1b4fc4"/>' +
      '<rect x="4" y="18" width="49" height="20" rx="1.5" fill="#2563eb"/>' +
      arrow(9, 24, 24, 24, '#fff', 2) + arrow(48, 24, 33, 24, '#fff', 2) +
      arrow(24, 32, 9, 32, '#fff', 2) + arrow(33, 32, 48, 32, '#fff', 2),
    router:
      '<ellipse cx="32" cy="31" rx="27" ry="10" fill="#0b6477"/>' +
      '<rect x="5" y="19" width="54" height="12" fill="#0b6477"/>' +
      '<ellipse cx="32" cy="19" rx="27" ry="10" fill="#19a7c2"/>' +
      arrow(13, 14.5, 25, 17.5, '#fff', 2) + arrow(51, 23.5, 39, 20.5, '#fff', 2) +
      arrow(36, 17, 49, 13.5, '#fff', 2) + arrow(28, 21, 15, 24.5, '#fff', 2),
    hub:
      '<path d="M4 20L11 13H60L53 20Z" fill="#b6c2d2"/>' +
      '<path d="M53 20L60 13V29L53 36Z" fill="#56657a"/>' +
      '<rect x="4" y="20" width="49" height="16" rx="1.5" fill="#7a889c"/>' +
      arrow(20, 28, 9, 28, '#fff', 2) + arrow(37, 28, 48, 28, '#fff', 2) +
      '<circle cx="28.5" cy="28" r="2.6" fill="#fff"/>',
    printer:
      '<rect x="17" y="3" width="30" height="13" rx="1.5" fill="#e5e7eb"/>' +
      '<path d="M22 8h20M22 11.5h14" stroke="#9aa5b3" stroke-width="1.4"/>' +
      '<rect x="6" y="14" width="52" height="20" rx="4" fill="#6b7a8f"/>' +
      '<rect x="12" y="29" width="40" height="15" rx="1.5" fill="#f3f4f6"/>' +
      '<path d="M17 35h30M17 39h22" stroke="#9aa5b3" stroke-width="1.6"/>' +
      '<circle cx="50" cy="20" r="2" fill="#22c55e"/>',
    tablet:
      '<rect x="15" y="2" width="34" height="44" rx="5" fill="#4a5a70"/>' +
      '<rect x="18.5" y="6" width="27" height="33" rx="1.5" fill="#1d3b63"/>' +
      '<path d="M18.5 39V25l11-9.5h16V39z" fill="#28508a" opacity=".55"/>' +
      '<circle cx="32" cy="42.5" r="1.7" fill="#9aa8bb"/>',
    ap:
      '<path d="M17 28V10M47 28V10" stroke="#4a5a70" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M24 17a11 11 0 0 1 16 0M27.5 21a6 6 0 0 1 9 0" stroke="#60a5fa" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
      '<circle cx="32" cy="24" r="1.9" fill="#60a5fa"/>' +
      '<rect x="8" y="28" width="48" height="13" rx="4.5" fill="#2563eb"/>' +
      '<circle cx="15" cy="34.5" r="1.6" fill="#22c55e"/><circle cx="21" cy="34.5" r="1.6" fill="#22c55e"/><circle cx="27" cy="34.5" r="1.6" fill="#f59e0b"/>',
    wrouter:
      '<path d="M13 26V5M51 26V5" stroke="#4a5a70" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M25 13a10 10 0 0 1 14 0M28 17a5 5 0 0 1 8 0" stroke="#19a7c2" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
      '<ellipse cx="32" cy="36" rx="26" ry="8.5" fill="#0b6477"/>' +
      '<rect x="6" y="26" width="52" height="10" fill="#0b6477"/>' +
      '<ellipse cx="32" cy="26" rx="26" ry="8.5" fill="#19a7c2"/>' +
      arrow(16, 23, 26, 25.5, '#fff', 1.8) + arrow(48, 29, 38, 26.5, '#fff', 1.8),
    switch3:
      '<path d="M4 18L11 11H60L53 18Z" fill="#a78bfa"/>' +
      '<path d="M53 18L60 11V31L53 38Z" fill="#5b21b6"/>' +
      '<rect x="4" y="18" width="49" height="20" rx="1.5" fill="#7c3aed"/>' +
      arrow(9, 24, 24, 24, '#fff', 2) + arrow(48, 24, 33, 24, '#fff', 2) +
      arrow(24, 32, 9, 32, '#fff', 2) + arrow(33, 32, 48, 32, '#fff', 2) +
      '<circle cx="28.5" cy="28" r="3.2" fill="#fde68a"/>',
  };

  const iconKey = (type, model) => (model === '3560-24PS' ? 'switch3' : type);

  UI.deviceIcon = function (type, model) { return DEV[iconKey(type, model)] || DEV.pc; };

  UI.deviceSvg = function (type, cls, model) {
    return UI.svgFrom(DEV[iconKey(type, model)] || DEV.pc, { viewBox: '0 0 64 48', class: cls || 'di', 'aria-hidden': 'true' });
  };

  const P = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const TOOL = {
    select: '<path d="M5 3l13 7.5-5.5 1.6L10 18z" ' + P + '/><path d="M12.6 12.2L17 17" ' + P + '/>',
    cable: '<path d="M6 18c0-6 4-6 6-6s6 0 6-6" ' + P + '/><rect x="3" y="17" width="6" height="4" rx="1" ' + P + '/><rect x="15" y="3" width="6" height="4" rx="1" ' + P + '/>',
    pdu: '<rect x="3" y="6" width="18" height="12" rx="2" ' + P + '/><path d="M3.5 7l8.5 6 8.5-6" ' + P + '/>',
    mail: '<path d="M4 10l8-6 8 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" ' + P + '/><path d="M4 10l8 5 8-5" ' + P + '/>',
    note: '<path d="M5 4h14v11l-5 5H5z" ' + P + '/><path d="M14 20v-5h5" ' + P + '/><path d="M8 9h8M8 12h5" ' + P + '/>',
    delete: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" ' + P + '/><path d="M10 11v6M14 11v6" ' + P + '/>',
    undo: '<path d="M9 14L4 9l5-5" ' + P + '/><path d="M4 9h10a6 6 0 0 1 0 12h-3" ' + P + '/>',
    redo: '<path d="M15 14l5-5-5-5" ' + P + '/><path d="M20 9H10a6 6 0 0 0 0 12h3" ' + P + '/>',
    newfile: '<path d="M14 3H6v18h12V7z" ' + P + '/><path d="M14 3v4h4M12 11v6M9 14h6" ' + P + '/>',
    open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" ' + P + '/>',
    save: '<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2z" ' + P + '/><path d="M8 3v5h7V3M8 21v-7h8v7" ' + P + '/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" ' + P + '/><path d="M4 21a2 2 0 0 1 2-2h13v2" ' + P + '/>',
    help: '<circle cx="12" cy="12" r="9" ' + P + '/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4M12 17.5v.01" ' + P + '/>',
    sun: '<circle cx="12" cy="12" r="4" ' + P + '/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" ' + P + '/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" ' + P + '/>',
    play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
    step: '<path d="M5 4l10 8-10 8z" fill="currentColor"/><rect x="16" y="4" width="3" height="16" rx="1" fill="currentColor"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.3-5.6" ' + P + '/><path d="M4 4v5h5" ' + P + '/>',
    zin: '<circle cx="11" cy="11" r="7" ' + P + '/><path d="M16 16l5 5M8 11h6M11 8v6" ' + P + '/>',
    zout: '<circle cx="11" cy="11" r="7" ' + P + '/><path d="M16 16l5 5M8 11h6" ' + P + '/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" ' + P + '/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z" ' + P + '/><circle cx="7.5" cy="8.5" r="1.3" fill="currentColor"/>',
    close: '<path d="M6 6l12 12M18 6L6 18" ' + P + '/>',
    power: '<path d="M12 3v8" ' + P + '/><path d="M6.3 7.5a8 8 0 1 0 11.4 0" ' + P + '/>',
    clear: '<path d="M4 20h16M7 16l9-9 3 3-9 9H7z" ' + P + '/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" ' + P + '/>',
    inspect: '<circle cx="10" cy="10" r="6.5" ' + P + '/><path d="M15 15l6 6M7 8.5h6M7 11.5h4" ' + P + '/>',
    shape: '<rect x="3" y="5" width="11" height="9" rx="1" ' + P + '/><circle cx="16" cy="15" r="5" ' + P + '/>',
    cycle: '<path d="M12 3v6" ' + P + '/><path d="M6.3 7.5a8 8 0 1 0 11.4 0" ' + P + '/><path d="M16 3.5l1.7 4-4 .6" ' + P + '/>',
    ffwd: '<path d="M3 5l8 7-8 7zM12 5l8 7-8 7z" fill="currentColor"/>',
    chev: '<path d="M9 6l6 6-6 6" ' + P + '/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14" ' + P + '/>',
  };

  /** Значок кабеля (как в палитре «Соединения» Packet Tracer). */
  const CABLE_STYLE = {
    auto: { color: '#f59e0b', dash: null, bolt: true },
    console: { color: '#38bdf8', dash: null, curl: true },
    straight: { color: '#94a3b8', dash: null },
    cross: { color: '#94a3b8', dash: '3 2.5' },
    fiber: { color: '#f97316', dash: null },
    'serial-dce': { color: '#ef4444', dash: null, clock: true },
    'serial-dte': { color: '#ef4444', dash: null },
  };
  UI.CABLE_STYLE = CABLE_STYLE;
  UI.cableIcon = function (kind) {
    const st = CABLE_STYLE[kind] || CABLE_STYLE.straight;
    let m = '';
    if (st.bolt) m = '<path d="M13 2L5 13h6l-2 9 9-12h-6z" fill="' + st.color + '"/>';
    else if (st.curl) m = '<path d="M4 20c3-2 1-5 4-6s4 2 6 0 0-5 3-6 2-3 3-4" fill="none" stroke="' + st.color + '" stroke-width="2.4" stroke-linecap="round"/>';
    else {
      m = '<path d="M4 20C8 12 16 12 20 4" fill="none" stroke="' + st.color + '" stroke-width="2.6" stroke-linecap="round"' + (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + '/>';
      if (st.clock) m += '<circle cx="18" cy="17" r="4" fill="var(--panel)" stroke="' + st.color + '" stroke-width="1.6"/><path d="M18 15v2.2l1.4 1" stroke="' + st.color + '" stroke-width="1.4" fill="none"/>';
    }
    return UI.svgFrom(m, { viewBox: '0 0 24 24', class: 'ti', 'aria-hidden': 'true' });
  };

  UI.icon = function (name, cls) {
    return UI.svgFrom(TOOL[name] || '', { viewBox: '0 0 24 24', class: cls || 'ti', 'aria-hidden': 'true' });
  };

  UI.DEVICE_TYPES = [
    { type: 'pc', label: 'Компьютер', short: 'ПК' },
    { type: 'laptop', label: 'Ноутбук', short: 'Ноутбук' },
    { type: 'server', label: 'Сервер', short: 'Сервер' },
    { type: 'switch', label: 'Коммутатор', short: 'Коммутатор' },
    { type: 'router', label: 'Маршрутизатор', short: 'Маршрутизатор' },
    { type: 'hub', label: 'Концентратор', short: 'Хаб' },
    { type: 'printer', label: 'Принтер', short: 'Принтер' },
    { type: 'tablet', label: 'Планшет', short: 'Планшет' },
    { type: 'ap', label: 'Точка доступа', short: 'Точка доступа' },
    { type: 'wrouter', label: 'Беспроводной маршрутизатор', short: 'WRT300N' },
  ];

  /** Палитра устройств как в Packet Tracer: категории → модели. */
  UI.DEVICE_CATEGORIES = [
    { id: 'routers', label: 'Маршрути­заторы', icon: 'router', models: ['2911', '1941', 'Router-PT'] },
    { id: 'switches', label: 'Коммутаторы', icon: 'switch', models: ['2960-24TT', '3560-24PS'] },
    { id: 'hubs', label: 'Хабы', icon: 'hub', models: ['Hub-PT'] },
    { id: 'wireless', label: 'Беспроводные', icon: 'ap', models: ['AccessPoint-PT', 'WRT300N'] },
    { id: 'end', label: 'Конечные', icon: 'pc', models: ['PC-PT', 'Laptop-PT', 'Server-PT', 'Printer-PT', 'TabletPC-PT'] },
  ];

  UI.CABLES = [
    { kind: 'auto', label: 'Автоматически', hint: 'Тип кабеля и порты подбираются сами' },
    { kind: 'console', label: 'Консольный', hint: 'RS 232 компьютера → Console маршрутизатора или коммутатора' },
    { kind: 'straight', label: 'Медный прямой', hint: 'Разнотипные устройства: ПК—коммутатор, коммутатор—маршрутизатор' },
    { kind: 'cross', label: 'Медный перекрёстный', hint: 'Однотипные устройства: ПК—ПК, коммутатор—коммутатор, ПК—маршрутизатор' },
    { kind: 'fiber', label: 'Оптоволокно', hint: 'Оптические порты (модули 1FFE/1FGE, SFP)' },
    { kind: 'serial-dce', label: 'Serial DCE', hint: 'Последовательный канал; первое устройство — DCE (на нём задаётся clock rate)' },
    { kind: 'serial-dte', label: 'Serial DTE', hint: 'Последовательный канал; первое устройство — DTE' },
  ];

  UI.typeLabel = function (type) {
    const t = UI.DEVICE_TYPES.find((x) => x.type === type);
    return t ? t.label : type;
  };
})(globalThis.NetLab = globalThis.NetLab || {});
