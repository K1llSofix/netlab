// Резервирование шлюза: HSRP (preempt, track, отказ), VRRP (владелец адреса), GLBP (балансировка).
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping } = require('./helpers');

const U = NL.util;

/** Два маршрутизатора между LAN (192.168.1.0/24) и серверной сетью (10.0.0.0/24). */
function lab(proto) {
  const net = mkNet();
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  const lan = net.addDevice('switch', { name: 'LAN' });
  const dc = net.addDevice('switch', { name: 'DC' });
  routerIf(r1, 0, '192.168.1.2/24');
  routerIf(r2, 0, '192.168.1.3/24');
  routerIf(r1, 1, '10.0.0.2/24');
  routerIf(r2, 1, '10.0.0.3/24');
  link(net, r1, lan, 0, 23);
  link(net, r2, lan, 0, 22);
  link(net, r1, dc, 1, 23);
  link(net, r2, dc, 1, 22);
  const host = pc(net, 'PC', '192.168.1.10/24', '192.168.1.254');
  const host2 = pc(net, 'PC2', '192.168.1.11/24', '192.168.1.254');
  const srv = net.addDevice('server', { name: 'Srv' });
  srv.setStatic(U.parseIp('10.0.0.10'), U.maskFromPrefix(24), U.parseIp('10.0.0.254'), null);
  link(net, host, lan, 0, 0);
  link(net, host2, lan, 0, 1);
  link(net, srv, dc, 0, 0);
  const cfg = (r, prio) => proto === 'hsrp'
    ? ['enable', 'conf t', 'interface g0/0', 'standby 1 ip 192.168.1.254', 'standby 1 priority ' + prio, 'standby 1 preempt', 'interface g0/1', 'standby 2 ip 10.0.0.254', 'standby 2 priority ' + prio, 'standby 2 preempt', 'end']
    : proto === 'vrrp'
      ? ['enable', 'conf t', 'interface g0/0', 'vrrp 1 ip 192.168.1.254', 'vrrp 1 priority ' + prio, 'interface g0/1', 'vrrp 2 ip 10.0.0.254', 'vrrp 2 priority ' + prio, 'end']
      : ['enable', 'conf t', 'interface g0/0', 'glbp 1 ip 192.168.1.254', 'glbp 1 priority ' + prio, 'glbp 1 preempt', 'interface g0/1', 'glbp 2 ip 10.0.0.254', 'glbp 2 priority ' + prio, 'glbp 2 preempt', 'end'];
  cli(r1, cfg(r1, 110));
  cli(r2, cfg(r2, 100));
  net.runUntilIdle();
  return { net, r1, r2, host, host2, srv };
}

test('HSRP: активен R1, при отказе — R2 без смены шлюза на ПК, preempt возвращает R1, track', () => {
  const { net, r1, r2, host } = lab('hsrp');
  let out = cli(r1, ['enable', 'show standby brief']).text;
  assert.match(out, /Gi0\/0\s+1\s+110 P Active\s+local\s+192\.168\.1\.3\s+192\.168\.1\.254/);
  out = cli(r2, ['enable', 'show standby brief']).text;
  assert.match(out, /Gi0\/0\s+1\s+100 P Standby\s+192\.168\.1\.2\s+local/);
  assert.equal(ping(net, host, '10.0.0.10', { count: 3 }).replies.length, 3);
  assert.equal(host.arp.get(U.parseIp('192.168.1.254')).mac, '00:00:0C:07:AC:01', 'шлюз — виртуальный MAC HSRP');
  assert.equal(ping(net, host, '192.168.1.254', { count: 1 }).replies.length, 1, 'виртуальный IP отвечает на ping');
  // отказ R1
  cli(r1, ['enable', 'conf t', 'interface g0/0', 'shutdown', 'interface g0/1', 'shutdown', 'end']);
  assert.match(r2.logBuf.join('\n'), /%HSRP-6-STATECHANGE: Gi0\/0 Grp 1 state Standby -> Active/);
  const r = ping(net, host, '10.0.0.10', { count: 3 });
  assert.equal(r.replies.length, 3, 'после отказа трафик идёт через R2');
  // R1 вернулся — preempt
  cli(r1, ['enable', 'conf t', 'interface g0/0', 'no shutdown', 'interface g0/1', 'no shutdown', 'end']);
  out = cli(r1, ['enable', 'show standby brief']).text;
  assert.match(out, /Gi0\/0\s+1\s+110 P Active/);
  // track: упал верхний интерфейс R1 — приоритет 90, активным становится R2
  cli(r1, ['enable', 'conf t', 'interface g0/0', 'standby 1 track g0/1 20', 'interface g0/1', 'shutdown', 'end']);
  out = cli(r2, ['enable', 'show standby brief', 'show standby']).text;
  assert.match(out, /Gi0\/0\s+1\s+100 P Active/);
  assert.match(cli(r1, ['enable', 'show standby']).text, /Priority 90 \(configured 110\)[\s\S]*Track interface GigabitEthernet0\/1 state Down decrement 20/);
  out = cli(r1, ['enable', 'show running-config']).text;
  assert.match(out, /^ standby 1 ip 192\.168\.1\.254$/m);
  assert.match(out, /^ standby 1 priority 110$/m);
  assert.match(out, /^ standby 1 track GigabitEthernet0\/1 20$/m);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(ping(n2, n2.findByName('PC'), '10.0.0.10', { count: 2 }).replies.length, 2);
});

