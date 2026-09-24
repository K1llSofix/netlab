// Коммутация: PVST+ / Rapid PVST+, PortFast и BPDU Guard, DTP, VTP, EtherChannel.
const test = require('node:test');
const { NL, assert, mkNet, pc, link, cli, ping } = require('./helpers');

function triangle() {
  const net = mkNet();
  const s1 = net.addDevice('switch', { name: 'S1' });
  const s2 = net.addDevice('switch', { name: 'S2' });
  const s3 = net.addDevice('switch', { name: 'S3' });
  link(net, s1, s2, 22, 22);
  link(net, s2, s3, 23, 23);
  link(net, s1, s3, 24, 24);
  for (const s of [s1, s2, s3]) cli(s, ['enable', 'conf t', 'vlan 10', 'vlan 20', 'exit', 'interface fa0/23', 'switchport mode trunk', 'interface fa0/24', 'switchport mode trunk', 'interface g0/1', 'switchport mode trunk', 'end']);
  return { net, s1, s2, s3 };
}

const blockedPorts = (s, v) => s.ports.filter((p) => p.stpV && p.stpV[v] === 'blocking').map((p) => p.name);

test('PVST+: у каждого VLAN свой корень, блокируются разные порты, трафик ходит', () => {
  const { net, s1, s2, s3 } = triangle();
  cli(s1, ['enable', 'conf t', 'spanning-tree vlan 10 root primary', 'end']);
  cli(s2, ['enable', 'conf t', 'spanning-tree vlan 20 root primary', 'spanning-tree mode rapid-pvst', 'end']);
  assert.equal(s1.stpInfoV[10].isRoot, true);
  assert.equal(s2.stpInfoV[20].isRoot, true);
  assert.equal(s1.stpInfoV[20].isRoot, false);
  const b10 = [s1, s2, s3].flatMap((s) => blockedPorts(s, 10).map((n) => s.name + ' ' + n));
  const b20 = [s1, s2, s3].flatMap((s) => blockedPorts(s, 20).map((n) => s.name + ' ' + n));
  assert.equal(b10.length, 1, b10.join());
  assert.equal(b20.length, 1, b20.join());
  assert.notDeepEqual(b10, b20, 'в разных VLAN заблокированы разные порты');
  // компьютеры в VLAN 10 и 20 на S2 и S3 видят друг друга
  const a10 = pc(net, 'A10', '10.10.0.1/24');
  const b10pc = pc(net, 'B10', '10.10.0.2/24');
  const a20 = pc(net, 'A20', '10.20.0.1/24');
  const b20pc = pc(net, 'B20', '10.20.0.2/24');
  link(net, a10, s2, 0, 0);
  link(net, b10pc, s3, 0, 0);
  link(net, a20, s2, 0, 1);
  link(net, b20pc, s3, 0, 1);
  cli(s2, ['enable', 'conf t', 'interface fa0/1', 'switchport access vlan 10', 'interface fa0/2', 'switchport access vlan 20', 'end']);
  cli(s3, ['enable', 'conf t', 'interface fa0/1', 'switchport access vlan 10', 'interface fa0/2', 'switchport access vlan 20', 'end']);
  const r1 = ping(net, a10, '10.10.0.2', { count: 3 });
  assert.equal(r1.replies.length, 3);
  assert.equal(r1.done.received, 3, 'без дубликатов');
  assert.equal(ping(net, a20, '10.20.0.2', { count: 3 }).replies.length, 3);
  let out = cli(s1, ['enable', 'show spanning-tree vlan 10', 'show running-config']).text;
  assert.match(out, /VLAN0010[\s\S]*This bridge is the root/);
  assert.match(out, /Priority    24586  \(priority 24576 sys-id-ext 10\)/);
  assert.match(out, /^spanning-tree vlan 10 priority 24576$/m);
  out = cli(s2, ['enable', 'show spanning-tree vlan 20', 'show spanning-tree summary']).text;
  assert.match(out, /protocol rstp/);
  assert.match(out, /Root bridge for: VLAN0020/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(n2.findByName('S1').stpInfoV[10].isRoot, true);
  assert.equal(n2.findByName('S2').stpMode, 'rapid-pvst');
});

test('PortFast и BPDU Guard: коммутатор на порту — err-disabled', () => {
  const net = mkNet();
  const s1 = net.addDevice('switch', { name: 'S1' });
  const host = pc(net, 'PC', '10.0.0.1/24');
  link(net, host, s1, 0, 0);
  let out = cli(s1, ['enable', 'conf t', 'interface fa0/1', 'switchport mode access', 'spanning-tree portfast', 'spanning-tree bpduguard enable', 'end']).text;
  assert.match(out, /portfast should only be enabled/);
  net.runUntilIdle();
  assert.equal(s1.ports[0].errDisabled, false, 'компьютер BPDU не шлёт');
  out = cli(s1, ['enable', 'show spanning-tree']).text;
  assert.match(out, /Fa0\/1\s+Desg FWD 19\s+128\.1\s+P2p Edge/);
  // вместо компьютера — коммутатор
  net.disconnect(host.ports[host.iface.port].link);
  const rogue = net.addDevice('switch', { name: 'Rogue' });
  link(net, rogue, s1, 0, 0);
  net.runUntilIdle();
  assert.equal(s1.ports[0].errDisabled, true);
  assert.match(s1.logBuf.join('\n'), /%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port FastEthernet0\/1/);
  assert.match(s1.logBuf.join('\n'), /%PM-4-ERR_DISABLE: bpduguard error detected on Fa0\/1/);
  out = cli(s1, ['enable', 'show interfaces status']).text;
  assert.match(out, /Fa0\/1\s+err-disabled/);
  // глобально: portfast default + bpduguard default
  const s2 = net.addDevice('switch', { name: 'S2' });
  cli(s2, ['enable', 'conf t', 'spanning-tree portfast default', 'spanning-tree portfast bpduguard default', 'interface fa0/5', 'switchport mode access', 'end']);
  const r2 = net.addDevice('switch', { name: 'R2' });
  link(net, r2, s2, 0, 4);
  net.runUntilIdle();
  assert.equal(s2.ports[4].errDisabled, true);
  out = cli(s2, ['enable', 'show running-config']).text;
  assert.match(out, /^spanning-tree portfast default$/m);
  assert.match(out, /^spanning-tree portfast bpduguard default$/m);
});

test('DTP: auto+auto — access, desirable или trunk — транк, nonegotiate отключает согласование', () => {
  const net = mkNet();
  const s1 = net.addDevice('switch', { name: 'S1' });
  const s2 = net.addDevice('switch', { name: 'S2' });
  link(net, s1, s2, 24, 24);
  net.runUntilIdle();
  assert.equal(s1.ports[24].mode, 'access');
  let out = cli(s1, ['enable', 'show interfaces switchport']).text;
  assert.match(out, /Name: Gi\w*0\/1\nSwitchport: Enabled\nAdministrative Mode: dynamic auto\nOperational Mode: static access/);
  cli(s1, ['enable', 'conf t', 'interface g0/1', 'switchport mode dynamic desirable', 'end']);
  assert.equal(s1.ports[24].mode, 'trunk');
  assert.equal(s2.ports[24].mode, 'trunk');
  out = cli(s2, ['enable', 'show interfaces trunk']).text;
  assert.match(out, /Gi\w*0\/1/);
  // VLAN 10 через согласованный транк
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, s1, 0, 0);
  link(net, b, s2, 0, 0);
  cli(s1, ['enable', 'conf t', 'interface fa0/1', 'switchport access vlan 10', 'end']);
  cli(s2, ['enable', 'conf t', 'interface fa0/1', 'switchport access vlan 10', 'end']);
  assert.equal(ping(net, a, '10.0.0.2', { count: 2 }).replies.length, 2);
  // trunk + nonegotiate с одной стороны, dynamic auto с другой — транка нет
  cli(s1, ['enable', 'conf t', 'interface g0/1', 'switchport mode trunk', 'switchport nonegotiate', 'end']);
  assert.equal(s2.ports[24].mode, 'access');
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).replies.length, 0);
  out = cli(s1, ['enable', 'show running-config']).text;
  assert.match(out, /interface GigabitEthernet0\/1\n switchport mode trunk\n switchport nonegotiate/);
});

