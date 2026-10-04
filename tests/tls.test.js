// HTTPS: рукопожатие TLS, проверка сертификата (издатель, имя, срок), клиенты (браузер, curl, wget), журнал симуляции.
const test = require('node:test');
const { NL, assert, mkNet, pc, link, cli } = require('./helpers');

const U = NL.util;

function lab() {
  const net = mkNet();
  const sw = net.addDevice('switch', { name: 'SW' });
  const a = pc(net, 'PC', '192.168.1.10/24', null, '192.168.1.20');
  const srv = net.addDevice('server', { name: 'WEB' });
  srv.setStatic(U.parseIp('192.168.1.20'), U.maskFromPrefix(24), null, null);
  link(net, a, sw, 0, 0);
  link(net, srv, sw, 0, 1);
  srv.dnsd.enabled = true;
  srv.dnsd.records = [{ name: 'www.lab', ip: U.parseIp('192.168.1.20') }, { name: 'shop.lab', ip: U.parseIp('192.168.1.20') }];
  if (srv.dnsd.bind) srv.dnsd.bind();
  net.runUntilIdle();
  return { net, a, srv };
}

function get(net, dev, url, opts) {
  let r = null;
  dev.httpGet(url, (x) => { r = x; }, opts);
  net.runUntilIdle();
  return r;
}

test('HTTPS: самоподписанный сертификат, доверенный, чужое имя, просрочен; небезопасный режим; HTTP не затронут', () => {
  const { net, a, srv } = lab();
  let r = get(net, a, 'https://192.168.1.20/');
  assert.equal(r.ok, false);
  assert.equal(r.cert.code, 'self-signed');
  assert.match(r.error, /выдан самому себе/);
  assert.match(r.url, /^https:\/\//);
  r = get(net, a, 'https://192.168.1.20/', { insecure: true });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.tls.version, 'TLS 1.3');
  assert.equal(r.tls.problem.code, 'self-signed');
  assert.equal(get(net, a, 'http://192.168.1.20/').ok, true, 'HTTP на 80 без TLS');

  NL.tls.setCert(srv, { cn: 'www.lab', san: ['www.lab', '*.lab'], issuer: NL.tls.TRUSTED });
  r = get(net, a, 'https://www.lab/');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tls.problem, null);
  assert.equal(get(net, a, 'https://shop.lab/').ok, true, 'подстановочное имя *.lab');
  r = get(net, a, 'https://192.168.1.20/');
  assert.equal(r.cert.code, 'hostname');
  NL.tls.setCert(srv, { cn: 'www.lab', san: [], issuer: NL.tls.TRUSTED, expired: true });
  assert.equal(get(net, a, 'https://www.lab/').cert.code, 'expired');

  // HTTP на порт 443 — сервер закрывает соединение
  assert.equal(get(net, a, 'http://192.168.1.20:443/').ok, false);
  // сохранение сертификата
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.deepEqual(n2.findByName('WEB').tlsCert, { cn: 'www.lab', san: [], issuer: 'NetLab Root CA', expired: true });
});

test('HTTPS: этапы рукопожатия в журнале симуляции; curl и wget на Linux', () => {
  const { net, a, srv } = lab();
  net.recording = true;
  get(net, a, 'https://192.168.1.20/', { insecure: true });
  const sums = net.log.filter((e) => e.type === 'tx' && e.frame).map((e) => NL.packets.summary(e.frame));
  const i1 = sums.findIndex((x) => /^TLS ClientHello: .*\(SNI\) 192\.168\.1\.20/.test(x));
  const i2 = sums.findIndex((x) => /^TLS ServerHello \+ Certificate: CN=web, самоподписанный/.test(x));
  const i3 = sums.findIndex((x) => /^TLS Finished/.test(x));
  const i4 = sums.findIndex((x) => /^HTTPS: данные зашифрованы TLS/.test(x));
  assert.ok(i1 >= 0 && i1 < i2 && i2 < i3 && i3 < i4, sums.join('\n'));
  net.log = [];
  get(net, a, 'https://192.168.1.20/');
  assert.ok(net.log.some((e) => e.type === 'tx' && e.frame && /^TLS Alert: bad_certificate/.test(NL.packets.summary(e.frame))));
  net.recording = false;

  NL.linux.setOs(a, 'linux');
  let out = cli(a, ['curl https://192.168.1.20/']).text;
  assert.match(out, /curl: \(60\) SSL certificate problem: self-signed certificate/);
  out = cli(a, ['curl -k -v https://192.168.1.20/ | head -n 3']).text;
  assert.match(out, /SSL connection using TLS 1\.3 \/ TLS_AES_128_GCM_SHA256/);
  assert.match(cli(a, ['curl -sk https://192.168.1.20/']).text, /<html|<h|NetLab|Cisco/i);
  out = cli(a, ['wget https://192.168.1.20/']).text;
  assert.match(out, /ERROR: cannot verify 192\.168\.1\.20's certificate, issued by ‘CN=web’:\n  Self-signed certificate encountered\./);
  assert.match(cli(a, ['wget --no-check-certificate https://192.168.1.20/']).text, /saved \[\d+\/\d+\]/);
  NL.tls.setCert(srv, { cn: 'www.lab', san: ['www.lab'], issuer: NL.tls.TRUSTED });
  assert.match(cli(a, ['curl -I https://www.lab/']).text, /^HTTP\/1\.1 200 OK$/m);
});
