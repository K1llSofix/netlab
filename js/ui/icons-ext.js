/* NetLab UI — значки новых устройств (IP-телефон, телефонная сеть, Bluetooth, IoT, платы и компоненты),
 * палитра устройств и кабели. Значки умных устройств и компонентов показывают состояние:
 * лампа светит, светодиод горит, колонка играет, дверь открыта. */
(function (NS) {
  'use strict';

  const UI = NS.ui;

  const DEV = {
    ipphone:
      '<path d="M8 42L15 16H57L61 42Z" fill="#4a5a70"/>' +
      '<rect x="4" y="12" width="12" height="31" rx="5.5" fill="#1f2a3a"/>' +
      '<rect x="23" y="19" width="29" height="10" rx="1.5" fill="#a7f3d0"/>' +
      [0, 1, 2].map((c) => [0, 1, 2].map((r) => '<circle cx="' + (31 + c * 7) + '" cy="' + (33 + r * 3.2) + '" r="1.2" fill="#cbd5e1"/>').join('')).join(''),
    cloud:
      '<path d="M15 39a9.5 9.5 0 0 1 .5-19 13 13 0 0 1 24.5-5 10.5 10.5 0 0 1 10.5 11 7 7 0 0 1-1.5 13z" fill="#bfdbfe" stroke="#2563eb" stroke-width="2.2"/>' +
      '<path d="M26 22c1.5-1.5 3-1.5 4 0l1.5 2.5c.6 1-.2 2-1.2 2.6 1 2 2.5 3.5 4.5 4.5.6-1 1.6-1.8 2.6-1.2l2.5 1.5c1.5 1 1.5 2.5 0 4-4 3-15-8-13.9-13.9z" fill="#1d4ed8"/>',
    smartphone:
      '<rect x="21" y="2" width="22" height="44" rx="4.5" fill="#1f2a3a"/>' +
      '<rect x="23.5" y="7" width="17" height="32" rx="1.5" fill="#1d3b63"/>' +
      '<path d="M23.5 39V26l8-7h9v20z" fill="#28508a" opacity=".55"/>' +
      '<rect x="28.5" y="41.5" width="7" height="1.8" rx=".9" fill="#9aa8bb"/>',
    btheadset:
      '<path d="M12 30V24a20 20 0 0 1 40 0v6" fill="none" stroke="#334155" stroke-width="5" stroke-linecap="round"/>' +
      '<rect x="6" y="26" width="13" height="17" rx="5" fill="#1d4ed8"/><rect x="45" y="26" width="13" height="17" rx="5" fill="#1d4ed8"/>',
    homegw:
      '<path d="M13 22V6M51 22V6" stroke="#4a5a70" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M32 8L8 26h6v16h36V26h6z" fill="#15803d"/>' +
      '<rect x="27" y="30" width="10" height="12" rx="1" fill="#bbf7d0"/>' +
      '<path d="M25 20a10 10 0 0 1 14 0M28.5 23.5a5 5 0 0 1 7 0" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
    mcu:
      '<rect x="6" y="10" width="52" height="30" rx="3" fill="#1d4ed8"/>' +
      '<rect x="24" y="18" width="16" height="14" rx="1.5" fill="#0f172a"/>' +
      [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => '<rect x="' + (9 + i * 5.3) + '" y="12" width="2.4" height="3.6" fill="#fde68a"/>').join('') +
      [0, 1, 2, 3].map((i) => '<rect x="' + (10 + i * 5.3) + '" y="35" width="2.4" height="3.6" fill="#fde68a"/>').join(''),
    sbc:
      '<rect x="4" y="9" width="56" height="32" rx="3" fill="#15803d"/>' +
      '<rect x="10" y="16" width="14" height="14" rx="1.5" fill="#0f172a"/>' +
      '<rect x="44" y="18" width="14" height="12" rx="1" fill="#cbd5e1"/>' +
      '<rect x="30" y="17" width="10" height="7" rx="1" fill="#94a3b8"/>' +
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => '<rect x="' + (8 + i * 5) + '" y="11" width="2.4" height="3" fill="#fde68a"/>').join(''),
  };

  /* ---------- состояние ---------- */

  function speaker(playing) {
    return '<rect x="18" y="6" width="28" height="38" rx="6" fill="#334155"/>' +
      '<circle cx="32" cy="30" r="9" fill="#0f172a" stroke="#64748b" stroke-width="2"/><circle cx="32" cy="30" r="3.2" fill="#475569"/>' +
      '<circle cx="32" cy="14" r="3.5" fill="#0f172a"/>' +
      '<path d="M29.5 10.5l5 4-2.5 2v-8l2.5 2-5 4" fill="none" stroke="#60a5fa" stroke-width="1.2" transform="translate(0 0)"/>' +
      (playing ? '<path d="M50 12v12a3 3 0 1 1-2-2.8V14l7-2v9a3 3 0 1 1-2-2.8" fill="none" stroke="#f59e0b" stroke-width="2"/><path d="M8 18a14 14 0 0 1 0 16M12 21a8 8 0 0 1 0 10" stroke="#f59e0b" stroke-width="2" fill="none"/>' : '');
  }

  const THING = {
    lamp(st) {
      const lv = st.level || 0;
      const fill = lv === 2 ? '#fde047' : lv === 1 ? '#fef3c7' : '#e5e7eb';
      return (lv === 2 ? '<circle cx="32" cy="18" r="17" fill="#fde047" opacity=".35"/>' : '') +
        '<path d="M32 4a13 13 0 0 1 8 23v5H24v-5A13 13 0 0 1 32 4z" fill="' + fill + '" stroke="#a16207" stroke-width="1.8"/>' +
        '<rect x="24" y="33" width="16" height="4" rx="1" fill="#94a3b8"/><rect x="25.5" y="37.5" width="13" height="4" rx="1.5" fill="#64748b"/>' +
        (lv ? '<path d="M28 20l4 4 4-4" stroke="#a16207" stroke-width="1.4" fill="none"/>' : '');
    },
    fan(st) {
      const c = st.speed === 2 ? '#0284c7' : st.speed === 1 ? '#38bdf8' : '#94a3b8';
      return '<circle cx="32" cy="22" r="18" fill="#e2e8f0" stroke="#475569" stroke-width="2"/>' +
        [0, 120, 240].map((a) => '<path d="M32 22c-3-8 0-14 6-14-1 6-2 10-6 14z" fill="' + c + '" transform="rotate(' + (a + (st.speed ? 25 : 0)) + ' 32 22)"/>').join('') +
        '<circle cx="32" cy="22" r="3" fill="#334155"/><rect x="30" y="40" width="4" height="4" fill="#475569"/><rect x="22" y="43" width="20" height="3" rx="1.5" fill="#475569"/>';
    },
    door(st) {
      return '<rect x="17" y="3" width="30" height="42" rx="1.5" fill="#78350f"/>' +
        (st.open ? '<path d="M20 5L38 9V44L20 42Z" fill="#fbbf24" stroke="#92400e" stroke-width="1.4"/><circle cx="34" cy="26" r="1.6" fill="#1f2937"/>'
          : '<rect x="20" y="6" width="24" height="37" fill="#b45309"/><circle cx="40" cy="26" r="1.8" fill="#fde68a"/>') +
        (st.locked ? '<rect x="48" y="20" width="11" height="9" rx="1.5" fill="#dc2626"/><path d="M50.5 20v-3a3 3 0 0 1 6 0v3" stroke="#dc2626" stroke-width="2" fill="none"/>' : '');
    },
    window(st) {
      return '<rect x="10" y="6" width="44" height="36" rx="2" fill="#bae6fd" stroke="#475569" stroke-width="3"/>' +
        '<path d="M32 6v36M10 24h44" stroke="#475569" stroke-width="2.4"/>' +
        (st.open ? '<path d="M32 7l14 5v27l-14 2z" fill="#e0f2fe" stroke="#0369a1" stroke-width="1.6"/>' : '');
    },
    siren(st) {
      return (st.on ? '<path d="M8 12l6 5M56 12l-6 5M4 26h7M60 26h-7" stroke="#ef4444" stroke-width="2.6" stroke-linecap="round"/>' : '') +
        '<path d="M18 36V24a14 14 0 0 1 28 0v12z" fill="' + (st.on ? '#ef4444' : '#fca5a5') + '"/>' +
        '<rect x="13" y="36" width="38" height="7" rx="2" fill="#475569"/>' + (st.on ? '<circle cx="28" cy="22" r="3.5" fill="#fff" opacity=".7"/>' : '');
    },
    coffee(st) {
      return '<rect x="14" y="4" width="30" height="8" rx="2" fill="#374151"/><rect x="14" y="12" width="8" height="30" fill="#374151"/><rect x="12" y="40" width="36" height="5" rx="2" fill="#1f2937"/>' +
        '<path d="M28 26h14v10a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5z" fill="#f5f5f4" stroke="#78716c" stroke-width="1.5"/><path d="M42 29h3a3 3 0 0 1 0 6h-3" fill="none" stroke="#78716c" stroke-width="1.5"/>' +
        (st.brewing ? '<path d="M31 22c-2-3 2-4 0-7M36 22c-2-3 2-4 0-7" stroke="#9ca3af" stroke-width="1.6" fill="none"/><rect x="33" y="12" width="3" height="10" fill="#78350f"/>' : '');
    },
    motion(st) {
      return '<rect x="18" y="26" width="28" height="16" rx="3" fill="#e5e7eb" stroke="#64748b" stroke-width="1.5"/>' +
        '<path d="M22 26a10 10 0 0 1 20 0z" fill="#f8fafc" stroke="#64748b" stroke-width="1.5"/>' +
        (st.detected ? '<path d="M10 14a26 26 0 0 1 44 0M15 19a18 18 0 0 1 34 0" stroke="#ef4444" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
          : '<path d="M15 19a18 18 0 0 1 34 0" stroke="#cbd5e1" stroke-width="2" fill="none" stroke-dasharray="3 3"/>');
    },
    temp(st) {
      const v = Math.max(-40, Math.min(80, Number(st.value) || 0));
      const hh = 6 + ((v + 40) / 120) * 22;
      const c = v >= 30 ? '#ef4444' : v <= 5 ? '#3b82f6' : '#f97316';
      return '<rect x="26" y="4" width="12" height="32" rx="6" fill="#f1f5f9" stroke="#64748b" stroke-width="1.6"/>' +
        '<circle cx="32" cy="38" r="7" fill="' + c + '" stroke="#64748b" stroke-width="1.6"/><rect x="29.5" y="' + (36 - hh) + '" width="5" height="' + hh + '" fill="' + c + '"/>' +
        '<text x="50" y="22" font-size="10" font-weight="700" text-anchor="middle" fill="' + c + '" font-family="Segoe UI, sans-serif">' + Math.round(v) + '°</text>';
    },
    smoke(st) {
      const lv = Number(st.level) || 0;
      return (lv > 0 ? '<circle cx="20" cy="36" r="6" fill="#9ca3af" opacity="' + Math.min(0.9, 0.3 + lv / 150) + '"/><circle cx="30" cy="40" r="7" fill="#9ca3af" opacity="' + Math.min(0.9, 0.3 + lv / 150) + '"/><circle cx="42" cy="37" r="6" fill="#9ca3af" opacity="' + Math.min(0.9, 0.3 + lv / 150) + '"/>' : '') +
        '<ellipse cx="32" cy="18" rx="20" ry="8" fill="#f8fafc" stroke="#64748b" stroke-width="1.8"/><rect x="12" y="10" width="40" height="8" fill="#f8fafc"/><ellipse cx="32" cy="10" rx="20" ry="7" fill="#fff" stroke="#64748b" stroke-width="1.8"/>' +
        '<circle cx="32" cy="10" r="2.4" fill="' + (lv >= 50 ? '#ef4444' : '#22c55e') + '"/>';
    },
  };

  const COMP = {
    led: (v) => (v ? '<circle cx="32" cy="18" r="15" fill="#ef4444" opacity=".3"/>' : '') + '<path d="M24 32V18a8 8 0 0 1 16 0v14z" fill="' + (v ? '#ef4444' : '#fecaca') + '" stroke="#991b1b" stroke-width="1.5"/><rect x="22" y="31" width="20" height="3.5" rx="1" fill="#991b1b"/><path d="M28 35v9M36 35v7" stroke="#94a3b8" stroke-width="2"/>',
    buzzer: (v) => '<circle cx="30" cy="26" r="13" fill="#111827"/><circle cx="30" cy="26" r="2.5" fill="#374151"/>' + (v ? '<path d="M47 18a12 12 0 0 1 0 16M52 14a18 18 0 0 1 0 24" stroke="#f59e0b" stroke-width="2.4" fill="none"/>' : ''),
    motor: (v) => '<rect x="12" y="16" width="30" height="20" rx="4" fill="#94a3b8" stroke="#475569" stroke-width="1.5"/><rect x="42" y="23" width="10" height="6" fill="#475569"/>' + (v ? '<path d="M50 14a10 10 0 0 1 4 10M50 38a10 10 0 0 0 4-10" stroke="#16a34a" stroke-width="2.2" fill="none"/>' : '') + '<text x="27" y="30" font-size="9" text-anchor="middle" fill="#1f2937" font-family="Segoe UI, sans-serif">M</text>',
    button: (v) => '<rect x="16" y="24" width="32" height="16" rx="3" fill="#475569"/><rect x="24" y="' + (v ? 20 : 14) + '" width="16" height="' + (v ? 6 : 12) + '" rx="3" fill="#dc2626"/>',
    switch: (v) => '<rect x="14" y="24" width="36" height="14" rx="7" fill="' + (v ? '#16a34a' : '#94a3b8') + '"/><circle cx="' + (v ? 43 : 21) + '" cy="31" r="6" fill="#fff" stroke="#475569"/>',
    pot: (v) => '<circle cx="32" cy="26" r="14" fill="#1e3a8a"/><circle cx="32" cy="26" r="9" fill="#93c5fd"/><path d="M32 26L' + (32 + 8 * Math.cos(Math.PI * (0.75 + 1.5 * v / 1023))).toFixed(1) + ' ' + (26 + 8 * Math.sin(Math.PI * (0.75 + 1.5 * v / 1023))).toFixed(1) + '" stroke="#1e3a8a" stroke-width="2.5" stroke-linecap="round"/>',
    photo: (v) => '<circle cx="32" cy="30" r="10" fill="#fef9c3" stroke="#a16207" stroke-width="1.5"/><path d="M26 30h12M28 26h8M28 34h8" stroke="#a16207" stroke-width="1.2"/><circle cx="48" cy="12" r="' + (3 + (v / 1023) * 5).toFixed(1) + '" fill="#fbbf24"/>',
    tempsensor: (v) => '<rect x="22" y="12" width="20" height="20" rx="2" fill="#1f2937"/><path d="M28 32v10M32 32v10M36 32v10" stroke="#94a3b8" stroke-width="2"/><text x="32" y="26" font-size="8" text-anchor="middle" fill="#fca5a5" font-family="Segoe UI, sans-serif">' + Math.round((v / 1023) * 120 - 40) + '°</text>',
    pir: (v) => '<rect x="18" y="28" width="28" height="12" rx="2" fill="#16a34a"/><path d="M22 28a10 10 0 0 1 20 0z" fill="#f8fafc" stroke="#64748b"/>' + (v ? '<path d="M12 16a24 24 0 0 1 40 0" stroke="#ef4444" stroke-width="2.4" fill="none"/>' : ''),
  };

  /** Значок устройства по его состоянию (для схемы). */
  UI.deviceIconFor = function (d) {
    if (d.type === 'iot' && d.thing && THING[d.thing.kind]) return THING[d.thing.kind](d.thing.state || {});
    if (d.type === 'iotcomp' && d.info && COMP[d.info.kind]) return COMP[d.info.kind](d.value || 0);
    if (d.type === 'btspeaker') return speaker(!!(d.btRt && d.btRt.playing));
    return UI.deviceIcon(d.type, d.model);
  };

  /** Короткая подпись состояния под устройством на схеме: {text, cls} или null. */
  UI.deviceStatusText = function (d) {
    if (d.type === 'ipphone') {
      if (!d.power) return { text: 'нет питания', cls: 'warn' };
      const c = d.sccp;
      if (c && c.state === 'registered') return { text: '☎ ' + (c.number || 'без номера') + (c.call ? (c.call.state === 'connected' ? ' · разговор' : c.call.state === 'ringing' ? ' · звонок!' : ' · вызов') : ''), cls: 'ok' };
      return c && c.state === 'registering' ? { text: 'регистрация…' } : { text: 'не зарегистрирован', cls: 'warn' };
    }
    if (d.type === 'iot' && d.thing) {
      const k = NS.iot.KINDS[d.thing.kind];
      const first = Object.keys(k.props)[0];
      const t = NS.iot.propText(d.thing.kind, first, d.thing.state[first]);
      return { text: t + (d.iotRt && d.iotRt.state === 'registered' ? ' · ✓' : ''), cls: d.iotRt && d.iotRt.state === 'registered' ? 'ok' : '' };
    }
    if (d.type === 'btspeaker' || d.type === 'btheadset') {
      const pl = d.btRt && d.btRt.playing;
      if (pl) return { text: '♪ ' + pl.track, cls: 'ok' };
      return d.btRt && d.btRt.source ? { text: 'подключено', cls: 'ok' } : null;
    }
    if (d.type === 'iotcomp' && d.info && d.info.in && d.info.analog) return { text: String(d.value) };
    if (d.softphone && d.softphone.state === 'registered') return { text: '☎ ' + (d.softphone.number || '—') + ' (IP Communicator)', cls: 'ok' };
    if (d.dialup && d.dialup.state === 'up') return { text: '☎ модем: соединено', cls: 'ok' };
    if (d.pppoeClient && d.pppoeClient.state === 'up') return { text: 'PPPoE: ' + NS.util.ipStr(d.pppoeClient.ip), cls: 'ok' };
    if (d.vpn && d.vpn.state === 'up') return { text: 'VPN: ' + NS.util.ipStr(d.vpn.vip), cls: 'ok' };
    return null;
  };

  // значок по типу/модели — для палитры
  const baseIcon = UI.deviceIcon;
  UI.deviceIcon = function (type, model) {
    if (DEV[type]) return DEV[type];
    if (type === 'btspeaker') return speaker(false);
    const spec = model && NS.models.MODELS[model];
    if (type === 'iot') return THING[(spec && spec.thing) || 'lamp']({ level: 2, speed: 1, value: 22, on: true });
    if (type === 'iotcomp') { const k = spec && spec.comp; return COMP[k] ? COMP[k](k === 'pot' ? 512 : 1) : COMP.led(1); }
    return baseIcon(type, model);
  };
  UI.deviceSvg = function (type, cls, model) {
    return UI.svgFrom(UI.deviceIcon(type, model), { viewBox: '0 0 64 48', class: cls || 'di', 'aria-hidden': 'true' });
  };

  /* ---------- типы и палитра ---------- */

  UI.DEVICE_TYPES.push(
    { type: 'smartphone', label: 'Смартфон', short: 'Смартфон' },
    { type: 'ipphone', label: 'IP-телефон', short: 'IP-телефон' },
    { type: 'cloud', label: 'Телефонная сеть', short: 'Cloud' },
    { type: 'btspeaker', label: 'Bluetooth-колонка', short: 'Колонка' },
    { type: 'btheadset', label: 'Bluetooth-гарнитура', short: 'Гарнитура' },
    { type: 'homegw', label: 'Домашний шлюз IoT', short: 'Home Gateway' },
    { type: 'iot', label: 'Умное устройство', short: 'IoT' },
    { type: 'mcu', label: 'Микроконтроллер', short: 'MCU' },
    { type: 'sbc', label: 'Одноплатный компьютер', short: 'SBC' },
    { type: 'iotcomp', label: 'IoT-компонент', short: 'Компонент' },
  );

  const cat = (id) => UI.DEVICE_CATEGORIES.find((c) => c.id === id);
  cat('wireless').models.push('DLC100');
  cat('end').models.push('Smartphone-PT', '7960', 'BT-Speaker', 'BT-Headset');
  UI.DEVICE_CATEGORIES.push(
    { id: 'wan', label: 'WAN', icon: 'cloud', models: ['Cloud-PT'] },
    {
      id: 'iot', label: 'IoT', icon: 'iot', noQuickAdd: true,
      models: [{ title: 'Умный дом (регистрируются на IoT-сервере)' }].concat(Object.values(NS.iot.KINDS).map((k) => k.model),
        [{ title: 'Платы (вкладка «Программирование»)' }], ['MCU-PT', 'SBC-PT'], [{ title: 'Компоненты (IoT-кабель к пинам платы)' }], Object.keys(NS.iot.COMPS)),
    },
  );

  /* ---------- кабели ---------- */

  UI.CABLE_STYLE.phone = { color: '#a16207', dash: '1.5 2' };
  UI.CABLE_STYLE.iot = { color: '#7c3aed', dash: null };
  UI.CABLES.push(
    { kind: 'phone', label: 'Телефонный', hint: 'Модем компьютера (PT-HOST-NM-1AM) → порт Modem облака Cloud-PT' },
    { kind: 'iot', label: 'IoT (кастомный)', hint: 'Пины D0–D5 / A0–A3 платы MCU-PT или SBC-PT → IoT-компонент' },
  );
})(globalThis.NetLab = globalThis.NetLab || {});
