/* NetLab — IP-телефония: IP-телефон Cisco 7960 (питание от адаптера или PoE коммутатора 3560-24PS,
 * встроенный мост на порт PC, голосовой VLAN), программный телефон IP Communicator на ПК,
 * Cisco CME на маршрутизаторе (telephony-service, ephone-dn, ephone, auto assign),
 * регистрация и управление вызовами по SCCP (TCP 2000), голос — RTP (UDP) напрямую между телефонами.
 * Адрес CME телефон получает из DHCP (option 150). */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const M = NS.models;

  const SCCP_PORT = 2000;
  const RTP_BASE = 16384;
  const REG_RETRY = 1000;

  const hex12 = (m) => String(m || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const macDots = (m) => { const h = hex12(m).toUpperCase(); return h.slice(0, 4) + '.' + h.slice(4, 8) + '.' + h.slice(8, 12); };

  /* ================= модели ================= */

  M.MODELS['7960'] = {
    type: 'ipphone', title: 'IP-телефон Cisco 7960',
    ports: [{ name: 'Switch', media: 'copper', speed: 100 }, { name: 'PC', media: 'copper', speed: 100, mdix: true }],
    slots: [], attrs: { MTBF: 100000, cost: 300, 'power source': 0, 'rack units': 0, wattage: 6.3 },
  };
  M.DEFAULT_MODEL.ipphone = '7960';
  if (M.MODELS['3560-24PS']) M.MODELS['3560-24PS'].poe = true;

  /* ================= SCCP-клиент: телефон 7960 и IP Communicator ================= */

  class SccpClient {
    constructor(node, kind) {
      this.node = node;
      this.kind = kind; // '7960' | 'CIPC'
      this.retry = null;
      this.reset('Не зарегистрирован');
    }

    emit() { this.node.net.emit('config', { dev: this.node }); }

    reset(text) {
      if (this.retry) { this.retry.cancel(); this.retry = null; }
      const c = this.conn;
      this.conn = null;
      if (c && !c.done && this.node.tcp && this.node.tcp.conns.get(c.key) === c) c.abort('Телефон перезапущен');
      this.freeRtp();
      this.state = 'off';
      this.text = text || '';
      this.lines = [];
      this.ephone = null;
      this.call = null;
      this.heard = [];
      this.server = null;
      this.message = '';
    }

    get mac() { const f = this.node.iface; return f ? this.node.ifaceMac(f) : null; }
    get number() { return this.lines.length ? this.lines[0].number : ''; }

    /** Регистрация на CME (адрес — из option 150 или указан вручную). */
    register(server) {
      this.reset();
      if (server == null) {
        this.state = 'failed';
        this.text = this.kind === 'CIPC' ? 'Укажите адрес TFTP-сервера (CME)' : 'Нет адреса TFTP-сервера: добавьте в DHCP-пул option 150 ip <адрес CME>';
        this.emit();
        return;
      }
      if (!this.node.iface || this.node.iface.ip == null) {
        this.state = 'failed';
        this.text = 'Нет IP-адреса';
        this.emit();
        return;
      }
      this.server = server;
      this.state = 'registering';
      this.text = 'Регистрация на ' + U.ipStr(server) + '…';
      const conn = this.node.tcp.connect(server, SCCP_PORT, {
        onOpen: (c) => { if (c === this.conn) c.send({ sccp: 'Register', mac: this.mac, type: this.kind, name: this.node.name }); },
        onData: (d, c) => { if (c === this.conn) this.onMsg(d); },
        onClose: (c) => { if (c === this.conn) this.lost('CME закрыл соединение'); },
        onError: (code, text, c) => { if (c === this.conn) this.lost(text); },
      });
      this.conn = conn;
      this.emit();
    }

    lost(text) {
      const server = this.server;
      const wasCall = this.call;
      this.conn = null;
      this.freeRtp();
      this.call = null;
      this.lines = [];
      this.state = 'failed';
      this.text = 'Не зарегистрирован: ' + text;
      if (wasCall) this.node.note('Телефон: вызов прерван — ' + text, null, 'drop');
      this.emit();
      // телефон повторяет регистрацию, пока есть связь (как настоящий: каждые несколько секунд)
      if (server != null && this.node.iface && this.node.iface.ip != null && this.node.ifaceUp(this.node.iface)) {
        this.retry = this.node.timer(REG_RETRY, () => { this.retry = null; if (this.state === 'failed') this.register(server); });
      }
    }

    send(data) { if (this.conn && !this.conn.done) this.conn.send(data); }

    onMsg(d) {
      switch (d.sccp) {
        case 'RegisterAck':
          this.state = 'registered';
          this.ephone = d.ephone;
          this.lines = d.lines || [];
          this.message = d.message || '';
          this.text = this.lines.length ? 'Зарегистрирован, номер ' + this.lines[0].number : 'Зарегистрирован, но номер не назначен (ephone-dn / auto assign / button)';
          this.node.note('Телефон зарегистрирован на CME ' + U.ipStr(this.server) + (this.lines.length ? ', номер ' + this.lines[0].number : ' без номера'), null, 'accept');
          break;
        case 'RegisterReject': {
          const c = this.conn;
          this.lost('CME отклонил регистрацию — ' + d.text);
          if (c && !c.done) c.close();
          return;
        }
        case 'Ringback':
          if (this.call && this.call.state === 'dialing') Object.assign(this.call, { id: d.callId, state: 'ringback', text: 'Вызов ' + d.number + '…' });
          break;
        case 'Busy':
        case 'Error':
          if (this.call && (this.call.state === 'dialing' || this.call.state === 'ringback')) {
            this.call = null;
            this.text = d.text;
          }
          break;
        case 'Ring':
          if (this.call) break;
          this.call = { id: d.callId, state: 'ringing', dir: 'in', peer: d.from, text: 'Входящий вызов от ' + d.from };
          this.node.note('Телефон ' + this.number + ': звонит ' + d.from, null, 'info');
          break;
        case 'Connected':
          if (!this.call || this.call.id !== d.callId) break;
          Object.assign(this.call, { state: 'connected', peerIp: d.peerIp, port: d.port, peer: d.peer || this.call.peer, since: this.node.net.time, text: 'Разговор с ' + (d.peer || this.call.peer) });
          this.bindRtp(d.port);
          this.say('Алло!');
          break;
        case 'CallEnd':
          if (this.call && this.call.id === d.callId) {
            this.freeRtp();
            this.call = null;
            this.text = d.text || 'Вызов завершён';
          }
          break;
        default:
          return;
      }
      this.emit();
    }

    /** Набрать номер. Возвращает текст ошибки или null. */
    dial(number) {
      const n = String(number || '').trim();
      if (this.state !== 'registered') return 'Телефон не зарегистрирован на CME';
      if (!this.lines.length) return 'У телефона нет номера';
      if (this.call) return 'Линия занята — сначала положите трубку';
      if (!/^[0-9*#]{1,16}$/.test(n)) return 'Наберите номер цифрами';
      this.call = { id: null, state: 'dialing', dir: 'out', peer: n, text: 'Набор ' + n + '…' };
      this.send({ sccp: 'Dial', number: n });
      this.emit();
      return null;
    }

    answer() {
      if (!this.call || this.call.state !== 'ringing') return 'Нет входящего вызова';
      this.send({ sccp: 'Answer', callId: this.call.id });
      return null;
    }

    hangup() {
      if (!this.call) return;
      if (this.call.id != null) this.send({ sccp: 'Hangup', callId: this.call.id });
      this.freeRtp();
      this.call = null;
      this.text = 'Трубка положена';
      this.emit();
    }

    bindRtp(port) {
      this.freeRtp();
      this.rtpPort = port;
      this.rtpSeq = 0;
      this.node.udp.set(port, (pkt) => {
        const d = pkt.payload.data || {};
        if (!d.rtp) return;
        this.heard.push({ text: String(d.text || ''), from: this.call ? this.call.peer : U.ipStr(pkt.src), time: this.node.net.time });
        if (this.heard.length > 50) this.heard.shift();
        this.emit();
      });
    }

    freeRtp() {
      if (this.rtpPort != null && this.node.udp) this.node.udp.delete(this.rtpPort);
      this.rtpPort = null;
    }

    /** «Сказать» в трубку — голосовой пакет RTP собеседнику. */
    say(text) {
      const c = this.call;
      if (!c || c.state !== 'connected') return 'Нет разговора';
      this.rtpSeq++;
      this.node.sendIp(P.ipv4(null, c.peerIp, 'UDP', P.udp(c.port, c.port, { rtp: true, codec: 'G.711 µ-law', seq: this.rtpSeq, text: String(text || '').slice(0, 200) }), this.node.defaultTtl), {
        why: 'RTP: голос для ' + c.peer + ' идёт напрямую на ' + U.ipStr(c.peerIp) + ' (не через CME)',
      });
      return null;
    }
  }

  /* ================= IP-телефон 7960 ================= */

  class IpPhone extends NS.Host {
    constructor(net, id, name, model) {
      super(net, id, name, model, 'ipphone');
      this.adapter = false;
      this.tftpManual = null;
      this.voiceVlan = null;
      this.sccp = new SccpClient(this, '7960');
      this.iface.dhcp = true;
    }

    /* ---------- питание: адаптер или PoE ---------- */

    get power() { return this._power !== false && this.powerSource() !== null; }
    set power(v) { this._power = !!v; }

    /** Откуда питание: 'adapter' | 'poe' | null. */
    powerSource() {
      if (this.adapter) return 'adapter';
      if (!this.ports || !this.ports[0] || !this.ports[0].link || !this.net) return null;
      const pr = this.net.peer(this, 0);
      if (!pr || !pr.dev.spec || !pr.dev.spec.poe || !pr.dev.power) return null;
      const p = pr.dev.ports[pr.port];
      return p && p.adminUp && p.poe !== false && (pr.link.cable === 'straight' || pr.link.cable === 'cross') ? 'poe' : null;
    }

    setAdapter(on) {
      this.adapter = !!on;
      this.net.refreshTopology();
      if (this.power) this.timer(5, () => this.boot());
      else this.powerLost();
      this.net.emit('config', { dev: this });
    }

    powerLost() {
      this.sccp.reset('Нет питания');
      const f = this.iface;
      if (this.dhcpc && this.dhcpc.timer) this.dhcpc.timer.cancel();
      this.dhcpc = null;
      if (f && f.dhcp) { f.ip = null; f.mask = null; this.gateway = null; this.dns = null; }
      this.voiceVlan = null;
    }

    /* ---------- «CDP»: голосовой VLAN от коммутатора ---------- */

    learnVoiceVlan() {
      const pr = this.net.peer(this, 0);
      const p = pr && pr.dev.type === 'switch' && this.net.isPortOperational(this, 0) ? pr.dev.ports[pr.port] : null;
      const v = p && p.mode === 'access' && p.voiceVlan && (!pr.dev.ios || pr.dev.ios.cdp !== false) ? p.voiceVlan : null;
      const changed = v !== this.voiceVlan;
      this.voiceVlan = v;
      return changed;
    }

    /** Коммутатор сообщил (CDP) о смене voice vlan — телефон перезапрашивает адрес в новом VLAN. */
    cdpUpdate() {
      if (!this.power || !this.learnVoiceVlan()) return;
      this.sccp.reset('Смена голосового VLAN');
      const f = this.iface;
      if (f.dhcp) this.startDhcp(f);
      this.net.emit('config', { dev: this });
    }

    boot() {
      if (!this.power) return;
      this.learnVoiceVlan();
      const f = this.iface;
      if (f.ip != null && (!f.dhcp || (this.dhcpc && this.dhcpc.phase === 'bound'))) this.sccpBoot();
      else if (f.dhcp && (!this.dhcpc || this.dhcpc.phase === 'failed' || this.dhcpc.phase === 'wait-link')) this.startDhcp(f);
    }

    tftpServer() {
      if (this.tftpManual != null) return this.tftpManual;
      return this.dhcpc && this.dhcpc.tftp != null ? this.dhcpc.tftp : null;
    }

    sccpBoot() { this.sccp.register(this.tftpServer()); }

    setTftp(ipv) {
      this.tftpManual = ipv == null ? null : ipv;
      if (this.power && this.iface.ip != null) this.sccpBoot();
    }

    onDhcpBound(f, d) {
      super.onDhcpBound(f, d);
      this.sccpBoot();
    }

    setStatic(ip, mask, gateway, dns) {
      super.setStatic(ip, mask, gateway, dns);
      if (this.power) this.timer(1, () => this.sccpBoot());
    }

    setDhcp() {
      this.sccp.reset('Запрос адреса…');
      super.setDhcp();
    }

    reset() {
      super.reset();
      if (this.sccp) this.sccp.reset('Загрузка…');
      this.timer(5, () => this.boot());
    }

    onLinkChange(i, up) {
      if (i === 0) {
        if (!this.power) { this.powerLost(); this.net.emit('config', { dev: this }); return; }
        if (up) this.learnVoiceVlan();
        super.onLinkChange(i, up);
        if (!up) {
          this.sccp.reset('Нет связи с коммутатором');
          this.voiceVlan = null;
        } else if (this.iface.ip != null && !this.iface.dhcp) {
          this.timer(5, () => this.sccpBoot());
        }
        this.net.emit('config', { dev: this });
        return;
      }
      super.onLinkChange(i, up);
    }

    /* ---------- встроенный мини-коммутатор: порт PC ↔ порт Switch ---------- */

    bridge(j, frame, why) {
      if (!this.net.isPortOperational(this, j)) return false;
      return this.net.transmit(this, j, frame, why);
    }

    send(i, frame, why, ex) {
      if (i === 0 && this.voiceVlan != null && frame.vlan == null) frame = Object.assign({}, frame, { vlan: this.voiceVlan });
      return super.send(i, frame, why, ex);
    }

    receive(i, frame) {
      const own = this.ports[0].mac;
      if (i === 1) {
        if (frame.vlan != null) { this.drop(frame, 'IP-телефон: кадр с тегом 802.1Q от компьютера отброшен'); return; }
        this.bridge(0, frame, 'IP-телефон: кадр от компьютера передан в порт Switch' + (this.voiceVlan ? ' (без тега — VLAN данных)' : ''));
        if (!this.voiceVlan && (frame.dst === own || U.isMulticastMac(frame.dst))) super.receive(0, frame);
        return;
      }
      if (i !== 0) return;
      if (frame.vlan != null) {
        if (frame.vlan === this.voiceVlan) { super.receive(0, Object.assign({}, frame, { vlan: null })); return; }
        this.drop(frame, 'IP-телефон: кадр VLAN ' + frame.vlan + ' — не голосовой VLAN телефона' + (this.voiceVlan ? ' (' + this.voiceVlan + ')' : ''));
        return;
      }
      if (this.voiceVlan) { this.bridge(1, frame, 'IP-телефон: кадр VLAN данных передан компьютеру (порт PC)'); return; }
      const mine = frame.dst === own;
      if (!mine) this.bridge(1, frame, 'IP-телефон: кадр передан компьютеру (порт PC)');
      if (mine || U.isMulticastMac(frame.dst)) super.receive(0, frame);
    }

    /* ---------- сохранение ---------- */

    serialize() {
      const o = super.serialize();
      o.power = this._power !== false;
      return o;
    }

    serializeConfig() {
      const c = super.serializeConfig();
      c.phone = { adapter: !!this.adapter, tftp: this.tftpManual != null ? U.ipStr(this.tftpManual) : null };
      if (this.dhcpc && this.dhcpc.phase === 'bound' && this.dhcpc.tftp != null) c.phone.dhcpTftp = U.ipStr(this.dhcpc.tftp);
      return c;
    }

    loadConfig(c) {
      super.loadConfig(c);
      const p = c.phone || {};
      this.adapter = !!p.adapter;
      this.tftpManual = p.tftp ? U.parseIp(p.tftp) : null;
      if (this.dhcpc && p.dhcpTftp) this.dhcpc.tftp = U.parseIp(p.dhcpTftp);
      if (this.sccp) this.sccp.reset('Загрузка…');
      this.timer(5, () => this.boot());
    }
  }
  IpPhone.namePrefix = 'IP Phone';
  IpPhone.title = 'IP-телефон';
  NS.deviceTypes.ipphone = IpPhone;
  NS.IpPhone = IpPhone;

  /* ================= IP Communicator на ПК ================= */

  NS.Host.prototype.ipcStart = function (server) {
    if (!this.softphone) this.softphone = new SccpClient(this, 'CIPC');
    this.ipcTftp = server == null ? null : server;
    this.softphone.register(this.ipcTftp);
  };
  NS.Host.prototype.ipcStop = function () {
    if (!this.softphone) return;
    this.softphone.hangup();
    const c = this.softphone.conn;
    this.softphone.reset('Выключен');
    if (c && !c.done) c.close();
    this.net.emit('config', { dev: this });
  };

  IpNode.hooks.runtime.push(function () {
    if (this.softphone) this.softphone.reset('Выключен');
    this.cmeRt = { regs: new Map(), calls: new Map(), nextCall: 1 };
  });

  NS.deviceExt.push({
    key: 'ipc',
    applies: (d) => !!d.sendMail && d.type !== 'ipphone',
    save: (d) => (d.ipcTftp != null ? { tftp: U.ipStr(d.ipcTftp) } : null),
    load(d, c) { d.ipcTftp = c && c.tftp ? U.parseIp(c.tftp) : null; },
  });

  /* ================= Cisco CME на маршрутизаторе ================= */

  function cmeCfg(dev) {
    if (!dev.cme) dev.cme = { on: false, maxEphones: 0, maxDn: 0, source: null, port: SCCP_PORT, auto: null, message: '', dns: {}, ephones: {} };
    return dev.cme;
  }

  function cmeListen(dev) {
    if (!dev.tcp) return;
    const c = dev.cme;
    for (const port of [...dev.tcp.listeners.keys()]) if (dev.tcp.listeners.get(port) && dev.tcp.listeners.get(port).cme) dev.tcp.unlisten(port);
    if (!c || !c.on || c.source == null) return;
    const accept = (conn) => {
      conn.h = {
        onData: (d, cn) => cmeMsg(dev, cn, d),
        onClose: (cn) => cmeDrop(dev, cn, 'телефон отключился'),
        onError: (code, text, cn) => cmeDrop(dev, cn, text),
      };
    };
    accept.cme = true;
    dev.tcp.listen(c.port || SCCP_PORT, accept);
  }

  IpNode.hooks.bind.push(function () { if (this.type === 'router') cmeListen(this); });

  const regOf = (dev, conn) => { for (const r of dev.cmeRt.regs.values()) if (r.conn === conn) return r; return null; };
  const dnByNumber = (c, n) => Object.keys(c.dns).find((t) => c.dns[t].number === n);
  const regByDn = (dev, tag) => { for (const r of dev.cmeRt.regs.values()) if (r.lines.some((l) => String(l.dn) === String(tag))) return r; return null; };
  const callOf = (dev, reg) => { for (const x of dev.cmeRt.calls.values()) if (x.a === reg.mac || x.b === reg.mac) return x; return null; };

  function assignedDns(c) {
    const s = new Set();
    for (const e of Object.values(c.ephones)) for (const t of Object.values(e.buttons || {})) s.add(String(t));
    return s;
  }

  function linesOf(c, e) {
    return Object.entries(e.buttons || {}).sort((a, b) => a[0] - b[0])
      .map(([b, tag]) => ({ button: Number(b), dn: Number(tag), number: c.dns[tag] ? c.dns[tag].number : '', name: c.dns[tag] ? c.dns[tag].name || '' : '' }))
      .filter((l) => l.number);
  }

  function cmeRegister(dev, conn, d) {
    const c = dev.cme;
    const reject = (text) => {
      conn.send({ sccp: 'RegisterReject', text });
      dev.note('CME: отказ в регистрации ' + macDots(d.mac) + ' — ' + text, null, 'drop');
    };
    if (!c || !c.on) { reject('на маршрутизаторе не настроен telephony-service'); return; }
    if (conn.lip !== c.source) { reject('телефон обращается к ' + U.ipStr(conn.lip) + ', а ip source-address — ' + U.ipStr(c.source)); return; }
    const mac = hex12(d.mac);
    let n = Object.keys(c.ephones).find((k) => c.ephones[k].mac === mac);
    if (n == null) {
      const count = Object.keys(c.ephones).length;
      if (count >= c.maxEphones) { reject(c.maxEphones ? 'достигнут предел max-ephones ' + c.maxEphones : 'не задан max-ephones'); return; }
      let k = 1;
      while (c.ephones[k]) k++;
      c.ephones[k] = { mac, type: d.type === 'CIPC' ? 'CIPC' : '7960', buttons: {} };
      n = String(k);
      dev.note('CME: создан ephone ' + k + ' для ' + macDots(mac), null, 'info');
    }
    const e = c.ephones[n];
    if (!Object.keys(e.buttons).length && c.auto) {
      const used = assignedDns(c);
      for (let t = c.auto.from; t <= c.auto.to; t++) {
        if (c.dns[t] && c.dns[t].number && !used.has(String(t))) { e.buttons[1] = t; break; }
      }
    }
    const old = dev.cmeRt.regs.get(mac);
    if (old && old.conn !== conn) cmeDrop(dev, old.conn, 'повторная регистрация');
    const reg = { mac, conn, ip: conn.rip, ephone: Number(n), type: e.type, name: d.name || '', lines: linesOf(c, e), since: dev.net.time };
    dev.cmeRt.regs.set(mac, reg);
    conn.send({ sccp: 'RegisterAck', ephone: Number(n), lines: reg.lines, message: c.message || '' });
    dev.note('CME: ephone-' + n + ' (' + macDots(mac) + ', ' + U.ipStr(reg.ip) + ') зарегистрирован' + (reg.lines.length ? ', номер ' + reg.lines[0].number : ' без номера'), null, 'accept');
    dev.net.emit('config', { dev });
  }

  function cmeMsg(dev, conn, d) {
    if (!d || !d.sccp) return;
    if (d.sccp === 'Register') { cmeRegister(dev, conn, d); return; }
    const reg = regOf(dev, conn);
    if (!reg) return;
    const c = dev.cme;
    const rt = dev.cmeRt;
    if (d.sccp === 'Dial') {
      const number = String(d.number);
      const tag = dnByNumber(c, number);
      if (tag == null) { conn.send({ sccp: 'Error', text: 'Номер ' + number + ' не существует (нет ephone-dn с таким number)' }); return; }
      const to = regByDn(dev, tag);
      if (!to) { conn.send({ sccp: 'Busy', text: 'Абонент ' + number + ' не зарегистрирован' }); return; }
      if (to === reg) { conn.send({ sccp: 'Busy', text: 'Это ваш собственный номер' }); return; }
      if (callOf(dev, to)) { conn.send({ sccp: 'Busy', text: 'Абонент ' + number + ' занят' }); return; }
      const id = rt.nextCall++;
      rt.calls.set(id, { id, a: reg.mac, b: to.mac, number, from: reg.lines.length ? reg.lines[0].number : '', state: 'ringing', since: dev.net.time });
      conn.send({ sccp: 'Ringback', callId: id, number });
      to.conn.send({ sccp: 'Ring', callId: id, from: reg.lines.length ? reg.lines[0].number : '' });
      dev.note('CME: вызов ' + (reg.lines[0] ? reg.lines[0].number : '?') + ' → ' + number, null, 'info');
      return;
    }
    const call = rt.calls.get(d.callId);
    if (!call) return;
    if (d.sccp === 'Answer' && call.b === reg.mac && call.state === 'ringing') {
      const a = rt.regs.get(call.a);
      if (!a) { rt.calls.delete(call.id); conn.send({ sccp: 'CallEnd', callId: call.id, text: 'Вызывающий положил трубку' }); return; }
      call.state = 'connected';
      const port = RTP_BASE + 2 * (call.id % 8000);
      a.conn.send({ sccp: 'Connected', callId: call.id, peerIp: reg.ip, port, peer: call.number });
      conn.send({ sccp: 'Connected', callId: call.id, peerIp: a.ip, port, peer: call.from });
      dev.note('CME: соединение ' + call.from + ' ↔ ' + call.number + ' — голос (RTP) пойдёт напрямую между телефонами', null, 'accept');
      return;
    }
    if (d.sccp === 'Hangup' && (call.a === reg.mac || call.b === reg.mac)) {
      rt.calls.delete(call.id);
      const other = rt.regs.get(call.a === reg.mac ? call.b : call.a);
      if (other) other.conn.send({ sccp: 'CallEnd', callId: call.id, text: 'Собеседник положил трубку' });
    }
  }

  function cmeDrop(dev, conn, text) {
    const reg = regOf(dev, conn);
    if (!reg) return;
    dev.cmeRt.regs.delete(reg.mac);
    for (const call of [...dev.cmeRt.calls.values()]) {
      if (call.a !== reg.mac && call.b !== reg.mac) continue;
      dev.cmeRt.calls.delete(call.id);
      const other = dev.cmeRt.regs.get(call.a === reg.mac ? call.b : call.a);
      if (other) other.conn.send({ sccp: 'CallEnd', callId: call.id, text: 'Связь с собеседником потеряна' });
    }
    dev.note('CME: ephone-' + reg.ephone + ' снят с регистрации (' + text + ')', null, 'info');
    if (!conn.done) conn.close();
    dev.net.emit('config', { dev });
  }

  function cmeResetAll(dev, only) {
    for (const r of [...dev.cmeRt.regs.values()]) {
      if (only != null && r.ephone !== only) continue;
      const c = r.conn;
      cmeDrop(dev, c, 'reset');
    }
  }

  NS.deviceExt.push({
    key: 'cme',
    applies: (d) => d.type === 'router',
    save(d) {
      const c = d.cme;
      if (!c) return null;
      return {
        on: !!c.on, maxEphones: c.maxEphones, maxDn: c.maxDn, source: c.source != null ? U.ipStr(c.source) : null, port: c.port, auto: c.auto, message: c.message || '',
        dns: JSON.parse(JSON.stringify(c.dns)),
        ephones: Object.fromEntries(Object.entries(c.ephones).map(([k, e]) => [k, { mac: e.mac, type: e.type, buttons: Object.assign({}, e.buttons) }])),
      };
    },
    load(d, c) {
      d.cme = null;
      if (!c) return;
      d.cme = {
        on: !!c.on, maxEphones: Number(c.maxEphones) || 0, maxDn: Number(c.maxDn) || 0, source: c.source ? U.parseIp(c.source) : null, port: Number(c.port) || SCCP_PORT,
        auto: c.auto && Number.isInteger(c.auto.from) ? { from: c.auto.from, to: c.auto.to } : null, message: String(c.message || ''),
        dns: c.dns || {}, ephones: c.ephones || {},
      };
      cmeListen(d);
    },
  });

  /* ================= описание пакетов ================= */

  const SCCP_TEXT = {
    Register: (d) => 'регистрация телефона ' + macDots(d.mac) + ' (' + d.type + ')',
    RegisterAck: (d) => 'регистрация принята' + (d.lines && d.lines.length ? ', номер ' + d.lines[0].number : ', без номера'),
    RegisterReject: (d) => 'отказ в регистрации: ' + d.text,
    Dial: (d) => 'набран номер ' + d.number,
    Ringback: (d) => 'вызов ' + d.number + ' — у абонента звонит',
    Ring: (d) => 'входящий вызов от ' + d.from,
    Answer: () => 'трубка снята',
    Connected: (d) => 'соединение установлено, голос на ' + U.ipStr(d.peerIp) + ':' + d.port,
    Hangup: () => 'трубка положена',
    CallEnd: (d) => 'вызов завершён' + (d.text ? ': ' + d.text : ''),
    Busy: (d) => 'занято: ' + d.text,
    Error: (d) => 'ошибка: ' + d.text,
  };
  const sccpOf = (f) => {
    if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'TCP') return null;
    const s = f.payload.payload;
    return s && (s.sport === SCCP_PORT || s.dport === SCCP_PORT) && s.data && s.data.sccp ? s.data : null;
  };
  const rtpOf = (f) => {
    if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'UDP') return null;
    const d = f.payload.payload && f.payload.payload.data;
    return d && d.rtp ? d : null;
  };

  P.register({
    protocols: { SCCP: { label: 'SCCP (Skinny)', color: '#0e7490' }, RTP: { label: 'RTP (голос)', color: '#15803d' } },
    classify(f) {
      if (sccpOf(f)) return 'SCCP';
      if (rtpOf(f)) return 'RTP';
      return null;
    },
    summary(f) {
      const d = sccpOf(f);
      const route = () => U.ipStr(f.payload.src) + ' → ' + U.ipStr(f.payload.dst);
      if (d) return 'SCCP: ' + (SCCP_TEXT[d.sccp] ? SCCP_TEXT[d.sccp](d) : d.sccp) + ', ' + route();
      const r = rtpOf(f);
      if (r) return 'RTP (голос, ' + r.codec + ') №' + r.seq + (r.text ? ': «' + r.text + '»' : '') + ', ' + route();
      return null;
    },
    extraLayers(f, out) {
      const d = sccpOf(f);
      if (d) {
        const fields = [['Сообщение', d.sccp], ['Смысл', SCCP_TEXT[d.sccp] ? SCCP_TEXT[d.sccp](d) : '']];
        if (d.mac) fields.push(['MAC телефона', macDots(d.mac)]);
        if (d.callId != null) fields.push(['Номер вызова', String(d.callId)]);
        out.push({ title: 'SCCP — Skinny Client Control Protocol (уровень 7)', fields });
        return;
      }
      const r = rtpOf(f);
      if (r) out.push({ title: 'RTP — голос в реальном времени', fields: [['Кодек', r.codec], ['Номер пакета', String(r.seq)], ['Содержимое', r.text ? '«' + r.text + '»' : '(голос)']] });
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;

  X.global.push((t) => /^(telephony-service|ephone-dn|ephone|dial-peer)$/i.test(t[0] || ''));

  X.modes.telephony = {
    prompt: () => '(config-telephony)#',
    tree: ['max-ephones WORD', 'max-dn WORD', 'ip source-address A.B.C.D port 2000', 'auto assign WORD to WORD', 'create cnf-files', 'system message WORD'],
    run(dev, s, t, io, C) {
      const c = cmeCfg(dev);
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'max-ephones', 5)) {
        const n = Number(a[1]);
        if (!neg && !(n >= 0 && n <= 240)) { C.invalid(io, a[1]); return; }
        C.withMutate(io, () => { c.maxEphones = neg ? 0 : n; });
        return;
      }
      if (C.kw(a[0], 'max-dn', 5)) {
        const n = Number(a[1]);
        if (!neg && !(n >= 0 && n <= 720)) { C.invalid(io, a[1]); return; }
        C.withMutate(io, () => { c.maxDn = neg ? 0 : n; });
        return;
      }
      if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'source-address', 2)) {
        if (neg) { C.withMutate(io, () => { c.source = null; }); cmeListen(dev); return; }
        const v = U.parseIp(a[2] || '');
        if (v == null) { C.incomplete(io); return; }
        const pi = a.findIndex((x) => C.kw(x, 'port', 1));
        const port = pi > 0 ? Number(a[pi + 1]) : SCCP_PORT;
        if (!(port >= 2000 && port <= 9999)) { C.invalid(io, a[pi + 1]); return; }
        if (!dev.hasIp(v)) io.out('% Адрес ' + U.ipStr(v) + ' не назначен ни одному интерфейсу — телефоны не смогут зарегистрироваться', 'hint');
        C.withMutate(io, () => { c.source = v; c.port = port; });
        cmeListen(dev);
        return;
      }
      if (C.kw(a[0], 'auto', 2) && C.kw(a[1], 'assign', 2)) {
        if (neg) { C.withMutate(io, () => { c.auto = null; }); return; }
        const from = Number(a[2]);
        const ti = a.findIndex((x) => C.kw(x, 'to', 2));
        const to = ti > 0 ? Number(a[ti + 1]) : from;
        if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) { C.incomplete(io); return; }
        C.withMutate(io, () => { c.auto = { from, to }; });
        return;
      }
      if (C.kw(a[0], 'system', 2) && C.kw(a[1], 'message', 1)) { C.withMutate(io, () => { c.message = neg ? '' : a.slice(2).join(' '); }); return; }
      if (C.kw(a[0], 'create', 2)) { io.out('Creating CNF files'); return; }
      if (C.kw(a[0], 'reset', 3) || C.kw(a[0], 'restart', 3)) { cmeResetAll(dev, null); return; }
      if (C.kw(a[0], 'load', 2) || C.kw(a[0], 'keepalive', 2) || C.kw(a[0], 'max-conferences', 5) || C.kw(a[0], 'time-format', 3) || C.kw(a[0], 'date-format', 3)) return;
      C.invalid(io, a[0]);
    },
  };

  X.modes['ephone-dn'] = {
    prompt: () => '(config-ephone-dn)#',
    tree: ['number WORD', 'name WORD'],
    run(dev, s, t, io, C) {
      const dn = cmeCfg(dev).dns[s.ctx];
      if (!dn) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'number', 1)) {
        const n = a[1] || '';
        if (!neg && !/^[0-9*#]{1,16}$/.test(n)) { C.invalid(io, n); return; }
        const dup = !neg && Object.entries(cmeCfg(dev).dns).find(([k, v]) => k !== String(s.ctx) && v.number === n);
        if (dup) { io.out('% Number ' + n + ' уже назначен ephone-dn ' + dup[0]); return; }
        C.withMutate(io, () => { dn.number = neg ? '' : n; });
        return;
      }
      if (C.kw(a[0], 'name', 2)) { C.withMutate(io, () => { dn.name = neg ? '' : a.slice(1).join(' '); }); return; }
      if (C.kw(a[0], 'label', 2) || C.kw(a[0], 'description', 2) || C.kw(a[0], 'call-forward', 2)) return;
      C.invalid(io, a[0]);
    },
  };

  X.modes.ephone = {
    prompt: () => '(config-ephone)#',
    tree: ['mac-address H.H.H', 'type 7960', 'type CIPC', 'button 1:1', 'restart', 'reset'],
    run(dev, s, t, io, C) {
      const c = cmeCfg(dev);
      const e = c.ephones[s.ctx];
      if (!e) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'mac-address', 2)) {
        const m = hex12(a[1]);
        if (!neg && m.length !== 12) { C.invalid(io, a[1]); return; }
        C.withMutate(io, () => { e.mac = neg ? '' : m; });
        return;
      }
      if (C.kw(a[0], 'type', 1)) { C.withMutate(io, () => { e.type = neg ? '7960' : /^cipc$/i.test(a[1] || '') ? 'CIPC' : '7960'; }); return; }
      if (C.kw(a[0], 'button', 1)) {
        if (neg) { C.withMutate(io, () => { e.buttons = {}; }); return; }
        const next = {};
        for (const x of a.slice(1)) {
          const m = /^(\d+)[:sbfox](\d+)$/i.exec(x);
          if (!m) { C.invalid(io, x); return; }
          if (!c.dns[m[2]]) { io.out('% ephone-dn ' + m[2] + ' не существует'); return; }
          next[m[1]] = Number(m[2]);
        }
        C.withMutate(io, () => { e.buttons = next; });
        return;
      }
      if (C.kw(a[0], 'restart', 3) || C.kw(a[0], 'reset', 3)) { cmeResetAll(dev, Number(s.ctx)); return; }
      if (C.kw(a[0], 'device-security-mode', 2) || C.kw(a[0], 'username', 2)) return;
      C.invalid(io, a[0]);
    },
  };

  X.config.push((dev, s, a, neg, io, C) => {
    if (dev.type === 'switch' && C.kw(a[0], 'mls', 3)) return true;
    if (dev.type !== 'router') return false;
    if (C.kw(a[0], 'telephony-service', 5)) {
      const c = cmeCfg(dev);
      if (neg) {
        C.withMutate(io, () => { c.on = false; });
        cmeResetAll(dev, null);
        cmeListen(dev);
        return true;
      }
      if (!c.on) C.withMutate(io, () => { c.on = true; });
      cmeListen(dev);
      s.mode = 'telephony';
      s.ctx = null;
      return true;
    }
    if (C.kw(a[0], 'ephone-dn', 7)) {
      const n = Number(a[1]);
      if (!Number.isInteger(n) || n < 1) { C.incomplete(io); return true; }
      const c = cmeCfg(dev);
      if (neg) { C.withMutate(io, () => { delete c.dns[n]; for (const e of Object.values(c.ephones)) for (const [b, tg] of Object.entries(e.buttons)) if (tg === n) delete e.buttons[b]; }); return true; }
      if (!c.dns[n]) {
        if (!c.on) { io.out('% Сначала настройте telephony-service'); return true; }
        if (n > c.maxDn) { io.out('% ephone-dn ' + n + ' больше max-dn (' + c.maxDn + '): увеличьте max-dn в telephony-service'); return true; }
        C.withMutate(io, () => { c.dns[n] = { number: '', name: '' }; });
        io.out('%LINK-3-UPDOWN: Interface ephone_dsp DN ' + n + '.1, changed state to up');
      }
      s.mode = 'ephone-dn';
      s.ctx = n;
      return true;
    }
    if (C.kw(a[0], 'ephone', 6)) {
      const n = Number(a[1]);
      if (!Number.isInteger(n) || n < 1) { C.incomplete(io); return true; }
      const c = cmeCfg(dev);
      if (neg) { C.withMutate(io, () => { delete c.ephones[n]; }); cmeResetAll(dev, n); return true; }
      if (!c.ephones[n]) {
        if (!c.on) { io.out('% Сначала настройте telephony-service'); return true; }
        if (n > c.maxEphones) { io.out('% ephone ' + n + ' больше max-ephones (' + c.maxEphones + ')'); return true; }
        C.withMutate(io, () => { c.ephones[n] = { mac: '', type: '7960', buttons: {} }; });
      }
      s.mode = 'ephone';
      s.ctx = n;
      return true;
    }
    if (C.kw(a[0], 'dial-peer', 6)) { io.out('% dial-peer между разными CME в NetLab не поддерживается'); return true; }
    return false;
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (dev.type !== 'switch') return false;
    const ports = targets.filter((r) => r.kind === 'port' && r.sub == null).map((r) => r.port);
    if (C.kw(a[0], 'switchport', 2) && C.kw(a[1], 'voice', 1)) {
      if (!C.kw(a[2], 'vlan', 1)) { C.invalid(io, a[2]); return true; }
      const v = neg ? null : Number(a[3]);
      if (!neg && !(Number.isInteger(v) && v >= 1 && v <= 4094)) { C.invalid(io, a[3]); return true; }
      if (v != null && !dev.vlans.has(v)) {
        io.out('% Voice VLAN does not exist. Creating vlan ' + v);
        C.withMutate(io, () => dev.addVlan(v));
      }
      C.withMutate(io, () => { for (const i of ports) dev.ports[i].voiceVlan = v; });
      for (const i of ports) {
        const pr = dev.net.peer(dev, i);
        if (pr && pr.dev.cdpUpdate) pr.dev.cdpUpdate();
      }
      return true;
    }
    if (C.kw(a[0], 'mls', 3) || C.kw(a[0], 'auto', 2) && C.kw(a[1], 'qos', 1)) return true;
    // на коммутаторах 3-го уровня (3560) транк сначала требует выбора инкапсуляции
    if (C.kw(a[0], 'switchport', 2) && C.kw(a[1], 'trunk', 2) && C.kw(a[2], 'encapsulation', 2)) {
      if (!dev.l3) { C.invalid(io, a[1]); return true; }
      if (!neg && !/^(dot1q|negotiate)$/i.test(a[3] || '')) { C.invalid(io, a[3]); return true; }
      return true;
    }
    if (C.kw(a[0], 'power', 3) && C.kw(a[1], 'inline', 3)) {
      if (!dev.spec.poe) { io.out('% Коммутатор ' + dev.model + ' не поддерживает PoE (нужен 3560-24PS)'); return true; }
      const off = !neg && C.kw(a[2], 'never', 1);
      C.withMutate(io, () => { for (const i of ports) dev.ports[i].poe = off ? false : undefined; });
      dev.net.refreshTopology();
      return true;
    }
    return false;
  });

  X.running.iface.push((dev, f, p) => {
    if (!p || dev.type !== 'switch') return [];
    const L = [];
    if (p.voiceVlan != null) L.push(' switchport voice vlan ' + p.voiceVlan);
    if (p.poe === false) L.push(' power inline never');
    return L;
  });

  X.running.global.push((dev) => {
    const c = dev.cme;
    if (!c) return [];
    const L = [];
    if (c.on) {
      L.push('telephony-service');
      if (c.maxEphones) L.push(' max-ephones ' + c.maxEphones);
      if (c.maxDn) L.push(' max-dn ' + c.maxDn);
      if (c.source != null) L.push(' ip source-address ' + U.ipStr(c.source) + ' port ' + c.port);
      if (c.auto) L.push(' auto assign ' + c.auto.from + ' to ' + c.auto.to);
      if (c.message) L.push(' system message ' + c.message);
      L.push('!');
    }
    for (const [n, d] of Object.entries(c.dns).sort((x, y) => x[0] - y[0])) {
      L.push('ephone-dn ' + n);
      if (d.number) L.push(' number ' + d.number);
      if (d.name) L.push(' name ' + d.name);
      L.push('!');
    }
    for (const [n, e] of Object.entries(c.ephones).sort((x, y) => x[0] - y[0])) {
      L.push('ephone ' + n, ' device-security-mode none');
      if (e.mac) L.push(' mac-address ' + macDots(e.mac));
      L.push(' type ' + e.type);
      const b = Object.entries(e.buttons || {}).sort((x, y) => x[0] - y[0]).map(([k, v]) => k + ':' + v).join(' ');
      if (b) L.push(' button ' + b);
      L.push('!');
    }
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (dev.type === 'switch' && C.kw(a[0], 'power', 2) && C.kw(a[1], 'inline', 3)) {
      if (!dev.spec.poe) { io.out('% PoE не поддерживается на ' + dev.model); return true; }
      const rows = [];
      let used = 0;
      dev.ports.forEach((p, i) => {
        if (!NS.Network.isData(p) || !/^Fast/.test(p.name)) return;
        const pr = p.link ? dev.net.peer(dev, i) : null;
        const pd = pr && pr.dev.powerSource && pr.dev.powerSource() === 'poe' ? pr.dev : null;
        const w = pd ? Number(pd.attrs.wattage) || 6.3 : 0;
        used += w;
        rows.push(C.pad(C.shortIf(p.name), 10) + C.pad(p.poe === false ? 'off' : 'auto', 6) + C.pad(pd ? 'on' : 'off', 11) + C.pad(w.toFixed(1), 8) + C.pad(pd ? 'IP Phone ' + pd.model : 'n/a', 20) + C.pad(pd ? '2' : 'n/a', 6) + '15.4');
      });
      io.out('Available:370.0(w)  Used:' + used.toFixed(1) + '(w)  Remaining:' + (370 - used).toFixed(1) + '(w)');
      io.out('');
      io.out('Interface Admin  Oper       Power   Device              Class Max');
      io.out('                            (Watts)');
      io.out('--------- ------ ---------- ------- ------------------- ----- ----');
      rows.forEach((r) => io.out(r));
      return true;
    }
    if (dev.type !== 'router') return false;
    const c = dev.cme || cmeCfg(dev);
    const rt = dev.cmeRt;
    if (C.kw(a[0], 'ephone', 6)) {
      const list = Object.entries(c.ephones).sort((x, y) => x[0] - y[0]);
      for (const [n, e] of list) {
        const reg = rt.regs.get(e.mac);
        const call = reg ? callOf(dev, reg) : null;
        io.out('ephone-' + n + '[' + (Number(n) - 1) + '] Mac:' + (e.mac ? macDots(e.mac) : 'не задан') + ' TCP socket:[' + (reg ? n : -1) + '] activeLine:' + (call ? 1 : 0) + ' ' + (reg ? 'REGISTERED in SCCP ver 12/12' : 'UNREGISTERED'));
        io.out('mediaActive:' + (call && call.state === 'connected' ? 1 : 0) + ' offhook:' + (call ? 1 : 0) + ' ringing:' + (call && call.state === 'ringing' && call.b === e.mac ? 1 : 0) + ' reset:0 debug:0');
        io.out('IP:' + (reg ? U.ipStr(reg.ip) : '0.0.0.0') + ' * ' + e.type + '  keepalive ' + (reg ? 1 : 0) + ' max_line 6');
        for (const l of linesOf(c, e)) io.out('button ' + l.button + ': dn ' + l.dn + '  number ' + l.number + ' CH1   ' + (call ? (call.state === 'connected' ? 'CONNECTED' : call.b === e.mac ? 'RINGING' : 'ALERTING') : 'IDLE'));
        io.out('');
      }
      if (!list.length) io.out('(телефонов нет: настройте telephony-service и подключите IP-телефоны)');
      return true;
    }
    if (C.kw(a[0], 'ephone-dn', 7)) {
      io.out('EDN TAG  NUMBER           NAME                 STATE      EPHONE');
      io.out('-------  ---------------  -------------------  ---------  ------');
      const used = {};
      for (const [n, e] of Object.entries(c.ephones)) for (const t of Object.values(e.buttons || {})) used[t] = n;
      for (const [n, d] of Object.entries(c.dns).sort((x, y) => x[0] - y[0])) {
        const eph = used[n];
        const reg = eph ? rt.regs.get(c.ephones[eph].mac) : null;
        const call = reg ? callOf(dev, reg) : null;
        io.out(C.pad(n, 9) + C.pad(d.number || '-', 17) + C.pad(d.name || '', 21) + C.pad(!reg ? 'DOWN' : call ? (call.state === 'connected' ? 'CONNECTED' : 'RINGING') : 'IDLE', 11) + (eph || '-'));
      }
      return true;
    }
    if (C.kw(a[0], 'telephony-service', 5)) {
      if (!c.on) { io.out('% telephony-service не настроен'); return true; }
      io.out('CONFIG (Version=4.1(0))');
      io.out('=====================');
      io.out('ip source-address ' + (c.source != null ? U.ipStr(c.source) : '(не задан)') + ' port ' + c.port);
      io.out('max-ephones ' + c.maxEphones + ', max-dn ' + c.maxDn + ', зарегистрировано: ' + rt.regs.size);
      io.out('auto assign ' + (c.auto ? c.auto.from + ' to ' + c.auto.to : '(выключено)'));
      if (c.message) io.out('system message ' + c.message);
      io.out('активных вызовов: ' + [...rt.calls.values()].filter((x) => x.state === 'connected').length);
      return true;
    }
    return false;
  });

  X.tree.config = (X.tree.config || []).concat(['telephony-service', 'ephone-dn WORD', 'ephone WORD']);
  X.tree.if = (X.tree.if || []).concat(['switchport voice vlan WORD', 'mls qos trust cos', 'power inline auto', 'power inline never']);
  X.tree.exec = (X.tree.exec || []).concat(['show ephone', 'show ephone-dn', 'show telephony-service', 'show power inline']);

  NS.voip = { SccpClient, SCCP_PORT, RTP_BASE, macDots };
})(globalThis.NetLab = globalThis.NetLab || {});
