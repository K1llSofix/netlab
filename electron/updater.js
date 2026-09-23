/* NetLab — проверка и установка обновлений (electron-updater, GitHub Releases).
 * Установленная версия скачивает новый установщик и ставит его при перезапуске.
 * Portable-версия себя не обновляет — ей предлагается скачать новый файл.
 * Для проверки без GitHub: NETLAB_UPDATE_URL=http://адрес/папки (там latest.yml и установщик). */
'use strict';

const { app, ipcMain, shell } = require('electron');
const pkg = require('../package.json');

const TEST_URL = process.env.NETLAB_UPDATE_URL || '';
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
const PUB = [].concat((pkg.build && pkg.build.publish) || [])[0] || null;

let updater = null;
function load() {
  if (updater === null) {
    try { updater = require('electron-updater').autoUpdater; } catch (e) { updater = false; }
  }
  return updater;
}

/** Откуда брать обновления. */
function feed() {
  if (TEST_URL) return { provider: 'generic', url: TEST_URL };
  if (PUB && PUB.provider === 'github' && PUB.owner && PUB.repo) return { provider: 'github', owner: PUB.owner, repo: PUB.repo, releaseType: 'release' };
  if (PUB && PUB.provider === 'generic' && PUB.url) return { provider: 'generic', url: PUB.url };
  return null;
}

const trimSlash = (u) => String(u).replace(/\/+$/, '');

/** Страница выпуска (для кнопки «Что нового» и для portable-версии). */
function pageUrl(version) {
  if (TEST_URL) return trimSlash(TEST_URL) + '/';
  if (PUB && PUB.provider === 'github') return 'https://github.com/' + PUB.owner + '/' + PUB.repo + '/releases' + (version ? '/tag/v' + version : '/latest');
  return PUB && PUB.url ? trimSlash(PUB.url) + '/' : '';
}

/** Прямая ссылка на новый portable-файл. */
function portableUrl(version) {
  const file = 'NetLab-' + version + '-portable.exe';
  if (!TEST_URL && PUB && PUB.provider === 'github') return 'https://github.com/' + PUB.owner + '/' + PUB.repo + '/releases/download/v' + version + '/' + file;
  const base = pageUrl();
  return base ? base + encodeURIComponent(file) : '';
}

function status() {
  const u = load();
  let reason = null;
  if (!u) reason = 'Модуль обновлений не установлен';
  else if (!feed()) reason = 'Не задан адрес, где публикуются обновления (package.json → build.publish)';
  else if (!app.isPackaged && !TEST_URL) reason = 'Обновления проверяются только в собранной программе (npm run dist), а не при запуске через npm start';
  return { version: app.getVersion(), portable: PORTABLE, supported: !reason, reason, page: pageUrl() };
}

/** Заметки о выпуске → строка (у GitHub это HTML, у latest.yml — текст или список). */
function notesText(n) {
  if (!n) return '';
  if (Array.isArray(n)) return n.map((x) => (x && x.note) || '').filter(Boolean).join('\n');
  return String(n);
}

function friendly(e) {
  const m = String((e && (e.message || e)) || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_PROXY|net::/i.test(m)) return 'Нет связи с сервером обновлений. Проверьте подключение к интернету.';
  if (/\b404\b|Cannot find latest|No published versions|Unable to find latest version/i.test(m)) return 'На сервере обновлений пока нет ни одной опубликованной версии (нет выпуска с файлом latest.yml).';
  if (/sha512 checksum mismatch/i.test(m)) return 'Скачанный файл повреждён (не совпала контрольная сумма). Попробуйте ещё раз.';
  if (/not signed|signature/i.test(m)) return 'Файл обновления не прошёл проверку подписи.';
  return m.split('\n')[0].slice(0, 300) || 'Неизвестная ошибка';
}

const isWeb = (u) => /^https?:\/\//i.test(String(u || ''));

/**
 * Подключить обновления. getWin() — главное окно, allowQuit() — разрешить закрыть окно
 * без вопроса о несохранённой схеме (интерфейс уже спросил сам).
 */
function init(getWin, allowQuit) {
  const u = load();
  const st = { manual: false, info: null, downloading: false, downloaded: false, last: null };
  const send = (ev) => {
    st.last = ev;
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send('update:event', ev);
  };

  if (u && feed()) {
    u.autoDownload = false;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = false;
    u.allowDowngrade = false;
    u.fullChangelog = false;
    u.logger = { info() {}, debug() {}, warn: (m) => console.warn('[update]', m), error: (m) => console.error('[update]', m) };
    if (!app.isPackaged && TEST_URL) u.forceDevUpdateConfig = true;
    u.setFeedURL(feed());
    u.on('update-available', (i) => {
      st.info = i;
      send({ type: 'available', manual: st.manual, version: i.version, current: app.getVersion(), notes: notesText(i.releaseNotes), date: i.releaseDate || null, portable: PORTABLE, page: pageUrl(i.version) });
    });
    u.on('update-not-available', () => send({ type: 'none', manual: st.manual, version: app.getVersion() }));
    u.on('download-progress', (p) => send({ type: 'progress', percent: p.percent, transferred: p.transferred, total: p.total, bps: p.bytesPerSecond }));
    u.on('update-downloaded', (i) => {
      st.downloading = false;
      st.downloaded = true;
      send({ type: 'downloaded', version: i.version });
    });
    u.on('error', (e) => {
      const wasDownloading = st.downloading;
      st.downloading = false;
      send({ type: 'error', manual: st.manual || wasDownloading, during: wasDownloading ? 'download' : 'check', message: friendly(e) });
    });
  }

  ipcMain.handle('update:status', () => Object.assign(status(), { downloaded: st.downloaded, available: st.info ? st.info.version : null }));

  ipcMain.handle('update:check', async (_e, opts) => {
    const s = status();
    if (!s.supported) return s;
    st.manual = !!(opts && opts.manual);
    try { await u.checkForUpdates(); } catch (e) { /* ошибку уже отправил обработчик 'error' */ }
    return s;
  });

  ipcMain.handle('update:download', async () => {
    if (!st.info) return { ok: false, error: 'Сначала проверьте обновления' };
    if (PORTABLE) {
      const link = portableUrl(st.info.version);
      if (isWeb(link)) await shell.openExternal(link);
      return { ok: true, opened: link };
    }
    if (st.downloaded) { send({ type: 'downloaded', version: st.info.version }); return { ok: true }; }
    if (!st.downloading) {
      st.downloading = true;
      u.downloadUpdate().catch(() => { /* ошибку уже отправил обработчик 'error' */ });
    }
    return { ok: true };
  });

  ipcMain.handle('update:open-page', async () => {
    const link = pageUrl(st.info && st.info.version);
    if (isWeb(link)) await shell.openExternal(link);
    return link;
  });

  ipcMain.on('update:install', () => {
    if (!st.downloaded) return;
    allowQuit();
    // тихая установка и автоматический запуск новой версии
    setImmediate(() => u.quitAndInstall(true, true));
  });

  return { status, state: st };
}

module.exports = { init, status, pageUrl, portableUrl };
