// Linux на узлах: ip, ifconfig, route, ping, curl, ss, iptables, tcpdump, systemctl, конвейеры, сохранение.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

const U = NL.util;

/** LNX (Linux) и WEB (сервер) в одной сети с маршрутизатором R1. */
function lab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch', { name: 'SW' });
  routerIf(r, 0, '192.168.1.1/24');
  const lx = pc(net, 'LNX', '192.168.1.10/24', '192.168.1.1');
  const web = net.addDevice('server', { name: 'WEB' });
  web.setStatic(U.parseIp('192.168.1.20'), U.maskFromPrefix(24), U.parseIp('192.168.1.1'), null);
  link(net, lx, sw, 0, 0);
  link(net, web, sw, 0, 1);
  link(net, r, sw, 0, 2);
  NL.linux.setOs(lx, 'linux');
  NL.linux.setOs(web, 'linux');
  net.runUntilIdle();
  return { net, r, lx, web };
}

const sh = (dev, cmds, session) => cli(dev, cmds, session);

test('Linux: приглашение, ip addr / route / link, ifconfig, route -n, ping, конвейеры', () => {
  const { net, lx } = lab();
  const s = NL.cli.createSession(lx);
  assert.equal(NL.cli.prompt(lx, s), 'root@LNX:~# ');
  let out = sh(lx, ['ip a', 'ip -br a', 'ip r', 'route -n', 'ifconfig eth0']).text;
  assert.match(out, /^2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 .* state UP/m);
  assert.match(out, /inet 192\.168\.1\.10\/24 brd 192\.168\.1\.255 scope global eth0/);
  assert.match(out, /^eth0\s+UP\s+192\.168\.1\.10\/24$/m);
  assert.match(out, /^default via 192\.168\.1\.1 dev eth0 proto static$/m);
  assert.match(out, /^192\.168\.1\.0\/24 dev eth0 proto kernel scope link src 192\.168\.1\.10$/m);
  assert.match(out, /^0\.0\.0\.0\s+192\.168\.1\.1\s+0\.0\.0\.0\s+UG/m);
  assert.match(out, /inet 192\.168\.1\.10 {2}netmask 255\.255\.255\.0 {2}broadcast 192\.168\.1\.255/);

  out = sh(lx, ['ping -c 3 192.168.1.1']).text;
  assert.match(out, /^PING 192\.168\.1\.1 \(192\.168\.1\.1\) 56\(84\) bytes of data\.$/m);
  assert.match(out, /^64 bytes from 192\.168\.1\.1: icmp_seq=\d ttl=255 time=[\d.]+ ms$/m);
  assert.match(out, /^3 packets transmitted, 3 received, 0% packet loss/m);
  assert.match(out, /^rtt min\/avg\/max\/mdev = /m);
  assert.match(sh(lx, ['ping -c 2 10.9.9.9']).text, /From 192\.168\.1\.1 icmp_seq=\d Destination Net Unreachable/);
  assert.match(sh(lx, ['ping -c 1 nosuch.example']).text, /ping: nosuch\.example: Temporary failure in name resolution/);

  // изменение адреса, маршрута, состояния порта
  sh(lx, ['ip addr add 192.168.1.50/24 dev eth0', 'ip route add default via 192.168.1.1']);
  assert.equal(U.ipStr(lx.iface.ip), '192.168.1.50');
  assert.equal(U.ipStr(lx.gateway), '192.168.1.1');
  assert.match(sh(lx, ['ip route add default via 10.0.0.1']).text, /Nexthop has invalid gateway/);
  sh(lx, ['ip route del default']);
  assert.equal(lx.gateway, null);
  assert.match(sh(lx, ['ping -c 1 8.8.8.8']).text, /ping: connect: Network is unreachable/);
  sh(lx, ['ip link set eth0 down']);
  assert.match(sh(lx, ['ip link']).text, /eth0: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN/);
  sh(lx, ['ip link set dev eth0 up']);
  assert.match(sh(lx, ['ip -br a']).text, /eth0\s+UP/);
  assert.match(sh(lx, ['ip a | grep inet | wc -l']).text, /^2$/m, 'конвейер: grep и wc -l');
  assert.match(sh(lx, ['help | head -n 1']).text, /^NetLab Linux — bash/m);
  assert.match(sh(lx, ['frobnicate']).text, /frobnicate: command not found/);
  // resolv.conf
  sh(lx, ['echo "nameserver 192.168.1.20" > /etc/resolv.conf']);
  assert.equal(U.ipStr(lx.dns), '192.168.1.20');
  assert.match(sh(lx, ['cat /etc/resolv.conf']).text, /^nameserver 192\.168\.1\.20$/m);
});

