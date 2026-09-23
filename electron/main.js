/* NetLab — настольное приложение (Electron): окно, меню, диалоги открытия/сохранения,
 * открытие схем двойным щелчком по файлу .netlab, вопрос о несохранённых изменениях. */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const updates = require('./updater');

const ROOT = path.join(__dirname, '..');
const SMOKE = process.env.NETLAB_SMOKE || '';
const SMOKE_UPDATE = process.env.NETLAB_SMOKE_UPDATE || '';
const FILE_RE = /\.(netlab|json)$/i;
const MAX_FILE = 50 * 1024 * 1024;
const FILTERS = [
  { name: 'Схема NetLab', extensions: ['netlab', 'json'] },
  { name: 'Все файлы', extensions: ['*'] },
];

let win = null;
let state = { dirty: false, filePath: null };
let allowClose = false;
let pendingOpen = null;

if (SMOKE || SMOKE_UPDATE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'netlab-smoke-')));

/** Путь к схеме среди аргументов запуска (двойной щелчок по файлу в Проводнике). */
function fileFromArgs(argv) {
  for (const a of argv.slice(1)) {
    if (FILE_RE.test(a) && fs.existsSync(a)) return path.resolve(a);
  }
  return null;
}

function readSchemeFile(p) {
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('Это не файл');
  if (st.size > MAX_FILE) throw new Error('Файл слишком большой');
  return { path: p, name: path.basename(p), text: fs.readFileSync(p, 'utf8') };
}

function openPath(p) {
  if (!win) { pendingOpen = p; return; }
  try {
    win.webContents.send('file:opened', readSchemeFile(p));
  } catch (e) {
    dialog.showErrorBox('NetLab', 'Не удалось открыть «' + p + '»:\n' + e.message);
  }
}

function send(cmd) {
  if (win) win.webContents.send('menu', cmd);
}

function buildMenu() {
  // Горячие клавиши обрабатывает сама страница (registerAccelerator: false), иначе меню
  // перехватывало бы Ctrl+Z в полях ввода и Ctrl+Z (end) в консоли IOS.
  const k = (accelerator) => ({ accelerator, registerAccelerator: false });
  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая схема', ...k('CmdOrCtrl+N'), click: () => send('new') },
        { label: 'Открыть…', ...k('CmdOrCtrl+O'), click: () => send('open') },
        { type: 'separator' },
        { label: 'Сохранить', ...k('CmdOrCtrl+S'), click: () => send('save') },
        { label: 'Сохранить как…', ...k('CmdOrCtrl+Shift+S'), click: () => send('saveAs') },
        { type: 'separator' },
        { label: 'Примеры…', click: () => send('examples') },
        { type: 'separator' },
        { label: 'Выход', accelerator: 'Alt+F4', click: () => win && win.close() },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', ...k('CmdOrCtrl+Z'), click: () => send('undo') },
        { label: 'Повторить', ...k('CmdOrCtrl+Y'), click: () => send('redo') },
        { type: 'separator' },
        { label: 'Дублировать выделенное', ...k('CmdOrCtrl+D'), click: () => send('duplicate') },
        { label: 'Удалить выделенное', ...k('Delete'), click: () => send('delete') },
        { label: 'Выделить всё', ...k('CmdOrCtrl+A'), click: () => send('selectAll') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Реальное время', ...k('R'), click: () => send('mode-realtime') },
        { label: 'Режим симуляции', ...k('S'), click: () => send('mode-sim') },
        { type: 'separator' },
        { label: 'Показать всю схему', ...k('F'), click: () => send('fit') },
        { type: 'separator' },
        { label: 'Крупнее', role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { label: 'Мельче', role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { label: 'Обычный размер', role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { label: 'Во весь экран', role: 'togglefullscreen', accelerator: 'F11' },
        { type: 'separator' },
        { label: 'Инструменты разработчика', role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        { label: 'Как пользоваться', ...k('F1'), click: () => send('help') },
        { label: 'Примеры', click: () => send('examples') },
        { type: 'separator' },
        { label: 'Что нового в этой версии', click: () => send('whats-new') },
        { label: 'Проверить обновления…', click: () => send('check-updates') },
        { label: 'О программе', click: () => send('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function onClose(e) {
  if (allowClose || SMOKE || SMOKE_UPDATE) return;
  // Без открытого файла схема и так хранится в автосохранении — спрашивать не о чем.
  if (!state.dirty || !state.filePath) return;
  e.preventDefault();
  const r = dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'NetLab',
    message: 'Сохранить изменения в «' + path.basename(state.filePath) + '»?',
    detail: 'Если не сохранить, последние изменения останутся только в автосохранении NetLab.',
  });
  if (r === 0) send('save-and-close');
  else if (r === 1) {
    allowClose = true;
    win.close();
  }
}

function createWindow() {
  const icon = path.join(ROOT, 'build', 'icon.png');
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'NetLab',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#eef1f5',
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  buildMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', onClose);
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => {
    if (!SMOKE && !SMOKE_UPDATE) win.maximize();
    win.show();
  });
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen) {
      const p = pendingOpen;
      pendingOpen = null;
      openPath(p);
    }
    if (SMOKE_UPDATE) runSmokeUpdate();
    else if (SMOKE) runSmoke();
  });
  win.loadFile(path.join(ROOT, 'index.html'));
}

/* ---------- обмен с интерфейсом ---------- */

ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Открыть схему', filters: FILTERS, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return readSchemeFile(r.filePaths[0]);
});

