// Физическое пространство: город → здание → шкаф, длина кабелей и дальность Wi-Fi по физическим координатам.
const test = require('node:test');
const { NL, assert, mkNet, pc, link, ping } = require('./helpers');

const U = NL.util;
const PL = NL.places;

test('Физическое пространство: места по умолчанию, иерархия, добавление/удаление, координаты устройств', () => {
  const net = mkNet();
  const a = pc(net, 'A', '10.0.0.1/24');
  assert.equal(PL.on(net), false);
  assert.deepEqual(PL.path(net, 'k1').map((p) => p.name), ['Междугородняя карта', 'Город', 'Офис', 'Основной шкаф']);
  assert.equal(PL.devPos(net, a).place, 'k1', 'новое устройство — в основном шкафу');
  assert.equal(PL.devPos(net, a).auto, true);
  const city2 = PL.add(net, 'root', 'Филиал-город');
  assert.equal(city2.kind, 'city');
  const bld = PL.add(net, city2.id, 'Склад');
  assert.equal(bld.kind, 'building');
  const cl = PL.add(net, bld.id);
  assert.equal(cl.kind, 'closet');
  assert.match(cl.name, /^Шкаф 1$/);
  assert.throws(() => PL.add(net, cl.id), /только устройства/);
  PL.setDevice(net, a.id, cl.id, 2, 1);
  assert.deepEqual(PL.devPos(net, a), { place: cl.id, x: 2, y: 1, auto: false });
  assert.throws(() => PL.remove(net, bld.id), /другие места/);
  assert.throws(() => PL.remove(net, cl.id), /стоят устройства \(A\)/);
  assert.deepEqual(PL.visibleAt(net, a, 'root'), { place: city2 });
  assert.deepEqual(PL.visibleAt(net, a, bld.id), { place: cl });
  assert.deepEqual(PL.visibleAt(net, a, cl.id), { dev: a });
  assert.equal(PL.visibleAt(net, a, 'b1'), null);
  PL.setDevice(net, a.id, 'k1', 1, 1);
  PL.remove(net, cl.id);
  PL.rename(net, bld.id, 'Склад №2');
  assert.equal(PL.get(net, bld.id).name, 'Склад №2');
  // координаты ограничены размером места
  PL.setDevice(net, a.id, 'k1', 500, -3);
  assert.deepEqual([PL.devPos(net, a).x, PL.devPos(net, a).y], [PL.KINDS.closet.w, 0]);
});

test('Физическое пространство: кабель между зданиями длиннее 100 м — медь не работает, оптика работает; сохранение', () => {
  const net = mkNet();
  const sw1 = net.addDevice('switch', { name: 'SW1', model: '3650-24PS' });
  const sw2 = net.addDevice('switch', { name: 'SW2', model: '3650-24PS' });
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  link(net, a, sw1, 0, 0);
  link(net, b, sw2, 0, 0);
  const cu = link(net, sw1, sw2, 1, 1);
  net.runUntilIdle();
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).replies.length, 1);
  const b2 = PL.add(net, 'c1', 'Склад', 3250, 2000); // в 250 м от офиса
  const k2 = PL.add(net, b2.id, 'Шкаф склада');
  PL.setDevice(net, sw2.id, k2.id, 1, 1);
  PL.setDevice(net, b.id, b2.id, 30, 20);
  assert.equal(net.linkIssue(cu), null, 'пока пространство выключено, расстояния не учитываются');
  PL.setOn(net, true);
  const len = NL.physical.linkLength(net, cu);
  assert.ok(len > 240 && len < 260, 'длина ' + len);
  assert.match(net.linkIssue(cu), /Кабель слишком длинный: \d+ м — предел для медного кабеля 100 м/);
  const lb = [...net.links.values()].find((l) => l.a.dev === b.id || l.b.dev === b.id);
  assert.equal(net.linkIssue(lb), null, 'B в здании склада, коммутатор в шкафу склада — рядом');
  assert.equal(ping(net, a, '10.0.0.2', { count: 1 }).replies.length, 0);
  // оптика между зданиями
  net.disconnect(cu.id);
  PL.setDevice(net, b.id, k2.id, 3, 2);
  const fp1 = sw1.ports.findIndex((p) => p.media === 'fiber');
  const fp2 = sw2.ports.findIndex((p) => p.media === 'fiber');
  assert.ok(fp1 >= 0 && fp2 >= 0, 'оптические порты');
  const fl = link(net, sw1, sw2, fp1, fp2, 'fiber');
  assert.equal(net.linkIssue(fl), null);
  net.runUntilIdle(200000);
  assert.equal(ping(net, a, '10.0.0.2', { count: 2 }).replies.length, 2);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(PL.on(n2), true);
  assert.equal(PL.devPos(n2, n2.findByName('SW2')).place, k2.id);
  assert.equal(PL.get(n2, b2.id).name, 'Склад');
  assert.equal(Math.round(NL.physical.linkLength(n2, n2.links.get(fl.id))), Math.round(NL.physical.linkLength(net, fl)));
});

test('Физическое пространство: Wi-Fi 100 м по физическим координатам', () => {
  const net = mkNet();
  const sw = net.addDevice('switch');
  const srv = pc(net, 'Wired', '192.168.1.10/24');
  link(net, srv, sw);
  const ap = net.addDevice('ap', { x: 0, y: 0 });
  link(net, ap, sw);
  ap.setWifi({ ssid: 'Office', security: 'wpa2', key: 'secret123' });
  const lap = net.addDevice('laptop', { x: 5000, y: 50 }); // на схеме далеко
  net.setPower(lap, false);
  net.setModule(lap, 'nic', 'WPC300N');
  net.setPower(lap, true);
  lap.setStatic(U.parseIp('192.168.1.20'), U.maskFromPrefix(24), null, null);
  lap.setWifi({ ssid: 'Office', security: 'wpa2', key: 'secret123' });
  assert.match(net.wirelessStatus(lap).reason, /далеко/);
  PL.setOn(net, true);
  PL.setDevice(net, ap.id, 'b1', 50, 30);
  PL.setDevice(net, lap.id, 'b1', 80, 40);
  assert.equal(net.wirelessStatus(lap).ap, ap, 'в одном здании в 32 м — связь есть');
  assert.equal(ping(net, lap, '192.168.1.10', { count: 1 }).done.received, 1);
  const far = PL.add(net, 'c1', 'Дом', 3000 + 400, 2000);
  PL.setDevice(net, lap.id, far.id, 10, 10);
  assert.match(net.wirelessStatus(lap).reason, /далеко/);
});
