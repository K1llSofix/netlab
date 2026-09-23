/* NetLab — приложения IP-узлов: ping, traceroute, DNS-резолвер.
 * Каждое приложение — «задача» (job), которую можно отменить (Ctrl+C) и которая
 * корректно завершается при перезапуске или удалении устройства. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;

  const PING_TIMEOUT = 400;
  const PING_INTERVAL = 25;
  const BCAST_WINDOW = 120;
  const DNS_TIMEOUT = 300;
  const DNS_TRIES = 2;
  const DNS_CACHE_TTL = 60000;

  function makeJob(node, onCancel) {
    const job = {
      done: false,
      cancel(reason) { if (!job.done) onCancel(reason); },
      finish() { job.done = true; node.jobs.delete(job); },
    };
    node.jobs.add(job);
    return job;
  }

  /** Определить IP по имени через DNS. cb(ip) или cb(null, текстОшибки). */
  IpNode.prototype.resolveName = function (name, cb) {
    const raw = String(name == null ? '' : name).trim();
    const ip = U.parseIp(raw);
    if (ip != null) { cb(ip); return; }
    const n = raw.toLowerCase();
    if (!n) { cb(null, 'Не указан адрес'); return; }
    if (!/^[a-z0-9.-]+$/.test(n)) { cb(null, '«' + raw + '» — это не IP-адрес и не доменное имя'); return; }
    const c = this.dnsCache.get(n);
    if (c && this.net.time - c.time < DNS_CACHE_TTL) { cb(c.ip); return; }
    if (this.dns == null) { cb(null, 'Не удалось найти узел «' + raw + '»: не задан DNS-сервер'); return; }
    const server = this.dns;
    const port = this.allocPort();
    let tries = 0;
    let timer = null;
    let done = false;
    const finish = (res, err) => {
      if (done) return;
      done = true;
      if (timer) timer.cancel();
      this.udp.delete(port);
      this.udpErr.delete(port);
      cb(res, err);
    };
    this.udp.set(port, (pkt) => {
      const d = pkt.payload.data || {};
      if (d.op !== 'answer' || d.id !== port) return;
      if (d.ip != null) {
        this.dnsCache.set(n, { ip: d.ip, time: this.net.time });
        finish(d.ip);
      } else {
        finish(null, 'DNS-сервер не знает имя «' + raw + '»');
      }
    });
    this.udpErr.set(port, () => finish(null, 'На ' + U.ipStr(server) + ' не работает служба DNS'));
    const attempt = () => {
      timer = null;
      if (done) return;
      if (++tries > DNS_TRIES) { finish(null, 'DNS-сервер ' + U.ipStr(server) + ' не отвечает'); return; }
      this.sendIp(P.ipv4(null, server, 'UDP', P.udp(port, 53, { op: 'query', id: port, name: n }), this.defaultTtl), {
        why: 'DNS-запрос: какой адрес у «' + n + '»?',
        onError: (code, text) => finish(null, 'Нет связи с DNS-сервером: ' + text),
      });
      if (!done) timer = this.timer(DNS_TIMEOUT, attempt);
    };
    attempt();
  };

  /** Эхо-запрос по IPv4 или IPv6 (адрес — число или BigInt). */
  IpNode.prototype.sendEcho = function (ip, id, seq, size, ttl, opts) {
    if (typeof ip === 'bigint') return this.sendIp6(P.ipv6(null, ip, 'ICMPv6', P.echoRequest(id, seq, size), ttl || this.defaultTtl), opts);
    return this.sendIp(P.ipv4(null, ip, 'ICMP', P.echoRequest(id, seq, size), ttl || this.defaultTtl), opts);
  };

  /** Адрес назначения: IPv6-литерал сразу, остальное — через DNS (IPv4). */
  IpNode.prototype.resolveTarget = function (target, cb) {
    const v6 = NS.ip6 ? NS.ip6.parse(String(target)) : null;
    if (v6 != null) { cb(v6); return; }
    this.resolveName(target, cb);
  };

  /**
   * ping. o = { count (Infinity — до отмены), timeout, interval, ttl, size, onEvent(ev) }
   * События: start, reply, timeout, unreachable, ttl-expired, error, resolve-fail, done.
   */
  IpNode.prototype.ping = function (target, o) {
    o = o || {};
    const emit = o.onEvent || (() => {});
    const count = o.count == null ? 4 : o.count;
    const timeout = o.timeout || PING_TIMEOUT;
    const interval = o.interval == null ? PING_INTERVAL : o.interval;
    const size = o.size || 32;
    const id = this.nextIcmpId++;
    let ip = null;
    let bcast = false;
    let sent = 0;
    let received = 0;
    let lost = 0;
    const rtts = [];
    let cur = null;
    let timer = null;

    const finish = (cancelled, reason) => {
      if (job.done) return;
      job.finish();
      if (timer) timer.cancel();
      this.icmpListeners.delete(id);
      emit({ type: 'done', ip, sent, received, lost, rtts, cancelled: !!cancelled, reason });
    };
    const job = makeJob(this, (reason) => finish(true, reason));

    const scheduleNext = () => {
      if (timer) timer.cancel();
      timer = this.timer(sent >= count ? 0 : interval, next);
    };

    const next = () => {
      timer = null;
      if (job.done) return;
      if (sent >= count) { finish(false); return; }
      const seq = ++sent;
      const probe = { seq, t0: this.net.time, done: false, replies: 0 };
      cur = probe;
      this.sendEcho(ip, id, seq, size, o.ttl, {
        why: 'Эхо-запрос (ping) №' + seq,
        onError: (code, text) => {
          if (job.done || probe.done) return;
          probe.done = true;
          lost++;
          emit({ type: 'error', seq, code, text });
          scheduleNext();
        },
      });
      if (!probe.done) {
        timer = this.timer(bcast ? BCAST_WINDOW : timeout, () => {
          timer = null;
          if (probe.done) return;
          probe.done = true;
          if (bcast && probe.replies > 0) received++;
          else { lost++; emit({ type: 'timeout', seq }); }
          scheduleNext();
        });
      }
    };

    this.icmpListeners.set(id, (info) => {
      if (job.done || !cur || info.seq !== cur.seq || cur.done) return;
      const rtt = this.net.time - cur.t0;
      if (info.kind === 'reply') {
        if (bcast) {
          if (cur.replies === 0) rtts.push(rtt);
          cur.replies++;
          emit({ type: 'reply', from: info.from, seq: info.seq, rtt, ttl: info.ttl, bytes: size });
          return;
        }
        cur.done = true;
        received++;
        rtts.push(rtt);
        emit({ type: 'reply', from: info.from, seq: info.seq, rtt, ttl: info.ttl, bytes: size });
      } else {
        cur.done = true;
        lost++;
        emit({ type: info.kind === 'time-exceeded' ? 'ttl-expired' : 'unreachable', from: info.from, seq: info.seq, code: info.code });
      }
      scheduleNext();
    });

    this.resolveTarget(target, (addr, err) => {
      if (job.done) return;
      if (addr == null) {
        emit({ type: 'resolve-fail', text: err });
        finish(false);
        return;
      }
      ip = addr;
      bcast = typeof ip !== 'bigint' && (ip === U.BROADCAST_IP || this.ifaces.some((f) => this.isDirectedBcast(ip, f)));
      emit({ type: 'start', ip, name: String(target), size, bcast });
      next();
    });
    return job;
  };

  /**
   * traceroute. o = { maxHops, timeout, onEvent(ev) }
   * События: start, hop {ttl, rtts[], from, kind}, resolve-fail, done {reached}.
   */
  IpNode.prototype.traceroute = function (target, o) {
    o = o || {};
    const emit = o.onEvent || (() => {});
    const maxHops = o.maxHops || 30;
    const timeout = o.timeout || PING_TIMEOUT;
    const PROBES = 3;
    const id = this.nextIcmpId++;
    let ip = null;
    let ttl = 0;
    let seq = 0;
    let hop = null;
    let timer = null;
    let reached = false;

    const finish = (cancelled, reason) => {
      if (job.done) return;
      job.finish();
      if (timer) timer.cancel();
      this.icmpListeners.delete(id);
      emit({ type: 'done', ip, reached, cancelled: !!cancelled, reason });
    };
    const job = makeJob(this, (reason) => finish(true, reason));

    const endHop = () => {
      if (job.done) return;
      emit({ type: 'hop', ttl: hop.ttl, rtts: hop.rtts.slice(), from: hop.from, kind: hop.kind, code: hop.code, text: hop.text });
      if (hop.kind === 'reply') { reached = true; finish(false); return; }
      if (hop.kind === 'unreachable' || hop.kind === 'error') { finish(false); return; }
      if (ttl >= maxHops) { finish(false); return; }
      timer = this.timer(1, startHop);
    };

    const probe = () => {
      timer = null;
      if (job.done) return;
      if (hop.rtts.length >= PROBES) { endHop(); return; }
      const s = ++seq;
      const p = { seq: s, t0: this.net.time, done: false };
      hop.cur = p;
      this.sendEcho(ip, id, s, 32, ttl, {
        why: 'Трассировка: эхо-запрос с TTL=' + ttl,
        onError: (code, text) => {
          if (job.done || p.done) return;
          p.done = true;
          if (timer) timer.cancel();
          hop.kind = 'error';
          hop.text = text;
          hop.rtts.push(null);
          endHop();
        },
      });
      if (!p.done) {
        timer = this.timer(timeout, () => {
          timer = null;
          if (p.done) return;
          p.done = true;
          hop.rtts.push(null);
          probe();
        });
      }
    };

    const startHop = () => {
      timer = null;
      if (job.done) return;
      ttl++;
      hop = { ttl, rtts: [], from: null, kind: 'timeout', code: null, text: null, cur: null };
      probe();
    };

    this.icmpListeners.set(id, (info) => {
      if (job.done || !hop || !hop.cur || info.seq !== hop.cur.seq || hop.cur.done) return;
      hop.cur.done = true;
      if (timer) timer.cancel();
      hop.rtts.push(this.net.time - hop.cur.t0);
      hop.from = info.from;
      hop.kind = info.kind === 'reply' ? 'reply' : info.kind === 'time-exceeded' ? 'ttl' : 'unreachable';
      hop.code = info.code;
      probe();
    });

    this.resolveTarget(target, (addr, err) => {
      if (job.done) return;
      if (addr == null) {
        emit({ type: 'resolve-fail', text: err });
        finish(false);
        return;
      }
      ip = addr;
      emit({ type: 'start', ip, name: String(target), maxHops });
      startHop();
    });
    return job;
  };

  /* ================= общий помощник: запрос-ответ по TCP ================= */

  /**
   * Подключиться к host:port, отправить одно сообщение и дождаться ответа (как HTTP/SMTP/POP3).
   * accept(data) → true, если это нужный ответ. cb({ok, data, error, ip}).
   */
  IpNode.prototype.tcpRequest = function (host, port, message, accept, cb) {
    let finished = false;
    let conn = null;
    const job = makeJob(this, (reason) => { if (conn) conn.abort(reason); done({ ok: false, error: reason || 'Прервано' }); });
    const done = (r) => {
      if (finished) return;
      finished = true;
      job.finish();
      cb(r);
    };
    this.resolveName(host, (ip, err) => {
      if (finished) return;
      if (ip == null) { done({ ok: false, error: err || 'Не удалось определить адрес', resolve: true }); return; }
      let answer = null;
      conn = this.tcp.connect(ip, port, {
        onOpen: (c) => c.send(message),
        onData: (d) => { if (!answer && accept(d)) answer = d; },
        onClose: () => done(answer ? { ok: true, data: answer, ip } : { ok: false, error: 'Сервер закрыл соединение без ответа', ip }),
        onError: (code, text) => {
          if (answer) { done({ ok: true, data: answer, ip }); return; }
          done({ ok: false, code, error: code === 'refused' ? 'Сервер отклонил соединение: на ' + U.ipStr(ip) + ' порт ' + port + ' закрыт (служба выключена?)' : text, ip });
        },
      });
    });
    return job;
  };

  /* ================= веб-браузер ================= */

  /** Разобрать адрес «http://узел/страница». */
  IpNode.parseUrl = function (url) {
    let u = String(url || '').trim();
    u = u.replace(/^https?:\/\//i, '');
    if (!u) return null;
    const slash = u.indexOf('/');
    let host = (slash >= 0 ? u.slice(0, slash) : u).toLowerCase();
    let port = null;
    const m = /^(.+):(\d{1,5})$/.exec(host);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 65535) { host = m[1]; port = Number(m[2]); }
    let path = slash >= 0 ? u.slice(slash) : '/';
    if (path === '/') path = '/index.html';
    return host ? { host, path, port } : null;
  };

  /** HTTP GET. cb({ok, status, body, error, url}). */
  IpNode.prototype.httpGet = function (url, cb) {
    const u = IpNode.parseUrl(url);
    if (!u) { cb({ ok: false, error: 'Введите адрес, например http://192.168.1.10' }); return null; }
    const hp = u.host + (u.port && u.port !== P.PORT_HTTP ? ':' + u.port : '');
    return this.tcpRequest(u.host, u.port || P.PORT_HTTP, { http: 'GET', path: u.path, host: u.host }, (d) => d && d.http === 'RESP', (r) => {
      if (!r.ok) {
        cb({ ok: false, error: r.resolve ? 'Не удалось найти узел «' + u.host + '»: ' + r.error : r.error, url: 'http://' + hp + u.path });
        return;
      }
      cb({ ok: true, status: r.data.status, reason: r.data.reason, body: String(r.data.body || ''), url: 'http://' + hp + u.path, host: hp });
    });
  };

  /* ================= почтовый клиент (SMTP / POP3) ================= */

  /** Отправить письмо через SMTP-сервер из настроек. cb({ok, results[], error}). */
  NS.Host.prototype.emailSend = function (to, subject, body, cb) {
    const e = this.email;
    if (!e.address || !/^[^@\s]+@[^@\s]+$/.test(e.address)) { cb({ ok: false, error: 'В настройках почты не указан ваш адрес (Email Address)' }); return null; }
    if (!e.outgoing) { cb({ ok: false, error: 'Не указан сервер исходящей почты (SMTP)' }); return null; }
    const list = [];
    for (const raw of to) {
      const t = String(raw).trim();
      if (t && !list.some((x) => x.toLowerCase() === t.toLowerCase())) list.push(t);
    }
    if (!list.length) { cb({ ok: false, error: 'Не указан ни один получатель' }); return null; }
    const msg = { smtp: 'SEND', from: e.address, fromName: e.name || this.name, to: list, subject: String(subject || ''), body: String(body || '') };
    return this.tcpRequest(e.outgoing, P.PORT_SMTP, msg, (d) => d && d.smtp === 'RESULT', (r) => {
      if (!r.ok) { cb({ ok: false, error: 'Сервер исходящей почты: ' + r.error }); return; }
      cb({ ok: true, results: r.data.results || [] });
    });
  };

  /** Забрать письма с POP3-сервера. cb({ok, count, error}). */
  NS.Host.prototype.emailReceive = function (cb) {
    const e = this.email;
    if (!e.incoming) { cb({ ok: false, error: 'Не указан сервер входящей почты (POP3)' }); return null; }
    if (!e.user) { cb({ ok: false, error: 'Не указано имя пользователя почты' }); return null; }
    return this.tcpRequest(e.incoming, P.PORT_POP3, { pop3: 'RETR', user: e.user, pass: e.password }, (d) => d && d.pop3, (r) => {
      if (!r.ok) { cb({ ok: false, error: 'Сервер входящей почты: ' + r.error }); return; }
      if (r.data.pop3 !== 'OK') { cb({ ok: false, error: r.data.text || 'Ошибка POP3' }); return; }
      const msgs = r.data.messages || [];
      for (const m of msgs) this.emailBox.unshift(Object.assign({ read: false }, m));
      if (msgs.length) this.net.emit('mail', { dev: this, message: { from: msgs[0].from, subject: msgs[0].subject, email: true } });
      cb({ ok: true, count: msgs.length });
    });
  };

  /* ================= Telnet / SSH клиент ================= */

  /**
   * Удалённая консоль. proto: telnet | ssh. h: {onOutput(lines), onPrompt(prompt, mask), onClose(reason)}.
   * Возвращает {send(line), close()}.
   */
  IpNode.prototype.openRemote = function (proto, target, user, h) {
    const port = proto === 'ssh' ? P.PORT_SSH : P.PORT_TELNET;
    const sess = { conn: null, closed: false };
    const close = (reason) => {
      if (sess.closed) return;
      sess.closed = true;
      job.finish();
      h.onClose(reason);
    };
    const job = makeJob(this, (reason) => { if (sess.conn) sess.conn.abort(reason); close(reason || 'Прервано'); });
    sess.send = (line, mask) => { if (sess.conn && !sess.closed) sess.conn.send({ term: 'line', text: String(line), mask: !!mask }); };
    sess.close = () => { if (sess.conn) sess.conn.close(); close(null); };
    this.resolveName(target, (ip, err) => {
      if (sess.closed) return;
      if (ip == null) { close('% Неизвестный узел: ' + (err || target)); return; }
      h.onOutput(['Trying ' + U.ipStr(ip) + ' ...' + (proto === 'ssh' ? '' : 'Open')]);
      sess.conn = this.tcp.connect(ip, port, {
        onOpen: (c) => c.send({ term: 'hello', proto, user: user || null }),
        onData: (d) => {
          if (!d || d.term !== 'out') return;
          if (d.lines && d.lines.length) h.onOutput(d.lines);
          if (d.close) { close('[Соединение с ' + U.ipStr(ip) + ' закрыто удалённым узлом]'); return; }
          if (d.prompt != null) h.onPrompt(d.prompt, !!d.mask);
        },
        onClose: () => close('[Соединение с ' + U.ipStr(ip) + ' закрыто удалённым узлом]'),
        onError: (code, text) => close(code === 'refused' ? '% Connection refused by remote host (' + (proto === 'ssh' ? 'SSH' : 'Telnet') + ' на ' + U.ipStr(ip) + ' недоступен)' : '% ' + text),
      });
    });
    return sess;
  };

  /* ================= TFTP-клиент (copy running-config tftp:) ================= */

  IpNode.prototype.tftp = function (server, op, name, data, cb) {
    const port = this.allocPort();
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
      if (d.tftp === 'ERROR') finish({ ok: false, error: d.text || 'Ошибка TFTP' });
      else if (d.tftp === 'ACK' || d.tftp === 'DATA') finish({ ok: true, data: d.data });
    });
    this.udpErr.set(port, () => finish({ ok: false, error: 'На сервере не работает служба TFTP' }));
    const attempt = () => {
      if (done) return;
      if (++tries > 3) { finish({ ok: false, error: 'TFTP-сервер не отвечает (истекло время ожидания)' }); return; }
      this.sendIp(P.ipv4(null, server, 'UDP', P.udp(port, P.PORT_TFTP, { tftp: op, name, data: op === 'WRQ' ? data : undefined }), this.defaultTtl), {
        why: 'TFTP ' + (op === 'WRQ' ? 'запись' : 'чтение') + ' файла ' + name,
        onError: (c, t) => finish({ ok: false, error: t }),
      });
      if (!done) timer = this.timer(250, attempt);
    };
    attempt();
  };

  /* ================= генератор трафика ================= */

  /**
   * Сгенерировать трафик. o: {dst, proto: icmp|udp|tcp, dport, sport, ttl, size, count, interval, onEvent}.
   * События: {type: 'sent'|'ok'|'fail'|'done', text}.
   */
  IpNode.prototype.trafficGen = function (o) {
    const emit = o.onEvent || (() => {});
    const count = Math.max(1, Math.min(1000, Number(o.count) || 1));
    const interval = Math.max(1, Number(o.interval) || 50);
    if (o.proto === 'icmp') {
      let n = 0;
      return this.ping(o.dst, {
        count, ttl: o.ttl || undefined, size: o.size || 32, interval,
        onEvent: (ev) => {
          if (ev.type === 'reply') emit({ type: 'ok', text: '№' + (++n) + ': ответ от ' + U.ipStr(ev.from) + ' за ' + ev.rtt + ' тиков' });
          else if (ev.type === 'timeout') emit({ type: 'fail', text: '№' + (++n) + ': нет ответа' });
          else if (ev.type === 'unreachable' || ev.type === 'ttl-expired') emit({ type: 'fail', text: '№' + (++n) + ': ' + U.ipStr(ev.from) + (ev.type === 'ttl-expired' ? ' — истёк TTL' : ' — недоступно') });
          else if (ev.type === 'error' || ev.type === 'resolve-fail') emit({ type: 'fail', text: ev.text || IpNode.errorText(ev.code) });
          else if (ev.type === 'done') emit({ type: 'done', text: 'Отправлено ' + ev.sent + ', получено ответов ' + ev.received });
        },
      });
    }
    let sent = 0;
    let ok = 0;
    let timer = null;
    let finished = false;
    const job = makeJob(this, () => finish());
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) timer.cancel();
      job.finish();
      emit({ type: 'done', text: 'Отправлено ' + sent + (o.proto === 'tcp' ? ', успешных соединений ' + ok : '') });
    };
    const dport = Number(o.dport) || 80;
    this.resolveName(o.dst, (ip, err) => {
      if (finished) return;
      if (ip == null) { emit({ type: 'fail', text: err }); finish(); return; }
      const one = () => {
        timer = null;
        if (finished) return;
        if (sent >= count) { finish(); return; }
        const n = ++sent;
        if (o.proto === 'udp') {
          const sport = Number(o.sport) || this.allocPort();
          this.udpErr.set(sport, (info) => emit({ type: 'fail', text: '№' + n + ': ' + U.ipStr(info.from) + (info.code === 3 ? ' — порт ' + dport + ' закрыт' : ' — недоступно') }));
          this.sendIp(P.ipv4(null, ip, 'UDP', P.udp(sport, dport, { gen: true, size: o.size || 32 }), Number(o.ttl) || this.defaultTtl), {
            why: 'Генератор трафика: UDP-дейтаграмма №' + n, onError: (c, t) => emit({ type: 'fail', text: '№' + n + ': ' + t }),
          });
          emit({ type: 'sent', text: '№' + n + ': UDP → ' + U.ipStr(ip) + ':' + dport });
          timer = this.timer(interval, one);
        } else {
          this.tcp.connect(ip, dport, {
            onOpen: (c) => { ok++; emit({ type: 'ok', text: '№' + n + ': TCP-соединение с ' + U.ipStr(ip) + ':' + dport + ' установлено' }); c.send({ gen: true, size: o.size || 32 }); c.close(); },
            onClose: () => { if (!finished) timer = this.timer(interval, one); },
            onError: (code, text) => { emit({ type: 'fail', text: '№' + n + ': ' + text }); if (!finished) timer = this.timer(interval, one); },
          });
        }
      };
      one();
    });
    return job;
  };
})(globalThis.NetLab = globalThis.NetLab || {});
