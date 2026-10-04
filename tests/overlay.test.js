// Наглядные слои: VLAN и транки, STP, области OSPF, загрузка каналов.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

const O = () => NL.overlay;

test('Слой VLAN: access по цвету VLAN, транк, несовпадение; слой STP: корень и блокировка', () => {
  const net = mkNet();
  const s1 = net.addDevice('switch', { name: 'S1' });
  const s2 = net.addDevice('switch', { name: 'S2' });
  const s3 = net.addDevice('switch', { name: 'S3' });
  const a = pc(net, 'A', '10.0.10.1/24');
  const b = pc(net, 'B', '10.0.10.2/24');
  const la = link(net, a, s1, 0, 0);
  const lb = link(net, b, s2, 0, 0);
  const t12 = link(net, s1, s2, 24, 24);
  const t23 = link(net, s2, s3, 23, 24);
  const t31 = link(net, s3, s1, 23, 23);
  for (const s of [s1, s2]) cli(s, ['enable', 'conf t', 'vlan 10', 'name USERS', 'exit', 'interface fa0/1', 'switchport access vlan 10', 'interface g0/1', 'switchport mode trunk', 'end']);
  cli(s1, ['enable', 'conf t', 'spanning-tree vlan 1 priority 4096', 'end']);
  net.runUntilIdle();
  let r = O().compute(net, 'vlan');
  assert.equal(r.links.get(la.id).label, 'VLAN 10');
  assert.equal(r.links.get(la.id).color, O().vlanColor(10));
  assert.match(r.links.get(la.id).title, /USERS/);
  assert.equal(r.links.get(t12.id).dash, '9 4');
  assert.match(r.links.get(t12.id).label, /^транк/);
  assert.ok(r.legend.some((x) => x.text === 'VLAN 10') && r.legend.some((x) => x.text === 'Транк'));
  cli(s2, ['enable', 'conf t', 'interface fa0/1', 'switchport access vlan 20', 'end']);
  r = O().compute(net, 'vlan');
  assert.equal(r.links.get(lb.id).label, 'VLAN 20');
  cli(s3, ['enable', 'conf t', 'interface g0/1', 'switchport mode access', 'end']);
  cli(s2, ['enable', 'conf t', 'interface fa0/24', 'switchport mode trunk', 'end']);
  r = O().compute(net, 'vlan');
  assert.equal(r.links.get(t23.id).color, '#ef4444', 'транк ↔ access');

  r = O().compute(net, 'stp');
  assert.equal(r.devs.get(s1.id).badge, '★ Root');
  assert.match(r.devs.get(s2.id).badge, /^cost \d+/);
  const blocked = [t12, t23, t31].filter((l) => r.links.get(l.id) && r.links.get(l.id).dash);
  assert.equal(blocked.length, 1, 'в треугольнике один кабель заблокирован');
  assert.match(r.links.get(blocked[0].id).title, /заблокирован STP/);
  assert.ok(r.legend.some((x) => x.text === 'заблокировано'));
});

test('Слой OSPF: области, ABR, несовпадение области; слой загрузки', () => {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  const r3 = net.addDevice('router', { name: 'R3' });
  routerIf(r1, 0, '10.0.12.1/30');
  routerIf(r2, 0, '10.0.12.2/30');
  routerIf(r2, 1, '10.0.23.1/30');
  routerIf(r3, 1, '10.0.23.2/30');
  const l12 = link(net, r1, r2, 0, 0);
  const l23 = link(net, r2, r3, 1, 1);
  cli(r1, ['enable', 'conf t', 'router ospf 1', 'network 10.0.12.0 0.0.0.3 area 0', 'end']);
  cli(r2, ['enable', 'conf t', 'router ospf 1', 'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 1', 'end']);
  cli(r3, ['enable', 'conf t', 'router ospf 1', 'network 10.0.23.0 0.0.0.3 area 2', 'end']);
  net.runUntilIdle();
  const r = O().compute(net, 'ospf');
  assert.equal(r.links.get(l12.id).label, 'area 0');
  assert.equal(r.links.get(l23.id).color, '#ef4444');
  assert.match(r.links.get(l23.id).label, /area 1 ≠ 2/);
  assert.equal(r.devs.get(r2.id).badge, 'ABR');
  assert.equal(r.devs.get(r1.id).badge, 'area 0');

  // загрузка: первый замер — база, после трафика — скорость
  const st = {};
  O().compute(net, 'load', st);
  const before = O().compute(net, 'load', st).links.get(l12.id);
  assert.equal(before.label, '');
  cli(r1, ['enable', 'ping 10.0.12.2']);
  const x = O().compute(net, 'load', st).links.get(l12.id);
  assert.match(x.label, /бит\/с/);
  assert.equal(x.color, '#16a34a');
});
