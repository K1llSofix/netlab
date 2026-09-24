/* NetLab — сеть: устройства, кабели (типы, проверка правильности), беспроводные ассоциации,
 * дискретно-событийный движок, журнал событий, сохранение. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;

  const LINK_DELAY = 1;          // тиков на передачу по кабелю
  const MAX_IN_FLIGHT = 4000;    // защита от широковещательного шторма
  const MAX_L2_HOPS = 64;        // защита от петель через концентраторы
  const WIFI_RANGE = 420;        // дальность Wi-Fi в единицах схемы

  const DATA_MEDIA = new Set(['copper', 'fiber', 'serial', 'wireless', 'phone', 'iot', 'coax']);
  const CELL_RANGE = 1400;       // дальность вышки 3G/4G

  const CABLES = {
    auto: 'Автоматически',
    straight: 'Медный прямой',
    cross: 'Медный перекрёстный',
    fiber: 'Оптоволокно',
    console: 'Консольный',
    serial: 'Serial',
    phone: 'Телефонный',
    coaxial: 'Коаксиальный',
    iot: 'IoT (кастомный)',
    wireless: 'Беспроводная связь',
  };

  NS.deviceTypes = NS.deviceTypes || {};
  /** Расширения уровня схемы (сценарии PDU, задание, настройки): { key, init(net), save(net) → данные|null, load(net, данные) }. */
  NS.netExt = NS.netExt || [];

  function isData(p) { return !!p && DATA_MEDIA.has(p.media); }

  /** Можно ли порт использовать с этим типом кабеля. */
  function portFits(cable, p) {
    switch (cable) {
      case 'straight': case 'cross': return p.media === 'copper';
      case 'fiber': return p.media === 'fiber';
      case 'console': return p.media === 'console' || p.media === 'rs232';
      case 'serial': return p.media === 'serial';
      case 'phone': return p.media === 'phone';
      case 'coaxial': return p.media === 'coax';
      case 'iot': return p.media === 'iot';
      default: return p.media === 'copper' || p.media === 'fiber' || p.media === 'serial' || p.media === 'phone' || p.media === 'iot' || p.media === 'coax';
    }
  }

  /** Подходит ли кабель к паре портов по типу разъёма. */
  function pairFits(cable, pa, pb) {
    if (!portFits(cable, pa) || !portFits(cable, pb)) return false;
    if (cable === 'console') return (pa.media === 'console') !== (pb.media === 'console');
    return pa.media === pb.media;
  }

  class Network {
    constructor() {
      this.devices = new Map();
      this.links = new Map();
      this.notes = [];
      this.shapes = [];
      this.time = 0;
      this.queue = new U.EventQueue();
      this.seq = 0;
      this.counters = { id: 1, mac: 1, link: 1, note: 1, msg: 1, xid: 1, shape: 1 };
      this.listeners = new Set();
      this.recording = false;
      this.log = [];
      this.logLimit = 4000;
      this.logSeq = 0;
      this.inFlight = new Map();
      this.activity = [];
      this.stormUntil = -1;
      this.routingDirty = true;
      for (const e of NS.netExt) if (e.init) e.init(this);
    }

    /* ---------- уведомления для интерфейса ---------- */

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    emit(type, data) {
      for (const fn of this.listeners) {
        try { fn(type, data); } catch (e) { console.error(e); }
      }
    }

    /* ---------- устройства ---------- */

    allocMac() {
      const used = new Set();
      for (const d of this.devices.values()) {
        if (d.baseMac) used.add(d.baseMac);
        for (const p of d.ports) if (p.mac) used.add(p.mac);
      }
      let mac;
      do { mac = U.macFromCounter(this.counters.mac++); } while (used.has(mac));
      return mac;
    }

    uniqueName(prefix) {
      const used = new Set();
      for (const d of this.devices.values()) used.add(d.name.toLowerCase());
      for (let n = 0; ; n++) {
        if (!used.has((prefix + n).toLowerCase())) return prefix + n;
      }
    }

    addDevice(type, opts) {
      opts = opts || {};
      const Cls = NS.deviceTypes[type];
      if (!Cls) throw new Error('Неизвестный тип устройства: ' + type);
      const model = opts.model || NS.models.DEFAULT_MODEL[type];
      const id = 'd' + this.counters.id++;
      const dev = new Cls(this, id, opts.name || this.uniqueName(Cls.namePrefix), model);
      dev.x = opts.x || 0;
      dev.y = opts.y || 0;
      this.devices.set(id, dev);
      this.refreshTopology();
      return dev;
    }

    getDevice(id) { return this.devices.get(id) || null; }

    findByName(name) {
      const n = String(name).toLowerCase();
      for (const d of this.devices.values()) if (d.name.toLowerCase() === n) return d;
      return null;
    }

    renameDevice(dev, name) {
      const n = String(name || '').trim();
      if (!n) throw new Error('Имя не может быть пустым');
      if (!/^[\p{L}\p{N}_.-]{1,32}$/u.test(n)) throw new Error('Имя: только буквы, цифры, «-», «_», «.» (до 32 символов)');
      const other = this.findByName(n);
      if (other && other !== dev) throw new Error('Устройство с именем «' + n + '» уже есть');
      dev.name = n;
    }

    removeDevice(id) {
      const dev = this.devices.get(id);
      if (!dev) return;
      for (const l of [...this.links.values()]) {
        if (l.a.dev === id || l.b.dev === id) this._removeLink(l);
      }
      dev.destroy();
      this.devices.delete(id);
      this.refreshTopology();
    }

    setPower(dev, on) {
      if (dev.power === !!on) return;
      dev.power = !!on;
      dev.reset();
      if (dev.power && dev.onPowerOn) dev.onPowerOn();
      this.refreshTopology();
    }

    /** Заменить модуль в слоте (только при выключенном питании, как в Packet Tracer). */
    setModule(dev, slotId, moduleId) {
      if (dev.power) throw new Error('Модули меняются только при выключенном питании — нажмите кнопку питания устройства');
      const slot = dev.slots.find((s) => s.id === slotId);
      if (!slot) throw new Error('Слот не найден');
      if (moduleId) {
        const m = NS.models.module(moduleId);
        if (!m || m.kind !== slot.kind) throw new Error('Модуль ' + moduleId + ' не подходит к этому слоту');
      }
      slot.module = moduleId || null;
      const map = dev.rebuildPorts();
      for (const l of [...this.links.values()]) {
        for (const end of [l.a, l.b]) {
          if (end.dev !== dev.id) continue;
          const ni = map[end.port];
          if (ni === undefined || ni < 0) { this._removeLink(l); break; }
          end.port = ni;
        }
      }
      this.refreshTopology();
    }

    /* ---------- кабели ---------- */

    firstFreePort(dev, cable) {
      return dev.ports.findIndex((p) => !p.link && portFits(cable || 'auto', p));
    }

    /** Подобрать свободные совместимые порты. Возвращает [ia, ib] или бросает Error. */
    pickPorts(a, aPort, b, bPort, cable) {
      const fixed = (dev, i) => {
        const p = dev.ports[i];
        if (!p) throw new Error('Порт не найден');
        if (p.link) throw new Error('Порт ' + dev.name + ' ' + p.name + ' уже занят');
        if (!portFits(cable, p)) throw new Error('К порту ' + dev.name + ' ' + p.name + ' нельзя подключить кабель «' + CABLES[cable] + '»');
        return i;
      };
      const free = (dev, other, oi) => dev.ports.map((p, i) => i).filter((i) => {
        const p = dev.ports[i];
        if (p.link || !portFits(cable, p)) return false;
        return oi == null || pairFits(cable, p, other.ports[oi]);
      });
      let ia = aPort === 'auto' || aPort == null ? null : fixed(a, aPort);
      let ib = bPort === 'auto' || bPort == null ? null : fixed(b, bPort);
      if (ia == null && ib == null) {
        for (const i of free(a, null, null)) {
          const j = free(b, a, i)[0];
          if (j !== undefined) { ia = i; ib = j; break; }
        }
        if (ia == null) throw new Error('Нет свободных совместимых портов для кабеля «' + CABLES[cable] + '» между ' + a.name + ' и ' + b.name);
      } else if (ia == null) {
        ia = free(a, b, ib)[0];
        if (ia === undefined) throw new Error('У ' + a.name + ' нет свободного порта, совместимого с ' + b.ports[ib].name);
      } else if (ib == null) {
        ib = free(b, a, ia)[0];
        if (ib === undefined) throw new Error('У ' + b.name + ' нет свободного порта, совместимого с ' + a.ports[ia].name);
      } else if (!pairFits(cable, a.ports[ia], b.ports[ib])) {
        throw new Error('Порты ' + a.ports[ia].name + ' и ' + b.ports[ib].name + ' нельзя соединить: разные типы разъёмов (' + a.ports[ia].media + ' / ' + b.ports[ib].media + ')');
      }
      return [ia, ib];
    }

    /** Конкретный тип кабеля для «Автоматически». */
    static resolveCable(pa, pb) {
      if (pa.media === 'phone') return 'phone';
      if (pa.media === 'coax') return 'coaxial';
      if (pa.media === 'iot') return 'iot';
      if (pa.media === 'fiber') return 'fiber';
      if (pa.media === 'serial') return 'serial';
      if (pa.media === 'console' || pa.media === 'rs232') return 'console';
      return !!pa.mdix !== !!pb.mdix ? 'straight' : 'cross';
    }

    /**
     * Соединить порты. port = индекс или 'auto'.
     * cable: auto | straight | cross | fiber | console | serial-dce | serial-dte (первое устройство — DCE/DTE).
     */
    connect(aId, aPort, bId, bPort, cable) {
      const a = this.devices.get(aId);
      const b = this.devices.get(bId);
      if (!a || !b) throw new Error('Устройство не найдено');
      if (a === b) throw new Error('Нельзя соединить устройство само с собой');
      let c = cable || 'auto';
      let dce = null;
      if (c === 'serial-dce' || c === 'serial-dte' || c === 'serial') {
        dce = c === 'serial-dte' ? bId : aId;
        c = 'serial';
      }
      const [ia, ib] = this.pickPorts(a, aPort, b, bPort, c);
      const pa = a.ports[ia];
      const pb = b.ports[ib];
      const kind = c === 'auto' ? Network.resolveCable(pa, pb) : c;
      if (kind === 'serial' && !dce) dce = aId;
      const link = { id: 'l' + this.counters.link++, a: { dev: aId, port: ia }, b: { dev: bId, port: ib }, cable: kind, dce };
      this._addLink(link);
      this.refreshTopology();
      return link;
    }

    _addLink(link) {
      const a = this.devices.get(link.a.dev);
      const b = this.devices.get(link.b.dev);
      if (!a || !b || !a.ports[link.a.port] || !b.ports[link.b.port]) throw new Error('Неверный кабель ' + link.id);
      if (a.ports[link.a.port].link || b.ports[link.b.port].link) throw new Error('Порт уже занят (' + link.id + ')');
      a.ports[link.a.port].link = link.id;
      b.ports[link.b.port].link = link.id;
      this.links.set(link.id, link);
    }

    _removeLink(link) {
      for (const end of [link.a, link.b]) {
        const d = this.devices.get(end.dev);
        const p = d && d.ports[end.port];
        if (!p) continue;
        if (p.link === link.id) p.link = null;
        if (p.wlinks) p.wlinks.delete(link.id);
      }
      this.links.delete(link.id);
    }

    disconnect(linkId) {
      const l = this.links.get(linkId);
      if (!l || l.wireless) return;
      this._removeLink(l);
      this.refreshTopology();
    }

    /** Другой конец кабеля: {dev, port, link} или null. У радиопорта точки доступа — null. */
    peer(dev, portIdx) {
      const p = dev.ports[portIdx];
      if (!p || !p.link) return null;
      const l = this.links.get(p.link);
      if (!l) return null;
      const o = (l.a.dev === dev.id && l.a.port === portIdx) ? l.b : l.a;
      const od = this.devices.get(o.dev);
      if (!od) return null;
      return { dev: od, port: o.port, link: l };
    }

    /** Почему канал не работает, хотя кабель подключён (неверный кабель, нет clock rate…), или null. */
    linkIssue(l) {
      if (l.wireless || l.cable === 'console') return null;
      const a = this.devices.get(l.a.dev);
      const b = this.devices.get(l.b.dev);
      if (!a || !b) return 'Устройство удалено';
      const pa = a.ports[l.a.port];
      const pb = b.ports[l.b.port];
      if (l.cable === 'straight' && !!pa.mdix === !!pb.mdix) return 'Неверный тип кабеля: для соединения однотипных устройств нужен перекрёстный кабель';
      if (l.cable === 'cross' && !!pa.mdix !== !!pb.mdix) return 'Неверный тип кабеля: здесь нужен прямой кабель';
      if (l.cable === 'serial') {
        const dceP = l.dce === l.a.dev ? pa : pb;
        const dceDev = l.dce === l.a.dev ? a : b;
        if (!dceP.clockRate) return 'На стороне DCE (' + dceDev.name + ' ' + dceP.name + ') не задана тактовая частота: clock rate';
        if ((pa.encap || 'hdlc') !== (pb.encap || 'hdlc')) return 'Разная инкапсуляция на концах канала (HDLC / PPP)';
      }
      return null;
    }

    /** Порт передаёт данные: питание, кабель/ассоциация, оба конца не в shutdown, кабель правильный. */
    isPortOperational(dev, portIdx) {
      const p = dev.ports[portIdx];
      if (!p || !dev.power || !p.adminUp || p.errDisabled || !isData(p)) return false;
      if (p.radio) return dev.radioEnabled ? dev.radioEnabled() : true;
      if (!p.link) return false;
      const l = this.links.get(p.link);
      if (!l || l.cable === 'console') return false;
      const pr = this.peer(dev, portIdx);
      if (!pr || !pr.dev.power) return false;
      const op = pr.dev.ports[pr.port];
      if (!op || !op.adminUp || op.errDisabled) return false;
      if (op.radio) return pr.dev.radioEnabled ? pr.dev.radioEnabled() : true;
      return !this.linkIssue(l);
    }

    /** Состояние конца кабеля для отрисовки: 'up' | 'down' | 'blocking'. */
    portVisualState(dev, portIdx) {
      const p = dev.ports[portIdx];
      if (!this.isPortOperational(dev, portIdx)) return 'down';
      if (p.stp === 'blocking') return 'blocking';
      return 'up';
    }

    /** Устройство на другом конце консольного кабеля (для программы «Терминал»). */
    consolePeer(dev) {
      for (let i = 0; i < dev.ports.length; i++) {
        const p = dev.ports[i];
        if (p.media !== 'rs232' || !p.link) continue;
        const pr = this.peer(dev, i);
        if (pr && pr.link.cable === 'console') return pr.dev;
      }
      return null;
    }

    /* ---------- Wi-Fi ---------- */

    /** Состояние беспроводного клиента: {ap, reason} — к какой точке подключён или почему нет. */
    wirelessStatus(dev) {
      const i = dev.ports.findIndex((p) => p.media === 'wireless' && !p.radio);
      if (i < 0) return null;
      const p = dev.ports[i];
      const cfg = dev.wifi || {};
      if (p.link) {
        const l = this.links.get(p.link);
        const ap = l && this.devices.get(l.a.dev);
        if (ap) return { ap, reason: null };
      }
      if (!dev.power) return { ap: null, reason: 'Устройство выключено' };
      if (!cfg.ssid && dev.cellular) return { ap: null, reason: 'Нет сети 3G/4G: вышка сотовой связи слишком далеко или выключена' };
      if (!cfg.ssid) return { ap: null, reason: 'Не задан SSID сети' };
      const nets = (ap) => wlansOf(ap).filter((w) => w.ssid === cfg.ssid);
      const same = this.accessPoints().filter((ap) => nets(ap).length);
      if (!same.length) return { ap: null, reason: 'Сеть «' + cfg.ssid + '» не найдена' };
      const near = same.filter((ap) => Math.hypot(ap.x - dev.x, ap.y - dev.y) <= this.wifiRange());
      if (!near.length) return { ap: null, reason: 'Точка доступа «' + cfg.ssid + '» слишком далеко' };
      const sec = near.flatMap((ap) => nets(ap).map((w) => ({ ap, w }))).filter((x) => (x.w.security || 'open') === (cfg.security || 'open'));
      if (!sec.length) return { ap: null, reason: 'Тип защиты не совпадает с точкой доступа' };
      if ((cfg.security || 'open') === 'wpa2-ent') {
        for (const x of sec) {
          const st = x.ap.entCheck ? x.ap.entCheck(dev, x.w, cfg, true) : 'unsupported';
          if (st === 'pending') return { ap: null, reason: 'Проверка WPA2-Enterprise на RADIUS-сервере…' };
          if (st === 'fail') return { ap: null, reason: 'RADIUS-сервер отклонил пользователя ' + (cfg.user || '') + ' (или сервер недоступен)' };
          if (st === 'unsupported') return { ap: null, reason: 'Эта точка доступа не поддерживает WPA2-Enterprise' };
        }
      }
      return { ap: null, reason: 'Неверный ключ (пароль) сети' };
    }

    accessPoints() {
      const out = [];
      for (const d of this.devices.values()) {
        if (!d.power || !d.wifi || !d.radioEnabled || !d.radioEnabled()) continue;
        if (d.ports.some((p) => p.radio)) out.push(d);
      }
      return out;
    }

    /** Точки доступа в радиусе действия устройства (для списка сетей). */
    scanWifi(dev) {
      return this.accessPoints()
        .map((ap) => ({ ap, dist: Math.hypot(ap.x - dev.x, ap.y - dev.y) }))
        .filter((x) => x.dist <= this.wifiRange())
        .sort((a, b) => a.dist - b.dist)
        .flatMap((x) => wlansOf(x.ap).map((w) => ({ ssid: w.ssid, security: w.security || 'open', channel: w.channel || x.ap.wifi.channel || 6, signal: Math.max(1, Math.round(100 - (x.dist / this.wifiRange()) * 80)), ap: x.ap })));
    }

    updateWireless() {
      const aps = this.accessPoints();
      const want = new Map();
      for (const d of this.devices.values()) {
        const i = d.ports.findIndex((p) => p.media === 'wireless' && !p.radio);
        if (i < 0 || !d.power || !d.ports[i].adminUp) continue;
        const cfg = d.wifi || {};
        if (!cfg.ssid && !d.cellular) continue;
        let best = null;
        let bestD = Infinity;
        for (const ap of cfg.ssid ? aps : []) {
          const dist = Math.hypot(ap.x - d.x, ap.y - d.y);
          if (dist > this.wifiRange() || dist >= bestD) continue;
          for (const w of wlansOf(ap)) {
            if (w.ssid !== cfg.ssid) continue;
            const sec = w.security || 'open';
            if (sec !== (cfg.security || 'open')) continue;
            if (sec === 'wpa2' && w.key !== cfg.key) continue;
            if (sec === 'wpa2-ent' && !(ap.entCheck && ap.entCheck(d, w, cfg) === 'ok')) continue;
            best = ap;
            bestD = dist;
            break;
          }
        }
        if (!best && d.cellular) {
          for (const t of aps) {
            if (t.type !== 'celltower') continue;
            const dist = Math.hypot(t.x - d.x, t.y - d.y);
            if (dist <= this.cellRange() && dist < bestD) { best = t; bestD = dist; }
          }
        }
        if (best) want.set(d.id, { ap: best, radio: best.ports.findIndex((p) => p.radio), port: i });
      }
      for (const l of [...this.links.values()]) {
        if (!l.wireless) continue;
        const w = want.get(l.b.dev);
        if (!w || w.ap.id !== l.a.dev || w.radio !== l.a.port || w.port !== l.b.port) this._removeLink(l);
        else want.delete(l.b.dev);
      }
      for (const [devId, w] of want) {
        const id = 'w:' + w.ap.id + ':' + devId;
        const link = { id, a: { dev: w.ap.id, port: w.radio }, b: { dev: devId, port: w.port }, cable: 'wireless', wireless: true };
        const rp = w.ap.ports[w.radio];
        if (!rp.wlinks) rp.wlinks = new Set();
        rp.wlinks.add(id);
        this.getDevice(devId).ports[w.port].link = id;
        this.links.set(id, link);
      }
    }

    /** Дальность Wi-Fi и вышки 3G/4G в единицах схемы (модуль физических расстояний может пересчитать из метров). */
    wifiRange() { return WIFI_RANGE; }
    cellRange() { return CELL_RANGE; }

    /** Пересчитать состояние портов, Wi-Fi и STP после любого изменения топологии/настроек. */
    refreshTopology() {
      this.updateWireless();
      const changed = [];
      for (const dev of this.devices.values()) {
        dev.ports.forEach((p, i) => {
          const up = this.isPortOperational(dev, i);
          if (p.oper !== up) {
            p.oper = up;
            changed.push([dev, i, up]);
          }
        });
      }
      const stpChanged = NS.stp.compute(this);
      if (stpChanged) {
        for (const d of this.devices.values()) if (d.flushMacTable) d.flushMacTable();
      }
      this.routingDirty = true;
      for (const [dev, i, up] of changed) {
        try { dev.onLinkChange(i, up); } catch (e) { console.error(e); this.emit('error', e); }
      }
      this.emit('topology');
    }

    markRouting() { this.routingDirty = true; }

    /** Пересчитать динамическую маршрутизацию (RIP/OSPF), если что-то менялось. */
    ensureRouting() {
      if (!this.routingDirty || this.computingRoutes) return;
      this.routingDirty = false;
      this.computingRoutes = true;
      try { if (NS.routing) NS.routing.compute(this); } finally { this.computingRoutes = false; }
    }

    /* ---------- движок событий ---------- */

    schedule(ev) {
      ev.seq = this.seq++;
      this.queue.push(ev);
      return ev;
    }

    /** Таймер устройства. Срабатывает, только если устройство не перезапускалось. */
    timer(dev, delay, fn) {
      const ev = this.schedule({ kind: 'timer', time: this.time + Math.max(0, delay), dev: dev ? dev.id : null, epoch: dev ? dev.epoch : 0, fn, cancelled: false });
      return { cancel() { ev.cancelled = true; } };
    }

    /**
     * Отправить кадр в порт. Возвращает true, если кадр ушёл в кабель (эфир).
     * excludeDev — для радиопорта точки доступа: не отправлять обратно этому клиенту.
     */
    transmit(dev, portIdx, frame, why, excludeDev) {
      const p = dev.ports[portIdx];
      if (!this.isPortOperational(dev, portIdx)) {
        this.logDrop(dev, frame, 'Порт ' + (p ? p.name : '?') + ' не активен');
        return false;
      }
      if (p.stp === 'blocking') return false;
      const hops = (frame.hops || 0) + 1;
      if (hops > MAX_L2_HOPS) {
        this.logDrop(dev, frame, 'Кадр прошёл слишком много коммутаторов/концентраторов — вероятна петля');
        return false;
      }
      if (p.radio) {
        const keep = typeof excludeDev === 'function' ? (l) => excludeDev(this.devices.get(l.b.dev)) : (l) => l.b.dev !== excludeDev;
        let targets = [...(p.wlinks || [])].map((id) => this.links.get(id)).filter((l) => l && keep(l));
        if (!U.isMulticastMac(frame.dst)) {
          const t = targets.find((l) => {
            const cd = this.devices.get(l.b.dev);
            return cd && cd.ports[l.b.port].mac === frame.dst;
          });
          if (t) targets = [t];
        }
        let sent = false;
        for (const l of targets) {
          const cd = this.devices.get(l.b.dev);
          if (cd && this.isPortOperational(cd, l.b.port)) sent = this._launch(dev, portIdx, l, cd, l.b.port, frame, hops, why) || sent;
        }
        return sent;
      }
      const pr = this.peer(dev, portIdx);
      return this._launch(dev, portIdx, pr.link, pr.dev, pr.port, frame, hops, why);
    }

    _launch(dev, portIdx, link, toDev, toPort, frame, hops, why) {
      if (this.inFlight.size >= MAX_IN_FLIGHT) {
        if (this.stormUntil < this.time) {
          this.emit('warn', { dev: null, text: 'Обнаружен широковещательный шторм (петля из концентраторов?). Лишние кадры отброшены.' });
        }
        this.stormUntil = this.time + 50;
        return false;
      }
      const f = U.clone(frame);
      f.hops = hops;
      const bytes = P.sizeOf(f);
      const sp = dev.ports[portIdx];
      sp.txPkts = (sp.txPkts || 0) + 1;
      sp.txBytes = (sp.txBytes || 0) + bytes;
      const ev = this.schedule({ kind: 'frame', time: this.time + LINK_DELAY, start: this.time, link: link.id, from: dev.id, fromPort: portIdx, to: toDev.id, port: toPort, frame: f });
      this.inFlight.set(ev.seq, ev);
      if (this.activity.length < 2000) this.activity.push(link.id);
      if (this.recording) {
        this.addLog({ type: 'tx', from: dev.id, fromPort: portIdx, to: toDev.id, toPort, link: link.id, frame: f, proto: P.classify(f), why: why || '', evSeq: ev.seq });
      }
      return true;
    }

    _purgeHead() {
      while (this.queue.size) {
        const ev = this.queue.peek();
        if (ev.kind !== 'timer') return;
        if (ev.cancelled) { this.queue.pop(); continue; }
        if (ev.dev) {
          const d = this.devices.get(ev.dev);
          if (!d || d.epoch !== ev.epoch) { this.queue.pop(); continue; }
        }
        return;
      }
    }

    hasPending() { this._purgeHead(); return this.queue.size > 0; }

    nextEventTime() { this._purgeHead(); return this.queue.size ? this.queue.peek().time : null; }

    /** Обработать все события следующего момента времени. Возвращает время или null. */
    step() {
      this._purgeHead();
      if (!this.queue.size) return null;
      const t = this.queue.peek().time;
      if (t > this.time) this.time = t;
      let n = 0;
      while (this.queue.size && this.queue.peek().time <= this.time) {
        this._dispatch(this.queue.pop());
        if (++n > 500000) {
          this.emit('warn', { dev: null, text: 'Слишком много событий за один шаг — симуляция приостановлена.' });
          break;
        }
      }
      return this.time;
    }

    /** Обработать события до момента t включительно и перевести часы. */
    advanceTo(t) {
      for (;;) {
        const nt = this.nextEventTime();
        if (nt === null || nt > t) break;
        this.step();
      }
      if (t > this.time) this.time = t;
    }

    /** Для тестов: крутить, пока есть события (не дольше maxTicks). */
    runUntilIdle(maxTicks) {
      const end = this.time + (maxTicks || 100000);
      for (;;) {
        const nt = this.nextEventTime();
        if (nt === null || nt > end) break;
        this.step();
      }
    }

    run(ticks) { this.advanceTo(this.time + ticks); }

    _dispatch(ev) {
      if (ev.kind === 'frame') {
        this.inFlight.delete(ev.seq);
        const link = this.links.get(ev.link);
        const dev = this.devices.get(ev.to);
        if (!link || !dev) {
          this.logDrop(null, ev.frame, 'Кабель отключён во время передачи');
          return;
        }
        if (!this.isPortOperational(dev, ev.port)) {
          this.logDrop(dev, ev.frame, 'Порт отключён');
          return;
        }
        const rp = dev.ports[ev.port];
        rp.rxPkts = (rp.rxPkts || 0) + 1;
        rp.rxBytes = (rp.rxBytes || 0) + P.sizeOf(ev.frame);
        try { dev.receive(ev.port, ev.frame); } catch (e) { console.error(e); this.emit('error', e); }
      } else if (ev.kind === 'timer') {
        if (ev.cancelled) return;
        if (ev.dev) {
          const d = this.devices.get(ev.dev);
          if (!d || d.epoch !== ev.epoch) return;
        }
        try { ev.fn(); } catch (e) { console.error(e); this.emit('error', e); }
      }
    }

    /** Сбросить всё, что «в пути», и журнал (кнопка «Сброс» в режиме симуляции). */
    resetSimulation() {
      for (const d of this.devices.values()) d.reset();
      this.queue.clear();
      this.inFlight.clear();
      this.log = [];
      this.emit('log-reset');
      this.refreshTopology();
    }

    /* ---------- журнал ---------- */

    addLog(entry) {
      entry.n = ++this.logSeq;
      entry.time = this.time;
      this.log.push(entry);
      if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
      this.emit('log', entry);
    }

    logDrop(dev, frame, reason) {
      if (!this.recording) return;
      this.addLog({ type: 'drop', dev: dev ? dev.id : null, frame: frame ? U.clone(frame) : null, proto: P.classify(frame), reason });
    }

    logNote(dev, text, frame, kind) {
      if (!this.recording) return;
      this.addLog({ type: kind || 'info', dev: dev ? dev.id : null, frame: frame ? U.clone(frame) : null, proto: frame ? P.classify(frame) : 'OTHER', reason: text });
    }

    /* ---------- заметки и фигуры на схеме ---------- */

    addNote(x, y, text) {
      const n = { id: 'n' + this.counters.note++, x, y, text: text || 'Заметка' };
      this.notes.push(n);
      return n;
    }

    removeNote(id) { this.notes = this.notes.filter((n) => n.id !== id); }

    addShape(kind, x, y, w, h, color) {
      const s = { id: 's' + this.counters.shape++, kind: kind === 'ellipse' ? 'ellipse' : 'rect', x, y, w: Math.max(10, w), h: Math.max(10, h), color: color || '#3b82f6' };
      this.shapes.push(s);
      return s;
    }

    removeShape(id) { this.shapes = this.shapes.filter((s) => s.id !== id); }

    /* ---------- сохранение ---------- */

    serialize() {
      const links = [];
      for (const l of this.links.values()) {
        if (l.wireless) continue;
        const a = this.devices.get(l.a.dev);
        const b = this.devices.get(l.b.dev);
        links.push({
          id: l.id,
          a: { dev: l.a.dev, port: l.a.port, name: a ? a.ports[l.a.port].name : '' },
          b: { dev: l.b.dev, port: l.b.port, name: b ? b.ports[l.b.port].name : '' },
          cable: l.cable,
          dce: l.dce || null,
        });
      }
      return {
        format: 'netlab',
        version: 2,
        counters: Object.assign({}, this.counters),
        devices: [...this.devices.values()].map((d) => d.serialize()),
        links,
        notes: this.notes.map((n) => Object.assign({}, n)),
        shapes: this.shapes.map((s) => Object.assign({}, s)),
        ...Object.fromEntries(NS.netExt.map((e) => [e.key, e.save(this)]).filter(([, v]) => v != null)),
      };
    }

    static deserialize(data) {
      if (!data || data.format !== 'netlab') throw new Error('Это не файл NetLab');
      if (data.version > 2) throw new Error('Файл создан более новой версией NetLab');
      const legacy = !data.version || data.version < 2;
      const net = new Network();
      const maxNum = (arr, prefix) => arr.reduce((m, x) => {
        const n = parseInt(String(x.id).slice(prefix.length), 10);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0);
      for (const d of data.devices || []) {
        const Cls = NS.deviceTypes[d.type];
        if (!Cls) throw new Error('Неизвестный тип устройства в файле: ' + d.type);
        const model = d.model && NS.models.MODELS[d.model] ? d.model : NS.models.LEGACY_MODEL[d.type];
        const dev = new Cls(net, d.id, d.name, model);
        dev.load(d);
        net.devices.set(d.id, dev);
      }
      for (const l of data.links || []) {
        const a = net.devices.get(l.a.dev);
        const b = net.devices.get(l.b.dev);
        if (!a || !b) continue;
        const ia = l.a.name && a.portIndex(l.a.name) >= 0 ? a.portIndex(l.a.name) : l.a.port;
        const ib = l.b.name && b.portIndex(l.b.name) >= 0 ? b.portIndex(l.b.name) : l.b.port;
        if (!a.ports[ia] || !b.ports[ib]) continue;
        const cable = l.cable && CABLES[l.cable] ? l.cable : Network.resolveCable(a.ports[ia], b.ports[ib]);
        net._addLink({ id: l.id, a: { dev: l.a.dev, port: ia }, b: { dev: l.b.dev, port: ib }, cable, dce: l.dce || (cable === 'serial' ? l.a.dev : null) });
      }
      net.notes = (data.notes || []).map((n) => ({ id: n.id, x: n.x, y: n.y, text: String(n.text || '') }));
      net.shapes = (data.shapes || []).map((s) => ({ id: s.id, kind: s.kind === 'ellipse' ? 'ellipse' : 'rect', x: +s.x || 0, y: +s.y || 0, w: +s.w || 50, h: +s.h || 50, color: String(s.color || '#3b82f6') }));
      for (const e of NS.netExt) e.load(net, data[e.key]);
      const c = Object.assign({}, net.counters, data.counters || {});
      c.id = Math.max(c.id, maxNum(data.devices || [], 'd') + 1);
      c.link = Math.max(c.link, maxNum(data.links || [], 'l') + 1);
      c.note = Math.max(c.note, maxNum(data.notes || [], 'n') + 1);
      c.shape = Math.max(c.shape || 1, maxNum(data.shapes || [], 's') + 1);
      net.counters = c;
      // В файлах первой версии не было NVRAM: считаем текущую конфигурацию сохранённой.
      if (legacy) for (const d of net.devices.values()) if (d.saveNvram) d.saveNvram();
      net.refreshTopology();
      return net;
    }
  }

  Network.LINK_DELAY = LINK_DELAY;
  Network.WIFI_RANGE = WIFI_RANGE;
  Network.CELL_RANGE = CELL_RANGE;

  /** Беспроводные сети точки доступа: одна (wifi) или несколько (WLAN контроллера). */
  function wlansOf(ap) { return ap.wlans ? ap.wlans() : [ap.wifi]; }
  Network.wlansOf = wlansOf;
  Network.CABLES = CABLES;
  Network.isData = isData;
  Network.portFits = portFits;
  Network.pairFits = pairFits;
  NS.Network = Network;
})(globalThis.NetLab = globalThis.NetLab || {});
