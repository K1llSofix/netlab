// LLDP и CDP на порту; безопасность IOS: уровни привилегий, parser view, login block-for, min-length, IP Source Guard, storm-control.
const test = require('node:test');
const { NL, U, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

test('LLDP: lldp run, соседи, lldp transmit/receive на порту, no cdp enable, сохранение', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch', { name: 'SW1' });
  routerIf(r, 0, '192.168.1.1/24');
  link(net, r, sw, 0, 0);
  cli(r, ['enable', 'conf t', 'hostname R1', 'end']);
  cli(sw, ['enable', 'conf t', 'hostname SW1', 'interface vlan 1', 'ip address 192.168.1.2 255.255.255.0', 'no shutdown', 'end']);
  net.runUntilIdle();
  assert.match(cli(r, ['enable', 'show lldp neighbors']).text, /% LLDP is not enabled/);
  cli(r, ['enable', 'conf t', 'lldp run', 'end']);
  assert.doesNotMatch(cli(r, ['enable', 'show lldp neighbors']).text, /SW1/, 'у соседа LLDP выключен');
  cli(sw, ['enable', 'conf t', 'lldp run', 'end']);
  let out = cli(r, ['enable', 'show lldp neighbors', 'show lldp neighbors detail', 'show lldp']).text;
  assert.match(out, /^SW1\s+Gi0\/0\s+120\s+B\s+Fa0\/1$/m);
  assert.match(out, /System Name: SW1/);
  assert.match(out, /IP: 192\.168\.1\.2/);
  assert.match(out, /Status: ACTIVE/);
  assert.match(cli(sw, ['enable', 'show lldp neighbors']).text, /^R1\s+Fa0\/1\s+120\s+R\s+Gi0\/0$/m);
  // коммутатор не передаёт LLDP с порта — маршрутизатор его не видит, а сам виден
  cli(sw, ['enable', 'conf t', 'interface fa0/1', 'no lldp transmit', 'no cdp enable', 'end']);
  assert.doesNotMatch(cli(r, ['enable', 'show lldp neighbors']).text, /SW1/);
  assert.match(cli(sw, ['enable', 'show lldp neighbors']).text, /R1/);
  assert.doesNotMatch(cli(r, ['enable', 'show cdp neighbors']).text, /SW1/, 'CDP выключен на порту соседа');
  out = cli(sw, ['enable', 'show running-config']).text;
  assert.match(out, /^lldp run$/m);
  assert.match(out, /interface FastEthernet0\/1\n( .*\n)*? no cdp enable\n no lldp transmit/);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(n2.findByName('SW1').lldpRun, true);
  assert.equal(n2.findByName('SW1').ports[0].lldpTx, false);
  assert.match(cli(n2.findByName('SW1'), ['enable', 'show lldp neighbors']).text, /R1/);
});

function r1pc() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R' });
  routerIf(r, 0, '10.0.0.1/24');
  const a = pc(net, 'A', '10.0.0.10/24', '10.0.0.1');
  link(net, a, r, 0, 0);
  net.runUntilIdle();
  return { net, r, a };
}

