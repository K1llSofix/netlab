### Задания с проверкой (как Activity Wizard)
- Меню «Задание» → «Мастер заданий»: схема-ответ, начальная схема, инструкции, пункты оценки (строки конфигурации, адреса, соединения, состояние портов), проверки связи ping, таймер и пароль мастера.
- У ученика — панель задания: инструкции, таймер, «Проверить» (процент выполнения и что верно, что нет) и «Заново». Ответ хранится в файле в закодированном виде.

### Коммутация
- PVST+ и Rapid PVST+ (свой корень для каждого VLAN), PortFast и BPDU Guard.
- DTP (dynamic auto / desirable, nonegotiate), VTP (server, client, transparent; домен и пароль).
- EtherChannel: LACP и PAgP, interface Port-channel, show etherchannel summary.

### Маршрутизация
- EIGRP: соседи, DUAL, variance, суммаризация. BGP: eBGP и iBGP, network … mask, show ip bgp.
- Редистрибуция между RIP, OSPF, EIGRP, BGP, static и connected; OSPF: межзональные и внешние маршруты, area … range.
- IPv6: OSPFv3, RIPng, DHCPv6-сервер на маршрутизаторе и DHCPv6 на компьютере.
- Резервирование шлюза: HSRP, VRRP и GLBP (preempt, track, балансировка GLBP).

### Безопасность
- AAA: RADIUS и TACACS+ на Server-PT, aaa new-model, login authentication, test aaa group.
- DHCP snooping, Dynamic ARP Inspection, 802.1X на портах коммутатора (супликант на ПК).
- Межсетевой экран на основе зон (ZBF) на маршрутизаторе и межсетевой экран ASA 5506-X: nameif, security-level, PAT, access-group, inspect icmp, dhcpd.
- IPsec: видны обе фазы IKE — Main Mode (6 сообщений) и Quick Mode (3); ошибки фазы 1 и 2 отдельно; show crypto session, debug crypto isakmp.

### Беспроводные сети и WAN
- Контроллер WLC 2504 и точки LAP 3702i: CAPWAP, option 43, WLAN в VLAN; WPA2-Enterprise с проверкой на RADIUS.
- Облако провайдера с DSL и коаксиалом, DSL- и кабельный модемы, вышка 3G/4G для смартфонов.
- Новые модели: маршрутизаторы 1841 и ISR 4331 (NIM-2T, NIM-ES2-4), коммутатор 3650-24PS, модуль HWIC-4ESW.

### IP-телефония и IoT
- Удержание и перевод вызова на телефоне; вызовы между двумя CME по dial-peer voice (H.323), show dial-peer voice summary.
- Правила IoT: несколько условий «И» / «ИЛИ» и расписание по часам сервера.
- Программирование плат на Python и блоками, а не только на JavaScript.

### Управление и инструменты
- Syslog, NTP, FTP-сервер и copy running-config ftp:, команды debug.
- Сложный PDU и сценарии в режиме симуляции, физические расстояния (длина кабелей, дальность Wi-Fi).
- Сетевой контроллер с REST API и программа «REST-клиент», многопользовательский режим между копиями NetLab.
- Перед открытием другой схемы NetLab предлагает сохранить несохранённую.
- 11 новых примеров, в том числе готовое задание с проверкой.
