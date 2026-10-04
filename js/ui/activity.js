/* NetLab UI — задания (Activity Wizard): мастер для автора (ответ, начальная схема, инструкции, пункты оценки,
 * проверки связи, таймер, пароль) и панель задания для ученика (инструкции, таймер, «Проверить», «Заново»). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const A = NS.activity;
  const DW = NS.dw;

  const st = { app: null, bar: null, timerEl: null, liveEl: null, key: null, deadline: null, expired: false, hasInitial: false, unlocked: new Set(), draft: null, draftKey: null, cands: null, candFor: null, authoring: false, liveTimer: null };

  const LOCK_TEXT = {
    add: 'добавлять устройства', remove: 'удалять устройства', cables: 'менять кабели', rename: 'переименовывать устройства',
    cli: 'вкладка CLI', config: 'вкладка «Настройка»', physical: 'вкладка «Физический вид» (модули и питание)', sim: 'режим «Симуляция»',
    diag: 'подсказки «Почему не работает?» и проверка сети',
  };
  const LOCK_TITLE = { add: 'Запретить добавлять устройства', remove: 'Запретить удалять устройства', cables: 'Запретить подключать и отключать кабели', rename: 'Запретить переименовывать устройства',
    cli: 'Скрыть вкладку CLI', config: 'Скрыть вкладку «Настройка»', physical: 'Скрыть вкладку «Физический вид»', sim: 'Запретить режим «Симуляция»',
    diag: 'Запретить подсказки «Почему не работает?» и проверку сети' };

  /** Действие запрещено заданием (пока открыт мастер, автор может всё). */
  function locked(what) {
    const t = st.app && st.app.net.task;
    return !!(t && !st.authoring && t.locks && t.locks.includes(what));
  }
  UI.taskLocked = (what) => locked(what);
  const denied = (what) => { UI.toast('В этом задании нельзя: ' + LOCK_TEXT[what], 'warn', 3500); };
  const vals = () => (st.app && st.app.net.task && st.app.net.task.values) || {};

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
    st.liveEl = t.live && t.feedback !== 'none' ? h('span', { class: 'task-live', title: 'Сколько пунктов оценки уже выполнено (без проверок связи)' }) : null;
    st.bar.append(...[UI.icon('task'), h('b', { class: 'task-title', title: t.title }, t.title), st.liveEl, st.timerEl,
      h('button', { class: 'btn small outline', onClick: () => showInstructions(app) }, 'Инструкции'),
      t.feedback !== 'none' ? h('button', { class: 'btn small primary', title: 'Сравнить схему с ответом и показать процент выполнения', onClick: () => showCheck(app) }, 'Проверить') : null,
      st.hasInitial ? h('button', { class: 'btn small outline', title: 'Вернуть начальную схему задания', onClick: () => restart(app) }, 'Заново') : null].filter(Boolean));
    tick();
    scheduleLive();
  }

  /** «Живой» счёт: пересчитывается после изменений схемы (без проверок связи — они долгие). */
  function scheduleLive() {
    if (!st.liveEl) return;
    clearTimeout(st.liveTimer);
    st.liveTimer = setTimeout(() => {
      const t = st.app.net.task;
      if (!st.liveEl || !t) return;
      try {
        const r = A.check(st.app.net, t, { tests: false });
        st.liveEl.textContent = 'Выполнено ' + String(r.percent).replace('.', ',') + '%';
        st.liveEl.classList.toggle('done', r.percent >= 100);
      } catch (e) { st.liveEl.textContent = ''; }
    }, 600);
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
      // у каждого ученика свои значения переменных задания
      if (t && !st.authoring && A.startAttempt(t)) { st.key = taskKey(t); st.app.markDirty(); st.app.autosave(); }
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
          const who = h('input', { class: 'inp', value: t.student || '', placeholder: 'фамилия и имя', style: { width: '220px' } });
          who.addEventListener('change', () => { const x = app.net.task; if (!x) return; x.student = who.value.trim().slice(0, 80) || undefined; app.markDirty(); app.autosave(); });
          body.append(h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', null, 'Ученик:'), who),
            renderText(A.subst(t.instructions, vals())), h('div', { class: 'row', style: { marginTop: '14px' } },
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
        list.map((x) => [h('div', { class: 'task-item ' + (x.ok ? 'ok' : 'fail') }, h('span', { class: 'mark' }, x.ok ? '✓' : '✗'), h('span', { class: 'mono' }, x.label),
          x.points !== 1 ? h('span', { class: 'muted small' }, ' · ' + x.points + ' б.') : null),
          !x.ok && x.hint ? h('div', { class: 'task-hint' }, '💡 ' + x.hint) : null]));
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
      full ? h('div', { class: 'task-results-wrap' }, resultList(r)) : h('p', { class: 'muted' }, 'Автор задания разрешил показывать только общий процент.'),
      r.faults && r.faults.length && (author || r.percent >= 100) ? h('div', null, h('div', { class: 'section-title' }, r.percent >= 100 ? 'Все неисправности исправлены. Вот что было сломано:' : 'Неисправности в сети'),
        h('ol', null, r.faults.map((f) => h('li', null, f.text, f.fix ? h('div', { class: 'muted small' }, 'Исправление: ' + f.fix) : null)))) : null);
    const csv = () => {
      const date = new Date().toLocaleString('ru-RU');
      const name = (t.title + (t.student ? ' — ' + t.student : '')).replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.csv';
      UI.download(name, A.resultCsv(t, r, { student: t.student || '', date }));
      return false;
    };
    UI.modal({ title: 'Результат: ' + t.title, body, actions: (full ? [{ label: 'Сохранить результат (CSV)', onClick: csv }] : []).concat([{ label: 'Закрыть', primary: true }]) });
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
    const hadItems = d.items.some((x) => !x.custom);
    d.answer = A.snapshot(app.net);
    const cands = candidates(d);
    const byKey = new Map(cands.map((c) => [c.key, c]));
    const custom = d.items.filter((x) => x.custom);
    if (hadItems) {
      d.items = d.items.filter((it) => !it.custom && byKey.has(it.key)).map((it) => {
        const c = byKey.get(it.key);
        const o = { key: c.key, path: c.path, label: c.label, value: c.value, points: it.points };
        if (it.hint) o.hint = it.hint;
        return o;
      });
    } else {
      d.items = cands.map((c) => ({ key: c.key, path: c.path, label: c.label, value: c.value, points: 1 }));
    }
    d.items = d.items.concat(custom);
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
      onClose: () => {
        st.authoring = false;
        // автору — пробные значения переменных; ученик при открытии файла всё равно получит свои (fresh)
        const t = app.net.task;
        const sec = t && A.open(t);
        if (sec && sec.vars.length) { t.fresh = true; A.ensureValues(t); }
        drawBar();
      },
      tabs: [
        { id: 'answer', label: 'Ответ и начало', keep: true, render: (body) => answerTab(app, body) },
        { id: 'text', label: 'Инструкции', keep: true, render: (body) => textTab(app, body) },
        { id: 'items', label: 'Оценка', keep: true, render: (body) => itemsTab(app, body) },
        { id: 'custom', label: 'Переменные и свои пункты', keep: true, render: (body) => customTab(app, body) },
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
    const sel = new Map(d.items.filter((it) => !it.custom).map((it) => [it.key, it]));
    const sum = h('div', { class: 'muted' });
    const upd = () => { sum.textContent = 'Выбрано пунктов: ' + d.items.length + ' из ' + cands.length + ', баллов: ' + d.items.reduce((s, x) => s + (Number(x.points) || 0), 0); };
    const toggle = (c, on, pts) => {
      if (on) { if (!sel.has(c.key)) { const it = { key: c.key, path: c.path, label: c.label, value: c.value, points: pts == null ? 1 : pts }; sel.set(c.key, it); } }
      else sel.delete(c.key);
      d.items = cands.filter((x) => sel.has(x.key)).map((x) => sel.get(x.key)).concat(d.items.filter((x) => x.custom));
    };
    const groups = new Map();
    for (const c of cands) { const g = c.path.join(' › '); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    const list = h('div', { class: 'task-tree' });
    for (const [g, cs] of groups) {
      const all = h('input', { type: 'checkbox', checked: cs.every((c) => sel.has(c.key)) });
      const rows = cs.map((c) => {
        const cb = h('input', { type: 'checkbox', checked: sel.has(c.key) });
        const pts = h('input', { class: 'inp', type: 'number', min: 0, max: 100, value: sel.has(c.key) ? sel.get(c.key).points : 1, style: { width: '58px' } });
        cb.addEventListener('change', () => { toggle(c, cb.checked, Number(pts.value)); all.checked = cs.every((x) => sel.has(x.key)); upd(); commit(app); hintBtn.disabled = !cb.checked; });
        pts.addEventListener('change', () => { if (sel.has(c.key)) { sel.get(c.key).points = Math.max(0, Number(pts.value) || 0); commit(app); upd(); } });
        const hasHint = () => sel.has(c.key) && !!sel.get(c.key).hint;
        const hintBtn = h('button', { class: 'btn icon small' + (hasHint() ? ' on' : ''), title: hasHint() ? 'Подсказка: ' + sel.get(c.key).hint : 'Подсказка, если пункт не выполнен', disabled: !sel.has(c.key), onClick: async () => {
          const it = sel.get(c.key);
          if (!it) return;
          const v = await UI.prompt('Подсказка', 'Что показать ученику, если пункт «' + c.label + '» не выполнен:', it.hint || '');
          if (v == null) return;
          if (v.trim()) it.hint = v.trim(); else delete it.hint;
          hintBtn.classList.toggle('on', !!it.hint);
          hintBtn.title = it.hint ? 'Подсказка: ' + it.hint : 'Подсказка, если пункт не выполнен';
          commit(app);
        } }, '💡');
        return h('div', { class: 'task-item' }, cb, h('span', { class: 'mono', style: { flex: 1 } }, c.label), hintBtn, pts, h('span', { class: 'muted small' }, 'б.'));
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

  /** Переменные задания ({{ИМЯ}} — своё значение у каждого ученика) и свои пункты оценки. */
  function customTab(app, body) {
    const d = draftOf(app);
    d.vars = d.vars || [];
    const ref = d.answer ? NS.Network.deserialize(d.answer) : app.net;
    const names = [...ref.devices.values()].map((x) => x.name);
    const ev = err();
    const ei = err();

    const vbox = h('div');
    const drawVars = () => {
      UI.clear(vbox);
      vbox.append(h('table', { class: 'tbl' }, h('tr', null, ['Переменная', 'Значения', 'Пример', ''].map((x) => h('th', null, x))),
        d.vars.length ? d.vars.map((v, i) => h('tr', null, h('td', { class: 'mono' }, '{{' + v.name + '}}'),
          h('td', null, v.kind === 'list' ? 'одно из: ' + v.list.join(', ') : 'число от ' + v.min + ' до ' + v.max),
          h('td', { class: 'mono' }, A.pickValues([v])[v.name]),
          h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => { d.vars.splice(i, 1); commit(app); drawVars(); } }, UI.icon('delete')))))
          : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Переменных нет'))));
    };
    const vName = h('input', { class: 'inp mono', placeholder: 'NET', style: { width: '90px' } });
    const vA = h('input', { class: 'inp', placeholder: 'от', style: { width: '80px' } });
    const vB = h('input', { class: 'inp', placeholder: 'до', style: { width: '80px' } });
    const vKind = DW.select([['range', 'число от … до'], ['list', 'одно из списка']], 'range', (k) => {
      vA.placeholder = k === 'list' ? 'значения через запятую' : 'от';
      vA.style.width = k === 'list' ? '240px' : '80px';
      vB.style.display = k === 'list' ? 'none' : '';
    });
    const addVar = () => {
      ev.textContent = '';
      const v = A.normVar({ name: vName.value, kind: vKind.value, min: vA.value, max: vB.value, list: vA.value });
      if (!v) { ev.textContent = 'Имя — латиница, цифры и «_»; значения — два числа или список через запятую'; return; }
      if (d.vars.some((x) => x.name === v.name)) { ev.textContent = 'Такая переменная уже есть'; return; }
      d.vars.push(v);
      commit(app);
      vName.value = vA.value = vB.value = '';
      drawVars();
    };

    // свои пункты оценки
    const ibox = h('div');
    const drawItems = () => {
      UI.clear(ibox);
      const list = d.items.filter((x) => x.custom);
      ibox.append(h('table', { class: 'tbl' }, h('tr', null, ['Где', 'Что проверяется', 'Баллы', ''].map((x) => h('th', null, x))),
        list.length ? list.map((it) => h('tr', null, h('td', null, it.path.join(' › ')), h('td', { class: 'mono' }, it.label + (it.hint ? '  💡' : '')), h('td', null, String(it.points)),
          h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => { d.items = d.items.filter((x) => x !== it); commit(app); drawItems(); } }, UI.icon('delete')))))
          : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Своих пунктов нет'))));
    };
    const form = h('div');
    const f = { kind: 'cfg', device: names[0] || '', section: '', line: '', field: 'ip', value: '', port: '', up: true, points: 1, hint: '' };
    const inp = (key, attrs) => { const i = h('input', Object.assign({ class: 'inp', value: f[key] }, attrs || {})); i.addEventListener('input', () => { f[key] = i.value; }); return i; };
    const drawForm = () => {
      UI.clear(form);
      const devSel = DW.select(names.map((n) => [n, n]), f.device, (v) => { f.device = v; f.port = ''; drawForm(); });
      let fields;
      if (f.kind === 'cfg') {
        fields = [lbl('Раздел'), inp('section', { class: 'inp mono', placeholder: 'например interface GigabitEthernet0/0 (пусто — глобальная команда)', style: { width: '100%' } }),
          lbl('Строка'), inp('line', { class: 'inp mono', placeholder: 'например ip address 192.168.{{NET}}.1 255.255.255.0', style: { width: '100%' } })];
      } else if (f.kind === 'host') {
        fields = [lbl('Поле'), DW.select(Object.entries(A.HOST_FIELDS), f.field, (v) => { f.field = v; }),
          lbl('Значение'), inp('value', { class: 'inp mono', placeholder: 'например 192.168.{{NET}}.10', style: { width: '260px' } })];
      } else {
        const dev = ref.findByName(f.device);
        const ports = dev ? dev.ports.map((p) => p.name) : [];
        if (!ports.includes(f.port)) f.port = ports[0] || '';
        fields = [lbl('Порт'), DW.select(ports.map((p) => [p, p]), f.port, (v) => { f.port = v; }),
          lbl('Состояние'), DW.select([['1', 'включён'], ['0', 'выключен (shutdown)']], f.up ? '1' : '0', (v) => { f.up = v === '1'; })];
      }
      form.append(DW.form(
        lbl('Вид'), DW.select([['cfg', 'строка конфигурации IOS'], ['host', 'адрес компьютера или сервера'], ['port', 'состояние порта']], f.kind, (v) => { f.kind = v; drawForm(); }),
        lbl('Устройство'), devSel, ...fields,
        lbl('Баллы'), inp('points', { type: 'number', min: 0, max: 100, style: { width: '80px' } }),
        lbl('Подсказка'), inp('hint', { placeholder: 'что показать, если не выполнено (необязательно)', style: { width: '100%' } }),
        h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: () => {
          ei.textContent = '';
          try {
            d.items.push(A.customItem(f, ref));
            commit(app);
            f.line = f.value = f.hint = '';
            drawForm();
            drawItems();
          } catch (x) { ei.textContent = x.message; }
        } }, 'Добавить пункт'), ei)));
    };

    body.append(
      h('div', { class: 'hint-box' }, 'Переменная получает своё значение у каждого ученика при первом открытии задания. Пишите {{ИМЯ}} в инструкциях, своих пунктах оценки и проверках связи: «Настройте на G0/0 адрес 192.168.{{NET}}.1/24».'),
      DW.section('Переменные'), vbox,
      h('div', { class: 'row', style: { marginTop: '6px' } }, vName, vKind, vA, vB, h('button', { class: 'btn primary small', onClick: addVar }, 'Добавить'), ev),
      DW.section('Свои пункты оценки'),
      h('div', { class: 'muted small', style: { marginBottom: '6px' } }, 'Нужны, когда пункт зависит от переменной или его нет в ответе. Строка конфигурации сравнивается с running-config ученика дословно (как в show running-config).'),
      form, ibox);
    drawVars();
    drawForm();
    drawItems();
  }

  function testsTab(app, body) {
    const d = draftOf(app);
    const names = d.answer ? (d.answer.devices || []).map((x) => x.name) : [...app.net.devices.values()].map((x) => x.name);
    const e = err();
    const table = h('div');
    const draw = () => {
      UI.clear(table);
      table.append(h('table', { class: 'tbl' }, h('tr', null, ['Откуда', 'Куда (IP, имя или {{ПЕРЕМЕННАЯ}})', 'Ожидается', 'Баллы', ''].map((x) => h('th', null, x))),
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
    const live = UI.toggle('показывать процент на панели задания сразу', !!d.live, (on) => { d.live = on; commit(app); });
    d.locks = d.locks || {};
    const locks = h('div', { class: 'task-locks' }, A.LOCKS.map((k) => {
      const cb = h('input', { type: 'checkbox', checked: !!d.locks[k] });
      cb.addEventListener('change', () => { d.locks[k] = cb.checked; commit(app); });
      return h('label', null, cb, ' ' + LOCK_TITLE[k]);
    }));
    const pass = h('input', { class: 'inp', type: 'password', placeholder: 'новый пароль', style: { width: '160px' } });
    const e = err();
    body.append(DW.form(
      lbl('Таймер, минут'), h('div', { class: 'row' }, timer, h('span', { class: 'muted small' }, '0 — без ограничения времени')),
      lbl('Ученик видит'), fb,
      lbl('Живой счёт'), live,
      lbl('Ограничения'), h('div', null, locks, h('div', { class: 'muted small' }, 'Действуют у ученика; пока открыт мастер, автор может всё.')),
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
      t && faultsOf(t).length ? { label: 'Сдаться: показать неисправности', onClick: () => UI.confirm('Показать неисправности?', 'Вы увидите, что было сломано в сети, — искать станет неинтересно.', 'Показать').then((ok) => { if (ok) UI.showFaults(app, faultsOf(t)); }) } : null,
      '-',
      { label: 'Сводка результатов класса (CSV учеников)…', onClick: () => classSummary() },
    ].filter(Boolean));
  };

  /* ================= сводка по классу ================= */

  function pickFiles(accept) {
    return new Promise((resolve) => {
      const inp = h('input', { type: 'file', accept, multiple: true, style: { display: 'none' } });
      inp.addEventListener('change', async () => {
        const files = [...(inp.files || [])];
        inp.remove();
        resolve(await Promise.all(files.map((f) => f.text().then((text) => ({ name: f.name, text })))));
      });
      document.body.appendChild(inp);
      inp.click();
    });
  }

  async function classSummary() {
    const files = await pickFiles('.csv,text/csv');
    if (!files.length) return;
    const ok = [];
    const bad = [];
    for (const f of files) { try { ok.push(A.parseResultCsv(f.text)); } catch (e) { bad.push(f.name); } }
    if (!ok.length) { UI.toast('Среди файлов нет результатов NetLab (их сохраняет кнопка «Сохранить результат (CSV)» в окне проверки)', 'err', 6000); return; }
    UI.showClassSummary(A.classSummary(ok), bad);
  }

  UI.showClassSummary = function (sum, bad) {
    const cell = (v) => h('td', { class: 'cls-mark ' + (v === undefined ? '' : v ? 'ok' : 'no') }, v === undefined ? '' : v ? '✓' : '✗');
    const table = h('table', { class: 'tbl cls-tbl' },
      h('tr', null, h('th', null, 'Ученик'), h('th', null, '%'), h('th', null, 'Баллы'), sum.keys.map((k, i) => h('th', { title: k.key, class: 'cls-col' }, String(i + 1)))),
      sum.rows.map((r) => h('tr', null, h('td', null, r.student), h('td', null, h('b', { class: r.percent >= 100 ? 'ok' : r.percent < 50 ? 'no' : '' }, String(r.percent).replace('.', ','))), h('td', { class: 'muted' }, r.got + '/' + r.total),
        sum.keys.map((k) => cell(r.marks.has(k.key) ? r.marks.get(k.key) : undefined)))),
      h('tr', { class: 'cls-total' }, h('td', null, 'Решили'), h('td', null, h('b', null, String(sum.avg).replace('.', ','))), h('td'), sum.solved.map((p) => h('td', { class: p < 50 ? 'no' : '' }, p + '%'))));
    const legend = h('ol', { class: 'cls-legend small' }, sum.keys.map((k) => h('li', null, k.key)));
    const body = h('div', null,
      h('p', null, 'Задание: ' + sum.tasks.join(', ') + ' · учеников: ' + sum.rows.length + ' · средний результат: ' + String(sum.avg).replace('.', ',') + '%'),
      sum.tasks.length > 1 ? h('div', { class: 'hint-box warn' }, 'В файлах разные задания — сравнение по пунктам может быть неточным.') : null,
      bad && bad.length ? h('div', { class: 'hint-box warn' }, 'Пропущены файлы (не результаты NetLab): ' + bad.join(', ')) : null,
      h('div', { class: 'cls-wrap' }, table),
      h('div', { class: 'section-title' }, 'Пункты проверки'), legend);
    UI.windows.open({
      id: 'task:class', title: 'Сводка результатов класса', sub: sum.rows.length + ' учеников', width: 760, height: 560,
      tabs: [{ id: 'main', label: 'Ведомость', keep: true, render(b) { b.append(body, h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary small', onClick: () => UI.download('Сводка — ' + sum.tasks[0] + '.csv', A.summaryCsv(sum), 'text/csv') }, 'Сохранить сводку (CSV)'))); } }],
    });
  };

  function faultsOf(t) { const s = A.open(t); return s ? s.faults : []; }

  /** Вкладки, скрытые заданием. */
  UI.tabHidden = function (dev, tab) {
    if (tab === 'cli') return locked('cli');
    if (tab === 'config') return locked('config');
    if (tab === 'physical') return locked('physical');
    return false;
  };

  NS.taskSetup = function (app) {
    st.app = app;
    const base = app.setNetwork;
    app.setNetwork = function (net, opts) {
      const r = base.call(this, net, opts);
      onNet();
      return r;
    };
    // ограничения задания
    const guard = (name, what, when) => {
      const orig = app[name];
      app[name] = function (...args) {
        if ((!when || when.apply(this, args)) && locked(what)) { denied(what); return null; }
        return orig.apply(this, args);
      };
    };
    guard('placeDevice', 'add');
    guard('duplicate', 'add');
    guard('deleteIds', 'remove', function (ids) { return ids.some((id) => this.net.getDevice(id)); });
    guard('connect', 'cables');
    guard('deleteLink', 'cables');
    guard('renameDevice', 'rename');
    guard('setMode', 'sim', (m) => m === 'sim');
    const ren = NS.Network.prototype.renameDevice;
    NS.Network.prototype.renameDevice = function (...args) {
      if (st.app && st.app.net === this && locked('rename')) throw new Error('В этом задании нельзя переименовывать устройства');
      return ren.apply(this, args);
    };
    // живой счёт — после изменений схемы
    const baseEv = app.onNetEvent;
    app.onNetEvent = function (type, data) {
      baseEv.call(this, type, data);
      if (type === 'config' || type === 'topology' || type === 'remote-change') scheduleLive();
    };
    const baseMut = app.mutate;
    app.mutate = function (fn) { const r = baseMut.call(this, fn); scheduleLive(); return r; };
    setInterval(tick, 1000);
    onNet();
  };

  UI.task = { wizard, showCheck, showInstructions, renderText, state: st };
})(globalThis.NetLab = globalThis.NetLab || {});
