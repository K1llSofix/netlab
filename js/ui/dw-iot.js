/* NetLab UI — вкладки новых устройств:
 *  «Устройство» у умных вещей (кнопки и датчики, как Alt+щелчок в Packet Tracer),
 *  «Программирование» у плат MCU-PT / SBC-PT (редактор, запуск в Web Worker, консоль, состояние пинов),
 *  «Компонент» у датчиков и исполнительных устройств, «Телефон» у IP-телефона 7960
 *  (тот же виджет — в программе IP Communicator). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const I = NS.iot;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });
  const bigIcon = (dev) => UI.svgFrom(UI.deviceIconFor(dev), { viewBox: '0 0 64 48', width: 128, height: 96, class: 'big-icon' });

  /* ================= умное устройство ================= */

  DW.thingTab = function (app, id) {
    const tab = {
      id: 'thing',
      label: 'Устройство',
      render(body) {
        const dev = app.net.getDevice(id);
        const k = I.KINDS[dev.thing.kind];
        const e = err();
        const iconBox = h('div', { class: 'thing-icon' }, bigIcon(dev));
        const rows = [];
        for (const [prop, meta] of Object.entries(k.props)) {
          const v = dev.thing.state[prop];
          const set = (val) => DW.apply(app, () => { const r = app.net.getDevice(id).thingSet(prop, val, 'local'); if (r) throw new Error(r); }, e);
          let ctl;
          if (meta.type === 'bool') ctl = UI.toggle(meta.labels[v ? 1 : 0], !!v, (on) => set(on));
          else if (meta.type === 'enum') ctl = h('div', { class: 'seg' }, meta.values.map((x, i) => h('button', { class: 'btn small ' + (x === v ? 'primary' : 'outline'), onClick: () => set(x) }, meta.labels[i])));
          else {
            const r = h('input', { type: 'range', min: meta.min, max: meta.max, step: 1, value: v, class: 'range' });
            const out = h('span', { class: 'mono' }, v + ' ' + meta.unit);
            r.addEventListener('input', () => { out.textContent = r.value + ' ' + meta.unit; });
            r.addEventListener('change', () => set(Number(r.value)));
            ctl = h('div', { class: 'row' }, r, out);
          }
          rows.push(lbl((meta.sensor ? 'Датчик: ' : '') + (meta.title || prop)), ctl);
        }
        const stat = h('div', { class: 'hint-box' });
        body.append(h('div', { class: 'thing-panel' }, iconBox, h('div', { class: 'grow' },
          h('div', { class: 'desk-subtitle' }, k.title + ' · ' + dev.model),
          DW.form(...rows, h('div', { class: 'full' }, e)), stat)),
        h('div', { class: 'hint-box', style: { marginTop: '12px' } }, 'Управлять можно здесь (как Alt+щелчок в Packet Tracer), из IoT Monitor на компьютере или правилами IoT-сервера. ' +
          (Object.values(k.props).some((m) => m.sensor) ? 'Это датчик: меняя его значение, вы имитируете событие (движение, нагрев, дым) — сервер передаст его правилам.' : 'Команды сервера приходят по сети (TCP 1883).')));
        tab.live = () => {
          const d = app.net.getDevice(id);
          if (!d) return;
          UI.clear(iconBox);
          iconBox.appendChild(bigIcon(d));
          stat.textContent = d.iot.server === 'off' ? 'IoT-сервер не задан — вкладка «Настройка» → «IoT-сервер».' : d.iotRt.text;
          stat.className = 'hint-box' + (d.iotRt.state === 'registered' ? '' : ' warn');
        };
        tab.live();
      },
      live: null,
    };
    return tab;
  };

  /* ================= компонент ================= */

  DW.compTab = function (app, id) {
    const tab = {
      id: 'comp',
      label: 'Компонент',
      render(body) {
        const dev = app.net.getDevice(id);
        const info = dev.info;
        const iconBox = h('div', { class: 'thing-icon' }, bigIcon(dev));
        const set = (v) => { NS.iot.setComp(app.net.getDevice(id), v); app.needRender = true; };
        let ctl;
        if (!info.in) ctl = h('div', { class: 'muted' }, 'Исполнительное устройство: состоянием управляет программа платы.');
        else if (info.analog) {
          const r = h('input', { type: 'range', min: 0, max: 1023, value: dev.value, class: 'range' });
          const out = h('span', { class: 'mono' }, String(dev.value));
          r.addEventListener('input', () => { out.textContent = r.value; set(Number(r.value)); });
          ctl = h('div', { class: 'row' }, r, out);
        } else if (info.kind === 'button') {
          const b = h('button', { class: 'btn primary' }, 'Нажать и держать');
          b.addEventListener('pointerdown', () => set(1));
          for (const ev of ['pointerup', 'pointerleave']) b.addEventListener(ev, () => { if (app.net.getDevice(id).value) set(0); });
          ctl = b;
        } else ctl = UI.toggle(dev.value ? 'Включено' : 'Выключено', !!dev.value, (on) => set(on ? 1 : 0));
        const conn = h('div');
        body.append(h('div', { class: 'thing-panel' }, iconBox, h('div', { class: 'grow' },
          h('div', { class: 'desk-subtitle' }, info.title + ' · ' + dev.model), DW.form(lbl(info.in ? 'Значение' : 'Состояние'), ctl), conn)));
        tab.live = () => {
          const d = app.net.getDevice(id);
          if (!d) return;
          UI.clear(iconBox);
          iconBox.appendChild(bigIcon(d));
          const b = NS.iot.boardOf(d);
          UI.clear(conn);
          conn.append(h('div', { class: 'hint-box' + (b ? '' : ' warn') }, b ? 'Подключён к ' + b.board.name + ', пин ' + b.pin + '. Значение: ' + d.value : 'Не подключён — соедините IoT-кабелем с пином платы MCU-PT или SBC-PT.'));
        };
        tab.live();
      },
      live: null,
    };
    return tab;
  };

  /* ================= программирование ================= */

  const TEMPLATES = [
    ['blink', 'Мигание светодиодом (D0)', I.DEFAULT_CODE],
    ['button', 'Кнопка (D1) включает светодиод (D0)', '// Кнопка на D1, светодиод на D0\nfunction setup() {\n  pinMode(0, OUTPUT);\n  pinMode(1, INPUT);\n}\n\nfunction loop() {\n  if (digitalRead(1) === HIGH) digitalWrite(0, HIGH);\n  else digitalWrite(0, LOW);\n  delay(50);\n}\n'],
    ['pot', 'Потенциометр (A0) → мотор (D2)', '// Потенциометр на A0 управляет скоростью мотора на D2\nfunction setup() {\n  pinMode(2, OUTPUT);\n}\n\nfunction loop() {\n  const v = analogRead(A0);\n  analogWrite(2, v);\n  Serial.println("A0 = " + v);\n  delay(500);\n}\n'],
    ['alarm', 'Датчик движения (D3) → зуммер (D4)', '// Датчик движения на D3, зуммер на D4\nlet count = 0;\n\nfunction setup() {\n  pinMode(4, OUTPUT);\n}\n\nfunction loop() {\n  if (digitalRead(3) === HIGH) {\n    count++;\n    print("Движение! Срабатываний: " + count);\n    for (let i = 0; i < 3; i++) {\n      digitalWrite(4, HIGH);\n      delay(200);\n      digitalWrite(4, LOW);\n      delay(200);\n    }\n  }\n  delay(100);\n}\n'],
    ['temp', 'Термодатчик (A1) → вентилятор-мотор (D2)', '// Датчик температуры на A1: 0..1023 → -40..80 °C\nfunction celsius(raw) {\n  return Math.round(raw * 120 / 1023 - 40);\n}\n\nfunction loop() {\n  const t = celsius(analogRead(A1));\n  digitalWrite(2, t > 28 ? HIGH : LOW);\n  print("Температура: " + t + " °C");\n  delay(1000);\n}\n'],
  ];

  /** Запущенные программы плат (продолжают работать при закрытом окне, как в Packet Tracer). */
  const running = new Map();
  UI.programs = running;

  function stopProgram(id, why) {
    const r = running.get(id);
    if (!r) return;
    running.delete(id);
    clearInterval(r.timer);
    try { r.worker.terminate(); } catch (e) { /* ignore */ }
    r.log.push({ kind: 'info', text: '■ Программа остановлена' + (why ? ': ' + why : '') });
    r.onChange();
  }

  const PY_BLINK = '# Мигание светодиодом на пине D0 (Python)\nfrom gpio import *\nfrom time import *\n\ndef main():\n    pinMode(0, OUT)\n    print("Старт")\n    while True:\n        digitalWrite(0, HIGH)\n        sleep(0.5)\n        digitalWrite(0, LOW)\n        sleep(0.5)\n\nif __name__ == "__main__":\n    main()\n';
  const PY_TEMPLATES = [
    ['blink', 'Мигание светодиодом (D0)', PY_BLINK],
    ['button', 'Кнопка (D1) включает светодиод (D0)', '# Кнопка на D1, светодиод на D0\nfrom gpio import *\nfrom time import *\n\ndef main():\n    pinMode(0, OUT)\n    pinMode(1, IN)\n    while True:\n        if digitalRead(1) == HIGH:\n            digitalWrite(0, HIGH)\n        else:\n            digitalWrite(0, LOW)\n        delay(50)\n\nif __name__ == "__main__":\n    main()\n'],
    ['pot', 'Потенциометр (A0) → мотор (D2)', '# Потенциометр на A0 управляет мотором на D2\nfrom gpio import *\nfrom time import *\n\ndef main():\n    pinMode(2, OUT)\n    while True:\n        v = analogRead(A0)\n        analogWrite(2, v)\n        print("A0 =", v)\n        sleep(0.5)\n\nif __name__ == "__main__":\n    main()\n'],
  ];
  const LANGS = [['js', 'JavaScript'], ['python', 'Python'], ['blocks', 'Блоки']];
  const RT = NS.scriptRt;
  /** Код и язык для запуска: блоки собираются в JavaScript. */
  function runnable(p) {
    if (p.lang === 'blocks') return { code: RT.blocksToJs(p.blocks || DW.defaultBlocks()), lang: 'js' };
    return { code: p.code, lang: p.lang === 'python' ? 'python' : 'js' };
  }

  function startProgram(app, id, logs, onChange) {
    stopProgram(id);
    const dev = app.net.getDevice(id);
    if (!dev || !dev.power) { logs.push({ kind: 'err', text: 'Плата выключена' }); onChange(); return; }
    let worker;
    try {
      worker = new Worker('js/ui/script-worker.js');
    } catch (e) {
      logs.push({ kind: 'err', text: 'Не удалось запустить поток программы: ' + e.message });
      onChange();
      return;
    }
    const r = { worker, log: logs, onChange, last: '' };
    running.set(id, r);
    logs.push({ kind: 'info', text: '▶ Программа запущена' });
    const push = () => {
      const d = app.net.getDevice(id);
      if (!d || !d.power) { stopProgram(id, d ? 'плата выключена' : 'плата удалена'); return; }
      const v = I.inputs(d);
      const js = JSON.stringify(v);
      if (js !== r.last) { r.last = js; worker.postMessage({ type: 'inputs', values: v }); }
    };
    r.timer = setInterval(push, 60);
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      const d = app.net.getDevice(id);
      if (!d) { stopProgram(id, 'плата удалена'); return; }
      if (m.type === 'write') { I.write(d, m.pin, m.value); app.needRender = true; } else if (m.type === 'log' || m.type === 'error') {
        logs.push({ kind: m.type === 'error' ? 'err' : 'out', text: m.text });
        if (logs.length > 400) logs.splice(0, logs.length - 400);
        onChange();
      } else if (m.type === 'done') stopProgram(id, 'программа завершилась');
    };
    worker.onerror = (e) => { logs.push({ kind: 'err', text: 'Ошибка потока: ' + (e.message || e) }); stopProgram(id); };
    const rp = runnable(I.program(dev));
    worker.postMessage({ type: 'run', code: rp.code, lang: rp.lang, inputs: I.inputs(dev) });
    onChange();
  }

  DW.programTab = function (app, id) {
    const st = app.deskState(id);
    const tab = {
      id: 'program',
      label: 'Программирование',
      keep: true,
      flush: true,
      render(body) {
        const dev = app.net.getDevice(id);
        st.progLog = st.progLog || [];
        const ta = h('textarea', { class: 'code-editor mono', spellcheck: 'false', wrap: 'off' });
        ta.value = I.program(dev).code;
        const prog0 = I.program(dev);
        const lang = () => I.program(app.net.getDevice(id)).lang || 'js';
        let saveT = null;
        const save = () => {
          clearTimeout(saveT);
          saveT = null;
          const d = app.net.getDevice(id);
          if (d && I.program(d).code !== ta.value) app.mutate(() => { I.program(d).code = ta.value; });
        };
        ta.addEventListener('input', () => { clearTimeout(saveT); saveT = setTimeout(save, 800); });
        ta.addEventListener('blur', save);
        ta.addEventListener('keydown', (ev) => {
          if (ev.key === 'Tab') {
            ev.preventDefault();
            const a = ta.selectionStart;
            ta.setRangeText(lang() === 'python' ? '    ' : '  ', a, ta.selectionEnd, 'end');
          } else if (ev.key === 'Enter' && ev.ctrlKey) { ev.preventDefault(); run(); }
        });
        const con = h('div', { class: 'gen-log prog-console' });
        const pins = h('div', { class: 'pin-grid' });
        const runBtn = h('button', { class: 'btn primary small' });
        const drawLog = () => {
          UI.clear(con);
          for (const l of st.progLog.slice(-200)) con.appendChild(h('div', { class: l.kind === 'err' ? 'fail' : l.kind === 'info' ? 'done' : '' }, l.text));
          con.scrollTop = con.scrollHeight;
          runBtn.textContent = running.has(id) ? '■ Остановить' : '▶ Запустить';
        };
        const onChange = () => { if (con.isConnected) drawLog(); else if (!running.has(id)) runBtn.textContent = '▶ Запустить'; };
        const run = () => {
          if (running.has(id)) { stopProgram(id); return; }
          save();
          startProgram(app, id, st.progLog, onChange);
        };
        runBtn.addEventListener('click', run);
        const r = running.get(id);
        if (r) r.onChange = onChange;
        const tplList = () => (lang() === 'python' ? PY_TEMPLATES : TEMPLATES);
        const tpl = DW.select([['', 'Шаблоны…']].concat(TEMPLATES.map((t) => [t[0], t[1]])), '', async (v) => {
          if (lang() === 'blocks') { tpl.value = ''; return; }
          const t = tplList().find((x) => x[0] === v);
          tpl.value = '';
          if (!t) return;
          if (ta.value.trim() && ta.value !== t[2] && !(await UI.confirm('Шаблон', 'Заменить текущую программу шаблоном «' + t[1] + '»?', 'Заменить'))) return;
          ta.value = t[2];
          save();
        });
        // редактор блоков и предпросмотр кода
        const blocksBox = h('div', { class: 'blocks-wrap' });
        const genPre = h('pre', { class: 'code-editor mono blocks-code' });
        const editor = h('div', { class: 'prog-editor' }, ta, blocksBox);
        const langNote = h('span', { class: 'muted small' });
        const sideHint = h('div', { class: 'hint-box small' });
        const setProg = (fn) => { const d = app.net.getDevice(id); if (d) app.mutate(() => fn(I.program(d))); };
        const showLang = () => {
          const l = lang();
          ta.style.display = l === 'blocks' ? 'none' : '';
          blocksBox.style.display = l === 'blocks' ? '' : 'none';
          UI.clear(tpl);
          tpl.append(h('option', { value: '' }, l === 'blocks' ? 'Шаблоны — для кода' : 'Шаблоны…'), ...tplList().map((t) => h('option', { value: t[0] }, t[1])));
          langNote.textContent = l === 'python' ? 'Python · main() или setup()/loop() · Ctrl+Enter — запуск' : l === 'blocks' ? 'Блоки · собираются в JavaScript' : 'JavaScript · setup() и loop() · Ctrl+Enter — запуск';
          sideHint.textContent = l === 'python'
            ? 'from gpio import * · pinMode(0, OUT) · digitalWrite(0, HIGH) · digitalRead(1) · analogRead(A0) · analogWrite(2, 512) · sleep(0.5) / delay(500) · print(…). Поддерживается основное подмножество Python: def, if/elif/else, while, for … in range(), списки, f-строки.'
            : l === 'blocks' ? 'Соберите программу из блоков: «При запуске» выполняется один раз, «Повторять» — по кругу. Ниже — код, который получится; его можно перенести в редактор JavaScript.'
              : 'pinMode(0, OUTPUT); digitalWrite(0, HIGH); digitalRead(1); analogRead(A0); analogWrite(2, 512); delay(500); Serial.println("…"). Программа работает в отдельном потоке без доступа к сети и файлам.';
          if (l === 'blocks') {
            const work = JSON.parse(JSON.stringify(I.program(app.net.getDevice(id)).blocks || DW.defaultBlocks()));
            UI.clear(blocksBox);
            const upd = () => { genPre.textContent = RT.blocksToJs(work); };
            blocksBox.append(DW.blocksEditor(work, () => { setProg((x) => { x.blocks = JSON.parse(JSON.stringify(work)); }); upd(); }), h('div', { class: 'section-title' }, 'Код из блоков'), genPre,
              h('button', { class: 'btn outline small', onClick: async () => {
                if (!(await UI.confirm('Блоки → JavaScript', 'Перенести код в редактор JavaScript? Блоки сохранятся, к ним можно вернуться.', 'Перенести'))) return;
                setProg((x) => { x.code = RT.blocksToJs(x.blocks); x.lang = 'js'; });
                ta.value = I.program(app.net.getDevice(id)).code;
                langSel.value = 'js';
                showLang();
              } }, 'Перенести в JavaScript'));
            upd();
          }
        };
        const langSel = DW.select(LANGS, prog0.lang || 'js', async (v) => {
          if (running.has(id)) stopProgram(id);
          save();
          const p = I.program(app.net.getDevice(id));
          if (v === 'python' && p.lang !== 'python') {
            const jsLike = /\bfunction\b/.test(p.code);
            if (jsLike && (p.code === I.DEFAULT_CODE || await UI.confirm('Python', 'Заменить программу примером на Python? (текущий код JavaScript будет потерян)', 'Заменить'))) {
              setProg((x) => { x.code = PY_BLINK; });
              ta.value = PY_BLINK;
            }
          }
          if (v === 'js' && p.lang === 'python' && !/\bfunction\b/.test(p.code)) {
            setProg((x) => { x.code = I.DEFAULT_CODE; });
            ta.value = I.DEFAULT_CODE;
          }
          setProg((x) => { x.lang = v === 'js' ? undefined : v; if (v === 'blocks' && !x.blocks) x.blocks = DW.defaultBlocks(); });
          if (!prog0.lang && v === 'js') delete I.program(app.net.getDevice(id)).lang;
          showLang();
        }, { style: { width: '130px' } });
        body.append(h('div', { class: 'prog' },
          h('div', { class: 'prog-bar' }, runBtn, h('button', { class: 'btn outline small', onClick: () => { st.progLog.length = 0; drawLog(); } }, 'Очистить консоль'), langSel, tpl,
            h('span', { class: 'grow' }), langNote),
          h('div', { class: 'prog-main' }, editor, h('div', { class: 'prog-side' }, h('div', { class: 'section-title' }, 'Пины'), pins, sideHint)),
          h('div', { class: 'section-title' }, 'Консоль'), con));
        showLang();
        drawLog();
        tab.live = () => {
          const d = app.net.getDevice(id);
          if (!d) return;
          const sig = JSON.stringify(I.PINS.map((p) => { const c = I.compAt(d, p); return [p, c ? c.id + ':' + c.value : '', d.pinOut ? d.pinOut[p] : null]; }));
          if (sig !== pins.dataset.sig) {
            pins.dataset.sig = sig;
            UI.clear(pins);
            for (const p of I.PINS) {
              const c = I.compAt(d, p);
              const out = d.pinOut && d.pinOut[p] != null ? d.pinOut[p] : null;
              const val = c && c.info.in ? c.value : out;
              pins.append(h('div', { class: 'pin' + (val ? ' hi' : '') }, h('b', null, p), h('span', null, c ? c.info.title : '—'), h('span', { class: 'mono' }, val == null ? '' : String(val))));
            }
          }
          if (!running.has(id) && runBtn.textContent !== '▶ Запустить') runBtn.textContent = '▶ Запустить';
        };
        tab.live();
      },
      live: null,
    };
    return tab;
  };

  // перезапуск/удаление платы останавливает программу
  UI.stopAllPrograms = function () { for (const id of [...running.keys()]) stopProgram(id, 'схема заменена'); };

  /* ================= телефон (7960 и IP Communicator) ================= */

  /** Виджет телефона. getClient() → SccpClient. Возвращает live-функцию. */
  DW.phoneWidget = function (app, id, getClient, box, st) {
    const ps = (st.phone = st.phone || { digits: '', say: '' });
    const screen = h('div', { class: 'phone-screen' });
    const digits = h('div', { class: 'phone-digits mono' });
    const e = err();
    const act = (fn) => { const r = fn(getClient()); if (r) e.textContent = r; else e.textContent = ''; app.needRender = true; app.scheduleRefresh(); };
    const key = (k) => h('button', { class: 'btn outline phone-key', onClick: () => { if (ps.digits.length < 16) ps.digits += k; digits.textContent = ps.digits || ' '; } }, k);
    const keypad = h('div', { class: 'phone-keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(key));
    const sayI = h('input', { class: 'inp', placeholder: 'Сказать в трубку…', value: ps.say });
    sayI.addEventListener('input', () => { ps.say = sayI.value; });
    const say = () => { act((c) => c.say(sayI.value || '…')); ps.say = ''; sayI.value = ''; };
    DW.onEnter(sayI, say);
    const heard = h('div', { class: 'gen-log phone-heard' });
    box.append(h('div', { class: 'phone' },
      h('div', { class: 'phone-left' }, screen, digits, keypad,
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn primary small', onClick: () => { const n = ps.digits; act((c) => c.dial(n)); ps.digits = ''; digits.textContent = ' '; } }, '📞 Вызов'),
          h('button', { class: 'btn outline small', onClick: () => act((c) => c.answer()) }, 'Ответить'),
          h('button', { class: 'btn outline small danger', onClick: () => act((c) => { c.hangup(); return null; }) }, 'Положить'),
          h('button', { class: 'btn icon small', title: 'Стереть', onClick: () => { ps.digits = ps.digits.slice(0, -1); digits.textContent = ps.digits || ' '; } }, '⌫')),
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { class: 'btn outline small', title: 'Поставить разговор на удержание (Hold)', onClick: () => act((c) => c.hold()) }, '⏸ Удержать'),
          h('button', { class: 'btn outline small', title: 'Вернуться к разговору (Resume)', onClick: () => act((c) => c.resume()) }, '▶ Вернуть'),
          h('button', { class: 'btn outline small', title: 'Слепой перевод: соединить собеседника с набранным номером', onClick: () => { const n = ps.digits; act((c) => c.transfer(n)); ps.digits = ''; digits.textContent = ' '; } }, '↪ Перевести')), e),
      h('div', { class: 'phone-right' }, h('div', { class: 'section-title' }, 'Разговор (RTP)'), h('div', { class: 'row' }, sayI, h('button', { class: 'btn small', onClick: say }, 'Сказать')), heard)));
    digits.textContent = ps.digits || ' ';
    return () => {
      const c = getClient();
      UI.clear(screen);
      if (!c) { screen.append(h('div', null, 'Выключен')); return; }
      const call = c.call;
      screen.append(
        h('div', { class: 'ps-top' }, h('span', null, c.number ? 'Линия ' + c.number : 'Нет номера'), h('span', null, c.state === 'registered' ? '● CME' : '○')),
        h('div', { class: 'ps-main' }, call ? call.text : c.state === 'registered' ? (c.message || 'Готов') : c.text || '—'),
        h('div', { class: 'ps-sub' }, call && call.state === 'ringing' ? '🔔 Звонок! Нажмите «Ответить»' : call && call.state === 'connected' && call.hold ? '⏸ На удержании — «Вернуть»; или наберите номер и «Перевести»' : call && call.state === 'connected' && call.remoteHold ? '♫ Музыка ожидания' : call && call.state === 'connected' ? 'Голос идёт напрямую на ' + U.ipStr(call.peerIp) + ' · для перевода наберите номер и «Перевести»' : call ? 'Ждём ответа… («Положить» — отменить)' : c.state === 'registered' ? 'Наберите номер и нажмите «Вызов»' : ''));
      screen.className = 'phone-screen' + (call && call.state === 'ringing' ? ' ringing' : '');
      UI.clear(heard);
      for (const x of c.heard.slice(-30)) heard.appendChild(h('div', null, '🔊 ' + x.from + ': ' + x.text));
      if (!c.heard.length) heard.appendChild(h('div', { class: 'muted' }, 'Здесь появится то, что говорит собеседник.'));
    };
  };

  DW.phoneTab = function (app, id) {
    const st = app.deskState(id);
    const tab = {
      id: 'phone',
      label: 'Телефон',
      keep: true,
      render(body) {
        const dev = app.net.getDevice(id);
        const warn = h('div');
        body.append(warn);
        const live = DW.phoneWidget(app, id, () => { const d = app.net.getDevice(id); return d && d.power ? d.sccp : null; }, body, st);
        tab.live = () => {
          const d = app.net.getDevice(id);
          if (!d) return;
          UI.clear(warn);
          if (!d.power) warn.append(h('div', { class: 'hint-box warn', style: { marginBottom: '8px' } }, 'Нет питания: подключите адаптер на вкладке «Физический вид» или подключите телефон к PoE-коммутатору 3560-24PS.'));
          live();
        };
        tab.live();
        void dev;
      },
      live: null,
    };
    return tab;
  };
})(globalThis.NetLab = globalThis.NetLab || {});
