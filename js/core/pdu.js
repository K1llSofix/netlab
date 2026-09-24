/* NetLab — сложный PDU (Complex PDU) и сценарии, как в режиме симуляции Packet Tracer:
 * произвольный пакет ICMP / TCP / UDP с портами, TTL, размером и числом повторов; однократно или периодически;
 * сценарии — сохранённые в файле наборы PDU, которые запускаются одной кнопкой («Fire»). */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = NS.packets;
  const UDP_WAIT = 150;
  const TCP_WAIT = 1500;

  const PROTOS = { icmp: 'ICMP', tcp: 'TCP', udp: 'UDP' };

  function describe(spec) {
    const p = PROTOS[spec.proto] || 'ICMP';
    return p + (spec.proto !== 'icmp' && spec.dport ? ' :' + spec.dport : '') + (spec.ttl ? ', TTL ' + spec.ttl : '') + (spec.count > 1 ? ', ×' + spec.count : '');
  }

  /** Отправить PDU. spec: { src: id устройства, dst: адрес или имя, proto, sport, dport, ttl, size, count }. cb({status: ok|partial|fail, text}). */
  function fire(net, spec, cb) {
    const dev = net.getDevice(spec.src);
    const done = (status, text) => cb({ status, text });
    if (!dev || !dev.ifaces) { done('fail', 'Отправитель не найден или у него нет IP'); return; }
    if (!dev.power) { done('fail', dev.name + ' выключен'); return; }
    const proto = PROTOS[spec.proto] ? spec.proto : 'icmp';
    const count = Math.max(1, Math.min(20, Number(spec.count) || 1));
    if (proto === 'icmp') {
      let ok = 0;
      let last = '';
      dev.ping(String(spec.dst), {
        count,
        ttl: spec.ttl || undefined,
        size: spec.size || undefined,
        interval: 100,
        onEvent(ev) {
          if (ev.type === 'reply') { ok++; last = 'Ответ от ' + U.ipStr(ev.from) + ', TTL=' + ev.ttl; }
          else if (ev.type === 'ttl-expired') last = 'TTL истёк на ' + U.ipStr(ev.from);
          else if (ev.type === 'unreachable') last = U.ipStr(ev.from) + ' сообщает: адрес недоступен';
          else if (ev.type === 'timeout') last = last || 'Нет ответа';
          else if (ev.type === 'error') last = ev.text || 'Ошибка отправки';
          else if (ev.type === 'resolve-fail') last = 'Имя не найдено';
          else if (ev.type === 'done') done(ok === count ? 'ok' : ok ? 'partial' : 'fail', (last || 'Нет ответа') + (count > 1 ? ' (' + ok + ' из ' + count + ')' : ''));
        },
      });
      return;
    }
    dev.resolveTarget(String(spec.dst), (ip, err) => {
      if (ip == null) { done('fail', err || 'Не удалось определить адрес получателя'); return; }
      const dport = Number(spec.dport) || (proto === 'tcp' ? 80 : 53);
      if (proto === 'tcp') {
        if (!dev.tcp) { done('fail', 'На ' + dev.name + ' нет TCP'); return; }
        let fin = false;
        const t = dev.timer(TCP_WAIT, () => { if (!fin) { fin = true; if (!conn.done) conn.close(); done('fail', 'Нет ответа на TCP SYN (' + U.ipStr(ip) + ':' + dport + ')'); } });
        const conn = dev.tcp.connect(ip, dport, {
          onOpen: () => { if (fin) return; fin = true; t.cancel(); conn.close(); done('ok', 'TCP-соединение с ' + U.ipStr(ip) + ':' + dport + ' установлено'); },
          onError: (code, text) => { if (fin) return; fin = true; t.cancel(); done('fail', code === 'refused' ? 'Порт ' + dport + ' закрыт — ответ TCP RST' : text || code); },
          onClose: () => {},
          onData: () => {},
        });
        return;
      }
      const sport = Number(spec.sport) || dev.allocPort();
      let fin = false;
      const finish = (status, text) => { if (fin) return; fin = true; dev.udpErr.delete(sport); done(status, text); };
      dev.udpErr.set(sport, (info) => finish('fail', U.ipStr(info.from) + ' сообщает: ' + (info.code === 3 ? 'порт ' + dport + ' недоступен' : 'адрес недоступен')));
      const pkt = P.ipv4(null, ip, 'UDP', P.udp(sport, dport, { pdu: true, size: spec.size || 32 }), spec.ttl || dev.defaultTtl);
      dev.sendIp(pkt, { why: 'Сложный PDU: UDP → ' + U.ipStr(ip) + ':' + dport, onError: (code, text) => finish('fail', text || code) });
      dev.timer(UDP_WAIT, () => finish('ok', 'UDP-датаграмма отправлена на ' + U.ipStr(ip) + ':' + dport + ' (ошибок не пришло)'));
    });
  }

  /* ---------- сценарии ---------- */

  function scenarios(net) {
    if (!net.scenarios) net.scenarios = { current: 0, list: [{ name: 'Сценарий 0', desc: '', pdus: [] }] };
    return net.scenarios;
  }

  function cleanSpec(s) {
    return { src: String(s.src), dst: String(s.dst || ''), proto: PROTOS[s.proto] ? s.proto : 'icmp', sport: Number(s.sport) || null, dport: Number(s.dport) || null, ttl: Number(s.ttl) || null, size: Number(s.size) || null, count: Number(s.count) || 1, periodic: Number(s.periodic) || null };
  }

  NS.netExt.push({
    key: 'scenarios',
    init(net) { net.scenarios = null; },
    save(net) {
      const sc = net.scenarios;
      if (!sc || !sc.list.some((x) => x.pdus.length || x.desc || x.name !== 'Сценарий 0') || (sc.list.length === 1 && !sc.list[0].pdus.length && !sc.list[0].desc)) return null;
      return { current: sc.current, list: sc.list.map((x) => ({ name: x.name, desc: x.desc || '', pdus: x.pdus.map(cleanSpec) })) };
    },
    load(net, d) {
      net.scenarios = null;
      if (!d || !Array.isArray(d.list) || !d.list.length) return;
      net.scenarios = { current: Math.min(Number(d.current) || 0, d.list.length - 1), list: d.list.map((x, i) => ({ name: String(x.name || 'Сценарий ' + i), desc: String(x.desc || ''), pdus: (x.pdus || []).map(cleanSpec) })) };
    },
  });

  /** Запустить все PDU сценария. onResult(i, spec, result) для каждого. */
  function fireScenario(net, idx, onResult) {
    const sc = scenarios(net).list[idx];
    if (!sc) return 0;
    sc.pdus.forEach((spec, i) => fire(net, spec, (r) => onResult && onResult(i, spec, r)));
    return sc.pdus.length;
  }

  NS.pdu = { fire, describe, scenarios, fireScenario, cleanSpec, PROTOS };
})(globalThis.NetLab = globalThis.NetLab || {});
