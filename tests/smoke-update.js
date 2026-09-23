// Самопроверка обновлений на собранной программе, без GitHub:
//   node tests/smoke-update.js dist/win-unpacked/NetLab.exe папка-с-новой-версией
// В папке должны лежать latest.yml и установщик новой версии (npm run dist с большим номером версии).
// Вместо папки можно указать github — тогда обновление берётся с настоящих GitHub Releases
// (запускайте сборку с номером версии меньше опубликованного).
// Скрипт поднимает локальный HTTP-сервер, запускает программу с NETLAB_UPDATE_URL и проверяет:
// предложение обновиться показано, «Обновить сейчас» скачивает установщик, появляется «Перезапустить и установить».
// Сама установка не запускается. Снимки окна — dist/update-offer.png и dist/update.png.
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const exe = process.argv[2];
const dir = process.argv[3];
const GITHUB = dir === 'github';
if (!exe || !dir || (!GITHUB && !fs.existsSync(path.join(dir, 'latest.yml')))) {
  console.error('Использование: node tests/smoke-update.js путь\\к\\NetLab.exe (папка-с-latest.yml | github)');
  process.exit(2);
}
const outDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(outDir, { recursive: true });

const served = [];
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.join(dir, path.basename(name));
  served.push(name);
  if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Length': fs.statSync(file).size, 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const env = Object.assign({}, process.env, { NETLAB_SMOKE_UPDATE: path.join(outDir, 'update.png') });
  if (GITHUB) delete env.NETLAB_UPDATE_URL;
  else env.NETLAB_UPDATE_URL = url;
  // Chromium не читает HTTPS_PROXY — если интернет только через прокси, передаём его ключом
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const child = spawn(exe, GITHUB && proxy ? ['--proxy-server=' + proxy] : [], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  const timer = setTimeout(() => child.kill(), 11 * 60 * 1000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    server.close();
    const line = out.split('\n').find((l) => l.startsWith('SMOKE '));
    if (!line) { console.error('Программа не ответила. Код выхода ' + code + '\n' + out); process.exit(1); }
    const r = JSON.parse(line.slice(6));
    console.log('обновление: ' + (r.ok ? 'OK' : 'ОШИБКА') + ' ' + JSON.stringify(r.res) + (r.errors.length ? ' ' + JSON.stringify(r.errors) : ''));
    if (!GITHUB) console.log('запрошено с сервера: ' + [...new Set(served)].join(', '));
    process.exit(r.ok ? 0 : 1);
  });
});
