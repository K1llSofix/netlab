# NetLab — учебный симулятор компьютерных сетей

NetLab — симулятор сетей в духе Cisco Packet Tracer. Есть настольное приложение для Windows и версия для браузера. Интерфейс полностью на русском.

## Настольное приложение (Windows)

Готовые файлы лежат в папке `dist/` после сборки (см. ниже):

- `NetLab-Setup-1.3.0.exe` — установщик. Создаёт ярлыки на рабочем столе и в меню «Пуск», связывает файлы `.netlab` с NetLab: схема открывается двойным щелчком.
- `NetLab-1.3.0-portable.exe` — версия без установки: один файл, можно носить на флешке.

Особенности настольной версии:

- родное меню «Файл / Правка / Вид / Справка»;
- обычные окна «Открыть» и «Сохранить как»; `Ctrl+S` сохраняет в тот же файл без вопросов;
- в заголовке окна видно имя файла, `•` означает несохранённые изменения;
- при закрытии с несохранёнными изменениями NetLab предложит сохранить;
- файл схемы можно перетащить в окно;
- последняя схема восстанавливается при следующем запуске.

Установщик не подписан цифровой подписью, поэтому при первом запуске Windows SmartScreen может показать предупреждение: «Подробнее» → «Выполнить в любом случае».

### Обновления

При запуске NetLab проверяет, есть ли новая версия. Если есть, показывает окно с номером версии и списком «Что нового» и предлагает три варианта: «Обновить сейчас», «Напомнить позже» или «Пропустить эту версию».

- **Установленная версия** скачивает обновление в фоне с индикатором загрузки. Затем предлагает «Перезапустить и установить»; если отложить, обновление установится при закрытии программы. Перед перезапуском NetLab предложит сохранить открытую схему.
- **Portable-версия** себя не заменяет: кнопка «Скачать» открывает в браузере загрузку нового файла.
- Проверить вручную: «Справка → Проверить обновления…». Автопроверку можно выключить в меню «Вид» или в окне «О программе».

Обновления берутся из выпусков (Releases) репозитория GitHub, указанного в `package.json` → `build.publish`. Сейчас там указан `K1llSofix/netlab`. Если репозиторий называется иначе, поменяйте `owner` и `repo`. Репозиторий должен быть публичным.

**Как выпустить новую версию**

1. Увеличьте `version` в `package.json` (например, `1.3.0` → `1.4.0`) и опишите изменения в `build/release-notes.md`. Разделы начинайте с `### `, пункты — с `- `. Этот текст пользователи увидят дважды: в окне с предложением обновиться и один раз после обновления в окне «Что нового в NetLab 1.4.0». Также он доступен в «Справка → Что нового в этой версии». При сборке текст попадает в `latest.yml`, поэтому программа покажет его, даже если описание Release на GitHub оставить пустым. Для красоты страницы на GitHub вставьте тот же текст в описание Release (`npm run release` сделает это сам).
2. Соберите: `npm run dist`.
3. На GitHub создайте Release с тегом `v1.4.0` (буква `v` и номер версии) и приложите файлы из `dist/`:
   - `NetLab-Setup-1.4.0.exe`
   - `NetLab-Setup-1.4.0.exe.blockmap`
   - `latest.yml`
   - `NetLab-1.4.0-portable.exe`

   Опубликуйте Release (черновик программы не видят).

Вместо шагов 2–3 можно одной командой собрать и опубликовать выпуск: `npm run release`. Для этого нужен токен GitHub с правом записи в репозиторий в переменной `GH_TOKEN`. Токен не записывайте в файлы проекта.

Версии 1.0.0 и 1.1.0 обновляться не умеют: у 1.0.0 проверки обновлений ещё не было, а в 1.1.0 она не находила адрес GitHub. Если у вас одна из них, один раз установите 1.1.1 или новее вручную — дальше обновления будут приходить сами.

## Версия для браузера

Откройте файл `index.html` двойным щелчком (Chrome, Edge или Firefox). Если браузер ограничивает локальные файлы, запустите локальный сервер:

