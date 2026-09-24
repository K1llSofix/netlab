// IP-телефония: удержание, слепой перевод, dial-peer и вызовы между двумя CME (H.323).
const test = require('node:test');
const { NL, U, assert, mkNet, routerIf, link, cli } = require('./helpers');

function cme(r, net24, first, count) {
  const gw = net24 + '.1';
  const lines = ['enable', 'conf t', 'ip dhcp excluded-address ' + gw, 'ip dhcp pool VOICE', 'network ' + net24 + '.0 255.255.255.0',
    'default-router ' + gw, 'option 150 ip ' + gw, 'exit',
    'telephony-service', 'max-ephones 5', 'max-dn 5', 'ip source-address ' + gw + ' port 2000', 'auto assign 1 to 5', 'exit'];
  for (let i = 0; i < count; i++) lines.push('ephone-dn ' + (i + 1), 'number ' + (first + i), 'exit');
  lines.push('end');
  cli(r, lines);
}

function phones(net, sw, names) {
  return names.map((n) => {
    const p = net.addDevice('ipphone', { name: n });
    link(net, p, sw, 0);
    p.setAdapter(true);
    net.runUntilIdle();
    return p;
  });
}

/** Два CME: R1 (10.1.0.0/24, номера 100x) и R2 (10.2.0.0/24, номера 200x), между ними 192.168.0.0/30. */
function lab() {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'CME1' });
  const r2 = net.addDevice('router', { name: 'CME2' });
  const s1 = net.addDevice('switch', { name: 'SW1' });
  const s2 = net.addDevice('switch', { name: 'SW2' });
  routerIf(r1, 0, '10.1.0.1/24');
  routerIf(r1, 1, '192.168.0.1/30');
  routerIf(r2, 0, '10.2.0.1/24');
  routerIf(r2, 1, '192.168.0.2/30');
  link(net, r1, s1, 0);
  link(net, r2, s2, 0);
  link(net, r1, r2, 1, 1);
  cli(r1, ['enable', 'conf t', 'ip route 10.2.0.0 255.255.255.0 192.168.0.2', 'end']);
  cli(r2, ['enable', 'conf t', 'ip route 10.1.0.0 255.255.255.0 192.168.0.1', 'end']);
  cme(r1, '10.1.0', 1001, 3);
  cme(r2, '10.2.0', 2001, 2);
  const [p1, p2, p3] = phones(net, s1, ['P1', 'P2', 'P3']);
  const [p4, p5] = phones(net, s2, ['P4', 'P5']);
  net.runUntilIdle();
  for (const p of [p1, p2, p3, p4, p5]) assert.equal(p.sccp.state, 'registered', p.name + ': ' + p.sccp.text);
  return { net, r1, r2, p1, p2, p3, p4, p5 };
}

function connect(net, a, b, number) {
  assert.equal(a.sccp.dial(number), null);
  net.runUntilIdle();
  assert.equal(b.sccp.call && b.sccp.call.state, 'ringing', b.name + ' должен звонить: ' + (a.sccp.call ? a.sccp.call.text : a.sccp.text));
  assert.equal(b.sccp.answer(), null);
  net.runUntilIdle();
  assert.equal(a.sccp.call.state, 'connected', a.sccp.call && a.sccp.call.text);
  assert.equal(b.sccp.call.state, 'connected');
}

