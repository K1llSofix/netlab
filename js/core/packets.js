/* NetLab — структуры PDU (кадры, ARP, IPv4, ICMP, UDP, TCP) и их описание для инспектора. */
(function (NS) {
  'use strict';

  const U = NS.util;
  const P = {};

  P.PORT_DHCP_SERVER = 67;
  P.PORT_DHCP_CLIENT = 68;
  P.PORT_DNS = 53;
  P.PORT_MAIL = 7777; // «Сообщения» — прямая доставка между компьютерами
  P.PORT_HTTP = 80;
  P.PORT_SMTP = 25;
  P.PORT_POP3 = 110;
  P.PORT_TELNET = 23;
  P.PORT_SSH = 22;
  P.PORT_TFTP = 69;

  P.frame = function (src, dst, type, payload, vlan) {
    return { src, dst, type, vlan: vlan === undefined ? null : vlan, payload, hops: 0 };
  };

  P.arp = function (op, senderMac, senderIp, targetMac, targetIp) {
    return { op, senderMac, senderIp, targetMac, targetIp };
  };

  P.ipv4 = function (src, dst, proto, payload, ttl) {
    return { src, dst, proto, ttl: ttl || 128, payload };
  };

  P.echoRequest = function (id, seq, size) { return { type: 'echo-request', id, seq, size: size || 32 }; };
  P.echoReply = function (id, seq, size) { return { type: 'echo-reply', id, seq, size: size || 32 }; };

  P.udp = function (sport, dport, data) { return { sport, dport, data }; };

  /** TCP-сегмент. flags — строка вида 'SYN', 'SYN,ACK', 'PSH,ACK', 'FIN,ACK', 'RST'. */
  P.tcp = function (sport, dport, seq, ack, flags, data, len) {
    return { sport, dport, seq, ack, flags, data: data === undefined ? null : data, len: len || 0 };
  };

  P.hasFlag = function (seg, f) { return (',' + seg.flags + ',').indexOf(',' + f + ',') >= 0; };

  /* ---------- классификация ---------- */

  P.PROTOCOLS = {
    ARP: { label: 'ARP', color: '#f59e0b' },
    ICMP: { label: 'ICMP', color: '#3b82f6' },
    DHCP: { label: 'DHCP', color: '#a855f7' },
    DNS: { label: 'DNS', color: '#14b8a6' },
    TCP: { label: 'TCP', color: '#0ea5e9' },
    HTTP: { label: 'HTTP', color: '#10b981' },
    SMTP: { label: 'SMTP', color: '#f97316' },
    POP3: { label: 'POP3', color: '#eab308' },
    TELNET: { label: 'Telnet', color: '#8b5cf6' },
    SSH: { label: 'SSH', color: '#6366f1' },
    TFTP: { label: 'TFTP', color: '#84cc16' },
    MAIL: { label: 'Сообщения', color: '#ec4899' },
    UDP: { label: 'UDP', color: '#64748b' },
    OTHER: { label: 'Другое', color: '#64748b' },
  };

  const TCP_APPS = { 80: 'HTTP', 25: 'SMTP', 110: 'POP3', 23: 'TELNET', 22: 'SSH' };

  P.classify = function (f) {
    if (!f) return 'OTHER';
    if (f.type === 'ARP') return 'ARP';
    if (f.type === 'IPv4' && f.payload) {
      const p = f.payload;
      if (p.proto === 'ICMP') return 'ICMP';
      if (p.proto === 'UDP' && p.payload) {
        const s = p.payload.sport;
        const d = p.payload.dport;
        if (s === 67 || s === 68 || d === 67 || d === 68) return 'DHCP';
        if (s === 53 || d === 53) return 'DNS';
        if (s === P.PORT_MAIL || d === P.PORT_MAIL) return 'MAIL';
        if (d === 69 || (p.payload.data && p.payload.data.tftp)) return 'TFTP';
        return 'UDP';
      }
      if (p.proto === 'TCP' && p.payload) {
        const seg = p.payload;
        if (seg.data != null) return TCP_APPS[seg.dport] || TCP_APPS[seg.sport] || 'TCP';
        return 'TCP';
      }
    }
    return 'OTHER';
  };

  const ICMP_NAMES = {
    'echo-request': 'Эхо-запрос (ping)',
    'echo-reply': 'Эхо-ответ',
    'time-exceeded': 'Время жизни истекло',
    unreachable: 'Узел недоступен',
  };
  const UNREACH_CODES = { 0: 'сеть недоступна', 1: 'узел недоступен', 3: 'порт недоступен', 13: 'запрещено администратором (ACL)' };

  function tcpAppSummary(seg) {
    const d = seg.data || {};
    if (d.http === 'GET') return 'HTTP GET ' + (d.path || '/');
    if (d.http === 'RESP') return 'HTTP ' + d.status + ' ' + (d.reason || '');
    if (d.smtp === 'SEND') return 'SMTP: письмо для ' + (d.to || []).length + ' получател' + ((d.to || []).length === 1 ? 'я' : 'ей');
    if (d.smtp === 'RESULT') return 'SMTP: отчёт о доставке';
    if (d.pop3 === 'RETR') return 'POP3: запрос писем ' + (d.user || '');
    if (d.pop3) return 'POP3: ' + (d.pop3 === 'OK' ? 'писем: ' + (d.messages || []).length : 'ошибка');
    if (d.term === 'line') return 'Терминал: ввод команды';
    if (d.term === 'out') return 'Терминал: вывод';
    return 'данные';
  }

  /** Короткое описание для списка событий. */
  P.summary = function (f) {
    const ip = U.ipStr;
    if (!f) return '';
    if (f.type === 'ARP') {
      const a = f.payload;
      if (a.op === 'request') {
        if (a.senderIp === 0) return `ARP-проба: занят ли ${ip(a.targetIp)}?`;
        if (a.senderIp === a.targetIp) return `Gratuitous ARP: ${ip(a.senderIp)} — это ${a.senderMac}`;
        return `ARP: у кого ${ip(a.targetIp)}? Сообщите ${ip(a.senderIp)}`;
      }
      return `ARP-ответ: ${ip(a.senderIp)} — это ${a.senderMac}`;
    }
    if (f.type === 'IPv4') {
      const p = f.payload;
      const route = `${ip(p.src)} → ${ip(p.dst)}`;
      if (p.proto === 'ICMP') {
        const m = p.payload;
        let s = ICMP_NAMES[m.type] || m.type;
        if (m.type === 'unreachable') s += ' (' + (UNREACH_CODES[m.code] || m.code) + ')';
        return `ICMP ${s}, ${route}`;
      }
      if (p.proto === 'UDP') {
        const d = p.payload.data || {};
        const kind = P.classify(f);
        if (kind === 'DHCP') return `DHCP ${d.op || ''}${d.yiaddr ? ' ' + ip(d.yiaddr) : ''}, ${route}`;
        if (kind === 'DNS') {
          if (d.op === 'query') return `DNS-запрос «${d.name}», ${route}`;
          return `DNS-ответ «${d.name}» = ${d.ip != null ? ip(d.ip) : 'не найдено'}, ${route}`;
        }
        if (kind === 'MAIL') {
          if (d.kind === 'ack') return `Сообщение: подтверждение доставки, ${route}`;
          return `Сообщение «${d.subject || 'без темы'}», ${route}`;
        }
        if (kind === 'TFTP') return `TFTP ${d.tftp || ''} ${d.name || ''}, ${route}`;
        return `UDP ${p.payload.sport} → ${p.payload.dport}, ${route}`;
      }
      if (p.proto === 'TCP') {
        const s = p.payload;
        const ports = `${ip(p.src)}:${s.sport} → ${ip(p.dst)}:${s.dport}`;
        if (s.data != null) return `${tcpAppSummary(s)}, ${ports}`;
        return `TCP ${s.flags}, ${ports}`;
      }
    }
    return f.type;
  };

  /** Уровни PDU для окна инспектора: [{title, fields: [[k, v], ...]}]. */
  P.layers = function (f) {
    const ip = U.ipStr;
    const out = [];
    if (!f) return out;
    if (f.encap) {
      out.push({ title: f.encap + ' (уровень 2, последовательный канал)', fields: [['Инкапсуляция', f.encap], ['Протокол', f.type]] });
    } else {
      out.push({
        title: 'Ethernet II (уровень 2)',
        fields: [['MAC отправителя', f.src], ['MAC получателя', f.dst + (U.isBroadcastMac(f.dst) ? ' (широковещательный)' : '')], ['Тип', f.type === 'ARP' ? '0x0806 ARP' : '0x0800 IPv4']],
      });
    }
    if (f.vlan != null) out.push({ title: '802.1Q (тег VLAN)', fields: [['VLAN ID', String(f.vlan)]] });
    if (f.type === 'ARP') {
      const a = f.payload;
      out.push({
        title: 'ARP',
        fields: [['Операция', a.op === 'request' ? '1 — запрос' : '2 — ответ'], ['MAC отправителя', a.senderMac], ['IP отправителя', ip(a.senderIp)], ['MAC цели', a.targetMac], ['IP цели', ip(a.targetIp)]],
      });
      return out;
    }
    if (f.type === 'IPv4') {
      const p = f.payload;
      out.push({ title: 'IPv4 (уровень 3)', fields: [['Источник', ip(p.src)], ['Назначение', ip(p.dst)], ['TTL', String(p.ttl)], ['Протокол', p.proto]] });
      if (p.proto === 'ICMP') {
        const m = p.payload;
        const fields = [['Тип', ICMP_NAMES[m.type] || m.type]];
        if (m.type === 'unreachable') fields.push(['Код', (UNREACH_CODES[m.code] || '') + ' (' + m.code + ')']);
        if (m.id !== undefined) fields.push(['Идентификатор', String(m.id)], ['Номер', String(m.seq)]);
        if (m.original) fields.push(['Исходный пакет', `${ip(m.original.src)} → ${ip(m.original.dst)} ${m.original.proto}`]);
        out.push({ title: 'ICMP', fields });
      } else if (p.proto === 'UDP') {
        const u = p.payload;
        out.push({ title: 'UDP (уровень 4)', fields: [['Порт источника', String(u.sport)], ['Порт назначения', String(u.dport)]] });
        const d = u.data || {};
        const kind = P.classify(f);
        if (kind === 'DHCP') {
          const fields = [['Сообщение', d.op], ['Транзакция', String(d.xid)], ['MAC клиента', d.chaddr]];
          if (d.yiaddr) fields.push(['Предлагаемый IP', ip(d.yiaddr)]);
          if (d.mask) fields.push(['Маска', ip(d.mask)]);
          if (d.router) fields.push(['Шлюз', ip(d.router)]);
          if (d.dns) fields.push(['DNS', ip(d.dns)]);
          if (d.requested) fields.push(['Запрошенный IP', ip(d.requested)]);
          if (d.serverId) fields.push(['DHCP-сервер', ip(d.serverId)]);
          if (d.giaddr) fields.push(['Relay-агент (giaddr)', ip(d.giaddr)]);
          out.push({ title: 'DHCP (уровень 7)', fields });
        } else if (kind === 'DNS') {
          const fields = [['Тип', d.op === 'query' ? 'Запрос' : 'Ответ'], ['Имя', d.name]];
          if (d.op !== 'query') fields.push(['Адрес', d.ip != null ? ip(d.ip) : 'не найдено (NXDOMAIN)']);
          out.push({ title: 'DNS (уровень 7)', fields });
        } else if (kind === 'MAIL') {
          if (d.kind === 'ack') out.push({ title: 'Сообщения (уровень 7)', fields: [['Тип', 'Подтверждение доставки'], ['Сообщение №', String(d.id)]] });
          else out.push({ title: 'Сообщения (уровень 7)', fields: [['Тип', 'Сообщение'], ['От', d.fromName || ''], ['Тема', d.subject || ''], ['Текст', d.body || '']] });
        } else if (kind === 'TFTP') {
          out.push({ title: 'TFTP (уровень 7)', fields: [['Операция', String(d.tftp)], ['Файл', d.name || ''], ['Данные', d.data ? String(d.data).length + ' байт' : '—']] });
        }
      } else if (p.proto === 'TCP') {
        const s = p.payload;
        out.push({ title: 'TCP (уровень 4)', fields: [['Порт источника', String(s.sport)], ['Порт назначения', String(s.dport)], ['Номер последовательности', String(s.seq)], ['Номер подтверждения', String(s.ack)], ['Флаги', s.flags], ['Длина данных', String(s.len)]] });
        if (s.data != null) {
          const d = s.data;
          const kind = P.classify(f);
          const fields = [];
          if (d.http === 'GET') fields.push(['Запрос', 'GET ' + d.path], ['Узел', d.host || '']);
          else if (d.http === 'RESP') fields.push(['Ответ', d.status + ' ' + (d.reason || '')], ['Размер страницы', String((d.body || '').length) + ' символов']);
          else if (d.smtp === 'SEND') fields.push(['От', d.from || ''], ['Кому', (d.to || []).join(', ')], ['Тема', d.subject || '']);
          else if (d.smtp === 'RESULT') for (const r of d.results || []) fields.push([r.to, (r.ok ? 'доставлено' : 'ошибка: ') + (r.ok ? '' : r.text)]);
          else if (d.pop3 === 'RETR') fields.push(['Пользователь', d.user || ''], ['Пароль', '••••']);
          else if (d.pop3) fields.push(['Результат', d.pop3 === 'OK' ? 'писем: ' + (d.messages || []).length : (d.text || 'ошибка')]);
          else if (d.term === 'line') fields.push(['Ввод', d.mask ? '••••' : String(d.text)]);
          else if (d.term === 'out') fields.push(['Строк вывода', String((d.lines || []).length)]);
          if (kind === 'SSH') fields.unshift(['Шифрование', 'данные зашифрованы (SSH)']);
          out.push({ title: (P.PROTOCOLS[kind] || P.PROTOCOLS.TCP).label + ' (уровень 7)', fields });
        }
      }
    }
    return out;
  };

  NS.packets = P;
})(globalThis.NetLab = globalThis.NetLab || {});
