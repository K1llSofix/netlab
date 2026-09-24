// Маршрутизация IPv6: RIPng, OSPFv3 (области, router-id, OE2), DHCPv6 с сохранением состояния и без него.
const test = require('node:test');
const { NL, assert, mkNet, link, cli, ping } = require('./helpers');

const ip6 = NL.ip6;
const A = (s) => ip6.parse(s);

/** Команды конфигурации; строки подрежимов (не глобальные) получают отступ, как в running-config. */
function ios(dev, text) {
  const errs = [];
  const top = /^(hostname|interface|ipv6 (unicast-routing|route |router |dhcp pool )|router )/;
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (top.test(l) ? l : ' ' + l));
  NL.cliIos.replayConfig(dev, lines, { out: (l) => { if (!NL.cliIos.isInfo(l)) errs.push(l); }, mutate: (fn) => fn() }, false);
  assert.deepEqual(errs, [], dev.name + ': ' + errs.join('; '));
}

/** ПК1 — R1 — R2 — R3 — ПК3, сети 2001:DB8:1::/64 … 2001:DB8:4::/64. proto(r, i) → строки для интерфейсов. */
function chain(ifCfg, extra) {
  const net = mkNet();
  const R = [1, 2, 3].map((i) => net.addDevice('router', { name: 'R' + i }));
  const p1 = net.addDevice('pc', { name: 'PC1' });
  const p3 = net.addDevice('pc', { name: 'PC3' });
  link(net, p1, R[0], 0, 0); link(net, R[0], R[1], 1, 0); link(net, R[1], R[2], 1, 0); link(net, R[2], p3, 1, 0);
  const nets = [['1', '2'], ['2', '3'], ['3', '4']];
  R.forEach((r, i) => {
    ios(r, ['hostname R' + (i + 1), 'ipv6 unicast-routing', (extra && extra[i]) || '',
      'interface g0/0', 'ipv6 address 2001:db8:' + nets[i][0] + '::' + (i === 0 ? '1' : '2') + '/64', ...ifCfg(r, i, 0), 'no shutdown',
      'interface g0/1', 'ipv6 address 2001:db8:' + nets[i][1] + '::1/64', ...ifCfg(r, i, 1), 'no shutdown'].filter(Boolean).join('\n'));
  });
  p1.setIpv6Host('static', A('2001:db8:1::10'), 64, A('2001:db8:1::1'));
  p3.setIpv6Host('static', A('2001:db8:4::10'), 64, A('2001:db8:4::1'));
  net.runUntilIdle();
  return { net, R, p1, p3 };
}

test('RIPng: маршруты R с метрикой, следующий переход — link-local, ping через три маршрутизатора', () => {
  const { net, R, p1 } = chain(() => ['ipv6 rip LAB enable']);
  let out = cli(R[0], ['enable', 'show ipv6 route rip']).text;
  assert.match(out, /^R   2001:DB8:3::\/64 \[120\/2\]\n     via FE80::[0-9A-F:]+, GigabitEthernet0\/1$/m);
  assert.match(out, /^R   2001:DB8:4::\/64 \[120\/3\]/m);
  assert.equal(ping(net, p1, '2001:db8:4::10', { count: 3 }).replies.length, 3);
  out = cli(R[1], ['enable', 'show ipv6 protocols', 'show ipv6 rip', 'show ipv6 rip next-hops', 'show running-config']).text;
  assert.match(out, /IPv6 Routing Protocol is "rip LAB"\n  Interfaces:\n    GigabitEthernet0\/0\n    GigabitEthernet0\/1/);
  assert.match(out, /RIP process "LAB", port 521, multicast-group FF02::9/);
  assert.match(out, /FE80::[0-9A-F:]+\/GigabitEthernet0\/0 \[\d paths\]/);
  assert.match(out, /interface GigabitEthernet0\/0\n[\s\S]*? ipv6 rip LAB enable/);
  assert.match(out, /^ipv6 router rip LAB\n!/m);
  // маршрут по умолчанию от R3 и redistribute static
  ios(R[2], 'ipv6 route 2001:db8:99::/64 2001:db8:4::10\ninterface g0/0\nipv6 rip LAB default-information originate\nipv6 router rip LAB\nredistribute static');
  out = cli(R[0], ['enable', 'show ipv6 route rip']).text;
  assert.match(out, /^R   ::\/0 \[120\/3\]/m);
  assert.match(out, /^R   2001:DB8:99::\/64 \[120\/3\]/m);
  // отказ канала R2—R3: маршруты пропадают
  cli(R[1], ['enable', 'conf t', 'interface g0/1', 'shutdown', 'end']);
  assert.doesNotMatch(cli(R[0], ['enable', 'show ipv6 route']).text, /2001:DB8:4::/);
  // без ipv6 unicast-routing процесс не запускается
  const r = mkNet().addDevice('router');
  assert.match(cli(r, ['enable', 'conf t', 'ipv6 router rip X']).text, /% IPv6 routing not enabled/);
});

