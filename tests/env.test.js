// Среда IoT: день и ночь, температура, свет, CO2, пожар; датчики сами сообщают значения; правила по датчикам.
const test = require('node:test');
const { NL, assert, mkNet, link, run } = require('./helpers');

function home() {
  const net = mkNet();
  const gw = net.addDevice('homegw', { name: 'Home' });
  const sw = net.addDevice('switch', { name: 'SW' });
  link(net, gw, sw, gw.portIndex('Ethernet 1'));
  const mk = (name, model) => { const d = net.addDevice('iot', { name, model }); link(net, d, sw); d.setDhcp(); d.setIotServer({ server: 'gateway' }); return d; };
  const t = { temp: mk('Temp', 'Temperature Monitor'), light: mk('Light', 'Light Sensor'), co2: mk('CO2', 'CO2 Detector'), smoke: mk('Smoke', 'Smoke Detector'),
    heater: mk('Heater', 'Heater'), window: mk('Window', 'Smart Window'), lamp: mk('Lamp', 'Smart Lamp'), blinds: mk('Blinds', 'Smart Blinds') };
  const admin = net.addDevice('pc', { name: 'Admin' });
  link(net, admin, sw);
  admin.setDhcp();
  net.runUntilIdle();
  return { net, gw, admin, t };
}

test('Среда: датчики следуют за средой и устройствами, день/ночь, пожар, сохранение', () => {
  const { net, t } = home();
  for (const d of Object.values(t)) assert.equal(d.iotRt.state, 'registered', d.name);
  NL.env.set(net, { on: true, run: false, clock: 13 * 60, outTemp: 5 });
  net.run(3000);
  assert.ok(t.light.thing.state.value >= 90, 'днём светло: ' + t.light.thing.state.value);
  const cold = t.temp.thing.state.value;
  assert.ok(cold < 20, 'на улице +5, в помещении прохладнее обычного: ' + cold);
  // обогреватель
  t.heater.thingSet('on', true);
  net.run(4000);
  assert.ok(t.temp.thing.state.value > cold + 4, 'обогреватель нагрел: ' + t.temp.thing.state.value);
  // ночь: свет только от лампы; жалюзи днём
  NL.env.set(net, { clock: 23 * 60 });
  net.run(200);
  assert.equal(t.light.thing.state.value, 0);
  t.lamp.thingSet('level', 2);
  net.run(200);
  assert.equal(t.light.thing.state.value, 50);
  NL.env.set(net, { clock: 12 * 60 });
  t.lamp.thingSet('level', 0);
  t.blinds.thingSet('open', false);
  net.run(200);
  assert.ok(t.light.thing.state.value <= 20, 'жалюзи закрыты: ' + t.light.thing.state.value);
  // люди и CO2, проветривание
  NL.env.set(net, { people: true });
  net.run(3000);
  const stuffy = t.co2.thing.state.value;
  assert.ok(stuffy > 700, 'люди надышали: ' + stuffy);
  t.window.thingSet('open', true);
  net.run(3000);
  assert.ok(t.co2.thing.state.value < stuffy - 150, 'проветрили: ' + t.co2.thing.state.value);
  // пожар → дым
  NL.env.set(net, { fire: true });
  net.run(1500);
  assert.ok(t.smoke.thing.state.level >= 90);
  // время идёт
  NL.env.set(net, { fire: false, run: true, speed: 10, clock: 5 * 60 + 50 });
  net.run(200);
  assert.equal(NL.env.clockText(NL.env.get(net).clock), '06:10');
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(n2.env.on, true);
  assert.equal(n2.env.speed, 10);
  assert.equal(n2.findByName('Blinds').thing.state.open, false);
  NL.env.set(net, { on: false });
});

test('Среда: правило IoT-сервера по датчику температуры включает обогреватель', () => {
  const { net, admin, t } = home();
  const rules = [{ name: 'Холодно', cond: { thing: 'Temp', prop: 'value', op: '<', value: 18 }, actions: [{ thing: 'Heater', prop: 'on', value: true }] },
    { name: 'Тепло', cond: { thing: 'Temp', prop: 'value', op: '>', value: 23 }, actions: [{ thing: 'Heater', prop: 'on', value: false }] }];
  assert.ok(run(net, (cb) => admin.iotSaveRules('192.168.25.1', 'admin', 'admin', rules, cb)).ok);
  NL.env.set(net, { on: true, run: false, clock: 3 * 60, outTemp: -10 });
  net.run(4000);
  assert.equal(t.heater.thing.state.on, true, 'стало холодно — правило включило обогреватель (t=' + t.temp.thing.state.value + ')');
  net.run(8000);
  assert.ok(t.temp.thing.state.value >= 17, 'температура держится около уставки: ' + t.temp.thing.state.value);
  NL.env.set(net, { on: false });
});
