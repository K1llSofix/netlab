// SNMP (агент IOS + MIB Browser) и NetFlow (учёт потоков, экспорт, коллектор).
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping, run } = require('./helpers');

const U = NL.util;

function lab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const s1 = net.addDevice('switch', { name: 'S1' });
  const s2 = net.addDevice('switch', { name: 'S2' });
  routerIf(r, 0, '192.168.1.1/24');
  routerIf(r, 1, '192.168.2.1/24');
  link(net, r, s1, 0);
  link(net, r, s2, 1);
  const admin = pc(net, 'Admin', '192.168.1.10/24', '192.168.1.1');
  const srv = net.addDevice('server', { name: 'Srv' });
  srv.setStatic(U.parseIp('192.168.2.10'), U.maskFromPrefix(24), U.parseIp('192.168.2.1'), null);
  link(net, admin, s1);
  link(net, srv, s2);
  net.runUntilIdle();
  return { net, r, admin, srv };
}

test('SNMP: get/getnext/walk/set с правами RO и RW, неверная community — тишина', () => {
  const { net, r, admin } = lab();
  cli(r, ['enable', 'conf t', 'snmp-server community public RO', 'snmp-server community private RW', 'snmp-server location Moscow', 'end']);
  const ip = U.parseIp('192.168.1.1');
  const g = run(net, (cb) => admin.snmpRequest(ip, 'public', 'get', ['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.6.0'], cb));
  assert.ok(g.ok, JSON.stringify(g));
  assert.deepEqual(g.varbinds.map((v) => v.value), ['Router', 'Moscow']);
  const n = run(net, (cb) => admin.snmpRequest(ip, 'public', 'getnext', ['1.3.6.1.2.1.1.4.0'], cb));
  assert.equal(n.varbinds[0].name, 'sysName');
  const rows = [];
  const w = run(net, (cb) => admin.snmpWalk(ip, 'public', '1.3.6.1.2.1.2.2.1.2', (v) => rows.push(v.value), cb));
  assert.ok(w.ok);
  assert.ok(rows.includes('GigabitEthernet0/0') && rows.includes('GigabitEthernet0/1'), rows.join(','));
  // RO не может менять
  const ro = run(net, (cb) => admin.snmpRequest(ip, 'public', 'set', [{ oid: '1.3.6.1.2.1.1.5.0', value: 'Core' }], cb));
  assert.equal(ro.error, 'readOnly');
  // RW меняет hostname — как настоящий агент
  const rw = run(net, (cb) => admin.snmpRequest(ip, 'private', 'set', [{ oid: '1.3.6.1.2.1.1.5.0', value: 'Core' }], cb));
  assert.ok(rw.ok, JSON.stringify(rw));
  assert.equal(r.ios.hostname, 'Core');
  // выключить интерфейс через ifAdminStatus
  const idx = rows.indexOf('GigabitEthernet0/1') + 1;
  run(net, (cb) => admin.snmpRequest(ip, 'private', 'set', [{ oid: '1.3.6.1.2.1.2.2.1.7.' + idx, value: 2 }], cb));
  assert.equal(r.ifaceByName('GigabitEthernet0/1').adminUp, false);
  // неверная community — агент молчит, клиент сообщает о тайм-ауте
  const bad = run(net, (cb) => admin.snmpRequest(ip, 'wrong', 'get', ['1.3.6.1.2.1.1.5.0'], cb));
  assert.equal(bad.error, 'timeout');
  const sh = cli(r, ['enable', 'show snmp', 'show running-config']).text;
  assert.match(sh, /Unknown community name/);
  assert.match(sh, /^snmp-server community public RO$/m);
  assert.match(sh, /^snmp-server community private RW$/m);
  // без community агент выключен — «порт закрыт»
  cli(r, ['enable', 'conf t', 'no snmp-server community public', 'no snmp-server community private', 'end']);
  const off = run(net, (cb) => admin.snmpRequest(ip, 'public', 'get', ['1.3.6.1.2.1.1.5.0'], cb));
  assert.equal(off.error, 'unreachable');
});

test('SNMP: счётчики интерфейсов растут с трафиком, список доступа на community', () => {
  const { net, r, admin, srv } = lab();
  cli(r, ['enable', 'conf t', 'access-list 5 permit host 192.168.2.10', 'snmp-server community secret RO 5', 'end']);
  const ip = U.parseIp('192.168.1.1');
  const denied = run(net, (cb) => admin.snmpRequest(ip, 'secret', 'get', ['1.3.6.1.2.1.1.5.0'], cb));
  assert.equal(denied.error, 'timeout');
  const oid = '1.3.6.1.2.1.2.2.1.10.1';
  const a = run(net, (cb) => srv.snmpRequest(U.parseIp('192.168.2.1'), 'secret', 'get', [oid], cb));
  ping(net, admin, '192.168.2.10', { count: 10 });
  const b = run(net, (cb) => srv.snmpRequest(U.parseIp('192.168.2.1'), 'secret', 'get', [oid], cb));
  assert.ok(b.varbinds[0].value > a.varbinds[0].value + 500, a.varbinds[0].value + ' → ' + b.varbinds[0].value);
});

test('NetFlow: учёт потоков на входе, экспорт на коллектор, show ip cache flow', () => {
  const { net, r, admin, srv } = lab();
  cli(r, ['enable', 'conf t', 'interface g0/0', 'ip flow ingress', 'exit', 'ip flow-export version 9', 'ip flow-export destination 192.168.2.10 9996', 'end']);
  srv.setCollector(true, 9996);
  ping(net, admin, '192.168.2.10', { count: 5 });
  run(net, (cb) => admin.httpGet('http://192.168.2.10', cb));
  net.runUntilIdle();
  const recs = srv.collected;
  assert.ok(recs.length >= 2, 'записи пришли коллектору: ' + recs.length);
  const icmp = recs.filter((x) => x.proto === 'ICMP' && x.src === '192.168.1.10');
  assert.equal(icmp.reduce((a, x) => a + x.pkts, 0), 5);
  assert.ok(recs.some((x) => x.proto === 'TCP' && x.dport === 80));
  assert.ok(recs.every((x) => x.exporter === 'Router'));
  const out = cli(r, ['enable', 'show ip cache flow', 'show ip flow export', 'show running-config']).text;
  assert.match(out, /Gi0\/0\s+192\.168\.1\.10\s+/);
  assert.match(out, /flows exported in \d+ udp datagrams/);
  assert.match(out, /^ ip flow ingress$/m);
  assert.match(out, /^ip flow-export destination 192\.168\.2\.10 9996$/m);
  // выключенный коллектор — ICMP «порт недоступен», записи не копятся
  srv.setCollector(false, 9996);
  const before = srv.collected.length;
  ping(net, admin, '192.168.2.10', { count: 1 });
  net.runUntilIdle();
  assert.equal(srv.collected.length, before);
  // сохранение и загрузка
  const again = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  const r2 = again.findByName('R1');
  assert.ok(r2.ifaceByName('GigabitEthernet0/0').flow.in);
  assert.equal(U.ipStr(r2.netflow.dest), '192.168.2.10');
});
