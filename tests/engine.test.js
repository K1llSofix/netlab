// Тесты движка NetLab. Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const NL = require('./load');

const U = NL.util;
const ip = (s) => U.parseIp(s);

/* ---------- помощники ---------- */

function mkNet() { return new NL.Network(); }

function host(net, type, name, cidr, gw, dns) {
  const d = net.addDevice(type, { name });
  if (cidr) {
    const [a, p] = cidr.split('/');
    d.setStatic(ip(a), U.maskFromPrefix(Number(p)), gw ? ip(gw) : null, dns ? ip(dns) : null);
  }
  return d;
}
const pc = (net, name, cidr, gw, dns) => host(net, 'pc', name, cidr, gw, dns);

function routerIf(r, idx, cidr) {
  const [a, p] = cidr.split('/');
  r.setIfaceIp(r.ifaces[idx], ip(a), U.maskFromPrefix(Number(p)));
}

function link(net, a, b, pa, pb) { return net.connect(a.id, pa === undefined ? 'auto' : pa, b.id, pb === undefined ? 'auto' : pb); }

function ping(net, dev, target, opts) {
  const events = [];
  let done = null;
  dev.ping(target, Object.assign({}, opts, { onEvent: (e) => { events.push(e); if (e.type === 'done') done = e; } }));
  net.runUntilIdle(200000);
  assert.ok(done, 'ping должен завершиться');
  return { events, done, replies: events.filter((e) => e.type === 'reply') };
}

function cli(dev, lines) {
  const session = NL.cli.createSession(dev);
  const out = [];
  const io = { out: (l) => out.push(l), write: (t) => out.push(t), mutate: (fn) => fn(), done: () => {} };
  for (const l of lines) {
    NL.cli.exec(dev, session, l, io);
    dev.net.runUntilIdle(200000);
  }
  return { text: out.join('\n'), session };
}

/** Две подсети через маршрутизатор. */
function twoLans() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const s1 = net.addDevice('switch', { name: 'S1' });
  const s2 = net.addDevice('switch', { name: 'S2' });
  routerIf(r, 0, '192.168.1.1/24');
  routerIf(r, 1, '192.168.2.1/24');
  link(net, r, s1, 0);
  link(net, r, s2, 1);
  const a = pc(net, 'A', '192.168.1.10/24', '192.168.1.1');
  const b = pc(net, 'B', '192.168.2.10/24', '192.168.2.1');
  link(net, a, s1);
  link(net, b, s2);
  net.runUntilIdle();
  return { net, r, s1, s2, a, b };
}

/* ---------- адресация ---------- */

test('разбор IP и масок', () => {
  assert.equal(U.ipStr(ip('10.1.2.3')), '10.1.2.3');
  assert.equal(ip('256.1.1.1'), null);
  assert.equal(ip('1.2.3'), null);
  assert.equal(U.parseMask('255.255.255.0'), U.maskFromPrefix(24));
  assert.equal(U.parseMask('/26'), U.maskFromPrefix(26));
  assert.equal(U.parseMask('255.0.255.0'), null);
  assert.equal(U.prefixFromMask(U.parseMask('255.255.255.252')), 30);
  assert.equal(U.ipStr(U.bcast(ip('192.168.1.77'), U.maskFromPrefix(26))), '192.168.1.127');
  assert.match(U.validateHostIp(ip('192.168.1.0'), U.maskFromPrefix(24)), /адрес сети/);
  assert.match(U.validateHostIp(ip('192.168.1.255'), U.maskFromPrefix(24)), /широковещательный/);
  assert.equal(U.validateHostIp(ip('10.0.0.1'), U.maskFromPrefix(31)), null);
});

test('MAC-адреса уникальны', () => {
  const net = mkNet();
  for (let i = 0; i < 20; i++) net.addDevice('switch');
  const all = [];
  for (const d of net.devices.values()) { all.push(d.baseMac); for (const p of d.ports) if (p.mac) all.push(p.mac); }
  assert.equal(new Set(all).size, all.length);
});

/* ---------- базовая связность ---------- */

test('ping через коммутатор: первый пакет не теряется из-за ARP', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, sw);
  link(net, b, sw);
  const r = ping(net, a, '10.0.0.2');
  assert.equal(r.done.received, 4);
  assert.equal(r.done.lost, 0);
  assert.equal(r.replies[0].ttl, 128);
  // коммутатор выучил оба MAC
  assert.equal(sw.macEntries().length, 2);
});