test('CME: удержание и слепой перевод между телефонами одного CME', () => {
  const { net, r1, p1, p2, p3 } = lab();
  connect(net, p1, p2, '1002');

  // удержание
  assert.equal(p1.sccp.hold(), null);
  net.runUntilIdle();
  assert.equal(p2.sccp.call.remoteHold, true);
  assert.match(p2.sccp.call.text, /удержание/);
  assert.match(p2.sccp.say('алло?'), /удержание/);
  assert.match(p1.sccp.say('тихо'), /удержании/);
  let out = cli(r1, ['enable', 'show ephone', 'show ephone-dn', 'show call active voice brief']).text;
  assert.match(out, /number 1001 CH1\s+HOLD/);
  assert.match(out, /number 1002 CH1\s+CONNECTED/);
  assert.match(out, /1001\s+-> 1002\s+CONNECTED HOLD/);
  assert.equal(p1.sccp.resume(), null);
  net.runUntilIdle();
  assert.equal(p2.sccp.call.remoteHold, false);
  assert.equal(p2.sccp.say('снова слышно'), null);
  net.runUntilIdle();
  assert.ok(p1.sccp.heard.some((h) => h.text === 'снова слышно'));

  // перевод на несуществующий номер — разговор продолжается
  assert.equal(p1.sccp.transfer('7777'), null);
  net.runUntilIdle();
  assert.equal(p1.sccp.call.state, 'connected');
  assert.match(p1.sccp.call.text, /Перевод не выполнен: номер 7777 не существует/);

  // слепой перевод 1002 → 1003
  assert.equal(p1.sccp.transfer('1003'), null);
  net.runUntilIdle();
  assert.equal(p1.sccp.call, null);
  assert.match(p1.sccp.text, /переведён на 1003/);
  assert.equal(p2.sccp.call.state, 'ringback');
  assert.equal(p3.sccp.call.state, 'ringing');
  assert.equal(p3.sccp.call.peer, '1002');
  p3.sccp.answer();
  net.runUntilIdle();
  assert.equal(p2.sccp.call.state, 'connected');
  assert.equal(p3.sccp.call.state, 'connected');
  p3.sccp.say('это 1003');
  net.runUntilIdle();
  assert.ok(p2.sccp.heard.some((h) => h.text === 'это 1003'));
  // P1 свободен и может звонить
  assert.equal(p1.sccp.dial('1002'), null);
  net.runUntilIdle();
  assert.equal(p1.sccp.call, null);
  assert.match(p1.sccp.text, /занят/);
});

