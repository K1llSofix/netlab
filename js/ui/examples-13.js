/* NetLab UI — примеры для возможностей 1.3.0: коммутация (VTP, EtherChannel, PVST), HSRP, EIGRP и BGP,
 * IPv6 (OSPFv3, DHCPv6), межсетевой экран ASA, корпоративный Wi-Fi (WLC и LAP), доступ в интернет (DSL, кабель,
 * сотовая сеть), сетевой контроллер (REST API), IP-телефония двух офисов (dial-peer), Syslog / NTP / FTP. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const { dev, host, link, ios, module, finish } = UI.exampleHelpers;
  const ip = (s) => U.parseIp(s);
  const pfx = (n) => U.maskFromPrefix(n);

  /** Команды для ASA (у него свой CLI). Ошибка в примере — исключение. */
  function asa(d, lines) {
    const s = NS.cli.createSession(d);
    const errs = [];
    const io = { out: (l) => { if (/^(ERROR|%)/.test(String(l))) errs.push(l); }, write: () => {}, mutate: (fn) => fn(), done: () => {}, clear: () => {} };
    for (const l of lines) { NS.cli.exec(d, s, l, io); d.net.runUntilIdle(2000); }
    if (errs.length) throw new Error(d.name + ': ' + errs.join('; '));
  }

  const EX13 = [
    {
      id: 'switching-13',
      title: 'Коммутация: VTP, EtherChannel и PVST',
      level: 'средний',
      desc: 'Три коммутатора: SW1 — сервер VTP, остальные получают VLAN сами. Между SW1 и SW2 — EtherChannel (LACP) из двух линий, у каждого VLAN свой корень STP.',
      build() {
        const net = new NS.Network();
        const s1 = dev(net, '2960-24TT', 'SW1', 420, 110);
        const s2 = dev(net, '2960-24TT', 'SW2', 230, 280);
        const s3 = dev(net, '2960-24TT', 'SW3', 610, 280);
        link(net, s1, 'FastEthernet0/23', s2, 'FastEthernet0/23');
        link(net, s1, 'FastEthernet0/24', s2, 'FastEthernet0/24');
        link(net, s1, 'GigabitEthernet0/1', s3, 'GigabitEthernet0/1');
        link(net, s2, 'GigabitEthernet0/2', s3, 'GigabitEthernet0/2');
        ios(s1, 'hostname SW1\nvtp domain CCNA\nvtp password cisco\nvlan 10\n name STAFF\nvlan 20\n name GUEST\nspanning-tree vlan 10 root primary\n' +
          'interface range FastEthernet0/23 - 24\n channel-group 1 mode active\ninterface Port-channel1\n switchport mode trunk\ninterface GigabitEthernet0/1\n switchport mode trunk');
        ios(s2, 'hostname SW2\nvtp mode client\nvtp domain CCNA\nvtp password cisco\ninterface range FastEthernet0/23 - 24\n channel-group 1 mode active\n' +
          'interface Port-channel1\n switchport mode trunk\ninterface GigabitEthernet0/2\n switchport mode trunk');
        ios(s3, 'hostname SW3\nvtp mode client\nvtp domain CCNA\nvtp password cisco\ninterface GigabitEthernet0/1\n switchport mode trunk\ninterface GigabitEthernet0/2\n switchport mode trunk');
        net.runUntilIdle(20000); // LACP собирает канал, VTP разносит VLAN
        const access = 'interface FastEthernet0/1\n switchport mode access\n switchport access vlan 10\ninterface FastEthernet0/2\n switchport mode access\n switchport access vlan 20';
        ios(s2, 'spanning-tree vlan 20 root primary\n' + access);
        ios(s3, access);
        const pcs = [['Staff-1', s2, 0, '192.168.10.11', 150], ['Guest-1', s2, 1, '192.168.20.11', 310], ['Staff-2', s3, 0, '192.168.10.12', 530], ['Guest-2', s3, 1, '192.168.20.12', 690]];
        for (const [n, sw, p, a, x] of pcs) link(net, host(net, 'PC-PT', n, x, 430, a + '/24'), 0, sw, p);
        net.addNote(40, 20, 'Staff-1 → ping 192.168.10.12 — тот же VLAN через транки работает; ping 192.168.20.12 — нет (другой VLAN, маршрутизатора нет).\nSW2 → show vlan brief: VLAN 10 и 20 пришли по VTP от SW1. SW1 → show etherchannel summary, show vtp status.\nshow spanning-tree vlan 10 и vlan 20: корень VLAN 10 — SW1, VLAN 20 — SW2 (PVST).');
        return finish(net);
      },
    },
    {
      id: 'hsrp',
      title: 'Резервный шлюз: HSRP',
      level: 'средний',
      desc: 'Два маршрутизатора делят виртуальный адрес шлюза 192.168.1.254. Если основной R1 выключится, его роль за секунды возьмёт R2 — компьютерам ничего менять не нужно.',
      build() {
        const net = new NS.Network();
        const r1 = dev(net, '2911', 'R1', 300, 220);
        const r2 = dev(net, '2911', 'R2', 540, 220);
        const lan = dev(net, '2960-24TT', 'SW-LAN', 420, 380);
        const srv = dev(net, '2960-24TT', 'SW-SRV', 420, 80);
        const cfg = (n, a, b, prio) => 'hostname ' + n + '\ninterface GigabitEthernet0/0\n ip address 192.168.1.' + a + ' 255.255.255.0\n standby 1 ip 192.168.1.254\n standby 1 priority ' + prio +
          '\n standby 1 preempt\n' + (prio > 100 ? ' standby 1 track GigabitEthernet0/1 20\n' : '') + ' no shutdown\ninterface GigabitEthernet0/1\n ip address 10.0.0.' + b + ' 255.255.255.0\n standby 2 ip 10.0.0.254\n standby 2 priority ' + prio +
          '\n standby 2 preempt\n' + (prio > 100 ? ' standby 2 track GigabitEthernet0/0 20\n' : '') + ' no shutdown';
        ios(r1, cfg('R1', 2, 2, 110));
        ios(r2, cfg('R2', 3, 3, 100));
        link(net, r1, 0, lan, 'GigabitEthernet0/1');
        link(net, r2, 0, lan, 'GigabitEthernet0/2');
        link(net, r1, 1, srv, 'GigabitEthernet0/1');
        link(net, r2, 1, srv, 'GigabitEthernet0/2');
        link(net, host(net, 'PC-PT', 'PC1', 330, 500, '192.168.1.10/24', '192.168.1.254'), 0, lan, 0);
        link(net, host(net, 'PC-PT', 'PC2', 510, 500, '192.168.1.11/24', '192.168.1.254'), 0, lan, 1);
        link(net, host(net, 'Server-PT', 'Server', 700, 80, '10.0.0.10/24', '10.0.0.254'), 0, srv, 0);
        net.addNote(40, 20, 'Шлюз у компьютеров — виртуальный 192.168.1.254 (у сервера — 10.0.0.254). R1 → show standby brief: R1 — Active, R2 — Standby.\nPC1 → ping -t 10.0.0.10, затем выключите R1 кнопкой питания: через несколько секунд R2 станет Active и ping пойдёт снова.\nВключите R1 — благодаря preempt и приоритету 110 он вернёт себе роль.');
        return finish(net);
      },
    },
    {
      id: 'eigrp-bgp',
      title: 'EIGRP внутри компании и BGP с провайдером',
      level: 'продвинутый',
      desc: 'Внутри AS 65001 работает EIGRP, пограничный R2 держит eBGP-сессию с провайдером (AS 65002) и анонсирует сеть компании. Маршрут по умолчанию раздаётся в EIGRP.',
      build() {
        const net = new NS.Network();
        const r1 = dev(net, '2911', 'R1', 180, 200);
        const r2 = dev(net, '2911', 'R2-Edge', 420, 200);
        const isp = dev(net, '2911', 'ISP', 660, 200);
        ios(r1, 'hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.12.1 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 192.168.1.1 255.255.255.0\n no shutdown\n' +
          'router eigrp 100\n network 10.0.12.0 0.0.0.3\n network 192.168.1.0\n no auto-summary');
        ios(r2, 'hostname R2-Edge\ninterface GigabitEthernet0/0\n ip address 10.0.12.2 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 203.0.113.1 255.255.255.252\n no shutdown\n' +
          'ip route 0.0.0.0 0.0.0.0 203.0.113.2\nrouter eigrp 100\n network 10.0.12.0 0.0.0.3\n redistribute static\n default-metric 100000 10 255 1 1500\n no auto-summary\n' +
          'router bgp 65001\n neighbor 203.0.113.2 remote-as 65002\n network 192.168.1.0 mask 255.255.255.0');
        ios(isp, 'hostname ISP\ninterface GigabitEthernet0/0\n ip address 203.0.113.2 255.255.255.252\n no shutdown\ninterface GigabitEthernet0/1\n ip address 198.51.100.1 255.255.255.0\n no shutdown\n' +
          'router bgp 65002\n neighbor 203.0.113.1 remote-as 65001\n network 198.51.100.0 mask 255.255.255.0');
        link(net, r1, 0, r2, 0);
        link(net, r2, 1, isp, 0);
        const sw = dev(net, '2960-24TT', 'SW', 180, 340);
        link(net, r1, 1, sw, 'GigabitEthernet0/1');
        link(net, host(net, 'PC-PT', 'PC', 180, 470, '192.168.1.10/24', '192.168.1.1'), 0, sw, 0);
        link(net, host(net, 'Server-PT', 'Web', 660, 360, '198.51.100.10/24', '198.51.100.1'), 0, isp, 1);
        net.addNote(40, 20, 'PC → ping 198.51.100.10 и Web Browser http://198.51.100.10 — путь: EIGRP до R2-Edge, дальше по BGP.\nR1 → show ip eigrp neighbors, show ip route (D*EX 0.0.0.0/0 — маршрут по умолчанию из EIGRP).\nR2-Edge → show ip bgp summary, show ip bgp; ISP → show ip route bgp: сеть 192.168.1.0/24 компании пришла по BGP.');
        return finish(net);
      },
    },
    {
      id: 'ipv6-routing',
      title: 'IPv6: OSPFv3 и DHCPv6',
      level: 'средний',
      desc: 'Два маршрутизатора обмениваются IPv6-маршрутами по OSPFv3. В сети A адреса раздаёт DHCPv6-сервер на R1, в сети B компьютеры настраиваются сами (SLAAC).',
      build() {
        const net = new NS.Network();
        const r1 = dev(net, '2911', 'R1', 250, 150);
        const r2 = dev(net, '2911', 'R2', 590, 150);
        ios(r1, 'hostname R1\nipv6 unicast-routing\nipv6 router ospf 1\n router-id 1.1.1.1\nipv6 dhcp pool LAN-A\n address prefix 2001:db8:1::/64\n dns-server 2001:db8:2::100\n domain-name lab.local\n' +
          'interface GigabitEthernet0/0\n ipv6 address 2001:db8:1::1/64\n ipv6 dhcp server LAN-A\n ipv6 nd managed-config-flag\n ipv6 ospf 1 area 0\n no shutdown\n' +
          'interface GigabitEthernet0/1\n ipv6 address 2001:db8:12::1/64\n ipv6 ospf 1 area 0\n no shutdown');
        ios(r2, 'hostname R2\nipv6 unicast-routing\nipv6 router ospf 1\n router-id 2.2.2.2\ninterface GigabitEthernet0/0\n ipv6 address 2001:db8:2::1/64\n ipv6 ospf 1 area 0\n no shutdown\n' +
          'interface GigabitEthernet0/1\n ipv6 address 2001:db8:12::2/64\n ipv6 ospf 1 area 0\n no shutdown');
        link(net, r1, 1, r2, 1);
        const s1 = dev(net, '2960-24TT', 'SW-A', 250, 290);
        const s2 = dev(net, '2960-24TT', 'SW-B', 590, 290);
        link(net, r1, 0, s1, 'GigabitEthernet0/1');
        link(net, r2, 0, s2, 'GigabitEthernet0/1');
        const a = dev(net, 'PC-PT', 'PC-A', 250, 420);
        link(net, a, 0, s1, 0);
        a.setIpv6Host('dhcp');
        const b = dev(net, 'PC-PT', 'PC-B', 520, 420);
        link(net, b, 0, s2, 0);
        b.setIpv6Host('auto');
        const d = dev(net, 'Server-PT', 'DNS-v6', 680, 420);
        link(net, d, 0, s2, 1);
        d.setIpv6Host('static', NS.ip6.parse('2001:db8:2::100'), 64, NS.ip6.parse('2001:db8:2::1'));
        net.addNote(40, 20, 'PC-A → Command Prompt: ipv6config — адрес 2001:DB8:1::… выдан DHCPv6 (вместе с DNS и доменом). PC-B получил адрес сам (SLAAC).\nPC-A → ping 2001:db8:2::100. R1 → show ipv6 ospf neighbor, show ipv6 route ospf, show ipv6 dhcp binding.');
        return finish(net);
      },
    },
    {
      id: 'asa-fw',
      title: 'Межсетевой экран ASA 5506-X',
      level: 'продвинутый',
      desc: 'ASA отделяет внутреннюю сеть (inside, уровень 100) от интернета (outside, 0): PAT на адрес интерфейса, DHCP для внутренних компьютеров, inspect icmp для ответов на ping.',
      build() {
        const net = new NS.Network();
        const fw = dev(net, 'ASA5506', 'FW', 420, 200);
        const isp = dev(net, '2911', 'ISP', 680, 200);
        const sw = dev(net, '2960-24TT', 'SW', 200, 200);
        ios(isp, 'hostname ISP\ninterface GigabitEthernet0/0\n ip address 203.0.113.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 198.51.100.1 255.255.255.0\n no shutdown');
        link(net, fw, 0, isp, 0);
        link(net, fw, 1, sw, 'GigabitEthernet0/1');
        link(net, host(net, 'Server-PT', 'Internet-Web', 680, 360, '198.51.100.10/24', '198.51.100.1'), 0, isp, 1);
        asa(fw, ['enable', '', 'conf t', 'hostname FW',
          'interface g1/1', 'nameif outside', 'ip address 203.0.113.2 255.255.255.0', 'no shutdown',
          'interface g1/2', 'nameif inside', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
          'route outside 0.0.0.0 0.0.0.0 203.0.113.1',
          'object network LAN', 'subnet 192.168.1.0 255.255.255.0', 'nat (inside,outside) dynamic interface', 'exit',
          'dhcpd address 192.168.1.10-192.168.1.30 inside', 'dhcpd dns 198.51.100.10', 'dhcpd enable inside',
          'policy-map global_policy', 'class inspection_default', 'inspect icmp', 'end', 'write memory']);
        for (const [n, x] of [['PC1', 120], ['PC2', 280]]) {
          const p = dev(net, 'PC-PT', n, x, 360);
          link(net, p, 0, sw, n === 'PC1' ? 0 : 1);
          p.setDhcp();
        }
        net.addNote(40, 20, 'PC1 получает адрес от ASA (dhcpd). PC1 → ping 198.51.100.10 и http://198.51.100.10 — снаружи видно только 203.0.113.2 (PAT).\nFW → CLI (пароль enable пустой): show nameif, show xlate, show conn, show running-config.\nInternet-Web → ping 192.168.1.10 не проходит: с уровня 0 (outside) на 100 (inside) без ACL нельзя.');
        return finish(net);
      },
    },
    {
      id: 'wlc',
      title: 'Корпоративный Wi-Fi: контроллер WLC и точки LAP',
      level: 'продвинутый',
      desc: 'Лёгкие точки доступа находят контроллер по DHCP (option 43) и получают от него настройки по CAPWAP. Сеть CORP (WPA2) — в VLAN 10, сеть STAFF — WPA2-Enterprise с проверкой на RADIUS.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'R1', 420, 60);
        const sw = dev(net, '2960-24TT', 'SW', 420, 190);
        const wlc = dev(net, 'WLC-2504', 'WLC', 660, 190);
        const rad = host(net, 'Server-PT', 'RADIUS', 180, 190, '192.168.1.10/24', '192.168.1.1');
        ios(r, 'hostname R1\nip dhcp excluded-address 192.168.1.1 192.168.1.19\nip dhcp excluded-address 192.168.10.1 192.168.10.9\n' +
          'ip dhcp pool MGMT\n network 192.168.1.0 255.255.255.0\n default-router 192.168.1.1\n option 43 hex f104.c0a8.0105\n' +
          'ip dhcp pool WIFI\n network 192.168.10.0 255.255.255.0\n default-router 192.168.10.1\n' +
          'interface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/0.10\n encapsulation dot1Q 10\n ip address 192.168.10.1 255.255.255.0');
        ios(sw, 'hostname SW\nvlan 10\n name WIFI\ninterface FastEthernet0/1\n switchport mode trunk\ninterface FastEthernet0/2\n switchport mode trunk');
        link(net, r, 0, sw, 0);
        link(net, wlc, 0, sw, 1);
        link(net, rad, 0, sw, 3);
        wlc.setStatic(ip('192.168.1.5'), pfx(24), ip('192.168.1.1'), null);
        rad.aaad.enabled = true;
        rad.aaad.addClient('WLC', ip('192.168.1.5'), 'wlckey', 'radius');
        rad.aaad.addUser('anna', 'Anna2024!');
        rad.aaad.bind();
        wlc.setRadius([{ ip: ip('192.168.1.10'), key: 'wlckey' }]);
        wlc.setWlan({ ssid: 'CORP', security: 'wpa2', key: 'Corp12345', vlan: 10 });
        wlc.setWlan({ ssid: 'STAFF', security: 'wpa2-ent', vlan: 10 });
        net.runUntilIdle(3000);
        const laps = [['LAP-1', 260, 340, 2], ['LAP-2', 580, 340, 4]].map(([n, x, y, p]) => { const l = dev(net, '3702i', n, x, y); link(net, l, 0, sw, p); return l; });
        net.runUntilIdle(20000); // точки получают адрес, находят WLC и подключаются к нему
        const a = dev(net, 'Laptop-PT', 'Laptop-CORP', 200, 470);
        module(net, a, 'nic', 'WPC300N');
        a.setWifi({ ssid: 'CORP', security: 'wpa2', key: 'Corp12345' });
        a.setDhcp();
        const b = dev(net, 'Laptop-PT', 'Laptop-STAFF', 640, 470);
        module(net, b, 'nic', 'WPC300N');
        b.setWifi({ ssid: 'STAFF', security: 'wpa2-ent', user: 'anna', pass: 'Anna2024!' });
        b.setDhcp();
        void laps;
        net.addNote(40, 20, 'LAP-1 и LAP-2 получили адрес по DHCP, адрес контроллера — из option 43, и подключились к WLC (CAPWAP). WLC → «Настройка»: WLAN, точки, клиенты.\nLaptop-CORP (WPA2-PSK) и Laptop-STAFF (WPA2-Enterprise, anna / Anna2024! на RADIUS) получили адреса 192.168.10.x.\nLaptop-CORP → ping 192.168.1.10 — трафик Wi-Fi идёт по CAPWAP через контроллер в VLAN 10.');
        return finish(net);
      },
    },
    {
      id: 'wan-access',
      title: 'Доступ в интернет: DSL, кабельный модем и 4G',
      level: 'начальный',
      desc: 'Провайдер подключает абонентов тремя способами: DSL-модем по телефонной линии, кабельный модем по коаксиалу и смартфон через вышку сотовой связи.',
      build() {
        const net = new NS.Network();
        const isp = dev(net, '2911', 'ISP', 420, 80);
        const cloud = dev(net, 'Cloud-PT', 'Provider-Cloud', 250, 220);
        ios(isp, 'hostname ISP\nip dhcp excluded-address 203.0.113.1\nip dhcp excluded-address 10.64.0.1\nip dhcp pool SUBSCRIBERS\n network 203.0.113.0 255.255.255.0\n default-router 203.0.113.1\n dns-server 198.51.100.10\n' +
          'ip dhcp pool MOBILE\n network 10.64.0.0 255.255.0.0\n default-router 10.64.0.1\n dns-server 198.51.100.10\n' +
          'interface GigabitEthernet0/0\n ip address 203.0.113.1 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address 198.51.100.1 255.255.255.0\n no shutdown\n' +
          'interface GigabitEthernet0/2\n ip address 10.64.0.1 255.255.0.0\n no shutdown');
        link(net, isp, 0, cloud, 'Ethernet');
        const web = host(net, 'Server-PT', 'Web', 700, 80, '198.51.100.10/24', '198.51.100.1');
        link(net, web, 0, isp, 1);
        web.dnsd.enabled = true;
        web.dnsd.setRecord('www.provider.net', ip('198.51.100.10'));
        const dsl = dev(net, 'DSL-Modem-PT', 'DSL-Modem', 100, 360);
        net.connect(dsl.id, 0, cloud.id, cloud.portIndex('DSL'));
        const home1 = dev(net, 'PC-PT', 'Home-DSL', 100, 490);
        link(net, home1, 0, dsl, 1);
        home1.setDhcp();
        const cm = dev(net, 'Cable-Modem-PT', 'Cable-Modem', 330, 360);
        net.connect(cm.id, 0, cloud.id, cloud.portIndex('Coaxial'));
        const home2 = dev(net, 'PC-PT', 'Home-Cable', 330, 490);
        link(net, home2, 0, cm, 1);
        home2.setDhcp();
        const sw = dev(net, '2960-24TT', 'SW-Mobile', 620, 240);
        link(net, isp, 2, sw, 'GigabitEthernet0/1');
        const tower = dev(net, 'Cell-Tower', 'Tower', 620, 380);
        link(net, tower, 0, sw, 0);
        const phone = dev(net, 'Smartphone-PT', 'Phone', 700, 480);
        phone.setDhcp();
        net.addNote(40, 20, 'Home-DSL и Home-Cable получили адреса провайдера 203.0.113.x через модемы и облако; Phone — 10.64.x.x через вышку 4G.\nОткройте любой из них → Web Browser: http://www.provider.net. Отнесите Phone подальше от вышки — связь пропадёт.\nКабели: телефонный — DSL-модем ↔ облако, коаксиальный — кабельный модем ↔ облако.');
        return finish(net);
      },
    },
    {
      id: 'netctrl',
      title: 'Сетевой контроллер и REST API',
      level: 'продвинутый',
      desc: 'Network Controller находит устройства сети (discovery), проверяет учётные данные CLI и отдаёт сведения по REST API — как Cisco APIC-EM / DNA Center.',
      build() {
        const net = new NS.Network();
        const nc = host(net, 'NetworkController-PT', 'Controller', 640, 200, '192.168.1.100/24', '192.168.1.1');
        const sw = dev(net, '2960-24TT', 'SW', 420, 200);
        const r1 = dev(net, '2911', 'Edge', 300, 80);
        const r2 = dev(net, '2911', 'Core', 540, 80);
        ios(r1, 'hostname Edge\nusername netadmin secret C1sco\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown');
        ios(r2, 'hostname Core\nusername netadmin secret C1sco\ninterface GigabitEthernet0/0\n ip address 192.168.1.2 255.255.255.0\n no shutdown');
        link(net, nc, 0, sw, 0);
        link(net, r1, 0, sw, 'GigabitEthernet0/1');
        link(net, r2, 0, sw, 'GigabitEthernet0/2');
        const adm = host(net, 'PC-PT', 'Admin', 300, 340, '192.168.1.50/24', '192.168.1.1');
        link(net, adm, 0, sw, 1);
        link(net, host(net, 'PC-PT', 'User', 540, 340, '192.168.1.51/24', '192.168.1.1'), 0, sw, 2);
        nc.addCredential('netadmin', 'C1sco');
        net.addNote(40, 20, 'Admin → Web Browser: http://192.168.1.100 (admin / cisco123) — панель контроллера. Controller → «Настройка» → «Контроллер»: запустите обнаружение 192.168.1.1-192.168.1.60.\nAdmin → Рабочий стол → REST-клиент: POST /api/v1/ticket с {"username":"admin","password":"cisco123"},\nзатем GET /api/v1/network-device и GET /api/v1/host — токен X-Auth-Token подставится сам.');
        return finish(net);
      },
    },
    {
      id: 'voip-trunk',
      title: 'IP-телефония двух офисов: dial-peer, удержание и перевод',
      level: 'продвинутый',
      desc: 'В каждом офисе свой CME. Номера 100x и 200x знают друг о друге через dial-peer: вызов уходит на другой CME по H.323, а голос (RTP) идёт напрямую между телефонами.',
      build() {
        const net = new NS.Network();
        const office = (n, x, net24, first, peerPat, peerIp, wanIp) => {
          const r = dev(net, '2911', 'CME-' + n, x, 150);
          const sw = dev(net, '2960-24TT', 'SW-' + n, x, 290);
          const gw = net24 + '.1';
          let dns = '';
          for (let i = 0; i < 2; i++) dns += 'ephone-dn ' + (i + 1) + '\n number ' + (first + i) + '\n';
          ios(r, 'hostname CME-' + n + '\nip dhcp excluded-address ' + gw + '\nip dhcp pool VOICE\n network ' + net24 + '.0 255.255.255.0\n default-router ' + gw + '\n option 150 ip ' + gw + '\n' +
            'interface GigabitEthernet0/0\n ip address ' + gw + ' 255.255.255.0\n no shutdown\ninterface GigabitEthernet0/1\n ip address ' + wanIp + ' 255.255.255.252\n no shutdown\n' +
            'telephony-service\n max-ephones 5\n max-dn 5\n ip source-address ' + gw + ' port 2000\n auto assign 1 to 5\n' + dns +
            'dial-peer voice 1 voip\n destination-pattern ' + peerPat + '\n session target ipv4:' + peerIp + '\n codec g711ulaw');
          link(net, r, 0, sw, 'GigabitEthernet0/1');
          const phones = [0, 1].map((i) => {
            const p = dev(net, '7960', 'Phone-' + (first + i), x - 90 + i * 180, 430);
            link(net, p, 0, sw, i);
            p.setAdapter(true);
            return p;
          });
          return { r, phones };
        };
        const a = office('A', 250, '10.1.0', 1001, '2...', '192.168.0.2', '192.168.0.1');
        const b = office('B', 600, '10.2.0', 2001, '1...', '192.168.0.1', '192.168.0.2');
        link(net, a.r, 1, b.r, 1);
        ios(a.r, 'ip route 10.2.0.0 255.255.255.0 192.168.0.2');
        ios(b.r, 'ip route 10.1.0.0 255.255.255.0 192.168.0.1');
        net.runUntilIdle(20000);
        net.addNote(40, 20, 'Phone-1001 → вкладка «Телефон»: наберите 2001 → «Вызов». На Phone-2001 — «Ответить»: вызов прошёл на другой CME по dial-peer (H.323).\nВо время разговора: «Удержать» / «Вернуть»; наберите 2002 и «Перевести» — собеседник уйдёт на Phone-2002.\nCME-A → show dial-peer voice summary, show call active voice brief, show ephone.');
        return finish(net);
      },
    },
    {
      id: 'mgmt-13',
      title: 'Управление: Syslog, NTP и резервная копия по FTP',
      level: 'начальный',
      desc: 'Маршрутизатор отправляет журнал на Syslog-сервер, берёт точное время с NTP-сервера и сохраняет копию конфигурации на FTP-сервер.',
      build() {
        const net = new NS.Network();
        const r = dev(net, '2911', 'R1', 300, 150);
        const sw = dev(net, '2960-24TT', 'SW', 520, 150);
        ios(r, 'hostname R1\nservice timestamps log datetime msec\nlogging host 10.0.0.5\nlogging trap informational\nntp server 10.0.0.5\nip ftp username cisco\nip ftp password cisco\n' +
          'interface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n no shutdown\ninterface Loopback0\n ip address 1.1.1.1 255.255.255.255');
        link(net, r, 0, sw, 'GigabitEthernet0/1');
        link(net, host(net, 'Server-PT', 'Server', 740, 150, '10.0.0.5/24', '10.0.0.1'), 0, sw, 0);
        link(net, host(net, 'PC-PT', 'Admin', 520, 300, '10.0.0.10/24', '10.0.0.1'), 0, sw, 1);
        net.addNote(40, 20, 'R1 → CLI: conf t → interface loopback 0 → shutdown / no shutdown — сообщения появятся на Server → «Службы» → Syslog.\nR1 → show ntp status, show clock (время с сервера NTP). copy running-config ftp: → 10.0.0.5 → имя файла — копия на Server (Службы → FTP).\nAdmin → Command Prompt: ftp 10.0.0.5 (cisco / cisco), dir.');
        return finish(net);
      },
    },
  ];

  UI.EXAMPLES.push(...EX13);
})(globalThis.NetLab = globalThis.NetLab || {});
