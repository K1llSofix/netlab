// IPv6: адреса, Neighbor Discovery, SLAAC, маршрутизация, команды IOS и ПК, сохранение.
const test = require('node:test');
const { NL, assert, mkNet, link, cli, ping } = require('./helpers');

const ip6 = NL.ip6;
const A = (s) => ip6.parse(s);
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? ip6.str(v) : v));

function ios(dev, text) {
  const errs = [];
  NL.cliIos.replayConfig(dev, text.split('\n'), { out: (l) => { if (!NL.cliIos.isInfo(l)) errs.push(l); }, mutate: (fn) => fn() }, false);
  assert.deepEqual(errs, [], dev.name + ': ' + errs.join('; '));
}

test('адреса IPv6: разбор, сокращённая запись, EUI-64', () => {
  assert.equal(ip6.str(A('2001:0db8:0000:0000:0000:0000:0000:0001')), '2001:db8::1');
  assert.equal(ip6.str(A('2001:db8:0:0:1:0:0:1')), '2001:db8::1:0:0:1');
  assert.equal(ip6.str(A('fe80::1'), true), 'FE80::1');
  assert.equal(A('2001:db8::g'), null);
  assert.equal(A('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(A('::'), 0n);
  assert.equal(ip6.str(ip6.linkLocal('00:D0:BA:12:34:56')), 'fe80::2d0:baff:fe12:3456');
  assert.equal(ip6.cidr(A('2001:db8:1::1'), 64), '2001:db8:1::/64');
  assert.ok(ip6.isLinkLocal(A('fe80::1')) && !ip6.isLinkLocal(A('2001::1')));
  assert.equal(ip6.mcastMac(ip6.solicited(A('2001:db8::1:2:3'))), '33:33:FF:02:00:03');
  assert.equal(NL.util.ipStr(A('2001:db8::5')), '2001:db8::5');
});

test('два ПК в одной сети: ping по IPv6 через коммутатор (Neighbor Discovery)', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const a = net.addDevice('pc', { name: 'A' });
  const b = net.addDevice('pc', { name: 'B' });
  link(net, a, sw);
  link(net, b, sw);
  a.setIpv6Host('static', A('2001:db8::10'), 64, null);
  b.setIpv6Host('static', A('2001:db8::20'), 64, null);
  net.runUntilIdle();
  const r = ping(net, a, '2001:db8::20');
  assert.equal(r.done.received, 4, J(r.events.slice(0, 3)));
  assert.ok(a.nd6Entries().some((e) => e.addr === A('2001:db8::20')));
  // link-local тоже работает
  assert.equal(ping(net, a, ip6.str(b.ll6(b.iface))).done.received, 4);
});

function twoLans() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const s1 = net.addDevice('switch', { name: 'S1' });
  const s2 = net.addDevice('switch', { name: 'S2' });
  link(net, r, s1, 0);
  link(net, r, s2, 1);
  ios(r, 'ipv6 unicast-routing\ninterface GigabitEthernet0/0\n ipv6 address 2001:DB8:1::1/64\n ipv6 address FE80::1 link-local\ninterface GigabitEthernet0/1\n ipv6 address 2001:db8:2::1/64');
  const a = net.addDevice('pc', { name: 'A' });
  const b = net.addDevice('pc', { name: 'B' });
  link(net, a, s1);
  link(net, b, s2);
  a.setIpv6Host('auto');
  b.setIpv6Host('static', A('2001:db8:2::20'), 64, A('2001:db8:2::1'));
  net.runUntilIdle();
  return { net, r, a, b };
}

test('SLAAC: ПК получает адрес и шлюз из Router Advertisement, ping через маршрутизатор', () => {
  const { net, r, a, b } = twoLans();
  const f = a.iface;
  assert.equal(f.v6.addrs.length, 1, 'адрес из RA');
  const got = f.v6.addrs[0].addr;
  assert.ok(ip6.sameNet(got, A('2001:db8:1::'), 64));
  assert.equal(got & ((1n << 64n) - 1n), ip6.eui64(a.ifaceMac(f)));
  assert.equal(a.gateway6().addr, A('fe80::1'));
  const p = ping(net, a, '2001:db8:2::20');
  assert.equal(p.done.received, 4, J(p.events.slice(0, 3)));
  assert.equal(p.replies[0].ttl, 127, 'hop limit (128 у ПК) уменьшился на маршрутизаторе');
  // трассировка
  const hops = [];
  let done = null;
  a.traceroute('2001:db8:2::20', { onEvent: (e) => { if (e.type === 'hop') hops.push(e); if (e.type === 'done') done = e; } });
  net.runUntilIdle();
  assert.ok(done.reached);
  assert.deepEqual(hops.map((h) => ip6.str(h.from)), ['2001:db8:1::1', '2001:db8:2::20']);
  // вывод IOS
  const out = cli(r, ['enable', 'show ipv6 interface brief', 'show ipv6 route', 'show ipv6 neighbors']).text;
  assert.match(out, /GigabitEthernet0\/0\s+\[up\/up\]/);
  assert.match(out, /FE80::1/);
  assert.match(out, /C\s+2001:DB8:1::\/64/);
  assert.match(out, /L\s+2001:DB8:2::1\/128/);
  assert.match(out, /2001:DB8:2::20/);
});

