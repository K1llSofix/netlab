// Автоматизация: RESTCONF на маршрутизаторе, программный CLI по SSH (как netmiko), программы на ПК (Python → requests / ConnectHandler / ping).
const test = require('node:test');
const { NL, assert, mkNet, pc, routerIf, link, cli } = require('./helpers');

const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
const IFS = 'https://192.168.1.1/restconf/data/ietf-interfaces:interfaces';

function lab() {
  const net = mkNet();
  const r = net.addDevice('router', { name: 'R1' });
  routerIf(r, 0, '192.168.1.1/24');
  const a = pc(net, 'PC', '192.168.1.10/24', '192.168.1.1');
  link(net, a, r, 0, 0);
  cli(r, ['enable', 'conf t', 'hostname R1', 'ip domain-name lab.local', 'crypto key generate rsa general-keys modulus 1024', 'enable secret class',
    'username admin privilege 15 secret cisco', 'username oper secret op', 'line vty 0 4', 'login local', 'transport input ssh', 'exit',
    'ip http secure-server', 'ip http authentication local', 'restconf', 'end']);
  net.runUntilIdle();
  return { net, r, a };
}

function http(net, dev, method, url, headers, body) {
  let res = null;
  dev.httpRequest(method, url, { headers: headers || {}, body, insecure: true }, (x) => { res = x; });
  net.runUntilIdle();
  assert.ok(res, 'нет ответа на ' + method + ' ' + url);
  return res;
}

test('RESTCONF: интерфейсы (GET/PUT/DELETE), hostname, Basic-авторизация privilege 15, сохранение', () => {
  const { net, r, a } = lab();
  const ok = { Authorization: basic('admin', 'cisco'), Accept: 'application/yang-data+json' };
  let res = http(net, a, 'GET', IFS, ok);
  assert.equal(res.status, 200);
  const list = JSON.parse(res.body)['ietf-interfaces:interfaces'].interface;
  const g0 = list.find((i) => i.name === 'GigabitEthernet0/0');
  assert.equal(g0['ietf-ip:ipv4'].address[0].ip, '192.168.1.1');
  assert.equal(g0.enabled, true);

  assert.equal(http(net, a, 'GET', IFS, { Authorization: basic('admin', 'bad') }).status, 401, 'неверный пароль');
  assert.equal(http(net, a, 'GET', IFS, { Authorization: basic('oper', 'op') }).status, 401, 'нужен privilege 15');
  assert.equal(http(net, a, 'GET', IFS).status, 401, 'без авторизации');

  const lo = { 'ietf-interfaces:interface': { name: 'Loopback1', description: 'from restconf', enabled: true, 'ietf-ip:ipv4': { address: [{ ip: '1.1.1.1', netmask: '255.255.255.255' }] } } };
  assert.equal(http(net, a, 'PUT', IFS + '/interface=Loopback1', Object.assign({ 'Content-Type': 'application/yang-data+json' }, ok), JSON.stringify(lo)).status, 201);
  let run = cli(r, ['enable', 'class', 'show running-config']).text;
  assert.match(run, /interface Loopback1\n description from restconf\n ip address 1\.1\.1\.1 255\.255\.255\.255/);
  assert.equal(http(net, a, 'PUT', IFS + '/interface=Loopback1', ok, JSON.stringify(lo)).status, 204, 'повторный PUT — замена');
  res = http(net, a, 'GET', IFS + '/interface=Loopback1', ok);
  assert.equal(JSON.parse(res.body)['ietf-interfaces:interface'].type, 'iana-if-type:softwareLoopback');
  assert.equal(http(net, a, 'DELETE', IFS + '/interface=GigabitEthernet0%2F0', ok).status, 400, 'физический интерфейс не удаляется');
  assert.equal(http(net, a, 'DELETE', IFS + '/interface=Loopback1', ok).status, 204);
  assert.equal(r.ifaceByName('Loopback1'), null);
  assert.equal(http(net, a, 'GET', IFS + '/interface=Loopback9', ok).status, 404);
  assert.equal(http(net, a, 'POST', IFS, ok, '{}').status, 405);
  assert.equal(http(net, a, 'PUT', IFS + '/interface=Loopback2', ok, 'не json').status, 400);

  const HN = 'https://192.168.1.1/restconf/data/Cisco-IOS-XE-native:native/hostname';
  assert.equal(http(net, a, 'PUT', HN, ok, JSON.stringify({ 'Cisco-IOS-XE-native:hostname': 'EDGE' })).status, 204);
  assert.equal(r.ios.hostname, 'EDGE');
  assert.equal(JSON.parse(http(net, a, 'GET', HN, ok).body)['Cisco-IOS-XE-native:hostname'], 'EDGE');
  assert.equal(http(net, a, 'GET', 'https://192.168.1.1/restconf', ok).status, 200);

  // HTTP (порт 80) выключен, show ip http server status, running-config
  assert.equal(http(net, a, 'GET', 'http://192.168.1.1/restconf', ok).ok, false);
  const st = cli(r, ['enable', 'class', 'show ip http server status']).text;
  assert.match(st, /HTTP server status: Disabled/);
  assert.match(st, /HTTP secure server status: Enabled/);
  assert.match(st, /RESTCONF: enabled/);
  run = cli(r, ['enable', 'class', 'show running-config']).text;
  assert.match(run, /^ip http authentication local\nip http secure-server\nrestconf$/m);

  // сохранение и загрузка
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  n2.runUntilIdle();
  assert.equal(http(n2, n2.findByName('PC'), 'GET', IFS, ok).status, 200);
  cli(n2.findByName('R1'), ['enable', 'class', 'conf t', 'no restconf', 'end']);
  assert.equal(http(n2, n2.findByName('PC'), 'GET', IFS, ok).status, 404, 'restconf выключен');
});