ipcMain.handle('file:read', (_e, p) => {
  if (typeof p !== 'string' || !FILE_RE.test(p)) throw new Error('Можно открыть только файлы .netlab или .json');
  return readSchemeFile(p);
});

ipcMain.handle('file:save', async (_e, opts) => {
  let target = opts && typeof opts.path === 'string' && FILE_RE.test(opts.path) ? opts.path : null;
  if (!target || opts.saveAs) {
    const base = (opts && opts.suggestedName) || 'Моя сеть.netlab';
    const r = await dialog.showSaveDialog(win, {
      title: 'Сохранить схему',
      defaultPath: target || path.join(app.getPath('documents'), base),
      filters: FILTERS,
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
    if (!FILE_RE.test(target)) target += '.netlab';
  }
  // Запись через временный файл: при сбое старая версия схемы не портится.
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, String(opts.text), 'utf8');
  fs.renameSync(tmp, target);
  return { path: target, name: path.basename(target) };
});

ipcMain.on('app:state', (_e, s) => {
  state = { dirty: !!(s && s.dirty), filePath: s && typeof s.filePath === 'string' ? s.filePath : null };
});

ipcMain.on('app:close-now', () => {
  allowClose = true;
  if (win) win.close();
});

ipcMain.handle('app:version', () => app.getVersion());

/** Описание текущей версии (build/release-notes.md) — для окна «Что нового». */
ipcMain.handle('app:release-notes', () => {
  try { return fs.readFileSync(path.join(ROOT, 'build', 'release-notes.md'), 'utf8'); } catch (e) { return ''; }
});

/* ---------- обновления ---------- */

const upd = updates.init(() => win, () => { allowClose = true; });

/* ---------- самопроверка сборки: NETLAB_SMOKE=out.png electron . ---------- */

function runSmoke() {
  const errors = [];
  win.webContents.on('console-message', (e) => {
    const level = e.level !== undefined ? e.level : e;
    if (level === 'error' || level === 3) errors.push(e.message || String(e));
  });
  setTimeout(async () => {
    let res = null;
    const saveTo = process.env.NETLAB_SMOKE_SAVE || '';
    try {
      res = await win.webContents.executeJavaScript(`(async () => {
        const a = NetLab.app;
        if (a.filePath) {
          // запуск с файлом в аргументах (двойной щелчок по .netlab)
          return { desktop: !!window.netlabDesktop, openedFile: a.filePath, devices: a.net.devices.size, dirty: a.dirty, title: document.title };
        }
        a.loadExample(NetLab.ui.EXAMPLES.find((x) => x.id === 'routing'));
        const pc = a.net.findByName('PC0');
        let got = null;
        pc.ping('192.168.2.10', { count: 3, onEvent: (e) => { if (e.type === 'done') got = e.received; } });
        a.net.runUntilIdle();
        a.openDevice(pc.id, 'cli');
        const r = { desktop: !!window.netlabDesktop, devices: a.net.devices.size, received: got };
        // программы плат выполняются в Web Worker без сети
        r.worker = await new Promise((resolve) => {
          let w;
          try { w = new Worker('js/ui/script-worker.js'); } catch (e) { resolve('нет воркера: ' + e.message); return; }
          const logs = [];
          const t = setTimeout(() => { w.terminate(); resolve('тайм-аут: ' + logs.join('|')); }, 4000);
          w.onmessage = (ev) => { if (ev.data.type === 'log' || ev.data.type === 'error') logs.push(ev.data.text); if (logs.length >= 2) { clearTimeout(t); w.terminate(); resolve(logs.join('|')); } };
          w.onerror = (e) => { clearTimeout(t); resolve('ошибка: ' + e.message); };
          w.postMessage({ type: 'run', code: 'function setup() { Serial.println("ok"); print(typeof fetch + "," + typeof XMLHttpRequest + "," + typeof WebSocket); }', inputs: {} });
        });
        const u = await window.netlabDesktop.updateStatus();
        r.updates = { supported: u.supported, page: u.page, reason: u.reason };
        const target = ${JSON.stringify(saveTo)};
        if (target) {
          const saved = await window.netlabDesktop.saveFile({ text: JSON.stringify(a.net.serialize()), path: target, saveAs: false });
          const back = await window.netlabDesktop.readFile(saved.path);
          a.openText(back.text, back.name, back.path);
          r.savedTo = a.filePath;
          r.reopenedDevices = a.net.devices.size;
          r.dirtyAfterOpen = a.dirty;
          a.mutate(() => a.net.addNote(0, 0, 'проверка'));
          r.dirtyAfterEdit = a.dirty;
          r.title = document.title;
        }
        return r;
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SMOKE, img.toPNG());
      if (res && !res.openedFile) {
        // описание версии встроено в сборку и открывается в окне «Что нового»
        res.notes = await win.webContents.executeJavaScript(`(async () => {
          const t = await window.netlabDesktop.releaseNotes();
          await NetLab.ui.updates.whatsNew(true);
          await new Promise((r) => setTimeout(r, 300));
          const el = document.querySelector('.upd-news');
          return { chars: t.length, shown: !!el, items: el ? el.querySelectorAll('li').length : 0 };
        })()`);
        fs.writeFileSync(SMOKE.replace(/\.png$/i, '') + '-news.png', (await win.webContents.capturePage()).toPNG());
      }
    } catch (e) {
      errors.push(String(e));
    }
    const ok = !!res && res.desktop && errors.length === 0 &&
      (res.openedFile ? res.devices > 0 && !res.dirty : res.received === 3 && !!res.notes && res.notes.shown && res.notes.items > 0 &&
        res.worker === 'ok|undefined,undefined,undefined' &&
        // в собранной программе адрес обновлений обязан найтись (в 1.1.0 его не было — обновления не работали)
        (!app.isPackaged || (!!res.updates && res.updates.supported && /^https:\/\//.test(res.updates.page))) &&
        (!saveTo || (res.savedTo === saveTo && res.reopenedDevices === res.devices && !res.dirtyAfterOpen && res.dirtyAfterEdit)));
    process.stdout.write('SMOKE ' + JSON.stringify({ ok, res, errors }) + '\n');
    app.exit(ok ? 0 : 1);
  }, 1200);
}

/**
 * Самопроверка обновления: NETLAB_UPDATE_URL=http://…/ NETLAB_SMOKE_UPDATE=out.png NetLab.exe
 * Интерфейс сам проверяет обновления при запуске и показывает предложение; проверка нажимает
 * «Обновить сейчас», дожидается загрузки и делает снимки окна. Установка не запускается.
 */
function runSmokeUpdate() {
  const errors = [];
  const out = { current: app.getVersion() };
  const shot = async (file) => fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = async (fn, ms) => {
    for (let t = 0; t < ms; t += 250) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  win.webContents.on('console-message', (e) => {
    const level = e.level !== undefined ? e.level : e;
    if (level === 'error' || level === 3) errors.push(e.message || String(e));
  });
  (async () => {
    try {
      out.offerShown = await wait(() => js('!!document.querySelector(".upd-offer")'), 30000);
      out.offerText = out.offerShown ? await js('document.querySelector(".upd-offer").innerText') : null;
      out.available = upd.state.info ? upd.state.info.version : null;
      if (out.offerShown) {
        await shot(SMOKE_UPDATE.replace(/\.png$/i, '') + '-offer.png');
        await js('document.querySelector(".upd-offer").closest(".modal").querySelector(".actions .btn.primary").click()');
        out.downloaded = await wait(() => upd.state.downloaded, 600000);
        out.readyShown = await wait(() => js('!!document.querySelector(".upd-card.ready")'), 5000);
        await shot(SMOKE_UPDATE);
      }
      if (upd.state.last && upd.state.last.type === 'error') errors.push(upd.state.last.message);
    } catch (e) {
      errors.push(String(e));
    }
    const ok = !!(out.offerShown && out.downloaded && out.readyShown) && errors.length === 0;
    process.stdout.write('SMOKE ' + JSON.stringify({ ok, res: out, errors }) + '\n');
    app.exit(ok ? 0 : 1);
  })();
}

/* ---------- запуск ---------- */

if (!SMOKE && !SMOKE_UPDATE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingOpen = fileFromArgs(process.argv);
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = fileFromArgs(argv);
    if (f) openPath(f);
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
