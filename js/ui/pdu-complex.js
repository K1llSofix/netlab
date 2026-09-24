/* NetLab UI — сложный PDU (окно параметров пакета) и сценарии в нижней панели:
 * выбор сценария, запуск всех его PDU («Запустить»), сохранение отправленного PDU в сценарий, периодические PDU. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;

  const lbl = (t) => h('label', null, t);

  function devLabel(net, id) { const d = net.getDevice(id); return d ? d.name : '?'; }

  /** Отправить PDU и показать строку в нижней панели. periodic — повтор каждые N секунд (время модели). */
  function sendPdu(app, spec) {
    const net = app.net;
    const item = app.pdu.add({ kind: 'cpdu', status: 'run', srcName: devLabel(net, spec.src), dstName: spec.dst, text: NS.pdu.describe(spec) + ': отправка…', spec });
    item.redo = () => sendPdu(app, spec);
    let stop = false;
    item.stop = () => { stop = true; };
    const once = () => {
      if (stop) return;
      NS.pdu.fire(app.net, spec, (r) => {
        item.status = r.status;
        item.text = NS.pdu.describe(spec) + ': ' + r.text + (spec.periodic ? ' · повтор каждые ' + spec.periodic + ' с' : '');
        app.pdu.update();
        if (spec.periodic && !stop) app.net.timer(null, spec.periodic * 100, once);
      });
    };
    once();
    if (app.mode === 'sim' && app.sim && !app.sim.playing) UI.toast('Симуляция на паузе — нажмите «Пуск» или «Шаг»', 'warn');
    return item;
  }

  /** Окно «Сложный PDU» для выбранного отправителя. */
  UI.complexPdu = function (app, srcId, preset) {
    const net = app.net;
    const src = net.getDevice(srcId);
    if (!src || !src.ifaces) { UI.toast('Отправитель должен быть узлом с IP-адресом (ПК, сервер, маршрутизатор…)', 'err'); return; }
    const p = Object.assign({ proto: 'icmp', dst: '', dport: '', sport: '', ttl: '', size: '', count: 1, periodic: '' }, preset || {});
    const targets = [...net.devices.values()].filter((d) => d.id !== srcId && d.ifaces && d.ifaces.some((f) => f.ip != null));
    const dst = h('input', { class: 'inp mono', value: p.dst, placeholder: 'IP-адрес или имя', list: 'cpdu-targets', spellcheck: 'false' });
    const dl = h('datalist', { id: 'cpdu-targets' }, targets.map((d) => h('option', { value: U.ipStr(app.pickTargetIp(src, d)) }, d.name)));
    const proto = DW.select([['icmp', 'ICMP (ping)'], ['tcp', 'TCP (попытка соединения)'], ['udp', 'UDP (датаграмма)']], p.proto);
    const dport = h('input', { class: 'inp', type: 'number', min: 1, max: 65535, value: p.dport || '', placeholder: 'например 80', style: { width: '110px' } });
    const sport = h('input', { class: 'inp', type: 'number', min: 1, max: 65535, value: p.sport || '', placeholder: 'авто', style: { width: '110px' } });
    const ttl = h('input', { class: 'inp', type: 'number', min: 1, max: 255, value: p.ttl || '', placeholder: 'по умолчанию', style: { width: '110px' } });
    const size = h('input', { class: 'inp', type: 'number', min: 1, max: 1500, value: p.size || '', placeholder: '32', style: { width: '110px' } });
    const count = h('input', { class: 'inp', type: 'number', min: 1, max: 20, value: p.count || 1, style: { width: '80px' } });
    const periodic = h('input', { class: 'inp', type: 'number', min: 1, max: 600, value: p.periodic || '', placeholder: 'однократно', style: { width: '110px' } });
    const toScen = h('input', { type: 'checkbox' });
    const portRows = [lbl('Порт получателя'), dport, lbl('Порт отправителя'), sport];
    const showPorts = () => { for (const x of portRows) x.style.display = proto.value === 'icmp' ? 'none' : ''; };
    proto.addEventListener('change', showPorts);
    const e = h('div', { class: 'err-text' });
    const body = h('div', null, dl, DW.form(lbl('Отправитель'), h('b', null, src.name), lbl('Получатель'), dst, lbl('Протокол'), proto, ...portRows, lbl('TTL'), ttl, lbl('Размер, байт'), size, lbl('Повторов'), count, lbl('Период, с'), periodic,
      lbl('Сценарий'), h('label', null, toScen, ' добавить в текущий сценарий')), e,
    h('div', { class: 'hint-box', style: { marginTop: '8px' } }, 'TCP-PDU открывает соединение (SYN → SYN+ACK → ACK) и сразу его закрывает: так проверяется, что порт открыт и списки доступа его пропускают. UDP-PDU считается доставленным, если за короткое время не пришло ICMP «порт недоступен».'));
    showPorts();
    const go = () => {
      if (!dst.value.trim()) { e.textContent = 'Укажите получателя'; return false; }
      const spec = NS.pdu.cleanSpec({ src: srcId, dst: dst.value.trim(), proto: proto.value, dport: dport.value, sport: sport.value, ttl: ttl.value, size: size.value, count: count.value, periodic: periodic.value });
      if (spec.proto !== 'icmp' && !spec.dport) { e.textContent = 'Укажите порт получателя'; return false; }
      if (toScen.checked) { const sc = NS.pdu.scenarios(app.net); sc.list[sc.current].pdus.push(spec); app.markDirty(); }
      sendPdu(app, spec);
      app.setTool('select');
      return true;
    };
    UI.modal({ title: 'Сложный PDU', body, actions: [{ label: 'Отмена' }, { label: 'Отправить', primary: true, onClick: go }], enterAction: go });
    showPorts();
  };

  /* ---------- панель сценариев над списком PDU ---------- */

  const baseRender = UI.PduPanel.prototype.render;
  UI.PduPanel.prototype.render = function () {
    const wasDirty = this.dirty;
    baseRender.call(this);
    if (!wasDirty) return;
    const app = this.app;
    const sc = NS.pdu.scenarios(app.net);
    const cur = sc.list[sc.current] || sc.list[0];
    const sel = DW.select(sc.list.map((x, i) => [String(i), x.name + (x.pdus.length ? ' (' + x.pdus.length + ')' : '')]), String(sc.current), (v) => { sc.current = Number(v); this.dirty = true; this.render(); });
    sel.style.width = '190px';
    const bar = h('div', { class: 'row pdu-scen', style: { gap: '6px', padding: '4px 6px', alignItems: 'center', flexWrap: 'wrap' } },
      h('span', { class: 'muted' }, 'Сценарий:'), sel,
      h('button', { class: 'btn small primary', title: 'Отправить все PDU сценария', disabled: !cur.pdus.length, onClick: () => { for (const spec of cur.pdus) sendPdu(app, spec); } }, 'Запустить'),
      h('button', { class: 'btn small outline', title: 'Новый сценарий', onClick: () => { sc.list.push({ name: 'Сценарий ' + sc.list.length, desc: '', pdus: [] }); sc.current = sc.list.length - 1; app.markDirty(); this.dirty = true; this.render(); } }, 'Новый'),
      h('button', { class: 'btn small outline', title: 'Переименовать', onClick: () => { const n = window.prompt('Имя сценария', cur.name); if (n && n.trim()) { cur.name = n.trim(); app.markDirty(); this.dirty = true; this.render(); } } }, 'Имя'),
      h('button', { class: 'btn small outline danger', title: 'Удалить сценарий', disabled: sc.list.length < 2, onClick: () => { sc.list.splice(sc.current, 1); sc.current = 0; app.markDirty(); this.dirty = true; this.render(); } }, 'Удалить'),
      cur.pdus.length ? h('span', { class: 'muted', style: { fontSize: '12px' } }, cur.pdus.map((s) => devLabel(app.net, s.src) + ' → ' + s.dst + ' ' + NS.pdu.describe(s)).join(' · ')) : h('span', { class: 'muted', style: { fontSize: '12px' } }, 'пусто — отметьте «добавить в сценарий» в окне «Сложный PDU» или нажмите ☆ у PDU в списке'));
    this.el.insertBefore(bar, this.el.firstChild);
    // кнопки у PDU: сохранить в сценарий, остановить периодический
    const rows = this.el.querySelectorAll('.pdu-table tr');
    this.items.forEach((it, k) => {
      const tr = rows[k + 1];
      if (!tr || !it.spec) return;
      const td = tr.lastElementChild;
      td.insertBefore(h('button', { class: 'btn icon small', title: 'Сохранить в текущий сценарий', onClick: () => { cur.pdus.push(NS.pdu.cleanSpec(it.spec)); app.markDirty(); this.dirty = true; this.render(); } }, '☆'), td.firstChild);
      if (it.spec.periodic && it.stop) td.insertBefore(h('button', { class: 'btn icon small', title: 'Остановить повтор', onClick: () => { it.stop(); it.spec = Object.assign({}, it.spec, { periodic: null }); it.text += ' · остановлен'; this.dirty = true; this.render(); } }, '■'), td.firstChild);
    });
    const kind = this.el.querySelectorAll('.pdu-table tr td:nth-child(2)');
    this.items.forEach((it, k) => { if (it.kind === 'cpdu' && kind[k]) kind[k].textContent = 'Сложный PDU'; });
  };

  UI.sendComplexPdu = sendPdu;
})(globalThis.NetLab = globalThis.NetLab || {});
