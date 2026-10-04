// Примеры 1.4.0 собираются и работают: ASA 5505 (IPsec, WebVPN), Frame Relay, физическое пространство, IP SLA, Linux, HTTPS, Python.
const test = require('node:test');
const path = require('path');
const { NL, assert, ping } = require('./helpers');

NL.ui = NL.ui || {};
require(path.join(__dirname, '..', 'js', 'ui', 'examples.js'));
require(path.join(__dirname, '..', 'js', 'ui', 'examples-14.js'));

const IDS = ['asa5505-vpn', 'frame-relay', 'places-campus', 'ipsla-track', 'linux-iptables', 'https-certs', 'python-automation'];

function build(id) {
  const ex = NL.ui.EXAMPLES.find((e) => e.id === id);
  assert.ok(ex, 'нет примера ' + id);
  const net = ex.build();
  net.runUntilIdle(200000);
  return net;
}
const by = (net, n) => { const d = net.findByName(n); assert.ok(d, 'нет устройства ' + n); return d; };
const cli = (d, lines) => { const s = NL.cli.createSession(d); const out = []; const io = { out: (l) => out.push(l), write: (t) => out.push(t), mutate: (fn) => fn(), done: () => {}, clear: () => {} }; for (const l of lines) { NL.cli.exec(d, s, l, io); d.net.runUntilIdle(200000); } return out.join('\n'); };
const get = (net, d, url, opts) => { let r = null; d.httpGet(url, (x) => { r = x; }, opts); net.runUntilIdle(200000); return r; };

test('примеры 1.4.0 собираются, конфигурация сохранена, файл читается обратно', () => {
  for (const id of IDS) {
    const net = build(id);
    for (const d of net.devices.values()) if (d.nvramDirty) assert.equal(d.nvramDirty(), false, id + ': ' + d.name + ' — конфигурация не сохранена');
    const again = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
    assert.equal(again.devices.size, net.devices.size, id);
  }
});

test('пример ASA 5505: DHCP, туннель IPsec с филиалом, WebVPN из дома', () => {
  const net = build('asa5505-vpn');
  const pc = by(net, 'PC-HQ');
  assert.ok(pc.iface.ip != null && NL.util.ipStr(pc.iface.ip).startsWith('192.168.1.'), 'адрес от ASA');
  assert.ok(ping(net, by(net, 'PC-Branch'), '192.168.1.100', { count: 3 }).replies.length >= 2, 'филиал → сервер через IPsec');
  assert.ok(ping(net, pc, '198.51.100.10', { count: 2 }).replies.length >= 1, 'в интернет через PAT');
  const home = by(net, 'Home');
  const r = get(net, home, 'https://203.0.113.2/+webvpn+/index.html', { insecure: true, form: { username: 'alice', password: 'Secret1' } });
  assert.match(r.setCookie || '', /^webvpn=/);
  assert.match(get(net, home, 'https://203.0.113.2/+CSCO+/http/192.168.1.100/index.html', { insecure: true, cookie: r.setCookie }).body, /Корпоративный портал/);
  const out = cli(by(net, 'FW'), ['enable', '', 'show crypto ipsec sa', 'show switch vlan']);
  assert.match(out, /#pkts encaps: [1-9]/);
  assert.match(out, /^2    outside\s+up\s+Et0\/0/m);
});

test('примеры 1.4.0: Frame Relay, физическое пространство, IP SLA, Linux, HTTPS', () => {
  let net = build('frame-relay');
  assert.ok(ping(net, by(net, 'PC-B1'), '192.168.12.10', { count: 2 }).replies.length >= 1, 'филиал → филиал через HQ');
  assert.match(cli(by(net, 'HQ'), ['enable', 'show ip ospf neighbor']), /FULL/);

  net = build('places-campus');
  assert.equal(NL.places.on(net), true);
  const fl = [...net.links.values()].find((l) => l.cable === 'fiber');
  const len = NL.physical.linkLength(net, fl);
  assert.ok(len > 200 && len < 300, 'оптика между зданиями ~250 м: ' + len);
  assert.equal(net.linkIssue(fl), null);
  assert.ok(ping(net, by(net, 'PC-Office'), '192.168.1.20', { count: 2 }).replies.length >= 1);

  net = build('ipsla-track');
  const pc = by(net, 'PC');
  assert.ok(ping(net, pc, '8.8.8.8', { count: 2 }).replies.length >= 1);
  assert.match(cli(by(net, 'R1'), ['enable', 'show ip route static']), /via 203\.0\.113\.1/);
  net.setPower(by(net, 'ISP1'), false);
  net.run(3000);
  assert.match(cli(by(net, 'R1'), ['enable', 'show ip route static']), /via 198\.51\.100\.1/);
  assert.ok(ping(net, pc, '8.8.8.8', { count: 2 }).replies.length >= 1, 'через ISP2');

  net = build('linux-iptables');
  assert.equal(ping(net, by(net, 'User'), '192.168.1.20', { count: 1 }).replies.length, 0, 'iptables DROP');
  assert.equal(ping(net, by(net, 'Admin-Linux'), '192.168.1.20', { count: 1 }).replies.length, 1, 'админу можно');
  assert.equal(get(net, by(net, 'User'), 'http://192.168.1.20/').ok, true, 'веб открыт');

  net = build('https-certs');
  const p = by(net, 'PC');
  let r = get(net, p, 'https://www.lab/');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tls.problem, null);
  r = get(net, p, 'https://old.lab/');
  assert.equal(r.ok, false);
  assert.equal(r.cert.code, 'self-signed');
});

test('пример автоматизации: программа Python на ПК читает RESTCONF и настраивает R1 по SSH', async () => {
  const net = build('python-automation');
  const pc = by(net, 'NetOps');
  const r1 = by(net, 'R1');
  const prog = NL.automation.program(pc);
  assert.equal(prog.lang, 'python');
  const logs = [];
  const io = {
    read: () => 0, write() {}, log: (t) => logs.push(t), error: (t) => logs.push('ERR ' + t),
    request: (kind, args) => new Promise((res, rej) => { NL.automation.handle(pc, kind, args, (e, x) => (e ? rej(e) : res(x))); net.runUntilIdle(); }),
  };
  await new Promise((done) => { io.done = done; NL.scriptRt.run(prog.code, io, 'python'); });
  const text = logs.join('\n');
  assert.doesNotMatch(text, /ERR/, text);
  assert.match(text, /^Интерфейсы: GigabitEthernet0\/0\/0/m);
  assert.match(text, /^Теперь: \d+ интерфейсов$/m);
  assert.ok(r1.ifaceByName('Loopback3'), 'Loopback3 создан по SSH');
});
