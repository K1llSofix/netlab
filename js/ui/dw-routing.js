/* NetLab UI — страницы маршрутизатора EIGRP, BGP и «Редистрибуция» (с суммаризацией),
 * резервирование шлюза (HSRP / VRRP / GLBP) на странице интерфейса. Всё выполняется командами IOS. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const ip = U.ipStr;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });
  const hint = (t) => h('div', { class: 'hint-box', style: { marginTop: '10px' } }, t);
  const num = (v, w, min) => h('input', { class: 'inp', type: 'number', min: min == null ? 1 : min, value: v, style: { width: (w || 90) + 'px' } });
  const tbl = (head, rows, empty) => h('table', { class: 'tbl', style: { marginTop: '8px' } },
    h('tr', null, head.map((x) => h('th', null, x))),
    rows.length ? rows : h('tr', { class: 'empty' }, h('td', { colspan: head.length }, empty || 'Пусто')));
  const delBtn = (fn) => h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: fn }, UI.icon('delete'));
  const pre = () => h('pre', { class: 'ios-log', style: { maxHeight: '220px' } });

  /** Вывод show-команды IOS в виде текста. */
  function showText(dev, cmd) {
    const out = [];
    const s = NS.cliIos.createSession(dev);
    s.mode = 'exec';
    NS.cliIos.exec(dev, s, cmd, { out: (l) => out.push(l), write: (t) => out.push(t), mutate: (fn) => fn(), done() {}, clear() {} });
    return out.join('\n');
  }

  function page(app, dev, box, title, build) {
    const e = err();
    const run = (cmds) => DW.iosApply(app, app.net.getDevice(dev.id), cmds, e);
    box.appendChild(DW.section(title));
    const live = build(run, e);
    box.appendChild(e);
    return live;
  }

  /** Поля «сеть + wildcard» с проверкой; ok(net, wc) получает числа. */
  function netWc(e, ok, wcDefault) {
    const n = DW.ipInput('', 'сеть');
    const w = DW.ipInput(wcDefault || '', 'wildcard (необязательно)');
    const btn = h('button', { class: 'btn primary small', onClick: () => {
      const a = DW.readIp(n, true);
      if (!a.ok) { e.textContent = 'Сеть: ' + a.err; return; }
      const b = DW.readIp(w, false);
      if (!b.ok) { e.textContent = 'Wildcard: ' + b.err; return; }
      ok(a.v, b.v);
    } }, 'Добавить');
    return h('div', { class: 'row' }, n, w, btn);
  }

  /* ================= EIGRP ================= */

  const eigrpPage = {
    id: 'eigrp', label: 'EIGRP', group: 'routing',
    render: (app, dev, box) => page(app, dev, box, 'EIGRP', (run, e) => {
      const c = dev.eigrp;
      const asI = num(c ? c.asn : 100, 110);
      const pfx = () => ['router eigrp ' + (c ? c.asn : asI.value)];
      box.append(DW.form(lbl('Автономная система'), c ? h('div', { class: 'mono' }, String(c.asn)) : asI,
        lbl('Сеть'), netWc(e, (n, w) => run(pfx().concat(['network ' + ip(n) + (w != null ? ' ' + ip(w) : '')])))));
      if (!c) {
        box.append(hint('EIGRP — гибридный протокол Cisco: соседи обмениваются маршрутами, а алгоритм DUAL заранее выбирает резервный путь (feasible successor). Метрика считается по самой узкой полосе и сумме задержек на пути. Добавьте сети, в которых работают интерфейсы, — одинаковый номер AS на всех маршрутизаторах.'));
        return null;
      }
      box.append(tbl(['Сеть', 'Wildcard', ''], c.networks.map((n) => h('tr', null, h('td', { class: 'mono' }, ip(n.net)), h('td', { class: 'mono' }, n.wc != null ? ip(n.wc) : 'классовая'),
        h('td', null, delBtn(() => run(pfx().concat(['no network ' + ip(n.net) + (n.wc != null ? ' ' + ip(n.wc) : '')])))))), 'Сетей нет'));
      const varI = num(c.variance, 80);
      DW.commitOnChange(varI, () => run(pfx().concat([Number(varI.value) > 1 ? 'variance ' + varI.value : 'no variance'])));
      const rid = DW.ipInput(c.routerId != null ? ip(c.routerId) : '', 'автоматически');
      DW.commitOnChange(rid, () => {
        const r = DW.readIp(rid, false);
        if (!r.ok) { e.textContent = r.err; return; }
        run(pfx().concat([r.v == null ? 'no eigrp router-id' : 'eigrp router-id ' + ip(r.v)]));
      });
      const ifs = dev.ifaces.filter((f) => f.ip != null && !f.runtime);
      box.append(DW.form(
        lbl('auto-summary'), UI.toggle(c.autoSummary ? 'Включена' : 'Выключена', c.autoSummary, (on) => run(pfx().concat([on ? 'auto-summary' : 'no auto-summary']))),
        lbl('variance'), varI, lbl('Router ID'), rid,
        lbl('Пассивные интерфейсы'), h('div', { class: 'row', style: { flexWrap: 'wrap' } }, ifs.map((f) => UI.toggle(UI.shortIf(f.name), c.passive.includes(f.name), (on) => run(pfx().concat([(on ? '' : 'no ') + 'passive-interface ' + f.name])))))));
      const nb = h('div');
      const topo = pre();
      box.append(DW.section('Соседи'), nb, DW.section('Таблица топологии'), topo,
        h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn outline small danger', onClick: () => run(['no router eigrp ' + c.asn]) }, 'Остановить EIGRP')),
        hint('Successor — лучший путь, он попадает в таблицу маршрутизации (D). Feasible successor — запасной путь без петли (его отчётное расстояние меньше лучшей метрики): при отказе EIGRP переключается на него сразу. variance N добавляет в таблицу запасные пути с метрикой до N × лучшей — неравная балансировка. Суммарный маршрут задаётся на странице «Редистрибуция».'));
      return () => {
        const d = app.net.getDevice(dev.id);
        if (!d.eigrp) return;
        d.net.ensureRouting();
        UI.clear(nb);
        nb.append(tbl(['Адрес', 'Интерфейс', 'Сосед'], (d.eigrpNeighbors || []).map((n) => h('tr', null, h('td', { class: 'mono' }, ip(n.address)), h('td', null, n.ifname), h('td', null, n.dev ? n.dev.name : ''))), 'Соседей нет: проверьте номер AS и сети на обоих концах'));
        topo.textContent = showText(d, 'show ip eigrp topology').split('\n').slice(5).join('\n') || '(пусто)';
      };
    }),
  };

  /* ================= BGP ================= */

  const bgpPage = {
    id: 'bgp', label: 'BGP', group: 'routing',
    render: (app, dev, box) => page(app, dev, box, 'BGP', (run, e) => {
      const c = dev.bgp;
      const asI = num(c ? c.asn : 65001, 120);
      if (!c) {
        box.append(DW.form(lbl('Автономная система'), asI, h('span'), h('button', { class: 'btn primary small', onClick: () => run(['router bgp ' + asI.value]) }, 'Запустить BGP')),
          hint('BGP связывает автономные системы (провайдеров, организации). Соседей указывают вручную: neighbor <адрес> remote-as <AS>. Сосед из другой AS — eBGP (обычно на прямом канале), из той же — iBGP (часто между loopback-адресами с update-source). Сети объявляются командой network … mask … — такая сеть должна быть в таблице маршрутизации.'));
        return null;
      }
      const pfx = ['router bgp ' + c.asn];
      const nIp = DW.ipInput('', 'адрес соседа');
      const nAs = num(c.asn, 110);
      const srcOpts = [['', 'по умолчанию']].concat(dev.ifaces.filter((f) => f.ip != null && !f.runtime).map((f) => [f.name, f.name + ' (' + ip(f.ip) + ')']));
      const nSrc = DW.select(srcOpts, '');
      box.append(DW.form(lbl('Автономная система'), h('div', { class: 'mono' }, String(c.asn)),
        lbl('Новый сосед'), h('div', { class: 'row', style: { flexWrap: 'wrap' } }, nIp, h('span', null, 'AS'), nAs, h('span', null, 'источник'), nSrc, h('button', { class: 'btn primary small', onClick: () => {
          const r = DW.readIp(nIp, true);
          if (!r.ok) { e.textContent = r.err; return; }
          run(pfx.concat(['neighbor ' + ip(r.v) + ' remote-as ' + nAs.value], nSrc.value ? ['neighbor ' + ip(r.v) + ' update-source ' + nSrc.value] : []));
        } }, 'Добавить'))));
      const peers = h('div');
      const nNet = DW.ipInput('', 'сеть');
      const nMask = DW.ipInput('255.255.255.0', 'маска');
      box.append(peers, DW.section('Объявляемые сети'), h('div', { class: 'row' }, nNet, nMask, h('button', { class: 'btn primary small', onClick: () => {
        const a = DW.readIp(nNet, true);
        const m = DW.readIp(nMask, true);
        if (!a.ok || !m.ok) { e.textContent = (a.err || m.err); return; }
        run(pfx.concat(['network ' + ip(a.v) + ' mask ' + ip(m.v)]));
      } }, 'Добавить')),
      tbl(['Сеть', 'Маска', ''], c.networks.map((n) => h('tr', null, h('td', { class: 'mono' }, ip(n.net)), h('td', { class: 'mono' }, ip(n.mask)), h('td', null, delBtn(() => run(pfx.concat(['no network ' + ip(n.net) + ' mask ' + ip(n.mask)])))))), 'Сетей нет'));
      const table = pre();
      box.append(DW.section('Таблица BGP'), table,
        h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn outline small danger', onClick: () => run(['no router bgp ' + c.asn]) }, 'Остановить BGP')),
        hint('*> — лучший путь, он попадает в таблицу маршрутизации (B, AD 20 для eBGP и 200 для iBGP). i — путь получен от iBGP-соседа. Если путь без *, его следующий переход недоступен: включите next-hop-self на маршрутизаторе границы AS. iBGP не передаёт пути, полученные от другого iBGP-соседа (нужна полная связность).'));
      return () => {
        const d = app.net.getDevice(dev.id);
        if (!d.bgp) return;
        d.net.ensureRouting();
        UI.clear(peers);
        peers.append(tbl(['Сосед', 'AS', 'Тип', 'Состояние', 'next-hop-self', ''], (d.bgpPeers || []).map((p) => {
          const a = ip(p.n.ip);
          const st = p.state === 'Established' ? h('span', { class: 'st ok' }, 'Established') : h('span', { class: 'st bad', title: p.text || '' }, p.state + (p.text ? ' — ' + p.text : ''));
          return h('tr', null, h('td', { class: 'mono' }, a + (p.n.updateSource ? ' (' + UI.shortIf(p.n.updateSource) + ')' : '')), h('td', null, String(p.n.remoteAs)), h('td', null, p.ebgp ? 'eBGP' : 'iBGP'), h('td', null, st),
            h('td', null, p.ebgp ? '' : UI.toggle('', !!p.n.nextHopSelf, (on) => run(pfx.concat([(on ? '' : 'no ') + 'neighbor ' + a + ' next-hop-self'])))),
            h('td', null, delBtn(() => run(pfx.concat(['no neighbor ' + a + ' remote-as ' + p.n.remoteAs])))));
        }), 'Соседей нет'));
        table.textContent = showText(d, 'show ip bgp').split('\n').slice(5).join('\n') || '(пусто)';
      };
    }),
  };

  /* ================= редистрибуция и суммаризация ================= */

  const redistPage = {
    id: 'redist', label: 'Редистрибуция', group: 'routing',
    render: (app, dev, box) => page(app, dev, box, 'Редистрибуция маршрутов', (run, e) => {
      const targets = [];
      if (dev.rip && dev.rip.networks.length) targets.push({ key: 'rip', name: 'RIP', mode: 'router rip' });
      if (dev.ospf) targets.push({ key: 'ospf', name: 'OSPF ' + dev.ospf.pid, mode: 'router ospf ' + dev.ospf.pid });
      if (dev.eigrp) targets.push({ key: 'eigrp', name: 'EIGRP ' + dev.eigrp.asn, mode: 'router eigrp ' + dev.eigrp.asn });
      if (dev.bgp) targets.push({ key: 'bgp', name: 'BGP ' + dev.bgp.asn, mode: 'router bgp ' + dev.bgp.asn });
      const sources = [{ src: 'connected', name: 'Подключённые (connected)' }, { src: 'static', name: 'Статические (static)' }];
      if (dev.rip && dev.rip.networks.length) sources.push({ src: 'rip', name: 'RIP' });
      if (dev.ospf) sources.push({ src: 'ospf', id: dev.ospf.pid, name: 'OSPF ' + dev.ospf.pid });
      if (dev.eigrp) sources.push({ src: 'eigrp', id: dev.eigrp.asn, name: 'EIGRP ' + dev.eigrp.asn });
      if (dev.bgp) sources.push({ src: 'bgp', id: dev.bgp.asn, name: 'BGP ' + dev.bgp.asn });
      if (!targets.length) box.append(hint('Сначала запустите протокол маршрутизации (RIP, OSPF, EIGRP или BGP) — затем здесь можно передавать в него маршруты других источников.'));
      const EIGRP_DEF = '100000 100 255 1 1500';
      for (const t of targets) {
        const rules = (dev.redist && dev.redist[t.key]) || [];
        const rows = [];
        for (const s of sources) {
          if (s.src === t.key) continue;
          const r = rules.find((x) => x.src === s.src && (x.id || null) === (s.id || null));
          const srcTxt = s.src + (s.id != null ? ' ' + s.id : '');
          let metricTxt = t.key === 'eigrp' ? EIGRP_DEF : t.key === 'rip' ? '2' : '';
          if (r && r.metricVec) metricTxt = [r.metricVec.bw, r.metricVec.delay, r.metricVec.rel, r.metricVec.load, r.metricVec.mtu].join(' ');
          else if (r && r.metric != null) metricTxt = String(r.metric);
          const mI = h('input', { class: 'inp mono', value: metricTxt, placeholder: t.key === 'ospf' ? '20 (по умолчанию)' : '', style: { width: t.key === 'eigrp' ? '190px' : '110px' }, title: t.key === 'eigrp' ? 'полоса кбит/с, задержка (×10 мкс), надёжность, нагрузка, MTU' : 'метрика' });
          const typeSel = t.key === 'ospf' ? DW.select([['2', 'E2'], ['1', 'E1']], r && r.metricType === 1 ? '1' : '2') : null;
          const cmd = () => {
            let x = 'redistribute ' + srcTxt;
            if (mI.value.trim()) x += ' metric ' + mI.value.trim();
            if (typeSel && typeSel.value === '1') x += ' metric-type 1';
            if (t.key === 'ospf') x += ' subnets';
            return x;
          };
          rows.push(h('tr', null, h('td', null, s.name),
            h('td', null, UI.toggle('', !!r, (on) => run([t.mode, on ? cmd() : 'no redistribute ' + srcTxt]))),
            h('td', null, h('div', { class: 'row' }, mI, typeSel, r ? h('button', { class: 'btn outline small', onClick: () => run([t.mode, cmd()]) }, 'Применить') : null))));
        }
        box.append(DW.section('В ' + t.name), tbl(['Источник', 'Передавать', t.key === 'ospf' ? 'Метрика и тип' : 'Метрика'], rows, 'Других источников нет'));
      }
      if (targets.length) box.append(hint('Метрики у разных протоколов несовместимы, поэтому при редистрибуции метрику задают вручную: в RIP — число переходов, в OSPF — стоимость (по умолчанию 20; E2 — стоимость не растёт по пути, E1 — растёт), в EIGRP — пять чисел: полоса, задержка, надёжность, нагрузка, MTU (без метрики маршруты в EIGRP не попадут). В OSPF передаются и подсети (subnets). В таблице такие маршруты видны как O E2 / O E1, D EX, R, B.'));
      // суммаризация
      if (dev.ospf) {
        const area = num(1, 80, 0);
        const n = DW.ipInput('', 'сеть');
        const m = DW.ipInput('255.255.252.0', 'маска');
        box.append(DW.section('OSPF: суммаризация области (area range, на ABR)'), h('div', { class: 'row' }, h('span', null, 'область'), area, n, m, h('button', { class: 'btn primary small', onClick: () => {
          const a = DW.readIp(n, true);
          const b = DW.readIp(m, true);
          if (!a.ok || !b.ok) { e.textContent = a.err || b.err; return; }
          run(['router ospf ' + dev.ospf.pid, 'area ' + area.value + ' range ' + ip(a.v) + ' ' + ip(b.v)]);
        } }, 'Добавить')),
        tbl(['Область', 'Диапазон', ''], (dev.ospfRanges || []).map((r) => h('tr', null, h('td', null, String(r.area)), h('td', { class: 'mono' }, U.cidr(r.net, r.mask)),
          h('td', null, delBtn(() => run(['router ospf ' + dev.ospf.pid, 'no area ' + r.area + ' range ' + ip(r.net) + ' ' + ip(r.mask)]))))), 'Диапазонов нет'));
      }
      if (dev.eigrp) {
        const ifs = dev.ifaces.filter((f) => f.ip != null && !f.runtime && f.kind !== 'loop');
        const ifSel = DW.select(ifs.map((f) => [f.name, f.name]), ifs[0] ? ifs[0].name : '');
        const n = DW.ipInput('', 'сеть');
        const m = DW.ipInput('255.255.252.0', 'маска');
        const rows = [];
        for (const f of dev.ifaces) for (const s of f.eigrpSum || []) rows.push(h('tr', null, h('td', null, f.name), h('td', { class: 'mono' }, U.cidr(s.net, s.mask)),
          h('td', null, delBtn(() => run(['interface ' + f.name, 'no ip summary-address eigrp ' + s.asn + ' ' + ip(s.net) + ' ' + ip(s.mask)])))));
        box.append(DW.section('EIGRP: суммарный маршрут на интерфейсе'), h('div', { class: 'row' }, ifSel, n, m, h('button', { class: 'btn primary small', onClick: () => {
          const a = DW.readIp(n, true);
          const b = DW.readIp(m, true);
          if (!a.ok || !b.ok) { e.textContent = a.err || b.err; return; }
          if (!ifSel.value) return;
          run(['interface ' + ifSel.value, 'ip summary-address eigrp ' + dev.eigrp.asn + ' ' + ip(a.v) + ' ' + ip(b.v)]);
        } }, 'Добавить')), tbl(['Интерфейс', 'Суммарный маршрут', ''], rows, 'Нет'),
        hint('Через выбранный интерфейс вместо подробных сетей объявляется одна суммарная. На самом маршрутизаторе появляется маршрут в Null0 — он отбрасывает пакеты в несуществующие подсети диапазона и защищает от петель.'));
      }
      return null;
    }),
  };

  /* ================= IPv6: RIPng и OSPFv3 ================= */

  const ip6 = NS.ip6;
  const v6ifs = (dev) => dev.ifaces.filter((f) => !f.runtime && f.v6 && (f.v6.enabled || f.v6.addrs.length || f.v6.llManual != null));
  const v6addrs = (f) => (f.v6 ? f.v6.addrs.filter((a) => a.origin !== 'slaac').map((a) => ip6.str(a.addr, true) + '/' + a.plen).join(', ') : '');

  function needV6Routing(dev, box, run) {
    if (dev.v6cfg().routing) return false;
    box.append(hint('Сначала включите маршрутизацию IPv6 — без неё RIPng, OSPFv3 и DHCPv6-сервер не работают.'),
      h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn primary small', onClick: () => run(['ipv6 unicast-routing']) }, 'Включить ipv6 unicast-routing')));
    return true;
  }

  const ipv6RoutingPage = {
    id: 'ipv6dyn', label: 'IPv6: RIPng, OSPFv3', group: 'routing',
    render: (app, dev, box) => page(app, dev, box, 'Динамическая маршрутизация IPv6', (run, e) => {
      if (needV6Routing(dev, box, run)) return null;
      const ifs = v6ifs(dev);
      if (!ifs.length) box.append(hint('Ни на одном интерфейсе не включён IPv6. Задайте IPv6-адреса на страницах интерфейсов.'));
      // RIPng
      const rip = dev.ripng;
      const nameI = h('input', { class: 'inp', value: rip ? rip.name : 'RIPNG', style: { width: '140px' }, spellcheck: 'false' });
      const rname = () => (rip ? rip.name : nameI.value.trim() || 'RIPNG');
      box.append(DW.section('RIPng'), DW.form(lbl('Имя процесса'), rip ? h('div', { class: 'mono' }, rip.name) : nameI));
      box.append(tbl(['Интерфейс', 'Адреса', 'RIPng', 'Маршрут по умолчанию'], ifs.map((f) => {
        const r = f.v6r || {};
        const onR = !!(rip && r.rip === rip.name);
        return h('tr', null, h('td', null, f.name), h('td', { class: 'mono' }, v6addrs(f) || 'link-local'),
          h('td', null, UI.toggle('', onR, (v) => run(['interface ' + f.name, (v ? '' : 'no ') + 'ipv6 rip ' + rname() + ' enable']))),
          h('td', null, onR ? UI.toggle('', !!r.ripDefault, (v) => run(['interface ' + f.name, (v ? '' : 'no ') + 'ipv6 rip ' + rip.name + ' default-information originate'])) : null));
      }), 'Нет интерфейсов с IPv6'));
      if (rip) {
        box.append(DW.form(lbl('Передавать в RIPng'), h('div', { class: 'row' }, ['static', 'connected'].map((x) => UI.toggle(x, rip.redist.includes(x), (v) => run(['ipv6 router rip ' + rip.name, (v ? '' : 'no ') + 'redistribute ' + x])))),
          h('span'), h('button', { class: 'btn outline small danger', onClick: () => run(['no ipv6 router rip ' + rip.name]) }, 'Остановить RIPng')));
      }
      // OSPFv3
      const o = dev.ospf6;
      const pidI = num(o ? o.pid : 1, 90);
      const pid = () => (o ? o.pid : pidI.value);
      const rid = DW.ipInput(o && o.routerId != null ? U.ipStr(o.routerId) : '', 'например, 1.1.1.1');
      DW.commitOnChange(rid, () => {
        const r = DW.readIp(rid, false);
        if (!r.ok) { e.textContent = r.err; return; }
        run(['ipv6 router ospf ' + pid(), r.v == null ? 'no router-id' : 'router-id ' + U.ipStr(r.v)]);
      });
      box.append(DW.section('OSPFv3'), DW.form(lbl('Номер процесса'), o ? h('div', { class: 'mono' }, String(o.pid)) : pidI, lbl('Router ID'), rid));
      if (o && !NS.routing6.ospf6Rid(dev)) box.append(h('div', { class: 'err-text' }, 'Router ID не выбран: у маршрутизатора нет IPv4-адресов. Задайте router-id (любое число в виде IPv4-адреса, уникальное в сети).'));
      box.append(tbl(['Интерфейс', 'Адреса', 'Область', 'Стоимость', ''], ifs.map((f) => {
        const r = f.v6r || {};
        const cur = o && r.ospf && r.ospf.pid === o.pid ? String(r.ospf.area) : '';
        const areaI = h('input', { class: 'inp', value: cur, placeholder: 'выкл.', style: { width: '80px' } });
        DW.commitOnChange(areaI, () => {
          const v = areaI.value.trim();
          run(['interface ' + f.name, v === '' ? 'no ipv6 ospf ' + pid() + ' area ' + (cur || '0') : 'ipv6 ospf ' + pid() + ' area ' + v]);
        });
        const costI = h('input', { class: 'inp', type: 'number', min: 1, value: r.cost != null ? r.cost : '', placeholder: 'авто', style: { width: '80px' } });
        DW.commitOnChange(costI, () => run(['interface ' + f.name, costI.value ? 'ipv6 ospf cost ' + costI.value : 'no ipv6 ospf cost']));
        return h('tr', null, h('td', null, f.name), h('td', { class: 'mono' }, v6addrs(f) || 'link-local'), h('td', null, areaI), h('td', null, costI),
          h('td', null, o && cur ? UI.toggle('passive', o.passive.includes(f.name), (v) => run(['ipv6 router ospf ' + o.pid, (v ? '' : 'no ') + 'passive-interface ' + f.name])) : null));
      }), 'Нет интерфейсов с IPv6'));
      if (o) {
        box.append(DW.form(lbl('Передавать в OSPFv3'), h('div', { class: 'row' }, ['static', 'connected'].map((x) => UI.toggle(x, o.redist.includes(x), (v) => run(['ipv6 router ospf ' + o.pid, (v ? '' : 'no ') + 'redistribute ' + x])))),
          lbl('default-information originate'), UI.toggle('', o.defaultOriginate, (v) => run(['ipv6 router ospf ' + o.pid, v ? 'default-information originate' : 'no default-information originate'])),
          h('span'), h('button', { class: 'btn outline small danger', onClick: () => run(['no ipv6 router ospf ' + o.pid]) }, 'Остановить OSPFv3')));
      }
      const nb = h('div');
      const rt = pre();
      box.append(DW.section('Соседи'), nb, DW.section('Маршруты RIPng и OSPFv3'), rt,
        hint('В IPv6 протоколы включаются прямо на интерфейсах (ipv6 rip ИМЯ enable, ipv6 ospf N area A), а не командой network. Соседи общаются по link-local адресам — они же становятся следующими переходами в таблице маршрутизации. OSPFv3 берёт Router ID из IPv4-адресов; если их нет, задайте router-id вручную.'));
      return () => {
        const d = app.net.getDevice(dev.id);
        d.net.ensureRouting();
        UI.clear(nb);
        const rows = (d.ripngNeighbors || []).map((n) => h('tr', null, h('td', null, 'RIPng'), h('td', null, n.dev.name), h('td', { class: 'mono' }, ip6.str(n.ll, true)), h('td', null, n.ifname), h('td', null, '')))
          .concat((d.ospf6Neighbors || []).map((n) => h('tr', null, h('td', null, 'OSPFv3'), h('td', null, n.dev.name + ' (' + U.ipStr(n.id) + ')'), h('td', { class: 'mono' }, ip6.str(n.ll, true)), h('td', null, n.ifname), h('td', null, n.state))));
        nb.append(tbl(['Протокол', 'Сосед', 'Link-local', 'Интерфейс', 'Состояние'], rows, 'Соседей нет'));
        rt.textContent = (d.dynRoutes6 || []).map((r) => (r.type + (r.sub || '')).padEnd(4) + ip6.cidr(r.net, r.plen, true) + ' [' + r.ad + '/' + r.metric + '] via ' + ip6.str(r.nextHop, true) + ', ' + r.ifc.name).join('\n') || '(нет)';
      };
    }),
  };

  /* ================= DHCPv6-сервер ================= */

  const dhcp6Page = {
    id: 'dhcp6', label: 'DHCPv6',
    render: (app, dev, box) => page(app, dev, box, 'DHCPv6-сервер', (run, e) => {
      if (needV6Routing(dev, box, run)) return null;
      const pools = dev.dhcp6Pools || {};
      const nameI = h('input', { class: 'inp', placeholder: 'имя пула', style: { width: '120px' }, spellcheck: 'false' });
      const pfxI = h('input', { class: 'inp mono', placeholder: '2001:DB8:1::/64 (пусто — без адресов)', spellcheck: 'false', style: { width: '260px' } });
      const dnsI = h('input', { class: 'inp mono', placeholder: 'DNS IPv6', spellcheck: 'false' });
      const domI = h('input', { class: 'inp', placeholder: 'домен', style: { width: '130px' } });
      box.append(h('div', { class: 'row', style: { flexWrap: 'wrap' } }, nameI, pfxI, dnsI, domI, h('button', { class: 'btn primary small', onClick: () => {
        const n = nameI.value.trim();
        if (!n) { e.textContent = 'Укажите имя пула'; return; }
        const cmds = ['ipv6 dhcp pool ' + n];
        if (pfxI.value.trim()) cmds.push('address prefix ' + pfxI.value.trim());
        if (dnsI.value.trim()) cmds.push('dns-server ' + dnsI.value.trim());
        if (domI.value.trim()) cmds.push('domain-name ' + domI.value.trim());
        run(cmds);
      } }, 'Создать / изменить')));
      box.append(tbl(['Пул', 'Префикс адресов', 'DNS', 'Домен', ''], Object.entries(pools).map(([k, p]) => h('tr', null, h('td', null, k),
        h('td', { class: 'mono' }, p.prefix ? ip6.cidr(p.prefix.net, p.prefix.plen, true) : 'нет (только DNS)'), h('td', { class: 'mono' }, p.dns.map((x) => ip6.str(x, true)).join(', ') || '—'), h('td', null, p.domain || '—'),
        h('td', null, delBtn(() => run(['no ipv6 dhcp pool ' + k]))))), 'Пулов нет'));
      const ifs = v6ifs(dev).filter((f) => f.kind !== 'loop');
      const poolOpts = [['', 'выключен']].concat(Object.keys(pools).map((k) => [k, k]));
      box.append(DW.section('Интерфейсы'), tbl(['Интерфейс', 'DHCPv6-сервер', 'Флаг M (адрес)', 'Флаг O (DNS)'], ifs.map((f) => {
        const r = f.v6r || {};
        return h('tr', null, h('td', null, f.name),
          h('td', null, DW.select(poolOpts, r.dhcpServer || '', (v) => run(['interface ' + f.name, v ? 'ipv6 dhcp server ' + v : 'no ipv6 dhcp server']))),
          h('td', null, UI.toggle('', !!r.ndM, (v) => run(['interface ' + f.name, (v ? '' : 'no ') + 'ipv6 nd managed-config-flag']))),
          h('td', null, UI.toggle('', !!r.ndO, (v) => run(['interface ' + f.name, (v ? '' : 'no ') + 'ipv6 nd other-config-flag']))));
      }), 'Нет интерфейсов с IPv6'));
      const bind = h('div');
      box.append(DW.section('Выданные адреса'), bind,
        hint('С сохранением состояния (stateful): в пуле есть address prefix, на интерфейсе — ipv6 dhcp server и флаг M; компьютер в режиме «Автоматически (DHCPv6)» получает адрес и DNS, а шлюз — из Router Advertisement. Без сохранения состояния (stateless): в пуле только DNS и домен, флаг O; компьютер берёт адрес по SLAAC, а DNS — у DHCPv6-сервера.'));
      return () => {
        const d = app.net.getDevice(dev.id);
        UI.clear(bind);
        const list = d.dhcp6Rt ? [...d.dhcp6Rt.bindings.values()] : [];
        bind.append(tbl(['Адрес', 'Клиент (link-local)', 'Пул', 'Интерфейс', 'Состояние'], list.map((b) => h('tr', null, h('td', { class: 'mono' }, ip6.str(b.addr, true)), h('td', { class: 'mono' }, ip6.str(b.ll, true)),
          h('td', null, b.pool), h('td', null, b.ifname), h('td', null, b.state === 'bound' ? h('span', { class: 'st ok' }, 'выдан') : 'предложен'))), 'Пока никому'));
      };
    }),
  };

  DW.routerPages = [eigrpPage, bgpPage, redistPage, ipv6RoutingPage].concat(DW.routerPages || []);
  const at = DW.routerPages.findIndex((x) => x.id === 'ipv6');
  DW.routerPages.splice(at >= 0 ? at + 1 : DW.routerPages.length, 0, dhcp6Page);

  /* ================= интерфейс: HSRP / VRRP / GLBP ================= */

  const PROTO = [['hsrp', 'HSRP', 'standby'], ['vrrp', 'VRRP', 'vrrp'], ['glbp', 'GLBP', 'glbp']];
  const baseExtra = DW.routerIfaceExtra;
  DW.routerIfaceExtra = function (app, dev, f, run) {
    const rows = baseExtra ? baseExtra(app, dev, f, run) : [];
    if (f.kind === 'loop' || f.kind === 'tunnel' || f.kind === 'vtemplate' || f.ip == null) return rows;
    const groups = [];
    for (const [key, name, cmd] of PROTO) {
      for (const [g, c] of Object.entries((f.fhrp && f.fhrp[key]) || {})) {
        const rt = f.fhrpRt && f.fhrpRt[key] && f.fhrpRt[key][g];
        const st = rt ? rt.state : 'Init';
        const good = st === 'Active' || st === 'Master';
        groups.push(h('tr', null, h('td', null, name + ' ' + g), h('td', { class: 'mono' }, c.ip != null ? ip(c.ip) : '—'), h('td', null, String(c.prio)),
          h('td', null, UI.toggle('', key === 'vrrp' ? c.preempt !== false : !!c.preempt, (on) => run([(on ? '' : 'no ') + cmd + ' ' + g + ' preempt']))),
          h('td', null, h('span', { class: 'st ' + (good ? 'ok' : st === 'Init' ? 'bad' : '') }, st)),
          h('td', null, delBtn(() => run(['no ' + cmd + ' ' + g])))));
      }
    }
    const proto = DW.select(PROTO.map((p) => [p[0], p[1]]), 'hsrp');
    const g = num(1, 70, 0);
    const vip = DW.ipInput('', 'виртуальный IP');
    const prio = num(100, 80, 1);
    const pre = UI.toggle('preempt', true, () => {});
    const e = err();
    const add = h('button', { class: 'btn primary small', onClick: () => {
      const r = DW.readIp(vip, true);
      if (!r.ok) { e.textContent = r.err; return; }
      const cmd = PROTO.find((p) => p[0] === proto.value)[2];
      const on = pre.querySelector('input') ? pre.querySelector('input').checked : true;
      run([cmd + ' ' + g.value + ' ip ' + ip(r.v), cmd + ' ' + g.value + ' priority ' + prio.value, (on ? '' : 'no ') + cmd + ' ' + g.value + ' preempt']);
    } }, 'Добавить');
    rows.push(lbl('Резервирование шлюза'), h('div', null,
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, proto, h('span', null, 'группа'), g, vip, h('span', null, 'приоритет'), prio, pre, add),
      groups.length ? tbl(['Группа', 'Виртуальный IP', 'Приоритет', 'Preempt', 'Состояние', ''], groups) : null,
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, 'Два маршрутизатора делят один виртуальный адрес шлюза: компьютеры указывают его, а при отказе активного маршрутизатора адрес подхватывает резервный. GLBP ещё и распределяет компьютеры между маршрутизаторами.'),
      e));
    return rows;
  };
})(globalThis.NetLab = globalThis.NetLab || {});
