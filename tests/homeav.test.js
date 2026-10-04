// ATA и аналоговый телефон (регистрация в CME, вызов), коаксиальный разветвитель и ТВ, кабельный модем за разветвителем.
const test = require('node:test');
const { NL, assert, mkNet, routerIf, link, cli } = require('./helpers');

const CME = ['telephony-service', 'max-ephones 5', 'max-dn 5', 'ip source-address 10.0.0.1 port 2000', 'auto assign 1 to 5', 'exit',
  'ephone-dn 1', 'number 1001', 'exit', 'ephone-dn 2', 'number 1002', 'end'];

test('ATA + аналоговый телефон: регистрация в CME и звонок на IP-телефон', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'CME' });
  const sw = net.addDevice('switch', { name: 'SW' });
  routerIf(r, 0, '10.0.0.1/24');
  link(net, r, sw, 0);
  cli(r, ['enable', 'conf t', 'ip dhcp excluded-address 10.0.0.1 10.0.0.9', 'ip dhcp pool VOICE', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1', 'option 150 ip 10.0.0.1', 'exit'].concat(CME));
  const ata = net.addDevice('ata', { name: 'ATA' });
  const ph = net.addDevice('aphone', { name: 'Phone' });
  const ip = net.addDevice('ipphone', { name: 'IPPhone' });
  link(net, ata, sw, 0);
  link(net, ip, sw, 0);
  assert.equal(ph.lineText(), 'Нет линии: подключите телефонный кабель к порту Phone 1 адаптера ATA');
  const l = link(net, ph, ata, 0, 1);
  assert.equal(l.cable, 'phone');
  ip.setAdapter(true);
  net.runUntilIdle();
  assert.equal(ata.power, true, 'у ATA свой блок питания');
  assert.equal(ata.sccp.state, 'registered', ata.sccp.text);
  assert.match(ph.lineText(), /^Линия готова, номер 10\d\d$/);
  const other = ip.sccp.number;
  ph.sccp.dial(other);
  net.runUntilIdle();
  assert.equal(ip.sccp.call && ip.sccp.call.state, 'ringing');
  ip.sccp.answer();
  net.runUntilIdle();
  assert.equal(ph.sccp.call.state, 'connected');
  ph.sccp.hangup();
  net.runUntilIdle();
  assert.equal(ip.sccp.call, null);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(n2.findByName('ATA').type, 'ata');
  assert.equal(n2.findByName('Phone').ata().name, 'ATA');
});

test('Кабельное ТВ через разветвитель; кабельный модем за тем же разветвителем получает интернет', () => {
  const net = mkNet();
  const cloud = net.addDevice('cloud', { name: 'ISP' });
  const sp = net.addDevice('splitter', { name: 'Splitter' });
  const tv = net.addDevice('tv', { name: 'TV' });
  const modem = net.addDevice('modem', { name: 'Modem', model: 'Cable-Modem-PT' });
  const tv2 = net.addDevice('tv', { name: 'TV2' });
  assert.equal(tv.signal(), false);
  link(net, cloud, sp, cloud.portIndex('Coaxial'), 0);
  link(net, sp, tv, 1, 0);
  link(net, sp, modem, 2, 0);
  assert.equal(tv.signal(), true, 'сигнал через разветвитель');
  assert.equal(tv2.signal(), false);
  tv.setChannel(3);
  assert.equal(tv.channelName(), 'Кабель-ТВ');
  // интернет: маршрутизатор провайдера за облаком, ПК за модемом
  const isp = net.addDevice('router', { name: 'ISP-R' });
  routerIf(isp, 0, '203.0.113.1/24');
  link(net, isp, cloud, 0, cloud.portIndex('Ethernet'));
  const pcA = net.addDevice('pc', { name: 'Home' });
  pcA.setStatic(NL.util.parseIp('203.0.113.10'), NL.util.maskFromPrefix(24), NL.util.parseIp('203.0.113.1'), null);
  link(net, pcA, modem, 0, 1);
  net.runUntilIdle();
  let done = null;
  pcA.ping('203.0.113.1', { count: 2, onEvent: (e) => { if (e.type === 'done') done = e; } });
  net.runUntilIdle();
  assert.equal(done.received, 2, 'данные проходят через разветвитель');
  cloud.setPower ? cloud.setPower(false) : (cloud.power = false);
  assert.equal(tv.signal(), false);
});
