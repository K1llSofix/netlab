/* NetLab UI — нижняя панель: результаты «Проверок связи» и отправленных писем. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;

  class PduPanel {
    constructor(app, el) {
      this.app = app;
      this.el = el;
      this.items = [];
      this.seq = 1;
      this.dirty = true;
    }

    add(item) {
      item.id = this.seq++;
      this.items.unshift(item);
      if (this.items.length > 60) this.items.length = 60;
      this.dirty = true;
      this.render();
      return item;
    }

    update() { this.dirty = true; }

    clear() {
      this.items = [];
      this.dirty = true;
      this.render();
    }

    render() {
      if (!this.dirty) return;
      this.dirty = false;
      const el = this.el;
      UI.clear(el);
      if (!this.items.length) return;
      const st = { ok: ['Успешно', 'ok'], fail: ['Ошибка', 'fail'], partial: ['Частично', 'run'], run: ['Выполняется…', 'run'] };
      const icon = { ok: '✓ ', fail: '✕ ', partial: '⚠ ', run: '⏳ ' };
      el.appendChild(h('table', { class: 'pdu-table' },
        h('tr', null,
          h('th', { style: { width: '120px' } }, 'Результат'), h('th', null, 'Тип'), h('th', null, 'Отправитель'), h('th', null, 'Получатель'), h('th', null, 'Подробности'),
          h('th', { style: { width: '90px', textAlign: 'right' } }, h('button', { class: 'btn small', onClick: () => this.clear(), title: 'Очистить список' }, 'Очистить'))),
        this.items.map((it) => h('tr', null,
          h('td', null, h('span', { class: 'st ' + st[it.status][1] }, icon[it.status] + st[it.status][0])),
          h('td', null, it.kind === 'mail' ? 'Письмо' : 'Проверка связи'),
          h('td', null, it.srcName),
          h('td', null, it.dstName),
          h('td', { class: 'muted' }, it.text),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            it.redo ? h('button', { class: 'btn icon small', title: 'Повторить', onClick: () => it.redo() }, UI.icon('reset')) : null,
            it.open ? h('button', { class: 'btn icon small', title: 'Открыть', onClick: () => it.open() }, UI.icon('list')) : null,
            h('button', { class: 'btn icon small', title: 'Убрать', onClick: () => { this.items = this.items.filter((x) => x !== it); this.dirty = true; this.render(); } }, UI.icon('close')))))));
    }
  }

  UI.PduPanel = PduPanel;
})(globalThis.NetLab = globalThis.NetLab || {});
