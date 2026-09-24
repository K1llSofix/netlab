/* NetLab UI — задания (Activity Wizard): мастер для автора (ответ, начальная схема, инструкции, пункты оценки,
 * проверки связи, таймер, пароль) и панель задания для ученика (инструкции, таймер, «Проверить», «Заново»). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const A = NS.activity;
  const DW = NS.dw;

  const st = { app: null, bar: null, timerEl: null, key: null, deadline: null, expired: false, hasInitial: false, unlocked: new Set(), draft: null, draftKey: null, cands: null, candFor: null, authoring: false };

  const mmss = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const taskKey = (t) => (t ? t.title + '|' + t.timer + '|' + t.secret.length + '|' + t.secret.slice(-40) : null);
  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });

  /* ================= текст инструкций ================= */

  /** Простая разметка: «# заголовок», «- пункт», «**жирный**», «`команда`», пустая строка — новый абзац. */
  function renderText(text) {
    const box = h('div', { class: 'task-text' });
    const inline = (s) => {
      const out = [];
      const re = /\*\*(.+?)\*\*|`(.+?)`/g;
      let last = 0;
      let m;
      while ((m = re.exec(s))) {
        if (m.index > last) out.push(s.slice(last, m.index));
        out.push(m[1] != null ? h('b', null, m[1]) : h('code', null, m[2]));
        last = re.lastIndex;
      }
      if (last < s.length) out.push(s.slice(last));
      return out;
    };
    let list = null;
    let para = [];
    const flush = () => { if (para.length) { box.append(h('p', null, inline(para.join(' ')))); para = []; } };
    for (const raw of String(text || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flush(); list = null; box.append(h('h' + (m[1].length + 3), null, inline(m[2]))); continue; }
      if ((m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line))) { flush(); if (!list) { list = h('ul'); box.append(list); } list.append(h('li', null, inline(m[1]))); continue; }
      if (!line.trim()) { flush(); list = null; continue; }
      list = null;
      para.push(line.trim());
    }
    flush();
    if (!box.childNodes.length) box.append(h('p', { class: 'muted' }, 'Инструкций нет.'));
    return box;
  }

  /* ================= панель задания ================= */

  function drawBar() {
    const app = st.app;
    const t = app.net.task;
    if (!st.bar) {
      st.bar = h('div', { class: 'task-bar' });
      document.getElementById('stageWrap').appendChild(st.bar);
    }
    UI.clear(st.bar);
    st.bar.hidden = !t;
    if (!t) return;
    st.timerEl = h('span', { class: 'task-timer' });
    st.bar.append(UI.icon('task'), h('b', { class: 'task-title', title: t.title }, t.title), st.timerEl,
      h('button', { class: 'btn small outline', onClick: () => showInstructions(app) }, 'Инструкции'),
      t.feedback !== 'none' ? h('button', { class: 'btn small primary', title: 'Сравнить схему с ответом и показать процент выполнения', onClick: () => showCheck(app) }, 'Проверить') : null,
      st.hasInitial ? h('button', { class: 'btn small outline', title: 'Вернуть начальную схему задания', onClick: () => restart(app) }, 'Заново') : null);
    tick();
  }

  function tick() {
    if (!st.timerEl) return;
    if (!st.deadline) { st.timerEl.textContent = ''; return; }
    const left = st.deadline - Date.now();
    if (left <= 0 && !st.expired) {
      st.expired = true;
      UI.toast('Время на задание вышло', 'warn', 5000);
      if (st.app.net.task && st.app.net.task.feedback !== 'none') showCheck(st.app);
    }
    st.timerEl.textContent = st.expired ? 'Время вышло' : '⏱ ' + mmss(left);
    st.timerEl.classList.toggle('over', st.expired);
    st.timerEl.classList.toggle('soon', !st.expired && left < 60000);
  }

  /** Схема сменилась (открыт файл, отмена, «Заново», мастер): обновить панель, таймер — только для другого задания. */
  function onNet() {
    const t = st.app.net.task;
    const key = taskKey(t);
    if (key !== st.key) {
      st.key = key;
      st.expired = false;
      st.deadline = t && t.timer ? Date.now() + t.timer * 60000 : null;
      const sec = t ? A.open(t) : null;
      st.hasInitial = !!(sec && sec.initial);
      UI.windows.close('task:instr');
      if (t && !st.authoring) setTimeout(() => showInstructions(st.app), 60);
    }
    drawBar();
  }

  function showInstructions(app) {
    const t = app.net.task;
    if (!t) return;
    UI.windows.open({
      id: 'task:instr', title: t.title, sub: 'Задание' + (t.timer ? ' · ' + t.timer + ' мин' : ''), width: 540, height: 520,
      tabs: [{
        id: 'text', label: 'Инструкции', keep: true,
        render(body) {
          body.append(renderText(t.instructions), h('div', { class: 'row', style: { marginTop: '14px' } },
            t.feedback !== 'none' ? h('button', { class: 'btn primary small', onClick: () => showCheck(app) }, 'Проверить результат') : null,
            h('span', { class: 'muted small' }, t.feedback === 'none' ? 'Результат проверит преподаватель.' : 'Проверка сравнивает вашу схему с ответом автора и показывает процент выполнения.')));
        },
      }],
    });
  }

  function restart(app) {
    const t = app.net.task;
    const sec = t && A.open(t);
    if (!sec || !sec.initial) return;
    UI.confirm('Начать задание заново', 'Схема вернётся в начальное состояние задания. Текущую работу можно будет вернуть кнопкой «Отменить».', 'Начать заново').then((ok) => {
      if (!ok) return;
      const net = NS.Network.deserialize(sec.initial);
      net.task = t;
      net.runUntilIdle(5000);
      st.key = null; // таймер — заново
      app.setNetwork(net, { undoable: true });
      app.markDirty();
    });
  }

  /* ================= результат проверки ================= */

  function resultList(r) {
    const box = h('div', { class: 'task-results' });
    const groups = new Map();
    for (const it of r.items) {
      const g = it.path.join(' › ');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    for (const [g, list] of groups) {
      const ok = list.filter((x) => x.ok).length;
      const d = h('details', { class: 'task-group' + (ok === list.length ? ' ok' : '') },
        h('summary', null, h('span', { class: ok === list.length ? 'st ok' : 'st fail' }, ok + '/' + list.length), ' ', g),
        list.map((x) => h('div', { class: 'task-item ' + (x.ok ? 'ok' : 'fail') }, h('span', { class: 'mark' }, x.ok ? '✓' : '✗'), h('span', { class: 'mono' }, x.label),
          x.points !== 1 ? h('span', { class: 'muted small' }, ' · ' + x.points + ' б.') : null)));
      if (ok < list.length) d.open = true;
      box.append(d);
    }
    if (r.tests.length) {
      box.append(h('div', { class: 'section-title', style: { marginTop: '10px' } }, 'Проверки связи'));
      for (const t of r.tests) {
        box.append(h('div', { class: 'task-item ' + (t.ok ? 'ok' : 'fail') }, h('span', { class: 'mark' }, t.ok ? '✓' : '✗'),
          h('span', null, t.from + ' → ' + t.to + ': ' + (t.expect !== false ? 'должна быть связь' : 'связи быть не должно') + ' — ' + (t.got == null ? (t.why || 'не проверено') : t.got ? 'ping проходит' : 'ping не проходит'))));
      }
    }
    if (!r.items.length && !r.tests.length) box.append(h('p', { class: 'muted' }, 'В задании нет пунктов оценки.'));
    return box;
  }

  function showCheck(app, author) {
    const t = app.net.task;
    if (!t) return;
    if (t.feedback === 'none' && !author) { UI.modal({ title: 'Проверка', body: 'Автор задания отключил показ результатов — работу проверит преподаватель.' }); return; }
    let r;
    try { r = A.check(app.net, t); } catch (e) { UI.toast(e.message, 'err', 6000); return; }
    const full = author || t.feedback === 'full';
    const body = h('div', null,
      h('div', { class: 'task-score' }, h('div', { class: 'big' }, String(r.percent).replace('.', ',') + '%'),
        h('div', null, h('div', null, 'Набрано баллов: ' + r.got + ' из ' + r.total), h('div', { class: 'task-meter' }, h('i', { style: { width: Math.min(100, r.percent) + '%' } })),
          st.expired && !author ? h('div', { class: 'muted small' }, 'Время на задание вышло') : null)),
      full ? h('div', { class: 'task-results-wrap' }, resultList(r)) : h('p', { class: 'muted' }, 'Автор задания разрешил показывать только общий процент.'));
    UI.modal({ title: 'Результат: ' + t.title, body, actions: [{ label: 'Закрыть', primary: true }] });
    return r;
  }

  /* ================= мастер заданий ================= */

  function draftOf(app) {
    const k = taskKey(app.net.task);
    if (!st.draft || st.draftKey !== k) { st.draft = A.draft(app.net.task); st.draftKey = k; st.cands = null; st.candFor = null; }
    return st.draft;
  }

  function commit(app) {
    app.net.task = A.build(st.draft);
    st.draftKey = taskKey(app.net.task);
    app.markDirty();
    app.autosave();
    onNet();
  }

  function candidates(d) {
    if (!d.answer) return [];
    if (st.candFor !== d.answer) {
      st.cands = A.candidates(NS.Network.deserialize(d.answer));
      st.candFor = d.answer;
    }
    return st.cands;
  }

  /** Новый ответ: пункты, которые остались, получают новые ожидаемые значения; если пунктов не было — выбрать всё. */
  function setAnswer(app, d) {
    const hadItems = d.items.length > 0;
    d.answer = A.snapshot(app.net);
    const cands = candidates(d);
    const byKey = new Map(cands.map((c) => [c.key, c]));
    if (hadItems) {
      d.items = d.items.filter((it) => byKey.has(it.key)).map((it) => { const c = byKey.get(it.key); return { key: c.key, path: c.path, label: c.label, value: c.value, points: it.points }; });
    } else {
      d.items = cands.map((c) => ({ key: c.key, path: c.path, label: c.label, value: c.value, points: 1 }));
    }
  }

  function openOnCanvas(app, data, what) {
    const t = app.net.task;
    const net = NS.Network.deserialize(data);
    net.task = t;
    net.runUntilIdle(5000);
    app.setNetwork(net, { undoable: true });
    app.markDirty();
    UI.toast('На холсте — ' + what + '. Вернуть прежнюю схему можно кнопкой «Отменить».', 'ok', 4000);
  }

  async function unlock(app) {
    const t = app.net.task;
    if (!t || !t.lock || st.unlocked.has(t.lock)) return true;
    const p = await UI.prompt('Мастер заданий', 'Задание защищено паролем. Введите пароль автора:');
    if (p == null) return false;
    if (A.passHash(p) !== t.lock) { UI.toast('Неверный пароль', 'err'); return false; }
    st.unlocked.add(t.lock);
    return true;
  }

  async function wizard(app) {
    if (!(await unlock(app))) return;
    st.authoring = true;
    const d = draftOf(app);
    const w = UI.windows.open({
      id: 'task:wizard', title: 'Мастер заданий', sub: app.net.task ? app.net.task.title : 'новое задание', width: 880, height: 640,
      onClose: () => { st.authoring = false; },
      tabs: [
        { id: 'answer', label: 'Ответ и начало', keep: true, render: (body) => answerTab(app, body) },
        { id: 'text', label: 'Инструкции', keep: true, render: (body) => textTab(app, body) },
        { id: 'items', label: 'Оценка', keep: true, render: (body) => itemsTab(app, body) },
        { id: 'tests', label: 'Проверка связи', keep: true, render: (body) => testsTab(app, body) },
        { id: 'opts', label: 'Параметры', keep: true, render: (body) => optsTab(app, body) },
      ],
    });
    void d;
    return w;
  }

  const rerender = () => { const w = UI.windows.get('task:wizard'); if (w) w.renderActive(); };

  function answerTab(app, body) {
    const d = draftOf(app);
    const info = (data) => (data ? 'устройств: ' + (data.devices || []).length + ', соединений: ' + (data.links || []).length : 'не задана');
    body.append(
      h('div', { class: 'hint-box' }, 'Как сделать задание: 1) соберите и настройте готовую сеть — это ответ; 2) «Запомнить текущую схему как ответ»; 3) уберите из схемы то, что должен сделать ученик, и «Запомнить как начальную»; 4) заполните инструкции, выберите пункты оценки; 5) сохраните файл, когда на холсте начальная схема.'),
      DW.section('Схема-ответ'),
      h('div', null, 'Ответ: ' + info(d.answer)),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary small', onClick: () => { setAnswer(app, d); commit(app); rerender(); UI.toast('Ответ запомнен: ' + d.items.length + ' пунктов оценки', 'ok'); } }, 'Запомнить текущую схему как ответ'),
        d.answer ? h('button', { class: 'btn outline small', onClick: () => openOnCanvas(app, d.answer, 'схема-ответ') }, 'Открыть ответ на холсте') : null),
      DW.section('Начальная схема (что получит ученик)'),
      h('div', null, 'Начальная схема: ' + info(d.initial)),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary small', onClick: () => { d.initial = A.snapshot(app.net); commit(app); rerender(); UI.toast('Начальная схема запомнена', 'ok'); } }, 'Запомнить текущую схему как начальную'),
        d.initial ? h('button', { class: 'btn outline small', onClick: () => openOnCanvas(app, d.initial, 'начальная схема') }, 'Открыть начальную на холсте') : null),
      h('div', { class: 'muted small', style: { marginTop: '4px' } }, 'Начальная схема нужна для кнопки «Заново» у ученика. В файл задания сохраняется та схема, что на холсте, — перед сохранением откройте начальную.'),
      DW.section('Проверка'),
      h('div', { class: 'row' },
        h('button', { class: 'btn outline small', disabled: !app.net.task, onClick: () => showCheck(app, true) }, 'Проверить схему на холсте'),
        h('span', { class: 'muted small' }, 'Покажет, сколько процентов набирает текущая схема (для ответа должно быть 100%).')));
  }

  function textTab(app, body) {
    const d = draftOf(app);
    const title = h('input', { class: 'inp', value: d.title, style: { width: '100%' } });
    const text = h('textarea', { class: 'inp mono', rows: 14, style: { width: '100%', resize: 'vertical' } });
    text.value = d.instructions;
    const prev = h('div', { class: 'task-preview' });
    const draw = () => { UI.clear(prev); prev.append(renderText(text.value)); };
    title.addEventListener('change', () => { d.title = title.value.trim() || 'Задание'; commit(app); });
    text.addEventListener('input', draw);
    text.addEventListener('change', () => { d.instructions = text.value; commit(app); });
    body.append(DW.form(lbl('Название'), title), DW.section('Инструкции для ученика'), text,
      h('div', { class: 'muted small' }, 'Разметка: «# Заголовок», «- пункт списка», **жирный**, `команда`. Пустая строка — новый абзац.'),
      DW.section('Как увидит ученик'), prev);
    draw();
  }

  function itemsTab(app, body) {
    const d = draftOf(app);
    if (!d.answer) { body.append(h('div', { class: 'hint-box warn' }, 'Сначала задайте ответ на вкладке «Ответ и начало».')); return; }
    const cands = candidates(d);
    const sel = new Map(d.items.map((it) => [it.key, it]));
    const sum = h('div', { class: 'muted' });
    const upd = () => { sum.textContent = 'Выбрано пунктов: ' + d.items.length + ' из ' + cands.length + ', баллов: ' + d.items.reduce((s, x) => s + (Number(x.points) || 0), 0); };
    const toggle = (c, on, pts) => {
      if (on) { if (!sel.has(c.key)) { const it = { key: c.key, path: c.path, label: c.label, value: c.value, points: pts == null ? 1 : pts }; sel.set(c.key, it); } }
      else sel.delete(c.key);
      d.items = cands.filter((x) => sel.has(x.key)).map((x) => sel.get(x.key));
    };
    const groups = new Map();
    for (const c of cands) { const g = c.path.join(' › '); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    const list = h('div', { class: 'task-tree' });
    for (const [g, cs] of groups) {
      const all = h('input', { type: 'checkbox', checked: cs.every((c) => sel.has(c.key)) });
      const rows = cs.map((c) => {
        const cb = h('input', { type: 'checkbox', checked: sel.has(c.key) });
        const pts = h('input', { class: 'inp', type: 'number', min: 0, max: 100, value: sel.has(c.key) ? sel.get(c.key).points : 1, style: { width: '58px' } });
        cb.addEventListener('change', () => { toggle(c, cb.checked, Number(pts.value)); all.checked = cs.every((x) => sel.has(x.key)); upd(); commit(app); });
        pts.addEventListener('change', () => { if (sel.has(c.key)) { sel.get(c.key).points = Math.max(0, Number(pts.value) || 0); commit(app); upd(); } });
        return h('div', { class: 'task-item' }, cb, h('span', { class: 'mono', style: { flex: 1 } }, c.label), pts, h('span', { class: 'muted small' }, 'б.'));
      });
      all.addEventListener('change', () => { for (const c of cs) toggle(c, all.checked); rows.forEach((r) => { r.querySelector('input[type=checkbox]').checked = all.checked; }); upd(); commit(app); });
      const det = h('details', { class: 'task-group' }, h('summary', null, all, ' ', g, h('span', { class: 'muted small' }, ' (' + cs.length + ')')), rows);
      list.append(det);
    }
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn outline small', onClick: () => { for (const c of cands) toggle(c, true); commit(app); rerender(); } }, 'Выбрать всё'),
      h('button', { class: 'btn outline small', onClick: () => { for (const c of cands) toggle(c, false); commit(app); rerender(); } }, 'Снять всё'), sum),
    h('div', { class: 'muted small', style: { margin: '6px 0' } }, 'Отмеченные пункты сравниваются со схемой ученика: строки конфигурации маршрутизаторов и коммутаторов, настройки компьютеров и серверов, соединения и состояние портов. Устройства сравниваются по имени.'),
    list);
    upd();
  }

  function testsTab(app, body) {
    const d = draftOf(app);
    const names = d.answer ? (d.answer.devices || []).map((x) => x.name) : [...app.net.devices.values()].map((x) => x.name);
    const e = err();
    const table = h('div');
    const draw = () => {
      UI.clear(table);
      table.append(h('table', { class: 'tbl' }, h('tr', null, ['Откуда', 'Куда (IP или имя)', 'Ожидается', 'Баллы', ''].map((x) => h('th', null, x))),
        d.tests.length ? d.tests.map((t, i) => {
          const from = DW.select(names.map((n) => [n, n]), t.from, (v) => { t.from = v; commit(app); });
          const to = h('input', { class: 'inp mono', value: t.to, style: { width: '150px' } });
          to.addEventListener('change', () => { t.to = to.value.trim(); commit(app); });
          const exp = DW.select([['1', 'связь есть'], ['0', 'связи нет']], t.expect !== false ? '1' : '0', (v) => { t.expect = v === '1'; commit(app); });
          const pts = h('input', { class: 'inp', type: 'number', min: 0, max: 100, value: t.points, style: { width: '58px' } });
          pts.addEventListener('change', () => { t.points = Math.max(0, Number(pts.value) || 0); commit(app); });
          return h('tr', null, h('td', null, from), h('td', null, to), h('td', null, exp), h('td', null, pts),
            h('td', null, h('button', { class: 'btn icon small danger', onClick: () => { d.tests.splice(i, 1); commit(app); draw(); } }, UI.icon('delete'))));
        }) : h('tr', { class: 'empty' }, h('td', { colspan: 5 }, 'Проверок нет'))));
    };
    body.append(h('div', { class: 'hint-box' }, 'Проверка связи — ping с устройства ученика (на копии его схемы, сама схема не меняется). Можно проверять и то, что связи быть не должно (например, ACL запрещает доступ).'),
      h('div', { class: 'row', style: { margin: '8px 0' } }, h('button', { class: 'btn primary small', onClick: () => {
        if (!names.length) { e.textContent = 'В схеме нет устройств'; return; }
        d.tests.push({ from: names[0], to: '', expect: true, points: 1 });
        draw();
      } }, '+ проверка'), e), table);
    draw();
  }

  function optsTab(app, body) {
    const d = draftOf(app);
    const timer = h('input', { class: 'inp', type: 'number', min: 0, max: 600, value: d.timer || 0, style: { width: '90px' } });
    timer.addEventListener('change', () => { d.timer = Math.max(0, Math.min(600, Math.round(Number(timer.value) || 0))); commit(app); });
    const fb = DW.select([['full', 'процент и все пункты (что верно, что нет)'], ['score', 'только процент'], ['none', 'ничего — проверит преподаватель']], d.feedback, (v) => { d.feedback = v; commit(app); });
    const pass = h('input', { class: 'inp', type: 'password', placeholder: 'новый пароль', style: { width: '160px' } });
    const e = err();
    body.append(DW.form(
      lbl('Таймер, минут'), h('div', { class: 'row' }, timer, h('span', { class: 'muted small' }, '0 — без ограничения времени')),
      lbl('Ученик видит'), fb,
      lbl('Пароль мастера'), h('div', { class: 'row' }, pass,
        h('button', { class: 'btn outline small', onClick: () => { if (!pass.value) { e.textContent = 'Введите пароль'; return; } d.lock = A.passHash(pass.value); st.unlocked.add(d.lock); commit(app); pass.value = ''; rerender(); UI.toast('Пароль установлен', 'ok'); } }, 'Установить'),
        d.lock ? h('button', { class: 'btn outline small', onClick: () => { d.lock = ''; commit(app); rerender(); } }, 'Снять') : null,
        h('span', { class: 'muted small' }, d.lock ? 'задан' : 'не задан')),
      h('span'), e),
    h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'Пароль не даёт ученику открыть мастер (и увидеть ответ) из программы. Ответ в файле хранится в закодированном виде.'),
    DW.section('Задание в этой схеме'),
    h('div', { class: 'row' },
      h('button', { class: 'btn outline small danger', disabled: !app.net.task, onClick: async () => {
        if (!(await UI.confirm('Удалить задание', 'Из схемы будут удалены инструкции, ответ и пункты оценки. Сама схема останется.', 'Удалить', true))) return;
        app.mutate(() => { app.net.task = null; });
        st.draft = null;
        onNet();
        UI.windows.close('task:wizard');
      } }, 'Удалить задание из схемы')));
  }

  /* ================= меню ================= */

  UI.taskMenu = function (app, e) {
    const r = e.currentTarget.getBoundingClientRect();
    const t = app.net.task;
    UI.menu(r.left, r.bottom + 4, [
      { label: (t ? 'Мастер заданий (изменить)…' : 'Мастер заданий (создать)…'), onClick: () => wizard(app) },
      t ? '-' : null,
      t ? { label: 'Инструкции', onClick: () => showInstructions(app) } : null,
      t && t.feedback !== 'none' ? { label: 'Проверить результат', onClick: () => showCheck(app) } : null,
      t && st.hasInitial ? { label: 'Начать заново', onClick: () => restart(app) } : null,
    ].filter(Boolean));
  };

  NS.taskSetup = function (app) {
    st.app = app;
    const base = app.setNetwork;
    app.setNetwork = function (net, opts) {
      const r = base.call(this, net, opts);
      onNet();
      return r;
    };
    setInterval(tick, 1000);
    onNet();
  };

  UI.task = { wizard, showCheck, showInstructions, renderText, state: st };
})(globalThis.NetLab = globalThis.NetLab || {});