test('VTP: сервер раздаёт VLAN клиентам по транкам, клиент не может менять VLAN, пароль и transparent', () => {
  const net = mkNet();
  const srv = net.addDevice('switch', { name: 'Server' });
  const mid = net.addDevice('switch', { name: 'Transp' });
  const cl = net.addDevice('switch', { name: 'Client' });
  const cl2 = net.addDevice('switch', { name: 'Client2' });
  link(net, srv, mid, 24, 24);
  link(net, mid, cl, 23, 23);
  link(net, srv, cl2, 22, 22);
  for (const [s, ports] of [[srv, ['g0/1', 'fa0/23']], [mid, ['g0/1', 'fa0/24']], [cl, ['fa0/24']], [cl2, ['fa0/23']]]) {
    cli(s, ['enable', 'conf t'].concat(ports.flatMap((p) => ['interface ' + p, 'switchport mode trunk']), ['end']));
  }
  cli(srv, ['enable', 'conf t', 'vtp domain CCNA', 'vtp password cisco', 'end']);
  cli(mid, ['enable', 'conf t', 'vtp mode transparent', 'end']);
  cli(cl, ['enable', 'conf t', 'vtp mode client', 'vtp domain CCNA', 'vtp password cisco', 'end']);
  cli(cl2, ['enable', 'conf t', 'vtp mode client', 'vtp domain CCNA', 'vtp password wrong', 'end']);
  cli(srv, ['enable', 'conf t', 'vlan 30', 'name SALES', 'vlan 40', 'end']);
  assert.equal(cl.vlans.get(30), 'SALES', 'клиент за transparent получил VLAN');
  assert.ok(cl.vlans.has(40));
  assert.ok(!mid.vlans.has(30), 'transparent не применяет чужие VLAN');
  assert.ok(!cl2.vlans.has(30), 'неверный пароль VTP — нет синхронизации');
  assert.equal(cl.vtp.revision, srv.vtp.revision);
  let out = cli(cl, ['enable', 'conf t', 'vlan 50', 'end']).text;
  assert.match(out, /VTP VLAN configuration not allowed when device is in CLIENT mode/);
  out = cli(cl, ['enable', 'show vtp status']).text;
  assert.match(out, /VTP Domain Name\s+: CCNA/);
  assert.match(out, /VTP Operating Mode\s+: Client/);
  assert.match(out, new RegExp('Configuration Revision\\s+: ' + srv.vtp.revision));
  // коммутатор без домена узнаёт его из объявления
  const fresh = net.addDevice('switch', { name: 'Fresh' });
  link(net, fresh, srv, 24, 21);
  cli(fresh, ['enable', 'conf t', 'vtp mode client', 'vtp password cisco', 'interface g0/1', 'switchport mode trunk', 'end']);
  cli(srv, ['enable', 'conf t', 'interface fa0/22', 'switchport mode trunk', 'end']);
  assert.equal(fresh.vtp.domain, 'CCNA');
  assert.ok(fresh.vlans.has(30));
});