```bash
python -m http.server 8123
```

Затем откройте в браузере <http://localhost:8123>.

Схема автоматически сохраняется в браузере. Кнопки «Сохранить» и «Открыть» работают с файлами `.netlab` (это JSON). Файлы первой версии NetLab тоже открываются.

## Возможности

### Устройства и модели (как в Packet Tracer)

| Категория | Модели |
|---|---|
| Маршрутизаторы | Cisco 2911 (3 × Gigabit, 4 слота EHWIC), Cisco 1941 (2 × Gigabit, 2 слота), Cisco 1841, ISR 4331 (модули NIM-2T, NIM-ES2-4), Router-PT; модуль встроенного коммутатора HWIC-4ESW |
| Коммутаторы | Cisco 2960-24TT (2-й уровень), Cisco 3560-24PS и Catalyst 3650-24PS (3-й уровень: SVI, `ip routing`, routed-порты) |
| Безопасность | Межсетевой экран Cisco ASA 5506-X (свой CLI ASA) |
| Концентраторы | Hub-PT |
| Беспроводные | AccessPoint-PT, домашний маршрутизатор Linksys WRT300N (WAN по DHCP или статически, NAT, DHCP, Wi-Fi, WPA2-Enterprise), домашний шлюз IoT Home Gateway DLC100, контроллер WLC 2504 и лёгкие точки LAP 3702i |
| Конечные | PC-PT, Laptop-PT, Server-PT, Printer-PT, TabletPC-PT, Smartphone-PT, IP-телефон Cisco 7960, Bluetooth-колонка и гарнитура |
| WAN | Cloud-PT — телефонная сеть с портами Modem и номерами (модем PT-HOST-NM-1AM в ПК) и сеть провайдера с портами Ethernet, DSL и Coaxial; DSL- и кабельный модемы; вышка сотовой связи 3G/4G; облако Multiuser-PT |
| Управление | Сетевой контроллер Network Controller-PT (REST API, обнаружение устройств) |
| IoT | Умная лампа, вентилятор, дверь, окно, сирена, кофеварка, датчики движения, температуры и дыма; платы MCU-PT и SBC-PT; компоненты: светодиод, зуммер, мотор, кнопка, переключатель, потенциометр, фото-, термодатчик, датчик движения |

### Окно устройства

- **Физический вид.** Панель устройства со светодиодами портов, кнопка питания, список модулей с описанием. Модули ставятся перетаскиванием в слот и только при выключенном питании: HWIC-2T (Serial), HWIC-1GE-SFP, сетевые карты ПК и ноутбука (медь, оптика, Wi-Fi WMP300N / WPC300N).
- **Настройка.** Боковое меню GLOBAL / ROUTING / SWITCHING / INTERFACE, как в CPT. На маршрутизаторе и коммутаторе каждое действие выполняется настоящей командой IOS, а внизу видны «Эквивалентные команды IOS». Сохранение и стирание NVRAM, экспорт и загрузка startup/running-config.
- **Рабочий стол** ПК, ноутбука, планшета и сервера: IP Configuration, Command Prompt, Terminal (консоль через кабель), Web Browser, PC Wireless, Email, «Сообщения», Telnet/SSH Client, Traffic Generator, Text Editor, Firewall, MIB Browser, NetFlow Collector, VPN, PPPoE Dialer, IP Communicator, IoT Monitor, IoX IDE, REST-клиент.
- **Службы** сервера: HTTP (редактор страниц), DHCP, DNS, EMAIL (SMTP/POP3, домен, пользователи), TFTP, FTP, SYSLOG, NTP, AAA (RADIUS и TACACS+), IoT.
- **CLI**: консоль Cisco IOS с `Press RETURN to get started`, паролями, `?` и Tab.
- **Атрибуты**: MTBF, стоимость, питание, место в стойке, свои атрибуты. Общая стоимость сети показана в строке состояния.

### Новое в 1.2: IPv6, VPN, телефония, IoT

