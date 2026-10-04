// Задания (Activity Wizard): схема-ответ, пункты оценки, проверки связи, процент, сохранение в файле.
const test = require('node:test');
const { NL, U, assert, mkNet, link, cli } = require('./helpers');

const A = NL.activity;

/** R1 (две сети) — SW1 — PC1, SW2 — Server; ответ: адреса, OSPF, enable secret. */
function answerNet() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const s1 = net.addDevice('switch', { name: 'SW1' });
  const s2 = net.addDevice('switch', { name: 'SW2' });
  const pc = net.addDevice('pc', { name: 'PC1' });
  const srv = net.addDevice('server', { name: 'Server' });
  link(net, r, s1, 0);
  link(net, r, s2, 1);
  link(net, pc, s1);
  link(net, srv, s2);
  return { net, r, pc, srv };
}

function configure({ net, r, pc, srv }) {
  cli(r, ['enable', 'conf t', 'hostname R1', 'enable secret class', 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'exit',
    'interface g0/1', 'ip address 192.168.2.1 255.255.255.0', 'exit', 'router ospf 1', 'network 192.168.0.0 0.0.255.255 area 0', 'end']);
  pc.setStatic(U.parseIp('192.168.1.10'), U.maskFromPrefix(24), U.parseIp('192.168.1.1'), null);
  srv.setStatic(U.parseIp('192.168.2.10'), U.maskFromPrefix(24), U.parseIp('192.168.2.1'), null);
  net.runUntilIdle();
}

test('Задание: пункты оценки из ответа, процент выполнения, проверка связи, сохранение', () => {
  const lab = answerNet();
  const initial = A.snapshot(lab.net); // начальная схема — без настроек
  configure(lab);
  const answer = A.snapshot(lab.net);
  const cands = A.candidates(NL.Network.deserialize(answer));
  const labels = cands.map((c) => c.label);
  assert.ok(labels.includes('hostname R1'));
  assert.ok(labels.includes('ip address 192.168.1.1 255.255.255.0'));
  assert.ok(labels.includes('network 192.168.0.0 0.0.255.255 area 0'));
  assert.ok(labels.includes('IP-адрес = 192.168.1.10'));
  assert.ok(labels.some((l) => /^R1 GigabitEthernet0\/0 — SW1 /.test(l)), 'соединения');
  assert.ok(!labels.some((l) => /^hostname Router|^line con 0|no service/.test(l)), 'заводские строки не попадают в оценку');
  assert.ok(!labels.some((l) => /почта|SSID/.test(l)), 'пустые настройки ПК не попадают в оценку');

  const items = cands.map((c) => ({ key: c.key, path: c.path, label: c.label, value: c.value, points: 1 }));
  const task = A.build({ title: 'Маршрутизация', instructions: '# Задача\n- настройте R1\n- **OSPF**', timer: 20, feedback: 'full', answer, initial, items,
    tests: [{ from: 'PC1', to: '192.168.2.10', expect: true, points: 5 }, { from: 'PC1', to: '10.9.9.9', expect: false, points: 1 }] });
  assert.ok(!JSON.stringify(task).includes('192.168.1.10'), 'ответ в файле не читается глазами');
  assert.equal(A.open(task).items.length, items.length);

  // ученик получает начальную схему
  const student = NL.Network.deserialize(initial);
  student.task = task;
  let r = A.check(student, task);
  const total = items.length + 6;
  assert.equal(r.total, total);
  const devAndLinks = r.items.filter((x) => x.ok).length;
  assert.ok(devAndLinks > 0 && devAndLinks < items.length, 'устройства и кабели уже на месте, настроек нет');
  assert.equal(r.tests[0].ok, false);
  assert.equal(r.tests[1].ok, true, 'связи с 10.9.9.9 и не должно быть');
  assert.ok(r.percent < 60, 'процент: ' + r.percent);

  // ученик выполняет задание — 100 %
  configure({ net: student, r: student.findByName('R1'), pc: student.findByName('PC1'), srv: student.findByName('Server') });
  r = A.check(student, task);
  assert.deepEqual(r.items.filter((x) => !x.ok).map((x) => x.label), []);
  assert.equal(r.tests[0].ok, true, 'ping PC1 → Server проходит');
  assert.equal(r.percent, 100);
  assert.equal(student.findByName('PC1').arp.size, 0, 'проверка связи идёт на копии схемы — ARP ученика не тронут');

  // ошибка ученика: другой адрес — пункт не засчитан
  cli(student.findByName('R1'), ['enable', 'class', 'conf t', 'interface g0/0', 'ip address 192.168.1.254 255.255.255.0', 'end']); // enable secret class
  r = A.check(student, task);
  assert.ok(r.percent < 100);
  assert.ok(r.items.some((x) => !x.ok && x.label === 'ip address 192.168.1.1 255.255.255.0'));

  // задание сохраняется в файле вместе со схемой
  const saved = JSON.parse(JSON.stringify(student.serialize()));
  assert.equal(saved.task.title, 'Маршрутизация');
  const n2 = NL.Network.deserialize(saved);
  assert.equal(n2.task.timer, 20);
  assert.equal(A.check(n2, n2.task).total, total);
  // черновик мастера восстанавливается из задания
  const d = A.draft(n2.task);
  assert.equal(d.items.length, items.length);
  assert.equal(d.tests[0].points, 5);
  assert.equal(d.initial.devices.length, 5);
  // пароль мастера
  assert.equal(A.passHash('teacher'), A.passHash('teacher'));
  assert.notEqual(A.passHash('teacher'), A.passHash('student'));
  // испорченное задание
  assert.throws(() => A.check(n2, { secret: 'nla1:###' }), /повреждено/);
  const n3 = NL.Network.deserialize(Object.assign({}, saved, { task: { v: 99, secret: 'x' } }));
  assert.equal(n3.task, null);
});