test('ping самого себя', () => {
  const net = mkNet();
  const a = pc(net, 'A', '10.0.0.1/24');
  assert.equal(ping(net, a, '10.0.0.1').done.received, 4);
});

test('ping через маршрутизатор: TTL уменьшается', () => {
  const { net, a } = twoLans();
  const r = ping(net, a, '192.168.2.10');
  assert.equal(r.done.received, 4);
  assert.equal(r.replies[0].ttl, 127);
});

test('без шлюза — «нет маршрута» и понятная подсказка', () => {
  const { net, a } = twoLans();
  a.setStatic(ip('192.168.1.10'), U.maskFromPrefix(24), null, null);
  const r = ping(net, a, '192.168.2.10');
  assert.equal(r.done.received, 0);
  assert.ok(r.events.some((e) => e.type === 'error' && e.code === 'no-route'));
  const out = cli(a, ['ping 192.168.2.10']).text;
  assert.match(out, /основной шлюз не задан/);
});

test('несуществующий узел в своей сети — ARP не отвечает', () => {
  const { net, a } = twoLans();
  const r = ping(net, a, '192.168.1.99', { count: 2 });
  assert.equal(r.done.lost, 2);
  assert.ok(r.events.every((e) => e.type !== 'error' || e.code === 'arp-fail'));
});

test('маршрутизатор сообщает «узел недоступен», если ARP за ним не отвечает', () => {
  const { net, a } = twoLans();
  const r = ping(net, a, '192.168.2.99', { count: 1 });
  const u = r.events.find((e) => e.type === 'unreachable');
  assert.ok(u);
  assert.equal(u.code, 1);
  assert.equal(U.ipStr(u.from), '192.168.1.1');
});

test('нет маршрута на маршрутизаторе — «сеть недоступна»', () => {
  const { net, a } = twoLans();
  const r = ping(net, a, '172.16.0.5', { count: 1 });
  const u = r.events.find((e) => e.type === 'unreachable');
  assert.ok(u);
  assert.equal(u.code, 0);
});

test('петля маршрутизации — TTL истекает', () => {
  const net = mkNet();
  const r1 = net.addDevice('router');
  const r2 = net.addDevice('router');
  routerIf(r1, 0, '10.0.0.1/30');
  routerIf(r2, 0, '10.0.0.2/30');
  routerIf(r1, 1, '192.168.1.1/24');
  link(net, r1, r2, 0, 0);
  const s = net.addDevice('switch');
  link(net, r1, s, 1);
  const a = pc(net, 'A', '192.168.1.10/24', '192.168.1.1');
  link(net, a, s);
  r1.addRoute(0, 0, ip('10.0.0.2'));
  r2.addRoute(0, 0, ip('10.0.0.1'));
  const r = ping(net, a, '8.8.8.8', { count: 1 });
  assert.ok(r.events.some((e) => e.type === 'ttl-expired'));
});

test('трассировка через два маршрутизатора', () => {
  const net = mkNet();
  const r1 = net.addDevice('router');
  const r2 = net.addDevice('router');
  routerIf(r1, 0, '192.168.1.1/24');
  routerIf(r1, 1, '10.0.0.1/30');
  routerIf(r2, 1, '10.0.0.2/30');
  routerIf(r2, 0, '192.168.2.1/24');
  link(net, r1, r2, 1, 1);
  r1.addRoute(ip('192.168.2.0'), U.maskFromPrefix(24), ip('10.0.0.2'));
  r2.addRoute(ip('192.168.1.0'), U.maskFromPrefix(24), ip('10.0.0.1'));
  const a = pc(net, 'A', '192.168.1.10/24', '192.168.1.1');
  const b = pc(net, 'B', '192.168.2.10/24', '192.168.2.1');
  link(net, a, r1, 0, 0);
  link(net, b, r2, 0, 0);
  const hops = [];
  let done = null;
  a.traceroute('192.168.2.10', { onEvent: (e) => { if (e.type === 'hop') hops.push(e); if (e.type === 'done') done = e; } });
  net.runUntilIdle();
  assert.ok(done.reached);
  assert.deepEqual(hops.map((h) => U.ipStr(h.from)), ['192.168.1.1', '10.0.0.2', '192.168.2.10']);
  assert.ok(hops.every((h) => h.rtts.every((x) => x != null)));
});

