// IPv6, часть 2: EIGRP для IPv6 и HSRP для IPv6 (standby version 2, ipv6 autoconfig).
const test = require('node:test');
const { NL, assert, mkNet, link, cli, ping } = require('./helpers');

const A6 = (s) => NL.ip6.parse(s);

test('EIGRP для IPv6: соседи по link-local, маршруты D, ping через три маршрутизатора, сохранение', () => {
  const net = mkNet();
  const R = [1, 2, 3].map((i) => net.addDevice('router', { name: 'R' + i }));
  link(net, R[0], R[1], 1, 0);
  link(net, R[1], R[2], 1, 0);
  const a = net.addDevice('pc', { name: 'A' });
  const b = net.addDevice('pc', { name: 'B' });
  link(net, a, R[0], 0, 0);
  link(net, b, R[2], 0, 1);
  const cfg = (i, n0, n1) => ['enable', 'conf t', 'hostname R' + (i + 1), 'ipv6 unicast-routing', 'ipv6 router eigrp 10', 'eigrp router-id ' + [i + 1, i + 1, i + 1, i + 1].join('.'), 'exit',
    'interface g0/0', 'ipv6 address ' + n0, 'ipv6 eigrp 10', 'no shutdown', 'interface g0/1', 'ipv6 address ' + n1, 'ipv6 eigrp 10', 'no shutdown', 'end'];
  cli(R[0], cfg(0, '2001:db8:1::1/64', '2001:db8:12::1/64'));
  cli(R[1], cfg(1, '2001:db8:12::2/64', '2001:db8:23::2/64'));
  cli(R[2], cfg(2, '2001:db8:23::3/64', '2001:db8:3::1/64'));
  a.setIpv6Host('static', A6('2001:db8:1::10'), 64, A6('2001:db8:1::1'));
  b.setIpv6Host('static', A6('2001:db8:3::10'), 64, A6('2001:db8:3::1'));
  net.runUntilIdle();
  let out = cli(R[0], ['enable', 'show ipv6 route eigrp', 'show ipv6 eigrp neighbors', 'show ipv6 eigrp topology', 'show ipv6 protocols', 'show running-config']).text;
  assert.match(out, /^D   2001:DB8:3::\/64 \[90\/3328\]\n     via FE80::[0-9A-F:]+, GigabitEthernet0\/1$/m);
  assert.match(out, /EIGRP-IPv6 Neighbors for AS\(10\)[\s\S]*Gi0\/1/);
  assert.match(out, /P 2001:DB8:1::\/64, 1 successors, FD is 2816\n        via Connected, GigabitEthernet0\/0/);
  assert.match(out, /IPv6 Routing Protocol is "eigrp 10"[\s\S]*Router-ID: 1\.1\.1\.1/);
  assert.match(out, /^ipv6 router eigrp 10\n eigrp router-id 1\.1\.1\.1\n!/m);
  assert.match(out, /^ ipv6 eigrp 10$/m);
  assert.match(R[0].logBuf.join('\n'), /%DUAL-5-NBRCHANGE: EIGRP-IPv6 10: Neighbor FE80::\S+ \(GigabitEthernet0\/1\) is up: new adjacency/);
  assert.equal(ping(net, a, '2001:db8:3::10', { count: 2 }).replies.length, 2);
  // passive-interface и shutdown процесса
  cli(R[1], ['enable', 'conf t', 'ipv6 router eigrp 10', 'shutdown', 'end']);
  assert.doesNotMatch(cli(R[0], ['enable', 'show ipv6 route eigrp']).text, /2001:DB8:3::/);
  cli(R[1], ['enable', 'conf t', 'ipv6 router eigrp 10', 'no shutdown', 'end']);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  out = cli(n2.findByName('R1'), ['enable', 'show ipv6 route eigrp']).text;
  assert.match(out, /2001:DB8:3::\/64/);
});

test('HSRP для IPv6: виртуальный link-local шлюз из RA, смена активного при отказе', () => {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  const lan = net.addDevice('switch', { name: 'LAN' });
  const srvSw = net.addDevice('switch', { name: 'SRV' });
  link(net, r1, lan, 0, 23);
  link(net, r2, lan, 0, 22);
  link(net, r1, srvSw, 1, 23);
  link(net, r2, srvSw, 1, 22);
  const pcA = net.addDevice('pc', { name: 'PC' });
  const srv = net.addDevice('server', { name: 'S' });
  link(net, pcA, lan, 0, 0);
  link(net, srv, srvSw, 0, 0);
  const cfg = (n, host, prio) => ['enable', 'conf t', 'hostname ' + n, 'ipv6 unicast-routing',
    'interface g0/0', 'ipv6 address 2001:db8:1::' + host + '/64', 'standby version 2', 'standby 1 ipv6 autoconfig', 'standby 1 priority ' + prio, 'standby 1 preempt', 'no shutdown',
    'interface g0/1', 'ipv6 address 2001:db8:2::' + host + '/64', 'standby version 2', 'standby 2 ipv6 FE80::2', 'standby 2 priority ' + prio, 'standby 2 preempt', 'no shutdown', 'end'];
  let out = cli(r1, ['enable', 'conf t', 'interface g0/0', 'standby 1 ipv6 autoconfig', 'end']).text;
  assert.match(out, /standby version 2/);
  cli(r1, cfg('R1', 2, 110));
  cli(r2, cfg('R2', 3, 100));
  pcA.setIpv6Host('auto');
  srv.setIpv6Host('static', A6('2001:db8:2::10'), 64, A6('fe80::2'));
  net.runUntilIdle();
  assert.equal(NL.ip6.str(pcA.gateway6().addr, true), 'FE80::5:73FF:FEA0:1', 'шлюз ПК — виртуальный адрес из RA');
  out = cli(r1, ['enable', 'show standby brief', 'show standby', 'show running-config']).text;
  assert.match(out, /Gi0\/0\s+1\s+110 P Active\s+local\s+FE80::\S+\s+FE80::5:73FF:FEA0:1/);
  assert.match(out, /Active virtual MAC address is 0005\.73a0\.0001/i);
  assert.match(out, /^ standby 1 ipv6 autoconfig$/m);
  assert.match(out, /^ standby 2 ipv6 FE80::2$/m);
  assert.match(cli(r2, ['enable', 'show standby brief']).text, /Gi0\/0\s+1\s+100 P Standby/);
  assert.ok(ping(net, pcA, '2001:db8:2::10', { count: 2 }).replies.length >= 1);
  // отказ R1 — активным становится R2, связь сохраняется
  net.setPower(r1, false);
  net.runUntilIdle();
  assert.match(cli(r2, ['enable', 'show standby brief']).text, /Gi0\/0\s+1\s+100 P Active/);
  assert.ok(ping(net, pcA, '2001:db8:2::10', { count: 3 }).replies.length >= 1, 'после отказа R1 шлюз — R2');
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  const g = n2.findByName('R2').ifaceByName('GigabitEthernet0/0').fhrp.hsrp[1];
  assert.equal(g.auto6, true);
  assert.equal(NL.ip6.str(g.ip6, true), 'FE80::5:73FF:FEA0:1');
});
