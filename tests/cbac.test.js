// CBAC (ip inspect) и IOS IPS: ответы проходят через запрещающий ACL только в проверенных сеансах; сигнатура 2004 отбрасывает ping.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping } = require('./helpers');

function lab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  routerIf(r, 0, '192.168.1.1/24');
  routerIf(r, 1, '203.0.113.1/24');
  const a = pc(net, 'PC', '192.168.1.10/24', '192.168.1.1');
  const srv = net.addDevice('server', { name: 'WEB' });
  srv.setStatic(NL.util.parseIp('203.0.113.10'), NL.util.maskFromPrefix(24), NL.util.parseIp('203.0.113.1'), null);
  link(net, a, r, 0, 0);
  link(net, srv, r, 0, 1);
  cli(r, ['enable', 'conf t', 'hostname R1', 'ip access-list extended OUTSIDE-IN', 'deny ip any any', 'exit', 'interface g0/1', 'ip access-group OUTSIDE-IN in', 'end']);
  net.runUntilIdle();
  return { net, r, a, srv };
}

test('CBAC: ip inspect открывает окно в ACL для ответов, обратно сеанс не начать', () => {
  const { net, r, a, srv } = lab();
  assert.equal(ping(net, a, '203.0.113.10', { count: 1 }).replies.length, 0, 'без inspect ответ блокирует ACL');
  cli(r, ['enable', 'conf t', 'ip inspect name FW icmp', 'ip inspect name FW tcp', 'ip inspect audit-trail', 'interface g0/1', 'ip inspect FW out', 'end']);
  assert.equal(ping(net, a, '203.0.113.10', { count: 2 }).replies.length, 2, 'ответы в проверенном сеансе проходят');
  let res;
  a.httpGet('http://203.0.113.10', (x) => { res = x; });
  net.runUntilIdle(200000);
  assert.ok(res && res.ok, 'HTTP (TCP) изнутри работает');
  assert.equal(ping(net, srv, '192.168.1.10', { count: 1 }).replies.length, 0, 'снаружи сеанс не начать');
  const out = cli(r, ['enable', 'show ip inspect all', 'show running-config']).text;
  assert.match(out, /Inspection name FW\n    icmp alert is on audit-trail is on timeout 10\n    tcp alert is on/);
  assert.match(out, /Interface GigabitEthernet0\/1\n  Inbound inspection rule is not set\n  Outgoing inspection rule is FW/);
  assert.match(out, /\(192\.168\.1\.10:\d+\)=>\(203\.0\.113\.10:80\) http SIS_OPEN/);
  assert.match(out, /^ip inspect audit-trail\nip inspect name FW icmp\nip inspect name FW tcp$/m);
  assert.match(out, /^ ip inspect FW out$/m);
  assert.match(r.logBuf.join('\n'), /%FW-6-SESS_AUDIT_TRAIL_START: Start icmp session: initiator \(192\.168\.1\.10:0\) -- responder \(203\.0\.113\.10:0\)/);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.deepEqual(n2.findByName('R1').cbac.rules.FW, ['icmp', 'tcp']);
  assert.equal(n2.findByName('R1').ifaceByName('GigabitEthernet0/1').inspect.out, 'FW');
});

test('IOS IPS: категория basic, сигнатура 2004 с deny-packet-inline, журнал %IPS-4-SIGNATURE', () => {
  const { net, r, a } = lab();
  cli(r, ['enable', 'conf t', 'interface g0/1', 'no ip access-group OUTSIDE-IN in', 'end']);
  assert.equal(ping(net, a, '203.0.113.10', { count: 1 }).replies.length, 1);
  cli(r, ['enable', 'conf t', 'ip ips config location flash:ipsdir', 'ip ips name IOSIPS', 'ip ips notify log',
    'ip ips signature-category', 'category all', 'retired true', 'exit', 'category ios_ips basic', 'retired false', 'exit', 'exit',
    'interface g0/0', 'ip ips IOSIPS in', 'exit',
    'ip ips signature-definition', 'signature 2004 0', 'status', 'retired false', 'enabled true', 'exit', 'engine', 'event-action produce-alert', 'event-action deny-packet-inline', 'exit', 'exit', 'exit', 'end']);
  net.recording = true;
  assert.equal(ping(net, a, '203.0.113.10', { count: 2 }).replies.length, 0, 'ping отброшен сигнатурой');
  assert.ok(net.log.some((e) => e.type === 'drop' && /IOS IPS IOSIPS: сигнатура 2004\/0/.test(e.reason)));
  assert.match(r.logBuf.join('\n'), /%IPS-4-SIGNATURE: Sig:2004 Subsig:0 Sev:25 ICMP Echo Req \[192\.168\.1\.10:0 -> 203\.0\.113\.10:0\]/);
  const out = cli(r, ['enable', 'show ip ips all', 'show ip ips signatures count']).text;
  assert.match(out, /Event notification through syslog is enabled/);
  assert.match(out, /Interface GigabitEthernet0\/0\n        Inbound IPS rule is IOSIPS/);
  assert.match(out, /Total Enabled Signatures: 5/, 'basic (1102, 1104, 3040, 5081) + 2004');
  assert.match(out, /2004 0  ICMP Echo Req  sev=informational  action=produce-alert,deny-packet-inline/);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(ping(n2, n2.findByName('PC'), '203.0.113.10', { count: 1 }).replies.length, 0, 'после загрузки IPS работает');
});