test('broadcast ping получает ответы от всех узлов подсети', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const a = pc(net, 'A', '10.0.0.1/24');
  link(net, a, sw);
  for (let i = 2; i <= 5; i++) link(net, pc(net, 'P' + i, '10.0.0.' + i + '/24'), sw);
  const r = ping(net, a, '10.0.0.255', { count: 1 });
  assert.equal(new Set(r.replies.map((e) => e.from)).size, 4);
});

test('концентратор повторяет кадры, «чужие» кадры отбрасываются узлами', () => {
  const net = mkNet();
  const hub = net.addDevice('hub');
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  const c = pc(net, 'C', '10.0.0.3/24');
  [a, b, c].forEach((d) => link(net, d, hub));
  net.recording = true;
  assert.equal(ping(net, a, '10.0.0.2').done.received, 4);
  const drops = net.log.filter((e) => e.type === 'drop' && e.dev === c.id);
  assert.ok(drops.length > 0, 'C должен видеть и отбрасывать чужие кадры');
});

/* ---------- STP и петли ---------- */

test('STP: кольцо из трёх коммутаторов — ровно один порт заблокирован, ping работает', () => {
  const net = mkNet();
  const s = [0, 1, 2].map(() => net.addDevice('switch'));
  link(net, s[0], s[1], 24, 24);
  link(net, s[1], s[2], 25, 24);
  link(net, s[2], s[0], 25, 25);
  const blocked = () => s.flatMap((x) => x.ports.filter((p) => p.stp === 'blocking'));
  assert.equal(blocked().length, 1);
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, s[0]);
  link(net, b, s[2]);
  const r = ping(net, a, '10.0.0.2');
  assert.equal(r.done.received, 4);
  assert.ok(net.inFlight.size === 0);
  // корень — мост с наименьшим (приоритет, MAC); меняем приоритет — корень меняется
  s[2].setStpPriority(4096);
  net.refreshTopology();
  assert.ok(s[2].stpInfo.isRoot);
  assert.equal(blocked().length, 1);
  assert.equal(ping(net, a, '10.0.0.2').done.received, 4);
});

test('STP: отказ канала — резервный путь разблокируется', () => {
  const net = mkNet();
  const s1 = net.addDevice('switch');
  const s2 = net.addDevice('switch');
  const l1 = link(net, s1, s2, 24, 24);
  link(net, s1, s2, 25, 25);
  assert.equal([...s1.ports, ...s2.ports].filter((p) => p.stp === 'blocking').length, 1);
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, s1);
  link(net, b, s2);
  assert.equal(ping(net, a, '10.0.0.2').done.received, 4);
  net.disconnect(l1.id);
  assert.equal([...s1.ports, ...s2.ports].filter((p) => p.stp === 'blocking').length, 0);
  assert.equal(ping(net, a, '10.0.0.2').done.received, 4);
});

test('петля из концентраторов не вешает симулятор', () => {
  const net = mkNet();
  const h1 = net.addDevice('hub');
  const h2 = net.addDevice('hub');
  link(net, h1, h2);
  link(net, h1, h2);
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, h1);
  link(net, b, h2);
  const warns = [];
  net.on((t, d) => { if (t === 'warn') warns.push(d); });
  a.ping('10.0.0.2', { count: 1 });
  net.runUntilIdle(5000);
  assert.ok(net.inFlight.size <= 4000);
  assert.ok(warns.length > 0 || net.inFlight.size === 0);
});

/* ---------- VLAN ---------- */

function vlanLab() {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const a = pc(net, 'A', '192.168.10.10/24', '192.168.10.1');
  const b = pc(net, 'B', '192.168.20.10/24', '192.168.20.1');
  const c = pc(net, 'C', '192.168.10.11/24', '192.168.10.1');
  link(net, a, sw, 0, 0);
  link(net, b, sw, 0, 1);
  link(net, c, sw, 0, 2);
  sw.setAccessVlan(0, 10);
  sw.setAccessVlan(1, 20);
  sw.setAccessVlan(2, 10);
  return { net, sw, a, b, c };
}

test('VLAN изолируют трафик', () => {
  const { net, a, c } = vlanLab();
  assert.equal(ping(net, a, '192.168.10.11').done.received, 4);
  // тот же IP-диапазон, но C переведён в VLAN 20 — связь пропадает
  const { net: n2, sw, a: a2 } = vlanLab();
  sw.setAccessVlan(2, 20);
  assert.equal(ping(n2, a2, '192.168.10.11', { count: 1 }).done.received, 0);
  assert.ok(c);
});

