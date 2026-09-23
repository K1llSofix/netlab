// IP-телефония: CME, IP-телефоны 7960, IP Communicator, voice VLAN, PoE.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, run } = require('./helpers');

const U = NL.util;

const CME = ['telephony-service', 'max-ephones 5', 'max-dn 5', 'ip source-address 10.0.0.1 port 2000', 'auto assign 1 to 5', 'exit',
  'ephone-dn 1', 'number 1001', 'exit', 'ephone-dn 2', 'number 1002', 'exit', 'ephone-dn 3', 'number 1003', 'end'];

function phone(net, name, sw, port) {
  const p = net.addDevice('ipphone', { name });
  link(net, p, sw, 0, port);
  return p;
}

test('CME: регистрация телефонов, вызов, разговор по RTP напрямую, занято, IP Communicator', () => {
  const net = mkNet();
  net.recording = true;
  const r = net.addDevice('router', { name: 'CME' });
  const sw = net.addDevice('switch', { name: 'SW' });
  routerIf(r, 0, '10.0.0.1/24');
  link(net, r, sw, 0);
  cli(r, ['enable', 'conf t', 'ip dhcp excluded-address 10.0.0.1 10.0.0.9', 'ip dhcp pool VOICE', 'network 10.0.0.0 255.255.255.0',
    'default-router 10.0.0.1', 'option 150 ip 10.0.0.1', 'exit'].concat(CME));
  const p1 = phone(net, 'Phone1', sw);
  const p2 = phone(net, 'Phone2', sw);
  net.runUntilIdle();
  assert.equal(p1.power, false, 'без адаптера и PoE телефон выключен');
  p1.setAdapter(true);
  net.runUntilIdle();
  p2.setAdapter(true);
  net.runUntilIdle();
  assert.equal(p1.sccp.state, 'registered', p1.sccp.text);
  assert.equal(p2.sccp.state, 'registered', p2.sccp.text);
  assert.equal(p1.sccp.number, '1001');
  assert.equal(p2.sccp.number, '1002');
  assert.ok(U.sameNet(p1.iface.ip, U.parseIp('10.0.0.0'), U.maskFromPrefix(24)));

  // неизвестный номер
  assert.equal(p1.sccp.dial('5555'), null);
  net.runUntilIdle();
  assert.equal(p1.sccp.call, null);
  assert.match(p1.sccp.text, /не существует/);

  // вызов и ответ
  const log = [];
  const off = net.on((t, e) => { if (t === 'log' && e.type === 'tx') log.push(e); });
  p1.sccp.dial('1002');
  net.runUntilIdle();
  assert.equal(p1.sccp.call.state, 'ringback');
  assert.equal(p2.sccp.call.state, 'ringing');
  assert.equal(p2.sccp.call.peer, '1001');
  p2.sccp.answer();
  net.runUntilIdle();
  assert.equal(p1.sccp.call.state, 'connected');
  assert.equal(p2.sccp.call.state, 'connected');
  assert.ok(p2.sccp.heard.some((h) => h.text === 'Алло!'));
  p1.sccp.say('Привет из 1001');
  net.runUntilIdle();
  off();
  assert.ok(p2.sccp.heard.some((h) => h.text === 'Привет из 1001'));
  const rtp = log.filter((e) => e.proto === 'RTP');
  assert.ok(rtp.length >= 3, 'голосовые пакеты RTP');
  assert.ok(rtp.every((e) => e.from !== r.id && e.to !== r.id), 'RTP идёт между телефонами, минуя CME');
  assert.ok(log.some((e) => e.proto === 'SCCP'));

  let out = cli(r, ['enable', 'show ephone', 'show ephone-dn', 'show running-config']).text;
  assert.equal((out.match(/REGISTERED in SCCP/g) || []).length, 2);
  assert.match(out, /number 1001 CH1\s+CONNECTED/);
  assert.match(out, /^ephone 1$/m);
  assert.match(out, /^ button 1:1$/m);
  assert.match(out, /^ auto assign 1 to 5$/m);
  assert.match(out, /^ option 150 ip 10\.0\.0\.1$/m);

  // IP Communicator на ПК получает 1003 и попадает на занятого абонента
  const host = pc(net, 'PC', '10.0.0.50/24', '10.0.0.1');
  link(net, host, sw);
  net.runUntilIdle();
  host.ipcStart(U.parseIp('10.0.0.1'));
  net.runUntilIdle();
  assert.equal(host.softphone.state, 'registered', host.softphone.text);
  assert.equal(host.softphone.number, '1003');
  host.softphone.dial('1001');
  net.runUntilIdle();
  assert.match(host.softphone.text, /занят/);
  // положили трубку — второй абонент получает отбой, звоним снова
  p1.sccp.hangup();
  net.runUntilIdle();
  assert.equal(p2.sccp.call, null);
  host.softphone.dial('1001');
  net.runUntilIdle();
  p1.sccp.answer();
  net.runUntilIdle();
  assert.equal(host.softphone.call.state, 'connected');
  assert.ok(host.softphone.heard.some((h) => h.text === 'Алло!'));
  host.softphone.hangup();
  net.runUntilIdle();

  // max-ephones: четвёртому телефону отказано
  cli(r, ['enable', 'conf t', 'telephony-service', 'max-ephones 3', 'end']);
  const p4 = phone(net, 'Phone4', sw);
  p4.setAdapter(true);
  net.runUntilIdle(3000);
  assert.equal(p4.sccp.state, 'failed');
  assert.match(p4.sccp.text, /max-ephones 3/);

  // сохранение: после загрузки телефоны снова регистрируются
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle(3000);
  assert.equal(n2.findByName('Phone1').sccp.state, 'registered', n2.findByName('Phone1').sccp.text + ' ip=' + U.ipStr(n2.findByName('Phone1').iface.ip) + ' dhcp=' + JSON.stringify(n2.findByName('Phone1').dhcpc && n2.findByName('Phone1').dhcpc.phase));
  assert.equal(n2.findByName('Phone1').sccp.number, '1001');
  out = cli(n2.findByName('CME'), ['enable', 'show running-config']).text;
  assert.match(out, /^ephone-dn 3$/m);
  assert.match(out, /^ max-ephones 3$/m);
});