test('HSRP: без preempt вернувшийся маршрутизатор остаётся Standby; адрес вне подсети отклоняется', () => {
  const { r1, r2 } = lab('hsrp');
  cli(r1, ['enable', 'conf t', 'interface g0/0', 'no standby 1 preempt', 'shutdown', 'end']);
  cli(r1, ['enable', 'conf t', 'interface g0/0', 'no shutdown', 'end']);
  assert.match(cli(r1, ['enable', 'show standby brief']).text, /Gi0\/0\s+1\s+110\s+Standby/);
  assert.match(cli(r2, ['enable', 'show standby brief']).text, /Gi0\/0\s+1\s+100 P Active/);
  const out = cli(r1, ['enable', 'conf t', 'interface g0/0', 'standby 3 ip 172.16.0.1', 'end']).text;
  assert.match(out, /must be in the subnet/);
});

test('VRRP: мастер с большим приоритетом, владелец адреса всегда 255', () => {
  const { net, r1, r2, host } = lab('vrrp');
  assert.match(cli(r1, ['enable', 'show vrrp brief']).text, /Gi0\/0\s+1\s+110 .* Master/);
  assert.equal(ping(net, host, '10.0.0.10', { count: 2 }).replies.length, 2);
  assert.equal(host.arp.get(U.parseIp('192.168.1.254')).mac, '00:00:5E:00:01:01');
  cli(r2, ['enable', 'conf t', 'interface g0/0', 'vrrp 5 ip 192.168.1.3', 'end']);
  cli(r1, ['enable', 'conf t', 'interface g0/0', 'vrrp 5 ip 192.168.1.3', 'vrrp 5 priority 200', 'end']);
  assert.match(cli(r2, ['enable', 'show vrrp']).text, /Group 5\n  State is Master[\s\S]*Priority is 255 \(address owner\)/);
});

test('GLBP: разные компьютеры получают MAC разных AVF, при отказе MAC берёт другой маршрутизатор', () => {
  const { net, r1, r2, host, host2 } = lab('glbp');
  assert.equal(ping(net, host, '10.0.0.10', { count: 2 }).replies.length, 2);
  assert.equal(ping(net, host2, '10.0.0.10', { count: 2 }).replies.length, 2);
  const m1 = host.arp.get(U.parseIp('192.168.1.254')).mac;
  const m2 = host2.arp.get(U.parseIp('192.168.1.254')).mac;
  assert.match(m1, /^00:07:B4:00:01:0[12]$/);
  assert.notEqual(m1, m2, 'балансировка: разные виртуальные MAC');
  const out = cli(r1, ['enable', 'show glbp brief']).text;
  assert.match(out, /Gi0\/0\s+1\s+-\s+110 Active/);
  // отказ R2 — его AVF-MAC обслуживает R1, оба компьютера работают дальше
  net.setPower(r2, false);
  net.runUntilIdle();
  assert.equal(ping(net, host, '10.0.0.10', { count: 2 }).replies.length, 2);
  assert.equal(ping(net, host2, '10.0.0.10', { count: 2 }).replies.length, 2);
});