test('router-on-a-stick: маршрутизация между VLAN через транк', () => {
  const { net, sw, a, b } = vlanLab();
  const r = net.addDevice('router', { name: 'R' });
  link(net, r, sw, 0, 24);
  sw.setPortMode(24, 'trunk');
  const s10 = r.addSubif(0, 10, 10);
  const s20 = r.addSubif(0, 20, 20);
  r.setIfaceIp(s10, ip('192.168.10.1'), U.maskFromPrefix(24));
  r.setIfaceIp(s20, ip('192.168.20.1'), U.maskFromPrefix(24));
  const res = ping(net, a, '192.168.20.10');
  assert.equal(res.done.received, 4);
  assert.equal(res.replies[0].ttl, 127);
  assert.ok(b);
});

test('транк между коммутаторами; VLAN должен существовать на обоих', () => {
  const net = mkNet();
  const s1 = net.addDevice('switch');
  const s2 = net.addDevice('switch');
  link(net, s1, s2, 24, 24);
  s1.setPortMode(24, 'trunk');
  s2.setPortMode(24, 'trunk');
  const a = pc(net, 'A', '10.10.0.1/24');
  const b = pc(net, 'B', '10.10.0.2/24');
  link(net, a, s1, 0, 0);
  link(net, b, s2, 0, 0);
  s1.setAccessVlan(0, 10);
  s2.setAccessVlan(0, 10);
  assert.equal(ping(net, a, '10.10.0.2').done.received, 4);
  // allowed vlan без 10 — связи нет
  s1.setAllowedVlans(24, '1,20');
  assert.equal(ping(net, a, '10.10.0.2', { count: 1 }).done.received, 0);
  s1.setAllowedVlans(24, 'all');
  assert.equal(ping(net, a, '10.10.0.2', { count: 1 }).done.received, 1);
});

test('access-порт отбрасывает тегированные кадры, узел — тоже', () => {
  const net = mkNet();
  const s1 = net.addDevice('switch');
  const s2 = net.addDevice('switch');
  link(net, s1, s2, 24, 24);
  s1.setPortMode(24, 'trunk');
  s2.setPortMode(24, 'access'); // на другой стороне статический access — несогласованность (без него DTP согласовал бы транк)
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, s1, 0, 0);
  link(net, b, s2, 0, 0);
  s1.setAccessVlan(0, 10);
  s2.setAccessVlan(0, 10);
  s2.setAccessVlan(24, 10);
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).done.received, 0);
});

/* ---------- DHCP ---------- */

function dhcpServerLab(n) {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const srv = host(net, 'server', 'SRV', '192.168.1.2/24', '192.168.1.1');
  link(net, srv, sw);
  srv.dhcpd.enabled = true;
  srv.dhcpd.setPool({ name: 'LAN', start: ip('192.168.1.100'), end: ip('192.168.1.199'), mask: U.maskFromPrefix(24), gateway: ip('192.168.1.1'), dns: ip('192.168.1.2') });
  const pcs = [];
  for (let i = 0; i < n; i++) {
    const p = net.addDevice('pc');
    link(net, p, sw);
    p.setDhcp();
    pcs.push(p);
  }
  net.runUntilIdle();
  return { net, sw, srv, pcs };
}

test('DHCP: 20 компьютеров получают разные адреса из пула', () => {
  const { pcs, srv } = dhcpServerLab(20);
  const ips = pcs.map((p) => p.iface.ip);
  assert.ok(ips.every((x) => x != null && x >= ip('192.168.1.100') && x <= ip('192.168.1.199')));
  assert.equal(new Set(ips).size, 20);
  assert.ok(pcs.every((p) => p.gateway === ip('192.168.1.1') && p.dns === ip('192.168.1.2')));
  assert.equal(srv.dhcpd.leaseList().length, 20);
});

test('DHCP: занятый вручную адрес обнаруживается ARP-пробой и пропускается', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const srv = host(net, 'server', 'SRV', '192.168.1.2/24');
  link(net, srv, sw);
  srv.dhcpd.enabled = true;
  srv.dhcpd.setPool({ name: 'LAN', start: ip('192.168.1.100'), end: ip('192.168.1.110'), mask: U.maskFromPrefix(24) });
  const squatter = pc(net, 'X', '192.168.1.100/24');
  link(net, squatter, sw);
  const p = net.addDevice('pc');
  link(net, p, sw);
  p.setDhcp();
  net.runUntilIdle();
  assert.equal(U.ipStr(p.iface.ip), '192.168.1.101');
  assert.equal(squatter.conflict, null);
});

