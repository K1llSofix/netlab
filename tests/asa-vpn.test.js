// IPsec site-to-site между ASA и маршрутизатором IOS: crypto ikev1, tunnel-group, crypto map, twice NAT без трансляции.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping } = require('./helpers');
const U = NL.util;

function lab() {
  const net = mkNet();
  const asa = net.addDevice('asa', { name: 'ASA' });
  const isp = net.addDevice('router', { name: 'ISP' });
  const r2 = net.addDevice('router', { name: 'R2' });
  const pc1 = pc(net, 'PC1', '192.168.1.10/24', '192.168.1.1');
  const pc2 = pc(net, 'PC2', '192.168.2.10/24', '192.168.2.1');
  link(net, asa, isp, 0, 0);
  link(net, pc1, asa, 0, 1);
  link(net, r2, isp, 0, 1);
  link(net, pc2, r2, 0, 1);
  routerIf(isp, 0, '203.0.113.1/24');
  routerIf(isp, 1, '10.0.2.2/24');
  routerIf(r2, 0, '10.0.2.1/24');
  routerIf(r2, 1, '192.168.2.1/24');
  cli(asa, ['enable', '', 'conf t', 'hostname FW',
    'interface g1/1', 'nameif outside', 'ip address 203.0.113.2 255.255.255.0', 'no shutdown',
    'interface g1/2', 'nameif inside', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'route outside 0.0.0.0 0.0.0.0 203.0.113.1',
    'object network LAN', 'subnet 192.168.1.0 255.255.255.0', 'nat (inside,outside) dynamic interface', 'exit',
    'object network REMOTE', 'subnet 192.168.2.0 255.255.255.0', 'exit',
    'policy-map global_policy', 'class inspection_default', 'inspect icmp', 'exit', 'exit',
    'access-list VPN extended permit ip object LAN object REMOTE',
    'nat (inside,outside) source static LAN LAN destination static REMOTE REMOTE no-proxy-arp route-lookup',
    'crypto ikev1 policy 10', 'authentication pre-share', 'encryption aes-256', 'hash sha', 'group 5', 'lifetime 86400', 'exit',
    'crypto ikev1 enable outside',
    'crypto ipsec ikev1 transform-set TS esp-aes esp-sha-hmac',
    'crypto map CMAP 10 match address VPN', 'crypto map CMAP 10 set peer 10.0.2.1', 'crypto map CMAP 10 set ikev1 transform-set TS', 'crypto map CMAP interface outside',
    'tunnel-group 10.0.2.1 type ipsec-l2l', 'tunnel-group 10.0.2.1 ipsec-attributes', 'ikev1 pre-shared-key cisco123', 'end']);
  cli(r2, ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.0.2.2',
    'crypto isakmp policy 10', 'encryption aes 256', 'hash sha', 'authentication pre-share', 'group 5', 'exit',
    'crypto isakmp key cisco123 address 203.0.113.2',
    'crypto ipsec transform-set TS esp-aes esp-sha-hmac', 'exit',
    'access-list 110 permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255',
    'crypto map VPN 10 ipsec-isakmp', 'set peer 203.0.113.2', 'set transform-set TS', 'match address 110', 'exit',
    'interface g0/0', 'crypto map VPN', 'end']);
  net.runUntilIdle();
  return { net, asa, isp, r2, pc1, pc2 };
}

