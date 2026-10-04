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
    let mask = codeMask(src);
    src = src.replace(re, (m, pre, aw, name, off, whole) => {
      if (aw || mask[off + pre.length]) return m;
      if (/function\s*$/.test(whole.slice(0, off + pre.length))) return m;
      return pre + 'await ' + name + '(';
    });
    // сеть: requests.get(…), http.post(…), ConnectHandler(…), ping(…), conn.send_command(…) и т. п.
    const NET = /(^|[^\w$.])(await\s+)?((?:requests|http)\.(?:get|post|put|patch|delete|request)|ConnectHandler|ping|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:send_command|send_config_set|enable|disconnect|find_prompt))\s*\(/g;
    mask = codeMask(src);
    src = src.replace(NET, (m, pre, aw, name, off) => (aw || mask[off + pre.length] ? m : pre + 'await ' + name + '('));
    // асинхронные методы классов: obj.method(…) → (await obj.method(…))
    const meths = new Set();
    src.replace(/^\s*(?:static\s+)?async\s+([A-Za-z_$][\w$]*)\s*\(/gm, (m, n) => { if (n !== 'function') meths.add(n); return m; });
    if (meths.size) src = awaitMethods(src, meths);
    return src;
  }

  /** Отметить позиции внутри строк и комментариев. */
  function codeMask(src) {
    const mask = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') mask[i++] = 1; continue; }
      if (c === '"' || c === "'" || c === '`') {
        mask[i] = 1;
        let j = i + 1;
        while (j < src.length && src[j] !== c) { mask[j] = 1; if (src[j] === '\\') { mask[j + 1] = 1; j++; } j++; }
        mask[j] = 1;
        i = j;
      }
    }
    return mask;
  }

  function awaitMethods(src, set) {
    const re = /\.([A-Za-z_$][\w$]*)\s*\(/g;
    let from = 0;
    for (let guard = 0; guard < 5000; guard++) {
      re.lastIndex = from;
      const m = re.exec(src);
      if (!m) break;
      const mask = codeMask(src);
      if (!set.has(m[1]) || mask[m.index]) { from = m.index + 1; continue; }
      // начало выражения-получателя: имена, точки, скобки
      let st = m.index - 1;
      for (;;) {
        const c = src[st];
        if (c === ')' || c === ']') {
          const open = c === ')' ? '(' : '[';
          let d = 0;
          for (; st >= 0; st--) { if (mask[st]) continue; if (src[st] === c) d++; else if (src[st] === open) { d--; if (d === 0) break; } }
          st--;
          continue;
        }
        if (c && /[\w$.]/.test(c)) { st--; continue; }
        break;
      }
      const start = st + 1;
      if (start >= m.index || /await\s*$/.test(src.slice(0, start))) { from = m.index + 1; continue; }
      let d = 0;
      let close = -1;
      for (let j = m.index + m[0].length - 1; j < src.length; j++) {
        if (mask[j]) continue;
        if (src[j] === '(') d++;
        else if (src[j] === ')') { d--; if (d === 0) { close = j; break; } }
      }
      if (close < 0) break;
      src = src.slice(0, start) + '(await ' + src.slice(start, close + 1) + ')' + src.slice(close + 1);
      from = start + 7;
    }
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
    [/\btime\.sleep\(/g, 'sleep('], [/\bgpio\./g, ''], [/\btime\.time\(\)/g, '(millis() / 1000)'],
    [/\b([A-Za-z_][\w.]*)\.items\(\)/g, 'Object.entries($1)'], [/\b([A-Za-z_][\w.]*)\.keys\(\)/g, 'Object.keys($1)'], [/\b([A-Za-z_][\w.]*)\.values\(\)/g, 'Object.values($1)']];

  function convCode(t) {
    let s = ' ' + t + ' ';
    s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
      .replace(/\bis\s+not\b/g, '!==').replace(/\bis\b/g, '===');
    // x in y / x not in y — метки, операнды разбираются после склейки со строками (fixIn)
    s = s.replace(/\bnot\s+in\b/g, '\u0001N').replace(/\bin\b/g, '\u0001I');
    s = s.replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!');
    s = s.replace(/([\w.]+|\))\s*\/\/\s*([\w.]+)/g, 'Math.floor($1 / $2)');
    for (const [re, to] of PY_FUN) s = s.replace(re, to);
    s = s.replace(/\blambda\b([^:]*):/g, (m, p) => '(' + p.trim() + ') =>');
    s = s.replace(/\bsuper\(\)\./g, 'super.');
    if (pySelf) s = s.replace(new RegExp('\\b' + pySelf + '\\b', 'g'), 'this');
    s = s.replace(PY_METH, '.__py_$1(').replace(/(?<!\b(?:requests|http))\.get\(/g, '.__py_get(');
    s = s.replace(/(?<![\w$.])(sorted|sum|any|all|zip|reversed|isinstance|filter|ord|hex|bin|divmod|hasattr|getattr|setattr|set|chr|bool|pow)\(/g,
      (m, f) => ({ chr: 'String.fromCharCode(', bool: 'Boolean(', pow: 'Math.pow(' }[f] || '__' + f + '('));
    return s.slice(1, -1);
  }

  const PY_METH = /\.(startswith|endswith|find|rfind|count|format|isdigit|isalpha|isalnum|isspace|isupper|islower|lstrip|rstrip|strip|title|capitalize|zfill|join|split|splitlines|replace|extend|insert|remove|index|copy|sort|update|setdefault|pop|clear)\(/g;
  let pySelf = null; // имя self в текущем методе класса (→ this)

  /** Позиция «:» верхнего уровня (вне строк и скобок) или -1. */
  function topColon(t) {
    let d = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '"' || c === "'") { const q = c; i++; while (i < t.length && t[i] !== q) { if (t[i] === '\\') i++; i++; } continue; }
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) d--;
      else if (c === ':' && d === 0) return i;
    }
    return -1;
  }

  /** Выражение Python → JS (строки и f-строки сохраняются). */
  /** Включения: [e for v in it if c] → __list(it).filter(…).map(…); {k: v for …} → Object.fromEntries(…). */
  function comprehensions(t, keep) {
    const str = (i) => { const q = t[i]; let j = i + 1; while (j < t.length && t[j] !== q) { if (t[j] === '\\') j++; j++; } return j + 1; };
    const close = (x, i) => { let d = 0; for (let j = i; j < x.length; j++) { const c = x[j]; if (c === '"' || c === "'") { const q = c; j++; while (j < x.length && x[j] !== q) { if (x[j] === '\\') j++; j++; } continue; } if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { d--; if (d === 0) return j; } } return -1; };
    const word = (x, w, from) => {
      for (let j = from || 0; j < x.length; j++) {
        const c = x[j];
        if (c === '"' || c === "'") { const q = c; j++; while (j < x.length && x[j] !== q) { if (x[j] === '\\') j++; j++; } continue; }
        if ('([{'.includes(c)) { const k = close(x, j); if (k < 0) return -1; j = k; continue; }
        if (x.startsWith(w, j) && !/[\w$]/.test(x[j - 1] || '') && !/[\w$]/.test(x[j + w.length] || '')) return j;
      }
      return -1;
    };
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '"' || c === "'") { const j = str(i); out += t.slice(i, j); i = j - 1; continue; }
      if (c === '[' || c === '{') {
        const j = close(t, i);
        const inner = j > 0 ? t.slice(i + 1, j) : '';
        const fo = j > 0 ? word(inner, 'for') : -1;
        const io = fo > 0 ? word(inner, 'in', fo + 3) : -1;
        if (io > 0) {
          const expr = inner.slice(0, fo).trim();
          let vars = inner.slice(fo + 3, io).trim().replace(/^\((.*)\)$/, '$1');
          vars = vars.includes(',') ? '[' + vars.split(',').map((v) => v.trim()).join(', ') + ']' : vars;
          const rest = inner.slice(io + 2);
          const ifAt = word(rest, 'if');
          const it = (ifAt >= 0 ? rest.slice(0, ifAt) : rest).trim();
          const cond = ifAt >= 0 ? rest.slice(ifAt + 2).trim() : null;
          const colon = c === '{' ? (() => { let k = -1; for (let q = 0; q < expr.length; q++) { const ch = expr[q]; if (ch === '"' || ch === "'") { const qq = ch; q++; while (q < expr.length && expr[q] !== qq) q++; continue; } if ('([{'.includes(ch)) { q = close(expr, q); continue; } if (ch === ':') { k = q; break; } } return k; })() : -1;
          let js = '__list(' + convExpr(it) + ')' + (cond ? '.filter((' + vars + ') => ' + convExpr(cond) + ')' : '');
          if (colon > 0) js = 'Object.fromEntries(' + js + '.map((' + vars + ') => [' + convExpr(expr.slice(0, colon)) + ', ' + convExpr(expr.slice(colon + 1)) + ']))';
          else js += '.map((' + vars + ') => ' + convExpr(expr) + ')';
          out += '\u0002' + keep.length + '\u0002';
          keep.push(js);
          i = j;
          continue;
        }
      }
      out += c;
    }
    return out;
  }

  function convExpr(t) {
    const keep = [];
    if (/\bfor\b/.test(t)) t = comprehensions(t, keep);
    return keep.length ? convExpr0(t).replace(/\u0002(\d+)\u0002/g, (m, n) => keep[Number(n)]) : convExpr0(t);
  }

  function convExpr0(t) {
    const out = splitStrings(t).map(([x, str, f]) => {
      if (!str) return convCode(x);
      if (!f) return x;
      const body = x.slice(1, -1).replace(/`/g, '\\`').replace(/\{([^{}]+)\}/g, (m, e) => {
        const k = topColon(e);
        let ex = k < 0 ? e : e.slice(0, k);
        const conv = /!([rsa])\s*$/.exec(ex);
        if (conv) ex = ex.slice(0, conv.index);
        let js = convExpr(ex);
        if (conv) js = conv[1] === 'r' ? '__fmt("%r", ' + js + ')' : '__fmt("%s", ' + js + ')';
        return k < 0 ? '${' + js + '}' : '${__fmtspec(' + js + ', ' + JSON.stringify(e.slice(k + 1)) + ')}';
      });
      return '`' + body + '`';
    }).join('');
    return fixTern(fixSlice(fixKw(fixIn(pyOps(out)))));
  }

  /** «строка» % значения → __fmt(…); строка/список * n → __mul(…). */
  function pyOps(s) {
    const STR = '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')';
    s = s.replace(new RegExp(STR + '\\s*%\\s*(\\([^()]*\\)|\\[[^\\[\\]]*\\]|[\\w.$]+(?:\\([^()]*\\))?)', 'g'), '__fmt($1, $2)');
    s = s.replace(new RegExp('(' + STR.slice(1, -1) + '|\\[[^\\[\\]]*\\])\\s*\\*\\s*([\\w.$]+|\\([^()]*\\))', 'g'), '__mul($1, $2)');
    s = s.replace(new RegExp('([\\w.$]+)\\s*\\*\\s*(' + STR.slice(1, -1) + '|\\[[^\\[\\]]*\\])', 'g'), '__mul($2, $1)');
    return s;
  }

  /** Срезы: x[a:b:c] → __slice(x, a, b, c). */
  function fixSlice(s) {
    const skip = (i) => { const q = s[i]; let j = i + 1; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } return j; };
    const match = (i) => { let d = 0; for (let j = i; j < s.length; j++) { const c = s[j]; if (c === '"' || c === "'" || c === '`') { j = skip(j); continue; } if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { d--; if (d === 0) return j; } } return -1; };
    for (let guard = 0; guard < 50; guard++) {
      let done = true;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"' || c === "'" || c === '`') { i = skip(i); continue; }
        if (c !== '[' || !/[\w$\])'"`]/.test(s[i - 1] || '')) continue;
        const j = match(i);
        if (j < 0) break;
        const inner = s.slice(i + 1, j);
        const parts = [];
        let rest = inner;
        for (let k = topColon(rest); k >= 0; k = topColon(rest)) { parts.push(rest.slice(0, k)); rest = rest.slice(k + 1); }
        if (!parts.length) continue;
        parts.push(rest);
        let st = i - 1;
        for (;;) {
          const ch = s[st];
          if (ch === ')' || ch === ']') { const op = ch === ')' ? '(' : '['; let d = 0; for (; st >= 0; st--) { if (s[st] === ch) d++; else if (s[st] === op) { d--; if (d === 0) break; } } st--; continue; }
          if (ch === '"' || ch === "'") { st--; while (st >= 0 && s[st] !== ch) st--; st--; continue; }
          if (ch && /[\w$.]/.test(ch)) { st--; continue; }
          break;
        }
        const recv = s.slice(st + 1, i);
        if (!recv) continue;
        s = s.slice(0, st + 1) + '__slice(' + recv + ', ' + parts.map((x) => x.trim() || 'undefined').join(', ') + ')' + s.slice(j + 1);
        done = false;
        break;
      }
      if (done) break;
    }
    return s;
  }

  /** Условное выражение Python: A if C else B → (C ? A : B), в том числе внутри скобок и значений словаря. */
  function fixTern(s) {
    const str = (t, i) => { const q = t[i]; let j = i + 1; while (j < t.length && t[j] !== q) { if (t[j] === '\\') j++; j++; } return j + 1; };
    const close = (t, i) => { let d = 0; for (let j = i; j < t.length; j++) { const c = t[j]; if (c === '"' || c === "'" || c === '`') { j = str(t, j) - 1; continue; } if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { d--; if (d === 0) return j; } } return -1; };
    // позиции символов верхнего уровня (вне строк и скобок)
    const top = (t, fn) => { for (let j = 0; j < t.length; j++) { const c = t[j]; if (c === '"' || c === "'" || c === '`') { j = str(t, j) - 1; continue; } if ('([{'.includes(c)) { const k = close(t, j); if (k < 0) return; j = k; continue; } if (fn(j, c) === false) return; } };
    const split = (t) => { const parts = []; let a = 0; top(t, (j, c) => { if (c === ',') { parts.push(t.slice(a, j)); a = j + 1; } }); parts.push(t.slice(a)); return parts; };
    const part = (t) => {
      if (!/\sif\s/.test(t) || !/\selse\s/.test(t)) return t;
      let ifAt = -1;
      let elseAt = -1;
      let colon = -1;
      top(t, (j, c) => {
        if (ifAt < 0 && c === ':') colon = j;
        const w = /\s/.test(t[j - 1] || '') && /\s/.test(t[j + (ifAt < 0 ? 2 : 4)] || '');
        if (ifAt < 0 && w && t.startsWith('if', j) && j > 0) ifAt = j;
        else if (ifAt >= 0 && w && t.startsWith('else', j)) { elseAt = j; return false; }
        return true;
      });
      if (ifAt < 0 || elseAt < 0) return t;
      const lead = t.slice(0, colon + 1);
      const A = t.slice(colon + 1, ifAt).trim();
      const C = t.slice(ifAt + 2, elseAt).trim();
      const B = part(t.slice(elseAt + 4)).trim();
      if (!A || !C || !B) return t;
      const ws = /^\s*/.exec(t.slice(colon + 1))[0];
      return lead + ws + '(' + C + ' ? ' + A + ' : ' + B + ')';
    };
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') { const j = str(s, i); out += s.slice(i, j); i = j - 1; continue; }
      if ('([{'.includes(c)) {
        const j = close(s, i);
        if (j < 0) { out += s.slice(i); break; }
        out += c + split(fixTern(s.slice(i + 1, j))).map(part).join(',') + s[j];
        i = j;
        continue;
      }
      out += c;
    }
    return split(out).map(part).join(',');
  }

  let pySigs = null;

  /** Именованные аргументы: f(a, x=1, y=(2, 3)) → f(a, { __kw: 1, x: 1, y: [2, 3] }); для своих функций (def) — по позициям. */
  function fixKw(s) {
    const skipStr = (i) => { const q = s[i]; let j = i + 1; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } return j + 1; };
    const close = (i) => { let d = 0; for (let j = i; j < s.length; j++) { const c = s[j]; if (c === '"' || c === "'" || c === '`') { j = skipStr(j) - 1; continue; } if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { d--; if (d === 0) return j; } } return -1; };
    const split = (t) => { const out = []; let d = 0; let cur = ''; for (let j = 0; j < t.length; j++) { const c = t[j]; if (c === '"' || c === "'" || c === '`') { const q = c; let k = j + 1; while (k < t.length && t[k] !== q) { if (t[k] === '\\') k++; k++; } cur += t.slice(j, k + 1); j = k; continue; } if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; if (c === ',' && d === 0) { out.push(cur); cur = ''; } else cur += c; } if (cur.trim()) out.push(cur); return out; };
    const tuple = (v) => { if (/^\(/.test(v) && close(0) === -1) return v; if (v[0] === '(' && v[v.length - 1] === ')' && split(v.slice(1, -1)).length > 1) return '[' + v.slice(1, -1) + ']'; return v; };
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') { const j = skipStr(i); out += s.slice(i, j); i = j; continue; }
      if (c === '(') {
        const j = close(i);
        if (j < 0) { out += s.slice(i); break; }
        const args = split(s.slice(i + 1, j)).map((a) => fixKw(a));
        const call = /[\w$\])]\s*$/.test(out) && !/(^|[^\w$.])(if|else|in|not|and|or|return|await)\s*$/.test(out);
        const KW =/^\s*([A-Za-z_]\w*)\s*=(?![=>])\s*([\s\S]*)$/;
        if (call && args.some((a) => KW.test(a))) {
          const pos = [];
          const kw = [];
          const kwv = new Map();
          for (const a of args) { const m = KW.exec(a); if (m) { kw.push(m[1] + ': ' + tuple(m[2].trim())); kwv.set(m[1], tuple(m[2].trim())); } else pos.push(a.trim()); }
          const fm = /(^|[^\w$.])([A-Za-z_]\w*)\s*$/.exec(out);
          const sig = fm && pySigs && pySigs.get(fm[2]);
          if (sig && [...kwv.keys()].every((k) => sig.includes(k))) {
            const list = pos.slice();
            for (let k = pos.length; k < sig.length; k++) list.push(kwv.has(sig[k]) ? kwv.get(sig[k]) : 'undefined');
            while (list.length > pos.length && list[list.length - 1] === 'undefined') list.pop();
            out += '(' + list.join(', ') + ')';
          } else out += '(' + pos.concat(['{ __kw: 1, ' + kw.join(', ') + ' }']).join(', ') + ')';
        } else if (!call && (args.length > 1 || /,\s*$/.test(s.slice(i + 1, j)))) out += '[' + args.join(',') + ']'; // кортеж (a, b) → массив
        else out += '(' + args.join(',') + ')';
        i = j + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
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
  const PY_EXC = ['Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'ZeroDivisionError', 'NameError', 'AttributeError',
    'AssertionError', 'StopIteration', 'NotImplementedError', 'OSError', 'TimeoutError', 'ConnectionError'];

  /** Строки в тройных кавычках: документирующие строки → pass, остальные → обычная строка. */
  function tripleQuotes(src) {
    src = String(src || '').replace(/^([ \t]*)(?:[rR]?"{3}[\s\S]*?"{3}|[rR]?'{3}[\s\S]*?'{3})[ \t]*$/gm, (m, ind) => ind + 'pass' + '\n'.repeat((m.match(/\n/g) || []).length));
    return src.replace(/([fF]?)("{3}|'{3})([\s\S]*?)\2/g, (m, f, q, body) => f + JSON.stringify(body));
  }

  const ASYNC_RE = /(^|[^\w$.])(sleep|delay|input)\s*\(|\btime\.sleep\s*\(|\b(requests|http)\.|\bConnectHandler\s*\(|(^|[^\w$.])ping\s*\(|\.(send_command|send_config_set|enable|disconnect|find_prompt)\s*\(/;

  /** Методы классов, которым нужен await (sleep, сеть, вызовы функций def и других таких методов); остальные — обычные. */
  function asyncMethods(lines) {
    const funcs = new Set();
    const meths = [];
    const classInd = [];
    lines.forEach((l, i) => {
      const ind = l.match(/^ */)[0].length;
      while (classInd.length && ind <= classInd[classInd.length - 1]) classInd.pop();
      if (/^\s*class\s/.test(l)) { classInd.push(ind); return; }
      const d = /^\s*def\s+([A-Za-z_]\w*)/.exec(l);
      if (!d) return;
      let j = i + 1;
      const body = [];
      while (j < lines.length && (!lines[j].trim() || lines[j].match(/^ */)[0].length > ind)) body.push(lines[j++]);
      const text = body.join('\n');
      if (classInd.length && ind > classInd[classInd.length - 1]) meths.push({ name: d[1], text });
      else funcs.add(d[1]);
    });
    const res = new Set();
    const callsFunc = (t) => [...funcs].some((f) => new RegExp('(^|[^\\w$.])' + f + '\\s*\\(').test(t));
    for (const m of meths) if (ASYNC_RE.test(m.text) || callsFunc(m.text)) res.add(m.name);
    for (let changed = true; changed;) {
      changed = false;
      for (const m of meths) {
        if (res.has(m.name)) continue;
        if ([...res].some((n) => new RegExp('\\.' + n + '\\s*\\(').test(m.text))) { res.add(m.name); changed = true; }
      }
    }
    return res;
  }

  function py2js(src) {
    const lines = logicalLines(tripleQuotes(src));
    const classes = new Set();
    let deco = null;
    const asyncMeth = asyncMethods(lines);
    // сигнатуры своих функций: f(1, b=2) → f(1, 2) по порядку параметров
    pySigs = new Map();
    for (const l of lines) {
      const d = /^\s*def\s+([A-Za-z_]\w*)\s*\((.*)\)\s*:\s*$/.exec(l);
      if (d) pySigs.set(d[1], d[2].split(',').map((x) => x.trim().replace(/=.*$/, '').trim()).filter(Boolean));
    }
    const out = [''];
    const mod = { kind: 'module', indent: -1, vars: new Set(), globals: new Set(), params: new Set(), decl: 0 };
    const stack = [mod];
    const scope = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind !== 'block') return stack[i]; return mod; };
    const pad = (n) => ' '.repeat(Math.max(0, n));
    const defs = [];
    let lastExc = null;
    const closeBlock = (b) => {
      if (b.exc) { out.push(pad(b.indent) + '} else throw __e; }'); lastExc = { indent: b.indent, idx: out.length - 1 }; return; }
      if (b.kind === 'class' && b.hasStr) out.push(pad(b.indent + 4) + 'toString() { return String((this.__str__ || this.__repr__).call(this)); }');
      else if (b.kind === 'class' && b.isErr) out.push(pad(b.indent + 4) + 'toString() { return this.message; }');
      out.push(pad(b.indent) + '}');
      if (b.kind === 'class') {
        out.push(pad(b.indent) + 'function ' + b.name + '(...__a) { const __o = new __C_' + b.name + '(...__a); if (typeof __o.__init__ === "function") __o.__init__(...__a); return __o; }');
        out.push(pad(b.indent) + b.name + '.__cls = __C_' + b.name + '; Object.setPrototypeOf(' + b.name + ', __C_' + b.name + ');');
      }
    };
    lines.forEach((raw, ln) => {
      if (!raw.trim() || /^\s*#/.test(raw)) { out.push(''); return; }
      const indent = raw.match(/^ */)[0].length;
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) closeBlock(stack.pop());
      const meth = [...stack].reverse().find((e) => e.kind === 'def');
      pySelf = meth && meth.selfName ? meth.selfName : null;
      const inClass = stack[stack.length - 1].kind === 'class' ? stack[stack.length - 1] : null;
      let text = splitStrings(raw.trim()).map(([x, s, f]) => (s ? (f ? 'f' : '') + x : x)).join('').trim();
      const p = pad(indent);
      if (/^@/.test(text)) { deco = /^@staticmethod\b/.test(text) ? 'static' : /^@classmethod\b/.test(text) ? 'class' : deco; out.push(''); return; }
      const header = /:$/.test(text) && /^(def|if|elif|else|while|for|try|except|finally|with|class)\b/.test(text);
      const open = (js, kind, extra) => { out.push(p + js + ' {'); const e = Object.assign({ kind: kind || 'block', indent }, extra || {}); stack.push(e); return e; };
      if (header) text = text.slice(0, -1).trim();
      let m;
      if (header && (m = /^def\s+([A-Za-z_]\w*)\s*\((.*)\)$/.exec(text)) && inClass) {
        const list = m[2].split(',').map((x) => x.trim()).filter(Boolean);
        const kind = deco;
        deco = null;
        const selfName = kind === 'static' ? null : (list.shift() || 'self').replace(/=.*$/, '').trim();
        const params = new Set(list.map((x) => x.replace(/=.*$/, '').replace(/^\*+/, '').trim()));
        const sync = ['__str__', '__repr__', '__len__', '__eq__'].includes(m[1]) || !asyncMeth.has(m[1]);
        if (m[1] === '__str__' || m[1] === '__repr__') inClass.hasStr = true;
        pySelf = null;
        const head = (kind ? 'static ' : '') + (sync ? '' : 'async ') + m[1] + '(' + convExpr(list.join(', ')) + ')';
        const e = open(head, 'def', { vars: new Set(), globals: new Set(), params, selfName });
        e.decl = out.length;
        out.push('');
        defs.push(e);
        return;
      }
      if (header && (m = /^def\s+([A-Za-z_]\w*)\s*\((.*)\)$/.exec(text))) {
        deco = null;
        const params = new Set(m[2].split(',').map((x) => x.trim().replace(/=.*$/, '').replace(/^\*+/, '').trim()).filter(Boolean));
        const e = open('function ' + m[1] + '(' + convExpr(m[2]) + ')', 'def', { vars: new Set(), globals: new Set(), params });
        e.decl = out.length;
        out.push('');
        defs.push(e);
        return;
      }
      if (header && (m = /^class\s+([A-Za-z_]\w*)\s*(?:\((.*)\))?$/.exec(text))) {
        const base = (m[2] || '').trim();
        const ext = !base || base === 'object' ? '' : classes.has(base) ? ' extends __C_' + base : /(Error|Exception)$/.test(base) ? ' extends Error' : '';
        if (base && !ext && base !== 'object') throw new Error('Строка ' + (ln + 1) + ': базовый класс «' + base + '» не найден — объявите его выше');
        classes.add(m[1]);
        open('class __C_' + m[1] + ext, 'class', { name: m[1], vars: new Set(), globals: new Set(), params: new Set(), hasStr: false, isErr: ext === ' extends Error' });
        return;
      }
      if (header && /^class\b/.test(text)) throw new Error('Строка ' + (ln + 1) + ': не удалось разобрать объявление класса');
      if (header && (m = /^(if|elif|while)\s+(.+)$/.exec(text))) { open((m[1] === 'elif' ? 'else if' : m[1]) + ' (' + convExpr(m[2]) + ')'); return; }
      if (header && text === 'else') { open('else'); return; }
      if (header && text === 'try') { open('try'); return; }
      if (header && text === 'finally') { open('finally'); return; }
      if (header && (m = /^except\b\s*(.*?)(?:\s+as\s+(\w+))?$/.exec(text))) {
        // except A: … except (B, C) as e: … → catch (__e) { if (A) {…} else if (B, C) {…} else throw __e; }
        const cond = m[1].trim() ? '__isinstance(__e, ' + convExpr(m[1].trim()) + ')' : 'true';
        const bind = m[2] ? ' ' + m[2] + ' = __e;' : '';
        if (m[2]) scope().vars.add(m[2]);
        let last = out.length - 1;
        while (last >= 0 && out[last] === '') last--;
        if (lastExc && lastExc.indent === indent && lastExc.idx === last) out[last] = p + '} else if (' + cond + ') {' + bind;
        else out.push(p + 'catch (__e) { if (' + cond + ') {' + bind);
        stack.push({ kind: 'block', indent, exc: true, catchVar: m[2] || '__e' });
        lastExc = null;
        return;
      }
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
      if ((m = /^raise\b\s*(.*)$/.exec(text))) {
        let ex = m[1].replace(/\s+from\s+.*$/, '').trim();
        if (!ex) { const c = [...stack].reverse().find((e) => e.catchVar); out.push(p + 'throw ' + (c ? c.catchVar : '__e') + ';'); return; }
        if (/^[A-Za-z_]\w*$/.test(ex) && (PY_EXC.includes(ex) || classes.has(ex))) ex += '()';
        out.push(p + 'throw ' + convExpr(ex) + ';');
        return;
      }
      if ((m = /^assert\s+(.+)$/.exec(text))) {
        const k = (() => { let d = 0; for (const [x, str] of splitStrings(m[1])) { if (str) continue; for (let i = 0; i < x.length; i++) { const c = x[i]; if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; else if (c === ',' && d === 0) return true; } } return false; })();
        const at = k ? m[1].lastIndexOf(',') : -1;
        out.push(p + 'if (!(' + convExpr(k ? m[1].slice(0, at) : m[1]) + ')) throw AssertionError(' + (k ? convExpr(m[1].slice(at + 1)) : '') + ');');
        return;
      }
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
      if (inClass && (m = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(text))) {
        const v = convExpr(m[2]);
        out.push(p + 'static ' + m[1] + ' = ' + v + '; ' + m[1] + ' = ' + v + ';');
        return;
      }
      if ((m = /^([A-Za-z_]\w*)\s*(=(?!=)|\+=|-=|\*=|\/=|%=|\*\*=)\s*(.+)$/.exec(text))) {
        scope().vars.add(m[1]);
        out.push(p + m[1] + ' ' + m[2] + ' ' + (m[2] === '=' && topComma(m[3]) ? '[' + convExpr(m[3]) + ']' : convExpr(m[3])) + ';');
        return;
      }
      out.push(p + convExpr(text) + ';');
    });
    while (stack.length > 1) closeBlock(stack.pop());
    pySelf = null;
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
    const show = (x) => (x instanceof Error ? (typeof (x.__str__ || x.__repr__) === 'function' ? String((x.__str__ || x.__repr__).call(x)) : x.message) : x && typeof (x.__str__ || x.__repr__) === 'function' ? String((x.__str__ || x.__repr__).call(x)) : typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x));
    const log = (...a) => io.log(a.map(show).join(' '));
    installPy();
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
      __len(x) { return x == null ? 0 : typeof x.__len__ === 'function' ? x.__len__() : typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).length : x.length; },
      __int(x) { const v = typeof x === 'string' ? parseInt(x, 10) : Math.trunc(Number(x)); if (Number.isNaN(v)) throw new Error('invalid literal for int(): ' + x); return v; },
      __min(...a) { return Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a)); },
      __max(...a) { return Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a)); },
      __list(x) { return x == null ? [] : Array.from(typeof x === 'object' && !Array.isArray(x) && !(Symbol.iterator in x) ? Object.keys(x) : x); },
      __in(a, b) { return typeof b === 'string' ? b.includes(a) : Array.isArray(b) ? b.includes(a) : b != null && Object.prototype.hasOwnProperty.call(b, a); },
      __enumerate(x) { return Array.from(x).map((v, i) => [i, v]); },
      __round(x, n) { return n ? Number(Number(x).toFixed(n)) : Math.round(Number(x)); },
      __slice(o, a, b, st) {
        const arr = typeof o === 'string' ? [...o] : Array.from(o || []);
        const n = arr.length;
        st = st == null ? 1 : Number(st);
        if (!st) throw new Error('slice step cannot be zero');
        const norm = (v, d) => (v == null ? d : v < 0 ? Math.max(st > 0 ? 0 : -1, n + v) : Math.min(v, st > 0 ? n : n - 1));
        const r = [];
        if (st > 0) for (let i = norm(a, 0); i < norm(b, n); i += st) r.push(arr[i]);
        else for (let i = norm(a, n - 1); i > norm(b, -1); i += st) r.push(arr[i]);
        return typeof o === 'string' ? r.join('') : r;
      },
      __fmt(f, v) {
        const vals = Array.isArray(v) ? v.slice() : [v];
        return String(f).replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?([sdifxXor%])/g, (m, fl, w, pr, t) => {
          if (t === '%') return '%';
          const x = vals.shift();
          let s = t === 's' ? show(x) : t === 'r' ? JSON.stringify(x) : t === 'f' ? Number(x).toFixed(pr ? Number(pr) : 6) : t === 'x' ? Math.trunc(x).toString(16) : t === 'X' ? Math.trunc(x).toString(16).toUpperCase() : t === 'o' ? Math.trunc(x).toString(8) : String(Math.trunc(Number(x)));
          if (fl.includes('+') && Number(x) >= 0 && 'dif'.includes(t)) s = '+' + s;
          const width = Number(w) || 0;
          return fl.includes('-') ? s.padEnd(width) : s.padStart(width, fl.includes('0') && 'dif'.includes(t) ? '0' : ' ');
        });
      },
      __fmtspec(v, spec) {
        const m = /^(?:(.)?([<>^]))?([+ -])?(0)?(\d*)(,)?(?:\.(\d+))?([sdfxXobe%])?$/.exec(String(spec));
        if (!m) return show(v);
        const [, fill, align, sign, zero, w, comma, pr, t] = m;
        let s;
        if (t === 'f' || (pr && !t)) s = Number(v).toFixed(Number(pr || 6));
        else if (t === '%') s = (Number(v) * 100).toFixed(Number(pr || 6)) + '%';
        else if (t === 'x') s = Math.trunc(v).toString(16);
        else if (t === 'X') s = Math.trunc(v).toString(16).toUpperCase();
        else if (t === 'b') s = Math.trunc(v).toString(2);
        else if (t === 'o') s = Math.trunc(v).toString(8);
        else if (t === 'e') s = Number(v).toExponential(Number(pr || 6));
        else if (t === 'd') s = String(Math.trunc(Number(v)));
        else s = show(v);
        if (comma) s = s.replace(/^(-?\d+)/, (d) => d.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
        if (sign === '+' && Number(v) >= 0 && typeof v === 'number') s = '+' + s;
        const width = Number(w) || 0;
        if (zero && !align) return s.padStart(width, '0');
        const al = align || (typeof v === 'number' ? '>' : '<');
        const f = fill || ' ';
        if (al === '<') return s.padEnd(width, f);
        if (al === '>') return s.padStart(width, f);
        const left = Math.floor((width - s.length) / 2);
        return width > s.length ? f.repeat(left) + s + f.repeat(width - s.length - left) : s;
      },
      __mul(a, n) {
        if (typeof a === 'string') return a.repeat(Math.max(0, Math.trunc(n)));
        if (Array.isArray(a)) { const r = []; for (let i = 0; i < n; i++) r.push(...a); return r; }
        return a * n;
      },
      __sorted(x, kw) {
        const k = kw && kw.__kw ? kw : {};
        return api.__list(x).__py_sort(k);
      },
      __sum(x, s) { return api.__list(x).reduce((a, b) => a + b, s || 0); },
      __any(x) { return api.__list(x).some(Boolean); },
      __all(x) { return api.__list(x).every(Boolean); },
      __zip(...xs) { const ls = xs.map(api.__list); const n = ls.length ? Math.min(...ls.map((l) => l.length)) : 0; const r = []; for (let i = 0; i < n; i++) r.push(ls.map((l) => l[i])); return r; },
      __reversed(x) { return api.__list(x).reverse(); },
      __filter(f, x) { return api.__list(x).filter((v) => (f ? f(v) : v)); },
      __isinstance(o, t) {
        if (Array.isArray(t)) return t.some((x) => api.__isinstance(o, x));
        if (t === String) return typeof o === 'string';
        if (t === Boolean) return typeof o === 'boolean';
        if (t === Number) return typeof o === 'number';
        if (t === api.int) return Number.isInteger(o);
        if (t === api.list) return Array.isArray(o);
        if (t === api.dict) return !!o && typeof o === 'object' && !Array.isArray(o);
        if (t && t.__cls) return o instanceof t.__cls;
        if (t && t.pyExc) return o instanceof Error && (t.pyExc === 'Exception' || o.pyName === t.pyExc || o.name === t.pyExc);
        return false;
      },
      __ord(c) { return String(c).codePointAt(0); },
      __hex(n) { return (n < 0 ? '-0x' : '0x') + Math.abs(Math.trunc(n)).toString(16); },
      __bin(n) { return (n < 0 ? '-0b' : '0b') + Math.abs(Math.trunc(n)).toString(2); },
      __divmod(a, b) { return [Math.floor(a / b), ((a % b) + b) % b]; },
      __hasattr(o, k) { return o != null && k in Object(o); },
      __getattr(o, k, d) { return o != null && k in Object(o) ? o[k] : d; },
      __setattr(o, k, v) { o[k] = v; },
      __set(x) { return [...new Set(api.__list(x))]; },
      print: log,
      console: { log, info: log, warn: log, error: log },
      Serial: { begin() {}, print: log, println: log },
      setTimeout(fn, ms) { const t = setTimeout(() => { state.timers.delete(t); if (!state.stopped) fn(); }, ms); state.timers.add(t); return t; },
      setInterval(fn, ms) { const t = setInterval(() => { if (!state.stopped) fn(); }, Math.max(10, Number(ms) || 10)); state.timers.add(t); return t; },
      clearTimeout(t) { clearTimeout(t); state.timers.delete(t); },
      clearInterval(t) { clearInterval(t); state.timers.delete(t); },
    };
    // встроенные имена Python как значения: sorted(x, key=len), isinstance(x, str)
    Object.assign(api, {
      len: (x) => api.__len(x), str: String, int: function int(x) { return api.__int(x); }, float: Number, bool: Boolean,
      list: function list(x) { return api.__list(x); },
      dict: function dict(...a) { const o = {}; for (const x of a) { if (Array.isArray(x)) for (const [k, v] of x) o[k] = v; else if (x && typeof x === 'object') for (const k of Object.keys(x)) if (k !== '__kw') o[k] = x[k]; } return o; },
      abs: Math.abs, min: (...a) => api.__min(...a), max: (...a) => api.__max(...a), sum: (x, s) => api.__sum(x, s), sorted: (x, kw) => api.__sorted(x, kw),
    });
    const arduinoMap = api.map;
    api.map = (f, ...rest) => (typeof f === 'function' ? api.__list(rest[0]).map((v) => f(v)) : arduinoMap(f, ...rest));
    for (const n of PY_EXC) {
      const f = (msg) => { const e = new Error(msg == null ? '' : String(msg)); e.name = n; e.pyName = n; e.toString = () => e.message; return e; };
      f.pyExc = n;
      api[n] = f;
    }
    if (io.request) Object.assign(api, netApi(io, log));
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

  /** Методы Python (str, list, dict) с приставкой __py_ — чтобы не пересекаться с JavaScript. */
  function installPy() {
    if (String.prototype.__py_split) return;
    const def = (proto, name, fn) => Object.defineProperty(proto, '__py_' + name, { value: fn, writable: true, configurable: true, enumerable: false });
    const list = (x) => (x == null ? [] : Array.from(typeof x === 'object' && !Array.isArray(x) && !(Symbol.iterator in x) ? Object.keys(x) : x));
    const chars = (c) => (c == null ? null : new Set(String(c)));
    const S = String.prototype;
    def(S, 'split', function (sep, max) {
      const s = String(this);
      let r = sep == null ? s.trim().split(/\s+/).filter(Boolean) : s.split(sep);
      if (max != null && max >= 0 && r.length > max + 1) r = r.slice(0, max).concat([r.slice(max).join(sep == null ? ' ' : sep)]);
      return r;
    });
    def(S, 'join', function (it) { return list(it).map(String).join(String(this)); });
    def(S, 'replace', function (a, b, n) { if (n == null || n < 0) return String(this).split(a).join(b); let s = String(this); for (let i = 0; i < n && s.includes(a); i++) s = s.replace(a, b); return s; });
    def(S, 'startswith', function (p) { return Array.isArray(p) ? p.some((x) => this.startsWith(x)) : this.startsWith(p); });
    def(S, 'endswith', function (p) { return Array.isArray(p) ? p.some((x) => this.endsWith(x)) : this.endsWith(p); });
    def(S, 'find', function (x) { return this.indexOf(x); });
    def(S, 'rfind', function (x) { return this.lastIndexOf(x); });
    def(S, 'index', function (x) { const i = this.indexOf(x); if (i < 0) throw new Error('substring not found'); return i; });
    def(S, 'count', function (x) { return x === '' ? this.length + 1 : String(this).split(x).length - 1; });
    def(S, 'format', function (...a) {
      const kw = a.length && a[a.length - 1] && a[a.length - 1].__kw ? a.pop() : {};
      let auto = 0;
      return String(this).replace(/\{\{|\}\}|\{([^{}:]*)(?::([^{}]*))?\}/g, (m, key, spec) => {
        if (m === '{{') return '{';
        if (m === '}}') return '}';
        const v = key === '' || key == null ? a[auto++] : /^\d+$/.test(key) ? a[Number(key)] : kw[key];
        return spec ? rtFmtSpec(v, spec) : v && typeof v.__str__ === 'function' ? String(v.__str__()) : String(v);
      });
    });
    def(S, 'isdigit', function () { return /^\d+$/.test(this); });
    def(S, 'isalpha', function () { return /^\p{L}+$/u.test(this); });
    def(S, 'isalnum', function () { return /^[\p{L}\d]+$/u.test(this); });
    def(S, 'isspace', function () { return /^\s+$/.test(this); });
    def(S, 'isupper', function () { return /\p{L}/u.test(this) && this.toUpperCase() === String(this); });
    def(S, 'islower', function () { return /\p{L}/u.test(this) && this.toLowerCase() === String(this); });
    const strip = (s, c, l, r) => { const set = chars(c); let a = 0; let b = s.length; const ws = (ch) => (set ? set.has(ch) : /\s/.test(ch)); if (l) while (a < b && ws(s[a])) a++; if (r) while (b > a && ws(s[b - 1])) b--; return s.slice(a, b); };
    def(S, 'strip', function (c) { return strip(String(this), c, true, true); });
    def(S, 'lstrip', function (c) { return strip(String(this), c, true, false); });
    def(S, 'rstrip', function (c) { return strip(String(this), c, false, true); });
    def(S, 'title', function () { return String(this).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); });
    def(S, 'capitalize', function () { const s = String(this); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; });
    def(S, 'zfill', function (n) { const s = String(this); const neg = /^[-+]/.test(s); return neg ? s[0] + s.slice(1).padStart(n - 1, '0') : s.padStart(n, '0'); });
    def(S, 'splitlines', function () { return String(this).split(/\r?\n/); });
    const A = Array.prototype;
    def(A, 'extend', function (it) { for (const x of list(it)) this.push(x); });
    def(A, 'insert', function (i, x) { this.splice(i < 0 ? Math.max(0, this.length + i) : i, 0, x); });
    def(A, 'remove', function (x) { const i = this.indexOf(x); if (i < 0) throw new Error('list.remove(x): x not in list'); this.splice(i, 1); });
    def(A, 'index', function (x) { const i = this.indexOf(x); if (i < 0) throw new Error(JSON.stringify(x) + ' is not in list'); return i; });
    def(A, 'count', function (x) { return this.filter((v) => v === x).length; });
    def(A, 'copy', function () { return this.slice(); });
    def(A, 'clear', function () { this.length = 0; });
    def(A, 'pop', function (i) { if (!this.length) throw new Error('pop from empty list'); if (i == null) return this.pop(); const k = i < 0 ? this.length + i : i; if (k < 0 || k >= this.length) throw new Error('pop index out of range'); return this.splice(k, 1)[0]; });
    def(A, 'sort', function (kw) {
      const k = kw && typeof kw === 'object' ? kw : {};
      const key = typeof k.key === 'function' ? k.key : (x) => x;
      const cmp = (a, b) => { const x = key(a); const y = key(b); return x < y ? -1 : x > y ? 1 : 0; };
      this.sort(cmp);
      if (k.reverse) this.reverse();
      return this;
    });
    const O = Object.prototype;
    def(O, 'get', function (k, d) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : d === undefined ? null : d; });
    def(O, 'update', function (o) { if (o && typeof o === 'object') for (const k of Object.keys(o)) if (k !== '__kw') this[k] = o[k]; });
    def(O, 'setdefault', function (k, d) { if (!Object.prototype.hasOwnProperty.call(this, k)) this[k] = d === undefined ? null : d; return this[k]; });
    def(O, 'pop', function (k, d) { if (Object.prototype.hasOwnProperty.call(this, k)) { const v = this[k]; delete this[k]; return v; } if (d !== undefined) return d; throw new Error('KeyError: ' + k); });
    def(O, 'copy', function () { return Object.assign({}, this); });
    def(O, 'clear', function () { for (const k of Object.keys(this)) delete this[k]; });
  }

  /** Спецификатор формата (для str.format вне среды выполнения программы). */
  function rtFmtSpec(v, spec) {
    const m = /^(?:(.)?([<>^]))?(0)?(\d*)(?:\.(\d+))?([sdf%])?$/.exec(String(spec));
    if (!m) return String(v);
    const [, fill, align, zero, w, pr, t] = m;
    let s = t === 'f' || (pr && !t) ? Number(v).toFixed(Number(pr || 6)) : t === '%' ? (Number(v) * 100).toFixed(Number(pr || 6)) + '%' : t === 'd' ? String(Math.trunc(v)) : String(v);
    const width = Number(w) || 0;
    if (zero && !align) return s.padStart(width, '0');
    const al = align || (typeof v === 'number' ? '>' : '<');
    s = al === '<' ? s.padEnd(width, fill || ' ') : al === '>' ? s.padStart(width, fill || ' ') : s.padStart(Math.floor((width + s.length) / 2), fill || ' ').padEnd(width, fill || ' ');
    return s;
  }

  /* ================= сеть для программ ПК ================= */

  /** requests, http, json, ConnectHandler (как netmiko), ping. io.request(kind, args) → Promise. */
  function netApi(io, log) {
    const kwOf = (args) => (args.length && args[args.length - 1] && args[args.length - 1].__kw ? args.pop() : {});
    const b64 = (str) => {
      if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(str)));
      return Buffer.from(str, 'utf8').toString('base64');
    };
    const response = (r) => ({
      status_code: r.status, status: r.status, reason: r.reason, ok: r.status >= 200 && r.status < 300, text: r.body, headers: r.headers || {}, url: r.url,
      json() { try { return JSON.parse(r.body); } catch (e) { throw new Error('Ответ не JSON: ' + String(r.body).slice(0, 80)); } },
      raise_for_status() { if (r.status >= 400) throw new Error('HTTPError: ' + r.status + ' ' + (r.reason || '')); },
    });
    async function request(method, url, ...args) {
      const kw = kwOf(args);
      const opts = Object.assign({}, args[0] && typeof args[0] === 'object' ? args[0] : {}, kw);
      const headers = Object.assign({}, opts.headers || {});
      let body = opts.data != null ? opts.data : opts.body;
      if (opts.json !== undefined) { body = JSON.stringify(opts.json); if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'; }
      if (body != null && typeof body === 'object') body = JSON.stringify(body);
      if (opts.auth) { const [u, p] = Array.isArray(opts.auth) ? opts.auth : [opts.auth.username, opts.auth.password]; headers.Authorization = 'Basic ' + b64(u + ':' + p); }
      let full = String(url);
      if (opts.params && typeof opts.params === 'object') { const q = Object.entries(opts.params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); if (q) full += (full.includes('?') ? '&' : '?') + q; }
      return response(await io.request('http', { method: String(method).toUpperCase(), url: full, headers, body, verify: opts.verify !== false }));
    }
    const requests = {
      request, get: (u, ...a) => request('GET', u, ...a), post: (u, ...a) => request('POST', u, ...a), put: (u, ...a) => request('PUT', u, ...a),
      patch: (u, ...a) => request('PATCH', u, ...a), delete: (u, ...a) => request('DELETE', u, ...a),
    };
    async function ConnectHandler(...args) {
      const kw = kwOf(args);
      const o = Object.assign({}, args[0] && typeof args[0] === 'object' ? args[0] : {}, kw);
      const host = o.host || o.ip;
      if (!host) throw new Error('ConnectHandler: укажите host');
      const proto = /telnet/i.test(String(o.device_type || '')) ? 'telnet' : 'ssh';
      const r = await io.request('ssh.connect', { host, proto, username: o.username, password: o.password, secret: o.secret });
      const sid = r.sid;
      return {
        host,
        async send_command(cmd) { return io.request('ssh.send', { sid, cmd: String(cmd) }); },
        async send_config_set(cmds) { return io.request('ssh.config', { sid, cmds: Array.isArray(cmds) ? cmds.map(String) : [String(cmds)] }); },
        async enable() { return io.request('ssh.enable', { sid }); },
        async find_prompt() { return io.request('ssh.prompt', { sid }); },
        async disconnect() { return io.request('ssh.close', { sid }); },
      };
    }
    async function ping(host, count) {
      const kw = typeof count === 'object' && count ? count : {};
      const r = await io.request('ping', { host: String(host), count: kw.count || (typeof count === 'number' ? count : 2) });
      return Object.assign({ ok: r.received > 0 }, r);
    }
    const json = {
      dumps(o, ...a) { const kw = kwOf(a); return JSON.stringify(o, null, kw.indent != null ? kw.indent : a[0] && a[0].indent); },
      loads: (t) => JSON.parse(String(t)),
    };
    return { requests, http: requests, ConnectHandler, ping, json, __kwOf: kwOf, log };
  }

  const rt = { transform, run, pinName, py2js, blocksToJs, netApi };
  root.NetLab = root.NetLab || {};
  root.NetLab.scriptRt = rt;
  if (typeof module === 'object' && module.exports) module.exports = rt;
})(typeof self !== 'undefined' ? self : globalThis);