test('DHCP: нет сервера — APIPA, затем адрес после включения службы', () => {
  const { net, srv, pcs } = (() => {
    const r = dhcpServerLab(0);
    r.srv.dhcpd.enabled = false;
    const p = r.net.addDevice('pc');
    link(r.net, p, r.sw);
    p.setDhcp();
    r.net.runUntilIdle();
    return { net: r.net, srv: r.srv, pcs: [p] };
  })();
  assert.equal(U.ipStr(pcs[0].iface.ip).startsWith('169.254.'), true);
  srv.dhcpd.enabled = true;
  pcs[0].startDhcp();
  net.runUntilIdle();
  assert.equal(U.ipStr(pcs[0].iface.ip).startsWith('192.168.1.'), true);
});

test('DHCP relay (ip helper-address): адрес из пула нужной сети', () => {
  const net = mkNet();
  const r = net.addDevice('router');
  const s1 = net.addDevice('switch');
  const s2 = net.addDevice('switch');
  routerIf(r, 0, '10.0.0.1/24');
  routerIf(r, 1, '10.0.1.1/24');
  link(net, r, s1, 0);
  link(net, r, s2, 1);
  const srv = host(net, 'server', 'SRV', '10.0.0.2/24', '10.0.0.1');
  link(net, srv, s1);
  srv.dhcpd.enabled = true;
  srv.dhcpd.setPool({ name: 'NET0', start: ip('10.0.0.100'), mask: U.maskFromPrefix(24), gateway: ip('10.0.0.1') });
  srv.dhcpd.setPool({ name: 'NET1', start: ip('10.0.1.100'), mask: U.maskFromPrefix(24), gateway: ip('10.0.1.1') });
  r.ifaces[1].helper = ip('10.0.0.2');
  const p0 = net.addDevice('pc');
  const p1 = net.addDevice('pc');
  link(net, p0, s1);
  link(net, p1, s2);
  p0.setDhcp();
  p1.setDhcp();
  net.runUntilIdle();
  assert.equal(U.ipStr(p0.iface.ip), '10.0.0.100');
  assert.equal(U.ipStr(p1.iface.ip), '10.0.1.100');
  assert.equal(U.ipStr(p1.gateway), '10.0.1.1');
  assert.equal(ping(net, p1, '10.0.0.2').done.received, 4);
});

test('DHCP на маршрутизаторе, настроенный через CLI', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch');
  link(net, r, sw, 0);
  const out = cli(r, [
    'en', 'conf t',
    'int g0/0', 'ip add 192.168.5.1 255.255.255.0', 'no shut', 'exit',
    'ip dhcp excluded-address 192.168.5.1 192.168.5.9',
    'ip dhcp pool OFFICE', 'network 192.168.5.0 255.255.255.0', 'default-router 192.168.5.1', 'dns-server 8.8.8.8', 'end',
  ]).text;
  assert.doesNotMatch(out, /^%(?!LINK)/m);
  const p = net.addDevice('pc');
  link(net, p, sw);
  p.setDhcp();
  net.runUntilIdle();
  assert.equal(U.ipStr(p.iface.ip), '192.168.5.10');
  assert.equal(U.ipStr(p.gateway), '192.168.5.1');
  assert.equal(U.ipStr(p.dns), '8.8.8.8');
  const show = cli(r, ['en', 'sh ip dhcp binding']).text;
  assert.match(show, /192\.168\.5\.10/);
});

/* ---------- DNS ---------- */

test('DNS: ping по имени и nslookup', () => {
  const { net, a, b } = twoLans();
  const srv = host(net, 'server', 'DNS', '192.168.2.53/24', '192.168.2.1');
  link(net, srv, net.findByName('S2'));
  srv.dnsd.enabled = true;
  srv.dnsd.setRecord('b.lab', ip('192.168.2.10'));
  a.setStatic(a.iface.ip, a.iface.mask, a.gateway, ip('192.168.2.53'));
  const r = ping(net, a, 'B.lab');
  assert.equal(r.done.received, 4);
  assert.equal(U.ipStr(r.done.ip), '192.168.2.10');
  assert.match(cli(a, ['nslookup b.lab']).text, /192\.168\.2\.10/);
  assert.match(cli(a, ['nslookup nope.lab']).text, /Не удалось найти/);
  assert.ok(b);
});

/* ---------- Почта ---------- */

