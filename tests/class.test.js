// Сводка результатов класса: разбор CSV результатов учеников и общая ведомость.
const test = require('node:test');
const { NL, assert } = require('./helpers');

test('Сводка класса: CSV результатов → ведомость, доля решивших, CSV сводки', () => {
  const A = NL.activity;
  const act = { title: 'VLAN и транки', student: '' };
  const mk = (student, oks, pct) => A.resultCsv(act, {
    percent: pct, got: oks.filter(Boolean).length * 10, total: 30,
    items: [{ path: ['SW1', 'VLAN'], label: 'VLAN 10 «Отдел, продажи»', points: 10, ok: oks[0] }, { path: ['SW1', 'Fa0/1'], label: 'access vlan 10', points: 10, ok: oks[1] }],
    tests: [{ from: 'PC1', to: '10.0.0.2', expect: true, points: 10, ok: oks[2] }],
  }, { student, date: '25.09.2026' });
  const r1 = A.parseResultCsv(mk('Иванов Иван', [true, true, false], 66.6));
  assert.equal(r1.task, 'VLAN и транки');
  assert.equal(r1.student, 'Иванов Иван');
  assert.equal(r1.percent, 66.6);
  assert.equal(r1.got, 20);
  assert.equal(r1.items.length, 3);
  assert.equal(r1.items[0].label, 'VLAN 10 «Отдел, продажи»', 'запятая внутри кавычек');
  assert.equal(r1.items[2].section, 'Проверка связи');
  const r2 = A.parseResultCsv(mk('Петрова Анна', [true, true, true], 100));
  const sum = A.classSummary([r1, r2]);
  assert.deepEqual(sum.rows.map((r) => r.student), ['Петрова Анна', 'Иванов Иван']);
  assert.deepEqual(sum.solved, [100, 100, 50]);
  assert.equal(sum.avg, 83.3);
  const csv = A.summaryCsv(sum);
  assert.match(csv, /"Петрова Анна";"100";"30 из 30";"25\.09\.2026";"да";"да";"да"/);
  assert.match(csv, /"Решили, %";"83,3";"";"";"100";"100";"50"/);
  assert.throws(() => A.parseResultCsv('a;b\n1;2'), /не файл результата/);
});