test('Linux: curl, systemctl, ss, nslookup, dhclient', () => {
  const { net, lx, web } = lab();
  let out = sh(lx, ['curl http://192.168.1.20/']).text;
  assert.match(out, /<html|Cisco|NetLab/i, out);
  out = sh(lx, ['curl -I http://192.168.1.20/']).text;
  assert.match(out, /^HTTP\/1\.1 200 OK$/m);
  out = sh(web, ['systemctl status apache2', 'ss -tln']).text;
  assert.match(out, /● apache2\.service - The Apache HTTP Server/);
  assert.match(out, /Active: active \(running\)/);
  assert.match(out, /^tcp\s+LISTEN\s+0\s+0\s+0\.0\.0\.0:80\s+0\.0\.0\.0:\*$/m);
  sh(web, ['systemctl stop apache2']);
  assert.equal(web.httpd.enabled, false);
  assert.match(sh(lx, ['curl http://192.168.1.20/']).text, /curl: \(7\) Failed to connect to 192\.168\.1\.20 port 80/);
  assert.match(sh(lx, ['systemctl status nginx2']).text, /Unit nginx2\.service could not be found/);
  sh(web, ['systemctl start apache2']);
  assert.match(sh(lx, ['nc -zv 192.168.1.20 80']).text, /Connection to 192\.168\.1\.20 80 port \[tcp\/http\] succeeded!/);
  assert.match(sh(lx, ['nc -zv 192.168.1.20 81']).text, /failed: Connection refused/);
  // DNS
  web.dnsd.enabled = true;
  web.dnsd.records = [{ name: 'www.lab', ip: U.parseIp('192.168.1.20') }];
  if (web.dnsd.bind) web.dnsd.bind();
  sh(lx, ['echo "nameserver 192.168.1.20" > /etc/resolv.conf']);
  out = sh(lx, ['nslookup www.lab', 'dig +short www.lab', 'host www.lab']).text;
  assert.match(out, /Name:\twww\.lab\nAddress: 192\.168\.1\.20/);
  assert.match(out, /^192\.168\.1\.20$/m);
  assert.match(out, /www\.lab has address 192\.168\.1\.20/);
  // DHCP с маршрутизатора
  cli(net.findByName('R1'), ['enable', 'conf t', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'exit', 'ip dhcp excluded-address 192.168.1.1 192.168.1.99', 'end']);
  out = sh(lx, ['dhclient -v eth0']).text;
  assert.match(out, /DHCPDISCOVER on eth0/);
  assert.match(out, /bound to 192\.168\.1\.\d+ -- renewal/);
  assert.equal(lx.iface.dhcp, true);
  assert.match(sh(lx, ['ip r']).text, /^default via 192\.168\.1\.1 dev eth0 proto dhcp/m);
});