- **IPv6.** Адреса и `ipv6 enable` на интерфейсах, `ipv6 unicast-routing`, статические маршруты, Neighbor Discovery, Router Advertisement и SLAAC (EUI-64) на компьютерах, `ping`/`tracert` по IPv6, `show ipv6 interface/route/neighbors`. Поля IPv6 в IP Configuration и в настройках интерфейсов.
- **SNMP и MIB Browser.** Агент SNMP v2c на маршрутизаторах и коммутаторах (`snmp-server community … RO/RW [acl]`, location, contact), MIB-II: system, ifTable со счётчиками, ipAddrTable. Программа MIB Browser: дерево MIB, Get / Get Next / Get Bulk / Walk / Set (RW меняет hostname и выключает интерфейсы).
- **NetFlow.** `ip flow ingress/egress`, `ip flow-export destination/version`, `show ip cache flow`, экспорт по UDP на программу NetFlow Collector.
- **VPN.** GRE-туннели (`interface Tunnel`), IPsec site-to-site (`crypto isakmp policy/key`, `transform-set`, `crypto map` с ACL; ошибки ключа и политики видны в `show crypto isakmp sa`), удалённый доступ Easy VPN с пулом адресов и программой VPN на компьютере.
- **PPPoE и Dial-up.** Сервер доступа на маршрутизаторе (`bba-group pppoe`, `Virtual-Template`, CHAP/PAP, пул адресов) и программа PPPoE Dialer; модем в компьютере, облако Cloud-PT с номерами, программа Dial-up с приёмом звонков и выдачей адреса.
- **IP-телефония.** Cisco CME (`telephony-service`, `ephone-dn`, `ephone`, `auto assign`), IP-телефон 7960 с питанием от адаптера или PoE (3560-24PS, `show power inline`), `switchport voice vlan`, DHCP `option 150`, регистрация по SCCP, голос по RTP напрямую между телефонами, компьютер за телефоном. Программный телефон IP Communicator.
- **Bluetooth.** Поиск устройств в радиусе, сопряжение по PIN, музыка на колонке или гарнитуре, передача файлов.
- **IoT.** Умные устройства регистрируются на IoT-сервере (Home Gateway или служба IoT на Server-PT). IoT Monitor управляет ими и задаёт правила «если… то…».
- **Программирование.** Платы MCU-PT и SBC-PT с пинами D0–D5 и A0–A3, IoT-кабель к компонентам, вкладка «Программирование»: JavaScript в стиле Arduino (`setup()`, `loop()`, `digitalWrite`, `analogRead`, `delay`), шаблоны, консоль. Программа выполняется в отдельном потоке без доступа к сети и файлам.
- **IOx и IoX IDE.** `iox`, `interface VirtualPortGroup0`, `app-hosting appid …`, установка, запуск и остановка приложений; IoX IDE на компьютере загружает веб-приложение (package.yaml + index.html) на маршрутизатор через IOx Local Manager, а браузер открывает его по гостевому адресу.

### Новое в 1.3: CCNA целиком, задания с проверкой

