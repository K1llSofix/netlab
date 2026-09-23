/* NetLab — беспроводной маршрутизатор Linksys WRT300N (домашний роутер):
 * порт Internet (WAN, DHCP или статический адрес), 4 LAN-порта и Wi-Fi в одной сети,
 * встроенный DHCP-сервер для LAN и NAT/PAT в интернет. Настраивается через GUI, без IOS. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;

  const ACL = 'WRT-LAN';

  class WirelessRouter extends NS.Switch {
    constructor(net, id, name, model) {
      super(net, id, name, model, 'wrouter');
      this.l3 = true;
      this.ipRouting = true;
      this.forwarding = true;
      this.nvram = undefined; // конфигурация сохраняется сразу, как у домашних роутеров
      this.useApipa = false;
      this.wifi = { ssid: 'Default', security: 'open', key: '', channel: 6, enabled: true };
      this.wanDns = null;
      this.wanMode = 'dhcp';
      this.dhcpd = new NS.DhcpService(this);
      this.dhcpd.enabled = true;
      this.nat = new NS.NatEngine(this);
      this.setupDefaults();
      this.bindServices();
    }

    get wanIface() { return this.ifaces.find((f) => f.kind === 'routed'); }
    get lanIface() { return this.ifaces.find((f) => f.kind === 'svi' && f.vlan === 1); }

    setupDefaults() {
      const wan = this.ports.findIndex((p) => p.name === 'Internet');
      this.ports[wan].routed = true;
      this.syncIfaces();
      const lan = this.lanIface;
      lan.adminUp = true;
      lan.ip = U.parseIp('192.168.0.1');
      lan.mask = U.maskFromPrefix(24);
      lan.nat = 'inside';
      const w = this.wanIface;
      w.nat = 'outside';
      w.dhcp = true;
      this.dhcpd.pools = [];
      this.dhcpd.setPool({ name: 'LAN', start: U.parseIp('192.168.0.100'), end: U.parseIp('192.168.0.149'), mask: U.maskFromPrefix(24), gateway: lan.ip, dns: lan.ip });
      this.rebuildNat();
    }

    /** Правило PAT: вся сеть LAN уходит в интернет под адресом порта Internet. */
    rebuildNat() {
      const lan = this.lanIface;
      const acl = new NS.AccessList(ACL, 'standard');
      acl.add(['permit', U.ipStr(U.net(lan.ip, lan.mask)), U.ipStr(U.wildcardFromMask(lan.mask))]);
      this.acls = new Map([[ACL, acl]]);
      this.nat.rules = [];
      this.nat.addRule({ acl: ACL, ifName: 'Internet', overload: true });
    }

    bindServices() {
      super.bindServices();
      if (this.dhcpd) this.udp.set(67, (pkt, f) => { if (f === this.lanIface) this.dhcpd.handle(pkt, f); });
      this.udp.set(53, (pkt, f) => this.dnsProxy(pkt, f));
    }

    /** DNS-прокси: клиенты LAN спрашивают роутер, роутер — DNS провайдера. */
    dnsProxy(pkt, f) {
      if (f !== this.lanIface) return;
      const d = pkt.payload.data || {};
      if (d.op !== 'query') return;
      const reply = (addr) => this.sendIp(P.ipv4(f.ip, pkt.src, 'UDP', P.udp(53, pkt.payload.sport, { op: 'answer', id: d.id, name: d.name, ip: addr }), this.defaultTtl), {
        why: 'DNS-прокси роутера: ' + (addr != null ? d.name + ' = ' + U.ipStr(addr) : 'имя не найдено'),
      });
      if (this.wanDns == null) { reply(null); return; }
      const saved = this.dns;
      this.dns = this.wanDns;
      this.resolveName(d.name, (addr) => reply(addr));
      this.dns = saved;
    }

    radioEnabled() { return this.power && this.wifi.enabled !== false; }

    /* ---------- настройки из GUI ---------- */

    setWan(cfg) {
      const w = this.wanIface;
      if (cfg.mode === 'dhcp') {
        this.wanMode = 'dhcp';
        this.routes = [];
        w.dhcp = true;
        this.wanDns = null;
        this.startDhcp(w);
      } else {
        const err = U.validateHostIp(cfg.ip, cfg.mask);
        if (err) throw new Error(err);
        if (cfg.gateway != null && !U.sameNet(cfg.gateway, cfg.ip, cfg.mask)) throw new Error('Шлюз провайдера должен быть в сети порта Internet');
        this.stopDhcp();
        this.wanMode = 'static';
        w.dhcp = false;
        this.setIfaceIp(w, cfg.ip, cfg.mask);
        this.routes = cfg.gateway != null ? [{ net: 0, mask: 0, nextHop: cfg.gateway, ifName: null, ad: 1 }] : [];
        this.wanDns = cfg.dns == null ? null : cfg.dns;
      }
      this.updatePoolDns();
      this.net.markRouting();
    }

    setLan(ip, mask) {
      const err = U.validateHostIp(ip, mask);
      if (err) throw new Error(err);
      const lan = this.lanIface;
      const w = this.wanIface;
      if (w.ip != null && (U.sameNet(ip, w.ip, mask) || U.sameNet(w.ip, ip, w.mask))) throw new Error('Сеть LAN пересекается с сетью порта Internet');
      lan.ip = ip;
      lan.mask = mask;
      const p = this.dhcpd.pools[0];
      const net = U.net(ip, mask);
      const count = p ? p.end - p.start + 1 : 50;
      this.dhcpd.pools = [];
      this.dhcpd.leases.clear();
      let start = net + 100;
      if (!U.sameNet(start, net, mask) || start >= U.bcast(net, mask)) start = net + 2;
      this.dhcpd.setPool({ name: 'LAN', start, end: Math.min(start + count - 1, U.bcast(net, mask) - 1), mask, gateway: ip, dns: ip });
      this.rebuildNat();
      this.addressChanged(lan);
    }

    setDhcpServer(cfg) {
      const p = this.dhcpd.pools[0];
      if (cfg.enabled !== undefined) this.dhcpd.enabled = !!cfg.enabled;
      if (cfg.start != null || cfg.count != null) {
        const lan = this.lanIface;
        const start = cfg.start != null ? cfg.start : p.start;
        const count = cfg.count != null ? cfg.count : p.end - p.start + 1;
        if (!U.sameNet(start, lan.ip, lan.mask)) throw new Error('Начальный адрес должен быть в сети LAN ' + U.cidr(U.net(lan.ip, lan.mask), lan.mask));
        if (!(count >= 1 && count <= 253)) throw new Error('Число адресов: 1–253');
        this.dhcpd.setPool({ name: 'LAN', start, end: start + count - 1, mask: lan.mask, gateway: lan.ip, dns: lan.ip }, 'LAN');
      }
    }

    setWifi(cfg) {
      NS.validateWifi(cfg);
      Object.assign(this.wifi, cfg);
      this.net.refreshTopology();
    }

    updatePoolDns() {
      const p = this.dhcpd.pools[0];
      if (p && this.lanIface) p.dns = this.lanIface.ip;
    }

    onDhcpBound(f, d) {
      this.wanDns = d.dns || null;
      this.updatePoolDns();
    }

    onDhcpUnbound() {
      this.wanDns = null;
      this.updatePoolDns();
    }

    wirelessClients() {
      const rp = this.ports.find((p) => p.radio);
      if (!rp || !rp.wlinks) return [];
      return [...rp.wlinks].map((id) => this.net.links.get(id)).filter(Boolean).map((l) => this.net.getDevice(l.b.dev)).filter(Boolean);
    }

    /* Домашний роутер не теряет настройки при выключении */
    onPowerOn() { this.net.emit('config', { dev: this }); }
    saveNvram() {}
    nvramDirty() { return false; }

    serializeConfig() {
      const c = super.serializeConfig();
      const ip = (v) => (v == null ? null : U.ipStr(v));
      Object.assign(c, { wifi: Object.assign({}, this.wifi), wanMode: this.wanMode, wanDns: ip(this.wanDns), dhcpd: this.dhcpd.serialize() });
      return c;
    }

    loadConfig(c) {
      if (!this.nat) return; // вызов из конструктора родителя до инициализации
      super.loadConfig(c);
      this.ipRouting = true;
      this.forwarding = true;
      if (c.wifi) Object.assign(this.wifi, c.wifi);
      this.wanMode = c.wanMode === 'static' ? 'static' : 'dhcp';
      this.wanDns = c.wanDns ? U.parseIp(c.wanDns) : null;
      if (c.dhcpd) this.dhcpd.load(c.dhcpd);
      const w = this.wanIface;
      if (w) { w.nat = 'outside'; if (this.wanMode === 'dhcp') { w.dhcp = true; w.ip = null; w.mask = null; } }
      const lan = this.lanIface;
      if (lan) lan.nat = 'inside';
      if (lan && lan.ip != null) this.rebuildNat();
      this.bindServices();
    }
  }
  WirelessRouter.namePrefix = 'WirelessRouter';
  WirelessRouter.title = 'Беспроводной маршрутизатор';

  NS.WirelessRouter = WirelessRouter;
  NS.deviceTypes.wrouter = WirelessRouter;
})(globalThis.NetLab = globalThis.NetLab || {});
