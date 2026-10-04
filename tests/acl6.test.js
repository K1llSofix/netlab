// Списки доступа IPv6: ipv6 access-list, ipv6 traffic-filter in/out, неявные правила ND, счётчики, сохранение.
const test = require('node:test');
const { NL, assert, mkNet, link, cli, ping } = require('./helpers');

const A6 = (s) => NL.ip6.parse(s);

test('IPv6 ACL: запрет ping из одной сети, разрешение из другой, ND не ломается, сохранение', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const a = net.addDevice('pc', { name: 'A' });
  const b = net.addDevice('pc', { name: 'B' });
  const c = net.addDevice('pc', { name: 'C' });
  const sw = net.addDevice('switch', { name: 'SW' });
  link(net, a, sw, 0, 0);
  link(net, c, sw, 0, 1);
  link(net, r, sw, 0, 23);
  link(net, b, r, 0, 1);
  cli(r, ['enable', 'conf t', 'ipv6 unicast-routing', 'interface g0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'interface g0/1', 'ipv6 address 2001:db8:2::1/64', 'no shutdown', 'end']);
  a.setIpv6Host('static', A6('2001:db8:1::10'), 64, A6('2001:db8:1::1'));
  c.setIpv6Host('static', A6('2001:db8:1::20'), 64, A6('2001:db8:1::1'));
  b.setIpv6Host('static', A6('2001:db8:2::10'), 64, A6('2001:db8:2::1'));
  net.runUntilIdle();
  assert.equal(ping(net, a, '2001:db8:2::10', { count: 1 }).replies.length, 1);
  cli(r, ['enable', 'conf t', 'ipv6 access-list BLOCK-A', 'deny icmp host 2001:db8:1::10 2001:db8:2::/64 echo-request', 'permit ipv6 any any', 'exit',
    'interface g0/0', 'ipv6 traffic-filter BLOCK-A in', 'end']);
  net.recording = true;
  assert.equal(ping(net, a, '2001:db8:2::10', { count: 2 }).replies.length, 0, 'A заблокирован');
  assert.ok(net.log.some((e) => e.type === 'drop' && /списком доступа IPv6 BLOCK-A/.test(e.reason)));
  assert.equal(ping(net, c, '2001:db8:2::10', { count: 1 }).replies.length, 1, 'C проходит');
  let out = cli(r, ['enable', 'show ipv6 access-list', 'show running-config']).text;
  assert.match(out, /IPv6 access list BLOCK-A\n    deny icmp host 2001:DB8:1::10 2001:DB8:2::\/64 echo-request \(2 matches\) sequence 10\n    permit ipv6 any any \(\d+ match(es)?\) sequence 20/);
  assert.match(out, /^ipv6 access-list BLOCK-A\n deny icmp host 2001:DB8:1::10 2001:DB8:2::\/64 echo-request\n permit ipv6 any any\n!/m);
  assert.match(out, /^ ipv6 traffic-filter BLOCK-A in$/m);
  // исходящий фильтр без permit: неявный deny, но Neighbor Discovery работает
  cli(r, ['enable', 'conf t', 'interface g0/0', 'no ipv6 traffic-filter BLOCK-A in', 'exit', 'ipv6 access-list ONLY-WEB', 'permit tcp any any eq www', 'exit', 'interface g0/1', 'ipv6 traffic-filter ONLY-WEB out', 'end']);
  assert.equal(ping(net, c, '2001:db8:2::10', { count: 1 }).replies.length, 0, 'неявный deny ipv6 any any');
  assert.equal(ping(net, r, '2001:db8:2::10', { count: 1 }).replies.length, 1, 'свои пакеты маршрутизатора исходящий фильтр не проверяет, ND проходит');
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  const r2 = n2.findByName('R1');
  assert.equal(r2.acl6['BLOCK-A'].length, 2);
  assert.equal(r2.ifaceByName('GigabitEthernet0/1').v6acl.out, 'ONLY-WEB');
  assert.match(cli(r2, ['enable', 'show running-config']).text, /permit tcp any any eq 80/);
});
