/* NetLab — утилиты: IP-адреса, маски, MAC, очередь событий, клонирование.
 * Файл работает и в браузере (обычный <script>), и в Node (require) —
 * всё регистрируется в globalThis.NetLab. */
(function (NS) {
  'use strict';

  const U = {};

  U.BROADCAST_MAC = 'FF:FF:FF:FF:FF:FF';
  U.ZERO_MAC = '00:00:00:00:00:00';
  U.BROADCAST_IP = 0xFFFFFFFF;

  /* ---------- IPv4 ---------- */

  /** "192.168.1.1" -> 3232235777 (беззнаковое число) или null. */
  U.parseIp = function (s) {
    if (typeof s !== 'string') return null;
    const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(s);
    if (!m) return null;
    let n = 0;
    for (let i = 1; i <= 4; i++) {
      const o = Number(m[i]);
      if (o > 255) return null;
      n = n * 256 + o;
    }
    return n;
  };

  U.ipStr = function (n) {
    if (n === null || n === undefined) return '';
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  };

  U.maskFromPrefix = function (p) {
    if (p <= 0) return 0;
    if (p >= 32) return 0xFFFFFFFF;
    return (0xFFFFFFFF << (32 - p)) >>> 0;
  };

  /** Длина префикса или -1, если маска несмежная (например 255.0.255.0). */
  U.prefixFromMask = function (m) {
    if (m === null || m === undefined) return -1;
    let p = 0;
    let gap = false;
    for (let bit = 31; bit >= 0; bit--) {
      if ((m >>> bit) & 1) {
        if (gap) return -1;
        p++;
      } else {
        gap = true;
      }
    }
    return p;
  };

  /** Принимает "255.255.255.0", "/24" или "24". Возвращает число или null. */
  U.parseMask = function (s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    const pm = /^\/?(\d{1,2})$/.exec(t);
    if (pm) {
      const p = Number(pm[1]);
      return p <= 32 ? U.maskFromPrefix(p) : null;
    }
    const m = U.parseIp(t);
    if (m === null || U.prefixFromMask(m) < 0) return null;
    return m;
  };

  U.net = function (ip, mask) { return (ip & mask) >>> 0; };
  U.bcast = function (ip, mask) { return (ip | ~mask) >>> 0; };
  U.sameNet = function (a, b, mask) { return U.net(a, mask) === U.net(b, mask); };

  U.cidr = function (net, mask) { return U.ipStr(net) + '/' + U.prefixFromMask(mask); };

  /** Можно ли назначить адрес узлу (не адрес сети и не широковещательный). */
  U.isHostAddress = function (ip, mask) {
    const p = U.prefixFromMask(mask);
    if (p < 0) return false;
    if (p >= 31) return true;
    return ip !== U.net(ip, mask) && ip !== U.bcast(ip, mask);
  };

  /** Проверка пары IP/маска для интерфейса. Возвращает текст ошибки или null. */
  U.validateHostIp = function (ip, mask) {
    if (ip === null) return 'Неверный IP-адрес';
    if (mask === null) return 'Неверная маска подсети';
    if (mask === 0) return 'Маска /0 недопустима для интерфейса';
    const first = ip >>> 24;
    if (first === 0) return 'Адрес не может начинаться с 0';
    if (first === 127) return 'Адреса 127.x.x.x зарезервированы (loopback)';
    if (first >= 224) return 'Это групповой или зарезервированный адрес';
    if (!U.isHostAddress(ip, mask)) {
      return ip === U.net(ip, mask)
        ? 'Это адрес сети — его нельзя назначить устройству'
        : 'Это широковещательный адрес — его нельзя назначить устройству';
    }
    return null;
  };

  /* ---------- MAC ---------- */

  function hex2(n) { return (n & 255).toString(16).toUpperCase().padStart(2, '0'); }

  /** Детерминированный уникальный MAC: умножение на нечётную константу по модулю 2^32 — биекция. */
  U.macFromCounter = function (c) {
    const v = Math.imul(c, 0x9E3779B1) >>> 0;
    return ['00', 'D0', hex2(v >>> 24), hex2(v >>> 16), hex2(v >>> 8), hex2(v)].join(':');
  };

  U.isBroadcastMac = function (m) { return m === U.BROADCAST_MAC; };
  U.isMulticastMac = function (m) { return (parseInt(m.slice(0, 2), 16) & 1) === 1; };

  /* ---------- VLAN ---------- */

  /** "all" | "1,10,20-30" -> null (все) | Set. Бросает Error при ошибке. */
  U.parseVlanList = function (s) {
    const t = String(s || '').trim().toLowerCase();
    if (t === '' || t === 'all') return null;
    const set = new Set();
    for (const part of t.split(',')) {
      const r = /^(\d{1,4})(?:\s*-\s*(\d{1,4}))?$/.exec(part.trim());
      if (!r) throw new Error('Неверный список VLAN: ' + s);
      const a = Number(r[1]);
      const b = r[2] ? Number(r[2]) : a;
      if (a < 1 || b > 4094 || a > b) throw new Error('VLAN должны быть в диапазоне 1–4094');
      for (let v = a; v <= b; v++) set.add(v);
    }
    return set;
  };

  const vlanListCache = new Map();
  U.vlanInList = function (list, vlan) {
    if (!list || list === 'all') return true;
    let set = vlanListCache.get(list);
    if (set === undefined) {
      try { set = U.parseVlanList(list); } catch (e) { set = new Set(); }
      vlanListCache.set(list, set);
    }
    return set === null || set.has(vlan);
  };

  /* ---------- wildcard-маски (ACL, OSPF) ---------- */

  U.wildcardFromMask = function (m) { return (~m) >>> 0; };

  /** Совпадает ли адрес с парой адрес/wildcard (биты wildcard = «не важно»). */
  U.matchWild = function (ip, net, wc) {
    const care = (~wc) >>> 0;
    return ((ip & care) >>> 0) === ((net & care) >>> 0);
  };

  /** Классовая маска (A — /8, B — /16, C — /24) — нужна RIP и автоподстановке в формах. */
  U.classfulMask = function (ip) {
    const a = ip >>> 24;
    if (a < 128) return U.maskFromPrefix(8);
    if (a < 192) return U.maskFromPrefix(16);
    return U.maskFromPrefix(24);
  };

  /* ---------- пароли Cisco ---------- */

  const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

  /** «Шифрование» Cisco type 7 (service password-encryption) — настоящий алгоритм IOS. */
  U.type7 = function (plain) {
    const seed = 8;
    let out = String(seed).padStart(2, '0');
    for (let i = 0; i < plain.length; i++) {
      out += (plain.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length)).toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  };

  U.type7decode = function (enc) {
    const s = String(enc);
    if (!/^[0-9]{2}([0-9A-Fa-f]{2})*$/.test(s)) return null;
    const seed = parseInt(s.slice(0, 2), 10);
    let out = '';
    for (let i = 2, k = 0; i < s.length; i += 2, k++) {
      out += String.fromCharCode(parseInt(s.slice(i, i + 2), 16) ^ XLAT.charCodeAt((seed + k) % XLAT.length));
    }
    return out;
  };

  /** Хэш для enable secret / username secret (детерминированный, похож на MD5-crypt по виду). */
  U.secretHash = function (plain) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 + c, 2654435761) >>> 0;
    }
    const abc = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let s = '';
    let v1 = h1;
    let v2 = h2;
    for (let i = 0; i < 22; i++) {
      const src = i % 2 ? v1 : v2;
      s += abc[src % 64];
      if (i % 2) v1 = Math.floor(v1 / 64) || (h2 ^ i) >>> 0; else v2 = Math.floor(v2 / 64) || (h1 ^ i) >>> 0;
    }
    return '$1$mERr$' + s;
  };

  /* ---------- разное ---------- */

  U.ciscoMac = function (m) {
    const h = String(m).replace(/:/g, '').toLowerCase();
    return h.slice(0, 4) + '.' + h.slice(4, 8) + '.' + h.slice(8, 12);
  };

  /** Время устройства: старт 1 марта 1993 (как в Packet Tracer), 1 тик = 10 мс. */
  U.clockString = function (ticks, offsetMs) {
    const d = new Date(Date.UTC(1993, 2, 1) + ticks * 10 + (offsetMs || 0));
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = (n, l) => String(n).padStart(l || 2, '0');
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + '.' + p(d.getUTCMilliseconds(), 3) +
      ' UTC ' + days[d.getUTCDay()] + ' ' + mons[d.getUTCMonth()] + ' ' + d.getUTCDate() + ' ' + d.getUTCFullYear();
  };

  U.MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  /** Глубокое копирование простых данных (объекты, массивы, примитивы). */
  U.clone = function clone(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(clone);
    const r = {};
    for (const k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = clone(o[k]);
    }
    return r;
  };

  /** Двоичная куча событий, упорядоченная по (time, seq) — детерминированный порядок. */
  class EventQueue {
    constructor() { this.h = []; }
    get size() { return this.h.length; }
    static less(a, b) { return a.time < b.time || (a.time === b.time && a.seq < b.seq); }
    push(e) {
      const h = this.h;
      h.push(e);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!EventQueue.less(h[i], h[p])) break;
        [h[i], h[p]] = [h[p], h[i]];
        i = p;
      }
    }
    peek() { return this.h[0]; }
    pop() {
      const h = this.h;
      const top = h[0];
      const last = h.pop();
      if (h.length > 0) {
        h[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < h.length && EventQueue.less(h[l], h[m])) m = l;
          if (r < h.length && EventQueue.less(h[r], h[m])) m = r;
          if (m === i) break;
          [h[i], h[m]] = [h[m], h[i]];
          i = m;
        }
      }
      return top;
    }
    clear() { this.h = []; }
  }
  U.EventQueue = EventQueue;

  NS.util = U;
})(globalThis.NetLab = globalThis.NetLab || {});
