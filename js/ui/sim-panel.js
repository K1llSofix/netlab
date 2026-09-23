/* NetLab UI — режим симуляции: пошаговое движение пакетов, фильтры протоколов,
 * журнал событий и инспектор PDU с объяснением решений каждого устройства. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const P = NS.packets;
  const h = UI.h;

  const MAX_ROWS = 800;
  const BASE = ['ARP', 'ICMP', 'DHCP', 'DNS', 'TCP', 'HTTP', 'SMTP', 'POP3', 'TELNET', 'SSH', 'TFTP', 'MAIL', 'UDP'];
  // плюс протоколы, которые регистрируют модули ядра (IPv6, SNMP, VPN, VoIP, IoT…)
  const FILTERABLE = BASE.concat(Object.keys(P.PROTOCOLS).filter((k) => k !== 'OTHER' && !BASE.includes(k)));

  class SimPanel {
    constructor(app, el) {
      this.app = app;
      this.el = el;
      this.playing = true;
      this.speed = Number(UI.store.get('netlab.simSpeed')) || 1;
      this.filters = new Set(FILTERABLE.concat(['OTHER']));
      this.stepRequested = false;
      this.animStart = new Map();
      this.pendingRows = [];
      this.selectedN = null;
      this.build();
    }

    get net() { return this.app.net; }
    get duration() { return 900 / this.speed; }

    isVisible(proto) { return this.filters.has(proto || 'OTHER'); }

    build() {
      const el = this.el;
      UI.clear(el);
      this.timeEl = h('span', { class: 'sim-time' });
      this.playBtn = h('button', { class: 'btn outline', onClick: () => this.togglePlay() });
      this.stepBtn = h('button', { class: 'btn outline', title: 'Следующий шаг (→)', onClick: () => this.step() }, UI.icon('step'), 'Шаг');
      const resetBtn = h('button', { class: 'btn outline', title: 'Сбросить: удалить пакеты в пути и очистить журнал', onClick: () => this.reset() }, UI.icon('reset'), 'Сброс');
      const speed = h('input', { type: 'range', min: 0, max: 6, step: 1, value: String(Math.round(Math.log2(this.speed) + 2)) });
      const speedVal = h('span', { style: { minWidth: '38px', textAlign: 'right' } });
      const setSpeed = () => {
        this.speed = Math.pow(2, Number(speed.value) - 2);
        speedVal.textContent = '×' + (this.speed < 1 ? this.speed.toFixed(2).replace(/0+$/, '') : this.speed);
        UI.store.set('netlab.simSpeed', String(this.speed));
      };
      speed.addEventListener('input', setSpeed);
      setSpeed();

      const chips = h('div', { class: 'filters' });
      for (const p of FILTERABLE) {
        const info = P.PROTOCOLS[p];
        const c = h('span', { class: 'chip', title: 'Показывать ' + info.label }, h('span', { class: 'dot', style: { background: info.color } }), info.label);
        c.addEventListener('click', () => {
          if (this.filters.has(p)) this.filters.delete(p); else this.filters.add(p);
          c.classList.toggle('off', !this.filters.has(p));
          this.rebuildRows();
        });
        chips.appendChild(c);
      }

      this.list = h('div', { class: 'events' });
      el.append(
        h('div', { class: 'sim-head' },
          h('h3', null, 'Симуляция', this.timeEl),
          h('div', { class: 'sim-controls' }, this.playBtn, this.stepBtn, h('div', { class: 'grow' }), resetBtn),
          h('div', { class: 'speed' }, 'Скорость', speed, speedVal)),
        chips,
        this.list);
      this.updateButtons();
      this.rebuildRows();
    }

    updateButtons() {
      UI.clear(this.playBtn);
      this.playBtn.append(UI.icon(this.playing ? 'pause' : 'play'), this.playing ? 'Пауза' : 'Пуск');
      this.playBtn.title = (this.playing ? 'Пауза' : 'Автоматическое воспроизведение') + ' (пробел)';
      this.stepBtn.disabled = this.playing;
    }

    togglePlay() {
      this.playing = !this.playing;
      this.updateButtons();
    }

    step() {
      if (this.playing) return;
      this.stepRequested = true;
    }

    reset() {
      this.net.resetSimulation();
      this.animStart.clear();
      this.app.ws.clearPackets();
      this.rebuildRows();
      UI.toast('Симуляция сброшена', 'ok');
    }

    networkReplaced() {
      this.animStart.clear();
      this.pendingRows = [];
      this.rebuildRows();
    }

    /* ---------- тик анимации (из главного цикла) ---------- */

    progressOf(ev, now) {
      if (!this.playing && !this.stepRequested) {
        // на паузе пакет стоит у отправителя и начнёт движение с начала
        this.animStart.delete(ev.seq);
        return 0;
      }
      let t0 = this.animStart.get(ev.seq);
      if (t0 === undefined) { t0 = now; this.animStart.set(ev.seq, t0); }
      const dur = this.stepRequested ? Math.min(this.duration, 320) : this.duration;
      return Math.min(1, (now - t0) / dur);
    }

    tick(now) {
      const net = this.net;
      this.timeEl.textContent = 'время ' + net.time;
      const go = this.playing || this.stepRequested;
      let guard = 0;
      while (go && guard++ < 60) {
        const visible = [];
        for (const ev of net.inFlight.values()) if (this.isVisible(P.classify(ev.frame))) visible.push(ev);
        if (!net.hasPending()) { this.stepRequested = false; break; }
        if (visible.length) {
          let done = true;
          for (const ev of visible) if (this.progressOf(ev, now) < 1) { done = false; break; }
          if (!done) break;
        }
        for (const ev of visible) this.animStart.delete(ev.seq);
        net.step();
        if (visible.length) {
          if (this.stepRequested) { this.stepRequested = false; break; }
          // после видимого шага новые пакеты начнут анимироваться со следующего кадра
          break;
        }
      }
      if (this.animStart.size > 5000) this.animStart.clear();
      this.flushRows();
      return (ev) => this.progressOf(ev, now);
    }

    /* ---------- журнал ---------- */

    onLog(entry) {
      if (entry.type === 'drop') this.app.ws.addMarker(entry.dev, 'drop', Math.max(700, this.duration * 1.4));
      else if (entry.type === 'accept') this.app.ws.addMarker(entry.dev, 'accept', Math.max(700, this.duration * 1.4));
      this.pendingRows.push(entry);
    }

    visibleEntry(e) {
      if (e.type === 'tx') return this.isVisible(e.proto);
      if (e.type === 'drop' || e.type === 'accept' || e.type === 'info') return !e.frame || this.isVisible(e.proto);
      return false;
    }

    flushRows() {
      if (!this.pendingRows.length) return;
      const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 30;
      const empty = this.list.querySelector('.empty');
      if (empty) empty.remove();
      for (const e of this.pendingRows) if (this.visibleEntry(e)) this.list.appendChild(this.row(e));
      this.pendingRows = [];
      while (this.list.children.length > MAX_ROWS) this.list.removeChild(this.list.firstChild);
      if (atBottom) this.list.scrollTop = this.list.scrollHeight;
    }

    rebuildRows() {
      UI.clear(this.list);
      this.pendingRows = [];
      const rows = this.net.log.filter((e) => this.visibleEntry(e)).slice(-MAX_ROWS);
      if (!rows.length) {
        this.list.appendChild(h('div', { class: 'empty' },
          h('div', null, 'Событий пока нет.'),
          h('div', { style: { marginTop: '6px' } }, 'Отправьте ping из командной строки, письмо или «Проверку связи» (конверт на панели слева) — пакеты будут двигаться по схеме шаг за шагом.')));
        return;
      }
      for (const e of rows) this.list.appendChild(this.row(e));
      this.list.scrollTop = this.list.scrollHeight;
    }

    devName(id) {
      const d = id && this.net.getDevice(id);
      return d ? d.name : '?';
    }

    row(e) {
      const info = P.PROTOCOLS[e.proto] || P.PROTOCOLS.OTHER;
      let what;
      let desc;
      let cls = 'ev-row';
      if (e.type === 'tx') {
        what = h('div', { class: 'what' }, h('span', { class: 'ptag', style: { background: info.color } }, info.label),
          h('span', { class: 'route' }, this.devName(e.from) + ' → ' + this.devName(e.to)));
        desc = P.summary(e.frame);
      } else {
        cls += ' ' + e.type;
        const mark = e.type === 'drop' ? '✕ ' : e.type === 'accept' ? '✓ ' : '• ';
        what = h('div', { class: 'what' }, e.frame ? h('span', { class: 'ptag', style: { background: info.color } }, info.label) : null,
          h('span', { class: 'route' }, mark + this.devName(e.dev)));
        desc = e.reason;
      }
      const r = h('div', { class: cls + (this.selectedN === e.n ? ' sel' : ''), 'data-n': e.n },
        h('div', { class: 't' }, String(e.time)), what, h('div', { class: 'desc' }, desc));
      r.addEventListener('click', () => {
        for (const x of this.list.querySelectorAll('.ev-row.sel')) x.classList.remove('sel');
        r.classList.add('sel');
        this.selectedN = e.n;
        this.inspect(e);
      });
      return r;
    }

    inspectInFlight(seq) {
      const ev = [...this.net.inFlight.values()].find((x) => x.seq === seq);
      if (!ev) return;
      const logged = this.net.log.find((e) => e.type === 'tx' && e.evSeq === seq);
      this.inspect(logged || { type: 'tx', time: ev.start, from: ev.from, to: ev.to, fromPort: ev.fromPort, toPort: ev.port, frame: ev.frame, proto: P.classify(ev.frame), why: '' });
    }

    inspect(e) {
      const net = this.net;
      const win = UI.windows.open({
        id: 'inspector',
        title: 'Сведения о PDU',
        icon: UI.icon('pdu'),
        width: 520,
        height: 600,
        tabs: [{ id: 'pdu', label: 'PDU', render: () => {} }],
      });
      win.tabs[0].render = (body) => {
        const cur = win.inspectEntry;
        if (!cur) return;
        const info = P.PROTOCOLS[cur.proto] || P.PROTOCOLS.OTHER;
        const port = (id, p) => {
          const d = net.getDevice(id);
          return d && d.ports[p] ? ' (' + d.ports[p].name + ')' : '';
        };
        body.appendChild(h('div', { class: 'row', style: { marginBottom: '10px' } },
          h('span', { class: 'ptag', style: { background: info.color } }, info.label),
          h('b', null, cur.type === 'tx' ? this.devName(cur.from) + port(cur.from, cur.fromPort) + ' → ' + this.devName(cur.to) + port(cur.to, cur.toPort) : this.devName(cur.dev)),
          h('span', { class: 'muted', style: { marginLeft: 'auto' } }, 'время ' + cur.time)));
        if (cur.type === 'tx') {
          body.appendChild(h('div', { class: 'why-box' }, h('b', null, 'Что сделало устройство: '), cur.why || 'отправило кадр'));
        } else {
          body.appendChild(h('div', { class: 'why-box' + (cur.type === 'drop' ? ' drop' : '') }, h('b', null, cur.type === 'drop' ? 'Отброшено: ' : cur.type === 'accept' ? 'Принято: ' : 'Событие: '), cur.reason));
        }
        if (cur.frame) {
          body.appendChild(h('div', { class: 'muted', style: { margin: '4px 0 8px' } }, P.summary(cur.frame)));
          for (const L of P.layers(cur.frame)) {
            body.appendChild(h('div', { class: 'layer' }, h('div', { class: 'lh' }, L.title),
              h('table', null, L.fields.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v))))));
          }
        }
      };
      win.inspectEntry = e;
      win.select('pdu');
      win.refresh(true);
    }
  }

  UI.SimPanel = SimPanel;
})(globalThis.NetLab = globalThis.NetLab || {});