- **Задания (Activity Wizard).** Меню «Задание» → «Мастер заданий»: запомните готовую схему как ответ и урезанную — как начальную, напишите инструкции (простая разметка: заголовки, списки, **жирный**, `команды`), отметьте пункты оценки и баллы. Пункты строятся сравнением ответа с заводскими настройками: строки running-config маршрутизаторов, коммутаторов и ASA (с учётом раздела `interface …`, `router …`), адреса и службы компьютеров и серверов, соединения между портами, состояние портов. Проверки связи — ping на копии схемы ученика («связь есть» или «связи быть не должно»). Таймер, режим показа результатов (всё, только процент, ничего) и пароль мастера. У ученика — панель задания: инструкции, таймер, «Проверить» и «Заново». Задание хранится в том же файле `.netlab`, ответ — в закодированном виде.
- **Коммутация.** PVST+ и Rapid PVST+ (`spanning-tree vlan … root primary|priority`, свой корень у каждого VLAN), PortFast и BPDU Guard, DTP (`dynamic auto|desirable`, `nonegotiate`), VTP (server / client / transparent, домен, пароль, ревизия), EtherChannel (LACP и PAgP, `interface Port-channel`, `show etherchannel summary`).
- **Резервирование шлюза.** HSRP (v1/v2), VRRP и GLBP: приоритет, `preempt`, `track`, виртуальный MAC, балансировка GLBP; `show standby|vrrp|glbp [brief]`.
- **EIGRP и BGP.** EIGRP: соседи, составная метрика, DUAL (successor и feasible successor), `variance`, `passive-interface`, суммаризация. BGP: eBGP и iBGP (`update-source`, `next-hop-self`, `ebgp-multihop`), `network … mask`, AS_PATH, `show ip bgp [summary]`. Редистрибуция между RIP, OSPF, EIGRP, BGP, static и connected; OSPF: O IA, O E2, `area … range`.
- **IPv6.** OSPFv3 (`ipv6 router ospf`, `ipv6 ospf … area`), RIPng, DHCPv6-сервер на маршрутизаторе (`ipv6 dhcp pool`, флаги M и O в RA) и режим DHCPv6 на компьютере (`ipconfig /renew6`).
- **Безопасность.** AAA: служба RADIUS и TACACS+ на Server-PT, `aaa new-model`, `aaa authentication login`, `login authentication`, `test aaa group`. DHCP snooping, Dynamic ARP Inspection, 802.1X на портах коммутатора с проверкой на RADIUS. Zone-Based Firewall на маршрутизаторе. Межсетевой экран ASA 5506-X: `nameif`, `security-level`, таблица соединений, `access-group`, object NAT (PAT и static), `inspect icmp`, `dhcpd`. IPsec: обе фазы IKE видны в симуляции — Main Mode (6 сообщений: политика, ключи Диффи — Хеллмана, аутентификация) и Quick Mode (3), ошибки фазы 1 и фазы 2 различаются; `show crypto isakmp sa` (MM_SA_SETUP, MM_KEY_EXCH, QM_IDLE), `show crypto session`, `clear crypto isakmp`, `debug crypto isakmp|ipsec`.
- **Беспроводные сети.** Контроллер WLC 2504 и точки LAP 3702i: поиск контроллера (в своей сети или по DHCP option 43), CAPWAP, WLAN в VLAN, клиенты и точки в окне контроллера. WPA2-Enterprise с проверкой пользователя на RADIUS (на WLC и WRT300N).
- **WAN.** Облако провайдера с портами DSL и Coaxial, DSL- и кабельный модемы, коаксиальный кабель, вышка 3G/4G для смартфонов. Маршрутизаторы 1841 и ISR 4331, коммутатор 3650-24PS, модуль HWIC-4ESW (`interface vlan` на маршрутизаторе, `show vlan-switch`).
- **Телефония.** Удержание и возврат вызова, слепой перевод на другой номер; вызовы между CME по `dial-peer voice N voip` (`destination-pattern`, `session target ipv4:`) — сигнализация H.323, голос напрямую между телефонами; `show dial-peer voice summary`, `show call active voice brief`.
- **IoT и программирование.** Правила IoT с несколькими условиями «И» / «ИЛИ» и расписанием по часам сервера (дни недели, интервал времени); противоречащие правила не переключают устройство бесконечно. Программы плат на Python (подмножество: `def`, `while`, `for … in range`, списки) и блоками — без знания языка.
- **Управление.** Журнал IOS и Syslog (`logging host`, `logging trap`, `service timestamps`), NTP (`ntp server`, `ntp master`, аутентификация), FTP-сервер и `copy running-config ftp:`, команды `debug`.
- **Инструменты.** Сложный PDU (ICMP / TCP / UDP с портами, TTL, размером, периодичностью) и сценарии в режиме симуляции; физические расстояния (масштаб схемы, предельная длина кабелей, дальность Wi-Fi и вышки в метрах); сетевой контроллер с REST API (`/api/v1/ticket`, `network-device`, `host`, `discovery`) и программа «REST-клиент»; многопользовательский режим — облако Multiuser-PT соединяет схемы двух копий NetLab по сети.
- **Удобство.** Перед открытием другой схемы, созданием новой или примером NetLab предлагает сохранить несохранённую.