test('Программный CLI по SSH (как netmiko): вход, enable с secret, команды, конфигурация, ошибки', () => {
  const { net, r, a } = lab();
  const got = {};
  a.cliConnect({ host: '192.168.1.1', proto: 'ssh', username: 'oper', password: 'op', secret: 'class' }, (e, c) => {
    assert.ifError(e);
    got.prompt1 = c.prompt;
    c.send('show ip interface brief', (e2, t) => {
      got.brief = t;
      c.config(['interface loopback 5', 'ip address 5.5.5.5 255.255.255.255'], (e3, t3) => {
        assert.ifError(e3);
        got.cfg = t3;
        got.prompt2 = c.prompt;
        c.close();
      });
    });
  });
  net.runUntilIdle();
  assert.equal(got.prompt1, 'R1>');
  assert.match(got.brief, /GigabitEthernet0\/0\s+192\.168\.1\.1/);
  assert.match(got.cfg, /R1\(config\)#interface loopback 5/);
  assert.equal(got.prompt2, 'R1#');
  assert.ok(r.ifaceByName('Loopback5'));

  let err = null;
  a.cliConnect({ host: '192.168.1.1', proto: 'ssh', username: 'admin', password: 'wrong' }, (e) => { err = e; });
  net.runUntilIdle();
  assert.match(String(err && err.message), /Authentication failed|отказ|denied/i);

  // без secret enable не пройти
  const r3 = {};
  a.cliConnect({ host: '192.168.1.1', proto: 'ssh', username: 'oper', password: 'op' }, (e, c) => { c.enable((e2) => { r3.err = e2; c.close(); }); });
  net.runUntilIdle();
  assert.match(String(r3.err && r3.err.message), /secret/);

  // privilege 15 — сразу в привилегированном режиме; запросы программ через NS.automation.handle
  const A = NL.automation;
  const out = {};
  A.handle(a, 'ssh.connect', { host: '192.168.1.1', proto: 'ssh', username: 'admin', password: 'cisco' }, (e, s) => {
    assert.ifError(e);
    out.prompt = s.prompt;
    A.handle(a, 'ssh.send', { sid: s.sid, cmd: 'show running-config | include hostname' }, (e2, t) => {
      out.run = t;
      A.handle(a, 'ssh.close', { sid: s.sid }, () => { out.closed = true; });
    });
  });
  A.handle(a, 'ping', { host: '192.168.1.1', count: 2 }, (e, p) => { out.ping = p; });
  A.handle(a, 'nope', {}, (e) => { out.bad = e; });
  net.runUntilIdle();
  assert.equal(out.prompt, 'R1#');
  assert.match(out.run, /^hostname R1$/m);
  assert.ok(out.closed);
  assert.deepEqual(out.ping, { sent: 2, received: 2 });
  assert.match(out.bad.message, /Неизвестный запрос/);
});

test('Программа на Python с ПК: requests (RESTCONF), ConnectHandler, ping, включения списков; сохранение программы', async () => {
  const { net, r, a } = lab();
  const RT = NL.scriptRt;
  const py = [
    'import requests',
    'import json',
    'from netmiko import ConnectHandler',
    '',
    'url = "https://192.168.1.1/restconf/data/ietf-interfaces:interfaces"',
    'auth = ("admin", "cisco")',
    'try:',
    '    requests.get(url, auth=auth)',
    'except Exception as e:',
    '    print("strict", "SSLError" in str(e))',
    'r = requests.get(url, headers={"Accept": "application/yang-data+json"}, auth=auth, verify=False)',
    'print("status", r.status_code)',
    'names = [i["name"] for i in r.json()["ietf-interfaces:interfaces"]["interface"] if i["enabled"]]',
    'print("up", len(names), names[0])',
    'body = {"ietf-interfaces:interface": {"name": "Loopback7", "enabled": True, "ietf-ip:ipv4": {"address": [{"ip": "7.7.7.7", "netmask": "255.255.255.255"}]}}}',
    'r = requests.put(url + "/interface=Loopback7", json=body, auth=auth, verify=False)',
    'print("put", r.status_code, "создан" if r.status_code == 201 else "обновлён")',
    'bad = requests.get(url, auth=("admin", "x"), verify=False)',
    'print("bad", bad.status_code, bad.ok)',
    '',
    'def show(conn, cmd="show ip interface brief"):',
    '    return conn.send_command(cmd)',
    '',
    'c = ConnectHandler(device_type="cisco_ios", host="192.168.1.1", username="oper", password="op", secret="class")',
    'print("prompt", c.find_prompt())',
    'print("lo7", "Loopback7" in show(c))',
    'c.enable()',
    'c.send_config_set(["interface loopback 8", "ip address 8.8.8.8 255.255.255.255"])',
    'print("hn", show(c, cmd="show running-config | include hostname"))',
    'c.disconnect()',
    'p = ping("192.168.1.1")',
    'print("ping", p["ok"], p["received"])',
    'print(json.dumps({"k": 1}))',
  ].join('\n');
  const logs = [];
  const io = {
    read: () => 0, write() {}, log: (t) => logs.push(t), error: (t) => logs.push('ERR ' + t),
    request: (kind, args) => new Promise((res, rej) => {
      NL.automation.handle(a, kind, args, (e, x) => (e ? rej(e) : res(x)));
      net.runUntilIdle();
    }),
  };
  await new Promise((done) => { io.done = done; RT.run(py, io, 'python'); });
  const text = logs.join('\n');
  assert.doesNotMatch(text, /ERR/, text);
  assert.match(text, /^strict true$/m, 'самоподписанный сертификат без verify=False — SSLError');
  assert.match(text, /^status 200$/m);
  assert.match(text, /^up 3 GigabitEthernet0\/0$/m);
  assert.match(text, /^put 201 создан$/m);
  assert.match(text, /^bad 401 false$/m);
  assert.match(text, /^prompt R1>$/m);
  assert.match(text, /^lo7 true$/m);
  assert.match(text, /^hn hostname R1$/m);
  assert.match(text, /^ping true 2$/m);
  assert.match(text, /^\{"k":1\}$/m);
  assert.ok(r.ifaceByName('Loopback7') && r.ifaceByName('Loopback8'));

  // сетевые вызовы получают await, в том числе в JavaScript
  assert.match(RT.transform('const x = requests.get("u"); const c = ConnectHandler({host: "h"}); c.send_command("x");'), /await requests\.get\(.*await ConnectHandler\(.*await c\.send_command\(/s);

  // программа ПК сохраняется в схеме
  NL.automation.setProgram(a, { lang: 'python', code: py });
  const n2 = NL.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
  assert.equal(n2.findByName('PC').pcProg.code, py);
  assert.equal(NL.automation.program(n2.findByName('R1') || {}).lang, 'python');
});

test('Фильтры вывода IOS: | include, exclude, begin, section, count; do show … | include', () => {
  const { r } = lab();
  const q = (cmds) => cli(r, ['enable', 'class'].concat(cmds)).text.split('\n').filter((l) => !/^(R1[>#(]|Password:|Enter configuration)/.test(l) && l !== '');
  assert.deepEqual(q(['show running-config | include ^interface']), ['interface GigabitEthernet0/0', 'interface GigabitEthernet0/1', 'interface GigabitEthernet0/2']);
  assert.deepEqual(q(['show running-config | section vty']), ['line vty 0 4', ' login local', ' transport input ssh']);
  assert.deepEqual(q(['show running-config | count ^username']), ['Number of lines which match regexp = 2']);
  const brief = q(['show ip interface brief | exclude unassigned']);
  assert.equal(brief.length, 2);
  assert.match(brief[1], /^GigabitEthernet0\/0\s+192\.168\.1\.1/);
  assert.equal(q(['show running-config | begin ^line vty'])[0], 'line vty 0 4');
  assert.deepEqual(q(['conf t', 'do show running-config | i hostname']), ['hostname R1']);
  // «|» в других командах не трогается
  cli(r, ['enable', 'class', 'conf t', 'banner motd |Только для персонала|', 'end']);
  assert.match(r.ios.banner, /Только для персонала/);
});