test('без ipv6 unicast-routing маршрутизатор не отвечает на RS и не пересылает IPv6', () => {
  const { net, r, a } = twoLans();
  cli(r, ['enable', 'conf t', 'no ipv6 unicast-routing', 'end']);
  a.setIpv6Host('static', null, 64, null); // забыть адрес, полученный раньше
  a.setIpv6Host('auto');
  net.runUntilIdle();
  assert.equal(a.iface.v6.addrs.length, 0);
  a.setIpv6Host('static', A('2001:db8:1::10'), 64, A('2001:db8:1::1'));
  const p = ping(net, a, '2001:db8:2::20', { count: 1 });
  assert.equal(p.done.received, 0);
  const out = cli(a, ['ipv6config']).text;
  assert.match(out, /2001:db8:1::10\/64/);
});

test('статические маршруты IPv6 между маршрутизаторами и сообщение «адрес недоступен»', () => {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  link(net, r1, r2, 1, 1);
  ios(r1, 'ipv6 unicast-routing\ninterface GigabitEthernet0/0\n ipv6 address 2001:db8:a::1/64\ninterface GigabitEthernet0/1\n ipv6 address 2001:db8:12::1/64\nipv6 route 2001:db8:b::/64 2001:db8:12::2');
  ios(r2, 'ipv6 unicast-routing\ninterface GigabitEthernet0/0\n ipv6 address 2001:db8:b::1/64\ninterface GigabitEthernet0/1\n ipv6 address 2001:db8:12::2/64\nipv6 route ::/0 GigabitEthernet0/1 FE80::' + ip6.str(r1.ll6(r1.ifaces[1]) & ((1n << 64n) - 1n)).replace(/^::/, ''));
  const a = net.addDevice('pc', { name: 'A' });
  const b = net.addDevice('pc', { name: 'B' });
  link(net, a, r1, 0, 0);
  link(net, b, r2, 0, 0);
  a.setIpv6Host('auto');
  b.setIpv6Host('auto');
  net.runUntilIdle();
  const target = ip6.str(b.iface.v6.addrs[0].addr);
  assert.equal(ping(net, a, target).done.received, 4);
  // из маршрутизатора
  const out = cli(r1, ['enable', 'ping ipv6 ' + target]).text;
  assert.match(out, /Success rate is 100 percent/);
  // в несуществующую сеть: R2 сообщает «недоступно» (у R1 маршрута тоже нет)
  const u = ping(net, a, '2001:db8:99::1', { count: 1 });
  assert.ok(u.events.some((e) => e.type === 'unreachable'), J(u.events));
});

test('конфигурация IPv6 в running-config, NVRAM и файле схемы', () => {
  const { net, r, a } = twoLans();
  const text = cli(r, ['enable', 'show running-config']).text;
  assert.match(text, /^ipv6 unicast-routing$/m);
  assert.match(text, /^ ipv6 address FE80::1 link-local$/m);
  assert.match(text, /^ ipv6 address 2001:DB8:1::1\/64$/m);
  // перечитать running-config на чистом маршрутизаторе — получится то же самое
  const net2 = mkNet();
  const r2 = net2.addDevice('router', { name: 'R1' });
  NL.cliIos.replayConfig(r2, NL.cliIos.runningConfig(r), { out() {}, mutate: (fn) => fn() }, true);
  assert.deepEqual(NL.cliIos.runningConfig(r2), NL.cliIos.runningConfig(r));
  // NVRAM: без сохранения IPv6 пропадёт после выключения, после copy run start — останется
  r.saveNvram();
  cli(r, ['enable', 'conf t', 'interface g0/1', 'ipv6 address 2001:db8:3::1/64', 'end']);
  assert.ok(r.nvramDirty());
  net.setPower(r, false);
  net.setPower(r, true);
  assert.ok(!NL.cliIos.runningConfig(r).some((l) => /2001:DB8:3::1/.test(l)));
  assert.ok(NL.cliIos.runningConfig(r).some((l) => /2001:DB8:1::1\/64/.test(l)));
  // файл схемы
  const again = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  again.runUntilIdle();
  const r3 = again.findByName('R1');
  assert.ok(r3.forwarding6());
  const a3 = again.findByName('A');
  assert.ok(a3.iface.v6.autoconfig);
  assert.equal(a3.iface.v6.addrs.length, 1, 'после загрузки ПК снова получил адрес по SLAAC');
  assert.equal(ping(again, a3, '2001:db8:2::20').done.received, 4);
});

test('командная строка ПК: ipconfig и ping по IPv6', () => {
  const { a } = twoLans();
  const out = cli(a, ['ipconfig', 'ping 2001:db8:2::20']).text;
  assert.match(out, /Локальный IPv6-адрес канала/);
  assert.match(out, /IPv6-адрес.*2001:db8:1:/);
  assert.match(out, /Основной шлюз \(IPv6\).*fe80::1/);
  assert.match(out, /Ответ от 2001:db8:2::20: время/);
});

test('описание пакетов IPv6 в симуляции', () => {
  const { net, a } = twoLans();
  net.recording = true;
  ping(net, a, '2001:db8:2::20', { count: 1 });
  const tx = net.log.filter((e) => e.type === 'tx');
  assert.ok(tx.some((e) => e.proto === 'ICMPv6'));
  const echo = tx.find((e) => e.proto === 'ICMPv6');
  assert.match(NL.packets.summary(echo.frame), /Эхо-запрос ICMPv6/);
  const layers = NL.packets.layers(echo.frame);
  assert.equal(layers[0].fields.find((f) => f[0] === 'Тип')[1], '0x86DD IPv6');
  assert.ok(layers.some((l) => l.title.startsWith('IPv6')));
});
