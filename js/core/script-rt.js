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

  const pinName = (p) => (typeof p === 'number' || /^\d+$/.test(String(p)) ? 'D' + Number(p) : String(p).toUpperCase());

  /**
   * Запустить программу. io: read(pin, 'digital'|'analog') → число, write(pin, value), mode(pin, mode),
   * log(text), error(text), done(). Возвращает { stop() }.
   */
  function run(code, io) {
    const state = { stopped: false, timers: new Set(), start: Date.now() };
    const out = {};
    const handle = { stop() { state.stopped = true; for (const t of state.timers) { clearTimeout(t); clearInterval(t); } state.timers.clear(); } };
    const log = (...a) => io.log(a.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x))).join(' '));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const api = {
      HIGH: 1, LOW: 0, INPUT: 'INPUT', OUTPUT: 'OUTPUT', INPUT_PULLUP: 'INPUT_PULLUP',
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

  const rt = { transform, run, pinName };
  root.NetLab = root.NetLab || {};
  root.NetLab.scriptRt = rt;
  if (typeof module === 'object' && module.exports) module.exports = rt;
})(typeof self !== 'undefined' ? self : globalThis);
