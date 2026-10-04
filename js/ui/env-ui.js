/* NetLab UI — среда IoT: значки новых умных устройств и окно «Среда» (время суток, погода, пожар, люди)
 * с показаниями в помещении. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const E = NS.env;

  const TXT = (x, y, t, c, size) => '<text x="' + x + '" y="' + y + '" font-size="' + (size || 10) + '" font-weight="700" text-anchor="middle" fill="' + c + '" font-family="Segoe UI, sans-serif">' + t + '</text>';
  const box = '<rect x="12" y="8" width="40" height="32" rx="6" fill="#f8fafc" stroke="#64748b" stroke-width="1.8"/>';

  Object.assign(UI.THING_ICONS, {
    light(st) {
      const v = Number(st.value) || 0;
      return box + '<circle cx="24" cy="24" r="' + (4 + v / 20).toFixed(1) + '" fill="#fbbf24" opacity="' + (0.35 + v / 160).toFixed(2) + '"/>' + TXT(40, 28, Math.round(v) + '%', '#a16207', 9);
    },
    humidity(st) {
      const v = Number(st.value) || 0;
      return box + '<path d="M24 14c4 6 7 9 7 13a7 7 0 0 1-14 0c0-4 3-7 7-13z" fill="#38bdf8" stroke="#0369a1" stroke-width="1.2"/>' + TXT(42, 28, Math.round(v) + '%', '#0369a1', 9);
    },
    co2(st) {
      const v = Number(st.value) || 400;
      const c = v >= 1500 ? '#dc2626' : v >= 1000 ? '#d97706' : '#16a34a';
      return box + TXT(32, 22, 'CO₂', '#334155', 9) + TXT(32, 34, Math.round(v), c, 9);
    },
    heater(st) {
      const on = !!st.on;
      return '<rect x="10" y="12" width="44" height="26" rx="4" fill="' + (on ? '#fed7aa' : '#e5e7eb') + '" stroke="#9a3412" stroke-width="1.8"/>' +
        [18, 26, 34, 42].map((x) => '<rect x="' + (x - 2) + '" y="16" width="4" height="18" rx="2" fill="' + (on ? '#ea580c' : '#94a3b8') + '"/>').join('') +
        (on ? '<path d="M20 8c2-3-2-4 0-7M32 8c2-3-2-4 0-7M44 8c2-3-2-4 0-7" stroke="#ea580c" stroke-width="1.6" fill="none"/>' : '') + '<rect x="14" y="38" width="4" height="5" fill="#475569"/><rect x="46" y="38" width="4" height="5" fill="#475569"/>';
    },
    ac(st) {
      const on = !!st.on;
      return '<rect x="6" y="10" width="52" height="20" rx="5" fill="#f1f5f9" stroke="#475569" stroke-width="1.8"/><rect x="12" y="24" width="40" height="3" rx="1.5" fill="#94a3b8"/>' +
        '<circle cx="50" cy="16" r="2" fill="' + (on ? '#22c55e' : '#94a3b8') + '"/>' + (on ? '<path d="M18 34v8M26 34v10M34 34v8M42 34v10" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>' + TXT(28, 20, '❄', '#0284c7', 9) : '');
    },
    blinds(st) {
      const open = st.open !== false;
      let s = '<rect x="12" y="4" width="40" height="3" rx="1" fill="#475569"/>';
      for (let i = 0; i < 7; i++) s += '<rect x="13" y="' + (9 + i * 5) + '" width="38" height="' + (open ? 1.5 : 4.4) + '" rx="1" fill="#cbd5e1" stroke="#64748b" stroke-width=".6"/>';
      return (open ? '<rect x="13" y="8" width="38" height="36" fill="#bae6fd"/>' : '') + s + '<path d="M50 7v' + (open ? 12 : 30) + '" stroke="#64748b" stroke-width="1.2"/>';
    },
    sprinkler(st) {
      const on = !!st.on;
      return '<rect x="10" y="40" width="44" height="5" rx="2" fill="#65a30d"/><rect x="29" y="28" width="6" height="12" fill="#475569"/><rect x="25" y="24" width="14" height="5" rx="2" fill="#334155"/>' +
        (on ? '<path d="M32 22C24 10 14 12 8 20M32 22c8-12 18-10 24-2M32 22V6" stroke="#38bdf8" stroke-width="2" fill="none" stroke-dasharray="3 3"/>' : '');
    },
  });

  /* ================= окно «Среда» ================= */

  UI.envDialog = function (app) {
    UI.windows.open({
      id: 'env', title: 'Среда', sub: 'IoT: время, погода, условия в помещении', width: 560, height: 560,
      tabs: [{
        id: 'main', label: 'Среда', keep: true,
        render(body) {
          const net = () => app.net;
          const e = E.get(net());
          const set = (patch) => { app.mutate(() => E.set(net(), patch)); };
          const slider = (min, max, step, val, fn) => { const r = h('input', { type: 'range', min, max, step, value: val, class: 'env-range' }); r.addEventListener('input', () => fn(Number(r.value))); return r; };
          const clockT = h('b', { class: 'mono' }, E.clockText(e.clock));
          const tempT = h('b', null, e.outTemp + ' °C');
          const humT = h('b', null, e.humidity + ' %');
          const co2T = h('b', null, e.co2 + ' ppm');
          const onBox = h('input', { type: 'checkbox', checked: e.on });
          onBox.addEventListener('change', () => set({ on: onBox.checked }));
          const run = h('input', { type: 'checkbox', checked: e.run });
          run.addEventListener('change', () => set({ run: run.checked }));
          const speed = UI.h('select', { class: 'inp', style: { width: 'auto' } }, [[1, '1 мин/с'], [5, '5 мин/с'], [10, '10 мин/с'], [30, '30 мин/с'], [60, '1 час/с']].map(([v, t]) => h('option', { value: v }, t)));
          speed.value = String(e.speed);
          speed.addEventListener('change', () => set({ speed: Number(speed.value) }));
          const fire = h('input', { type: 'checkbox', checked: e.fire });
          fire.addEventListener('change', () => set({ fire: fire.checked }));
          const people = h('input', { type: 'checkbox', checked: e.people });
          people.addEventListener('change', () => set({ people: people.checked }));
          const clockR = slider(0, 1439, 5, Math.round(e.clock), (v) => { E.set(net(), { clock: v }); clockT.textContent = E.clockText(v); });
          const out = h('div', { class: 'env-read' });
          body.append(
            h('label', { class: 'row', style: { marginBottom: '8px' } }, onBox, h('b', null, 'Моделировать среду'), h('span', { class: 'muted small' }, '— датчики IoT сами получают значения')),
            h('div', { class: 'form' },
              h('label', null, 'Время суток'), h('div', { class: 'row' }, clockR, clockT),
              h('label', null, 'Время идёт'), h('div', { class: 'row' }, run, speed),
              h('label', null, 'На улице'), h('div', { class: 'row' }, slider(-30, 40, 1, e.outTemp, (v) => { E.set(net(), { outTemp: v }); tempT.textContent = v + ' °C'; }), tempT),
              h('label', null, 'Влажность воздуха'), h('div', { class: 'row' }, slider(5, 100, 1, e.humidity, (v) => { E.set(net(), { humidity: v }); humT.textContent = v + ' %'; }), humT),
              h('label', null, 'CO₂ снаружи'), h('div', { class: 'row' }, slider(400, 2000, 10, e.co2, (v) => { E.set(net(), { co2: v }); co2T.textContent = v + ' ppm'; }), co2T),
              h('label', null, 'События'), h('div', { class: 'row' }, h('label', { class: 'row' }, people, 'люди в помещении'), h('label', { class: 'row' }, fire, '🔥 пожар'))),
            h('div', { class: 'section-title' }, 'В помещении сейчас'), out,
            h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Свет — солнце (жалюзи приглушают) и лампы; температура — улица через окно или дверь, обогреватель, кондиционер, вентилятор; CO₂ — люди и проветривание; дым — пожар. ' +
              'Датчики температуры, освещённости, влажности, CO₂ и дыма отправляют показания IoT-серверу — правила «если… то…» в IoT Monitor срабатывают сами.'));
          const draw = () => {
            const ev = E.get(net());
            const cur = ev.cur || E.targets(net());
            clockT.textContent = E.clockText(ev.clock);
            if (document.activeElement !== clockR) clockR.value = String(Math.round(ev.clock));
            const sun = E.daylight(ev.clock);
            UI.clear(out);
            const tile = (icon, v, label) => h('div', { class: 'env-tile' }, h('div', { class: 'env-ico' }, icon), h('b', null, v), h('span', { class: 'muted small' }, label));
            out.append(tile(sun > 0 ? '☀' : '☾', sun + '%', 'солнце'), tile('💡', (cur.light != null ? cur.light : E.targets(net()).light) + '%', 'свет'), tile('🌡', cur.temp + ' °C', 'температура'),
              tile('💧', cur.humidity + ' %', 'влажность'), tile('CO₂', cur.co2 + ' ppm', 'CO₂'), tile('💨', (cur.smoke || 0) + '%', 'дым'));
            if (!ev.on) out.append(h('div', { class: 'muted small', style: { gridColumn: '1 / -1' } }, 'Моделирование выключено — датчики показывают значения, заданные вручную.'));
          };
          draw();
          this.liveDraw = draw;
        },
        live() { if (this.liveDraw) this.liveDraw(); },
      }],
    });
  };
})(globalThis.NetLab = globalThis.NetLab || {});
