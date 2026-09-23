/* NetLab — NAT Cisco: статический (ip nat inside source static), динамический из пула и PAT (overload).
 * Таблица трансляций как в show ip nat translations; корректно обрабатываются ICMP-ошибки (tracert через NAT). */
(function (NS) {
  'use strict';

  const U = NS.util;

  class NatEngine {
    constructor(node) {
      this.node = node;
      this.statics = [];
      this.pools = new Map();
      this.rules = [];
      this.table = [];
    }

    clearDynamic() { this.table = []; }

    addStatic(local, global) {
      if (local == null || global == null) throw new Error('Неверный адрес');
      if (this.statics.some((s) => s.local === local || s.global === global)) throw new Error('Такое статическое соответствие уже есть');
      this.statics.push({ local, global });
    }

    removeStatic(local, global) { this.statics = this.statics.filter((s) => !(s.local === local && s.global === global)); }

    addPool(name, start, end, mask) {
      if (!name) throw new Error('Не указано имя пула');
      if (start == null || end == null || end < start) throw new Error('Неверный диапазон пула');
      if (mask == null) throw new Error('Неверная маска пула');
      this.pools.set(name, { name, start, end, mask });
    }

    /** rule: {acl, pool|null, ifName|null, overload} */
    addRule(rule) {
      if (!rule.acl) throw new Error('Не указан список доступа');
      if (!rule.pool && !rule.ifName) throw new Error('Укажите pool или interface');
      this.rules = this.rules.filter((r) => r.acl !== rule.acl);
      this.rules.push(rule);
    }

    removeRule(acl) { this.rules = this.rules.filter((r) => r.acl !== acl); }

    static portOf(pkt) {
      const l4 = pkt.payload || {};
      if (pkt.proto === 'ICMP') return l4.type === 'echo-request' || l4.type === 'echo-reply' ? l4.id : null;
      if (pkt.proto === 'TCP' || pkt.proto === 'UDP') return l4.sport;
      return null;
    }

    static protoName(pkt) { return pkt.proto.toLowerCase(); }

    /** Изнутри наружу: заменить адрес источника. Возвращает новый пакет, null (без трансляции) или false (нет адресов). */
    outbound(pkt, outIf) {
      const st = this.statics.find((s) => s.local === pkt.src);
      if (st) {
        const t = U.clone(pkt);
        t.src = st.global;
        this.touch({ type: 'static', proto: NatEngine.protoName(pkt), local: pkt.src, global: st.global, lport: null, gport: null, outside: pkt.dst });
        return t;
      }
      for (const r of this.rules) {
        const acl = this.node.acls.get(String(r.acl));
        if (!acl || !acl.check(pkt).permit) continue;
        let gip;
        if (r.ifName) {
          const f = this.node.ifaceByName(r.ifName);
          if (!f || f.ip == null) return false;
          gip = f.ip;
        } else {
          const pool = this.pools.get(r.pool);
          if (!pool) return false;
          gip = pool.start;
        }
        const proto = NatEngine.protoName(pkt);
        const lport = NatEngine.portOf(pkt);
        if (r.overload || r.ifName) {
          let e = this.table.find((x) => x.type === 'pat' && x.proto === proto && x.local === pkt.src && x.lport === lport && x.global === gip);
          if (!e) {
            const busy = new Set(this.table.filter((x) => x.global === gip && x.proto === proto).map((x) => x.gport));
            let gport = lport;
            if (gport == null || busy.has(gport)) {
              gport = 1024;
              while (busy.has(gport)) gport++;
            }
            e = { type: 'pat', proto, local: pkt.src, lport, global: gip, gport, outside: pkt.dst, oport: null };
            this.table.push(e);
          }
          e.last = this.node.net.time;
          const t = U.clone(pkt);
          t.src = e.global;
          this.setPort(t, e.gport, 'src');
          return t;
        }
        // динамический 1:1 из пула
        const pool = this.pools.get(r.pool);
        let e = this.table.find((x) => x.type === 'dyn' && x.local === pkt.src);
        if (!e) {
          const used = new Set(this.table.filter((x) => x.type === 'dyn').map((x) => x.global).concat(this.statics.map((s) => s.global)));
          let g = null;
          for (let a = pool.start; a <= pool.end; a++) if (!used.has(a)) { g = a; break; }
          if (g == null) return false;
          e = { type: 'dyn', proto: '---', local: pkt.src, lport: null, global: g, gport: null, outside: null };
          this.table.push(e);
        }
        e.last = this.node.net.time;
        const t = U.clone(pkt);
        t.src = e.global;
        return t;
      }
      return null;
    }

    setPort(pkt, port, which) {
      const l4 = pkt.payload;
      if (port == null || !l4) return;
      if (pkt.proto === 'ICMP') l4.id = port;
      else if (which === 'src') l4.sport = port;
      else l4.dport = port;
    }

    touch(e) {
      if (this.table.some((x) => x.type === 'static' && x.local === e.local && x.proto === e.proto && x.outside === e.outside)) return;
      if (this.table.length > 500) this.table.shift();
      e.last = this.node.net.time;
      this.table.push(e);
    }

    /** Снаружи внутрь: восстановить адрес получателя. Возвращает новый пакет или null. */
    inbound(pkt) {
      const l4 = pkt.payload || {};
      // ICMP-ошибка про наш оттранслированный пакет: исправляем и вложенный исходный пакет
      if (pkt.proto === 'ICMP' && (l4.type === 'time-exceeded' || l4.type === 'unreachable') && l4.original) {
        const o = l4.original;
        const oport = NatEngine.portOf(o);
        const oproto = NatEngine.protoName(o);
        const e = this.table.find((x) => x.type === 'pat' && x.global === o.src && x.gport === oport && x.proto === oproto) ||
          this.table.find((x) => x.type === 'dyn' && x.global === o.src);
        const st = e ? null : this.statics.find((s) => s.global === o.src);
        if (!e && !st) return null;
        const t = U.clone(pkt);
        const local = e ? e.local : st.local;
        t.dst = local;
        t.payload.original.src = local;
        if (e && e.type === 'pat') this.setPort(t.payload.original, e.lport, 'src');
        return t;
      }
      const proto = NatEngine.protoName(pkt);
      const port = pkt.proto === 'ICMP' ? (l4.type === 'echo-reply' || l4.type === 'echo-request' ? l4.id : null) : l4.dport;
      const pat = this.table.find((x) => x.type === 'pat' && x.global === pkt.dst && x.proto === proto && x.gport === port);
      if (pat) {
        pat.last = this.node.net.time;
        const t = U.clone(pkt);
        t.dst = pat.local;
        this.setPort(t, pat.lport, 'dst');
        return t;
      }
      const dyn = this.table.find((x) => x.type === 'dyn' && x.global === pkt.dst);
      if (dyn) {
        const t = U.clone(pkt);
        t.dst = dyn.local;
        return t;
      }
      const st = this.statics.find((s) => s.global === pkt.dst);
      if (st) {
        const t = U.clone(pkt);
        t.dst = st.local;
        return t;
      }
      return null;
    }

    /** Строки show ip nat translations. */
    showLines() {
      const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, Math.max(n, String(s).length + 1));
      const ap = (ip, p) => U.ipStr(ip) + (p != null ? ':' + p : '');
      const lines = [pad('Pro', 5) + pad('Inside global', 22) + pad('Inside local', 22) + pad('Outside local', 22) + 'Outside global'];
      for (const s of this.statics) lines.push(pad('---', 5) + pad(U.ipStr(s.global), 22) + pad(U.ipStr(s.local), 22) + pad('---', 22) + '---');
      for (const e of this.table) {
        if (e.type === 'static') {
          lines.push(pad(e.proto, 5) + pad(U.ipStr(e.global), 22) + pad(U.ipStr(e.local), 22) + pad(U.ipStr(e.outside), 22) + U.ipStr(e.outside));
        } else if (e.type === 'dyn') {
          lines.push(pad('---', 5) + pad(U.ipStr(e.global), 22) + pad(U.ipStr(e.local), 22) + pad('---', 22) + '---');
        } else {
          lines.push(pad(e.proto, 5) + pad(ap(e.global, e.gport), 22) + pad(ap(e.local, e.lport), 22) + pad(ap(e.outside, e.lport), 22) + ap(e.outside, e.lport));
        }
      }
      return lines;
    }

    configLines() {
      const L = [];
      for (const p of this.pools.values()) L.push('ip nat pool ' + p.name + ' ' + U.ipStr(p.start) + ' ' + U.ipStr(p.end) + ' netmask ' + U.ipStr(p.mask));
      for (const r of this.rules) L.push('ip nat inside source list ' + r.acl + (r.ifName ? ' interface ' + r.ifName : ' pool ' + r.pool) + (r.overload ? ' overload' : ''));
      for (const s of this.statics) L.push('ip nat inside source static ' + U.ipStr(s.local) + ' ' + U.ipStr(s.global));
      return L;
    }

    isEmpty() { return !this.statics.length && !this.pools.size && !this.rules.length; }

    serialize() {
      return {
        statics: this.statics.map((s) => ({ local: U.ipStr(s.local), global: U.ipStr(s.global) })),
        pools: [...this.pools.values()].map((p) => ({ name: p.name, start: U.ipStr(p.start), end: U.ipStr(p.end), mask: U.ipStr(p.mask) })),
        rules: this.rules.map((r) => Object.assign({}, r)),
      };
    }

    load(d) {
      this.statics = [];
      this.pools = new Map();
      this.rules = [];
      this.table = [];
      if (!d) return;
      for (const s of d.statics || []) {
        const l = U.parseIp(s.local);
        const g = U.parseIp(s.global);
        if (l != null && g != null) this.statics.push({ local: l, global: g });
      }
      for (const p of d.pools || []) {
        const a = U.parseIp(p.start);
        const b = U.parseIp(p.end);
        const m = U.parseMask(p.mask);
        if (p.name && a != null && b != null && m != null) this.pools.set(p.name, { name: p.name, start: a, end: b, mask: m });
      }
      for (const r of d.rules || []) if (r.acl) this.rules.push({ acl: String(r.acl), pool: r.pool || null, ifName: r.ifName || null, overload: !!r.overload });
    }
  }

  NS.NatEngine = NatEngine;
})(globalThis.NetLab = globalThis.NetLab || {});
