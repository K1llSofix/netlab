// Диагностика «Почему не работает?» и аудит схемы.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

/** PC1 — SW1 — R1 ═ R2 — PC2; статические маршруты. */
function lab() {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  const sw = net.addDevice('switch', { name: 'SW1' });
  routerIf(r1, 0, '192.168.1.1/24');
  routerIf(r1, 1, '10.0.0.1/30');
  routerIf(r2, 1, '10.0.0.2/30');
  routerIf(r2, 0, '192.168.2.1/24');
  const a = pc(net, 'PC1', '192.168.1.10/24', '192.168.1.1');
  const b = pc(net, 'PC2', '192.168.2.10/24', '192.168.2.1');
  link(net, a, sw, 0, 0);
  link(net, sw, r1, 1, 0);
  link(net, r1, r2, 1, 1);
  link(net, r2, b, 0, 0);
  cli(r1, ['enable', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end']);
  cli(r2, ['enable', 'conf t', 'ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'end']);
  net.runUntilIdle();
  return { net, r1, r2, sw, a, b };
}

const D = () => NL.diag;
const errs = (res) => res.issues.filter((x) => x.sev === 'err');

test('Почему не работает: исправная сеть — путь туда и обратно', () => {
  const { net, a } = lab();
  const res = D().explain(net, a.id, 'PC2');
  assert.equal(res.ok, true, JSON.stringify(res.issues));
  assert.equal(res.ip, '192.168.2.10');
  assert.deepEqual(res.path, ['PC1', 'SW1', 'R1', 'R2', 'PC2']);
  assert.deepEqual(res.back, ['PC2', 'R2', 'R1', 'SW1', 'PC1']);
  assert.ok(res.links.length >= 4);
  assert.ok(res.steps.some((s) => s.dev === 'R1' && /статический 192\.168\.2\.0\/24 через 10\.0\.0\.2/.test(s.text)), JSON.stringify(res.steps));
  assert.equal(errs(res).length, 0);
  // копия: исходная сеть не меняется
  assert.equal(net.log.length, 0);
});

test('Почему не работает: нет шлюза, нет обратного маршрута, shutdown, ACL, чужой адрес', () => {
  let { net, a, r1, r2, b } = lab();
  a.setStatic(a.iface.ip, a.iface.mask, null, null);
  let res = D().explain(net, a.id, '192.168.2.10');
  assert.equal(res.ok, false);
  assert.match(errs(res)[0].text, /PC1: не задан шлюз по умолчанию/);
  assert.match(errs(res)[0].fix, /192\.168\.1\.0\/24/);

  ({ net, a, r1, r2, b } = lab());
  cli(r2, ['enable', 'conf t', 'no ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'end']);
  res = D().explain(net, a.id, 'PC2');
  assert.equal(res.ok, false);
  assert.equal(errs(res)[0].dev, 'R2');
  assert.match(errs(res)[0].text, /Нет маршрута до 192\.168\.1\.10/);
  assert.match(errs(res)[0].fix, /ip route/);
  assert.deepEqual(res.path, ['PC1', 'SW1', 'R1', 'R2', 'PC2'], 'запрос дошёл');

  ({ net, a, r1, r2, b } = lab());
  cli(r1, ['enable', 'conf t', 'interface g0/1', 'shutdown', 'end']);
  res = D().explain(net, a.id, 'PC2');
  assert.match(errs(res)[0].text, /R1: маршрут «ip route 192\.168\.2\.0 255\.255\.255\.0 10\.0\.0\.2» неактивен — интерфейс GigabitEthernet0\/1 .*shutdown/);
  assert.match(errs(res)[0].fix, /no shutdown/);

  ({ net, a, r1, r2, b } = lab());
  cli(r2, ['enable', 'conf t', 'access-list 101 deny icmp any host 192.168.2.10', 'access-list 101 permit ip any any', 'interface g0/0', 'ip access-group 101 out', 'end']);
  res = D().explain(net, a.id, 'PC2');
  assert.match(errs(res)[0].text, /R2: Отброшено списком доступа 101/);
  assert.match(errs(res)[0].fix, /show access-lists/);

  ({ net, a } = lab());
  res = D().explain(net, a.id, '192.168.2.99');
  assert.match(errs(res)[0].text, /R2: на ARP-запрос о 192\.168\.2\.99 никто не ответил/);

  ({ net, a, b } = lab());
  b.setStatic(b.iface.ip, b.iface.mask, null, null);
  res = D().explain(net, a.id, 'PC2');
  assert.match(errs(res)[0].text, /дошёл до PC2, но у него не задан шлюз/);

  ({ net, a } = lab());
  res = D().explain(net, a.id, 'www.example.com');
  assert.match(errs(res)[0].text, /Имя «www\.example\.com» не удалось преобразовать/);
});

test('Почему не работает: второй уровень — VLAN на порту, транк, кабель', () => {
  let { net, a, sw } = lab();
  cli(sw, ['enable', 'conf t', 'vlan 10', 'exit', 'interface fa0/1', 'switchport access vlan 10', 'end']);
  let res = D().explain(net, a.id, 'PC2');
  assert.equal(res.ok, false);
  const e = errs(res)[0];
  assert.equal(e.dev, 'SW1');
  assert.match(e.text, /порт FastEthernet0\/2 \(к R1\) в VLAN 1, а кадры от PC1 идут в VLAN 10/);
  assert.match(e.fix, /switchport access vlan 10/);

  ({ net, a, sw } = lab());
  cli(sw, ['enable', 'conf t', 'interface fa0/2', 'shutdown', 'end']);
  res = D().explain(net, a.id, 'PC2');
  assert.match(errs(res)[0].text, /SW1 FastEthernet0\/2.*shutdown/);

  // транк между коммутаторами без нужного VLAN
  const net2 = mkNet();
  const s1 = net2.addDevice('switch', { name: 'S1' });
  const s2 = net2.addDevice('switch', { name: 'S2' });
  const p1 = pc(net2, 'A', '10.1.1.1/24');
  const p2 = pc(net2, 'B', '10.1.1.2/24');
  link(net2, p1, s1, 0, 0);
  link(net2, p2, s2, 0, 0);
  link(net2, s1, s2, 24, 24);
  for (const s of [s1, s2]) cli(s, ['enable', 'conf t', 'vlan 20', 'exit', 'interface fa0/1', 'switchport access vlan 20', 'interface g0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 1', 'end']);
  net2.runUntilIdle();
  res = D().explain(net2, p1.id, 'B');
  assert.match(errs(res)[0].text, /VLAN 20 не разрешён на транке GigabitEthernet0\/1/, JSON.stringify(res.issues));
  assert.match(errs(res)[0].fix, /switchport trunk allowed vlan add 20/);
});

test('Аудит схемы: повтор адреса, шлюз, shutdown, транк/access, нет маршрута', () => {
  const { net, a, b, r1, r2, sw } = lab();
  assert.deepEqual(D().audit(net).filter((x) => x.sev !== 'info'), [], 'исправная сеть без замечаний');
  const c = pc(net, 'PC3', '192.168.1.10/24', '192.168.1.254');
  link(net, c, sw, 0, 2);
  cli(r1, ['enable', 'conf t', 'no ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end']);
  cli(r2, ['enable', 'conf t', 'interface g0/0', 'shutdown', 'end']);
  const sw2 = net.addDevice('switch', { name: 'SW2' });
  link(net, sw, sw2, 24, 24);
  cli(sw, ['enable', 'conf t', 'interface g0/1', 'switchport mode trunk', 'end']);
  cli(sw2, ['enable', 'conf t', 'interface g0/1', 'switchport mode access', 'end']);
  const pr = pc(net, 'PC4', '192.168.1.20/24');
  link(net, pr, sw, 0, 3);
  net.runUntilIdle();
  const list = D().audit(net);
  const text = list.map((x) => x.sev + ' ' + x.text).join('\n');
  assert.match(text, /^err Адрес 192\.168\.1\.10 повторяется: PC1, PC3$/m);
  assert.match(text, /^err PC3: шлюз 192\.168\.1\.254 не назначен ни одному устройству$/m);
  assert.match(text, /^err R2 GigabitEthernet0\/0: интерфейс с адресом 192\.168\.2\.0\/24 выключен \(shutdown\)/m);
  assert.match(text, /^warn SW1 GigabitEthernet0\/1 ↔ SW2 GigabitEthernet0\/1: на одном конце транк, на другом access$/m);
  assert.match(text, /^warn R1: нет маршрута в сеть 192\.168\.2\.0\/24$/m);
  assert.match(text, /^warn PC4: не задан шлюз по умолчанию/m);
  assert.ok(list.findIndex((x) => x.sev === 'warn') > list.findIndex((x) => x.sev === 'err'), 'ошибки раньше предупреждений');
  void a; void b;
});

test('Поиск неисправностей: поломки нарушают связь, задание проверяет её восстановление', () => {
  const { net, sw, r2 } = lab();
  const c = pc(net, 'PC3', '192.168.1.11/24', '192.168.1.1');
  link(net, c, sw, 0, 2);
  const e = pc(net, 'PC4', '192.168.2.11/24', '192.168.2.1');
  const sw2 = net.addDevice('switch', { name: 'SW2' });
  link(net, e, sw2, 0, 0);
  link(net, sw2, r2, 1, 2);
  cli(r2, ['enable', 'conf t', 'interface g0/2', 'ip address 192.168.3.1 255.255.255.0', 'end']);
  e.setStatic(NL.util.parseIp('192.168.3.10'), NL.util.maskFromPrefix(24), NL.util.parseIp('192.168.3.1'), null);
  cli(net.findByName('R1'), ['enable', 'conf t', 'ip route 192.168.3.0 255.255.255.0 10.0.0.2', 'end']);
  net.runUntilIdle();
  const cands = D().faultCandidates(net);
  const kinds = new Set(cands.map((x) => x.cat + ':' + x.kind));
  for (const k of ['host:gw', 'host:mask', 'host:ip', 'l2:vlan', 'l2:shut', 'l3:shut', 'l3:ifip', 'l3:route', 'sec:acl']) assert.ok(kinds.has(k), 'есть поломка ' + k);

  const before = JSON.stringify(net.serialize());
  const res = D().breakNetwork(net, { count: 3, seed: 7 });
  assert.equal(JSON.stringify(net.serialize()), before, 'исходная сеть не меняется');
  assert.ok(res.faults.length >= 2 && res.faults.length <= 3, JSON.stringify(res.faults));
  assert.equal(new Set(res.faults.map((f) => f.dev)).size, res.faults.length, 'не больше одной поломки на устройство');
  assert.ok(res.tests.length >= 5);
  assert.ok(res.faults.every((f) => f.text && f.fix));
  // тот же seed — те же поломки
  assert.deepEqual(D().breakNetwork(net, { count: 3, seed: 7 }).faults, res.faults);

  const A = NL.activity;
  const task = A.build({ title: 'Поиск неисправностей', tests: res.tests, faults: res.faults, items: [], locks: { add: true, diag: true }, feedback: 'full' });
  assert.deepEqual(task.locks, ['add', 'diag']);
  assert.doesNotMatch(JSON.stringify(task), /неверн|удалён|shutdown/, 'ответы спрятаны');
  const broken = A.check(res.net, task);
  assert.ok(broken.percent < 100, 'в сломанной сети проверка не проходит');
  assert.deepEqual(broken.faults, res.faults.map((f) => ({ dev: f.dev, text: f.text, fix: f.fix })));
  assert.equal(A.check(net, task).percent >= 99, true, 'исправная сеть проходит все проверки');

  // только одна категория
  const l2 = D().breakNetwork(net, { count: 2, kinds: ['l2'], seed: 3 });
  assert.ok(l2.faults.every((f) => f.cat === 'l2'));
  assert.throws(() => D().breakNetwork(mkNet(), {}), /два компьютера/);
});
