// Самопроверка настольной версии (Electron):
//  1) загрузить пример, выполнить ping, сохранить схему в файл и прочитать обратно;
//  2) запустить приложение с этим файлом в аргументах — как при двойном щелчке по .netlab.
// Скриншоты окна кладутся в dist/. Запуск: npm run smoke  (или: node tests/smoke.js путь\к\NetLab.exe)
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const exe = process.argv[2] || require('electron');
const appArgs = process.argv[2] ? [] : [path.join(__dirname, '..')];
const outDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(outDir, { recursive: true });
const scheme = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'netlab-file-')), 'Проверка сети.netlab');

function run(label, args, env) {
  const r = spawnSync(exe, args, { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 90000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('SMOKE '));
  if (!line) {
    console.error(label + ': приложение не ответило.\n', r.stdout, r.stderr, r.error || '');
    process.exit(1);
  }
  const res = JSON.parse(line.slice(6));
  console.log(label + ': ' + (res.ok ? 'OK' : 'ОШИБКА') + ' ' + JSON.stringify(res.res) + (res.errors.length ? ' ' + JSON.stringify(res.errors) : ''));
  return res.ok;
}

const ok1 = run('пример + ping + сохранение', appArgs, { NETLAB_SMOKE: path.join(outDir, 'smoke.png'), NETLAB_SMOKE_SAVE: scheme });
const ok2 = ok1 && run('открытие файла из аргументов', appArgs.concat([scheme]), { NETLAB_SMOKE: path.join(outDir, 'smoke-open.png') });
process.exit(ok1 && ok2 ? 0 : 1);
