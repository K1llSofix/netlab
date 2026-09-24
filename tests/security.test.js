// Безопасность: AAA (RADIUS, TACACS+, запасной local), DHCP snooping, Dynamic ARP Inspection, 802.1X.
const test = require('node:test');
const { NL, U, assert, mkNet, host, pc, routerIf, link, cli, ping } = require('./helpers');

const ip = (s) => U.parseIp(s);

/** Интерактивный сеанс на ПК: step(line) → весь накопленный вывод. */
function term(net, dev) {
  const s = NL.cli.createSession(dev);
  const out = [];
  const io = { out: (l) => out.push(l), write: (t) => out.push(t), mutate: (f) => f(), done: () => {}, clear: () => {} };
  const step = (l) => { NL.cli.exec(dev, s, l, io); net.runUntilIdle(); return out.join('\n'); };
  return { s, out, step, prompt: () => NL.cli.prompt(dev, s) };
}

/** ПК и AAA-сервер в сети 10.0.0.0/24 с маршрутизатором R1 (10.0.0.1). */
function aaaLab() {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const r = net.addDevice('router', { name: 'R1' });
  const a = pc(net, 'PC', '10.0.0.20/24', '10.0.0.1');
  const srv = host(net, 'server', 'AAA', '10.0.0.10/24', '10.0.0.1');
  link(net, r, sw, 0, 23); link(net, a, sw, 0, 0); link(net, srv, sw, 0, 1);
  routerIf(r, 0, '10.0.0.1/24');
  srv.aaad.enabled = true;
  srv.aaad.addClient('R1', ip('10.0.0.1'), 'RADKEY', 'radius');
  srv.aaad.addClient('R1-tac', ip('10.0.0.1'), 'TACKEY', 'tacacs');
  srv.aaad.addUser('netadmin', 'Str0ng');
  srv.aaad.bind();
  cli(r, ['enable', 'conf t', 'hostname R1', 'username local1 secret L0cal',
    'aaa new-model', 'aaa authentication login default group radius local',
    'radius server RAD', 'address ipv4 10.0.0.10 auth-port 1812 acct-port 1813', 'key RADKEY', 'exit',
    'tacacs server TAC', 'address ipv4 10.0.0.10', 'key TACKEY', 'exit',
    'line vty 0 4', 'transport input telnet', 'end']);
  net.runUntilIdle();
  return { net, r, a, srv };
}

