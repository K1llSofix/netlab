/* NetLab — HTTPS: рукопожатие TLS и сертификаты.
 *  Клиент (tcpRequest с message.https): ClientHello (SNI) → ServerHello + Certificate → проверка сертификата → Finished → HTTP внутри TLS.
 *  Проверка как в браузере: доверенный издатель (NetLab Root CA), имя (CN / SAN, *.маска), срок действия.
 *  Сервер: веб-сервер (443) и HTTPS маршрутизатора (RESTCONF) отвечают сертификатом устройства;
 *  по умолчанию он самоподписанный (как у свежего сервера), выдать доверенный — в настройках HTTP сервера. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const IpNode = NS.IpNode;
  const TRUSTED = 'NetLab Root CA';
  const HANDSHAKE_TIMEOUT = 300;

  function defaultCert(dev) {
    const name = dev.ios ? dev.ios.hostname : String(dev.name || 'server').toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
    const ips = (dev.ifaces || []).filter((f) => f.ip != null && !f.runtime).map((f) => U.ipStr(f.ip));
    return { cn: dev.type === 'asa' ? 'ASA Temporary Self Signed Certificate' : dev.ios ? 'IOS-Self-Signed-Certificate' : name, san: dev.ios ? ips : [name].concat(ips), issuer: 'self', expired: false };
  }

  function certOf(dev) {
    const c = dev.tlsCert;
    return c ? { cn: c.cn, san: c.san.slice(), issuer: c.issuer, expired: !!c.expired } : defaultCert(dev);
  }

  /** Проверка сертификата для адреса host → null или { code, text }. */
  function verify(cert, host) {
    if (!cert) return { code: 'none', text: 'сервер не прислал сертификат' };
    if (cert.issuer !== TRUSTED) return { code: 'self-signed', text: 'сертификат выдан самому себе (' + cert.cn + ') — ему нет доверия' };
    const h = String(host || '').toLowerCase();
    const names = [cert.cn].concat(cert.san || []).map((s) => String(s).toLowerCase());
    const ok = names.some((n) => n === h || (n.startsWith('*.') && h.endsWith(n.slice(1)) && h.split('.').length === n.split('.').length));
    if (!ok) return { code: 'hostname', text: 'имя в сертификате (' + names.join(', ') + ') не совпадает с адресом ' + h };
    if (cert.expired) return { code: 'expired', text: 'срок действия сертификата истёк' };
    return null;
  }

  function mkJob(node, onCancel) {
    const j = { done: false, cancel(r) { if (!j.done) onCancel(r); }, finish() { if (j.done) return; j.done = true; node.jobs.delete(j); } };
    node.jobs.add(j);
    return j;
  }

  // клиент: запросы с message.https идут через TLS
  const baseRequest = IpNode.prototype.tcpRequest;
  IpNode.prototype.tcpRequest = function (host, port, message, accept, cb) {
    if (!message || !message.https) return baseRequest.call(this, host, port, message, accept, cb);
    let finished = false;
    let conn = null;
    let timer = null;
    const job = mkJob(this, (reason) => { if (conn) conn.abort(reason); done({ ok: false, error: reason || 'Прервано' }); });
    function done(r) {
      if (finished) return;
      finished = true;
      if (timer) timer.cancel();
      job.finish();
      cb(r);
    }
    const sni = String(host).toLowerCase();
    const inner = Object.assign({}, message);
    delete inner.https;
    delete inner.insecure;
    this.resolveName(host, (addr, err) => {
      if (finished) return;
      if (addr == null) { done({ ok: false, error: err || 'Не удалось определить адрес', resolve: true }); return; }
      let answer = null;
      let tls = null;
      let phase = 'hello';
      conn = this.tcp.connect(addr, port, {
        onOpen: (c) => {
          c.send({ tls: 'ClientHello', sni, versions: ['TLS 1.3', 'TLS 1.2'] });
          timer = this.timer(HANDSHAKE_TIMEOUT, () => { timer = null; if (phase === 'hello') { conn.abort('timeout'); done({ ok: false, error: 'Сервер не ответил на TLS ClientHello — на порту ' + port + ' нет HTTPS', ip: addr }); } });
        },
        onData: (d) => {
          if (!d) return;
          if (phase === 'hello' && d.tls === 'ServerHello') {
            if (timer) { timer.cancel(); timer = null; }
            const problem = verify(d.cert, sni);
            tls = { version: d.version, cipher: d.cipher, cert: d.cert, problem };
            if (problem && !message.insecure) {
              phase = 'failed';
              conn.send({ tls: 'Alert', desc: problem.code === 'expired' ? 'certificate_expired' : 'bad_certificate' });
              conn.close();
              done({ ok: false, error: 'Сертификат не прошёл проверку: ' + problem.text, cert: problem, tls, ip: addr });
              return;
            }
            phase = 'app';
            conn.send({ tls: 'Finished' });
            conn.send(inner);
            return;
          }
          if (phase === 'app' && !answer && accept(d)) answer = d;
        },
        onClose: () => done(answer ? { ok: true, data: answer, ip: addr, tls } : { ok: false, error: phase === 'hello' ? 'Сервер закрыл соединение, не начав TLS' : 'Сервер закрыл соединение без ответа', ip: addr }),
        onError: (code, text) => {
          if (answer) { done({ ok: true, data: answer, ip: addr, tls }); return; }
          done({ ok: false, code, error: code === 'refused' ? 'Сервер отклонил соединение: на ' + U.ipStr(addr) + ' порт ' + port + ' закрыт (служба выключена?)' : text, ip: addr });
        },
      });
    });
    return job;
  };

  /** Серверная сторона: обёртка обработчика принятого соединения (onAccept) для HTTPS. */
  function server(dev, onAccept) {
    const wrap = (conn) => {
      onAccept(conn);
      const app = conn.h.onData;
      let ready = false;
      conn.h.onData = (d) => {
        if (d && d.tls === 'ClientHello') {
          conn.send({ tls: 'ServerHello', version: 'TLS 1.3', cipher: 'TLS_AES_128_GCM_SHA256', cert: certOf(dev), sni: d.sni });
          return;
        }
        if (d && d.tls === 'Finished') { ready = true; return; }
        if (d && d.tls) { if (d.tls === 'Alert') conn.close(); return; }
        if (!ready) { conn.close(); return; } // HTTP без TLS на порт 443
        if (app) app(d);
      };
    };
    for (const k of Object.keys(onAccept)) wrap[k] = onAccept[k];
    return wrap;
  }

  // понятные подписи в симуляции
  P.register({
    summary(f) {
      const seg = f && f.type === 'IPv4' && f.payload && f.payload.proto === 'TCP' ? f.payload.payload : null;
      const d = seg && seg.data;
      if (!d || !d.tls) return null;
      if (d.tls === 'ClientHello') return 'TLS ClientHello: клиент предлагает ' + (d.versions || ['TLS 1.3']).join(' / ') + ', имя сервера (SNI) ' + d.sni;
      if (d.tls === 'ServerHello') {
        const c = d.cert || {};
        return 'TLS ServerHello + Certificate: CN=' + c.cn + (c.issuer === TRUSTED ? ', выдан ' + TRUSTED : ', самоподписанный') + (c.expired ? ', ПРОСРОЧЕН' : '') + '; шифр ' + d.cipher;
      }
      if (d.tls === 'Finished') return 'TLS Finished: ключи согласованы — дальше данные зашифрованы';
      if (d.tls === 'Alert') return 'TLS Alert: ' + (d.desc || 'ошибка') + ' — клиент не доверяет сертификату и закрывает соединение';
      return 'TLS ' + d.tls;
    },
  });

  NS.deviceExt.push({
    key: 'tlscert',
    applies: (d) => d.type === 'server' || d.type === 'router',
    save: (d) => (d.tlsCert ? Object.assign({}, d.tlsCert, { san: d.tlsCert.san.slice() }) : null),
    load(d, c) {
      d.tlsCert = c && c.cn ? { cn: String(c.cn), san: Array.isArray(c.san) ? c.san.map(String) : [], issuer: c.issuer === TRUSTED ? TRUSTED : 'self', expired: !!c.expired } : null;
    },
  });

  NS.tls = { TRUSTED, verify, certOf, defaultCert, server, setCert(dev, c) { dev.tlsCert = c ? { cn: String(c.cn || '').trim(), san: (c.san || []).map((s) => String(s).trim()).filter(Boolean), issuer: c.issuer === TRUSTED ? TRUSTED : 'self', expired: !!c.expired } : null; } };
})(globalThis.NetLab = globalThis.NetLab || {});
