// Тесты механик в духе Packet Tracer: кабели, модули, Wi-Fi, TCP-службы, IOS, ACL, NAT, RIP/OSPF…
// Запуск: node --test tests/
const test = require('node:test');
const { NL, U, ip, pfx, mkNet, host, pc, routerIf, ifIp, link, ping, cli, run, assert } = require('./helpers');

/* ================= кабели ================= */

test('кабели: прямой между коммутаторами не работает, перекрёстный — работает, «авто» выбирает верный', () => {
  const net = mkNet();
  const s1 = net.addDevice('switch');
  const s2 = net.addDevice('switch');
  const l = link(net, s1, s2, 23, 23, 'straight');
  assert.match(net.linkIssue(l), /перекрёстный/);
  assert.equal(net.portVisualState(s1, 23), 'down');
  net.disconnect(l.id);
  const l2 = link(net, s1, s2, 23, 23, 'cross');
  assert.equal(net.linkIssue(l2), null);
  assert.equal(net.portVisualState(s1, 23), 'up');
  const p = pc(net, 'A', '10.0.0.1/24');
  const l3 = link(net, p, s1);
  assert.equal(l3.cable, 'straight');
  const r = net.addDevice('router');
  const b = pc(net, 'B', '10.0.0.2/24');
  assert.equal(link(net, b, r).cable, 'cross', 'ПК—маршрутизатор: перекрёстный');
  assert.equal(link(net, r, s1).cable, 'straight');
});

test('кабели: ПК—ПК прямым не работает; ПК—маршрутизатор нужен перекрёстный', () => {
  const net = mkNet();
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  const l = link(net, a, b, 0, 0, 'straight');
  assert.ok(net.linkIssue(l));
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).done.received, 0);
  net.disconnect(l.id);
  link(net, a, b, 0, 0, 'cross');
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).done.received, 1);
});

test('кабели: оптика подключается только к оптическим портам, консоль — RS-232 ↔ Console', () => {
  const net = mkNet();
  const a = net.addDevice('pc');
  const r = net.addDevice('router');
  assert.throws(() => link(net, a, r, 'auto', 'auto', 'fiber'), /Нет свободных совместимых портов/);
  const c = link(net, a, r, 'auto', 'auto', 'console');
  assert.equal(a.ports[c.a.port].media, 'rs232');
  assert.equal(r.ports[c.b.port].media, 'console');
  assert.equal(net.consolePeer(a), r);
  assert.equal(net.isPortOperational(a, c.a.port), false, 'консоль не передаёт данные');
});

/* ================= модули ================= */

test('модули: менять можно только при выключенном питании; кабель на снятом порту удаляется', () => {
  const net = mkNet();
  const a = pc(net, 'A', '10.0.0.1/24');
  const sw = net.addDevice('switch');
  link(net, a, sw);
  assert.throws(() => net.setModule(a, 'nic', 'PT-HOST-NM-1FGE'), /выключенном питании/);
  net.setPower(a, false);
  net.setModule(a, 'nic', 'PT-HOST-NM-1FGE');
  assert.equal(net.links.size, 0);
  assert.equal(a.iface.name, 'GigabitEthernet0');
  assert.equal(a.ports[0].media, 'fiber');
  assert.equal(U.ipStr(a.iface.ip), '10.0.0.1', 'IP-настройки сохраняются');
  assert.throws(() => net.setModule(a, 'nic', 'HWIC-2T'), /не подходит/);
});

test('модули: HWIC-2T добавляет serial-порты маршрутизатору', () => {
  const net = mkNet();
  const r = net.addDevice('router');
  net.setPower(r, false);
  net.setModule(r, 'hwic0', 'HWIC-2T');
  net.setPower(r, true);
  assert.ok(r.ports.some((p) => p.name === 'Serial0/0/0'));
  assert.ok(r.ifaceByName('Serial0/0/1'));
});

/* ================= serial ================= */

function serialPair() {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  for (const r of [r1, r2]) { net.setPower(r, false); net.setModule(r, 'hwic0', 'HWIC-2T'); net.setPower(r, true); }
  const l = link(net, r1, r2, r1.portIndex('Serial0/0/0'), r2.portIndex('Serial0/0/0'), 'serial-dce');
  ifIp(r1, 'Serial0/0/0', '10.0.0.1/30');
  ifIp(r2, 'Serial0/0/0', '10.0.0.2/30');
  return { net, r1, r2, l };
}

test('serial: без clock rate на DCE канал не поднимается; PPP с одной стороны — тоже', () => {
  const { net, r1, r2, l } = serialPair();
  assert.match(net.linkIssue(l), /clock rate/);
  assert.equal(ping(net, r1, '10.0.0.2', { count: 1 }).done.received, 0);
  cli(r1, ['en', 'conf t', 'int s0/0/0', 'clock rate 64000']);
  assert.equal(net.linkIssue(l), null);
  assert.equal(ping(net, r1, '10.0.0.2', { count: 2 }).done.received, 2);
  cli(r2, ['en', 'conf t', 'int s0/0/0', 'encapsulation ppp']);
  assert.match(net.linkIssue(l), /инкапсуляция/);
  cli(r1, ['en', 'conf t', 'int s0/0/0', 'encapsulation ppp']);
  assert.equal(ping(net, r1, '10.0.0.2', { count: 1 }).done.received, 1);
  assert.match(cli(r1, ['en', 'show controllers serial 0/0/0']).text, /DCE V\.35, clock rate 64000/);
  assert.match(cli(r2, ['en', 'show controllers serial 0/0/0']).text, /DTE/);
});

