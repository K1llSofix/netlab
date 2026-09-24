// Сетевой контроллер: REST API (ticket, network-device, host, discovery), обнаружение с проверкой учётных данных CLI.
const test = require('node:test');
const { NL, U, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

const call = (net, dev, method, url, opts) => { let res; dev.httpRequest(method, url, opts || {}, (r) => { res = r; }); net.runUntilIdle(300000); return res; };

test('Network Controller: вход по REST, обнаружение, Managed / Credential mismatch, узлы из ARP', () => {
  const net = mkNet();
  const ctrl = net.addDevice('netctrl', { name: 'NC' });
  const sw = net.addDevice('switch', { name: 'SW' });
  const r1 = net.addDevice('router', { name: 'R1' });
  const r2 = net.addDevice('router', { name: 'R2' });
  const a = pc(net, 'PC', '192.168.1.50/24', '192.168.1.1');
  ctrl.setStatic(U.parseIp('192.168.1.100'), U.maskFromPrefix(24), U.parseIp('192.168.1.1'), null);
  link(net, ctrl, sw); link(net, r1, sw, 0); link(net, r2, sw, 0); link(net, a, sw);
  routerIf(r1, 0, '192.168.1.1/24'); routerIf(r2, 0, '192.168.1.2/24');
  cli(r1, ['enable', 'conf t', 'hostname Edge', 'username netadmin secret C1sco', 'end']);
  cli(r2, ['enable', 'conf t', 'hostname Core', 'username other secret x', 'end']);
  net.runUntilIdle();
  // без токена — 401
  let r = call(net, a, 'GET', 'http://192.168.1.100/api/v1/network-device');
  assert.equal(r.status, 401);
  assert.equal(r.json.response.errorCode, 'RBAC');
  r = call(net, a, 'POST', 'http://192.168.1.100/api/v1/ticket', { headers: { 'Content-Type': 'application/json' }, body: { username: 'admin', password: 'bad' } });
  assert.equal(r.status, 401);
  r = call(net, a, 'POST', 'http://192.168.1.100/api/v1/ticket', { body: { username: 'admin', password: 'cisco123' } });
  assert.equal(r.status, 201);
  const tok = r.json.response.serviceTicket;
  assert.match(tok, /^ST-/);
  // учётные данные CLI и обнаружение через REST
  ctrl.addCredential('netadmin', 'C1sco');
  r = call(net, a, 'POST', 'http://192.168.1.100/api/v1/discovery', { headers: { 'X-Auth-Token': tok }, body: { name: 'LAN', ipAddressList: '192.168.1.1-192.168.1.60' } });
  assert.equal(r.status, 202, r.body);
  net.runUntilIdle(300000);
  r = call(net, a, 'GET', 'http://192.168.1.100/api/v1/network-device', { headers: { 'X-Auth-Token': tok } });
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.json.response.map((d) => [d.hostname, d]));
  assert.equal(byName.Edge.collectionStatus, 'Managed');
  assert.equal(byName.Edge.managementIpAddress, '192.168.1.1');
  assert.equal(byName.Core.collectionStatus, 'Credential mismatch');
  assert.equal(call(net, a, 'GET', 'http://192.168.1.100/api/v1/network-device/count', { headers: { 'X-Auth-Token': tok } }).json.response, 2);
  r = call(net, a, 'GET', 'http://192.168.1.100/api/v1/host', { headers: { 'X-Auth-Token': tok } });
  assert.ok(r.json.response.some((h) => h.hostIp === '192.168.1.50'), JSON.stringify(r.json));
  r = call(net, a, 'GET', 'http://192.168.1.100/api/v1/discovery', { headers: { 'X-Auth-Token': tok } });
  assert.equal(r.json.response[0].status, 'Complete');
  // веб-страница и сохранение настроек
  const page = call(net, a, 'GET', 'http://192.168.1.100/');
  assert.match(page.body, /Edge/);
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(n2.findByName('NC').ctrl.creds[0].user, 'netadmin');
});