test('почта: письмо нескольким получателям — каждый получает ровно одну копию', () => {
  const { net, a, b } = twoLans();
  const s1 = net.findByName('S1');
  const locals = [];
  for (let i = 0; i < 4; i++) {
    const p = pc(net, 'L' + i, '192.168.1.' + (20 + i) + '/24', '192.168.1.1');
    link(net, p, s1);
    locals.push(p);
  }
  const srv = host(net, 'server', 'DNS', '192.168.1.53/24', '192.168.1.1');
  link(net, srv, s1);
  srv.dnsd.enabled = true;
  srv.dnsd.setRecord('bob.lab', ip('192.168.2.10'));
  a.setStatic(a.iface.ip, a.iface.mask, a.gateway, ip('192.168.1.53'));

  const msg = a.sendMail([
    '192.168.1.20', '192.168.1.21', '192.168.1.22', '192.168.1.23', // та же сеть
    'bob.lab',        // через DNS и маршрутизатор
    '192.168.1.99',   // нет такого узла в своей сети
    '192.168.2.99',   // нет такого узла за маршрутизатором
    '172.16.0.1',     // нет маршрута
    'nobody.lab',     // имя не найдено
    '192.168.1.20',   // дубликат — должен быть убран
  ], 'Привет', 'Текст письма');
  net.runUntilIdle();

  assert.equal(msg.items.length, 9);
  const st = Object.fromEntries(msg.items.map((it) => [it.target, it.status]));
  for (const t of ['192.168.1.20', '192.168.1.21', '192.168.1.22', '192.168.1.23', 'bob.lab']) assert.equal(st[t], 'ok', t);
  for (const t of ['192.168.1.99', '192.168.2.99', '172.16.0.1', 'nobody.lab']) assert.equal(st[t], 'fail', t);
  for (const p of locals) {
    assert.equal(p.inbox.length, 1, p.name);
    assert.equal(p.inbox[0].subject, 'Привет');
    assert.equal(p.inbox[0].from, 'A');
  }
  assert.equal(b.inbox.length, 1);
  const why = Object.fromEntries(msg.items.map((it) => [it.target, it.text]));
  assert.match(why['192.168.2.99'], /недоступен/);
  assert.match(why['172.16.0.1'], /нет маршрута/i);
  assert.match(why['nobody.lab'], /не знает/);
});

test('почта: потерянные подтверждения не создают дубликатов у получателя', () => {
  const { net, a, b } = twoLans();
  // у B неверный шлюз: письмо дойдёт, а подтверждение — нет
  b.setStatic(b.iface.ip, b.iface.mask, ip('192.168.2.254'), null);
  const msg = a.sendMail(['192.168.2.10'], 'Тема', 'Текст');
  net.runUntilIdle();
  assert.equal(b.inbox.length, 1, 'повторы должны распознаваться как дубликаты');
  assert.equal(msg.items[0].status, 'fail');
  assert.match(msg.items[0].text, /Нет подтверждения/);
});

test('почта: рассылка всем в подсети', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const a = pc(net, 'A', '10.0.0.1/24');
  link(net, a, sw);
  const others = [];
  for (let i = 2; i <= 6; i++) { const p = pc(net, 'P' + i, '10.0.0.' + i + '/24'); link(net, p, sw); others.push(p); }
  const msg = a.sendMail(['*'], 'Всем', 'Собрание в 15:00');
  net.runUntilIdle();
  assert.equal(msg.items[0].status, 'ok');
  assert.equal(msg.items[0].acks.length, 5);
  assert.ok(others.every((p) => p.inbox.length === 1));
  assert.equal(a.inbox.length, 0);
});

test('почта: выключенный получатель — ошибка, остальные получают', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  const c = pc(net, 'C', '10.0.0.3/24');
  [a, b, c].forEach((d) => link(net, d, sw));
  assert.equal(ping(net, a, '10.0.0.3', { count: 1 }).done.received, 1); // C есть в ARP-кэше
  net.setPower(c, false);
  const msg = a.sendMail(['10.0.0.2', '10.0.0.3'], 's', 'b');
  net.runUntilIdle();
  assert.equal(msg.items[0].status, 'ok');
  assert.equal(msg.items[1].status, 'fail');
  assert.equal(b.inbox.length, 1);
});

/* ---------- устойчивость ---------- */

test('обрыв кабеля во время передачи не ломает симуляцию', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, sw);
  const lb = link(net, b, sw);
  const events = [];
  a.ping('10.0.0.2', { onEvent: (e) => events.push(e) });
  net.step();
  net.step();
  net.disconnect(lb.id);
  net.runUntilIdle();
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.equal(done.received, 0);
});

