// IOx: app-hosting на маршрутизаторе, IOx Local Manager и IoX IDE, веб-приложение на гостевом адресе.
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli, ping, run } = require('./helpers');

test('IOx: IoX IDE загружает пакет, приложение отвечает по HTTP на гостевом адресе', () => {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  const sw = net.addDevice('switch', { name: 'SW' });
  routerIf(r, 0, '10.0.0.1/24');
  link(net, r, sw, 0);
  const dev = pc(net, 'Dev', '10.0.0.10/24', '10.0.0.1');
  link(net, dev, sw);
  const lm = (msg, user, pass) => run(net, (cb) => dev.ioxRequest('10.0.0.1', user || 'admin', pass || 'cisco', msg, cb));

  // IOx выключен
  assert.match(lm({ ioxm: 'LIST' }).error, /IOx не включён/);
  cli(r, ['enable', 'conf t', 'username admin privilege 15 secret cisco', 'username user password 123', 'iox',
    'interface VirtualPortGroup0', 'ip address 192.168.10.1 255.255.255.0', 'exit',
    'app-hosting appid web', 'app-vnic gateway0 virtualportgroup 0 guest-interface 0', 'guest-ipaddress 192.168.10.2 netmask 255.255.255.0',
    'app-default-gateway 192.168.10.1 guest-interface 0', 'end']);
  assert.match(lm({ ioxm: 'LIST' }, 'admin', 'bad').error, /Неверное/);
  assert.match(lm({ ioxm: 'LIST' }, 'user', '123').error, /privilege 15/);

  const manifest = NL.iox.parseYaml('# IOx\nname: hello\nversion: "1.2"\nport: 8000\n');
  assert.equal(manifest.port, '8000');
  assert.match(lm({ ioxm: 'DEPLOY', appid: 'web', manifest, files: { 'about.html': 'x' } }).error, /index\.html/);
  assert.ok(lm({ ioxm: 'DEPLOY', appid: 'web', manifest, files: { 'index.html': '<h1>Привет из IOx</h1>' } }).ok);
  let out = cli(r, ['enable', 'show app-hosting list']).text;
  assert.match(out, /web\s+DEPLOYED/);
  assert.ok(lm({ ioxm: 'ACTION', appid: 'web', action: 'start' }).ok);
  out = cli(r, ['enable', 'show app-hosting list', 'show app-hosting detail appid web', 'show running-config']).text;
  assert.match(out, /web\s+RUNNING/);
  assert.match(out, /IPv4 address: 192\.168\.10\.2/);
  assert.match(out, /^iox$/m);
  assert.match(out, /^  guest-ipaddress 192\.168\.10\.2 netmask 255\.255\.255\.0$/m);
  assert.doesNotMatch(out, /interface IOx:/);

  const page = run(net, (cb) => dev.httpGet('http://192.168.10.2:8000', cb));
  assert.ok(page.ok, JSON.stringify(page));
  assert.match(page.body, /Привет из IOx/);
  assert.equal(page.url, 'http://192.168.10.2:8000/index.html');
  assert.equal(ping(net, dev, '192.168.10.2', { count: 1 }).replies.length, 1);
  // на адресе самого маршрутизатора приложения нет
  assert.equal(run(net, (cb) => dev.httpGet('http://10.0.0.1:8000', cb)).ok, false);

  // жизненный цикл из CLI
  out = cli(r, ['enable', 'app-hosting uninstall appid web']).text;
  assert.match(out, /остановите/);
  cli(r, ['enable', 'app-hosting stop appid web']);
  assert.equal(run(net, (cb) => dev.httpGet('http://192.168.10.2:8000', cb)).ok, false);
  out = cli(r, ['enable', 'app-hosting start appid web', 'show app-hosting list']).text;
  assert.match(out, /web\s+RUNNING/);

  // без start в конфигурации после перезагрузки приложение не запускается; со start — запускается
  let n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(n2.findByName('R1').iox.apps.web.state, 'ACTIVATED');
  cli(r, ['enable', 'conf t', 'app-hosting appid web', 'start', 'end']);
  n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(n2.findByName('R1').iox.apps.web.state, 'RUNNING');
  const p2 = run(n2, (cb) => n2.findByName('Dev').httpGet('http://192.168.10.2:8000', cb));
  assert.ok(p2.ok, JSON.stringify(p2));

  // гостевой адрес вне сети VirtualPortGroup — ошибка активации
  cli(r, ['enable', 'app-hosting stop appid web', 'conf t', 'app-hosting appid web', 'no start', 'guest-ipaddress 172.16.0.2 netmask 255.255.255.0', 'end']);
  out = cli(r, ['enable', 'app-hosting deactivate appid web', 'app-hosting activate appid web']).text;
  assert.match(out, /должен быть в сети 192\.168\.10\.0\/24/);
});
