/* NetLab — физическое пространство, как Physical Workspace в Packet Tracer:
 *  междугородняя карта → города → здания → монтажные шкафы. У каждого устройства — место и координаты в метрах;
 *  когда пространство включено, длина кабелей, дальность Wi-Fi, вышек 3G/4G и Bluetooth считаются по нему
 *  (медь — до 100 м, так что два здания соединяют оптикой). Устройства без явного места стоят в месте
 *  «по умолчанию» (сначала — основной шкаф). */
(function (NS) {
  'use strict';

  const Network = NS.Network;
  const ROOT = 'root';

  /** Виды мест: размер в метрах (для раскладки и ограничения координат) и что внутри. */
  const KINDS = {
    root: { title: 'Междугородняя карта', w: 100000, h: 60000, child: 'city' },
    city: { title: 'Город', w: 8000, h: 5000, child: 'building' },
    building: { title: 'Здание', w: 120, h: 70, child: 'closet' },
    closet: { title: 'Шкаф', w: 6, h: 4, child: null },
  };

  const DEFAULT_LIST = [
    { id: 'c1', kind: 'city', name: 'Город', parent: ROOT, x: 30000, y: 25000 },
    { id: 'b1', kind: 'building', name: 'Офис', parent: 'c1', x: 3000, y: 2000 },
    { id: 'k1', kind: 'closet', name: 'Основной шкаф', parent: 'b1', x: 20, y: 15 },
  ];

  function defaults() {
    return { on: false, home: 'k1', next: 2, list: DEFAULT_LIST.map((p) => Object.assign({}, p)), pos: {} };
  }

  const cfg = (net) => net.places || (net.places = defaults());
  const on = (net) => !!(net.places && net.places.on);
  const ROOT_PLACE = { id: ROOT, kind: 'root', name: KINDS.root.title, parent: null, x: 0, y: 0 };
  const get = (net, id) => (id === ROOT ? ROOT_PLACE : cfg(net).list.find((p) => p.id === id) || null);
  const children = (net, id) => cfg(net).list.filter((p) => p.parent === id);

  /** Цепочка от карты до места (для «хлебных крошек»). */
  function path(net, id) {
    const out = [];
    let p = get(net, id);
    for (let guard = 0; p && guard < 10; guard++) { out.unshift(p); p = p.parent ? get(net, p.parent) : null; }
    return out;
  }

  function absPlace(net, id) {
    let x = 0;
    let y = 0;
    for (const p of path(net, id)) { x += p.x; y += p.y; }
    return { x, y };
  }

  function homeId(net) {
    const c = cfg(net);
    if (get(net, c.home)) return c.home;
    const k = c.list.find((p) => p.kind === 'closet') || c.list[c.list.length - 1];
    return k ? k.id : ROOT;
  }

  /** Место и координаты устройства (м). auto — устройство не размещали явно. */
  function devPos(net, dev) {
    const p = cfg(net).pos[dev.id];
    if (p && get(net, p.place)) return { place: p.place, x: p.x, y: p.y, auto: false };
    const home = homeId(net);
    const k = KINDS[get(net, home).kind];
    const fx = ((((dev.x || 0) % 997) + 997) % 997) / 997;
    const fy = ((((dev.y || 0) % 991) + 991) % 991) / 991;
    return { place: home, x: k.w * (0.1 + 0.8 * fx), y: k.h * (0.1 + 0.8 * fy), auto: true };
  }

  function absPos(net, dev) {
    const p = devPos(net, dev);
    const b = absPlace(net, p.place);
    return { x: b.x + p.x, y: b.y + p.y };
  }

  /** Расстояние между устройствами в метрах. */
  function distance(net, a, b) {
    const p = absPos(net, a);
    const q = absPos(net, b);
    return Math.hypot(p.x - q.x, p.y - q.y);
  }

  /** Как устройство видно на уровне levelId: { dev } — стоит здесь, { place } — внутри дочернего места, null — снаружи. */
  function visibleAt(net, dev, levelId) {
    const pid = devPos(net, dev).place;
    if (pid === levelId) return { dev };
    const pth = path(net, pid);
    const i = pth.findIndex((p) => p.id === levelId);
    if (i < 0 || i + 1 >= pth.length) return null;
    return { place: pth[i + 1] };
  }

  /** Все устройства внутри места (включая вложенные). */
  function devicesIn(net, id, direct) {
    const out = [];
    for (const d of net.devices.values()) {
      const pid = devPos(net, d).place;
      if (direct ? pid === id : path(net, pid).some((p) => p.id === id)) out.push(d);
    }
    return out;
  }

  const clamp = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));

  function add(net, parent, name, x, y) {
    const c = cfg(net);
    const par = get(net, parent);
    if (!par) throw new Error('Место не найдено');
    const kind = KINDS[par.kind].child;
    if (!kind) throw new Error('В шкафу можно размещать только устройства');
    const K = KINDS[par.kind];
    const n = children(net, parent).length;
    const title = String(name || '').trim() || KINDS[kind].title + ' ' + (n + 1);
    const p = { id: 'p' + c.next++, kind, name: title.slice(0, 40), parent: par.id,
      x: x != null ? clamp(x, K.w) : K.w * (0.15 + 0.17 * (n % 5)), y: y != null ? clamp(y, K.h) : K.h * (0.3 + 0.3 * (Math.floor(n / 5) % 3)) };
    c.list.push(p);
    return p;
  }

  function remove(net, id) {
    const c = cfg(net);
    const p = get(net, id);
    if (!p || id === ROOT) throw new Error('Место не найдено');
    if (children(net, id).length) throw new Error('Внутри «' + p.name + '» есть другие места — сначала удалите их');
    const devs = devicesIn(net, id);
    if (devs.length) throw new Error('В «' + p.name + '» стоят устройства (' + devs.slice(0, 3).map((d) => d.name).join(', ') + (devs.length > 3 ? '…' : '') + ') — сначала перенесите их');
    c.list = c.list.filter((x) => x !== p);
    if (c.home === id) c.home = homeId(net);
  }

  function rename(net, id, name) {
    const p = get(net, id);
    if (!p || id === ROOT) throw new Error('Место не найдено');
    const n = String(name || '').trim();
    if (!n) throw new Error('Введите название');
    p.name = n.slice(0, 40);
  }

  function movePlace(net, id, x, y) {
    const p = get(net, id);
    if (!p || id === ROOT) throw new Error('Место не найдено');
    const K = KINDS[get(net, p.parent).kind];
    p.x = clamp(x, K.w);
    p.y = clamp(y, K.h);
    net.refreshTopology();
  }

  /** Поставить устройство в место (координаты в метрах внутри места). */
  function setDevice(net, devId, placeId, x, y) {
    const dev = net.devices.get(devId);
    const p = get(net, placeId);
    if (!dev || !p) throw new Error('Устройство или место не найдено');
    const K = KINDS[p.kind];
    const cur = devPos(net, dev);
    const same = cur.place === placeId;
    cfg(net).pos[devId] = { place: placeId, x: clamp(x != null ? x : same ? cur.x : K.w / 2, K.w), y: clamp(y != null ? y : same ? cur.y : K.h / 2, K.h) };
    net.refreshTopology();
  }

  function setHome(net, id) {
    if (!get(net, id)) throw new Error('Место не найдено');
    cfg(net).home = id;
  }

  function setOn(net, v) {
    cfg(net).on = !!v;
    net.refreshTopology();
  }

  // радиосвязь — по физическим координатам
  const baseDist = Network.prototype.devDistance;
  Network.prototype.devDistance = function (a, b) { return on(this) ? distance(this, a, b) : baseDist.call(this, a, b); };

  NS.netExt.push({
    key: 'places',
    init(net) { net.places = null; },
    save(net) {
      const c = net.places;
      if (!c) return null;
      const pos = {};
      for (const [k, v] of Object.entries(c.pos)) if (net.devices.has(k) && get(net, v.place)) pos[k] = { place: v.place, x: +v.x.toFixed(2), y: +v.y.toFixed(2) };
      const changed = c.on || Object.keys(pos).length || c.home !== 'k1' || JSON.stringify(c.list) !== JSON.stringify(DEFAULT_LIST);
      return changed ? { on: c.on, home: c.home, next: c.next, list: c.list.map((p) => Object.assign({}, p)), pos } : null;
    },
    load(net, d) {
      if (!d || !Array.isArray(d.list)) { net.places = null; return; }
      const list = d.list.filter((p) => p && KINDS[p.kind] && p.kind !== 'root').map((p) => ({ id: String(p.id), kind: p.kind, name: String(p.name || KINDS[p.kind].title).slice(0, 40), parent: String(p.parent || ROOT), x: Number(p.x) || 0, y: Number(p.y) || 0 }));
      const pos = {};
      for (const [k, v] of Object.entries(d.pos || {})) if (v && v.place) pos[k] = { place: String(v.place), x: Number(v.x) || 0, y: Number(v.y) || 0 };
      net.places = { on: !!d.on, home: String(d.home || 'k1'), next: Math.max(Number(d.next) || 2, list.length + 2), list, pos };
    },
  });

  NS.places = { ROOT, KINDS, cfg, on, get, children, path, absPlace, devPos, absPos, distance, visibleAt, devicesIn, homeId, add, remove, rename, movePlace, setDevice, setHome, setOn };
})(globalThis.NetLab = globalThis.NetLab || {});
