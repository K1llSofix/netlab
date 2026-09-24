// EIGRP (DUAL, feasible successor, variance, суммаризация), редистрибуция, OSPF IA/E2/area range, BGP.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping } = require('./helpers');

/** Ромб R1—R2—R4 и R1—R3—R4, за R4 — loopback-сети 172.16.4.0/24 и 172.16.5.0/24, за R1 — ПК. */
function diamond() {
  const net = mkNet();
  const R = {};
  for (const n of ['R1', 'R2', 'R3', 'R4']) R[n] = net.addDevice('router', { name: n });
  routerIf(R.R1, 0, '10.12.0.1/24'); routerIf(R.R2, 0, '10.12.0.2/24');
  routerIf(R.R1, 1, '10.13.0.1/24'); routerIf(R.R3, 0, '10.13.0.3/24');
  routerIf(R.R2, 1, '10.24.0.2/24'); routerIf(R.R4, 0, '10.24.0.4/24');
  routerIf(R.R3, 1, '10.34.0.3/24'); routerIf(R.R4, 1, '10.34.0.4/24');
  routerIf(R.R1, 2, '192.168.1.1/24');
  link(net, R.R1, R.R2, 0, 0); link(net, R.R1, R.R3, 1, 0); link(net, R.R2, R.R4, 1, 0); link(net, R.R3, R.R4, 1, 1);
  const host = pc(net, 'PC', '192.168.1.10/24', '192.168.1.1');
  link(net, host, R.R1, 0, 2);
  cli(R.R4, ['enable', 'conf t', 'interface loopback 0', 'ip address 172.16.4.1 255.255.255.0', 'interface loopback 1', 'ip address 172.16.5.1 255.255.255.0', 'end']);
  net.recording = true;
  for (const r of Object.values(R)) cli(r, ['enable', 'conf t', 'router eigrp 100', 'network 10.0.0.0', 'network 172.16.0.0', 'network 192.168.1.0', 'no auto-summary', 'end']);
  // путь через R3 хуже: задержка на R1 g0/1
  cli(R.R1, ['enable', 'conf t', 'interface g0/1', 'delay 5', 'end']);
  return { net, R, host };
}

test('EIGRP: соседи, маршруты D с метрикой, feasible successor, variance и переключение при отказе', () => {
  const { net, R, host } = diamond();
  let out = cli(R.R1, ['enable', 'show ip route']).text;
  assert.match(out, /^D\s+172\.16\.4\.0\/24 \[90\/131072\] via 10\.12\.0\.2, .*GigabitEthernet0\/0$/m);
  assert.doesNotMatch(out, /172\.16\.4\.0\/24 \[90\/\d+\] via 10\.13\.0\.3/, 'без variance — только successor');
  out = cli(R.R1, ['enable', 'show ip eigrp neighbors']).text;
  assert.match(out, /IP-EIGRP neighbors for process 100/);
  assert.match(out, /10\.12\.0\.2\s+Gi0\/0/);
  assert.match(out, /10\.13\.0\.3\s+Gi0\/1/);
  out = cli(R.R1, ['enable', 'show ip eigrp topology']).text;
  assert.match(out, /P 172\.16\.4\.0\/24, 1 successors, FD is 131072\n\s+via 10\.12\.0\.2 \(131072\/130816\), GigabitEthernet0\/0\n\s+via 10\.13\.0\.3 \(132096\/130816\), GigabitEthernet0\/1\s+<- feasible successor/);
  assert.match(R.R1.logBuf.join('\n'), /%DUAL-5-NBRCHANGE: EIGRP-IPv4 100: Neighbor 10\.12\.0\.2 \(GigabitEthernet0\/0\) is up: new adjacency/);
  assert.equal(ping(net, host, '172.16.4.1', { count: 2 }).replies.length, 2);
  // variance 2 — неравная балансировка через feasible successor
  cli(R.R1, ['enable', 'conf t', 'router eigrp 100', 'variance 2', 'end']);
  out = cli(R.R1, ['enable', 'show ip route eigrp']).text;
  assert.match(out, /172\.16\.4\.0\/24 \[90\/131072\] via 10\.12\.0\.2/);
  assert.match(out, /172\.16\.4\.0\/24 \[90\/132096\] via 10\.13\.0\.3/);
  // отказ канала R1—R2: трафик уходит через R3
  cli(R.R1, ['enable', 'conf t', 'interface g0/0', 'shutdown', 'end']);
  assert.match(cli(R.R1, ['enable', 'show ip route eigrp']).text, /^D\s+172\.16\.4\.0\/24 \[90\/132096\] via 10\.13\.0\.3/m);
  const log = R.R1.logBuf.join('\n');
  assert.match(log, /%LINK-5-CHANGED: Interface GigabitEthernet0\/0, changed state to administratively down/);
  assert.match(log, /Neighbor 10\.12\.0\.2 \(GigabitEthernet0\/0\) is down/);
  assert.equal(ping(net, host, '172.16.4.1', { count: 2 }).replies.length, 2);
});