test('ASA ↔ IOS: IPsec site-to-site, трафик в ESP, show crypto, running-config, сохранение', () => {
  const { net, asa, pc1, pc2 } = lab();
  const frames = [];
  net.recording = true;
  const off = net.on((t, e) => { if (t === 'log' && e.type === 'tx') frames.push(e.frame); });
  const r = ping(net, pc1, '192.168.2.10', { count: 4 });
  off();
  assert.ok(r.replies.length >= 3, 'через туннель ' + r.replies.length + '/4');
  assert.ok(frames.some((f) => f && f.type === 'IPv4' && f.payload.proto === 'ESP'), 'пакеты шли в ESP');
  assert.ok(frames.some((f) => f && f.type === 'IPv4' && f.payload.proto === 'UDP' && f.payload.payload.dport === 500), 'IKE на UDP 500');
  assert.equal(ping(net, pc2, '192.168.1.10', { count: 2 }).replies.length, 2, 'обратно — тоже через туннель');
  let out = cli(asa, ['enable', '', 'show crypto isakmp sa', 'show crypto ipsec sa', 'show running-config']).text;
  assert.match(out, /IKE Peer: 10\.0\.2\.1/);
  assert.match(out, /State\s+: MM_ACTIVE/);
  assert.match(out, /current_peer: 10\.0\.2\.1/);
  assert.match(out, /#pkts encaps: [1-9]/);
  assert.match(out, /^crypto map CMAP 10 match address VPN$/m);
  assert.match(out, /^crypto map CMAP interface outside$/m);
  assert.match(out, /^crypto ikev1 enable outside$/m);
  assert.match(out, /^crypto ikev1 policy 10\n authentication pre-share\n encryption aes-256\n hash sha\n group 5/m);
  assert.match(out, /^tunnel-group 10\.0\.2\.1 type ipsec-l2l$/m);
  assert.match(out, /^nat \(inside,outside\) source static LAN LAN destination static REMOTE REMOTE no-proxy-arp route-lookup$/m);
  // интернет без туннеля — по-прежнему через PAT
  assert.equal(ping(net, pc1, '10.0.2.2', { count: 2 }).replies.length, 2, 'в интернет — через PAT');
  out = cli(asa, ['enable', '', 'show xlate', 'show nat']).text;
  assert.match(out, /ICMP PAT from inside:192\.168\.1\.10/);
  assert.match(out, /Manual NAT Policies \(Section 1\)\n1 \(inside\) to \(outside\) source static LAN LAN   destination static REMOTE REMOTE/);
  assert.match(out, /translate_hits = [1-9]/);
  assert.match(out, /Auto NAT Policies \(Section 2\)\n1 \(inside\) to \(outside\) source dynamic LAN interface/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.ok(ping(n2, n2.findByName('PC1'), '192.168.2.10', { count: 3 }).replies.length >= 2, 'после загрузки туннель поднимается снова');
});

test('ASA: без twice NAT трафик VPN уходит через PAT и не шифруется; неверный ключ', () => {
  let { net, asa, pc1 } = lab();
  cli(asa, ['enable', '', 'conf t', 'no nat (inside,outside) source static LAN LAN destination static REMOTE REMOTE no-proxy-arp route-lookup', 'end']);
  assert.equal(ping(net, pc1, '192.168.2.10', { count: 2 }).replies.length, 0);
  ({ net, asa, pc1 } = lab());
  cli(asa, ['enable', '', 'conf t', 'tunnel-group 10.0.2.1 ipsec-attributes', 'ikev1 pre-shared-key WRONG', 'end']);
  assert.equal(ping(net, pc1, '192.168.2.10', { count: 2 }).replies.length, 0, 'ключи не совпадают — туннеля нет');
});

test('ASA 5505: заводской конфиг, порты встроенного коммутатора в VLAN, outside по DHCP, PAT, DMZ на VLAN 3, сохранение', () => {
  const net = mkNet();
  const fw = net.addDevice('asa', { name: 'FW', model: 'ASA5505' });
  const isp = net.addDevice('router', { name: 'ISP' });
  const a = net.addDevice('pc', { name: 'A' });
  const b = net.addDevice('pc', { name: 'B' });
  const srv = pc(net, 'SRV', '10.0.3.10/24', '10.0.3.1');
  assert.deepEqual(fw.ports.slice(0, 8).map((p) => p.name), [0, 1, 2, 3, 4, 5, 6, 7].map((i) => 'Ethernet0/' + i));
  assert.equal(fw.ifaces.filter((f) => f.kind === 'phys').length, 0, 'у портов коммутатора нет своих IP-интерфейсов');
  routerIf(isp, 0, '203.0.113.1/24');
  cli(isp, ['enable', 'conf t', 'ip dhcp excluded-address 203.0.113.1', 'ip dhcp pool OUT', 'network 203.0.113.0 255.255.255.0', 'default-router 203.0.113.1', 'end']);
  link(net, fw, isp, 0, 0);
  link(net, a, fw, 0, 1);
  link(net, b, fw, 0, 2);
  link(net, srv, fw, 0, 3);
  a.setDhcp();
  b.setDhcp();
  net.runUntilIdle(200000);
  // заводской конфиг: inside 192.168.1.1, DHCP 192.168.1.5–36; outside — адрес от провайдера
  assert.equal(U.ipStr(a.iface.ip).startsWith('192.168.1.'), true, 'A получил адрес от ASA: ' + U.ipStr(a.iface.ip));
  assert.equal(U.ipStr(a.gateway), '192.168.1.1');
  const v2 = fw.ifaceByName('Vlan2');
  assert.ok(v2.ip != null && U.ipStr(v2.ip).startsWith('203.0.113.'), 'outside по DHCP');
  // коммутация внутри VLAN 1
  assert.equal(ping(net, a, U.ipStr(b.iface.ip), { count: 2 }).replies.length, 2);
  let out = cli(fw, ['enable', '', 'show switch vlan', 'show interface ip brief', 'show version', 'show running-config']).text;
  assert.match(out, /^1    inside\s+up\s+Et0\/1, Et0\/2, Et0\/3/m);
  assert.match(out, /^2    outside\s+up\s+Et0\/0/m);
  assert.match(out, /^Vlan2\s+203\.0\.113\.\d+\s+YES DHCP\s+up/m);
  assert.match(out, /Hardware:\s+ASA5505/);
  assert.match(out, /^interface Ethernet0\/0\n switchport access vlan 2\n!/m);
  assert.match(out, /^interface Vlan1\n nameif inside\n security-level 100\n ip address 192\.168\.1\.1 255\.255\.255\.0/m);
  assert.match(out, /^interface Vlan2\n nameif outside\n security-level 0\n ip address dhcp setroute/m);
  // PAT + inspect icmp; DMZ на VLAN 3
  out = cli(fw, ['enable', '', 'conf t', 'object network LAN', 'subnet 192.168.1.0 255.255.255.0', 'nat (inside,outside) dynamic interface', 'exit',
    'policy-map global_policy', 'class inspection_default', 'inspect icmp', 'exit', 'exit',
    'interface vlan 3', 'nameif dmz', 'security-level 50', 'ip address 10.0.3.1 255.255.255.0', 'no shutdown',
    'interface ethernet0/3', 'switchport access vlan 3', 'no shutdown', 'ip address 1.1.1.1 255.0.0.0', 'end']).text;
  assert.match(out, /порт встроенного коммутатора/);
  assert.equal(ping(net, a, '203.0.113.1', { count: 2 }).replies.length, 2, 'в интернет через PAT');
  assert.equal(ping(net, a, '10.0.3.10', { count: 2 }).replies.length, 2, 'inside → dmz');
  assert.equal(ping(net, srv, U.ipStr(a.iface.ip), { count: 1 }).replies.length, 0, 'dmz → inside запрещено');
  out = cli(fw, ['enable', '', 'show switch vlan', 'show running-config']).text;
  assert.match(out, /^3    dmz\s+up\s+Et0\/3/m);
  assert.match(out, /^interface Ethernet0\/3\n switchport access vlan 3\n!/m);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle(200000);
  const fw2 = n2.findByName('FW');
  assert.equal(cli(fw2, ['enable', '', 'show running-config']).text.replace(/ip address dhcp.*/, ''), cli(fw, ['enable', '', 'show running-config']).text.replace(/ip address dhcp.*/, ''));
  assert.equal(ping(n2, n2.findByName('A'), '10.0.3.10', { count: 2 }).replies.length, 2);
  // no interface vlan
  cli(fw, ['enable', '', 'conf t', 'no interface vlan 3', 'end']);
  assert.equal(fw.ifaceByName('Vlan3'), null);
});

test('ASA WebVPN: портал на HTTPS, вход, закладки из url-list, доступ к внутреннему серверу через ASA, выход, сохранение', () => {
  const net = mkNet();
  const fw = net.addDevice('asa', { name: 'FW' });
  const isp = net.addDevice('router', { name: 'ISP' });
  const home = pc(net, 'HOME', '198.51.100.10/24', '198.51.100.1');
  const web = net.addDevice('server', { name: 'WEB' });
  web.setStatic(U.parseIp('192.168.1.100'), U.maskFromPrefix(24), U.parseIp('192.168.1.1'), null);
  web.httpd.setFile('index.html', '<html><head><title>Intranet</title></head><body><h1>Корпоративный портал</h1><a href="news.html">Новости</a> <a href="http://192.168.1.100/news.html">абс</a></body></html>');
  web.httpd.setFile('news.html', '<html><body><h2>Новости компании</h2></body></html>');
  link(net, fw, isp, 0, 0);
  link(net, web, fw, 0, 1);
  link(net, home, isp, 0, 1);
  routerIf(isp, 0, '203.0.113.1/24');
  routerIf(isp, 1, '198.51.100.1/24');
  let out = cli(fw, ['enable', '', 'conf t', 'hostname FW',
    'interface g1/1', 'nameif outside', 'ip address 203.0.113.2 255.255.255.0', 'no shutdown',
    'interface g1/2', 'nameif inside', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'route outside 0.0.0.0 0.0.0.0 203.0.113.1',
    'username alice password Secret1',
    'username bob password Bob12345',
    'url-list INTRANET "Корпоративный портал" http://192.168.1.100',
    'webvpn', 'enable outside', 'exit',
    'group-policy WEB internal', 'group-policy WEB attributes', 'vpn-tunnel-protocol ssl-clientless', 'banner value Только для сотрудников', 'webvpn', 'url-list value INTRANET', 'exit',
    'group-policy NOWEB internal', 'group-policy NOWEB attributes', 'vpn-tunnel-protocol ikev1', 'exit',
    'tunnel-group DefaultWEBVPNGroup general-attributes', 'default-group-policy WEB', 'exit',
    'username bob attributes', 'vpn-group-policy NOWEB', 'end']).text;
  assert.match(out, /WebVPN and DTLS are enabled on 'outside'/);
  const get = (url, opts) => { let r; home.httpGet(url, (x) => { r = x; }, opts); net.runUntilIdle(200000); return r; };
  // сертификат ASA — самоподписанный
  let r = get('https://203.0.113.2');
  assert.equal(r.ok, false);
  assert.equal(r.cert.code, 'self-signed');
  r = get('https://203.0.113.2', { insecure: true });
  assert.ok(r.ok, r.error);
  assert.match(r.body, /SSL VPN Service/);
  assert.match(r.body, /<form action="\/\+webvpn\+\/index\.html" method="post">/);
  // неверный пароль; пользователь без ssl-clientless
  r = get('https://203.0.113.2/+webvpn+/index.html', { insecure: true, form: { username: 'alice', password: 'wrong' } });
  assert.match(r.body, /Login failed/);
  assert.equal(r.setCookie, undefined);
  r = get('https://203.0.113.2/+webvpn+/index.html', { insecure: true, form: { username: 'bob', password: 'Bob12345' } });
  assert.match(r.body, /Clientless \(browser\) SSL VPN access is not allowed/);
  // вход
  r = get('https://203.0.113.2/+webvpn+/index.html', { insecure: true, form: { username: 'alice', password: 'Secret1' } });
  assert.match(r.setCookie, /^webvpn=\w+$/);
  const cookie = r.setCookie;
  assert.match(r.body, /Пользователь: <b>alice<\/b>/);
  assert.match(r.body, /Только для сотрудников/);
  assert.match(r.body, /<a href="\/\+CSCO\+\/http\/192\.168\.1\.100\/index\.html">Корпоративный портал<\/a>/);
  // без cookie — снова страница входа
  assert.match(get('https://203.0.113.2/+CSCO+/http/192.168.1.100/index.html', { insecure: true }).body, /USERNAME/);
  // напрямую внутренний сервер из интернета недоступен
  assert.equal(get('http://192.168.1.100').ok, false);
  // через портал
  r = get('https://203.0.113.2/+CSCO+/http/192.168.1.100/index.html', { insecure: true, cookie });
  assert.ok(r.ok);
  assert.match(r.body, /<title>Intranet<\/title>/);
  assert.match(r.body, /Корпоративный портал/);
  assert.match(r.body, /href="\/\+CSCO\+\/http\/192\.168\.1\.100\/news\.html"/, 'относительная ссылка переписана');
  assert.doesNotMatch(r.body, /href="http:\/\/192\.168\.1\.100/, 'абсолютная ссылка переписана');
  r = get('https://203.0.113.2/+CSCO+/http/192.168.1.100/news.html', { insecure: true, cookie });
  assert.match(r.body, /Новости компании/);
  r = get('https://203.0.113.2/+webvpn+/go', { insecure: true, cookie, form: { url: '192.168.1.100/news.html' } });
  assert.match(r.body, /Новости компании/);
  // show vpn-sessiondb webvpn, running-config
  out = cli(fw, ['enable', '', 'show vpn-sessiondb webvpn', 'show running-config', 'show logging']).text;
  assert.match(out, /Username\s+: alice\s+Index\s+: 1/);
  assert.match(out, /Public IP\s+: 198\.51\.100\.10/);
  assert.match(out, /Group Policy : WEB\s+Tunnel Group : DefaultWEBVPNGroup/);
  assert.match(out, /^url-list INTRANET "Корпоративный портал" http:\/\/192\.168\.1\.100$/m);
  assert.match(out, /^webvpn\n enable outside$/m);
  assert.match(out, /^group-policy WEB attributes\n banner value Только для сотрудников\n vpn-tunnel-protocol ssl-clientless\n webvpn\n  url-list value INTRANET$/m);
  assert.match(out, /^username bob attributes\n vpn-group-policy NOWEB$/m);
  assert.match(out, /^tunnel-group DefaultWEBVPNGroup general-attributes\n default-group-policy WEB$/m);
  assert.match(fw.logBuf.join('\n'), /%ASA-6-716001: Group <WEB> User <alice> IP <198\.51\.100\.10> WebVPN session started\./);
  assert.match(fw.logBuf.join('\n'), /%ASA-6-113015: AAA user authentication Rejected/);
  // выход
  r = get('https://203.0.113.2/+webvpn+/webvpn_logout.html', { insecure: true, cookie });
  assert.equal(r.setCookie, '');
  assert.match(get('https://203.0.113.2/+CSCO+/http/192.168.1.100/index.html', { insecure: true, cookie }).body, /USERNAME/);
  assert.match(cli(fw, ['enable', '', 'show vpn-sessiondb webvpn']).text, /no active sessions/);
  // WebVPN не включён на inside — портал изнутри не открывается
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle(200000);
  const fw2 = n2.findByName('FW');
  assert.equal(cli(fw2, ['enable', '', 'show running-config']).text, cli(fw, ['enable', '', 'show running-config']).text);
  let r2;
  n2.findByName('HOME').httpGet('https://203.0.113.2/+webvpn+/index.html', (x) => { r2 = x; }, { insecure: true, form: { username: 'alice', password: 'Secret1' } });
  n2.runUntilIdle(200000);
  assert.match(r2.setCookie || '', /^webvpn=/);
});

test('ASA — ответчик IKE: туннель поднимает маршрутизатор IOS (проверка зеркальности ACL ASA)', () => {
  const { net, pc2 } = lab();
  assert.ok(ping(net, pc2, '192.168.1.10', { count: 3 }).replies.length >= 2, 'туннель по инициативе филиала');
});
