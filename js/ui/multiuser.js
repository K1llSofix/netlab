/* NetLab UI — многопользовательский режим: облако Multiuser-PT в палитре и его настройки,
 * окно подключения (ожидать подключений / подключиться к другой копии NetLab по адресу и паролю).
 * Работает в настольной версии (TCP через Electron); в браузере — только объяснение. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const DW = NS.dw;
  const MU = NS.multiuser;
  const desk = typeof window !== 'undefined' && window.netlabDesktop && window.netlabDesktop.mu ? window.netlabDesktop.mu : null;

  const lbl = (t) => h('label', null, t);

  const ICON = '<path d="M15 39a9.5 9.5 0 0 1 .5-19 13 13 0 0 1 24.5-5 10.5 10.5 0 0 1 10.5 11 7 7 0 0 1-1.5 13z" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2.2"/>' +
    '<circle cx="25" cy="29" r="4" fill="#7c3aed"/><circle cx="39" cy="29" r="4" fill="#7c3aed"/><path d="M29 29h6" stroke="#7c3aed" stroke-width="2.4"/>';
  const baseIcon = UI.deviceIcon;
  UI.deviceIcon = function (type, model) { return type === 'mucloud' ? ICON : baseIcon(type, model); };
  UI.DEVICE_TYPES.push({ type: 'mucloud', label: 'Многопользовательское облако', short: 'Multiuser' });
  const wan = UI.DEVICE_CATEGORIES.find((c) => c.id === 'wan');
  if (wan) wan.models.push('Multiuser-PT');

  const state = { status: { listening: false, port: null, peers: [] }, log: [] };
  const ready = () => state.status.peers.some((p) => p.ready);
  const peerName = (id) => { const p = state.status.peers.find((x) => x.id === id); return p ? p.name : 'удалённая копия'; };

  function setup(app) {
    if (!desk) return;
    MU.transport = (msg) => desk.send(msg);
    MU.connected = ready;
    desk.onEvent((ev) => {
      if (ev.type === 'status') state.status = ev.status;
      else if (ev.type === 'message') { MU.deliver(app.net, ev.msg, peerName(ev.peer)); app.needRender = true; }
      else if (ev.type === 'peer-up') { UI.toast('Подключено: ' + ev.name + ' (' + ev.addr + ')', 'ok'); state.log.push('+ ' + ev.name); }
      else if (ev.type === 'peer-down') { UI.toast('Отключено: ' + ev.name + ' — ' + ev.reason, 'warn'); state.log.push('− ' + ev.name + ': ' + ev.reason); }
      else if (ev.type === 'error') UI.toast('Многопользовательский режим: ' + ev.text, 'err', 5000);
      if (state.onChange) state.onChange();
    });
    desk.status().then((s) => { state.status = s; });
  }

  /** Окно «Многопользовательский режим». */
  UI.multiuserDialog = function (app) {
    if (!desk) {
      UI.modal({ title: 'Многопользовательский режим', body: 'Соединение с другой копией NetLab по сети работает в настольной версии программы (Windows): там можно ждать подключений или подключиться к другому компьютеру по адресу и паролю. В браузере эта функция недоступна.' });
      return;
    }
    const port = h('input', { class: 'inp', type: 'number', value: 38000, style: { width: '100px' } });
    const pass = h('input', { class: 'inp', type: 'password', placeholder: 'пароль', style: { width: '140px' } });
    const host = h('input', { class: 'inp mono', placeholder: 'адрес другого компьютера', style: { width: '180px' } });
    const e = h('div', { class: 'err-text' });
    const st = h('div');
    const draw = () => {
      UI.clear(st);
      const s = state.status;
      st.append(h('div', null, s.listening ? '● Ожидание подключений на порту ' + s.port : '○ Ожидание выключено'),
        h('table', { class: 'tbl', style: { marginTop: '6px' } }, h('tr', null, h('th', null, 'Копия NetLab'), h('th', null, 'Адрес'), h('th', null, '')),
          s.peers.length ? s.peers.map((p) => h('tr', null, h('td', null, p.name + (p.ready ? '' : ' (подключение…)')), h('td', { class: 'mono' }, p.addr),
            h('td', null, h('button', { class: 'btn small outline danger', onClick: async () => { state.status = await desk.disconnect(p.id); draw(); } }, 'Отключить'))))
            : h('tr', { class: 'empty' }, h('td', { colspan: 3 }, 'Нет подключений'))));
    };
    state.onChange = () => { if (st.isConnected) draw(); };
    const name = () => (app.fileName || 'NetLab').replace(/\.netlab$/i, '');
    const body = h('div', null,
      DW.form(lbl('Порт'), port, lbl('Пароль'), pass),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary small', onClick: async () => { e.textContent = ''; const r = await desk.listen({ port: Number(port.value), password: pass.value, name: name() }); if (!r.ok) e.textContent = r.error; else state.status = r.status; draw(); } }, 'Ждать подключений'),
        h('button', { class: 'btn outline small', onClick: async () => { state.status = await desk.stop(); draw(); } }, 'Перестать ждать')),
      h('div', { class: 'row', style: { marginTop: '8px' } }, host,
        h('button', { class: 'btn primary small', onClick: async () => { e.textContent = ''; const r = await desk.connect({ host: host.value.trim(), port: Number(port.value), password: pass.value, name: name() }); if (!r.ok) e.textContent = r.error; } }, 'Подключиться')),
      e, h('div', { class: 'section-title', style: { marginTop: '10px' } }, 'Состояние'), st,
      h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Поставьте в обе схемы облако Multiuser-PT (категория WAN) и подключите к его портам Link0…Link7 свои устройства. Кадр, ушедший в порт LinkN, выходит из порта LinkN облака в другой копии: облака находят друг друга по имени (или по полю «Удалённое облако»). Один компьютер ждёт подключений, другой подключается к его адресу с тем же паролем; порт должен быть открыт в брандмауэре.'));
    draw();
    UI.modal({ title: 'Многопользовательский режим', body, actions: [{ label: 'Закрыть', primary: true }] });
  };

  DW.configBuilders.mucloud = DW.simpleConfig({
    items: [{ group: 'MULTIUSER' }, { id: 'mu', label: 'Подключение' }],
    globalHint: () => 'Многопользовательское облако соединяет эту схему с другой копией NetLab. Кадры из порта LinkN уходят в порт LinkN облака на той стороне.',
    render(sec, app, d, box) {
      const e = h('div', { class: 'err-text' });
      const remote = h('input', { class: 'inp', value: d.remote || '', placeholder: 'как у этого облака: ' + d.name, style: { width: '220px' } });
      DW.commitOnChange(remote, () => DW.apply(app, () => { app.net.getDevice(d.id).remote = remote.value.trim(); }, e));
      const st = h('div');
      box.append(DW.section('Подключение'), DW.form(lbl('Удалённое облако'), remote, lbl('Состояние'), st, h('div', { class: 'full' }, e)),
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn outline small', onClick: () => UI.multiuserDialog(app) }, 'Многопользовательский режим…')));
      return () => {
        const x = app.net.getDevice(d.id);
        st.textContent = (desk ? (ready() ? 'подключено к ' + state.status.peers.filter((p) => p.ready).map((p) => p.name).join(', ') : 'нет подключения') : 'только в настольной версии') + ' · отправлено кадров: ' + x.stats.out + ', получено: ' + x.stats.in;
      };
    },
  });

  NS.muSetup = setup;
})(globalThis.NetLab = globalThis.NetLab || {});