test('dial-peer voice: вызовы между двумя CME по H.323, RTP напрямую, удержание, перевод, сохранение', () => {
  const { net, r1, r2, p1, p2, p4, p5 } = lab();

  // без dial-peer номер чужого CME неизвестен
  p1.sccp.dial('2001');
  net.runUntilIdle();
  assert.equal(p1.sccp.call, null);
  assert.match(p1.sccp.text, /не существует/);

  let out = cli(r1, ['enable', 'conf t', 'dial-peer voice 10 pots']).text;
  assert.match(out, /POTS/);
  cli(r1, ['enable', 'conf t', 'dial-peer voice 1 voip', 'destination-pattern 20..', 'session target ipv4:192.168.0.2', 'codec g711ulaw', 'end']);
  cli(r2, ['enable', 'conf t', 'dial-peer voice 1 voip', 'destination-pattern 1...', 'session target ipv4:192.168.0.1', 'end']);
  out = cli(r1, ['enable', 'show dial-peer voice summary', 'show running-config']).text;
  assert.match(out, /^1\s+voip\s+up\s+up\s+20\.\.\s+0\s+syst ipv4:192\.168\.0\.2/m);
  assert.match(out, /^dial-peer voice 1 voip\n destination-pattern 20\.\.\n session target ipv4:192\.168\.0\.2\n codec g711ulaw$/m);

  // вызов на другой CME
  net.recording = true;
  const log = [];
  const off = net.on((t, e) => { if (t === 'log' && e.type === 'tx') log.push(e); });
  connect(net, p1, p4, '2001');
  assert.equal(p4.sccp.call.peer, '1001');
  assert.equal(p1.sccp.call.peerIp, p4.iface.ip);
  p1.sccp.say('привет с CME1');
  net.runUntilIdle();
  off();
  assert.ok(p4.sccp.heard.some((h) => h.text === 'привет с CME1'));
  assert.ok(log.some((e) => e.proto === 'H323'), 'сигнализация H.323 между CME');
  out = cli(r2, ['enable', 'show call active voice brief']).text;
  assert.match(out, /1001\s+-> 2001\s+CONNECTED\s+H\.323 from 192\.168\.0\.1/);

  // удержание через H.323
  p4.sccp.hold();
  net.runUntilIdle();
  assert.equal(p1.sccp.call.remoteHold, true);
  p4.sccp.resume();
  net.runUntilIdle();
  assert.equal(p1.sccp.call.remoteHold, false);

  // P4 переводит собеседника (1001 на CME1) на местный 2002
  p4.sccp.transfer('2002');
  net.runUntilIdle();
  assert.equal(p4.sccp.call, null);
  assert.equal(p5.sccp.call.state, 'ringing');
  assert.equal(p5.sccp.call.peer, '1001');
  assert.equal(p1.sccp.call.state, 'ringback');
  p5.sccp.answer();
  net.runUntilIdle();
  assert.equal(p1.sccp.call.state, 'connected');
  assert.equal(p1.sccp.call.peerIp, p5.iface.ip, 'голос теперь идёт на новый телефон');
  p5.sccp.say('это 2002');
  net.runUntilIdle();
  assert.ok(p1.sccp.heard.some((h) => h.text === 'это 2002'));

  // отбой с удалённой стороны
  p5.sccp.hangup();
  net.runUntilIdle();
  assert.equal(p1.sccp.call, null);
  assert.match(p1.sccp.text, /положил трубку/);
  assert.equal(r1.cmeRt.calls.size, 0);
  assert.equal(r2.cmeRt.calls.size, 0);

  // занято и несуществующий номер на удалённом CME
  connect(net, p4, p5, '2002');
  p1.sccp.dial('2002');
  net.runUntilIdle();
  assert.equal(p1.sccp.call, null);
  assert.match(p1.sccp.text, /занят/);
  p1.sccp.dial('2099');
  net.runUntilIdle();
  assert.equal(p1.sccp.call, null);
  assert.match(p1.sccp.text, /не существует на удалённом CME/);

  // местный перевод на удалённый номер: 1001 говорит с 1002 и переводит его на 2001
  p4.sccp.hangup();
  net.runUntilIdle();
  assert.equal(p5.sccp.call, null);
  connect(net, p1, p2, '1002');
  p1.sccp.transfer('2001');
  net.runUntilIdle();
  assert.equal(p1.sccp.call, null);
  assert.equal(p2.sccp.call.state, 'ringback');
  assert.equal(p4.sccp.call.state, 'ringing');
  assert.equal(p4.sccp.call.peer, '1002');
  p4.sccp.answer();
  net.runUntilIdle();
  assert.equal(p2.sccp.call.state, 'connected');
  assert.equal(p2.sccp.call.peerIp, p4.iface.ip);

  // shutdown: dial-peer не используется
  cli(r1, ['enable', 'conf t', 'dial-peer voice 1 voip', 'shutdown', 'end']);
  assert.equal(NL.voip2.matchPeer(r1.cme, '2001'), null);
  cli(r1, ['enable', 'conf t', 'dial-peer voice 1 voip', 'no shutdown', 'end']);

  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  const r1b = n2.findByName('CME1');
  assert.equal(r1b.cme.peers[1].pattern, '20..');
  assert.equal(U.ipStr(r1b.cme.peers[1].target), '192.168.0.2');
  out = cli(r1b, ['enable', 'show dial-peer voice 1']).text;
  assert.match(out, /destination-pattern = `20\.\.'/);
});

test('destination-pattern: точки, диапазоны, T, выбор самого точного dial-peer', () => {
  const { patRe, matchPeer } = NL.voip2;
  assert.ok(patRe('2...').test('2001'));
  assert.ok(!patRe('2...').test('20011'));
  assert.ok(patRe('[2-3]0T').test('30123'));
  assert.ok(patRe('9T').test('9'));
  assert.equal(patRe('2x'), null);
  const c = { peers: { 1: { pattern: '2...', target: 1 }, 2: { pattern: '20..', target: 2 }, 3: { pattern: '2T', target: 3 } } };
  assert.equal(matchPeer(c, '2001')[0], '2');
  assert.equal(matchPeer(c, '2101')[0], '1');
  assert.equal(matchPeer(c, '21')[0], '3');
  assert.equal(matchPeer(c, '3001'), null);
});