test('EIGRP: ручная суммаризация с Null0, auto-summary, passive-interface, running-config и сохранение', () => {
  const { net, R } = diamond();
  cli(R.R4, ['enable', 'conf t', 'interface g0/0', 'ip summary-address eigrp 100 172.16.4.0 255.255.254.0', 'interface g0/1', 'ip summary-address eigrp 100 172.16.4.0 255.255.254.0', 'end']);
  assert.match(cli(R.R4, ['enable', 'show ip route']).text, /^D\s+172\.16\.4\.0\/23 is a summary, .*Null0$/m);
  let out = cli(R.R1, ['enable', 'show ip route eigrp']).text;
  assert.match(out, /172\.16\.4\.0\/23 \[90\/\d+\] via 10\.12\.0\.2/);
  assert.doesNotMatch(out, /172\.16\.4\.0\/24/, 'вместо /24 приходит суммарный /23');
  out = cli(R.R4, ['enable', 'show running-config']).text;
  assert.match(out, /interface GigabitEthernet0\/0\n ip address 10\.24\.0\.4 255\.255\.255\.0\n ip summary-address eigrp 100 172\.16\.4\.0 255\.255\.254\.0/);
  assert.match(out, /router eigrp 100\n network 10\.0\.0\.0\n network 172\.16\.0\.0\n network 192\.168\.1\.0\n no auto-summary/);
  // auto-summary: на границе классовых сетей 172.16.0.0/16
  cli(R.R4, ['enable', 'conf t', 'interface g0/0', 'no ip summary-address eigrp 100 172.16.4.0 255.255.254.0', 'interface g0/1', 'no ip summary-address eigrp 100 172.16.4.0 255.255.254.0', 'router eigrp 100', 'auto-summary', 'end']);
  out = cli(R.R1, ['enable', 'show ip route eigrp']).text;
  assert.match(out, /172\.16\.0\.0\/16 \[90\/\d+\] via 10\.12\.0\.2/);
  assert.match(cli(R.R4, ['enable', 'show ip route']).text, /172\.16\.0\.0\/16 is a summary, .*Null0/);
  // passive-interface: сосед на g0/0 пропадает
  cli(R.R2, ['enable', 'conf t', 'router eigrp 100', 'passive-interface g0/0', 'end']);
  assert.doesNotMatch(cli(R.R1, ['enable', 'show ip eigrp neighbors']).text, /10\.12\.0\.2/);
  assert.match(cli(R.R2, ['enable', 'show running-config']).text, /^ passive-interface GigabitEthernet0\/0$/m);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.match(cli(n2.findByName('R1'), ['enable', 'show ip route eigrp']).text, /172\.16\.0\.0\/16 \[90\/\d+\] via 10\.13\.0\.3/);
  assert.match(cli(n2.findByName('R1'), ['enable', 'show running-config']).text, /^ delay 5$/m);
});

/** R1 (область 1) — R2 (ABR) — R3 (область 0, ASBR, EIGRP 10) — R4 (EIGRP). */
function multi() {
  const net = mkNet();
  const R = {};
  for (const n of ['R1', 'R2', 'R3', 'R4']) R[n] = net.addDevice('router', { name: n });
  routerIf(R.R1, 0, '10.12.0.1/24'); routerIf(R.R2, 0, '10.12.0.2/24');
  routerIf(R.R2, 1, '10.23.0.2/24'); routerIf(R.R3, 0, '10.23.0.3/24');
  routerIf(R.R3, 1, '10.34.0.3/24'); routerIf(R.R4, 0, '10.34.0.4/24');
  link(net, R.R1, R.R2, 0, 0); link(net, R.R2, R.R3, 1, 0); link(net, R.R3, R.R4, 1, 0);
  cli(R.R1, ['enable', 'conf t', 'interface lo0', 'ip address 10.1.0.1 255.255.255.0', 'interface lo1', 'ip address 10.1.1.1 255.255.255.0', 'router ospf 1', 'network 10.1.0.0 0.0.1.255 area 1', 'network 10.12.0.0 0.0.0.255 area 1', 'end']);
  cli(R.R2, ['enable', 'conf t', 'router ospf 1', 'network 10.12.0.0 0.0.0.255 area 1', 'network 10.23.0.0 0.0.0.255 area 0', 'end']);
  cli(R.R3, ['enable', 'conf t', 'router ospf 1', 'network 10.23.0.0 0.0.0.255 area 0', 'router eigrp 10', 'network 10.34.0.0 0.0.0.255', 'end']);
  cli(R.R4, ['enable', 'conf t', 'interface lo0', 'ip address 172.20.0.1 255.255.255.0', 'router eigrp 10', 'network 10.34.0.0 0.0.0.255', 'network 172.20.0.0', 'end']);
  return { net, R };
}