test('Уровни привилегий: privilege exec level, enable secret level, username privilege, show privilege', () => {
  const { r, a } = r1pc();
  cli(r, ['enable', 'conf t', 'hostname R1', 'enable secret class', 'enable secret level 5 lvl5pass', 'privilege exec level 5 show running-config', 'privilege exec level 5 configure terminal',
    'privilege configure level 5 hostname', 'username admin privilege 15 secret Adm1n', 'username oper privilege 5 secret Oper1', 'line vty 0 4', 'login local', 'end']);
  // уровень 5 с консоли
  const s = cli(r, ['enable 5', 'lvl5pass', 'show privilege', 'show running-config', 'configure terminal', 'hostname R5', 'end']);
  assert.match(s.text, /Current privilege level is 5/);
  assert.match(s.text, /hostname R1/, 'show running-config разрешён на уровне 5');
  assert.equal(r.ios.hostname, 'R5', 'hostname разрешён на уровне 5');
  assert.equal(NL.cli.prompt(r, s.session), 'R5#');
  assert.match(cli(r, ['enable 5', 'lvl5pass', 'debug ip icmp']).text, /Invalid input detected/);
  assert.match(cli(r, ['enable 5', 'lvl5pass', 'conf t', 'interface g0/0']).text, /Invalid input detected/, 'interface на уровне 5 не разрешён');
  assert.match(cli(r, ['enable 5', 'lvl5pass', 'disable', 'show privilege']).text, /Current privilege level is 1/);
  assert.match(cli(r, ['enable 7']).text, /No password set/);
  // вход по telnet: пользователь с privilege 15 сразу в «#», с privilege 5 — на уровне 5
  let t = cli(a, ['telnet 10.0.0.1', 'admin', 'Adm1n', 'show privilege']);
  assert.match(t.text, /Current privilege level is 15/);
  assert.equal(NL.cli.prompt(a, t.session), 'R5#');
  t = cli(a, ['telnet 10.0.0.1', 'oper', 'Oper1', 'show privilege', 'show running-config']);
  assert.match(t.text, /Current privilege level is 5/);
  assert.match(t.text, /hostname R5/);
  const out = cli(r, ['enable', 'class', 'show running-config']).text;
  assert.match(out, /^enable secret level 5 5 \$1\$/m);
  assert.match(out, /^privilege exec level 5 show running-config$/m);
  assert.match(out, /^privilege configure level 5 hostname$/m);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(r.net.serialize())));
  assert.match(cli(n2.findByName('R'), ['enable 5', 'lvl5pass', 'show privilege']).text, /level is 5/);
});

test('Parser view: нужен aaa new-model и root view, в представлении — только разрешённые команды', () => {
  const { r } = r1pc();
  cli(r, ['enable', 'conf t', 'enable secret class', 'end']);
  assert.match(cli(r, ['enable', 'class', 'enable view']).text, /AAA must be configured/);
  let out = cli(r, ['enable', 'class', 'conf t', 'parser view SHOW']).text;
  assert.match(out, /No view is active/);
  cli(r, ['enable', 'class', 'conf t', 'aaa new-model', 'end']);
  out = cli(r, ['enable', 'class', 'enable view', 'class', 'conf t', 'parser view SHOW', 'secret sh0w', 'commands exec include all show ip', 'commands exec include ping', 'end', 'show parser view all']).text;
  assert.match(out, /successfully set to view 'root'/);
  assert.match(out, /Successfully created the parser view 'SHOW'/);
  assert.match(out, /Views\/SuperViews Present in System:\n SHOW/);
  const s = cli(r, ['enable', 'class', 'enable view SHOW', 'sh0w', 'show parser view', 'show ip interface brief', 'show running-config', 'configure terminal']);
  assert.match(s.text, /Current view is 'SHOW'/);
  assert.match(s.text, /GigabitEthernet0\/0\s+10\.0\.0\.1/);
  assert.equal((s.text.match(/Invalid input detected/g) || []).length, 2, 'show running-config и configure — вне представления');
  out = cli(r, ['enable', 'class', 'show running-config']).text;
  assert.match(out, /^parser view SHOW\n secret 5 \$1\$\S+\n commands exec include all show ip\n commands exec include ping\n!/m);
});

test('Защита входа: login block-for, quiet-mode access-class, журнал; security passwords min-length', () => {
  const { net, r, a } = r1pc();
  cli(r, ['enable', 'conf t', 'security passwords min-length 8', 'username admin secret Adm1nPass', 'line vty 0 4', 'login local', 'end']);
  let out = cli(r, ['enable', 'conf t', 'enable secret tiny', 'end']).text;
  assert.match(out, /Password too short - must be at least 8 characters/);
  assert.equal(r.ios.enableSecret, null);
  assert.match(cli(r, ['enable', 'conf t', 'line vty 0 4', 'password abc', 'end']).text, /Password too short/);
  cli(r, ['enable', 'conf t', 'login block-for 3000 attempts 2 within 30', 'login on-failure log', 'login on-success log', 'end']);
  cli(a, ['telnet 10.0.0.1', 'admin', 'bad1', 'admin', 'bad2']);
  out = r.logBuf.join('\n');
  assert.match(out, /%SEC_LOGIN-4-LOGIN_FAILED: Login failed \[user: admin\] \[Source: 10\.0\.0\.10\]/);
  assert.match(out, /%SEC_LOGIN-1-QUIET_MODE_ON/);
  assert.match(cli(a, ['telnet 10.0.0.1']).text, /refused/i, 'в тихом режиме вход закрыт');
  assert.match(cli(r, ['enable', 'show login']).text, /Router presently in Quiet-Mode/);
  // адрес администратора в списке — ему можно
  cli(r, ['enable', 'conf t', 'access-list 10 permit host 10.0.0.10', 'login quiet-mode access-class 10', 'end']);
  const ok = cli(a, ['telnet 10.0.0.1', 'admin', 'Adm1nPass', 'show privilege']);
  assert.match(ok.text, /Current privilege level is 1/);
  assert.match(r.logBuf.join('\n'), /%SEC_LOGIN-5-LOGIN_SUCCESS: Login Success \[user: admin\]/);
  net.run(300100);
  assert.match(r.logBuf.join('\n'), /%SEC_LOGIN-5-QUIET_MODE_OFF/);
  out = cli(r, ['enable', 'show running-config']).text;
  assert.match(out, /^security passwords min-length 8$/m);
  assert.match(out, /^login block-for 3000 attempts 2 within 30$/m);
  assert.match(out, /^login quiet-mode access-class 10$/m);
});

