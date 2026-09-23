// Общие помощники для тестов NetLab.
const assert = require('node:assert/strict');
const NL = require('./load');

const U = NL.util;
const ip = (s) => U.parseIp(s);
const pfx = (n) => U.maskFromPrefix(n);

function mkNet() { return new NL.Network(); }

function host(net, type, name, cidr, gw, dns) {
  const d = net.addDevice(type, { name });
  if (cidr) {
    const [a, p] = cidr.split('/');
    d.setStatic(ip(a), pfx(Number(p)), gw ? ip(gw) : null, dns ? ip(dns) : null);
  }
  return d;
}
const pc = (net, name, cidr, gw, dns) => host(net, 'pc', name, cidr, gw, dns);

function routerIf(r, idx, cidr) {
  const [a, p] = cidr.split('/');
  r.setIfaceIp(r.ifaces[idx], ip(a), pfx(Number(p)));
}

function ifIp(dev, name, cidr) {
  const [a, p] = cidr.split('/');
  dev.setIfaceIp(dev.ifaceByName(name), ip(a), pfx(Number(p)));
}

function link(net, a, b, pa, pb, cable) {
  return net.connect(a.id, pa === undefined ? 'auto' : pa, b.id, pb === undefined ? 'auto' : pb, cable);
}

function ping(net, dev, target, opts) {
  const events = [];
  let done = null;
  dev.ping(target, Object.assign({}, opts, { onEvent: (e) => { events.push(e); if (e.type === 'done') done = e; } }));
  net.runUntilIdle(200000);
  assert.ok(done, 'ping должен завершиться');
  return { events, done, replies: events.filter((e) => e.type === 'reply') };
}

/** Выполнить команды CLI; возвращает весь вывод. session можно передать, чтобы продолжить. */
function cli(dev, lines, session) {
  const s = session || NL.cli.createSession(dev);
  const out = [];
  const io = { out: (l) => out.push(l), write: (t) => out.push(t), mutate: (fn) => fn(), done: () => {}, clear: () => {} };
  for (const l of lines) {
    NL.cli.exec(dev, s, l, io);
    dev.net.runUntilIdle(200000);
  }
  return { text: out.join('\n'), session: s, out };
}

/** Асинхронный вызов с колбэком → результат после прогона сети. */
function run(net, fn) {
  let res;
  fn((r) => { res = r; });
  net.runUntilIdle(200000);
  return res;
}

module.exports = { NL, U, ip, pfx, mkNet, host, pc, routerIf, ifIp, link, ping, cli, run, assert };