test('Задание: переменные у каждого ученика, свои пункты, подсказки, блокировки, живой счёт, CSV', () => {
  const lab = answerNet();
  const initial = A.snapshot(lab.net);
  const answerRef = NL.Network.deserialize(initial);
  const items = [
    A.customItem({ kind: 'cfg', device: 'R1', section: 'interface GigabitEthernet0/0', line: 'ip address 10.{{NET}}.0.1 255.255.255.0', points: 2, hint: 'адрес на G0/0: 10.{{NET}}.0.1/24' }, answerRef),
    A.customItem({ kind: 'host', device: 'PC1', field: 'ip', value: '10.{{NET}}.0.10' }, answerRef),
    A.customItem({ kind: 'port', device: 'R1', port: 'GigabitEthernet0/2', up: false }, answerRef),
  ];
  assert.equal(items[1].key, 'set|PC1|ifaces/FastEthernet0/ip');
  assert.throws(() => A.customItem({ kind: 'cfg', device: 'R1', line: '' }, answerRef), /строку/);
  const task = A.build({ title: 'Переменные', instructions: 'Сеть 10.{{NET}}.0.0/24', answer: initial, initial, items,
    tests: [{ from: 'PC1', to: '10.{{NET}}.0.1', expect: true, points: 3 }],
    vars: [{ name: 'NET', kind: 'range', min: 20, max: 20 }, { name: 'bad name', kind: 'range', min: 1, max: 2 }, { name: 'SITE', kind: 'list', list: 'A, B' }],
    locks: { cli: true, add: true, bogus: true }, live: true });
  assert.deepEqual(task.locks, ['add', 'cli']);
  assert.equal(task.live, true);
  assert.deepEqual(A.open(task).vars.map((v) => v.name), ['NET', 'SITE'], 'неверное имя переменной отброшено');
  const student = NL.Network.deserialize(initial);
  student.task = task;
  assert.equal(A.ensureValues(task, () => 0.99), true);
  assert.equal(task.values.NET, '20');
  assert.equal(task.values.SITE, 'B');
  assert.equal(A.ensureValues(task), false, 'значения выбираются один раз');
  assert.equal(A.subst(task.instructions, task.values), 'Сеть 10.20.0.0/24');

  let r = A.check(student, task, { tests: false });
  assert.equal(r.tests.length, 0);
  assert.equal(r.total, 2 + 1 + 1 + 3, 'баллы проверок связи учитываются и без их запуска');
  const f = r.items.find((x) => x.label.startsWith('ip address'));
  assert.equal(f.label, 'ip address 10.20.0.1 255.255.255.0');
  assert.equal(f.hint, 'адрес на G0/0: 10.20.0.1/24');

  cli(student.findByName('R1'), ['enable', 'conf t', 'interface g0/0', 'ip address 10.20.0.1 255.255.255.0', 'exit', 'interface g0/2', 'shutdown', 'end']);
  student.findByName('PC1').setStatic(U.parseIp('10.20.0.10'), U.maskFromPrefix(24), U.parseIp('10.20.0.1'), null);
  student.runUntilIdle();
  r = A.check(student, task);
  assert.deepEqual(r.items.filter((x) => !x.ok).map((x) => x.label), []);
  assert.equal(r.tests[0].to, '10.20.0.1');
  assert.equal(r.tests[0].ok, true);
  assert.equal(r.percent, 100);

  // CSV для Excel
  task.student = 'Иванов Пётр';
  const csv = A.resultCsv(task, r, { date: '25.09.2026' });
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /"Ученик";"Иванов Пётр"/);
  assert.match(csv, /"Процент";"100"/);
  assert.match(csv, /"R1 \/ Конфигурация \/ interface GigabitEthernet0\/0";"ip address 10\.20\.0\.1 255\.255\.255\.0";"2";"да"/);

  // значения, имя ученика и ограничения сохраняются в файле
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(student.serialize())));
  assert.equal(n2.task.values.NET, '20');
  assert.equal(n2.task.student, 'Иванов Пётр');
  assert.deepEqual(n2.task.locks, ['add', 'cli']);
  const d = A.draft(n2.task);
  assert.equal(d.locks.cli, true);
  assert.equal(d.vars.length, 2);
  assert.equal(d.items.filter((x) => x.custom).length, 3);
});

test('Задание: новая попытка — свои значения переменных, сохранённая работа — прежние', () => {
  const lab = answerNet();
  const initial = A.snapshot(lab.net);
  const task = A.build({ title: 'T', answer: initial, initial, items: [], vars: [{ name: 'N', kind: 'range', min: 1, max: 100 }] });
  assert.equal(task.fresh, true);
  task.values = { N: '5' }; // автор проверял задание и сохранил файл
  const file = JSON.parse(JSON.stringify(Object.assign(NL.Network.deserialize(initial).serialize(), { task })));
  const student = NL.Network.deserialize(file);
  assert.equal(A.startAttempt(student.task, () => 0.5), true);
  assert.equal(student.task.values.N, '51', 'ученик получил своё значение, а не авторское');
  assert.equal(student.task.fresh, undefined);
  const again = NL.Network.deserialize(JSON.parse(JSON.stringify(student.serialize())));
  assert.equal(A.startAttempt(again.task, () => 0.1), false);
  assert.equal(again.task.values.N, '51', 'продолжение работы — те же значения');
});