test('удаление устройства с запущенным ping завершает задачу', () => {
  const { net, a } = twoLans();
  let done = null;
  a.ping('192.168.2.10', { count: Infinity, onEvent: (e) => { if (e.type === 'done') done = e; } });
  net.run(50);
  net.removeDevice(a.id);
  assert.ok(done && done.cancelled);
  net.runUntilIdle();
});

test('конфликт IP-адресов обнаруживается обеими сторонами', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const a = pc(net, 'A', '10.0.0.5/24');
  const b = net.addDevice('pc');
  link(net, a, sw);
  link(net, b, sw);
  b.setStatic(ip('10.0.0.5'), U.maskFromPrefix(24), null, null);
  net.runUntilIdle();
  assert.ok(a.conflict);
  assert.ok(b.conflict);
});

test('шлюз вне подсети отклоняется с понятной ошибкой', () => {
  const net = mkNet();
  const a = net.addDevice('pc');
  assert.throws(() => a.setStatic(ip('10.0.0.5'), U.maskFromPrefix(24), ip('10.0.1.1'), null), /не в сети/);
});

test('сохранение и загрузка: конфигурация и связность сохраняются', () => {
  const { net } = twoLans();
  const r = net.findByName('R1');
  r.addRoute(ip('10.9.0.0'), U.maskFromPrefix(16), ip('192.168.2.200'));
  const s = net.findByName('S1');
  s.addVlan(30, 'Guests');
  const data = JSON.parse(JSON.stringify(net.serialize()));
  const net2 = NL.Network.deserialize(data);
  assert.deepEqual(JSON.parse(JSON.stringify(net2.serialize())), data);
  const a2 = net2.findByName('A');
  assert.equal(ping(net2, a2, '192.168.2.10').done.received, 4);
  // новые устройства после загрузки получают новые уникальные MAC
  const extra = net2.addDevice('switch');
  const macs = new Set();
  for (const d of net2.devices.values()) for (const p of d.ports) if (p.mac) macs.add(p.mac);
  assert.ok(extra);
  let total = 0;
  for (const d of net2.devices.values()) total += d.ports.filter((p) => p.mac).length;
  assert.equal(macs.size, total);
});

test('загрузка DHCP-клиентов сохраняет выданные адреса', () => {
  const { net, pcs } = dhcpServerLab(3);
  const before = pcs.map((p) => p.iface.ip);
  const net2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  net2.runUntilIdle();
  const after = pcs.map((p) => net2.getDevice(p.id).iface.ip);
  assert.deepEqual(after, before);
});

test('кабель: нельзя занять занятый порт или соединить устройство с собой', () => {
  const net = mkNet();
  const a = net.addDevice('pc');
  const b = net.addDevice('pc');
  const c = net.addDevice('pc');
  link(net, a, b);
  assert.throws(() => link(net, a, c), /нет свободных/i);
  assert.throws(() => net.connect(a.id, 0, a.id, 0), /само с собой/);
});

/* ---------- CLI ---------- */

test('IOS CLI: интерфейсы, маршруты, show', () => {
  const { net, r, a } = twoLans();
  const res = cli(r, ['en', 'conf t', 'ip route 10.0.0.0 255.0.0.0 192.168.2.254', 'int g0/2', 'ip add 172.16.0.1 255.255.0.0', 'no shut', 'end', 'sh ip route', 'sh ip int br', 'show run']);
  assert.match(res.text, /S\s+10\.0\.0\.0\/8 \[1\/0\] via 192\.168\.2\.254/);
  assert.match(res.text, /C\s+192\.168\.1\.0\/24 is directly connected, GigabitEthernet0\/0/);
  assert.match(res.text, /ip route 10\.0\.0\.0 255\.0\.0\.0 192\.168\.2\.254/);
  assert.equal(res.session.mode, 'exec');
  const bad = cli(r, ['en', 'conf t', 'int g0/1', 'ip add 192.168.1.5 255.255.255.0']).text;
  assert.match(bad, /пересекается/);
  const shut = cli(r, ['en', 'conf t', 'int g0/1', 'shutdown']);
  assert.ok(shut);
  assert.equal(ping(net, a, '192.168.2.10', { count: 1 }).done.received, 0);
  cli(r, ['en', 'conf t', 'int g0/1', 'no sh']);
  assert.equal(ping(net, a, '192.168.2.10', { count: 1 }).done.received, 1);
});

