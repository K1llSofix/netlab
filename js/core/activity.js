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

  /* ================= переменные задания ================= */

  const VAR_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
  const LOCKS = ['add', 'remove', 'cables', 'rename', 'cli', 'config', 'physical', 'sim', 'diag'];

  /** Подставить значения переменных вместо {{ИМЯ}}. */
  function subst(v, values) {
    if (typeof v !== 'string' || !values) return v;
    return v.replace(VAR_RE, (m, n) => (values[n] != null ? String(values[n]) : m));
  }

  function normVar(v) {
    const name = String((v && v.name) || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name)) return null;
    if (v.kind === 'list') {
      const list = (Array.isArray(v.list) ? v.list : String(v.list || '').split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
      return list.length ? { name, kind: 'list', list } : null;
    }
    let min = Math.round(Number(v.min));
    let max = Math.round(Number(v.max));
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min > max) [min, max] = [max, min];
    return { name, kind: 'range', min, max };
  }

  /** Случайные значения переменных (rnd — генератор 0…1, по умолчанию Math.random). */
  function pickValues(vars, rnd) {
    const r = rnd || Math.random;
    const out = {};
    for (const v of vars || []) {
      if (v.kind === 'list') out[v.name] = v.list[Math.floor(r() * v.list.length) % v.list.length];
      else out[v.name] = String(v.min + Math.floor(r() * (v.max - v.min + 1)));
    }
    return out;
  }

  /** У задания должны быть значения для всех его переменных — дописать недостающие. Возвращает true, если что-то добавлено. */
  function ensureValues(act, rnd) {
    const sec = open(act);
    if (!sec || !sec.vars.length) return false;
    const have = Object.assign({}, act.values || {});
    const missing = sec.vars.filter((v) => have[v.name] == null);
    if (!missing.length) return false;
    Object.assign(have, pickValues(missing, rnd));
    act.values = have;
    return true;
  }

  const HOST_FIELDS = { ip: 'IP-адрес', mask: 'маска', gateway: 'шлюз', dns: 'DNS-сервер' };

  /**
   * Свой пункт оценки (можно с переменными {{ИМЯ}}):
   *  { kind: 'cfg', device, section, line } — строка running-config (section — строка раздела, например «interface GigabitEthernet0/0»);
   *  { kind: 'host', device, field: ip|mask|gateway|dns, value } — адрес компьютера или сервера (первый интерфейс);
   *  { kind: 'port', device, port, up } — порт включён / выключен.
   * net — схема, по которой узнаётся имя интерфейса узла (ответ или текущая).
   */
  function customItem(spec, net) {
    const dev = String(spec.device || '').trim();
    if (!dev) throw new Error('Выберите устройство');
    const base = { points: Math.max(0, Math.min(100, Number(spec.points) || 1)), custom: spec.kind };
    if (spec.hint) base.hint = String(spec.hint);
    if (spec.kind === 'cfg') {
      const line = String(spec.line || '').trim();
      const sect = String(spec.section || '').trim();
      if (!line) throw new Error('Введите строку конфигурации');
      return Object.assign(base, { key: 'cfg|' + dev + '|' + sect + '|' + line, path: [dev, 'Конфигурация', sect || 'глобальные'], label: line, value: true });
    }
    if (spec.kind === 'host') {
      if (!HOST_FIELDS[spec.field]) throw new Error('Неизвестное поле');
      const val = String(spec.value || '').trim();
      if (!val) throw new Error('Введите значение');
      let p = [spec.field];
      if (spec.field === 'ip' || spec.field === 'mask') {
        const d = net && net.findByName(dev);
        const f = d && d.ifaces && d.ifaces[0];
        if (!f) throw new Error('У ' + dev + ' нет сетевого интерфейса');
        p = ['ifaces', f.name, spec.field];
      }
      return Object.assign(base, { key: 'set|' + dev + '|' + p.join('/'), path: [dev, 'Настройки'].concat(p.slice(0, -1).map(lbl)), label: HOST_FIELDS[spec.field] + ' = ' + val, value: JSON.stringify(val) });
    }
    if (spec.kind === 'port') {
      const port = String(spec.port || '').trim();
      if (!port) throw new Error('Выберите порт');
      return Object.assign(base, { key: 'port|' + dev + '|' + port, path: [dev, 'Порты'], label: port + ': ' + (spec.up ? 'включён' : 'выключен (shutdown)'), value: !!spec.up });
    }
    throw new Error('Неизвестный вид пункта');
  }

  /**
   * Начало попытки ученика: задание из мастера (fresh) получает новые значения переменных,
   * а сохранённая работа ученика сохраняет свои. Возвращает true, если значения изменились.
   */
  function startAttempt(act, rnd) {
    const sec = open(act);
    if (!sec) return false;
    if (act.fresh) {
      delete act.fresh;
      if (!sec.vars.length) return true;
      act.values = pickValues(sec.vars, rnd);
      return true;
    }
    return ensureValues(act, rnd);
  }

  /** Результат проверки в CSV (разделитель «;», UTF-8 с BOM — открывается в Excel). */
  function resultCsv(act, r, meta) {
    const q = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    const rows = [
      ['Задание', act.title], ['Ученик', (meta && meta.student) || act.student || ''], ['Дата', (meta && meta.date) || ''],
      ['Процент', String(r.percent).replace('.', ',')], ['Баллы', r.got + ' из ' + r.total], [],
      ['Раздел', 'Пункт', 'Баллы', 'Выполнено'],
    ];
    for (const it of r.items) rows.push([it.path.join(' / '), it.label, it.points, it.ok ? 'да' : 'нет']);
    for (const t of r.tests) rows.push(['Проверка связи', t.from + ' → ' + t.to + (t.expect !== false ? ' (связь есть)' : ' (связи нет)'), t.points, t.ok ? 'да' : 'нет']);
    return '﻿' + rows.map((row) => row.map(q).join(';')).join('\r\n') + '\r\n';
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

  /**
   * Проверить схему ученика по заданию. Возвращает { percent, got, total, items, tests }.
   * opts.tests === false — без проверок связи (быстро: для «живого» счёта).
   */
  function check(net, act, opts) {
    const sec = open(act);
    if (!sec) throw new Error('Задание повреждено или создано другой версией NetLab');
    const vals = act.values || {};
    const have = facts(net);
    let got = 0;
    let total = 0;
    const items = sec.items.map((it) => {
      const key = subst(it.key, vals);
      const want = typeof it.value === 'string' ? subst(it.value, vals) : it.value;
      const f = have.get(key);
      const ok = !!f && stable(f.value) === stable(want);
      const pts = Number(it.points) || 0;
      total += pts;
      if (ok) got += pts;
      return { key, path: it.path.map((x) => subst(x, vals)), label: subst(it.label, vals), points: pts, ok, actual: f ? f.label : null, hint: it.hint ? subst(it.hint, vals) : '' };
    });
    const testList = sec.tests.map((t) => Object.assign({}, t, { to: subst(t.to, vals) }));
    const tests = opts && opts.tests === false ? [] : runTests(net, testList);
    if (opts && opts.tests === false) for (const t of testList) total += Number(t.points) || 0;
    for (const t of tests) { const pts = Number(t.points) || 0; total += pts; if (t.ok) got += pts; }
    return { percent: total ? Math.floor((got / total) * 1000) / 10 : 0, got, total, items, tests, faults: sec.faults };
  }

  /* ================= задание ================= */

  /** Закрытая часть задания: { answer, initial, items, tests, vars }. */
  function open(act) {
    if (!act) return null;
    const s = decode(act.secret);
    if (!s) return null;
    return { answer: s.answer || null, initial: s.initial || null, items: Array.isArray(s.items) ? s.items : [], tests: Array.isArray(s.tests) ? s.tests : [],
      vars: Array.isArray(s.vars) ? s.vars.map(normVar).filter(Boolean) : [], faults: Array.isArray(s.faults) ? s.faults : [] };
  }

  /** Собрать задание из черновика мастера. */
  function build(d) {
    const items = (d.items || []).map((it) => {
      const o = { key: String(it.key), path: (it.path || []).map(String), label: String(it.label || ''), value: it.value, points: Math.max(0, Math.min(100, Number(it.points) || 0)) };
      if (it.hint) o.hint = String(it.hint).slice(0, 500);
      if (it.custom) o.custom = it.custom;
      return o;
    });
    const vars = (d.vars || []).map(normVar).filter(Boolean);
    const locks = LOCKS.filter((k) => d.locks && d.locks[k]);
    const tests = (d.tests || []).filter((t) => t && t.from && t.to).map((t) => ({ from: String(t.from), to: String(t.to), expect: t.expect !== false, points: Math.max(0, Math.min(100, Number(t.points) || 0)) }));
    return {
      v: VERSION,
      title: String(d.title || 'Задание').slice(0, 120),
      instructions: String(d.instructions || '').slice(0, 20000),
      timer: Math.max(0, Math.min(600, Math.round(Number(d.timer) || 0))),
      feedback: ['full', 'score', 'none'].includes(d.feedback) ? d.feedback : 'full',
      lock: d.lock ? String(d.lock) : '',
      locks,
      live: !!d.live,
      fresh: vars.length ? true : undefined,
      secret: encode({ answer: d.answer || null, initial: d.initial || null, items, tests, vars, faults: (d.faults || []).map((f) => ({ dev: String(f.dev || ''), text: String(f.text || ''), fix: String(f.fix || '') })) }),
    };
  }

  /** Черновик мастера из задания (для правки). */
  function draft(act) {
    const s = open(act) || { answer: null, initial: null, items: [], tests: [], vars: [], faults: [] };
    return { title: act ? act.title : 'Задание', instructions: act ? act.instructions : '', timer: act ? act.timer : 0, feedback: act ? act.feedback : 'full', lock: act ? act.lock : '',
      locks: Object.fromEntries(((act && act.locks) || []).map((k) => [k, true])), live: !!(act && act.live),
      answer: s.answer, initial: s.initial, items: s.items.map((x) => Object.assign({}, x)), tests: s.tests.map((x) => Object.assign({}, x)), vars: s.vars.map((x) => Object.assign({}, x)), faults: (s.faults || []).map((x) => Object.assign({}, x)) };
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
    save(net) {
      if (!net.task) return null;
      const o = Object.assign({}, net.task);
      for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
      return o;
    },
    load(net, d) {
      net.task = d && typeof d === 'object' && d.v === VERSION && typeof d.secret === 'string'
        ? {
          v: VERSION, title: String(d.title || 'Задание'), instructions: String(d.instructions || ''), timer: Number(d.timer) || 0, feedback: ['full', 'score', 'none'].includes(d.feedback) ? d.feedback : 'full',
          lock: String(d.lock || ''), locks: Array.isArray(d.locks) ? d.locks.filter((k) => LOCKS.includes(k)) : [], live: !!d.live, secret: d.secret,
          values: d.values && typeof d.values === 'object' ? Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, String(v)])) : undefined,
          student: d.student ? String(d.student).slice(0, 80) : undefined,
          fresh: d.fresh ? true : undefined,
        }
        : null;
    },
  });

  /* ================= сводка по классу ================= */

  /** Разобрать CSV результата (resultCsv): ; как разделитель, строки в кавычках. */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let q = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
        continue;
      }
      if (c === '"') q = true;
      else if (c === ';' || c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        rows.push(row); row = [];
      } else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function parseResultCsv(text) {
    const rows = parseCsv(text);
    const meta = {};
    let i = 0;
    for (; i < rows.length; i++) {
      const r = rows[i];
      if (r[0] === 'Раздел') break;
      if (r.length >= 2) meta[r[0]] = r[1];
    }
    if (!meta['Задание'] || i >= rows.length) throw new Error('это не файл результата NetLab');
    const items = [];
    for (i++; i < rows.length; i++) {
      const r = rows[i];
      if (r.length < 4) continue;
      items.push({ section: r[0], label: r[1], points: Number(r[2]) || 0, ok: /^да$/i.test(r[3]) });
    }
    const [got, total] = String(meta['Баллы'] || '').split(/\s+из\s+/).map(Number);
    return { task: meta['Задание'], student: meta['Ученик'] || '', date: meta['Дата'] || '', percent: Number(String(meta['Процент'] || '0').replace(',', '.')) || 0, got: got || 0, total: total || 0, items };
  }

  /** Сводка по нескольким результатам: ученики × пункты, средний процент, доля решивших каждый пункт. */
  function classSummary(results) {
    const keys = [];
    const seen = new Set();
    for (const r of results) for (const it of r.items) { const k = it.section + ' / ' + it.label; if (!seen.has(k)) { seen.add(k); keys.push({ key: k, section: it.section, label: it.label }); } }
    const rows = results.map((r) => ({ student: r.student || '(без имени)', task: r.task, date: r.date, percent: r.percent, got: r.got, total: r.total, marks: new Map(r.items.map((it) => [it.section + ' / ' + it.label, it.ok])) }))
      .sort((a, b) => b.percent - a.percent || a.student.localeCompare(b.student, 'ru'));
    const solved = keys.map((k) => { const have = rows.filter((r) => r.marks.has(k.key)); return have.length ? Math.round((have.filter((r) => r.marks.get(k.key)).length / have.length) * 100) : 0; });
    const avg = rows.length ? Math.round((rows.reduce((x, r) => x + r.percent, 0) / rows.length) * 10) / 10 : 0;
    return { tasks: [...new Set(results.map((r) => r.task))], keys, rows, solved, avg };
  }

  function summaryCsv(sum) {
    const q = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    const head = ['Ученик', 'Процент', 'Баллы', 'Дата'].concat(sum.keys.map((k) => k.label));
    const lines = [head.map(q).join(';')];
    for (const r of sum.rows) lines.push([r.student, String(r.percent).replace('.', ','), r.got + ' из ' + r.total, r.date].concat(sum.keys.map((k) => (!r.marks.has(k.key) ? '' : r.marks.get(k.key) ? 'да' : 'нет'))).map(q).join(';'));
    lines.push(['Решили, %', String(sum.avg).replace('.', ','), '', ''].concat(sum.solved.map(String)).map(q).join(';'));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  NS.activity = { facts, candidates, check, runTests, build, draft, open, snapshot, encode, decode, passHash, subst, pickValues, ensureValues, startAttempt, resultCsv, parseResultCsv, classSummary, summaryCsv, normVar, customItem, HOST_FIELDS, LOCKS, VERSION };
})(globalThis.NetLab = globalThis.NetLab || {});
