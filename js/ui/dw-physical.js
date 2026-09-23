/* NetLab UI — вкладка «Физический вид»: панель устройства (порты со светодиодами, слоты, кнопка питания),
 * список модулей с описанием. Модуль ставится перетаскиванием в слот — только при выключенном питании. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const s = UI.s;
  const DW = NS.dw;
  const M = NS.models;

  /* ---------- значки портов ---------- */

  function ledColor(net, dev, i) {
    const p = dev.ports[i];
    if (!dev.power) return '#2a2f37';
    if (p.errDisabled) return '#f59e0b';
    const st = net.portVisualState(dev, i);
    if (st === 'up') return '#22c55e';
    if (st === 'blocking') return '#f59e0b';
    return p.link ? '#ef4444' : '#2a2f37';
  }

  function portGlyph(p, x, y, led) {
    const g = s('g', { transform: 'translate(' + x + ',' + y + ')' });
    switch (p.media) {
      case 'serial':
        g.append(s('path', { d: 'M-15 -7 H15 L12 7 H-12 Z', fill: '#1b1f25', stroke: '#8792a2', 'stroke-width': 1 }));
        for (let k = -9; k <= 9; k += 4.5) g.appendChild(s('circle', { cx: k, cy: 0, r: 1.1, fill: '#9aa5b3' }));
        break;
      case 'fiber':
        g.append(s('rect', { x: -10, y: -8, width: 20, height: 16, rx: 2, fill: '#1b1f25', stroke: '#8792a2' }),
          s('rect', { x: -7, y: -4, width: 5, height: 8, fill: '#e5e7eb' }), s('rect', { x: 2, y: -4, width: 5, height: 8, fill: '#e5e7eb' }));
        break;
      case 'console':
        g.append(s('rect', { x: -9, y: -7, width: 18, height: 14, rx: 1.5, fill: '#7dd3fc', stroke: '#0c4a6e' }), s('rect', { x: -5, y: -3, width: 10, height: 7, fill: '#0c4a6e' }));
        return g;
      case 'rs232':
        g.append(s('path', { d: 'M-14 -7 H14 L11 7 H-11 Z', fill: '#475569', stroke: '#1e293b' }));
        for (let k = -8; k <= 8; k += 4) g.appendChild(s('circle', { cx: k, cy: -1, r: 1.1, fill: '#cbd5e1' }));
        return g;
      case 'wireless':
        g.append(s('path', { d: 'M-8 4 a10 10 0 0 1 16 0 M-5 1 a6 6 0 0 1 10 0', fill: 'none', stroke: '#93c5fd', 'stroke-width': 1.6 }), s('circle', { cx: 0, cy: 5, r: 1.8, fill: '#93c5fd' }));
        break;
      default:
        g.append(s('rect', { x: -9, y: -7, width: 18, height: 14, rx: 1.5, fill: '#1b1f25', stroke: '#8792a2' }), s('path', { d: 'M-5 -3 H5 V3 H3 V5 H-3 V3 H-5 Z', fill: '#3b4250' }));
    }
    if (led) g.appendChild(s('rect', { x: -3, y: -13, width: 6, height: 3, rx: 1, fill: led }));
    return g;
  }

  function screws(g, x, y, w, hh) {
    for (const [a, b] of [[x + 6, y + hh / 2], [x + w - 6, y + hh / 2]]) g.appendChild(s('circle', { cx: a, cy: b, r: 2.4, fill: '#9aa5b3', stroke: '#5b6778' }));
  }

  /* ---------- раскладка панелей ---------- */

  /** Координаты встроенных портов и слотов для модели. */
  function layout(dev) {
    const t = dev.type;
    const L = { w: 440, h: 260, body: [], ports: {}, slots: {}, power: null, title: dev.model };
    const byName = (n) => dev.portIndex(n);
    const put = (name, x, y) => { const i = byName(name); if (i >= 0) L.ports[i] = [x, y]; };
    if (t === 'pc' || t === 'server' || t === 'printer') {
      L.w = 460; L.h = 280;
      if (t === 'printer') L.body.push({ kind: 'printer', x: 20, y: 60, w: 190, h: 160 });
      else L.body.push({ kind: t === 'server' ? 'server' : 'tower', x: 24, y: 16, w: 160, h: 248 });
      L.power = t === 'printer' ? [180, 200] : [104, 150];
      L.body.push({ kind: 'rear', x: 220, y: 16, w: 220, h: 248 });
      put('RS 232', 270, 70);
      L.slots.nic = [240, 180, 180, 60];
    } else if (t === 'laptop') {
      L.w = 460; L.h = 250;
      L.body.push({ kind: 'laptop', x: 20, y: 20, w: 240, h: 210 });
      L.power = [140, 200];
      L.body.push({ kind: 'rear', x: 290, y: 30, w: 150, h: 190 });
      put('RS 232', 330, 70);
      L.slots.nic = [305, 140, 120, 55];
    } else if (t === 'tablet') {
      L.w = 320; L.h = 230;
      L.body.push({ kind: 'tablet', x: 40, y: 20, w: 240, h: 190 });
      L.power = [160, 198];
      put('Wireless0', 262, 34);
    } else if (t === 'router') {
      const nS = dev.slots.length;
      const gig = dev.ports.filter((p) => /^GigabitEthernet0\/\d$/.test(p.name));
      L.w = Math.max(520, 60 + Math.max(nS * 155, 200 + gig.length * 52) + 60);
      L.h = 160;
      L.body.push({ kind: 'chassis', x: 10, y: 10, w: L.w - 20, h: 140, fill: '#3c4a5c' });
      dev.slots.forEach((sl, i) => { L.slots[sl.id] = [30 + i * 155, 24, 140, 46]; });
      L.power = [42, 112];
      put('Console', 100, 112);
      gig.forEach((p, i) => put(p.name, 180 + i * 52, 112));
    } else if (t === 'switch') {
      L.w = 780; L.h = 120;
      L.body.push({ kind: 'chassis', x: 10, y: 10, w: 760, h: 100, fill: dev.spec.l3 ? '#355070' : '#44607f' });
      L.power = [38, 72];
      for (let n = 1; n <= 24; n++) {
        const col = Math.floor((n - 1) / 2);
        const x = 110 + col * 40 + (col >= 6 ? 12 : 0);
        put('FastEthernet0/' + n, x, n % 2 ? 44 : 84);
      }
      put('GigabitEthernet0/1', 640, 64);
      put('GigabitEthernet0/2', 684, 64);
      put('Console', 736, 64);
    } else if (t === 'hub') {
      L.w = 400; L.h = 110;
      L.body.push({ kind: 'chassis', x: 10, y: 10, w: 380, h: 90, fill: '#5b6b80' });
      L.power = [40, 58];
      dev.ports.forEach((p, i) => put(p.name, 90 + i * 38, 62));
    } else if (t === 'ap' || t === 'wrouter') {
      const wr = t === 'wrouter';
      L.w = wr ? 440 : 340; L.h = 190;
      L.body.push({ kind: 'ap', x: 20, y: 70, w: L.w - 40, h: 100, antennas: wr ? 3 : 2 });
      L.power = [56, 136];
      if (wr) {
        put('Internet', 130, 136);
        for (let n = 1; n <= 4; n++) put('Ethernet ' + n, 170 + n * 40, 136);
        put('Wireless', L.w - 70, 100);
      } else {
        put('Port 0', 170, 136);
        put('Port 1', L.w - 70, 100);
      }
    }
    return L;
  }

  function drawBody(g, b) {
    switch (b.kind) {
      case 'tower':
      case 'server': {
        g.appendChild(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill: b.kind === 'server' ? '#4b5563' : '#d6dade', stroke: '#6b7280' }));
        const face = b.kind === 'server' ? '#374151' : '#c3c8ce';
        for (let k = 0; k < 2; k++) g.appendChild(s('rect', { x: b.x + 16, y: b.y + 16 + k * 36, width: b.w - 32, height: 28, rx: 3, fill: face, stroke: '#8b939e' }));
        g.appendChild(s('rect', { x: b.x + 50, y: b.y + 30, width: 60, height: 5, rx: 2, fill: '#6b7280' }));
        for (let yy = b.y + 175; yy < b.y + b.h - 10; yy += 12) {
          for (let xx = b.x + 18; xx < b.x + b.w - 10; xx += 12) g.appendChild(s('circle', { cx: xx, cy: yy, r: 3, fill: b.kind === 'server' ? '#1f2937' : '#7b8390' }));
        }
        g.appendChild(s('text', { x: b.x + b.w / 2, y: b.y + b.h - 8, 'text-anchor': 'middle', class: 'phys-label' }, b.kind === 'server' ? 'Server-PT' : 'PC-PT'));
        break;
      }
      case 'printer':
        g.appendChild(s('rect', { x: b.x, y: b.y + 30, width: b.w, height: b.h - 30, rx: 10, fill: '#d6dade', stroke: '#6b7280' }));
        g.appendChild(s('rect', { x: b.x + 30, y: b.y, width: b.w - 60, height: 40, fill: '#f8fafc', stroke: '#94a3b8' }));
        g.appendChild(s('rect', { x: b.x + 20, y: b.y + b.h - 40, width: b.w - 40, height: 14, rx: 3, fill: '#9aa5b3' }));
        g.appendChild(s('text', { x: b.x + 50, y: b.y + 80, class: 'phys-label' }, 'Printer-PT'));
        break;
      case 'laptop':
        g.appendChild(s('rect', { x: b.x + 20, y: b.y, width: b.w - 40, height: 130, rx: 8, fill: '#9aa8bb', stroke: '#4b5563' }));
        g.appendChild(s('rect', { x: b.x + 32, y: b.y + 12, width: b.w - 64, height: 106, rx: 3, fill: '#1d3b63' }));
        g.appendChild(s('path', { d: 'M' + b.x + ' ' + (b.y + 140) + ' H' + (b.x + b.w) + ' L' + (b.x + b.w - 20) + ' ' + (b.y + b.h) + ' H' + (b.x + 20) + ' Z', fill: '#6b7a8f', stroke: '#4b5563' }));
        for (let r = 0; r < 3; r++) for (let c = 0; c < 12; c++) g.appendChild(s('rect', { x: b.x + 30 + c * 15, y: b.y + 148 + r * 11, width: 12, height: 8, rx: 1.5, fill: '#4b5563' }));
        break;
      case 'tablet':
        g.appendChild(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 18, fill: '#1f2937', stroke: '#4b5563' }));
        g.appendChild(s('rect', { x: b.x + 16, y: b.y + 16, width: b.w - 32, height: b.h - 44, rx: 4, fill: '#1d3b63' }));
        g.appendChild(s('text', { x: b.x + b.w / 2, y: b.y + 80, 'text-anchor': 'middle', class: 'phys-label light' }, 'TabletPC-PT'));
        g.appendChild(s('text', { x: b.x + b.w / 2, y: b.y + 100, 'text-anchor': 'middle', class: 'phys-label light' }, 'Wi-Fi встроен'));
        break;
      case 'rear':
        g.appendChild(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill: '#8f98a4', stroke: '#5b6778' }));
        g.appendChild(s('text', { x: b.x + 12, y: b.y + 22, class: 'phys-label' }, 'Задняя панель'));
        break;
      case 'chassis':
        g.appendChild(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, fill: b.fill, stroke: '#1e293b' }));
        break;
      case 'ap': {
        for (let k = 0; k < b.antennas; k++) {
          const ax = b.x + 40 + (k * (b.w - 80)) / Math.max(1, b.antennas - 1);
          g.appendChild(s('line', { x1: ax, y1: b.y, x2: ax, y2: b.y - 56, stroke: '#1f2937', 'stroke-width': 7, 'stroke-linecap': 'round' }));
        }
        g.appendChild(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 14, fill: '#27303d', stroke: '#111827' }));
        g.appendChild(s('text', { x: b.x + 18, y: b.y + 26, class: 'phys-label light' }, b.antennas === 3 ? 'Linksys WRT300N' : 'AccessPoint-PT'));
        break;
      }
      default: break;
    }
  }

  function moduleSvg(modId) {
    const m = M.module(modId);
    const svg = s('svg', { viewBox: '0 0 180 60', width: 180, height: 60 });
    svg.appendChild(s('rect', { x: 2, y: 2, width: 176, height: 56, rx: 4, fill: '#9aa5b3', stroke: '#475569' }));
    screws(svg, 2, 2, 176, 56);
    if (m) {
      m.ports.forEach((pp, k) => svg.appendChild(portGlyph({ media: pp.media }, 60 + k * 50, 34, null)));
      svg.appendChild(s('text', { x: 90, y: 16, 'text-anchor': 'middle', class: 'phys-label' }, m.title));
    }
    return svg;
  }

  /* ---------- вкладка ---------- */

  DW.physicalTab = function (app, id) {
    const st = { zoom: null, sel: null };
    const tab = {
      id: 'physical',
      label: 'Физический вид',
      flush: true,
      render(body) {
        const dev = app.net.getDevice(id);
        const kinds = [...new Set(dev.slots.map((x) => x.kind))];
        const mods = kinds.flatMap((k) => M.modulesFor(k));
        const list = h('div', { class: 'mod-list' }, h('div', { class: 'mod-head' }, 'МОДУЛИ'));
        const desc = h('div', { class: 'mod-desc' });
        const descImg = h('div', { class: 'mod-img' });
        const showDesc = (mid) => {
          st.sel = mid;
          UI.clear(desc);
          UI.clear(descImg);
          const m = mid && M.module(mid);
          if (m) {
            desc.textContent = m.title + ': ' + m.desc;
            descImg.appendChild(moduleSvg(mid));
          } else {
            desc.textContent = dev.slots.length
              ? 'Выберите модуль слева и перетащите его в свободный слот на изображении устройства. Модули меняются только при выключенном питании — нажмите кнопку питания на устройстве.'
              : (dev.spec.title + '. У этой модели нет сменных модулей. Кнопка питания включает и выключает устройство.');
          }
          for (const x of list.querySelectorAll('.mod-item')) x.classList.toggle('on', x.dataset.mod === mid);
        };
        if (!mods.length) list.appendChild(h('div', { class: 'muted', style: { padding: '8px', fontSize: '12px' } }, 'Нет сменных модулей'));
        for (const mid of mods) {
          const it = h('div', { class: 'mod-item', draggable: 'true', 'data-mod': mid, title: M.module(mid).desc }, mid);
          it.addEventListener('click', () => showDesc(mid));
          it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-netlab-module', mid); e.dataTransfer.effectAllowed = 'copy'; showDesc(mid); });
          list.appendChild(it);
        }

        const stage = h('div', { class: 'phys-stage' });
        const zoomBar = h('div', { class: 'phys-zoom' },
          h('button', { class: 'btn small outline', onClick: () => { st.zoom = Math.min(2.5, st.zoom * 1.25); draw(); } }, 'Увеличить'),
          h('button', { class: 'btn small outline', onClick: () => { st.zoom = 1; draw(); } }, 'Исходный размер'),
          h('button', { class: 'btn small outline', onClick: () => { st.zoom = Math.max(0.5, st.zoom / 1.25); draw(); } }, 'Уменьшить'));

        const install = (slotId, mid) => {
          const d = app.net.getDevice(id);
          if (d.power) {
            UI.toast('Нельзя менять модули при включённом питании. Выключите устройство кнопкой питания.', 'err', 5000);
            return;
          }
          DW.apply(app, () => app.net.setModule(d, slotId, mid), null, mid ? 'Модуль ' + mid + ' установлен' : 'Модуль извлечён');
        };

        const draw = () => {
          const d = app.net.getDevice(id);
          if (!d) return;
          // перерисовываем только при изменениях — иначе перетаскивание модуля прерывалось бы
          const sig = JSON.stringify([d.power, st.zoom, d.slots.map((x) => x.module), d.ports.map((p, i) => ledColor(app.net, d, i) + (p.link || '') + (p.radio && p.wlinks ? p.wlinks.size : ''))]);
          if (sig === st.sig && stage.isConnected && stage.firstChild) return;
          st.sig = sig;
          const L = layout(d);
          // по умолчанию — «по ширине окна», как «Original Size» в Packet Tracer, но без прокрутки
          if (st.zoom == null) st.zoom = stage.clientWidth > 80 ? Math.max(0.5, Math.min(1.25, (stage.clientWidth - 40) / L.w)) : 1;
          UI.clear(stage);
          const svg = s('svg', { viewBox: '0 0 ' + L.w + ' ' + L.h, width: L.w * st.zoom, height: L.h * st.zoom, class: 'phys-svg' + (d.power ? '' : ' off') });
          for (const b of L.body) drawBody(svg, b);
          // слоты
          for (const sl of d.slots) {
            const r = L.slots[sl.id];
            if (!r) continue;
            const [x, y, w, hh] = r;
            const g = s('g', { class: 'phys-slot', 'data-slot': sl.id });
            g.appendChild(s('rect', { x, y, width: w, height: hh, rx: 3, fill: sl.module ? '#9aa5b3' : '#6b7280', stroke: '#1f2937', 'stroke-dasharray': sl.module ? null : '4 3' }));
            screws(g, x, y, w, hh);
            if (!sl.module) g.appendChild(s('text', { x: x + w / 2, y: y + hh / 2 + 4, 'text-anchor': 'middle', class: 'phys-label light small' }, sl.label || 'слот'));
            else {
              const m = M.module(sl.module);
              g.appendChild(s('text', { x: x + w - 8, y: y + 12, 'text-anchor': 'end', class: 'phys-label small' }, m.title));
              const mp = d.ports.map((p, i) => ({ p, i })).filter((x2) => x2.p.module === sl.module && (d.type !== 'router' || x2.p.name.includes('0/' + sl.n + '/') || !x2.p.name.includes('/')));
              mp.forEach((o, k) => {
                const px = x + 32 + k * Math.min(56, (w - 50) / Math.max(1, mp.length - 0.5));
                L.ports[o.i] = [px, y + hh / 2 + 6];
              });
            }
            g.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-netlab-module')) { e.preventDefault(); g.classList.add('drop'); } });
            g.addEventListener('dragleave', () => g.classList.remove('drop'));
            g.addEventListener('drop', (e) => {
              e.preventDefault();
              g.classList.remove('drop');
              const mid = e.dataTransfer.getData('application/x-netlab-module');
              const m = M.module(mid);
              if (!m || m.kind !== sl.kind) { UI.toast('Модуль ' + mid + ' не подходит к этому слоту', 'err'); return; }
              install(sl.id, mid);
            });
            g.addEventListener('click', (e) => {
              if (st.sel && !sl.module) { install(sl.id, st.sel); return; }
              if (sl.module) {
                UI.menu(e.clientX, e.clientY, [{ title: sl.label + ': ' + sl.module }, { label: 'Извлечь модуль', danger: true, onClick: () => install(sl.id, null) }]);
              }
            });
            svg.appendChild(g);
          }
          // порты
          d.ports.forEach((p, i) => {
            const pos = L.ports[i];
            if (!pos) return;
            const led = p.media === 'console' || p.media === 'rs232' ? null : ledColor(app.net, d, i);
            const g = portGlyph(p, pos[0], pos[1], led);
            g.classList.add('phys-port');
            const peer = DW.peerText(app.net, d, i);
            const issue = p.link && app.net.links.get(p.link) ? app.net.linkIssue(app.net.links.get(p.link)) : null;
            g.appendChild(s('title', null, p.name + ' — ' + (p.link || p.radio ? peer : 'не подключён') + (issue ? '\n' + issue : '') + (p.errDisabled ? '\nerr-disabled (port-security)' : '')));
            svg.appendChild(g);
            if (d.type === 'router' || d.type === 'hub' || d.type === 'ap' || d.type === 'wrouter' || p.media === 'rs232') {
              svg.appendChild(s('text', { x: pos[0], y: pos[1] + 20, 'text-anchor': 'middle', class: 'phys-label tiny light' }, UI.shortIf(p.name)));
            }
          });
          // питание
          if (L.power) {
            const [px, py] = L.power;
            const g = s('g', { class: 'phys-power', transform: 'translate(' + px + ',' + py + ')' });
            g.append(s('circle', { r: 11, fill: '#1f2937', stroke: '#94a3b8', 'stroke-width': 2 }),
              s('path', { d: 'M0 -6 V0 M-4.5 -3.5 A6 6 0 1 0 4.5 -3.5', fill: 'none', stroke: d.power ? '#22c55e' : '#94a3b8', 'stroke-width': 2, 'stroke-linecap': 'round' }),
              s('circle', { cx: 18, cy: -8, r: 3, fill: d.power ? '#22c55e' : '#374151' }),
              s('title', null, d.power ? 'Выключить питание' : 'Включить питание'));
            g.addEventListener('click', () => app.togglePower(id));
            svg.appendChild(g);
          }
          stage.appendChild(svg);
        };

        const custom = h('div', { class: 'row', style: { gap: '6px' } },
          h('span', { class: 'muted', style: { fontSize: '12px' } }, d0status(dev)));
        body.appendChild(h('div', { class: 'phys' },
          list,
          h('div', { class: 'phys-right' }, zoomBar, stage, custom)));
        body.appendChild(h('div', { class: 'mod-bottom' }, desc, descImg));
        showDesc(null);
        draw();
        tab.live = draw;
      },
      live: null,
    };
    return tab;
  };

  function d0status(dev) {
    return dev.power ? 'Питание включено. Модули меняются только при выключенном питании.' : 'Питание выключено — можно менять модули.';
  }

  DW.moduleSvg = moduleSvg;
})(globalThis.NetLab = globalThis.NetLab || {});
