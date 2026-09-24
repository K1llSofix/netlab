// Управление: журнал IOS и Syslog, NTP, FTP (сервер, клиент ПК, copy … ftp:), debug.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping } = require('./helpers');

const U = NL.util;

function lab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch', { name: 'SW' });
  routerIf(r, 0, '10.0.0.1/24');
  link(net, r, sw, 0);
  const srv = net.addDevice('server', { name: 'Srv' });
  srv.setStatic(U.parseIp('10.0.0.5'), U.maskFromPrefix(24), U.parseIp('10.0.0.1'), null);
  link(net, srv, sw);
  const host = pc(net, 'PC', '10.0.0.10/24', '10.0.0.1');
  link(net, host, sw);
  net.runUntilIdle();
  return { net, r, sw, srv, host };
}

test('Syslog: сообщения интерфейсов и конфигурации уходят на сервер, trap фильтрует по уровню', () => {
  const { net, r, srv } = lab();
  cli(r, ['enable', 'conf t', 'logging host 10.0.0.5', 'service timestamps log datetime msec', 'end']);
  assert.ok(srv.syslogd.msgs.some((m) => /%SYS-5-CONFIG_I: Configured from console/.test(m.text)), JSON.stringify(srv.syslogd.msgs));
  const pc2 = pc(net, 'PC2', '10.0.1.10/24');
  cli(r, ['enable', 'conf t', 'interface g0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'end']);
  link(net, pc2, r, undefined, 1);
  net.runUntilIdle();
  const texts = srv.syslogd.msgs.map((m) => m.text);
  assert.ok(texts.some((t) => /%LINK-3-UPDOWN: Interface GigabitEthernet0\/1, changed state to up/.test(t)));
  assert.ok(texts.some((t) => /%LINEPROTO-5-UPDOWN/.test(t)));
  assert.ok(texts.every((t) => /^\*/.test(t)), 'с service timestamps у сообщений есть время');
  assert.equal(srv.syslogd.msgs[0].host, '10.0.0.1');
  // trap warnings (4): уровень 5 не уходит, уровень 3 — уходит
  cli(r, ['enable', 'conf t', 'logging trap warnings', 'end']);
  const before = srv.syslogd.msgs.length;
  net.disconnect(pc2.ports[pc2.iface.port].link);
  net.runUntilIdle();
  const added = srv.syslogd.msgs.slice(before).map((m) => m.text);
  assert.ok(added.some((t) => /LINK-3-UPDOWN.*down/.test(t)), added.join('|'));
  assert.ok(!added.some((t) => /LINEPROTO-5/.test(t)));
  const out = cli(r, ['enable', 'show logging', 'show running-config']).text;
  assert.match(out, /Logging to 10\.0\.0\.5/);
  assert.match(out, /%LINEPROTO-5-UPDOWN/);
  assert.match(out, /^logging trap warnings$/m);
  assert.match(out, /^logging host 10\.0\.0\.5$/m);
  assert.match(out, /^service timestamps log datetime msec$/m);
  // выключенная служба — ICMP «порт недоступен»
  srv.syslogd.enabled = false;
  const n = srv.syslogd.msgs.length;
  cli(r, ['enable', 'conf t', 'end']);
  assert.equal(srv.syslogd.msgs.length, n);
});

test('NTP: синхронизация с сервером, аутентификация, ntp master', () => {
  const { net, r, srv } = lab();
  srv.clockOffset = 86400000 * 365 * 30; // 2023 год
  cli(r, ['enable', 'conf t', 'ntp server 10.0.0.5', 'end']);
  assert.equal(r.ntpRt.synced, true, r.ntpRt.text);
  assert.ok(Math.abs(NL.mgmt.absTime(r) - NL.mgmt.absTime(srv)) < 1000, 'часы совпали с сервером');
  let out = cli(r, ['enable', 'show ntp status', 'show ntp associations', 'show clock']).text;
  assert.match(out, /Clock is synchronized, stratum 2, reference is 10\.0\.0\.5/);
  assert.match(out, /\*~10\.0\.0\.5/);
  assert.doesNotMatch(out.split('\n').pop(), /^\*/);
  // аутентификация: на сервере ключ, на маршрутизаторе — другой
  srv.ntpd.auth = true;
  srv.ntpd.keyId = 1;
  srv.ntpd.key = 'secret';
  cli(r, ['enable', 'conf t', 'ntp authentication-key 1 md5 wrong', 'ntp trusted-key 1', 'ntp authenticate', 'ntp server 10.0.0.5 key 1', 'end']);
  assert.equal(r.ntpRt.synced, false);
  cli(r, ['enable', 'conf t', 'ntp authentication-key 1 md5 secret', 'ntp server 10.0.0.5 key 1', 'end']);
  assert.equal(r.ntpRt.synced, true, r.ntpRt.text);
  out = cli(r, ['enable', 'show running-config']).text;
  assert.match(out, /^ntp authentication-key 1 md5 secret$/m);
  assert.match(out, /^ntp server 10\.0\.0\.5 key 1$/m);
  // маршрутизатор-источник времени для другого
  const r2 = net.addDevice('router', { name: 'R2' });
  routerIf(r2, 0, '10.0.0.2/24');
  link(net, r2, net.findByName('SW'), 0);
  cli(r2, ['enable', 'conf t', 'ntp master 4', 'end']);
  const r3 = net.addDevice('router', { name: 'R3' });
  routerIf(r3, 0, '10.0.0.3/24');
  link(net, r3, net.findByName('SW'), 0);
  cli(r3, ['enable', 'conf t', 'ntp server 10.0.0.2', 'end']);
  assert.equal(r3.ntpRt.stratum, 5);
  // после загрузки файла синхронизация повторяется
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(n2.findByName('R1').ntpRt.synced, true);
});

test('FTP: ftp на компьютере (dir, put, get, права), copy running-config ftp: на маршрутизаторе', () => {
  const { net, r, srv, host } = lab();
  host.saveFile('notes.txt', 'привет, FTP');
  srv.ftpd.addUser('guest', 'guest', 'rl');
  let out = cli(host, ['ftp 10.0.0.5', 'cisco', 'cisco', 'dir', 'put notes.txt', 'rename notes.txt n2.txt', 'get n2.txt', 'quit']).text;
  assert.match(out, /230- Logged in/);
  assert.match(out, /c2960-lanbasek9/);
  assert.match(out, /\[Transfer complete - 11 bytes\]/);
  assert.equal(srv.ftpd.files.get('n2.txt'), 'привет, FTP');
  assert.ok(host.files.some((f) => f.name === 'n2.txt'));
  out = cli(host, ['ftp 10.0.0.5', 'guest', 'guest', 'put notes.txt', 'delete n2.txt', 'quit']).text;
  assert.match(out, /Permission denied \(write\)/);
  assert.match(out, /Permission denied \(delete\)/);
  out = cli(host, ['ftp 10.0.0.5', 'cisco', 'wrong']).text;
  assert.match(out, /530- Login incorrect/);

  // маршрутизатор: без учётных данных — ошибка, с ними — файл на сервере
  out = cli(r, ['enable', 'copy running-config ftp:', '10.0.0.5', '']).text;
  assert.match(out, /ip ftp username/);
  cli(r, ['enable', 'conf t', 'hostname Core', 'ip ftp username cisco', 'ip ftp password cisco', 'end']);
  out = cli(r, ['enable', 'copy running-config ftp:', '10.0.0.5', '']).text;
  assert.match(out, /\[OK - \d+ bytes\]/, out);
  assert.match(srv.ftpd.files.get('core-confg'), /hostname Core/);
  // обратно: изменённый файл применяется
  srv.ftpd.files.set('new.cfg', 'hostname FromFTP\n');
  cli(r, ['enable', 'copy ftp: running-config', '10.0.0.5', 'new.cfg']);
  assert.equal(r.ios.hostname, 'FromFTP');
  // выключенная служба
  srv.ftpd.enabled = false;
  srv.ftpd.bind();
  out = cli(host, ['ftp 10.0.0.5']).text;
  assert.match(out, /refused/i);
});

test('debug: ICMP и пакеты в консоли, undebug all; OSPF: сообщения о соседях', () => {
  const { net, r, host } = lab();
  let out = cli(r, ['enable', 'debug ip icmp', 'debug ip packet', 'show debugging']).text;
  assert.match(out, /ICMP packet debugging is on/);
  assert.match(out, /IP packet debugging is on/);
  r.consoleLines.length = 0;
  ping(net, host, '10.0.0.1', { count: 1 });
  const con = r.consoleLines.join('\n');
  assert.match(con, /ICMP: echo rcvd, src 10\.0\.0\.10, dst 10\.0\.0\.1/);
  assert.match(con, /ICMP: echo reply sent, src 10\.0\.0\.1, dst 10\.0\.0\.10/);
  assert.match(con, /IP: s=10\.0\.0\.10 \(GigabitEthernet0\/0\), d=10\.0\.0\.1, len \d+, rcvd 3/);
  out = cli(r, ['enable', 'undebug all']).text;
  assert.match(out, /All possible debugging has been turned off/);
  r.consoleLines.length = 0;
  ping(net, host, '10.0.0.1', { count: 1 });
  assert.equal(r.consoleLines.length, 0);

  // OSPF: при появлении соседа — %OSPF-5-ADJCHG
  const r2 = net.addDevice('router', { name: 'R2' });
  routerIf(r2, 0, '10.0.0.2/24');
  link(net, r2, net.findByName('SW'), 0);
  cli(r, ['enable', 'debug ip ospf adj', 'conf t', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end']);
  cli(r2, ['enable', 'conf t', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end']);
  ping(net, host, '10.0.0.2', { count: 1 });
  const log = r.logBuf.join('\n');
  assert.match(log, /%OSPF-5-ADJCHG: Process 1, Nbr 10\.0\.0\.2 on GigabitEthernet0\/0 from LOADING to FULL, Loading Done/);
  assert.match(r.consoleLines.join('\n'), /OSPF: Synchronized with 10\.0\.0\.2/);
});
