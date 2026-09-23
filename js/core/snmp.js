/* NetLab — SNMP v2c: агент на маршрутизаторах и коммутаторах (snmp-server community … RO|RW),
 * MIB-II (system, interfaces, ip), операции get / get-next / get-bulk / set, SNMP-клиент для ПК
 * (программа MIB Browser). Неверная community — запрос молча отбрасывается, как у настоящего агента. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const PORT = 161;
  const TIMEOUT = 300;
  const RETRIES = 2;

  /* ================= OID ================= */

  const oidParse = (s) => String(s).replace(/^\./, '').split('.').filter((x) => x !== '').map(Number);
  const oidStr = (a) => a.join('.');
  function oidCmp(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }
  const starts = (a, pre) => pre.every((x, i) => a[i] === x);

  /* ================= MIB-II ================= */

  const SYS = '1.3.6.1.2.1.1';
  const IFT = '1.3.6.1.2.1.2.2.1';

  /** Строки таблицы интерфейсов агента. */
  function ifRows(dev) {
    const rows = [];
    if (dev.type === 'router') {
      for (const f of dev.ifaces) if (!f.runtime) rows.push({ name: f.name, f, p: f.port >= 0 ? dev.ports[f.port] : null });
    } else {
      dev.ports.forEach((p, i) => { if (NS.Network.isData(p)) rows.push({ name: p.name, f: dev.ifaces.find((x) => x.port === i && x.kind === 'routed') || null, p, i }); });
      for (const f of dev.ifaces) if (f.kind === 'svi') rows.push({ name: f.name, f, p: null });
    }
    return rows;
  }

  function ifType(r) {
    if (r.f && r.f.kind === 'loop') return 24;
    if (r.f && (r.f.kind === 'svi' || r.f.kind === 'tunnel')) return r.f.kind === 'tunnel' ? 131 : 53;
    if (r.p && r.p.media === 'serial') return 22;
    return 6;
  }

  function adminUp(dev, r) { return r.f ? r.f.adminUp && (!r.p || r.p.adminUp) : !!(r.p && r.p.adminUp); }
  function operUp(dev, r) {
    if (r.f) return dev.ifaceUp(r.f);
    return r.i != null && dev.net.isPortOperational(dev, r.i);
  }

  /** Все объекты агента: [{oid:[..], name, type, access, get(), set(v)}], по возрастанию OID. */
  function objects(dev) {
    const out = [];
    const cfg = snmpCfg(dev);
    const add = (oid, name, type, get, set) => out.push({ oid: oidParse(oid), name, type, access: set ? 'rw' : 'ro', get, set });
    const descr = () => 'Cisco IOS Software, ' + (dev.type === 'router' ? 'C' + (dev.model === '1941' ? '1900' : '2900') + ' Software' : 'C' + dev.model.slice(0, 4) + ' Software') + ' (' + dev.model + '), Version 15.1(4)M4, RELEASE SOFTWARE (fc2) — NetLab';
    add(SYS + '.1.0', 'sysDescr', 'OctetString', descr);
    add(SYS + '.2.0', 'sysObjectID', 'OID', () => '1.3.6.1.4.1.9.1.' + (dev.type === 'router' ? (dev.model === '1941' ? 1095 : 1044) : 1208));
    add(SYS + '.3.0', 'sysUpTime', 'TimeTicks', () => Math.max(0, dev.net.time - (dev.bootTime || 0)));
    add(SYS + '.4.0', 'sysContact', 'OctetString', () => cfg.contact, (v) => { cfg.contact = String(v).slice(0, 255); });
    add(SYS + '.5.0', 'sysName', 'OctetString', () => dev.ios.hostname, (v) => dev.setHostname(String(v)));
    add(SYS + '.6.0', 'sysLocation', 'OctetString', () => cfg.location, (v) => { cfg.location = String(v).slice(0, 255); });
    add(SYS + '.7.0', 'sysServices', 'Integer', () => (dev.forwarding ? 78 : 2));
    const rows = ifRows(dev);
    add('1.3.6.1.2.1.2.1.0', 'ifNumber', 'Integer', () => rows.length);
    const cols = [
      [1, 'ifIndex', 'Integer', (r, k) => k],
      [2, 'ifDescr', 'OctetString', (r) => r.name],
      [3, 'ifType', 'Integer', (r) => ifType(r)],
      [4, 'ifMtu', 'Integer', (r) => (r.p && r.p.media === 'serial' ? 1500 : 1500)],
      [5, 'ifSpeed', 'Gauge32', (r) => Math.round((r.p ? NS.portSpeed(r.p) : 100) * 1e6)],
      [6, 'ifPhysAddress', 'OctetString', (r) => (r.f ? dev.ifaceMac(r.f) || '' : r.p && r.p.mac) || ''],
      [7, 'ifAdminStatus', 'Integer', (r) => (adminUp(dev, r) ? 1 : 2)],
      [8, 'ifOperStatus', 'Integer', (r) => (operUp(dev, r) ? 1 : 2)],
      [10, 'ifInOctets', 'Counter32', (r) => (r.p ? r.p.rxBytes || 0 : 0)],
      [11, 'ifInUcastPkts', 'Counter32', (r) => (r.p ? r.p.rxPkts || 0 : 0)],
      [16, 'ifOutOctets', 'Counter32', (r) => (r.p ? r.p.txBytes || 0 : 0)],
      [17, 'ifOutUcastPkts', 'Counter32', (r) => (r.p ? r.p.txPkts || 0 : 0)],
    ];
    for (const [c, name, type, fn] of cols) {
      rows.forEach((r, k) => {
        const setter = c === 7 ? (v) => {
          const up = Number(v) === 1;
          if (Number(v) !== 1 && Number(v) !== 2) throw new Error('badValue');
          if (r.f) dev.setIfaceAdmin(r.f, up);
          else if (r.i != null) dev.setPortAdmin(r.i, up);
        } : null;
        add(IFT + '.' + c + '.' + (k + 1), name + '.' + (k + 1), type, () => fn(r, k + 1), setter);
      });
    }
    add('1.3.6.1.2.1.4.1.0', 'ipForwarding', 'Integer', () => (dev.forwarding ? 1 : 2));
    const addrs = dev.ifaces.filter((f) => f.ip != null).sort((a, b) => a.ip - b.ip);
    for (const [c, name, type, fn] of [[1, 'ipAdEntAddr', 'IpAddress', (f) => U.ipStr(f.ip)], [2, 'ipAdEntIfIndex', 'Integer', (f) => rows.findIndex((r) => r.f === f) + 1], [3, 'ipAdEntNetMask', 'IpAddress', (f) => U.ipStr(f.mask)]]) {
      for (const f of addrs) add('1.3.6.1.2.1.4.20.1.' + c + '.' + U.ipStr(f.ip), name + '.' + U.ipStr(f.ip), type, () => fn(f));
    }
    out.sort((a, b) => oidCmp(a.oid, b.oid));
    return out;
  }

  /** Дерево MIB для MIB Browser (имена и описания узлов). */
  const MIB_TREE = [
    { oid: '1.3.6.1.2.1.1', name: 'system', desc: 'Сведения об устройстве', children: [
      { oid: SYS + '.1.0', name: 'sysDescr', desc: 'Описание: модель и версия IOS' },
      { oid: SYS + '.2.0', name: 'sysObjectID', desc: 'Идентификатор модели' },
      { oid: SYS + '.3.0', name: 'sysUpTime', desc: 'Время работы (сотые доли секунды)' },
      { oid: SYS + '.4.0', name: 'sysContact', desc: 'Контакт администратора (можно изменить)', rw: true },
      { oid: SYS + '.5.0', name: 'sysName', desc: 'Имя (hostname, можно изменить)', rw: true },
      { oid: SYS + '.6.0', name: 'sysLocation', desc: 'Расположение (можно изменить)', rw: true },
      { oid: SYS + '.7.0', name: 'sysServices', desc: 'Уровни модели OSI' },
    ] },
    { oid: '1.3.6.1.2.1.2', name: 'interfaces', desc: 'Интерфейсы', children: [
      { oid: '1.3.6.1.2.1.2.1.0', name: 'ifNumber', desc: 'Число интерфейсов' },
      { oid: '1.3.6.1.2.1.2.2', name: 'ifTable', desc: 'Таблица интерфейсов (Walk)', table: true, children: [
        { oid: IFT + '.2', name: 'ifDescr', desc: 'Имя интерфейса', table: true },
        { oid: IFT + '.5', name: 'ifSpeed', desc: 'Скорость, бит/с', table: true },
        { oid: IFT + '.6', name: 'ifPhysAddress', desc: 'MAC-адрес', table: true },
        { oid: IFT + '.7', name: 'ifAdminStatus', desc: '1 — включён, 2 — выключен (можно изменить)', table: true, rw: true },
        { oid: IFT + '.8', name: 'ifOperStatus', desc: '1 — работает, 2 — не работает', table: true },
        { oid: IFT + '.10', name: 'ifInOctets', desc: 'Принято байт', table: true },
        { oid: IFT + '.16', name: 'ifOutOctets', desc: 'Отправлено байт', table: true },
      ] },
    ] },
    { oid: '1.3.6.1.2.1.4', name: 'ip', desc: 'Протокол IP', children: [
      { oid: '1.3.6.1.2.1.4.1.0', name: 'ipForwarding', desc: '1 — маршрутизирует, 2 — нет' },
      { oid: '1.3.6.1.2.1.4.20', name: 'ipAddrTable', desc: 'IP-адреса интерфейсов (Walk)', table: true },
    ] },
  ];

  /* ================= настройки агента ================= */

  function snmpCfg(dev) {
    if (!dev.snmp) dev.snmp = { communities: [], location: '', contact: '' };
    return dev.snmp;
  }

  const P6 = IpNode.prototype;

  P6.setCommunity = function (name, access, acl) {
    const n = String(name || '').trim();
    if (!/^[\w.@#$%&*!-]{1,32}$/.test(n)) throw new Error('Имя community: буквы, цифры и знаки, до 32 символов');
    const c = snmpCfg(this);
    c.communities = c.communities.filter((x) => x.name !== n);
    c.communities.push({ name: n, access: access === 'rw' ? 'rw' : 'ro', acl: acl || null });
  };

  P6.removeCommunity = function (name) {
    const c = snmpCfg(this);
    c.communities = c.communities.filter((x) => x.name !== name);
  };

  /** Агент: обработать запрос. Возвращает ответ или null (молча отбросить). */
  P6.snmpAgent = function (req, srcIp) {
    const cfg = snmpCfg(this);
    const com = cfg.communities.find((c) => c.name === req.community);
    if (!com) return { drop: 'SNMP: неизвестная community «' + req.community + '» — запрос отброшен (как у настоящего агента)' };
    if (com.acl) {
      const acl = this.acls.get(com.acl);
      if (acl && !acl.check({ src: srcIp, dst: 0, proto: 'UDP', payload: { sport: 0, dport: PORT } }).permit) return { drop: 'SNMP: адрес ' + U.ipStr(srcIp) + ' запрещён списком доступа ' + com.acl };
    }
    this.snmpStats.inPkts++;
    const objs = objects(this);
    const find = (oid) => objs.find((o) => oidCmp(o.oid, oid) === 0);
    const next = (oid) => objs.find((o) => oidCmp(o.oid, oid) > 0);
    const vb = (o) => ({ oid: oidStr(o.oid), name: o.name, type: o.type, value: o.get() });
    const res = { snmp: 'response', reqId: req.reqId, error: 'noError', errorIndex: 0, varbinds: [] };
    const oids = (req.oids || []).map(oidParse);
    if (req.snmp === 'get') {
      oids.forEach((oid, i) => {
        const o = find(oid);
        res.varbinds.push(o ? vb(o) : { oid: oidStr(oid), type: 'noSuchObject', value: null });
        if (!o && res.error === 'noError') { res.error = 'noSuchName'; res.errorIndex = i + 1; }
      });
    } else if (req.snmp === 'getnext') {
      for (const oid of oids) {
        const o = next(oid);
        res.varbinds.push(o ? vb(o) : { oid: oidStr(oid), type: 'endOfMibView', value: null });
      }
    } else if (req.snmp === 'getbulk') {
      let cur = oids[0] || [];
      for (let k = 0; k < Math.min(50, req.max || 10); k++) {
        const o = next(cur);
        if (!o) { res.varbinds.push({ oid: oidStr(cur), type: 'endOfMibView', value: null }); break; }
        res.varbinds.push(vb(o));
        cur = o.oid;
      }
    } else if (req.snmp === 'set') {
      if (com.access !== 'rw') {
        res.error = 'readOnly';
        res.errorIndex = 1;
        res.varbinds = (req.varbinds || []).map((v) => ({ oid: v.oid, type: 'null', value: v.value }));
        return res;
      }
      (req.varbinds || []).forEach((v, i) => {
        const o = find(oidParse(v.oid));
        if (res.error !== 'noError') return;
        if (!o) { res.error = 'noSuchName'; res.errorIndex = i + 1; return; }
        if (!o.set) { res.error = 'notWritable'; res.errorIndex = i + 1; return; }
        try { o.set(v.value); res.varbinds.push(vb(o)); } catch (e) { res.error = 'badValue'; res.errorIndex = i + 1; res.text = e.message; }
      });
      if (res.error === 'noError') this.net.emit('remote-change', { dev: this });
    }
    this.snmpStats.outPkts++;
    return res;
  };

  IpNode.hooks.runtime.push(function () {
    this.bootTime = this.net ? this.net.time : 0;
    this.snmpStats = { inPkts: 0, outPkts: 0, badCommunity: 0 };
  });

  IpNode.hooks.bind.push(function () {
    if (!this.ios || this.type === 'wrouter') return;
    this.udp.set(PORT, (pkt, f, frame) => {
      const req = pkt.payload.data || {};
      if (!req.snmp) return;
      if (!snmpCfg(this).communities.length) { this.portClosed(pkt, f, frame); return; }
      const res = this.snmpAgent(req, pkt.src);
      if (res.drop) {
        this.snmpStats.badCommunity++;
        if (frame) this.drop(frame, res.drop);
        return;
      }
      const src = this.hasIp(pkt.dst) ? pkt.dst : f && f.ip;
      this.sendIp(P.ipv4(src, pkt.src, 'UDP', P.udp(PORT, pkt.payload.sport, res), this.defaultTtl), {
        why: 'SNMP-ответ' + (res.error !== 'noError' ? ' (ошибка ' + res.error + ')' : '') + ' для ' + U.ipStr(pkt.src),
      });
    });
  });

  NS.deviceExt.push({
    key: 'snmp',
    applies: (d) => !!d.ios,
    save(d) {
      const c = d.snmp;
      if (!c || (!c.communities.length && !c.location && !c.contact)) return null;
      return { communities: c.communities.map((x) => Object.assign({}, x)), location: c.location, contact: c.contact };
    },
    load(d, c) {
      d.snmp = { communities: [], location: '', contact: '' };
      if (!c) return;
      d.snmp.communities = (c.communities || []).filter((x) => x && x.name).map((x) => ({ name: String(x.name), access: x.access === 'rw' ? 'rw' : 'ro', acl: x.acl || null }));
      d.snmp.location = String(c.location || '');
      d.snmp.contact = String(c.contact || '');
    },
  });

  /* ================= клиент (MIB Browser) ================= */

  /**
   * SNMP-запрос. op: get | getnext | getbulk | set. arg: список OID (get/getnext), OID (getbulk) или [{oid, value}] (set).
   * cb({ ok, error, varbinds, text }).
   */
  P6.snmpRequest = function (target, community, op, arg, cb) {
    const port = this.allocPort();
    const reqId = this.net.counters.xid++;
    let tries = 0;
    let timer = null;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) timer.cancel();
      this.udp.delete(port);
      this.udpErr.delete(port);
      cb(r);
    };
    this.udp.set(port, (pkt) => {
      const d = pkt.payload.data || {};
      if (d.snmp !== 'response' || d.reqId !== reqId) return;
      finish({ ok: d.error === 'noError', error: d.error, errorIndex: d.errorIndex, varbinds: d.varbinds || [], text: d.text });
    });
    this.udpErr.set(port, () => finish({ ok: false, error: 'unreachable', text: 'На ' + U.ipStr(target) + ' не работает SNMP-агент (не задана snmp-server community)' }));
    const data = { snmp: op, community: String(community || ''), reqId };
    if (op === 'set') data.varbinds = arg;
    else if (op === 'getbulk') { data.oids = [arg]; data.max = 20; }
    else data.oids = Array.isArray(arg) ? arg : [arg];
    const attempt = () => {
      timer = null;
      if (done) return;
      if (++tries > RETRIES + 1) { finish({ ok: false, error: 'timeout', text: 'Нет ответа от агента. Проверьте адрес и имя community (при неверной community агент молчит).' }); return; }
      this.sendIp(P.ipv4(null, target, 'UDP', P.udp(port, PORT, data), this.defaultTtl), {
        why: 'SNMP ' + op.toUpperCase() + ' ' + (data.oids ? data.oids.join(', ') : (arg || []).map((v) => v.oid).join(', ')),
        onError: (code, text) => finish({ ok: false, error: code, text }),
      });
      if (!done) timer = this.timer(TIMEOUT, attempt);
    };
    attempt();
  };

  /** Обход поддерева (Walk): onRow(varbind) для каждого объекта, cb({ok, count, text}). */
  P6.snmpWalk = function (target, community, root, onRow, cb) {
    const base = oidParse(root);
    let cur = String(root);
    let count = 0;
    const step = () => {
      this.snmpRequest(target, community, 'getnext', [cur], (r) => {
        if (!r.ok || !r.varbinds[0]) { cb({ ok: count > 0 || r.ok, count, text: r.text || r.error }); return; }
        const v = r.varbinds[0];
        if (v.type === 'endOfMibView' || !starts(oidParse(v.oid), base) || count > 500) { cb({ ok: true, count }); return; }
        count++;
        onRow(v);
        cur = v.oid;
        step();
      });
    };
    step();
  };

  NS.snmp = { MIB_TREE, oidParse, oidStr, oidCmp, objects, PORT };

  /* ================= описание пакетов ================= */

  P.register({
    protocols: { SNMP: { label: 'SNMP', color: '#0d9488' } },
    classify(f) {
      if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'UDP') return null;
      const u = f.payload.payload || {};
      return (u.sport === PORT || u.dport === PORT) && u.data && u.data.snmp ? 'SNMP' : null;
    },
    summary(f) {
      if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'UDP') return null;
      const d = (f.payload.payload || {}).data || {};
      if (!d.snmp) return null;
      const route = U.ipStr(f.payload.src) + ' → ' + U.ipStr(f.payload.dst);
      if (d.snmp === 'response') return 'SNMP Response' + (d.error !== 'noError' ? ' (' + d.error + ')' : ': ' + (d.varbinds || []).map((v) => (v.name || v.oid) + ' = ' + v.value).slice(0, 2).join(', ')) + ', ' + route;
      return 'SNMP ' + d.snmp.toUpperCase() + ' (community «' + d.community + '»), ' + route;
    },
    extraLayers(f, out) {
      if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'UDP') return;
      const d = (f.payload.payload || {}).data || {};
      if (!d.snmp) return;
      const fields = [['Версия', 'SNMPv2c'], ['PDU', d.snmp], ['Request ID', String(d.reqId)]];
      if (d.community != null) fields.push(['Community', d.community]);
      if (d.error) fields.push(['Статус', d.error]);
      for (const v of d.varbinds || []) fields.push([v.name || v.oid, v.value == null ? v.type : String(v.value)]);
      for (const o of d.oids || []) fields.push(['OID', o]);
      out.push({ title: 'SNMP (уровень 7)', fields });
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;
  X.global.push((t) => /^snmp-server$/i.test(t[0] || '') || (/^no$/i.test(t[0] || '') && /^snmp-server$/i.test(t[1] || '')));

  X.config.push((dev, s, a, neg, io, C) => {
    if (!C.kw(a[0], 'snmp-server', 6)) return false;
    const cfg = snmpCfg(dev);
    if (C.kw(a[1], 'community', 1)) {
      if (!a[2]) { C.incomplete(io); return true; }
      if (neg) { C.withMutate(io, () => dev.removeCommunity(a[2])); return true; }
      const acc = a[3] && C.kw(a[3], 'rw', 2) ? 'rw' : 'ro';
      const acl = a[4] || (a[3] && !C.kw(a[3], 'rw', 2) && !C.kw(a[3], 'ro', 2) ? a[3] : null);
      C.withMutate(io, () => dev.setCommunity(a[2], acc, acl));
      return true;
    }
    if (C.kw(a[1], 'location', 1)) { C.withMutate(io, () => { cfg.location = neg ? '' : a.slice(2).join(' '); }); return true; }
    if (C.kw(a[1], 'contact', 1)) { C.withMutate(io, () => { cfg.contact = neg ? '' : a.slice(2).join(' '); }); return true; }
    if (neg && !a[1]) { C.withMutate(io, () => { dev.snmp = { communities: [], location: '', contact: '' }; }); return true; }
    if (C.kw(a[1], 'enable', 1) || C.kw(a[1], 'host', 1)) return true;
    C.invalid(io, a[1]);
    return true;
  });

  X.running.tail.push((dev) => {
    const c = dev.snmp;
    if (!c) return [];
    const L = [];
    for (const x of c.communities) L.push('snmp-server community ' + x.name + ' ' + x.access.toUpperCase() + (x.acl ? ' ' + x.acl : ''));
    if (c.location) L.push('snmp-server location ' + c.location);
    if (c.contact) L.push('snmp-server contact ' + c.contact);
    if (L.length) L.push('!');
    return L;
  });

  X.show.push((dev, s, a, io, C) => {
    if (!C.kw(a[0], 'snmp', 2)) return false;
    const c = snmpCfg(dev);
    if (C.kw(a[1], 'community', 1)) {
      for (const x of c.communities) {
        io.out('Community name: ' + x.name);
        io.out('Community Index: ' + x.name);
        io.out('Community SecurityName: ' + x.name);
        io.out('storage-type: nonvolatile        active   access: ' + (x.access === 'rw' ? 'read-write' : 'read-only') + (x.acl ? '   access-list: ' + x.acl : ''));
        io.out('');
      }
      if (!c.communities.length) io.out('%SNMP agent not enabled');
      return true;
    }
    if (!c.communities.length) { io.out('%SNMP agent not enabled'); return true; }
    io.out('Chassis: ' + dev.model);
    if (c.contact) io.out('Contact: ' + c.contact);
    if (c.location) io.out('Location: ' + c.location);
    io.out(dev.snmpStats.inPkts + dev.snmpStats.badCommunity + ' SNMP packets input');
    io.out('    ' + dev.snmpStats.badCommunity + ' Unknown community name');
    io.out(dev.snmpStats.outPkts + ' SNMP packets output');
    return true;
  });

  X.tree.config = (X.tree.config || []).concat(['snmp-server community WORD ro', 'snmp-server community WORD rw', 'snmp-server location LINE', 'snmp-server contact LINE']);
  X.tree.exec = (X.tree.exec || []).concat(['show snmp', 'show snmp community']);
})(globalThis.NetLab = globalThis.NetLab || {});
