// IP SLA и track: резервный канал к провайдеру, delay, HSRP track объекта, сохранение.
const test = require('node:test');
const { NL, assert, mkNet, routerIf, link, cli } = require('./helpers');

const U = NL.util;

/** R1 — SWX — ISP1 (через коммутатор: отказ ISP1 не гасит порт R1) и R1 — ISP2 напрямую. */
function lab() {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const isp1 = net.addDevice('router', { name: 'ISP1' });
  const isp2 = net.addDevice('router', { name: 'ISP2' });
  const sw = net.addDevice('switch', { name: 'SWX' });
  routerIf(r1, 1, '203.0.113.2/29');
  routerIf(isp1, 1, '203.0.113.1/29');
  routerIf(r1, 2, '198.51.100.2/30');
  routerIf(isp2, 1, '198.51.100.1/30');
  link(net, r1, sw, 1, 0);
  link(net, isp1, sw, 1, 1);
  link(net, r1, isp2, 2, 1);
  cli(r1, ['enable', 'conf t', 'ip sla 1', 'icmp-echo 203.0.113.1 source-interface g0/1', 'frequency 5', 'exit', 'ip sla schedule 1 life forever start-time now',
    'track 1 ip sla 1 reachability', 'exit', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1 track 1', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1 10', 'end']);
  net.run(1000);
  return { net, r1, isp1, isp2 };
}

/** Команды без прокрутки модельного времени (cli() после каждой команды крутит сеть до 2000 с). */
function cfgNow(dev, lines) {
  const s = NL.cli.createSession(dev);
  const io = { out() {}, write() {}, mutate: (fn) => fn(), done() {}, clear() {} };
  for (const l of lines) NL.cli.exec(dev, s, l, io);
}

const via = (r) => { const x = r.lookup(U.parseIp('8.8.8.8')); return x && x.nextHop != null ? U.ipStr(x.nextHop) : null; };

