/* NetLab UI — работа с большими схемами: поиск устройств (Ctrl+F), мини-карта, шаблоны
 * (сохранить выделенное и вставить в любую схему) и копирование с кабелями (Ctrl+C / Ctrl+V). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const TPL_KEY = 'netlab.templates';
  const CLIP_KEY = 'netlab.clipboard';

  const typing = (t) => t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || (t.closest && t.closest('.term')));

  /* ================= поиск ================= */

  let searchEl = null;

  function openSearch(app) {
    const ws = app.ws;
    if (searchEl) { searchEl.querySelector('input').select(); return; }
    const inp = h('input', { class: 'inp', placeholder: 'Имя, IP, MAC, модель, VLAN или текст заметки', spellcheck: 'false' });
    const list = h('div', { class: 'find-list' });
    let res = [];
    let cur = 0;
    const close = () => { if (searchEl) { searchEl.remove(); searchEl = null; } };
    const pick = (x) => {
      if (!x) return;
      if (x.kind === 'dev') ws.focusDevice(x.id);
      else {
        const n = app.net.notes.find((z) => z.id === x.id);
        if (n) { const r = ws.svg.getBoundingClientRect(); ws.view = { k: Math.max(ws.view.k, 1), x: r.width / 2 - n.x * Math.max(ws.view.k, 1), y: r.height / 2 - n.y * Math.max(ws.view.k, 1) }; ws.applyView(); }
      }
    };
    const draw = () => {
      UI.clear(list);
      res = NS.search.find(app.net, inp.value, 12);
      cur = Math.min(cur, Math.max(0, res.length - 1));
      if (inp.value.trim() && !res.length) list.append(h('div', { class: 'find-empty muted' }, 'Ничего не найдено'));
      res.forEach((x, i) => list.append(h('div', { class: 'find-item' + (i === cur ? ' cur' : ''), onMousedown: (e) => { e.preventDefault(); cur = i; pick(x); draw(); } },
        h('b', null, x.name), h('span', { class: 'muted' }, x.what))));
    };
    inp.addEventListener('input', () => { cur = 0; draw(); if (res[0]) pick(res[0]); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(res.length - 1, cur + 1); draw(); pick(res[cur]); }
      if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); pick(res[cur]); }
      if (e.key === 'Enter') { e.preventDefault(); pick(res[cur]); if (res[cur] && res[cur].kind === 'dev' && e.ctrlKey) app.openDevice(res[cur].id); close(); }
    });
    searchEl = h('div', { class: 'find-box' }, h('div', { class: 'row' }, UI.icon('inspect'), inp, h('button', { class: 'btn icon small', title: 'Закрыть (Esc)', onClick: close }, UI.icon('close'))), list,
      h('div', { class: 'muted small' }, '↑↓ — выбор, Enter — показать, Ctrl+Enter — открыть окно устройства'));
    ws.wrap.appendChild(searchEl);
    setTimeout(() => inp.focus(), 0);
  }

  /* ================= мини-карта ================= */

  const mini = { el: null, svg: null, raf: 0, bounds: null };

  function miniUpdate(ws) {
    if (mini.raf) return;
    mini.raf = setTimeout(() => { mini.raf = 0; miniDraw(ws); }, 40);
  }

  function miniDraw(ws) {
    const app = ws.app;
    const on = app.settings.minimap !== false && ws.net.devices.size >= 2;
    if (!on) { if (mini.el) mini.el.style.display = 'none'; return; }
    if (!mini.el) {
      mini.svg = document.createElementNS(SVGNS, 'svg');
      mini.svg.setAttribute('class', 'minimap-svg');
      mini.el = h('div', { class: 'minimap', title: 'Мини-карта: щёлкните или перетащите, чтобы перейти' }, mini.svg);
      ws.wrap.appendChild(mini.el);
      const go = (e) => {
        const b = mini.bounds;
        if (!b) return;
        const r = mini.svg.getBoundingClientRect();
        const wx = b.x + ((e.clientX - r.left) / r.width) * b.w;
        const wy = b.y + ((e.clientY - r.top) / r.height) * b.h;
        const sr = ws.svg.getBoundingClientRect();
        ws.view.x = sr.width / 2 - wx * ws.view.k;
        ws.view.y = sr.height / 2 - wy * ws.view.k;
        ws.applyView();
      };
      mini.svg.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        go(e);
        const mv = (ev) => go(ev);
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
      });
    }
    mini.el.style.display = '';
    const devs = [...ws.net.devices.values()];
    const sr = ws.svg.getBoundingClientRect();
    const tl = ws.toWorld(sr.left, sr.top);
    const br = ws.toWorld(sr.right, sr.bottom);
    let x0 = Math.min(tl.x, ...devs.map((d) => d.x - 60));
    let y0 = Math.min(tl.y, ...devs.map((d) => d.y - 60));
    let x1 = Math.max(br.x, ...devs.map((d) => d.x + 60));
    let y1 = Math.max(br.y, ...devs.map((d) => d.y + 60));
    const W = 170;
    const H = 110;
    // сохранить пропорции окна мини-карты
    const k = Math.max((x1 - x0) / W, (y1 - y0) / H);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    x0 = cx - (W * k) / 2; x1 = cx + (W * k) / 2; y0 = cy - (H * k) / 2; y1 = cy + (H * k) / 2;
    mini.bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const svg = mini.svg;
    svg.setAttribute('viewBox', x0 + ' ' + y0 + ' ' + (x1 - x0) + ' ' + (y1 - y0));
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const el = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v); svg.appendChild(e); return e; };
    const lw = Math.max(1, k * 1.2);
    for (const l of ws.net.links.values()) {
      const a = ws.net.getDevice(l.a.dev);
      const b = ws.net.getDevice(l.b.dev);
      if (a && b) el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'mm-link', 'stroke-width': lw });
    }
    const r = Math.max(3, k * 3.2);
    for (const d of devs) el('circle', { cx: d.x, cy: d.y, r, class: 'mm-dev mm-' + d.type + (ws.selection.has(d.id) ? ' sel' : '') });
    el('rect', { x: tl.x, y: tl.y, width: Math.max(1, br.x - tl.x), height: Math.max(1, br.y - tl.y), class: 'mm-view', 'stroke-width': Math.max(1, k * 1.5) });
  }

  /* ================= шаблоны и буфер обмена ================= */

  function readTemplates() {
    try { const v = JSON.parse(UI.store.get(TPL_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function writeTemplates(list) { if (!UI.store.set(TPL_KEY, JSON.stringify(list))) throw new Error('хранилище браузера недоступно или переполнено'); }

  function selectedDevices(ws) { return [...ws.selection].filter((id) => ws.net.getDevice(id)); }

  async function saveTemplate(app) {
    const ids = selectedDevices(app.ws);
    if (!ids.length) { UI.toast('Выделите устройства, которые нужно сохранить как шаблон', 'warn'); return; }
    const name = await UI.prompt('Шаблон', 'Название шаблона (устройства с настройками и кабелями между ними):', ids.length === 1 ? app.net.getDevice(ids[0]).name : 'Фрагмент из ' + ids.length + ' устройств');
    if (!name) return;
    const frag = NS.fragment.capture(app.net, ids);
    const list = readTemplates().filter((t) => t.name !== name);
    list.push({ name: String(name).slice(0, 80), date: new Date().toISOString(), frag });
    try { writeTemplates(list); } catch (e) { UI.toast('Не удалось сохранить шаблон: ' + e.message, 'err'); return; }
    UI.toast('Шаблон «' + name + '» сохранён — вставка: правый щелчок по пустому месту схемы', 'ok', 5000);
  }

  function insertFrag(app, frag, x, y, what) {
    let ids = [];
    try { app.mutate(() => { ids = NS.fragment.insert(app.net, frag, x, y); }); } catch (e) { UI.toast(e.message, 'err'); return; }
    app.ws.selection = new Set(ids);
    app.needRender = true;
    UI.toast(what + ': устройств ' + ids.length + (frag.links && frag.links.length ? ', кабелей ' + frag.links.length : ''), 'ok');
  }

  function manageTemplates(app) {
    const box = h('div');
    const draw = () => {
      UI.clear(box);
      const list = readTemplates();
      if (!list.length) { box.append(h('p', { class: 'muted' }, 'Шаблонов пока нет. Выделите устройства и выберите в меню по правому щелчку «Сохранить как шаблон».')); return; }
      box.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Шаблон'), h('th', null, 'Устройств'), h('th', null, 'Сохранён'), h('th')),
        list.map((t, i) => h('tr', null, h('td', null, t.name), h('td', null, String(t.frag.devices.length)), h('td', { class: 'muted' }, new Date(t.date).toLocaleDateString('ru-RU')),
          h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => { const l = readTemplates(); l.splice(i, 1); writeTemplates(l); draw(); } }, UI.icon('delete')))))));
    };
    draw();
    UI.modal({ title: 'Шаблоны', body: box });
  }

  function copy(app) {
    const ids = selectedDevices(app.ws);
    if (!ids.length) return false;
    const frag = NS.fragment.capture(app.net, ids);
    app.clip = frag;
    try { UI.store.set(CLIP_KEY, JSON.stringify(frag)); } catch (e) { /* большой фрагмент — только в памяти */ }
    UI.toast('Скопировано устройств: ' + ids.length + (frag.links.length ? ' (с кабелями: ' + frag.links.length + ')' : ''), 'ok');
    return true;
  }

  function paste(app) {
    let frag = app.clip;
    if (!frag) { try { frag = JSON.parse(UI.store.get(CLIP_KEY) || 'null'); } catch (e) { frag = null; } }
    if (!frag) return false;
    const c = app.ws.lastWorld || app.ws.centerWorld();
    insertFrag(app, frag, c.x + 30, c.y + 30, 'Вставлено');
    return true;
  }

  UI.addMenuExtra = (UI.addMenuExtra || []).concat([(ws, w) => {
    const list = readTemplates();
    const items = [];
    const clip = ws.app.clip || (() => { try { return JSON.parse(UI.store.get(CLIP_KEY) || 'null'); } catch (e) { return null; } })();
    if (clip) items.push({ label: 'Вставить скопированное', right: 'Ctrl+V', onClick: () => insertFrag(ws.app, clip, w.x, w.y, 'Вставлено') });
    if (list.length) {
      items.push({ title: 'Шаблоны' });
      for (const t of list.slice(-12).reverse()) items.push({ label: t.name, right: t.frag.devices.length + ' уст.', onClick: () => insertFrag(ws.app, t.frag, w.x, w.y, 'Шаблон «' + t.name + '»') });
      items.push({ label: 'Управление шаблонами…', onClick: () => manageTemplates(ws.app) });
    }
    return items.length ? ['-'].concat(items) : [];
  }]);

  UI.devMenuExtra = (UI.devMenuExtra || []).concat([(ws) => [
    { label: 'Копировать с кабелями', right: 'Ctrl+C', onClick: () => copy(ws.app) },
    { label: ws.selection.size > 1 ? 'Сохранить выделенное как шаблон…' : 'Сохранить как шаблон…', onClick: () => saveTemplate(ws.app) },
  ]]);

  NS.navSetup = function (app) {
    const W = UI.Workspace.prototype;
    const baseApply = W.applyView;
    W.applyView = function () { baseApply.call(this); if (this.app) miniUpdate(this); };
    const baseRender = W.render;
    W.render = function () { baseRender.call(this); miniUpdate(this); };
    // последняя точка мыши на схеме — туда вставляется Ctrl+V
    app.ws.svg.addEventListener('pointermove', (e) => { app.ws.lastWorld = app.ws.toWorld(e.clientX, e.clientY); });
    app.ws.svg.addEventListener('pointerleave', () => { app.ws.lastWorld = null; });
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-back')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'f' || key === 'а') { e.preventDefault(); openSearch(app); return; }
      if (typing(e.target)) return;
      if ((key === 'c' || key === 'с') && !e.shiftKey && !window.getSelection().toString()) { if (copy(app)) e.preventDefault(); return; }
      if ((key === 'v' || key === 'м') && !e.shiftKey) { if (paste(app)) e.preventDefault(); }
    });
    miniUpdate(app.ws);
  };

  UI.openSearch = openSearch;
  UI.saveTemplate = saveTemplate;
})(globalThis.NetLab = globalThis.NetLab || {});
