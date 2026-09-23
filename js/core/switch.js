/* NetLab — коммутатор Cisco (2960 — 2-го уровня, 3560 — 3-го уровня).
 * VLAN, trunk 802.1Q, таблица MAC, STP, port-security (sticky, err-disabled),
 * SVI (interface vlan N) для управления, ip default-gateway,
 * на 3560 — ip routing, маршрутизация между VLAN и routed-порты (no switchport). */
(function (NS) {
  'use strict';

  const U = NS.util;

  const MAC_AGING = 30000;

  class Switch extends NS.IpNode {
    constructor(net, id, name, model, type) {
      super(net, id, type || 'switch', name, model);
      this.baseMac = net.allocMac();
      this.l3 = !!this.spec.l3;
      this.ipRouting = false;
      this.forwarding = false;
      this.defaultGateway = null;
      this.defaultTtl = 255;
      this.stpPriority = 32768;
      this.vlans = new Map([[1, 'default']]);
      this.macTable = new Map();
      this.stpInfo = null;
      this.rip = { networks: [], version: 1, autoSummary: true, passive: [], defaultOriginate: false };
      this.ospf = null;
      this.iosInit();
      this.syncIfaces();
      this.bindServices();
    }

    initPort(p) {
      if (!NS.Network.isData(p)) return;
      p.mode = 'access';
      p.vlan = 1;
      p.nativeVlan = 1;
      p.allowed = 'all';
      p.routed = false;
      p.ps = { enabled: false, max: 1, sticky: false, violation: 'shutdown', macs: [], violations: 0, lastMac: null };
      p.errDisabled = false;
    }

    bindServices() {
      super.bindServices();
      if (NS.bindIosServices) NS.bindIosServices(this);
    }

    /** SVI Vlan1 есть всегда; для routed-портов — свои интерфейсы. */
    syncIfaces() {
      if (!this.ifaces) return;
      if (!this.ifaces.some((f) => f.kind === 'svi' && f.vlan === 1)) {
        const f = this.addIface(-1, 'Vlan1', 1, 'svi');
        f.adminUp = false;
      }
      this.ports.forEach((p, i) => {
        const has = this.ifaces.find((f) => f.kind === 'routed' && f.port === i);
        if (p.routed && !has) this.addIface(i, p.name, null, 'routed');
      });
      this.ifaces = this.ifaces.filter((f) => f.kind !== 'routed' || (this.ports[f.port] && this.ports[f.port].routed));
    }

    /* ---------- интерфейсы 3-го уровня ---------- */

    portCarries(p, vlan) {
      if (p.routed || !NS.Network.isData(p)) return false;
      return p.mode === 'trunk' ? U.vlanInList(p.allowed, vlan) : p.vlan === vlan;
    }

    ifaceUp(f) {
      if (f && f.kind === 'svi') {
        if (!f.adminUp || !this.power || !this.vlans.has(f.vlan)) return false;
        return this.ports.some((p) => p.oper && p.stp !== 'blocking' && this.portCarries(p, f.vlan));
      }
      return super.ifaceUp(f);
    }

    ifaceMac(f) { return f.kind === 'svi' ? this.baseMac : super.ifaceMac(f); }

    ifaceSend(f, frame, why) {
      if (f.kind !== 'svi') return super.ifaceSend(f, frame, why);
      const vlan = f.vlan;
      const fr = Object.assign({}, frame, { vlan: null });
      if (!U.isMulticastMac(fr.dst)) {
        const e = this.macTable.get(vlan + '|' + fr.dst);
        if (e && this.egress(e.port, vlan, fr, why || 'Кадр от самого коммутатора (' + f.name + ')')) return true;
      }
      return this.flood(-1, vlan, fr, why || 'Кадр от самого коммутатора (' + f.name + ') во все порты VLAN ' + vlan);
    }

    addSvi(vlan) {
      vlan = Number(vlan);
      if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw new Error('Номер VLAN: 1–4094');
      let f = this.ifaces.find((x) => x.kind === 'svi' && x.vlan === vlan);
      if (!f) {
        if (!this.l3 && this.ifaces.some((x) => x.kind === 'svi' && x.ip != null && x.vlan !== vlan)) {
          // 2960 допускает несколько SVI, но активным для управления обычно делают один — ограничений не вводим
        }
        f = this.addIface(-1, 'Vlan' + vlan, vlan, 'svi');
        f.adminUp = true;
      }
      this.net.markRouting();
      return f;
    }

    removeSvi(vlan) {
      if (vlan === 1) throw new Error('Интерфейс Vlan1 удалить нельзя');
      const f = this.ifaces.find((x) => x.kind === 'svi' && x.vlan === vlan);
      if (f) {
        this.flushIface(f, 'down');
        this.ifaces = this.ifaces.filter((x) => x !== f);
        this.net.markRouting();
      }
    }

    setIpRouting(on) {
      if (on && !this.l3) throw new Error('Коммутатор ' + this.model + ' работает только на 2-м уровне — нужен 3560');
      this.ipRouting = !!on;
      this.forwarding = !!on;
      this.net.markRouting();
    }

    /** no switchport — порт становится маршрутизируемым (только 3560). */
    setPortRouted(i, on) {
      const p = this.ports[i];
      if (on && !this.l3) throw new Error('Команда no switchport доступна только на коммутаторе 3-го уровня (3560)');
      if (!NS.Network.isData(p)) throw new Error('Это не сетевой порт');
      p.routed = !!on;
      for (const [k, e] of this.macTable) if (e.port === i) this.macTable.delete(k);
      this.syncIfaces();
      this.net.refreshTopology();
    }

    staticRoutes() {
      const r = super.staticRoutes();
      if (!this.ipRouting && this.defaultGateway != null) r.push({ net: 0, mask: 0, nextHop: this.defaultGateway, gateway: true });
      return r;
    }

    /* ---------- настройка портов и VLAN (общая для GUI и CLI) ---------- */

    ensureVlan(v) {
      if (!this.vlans.has(v)) this.vlans.set(v, 'VLAN' + String(v).padStart(4, '0'));
    }

    addVlan(v, name) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 4094) throw new Error('Номер VLAN должен быть от 1 до 4094');
      const n = String(name || '').trim() || (this.vlans.get(v) || 'VLAN' + String(v).padStart(4, '0'));
      if (!/^[\p{L}\p{N}_.-]{1,32}$/u.test(n)) throw new Error('Имя VLAN: буквы, цифры, «-», «_», «.»');
      this.vlans.set(v, n);
      this.net.markRouting();
    }

    removeVlan(v) {
      if (v === 1) throw new Error('VLAN 1 удалить нельзя');
      this.vlans.delete(v);
      this.flushMacTable();
      this.net.markRouting();
    }

    dataPort(i) {
      const p = this.ports[i];
      if (!p || !NS.Network.isData(p)) throw new Error('Это не сетевой порт');
      if (p.routed) throw new Error('Порт ' + p.name + ' маршрутизируемый (no switchport) — сначала введите switchport');
      return p;
    }

    setPortMode(i, mode) {
      if (mode !== 'access' && mode !== 'trunk') throw new Error('Режим порта: access или trunk');
      const p = this.dataPort(i);
      if (mode === 'trunk' && p.ps.enabled) throw new Error('На порту включён port-security — транк невозможен');
      p.mode = mode;
      this.flushMacTable();
      this.net.markRouting();
    }

    setAccessVlan(i, v) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 4094) throw new Error('Номер VLAN должен быть от 1 до 4094');
      const p = this.dataPort(i);
      this.ensureVlan(v);
      p.vlan = v;
      this.flushMacTable();
      this.net.markRouting();
    }

    setNativeVlan(i, v) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 4094) throw new Error('Номер VLAN должен быть от 1 до 4094');
      const p = this.dataPort(i);
      this.ensureVlan(v);
      p.nativeVlan = v;
      this.flushMacTable();
      this.net.markRouting();
    }

    setAllowedVlans(i, list) {
      const s = String(list || '').trim() || 'all';
      U.parseVlanList(s);
      this.dataPort(i).allowed = s.toLowerCase();
      this.flushMacTable();
      this.net.markRouting();
    }

    setPortAdmin(i, up) {
      const p = this.ports[i];
      p.adminUp = !!up;
      if (up) p.errDisabled = false;
      const f = this.ifaces.find((x) => x.kind === 'routed' && x.port === i);
      if (f) f.adminUp = !!up;
      this.net.refreshTopology();
    }

    setStpPriority(v) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 0 || v > 61440 || v % 4096 !== 0) throw new Error('Приоритет STP: 0–61440, кратно 4096');
      this.stpPriority = v;
    }

    /** Настройка port-security. cfg: {enabled, max, sticky, violation}. */
    setPortSecurity(i, cfg) {
      const p = this.dataPort(i);
      if (cfg.enabled && p.mode !== 'access') throw new Error('Command rejected: ' + p.name + ' is a dynamic port. (port-security работает только на access-порту — введите switchport mode access)');
      if (cfg.max !== undefined && !(cfg.max >= 1 && cfg.max <= 132)) throw new Error('Максимум адресов: 1–132');
      if (cfg.violation !== undefined && !['shutdown', 'restrict', 'protect'].includes(cfg.violation)) throw new Error('violation: shutdown, restrict или protect');
      Object.assign(p.ps, cfg);
      if (cfg.sticky === true) for (const m of p.ps.macs) m.sticky = true;
      if (cfg.sticky === false) p.ps.macs = p.ps.macs.filter((m) => !m.sticky);
      if (cfg.enabled === false) { p.ps.macs = p.ps.macs.filter((m) => m.sticky); p.ps.violations = 0; }
      while (p.ps.macs.length > p.ps.max) p.ps.macs.pop();
    }

    addSecureMac(i, mac, sticky) {
      const p = this.dataPort(i);
      const m = String(mac).toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m)) throw new Error('Неверный MAC-адрес');
      if (!p.ps.macs.some((x) => x.mac === m)) {
        if (p.ps.macs.length >= p.ps.max) throw new Error('Превышено максимальное число адресов на порту');
        p.ps.macs.push({ mac: m, sticky: !!sticky, manual: !sticky });
      }
    }

    /* ---------- работа ---------- */

    flushMacTable() { this.macTable.clear(); }

    reset() {
      super.reset();
      this.macTable.clear();
      for (const p of this.ports) if (p.ps) p.ps.macs = p.ps.macs.filter((m) => m.sticky || m.manual);
    }

    onLinkChange(i, up) {
      super.onLinkChange(i, up);
      if (!up) {
        for (const [k, e] of this.macTable) if (e.port === i) this.macTable.delete(k);
        const p = this.ports[i];
        if (p.ps) p.ps.macs = p.ps.macs.filter((m) => m.sticky || m.manual);
      }
    }

    macEntries() {
      const now = this.net.time;
      const out = [];
      for (const e of this.macTable.values()) if (now - e.time <= MAC_AGING) out.push(e);
      out.sort((a, b) => a.vlan - b.vlan || a.port - b.port || (a.mac < b.mac ? -1 : 1));
      return out;
    }

    receive(i, frame) {
      const port = this.ports[i];
      if (port.routed) { super.receive(i, frame); return; }
      if (port.stp === 'blocking') {
        this.drop(frame, 'Порт ' + port.name + ' заблокирован STP (защита от петли)');
        return;
      }
      let vlan;
      if (port.mode === 'trunk') {
        vlan = frame.vlan != null ? frame.vlan : port.nativeVlan;
        if (!U.vlanInList(port.allowed, vlan)) {
          this.drop(frame, 'VLAN ' + vlan + ' не разрешён на транке ' + port.name);
          return;
        }
      } else {
        if (frame.vlan != null) {
          this.drop(frame, 'Кадр с тегом 802.1Q пришёл на access-порт ' + port.name);
          return;
        }
        vlan = port.vlan;
      }
      if (!this.vlans.has(vlan)) {
        this.drop(frame, 'VLAN ' + vlan + ' не создан на ' + this.name);
        return;
      }
      if (port.mode === 'access' && port.ps && port.ps.enabled && !this.portSecurityOk(i, port, frame)) return;

      if (!U.isMulticastMac(frame.src)) {
        this.macTable.set(vlan + '|' + frame.src, { mac: frame.src, vlan, port: i, time: this.net.time });
      }

      const dst = frame.dst;
      const svi = this.ifaces.find((f) => f.kind === 'svi' && f.vlan === vlan);
      if (svi && svi.adminUp) {
        if (dst === this.baseMac) {
          this.ipIngress(svi, Object.assign({}, frame, { vlan: null }));
          return;
        }
        if (U.isMulticastMac(dst)) this.ipIngress(svi, Object.assign({}, frame, { vlan: null }));
      }

      if (U.isMulticastMac(dst)) {
        this.flood(i, vlan, frame, 'Широковещательный кадр — рассылка во все порты VLAN ' + vlan);
        return;
      }
      const key = vlan + '|' + dst;
      let e = this.macTable.get(key);
      if (e && this.net.time - e.time > MAC_AGING) {
        this.macTable.delete(key);
        e = null;
      }
      if (e) {
        if (e.port === i) {
          this.drop(frame, 'Получатель находится за тем же портом — кадр отфильтрован');
          return;
        }
        const out = this.ports[e.port];
        if (this.egress(e.port, vlan, frame, 'MAC ' + dst + ' есть в таблице (VLAN ' + vlan + ') → порт ' + out.name)) return;
        this.macTable.delete(key);
      }
      this.flood(i, vlan, frame, 'MAC ' + dst + ' нет в таблице — рассылка во все порты VLAN ' + vlan);
    }

    portSecurityOk(i, port, frame) {
      const ps = port.ps;
      const src = frame.src;
      if (ps.macs.some((m) => m.mac === src)) return true;
      if (ps.macs.length < ps.max) {
        ps.macs.push({ mac: src, sticky: !!ps.sticky, manual: false });
        return true;
      }
      ps.violations++;
      ps.lastMac = src;
      if (ps.violation === 'protect') {
        this.drop(frame, 'Port-security (protect): неизвестный MAC ' + src + ' на ' + port.name + ' — кадр отброшен');
        return false;
      }
      if (ps.violation === 'restrict') {
        this.drop(frame, 'Port-security (restrict): неизвестный MAC ' + src + ' на ' + port.name + ' — кадр отброшен, счётчик нарушений ' + ps.violations);
        return false;
      }
      port.errDisabled = true;
      this.drop(frame, 'Port-security: нарушение на ' + port.name + ' (MAC ' + src + ') — порт переведён в err-disabled');
      this.net.emit('warn', { dev: this, text: this.name + ' ' + port.name + ': нарушение port-security — порт выключен (err-disabled). Включите его командами shutdown / no shutdown.' });
      this.timer(0, () => this.net.refreshTopology());
      return false;
    }

    egress(j, vlan, frame, why) {
      const p = this.ports[j];
      if (!p.oper || p.stp === 'blocking' || p.routed) return false;
      let tag;
      if (p.mode === 'trunk') {
        if (!U.vlanInList(p.allowed, vlan)) return false;
        tag = vlan === p.nativeVlan ? null : vlan;
      } else {
        if (p.vlan !== vlan) return false;
        tag = null;
      }
      return this.send(j, Object.assign({}, frame, { vlan: tag }), why);
    }

    flood(i, vlan, frame, why) {
      let n = 0;
      for (let j = 0; j < this.ports.length; j++) {
        if (j !== i && this.egress(j, vlan, frame, why)) n++;
      }
      if (n === 0 && i >= 0) this.drop(frame, 'В VLAN ' + vlan + ' нет других активных портов');
      return n > 0;
    }

    /* ---------- сохранение ---------- */

    serialize() {
      const o = super.serialize();
      o.baseMac = this.baseMac;
      return o;
    }

    serializePort(p) {
      const o = super.serializePort(p);
      if (!NS.Network.isData(p)) return o;
      Object.assign(o, { mode: p.mode, vlan: p.vlan, nativeVlan: p.nativeVlan, allowed: p.allowed });
      if (p.routed) o.routed = true;
      if (p.ps && (p.ps.enabled || p.ps.macs.some((m) => m.sticky || m.manual))) {
        o.ps = { enabled: p.ps.enabled, max: p.ps.max, sticky: p.ps.sticky, violation: p.ps.violation, macs: p.ps.macs.filter((m) => m.sticky || m.manual).map((m) => Object.assign({}, m)) };
      }
      return o;
    }

    loadPort(p, sp) {
      super.loadPort(p, sp);
      if (!NS.Network.isData(p)) return;
      p.mode = sp.mode === 'trunk' ? 'trunk' : 'access';
      p.vlan = Number(sp.vlan) || 1;
      p.nativeVlan = Number(sp.nativeVlan) || 1;
      p.allowed = typeof sp.allowed === 'string' ? sp.allowed : 'all';
      p.routed = !!sp.routed && this.l3;
      p.ps = { enabled: false, max: 1, sticky: false, violation: 'shutdown', macs: [], violations: 0, lastMac: null };
      if (sp.ps) {
        Object.assign(p.ps, { enabled: !!sp.ps.enabled, max: Number(sp.ps.max) || 1, sticky: !!sp.ps.sticky, violation: sp.ps.violation || 'shutdown' });
        p.ps.macs = (sp.ps.macs || []).map((m) => ({ mac: String(m.mac), sticky: !!m.sticky, manual: !!m.manual }));
      }
      p.errDisabled = false;
    }

    serializeConfig() {
      return Object.assign({
        stpPriority: this.stpPriority,
        vlans: [...this.vlans.entries()],
        ipRouting: this.ipRouting,
        defaultGateway: this.defaultGateway == null ? null : U.ipStr(this.defaultGateway),
        ifaces: this.serializeIfaces(),
        routes: this.serializeRoutes(),
        acls: this.serializeAcls(),
        nameServer: this.dns == null ? null : U.ipStr(this.dns),
        ios: this.iosSerialize(),
      }, this.serializeRouting());
    }

    loadConfig(c) {
      if (typeof c.baseMac === 'string') this.baseMac = c.baseMac;
      this.stpPriority = Number.isInteger(c.stpPriority) ? c.stpPriority : 32768;
      this.vlans = new Map([[1, 'default']]);
      if (Array.isArray(c.vlans)) for (const [v, n] of c.vlans) if (Number.isInteger(v)) this.vlans.set(v, String(n));
      this.ipRouting = !!c.ipRouting && this.l3;
      this.forwarding = this.ipRouting;
      this.defaultGateway = c.defaultGateway ? U.parseIp(c.defaultGateway) : null;
      this.ifaces = [];
      for (const s of c.ifaces || []) {
        if (s.kind === 'svi') {
          const f = this.addIface(-1, String(s.name), Number(s.vlan), 'svi');
          this.loadIface(f, s);
        } else if (s.kind === 'routed') {
          const i = this.savedPort(s);
          if (i >= 0 && this.ports[i].routed) this.loadIface(this.addIface(i, this.ports[i].name, null, 'routed'), s);
        }
      }
      this.syncIfaces();
      this.loadRoutes(c.routes);
      this.loadAcls(c.acls);
      this.dns = c.nameServer ? U.parseIp(c.nameServer) : null;
      this.loadRouting(c);
      this.iosLoad(c.ios);
      this.net.markRouting();
    }

    load(d) {
      super.load(d);
      if (typeof d.baseMac === 'string') this.baseMac = d.baseMac;
    }
  }
  NS.applyIos(Switch);
  Switch.namePrefix = 'Switch';
  Switch.title = 'Коммутатор';

  NS.Switch = Switch;
  NS.deviceTypes.switch = Switch;
})(globalThis.NetLab = globalThis.NetLab || {});
