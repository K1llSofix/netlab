/* NetLab — экспорт захваченных кадров в формат libpcap (.pcap), который открывает Wireshark.
 * Кадры NetLab переводятся в настоящие байты: Ethernet (802.1Q), ARP, IPv4, IPv6, ICMP, ICMPv6 (эхо, NS/NA, RS/RA),
 * UDP, TCP (с контрольными суммами), DHCP (BOOTP с опциями), DNS, HTTP, почта, Telnet, Syslog — как текст;
 * протоколы, которых нет в реальном мире в таком виде (SCCP, IoT, CAPWAP-данные NetLab и т. п.), — как данные в JSON. */
(function (NS) {
  'use strict';

  class Buf {
    constructor() { this.a = []; }
    u8(v) { this.a.push(v & 255); return this; }
    u16(v) { this.a.push((v >>> 8) & 255, v & 255); return this; }
    u32(v) { this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
    bytes(b) { for (const x of b) this.a.push(x & 255); return this; }
    zeros(n) { for (let i = 0; i < n; i++) this.a.push(0); return this; }
    get length() { return this.a.length; }
  }

  const enc = new TextEncoder();
  const text = (s) => enc.encode(String(s));
  function macBytes(m) {
    const h = String(m || '').replace(/[^0-9a-f]/gi, '');
    if (h.length !== 12) return [0, 0, 0, 0, 0, 0];
    return h.match(/../g).map((x) => parseInt(x, 16));
  }
  const ipBytes = (v) => { const x = Number(v) >>> 0; return [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]; };
  function ip6Bytes(v) {
    let b = BigInt.asUintN(128, BigInt(v || 0));
    const out = new Array(16);
    for (let i = 15; i >= 0; i--) { out[i] = Number(b & 255n); b >>= 8n; }
    return out;
  }
  function checksum(bytes) {
    let s = 0;
    for (let i = 0; i < bytes.length; i += 2) s += (bytes[i] << 8) + (i + 1 < bytes.length ? bytes[i + 1] : 0);
    while (s >>> 16) s = (s & 0xffff) + (s >>> 16);
    return (~s) & 0xffff;
  }
  const json = (o) => text(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString(16) : v)));

  /* ---------- прикладной уровень ---------- */

  const DHCP_TYPE = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 };

  function dhcpBytes(d, src) {
    const reply = ['OFFER', 'ACK', 'NAK'].includes(d.op);
    const b = new Buf();
    b.u8(reply ? 2 : 1).u8(1).u8(6).u8(0).u32(Number(d.xid) || 0).u16(0).u16(0x8000);
    b.bytes(ipBytes(d.ciaddr || 0)).bytes(ipBytes(d.yiaddr || 0)).bytes(ipBytes(reply ? src || 0 : 0)).bytes(ipBytes(d.giaddr || 0));
    b.bytes(macBytes(d.chaddr)).zeros(10).zeros(64).zeros(128);
    b.u32(0x63825363);
    b.u8(53).u8(1).u8(DHCP_TYPE[d.op] || 1);
    const ipOpt = (code, v) => { if (v != null) b.u8(code).u8(4).bytes(ipBytes(v)); };
    ipOpt(1, d.mask);
    ipOpt(3, d.router);
    ipOpt(6, d.dns);
    ipOpt(50, d.requested);
    ipOpt(54, d.serverId);
    ipOpt(150, d.tftp);
    if (d.yiaddr != null && reply) b.u8(51).u8(4).u32(86400);
    b.u8(255);
    return b.a;
  }

  function dnsName(b, name) {
    for (const part of String(name || '').split('.').filter(Boolean)) { const t = text(part); b.u8(t.length).bytes(t); }
    b.u8(0);
  }
  function dnsBytes(d) {
    const b = new Buf();
    const answer = d.op === 'answer';
    b.u16(Number(d.id) & 0xffff).u16(answer ? (d.ip != null ? 0x8180 : 0x8183) : 0x0100).u16(1).u16(answer && d.ip != null ? 1 : 0).u16(0).u16(0);
    dnsName(b, d.name);
    b.u16(1).u16(1);
    if (answer && d.ip != null) b.u16(0xc00c).u16(1).u16(1).u32(86400).u16(4).bytes(ipBytes(d.ip));
    return b.a;
  }

  function httpBytes(d) {
    if (d.http === 'RESP') {
      const body = String(d.body == null ? '' : d.body);
      return text('HTTP/1.1 ' + (d.status || 200) + ' ' + (d.reason || 'OK') + '\r\nServer: ' + (d.server || 'NetLab') + '\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ' + text(body).length + '\r\n\r\n' + body);
    }
    const h = Object.entries(d.headers || {}).map(([k, v]) => k + ': ' + v + '\r\n').join('');
    const body = d.body == null ? '' : typeof d.body === 'string' ? d.body : JSON.stringify(d.body);
    return text(d.http + ' ' + (d.path || '/') + ' HTTP/1.1\r\nHost: ' + (d.host || '') + '\r\n' + h + (body ? 'Content-Length: ' + text(body).length + '\r\n' : '') + '\r\n' + body);
  }

  function appBytes(proto, sport, dport, data, src) {
    if (data == null) return [];
    if (typeof data !== 'object') return text(String(data));
    const port = (p) => sport === p || dport === p;
    if (proto === 'UDP' && (port(67) || port(68)) && data.op) return dhcpBytes(data, src);
    if (proto === 'UDP' && port(53) && (data.op === 'query' || data.op === 'answer')) return dnsBytes(data);
    if (data.tls) { const t = JSON.stringify(data); const b = new Buf().u8(data.tls === 'Alert' ? 0x15 : 0x16).u16(0x0303).u16(t.length); for (let i = 0; i < t.length; i++) b.u8(t.charCodeAt(i) & 255); return b.a; }
    if (data.http && port(443)) { const inner = httpBytes(data); const b = new Buf().u8(0x17).u16(0x0303).u16(inner.length); for (let i = 0; i < inner.length; i++) b.u8((inner[i] * 131 + i * 17) & 255); return b.a; }
    if (data.http) return httpBytes(data);
    if (data.syslog) return text('<' + (23 * 8 + (data.sev != null ? data.sev : 6)) + '>' + (data.text || '')); // local7
    if (data.term) return text([].concat(data.lines || [], data.text != null ? [data.text] : []).join('\r\n'));
    if (data.smtp || data.pop3) return text(data.line || data.text || JSON.stringify(data));
    if (data.gen) return new Array(Math.min(1400, data.size || 32)).fill(0x61);
    return json(data);
  }

  /* ---------- транспорт ---------- */

  const TCP_FLAGS = { FIN: 1, SYN: 2, RST: 4, PSH: 8, ACK: 16, URG: 32 };

  function l4Bytes(proto, l4, pseudo, src) {
    if (proto === 'UDP') {
      const data = appBytes('UDP', l4.sport, l4.dport, l4.data, src);
      const b = new Buf().u16(l4.sport || 0).u16(l4.dport || 0).u16(8 + data.length).u16(0).bytes(data);
      const c = checksum(pseudo(17, b.length).concat(b.a));
      b.a[6] = (c >>> 8) & 255; b.a[7] = c & 255;
      return b.a;
    }
    if (proto === 'TCP') {
      const data = appBytes('TCP', l4.sport, l4.dport, l4.data, src);
      const flags = String(l4.flags || '').split(',').reduce((m, f) => m | (TCP_FLAGS[f.trim()] || 0), 0);
      const b = new Buf().u16(l4.sport || 0).u16(l4.dport || 0).u32(Number(l4.seq) || 0).u32(Number(l4.ack) || 0).u8(5 << 4).u8(flags).u16(65535).u16(0).u16(0).bytes(data);
      const c = checksum(pseudo(6, b.length).concat(b.a));
      b.a[16] = (c >>> 8) & 255; b.a[17] = c & 255;
      return b.a;
    }
    return null;
  }

  const ICMP4 = { 'echo-reply': 0, unreachable: 3, redirect: 5, 'echo-request': 8, 'time-exceeded': 11 };

  function icmpBytes(m) {
    const t = ICMP4[m.type] != null ? ICMP4[m.type] : 8;
    const b = new Buf().u8(t).u8(m.code || 0).u16(0);
    if (t === 0 || t === 8) b.u16(Number(m.id) & 0xffff).u16(Number(m.seq) & 0xffff).bytes(new Array(Math.min(1400, m.size || 32)).fill(0x61));
    else b.u32(0).zeros(28);
    const c = checksum(b.a);
    b.a[2] = (c >>> 8) & 255; b.a[3] = c & 255;
    return b.a;
  }

  const PROTO_NUM = { ICMP: 1, TCP: 6, UDP: 17, GRE: 47, ESP: 50, OSPF: 89, EIGRP: 88 };
  let ipId = 1;

  function ipv4Bytes(p) {
    const src = ipBytes(p.src);
    const dst = ipBytes(p.dst);
    const pseudo = (proto, len) => src.concat(dst, [0, proto, (len >>> 8) & 255, len & 255]);
    let body;
    if (p.proto === 'ICMP') body = icmpBytes(p.payload || {});
    else body = l4Bytes(p.proto, p.payload || {}, pseudo, p.src);
    if (!body) body = Array.from(json(p.payload)); // GRE, ESP и прочее — содержимое для наглядности
    const num = PROTO_NUM[p.proto] != null ? PROTO_NUM[p.proto] : 253;
    const h = new Buf().u8(0x45).u8(0).u16(20 + body.length).u16(ipId++ & 0xffff).u16(0).u8(p.ttl || 64).u8(num).u16(0).bytes(src).bytes(dst);
    const c = checksum(h.a);
    h.a[10] = (c >>> 8) & 255; h.a[11] = c & 255;
    return h.a.concat(body);
  }

  const ICMP6 = { unreachable: 1, 'time-exceeded': 3, 'echo-request': 128, 'echo-reply': 129, rs: 133, ra: 134, ns: 135, na: 136 };

  function icmp6Bytes(m) {
    const t = ICMP6[m.type] != null ? ICMP6[m.type] : 128;
    const b = new Buf().u8(t).u8(m.code || 0).u16(0);
    const lla = (type, mac) => { if (mac) b.u8(type).u8(1).bytes(macBytes(mac)); };
    if (t === 128 || t === 129) b.u16(Number(m.id) & 0xffff).u16(Number(m.seq) & 0xffff).bytes(new Array(Math.min(1400, m.size || 32)).fill(0x61));
    else if (t === 135) { b.u32(0).bytes(ip6Bytes(m.target)); lla(1, m.mac); }
    else if (t === 136) { b.u8((m.router ? 0x80 : 0) | (m.solicited ? 0x40 : 0) | 0x20).zeros(3).bytes(ip6Bytes(m.target)); lla(2, m.mac); }
    else if (t === 133) { b.u32(0); lla(1, m.mac); }
    else if (t === 134) {
      b.u8(64).u8((m.managed ? 0x80 : 0) | (m.other ? 0x40 : 0)).u16(1800).u32(0).u32(0);
      lla(1, m.mac);
      for (const pr of m.prefixes || []) b.u8(3).u8(4).u8(pr.plen || 64).u8(0xc0).u32(2592000).u32(604800).u32(0).bytes(ip6Bytes(pr.net));
    } else b.u32(0).zeros(40);
    return b.a;
  }

  function ipv6Bytes(p) {
    const src = ip6Bytes(p.src);
    const dst = ip6Bytes(p.dst);
    const pseudo = (next, len) => src.concat(dst, [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, 0, 0, 0, next]);
    let body;
    let next;
    if (p.next === 'ICMPv6') {
      body = icmp6Bytes(p.payload || {});
      const c = checksum(pseudo(58, body.length).concat(body));
      body[2] = (c >>> 8) & 255; body[3] = c & 255;
      next = 58;
    } else {
      body = l4Bytes(p.next, p.payload || {}, pseudo, null) || Array.from(json(p.payload));
      next = p.next === 'TCP' ? 6 : p.next === 'UDP' ? 17 : 253;
    }
    const h = new Buf().u32(0x60000000).u16(body.length).u8(next).u8(p.hop || 64).bytes(src).bytes(dst);
    return h.a.concat(body);
  }

  function arpBytes(a) {
    return new Buf().u16(1).u16(0x0800).u8(6).u8(4).u16(a.op === 'reply' ? 2 : 1)
      .bytes(macBytes(a.senderMac)).bytes(ipBytes(a.senderIp)).bytes(macBytes(a.targetMac)).bytes(ipBytes(a.targetIp)).a;
  }

  const ETHERTYPE = { IPv4: 0x0800, ARP: 0x0806, IPv6: 0x86dd, EAPOL: 0x888e, 'PPPoE-D': 0x8863, 'PPPoE-S': 0x8864 };

  /** Кадр NetLab → байты Ethernet. */
  function encodeFrame(frame) {
    let payload;
    if (frame.type === 'IPv4') payload = ipv4Bytes(frame.payload || {});
    else if (frame.type === 'IPv6') payload = ipv6Bytes(frame.payload || {});
    else if (frame.type === 'ARP') payload = arpBytes(frame.payload || {});
    else payload = json({ type: frame.type, payload: frame.payload });
    const b = new Buf().bytes(macBytes(frame.dst)).bytes(macBytes(frame.src));
    if (frame.vlan != null) b.u16(0x8100).u16(Number(frame.vlan) & 0xfff);
    b.u16(ETHERTYPE[frame.type] || 0x88b5).bytes(payload);
    while (b.length < 60) b.u8(0);
    return new Uint8Array(b.a);
  }

  /** Файл .pcap из записей [{ time (тики NetLab), frame }]. offsetMs — сдвиг часов (как у устройства). */
  function file(records, offsetMs) {
    const parts = [];
    const hdr = new Uint8Array(24);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, 0xa1b2c3d4, true);
    dv.setUint16(4, 2, true);
    dv.setUint16(6, 4, true);
    dv.setInt32(8, 0, true);
    dv.setUint32(12, 0, true);
    dv.setUint32(16, 65535, true);
    dv.setUint32(20, 1, true); // LINKTYPE_ETHERNET
    parts.push(hdr);
    let total = 24;
    const epochMs = Date.UTC(1993, 2, 1) + (offsetMs || 0);
    for (const r of records) {
      let data;
      try { data = encodeFrame(r.frame); } catch (e) { continue; }
      const ms = epochMs + (Number(r.time) || 0) * 10 + (r.sub || 0) / 1000;
      const rh = new Uint8Array(16);
      const rv = new DataView(rh.buffer);
      rv.setUint32(0, Math.floor(ms / 1000), true);
      rv.setUint32(4, Math.floor((ms % 1000) * 1000), true);
      rv.setUint32(8, data.length, true);
      rv.setUint32(12, data.length, true);
      parts.push(rh, data);
      total += 16 + data.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** Записи для pcap из журнала симуляции: каждая передача кадра по кабелю (как захват на всех каналах). */
  function fromLog(log) {
    const out = [];
    let last = -1;
    let sub = 0;
    for (const e of log || []) {
      if (e.type !== 'tx' || !e.frame) continue;
      sub = e.time === last ? sub + 1 : 0;
      last = e.time;
      out.push({ time: e.time, frame: e.frame, sub });
    }
    return out;
  }

  NS.pcap = { encodeFrame, file, fromLog, checksum, macBytes, ipBytes };
})(globalThis.NetLab = globalThis.NetLab || {});
