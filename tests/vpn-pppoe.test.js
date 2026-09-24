// VPN (GRE, IPsec site-to-site, Easy VPN), PPPoE и коммутируемый доступ (Dial-up).
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping, run } = require('./helpers');

const U = NL.util;

/** R1 — ISP — R2; за R1 сеть 192.168.1.0/24, за R2 — 192.168.2.0/24. Провайдер не знает частных сетей. */
function wan() {
  const net = mkNet();
  net.recording = true;
  const r1 = net.addDevice('router', { name: 'R1' });
  const isp = net.addDevice('router', { name: 'ISP' });
  const r2 = net.addDevice('router', { name: 'R2' });
  routerIf(r1, 0, '10.0.1.1/30');
  routerIf(r1, 1, '192.168.1.1/24');
  routerIf(isp, 0, '10.0.1.2/30');
  routerIf(isp, 1, '10.0.2.2/30');
  routerIf(r2, 0, '10.0.2.1/30');
  routerIf(r2, 1, '192.168.2.1/24');
  link(net, r1, isp, 0, 0);
  link(net, r2, isp, 0, 1);
  const pc1 = pc(net, 'PC1', '192.168.1.10/24', '192.168.1.1');
  const pc2 = pc(net, 'PC2', '192.168.2.10/24', '192.168.2.1');
  link(net, pc1, r1, undefined, 1);
  link(net, pc2, r2, undefined, 1);
  cli(r1, ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.0.1.2', 'end']);
  cli(r2, ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.0.2.2', 'end']);
  net.runUntilIdle();
  return { net, r1, r2, isp, pc1, pc2 };
}

const ipsec = (peer, key, lan, remote, enc) => ['enable', 'conf t',
  'crypto isakmp policy 10', 'encryption ' + (enc || 'aes 256'), 'hash sha', 'authentication pre-share', 'group 5', 'exit',
  'crypto isakmp key ' + key + ' address ' + peer,
  'crypto ipsec transform-set TS esp-aes esp-sha-hmac', 'exit',
  'access-list 110 permit ip ' + lan + ' 0.0.0.255 ' + remote + ' 0.0.0.255',
  'crypto map VPN 10 ipsec-isakmp', 'set peer ' + peer, 'set transform-set TS', 'match address 110', 'exit',
  'interface g0/0', 'crypto map VPN', 'end'];

test('GRE: туннель поверх провайдера, частные сети видят друг друга', () => {
  const { net, r1, r2, pc1 } = wan();
  assert.equal(ping(net, pc1, '192.168.2.10', { count: 1 }).replies.length, 0, 'без туннеля провайдер не знает частных сетей');
  cli(r1, ['enable', 'conf t', 'interface tunnel 0', 'ip address 172.16.0.1 255.255.255.252', 'tunnel source g0/0', 'tunnel destination 10.0.2.1', 'exit', 'ip route 192.168.2.0 255.255.255.0 172.16.0.2', 'end']);
  cli(r2, ['enable', 'conf t', 'interface tunnel 0', 'ip address 172.16.0.2 255.255.255.252', 'tunnel source 10.0.2.1', 'tunnel destination 10.0.1.1', 'exit', 'ip route 192.168.1.0 255.255.255.0 172.16.0.1', 'end']);
  const frames = [];
  const off = net.on((t, e) => { if (t === 'log' && e.type === 'tx') frames.push(e.frame); });
  const r = ping(net, pc1, '192.168.2.10', { count: 3 });
  off();
  assert.equal(r.replies.length, 3);
  assert.ok(frames.some((f) => f.type === 'IPv4' && f.payload.proto === 'GRE'), 'пакеты шли в GRE');
  const out = cli(r1, ['enable', 'show ip interface brief', 'show running-config']).text;
  assert.match(out, /Tunnel0\s+172\.16\.0\.1\s+YES\s+manual\s+up\s+up/);
  assert.match(out, /^ tunnel source GigabitEthernet0\/0$/m);
  // сохранение
  const again = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  again.runUntilIdle();
  assert.equal(ping(again, again.findByName('PC1'), '192.168.2.10', { count: 1 }).replies.length, 1);
});

test('IPsec site-to-site: шифрование интересного трафика, ошибки ключа и политики', () => {
  const { net, r1, r2, isp, pc1 } = wan();
  cli(r1, ipsec('10.0.2.1', 'cisco123', '192.168.1.0', '192.168.2.0'));
  cli(r2, ipsec('10.0.1.1', 'WRONG', '192.168.2.0', '192.168.1.0'));
  const bad = ping(net, pc1, '192.168.2.10', { count: 2 });
  assert.equal(bad.replies.length, 0);
  let out = cli(r1, ['enable', 'show crypto isakmp sa']).text;
  assert.match(out, /pre-shared key/, out);
  // верный ключ, но другая политика
  cli(r2, ['enable', 'conf t', 'no crypto isakmp key WRONG address 10.0.1.1', 'crypto isakmp key cisco123 address 10.0.1.1', 'crypto isakmp policy 10', 'encryption 3des', 'end', 'clear crypto sa']);
  cli(r1, ['enable', 'clear crypto sa']);
  ping(net, pc1, '192.168.2.10', { count: 1 });
  out = cli(r1, ['enable', 'show crypto isakmp sa']).text;
  assert.match(out, /NO_PROPOSAL_CHOSEN/, out);
  // исправили политику — канал поднимается
  cli(r2, ['enable', 'conf t', 'crypto isakmp policy 10', 'encryption aes 256', 'end']);
  cli(r1, ['enable', 'clear crypto sa']);
  const seen = [];
  const off = net.on((t, e) => { if (t === 'log' && e.type === 'tx') seen.push(e); });
  const ok = ping(net, pc1, '192.168.2.10', { count: 4 });
  off();
  assert.ok(ok.replies.length >= 3, 'после установки SA ответы идут: ' + ok.replies.length);
  // провайдер видит только ESP между 10.0.1.1 и 10.0.2.1 — ICMP между частными сетями через него не идёт открыто
  const viaIsp = seen.filter((e) => e.from === isp.id || e.to === isp.id).map((e) => e.frame);
  assert.ok(viaIsp.some((f) => f.type === 'IPv4' && f.payload.proto === 'ESP'));
  assert.ok(!viaIsp.some((f) => f.type === 'IPv4' && f.payload.proto === 'ICMP'), 'ICMP через провайдера не идёт в открытом виде');
  out = cli(r1, ['enable', 'show crypto isakmp sa', 'show crypto ipsec sa', 'show running-config']).text;
  assert.match(out, /10\.0\.2\.1\s+10\.0\.1\.1\s+QM_IDLE/);
  assert.match(out, /#pkts encaps: [1-9]/);
  assert.match(out, /^crypto map VPN 10 ipsec-isakmp$/m);
  assert.match(out, /^ set peer 10\.0\.2\.1$/m);
  assert.match(out, /^ crypto map VPN$/m);
  const again = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(again.findByName('R1').crypto.policies[0].enc, 'aes 256');
  assert.equal(again.findByName('R1').ifaceByName('GigabitEthernet0/0').cryptoMap, 'VPN');
});

test('IKE: фаза 1 (Main Mode, 6 сообщений) и фаза 2 (Quick Mode, 3), ошибка фазы 2, debug, show crypto session', () => {
  const { net, r1, r2, pc1 } = wan();
  cli(r1, ipsec('10.0.2.1', 'cisco123', '192.168.1.0', '192.168.2.0'));
  cli(r2, ipsec('10.0.1.1', 'cisco123', '192.168.2.0', '192.168.1.0'));
  // у R2 другой transform-set — фаза 1 пройдёт, фаза 2 нет
  cli(r2, ['enable', 'conf t', 'crypto ipsec transform-set TS esp-3des esp-md5-hmac', 'exit', 'end']);
  cli(r1, ['enable', 'debug crypto isakmp', 'debug crypto ipsec']);
  const msgs = [];
  const off = net.on((t, e) => { if (t === 'log' && e.type === 'tx' && e.from === r1.id || t === 'log' && e.type === 'tx' && e.from === r2.id) { const d = e.frame.payload && e.frame.payload.payload && e.frame.payload.payload.data; if (d && d.isakmp && e.proto === 'ISAKMP') msgs.push(d.isakmp); } });
  r1.consoleLines.length = 0;
  assert.equal(ping(net, pc1, '192.168.2.10', { count: 1 }).replies.length, 0);
  const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);
  assert.deepEqual(uniq(msgs), ['MM1', 'MM2', 'MM3', 'MM4', 'MM5', 'MM6', 'QM1', 'NOTIFY']);
  let out = cli(r1, ['enable', 'show crypto isakmp sa', 'show crypto ipsec sa', 'show crypto session']).text;
  assert.match(out, /10\.0\.2\.1\s+10\.0\.1\.1\s+QM_IDLE\s+\d+\s+0\s+ACTIVE/, out);
  assert.match(out, /фаза 2 \(IPsec\) не согласована: не совпадает transform-set/);
  assert.match(out, /Session status: UP-IDLE/);
  let con = r1.consoleLines.join('\n');
  assert.match(con, /beginning Main Mode exchange/);
  assert.match(con, /SA authentication status: authenticated/);
  assert.match(con, /Quick Mode with 10\.0\.2\.1 failed: не совпадает transform-set/);
  out = cli(r2, ['enable', 'show crypto isakmp sa']).text;
  assert.match(out, /10\.0\.2\.1\s+10\.0\.1\.1\s+QM_IDLE/, 'у ответчика dst — он сам, src — инициатор');

  // исправили transform-set: снова только фаза 2 — ISAKMP SA уже есть
  cli(r2, ['enable', 'conf t', 'crypto ipsec transform-set TS esp-aes esp-sha-hmac', 'exit', 'end']);
  msgs.length = 0;
  r1.consoleLines.length = 0;
  const ok = ping(net, pc1, '192.168.2.10', { count: 3 });
  assert.ok(ok.replies.length >= 2, 'ответы через IPsec: ' + ok.replies.length);
  assert.deepEqual(uniq(msgs), ['QM1', 'QM2', 'QM3']);
  con = r1.consoleLines.join('\n');
  assert.match(con, /beginning Quick Mode exchange/);
  assert.match(con, /IPSEC\(create_sa\): sa created, \(sa\) sa_dest= 10\.0\.2\.1, sa_proto= 50/);
  out = cli(r1, ['enable', 'show crypto session', 'show debugging']).text;
  assert.match(out, /Session status: UP-ACTIVE/);
  assert.match(out, /IKEv1 SA: local 10\.0\.1\.1\/500 remote 10\.0\.2\.1\/500 Active/);
  assert.match(out, /Crypto ISAKMP debugging is on/);
  // clear crypto isakmp — удаляется только фаза 1, IPsec SA продолжает работать
  cli(r1, ['enable', 'clear crypto isakmp', 'undebug all']);
  out = cli(r1, ['enable', 'show crypto session']).text;
  assert.match(out, /UP-NO-IKE/);
  assert.equal(ping(net, pc1, '192.168.2.10', { count: 1 }).replies.length, 1);
  // clear crypto sa на R1: фаза 2 заново; у R2 ISAKMP SA есть, у R1 — нет, поэтому сначала снова фаза 1
  cli(r1, ['enable', 'clear crypto sa']);
  msgs.length = 0;
  const again = ping(net, pc1, '192.168.2.10', { count: 3 });
  off();
  assert.ok(again.replies.length >= 2);
  assert.deepEqual(uniq(msgs), ['MM1', 'MM2', 'MM3', 'MM4', 'MM5', 'MM6', 'QM1', 'QM2', 'QM3']);
});

test('Easy VPN: удалённый клиент получает адрес из пула и ходит во внутреннюю сеть', () => {
  const { net, r2, isp, pc1 } = wan();
  // PC1 — «домашний» компьютер за R1 (провайдер знает его сеть), внутренняя сеть офиса — за R2
  cli(isp, ['enable', 'conf t', 'ip route 192.168.1.0 255.255.255.0 10.0.1.1', 'end']);
  cli(r2, ['enable', 'conf t', 'aaa new-model', 'username bob password secret',
    'ip local pool VPNPOOL 10.99.0.10 10.99.0.20',
    'crypto isakmp policy 10', 'authentication pre-share', 'exit',
    'crypto isakmp client configuration group STAFF', 'key grpkey', 'pool VPNPOOL', 'exit', 'end']);
  const bad = run(net, (cb) => pc1.vpnConnect('10.0.2.1', 'STAFF', 'grpkey', 'bob', 'nope', cb));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /логин или пароль/);
  const noGroup = run(net, (cb) => pc1.vpnConnect('10.0.2.1', 'OTHER', 'grpkey', 'bob', 'secret', cb));
  assert.match(noGroup.error, /группа/);
  const ok = run(net, (cb) => pc1.vpnConnect('10.0.2.1', 'STAFF', 'grpkey', 'bob', 'secret', cb));
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(U.ipStr(ok.ip), '10.99.0.10');
  const r = ping(net, pc1, '192.168.2.10', { count: 3 });
  assert.equal(r.replies.length, 3, 'через VPN во внутреннюю сеть офиса');
  const out = cli(r2, ['enable', 'show crypto isakmp sa', 'show running-config']).text;
  assert.match(out, /EzVPN bob 10\.99\.0\.10/);
  assert.match(out, /^ip local pool VPNPOOL 10\.99\.0\.10 10\.99\.0\.20$/m);
  assert.match(out, /^crypto isakmp client configuration group STAFF$/m);
  pc1.vpnDisconnect();
  net.runUntilIdle();
  assert.equal(r2.vpnClients.size, 0);
  assert.equal(ping(net, pc1, '192.168.2.10', { count: 1 }).replies.length, 0, 'без VPN провайдер не знает частную сеть');
});

function pppoeLab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'BRAS' });
  const sw = net.addDevice('switch', { name: 'SW' });
  const srv = net.addDevice('server', { name: 'Web' });
  routerIf(r, 1, '203.0.113.1/24');
  srv.setStatic(U.parseIp('203.0.113.10'), U.maskFromPrefix(24), U.parseIp('203.0.113.1'), null);
  link(net, r, sw, 0);
  link(net, r, srv, 1);
  const home = net.addDevice('pc', { name: 'Home' });
  link(net, home, sw);
  cli(r, ['enable', 'conf t', 'username client1 password pass1',
    'ip local pool PPP 100.64.0.10 100.64.0.50',
    'interface loopback 0', 'ip address 100.64.0.1 255.255.255.255', 'exit',
    'bba-group pppoe GLOBAL', 'virtual-template 1', 'exit',
    'interface virtual-template 1', 'ip unnumbered loopback0', 'peer default ip address pool PPP', 'ppp authentication chap', 'exit',
    'interface g0/0', 'pppoe enable group GLOBAL', 'no shutdown', 'end']);
  net.runUntilIdle();
  return { net, r, home, srv };
}

