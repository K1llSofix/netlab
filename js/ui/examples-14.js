/* NetLab UI — примеры для возможностей 1.4.0: ASA 5505 (IPsec site-to-site и WebVPN), Frame Relay, физическое пространство
 * (два здания и оптика), IP SLA и track, Linux и iptables, HTTPS-сертификаты, автоматизация на Python (RESTCONF и SSH). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const { dev, host, link, ios, module, finish } = UI.exampleHelpers;
  const ip = (s) => U.parseIp(s);

  /** Команды CLI (ASA, Linux). Ошибка в примере — исключение. */
  function cli(d, lines, errRe) {
    const s = NS.cli.createSession(d);
    const errs = [];
    const io = { out: (l) => { if ((errRe || /^(ERROR|%)/).test(String(l))) errs.push(l); }, write: () => {}, mutate: (fn) => fn(), done: () => {}, clear: () => {} };
    for (const l of lines) { NS.cli.exec(d, s, l, io); d.net.runUntilIdle(2000); }
    if (errs.length) throw new Error(d.name + ': ' + errs.join('; '));
  }

  const EX14 = [
    {
      id: 'asa5505-vpn',
      title: 'ASA 5505: филиал по IPsec и WebVPN для сотрудников',
      level: 'продвинутый',
      desc: 'ASA 5505 в центральном офисе: встроенный коммутатор и interface vlan, PAT в интернет, туннель IPsec site-to-site с маршрутизатором филиала и WebVPN — портал в браузере для сотрудника из дома.',
      build() {
        const net = new NS.Network();
        const fw = dev(net, 'ASA5505', 'FW', 420, 200);
        const isp = dev(net, '2911', 'ISP', 680, 200);
        const br = dev(net, '1941', 'Branch', 900, 200);
        const web = host(net, 'Server-PT', 'Intranet', 260, 360, '192.168.1.100/24', '192.168.1.1');
        web.httpd.setFile('index.html', '<html><head><title>Intranet</title></head><body><h1>Корпоративный портал</h1><p>Сюда можно попасть только изнутри, через туннель филиала или через WebVPN.</p><p><a href="news.html">Новости</a></p></body></html>');
        web.httpd.setFile('news.html', '<html><body><h2>Новости компании</h2><p>Филиал подключён по IPsec.</p></body></html>');
        const pc1 = dev(net, 'PC-PT', 'PC-HQ', 420, 380);
        const pc2 = host(net, 'PC-PT', 'PC-Branch', 900, 360, '192.168.2.10/24', '192.168.2.1');
        const home = host(net, 'PC-PT', 'Home', 680, 380, '198.51.100.10/24', '198.51.100.1');
        ios(isp, 'hostname ISP\ninterface GigabitEthernet0/0\n ip address 203.0.113.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.2.2 255.255.255.0\n no shutdown\n' +
          'interface GigabitEthernet0/2\n ip address 198.51.100.1 255.255.255.0\n no shutdown');
        ios(br, 'hostname Branch\ninterface GigabitEthernet0/0\n ip address 10.0.2.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 192.168.2.1 255.255.255.0\n no shutdown\n' +
          'ip route 0.0.0.0 0.0.0.0 10.0.2.2\ncrypto isakmp policy 10\n encr aes 256\n hash sha\n authentication pre-share\n group 5\ncrypto isakmp key HQ-secret address 203.0.113.2\n' +
          'crypto ipsec transform-set TS esp-aes esp-sha-hmac\naccess-list 110 permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255\n' +
          'crypto map VPN 10 ipsec-isakmp\n set peer 203.0.113.2\n set transform-set TS\n match address 110\ninterface GigabitEthernet0/0\n crypto map VPN');
        link(net, fw, 'Ethernet0/0', isp, 'GigabitEthernet0/0');
        link(net, br, 'GigabitEthernet0/0', isp, 'GigabitEthernet0/1');
        link(net, home, 0, isp, 'GigabitEthernet0/2');
        link(net, pc1, 0, fw, 'Ethernet0/1');
        link(net, web, 0, fw, 'Ethernet0/2');
        link(net, pc2, 0, br, 'GigabitEthernet0/1');
        cli(fw, ['enable', '', 'conf t', 'hostname FW', 'interface vlan 2', 'ip address 203.0.113.2 255.255.255.0', 'exit',
          'route outside 0.0.0.0 0.0.0.0 203.0.113.1',
          'object network LAN', 'subnet 192.168.1.0 255.255.255.0', 'nat (inside,outside) dynamic interface', 'exit',
          'object network BRANCH', 'subnet 192.168.2.0 255.255.255.0', 'exit',
          'nat (inside,outside) source static LAN LAN destination static BRANCH BRANCH no-proxy-arp route-lookup',
          'policy-map global_policy', 'class inspection_default', 'inspect icmp', 'exit', 'exit',
          'access-list VPN extended permit ip object LAN object BRANCH',
          'crypto ikev1 policy 10', 'authentication pre-share', 'encryption aes-256', 'hash sha', 'group 5', 'exit',
          'crypto ikev1 enable outside', 'crypto ipsec ikev1 transform-set TS esp-aes esp-sha-hmac',
          'crypto map CMAP 10 match address VPN', 'crypto map CMAP 10 set peer 10.0.2.1', 'crypto map CMAP 10 set ikev1 transform-set TS', 'crypto map CMAP interface outside',
          'tunnel-group 10.0.2.1 type ipsec-l2l', 'tunnel-group 10.0.2.1 ipsec-attributes', 'ikev1 pre-shared-key HQ-secret', 'exit',
          'username alice password Secret1', 'url-list INTRANET "Корпоративный портал" http://192.168.1.100',
          'webvpn', 'enable outside', 'exit',
          'group-policy STAFF internal', 'group-policy STAFF attributes', 'vpn-tunnel-protocol ssl-clientless', 'banner value Только для сотрудников', 'webvpn', 'url-list value INTRANET', 'exit',
          'tunnel-group DefaultWEBVPNGroup general-attributes', 'default-group-policy STAFF', 'end', 'write memory'], /^ERROR/);
        pc1.setDhcp();
        net.addNote(40, 20, 'PC-HQ получает адрес от ASA (заводской DHCP 192.168.1.5–36). PC-Branch → ping 192.168.1.100: первый пакет запускает IKE, дальше — ESP (видно в «Симуляции»).\n' +
          'Home → Web Browser → https://203.0.113.2 → «Всё равно перейти» → alice / Secret1 → закладка «Корпоративный портал».\n' +
          'FW → CLI: show switch vlan, show crypto isakmp sa, show crypto ipsec sa, show nat, show vpn-sessiondb webvpn.');
        return finish(net);
      },
    },
    {
      id: 'frame-relay',
      title: 'Frame Relay: звезда через облако и OSPF',
      level: 'продвинутый',
      desc: 'Центральный маршрутизатор и два филиала соединены через облако Frame Relay (Cloud-PT): DLCI, PVC, подынтерфейсы point-to-point и OSPF поверх виртуальных каналов.',
      build() {
        const net = new NS.Network();
        const cloud = dev(net, 'Cloud-PT', 'FR-Cloud', 460, 150);
        const hq = dev(net, '1941', 'HQ', 460, 330);
        const b1 = dev(net, '1941', 'Branch1', 200, 150);
        const b2 = dev(net, '1941', 'Branch2', 720, 150);
        for (const r of [hq, b1, b2]) module(net, r, 'hwic0', 'HWIC-2T');
        link(net, cloud, 'Serial0', hq, 'Serial0/0/0', 'serial-dce');
        link(net, cloud, 'Serial1', b1, 'Serial0/0/0', 'serial-dce');
        link(net, cloud, 'Serial2', b2, 'Serial0/0/0', 'serial-dce');
        const C = NS.fr.cloud;
        C.addDlci(cloud, 'Serial0', 102, 'HQ-Branch1');
        C.addDlci(cloud, 'Serial0', 103, 'HQ-Branch2');
        C.addDlci(cloud, 'Serial1', 201, 'Branch1-HQ');
        C.addDlci(cloud, 'Serial2', 301, 'Branch2-HQ');
        C.connect(cloud, 'Serial0', 102, 'Serial1', 201);
        C.connect(cloud, 'Serial0', 103, 'Serial2', 301);
        ios(hq, 'hostname HQ\ninterface GigabitEthernet0/0\n ip address 192.168.10.1 255.255.255.0\n no shutdown\ninterface Serial0/0/0\n no ip address\n encapsulation frame-relay\n no shutdown\n' +
          'interface Serial0/0/0.102 point-to-point\n ip address 10.1.12.1 255.255.255.252\n frame-relay interface-dlci 102\ninterface Serial0/0/0.103 point-to-point\n ip address 10.1.13.1 255.255.255.252\n frame-relay interface-dlci 103\n' +
          'router ospf 1\n network 192.168.10.0 0.0.0.255 area 0\n network 10.1.0.0 0.0.255.255 area 0');
        ios(b1, 'hostname Branch1\ninterface GigabitEthernet0/0\n ip address 192.168.11.1 255.255.255.0\n no shutdown\ninterface Serial0/0/0\n no ip address\n encapsulation frame-relay\n no shutdown\n' +
          'interface Serial0/0/0.201 point-to-point\n ip address 10.1.12.2 255.255.255.252\n frame-relay interface-dlci 201\nrouter ospf 1\n network 192.168.11.0 0.0.0.255 area 0\n network 10.1.0.0 0.0.255.255 area 0');
        ios(b2, 'hostname Branch2\ninterface GigabitEthernet0/0\n ip address 192.168.12.1 255.255.255.0\n no shutdown\ninterface Serial0/0/0\n no ip address\n encapsulation frame-relay\n no shutdown\n' +
          'interface Serial0/0/0.301 point-to-point\n ip address 10.1.13.2 255.255.255.252\n frame-relay interface-dlci 301\nrouter ospf 1\n network 192.168.12.0 0.0.0.255 area 0\n network 10.1.0.0 0.0.255.255 area 0');
        link(net, hq, 'GigabitEthernet0/0', host(net, 'PC-PT', 'PC-HQ', 460, 480, '192.168.10.10/24', '192.168.10.1'), 0);
        link(net, b1, 'GigabitEthernet0/0', host(net, 'PC-PT', 'PC-B1', 200, 330, '192.168.11.10/24', '192.168.11.1'), 0);
        link(net, b2, 'GigabitEthernet0/0', host(net, 'PC-PT', 'PC-B2', 720, 330, '192.168.12.10/24', '192.168.12.1'), 0);
        net.addNote(40, 20, 'FR-Cloud → «Настройка» → Frame Relay: DLCI на портах и PVC между ними.\nPC-B1 → ping 192.168.12.10: филиалы общаются через HQ.\nHQ → CLI: show frame-relay pvc, show frame-relay map, show ip ospf neighbor, show ip route ospf.');
        return finish(net);
      },
    },
    {
      id: 'places-campus',
      title: 'Физическое пространство: два здания и оптика',
      level: 'средний',
      desc: 'Офис и склад в 250 м друг от друга (меню «Вид» → «Физическое пространство»). Медный кабель работает только до 100 м, поэтому здания соединены оптикой между коммутаторами 3650.',
      build() {
        const net = new NS.Network();
        const sw1 = dev(net, '3650-24PS', 'SW-Office', 260, 200);
        const sw2 = dev(net, '3650-24PS', 'SW-Store', 640, 200);
        link(net, sw1, 'GigabitEthernet1/1/1', sw2, 'GigabitEthernet1/1/1', 'fiber');
        const pcs = [['PC-Office', 160, sw1, '192.168.1.10/24'], ['Printer-PC', 360, sw1, '192.168.1.11/24'], ['PC-Store', 540, sw2, '192.168.1.20/24'], ['Scanner-PC', 740, sw2, '192.168.1.21/24']]
          .map(([n, x, sw, a], i) => { const p = host(net, 'PC-PT', n, x, 360, a); link(net, p, 0, sw, i % 2); return p; });
        const P = NS.places;
        const store = P.add(net, 'c1', 'Склад', 3250, 2000);
        const closet = P.add(net, store.id, 'Шкаф склада', 60, 30);
        P.rename(net, 'b1', 'Офис');
        P.setDevice(net, sw1.id, 'k1', 2, 1);
        P.setDevice(net, pcs[0].id, 'b1', 30, 20);
        P.setDevice(net, pcs[1].id, 'b1', 45, 35);
        P.setDevice(net, sw2.id, closet.id, 3, 2);
        P.setDevice(net, pcs[2].id, store.id, 40, 25);
        P.setDevice(net, pcs[3].id, store.id, 90, 50);
        P.setOn(net, true);
        net.addNote(40, 20, 'Вид → «Физическое пространство»: город → здания «Офис» и «Склад» → шкафы. Подписи на кабелях — длина в метрах.\nPC-Office → ping 192.168.1.20 работает: между зданиями оптика (до 2 км).\nЗамените оптику медным кабелем — он станет красным: 250 м больше предела 100 м.');
        return finish(net);
      },
    },
    {
      id: 'ipsla-track',
      title: 'IP SLA и track: резервный провайдер',
      level: 'продвинутый',
      desc: 'R1 проверяет основного провайдера пингом IP SLA. Пока ответы идут, маршрут по умолчанию — через ISP1; при отказе track переключает трафик на плавающий маршрут через ISP2.',
      build() {
        const net = new NS.Network();
        const r1 = dev(net, '2911', 'R1', 300, 220);
        const sw = dev(net, '2960-24TT', 'SW-ISP1', 520, 120);
        const isp1 = dev(net, '2911', 'ISP1', 740, 120);
        const isp2 = dev(net, '2911', 'ISP2', 740, 320);
        const inet = dev(net, '2911', 'Internet', 960, 220);
        link(net, r1, 'GigabitEthernet0/1', sw, 'GigabitEthernet0/1');
        link(net, isp1, 'GigabitEthernet0/1', sw, 'GigabitEthernet0/2');
        link(net, r1, 'GigabitEthernet0/2', isp2, 'GigabitEthernet0/1');
        link(net, isp1, 'GigabitEthernet0/0', inet, 'GigabitEthernet0/0');
        link(net, isp2, 'GigabitEthernet0/0', inet, 'GigabitEthernet0/1');
        ios(isp1, 'hostname ISP1\ninterface GigabitEthernet0/1\n ip address 203.0.113.1 255.255.255.248\n no shutdown\ninterface GigabitEthernet0/0\n ip address 10.10.1.1 255.255.255.252\n no shutdown\nip route 0.0.0.0 0.0.0.0 10.10.1.2\nip route 192.168.1.0 255.255.255.0 203.0.113.2');
        ios(isp2, 'hostname ISP2\ninterface GigabitEthernet0/1\n ip address 198.51.100.1 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/0\n ip address 10.10.2.1 255.255.255.252\n no shutdown\nip route 0.0.0.0 0.0.0.0 10.10.2.2\nip route 192.168.1.0 255.255.255.0 198.51.100.2');
        ios(inet, 'hostname Internet\ninterface GigabitEthernet0/0\n ip address 10.10.1.2 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 10.10.2.2 255.255.255.252\n no shutdown\n' +
          'interface Loopback0\n ip address 8.8.8.8 255.255.255.255\nip route 192.168.1.0 255.255.255.0 10.10.1.1\nip route 192.168.1.0 255.255.255.0 10.10.2.1 10');
        ios(r1, 'hostname R1\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 203.0.113.2 255.255.255.248\n no shutdown\n' +
          'interface GigabitEthernet0/2\n ip address 198.51.100.2 255.255.255.252\n no shutdown\nip sla 1\n icmp-echo 203.0.113.1 source-interface GigabitEthernet0/1\n frequency 5\nip sla schedule 1 life forever start-time now\n' +
          'track 1 ip sla 1 reachability\nip route 0.0.0.0 0.0.0.0 203.0.113.1 track 1\nip route 0.0.0.0 0.0.0.0 198.51.100.1 10');
        link(net, r1, 'GigabitEthernet0/0', host(net, 'PC-PT', 'PC', 100, 220, '192.168.1.10/24', '192.168.1.1'), 0);
        net.addNote(40, 20, 'PC → tracert 8.8.8.8 — путь через ISP1 (203.0.113.1).\nВыключите ISP1 (или его порт Gi0/1): через несколько секунд track 1 станет Down, и маршрут по умолчанию уйдёт на ISP2 (tracert покажет 198.51.100.1).\nR1 → CLI: show ip sla statistics, show track, show ip route static.');
        return finish(net);
      },
    },
    {
      id: 'linux-iptables',
      title: 'Linux: bash, ip и iptables на сервере',
      level: 'средний',
      desc: 'Сервер работает под Linux: командная строка bash (ip a, ss, curl, systemctl) и межсетевой экран iptables — веб-сервер открыт всем, а ping разрешён только администратору.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'R1', 420, 110);
        const sw = dev(net, '2960-24TT', 'SW', 420, 250);
        ios(r, 'hostname R1\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown');
        link(net, r, 'GigabitEthernet0/0', sw, 'GigabitEthernet0/1');
        const srv = host(net, 'Server-PT', 'Web-Linux', 640, 380, '192.168.1.20/24', '192.168.1.1');
        const adm = host(net, 'PC-PT', 'Admin-Linux', 420, 400, '192.168.1.10/24', '192.168.1.1');
        const usr = host(net, 'PC-PT', 'User', 200, 380, '192.168.1.30/24', '192.168.1.1');
        link(net, srv, 0, sw, 0);
        link(net, adm, 0, sw, 1);
        link(net, usr, 0, sw, 2);
        NS.linux.setOs(srv, 'linux');
        NS.linux.setOs(adm, 'linux');
        cli(srv, ['iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT', 'iptables -A INPUT -p tcp --dport 80 -j ACCEPT',
          'iptables -A INPUT -p icmp --icmp-type echo-request -s 192.168.1.10 -j ACCEPT', 'iptables -P INPUT DROP'], /^(iptables|bash):/);
        net.addNote(40, 20, 'Admin-Linux и Web-Linux → вкладка CLI (bash): ip a, ip r, ss -tln, curl http://192.168.1.20, ping -c 2 192.168.1.20.\nUser → ping 192.168.1.20 не проходит (iptables DROP), а Web Browser → http://192.168.1.20 открывается.\nWeb-Linux → iptables -L -n -v --line-numbers — счётчики правил растут.');
        return finish(net);
      },
    },
    {
      id: 'https-certs',
      title: 'HTTPS: самоподписанный и доверенный сертификат',
      level: 'средний',
      desc: 'Два веб-сервера по HTTPS: у одного сертификат самоподписанный — браузер предупреждает, у другого выдан NetLab Root CA на имя www.lab — замок и никаких предупреждений.',
      build() {
        const net = new NS.Network();
        const sw = dev(net, '2960-24TT', 'SW', 420, 200);
        const dns = host(net, 'Server-PT', 'DNS', 200, 80, '192.168.1.5/24');
        const good = host(net, 'Server-PT', 'www.lab', 640, 80, '192.168.1.20/24');
        const bad = host(net, 'Server-PT', 'old.lab', 640, 340, '192.168.1.21/24');
        const pc = host(net, 'PC-PT', 'PC', 200, 340, '192.168.1.10/24', null, '192.168.1.5');
        for (const [d, p] of [[dns, 0], [good, 1], [bad, 2], [pc, 3]]) link(net, d, 0, sw, p);
        dns.dnsd.enabled = true;
        dns.dnsd.records = [{ name: 'www.lab', ip: ip('192.168.1.20') }, { name: 'old.lab', ip: ip('192.168.1.21') }];
        if (dns.dnsd.bind) dns.dnsd.bind();
        NS.tls.setCert(good, { cn: 'www.lab', san: ['www.lab'], issuer: NS.tls.TRUSTED });
        good.httpd.setFile('index.html', '<html><body><h1>www.lab</h1><p>Сертификат выдан NetLab Root CA — браузер доверяет ему.</p></body></html>');
        bad.httpd.setFile('index.html', '<html><body><h1>old.lab</h1><p>Сертификат самоподписанный.</p></body></html>');
        net.addNote(40, 20, 'PC → Web Browser: https://www.lab — замок, всё в порядке. https://old.lab — «Подключение не защищено» (NET::ERR_CERT_AUTHORITY_INVALID).\nhttps://192.168.1.20 — тоже предупреждение: IP-адреса нет в сертификате (имя не совпадает).\nСервер → «Службы» → HTTP → «Сертификат HTTPS»: выпустите доверенный сертификат для old.lab.');
        return finish(net);
      },
    },
    {
      id: 'python-automation',
      title: 'Автоматизация: Python на ПК настраивает маршрутизатор',
      level: 'продвинутый',
      desc: 'Программа на Python (вкладка «Программирование» компьютера) читает интерфейсы маршрутизатора по RESTCONF (requests) и настраивает его по SSH (netmiko ConnectHandler).',
      build() {
        const net = new NS.Network();
        const r = dev(net, '4331', 'R1', 420, 150);
        const pc = host(net, 'PC-PT', 'NetOps', 420, 330, '192.168.1.10/24', '192.168.1.1');
        link(net, r, 'GigabitEthernet0/0/0', pc, 0);
        ios(r, 'hostname R1\nip domain-name lab.local\nenable secret class\nusername admin privilege 15 secret cisco\n' +
          'interface GigabitEthernet0/0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\nline vty 0 4\n login local\n transport input ssh\nip http secure-server\nip http authentication local\nrestconf');
        cli(r, ['enable', 'class', 'conf t', 'crypto key generate rsa general-keys modulus 1024', 'end'], /^% (Invalid|Incomplete|Ambiguous)/);
        NS.automation.setProgram(pc, { lang: 'python', code: [
          'import requests',
          'from netmiko import ConnectHandler',
          '',
          'URL = "https://192.168.1.1/restconf/data/ietf-interfaces:interfaces"',
          'AUTH = ("admin", "cisco")',
          '',
          'class Router:',
          '    def __init__(self, host):',
          '        self.host = host',
          '        self.conn = None',
          '    def interfaces(self):',
          '        r = requests.get(URL, auth=AUTH, verify=False)',
          '        r.raise_for_status()',
          '        return [i["name"] for i in r.json()["ietf-interfaces:interfaces"]["interface"]]',
          '    def configure(self, lines):',
          '        c = ConnectHandler(device_type="cisco_ios", host=self.host, username="admin", password="cisco")',
          '        c.send_config_set(lines)',
          '        out = c.send_command("show ip interface brief")',
          '        c.disconnect()',
          '        return out',
          '',
          'r1 = Router("192.168.1.1")',
          'print("Интерфейсы:", ", ".join(r1.interfaces()))',
          'for n in range(1, 4):',
          '    print(r1.configure([f"interface loopback {n}", f"ip address 10.0.{n}.1 255.255.255.0"]).splitlines()[-1])',
          'print("Теперь:", len(r1.interfaces()), "интерфейсов")',
        ].join('\n') });
        net.addNote(40, 20, 'NetOps → вкладка «Программирование» → ▶ Запустить: программа читает интерфейсы R1 по RESTCONF и добавляет Loopback1–3 по SSH.\nR1 → CLI: show ip interface brief, show running-config | section restconf.\nВ «Симуляции» видно TLS-рукопожатие RESTCONF и сеансы SSH.');
        return finish(net);
      },
    },
  ];

  UI.EXAMPLES.push(...EX14);
})(globalThis.NetLab = globalThis.NetLab || {});
