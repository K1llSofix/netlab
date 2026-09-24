// Примеры 1.3.0 собираются и работают: VTP/EtherChannel, HSRP, EIGRP+BGP, IPv6, ASA, WLC, WAN, контроллер, VoIP, Syslog/NTP.
const test = require('node:test');
const path = require('path');
const { NL, assert, ping, run } = require('./helpers');

NL.ui = NL.ui || {};
require(path.join(__dirname, '..', 'js', 'ui', 'examples.js'));
require(path.join(__dirname, '..', 'js', 'ui', 'examples-13.js'));

const U = NL.util;
const IDS = ['switching-13', 'hsrp', 'eigrp-bgp', 'ipv6-routing', 'asa-fw', 'wlc', 'wan-access', 'netctrl', 'voip-trunk', 'mgmt-13'];

function build(id) {
  const ex = NL.ui.EXAMPLES.find((e) => e.id === id);
  assert.ok(ex, 'нет примера ' + id);
  const net = ex.build();
  net.runUntilIdle(200000);
  return net;
}
const by = (net, n) => { const d = net.findByName(n); assert.ok(d, 'нет устройства ' + n); return d; };
const cli = (d, lines) => { const s = NL.cli.createSession(d); const out = []; const io = { out: (l) => out.push(l), write: (t) => out.push(t), mutate: (fn) => fn(), done: () => {}, clear: () => {} }; for (const l of lines) { NL.cli.exec(d, s, l, io); d.net.runUntilIdle(200000); } return out.join('\n'); };

test('примеры 1.3.0 собираются, конфигурация сохранена, файл читается обратно', () => {
  for (const id of IDS) {
    const net = build(id);
    for (const d of net.devices.values()) if (d.nvramDirty && !(id === 'voip-trunk' && /^CME/.test(d.name))) assert.equal(d.nvramDirty(), false, id + ': ' + d.name + ' — конфигурация не сохранена');
    const again = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
    assert.equal(again.devices.size, net.devices.size, id);
  }
});

test('примеры 1.3.0 работают', () => {
  let net = build('switching-13');
  assert.equal(ping(net, by(net, 'Staff-1'), '192.168.10.12', { count: 2 }).replies.length >= 1, true, 'VLAN 10 через транки');
  assert.equal(ping(net, by(net, 'Staff-1'), '192.168.20.12', { count: 1 }).replies.length, 0);
  let out = cli(by(net, 'SW2'), ['enable', 'show vlan brief', 'show etherchannel summary']);
  assert.match(out, /10\s+STAFF/);
  assert.match(out, /Po1\(SU\)/);

  net = build('hsrp');
  assert.ok(ping(net, by(net, 'PC1'), '10.0.0.10', { count: 2 }).replies.length >= 1);
  assert.match(cli(by(net, 'R1'), ['enable', 'show standby brief']), /Active/);
  net.setPower(by(net, 'R1'), false);
  net.runUntilIdle(3000);
  assert.ok(ping(net, by(net, 'PC1'), '10.0.0.10', { count: 3 }).replies.length >= 1, 'после отказа R1 шлюз — R2');

  net = build('eigrp-bgp');
  assert.ok(ping(net, by(net, 'PC'), '198.51.100.10', { count: 2 }).replies.length >= 1);
  assert.match(cli(by(net, 'ISP'), ['enable', 'show ip route']), /B\s+192\.168\.1\.0/);

  net = build('ipv6-routing');
  const a = by(net, 'PC-A');
  assert.ok(a.iface.v6.addrs.some((x) => x.origin === 'dhcp'), 'DHCPv6');
  assert.ok(ping(net, a, '2001:db8:2::100', { count: 2 }).replies.length >= 1);

  net = build('asa-fw');
  const p1 = by(net, 'PC1');
  assert.ok(p1.iface.ip != null, 'адрес от ASA');
  assert.ok(ping(net, p1, '198.51.100.10', { count: 2 }).replies.length >= 1);
  assert.equal(ping(net, by(net, 'Internet-Web'), U.ipStr(p1.iface.ip), { count: 1 }).replies.length, 0);

  net = build('wlc');
  for (const n of ['Laptop-CORP', 'Laptop-STAFF']) {
    const l = by(net, n);
    assert.ok(l.iface.ip != null && U.sameNet(l.iface.ip, U.parseIp('192.168.10.0'), U.maskFromPrefix(24)), n + ': ' + U.ipStr(l.iface.ip));
  }
  assert.ok(ping(net, by(net, 'Laptop-CORP'), '192.168.1.10', { count: 2 }).replies.length >= 1);

  net = build('wan-access');
  for (const n of ['Home-DSL', 'Home-Cable', 'Phone']) assert.ok(by(net, n).iface.ip != null, n + ' получил адрес');
  const page = run(net, (cb) => by(net, 'Home-DSL').httpGet('http://www.provider.net', cb));
  assert.ok(page && page.ok, JSON.stringify(page && page.error));

  net = build('netctrl');
  let res;
  by(net, 'Admin').httpRequest('POST', 'http://192.168.1.100/api/v1/ticket', { body: { username: 'admin', password: 'cisco123' } }, (r) => { res = r; });
  net.runUntilIdle(300000);
  assert.ok(res.json && res.json.response && res.json.response.serviceTicket, 'токен получен: ' + res.status);

  net = build('voip-trunk');
  const ph = (n) => by(net, 'Phone-' + n).sccp;
  assert.equal(ph(1001).state, 'registered', ph(1001).text);
  assert.equal(ph(2001).state, 'registered', ph(2001).text);
  ph(1001).dial('2001');
  net.runUntilIdle();
  assert.equal(ph(2001).call && ph(2001).call.state, 'ringing');

  net = build('mgmt-13');
  const r = by(net, 'R1');
  cli(r, ['enable', 'conf t', 'interface loopback 0', 'shutdown', 'end']);
  assert.ok(by(net, 'Server').syslogd.msgs.some((m) => /Loopback0/.test(m.text)), 'сообщения на Syslog-сервере');
  assert.match(cli(r, ['enable', 'show ntp status']), /Clock is synchronized/);
});
