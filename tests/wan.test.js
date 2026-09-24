// WAN: DSL- и кабельный модемы через облако провайдера, вышка 3G/4G, модели 1841 / 4331 / 3650, модуль HWIC-4ESW.
const test = require('node:test');
const { NL, U, assert, mkNet, host, pc, routerIf, link, cli, ping } = require('./helpers');

const ip = (s) => U.parseIp(s);
/** Модули ставятся при выключенном питании, как в Packet Tracer. */
function withModule(net, dev, slot, mod) { net.setPower(dev, false); net.setModule(dev, slot, mod); net.setPower(dev, true); }

/** Провайдер: маршрутизатор ISP с DHCP для абонентов, за ним облако Cloud-PT (порт Ethernet). */
function provider() {
  const net = mkNet();
  const isp = net.addDevice('router', { name: 'ISP' });
  const cloud = net.addDevice('cloud', { name: 'Cloud' });
  const web = host(net, 'server', 'Web', '198.51.100.10/24', '198.51.100.1');
  routerIf(isp, 0, '203.0.113.1/24');
  routerIf(isp, 1, '198.51.100.1/24');
  link(net, isp, cloud, 0, cloud.portIndex('Ethernet'));
  link(net, web, isp, 0, 1);
  cli(isp, ['enable', 'conf t', 'ip dhcp excluded-address 203.0.113.1', 'ip dhcp pool SUBS', 'network 203.0.113.0 255.255.255.0', 'default-router 203.0.113.1', 'end']);
  return { net, isp, cloud, web };
}

test('DSL-модем: ПК получает адрес провайдера по телефонной линии; кабельный модем и WRT300N', () => {
  const { net, cloud } = provider();
  const dsl = net.addDevice('modem', { name: 'DSL', model: 'DSL-Modem-PT' });
  const a = net.addDevice('pc', { name: 'Home' });
  const l1 = net.connect(dsl.id, 0, cloud.id, cloud.portIndex('DSL'));
  assert.equal(l1.cable, 'phone', 'модем ↔ облако — телефонный кабель');
  const l2 = link(net, a, dsl, 0, 1);
  assert.equal(l2.cable, 'straight');
  a.setDhcp();
  net.runUntilIdle();
  assert.ok(U.ipStr(a.iface.ip).startsWith('203.0.113.'), 'адрес от провайдера: ' + U.ipStr(a.iface.ip));
  assert.equal(ping(net, a, '198.51.100.10', { count: 2 }).replies.length, 2);
  // кабельный модем: коаксиальный кабель к облаку, за модемом — домашний роутер
  const cm = net.addDevice('modem', { name: 'CM', model: 'Cable-Modem-PT' });
  const l3 = net.connect(cm.id, 0, cloud.id, cloud.portIndex('Coaxial'));
  assert.equal(l3.cable, 'coaxial');
  const wrt = net.addDevice('wrouter', { name: 'WRT' });
  link(net, wrt, cm, wrt.portIndex('Internet'), 1);
  wrt.startDhcp(wrt.wanIface);
  net.runUntilIdle();
  assert.ok(U.ipStr(wrt.wanIface.ip).startsWith('203.0.113.'), 'WAN роутера получен через кабельную сеть');
  // коаксиальный кабель подходит только к коаксиальным портам
  assert.throws(() => net.connect(cm.id, 1, cloud.id, cloud.portIndex('Coaxial'), 'coaxial'));
  // номера телефонной сети не назначаются портам провайдера
  assert.equal(cloud.numberOf(cloud.portIndex('DSL')), '');
});

test('Вышка 3G/4G: смартфон без Wi-Fi получает адрес через сотовую сеть; вне зоны — нет связи; Wi-Fi важнее', () => {
  const { net, isp } = provider();
  const tower = net.addDevice('celltower', { name: 'Tower', x: 0, y: 0 });
  const sw = net.addDevice('switch', { name: 'SW' });
  routerIf(isp, 2, '10.64.0.1/16');
  cli(isp, ['enable', 'conf t', 'ip dhcp pool MOBILE', 'network 10.64.0.0 255.255.0.0', 'default-router 10.64.0.1', 'end']);
  link(net, isp, sw, 2, 0); link(net, tower, sw, 0, 1);
  const phone = net.addDevice('smartphone', { name: 'Phone', x: 600, y: 300 });
  assert.equal(phone.cellular, true, '3G/4G включён по умолчанию');
  phone.setDhcp();
  net.runUntilIdle();
  assert.equal(net.wirelessStatus(phone).ap, tower);
  assert.ok(U.ipStr(phone.iface.ip).startsWith('10.64.'), U.ipStr(phone.iface.ip));
  assert.equal(ping(net, phone, '198.51.100.10', { count: 2 }).replies.length, 2);
  assert.deepEqual(net.scanWifi(phone).map((x) => x.ssid), [], 'вышка не видна как Wi-Fi-сеть');
  // вне зоны покрытия
  phone.x = 5000;
  net.refreshTopology();
  assert.equal(net.wirelessStatus(phone).ap, null);
  assert.match(net.wirelessStatus(phone).reason, /Нет сети 3G\/4G/);
  // Wi-Fi рядом — предпочтительнее вышки
  phone.x = 600;
  const ap = net.addDevice('ap', { name: 'AP', x: 620, y: 320 });
  link(net, ap, sw, 0, 2);
  ap.setWifi({ ssid: 'Cafe', security: 'open' });
  phone.setWifi({ ssid: 'Cafe', security: 'open' });
  assert.equal(net.wirelessStatus(phone).ap, ap);
  // 3G/4G выключен, Wi-Fi далеко — связи нет; сохранение флага
  phone.setCellular(false);
  phone.x = 3000;
  net.refreshTopology();
  assert.equal(net.wirelessStatus(phone).ap, null);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(n2.findByName('Phone').cellular, false);
});

