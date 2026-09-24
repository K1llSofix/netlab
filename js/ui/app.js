/* NetLab UI — главный модуль: состояние приложения, меню, инструменты, отмена/повтор,
 * автосохранение, режимы «Реальное время» и «Симуляция», главный цикл. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;

  const AUTOSAVE_KEY = 'netlab.autosave.v1';
  const FILE_KEY = 'netlab.file.v1';
  const DESKTOP = window.netlabDesktop || null; // есть только в настольной версии (Electron)
  const PREFS_KEY = 'netlab.prefs.v1';
  const RATE = 100; // тиков модели в секунду в режиме реального времени
  const UNDO_LIMIT = 80;

  const App = {
    net: null,
    mode: 'realtime',
    tool: 'select',
    settings: { showPorts: true, showIps: true, autoPorts: false, showNvram: true, confirmPowerOff: true, autoUpdate: true, theme: 'auto' },
    undoStack: [],
    redoStack: [],
    terminals: new Map(),
    mailDrafts: new Map(),
    deskStates: new Map(),
    iosLogs: new Map(),
    iosListeners: new Map(),
    cableType: 'auto',
    shapeKind: 'rect',
    shapeColor: '#3b82f6',
    prefs: {},
    needRender: true,
    lastLive: 0,
    fileName: null,
    filePath: null,
    dirty: false,
    warnAt: 0,

    init() {
      try { this.prefs = JSON.parse(UI.store.get(PREFS_KEY) || '{}') || {}; } catch (e) { this.prefs = {}; }
      Object.assign(this.settings, this.prefs.settings || {});
      this.applyTheme();

      this.ws = new UI.Workspace(this, document.getElementById('stage'), document.getElementById('stageWrap'));
      this.pdu = new UI.PduPanel(this, document.getElementById('pduPanel'));

      let net = null;
      const saved = UI.store.get(AUTOSAVE_KEY);
      if (saved) {
        try { net = NS.Network.deserialize(JSON.parse(saved)); } catch (e) { console.warn('Автосохранение повреждено', e); }
      }
      this.net = net || new NS.Network();
      this.sim = new UI.SimPanel(this, document.getElementById('simPanel'));
      this.bindNet();

      this.buildMenu();
      this.buildToolbar();
      this.buildModeSwitch();
      this.bindKeys();
      this.bindDesktop();
      let fileState = null;
      try { fileState = net ? JSON.parse(UI.store.get(FILE_KEY) || 'null') : null; } catch (e) { fileState = null; }
      if (fileState) this.setFile(DESKTOP ? fileState.path : null, fileState.name, fileState.dirty);
      else this.setFile(null, null, false);
      this.setTool('select');
      this.ws.render();
      requestAnimationFrame(() => this.ws.fit());
      this.updateMenu();
      this.updateStatus();
      if (DESKTOP && UI.updates) UI.updates.init(this);

      // Модель в реальном времени идёт по таймеру — она не останавливается, когда вкладка
      // скрыта (requestAnimationFrame в фоне не вызывается). Отрисовка — по кадрам.
      let lastTick = performance.now();
      setInterval(() => {
        const now = performance.now();
        const dt = Math.min(1, Math.max(0, (now - lastTick) / 1000));
        lastTick = now;
        if (this.mode !== 'realtime') return;
        try {
          this.net.advanceTo(this.net.time + Math.max(1, Math.round(dt * RATE)));
        } catch (e) {
          console.error(e);
          this.reportError(e);
        }
      }, 20);
      const loop = (now) => {
        this.frame(now);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },

    /* ---------- главный цикл ---------- */

    frame(now) {
      let progress = () => 0;
      try {
        if (this.mode === 'sim') progress = this.sim.tick(now);
      } catch (e) {
        console.error(e);
        this.reportError(e);
      }
      if (this.needRender) {
        this.needRender = false;
        this.ws.render();
      }
      this.ws.frame(now, progress);
      if (now - this.lastLive > 300) {
        this.lastLive = now;
        UI.windows.liveAll();
        this.pdu.render();
        this.updateStatus();
      }
    },

    reportError(e) {
      const t = performance.now();
      if (t - this.warnAt < 3000) return;
      this.warnAt = t;
      UI.toast('Внутренняя ошибка симулятора: ' + (e && e.message) + '. Симуляция продолжается; сообщите о проблеме, если она повторяется.', 'err', 6000);
    },

    bindNet() {
      if (this.unsub) this.unsub();
      this.net.recording = this.mode === 'sim';
      this.unsub = this.net.on((type, data) => this.onNetEvent(type, data));
    },

    onNetEvent(type, data) {
      switch (type) {
        case 'topology':
        case 'config':
          this.needRender = true;
          this.scheduleRefresh();
          break;
        case 'log':
          this.sim.onLog(data);
          break;
        case 'ios-console':
          // асинхронные сообщения IOS (%LINK-…, debug) — в открытые консоли этого устройства
          for (const t of this.terminals.values()) {
            if ((t.kind === 'cli' && t.devId === data.dev.id) || (t.kind === 'console' && t.targetId === data.dev.id)) t.print(data.line, 'async');
          }
          break;
        case 'log-reset':
          this.sim.rebuildRows();
          break;
        case 'mail': {
          const d = data.dev;
          const m = data.message;
          this.needRender = true;
          const w = UI.windows.get('dev:' + d.id);
          const ds = this.deskStates.get(d.id);
          const visible = w && w.active && w.active.id === 'desktop' && ds && ds.app === (m.email ? 'email' : 'messages');
          if (w) w.setBadge('desktop', d.unreadCount());
          if (!visible && !m.email) UI.toast('✉ ' + d.name + ': новое сообщение от ' + (m.from || U.ipStr(m.fromIp)) + (m.subject ? ' — «' + m.subject + '»' : ''));
          break;
        }
        case 'remote-change':
          // настройку поменяли по Telnet/SSH — сохранить и обновить окна (без записи в историю отмены)
          this.markDirty();
          this.needRender = true;
          this.autosave();
          this.scheduleRefresh();
          break;
        case 'mail-status':
          this.pdu.update();
          break;
        case 'warn':
          if (performance.now() - this.warnAt > 1500) {
            this.warnAt = performance.now();
            UI.toast(data.text, 'warn', 5000);
          }
          this.needRender = true;
          break;
        case 'error':
          this.reportError(data);
          break;
        default: break;
      }
    },

    scheduleRefresh() {
      if (this.refreshPending) return;
      this.refreshPending = true;
      setTimeout(() => {
        this.refreshPending = false;
        this.refreshWindows(false);
      }, 60);
    },

    refreshWindows(force) {
      for (const w of UI.windows.all()) {
        if (w.id.startsWith('insp:')) {
          const d = this.net.getDevice(w.id.slice(5));
          if (!d) { w.close(); continue; }
          w.setTitle(d.name, 'Инспектор');
          if (force) w.refresh(force);
          continue;
        }
        if (!w.id.startsWith('dev:')) { if (force && w.id !== 'inspector') w.refresh(force); continue; }
        const d = this.net.getDevice(w.id.slice(4));
        if (!d) { w.close(); continue; }
        w.setTitle(d.name, UI.typeLabel(d.type) + ' · ' + d.model + (d.power ? '' : ' · выключен'));
        w.refresh(force);
      }
    },

    /* ---------- изменения, отмена, автосохранение ---------- */

    snapshot() { return JSON.stringify(this.net.serialize()); },

    /** Выполнить изменение с записью в историю отмены. Ошибка пробрасывается вызывающему. */
    mutate(fn) {
      const snap = this.snapshot();
      let res;
      try {
        res = fn();
      } finally {
        this.commitSnapshot(snap);
      }
      return res;
    },

    commitSnapshot(snap) {
      if (!snap) return;
      this.net.refreshTopology();
      const cur = this.snapshot();
      if (cur === snap) {
        // ничего не изменилось (например, ошибка проверки) — не перерисовываем окна, чтобы не стереть текст ошибки
        this.needRender = true;
        return;
      }
      this.undoStack.push(snap);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.afterChange(cur);
    },

    afterChange(cur) {
      this.markDirty();
      this.needRender = true;
      this.refreshWindows(true);
      this.autosave(cur);
      this.updateMenu();
    },

    /** Записать автосохранение немедленно (перед перезапуском для обновления). */
    flushAutosave() {
      clearTimeout(this.saveTimer);
      UI.store.set(AUTOSAVE_KEY, this.snapshot());
    },

    autosave(json) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        const ok = UI.store.set(AUTOSAVE_KEY, json || this.snapshot());
        this.savedAt = ok ? new Date() : null;
        this.updateStatus();
      }, 300);
    },

    undo() {
      if (!this.undoStack.length) return;
      const cur = this.snapshot();
      const prev = this.undoStack.pop();
      this.redoStack.push(cur);
      this.loadJson(prev, true);
      this.markDirty();
      UI.toast('Отменено', 'ok', 1200);
    },

    redo() {
      if (!this.redoStack.length) return;
      const cur = this.snapshot();
      const next = this.redoStack.pop();
      this.undoStack.push(cur);
      this.loadJson(next, true);
      this.markDirty();
      UI.toast('Повторено', 'ok', 1200);
    },

    loadJson(json, keepView) {
      const net = NS.Network.deserialize(JSON.parse(json));
      this.setNetwork(net, { keepView });
    },

    /** Заменить сеть целиком (отмена, открытие файла, пример). */
    setNetwork(net, opts) {
      opts = opts || {};
      if (opts.undoable) {
        this.undoStack.push(this.snapshot());
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.redoStack = [];
      }
      this.net = net;
      this.bindNet();
      if (opts.undoable) this.pdu.clear();
      if (!opts.keepView) {
        // другая схема: номера устройств могут совпасть, а состояние программ — чужое
        if (UI.stopAllPrograms) UI.stopAllPrograms();
        this.terminals.clear();
        this.deskStates.clear();
        this.iosLogs.clear();
        this.mailDrafts.clear();
        UI.windows.closeWhere((w) => w.id.startsWith('dev:') || w.id.startsWith('insp:'));
      }
      for (const [key, t] of this.terminals) {
        if (!net.getDevice(t.devId)) this.terminals.delete(key);
        else t.networkReplaced();
      }
      for (const id of [...this.ws.selection]) if (!net.getDevice(id) && !net.notes.some((n) => n.id === id) && !net.shapes.some((x) => x.id === id)) this.ws.selection.delete(id);
      if (this.ws.selLink && !net.links.has(this.ws.selLink)) this.ws.selLink = null;
      this.ws.cableSrc = null;
      this.ws.pduSrc = null;
      this.ws.clearPackets();
      this.sim.networkReplaced();
      this.refreshWindows(true);
      this.ws.render();
      if (!opts.keepView) this.ws.fit();
      this.autosave();
      this.updateMenu();
      this.updateStatus();
    },

    /* ---------- действия ---------- */

    /** Поставить устройство: what — модель (2911, PC-PT…) или тип (router, pc…). */
    placeDevice(what, x, y) {
      try {
        const M = NS.models;
        const model = M.MODELS[what] ? what : M.DEFAULT_MODEL[what];
        if (!model) throw new Error('Неизвестное устройство: ' + what);
        const type = M.get(model).type;
        const d = this.mutate(() => this.net.addDevice(type, { model, x: Math.round(x / 8) * 8, y: Math.round(y / 8) * 8 }));
        this.ws.selection.clear();
        this.ws.selection.add(d.id);
        this.needRender = true;
        return d;
      } catch (e) { UI.toast(e.message, 'err'); return null; }
    },

    connect(aId, aPort, bId, bPort, cable) {
      try {
        const l = this.mutate(() => this.net.connect(aId, aPort, bId, bPort, cable || 'auto'));
        const issue = l && this.net.linkIssue(l);
        if (issue) UI.toast(issue, 'warn', 6000);
        else if (l && l.cable === 'console') UI.toast('Консольный кабель подключён. На компьютере: «Рабочий стол» → Terminal', 'ok', 4000);
      } catch (e) { UI.toast(e.message, 'err', 5000); }
    },

    deleteIds(ids) {
      if (!ids.length) return;
      this.mutate(() => {
        for (const id of ids) {
          if (this.net.getDevice(id)) {
            this.net.removeDevice(id);
            for (const [key, t] of this.terminals) if (t.devId === id) this.terminals.delete(key);
            this.mailDrafts.delete(id);
            this.deskStates.delete(id);
            this.iosLogs.delete(id);
            UI.windows.close('dev:' + id);
            UI.windows.close('insp:' + id);
          } else if (this.net.notes.some((n) => n.id === id)) this.net.removeNote(id);
          else this.net.removeShape(id);
          this.ws.selection.delete(id);
        }
      });
    },

    deleteLink(id) {
      this.mutate(() => this.net.disconnect(id));
      if (this.ws.selLink === id) this.ws.selLink = null;
    },

    deleteSelection() {
      if (this.ws.selLink) this.deleteLink(this.ws.selLink);
      else if (this.ws.selection.size) this.deleteIds([...this.ws.selection]);
    },

    duplicate(ids) {
      const created = [];
      try {
        this.mutate(() => {
          for (const id of ids) {
            const src = this.net.getDevice(id);
            if (!src) continue;
            const data = JSON.parse(JSON.stringify(src.serialize()));
            const d = this.net.addDevice(src.type, { model: src.model, x: src.x + 48, y: src.y + 48 });
            for (const p of data.ports) delete p.mac;
            delete data.baseMac;
            delete data.nvram;
            const c = data.config || {};
            delete c.baseMac;
            if (c.ifaces) for (const f of c.ifaces) { f.ip = null; f.mask = null; }
            c.inbox = [];
            c.outbox = [];
            c.dhcpBound = false;
            if (c.dhcpd) c.dhcpd.leases = [];
            d.load(Object.assign({}, data, { name: d.name, x: d.x, y: d.y }));
            created.push(d.id);
          }
        });
      } catch (e) { UI.toast(e.message, 'err'); }
      if (created.length) {
        this.ws.selection = new Set(created);
        this.needRender = true;
        UI.toast('Скопировано устройств: ' + created.length + ' (IP-адреса не копируются, чтобы не было конфликтов)', 'ok');
      }
    },

    async renameDevice(id) {
      const d = this.net.getDevice(id);
      if (!d) return;
      const name = await UI.prompt('Переименовать', 'Новое имя для ' + d.name + ':', d.name);
      if (name == null) return;
      try { this.mutate(() => this.net.renameDevice(this.net.getDevice(id), name)); } catch (e) { UI.toast(e.message, 'err'); }
    },

    async setPower(id, on) {
      const d = this.net.getDevice(id);
      if (!d) return;
      if (!on && d.power && d.nvramDirty && d.nvramDirty() && this.settings.confirmPowerOff) {
        // как настоящий маршрутизатор: всё, что не сохранено в NVRAM, пропадёт при выключении
        const choice = await new Promise((resolve) => {
          UI.modal({
            title: 'Выключить ' + d.name + '?',
            body: UI.h('p', null, 'Текущая конфигурация (running-config) не сохранена в NVRAM. После включения устройство загрузит startup-config, и несохранённые изменения пропадут — как на настоящем оборудовании.'),
            actions: [
              { label: 'Отмена', onClick: () => resolve('cancel') },
              { label: 'Выключить без сохранения', danger: true, onClick: () => resolve('off') },
              { label: 'Сохранить и выключить', primary: true, onClick: () => resolve('save') },
            ],
            onCancel: () => resolve('cancel'),
            dismissable: false,
          });
        });
        if (choice === 'cancel') return;
        if (choice === 'save') {
          try { this.mutate(() => this.net.getDevice(id).saveNvram()); } catch (e) { UI.toast(e.message, 'err'); return; }
        }
      }
      this.mutate(() => this.net.setPower(this.net.getDevice(id), on));
      for (const t of this.terminals.values()) t.deviceRestarted(id);
    },

    togglePower(id) {
      const d = this.net.getDevice(id);
      if (d) this.setPower(id, !d.power);
    },

    /** «Power Cycle Devices» из Packet Tracer: перезагрузить все устройства (несохранённое пропадёт). */
    async powerCycleAll() {
      const dirty = [...this.net.devices.values()].filter((d) => d.power && d.nvramDirty && d.nvramDirty());
      const text = 'Все устройства будут выключены и снова включены: DHCP-адреса, таблицы ARP/MAC и соединения сбросятся.' +
        (dirty.length ? ' Несохранённая конфигурация пропадёт на: ' + dirty.map((d) => d.name).join(', ') + '.' : '');
      if (!(await UI.confirm('Перезапустить все устройства', text, 'Перезапустить', dirty.length > 0))) return;
      this.mutate(() => {
        for (const d of this.net.devices.values()) {
          if (!d.power) continue;
          this.net.setPower(d, false);
          this.net.setPower(d, true);
        }
      });
      for (const d of this.net.devices.values()) for (const t of this.terminals.values()) t.deviceRestarted(d.id);
      UI.toast('Устройства перезапущены', 'ok');
    },

    /** «Fast Forward Time»: прокрутить модель вперёд (DHCP, STP, таймеры) без ожидания. */
    fastForward() {
      try {
        this.net.advanceTo(this.net.time + 3000);
        this.needRender = true;
        this.scheduleRefresh();
        UI.toast('Время модели продвинуто на 30 секунд', 'ok', 1500);
      } catch (e) { this.reportError(e); }
    },

    deskState(id) {
      let s = this.deskStates.get(id);
      if (!s) { s = { app: null }; this.deskStates.set(id, s); }
      return s;
    },

    /* ---------- журнал «Эквивалентные команды IOS» ---------- */

    iosLog(id) {
      let l = this.iosLogs.get(id);
      if (!l) { l = []; this.iosLogs.set(id, l); }
      return l;
    },

    onIosLog(id, fn) {
      let set = this.iosListeners.get(id);
      if (!set) { set = new Set(); this.iosListeners.set(id, set); }
      set.add(fn);
    },

    emitIosLog(id) {
      const set = this.iosListeners.get(id);
      if (!set) return;
      for (const fn of [...set]) {
        // панель, которой уже нет на экране, отписывается сама
        try { if (fn() === false) set.delete(fn); } catch (e) { set.delete(fn); }
      }
    },

    async addNote(x, y) {
      const text = await UI.prompt('Заметка', 'Текст заметки:', '');
      if (!text) { this.setTool('select'); return; }
      this.mutate(() => this.net.addNote(Math.round(x), Math.round(y), text.replace(/\\n/g, '\n')));
      this.setTool('select');
    },

    async editNote(id) {
      const n = this.net.notes.find((x) => x.id === id);
      if (!n) return;
      const text = await UI.prompt('Заметка', 'Текст (\\n — новая строка):', n.text.replace(/\n/g, '\\n'));
      if (text == null) return;
      if (!text.trim()) { this.deleteIds([id]); return; }
      this.mutate(() => { const m = this.net.notes.find((x) => x.id === id); if (m) m.text = text.replace(/\\n/g, '\n'); });
    },

    openDevice(id, tab) {
      UI.openDeviceWindow(this, id, tab);
    },

    /** Терминал устройства. kind: cmd — командная строка, cli — консоль IOS, console — программа «Терминал», tel — Telnet/SSH-клиент. */
    terminal(id, kind) {
      const k = kind || 'cmd';
      const key = k + ':' + id;
      let t = this.terminals.get(key);
      if (!t) {
        t = new UI.Terminal(this, id, { kind: k === 'tel' ? 'cmd' : k });
        this.terminals.set(key, t);
      }
      return t;
    },

    mailDraft(id) {
      let d = this.mailDrafts.get(id);
      if (!d) { d = { to: [], subject: '', body: '' }; this.mailDrafts.set(id, d); }
      return d;
    },

    /** «192.168.1.20» → «192.168.1.20 (PC2)» — подпись для людей, сеть об этом не знает. */
    labelForTarget(t) {
      const ip = U.parseIp(t);
      if (ip == null) return t;
      for (const d of this.net.devices.values()) {
        if (d.ifaces && d.ifaces.some((f) => f.ip === ip)) return t + ' (' + d.name + ')';
      }
      return t;
    },

    nameForMac(mac) {
      for (const d of this.net.devices.values()) {
        const i = d.ports.findIndex((p) => p.mac === mac);
        if (i >= 0) return d.name + (d.ports.length > 1 ? ' ' + UI.shortIf(d.ports[i].name) : '');
      }
      return '';
    },

    /** DHCP-клиенты, не получившие адрес, пробуют снова (как периодический повтор в реальных ОС). */
    nudgeDhcp() {
      for (const d of this.net.devices.values()) {
        if (d.iface && d.iface.dhcp && d.dhcpc && d.dhcpc.phase === 'failed') d.startDhcp();
      }
    },

    uiPref(key, def) { return key in this.prefs ? this.prefs[key] : def; },
    setUiPref(key, v) { this.prefs[key] = v; this.savePrefs(); },
    savePrefs() {
      this.prefs.settings = this.settings;
      UI.store.set(PREFS_KEY, JSON.stringify(this.prefs));
    },

    /* ---------- проверка связи и письма ---------- */

    pickTargetIp(src, dst) {
      const addrs = (dst.ifaces || []).filter((f) => f.ip != null);
      if (!addrs.length) return null;
      const my = (src.ifaces || []).filter((f) => f.ip != null);
      for (const f of addrs) for (const m of my) if (U.sameNet(f.ip, m.ip, m.mask)) return f.ip;
      const up = addrs.find((f) => dst.ifaceUp(f));
      return (up || addrs[0]).ip;
    },

    simplePdu(srcId, dstId) {
      const src = this.net.getDevice(srcId);
      const dst = this.net.getDevice(dstId);
      if (!src || !dst) return;
      const ip = this.pickTargetIp(src, dst);
      if (ip == null) { UI.toast('У ' + dst.name + ' нет IP-адреса', 'err'); return; }
      if (src.ifaces.every((f) => f.ip == null)) { UI.toast('У ' + src.name + ' нет IP-адреса', 'err'); return; }
      const item = this.pdu.add({ kind: 'ping', status: 'run', srcName: src.name, dstName: dst.name + ' (' + U.ipStr(ip) + ')', text: 'Эхо-запрос отправлен…', redo: () => this.simplePdu(srcId, dstId) });
      const s = this.net.getDevice(srcId);
      s.ping(U.ipStr(ip), {
        count: 1,
        onEvent: (ev) => {
          if (ev.type === 'reply') { item.status = 'ok'; item.text = 'Ответ от ' + U.ipStr(ev.from) + ' за ' + ev.rtt + ' тиков, TTL=' + ev.ttl; }
          else if (ev.type === 'timeout') { item.status = 'fail'; item.text = 'Нет ответа (превышено время ожидания)'; }
          else if (ev.type === 'unreachable') { item.status = 'fail'; item.text = U.ipStr(ev.from) + ' сообщает: ' + (ev.code === 0 ? 'нет маршрута к сети' : 'узел недоступен'); }
          else if (ev.type === 'ttl-expired') { item.status = 'fail'; item.text = 'Истёк TTL на ' + U.ipStr(ev.from) + ' (петля маршрутизации?)'; }
          else if (ev.type === 'error') { item.status = 'fail'; item.text = ev.text; }
          else if (ev.type === 'done' && ev.cancelled) { item.status = 'fail'; item.text = 'Прервано: ' + (ev.reason || ''); }
          this.pdu.update();
        },
      });
      if (this.mode === 'sim' && !this.sim.playing) UI.toast('Симуляция на паузе — нажмите «Пуск» или «Шаг»', 'warn');
    },

    trackMail(dev, msg) {
      const devId = dev.id;
      const n = msg.items.length;
      const item = this.pdu.add({
        kind: 'mail', status: 'run', srcName: dev.name,
        dstName: msg.items.map((it) => (it.target === '*' ? 'всем в подсети' : it.target)).slice(0, 3).join(', ') + (n > 3 ? ' и ещё ' + (n - 3) : ''),
        text: '«' + (msg.subject || 'без темы') + '»: отправка…',
        open: () => this.openDevice(devId, 'mail'),
      });
      const upd = () => {
        const ok = msg.items.filter((it) => it.status === 'ok').length;
        const fail = msg.items.filter((it) => it.status === 'fail').length;
        if (ok + fail < n) { item.status = 'run'; item.text = '«' + (msg.subject || 'без темы') + '»: доставлено ' + ok + ' из ' + n + '…'; return; }
        item.status = !fail ? 'ok' : ok ? 'partial' : 'fail';
        item.text = '«' + (msg.subject || 'без темы') + '»: доставлено ' + ok + ' из ' + n + (fail ? ' — откройте почту, чтобы увидеть причины' : '');
      };
      const off = this.net.on((type, data) => {
        if (type === 'mail-status' && data.msg === msg) {
          upd();
          this.pdu.update();
          if (item.status !== 'run') off();
        }
      });
      upd();
    },

    /* ---------- интерфейс: меню, панель инструментов, режимы ---------- */

    buildMenu() {
      const m = document.getElementById('menu');
      UI.clear(m);
      const btn = (icon, label, title, fn) => h('button', { class: 'btn', title, onClick: fn }, UI.icon(icon), h('span', { class: 'lbl' }, label));
      this.undoBtn = h('button', { class: 'btn icon', title: 'Отменить (Ctrl+Z)', onClick: () => this.undo() }, UI.icon('undo'));
      this.redoBtn = h('button', { class: 'btn icon', title: 'Повторить (Ctrl+Y)', onClick: () => this.redo() }, UI.icon('redo'));
      m.append(
        btn('newfile', 'Новый', 'Новая схема', () => this.newProject()),
        btn('open', 'Открыть', 'Открыть файл (Ctrl+O)', () => this.openFile()),
        btn('save', 'Сохранить', 'Сохранить в файл (Ctrl+S; «Сохранить как» — Ctrl+Shift+S)', () => this.saveFile(false)),
        h('span', { class: 'sep' }),
        this.undoBtn, this.redoBtn,
        h('span', { class: 'sep' }),
        btn('book', 'Примеры', 'Готовые схемы для изучения', () => this.showExamples()),
        btn('task', 'Задание', 'Задания с проверкой: мастер заданий, инструкции, проверка результата', (e) => UI.taskMenu(this, e)),
        btn('tag', 'Вид', 'Настройки отображения', (e) => this.viewMenu(e)),
        btn('help', 'Справка', 'Как пользоваться NetLab (F1)', () => this.showHelp()));
    },

    updateMenu() {
      if (!this.undoBtn) return;
      this.undoBtn.disabled = !this.undoStack.length;
      this.redoBtn.disabled = !this.redoStack.length;
    },

    viewMenu(e) {
      const r = e.currentTarget.getBoundingClientRect();
      const s = this.settings;
      const flip = (k) => { s[k] = !s[k]; this.savePrefs(); this.needRender = true; };
      UI.menu(r.left, r.bottom + 4, [
        { label: (s.showPorts ? '☑ ' : '☐ ') + 'Названия портов на кабелях', onClick: () => flip('showPorts') },
        { label: (s.showIps ? '☑ ' : '☐ ') + 'IP-адреса под устройствами', onClick: () => flip('showIps') },
        { label: (s.autoPorts ? '☑ ' : '☐ ') + 'Кабель: выбирать порт автоматически', onClick: () => flip('autoPorts') },
        { label: (s.showNvram ? '☑ ' : '☐ ') + 'Отмечать несохранённую конфигурацию (NVRAM)', onClick: () => flip('showNvram') },
        { label: (s.confirmPowerOff ? '☑ ' : '☐ ') + 'Спрашивать перед выключением без сохранения', onClick: () => flip('confirmPowerOff') },
        { label: ((this.net.physical && this.net.physical.enabled) ? '☑ ' : '☐ ') + 'Физические расстояния (длина кабелей, дальность Wi-Fi)…', onClick: () => this.physicalDialog() },
        { label: 'Многопользовательский режим…', onClick: () => UI.multiuserDialog(this) },
        DESKTOP ? { label: (s.autoUpdate ? '☑ ' : '☐ ') + 'Проверять обновления при запуске', onClick: () => flip('autoUpdate') } : null,
        '-',
        { title: 'Тема' },
        { label: (s.theme === 'auto' ? '● ' : '○ ') + 'Как в системе', onClick: () => this.setTheme('auto') },
        { label: (s.theme === 'dark' ? '● ' : '○ ') + 'Тёмная', onClick: () => this.setTheme('dark') },
        { label: (s.theme === 'light' ? '● ' : '○ ') + 'Светлая', onClick: () => this.setTheme('light') },
      ]);
    },

    /** Масштаб схемы и проверка длины кабелей (сохраняется в файле схемы). */
    physicalDialog() {
      const c = Object.assign({}, NS.physical.cfg(this.net));
      const on = h('input', { type: 'checkbox', checked: c.enabled });
      const num = (v, step) => h('input', { class: 'inp', type: 'number', step, value: v, style: { width: '110px' } });
      const scale = num(c.scale, '0.05');
      const wifi = num(c.wifi, '5');
      const cell = num(c.cell, '100');
      const err = h('div', { class: 'err-text' });
      const L = NS.physical.MAX_LEN;
      const body = h('div', null,
        h('label', { class: 'row' }, on, ' Учитывать физические расстояния'),
        h('div', { class: 'form', style: { marginTop: '10px' } },
          h('label', null, 'Масштаб, м в единице схемы'), scale, h('label', null, 'Дальность Wi-Fi, м'), wifi, h('label', null, 'Дальность вышки 3G/4G, м'), cell),
        err,
        h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Длина кабеля считается по расстоянию между устройствами на схеме. Предельная длина: медь — ' + L.straight + ' м, оптика — ' + L.fiber + ' м, коаксиал — ' + L.coaxial + ' м, телефонная линия (DSL) — ' + L.phone + ' м, Serial — ' + L.serial + ' м. Слишком длинный кабель не передаёт данные (индикаторы красные, подпись длины выделена). Сетка схемы — 20 единиц.'));
      const apply = () => {
        try {
          this.mutate(() => NS.physical.setPhysical(this.net, { enabled: on.checked, scale: Number(scale.value), wifi: Number(wifi.value), cell: Number(cell.value) }));
          this.markDirty();
          this.needRender = true;
          return true;
        } catch (e2) { err.textContent = e2.message; return false; }
      };
      UI.modal({ title: 'Физические расстояния', body, actions: [{ label: 'Отмена' }, { label: 'Применить', primary: true, onClick: apply }], enterAction: apply });
    },

    setTheme(t) {
      this.settings.theme = t;
      this.savePrefs();
      this.applyTheme();
    },

    applyTheme() {
      let t = this.settings.theme;
      if (t === 'auto') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      document.documentElement.dataset.theme = t;
    },

    buildToolbar() {
      const tb = document.getElementById('toolbar');
      UI.clear(tb);
      this.toolBtns = new Map();
      const add = (id, iconEl, label, title) => {
        const b = h('button', { class: 'tool', title, onClick: () => this.setTool(this.tool === id && id !== 'select' ? 'select' : id) }, iconEl, h('span', null, label));
        this.toolBtns.set(id, b);
        tb.appendChild(b);
        return b;
      };
      tb.appendChild(h('div', { class: 'group-title' }, 'Инструменты'));
      add('select', UI.icon('select'), 'Выбор', 'Выбор и перемещение (V). Двойной щелчок — настройки устройства');
      add('inspect', UI.icon('inspect'), 'Инспектор', 'Посмотреть таблицы устройства: ARP, MAC, маршрутизация, NAT (I)');
      add('pdu', UI.icon('pdu'), 'Проверка связи', 'Отправить один ping от устройства к устройству (P)');
      add('cpdu', UI.icon('list'), 'Сложный PDU', 'Пакет с выбранным протоколом (ICMP, TCP, UDP), портом, TTL и повторами; можно сохранить в сценарий');
      add('mail', UI.icon('mail'), 'Сообщение', 'Отправить сообщение с компьютера сразу нескольким ПК (M)');
      add('note', UI.icon('note'), 'Заметка', 'Добавить текстовую заметку (N)');
      const shapeBtn = add('shape', UI.icon('shape'), 'Фигура', 'Нарисовать прямоугольник или эллипс для выделения зоны (G). Правый щелчок — выбор фигуры');
      shapeBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        UI.menu(e.clientX, e.clientY, [{ title: 'Фигура' },
          { label: 'Прямоугольник', on: this.shapeKind === 'rect', onClick: () => { this.shapeKind = 'rect'; this.setTool('shape'); } },
          { label: 'Эллипс', on: this.shapeKind === 'ellipse', onClick: () => { this.shapeKind = 'ellipse'; this.setTool('shape'); } }]);
      });
      add('delete', UI.icon('delete'), 'Удалить', 'Удалять щелчком (X). Или выделите и нажмите Delete');

      tb.appendChild(h('div', { class: 'group-title' }, 'Соединения'));
      this.cableBtn = h('button', { class: 'tool', title: 'Соединить устройства кабелем (C). Щелчок — выбрать тип кабеля' }, UI.cableIcon('auto'), h('span', null, 'Кабель'));
      this.toolBtns.set('cable', this.cableBtn);
      tb.appendChild(this.cableBtn);
      this.cableBtn.addEventListener('click', () => {
        const r = this.cableBtn.getBoundingClientRect();
        UI.menu(r.right + 6, r.top, [{ title: 'Тип кабеля' }].concat(UI.CABLES.map((c) => ({
          label: c.label, hint: c.hint, icon: UI.cableIcon(c.kind), on: this.tool === 'cable' && this.cableType === c.kind,
          onClick: () => this.setCable(c.kind),
        }))), 'flyout');
      });

      tb.appendChild(h('div', { class: 'group-title' }, 'Устройства'));
      for (const c of UI.DEVICE_CATEGORIES) {
        const b = h('button', { class: 'tool cat', title: c.label + ': щёлкните, чтобы выбрать модель' }, UI.deviceSvg(c.icon), h('span', null, c.label));
        b.addEventListener('click', () => {
          const r = b.getBoundingClientRect();
          UI.menu(r.right + 6, r.top, [{ title: c.label + ' — щёлкните или перетащите на схему' }].concat(c.models.map((m) => {
            if (typeof m === 'object') return m;
            const spec = NS.models.get(m);
            return {
              label: m, right: spec.title.replace(m, '').replace('Cisco', '').replace(/\(\s*\)/g, '').trim(), icon: UI.deviceSvg(spec.type, 'mi', m), on: this.tool === 'place:' + m,
              drag: { type: 'application/x-netlab-device', data: m },
              onClick: () => this.setTool('place:' + m),
            };
          })), 'flyout models');
        });
        this.toolBtns.set('cat:' + c.id, b);
        tb.appendChild(b);
      }
    },

    /** Выбрать тип кабеля и включить инструмент «Кабель». */
    setCable(kind) {
      this.cableType = kind;
      const c = UI.CABLES.find((x) => x.kind === kind) || UI.CABLES[0];
      const icon = this.cableBtn.querySelector('svg');
      if (icon) icon.replaceWith(UI.cableIcon(kind));
      this.cableBtn.querySelector('span').textContent = kind === 'auto' ? 'Кабель' : c.label.replace('Медный ', '');
      this.setTool('cable');
    },

    setTool(t) {
      this.tool = t;
      for (const [id, b] of this.toolBtns) {
        const cat = id.startsWith('cat:') && t.startsWith('place:') && UI.DEVICE_CATEGORIES.find((c) => 'cat:' + c.id === id).models.includes(t.slice(6));
        b.classList.toggle('on', id === t || !!cat);
      }
      this.ws.cableSrc = null;
      this.ws.pduSrc = null;
      UI.clear(this.ws.gOverlay);
      this.ws.updateHint();
      this.needRender = true;
    },

    buildModeSwitch() {
      const sw = document.getElementById('modeSwitch');
      for (const b of sw.querySelectorAll('button')) b.addEventListener('click', () => this.setMode(b.dataset.mode));
      this.updateModeSwitch();
    },

    updateModeSwitch() {
      for (const b of document.querySelectorAll('#modeSwitch button')) b.classList.toggle('on', b.dataset.mode === this.mode);
    },

    setMode(mode) {
      if (mode === this.mode) return;
      this.mode = mode;
      const panel = document.getElementById('simPanel');
      if (mode === 'sim') {
        this.net.recording = true;
        this.net.log = [];
        this.sim.networkReplaced();
        panel.hidden = false;
      } else {
        this.net.recording = false;
        panel.hidden = true;
        this.ws.clearPackets();
      }
      this.updateModeSwitch();
      this.updateStatus();
    },

    selectionChanged() { this.updateStatus(); },

    updateStatus() {
      const sb = document.getElementById('statusbar');
      if (!sb) return;
      if (!this.statusEls) {
        // элементы создаются один раз: кнопки не пересоздаются под курсором
        const E = (this.statusEls = {
          mode: h('span', { class: 'mode-ind' }),
          counts: h('span'),
          cost: h('span', { title: 'Сумма атрибута cost всех устройств (вкладка «Атрибуты»)' }),
          clock: h('span', { class: 'mono', title: 'Время модели (часы устройств)' }),
          cycle: h('button', { class: 'btn small', title: 'Перезапустить все устройства (Power Cycle Devices)', onClick: () => this.powerCycleAll() }, UI.icon('cycle'), 'Перезапуск'),
          ffwd: h('button', { class: 'btn small', title: 'Продвинуть время модели на 30 секунд (Fast Forward Time)', onClick: () => this.fastForward() }, UI.icon('ffwd'), 'Ускорить время'),
          saved: h('span'),
        });
        UI.clear(sb);
        sb.append(E.mode, E.counts, E.cost, E.clock, h('span', { class: 'grow' }), E.cycle, E.ffwd, E.saved);
      }
      const E = this.statusEls;
      const net = this.net;
      const set = (el, t) => { if (el.textContent !== t) el.textContent = t; };
      set(E.mode, this.mode === 'sim' ? '● Симуляция' : '● Реальное время');
      E.mode.style.color = this.mode === 'sim' ? '#d97706' : 'var(--ok)';
      const sel = this.ws.selection.size ? ' · выделено: ' + this.ws.selection.size : '';
      let cables = 0;
      for (const l of net.links.values()) if (!l.wireless) cables++;
      set(E.counts, 'Устройств: ' + net.devices.size + ' · кабелей: ' + cables + sel);
      let cost = 0;
      for (const d of net.devices.values()) cost += Number(d.attrs && d.attrs.cost) || 0;
      set(E.cost, 'Стоимость: $' + cost.toLocaleString('ru-RU'));
      set(E.clock, U.clockString(net.time, 0).replace(/^.*?(\d+:\d+:\d+).*$/, '$1'));
      E.cycle.style.display = E.ffwd.style.display = this.mode === 'realtime' ? '' : 'none';
      set(E.saved, this.savedAt ? 'Автосохранено ' + this.savedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
    },

    /* ---------- файлы ---------- */

    /** Имя открытого файла, путь (только в настольной версии) и признак несохранённых изменений. */
    setFile(path, name, dirty) {
      this.filePath = path || null;
      this.fileName = name || null;
      this.dirty = !!dirty;
      this.fileStateChanged();
    },

    markDirty() {
      if (this.dirty) {
        // схема «Без имени» могла только что стать непустой — оболочке нужно знать, спрашивать ли при закрытии
        if (DESKTOP && !this.filePath) DESKTOP.setState({ dirty: true, filePath: null, hasContent: this.hasContent() });
        return;
      }
      this.dirty = true;
      this.fileStateChanged();
    },

    fileStateChanged() {
      document.title = (this.fileName || 'Без имени') + (this.dirty ? ' •' : '') + ' — NetLab';
      UI.store.set(FILE_KEY, JSON.stringify({ path: this.filePath, name: this.fileName, dirty: this.dirty }));
      if (DESKTOP) DESKTOP.setState({ dirty: this.dirty, filePath: this.filePath, hasContent: this.hasContent() });
    },

    /** В схеме есть что сохранять (устройства, заметки или фигуры). */
    hasContent() { return !!this.net && (this.net.devices.size > 0 || this.net.notes.length > 0 || this.net.shapes.length > 0); },

    /** Есть несохранённые изменения, которые пропадут при замене схемы. */
    hasUnsaved() { return this.dirty && (!!this.filePath || this.hasContent()); },

    /**
     * Перед заменой схемы (новая, открыть, пример) — предложить сохранить несохранённые изменения.
     * Возвращает true, если можно продолжать.
     */
    async confirmUnsaved(title) {
      if (!this.hasUnsaved()) return true;
      const named = this.fileName ? '«' + this.fileName + '»' : null;
      const choice = await new Promise((resolve) => {
        let answered = false;
        const pick = (v) => { if (!answered) { answered = true; resolve(v); } };
        UI.modal({
          title: title || 'Несохранённые изменения',
          body: h('div', null,
            h('p', null, named ? 'Сохранить изменения в ' + named + '?' : 'Эта схема ещё не сохранена в файл. Сохранить её?'),
            h('p', { class: 'muted' }, named ? 'Если не сохранить, последние изменения пропадут (их можно будет вернуть только кнопкой «Отменить» до закрытия программы).'
              : 'Если не сохранить, схема пропадёт при открытии другой (вернуть её можно будет только кнопкой «Отменить» до закрытия программы).')),
          onCancel: () => pick('cancel'),
          enterAction: () => pick('save'),
          actions: [
            { label: 'Отмена', onClick: () => pick('cancel') },
            { label: 'Не сохранять', onClick: () => pick('discard') },
            { label: 'Сохранить', primary: true, onClick: () => pick('save') },
          ],
        });
      });
      if (choice === 'cancel') return false;
      if (choice === 'save') return this.saveFile(false);
      return true;
    },

    async newProject() {
      if (this.hasUnsaved()) { if (!(await this.confirmUnsaved('Новая схема'))) return; } else if (this.net.devices.size && !(await UI.confirm('Новая схема', 'Текущая схема будет закрыта. Её можно вернуть кнопкой «Отменить».', 'Создать'))) return;
      this.setNetwork(new NS.Network(), { undoable: true });
      this.setFile(null, null, false);
    },

    /** Сохранить. saveAs — всегда спрашивать имя. Возвращает true, если файл записан. */
    async saveFile(saveAs) {
      const text = JSON.stringify(this.net.serialize(), null, 1);
      if (DESKTOP) {
        try {
          const r = await DESKTOP.saveFile({ text, path: this.filePath, saveAs: !!saveAs, suggestedName: this.fileName || 'Моя сеть.netlab' });
          if (!r) return false;
          this.setFile(r.path, r.name, false);
          UI.toast('Сохранено: ' + r.name, 'ok');
          return true;
        } catch (e) {
          UI.toast('Не удалось сохранить файл: ' + e.message, 'err', 6000);
          return false;
        }
      }
      const name = this.fileName || 'netlab-' + new Date().toISOString().slice(0, 10) + '.netlab';
      UI.download(name, text);
      this.setFile(null, name, false);
      UI.toast('Файл «' + name + '» сохранён в папку загрузок', 'ok');
      return true;
    },

    async openFile() {
      if (!(await this.confirmUnsaved('Открыть файл'))) return;
      if (DESKTOP) {
        try {
          const f = await DESKTOP.openFile();
          if (f) this.openText(f.text, f.name, f.path);
        } catch (e) {
          UI.toast('Не удалось открыть файл: ' + e.message, 'err', 6000);
        }
        return;
      }
      const f = await UI.pickFile('.netlab,.json,application/json');
      if (f) this.openText(f.text, f.name, null);
    },

    openText(text, name, path) {
      try {
        const net = NS.Network.deserialize(JSON.parse(text));
        this.setNetwork(net, { undoable: true });
        this.setFile(path, name, false);
        UI.toast('Открыт файл «' + name + '»', 'ok');
      } catch (e) {
        UI.toast('Не удалось открыть «' + name + '»: ' + e.message, 'err', 6000);
      }
    },

    async showAbout() {
      const v = DESKTOP ? await DESKTOP.version() : null;
      const st = DESKTOP && DESKTOP.updateStatus ? await DESKTOP.updateStatus() : null;
      const auto = UI.toggle('Проверять обновления при запуске', this.settings.autoUpdate !== false, (on) => { this.settings.autoUpdate = on; this.savePrefs(); });
      let close = null;
      close = UI.modal({
        title: 'NetLab' + (v ? ' ' + v : ''),
        body: h('div', null,
          h('p', null, 'Учебный симулятор компьютерных сетей в духе Cisco Packet Tracer.'),
          h('p', null, DESKTOP
            ? 'Настольная версия' + (st && st.portable ? ' без установки (portable)' : '') + '. Схемы сохраняются в файлы .netlab; последняя схема также восстанавливается автоматически при запуске.'
            : 'Браузерная версия. Схема автоматически сохраняется в этом браузере.'),
          st ? h('div', { class: 'hint-box', style: { marginTop: '8px' } },
            st.supported ? (st.downloaded ? 'Загружено обновление ' + st.available + ' — оно установится при закрытии программы.' : st.available ? 'Доступна новая версия ' + st.available + '.' : 'Обновления: ' + st.page)
              : st.reason) : null,
          st ? h('div', { style: { marginTop: '10px' } }, auto) : null),
        actions: st ? [
          { label: 'Проверить обновления', onClick: () => { setTimeout(() => UI.updates.check(true), 0); } },
          { label: 'Закрыть', primary: true },
        ] : [{ label: 'Закрыть', primary: true }],
      });
      return close;
    },

    /** Подключение к настольной оболочке: команды меню, открытие файлов, закрытие окна. */
    bindDesktop() {
      // перетаскивание файла схемы на окно — работает и в браузере
      document.addEventListener('dragover', (e) => {
        if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault();
      });
      document.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        if (!/\.(netlab|json)$/i.test(f.name)) { UI.toast('Можно открыть только файл схемы (.netlab)', 'err'); return; }
        const path = DESKTOP ? DESKTOP.pathForFile(f) : null;
        const r = new FileReader();
        r.onload = async () => { if (await this.confirmUnsaved('Открыть файл')) this.openText(String(r.result), f.name, path); };
        r.readAsText(f);
      });
      window.addEventListener('beforeunload', (e) => {
        clearTimeout(this.saveTimer);
        UI.store.set(AUTOSAVE_KEY, this.snapshot());
        // в браузере — стандартный вопрос «Покинуть сайт?»; в настольной версии спрашивает сама оболочка
        if (!DESKTOP && this.hasUnsaved()) { e.preventDefault(); e.returnValue = ''; }
      });
      if (!DESKTOP) return;
      DESKTOP.onOpenFile(async (f) => { if (await this.confirmUnsaved('Открыть файл')) this.openText(f.text, f.name, f.path); });
      DESKTOP.onMenu(async (cmd) => {
        if (document.querySelector('.modal-back') && cmd !== 'save-and-close') return;
        switch (cmd) {
          case 'new': this.newProject(); break;
          case 'open': this.openFile(); break;
          case 'save': this.saveFile(false); break;
          case 'saveAs': this.saveFile(true); break;
          case 'save-and-close': if (await this.saveFile(false)) DESKTOP.closeNow(); break;
          case 'examples': this.showExamples(); break;
          case 'help': this.showHelp(); break;
          case 'about': this.showAbout(); break;
          case 'check-updates': if (UI.updates) UI.updates.check(true); break;
          case 'whats-new': if (UI.updates) UI.updates.whatsNew(true); break;
          case 'undo': this.undo(); break;
          case 'redo': this.redo(); break;
          case 'duplicate': this.duplicate([...this.ws.selection].filter((id) => this.net.getDevice(id))); break;
          case 'delete': this.deleteSelection(); break;
          case 'selectAll': this.selectAll(); break;
          case 'mode-realtime': this.setMode('realtime'); break;
          case 'mode-sim': this.setMode('sim'); break;
          case 'fit': this.ws.fit(); break;
          default: break;
        }
      });
    },

    selectAll() {
      this.ws.selection = new Set([...this.net.devices.keys(), ...this.net.notes.map((n) => n.id)]);
      this.needRender = true;
      this.updateStatus();
    },

    showExamples() {
      const list = h('div', { style: { display: 'grid', gap: '8px' } });
      let close = null;
      for (const ex of UI.EXAMPLES) {
        list.appendChild(h('button', {
          class: 'msg-card', style: { textAlign: 'left', cursor: 'pointer', display: 'block', width: '100%', color: 'inherit', font: 'inherit' },
          onClick: async () => { close(); if (await this.confirmUnsaved('Открыть пример')) this.loadExample(ex); },
        }, h('div', { class: 'head' }, h('span', null, ex.title), h('span', { class: 'meta' }, ex.level)), h('div', { class: 'body muted' }, ex.desc)));
      }
      close = UI.modal({ title: 'Примеры', body: list, actions: [{ label: 'Закрыть' }] });
    },

    loadExample(ex) {
      try {
        const net = ex.build();
        net.runUntilIdle(5000);
        this.setNetwork(net, { undoable: true });
        this.setFile(null, null, false);
        UI.toast('Пример «' + ex.title + '» загружен. Предыдущую схему можно вернуть через «Отменить».', 'ok', 4000);
      } catch (e) {
        console.error(e);
        UI.toast('Ошибка в примере: ' + e.message, 'err');
      }
    },

    showHelp() {
      const k = (t) => h('span', { class: 'kbd' }, t);
      const body = h('div', null,
        h('p', null, 'NetLab — учебный симулятор компьютерных сетей в духе Cisco Packet Tracer.'),
        h('b', null, 'Быстрый старт'),
        h('ul', null,
          h('li', null, 'Слева выберите категорию устройств (Маршрутизаторы, Коммутаторы, Конечные…) и модель; щёлкните по схеме или перетащите модель.'),
          h('li', null, '«Кабель» ', k('C'), ': выберите тип (Автоматически, Консольный, Медный прямой/перекрёстный, Оптоволокно, Serial DCE/DTE) и щёлкните по двум устройствам. Неверный кабель — красные индикаторы и подсказка.'),
          h('li', null, 'Двойной щелчок по устройству: вкладки «Физический вид» (модули, питание), «Настройка», «Рабочий стол» (IP Configuration, Command Prompt, Web Browser, Email, Terminal…), CLI, «Атрибуты».'),
          h('li', null, 'На вкладке «Настройка» маршрутизатора и коммутатора каждое действие выполняется командой IOS — внизу видно «Эквивалентные команды IOS».'),
          h('li', null, 'Как в IOS: конфигурация пропадает после выключения или reload, если не сохранить её (copy running-config startup-config или кнопка «Сохранить» в NVRAM).'),
          h('li', null, 'Инспектор ', k('I'), ' показывает таблицы ARP, MAC, маршрутизации, NAT, DHCP, CDP.'),
          h('li', null, '«Симуляция» (вверху справа) — пакеты движутся по шагам, каждое решение устройства объяснено.')),
        h('b', null, 'IPv6, VPN, телефония, IoT'),
        h('ul', null,
          h('li', null, 'IPv6: поля в IP Configuration и в настройках интерфейсов, ipv6 unicast-routing, SLAAC. SNMP — программа MIB Browser, NetFlow — NetFlow Collector.'),
          h('li', null, 'VPN (GRE, IPsec, Easy VPN), PPPoE Dialer и Dial-up (модем + облако Cloud-PT в категории WAN) — программы на рабочем столе.'),
          h('li', null, 'IP-телефон 7960: вкладка «Телефон», питание — адаптер (Физический вид) или PoE 3560-24PS. АТС — Cisco CME на маршрутизаторе (Настройка → Телефония). IP Communicator — на рабочем столе ПК.'),
          h('li', null, 'Bluetooth: программа на смартфоне, ноутбуке или планшете; устройства должны быть рядом на схеме.'),
          h('li', null, 'IoT: умные устройства и платы — категория IoT слева. IoT Monitor управляет устройствами, вкладка «Программирование» платы запускает код, IoX IDE загружает приложения на маршрутизатор.'),
          h('li', null, 'Готовые примеры по каждой теме — кнопка «Примеры».')),
        h('b', null, 'Новое в 1.3'),
        h('ul', null,
          h('li', null, 'Задания с проверкой: кнопка «Задание» → «Мастер заданий» (ответ, инструкции, пункты оценки, таймер). У ученика — панель задания с кнопкой «Проверить».'),
          h('li', null, 'ASA 5506-X, WLC 2504 и точки LAP, модемы, вышка 3G/4G, сетевой контроллер — в категориях слева; у ASA свой CLI, WLC настраивается во вкладке «Настройка».'),
          h('li', null, 'Инструмент «Сложный PDU» — на панели слева, сценарии PDU — внизу. «Вид» → «Физические расстояния» и «Многопользовательский режим».'),
          h('li', null, 'Программы плат — на JavaScript, Python или блоками (вкладка «Программирование»). На IP-телефоне — «Удержать», «Вернуть», «Перевести».')),
        h('b', null, 'Клавиши'),
        h('ul', null,
          h('li', null, k('V'), ' выбор, ', k('C'), ' кабель, ', k('P'), ' ping, ', k('M'), ' сообщение, ', k('I'), ' инспектор, ', k('N'), ' заметка, ', k('G'), ' фигура, ', k('X'), ' удаление'),
          h('li', null, k('1'), '–', k('9'), ' быстро поставить: ПК, ноутбук, сервер, 2960, 2911, хаб, точка доступа, WRT300N, 3560'),
          h('li', null, k('Del'), ' удалить выделенное, ', k('Ctrl+D'), ' дублировать, ', k('Ctrl+A'), ' выделить всё, ', k('Esc'), ' отмена'),
          h('li', null, k('Ctrl+Z'), ' / ', k('Ctrl+Y'), ' отменить / повторить, ', k('Ctrl+S'), ' сохранить, ', k('F'), ' показать всю схему'),
          h('li', null, 'В консоли IOS: ', k('?'), ' подсказка, ', k('Tab'), ' дописать команду, ', k('Ctrl+Z'), ' выйти в привилегированный режим, ', k('Ctrl+C'), ' прервать'),
          h('li', null, 'В симуляции: ', k('Пробел'), ' пуск/пауза, ', k('→'), ' шаг'),
          h('li', null, 'Shift+перетаскивание по фону — выделение рамкой; колесо мыши — масштаб.')),
        h('b', null, 'Что сделано надёжнее, чем в Packet Tracer'),
        h('ul', null,
          h('li', null, 'Сообщение или письмо нескольким получателям доставляется каждому отдельно, с отчётом по каждому адресу, повторами и понятной причиной ошибки; дубликатов не бывает.'),
          h('li', null, 'Первый ping не теряется: пакеты ждут в очереди, пока выполняется ARP.'),
          h('li', null, 'STP, RIP и OSPF сходятся мгновенно — не нужно ждать «зелёных» индикаторов.'),
          h('li', null, 'Ошибки настройки (шлюз вне сети, адрес сети, пересечение подсетей, неверный кабель, нет clock rate) показываются сразу, конфликты IP обнаруживаются.'),
          h('li', null, 'Петли не «вешают» программу, отмена работает для любых изменений, схема автоматически сохраняется.'),
          h('li', null, 'Ядро симулятора покрыто автотестами (npm test).')));
      UI.modal({ title: 'Справка', body, actions: [{ label: 'Понятно', primary: true }] });
    },

    /* ---------- клавиатура ---------- */

    bindKeys() {
      document.addEventListener('keydown', (e) => {
        const t = e.target;
        const typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || (t.closest && t.closest('.term')));
        if (document.querySelector('.modal-back')) return;
        const ctrl = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (ctrl && key === 's') { e.preventDefault(); this.saveFile(e.shiftKey); return; }
        if (ctrl && key === 'o') { e.preventDefault(); this.openFile(); return; }
        if (ctrl && key === 'n') { e.preventDefault(); this.newProject(); return; }
        if (typing) return;
        if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
        if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
        if (ctrl && key === 'a') { e.preventDefault(); this.selectAll(); return; }
        if (ctrl && key === 'd') { e.preventDefault(); this.duplicate([...this.ws.selection].filter((id) => this.net.getDevice(id))); return; }
        if (ctrl || e.altKey) return;
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); return; }
        if (e.key === 'Escape') {
          if (this.tool !== 'select' || this.ws.cableSrc || this.ws.pduSrc) this.setTool('select');
          else if (this.ws.selection.size || this.ws.selLink) { this.ws.selection.clear(); this.ws.selLink = null; this.needRender = true; }
          return;
        }
        if (e.key === 'F1') { e.preventDefault(); this.showHelp(); return; }
        if (this.mode === 'sim' && e.key === ' ') { e.preventDefault(); this.sim.togglePlay(); return; }
        if (this.mode === 'sim' && e.key === 'ArrowRight') { e.preventDefault(); this.sim.step(); return; }
        if (key === 'c') { this.setCable('auto'); return; }
        const tools = { v: 'select', p: 'pdu', m: 'mail', n: 'note', x: 'delete', i: 'inspect', g: 'shape' };
        if (tools[key]) { this.setTool(tools[key]); return; }
        if (/^[1-9]$/.test(e.key)) {
          const QUICK = ['PC-PT', 'Laptop-PT', 'Server-PT', '2960-24TT', '2911', 'Hub-PT', 'AccessPoint-PT', 'WRT300N', '3560-24PS'];
          this.setTool('place:' + QUICK[Number(e.key) - 1]);
          return;
        }
        if (key === 'f') { this.ws.fit(); return; }
        if (e.key === '+' || e.key === '=') { this.ws.zoomBy(1.2); return; }
        if (e.key === '-') { this.ws.zoomBy(1 / 1.2); return; }
        if (key === 's') { this.setMode(this.mode === 'sim' ? 'realtime' : 'sim'); return; }
        if (key === 'r') { this.setMode('realtime'); }
      });
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => this.applyTheme());
      }
    },
  };

  NS.app = App;
  window.addEventListener('DOMContentLoaded', () => { App.init(); if (NS.muSetup) NS.muSetup(App); if (NS.taskSetup) NS.taskSetup(App); });
})(globalThis.NetLab = globalThis.NetLab || {});