test('AAA RADIUS: вход по Telnet через сервер, отказ, test aaa, show aaa servers, running-config', () => {
  const { net, r, a, srv } = aaaLab();
  let t = term(net, a);
  t.step('telnet 10.0.0.1');
  assert.equal(t.prompt(), 'Username: ');
  t.step('netadmin');
  assert.equal(t.prompt(), 'Password: ');
  t.step('wrong');
  assert.match(t.out.join('\n'), /% Authentication failed/);
  assert.equal(t.prompt(), 'Username: ', 'после отказа — новая попытка');
  t.step('netadmin');
  t.step('Str0ng');
  assert.equal(t.prompt(), 'R1>');
  assert.ok(srv.aaad.log.some((l) => /Access-Accept: netadmin от R1/.test(l.text)));
  // локальный пользователь при доступном сервере не проходит: отказ сервера окончателен
  t = term(net, a);
  t.step('telnet 10.0.0.1'); t.step('local1'); t.step('L0cal');
  assert.notEqual(t.prompt(), 'R1>');
  let out = cli(r, ['enable', 'test aaa group radius netadmin Str0ng legacy', 'test aaa group radius netadmin bad legacy', 'test aaa group tacacs+ netadmin Str0ng legacy', 'show aaa servers']).text;
  assert.match(out, /Attempting authentication test to server-group radius using radius\nUser was successfully authenticated\./);
  assert.match(out, /User authentication request was rejected by server\./);
  assert.match(out, /server-group tacacs\+ using tacacs\+\nUser was successfully authenticated\./);
  assert.match(out, /RADIUS: id 1, priority 1, host 10\.0\.0\.10, auth-port 1812, acct-port 1813\n\s+State: current UP/);
  assert.match(out, /Response: accept \d+, reject \d+/);
  out = cli(r, ['enable', 'show running-config']).text;
  assert.match(out, /aaa new-model\n!\naaa authentication login default group radius local\n!/);
  assert.match(out, /radius server RAD\n address ipv4 10\.0\.0\.10 auth-port 1812 acct-port 1813\n key RADKEY\n!/);
  assert.match(out, /tacacs server TAC\n address ipv4 10\.0\.0\.10\n key TACKEY\n!/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.match(cli(n2.findByName('R1'), ['enable', 'test aaa group radius netadmin Str0ng legacy']).text, /successfully authenticated/);
});

test('AAA: неверный ключ и выключенный сервер — переход к local; TACACS+ через login authentication', () => {
  const { net, r, a, srv } = aaaLab();
  cli(r, ['enable', 'conf t', 'radius server RAD', 'key WRONG', 'end']);
  let out = cli(r, ['enable', 'test aaa group radius netadmin Str0ng legacy']).text;
  assert.match(out, /No authoritative response from any server/);
  assert.ok(srv.aaad.log.some((l) => /неверный общий ключ от R1/.test(l.text)));
  // сервер не отвечает — запасной метод local
  let t = term(net, a);
  t.step('telnet 10.0.0.1'); t.step('local1'); t.step('L0cal');
  assert.equal(t.prompt(), 'R1>', 'RADIUS недоступен — сработал local');
  assert.match(r.logBuf.join('\n'), /%RADIUS-4-RADIUS_DEAD: RADIUS server 10\.0\.0\.10:1812,1813 is not responding/);
  // именованный список на vty: TACACS+
  cli(r, ['enable', 'conf t', 'aaa authentication login VTY group tacacs+ local', 'line vty 0 4', 'login authentication VTY', 'end']);
  t = term(net, a);
  t.step('telnet 10.0.0.1'); t.step('netadmin'); t.step('Str0ng');
  assert.equal(t.prompt(), 'R1>');
  assert.ok(srv.aaad.log.some((l) => /TACACS\+ PASS: netadmin/.test(l.text)));
  assert.match(cli(r, ['enable', 'show running-config']).text, /line vty 0 4\n login authentication VTY/);
  // служба выключена: TACACS+ отвергает соединение → local
  srv.aaad.enabled = false;
  srv.aaad.bind();
  t = term(net, a);
  t.step('telnet 10.0.0.1'); t.step('local1'); t.step('L0cal');
  assert.equal(t.prompt(), 'R1>');
  // без aaa new-model команды AAA недоступны
  const r2 = mkNet().addDevice('router');
  out = cli(r2, ['enable', 'conf t', 'aaa authentication login default local']).text;
  assert.match(out, /aaa new-model/);
});

/** Коммутатор: настоящий DHCP-сервер (R1) на Fa0/24, «чужой» сервер на Fa0/5, клиенты на Fa0/1–2. */
function snoopLab() {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const r = net.addDevice('router', { name: 'R1' });
  routerIf(r, 0, '192.168.1.1/24');
  link(net, r, sw, 0, 23);
  cli(r, ['enable', 'conf t', 'ip dhcp excluded-address 192.168.1.1 192.168.1.9', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'end']);
  const rogue = host(net, 'server', 'ROGUE', '192.168.1.250/24', null);
  rogue.dhcpd.enabled = true;
  rogue.dhcpd.setPool({ name: 'EVIL', start: ip('192.168.1.200'), end: ip('192.168.1.210'), mask: U.maskFromPrefix(24), gateway: ip('192.168.1.250'), dns: null });
  link(net, rogue, sw, 0, 4);
  const p1 = net.addDevice('pc', { name: 'PC1' });
  const p2 = net.addDevice('pc', { name: 'PC2' });
  link(net, p1, sw, 0, 0); link(net, p2, sw, 0, 1);
  cli(sw, ['enable', 'conf t', 'interface range fa0/1 - 24', 'switchport mode access', 'end']);
  net.runUntilIdle();
  return { net, sw, r, rogue, p1, p2 };
}

test('DHCP snooping: ответы «чужого» сервера отбрасываются, таблица привязок, limit rate', () => {
  const { net, sw, p1, p2 } = snoopLab();
  cli(sw, ['enable', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 1', 'no ip dhcp snooping information option', 'interface fa0/24', 'ip dhcp snooping trust', 'end']);
  net.recording = true;
  p1.setDhcp();
  p2.setDhcp();
  net.runUntilIdle();
  for (const p of [p1, p2]) {
    assert.ok(p.iface.ip != null, 'адрес получен');
    assert.equal(U.net(p.iface.ip, U.maskFromPrefix(24)), ip('192.168.1.0'));
    assert.ok(p.iface.ip < ip('192.168.1.200'), 'адрес от настоящего сервера, а не от ROGUE: ' + U.ipStr(p.iface.ip));
    assert.equal(p.gateway, ip('192.168.1.1'));
  }
  assert.ok(net.log.some((e) => e.type === 'drop' && /DHCP snooping: ответ DHCP-сервера \(OFFER\) на недоверенном порту FastEthernet0\/5/.test(e.reason)));
  assert.match(sw.logBuf.join('\n'), /%DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT: DHCP_SNOOPING drop message on untrusted port, message type: DHCPOFFER/);
  let out = cli(sw, ['enable', 'show ip dhcp snooping binding', 'show ip dhcp snooping']).text;
  assert.match(out, new RegExp(p1.ifaceMac(p1.iface).replace(/:/g, ':') + '\\s+' + U.ipStr(p1.iface.ip).replace(/\./g, '\\.') + '\\s+\\d+\\s+dhcp-snooping\\s+1\\s+FastEthernet0/1'));
  assert.match(out, /Total number of bindings: 2/);
  assert.match(out, /Switch DHCP snooping is enabled\nDHCP snooping is configured on following VLANs:\n1\n/);
  assert.match(out, /Insertion of option 82 is disabled/);
  assert.match(out, /FastEthernet0\/24\s+yes\s+yes\s+unlimited/);
  out = cli(sw, ['enable', 'show running-config']).text;
  assert.match(out, /ip dhcp snooping vlan 1\nno ip dhcp snooping information option\nip dhcp snooping\n/);
  assert.match(out, /interface FastEthernet0\/24\n[\s\S]*? ip dhcp snooping trust\n/);
  // limit rate 1: два DHCP-пакета за секунду — порт в err-disabled
  cli(sw, ['enable', 'conf t', 'interface fa0/2', 'ip dhcp snooping limit rate 1', 'end']);
  p2.releaseDhcp();
  p2.setDhcp();
  net.runUntilIdle();
  assert.ok(sw.ports[1].errDisabled, 'Fa0/2 выключен');
  assert.match(sw.logBuf.join('\n'), /%PM-4-ERR_DISABLE: dhcp-rate-limit error detected on Fa0\/2/);
  // сохранение настроек
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  const sw2 = n2.findByName('SW');
  assert.ok(sw2.snoop.on && sw2.ports[23].snoopTrust && sw2.ports[1].snoopRate === 1);
});

test('Dynamic ARP Inspection: подмена шлюза отброшена, клиенты DHCP работают, статический узел — через ARP ACL', () => {
  const { net, sw, r, rogue, p1 } = snoopLab();
  cli(sw, ['enable', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 1', 'interface fa0/24', 'ip dhcp snooping trust', 'ip arp inspection trust', 'exit', 'ip arp inspection vlan 1', 'end']);
  rogue.dhcpd.enabled = false;
  net.recording = true;
  p1.setDhcp();
  net.runUntilIdle();
  assert.equal(ping(net, p1, '192.168.1.1', { count: 2 }).replies.length, 2, 'клиент DHCP — есть привязка, ARP проходит');
  // атака: ROGUE объявляет себя шлюзом 192.168.1.1
  const f = rogue.iface;
  rogue.sendArp(f, 'reply', ip('192.168.1.1'), p1.iface.ip, p1.ifaceMac(p1.iface), p1.ifaceMac(p1.iface), 'Поддельный ARP: 192.168.1.1 — это я');
  net.runUntilIdle();
  assert.notEqual(p1.arp.get(ip('192.168.1.1')).mac, rogue.ifaceMac(rogue.iface), 'кэш ARP клиента не отравлен');
  assert.match(sw.logBuf.join('\n'), /%SW_DAI-4-DHCP_SNOOPING_DENY: 1 Invalid ARPs \(Res\) on Fa0\/5, vlan 1\.\(\[[0-9a-f.]+\/192\.168\.1\.1\//);
  // статический узел без привязки не работает
  assert.equal(ping(net, rogue, '192.168.1.1', { count: 1 }).replies.length, 0);
  let out = cli(sw, ['enable', 'show ip arp inspection']).text;
  assert.match(out, /\n\s+1\s+Enabled\s+Active/);
  assert.match(out, /Vlan\s+Forwarded\s+Dropped\s+DHCP Drops\s+ACL Drops\n.*\n\s+1\s+\d+\s+[1-9]\d*\s+[1-9]\d*\s+0/);
  // ARP ACL разрешает статический адрес
  cli(sw, ['enable', 'conf t', 'arp access-list STATIC', 'permit ip host 192.168.1.250 mac host ' + U.ciscoMac(rogue.ifaceMac(rogue.iface)), 'exit', 'ip arp inspection filter STATIC vlan 1', 'end']);
  assert.equal(ping(net, rogue, '192.168.1.1', { count: 2 }).replies.length, 2, 'ARP ACL пропускает статический узел');
  out = cli(sw, ['enable', 'show running-config', 'show ip arp inspection interfaces']).text;
  assert.match(out, /ip arp inspection vlan 1\nip arp inspection filter STATIC vlan 1/);
  assert.match(out, /arp access-list STATIC\n permit ip host 192\.168\.1\.250 mac host [0-9a-f.]+\n!/);
  assert.match(out, /Fa0\/24\s+Trusted/);
  assert.match(out, /Fa0\/1\s+Untrusted\s+15/);
  void r;
});

/** 802.1X: коммутатор с SVI 10.0.0.2 проверяет пользователей на RADIUS 10.0.0.10. */
function dot1xLab(user, pass) {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const srv = host(net, 'server', 'RADIUS', '10.0.0.10/24', null);
  const a = pc(net, 'PC', '10.0.0.20/24', null);
  link(net, srv, sw, 0, 23); link(net, a, sw, 0, 0);
  srv.aaad.enabled = true;
  srv.aaad.addClient('SW', ip('10.0.0.2'), 'K8021X', 'radius');
  srv.aaad.addUser('alice', 'Wonder1and');
  srv.aaad.bind();
  cli(sw, ['enable', 'conf t', 'interface vlan 1', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'aaa new-model', 'aaa authentication dot1x default group radius', 'dot1x system-auth-control',
    'radius server R', 'address ipv4 10.0.0.10 auth-port 1812', 'key K8021X', 'exit',
    'interface fa0/1', 'switchport mode access', 'authentication port-control auto', 'dot1x pae authenticator', 'end']);
  net.runUntilIdle();
  if (user) a.setDot1x(a.iface, { enabled: true, user, pass });
  net.runUntilIdle();
  return { net, sw, srv, a };
}

test('802.1X: без проверки порт закрыт; EAP-MD5 через RADIUS открывает порт; неверный пароль — нет', () => {
  let lab = dot1xLab(null);
  assert.equal(ping(lab.net, lab.a, '10.0.0.10', { count: 1 }).replies.length, 0, 'порт не авторизован');
  assert.match(cli(lab.sw, ['enable', 'show dot1x all']).text, /Sysauthcontrol\s+Enabled[\s\S]*Dot1x Info for FastEthernet0\/1[\s\S]*PAE\s+= AUTHENTICATOR\nPortControl\s+= AUTO[\s\S]*Status\s+= UNAUTHORIZED/);

  lab = dot1xLab('alice', 'Wonder1and');
  lab.net.recording = true;
  assert.equal(ping(lab.net, lab.a, '10.0.0.10', { count: 2 }).replies.length, 2, 'после 802.1X сеть доступна');
  const out = cli(lab.sw, ['enable', 'show authentication sessions', 'show dot1x all', 'show running-config']).text;
  assert.match(out, /Fa0\/1\s+[0-9a-f.]+\s+dot1x\s+DATA\s+Auth/);
  assert.match(out, /Status\s+= AUTHORIZED\nUser\s+= alice/);
  assert.match(out, /interface FastEthernet0\/1\n switchport mode access\n[\s\S]*? authentication port-control auto\n dot1x pae authenticator/);
  assert.match(out, /dot1x system-auth-control/);
  assert.match(lab.sw.logBuf.join('\n'), /%DOT1X-5-SUCCESS: Authentication successful for client \([0-9a-f.]+\) on Interface Fa0\/1/);
  assert.ok(lab.srv.aaad.log.some((l) => /Access-Accept: alice от SW/.test(l.text)));

  lab = dot1xLab('alice', 'bad');
  assert.equal(ping(lab.net, lab.a, '10.0.0.10', { count: 1 }).replies.length, 0);
  assert.match(lab.sw.logBuf.join('\n'), /%DOT1X-5-FAIL: Authentication failed/);
  assert.equal(lab.a.eapRt.get(lab.a.iface.id).state, 'failed');
  // 802.1X только на access-портах
  const sw = mkNet().addDevice('switch');
  assert.match(cli(sw, ['enable', 'conf t', 'interface fa0/2', 'authentication port-control auto']).text, /is not an access port/);
  // сохранение: ПК снова проходит проверку после загрузки
  const good = dot1xLab('alice', 'Wonder1and');
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(good.net.serialize())));
  n2.runUntilIdle();
  assert.equal(ping(n2, n2.findByName('PC'), '10.0.0.10', { count: 2 }).replies.length, 2);
});

/** ПК (зона IN) — R1 — сервер (зона OUT) и ПК в DMZ без зоны. */
function zbfLab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const a = pc(net, 'PC', '192.168.1.10/24', '192.168.1.1');
  const srv = host(net, 'server', 'WEB', '203.0.113.10/24', '203.0.113.1');
  const dmz = pc(net, 'DMZ', '172.16.0.10/24', '172.16.0.1');
  link(net, a, r, 0, 0); link(net, srv, r, 0, 1); link(net, dmz, r, 0, 2);
  routerIf(r, 0, '192.168.1.1/24'); routerIf(r, 1, '203.0.113.1/24'); routerIf(r, 2, '172.16.0.1/24');
  net.runUntilIdle();
  return { net, r, a, srv, dmz };
}

test('Zone-Based Firewall: inspect пропускает ответы, обратное направление и «без зоны» запрещены', () => {
  const { net, r, a, srv, dmz } = zbfLab();
  cli(r, ['enable', 'conf t', 'zone security IN', 'zone security OUT', 'exit',
    'class-map type inspect match-any IN-OUT-C', 'match protocol icmp', 'match protocol http', 'exit',
    'policy-map type inspect IN-OUT-P', 'class type inspect IN-OUT-C', 'inspect', 'class class-default', 'drop log', 'exit', 'exit',
    'zone-pair security IN-OUT source IN destination OUT', 'service-policy type inspect IN-OUT-P', 'exit',
    'interface g0/0', 'zone-member security IN', 'interface g0/1', 'zone-member security OUT', 'end']);
  net.recording = true;
  assert.equal(ping(net, a, '203.0.113.10', { count: 2 }).replies.length, 2, 'изнутри наружу — inspect, ответы проходят');
  const page = (() => { let res; a.httpGet('http://203.0.113.10', (x) => { res = x; }); net.runUntilIdle(200000); return res; })();
  assert.ok(page && page.ok, 'HTTP изнутри наружу: ' + JSON.stringify(page));
  assert.equal(ping(net, srv, '192.168.1.10', { count: 1 }).replies.length, 0, 'снаружи внутрь — нет zone-pair');
  assert.ok(net.log.some((e) => e.type === 'drop' && /Zone-Based Firewall: нет zone-pair OUT → IN/.test(e.reason)));
  assert.equal(ping(net, dmz, '192.168.1.10', { count: 1 }).replies.length, 0, 'интерфейс без зоны → зона запрещено');
  assert.ok(net.log.some((e) => e.type === 'drop' && /не входит ни в одну зону/.test(e.reason)));
  assert.equal(ping(net, dmz, '203.0.113.10', { count: 1 }).replies.length, 0);
  let out = cli(r, ['enable', 'show zone security', 'show zone-pair security', 'show policy-map type inspect zone-pair sessions']).text;
  assert.match(out, /zone IN\n  Member Interfaces:\n    GigabitEthernet0\/0/);
  assert.match(out, /Zone-pair name IN-OUT\n    Source-Zone IN  Destination-Zone OUT\n    service-policy IN-OUT-P/);
  assert.match(out, /Class-map: IN-OUT-C \(match-any\)\n      Inspect\n        Established Sessions\n         Session \d+ \(192\.168\.1\.10:\d+\)=>\(203\.0\.113\.10:\d+\) icmp SIS_OPEN/);
  out = cli(r, ['enable', 'show running-config']).text;
  assert.match(out, /class-map type inspect match-any IN-OUT-C\n match protocol icmp\n match protocol http\n!\npolicy-map type inspect IN-OUT-P\n class type inspect IN-OUT-C\n  inspect\n class class-default\n  drop log\n!\nzone security IN\nzone security OUT\nzone-pair security IN-OUT source IN destination OUT\n service-policy type inspect IN-OUT-P\n!/);
  assert.match(out, /interface GigabitEthernet0\/1\n ip address 203\.0\.113\.1 255\.255\.255\.0\n zone-member security OUT/);
  // telnet (не в классе) изнутри — class-default drop с журналом
  cli(a, ['telnet 203.0.113.10']);
  assert.match(r.logBuf.join('\n'), /%FW-6-DROP_PKT: Dropping tcp session 192\.168\.1\.10 203\.0\.113\.10 on zone-pair IN-OUT class class-default/);
  // зона, которой нет; удалить зону с интерфейсами нельзя
  assert.match(cli(r, ['enable', 'conf t', 'interface g0/2', 'zone-member security DMZ']).text, /% Zone DMZ does not exist/);
  assert.match(cli(r, ['enable', 'conf t', 'no zone security IN']).text, /Remove all interfaces from zone IN first/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(ping(n2, n2.findByName('PC'), '203.0.113.10', { count: 1 }).replies.length, 1);
  assert.equal(ping(n2, n2.findByName('WEB'), '192.168.1.10', { count: 1 }).replies.length, 0);
});

/** ПК и веб-сервер внутри — ASA 5506-X — провайдер (ISP) — внешний сервер 198.51.100.10. */
function asaLab() {
  const net = mkNet();
  const asa = net.addDevice('asa', { name: 'ASA' });
  const isp = net.addDevice('router', { name: 'ISP' });
  const sw = net.addDevice('switch', { name: 'SW' });
  const a = net.addDevice('pc', { name: 'PC' });
  const web = host(net, 'server', 'WEB', '192.168.1.50/24', '192.168.1.1');
  const ext = host(net, 'server', 'EXT', '198.51.100.10/24', '198.51.100.1');
  const dmz = pc(net, 'DMZPC', '172.16.1.10/24', '172.16.1.1');
  link(net, asa, isp, 0, 0); link(net, asa, sw, 1, 23); link(net, a, sw, 0, 0); link(net, web, sw, 0, 1); link(net, ext, isp, 0, 1); link(net, dmz, asa, 0, 2);
  routerIf(isp, 0, '203.0.113.1/24'); routerIf(isp, 1, '198.51.100.1/24');
  const out = cli(asa, ['enable', '', 'conf t', 'hostname FW',
    'interface g1/1', 'nameif outside', 'ip address 203.0.113.2 255.255.255.0', 'no shutdown',
    'interface g1/2', 'nameif inside', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown',
    'interface g1/3', 'nameif dmz', 'security-level 50', 'ip address 172.16.1.1 255.255.255.0', 'no shutdown', 'exit',
    'route outside 0.0.0.0 0.0.0.0 203.0.113.1',
    'object network LAN', 'subnet 192.168.1.0 255.255.255.0', 'nat (inside,outside) dynamic interface', 'exit',
    'dhcpd address 192.168.1.10-192.168.1.20 inside', 'dhcpd dns 198.51.100.10', 'dhcpd enable inside', 'end']).text;
  a.setDhcp();
  net.runUntilIdle();
  return { net, asa, isp, a, web, ext, dmz, out };
}

test('ASA 5506-X: nameif и security-level, PAT, ICMP без inspect не возвращается, inspect icmp, static NAT и access-group', () => {
  const { net, asa, a, web, ext, dmz, out } = asaLab();
  assert.match(out, /INFO: Security level for "outside" set to 0 by default\./);
  assert.match(out, /INFO: Security level for "inside" set to 100 by default\./);
  assert.equal(NL.cli.prompt(asa, NL.cli.createSession(asa)), 'FW>');
  // DHCP от ASA
  assert.equal(U.ipStr(a.iface.ip), '192.168.1.10');
  assert.equal(a.gateway, ip('192.168.1.1'));
  net.recording = true;
  // ping наружу: запрос уходит (PAT), ответ ASA отбрасывает — нет inspect icmp
  assert.equal(ping(net, a, '198.51.100.10', { count: 1 }).replies.length, 0);
  assert.ok(net.log.some((e) => e.type === 'drop' && /без inspect icmp ASA не помнит ping изнутри/.test(e.reason)));
  assert.match(asa.logBuf.join('\n'), /%ASA-2-106001: Deny inbound icmp src outside:198\.51\.100\.10 dst inside:192\.168\.1\.10 \(type 0, code 0\)/);
  // TCP проверяется всегда: HTTP изнутри работает через PAT
  let page;
  a.httpGet('http://198.51.100.10', (r) => { page = r; });
  net.runUntilIdle(200000);
  assert.ok(page && page.ok, JSON.stringify(page));
  let o = cli(asa, ['enable', '', 'show xlate', 'show conn']).text;
  assert.match(o, /TCP PAT from inside:192\.168\.1\.10\/\d+ to outside:203\.0\.113\.2\/\d+ flags ri/);
  assert.match(o, /TCP outside  198\.51\.100\.10:80 inside  192\.168\.1\.10:\d+/);
  // inspect icmp — ping проходит
  cli(asa, ['enable', '', 'conf t', 'policy-map global_policy', 'class inspection_default', 'inspect icmp', 'end']);
  assert.equal(ping(net, a, '198.51.100.10', { count: 2 }).replies.length, 2);
  assert.match(cli(asa, ['enable', '', 'show xlate']).text, /ICMP PAT from inside:192\.168\.1\.10\/\d+ to outside:203\.0\.113\.2/);
  // снаружи внутрь без ACL — нельзя; ping на внешний адрес самого ASA — можно
  assert.equal(ping(net, ext, '203.0.113.2', { count: 1 }).replies.length, 1);
  assert.equal(ping(net, ext, '192.168.1.1', { count: 1 }).replies.length, 0, 'ASA не отвечает на адрес дальнего интерфейса');
  // уровни: inside(100) → dmz(50) можно, dmz → inside нельзя
  assert.equal(ping(net, a, '172.16.1.10', { count: 1 }).replies.length, 1);
  assert.equal(ping(net, dmz, '192.168.1.10', { count: 1 }).replies.length, 0);
  assert.ok(net.log.some((e) => e.type === 'drop' && /с уровня 50 \(dmz\) на более высокий 100 \(inside\)/.test(e.reason)));
  // публикация веб-сервера: static NAT + access-group
  cli(asa, ['enable', '', 'conf t', 'object network WEB', 'host 192.168.1.50', 'nat (inside,outside) static 203.0.113.50', 'exit',
    'access-list OUTSIDE extended permit tcp any host 192.168.1.50 eq www', 'access-group OUTSIDE in interface outside', 'end']);
  page = null;
  ext.httpGet('http://203.0.113.50', (r) => { page = r; });
  net.runUntilIdle(200000);
  assert.ok(page && page.ok, 'веб-сервер доступен снаружи: ' + JSON.stringify(page));
  assert.equal(ping(net, ext, '203.0.113.50', { count: 1 }).replies.length, 0, 'ICMP списком OUTSIDE не разрешён');
  o = cli(asa, ['enable', '', 'show access-list', 'show nameif', 'show interface ip brief', 'show route', 'show running-config']).text;
  assert.match(o, /access-list OUTSIDE line 1 extended permit tcp any host 192\.168\.1\.50 eq www \(hitcnt=[1-9]\d*\)/);
  assert.match(o, /GigabitEthernet1\/3\s+dmz\s+50/);
  assert.match(o, /GigabitEthernet1\/1\s+203\.0\.113\.2\s+YES manual up\s+up/);
  assert.match(o, /GigabitEthernet1\/4\s+unassigned\s+YES unset\s+administratively down\s+down/);
  assert.match(o, /S\*\s+0\.0\.0\.0 0\.0\.0\.0 \[1\/0\] via 203\.0\.113\.1, outside/);
  assert.match(o, /interface GigabitEthernet1\/1\n nameif outside\n security-level 0\n ip address 203\.0\.113\.2 255\.255\.255\.0\n!/);
  assert.match(o, /object network LAN\n nat \(inside,outside\) dynamic interface/);
  assert.match(o, /access-group OUTSIDE in interface outside\nroute outside 0\.0\.0\.0 0\.0\.0\.0 203\.0\.113\.1 1/);
  assert.match(o, /dhcpd address 192\.168\.1\.10-192\.168\.1\.20 inside\ndhcpd enable inside/);
  assert.match(o, /policy-map global_policy\n class inspection_default\n[\s\S]*?  inspect icmp\n!/);
  // write memory и сохранение
  cli(asa, ['enable', '', 'write memory']);
  assert.ok(!asa.nvramDirty());
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle(100000);
  const a2 = n2.findByName('PC');
  a2.setDhcp();
  n2.runUntilIdle(100000);
  assert.equal(ping(n2, a2, '198.51.100.10', { count: 2 }).replies.length, 2);
  void web;
});
