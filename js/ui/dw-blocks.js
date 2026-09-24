/* NetLab UI — визуальное программирование плат: блоки «При запуске» и «Повторять»,
 * условия и циклы с вложенными блоками. Из блоков собирается программа JavaScript (NetLab.scriptRt.blocksToJs). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const DW = NS.dw;

  const PINS = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'A0', 'A1', 'A2', 'A3'];
  const TYPES = [
    ['pinMode', 'Режим пина', () => ({ pin: 'D0', mode: 'OUTPUT' })],
    ['digitalWrite', 'Включить / выключить', () => ({ pin: 'D0', value: 'HIGH' })],
    ['toggle', 'Переключить пин', () => ({ pin: 'D0' })],
    ['analogWrite', 'Аналоговый выход', () => ({ pin: 'D2', value: 512 })],
    ['copy', 'Передать аналоговое значение', () => ({ pin: 'A0', to: 'D2' })],
    ['delay', 'Пауза', () => ({ ms: 500 })],
    ['set', 'Переменная', () => ({ name: 'n', src: 'num', value: 0 })],
    ['if', 'Если … то / иначе', () => ({ src: 'digital', pin: 'D1', op: '==', value: 'HIGH', then: [], else: [] })],
    ['repeat', 'Повторить N раз', () => ({ n: 3, body: [] })],
    ['print', 'Вывести текст', () => ({ text: 'Привет' })],
    ['printRead', 'Вывести значение пина', () => ({ pin: 'A0', mode: 'analog' })],
  ];
  const TITLE = Object.fromEntries(TYPES.map(([t, l]) => [t, l]));

  const sel = (opts, v, on, w) => DW.select(opts.map((x) => (Array.isArray(x) ? x : [x, x])), String(v), on, { style: { width: (w || 90) + 'px' } });
  const num = (v, on, w) => {
    const i = h('input', { class: 'inp', type: 'number', value: v, style: { width: (w || 80) + 'px' } });
    i.addEventListener('change', () => on(Number(i.value)));
    return i;
  };
  const txt = (v, on, w) => {
    const i = h('input', { class: 'inp', value: v, style: { width: (w || 140) + 'px' }, spellcheck: 'false' });
    i.addEventListener('change', () => on(i.value));
    return i;
  };

  /**
   * Редактор блоков. prog: { setup: [], loop: [] } (изменяется на месте). onChange() — после любого изменения.
   * Возвращает элемент.
   */
  DW.blocksEditor = function (prog, onChange) {
    const root = h('div', { class: 'blocks' });
    const redraw = () => { UI.clear(root); root.append(section('При запуске (setup)', prog.setup), section('Повторять бесконечно (loop)', prog.loop)); };
    const changed = (again) => { onChange(); if (again) redraw(); };

    function section(title, list) {
      return h('div', { class: 'blk-sec' }, h('div', { class: 'blk-title' }, title), listEl(list));
    }

    function listEl(list) {
      const box = h('div', { class: 'blk-list' });
      list.forEach((b, i) => box.appendChild(blockEl(list, b, i)));
      const add = DW.select([['', '+ блок…']].concat(TYPES.map(([t, l]) => [t, l])), '', (v) => {
        const t = TYPES.find((x) => x[0] === v);
        if (!t) return;
        list.push(Object.assign({ t: t[0] }, t[2]()));
        changed(true);
      }, { style: { width: '170px' }, class: 'inp blk-add' });
      box.appendChild(add);
      return box;
    }

    function blockEl(list, b, i) {
      const set = (k, again) => (v) => { b[k] = v; changed(again); };
      const f = [];
      switch (b.t) {
        case 'pinMode': f.push(sel(PINS, b.pin, set('pin')), sel([['OUTPUT', 'выход'], ['INPUT', 'вход']], b.mode, set('mode'))); break;
        case 'digitalWrite': f.push(sel(PINS, b.pin, set('pin')), sel([['HIGH', 'HIGH (вкл)'], ['LOW', 'LOW (выкл)']], b.value, set('value'), 120)); break;
        case 'toggle': f.push(sel(PINS, b.pin, set('pin'))); break;
        case 'analogWrite': f.push(sel(PINS, b.pin, set('pin')), h('span', null, '='), num(b.value, set('value'))); break;
        case 'copy': f.push(h('span', null, 'из'), sel(PINS, b.pin, set('pin')), h('span', null, 'в'), sel(PINS, b.to, set('to'))); break;
        case 'delay': f.push(num(b.ms, set('ms')), h('span', null, 'мс')); break;
        case 'print': f.push(txt(b.text, set('text'), 200)); break;
        case 'printRead': f.push(sel(PINS, b.pin, set('pin')), sel([['analog', 'аналоговое'], ['digital', 'цифровое']], b.mode, set('mode'), 120)); break;
        case 'set':
          f.push(txt(b.name, set('name'), 70), h('span', null, '='), sel([['num', 'число'], ['add', 'прибавить'], ['analog', 'analogRead'], ['digital', 'digitalRead']], b.src, set('src', true), 120));
          if (b.src === 'analog' || b.src === 'digital') f.push(sel(PINS, b.pin || 'A0', set('pin')));
          else f.push(num(b.value, set('value')));
          break;
        case 'if':
          f.push(sel([['digital', 'digitalRead'], ['analog', 'analogRead'], ['var', 'переменная']], b.src, set('src', true), 120));
          if (b.src === 'var') f.push(txt(b.name || 'n', set('name'), 70)); else f.push(sel(PINS, b.pin, set('pin')));
          f.push(sel(['==', '!=', '>', '<', '>=', '<='], b.op, set('op'), 60));
          if (b.src === 'digital') f.push(sel(['HIGH', 'LOW'], b.value, set('value'), 80)); else f.push(num(b.value, set('value')));
          break;
        case 'repeat': f.push(num(b.n, set('n'), 70), h('span', null, 'раз')); break;
        default: break;
      }
      const tools = h('span', { class: 'blk-tools' },
        h('button', { class: 'btn icon small', title: 'Выше', disabled: i === 0, onClick: () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); changed(true); } }, '↑'),
        h('button', { class: 'btn icon small', title: 'Ниже', disabled: i === list.length - 1, onClick: () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); changed(true); } }, '↓'),
        h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => { list.splice(i, 1); changed(true); } }, '✕'));
      const row = h('div', { class: 'blk blk-' + b.t }, h('div', { class: 'blk-row' }, h('b', null, TITLE[b.t] || b.t), ...f, tools));
      if (b.t === 'if') {
        if (!b.then) b.then = [];
        if (!b.else) b.else = [];
        row.append(h('div', { class: 'blk-inner' }, h('div', { class: 'blk-sub' }, 'то:'), listEl(b.then), h('div', { class: 'blk-sub' }, 'иначе:'), listEl(b.else)));
      } else if (b.t === 'repeat') {
        if (!b.body) b.body = [];
        row.append(h('div', { class: 'blk-inner' }, listEl(b.body)));
      }
      return row;
    }

    redraw();
    return root;
  };

  /** Программа из блоков по умолчанию — мигание светодиодом. */
  DW.defaultBlocks = () => ({
    setup: [{ t: 'pinMode', pin: 'D0', mode: 'OUTPUT' }],
    loop: [{ t: 'digitalWrite', pin: 'D0', value: 'HIGH' }, { t: 'delay', ms: 500 }, { t: 'digitalWrite', pin: 'D0', value: 'LOW' }, { t: 'delay', ms: 500 }],
  });
})(globalThis.NetLab = globalThis.NetLab || {});
