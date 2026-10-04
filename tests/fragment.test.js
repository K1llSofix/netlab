// Фрагменты схемы (шаблоны, копирование с кабелями) и поиск устройств.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping } = require('./helpers');

function lab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1', x: 300, y: 100 });
  const sw = net.addDevice('switch', { name: 'SW1', x: 300, y: 250 });
  routerIf(r, 0, '192.168.1.1/24');
  const a = pc(net, 'PC1', '192.168.1.10/24', '192.168.1.1');
  a.x = 200; a.y = 400;
  link(net, r, sw, 0, 0);
  link(net, a, sw, 0, 1);
  cli(sw, ['enable', 'conf t', 'vlan 10', 'name SALES', 'end']);
  cli(r, ['enable', 'conf t', 'hostname EDGE', 'end']);
  net.addNote(10, 10, 'Серверная, стойка 3');
  net.runUntilIdle();
  return { net, r, sw, a };
}

test('Фрагмент: устройства с настройками и кабелями, вставка в другую схему и повторно (без конфликта адресов)', () => {
  const { net, r, sw, a } = lab();
  const frag = NL.fragment.capture(net, [r.id, sw.id, a.id]);
  assert.equal(frag.devices.length, 3);
  assert.equal(frag.links.length, 2);
  const json = JSON.parse(JSON.stringify(frag));
  const n2 = mkNet();
  const ids = NL.fragment.insert(n2, json, 1000, 1000);
  assert.equal(ids.length, 3);
  assert.equal(n2.links.size, 2);
  const r2 = n2.findByName('R1');
  assert.equal(r2.ios.hostname, 'EDGE', 'настройки сохранились');
  assert.equal(r2.x, 1100);
  const a2 = n2.findByName('PC1');
  assert.equal(NL.util.ipStr(a2.iface.ip), '192.168.1.10');
  n2.runUntilIdle();
  assert.equal(ping(n2, a2, '192.168.1.1', { count: 2 }).replies.length, 2, 'вставленная сеть работает');
  // повторная вставка в ту же схему: новые имена, занятые адреса сброшены
  const ids2 = NL.fragment.insert(n2, json, 0, 0);
  const names = ids2.map((id) => n2.getDevice(id).name).sort();
  assert.deepEqual(names, ['PC2', 'R2', 'SW2']);
  assert.equal(n2.findByName('PC2').iface.ip, null);
  assert.equal(n2.links.size, 4);
  assert.equal(n2.findByName('SW2').vlans.get(10), 'SALES');
});

test('Поиск устройств: имя, модель, IP, MAC, имя VLAN, заметка', () => {
  const { net, a } = lab();
  const S = NL.search;
  assert.deepEqual(S.find(net, 'pc1').map((x) => x.name), ['PC1']);
  assert.ok(S.find(net, '2911').some((x) => x.name === 'R1'));
  assert.match(S.find(net, '192.168.1.1')[0].what, /192\.168\.1\.1\/24/);
  assert.equal(S.find(net, '192.168.1.1')[0].name, 'R1', 'точное совпадение адреса — первым');
  const mac = NL.util.ciscoMac(a.ports[a.iface.port].mac);
  assert.equal(S.find(net, mac)[0].name, 'PC1');
  assert.match(S.find(net, 'sales')[0].what, /VLAN 10 SALES/);
  assert.equal(S.find(net, 'стойка')[0].kind, 'note');
  assert.deepEqual(S.find(net, ''), []);
});