/* ================= Wi-Fi ================= */

function wifiLab() {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const srv = pc(net, 'Wired', '192.168.1.10/24');
  link(net, srv, sw);
  const ap = net.addDevice('ap', { x: 0, y: 0 });
  link(net, ap, sw);
  ap.setWifi({ ssid: 'Office', security: 'wpa2', key: 'secret123' });
  const lap = net.addDevice('laptop', { x: 100, y: 50 });
  net.setPower(lap, false);
  net.setModule(lap, 'nic', 'WPC300N');
  net.setPower(lap, true);
  lap.setStatic(ip('192.168.1.20'), pfx(24), null, null);
  return { net, sw, srv, ap, lap };
}

test('Wi-Fi: подключение по SSID и ключу WPA2, связь с проводной сетью через точку доступа', () => {
  const { net, ap, lap } = wifiLab();
  lap.setWifi({ ssid: 'Office', security: 'wpa2', key: 'wrongkey1' });
  assert.match(net.wirelessStatus(lap).reason, /Неверный ключ/);
  lap.setWifi({ ssid: 'Office', security: 'wpa2', key: 'secret123' });
  assert.equal(net.wirelessStatus(lap).ap, ap);
  assert.equal(ping(net, lap, '192.168.1.10').done.received, 4);
  lap.x = 5000;
  net.refreshTopology();
  assert.match(net.wirelessStatus(lap).reason, /далеко/);
  assert.equal(ping(net, lap, '192.168.1.10', { count: 1 }).done.received, 0);
});

test('Wi-Fi: два беспроводных клиента видят друг друга', () => {
  const { net, lap } = wifiLab();
  lap.setWifi({ ssid: 'Office', security: 'wpa2', key: 'secret123' });
  const tab = net.addDevice('tablet', { x: -80, y: 40 });
  tab.setStatic(ip('192.168.1.30'), pfx(24), null, null);
  tab.setWifi({ ssid: 'Office', security: 'wpa2', key: 'secret123' });
  assert.equal(ping(net, tab, '192.168.1.20').done.received, 4);
});

test('WRT300N: DHCP для Wi-Fi-клиентов, адрес WAN от провайдера, выход в «интернет» через NAT', () => {
  const net = mkNet();
  const isp = net.addDevice('router', { name: 'ISP' });
  routerIf(isp, 1, '203.0.113.1/24');
  const web = host(net, 'server', 'Web', '203.0.113.80/24', '203.0.113.1');
  web.dnsd.enabled = true;
  web.dnsd.setRecord('web.isp', ip('203.0.113.80'));
  link(net, web, isp, 0, 1);
  routerIf(isp, 0, '198.51.100.1/24');
  isp.dhcpd.setPool({ name: 'WAN', start: ip('198.51.100.10'), end: ip('198.51.100.20'), mask: pfx(24), gateway: ip('198.51.100.1'), dns: ip('203.0.113.80') });
  const wrt = net.addDevice('wrouter', { x: 0, y: 0 });
  link(net, wrt, isp, wrt.portIndex('Internet'), 0);
  wrt.setWifi({ ssid: 'Home', security: 'wpa2', key: 'password1' });
  const lap = net.addDevice('laptop', { x: 60, y: 60 });
  net.setPower(lap, false);
  net.setModule(lap, 'nic', 'WPC300N');
  net.setPower(lap, true);
  lap.setWifi({ ssid: 'Home', security: 'wpa2', key: 'password1' });
  lap.setDhcp();
  const wired = net.addDevice('pc');
  link(net, wired, wrt, 0, wrt.portIndex('Ethernet 1'));
  wired.setDhcp();
  net.runUntilIdle();
  assert.ok(U.ipStr(wrt.wanIface.ip).startsWith('198.51.100.'));
  assert.ok(U.ipStr(lap.iface.ip).startsWith('192.168.0.1'));
  assert.equal(U.ipStr(lap.gateway), '192.168.0.1');
  assert.equal(U.ipStr(lap.dns), '192.168.0.1', 'роутер — DNS-прокси для LAN');
  assert.equal(ping(net, lap, '203.0.113.80').done.received, 4);
  const byName = ping(net, lap, 'web.isp', { count: 1 });
  assert.equal(byName.done.received, 1, 'имя разрешается через DNS-прокси роутера');
  assert.equal(ping(net, wired, '192.168.0.1', { count: 1 }).done.received, 1);
  assert.equal(ping(net, wired, lap.iface.ip != null ? U.ipStr(lap.iface.ip) : '', { count: 1 }).done.received, 1);
  assert.ok(wrt.nat.table.length > 0, 'есть трансляции PAT');
});

/* ================= TCP и службы ================= */

function lanWithServer() {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const srv = host(net, 'server', 'SRV', '10.0.0.5/24', null, '10.0.0.5');
  const a = pc(net, 'A', '10.0.0.10/24', null, '10.0.0.5');
  const b = pc(net, 'B', '10.0.0.11/24', null, '10.0.0.5');
  const c = pc(net, 'C', '10.0.0.12/24', null, '10.0.0.5');
  for (const d of [srv, a, b, c]) link(net, d, sw);
  return { net, sw, srv, a, b, c };
}

