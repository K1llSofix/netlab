// Bluetooth: поиск, сопряжение по PIN, музыка на колонке, передача файлов, радиус действия.
const test = require('node:test');
const { NL, assert, mkNet } = require('./helpers');

const BT = NL.bt;

test('Bluetooth: поиск в радиусе, PIN, A2DP, OBEX, потеря связи при удалении', () => {
  const net = mkNet();
  const phone = net.addDevice('smartphone', { name: 'Phone', x: 100, y: 100 });
  const laptop = net.addDevice('laptop', { name: 'Laptop', x: 250, y: 100 });
  const spk = net.addDevice('btspeaker', { name: 'Speaker', x: 150, y: 200 });
  const far = net.addDevice('btheadset', { name: 'Headset', x: 900, y: 900 });
  const pc = net.addDevice('pc', { name: 'PC', x: 120, y: 120 });

  const found = BT.scan(phone).map((x) => x.dev.name);
  assert.deepEqual(found.sort(), ['Laptop', 'Speaker']);
  assert.ok(!found.includes('PC'), 'у обычного ПК нет Bluetooth');

  assert.match(BT.pair(phone, spk, '1234'), /PIN/);
  assert.match(BT.pair(phone, far, '0000'), /вне радиуса/);
  assert.equal(BT.pair(phone, spk, '0000'), null);
  assert.match(BT.play(phone, 'Song'), /не подключено/i);
  assert.equal(BT.connectAudio(phone, spk), null);
  assert.equal(BT.play(phone, 'Imagine'), null);
  assert.equal(spk.btRt.playing.track, 'Imagine');
  assert.equal(spk.btRt.playing.from, 'Phone');
  // вторая «голова» не может перехватить занятую колонку
  assert.equal(BT.pair(laptop, spk, '0000'), null);
  assert.match(BT.connectAudio(laptop, spk), /уже подключена к Phone/);

  // файл: только после сопряжения
  assert.match(BT.sendFile(phone, laptop, { name: 'photo.txt', text: 'hello' }), /сопряжение/);
  assert.equal(BT.pair(phone, laptop), null);
  assert.equal(BT.sendFile(phone, laptop, { name: 'photo.txt', text: 'hello' }), null);
  assert.equal(BT.sendFile(phone, laptop, { name: 'photo.txt', text: 'again' }), null);
  assert.deepEqual(laptop.files.map((f) => f.name), ['photo.txt', 'photo (1).txt']);

  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.ok(n2.findByName('Phone').bt.paired.includes(spk.id));
  assert.ok(n2.findByName('Speaker').bt.paired.includes(phone.id));

  // унесли колонку — музыка прекращается
  spk.x = 2000;
  assert.equal(BT.check(net), true);
  assert.equal(spk.btRt.playing, null);
  assert.equal(phone.btRt.audio, null);
  // выключили питание — связи нет
  spk.x = 150;
  assert.equal(BT.connectAudio(phone, spk), null);
  net.setPower(spk, false);
  assert.equal(phone.btRt.audio, null);
  assert.match(BT.connectAudio(phone, spk), /выключен/);
});