### Кабели

Автоматически, консольный, медный прямой, медный перекрёстный, оптоволокно, Serial DCE/DTE, телефонный, коаксиальный, IoT. Меню порта показывает только подходящие порты. Неверный кабель или отсутствие `clock rate` на стороне DCE даёт красные индикаторы и подсказку с причиной. У Serial-канала сторона DCE помечена часами. Wi-Fi-связи рисуются пунктиром; радиус точки доступа виден при её выделении.

### Протоколы и функции

- Ethernet, ARP (очередь пакетов, proxy ARP), IPv4, ICMP, UDP, TCP (установка соединения, повторы, закрытие), HDLC/PPP на Serial.
- Прикладной уровень: HTTP, DNS, DHCP (сервер, клиент, relay), SMTP/POP3 с пересылкой между доменами через DNS, TFTP, Telnet, SSH.
- Коммутация: MAC-таблица, VLAN (access/trunk, 802.1Q, native, allowed), STP, port-security (sticky, maximum, shutdown/restrict/protect → err-disabled), SVI и `ip default-gateway`.
- Маршрутизация: подключённые и статические маршруты (через next-hop и через интерфейс, административная дистанция), RIP v1/v2, OSPF (область, стоимость, passive-interface, default-information originate, соседи и DR/BDR), маршрутизация между VLAN (router-on-a-stick и 3560).
- Безопасность и NAT: стандартные и расширенные ACL (номерные и именованные, счётчики совпадений), `access-class` на vty, статический и динамический NAT, PAT (`overload`), брандмауэр ПК.
- IOS: пароли `enable secret/password`, `service password-encryption` (type 7), пользователи, `banner motd`, линии console/vty (`login`, `login local`, `transport input`), RSA-ключи, CDP, часы, NVRAM (`copy run start`, `write`, `erase startup-config`, `reload`), TFTP (`copy running-config tftp:`), `show` почти для всего.
- Командная строка ПК: `ping`, `tracert`, `ipconfig`, `arp`, `nslookup`, `netstat`, `telnet`, `ssh -l`.
- Инструменты: инспектор (таблицы ARP, MAC, маршрутизации, NAT, DHCP, CDP, OSPF, сводка портов), фигуры и заметки, перезапуск всех устройств, ускорение времени.
- Два режима: «Реальное время» и «Симуляция». В симуляции видно, *почему* устройство поступило так, а не иначе; фильтры протоколов включают TCP, HTTP, SMTP, POP3, Telnet, SSH, TFTP.
- 38 готовых примеров: VLAN, STP, DHCP/DNS/веб, домашний Wi-Fi, NAT, ACL, OSPF, Serial PPP + RIP, консоль/Telnet/SSH, 3560, port-security, почта двух доменов, IPv6, SNMP и NetFlow, GRE, IPsec и Easy VPN, PPPoE, Dial-up, IP-телефония, Bluetooth, умный дом, плата MCU, IOx; новые в 1.3 — VTP, EtherChannel и PVST, HSRP, EIGRP и BGP, OSPFv3 и DHCPv6, ASA, WLC и LAP, DSL / кабель / 4G, сетевой контроллер, телефония двух офисов, Syslog / NTP / FTP и готовое задание с проверкой.

### Как в настоящем IOS

Конфигурация маршрутизатора и коммутатора хранится в running-config и пропадает при выключении питания или `reload`, если её не сохранить (`copy running-config startup-config` или кнопка «Сохранить» в NVRAM). Устройства с несохранёнными изменениями отмечены на схеме. Перед выключением NetLab предложит сохранить конфигурацию.

## Что сделано надёжнее, чем в Packet Tracer

