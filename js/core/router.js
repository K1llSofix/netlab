/* NetLab — маршрутизатор Cisco (2911, 1941, Router-PT).
 * Интерфейсы по модели и модулям (Gigabit, Serial из HWIC-2T, оптика), подынтерфейсы 802.1Q,
 * loopback, clock rate и инкапсуляция HDLC/PPP на serial, DHCP-сервер и relay, NAT, ACL, RIP, OSPF. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;

  const CLOCK_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000, 128000, 148000, 250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000];

  function defaultRip() { return { networks: [], version: 1, autoSummary: true, passive: [], defaultOriginate: false }; }

  class Router extends NS.IpNode {
    constructor(net, id, name, model) {
      super(net, id, 'router', name, model);
      this.forwarding = true;
      this.defaultTtl = 255;
      this.dhcpd = new NS.DhcpService(this);
      this.dhcpd.enabled = true; // как «service dhcp» в IOS: работает, если настроен пул
      this.nat = new NS.NatEngine(this);
      this.rip = defaultRip();
      this.ospf = null;
      this.iosInit();
      this.syncIfaces();
      this.bindServices();
    }

    /** У каждого сетевого порта — физический интерфейс с тем же именем. */
    syncIfaces() {
      if (!this.ifaces) return;
      this.ports.forEach((p, i) => {
        if (p.media !== 'copper' && p.media !== 'fiber' && p.media !== 'serial') return;
        let f = this.ifaces.find((x) => x.kind === 'phys' && x.port === i);
        if (!f) f = this.addIface(i, p.name);
        f.name = p.name;
      });
    }

    /** Порядок интерфейсов как в IOS: loopback, затем физические, за каждым — его подынтерфейсы. */
    sortIfaces() {
      const num = (f) => Number((/(\d+)$/.exec(f.name) || [0, 0])[1]);
      this.ifaces.sort((a, b) => {
        if (a.kind === 'loop' || b.kind === 'loop') return a.kind === b.kind ? num(a) - num(b) : a.kind === 'loop' ? -1 : 1;
        if (a.port !== b.port) return a.port - b.port;
        if (a.kind !== b.kind) return a.kind === 'phys' ? -1 : 1;
        return num(a) - num(b);
      });
    }

    bindServices() {
      super.bindServices();
      this.udp.set(67, (pkt, f) => this.onDhcp(pkt, f));
      if (NS.bindIosServices) NS.bindIosServices(this);
    }

    onDhcp(pkt, f) {
      const d = pkt.payload.data || {};
      const fromClient = d.op === 'DISCOVER' || d.op === 'REQUEST' || d.op === 'DECLINE' || d.op === 'RELEASE';
      if (fromClient) {
        if (f.helper != null && f.ip != null && pkt.dst === U.BROADCAST_IP) {
          const fwd = Object.assign({}, d, { giaddr: d.giaddr || f.ip });
          this.sendIp(P.ipv4(f.ip, f.helper, 'UDP', P.udp(67, 67, fwd), this.defaultTtl), {
            why: 'DHCP relay: пересылаю ' + d.op + ' серверу ' + U.ipStr(f.helper),
          });
          return;
        }
        this.dhcpd.handle(pkt, f);
        return;
      }
      if (d.giaddr) {
        const g = this.ifaces.find((x) => x.ip === d.giaddr && this.ifaceUp(x));
        if (!g) return;
        this.sendIp(P.ipv4(g.ip, U.BROADCAST_IP, 'UDP', P.udp(67, 68, d), this.defaultTtl), {
          iface: g, dstMac: d.chaddr, why: 'DHCP relay: передаю ' + d.op + ' клиенту',
        });
      }
    }

    /* ---------- интерфейсы ---------- */

    /** Создать подынтерфейс, например GigabitEthernet0/0.10. */
    addSubif(portIdx, num, vlan) {
      const port = this.ports[portIdx];
      if (!port || (port.media !== 'copper' && port.media !== 'fiber')) throw new Error('Подынтерфейс можно создать только на Ethernet-порту');
      num = Number(num);
      if (!Number.isInteger(num) || num < 1 || num > 4094) throw new Error('Номер подынтерфейса: 1–4094');
      const name = port.name + '.' + num;
      if (this.ifaceByName(name)) throw new Error('Подынтерфейс ' + name + ' уже есть');
      const f = this.addIface(portIdx, name, null, 'sub');
      this.sortIfaces();
      if (vlan != null) this.setSubifVlan(f, vlan);
      return f;
    }

    setSubifVlan(f, vlan) {
      if (f.kind !== 'sub') throw new Error('VLAN задаётся только на подынтерфейсе');
      vlan = Number(vlan);
      if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw new Error('VLAN: 1–4094');
      const other = this.ifaces.find((x) => x !== f && x.kind === 'sub' && x.port === f.port && x.vlan === vlan);
      if (other) throw new Error('VLAN ' + vlan + ' уже используется на ' + other.name);
      this.flushIface(f, 'down');
      f.vlan = vlan;
      this.net.refreshTopology();
    }

    addLoopback(n) {
      n = Number(n);
      if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new Error('Номер loopback: 0–2147483647');
      const name = 'Loopback' + n;
      let f = this.ifaceByName(name);
      if (!f) f = this.addIface(-1, name, null, 'loop');
      this.sortIfaces();
      this.net.markRouting();
      return f;
    }

    removeIface(f) {
      if (f.kind !== 'sub' && f.kind !== 'loop') throw new Error('Физический интерфейс удалить нельзя');
      this.flushIface(f, 'down');
      this.ifaces = this.ifaces.filter((x) => x !== f);
      this.net.markRouting();
      this.net.emit('config', { dev: this });
    }

    /* ---------- serial ---------- */

    serialPort(i) {
      const p = this.ports[i];
      if (!p || p.media !== 'serial') throw new Error('Это не последовательный (Serial) интерфейс');
      return p;
    }

    setClockRate(i, rate) {
      const p = this.serialPort(i);
      if (rate == null) { p.clockRate = null; this.net.refreshTopology(); return; }
      rate = Number(rate);
      if (!CLOCK_RATES.includes(rate)) throw new Error('Допустимые значения clock rate: ' + CLOCK_RATES.join(', '));
      p.clockRate = rate;
      this.net.refreshTopology();
    }

    setEncapsulation(i, enc) {
      const p = this.serialPort(i);
      if (enc !== 'hdlc' && enc !== 'ppp') throw new Error('Инкапсуляция: hdlc или ppp');
      p.encap = enc;
      this.net.refreshTopology();
    }

    /** Этот конец serial-кабеля — DCE (на нём задаётся clock rate)? */
    isDce(i) {
      const pr = this.net.peer(this, i);
      return !!pr && pr.link.cable === 'serial' && pr.link.dce === this.id;
    }

    /* ---------- RIP / OSPF ---------- */

    ripNetwork(net, remove) {
      if (net == null) throw new Error('Неверный адрес сети');
      const cls = U.net(net, U.classfulMask(net));
      this.rip.networks = this.rip.networks.filter((n) => n !== cls);
      if (!remove) this.rip.networks.push(cls);
      this.net.markRouting();
    }

    ospfEnable(pid) {
      pid = Number(pid);
      if (!Number.isInteger(pid) || pid < 1 || pid > 65535) throw new Error('Номер процесса OSPF: 1–65535');
      if (this.ospf && this.ospf.pid !== pid) throw new Error('Уже запущен процесс OSPF ' + this.ospf.pid + ' (в NetLab поддерживается один процесс)');
      if (!this.ospf) this.ospf = { pid, routerId: null, networks: [], passive: [], defaultOriginate: false, defaultAlways: false };
      this.net.markRouting();
      return this.ospf;
    }

    ospfNetwork(net, wc, area, remove) {
      if (!this.ospf) throw new Error('Сначала router ospf');
      if (net == null || wc == null) throw new Error('Неверный адрес или wildcard-маска');
      area = Number(area);
      if (!Number.isInteger(area) || area < 0) throw new Error('Номер области: число (0 — магистральная)');
      this.ospf.networks = this.ospf.networks.filter((n) => !(n.net === U.net(net, (~wc) >>> 0) && n.wc === wc));
      if (!remove) this.ospf.networks.push({ net: U.net(net, (~wc) >>> 0), wc, area });
      this.net.markRouting();
    }

    setPassive(proto, ifname, on) {
      const cfg = proto === 'ospf' ? this.ospf : this.rip;
      if (!cfg) throw new Error('Протокол не запущен');
      const f = this.ifaceByName(ifname);
      if (!f) throw new Error('Интерфейс ' + ifname + ' не найден');
      cfg.passive = cfg.passive.filter((n) => n.toLowerCase() !== f.name.toLowerCase());
      if (on) cfg.passive.push(f.name);
      this.net.markRouting();
    }

    /* ---------- сохранение ---------- */

    serializeRouting() {
      const ip = U.ipStr;
      return {
        rip: Object.assign({}, this.rip, { networks: this.rip.networks.map(ip) }),
        ospf: this.ospf ? Object.assign({}, this.ospf, { routerId: this.ospf.routerId == null ? null : ip(this.ospf.routerId), networks: this.ospf.networks.map((n) => ({ net: ip(n.net), wc: ip(n.wc), area: n.area })) }) : null,
      };
    }

    loadRouting(c) {
      const r = c.rip || {};
      this.rip = Object.assign(defaultRip(), r, { networks: (r.networks || []).map((x) => U.parseIp(x)).filter((x) => x != null), passive: (r.passive || []).slice() });
      const o = c.ospf;
      this.ospf = o ? {
        pid: Number(o.pid) || 1,
        routerId: o.routerId ? U.parseIp(o.routerId) : null,
        networks: (o.networks || []).map((n) => ({ net: U.parseIp(n.net), wc: U.parseIp(n.wc), area: Number(n.area) || 0 })).filter((n) => n.net != null && n.wc != null),
        passive: (o.passive || []).slice(),
        defaultOriginate: !!o.defaultOriginate,
        defaultAlways: !!o.defaultAlways,
      } : null;
    }

    serializeConfig() {
      return Object.assign({
        ifaces: this.serializeIfaces(),
        routes: this.serializeRoutes(),
        dhcpd: this.dhcpd.serialize(),
        acls: this.serializeAcls(),
        nat: this.nat.serialize(),
        proxyArp: this.proxyArp,
        nameServer: this.dns == null ? null : U.ipStr(this.dns),
        ios: this.iosSerialize(),
      }, this.serializeRouting());
    }

    loadConfig(c) {
      this.stopDhcp();
      this.ifaces = [];
      this.syncIfaces();
      for (const s of c.ifaces || []) {
        const kind = s.kind || (s.sub ? 'sub' : 'phys');
        let f = null;
        if (kind === 'phys') {
          const i = this.savedPort(s);
          f = this.ifaces.find((x) => x.kind === 'phys' && x.port === i);
        } else if (kind === 'sub') {
          const i = this.savedPort(s);
          if (i < 0 || this.ifaceByName(s.name)) continue;
          f = this.addIface(i, String(s.name), Number.isInteger(s.vlan) ? s.vlan : null, 'sub');
        } else if (kind === 'loop') {
          if (this.ifaceByName(s.name)) continue;
          f = this.addIface(-1, String(s.name), null, 'loop');
        }
        if (!f) continue;
        this.loadIface(f, s);
        if (f.dhcp) { f.ip = null; f.mask = null; }
      }
      this.sortIfaces();
      this.loadRoutes(c.routes);
      this.dhcpd.load(c.dhcpd);
      if (!c.dhcpd) this.dhcpd.enabled = true;
      this.loadAcls(c.acls);
      this.nat.load(c.nat);
      this.proxyArp = c.proxyArp !== false;
      this.dns = c.nameServer ? U.parseIp(c.nameServer) : null;
      this.loadRouting(c);
      this.iosLoad(c.ios);
      this.net.markRouting();
    }
  }
  NS.applyIos(Router);
  Router.namePrefix = 'Router';
  Router.title = 'Маршрутизатор';
  Router.CLOCK_RATES = CLOCK_RATES;

  // RIP и OSPF работают и на коммутаторе 3-го уровня
  for (const k of ['ripNetwork', 'ospfEnable', 'ospfNetwork', 'setPassive', 'serializeRouting', 'loadRouting']) {
    NS.Switch.prototype[k] = Router.prototype[k];
  }

  NS.Router = Router;
  NS.deviceTypes.router = Router;
})(globalThis.NetLab = globalThis.NetLab || {});
