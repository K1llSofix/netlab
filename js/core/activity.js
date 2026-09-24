/* NetLab — задания (как Activity Wizard в Packet Tracer): схема-ответ, инструкции, пункты оценки,
 * проверки связи, таймер и процент выполнения. Задание хранится в файле схемы (ключ task, в сети — net.task):
 * открытая часть (название, инструкции, таймер, режим показа результатов) и закрытая (ответ,
 * начальная схема, пункты оценки, проверки связи) — закодирована, чтобы ответ не читался из файла глазами.
 *
 * Пункты оценки строятся сравнением схемы-ответа с «чистыми» устройствами тех же моделей:
 *  • устройства (имя и модель) и соединения между портами;
 *  • строки running-config маршрутизаторов, коммутаторов и ASA (с учётом раздела: interface …, router …);
 *  • состояние портов (включён / выключен);
 *  • настройки остальных устройств (адреса ПК и серверов, службы, Wi-Fi…) — по полям конфигурации. */
(function (NS) {
  'use strict';

  const VERSION = 1;

  /* ================= кодирование закрытой части ================= */

  const KEY = 'NetLab-activity';
  const b64enc = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); };
  const b64dec = (str) => { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
  function xor(bytes) {
    const k = new TextEncoder().encode(KEY);
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ k[i % k.length] ^ (i * 31 & 0xff);
    return out;
  }
  const encode = (obj) => 'nla1:' + b64enc(xor(new TextEncoder().encode(JSON.stringify(obj))));
  function decode(str) {
    if (typeof str !== 'string' || !str.startsWith('nla1:')) return null;
    try { return JSON.parse(new TextDecoder().decode(xor(b64dec(str.slice(5))))); } catch (e) { return null; }
  }

  /** Простой хэш пароля мастера (защита от случайного открытия, не криптостойкая). */
  function passHash(p) {
    let h = 0x811c9dc5;
    const s = 'nla|' + String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }

  /* ================= факты о схеме ================= */

  const SKIP_KEYS = new Set(['inbox', 'outbox', 'emailBox', 'leases', 'msgs', 'dhcpBound', 'boxes', 'll', 'mac', 'since', 'log', 'history', 'heard', 'stats', 'x', 'y']);
  const SKIP_LINES = /^(!|end|version |Building configuration|Current configuration|no service timestamps|\s*no ip address$|\s*no ipv6 address$)/;
  const LABEL = { ifaces: 'Интерфейсы', ip: 'IP-адрес', mask: 'маска', gateway: 'шлюз', dns: 'DNS-сервер', dhcp: 'DHCP', ssid: 'SSID', security: 'защита', key: 'ключ', desc: 'описание',
    dhcpd: 'DHCP-сервер', dnsd: 'DNS-сервер', httpd: 'HTTP', maild: 'почта', tftpd: 'TFTP', iotd: 'IoT-сервер', wifi: 'Wi-Fi', enabled: 'включено', records: 'записи', pools: 'пулы', users: 'пользователи',
    v6: 'IPv6', addrs: 'адреса', firewall: 'брандмауэр', rules: 'правила', email: 'почта (клиент)', thing: 'устройство IoT', state: 'состояние', iot: 'IoT', phone: 'телефон' };
  const lbl = (k) => LABEL[k] || k;
  const stable = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}') : JSON.stringify(v));
  const short = (v) => { const s = typeof v === 'string' ? v : stable(v); return s.length > 80 ? s.slice(0, 77) + '…' : s; };
  const isIos = (d) => (!!d.ios || d.type === 'asa') && NS.cli && typeof NS.cli.runningConfig === 'function';

  /** Поля конфигурации устройства без CLI → факты. Массивы объектов с именем — по имени, остальные элементы — по содержимому. */
  function flatten(obj, path, add) {
    if (obj == null) return;
    if (Array.isArray(obj)) {
      for (const el of obj) {
        const id = el && typeof el === 'object' && !Array.isArray(el) ? (el.name != null ? el.name : el.user != null ? el.user : null) : null;
        if (id != null && typeof id !== 'object') { flatten(el, path.concat(String(id)), add); continue; }
        if (Array.isArray(el) && el.length === 2 && typeof el[0] === 'string') { add(path.concat(el[0]), el[1], false); continue; } // [имя файла, содержимое]
        add(path.concat('•'), el, true);
      }
      return;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) if (!SKIP_KEYS.has(k)) flatten(v, path.concat(k), add);
      return;
    }
    add(path, obj, false);
  }

  function deviceFacts(dev, out) {
    const name = dev.name;
    const put = (f) => { out.set(f.key, f); };
    put({ key: 'dev|' + name, path: [name], label: 'устройство (модель ' + dev.model + ')', value: dev.model, kind: 'dev' });
    if (isIos(dev)) {
      let parent = null;
      let lines = [];
      try { lines = NS.cli.runningConfig(dev); } catch (e) { lines = []; }
      for (const raw of lines) {
        const line = String(raw).replace(/\s+$/, '');
        if (!line.trim() || SKIP_LINES.test(line)) { if (/^!/.test(line)) parent = null; continue; }
        if (!/^\s/.test(line)) parent = line;
        const child = /^\s/.test(line);
        const sect = child ? parent : line;
        put({ key: 'cfg|' + name + '|' + (child ? sect : '') + '|' + line.trim(), path: [name, 'Конфигурация', sect || 'глобальные'], label: child ? line.trim() : line, value: true, kind: 'cfg' });
      }
    } else {
      let cfg = {};
      try { cfg = dev.serializeConfig(); } catch (e) { cfg = {}; }
      flatten(cfg, [], (p, v, presence) => {
        if (!p.length) return;
        const key = 'set|' + name + '|' + p.join('/') + (presence ? '|' + stable(v) : '');
        const where = [name, 'Настройки'].concat(p.slice(0, -1).map(lbl));
        const label = presence ? lbl(p[p.length - 2] || 'элемент') + ': ' + short(v) : lbl(p[p.length - 1]) + ' = ' + short(v);
        put({ key, path: where, label, value: presence ? true : stable(v), kind: 'set' });
      });
    }
    dev.ports.forEach((p) => {
      if (p.adminUp === undefined) return;
      put({ key: 'port|' + name + '|' + p.name, path: [name, 'Порты'], label: p.name + ': ' + (p.adminUp ? 'включён' : 'выключен (shutdown)'), value: !!p.adminUp, kind: 'port' });
    });
  }

  /** Все факты о схеме: Map ключ → { key, path, label, value, kind }. */
  function facts(net) {
    const out = new Map();
    for (const d of net.devices.values()) deviceFacts(d, out);
    for (const l of net.links.values()) {
      if (l.wireless) continue;
      const a = net.devices.get(l.a.dev);
      const b = net.devices.get(l.b.dev);
      if (!a || !b) continue;
      const ends = [a.name + ' ' + a.ports[l.a.port].name, b.name + ' ' + b.ports[l.b.port].name].sort();
      out.set('link|' + ends.join('|'), { key: 'link|' + ends.join('|'), path: ['Соединения'], label: ends.join(' — ') + ' (' + l.cable + ')', value: l.cable, kind: 'link' });
    }
    return out;
  }

  /** Факты «чистого» устройства той же модели с теми же модулями — то, что есть без всякой настройки. */
  function baselineFacts(dev) {
    const out = new Map();
    try {
      const tmp = new NS.Network();
      const b = tmp.addDevice(dev.type, { name: dev.name, model: dev.model });
      const diff = (dev.slots || []).filter((s) => { const bs = b.slots.find((x) => x.id === s.id); return bs && bs.module !== s.module; });
      if (diff.length) {
        tmp.setPower(b, false); // модули меняются только при выключенном питании
        for (const s of diff) { try { tmp.setModule(b, s.id, s.module); } catch (e) { /* модуль не подходит — пропускаем */ } }
        tmp.setPower(b, true);
      }
      tmp.runUntilIdle(50);
      deviceFacts(b, out);
    } catch (e) { /* нет эталона — считаем всё настройкой */ }
    return out;
  }

  /** Пункты, которые можно проверять: факты схемы-ответа, отличающиеся от заводских. */
  function candidates(answerNet) {
    const all = facts(answerNet);
    const base = new Map();
    for (const d of answerNet.devices.values()) for (const [k, f] of baselineFacts(d)) base.set(k, f);
    const list = [];
    for (const f of all.values()) {
      const b = base.get(f.key);
      if (f.kind !== 'dev' && f.kind !== 'link' && b && stable(b.value) === stable(f.value)) continue;
      list.push(f);
    }
    return list;
  }

  /* ================= проверка ================= */

  /** Прогнать проверки связи на копии схемы (сама схема ученика не меняется). */
  function runTests(net, tests) {
    if (!tests || !tests.length) return [];
    const mu = NS.multiuser;
    const saved = mu ? mu.transport : null;
    if (mu) mu.transport = null; // копия не должна отправлять кадры в другие копии NetLab
    try {
      const copy = NS.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
      copy.runUntilIdle(6000);
      return tests.map((t) => {
        const dev = copy.findByName(t.from);
        if (!dev || typeof dev.ping !== 'function') return Object.assign({}, t, { ok: false, got: null, why: 'нет устройства ' + t.from });
        let done = null;
        try { dev.ping(String(t.to), { count: 2, onEvent: (e) => { if (e.type === 'done') done = e; } }); } catch (e) { return Object.assign({}, t, { ok: false, got: null, why: e.message }); }
        copy.runUntilIdle(20000);
        const reached = !!(done && done.received > 0);
        return Object.assign({}, t, { reached, ok: reached === (t.expect !== false), got: reached });
      });
    } finally {
      if (mu) mu.transport = saved;
    }
  }

  /** Проверить схему ученика по заданию. Возвращает { percent, got, total, items, tests }. */
  function check(net, act) {
    const sec = open(act);
    if (!sec) throw new Error('Задание повреждено или создано другой версией NetLab');
    const have = facts(net);
    let got = 0;
    let total = 0;
    const items = sec.items.map((it) => {
      const f = have.get(it.key);
      const ok = !!f && stable(f.value) === stable(it.value);
      const pts = Number(it.points) || 0;
      total += pts;
      if (ok) got += pts;
      return { key: it.key, path: it.path, label: it.label, points: pts, ok, actual: f ? f.label : null };
    });
    const tests = runTests(net, sec.tests);
    for (const t of tests) { const pts = Number(t.points) || 0; total += pts; if (t.ok) got += pts; }
    return { percent: total ? Math.floor((got / total) * 1000) / 10 : 0, got, total, items, tests };
  }

  /* ================= задание ================= */

  /** Закрытая часть задания: { answer, initial, items, tests }. */
  function open(act) {
    if (!act) return null;
    const s = decode(act.secret);
    if (!s) return null;
    return { answer: s.answer || null, initial: s.initial || null, items: Array.isArray(s.items) ? s.items : [], tests: Array.isArray(s.tests) ? s.tests : [] };
  }

  /** Собрать задание из черновика мастера. */
  function build(d) {
    const items = (d.items || []).map((it) => ({ key: String(it.key), path: (it.path || []).map(String), label: String(it.label || ''), value: it.value, points: Math.max(0, Math.min(100, Number(it.points) || 0)) }));
    const tests = (d.tests || []).filter((t) => t && t.from && t.to).map((t) => ({ from: String(t.from), to: String(t.to), expect: t.expect !== false, points: Math.max(0, Math.min(100, Number(t.points) || 0)) }));
    return {
      v: VERSION,
      title: String(d.title || 'Задание').slice(0, 120),
      instructions: String(d.instructions || '').slice(0, 20000),
      timer: Math.max(0, Math.min(600, Math.round(Number(d.timer) || 0))),
      feedback: ['full', 'score', 'none'].includes(d.feedback) ? d.feedback : 'full',
      lock: d.lock ? String(d.lock) : '',
      secret: encode({ answer: d.answer || null, initial: d.initial || null, items, tests }),
    };
  }

  /** Черновик мастера из задания (для правки). */
  function draft(act) {
    const s = open(act) || { answer: null, initial: null, items: [], tests: [] };
    return { title: act ? act.title : 'Задание', instructions: act ? act.instructions : '', timer: act ? act.timer : 0, feedback: act ? act.feedback : 'full', lock: act ? act.lock : '',
      answer: s.answer, initial: s.initial, items: s.items.map((x) => Object.assign({}, x)), tests: s.tests.map((x) => Object.assign({}, x)) };
  }

  /** Снимок схемы без самого задания (ответ и начальная схема не должны содержать вложенных заданий). */
  function snapshot(net) {
    const d = net.serialize();
    delete d.task;
    return d;
  }

  NS.netExt.push({
    key: 'task',
    init(net) { net.task = null; },
    save(net) { return net.task ? Object.assign({}, net.task) : null; },
    load(net, d) {
      net.task = d && typeof d === 'object' && d.v === VERSION && typeof d.secret === 'string'
        ? { v: VERSION, title: String(d.title || 'Задание'), instructions: String(d.instructions || ''), timer: Number(d.timer) || 0, feedback: ['full', 'score', 'none'].includes(d.feedback) ? d.feedback : 'full', lock: String(d.lock || ''), secret: d.secret }
        : null;
    },
  });

  NS.activity = { facts, candidates, check, runTests, build, draft, open, snapshot, encode, decode, passHash, VERSION };
})(globalThis.NetLab = globalThis.NetLab || {});