| Частая жалоба на CPT | Как в NetLab |
|---|---|
| Письмо нескольким получателям уходит не всем или с ошибками | «Сообщения» доставляются каждому получателю отдельно, с подтверждением и 3 повторами. Почтовый сервер (SMTP) возвращает отчёт по каждому адресу: кому доставлено, кому нет и почему (нет пользователя, домен не найден, сервер недоступен). |
| Первый ping теряется из-за ARP | Пакеты ждут в очереди, пока выполняется ARP. |
| Неверно выбранный тип кабеля — и непонятно, что не так | Кабель «Автоматически» подбирает тип сам. Если кабель выбран вручную и не подходит, подсказка объясняет причину. |
| После подключения коммутатора связь «пропадает» на 30–50 секунд, пока сходится STP; RIP/OSPF сходятся долго | STP, RIP и OSPF пересчитываются мгновенно. |
| Непонятно, почему не работает | Подсказки в `ping`, проверка настроек: шлюз вне сети, адрес сети или широковещательный, пересечение подсетей, нет `clock rate`, разная инкапсуляция. Конфликты IP обнаруживаются и показываются на схеме. |
| Петля из коммутаторов или концентраторов «вешает» симуляцию | Защита от широковещательного шторма и ограничение числа прыжков кадра. |
| Отмена работает не для всех действий | Отмена и повтор (Ctrl+Z / Ctrl+Y) для любых изменений, включая команды CLI. |

## Клавиши

| Клавиша | Действие |
|---|---|
| `V` `I` `P` `M` `N` `G` `X` | выбор, инспектор, ping, сообщение, заметка, фигура, удаление |
| `C` | кабель «Автоматически» (другой тип — щелчок по кнопке «Кабель») |
| `1`–`9` | поставить ПК, ноутбук, сервер, 2960, 2911, хаб, точку доступа, WRT300N, 3560 |
| `Del` | удалить выделенное |
| `Ctrl+D` | дублировать |
| `Ctrl+A` | выделить всё |
| `Ctrl+Z` / `Ctrl+Y` | отменить / повторить |
| `Ctrl+S` / `Ctrl+Shift+S` | сохранить / сохранить как |
| `Ctrl+O` / `Ctrl+N` | открыть / новая схема |
| `F` | показать всю схему |
| `S` | переключить режим симуляции |
| `Пробел` / `→` | в симуляции: пуск/пауза, шаг |
| `Shift` + перетаскивание | выделение рамкой |
| В консоли IOS: `?`, `Tab`, `Ctrl+Z`, `Ctrl+C` | подсказка, дописать команду, выйти в привилегированный режим, прервать |

Масштаб меняется колесом мыши, схема прокручивается перетаскиванием фона.

## Сборка настольной версии

Нужен Node.js 18+.

```bash
npm install
```

Команды:

- `npm start` — запустить приложение без сборки (для разработки);
- `npm run dist` — собрать установщик и portable-версию в папку `dist/`;
- `npm run release` — собрать и опубликовать выпуск на GitHub (нужен `GH_TOKEN`, см. «Обновления»);
- `npm test` — автотесты ядра;
- `npm run smoke` — самопроверка приложения (см. «Тесты»).

Если интернет идёт через прокси, а Electron не скачивается (`fetch failed`), задайте переменную `NODE_USE_ENV_PROXY=1` — тогда Node использует `HTTPS_PROXY`:

```bash
NODE_USE_ENV_PROXY=1 node node_modules/electron/install.js
```

## Тесты

Ядро симулятора не зависит от браузера и покрыто автотестами (168 тестов):

```bash
npm test
```

