// Контроллер WLC 2504 и лёгкие точки доступа: CAPWAP, WLAN в VLAN, WPA2-PSK и WPA2-Enterprise (RADIUS), option 43.
const test = require('node:test');
const { NL, U, assert, mkNet, host, link, cli, ping } = require('./helpers');

const ip = (s) => U.parseIp(s);

/**
 * R1 (router-on-a-stick: VLAN 1 — управление 192.168.1.0/24, VLAN 10 — Wi-Fi 192.168.10.0/24, DHCP для обоих)
 * — SW — WLC (192.168.1.5), LAP (DHCP), RADIUS-сервер 192.168.1.10.
 */
function lab(opts) {
  opts = opts || {};
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch', { name: 'SW' });
  const wlc = net.addDevice('wlc', { name: 'WLC' });
  const lap = net.addDevice('lap', { name: 'LAP1', x: 0, y: 0 });
  const srv = host(net, 'server', 'RAD', '192.168.1.10/24', '192.168.1.1');
  link(net, r, sw, 0, 0); link(net, wlc, sw, 0, 1); link(net, srv, sw, 0, 3);
  cli(r, ['enable', 'conf t', 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'interface g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0', 'exit',
    'ip dhcp excluded-address 192.168.1.1 192.168.1.19', 'ip dhcp excluded-address 192.168.10.1 192.168.10.9',
    'ip dhcp pool MGMT', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', ...(opts.opt43 ? ['option 43 hex f104.c0a8.0105'] : []), 'exit',
    'ip dhcp pool WIFI', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1', 'end']);
  cli(sw, ['enable', 'conf t', 'vlan 10', 'exit', 'interface range fa0/1 - 2', 'switchport mode trunk', 'interface range fa0/3 - 4', 'switchport mode access', 'end']);
  wlc.setStatic(ip('192.168.1.5'), U.maskFromPrefix(24), ip('192.168.1.1'), null);
  srv.aaad.enabled = true;
  srv.aaad.addClient('WLC', ip('192.168.1.5'), 'wlckey', 'radius');
  srv.aaad.addUser('bob', 'B0bpass!');
  srv.aaad.bind();
  wlc.setRadius([{ ip: ip('192.168.1.10'), key: 'wlckey' }]);
  wlc.setWlan({ ssid: 'CORP', security: 'wpa2', key: 'Secret123', vlan: 10 });
  wlc.setWlan({ ssid: 'ENT', security: 'wpa2-ent', vlan: 10 });
  net.runUntilIdle();
  link(net, lap, sw, 0, 2); // точка доступа включается в уже работающую сеть
  net.runUntilIdle();
  return { net, r, sw, wlc, lap, srv };
}

function laptop(net, name, x) {
  const d = net.addDevice('laptop', { name, x, y: 60 });
  net.setPower(d, false);
  net.setModule(d, 'nic', 'WPC300N');
  net.setPower(d, true);
  return d;
}

test('WLC + LAP: CAPWAP join, клиент WPA2-PSK получает адрес в VLAN 10 и связан с проводной сетью', () => {
  const { net, wlc, lap, srv } = lab();
  net.recording = true;
  assert.ok(lap.iface.ip != null && U.ipStr(lap.iface.ip).startsWith('192.168.1.'), 'LAP получила адрес по DHCP');
  assert.equal(lap.lapRt.state, 'joined', 'LAP подключилась к контроллеру');
  assert.ok(wlc.wlcRt.aps.has(lap.iface.ip));
  assert.deepEqual(net.scanWifi(laptop(net, 'scan', 30)).map((x) => x.ssid).sort(), ['CORP', 'ENT']);
  const a = laptop(net, 'A', 40);
  a.setWifi({ ssid: 'CORP', security: 'wpa2', key: 'wrongpass' });
  assert.match(net.wirelessStatus(a).reason, /Неверный ключ/);
  a.setWifi({ ssid: 'CORP', security: 'wpa2', key: 'Secret123' });
  assert.equal(net.wirelessStatus(a).ap, lap);
  a.setDhcp();
  net.runUntilIdle();
  assert.ok(U.ipStr(a.iface.ip).startsWith('192.168.10.'), 'адрес из VLAN 10: ' + U.ipStr(a.iface.ip));
  assert.equal(a.gateway, ip('192.168.10.1'));
  assert.equal(ping(net, a, '192.168.1.10', { count: 2 }).replies.length, 2, 'клиент Wi-Fi → проводной сервер через туннель CAPWAP и транк');
  assert.ok(net.log.some((e) => e.type === 'tx' && e.proto === 'CAPWAP' && /CAPWAP Data \(CORP\)/.test(NL.packets.summary(e.frame))));
  // второй клиент на той же WLAN видит первого
  const b = laptop(net, 'B', -40);
  b.setWifi({ ssid: 'CORP', security: 'wpa2', key: 'Secret123' });
  b.setDhcp();
  net.runUntilIdle();
  assert.equal(ping(net, b, U.ipStr(a.iface.ip), { count: 2 }).replies.length, 2);
  void srv;
});

test('WPA2-Enterprise: подключение после проверки на RADIUS; неверный пароль — отказ', () => {
  const { net, srv } = lab();
  const a = laptop(net, 'A', 40);
  a.setWifi({ ssid: 'ENT', security: 'wpa2-ent', user: 'bob', pass: 'B0bpass!' });
  a.setDhcp();
  net.runUntilIdle();
  assert.equal(net.wirelessStatus(a).ap && net.wirelessStatus(a).ap.type, 'lap');
  assert.ok(U.ipStr(a.iface.ip).startsWith('192.168.10.'));
  assert.ok(srv.aaad.log.some((l) => /Access-Accept: bob от WLC/.test(l.text)));
  const b = laptop(net, 'B', -40);
  b.setWifi({ ssid: 'ENT', security: 'wpa2-ent', user: 'bob', pass: 'nope' });
  net.runUntilIdle();
  assert.equal(net.wirelessStatus(b).ap, null);
  assert.match(net.wirelessStatus(b).reason, /RADIUS-сервер отклонил пользователя bob/);
});

test('LAP в другой сети находит WLC по DHCP option 43; сохранение и загрузка', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const wlc = net.addDevice('wlc', { name: 'WLC' });
  const lap = net.addDevice('lap', { name: 'LAP1' });
  link(net, r, wlc, 0, 0); link(net, r, lap, 1, 0);
  let out = cli(r, ['enable', 'conf t', 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'interface g0/1', 'ip address 10.20.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool AP', 'network 10.20.0.0 255.255.255.0', 'default-router 10.20.0.1', 'option 43 hex f104.c0a8.0105', 'end', 'show running-config']).text;
  assert.match(out, /ip dhcp pool AP\n network 10\.20\.0\.0 255\.255\.255\.0\n default-router 10\.20\.0\.1\n option 43 hex f104\.c0a8\.0105/);
  wlc.setStatic(ip('192.168.1.5'), U.maskFromPrefix(24), ip('192.168.1.1'), null);
  wlc.setWlan({ ssid: 'Guest', security: 'open' });
  lap.startDhcp();
  net.runUntilIdle();
  assert.equal(lap.lapRt.state, 'joined', 'LAP нашла контроллер через option 43');
  assert.equal(lap.dhcpc.wlc, ip('192.168.1.5'));
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  const w2 = n2.findByName('WLC');
  assert.deepEqual(w2.wlc.wlans.map((w) => w.ssid), ['Guest']);
  assert.equal(n2.findByName('LAP1').lapRt.state, 'joined');
  // без контроллера точка не вещает
  n2.setPower(w2, false);
  n2.refreshTopology();
  assert.equal(n2.findByName('LAP1').radioEnabled(), false);
});
