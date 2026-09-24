/* NetLab — IP-телефония, дополнения: удержание вызова (Hold / Resume), слепой перевод (Transfer),
 * вызовы между разными CME по dial-peer voice N voip (destination-pattern, session target ipv4:X).
 * Сигнализация между CME — упрощённый H.323 (H.225 по TCP 1720: Setup / Alerting / Connect / Release),
 * голос (RTP) по-прежнему идёт напрямую между телефонами. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const V = NS.voip;
  const X = NS.cliIos.ext;
  const { SccpClient, RTP_BASE, CME_HOOKS } = V;

  const H323_PORT = 1720;
  const NUM_RE = /^[0-9*#]{1,16}$/;

  /* ================= телефон: удержание и перевод ================= */

  const talkText = (c) => (c.hold ? 'На удержании: ' + c.peer : c.remoteHold ? c.peer + ' поставил вас на удержание ♫' : 'Разговор с ' + c.peer);

  const SP = SccpClient.prototype;
  const say0 = SP.say;
  SP.say = function (text) {
    const c = this.call;
    if (c && c.state === 'connected' && c.hold) return 'Вызов на удержании — нажмите «Вернуть»';
    if (c && c.state === 'connected' && c.remoteHold) return 'Собеседник поставил вызов на удержание';
    return say0.call(this, text);
  };

  /** Поставить разговор на удержание (собеседник слышит музыку, голос не передаётся). */
  SP.hold = function () {
    const c = this.call;
    if (!c || c.state !== 'connected') return 'Нет разговора';
    if (c.hold) return null;
    c.hold = true;
    c.text = talkText(c);
    this.send({ sccp: 'Hold', callId: c.id });
    this.node.note('Телефон ' + this.number + ': вызов с ' + c.peer + ' поставлен на удержание', null, 'info');
    this.emit();
    return null;
  };

  SP.resume = function () {
    const c = this.call;
    if (!c || c.state !== 'connected' || !c.hold) return 'Нет вызова на удержании';
    c.hold = false;
    c.text = talkText(c);
    this.send({ sccp: 'Resume', callId: c.id });
    this.emit();
    return null;
  };

  /** Слепой перевод: собеседник соединяется с номером number, этот телефон освобождается. */
  SP.transfer = function (number) {
    const n = String(number || '').trim();
    const c = this.call;
    if (!c || c.state !== 'connected') return 'Перевести можно только идущий разговор';
    if (!NUM_RE.test(n)) return 'Наберите номер, на который перевести вызов';
    c.text = 'Перевод на ' + n + '…';
    this.send({ sccp: 'Transfer', callId: c.id, number: n });
    this.emit();
    return null;
  };

  SccpClient.onExtMsg = function (ph, d) {
    const c = ph.call;
    if (!c || d.callId == null || c.id !== d.callId) return false;
    switch (d.sccp) {
      case 'Held':
      case 'Resumed':
        c.remoteHold = d.sccp === 'Held';
        c.text = talkText(c);
        return true;
      case 'Transferred':
        // собеседник перевёл нас: телефон сам «набирает» новый номер (CME пришлёт Ringback / Busy)
        ph.freeRtp();
        ph.call = { id: null, state: 'dialing', dir: 'out', peer: d.number, text: 'Перевод на ' + d.number + '…' };
        ph.node.note('Телефон ' + ph.number + ': собеседник перевёл вызов на ' + d.number, null, 'info');
        return true;
      case 'Update':
        // удалённый CME перевёл собеседника на другой телефон: ждём ответа нового абонента
        ph.freeRtp();
        Object.assign(c, { state: 'ringback', hold: false, remoteHold: false, peer: d.number || c.peer, text: 'Перевод на ' + (d.number || c.peer) + '…' });
        return true;
      case 'XferFail':
        c.text = 'Перевод не выполнен: ' + d.text;
        return true;
      default:
        return false;
    }
  };

  Object.assign(V.SCCP_TEXT, {
    Hold: () => 'вызов поставлен на удержание',
    Resume: () => 'возврат к разговору',
    Held: () => 'собеседник поставил вызов на удержание (музыка)',
    Resumed: () => 'собеседник вернулся к разговору',
    Transfer: (d) => 'перевести собеседника на ' + d.number,
    Transferred: (d) => 'вас переводят на ' + d.number,
    Update: (d) => 'собеседник переведён на ' + d.number,
    XferFail: (d) => 'перевод не выполнен: ' + d.text,
  });

  /* ================= dial-peer ================= */

  /** destination-pattern → RegExp: «.» — любая цифра, «T» — любое число цифр, [1-3] — диапазон. */
  function patRe(p) {
    let s = '';
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === '.') s += '[0-9*#]';
      else if (ch === 'T' || ch === 't') { if (i !== p.length - 1) return null; s += '[0-9*#]*'; }
      else if (ch === '[') {
        const j = p.indexOf(']', i);
        if (j < 0 || !/^\^?[0-9\-]+$/.test(p.slice(i + 1, j))) return null;
        s += '[' + p.slice(i + 1, j) + ']';
        i = j;
      } else if (/[0-9#]/.test(ch)) s += ch;
      else if (ch === '*') s += '\\*';
      else return null;
    }
    return s ? new RegExp('^' + s + '$') : null;
  }

  /** Самый точный подходящий dial-peer (больше явных цифр, затем меньше preference). */
  function matchPeer(c, number) {
    let best = null;
    for (const [tag, p] of Object.entries((c && c.peers) || {})) {
      if (!p.pattern || p.shut) continue;
      const re = patRe(p.pattern);
      if (!re || !re.test(number)) continue;
      const lit = (p.pattern.replace(/\[[^\]]*\]/g, '').match(/[0-9*#]/g) || []).length;
      if (!best || lit > best.lit || (lit === best.lit && (p.pref || 0) < (best.p.pref || 0))) best = { tag, p, lit };
    }
    return best ? [best.tag, best.p] : null;
  }

  const numOf = (reg) => (reg && reg.lines.length ? reg.lines[0].number : '?');

  /* ================= CME: удержание, перевод, вызовы через H.323 ================= */

  function trunkSend(call, msg) {
    const t = call.trunk;
    if (t && t.conn && !t.conn.done) t.conn.send(msg);
  }

  function trunkRelease(call, cause) {
    const t = call.trunk;
    if (!t || !t.conn || t.conn.done) return;
    if (!t.open) { t.conn.abort('Вызов отменён'); return; }
    t.conn.send({ h323: 'Release', cause });
    t.conn.close();
  }

  const RELEASE_TEXT = {
    'normal call clearing': 'Собеседник положил трубку',
    'user busy': 'Абонент занят',
    'unallocated number': 'Номер не существует на удалённом CME',
    'subscriber absent': 'Абонент не зарегистрирован на удалённом CME',
    'no circuit': 'На удалённом маршрутизаторе не настроен telephony-service',
    'destination out of order': 'Связь с собеседником потеряна',
  };

  /** Сообщить второй стороне вызова: местному телефону — SCCP, удалённому CME — H.323. */
  function tellOther(dev, call, mac, sccp, h323) {
    const other = call.a === mac ? call.b : call.a;
    if (other) {
      const r = dev.cmeRt.regs.get(other);
      if (r) r.conn.send(Object.assign({ callId: call.id }, sccp));
    } else if (call.trunk) trunkSend(call, h323);
  }

  function trunkGone(dev, call, text) {
    const rt = dev.cmeRt;
    if (rt.calls.get(call.id) !== call) return;
    rt.calls.delete(call.id);
    const local = rt.regs.get(call[call.trunk.side]);
    if (local) local.conn.send({ sccp: 'CallEnd', callId: call.id, text: 'Связь с удалённым CME потеряна: ' + text });
    dev.note('CME: вызов через H.323 с ' + U.ipStr(call.trunk.ip) + ' прерван — ' + text, null, 'drop');
    dev.net.emit('config', { dev });
  }

  /** Сообщение H.323 по уже установленному вызову (обе стороны). */
  function trunkMsg(dev, call, x) {
    const rt = dev.cmeRt;
    if (!x || !x.h323 || rt.calls.get(call.id) !== call) return;
    const t = call.trunk;
    const local = rt.regs.get(call[t.side]);
    const tell = (m) => { if (local) local.conn.send(Object.assign({ callId: call.id }, m)); };
    switch (x.h323) {
      case 'Alerting':
        dev.note('CME: удалённый CME ' + U.ipStr(t.ip) + ' — у абонента ' + t.remote + ' звонит', null, 'info');
        break;
      case 'Connect':
        call.state = 'connected';
        call.since = dev.net.time;
        call.held = {};
        t.peerIp = x.rtpIp;
        tell({ sccp: 'Connected', peerIp: x.rtpIp, port: t.port, peer: t.remote });
        dev.note('CME: ' + t.remote + ' ответил (H.323 Connect) — голос пойдёт напрямую на ' + U.ipStr(x.rtpIp), null, 'accept');
        break;
      case 'Hold':
      case 'Resume':
        if (call.state === 'connected') tell({ sccp: x.h323 === 'Hold' ? 'Held' : 'Resumed' });
        break;
      case 'Transfer':
        t.remote = String(x.number || t.remote);
        call.state = 'alerting';
        call.held = {};
        tell({ sccp: 'Update', number: t.remote });
        break;
      case 'Release':
        rt.calls.delete(call.id);
        tell({ sccp: 'CallEnd', text: RELEASE_TEXT[x.cause] || String(x.cause || 'Вызов завершён') });
        if (t.conn && !t.conn.done) t.conn.close();
        dev.note('CME: удалённый CME завершил вызов (' + (x.cause || 'release') + ')', null, 'info');
        break;
      default:
        return;
    }
    dev.net.emit('config', { dev });
  }

  /** Входящее соединение H.323 от другого CME. */
  function h323In(dev, conn, x) {
    if (!x || !x.h323) return;
    if (conn.call) { trunkMsg(dev, conn.call, x); return; }
    if (x.h323 !== 'Setup') return;
    const c = dev.cme;
    const rt = dev.cmeRt;
    const number = String(x.called || '');
    const rel = (cause, why) => {
      conn.send({ h323: 'Release', cause });
      conn.close();
      dev.note('CME: входящий вызов H.323 от ' + U.ipStr(conn.rip) + ' на ' + number + ' отклонён — ' + why, null, 'drop');
    };
    if (!c || !c.on) { rel('no circuit', 'не настроен telephony-service'); return; }
    const tag = V.dnByNumber(c, number);
    if (tag == null) { rel('unallocated number', 'нет ephone-dn с номером ' + number); return; }
    const to = V.regByDn(dev, tag);
    if (!to) { rel('subscriber absent', 'телефон с номером ' + number + ' не зарегистрирован'); return; }
    if (V.callOf(dev, to)) { rel('user busy', 'абонент ' + number + ' занят'); return; }
    const id = rt.nextCall++;
    const from = String(x.calling || '');
    const call = {
      id, a: null, b: to.mac, number, from, state: 'ringing', since: dev.net.time,
      trunk: { side: 'b', dir: 'in', ip: conn.rip, remote: from, port: Number(x.port) || RTP_BASE, peerIp: x.rtpIp, conn, open: true },
    };
    conn.call = call;
    rt.calls.set(id, call);
    to.conn.send({ sccp: 'Ring', callId: id, from });
    conn.send({ h323: 'Alerting' });
    dev.note('CME: входящий вызов H.323 от ' + U.ipStr(conn.rip) + ': ' + from + ' → ' + number, null, 'info');
    dev.net.emit('config', { dev });
  }

  CME_HOOKS.listen.push((dev) => {
    const accept = (conn) => {
      conn.h = {
        onData: (x, cn) => h323In(dev, cn, x),
        onClose: (cn) => { if (cn.call) trunkGone(dev, cn.call, 'удалённый CME закрыл соединение'); },
        onError: (code, text, cn) => { if (cn.call) trunkGone(dev, cn.call, text); },
      };
    };
    accept.cme = true;
    dev.tcp.listen(H323_PORT, accept);
  });

  /** Номера нет среди ephone-dn: ищем dial-peer и звоним на другой CME. */
  CME_HOOKS.dialRemote = (dev, conn, reg, number) => {
    const m = matchPeer(dev.cme, number);
    if (!m) return false;
    const [tag, p] = m;
    if (p.target == null) { conn.send({ sccp: 'Error', text: 'dial-peer voice ' + tag + ': не задан session target ipv4:<адрес другого CME>' }); return true; }
    if (dev.hasIp(p.target)) { conn.send({ sccp: 'Error', text: 'dial-peer voice ' + tag + ': session target — адрес этого же маршрутизатора' }); return true; }
    const rt = dev.cmeRt;
    const id = rt.nextCall++;
    const from = numOf(reg);
    const t = { side: 'a', dir: 'out', peer: Number(tag), ip: p.target, remote: number, port: RTP_BASE + 2 * (id % 8000), peerIp: null, conn: null, open: false };
    const call = { id, a: reg.mac, b: null, number, from, state: 'ringing', since: dev.net.time, trunk: t };
    rt.calls.set(id, call);
    conn.send({ sccp: 'Ringback', callId: id, number });
    dev.note('CME: номер ' + number + ' не местный — по dial-peer voice ' + tag + ' (' + p.pattern + ') вызов уходит на ' + U.ipStr(p.target) + ' (H.323, TCP ' + H323_PORT + ')', null, 'info');
    const live = () => rt.calls.get(id) === call;
    t.conn = dev.tcp.connect(p.target, H323_PORT, {
      onOpen: (c) => { if (!live()) { c.close(); return; } t.open = true; c.send({ h323: 'Setup', called: number, calling: from, rtpIp: reg.ip, port: t.port }); },
      onData: (x) => trunkMsg(dev, call, x),
      onClose: () => trunkGone(dev, call, 'удалённый CME закрыл соединение'),
      onError: (code, text) => trunkGone(dev, call, code === 'refused' ? 'на ' + U.ipStr(p.target) + ' нет CME (TCP ' + H323_PORT + ' закрыт)' : text),
    });
    return true;
  };

  function transfer(dev, conn, reg, call, number) {
    const c = dev.cme;
    const rt = dev.cmeRt;
    const fail = (text) => conn.send({ sccp: 'XferFail', callId: call.id, text });
    if (call.state !== 'connected') { fail('вызов ещё не соединён'); return; }
    if (!NUM_RE.test(number)) { fail('неверный номер'); return; }
    if (reg.lines.some((l) => l.number === number)) { fail('это ваш собственный номер'); return; }
    const tag = V.dnByNumber(c, number);
    if (tag == null && !matchPeer(c, number)) { fail('номер ' + number + ' не существует (нет ephone-dn и подходящего dial-peer)'); return; }
    const otherMac = call.a === reg.mac ? call.b : call.a;
    if (otherMac) {
      // собеседник — на этом CME: он сам «набирает» новый номер
      const y = rt.regs.get(otherMac);
      if (!y) { fail('собеседник недоступен'); return; }
      if (y.lines.some((l) => l.number === number)) { fail('абонент ' + number + ' уже участвует в разговоре'); return; }
      rt.calls.delete(call.id);
      conn.send({ sccp: 'CallEnd', callId: call.id, text: 'Вызов переведён на ' + number });
      y.conn.send({ sccp: 'Transferred', callId: call.id, number });
      dev.note('CME: ' + numOf(reg) + ' перевёл ' + numOf(y) + ' на ' + number + ' (слепой перевод)', null, 'info');
      V.cmeMsg(dev, y.conn, { sccp: 'Dial', number });
      dev.net.emit('config', { dev });
      return;
    }
    // собеседник — на другом CME: вызов через H.323 остаётся, меняется местный телефон
    if (tag == null) { fail('перевод удалённого абонента на третий CME не поддерживается'); return; }
    const z = V.regByDn(dev, tag);
    if (!z) { fail('абонент ' + number + ' не зарегистрирован'); return; }
    if (V.callOf(dev, z)) { fail('абонент ' + number + ' занят'); return; }
    const t = call.trunk;
    call[t.side] = z.mac;
    call.state = 'ringing';
    call.held = {};
    if (t.side === 'b') call.number = number; else call.from = number;
    conn.send({ sccp: 'CallEnd', callId: call.id, text: 'Вызов переведён на ' + number });
    z.conn.send({ sccp: 'Ring', callId: call.id, from: t.remote });
    trunkSend(call, { h323: 'Transfer', number });
    dev.note('CME: ' + numOf(reg) + ' перевёл удалённого абонента ' + t.remote + ' на ' + number, null, 'info');
    dev.net.emit('config', { dev });
  }

  CME_HOOKS.msg.push((dev, conn, d, reg) => {
    const rt = dev.cmeRt;
    const call = d.callId != null ? rt.calls.get(d.callId) : null;
    const party = !!call && (call.a === reg.mac || call.b === reg.mac);
    switch (d.sccp) {
      case 'Hold':
      case 'Resume': {
        if (!party || call.state !== 'connected') return true;
        const on = d.sccp === 'Hold';
        call.held = call.held || {};
        if (on) call.held[reg.mac] = true; else delete call.held[reg.mac];
        tellOther(dev, call, reg.mac, { sccp: on ? 'Held' : 'Resumed' }, { h323: on ? 'Hold' : 'Resume' });
        dev.note('CME: ' + numOf(reg) + (on ? ' поставил вызов на удержание — собеседнику играет музыка' : ' вернулся к разговору'), null, 'info');
        dev.net.emit('config', { dev });
        return true;
      }
      case 'Transfer':
        if (party) transfer(dev, conn, reg, call, String(d.number || '').trim());
        return true;
      case 'Answer': {
        if (!party || !call.trunk) return false;
        const t = call.trunk;
        if (call.state !== 'ringing' || call[t.side] !== reg.mac) return true;
        call.state = 'connected';
        call.since = dev.net.time;
        conn.send({ sccp: 'Connected', callId: call.id, peerIp: t.peerIp, port: t.port, peer: t.remote });
        trunkSend(call, { h323: 'Connect', rtpIp: reg.ip });
        dev.note('CME: ' + numOf(reg) + ' ответил на вызов ' + t.remote + ' с другого CME — голос пойдёт напрямую на ' + U.ipStr(t.peerIp), null, 'accept');
        dev.net.emit('config', { dev });
        return true;
      }
      case 'Hangup':
        if (!party || !call.trunk) return false;
        rt.calls.delete(call.id);
        trunkRelease(call, 'normal call clearing');
        dev.note('CME: ' + numOf(reg) + ' положил трубку — H.323 Release на ' + U.ipStr(call.trunk.ip), null, 'info');
        dev.net.emit('config', { dev });
        return true;
      default:
        return false;
    }
  });

  CME_HOOKS.drop.push((dev, call) => { if (call.trunk) trunkRelease(call, 'destination out of order'); });

  /* ================= сохранение ================= */

  NS.deviceExt.push({
    key: 'dialPeers',
    applies: (d) => d.type === 'router',
    save(d) {
      const ps = d.cme && d.cme.peers;
      if (!ps || !Object.keys(ps).length) return null;
      return Object.fromEntries(Object.entries(ps).map(([k, p]) => [k, { pattern: p.pattern || '', target: p.target != null ? U.ipStr(p.target) : null, codec: p.codec || '', desc: p.desc || '', pref: p.pref || 0, shut: !!p.shut }]));
    },
    load(d, c) {
      if (!c) { if (d.cme) d.cme.peers = {}; return; }
      const cfg = V.cmeCfg(d);
      cfg.peers = {};
      for (const [k, p] of Object.entries(c)) {
        cfg.peers[k] = { pattern: String(p.pattern || ''), target: p.target ? U.parseIp(p.target) : null, codec: String(p.codec || ''), desc: String(p.desc || ''), pref: Number(p.pref) || 0, shut: !!p.shut };
      }
    },
  });

  /* ================= описание пакетов H.323 ================= */

  const H_TEXT = {
    Setup: (d) => 'Setup: вызов ' + d.calling + ' → ' + d.called + ', голос вызывающего на ' + U.ipStr(d.rtpIp) + ':' + d.port,
    Alerting: () => 'Alerting: у абонента звонит',
    Connect: (d) => 'Connect: абонент ответил, голос на ' + U.ipStr(d.rtpIp),
    Release: (d) => 'Release Complete: ' + (d.cause || ''),
    Hold: () => 'удержание вызова',
    Resume: () => 'возврат к разговору',
    Transfer: (d) => 'собеседник переведён на ' + d.number,
  };
  const h323Of = (f) => {
    if (f.type !== 'IPv4' || !f.payload || f.payload.proto !== 'TCP') return null;
    const s = f.payload.payload;
    return s && (s.sport === H323_PORT || s.dport === H323_PORT) && s.data && s.data.h323 ? s.data : null;
  };

  P.register({
    protocols: { H323: { label: 'H.323 (вызовы между CME)', color: '#9a3412' } },
    classify: (f) => (h323Of(f) ? 'H323' : null),
    summary(f) {
      const d = h323Of(f);
      if (!d) return null;
      return 'H.323 ' + (H_TEXT[d.h323] ? H_TEXT[d.h323](d) : d.h323) + ', ' + U.ipStr(f.payload.src) + ' → ' + U.ipStr(f.payload.dst);
    },
    extraLayers(f, out) {
      const d = h323Of(f);
      if (!d) return;
      const fields = [['Сообщение', d.h323], ['Смысл', H_TEXT[d.h323] ? H_TEXT[d.h323](d) : '']];
      if (d.calling) fields.push(['Кто звонит', d.calling]);
      if (d.called) fields.push(['Кому', d.called]);
      if (d.rtpIp != null) fields.push(['Адрес для голоса (RTP)', U.ipStr(d.rtpIp) + (d.port ? ':' + d.port : '')]);
      out.push({ title: 'H.225 — сигнализация H.323 между CME (уровень 7)', fields });
    },
  });

  /* ================= Cisco IOS: dial-peer ================= */

  const CODECS = /^(g711ulaw|g711alaw|g729r8|g729br8|g723r63|g726r32)$/i;

  X.config.push((dev, s, a, neg, io, C) => {
    if (dev.type !== 'router' || !C.kw(a[0], 'dial-peer', 6)) return false;
    if (!C.kw(a[1], 'voice', 1)) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return true; }
    const n = Number(a[2]);
    if (!Number.isInteger(n) || n < 1 || n > 2147483647) { C.incomplete(io); return true; }
    const c = V.cmeCfg(dev);
    if (neg) { if (c.peers && c.peers[n]) C.withMutate(io, () => { delete c.peers[n]; }); return true; }
    if (!c.peers || !c.peers[n]) {
      if (C.kw(a[3], 'pots', 1)) { io.out('% dial-peer POTS нужен для аналоговых портов FXS/FXO — в NetLab номера телефонов задаются через ephone-dn'); return true; }
      if (!C.kw(a[3], 'voip', 1)) { C.incomplete(io); return true; }
      C.withMutate(io, () => { c.peers = c.peers || {}; c.peers[n] = { pattern: '', target: null, codec: '', desc: '', pref: 0, shut: false }; });
    }
    s.mode = 'dial-peer';
    s.ctx = n;
    return true;
  });

  X.modes['dial-peer'] = {
    prompt: () => '(config-dial-peer)#',
    tree: ['destination-pattern WORD', 'session target ipv4:A.B.C.D', 'session protocol sipv2', 'codec g711ulaw', 'codec g729r8', 'description WORD', 'preference WORD', 'dtmf-relay h245-alphanumeric', 'no vad', 'shutdown'],
    run(dev, s, t, io, C) {
      const p = dev.cme && dev.cme.peers && dev.cme.peers[s.ctx];
      if (!p) return;
      const neg = C.kw(t[0], 'no', 2);
      const a = neg ? t.slice(1) : t;
      if (C.kw(a[0], 'destination-pattern', 4)) {
        const v = String(a[1] || '').replace(/^\+/, '');
        if (!neg && !patRe(v)) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return; }
        C.withMutate(io, () => { p.pattern = neg ? '' : v; });
        return;
      }
      if (C.kw(a[0], 'session', 2)) {
        if (C.kw(a[1], 'target', 1)) {
          if (neg) { C.withMutate(io, () => { p.target = null; }); return; }
          const m = /^ipv4:(.+)$/i.exec(a[2] || '');
          const ip = m ? U.parseIp(m[1]) : null;
          if (ip == null) {
            if (/^(dns|ras|sip-server|enum|ipv6):/i.test(a[2] || '')) io.out('% В NetLab поддерживается только session target ipv4:<адрес другого CME>');
            else if (a[2]) C.invalid(io, a[2]);
            else C.incomplete(io);
            return;
          }
          if (dev.hasIp(ip)) io.out('% ' + U.ipStr(ip) + ' — адрес этого же маршрутизатора: укажите адрес другого CME', 'hint');
          C.withMutate(io, () => { p.target = ip; });
          return;
        }
        if (C.kw(a[1], 'protocol', 1)) {
          if (!neg && !C.kw(a[2], 'cisco', 1)) io.out('% Между CME в NetLab используется H.323 (session protocol по умолчанию); SIP не моделируется');
          return;
        }
        if (a[1]) C.invalid(io, a[1]); else C.incomplete(io);
        return;
      }
      if (C.kw(a[0], 'codec', 2)) {
        if (!neg && !CODECS.test(a[1] || '')) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return; }
        C.withMutate(io, () => { p.codec = neg ? '' : a[1].toLowerCase(); });
        return;
      }
      if (C.kw(a[0], 'description', 4)) { C.withMutate(io, () => { p.desc = neg ? '' : a.slice(1).join(' ').slice(0, 64); }); return; }
      if (C.kw(a[0], 'preference', 3)) {
        const v = Number(a[1]);
        if (!neg && !(Number.isInteger(v) && v >= 0 && v <= 10)) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return; }
        C.withMutate(io, () => { p.pref = neg ? 0 : v; });
        return;
      }
      if (C.kw(a[0], 'shutdown', 2)) { C.withMutate(io, () => { p.shut = !neg; }); return; }
      if (C.kw(a[0], 'dtmf-relay', 2) || C.kw(a[0], 'vad', 1) || C.kw(a[0], 'ip', 1) || C.kw(a[0], 'fax', 2)) return;
      C.invalid(io, a[0]);
    },
  };

  X.running.global.push((dev) => {
    const ps = dev.cme && dev.cme.peers;
    if (!ps) return [];
    const L = [];
    for (const [n, p] of Object.entries(ps).sort((x, y) => x[0] - y[0])) {
      L.push('dial-peer voice ' + n + ' voip');
      if (p.desc) L.push(' description ' + p.desc);
      if (p.pref) L.push(' preference ' + p.pref);
      if (p.pattern) L.push(' destination-pattern ' + p.pattern);
      if (p.target != null) L.push(' session target ipv4:' + U.ipStr(p.target));
      if (p.codec) L.push(' codec ' + p.codec);
      if (p.shut) L.push(' shutdown');
      L.push('!');
    }
    return L;
  });

  const operUp = (p) => !p.shut && !!p.pattern && p.target != null;

  X.show.push((dev, s, a, io, C) => {
    if (dev.type !== 'router') return false;
    if (C.kw(a[0], 'dial-peer', 6)) {
      if (!C.kw(a[1], 'voice', 1)) { if (a[1]) C.invalid(io, a[1]); else C.incomplete(io); return true; }
      const list = Object.entries((dev.cme && dev.cme.peers) || {}).sort((x, y) => x[0] - y[0]);
      if (C.kw(a[2], 'summary', 1)) {
        io.out('dial-peer hunt 0');
        io.out('             AD                                    PRE PASS                OUT');
        io.out('TAG    TYPE  MIN  OPER PREFIX    DEST-PATTERN      FER THRU SESS-TARGET    STAT PORT');
        for (const [n, p] of list) {
          io.out(C.pad(n, 7) + C.pad('voip', 6) + C.pad(p.shut ? 'down' : 'up', 5) + C.pad(operUp(p) ? 'up' : 'down', 5) + C.pad('', 10) + C.pad(p.pattern || '', 18) +
            C.pad(String(p.pref || 0), 4) + C.pad('syst', 5) + (p.target != null ? 'ipv4:' + U.ipStr(p.target) : ''));
        }
        return true;
      }
      const only = a[2] != null ? String(Number(a[2])) : null;
      for (const [n, p] of list) {
        if (only != null && n !== only) continue;
        io.out('VoiceOverIpPeer' + n);
        io.out('        peer type = voice, information type = voice,');
        io.out("        description = `" + (p.desc || '') + "',");
        io.out("        tag = " + n + ", destination-pattern = `" + (p.pattern || '') + "',");
        io.out('        admin state is ' + (p.shut ? 'down' : 'up') + ', operation state is ' + (operUp(p) ? 'up' : 'down') + ',');
        io.out("        session-target = `" + (p.target != null ? 'ipv4:' + U.ipStr(p.target) : '') + "',");
        io.out('        session-protocol = cisco (H.323), codec = ' + (p.codec || 'g729r8') + ',');
        io.out('        preference = ' + (p.pref || 0));
        io.out('');
      }
      if (!list.length) io.out('(dial-peer не настроены)');
      return true;
    }
    if (C.kw(a[0], 'call', 2) && C.kw(a[1], 'active', 1)) {
      if (a[2] && !C.kw(a[2], 'voice', 1)) { C.invalid(io, a[2]); return true; }
      const calls = dev.cmeRt ? [...dev.cmeRt.calls.values()] : [];
      io.out('Telephony call-legs: ' + calls.reduce((n, x) => n + (x.trunk ? 1 : 2), 0));
      io.out('VoIP call-legs: ' + calls.filter((x) => x.trunk).length);
      io.out('Total call-legs: ' + calls.length * 2);
      io.out('');
      for (const x of calls) {
        const held = x.held && Object.keys(x.held).length ? ' HOLD' : '';
        const st = x.state === 'connected' ? 'CONNECTED' : 'ALERTING';
        io.out(C.pad(String(x.id), 5) + ': ' + C.pad(x.from || '?', 10) + '-> ' + C.pad(x.number || '?', 10) + C.pad(st + held, 16) +
          (x.trunk ? 'H.323 ' + (x.trunk.dir === 'out' ? 'to ' : 'from ') + U.ipStr(x.trunk.ip) + ' ' : 'local ') + 'dur ' + ((dev.net.time - (x.since || 0)) / 100).toFixed(1) + 's');
      }
      return true;
    }
    return false;
  });

  X.tree.config = (X.tree.config || []).concat(['dial-peer voice WORD voip']);
  X.tree.exec = (X.tree.exec || []).concat(['show dial-peer voice summary', 'show dial-peer voice', 'show call active voice brief']);

  NS.voip2 = { patRe, matchPeer, H323_PORT };
})(globalThis.NetLab = globalThis.NetLab || {});
