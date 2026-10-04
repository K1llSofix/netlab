// Реалистичные таймеры: STP listening/learning, PortFast, rapid-pvst, сходимость OSPF, сохранение.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

function reach(net, a, ip) {
  let done = null;
  a.ping(ip, { count: 1, onEvent: (e) => { if (e.type === 'done') done = e; } });
  net.run(300);
  return !!(done && done.received);
}
const stState = (sw, port) => {
  const s = NL.cli.createSession(sw);
  const out = [];
  const io = { out: (l) => out.push(l), write() {}, clear() {}, done() {}, mutate: (fn) => fn() };
  for (const l of ['enable', 'show spanning-tree']) NL.cli.exec(sw, s, l, io);
  const line = out.find((l) => l.startsWith(port));
  return line ? line.split(/\s+/)[2] : null;
};

test('Реалистичные таймеры: STP 802.1D (30 с), PortFast сразу, rapid-pvst ~3 с', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  const c = pc(net, 'C', '10.0.0.3/24');
  NL.timers.set(net, true);
  link(net, a, sw, 0, 0);
  link(net, b, sw, 0, 1);
  net.run(10);
  assert.equal(stState(sw, 'Fa0/1'), 'LIS');
  assert.equal(reach(net, a, '10.0.0.2'), false, 'пока listening — связи нет');
  const res = NL.diag.explain(net, a.id, '10.0.0.2');
  assert.match(res.issues.map((x) => x.text).join('\n'), /Идёт сходимость STP: .*SW Fa0\/1/, 'диагностика предупреждает о переходных состояниях');
  net.run(1500);
  assert.equal(stState(sw, 'Fa0/1'), 'LRN');
  net.run(1300);
  assert.equal(stState(sw, 'Fa0/1'), 'FWD');
  assert.equal(reach(net, a, '10.0.0.2'), true, 'через 30 с — связь есть');
  // PortFast
  NL.cli.exec(sw, (() => { const s = NL.cli.createSession(sw); const io = { out() {}, write() {}, clear() {}, done() {}, mutate: (fn) => fn() }; for (const l of ['enable', 'conf t', 'interface fa0/3', 'spanning-tree portfast', 'end']) NL.cli.exec(sw, s, l, io); return s; })(), '', { out() {} });
  link(net, c, sw, 0, 2);
  net.run(5);
  assert.equal(stState(sw, 'Fa0/3'), 'FWD', 'PortFast — сразу forwarding');
  assert.equal(reach(net, c, '10.0.0.1'), true);
  // rapid-pvst
  const s2 = NL.cli.createSession(sw);
  for (const l of ['enable', 'conf t', 'spanning-tree mode rapid-pvst', 'interface fa0/2', 'shutdown', 'no shutdown', 'end']) NL.cli.exec(sw, s2, l, { out() {}, write() {}, clear() {}, done() {}, mutate: (fn) => fn() });
  net.run(5);
  assert.equal(stState(sw, 'Fa0/2'), 'LRN');
  net.run(320);
  assert.equal(stState(sw, 'Fa0/2'), 'FWD');
  // выключение режима — мгновенно; сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(n2.realTimers, true);
  NL.timers.set(net, false);
  assert.equal(stState(sw, 'Fa0/1'), 'FWD');
});

test('Реалистичные таймеры: маршруты OSPF появляются через несколько секунд', () => {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  routerIf(r1, 0, '10.0.12.1/30');
  routerIf(r2, 0, '10.0.12.2/30');
  routerIf(r2, 1, '192.168.2.1/24');
  link(net, r1, r2, 0, 0);
  link(net, pc(net, 'LAN', '192.168.2.10/24', '192.168.2.1'), r2, 0, 1);
  net.runUntilIdle();
  NL.timers.set(net, true);
  net.run(10);
  const cfg = (r, lines) => { const s = NL.cli.createSession(r); for (const l of lines) NL.cli.exec(r, s, l, { out() {}, write() {}, clear() {}, done() {}, mutate: (fn) => fn() }); };
  cfg(r1, ['enable', 'conf t', 'router ospf 1', 'network 10.0.12.0 0.0.0.3 area 0', 'end']);
  cfg(r2, ['enable', 'conf t', 'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0', 'end']);
  net.run(50);
  const has = () => !!r1.lookup(NL.util.parseIp('192.168.2.10'));
  void cli;
  assert.equal(has(), false, 'сразу после настройки маршрута ещё нет');
  net.run(600);
  assert.equal(has(), true, 'через ~5 с OSPF сошёлся');
});
