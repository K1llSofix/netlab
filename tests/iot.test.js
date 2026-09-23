// IoT: умные устройства, Home Gateway, IoT-сервер, правила, IoT Monitor; платы MCU/SBC и программы.
const test = require('node:test');
const { NL, assert, mkNet, pc, link, run } = require('./helpers');

const U = NL.util;

test('Home Gateway: устройства регистрируются, IoT Monitor управляет, правило «движение → свет и сирена»', () => {
  const net = mkNet();
  net.recording = true;
  const gw = net.addDevice('homegw', { name: 'Home' });
  const lamp = net.addDevice('iot', { name: 'Lamp', model: 'Smart Lamp' });
  const motion = net.addDevice('iot', { name: 'Motion', model: 'Motion Detector' });
  const siren = net.addDevice('iot', { name: 'Siren', model: 'Siren' });
  const door = net.addDevice('iot', { name: 'Door', model: 'Smart Door' });
  const laptop = net.addDevice('pc', { name: 'Admin' });
  const sw = net.addDevice('switch', { name: 'SW' });
  link(net, gw, sw, gw.portIndex('Ethernet 1'));
  for (const d of [lamp, motion, siren, door]) link(net, d, sw);
  for (const d of [lamp, motion, siren, door]) { d.setDhcp(); d.setIotServer({ server: 'gateway' }); }
  net.runUntilIdle();
  assert.equal(U.ipStr(gw.lanIface.ip), '192.168.25.1');
  for (const d of [lamp, motion, siren, door]) assert.equal(d.iotRt.state, 'registered', d.name + ': ' + d.iotRt.text);
  assert.equal(gw.iotd.things.size, 4);

  // IoT Monitor на ноутбуке (подключён по кабелю к шлюзу)
  link(net, laptop, sw);
  laptop.setDhcp();
  net.runUntilIdle();
  const srv = '192.168.25.1';
  const denied = run(net, (cb) => laptop.iotList(srv, 'admin', 'wrong', cb));
  assert.equal(denied.ok, false);
  const list = run(net, (cb) => laptop.iotList(srv, 'admin', 'admin', cb));
  assert.ok(list.ok, JSON.stringify(list));
  assert.deepEqual(list.data.things.map((t) => t.name).sort(), ['Door', 'Lamp', 'Motion', 'Siren']);

  // управление
  assert.ok(run(net, (cb) => laptop.iotControl(srv, 'admin', 'admin', 'Lamp', 'level', 2, cb)).ok);
  assert.equal(lamp.thing.state.level, 2);
  const bad = run(net, (cb) => laptop.iotControl(srv, 'admin', 'admin', 'Motion', 'detected', true, cb));
  assert.match(bad.error, /нельзя управлять/);
  // заперта дверь не открывается
  run(net, (cb) => laptop.iotControl(srv, 'admin', 'admin', 'Door', 'locked', true, cb));
  run(net, (cb) => laptop.iotControl(srv, 'admin', 'admin', 'Door', 'open', true, cb));
  assert.equal(door.thing.state.locked, true);
  assert.equal(door.thing.state.open, false);

  // правило: движение → сирена и свет
  const rules = [{ name: 'Тревога', cond: { thing: 'Motion', prop: 'detected', op: '=', value: true }, actions: [{ thing: 'Siren', prop: 'on', value: true }, { thing: 'Lamp', prop: 'level', value: 2 }] }];
  assert.ok(run(net, (cb) => laptop.iotSaveRules(srv, 'admin', 'admin', rules, cb)).ok);
  lamp.thingSet('level', 0);
  net.runUntilIdle();
  assert.equal(siren.thing.state.on, false);
  motion.thingSet('detected', true);
  net.runUntilIdle();
  assert.equal(siren.thing.state.on, true, 'правило включило сирену');
  assert.equal(lamp.thing.state.level, 2);

  // сохранение: правила и настройки устройств
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(n2.findByName('Home').iotd.rules.length, 1);
  assert.equal(n2.findByName('Lamp').iotRt.state, 'registered');
  assert.equal(n2.findByName('Siren').thing.state.on, true);
});