test('OSPFv3: router-id, соседи FULL, области (O / OI), cost, passive, OE2, сохранение', () => {
  const area = (i, k) => (i === 0 ? '1' : i === 1 && k === 0 ? '1' : '0');
  const { net, R, p1 } = chain((r, i, k) => ['ipv6 ospf 1 area ' + area(i, k)], ['ipv6 router ospf 1\nrouter-id 1.1.1.1', 'ipv6 router ospf 1\nrouter-id 2.2.2.2', 'ipv6 router ospf 1\nrouter-id 3.3.3.3']);
  let out = cli(R[1], ['enable', 'show ipv6 ospf neighbor']).text;
  assert.match(out, /^1\.1\.1\.1\s+1\s+FULL\/BDR\s+.*GigabitEthernet0\/0$/m);
  assert.match(out, /^3\.3\.3\.3\s+1\s+FULL\/DR\s+.*GigabitEthernet0\/1$/m);
  assert.match(R[1].logBuf.join('\n'), /%OSPFv3-5-ADJCHG: Process 1, Nbr 1\.1\.1\.1 on GigabitEthernet0\/0 from LOADING to FULL, Loading Done/);
  out = cli(R[2], ['enable', 'show ipv6 route ospf']).text;
  assert.match(out, /^OI  2001:DB8:1::\/64 \[110\/3\]/m);
  assert.match(out, /^OI  2001:DB8:2::\/64 \[110\/2\]/m);
  assert.match(cli(R[0], ['enable', 'show ipv6 route ospf']).text, /^O   2001:DB8:2::\/64|^OI  2001:DB8:3::\/64 \[110\/2\]/m);
  assert.equal(ping(net, p1, '2001:db8:4::10', { count: 2 }).replies.length, 2);
  out = cli(R[1], ['enable', 'show ipv6 ospf interface brief', 'show ipv6 ospf']).text;
  assert.match(out, /^Gi0\/0\s+1\s+1\s+\d+\s+1\s+DR\s+1\/1$/m);
  assert.match(out, /Routing Process "ospfv3 1" with ID 2\.2\.2\.2/);
  assert.match(out, /Number of areas in this router is 2/);
  // cost
  ios(R[0], 'interface g0/1\nipv6 ospf cost 50');
  assert.match(cli(R[0], ['enable', 'show ipv6 route ospf']).text, /2001:DB8:4::\/64 \[110\/52\]/);
  // redistribute static → OE2
  ios(R[2], 'ipv6 route 2001:db8:77::/64 2001:db8:4::10\nipv6 router ospf 1\nredistribute static');
  assert.match(cli(R[0], ['enable', 'show ipv6 route ospf']).text, /^OE2 2001:DB8:77::\/64 \[110\/20\]/m);
  out = cli(R[2], ['enable', 'show running-config']).text;
  assert.match(out, /ipv6 router ospf 1\n router-id 3\.3\.3\.3\n log-adjacency-changes\n redistribute static\n!/);
  assert.match(out, /^ ipv6 ospf 1 area 0$/m);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(ping(n2, n2.findByName('PC1'), '2001:db8:4::10', { count: 2 }).replies.length, 2);
  assert.match(cli(n2.findByName('R1'), ['enable', 'show ipv6 route ospf']).text, /OE2 2001:DB8:77::\/64/);
  // passive-interface: сосед пропадает
  ios(R[1], 'ipv6 router ospf 1\npassive-interface g0/1');
  cli(R[1], ['enable', 'show ipv6 ospf neighbor']);
  assert.match(R[1].logBuf.join('\n'), /Nbr 3\.3\.3\.3 on GigabitEthernet0\/1 from FULL to DOWN/);
});

test('OSPFv3 без IPv4-адресов требует router-id', () => {
  const net = mkNet();
  const r = net.addDevice('router');
  const out = cli(r, ['enable', 'conf t', 'ipv6 unicast-routing', 'ipv6 router ospf 5']).text;
  assert.match(out, /%OSPFv3-4-NORTRID: OSPFv3 process 5 could not pick a router-id/);
  assert.match(cli(r, ['enable', 'show ipv6 ospf']).text, /router-id не выбран/);
});

/** R1 (DHCPv6-сервер) — коммутатор — ПК. */
function dhcpLab(serverCfg) {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch', { name: 'SW' });
  const pc = net.addDevice('pc', { name: 'PC' });
  const srv = net.addDevice('server', { name: 'SRV' });
  link(net, r, sw, 0, 23); link(net, pc, sw, 0, 0); link(net, srv, sw, 0, 1);
  srv.setIpv6Host('static', A('2001:db8:1::100'), 64, A('2001:db8:1::1'));
  ios(r, 'ipv6 unicast-routing\n' + serverCfg + '\ninterface g0/0\nipv6 address 2001:db8:1::1/64\nno shutdown');
  net.runUntilIdle();
  return { net, r, pc, srv };
}