test('TCP/HTTP: браузер загружает страницу, 404 и закрытый порт обрабатываются', () => {
  const { net, srv, a } = lanWithServer();
  srv.dnsd.enabled = true;
  srv.dnsd.setRecord('www.lab', ip('10.0.0.5'));
  const r = run(net, (cb) => a.httpGet('http://www.lab', cb));
  assert.ok(r.ok);
  assert.equal(r.status, 200);
  assert.match(r.body, /NetLab/);
  assert.equal(run(net, (cb) => a.httpGet('10.0.0.5/nope.html', cb)).status, 404);
  srv.httpd.enabled = false;
  srv.rebindServices();
  const off = run(net, (cb) => a.httpGet('10.0.0.5', cb));
  assert.equal(off.ok, false);
  assert.match(off.error, /отклонил/);
  const none = run(net, (cb) => a.httpGet('10.0.0.99', cb));
  assert.equal(none.ok, false);
});

test('TCP: рукопожатие и закрытие видны в журнале симуляции', () => {
  const { net, a } = lanWithServer();
  net.recording = true;
  run(net, (cb) => a.httpGet('10.0.0.5', cb));
  const flags = net.log.filter((e) => e.type === 'tx' && e.frame.payload && e.frame.payload.proto === 'TCP').map((e) => e.frame.payload.payload.flags);
  assert.ok(flags.includes('SYN'));
  assert.ok(flags.includes('SYN,ACK'));
  assert.ok(flags.some((f) => f.startsWith('FIN')));
  assert.ok(net.log.some((e) => e.proto === 'HTTP'));
});

test('почтовый сервер: письмо нескольким адресатам с отчётом по каждому, получение по POP3', () => {
  const { net, srv, a, b, c } = lanWithServer();
  srv.maild.setDomain('mail.lab');
  srv.maild.setUser('bob', 'b1');
  srv.maild.setUser('carl', 'c1');
  srv.dnsd.enabled = true;
  srv.dnsd.setRecord('mail.lab', ip('10.0.0.5'));
  Object.assign(a.email, { name: 'Alice', address: 'alice@mail.lab', incoming: 'mail.lab', outgoing: 'mail.lab', user: 'alice', password: 'x' });
  Object.assign(b.email, { name: 'Bob', address: 'bob@mail.lab', incoming: 'mail.lab', outgoing: 'mail.lab', user: 'bob', password: 'b1' });
  Object.assign(c.email, { name: 'Carl', address: 'carl@mail.lab', incoming: '10.0.0.5', outgoing: '10.0.0.5', user: 'carl', password: 'wrong' });
  const r = run(net, (cb) => a.emailSend(['bob@mail.lab', 'carl@mail.lab', 'nobody@mail.lab', 'bad-address', 'bob@mail.lab'], 'Отчёт', 'Текст', cb));
  assert.ok(r.ok);
  assert.equal(r.results.length, 4, 'дубликаты адресатов убираются');
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, false, false]);
  assert.match(r.results[2].text, /нет такого пользователя/);
  const rb = run(net, (cb) => b.emailReceive(cb));
  assert.deepEqual([rb.ok, rb.count], [true, 1]);
  assert.equal(b.emailBox[0].subject, 'Отчёт');
  assert.equal(run(net, (cb) => b.emailReceive(cb)).count, 0, 'POP3 забирает письма с сервера');
  const rc = run(net, (cb) => c.emailReceive(cb));
  assert.equal(rc.ok, false);
  assert.match(rc.error, /пароль/);
});

test('почта между доменами: сервер пересылает письмо серверу другого домена (через DNS)', () => {
  const { net, srv, a } = lanWithServer();
  const sw = net.findByName('Switch0');
  const srv2 = host(net, 'server', 'SRV2', '10.0.0.6/24', null, '10.0.0.5');
  link(net, srv2, sw);
  srv.dns = ip('10.0.0.5');
  srv.dnsd.enabled = true;
  srv.dnsd.setRecord('one.lab', ip('10.0.0.5'));
  srv.dnsd.setRecord('two.lab', ip('10.0.0.6'));
  srv.maild.setDomain('one.lab');
  srv.maild.setUser('ann', '1');
  srv2.maild.setDomain('two.lab');
  srv2.maild.setUser('tom', '2');
  Object.assign(a.email, { address: 'ann@one.lab', outgoing: 'one.lab', incoming: 'one.lab', user: 'ann', password: '1' });
  const r = run(net, (cb) => a.emailSend(['tom@two.lab', 'ann@one.lab', 'x@three.lab'], 's', 'b', cb));
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, false]);
  assert.equal(srv2.maild.boxes.get('tom').length, 1);
  assert.match(r.results[2].text, /не найден/);
});

test('брандмауэр узла: блокирует входящий ping, но ответы на свой трафик проходят', () => {
  const { net, a, b } = lanWithServer();
  b.firewall.enabled = true;
  assert.equal(ping(net, a, '10.0.0.11', { count: 1 }).done.received, 0);
  assert.equal(ping(net, b, '10.0.0.10', { count: 1 }).done.received, 1);
  b.addFirewallRule({ action: 'allow', proto: 'icmp', remote: ip('10.0.0.10'), wc: 0 });
  assert.equal(ping(net, a, '10.0.0.11', { count: 1 }).done.received, 1);
});

