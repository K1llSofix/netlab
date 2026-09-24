/* NetLab — физические расстояния: масштаб схемы (метров в единице), предельная длина кабелей
 * (медь — 100 м, оптика — 2 км, коаксиал — 500 м, DSL — 5 км…), дальность Wi-Fi и вышки 3G/4G в метрах.
 * Выключено по умолчанию: тогда длина кабелей не проверяется, а дальности — прежние. */
(function (NS) {
  'use strict';

  const Network = NS.Network;

  const MAX_LEN = { straight: 100, cross: 100, fiber: 2000, serial: 15, phone: 5000, coaxial: 500, iot: 20, console: 15 };
  const CABLE_NAME = { straight: 'медного кабеля', cross: 'медного кабеля', fiber: 'оптического кабеля', serial: 'кабеля Serial', phone: 'телефонной линии', coaxial: 'коаксиального кабеля', iot: 'IoT-кабеля', console: 'консольного кабеля' };
  const DEFAULTS = { enabled: false, scale: 0.25, wifi: 100, cell: 2000 };

  function cfg(net) {
    if (!net.physical) net.physical = Object.assign({}, DEFAULTS);
    return net.physical;
  }

  /** Длина кабеля в метрах (по расстоянию между устройствами на схеме). */
  function linkLength(net, l) {
    const a = net.devices.get(l.a.dev);
    const b = net.devices.get(l.b.dev);
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y) * cfg(net).scale;
  }

  const issue = Network.prototype.linkIssue;
  Network.prototype.linkIssue = function (l) {
    const base = issue.call(this, l);
    if (base || l.wireless) return base;
    const c = this.physical;
    if (!c || !c.enabled) return null;
    const max = MAX_LEN[l.cable];
    if (!max) return null;
    const len = linkLength(this, l);
    if (len > max) return 'Кабель слишком длинный: ' + Math.round(len) + ' м — предел для ' + (CABLE_NAME[l.cable] || 'кабеля') + ' ' + max + ' м';
    return null;
  };

  const wifi = Network.prototype.wifiRange;
  Network.prototype.wifiRange = function () {
    const c = this.physical;
    return c && c.enabled ? c.wifi / c.scale : wifi.call(this);
  };
  const cell = Network.prototype.cellRange;
  Network.prototype.cellRange = function () {
    const c = this.physical;
    return c && c.enabled ? c.cell / c.scale : cell.call(this);
  };

  /** Изменить настройки (enabled, scale — метров в единице схемы, wifi и cell — дальность в метрах). */
  function setPhysical(net, v) {
    const c = cfg(net);
    if (v.scale !== undefined && !(v.scale > 0 && v.scale <= 100)) throw new Error('Масштаб: от 0,01 до 100 м в единице схемы');
    if (v.wifi !== undefined && !(v.wifi >= 5 && v.wifi <= 1000)) throw new Error('Дальность Wi-Fi: 5–1000 м');
    if (v.cell !== undefined && !(v.cell >= 100 && v.cell <= 50000)) throw new Error('Дальность вышки: 100–50 000 м');
    Object.assign(c, v);
    net.refreshTopology();
  }

  NS.netExt.push({
    key: 'physical',
    init(net) { net.physical = null; },
    save(net) {
      const c = net.physical;
      if (!c || (!c.enabled && c.scale === DEFAULTS.scale && c.wifi === DEFAULTS.wifi && c.cell === DEFAULTS.cell)) return null;
      return Object.assign({}, c);
    },
    load(net, d) {
      net.physical = d ? Object.assign({}, DEFAULTS, { enabled: !!d.enabled, scale: Number(d.scale) || DEFAULTS.scale, wifi: Number(d.wifi) || DEFAULTS.wifi, cell: Number(d.cell) || DEFAULTS.cell }) : null;
    },
  });

  NS.physical = { cfg, linkLength, setPhysical, MAX_LEN, DEFAULTS };
})(globalThis.NetLab = globalThis.NetLab || {});