test('IP Source Guard и storm-control на коммутаторе', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R' });
  const sw = net.addDevice('switch', { name: 'SW' });
  routerIf(r, 0, '192.168.1.1/24');
  link(net, r, sw, 0, 23);
  cli(r, ['enable', 'conf t', 'ip dhcp excluded-address 192.168.1.1', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'end']);
  cli(sw, ['enable', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 1', 'no ip dhcp snooping information option', 'interface fa0/24', 'ip dhcp snooping trust', 'interface range fa0/1 - 2', 'ip verify source', 'end']);
  const good = net.addDevice('pc', { name: 'Good' });
  const bad = pc(net, 'Bad', '192.168.1.99/24', '192.168.1.1');
  link(net, good, sw, 0, 0);
  link(net, bad, sw, 0, 1);
  good.setDhcp();
  net.runUntilIdle();
  assert.ok(good.iface.ip != null, 'DHCP проходит через IP Source Guard');
  const p = (d) => { let done = null; d.ping('192.168.1.1', { count: 2, onEvent: (e) => { if (e.type === 'done') done = e; } }); net.runUntilIdle(); return done.received; };
  assert.ok(p(good) >= 1);
  net.recording = true;
  assert.equal(p(bad), 0, 'статический адрес без привязки не проходит');
  assert.ok(net.log.some((e) => e.type === 'drop' && /IP Source Guard/.test(e.reason)));
  let out = cli(sw, ['enable', 'show ip verify source']).text;
  assert.match(out, /Fa0\/1\s+ip\s+active\s+192\.168\.1\.\d+/);
  assert.match(out, /Fa0\/2\s+ip\s+active\s+deny-all/);
  cli(sw, ['enable', 'conf t', 'ip source binding ' + U.ciscoMac(bad.ifaceMac(bad.iface)) + ' vlan 1 192.168.1.99 interface fa0/2', 'end']);
  assert.ok(p(bad) >= 1, 'статическая привязка разрешает адрес');
  // storm-control: не больше 2 широковещательных кадров в секунду, затем err-disable
  cli(sw, ['enable', 'conf t', 'interface fa0/1', 'storm-control broadcast level pps 2', 'storm-control action shutdown', 'end']);
  for (let i = 0; i < 4; i++) good.sendArp(good.iface, 'request', good.iface.ip, U.parseIp('192.168.1.' + (200 + i)), 'FF:FF:FF:FF:FF:FF', null);
  net.runUntilIdle();
  assert.equal(sw.ports[0].errDisabled, true);
  assert.match(sw.logBuf.join('\n'), /storm-control error detected on Fa0\/1/);
  out = cli(sw, ['enable', 'show storm-control', 'show running-config']).text;
  assert.match(out, /Fa0\/1\s+Shutdown\s+2 pps/);
  assert.match(out, /^ storm-control broadcast level pps 2\n storm-control action shutdown$/m);
  assert.match(out, /^ ip verify source$/m);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.deepEqual(n2.findByName('SW').ports[0].storm, { broadcast: { unit: 'pps', level: 2 }, action: 'shutdown' });
});
