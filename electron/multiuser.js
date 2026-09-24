/* NetLab — многопользовательский режим (настольная версия): TCP-соединение между копиями NetLab.
 * Одна копия ждёт подключений (listen), другие подключаются (connect) с общим паролем.
 * Сообщения — JSON по строке; главное окно получает их через IPC «mu:event». */
'use strict';

const net = require('net');

const MAX_LINE = 1024 * 1024;
const VERSION = 1;

function init(getWin) {
  const peers = new Map(); // id → { sock, name, addr }
  let server = null;
  let password = '';
  let seq = 0;
  let myName = 'NetLab';

  const emit = (ev) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('mu:event', ev); };
  const status = () => ({ listening: !!server, port: server ? server.address() && server.address().port : null, peers: [...peers.entries()].map(([id, p]) => ({ id, name: p.name, addr: p.addr, ready: p.ready })) });

  function wire(sock, outgoing) {
    const id = String(++seq);
    const peer = { sock, name: '?', addr: sock.remoteAddress + ':' + sock.remotePort, ready: false };
    peers.set(id, peer);
    sock.setNoDelay(true);
    let buf = '';
    const send = (obj) => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };
    peer.send = send;
    const drop = (reason) => {
      if (!peers.has(id)) return;
      peers.delete(id);
      emit({ type: 'peer-down', peer: id, name: peer.name, reason: reason || 'соединение закрыто' });
      emit({ type: 'status', status: status() });
      if (!sock.destroyed) sock.destroy();
    };
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE * 4) { drop('слишком большое сообщение'); return; }
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { drop('неверные данные'); return; }
        if (!peer.ready) {
          if (msg.t === 'error') { emit({ type: 'error', text: String(msg.text || 'отказ') }); drop(String(msg.text || 'отказ')); return; }
          if (msg.t !== 'hello' || msg.v !== VERSION) { send({ t: 'error', text: 'Это не NetLab или другая версия протокола' }); drop('неверное приветствие'); return; }
          if (!outgoing && String(msg.password || '') !== password) { send({ t: 'error', text: 'Неверный пароль' }); drop('неверный пароль'); return; }
          peer.name = String(msg.name || '?').slice(0, 64);
          peer.ready = true;
          if (!outgoing) send({ t: 'hello', v: VERSION, name: myName });
          emit({ type: 'peer-up', peer: id, name: peer.name, addr: peer.addr });
          emit({ type: 'status', status: status() });
          continue;
        }
        if (msg.t === 'error') { emit({ type: 'error', text: String(msg.text || '') }); continue; }
        emit({ type: 'message', peer: id, msg });
      }
    });
    sock.on('close', () => drop());
    sock.on('error', (e) => drop(e.code === 'ECONNREFUSED' ? 'подключение отклонено (на той стороне не включено ожидание?)' : e.message));
    return { id, send };
  }

  return {
    setName(n) { myName = String(n || 'NetLab').slice(0, 64); },
    listen(port, pass) {
      return new Promise((resolve) => {
        if (server) { resolve({ ok: true, status: status() }); return; }
        password = String(pass || '');
        const s = net.createServer((sock) => wire(sock, false));
        s.once('error', (e) => { server = null; resolve({ ok: false, error: e.code === 'EADDRINUSE' ? 'Порт ' + port + ' уже занят' : e.message }); });
        s.listen(Number(port) || 38000, () => { server = s; emit({ type: 'status', status: status() }); resolve({ ok: true, status: status() }); });
      });
    },
    stopListen() { if (server) { server.close(); server = null; } emit({ type: 'status', status: status() }); return status(); },
    connect(host, port, pass) {
      return new Promise((resolve) => {
        const sock = net.connect({ host: String(host || '127.0.0.1'), port: Number(port) || 38000 }, () => {
          const p = wire(sock, true);
          p.send({ t: 'hello', v: VERSION, name: myName, password: String(pass || '') });
          resolve({ ok: true, peer: p.id });
        });
        sock.once('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? 'Подключение отклонено: на ' + host + ':' + port + ' никто не ждёт' : e.message }));
      });
    },
    disconnect(id) { const p = peers.get(String(id)); if (p) p.sock.destroy(); return status(); },
    send(msg, to) {
      for (const [id, p] of peers) if (p.ready && (!to || to === id)) p.send(msg);
    },
    status,
    closeAll() { for (const p of peers.values()) p.sock.destroy(); if (server) server.close(); server = null; },
  };
}

module.exports = { init };
