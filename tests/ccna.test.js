// Команды CCNA 200-301: show interfaces (описания, счётчики, L2-порт), новая запись команд, archive, mtu, статические MAC, dir.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

test('CCNA: show-команды маршрутизатора и коммутатора, новая запись команд, сохранение', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch', { name: 'SW1' });
  routerIf(r, 0, '192.168.1.1/24');
  link(net, r, sw, 0, 0);
  const a = pc(net, 'A', '192.168.1.10/24', '192.168.1.1');
  link(net, a, sw, 0, 1);
  net.runUntilIdle();
  cli(r, ['enable', 'conf t', 'interface g0/0', 'description LAN', 'mtu 1400', 'exit', 'ip domain name lab.local', 'ip domain lookup', 'banner login #Только для персонала#',
    'enable algorithm-type scrypt secret Cisco123', 'username admin algorithm-type sha256 secret Pa55', 'archive', 'path flash:backup', 'write-memory', 'exit', 'boot system flash:c2900.bin', 'config-register 0x2142',
    'line vty 0 4', 'logging synchronous', 'exit', 'hostname EDGE', 'router ospf 1', 'maximum-paths 4', 'end']);
  assert.equal(r.ios.hostname, 'EDGE', '«logging synchronous» в line не выкидывает из режима config');
  cli(r, ['enable', 'Cisco123', 'ping 192.168.1.10']);
  let out = cli(r, ['enable', 'Cisco123', 'show interfaces description', 'show interfaces g0/0 counters', 'show running-config', 'show boot', 'show archive', 'dir', 'show inventory', 'show license']).text;
  assert.match(out, /^Gi0\/0\s+up\s+up\s+LAN$/m);
  assert.match(out, /^Gi0\/0\s+\d+\s+[1-9]\d*/m, 'счётчики входящих пакетов');
  assert.match(out, /^ip domain-name lab\.local$/m);
  assert.match(out, /^ mtu 1400$/m);
  assert.match(out, /^banner login \^CТолько для персонала\^C$/m);
  assert.match(out, /^archive\n path flash:backup\n write-memory$/m);
  assert.match(out, /^boot system flash:c2900\.bin$/m);
  assert.match(out, /^config-register 0x2142$/m);
  assert.match(out, /^username admin secret/m);
  assert.match(out, /^enable secret/m);
  assert.match(out, /Configuration register is 0x2142/);
  assert.match(out, /Directory of flash:\/\n\n\s+1\s+-rw-\s+\d+\s+<no date>\s+c2900/);
  assert.match(out, /PID: CISCO\d+\/K9/);
  assert.match(out, /License State: Active, In Use/);
  assert.match(cli(r, ['enable', 'Cisco123', 'clear counters', 'show interfaces g0/0 counters']).text, /^Gi0\/0\s+0\s+0/m);

  out = cli(sw, ['enable', 'conf t', 'interface fa0/2', 'description PC-A', 'exit', 'mac address-table static 0000.1111.2222 vlan 1 interface fa0/5', 'mac address-table aging-time 600', 'sdm prefer lanbase-routing', 'end',
    'show interfaces fa0/2', 'show interfaces fa0/2 switchport', 'show interfaces description', 'show mac address-table', 'show running-config', 'show sdm prefer', 'show mac address-table aging-time']).text;
  assert.match(out, /^FastEthernet0\/2 is up, line protocol is up \(connected\)$/m);
  assert.match(out, /Description: PC-A/);
  assert.match(out, /^Name: Fa0\/2\nSwitchport: Enabled/m);
  assert.doesNotMatch(out, /^Name: Fa0\/3$/m, 'только выбранный порт');
  assert.match(out, /^Fa0\/2\s+up\s+up\s+PC-A$/m);
  assert.match(out, /^\s+1\s+0000\.1111\.2222\s+STATIC\s+Fa0\/5$/m);
  assert.match(out, /^mac address-table static 0000\.1111\.2222 vlan 1 interface FastEthernet0\/5$/m);
  assert.match(out, /On next reload, template will be "lanbase-routing"/);
  assert.match(out, /Global Aging Time:\s+600/);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.match(cli(n2.findByName('SW1'), ['enable', 'show mac address-table']).text, /0000\.1111\.2222\s+STATIC/);
  assert.match(cli(n2.findByName('R1'), ['enable', 'Cisco123', 'show running-config']).text, /^ mtu 1400$/m);
});