test('IOS CLI коммутатора: VLAN, access, trunk, range', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW1' });
  const out = cli(sw, ['en', 'conf t', 'vlan 10', 'name Sales', 'exit', 'int range fa0/1 - 4', 'switchport mode access', 'switchport access vlan 10', 'int g0/1', 'sw mode trunk', 'sw trunk allowed vlan 1,10', 'end', 'sh vlan br', 'sh int trunk']).text;
  assert.doesNotMatch(out, /Invalid/);
  assert.deepEqual(sw.ports.slice(0, 4).map((p) => p.vlan), [10, 10, 10, 10]);
  assert.equal(sw.ports[4].vlan, 1);
  assert.equal(sw.vlans.get(10), 'Sales');
  assert.equal(sw.ports[24].mode, 'trunk');
  assert.equal(sw.ports[24].allowed, '1,10');
  assert.match(out, /10\s+Sales\s+active\s+Fa0\/1, Fa0\/2, Fa0\/3, Fa0\/4/);
});

test('IOS CLI: router-on-a-stick через подынтерфейсы', () => {
  const { net, sw, a } = vlanLab();
  const r = net.addDevice('router', { name: 'R' });
  link(net, r, sw, 0, 24);
  cli(sw, ['en', 'conf t', 'int g0/1', 'switchport mode trunk']);
  const out = cli(r, ['en', 'conf t', 'int g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0', 'int g0/0.20', 'encapsulation dot1q 20', 'ip address 192.168.20.1 255.255.255.0', 'end']).text;
  assert.doesNotMatch(out, /^%(?!LINK)/m);
  assert.equal(ping(net, a, '192.168.20.10').done.received, 4);
});

test('Windows-консоль: ipconfig, arp, неизвестная команда', () => {
  const { net, a } = twoLans();
  ping(net, a, '192.168.1.1', { count: 1 });
  const out = cli(a, ['ipconfig', 'ipconfig /all', 'arp -a', 'foo']).text;
  assert.match(out, /IPv4-адрес[ .]+: 192\.168\.1\.10/);
  assert.match(out, /Основной шлюз[ .]+: 192\.168\.1\.1/);
  assert.match(out, /192\.168\.1\.1\s+00-d0/);
  assert.match(out, /не является внутренней или внешней командой/);
});

test('журнал симуляции содержит пояснения решений', () => {
  const { net, a } = twoLans();
  net.recording = true;
  ping(net, a, '192.168.2.10', { count: 1 });
  const tx = net.log.filter((e) => e.type === 'tx');
  assert.ok(tx.some((e) => /нет в таблице|есть в таблице/.test(e.why)));
  assert.ok(tx.some((e) => /подключена напрямую/.test(e.why)));
  assert.ok(tx.every((e) => e.proto));
});

/* ---------- готовые примеры ---------- */

test('все примеры собираются, и в каждом все узлы видят друг друга', () => {
  NL.ui = NL.ui || {};
  require('../js/ui/examples.js');
  assert.ok(NL.ui.EXAMPLES.length >= 5);
  for (const ex of NL.ui.EXAMPLES) {
    const net = ex.build();
    net.runUntilIdle(20000);
    const hosts = [...net.devices.values()].filter((d) => d.iface);
    for (const hst of hosts) {
      assert.ok(hst.iface.ip != null, ex.id + ': у ' + hst.name + ' нет адреса');
      assert.ok(!U.ipStr(hst.iface.ip).startsWith('169.254.'), ex.id + ': ' + hst.name + ' не получил адрес по DHCP');
      assert.equal(hst.conflict, null, ex.id + ': конфликт IP у ' + hst.name);
    }
    for (const a of hosts) {
      for (const b of hosts) {
        if (a === b || ex.mesh === false) continue;
        const r = ping(net, a, U.ipStr(b.iface.ip), { count: 1 });
        assert.equal(r.done.received, 1, ex.id + ': ' + a.name + ' → ' + b.name);
      }
    }
    // сохранение/загрузка примера не теряет ничего
    const data = JSON.parse(JSON.stringify(net.serialize()));
    const loaded = NL.Network.deserialize(data);
    loaded.runUntilIdle(20000);
    const again = JSON.parse(JSON.stringify(loaded.serialize()));
    // WAN-порт WRT300N после загрузки заново получает адрес по DHCP (номер транзакции растёт) — это не потеря данных
    delete data.counters.xid;
    delete again.counters.xid;
    assert.deepEqual(again, data, ex.id);
  }
});