test('Модели 1841 и ISR 4331: Serial через HWIC-2T и NIM-2T; Catalyst 3650 — имена портов', () => {
  const net = mkNet();
  const a = net.addDevice('router', { name: 'R1841', model: '1841' });
  const b = net.addDevice('router', { name: 'R4331', model: '4331' });
  withModule(net, a, 'hwic0', 'HWIC-2T');
  withModule(net, b, 'nim1', 'NIM-2T');
  assert.deepEqual(a.ports.filter((p) => p.media !== 'console').map((p) => p.name), ['FastEthernet0/0', 'FastEthernet0/1', 'Serial0/0/0', 'Serial0/0/1']);
  assert.deepEqual(b.ports.filter((p) => p.media !== 'console').map((p) => p.name), ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'Serial0/1/0', 'Serial0/1/1']);
  net.connect(a.id, a.portIndex('Serial0/0/0'), b.id, b.portIndex('Serial0/1/0'), 'serial-dce');
  cli(a, ['enable', 'conf t', 'interface s0/0/0', 'ip address 10.0.0.1 255.255.255.252', 'clock rate 64000', 'no shutdown', 'end']);
  cli(b, ['enable', 'conf t', 'interface s0/1/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'interface g0/0/1', 'ip address 172.16.0.1 255.255.255.0', 'end']);
  net.runUntilIdle();
  assert.equal(ping(net, a, '10.0.0.2', { count: 2 }).replies.length, 2);
  assert.match(cli(b, ['enable', 'show ip interface brief']).text, /GigabitEthernet0\/0\/1\s+172\.16\.0\.1/);
  const sw = net.addDevice('switch', { name: 'SW3650', model: '3650-24PS' });
  assert.ok(sw.l3);
  assert.equal(sw.ports[0].name, 'GigabitEthernet1/0/1');
  assert.equal(sw.ports[24].name, 'GigabitEthernet1/1/1');
  const out = cli(sw, ['enable', 'conf t', 'vlan 20', 'exit', 'interface g1/0/5', 'switchport mode access', 'switchport access vlan 20', 'end', 'show vlan brief']).text;
  assert.match(out, /20\s+VLAN0020\s+active\s+Gi1\/0\/5/);
});

test('HWIC-4ESW: порты встроенного коммутатора в VLAN, interface vlan на маршрутизаторе, маршрутизация между VLAN', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1', model: '1841' });
  withModule(net, r, 'hwic1', 'HWIC-4ESW');
  const names = r.ports.map((p) => p.name);
  assert.ok(names.includes('FastEthernet0/1/0') && names.includes('FastEthernet0/1/3'));
  assert.ok(!r.ifaces.some((f) => f.name === 'FastEthernet0/1/0'), 'у портов коммутатора нет IP-интерфейса');
  const a = pc(net, 'A', '192.168.1.10/24', '192.168.1.1');
  const b = pc(net, 'B', '192.168.10.10/24', '192.168.10.1');
  const c = pc(net, 'C', '192.168.1.11/24', '192.168.1.1');
  link(net, a, r, 0, r.portIndex('FastEthernet0/1/0'));
  link(net, b, r, 0, r.portIndex('FastEthernet0/1/1'));
  link(net, c, r, 0, r.portIndex('FastEthernet0/1/2'));
  let out = cli(r, ['enable', 'conf t', 'interface fa0/1/1', 'switchport access vlan 10', 'interface vlan 1', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown',
    'interface vlan 10', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'interface fa0/1/0', 'ip address 1.1.1.1 255.0.0.0', 'end']).text;
  assert.match(out, /порт встроенного коммутатора/);
  net.runUntilIdle();
  assert.equal(ping(net, a, '192.168.1.11', { count: 2 }).replies.length, 2, 'внутри VLAN 1 — коммутация во встроенном коммутаторе');
  assert.equal(ping(net, a, '192.168.10.10', { count: 2 }).replies.length, 2, 'между VLAN — маршрутизация через interface vlan');
  out = cli(r, ['enable', 'show vlan-switch', 'show ip interface brief', 'show running-config']).text;
  assert.match(out, /1\s+default\s+active\s+Fa0\/1\/0, Fa0\/1\/2, Fa0\/1\/3/);
  assert.match(out, /10\s+VLAN0010\s+active\s+Fa0\/1\/1/);
  assert.match(out, /Vlan10\s+192\.168\.10\.1/);
  assert.match(out, /interface FastEthernet0\/1\/1\n switchport access vlan 10\n!/);
  assert.match(out, /interface Vlan1\n ip address 192\.168\.1\.1 255\.255\.255\.0/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(ping(n2, n2.findByName('A'), '192.168.10.10', { count: 2 }).replies.length, 2);
});
