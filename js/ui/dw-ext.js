/* NetLab UI — вкладка «Настройка» для новых подсистем: IPv6 на компьютерах и интерфейсах маршрутизатора,
 * GRE-туннели, crypto map, PPPoE, NetFlow; страницы маршрутизатора IPv6 / SNMP / NetFlow / Телефония (CME) / IOx;
 * настройки IP-телефона, умных устройств, IoT-сервера, телефонной сети и простых устройств.
 * На маршрутизаторе всё выполняется IOS-командами (видны в «Эквивалентных командах IOS»). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const ip6 = NS.ip6;
  const ipT = DW.ipText;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });
  const hint = (t) => h('div', { class: 'hint-box', style: { marginTop: '10px' } }, t);
  const tbl = (head, rows, empty) => h('table', { class: 'tbl', style: { marginTop: '8px' } },
    h('tr', null, head.map((x) => h('th', null, x))),
    rows.length ? rows : h('tr', { class: 'empty' }, h('td', { colspan: head.length }, empty || 'Пусто')));
  const delBtn = (fn) => h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: fn }, UI.icon('delete'));

  /** Прочитать IPv6-адрес из поля (пусто → null). */
  function read6(inp, required) {
    const t = inp.value.trim();
    inp.classList.remove('bad');
    if (!t) return required ? { ok: false, err: 'Заполните поле' } : { ok: true, v: null };
    const v = ip6.parse(t);
    if (v == null) { inp.classList.add('bad'); return { ok: false, err: '«' + t + '» — неверный IPv6-адрес (пример: 2001:DB8:1::10)' }; }
    return { ok: true, v };
  }

  /* ================= IPv6 на компьютере ================= */

  DW.hostIpv6Form = function (app, dev, box) {
    const f = dev.iface;
    if (!f || f.port < 0 || !dev.setIpv6Host || f.kind !== 'phys') return null;
    const v = f.v6 || { addrs: [] };
    const man = (v.addrs || []).find((a) => a.origin !== 'slaac');
    const e = err();
    const addrI = h('input', { class: 'inp mono', value: man ? ip6.str(man.addr) : '', placeholder: '2001:DB8:1::10', spellcheck: 'false' });
    const plenI = h('input', { class: 'inp', type: 'number', min: 1, max: 128, value: man ? man.plen : 64, style: { width: '90px' } });
    const gwI = h('input', { class: 'inp mono', value: dev.v6cfg().gw != null ? ip6.str(dev.v6cfg().gw) : '', placeholder: 'FE80::1 или 2001:DB8:1::1', spellcheck: 'false' });
    const ll = h('div', { class: 'mono' });
    const auto = h('div', { class: 'mono' });
    const mode0 = v.dhcp ? 'dhcp' : v.autoconfig ? 'auto' : 'static';
    const staticBox = h('div', { style: { display: mode0 !== 'static' ? 'none' : '' } }, DW.form(lbl('IPv6-адрес'), h('div', { class: 'row' }, addrI, h('span', null, '/'), plenI), lbl('Шлюз IPv6'), gwI,
      h('span'), h('button', { class: 'btn primary small', onClick: () => {
        const a = read6(addrI, false);
        if (!a.ok) { e.textContent = a.err; return; }
        const g = read6(gwI, false);
        if (!g.ok) { e.textContent = 'Шлюз: ' + g.err; return; }
        DW.apply(app, () => app.net.getDevice(dev.id).setIpv6Host('static', a.v, Number(plenI.value) || 64, g.v), e, true);
      } }, 'Применить')));
    box.append(DW.section('IPv6'), DW.form(
      lbl('IPv6-конфигурация'), DW.radio('v6-' + dev.id, [['dhcp', 'Автоматически (DHCPv6)'], ['auto', 'Автонастройка (SLAAC)'], ['static', 'Статически']], mode0, (m) => {
        if (m !== 'static') { staticBox.style.display = 'none'; DW.apply(app, () => app.net.getDevice(dev.id).setIpv6Host(m), e); } else staticBox.style.display = '';
      }),
      lbl('Link-local'), ll, lbl('Полученный адрес'), auto), staticBox, e);
    return () => {
      const d = app.net.getDevice(dev.id);
      if (!d) return;
      const x = d.iface;
      ll.textContent = d.ll6(x) != null ? ip6.str(d.ll6(x)) : '—';
      const sl = d.addrs6(x).filter((a) => a.origin === 'slaac' || a.origin === 'dhcp');
      const gw = d.gateway6();
      const dns = d.v6dns && d.v6dns.length ? ', DNS ' + d.v6dns.map((a) => ip6.str(a)).join(', ') : '';
      const c = d.dhcp6c;
      const wait = x.v6 && x.v6.dhcp ? (c && c.error ? 'DHCPv6: ' + c.error : gw ? 'запрос адреса у DHCPv6-сервера…' : 'ожидание Router Advertisement…') : x.v6 && x.v6.autoconfig ? 'ожидание Router Advertisement…' : '—';
      auto.textContent = sl.length ? sl.map((a) => ip6.str(a.addr) + '/' + a.plen + (a.origin === 'dhcp' ? ' (DHCPv6)' : '')).join(', ') + (gw ? ', шлюз ' + ip6.str(gw.addr) : '') + dns : wait;
    };
  };

  /* ================= интерфейс маршрутизатора ================= */

  DW.routerIfaceExtra = function (app, dev, f, run) {
    const rows = [];
    const e = err();
    // IPv6
    const man = f.v6 ? (f.v6.addrs || []).find((a) => a.origin !== 'slaac') : null;
    const v6I = h('input', { class: 'inp mono', value: man ? ip6.str(man.addr) + '/' + man.plen : '', placeholder: '2001:DB8:1::1/64', spellcheck: 'false' });
    DW.commitOnChange(v6I, () => {
      const t = v6I.value.trim();
      if (!t) { if (man) run(['no ipv6 address ' + ip6.str(man.addr) + '/' + man.plen]); return; }
      const p = ip6.parsePrefix(t);
      if (!p) { v6I.classList.add('bad'); e.textContent = 'IPv6: пример 2001:DB8:1::1/64'; return; }
      run((man ? ['no ipv6 address ' + ip6.str(man.addr) + '/' + man.plen] : []).concat(['ipv6 address ' + t]));
    });
    const ll = dev.ll6(f);
    rows.push(lbl('IPv6-адрес'), h('div', null, v6I, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'link-local: ' + (ll != null ? ip6.str(ll) : 'нет (IPv6 выключен)'))));
    if (f.kind === 'tunnel' && f.tunnel) {
      const srcOpts = [['', 'не задан']].concat(dev.ifaces.filter((x) => x !== f && x.kind !== 'tunnel' && x.ip != null).map((x) => [x.name, x.name + ' (' + U.ipStr(x.ip) + ')']));
      const cur = typeof f.tunnel.src === 'number' ? '' : f.tunnel.src || '';
      rows.push(lbl('Tunnel source'), DW.select(srcOpts, cur, (val) => run([val ? 'tunnel source ' + val : 'no tunnel source'])));
      const dst = DW.ipInput(ipT(f.tunnel.dst), 'адрес другого конца');
      DW.commitOnChange(dst, () => {
        const r = DW.readIp(dst, false);
        if (!r.ok) { e.textContent = r.err; return; }
        run([r.v == null ? 'no tunnel destination' : 'tunnel destination ' + U.ipStr(r.v)]);
      });
      rows.push(lbl('Tunnel destination'), dst);
    }
    if (f.kind === 'vtemplate' && f.vt) {
      const un = [['', 'нет (свой адрес)']].concat(dev.ifaces.filter((x) => x.ip != null && x.kind !== 'vtemplate').map((x) => [x.name, x.name]));
      rows.push(lbl('ip unnumbered'), DW.select(un, f.vt.unnumbered || '', (val) => run([val ? 'ip unnumbered ' + val : 'no ip unnumbered'])));
      const pools = [['', 'не задан']].concat(Object.keys(dev.pools || {}).map((k) => [k, k]));
      rows.push(lbl('Пул адресов клиентов'), DW.select(pools, f.vt.pool || '', (val) => run([val ? 'peer default ip address pool ' + val : 'no peer default ip address pool'])));
      rows.push(lbl('Проверка подлинности'), DW.select([['', 'нет'], ['chap', 'CHAP'], ['pap', 'PAP']], f.vt.auth || '', (val) => run([val ? 'ppp authentication ' + val : 'no ppp authentication chap'])));
    }
    if (f.kind === 'phys' || f.kind === 'sub') {
      const maps = Object.keys((dev.crypto && dev.crypto.maps) || {});
      if (maps.length || f.cryptoMap) rows.push(lbl('Crypto map (IPsec)'), DW.select([['', 'нет']].concat(maps.map((k) => [k, k])), f.cryptoMap || '', (val) => run([val ? 'crypto map ' + val : 'no crypto map'])));
      const groups = Object.keys((dev.pppoe && dev.pppoe.groups) || {});
      if (groups.length || f.pppoeGroup) rows.push(lbl('PPPoE-сервер'), DW.select([['', 'выключен']].concat(groups.map((k) => [k, 'bba-group ' + k])), f.pppoeGroup || '', (val) => run([val ? 'pppoe enable group ' + val : 'no pppoe enable'])));
      const fl = f.flow || {};
      rows.push(lbl('NetFlow'), h('div', { class: 'row' },
        UI.toggle('ingress', !!fl.in, (on) => run([on ? 'ip flow ingress' : 'no ip flow ingress'])),
        UI.toggle('egress', !!fl.out, (on) => run([on ? 'ip flow egress' : 'no ip flow egress']))));
    }
    rows.push(h('div', { class: 'full' }, e));
    return rows;
  };

  /* ================= страницы маршрутизатора ================= */

  function iosPage(app, dev, box, title, build) {
    const e = err();
    const run = (cmds) => DW.iosApply(app, app.net.getDevice(dev.id), cmds, e);
    box.appendChild(DW.section(title));
    const live = build(run, e);
    box.appendChild(e);
    return live;
  }

  DW.routerPages = [
    {
      id: 'ipv6', label: 'IPv6',
      render: (app, dev, box) => iosPage(app, dev, box, 'IPv6-маршрутизация', (run) => {
        const c = dev.v6cfg();
        box.appendChild(DW.form(lbl('ipv6 unicast-routing'), UI.toggle(c.routing ? 'Включена' : 'Выключена', c.routing, (on) => run([on ? 'ipv6 unicast-routing' : 'no ipv6 unicast-routing']))));
        const netI = h('input', { class: 'inp mono', placeholder: '2001:DB8:2::/64', spellcheck: 'false' });
        const nhI = h('input', { class: 'inp mono', placeholder: 'следующий переход', spellcheck: 'false' });
        box.append(DW.section('Статические маршруты IPv6'), h('div', { class: 'row' }, netI, nhI, h('button', { class: 'btn primary small', onClick: () => run(['ipv6 route ' + netI.value.trim() + ' ' + nhI.value.trim()]) }, 'Добавить')),
          tbl(['Префикс', 'Следующий переход', ''], c.routes.map((r) => h('tr', null, h('td', { class: 'mono' }, ip6.cidr(r.net, r.plen, true)), h('td', { class: 'mono' }, (r.ifName ? r.ifName + ' ' : '') + (r.nextHop != null ? ip6.str(r.nextHop) : '')),
            h('td', null, delBtn(() => run(['no ipv6 route ' + ip6.cidr(r.net, r.plen, true) + (r.ifName ? ' ' + r.ifName : '') + (r.nextHop != null ? ' ' + ip6.str(r.nextHop) : '')]))))), 'Маршрутов нет'),
          hint('Адреса интерфейсов IPv6 задаются на страницах интерфейсов (ipv6 address …/64). С включённой ipv6 unicast-routing маршрутизатор рассылает Router Advertisement — компьютеры с режимом SLAAC получают адрес и шлюз сами.'));
        const rt = h('pre', { class: 'ios-log', style: { maxHeight: '200px' } });
        box.append(DW.section('Таблица маршрутизации IPv6'), rt);
        return () => { const d = app.net.getDevice(dev.id); rt.textContent = d.routingTable6().map((r) => r.type + '   ' + ip6.cidr(r.net, r.plen, true) + (r.nextHop != null ? ' via ' + ip6.str(r.nextHop) : '') + (r.ifname ? ', ' + r.ifname : '')).join('\n') || '(пусто)'; };
      }),
    },
    {
      id: 'snmp', label: 'SNMP',
      render: (app, dev, box) => iosPage(app, dev, box, 'SNMP-агент', (run) => {
        const c = dev.snmp || { communities: [], location: '', contact: '' };
        const name = h('input', { class: 'inp', placeholder: 'community (public)', spellcheck: 'false' });
        const acc = DW.select([['RO', 'RO — только чтение'], ['RW', 'RW — чтение и запись']], 'RO');
        const loc = h('input', { class: 'inp', value: c.location || '', placeholder: 'например, Москва, стойка 3' });
        const con = h('input', { class: 'inp', value: c.contact || '', placeholder: 'admin@example.com' });
        DW.commitOnChange(loc, () => run([loc.value.trim() ? 'snmp-server location ' + loc.value.trim() : 'no snmp-server location']));
        DW.commitOnChange(con, () => run([con.value.trim() ? 'snmp-server contact ' + con.value.trim() : 'no snmp-server contact']));
        box.append(h('div', { class: 'row' }, name, acc, h('button', { class: 'btn primary small', onClick: () => { if (name.value.trim()) run(['snmp-server community ' + name.value.trim() + ' ' + acc.value]); } }, 'Добавить')),
          tbl(['Community', 'Доступ', 'ACL', ''], c.communities.map((x) => h('tr', null, h('td', { class: 'mono' }, x.name), h('td', null, x.access.toUpperCase()), h('td', null, x.acl || '—'), h('td', null, delBtn(() => run(['no snmp-server community ' + x.name]))))), 'Агент выключен: нет ни одной community'),
          DW.form(lbl('Location'), loc, lbl('Contact'), con),
          hint('SNMP v2c (UDP 161). Читать и менять MIB-II (sysName, ifTable, счётчики) можно программой MIB Browser на рабочем столе компьютера. RW-community позволяет менять hostname и выключать интерфейсы (ifAdminStatus).'));
      }),
    },
    {
      id: 'netflow', label: 'NetFlow',
      render: (app, dev, box) => iosPage(app, dev, box, 'NetFlow — учёт потоков', (run, e) => {
        const c = dev.netflow || { dest: null, port: 9996, version: 9 };
        const dst = DW.ipInput(ipT(c.dest), 'адрес коллектора');
        const port = h('input', { class: 'inp', type: 'number', min: 1, max: 65535, value: c.port, style: { width: '110px' } });
        const ver = DW.select([['9', 'версия 9'], ['5', 'версия 5']], String(c.version));
        box.append(DW.form(lbl('Коллектор'), h('div', { class: 'row' }, dst, port), lbl('Версия'), ver,
          h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: () => {
            const r = DW.readIp(dst, false);
            if (!r.ok) { e.textContent = r.err; return; }
            run(r.v == null ? ['no ip flow-export destination'] : ['ip flow-export version ' + ver.value, 'ip flow-export destination ' + U.ipStr(r.v) + ' ' + port.value]);
          } }, 'Сохранить'))),
        tbl(['Интерфейс', 'Ingress', 'Egress'], dev.ifaces.filter((f) => f.flow && (f.flow.in || f.flow.out)).map((f) => h('tr', null, h('td', null, f.name), h('td', null, f.flow.in ? '✓' : ''), h('td', null, f.flow.out ? '✓' : ''))), 'Учёт не включён ни на одном интерфейсе (включите на странице интерфейса)'));
        const cache = h('div', { class: 'muted' });
        box.append(cache, hint('Маршрутизатор записывает потоки (адреса, порты, протокол, число пакетов и байт) и отправляет их по UDP коллектору — программе NetFlow Collector на рабочем столе компьютера или сервера.'));
        return () => { const d = app.net.getDevice(dev.id); cache.textContent = 'Потоков в кэше: ' + (d.flowCache ? d.flowCache.size : 0); };
      }),
    },
    {
      id: 'cme', label: 'Телефония (CME)',
      render: (app, dev, box) => iosPage(app, dev, box, 'Cisco CME — telephony-service', (run, e) => {
        const c = dev.cme || { on: false, maxEphones: 0, maxDn: 0, source: null, port: 2000, auto: null, dns: {}, ephones: {} };
        const maxE = h('input', { class: 'inp', type: 'number', min: 0, max: 240, value: c.maxEphones || 5, style: { width: '90px' } });
        const maxD = h('input', { class: 'inp', type: 'number', min: 0, max: 720, value: c.maxDn || 5, style: { width: '90px' } });
        const srcOpts = dev.ifaces.filter((f) => f.ip != null && !f.runtime).map((f) => [U.ipStr(f.ip), U.ipStr(f.ip) + ' (' + f.name + ')']);
        const src = DW.select([['', 'не задан']].concat(srcOpts), c.source != null ? U.ipStr(c.source) : '');
        const aFrom = h('input', { class: 'inp', type: 'number', min: 1, value: c.auto ? c.auto.from : 1, style: { width: '70px' } });
        const aTo = h('input', { class: 'inp', type: 'number', min: 1, value: c.auto ? c.auto.to : 5, style: { width: '70px' } });
        box.append(DW.form(
          lbl('max-ephones'), maxE, lbl('max-dn'), maxD, lbl('ip source-address'), src,
          lbl('auto assign'), h('div', { class: 'row' }, aFrom, h('span', null, 'по'), aTo),
          h('span'), h('button', { class: 'btn primary small', onClick: () => {
            if (!src.value) { e.textContent = 'Выберите адрес, на котором телефоны будут регистрироваться (ip source-address)'; return; }
            run(['telephony-service', 'max-ephones ' + maxE.value, 'max-dn ' + maxD.value, 'ip source-address ' + src.value + ' port 2000', 'auto assign ' + aFrom.value + ' to ' + aTo.value, 'exit']);
          } }, c.on ? 'Сохранить' : 'Включить telephony-service')));
        const tag = h('input', { class: 'inp', type: 'number', min: 1, value: Object.keys(c.dns).length + 1, style: { width: '70px' } });
        const num = h('input', { class: 'inp mono', placeholder: 'номер, например 1001', style: { width: '160px' } });
        box.append(DW.section('Номера (ephone-dn)'), h('div', { class: 'row' }, h('span', null, 'ephone-dn'), tag, num, h('button', { class: 'btn primary small', onClick: () => run(['ephone-dn ' + tag.value, 'number ' + num.value.trim(), 'exit']) }, 'Добавить')));
        const regBox = h('div');
        box.append(regBox, hint('Порядок как в Packet Tracer: 1) DHCP-пул для телефонов с option 150 ip <адрес CME>; 2) telephony-service с max-ephones, max-dn, ip source-address и auto assign; 3) ephone-dn с номерами. Телефоны регистрируются сами (SCCP, TCP 2000); голос идёт напрямую между телефонами по RTP. На коммутаторе — switchport voice vlan.'));
        const pTag = h('input', { class: 'inp', type: 'number', min: 1, value: Object.keys(c.peers || {}).length + 1, style: { width: '70px' } });
        const pPat = h('input', { class: 'inp mono', placeholder: 'шаблон, например 2...', style: { width: '140px' } });
        const pTgt = h('input', { class: 'inp mono', placeholder: 'адрес другого CME', style: { width: '150px' } });
        const peersBox = h('div');
        const callsBox = h('div');
        box.append(DW.section('Вызовы на другой CME (dial-peer voice … voip)'),
          h('div', { class: 'row' }, h('span', null, 'dial-peer'), pTag, pPat, pTgt, h('button', { class: 'btn primary small', onClick: () => {
            if (!pPat.value.trim() || !pTgt.value.trim()) { e.textContent = 'Укажите шаблон номеров (destination-pattern) и адрес другого CME (session target)'; return; }
            run(['dial-peer voice ' + pTag.value + ' voip', 'destination-pattern ' + pPat.value.trim(), 'session target ipv4:' + pTgt.value.trim(), 'exit']);
          } }, 'Добавить')),
          peersBox, DW.section('Активные вызовы'), callsBox,
          hint('Номер, которого нет среди ephone-dn, CME ищет в dial-peer: «.» в шаблоне — любая цифра, «T» — любое число цифр (2... — все четырёхзначные номера на 2). Вызов уходит на session target по H.323 (TCP 1720); на другом CME нужен встречный dial-peer. Голос идёт напрямую между телефонами, поэтому сети телефонов должны быть связаны маршрутами. На телефоне можно поставить вызов на удержание и перевести собеседника на другой номер.'));
        return () => {
          const d = app.net.getDevice(dev.id);
          const cc = d.cme || c;
          const used = {};
          for (const [n, x] of Object.entries(cc.ephones || {})) for (const t of Object.values(x.buttons || {})) used[t] = n;
          UI.clear(regBox);
          regBox.append(tbl(['DN', 'Номер', 'ephone', 'Состояние', ''], Object.entries(cc.dns || {}).map(([n, x]) => {
            const eph = used[n];
            const reg = eph && d.cmeRt ? d.cmeRt.regs.get(cc.ephones[eph].mac) : null;
            return h('tr', null, h('td', null, n), h('td', { class: 'mono' }, x.number || '—'), h('td', null, eph ? 'ephone-' + eph : '—'),
              h('td', null, reg ? h('span', { class: 'st ok' }, 'зарегистрирован ' + U.ipStr(reg.ip)) : h('span', { class: 'muted' }, 'нет')), h('td', null, delBtn(() => run(['no ephone-dn ' + n]))));
          }), 'Номеров нет'));
          UI.clear(peersBox);
          peersBox.append(tbl(['Тег', 'Шаблон', 'session target', 'Состояние', ''], Object.entries(cc.peers || {}).map(([n, p]) => h('tr', null, h('td', null, n), h('td', { class: 'mono' }, p.pattern || '—'),
            h('td', { class: 'mono' }, p.target != null ? 'ipv4:' + U.ipStr(p.target) : '—'),
            h('td', null, p.shut ? h('span', { class: 'muted' }, 'shutdown') : p.pattern && p.target != null ? h('span', { class: 'st ok' }, 'up') : h('span', { class: 'muted' }, 'не настроен')),
            h('td', null, delBtn(() => run(['no dial-peer voice ' + n]))))), 'dial-peer не настроены'));
          UI.clear(callsBox);
          const calls = d.cmeRt ? [...d.cmeRt.calls.values()] : [];
          callsBox.append(tbl(['Кто', 'Кому', 'Состояние', 'Путь'], calls.map((x) => h('tr', null, h('td', { class: 'mono' }, x.from || '?'), h('td', { class: 'mono' }, x.number || '?'),
            h('td', null, x.state === 'connected' ? (x.held && Object.keys(x.held).length ? 'на удержании' : 'разговор') : 'звонит'),
            h('td', null, x.trunk ? 'H.323 ' + (x.trunk.dir === 'out' ? '→ ' : '← ') + U.ipStr(x.trunk.ip) : 'внутри CME'))), 'Вызовов нет'));
        };
      }),
    },
    {
      id: 'iox', label: 'IOx',
      render: (app, dev, box) => iosPage(app, dev, box, 'IOx — приложения на маршрутизаторе', (run) => {
        const c = dev.iox || { enabled: false, apps: {} };
        box.append(DW.form(lbl('iox'), UI.toggle(c.enabled ? 'Включён' : 'Выключен', !!c.enabled, (on) => run([on ? 'iox' : 'no iox']))));
        const vpg = dev.ifaces.find((f) => f.kind === 'vpg');
        if (!vpg) box.append(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn outline small', onClick: () => run(['interface VirtualPortGroup0', 'ip address 192.168.10.1 255.255.255.0']) }, 'Создать VirtualPortGroup0 (192.168.10.1/24)')));
        const list = h('div');
        box.append(list, hint('Приложения загружает программа IoX IDE с рабочего стола компьютера (вход — пользователь с privilege 15: username admin privilege 15 secret …). Сеть приложения: app-hosting appid <имя> → app-vnic gateway0 virtualportgroup 0 guest-interface 0 → guest-ipaddress. Запущенное приложение открывается в браузере: http://<гостевой адрес>:<порт>.'));
        return () => {
          const d = app.net.getDevice(dev.id);
          const cc = d.iox || c;
          UI.clear(list);
          list.append(tbl(['Приложение', 'Состояние', 'Гостевой адрес', 'Порт'], Object.entries(cc.apps || {}).map(([id, a]) => h('tr', null, h('td', null, id), h('td', null, a.state || 'не установлено'),
            h('td', { class: 'mono' }, a.guestIp != null ? U.ipStr(a.guestIp) : '—'), h('td', null, a.pkg && cc.pkgs[a.pkg] ? String(cc.pkgs[a.pkg].port) : '—'))), 'Приложений нет'));
        };
      }),
    },
  ];

  /* ================= IP-телефон ================= */

  DW.hostPages = [
    {
      id: 'phone', label: 'Телефон', applies: (d) => d.type === 'ipphone',
      render(app, dev, box) {
        const e = err();
        const tftp = DW.ipInput(dev.tftpManual != null ? U.ipStr(dev.tftpManual) : '', 'из DHCP (option 150)');
        DW.commitOnChange(tftp, () => {
          const r = DW.readIp(tftp, false);
          if (!r.ok) { e.textContent = r.err; return; }
          DW.apply(app, () => app.net.getDevice(dev.id).setTftp(r.v), e, true);
        });
        const stat = h('div');
        box.append(DW.section('IP-телефон Cisco 7960'), DW.form(
          lbl('Адаптер питания'), UI.toggle(dev.adapter ? 'Подключён' : 'Не подключён', dev.adapter, (on) => DW.apply(app, () => app.net.getDevice(dev.id).setAdapter(on), e)),
          lbl('TFTP-сервер (CME)'), tftp, h('div', { class: 'full' }, e)), stat,
        hint('Телефон получает питание от адаптера или по кабелю от PoE-коммутатора 3560-24PS. Адрес — по DHCP, адрес CME — из option 150 (или укажите вручную). Голосовой VLAN телефон узнаёт от коммутатора (switchport voice vlan). К порту PC можно подключить компьютер — телефон работает как мини-коммутатор.'));
        return () => {
          const d = app.net.getDevice(dev.id);
          const src = d.powerSource();
          UI.clear(stat);
          stat.append(DW.form(lbl('Питание'), h('div', null, src === 'poe' ? 'PoE от коммутатора' : src === 'adapter' ? 'адаптер' : h('span', { class: 'err-text' }, 'нет')),
            lbl('Голосовой VLAN'), h('div', null, d.voiceVlan ? String(d.voiceVlan) : 'нет (общий VLAN с компьютером)'),
            lbl('Регистрация'), h('div', null, d.sccp.text || '—'),
            lbl('Номер'), h('div', { class: 'mono' }, d.sccp.number || '—')));
        };
      },
    },
    {
      id: 'iot', label: 'IoT-сервер', applies: (d) => d.type === 'iot',
      render(app, dev, box) {
        const e = err();
        const c = dev.iot;
        const addr = DW.ipInput(ipT(c.address), 'адрес сервера');
        const user = h('input', { class: 'inp', value: c.user, spellcheck: 'false' });
        const pass = h('input', { class: 'inp', type: 'password', value: c.pass });
        let mode = c.server;
        const save = () => {
          const r = DW.readIp(addr, mode === 'remote');
          if (!r.ok) { e.textContent = r.err; return; }
          DW.apply(app, () => app.net.getDevice(dev.id).setIotServer({ server: mode, address: r.v, user: user.value.trim(), pass: pass.value }), e, true);
        };
        const stat = h('div', { class: 'hint-box', style: { marginTop: '8px' } });
        box.append(DW.section('Подключение к IoT-серверу'), DW.form(
          lbl('Сервер'), DW.radio('iotsrv-' + dev.id, [['off', 'Не задан'], ['gateway', 'Home Gateway (шлюз по умолчанию)'], ['remote', 'Удалённый сервер']], mode, (v) => { mode = v; addr.disabled = v !== 'remote'; }),
          lbl('Адрес сервера'), addr, lbl('Пользователь'), user, lbl('Пароль'), pass,
          h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: save }, 'Подключить'), e)), stat);
        addr.disabled = mode !== 'remote';
        return () => {
          const d = app.net.getDevice(dev.id);
          stat.textContent = d.iotRt.text || '—';
          stat.className = 'hint-box' + (d.iotRt.state === 'registered' ? '' : ' warn');
        };
      },
    },
    {
      id: 'iotd', label: 'IoT-сервер', applies: (d) => d.type === 'homegw',
      render: (app, dev, box) => DW.iotServerSection(app, dev, box),
    },
  ];

  /** Раздел IoT-сервера: включение, пользователи, зарегистрированные устройства (Home Gateway и Server-PT). */
  DW.iotServerSection = function (app, dev, box) {
    const e = err();
    const s = dev.iotd;
    const u = h('input', { class: 'inp', placeholder: 'имя', spellcheck: 'false' });
    const p = h('input', { class: 'inp', placeholder: 'пароль' });
    const list = h('div');
    const clockNow = h('span', { class: 'mono' });
    const clockIn = h('input', { class: 'inp', type: 'time', style: { width: '110px' } });
    const clockRow = h('div', { class: 'row' }, h('span', null, 'Сейчас:'), clockNow, clockIn,
      h('button', { class: 'btn outline small', onClick: () => DW.apply(app, () => app.net.getDevice(dev.id).iotd.setClock(clockIn.value), e) }, 'Установить'));
    box.append(DW.section('IoT-сервер (регистрация умных устройств)'),
      DW.form(lbl('Служба'), UI.toggle(s.enabled ? 'Включена' : 'Выключена', s.enabled, (on) => DW.apply(app, () => app.net.getDevice(dev.id).iotd.setEnabled(on), e))),
      DW.section('Учётные записи'),
      h('div', { class: 'row' }, u, p, h('button', { class: 'btn primary small', onClick: () => DW.apply(app, () => app.net.getDevice(dev.id).iotd.addUser(u.value, p.value), e) }, 'Добавить'), e),
      tbl(['Пользователь', 'Пароль', ''], s.users.map((x) => h('tr', null, h('td', null, x.user), h('td', { class: 'mono' }, '•'.repeat(Math.min(8, x.pass.length))), h('td', null, delBtn(() => DW.apply(app, () => app.net.getDevice(dev.id).iotd.removeUser(x.user)))))), 'Нет пользователей — устройства не смогут зарегистрироваться'),
      DW.section('Зарегистрированные устройства'), list,
      DW.section('Часы сервера (для расписаний в правилах)'), clockRow,
      hint('Умные устройства подключаются к серверу по TCP 1883 (вкладка устройства «Настройка» → «IoT-сервер»). Управлять ими и задавать правила «если… то…» можно программой IoT Monitor на рабочем столе компьютера или смартфона.'));
    return () => {
      const d = app.net.getDevice(dev.id);
      UI.clear(list);
      list.append(tbl(['Устройство', 'Тип', 'Адрес', 'Состояние'], [...d.iotd.things.values()].map((t) => h('tr', null, h('td', null, t.name), h('td', null, NS.iot.KINDS[t.kind] ? NS.iot.KINDS[t.kind].title : t.kind),
        h('td', { class: 'mono' }, U.ipStr(t.ip)), h('td', null, Object.entries(t.state).map(([k, v]) => NS.iot.propText(t.kind, k, v)).join(', ')))), 'Пока никого'),
      h('div', { class: 'muted', style: { marginTop: '6px' } }, 'Правил: ' + d.iotd.rules.length));
      clockNow.textContent = d.iotd.clock();
    };
  };

  /* ================= простые устройства ================= */

  function simpleConfig(extra) {
    return (app, id, st) => (body) => {
      const items = [{ group: 'GLOBAL' }, { id: 'global', label: 'Настройки' }].concat(extra ? extra.items : []);
      let live = null;
      DW.sidebarLayout(body, items, st, 'sec', (sec, box) => {
        const d = app.net.getDevice(id);
        live = null;
        if (sec === 'global') {
          box.append(DW.section('Глобальные настройки'), DW.form(...DW.cfg.displayName(app, d), lbl('Модель'), h('div', null, d.spec.title)));
          if (extra && extra.globalHint) box.append(hint(extra.globalHint(d)));
        } else if (extra) live = extra.render(sec, app, d, box) || null;
      });
      return () => { if (live) live(); };
    };
  }

  DW.simpleConfig = simpleConfig;

  DW.configBuilders.cloud = simpleConfig({
    items: [{ group: 'ТЕЛЕФОНИЯ' }, { id: 'numbers', label: 'Номера портов' }, { group: 'ПРОВАЙДЕР' }, { id: 'isp', label: 'DSL и кабель' }],
    globalHint: () => 'Облако моделирует телефонную сеть (PSTN): компьютер с модемом PT-HOST-NM-1AM подключается телефонным кабелем к порту Modem и звонит на номер другого порта программой Dial-up.',
    render(sec, app, d, box) {
      const e = err();
      if (sec === 'isp') {
        const peer = (n) => DW.peerText(app.net, d, d.portIndex(n));
        box.append(DW.section('Сеть провайдера'), DW.form(lbl('Ethernet'), h('div', null, peer('Ethernet')), lbl('DSL'), h('div', null, peer('DSL')), lbl('Coaxial'), h('div', null, peer('Coaxial'))),
          hint('Порты DSL (телефонный кабель от DSL-модема) и Coaxial (коаксиальный кабель от кабельного модема) соединены с портом Ethernet — к нему подключают маршрутизатор провайдера с DHCP. Абоненту за модемом провайдер выдаёт адрес, как будто они в одной сети.'));
        return null;
      }
      box.append(DW.section('Номера портов Modem'), h('div', { class: 'form' }, d.ports.filter((p) => /^Modem/.test(p.name)).map((p) => {
        const i = h('input', { class: 'inp mono', value: d.numbers[p.name] || '', style: { width: '160px' } });
        DW.commitOnChange(i, () => DW.apply(app, () => app.net.getDevice(d.id).setNumber(p.name, i.value), e));
        return [lbl(p.name + ' — ' + DW.peerText(app.net, d, d.portIndex(p.name))), i];
      }).flat(), h('div', { class: 'full' }, e)));
    },
  });

  const btHint = (d) => 'Bluetooth-' + (d.type === 'btspeaker' ? 'колонка' : 'гарнитура') + '. Подключается без проводов к смартфону, ноутбуку или планшету в радиусе ~10 м (на схеме — около ' + NS.bt.RANGE + ' точек): программа «Bluetooth» на рабочем столе → поиск → сопряжение (PIN ' + d.bt.pin + ') → «Подключить звук» → музыка.';
  DW.configBuilders.btspeaker = DW.configBuilders.btheadset = simpleConfig({
    items: [{ group: 'BLUETOOTH' }, { id: 'bt', label: 'Состояние' }],
    globalHint: btHint,
    render(sec, app, d, box) {
      const e = err();
      const pin = h('input', { class: 'inp mono', value: d.bt.pin, style: { width: '120px' } });
      DW.commitOnChange(pin, () => DW.apply(app, () => { if (!/^\d{4,8}$/.test(pin.value.trim())) throw new Error('PIN: 4–8 цифр'); app.net.getDevice(d.id).bt.pin = pin.value.trim(); }, e));
      const stat = h('div');
      box.append(DW.section('Bluetooth'), DW.form(lbl('Bluetooth'), UI.toggle(d.bt.on ? 'Включён' : 'Выключен', d.bt.on, (on) => DW.apply(app, () => NS.bt.setOn(app.net.getDevice(d.id), on), e)), lbl('PIN-код'), pin, h('div', { class: 'full' }, e)), stat);
      return () => {
        const x = app.net.getDevice(d.id);
        const src = x.btRt.source ? app.net.getDevice(x.btRt.source) : null;
        UI.clear(stat);
        stat.append(DW.form(lbl('Сопряжено с'), h('div', null, x.bt.paired.map((pid) => (app.net.getDevice(pid) || { name: '?' }).name).join(', ') || '—'),
          lbl('Источник звука'), h('div', null, src ? src.name : '—'), lbl('Играет'), h('div', null, x.btRt.playing ? '♪ ' + x.btRt.playing.track : 'тишина')));
      };
    },
  });

  DW.configBuilders.iotcomp = simpleConfig({
    items: [],
    globalHint: (d) => d.info.title + ': ' + (d.info.in ? 'датчик — плата читает его значение (' + (d.info.analog ? 'analogRead, 0–1023' : 'digitalRead, HIGH/LOW') + ').' : 'исполнительное устройство — плата управляет им (' + (d.info.analog ? 'analogWrite, 0–1023' : 'digitalWrite, HIGH/LOW') + ').') + ' Подключите его IoT-кабелем к пину платы MCU-PT или SBC-PT.',
  });

  DW.configBuilders.mcu = simpleConfig({
    items: [],
    globalHint: () => 'Микроконтроллер MCU-PT: пины D0–D5 (цифровые) и A0–A3 (аналоговые). Компоненты подключаются IoT-кабелем, программа пишется на вкладке «Программирование» (JavaScript, setup() и loop()).',
  });
})(globalThis.NetLab = globalThis.NetLab || {});