- `tests/engine.test.js` — связность, маршрутизация, VLAN, STP, DHCP, DNS, «Сообщения», CLI, сохранение;
- `tests/features.test.js` — кабели и модули, Serial, Wi-Fi, WRT300N, TCP, HTTP, почта с несколькими получателями и двумя доменами, брандмауэр, генератор трафика, SVI и Telnet, SSH, 3560, port-security, ACL, NAT, RIP, OSPF, NVRAM, пароли, CDP, TFTP, `?` и Tab, совпадение running-config после повторного применения;
- `tests/examples.test.js`, `tests/examples-ext.test.js`, `tests/examples-13.test.js` — каждый пример собирается, конфигурация сохранена, и в нём работает то, что обещано в описании;
- `tests/ipv6.test.js`, `tests/snmp-netflow.test.js`, `tests/vpn-pppoe.test.js`, `tests/voip.test.js`, `tests/bluetooth.test.js`, `tests/iot.test.js`, `tests/iox.test.js` — новые подсистемы: IPv6 и SLAAC, SNMP и NetFlow, GRE, IPsec, Easy VPN, PPPoE, Dial-up, CME и IP-телефоны, PoE и voice VLAN, Bluetooth, IoT-сервер и правила, программы плат, IOx;
- `tests/mgmt.test.js`, `tests/l2.test.js`, `tests/fhrp.test.js`, `tests/routing2.test.js`, `tests/routing6.test.js`, `tests/security.test.js`, `tests/wireless.test.js`, `tests/wan.test.js`, `tests/pdu.test.js`, `tests/netctrl.test.js`, `tests/multiuser.test.js`, `tests/voip2.test.js`, `tests/activity.test.js` — подсистемы 1.3: Syslog / NTP / FTP / debug, PVST, DTP, VTP, EtherChannel, HSRP / VRRP / GLBP, EIGRP, BGP и редистрибуция, OSPFv3 / RIPng / DHCPv6, AAA, DHCP snooping, DAI, 802.1X, ZBF, ASA, WLC и LAP, модемы и вышка, новые модели, сложный PDU и физические расстояния, REST API контроллера, многопользовательский режим, удержание / перевод / dial-peer, задания с проверкой; фазы IKE — в `tests/vpn-pppoe.test.js`, правила IoT с «И» / «ИЛИ» и расписанием, Python и блоки — в `tests/iot.test.js`.

Самопроверка настольной версии запускает Electron и проверяет в реальном окне загрузку примера, ping, запуск программы платы в отдельном потоке (без доступа к сети), сохранение и открытие файла:

```bash
npm run smoke
```

Ту же проверку можно запустить на собранной программе: `node tests/smoke.js dist/win-unpacked/NetLab.exe`.

Обновление проверяется без GitHub: соберите версию с большим номером в отдельную папку, например `npx electron-builder --win nsis --publish never -c.extraMetadata.version=9.9.9 -c.directories.output=upd-test`, и запустите:

```bash
node tests/smoke-update.js dist/win-unpacked/NetLab.exe upd-test
```

Скрипт поднимает локальный сервер с новой версией и проверяет, что программа показала предложение обновиться, скачала установщик и предложила «Перезапустить и установить». Чтобы проверить настоящие GitHub Releases, соберите версию с номером меньше опубликованного (с установщиком, `--win nsis`: только такая сборка содержит `app-update.yml`) и укажите вместо папки `github`: `node tests/smoke-update.js путь\к\NetLab.exe github`. Сама установка не запускается; снимки окна сохраняются в `dist/update-offer.png` и `dist/update.png`.

## Структура

