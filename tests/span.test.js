// SPAN на коммутаторе, анализатор Sniffer-PT и экспорт захвата в .pcap (формат libpcap для Wireshark).
const test = require('node:test');
const { NL, assert, mkNet, pc, link, cli, ping } = require('./helpers');

test('SPAN: копии кадров порта-источника уходят на Sniffer, чужой трафик — нет; .pcap читается', () => {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const a = pc(net, 'A', '10.0.0.1/24');
  const b = pc(net, 'B', '10.0.0.2/24');
  const c = pc(net, 'C', '10.0.0.3/24');
  const sn = net.addDevice('sniffer', { name: 'Sniffer' });
  link(net, a, sw, 0, 0);
  link(net, b, sw, 0, 1);
  link(net, c, sw, 0, 2);
  link(net, sn, sw, 0, 23);
  net.runUntilIdle();
  cli(sw, ['enable', 'conf t', 'monitor session 1 source interface fa0/1', 'monitor session 1 destination interface fa0/24', 'end']);
  sn.clearCapture();
  assert.equal(ping(net, a, '10.0.0.2', { count: 2 }).replies.length, 2);
  const types = sn.capture.map((x) => x.frame.type + ':' + (x.frame.payload && x.frame.payload.payload ? x.frame.payload.payload.type : x.frame.payload && x.frame.payload.op));
  assert.ok(types.includes('IPv4:echo-request') && types.includes('IPv4:echo-reply'), 'в захвате запросы и ответы A: ' + types.join(' '));
  const before = sn.capture.length;
  assert.equal(ping(net, c, '10.0.0.2', { count: 1 }).replies.length, 1);
  assert.ok(!sn.capture.slice(before).some((x) => x.frame.type === 'IPv4'), 'трафик C не зеркалится');
  let out = cli(sw, ['enable', 'show monitor session 1', 'show running-config']).text;
  assert.match(out, /Both\s+: Fa0\/1/);
  assert.match(out, /Destination Ports\s+: Fa0\/24/);
  assert.match(out, /^monitor session 1 source interface FastEthernet0\/1\nmonitor session 1 destination interface FastEthernet0\/24$/m);
  // только входящие кадры
  cli(sw, ['enable', 'conf t', 'monitor session 1 source interface fa0/1 rx', 'end']);
  sn.clearCapture();
  ping(net, a, '10.0.0.2', { count: 1 });
  assert.ok(sn.capture.every((x) => !(x.frame.type === 'IPv4' && x.frame.payload.payload.type === 'echo-reply')), 'rx: ответы (tx порта A) не копируются');

  // .pcap: заголовок libpcap, Ethernet + IPv4 + ICMP с верными контрольными суммами
  sn.clearCapture();
  ping(net, a, '10.0.0.2', { count: 1 });
  const bytes = sn.pcap();
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getUint32(0, true), 0xa1b2c3d4);
  assert.equal(dv.getUint32(20, true), 1, 'LINKTYPE_ETHERNET');
  let off = 24;
  let found = false;
  while (off < bytes.length) {
    const len = dv.getUint32(off + 8, true);
    const f = bytes.slice(off + 16, off + 16 + len);
    off += 16 + len;
    if (f[12] !== 0x08 || f[13] !== 0x00) continue;
    const ip = f.slice(14, 34);
    assert.equal(NL.pcap.checksum(Array.from(ip)), 0, 'контрольная сумма IPv4');
    assert.equal(ip[9], 1, 'протокол ICMP');
    assert.deepEqual(Array.from(ip.slice(12, 16)), [10, 0, 0, 1]);
    const icmp = Array.from(f.slice(34, 34 + 8 + 32));
    assert.equal(icmp[0], 8, 'echo request');
    assert.equal(NL.pcap.checksum(icmp), 0, 'контрольная сумма ICMP');
    found = true;
    break;
  }
  assert.ok(found, 'в файле есть кадр IPv4');
  // сохранение настроек SPAN
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.deepEqual(n2.findByName('SW').span[1].src, [{ port: 0, dir: 'rx' }]);
  assert.equal(n2.findByName('SW').span[1].dst, 23);
});

test('pcap: DHCP, DNS, HTTP, ARP и IPv6 превращаются в настоящие байты протоколов', () => {
  const U = NL.util;
  const P = NL.packets;
  const mac1 = '00:11:22:33:44:55';
  const E = (frame) => Array.from(NL.pcap.encodeFrame(frame));
  // ARP
  let f = E(P.frame(mac1, U.BROADCAST_MAC, 'ARP', P.arp('request', mac1, U.parseIp('10.0.0.1'), '00:00:00:00:00:00', U.parseIp('10.0.0.2'))));
  assert.deepEqual(f.slice(12, 14), [0x08, 0x06]);
  assert.deepEqual(f.slice(20, 22), [0, 1], 'ARP request');
  // DHCP Discover: BOOTP + magic cookie + опция 53 = 1
  f = E(P.frame(mac1, U.BROADCAST_MAC, 'IPv4', P.ipv4(0, U.BROADCAST_IP, 'UDP', P.udp(68, 67, { op: 'DISCOVER', xid: 1234, chaddr: mac1, giaddr: 0 }), 64)));
  const bootp = f.slice(14 + 20 + 8);
  assert.equal(bootp[0], 1);
  assert.deepEqual(bootp.slice(236, 240), [0x63, 0x82, 0x53, 0x63]);
  assert.deepEqual(bootp.slice(240, 243), [53, 1, 1]);
  // DNS answer
  f = E(P.frame(mac1, mac1, 'IPv4', P.ipv4(U.parseIp('10.0.0.53'), U.parseIp('10.0.0.1'), 'UDP', P.udp(53, 1025, { op: 'answer', id: 7, name: 'www.lab.local', ip: U.parseIp('10.0.0.80') }), 64)));
  const dns = f.slice(42);
  assert.deepEqual(dns.slice(0, 8), [0, 7, 0x81, 0x80, 0, 1, 0, 1]);
  assert.deepEqual(dns.slice(dns.length - 4), [10, 0, 0, 80]);
  // HTTP GET в TCP
  f = E(P.frame(mac1, mac1, 'IPv4', P.ipv4(U.parseIp('10.0.0.1'), U.parseIp('10.0.0.80'), 'TCP', P.tcp(1025, 80, 100, 1, 'PSH,ACK', { http: 'GET', path: '/index.html' }, 20), 64)));
  const tcp = f.slice(34);
  assert.equal(tcp[13], 0x18, 'флаги PSH+ACK');
  assert.match(Buffer.from(tcp.slice(20)).toString('utf8'), /^GET \/index\.html HTTP\/1\.1\r\n/);
  // ICMPv6 echo-request и Neighbor Solicitation
  const A6 = (s) => NL.ip6.parse(s);
  f = E(P.frame(mac1, mac1, 'IPv6', P.ipv6(A6('2001:db8::1'), A6('2001:db8::2'), 'ICMPv6', P.echoRequest(1, 1, 8), 64)));
  assert.deepEqual(f.slice(12, 14), [0x86, 0xdd]);
  assert.equal(f[20], 58, 'next header ICMPv6');
  assert.equal(f[54], 128, 'echo request');
});
