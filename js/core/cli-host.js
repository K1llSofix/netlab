/* NetLab — командная строка ПК и сервера в стиле Windows:
 * ping, tracert, ipconfig, arp, nslookup, netstat, telnet, ssh, hostname, cls, help. */
(function (NS) {
  'use strict';

  const U = NS.util;

  function tokenize(line) { return String(line).trim().split(/\s+/).filter(Boolean); }
  function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }
  function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
  function winMac(m) { return String(m || '').toLowerCase().replace(/:/g, '-'); }

  function hint(dev, code, dst) {
    const f = dev.iface;
    switch (code) {
      case 'no-ip': return 'Подсказка: у устройства нет IP-адреса. Задайте его в «IP Configuration» (Рабочий стол) или включите DHCP.';
      case 'down':
        if (f && f.port < 0) return 'Подсказка: в устройстве нет сетевой карты — установите модуль на вкладке «Физический вид».';
        if (f && dev.ports[f.port] && dev.ports[f.port].media === 'wireless') return 'Подсказка: беспроводной адаптер не подключён к сети — откройте «PC Wireless» на рабочем столе.';
        return 'Подсказка: интерфейс не активен — проверьте кабель (его тип!) и питание соседнего устройства.';
      case 'no-route':
        if (f && f.ip != null && dev.gateway == null && dst != null) {
          return 'Подсказка: ' + U.ipStr(dst) + ' находится вне сети ' + U.cidr(U.net(f.ip, f.mask), f.mask) + ', а основной шлюз не задан.';
        }
        return 'Подсказка: нет маршрута к узлу. Проверьте IP-адрес, маску и основной шлюз.';
      case 'arp-fail':
        if (f && f.ip != null && dst != null && !U.sameNet(dst, f.ip, f.mask) && dev.gateway != null) {
          return 'Подсказка: основной шлюз ' + U.ipStr(dev.gateway) + ' не отвечает на ARP. Проверьте адрес маршрутизатора и VLAN.';
        }
        return 'Подсказка: никто не ответил на ARP-запрос. Узел выключен, не подключён или находится в другой VLAN.';
      default: return null;
    }
  }

  const HELP = [
    'Доступные команды:',
    '  ping [-n число] [-t] [-i TTL] [-l размер] <адрес|имя>   проверка связи',
    '  tracert [-h прыжков] <адрес|имя>                         трассировка маршрута',
    '  ipconfig [/all | /release | /renew]                      настройки IP',
    '  arp -a | arp -d                                          таблица ARP',
    '  nslookup <имя>                                           запрос к DNS',
    '  netstat                                                  TCP-соединения',
    '  telnet <адрес>                                           удалённая консоль',
    '  ssh -l <пользователь> <адрес>                            защищённая консоль',
    '  hostname                                                 имя устройства',
    '  cls                                                      очистить экран',
    'Ctrl+C — прервать выполняемую команду.',
  ];

  function ping(dev, args, io) {
    let count = 4;
    let ttl = null;
    let size = 32;
    let target = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-n') { count = parseInt(args[++i], 10); if (!(count > 0)) { io.out('Неверное значение параметра -n.'); return null; } }
      else if (a === '-t') count = Infinity;
      else if (a === '-i') { ttl = parseInt(args[++i], 10); if (!(ttl > 0 && ttl <= 255)) { io.out('Неверное значение параметра -i.'); return null; } }
      else if (a === '-l') { size = parseInt(args[++i], 10); if (!(size >= 0 && size <= 65500)) { io.out('Неверное значение параметра -l.'); return null; } }
      else if (a.startsWith('-')) { io.out('Неизвестный параметр ' + args[i] + '.'); return null; }
      else target = args[i];
    }
    if (!target) { io.out('Использование: ping [-n число] [-t] [-i TTL] <адрес>'); return null; }
    const own = () => { const f = dev.firstAddressedIface(); return f ? U.ipStr(f.ip) : '0.0.0.0'; };
    const hints = new Set();
    let dst = null;
    return dev.ping(target, {
      count, ttl, size,
      onEvent(ev) {
        switch (ev.type) {
          case 'resolve-fail':
            io.out('При проверке связи не удалось обнаружить узел ' + target + '.');
            io.out('Проверьте имя узла и повторите попытку.');
            if (ev.text) io.out('Подсказка: ' + ev.text + '.', 'hint');
            break;
          case 'start':
            dst = ev.ip;
            io.out('');
            io.out('Обмен пакетами с ' + (U.parseIp(ev.name) != null ? U.ipStr(ev.ip) : ev.name + ' [' + U.ipStr(ev.ip) + ']') + ' с ' + ev.size + ' байтами данных:');
            break;
          case 'reply':
            io.out('Ответ от ' + U.ipStr(ev.from) + ': число байт=' + ev.bytes + ' время' + (ev.rtt < 1 ? '<1' : '=' + ev.rtt) + 'мс TTL=' + ev.ttl);
            break;
          case 'timeout':
            io.out('Превышен интервал ожидания для запроса.');
            break;
          case 'unreachable': {
            const what = ev.code === 0 ? 'Заданная сеть недоступна.' : ev.code === 3 ? 'Заданный порт недоступен.' : ev.code === 13 ? 'Связь запрещена администратором.' : 'Заданный узел недоступен.';
            io.out('Ответ от ' + U.ipStr(ev.from) + ': ' + what);
            if (ev.code === 0) hints.add('Подсказка: у маршрутизатора ' + U.ipStr(ev.from) + ' нет маршрута к сети получателя.');
            if (ev.code === 13) hints.add('Подсказка: пакет отброшен списком доступа (ACL) на ' + U.ipStr(ev.from) + '.');
            break;
          }
          case 'ttl-expired':
            io.out('Ответ от ' + U.ipStr(ev.from) + ': Превышен срок жизни (TTL) при передаче пакета.');
            hints.add('Подсказка: вероятна петля маршрутизации — проверьте статические маршруты.');
            break;
          case 'error':
            if (ev.code === 'arp-fail') io.out('Ответ от ' + own() + ': Заданный узел недоступен.');
            else io.out('PING: сбой передачи. Общий сбой.');
            { const h = hint(dev, ev.code, dst); if (h) hints.add(h); }
            break;
          case 'done': {
            if (ev.cancelled) io.out('^C');
            if (ev.sent > 0) {
              const pct = Math.round((ev.lost / ev.sent) * 100);
              io.out('');
              io.out('Статистика Ping для ' + U.ipStr(ev.ip) + ':');
              io.out('    Пакетов: отправлено = ' + ev.sent + ', получено = ' + ev.received + ', потеряно = ' + ev.lost);
              io.out('    (' + pct + '% потерь)');
              if (ev.rtts.length) {
                const min = Math.min(...ev.rtts);
                const max = Math.max(...ev.rtts);
                const avg = Math.round(ev.rtts.reduce((a, b) => a + b, 0) / ev.rtts.length);
                io.out('Приблизительное время приема-передачи в мс:');
                io.out('    Минимальное = ' + min + 'мсек, Максимальное = ' + max + ' мсек, Среднее = ' + avg + ' мсек');
              }
            }
            for (const h of hints) io.out(h, 'hint');
            io.done();
            break;
          }
          default: break;
        }
      },
    });
  }

  function tracert(dev, args, io) {
    let maxHops = 30;
    let target = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-h') { maxHops = parseInt(args[++i], 10); if (!(maxHops > 0 && maxHops <= 255)) { io.out('Неверное значение параметра -h.'); return null; } }
      else if (a === '-d') { /* без разрешения имён */ } else if (a.startsWith('-')) { io.out('Неизвестный параметр ' + args[i] + '.'); return null; } else target = args[i];
    }
    if (!target) { io.out('Использование: tracert [-h прыжков] <адрес>'); return null; }
    let dst = null;
    return dev.traceroute(target, {
      maxHops,
      onEvent(ev) {
        if (ev.type === 'resolve-fail') {
          io.out('Не удается разрешить системное имя узла ' + target + '.');
          if (ev.text) io.out('Подсказка: ' + ev.text + '.', 'hint');
        } else if (ev.type === 'start') {
          dst = ev.ip;
          io.out('');
          io.out('Трассировка маршрута к ' + (U.parseIp(ev.name) != null ? U.ipStr(ev.ip) : ev.name + ' [' + U.ipStr(ev.ip) + ']'));
          io.out('с максимальным числом прыжков ' + ev.maxHops + ':');
          io.out('');
        } else if (ev.type === 'hop') {
          const cols = ev.rtts.map((r) => (r == null ? padL('*', 6) + '   ' : padL(r < 1 ? '<1' : r, 6) + ' мс')).join('');
          let tail;
          if (ev.kind === 'error') {
            const f = dev.firstAddressedIface();
            io.out(padL(ev.ttl, 3) + '  ' + (f ? U.ipStr(f.ip) : '') + '  сообщает: ' + (ev.text || 'Общий сбой.'));
            const h = hint(dev, 'arp-fail', dst);
            if (h) io.out(h, 'hint');
            return;
          } else if (ev.kind === 'unreachable') {
            tail = U.ipStr(ev.from) + '  сообщает: ' + (ev.code === 0 ? 'Заданная сеть недоступна.' : ev.code === 13 ? 'Связь запрещена администратором.' : 'Заданный узел недоступен.');
          } else if (ev.from == null) {
            tail = 'Превышен интервал ожидания для запроса.';
          } else {
            tail = U.ipStr(ev.from);
          }
          io.out(padL(ev.ttl, 3) + ' ' + cols + ' ' + tail);
        } else if (ev.type === 'done') {
          if (ev.cancelled) io.out('^C');
          else if (ev.ip != null) { io.out(''); io.out('Трассировка завершена.'); }
          io.done();
        }
      },
    });
  }

  function ipconfig(dev, args, io) {
    const a = (args[0] || '').toLowerCase();
    const f = dev.iface;
    const wifi = f.port >= 0 && dev.ports[f.port] && dev.ports[f.port].media === 'wireless';
    const adapter = (wifi ? 'Адаптер беспроводной локальной сети ' : 'Адаптер Ethernet ') + f.name + ':';
    if (a === '/release') {
      if (!f.dhcp) { io.out('Для адаптера ' + f.name + ' не включен DHCP.'); return null; }
      io.mutate(() => dev.releaseDhcp());
      io.out('IP-адрес освобождён.');
      return null;
    }
    if (a === '/renew') {
      if (!f.dhcp) { io.out('Для адаптера ' + f.name + ' не включен DHCP.'); return null; }
      io.mutate(() => dev.startDhcp());
      io.out('Запрос адреса у DHCP-сервера…');
      let waited = 0;
      let timer = null;
      const job = {
        done: false,
        cancel() { if (timer) timer.cancel(); job.finish(); io.out('^C'); io.done(); },
        finish() { job.done = true; dev.jobs.delete(job); },
      };
      const poll = () => {
        const st = dev.dhcpc ? dev.dhcpc.phase : null;
        if (st === 'bound' || st === 'failed' || st === 'wait-link' || st == null || waited > 2000) {
          if (st === 'bound') io.out('Получен адрес ' + U.cidr(f.ip, f.mask) + '.');
          else if (st === 'failed') io.out('Произошла ошибка при обновлении интерфейса ' + f.name + ': DHCP-сервер не ответил. Назначен ' + U.ipStr(f.ip) + '.');
          else if (st === 'wait-link') io.out('Среда передачи недоступна (нет подключения).');
          job.finish();
          io.done();
          return;
        }
        waited += 10;
        timer = dev.timer(10, poll);
      };
      dev.jobs.add(job);
      poll();
      return job;
    }
    const all = a === '/all';
    if (a && !all) { io.out('Неизвестный параметр ' + args[0] + '. Допустимо: /all, /release, /renew'); return null; }
    io.out('');
    io.out('Настройка протокола IP для Windows');
    if (all) {
      io.out('');
      io.out('   Имя компьютера  . . . . . . . . . : ' + dev.name);
    }
    io.out('');
    io.out(adapter);
    io.out('');
    if (!dev.ifaceUp(f)) io.out('   Состояние среды. . . . . . . . . : Среда передачи недоступна.');
    if (all) {
      if (f.port >= 0) io.out('   Физический адрес. . . . . . . . . : ' + winMac(dev.ifaceMac(f)).toUpperCase());
      io.out('   DHCP включен. . . . . . . . . . . : ' + (f.dhcp ? 'Да' : 'Нет'));
    }
    io.out('   IPv4-адрес. . . . . . . . . . . . : ' + (f.ip != null ? U.ipStr(f.ip) + (dev.conflict ? ' (Дубликат)' : '') : '—'));
    io.out('   Маска подсети . . . . . . . . . . : ' + (f.mask != null ? U.ipStr(f.mask) : '—'));
    io.out('   Основной шлюз. . . . . . . . . : ' + (dev.gateway != null ? U.ipStr(dev.gateway) : ''));
    if (all) {
      if (f.dhcp && dev.dhcpc && dev.dhcpc.server) io.out('   DHCP-сервер. . . . . . . . . . . : ' + U.ipStr(dev.dhcpc.server));
      io.out('   DNS-серверы. . . . . . . . . . . : ' + (dev.dns != null ? U.ipStr(dev.dns) : ''));
    }
    if (f.dhcp && dev.dhcpStatus) io.out('   Состояние DHCP . . . . . . . . . : ' + dev.dhcpStatus);
    if (dev.conflict) io.out('Внимание: адрес ' + U.ipStr(dev.conflict.ip) + ' уже используется устройством ' + dev.conflict.mac + '.', 'hint');
    return null;
  }

  function arp(dev, args, io) {
    const a = (args[0] || '').toLowerCase();
    if (a === '-d') { dev.clearArp(); io.out('Кэш ARP очищен.'); return null; }
    if (a !== '-a' && a !== '-g') { io.out('Использование: arp -a (показать) | arp -d (очистить)'); return null; }
    const f = dev.iface;
    const rows = dev.arpEntries();
    if (!rows.length) { io.out('Записи ARP не найдены.'); return null; }
    io.out('');
    io.out('Интерфейс: ' + (f.ip != null ? U.ipStr(f.ip) : '0.0.0.0') + ' --- 0x1');
    io.out('  Адрес в Интернете     Физический адрес      Тип');
    for (const r of rows) io.out('  ' + pad(U.ipStr(r.ip), 22) + pad(winMac(r.mac), 22) + 'динамический');
    return null;
  }

  function nslookup(dev, args, io) {
    const name = args[0];
    if (!name) { io.out('Использование: nslookup <имя>'); return null; }
    const server = dev.dns;
    io.out('Сервер:  ' + (server != null ? 'UnKnown' : '—'));
    io.out('Address:  ' + (server != null ? U.ipStr(server) : 'не задан'));
    io.out('');
    let finished = false;
    const job = {
      done: false,
      cancel() { if (!finished) { finished = true; job.finish(); io.out('^C'); io.done(); } },
      finish() { job.done = true; dev.jobs.delete(job); },
    };
    dev.jobs.add(job);
    dev.dnsCache.delete(String(name).toLowerCase());
    dev.resolveName(name, (addr, err) => {
      if (finished) return;
      finished = true;
      if (addr != null) {
        io.out('Имя:     ' + name);
        io.out('Address:  ' + U.ipStr(addr));
      } else {
        io.out('*** Не удалось найти ' + name + ': ' + (err || 'Non-existent domain'));
      }
      job.finish();
      io.done();
    });
    return finished ? null : job;
  }

  function netstat(dev, io) {
    const list = dev.tcp ? dev.tcp.list() : [];
    io.out('');
    io.out('Активные подключения');
    io.out('');
    io.out('  ' + pad('Имя', 7) + pad('Локальный адрес', 24) + pad('Внешний адрес', 24) + 'Состояние');
    for (const c of list) {
      io.out('  ' + pad('TCP', 7) + pad((c.lip != null ? U.ipStr(c.lip) : '0.0.0.0') + ':' + c.lport, 24) + pad(U.ipStr(c.rip) + ':' + c.rport, 24) + c.state);
    }
    if (dev.tcp) for (const port of dev.tcp.listeners.keys()) io.out('  ' + pad('TCP', 7) + pad('0.0.0.0:' + port, 24) + pad('0.0.0.0:0', 24) + 'LISTENING');
    return null;
  }

  function exec(dev, s, line, io) {
    const t = tokenize(line);
    if (!t.length) return null;
    const cmd = t[0].toLowerCase();
    const args = t.slice(1);
    switch (cmd) {
      case 'help': case '?': HELP.forEach((l) => io.out(l)); return null;
      case 'ping': return ping(dev, args, io);
      case 'tracert': case 'traceroute': return tracert(dev, args, io);
      case 'ipconfig': return ipconfig(dev, args, io);
      case 'arp': return arp(dev, args, io);
      case 'nslookup': return nslookup(dev, args, io);
      case 'netstat': return netstat(dev, io);
      case 'telnet':
        if (!args[0]) { io.out('Использование: telnet <адрес>'); return null; }
        return NS.cliIos.startRemote(dev, s, io, 'telnet', args[0], null);
      case 'ssh': {
        const i = args.indexOf('-l');
        const user = i >= 0 ? args[i + 1] : null;
        const host = args.filter((x, k) => x !== '-l' && k !== i + 1).pop();
        if (!user || !host) { io.out('Использование: ssh -l <пользователь> <адрес>'); return null; }
        return NS.cliIos.startRemote(dev, s, io, 'ssh', host, user);
      }
      case 'hostname': io.out(dev.name); return null;
      case 'cls': case 'clear': io.clear(); return null;
      default:
        io.out('"' + t[0] + '" не является внутренней или внешней командой,');
        io.out('исполняемой программой или пакетным файлом. Введите help для списка команд.');
        return null;
    }
  }

  const COMMANDS = ['help', 'ping', 'tracert', 'ipconfig', 'arp', 'nslookup', 'netstat', 'telnet', 'ssh', 'hostname', 'cls'];

  function complete(line) {
    const t = tokenize(line);
    if (t.length !== 1 || /\s$/.test(line)) return line;
    const c = COMMANDS.filter((x) => x.startsWith(t[0].toLowerCase()));
    return c.length === 1 ? c[0] + ' ' : line;
  }

  NS.cliHost = { exec, complete };
})(globalThis.NetLab = globalThis.NetLab || {});