test('генератор трафика: UDP на закрытый порт сообщает об ошибке, TCP на 80 — соединение', () => {
  const { net, a } = lanWithServer();
  const ev = [];
  a.trafficGen({ dst: '10.0.0.5', proto: 'udp', dport: 5000, count: 2, onEvent: (e) => ev.push(e) });
  net.runUntilIdle();
  assert.ok(ev.some((e) => e.type === 'fail' && /закрыт/.test(e.text)));
  const ev2 = [];
  a.trafficGen({ dst: '10.0.0.5', proto: 'tcp', dport: 80, count: 2, onEvent: (e) => ev2.push(e) });
  net.runUntilIdle();
  assert.equal(ev2.filter((e) => e.type === 'ok').length, 2);
});

/* ================= коммутаторы: SVI, L3, port-security ================= */

test('SVI: управление коммутатором по IP, ip default-gateway, Telnet с паролем vty', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const a = pc(net, 'A', '10.0.0.10/24');
  link(net, a, sw);
  cli(sw, ['en', 'conf t', 'int vlan 1', 'ip address 10.0.0.2 255.255.255.0', 'no shut', 'exit', 'ip default-gateway 10.0.0.1', 'line vty 0 15', 'password cisco', 'login', 'end']);
  assert.equal(ping(net, a, '10.0.0.2').done.received, 4);
  // Telnet с ПК
  const s = NL.cli.createSession(a);
  const out = [];
  const io = { out: (l) => out.push(l), write: (t) => out.push(t), mutate: (f) => f(), done: () => {}, clear: () => {} };
  const step = (l) => { NL.cli.exec(a, s, l, io); net.runUntilIdle(); };
  step('telnet 10.0.0.2');
  assert.equal(NL.cli.prompt(a, s), 'Password: ');
  assert.ok(NL.cli.isMasked(s));
  step('wrong');
  step('cisco');
  assert.equal(NL.cli.prompt(a, s), 'Switch>', 'в приглашении — hostname, а не имя на схеме');
  step('enable');
  assert.match(out.join('\n'), /No password set/);
  step('show ip interface brief');
  assert.match(out.join('\n'), /Vlan1\s+10\.0\.0\.2/);
  step('exit');
  assert.equal(s.remote, null);
  assert.equal(NL.cli.prompt(a, s), 'C:\\>');
});

test('SSH: без ключей RSA отказ; с domain-name, RSA, username и login local — вход', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R' });
  routerIf(r, 0, '10.0.0.1/24');
  const a = pc(net, 'A', '10.0.0.10/24', '10.0.0.1');
  link(net, a, r, 0, 0);
  let t = cli(a, ['ssh -l admin 10.0.0.1']).text;
  assert.match(t, /RSA/);
  cli(r, ['en', 'conf t', 'hostname R1', 'ip domain-name lab.local', 'crypto key generate rsa general-keys modulus 1024', 'username admin secret Pa55', 'enable secret en', 'line vty 0 4', 'login local', 'transport input ssh', 'end']);
  const res = cli(a, ['ssh -l admin 10.0.0.1', 'Pa55', 'enable', 'en', 'show run']);
  assert.match(res.text, /hostname R1/);
  assert.match(res.text, /username admin secret 5 \$1\$/);
  assert.equal(NL.cli.prompt(a, res.session), 'R1#');
  t = cli(a, ['telnet 10.0.0.1']).text;
  assert.match(t, /refused/i, 'transport input ssh запрещает telnet');
});

test('коммутатор 3560: ip routing между VLAN через SVI', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'L3', model: '3560-24PS' });
  const a = pc(net, 'A', '192.168.10.10/24', '192.168.10.1');
  const b = pc(net, 'B', '192.168.20.10/24', '192.168.20.1');
  link(net, a, sw, 0, 0);
  link(net, b, sw, 0, 1);
  const out = cli(sw, ['en', 'conf t', 'vlan 10', 'vlan 20', 'exit', 'int fa0/1', 'sw acc vl 10', 'int fa0/2', 'sw acc vl 20',
    'int vlan 10', 'ip add 192.168.10.1 255.255.255.0', 'int vlan 20', 'ip add 192.168.20.1 255.255.255.0', 'exit', 'ip routing', 'end']).text;
  assert.doesNotMatch(out, /Invalid/);
  assert.equal(ping(net, a, '192.168.20.10').done.received, 4);
  // 2960 не маршрутизирует
  const sw2 = net.addDevice('switch');
  assert.match(cli(sw2, ['en', 'conf t', 'ip routing']).text, /2-м уровне/);
});

test('port-security: второй MAC на порту переводит его в err-disabled; restrict только отбрасывает', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const hub = net.addDevice('hub');
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  const c = pc(net, 'C', '10.0.0.3/24');
  link(net, hub, sw, 0, 0);
  link(net, a, hub);
  link(net, b, hub);
  link(net, c, sw, 0, 1);
  cli(sw, ['en', 'conf t', 'int fa0/1', 'switchport mode access', 'switchport port-security', 'switchport port-security mac-address sticky']);
  assert.equal(ping(net, a, '10.0.0.3', { count: 1 }).done.received, 1);
  assert.equal(ping(net, b, '10.0.0.3', { count: 1 }).done.received, 0);
  assert.ok(sw.ports[0].errDisabled);
  assert.match(cli(sw, ['en', 'show port-security interface fa0/1']).text, /Secure-shutdown/);
  assert.match(NL.cli.runningConfig(sw).join('\n'), /mac-address sticky 00d0/);
  cli(sw, ['en', 'conf t', 'int fa0/1', 'switchport port-security violation restrict', 'shutdown', 'no shutdown']);
  assert.equal(sw.ports[0].errDisabled, false);
  assert.equal(ping(net, a, '10.0.0.3', { count: 1 }).done.received, 1);
  assert.equal(ping(net, b, '10.0.0.3', { count: 1 }).done.received, 0);
  assert.equal(sw.ports[0].errDisabled, false);
  assert.ok(sw.ports[0].ps.violations > 0);
});

