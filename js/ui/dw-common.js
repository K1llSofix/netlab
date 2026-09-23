/* NetLab UI — общие помощники окон устройств: поля, проверка, боковое меню в стиле Packet Tracer,
 * выполнение IOS-команд из графического интерфейса с журналом «Эквивалентные команды IOS». */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = (NS.dw = NS.dw || {});

  DW.ipText = (v) => (v == null ? '' : U.ipStr(v));

  DW.classfulMask = function (ip) { return U.ipStr(U.classfulMask(ip)); };

  DW.section = function (text, extra) { return h('div', { class: 'section-title' }, text, extra || null); };

  DW.stateDot = function (state) { return h('span', { class: 'state-dot ' + state }); };

  DW.peerText = function (net, dev, i) {
    const p = dev.ports[i];
    if (p && p.radio) {
      const n = p.wlinks ? p.wlinks.size : 0;
      return n ? 'Wi-Fi клиентов: ' + n : 'нет Wi-Fi клиентов';
    }
    const pr = net.peer(dev, i);
    if (!pr) return '—';
    return pr.dev.name + ' ' + UI.shortIf(pr.dev.ports[pr.port].name);
  };

  /** Безопасно выполнить изменение; ошибку показать в errEl (или тостом). */
  DW.apply = function (app, fn, errEl, okMsg) {
    try {
      app.mutate(fn);
      if (errEl) errEl.textContent = '';
      if (okMsg) UI.toast(okMsg === true ? 'Настройки применены' : okMsg, 'ok', 1400);
      return true;
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
      else UI.toast(e.message, 'err');
      return false;
    }
  };

  DW.ipInput = function (value, placeholder) {
    return h('input', { class: 'inp mono', value: value || '', placeholder: placeholder || '', spellcheck: 'false' });
  };

  /** Разобрать поле с IP. required=false: пустое → null. */
  DW.readIp = function (inp, required) {
    const t = inp.value.trim();
    inp.classList.remove('bad');
    if (!t) {
      if (required) { inp.classList.add('bad'); return { ok: false, err: 'Заполните поле' }; }
      return { ok: true, v: null };
    }
    const v = U.parseIp(t);
    if (v == null) { inp.classList.add('bad'); return { ok: false, err: '«' + t + '» — неверный IP-адрес (пример: 192.168.1.10)' }; }
    return { ok: true, v };
  };

  DW.readMask = function (inp) {
    const t = inp.value.trim();
    inp.classList.remove('bad');
    const v = U.parseMask(t);
    if (v == null) { inp.classList.add('bad'); return { ok: false, err: '«' + t + '» — неверная маска (пример: 255.255.255.0 или /24)' }; }
    return { ok: true, v };
  };

  DW.onEnter = function (inp, fn) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
  };

  /** Поле, которое применяется при потере фокуса или Enter. */
  DW.commitOnChange = function (inp, fn) {
    inp.addEventListener('change', fn);
    DW.onEnter(inp, () => inp.blur());
  };

  DW.form = function (...rows) { return h('div', { class: 'form' }, rows); };

  DW.radio = function (name, options, value, onChange) {
    return h('div', { class: 'radio-row' }, options.map(([v, label]) => {
      const r = h('input', { type: 'radio', name, checked: v === value });
      r.addEventListener('change', () => { if (r.checked) onChange(v); });
      return h('label', null, r, label);
    }));
  };

  DW.select = function (options, value, onChange, attrs) {
    const s = h('select', Object.assign({ class: 'inp' }, attrs || {}), options.map(([v, label]) => h('option', { value: v }, label)));
    s.value = String(value);
    if (onChange) s.addEventListener('change', () => onChange(s.value));
    return s;
  };

  /**
   * Боковое меню как в Packet Tracer: items = [{group:'GLOBAL'} | {id, label}].
   * render(id, box) рисует правую часть. Выбор запоминается в state.
   */
  DW.sidebarLayout = function (body, items, state, key, render, footer) {
    const first = items.find((x) => x.id);
    if (!state[key] || !items.some((x) => x.id === state[key])) state[key] = first && first.id;
    const nav = h('div', { class: 'cpt-nav' });
    const main = h('div', { class: 'cpt-main' });
    for (const it of items) {
      if (it.group) { nav.appendChild(h('div', { class: 'cpt-group' }, it.group)); continue; }
      const b = h('button', { class: 'cpt-item' + (it.id === state[key] ? ' on' : ''), title: it.title || '' }, it.label);
      b.addEventListener('click', () => { state[key] = it.id; for (const x of nav.querySelectorAll('.cpt-item')) x.classList.remove('on'); b.classList.add('on'); draw(); });
      nav.appendChild(b);
    }
    const draw = () => {
      UI.clear(main);
      try { render(state[key], main); } catch (e) { console.error(e); main.appendChild(h('div', { class: 'hint-box warn' }, 'Ошибка отображения: ' + e.message)); }
    };
    body.classList.add('flush');
    const wrap = h('div', { class: 'cpt-layout' }, nav, main);
    body.appendChild(wrap);
    if (footer) body.appendChild(footer);
    draw();
    return { draw, main };
  };

  /* ---------- IOS из графического интерфейса ---------- */

  /**
   * Выполнить команды глобальной конфигурации IOS (как это делает вкладка Config в Packet Tracer).
   * Команды попадают в журнал «Эквивалентные команды IOS». Возвращает {ok, errors[]}.
   */
  DW.ios = function (app, dev, cmds) {
    const s = NS.cli.createSession(dev);
    s.mode = 'exec';
    const errors = [];
    const log = app.iosLog(dev.id);
    const io = {
      out: (l) => { if (/^%/.test(l) && !NS.cliIos.isInfo(l)) errors.push(l.replace(/^%\s*/, '')); },
      write: () => {},
      clear: () => {},
      done: () => {},
      mutate: (fn) => fn(),
    };
    let ok = true;
    try {
      app.mutate(() => {
        NS.cli.exec(dev, s, 'configure terminal', io);
        log.push(dev.ios.hostname + '#configure terminal');
        for (const c of cmds) {
          const p = NS.cli.prompt(dev, s);
          NS.cli.exec(dev, s, c, io);
          log.push(p + c);
        }
        NS.cli.exec(dev, s, 'end', io);
        log.push(NS.cli.prompt(dev, s).replace(/#$/, '') + '(config)#end');
      });
    } catch (e) { errors.push(e.message); }
    if (errors.length) {
      ok = false;
      for (const e of errors) log.push('% ' + e);
    }
    while (log.length > 300) log.shift();
    app.emitIosLog(dev.id);
    return { ok, errors };
  };

  /** Выполнить и показать ошибку рядом с полем (или тостом). */
  DW.iosApply = function (app, dev, cmds, errEl) {
    const r = DW.ios(app, dev, cmds);
    if (errEl) errEl.textContent = r.ok ? '' : r.errors.join('; ');
    else if (!r.ok) UI.toast(r.errors.join('; '), 'err', 5000);
    return r.ok;
  };

  /** Панель «Эквивалентные команды IOS» внизу вкладки Config. */
  DW.iosLogPanel = function (app, dev) {
    const pre = h('pre', { class: 'ios-log' });
    const upd = () => {
      pre.textContent = app.iosLog(dev.id).slice(-60).join('\n');
      pre.scrollTop = pre.scrollHeight;
    };
    upd();
    app.onIosLog(dev.id, upd);
    return h('div', { class: 'ios-log-wrap' }, h('div', { class: 'ios-log-title' }, 'Эквивалентные команды IOS'), pre);
  };

  /** Правильное имя интерфейса для IOS-команды. */
  DW.ifCmd = function (name) { return 'interface ' + name; };
})(globalThis.NetLab = globalThis.NetLab || {});
