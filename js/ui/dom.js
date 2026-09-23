/* NetLab UI — помощники DOM: создание элементов, тосты, модальные окна, меню, подсказки. */
(function (NS) {
  'use strict';

  const UI = (NS.ui = NS.ui || {});
  const SVGNS = 'http://www.w3.org/2000/svg';

  function applyAttrs(el, attrs, isSvg) {
    if (!attrs) return;
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' && !isSvg) el.value = v;
      else if (k === 'checked' && !isSvg) el.checked = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }

  function append(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }

  /** HTML-элемент: h('div', {class: 'x', onClick: fn}, 'текст', child, [массив]) */
  UI.h = function (tag, attrs, ...children) {
    const el = document.createElement(tag);
    applyAttrs(el, attrs, false);
    append(el, children);
    return el;
  };

  /** SVG-элемент. */
  UI.s = function (tag, attrs, ...children) {
    const el = document.createElementNS(SVGNS, tag);
    applyAttrs(el, attrs, true);
    append(el, children);
    return el;
  };

  UI.svgFrom = function (markup, attrs) {
    const tpl = document.createElementNS(SVGNS, 'svg');
    applyAttrs(tpl, attrs, true);
    tpl.innerHTML = markup;
    return tpl;
  };

  UI.esc = function (s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  UI.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /* ---------- тосты ---------- */

  UI.toast = function (text, kind, ms) {
    const box = document.getElementById('toasts');
    const t = UI.h('div', { class: 'toast ' + (kind || '') }, text);
    box.appendChild(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => t.remove(), ms || (kind === 'err' ? 4500 : 2800));
  };

  /* ---------- модальные окна ---------- */

  UI.modal = function (opts) {
    const overlay = document.getElementById('overlay');
    const back = UI.h('div', { class: 'modal-back' });
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
    const actions = UI.h('div', { class: 'actions' });
    for (const a of opts.actions || [{ label: 'Закрыть', primary: true }]) {
      actions.appendChild(UI.h('button', {
        class: 'btn ' + (a.primary ? 'primary' : a.danger ? 'danger outline' : 'outline'),
        onClick: () => { if (a.onClick && a.onClick() === false) return; close(); },
      }, a.label));
    }
    const box = UI.h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      opts.title ? UI.h('h3', null, opts.title) : null,
      typeof opts.body === 'string' ? UI.h('p', null, opts.body) : opts.body,
      actions);
    back.appendChild(box);
    back.addEventListener('mousedown', (e) => { if (e.target === back && opts.dismissable !== false) close(); });
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); if (opts.onCancel) opts.onCancel(); }
      if (e.key === 'Enter' && opts.enterAction && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        if (opts.enterAction() !== false) close();
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.appendChild(back);
    const first = box.querySelector('input, select, textarea');
    if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 0);
    return close;
  };

  UI.confirm = function (title, text, okLabel, danger) {
    return new Promise((resolve) => {
      let answered = false;
      UI.modal({
        title, body: text,
        onCancel: () => { if (!answered) resolve(false); },
        enterAction: () => { answered = true; resolve(true); },
        actions: [
          { label: 'Отмена', onClick: () => { answered = true; resolve(false); } },
          { label: okLabel || 'OK', primary: !danger, danger: !!danger, onClick: () => { answered = true; resolve(true); } },
        ],
      });
    });
  };

  UI.prompt = function (title, label, value) {
    return new Promise((resolve) => {
      const inp = UI.h('input', { class: 'inp', value: value || '' });
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      UI.modal({
        title,
        body: UI.h('div', { class: 'form', style: { gridTemplateColumns: '1fr' } }, label ? UI.h('label', null, label) : null, inp),
        onCancel: () => done(null),
        enterAction: () => done(inp.value),
        actions: [
          { label: 'Отмена', onClick: () => done(null) },
          { label: 'OK', primary: true, onClick: () => done(inp.value) },
        ],
      });
    });
  };

  /* ---------- контекстное меню ---------- */

  let openMenu = null;
  UI.closeMenus = function () {
    if (openMenu) { openMenu.remove(); openMenu = null; }
  };
  // pointerdown в фазе перехвата: старое меню закрывается до того, как обработчик сцены
  // (тоже на pointerdown) откроет новое. С mousedown новое меню закрывалось бы сразу.
  document.addEventListener('pointerdown', (e) => {
    if (openMenu && !openMenu.contains(e.target)) UI.closeMenus();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') UI.closeMenus(); });

  /** items: [{label, onClick, danger, disabled, right}, '-', {title}] */
  UI.menu = function (x, y, items, cls) {
    UI.closeMenus();
    const m = UI.h('div', { class: 'ctx ' + (cls || '') });
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { m.appendChild(UI.h('div', { class: 'sep' })); continue; }
      if (it.title) { m.appendChild(UI.h('div', { class: 'title' }, it.title)); continue; }
      const b = UI.h('button', {
        class: (it.danger ? 'danger' : '') + (it.on ? ' on' : ''),
        disabled: it.disabled,
        title: it.hint || '',
        onClick: () => { UI.closeMenus(); it.onClick && it.onClick(); },
      }, it.icon || null, UI.h('span', { class: 'lbl' }, it.label), it.right ? UI.h('span', { class: 'pst' }, it.right) : null);
      if (it.drag) {
        b.draggable = true;
        b.addEventListener('dragstart', (e) => { e.dataTransfer.setData(it.drag.type, it.drag.data); e.dataTransfer.effectAllowed = 'copy'; setTimeout(UI.closeMenus, 0); });
      }
      m.appendChild(b);
    }
    document.getElementById('overlay').appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    openMenu = m;
    return m;
  };

  /* ---------- всплывающая подсказка ---------- */

  let tip = null;
  UI.showTip = function (x, y, content) {
    if (!tip) {
      tip = UI.h('div', { class: 'tooltip' });
      document.body.appendChild(tip);
    }
    UI.clear(tip);
    tip.appendChild(content);
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, window.innerWidth - r.width - 6) + 'px';
    tip.style.top = Math.min(y + 16, window.innerHeight - r.height - 6) + 'px';
  };
  UI.hideTip = function () { if (tip) tip.style.display = 'none'; };

  /* ---------- элементы форм ---------- */

  UI.toggle = function (label, checked, onChange) {
    const inp = UI.h('input', { type: 'checkbox', checked });
    inp.addEventListener('change', () => onChange(inp.checked, inp));
    return UI.h('label', { class: 'switch-toggle' }, inp, UI.h('span', { class: 'knob' }), label ? UI.h('span', null, label) : null);
  };

  UI.field = function (label, control) {
    return [UI.h('label', null, label), control];
  };

  /* ---------- файлы ---------- */

  UI.download = function (filename, text, type) {
    const blob = new Blob([text], { type: type || 'application/json' });
    const a = UI.h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  UI.pickFile = function (accept) {
    return new Promise((resolve) => {
      const inp = UI.h('input', { type: 'file', accept: accept || '', style: { display: 'none' } });
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        if (!f) return resolve(null);
        const r = new FileReader();
        r.onload = () => resolve({ name: f.name, text: String(r.result) });
        r.onerror = () => resolve(null);
        r.readAsText(f);
      });
      document.body.appendChild(inp);
      inp.click();
    });
  };

  /** localStorage, который не падает в приватном режиме. */
  UI.store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* нет доступа */ } },
  };
})(globalThis.NetLab = globalThis.NetLab || {});
