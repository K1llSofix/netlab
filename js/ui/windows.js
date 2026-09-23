/* NetLab UI — плавающие окна с вкладками (как окна устройств в Packet Tracer, но их можно
 * держать открытыми сколько угодно, перетаскивать и менять размер). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;

  const registry = new Map();
  const positions = new Map();
  let zTop = 10;
  let cascade = 0;

  class Win {
    constructor(opts) {
      this.id = opts.id;
      this.opts = opts;
      this.tabs = opts.tabs || [];
      this.active = null;
      this.cleanup = null;

      this.titleText = h('span', { class: 'ttl' });
      this.subText = h('span', { class: 'sub' });
      this.iconBox = h('span', { class: 'ico' });
      this.tabBar = h('div', { class: 'tabs', role: 'tablist' });
      this.body = h('div', { class: 'win-body' });
      const closeBtn = h('button', { class: 'btn icon small', title: 'Закрыть (Esc)', onClick: () => this.close() }, UI.icon('close'));
      const titleBar = h('div', { class: 'win-title' }, this.iconBox, h('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline' } }, this.titleText, this.subText), closeBtn);
      this.el = h('div', { class: 'win', role: 'dialog' }, titleBar, this.tabBar, this.body);
      if (this.tabs.length < 2) this.tabBar.style.display = 'none';

      const saved = positions.get(this.id);
      const w = Math.min(opts.width || 620, window.innerWidth - 24);
      const hh = Math.min(opts.height || 480, window.innerHeight - 24);
      let x;
      let y;
      if (saved) {
        ({ x, y } = saved);
      } else {
        x = Math.round((window.innerWidth - w) / 2 + (cascade % 6) * 28 - 70);
        y = Math.round(70 + (cascade % 6) * 26);
        cascade++;
      }
      this.el.style.width = (saved && saved.w) || w + 'px';
      this.el.style.height = (saved && saved.h) || hh + 'px';
      this.move(x, y);

      this.el.addEventListener('mousedown', () => this.focus(), true);
      this.el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented && !(e.target.closest && e.target.closest('.term'))) { this.close(); }
      });
      this.initDrag(titleBar);

      for (const t of this.tabs) {
        const b = h('button', { class: 'tab', role: 'tab', onClick: () => this.select(t.id) }, t.label, h('span', { class: 'cnt', style: { display: 'none' } }));
        t.button = b;
        this.tabBar.appendChild(b);
      }
      this.setTitle(opts.title, opts.sub, opts.icon);
      document.getElementById('windows').appendChild(this.el);
      this.focus();
      this.select(opts.initialTab || (this.tabs[0] && this.tabs[0].id));
    }

    initDrag(bar) {
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        const r = this.el.getBoundingClientRect();
        const dx = e.clientX - r.left;
        const dy = e.clientY - r.top;
        bar.setPointerCapture(e.pointerId);
        const mv = (ev) => this.move(ev.clientX - dx, ev.clientY - dy);
        const up = () => {
          bar.removeEventListener('pointermove', mv);
          bar.removeEventListener('pointerup', up);
          this.remember();
        };
        bar.addEventListener('pointermove', mv);
        bar.addEventListener('pointerup', up);
      });
      new ResizeObserver(() => this.remember()).observe(this.el);
    }

    move(x, y) {
      const w = this.el.offsetWidth || 400;
      x = Math.max(-w + 80, Math.min(x, window.innerWidth - 80));
      y = Math.max(0, Math.min(y, window.innerHeight - 40));
      this.el.style.left = x + 'px';
      this.el.style.top = y + 'px';
    }

    remember() {
      positions.set(this.id, { x: parseInt(this.el.style.left, 10), y: parseInt(this.el.style.top, 10), w: this.el.style.width, h: this.el.style.height });
    }

    setTitle(title, sub, icon) {
      this.titleText.textContent = title || '';
      this.subText.textContent = sub || '';
      if (icon) { UI.clear(this.iconBox); this.iconBox.appendChild(icon); }
    }

    focus() {
      for (const w of registry.values()) w.el.classList.remove('focused');
      this.el.classList.add('focused');
      this.el.style.zIndex = ++zTop;
    }

    select(id) {
      const t = this.tabs.find((x) => x.id === id) || this.tabs[0];
      if (!t) return;
      if (this.cleanup) { try { this.cleanup(); } catch (e) { console.error(e); } this.cleanup = null; }
      this.active = t;
      for (const x of this.tabs) x.button.classList.toggle('on', x === t);
      this.renderActive();
    }

    renderActive() {
      const t = this.active;
      if (!t) return;
      UI.clear(this.body);
      this.body.className = 'win-body' + (t.flush ? ' flush' : '');
      try {
        const r = t.render(this.body, this);
        if (typeof r === 'function') this.cleanup = r;
      } catch (e) {
        console.error(e);
        this.body.appendChild(h('div', { class: 'hint-box warn' }, 'Ошибка отображения: ' + e.message));
      }
    }

    /** Перерисовать вкладку, если пользователь сейчас ничего в ней не редактирует. */
    refresh(force) {
      if (!this.active) return;
      const ae = document.activeElement;
      const editing = ae && this.body.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && !(ae.closest && ae.closest('.term'));
      if (editing && !force) {
        if (this.active.live) this.active.live(this.body, this);
        return;
      }
      if (this.active.keep) { if (this.active.live) this.active.live(this.body, this); return; }
      const st = this.body.scrollTop;
      if (this.cleanup) { try { this.cleanup(); } catch (e) { console.error(e); } this.cleanup = null; }
      this.renderActive();
      this.body.scrollTop = st;
    }

    live() {
      if (this.active && this.active.live) {
        try { this.active.live(this.body, this); } catch (e) { console.error(e); }
      }
    }

    setBadge(tabId, n) {
      const t = this.tabs.find((x) => x.id === tabId);
      if (!t) return;
      const c = t.button.querySelector('.cnt');
      c.textContent = n > 99 ? '99+' : String(n);
      c.style.display = n > 0 ? '' : 'none';
    }

    close() {
      if (this.cleanup) { try { this.cleanup(); } catch (e) { console.error(e); } }
      this.remember();
      this.el.remove();
      registry.delete(this.id);
      if (this.opts.onClose) this.opts.onClose();
    }
  }

  UI.windows = {
    open(opts) {
      const ex = registry.get(opts.id);
      if (ex) {
        ex.focus();
        if (opts.initialTab) ex.select(opts.initialTab);
        return ex;
      }
      const w = new Win(opts);
      registry.set(opts.id, w);
      return w;
    },
    get(id) { return registry.get(id) || null; },
    close(id) { const w = registry.get(id); if (w) w.close(); },
    all() { return [...registry.values()]; },
    closeWhere(pred) { for (const w of [...registry.values()]) if (pred(w)) w.close(); },
    refreshAll() { for (const w of registry.values()) w.refresh(); },
    liveAll() { for (const w of registry.values()) w.live(); },
    topmost() {
      let best = null;
      for (const w of registry.values()) if (!best || Number(w.el.style.zIndex) > Number(best.el.style.zIndex)) best = w;
      return best;
    },
  };
})(globalThis.NetLab = globalThis.NetLab || {});
