// Примеры из меню «Примеры» собираются без ошибок, и в них действительно всё работает.
const test = require('node:test');
const path = require('path');
const { NL, assert, ping, cli, run } = require('./helpers');

NL.ui = NL.ui || {};
require(path.join(__dirname, '..', 'js', 'ui', 'examples.js'));

const EX = NL.ui.EXAMPLES;

function build(id) {
  const ex = EX.find((e) => e.id === id);
  assert.ok(ex, 'нет примера ' + id);
  const net = ex.build();
  net.runUntilIdle(200000);
  return net;
}
const byName = (net, n) => {
  const d = net.findByName(n);
  assert.ok(d, 'нет устройства ' + n);
  return d;
};
const okPing = (net, from, to, msg) => {
  const r = ping(net, byName(net, from), to, { count: 2 });
  assert.equal(r.replies.length, 2, (msg || from + ' → ' + to) + ': ' + JSON.stringify(r.events.slice(0, 3)));
};

test('все примеры собираются, IOS-конфигурация сохранена в NVRAM', () => {
  assert.ok(EX.length >= 14);
  for (const ex of EX) {
    const net = ex.build();
    net.runUntilIdle(200000);
    for (const d of net.devices.values()) {
      // sticky-адреса port-security попадают в running-config сами — как в настоящем IOS
      if (d.nvramDirty && ex.id !== 'portsec') assert.equal(d.nvramDirty(), false, ex.id + ': ' + d.name + ' — конфигурация не сохранена');
    }
    // сохранение и загрузка файла не теряют ничего
    const again = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
    assert.equal(again.devices.size, net.devices.size, ex.id);
    assert.equal(again.links.size, net.links.size, ex.id);
  }
});

test('пример routing и VLAN: связь между сетями', () => {
  let net = build('routing');
  okPing(net, 'PC0', '192.168.2.11');
  net = build('vlan');
  okPing(net, 'PC0', '192.168.20.11');
  okPing(net, 'PC1', '192.168.10.10');
  net = build('l3switch');
  okPing(net, 'PC0', '10.20.20.11');
});

test('пример DHCP/DNS/веб: адреса выданы, страница открывается по имени', () => {
  const net = build('dhcp-dns');
  const pc = byName(net, 'PC0');
  assert.ok(pc.iface.ip != null, 'PC0 получил адрес');
  const r = run(net, (cb) => pc.httpGet('http://www.lab', cb));
  assert.ok(r.ok && /www\.lab/.test(r.body), JSON.stringify(r));
});

test('пример Wi-Fi: клиенты подключены, NAT на WRT300N, веб-сайт провайдера открывается', () => {
  const net = build('wifi');
  for (const n of ['Laptop0', 'Tablet0', 'PC0']) {
    const d = byName(net, n);
    assert.ok(d.iface.ip != null && (d.iface.ip >>> 8) === (NL.util.parseIp('192.168.0.0') >>> 8), n + ' получил 192.168.0.x');
  }
  assert.equal(net.wirelessStatus(byName(net, 'Laptop0')).ap.name, 'Home');
  const r = run(net, (cb) => byName(net, 'Laptop0').httpGet('http://www.example.com', cb));
  assert.ok(r.ok && /интернет/.test(r.body), JSON.stringify(r));
});

test('пример NAT: офис выходит наружу, у провайдера нет маршрута внутрь', () => {
  const net = build('nat');
  okPing(net, 'PC0', '198.51.100.10');
  const r = run(net, (cb) => byName(net, 'PC1').httpGet('http://198.51.100.10', cb));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(cli(byName(net, 'Office'), ['enable', 'show ip nat translations']).text, /203\.0\.113\.2/);
});

test('пример ACL: гостям нет веба, но ping проходит; сотрудникам можно всё', () => {
  const net = build('acl');
  const staff = run(net, (cb) => byName(net, 'Staff0').httpGet('http://192.168.30.10', cb));
  assert.ok(staff.ok, JSON.stringify(staff));
  const guest = run(net, (cb) => byName(net, 'Guest0').httpGet('http://192.168.30.10', cb));
  assert.equal(guest.ok, false);
  okPing(net, 'Guest0', '192.168.30.10');
});

test('пример OSPF: все сети видны, при обрыве канала путь идёт в обход', () => {
  const net = build('ospf');
  okPing(net, 'PC2', '192.168.3.10');
  okPing(net, 'PC1', '192.168.2.10');
  const r2 = byName(net, 'R2');
  const r3 = byName(net, 'R3');
  const l = [...net.links.values()].find((x) => (x.a.dev === r2.id && x.b.dev === r3.id) || (x.a.dev === r3.id && x.b.dev === r2.id));
  net.disconnect(l.id);
  net.runUntilIdle(200000);
  okPing(net, 'PC2', '192.168.3.10', 'после обрыва R2—R3');
});

test('пример Serial: канал PPP с clock rate работает, RIP передаёт маршруты', () => {
  const net = build('serial');
  okPing(net, 'PC-Moscow', '192.168.2.10');
  assert.match(cli(byName(net, 'Moscow'), ['enable', 'show ip route']).text, /^R\s+192\.168\.2\.0/m);
});

test('пример SSH: вход по SSH на маршрутизатор и Telnet на коммутатор', () => {
  const net = build('ssh');
  const admin = byName(net, 'Admin');
  const s = cli(admin, ['ssh -l admin 192.168.1.1', 'cisco', 'enable', 'class', 'show running-config']);
  assert.match(s.text, /hostname R1/);
  const t = cli(admin, ['telnet 192.168.1.2', 'cisco', 'enable', 'class', 'show ip interface brief']);
  assert.match(t.text, /Vlan1\s+192\.168\.1\.2/);
  assert.equal(net.consolePeer(admin).name, 'R1');
});

test('пример почты: письмо нескольким адресатам в двух доменах, отчёт по каждому', () => {
  const net = build('email');
  const ivan = byName(net, 'Ivan');
  const r = run(net, (cb) => ivan.emailSend(['maria@office.lab', 'petr@office.lab', 'olga@partner.lab', 'nobody@office.lab'], 'План', 'Встреча в 10:00', cb));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, false]);
  const got = run(net, (cb) => byName(net, 'Olga').emailReceive(cb));
  assert.equal(got.count, 1);
  assert.equal(byName(net, 'Olga').emailBox[0].subject, 'План');
});

test('пример «Сообщения»: доставка всем, включая другую сеть', () => {
  const net = build('mail');
  const d = byName(net, 'Director');
  const msg = d.sendMail(['buh.office', 'kadry.office', 'logist.sklad', '192.168.2.10'], 'Привет', 'Текст');
  net.runUntilIdle(200000);
  assert.deepEqual(msg.items.map((it) => it.status), ['ok', 'ok', 'ok', 'ok']);
});
