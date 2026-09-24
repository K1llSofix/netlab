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
