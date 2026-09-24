/* NetLab UI — сетевой контроллер (страницы учётных данных, обнаружения и инвентаря)
 * и программа «REST-клиент» на рабочем столе ПК: метод, адрес, заголовки, тело JSON, ответ. */
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

  /* ---------- значок и палитра ---------- */

  const ICON = '<rect x="10" y="8" width="44" height="32" rx="3" fill="#0f172a"/>' +
    '<circle cx="32" cy="16" r="3.2" fill="#38bdf8"/><circle cx="20" cy="31" r="3.2" fill="#38bdf8"/><circle cx="44" cy="31" r="3.2" fill="#38bdf8"/>' +
    '<path d="M32 19v5M32 24H20v4M32 24h12v4" stroke="#7dd3fc" stroke-width="1.8" fill="none"/>' +
    '<rect x="26" y="41" width="12" height="3" fill="#475569"/>';
  const baseIcon = UI.deviceIcon;
  UI.deviceIcon = function (type, model) { return type === 'netctrl' ? ICON : baseIcon(type, model); };
  UI.DEVICE_TYPES.push({ type: 'netctrl', label: 'Сетевой контроллер', short: 'Контроллер' });
  const end = UI.DEVICE_CATEGORIES.find((c) => c.id === 'end');
  if (end) end.models.push('NetworkController-PT');

  /* ---------- страницы контроллера ---------- */

  function ctrlPage(app, dev, box) {
    const e = err();
    const apply = (fn) => DW.apply(app, () => fn(app.net.getDevice(dev.id)), e, true);
    const c = dev.ctrl;
    const au = h('input', { class: 'inp', value: c.users[0].user, style: { width: '140px' } });
    const ap = h('input', { class: 'inp', type: 'password', value: c.users[0].pass, style: { width: '140px' } });
    box.append(DW.section('Администратор (вход в REST API)'), h('div', { class: 'row' }, au, ap, h('button', { class: 'btn primary small', onClick: () => apply((d) => d.setAdmin(au.value.trim(), ap.value)) }, 'Сохранить')));
    const cu = h('input', { class: 'inp', placeholder: 'username CLI', style: { width: '140px' } });
    const cp = h('input', { class: 'inp', placeholder: 'пароль', style: { width: '140px' } });
    box.append(DW.section('Учётные данные CLI для обнаружения'), h('div', { class: 'row' }, cu, cp, h('button', { class: 'btn primary small', onClick: () => apply((d) => d.addCredential(cu.value, cp.value)) }, 'Добавить')),
      tbl(['Пользователь', 'Пароль', ''], c.creds.map((x) => h('tr', null, h('td', null, x.user), h('td', { class: 'mono' }, x.pass),
        h('td', null, h('button', { class: 'btn icon small danger', onClick: () => apply((d) => { d.ctrl.creds = d.ctrl.creds.filter((y) => y.user !== x.user); }) }, UI.icon('delete'))))), 'Нет — все устройства будут «Credential mismatch»'));
    const dn = h('input', { class: 'inp', value: 'LAN', style: { width: '120px' } });
    const dr = h('input', { class: 'inp mono', placeholder: '192.168.1.1-192.168.1.254', style: { width: '240px' } });
    box.append(DW.section('Обнаружение (Discovery)'), h('div', { class: 'row' }, dn, dr, h('button', { class: 'btn primary small', onClick: () => apply((d) => d.discover(dn.value, dr.value)) }, 'Запустить')), e);
    const inv = h('div');
    box.append(inv, hint('REST API: POST /api/v1/ticket с телом {"username":"…","password":"…"} → serviceTicket; дальше — заголовок X-Auth-Token: GET /api/v1/network-device, /api/v1/host, /api/v1/discovery. Попробуйте программу «REST-клиент» на рабочем столе ПК или откройте http://<адрес контроллера> в браузере. Устройство становится Managed, если на нём есть пользователь с теми же учётными данными CLI (username … secret …).'));
    return () => {
      const d = app.net.getDevice(dev.id);
      const rt = d.ctrlRt;
      UI.clear(inv);
      inv.append(tbl(['Обнаружение', 'Диапазон', 'Найдено', 'Состояние'], d.ctrl.discoveries.map((x) => h('tr', null, h('td', null, x.name), h('td', { class: 'mono' }, x.range), h('td', null, String(x.found)), h('td', null, x.status))), 'Не запускалось'),
        h('div', { style: { fontWeight: 600, marginTop: '10px' } }, 'Сетевые устройства'),
        tbl(['Hostname', 'IP', 'Платформа', 'Состояние'], [...rt.devices.values()].map((x) => h('tr', null, h('td', null, x.hostname), h('td', { class: 'mono' }, ip(x.managementIpAddress)), h('td', null, x.platformId),
          h('td', null, h('span', { class: 'st ' + (x.collectionStatus === 'Managed' ? 'ok' : 'bad') }, x.collectionStatus)))), 'Нет'),
        h('div', { style: { fontWeight: 600, marginTop: '10px' } }, 'Узлы'),
        tbl(['Имя', 'IP', 'MAC'], [...rt.hosts.values()].map((x) => h('tr', null, h('td', null, x.name), h('td', { class: 'mono' }, ip(x.hostIp)), h('td', { class: 'mono' }, x.hostMac))), 'Нет'));
    };
  }

  DW.hostPages = (DW.hostPages || []).concat([{ id: 'netctrl', label: 'Контроллер', applies: (d) => d.type === 'netctrl', render: ctrlPage }]);

  /* ---------- REST-клиент ---------- */

  function restApp(app, id, box, st) {
    const m = (st.rest = st.rest || { method: 'POST', url: 'http://192.168.1.100/api/v1/ticket', headers: 'Content-Type: application/json', body: '{\n  "username": "admin",\n  "password": "cisco123"\n}', resp: null, busy: false });
    const method = DW.select([['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['DELETE', 'DELETE']], m.method, (v) => { m.method = v; });
    method.style.width = '100px';
    const url = h('input', { class: 'inp mono', value: m.url, style: { flex: 1 } });
    url.addEventListener('input', () => { m.url = url.value; });
    const headers = h('textarea', { class: 'code-editor mono small', value: m.headers, placeholder: 'Заголовок: значение (по строке)' });
    headers.value = m.headers;
    headers.addEventListener('input', () => { m.headers = headers.value; });
    const body = h('textarea', { class: 'code-editor mono small' });
    body.value = m.body;
    body.addEventListener('input', () => { m.body = body.value; });
    const out = h('pre', { class: 'ios-log', style: { maxHeight: '260px', whiteSpace: 'pre-wrap' } });
    const statusEl = h('div');
    const draw = () => {
      UI.clear(statusEl);
      const r = m.resp;
      if (!r) { out.textContent = ''; return; }
      if (!r.ok) { statusEl.append(h('span', { class: 'st bad' }, 'Ошибка: ' + r.error)); out.textContent = ''; return; }
      statusEl.append(h('span', { class: 'st ' + (r.status < 400 ? 'ok' : 'bad') }, r.status + ' ' + (r.reason || '')));
      out.textContent = r.json ? JSON.stringify(r.json, null, 2) : r.body;
    };
    const send = () => {
      const d = app.net.getDevice(id);
      const hs = {};
      for (const line of m.headers.split('\n')) { const k = line.indexOf(':'); if (k > 0) hs[line.slice(0, k).trim()] = line.slice(k + 1).trim(); }
      m.busy = true;
      m.resp = null;
      statusEl.textContent = 'Отправка…';
      d.httpRequest(m.method, m.url, { headers: hs, body: m.method === 'GET' || !m.body.trim() ? null : m.body }, (r) => {
        m.busy = false;
        m.resp = r;
        // удобство: токен из ответа на /ticket — сразу в заголовки
        const tok = r.json && r.json.response && r.json.response.serviceTicket;
        if (tok) {
          m.headers = m.headers.split('\n').filter((l) => !/^x-auth-token\s*:/i.test(l)).concat(['X-Auth-Token: ' + tok]).join('\n');
          headers.value = m.headers;
        }
        if (box.isConnected) draw();
      });
    };
    box.append(h('div', null,
      h('div', { class: 'row' }, method, url, h('button', { class: 'btn primary small', onClick: send }, 'Отправить')),
      h('div', { class: 'section-title' }, 'Заголовки'), headers,
      h('div', { class: 'section-title' }, 'Тело запроса (JSON)'), body,
      h('div', { class: 'section-title' }, 'Ответ'), statusEl, out,
      hint('Как с сетевым контроллером: 1) POST /api/v1/ticket — получите serviceTicket (он сам добавится в заголовок X-Auth-Token); 2) GET http://<контроллер>/api/v1/network-device — список устройств в JSON.')));
    draw();
  }

  DW.appGlyphs = Object.assign(DW.appGlyphs || {}, {
    rest: (s, W) => [s('text', { x: 24, y: 22, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: W, 'font-family': 'Segoe UI, sans-serif' }, 'REST'), s('path', { d: 'M10 30h28M30 25l8 5-8 5', stroke: W, 'stroke-width': 2.4, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })],
  });
  DW.desktopApps.push({ id: 'rest', title: 'REST-клиент', color: '#0369a1', render: restApp, when: (d) => !!d.iface && d.type !== 'netctrl' });
})(globalThis.NetLab = globalThis.NetLab || {});
