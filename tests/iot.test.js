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

test('Правила IoT: условия И / ИЛИ, расписание по часам сервера, противоречащие правила не зацикливаются', () => {
  const net = mkNet();
  const gw = net.addDevice('homegw', { name: 'Home' });
  const sw = net.addDevice('switch', { name: 'SW' });
  link(net, gw, sw, gw.portIndex('Ethernet 1'));
  const mk = (name, model) => { const d = net.addDevice('iot', { name, model }); link(net, d, sw); d.setDhcp(); d.setIotServer({ server: 'gateway' }); return d; };
  const lamp = mk('Lamp', 'Smart Lamp');
  const motion = mk('Motion', 'Motion Detector');
  const smoke = mk('Smoke', 'Smoke Detector');
  const siren = mk('Siren', 'Siren');
  const fan = mk('Fan', 'Smart Fan');
  net.runUntilIdle();
  for (const d of [lamp, motion, smoke, siren, fan]) assert.equal(d.iotRt.state, 'registered', d.name);
  const R = NL.iotRules;
  assert.throws(() => R.normRule({ name: 'x', conds: [{ type: 'time', from: '25:00', to: '01:00' }], actions: [{ thing: 'Lamp', prop: 'level', value: 1 }] }), /ЧЧ:ММ/);
  assert.equal(R.normRule({ name: 'old', cond: { thing: 'Motion', prop: 'detected', op: '=', value: true }, actions: [{ thing: 'Lamp', prop: 'level', value: 1 }] }).conds.length, 1, 'старый формат { cond } принимается');

  gw.iotd.rules = [
    // ИЛИ: дым или движение → сирена
    R.normRule({ name: 'Тревога', match: 'any', conds: [{ thing: 'Smoke', prop: 'level', op: '>=', value: 50 }, { thing: 'Motion', prop: 'detected', op: '=', value: true }], actions: [{ thing: 'Siren', prop: 'on', value: true }] }),
    // И + расписание: движение в 08:00–09:00 по будням → вентилятор
    R.normRule({ name: 'Утро', match: 'all', conds: [{ thing: 'Motion', prop: 'detected', op: '=', value: true }, { type: 'time', from: '08:00', to: '09:00', days: [1, 2, 3, 4, 5] }], actions: [{ thing: 'Fan', prop: 'speed', value: 2 }] }),
    // только расписание: 20:00–23:00 — свет вполсилы
    R.normRule({ name: 'Вечер', conds: [{ type: 'time', from: '20:00', to: '23:00' }], actions: [{ thing: 'Lamp', prop: 'level', value: 1 }] }),
  ];
  gw.iotd.evaluate();
  net.runUntilIdle();
  assert.equal(siren.thing.state.on, false);
  smoke.thingSet('level', 70);
  net.runUntilIdle();
  assert.equal(siren.thing.state.on, true, 'ИЛИ: хватило дыма');

  // 1 марта 1993 — понедельник; часы 00:00. Движение ночью вентилятор не включает (И с расписанием)
  assert.match(gw.iotd.clock(), /^00:0\d, пн$/);
  motion.thingSet('detected', true);
  net.runUntilIdle();
  assert.equal(fan.thing.state.speed, 0);
  gw.iotd.setClock('08:30');
  net.runUntilIdle();
  assert.equal(fan.thing.state.speed, 2, 'И: движение и утро буднего дня');

  // расписание срабатывает само, по таймеру: 19:59 → через минуту свет
  gw.iotd.setClock('19:59');
  net.run(3000);
  assert.equal(lamp.thing.state.level, 0);
  net.run(3100);
  assert.equal(lamp.thing.state.level, 1, 'в 20:00 правило «Вечер» включило свет');
  assert.match(gw.iotd.clock(), /^20:00/);

  // противоречащие правила: побеждает последнее, без бесконечного переключения
  gw.iotd.rules.push(R.normRule({ name: 'Ярко', conds: [{ thing: 'Motion', prop: 'detected', op: '=', value: true }], actions: [{ thing: 'Lamp', prop: 'level', value: 2 }] }));
  let sets = 0;
  const off = net.on((t, e) => { if (t === 'log' && e.type === 'tx' && e.frame.payload && e.frame.payload.payload && e.frame.payload.payload.data && e.frame.payload.payload.data.iot === 'SET') sets++; });
  gw.iotd.evaluate();
  net.runUntilIdle(20000);
  off();
  assert.equal(lamp.thing.state.level, 2);
  assert.ok(sets <= 2, 'команд SET: ' + sets);

  // сохранение: правила в новом формате и часы сервера
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  const g2 = n2.findByName('Home');
  assert.equal(g2.iotd.rules[1].match, 'all');
  assert.deepEqual(g2.iotd.rules[1].conds[1], { type: 'time', from: '08:00', to: '09:00', days: [1, 2, 3, 4, 5] });
  assert.match(R.ruleText(g2.iotd.rules[0]), /Smoke\.level >= 50 ИЛИ Motion\.detected = true/);
  assert.match(g2.iotd.clock(), /^20:0\d/);
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
  // ждём по условию, а не фиксированное время: под нагрузкой (параллельные тесты) цикл идёт медленнее
  for (let i = 0; i < 150 && !logs.includes('pot 512'); i++) await new Promise((r) => setTimeout(r, 20));
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

test('Программирование на Python и в блоках: перевод в JavaScript и выполнение', async () => {
  const RT = NL.scriptRt;
  const py = 'from gpio import *\nfrom time import *\n\nhits = []\n\ndef blink(pin, times=2):\n    for i in range(times):\n        digitalWrite(pin, HIGH)\n        sleep(0.001)\n        digitalWrite(pin, LOW)\n    return times\n\ndef main():\n    pinMode(0, OUT)\n    n = blink(0, 3)\n    a, b = 1, 2\n    a, b = b, a\n    hits.append(n)\n    if n == 3 and "x" not in ["y"]:\n        print(f"n={n}", a, b, 7 // 2, len(hits), None is None)\n    elif n > 3:\n        print("много")\n    else:\n        pass\n\nif __name__ == "__main__":\n    main()\n';
  const js = RT.py2js(py);
  assert.match(js, /function blink\(pin, times=2\) \{/);
  assert.match(js, /for \(i of __iter\(__range\(times\)\)\)/);
  const logs = [];
  const writes = [];
  await new Promise((resolve) => RT.run(py, { read: () => 0, write: (p, v) => writes.push([p, v]), log: (t) => logs.push(t), error: (t) => logs.push('ERR ' + t), done: resolve }, 'python'));
  assert.deepEqual(logs, ['n=3 2 1 3 1 true']);
  assert.equal(writes.filter(([p, v]) => p === 'D0' && v === 1023).length, 3);
  let err = '';
  await new Promise((resolve) => RT.run('class A:\n    pass\n', { read: () => 0, write() {}, log() {}, error: (t) => { err = t; }, done: resolve }, 'python'));
  assert.match(err, /классы Python здесь не поддерживаются/);
  // блоки
  const code = RT.blocksToJs({
    setup: [{ t: 'pinMode', pin: 'D0', mode: 'OUTPUT' }],
    loop: [{ t: 'if', src: 'analog', pin: 'A0', op: '>', value: 500, then: [{ t: 'digitalWrite', pin: 'D0', value: 'HIGH' }], else: [{ t: 'digitalWrite', pin: 'D0', value: 'LOW' }] },
      { t: 'repeat', n: 2, body: [{ t: 'toggle', pin: 'D1' }] }, { t: 'set', name: 'n', src: 'add', value: 1 }, { t: 'delay', ms: 10 }],
  });
  assert.match(code, /if \(analogRead\("A0"\) > 500\) \{\n    digitalWrite\("D0", HIGH\);\n  \} else \{/);
  assert.match(code, /let v_n = 0;/);
  const w2 = [];
  const hnd = RT.run(code, { read: (p) => (p === 'A0' ? 800 : 0), write: (p, v) => w2.push(p + '=' + v), log() {}, error: (t) => w2.push('ERR ' + t) });
  for (let i = 0; i < 100 && !w2.includes('D0=1023'); i++) await new Promise((r) => setTimeout(r, 10));
  hnd.stop();
  assert.ok(w2.includes('D0=1023') && w2.includes('D1=1023'), w2.join(','));
  // сохранение языка и блоков платы
  const net = NL.Network.deserialize({ format: 'netlab', version: 2, devices: [], links: [] });
  const mcu = net.addDevice('mcu', { name: 'M' });
  mcu.program = { code: '', lang: 'blocks', blocks: { setup: [], loop: [{ t: 'delay', ms: 5 }] } };
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(n2.findByName('M').program.lang, 'blocks');
  assert.equal(n2.findByName('M').program.blocks.loop[0].ms, 5);
});