test('IoT-сервер на Server-PT: удалённая регистрация, неверный пароль, выключенная служба', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const srv = net.addDevice('server', { name: 'IoT' });
  srv.setStatic(U.parseIp('10.0.0.5'), U.maskFromPrefix(24), null, null);
  const fan = net.addDevice('iot', { name: 'Fan', model: 'Smart Fan' });
  fan.setStatic(U.parseIp('10.0.0.20'), U.maskFromPrefix(24), null, null);
  link(net, srv, sw);
  link(net, fan, sw);
  fan.setIotServer({ server: 'remote', address: U.parseIp('10.0.0.5'), user: 'bob', pass: 'x' });
  net.runUntilIdle(2500);
  assert.equal(fan.iotRt.state, 'failed');
  assert.match(fan.iotRt.text, /закрыт|отклон/);
  srv.iotd.setEnabled(true);
  net.runUntilIdle(2500);
  assert.match(fan.iotRt.text, /логин|пароль/);
  srv.iotd.addUser('bob', 'x');
  net.runUntilIdle(2500);
  assert.equal(fan.iotRt.state, 'registered', fan.iotRt.text);
  // выключили службу — устройство теряет связь
  srv.iotd.setEnabled(false);
  net.runUntilIdle(500);
  assert.notEqual(fan.iotRt.state, 'registered');
});

test('MCU-PT: пины, компоненты на IoT-кабеле, программа мигает светодиодом и читает кнопку', async () => {
  const net = mkNet();
  const mcu = net.addDevice('mcu', { name: 'MCU' });
  const led = net.addDevice('iotcomp', { name: 'LED', model: 'LED' });
  const btn = net.addDevice('iotcomp', { name: 'Button', model: 'Push Button' });
  const pot = net.addDevice('iotcomp', { name: 'Pot', model: 'Potentiometer' });
  assert.equal(net.connect(mcu.id, mcu.portIndex('D0'), led.id, 0).cable, 'iot');
  link(net, mcu, btn, mcu.portIndex('D1'), 0);
  link(net, mcu, pot, mcu.portIndex('A0'), 0);
  const I = NL.iot;
  assert.equal(I.read(mcu, 'D1', 'digital'), 0);
  I.setComp(btn, 1);
  assert.equal(I.read(mcu, 'D1', 'digital'), 1);
  assert.equal(I.read(mcu, 'A0', 'analog'), 512);
  I.write(mcu, 'D0', 1023);
  assert.equal(led.value, 1);
  I.write(mcu, 'D0', 0);
  assert.equal(led.value, 0);

  // программа: переписывание delay/функций в асинхронные
  const RT = NL.scriptRt;
  assert.match(RT.transform('function loop(){ blink(); delay(5); }\nfunction blink(){}'), /async function loop\(\)\{ await blink\(\); await delay\(5\); \}/);

  const logs = [];
  const writes = [];
  const io = {
    read: (pin, mode) => I.read(mcu, pin, mode),
    write: (pin, v) => { writes.push([pin, v]); I.write(mcu, pin, v); },
    log: (t) => logs.push(t),
    error: (t) => logs.push('ERR ' + t),
  };
  const code = 'let n = 0;\nfunction setup() { pinMode(0, OUTPUT); Serial.println("start"); }\n' +
    'function loop() { if (digitalRead(1) === HIGH) { digitalWrite(0, HIGH); } delay(10); digitalWrite(0, LOW); n++; if (n === 3) print("pot", analogRead(A0)); delay(10); }';
  const h = RT.run(code, io);
  await new Promise((r) => setTimeout(r, 150));
  h.stop();
  assert.equal(logs[0], 'start');
  assert.ok(logs.includes('pot 512'), logs.join('|'));
  assert.ok(writes.some(([p, v]) => p === 'D0' && v === 1023) && writes.some(([p, v]) => p === 'D0' && v === 0));
  const n = writes.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(writes.length, n, 'после «Стоп» программа не пишет в пины');

  // ошибки показываются, а не роняют приложение
  const errs = [];
  RT.run('function loop( {', { read: () => 0, write() {}, log() {}, error: (t) => errs.push(t) });
  assert.match(errs[0], /Синтаксическая ошибка/);
  RT.run('function setup(){ undefinedFn(); }', { read: () => 0, write() {}, log() {}, error: (t) => errs.push(t) });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(errs[1], /undefinedFn/);

  // сохранение программы
  mcu.program.code = 'function loop(){}';
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(n2.findByName('MCU').program.code, 'function loop(){}');
  assert.equal(n2.findByName('Pot').value, 512);
});

test('SBC-PT: сетевой интерфейс — сетевая карта, а не пины', () => {
  const net = mkNet();
  const sbc = net.addDevice('sbc', { name: 'SBC' });
  assert.equal(sbc.iface.name, 'FastEthernet0');
  const other = pc(net, 'PC', '10.0.0.2/24');
  sbc.setStatic(U.parseIp('10.0.0.1'), U.maskFromPrefix(24), null, null);
  link(net, sbc, other);
  net.runUntilIdle();
  const r = [];
  other.ping('10.0.0.1', { count: 1, onEvent: (e) => r.push(e.type) });
  net.runUntilIdle();
  assert.ok(r.includes('reply'));
});
