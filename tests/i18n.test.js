// Английский интерфейс: словарь и перевод составных строк (без DOM).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function load(lang) {
  const NS = { ui: {} };
  const prev = { NetLab: globalThis.NetLab, localStorage: globalThis.localStorage };
  globalThis.NetLab = NS;
  globalThis.localStorage = { getItem: () => lang, setItem() {} };
  for (const f of ['i18n-en.js', 'i18n.js']) {
    const p = path.join(__dirname, '..', 'js', 'ui', f);
    delete require.cache[require.resolve(p)];
    require(p);
  }
  globalThis.NetLab = prev.NetLab;
  globalThis.localStorage = prev.localStorage;
  return NS;
}

test('i18n: словарь, точные строки, составные строки, единицы измерения, смесь языков не допускается', () => {
  const NS = load('en');
  const tr = NS.i18n.tr;
  assert.equal(NS.ui.lang, 'en');
  assert.ok(Object.keys(NS.i18nEn).length > 1500);
  for (const [k, v] of Object.entries(NS.i18nEn)) {
    assert.equal(typeof v, 'string', k);
    assert.ok(v.length > 0, k);
    assert.doesNotMatch(v, /[А-Яа-яЁё]/, 'в переводе осталась кириллица: ' + k);
  }
  assert.equal(tr('Реальное время'), 'Realtime');
  assert.equal(tr('  Сохранить  '), '  Save  ', 'пробелы вокруг сохраняются');
  assert.equal(tr('Устройств: 8 · кабелей: 5'), 'Devices: 8 · links: 5');
  assert.equal(tr('Кабель слишком длинный: 336 м — предел для медного кабеля 100 м'), 'Cable too long: 336 m — limit for a copper cable 100 m');
  assert.equal(tr('Коммутатор 3-го уровня Cisco 3560-24PS. У этой модели нет сменных модулей. Кнопка питания включает и выключает устройство.'),
    'Layer 3 Switch Cisco 3560-24PS. This model has no replaceable modules. The power button turns the device on and off.');
  // не переведённая целиком строка остаётся русской (без смеси языков)
  assert.equal(tr('Совершенно неизвестная фраза и Сохранить'), 'Совершенно неизвестная фраза и Сохранить');
  assert.equal(tr('GigabitEthernet0/1'), 'GigabitEthernet0/1', 'латиница не трогается');
  assert.equal(load('ru').ui.lang, 'ru');
});
