/* NetLab — безопасность 2-го уровня на коммутаторе:
 *  • DHCP snooping: ответы DHCP-сервера только с доверенных портов, таблица привязок, limit rate (err-disable);
 *  • Dynamic ARP Inspection: ARP с недоверенных портов сверяется с привязками DHCP snooping и ARP ACL;
 *  • 802.1X: порт закрыт до проверки пользователя (EAPOL ↔ коммутатор ↔ RADIUS, EAP-MD5), супликант на ПК.
 * Проверки выполняются в Switch.ingress до изучения MAC-адреса. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const Switch = NS.Switch;
  const X = NS.cliIos.ext;
  const C0 = NS.cliIos.ctx;
  const PAE_MAC = '01:80:C2:00:00:03';
  const short = (n) => C0.shortIf(n);
  const cmac = (m) => U.ciscoMac(m);

  const inList = (list, v) => (list || []).includes(v);
  function vlanListStr(list) {
    const v = [...new Set(list)].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < v.length; i++) {
      let j = i;
      while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
      out.push(j > i ? v[i] + '-' + v[j] : String(v[i]));
      i = j;
    }
    return out.join(',');
  }

  function snoopCfg(d) { if (!d.snoop) d.snoop = { on: false, vlans: [], opt82: true }; return d.snoop; }
  function snoopRt(d) { if (!d.snoopRt) d.snoopRt = { bindings: new Map(), pend: new Map(), rate: new Map() }; return d.snoopRt; }
  function daiCfg(d) { if (!d.dai) d.dai = { vlans: [], validate: { src: false, dst: false, ip: false }, filters: [] }; return d.dai; }
  function daiStats(d, vlan) {
    if (!d.daiStats) d.daiStats = new Map();
    if (!d.daiStats.has(vlan)) d.daiStats.set(vlan, { fwd: 0, drop: 0, dhcpDrop: 0, aclDrop: 0, aclPermit: 0, valDrop: 0 });
    return d.daiStats.get(vlan);
  }
  const snoopOn = (d, vlan) => !!d.snoop && d.snoop.on && inList(d.snoop.vlans, vlan);

  function dhcpOf(frame) {
    if (frame.type !== 'IPv4' || !frame.payload || frame.payload.proto !== 'UDP') return null;
    const u = frame.payload.payload;
    if (!u || !(u.dport === 67 || u.dport === 68) || !u.data || !u.data.op) return null;
    return u.data;
  }
  const SERVER_OPS = ['OFFER', 'ACK', 'NAK'];

  /* ================= DHCP snooping ================= */

  function snoop(dev, i, port, vlan, frame, lp) {
    const d = dhcpOf(frame);
    if (!d || !snoopOn(dev, vlan)) return true;
    const rt = snoopRt(dev);
    const trusted = !!port.snoopTrust;
    if (!trusted && port.snoopRate) {
      const now = dev.net.time;
      const r = rt.rate.get(i) || { start: now, n: 0 };
      if (now - r.start >= 100) { r.start = now; r.n = 0; }
      r.n++;
      rt.rate.set(i, r);
      if (r.n > port.snoopRate) {
        port.errDisabled = true;
        port.errReason = 'dhcp-rate-limit';
        if (dev.iosLog) {
          dev.iosLog('DHCP_SNOOPING', 4, 'DHCP_SNOOPING_ERRDISABLE_WARNING', 'DHCP Snooping received ' + r.n + ' DHCP packets on interface ' + short(port.name));
          dev.iosLog('PM', 4, 'ERR_DISABLE', 'dhcp-rate-limit error detected on ' + short(port.name) + ', putting ' + short(port.name) + ' in err-disable state');
        }
        dev.drop(frame, 'DHCP snooping: превышен limit rate ' + port.snoopRate + ' пакетов/с на ' + port.name + ' — порт в err-disabled');
        dev.timer(0, () => dev.net.refreshTopology());
        return false;
      }
    }
    if (SERVER_OPS.includes(d.op)) {
      if (!trusted) {
        if (dev.iosLog) dev.iosLog('DHCP_SNOOPING', 5, 'DHCP_SNOOPING_UNTRUSTED_PORT', 'DHCP_SNOOPING drop message on untrusted port, message type: DHCP' + d.op + ', MAC sa: ' + cmac(frame.src));
        dev.drop(frame, 'DHCP snooping: ответ DHCP-сервера (' + d.op + ') на недоверенном порту ' + port.name + ' — поддельный сервер? (ip dhcp snooping trust — на порту к настоящему серверу)');
        return false;
      }
      if (d.op === 'ACK' && d.yiaddr != null) {
        const pend = rt.pend.get(d.chaddr);
        const e = pend || [...dev.macTable.values()].find((x) => x.mac === d.chaddr && x.vlan === vlan);
        rt.bindings.set(d.chaddr, { mac: d.chaddr, ip: d.yiaddr, vlan, port: e ? e.port : lp, lease: 86400, time: dev.net.time });
        rt.pend.delete(d.chaddr);
        dev.net.emit('config', { dev });
      }
      if (d.op === 'NAK') rt.bindings.delete(d.chaddr);
      return true;
    }
    // сообщение клиента
    if (!trusted && d.chaddr && d.chaddr !== frame.src) {
      dev.drop(frame, 'DHCP snooping: MAC отправителя ' + frame.src + ' не совпадает с chaddr ' + d.chaddr);
      return false;
    }
    if (d.op === 'RELEASE' || d.op === 'DECLINE') rt.bindings.delete(d.chaddr);
    else if (!trusted) rt.pend.set(d.chaddr, { port: lp, vlan });
    return true;
  }

  /* ================= Dynamic ARP Inspection ================= */

  function arpAclMatch(dev, name, a) {
    const acl = dev.arpAcls && dev.arpAcls[name];
    if (!acl) return null;
    for (const r of acl) {
      if (r.ip != null && r.ip !== a.senderIp) continue;
      if (r.mac != null && r.mac !== a.senderMac) continue;
      return r.action;
    }
    return null;
  }

  function dai(dev, i, port, vlan, frame) {
    if (frame.type !== 'ARP' || !dev.dai || !inList(dev.dai.vlans, vlan) || port.daiTrust) return true;
    const a = frame.payload;
    const st = daiStats(dev, vlan);
    const deny = (why, kind) => {
      st.drop++;
      if (kind) st[kind]++;
      if (dev.iosLog) dev.iosLog('SW_DAI', 4, kind === 'aclDrop' ? 'ACL_DENY' : 'DHCP_SNOOPING_DENY', '1 Invalid ARPs (' + (a.op === 'reply' ? 'Res' : 'Req') + ') on ' + short(port.name) + ', vlan ' + vlan + '.([' + cmac(a.senderMac) + '/' + U.ipStr(a.senderIp) + '/' + cmac(a.targetMac || '00:00:00:00:00:00') + '/' + U.ipStr(a.targetIp) + ']');
      dev.drop(frame, 'DAI: ' + why);
      return false;
    };
    const v = dev.dai.validate;
    if (v.src && frame.src !== a.senderMac) return deny('MAC источника кадра ' + frame.src + ' не совпадает с MAC отправителя в ARP (validate src-mac)', 'valDrop');
    if (v.dst && a.op === 'reply' && frame.dst !== a.targetMac) return deny('MAC получателя не совпадает с target MAC в ARP-ответе (validate dst-mac)', 'valDrop');
    if (v.ip && (a.senderIp === 0 || a.senderIp === U.BROADCAST_IP || (a.senderIp >>> 28) === 14)) return deny('недопустимый IP отправителя (validate ip)', 'valDrop');
    if (a.senderIp === 0) { st.fwd++; return true; } // ARP-проба при проверке адреса
    for (const f of dev.dai.filters.filter((x) => x.vlan === vlan)) {
      const r = arpAclMatch(dev, f.acl, a);
      if (r === 'permit') { st.fwd++; st.aclPermit++; return true; }
      if (r === 'deny') return deny('ARP ACL ' + f.acl + ' запрещает ' + U.ipStr(a.senderIp) + ' / ' + a.senderMac, 'aclDrop');
      if (f.static) return deny('нет разрешения в ARP ACL ' + f.acl + ' (static — привязки DHCP не проверяются)', 'aclDrop');
    }
    const b = dev.snoopRt && dev.snoopRt.bindings.get(a.senderMac);
    if (b && b.ip === a.senderIp && b.vlan === vlan) { st.fwd++; return true; }
    return deny('нет привязки DHCP snooping для ' + U.ipStr(a.senderIp) + ' / ' + a.senderMac + ' — подмена ARP? (для статических адресов — ARP ACL или ip arp inspection trust)', 'dhcpDrop');
  }

  /* ================= 802.1X: коммутатор (authenticator) ================= */

  const dot1xActive = (dev, p) => !!dev.dot1xSys && !!p.dot1x && (p.dot1x.control === 'auto' || p.dot1x.control === 'force-unauthorized');
  function xrt(p) { if (!p.dot1xRt) p.dot1xRt = { state: 'unauthorized', user: null, mac: null, id: 0, challenge: null, method: null }; return p.dot1xRt; }
  const authorized = (dev, p) => !dot1xActive(dev, p) || (p.dot1x.control === 'auto' && xrt(p).state === 'authorized');

  function eapSend(dev, i, eap, why) {
    const p = dev.ports[i];
    const rt = xrt(p);
    dev.send(i, P.frame(dev.baseMac, rt.mac || PAE_MAC, 'EAPOL', { eapol: 'eap', eap }, null), why);
  }

  function authenticator(dev, i, port, frame) {
    const m = frame.payload || {};
    if (!dot1xActive(dev, port)) {
      dev.drop(frame, 'EAPOL: 802.1X на порту ' + port.name + ' не включён' + (port.dot1x && !dev.dot1xSys ? ' (нет dot1x system-auth-control)' : ''));
      return;
    }
    const rt = xrt(port);
    rt.mac = frame.src;
    if (port.dot1x.control === 'force-unauthorized') { eapSend(dev, i, { code: 'failure', id: rt.id }, 'EAP-Failure: порт принудительно закрыт (force-unauthorized)'); return; }
    if (m.eapol === 'start') {
      rt.state = 'connecting';
      rt.id = (rt.id + 1) % 256;
      if (dev.iosLog) dev.iosLog('AUTHMGR', 5, 'START', "Starting 'dot1x' for client (" + cmac(frame.src) + ") on Interface " + short(port.name));
      eapSend(dev, i, { code: 'request', id: rt.id, type: 'identity' }, 'EAP-Request/Identity: кто вы?');
      return;
    }
    if (m.eapol === 'logoff') { rt.state = 'unauthorized'; rt.user = null; dev.net.emit('config', { dev }); return; }
    const e = m.eap || {};
    if (e.code !== 'response') return;
    if (e.type === 'identity') {
      rt.user = e.user;
      rt.id = (rt.id + 1) % 256;
      rt.challenge = Math.random().toString(16).slice(2, 10).toUpperCase();
      rt.state = 'authenticating';
      eapSend(dev, i, { code: 'request', id: rt.id, type: 'md5', challenge: rt.challenge }, 'EAP-Request/MD5-Challenge для ' + e.user);
      return;
    }
    if (e.type === 'md5' && rt.state === 'authenticating') {
      const methods = (dev.aaa && dev.aaa.newModel && dev.aaa.dot1x) || null;
      const fail = (text) => {
        rt.state = 'held';
        if (dev.iosLog) dev.iosLog('DOT1X', 5, 'FAIL', 'Authentication failed for client (' + cmac(rt.mac) + ') on Interface ' + short(port.name) + (text ? ' (' + text + ')' : ''));
        eapSend(dev, i, { code: 'failure', id: rt.id }, 'EAP-Failure: ' + (text || 'проверка не пройдена'));
        dev.net.emit('config', { dev });
      };
      if (!methods || !methods.includes('group radius')) { fail('нет aaa authentication dot1x default group radius'); return; }
      const user = rt.user;
      NS.aaa.radiusAuth(dev, { user, eap: { id: rt.id, challenge: rt.challenge, value: e.value } }, (r) => {
        if (!port.oper || xrt(port).user !== user) return;
        if (r.result === 'accept') {
          rt.state = 'authorized';
          rt.method = 'dot1x';
          if (dev.iosLog) {
            dev.iosLog('DOT1X', 5, 'SUCCESS', 'Authentication successful for client (' + cmac(rt.mac) + ') on Interface ' + short(port.name));
            dev.iosLog('AUTHMGR', 5, 'SUCCESS', 'Authorization succeeded for client (' + cmac(rt.mac) + ') on Interface ' + short(port.name));
          }
          eapSend(dev, i, { code: 'success', id: rt.id }, 'EAP-Success: пользователь ' + user + ' проверен RADIUS-сервером — порт открыт');
          dev.net.emit('config', { dev });
        } else fail(r.result === 'reject' ? 'RADIUS Access-Reject' : r.text);
      });
    }
  }

  /* ================= вход кадра на коммутатор ================= */

  Switch.ingress.push(function (i, port, vlan, frame, lp) {
    if (frame.type === 'EAPOL') { authenticator(this, i, port, frame); return false; }
    if (!authorized(this, port)) {
      this.drop(frame, '802.1X: порт ' + port.name + ' не авторизован — пропускаются только кадры EAPOL');
      return false;
    }
    if (!snoop(this, i, port, vlan, frame, lp)) return false;
    if (!dai(this, i, port, vlan, frame)) return false;
    return true;
  });

  const egressBase = Switch.prototype.egress;
  Switch.prototype.egress = function (j, vlan, frame, why) {
    const p = this.ports[j];
    if (p && frame.type !== 'EAPOL' && !authorized(this, p)) return false;
    return egressBase.call(this, j, vlan, frame, why);
  };

  const swLink = Switch.prototype.onLinkChange;
  Switch.prototype.onLinkChange = function (i, up) {
    swLink.call(this, i, up);
    const p = this.ports[i];
    if (p && p.dot1xRt && !up) { p.dot1xRt = null; this.net.emit('config', { dev: this }); }
    if (!up && this.snoopRt) {
      for (const [k, b] of this.snoopRt.bindings) if (b.port === i) this.snoopRt.bindings.delete(k);
    }
  };

  /* ================= 802.1X: компьютер (supplicant) ================= */

  function hostX(dev, f) { if (!dev.eapRt) dev.eapRt = new Map(); if (!dev.eapRt.has(f.id)) dev.eapRt.set(f.id, { state: 'idle', tries: 0, timer: null }); return dev.eapRt.get(f.id); }

  function eapolSend(dev, f, payload, why) {
    dev.ifaceSend(f, P.frame(dev.ifaceMac(f), PAE_MAC, 'EAPOL', payload, null), why);
  }

  IpNode.prototype.dot1xStart = function (f) {
    if (!f || !f.dot1x || !f.dot1x.enabled || !this.power || !this.ifaceUp(f)) return;
    const st = hostX(this, f);
    if (st.timer) st.timer.cancel();
    st.state = 'connecting';
    st.tries = 0;
    const attempt = () => {
      if (st.state !== 'connecting') return;
      if (++st.tries > 3) { st.state = 'no-response'; this.net.emit('config', { dev: this }); return; }
      eapolSend(this, f, { eapol: 'start' }, '802.1X: EAPOL-Start — прошу проверить меня' + (st.tries > 1 ? ' (попытка ' + st.tries + ')' : ''));
      st.timer = this.timer(300, attempt);
    };
    attempt();
  };

  IpNode.prototype.setDot1x = function (f, c) {
    f.dot1x = c && (c.enabled || c.user) ? { enabled: !!c.enabled, user: String(c.user || ''), pass: String(c.pass || '') } : null;
    if (this.eapRt) this.eapRt.delete(f.id);
    this.net.emit('config', { dev: this });
    if (f.dot1x && f.dot1x.enabled) this.dot1xStart(f);
  };

  IpNode.ethertypes.EAPOL = function (f, frame) {
    const m = frame.payload || {};
    if (!f.dot1x || !f.dot1x.enabled) { this.drop(frame, 'EAPOL: 802.1X на этом компьютере не включён (настройте на странице интерфейса)'); return; }
    const st = hostX(this, f);
    const e = m.eap || {};
    if (e.code === 'request' && e.type === 'identity') {
      if (st.timer) { st.timer.cancel(); st.timer = null; }
      st.state = 'authenticating';
      eapolSend(this, f, { eapol: 'eap', eap: { code: 'response', id: e.id, type: 'identity', user: f.dot1x.user } }, 'EAP-Response/Identity: я ' + f.dot1x.user);
      return;
    }
    if (e.code === 'request' && e.type === 'md5') {
      const value = NS.aaa.md5sim(e.id + f.dot1x.pass + e.challenge);
      eapolSend(this, f, { eapol: 'eap', eap: { code: 'response', id: e.id, type: 'md5', value } }, 'EAP-Response/MD5: ответ на вызов (пароль не передаётся)');
      return;
    }
    if (e.code === 'success') {
      st.state = 'authenticated';
      this.note('802.1X: проверка пройдена — сеть доступна', null, 'accept');
      this.net.emit('config', { dev: this });
      if (f.dhcp && this.startDhcp) this.timer(1, () => this.startDhcp());
      return;
    }
    if (e.code === 'failure') {
      st.state = 'failed';
      this.note('802.1X: проверка не пройдена (неверное имя или пароль?)', null, 'drop');
      this.net.emit('config', { dev: this });
    }
  };

  const hostLink = IpNode.prototype.onLinkChange;
  IpNode.prototype.onLinkChange = function (i, up) {
    hostLink.call(this, i, up);
    if (this.forwarding || !this.ifaces) return;
    for (const f of this.ifaces) {
      if (f.port !== i || !f.dot1x || !f.dot1x.enabled) continue;
      if (up) this.timer(3, () => this.dot1xStart(f));
      else if (this.eapRt) this.eapRt.delete(f.id);
    }
  };

  IpNode.hooks.runtime.push(function () {
    this.eapRt = null;
    if (!this.ifaces || this.forwarding) return;
    for (const f of this.ifaces) if (f.dot1x && f.dot1x.enabled) this.timer(5, () => this.dot1xStart(f));
  });

  IpNode.ifaceExt.push({
    key: 'dot1x',
    save(f) { return f.dot1x ? { enabled: f.dot1x.enabled, user: f.dot1x.user, pass: f.dot1x.pass } : null; },
    load(f, d) { f.dot1x = d ? { enabled: !!d.enabled, user: String(d.user || ''), pass: String(d.pass || '') } : null; },
  });

  /* ================= сохранение ================= */

  const serPort = Switch.prototype.serializePort;
  Switch.prototype.serializePort = function (p) {
    const o = serPort.call(this, p);
    if (!NS.Network.isData(p)) return o;
    if (p.snoopTrust) o.snoopTrust = true;
    if (p.snoopRate) o.snoopRate = p.snoopRate;
    if (p.daiTrust) o.daiTrust = true;
    if (p.dot1x) o.dot1x = { control: p.dot1x.control, pae: !!p.dot1x.pae };
    return o;
  };
  const loadPort = Switch.prototype.loadPort;
  Switch.prototype.loadPort = function (p, sp) {
    loadPort.call(this, p, sp);
    if (!NS.Network.isData(p)) return;
    p.snoopTrust = !!sp.snoopTrust;
    p.snoopRate = Number(sp.snoopRate) || null;
    p.daiTrust = !!sp.daiTrust;
    p.dot1x = sp.dot1x ? { control: String(sp.dot1x.control || 'auto'), pae: !!sp.dot1x.pae } : null;
    p.dot1xRt = null;
  };

  NS.deviceExt.push({
    key: 'l2sec',
    applies: (d) => d.type === 'switch',
    save(d) {
      const o = {};
      if (d.snoop && (d.snoop.on || d.snoop.vlans.length || !d.snoop.opt82)) o.snoop = { on: d.snoop.on, vlans: d.snoop.vlans.slice(), opt82: d.snoop.opt82 };
      if (d.dai && (d.dai.vlans.length || d.dai.filters.length || Object.values(d.dai.validate).some(Boolean))) o.dai = JSON.parse(JSON.stringify(d.dai));
      if (d.arpAcls && Object.keys(d.arpAcls).length) o.arpAcls = Object.fromEntries(Object.entries(d.arpAcls).map(([k, l]) => [k, l.map((r) => ({ action: r.action, ip: r.ip != null ? U.ipStr(r.ip) : null, mac: r.mac }))]));
      if (d.dot1xSys) o.dot1xSys = true;
      return Object.keys(o).length ? o : null;
    },
    load(d, c) {
      d.snoop = null;
      d.dai = null;
      d.arpAcls = null;
      d.dot1xSys = false;
      d.snoopRt = null;
      d.daiStats = null;
      if (!c) return;
      if (c.snoop) d.snoop = { on: !!c.snoop.on, vlans: (c.snoop.vlans || []).map(Number), opt82: c.snoop.opt82 !== false };
      if (c.dai) d.dai = { vlans: (c.dai.vlans || []).map(Number), validate: Object.assign({ src: false, dst: false, ip: false }, c.dai.validate || {}), filters: (c.dai.filters || []).map((f) => ({ acl: String(f.acl), vlan: Number(f.vlan), static: !!f.static })) };
      if (c.arpAcls) d.arpAcls = Object.fromEntries(Object.entries(c.arpAcls).map(([k, l]) => [k, (l || []).map((r) => ({ action: r.action === 'deny' ? 'deny' : 'permit', ip: r.ip ? U.parseIp(r.ip) : null, mac: r.mac || null }))]));
      d.dot1xSys = !!c.dot1xSys;
    },
  });

  /* ================= команды IOS ================= */

  const isSw = (dev) => dev.type === 'switch';

  X.global.push((t) => (/^arp$/i.test(t[0] || '') && /^access-list$/i.test(t[1] || '')) || (/^dot1x$/i.test(t[0] || '') && /^system-auth-control$/i.test(t[1] || '')) ||
    (/^ip$/i.test(t[0] || '') && /^arp$/i.test(t[1] || '') && /^inspection$/i.test(t[2] || '') && !/^(trust|limit)$/i.test(t[3] || '')));

  X.config.push((dev, s, a, neg, io, C) => {
    if (!isSw(dev)) return false;
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'dhcp', 2) && C.kw(a[2], 'snooping', 2)) {
      const c = snoopCfg(dev);
      if (!a[3]) { C.withMutate(io, () => { c.on = !neg; }); return true; }
      if (C.kw(a[3], 'vlan', 1)) {
        let vs;
        try { vs = [...(U.parseVlanList(a[4] || '') || [])]; } catch (e) { io.out('% ' + e.message); return true; }
        if (!vs || !vs.length) { C.incomplete(io); return true; }
        C.withMutate(io, () => { c.vlans = neg ? c.vlans.filter((v) => !vs.includes(v)) : [...new Set(c.vlans.concat(vs))].sort((x, y) => x - y); });
        return true;
      }
      if (C.kw(a[3], 'information', 1)) { C.withMutate(io, () => { c.opt82 = !neg; }); return true; }
      if (C.kw(a[3], 'verify', 2) || C.kw(a[3], 'database', 2)) return true;
      C.invalid(io, a[3]);
      return true;
    }
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'arp', 2) && C.kw(a[2], 'inspection', 2)) {
      const c = daiCfg(dev);
      if (C.kw(a[3], 'vlan', 1)) {
        let vs;
        try { vs = [...(U.parseVlanList(a[4] || '') || [])]; } catch (e) { io.out('% ' + e.message); return true; }
        if (!vs || !vs.length) { C.incomplete(io); return true; }
        C.withMutate(io, () => { c.vlans = neg ? c.vlans.filter((v) => !vs.includes(v)) : [...new Set(c.vlans.concat(vs))].sort((x, y) => x - y); });
        return true;
      }
      if (C.kw(a[3], 'validate', 2)) {
        const opts = a.slice(4);
        C.withMutate(io, () => {
          if (neg && !opts.length) { c.validate = { src: false, dst: false, ip: false }; return; }
          const set = { src: opts.some((x) => C.kw(x, 'src-mac', 1)), dst: opts.some((x) => C.kw(x, 'dst-mac', 1)), ip: opts.some((x) => C.kw(x, 'ip', 1)) };
          if (neg) { for (const k of Object.keys(set)) if (set[k]) c.validate[k] = false; } else c.validate = set;
        });
        return true;
      }
      if (C.kw(a[3], 'filter', 1)) {
        const acl = a[4];
        const vi = a.findIndex((x) => C.kw(x, 'vlan', 1));
        if (!acl || vi < 0) { C.incomplete(io); return true; }
        let vs;
        try { vs = [...(U.parseVlanList(a[vi + 1] || '') || [])]; } catch (e) { io.out('% ' + e.message); return true; }
        const stat = a.some((x) => C.kw(x, 'static', 2));
        C.withMutate(io, () => {
          c.filters = c.filters.filter((f) => !(f.acl === acl && vs.includes(f.vlan)));
          if (!neg) for (const v of vs) c.filters.push({ acl, vlan: v, static: stat });
        });
        return true;
      }
      if (C.kw(a[3], 'log-buffer', 2)) return true;
      C.invalid(io, a[3]);
      return true;
    }
    if (C.kw(a[0], 'arp', 3) && C.kw(a[1], 'access-list', 2)) {
      const name = a[2];
      if (!name) { C.incomplete(io); return true; }
      if (!dev.arpAcls) dev.arpAcls = {};
      if (neg) { C.withMutate(io, () => { delete dev.arpAcls[name]; }); return true; }
      if (!dev.arpAcls[name]) C.withMutate(io, () => { dev.arpAcls[name] = []; });
      s.mode = 'arpacl';
      s.arpAcl = name;
      return true;
    }
    if (C.kw(a[0], 'dot1x', 3) && C.kw(a[1], 'system-auth-control', 2)) {
      C.withMutate(io, () => { dev.dot1xSys = !neg; });
      dev.net.refreshTopology();
      return true;
    }
    return false;
  });

  /** permit ip host A mac host M | permit ip any mac any … */
  X.modes.arpacl = {
    prompt: () => '(config-arp-nacl)#',
    tree: ['permit ip host A.B.C.D mac host H.H.H', 'deny ip host A.B.C.D mac any', 'permit ip any mac any'],
    run(dev, s, t, io, C) {
      const acl = dev.arpAcls && dev.arpAcls[s.arpAcl];
      if (!acl) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      const action = C.kw(a[0], 'permit', 1) ? 'permit' : C.kw(a[0], 'deny', 1) ? 'deny' : null;
      if (!action) { C.invalid(io, a[0]); return; }
      if (!C.kw(a[1], 'ip', 1)) { C.invalid(io, a[1]); return; }
      let k = 2;
      let ipv = null;
      if (C.kw(a[k], 'host', 1)) { ipv = U.parseIp(a[k + 1] || ''); if (ipv == null) { C.invalid(io, a[k + 1]); return; } k += 2; } else if (C.kw(a[k], 'any', 1)) k++; else { C.invalid(io, a[k]); return; }
      if (!C.kw(a[k], 'mac', 1)) { C.incomplete(io); return; }
      k++;
      let mac = null;
      if (C.kw(a[k], 'host', 1)) {
        const m = String(a[k + 1] || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
        if (m.length !== 12) { C.invalid(io, a[k + 1]); return; }
        mac = m.match(/../g).join(':');
      } else if (!C.kw(a[k], 'any', 1)) { C.invalid(io, a[k]); return; }
      C.withMutate(io, () => {
        const i = acl.findIndex((r) => r.action === action && r.ip === ipv && r.mac === mac);
        if (neg) { if (i >= 0) acl.splice(i, 1); } else if (i < 0) acl.push({ action, ip: ipv, mac });
      });
    },
  };

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (!isSw(dev)) return false;
    const ports = targets.filter((r) => r.kind === 'port' && r.sub == null).map((r) => r.port);
    if (!ports.length) return false;
    const each = (fn) => C.withMutate(io, () => { for (const i of ports) fn(dev.ports[i], i); });
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'dhcp', 2) && C.kw(a[2], 'snooping', 2)) {
      if (C.kw(a[3], 'trust', 1)) { each((p) => { p.snoopTrust = !neg; }); return true; }
      if (C.kw(a[3], 'limit', 1) && C.kw(a[4], 'rate', 1)) {
        const n = Number(a[5]);
        if (!neg && !(Number.isInteger(n) && n >= 1 && n <= 2048)) { C.incomplete(io); return true; }
        each((p) => { p.snoopRate = neg ? null : n; });
        return true;
      }
      C.invalid(io, a[3]);
      return true;
    }
    if (C.kw(a[0], 'ip', 2) && C.kw(a[1], 'arp', 2) && C.kw(a[2], 'inspection', 2)) {
      if (C.kw(a[3], 'trust', 1)) { each((p) => { p.daiTrust = !neg; }); return true; }
      if (C.kw(a[3], 'limit', 1)) return true;
      C.invalid(io, a[3]);
      return true;
    }
    if (C.kw(a[0], 'authentication', 2) && C.kw(a[1], 'port-control', 2)) {
      const mode = neg ? null : ['auto', 'force-authorized', 'force-unauthorized'].find((x) => C.kw(a[2], x, x === 'auto' ? 1 : 7));
      if (!neg && !mode) { C.incomplete(io); return true; }
      const bad = ports.filter((i) => dev.ports[i].cfgMode !== 'access');
      if (!neg && bad.length) { io.out('% Command rejected: ' + bad.map((i) => short(dev.ports[i].name)).join(', ') + ' is not an access port.'); io.out('  (802.1X работает на access-портах: switchport mode access)', 'hint'); return true; }
      each((p) => { if (neg) { if (p.dot1x) p.dot1x.control = 'force-authorized'; if (p.dot1x && !p.dot1x.pae) p.dot1x = null; } else { p.dot1x = Object.assign({ pae: false }, p.dot1x || {}, { control: mode }); } p.dot1xRt = null; });
      dev.net.refreshTopology();
      return true;
    }
    if (C.kw(a[0], 'dot1x', 3)) {
      if (C.kw(a[1], 'pae', 1)) {
        each((p) => { if (neg) { if (p.dot1x) { p.dot1x.pae = false; if (p.dot1x.control === 'force-authorized') p.dot1x = null; } } else p.dot1x = Object.assign({ control: 'force-authorized' }, p.dot1x || {}, { pae: true }); });
        return true;
      }
      if (C.kw(a[1], 'port-control', 2)) { io.out('% Используйте authentication port-control auto (в новых IOS так)', 'hint'); return true; }
      if (C.kw(a[1], 'timeout', 1) || C.kw(a[1], 'max-reauth-req', 5) || C.kw(a[1], 'max-req', 5)) return true;
      C.invalid(io, a[1]);
      return true;
    }
    if (C.kw(a[0], 'authentication', 2) && (C.kw(a[1], 'periodic', 2) || C.kw(a[1], 'timer', 2) || C.kw(a[1], 'host-mode', 2))) return true;
    return false;
  });

  X.running.global.push((dev) => {
    if (!isSw(dev)) return [];
    const L = [];
    if (dev.dot1xSys) L.push('dot1x system-auth-control', '!');
    const c = dev.snoop;
    if (c) {
      if (c.vlans.length) L.push('ip dhcp snooping vlan ' + vlanListStr(c.vlans));
      if (!c.opt82) L.push('no ip dhcp snooping information option');
      if (c.on) L.push('ip dhcp snooping');
    }
    const d = dev.dai;
    if (d) {
      if (d.vlans.length) L.push('ip arp inspection vlan ' + vlanListStr(d.vlans));
      const v = [d.validate.src ? 'src-mac' : '', d.validate.dst ? 'dst-mac' : '', d.validate.ip ? 'ip' : ''].filter(Boolean);
      if (v.length) L.push('ip arp inspection validate ' + v.join(' '));
      const byAcl = new Map();
      for (const f of d.filters) { const k = f.acl + '|' + f.static; if (!byAcl.has(k)) byAcl.set(k, []); byAcl.get(k).push(f.vlan); }
      for (const [k, vs] of byAcl) { const [acl, st] = k.split('|'); L.push('ip arp inspection filter ' + acl + ' vlan ' + vlanListStr(vs) + (st === 'true' ? ' static' : '')); }
    }
    if (L.length && L[L.length - 1] !== '!') L.push('!');
    return L;
  });

  X.running.tail.push((dev) => {
    const L = [];
    for (const [k, l] of Object.entries(dev.arpAcls || {})) {
      L.push('arp access-list ' + k);
      for (const r of l) L.push(' ' + r.action + ' ip ' + (r.ip != null ? 'host ' + U.ipStr(r.ip) : 'any') + ' mac ' + (r.mac ? 'host ' + cmac(r.mac) : 'any'));
      L.push('!');
    }
    return L;
  });

  X.running.iface.push((dev, f, p) => {
    if (!isSw(dev) || !p) return [];
    const L = [];
    if (p.dot1x && p.dot1x.control && p.dot1x.control !== 'force-authorized') L.push(' authentication port-control ' + p.dot1x.control);
    if (p.dot1x && p.dot1x.pae) L.push(' dot1x pae authenticator');
    if (p.snoopTrust) L.push(' ip dhcp snooping trust');
    if (p.snoopRate) L.push(' ip dhcp snooping limit rate ' + p.snoopRate);
    if (p.daiTrust) L.push(' ip arp inspection trust');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!isSw(dev)) return false;
    if (C.kw(a[0], 'ip', 1) && C.kw(a[1], 'dhcp', 2) && C.kw(a[2], 'snooping', 2)) {
      const c = dev.snoop || { on: false, vlans: [], opt82: true };
      const rt = dev.snoopRt || { bindings: new Map() };
      if (C.kw(a[3], 'binding', 1)) {
        io.out('MacAddress          IpAddress        Lease(sec)  Type           VLAN  Interface');
        io.out('------------------  ---------------  ----------  -------------  ----  --------------------');
        for (const b of rt.bindings.values()) io.out(C.pad(b.mac, 20) + C.pad(U.ipStr(b.ip), 17) + C.pad(String(Math.max(0, b.lease - Math.floor((dev.net.time - b.time) / 100))), 12) + C.pad('dhcp-snooping', 15) + C.pad(String(b.vlan), 6) + (dev.ports[b.port] ? dev.ports[b.port].name : '?'));
        io.out('Total number of bindings: ' + rt.bindings.size);
        return true;
      }
      io.out('Switch DHCP snooping is ' + (c.on ? 'enabled' : 'disabled'));
      io.out('DHCP snooping is configured on following VLANs:');
      io.out(c.vlans.length ? vlanListStr(c.vlans) : 'none');
      io.out('DHCP snooping is operational on following VLANs:');
      io.out(c.on && c.vlans.length ? vlanListStr(c.vlans.filter((v) => dev.vlans.has(v))) : 'none');
      io.out('Insertion of option 82 is ' + (c.opt82 ? 'enabled' : 'disabled'));
      io.out('Interface                  Trusted    Allow option    Rate limit (pps)');
      io.out('-----------------------    -------    ------------    ----------------');
      for (const p of dev.ports) if (p.snoopTrust || p.snoopRate) io.out(C.pad(p.name, 27) + C.pad(p.snoopTrust ? 'yes' : 'no', 11) + C.pad(p.snoopTrust ? 'yes' : 'no', 16) + (p.snoopRate || 'unlimited'));
      return true;
    }
    if (C.kw(a[0], 'ip', 1) && C.kw(a[1], 'arp', 2) && C.kw(a[2], 'inspection', 2)) {
      const d = dev.dai || { vlans: [], validate: {}, filters: [] };
      if (C.kw(a[3], 'interfaces', 1)) {
        io.out(' Interface        Trust State     Rate (pps)    Burst Interval');
        io.out(' ---------------  -----------     ----------    --------------');
        for (const p of dev.ports) if (NS.Network.isData(p)) io.out(' ' + C.pad(short(p.name), 17) + C.pad(p.daiTrust ? 'Trusted' : 'Untrusted', 16) + C.pad(p.daiTrust ? 'None' : '15', 14) + (p.daiTrust ? 'N/A' : '1'));
        return true;
      }
      const onoff = (b) => (b ? 'Enabled' : 'Disabled');
      io.out('Source Mac Validation      : ' + onoff(d.validate.src));
      io.out('Destination Mac Validation : ' + onoff(d.validate.dst));
      io.out('IP Address Validation      : ' + onoff(d.validate.ip));
      io.out('');
      io.out(' Vlan     Configuration    Operation   ACL Match          Static ACL');
      io.out(' ----     -------------    ---------   ---------          ----------');
      for (const v of d.vlans) {
        const f = d.filters.find((x) => x.vlan === v);
        io.out(' ' + C.pad(String(v).padStart(4), 9) + C.pad('Enabled', 17) + C.pad(dev.vlans.has(v) ? 'Active' : 'Inactive', 12) + C.pad(f ? f.acl : '', 19) + (f ? (f.static ? 'Yes' : 'No') : ''));
      }
      io.out('');
      io.out(' Vlan      Forwarded        Dropped     DHCP Drops      ACL Drops');
      io.out(' ----      ---------        -------     ----------      ---------');
      for (const v of d.vlans) {
        const st = daiStats(dev, v);
        io.out(' ' + String(v).padStart(4) + String(st.fwd).padStart(15) + String(st.drop).padStart(15) + String(st.dhcpDrop).padStart(15) + String(st.aclDrop).padStart(15));
      }
      return true;
    }
    if ((C.kw(a[0], 'dot1x', 3) && (C.kw(a[1], 'all', 1) || C.kw(a[1], 'interface', 1) || !a[1])) || (C.kw(a[0], 'authentication', 2) && C.kw(a[1], 'sessions', 1))) {
      const ports = dev.ports.filter((p) => p.dot1x && (p.dot1x.control !== 'force-authorized' || p.dot1x.pae));
      if (C.kw(a[0], 'authentication', 2)) {
        io.out('Interface    MAC Address     Method   Domain   Status Fg  Session ID');
        for (const p of ports) {
          const rt = p.dot1xRt;
          if (!rt || !rt.mac) continue;
          io.out(C.pad(short(p.name), 13) + C.pad(cmac(rt.mac), 16) + C.pad('dot1x', 9) + C.pad('DATA', 9) + C.pad(rt.state === 'authorized' ? 'Auth' : rt.state === 'held' ? 'Unauth' : 'Running', 11) + '0A0A0A' + String(dev.ports.indexOf(p)).padStart(4, '0'));
        }
        return true;
      }
      io.out('Sysauthcontrol              ' + (dev.dot1xSys ? 'Enabled' : 'Disabled'));
      io.out('Dot1x Protocol Version            3');
      for (const p of ports) {
        io.out('');
        io.out('Dot1x Info for ' + p.name);
        io.out('-----------------------------------');
        io.out('PAE                       = ' + (p.dot1x.pae ? 'AUTHENTICATOR' : 'NONE'));
        io.out('PortControl               = ' + p.dot1x.control.toUpperCase().replace(/-/g, '_'));
        io.out('ControlDirection          = Both');
        io.out('HostMode                  = SINGLE_HOST');
        const rt = p.dot1xRt;
        io.out('Status                    = ' + (!dot1xActive(dev, p) ? 'AUTHORIZED (802.1X не активен)' : rt && rt.state === 'authorized' ? 'AUTHORIZED' : 'UNAUTHORIZED'));
        if (rt && rt.user) io.out('User                      = ' + rt.user);
      }
      return true;
    }
    return false;
  });

  X.tree.config = (X.tree.config || []).concat(['ip dhcp snooping', 'ip dhcp snooping vlan WORD', 'no ip dhcp snooping information option', 'ip arp inspection vlan WORD',
    'ip arp inspection validate src-mac', 'ip arp inspection filter WORD vlan WORD', 'arp access-list WORD', 'dot1x system-auth-control']);
  X.tree.if = (X.tree.if || []).concat(['ip dhcp snooping trust', 'ip dhcp snooping limit rate WORD', 'ip arp inspection trust', 'authentication port-control auto', 'dot1x pae authenticator']);
  X.tree.exec = (X.tree.exec || []).concat(['show ip dhcp snooping', 'show ip dhcp snooping binding', 'show ip arp inspection', 'show ip arp inspection interfaces', 'show dot1x all', 'show authentication sessions']);

  /* ---------- пакеты EAPOL ---------- */

  const EAP_NAMES = { start: 'EAPOL-Start', logoff: 'EAPOL-Logoff' };
  function eapTitle(m) {
    if (EAP_NAMES[m.eapol]) return EAP_NAMES[m.eapol];
    const e = m.eap || {};
    if (e.code === 'success') return 'EAP-Success';
    if (e.code === 'failure') return 'EAP-Failure';
    return 'EAP-' + (e.code === 'request' ? 'Request' : 'Response') + '/' + (e.type === 'md5' ? 'MD5-Challenge' : 'Identity') + (e.user ? ' (' + e.user + ')' : '');
  }
  P.register({
    protocols: { EAPOL: { label: '802.1X (EAPOL)', color: '#b45309' } },
    ethertypes: { EAPOL: '0x888E EAPOL (802.1X)' },
    classify(f) { return f.type === 'EAPOL' ? 'EAPOL' : null; },
    summary(f) { return f.type === 'EAPOL' ? '802.1X ' + eapTitle(f.payload || {}) : null; },
    layers(f) {
      if (f.type !== 'EAPOL') return null;
      const m = f.payload || {};
      const e = m.eap || {};
      const fields = [['Сообщение', eapTitle(m)]];
      if (e.id != null) fields.push(['EAP Identifier', String(e.id)]);
      if (e.challenge) fields.push(['Вызов (challenge)', e.challenge]);
      if (e.value) fields.push(['Ответ (MD5)', e.value]);
      return [P.l2Layer(f), { title: 'EAPOL / EAP', fields }];
    },
  });

  NS.l2sec = { snoopCfg, daiCfg, authorized, dot1xActive };
})(globalThis.NetLab = globalThis.NetLab || {});