test('DHCPv6 с сохранением состояния: ПК получает адрес, шлюз и DNS; show ipv6 dhcp binding', () => {
  const { net, r, pc, srv } = dhcpLab('ipv6 dhcp pool LAN\naddress prefix 2001:db8:1::/64\ndns-server 2001:db8:1::100\ndomain-name lab.local\ninterface g0/0\nipv6 dhcp server LAN\nipv6 nd managed-config-flag');
  net.recording = true;
  pc.setIpv6Host('dhcp');
  net.runUntilIdle();
  const f = pc.iface;
  const lease = f.v6.addrs.find((a) => a.origin === 'dhcp');
  assert.ok(lease, 'адрес получен по DHCPv6');
  assert.equal(ip6.str(lease.addr), '2001:db8:1::11');
  assert.ok(!f.v6.addrs.some((a) => a.origin === 'slaac'), 'SLAAC в режиме DHCPv6 не используется');
  assert.ok(pc.gateway6() && ip6.isLinkLocal(pc.gateway6().addr), 'шлюз — link-local маршрутизатора из RA');
  assert.equal(ping(net, pc, '2001:db8:1::100', { count: 2 }).replies.length, 2);
  assert.equal(ping(net, srv, '2001:db8:1::11', { count: 1 }).replies.length, 1);
  let out = cli(pc, ['ipv6config']).text;
  assert.match(out, /Режим .*: автоматически \(DHCPv6\)/);
  assert.match(out, /IPv6-адрес.*: 2001:db8:1::11\/64/);
  assert.match(out, /DNS-серверы \(IPv6\).*: 2001:db8:1::100/);
  assert.match(out, /DNS-суффикс \(DHCPv6\).*: lab\.local/);
  out = cli(r, ['enable', 'show ipv6 dhcp binding', 'show ipv6 dhcp pool', 'show ipv6 dhcp interface']).text;
  assert.match(out, /Address: 2001:DB8:1::11/);
  assert.match(out, /DHCPv6 pool: LAN\n  Address allocation prefix: 2001:DB8:1::\/64 valid 172800 preferred 86400 \(1 in use, 0 conflicts\)\n  DNS server: 2001:DB8:1::100\n  Domain name: lab\.local\n  Active clients: 1/);
  assert.match(out, /GigabitEthernet0\/0 is in server mode\n  Using pool: LAN/);
  const kinds = net.log.filter((e) => e.type === 'tx' && e.proto === 'DHCPv6').map((e) => NL.packets.summary(e.frame));
  assert.ok(['Solicit', 'Advertise', 'Request', 'Reply'].every((k) => kinds.some((s) => s.includes(k))), kinds.join(' | '));
  out = cli(r, ['enable', 'show running-config']).text;
  assert.match(out, /ipv6 dhcp pool LAN\n address prefix 2001:DB8:1::\/64 lifetime 172800 86400\n dns-server 2001:DB8:1::100\n domain-name lab\.local\n!/);
  assert.match(out, / ipv6 nd managed-config-flag\n ipv6 dhcp server LAN/);
  // /release6 и /renew6
  cli(pc, ['ipconfig /release6']);
  assert.ok(!pc.iface.v6.addrs.some((a) => a.origin === 'dhcp'));
  cli(pc, ['ipconfig /renew6']);
  assert.equal(ip6.str(pc.iface.v6.addrs.find((a) => a.origin === 'dhcp').addr), '2001:db8:1::11', 'тот же клиент — тот же адрес');
  // сохранение: режим DHCPv6, адрес снова запрашивается
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle(50000);
  const p2 = n2.findByName('PC');
  assert.ok(p2.iface.v6.dhcp);
  assert.ok(p2.iface.v6.addrs.some((a) => a.origin === 'dhcp'), 'после загрузки адрес получен заново');
  assert.ok(!JSON.stringify(net.serialize()).includes('2001:db8:1::11'), 'выданный адрес не сохраняется в файл');
});

test('DHCPv6 без сохранения состояния: SLAAC + DNS по флагу O; пул без префикса не выдаёт адрес', () => {
  const { net, r, pc } = dhcpLab('ipv6 dhcp pool INFO\ndns-server 2001:db8:1::53\ninterface g0/0\nipv6 dhcp server INFO\nipv6 nd other-config-flag');
  pc.setIpv6Host('auto');
  net.runUntilIdle();
  assert.ok(pc.iface.v6.addrs.some((a) => a.origin === 'slaac'), 'адрес — SLAAC');
  assert.equal(pc.v6dns.map((x) => ip6.str(x)).join(), '2001:db8:1::53');
  assert.match(cli(pc, ['ipv6config']).text, /DNS-серверы \(IPv6\).*: 2001:db8:1::53/);
  // тот же пул, но ПК просит адрес: NoAddrsAvail
  pc.setIpv6Host('dhcp');
  net.runUntilIdle();
  assert.ok(!pc.iface.v6.addrs.some((a) => a.origin === 'dhcp'));
  assert.match(cli(pc, ['ipv6config']).text, /DHCPv6: сервер не выдаёт адреса/);
  // нет сервера вовсе
  ios(r, 'interface g0/0\nno ipv6 dhcp server INFO');
  cli(pc, ['ipconfig /renew6']);
  net.runUntilIdle();
  assert.match(cli(pc, ['ipv6config']).text, /DHCPv6: нет ответа от DHCPv6-сервера/);
});
