/* NetLab — среда выполнения программ для плат MCU-PT и SBC-PT (вкладка «Программирование»).
 * Код в стиле Arduino / Packet Tracer (JavaScript): setup() и loop(), pinMode, digitalRead/digitalWrite,
 * analogRead/analogWrite, delay. delay() «блокирует», как на настоящей плате: перед запуском код
 * переписывается так, что функции становятся асинхронными, а их вызовы и delay() — с await.
 * В приложении код выполняется в отдельном Web Worker (js/ui/script-worker.js) без доступа к окну,
 * файлам и сети; в тестах — напрямую. */
(function (root) {
  'use strict';

  const esc = (s) => s.replace(/[$]/g, '\\$');

  /** Переписать код: function → async function, delay()/sleep()/свои функции → await. */
  function transform(code) {
    let src = String(code || '');
    const names = [];
    src.replace(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g, (m, n) => { if (!names.includes(n)) names.push(n); return m; });
    src = src.replace(/(^|[^\w$.])(async\s+)?function(?=[\s(])/g, (m, pre) => pre + 'async function');
    const calls = ['delay', 'sleep'].concat(names);
    const re = new RegExp('(^|[^\\w$.])(await\\s+)?(' + calls.map(esc).join('|') + ')\\s*\\(', 'g');
    src = src.replace(re, (m, pre, aw, name, off, whole) => {
      if (aw) return m;
      if (/function\s*$/.test(whole.slice(0, off + pre.length))) return m;
      return pre + 'await ' + name + '(';
    });
    return src;
  }

  /* ================= Python → JavaScript ================= */

  /** Разбить строку на код и строковые литералы (комментарий # отбрасывается): [[текст, строка?], …]. */
  function splitStrings(line) {
    const parts = [];
    let cur = '';
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '#') break;
      if (c === '"' || c === "'") {
        let j = i + 1;
        let s = c;
        while (j < line.length && line[j] !== c) {
          if (line[j] === '\\') { s += line[j] + (line[j + 1] || ''); j += 2; continue; }
          s += line[j];
          j++;
        }
        s += c;
        let f = false;
        if (/(^|[^\w])[fF]$/.test(cur)) { f = true; cur = cur.slice(0, -1); }
        parts.push([cur, false], [s, true, f]);
        cur = '';
        i = j + 1;
        continue;
      }
      cur += c;
      i++;
    }
    parts.push([cur, false]);
    return parts;
  }

  const PY_FUN = [[/\blen\(/g, '__len('], [/\bstr\(/g, 'String('], [/\bint\(/g, '__int('], [/\bfloat\(/g, 'Number('], [/\babs\(/g, 'Math.abs('],
    [/\bmin\(/g, '__min('], [/\bmax\(/g, '__max('], [/\brange\(/g, '__range('], [/\blist\(/g, '__list('], [/\benumerate\(/g, '__enumerate('], [/\bround\(/g, '__round('],
    [/\.append\(/g, '.push('], [/\.upper\(\)/g, '.toUpperCase()'], [/\.lower\(\)/g, '.toLowerCase()'], [/\.strip\(\)/g, '.trim()'], [/\.pop\(\)/g, '.pop()'],
    [/\btime\.sleep\(/g, 'sleep('], [/\bgpio\./g, ''], [/\btime\.time\(\)/g, '(millis() / 1000)']];

  function convCode(t) {
    let s = ' ' + t + ' ';
    s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
      .replace(/\bis\s+not\b/g, '!==').replace(/\bis\b/g, '===');
    // x in y / x not in y — метки, операнды разбираются после склейки со строками (fixIn)
    s = s.replace(/\bnot\s+in\b/g, '\u0001N').replace(/\bin\b/g, '\u0001I');
    s = s.replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!');
    s = s.replace(/([\w.]+|\))\s*\/\/\s*([\w.]+)/g, 'Math.floor($1 / $2)');
    for (const [re, to] of PY_FUN) s = s.replace(re, to);
    return s.slice(1, -1);
  }

  /** Выражение Python → JS (строки и f-строки сохраняются). */
  function convExpr(t) {
    const out = splitStrings(t).map(([x, str, f]) => {
      if (!str) return convCode(x);
      if (!f) return x;
      const body = x.slice(1, -1).replace(/`/g, '\\`').replace(/\{([^{}]+)\}/g, (m, e) => '${' + convExpr(e) + '}');
      return '`' + body + '`';
    }).join('');
    return fixIn(out);
  }

  /** Операторы in / not in: «a in b» → __in(a, b). Операнд — имя (с .атрибутами и [индексами]), строка или скобки. */
  function fixIn(s) {
    const OPEN = { ')': '(', ']': '[', '}': '{' };
    const CLOSE = { '(': ')', '[': ']', '{': '}' };
    for (let guard = 0; guard < 50; guard++) {
      const k = s.indexOf('\u0001');
      if (k < 0) break;
      const neg = s[k + 1] === 'N';
      // левый операнд
      let a = k - 1;
      while (a >= 0 && s[a] === ' ') a--;
      let st = a;
      const back = () => {
        const c = s[st];
        if (c === '"' || c === "'") { st--; while (st >= 0 && !(s[st] === c && s[st - 1] !== '\\')) st--; st--; return true; }
        if (OPEN[c]) { let d = 0; for (; st >= 0; st--) { if (s[st] === c) d++; else if (s[st] === OPEN[c]) { d--; if (d === 0) break; } } st--; return true; }
        if (/[\w.$]/.test(c || '')) { while (st >= 0 && /[\w.$]/.test(s[st])) st--; return true; }
        return false;
      };
      if (s[st] === '"' || s[st] === "'") back();
      else while (st >= 0 && /[\w.$\])}]/.test(s[st]) && back()) { /* цепочка a.b[0](…) */ }
      const left = s.slice(st + 1, a + 1).trim();
      // правый операнд
      let b = k + 2;
      while (b < s.length && s[b] === ' ') b++;
      let en = b;
      const fwd = () => {
        const c = s[en];
        if (c === '"' || c === "'" || c === '`') { en++; while (en < s.length && !(s[en] === c && s[en - 1] !== '\\')) en++; en++; return true; }
        if (CLOSE[c]) { let d = 0; for (; en < s.length; en++) { if (s[en] === c) d++; else if (s[en] === CLOSE[c]) { d--; if (d === 0) break; } } en++; return true; }
        if (/[\w.$]/.test(c || '')) { while (en < s.length && /[\w.$]/.test(s[en])) en++; return true; }
        return false;
      };
      fwd();
      while (en < s.length && (s[en] === '[' || s[en] === '(') && fwd()) { /* x.items()[0] */ }
      const right = s.slice(b, en).trim();
      if (!left || !right) { s = s.slice(0, k) + ' in ' + s.slice(k + 2); continue; }
      s = s.slice(0, st + 1) + (neg ? '!' : '') + '__in(' + left + ', ' + right + ')' + s.slice(en);
    }
    return s;
  }

  /** Есть ли запятая верхнего уровня (кортеж). */
  function topComma(t) {
    let d = 0;
    for (const [x, str] of splitStrings(t)) {
      if (str) continue;
      for (const c of x) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; else if (c === ',' && d === 0) return true; }
    }
    return false;
  }

  /** Склеить продолжения строк (незакрытые скобки, «\» в конце). */
  function logicalLines(src) {
    const out = [];
    let buf = null;
    let depth = 0;
    for (const raw of String(src || '').replace(/\t/g, '    ').split(/\r?\n/)) {
      let line = raw;
      const code = splitStrings(line).filter(([, s]) => !s).map(([x]) => x).join('');
      for (const c of code) { if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth = Math.max(0, depth - 1); }
      const cont = /\\\s*$/.test(line);
      if (cont) line = line.replace(/\\\s*$/, ' ');
      if (buf == null) buf = { text: line, n: out.length };
      else buf.text += ' ' + line.trim();
      if (depth === 0 && !cont) { out.push(buf.text); buf = null; } else out.push('');
    }
    if (buf) out.push(buf.text);
    return out;
  }

  /** Перевести программу Python (подмножество, как в Packet Tracer) в JavaScript для этой среды. */
  function py2js(src) {
    const lines = logicalLines(src);
    const out = [''];
    const mod = { kind: 'module', indent: -1, vars: new Set(), globals: new Set(), params: new Set(), decl: 0 };
    const stack = [mod];
    const scope = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind !== 'block') return stack[i]; return mod; };
    const pad = (n) => ' '.repeat(Math.max(0, n));
    const defs = [];
    lines.forEach((raw, ln) => {
      if (!raw.trim() || /^\s*#/.test(raw)) { out.push(''); return; }
      const indent = raw.match(/^ */)[0].length;
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) { const b = stack.pop(); out.push(pad(b.indent) + '}'); }
      let text = splitStrings(raw.trim()).map(([x, s, f]) => (s ? (f ? 'f' : '') + x : x)).join('').trim();
      const p = pad(indent);
      const header = /:$/.test(text) && /^(def|if|elif|else|while|for|try|except|finally|with|class)\b/.test(text);
      const open = (js, kind, extra) => { out.push(p + js + ' {'); const e = Object.assign({ kind: kind || 'block', indent }, extra || {}); stack.push(e); return e; };
      if (header) text = text.slice(0, -1).trim();
      let m;
      if (header && (m = /^def\s+([A-Za-z_]\w*)\s*\((.*)\)$/.exec(text))) {
        const params = new Set(m[2].split(',').map((x) => x.trim().replace(/=.*$/, '').replace(/^\*+/, '').trim()).filter(Boolean));
        const e = open('function ' + m[1] + '(' + convExpr(m[2]) + ')', 'def', { vars: new Set(), globals: new Set(), params });
        e.decl = out.length;
        out.push('');
        defs.push(e);
        return;
      }
      if (header && /^class\b/.test(text)) throw new Error('Строка ' + (ln + 1) + ': классы Python здесь не поддерживаются');
      if (header && (m = /^(if|elif|while)\s+(.+)$/.exec(text))) { open((m[1] === 'elif' ? 'else if' : m[1]) + ' (' + convExpr(m[2]) + ')'); return; }
      if (header && text === 'else') { open('else'); return; }
      if (header && text === 'try') { open('try'); return; }
      if (header && text === 'finally') { open('finally'); return; }
      if (header && (m = /^except\b(?:.*\bas\s+(\w+))?/.exec(text))) { open('catch (' + (m[1] || '__e') + ')'); return; }
      if (header && /^with\b/.test(text)) { open(''); return; }
      if (header && (m = /^for\s+(.+?)\s+in\s+(.+)$/.exec(text))) {
        const tgt = m[1].trim();
        const names = tgt.replace(/[()]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
        for (const n of names) scope().vars.add(n);
        open('for (' + (names.length > 1 ? '[' + names.join(', ') + ']' : names[0]) + ' of __iter(' + convExpr(m[2]) + '))');
        return;
      }
      if (header) throw new Error('Строка ' + (ln + 1) + ': неизвестная конструкция «' + text + ':»');
      if (/^(import|from)\s/.test(text)) { out.push(''); return; }
      if ((m = /^global\s+(.+)$/.exec(text))) { for (const n of m[1].split(',')) { scope().globals.add(n.trim()); mod.vars.add(n.trim()); } out.push(''); return; }
      if (text === 'pass') { out.push(p + ';'); return; }
      if (text === 'break' || text === 'continue') { out.push(p + text + ';'); return; }
      if ((m = /^return\b\s*(.*)$/.exec(text))) { out.push(p + 'return' + (m[1] ? ' ' + (topComma(m[1]) ? '[' + convExpr(m[1]) + ']' : convExpr(m[1])) : '') + ';'); return; }
      if ((m = /^del\s+/.exec(text))) { out.push(''); return; }
      // print(…, end="", sep=" ")
      if (/^print\s*\(/.test(text)) text = text.replace(/,\s*(end|sep|flush)\s*=\s*("[^"]*"|'[^']*'|\w+)/g, '');
      // присваивания
      if ((m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*=(?!=)\s*(.+)$/.exec(text))) {
        const names = m[1].split(',').map((x) => x.trim());
        for (const n of names) scope().vars.add(n);
        out.push(p + '[' + names.join(', ') + '] = ' + (topComma(m[2]) ? '[' + convExpr(m[2]) + ']' : convExpr(m[2])) + ';');
        return;
      }
      if ((m = /^([A-Za-z_]\w*)\s*\/\/=\s*(.+)$/.exec(text))) { scope().vars.add(m[1]); out.push(p + m[1] + ' = Math.floor(' + m[1] + ' / (' + convExpr(m[2]) + '));'); return; }
      if ((m = /^([A-Za-z_]\w*)\s*(=(?!=)|\+=|-=|\*=|\/=|%=|\*\*=)\s*(.+)$/.exec(text))) {
        scope().vars.add(m[1]);
        out.push(p + m[1] + ' ' + m[2] + ' ' + (m[2] === '=' && topComma(m[3]) ? '[' + convExpr(m[3]) + ']' : convExpr(m[3])) + ';');
        return;
      }
      out.push(p + convExpr(text) + ';');
    });
    while (stack.length > 1) { const b = stack.pop(); out.push(pad(b.indent) + '}'); }
    for (const d of defs) {
      const v = [...d.vars].filter((x) => !d.globals.has(x) && !d.params.has(x));
      out[d.decl] = v.length ? 'let ' + v.join(', ') + ';' : '';
    }
    const top = [...mod.vars];
    out[0] = 'const __name__ = "__main__";' + (top.length ? ' let ' + top.join(', ') + ';' : '');
    return out.join('\n');
  }

  /* ================= визуальные блоки → JavaScript ================= */

  const PIN_RE = /^(D[0-9]|A[0-9])$/;
  const OPS = ['==', '!=', '>', '<', '>=', '<='];
  const numOr = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
  const pinQ = (p) => JSON.stringify(PIN_RE.test(String(p)) ? String(p) : 'D0');
  const varName = (n) => (/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(String(n || '')) ? 'v_' + n : 'v_x');

  /** Программа из блоков: { setup: [блоки], loop: [блоки] } → код JavaScript с setup() и loop(). */
  function blocksToJs(prog) {
    const vars = new Set();
    const toggles = new Set();
    const cond = (b) => {
      const op = OPS.includes(b.op) ? b.op : '==';
      const left = b.src === 'analog' ? 'analogRead(' + pinQ(b.pin) + ')' : b.src === 'var' ? (vars.add(varName(b.name)), varName(b.name)) : 'digitalRead(' + pinQ(b.pin) + ')';
      const right = b.src === 'digital' ? (String(b.value).toUpperCase() === 'LOW' || Number(b.value) === 0 ? 'LOW' : 'HIGH') : String(numOr(b.value, 0));
      return left + ' ' + op + ' ' + right;
    };
    const gen = (list, ind) => (list || []).map((b) => {
      switch (b.t) {
        case 'pinMode': return ind + 'pinMode(' + pinQ(b.pin) + ', ' + (b.mode === 'INPUT' ? 'INPUT' : 'OUTPUT') + ');';
        case 'digitalWrite': return ind + 'digitalWrite(' + pinQ(b.pin) + ', ' + (b.value === 'LOW' ? 'LOW' : 'HIGH') + ');';
        case 'analogWrite': return ind + 'analogWrite(' + pinQ(b.pin) + ', ' + Math.max(0, Math.min(1023, numOr(b.value, 0))) + ');';
        case 'copy': return ind + 'analogWrite(' + pinQ(b.to) + ', analogRead(' + pinQ(b.pin) + '));';
        case 'toggle': toggles.add(pinQ(b.pin)); return ind + '__t[' + pinQ(b.pin) + '] = !__t[' + pinQ(b.pin) + ']; digitalWrite(' + pinQ(b.pin) + ', __t[' + pinQ(b.pin) + '] ? HIGH : LOW);';
        case 'delay': return ind + 'delay(' + Math.max(0, numOr(b.ms, 500)) + ');';
        case 'print': return ind + 'Serial.println(' + JSON.stringify(String(b.text || '')) + ');';
        case 'printRead': return ind + 'Serial.println(' + JSON.stringify(String(b.pin) + ' = ') + ' + ' + (b.mode === 'analog' ? 'analogRead(' : 'digitalRead(') + pinQ(b.pin) + '));';
        case 'set': vars.add(varName(b.name)); return ind + varName(b.name) + ' = ' + (b.src === 'analog' ? 'analogRead(' + pinQ(b.pin) + ')' : b.src === 'digital' ? 'digitalRead(' + pinQ(b.pin) + ')' : b.src === 'add' ? varName(b.name) + ' + ' + numOr(b.value, 1) : numOr(b.value, 0)) + ';';
        case 'if': return ind + 'if (' + cond(b) + ') {\n' + gen(b.then, ind + '  ') + '\n' + ind + '}' + (b.else && b.else.length ? ' else {\n' + gen(b.else, ind + '  ') + '\n' + ind + '}' : '');
        case 'repeat': return ind + 'for (let i = 0; i < ' + Math.max(0, Math.min(10000, numOr(b.n, 3))) + '; i++) {\n' + gen(b.body, ind + '  ') + '\n' + ind + '}';
        default: return ind + '// неизвестный блок';
      }
    }).join('\n');
    const setup = gen(prog && prog.setup, '  ');
    const loop = gen(prog && prog.loop, '  ');
    return '// Программа собрана из блоков\n' + (vars.size ? 'let ' + [...vars].map((v) => v + ' = 0').join(', ') + ';\n' : '') + (toggles.size ? 'const __t = {};\n' : '') +
      '\nfunction setup() {\n' + setup + '\n}\n\nfunction loop() {\n' + loop + '\n}\n';
  }

  const pinName = (p) => (typeof p === 'number' || /^\d+$/.test(String(p)) ? 'D' + Number(p) : String(p).toUpperCase());

  /**
   * Запустить программу. io: read(pin, 'digital'|'analog') → число, write(pin, value), mode(pin, mode),
   * log(text), error(text), done(). Возвращает { stop() }.
   */
  function run(code, io, lang) {
    if (lang === 'python') {
      try { code = py2js(code); } catch (e) {
        io.error('Ошибка Python: ' + e.message);
        if (io.done) io.done();
        return { stop() {} };
      }
    }
    const state = { stopped: false, timers: new Set(), start: Date.now() };
    const out = {};
    const handle = { stop() { state.stopped = true; for (const t of state.timers) { clearTimeout(t); clearInterval(t); } state.timers.clear(); } };
    const log = (...a) => io.log(a.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x))).join(' '));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const api = {
      HIGH: 1, LOW: 0, INPUT: 'INPUT', OUTPUT: 'OUTPUT', INPUT_PULLUP: 'INPUT_PULLUP', IN: 'INPUT', OUT: 'OUTPUT',
      A0: 'A0', A1: 'A1', A2: 'A2', A3: 'A3', D0: 'D0', D1: 'D1', D2: 'D2', D3: 'D3', D4: 'D4', D5: 'D5',
      pinMode(p, m) { if (io.mode) io.mode(pinName(p), String(m || 'INPUT')); },
      digitalWrite(p, v) { const n = pinName(p); out[n] = v ? 1 : 0; io.write(n, out[n] ? 1023 : 0); },
      digitalRead(p) { return io.read(pinName(p), 'digital') ? 1 : 0; },
      analogWrite(p, v) { const n = pinName(p); out[n] = clamp(Math.round(Number(v) || 0), 0, 1023); io.write(n, out[n]); },
      analogRead(p) { return clamp(Math.round(Number(io.read(pinName(p), 'analog')) || 0), 0, 1023); },
      customWrite(p, v) { io.write(pinName(p), v); },
      customRead(p) { return io.read(pinName(p), 'analog'); },
      delay(ms) {
        return new Promise((res) => {
          if (state.stopped) return;
          const t = setTimeout(() => { state.timers.delete(t); if (!state.stopped) res(); }, clamp(Number(ms) || 0, 0, 3600000));
          state.timers.add(t);
        });
      },
      sleep(s) { return api.delay((Number(s) || 0) * 1000); },
      millis() { return Date.now() - state.start; },
      random(a, b) { if (b === undefined) { b = a; a = 0; } return Math.floor(a + Math.random() * (b - a)); },
      map(v, a1, a2, b1, b2) { return b1 + ((v - a1) * (b2 - b1)) / (a2 - a1 || 1); },
      constrain: clamp,
      // встроенные функции Python (для программ на Python)
      __range(a, b, st) { if (b === undefined) { b = a; a = 0; } st = st || 1; const r = []; for (let i = a; st > 0 ? i < b : i > b; i += st) { r.push(i); if (r.length > 1e6) break; } return r; },
      __iter(x) { if (x == null) throw new Error('объект нельзя перебирать (None)'); if (typeof x === 'number') throw new Error('число нельзя перебирать — используйте range()'); return typeof x === 'object' && !Array.isArray(x) && !(Symbol.iterator in x) ? Object.keys(x) : x; },
      __len(x) { return x == null ? 0 : typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).length : x.length; },
      __int(x) { const v = typeof x === 'string' ? parseInt(x, 10) : Math.trunc(Number(x)); if (Number.isNaN(v)) throw new Error('invalid literal for int(): ' + x); return v; },
      __min(...a) { return Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a)); },
      __max(...a) { return Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a)); },
      __list(x) { return x == null ? [] : Array.from(typeof x === 'object' && !Array.isArray(x) && !(Symbol.iterator in x) ? Object.keys(x) : x); },
      __in(a, b) { return typeof b === 'string' ? b.includes(a) : Array.isArray(b) ? b.includes(a) : b != null && Object.prototype.hasOwnProperty.call(b, a); },
      __enumerate(x) { return Array.from(x).map((v, i) => [i, v]); },
      __round(x, n) { return n ? Number(Number(x).toFixed(n)) : Math.round(Number(x)); },
      print: log,
      console: { log, info: log, warn: log, error: log },
      Serial: { begin() {}, print: log, println: log },
      setTimeout(fn, ms) { const t = setTimeout(() => { state.timers.delete(t); if (!state.stopped) fn(); }, ms); state.timers.add(t); return t; },
      setInterval(fn, ms) { const t = setInterval(() => { if (!state.stopped) fn(); }, Math.max(10, Number(ms) || 10)); state.timers.add(t); return t; },
      clearTimeout(t) { clearTimeout(t); state.timers.delete(t); },
      clearInterval(t) { clearInterval(t); state.timers.delete(t); },
    };
    const names = Object.keys(api);
    const wrap = (b) => '"use strict";\nreturn (async function () {\n' + b + '\n;return { setup: typeof setup === "function" ? setup : null, loop: typeof loop === "function" ? loop : null };\n})();';
    let fn;
    try {
      fn = new Function(...names, wrap(transform(code)));
    } catch (e) {
      try { fn = new Function(...names, wrap(String(code || ''))); } catch (e2) {
        io.error('Синтаксическая ошибка: ' + e2.message);
        if (io.done) io.done();
        return handle;
      }
    }
    (async () => {
      const r = await fn(...names.map((n) => api[n]));
      if (state.stopped) return;
      if (r.setup) await r.setup();
      if (!r.loop) return;
      while (!state.stopped) {
        await r.loop();
        await api.delay(5);
      }
    })().then(() => { if (!state.stopped && io.done) io.done(); }, (e) => {
      if (state.stopped) return;
      io.error('Ошибка: ' + (e && e.message ? e.message : String(e)));
      if (io.done) io.done();
    });
    return handle;
  }

  const rt = { transform, run, pinName, py2js, blocksToJs };
  root.NetLab = root.NetLab || {};
  root.NetLab.scriptRt = rt;
  if (typeof module === 'object' && module.exports) module.exports = rt;
})(typeof self !== 'undefined' ? self : globalThis);
