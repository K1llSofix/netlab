/* NetLab — диагностика сети:
 *  • explain(net, srcId, target) — «Почему не работает?»: ping в копии сети, путь пакета по журналу,
 *    место и причина потери, объяснение и исправление; разбор ARP-сбоев по пути второго уровня (VLAN, транки, порты);
 *  • audit(net) — проверка всей схемы на типичные ошибки настройки (адреса, шлюзы, кабели, VLAN, маршруты). */
(function (NS) {
  'use strict';

  const U = NS.util;
  const ip = (x) => U.ipStr(x);
  const cidr = (f) => U.cidr(U.net(f.ip, f.mask), f.mask);

  // обычные отбрасывания, не относящиеся к неисправности
  const NOISE = /не для меня|адресован другому устройству|за тем же портом|не маршрутизируются|никто не ждёт|Solicitation|заблокирован STP/;

  const isHost = (d) => !!d && !!d.iface && typeof d.setStatic === 'function' && !d.ios;
  const isL2 = (d) => ['switch', 'hub', 'repeater', 'bridge'].includes(d.type);
  const dp = (d, i) => (d.dataPort ? d.dataPort(i) : d.ports[i]);

  /** Выполнить fn без отправки кадров в другие копии NetLab (совместная работа). */
  function guard(fn) {
    const mu = NS.multiuser;
    const saved = mu ? mu.transport : null;
    if (mu) mu.transport = null;
    try { return fn(); } finally { if (mu) mu.transport = saved; }
  }

  function copyOf(net) {
    const c = NS.Network.deserialize(JSON.parse(JSON.stringify(net.serialize())));
    c.runUntilIdle(6000);
    return c;
  }

  function ownerOf(net, addr) {
    for (const d of net.devices.values()) {
      const f = (d.ifaces || []).find((x) => x.ip === addr);
      if (f) return { dev: d, f };
    }
    return null;
  }

  function devIp(d) {
    if (isHost(d)) return d.iface.ip;
    const f = (d.ifaces || []).find((x) => x.ip != null && x.kind !== 'loop' && d.ifaceUp && d.ifaceUp(x)) || (d.ifaces || []).find((x) => x.ip != null);
    return f ? f.ip : null;
  }

  function resolveTarget(net, t) {
    const a = U.parseIp(t);
    if (a != null) return { ip: a };
    const d = net.findByName(t);
    if (d) return { ip: devIp(d), dev: d };
    return { ip: null };
  }

  /** Почему порт не работает — по-человечески. */
  function adminDown(d, i) {
    const p = d.ports[i];
    if (!p) return null;
    if (p.errDisabled) return d.name + ' ' + p.name + ' в состоянии err-disabled' + (p.errReason ? ' (' + p.errReason + ')' : '');
    if (p.adminUp === false) return d.name + ' ' + p.name + ' выключен (shutdown)';
    const f = (d.ifaces || []).find((x) => x.port === i && (x.kind === 'phys' || x.kind === 'routed'));
    if (f && !f.adminUp) return d.name + ' ' + f.name + ' выключен (shutdown)';
    return null;
  }
  function portWhy(net, d, i) {
    const p = d.ports[i];
    if (!p) return 'нет такого порта';
    if (p.radio) return 'нет беспроводного подключения (SSID, пароль, расстояние)';
    if (!p.link) return 'к порту ' + p.name + ' не подключён кабель';
    const l = net.links.get(p.link);
    const issue = l && net.linkIssue(l);
    if (issue) return issue;
    const pr = net.peer(d, i);
    if (!pr) return 'кабель никуда не ведёт';
    if (!pr.dev.power) return pr.dev.name + ' выключено';
    return adminDown(d, i) || adminDown(pr.dev, pr.port) || 'порт не активен';
  }
  function portFix(why) {
    if (/shutdown/.test(why)) return 'Включите интерфейс: interface … → no shutdown.';
    if (/err-disabled/.test(why)) return 'Устраните причину и перезапустите порт: shutdown, затем no shutdown.';
    if (/тип кабеля/.test(why)) return 'Замените кабель (для однотипных устройств — перекрёстный, для разнотипных — прямой).';
    if (/clock rate/.test(why)) return 'На стороне DCE: interface … → clock rate 64000.';
    if (/инкапсуляция/.test(why)) return 'Задайте одинаковую инкапсуляцию на обоих концах: encapsulation ppp (или hdlc).';
    if (/выключено/.test(why)) return 'Включите питание устройства (вкладка «Физический вид»).';
    if (/не подключён кабель/.test(why)) return 'Подключите кабель.';
    return 'Проверьте кабель, питание и shutdown на обоих концах.';
  }

  const FIXES = [
    [/^Нет маршрута до (\S+)/, (m, d) => (isHost(d) ? 'Укажите шлюз по умолчанию — адрес маршрутизатора в своей сети.' : 'На ' + d.name + ' добавьте маршрут в сеть получателя (ip route СЕТЬ МАСКА СЛЕДУЮЩИЙ-ХОП) или настройте OSPF/EIGRP/RIP и объявите эту сеть на всех маршрутизаторах. Проверка: show ip route.')],
    [/списком доступа (IPv6 )?(\S+)/, (m, d) => 'На ' + d.name + ' проверьте список доступа ' + m[2] + ' (show access-lists): разрешите этот трафик строкой permit выше запрещающей или снимите список с интерфейса (no ip access-group).'],
    [/^Интерфейс (\S+) выключен/, (m) => 'interface ' + m[1] + ' → no shutdown'],
    [/^Порт (\S+) не активен/, () => 'Проверьте кабель и питание; на обоих концах — no shutdown.'],
    [/^VLAN (\d+) не разрешён на транке (\S+)/, (m) => 'interface ' + m[2] + ' → switchport trunk allowed vlan add ' + m[1] + ' (на обоих концах транка).'],
    [/^VLAN (\d+) не создан/, (m) => 'Создайте VLAN: vlan ' + m[1] + '.'],
    [/тегом 802\.1Q.*access-порт/, () => 'На одном конце транк, на другом access. Сделайте оба конца транком: switchport mode trunk.'],
    [/^Нет подынтерфейса для VLAN (\d+) на (\S+)/, (m) => 'interface ' + m[2] + '.' + m[1] + ' → encapsulation dot1Q ' + m[1] + ' и ip address … — или проверьте VLAN на транке коммутатора.'],
    [/^Port-security/, () => 'Проверьте switchport port-security maximum / mac-address; порт в err-disabled поднимается через shutdown и no shutdown.'],
    [/802\.1X|EAPOL/, () => 'Проверьте 802.1X на компьютере и коммутаторе и доступность RADIUS-сервера.'],
    [/^DHCP snooping/, () => 'На порту к настоящему DHCP-серверу нужна команда ip dhcp snooping trust.'],
    [/^DAI/, () => 'Для узлов со статическим адресом: ip arp inspection trust на порту или ARP ACL.'],
    [/TTL истёк|Hop Limit/, () => 'Петля маршрутизации: маршрутизаторы пересылают пакет друг другу. Проверьте следующий хоп статических маршрутов на пути.'],
    [/^NAT/, () => 'Проверьте пул NAT (ip nat pool) и ip nat inside / outside на интерфейсах.'],
    [/^ASA/, () => 'Проверьте nameif, security-level, маршруты и access-group на ASA.'],
    [/IPS|CBAC|Zone-Based|зон/i, () => 'Трафик остановила политика безопасности (IPS или зонный межсетевой экран) — проверьте её правила.'],
    [/брандмауэр|firewall/i, () => 'Разрешите этот трафик в брандмауэре узла (Рабочий стол → Firewall).'],
    [/iptables/, (m, d) => 'На ' + (d.name || 'узле') + ' проверьте iptables (iptables -L -n --line-numbers): добавьте разрешающее правило выше запрета (iptables -I INPUT 1 …) или смените политику (iptables -P INPUT ACCEPT).'],
    [/петля/, () => 'Уберите петлю из концентраторов или включите STP на коммутаторах.'],
    [/в состоянии STP (listening|learning)/, () => 'Это обычная задержка STP (реалистичные таймеры): подождите до 30 с. Для портов к компьютерам включите spanning-tree portfast — они начнут работать сразу.'],
  ];
  function fixFor(reason, d) {
    for (const [re, fn] of FIXES) {
      const m = re.exec(reason);
      if (m) return fn(m, d || {});
    }
    return '';
  }

  /* ================= путь второго уровня ================= */

  /** Кратчайший путь по кабелям от порта устройства a до b через коммутаторы и концентраторы. */
  function l2Route(net, a, startPort, b) {
    const prev = new Map([[a.id, null]]);
    const queue = [{ dev: a, inPort: null }];
    while (queue.length) {
      const { dev, inPort } = queue.shift();
      const ports = dev === a ? [startPort] : dev.ports.map((p, i) => i).filter((i) => i !== inPort && !dev.ports[i].routed);
      for (const i of ports) {
        const pr = net.peer(dev, i);
        if (!pr || prev.has(pr.dev.id)) continue;
        prev.set(pr.dev.id, { dev, out: i, in: pr.port, to: pr.dev });
        if (pr.dev === b) {
          const hops = [];
          for (let h = prev.get(b.id); h; h = prev.get(h.dev.id)) hops.unshift(h);
          return hops; // [{dev, out, in, to}] — по кабелям от a до b
        }
        if (isL2(pr.dev) && !pr.dev.ports[pr.port].routed) queue.push({ dev: pr.dev, inPort: pr.port });
      }
    }
    return null;
  }

  /** Проблемы на пути второго уровня между интерфейсом fa устройства a и интерфейсом fb устройства b. */
  function l2Problems(net, a, fa, b, fb) {
    const out = [];
    const add = (dev, text, fix) => { if (!out.some((x) => x.text === text)) out.push({ dev, text, fix }); };
    const hops = l2Route(net, a, fa.port, b);
    if (!hops) {
      add(a, a.name + ' и ' + b.name + ' в одной IP-сети (' + cidr(fa) + '), но между ними нет пути по кабелям через коммутаторы — они в разных сегментах',
        'Устройства по разные стороны маршрутизатора должны быть в разных IP-сетях; проверьте адреса и маски или подключение кабелей.');
      return out;
    }
    let tag = fa.kind === 'sub' ? fa.vlan : null;
    let vlan = null;
    for (let k = 0; k < hops.length; k++) {
      const h = hops[k];
      if (!net.isPortOperational(h.dev, h.out)) { const why = portWhy(net, h.dev, h.out); add(h.dev, h.dev.name + ' ' + h.dev.ports[h.out].name + ' → ' + h.to.name + ': ' + why, portFix(why)); return out; }
      if (!net.isPortOperational(h.to, h.in)) { const why = portWhy(net, h.to, h.in); add(h.to, h.to.name + ' ' + h.to.ports[h.in].name + ': ' + why, portFix(why)); return out; }
      const sw = h.to;
      if (sw === b || sw.type !== 'switch') continue;
      const next = hops[k + 1];
      const pi = dp(sw, h.in);
      const po = dp(sw, next.out);
      if (pi.mode === 'trunk') {
        vlan = tag != null ? tag : pi.nativeVlan;
        if (!U.vlanInList(pi.allowed, vlan)) add(sw, sw.name + ': VLAN ' + vlan + ' не разрешён на транке ' + pi.name, 'interface ' + pi.name + ' → switchport trunk allowed vlan add ' + vlan);
      } else {
        if (tag != null && tag !== pi.voiceVlan) add(sw, sw.name + ': порт ' + pi.name + ' в режиме access, а от ' + h.dev.name + ' приходят кадры с тегом VLAN ' + tag, 'Сделайте порт транком: interface ' + pi.name + ' → switchport mode trunk');
        vlan = pi.vlan;
      }
      if (sw.vlans && !sw.vlans.has(vlan)) add(sw, sw.name + ': VLAN ' + vlan + ' не создан', 'vlan ' + vlan);
      if (po.mode === 'trunk') {
        if (!U.vlanInList(po.allowed, vlan)) add(sw, sw.name + ': VLAN ' + vlan + ' не разрешён на транке ' + po.name + ' (к ' + next.to.name + ')', 'interface ' + po.name + ' → switchport trunk allowed vlan add ' + vlan);
        tag = vlan === po.nativeVlan ? null : vlan;
      } else {
        if (po.vlan !== vlan) {
          add(sw, sw.name + ': порт ' + po.name + ' (к ' + next.to.name + ') в VLAN ' + po.vlan + ', а кадры от ' + a.name + ' идут в VLAN ' + vlan + ' — это разные широковещательные домены',
            'Поместите оба порта в один VLAN: interface ' + po.name + ' → switchport access vlan ' + vlan + ' (или наоборот)');
        }
        tag = null;
      }
    }
    if (fb.kind === 'sub') {
      if (tag !== fb.vlan) add(b, b.name + ': подынтерфейс ' + fb.name + ' ждёт кадры VLAN ' + fb.vlan + ', а приходят ' + (tag == null ? 'кадры без тега (native VLAN)' : 'кадры VLAN ' + tag), 'Проверьте encapsulation dot1Q на ' + fb.name + ' и транк на коммутаторе');
    } else if (tag != null && b.type !== 'switch') {
      add(b, 'К ' + b.name + ' приходят кадры с тегом VLAN ' + tag + ' — на порту коммутатора к нему транк', 'Для конечного узла порт коммутатора должен быть в режиме access: switchport mode access');
    }
    return out;
  }

  /** ARP-запрос устройства req о адресе x остался без ответа — почему. */
  function arpWhy(c, req, x, arpTx, add) {
    const o = ownerOf(c, x);
    if (!o) {
      add('err', req, req.name + ': на ARP-запрос о ' + ip(x) + ' никто не ответил — этот адрес не назначен ни одному устройству',
        isHost(req) ? 'Проверьте адрес назначения и шлюз по умолчанию на ' + req.name + '.' : 'Проверьте следующий хоп в маршрутах ' + req.name + ' (show ip route) и адреса соседних устройств.');
      return;
    }
    const od = o.dev;
    if (!od.power) { add('err', od, od.name + ' выключено', 'Включите питание (вкладка «Физический вид»).'); return; }
    if (!o.f.adminUp) { add('err', od, 'Интерфейс ' + o.f.name + ' на ' + od.name + ' выключен (shutdown)', 'interface ' + o.f.name + ' → no shutdown'); return; }
    if (o.f.port != null && o.f.kind !== 'loop' && o.f.kind !== 'svi' && !c.isPortOperational(od, o.f.port)) {
      const why = portWhy(c, od, o.f.port);
      add('err', od, od.name + ' ' + o.f.name + ' не активен: ' + why, portFix(why));
      return;
    }
    const reached = new Set(arpTx.filter((e) => e.frame.payload && e.frame.payload.targetIp === x && e.frame.payload.op === 'request').map((e) => e.to));
    if (reached.has(od.id)) {
      add('err', od, 'ARP-запрос от ' + req.name + ' дошёл до ' + od.name + ', но ответ не вернулся',
        'Проверьте адрес и маску ' + od.name + ' ' + o.f.name + ' (' + cidr(o.f) + ') — ' + req.name + ' должен быть с ним в одной сети.');
      return;
    }
    const rf = (req.ifaces || []).find((f) => f.ip != null && f.mask != null && U.sameNet(f.ip, x, f.mask));
    if (!rf || rf.port == null) { add('err', req, req.name + ': ARP-запрос о ' + ip(x) + ' без ответа', 'Проверьте адреса и маски.'); return; }
    if (o.f.kind === 'svi') {
      // адрес на SVI коммутатора: достаточно проверить порт отправителя
      add('err', req, 'ARP-запрос от ' + req.name + ' не дошёл до ' + od.name + ' (интерфейс ' + o.f.name + ')', 'Проверьте, что порт к ' + req.name + ' в том же VLAN, что и ' + o.f.name + ', и что VLAN создан.');
      return;
    }
    const probs = l2Problems(c, req, rf, od, o.f);
    if (probs.length) { for (const p of probs.slice(0, 3)) add('err', p.dev, p.text, p.fix); return; }
    const names = [...reached].map((id) => c.getDevice(id)).filter(Boolean).map((d) => d.name);
    add('err', req, 'Широковещательный ARP-запрос от ' + req.name + ' о ' + ip(x) + ' не дошёл до ' + od.name + (names.length ? ' (его получили: ' + names.slice(0, 6).join(', ') + ')' : ''),
      'Проверьте кабели, VLAN и транки между ' + req.name + ' и ' + od.name + '.');
  }

  const SEND_ERR = {
    'no-ip': (d) => [d.name + (d.iface && d.iface.dhcp ? ': DHCP не выдал IP-адрес' : ': не задан IP-адрес'), d.iface && d.iface.dhcp ? 'Проверьте DHCP-сервер (включён ли, пул, шлюз) и ip helper-address на маршрутизаторе, если сервер в другой сети.' : 'Задайте адрес и маску (IP Configuration).'],
    'no-route': (d, dst) => (isHost(d)
      ? [d.name + ': не задан шлюз по умолчанию — пакеты в другую сеть (' + ip(dst) + ') отправлять некуда', 'Укажите шлюз — адрес интерфейса маршрутизатора в сети ' + (d.iface.ip != null ? cidr(d.iface) : 'компьютера') + '.']
      : [d.name + ': нет маршрута до ' + ip(dst), fixFor('Нет маршрута до', d)]),
    off: (d) => [d.name + ' выключено', 'Включите питание.'],
    iptables: (d) => [d.name + ': исходящий пакет запрещён iptables (цепочка OUTPUT)', fixFor('iptables', d).replace(/INPUT/g, 'OUTPUT')],
  };

  /** У маршрутизатора нет маршрута до dst: есть ли настроенный, но неактивный маршрут, и почему. */
  function noRouteWhy(c, d, dst, add) {
    if (!d || !d.routes) return false;
    let found = false;
    for (const r of d.routes) {
      if (U.net(dst, r.mask) !== r.net) continue;
      const route = 'ip route ' + ip(r.net) + ' ' + ip(r.mask) + ' ' + (r.nextHop != null ? ip(r.nextHop) : r.ifName);
      if (r.ifName) {
        const f = d.ifaceByName(r.ifName);
        const why = f && f.port != null ? portWhy(c, d, f.port) : 'интерфейса нет';
        add('err', d, d.name + ': маршрут «' + route + '» неактивен — интерфейс ' + r.ifName + ' не работает: ' + why, portFix(why));
      } else {
        const f = d.ifaces.find((x) => x.ip != null && x.mask != null && U.sameNet(r.nextHop, x.ip, x.mask));
        if (f && !d.ifaceUp(f)) {
          const why = f.port != null ? portWhy(c, d, f.port) : 'интерфейс не активен';
          add('err', d, d.name + ': маршрут «' + route + '» неактивен — интерфейс ' + f.name + ' к следующему хопу не работает: ' + why, portFix(why));
        } else if (!f) {
          add('err', d, d.name + ': маршрут «' + route + '» неактивен — следующий хоп ' + ip(r.nextHop) + ' не в подключённой сети', 'Следующий хоп — адрес соседнего маршрутизатора в общей с ' + d.name + ' сети; проверьте адрес.');
        } else continue;
      }
      found = true;
    }
    return found;
  }

  /** Реалистичные таймеры: что в живой сети ещё не сошлось (копия для проверки уже прогрета). */
  function transient(net, add) {
    const stp = [];
    let left = 0;
    for (const d of net.devices.values()) {
      for (const p of d.ports || []) {
        if (!p.stpPhase) continue;
        stp.push(d.name + ' ' + (NS.cliIos && NS.cliIos.ctx ? NS.cliIos.ctx.shortIf(p.name) : p.name) + ' (' + p.stpPhase + ')');
        left = Math.max(left, (p.stpPhase === 'listening' ? 1500 : d.stpMode === 'rapid-pvst' ? 300 : 3000) - (net.time - (p.stpSince || 0)));
      }
    }
    if (stp.length) add('warn', null, 'Идёт сходимость STP: ' + stp.slice(0, 6).join(', ') + (stp.length > 6 ? ' и ещё ' + (stp.length - 6) : '') + ' — пока не пересылают кадры (ещё ≈' + Math.max(1, Math.ceil(left / 100)) + ' с). Результат проверки выше — после сходимости.', 'Подождите или включите spanning-tree portfast на портах к компьютерам.');
    const rt = [...net.devices.values()].filter((d) => d.dynPend).map((d) => d.name);
    if (rt.length) add('warn', null, 'Маршрутизация ещё сходится на ' + rt.join(', ') + ' — новые маршруты появятся через несколько секунд', 'Подождите (реалистичные таймеры) и проверьте show ip route.');
  }

  /* ================= «Почему не работает?» ================= */

  /**
   * Отправить ping от srcId к target (адрес, имя устройства или DNS-имя) в копии сети и объяснить результат.
   * → { ok, src, target, ip, sent, received, path:[имена], back:[имена], links:[id кабелей], issues:[{sev, dev, id, text, fix}], steps:[{dev, text}] }
   */
  function explain(net, srcId, target) {
    const src = net.getDevice(srcId);
    const res = { ok: false, src: src ? src.name : '?', target: String(target == null ? '' : target).trim(), ip: null, sent: 0, received: 0, path: [], back: [], links: [], issues: [], steps: [] };
    const add = (sev, dev, text, fix) => {
      if (res.issues.some((x) => x.text === text)) return;
      res.issues.push({ sev, dev: dev ? dev.name : null, id: dev ? dev.id : null, text, fix: fix || '' });
    };
    if (!src || typeof src.ping !== 'function') { add('err', src, 'С этого устройства нельзя отправить ping'); return res; }
    if (!res.target) { add('err', null, 'Укажите получателя: IP-адрес или имя устройства'); return res; }
    if (!src.power) { add('err', src, src.name + ' выключено', 'Включите питание (вкладка «Физический вид»).'); return res; }
    const tgt = resolveTarget(net, res.target);
    if (tgt.dev && tgt.ip == null) { add('err', tgt.dev, 'У ' + tgt.dev.name + ' нет IP-адреса', 'Задайте адрес устройству.'); return res; }
    guard(() => {
      const c = copyOf(net);
      c.recording = true;
      c.logLimit = 200000;
      c.log = [];
      const s = c.getDevice(src.id);
      const id = s.nextIcmpId;
      let done = null;
      const evs = [];
      s.ping(tgt.ip != null ? ip(tgt.ip) : res.target, { count: 2, onEvent: (e) => { evs.push(e); if (e.type === 'done') done = e; } });
      c.runUntilIdle(20000);
      analyze(c, s, id, done, evs, res, add);
    });
    res.ok = res.received > 0;
    if (res.ok) res.issues = res.issues.filter((x) => x.sev !== 'err');
    transient(net, add);
    return res;
  }

  function analyze(c, s, id, done, evs, res, add) {
    const rf = evs.find((e) => e.type === 'resolve-fail');
    if (rf) {
      add('err', s, 'Имя «' + res.target + '» не удалось преобразовать в адрес' + (rf.text ? ': ' + rf.text : ''), 'Проверьте адрес DNS-сервера на ' + s.name + ', доступность сервера и запись A на нём.');
      return;
    }
    res.sent = done ? done.sent : 0;
    res.received = done ? done.received : 0;
    const dst = done && done.ip != null ? done.ip : null;
    res.ip = dst != null ? ip(dst) : null;
    const owner = dst != null ? ownerOf(c, dst) : null;
    const name = (dId) => { const d = c.getDevice(dId); return d ? d.name : '?'; };

    const req = [];
    const rep = [];
    const drops = [];
    const arpNotes = [];
    const arpTx = [];
    for (const e of c.log) {
      const f = e.frame;
      const pk = f && f.type === 'IPv4' ? f.payload : null;
      const m = pk && pk.proto === 'ICMP' ? pk.payload : null;
      const mine = !!m && (m.type === 'echo-request' || m.type === 'echo-reply') && (m.id === id || (dst != null && (pk.dst === dst || pk.src === dst)));
      if (e.type === 'tx') {
        if (mine) (m.type === 'echo-request' ? req : rep).push(e);
        else if (f && f.type === 'ARP') arpTx.push(e);
      } else if (e.type === 'drop') {
        if (!f) { if (/^ARP: нет ответа от/.test(e.reason)) arpNotes.push(e); else if (/^IPv6 ND/.test(e.reason)) arpNotes.push(e); } else if (NOISE.test(e.reason)) continue;
        else if (mine || f.type === 'ARP') drops.push(e);
      }
    }

    // путь запроса (первый эхо-запрос) и ответа
    const seq0 = req.length ? req[0].frame.payload.payload.seq : null;
    const hopsOf = (list, start) => {
      const names = start ? [start] : [];
      const links = [];
      for (const e of list) {
        if (seq0 != null && e.frame.payload.payload.seq !== seq0) continue;
        if (!names.length) names.push(name(e.from));
        if (names[names.length - 1] !== name(e.to)) names.push(name(e.to));
        if (!links.includes(e.link)) links.push(e.link);
      }
      return { names, links };
    };
    const a = hopsOf(req, s.name);
    const b = hopsOf(rep, null);
    res.path = a.names;
    res.back = b.names;
    res.links = [...new Set(a.links.concat(b.links))];
    for (const e of req) if (seq0 == null || e.frame.payload.payload.seq === seq0) res.steps.push({ dev: name(e.from), text: '→ ' + name(e.to) + (e.why ? ': ' + e.why : '') });
    for (const e of rep) if (seq0 == null || e.frame.payload.payload.seq === seq0) res.steps.push({ dev: name(e.from), text: '← ' + name(e.to) + (e.why ? ': ' + e.why : '') });

    if (res.received > 0) {
      if (res.received < res.sent) add('info', s, 'Часть запросов потеряна (' + (res.sent - res.received) + ' из ' + res.sent + ')', 'Первый запрос может потеряться, пока идёт ARP, — это нормально.');
      return;
    }

    // 1) ошибка отправки у самого источника
    const se = evs.find((e) => e.type === 'error');
    if (se) {
      if (se.code === 'arp-fail') {
        const r = dst != null ? s.lookup(dst) : null;
        arpWhy(c, s, r && r.nextHop != null ? r.nextHop : dst, arpTx, add);
      } else if (se.code === 'down') {
        const r = dst != null ? s.lookup(dst) : null;
        const f = r ? r.ifc : s.iface;
        const why = f && f.port != null ? portWhy(c, s, f.port) : 'интерфейс не активен';
        add('err', s, s.name + (f ? ' ' + f.name : '') + ' не активен: ' + why, portFix(why));
      } else if (se.code === 'no-route' && !isHost(s) && dst != null && noRouteWhy(c, s, dst, add)) {
        // объяснено: настроенный маршрут неактивен
      } else if (SEND_ERR[se.code]) {
        const [t, fx] = SEND_ERR[se.code](s, dst);
        add('err', s, t, fx);
      } else add('err', s, s.name + ': ' + (se.text || se.code));
    }
    // 2) отброшенные пакеты (запрос, ответ, связанный ARP)
    for (const e of drops) {
      const d = c.getDevice(e.dev);
      const nr = /^Нет маршрута до (\S+)/.exec(e.reason);
      if (nr && noRouteWhy(c, d, U.parseIp(nr[1]), add)) continue;
      add('err', d, (d ? d.name + ': ' : '') + e.reason, fixFor(e.reason, d));
    }
    // 3) ARP без ответа на пути
    for (const e of arpNotes) {
      const d = c.getDevice(e.dev);
      const m = /(\d+\.\d+\.\d+\.\d+)/.exec(e.reason);
      if (d && m) arpWhy(c, d, U.parseIp(m[1]), arpTx, add);
      else if (d) add('err', d, d.name + ': ' + e.reason);
    }
    // 4) запрос дошёл, ответа нет
    const reached = !!owner && (owner.dev === s || req.some((e) => e.to === owner.dev.id));
    const replied = !!owner && rep.some((e) => e.from === owner.dev.id);
    if (owner && reached && !replied && !res.issues.some((x) => x.sev === 'err')) {
      const od = owner.dev;
      const srcIp = req.length ? req[0].frame.payload.src : null;
      if (isHost(od) && srcIp != null && od.iface.ip != null && !U.sameNet(srcIp, od.iface.ip, od.iface.mask) && od.gateway == null) {
        add('err', od, 'Запрос дошёл до ' + od.name + ', но у него не задан шлюз по умолчанию — ответ в сеть ' + ip(srcIp) + ' отправить некуда', 'Укажите шлюз на ' + od.name + ' — адрес маршрутизатора в сети ' + cidr(od.iface) + '.');
      } else if (!isHost(od) && srcIp != null && !od.lookup(srcIp)) {
        add('err', od, 'Запрос дошёл до ' + od.name + ', но у него нет маршрута обратно в сеть ' + ip(srcIp), fixFor('Нет маршрута до', od));
      } else {
        add('err', od, 'Эхо-запрос дошёл до ' + od.name + ', но ответа нет', 'Проверьте брандмауэр ' + od.name + ', его шлюз по умолчанию и маршрут обратно к ' + s.name + '.');
      }
    }
    if (dst != null && !owner && !res.issues.length) add('err', s, 'Адрес ' + ip(dst) + ' не назначен ни одному устройству схемы', 'Проверьте адрес получателя.');
    if (!res.issues.some((x) => x.sev === 'err')) {
      const last = res.path[res.path.length - 1];
      add('err', null, 'Ответа нет' + (res.path.length > 1 ? '; запрос дошёл до ' + last : ''), 'Откройте режим «Симуляция» и отправьте пакет, чтобы увидеть, где он теряется.');
    }
  }

  /* ================= аудит схемы ================= */

  /** Типичные ошибки настройки во всей схеме. → [{sev: 'err'|'warn'|'info', dev, id, text, fix}] */
  function audit(net) {
    const out = [];
    const add = (sev, dev, text, fix) => { if (!out.some((x) => x.text === text)) out.push({ sev, dev: dev ? dev.name : null, id: dev ? dev.id : null, text, fix: fix || '' }); };
    const devs = [...net.devices.values()].filter((d) => d.power !== false);
    net.ensureRouting();

    // адреса: повторы
    const byIp = new Map();
    for (const d of devs) {
      for (const f of d.ifaces || []) {
        if (f.ip == null || f.runtime) continue;
        if (!byIp.has(f.ip)) byIp.set(f.ip, []);
        byIp.get(f.ip).push({ d, f });
      }
    }
    for (const [a, list] of byIp) {
      const who = [...new Set(list.map((x) => x.d))];
      if (who.length > 1) add('err', who[1], 'Адрес ' + ip(a) + ' повторяется: ' + who.map((d) => d.name).join(', '), 'У каждого интерфейса должен быть свой адрес.');
    }
    const subnets = new Map();
    for (const d of devs) for (const f of d.ifaces || []) if (f.ip != null && f.mask != null && f.mask !== 0xffffffff && !f.runtime) subnets.set(U.net(f.ip, f.mask) + '/' + f.mask, { net: U.net(f.ip, f.mask), mask: f.mask, host: f.ip });

    // конечные узлы
    for (const d of devs) {
      if (!isHost(d)) continue;
      const f = d.iface;
      const p = f.port != null ? d.ports[f.port] : null;
      if (p && !p.link && !p.radio) { add('warn', d, d.name + ': сетевой кабель не подключён', 'Подключите ' + d.name + ' к коммутатору или маршрутизатору.'); continue; }
      if (f.ip == null) {
        add('err', d, d.name + (f.dhcp ? ': DHCP не выдал адрес' : ': не задан IP-адрес'), f.dhcp ? 'Проверьте DHCP-сервер (пул, шлюз) и ip helper-address на маршрутизаторе.' : 'Задайте адрес и маску (IP Configuration).');
        continue;
      }
      if ((f.ip >>> 16) === 0xa9fe) { add('err', d, d.name + ': адрес ' + ip(f.ip) + ' — автоматический (APIPA), DHCP-сервер не ответил', 'Проверьте DHCP-сервер и путь до него.'); continue; }
      const others = [...subnets.values()].some((sn) => sn.net !== U.net(f.ip, f.mask));
      if (d.gateway == null) {
        if (others && d.type !== 'printer') add('warn', d, d.name + ': не задан шлюз по умолчанию — связь только внутри сети ' + cidr(f), 'Укажите адрес маршрутизатора в сети ' + cidr(f) + '.');
      } else {
        const g = ownerOf(net, d.gateway);
        if (!g) add('err', d, d.name + ': шлюз ' + ip(d.gateway) + ' не назначен ни одному устройству', 'Шлюз — адрес интерфейса маршрутизатора в сети ' + cidr(f) + '.');
        else if (g.f.mask !== f.mask) add('warn', d, d.name + ': маска /' + U.prefixFromMask(f.mask) + ' не совпадает с маской шлюза ' + g.dev.name + ' ' + g.f.name + ' (/' + U.prefixFromMask(g.f.mask) + ')', 'Маска у всех узлов одной сети должна быть одинаковой.');
      }
      if (d.dns != null && !ownerOf(net, d.dns)) add('info', d, d.name + ': DNS-сервер ' + ip(d.dns) + ' не найден в схеме', 'Если имена не нужны — не обращайте внимания.');
    }

    // кабели и концы каналов
    for (const l of net.links.values()) {
      const a = net.getDevice(l.a.dev);
      const b = net.getDevice(l.b.dev);
      if (!a || !b || l.wireless || l.cable === 'console') continue;
      const where = a.name + ' ' + a.ports[l.a.port].name + ' ↔ ' + b.name + ' ' + b.ports[l.b.port].name;
      const issue = net.linkIssue(l);
      if (issue) { add('err', a, where + ': ' + issue, portFix(issue)); continue; }
      const fa = (a.ifaces || []).find((f) => f.port === l.a.port && (f.kind === 'phys' || f.kind === 'routed') && f.ip != null);
      const fb = (b.ifaces || []).find((f) => f.port === l.b.port && (f.kind === 'phys' || f.kind === 'routed') && f.ip != null);
      if (fa && fb && !isHost(a) && !isHost(b)) {
        if (!U.sameNet(fa.ip, fb.ip, fa.mask) || !U.sameNet(fa.ip, fb.ip, fb.mask)) add('err', a, where + ': адреса концов в разных сетях (' + cidr(fa) + ' и ' + cidr(fb) + ')', 'Адреса на концах одного канала должны быть в одной сети.');
        else if (fa.mask !== fb.mask) add('warn', a, where + ': разные маски на концах (/' + U.prefixFromMask(fa.mask) + ' и /' + U.prefixFromMask(fb.mask) + ')', 'Задайте одинаковую маску.');
      }
      if (a.type === 'switch' && b.type === 'switch' && !a.ports[l.a.port].routed && !b.ports[l.b.port].routed) {
        const pa = dp(a, l.a.port);
        const pb = dp(b, l.b.port);
        if (pa.mode !== pb.mode) add('warn', a, where + ': на одном конце транк, на другом access', 'Между коммутаторами обычно нужен транк на обоих концах: switchport mode trunk.');
        else if (pa.mode === 'trunk' && pa.nativeVlan !== pb.nativeVlan) add('warn', a, where + ': native VLAN не совпадает (' + pa.nativeVlan + ' и ' + pb.nativeVlan + ')', 'switchport trunk native vlan — одинаковый на обоих концах.');
      }
    }

    // интерфейсы IOS-устройств
    for (const d of devs) {
      if (!d.ios) continue;
      d.ports.forEach((p, i) => {
        if (p.errDisabled) add('err', d, d.name + ' ' + p.name + ': порт в состоянии err-disabled' + (p.errReason ? ' (' + p.errReason + ')' : ''), 'Устраните причину, затем interface ' + p.name + ' → shutdown, no shutdown.');
        else if (p.link && d.type === 'switch' && !p.routed && p.adminUp === false) add('warn', d, d.name + ' ' + p.name + ': порт с подключённым кабелем выключен (shutdown)', 'interface ' + p.name + ' → no shutdown');
        if (p.link && d.type === 'switch' && !p.routed && d.vlans && dp(d, i).mode !== 'trunk' && !d.vlans.has(dp(d, i).vlan)) add('err', d, d.name + ' ' + p.name + ': VLAN ' + dp(d, i).vlan + ' не создан', 'vlan ' + dp(d, i).vlan);
      });
      for (const f of d.ifaces || []) {
        if ((f.kind === 'phys' || f.kind === 'routed') && f.ip != null && d.ports[f.port] && d.ports[f.port].link && (!f.adminUp || d.ports[f.port].adminUp === false)) {
          add('err', d, d.name + ' ' + f.name + ': интерфейс с адресом ' + cidr(f) + ' выключен (shutdown), хотя кабель подключён', 'interface ' + f.name + ' → no shutdown');
        }
      }
    }

    // маршрутизация: в какие сети схемы маршрутизатор не знает дороги
    for (const d of devs) {
      if (d.type !== 'router' || !d.lookup || !(d.ifaces || []).some((f) => f.ip != null)) continue;
      const own = (sn) => d.ifaces.some((f) => f.ip != null && f.mask === sn.mask && U.net(f.ip, f.mask) === sn.net);
      const miss = [...subnets.values()].filter((sn) => !own(sn) && !d.lookup(sn.host));
      if (miss.length) {
        add('warn', d, d.name + ': нет маршрута в ' + (miss.length === 1 ? 'сеть ' : 'сети ') + miss.slice(0, 4).map((sn) => U.cidr(sn.net, sn.mask)).join(', ') + (miss.length > 4 ? ' и ещё ' + (miss.length - 4) : ''),
          'Добавьте статические маршруты или настройте динамическую маршрутизацию (OSPF, EIGRP, RIP). Проверка: show ip route.');
      }
    }
    const rank = { err: 0, warn: 1, info: 2 };
    return out.sort((x, y) => rank[x.sev] - rank[y.sev]);
  }

  /* ================= режим поиска неисправностей ================= */

  function rng(seed) {
    let s = (Number(seed) >>> 0) || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function shuffle(r, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const cfg = (d, lines) => NS.cliIos.replayConfig(d, lines, { out() {}, mutate: (fn) => fn() }, true);

  /** Свободный адрес узла в сети base/mask (с конца диапазона). */
  function freeHost(net, base, mask) {
    const n = U.net(base, mask);
    const size = (~mask >>> 0) + 1;
    for (let k = size - 2; k >= 1; k--) {
      const a = (n + k) >>> 0;
      if (!ownerOf(net, a)) return a;
    }
    return null;
  }

  const FAULT_KINDS = {
    host: 'Конечные узлы: адрес, маска, шлюз',
    l2: 'Коммутация: VLAN, транки, порты',
    l3: 'Маршрутизация: интерфейсы, маршруты, протоколы',
    sec: 'Безопасность: списки доступа',
  };

  /** Возможные поломки схемы: [{cat, kind, dev (имя), text, fix, apply(dev)}]. */
  function faultCandidates(net) {
    const out = [];
    const put = (cat, kind, d, text, fix, apply) => out.push({ cat, kind, dev: d.name, text, fix, apply });
    const devs = [...net.devices.values()].filter((d) => d.power !== false);
    for (const d of devs) {
      if (isHost(d) && d.iface.ip != null && !d.iface.dhcp) {
        const f = d.iface;
        const { gateway: gw, dns } = d;
        const a0 = f.ip;
        const m0 = f.mask;
        if (gw != null) {
          const ng = freeHost(net, a0, m0);
          if (ng != null && ng !== gw) put('host', 'gw', d, d.name + ': неверный шлюз по умолчанию ' + ip(ng), 'Шлюз должен быть ' + ip(gw) + ' (IP Configuration → Default Gateway).', (x) => x.setStatic(a0, m0, ng, dns));
          for (let p = U.prefixFromMask(m0) + 1; p <= 30; p++) {
            const m = U.maskFromPrefix(p);
            if (U.sameNet(a0, gw, m) || !U.isHostAddress(a0, m)) continue;
            put('host', 'mask', d, d.name + ': неверная маска ' + ip(m) + ' (/' + p + ') — шлюз ' + ip(gw) + ' оказался в другой сети', 'Маска должна быть ' + ip(m0) + ' (/' + U.prefixFromMask(m0) + ').', (x) => { x.iface.mask = m; x.addressChanged(x.iface); });
            break;
          }
        }
        const other = (a0 + (~m0 >>> 0) + 1) >>> 0; // тот же узел в соседней сети
        if (!ownerOf(net, other) && U.isHostAddress(other, m0)) put('host', 'ip', d, d.name + ': IP-адрес ' + ip(other) + ' не из своей сети', 'Адрес должен быть ' + ip(a0) + ' (сеть ' + cidr(f) + ').', (x) => { x.iface.ip = other; x.addressChanged(x.iface); });
      }

      if (d.type === 'switch' && d.ios && d.vlans) {
        d.ports.forEach((p, i) => {
          if (!p.link || p.routed) return;
          const pr = net.peer(d, i);
          if (!pr) return;
          const q = dp(d, i);
          if (q.mode !== 'trunk' && isHost(pr.dev)) {
            const w = [...d.vlans.keys()].find((v) => v !== q.vlan && v > 1 && v < 1002) || (q.vlan === 99 ? 98 : 99);
            put('l2', 'vlan', d, d.name + ' ' + p.name + ' (к ' + pr.dev.name + '): порт в VLAN ' + w + ' вместо VLAN ' + q.vlan, 'interface ' + p.name + ' → switchport access vlan ' + q.vlan,
              (x) => cfg(x, ['vlan ' + w, 'interface ' + p.name, ' switchport access vlan ' + w]));
          }
          if (isHost(pr.dev) || pr.dev.ios) put('l2', 'shut', d, d.name + ' ' + p.name + ' (к ' + pr.dev.name + '): порт выключен (shutdown)', 'interface ' + p.name + ' → no shutdown', (x) => cfg(x, ['interface ' + p.name, ' shutdown']));
          if (q.mode === 'trunk') {
            const used = [...d.vlans.keys()].filter((v) => v > 1 && v < 1002 && U.vlanInList(q.allowed, v) && d.ports.some((pp, k) => pp.link && k !== i && dp(d, k).mode !== 'trunk' && dp(d, k).vlan === v));
            if (used.length) {
              const v = used[0];
              put('l2', 'trunk', d, d.name + ' ' + p.name + ' (транк к ' + pr.dev.name + '): VLAN ' + v + ' убран из разрешённых', 'interface ' + p.name + ' → switchport trunk allowed vlan add ' + v,
                (x) => cfg(x, ['interface ' + p.name, ' switchport trunk allowed vlan remove ' + v]));
            }
          }
        });
      }

      if (d.type === 'router' && d.ios) {
        for (const f of d.ifaces) {
          if (f.ip == null || f.kind === 'loop' || f.runtime || f.port == null || !d.ports[f.port] || !d.ports[f.port].link) continue;
          const nm = f.name;
          const addr = ip(f.ip) + ' ' + ip(f.mask);
          if (f.kind === 'phys') put('l3', 'shut', d, d.name + ' ' + nm + ': интерфейс выключен (shutdown)', 'interface ' + nm + ' → no shutdown', (x) => cfg(x, ['interface ' + nm, ' shutdown']));
          const na = freeHost(net, f.ip, f.mask);
          if (na != null) put('l3', 'ifip', d, d.name + ' ' + nm + ': неверный адрес ' + ip(na) + ' (должен быть ' + ip(f.ip) + ')', 'interface ' + nm + ' → ip address ' + addr, (x) => cfg(x, ['interface ' + nm, ' ip address ' + ip(na) + ' ' + ip(f.mask)]));
          if (f.kind === 'sub' && f.vlan != null) {
            const w = f.vlan === 99 ? 98 : 99;
            put('l3', 'dot1q', d, d.name + ' ' + nm + ': encapsulation dot1Q ' + w + ' вместо ' + f.vlan, 'interface ' + nm + ' → encapsulation dot1Q ' + f.vlan, (x) => cfg(x, ['interface ' + nm, ' encapsulation dot1Q ' + w]));
          }
          const lan = devs.find((h) => isHost(h) && h.iface.ip != null && U.sameNet(h.iface.ip, f.ip, f.mask));
          if (lan) {
            let n = 180;
            while (d.acls && d.acls.has(String(n))) n++;
            const hip = ip(lan.iface.ip);
            put('sec', 'acl', d, d.name + ': список доступа ' + n + ' на ' + nm + ' (out) запрещает трафик к ' + lan.name + ' (' + hip + ')', 'interface ' + nm + ' → no ip access-group ' + n + ' out (или удалите строку deny из списка ' + n + ')',
              (x) => cfg(x, ['access-list ' + n + ' deny ip any host ' + hip, 'access-list ' + n + ' permit ip any any', 'interface ' + nm, ' ip access-group ' + n + ' out']));
          }
        }
        for (const r of d.routes || []) {
          if (r.nextHop == null) continue;
          const line = 'ip route ' + ip(r.net) + ' ' + ip(r.mask) + ' ' + ip(r.nextHop);
          put('l3', 'route', d, d.name + ': удалён маршрут «' + line + '»', line, (x) => cfg(x, ['no ' + line]));
          const f = d.ifaces.find((q) => q.ip != null && q.mask != null && U.sameNet(r.nextHop, q.ip, q.mask));
          const nh = f ? freeHost(net, f.ip, f.mask) : null;
          if (nh != null) put('l3', 'nexthop', d, d.name + ': в маршруте в сеть ' + U.cidr(r.net, r.mask) + ' неверный следующий хоп ' + ip(nh), line, (x) => cfg(x, ['no ' + line, 'ip route ' + ip(r.net) + ' ' + ip(r.mask) + ' ' + ip(nh)]));
        }
        let head = null;
        for (const l of NS.cliIos.runningConfig(d)) {
          if (/^router (ospf|eigrp|rip)\b/.test(l)) { head = l; continue; }
          if (!/^\s/.test(l)) { head = null; continue; }
          const m = head && /^\s+network\s+(.+?)\s*$/.exec(l);
          if (!m) continue;
          const hd = head;
          const nw = m[1];
          put('l3', 'net', d, d.name + ': в «' + hd + '» нет команды «network ' + nw + '»', hd + ' → network ' + nw, (x) => cfg(x, [hd, ' no network ' + nw]));
          const ar = /^(\S+ \S+) area (\d+)$/.exec(nw);
          if (ar) {
            const other = Number(ar[2]) === 0 ? 1 : 0;
            put('l3', 'area', d, d.name + ': «network ' + ar[1] + '» в area ' + other + ' вместо area ' + ar[2] + ' — соседство OSPF не устанавливается', hd + ' → network ' + nw,
              (x) => cfg(x, [hd, ' no network ' + nw, ' network ' + ar[1] + ' area ' + other]));
          }
        }
      }
    }
    return out;
  }

  /** Связь между парами устройств [имя, имя] в копии сети → [true|false]. */
  function reach(net, pairs) {
    const c = copyOf(net);
    return pairs.map(([a, b]) => {
      const d = c.findByName(a);
      if (!d || typeof d.ping !== 'function') return false;
      const addr = U.parseIp(b) != null ? U.parseIp(b) : (c.findByName(b) ? devIp(c.findByName(b)) : null);
      if (addr == null) return false;
      let done = null;
      d.ping(ip(addr), { count: 2, onEvent: (e) => { if (e.type === 'done') done = e; } });
      c.runUntilIdle(20000);
      return !!(done && done.received > 0);
    });
  }

  /**
   * Сломать работающую сеть для упражнения «поиск неисправностей».
   * opts: { count (1–6), kinds: ['host', 'l2', 'l3', 'sec'], seed }
   * → { net (сломанная копия), faults: [{cat, kind, dev, text, fix}], tests: [{from, to, expect, points}] }; ошибка — Error с объяснением.
   */
  function breakNetwork(net, opts) {
    opts = opts || {};
    const count = Math.max(1, Math.min(6, Number(opts.count) || 3));
    const kinds = new Set(opts.kinds && opts.kinds.length ? opts.kinds : Object.keys(FAULT_KINDS));
    const r = rng(opts.seed != null ? opts.seed : Date.now());
    return guard(() => {
      const hosts = [...net.devices.values()].filter((d) => isHost(d) && d.power && d.iface.ip != null && !['printer', 'ipphone'].includes(d.type));
      if (hosts.length < 2) throw new Error('Нужно хотя бы два компьютера с IP-адресами.');
      let pairs = [];
      for (let i = 0; i < hosts.length; i++) for (let j = i + 1; j < hosts.length; j++) pairs.push([hosts[i].name, ip(hosts[j].iface.ip)]);
      pairs = shuffle(r, pairs).slice(0, 24);
      const base = reach(net, pairs);
      const tests = pairs.filter((p, k) => base[k]);
      if (!tests.length) throw new Error('В этой сети компьютеры не пингуют друг друга. Сначала соберите работающую сеть — потом её можно сломать.');
      const cands = shuffle(r, faultCandidates(net).filter((c) => kinds.has(c.cat)));
      const faults = [];
      const used = new Set();
      let cur = JSON.stringify(net.serialize());
      let failing = 0;
      for (const c of cands) {
        if (faults.length >= count) break;
        if (used.has(c.dev)) continue;
        const trial = NS.Network.deserialize(JSON.parse(cur));
        const d = trial.findByName(c.dev);
        if (!d) continue;
        try { c.apply(d); } catch (e) { continue; }
        const f = reach(trial, tests).filter((x) => !x).length;
        if (f <= failing) continue; // поломка должна нарушать связь, которую не нарушили предыдущие
        failing = f;
        cur = JSON.stringify(trial.serialize());
        used.add(c.dev);
        faults.push({ cat: c.cat, kind: c.kind, dev: c.dev, text: c.text, fix: c.fix });
      }
      if (!faults.length) throw new Error('Не удалось подобрать неисправность, которая нарушила бы связь. Выберите другие виды поломок или сеть посложнее.');
      const pts = Math.max(1, Math.floor(100 / tests.length));
      return { net: NS.Network.deserialize(JSON.parse(cur)), faults, tests: tests.map(([from, to]) => ({ from, to, expect: true, points: pts })) };
    });
  }

  NS.diag = { explain, audit, breakNetwork, faultCandidates, reach, FAULT_KINDS, ownerOf, portWhy, l2Problems, fixFor, copyOf, guard, isHost };
})(globalThis.NetLab = globalThis.NetLab || {});
