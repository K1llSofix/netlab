/* NetLab UI — новые программы рабочего стола: MIB Browser, NetFlow Collector, VPN, PPPoE Dialer, Dial-up,
 * IP Communicator, Bluetooth, IoT Monitor, IoX IDE. Состояние каждой программы хранится в app.deskState(id). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const ipT = DW.ipText;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });
  const hint = (t) => h('div', { class: 'hint-box', style: { marginTop: '10px' } }, t);
  const inp = (st, key, attrs) => {
    const i = h('input', Object.assign({ class: 'inp', value: st[key] == null ? '' : st[key], spellcheck: 'false' }, attrs || {}));
    i.addEventListener('input', () => { st[key] = i.value; });
    return i;
  };
  const dev0 = (app, id) => app.net.getDevice(id);
  const refresh = (app) => { app.needRender = true; app.scheduleRefresh(); };
  const status = (ok, text) => h('div', { class: 'desk-status' + (ok ? ' ok' : ok === false ? ' warn' : '') }, text);

  /* ================= значки ================= */

  DW.appGlyphs = Object.assign(DW.appGlyphs || {}, {
    mib: (s, W) => [s('path', { d: 'M24 8v8M24 16H12v8M24 16h12v8M12 24v6M36 24v6M24 16v14', stroke: W, 'stroke-width': 2.4, fill: 'none' }), s('circle', { cx: 24, cy: 8, r: 3.5, fill: W }), s('circle', { cx: 12, cy: 33, r: 3.5, fill: W }), s('circle', { cx: 24, cy: 33, r: 3.5, fill: W }), s('circle', { cx: 36, cy: 33, r: 3.5, fill: W })],
    netflow: (s, W) => [s('path', { d: 'M8 38V26M16 38V18M24 38V22M32 38V12M40 38V28', stroke: W, 'stroke-width': 4, 'stroke-linecap': 'round' })],
    vpn: (s, W) => [s('rect', { x: 13, y: 22, width: 22, height: 17, rx: 2.5, fill: W }), s('path', { d: 'M17 22v-5a7 7 0 0 1 14 0v5', stroke: W, 'stroke-width': 3, fill: 'none' })],
    pppoe: (s, W) => [s('path', { d: 'M6 24h10M32 24h10', stroke: W, 'stroke-width': 3 }), s('rect', { x: 16, y: 16, width: 16, height: 16, rx: 3, fill: 'none', stroke: W, 'stroke-width': 2.6 }), s('text', { x: 24, y: 28, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: W, 'font-family': 'Segoe UI, sans-serif' }, 'PPP')],
    dialup: (s, W) => [s('path', { d: 'M14 12c3-3 6-3 8 0l3 5c1 2-.5 4-2.5 5 2 4 5 7 9 9 1-2 3-3.5 5-2.5l5 3c3 2 3 5 0 8-8 6-30-16-27.5-27.5z', fill: W })],
    ipc: (s, W) => [s('rect', { x: 6, y: 10, width: 36, height: 24, rx: 2, fill: 'none', stroke: W, 'stroke-width': 2.4 }), s('path', { d: 'M18 16c1.5-1.5 3-1.5 4 0l1 2c.5 1-.2 1.6-1 2.2.8 1.6 2 2.8 3.6 3.6.6-.8 1.3-1.5 2.2-1l2 1c1.5 1 1.5 2.2 0 3.6-4 3-13-5.8-11.8-11.4z', fill: W }), s('path', { d: 'M18 40h12', stroke: W, 'stroke-width': 2.4 })],
    bt: (s, W) => [s('path', { d: 'M17 16l14 14-7 6V12l7 6-14 14', stroke: W, 'stroke-width': 3, fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })],
    iotmon: (s, W) => [s('path', { d: 'M24 7L7 21h5v17h24V21h5z', fill: 'none', stroke: W, 'stroke-width': 2.6, 'stroke-linejoin': 'round' }), s('circle', { cx: 24, cy: 27, r: 4, fill: W }), s('path', { d: 'M17 22a9 9 0 0 1 14 0', stroke: W, 'stroke-width': 2, fill: 'none' })],
    ioxide: (s, W) => [s('path', { d: 'M16 14l-9 10 9 10M32 14l9 10-9 10M27 10l-6 28', stroke: W, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })],
  });

  /* ================= MIB Browser ================= */

  function mibApp(app, id, box, st) {
    const m = (st.mib = st.mib || { target: '', rcom: 'public', wcom: 'private', oid: '1.3.6.1.2.1.1.5.0', op: 'get', value: '', rows: [], busy: false, open: {} });
    const e = err();
    const target = inp(m, 'target', { class: 'inp mono', placeholder: 'адрес агента' });
    const rcom = inp(m, 'rcom');
    const wcom = inp(m, 'wcom');
    const oid = inp(m, 'oid', { class: 'inp mono' });
    const val = inp(m, 'value', { placeholder: 'значение для SET' });
    const op = DW.select([['get', 'Get'], ['getnext', 'Get Next'], ['getbulk', 'Get Bulk'], ['walk', 'Walk'], ['set', 'Set']], m.op, (v) => { m.op = v; valRow.style.display = v === 'set' ? '' : 'none'; });
    const valRow = h('div', { style: { display: m.op === 'set' ? '' : 'none' } }, DW.form(lbl('Значение'), val));
    const res = h('div');
    const draw = () => {
      UI.clear(res);
      res.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Имя/OID'), h('th', null, 'Значение'), h('th', null, 'Тип'), h('th', null, 'IP:порт')),
        m.rows.length ? m.rows.slice(-300).map((r) => h('tr', null, h('td', { class: 'mono' }, (r.name ? r.name + ' ' : '') + '(' + r.oid + ')'), h('td', { class: 'mono' }, String(r.value)), h('td', null, r.type || ''), h('td', { class: 'mono' }, r.ip)))
          : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Результатов нет'))));
    };
    const go = () => {
      const d = dev0(app, id);
      const ip = U.parseIp(m.target.trim());
      if (ip == null) { e.textContent = 'Укажите IP-адрес агента (маршрутизатора или коммутатора)'; return; }
      e.textContent = '';
      const ipS = U.ipStr(ip) + ':161';
      const add = (vb) => m.rows.push({ oid: vb.oid, name: vb.name, value: vb.value, type: vb.type || typeof vb.value, ip: ipS });
      const done = (r) => {
        m.busy = false;
        if (!r.ok) e.textContent = r.text || ('Ошибка: ' + r.error);
        else if (r.varbinds) r.varbinds.forEach(add);
        if (box.isConnected) draw();
      };
      m.busy = true;
      const oidS = m.oid.trim();
      if (m.op === 'walk') d.snmpWalk(ip, m.rcom, oidS, (vb) => { add(vb); if (box.isConnected) draw(); }, (r) => { m.busy = false; if (!r.ok && r.error !== 'endOfMib') e.textContent = r.text || r.error; });
      else if (m.op === 'set') {
        const v = /^-?\d+$/.test(m.value.trim()) ? Number(m.value.trim()) : m.value;
        d.snmpRequest(ip, m.wcom, 'set', [{ oid: oidS, value: v }], done);
      } else d.snmpRequest(ip, m.rcom, m.op, m.op === 'getbulk' ? oidS : [oidS], done);
    };
    const tree = h('div', { class: 'mib-tree' });
    const node = (n, depth) => {
      const has = n.children && n.children.length;
      const row = h('div', { class: 'mib-node' + (m.oid === n.oid ? ' on' : ''), style: { paddingLeft: (6 + depth * 14) + 'px' }, title: n.desc + ' — ' + n.oid },
        has ? h('span', { class: 'mib-tw' }, m.open[n.oid] ? '▾' : '▸') : h('span', { class: 'mib-tw' }, '·'), h('span', null, n.name + (n.rw ? ' ✎' : '')));
      row.addEventListener('click', () => {
        if (has) m.open[n.oid] = !m.open[n.oid];
        m.oid = n.oid;
        oid.value = n.oid;
        m.op = n.table || has ? 'walk' : 'get';
        op.value = m.op;
        valRow.style.display = 'none';
        drawTree();
      });
      const out = [row];
      if (has && m.open[n.oid]) for (const c of n.children) out.push(...node(c, depth + 1));
      return out;
    };
    const drawTree = () => { UI.clear(tree); tree.append(h('div', { class: 'mib-node head' }, 'MIB-II (1.3.6.1.2.1)'), ...NS.snmp.MIB_TREE.flatMap((n) => node(n, 0))); };
    drawTree();
    box.append(DW.form(lbl('Адрес агента'), target, lbl('Read community'), rcom, lbl('Write community'), wcom),
      h('div', { class: 'mib-main' }, tree, h('div', { class: 'grow' }, DW.form(lbl('OID'), oid, lbl('Операция'), op), valRow,
        h('div', { class: 'row', style: { margin: '8px 0' } }, h('button', { class: 'btn primary small', onClick: go }, 'Выполнить'), h('button', { class: 'btn outline small', onClick: () => { m.rows = []; draw(); } }, 'Очистить'), e), res)),
      hint('На маршрутизаторе или коммутаторе нужна community: snmp-server community public RO (и private RW для SET). Выберите объект в дереве MIB слева: для таблиц используйте Walk.'));
    draw();
    return null;
  }

  /* ================= NetFlow Collector ================= */

  function netflowApp(app, id, box) {
    const d = dev0(app, id);
    const c = d.collector || { enabled: false, port: 9996 };
    const e = err();
    const port = h('input', { class: 'inp', type: 'number', min: 1, max: 65535, value: c.port, style: { width: '110px' } });
    const list = h('div');
    box.append(DW.form(lbl('Коллектор'), UI.toggle(c.enabled ? 'Включён' : 'Выключен', c.enabled, (on) => DW.apply(app, () => dev0(app, id).setCollector(on, Number(port.value)), e)),
      lbl('UDP-порт'), port, h('div', { class: 'full' }, e)),
    h('div', { class: 'row', style: { margin: '8px 0' } }, h('button', { class: 'btn outline small', onClick: () => { dev0(app, id).collected.length = 0; live(); } }, 'Очистить записи')), list,
    hint('Маршрутизатор с ip flow ingress/egress и ip flow-export destination <адрес этого компьютера> ' + c.port + ' присылает сюда записи о потоках: кто с кем обменивался трафиком, сколько пакетов и байт.'));
    const live = () => {
      const x = dev0(app, id);
      if (!x) return;
      const recs = x.collected || [];
      const agg = new Map();
      for (const r of recs) {
        const k = [r.exporter, r.src, r.dst, r.proto, r.sport, r.dport].join('|');
        const a = agg.get(k) || Object.assign({}, r, { pkts: 0, bytes: 0 });
        a.pkts += r.pkts || 0;
        a.bytes += r.bytes || 0;
        agg.set(k, a);
      }
      UI.clear(list);
      list.append(h('div', { class: 'muted' }, 'Получено записей: ' + recs.length + ', потоков: ' + agg.size),
        h('table', { class: 'tbl' }, h('tr', null, ['Экспортёр', 'Источник', 'Назначение', 'Протокол', 'Порты', 'Интерфейс', 'Пакетов', 'Байт'].map((t) => h('th', null, t))),
          agg.size ? [...agg.values()].slice(-200).map((r) => h('tr', null, h('td', null, r.exporter), h('td', { class: 'mono' }, r.src), h('td', { class: 'mono' }, r.dst), h('td', null, r.proto),
            h('td', { class: 'mono' }, r.sport != null ? r.sport + ' → ' + r.dport : ''), h('td', null, (r.input || '') + (r.output ? ' → ' + r.output : '')), h('td', null, String(r.pkts)), h('td', null, String(r.bytes))))
            : h('tr', { class: 'empty' }, h('td', { colspan: 8 }, 'Записей пока нет'))));
    };
    live();
    return live;
  }

  /* ================= VPN (Easy VPN) ================= */

  function vpnApp(app, id, box, st) {
    const v = (st.vpnForm = st.vpnForm || { server: '', group: '', key: '', user: '', pass: '', busy: false });
    const e = err();
    const stat = h('div');
    const btn = h('button', { class: 'btn primary small' });
    btn.addEventListener('click', () => {
      const d = dev0(app, id);
      if (d.vpn && d.vpn.state === 'up') { app.mutate(() => d.vpnDisconnect()); refresh(app); return; }
      v.busy = true;
      e.textContent = '';
      d.vpnConnect(v.server.trim(), v.group, v.key, v.user, v.pass, (r) => { v.busy = false; if (!r.ok) e.textContent = r.error; refresh(app); });
      refresh(app);
    });
    box.append(DW.form(lbl('Группа'), inp(v, 'group'), lbl('Ключ группы'), inp(v, 'key', { type: 'password' }), lbl('VPN-сервер'), inp(v, 'server', { class: 'inp mono', placeholder: 'IP-адрес маршрутизатора' }),
      lbl('Пользователь'), inp(v, 'user'), lbl('Пароль'), inp(v, 'pass', { type: 'password' }), h('span'), h('div', { class: 'row' }, btn, e)), stat,
    hint('Удалённый доступ Easy VPN. На маршрутизаторе: aaa new-model, username …, ip local pool VPNPOOL …, crypto isakmp policy 10 (authentication pre-share), crypto isakmp client configuration group <группа> с key и pool. После подключения компьютер получает адрес из пула, и трафик во внутреннюю сеть идёт зашифрованным (ESP).'));
    return () => {
      const d = dev0(app, id);
      if (!d) return;
      const x = d.vpn;
      btn.textContent = x && x.state === 'up' ? 'Отключиться' : v.busy ? 'Подключение…' : 'Подключиться';
      btn.disabled = v.busy;
      UI.clear(stat);
      stat.append(x && x.state === 'up' ? status(true, '✓ Подключено к ' + U.ipStr(x.server) + ', адрес в VPN: ' + U.ipStr(x.vip) + (x.split ? ' (split tunnel)' : ' (весь трафик через туннель)'))
        : status(null, x ? x.text : 'Не подключено'));
    };
  }

  /* ================= PPPoE Dialer ================= */

  function pppoeApp(app, id, box, st) {
    const v = (st.pppoe = st.pppoe || { user: '', pass: '', busy: false });
    const e = err();
    const stat = h('div');
    const btn = h('button', { class: 'btn primary small' });
    btn.addEventListener('click', () => {
      const d = dev0(app, id);
      if (d.pppoeClient && d.pppoeClient.state === 'up') { app.mutate(() => d.pppoeDisconnect()); refresh(app); return; }
      v.busy = true;
      e.textContent = '';
      d.pppoeConnect(v.user, v.pass, (r) => { v.busy = false; if (!r.ok) e.textContent = r.error; refresh(app); });
      refresh(app);
    });
    box.append(DW.form(lbl('Имя пользователя'), inp(v, 'user'), lbl('Пароль'), inp(v, 'pass', { type: 'password' }), h('span'), h('div', { class: 'row' }, btn, e)), stat,
      hint('PPPoE как у домашнего провайдера: компьютер ищет сервер доступа (PADI/PADO), открывает сеанс, проходит CHAP или PAP и получает адрес по IPCP. На маршрутизаторе: username …, ip local pool, bba-group pppoe, interface Virtual-Template (peer default ip address pool, ppp authentication chap), pppoe enable group на интерфейсе к клиентам.'));
    return () => {
      const d = dev0(app, id);
      if (!d) return;
      const x = d.pppoeClient;
      btn.textContent = x && x.state === 'up' ? 'Отключиться' : v.busy ? 'Подключение…' : 'Подключиться';
      btn.disabled = v.busy;
      UI.clear(stat);
      stat.append(x && x.state === 'up' ? status(true, '✓ Подключено к ' + (x.ac || 'серверу') + ', сеанс ' + x.sid + ', адрес ' + U.ipStr(x.ip) + ', шлюз ' + U.ipStr(x.peer)) : status(null, x ? x.text : 'Не подключено'));
    };
  }

  /* ================= Dial-up ================= */

  function dialupApp(app, id, box, st) {
    const v = (st.dial = st.dial || { number: '', user: '', pass: '', busy: false, nu: '', np: '' });
    const d = dev0(app, id);
    const e = err();
    const e2 = err();
    const stat = h('div');
    const btn = h('button', { class: 'btn primary small' });
    btn.addEventListener('click', () => {
      const x = dev0(app, id);
      if (x.dialup && (x.dialup.state === 'up' || x.dialup.state === 'dialing')) { app.mutate(() => x.hangup()); refresh(app); return; }
      v.busy = true;
      e.textContent = '';
      x.dial(v.number.trim(), v.user, v.pass, (r) => { v.busy = false; if (!r.ok) e.textContent = r.error; refresh(app); });
      refresh(app);
    });
    const di = d.dialin || { enabled: false, ip: null, pool: null, users: [] };
    const myIp = DW.ipInput(ipT(di.ip), 'например 10.10.10.1');
    const peerIp = DW.ipInput(ipT(di.pool), 'например 10.10.10.2');
    const users = h('div');
    const drawUsers = () => {
      const c = dev0(app, id).dialin || di;
      UI.clear(users);
      users.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Пользователь'), h('th')),
        c.users.length ? c.users.map((u, i) => h('tr', null, h('td', null, u.user), h('td', null, h('button', { class: 'btn icon small danger', onClick: () => DW.apply(app, () => dev0(app, id).dialinCfg().users.splice(i, 1)) }, UI.icon('delete')))))
          : h('tr', { class: 'empty' }, h('td', { colspan: 2 }, 'Нет пользователей'))));
    };
    const saveIn = (enabled) => {
      const a = DW.readIp(myIp, false);
      if (!a.ok) { e2.textContent = a.err; return; }
      const b = DW.readIp(peerIp, false);
      if (!b.ok) { e2.textContent = b.err; return; }
      DW.apply(app, () => dev0(app, id).setDialin({ enabled, ip: a.v, pool: b.v }), e2, true);
    };
    const nu = inp(v, 'nu', { placeholder: 'имя' });
    const np = inp(v, 'np', { placeholder: 'пароль' });
    box.append(DW.section('Позвонить'), DW.form(lbl('Номер'), inp(v, 'number', { class: 'inp mono', placeholder: 'например 5551001' }), lbl('Пользователь'), inp(v, 'user'), lbl('Пароль'), inp(v, 'pass', { type: 'password' }),
      h('span'), h('div', { class: 'row' }, btn, e)), stat,
    DW.section('Принимать звонки (Dial-in)'), DW.form(lbl('Приём звонков'), UI.toggle(di.enabled ? 'Включён' : 'Выключен', di.enabled, (on) => saveIn(on)),
      lbl('Мой адрес'), myIp, lbl('Адрес звонящего'), peerIp, h('span'), h('button', { class: 'btn outline small', onClick: () => saveIn(!!(dev0(app, id).dialin || {}).enabled) }, 'Сохранить адреса'), h('div', { class: 'full' }, e2)),
    h('div', { class: 'row' }, nu, np, h('button', { class: 'btn outline small', onClick: () => DW.apply(app, () => { if (!v.nu.trim() || !v.np) throw new Error('Укажите имя и пароль'); dev0(app, id).dialinCfg().users.push({ user: v.nu.trim(), pass: v.np }); }, e2) }, 'Добавить пользователя')), users,
    hint('Модем PT-HOST-NM-1AM подключается телефонным кабелем к порту Modem облака Cloud-PT. Номера портов задаются в настройках облака. Принимающий компьютер проверяет логин и пароль и выдаёт звонящему адрес — получается канал PPP «точка-точка».'));
    drawUsers();
    return () => {
      const x = dev0(app, id);
      if (!x) return;
      const s0 = x.dialup;
      btn.textContent = s0 && s0.state === 'up' ? 'Положить трубку' : s0 && s0.state === 'dialing' ? 'Отменить' : 'Позвонить';
      UI.clear(stat);
      stat.append(s0 && s0.state === 'up' ? status(true, '✓ ' + s0.text + ' · мой адрес ' + U.ipStr(x.iface.ip) + ', собеседник ' + U.ipStr(x.iface.peer)) : status(null, s0 ? s0.text : 'Нет соединения'));
      drawUsers();
    };
  }

  /* ================= IP Communicator ================= */

  function ipcApp(app, id, box, st) {
    const v = (st.ipc = st.ipc || { tftp: '' });
    const d = dev0(app, id);
    if (!v.tftp && d.ipcTftp != null) v.tftp = U.ipStr(d.ipcTftp);
    const e = err();
    const top = h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', null, 'TFTP-сервер (CME)'), inp(v, 'tftp', { class: 'inp mono', style: { width: '160px' } }),
      h('button', { class: 'btn primary small', onClick: () => {
        const ip = U.parseIp(v.tftp.trim());
        if (ip == null) { e.textContent = 'Укажите IP-адрес CME'; return; }
        e.textContent = '';
        app.mutate(() => dev0(app, id).ipcStart(ip));
        refresh(app);
      } }, 'Включить'),
      h('button', { class: 'btn outline small', onClick: () => { dev0(app, id).ipcStop(); refresh(app); } }, 'Выключить'), e);
    box.append(top);
    const live = DW.phoneWidget(app, id, () => dev0(app, id).softphone || null, box, st);
    box.append(hint('Программный телефон Cisco IP Communicator: регистрируется на CME как ещё один телефон (тип CIPC) и получает номер через auto assign.'));
    live();
    return live;
  }

  /* ================= Bluetooth ================= */

  const TRACKS = ['Бетховен — «К Элизе»', 'Моцарт — Турецкий марш', 'Джаз-радио', 'Подкаст о сетях', 'Шум дождя'];

  function btApp(app, id, box, st) {
    const B = NS.bt;
    const v = (st.bt = st.bt || { found: [], track: TRACKS[0], file: '' });
    const e = err();
    const list = h('div');
    const player = h('div');
    const act = (fn, okMsg) => { const r = fn(); if (r) { e.textContent = r; return false; } e.textContent = ''; if (okMsg) UI.toast(okMsg, 'ok', 1500); refresh(app); return true; };
    const scan = () => { v.found = B.scan(dev0(app, id)).map((x) => x.dev.id); if (!v.found.length) e.textContent = 'Никого не найдено: устройство Bluetooth должно быть включено и находиться рядом (до ' + B.RANGE + ' точек на схеме).'; else e.textContent = ''; live(); refresh(app); };
    const d = dev0(app, id);
    box.append(DW.form(lbl('Bluetooth'), UI.toggle(B.cfg(d).on ? 'Включён' : 'Выключен', B.cfg(d).on, (on) => { B.setOn(dev0(app, id), on); refresh(app); })),
      h('div', { class: 'row', style: { margin: '8px 0' } }, h('button', { class: 'btn primary small', onClick: scan }, 'Поиск устройств'), e), list, player);
    const live = () => {
      const x = dev0(app, id);
      if (!x) return;
      const c = B.cfg(x);
      const ids = [...new Set(v.found.concat(c.paired))];
      UI.clear(list);
      list.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Устройство'), h('th', null, 'Расстояние'), h('th', null, 'Состояние'), h('th')),
        ids.length ? ids.map((oid) => {
          const o = app.net.getDevice(oid);
          if (!o) return null;
          const paired = c.paired.includes(oid);
          const audio = x.btRt && x.btRt.audio === oid;
          const btns = [];
          if (!paired) btns.push(h('button', { class: 'btn small primary', onClick: async () => {
            const pin = B.isAudio(o) ? await UI.prompt('Сопряжение с ' + o.name, 'PIN-код устройства (обычно 0000):', '0000') : null;
            if (B.isAudio(o) && pin == null) return;
            act(() => B.pair(dev0(app, id), app.net.getDevice(oid), pin), 'Сопряжено с ' + o.name);
          } }, 'Сопряжение'));
          else {
            if (B.isAudio(o)) btns.push(audio ? h('button', { class: 'btn small outline', onClick: () => { B.disconnectAudio(dev0(app, id)); refresh(app); } }, 'Отключить звук') : h('button', { class: 'btn small primary', onClick: () => act(() => B.connectAudio(dev0(app, id), app.net.getDevice(oid))) }, 'Подключить звук'));
            else btns.push(h('button', { class: 'btn small outline', onClick: () => {
              const f = (dev0(app, id).files || []).find((z) => z.name === v.file) || (dev0(app, id).files || [])[0];
              if (!f) { e.textContent = 'Нет файлов — создайте файл в программе Text Editor'; return; }
              act(() => B.sendFile(dev0(app, id), app.net.getDevice(oid), f), 'Файл «' + f.name + '» отправлен на ' + o.name);
            } }, 'Отправить файл'));
            btns.push(h('button', { class: 'btn icon small danger', title: 'Забыть устройство', onClick: () => { B.unpair(dev0(app, id), app.net.getDevice(oid)); refresh(app); } }, UI.icon('delete')));
          }
          return h('tr', null, h('td', null, o.name + ' (' + UI.typeLabel(o.type) + ')'), h('td', null, B.inRange(x, o) ? Math.round(B.distance(x, o)) + ' — рядом' : 'вне радиуса'),
            h('td', null, audio ? '♪ аудио' : paired ? 'сопряжено' : 'найдено'), h('td', null, h('div', { class: 'row' }, btns)));
        }) : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Нажмите «Поиск устройств»'))));
      UI.clear(player);
      const files = x.files || [];
      if (files.length) {
        if (!files.some((f) => f.name === v.file)) v.file = files[0].name;
        player.append(h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'muted' }, 'Файл для отправки:'), DW.select(files.map((f) => [f.name, f.name]), v.file, (val) => { v.file = val; })));
      }
      const rec = (x.btRt && x.btRt.received) || [];
      if (rec.length) player.append(h('div', { class: 'muted', style: { marginTop: '6px' } }, 'Получено по Bluetooth: ' + rec.map((r) => '«' + r.name + '» от ' + r.from).join(', ')));
      const out = x.btRt && x.btRt.audio ? app.net.getDevice(x.btRt.audio) : null;
      if (out) {
        player.append(DW.section('Музыка → ' + out.name), h('div', { class: 'row' }, DW.select(TRACKS.map((t) => [t, t]), v.track, (val) => { v.track = val; }),
          h('button', { class: 'btn primary small', onClick: () => act(() => B.play(dev0(app, id), v.track)) }, '▶ Играть'),
          h('button', { class: 'btn outline small', onClick: () => { B.stop(dev0(app, id)); refresh(app); } }, '■ Стоп'),
          x.btRt.track ? h('span', { class: 'st ok' }, '♪ ' + x.btRt.track) : null));
      }
    };
    live();
    return live;
  }

  /* ================= IoT Monitor ================= */

  function iotMonApp(app, id, box, st) {
    const I = NS.iot;
    const newRule = () => ({ name: '', match: 'all', conds: [{ type: 'thing', thing: '', prop: '', op: '=', value: '' }], actions: [{ thing: '', prop: '', value: '' }] });
    const v = (st.iotmon = st.iotmon || { server: '', user: 'admin', pass: 'admin', data: null, busy: false, rule: newRule() });
    if (!v.server) { const d = dev0(app, id); if (d.gateway != null) v.server = U.ipStr(d.gateway); }
    const e = err();
    const view = h('div');
    const load = () => {
      e.textContent = '';
      v.busy = true;
      dev0(app, id).iotList(v.server.trim(), v.user, v.pass, (r) => { v.busy = false; if (!r.ok) { e.textContent = r.error; v.data = null; } else v.data = r.data; draw(); refresh(app); });
    };
    const control = (thing, prop, value) => {
      dev0(app, id).iotControl(v.server.trim(), v.user, v.pass, thing, prop, value, (r) => { if (!r.ok) e.textContent = r.error; setTimeout(load, 30); });
    };
    const saveRules = (rules) => {
      dev0(app, id).iotSaveRules(v.server.trim(), v.user, v.pass, rules, (r) => { if (!r.ok) e.textContent = r.error; load(); });
    };
    const draw = () => {
      if (!box.isConnected) return;
      UI.clear(view);
      if (!v.data) { view.append(h('div', { class: 'muted' }, v.busy ? 'Загрузка…' : 'Войдите, чтобы увидеть устройства.')); return; }
      const things = v.data.things;
      view.append(DW.section('Устройства (' + things.length + ')'));
      const grid = h('div', { class: 'iot-grid' });
      for (const t of things) {
        const k = I.KINDS[t.kind];
        const rows = Object.entries(k ? k.props : {}).map(([p, m]) => {
          const val = t.state[p];
          let ctl = h('span', { class: 'mono' }, I.propText(t.kind, p, val));
          if (m.control && m.type === 'bool') ctl = UI.toggle(I.propText(t.kind, p, val), !!val, (on) => control(t.name, p, on));
          else if (m.control && m.type === 'enum') ctl = h('div', { class: 'seg' }, m.values.map((x, i) => h('button', { class: 'btn small ' + (x === val ? 'primary' : 'outline'), onClick: () => control(t.name, p, x) }, m.labels[i])));
          return [lbl(m.title || p), ctl];
        }).flat();
        const pseudo = { type: 'iot', thing: { kind: t.kind, state: t.state } };
        grid.append(h('div', { class: 'iot-card' }, h('div', { class: 'row' }, UI.svgFrom(UI.deviceIconFor(pseudo), { viewBox: '0 0 64 48', width: 48, height: 36 }), h('b', null, t.name), h('span', { class: 'muted small' }, U.ipStr(t.ip))), DW.form(...rows)));
      }
      if (!things.length) grid.append(h('div', { class: 'muted' }, 'Нет зарегистрированных устройств.'));
      view.append(grid);
      // правила
      const RT = NS.iotRules;
      const rules = v.data.rules || [];
      view.append(DW.section('Правила «если… то…»' + (v.data.clock ? ' · часы сервера: ' + v.data.clock : '')), h('table', { class: 'tbl' }, h('tr', null, ['Вкл', 'Имя', 'Если', 'То', ''].map((x) => h('th', null, x))),
        rules.length ? rules.map((r, i) => h('tr', null,
          h('td', null, h('input', { type: 'checkbox', checked: r.enabled, onChange: (ev) => { const nr = rules.map((x) => Object.assign({}, x)); nr[i].enabled = ev.target.checked; saveRules(nr); } })),
          h('td', null, r.name), h('td', { class: 'mono' }, RT.ruleText(r)),
          h('td', { class: 'mono' }, r.actions.map((a) => a.thing + '.' + a.prop + ' = ' + a.value).join('; ')),
          h('td', null, h('button', { class: 'btn icon small danger', onClick: () => saveRules(rules.filter((_, j) => j !== i)) }, UI.icon('delete')))))
          : h('tr', { class: 'empty' }, h('td', { colspan: 5 }, 'Правил нет'))));
      if (!v.rule || !v.rule.conds) v.rule = newRule();
      const R = v.rule;
      const thingSel = (o, filter) => DW.select([['', '— устройство —']].concat(things.filter(filter || (() => true)).map((t) => [t.name, t.name])), o.thing, (val) => { o.thing = val; o.prop = ''; draw(); });
      const propSel = (o, onlyControl) => {
        const t = things.find((x) => x.name === o.thing);
        const props = t && I.KINDS[t.kind] ? Object.entries(I.KINDS[t.kind].props).filter(([, m]) => !onlyControl || m.control).map(([p, m]) => [p, (m.title || p) + ' (' + p + ')']) : [];
        if (props.length && !props.some((x) => x[0] === o.prop)) o.prop = props[0][0];
        return DW.select(props.length ? props : [['', '—']], o.prop, (val) => { o.prop = val; });
      };
      const valIn = (o) => inp(o, 'value', { placeholder: 'значение', style: { width: '100px' } });
      const rm = (list, i) => (list.length > 1 ? h('button', { class: 'btn icon small', title: 'Убрать', onClick: () => { list.splice(i, 1); draw(); } }, '×') : null);
      const word = (i) => h('span', { class: 'muted', style: { width: '36px' } }, i ? (R.match === 'any' ? 'или' : 'и') : 'если');
      const condRow = (c, i) => {
        const type = DW.select([['thing', 'устройство'], ['time', 'время']], c.type, (val) => { c.type = val; draw(); });
        if (c.type === 'time') {
          const days = h('div', { class: 'vlan-checks' }, [1, 2, 3, 4, 5, 6, 0].map((d) => {
            const cb = h('input', { type: 'checkbox', checked: c.days.includes(d) });
            cb.addEventListener('change', () => { c.days = cb.checked ? c.days.concat([d]) : c.days.filter((x) => x !== d); });
            return h('label', null, cb, ' ' + RT.DAYS[d]);
          }));
          return h('div', { class: 'row' }, word(i), type, h('span', null, 'с'), inp(c, 'from', { type: 'time', style: { width: '96px' } }), h('span', null, 'до'), inp(c, 'to', { type: 'time', style: { width: '96px' } }), days, rm(R.conds, i));
        }
        return h('div', { class: 'row' }, word(i), type, thingSel(c), propSel(c), DW.select(['=', '!=', '>', '<', '>=', '<='].map((o) => [o, o]), c.op, (val) => { c.op = val; }), valIn(c), rm(R.conds, i));
      };
      const actRow = (a, i) => h('div', { class: 'row' }, h('span', { class: 'muted', style: { width: '36px' } }, i ? 'и' : 'то'),
        thingSel(a, (t) => I.KINDS[t.kind] && Object.values(I.KINDS[t.kind].props).some((m) => m.control)), propSel(a, true), h('span', null, '='), valIn(a), rm(R.actions, i));
      view.append(h('div', { class: 'rule-form' },
        h('div', { class: 'row' }, h('span', null, 'Имя'), inp(R, 'name', { placeholder: 'например, Вечерний свет', style: { width: '180px' } }),
          h('span', null, 'Условия:'), DW.select([['all', 'все сразу (И)'], ['any', 'любое из них (ИЛИ)']], R.match, (val) => { R.match = val; draw(); })),
        R.conds.map(condRow),
        h('div', { class: 'row' }, h('button', { class: 'btn outline small', onClick: () => { R.conds.push({ type: 'thing', thing: '', prop: '', op: '=', value: '' }); draw(); } }, '+ условие'),
          h('button', { class: 'btn outline small', onClick: () => { R.conds.push({ type: 'time', from: '18:00', to: '23:00', days: [] }); draw(); } }, '+ расписание')),
        R.actions.map(actRow),
        h('div', { class: 'row' }, h('button', { class: 'btn outline small', onClick: () => { R.actions.push({ thing: '', prop: '', value: '' }); draw(); } }, '+ действие'),
          h('button', { class: 'btn primary small', onClick: () => {
            e.textContent = '';
            if (!R.name.trim()) { e.textContent = 'Задайте имя правила'; return; }
            if (R.conds.some((c) => (c.type === 'time' ? !c.from || !c.to : !c.thing || c.value === ''))) { e.textContent = 'Заполните все условия (устройство и значение или время «с» и «до»)'; return; }
            if (R.actions.some((a) => !a.thing || a.value === '')) { e.textContent = 'Заполните все действия'; return; }
            const conds = R.conds.map((c) => (c.type === 'time' ? { type: 'time', from: c.from, to: c.to, days: c.days.slice() } : { thing: c.thing, prop: c.prop, op: c.op, value: c.value }));
            saveRules(rules.concat([{ name: R.name.trim(), enabled: true, match: R.match, conds, actions: R.actions.map((a) => ({ thing: a.thing, prop: a.prop, value: a.value })) }]));
            v.rule = newRule();
          } }, 'Добавить правило'))),
      h('div', { class: 'muted small', style: { marginTop: '4px' } }, 'Значения: true/false для вкл/выкл и открыто/закрыто, 0/1/2 для уровней, числа для датчиков. Расписание — по часам IoT-сервера (их можно задать на странице сервера или получить по NTP); без отмеченных дней — каждый день.'));
    };
    box.append(DW.form(lbl('IoT-сервер'), inp(v, 'server', { class: 'inp mono', placeholder: '192.168.25.1' }), lbl('Пользователь'), inp(v, 'user'), lbl('Пароль'), inp(v, 'pass', { type: 'password' }),
      h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: load }, v.data ? 'Обновить' : 'Войти'), e)), view);
    draw();
    return null;
  }

  /* ================= IoX IDE ================= */

  const PKG_YAML = '# Описание приложения IOx\nname: hello-iox\nversion: 1.0\ndescription: Веб-приложение на маршрутизаторе\nport: 8000\n';
  const PKG_HTML = '<html>\n<center><font size="+2" color="green">Привет из IOx!</font></center>\n<hr>Эта страница отдаётся приложением, которое работает прямо на маршрутизаторе Cisco (IOx app hosting).\n</html>';

  function ioxApp(app, id, box, st) {
    const v = (st.iox = st.iox || { host: '', user: 'admin', pass: '', appid: 'web', yaml: PKG_YAML, html: PKG_HTML, guest: '192.168.10.2', data: null });
    const e = err();
    const view = h('div');
    const call = (msg, after) => {
      e.textContent = '';
      dev0(app, id).ioxRequest(v.host.trim(), v.user, v.pass, msg, (r) => {
        if (!r.ok) e.textContent = r.error;
        else if (msg.ioxm === 'LIST') v.data = r;
        if (after && r.ok) after(r);
        else if (msg.ioxm !== 'LIST' && r.ok) call({ ioxm: 'LIST' });
        draw();
        refresh(app);
      });
    };
    const draw = () => {
      if (!box.isConnected) return;
      UI.clear(view);
      if (!v.data) { view.append(h('div', { class: 'muted' }, 'Подключитесь к маршрутизатору (IOx Local Manager, порт 8443).')); return; }
      view.append(DW.section('Приложения на ' + v.host), h('table', { class: 'tbl' }, h('tr', null, ['Приложение', 'Состояние', 'Адрес', 'Действия'].map((x) => h('th', null, x))),
        v.data.apps.length ? v.data.apps.map((a) => {
          const b = (t, act) => h('button', { class: 'btn small outline', onClick: () => call({ ioxm: 'ACTION', appid: a.id, action: act }) }, t);
          const acts = { DEPLOYED: [b('Активировать', 'activate'), b('Удалить', 'uninstall')], ACTIVATED: [b('Запустить', 'start'), b('Деактивировать', 'deactivate')], RUNNING: [b('Остановить', 'stop')], STOPPED: [b('Запустить', 'start'), b('Деактивировать', 'deactivate')] }[a.state] || [];
          return h('tr', null, h('td', null, a.id), h('td', null, a.state || 'не установлено'), h('td', { class: 'mono' }, a.guestIp ? a.guestIp + (a.port ? ':' + a.port : '') : '—'), h('td', null, h('div', { class: 'row' }, acts)));
        }) : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Приложений нет'))));
    };
    const deploy = () => {
      if (!/^[A-Za-z][\w-]{0,31}$/.test(v.appid)) { e.textContent = 'Имя приложения: латиница, цифры, «-», «_»'; return; }
      const manifest = NS.iox.parseYaml(v.yaml);
      call({ ioxm: 'NETWORK', appid: v.appid, guestIp: v.guest.trim() }, () => call({ ioxm: 'DEPLOY', appid: v.appid, manifest, files: { 'index.html': v.html } }));
    };
    const yaml = h('textarea', { class: 'code-editor mono small', spellcheck: 'false', rows: 6 });
    yaml.value = v.yaml;
    yaml.addEventListener('input', () => { v.yaml = yaml.value; });
    const html = h('textarea', { class: 'code-editor mono small', spellcheck: 'false', rows: 8 });
    html.value = v.html;
    html.addEventListener('input', () => { v.html = html.value; });
    box.append(DW.form(lbl('Маршрутизатор'), inp(v, 'host', { class: 'inp mono', placeholder: 'IP-адрес' }), lbl('Пользователь'), inp(v, 'user'), lbl('Пароль'), inp(v, 'pass', { type: 'password' }),
      h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: () => call({ ioxm: 'LIST' }) }, 'Подключиться'), e)), view,
    DW.section('Новое приложение'), DW.form(lbl('Имя (appid)'), inp(v, 'appid', { class: 'inp mono' }), lbl('Гостевой адрес'), inp(v, 'guest', { class: 'inp mono' })),
    h('div', { class: 'muted small' }, 'package.yaml'), yaml, h('div', { class: 'muted small' }, 'index.html'), html,
    h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'btn primary small', onClick: deploy }, 'Собрать и загрузить (Deploy)')),
    hint('На маршрутизаторе: username admin privilege 15 secret …, iox, interface VirtualPortGroup0 с IP-адресом (например 192.168.10.1/24). Гостевой адрес приложения — из этой сети. После «Запустить» откройте в браузере http://<гостевой адрес>:<порт>; другим сетям нужен маршрут к сети VirtualPortGroup.'));
    draw();
    return null;
  }

  /* ================= регистрация ================= */

  const isHostWithNic = (d) => d.iface && d.iface.port >= 0;
  DW.desktopApps.push(
    { id: 'mib', title: 'MIB Browser', color: '#0f766e', render: mibApp },
    { id: 'netflow', title: 'NetFlow Collector', color: '#9333ea', render: netflowApp },
    { id: 'vpn', title: 'VPN', color: '#1e3a8a', render: vpnApp, when: (d) => isHostWithNic(d) && d.iface.kind === 'phys' },
    { id: 'pppoe', title: 'PPPoE Dialer', color: '#ca8a04', render: pppoeApp, when: (d) => isHostWithNic(d) && d.iface.kind === 'phys' },
    { id: 'dialup', title: 'Dial-up', color: '#a16207', render: dialupApp, when: (d) => d.iface && d.iface.kind === 'dialup' },
    { id: 'ipc', title: 'IP Communicator', color: '#0e7490', render: ipcApp, keep: true },
    { id: 'bt', title: 'Bluetooth', color: '#1d4ed8', render: btApp, when: (d) => NS.bt.has(d) },
    { id: 'iotmon', title: 'IoT Monitor', color: '#7c3aed', render: iotMonApp },
    { id: 'ioxide', title: 'IoX IDE', color: '#115e59', render: ioxApp },
  );
})(globalThis.NetLab = globalThis.NetLab || {});