test('Редистрибуция EIGRP ↔ OSPF: O E2 / O E1, D EX, subnets, default-metric; OSPF IA и area range', () => {
  const { net, R } = multi();
  assert.doesNotMatch(cli(R.R1, ['enable', 'show ip route']).text, /172\.20\.0\.0/, 'без редистрибуции внешних сетей нет');
  let out = cli(R.R3, ['enable', 'conf t', 'router ospf 1', 'redistribute eigrp 10', 'end']).text;
  assert.match(out, /Only classful networks will be redistributed/);
  assert.doesNotMatch(cli(R.R1, ['enable', 'show ip route']).text, /172\.20\.0\.0\/24/, 'без subnets подсеть /24 не попадает в OSPF');
  cli(R.R3, ['enable', 'conf t', 'router ospf 1', 'redistribute eigrp 10 subnets', 'router eigrp 10', 'redistribute ospf 1', 'end']);
  out = cli(R.R1, ['enable', 'show ip route']).text;
  assert.match(out, /^O E2\s+172\.20\.0\.0\/24 \[110\/20\] via 10\.12\.0\.2/m);
  assert.match(out, /^O E2\s+10\.34\.0\.0\/24 \[110\/20\]/m, 'подключённые сети EIGRP тоже редистрибутируются');
  assert.match(out, /^O IA\s+10\.23\.0\.0\/24 \[110\/2\]/m);
  // без метрики OSPF в EIGRP не попадает (бесконечная метрика)
  assert.doesNotMatch(cli(R.R4, ['enable', 'show ip route']).text, /D EX/);
  cli(R.R3, ['enable', 'conf t', 'router eigrp 10', 'default-metric 100000 10 255 1 1500', 'end']);
  out = cli(R.R4, ['enable', 'show ip route']).text;
  assert.match(out, /^D EX\s+10\.12\.0\.0\/24 \[170\/28416\] via 10\.34\.0\.3/m);
  assert.match(out, /^D EX\s+10\.1\.0\.1\/32 \[170\/\d+\]/m);
  assert.equal(ping(net, R.R4, '10.1.0.1', { count: 2 }).replies.length, 2, 'связность через обе области маршрутизации');
  // metric-type 1: метрика растёт по пути
  cli(R.R3, ['enable', 'conf t', 'router ospf 1', 'redistribute eigrp 10 metric 50 metric-type 1 subnets', 'end']);
  assert.match(cli(R.R1, ['enable', 'show ip route']).text, /^O E1\s+172\.20\.0\.0\/24 \[110\/52\]/m);
  // area range на ABR: вместо двух /32 — один /23 в других областях
  assert.match(cli(R.R3, ['enable', 'show ip route ospf']).text, /10\.1\.0\.1\/32/);
  cli(R.R2, ['enable', 'conf t', 'router ospf 1', 'area 1 range 10.1.0.0 255.255.254.0', 'end']);
  out = cli(R.R3, ['enable', 'show ip route ospf']).text;
  assert.match(out, /^O IA\s+10\.1\.0\.0\/23 \[110\/3\] via 10\.23\.0\.2/m);
  assert.doesNotMatch(out, /10\.1\.0\.1\/32/);
  assert.match(cli(R.R1, ['enable', 'show ip route ospf']).text, /O E1\s+172\.20/, 'внутри области 1 суммаризации нет');
  out = cli(R.R3, ['enable', 'show running-config']).text;
  assert.match(out, /router ospf 1\n log-adjacency-changes\n network 10\.23\.0\.0 0\.0\.0\.255 area 0\n redistribute eigrp 10 metric 50 metric-type 1 subnets\n!/);
  assert.match(out, /router eigrp 10\n network 10\.34\.0\.0 0\.0\.0\.255\n redistribute ospf 1\n default-metric 100000 10 255 1 1500\n no auto-summary/);
  assert.match(cli(R.R2, ['enable', 'show running-config']).text, /^ area 1 range 10\.1\.0\.0 255\.255\.254\.0$/m);
  assert.match(cli(R.R3, ['enable', 'show ip protocols']).text, /Routing Protocol is "ospf 1"[\s\S]*Routing Protocol is "eigrp  10"[\s\S]*Redistributing: eigrp 10, ospf 1/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.match(cli(n2.findByName('R4'), ['enable', 'show ip route']).text, /D EX\s+10\.1\.0\.0\/23/);
});

test('RIP: redistribute static с метрикой', () => {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  routerIf(r1, 0, '10.0.0.1/24'); routerIf(r2, 0, '10.0.0.2/24');
  link(net, r1, r2, 0, 0);
  cli(r1, ['enable', 'conf t', 'ip route 203.0.113.0 255.255.255.0 10.0.0.99', 'router rip', 'version 2', 'network 10.0.0.0', 'redistribute static metric 3', 'end']);
  cli(r2, ['enable', 'conf t', 'router rip', 'version 2', 'network 10.0.0.0', 'end']);
  assert.match(cli(r2, ['enable', 'show ip route rip']).text, /^R\s+203\.0\.113\.0\/24 \[120\/4\] via 10\.0\.0\.1/m);
  assert.match(cli(r1, ['enable', 'show running-config']).text, /router rip\n version 2\n network 10\.0\.0\.0\n( no auto-summary\n)? redistribute static metric 3\n!/);
});

/** AS 65001: R5 + ПК1; AS 65002: R6 — R7 (iBGP через loopback, OSPF внутри AS) + ПК2. */
function bgpLab() {
  const net = mkNet();
  const B = {};
  for (const n of ['R5', 'R6', 'R7']) B[n] = net.addDevice('router', { name: n });
  routerIf(B.R5, 0, '10.56.0.5/24'); routerIf(B.R6, 0, '10.56.0.6/24');
  routerIf(B.R6, 1, '10.67.0.6/24'); routerIf(B.R7, 0, '10.67.0.7/24');
  routerIf(B.R5, 1, '192.0.2.1/24'); routerIf(B.R7, 1, '198.51.100.1/24');
  link(net, B.R5, B.R6, 0, 0); link(net, B.R6, B.R7, 1, 0);
  const p1 = pc(net, 'PC1', '192.0.2.10/24', '192.0.2.1');
  const p2 = pc(net, 'PC2', '198.51.100.10/24', '198.51.100.1');
  link(net, p1, B.R5, 0, 1); link(net, p2, B.R7, 0, 1);
  net.recording = true;
  cli(B.R5, ['enable', 'conf t', 'router bgp 65001', 'neighbor 10.56.0.6 remote-as 65002', 'network 192.0.2.0 mask 255.255.255.0', 'end']);
  cli(B.R6, ['enable', 'conf t', 'interface lo0', 'ip address 6.6.6.6 255.255.255.255', 'router ospf 1', 'network 10.67.0.0 0.0.0.255 area 0', 'network 6.6.6.6 0.0.0.0 area 0',
    'router bgp 65002', 'neighbor 10.56.0.5 remote-as 65001', 'neighbor 7.7.7.7 remote-as 65002', 'neighbor 7.7.7.7 update-source lo0', 'end']);
  cli(B.R7, ['enable', 'conf t', 'interface lo0', 'ip address 7.7.7.7 255.255.255.255', 'router ospf 1', 'network 10.67.0.0 0.0.0.255 area 0', 'network 7.7.7.7 0.0.0.0 area 0',
    'router bgp 65002', 'neighbor 6.6.6.6 remote-as 65002', 'neighbor 6.6.6.6 update-source loopback0', 'network 198.51.100.0 mask 255.255.255.0', 'end']);
  return { net, B, p1, p2 };
}

test('BGP: eBGP и iBGP через loopback, next-hop-self, AS_PATH, show ip bgp, сброс соседа', () => {
  const { net, B, p1 } = bgpLab();
  let out = cli(B.R6, ['enable', 'show ip bgp summary']).text;
  assert.match(out, /BGP router identifier 6\.6\.6\.6, local AS number 65002/);
  assert.match(out, /^10\.56\.0\.5\s+4\s+65001 .* 1$/m);
  assert.match(out, /^7\.7\.7\.7\s+4\s+65002 .* 1$/m);
  out = cli(B.R6, ['enable', 'show ip bgp']).text;
  assert.match(out, /^\*> 192\.0\.2\.0\/24\s+10\.56\.0\.5\s+0\s+0\s+65001 i$/m);
  assert.match(out, /^\*>i198\.51\.100\.0\/24\s+7\.7\.7\.7\s+0\s+100\s+0\s+i$/m);
  assert.match(cli(B.R6, ['enable', 'show ip route bgp']).text, /^B\s+192\.0\.2\.0\/24 \[20\/0\] via 10\.56\.0\.5/m);
  assert.match(B.R6.logBuf.join('\n'), /%BGP-5-ADJCHANGE: neighbor 7\.7\.7\.7 Up/);
  // без next-hop-self следующий переход 10.56.0.5 недоступен для R7
  out = cli(B.R7, ['enable', 'show ip bgp']).text;
  assert.match(out, /^  i192\.0\.2\.0\/24\s+10\.56\.0\.5/m);
  assert.doesNotMatch(cli(B.R7, ['enable', 'show ip route']).text, /192\.0\.2\.0/);
  assert.equal(ping(net, p1, '198.51.100.10', { count: 1 }).replies.length, 0);
  cli(B.R6, ['enable', 'conf t', 'router bgp 65002', 'neighbor 7.7.7.7 next-hop-self', 'end']);
  assert.match(cli(B.R7, ['enable', 'show ip bgp']).text, /^\*>i192\.0\.2\.0\/24\s+6\.6\.6\.6\s+0\s+100\s+0\s+65001 i$/m);
  assert.match(cli(B.R7, ['enable', 'show ip route bgp']).text, /^B\s+192\.0\.2\.0\/24 \[200\/0\] via 10\.67\.0\.6/m);
  assert.match(cli(B.R5, ['enable', 'show ip bgp']).text, /^\*> 198\.51\.100\.0\/24\s+10\.56\.0\.6\s+0\s+0\s+65002 i$/m);
  assert.equal(ping(net, p1, '198.51.100.10', { count: 3 }).replies.length, 3, 'ПК в разных AS связаны через BGP');
  out = cli(B.R6, ['enable', 'show running-config']).text;
  assert.match(out, /router bgp 65002\n bgp log-neighbor-changes\n no synchronization\n neighbor 10\.56\.0\.5 remote-as 65001\n neighbor 7\.7\.7\.7 remote-as 65002\n neighbor 7\.7\.7\.7 update-source Loopback0\n neighbor 7\.7\.7\.7 next-hop-self\n!/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(ping(n2, n2.findByName('PC1'), '198.51.100.10', { count: 2 }).replies.length, 2);
  // redistribute connected в BGP: происхождение «?»
  cli(B.R7, ['enable', 'conf t', 'interface lo1', 'ip address 203.0.113.1 255.255.255.0', 'router bgp 65002', 'redistribute connected', 'end']);
  assert.match(cli(B.R5, ['enable', 'show ip bgp']).text, /^\*> 203\.0\.113\.0\/24\s+10\.56\.0\.6\s+0\s+0\s+65002 \?$/m);
  assert.match(cli(B.R5, ['enable', 'show ip route bgp']).text, /^B\s+203\.0\.113\.0\/24 \[20\/0\]/m);
  // shutdown соседа и неверный remote-as
  cli(B.R5, ['enable', 'conf t', 'router bgp 65001', 'neighbor 10.56.0.6 shutdown', 'end']);
  assert.match(B.R6.logBuf.join('\n'), /%BGP-5-ADJCHANGE: neighbor 10\.56\.0\.5 Down/);
  assert.match(cli(B.R5, ['enable', 'show ip bgp summary']).text, /10\.56\.0\.6\s+4\s+65002 .*Idle \(Admin\)/);
  cli(B.R5, ['enable', 'conf t', 'router bgp 65001', 'no neighbor 10.56.0.6 shutdown', 'neighbor 10.56.0.6 remote-as 65009', 'end']);
  out = cli(B.R5, ['enable', 'show ip bgp neighbors']).text;
  assert.match(out, /BGP state = Idle/);
  assert.match(out, /неверный remote-as \(у соседа AS 65002\)/);
});