test('Linux: iptables INPUT/OUTPUT, state ESTABLISHED, REJECT, счётчики, сохранение; диагностика видит iptables', () => {
  const { net, lx, web } = lab();
  const r = net.findByName('R1');
  sh(web, ['iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT', 'iptables -A INPUT -p tcp --dport 80 -j ACCEPT', 'iptables -A INPUT -p icmp --icmp-type echo-request -s 192.168.1.10 -j ACCEPT', 'iptables -P INPUT DROP']);
  let out = sh(web, ['iptables -L INPUT -n --line-numbers']).text;
  assert.match(out, /^Chain INPUT \(policy DROP\)$/m);
  assert.match(out, /^1\s+ACCEPT\s+all\s+--\s+0\.0\.0\.0\/0\s+0\.0\.0\.0\/0\s+state ESTABLISHED,RELATED$/m);
  assert.match(out, /^2\s+ACCEPT\s+tcp\s+--\s+0\.0\.0\.0\/0\s+0\.0\.0\.0\/0\s+tcp dpt:80$/m);
  assert.match(out, /^3\s+ACCEPT\s+icmp\s+--\s+192\.168\.1\.10\s+0\.0\.0\.0\/0\s+icmptype 8$/m);
  assert.match(sh(web, ['iptables -L -v | head -n 1']).text, /Chain INPUT \(policy DROP \d+ packets, \d+ bytes\)/);
  assert.match(sh(web, ['iptables -S']).text, /^-A INPUT -p tcp -m tcp --dport 80 -j ACCEPT$/m);

  assert.match(sh(lx, ['ping -c 2 192.168.1.20']).text, /2 received/, 'ping от LNX разрешён');
  assert.match(sh(r, ['enable', 'ping 192.168.1.20']).text, /Success rate is 0 percent/, 'от маршрутизатора — политика DROP');
  assert.match(sh(lx, ['curl -I http://192.168.1.20/']).text, /200 OK/, 'порт 80 открыт');
  assert.match(sh(web, ['ping -c 1 192.168.1.1']).text, /1 received/, 'ответы на свой ping — ESTABLISHED');
  // REJECT: ICMP port unreachable
  sh(web, ['iptables -I INPUT 1 -p tcp --dport 80 -j REJECT']);
  assert.match(sh(lx, ['curl http://192.168.1.20/']).text, /curl: \(7\)/);
  sh(web, ['iptables -D INPUT 1']);
  assert.equal(web.ipt.INPUT.rules.length, 3);
  // OUTPUT
  sh(lx, ['iptables -A OUTPUT -d 192.168.1.1 -j DROP']);
  assert.match(sh(lx, ['ping -c 1 192.168.1.1']).text, /ping: sendmsg: Operation not permitted/);
  let res = NL.diag.explain(net, lx.id, '192.168.1.1');
  assert.match(res.issues[0].text, /исходящий пакет запрещён iptables/);
  sh(lx, ['iptables -F']);
  assert.match(sh(lx, ['ping -c 1 192.168.1.1']).text, /1 received/);
  res = NL.diag.explain(net, r.id, '192.168.1.20');
  assert.match(res.issues[0].text, /WEB: iptables: входящий пакет icmp .* отброшен в цепочке INPUT по политике DROP/);
  assert.match(res.issues[0].fix, /iptables -L -n --line-numbers/);
  // сохранение
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  const w2 = n2.findByName('WEB');
  assert.equal(w2.os, 'linux');
  assert.equal(w2.ipt.INPUT.policy, 'DROP');
  assert.equal(w2.ipt.INPUT.rules[2].s.net, U.parseIp('192.168.1.10'));
  assert.match(sh(n2.findByName('R1'), ['enable', 'ping 192.168.1.20']).text, /Success rate is 0 percent/);
  // ошибки
  assert.match(sh(web, ['iptables -A INPUT --dport 22 -j ACCEPT']).text, /unknown option "--dport"/);
  assert.match(sh(web, ['iptables -A BOGUS -j ACCEPT']).text, /No chain\/target\/match by that name/);
  assert.match(sh(web, ['iptables -t nat -L']).text, /только filter/);
});

test('Linux: tcpdump с фильтром и -c, Ctrl+C', () => {
  const { net, lx } = lab();
  const lines = [];
  const io = { out: (l) => lines.push(l), write() {}, clear() {}, done() {}, mutate: (fn) => fn() };
  const s = NL.cli.createSession(lx);
  const job = NL.cli.exec(lx, s, 'tcpdump -n -c 2 icmp', io);
  assert.ok(job && !job.done);
  const r = net.findByName('R1');
  cli(r, ['enable', 'ping 192.168.1.10']);
  net.runUntilIdle();
  const text = lines.join('\n');
  assert.match(text, /listening on eth0, link-type EN10MB/);
  assert.match(text, /^\d\d:\d\d:\d\d\.\d{6} IP 192\.168\.1\.1 > 192\.168\.1\.10: ICMP echo request, id \d+, seq \d+, length \d+$/m);
  assert.match(text, /IP 192\.168\.1\.10 > 192\.168\.1\.1: ICMP echo reply/);
  assert.match(text, /^2 packets captured$/m);
  assert.doesNotMatch(text, /ARP/, 'фильтр icmp');
  assert.ok(job.done);

  lines.length = 0;
  const j2 = NL.cli.exec(lx, s, 'tcpdump -n arp or port 80', io);
  cli(lx, ['ip neigh flush all', 'ping -c 1 192.168.1.20']);
  j2.cancel('Ctrl+C');
  const t2 = lines.join('\n');
  assert.match(t2, /ARP, Request who-has 192\.168\.1\.20 tell 192\.168\.1\.10, length 28/);
  assert.match(t2, /\^C\n\d+ packets captured/);
  assert.equal(lx.taps.size, 0);
  assert.match(cli(lx, ['tcpdump port']).text, /syntax error in filter expression/);
  assert.match(cli(lx, ['tcpdump -i eth7']).text, /eth7: No such device exists/);
});
