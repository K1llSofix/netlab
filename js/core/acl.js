/* NetLab — списки доступа (ACL) Cisco: стандартные и расширенные, нумерованные и именованные.
 * Разбор синтаксиса IOS, проверка пакетов (первое совпадение, в конце неявный deny), счётчики. */
(function (NS) {
  'use strict';

  const U = NS.util;

  const PORT_NAMES = {
    www: 80, http: 80, ftp: 21, 'ftp-data': 20, telnet: 23, smtp: 25, pop3: 110, domain: 53, tftp: 69,
    bootps: 67, bootpc: 68, snmp: 161, ssh: 22, https: 443, ntp: 123,
  };
  const PORT_BY_NUM = { 80: 'www', 21: 'ftp', 20: 'ftp-data', 23: 'telnet', 25: 'smtp', 110: 'pop3', 53: 'domain', 69: 'tftp', 67: 'bootps', 68: 'bootpc', 161: 'snmp' };
  const ICMP_TYPES = { echo: 'echo-request', 'echo-reply': 'echo-reply', unreachable: 'unreachable', 'time-exceeded': 'time-exceeded' };
  const ICMP_BACK = { 'echo-request': 'echo', 'echo-reply': 'echo-reply', unreachable: 'unreachable', 'time-exceeded': 'time-exceeded' };

  function parsePortNum(t) {
    if (t == null) throw new Error('Не указан порт');
    const k = String(t).toLowerCase();
    if (k in PORT_NAMES) return PORT_NAMES[k];
    const n = Number(k);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('Неверный порт: ' + t);
    return n;
  }

  /** Номер списка → тип: стандартный (1–99, 1300–1999) или расширенный (100–199, 2000–2699). */
  function typeForNumber(n) {
    n = Number(n);
    if ((n >= 1 && n <= 99) || (n >= 1300 && n <= 1999)) return 'standard';
    if ((n >= 100 && n <= 199) || (n >= 2000 && n <= 2699)) return 'extended';
    return null;
  }

  /** Разобрать «any | host A | A W», начиная с позиции i. Возвращает {addr, wc, i}. */
  function parseAddr(t, i, standard) {
    const a = (t[i] || '').toLowerCase();
    if (a === 'any') return { addr: 0, wc: 0xFFFFFFFF, i: i + 1 };
    if (a === 'host') {
      const ip = U.parseIp(t[i + 1] || '');
      if (ip == null) throw new Error('Неверный адрес после host');
      return { addr: ip, wc: 0, i: i + 2 };
    }
    const ip = U.parseIp(t[i] || '');
    if (ip == null) throw new Error('Ожидался адрес, any или host: «' + (t[i] || '') + '»');
    const wc = t[i + 1] != null ? U.parseIp(t[i + 1]) : null;
    if (wc != null) return { addr: ip, wc, i: i + 2 };
    if (standard) return { addr: ip, wc: 0, i: i + 1 };
    throw new Error('После адреса нужна wildcard-маска (например 0.0.0.255)');
  }

  function parsePortSpec(t, i) {
    const op = (t[i] || '').toLowerCase();
    if (op === 'eq' || op === 'neq' || op === 'lt' || op === 'gt') return { spec: { op, a: parsePortNum(t[i + 1]) }, i: i + 2 };
    if (op === 'range') return { spec: { op, a: parsePortNum(t[i + 1]), b: parsePortNum(t[i + 2]) }, i: i + 3 };
    return { spec: null, i };
  }

  function portMatch(spec, p) {
    if (!spec) return true;
    switch (spec.op) {
      case 'eq': return p === spec.a;
      case 'neq': return p !== spec.a;
      case 'lt': return p < spec.a;
      case 'gt': return p > spec.a;
      case 'range': return p >= spec.a && p <= spec.b;
      default: return false;
    }
  }

  function addrText(addr, wc) {
    if (wc === 0xFFFFFFFF) return 'any';
    if (wc === 0) return 'host ' + U.ipStr(addr);
    return U.ipStr(addr) + ' ' + U.ipStr(wc);
  }

  function portText(s) {
    if (!s) return '';
    const n = (p) => PORT_BY_NUM[p] || String(p);
    return ' ' + s.op + ' ' + n(s.a) + (s.op === 'range' ? ' ' + n(s.b) : '');
  }

  class AccessList {
    constructor(name, type) {
      this.name = String(name);
      this.type = type;
      this.named = !/^\d+$/.test(this.name);
      this.entries = [];
    }

    static typeForNumber(n) { return typeForNumber(n); }

    /** tokens: ['permit', 'tcp', 'any', 'host', '10.0.0.1', 'eq', '80'] (или 'remark …'). */
    parseEntry(tokens) {
      const action = (tokens[0] || '').toLowerCase();
      if (action === 'remark') return { remark: tokens.slice(1).join(' ') };
      if (action !== 'permit' && action !== 'deny') throw new Error('Ожидалось permit, deny или remark');
      const e = { action, proto: 'ip', src: 0, srcWc: 0xFFFFFFFF, sport: null, dst: 0, dstWc: 0xFFFFFFFF, dport: null, established: false, icmpType: null, hits: 0 };
      let i = 1;
      if (this.type === 'standard') {
        const s = parseAddr(tokens, i, true);
        e.src = U.net(s.addr, (~s.wc) >>> 0);
        e.srcWc = s.wc;
        i = s.i;
      } else {
        const proto = (tokens[i++] || '').toLowerCase();
        if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) throw new Error('Протокол: ip, icmp, tcp или udp');
        e.proto = proto;
        const s = parseAddr(tokens, i, false);
        e.src = U.net(s.addr, (~s.wc) >>> 0);
        e.srcWc = s.wc;
        i = s.i;
        if (proto === 'tcp' || proto === 'udp') {
          const ps = parsePortSpec(tokens, i);
          e.sport = ps.spec;
          i = ps.i;
        }
        const d = parseAddr(tokens, i, false);
        e.dst = U.net(d.addr, (~d.wc) >>> 0);
        e.dstWc = d.wc;
        i = d.i;
        if (proto === 'tcp' || proto === 'udp') {
          const ps = parsePortSpec(tokens, i);
          e.dport = ps.spec;
          i = ps.i;
        }
        while (i < tokens.length) {
          const k = tokens[i++].toLowerCase();
          if (k === 'established' && proto === 'tcp') e.established = true;
          else if (proto === 'icmp' && ICMP_TYPES[k]) e.icmpType = ICMP_TYPES[k];
          else if (k === 'log') { /* журналирование не моделируется */ } else throw new Error('Непонятный параметр «' + k + '»');
        }
      }
      if (i < tokens.length && tokens[i].toLowerCase() !== 'log') throw new Error('Лишние параметры: ' + tokens.slice(i).join(' '));
      return e;
    }

    add(tokens, seq) {
      const e = this.parseEntry(tokens);
      e.seq = seq || (this.entries.length ? this.entries[this.entries.length - 1].seq + 10 : 10);
      if (this.entries.some((x) => x.seq === e.seq)) throw new Error('Строка с номером ' + e.seq + ' уже есть');
      this.entries.push(e);
      this.entries.sort((a, b) => a.seq - b.seq);
      return e;
    }

    removeSeq(seq) { this.entries = this.entries.filter((e) => e.seq !== seq); }

    /** Проверить пакет: первое совпадение; если ничего не совпало — неявный deny. */
    check(pkt) {
      for (const e of this.entries) {
        if (e.remark !== undefined) continue;
        if (this.matches(e, pkt)) {
          e.hits++;
          return { permit: e.action === 'permit', entry: e };
        }
      }
      return { permit: false, entry: null };
    }

    matches(e, pkt) {
      if (!U.matchWild(pkt.src, e.src, e.srcWc)) return false;
      if (this.type === 'standard') return true;
      if (!U.matchWild(pkt.dst, e.dst, e.dstWc)) return false;
      const l4 = pkt.payload || {};
      switch (e.proto) {
        case 'ip': return true;
        case 'icmp': return pkt.proto === 'ICMP' && (!e.icmpType || l4.type === e.icmpType);
        case 'tcp':
          if (pkt.proto !== 'TCP') return false;
          if (e.established && !(NS.packets.hasFlag(l4, 'ACK') || NS.packets.hasFlag(l4, 'RST'))) return false;
          return portMatch(e.sport, l4.sport) && portMatch(e.dport, l4.dport);
        case 'udp': return pkt.proto === 'UDP' && portMatch(e.sport, l4.sport) && portMatch(e.dport, l4.dport);
        default: return false;
      }
    }

    entryText(e) {
      if (e.remark !== undefined) return 'remark ' + e.remark;
      if (this.type === 'standard') return e.action + ' ' + (e.srcWc === 0 ? U.ipStr(e.src) : addrText(e.src, e.srcWc));
      let s = e.action + ' ' + e.proto + ' ' + addrText(e.src, e.srcWc) + portText(e.sport) + ' ' + addrText(e.dst, e.dstWc) + portText(e.dport);
      if (e.icmpType) s += ' ' + ICMP_BACK[e.icmpType];
      if (e.established) s += ' established';
      return s;
    }

    /** Строки для running-config. */
    configLines() {
      if (this.named) {
        return ['ip access-list ' + this.type + ' ' + this.name].concat(this.entries.map((e) => ' ' + this.entryText(e)));
      }
      return this.entries.map((e) => 'access-list ' + this.name + ' ' + this.entryText(e));
    }

    /** Строки для show access-lists. */
    showLines() {
      const head = (this.type === 'standard' ? 'Standard' : 'Extended') + ' IP access list ' + this.name;
      return [head].concat(this.entries.map((e) => '    ' + e.seq + ' ' + this.entryText(e) + (e.hits ? ' (' + e.hits + ' match(es))' : '')));
    }

    serialize() {
      return { name: this.name, type: this.type, entries: this.entries.map((e) => Object.assign({}, e, { hits: 0 })) };
    }

    static load(d) {
      const a = new AccessList(d.name, d.type === 'extended' ? 'extended' : 'standard');
      for (const e of d.entries || []) a.entries.push(Object.assign({ hits: 0 }, e));
      return a;
    }
  }

  AccessList.PORT_NAMES = PORT_NAMES;
  NS.AccessList = AccessList;
})(globalThis.NetLab = globalThis.NetLab || {});
