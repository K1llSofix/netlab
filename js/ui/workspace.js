/* NetLab UI — рабочая область: устройства, кабели разных типов, Wi-Fi, заметки и фигуры,
 * панорама/масштаб, инструменты, анимация пакетов в режиме симуляции. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const P = NS.packets;
  const h = UI.h;
  const s = UI.s;

  const LIGHT_DIST = 34;
  const ICON_W = 56;
  const ICON_H = 42;

  /** Тип кабеля инструмента → тип для проверки портов. */
  const fitKind = (c) => (c === 'serial-dce' || c === 'serial-dte' ? 'serial' : c || 'auto');

  class Workspace {
    constructor(app, svg, wrap) {
      this.app = app;
      this.svg = svg;
      this.wrap = wrap;
      this.view = { x: 0, y: 0, k: 1 };
      this.selection = new Set();
      this.selLink = null;
      this.drag = null;
      this.cableSrc = null;
      this.pduSrc = null;
      this.mouse = { x: 0, y: 0 };
      this.hot = new Map();
      this.markers = [];
      this.pktEls = new Map();
      this.linkEls = new Map();
      this.hoverTimer = null;

      this.build();
      this.bind();
    }

    get net() { return this.app.net; }

    /* ---------- построение слоёв ---------- */

    build() {
      const svg = this.svg;
      UI.clear(svg);
      this.grid = s('pattern', { id: 'gridDots', width: 24, height: 24, patternUnits: 'userSpaceOnUse' },
        s('circle', { cx: 1, cy: 1, r: 1.1, fill: 'var(--grid)' }));
      svg.appendChild(s('defs', null, this.grid));
      this.bg = s('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'url(#gridDots)' });
      svg.appendChild(this.bg);
      this.root = s('g');
      this.gShapes = s('g');
      this.gRange = s('g');
      this.gLinks = s('g');
      this.gLabels = s('g');
      this.gNotes = s('g');
      this.gDevices = s('g');
      this.gPackets = s('g');
      this.gMarkers = s('g');
      this.gOverlay = s('g');
      this.root.append(this.gShapes, this.gRange, this.gLinks, this.gLabels, this.gNotes, this.gDevices, this.gPackets, this.gMarkers, this.gOverlay);
      svg.appendChild(this.root);

      this.emptyState = h('div', { class: 'empty-state' });
      this.wrap.appendChild(this.emptyState);

      const zc = document.getElementById('zoomCtl');
      UI.clear(zc);
      this.zoomVal = h('span', { class: 'val' }, '100%');
      zc.append(
        h('button', { class: 'btn icon small', title: 'Уменьшить (−)', onClick: () => this.zoomBy(1 / 1.2) }, UI.icon('zout')),
        this.zoomVal,
        h('button', { class: 'btn icon small', title: 'Увеличить (+)', onClick: () => this.zoomBy(1.2) }, UI.icon('zin')),
        h('button', { class: 'btn icon small', title: 'Показать всю схему (F)', onClick: () => this.fit() }, UI.icon('fit')),
      );
      this.applyView();
    }

    applyView() {
      const v = this.view;
      this.root.setAttribute('transform', 'translate(' + v.x + ',' + v.y + ') scale(' + v.k + ')');
      const step = 24 * v.k;
      this.grid.setAttribute('width', step);
      this.grid.setAttribute('height', step);
      this.grid.setAttribute('x', v.x % step);
      this.grid.setAttribute('y', v.y % step);
      this.grid.firstChild.setAttribute('r', Math.max(0.6, 1.1 * Math.min(v.k, 1.4)));
      this.zoomVal.textContent = Math.round(v.k * 100) + '%';
    }

    toWorld(clientX, clientY) {
      const r = this.svg.getBoundingClientRect();
      return { x: (clientX - r.left - this.view.x) / this.view.k, y: (clientY - r.top - this.view.y) / this.view.k };
    }

    zoomBy(f, cx, cy) {
      const r = this.svg.getBoundingClientRect();
      if (cx === undefined) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
      const w = this.toWorld(cx, cy);
      const k = Math.max(0.25, Math.min(3, this.view.k * f));
      this.view.k = k;
      this.view.x = cx - r.left - w.x * k;
      this.view.y = cy - r.top - w.y * k;
      this.applyView();
    }

    fit() {
      const devs = [...this.net.devices.values()];
      const pts = devs.map((d) => [d.x, d.y]).concat(this.net.notes.map((n) => [n.x, n.y]))
        .concat(this.net.shapes.flatMap((x) => [[x.x, x.y], [x.x + x.w, x.y + x.h]]));
      const r = this.svg.getBoundingClientRect();
      if (!pts.length) {
        this.view = { x: r.width / 2, y: r.height / 2, k: 1 };
        this.applyView();
        return;
      }
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      minX -= 70; maxX += 70; minY -= 60; maxY += 90;
      const k = Math.max(0.25, Math.min(1.4, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
      this.view = { k, x: r.width / 2 - ((minX + maxX) / 2) * k, y: r.height / 2 - ((minY + maxY) / 2) * k };
      this.applyView();
    }

    centerWorld() {
      const r = this.svg.getBoundingClientRect();
      return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    }

    /* ---------- отрисовка ---------- */

    render() {
      const net = this.net;
      const app = this.app;
      UI.clear(this.gLinks);
      UI.clear(this.gLabels);
      UI.clear(this.gDevices);
      UI.clear(this.gNotes);
      UI.clear(this.gShapes);
      this.linkEls.clear();

      for (const sh of net.shapes) this.renderShape(sh);
      for (const l of net.links.values()) this.renderLink(l);
      if (NS.bt) {
        NS.bt.check(net);
        for (const d of net.devices.values()) {
          const o = d.btRt && d.btRt.audio ? net.getDevice(d.btRt.audio) : null;
          if (o) this.gLinks.appendChild(s('line', { class: 'link-line c-bt', x1: d.x, y1: d.y, x2: o.x, y2: o.y }, s('title', null, 'Bluetooth: ' + d.name + ' → ' + o.name)));
        }
      }

      for (const d of net.devices.values()) {
        const g = s('g', { class: 'dev' + (this.selection.has(d.id) ? ' selected' : '') + (d.power ? '' : ' off') + (this.cableSrc && this.cableSrc.dev === d.id ? ' cable-src' : '') + (this.pduSrc === d.id ? ' cable-src' : ''), 'data-dev': d.id, transform: 'translate(' + d.x + ',' + d.y + ')' });
        g.appendChild(s('rect', { class: 'selbox', x: -40, y: -29, width: 80, height: 84, rx: 9 }));
        const icon = UI.svgFrom(UI.deviceIconFor ? UI.deviceIconFor(d) : UI.deviceIcon(d.type, d.model), { x: -ICON_W / 2, y: -ICON_H / 2 - 4, width: ICON_W, height: ICON_H, viewBox: '0 0 64 48', class: 'icon' });
        g.appendChild(icon);
        g.appendChild(s('rect', { class: 'hit', x: -32, y: -27, width: 64, height: 54 }));
        g.appendChild(s('text', { class: 'model', y: 31 }, d.model));
        g.appendChild(s('text', { class: 'name', y: 44 }, d.name));
        if (app.settings.showIps && d.ifaces) {
          let y = 57;
          for (const f of d.ifaces) {
            if (f.ip == null || f.kind === 'loop') continue;
            g.appendChild(s('text', { class: 'addr', y }, U.cidr(f.ip, f.mask)));
            y += 12;
            if (y > 57 + 12 * 2) break;
          }
        }
        const status = UI.deviceStatusText ? UI.deviceStatusText(d) : null;
        if (status) g.appendChild(s('text', { class: 'addr dev-status ' + (status.cls || ''), y: app.settings.showIps && d.ifaces && d.ifaces.some((f) => f.ip != null && f.kind !== 'loop') ? 70 : 57 }, status.text));
        if (d.unreadCount && d.unreadCount() > 0) {
          const n = d.unreadCount();
          g.appendChild(s('g', { class: 'badge badge-mail', transform: 'translate(25,-22)' }, s('circle', { r: 8.5 }), s('text', { y: 3.5 }, n > 9 ? '9+' : String(n))));
        }
        if (d.conflict) {
          g.appendChild(s('g', { class: 'badge badge-warn', transform: 'translate(-25,-22)' }, s('circle', { r: 8.5 }), s('text', { y: 3.8 }, '!')));
        } else if (d.nvramDirty && d.power && d.nvramDirty() && app.settings.showNvram) {
          g.appendChild(s('g', { class: 'badge badge-nvram', transform: 'translate(-25,-22)' }, s('title', null, 'Есть несохранённые изменения (running-config ≠ startup-config)'), s('circle', { r: 6 })));
        }
        this.gDevices.appendChild(g);
      }

      for (const n of net.notes) {
        const lines = String(n.text).split('\n').slice(0, 12);
        const w = Math.min(760, Math.max(60, ...lines.map((l) => l.length * 6.8 + 18)));
        const hh = lines.length * 16 + 12;
        const g = s('g', { class: 'note-el' + (this.selection.has(n.id) ? ' selected' : ''), 'data-note': n.id, transform: 'translate(' + n.x + ',' + n.y + ')', style: 'cursor:pointer' });
        g.appendChild(s('rect', { x: 0, y: 0, width: w, height: hh, rx: 6 }));
        lines.forEach((l, i) => g.appendChild(s('text', { x: 8, y: 20 + i * 16 }, l)));
        this.gNotes.appendChild(g);
      }

      this.renderRange();
      this.renderEmpty();
    }

    renderShape(sh) {
      const sel = this.selection.has(sh.id);
      const g = s('g', { class: 'shape-el' + (sel ? ' selected' : ''), 'data-shape': sh.id });
      const attrs = { fill: sh.color, 'fill-opacity': 0.12, stroke: sh.color, 'stroke-width': 2 };
      if (sh.kind === 'ellipse') g.appendChild(s('ellipse', Object.assign({ cx: sh.x + sh.w / 2, cy: sh.y + sh.h / 2, rx: sh.w / 2, ry: sh.h / 2 }, attrs)));
      else g.appendChild(s('rect', Object.assign({ x: sh.x, y: sh.y, width: sh.w, height: sh.h, rx: 6 }, attrs)));
      if (sel && this.selection.size === 1) g.appendChild(s('rect', { class: 'shape-handle', 'data-handle': sh.id, x: sh.x + sh.w - 6, y: sh.y + sh.h - 6, width: 12, height: 12, rx: 2 }));
      this.gShapes.appendChild(g);
    }

    /** Радиус действия Wi-Fi выделенных точек доступа. */
    renderRange() {
      UI.clear(this.gRange);
      for (const id of this.selection) {
        const d = this.net.getDevice(id);
        if (!d || !d.ports.some((p) => p.radio)) continue;
        this.gRange.appendChild(s('circle', { class: 'wifi-range' + (d.power && d.radioEnabled && d.radioEnabled() ? '' : ' off'), cx: d.x, cy: d.y, r: d.type === 'celltower' ? this.net.cellRange() : this.net.wifiRange() }));
      }
    }

    renderLink(l) {
      const net = this.net;
      const a = net.getDevice(l.a.dev);
      const b = net.getDevice(l.b.dev);
      if (!a || !b) return;
      const sa = net.portVisualState(a, l.a.port);
      const sb = net.portVisualState(b, l.b.port);
      const down = sa === 'down' || sb === 'down';
      const cls = 'link-line c-' + (l.wireless ? 'wireless' : l.cable) + (down ? ' down' : '') + (this.selLink === l.id ? ' sel' : '') + (net.linkIssue(l) ? ' issue' : '');
      const line = s('line', { class: cls, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      const hit = s('line', { class: 'link-hit', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'data-link': l.id });
      this.gLinks.append(line, hit);
      this.linkEls.set(l.id, line);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const d = Math.min(LIGHT_DIST, len * 0.3);
      if (l.cable !== 'console') {
        if (!l.wireless) this.gLinks.appendChild(s('circle', { class: 'light ' + sa, cx: a.x + ux * d, cy: a.y + uy * d, r: 4.2 }));
        this.gLinks.appendChild(s('circle', { class: 'light ' + sb, cx: b.x - ux * d, cy: b.y - uy * d, r: 4.2 }));
      }
      if (l.cable === 'serial' && l.dce) {
        // значок часов у конца DCE, как в Packet Tracer
        const dceA = l.dce === l.a.dev;
        const cx = dceA ? a.x + ux * (d + 13) : b.x - ux * (d + 13);
        const cy = dceA ? a.y + uy * (d + 13) : b.y - uy * (d + 13);
        this.gLinks.appendChild(s('g', { class: 'dce-clock', transform: 'translate(' + cx.toFixed(1) + ',' + cy.toFixed(1) + ')' }, s('title', null, 'DCE — эта сторона задаёт clock rate'), s('circle', { r: 6 }), s('path', { d: 'M0 -3.5V0l2.4 1.6' })));
      }
      const phys = net.physical;
      if (phys && phys.enabled && !l.wireless && NS.physical) {
        const m = NS.physical.linkLength(net, l);
        const max = NS.physical.MAX_LEN[l.cable];
        const px = uy * 12;
        const py = -ux * 12;
        this.gLabels.appendChild(s('text', { class: 'port-label len-label' + (max && m > max ? ' too-long' : ''), x: (a.x + b.x) / 2 + px, y: (a.y + b.y) / 2 + py + 3, 'text-anchor': 'middle' }, Math.round(m) + ' м'));
      }
      if (this.app.settings.showPorts && len > 110 && !l.wireless) {
        const px = -uy * 11;
        const py = ux * 11;
        const ld = Math.min(58, len * 0.36);
        this.gLabels.appendChild(s('text', { class: 'port-label', x: a.x + ux * ld + px, y: a.y + uy * ld + py + 3, 'text-anchor': 'middle' }, shortName(a.ports[l.a.port].name)));
        this.gLabels.appendChild(s('text', { class: 'port-label', x: b.x - ux * ld + px, y: b.y - uy * ld + py + 3, 'text-anchor': 'middle' }, shortName(b.ports[l.b.port].name)));
      }
    }

    renderEmpty() {
      UI.clear(this.emptyState);
      if (this.net.devices.size || this.net.notes.length || this.net.shapes.length) { this.emptyState.style.display = 'none'; return; }
      this.emptyState.style.display = '';
      this.emptyState.appendChild(h('div', { class: 'card' },
        h('h2', null, 'Постройте свою сеть'),
        h('p', null, 'Выберите устройство на панели слева и щёлкните по схеме (или перетащите его). Затем соедините устройства инструментом «Кабель».'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onClick: () => this.app.showExamples() }, UI.icon('book'), 'Открыть пример'),
          h('button', { class: 'btn outline', onClick: () => this.app.showHelp() }, UI.icon('help'), 'Как пользоваться'))));
    }

    /** Обновить подсветку выделения, не пересоздавая элементы. */
    updateSelection() {
      for (const g of this.gDevices.children) g.classList.toggle('selected', this.selection.has(g.dataset.dev));
      for (const g of this.gNotes.children) g.classList.toggle('selected', this.selection.has(g.dataset.note));
      for (const [id, el] of this.linkEls) el.classList.toggle('sel', this.selLink === id);
      UI.clear(this.gShapes);
      for (const sh of this.net.shapes) this.renderShape(sh);
      this.renderRange();
    }

    /** Обновить только положение объектов при перетаскивании. */
    renderPositions() {
      for (const g of this.gDevices.children) {
        const d = this.net.getDevice(g.dataset.dev);
        if (d) g.setAttribute('transform', 'translate(' + d.x + ',' + d.y + ')');
      }
      for (const g of this.gNotes.children) {
        const n = this.net.notes.find((x) => x.id === g.dataset.note);
        if (n) g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
      }
      UI.clear(this.gLinks);
      UI.clear(this.gLabels);
      UI.clear(this.gShapes);
      this.linkEls.clear();
      for (const sh of this.net.shapes) this.renderShape(sh);
      for (const l of this.net.links.values()) this.renderLink(l);
      this.renderRange();
    }

    /* ---------- анимация: пакеты, вспышки, отметки ---------- */

    frame(now, progress) {
      const act = this.net.activity;
      if (act.length) {
        for (const id of act) this.hot.set(id, now + 170);
        act.length = 0;
      }
      for (const [id, until] of this.hot) {
        const el = this.linkEls.get(id);
        const on = until > now;
        if (el) el.classList.toggle('hot', on);
        if (!on) this.hot.delete(id);
      }

      const seen = new Set();
      if (this.app.mode === 'sim') {
        for (const ev of this.net.inFlight.values()) {
          const proto = P.classify(ev.frame);
          if (!this.app.sim.isVisible(proto)) continue;
          const a = this.net.getDevice(ev.from);
          const b = this.net.getDevice(ev.to);
          if (!a || !b) continue;
          const p = progress(ev);
          const x = a.x + (b.x - a.x) * p;
          const y = a.y + (b.y - a.y) * p;
          let el = this.pktEls.get(ev.seq);
          if (!el) {
            const color = (P.PROTOCOLS[proto] || P.PROTOCOLS.OTHER).color;
            el = s('g', { class: 'pkt', 'data-pkt': ev.seq },
              s('rect', { x: -10, y: -7, width: 20, height: 14, rx: 2.5, fill: color }),
              s('path', { d: 'M-9 -6L0 1.5L9 -6' }));
            this.gPackets.appendChild(el);
            this.pktEls.set(ev.seq, el);
          }
          el.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + (y - 2).toFixed(1) + ')');
          seen.add(ev.seq);
        }
      }
      for (const [seq, el] of this.pktEls) {
        if (!seen.has(seq)) { el.remove(); this.pktEls.delete(seq); }
      }

      if (this.markers.length) {
        UI.clear(this.gMarkers);
        this.markers = this.markers.filter((m) => m.until > now);
        for (const m of this.markers) {
          const d = this.net.getDevice(m.dev);
          if (!d) continue;
          const left = (m.until - now) / m.dur;
          this.gMarkers.appendChild(s('g', { class: 'marker ' + m.kind, transform: 'translate(' + (d.x + (m.kind === 'drop' ? 20 : -20)) + ',' + (d.y - 30) + ')', opacity: Math.min(1, left * 2).toFixed(2) },
            s('text', null, m.kind === 'drop' ? '✕' : '✓')));
        }
      }
    }

    addMarker(devId, kind, dur) {
      if (!devId) return;
      const now = performance.now();
      this.markers = this.markers.filter((m) => !(m.dev === devId && m.kind === kind));
      this.markers.push({ dev: devId, kind, until: now + dur, dur });
    }

    clearPackets() {
      UI.clear(this.gPackets);
      this.pktEls.clear();
      UI.clear(this.gMarkers);
      this.markers = [];
    }

    /* ---------- подсказка инструмента ---------- */

    updateHint() {
      const t = this.app.tool;
      const el = document.getElementById('stageHint');
      let text = '';
      const cab = UI.CABLES.find((c) => c.kind === this.app.cableType) || UI.CABLES[0];
      if (t === 'cable') text = (this.cableSrc ? 'Кабель «' + cab.label + '»: выберите второе устройство · <b>Esc</b> — отмена' : 'Кабель «' + cab.label + '»: выберите первое устройство');
      else if (t === 'pdu') text = this.pduSrc ? 'Проверка связи: выберите получателя · <b>Esc</b> — отмена' : 'Проверка связи (ping): выберите отправителя';
      else if (t === 'mail') text = 'Сообщения: выберите компьютер, с которого отправить';
      else if (t === 'cpdu') text = 'Сложный PDU: выберите устройство-отправителя';
      else if (t === 'inspect') text = 'Инспектор: щёлкните по устройству, чтобы посмотреть его таблицы (ARP, MAC, маршрутизация, NAT…)';
      else if (t === 'delete') text = 'Удаление: щёлкните по устройству, кабелю, заметке или фигуре';
      else if (t === 'note') text = 'Щёлкните по схеме, чтобы добавить заметку';
      else if (t === 'shape') text = 'Фигура: нажмите и протяните по схеме, чтобы нарисовать ' + (this.app.shapeKind === 'ellipse' ? 'эллипс' : 'прямоугольник');
      else if (t && t.startsWith('place:')) text = 'Щёлкните по схеме, чтобы поставить: <b>' + UI.esc(t.slice(6)) + '</b> · <b>Shift</b> — несколько подряд';
      el.innerHTML = text;
      this.svg.setAttribute('class', t && t.startsWith('place:') ? 'tool-place' : 'tool-' + t);
    }

    cancelTool() {
      this.cableSrc = null;
      this.pduSrc = null;
      UI.clear(this.gOverlay);
      this.updateHint();
      this.render();
    }

    /* ---------- события ---------- */

    bind() {
      const svg = this.svg;
      svg.addEventListener('pointerdown', (e) => this.onDown(e));
      svg.addEventListener('pointermove', (e) => this.onMove(e));
      svg.addEventListener('pointerup', (e) => this.onUp(e));
      svg.addEventListener('pointercancel', (e) => this.onUp(e));
      svg.addEventListener('contextmenu', (e) => this.onContext(e));
      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
        this.zoomBy(f, e.clientX, e.clientY);
      }, { passive: false });
      svg.addEventListener('pointerleave', () => { UI.hideTip(); clearTimeout(this.hoverTimer); });
      this.wrap.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-netlab-device')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
      });
      this.wrap.addEventListener('drop', (e) => {
        const model = e.dataTransfer.getData('application/x-netlab-device');
        if (!model) return;
        e.preventDefault();
        const w = this.toWorld(e.clientX, e.clientY);
        this.app.placeDevice(model, w.x, w.y);
      });
    }

    targetOf(e) {
      const t = e.target;
      const handle = t.dataset && t.dataset.handle;
      if (handle) return { kind: 'handle', id: handle };
      const dev = t.closest && t.closest('[data-dev]');
      if (dev) return { kind: 'dev', id: dev.dataset.dev };
      const note = t.closest && t.closest('[data-note]');
      if (note) return { kind: 'note', id: note.dataset.note };
      const pkt = t.closest && t.closest('[data-pkt]');
      if (pkt) return { kind: 'pkt', id: Number(pkt.dataset.pkt) };
      if (t.dataset && t.dataset.link) return { kind: 'link', id: t.dataset.link };
      const sh = t.closest && t.closest('[data-shape]');
      if (sh) return { kind: 'shape', id: sh.dataset.shape };
      return { kind: 'empty' };
    }

    onDown(e) {
      this.svg.focus({ preventScroll: true });
      UI.hideTip();
      clearTimeout(this.hoverTimer);
      const w = this.toWorld(e.clientX, e.clientY);
      const tg = this.targetOf(e);
      const tool = this.app.tool;

      // Двойной щелчок распознаём сами: событие dblclick теряется, если между щелчками
      // перерисовался элемент под курсором.
      const now = performance.now();
      const last = this.lastDown;
      this.lastDown = { t: now, kind: tg.kind, id: tg.id, x: e.clientX, y: e.clientY };
      if (e.button === 0 && last && now - last.t < 420 && last.kind === tg.kind && last.id === tg.id &&
        Math.abs(last.x - e.clientX) < 6 && Math.abs(last.y - e.clientY) < 6 && (tool === 'select' || tool === 'note')) {
        this.lastDown = null;
        this.onDbl(e, tg, w);
        return;
      }

      if (e.button === 1 || e.button === 2 || (e.button === 0 && tg.kind === 'empty' && (tool === 'select' || tool === 'inspect' || e.altKey) && !e.shiftKey)) {
        if (e.button === 2) return;
        this.startPan(e);
        return;
      }
      if (e.button !== 0) return;

      if (tg.kind === 'pkt') { this.app.sim.inspectInFlight(tg.id); return; }

      if (tool && tool.startsWith('place:')) {
        this.app.placeDevice(tool.slice(6), w.x, w.y);
        if (!e.shiftKey) this.app.setTool('select');
        return;
      }

      switch (tool) {
        case 'select': this.selectDown(e, tg, w); break;
        case 'cable': this.cableClick(e, tg); break;
        case 'delete': this.deleteClick(tg); break;
        case 'pdu': this.pduClick(tg); break;
        case 'cpdu': if (tg.kind === 'dev' && UI.complexPdu) UI.complexPdu(this.app, tg.id); break;
        case 'mail': this.mailClick(tg); break;
        case 'inspect': this.inspectClick(e, tg); break;
        case 'shape':
          if (tg.kind === 'empty' || tg.kind === 'shape') this.startShapeDraw(e, w);
          else this.selectDown(e, tg, w);
          break;
        case 'note':
          if (tg.kind === 'empty') this.app.addNote(w.x, w.y);
          else this.selectDown(e, tg, w);
          break;
        default: break;
      }
    }

    startPan(e) {
      const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.drag = { kind: 'pan', start, moved: false };
      this.svg.setPointerCapture(e.pointerId);
      this.svg.classList.add('panning');
    }

    startShapeDraw(e, w) {
      this.drag = { kind: 'shape', start: w, el: s(this.app.shapeKind === 'ellipse' ? 'ellipse' : 'rect', { class: 'rubber' }) };
      this.gOverlay.appendChild(this.drag.el);
      this.svg.setPointerCapture(e.pointerId);
    }

    selectDown(e, tg, w) {
      if (tg.kind === 'handle') {
        const sh = this.net.shapes.find((x) => x.id === tg.id);
        if (!sh) return;
        this.drag = { kind: 'resize', sh, w0: sh.w, h0: sh.h, start: w, moved: false, snap: null };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
      if (tg.kind === 'dev' || tg.kind === 'note' || tg.kind === 'shape') {
        this.selLink = null;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          if (this.selection.has(tg.id)) this.selection.delete(tg.id);
          else this.selection.add(tg.id);
        } else if (!this.selection.has(tg.id)) {
          this.selection.clear();
          this.selection.add(tg.id);
        }
        const items = [];
        for (const id of this.selection) {
          const d = this.net.getDevice(id);
          if (d) items.push({ obj: d, x: d.x, y: d.y });
          const n = this.net.notes.find((x) => x.id === id);
          if (n) items.push({ obj: n, x: n.x, y: n.y });
          const sh = this.net.shapes.find((x) => x.id === id);
          if (sh) items.push({ obj: sh, x: sh.x, y: sh.y });
        }
        this.drag = { kind: 'move', start: w, items, moved: false, snap: null };
        this.svg.setPointerCapture(e.pointerId);
        this.updateSelection();
        this.app.selectionChanged();
        return;
      }
      if (tg.kind === 'link') {
        this.selection.clear();
        this.selLink = tg.id;
        this.updateSelection();
        this.app.selectionChanged();
        return;
      }
      if (tg.kind === 'empty' && e.shiftKey) {
        this.drag = { kind: 'rubber', start: w, el: s('rect', { class: 'rubber' }) };
        this.gOverlay.appendChild(this.drag.el);
        this.svg.setPointerCapture(e.pointerId);
      }
    }

    onMove(e) {
      const w = this.toWorld(e.clientX, e.clientY);
      this.mouse = w;
      const d = this.drag;
      if (d) {
        if (d.kind === 'pan') {
          const dx = e.clientX - d.start.x;
          const dy = e.clientY - d.start.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          this.view.x = d.start.vx + dx;
          this.view.y = d.start.vy + dy;
          this.applyView();
        } else if (d.kind === 'move') {
          const dx = w.x - d.start.x;
          const dy = w.y - d.start.y;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3 / this.view.k) return;
          if (!d.moved) { d.moved = true; d.snap = this.app.snapshot(); }
          const grid = e.altKey ? 1 : 8;
          for (const it of d.items) {
            it.obj.x = Math.round((it.x + dx) / grid) * grid;
            it.obj.y = Math.round((it.y + dy) / grid) * grid;
          }
          // Wi-Fi зависит от расстояния — пересчитать ассоциации на лету
          if (d.items.some((it) => it.obj.ports && it.obj.ports.some((p) => p.media === 'wireless'))) this.net.refreshTopology();
          this.renderPositions();
        } else if (d.kind === 'resize') {
          if (!d.moved) { d.moved = true; d.snap = this.app.snapshot(); }
          d.sh.w = Math.max(20, Math.round((d.w0 + w.x - d.start.x) / 8) * 8);
          d.sh.h = Math.max(20, Math.round((d.h0 + w.y - d.start.y) / 8) * 8);
          this.renderPositions();
        } else if (d.kind === 'rubber' || d.kind === 'shape') {
          const x = Math.min(d.start.x, w.x);
          const y = Math.min(d.start.y, w.y);
          const ww = Math.abs(w.x - d.start.x);
          const hh = Math.abs(w.y - d.start.y);
          if (d.el.tagName === 'ellipse') {
            d.el.setAttribute('cx', x + ww / 2);
            d.el.setAttribute('cy', y + hh / 2);
            d.el.setAttribute('rx', ww / 2);
            d.el.setAttribute('ry', hh / 2);
          } else {
            d.el.setAttribute('x', x);
            d.el.setAttribute('y', y);
            d.el.setAttribute('width', ww);
            d.el.setAttribute('height', hh);
          }
          d.rect = { x, y, w: ww, h: hh };
        }
        return;
      }
      if (this.cableSrc || this.pduSrc) this.drawRubberLine(w);
      this.scheduleTip(e);
    }

    onUp(e) {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      try { this.svg.releasePointerCapture(e.pointerId); } catch (err) { /* уже отпущено */ }
      this.svg.classList.remove('panning');
      if (d.kind === 'pan' && !d.moved && (this.app.tool === 'select' || this.app.tool === 'inspect')) {
        if (this.selection.size || this.selLink) {
          this.selection.clear();
          this.selLink = null;
          this.updateSelection();
          this.app.selectionChanged();
        }
      } else if ((d.kind === 'move' || d.kind === 'resize') && d.moved) {
        this.app.commitSnapshot(d.snap);
      } else if (d.kind === 'shape') {
        d.el.remove();
        const r = d.rect;
        if (r && r.w >= 12 && r.h >= 12) {
          const sh = this.app.mutate(() => this.net.addShape(this.app.shapeKind, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h), this.app.shapeColor));
          this.selection = new Set([sh.id]);
          this.app.setTool('select');
        }
      } else if (d.kind === 'rubber') {
        const r = d.rect || { x: 0, y: 0, w: 0, h: 0 };
        d.el.remove();
        const inside = (x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
        for (const dev of this.net.devices.values()) if (inside(dev.x, dev.y)) this.selection.add(dev.id);
        for (const n of this.net.notes) if (inside(n.x, n.y)) this.selection.add(n.id);
        for (const sh of this.net.shapes) if (inside(sh.x + sh.w / 2, sh.y + sh.h / 2)) this.selection.add(sh.id);
        this.updateSelection();
        this.app.selectionChanged();
      }
    }

    onDbl(e, tg, w) {
      if (this.drag) {
        try { this.svg.releasePointerCapture(e.pointerId); } catch (err) { /* нет захвата */ }
        this.drag = null;
        this.svg.classList.remove('panning');
      }
      if (tg.kind === 'dev') this.app.openDevice(tg.id);
      else if (tg.kind === 'note') this.app.editNote(tg.id);
      else if (tg.kind === 'shape') this.shapeMenu(e.clientX, e.clientY, tg.id);
      else if (tg.kind === 'empty' && this.app.tool === 'select') this.addMenu(e.clientX, e.clientY, w);
    }

    onContext(e) {
      e.preventDefault();
      const tg = this.targetOf(e);
      const w = this.toWorld(e.clientX, e.clientY);
      if (tg.kind === 'dev') {
        const d = this.net.getDevice(tg.id);
        if (!this.selection.has(d.id)) { this.selection.clear(); this.selection.add(d.id); this.updateSelection(); }
        const items = [{ title: d.name + ' · ' + d.model }, { label: 'Настройка', right: 'двойной щелчок', onClick: () => this.app.openDevice(d.id, 'config') }];
        items.push({ label: 'Физический вид (модули, питание)', onClick: () => this.app.openDevice(d.id, 'physical') });
        if (NS.cli.isIos(d)) items.push({ label: 'CLI — консоль IOS', onClick: () => this.app.openDevice(d.id, 'cli') });
        if (d.sendMail && d.type !== 'printer') {
          items.push({ label: 'Командная строка', onClick: () => { this.app.deskState(d.id).app = 'cmd'; this.app.openDevice(d.id, 'desktop'); } });
          items.push({ label: 'Рабочий стол', onClick: () => this.app.openDevice(d.id, 'desktop') });
        }
        if (d.ifaces || d.macTable) items.push({ label: 'Таблицы (инспектор)…', onClick: () => this.inspectMenu(e.clientX, e.clientY, d) });
        items.push('-',
          { label: 'Переименовать…', onClick: () => this.app.renameDevice(d.id) },
          { label: d.power ? 'Выключить питание' : 'Включить питание', onClick: () => this.app.togglePower(d.id) },
          { label: 'Дублировать', right: 'Ctrl+D', onClick: () => this.app.duplicate([d.id]) },
          '-',
          { label: 'Удалить', danger: true, right: 'Del', onClick: () => this.app.deleteIds([d.id]) });
        UI.menu(e.clientX, e.clientY, items);
      } else if (tg.kind === 'link') {
        const l = this.net.links.get(tg.id);
        if (!l) return;
        const a = this.net.getDevice(l.a.dev);
        const b = this.net.getDevice(l.b.dev);
        const issue = this.net.linkIssue(l);
        const items = [
          { title: a.name + ' ' + a.ports[l.a.port].name + ' ↔ ' + b.name + ' ' + b.ports[l.b.port].name },
          { title: 'Кабель: ' + (NS.Network.CABLES[l.cable] || l.cable) + (l.cable === 'serial' ? ' (DCE: ' + (l.dce === a.id ? a.name : b.name) + ')' : '') },
        ];
        if (issue) items.push({ title: '⚠ ' + issue });
        if (!l.wireless) items.push('-', { label: 'Удалить кабель', danger: true, onClick: () => this.app.deleteLink(l.id) });
        else items.push({ title: 'Беспроводная связь пропадает, если сменить SSID/пароль или отнести устройство дальше.' });
        UI.menu(e.clientX, e.clientY, items);
      } else if (tg.kind === 'note') {
        UI.menu(e.clientX, e.clientY, [
          { label: 'Изменить текст', onClick: () => this.app.editNote(tg.id) },
          { label: 'Удалить заметку', danger: true, onClick: () => this.app.deleteIds([tg.id]) },
        ]);
      } else if (tg.kind === 'shape' || tg.kind === 'handle') {
        this.shapeMenu(e.clientX, e.clientY, tg.id);
      } else {
        this.addMenu(e.clientX, e.clientY, w);
      }
    }

    shapeMenu(x, y, id) {
      const colors = [['#3b82f6', 'Синий'], ['#22c55e', 'Зелёный'], ['#f59e0b', 'Жёлтый'], ['#ef4444', 'Красный'], ['#a855f7', 'Фиолетовый'], ['#64748b', 'Серый']];
      const setColor = (c) => this.app.mutate(() => { const sh = this.net.shapes.find((z) => z.id === id); if (sh) sh.color = c; });
      UI.menu(x, y, [{ title: 'Фигура' }].concat(colors.map(([c, n]) => ({ label: n, icon: h('span', { class: 'swatch', style: { background: c } }), onClick: () => setColor(c) })),
        ['-', { label: 'На задний план', onClick: () => this.app.mutate(() => { const i = this.net.shapes.findIndex((z) => z.id === id); if (i > 0) this.net.shapes.unshift(this.net.shapes.splice(i, 1)[0]); }) },
          { label: 'Удалить фигуру', danger: true, onClick: () => this.app.deleteIds([id]) }]));
    }

    addMenu(cx, cy, w) {
      const items = [];
      for (const c of UI.DEVICE_CATEGORIES) {
        if (c.noQuickAdd) continue;
        items.push({ title: c.label });
        for (const m of c.models) {
          const spec = NS.models.get(m);
          items.push({ label: m, right: UI.typeLabel(spec.type), icon: UI.deviceSvg(spec.type, 'mi', m), onClick: () => this.app.placeDevice(m, w.x, w.y) });
        }
      }
      items.push('-', { label: 'Заметку', onClick: () => this.app.addNote(w.x, w.y) });
      UI.menu(cx, cy, items, 'models');
    }

    /* ---------- инструменты ---------- */

    /** Меню выбора порта: совместимые с кабелем порты доступны, остальные — с причиной. */
    choosePort(dev, x, y, other, cb) {
      const kind = fitKind(this.app.cableType);
      const Net = NS.Network;
      const fits = (p) => {
        if (!Net.portFits(kind, p)) return false;
        if (other) {
          const od = this.net.getDevice(other.dev);
          const op = od && od.ports[other.port];
          if (op && !Net.pairFits(kind, op, p)) return false;
        }
        return true;
      };
      const usable = (p) => !p.link && !p.radio && fits(p);
      const free = dev.ports.findIndex(usable);
      if (this.app.settings.autoPorts) {
        if (free < 0) { UI.toast('У ' + dev.name + ' нет свободных портов для этого кабеля', 'err'); return; }
        cb(free);
        return;
      }
      const items = [{ title: dev.name + ': выберите порт' }];
      items.push({ label: 'Первый подходящий', right: free >= 0 ? shortName(dev.ports[free].name) : 'нет', disabled: free < 0, onClick: () => cb(free) }, '-');
      dev.ports.forEach((p, i) => {
        if (p.radio) return;
        let right = '';
        const ok = fits(p);
        if (p.link) {
          const pr = this.net.peer(dev, i);
          right = pr ? '→ ' + pr.dev.name : 'занят';
        } else if (!ok) {
          right = p.media === 'console' || p.media === 'rs232' ? 'консольный кабель' : p.media === 'fiber' ? 'оптика' : p.media === 'serial' ? 'Serial-кабель' : p.media === 'wireless' ? 'Wi-Fi' : 'не подходит';
        } else if (dev.type === 'switch' && p.mode === 'trunk') right = 'trunk';
        else if (dev.type === 'switch' && p.vlan !== 1) right = 'VLAN ' + p.vlan;
        items.push({ label: p.name, right, disabled: !!p.link || !ok, onClick: () => cb(i) });
      });
      UI.menu(x, y, items, 'ports');
    }

    cableClick(e, tg) {
      if (tg.kind !== 'dev') {
        if (this.cableSrc) this.cancelTool();
        return;
      }
      const dev = this.net.getDevice(tg.id);
      if (!this.cableSrc) {
        this.choosePort(dev, e.clientX, e.clientY, null, (port) => {
          this.cableSrc = { dev: dev.id, port };
          this.updateHint();
          this.render();
          this.drawRubberLine(this.mouse);
        });
        return;
      }
      if (this.cableSrc.dev === dev.id) { this.cancelTool(); return; }
      const src = this.cableSrc;
      this.choosePort(dev, e.clientX, e.clientY, src, (port) => {
        this.cableSrc = null;
        UI.clear(this.gOverlay);
        this.app.connect(src.dev, src.port, dev.id, port, this.app.cableType);
        this.updateHint();
      });
    }

    drawRubberLine(w) {
      UI.clear(this.gOverlay);
      const id = this.cableSrc ? this.cableSrc.dev : this.pduSrc;
      const d = id && this.net.getDevice(id);
      if (!d) return;
      const st = this.cableSrc ? UI.CABLE_STYLE[this.app.cableType] : null;
      this.gOverlay.appendChild(s('line', { class: 'rubber-line', x1: d.x, y1: d.y, x2: w.x, y2: w.y, style: st ? 'stroke:' + st.color : null }));
    }

    deleteClick(tg) {
      if (tg.kind === 'dev' || tg.kind === 'note' || tg.kind === 'shape') this.app.deleteIds([tg.id]);
      else if (tg.kind === 'link') this.app.deleteLink(tg.id);
    }

    pduClick(tg) {
      if (tg.kind !== 'dev') { if (this.pduSrc) this.cancelTool(); return; }
      const dev = this.net.getDevice(tg.id);
      if (!dev.ifaces) { UI.toast(UI.typeLabel(dev.type) + ' не имеет IP-адреса — выберите ПК, сервер или маршрутизатор', 'err'); return; }
      if (!this.pduSrc) {
        this.pduSrc = dev.id;
        this.updateHint();
        this.render();
        return;
      }
      const src = this.pduSrc;
      this.pduSrc = null;
      UI.clear(this.gOverlay);
      this.updateHint();
      this.render();
      this.app.simplePdu(src, dev.id);
    }

    mailClick(tg) {
      if (tg.kind !== 'dev') return;
      const dev = this.net.getDevice(tg.id);
      if (!dev.sendMail || dev.type === 'printer') { UI.toast('Сообщения отправляются с компьютеров, ноутбуков, планшетов и серверов', 'err'); return; }
      this.app.openDevice(dev.id, 'mail');
      this.app.setTool('select');
    }

    inspectClick(e, tg) {
      if (tg.kind !== 'dev') return;
      const d = this.net.getDevice(tg.id);
      if (!d.ifaces && !d.macTable) { UI.toast('У концентратора и точки доступа нет таблиц — это устройства 1-го/2-го уровня без памяти', 'warn'); return; }
      this.inspectMenu(e.clientX, e.clientY, d);
    }

    inspectMenu(x, y, d) {
      const items = [{ title: d.name + ' — таблицы' }];
      for (const t of UI.inspectTables(d)) items.push({ label: t.label, onClick: () => UI.openInspector(this.app, d.id, t.id) });
      UI.menu(x, y, items);
    }

    /* ---------- всплывающие подсказки ---------- */

    scheduleTip(e) {
      clearTimeout(this.hoverTimer);
      UI.hideTip();
      const tg = this.targetOf(e);
      if (tg.kind !== 'dev' && tg.kind !== 'link' && tg.kind !== 'pkt') return;
      const x = e.clientX;
      const y = e.clientY;
      this.hoverTimer = setTimeout(() => {
        const c = this.tipContent(tg);
        if (c) UI.showTip(x, y, c);
      }, tg.kind === 'pkt' ? 80 : 450);
    }

    tipContent(tg) {
      const net = this.net;
      if (tg.kind === 'pkt') {
        const ev = [...net.inFlight.values()].find((x) => x.seq === tg.id);
        if (!ev) return null;
        return h('div', null, h('div', { class: 'tt-title' }, P.summary(ev.frame)), h('div', { class: 'muted' }, 'Щёлкните, чтобы открыть подробности'));
      }
      if (tg.kind === 'link') {
        const l = net.links.get(tg.id);
        if (!l) return null;
        const a = net.getDevice(l.a.dev);
        const b = net.getDevice(l.b.dev);
        const st = (d, i) => ({ up: 'работает', down: 'не активен', blocking: 'заблокирован STP' }[net.portVisualState(d, i)]);
        const issue = net.linkIssue(l);
        return h('div', null, h('div', { class: 'tt-title' }, NS.Network.CABLES[l.cable] || 'Кабель'),
          h('table', null,
            h('tr', null, h('td', null, a.name + ' ' + (a.ports[l.a.port].radio ? 'Wi-Fi' : a.ports[l.a.port].name)), h('td', null, l.cable === 'console' ? '' : st(a, l.a.port))),
            h('tr', null, h('td', null, b.name + ' ' + b.ports[l.b.port].name), h('td', null, l.cable === 'console' ? '' : st(b, l.b.port)))),
          issue ? h('div', { style: { color: 'var(--warn)', marginTop: '4px', maxWidth: '320px' } }, '⚠ ' + issue) : null);
      }
      const d = net.getDevice(tg.id);
      if (!d) return null;
      const rows = [];
      if (d.ifaces) {
        let shown = 0;
        for (const f of d.ifaces) {
          const up = d.ifaceUp(f);
          const p = f.port >= 0 ? d.ports[f.port] : null;
          if ((d.type === 'router' || d.type === 'switch' || d.type === 'wrouter') && f.ip == null && !(p && p.link)) continue;
          if (++shown > 8) break;
          rows.push(h('tr', null, h('td', null, shortName(f.name)), h('td', null, f.ip != null ? U.cidr(f.ip, f.mask) : 'нет IP'), h('td', null, up ? '▲' : '▼')));
        }
        if (d.gateway != null) rows.push(h('tr', null, h('td', null, 'Шлюз'), h('td', null, U.ipStr(d.gateway)), h('td', null, '')));
        if (d.defaultGateway != null) rows.push(h('tr', null, h('td', null, 'Шлюз'), h('td', null, U.ipStr(d.defaultGateway)), h('td', null, '')));
        if (d.iface && d.iface.dhcp) rows.push(h('tr', null, h('td', null, 'DHCP'), h('td', null, d.dhcpc && d.dhcpc.phase === 'bound' ? 'получен' : d.dhcpc && d.dhcpc.phase === 'failed' ? 'ошибка' : 'запрос…'), h('td', null, '')));
        if (d.iface && d.type !== 'router') rows.push(h('tr', null, h('td', null, 'MAC'), h('td', null, d.ifaceMac(d.iface)), h('td', null, '')));
      }
      if (d.macTable || !d.ifaces) {
        const used = d.ports.filter((p) => p.link && NS.Network.isData(p)).length;
        rows.push(h('tr', null, h('td', null, 'Порты'), h('td', null, used + ' из ' + d.ports.filter((p) => NS.Network.isData(p) && !p.radio).length + ' заняты')));
        if (d.stpInfo) rows.push(h('tr', null, h('td', null, 'STP'), h('td', null, d.stpInfo.isRoot ? 'корневой мост' : 'корень: ' + d.stpInfo.rootName)));
        const blocked = d.ports.filter((p) => p.stp === 'blocking').map((p) => shortName(p.name));
        if (blocked.length) rows.push(h('tr', null, h('td', null, 'Заблокированы'), h('td', null, blocked.join(', '))));
      }
      if (d.wifi && d.ports.some((p) => p.radio)) rows.push(h('tr', null, h('td', null, 'Wi-Fi'), h('td', null, '«' + d.wifi.ssid + '», клиентов: ' + d.wirelessClients().length)));
      else if (d.wifi && d.ports.some((p) => p.media === 'wireless')) {
        const r = net.wirelessStatus(d);
        rows.push(h('tr', null, h('td', null, 'Wi-Fi'), h('td', null, r && r.ap ? '«' + r.ap.wifi.ssid + '»' : 'нет связи')));
      }
      const dirty = d.nvramDirty && d.power && d.nvramDirty();
      return h('div', null,
        h('div', { class: 'tt-title' }, d.name + ' · ' + d.model + (d.power ? '' : ' (выключен)')),
        h('table', null, rows),
        dirty ? h('div', { class: 'muted', style: { marginTop: '4px' } }, 'Конфигурация не сохранена в NVRAM (copy run start)') : null,
        d.conflict ? h('div', { style: { color: 'var(--warn)', marginTop: '4px' } }, '⚠ Конфликт IP-адресов с ' + d.conflict.mac) : null);
    }
  }

  function shortName(n) {
    return n.replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^Serial/, 'Se');
  }

  UI.shortIf = shortName;
  UI.Workspace = Workspace;
})(globalThis.NetLab = globalThis.NetLab || {});
