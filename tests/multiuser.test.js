// Многопользовательский режим: две схемы, соединённые облаками Multiuser-PT (транспорт — в памяти).
const test = require('node:test');
const { NL, U, assert, mkNet, pc, link } = require('./helpers');

/** Две сети шагают по времени вместе; сообщения между ними доставляются в следующий шаг. */
function pair() {
  const A = mkNet();
  const B = mkNet();
  const qa = [];
  const qb = [];
  let from = null;
  NL.multiuser.connected = () => true;
  NL.multiuser.transport = (msg) => (from === A ? qb : qa).push(msg);
  let T = 0;
  const run = (ticks) => {
    for (let t = 0; t < ticks; t++) {
      T++;
      for (const n of [A, B]) {
        from = n;
        n.runUntilIdle(Math.max(0, T - n.time));
        if (n.time < T) n.time = T;
      }
      while (qb.length) { from = B; NL.multiuser.deliver(B, qb.shift(), 'A'); }
      while (qa.length) { from = A; NL.multiuser.deliver(A, qa.shift(), 'B'); }
    }
  };
  return { A, B, run };
}

test('Multiuser-PT: ПК в двух схемах в одной сети видят друг друга (ARP, ping, IPv6 BigInt)', () => {
  const { A, B, run } = pair();
  const ca = A.addDevice('mucloud', { name: 'Office' });
  const cb = B.addDevice('mucloud', { name: 'Home' });
  ca.remote = 'Home';
  cb.remote = 'Office';
  const pa = pc(A, 'PC-A', '10.0.0.1/24');
  const pb = pc(B, 'PC-B', '10.0.0.2/24');
  link(A, pa, ca, 0, 0);
  link(B, pb, cb, 0, 0);
  run(50);
  let done = null;
  pa.ping('10.0.0.2', { count: 2, onEvent: (e) => { if (e.type === 'done') done = e; } });
  run(900);
  assert.ok(done, 'ping завершился');
  assert.equal(done.received, 2, 'ответы пришли из другой схемы');
  assert.equal(pb.arp.get(U.parseIp('10.0.0.1')).mac, pa.ifaceMac(pa.iface));
  assert.ok(ca.stats.out > 0 && ca.stats.in > 0);
  // кодирование BigInt
  const fr = { src: 'a', dst: 'b', type: 'IPv6', payload: { src: 1n << 100n, dst: 5n } };
  assert.deepEqual(NL.multiuser.decode(JSON.parse(JSON.stringify(NL.multiuser.encode(fr)))), fr);
  // без подключения кадр отбрасывается
  NL.multiuser.connected = () => false;
  A.recording = true;
  pa.ping('10.0.0.2', { count: 1 });
  run(400);
  assert.ok(A.log.some((e) => e.type === 'drop' && /нет подключения к другой копии NetLab/.test(e.reason)));
  NL.multiuser.transport = null;
  // сохранение настройки
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(A.serialize())));
  assert.equal(n2.findByName('Office').remote, 'Home');
});