test('PoE 3560-24PS, voice VLAN: телефон в голосовом VLAN, компьютер за телефоном — в VLAN данных', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'CME' });
  const sw = net.addDevice('switch', { name: 'SW', model: '3560-24PS' });
  const cheap = net.addDevice('switch', { name: 'SW2' });
  link(net, r, sw, 0, sw.portIndex('GigabitEthernet0/1'));
  link(net, r, cheap, 1, cheap.portIndex('FastEthernet0/1'));
  cli(r, ['enable', 'conf t', 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface g0/0.10', 'encapsulation dot1Q 10', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip dhcp excluded-address 10.0.0.1', 'ip dhcp excluded-address 192.168.1.1',
    'ip dhcp pool DATA', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'exit',
    'ip dhcp pool VOICE', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1', 'option 150 ip 10.0.0.1', 'exit'].concat(CME));
  cli(sw, ['enable', 'conf t', 'interface g0/1', 'switchport trunk encapsulation dot1q', 'switchport mode trunk', 'exit',
    'interface range fa0/1 - 2', 'switchport mode access', 'switchport voice vlan 10', 'mls qos trust cos', 'end']);
  const ph = phone(net, 'Phone', sw, sw.portIndex('FastEthernet0/1'));
  const host = net.addDevice('pc', { name: 'PC' });
  link(net, host, ph, undefined, 1);
  host.setDhcp();
  net.runUntilIdle();
  assert.equal(ph.powerSource(), 'poe');
  assert.equal(ph.voiceVlan, 10);
  assert.equal(ph.sccp.state, 'registered', ph.sccp.text);
  assert.ok(U.sameNet(ph.iface.ip, U.parseIp('10.0.0.0'), U.maskFromPrefix(24)), 'телефон — в голосовом VLAN: ' + U.ipStr(ph.iface.ip));
  assert.ok(U.sameNet(host.iface.ip, U.parseIp('192.168.1.0'), U.maskFromPrefix(24)), 'ПК за телефоном — в VLAN данных: ' + U.ipStr(host.iface.ip));
  let out = cli(sw, ['enable', 'show power inline', 'show running-config']).text;
  assert.match(out, /Fa0\/1\s+auto\s+on\s+6\.3\s+IP Phone 7960/);
  assert.match(out, /^ switchport voice vlan 10$/m);
  // телефон на обычном 2960 без адаптера не включается
  const ph2 = phone(net, 'Phone2', cheap, cheap.portIndex('FastEthernet0/2'));
  net.runUntilIdle();
  assert.equal(ph2.power, false);
  out = cli(cheap, ['enable', 'conf t', 'interface fa0/2', 'power inline never', 'end']).text;
  assert.match(out, /не поддерживает PoE/);
  // отключили PoE на порту — телефон гаснет
  cli(sw, ['enable', 'conf t', 'interface fa0/1', 'power inline never', 'end']);
  assert.equal(ph.power, false);
  assert.equal(ph.sccp.state, 'off');
  cli(sw, ['enable', 'conf t', 'interface fa0/1', 'no power inline never', 'end']);
  net.runUntilIdle();
  assert.equal(ph.sccp.state, 'registered', ph.sccp.text);
});
