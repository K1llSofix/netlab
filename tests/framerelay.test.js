// Frame Relay: облако-коммутатор (DLCI, PVC), Inverse ARP и статические карты, подынтерфейсы point-to-point, OSPF через PVC.
const test = require('node:test');
const { NL, assert, mkNet, link, cli, ping } = require('./helpers');

const FR = () => NL.fr;

function lab() {
  const net = mkNet();
  const cloud = net.addDevice('cloud', { name: 'FR' });
  const rs = ['R1', 'R2', 'R3'].map((n) => net.addDevice('router', { name: n }));
  for (const r of rs) { net.setPower(r, false); net.setModule(r, 'hwic0', 'HWIC-2T'); net.setPower(r, true); }
  rs.forEach((r, i) => link(net, cloud, r, cloud.portIndex('Serial' + i), r.portIndex('Serial0/0/0'), 'serial-dce'));
  const C = FR().cloud;
  C.addDlci(cloud, 'Serial0', 102, 'R1-R2');
  C.addDlci(cloud, 'Serial0', 103, 'R1-R3');
  C.addDlci(cloud, 'Serial1', 201, 'R2-R1');
  C.addDlci(cloud, 'Serial2', 301, 'R3-R1');
  C.connect(cloud, 'Serial0', 102, 'Serial1', 201);
  C.connect(cloud, 'Serial0', 103, 'Serial2', 301);
  return { net, cloud, rs };
}

test('Frame Relay: звезда через облако, Inverse ARP, статическая карта, show frame-relay', () => {
  const { net, cloud, rs } = lab();
  const [r1, r2, r3] = rs;
  cli(r1, ['enable', 'conf t', 'interface s0/0/0', 'encapsulation frame-relay', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']);
  cli(r2, ['enable', 'conf t', 'interface s0/0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end']);
  // R2 ещё на HDLC — кабель к облаку с разной инкапсуляцией
  const l2 = [...net.links.values()].find((l) => l.b.dev === r2.id || l.a.dev === r2.id);
  assert.match(net.linkIssue(l2), /инкапсуляция/i);
  // статическая карта отключает Inverse ARP на этом DLCI — нужны карты и к хабу, и к соседнему филиалу
  cli(r2, ['enable', 'conf t', 'interface s0/0/0', 'encapsulation frame-relay', 'frame-relay map ip 10.0.0.1 201 broadcast', 'frame-relay map ip 10.0.0.3 201 broadcast', 'end']);
  cli(r3, ['enable', 'conf t', 'interface s0/0/0', 'encapsulation frame-relay', 'ip address 10.0.0.3 255.255.255.0', 'frame-relay map ip 10.0.0.1 301 broadcast', 'frame-relay map ip 10.0.0.2 301 broadcast', 'end']);
  net.runUntilIdle();
  assert.equal(net.linkIssue(l2), null);
  assert.equal(ping(net, r1, '10.0.0.2', { count: 2 }).replies.length, 2, 'R1 → R2 по Inverse ARP');
  assert.equal(ping(net, r1, '10.0.0.3', { count: 2 }).replies.length, 2, 'R1 → R3');
  assert.equal(ping(net, r2, '10.0.0.3', { count: 2 }).replies.length, 2, 'R2 → R3 через R1 (статическая карта на DLCI 201)');
  let out = cli(r1, ['enable', 'show frame-relay pvc', 'show frame-relay map', 'show frame-relay lmi', 'show running-config']).text;
  assert.match(out, /^\s+Local\s+2\s+0\s+0\s+0/m);
  assert.match(out, /DLCI = 102, DLCI USAGE = LOCAL, PVC STATUS = ACTIVE, INTERFACE = Serial0\/0\/0/);
  assert.match(out, /Serial0\/0\/0 \(up\): ip 10\.0\.0\.2 dlci 102\(0x66,0x1860\), dynamic,/);
  assert.match(out, /LMI TYPE = CISCO/);
  assert.match(out, /^ encapsulation frame-relay$/m);
  out = cli(r2, ['enable', 'show frame-relay map', 'show running-config']).text;
  assert.match(out, /ip 10\.0\.0\.3 dlci 201\(0xC9,0x3090\), static,/);
  assert.match(out, /^ frame-relay map ip 10\.0\.0\.3 201 broadcast$/m);
  // PVC без пары в облаке — INACTIVE; DLCI, которого нет в облаке, — DELETED
  FR().cloud.addDlci(cloud, 'Serial0', 104, 'spare');
  cli(r1, ['enable', 'conf t', 'interface s0/0/0', 'frame-relay map ip 10.0.0.9 999', 'end']);
  out = cli(r1, ['enable', 'show frame-relay pvc']).text;
  assert.match(out, /DLCI = 104, .*PVC STATUS = INACTIVE/);
  assert.match(out, /DLCI = 999, .*PVC STATUS = DELETED/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(n2.findByName('FR').fr.conns.length, 2);
  assert.equal(ping(n2, n2.findByName('R2'), '10.0.0.3', { count: 1 }).replies.length, 1);
});

test('Frame Relay: подынтерфейсы point-to-point и OSPF через PVC', () => {
  const { net, rs } = lab();
  const [r1, r2, r3] = rs;
  cli(r1, ['enable', 'conf t', 'interface s0/0/0', 'encapsulation frame-relay', 'no shutdown', 'exit',
    'interface s0/0/0.102 point-to-point', 'ip address 10.1.12.1 255.255.255.252', 'frame-relay interface-dlci 102', 'exit',
    'interface s0/0/0.103 point-to-point', 'ip address 10.1.13.1 255.255.255.252', 'frame-relay interface-dlci 103', 'exit',
    'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end']);
  cli(r2, ['enable', 'conf t', 'interface s0/0/0', 'encapsulation frame-relay', 'exit', 'interface s0/0/0.201 point-to-point', 'ip address 10.1.12.2 255.255.255.252', 'frame-relay interface-dlci 201', 'exit',
    'interface loopback 0', 'ip address 2.2.2.2 255.255.255.255', 'exit', 'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0', 'end']);
  cli(r3, ['enable', 'conf t', 'interface s0/0/0', 'encapsulation frame-relay', 'exit', 'interface s0/0/0.301 point-to-point', 'ip address 10.1.13.2 255.255.255.252', 'frame-relay interface-dlci 301', 'exit',
    'interface loopback 0', 'ip address 3.3.3.3 255.255.255.255', 'exit', 'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0', 'end']);
  net.runUntilIdle();
  assert.equal(ping(net, r1, '10.1.12.2', { count: 1 }).replies.length, 1);
  const rt = cli(r1, ['enable', 'show ip route', 'show frame-relay map', 'show running-config']).text;
  assert.match(rt, /O\s+2\.2\.2\.2\/32 \[110\/\d+\] via 10\.1\.12\.2/);
  assert.match(rt, /O\s+3\.3\.3\.3\/32 \[110\/\d+\] via 10\.1\.13\.2/);
  assert.match(rt, /Serial0\/0\/0\.102 \(up\): point-to-point dlci, dlci 102/);
  assert.match(rt, /^interface Serial0\/0\/0\.102 point-to-point\n ip address 10\.1\.12\.1 255\.255\.255\.252\n frame-relay interface-dlci 102$/m);
  assert.equal(ping(net, r2, '3.3.3.3', { count: 2 }).replies.length, 2, 'R2 → R3 через хаб по OSPF');
});
