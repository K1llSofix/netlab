/* NetLab UI — контроллер WLC 2504 и лёгкие точки доступа: значки, палитра, страницы WLAN / RADIUS /
 * точки доступа и клиенты (как веб-интерфейс WLC), состояние LAP. IP-настройки — общие страницы узла. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const ip = U.ipStr;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });
  const hint = (t) => h('div', { class: 'hint-box', style: { marginTop: '10px' } }, t);
  const tbl = (head, rows, empty) => h('table', { class: 'tbl', style: { marginTop: '8px' } },
    h('tr', null, head.map((x) => h('th', null, x))),
    rows.length ? rows : h('tr', { class: 'empty' }, h('td', { colspan: head.length }, empty || 'Пусто')));
  const delBtn = (fn) => h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: fn }, UI.icon('delete'));
  const SEC = { open: 'открытая', wpa2: 'WPA2-PSK', 'wpa2-ent': 'WPA2-Enterprise' };

  /* ---------- значки и палитра ---------- */

  const ICONS = {
    wlc: '<rect x="4" y="16" width="56" height="20" rx="2.5" fill="#334155"/>' +
      '<rect x="4" y="16" width="56" height="5" rx="2.5" fill="#475569"/>' +
      [0, 1, 2, 3].map((i) => '<rect x="' + (36 + i * 5.5) + '" y="27" width="3.6" height="4" fill="#94a3b8"/>').join('') +
      '<path d="M12 30a9 9 0 0 1 12 0M15 33a4.5 4.5 0 0 1 6 0" stroke="#7dd3fc" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '<circle cx="18" cy="35.2" r="1.3" fill="#7dd3fc"/>',
    lap: '<ellipse cx="32" cy="30" rx="22" ry="10" fill="#e2e8f0" stroke="#64748b" stroke-width="1.6"/>' +
      '<ellipse cx="32" cy="28" rx="15" ry="5.5" fill="#f8fafc"/>' +
      '<circle cx="32" cy="28" r="2" fill="#16a34a"/>' +
      '<path d="M22 14a14 14 0 0 1 20 0M26 18a8 8 0 0 1 12 0" stroke="#0284c7" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
  };
  const baseIcon = UI.deviceIcon;
  UI.deviceIcon = function (type, model) { return ICONS[type] || baseIcon(type, model); };
  UI.DEVICE_TYPES.push({ type: 'wlc', label: 'Контроллер WLC', short: 'WLC' }, { type: 'lap', label: 'Лёгкая точка доступа', short: 'LAP' });
  const cat = UI.DEVICE_CATEGORIES.find((c) => c.id === 'wireless');
  if (cat) cat.models.push('WLC-2504', '3702i');

  /* ---------- WLC: WLAN ---------- */

  function wlanPage(app, dev, box) {
    const e = err();
    const apply = (fn) => DW.apply(app, () => fn(app.net.getDevice(dev.id)), e, true);
    box.appendChild(DW.section('WLANs'));
    const ssid = h('input', { class: 'inp', placeholder: 'SSID', style: { width: '150px' }, spellcheck: 'false' });
    const sec = DW.select([['open', 'открытая'], ['wpa2', 'WPA2-PSK'], ['wpa2-ent', 'WPA2-Enterprise (802.1X)']], 'wpa2');
    const key = h('input', { class: 'inp', type: 'password', placeholder: 'PSK (8–63)', style: { width: '140px' } });
    const vlan = h('input', { class: 'inp', type: 'number', min: 1, max: 4094, placeholder: 'VLAN (нет — управление)', style: { width: '170px' } });
    sec.addEventListener('change', () => { key.style.display = sec.value === 'wpa2' ? '' : 'none'; });
    box.append(h('div', { class: 'row', style: { flexWrap: 'wrap' } }, ssid, sec, key, vlan, h('button', { class: 'btn primary small', onClick: () => apply((d) => d.setWlan({ ssid: ssid.value, security: sec.value, key: key.value, vlan: vlan.value ? Number(vlan.value) : null })) }, 'Создать')));
    box.append(tbl(['ID', 'SSID', 'Защита', 'VLAN', 'Включена', ''], dev.wlc.wlans.map((w) => h('tr', null, h('td', null, String(w.id)), h('td', null, w.ssid), h('td', null, SEC[w.security]),
      h('td', null, w.vlan ? String(w.vlan) : 'управление'),
      h('td', null, UI.toggle('', w.enabled !== false, (on) => apply((d) => d.setWlan(Object.assign({}, w, { enabled: on }), w.ssid)))),
      h('td', null, delBtn(() => apply((d) => d.removeWlan(w.ssid)))))), 'WLAN нет'), e,
    hint('WLAN раздаются всем точкам доступа, подключённым к контроллеру. Трафик клиентов идёт туннелем CAPWAP на WLC и выходит в проводную сеть с тегом VLAN этой WLAN — порт коммутатора к контроллеру должен быть транком (VLAN управления — native). Для WPA2-Enterprise сначала добавьте RADIUS-сервер.'));
    return null;
  }

  function radiusPage(app, dev, box) {
    const e = err();
    box.appendChild(DW.section('Security → RADIUS Authentication'));
    const a = DW.ipInput('', 'адрес сервера');
    const k = h('input', { class: 'inp', placeholder: 'shared secret', style: { width: '150px' } });
    const list = dev.wlc.radius;
    box.append(h('div', { class: 'row' }, a, k, h('button', { class: 'btn primary small', onClick: () => {
      const r = DW.readIp(a, true);
      if (!r.ok) { e.textContent = r.err; return; }
      DW.apply(app, () => { const d = app.net.getDevice(dev.id); d.setRadius(d.wlc.radius.concat([{ ip: r.v, key: k.value.trim() }])); }, e, true);
    } }, 'Добавить')),
    tbl(['Сервер', 'Порт', 'Ключ', ''], list.map((r, i) => h('tr', null, h('td', { class: 'mono' }, ip(r.ip)), h('td', null, String(r.port || 1812)), h('td', { class: 'mono' }, r.key),
      h('td', null, delBtn(() => DW.apply(app, () => { const d = app.net.getDevice(dev.id); d.setRadius(d.wlc.radius.filter((_, j) => j !== i)); }, e, true))))), 'Серверов нет'), e,
    hint('Контроллер проверяет пользователей WPA2-Enterprise на RADIUS-сервере. На сервере (Службы → AAA) добавьте клиента с адресом управления WLC и тем же ключом.'));
    return null;
  }

  function apsPage(app, dev, box) {
    box.appendChild(DW.section('Точки доступа и клиенты'));
    const aps = h('div');
    const cl = h('div');
    box.append(aps, h('div', { style: { fontWeight: 600, marginTop: '12px' } }, 'Клиенты'), cl,
      hint('Лёгкая точка доступа получает адрес по DHCP и ищет контроллер широковещательно в своей сети; если она в другой сети — добавьте в DHCP-пул option 43 (hex f104.<адрес WLC>). Без контроллера LAP не вещает сети.'));
    return () => {
      const d = app.net.getDevice(dev.id);
      UI.clear(aps);
      aps.append(tbl(['Точка доступа', 'IP-адрес', 'Модель', 'Клиентов'], [...d.wlcRt.aps.values()].map((a) => {
        const lap = a.dev && app.net.getDevice(a.dev);
        return h('tr', null, h('td', null, a.name), h('td', { class: 'mono' }, ip(a.ip)), h('td', null, a.model || ''), h('td', null, String(lap && lap.wirelessClients ? lap.wirelessClients().length : 0)));
      }), 'Ни одна точка не подключена'));
      UI.clear(cl);
      cl.append(tbl(['MAC', 'WLAN', 'VLAN', 'Точка'], [...d.wlcRt.clients.values()].map((c) => h('tr', null, h('td', { class: 'mono' }, c.mac), h('td', null, c.ssid), h('td', null, c.vlan ? String(c.vlan) : 'упр.'), h('td', null, d.apName(c.lap)))), 'Клиентов нет'));
    };
  }

  function lapPage(app, dev, box) {
    box.appendChild(DW.section('Лёгкая точка доступа (CAPWAP)'));
    const st = h('div');
    box.append(st, hint('LAP не настраивается сама: адрес она получает по DHCP, а сети (WLAN) — от контроллера WLC после подключения по CAPWAP. Кадры клиентов она передаёт туннелем на контроллер.'));
    return () => {
      const d = app.net.getDevice(dev.id);
      const rt = d.lapRt || {};
      UI.clear(st);
      const state = { idle: 'нет адреса', discovery: 'поиск контроллера…', join: 'подключение…', joined: 'подключена' }[rt.state] || rt.state;
      st.append(DW.form(lbl('Адрес'), h('div', { class: 'mono' }, d.iface.ip != null ? U.cidr(d.iface.ip, d.iface.mask) : (d.dhcpStatus || 'ожидание DHCP')),
        lbl('Контроллер'), h('div', null, h('span', { class: 'st ' + (rt.state === 'joined' ? 'ok' : 'bad') }, state), rt.wlc != null ? ' ' + ip(rt.wlc) : ''),
        lbl('WLAN'), h('div', null, (rt.wlans || []).map((w) => w.ssid + ' (' + SEC[w.security] + (w.vlan ? ', VLAN ' + w.vlan : '') + ')').join('; ') || '—'),
        lbl('Клиенты'), h('div', null, d.wirelessClients().map((c) => c.name).join(', ') || '—')));
    };
  }

  DW.hostPages = (DW.hostPages || []).concat([
    { id: 'wlans', label: 'WLAN', applies: (d) => d.type === 'wlc', render: wlanPage },
    { id: 'wlcsec', label: 'RADIUS', applies: (d) => d.type === 'wlc', render: radiusPage },
    { id: 'wlcaps', label: 'Точки и клиенты', applies: (d) => d.type === 'wlc', render: apsPage },
    { id: 'lap', label: 'CAPWAP', applies: (d) => d.type === 'lap', render: lapPage },
  ]);
})(globalThis.NetLab = globalThis.NetLab || {});
