/* NetLab UI — обновления настольной версии: при запуске программа спрашивает сервер обновлений,
 * показывает, что нового, скачивает установщик с индикатором и перезапускается в новой версии. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const D = typeof window !== 'undefined' ? window.netlabDesktop : null;

  const START_DELAY = 3000;           // не мешать запуску программы
  const RECHECK = 6 * 3600 * 1000;    // повторная проверка, если программа открыта долго

  const S = { app: null, info: null, downloading: false, downloaded: null, hidden: false, card: null, closeOffer: null };

  const mb = (n) => (n / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' МБ';
  const date = (d) => {
    const t = d ? new Date(d) : null;
    return t && !Number.isNaN(t.getTime()) ? t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  };

  /** «Что нового»: HTML с GitHub показываем безопасно, простой текст/markdown — списком. */
  function notesEl(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const box = h('div', { class: 'upd-notes' });
    if (/<[a-z][\s\S]*>/i.test(t) && NS.dw && NS.dw.renderHtml) {
      box.appendChild(NS.dw.renderHtml(t, () => {}).el);
      return box;
    }
    const plain = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    let ul = null;
    for (const raw of t.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) { ul = null; continue; }
      const li = /^[-*•]\s+(.*)$/.exec(line);
      if (li) {
        if (!ul) { ul = h('ul'); box.appendChild(ul); }
        ul.appendChild(h('li', null, plain(li[1])));
        continue;
      }
      ul = null;
      const hd = /^#{1,6}\s+(.*)$/.exec(line);
      box.appendChild(hd ? h('div', { class: 'upd-h' }, plain(hd[1])) : h('p', null, plain(line)));
    }
    return box;
  }

  /* ---------- значок «Доступно обновление» в верхней панели ---------- */

  function badge() {
    const m = document.getElementById('menu');
    if (!m) return;
    let b = document.getElementById('updBadge');
    if (!S.info) { if (b) b.remove(); return; }
    if (!b) {
      b = h('button', { id: 'updBadge', class: 'btn upd-badge', onClick: () => (S.downloaded ? showReady() : showOffer(S.info, true)) });
      m.appendChild(b);
    }
    UI.clear(b);
    b.append(UI.icon('download'), h('span', { class: 'lbl' }, S.downloaded ? 'Установить ' + S.info.version : 'Обновление ' + S.info.version));
    b.title = S.downloaded ? 'Обновление загружено — щёлкните, чтобы установить' : 'Доступна новая версия NetLab ' + S.info.version;
  }

  /* ---------- предложение обновиться ---------- */

  function showOffer(ev, fromBadge) {
    if (S.closeOffer) S.closeOffer();
    const app = S.app;
    const when = date(ev.date);
    const body = h('div', { class: 'upd-offer' },
      h('div', { class: 'upd-versions' },
        h('div', null, h('span', { class: 'muted' }, 'Установлена'), h('b', null, ev.current)),
        h('div', { class: 'upd-arrow' }, '→'),
        h('div', null, h('span', { class: 'muted' }, 'Новая версия'), h('b', { class: 'new' }, ev.version))),
      when ? h('div', { class: 'muted', style: { marginBottom: '8px' } }, 'Выпущена ' + when) : null,
      notesEl(ev.notes) ? h('div', null, h('div', { class: 'upd-h' }, 'Что нового'), notesEl(ev.notes)) : null,
      ev.portable
        ? h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'У вас версия без установки (portable). Новый файл скачается в браузере — запустите его вместо старого. Схемы и автосохранение сохранятся.')
        : h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Обновление скачается в фоне — можно продолжать работать. Потом NetLab перезапустится уже в новой версии; схема сохранится.'));
    const actions = [
      { label: 'Пропустить эту версию', onClick: () => { app.setUiPref('skipVersion', ev.version); badge(); } },
      { label: 'Напомнить позже' },
      { label: ev.portable ? 'Скачать' : 'Обновить сейчас', primary: true, onClick: () => { startDownload(); } },
    ];
    if (fromBadge) actions.shift();
    S.closeOffer = UI.modal({ title: 'Доступно обновление NetLab', body, actions, onCancel: () => {} });
  }

  async function startDownload() {
    S.closeOffer = null;
    if (!S.info) return;
    if (S.info.portable) {
      const r = await D.downloadUpdate();
      UI.toast(r && r.opened ? 'Скачивание NetLab ' + S.info.version + ' открыто в браузере' : 'Не удалось открыть ссылку на новую версию', r && r.opened ? 'ok' : 'err', 5000);
      return;
    }
    S.downloading = true;
    S.hidden = false;
    progressCard({ percent: 0, transferred: 0, total: 0 });
    const r = await D.downloadUpdate();
    if (r && r.ok === false) { S.downloading = false; errorCard(r.error); }
  }

  /* ---------- карточка загрузки ---------- */

  function card(cls) {
    if (!S.card) {
      S.card = h('div', { class: 'upd-card' });
      document.body.appendChild(S.card);
    }
    S.card.className = 'upd-card ' + (cls || '');
    UI.clear(S.card);
    return S.card;
  }

  function closeCard() {
    if (S.downloading) S.hidden = true; // загрузка продолжается, карточка вернётся, когда всё скачается
    if (S.card) { S.card.remove(); S.card = null; }
  }

  function progressCard(p) {
    const c = card('loading');
    const pct = Math.max(0, Math.min(100, p.percent || 0));
    c.append(
      h('div', { class: 'upd-card-head' }, h('b', null, 'Загрузка NetLab ' + S.info.version), h('button', { class: 'btn icon small', title: 'Скрыть (загрузка продолжится)', onClick: closeCard }, UI.icon('close'))),
      h('div', { class: 'upd-bar' }, h('span', { style: { width: pct.toFixed(1) + '%' } })),
      h('div', { class: 'muted' }, p.total ? Math.round(pct) + '% · ' + mb(p.transferred) + ' из ' + mb(p.total) + (p.bps ? ' · ' + mb(p.bps) + '/с' : '') : 'Подключение к серверу…'));
  }

  function showReady() {
    const c = card('ready');
    c.append(
      h('div', { class: 'upd-card-head' }, h('b', null, 'NetLab ' + S.info.version + ' готов к установке'), h('button', { class: 'btn icon small', title: 'Скрыть', onClick: closeCard }, UI.icon('close'))),
      h('div', { class: 'muted' }, 'Программа закроется, установит обновление и откроется снова. Если отложить — обновление установится при следующем закрытии NetLab.'),
      h('div', { class: 'row', style: { marginTop: '10px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn outline small', onClick: closeCard }, 'При выходе'),
        h('button', { class: 'btn primary small', 'data-act': 'install', onClick: install }, 'Перезапустить и установить')));
  }

  function errorCard(text) {
    const c = card('error');
    c.append(
      h('div', { class: 'upd-card-head' }, h('b', null, 'Не удалось обновить NetLab'), h('button', { class: 'btn icon small', title: 'Скрыть', onClick: closeCard }, UI.icon('close'))),
      h('div', null, text),
      h('div', { class: 'row', style: { marginTop: '10px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn outline small', onClick: () => D.openUpdatePage() }, 'Открыть страницу выпуска'),
        h('button', { class: 'btn primary small', onClick: startDownload }, 'Повторить')));
  }

  /** Перед перезапуском — сохранить схему, если она открыта из файла и изменена. */
  async function install() {
    const app = S.app;
    if (app.hasUnsaved ? app.hasUnsaved() : app.dirty && app.filePath) {
      const choice = await new Promise((resolve) => UI.modal({
        title: 'Сохранить схему перед обновлением?',
        body: (app.fileName ? 'В «' + app.fileName + '» есть несохранённые изменения.' : 'Схема ещё не сохранена в файл.') + ' Она в любом случае останется в автосохранении NetLab и откроется после обновления.',
        dismissable: false,
        onCancel: () => resolve('cancel'),
        actions: [
          { label: 'Отмена', onClick: () => resolve('cancel') },
          { label: 'Не сохранять', onClick: () => resolve('skip') },
          { label: 'Сохранить', primary: true, onClick: () => resolve('save') },
        ],
      }));
      if (choice === 'cancel') return;
      if (choice === 'save' && !(await app.saveFile(false))) return;
    }
    app.flushAutosave();
    D.installUpdate();
  }

  /* ---------- события от оболочки ---------- */

  function onEvent(ev) {
    const app = S.app;
    switch (ev.type) {
      case 'available':
        S.info = ev;
        badge();
        if (!ev.manual && app.uiPref('skipVersion', null) === ev.version) return;
        if (S.downloading || S.downloaded) return;
        showOffer(ev, false);
        break;
      case 'none':
        if (ev.manual) UI.modal({ title: 'Обновления', body: 'У вас последняя версия NetLab — ' + ev.version + '.', actions: [{ label: 'OK', primary: true }] });
        break;
      case 'progress':
        if (S.downloading && !S.hidden) progressCard(ev);
        break;
      case 'downloaded':
        S.downloading = false;
        S.downloaded = ev.version;
        badge();
        showReady();
        break;
      case 'error':
        if (ev.during === 'download') { S.downloading = false; errorCard(ev.message); } else if (ev.manual) UI.modal({ title: 'Не удалось проверить обновления', body: ev.message, actions: [{ label: 'Закрыть', primary: true }] });
        break;
      default: break;
    }
  }

  /* ---------- «Что нового» после обновления ---------- */

  /** Показать описание текущей версии. force — по команде меню; иначе — один раз после обновления. */
  async function whatsNew(force) {
    if (!D || !D.releaseNotes) return;
    const app = S.app;
    const [version, notes] = await Promise.all([D.version(), D.releaseNotes()]);
    const last = app.uiPref('lastVersion', null);
    if (!force) {
      app.setUiPref('lastVersion', version);
      // новая установка — не мешаем; показываем только тем, кто обновился с прошлой версии
      if (last === version || (!last && !S.existingUser) || !notes) return;
    }
    const upgraded = !force && last && last !== version;
    UI.modal({
      title: 'Что нового в NetLab ' + version,
      body: h('div', { class: 'upd-news' },
        force ? null : h('div', { class: 'hint-box', style: { marginBottom: '10px' } },
          'NetLab обновлён' + (upgraded ? ' с версии ' + last : '') + ' до ' + version + '. Ваши схемы и настройки на месте.'),
        notesEl(notes) || h('p', { class: 'muted' }, 'Описание этой версии не найдено.')),
      actions: [{ label: 'Понятно', primary: true }],
    });
  }

  async function check(manual) {
    if (!D || !D.checkUpdates) return;
    if (manual && S.downloaded) { showReady(); return; }
    const st = await D.checkUpdates({ manual: !!manual });
    if (manual && st && !st.supported) UI.modal({ title: 'Обновления', body: st.reason, actions: [{ label: 'Закрыть', primary: true }] });
  }

  UI.updates = {
    available: () => !!(D && D.checkUpdates),
    init(app) {
      S.app = app;
      if (!D || !D.onUpdate) return;
      // пользовался ли человек программой раньше (у версий до 1.1.0 номера версии в настройках не было)
      S.existingUser = Object.keys(app.prefs).some((k) => k !== 'lastVersion') || !!UI.store.get('netlab.autosave.v1');
      whatsNew(false);
      D.onUpdate(onEvent);
      if (app.settings.autoUpdate !== false) setTimeout(() => check(false), START_DELAY);
      setInterval(() => { if (app.settings.autoUpdate !== false && !S.downloading && !S.downloaded) check(false); }, RECHECK);
    },
    check,
    whatsNew,
    state: S,
  };
})(globalThis.NetLab = globalThis.NetLab || {});
