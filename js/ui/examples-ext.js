/* NetLab UI — примеры для новых возможностей: IPv6, SNMP и NetFlow, VPN (GRE, IPsec, Easy VPN), PPPoE,
 * Dial-up, IP-телефония (CME, PoE, voice VLAN, IP Communicator), Bluetooth, умный дом (IoT),
 * программирование платы MCU и приложение IOx на маршрутизаторе. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const { dev, host, link, ios, module, finish } = UI.exampleHelpers;
  const ip = (s) => U.parseIp(s);
  const pfx = (n) => U.maskFromPrefix(n);

  /** Провайдер между двумя офисами: R1 (192.168.1.0/24) — ISP — R2 (192.168.2.0/24). */
  function twoSites(net) {
    const r1 = dev(net, '2911', 'R-Office1', 200, 150);
    const isp = dev(net, '2911', 'ISP', 450, 90);
    const r2 = dev(net, '2911', 'R-Office2', 700, 150);
    ios(r1, 'hostname R-Office1\ninterface GigabitEthernet0/0\n ip address 10.0.1.1 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 192.168.1.1 255.255.255.0\n no shutdown\nip route 0.0.0.0 0.0.0.0 10.0.1.2');
    ios(isp, 'hostname ISP\ninterface GigabitEthernet0/0\n ip address 10.0.1.2 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.2.2 255.255.255.252\n no shutdown');
    ios(r2, 'hostname R-Office2\ninterface GigabitEthernet0/0\n ip address 10.0.2.1 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 192.168.2.1 255.255.255.0\n no shutdown\nip route 0.0.0.0 0.0.0.0 10.0.2.2');
    link(net, r1, 0, isp, 0);
    link(net, r2, 0, isp, 1);
    const pc1 = host(net, 'PC-PT', 'PC-Office1', 200, 320, '192.168.1.10/24', '192.168.1.1');
    const pc2 = host(net, 'PC-PT', 'PC-Office2', 700, 320, '192.168.2.10/24', '192.168.2.1');
    link(net, pc1, 0, r1, 1);
    link(net, pc2, 0, r2, 1);
    return { r1, isp, r2, pc1, pc2 };
  }

  const EXT = [
    {
      id: 'ipv6',
      title: 'IPv6: SLAAC и маршрутизация',
      level: 'средний',
      desc: 'Маршрутизатор с ipv6 unicast-routing рассылает Router Advertisement, компьютеры сами получают IPv6-адреса (SLAAC). Проверьте ping по IPv6.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'R1', 420, 110);
        ios(r, 'hostname R1\nipv6 unicast-routing\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n ipv6 address 2001:DB8:1::1/64\n no shutdown\ninterface GigabitEthernet0/1\n ip address 192.168.2.1 255.255.255.0\n ipv6 address 2001:DB8:2::1/64\n no shutdown');
        const s1 = dev(net, '2960-24TT', 'SW1', 220, 250);
        const s2 = dev(net, '2960-24TT', 'SW2', 620, 250);
        link(net, r, 0, s1, 'GigabitEthernet0/1');
        link(net, r, 1, s2, 'GigabitEthernet0/1');
        const a = dev(net, 'PC-PT', 'PC-A', 140, 400);
        const b = dev(net, 'PC-PT', 'PC-B', 300, 400);
        const c = dev(net, 'PC-PT', 'Server-v6', 620, 400);
        link(net, a, 0, s1, 0);
        link(net, b, 0, s1, 1);
        link(net, c, 0, s2, 0);
        a.setIpv6Host('auto');
        b.setIpv6Host('auto');
        c.setIpv6Host('static', NS.ip6.parse('2001:DB8:2::10'), 64, NS.ip6.parse('2001:DB8:2::1'));
        net.addNote(40, 20, 'PC-A и PC-B получают адрес 2001:DB8:1::… сами (SLAAC, из Router Advertisement).\nPC-A → Command Prompt: ipconfig, затем ping 2001:DB8:2::10 и tracert 2001:DB8:2::10.\nR1 → CLI: show ipv6 interface brief, show ipv6 route, show ipv6 neighbors.');
        return finish(net);
      },
    },
    {
      id: 'snmp-netflow',
      title: 'Мониторинг: SNMP и NetFlow',
      level: 'средний',
      desc: 'MIB Browser читает и меняет MIB маршрутизатора по SNMP, а NetFlow Collector на сервере собирает статистику потоков.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'R1', 420, 110);
        ios(r, 'hostname R1\nsnmp-server community public RO\nsnmp-server community private RW\nsnmp-server location Moscow, rack 3\nsnmp-server contact admin@netlab.local\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n ip flow ingress\n no shutdown\ninterface GigabitEthernet0/1\n ip address 192.168.2.1 255.255.255.0\n ip flow ingress\n no shutdown\nip flow-export version 9\nip flow-export destination 192.168.2.100 9996');
        const s1 = dev(net, '2960-24TT', 'SW1', 220, 250);
        const s2 = dev(net, '2960-24TT', 'SW2', 620, 250);
        link(net, r, 0, s1, 'GigabitEthernet0/1');
        link(net, r, 1, s2, 'GigabitEthernet0/1');
        const adm = host(net, 'PC-PT', 'Admin', 140, 400, '192.168.1.10/24', '192.168.1.1');
        const user = host(net, 'PC-PT', 'User', 300, 400, '192.168.1.11/24', '192.168.1.1');
        const col = host(net, 'Server-PT', 'Collector', 620, 400, '192.168.2.100/24', '192.168.2.1');
        link(net, adm, 0, s1, 0);
        link(net, user, 0, s1, 1);
        link(net, col, 0, s2, 0);
        col.setCollector(true, 9996);
        net.addNote(40, 20, 'Admin → Рабочий стол → MIB Browser: адрес 192.168.1.1, дерево system → sysName → Get;\ninterfaces → ifTable → Walk. SET с community private меняет hostname.\nПогоняйте трафик (User → ping 192.168.2.100, Web Browser) и откройте Collector → NetFlow Collector.');
        return finish(net);
      },
    },
    {
      id: 'gre',
      title: 'VPN: GRE-туннель между офисами',
      level: 'средний',
      desc: 'Провайдер не знает частных сетей офисов. Туннель Tunnel0 поверх интернета соединяет их: пакеты упаковываются в GRE.',
      build() {
        const net = new NS.Network();
        const { r1, r2 } = twoSites(net);
        ios(r1, 'interface Tunnel0\n ip address 172.16.0.1 255.255.255.252\n tunnel source GigabitEthernet0/0\n tunnel destination 10.0.2.1\nip route 192.168.2.0 255.255.255.0 172.16.0.2');
        ios(r2, 'interface Tunnel0\n ip address 172.16.0.2 255.255.255.252\n tunnel source GigabitEthernet0/0\n tunnel destination 10.0.1.1\nip route 192.168.1.0 255.255.255.0 172.16.0.1');
        net.addNote(40, 20, 'PC-Office1 → ping 192.168.2.10 — работает через туннель.\nВ режиме «Симуляция» видно: между R-Office1 и ISP идёт GRE (10.0.1.1 → 10.0.2.1), а внутри — ICMP.\nR-Office1 → CLI: show ip interface brief (Tunnel0 up/up), show ip route.');
        return finish(net);
      },
    },
    {
      id: 'ipsec',
      title: 'VPN: IPsec и удалённый доступ Easy VPN',
      level: 'продвинутый',
      desc: 'Офисы связаны IPsec (crypto map): трафик между сетями шифруется ESP. Домашний компьютер подключается к офису программой VPN.',
      build() {
        const net = new NS.Network();
        const { r1, isp, r2 } = twoSites(net);
        const map = (peer, lan, remote, key) => 'crypto isakmp policy 10\n encryption aes 256\n authentication pre-share\n group 5\ncrypto isakmp key ' + key + ' address ' + peer +
          '\ncrypto ipsec transform-set TS esp-aes esp-sha-hmac\naccess-list 110 permit ip ' + lan + ' 0.0.0.255 ' + remote + ' 0.0.0.255\ncrypto map VPN 10 ipsec-isakmp\n set peer ' + peer +
          '\n set transform-set TS\n match address 110\ninterface GigabitEthernet0/0\n crypto map VPN';
        ios(r1, map('10.0.2.1', '192.168.1.0', '192.168.2.0', 'office-key'));
        ios(r2, map('10.0.1.1', '192.168.2.0', '192.168.1.0', 'office-key'));
        ios(r2, 'aaa new-model\nusername anna password vpn123\nip local pool VPNPOOL 10.99.0.10 10.99.0.50\ncrypto isakmp client configuration group STAFF\n key staff-key\n pool VPNPOOL');
        ios(isp, 'interface GigabitEthernet0/2\n ip address 10.0.3.1 255.255.255.0\n no shutdown');
        const home = host(net, 'Laptop-PT', 'Home', 450, 320, '10.0.3.10/24', '10.0.3.1');
        link(net, home, 0, isp, 2);
        net.addNote(40, 20, 'IPsec: PC-Office1 → ping 192.168.2.10. Первый пакет запускает IKE, дальше между R-Office1 и ISP видно только ESP.\nR-Office1 → show crypto isakmp sa, show crypto ipsec sa.\nEasy VPN: Home → Рабочий стол → VPN: группа STAFF, ключ staff-key, сервер 10.0.2.1, anna / vpn123 → ping 192.168.2.10.');
        return finish(net);
      },
    },
    {
      id: 'pppoe',
      title: 'PPPoE: подключение как у провайдера',
      level: 'средний',
      desc: 'Сервер доступа (BRAS) проверяет логин и пароль по CHAP и выдаёт абонентам адреса. Абоненты входят программой PPPoE Dialer.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'BRAS', 420, 110);
        ios(r, 'hostname BRAS\nusername client1 password pass1\nusername client2 password pass2\nip local pool PPP 100.64.0.10 100.64.0.100\ninterface Loopback0\n ip address 100.64.0.1 255.255.255.255\nbba-group pppoe GLOBAL\n virtual-template 1\ninterface Virtual-Template1\n ip unnumbered Loopback0\n peer default ip address pool PPP\n ppp authentication chap\ninterface GigabitEthernet0/0\n pppoe enable group GLOBAL\n no shutdown\ninterface GigabitEthernet0/1\n ip address 203.0.113.1 255.255.255.0\n no shutdown');
        const sw = dev(net, '2960-24TT', 'Access', 260, 260);
        link(net, r, 0, sw, 'GigabitEthernet0/1');
        const web = host(net, 'Server-PT', 'Internet-Web', 640, 260, '203.0.113.10/24', '203.0.113.1');
        link(net, web, 0, r, 1);
        const a = dev(net, 'PC-PT', 'Client1', 160, 400);
        const b = dev(net, 'Laptop-PT', 'Client2', 360, 400);
        link(net, a, 0, sw, 0);
        link(net, b, 0, sw, 1);
        net.addNote(40, 20, 'Client1 → Рабочий стол → PPPoE Dialer: client1 / pass1 → «Подключиться».\nПосле входа: ping 203.0.113.10 и Web Browser → http://203.0.113.10.\nBRAS → CLI: show pppoe session. Попробуйте неверный пароль — CHAP откажет.');
        return finish(net);
      },
    },
    {
      id: 'dialup',
      title: 'Dial-up: модем и телефонная сеть',
      level: 'начальный',
      desc: 'Компьютеры с модемами звонят друг другу через облако Cloud-PT (телефонную сеть). Офис принимает звонки и выдаёт адрес.',
      build() {
        const net = new NS.Network();
        const cloud = dev(net, 'Cloud-PT', 'PSTN', 420, 180);
        const home = dev(net, 'PC-PT', 'Home', 180, 360);
        const office = dev(net, 'Server-PT', 'Office', 660, 360);
        module(net, home, 'nic', 'PT-HOST-NM-1AM');
        module(net, office, 'nic', 'PT-HOST-NM-1AM');
        link(net, home, 0, cloud, 'Modem0');
        link(net, office, 0, cloud, 'Modem1');
        office.setDialin({ enabled: true, ip: ip('10.10.10.1'), pool: ip('10.10.10.2'), users: [{ user: 'guest', pass: 'modem' }] });
        net.addNote(40, 20, 'Номера портов облака: Modem0 — 5551000, Modem1 — 5551001 (PSTN → Настройка).\nHome → Рабочий стол → Dial-up: номер 5551001, guest / modem → «Позвонить».\nПосле соединения: ping 10.10.10.1 и Web Browser → http://10.10.10.1.');
        return finish(net);
      },
    },
    {
      id: 'voip',
      title: 'IP-телефония: CME, PoE и voice VLAN',
      level: 'продвинутый',
      desc: 'Маршрутизатор — АТС Cisco CME. IP-телефоны питаются от PoE-коммутатора и работают в голосовом VLAN, компьютер за телефоном — в VLAN данных.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'CME', 420, 90);
        ios(r, 'hostname CME\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/0.10\n encapsulation dot1Q 10\n ip address 10.10.10.1 255.255.255.0\n' +
          'ip dhcp excluded-address 192.168.1.1\nip dhcp excluded-address 10.10.10.1\nip dhcp pool DATA\n network 192.168.1.0 255.255.255.0\n default-router 192.168.1.1\nip dhcp pool VOICE\n network 10.10.10.0 255.255.255.0\n default-router 10.10.10.1\n option 150 ip 10.10.10.1\n' +
          'telephony-service\n max-ephones 10\n max-dn 10\n ip source-address 10.10.10.1 port 2000\n auto assign 1 to 10\nephone-dn 1\n number 1001\nephone-dn 2\n number 1002\nephone-dn 3\n number 1003');
        const sw = dev(net, '3560-24PS', 'SW-PoE', 420, 220);
        ios(sw, 'hostname SW-PoE\nvlan 10\n name VOICE\ninterface GigabitEthernet0/1\n switchport trunk encapsulation dot1q\n switchport mode trunk\ninterface FastEthernet0/1\n switchport mode access\n switchport voice vlan 10\ninterface FastEthernet0/2\n switchport mode access\n switchport voice vlan 10\ninterface FastEthernet0/3\n switchport mode access');
        link(net, r, 0, sw, 'GigabitEthernet0/1');
        const p1 = dev(net, '7960', 'Phone1', 220, 360);
        const p2 = dev(net, '7960', 'Phone2', 480, 360);
        link(net, p1, 'Switch', sw, 'FastEthernet0/1');
        link(net, p2, 'Switch', sw, 'FastEthernet0/2');
        const pc = dev(net, 'PC-PT', 'PC-behind-phone', 220, 500);
        link(net, pc, 0, p1, 'PC');
        pc.setDhcp();
        const soft = dev(net, 'PC-PT', 'Softphone-PC', 700, 360);
        link(net, soft, 0, sw, 'FastEthernet0/3');
        soft.setDhcp();
        net.addNote(40, 20, 'Телефоны получают питание по PoE, адрес из пула VOICE (VLAN 10) и регистрируются на CME: номера 1001 и 1002.\nPhone1 → вкладка «Телефон»: наберите 1002 → «Вызов»; на Phone2 — «Ответить». Голос (RTP) идёт напрямую.\nSoftphone-PC → Рабочий стол → IP Communicator: TFTP 10.10.10.1 — получит номер 1003. CME → CLI: show ephone.');
        return finish(net);
      },
    },
    {
      id: 'bluetooth',
      title: 'Bluetooth: колонка, гарнитура, файлы',
      level: 'начальный',
      desc: 'Смартфон находит устройства рядом, сопрягается по PIN, играет музыку на колонке и передаёт файл на ноутбук. Отнесите колонку подальше — связь пропадёт.',
      build() {
        const net = new NS.Network();
        const phone = dev(net, 'Smartphone-PT', 'Phone', 300, 220);
        const lap = dev(net, 'Laptop-PT', 'Laptop', 520, 200);
        dev(net, 'BT-Speaker', 'Speaker', 330, 380);
        dev(net, 'BT-Headset', 'Headset', 150, 300);
        phone.saveFile('Список покупок.txt', 'Хлеб\nМолоко\nКабель витая пара');
        void lap;
        net.addNote(40, 20, 'Phone → Рабочий стол → Bluetooth → «Поиск устройств».\nСопряжение с Speaker (PIN 0000) → «Подключить звук» → «Играть».\nСопряжение с Laptop → «Отправить файл». Перетащите колонку далеко от телефона — звук прервётся.');
        return finish(net);
      },
    },
    {
      id: 'smarthome',
      title: 'Умный дом: Home Gateway и IoT Monitor',
      level: 'начальный',
      desc: 'Умные устройства регистрируются на домашнем шлюзе. С ноутбука ими можно управлять, а правила сервера включают свет при движении и сирену при дыме.',
      build() {
        const net = new NS.Network();
        const gw = dev(net, 'DLC100', 'Home Gateway', 420, 160);
        const sw = dev(net, '2960-24TT', 'SW', 420, 290);
        link(net, gw, 'Ethernet 1', sw, 'GigabitEthernet0/1');
        const things = [['Smart Lamp', 'Lamp', 120], ['Smart Fan', 'Fan', 230], ['Smart Door', 'Door', 340], ['Motion Detector', 'Motion', 450], ['Siren', 'Siren', 560], ['Temperature Monitor', 'Thermometer', 670], ['Smoke Detector', 'Smoke', 780]];
        things.forEach(([model, name, x], i) => {
          const t = dev(net, model, name, x, 450);
          link(net, t, 0, sw, i);
          t.setDhcp();
          t.setIotServer({ server: 'gateway', user: 'admin', pass: 'admin' });
        });
        const lap = dev(net, 'Laptop-PT', 'Admin', 700, 250);
        link(net, lap, 0, sw, 10);
        lap.setDhcp();
        gw.iotd.rules = [
          { name: 'Свет при движении', enabled: true, cond: { thing: 'Motion', prop: 'detected', op: '=', value: true }, actions: [{ thing: 'Lamp', prop: 'level', value: 2 }] },
          { name: 'Пожар', enabled: true, cond: { thing: 'Smoke', prop: 'level', op: '>=', value: 50 }, actions: [{ thing: 'Siren', prop: 'on', value: true }, { thing: 'Door', prop: 'open', value: true }] },
          { name: 'Жарко', enabled: true, cond: { thing: 'Thermometer', prop: 'value', op: '>', value: 28 }, actions: [{ thing: 'Fan', prop: 'speed', value: 2 }] },
        ];
        net.addNote(40, 20, 'Admin → Рабочий стол → IoT Monitor: сервер 192.168.25.1, admin / admin → «Войти».\nОткройте Motion → вкладка «Устройство» → включите датчик: правило зажжёт лампу.\nThermometer → 30 °C включит вентилятор, Smoke → 60 % — сирену и откроет дверь.');
        return finish(net);
      },
    },
    {
      id: 'mcu',
      title: 'Программирование: плата MCU и датчики',
      level: 'начальный',
      desc: 'Плата MCU-PT с кнопкой, светодиодом, потенциометром и мотором. Программа на JavaScript (setup и loop) связывает датчики с исполнительными устройствами.',
      build() {
        const net = new NS.Network();
        const mcu = dev(net, 'MCU-PT', 'MCU', 420, 200);
        const parts = [['Push Button', 'Button', 'D1', 200, 90], ['LED', 'LED', 'D0', 200, 330], ['Potentiometer', 'Pot', 'A0', 640, 90], ['Motor', 'Motor', 'D2', 640, 330]];
        for (const [model, name, pin, x, y] of parts) link(net, mcu, pin, dev(net, model, name, x, y), 0, 'iot');
        mcu.program.code = '// Кнопка (D1) зажигает светодиод (D0), потенциометр (A0) задаёт скорость мотора (D2)\nfunction setup() {\n  pinMode(0, OUTPUT);\n  pinMode(1, INPUT);\n  pinMode(2, OUTPUT);\n  Serial.println("Готово: нажмите кнопку, покрутите потенциометр");\n}\n\nfunction loop() {\n  digitalWrite(0, digitalRead(1));\n  analogWrite(2, analogRead(A0));\n  delay(50);\n}\n';
        net.addNote(40, 20, 'MCU → вкладка «Программирование» → «▶ Запустить».\nButton → вкладка «Компонент»: зажмите кнопку — светодиод загорится.\nPot → двигайте ползунок — меняется скорость мотора. Попробуйте шаблоны и свой код.');
        return finish(net);
      },
    },
    {
      id: 'iox',
      title: 'IOx: приложение на маршрутизаторе',
      level: 'продвинутый',
      desc: 'На маршрутизаторе работает веб-приложение Cisco IOx. IoX IDE на компьютере загружает новые версии, браузер открывает его по гостевому адресу.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'Edge-R1', 420, 110);
        ios(r, 'hostname Edge-R1\nusername admin privilege 15 secret cisco\niox\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\ninterface VirtualPortGroup0\n ip address 192.168.10.1 255.255.255.0\n' +
          'app-hosting appid sensors\n app-vnic gateway0 virtualportgroup 0 guest-interface 0\n  guest-ipaddress 192.168.10.2 netmask 255.255.255.0\n app-default-gateway 192.168.10.1 guest-interface 0');
        const c = NS.iox.cfg(r);
        c.pkgs.sensors = NS.iox.normPackage('sensors', { name: 'sensors-dashboard', version: '1.0', port: 8000 }, { 'index.html': '<html>\n<center><font size="+2" color="green">Датчики цеха №3</font></center>\n<hr>Температура: 21 °C<br>Влажность: 45 %\n<p>Страница отдаётся приложением IOx прямо с маршрутизатора Edge-R1.\n</html>' });
        NS.iox.install(r, 'sensors', 'sensors');
        NS.iox.action(r, 'sensors', 'start');
        ios(r, 'app-hosting appid sensors\n start');
        const sw = dev(net, '2960-24TT', 'SW', 420, 250);
        link(net, r, 0, sw, 'GigabitEthernet0/1');
        const pc = host(net, 'PC-PT', 'Engineer', 420, 400, '192.168.1.10/24', '192.168.1.1');
        link(net, pc, 0, sw, 0);
        net.addNote(40, 20, 'Engineer → Web Browser → http://192.168.10.2:8000 — страница приложения на маршрутизаторе.\nEngineer → IoX IDE: адрес 192.168.1.1, admin / cisco → «Подключиться»; измените index.html → Deploy (остановите и деактивируйте старое).\nEdge-R1 → CLI: show iox-service, show app-hosting list.');
        return finish(net);
      },
    },
  ];

  UI.EXAMPLES.push(...EXT);
})(globalThis.NetLab = globalThis.NetLab || {});
