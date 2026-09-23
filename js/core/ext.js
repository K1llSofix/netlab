/* NetLab — общая часть расширений: настройки новых подсистем (IPv6, SNMP, NetFlow, VPN, PPPoE,
 * VoIP, Bluetooth, IoT…) сохраняются вместе с конфигурацией устройства — в файле схемы и в NVRAM. */
(function (NS) {
  'use strict';

  /**
   * Регистрация: NS.deviceExt.push({ key, applies(dev), save(dev) → данные|null, load(dev, данные) }).
   * save вызывается при сохранении схемы и при copy running-config startup-config,
   * load — при открытии схемы, включении питания (startup-config) и отмене действий.
   */
  NS.deviceExt = NS.deviceExt || [];

  function wrap(Cls) {
    if (!Cls || Cls.prototype.__extWrapped) return;
    const ser = Cls.prototype.serializeConfig;
    const load = Cls.prototype.loadConfig;
    Cls.prototype.serializeConfig = function () {
      const c = ser.call(this);
      for (const e of NS.deviceExt) {
        if (e.applies && !e.applies(this)) continue;
        const v = e.save(this);
        if (v !== undefined && v !== null) c[e.key] = v;
      }
      return c;
    };
    Cls.prototype.loadConfig = function (c) {
      load.call(this, c);
      for (const e of NS.deviceExt) {
        if (e.applies && !e.applies(this)) continue;
        e.load(this, c ? c[e.key] : undefined);
      }
    };
    Cls.prototype.__extWrapped = true;
  }

  // WirelessRouter наследует Switch и вызывает super — достаточно обернуть базовые классы.
  wrap(NS.Host);
  wrap(NS.Router);
  wrap(NS.Switch);
})(globalThis.NetLab = globalThis.NetLab || {});