```
electron/             настольная оболочка: окно, меню, диалоги файлов (main.js, preload.js), обновления (updater.js), многопользовательский режим (multiuser.js)
build/                иконка приложения
index.html            страница приложения
css/app.css           оформление (тёмная и светлая темы)
js/core/              ядро симулятора, без DOM
  util.js             IP, маски, wildcard, MAC, часы, type 7, очередь событий
  packets.js          форматы PDU (Ethernet, ARP, IP, ICMP, UDP, TCP, HDLC) и их описание
  models.js           каталог моделей устройств и модулей
  network.js          сеть, кабели и их проверка, Wi-Fi, движок событий, сохранение
  stp.js              Spanning Tree
  devices-l2.js       базовое устройство, концентратор, точка доступа
  l3.js               IP-стек: ARP, IPv4, ICMP, UDP, маршрутизация, DHCP-клиент
  tcp.js              TCP
  acl.js, nat.js      списки доступа и NAT
  ios.js              общая часть Cisco IOS: пароли, линии, NVRAM, CDP
  switch.js           коммутаторы 2960/3560
  services.js         серверы DHCP, DNS, HTTP, SMTP/POP3, TFTP
  host.js             ПК, ноутбук, сервер, принтер, планшет
  router.js           маршрутизатор: подынтерфейсы, Serial, loopback, relay
  wireless.js         WRT300N
  routing.js          RIP и OSPF
  apps.js             ping, traceroute, DNS-резолвер, браузер, почтовый клиент, Telnet/SSH, TFTP, генератор трафика
  cli-host.js         командная строка ПК
  cli-ios.js          Cisco IOS
  cli.js              общий вход в командную строку
  ext.js              сохранение настроек новых подсистем вместе с конфигурацией устройства
  ipv6.js             IPv6: ND, RA/SLAAC, маршрутизация, ICMPv6
  snmp.js, netflow.js SNMP-агент и клиент, учёт и экспорт потоков, коллектор
  vpn.js, pppoe.js    GRE, IPsec, Easy VPN; PPPoE-сервер и клиент
  dialup.js           модем, телефонная сеть Cloud-PT, Dial-up
  voip.js             CME, SCCP, RTP, IP-телефон 7960, PoE, voice VLAN, IP Communicator
  bluetooth.js        Bluetooth: сопряжение, A2DP, OBEX
  iot.js              умные устройства, IoT-сервер, Home Gateway, платы и компоненты
  script-rt.js        среда выполнения программ плат (setup/loop, пины, delay)
  iox.js              IOx: app-hosting, IOx Local Manager
  mgmt.js             журнал IOS, Syslog, NTP, FTP, debug
  l2ext.js            PVST / Rapid PVST, PortFast, BPDU Guard, DTP, VTP, EtherChannel
  fhrp.js             HSRP, VRRP, GLBP
  routing2.js         EIGRP, BGP, редистрибуция, межзональные и внешние маршруты OSPF
  routing2-cli.js     команды IOS для EIGRP, BGP и редистрибуции
  routing6.js         OSPFv3, RIPng, DHCPv6
  voip2.js            удержание и перевод вызова, dial-peer и H.323 между CME
  aaa.js              AAA: RADIUS, TACACS+, списки методов входа
  l2sec.js            DHCP snooping, Dynamic ARP Inspection, 802.1X
  zbf.js, asa.js      Zone-Based Firewall; межсетевой экран ASA 5506-X и его CLI
  wlc.js              контроллер WLC 2504, точки LAP, CAPWAP, WPA2-Enterprise
  wan.js              облако провайдера (DSL, коаксиал), модемы, вышка 3G/4G, модели 1841 / 4331 / 3650, HWIC-4ESW
  pdu.js, physical.js сложный PDU и сценарии; физические расстояния
  netctrl.js          сетевой контроллер и REST API
  multiuser.js        облако Multiuser-PT
  activity.js         задания: пункты оценки, проверка, проверки связи
js/ui/                интерфейс
  script-worker.js    отдельный поток для программ плат (без сети)
  dw-*.js             вкладки окна устройства (физический вид, настройка, рабочий стол, службы, атрибуты)
  device-windows.js   сборка окна устройства
  inspect.js          инспектор таблиц
  workspace.js        схема, инструменты, кабели
  terminal.js         терминал (CLI, Command Prompt, Terminal)
  updates.js          окно обновлений (предложение, загрузка, установка)
  pdu-complex.js      окно «Сложный PDU» и панель сценариев
  multiuser.js        окно многопользовательского режима
  activity.js         мастер заданий, панель задания, результат проверки
  examples*.js        готовые примеры
tests/                автотесты ядра, примеров и самопроверка настольной версии (smoke.js)
```

## Чего нет (пока)

Спутниковая связь, IS-IS, MPLS, SIP-телефония и CUCM, VPN на ASA (AnyConnect), файлы заданий Packet Tracer (`.pka`) в NetLab не реализованы — задания NetLab делаются своим мастером и хранятся в `.netlab`.

Упрощено: SCCP и H.323 передают только события регистрации и вызова; RTP-«голос» — это текстовые реплики; приложения IOx — статические веб-сайты; Python на платах — учебное подмножество языка; в заданиях устройства сравниваются по имени, а конфигурация — по строкам running-config.