test('EtherChannel: LACP собирает два порта в Po1, STP не блокирует, настройки на Port-channel', () => {
  const net = mkNet();
  const s1 = net.addDevice('switch', { name: 'S1' });
  const s2 = net.addDevice('switch', { name: 'S2' });
  link(net, s1, s2, 22, 22);
  link(net, s1, s2, 23, 23);
  net.runUntilIdle();
  assert.equal(s1.ports.filter((p) => p.stp === 'blocking').length + s2.ports.filter((p) => p.stp === 'blocking').length, 1, 'без канала один порт заблокирован');
  let out = cli(s1, ['enable', 'conf t', 'interface range fa0/23 - 24', 'channel-group 1 mode active', 'exit', 'interface port-channel 1', 'switchport mode trunk', 'end']).text;
  assert.match(out, /Creating a port-channel interface Port-channel 1/);
  cli(s2, ['enable', 'conf t', 'interface range fa0/23 - 24', 'channel-group 1 mode passive', 'end']);
  assert.ok(s1.ports[22].bundle && s1.ports[23].bundle, 'оба порта в канале');
  assert.equal(s1.ports[22].mode, 'trunk');
  assert.equal(s2.ports[22].mode, 'trunk', 'DTP согласовал транк по каналу');
  assert.equal([...s1.ports, ...s2.ports].filter((p) => p.stp === 'blocking').length, 0);
  out = cli(s1, ['enable', 'show etherchannel summary', 'show spanning-tree', 'show running-config']).text;
  assert.match(out, /1\s+Po1\(SU\)\s+LACP\s+Fa0\/23\(P\) Fa0\/24\(P\)/);
  assert.match(out, /Po1\s+(Root|Desg) FWD 12/);
  assert.match(out, /^interface Port-channel1\n switchport mode trunk$/m);
  assert.match(out, /^ channel-group 1 mode active$/m);
  // трафик через канал без дубликатов
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, s1, 0, 0);
  link(net, b, s2, 0, 0);
  const r = ping(net, a, '10.0.0.2', { count: 4 });
  assert.equal(r.done.received, 4);
  assert.equal(r.replies.length, 4);
  // passive + passive — канал не собирается
  cli(s1, ['enable', 'conf t', 'interface range fa0/23 - 24', 'no channel-group', 'channel-group 1 mode passive', 'end']);
  assert.ok(!s1.ports[22].bundle);
  out = cli(s1, ['enable', 'show etherchannel summary']).text;
  assert.match(out, /Fa0\/23\(I\)/);
  // смешать LACP и PAgP в одной группе нельзя
  out = cli(s1, ['enable', 'conf t', 'interface fa0/23', 'channel-group 1 mode desirable', 'end']).text;
  assert.match(out, /Invalid etherchnl mode/);
  // сохранение
  cli(s1, ['enable', 'conf t', 'interface range fa0/23 - 24', 'channel-group 1 mode active', 'end']);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.ok(n2.findByName('S1').ports[22].bundle);
});