/* ================= маршрутизатор: ACL, NAT, RIP, OSPF ================= */

function threeNets() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R' });
  routerIf(r, 0, '192.168.1.1/24');
  routerIf(r, 1, '192.168.2.1/24');
  const s1 = net.addDevice('switch');
  const s2 = net.addDevice('switch');
  link(net, r, s1, 0);
  link(net, r, s2, 1);
  const a = pc(net, 'A', '192.168.1.10/24', '192.168.1.1');
  const a2 = pc(net, 'A2', '192.168.1.11/24', '192.168.1.1');
  const srv = host(net, 'server', 'SRV', '192.168.2.10/24', '192.168.2.1');
  link(net, a, s1);
  link(net, a2, s1);
  link(net, srv, s2);
  return { net, r, a, a2, srv };
}

test('ACL стандартный: запрет одного узла; ACL расширенный: запрет ping, но HTTP разрешён', () => {
  const { net, r, a, a2 } = threeNets();
  cli(r, ['en', 'conf t', 'access-list 10 deny host 192.168.1.11', 'access-list 10 permit any', 'int g0/1', 'ip access-group 10 out']);
  assert.equal(ping(net, a, '192.168.2.10', { count: 1 }).done.received, 1);
  const blocked = ping(net, a2, '192.168.2.10', { count: 1 });
  assert.equal(blocked.done.received, 0);
  assert.equal(blocked.events.find((e) => e.type === 'unreachable').code, 13);
  assert.match(cli(r, ['en', 'show access-lists']).text, /10 deny 192\.168\.1\.11 \(1 match/);
  cli(r, ['en', 'conf t', 'int g0/1', 'no ip access-group 10 out', 'ip access-list extended WEB', 'permit tcp any host 192.168.2.10 eq www', 'deny icmp any any', 'permit ip any any', 'int g0/0', 'ip access-group WEB in']);
  assert.equal(ping(net, a2, '192.168.2.10', { count: 1 }).done.received, 0);
  assert.ok(run(net, (cb) => a2.httpGet('192.168.2.10', cb)).ok);
  assert.match(NL.cli.runningConfig(r).join('\n'), /ip access-list extended WEB\n permit tcp any host 192\.168\.2\.10 eq www/);
});

test('NAT: PAT для внутренней сети, статический NAT для сервера, tracert через NAT', () => {
  const net = mkNet();
  const gw = net.addDevice('router', { name: 'GW' });
  const isp = net.addDevice('router', { name: 'ISP' });
  routerIf(gw, 0, '192.168.1.1/24');
  routerIf(gw, 1, '203.0.113.2/30');
  routerIf(isp, 1, '203.0.113.1/30');
  routerIf(isp, 0, '8.8.8.1/24');
  link(net, gw, isp, 1, 1);
  const inet = pc(net, 'Inet', '8.8.8.8/24', '8.8.8.1');
  link(net, inet, isp, 0, 0);
  const sw = net.addDevice('switch');
  link(net, gw, sw, 0);
  const a = pc(net, 'A', '192.168.1.10/24', '192.168.1.1');
  const web = host(net, 'server', 'WEB', '192.168.1.80/24', '192.168.1.1');
  link(net, a, sw);
  link(net, web, sw);
  // у провайдера нет маршрута в частную сеть — только NAT спасёт
  cli(gw, ['en', 'conf t', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'access-list 1 permit 192.168.1.0 0.0.0.255',
    'ip nat inside source list 1 interface g0/1 overload', 'ip nat inside source static 192.168.1.80 203.0.113.2',
    'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'end']);
  assert.equal(ping(net, a, '8.8.8.8', { count: 2 }).done.received, 2);
  const tr = cli(gw, ['en', 'show ip nat translations']).text;
  assert.match(tr, /icmp 203\.0\.113\.2:\d+\s+192\.168\.1\.10/);
  assert.match(tr, /---\s+203\.0\.113\.2\s+192\.168\.1\.80/);
  // снаружи — на внешний адрес статического NAT
  assert.ok(run(net, (cb) => inet.httpGet('203.0.113.2', cb)).ok);
  const hops = [];
  a.traceroute('8.8.8.8', { onEvent: (e) => { if (e.type === 'hop') hops.push(U.ipStr(e.from)); } });
  net.runUntilIdle();
  assert.deepEqual(hops, ['192.168.1.1', '203.0.113.1', '8.8.8.8']);
});

function chain3(proto) {
  const net = mkNet();
  const r = [1, 2, 3].map((n) => net.addDevice('router', { name: 'R' + n }));
  routerIf(r[0], 0, '10.1.0.1/24');
  routerIf(r[0], 1, '10.12.0.1/30');
  routerIf(r[1], 1, '10.12.0.2/30');
  routerIf(r[1], 2, '10.23.0.1/30');
  routerIf(r[2], 2, '10.23.0.2/30');
  routerIf(r[2], 0, '10.3.0.1/24');
  link(net, r[0], r[1], 1, 1);
  link(net, r[1], r[2], 2, 2);
  const a = pc(net, 'A', '10.1.0.10/24', '10.1.0.1');
  const b = pc(net, 'B', '10.3.0.10/24', '10.3.0.1');
  link(net, a, r[0], 0, 0);
  link(net, b, r[2], 0, 0);
  if (proto === 'rip') for (const x of r) cli(x, ['en', 'conf t', 'router rip', 'version 2', 'network 10.0.0.0', 'no auto-summary']);
  if (proto === 'ospf') {
    for (const x of r) cli(x, ['en', 'conf t', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0']);
  }
  return { net, r, a, b };
}

test('RIP: маршруты распространяются по цепочке, метрика — число прыжков; passive-interface', () => {
  const { net, r, a } = chain3('rip');
  assert.equal(ping(net, a, '10.3.0.10').done.received, 4);
  const t = cli(r[0], ['en', 'show ip route']).text;
  assert.match(t, /R\s+10\.3\.0\.0\/24 \[120\/2\] via 10\.12\.0\.2/);
  assert.match(t, /R\s+10\.23\.0\.0\/30 \[120\/1\]/);
  assert.match(cli(r[0], ['en', 'show ip protocols']).text, /Routing Protocol is "rip"/);
  cli(r[1], ['en', 'conf t', 'router rip', 'passive-interface g0/1']);
  assert.doesNotMatch(cli(r[0], ['en', 'show ip route']).text, /10\.3\.0\.0/);
});

test('OSPF: соседи FULL, кратчайший путь по стоимости, перестроение при обрыве, loopback /32', () => {
  const { net, r, a } = chain3('ospf');
  assert.equal(ping(net, a, '10.3.0.10').done.received, 4);
  assert.match(cli(r[1], ['en', 'show ip ospf neighbor']).text, /10\.23\.0\.2\s+1\s+FULL/);
  // обходной путь R1—R3 напрямую
  routerIf(r[0], 2, '10.13.0.1/30');
  routerIf(r[2], 1, '10.13.0.2/30');
  const l = link(net, r[0], r[2], 2, 1);
  net.refreshTopology();
  assert.match(cli(r[0], ['en', 'show ip route']).text, /O\s+10\.3\.0\.0\/24 \[110\/2\] via 10\.13\.0\.2/);
  net.disconnect(l.id);
  assert.match(cli(r[0], ['en', 'show ip route']).text, /O\s+10\.3\.0\.0\/24 \[110\/3\] via 10\.12\.0\.2/);
  cli(r[2], ['en', 'conf t', 'int lo0', 'ip add 3.3.3.3 255.255.255.255', 'router ospf 1', 'network 3.3.3.3 0.0.0.0 area 0']);
  assert.match(cli(r[0], ['en', 'show ip route']).text, /O\s+3\.3\.3\.3\/32/);
  assert.equal(ping(net, a, '3.3.3.3', { count: 1 }).done.received, 1);
  assert.match(cli(r[2], ['en', 'show ip protocols']).text, /Router ID 10\.3\.0\.1|Router ID 3\.3\.3\.3/);
});

test('OSPF: default-information originate раздаёт маршрут по умолчанию', () => {
  const { net, r, a } = chain3('ospf');
  const inet = pc(net, 'Inet', '172.16.0.10/24', '172.16.0.1');
  routerIf(r[2], 1, '172.16.0.1/24');
  link(net, inet, r[2], 0, 1);
  cli(r[2], ['en', 'conf t', 'ip route 0.0.0.0 0.0.0.0 172.16.0.10', 'router ospf 1', 'default-information originate']);
  assert.match(cli(r[0], ['en', 'show ip route']).text, /O\*E2\s+0\.0\.0\.0\/0/);
  assert.equal(ping(net, a, '172.16.0.10', { count: 1 }).done.received, 1);
});

test('статический маршрут с выходным интерфейсом и плавающий статический маршрут', () => {
  const { net, r1, r2 } = serialPair();
  cli(r1, ['en', 'conf t', 'int s0/0/0', 'clock rate 64000']);
  cli(r2, ['en', 'conf t', 'int lo0', 'ip address 10.9.9.1 255.255.255.0']);
  cli(r1, ['en', 'conf t', 'ip route 10.9.9.0 255.255.255.0 s0/0/0', 'ip route 10.9.9.0 255.255.255.0 10.0.0.9 200']);
  assert.equal(ping(net, r1, '10.9.9.1', { count: 1 }).done.received, 1);
  const t = cli(r1, ['en', 'show ip route']).text;
  assert.match(t, /S\s+10\.9\.9\.0\/24 \[1\/0\] is directly connected, Serial0\/0\/0/);
});

/* ================= IOS: пароли, NVRAM, CDP, конфигурация ================= */

test('NVRAM: без write настройки пропадают после перезагрузки, после write — остаются', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R' });
  cli(r, ['en', 'conf t', 'hostname Moscow', 'int g0/0', 'ip add 10.0.0.1 255.0.0.0']);
  assert.ok(r.nvramDirty());
  net.setPower(r, false);
  net.setPower(r, true);
  assert.equal(r.hostname, 'Router');
  assert.equal(r.ifaces[0].ip, null);
  const st = cli(r, ['en', 'conf t', 'hostname Moscow', 'int g0/0', 'ip add 10.0.0.1 255.0.0.0', 'end', 'reload']);
  assert.match(NL.cli.prompt(r, st.session), /System configuration has been modified/);
  cli(r, ['yes', ''], st.session);
  assert.equal(r.hostname, 'Moscow');
  assert.equal(U.ipStr(r.ifaces[0].ip), '10.0.0.1');
  assert.match(cli(r, ['en', 'show startup-config']).text, /hostname Moscow/);
  cli(r, ['en', 'erase startup-config', '']);
  net.setPower(r, false);
  net.setPower(r, true);
  assert.equal(r.hostname, 'Router');
});

test('пароли: enable secret, консольный пароль, service password-encryption', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R' });
  cli(r, ['en', 'conf t', 'enable secret class', 'line con 0', 'password cisco', 'login', 'exit', 'service password-encryption', 'end']);
  const run1 = NL.cli.runningConfig(r).join('\n');
  assert.match(run1, /enable secret 5 \$1\$/);
  assert.match(run1, /password 7 [0-9A-F]+/);
  assert.doesNotMatch(run1, /password cisco/);
  const s = NL.cli.createSession(r, { via: 'console' });
  const res = cli(r, ['', 'bad', 'cisco', 'enable', 'nope', 'class', 'show clock'], s);
  assert.match(res.text, /User Access Verification/);
  assert.equal(NL.cli.prompt(r, s), 'R#'.replace('R', 'Router'));
  assert.match(res.text, /\*\d\d:\d\d:\d\d\.\d{3} UTC Mon Mar 1 1993/);
  assert.equal(U.type7decode(U.type7('cisco')), 'cisco');
});

test('CDP: соседи видны по прямым кабелям', () => {
  const { net, r } = threeNets();
  const t = cli(r, ['en', 'show cdp neighbors']).text;
  assert.match(t, /Switch\s+Gig 0\/0\s+160\s+S I\s+2960-24TT\s+Fas 0\/1/);
  cli(r, ['en', 'conf t', 'no cdp run']);
  assert.match(cli(r, ['en', 'show cdp neighbors']).text, /not enabled/);
});

test('running-config можно применить заново и получить ту же конфигурацию', () => {
  const { net, r } = threeNets();
  net.setPower(r, false);
  net.setModule(r, 'hwic1', 'HWIC-2T');
  net.setPower(r, true);
  routerIf(r, 0, '192.168.1.1/24');
  routerIf(r, 1, '192.168.2.1/24');
  cli(r, ['en', 'conf t', 'hostname Core', 'enable secret s3cret', 'username adm privilege 15 secret pw', 'ip domain-name lab.local', 'banner motd #Только для персонала#',
    'int g0/0', 'description LAN', 'ip nat inside', 'int g0/1', 'ip nat outside', 'ip access-group 110 in',
    'int g0/0.10', 'encapsulation dot1Q 10', 'ip address 172.16.10.1 255.255.255.0', 'int lo0', 'ip add 1.1.1.1 255.255.255.255',
    'int s0/1/0', 'ip add 10.0.0.1 255.255.255.252', 'clock rate 128000', 'encapsulation ppp', 'shutdown',
    'exit', 'access-list 1 permit 192.168.1.0 0.0.0.255', 'access-list 110 permit tcp any any eq 80', 'access-list 110 deny icmp any any echo',
    'ip nat inside source list 1 interface g0/1 overload', 'ip nat inside source static 192.168.1.5 192.168.2.5',
    'ip route 0.0.0.0 0.0.0.0 192.168.2.254', 'ip dhcp excluded-address 192.168.1.1 192.168.1.9', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1',
    'router ospf 5', 'router-id 1.1.1.1', 'network 192.168.1.0 0.0.0.255 area 0', 'passive-interface g0/0', 'router rip', 'version 2', 'network 10.0.0.0', 'no auto-summary',
    'line vty 0 4', 'login local', 'transport input ssh', 'service password-encryption', 'end']);
  const before = JSON.stringify(r.configState());
  const text = NL.cli.runningConfig(r);
  // заводские настройки + применение текста = та же конфигурация
  r.applyConfigState(r.factoryState());
  assert.notEqual(JSON.stringify(r.configState()), before);
  NL.cliIos.replayConfig(r, text, { out: () => {}, write: () => {}, mutate: (f) => f(), done: () => {} });
  assert.deepEqual(JSON.parse(JSON.stringify(r.configState())), JSON.parse(before));
});

test('коммутатор: running-config применяется заново (VLAN, транки, port-security, SVI)', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW', model: '3560-24PS' });
  cli(sw, ['en', 'conf t', 'hostname Access', 'vlan 10', 'name Sales', 'vlan 20', 'int range fa0/1 - 3', 'switchport mode access', 'switchport access vlan 10',
    'int fa0/4', 'switchport mode access', 'switchport port-security', 'switchport port-security maximum 2', 'switchport port-security violation restrict',
    'int g0/1', 'switchport trunk native vlan 99', 'switchport trunk allowed vlan 10,20,99', 'switchport mode trunk', 'int g0/2', 'no switchport', 'ip address 10.0.0.1 255.255.255.252',
    'int vlan 10', 'ip address 192.168.10.1 255.255.255.0', 'exit', 'ip routing', 'spanning-tree vlan 1 priority 4096', 'line vty 0 15', 'password p', 'login', 'end']);
  const before = JSON.stringify(sw.configState());
  const text = NL.cli.runningConfig(sw);
  sw.applyConfigState(sw.factoryState());
  NL.cliIos.replayConfig(sw, text, { out: () => {}, write: () => {}, mutate: (f) => f(), done: () => {} });
  assert.deepEqual(JSON.parse(JSON.stringify(sw.configState())), JSON.parse(before));
});

test('TFTP: резервная копия конфигурации на сервер и восстановление', () => {
  const { net, r, srv } = threeNets();
  cli(r, ['en', 'conf t', 'hostname Branch', 'end']);
  const out = cli(r, ['en', 'copy running-config tftp:', '192.168.2.10', '']).text;
  assert.match(out, /\[OK - \d+ bytes\]/);
  assert.ok(srv.tftpd.files.has('branch-confg'));
  cli(r, ['en', 'conf t', 'hostname Other', 'end']);
  const out2 = cli(r, ['en', 'copy tftp: running-config', '192.168.2.10', 'branch-confg']).text;
  assert.match(out2, /Loading branch-confg/);
  assert.equal(r.hostname, 'Branch');
});

test('IOS: «?» и Tab-дополнение', () => {
  const net = mkNet();
  const r = net.addDevice('router');
  const s = NL.cli.createSession(r);
  cli(r, ['en'], s);
  assert.equal(NL.cli.complete(r, s, 'conf'), 'configure ');
  assert.equal(NL.cli.complete(r, s, 'show run'), 'show running-config ');
  const h = cli(r, ['show ip ?'], s).text;
  assert.match(h, /route/);
  assert.match(h, /interface/);
});

/* ================= сохранение ================= */

test('сохранение v2: модули, кабели, Wi-Fi, службы и NVRAM переживают сохранение и загрузку', () => {
  const { net, ap, lap } = wifiLab();
  lap.setWifi({ ssid: 'Office', security: 'wpa2', key: 'secret123' });
  const r = net.addDevice('router', { name: 'R' });
  net.setPower(r, false);
  net.setModule(r, 'hwic0', 'HWIC-2T');
  net.setPower(r, true);
  cli(r, ['en', 'conf t', 'hostname Saved', 'end', 'write']);
  const cfgBefore = JSON.stringify(r.configState());
  net.addShape('rect', 10, 20, 100, 50, '#ff0000');
  const data = JSON.parse(JSON.stringify(net.serialize()));
  const net2 = NL.Network.deserialize(data);
  assert.deepEqual(JSON.parse(JSON.stringify(net2.serialize())), data);
  const lap2 = net2.getDevice(lap.id);
  assert.equal(net2.wirelessStatus(lap2).ap.id, ap.id);
  assert.equal(ping(net2, lap2, '192.168.1.10', { count: 1 }).done.received, 1);
  const r2 = net2.getDevice(r.id);
  assert.equal(JSON.stringify(r2.configState()), cfgBefore);
  assert.equal(r2.nvramDirty(), false);
  assert.equal(net2.shapes.length, 1);
});

test('файл первой версии открывается (старые модели и формат)', () => {
  const v1 = {
    format: 'netlab', version: 1, counters: { id: 4, mac: 40, link: 3, note: 1, msg: 1, xid: 1 },
    devices: [
      { id: 'd1', type: 'router', name: 'Router0', x: 0, y: 0, power: true, ports: [{ name: 'GigabitEthernet0/0', mac: '00:D0:AA:00:00:01', adminUp: true }], config: { ifaces: [{ name: 'GigabitEthernet0/0', port: 0, vlan: null, sub: false, ip: '10.0.0.1', mask: '255.255.255.0', adminUp: true, dhcp: false, helper: null }], routes: [], dhcpd: { enabled: true, pools: [], excluded: [], leases: [] } } },
      { id: 'd2', type: 'switch', name: 'Switch0', x: 0, y: 0, power: true, ports: [{ name: 'FastEthernet0/1', mac: '00:D0:AA:00:00:02', adminUp: true, mode: 'access', vlan: 1, nativeVlan: 1, allowed: 'all' }], config: { baseMac: '00:D0:AA:00:00:09', stpPriority: 32768, vlans: [[1, 'default']] } },
      { id: 'd3', type: 'pc', name: 'PC0', x: 0, y: 0, power: true, ports: [{ name: 'FastEthernet0', mac: '00:D0:AA:00:00:03', adminUp: true }], config: { ifaces: [{ name: 'FastEthernet0', port: 0, ip: '10.0.0.10', mask: '255.255.255.0', adminUp: true, dhcp: false }], gateway: '10.0.0.1', dns: null } },
    ],
    links: [{ id: 'l1', a: { dev: 'd1', port: 0 }, b: { dev: 'd2', port: 1 } }, { id: 'l2', a: { dev: 'd3', port: 0 }, b: { dev: 'd2', port: 0 } }],
    notes: [],
  };
  const net = NL.Network.deserialize(v1);
  const r = net.getDevice('d1');
  assert.equal(r.model, 'Router-PT');
  assert.equal(r.ports.filter((p) => p.media === 'copper').length, 4);
  assert.equal(ping(net, net.getDevice('d3'), '10.0.0.1').done.received, 4);
  assert.equal(r.nvramDirty(), false, 'конфигурация старого файла считается сохранённой');
});
