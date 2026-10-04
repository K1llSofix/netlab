/* NetLab UI — физическое пространство (как Physical Workspace в Packet Tracer): междугородняя карта → город → здание → шкаф.
 * Места и устройства перетаскиваются мышью, двойной щелчок по месту — войти внутрь; справа — свойства и длины кабелей. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const s = UI.s;
  const PL = NS.places;
  const PH = NS.physical;

  const ICON_PX = 58; // размер значка на экране, пикселей
  const PLACE_ICON = {
    city: '<circle cx="32" cy="26" r="21" fill="#bbf7d0" stroke="#15803d" stroke-width="2"/><rect x="18" y="20" width="8" height="16" fill="#166534"/><rect x="28" y="12" width="9" height="24" fill="#15803d"/><rect x="39" y="18" width="7" height="18" fill="#166534"/>',
    building: '<rect x="12" y="6" width="40" height="38" rx="2" fill="#e2e8f0" stroke="#475569" stroke-width="2"/>' +
      [0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => '<rect x="' + (17 + c * 11) + '" y="' + (11 + r * 8) + '" width="7" height="5" fill="#60a5fa"/>').join('')).join('') + '<rect x="28" y="36" width="8" height="8" fill="#475569"/>',
    closet: '<rect x="18" y="4" width="28" height="42" rx="2" fill="#334155" stroke="#0f172a" stroke-width="2"/>' +
      [0, 1, 2, 3, 4].map((i) => '<rect x="22" y="' + (8 + i * 7) + '" width="20" height="5" fill="#64748b"/><circle cx="39" cy="' + (10.5 + i * 7) + '" r="1.2" fill="#4ade80"/>').join(''),
  };

  const view = (app) => app.placesView || (app.placesView = { cur: 'root', sel: null, vb: {} });
  const fmtLen = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',') + ' км' : m >= 10 ? Math.round(m) + ' м' : m.toFixed(1).replace('.', ',') + ' м');
  const niceStep = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); return [1, 2, 5, 10].map((k) => k * p).find((x) => x >= v) || 10 * p; };

  function apply(app, fn) {
    try { app.mutate(fn); return true; } catch (e) { UI.toast(e.message, 'err'); return false; }
  }

  /** Все места для выбора: с отступом по вложенности. */
  function placeOptions(net) {
    const out = [];
    const walk = (id, depth) => {
      for (const p of PL.children(net, id)) {
        out.push([p.id, '  '.repeat(depth) + PL.KINDS[p.kind].title + ': ' + p.name]);
        walk(p.id, depth + 1);
      }
    };
    walk(PL.ROOT, 0);
    return out;
  }

  function linkRows(app, dev) {
    const net = app.net;
    const rows = [];
    for (const l of net.links.values()) {
      if (l.a.dev !== dev.id && l.b.dev !== dev.id) continue;
      const other = net.devices.get(l.a.dev === dev.id ? l.b.dev : l.a.dev);
      if (!other) continue;
      if (l.wireless) { rows.push(h('tr', null, h('td', null, other.name), h('td', null, 'радио'), h('td', null, fmtLen(PL.distance(net, dev, other))), h('td', null, ''))); continue; }
      const m = PH.linkLength(net, l);
      const max = PH.MAX_LEN[l.cable];
      const bad = max && m > max;
      rows.push(h('tr', null, h('td', null, other.name), h('td', null, NS.Network.CABLES[l.cable] || l.cable), h('td', { class: bad ? 'st bad' : '' }, fmtLen(m)), h('td', { class: 'muted' }, max ? '≤ ' + fmtLen(max) : '')));
    }
    return rows;
  }

  function render(app, body) {
    const net = app.net;
    const V = view(app);
    if (!PL.get(net, V.cur)) V.cur = PL.ROOT;
    const place = PL.get(net, V.cur);
    const K = PL.KINDS[place.kind];
    const go = (id) => { V.cur = id; V.sel = null; UI.clear(body); render(app, body); };
    V.vb = V.vb || {};
    const full = () => ({ x: 0, y: 0, w: K.w, h: K.h });
    let vb = V.vb[V.cur] || full();
    const setVb = (v) => { vb = v; V.vb[V.cur] = v; svg.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h); draw(); };

    // верхняя панель
    const crumbs = h('div', { class: 'pl-crumbs' });
    PL.path(net, V.cur).forEach((p, i, arr) => {
      if (i) crumbs.append(h('span', { class: 'muted' }, ' › '));
      crumbs.append(i === arr.length - 1 ? h('b', null, p.name) : h('a', { href: '#', onClick: (e) => { e.preventDefault(); go(p.id); } }, p.name));
    });
    const bar = h('div', { class: 'pl-bar' },
      h('button', { class: 'btn icon small', title: 'На уровень выше', disabled: !place.parent, onClick: () => go(place.parent) }, '↑'), crumbs, h('div', { style: { flex: 1 } }),
      h('span', { class: 'muted small' }, 'колёсико — масштаб, фон — сдвиг'), h('button', { class: 'btn icon small', title: 'Показать всё место', onClick: () => setVb(full()) }, '⤢'),
      K.child ? h('button', { class: 'btn small', onClick: () => { if (apply(app, () => { V.sel = { place: PL.add(net, V.cur).id }; })) { UI.clear(body); render(app, body); } } }, '＋ ' + PL.KINDS[K.child].title) : null,
      UI.toggle('Учитывать расстояния', PL.on(net), (on) => { apply(app, () => PL.setOn(net, on)); UI.toast(on ? 'Длина кабелей и дальность Wi-Fi считаются по физическому пространству' : 'Расстояния по физическому пространству не учитываются', 'ok'); }));

    const svg = s('svg', { class: 'pl-svg', viewBox: vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h, preserveAspectRatio: 'xMidYMid meet' });
    const side = h('div', { class: 'pl-side' });
    body.append(h('div', { class: 'pl-wrap' }, bar, h('div', { class: 'pl-main' }, svg, side)));

    const drag = { key: null, x: 0, y: 0, moved: false, dx: 0, dy: 0 };
    const pan = { on: false, cx: 0, cy: 0, vb: null, moved: false };
    let scale = 1; // пикселей на метр
    let unit = K.w / 12; // метров на значок, уточняется по размеру окна

    const items = () => {
      const out = [];
      for (const p of PL.children(net, V.cur)) out.push({ key: 'p:' + p.id, place: p, x: p.x, y: p.y });
      for (const d of PL.devicesIn(net, V.cur, true)) { const q = PL.devPos(net, d); out.push({ key: 'd:' + d.id, dev: d, x: q.x, y: q.y }); }
      for (const it of out) if (drag.key === it.key && drag.moved) { it.x = drag.x; it.y = drag.y; }
      return out;
    };

    const draw = () => {
      const r = svg.getBoundingClientRect();
      if (r.width > 10) { scale = Math.min(r.width / vb.w, r.height / vb.h); unit = ICON_PX / scale; }
      UI.clear(svg);
      const g = niceStep(vb.w / 14);
      svg.append(s('rect', { class: 'pl-bg pl-bg-' + place.kind, x: 0, y: 0, width: K.w, height: K.h }));
      const grid = s('g', { class: 'pl-grid' });
      for (let x = Math.max(g, Math.ceil(vb.x / g) * g); x < Math.min(K.w, vb.x + vb.w); x += g) grid.append(s('line', { x1: x, y1: 0, x2: x, y2: K.h }));
      for (let y = Math.max(g, Math.ceil(vb.y / g) * g); y < Math.min(K.h, vb.y + vb.h); y += g) grid.append(s('line', { x1: 0, y1: y, x2: K.w, y2: y }));
      svg.append(grid);
      const list = items();
      const byKey = new Map(list.map((it) => [it.key, it]));
      // кабели между видимыми объектами
      const pairs = new Map();
      for (const l of net.links.values()) {
        const a = net.devices.get(l.a.dev);
        const b = net.devices.get(l.b.dev);
        if (!a || !b) continue;
        const va = PL.visibleAt(net, a, V.cur);
        const vb = PL.visibleAt(net, b, V.cur);
        if (!va || !vb) continue;
        const ka = va.dev ? 'd:' + va.dev.id : 'p:' + va.place.id;
        const kb = vb.dev ? 'd:' + vb.dev.id : 'p:' + vb.place.id;
        if (ka === kb) continue;
        const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        const e = pairs.get(k) || { a: byKey.get(ka), b: byKey.get(kb), links: [] };
        e.links.push(l);
        pairs.set(k, e);
      }
      const gl = s('g', { class: 'pl-links' });
      for (const e of pairs.values()) {
        if (!e.a || !e.b) continue;
        const bad = e.links.some((l) => !l.wireless && PH.MAX_LEN[l.cable] && PH.linkLength(net, l) > PH.MAX_LEN[l.cable]);
        const wl = e.links.every((l) => l.wireless);
        gl.append(s('line', { class: 'pl-link' + (bad ? ' bad' : '') + (wl ? ' wireless' : ''), x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y, 'stroke-width': unit / 26 }));
        const txt = e.links.length === 1 ? (wl ? 'Wi-Fi ' : '') + fmtLen(e.links[0].wireless ? PL.distance(net, net.devices.get(e.links[0].a.dev), net.devices.get(e.links[0].b.dev)) : PH.linkLength(net, e.links[0])) : e.links.length + ' кабеля';
        gl.append(s('text', { class: 'pl-len' + (bad ? ' bad' : ''), x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 - unit * 0.12, 'font-size': unit * 0.22, 'text-anchor': 'middle' }, txt));
      }
      svg.append(gl);
      // места и устройства
      for (const it of list) {
        const sel = V.sel && ((it.place && V.sel.place === it.place.id) || (it.dev && V.sel.dev === it.dev.id));
        const gi = s('g', { class: 'pl-item' + (sel ? ' sel' : ''), transform: 'translate(' + it.x + ',' + it.y + ')' });
        const markup = it.place ? PLACE_ICON[it.place.kind] : UI.deviceIconFor ? UI.deviceIconFor(it.dev) : UI.deviceIcon(it.dev.type, it.dev.model);
        if (sel) gi.append(s('rect', { class: 'pl-selbox', x: -unit * 0.58, y: -unit * 0.5, width: unit * 1.16, height: unit * 1.28, rx: unit * 0.08 }));
        gi.append(UI.svgFrom(markup, { x: -unit / 2, y: -unit * 0.42, width: unit, height: unit * 0.75, viewBox: '0 0 64 48' }));
        const name = it.place ? it.place.name : it.dev.name;
        gi.append(s('text', { class: 'pl-name', y: unit * 0.52, 'font-size': unit * 0.22, 'text-anchor': 'middle' }, name));
        if (it.place) {
          const n = PL.devicesIn(net, it.place.id).length;
          if (n) gi.append(s('text', { class: 'pl-count', y: unit * 0.76, 'font-size': unit * 0.18, 'text-anchor': 'middle' }, n + ' устр.'));
          if (PL.homeId(net) === it.place.id || PL.path(net, PL.homeId(net)).some((p) => p.id === it.place.id)) gi.append(s('text', { class: 'pl-home', x: unit * 0.45, y: -unit * 0.3, 'font-size': unit * 0.26 }, '★'));
        }
        gi.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const pt = toLocal(e);
          drag.key = it.key; drag.moved = false; drag.dx = pt.x - it.x; drag.dy = pt.y - it.y;
          V.sel = it.place ? { place: it.place.id } : { dev: it.dev.id };
          svg.setPointerCapture(e.pointerId);
          draw();
          drawSide();
        });
        gi.addEventListener('dblclick', () => { if (it.place) go(it.place.id); else UI.openDeviceWindow(app, it.dev.id); });
        svg.append(gi);
      }
      // масштаб
      const step = niceStep(vb.w / 8);
      const sx = vb.x + vb.w * 0.03;
      const sy = vb.y + vb.h * 0.95;
      svg.append(s('g', { class: 'pl-scale' }, s('line', { x1: sx, y1: sy, x2: sx + step, y2: sy, 'stroke-width': unit / 22 }),
        s('text', { x: sx + step / 2, y: sy - unit * 0.1, 'font-size': unit * 0.2, 'text-anchor': 'middle' }, fmtLen(step))));
    };

    const toLocal = (e) => {
      const p = svg.createSVGPoint();
      p.x = e.clientX;
      p.y = e.clientY;
      const m = svg.getScreenCTM();
      return m ? p.matrixTransform(m.inverse()) : { x: 0, y: 0 };
    };
    svg.addEventListener('pointermove', (e) => {
      if (!drag.key) return;
      const pt = toLocal(e);
      drag.x = Math.max(0, Math.min(K.w, pt.x - drag.dx));
      drag.y = Math.max(0, Math.min(K.h, pt.y - drag.dy));
      drag.moved = true;
      draw();
    });
    const endDrag = () => {
      if (!drag.key) return;
      const { key, moved, x, y } = drag;
      drag.key = null;
      if (!moved) return;
      const id = key.slice(2);
      apply(app, () => (key[0] === 'p' ? PL.movePlace(net, id, x, y) : PL.setDevice(net, id, V.cur, x, y)));
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    // фон: сдвиг карты (левая или средняя кнопка), щелчок без сдвига — снять выделение
    svg.addEventListener('pointerdown', (e) => {
      if (!(e.target.closest && !e.target.closest('.pl-item')) || (e.button !== 0 && e.button !== 1)) return;
      e.preventDefault();
      Object.assign(pan, { on: true, cx: e.clientX, cy: e.clientY, vb: Object.assign({}, vb), moved: false });
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pan.on) return;
      const dx = (e.clientX - pan.cx) / scale;
      const dy = (e.clientY - pan.cy) / scale;
      if (Math.abs(e.clientX - pan.cx) + Math.abs(e.clientY - pan.cy) > 3) pan.moved = true;
      if (pan.moved) setVb({ x: pan.vb.x - dx, y: pan.vb.y - dy, w: pan.vb.w, h: pan.vb.h });
    });
    const endPan = () => {
      if (!pan.on) return;
      pan.on = false;
      if (!pan.moved) { V.sel = null; draw(); drawSide(); }
    };
    svg.addEventListener('pointerup', endPan);
    svg.addEventListener('pointercancel', endPan);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pt = toLocal(e);
      const f = e.deltaY > 0 ? 1.25 : 0.8;
      const w = Math.max(K.w / 400, Math.min(K.w * 1.5, vb.w * f));
      const k = w / vb.w;
      setVb({ x: pt.x - (pt.x - vb.x) * k, y: pt.y - (pt.y - vb.y) * k, w, h: vb.h * k });
    }, { passive: false });

    const add = (...els) => side.append(...els.filter(Boolean));
    const drawSide = () => {
      UI.clear(side);
      const sel = V.sel;
      if (sel && sel.dev && net.devices.get(sel.dev)) {
        const d = net.devices.get(sel.dev);
        const q = PL.devPos(net, d);
        const num = (v, set) => { const i = h('input', { class: 'inp', type: 'number', step: '0.5', value: Math.round(v * 10) / 10, style: { width: '80px' } }); i.addEventListener('change', () => set(Number(i.value))); return i; };
        add(h('h3', null, d.name), h('div', { class: 'muted' }, d.model || d.type),
          h('div', { class: 'pl-field' }, h('label', null, 'Место'), UI.h('select', { class: 'inp', onChange: (e) => apply(app, () => PL.setDevice(net, d.id, e.target.value)) },
            placeOptions(net).map(([v, t]) => h('option', { value: v, selected: v === q.place }, t)))),
          h('div', { class: 'pl-field' }, h('label', null, 'X, м'), num(q.x, (v) => apply(app, () => PL.setDevice(net, d.id, q.place, v, q.y))), h('label', null, 'Y, м'), num(q.y, (v) => apply(app, () => PL.setDevice(net, d.id, q.place, q.x, v)))),
          q.auto ? h('div', { class: 'muted small' }, 'Место не задано — стоит в месте по умолчанию (★).') : null,
          h('div', { style: { fontWeight: 600, marginTop: '10px' } }, 'Кабели'),
          h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'К'), h('th', null, 'Кабель'), h('th', null, 'Длина'), h('th')), linkRows(app, d)),
          h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn small', onClick: () => UI.openDeviceWindow(app, d.id) }, 'Открыть устройство')));
        return;
      }
      const p = sel && sel.place ? PL.get(net, sel.place) : place;
      if (!p) return;
      const isCur = p.id === V.cur;
      const nm = h('input', { class: 'inp', value: p.name, disabled: p.id === PL.ROOT });
      nm.addEventListener('change', () => apply(app, () => PL.rename(net, p.id, nm.value)));
      const devs = PL.devicesIn(net, p.id, true);
      add(h('h3', null, PL.KINDS[p.kind].title), h('div', { class: 'pl-field' }, h('label', null, 'Название'), nm),
        h('div', { class: 'muted' }, 'Размер: ' + fmtLen(PL.KINDS[p.kind].w) + ' × ' + fmtLen(PL.KINDS[p.kind].h) + ' · устройств внутри: ' + PL.devicesIn(net, p.id).length),
        h('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } },
          !isCur ? h('button', { class: 'btn small primary', onClick: () => go(p.id) }, 'Открыть') : null,
          p.id !== PL.ROOT ? h('button', { class: 'btn small', title: 'Новые устройства со схемы появятся здесь', disabled: PL.homeId(net) === p.id, onClick: () => { apply(app, () => PL.setHome(net, p.id)); drawSide(); draw(); } }, PL.homeId(net) === p.id ? '★ Место по умолчанию' : '☆ Сделать местом по умолчанию') : null,
          p.id !== PL.ROOT ? h('button', { class: 'btn small danger', onClick: () => { if (apply(app, () => PL.remove(net, p.id))) { if (isCur) go(p.parent); } } }, 'Удалить') : null),
        devs.length ? h('div', { style: { fontWeight: 600, marginTop: '10px' } }, 'Устройства здесь') : null,
        devs.length ? h('div', { class: 'pl-devlist' }, devs.map((d) => h('a', { href: '#', onClick: (e) => { e.preventDefault(); if (isCur) { V.sel = { dev: d.id }; draw(); drawSide(); } else go(p.id); } }, d.name))) : null,
        h('div', { class: 'hint-box', style: { marginTop: '12px' } }, 'Перетаскивайте места и устройства мышью; двойной щелчок по месту — войти внутрь, по устройству — открыть его. ' +
          'Когда включено «Учитывать расстояния», длина кабеля — это расстояние между устройствами: медь — до 100 м, оптика — до 2 км, так что здания соединяют оптикой; Wi-Fi — до ' + (net.physical ? net.physical.wifi : PH.DEFAULTS.wifi) + ' м, Bluetooth — до 10 м.'));
    };

    drawSide();
    setTimeout(draw, 0);
    if (window.ResizeObserver) { const ro = new ResizeObserver(() => { if (!svg.isConnected) { ro.disconnect(); return; } if (!drag.key) draw(); }); ro.observe(svg); }
    return () => {};
  }

  UI.placesWindow = function (app) {
    UI.windows.open({
      id: 'places', title: 'Физическое пространство', sub: 'город · здание · шкаф', icon: UI.svgFrom(PLACE_ICON.building, { viewBox: '0 0 64 48', width: 22, height: 17 }), width: 980, height: 620,
      tabs: [{ id: 'map', label: 'Карта', render: (body) => render(app, body) }],
    });
  };

  UI.addMenuExtra = (UI.addMenuExtra || []).concat([(ws) => [{ label: 'Физическое пространство…', onClick: () => UI.placesWindow(ws.app) }]]);
  UI.devMenuExtra = (UI.devMenuExtra || []).concat([(ws, d) => [{ label: 'Показать в физическом пространстве', onClick: () => {
    const V = view(ws.app);
    V.cur = PL.devPos(ws.app.net, d).place;
    V.sel = { dev: d.id };
    UI.windows.close('places');
    UI.placesWindow(ws.app);
  } }]]);
})(globalThis.NetLab = globalThis.NetLab || {});