test('PPPoE: CHAP, выдача адреса из пула, выход в интернет через сеанс', () => {
  const { net, r, home } = pppoeLab();
  const bad = run(net, (cb) => home.pppoeConnect('client1', 'wrong', cb));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /имя пользователя или пароль/);
  assert.equal(r.pppoeSessions.size, 0);
  const ok = run(net, (cb) => home.pppoeConnect('client1', 'pass1', cb));
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(U.ipStr(ok.ip), '100.64.0.10');
  const p = ping(net, home, '203.0.113.10', { count: 3 });
  assert.equal(p.replies.length, 3);
  let out = cli(r, ['enable', 'show pppoe session', 'show running-config']).text;
  assert.match(out, /1 session in LOCALLY_TERMINATED/);
  assert.match(out, /пользователь client1, адрес 100\.64\.0\.10/);
  assert.match(out, /^bba-group pppoe GLOBAL$/m);
  assert.match(out, /^ peer default ip address pool PPP$/m);
  assert.match(out, /^ pppoe enable group GLOBAL$/m);
  assert.doesNotMatch(out, /Virtual-Access/);
  // сброс сеанса администратором
  cli(r, ['enable', 'clear pppoe all']);
  assert.equal(home.pppoeClient.state, 'down');
  assert.equal(ping(net, home, '203.0.113.10', { count: 1 }).replies.length, 0);
  // снова подключаемся — адрес вернулся в пул
  const again = run(net, (cb) => home.pppoeConnect('client1', 'pass1', cb));
  assert.equal(U.ipStr(again.ip), '100.64.0.10');
  home.pppoeDisconnect();
  net.runUntilIdle();
  assert.equal(r.pppoeSessions.size, 0);
  // конфигурация сохраняется
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  const res = run(n2, (cb) => n2.findByName('Home').pppoeConnect('client1', 'pass1', cb));
  assert.ok(res.ok, JSON.stringify(res));
  out = cli(n2.findByName('BRAS'), ['enable', 'show running-config']).text;
  assert.match(out, /^ ip unnumbered Loopback0$/m);
});

