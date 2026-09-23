/* NetLab — серверные службы: DHCP (пулы, исключения, аренды, relay через giaddr) и DNS. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;

  class DhcpService {
    constructor(node) {
      this.node = node;
      this.enabled = false;
      this.pools = [];
      this.excluded = [];
      this.leases = new Map();
      this.offers = new Map();
      this.conflicts = new Set();
    }

    /** Проверить и добавить (или заменить по имени) пул. Все адреса — числа. */
    setPool(p, replaceName) {
      const name = String(p.name || '').trim();
      if (!/^[\p{L}\p{N}_.-]{1,32}$/u.test(name)) throw new Error('Имя пула: буквы, цифры, «-», «_», «.»');
      if (p.mask == null || U.prefixFromMask(p.mask) < 0 || U.prefixFromMask(p.mask) > 30) throw new Error('Неверная маска пула');
      if (p.start == null) throw new Error('Неверный начальный адрес');
      const network = U.net(p.start, p.mask);
      const first = network + 1;
      const last = U.bcast(p.start, p.mask) - 1;
      const start = Math.max(p.start, first);
      const end = p.end == null ? last : Math.min(p.end, last);
      if (end < start) throw new Error('Пустой диапазон адресов');
      if (p.gateway != null && !U.sameNet(p.gateway, network, p.mask)) throw new Error('Шлюз должен быть в той же сети, что и пул');
      const clash = this.pools.find((x) => x.name !== (replaceName || name) && x.network === network && x.mask === p.mask);
      if (clash) throw new Error('Для сети ' + U.cidr(network, p.mask) + ' уже есть пул «' + clash.name + '»');
      const other = this.pools.find((x) => x.name === name && x.name !== replaceName);
      if (other) throw new Error('Пул с именем «' + name + '» уже есть');
      const pool = { name, network, mask: p.mask, start, end, gateway: p.gateway == null ? null : p.gateway, dns: p.dns == null ? null : p.dns };
      const idx = this.pools.findIndex((x) => x.name === (replaceName || name));
      if (idx >= 0) this.pools[idx] = pool;
      else this.pools.push(pool);
      return pool;
    }

    removePool(name) { this.pools = this.pools.filter((p) => p.name !== name); }

    addExcluded(from, to) {
      if (from == null) throw new Error('Неверный адрес');
      if (to == null) to = from;
      if (to < from) throw new Error('Конец диапазона меньше начала');
      this.excluded.push({ from, to });
    }

    isExcluded(ip) { return this.excluded.some((r) => ip >= r.from && ip <= r.to); }

    inPool(ip, pool) { return ip >= pool.start && ip <= pool.end && U.net(ip, pool.mask) === pool.network; }

    usedBy(ip) {
      for (const [mac, l] of this.leases) if (l.ip === ip) return mac;
      for (const [mac, o] of this.offers) if (o === ip) return mac;
      return null;
    }

    isAvailable(ip, pool, mac) {
      if (!this.inPool(ip, pool)) return false;
      if (this.isExcluded(ip) || this.conflicts.has(ip)) return false;
      if (ip === pool.gateway || ip === pool.dns) return false;
      if (this.node.hasIp(ip)) return false;
      const owner = this.usedBy(ip);
      return owner === null || owner === mac;
    }

    pick(pool, mac) {
      const cur = this.leases.get(mac);
      if (cur && this.isAvailable(cur.ip, pool, mac)) return cur.ip;
      const off = this.offers.get(mac);
      if (off != null && this.isAvailable(off, pool, mac)) return off;
      for (let ip = pool.start; ip <= pool.end; ip++) {
        if (this.isAvailable(ip, pool, mac)) return ip;
      }
      return null;
    }

    leaseList() {
      const out = [];
      for (const [mac, l] of this.leases) out.push({ mac, ip: l.ip, pool: l.pool });
      out.sort((a, b) => a.ip - b.ip);
      return out;
    }

    /** Обработать DHCP-сообщение, пришедшее на интерфейс f. */
    handle(pkt, f) {
      if (!this.enabled) return;
      const d = pkt.payload.data || {};
      const node = this.node;
      if (d.op === 'RELEASE') {
        const l = this.leases.get(d.chaddr);
        if (l && l.ip === d.ciaddr) this.leases.delete(d.chaddr);
        return;
      }
      if (d.op === 'DECLINE') {
        if (d.requested != null) this.conflicts.add(d.requested);
        this.leases.delete(d.chaddr);
        this.offers.delete(d.chaddr);
        node.note('DHCP: клиент отклонил ' + U.ipStr(d.requested) + ' (адрес уже занят в сети)', null, 'info');
        return;
      }
      const ref = d.giaddr || (f && f.ip);
      if (ref == null) return;
      const pool = this.pools.find((p) => U.net(ref, p.mask) === p.network);
      if (!pool) {
        node.note('DHCP: нет пула для сети ' + U.ipStr(ref), null, 'drop');
        return;
      }
      const serverId = f && f.ip;
      if (serverId == null) return;

      if (d.op === 'DISCOVER') {
        const ip = this.pick(pool, d.chaddr);
        if (ip == null) {
          node.note('DHCP: в пуле «' + pool.name + '» закончились свободные адреса', null, 'drop');
          return;
        }
        this.offers.set(d.chaddr, ip);
        this.reply(pkt, f, d, pool, 'OFFER', ip, serverId);
      } else if (d.op === 'REQUEST') {
        if (d.serverId !== serverId) {
          this.offers.delete(d.chaddr);
          return;
        }
        const ip = d.requested;
        if (ip != null && this.isAvailable(ip, pool, d.chaddr)) {
          this.offers.delete(d.chaddr);
          this.leases.set(d.chaddr, { ip, pool: pool.name });
          this.reply(pkt, f, d, pool, 'ACK', ip, serverId);
        } else {
          this.reply(pkt, f, d, pool, 'NAK', null, serverId);
        }
      }
    }

    reply(pkt, f, d, pool, op, ip, serverId) {
      const data = {
        op, xid: d.xid, chaddr: d.chaddr, yiaddr: ip, mask: ip != null ? pool.mask : null,
        router: ip != null ? pool.gateway : null, dns: ip != null ? pool.dns : null, serverId, giaddr: d.giaddr || 0,
      };
      const why = op === 'OFFER' ? 'DHCP Offer: предлагаю адрес ' + U.ipStr(ip)
        : op === 'ACK' ? 'DHCP Ack: адрес ' + U.ipStr(ip) + ' закреплён за ' + d.chaddr
          : 'DHCP Nak: запрошенный адрес недоступен';
      if (d.giaddr) {
        this.node.sendIp(P.ipv4(serverId, d.giaddr, 'UDP', P.udp(67, 67, data), this.node.defaultTtl), { why: why + ' (через relay)' });
      } else {
        this.node.sendIp(P.ipv4(serverId, U.BROADCAST_IP, 'UDP', P.udp(67, 68, data), this.node.defaultTtl), { iface: f, dstMac: d.chaddr, why });
      }
    }

    serialize() {
      return {
        enabled: this.enabled,
        pools: this.pools.map((p) => ({
          name: p.name, network: U.ipStr(p.network), mask: U.ipStr(p.mask), start: U.ipStr(p.start), end: U.ipStr(p.end),
          gateway: p.gateway == null ? null : U.ipStr(p.gateway), dns: p.dns == null ? null : U.ipStr(p.dns),
        })),
        excluded: this.excluded.map((r) => ({ from: U.ipStr(r.from), to: U.ipStr(r.to) })),
        leases: [...this.leases.entries()].map(([mac, l]) => ({ mac, ip: U.ipStr(l.ip), pool: l.pool })),
      };
    }

    load(c) {
      if (!c) return;
      this.enabled = !!c.enabled;
      this.pools = [];
      for (const p of c.pools || []) {
        try {
          this.setPool({ name: p.name, start: U.parseIp(p.start), end: U.parseIp(p.end), mask: U.parseMask(p.mask), gateway: p.gateway ? U.parseIp(p.gateway) : null, dns: p.dns ? U.parseIp(p.dns) : null });
        } catch (e) { /* пропускаем испорченный пул */ }
      }
      this.excluded = [];
      for (const r of c.excluded || []) {
        const a = U.parseIp(r.from);
        const b = U.parseIp(r.to);
        if (a != null && b != null && a <= b) this.excluded.push({ from: a, to: b });
      }
      this.leases = new Map();
      for (const l of c.leases || []) {
        const ip = U.parseIp(l.ip);
        if (ip != null && typeof l.mac === 'string') this.leases.set(l.mac, { ip, pool: l.pool });
      }
    }
  }

  class DnsService {
    constructor(node) {
      this.node = node;
      this.enabled = false;
      this.records = [];
    }

    setRecord(name, ip) {
      const n = String(name || '').trim().toLowerCase();
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(n) || n.length > 253) throw new Error('Неверное доменное имя (латиница, цифры, «-», «.»)');
      if (ip == null) throw new Error('Неверный IP-адрес');
      const r = this.records.find((x) => x.name === n);
      if (r) r.ip = ip;
      else this.records.push({ name: n, ip });
    }

    removeRecord(name) { this.records = this.records.filter((r) => r.name !== name); }

    handle(pkt, f) {
      if (!this.enabled) return;
      const d = pkt.payload.data || {};
      if (d.op !== 'query') return;
      const name = String(d.name || '').toLowerCase();
      const r = this.records.find((x) => x.name === name);
      const data = { op: 'answer', id: d.id, name, ip: r ? r.ip : null };
      const src = pkt.dst === U.BROADCAST_IP ? f.ip : pkt.dst;
      this.node.sendIp(P.ipv4(src, pkt.src, 'UDP', P.udp(53, pkt.payload.sport, data), this.node.defaultTtl), {
        why: r ? 'DNS: ' + name + ' = ' + U.ipStr(r.ip) : 'DNS: имя ' + name + ' не найдено',
      });
    }

    serialize() {
      return { enabled: this.enabled, records: this.records.map((r) => ({ name: r.name, ip: U.ipStr(r.ip) })) };
    }

    load(c) {
      if (!c) return;
      this.enabled = !!c.enabled;
      this.records = [];
      for (const r of c.records || []) {
        const ip = U.parseIp(r.ip);
        if (ip != null && r.name) this.records.push({ name: String(r.name).toLowerCase(), ip });
      }
    }
  }

  /* ================= HTTP ================= */

  const DEFAULT_PAGES = {
    'index.html': '<html>\n<center><font size="+2" color="blue">NetLab</font></center>\n<hr>Добро пожаловать на веб-сервер NetLab!\n<p>Быстрые ссылки:\n<br><a href="helloworld.html">Привет, мир</a>\n<br><a href="copyrights.html">Об этом сервере</a>\n</html>',
    'helloworld.html': '<html>\n<center><font size="+2" color="blue">Hello, World!</font></center>\n<hr>Эта страница пришла с сервера по протоколу HTTP поверх TCP.\n<p><a href="index.html">На главную</a>\n</html>',
    'copyrights.html': '<html>\n<center><font size="+2" color="blue">Об этом сервере</font></center>\n<hr>Страницы можно редактировать на вкладке «Службы» → HTTP.\n<p><a href="index.html">На главную</a>\n</html>',
  };

  class HttpService {
    constructor(node) {
      this.node = node;
      this.enabled = true;
      this.files = new Map(Object.entries(DEFAULT_PAGES));
    }

    bind() {
      if (!this.node.tcp) return;
      if (!this.enabled) { this.node.tcp.unlisten(80); return; }
      this.node.tcp.listen(80, (conn) => {
        conn.h.onData = (d) => {
          if (!d || d.http !== 'GET') return;
          let path = String(d.path || '/').replace(/^\/+/, '');
          if (!path) path = 'index.html';
          const body = this.files.get(path.toLowerCase());
          if (body != null) conn.send({ http: 'RESP', status: 200, reason: 'OK', path, body });
          else conn.send({ http: 'RESP', status: 404, reason: 'Not Found', path, body: '<html><h2>404 — страница не найдена</h2><p>На сервере нет файла «' + path.replace(/[<>&"]/g, '') + '».</html>' });
          conn.close();
        };
      });
    }

    setFile(name, body) {
      const n = String(name || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,64}$/.test(n)) throw new Error('Имя файла: латиница, цифры, «.», «-», «_»');
      this.files.set(n, String(body || ''));
    }

    removeFile(name) { this.files.delete(name); }

    serialize() { return { enabled: this.enabled, files: [...this.files.entries()] }; }

    load(c) {
      if (!c) return;
      this.enabled = c.enabled !== false;
      if (Array.isArray(c.files)) this.files = new Map(c.files.map(([k, v]) => [String(k), String(v)]));
    }
  }

  /* ================= Почтовый сервер (SMTP + POP3) ================= */

  class EmailService {
    constructor(node) {
      this.node = node;
      this.smtp = true;
      this.pop3 = true;
      this.domain = '';
      this.users = [];
      this.boxes = new Map();
    }

    bind() {
      const tcp = this.node.tcp;
      if (!tcp) return;
      if (this.smtp) tcp.listen(P.PORT_SMTP, (conn) => { conn.h.onData = (d) => this.onSmtp(conn, d); });
      else tcp.unlisten(P.PORT_SMTP);
      if (this.pop3) tcp.listen(P.PORT_POP3, (conn) => { conn.h.onData = (d) => this.onPop3(conn, d); });
      else tcp.unlisten(P.PORT_POP3);
    }

    setDomain(d) {
      const n = String(d || '').trim().toLowerCase();
      if (n && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n)) throw new Error('Домен: например mail.lab или office.local');
      this.domain = n;
    }

    setUser(name, password) {
      const n = String(name || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,32}$/.test(n)) throw new Error('Имя пользователя: латиница, цифры, «.», «-», «_»');
      if (!password) throw new Error('Задайте пароль');
      this.users = this.users.filter((u) => u.name !== n);
      this.users.push({ name: n, password: String(password) });
    }

    removeUser(name) {
      this.users = this.users.filter((u) => u.name !== name);
      this.boxes.delete(name);
    }

    static parseAddr(a) {
      const m = /^\s*([a-z0-9._-]+)@([a-z0-9.-]+)\s*$/i.exec(String(a));
      return m ? { user: m[1].toLowerCase(), domain: m[2].toLowerCase() } : null;
    }

    /** SMTP: доставить письмо каждому получателю; чужие домены — переслать их серверу (DNS). */
    onSmtp(conn, d) {
      if (!d || d.smtp !== 'SEND') return;
      const to = Array.isArray(d.to) ? d.to : [];
      const results = new Array(to.length);
      const remote = new Map();
      to.forEach((addr, i) => {
        const a = EmailService.parseAddr(addr);
        if (!a) { results[i] = { to: addr, ok: false, text: 'неверный адрес' }; return; }
        if (this.domain && a.domain === this.domain) {
          if (!this.users.some((u) => u.name === a.user)) { results[i] = { to: addr, ok: false, text: 'нет такого пользователя на ' + this.domain }; return; }
          if (!this.boxes.has(a.user)) this.boxes.set(a.user, []);
          this.boxes.get(a.user).push({ from: String(d.from || ''), fromName: String(d.fromName || ''), to: to.join(', '), subject: String(d.subject || ''), body: String(d.body || ''), time: this.node.net.time });
          results[i] = { to: addr, ok: true, text: 'доставлено в ящик ' + a.user + '@' + this.domain };
          return;
        }
        if (d.relayed) { results[i] = { to: addr, ok: false, text: 'домен ' + a.domain + ' не обслуживается этим сервером' }; return; }
        if (!remote.has(a.domain)) remote.set(a.domain, []);
        remote.get(a.domain).push(i);
      });
      if (!remote.size) { this.finish(conn, results); return; }
      let left = remote.size;
      const done = () => { if (--left === 0) this.finish(conn, results); };
      for (const [domain, idx] of remote) {
        const fail = (text) => { for (const i of idx) results[i] = { to: to[i], ok: false, text }; done(); };
        this.node.resolveName(domain, (ip, err) => {
          if (ip == null) { fail('домен ' + domain + ' не найден (' + (err || 'DNS') + ')'); return; }
          if (this.node.hasIp(ip)) { fail('домен ' + domain + ' не обслуживается этим сервером'); return; }
          let answered = false;
          const c = this.node.tcp.connect(ip, P.PORT_SMTP, {
            onOpen: (cc) => cc.send(Object.assign({}, d, { to: idx.map((i) => to[i]), relayed: true })),
            onData: (r) => {
              if (!r || r.smtp !== 'RESULT') return;
              answered = true;
              (r.results || []).forEach((x, k) => { results[idx[k]] = { to: to[idx[k]], ok: !!x.ok, text: (x.ok ? 'доставлено через сервер ' : 'сервер ' + domain + ': ') + (x.ok ? domain : x.text) }; });
              done();
            },
            onError: (code, text) => { if (!answered) fail('сервер домена ' + domain + ' недоступен: ' + text); },
            onClose: () => { if (!answered) fail('сервер домена ' + domain + ' закрыл соединение'); },
          });
          if (!c) fail('не удалось подключиться к серверу ' + domain);
        });
      }
    }

    finish(conn, results) {
      conn.send({ smtp: 'RESULT', results });
      conn.close();
    }

    onPop3(conn, d) {
      if (!d || d.pop3 !== 'RETR') return;
      const user = String(d.user || '').toLowerCase();
      const u = this.users.find((x) => x.name === user);
      if (!u || u.password !== String(d.pass || '')) {
        conn.send({ pop3: 'ERR', text: 'Неверное имя пользователя или пароль' });
      } else {
        const box = this.boxes.get(user) || [];
        this.boxes.set(user, []);
        conn.send({ pop3: 'OK', messages: box });
      }
      conn.close();
    }

    serialize() {
      return { smtp: this.smtp, pop3: this.pop3, domain: this.domain, users: this.users.map((u) => Object.assign({}, u)), boxes: [...this.boxes.entries()] };
    }

    load(c) {
      if (!c) return;
      this.smtp = c.smtp !== false;
      this.pop3 = c.pop3 !== false;
      this.domain = String(c.domain || '');
      this.users = (c.users || []).map((u) => ({ name: String(u.name), password: String(u.password) }));
      this.boxes = new Map((c.boxes || []).map(([k, v]) => [String(k), Array.isArray(v) ? v : []]));
    }
  }

  /* ================= TFTP ================= */

  class TftpService {
    constructor(node) {
      this.node = node;
      this.enabled = true;
      this.files = new Map();
    }

    bind() {
      this.node.udp.set(P.PORT_TFTP, (pkt, f, frame) => {
        if (!this.enabled) { this.node.portClosed(pkt, f, frame); return; }
        const d = pkt.payload.data || {};
        const name = String(d.name || '');
        let reply;
        if (d.tftp === 'WRQ') {
          if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) reply = { tftp: 'ERROR', text: 'Недопустимое имя файла' };
          else {
            this.files.set(name, String(d.data || ''));
            reply = { tftp: 'ACK', name };
          }
        } else if (d.tftp === 'RRQ') {
          reply = this.files.has(name) ? { tftp: 'DATA', name, data: this.files.get(name) } : { tftp: 'ERROR', text: 'File not found' };
        } else return;
        const src = pkt.dst === U.BROADCAST_IP ? f.ip : pkt.dst;
        this.node.sendIp(P.ipv4(src, pkt.src, 'UDP', P.udp(P.PORT_TFTP, pkt.payload.sport, reply), this.node.defaultTtl), { why: 'TFTP: ' + (reply.tftp === 'ERROR' ? reply.text : reply.tftp === 'ACK' ? 'файл ' + name + ' сохранён' : 'передаю файл ' + name) });
      });
    }

    serialize() { return { enabled: this.enabled, files: [...this.files.entries()] }; }

    load(c) {
      if (!c) return;
      this.enabled = c.enabled !== false;
      this.files = new Map((c.files || []).map(([k, v]) => [String(k), String(v)]));
    }
  }

  NS.DhcpService = DhcpService;
  NS.DnsService = DnsService;
  NS.HttpService = HttpService;
  NS.EmailService = EmailService;
  NS.TftpService = TftpService;
})(globalThis.NetLab = globalThis.NetLab || {});
