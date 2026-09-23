/* NetLab — упрощённый TCP: рукопожатие SYN / SYN-ACK / ACK, подтверждения, повторная передача
 * (stop-and-wait: один неподтверждённый сегмент), закрытие FIN, отказ RST.
 * Одно сообщение приложения = один сегмент, поэтому в режиме симуляции всё хорошо видно. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;

  const RTO = 150;
  const MAX_TRIES = 5;

  function dataLen(d) {
    try { return Math.max(1, Math.min(65000, JSON.stringify(d).length)); } catch (e) { return 1; }
  }

  class TcpConn {
    constructor(stack, rip, rport, lport, handlers) {
      this.stack = stack;
      this.rip = rip;
      this.rport = rport;
      this.lport = lport;
      this.lip = null;
      this.h = handlers || {};
      this.state = 'CLOSED';
      this.iss = stack.newIss();
      this.sndNxt = this.iss;
      this.rcvNxt = 0;
      this.outq = [];
      this.inflight = null;
      this.finSent = false;
      this.finRcvd = false;
      this.done = false;
    }

    get key() { return this.rip + ':' + this.rport + ':' + this.lport; }
    get node() { return this.stack.node; }

    /** Отправить сообщение приложения (объект). */
    send(data) {
      if (this.done || this.finSent || this.closing) return false;
      this.outq.push({ flags: 'PSH,ACK', data, len: dataLen(data) });
      this.pump();
      return true;
    }

    /** Корректно закрыть соединение (после отправки всех данных). */
    close() {
      if (this.done || this.closing) return;
      this.closing = true;
      this.outq.push({ flags: 'FIN,ACK', data: null, len: 1, fin: true });
      this.pump();
    }

    abort(reason) {
      if (this.done) return;
      this.stack.sendRaw(this, 'RST', this.sndNxt, 0, null, 0);
      this.fail('aborted', reason || 'Соединение прервано');
    }

    pump() {
      if (this.done || this.inflight || !this.outq.length) return;
      if (this.state !== 'ESTABLISHED' && this.state !== 'CLOSE_WAIT' && !(this.outq[0].flags.startsWith('SYN'))) return;
      const item = this.outq.shift();
      item.seq = this.sndNxt;
      this.sndNxt += item.len;
      item.tries = 0;
      if (item.fin) {
        this.finSent = true;
        this.state = this.finRcvd ? 'LAST_ACK' : 'FIN_WAIT';
      }
      this.inflight = item;
      this.transmit();
    }

    transmit() {
      const it = this.inflight;
      if (!it || this.done) return;
      if (++it.tries > MAX_TRIES) {
        this.fail('timeout', 'Нет ответа от ' + U.ipStr(this.rip) + ' (истекло время ожидания TCP)');
        return;
      }
      const ack = it.flags === 'SYN' ? 0 : this.rcvNxt;
      this.stack.sendRaw(this, it.flags, it.seq, ack, it.data, it.data != null ? it.len : 0, it.tries > 1);
      if (it.timer) it.timer.cancel();
      it.timer = this.node.timer(RTO, () => this.transmit());
    }

    /** Пришло подтверждение ack. */
    acked(ack) {
      const it = this.inflight;
      if (!it || ack < it.seq + it.len) return;
      if (it.timer) it.timer.cancel();
      this.inflight = null;
      if (it.fin && this.finRcvd) { this.finish(); return; }
      this.pump();
    }

    finish() {
      if (this.done) return;
      this.done = true;
      this.state = 'CLOSED';
      if (this.inflight && this.inflight.timer) this.inflight.timer.cancel();
      this.stack.conns.delete(this.key);
      if (this.h.onClose) this.h.onClose(this);
    }

    fail(code, text) {
      if (this.done) return;
      this.done = true;
      this.state = 'CLOSED';
      if (this.inflight && this.inflight.timer) this.inflight.timer.cancel();
      this.stack.conns.delete(this.key);
      if (this.h.onError) this.h.onError(code, text, this);
    }
  }

  class TcpStack {
    constructor(node) {
      this.node = node;
      this.listeners = new Map();
      this.conns = new Map();
      this.issCounter = 1000 + (Math.imul(String(node.id).length + node.id.charCodeAt(node.id.length - 1), 7919) % 40000);
    }

    newIss() {
      this.issCounter = (this.issCounter + 64013) % 2000000000;
      return this.issCounter;
    }

    /** Принимать соединения на порту. onAccept(conn) вызывается после рукопожатия. */
    listen(port, onAccept) { this.listeners.set(port, onAccept); }
    unlisten(port) { this.listeners.delete(port); }

    /** Установить соединение. handlers: onOpen, onData, onClose, onError. */
    connect(rip, rport, handlers) {
      const conn = new TcpConn(this, rip, rport, this.node.allocPort(), handlers);
      this.conns.set(conn.key, conn);
      conn.state = 'SYN_SENT';
      conn.outq.push({ flags: 'SYN', data: null, len: 1 });
      conn.pump();
      return conn;
    }

    abortAll(reason) {
      for (const c of [...this.conns.values()]) c.fail('reset', reason);
    }

    sendRaw(conn, flags, seq, ack, data, len, retrans) {
      const seg = P.tcp(conn.lport, conn.rport, seq, ack, flags, data, len);
      const pkt = P.ipv4(conn.lip, conn.rip, 'TCP', seg, this.node.defaultTtl);
      const what = flags === 'SYN' ? 'TCP SYN: открываю соединение с ' + U.ipStr(conn.rip) + ':' + conn.rport
        : flags === 'SYN,ACK' ? 'TCP SYN+ACK: соглашаюсь на соединение'
          : flags === 'RST' || flags === 'RST,ACK' ? 'TCP RST: соединение отклонено'
            : flags.startsWith('FIN') ? 'TCP FIN: закрываю соединение'
              : data != null ? 'TCP: данные приложения (seq ' + seq + ')' : 'TCP ACK: подтверждаю получение (ack ' + ack + ')';
      this.node.sendIp(pkt, {
        why: what + (retrans ? ' — повторная передача' : ''),
        onError: (code, text) => { if (!conn.done && flags !== 'ACK') conn.fail(code, text); },
      });
      if (conn.lip == null && pkt.src != null) conn.lip = pkt.src;
    }

    reply(pkt, flags, seq, ack) {
      const s = pkt.payload;
      const seg = P.tcp(s.dport, s.sport, seq, ack, flags, null, 0);
      this.node.sendIp(P.ipv4(pkt.dst, pkt.src, 'TCP', seg, this.node.defaultTtl), { why: 'TCP ' + flags + ': ' + (flags.startsWith('RST') ? 'на этом порту никто не слушает' : 'ответ') });
    }

    onSegment(pkt, f, frame) {
      const s = pkt.payload;
      const key = pkt.src + ':' + s.sport + ':' + s.dport;
      let conn = this.conns.get(key);
      const has = (x) => P.hasFlag(s, x);

      if (!conn) {
        if (has('RST')) return;
        if (has('SYN') && !has('ACK')) {
          const accept = this.listeners.get(s.dport);
          if (!accept) {
            this.reply(pkt, 'RST,ACK', 0, s.seq + 1);
            if (frame) this.node.drop(frame, 'TCP-порт ' + s.dport + ' закрыт — отвечаю RST');
            return;
          }
          conn = new TcpConn(this, pkt.src, s.sport, s.dport, null);
          conn.lip = pkt.dst;
          conn.accept = accept;
          conn.state = 'SYN_RCVD';
          conn.rcvNxt = s.seq + 1;
          this.conns.set(key, conn);
          conn.outq.push({ flags: 'SYN,ACK', data: null, len: 1 });
          conn.pump();
          return;
        }
        this.reply(pkt, 'RST', s.ack || 0, 0);
        return;
      }

      if (has('RST')) {
        conn.fail(conn.state === 'SYN_SENT' ? 'refused' : 'reset',
          conn.state === 'SYN_SENT' ? 'Подключение отклонено: на ' + U.ipStr(conn.rip) + ' порт ' + conn.rport + ' закрыт' : 'Соединение сброшено удалённой стороной');
        return;
      }

      if (conn.state === 'SYN_SENT') {
        if (has('SYN') && has('ACK')) {
          conn.rcvNxt = s.seq + 1;
          conn.acked(s.ack);
          conn.state = 'ESTABLISHED';
          this.sendRaw(conn, 'ACK', conn.sndNxt, conn.rcvNxt, null, 0);
          if (conn.h.onOpen) conn.h.onOpen(conn);
          conn.pump();
        }
        return;
      }

      if (has('SYN')) {
        // повтор SYN — наш SYN-ACK потерялся, он будет передан повторно по таймеру
        return;
      }

      if (has('ACK')) {
        conn.acked(s.ack);
        if (conn.state === 'SYN_RCVD' && !conn.inflight) {
          conn.state = 'ESTABLISHED';
          if (conn.accept) conn.accept(conn);
          conn.pump();
        }
      }
      if (conn.done) return;

      const len = s.data != null ? s.len : has('FIN') ? 1 : 0;
      if (!len) return;
      if (s.seq === conn.rcvNxt) {
        conn.rcvNxt += len;
        this.sendRaw(conn, 'ACK', conn.sndNxt, conn.rcvNxt, null, 0);
        if (s.data != null && conn.h.onData) conn.h.onData(s.data, conn);
        if (has('FIN')) {
          conn.finRcvd = true;
          if (conn.finSent && !conn.inflight) { conn.finish(); return; }
          if (!conn.finSent) {
            conn.state = 'CLOSE_WAIT';
            if (conn.h.onRemoteClose) conn.h.onRemoteClose(conn);
            conn.close();
          }
        }
      } else if (s.seq < conn.rcvNxt) {
        this.sendRaw(conn, 'ACK', conn.sndNxt, conn.rcvNxt, null, 0);
      }
    }

    onIcmpError(info) {
      const o = info.original;
      const seg = o && o.payload;
      if (!seg) return;
      const conn = this.conns.get(o.dst + ':' + seg.dport + ':' + seg.sport);
      if (!conn) return;
      const text = info.kind === 'time-exceeded' ? U.ipStr(info.from) + ': истёк TTL'
        : info.code === 13 ? U.ipStr(info.from) + ': запрещено списком доступа'
          : info.code === 0 ? U.ipStr(info.from) + ': нет маршрута до сети назначения'
            : U.ipStr(info.from) + ': узел назначения недоступен';
      conn.fail('unreachable', text);
    }

    list() { return [...this.conns.values()]; }
  }

  NS.TcpStack = TcpStack;
})(globalThis.NetLab = globalThis.NetLab || {});