test('PPPoE: сервер не настроен — клиент сообщает, что нет PADO', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R' });
  const home = net.addDevice('pc', { name: 'Home' });
  link(net, home, r, undefined, 0);
  cli(r, ['enable', 'conf t', 'interface g0/0', 'no shutdown', 'end']);
  const res = run(net, (cb) => home.pppoeConnect('a', 'b', cb));
  assert.equal(res.ok, false);
  assert.match(res.error, /PADO/);
});

function withModem(net, name) {
  const d = net.addDevice('pc', { name });
  net.setPower(d, false);
  net.setModule(d, 'nic', 'PT-HOST-NM-1AM');
  net.setPower(d, true);
  return d;
}

test('Dial-up: звонок через телефонную сеть, логин, PPP-адрес и ping', () => {
  const net = mkNet();
  const cloud = net.addDevice('cloud', { name: 'PSTN' });
  const a = withModem(net, 'Client');
  const b = withModem(net, 'Office');
  assert.equal(a.iface.kind, 'dialup');
  assert.equal(net.connect(a.id, 'auto', cloud.id, cloud.portIndex('Modem0')).cable, 'phone');
  link(net, b, cloud, undefined, cloud.portIndex('Modem1'));
  net.runUntilIdle();
  // приём звонков выключен
  let r = run(net, (cb) => a.dial('5551001', 'u', 'p', cb));
  assert.equal(r.ok, false);
  assert.match(r.error, /Dial-in/);
  b.setDialin({ enabled: true, ip: U.parseIp('10.10.10.1'), pool: U.parseIp('10.10.10.2'), users: [{ user: 'alice', pass: 'pw' }] });
  r = run(net, (cb) => a.dial('5551001', 'alice', 'bad', cb));
  assert.match(r.error, /логин или пароль/);
  r = run(net, (cb) => a.dial('5559999', 'alice', 'pw', cb));
  assert.match(r.error, /не существует/);
  r = run(net, (cb) => a.dial('5551000', 'alice', 'pw', cb));
  assert.match(r.error, /собственный/);
  r = run(net, (cb) => a.dial('5551001', 'alice', 'pw', cb));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(U.ipStr(a.iface.ip), '10.10.10.2');
  const p = ping(net, a, '10.10.10.1', { count: 2 });
  assert.equal(p.replies.length, 2);
  // третий абонент — «занято»
  const c = withModem(net, 'Third');
  link(net, c, cloud, undefined, cloud.portIndex('Modem2'));
  net.runUntilIdle();
  r = run(net, (cb) => c.dial('5551001', 'alice', 'pw', cb));
  assert.match(r.error, /занят/);
  a.hangup();
  net.runUntilIdle();
  assert.equal(b.dialup.state, 'down');
  assert.equal(ping(net, a, '10.10.10.1', { count: 1 }).replies.length, 0);
  // номера и настройки приёма сохраняются
  cloud.setNumber('Modem1', '777');
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(n2.findByName('PSTN').numbers.Modem1, '777');
  const res = run(n2, (cb) => n2.findByName('Client').dial('777', 'alice', 'pw', cb));
  assert.ok(res.ok, JSON.stringify(res));
});
