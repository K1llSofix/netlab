// Сравнение схем: устройства, кабели, построчная разница running-config и настроек узлов.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

function lab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch', { name: 'SW1' });
  routerIf(r, 0, '192.168.1.1/24');
  const a = pc(net, 'PC1', '192.168.1.10/24', '192.168.1.1');
  link(net, r, sw, 0, 0);
  link(net, a, sw, 0, 1);
  cli(r, ['enable', 'conf t', 'hostname R1', 'interface g0/0', 'description LAN', 'end']);
  net.runUntilIdle();
  return net;
}

test('Сравнение схем: одинаковые, изменённые настройки, устройства и кабели', () => {
  const ref = lab();
  const cur = NL.Network.deserialize(JSON.parse(JSON.stringify(ref.serialize())));
  assert.equal(NL.diffnet.compare(ref, cur).same, true);

  cli(cur.findByName('R1'), ['enable', 'conf t', 'interface g0/0', 'description LAN-USERS', 'ip address 192.168.1.254 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 192.168.1.2', 'end']);
  const p = cur.findByName('PC1');
  p.setStatic(p.iface.ip, p.iface.mask, NL.util.parseIp('192.168.1.254'), null);
  const b = pc(cur, 'PC2', '192.168.1.11/24', '192.168.1.254');
  link(cur, b, cur.findByName('SW1'), 0, 2);
  const d = NL.diffnet.compare(ref, cur);
  assert.equal(d.same, false);
  assert.deepEqual(d.added, ['PC2 (PC-PT)']);
  assert.deepEqual(d.removed, []);
  assert.equal(d.links.added.length, 1);
  assert.match(d.links.added[0], /PC2 FastEthernet0 ↔ SW1 FastEthernet0\/3/);
  const r1 = d.changed.find((x) => x.name === 'R1');
  const txt = r1.lines.map((l) => l.op + l.text).join('\n');
  assert.match(txt, /^ interface GigabitEthernet0\/0$/m, 'строка режима над изменением');
  assert.match(txt, /^- description LAN$/m);
  assert.match(txt, /^\+ description LAN-USERS$/m);
  assert.match(txt, /^- ip address 192\.168\.1\.1 255\.255\.255\.0$/m);
  assert.match(txt, /^\+ip route 0\.0\.0\.0 0\.0\.0\.0 192\.168\.1\.2$/m);
  const pc1 = d.changed.find((x) => x.name === 'PC1');
  assert.deepEqual(pc1.lines.filter((l) => l.op !== ' ' && l.op !== '…').map((l) => l.op + l.text), ['-Шлюз: 192.168.1.1', '+Шлюз: 192.168.1.254']);
  // удалённое устройство
  const cur2 = lab();
  cur2.removeDevice(cur2.findByName('PC1').id);
  const d2 = NL.diffnet.compare(ref, cur2);
  assert.deepEqual(d2.removed, ['PC1 (PC-PT)']);
  assert.equal(d2.links.removed.length, 1);
});

test('Построчная разница: LCS и сжатие контекста', () => {
  const D = NL.diffnet;
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const b = ['a', 'b', 'c', 'X', 'e', 'f', 'g', 'h', 'i'];
  const d = D.lineDiff(a, b);
  assert.deepEqual(d.filter((x) => x.op !== ' ').map((x) => x.op + x.text), ['-d', '+X', '+i']);
  const c = D.compact(d, 1);
  assert.equal(c[0].op, '…');
  assert.match(c[0].text, /^2 строк/);
});
