/* NetLab UI — диагностика: окно «Почему не работает?» (путь пакета, место потери, исправление, подсветка пути на схеме),
 * «Проверка сети» (аудит всей схемы) и «Поиск неисправностей» (сломать рабочую сеть и искать поломки как задание). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const D = NS.diag;

  const A = () => NS.activity;
  const SEV = { err: ['✖', 'Ошибка'], warn: ['⚠', 'Предупреждение'], info: ['ℹ', 'Замечание'] };

  const blocked = () => {
    if (UI.taskLocked && UI.taskLocked('diag')) { UI.toast('В этом задании подсказки отключены', 'warn', 3500); return true; }
    return false;
  };

  function selectDev(app, id) {
    if (!id || !app.net.getDevice(id)) return;
    app.ws.selection.clear();
    app.ws.selection.add(id);
    app.ws.updateSelection();
  }

  /** Текст замечания; имя устройства — ссылка, выделяющая его на схеме. */
  function devText(app, x) {
    if (!x.id || !x.dev) return [x.text];
    const a = h('a', { class: 'diag-dev', href: '#', title: 'Выделить на схеме', onClick: (e) => { e.preventDefault(); selectDev(app, x.id); } }, x.dev);
    return x.text.startsWith(x.dev) ? [a, x.text.slice(x.dev.length)] : [a, ' — ', x.text];
  }

  function issueList(app, list) {
    return h('div', { class: 'diag-list' }, list.map((x) => h('div', { class: 'diag-issue ' + x.sev },
      h('span', { class: 'diag-sev', title: SEV[x.sev][1] }, SEV[x.sev][0]),
      h('div', { class: 'grow' },
        h('div', null, ...devText(app, x)),
        x.fix ? h('div', { class: 'diag-fix' }, h('b', null, 'Как исправить: '), x.fix) : null))));
  }

  const pingable = (d) => typeof d.ping === 'function' && d.power !== undefined && !['switch', 'hub', 'repeater', 'bridge', 'ap', 'cloud', 'modem'].includes(d.type) && (d.ifaces || []).length > 0;

  /* ================= «Почему не работает?» ================= */

  UI.whyDialog = function (app, srcId, target) {
    if (blocked()) return;
    const st = { src: srcId || null, target: target || '' };
    UI.windows.open({
      id: 'diag:why', title: 'Почему не работает?', sub: 'ping и разбор пути', width: 640, height: 560,
      tabs: [{
        id: 'main', label: 'Проверка', keep: true,
        render(body) {
          const devs = [...app.net.devices.values()].filter(pingable).sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
          if (!st.src || !app.net.getDevice(st.src)) st.src = devs.length ? devs[0].id : null;
          const sel = h('select', { class: 'inp', style: { width: 'auto', minWidth: '160px' } }, devs.map((d) => h('option', { value: d.id }, d.name)));
          sel.value = st.src || '';
          sel.addEventListener('change', () => { st.src = sel.value; });
          const dl = h('datalist', { id: 'diag-targets' }, [...app.net.devices.values()].flatMap((d) => {
            const o = [h('option', { value: d.name })];
            for (const f of d.ifaces || []) if (f.ip != null && !f.runtime) o.push(h('option', { value: NS.util.ipStr(f.ip) }, d.name + ' ' + f.name));
            return o;
          }));
          const inp = h('input', { class: 'inp mono', value: st.target, list: 'diag-targets', placeholder: 'IP-адрес или имя устройства', spellcheck: 'false', style: { width: '220px' } });
          const out = h('div', { class: 'diag-out' });
          const run = () => {
            st.target = inp.value.trim();
            UI.clear(out);
            if (!st.src) { out.append(h('p', { class: 'muted' }, 'В схеме нет устройств, с которых можно отправить ping.')); return; }
            out.append(h('p', { class: 'muted' }, 'Проверяю…'));
            setTimeout(() => {
              let r;
              try { r = D.explain(app.net, st.src, st.target); } catch (e) { UI.clear(out); out.append(h('div', { class: 'hint-box warn' }, 'Ошибка проверки: ' + e.message)); console.error(e); return; }
              st.last = r;
              UI.clear(out);
              out.append(result(app, r));
              if (r.links.length) app.ws.highlightPath(r.links);
              const bad = r.issues.find((x) => x.sev === 'err' && x.id);
              if (bad) selectDev(app, bad.id);
            }, 20);
          };
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
          body.append(
            h('div', { class: 'row' }, h('span', null, 'Откуда'), sel, h('span', null, 'куда'), inp, dl, h('button', { class: 'btn primary small', onClick: run }, 'Проверить')),
            h('p', { class: 'muted small' }, 'NetLab отправит ping в копии сети (ваша схема не меняется), проследит путь пакета туда и обратно и объяснит, где и почему он теряется.'),
            out);
          if (st.last) out.append(result(app, st.last));
          else if (st.target) run();
          setTimeout(() => inp.focus(), 0);
        },
      }],
    });
  };

  function result(app, r) {
    const box = h('div');
    const head = r.ok
      ? h('div', { class: 'diag-head ok' }, '✔ Связь есть: ' + r.src + ' → ' + r.target + (r.ip && r.ip !== r.target ? ' (' + r.ip + ')' : '') + ' — ответов ' + r.received + ' из ' + r.sent)
      : h('div', { class: 'diag-head err' }, '✖ Связи нет: ' + r.src + ' → ' + r.target + (r.ip && r.ip !== r.target ? ' (' + r.ip + ')' : ''));
    box.append(head);
    if (r.path.length > 1) box.append(h('div', { class: 'diag-path' }, h('b', null, 'Запрос: '), r.path.join(' → ')));
    if (r.back.length > 1) box.append(h('div', { class: 'diag-path' }, h('b', null, 'Ответ: '), r.back.join(' → ')));
    if (r.issues.length) box.append(h('div', { class: 'section-title' }, r.ok ? 'Замечания' : 'Причина'), issueList(app, r.issues));
    if (r.links.length) box.append(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn outline small', onClick: () => app.ws.highlightPath(r.links) }, 'Показать путь на схеме')));
    if (r.steps.length) {
      const det = h('details', { class: 'diag-steps' }, h('summary', null, 'Подробно: как шёл пакет (' + r.steps.length + ' шагов)'),
        h('div', null, r.steps.map((s) => h('div', { class: 'mono small' }, h('b', null, s.dev), ' ', s.text))));
      box.append(det);
    }
    return box;
  }

  /* ================= проверка всей сети ================= */

  UI.auditDialog = function (app) {
    if (blocked()) return;
    UI.windows.open({
      id: 'diag:audit', title: 'Проверка сети', sub: 'типичные ошибки настройки', width: 640, height: 520,
      tabs: [{
        id: 'main', label: 'Проверка', keep: true,
        render(body) {
          const out = h('div');
          const run = () => {
            UI.clear(out);
            let list;
            try { list = D.audit(app.net); } catch (e) { out.append(h('div', { class: 'hint-box warn' }, 'Ошибка проверки: ' + e.message)); console.error(e); return; }
            const n = (s) => list.filter((x) => x.sev === s).length;
            out.append(list.length
              ? h('div', { class: 'diag-head ' + (n('err') ? 'err' : 'warn') }, 'Найдено: ошибок — ' + n('err') + ', предупреждений — ' + n('warn') + (n('info') ? ', замечаний — ' + n('info') : ''))
              : h('div', { class: 'diag-head ok' }, '✔ Типичных ошибок не найдено'), issueList(app, list));
          };
          body.append(h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: run }, 'Проверить ещё раз'),
            h('span', { class: 'muted small' }, 'Адреса и шлюзы, повторы IP, кабели, выключенные интерфейсы, VLAN и транки, маршруты между сетями.')), out);
          run();
        },
      }],
    });
  };

  /* ================= поиск неисправностей ================= */

  UI.troubleDialog = function (app) {
    if (app.net.task && !(A() && A().open(app.net.task) && A().open(app.net.task).faults.length)) {
      UI.modal({ title: 'Поиск неисправностей', body: 'В схеме уже есть задание. Удалите его в мастере заданий или откройте другую схему.' });
      return;
    }
    const count = h('select', { class: 'inp', style: { width: 'auto' } }, [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: n }, String(n))));
    count.value = '3';
    const kinds = Object.entries(D.FAULT_KINDS).map(([k, label]) => {
      const c = h('input', { type: 'checkbox', checked: true });
      return { k, c, el: h('label', { class: 'row' }, c, label) };
    });
    const timer = h('input', { class: 'inp', type: 'number', min: 0, max: 600, value: 0, style: { width: '80px' } });
    const hints = h('input', { type: 'checkbox' });
    const err = h('div', { class: 'err small' });
    const body = h('div', null,
      h('p', null, 'NetLab внесёт в работающую сеть случайные неисправности и превратит схему в задание: найдите и исправьте поломки, чтобы компьютеры снова пинговали друг друга. Проверка — кнопкой «Задание → Проверить результат».'),
      h('div', { class: 'form' }, h('label', null, 'Сколько неисправностей'), count, h('label', null, 'Таймер, минут (0 — без таймера)'), timer),
      h('div', { class: 'section-title' }, 'Какие неисправности'), ...kinds.map((x) => x.el),
      h('label', { class: 'row', style: { marginTop: '8px' } }, hints, 'Разрешить подсказки «Почему не работает?» и проверку сети'),
      err);
    UI.modal({
      title: 'Поиск неисправностей',
      body,
      actions: [{ label: 'Отмена' }, {
        label: 'Сломать сеть', primary: true, onClick: () => {
          const sel = kinds.filter((x) => x.c.checked).map((x) => x.k);
          if (!sel.length) { err.textContent = 'Выберите хотя бы один вид неисправностей'; return false; }
          let res;
          try { res = D.breakNetwork(app.net, { count: Number(count.value), kinds: sel }); } catch (e) { err.textContent = e.message; return false; }
          const n = res.faults.length;
          const words = n === 1 ? 'неисправность' : n < 5 ? 'неисправности' : 'неисправностей';
          res.net.task = A().build({
            title: 'Поиск неисправностей',
            instructions: 'В сети ' + n + ' ' + words + '. Найдите и исправьте их так, чтобы между компьютерами снова была связь.\n\n' +
              'Проверяются пары компьютеров (ping): ' + res.tests.length + '.\n\nПодсказки: ipconfig и ping на компьютерах, show ip interface brief, show ip route, show vlan brief, show interfaces trunk, show access-lists на сетевых устройствах. Режим «Симуляция» показывает, где теряется пакет.',
            timer: Number(timer.value) || 0,
            feedback: 'full',
            live: false, // проверка — только пингами, живой счёт по пунктам тут всегда 0
            locks: Object.assign({ add: true, remove: true, rename: true }, hints.checked ? {} : { diag: true }),
            tests: res.tests,
            items: [],
            faults: res.faults,
          });
          app.setNetwork(res.net, { undoable: true });
          app.markDirty();
          app.autosave();
          UI.toast('В сеть внесено: ' + n + ' ' + words + '. Удачи!', 'ok', 4000);
          return true;
        },
      }],
    });
  };

  /** Показать список неисправностей (ответ) задания «Поиск неисправностей». */
  UI.showFaults = function (app, list) {
    UI.modal({
      title: 'Неисправности в сети',
      body: h('div', { class: 'diag-list' }, list.map((f, i) => h('div', { class: 'diag-issue err' }, h('span', { class: 'diag-sev' }, String(i + 1)),
        h('div', { class: 'grow' }, h('div', null, f.text), f.fix ? h('div', { class: 'diag-fix' }, h('b', null, 'Исправление: '), f.fix) : null)))),
    });
  };

  /* ================= сравнение схем ================= */

  async function pickNet() {
    const D2 = window.netlabDesktop;
    let f = null;
    try { f = D2 && D2.openFile ? await D2.openFile() : await UI.pickFile('.netlab,.json,application/json'); } catch (e) { UI.toast('Не удалось открыть файл: ' + e.message, 'err'); return null; }
    if (!f) return null;
    try { return { net: NS.Network.deserialize(JSON.parse(f.text)), name: f.name }; } catch (e) { UI.toast('Это не схема NetLab: ' + e.message, 'err'); return null; }
  }

  UI.compareDialog = async function (app) {
    const p = await pickNet();
    if (p) UI.showCompare(app, p.net, p.name);
  };

  /** Окно отличий текущей схемы от эталона ref. */
  UI.showCompare = function (app, ref, refName) {
    const p = { net: ref, name: refName || 'эталон' };
    const r = NS.diffnet.compare(p.net, app.net);
    const sec = (title, list, cls) => (list.length ? h('div', null, h('div', { class: 'section-title' }, title + ' (' + list.length + ')'), h('ul', { class: 'diff-list ' + cls }, list.map((x) => h('li', null, x)))) : null);
    UI.windows.open({
      id: 'diag:diff', title: 'Сравнение схем', sub: 'эталон «' + p.name + '» → текущая', width: 720, height: 600,
      tabs: [{
        id: 'main', label: 'Отличия', keep: true,
        render(body) {
          if (r.same) { body.append(h('div', { class: 'diag-head ok' }, '✔ Схемы совпадают: те же устройства, кабели и настройки')); return; }
          body.append(...[h('div', { class: 'diag-head warn' }, 'Отличий: устройств ' + (r.added.length + r.removed.length) + ', кабелей ' + (r.links.added.length + r.links.removed.length) + ', настроек — на ' + r.changed.length + ' устройствах'),
            h('p', { class: 'muted small' }, 'Красным (−) — есть в эталоне, но нет в текущей схеме; зелёным (+) — есть только в текущей схеме.'),
            sec('Только в эталоне (нет в схеме)', r.removed, 'del'), sec('Новые устройства', r.added, 'add'),
            sec('Кабели только в эталоне', r.links.removed, 'del'), sec('Новые кабели', r.links.added, 'add')].filter(Boolean));
          if (r.changed.length) body.append(h('div', { class: 'section-title' }, 'Настройки устройств'));
          for (const c of r.changed) {
            const dev = app.net.findByName(c.name);
            body.append(h('details', { class: 'diff-dev', open: r.changed.length <= 3 ? true : null },
              h('summary', null, h('b', null, c.name), ' ', h('span', { class: 'muted' }, c.note || ('изменено строк: ' + c.count)), dev ? h('a', { href: '#', class: 'small', style: { marginLeft: '8px' }, onClick: (e) => { e.preventDefault(); app.ws.focusDevice(dev.id); } }, 'показать') : null),
              c.lines.length ? h('pre', { class: 'diff-pre mono' }, c.lines.map((l) => h('div', { class: l.op === '-' ? 'del' : l.op === '+' ? 'add' : l.op === '…' ? 'gap' : '' }, (l.op === '…' ? '   … ' : l.op + ' ') + l.text))) : null));
          }
        },
      }],
    });
  };

  UI.diagMenu = function (app, e) {
    const r = e.currentTarget.getBoundingClientRect();
    const sel = [...app.ws.selection].map((id) => app.net.getDevice(id)).find((d) => d && pingable(d));
    UI.menu(r.left, r.bottom + 4, [
      { label: 'Почему не работает?…', onClick: () => UI.whyDialog(app, sel ? sel.id : null) },
      { label: 'Проверка сети (типичные ошибки)…', onClick: () => UI.auditDialog(app) },
      { label: 'Сравнить с другой схемой…', onClick: () => UI.compareDialog(app) },
      '-',
      { label: 'Поиск неисправностей: сломать сеть…', onClick: () => UI.troubleDialog(app) },
    ]);
  };

  UI.diagPingable = pingable;
})(globalThis.NetLab = globalThis.NetLab || {});