test('IP SLA + track: основной маршрут пропадает при отказе провайдера, резервный занимает его место', () => {
  const { net, r1, isp1 } = lab();
  assert.equal(via(r1), '203.0.113.1', 'пока ISP1 отвечает — через него');
  let out = cli(r1, ['enable', 'show ip sla statistics', 'show track', 'show track brief', 'show ip route static', 'show ip sla configuration', 'show ip sla summary']).text;
  assert.match(out, /IPSLA operation id: 1\n\s+Latest RTT: \d+ milliseconds/);
  assert.match(out, /Latest operation return code: OK/);
  assert.match(out, /Operation time to live: Forever/);
  assert.match(out, /Track 1\n  IP SLA 1 reachability\n  Reachability is Up/);
  assert.match(out, /Tracked by:\n    Static IP Routing 1/);
  assert.match(out, /^1\s+ip sla\s+1\s+reachability\s+Up/m);
  assert.match(out, /S\*\s+0\.0\.0\.0\/0 \[1\/0\] via 203\.0\.113\.1/);
  assert.match(out, /Target address\/Source interface: 203\.0\.113\.1\/GigabitEthernet0\/1/);
  assert.match(out, /Operation frequency \(seconds\): 5/);
  assert.match(out, /^\*1\s+icmp-echo\s+203\.0\.113\.1\s+RTT=\d+\s+OK/m);

  // отказ провайдера за коммутатором: порт R1 остаётся up, ловит только SLA
  cli(isp1, ['enable', 'conf t', 'interface g0/1', 'shutdown', 'end']);
  net.run(1500);
  assert.equal(r1.ifaceUp(r1.ifaceByName('GigabitEthernet0/1')), true);
  assert.equal(via(r1), '198.51.100.1', 'маршрут переключился на ISP2');
  assert.match(r1.logBuf.join('\n'), /%TRACK-6-STATE: 1 ip sla 1 reachability Up -> Down/);
  out = cli(r1, ['enable', 'show track 1', 'show ip route static', 'show ip sla statistics 1']).text;
  assert.match(out, /Reachability is Down\n    \d+ changes?, last change \d\d:\d\d:\d\d/);
  assert.match(out, /S\*\s+0\.0\.0\.0\/0 \[10\/0\] via 198\.51\.100\.1/);
  assert.doesNotMatch(out, /via 203\.0\.113\.1/);
  assert.match(out, /Latest operation return code: Timeout/);
  assert.match(out, /Number of failures: [1-9]/);

  // восстановление — обратно на ISP1; delay up 30 — не раньше чем через 30 с
  cli(r1, ['enable', 'conf t', 'track 1', 'delay up 30', 'end']);
  cfgNow(isp1, ['enable', 'conf t', 'interface g0/1', 'no shutdown', 'end']);
  net.run(1000);
  assert.equal(via(r1), '198.51.100.1', 'delay up 30: пока ещё резервный');
  net.run(3000);
  assert.equal(via(r1), '203.0.113.1', 'после задержки — снова основной');
  assert.match(r1.logBuf.join('\n'), /%TRACK-6-STATE: 1 ip sla 1 reachability Down -> Up/);

  // running-config и сохранение
  out = cli(r1, ['enable', 'show running-config']).text;
  assert.match(out, /^ip sla 1\n icmp-echo 203\.0\.113\.1 source-interface GigabitEthernet0\/1\n frequency 5\nip sla schedule 1 life forever start-time now\ntrack 1 ip sla 1 reachability\n delay up 30$/m);
  assert.match(out, /^ip route 0\.0\.0\.0 0\.0\.0\.0 203\.0\.113\.1 track 1$/m);
  assert.match(out, /^ip route 0\.0\.0\.0 0\.0\.0\.0 198\.51\.100\.1 10$/m);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.run(4000);
  const r1b = n2.findByName('R1');
  assert.equal(via(r1b), '203.0.113.1', 'после загрузки зонд работает (с учётом delay up 30)');
  assert.equal(r1b.routes.find((r) => r.track === 1).nextHop, U.parseIp('203.0.113.1'));
  assert.equal(r1b.tracks.get(1).delayUp, 30);

  // запись уже запущенного SLA менять нельзя; повторный ip route меняет track
  assert.match(cli(r1, ['enable', 'conf t', 'ip sla 1', 'end']).text, /Entry already running/);
  cli(r1, ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
  assert.equal(r1.routes.filter((r) => r.nextHop === U.parseIp('203.0.113.1')).length, 1);
  assert.equal(r1.routes.find((r) => r.nextHop === U.parseIp('203.0.113.1')).track, undefined, 'маршрут без track');
  assert.match(cli(r1, ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']).text, /Такой маршрут уже есть/);
});

test('track interface и HSRP: standby track N decrement D', () => {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  const lan = net.addDevice('switch', { name: 'LAN' });
  routerIf(r1, 0, '192.168.1.2/24');
  routerIf(r2, 0, '192.168.1.3/24');
  routerIf(r1, 1, '10.0.0.1/30');
  routerIf(r2, 1, '10.0.0.5/30');
  link(net, r1, lan, 0, 0);
  link(net, r2, lan, 0, 1);
  const up1 = net.addDevice('router', { name: 'UP1' });
  routerIf(up1, 0, '10.0.0.2/30');
  link(net, r1, up1, 1, 0);
  cli(r1, ['enable', 'conf t', 'track 5 interface g0/1 line-protocol', 'exit', 'interface g0/0', 'standby 1 ip 192.168.1.254', 'standby 1 priority 110', 'standby 1 preempt', 'standby 1 track 5 decrement 20', 'end']);
  cli(r2, ['enable', 'conf t', 'interface g0/0', 'standby 1 ip 192.168.1.254', 'standby 1 preempt', 'end']);
  net.runUntilIdle();
  assert.match(cli(r1, ['enable', 'show standby brief']).text, /Gi0\/0\s+1\s+110 P Active/);
  assert.match(cli(r1, ['enable', 'show track 5']).text, /Interface GigabitEthernet0\/1 line-protocol\n  Line protocol is Up/);
  cli(up1, ['enable', 'conf t', 'interface g0/0', 'shutdown', 'end']);
  net.runUntilIdle();
  assert.match(cli(r2, ['enable', 'show standby brief']).text, /Gi0\/0\s+1\s+100 P Active/, 'R1 понизил приоритет до 90');
  const out = cli(r1, ['enable', 'show standby', 'show running-config', 'show track brief']).text;
  assert.match(out, /Track object 5 state Down decrement 20/);
  assert.match(out, /^ standby 1 track 5 decrement 20$/m);
  assert.match(out, /^track 5 interface GigabitEthernet0\/1 line-protocol$/m);
  assert.match(out, /^5\s+interface\s+GigabitEthernet0\/1\s+line-protocol\s+Down/m);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.deepEqual(n2.findByName('R1').ifaces[0].fhrp.hsrp['1'].track, [{ obj: 5, dec: 20 }]);
});
