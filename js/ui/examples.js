/* NetLab UI — готовые примеры топологий. Маршрутизаторы и коммутаторы настраиваются настоящими
 * командами IOS (как в running-config), конфигурация сохраняется в NVRAM. */
(function (NS) {
  'use strict';

  const UI = (NS.ui = NS.ui || {});
  const U = NS.util;
  const ip = (s) => U.parseIp(s);
  const pfx = (n) => U.maskFromPrefix(n);

  /** Устройство по модели (2911, PC-PT…) или по типу (router, pc…). */
  function dev(net, what, name, x, y) {
    const M = NS.models;
    const model = M.MODELS[what] ? what : M.DEFAULT_MODEL[what];
    return net.addDevice(M.get(model).type, { model, name, x, y });
  }

  function host(net, what, name, x, y, cidr, gw, dns) {
    const d = dev(net, what, name, x, y);
    if (cidr) {
      const [a, p] = cidr.split('/');
      d.setStatic(ip(a), pfx(Number(p)), gw ? ip(gw) : null, dns ? ip(dns) : null);
    }
    return d;
  }

  function rif(r, i, cidr) {
    const [a, p] = cidr.split('/');
    r.setIfaceIp(r.ifaces[i], ip(a), pfx(Number(p)));
  }

  const port = (d, name) => {
    const i = d.portIndex(name);
    if (i < 0) throw new Error(d.name + ': нет порта ' + name);
    return i;
  };

  /** Соединить: порт — индекс или имя. */
  function link(net, a, pa, b, pb, cable) {
    net.connect(a.id, typeof pa === 'string' ? port(a, pa) : pa, b.id, typeof pb === 'string' ? port(b, pb) : pb, cable);
  }

  /** Применить конфигурацию IOS (в формате running-config). Ошибка в примере — исключение. */
  function ios(d, text) {
    const errs = [];
    NS.cliIos.replayConfig(d, text.split('\n'), { out: (l) => { if (!NS.cliIos.isInfo(l)) errs.push(l); }, mutate: (fn) => fn() }, false);
    if (errs.length) throw new Error(d.name + ': ' + errs.join('; '));
  }

  /** Поставить модуль (как в Packet Tracer — при выключенном питании). */
  function module(net, d, slot, mod) {
    net.setPower(d, false);
    net.setModule(d, slot, mod);
    net.setPower(d, true);
  }

  /** Конфигурация примера — «сохранённая»: переживает выключение и reload. */
  function finish(net) {
    for (const d of net.devices.values()) if (d.saveNvram && d.nvram !== undefined) d.saveNvram();
    return net;
  }

  const EXAMPLES = [
    {
      id: 'basic',
      title: 'Первая сеть',
      level: 'начальный',
      desc: 'Три компьютера и коммутатор. Проверьте связь командой ping и посмотрите, как коммутатор заполняет MAC-таблицу.',
      build() {
        const net = new NS.Network();
        const sw = dev(net, '2960-24TT', 'Switch0', 420, 170);
        const pcs = [host(net, 'PC-PT', 'PC0', 220, 340, '192.168.1.10/24'), host(net, 'PC-PT', 'PC1', 420, 360, '192.168.1.11/24'), host(net, 'Laptop-PT', 'Laptop0', 620, 340, '192.168.1.12/24')];
        pcs.forEach((p, i) => link(net, p, 0, sw, i));
        net.addNote(60, 50, 'Откройте PC0 (двойной щелчок) → «Рабочий стол» → Command Prompt →\nping 192.168.1.11. Затем инспектором (лупа, I) посмотрите MAC-таблицу Switch0.\nВ режиме «Симуляция» пакеты видны по шагам.');
        return finish(net);
      },
    },
    {
      id: 'routing',
      title: 'Две сети и маршрутизатор',
      level: 'начальный',
      desc: 'Маршрутизатор 2911 соединяет сети 192.168.1.0/24 и 192.168.2.0/24. У компьютеров указан основной шлюз.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'Router0', 420, 110);
        ios(r, 'interface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 192.168.2.1 255.255.255.0\n no shutdown');
        const s0 = dev(net, '2960-24TT', 'Switch0', 220, 250);
        const s1 = dev(net, '2960-24TT', 'Switch1', 620, 250);
        link(net, r, 0, s0, 'GigabitEthernet0/1');
        link(net, r, 1, s1, 'GigabitEthernet0/1');
        link(net, host(net, 'PC-PT', 'PC0', 130, 410, '192.168.1.10/24', '192.168.1.1'), 0, s0, 0);
        link(net, host(net, 'PC-PT', 'PC1', 310, 410, '192.168.1.11/24', '192.168.1.1'), 0, s0, 1);
        link(net, host(net, 'PC-PT', 'PC2', 530, 410, '192.168.2.10/24', '192.168.2.1'), 0, s1, 0);
        link(net, host(net, 'PC-PT', 'PC3', 710, 410, '192.168.2.11/24', '192.168.2.1'), 0, s1, 1);
        net.addNote(40, 30, 'С PC0: ping 192.168.2.10 и tracert 192.168.2.10.\nRouter0 → CLI → Enter → enable → show ip route.\nУберите шлюз у PC0 — NetLab подскажет, в чём дело.');
        return finish(net);
      },
    },
    {
      id: 'dhcp-dns',
      title: 'DHCP, DNS и веб-сервер',
      level: 'средний',
      desc: 'Сервер раздаёт адреса по DHCP, отвечает на DNS-запросы и показывает веб-страницу. Компьютеры получают адреса автоматически.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'Gateway', 420, 90);
        ios(r, 'hostname Gateway\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n no shutdown');
        const sw = dev(net, '2960-24TT', 'Switch0', 420, 230);
        link(net, r, 0, sw, 'GigabitEthernet0/1');
        const srv = host(net, 'Server-PT', 'Server0', 700, 230, '10.0.0.2/24', '10.0.0.1', '10.0.0.2');
        link(net, srv, 0, sw, 'GigabitEthernet0/2');
        srv.dhcpd.enabled = true;
        srv.dhcpd.setPool({ name: 'serverPool', start: ip('10.0.0.100'), end: ip('10.0.0.149'), mask: pfx(24), gateway: ip('10.0.0.1'), dns: ip('10.0.0.2') });
        srv.dnsd.enabled = true;
        srv.dnsd.setRecord('www.lab', ip('10.0.0.2'));
        srv.dnsd.setRecord('gateway.lab', ip('10.0.0.1'));
        srv.httpd.setFile('index.html', '<html><h1>Добро пожаловать на www.lab!</h1><p>Эту страницу отдаёт Server0 по протоколу HTTP.</p><p><a href="about.html">О сервере</a> · <a href="helloworld.html">Hello world</a></p></html>');
        srv.httpd.setFile('about.html', '<html><h2>О сервере</h2><p>Службы: HTTP, DHCP, DNS. Страницы можно изменить: Server0 → «Службы» → HTTP.</p><p><a href="index.html">На главную</a></p></html>');
        for (let i = 0; i < 4; i++) {
          const p = dev(net, i === 3 ? 'Laptop-PT' : 'PC-PT', i === 3 ? 'Laptop0' : 'PC' + i, 150 + i * 150, 400);
          link(net, p, 0, sw, i);
          p.setDhcp();
        }
        net.addNote(40, 20, 'Компьютеры получили адреса от Server0.\nPC0 → «Рабочий стол» → Web Browser → www.lab\nCommand Prompt: ipconfig /all, nslookup gateway.lab, ping www.lab');
        return finish(net);
      },
    },
    {
      id: 'vlan',
      title: 'VLAN и router-on-a-stick',
      level: 'средний',
      desc: 'Два VLAN на одном коммутаторе. Маршрутизатор передаёт трафик между ними через подынтерфейсы 802.1Q и транковый порт.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'Router0', 420, 90);
        const sw = dev(net, '2960-24TT', 'Switch0', 420, 250);
        link(net, r, 0, sw, 'GigabitEthernet0/1');
        ios(sw, 'vlan 10\n name Buhgalteria\nvlan 20\n name Sklad\ninterface GigabitEthernet0/1\n switchport mode trunk\n' +
          'interface FastEthernet0/1\n switchport mode access\n switchport access vlan 10\ninterface FastEthernet0/2\n switchport mode access\n switchport access vlan 10\n' +
          'interface FastEthernet0/3\n switchport mode access\n switchport access vlan 20\ninterface FastEthernet0/4\n switchport mode access\n switchport access vlan 20');
        ios(r, 'interface GigabitEthernet0/0\n no shutdown\ninterface GigabitEthernet0/0.10\n encapsulation dot1Q 10\n ip address 192.168.10.1 255.255.255.0\n' +
          'interface GigabitEthernet0/0.20\n encapsulation dot1Q 20\n ip address 192.168.20.1 255.255.255.0');
        const hosts = [['PC0', 120, '192.168.10.10', 10], ['PC1', 300, '192.168.10.11', 10], ['PC2', 540, '192.168.20.10', 20], ['PC3', 720, '192.168.20.11', 20]];
        hosts.forEach(([n, x, a, v], i) => link(net, host(net, 'PC-PT', n, x, 410, a + '/24', v === 10 ? '192.168.10.1' : '192.168.20.1'), 0, sw, i));
        net.addNote(40, 30, 'PC0, PC1 — VLAN 10; PC2, PC3 — VLAN 20.\nВ режиме «Симуляция» сделайте ping с PC0 на 192.168.20.10:\nв инспекторе PDU на транке виден тег 802.1Q. Switch0 → CLI: show vlan brief');
        return finish(net);
      },
    },
    {
      id: 'l3switch',
      title: 'Коммутатор 3-го уровня (3560)',
      level: 'средний',
      desc: 'Маршрутизация между VLAN без маршрутизатора: интерфейсы VLAN (SVI) и ip routing на Cisco 3560.',
      build() {
        const net = new NS.Network();
        const sw = dev(net, '3560-24PS', 'Core', 420, 140);
        ios(sw, 'hostname Core\nip routing\nvlan 10\n name Office\nvlan 20\n name Lab\n' +
          'interface FastEthernet0/1\n switchport mode access\n switchport access vlan 10\ninterface FastEthernet0/2\n switchport mode access\n switchport access vlan 10\n' +
          'interface FastEthernet0/3\n switchport mode access\n switchport access vlan 20\ninterface FastEthernet0/4\n switchport mode access\n switchport access vlan 20\n' +
          'interface Vlan10\n ip address 10.10.10.1 255.255.255.0\n no shutdown\ninterface Vlan20\n ip address 10.20.20.1 255.255.255.0\n no shutdown');
        [['PC0', 150, '10.10.10.10', '10.10.10.1'], ['PC1', 330, '10.10.10.11', '10.10.10.1'], ['PC2', 510, '10.20.20.10', '10.20.20.1'], ['PC3', 690, '10.20.20.11', '10.20.20.1']]
          .forEach(([n, x, a, g], i) => link(net, host(net, 'PC-PT', n, x, 330, a + '/24', g), 0, sw, i));
        net.addNote(40, 20, 'PC0 → ping 10.20.20.10 — маршрутизирует сам коммутатор.\nCore → CLI: show ip route, show ip interface brief.\nВыполните no ip routing — связь между VLAN пропадёт.');
        return finish(net);
      },
    },
    {
      id: 'stp',
      title: 'Кольцо коммутаторов (STP)',
      level: 'средний',
      desc: 'Три коммутатора соединены в кольцо. Spanning Tree блокирует один порт (оранжевый), чтобы не было петли.',
      build() {
        const net = new NS.Network();
        const a = dev(net, '2960-24TT', 'Core', 420, 120);
        const b = dev(net, '2960-24TT', 'Access1', 220, 300);
        const c = dev(net, '2960-24TT', 'Access2', 620, 300);
        ios(a, 'hostname Core\nspanning-tree vlan 1 priority 4096');
        ios(b, 'hostname Access1');
        ios(c, 'hostname Access2');
        link(net, a, 'GigabitEthernet0/1', b, 'GigabitEthernet0/1');
        link(net, a, 'GigabitEthernet0/2', c, 'GigabitEthernet0/1');
        link(net, b, 'GigabitEthernet0/2', c, 'GigabitEthernet0/2');
        link(net, host(net, 'PC-PT', 'PC0', 120, 450, '172.16.0.10/24'), 0, b, 0);
        link(net, host(net, 'PC-PT', 'PC1', 320, 450, '172.16.0.11/24'), 0, b, 1);
        link(net, host(net, 'PC-PT', 'PC2', 720, 450, '172.16.0.12/24'), 0, c, 0);
        net.addNote(40, 30, 'Core — корневой мост (приоритет 4096). Кабели «перекрёстные»: коммутатор—коммутатор.\nУдалите кабель Core—Access2: заблокированный порт сразу начнёт пересылать.\nCLI: show spanning-tree');
        return finish(net);
      },
    },
    {
      id: 'mail',
      title: 'Сообщения нескольким ПК',
      level: 'начальный',
      desc: '«Сообщения» — доставка сразу нескольким получателям, в том числе в другой сети. По каждому адресату видно: доставлено или нет и почему.',
      build() {
        const net = new NS.Network();
        const sw = dev(net, '2960-24TT', 'Office', 380, 220);
        const r = dev(net, '2911', 'Router0', 680, 140);
        ios(r, 'interface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 192.168.2.1 255.255.255.0\n no shutdown');
        link(net, r, 0, sw, 'GigabitEthernet0/1');
        const srv = host(net, 'Server-PT', 'DNS', 380, 70, '192.168.1.2/24', '192.168.1.1', '192.168.1.2');
        link(net, srv, 0, sw, 'GigabitEthernet0/2');
        srv.dnsd.enabled = true;
        const people = [['Director', 'director', 120, 380], ['Buhgalter', 'buh', 260, 400], ['Kadry', 'kadry', 400, 400], ['Manager', 'manager', 540, 380]];
        people.forEach(([n, dns, x, y], i) => {
          const a = '192.168.1.' + (10 + i);
          link(net, host(net, 'PC-PT', n, x, y, a + '/24', '192.168.1.1', '192.168.1.2'), 0, sw, i);
          srv.dnsd.setRecord(dns + '.office', ip(a));
        });
        const s2 = dev(net, '2960-24TT', 'Sklad', 760, 300);
        link(net, r, 1, s2, 'GigabitEthernet0/1');
        link(net, host(net, 'Laptop-PT', 'Kladovshik', 700, 440, '192.168.2.10/24', '192.168.2.1', '192.168.1.2'), 0, s2, 0);
        link(net, host(net, 'PC-PT', 'Logist', 850, 440, '192.168.2.11/24', '192.168.2.1', '192.168.1.2'), 0, s2, 1);
        srv.dnsd.setRecord('kladovshik.sklad', ip('192.168.2.10'));
        srv.dnsd.setRecord('logist.sklad', ip('192.168.2.11'));
        net.addNote(20, 470, 'Director → «Рабочий стол» → «Сообщения» → «Выбрать из сети» → «Выбрать всех» → Отправить.\nМожно писать и по именам: buh.office, logist.sklad. Выключите одного получателя —\nсообщение дойдёт до остальных, а для него будет понятная ошибка.');
        return finish(net);
      },
    },
    {
      id: 'email',
      title: 'Почтовые серверы (SMTP/POP3)',
      level: 'средний',
      desc: 'Два домена: office.lab и partner.lab. Письмо нескольким адресатам в обоих доменах, пересылка между серверами через DNS и отчёт о доставке каждому.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'Router0', 460, 90);
        ios(r, 'interface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.1.1 255.255.255.0\n no shutdown');
        const sa = dev(net, '2960-24TT', 'SW-Office', 250, 230);
        const sb = dev(net, '2960-24TT', 'SW-Partner', 700, 230);
        link(net, r, 0, sa, 'GigabitEthernet0/1');
        link(net, r, 1, sb, 'GigabitEthernet0/1');
        const m1 = host(net, 'Server-PT', 'Mail-Office', 90, 150, '10.0.0.10/24', '10.0.0.1', '10.0.0.10');
        const m2 = host(net, 'Server-PT', 'Mail-Partner', 860, 150, '10.0.1.10/24', '10.0.1.1', '10.0.0.10');
        link(net, m1, 0, sa, 'GigabitEthernet0/2');
        link(net, m2, 0, sb, 'GigabitEthernet0/2');
        m1.dnsd.enabled = true;
        m1.dnsd.setRecord('office.lab', ip('10.0.0.10'));
        m1.dnsd.setRecord('partner.lab', ip('10.0.1.10'));
        m1.maild.setDomain('office.lab');
        m2.maild.setDomain('partner.lab');
        const users = [['Ivan', 'ivan', 120, m1, sa, '10.0.0.21'], ['Maria', 'maria', 260, m1, sa, '10.0.0.22'], ['Petr', 'petr', 400, m1, sa, '10.0.0.23'], ['Olga', 'olga', 700, m2, sb, '10.0.1.21'], ['Sergey', 'sergey', 840, m2, sb, '10.0.1.22']];
        users.forEach(([n, u, x, m, sw, a], i) => {
          m.maild.setUser(u, '123');
          const gw = a.startsWith('10.0.0') ? '10.0.0.1' : '10.0.1.1';
          const p = host(net, 'PC-PT', n, x, 400, a + '/24', gw, '10.0.0.10');
          link(net, p, 0, sw, i % 3);
          const dom = m === m1 ? 'office.lab' : 'partner.lab';
          Object.assign(p.email, { name: n, address: u + '@' + dom, incoming: dom, outgoing: dom, user: u, password: '123' });
        });
        net.addNote(20, 460, 'Ivan → «Рабочий стол» → Email → Написать:\nmaria@office.lab, petr@office.lab, olga@partner.lab, nobody@office.lab → Отправить.\nОтчёт покажет результат для каждого адреса. Затем у Olga: Email → Получить.');
        return finish(net);
      },
    },
    {
      id: 'wifi',
      mesh: false, // не все узлы должны видеть друг друга (NAT / неподключённое устройство)
      title: 'Домашний Wi-Fi (WRT300N)',
      level: 'начальный',
      desc: 'Беспроводной маршрутизатор получает адрес от провайдера по DHCP, раздаёт Wi-Fi с паролем WPA2 и адреса 192.168.0.x, делает NAT.',
      build() {
        const net = new NS.Network();
        const isp = dev(net, '2911', 'ISP', 620, 110);
        ios(isp, 'hostname ISP\nip dhcp excluded-address 203.0.113.1\nip dhcp pool CLIENTS\n network 203.0.113.0 255.255.255.0\n default-router 203.0.113.1\n dns-server 198.51.100.10\n' +
          'interface GigabitEthernet0/0\n ip address 203.0.113.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 198.51.100.1 255.255.255.0\n no shutdown');
        const web = host(net, 'Server-PT', 'Web', 860, 110, '198.51.100.10/24', '198.51.100.1', '198.51.100.10');
        link(net, isp, 'GigabitEthernet0/1', web, 0);
        web.dnsd.enabled = true;
        web.dnsd.setRecord('www.example.com', ip('198.51.100.10'));
        web.httpd.setFile('index.html', '<html><h1>www.example.com</h1><p>Если вы видите эту страницу — интернет через Wi-Fi и NAT работает.</p></html>');
        const home = dev(net, 'WRT300N', 'Home', 360, 220);
        link(net, home, 'Internet', isp, 'GigabitEthernet0/0');
        home.setWifi({ ssid: 'HomeNet', security: 'wpa2', key: 'netlab123' });
        const lap = dev(net, 'Laptop-PT', 'Laptop0', 170, 380);
        module(net, lap, 'nic', 'WPC300N');
        lap.setWifi({ ssid: 'HomeNet', security: 'wpa2', key: 'netlab123' });
        lap.setDhcp();
        const tab = dev(net, 'TabletPC-PT', 'Tablet0', 380, 420);
        tab.setWifi({ ssid: 'HomeNet', security: 'wpa2', key: 'netlab123' });
        tab.setDhcp();
        const pc = dev(net, 'PC-PT', 'PC0', 560, 400);
        link(net, pc, 0, home, 'Ethernet 1');
        pc.setDhcp();
        net.addNote(20, 20, 'Laptop0 → «Рабочий стол» → Web Browser → www.example.com\nВыделите Home — пунктиром виден радиус Wi-Fi. Утащите ноутбук за круг — связь пропадёт.\nСмените пароль Wi-Fi на Home («Настройка» → Wi-Fi) — клиенты отключатся.');
        return finish(net);
      },
    },
    {
      id: 'nat',
      mesh: false, // не все узлы должны видеть друг друга (NAT / неподключённое устройство)
      title: 'Выход в интернет через NAT (PAT)',
      level: 'продвинутый',
      desc: 'Офисная сеть 192.168.1.0/24 выходит в «интернет» через один публичный адрес: ip nat inside source list … overload.',
      build() {
        const net = new NS.Network();
        const office = dev(net, '2911', 'Office', 330, 120);
        const isp = dev(net, '2911', 'ISP', 650, 120);
        ios(office, 'hostname Office\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n ip nat inside\n no shutdown\n' +
          'interface GigabitEthernet0/1\n ip address 203.0.113.2 255.255.255.252\n ip nat outside\n no shutdown\n' +
          'access-list 1 permit 192.168.1.0 0.0.0.255\nip nat inside source list 1 interface GigabitEthernet0/1 overload\nip route 0.0.0.0 0.0.0.0 203.0.113.1');
        ios(isp, 'hostname ISP\ninterface GigabitEthernet0/0\n ip address 203.0.113.1 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 198.51.100.1 255.255.255.0\n no shutdown');
        link(net, office, 'GigabitEthernet0/1', isp, 'GigabitEthernet0/0');
        const web = host(net, 'Server-PT', 'Internet-Web', 860, 250, '198.51.100.10/24', '198.51.100.1');
        link(net, isp, 'GigabitEthernet0/1', web, 0);
        const sw = dev(net, '2960-24TT', 'SW-Office', 330, 260);
        link(net, office, 'GigabitEthernet0/0', sw, 'GigabitEthernet0/1');
        [['PC0', 170], ['PC1', 330], ['PC2', 490]].forEach(([n, x], i) => link(net, host(net, 'PC-PT', n, x, 410, '192.168.1.' + (10 + i) + '/24', '192.168.1.1'), 0, sw, i));
        net.addNote(20, 20, 'У ISP нет маршрута в 192.168.1.0/24 — связь есть только благодаря NAT.\nPC0 → Web Browser → 198.51.100.10, затем ping 198.51.100.10 с PC1.\nOffice → CLI: show ip nat translations (или инспектором — таблица NAT).');
        return finish(net);
      },
    },
    {
      id: 'acl',
      title: 'Списки доступа (ACL)',
      level: 'продвинутый',
      desc: 'Гостевой сети запрещён веб-доступ к серверу, но ping разрешён. Сотрудникам доступно всё. Расширенный именованный ACL на входе интерфейса.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'Router0', 450, 110);
        ios(r, 'interface GigabitEthernet0/0\n ip address 192.168.10.1 255.255.255.0\n no shutdown\n' +
          'interface GigabitEthernet0/1\n ip address 192.168.20.1 255.255.255.0\n ip access-group GUESTS in\n no shutdown\n' +
          'interface GigabitEthernet0/2\n ip address 192.168.30.1 255.255.255.0\n no shutdown\n' +
          'ip access-list extended GUESTS\n remark Гостям нельзя на веб-сервер\n deny tcp 192.168.20.0 0.0.0.255 host 192.168.30.10 eq www\n permit ip any any');
        const srv = host(net, 'Server-PT', 'Server', 450, 290, '192.168.30.10/24', '192.168.30.1');
        link(net, r, 'GigabitEthernet0/2', srv, 0);
        const s1 = dev(net, '2960-24TT', 'Staff', 200, 240);
        const s2 = dev(net, '2960-24TT', 'Guests', 700, 240);
        link(net, r, 'GigabitEthernet0/0', s1, 'GigabitEthernet0/1');
        link(net, r, 'GigabitEthernet0/1', s2, 'GigabitEthernet0/1');
        link(net, host(net, 'PC-PT', 'Staff0', 120, 400, '192.168.10.10/24', '192.168.10.1'), 0, s1, 0);
        link(net, host(net, 'PC-PT', 'Staff1', 280, 400, '192.168.10.11/24', '192.168.10.1'), 0, s1, 1);
        link(net, host(net, 'Laptop-PT', 'Guest0', 640, 400, '192.168.20.10/24', '192.168.20.1'), 0, s2, 0);
        link(net, host(net, 'Laptop-PT', 'Guest1', 780, 400, '192.168.20.11/24', '192.168.20.1'), 0, s2, 1);
        net.addNote(20, 20, 'Staff0 → Web Browser → 192.168.30.10 — открывается.\nGuest0 → Web Browser → 192.168.30.10 — нет, а ping 192.168.30.10 проходит.\nRouter0 → CLI: show access-lists (счётчики совпадений).');
        return finish(net);
      },
    },
    {
      id: 'ospf',
      title: 'Динамическая маршрутизация OSPF',
      level: 'продвинутый',
      desc: 'Три маршрутизатора в треугольнике с OSPF (область 0). Разорвите любой канал — маршруты пересчитаются в обход.',
      build() {
        const net = new NS.Network();
        const R = [dev(net, '2911', 'R1', 450, 90), dev(net, '2911', 'R2', 220, 300), dev(net, '2911', 'R3', 680, 300)];
        ios(R[0], 'hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.12.1 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.13.1 255.255.255.252\n no shutdown\n' +
          'interface GigabitEthernet0/2\n ip address 192.168.1.1 255.255.255.0\n no shutdown\nrouter ospf 1\n network 10.0.0.0 0.0.255.255 area 0\n network 192.168.1.0 0.0.0.255 area 0\n passive-interface GigabitEthernet0/2');
        ios(R[1], 'hostname R2\ninterface GigabitEthernet0/0\n ip address 10.0.12.2 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.23.1 255.255.255.252\n no shutdown\n' +
          'interface GigabitEthernet0/2\n ip address 192.168.2.1 255.255.255.0\n no shutdown\nrouter ospf 1\n network 10.0.0.0 0.0.255.255 area 0\n network 192.168.2.0 0.0.0.255 area 0\n passive-interface GigabitEthernet0/2');
        ios(R[2], 'hostname R3\ninterface GigabitEthernet0/0\n ip address 10.0.13.2 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.23.2 255.255.255.252\n no shutdown\n' +
          'interface GigabitEthernet0/2\n ip address 192.168.3.1 255.255.255.0\n no shutdown\nrouter ospf 1\n network 10.0.0.0 0.0.255.255 area 0\n network 192.168.3.0 0.0.0.255 area 0\n passive-interface GigabitEthernet0/2');
        link(net, R[0], 'GigabitEthernet0/0', R[1], 'GigabitEthernet0/0');
        link(net, R[0], 'GigabitEthernet0/1', R[2], 'GigabitEthernet0/0');
        link(net, R[1], 'GigabitEthernet0/1', R[2], 'GigabitEthernet0/1');
        link(net, R[0], 'GigabitEthernet0/2', host(net, 'PC-PT', 'PC1', 450, -40, '192.168.1.10/24', '192.168.1.1'), 0);
        link(net, R[1], 'GigabitEthernet0/2', host(net, 'PC-PT', 'PC2', 90, 430, '192.168.2.10/24', '192.168.2.1'), 0);
        link(net, R[2], 'GigabitEthernet0/2', host(net, 'PC-PT', 'PC3', 810, 430, '192.168.3.10/24', '192.168.3.1'), 0);
        net.addNote(260, 470, 'R1 → CLI: show ip route (маршруты с буквой O), show ip ospf neighbor.\nPC2 → tracert 192.168.3.10, затем удалите кабель R2—R3 и повторите:\nпуть пойдёт через R1.');
        return finish(net);
      },
    },
    {
      id: 'serial',
      title: 'WAN-канал Serial (PPP)',
      level: 'продвинутый',
      desc: 'Два маршрутизатора 1941 с модулями HWIC-2T, кабель Serial DCE, clock rate и инкапсуляция PPP. Маршруты между площадками — RIP v2.',
      build() {
        const net = new NS.Network();
        const r1 = dev(net, '1941', 'Moscow', 280, 130);
        const r2 = dev(net, '1941', 'Kazan', 640, 130);
        module(net, r1, 'hwic0', 'HWIC-2T');
        module(net, r2, 'hwic0', 'HWIC-2T');
        link(net, r1, 'Serial0/0/0', r2, 'Serial0/0/0', 'serial-dce');
        ios(r1, 'hostname Moscow\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\n' +
          'interface Serial0/0/0\n ip address 10.1.1.1 255.255.255.252\n encapsulation ppp\n clock rate 64000\n no shutdown\n' +
          'router rip\n version 2\n network 192.168.1.0\n network 10.0.0.0\n no auto-summary');
        ios(r2, 'hostname Kazan\ninterface GigabitEthernet0/0\n ip address 192.168.2.1 255.255.255.0\n no shutdown\n' +
          'interface Serial0/0/0\n ip address 10.1.1.2 255.255.255.252\n encapsulation ppp\n no shutdown\n' +
          'router rip\n version 2\n network 192.168.2.0\n network 10.0.0.0\n no auto-summary');
        link(net, r1, 'GigabitEthernet0/0', host(net, 'PC-PT', 'PC-Moscow', 150, 320, '192.168.1.10/24', '192.168.1.1'), 0);
        link(net, r2, 'GigabitEthernet0/0', host(net, 'PC-PT', 'PC-Kazan', 770, 320, '192.168.2.10/24', '192.168.2.1'), 0);
        net.addNote(200, 400, 'Часы у кабеля — сторона DCE (Moscow), там задан clock rate 64000.\nMoscow → CLI: show controllers serial 0/0/0, show ip route (R — RIP).\nВыполните no clock rate или encapsulation hdlc только на одной стороне — канал упадёт.');
        return finish(net);
      },
    },
    {
      id: 'ssh',
      title: 'Удалённое управление: консоль, Telnet, SSH',
      level: 'продвинутый',
      desc: 'Администратор подключён консольным кабелем к маршрутизатору; на маршрутизаторе SSH (login local), на коммутаторе Telnet с паролем линии.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'R1', 420, 110);
        const sw = dev(net, '2960-24TT', 'S1', 420, 260);
        link(net, r, 'GigabitEthernet0/0', sw, 'GigabitEthernet0/1');
        ios(r, 'hostname R1\nenable secret class\nip domain-name lab.local\nusername admin secret cisco\ncrypto key generate rsa modulus 1024\nip ssh version 2\n' +
          'banner motd #Только для авторизованного персонала#\n' +
          'interface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\n' +
          'line console 0\n password console\n login\nline vty 0 4\n login local\n transport input ssh');
        ios(sw, 'hostname S1\nenable secret class\ninterface Vlan1\n ip address 192.168.1.2 255.255.255.0\n no shutdown\nip default-gateway 192.168.1.1\n' +
          'line vty 0 4\n password cisco\n login\n transport input telnet');
        const admin = host(net, 'PC-PT', 'Admin', 190, 400, '192.168.1.10/24', '192.168.1.1');
        link(net, admin, 0, sw, 0);
        link(net, admin, 'RS 232', r, 'Console', 'console');
        link(net, host(net, 'PC-PT', 'User', 650, 400, '192.168.1.11/24', '192.168.1.1'), 0, sw, 1);
        net.addNote(20, 20, 'Admin → Terminal (консоль R1, пароль линии: console).\nAdmin → Telnet/SSH Client → SSH 192.168.1.1, пользователь admin / cisco; enable → class.\nAdmin → Command Prompt → telnet 192.168.1.2 (пароль cisco). ssh на S1 не пустит: transport input telnet.');
        return finish(net);
      },
    },
    {
      id: 'portsec',
      mesh: false, // не все узлы должны видеть друг друга (NAT / неподключённое устройство)
      title: 'Port-security на коммутаторе',
      level: 'средний',
      desc: 'Порт Fa0/1 запоминает MAC первого устройства (sticky). Чужое устройство на этом порту выключает порт (err-disabled).',
      build() {
        const net = new NS.Network();
        const sw = dev(net, '2960-24TT', 'Switch0', 420, 150);
        ios(sw, 'interface FastEthernet0/1\n switchport mode access\n switchport port-security\n switchport port-security maximum 1\n switchport port-security mac-address sticky\n switchport port-security violation shutdown');
        const pc0 = host(net, 'PC-PT', 'PC0', 250, 320, '192.168.1.10/24');
        const pc1 = host(net, 'PC-PT', 'PC1', 590, 320, '192.168.1.11/24');
        link(net, pc0, 0, sw, 0);
        link(net, pc1, 0, sw, 1);
        host(net, 'Laptop-PT', 'Intruder', 250, 460, '192.168.1.66/24');
        net.addNote(20, 20, '1) PC0 → ping 192.168.1.11 — коммутатор запомнит MAC PC0 (show port-security).\n2) Удалите кабель PC0 и подключите Intruder к Fa0/1, сделайте ping —\nпорт перейдёт в err-disabled. Включить: interface fa0/1 → shutdown → no shutdown.');
        return finish(net);
      },
    },
    {
      id: 'sites',
      title: 'Две площадки: маршруты и DHCP relay',
      level: 'продвинутый',
      desc: 'Два маршрутизатора, статические маршруты и один DHCP-сервер на обе сети (ip helper-address).',
      build() {
        const net = new NS.Network();
        const r1 = dev(net, '2911', 'R-Moscow', 300, 120);
        const r2 = dev(net, '2911', 'R-Kazan', 640, 120);
        ios(r1, 'hostname R-Moscow\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.0.1 255.255.255.252\n no shutdown\nip route 192.168.2.0 255.255.255.0 10.0.0.2');
        ios(r2, 'hostname R-Kazan\ninterface GigabitEthernet0/0\n ip address 192.168.2.1 255.255.255.0\n ip helper-address 192.168.1.2\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.0.2 255.255.255.252\n no shutdown\nip route 192.168.1.0 255.255.255.0 10.0.0.1');
        link(net, r1, 1, r2, 1);
        const s1 = dev(net, '2960-24TT', 'SW-Moscow', 300, 270);
        const s2 = dev(net, '2960-24TT', 'SW-Kazan', 640, 270);
        link(net, r1, 0, s1, 'GigabitEthernet0/1');
        link(net, r2, 0, s2, 'GigabitEthernet0/1');
        const srv = host(net, 'Server-PT', 'DHCP', 110, 270, '192.168.1.2/24', '192.168.1.1');
        link(net, srv, 0, s1, 'GigabitEthernet0/2');
        srv.dhcpd.enabled = true;
        srv.dhcpd.setPool({ name: 'Moscow', start: ip('192.168.1.100'), end: ip('192.168.1.199'), mask: pfx(24), gateway: ip('192.168.1.1') });
        srv.dhcpd.setPool({ name: 'Kazan', start: ip('192.168.2.100'), end: ip('192.168.2.199'), mask: pfx(24), gateway: ip('192.168.2.1') });
        const add = (name, x, sw, p) => { const d = dev(net, 'PC-PT', name, x, 420); link(net, d, 0, sw, p); d.setDhcp(); };
        add('M-PC0', 220, s1, 0);
        add('M-PC1', 380, s1, 1);
        add('K-PC0', 560, s2, 0);
        add('K-PC1', 720, s2, 1);
        net.addNote(40, 20, 'Компьютеры в Казани получают адрес от сервера в Москве через relay на R-Kazan.\nВ режиме симуляции видно, как DHCP Discover превращается в unicast на сервер.\nR-Moscow → CLI: enable → show ip route');
        return finish(net);
      },
    },
  ];

  UI.EXAMPLES = EXAMPLES;
  UI.exampleHelpers = { dev, host, rif, link, ios, module, finish };
})(globalThis.NetLab = globalThis.NetLab || {});
