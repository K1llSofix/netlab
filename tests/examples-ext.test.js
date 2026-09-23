// Новые примеры (IPv6, мониторинг, VPN, PPPoE, Dial-up, VoIP, Bluetooth, IoT, MCU, IOx) собираются и работают.
const test = require('node:test');
const path = require('path');
const { NL, assert, ping, run } = require('./helpers');

NL.ui = NL.ui || {};
require(path.join(__dirname, '..', 'js', 'ui', 'examples.js'));
require(path.join(__dirname, '..', 'js', 'ui', 'examples-ext.js'));

const U = NL.util;
const IDS = ['ipv6', 'snmp-netflow', 'gre', 'ipsec', 'pppoe', 'dialup', 'voip', 'bluetooth', 'smarthome', 'mcu', 'iox'];

function build(id) {
  const ex = NL.ui.EXAMPLES.find((e) => e.id === id);
  assert.ok(ex, 'нет примера ' + id);
  const net = ex.build();
  net.runUntilIdle(200000);
  return net;
}
const by = (net, n) => { const d = net.findByName(n); assert.ok(d, 'нет устройства ' + n); return d; };

test('новые примеры собираются, конфигурация сохранена, файл читается обратно', () => {
  for (const id of IDS) {
    const net = build(id);
    // CME сам дописывает в running-config автоматически зарегистрированные ephone — как настоящий
    for (const d of net.devices.values()) if (d.nvramDirty && !(id === 'voip' && d.name === 'CME')) assert.equal(d.nvramDirty(), false, id + ': ' + d.name + ' — конфигурация не сохранена');
    const again = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
    assert.equal(again.devices.size, net.devices.size, id);
    assert.equal(again.links.size, net.links.size, id);
  }
});

test('IPv6, мониторинг, GRE', () => {
  let net = build('ipv6');
  assert.equal(ping(net, by(net, 'PC-A'), '2001:DB8:2::10', { count: 2 }).replies.length, 2);
  net = build('snmp-netflow');
  const g = run(net, (cb) => by(net, 'Admin').snmpRequest(U.parseIp('192.168.1.1'), 'public', 'get', ['1.3.6.1.2.1.1.5.0'], cb));
  assert.equal(g.varbinds[0].value, 'R1');
  ping(net, by(net, 'User'), '192.168.2.100', { count: 3 });
  net.runUntilIdle(200000);
  assert.ok(by(net, 'Collector').collected.length > 0);
  net = build('gre');
  assert.equal(ping(net, by(net, 'PC-Office1'), '192.168.2.10', { count: 2 }).replies.length, 2);
});

test('IPsec и Easy VPN, PPPoE, Dial-up', () => {
  let net = build('ipsec');
  assert.ok(ping(net, by(net, 'PC-Office1'), '192.168.2.10', { count: 4 }).replies.length >= 3);
  const home = by(net, 'Home');
  assert.ok(run(net, (cb) => home.vpnConnect('10.0.2.1', 'STAFF', 'staff-key', 'anna', 'vpn123', cb)).ok);
  assert.equal(ping(net, home, '192.168.2.10', { count: 2 }).replies.length, 2);
  net = build('pppoe');
  const c1 = by(net, 'Client1');
  assert.ok(run(net, (cb) => c1.pppoeConnect('client1', 'pass1', cb)).ok);
  assert.equal(ping(net, c1, '203.0.113.10', { count: 2 }).replies.length, 2);
  net = build('dialup');
  const h = by(net, 'Home');
  assert.ok(run(net, (cb) => h.dial('5551001', 'guest', 'modem', cb)).ok);
  assert.equal(ping(net, h, '10.10.10.1', { count: 2 }).replies.length, 2);
});

test('IP-телефония, Bluetooth, умный дом, MCU, IOx', () => {
  let net = build('voip');
  assert.equal(by(net, 'Phone1').sccp.number, '1001');
  assert.equal(by(net, 'Phone2').sccp.number, '1002');
  assert.ok(U.sameNet(by(net, 'PC-behind-phone').iface.ip, U.parseIp('192.168.1.0'), U.maskFromPrefix(24)));
  const soft = by(net, 'Softphone-PC');
  soft.ipcStart(U.parseIp('10.10.10.1'));
  net.runUntilIdle(200000);
  assert.equal(soft.softphone.number, '1003', soft.softphone.text);

  net = build('bluetooth');
  assert.deepEqual(NL.bt.scan(by(net, 'Phone')).map((x) => x.dev.name).sort(), ['Headset', 'Laptop', 'Speaker']);

  net = build('smarthome');
  for (const n of ['Lamp', 'Fan', 'Door', 'Motion', 'Siren', 'Thermometer', 'Smoke']) assert.equal(by(net, n).iotRt.state, 'registered', n);
  by(net, 'Motion').thingSet('detected', true);
  by(net, 'Smoke').thingSet('level', 60);
  net.runUntilIdle(200000);
  assert.equal(by(net, 'Lamp').thing.state.level, 2);
  assert.equal(by(net, 'Siren').thing.state.on, true);
  assert.equal(by(net, 'Door').thing.state.open, true);

  net = build('mcu');
  const mcu = by(net, 'MCU');
  assert.equal(NL.iot.compAt(mcu, 'D1').name, 'Button');
  assert.match(mcu.program.code, /analogRead\(A0\)/);

  net = build('iox');
  const page = run(net, (cb) => by(net, 'Engineer').httpGet('http://192.168.10.2:8000', cb));
  assert.ok(page.ok, JSON.stringify(page));
  assert.match(page.body, /Датчики цеха/);
});
