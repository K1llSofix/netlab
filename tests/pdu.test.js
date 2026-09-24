// Сложный PDU (ICMP / TCP / UDP, TTL, повторы) и сценарии, сохраняемые в файле.
const test = require('node:test');
const { NL, U, assert, mkNet, host, pc, routerIf, link, ping } = require('./helpers');

function lab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const a = pc(net, 'A', '192.168.1.10/24', '192.168.1.1');
  const srv = host(net, 'server', 'Web', '10.0.0.10/24', '10.0.0.1');
  link(net, a, r, 0, 0); link(net, srv, r, 0, 1);
  routerIf(r, 0, '192.168.1.1/24'); routerIf(r, 1, '10.0.0.1/24');
  net.runUntilIdle();
  return { net, r, a, srv };
}
const fire = (net, spec) => { let res; NL.pdu.fire(net, spec, (x) => { res = x; }); net.runUntilIdle(200000); return res; };

test('Complex PDU: ICMP с повторами и TTL, TCP к открытому и закрытому порту, UDP и ICMP port unreachable', () => {
  const { net, a } = lab();
  let r = fire(net, { src: a.id, dst: '10.0.0.10', proto: 'icmp', count: 3 });
  assert.equal(r.status, 'ok');
  assert.match(r.text, /\(3 из 3\)/);
  r = fire(net, { src: a.id, dst: '10.0.0.10', proto: 'icmp', ttl: 1 });
  assert.equal(r.status, 'fail');
  assert.match(r.text, /TTL истёк на 192\.168\.1\.1/);
  r = fire(net, { src: a.id, dst: '10.0.0.10', proto: 'tcp', dport: 80 });
  assert.equal(r.status, 'ok', r.text);
  assert.match(r.text, /TCP-соединение с 10\.0\.0\.10:80 установлено/);
  r = fire(net, { src: a.id, dst: '10.0.0.10', proto: 'tcp', dport: 8081 });
  assert.equal(r.status, 'fail');
  assert.match(r.text, /Порт 8081 закрыт/);
  r = fire(net, { src: a.id, dst: '10.0.0.10', proto: 'udp', dport: 5555 });
  assert.equal(r.status, 'fail');
  assert.match(r.text, /порт 5555 недоступен/);
  r = fire(net, { src: a.id, dst: '10.0.0.10', proto: 'udp', dport: 53, size: 100 });
  assert.equal(r.status, 'fail', 'DNS на сервере выключен — порт закрыт');
  r = fire(net, { src: a.id, dst: '172.31.0.1', proto: 'icmp' });
  assert.equal(r.status, 'fail');
});

test('Сценарии PDU: запуск набора и сохранение в файле', () => {
  const { net, a } = lab();
  const sc = NL.pdu.scenarios(net);
  sc.list[0].pdus.push(NL.pdu.cleanSpec({ src: a.id, dst: '10.0.0.10', proto: 'icmp' }), NL.pdu.cleanSpec({ src: a.id, dst: '10.0.0.10', proto: 'tcp', dport: 25 }));
  sc.list.push({ name: 'Проверка веба', desc: 'HTTP снаружи', pdus: [NL.pdu.cleanSpec({ src: a.id, dst: '10.0.0.10', proto: 'tcp', dport: 80 })] });
  const results = [];
  assert.equal(NL.pdu.fireScenario(net, 0, (i, spec, r) => results.push([i, r.status])), 2);
  net.runUntilIdle(200000);
  assert.deepEqual(results.sort(), [[0, 'ok'], [1, 'ok']].sort(), 'SMTP на Server-PT включён по умолчанию');
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.deepEqual(n2.scenarios.list.map((x) => x.name), ['Сценарий 0', 'Проверка веба']);
  assert.equal(n2.scenarios.list[1].pdus[0].dport, 80);
  assert.equal(NL.pdu.describe(n2.scenarios.list[1].pdus[0]), 'TCP :80');
  // пустые сценарии в файл не пишутся
  assert.equal(lab().net.serialize().scenarios, undefined);
});

test('Физические расстояния: длина медного кабеля больше 100 м — канал не работает; дальность Wi-Fi в метрах', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW', x: 0, y: 0 });
  const a = pc(net, 'A', '10.0.0.1/24', null);
  const b = pc(net, 'B', '10.0.0.2/24', null);
  a.x = 200; b.x = 0; b.y = 600;
  const la = link(net, a, sw, 0, 0);
  const lb = link(net, b, sw, 0, 1);
  net.runUntilIdle();
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).replies.length, 1, 'без учёта расстояний всё работает');
  NL.physical.setPhysical(net, { enabled: true, scale: 0.25 });
  assert.equal(Math.round(NL.physical.linkLength(net, lb)), 150);
  assert.match(net.linkIssue(lb), /Кабель слишком длинный: 150 м — предел для медного кабеля 100 м/);
  assert.equal(net.linkIssue(la), null);
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).replies.length, 0);
  NL.physical.setPhysical(net, { scale: 0.1 });
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).replies.length, 1, 'при другом масштабе кабель в пределах нормы');
  assert.equal(net.wifiRange(), 1000, 'Wi-Fi 100 м при 0,1 м на единицу');
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.deepEqual([n2.physical.enabled, n2.physical.scale], [true, 0.1]);
  assert.throws(() => NL.physical.setPhysical(net, { scale: 0 }));
});
