/* NetLab UI — безопасность: служба AAA на сервере, страницы AAA и межсетевого экрана (ZBF) маршрутизатора,
 * DHCP snooping / DAI / 802.1X коммутатора, 802.1X на компьютере, окно настройки Cisco ASA 5506-X. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const ip = U.ipStr;
  const ipT = DW.ipText;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });
  const hint = (t) => h('div', { class: 'hint-box', style: { marginTop: '10px' } }, t);
  const tbl = (head, rows, empty) => h('table', { class: 'tbl', style: { marginTop: '8px' } },
    h('tr', null, head.map((x) => h('th', null, x))),
    rows.length ? rows : h('tr', { class: 'empty' }, h('td', { colspan: head.length }, empty || 'Пусто')));
  const delBtn = (fn) => h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: fn }, UI.icon('delete'));
  const inp = (ph, w, v) => h('input', { class: 'inp', placeholder: ph || '', value: v == null ? '' : v, spellcheck: 'false', style: w ? { width: w + 'px' } : {} });
  const st = (ok, text) => h('span', { class: 'st ' + (ok ? 'ok' : 'bad') }, text);

  function page(app, dev, box, title, build) {
    const e = err();
    const run = (cmds) => DW.iosApply(app, app.net.getDevice(dev.id), cmds, e);
    box.appendChild(DW.section(title));
    const live = build(run, e);
    box.appendChild(e);
    return live;
  }

  /* ================= значок и палитра ASA ================= */

  const ASA_ICON =
    '<rect x="4" y="14" width="56" height="22" rx="3" fill="#7f1d1d"/>' +
    '<rect x="4" y="14" width="56" height="6" rx="3" fill="#991b1b"/>' +
    '<path d="M32 18l9 3.5v6c0 5-4 8.5-9 10-5-1.5-9-5-9-10v-6z" fill="#fecaca" stroke="#450a0a" stroke-width="1.2"/>' +
    '<path d="M28.5 28l2.6 2.6 5-5.2" fill="none" stroke="#7f1d1d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    [0, 1, 2, 3].map((i) => '<rect x="' + (8 + i * 3.4) + '" y="30" width="2.2" height="3" fill="#fca5a5"/>').join('') +
    [0, 1, 2, 3].map((i) => '<rect x="' + (43 + i * 3.4) + '" y="30" width="2.2" height="3" fill="#fca5a5"/>').join('');
  const baseIcon = UI.deviceIcon;
  UI.deviceIcon = function (type, model) { return type === 'asa' ? ASA_ICON : baseIcon(type, model); };
  UI.DEVICE_TYPES.push({ type: 'asa', label: 'Межсетевой экран', short: 'ASA' });
  const wan = UI.DEVICE_CATEGORIES.findIndex((c) => c.id === 'wan');
  UI.DEVICE_CATEGORIES.splice(wan >= 0 ? wan : UI.DEVICE_CATEGORIES.length, 0, { id: 'security', label: 'Безопасность', icon: 'asa', models: ['ASA5506'] });

  /* ================= служба AAA на сервере ================= */

  DW.aaaSection = function (app, dev, box) {
    const a = dev.aaad;
    if (!a) return null;
    const e = err();
    const apply = (fn) => DW.apply(app, () => { const d = app.net.getDevice(dev.id); fn(d.aaad); d.aaad.bind(); }, e, true);
    box.append(DW.section('AAA-сервер (RADIUS и TACACS+)'), DW.form(lbl('Служба'), UI.toggle(a.enabled ? 'Включена' : 'Выключена', a.enabled, (on) => apply((x) => { x.enabled = on; }))));
    const cName = inp('имя (R1)', 110);
    const cIp = DW.ipInput('', 'IP клиента');
    const cKey = inp('общий ключ', 120);
    const cType = DW.select([['radius', 'RADIUS'], ['tacacs', 'TACACS+']], 'radius');
    box.append(h('div', { style: { fontWeight: 600, marginTop: '12px' } }, 'Клиенты (NAS): маршрутизаторы и коммутаторы'),
      h('div', { class: 'row', style: { flexWrap: 'wrap', marginTop: '6px' } }, cName, cIp, cKey, cType, h('button', { class: 'btn primary small', onClick: () => {
        const r = DW.readIp(cIp, true);
        if (!r.ok) { e.textContent = r.err; return; }
        apply((x) => x.addClient(cName.value, r.v, cKey.value, cType.value));
      } }, 'Добавить')),
      tbl(['Имя', 'IP-адрес', 'Ключ', 'Тип', ''], a.clients.map((c) => h('tr', null, h('td', null, c.name), h('td', { class: 'mono' }, ip(c.ip)), h('td', { class: 'mono' }, c.secret), h('td', null, c.type === 'tacacs' ? 'TACACS+' : 'RADIUS'),
        h('td', null, delBtn(() => apply((x) => { x.clients = x.clients.filter((y) => y !== c && !(y.name === c.name && y.type === c.type)); }))))), 'Клиентов нет'));
    const uName = inp('имя пользователя', 150);
    const uPass = inp('пароль', 130);
    box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, 'Пользователи'),
      h('div', { class: 'row', style: { marginTop: '6px' } }, uName, uPass, h('button', { class: 'btn primary small', onClick: () => apply((x) => x.addUser(uName.value, uPass.value)) }, 'Добавить')),
      tbl(['Пользователь', 'Пароль', ''], a.users.map((u) => h('tr', null, h('td', null, u.user), h('td', { class: 'mono' }, u.pass), h('td', null, delBtn(() => apply((x) => { x.users = x.users.filter((y) => y.user !== u.user); }))))), 'Пользователей нет'), e);
    const log = h('pre', { class: 'ios-log', style: { maxHeight: '160px' } });
    box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, 'Журнал проверок'), log,
      hint('IP клиента — адрес интерфейса маршрутизатора или коммутатора, с которого он обращается к серверу, а ключ — тот же, что в команде key (radius server …) на устройстве. Запрос от неизвестного клиента или с неверным ключом сервер молча отбрасывает — устройство переходит к следующему методу (например, local). RADIUS — UDP 1812, TACACS+ — TCP 49.'));
    return () => {
      const d = app.net.getDevice(dev.id);
      log.textContent = d && d.aaad && d.aaad.log.length ? d.aaad.log.slice(-40).map((l) => l.time + '  ' + l.text).join('\n') : '(пусто)';
    };
  };

  /* ================= AAA на маршрутизаторе и коммутаторе ================= */

  const aaaPage = {
    id: 'aaa', label: 'AAA',
    render: (app, dev, box) => page(app, dev, box, 'AAA — проверка пользователей на сервере', (run, e) => {
      const c = dev.aaa || { newModel: false, login: {}, dot1x: null, radius: [], tacacs: [] };
      box.append(DW.form(lbl('aaa new-model'), UI.toggle(c.newModel ? 'Включено' : 'Выключено', c.newModel, (on) => run([on ? 'aaa new-model' : 'no aaa new-model']))));
      if (!c.newModel) { box.append(hint('После aaa new-model вход в консоль, Telnet и SSH проверяется по спискам методов: например, сначала RADIUS-сервер, а если он недоступен — локальные пользователи (username … secret …).')); return null; }
      const LISTS = [['', 'не задан (local)'], ['local', 'local'], ['group radius local', 'RADIUS, затем local'], ['group tacacs+ local', 'TACACS+, затем local'], ['group radius', 'только RADIUS'], ['group tacacs+', 'только TACACS+']];
      const cur = (c.login.default || []).join(' ');
      box.append(DW.form(lbl('Вход (login default)'), DW.select(LISTS.some(([k]) => k === cur) ? LISTS : LISTS.concat([[cur, cur]]), cur, (v) => run([v ? 'aaa authentication login default ' + v : 'no aaa authentication login default'])),
        ...(dev.type === 'switch' ? [lbl('802.1X (dot1x default)'), UI.toggle('group radius', !!c.dot1x, (on) => run([on ? 'aaa authentication dot1x default group radius' : 'no aaa authentication dot1x default']))] : [])));
      for (const [kind, title, cmd] of [['radius', 'RADIUS-серверы', 'radius server'], ['tacacs', 'TACACS+-серверы', 'tacacs server']]) {
        const n = inp('имя', 90);
        const a = DW.ipInput('', 'адрес сервера');
        const k = inp('ключ', 110);
        box.append(h('div', { style: { fontWeight: 600, marginTop: '12px' } }, title), h('div', { class: 'row', style: { marginTop: '6px' } }, n, a, k, h('button', { class: 'btn primary small', onClick: () => {
          const r = DW.readIp(a, true);
          if (!r.ok) { e.textContent = r.err; return; }
          if (!n.value.trim() || !k.value.trim()) { e.textContent = 'Укажите имя и ключ'; return; }
          run([cmd + ' ' + n.value.trim(), 'address ipv4 ' + ip(r.v) + (kind === 'radius' ? ' auth-port 1812 acct-port 1813' : ''), 'key ' + k.value.trim()]);
        } }, 'Добавить')),
        tbl(['Имя', 'Адрес', 'Ключ', ''], c[kind].map((x) => h('tr', null, h('td', null, x.name || '(legacy)'), h('td', { class: 'mono' }, x.ip != null ? ip(x.ip) : '—'), h('td', { class: 'mono' }, x.key || (kind === 'radius' ? c.radiusKey : c.tacacsKey) || '—'),
          h('td', null, delBtn(() => run([x.name ? 'no ' + cmd + ' ' + x.name : 'no ' + kind + '-server host ' + ip(x.ip)]))))), 'Не заданы'));
      }
      const tu = inp('пользователь', 120);
      const tp = inp('пароль', 110);
      const tg = DW.select([['radius', 'RADIUS'], ['tacacs+', 'TACACS+']], 'radius');
      const out = h('pre', { class: 'ios-log', style: { maxHeight: '90px' } });
      box.append(h('div', { style: { fontWeight: 600, marginTop: '12px' } }, 'Проверка (test aaa)'), h('div', { class: 'row', style: { marginTop: '6px' } }, tg, tu, tp, h('button', { class: 'btn outline small', onClick: () => {
        const d = app.net.getDevice(dev.id);
        const s = NS.cli.createSession(d);
        s.mode = 'exec';
        out.textContent = '';
        const put = (l) => { out.textContent += l + '\n'; };
        NS.cli.exec(d, s, 'test aaa group ' + tg.value + ' ' + tu.value.trim() + ' ' + tp.value + ' legacy', { out: put, write: put, done() {}, clear() {}, mutate: (fn) => fn() });
      } }, 'Проверить')), out,
      hint('На AAA-сервере (Server-PT → Службы → AAA) добавьте это устройство клиентом с тем же ключом и адресом интерфейса, с которого идут запросы. Отказ сервера окончателен; если сервер не отвечает — используется следующий метод списка.'));
      return null;
    }),
  };

  /* ================= межсетевой экран на основе зон ================= */

  const ZPROTOS = ['icmp', 'http', 'https', 'dns', 'tcp', 'udp', 'ftp', 'ssh', 'telnet', 'smtp'];

  const zbfPage = {
    id: 'zbf', label: 'Межсетевой экран (ZBF)',
    render: (app, dev, box) => page(app, dev, box, 'Zone-Based Firewall', (run, e) => {
      const z = dev.zbf || { zones: {}, classes: {}, policies: {}, pairs: {} };
      const zones = Object.keys(z.zones);
      const zn = inp('имя зоны (INSIDE)', 150);
      box.append(h('div', { style: { fontWeight: 600 } }, '1. Зоны и интерфейсы'), h('div', { class: 'row', style: { marginTop: '6px' } }, zn, h('button', { class: 'btn primary small', onClick: () => { if (zn.value.trim()) run(['zone security ' + zn.value.trim()]); } }, 'Создать зону')),
        tbl(['Интерфейс', 'Адрес', 'Зона'], dev.ifaces.filter((f) => !f.runtime && f.kind !== 'loop').map((f) => h('tr', null, h('td', null, f.name), h('td', { class: 'mono' }, f.ip != null ? U.cidr(f.ip, f.mask) : '—'),
          h('td', null, DW.select([['', 'нет']].concat(zones.map((k) => [k, k])), f.zone || '', (v) => run(['interface ' + f.name, v ? 'zone-member security ' + v : 'no zone-member security']))))), 'Нет интерфейсов'),
        zones.length ? h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap', gap: '6px' } }, zones.map((k) => h('span', { class: 'chip' }, k, ' ', h('button', { class: 'btn icon small danger', title: 'Удалить зону', onClick: () => run(['no zone security ' + k]) }, UI.icon('delete'))))) : null);
      // class-map
      const cn = inp('имя класса (WEB-C)', 150);
      const checks = ZPROTOS.map((p) => { const cb = h('input', { type: 'checkbox' }); return { p, cb, el: h('label', null, cb, ' ' + p) }; });
      box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, '2. Классы трафика (class-map type inspect match-any)'),
        h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } }, cn, h('div', { class: 'vlan-checks' }, checks.map((x) => x.el)), h('button', { class: 'btn primary small', onClick: () => {
          const ps = checks.filter((x) => x.cb.checked).map((x) => x.p);
          if (!cn.value.trim() || !ps.length) { e.textContent = 'Укажите имя класса и хотя бы один протокол'; return; }
          run(['class-map type inspect match-any ' + cn.value.trim()].concat(ps.map((p) => 'match protocol ' + p)));
        } }, 'Создать')),
        tbl(['Класс', 'Совпадение', ''], Object.entries(z.classes).map(([k, c]) => h('tr', null, h('td', null, k), h('td', { class: 'mono' }, c.rules.map((r) => r.kind === 'protocol' ? r.proto : 'acl ' + r.acl).join(', ') || '—'), h('td', null, delBtn(() => run(['no class-map type inspect ' + k]))))), 'Классов нет'));
      // policy-map
      const pn = inp('имя политики (IN-OUT-P)', 160);
      const pc = DW.select([['', 'класс…']].concat(Object.keys(z.classes).map((k) => [k, k])), '');
      const pa = DW.select([['inspect', 'inspect'], ['pass', 'pass'], ['drop', 'drop']], 'inspect');
      box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, '3. Политики (policy-map type inspect)'),
        h('div', { class: 'row', style: { marginTop: '6px' } }, pn, pc, pa, h('button', { class: 'btn primary small', onClick: () => {
          if (!pn.value.trim() || !pc.value) { e.textContent = 'Укажите имя политики и класс'; return; }
          run(['policy-map type inspect ' + pn.value.trim(), 'class type inspect ' + pc.value, pa.value]);
        } }, 'Добавить правило')),
        tbl(['Политика', 'Правила', ''], Object.entries(z.policies).map(([k, pol]) => h('tr', null, h('td', null, k), h('td', { class: 'mono' }, pol.map((x) => x.cls + ' → ' + (x.action || 'drop') + (x.log ? ' log' : '')).join('; ') || '—'), h('td', null, delBtn(() => run(['no policy-map type inspect ' + k]))))), 'Политик нет'));
      // zone-pair
      const zs = DW.select([['', 'откуда…']].concat(zones.concat(['self']).map((k) => [k, k])), '');
      const zd = DW.select([['', 'куда…']].concat(zones.concat(['self']).map((k) => [k, k])), '');
      const zp = DW.select([['', 'политика…']].concat(Object.keys(z.policies).map((k) => [k, k])), '');
      box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, '4. Пары зон (zone-pair)'),
        h('div', { class: 'row', style: { marginTop: '6px' } }, zs, h('span', null, '→'), zd, zp, h('button', { class: 'btn primary small', onClick: () => {
          if (!zs.value || !zd.value || !zp.value) { e.textContent = 'Выберите зоны и политику'; return; }
          run(['zone-pair security ' + zs.value + '-' + zd.value + ' source ' + zs.value + ' destination ' + zd.value, 'service-policy type inspect ' + zp.value]);
        } }, 'Создать')),
        tbl(['Пара', 'Направление', 'Политика', ''], Object.entries(z.pairs).map(([k, p]) => h('tr', null, h('td', null, k), h('td', null, p.src + ' → ' + p.dst), h('td', null, p.policy || '—'), h('td', null, delBtn(() => run(['no zone-pair security ' + k]))))), 'Пар нет'));
      const sess = h('div');
      box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, 'Сеансы inspect'), sess,
        hint('Правила ZBF: трафик между интерфейсами одной зоны проходит; между зоной и интерфейсом без зоны — запрещён; между разными зонами — только по паре зон с политикой. Действие inspect запоминает соединение и пропускает ответы, поэтому пару в обратную сторону создавать не нужно. Всё, что не попало в классы, — class-default (drop).'));
      return () => {
        const d = app.net.getDevice(dev.id);
        UI.clear(sess);
        const list = d.zbfSessions ? [...d.zbfSessions.values()] : [];
        sess.append(tbl(['Пара', 'Протокол', 'Откуда', 'Куда', 'Пакетов'], list.slice(-30).map((x) => h('tr', null, h('td', null, x.pair), h('td', null, x.proto), h('td', { class: 'mono' }, ip(x.src) + ':' + (x.sport || 0)), h('td', { class: 'mono' }, ip(x.dst) + ':' + (x.dport || 0)), h('td', null, String(x.pkts)))), 'Сеансов нет'));
      };
    }),
  };

  DW.routerPages = (DW.routerPages || []).concat([aaaPage, zbfPage]);

  /* ================= коммутатор: DHCP snooping, DAI, 802.1X ================= */

  const vlanStr = (l) => (l || []).join(',');

  const swSecPage = {
    id: 'l2sec', label: 'Безопасность',
    render: (app, dev, box) => page(app, dev, box, 'Безопасность 2-го уровня', (run, e) => {
      const sn = dev.snoop || { on: false, vlans: [], opt82: true };
      const vI = inp('1,10', 90, vlanStr(sn.vlans));
      DW.commitOnChange(vI, () => { const v = vI.value.trim(); run(v ? ['ip dhcp snooping vlan ' + v] : sn.vlans.length ? ['no ip dhcp snooping vlan ' + vlanStr(sn.vlans)] : []); });
      box.append(h('div', { style: { fontWeight: 600 } }, 'DHCP snooping'), DW.form(
        lbl('Включён'), UI.toggle('', sn.on, (on) => run([on ? 'ip dhcp snooping' : 'no ip dhcp snooping'])),
        lbl('VLAN'), vI,
        lbl('Option 82'), UI.toggle('вставлять', sn.opt82, (on) => run([on ? 'ip dhcp snooping information option' : 'no ip dhcp snooping information option']))));
      const bind = h('div');
      box.append(bind);
      const dai = dev.dai || { vlans: [], validate: {}, filters: [] };
      const dI = inp('1,10', 90, vlanStr(dai.vlans));
      DW.commitOnChange(dI, () => { const v = dI.value.trim(); run(v ? ['ip arp inspection vlan ' + v] : dai.vlans.length ? ['no ip arp inspection vlan ' + vlanStr(dai.vlans)] : []); });
      const val = (k, word) => UI.toggle(word, !!dai.validate[k], (on) => {
        const next = Object.assign({}, dai.validate, { [k]: on });
        const words = [next.src ? 'src-mac' : '', next.dst ? 'dst-mac' : '', next.ip ? 'ip' : ''].filter(Boolean);
        run([words.length ? 'ip arp inspection validate ' + words.join(' ') : 'no ip arp inspection validate']);
      });
      box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, 'Dynamic ARP Inspection'), DW.form(lbl('VLAN'), dI, lbl('Проверки'), h('div', { class: 'row' }, val('src', 'src-mac'), val('dst', 'dst-mac'), val('ip', 'ip'))));
      const stats = h('div');
      box.append(stats);
      box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, '802.1X'), DW.form(lbl('dot1x system-auth-control'), UI.toggle('', !!dev.dot1xSys, (on) => run([on ? 'dot1x system-auth-control' : 'no dot1x system-auth-control']))));
      const x = h('div');
      box.append(x, hint('DHCP snooping: ответы DHCP-сервера принимаются только на доверенных портах (ip dhcp snooping trust — порт к настоящему серверу или к другому коммутатору), по выданным адресам строится таблица привязок. DAI сверяет ARP с недоверенных портов с этой таблицей — подменить шлюз не получится. 802.1X: для портов с authentication port-control auto нужны aaa new-model, aaa authentication dot1x default group radius (страница AAA), RADIUS-сервер и адрес на коммутаторе (SVI). Доверенность и 802.1X порта задаются на странице порта.'));
      return () => {
        const d = app.net.getDevice(dev.id);
        UI.clear(bind);
        const b = d.snoopRt ? [...d.snoopRt.bindings.values()] : [];
        bind.append(tbl(['MAC', 'IP', 'VLAN', 'Порт'], b.map((y) => h('tr', null, h('td', { class: 'mono' }, y.mac), h('td', { class: 'mono' }, ip(y.ip)), h('td', null, String(y.vlan)), h('td', null, d.ports[y.port] ? d.ports[y.port].name : '?'))), 'Привязок нет'),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Доверенные порты: ' + (d.ports.filter((p) => p.snoopTrust).map((p) => UI.shortIf(p.name)).join(', ') || 'нет')));
        UI.clear(stats);
        stats.append(tbl(['VLAN', 'Пропущено', 'Отброшено', 'Нет привязки', 'ARP ACL'], ((d.dai && d.dai.vlans) || []).map((v) => { const s = d.daiStats && d.daiStats.get(v); return h('tr', null, h('td', null, String(v)), h('td', null, String(s ? s.fwd : 0)), h('td', null, String(s ? s.drop : 0)), h('td', null, String(s ? s.dhcpDrop : 0)), h('td', null, String(s ? s.aclDrop : 0))); }), 'DAI выключен'));
        UI.clear(x);
        const ps = d.ports.filter((p) => p.dot1x && p.dot1x.control !== 'force-authorized');
        x.append(tbl(['Порт', 'Режим', 'Состояние', 'Пользователь'], ps.map((p) => {
          const r = p.dot1xRt;
          const ok = NS.l2sec.authorized(d, p);
          return h('tr', null, h('td', null, UI.shortIf(p.name)), h('td', null, p.dot1x.control), h('td', null, st(ok, ok ? 'авторизован' : r && r.state === 'held' ? 'отказ' : 'не авторизован')), h('td', null, (r && r.user) || '—'));
        }), 'Нет портов с 802.1X'));
      };
    }),
  };

  DW.switchPages = (DW.switchPages || []).concat([swSecPage, aaaPage]);

  DW.switchPortExtra = function (app, dev, i, run) {
    const p = dev.ports[i];
    const rows = [];
    const rate = h('input', { class: 'inp', type: 'number', min: 1, max: 2048, value: p.snoopRate || '', placeholder: 'без лимита', style: { width: '100px' } });
    DW.commitOnChange(rate, () => run([rate.value ? 'ip dhcp snooping limit rate ' + rate.value : 'no ip dhcp snooping limit rate']));
    rows.push(lbl('DHCP snooping / DAI'), h('div', { class: 'row' },
      UI.toggle('trust (DHCP)', !!p.snoopTrust, (on) => run([on ? 'ip dhcp snooping trust' : 'no ip dhcp snooping trust'])),
      h('span', { class: 'muted' }, 'limit rate'), rate,
      UI.toggle('trust (ARP)', !!p.daiTrust, (on) => run([on ? 'ip arp inspection trust' : 'no ip arp inspection trust'])),
      p.errDisabled && p.errReason === 'dhcp-rate-limit' ? h('span', { class: 'st fail' }, 'err-disabled (DHCP rate)') : null));
    const ctl = p.dot1x ? p.dot1x.control : '';
    const ok = NS.l2sec.authorized(dev, p);
    rows.push(lbl('802.1X'), h('div', { class: 'row' },
      DW.select([['', 'выключен'], ['auto', 'auto (проверка пользователя)'], ['force-authorized', 'force-authorized'], ['force-unauthorized', 'force-unauthorized']], ctl === 'force-authorized' && !(p.dot1x && p.dot1x.pae) ? '' : ctl, (v) => run(v ? ['switchport mode access', 'authentication port-control ' + v, 'dot1x pae authenticator'] : ['no authentication port-control', 'no dot1x pae']), { style: { width: '240px' } }),
      p.dot1x && p.dot1x.control !== 'force-authorized' ? st(ok, ok ? 'авторизован' + (p.dot1xRt && p.dot1xRt.user ? ' (' + p.dot1xRt.user + ')' : '') : 'не авторизован') : null));
    return rows;
  };

  /* ================= 802.1X на компьютере ================= */

  DW.hostIfaceExtras = (DW.hostIfaceExtras || []).concat([(app, dev, box) => {
    const f = dev.iface;
    if (!f || f.port < 0 || !dev.setDot1x || !['pc', 'laptop', 'server', 'printer'].includes(dev.type)) return null;
    const p = dev.ports[f.port];
    if (!p || p.media === 'wireless') return null;
    const c = f.dot1x || { enabled: false, user: '', pass: '' };
    const e = err();
    const u = inp('имя пользователя', 150, c.user);
    const pw = h('input', { class: 'inp', type: 'password', value: c.pass, placeholder: 'пароль', style: { width: '130px' } });
    const save = (en) => DW.apply(app, () => { const d = app.net.getDevice(dev.id); d.setDot1x(d.iface, { enabled: en, user: u.value.trim(), pass: pw.value }); }, e, true);
    DW.commitOnChange(u, () => save(c.enabled));
    DW.commitOnChange(pw, () => save(c.enabled));
    const state = h('span');
    box.append(DW.section('802.1X'), DW.form(lbl('Проверка 802.1X'), UI.toggle('', c.enabled, (on) => save(on)), lbl('Метод'), h('div', null, 'MD5'), lbl('Пользователь'), u, lbl('Пароль'), pw, lbl('Состояние'), state, h('div', { class: 'full' }, e)));
    return () => {
      const d = app.net.getDevice(dev.id);
      const x = d && d.eapRt && d.eapRt.get(d.iface.id);
      const s = x ? x.state : 'idle';
      UI.clear(state);
      state.append(!d.iface.dot1x || !d.iface.dot1x.enabled ? h('span', { class: 'muted' }, 'выключено') : s === 'authenticated' ? st(true, 'проверка пройдена') : s === 'failed' ? st(false, 'отказ (неверное имя или пароль)') : s === 'no-response' ? h('span', { class: 'muted' }, 'коммутатор не отвечает (802.1X на порту не включён)') : h('span', { class: 'muted' }, 'проверка…'));
    };
  }]);

  /* ================= ASA 5506-X ================= */

  function asaConfig(app, id, st0) {
    return (body) => {
      const dev = app.net.getDevice(id);
      const items = [{ group: 'GLOBAL' }, { id: 'global', label: 'Настройки' }, { id: 'routes', label: 'Маршруты' }, { group: 'ПОЛИТИКА' }, { id: 'nat', label: 'NAT' }, { id: 'acl', label: 'Списки доступа' }, { id: 'inspect', label: 'Инспекция' }, { id: 'dhcpd', label: 'DHCP-сервер' }, { group: 'INTERFACE' }];
      for (const f of dev.ifaces) if (f.kind === 'phys') items.push({ id: 'if:' + f.name, label: UI.shortIf(f.name) + (f.nameif ? ' · ' + f.nameif : ''), title: f.name });
      let live = null;
      DW.sidebarLayout(body, items, st0, 'sec', (sec, box) => {
        const d = app.net.getDevice(id);
        live = null;
        if (sec === 'global') live = asaGlobal(app, d, box);
        else if (sec === 'routes') asaRoutes(app, d, box);
        else if (sec === 'nat') asaNat(app, d, box);
        else if (sec === 'acl') asaAcl(app, d, box);
        else if (sec === 'inspect') asaInspect(app, d, box);
        else if (sec === 'dhcpd') asaDhcp(app, d, box);
        else if (sec.startsWith('if:')) { const f = d.ifaceByName(sec.slice(3)); if (f) asaIface(app, d, f, box); }
      }, DW.iosLogPanel(app, dev));
      return () => { if (live) live(); };
    };
  }

  const nameifs = (dev) => dev.ifaces.filter((f) => f.nameif).map((f) => f.nameif);

  function asaGlobal(app, dev, box) {
    return page(app, dev, box, 'Cisco ASA 5506-X', (run) => {
      const hn = inp('', 180, dev.ios.hostname);
      DW.commitOnChange(hn, () => run(['hostname ' + hn.value.trim()]));
      const en = h('input', { class: 'inp', type: 'password', placeholder: dev.hasEnablePassword() ? '(задан)' : 'не задан', style: { width: '180px' } });
      DW.commitOnChange(en, () => run([en.value ? 'enable password ' + en.value : 'no enable password']));
      box.append(DW.form(lbl('Hostname'), hn, lbl('enable password'), en));
      const t = h('div');
      box.append(t, hint('ASA пропускает трафик с интерфейса с более высоким уровнем безопасности (inside, 100) на более низкий (outside, 0) и запоминает соединение — ответы проходят обратно. В обратную сторону нужен список доступа (access-group). ICMP запоминается, только если в политике включён inspect icmp — иначе ping изнутри наружу не получит ответа. Интерфейсы ASA по умолчанию выключены: nameif, IP-адрес и no shutdown.'));
      return () => {
        const d = app.net.getDevice(dev.id);
        const r = d.asaRt;
        UI.clear(t);
        t.append(tbl(['Интерфейс', 'nameif', 'Уровень', 'Адрес', 'Состояние'], d.ifaces.filter((f) => f.kind === 'phys' && (f.nameif || f.ip != null)).map((f) => h('tr', null, h('td', null, f.name), h('td', null, f.nameif || '—'), h('td', null, f.nameif ? String(NS.asa.secOf(f)) : '—'), h('td', { class: 'mono' }, f.ip != null ? U.cidr(f.ip, f.mask) : f.dhcp ? 'DHCP…' : '—'), h('td', null, st(d.ifaceUp(f), d.ifaceUp(f) ? 'up' : 'down')))), 'Интерфейсы не настроены'),
          h('div', { class: 'muted', style: { marginTop: '6px' } }, 'Соединений (conn): ' + (r ? r.conns.size : 0) + ' · трансляций (xlate): ' + (r ? r.xlate.size : 0)));
      };
    });
  }

  function asaIface(app, dev, f, box) {
    const e = err();
    const run = (cmds) => DW.iosApply(app, app.net.getDevice(dev.id), ['interface ' + f.name].concat(cmds), e);
    box.appendChild(DW.section(f.name));
    const p = dev.ports[f.port];
    const nm = inp('inside / outside / dmz', 170, f.nameif || '');
    DW.commitOnChange(nm, () => run([nm.value.trim() ? 'nameif ' + nm.value.trim() : 'no nameif']));
    const lv = h('input', { class: 'inp', type: 'number', min: 0, max: 100, value: f.nameif ? NS.asa.secOf(f) : '', style: { width: '90px' } });
    DW.commitOnChange(lv, () => run(['security-level ' + lv.value]));
    const ipI = DW.ipInput(ipT(f.ip), 'IP-адрес');
    const mI = DW.ipInput(ipT(f.mask), 'маска');
    const applyIp = () => {
      const a = DW.readIp(ipI, false);
      if (!a.ok) { e.textContent = a.err; return; }
      if (a.v == null) { run(['no ip address']); return; }
      if (!mI.value.trim()) mI.value = DW.classfulMask(a.v);
      const m = DW.readMask(mI);
      if (!m.ok) { e.textContent = m.err; return; }
      run(['ip address ' + ip(a.v) + ' ' + ip(m.v)]);
    };
    DW.commitOnChange(ipI, applyIp);
    DW.commitOnChange(mI, applyIp);
    const up = f.adminUp && (!p || p.adminUp);
    box.appendChild(DW.form(
      lbl('Состояние порта'), UI.toggle(up ? 'Включён' : 'Выключен (shutdown)', up, (on) => run([on ? 'no shutdown' : 'shutdown'])),
      lbl('nameif'), nm, lbl('security-level'), lv,
      lbl('IP-конфигурация'), DW.radio('asa-ip-' + f.name, [['static', 'Статически'], ['dhcp', 'DHCP (setroute)']], f.dhcp ? 'dhcp' : 'static', (v) => { if (v === 'dhcp') run(['ip address dhcp setroute']); }),
      lbl('IP-адрес'), ipI, lbl('Маска'), mI, h('div', { class: 'full' }, e)));
  }

  function asaRoutes(app, dev, box) {
    page(app, dev, box, 'Статические маршруты (route)', (run, e) => {
      const nf = DW.select(nameifs(dev).map((n) => [n, n]), nameifs(dev).includes('outside') ? 'outside' : nameifs(dev)[0] || '');
      const n = DW.ipInput('0.0.0.0', 'сеть');
      const m = DW.ipInput('0.0.0.0', 'маска');
      const g = DW.ipInput('', 'шлюз');
      box.append(h('div', { class: 'row', style: { flexWrap: 'wrap' } }, nf, n, m, g, h('button', { class: 'btn primary small', onClick: () => {
        const a = DW.readIp(n, true); const b = DW.readIp(m, true); const c = DW.readIp(g, true);
        if (!a.ok || !b.ok || !c.ok) { e.textContent = a.err || b.err || c.err; return; }
        run(['route ' + nf.value + ' ' + ip(a.v) + ' ' + ip(b.v) + ' ' + ip(c.v)]);
      } }, 'Добавить')),
      tbl(['Интерфейс', 'Сеть', 'Шлюз', ''], dev.routes.map((r) => { const f = r.ifName ? dev.ifaceByName(r.ifName) : null; const nn = f && f.nameif ? f.nameif : '?'; return h('tr', null, h('td', null, nn), h('td', { class: 'mono' }, ip(r.net) + ' ' + ip(r.mask)), h('td', { class: 'mono' }, r.nextHop != null ? ip(r.nextHop) : '—'), h('td', null, delBtn(() => run(['no route ' + nn + ' ' + ip(r.net) + ' ' + ip(r.mask) + ' ' + ip(r.nextHop)])))); }), 'Маршрутов нет'),
      hint('Обычно достаточно маршрута по умолчанию: route outside 0.0.0.0 0.0.0.0 <адрес провайдера>.'));
      return null;
    });
  }

  function asaNat(app, dev, box) {
    page(app, dev, box, 'Object NAT', (run, e) => {
      const n = inp('имя объекта (LAN)', 150);
      const kind = DW.select([['subnet', 'сеть'], ['host', 'узел']], 'subnet');
      const a = DW.ipInput('', 'адрес');
      const m = DW.ipInput('255.255.255.0', 'маска');
      const real = DW.select(nameifs(dev).map((x) => [x, x]), nameifs(dev).includes('inside') ? 'inside' : nameifs(dev)[0] || '');
      const mapped = DW.select(nameifs(dev).map((x) => [x, x]), nameifs(dev).includes('outside') ? 'outside' : nameifs(dev)[0] || '');
      const type = DW.select([['dynamic interface', 'PAT на адрес интерфейса'], ['static', 'static (один к одному)']], 'dynamic interface');
      const sa = DW.ipInput('', 'внешний адрес (для static)');
      box.append(h('div', { class: 'row', style: { flexWrap: 'wrap' } }, n, kind, a, m, h('span', null, '('), real, h('span', null, ','), mapped, h('span', null, ')'), type, sa, h('button', { class: 'btn primary small', onClick: () => {
        const x = DW.readIp(a, true);
        if (!x.ok || !n.value.trim()) { e.textContent = x.err || 'Укажите имя объекта'; return; }
        const cmds = ['object network ' + n.value.trim()];
        if (kind.value === 'host') cmds.push('host ' + ip(x.v));
        else { const y = DW.readIp(m, true); if (!y.ok) { e.textContent = y.err; return; } cmds.push('subnet ' + ip(x.v) + ' ' + ip(y.v)); }
        if (type.value === 'static') { const z = DW.readIp(sa, true); if (!z.ok) { e.textContent = 'Внешний адрес: ' + z.err; return; } cmds.push('nat (' + real.value + ',' + mapped.value + ') static ' + ip(z.v)); } else cmds.push('nat (' + real.value + ',' + mapped.value + ') dynamic interface');
        run(cmds);
      } }, 'Добавить')),
      tbl(['Объект', 'Адреса', 'NAT', ''], Object.entries(dev.asa.objects).map(([k, o]) => h('tr', null, h('td', null, k), h('td', { class: 'mono' }, o.ip != null ? (o.kind === 'host' ? ip(o.ip) : U.cidr(o.ip, o.mask)) : '—'),
        h('td', { class: 'mono' }, o.nat ? '(' + o.nat.real + ',' + o.nat.mapped + ') ' + (o.nat.type === 'static' ? 'static ' + ip(o.nat.addr) : 'dynamic ' + (o.nat.addr != null ? ip(o.nat.addr) : 'interface')) : '—'), h('td', null, delBtn(() => run(['no object network ' + k]))))), 'Объектов нет'));
      const xl = h('pre', { class: 'ios-log', style: { maxHeight: '160px' } });
      box.append(h('div', { style: { fontWeight: 600, marginTop: '12px' } }, 'Трансляции (show xlate)'), xl,
        hint('PAT (dynamic interface) — все внутренние узлы выходят под адресом внешнего интерфейса. Static — публикация сервера: внешний адрес постоянно соответствует внутреннему; чтобы к нему можно было подключиться снаружи, разрешите трафик списком доступа на outside (в ACL указывается настоящий, внутренний адрес).'));
      return () => {
        const d = app.net.getDevice(dev.id);
        const out = [];
        NS.cliAsa.exec(d, { mode: 'exec', history: [] }, 'show xlate', { out: (l) => out.push(l), write() {}, done() {}, clear() {}, mutate: (fn) => fn() });
        xl.textContent = out.join('\n');
      };
    });
  }

  function asaAcl(app, dev, box) {
    page(app, dev, box, 'Списки доступа', (run, e) => {
      const name = inp('имя (OUTSIDE)', 120);
      const act = DW.select([['permit', 'permit'], ['deny', 'deny']], 'permit');
      const proto = DW.select([['icmp', 'icmp'], ['tcp', 'tcp'], ['udp', 'udp'], ['ip', 'ip']], 'tcp');
      const addr = (ph) => { const t = DW.select([['any', 'any'], ['host', 'host'], ['net', 'сеть']], 'any'); const a = DW.ipInput('', ph); const m = DW.ipInput('', 'маска'); return { t, a, m, read() { if (t.value === 'any') return 'any'; const x = DW.readIp(a, true); if (!x.ok) throw new Error(x.err); if (t.value === 'host') return 'host ' + ip(x.v); const y = DW.readIp(m, true); if (!y.ok) throw new Error(y.err); return ip(x.v) + ' ' + ip(y.v); } }; };
      const src = addr('источник');
      const dst = addr('получатель');
      const port = DW.select([['', 'любой порт'], ['www', 'www (80)'], ['https', 'https (443)'], ['ftp', 'ftp (21)'], ['ssh', 'ssh (22)'], ['telnet', 'telnet (23)'], ['domain', 'domain (53)'], ['smtp', 'smtp (25)']], '');
      box.append(h('div', { class: 'row', style: { flexWrap: 'wrap' } }, name, act, proto, src.t, src.a, src.m, h('span', null, '→'), dst.t, dst.a, dst.m, port, h('button', { class: 'btn primary small', onClick: () => {
        try {
          if (!name.value.trim()) throw new Error('Укажите имя списка');
          run(['access-list ' + name.value.trim() + ' extended ' + act.value + ' ' + proto.value + ' ' + src.read() + ' ' + dst.read() + (port.value && (proto.value === 'tcp' || proto.value === 'udp') ? ' eq ' + port.value : '')]);
        } catch (x) { e.textContent = x.message; }
      } }, 'Добавить')));
      const acls = dev.asa.acls;
      for (const [k, l] of Object.entries(acls)) {
        box.append(h('div', { style: { fontWeight: 600, marginTop: '10px' } }, k), tbl(['#', 'Правило', 'Совпадений', ''], l.map((x, i) => h('tr', null, h('td', null, String(i + 1)),
          h('td', { class: 'mono' }, NS.asa.aclLine(k, x).replace('access-list ' + k + ' ', '')), h('td', null, x.remark ? '' : String(x.hits || 0)),
          h('td', null, delBtn(() => run(['no ' + NS.asa.aclLine(k, x)]))))), 'Пусто'));
      }
      box.append(h('div', { style: { fontWeight: 600, marginTop: '14px' } }, 'Применение (access-group … in interface)'),
        tbl(['Интерфейс', 'Уровень', 'Список (входящий)'], dev.ifaces.filter((f) => f.nameif).map((f) => h('tr', null, h('td', null, f.nameif), h('td', null, String(NS.asa.secOf(f))),
          h('td', null, DW.select([['', 'нет — по уровням безопасности']].concat(Object.keys(acls).map((k) => [k, k])), dev.asa.groups[f.nameif.toLowerCase()] || '', (v) => {
            const cur = dev.asa.groups[f.nameif.toLowerCase()];
            run(v ? ['access-group ' + v + ' in interface ' + f.nameif] : cur ? ['no access-group ' + cur + ' in interface ' + f.nameif] : []);
          })))), 'Нет интерфейсов с nameif'),
        hint('Список, применённый к интерфейсу, решает судьбу всего нового трафика, входящего через этот интерфейс; в конце любого списка — неявный запрет. Ответы на уже разрешённые соединения проходят без проверки ACL.'));
      return null;
    });
  }

  function asaInspect(app, dev, box) {
    page(app, dev, box, 'Инспекция (policy-map global_policy)', (run) => {
      const list = ['icmp', 'http', 'dns', 'ftp', 'tftp', 'sip', 'esmtp'];
      box.append(DW.form(...list.flatMap((x) => [lbl('inspect ' + x), UI.toggle('', dev.asa.inspect.includes(x), (on) => run(['policy-map global_policy', 'class inspection_default', (on ? '' : 'no ') + 'inspect ' + x]))])),
        hint('TCP и UDP ASA отслеживает всегда. ICMP — только с inspect icmp: тогда эхо-ответ на ping изнутри считается частью соединения и пропускается наружу-внутрь. Это частая причина «ping не проходит через ASA» в лабораторных.'));
      return null;
    });
  }

  function asaDhcp(app, dev, box) {
    page(app, dev, box, 'DHCP-сервер (dhcpd)', (run, e) => {
      const d = dev.asa.dhcpd;
      const dns = DW.ipInput(d.dns[0] != null ? ip(d.dns[0]) : '', 'DNS-сервер');
      DW.commitOnChange(dns, () => { const r = DW.readIp(dns, false); if (!r.ok) { e.textContent = r.err; return; } run([r.v == null ? 'no dhcpd dns' : 'dhcpd dns ' + ip(r.v)]); });
      box.append(DW.form(lbl('DNS для клиентов'), dns));
      box.append(tbl(['Интерфейс', 'Диапазон', 'Включён'], dev.ifaces.filter((f) => f.nameif && f.ip != null).map((f) => {
        const r = d.ranges[f.nameif];
        const s = DW.ipInput(r ? ip(r.start) : '', 'начало');
        const en = DW.ipInput(r ? ip(r.end) : '', 'конец');
        const save = () => { const a = DW.readIp(s, true); const b = DW.readIp(en, true); if (!a.ok || !b.ok) { e.textContent = a.err || b.err; return; } run(['dhcpd address ' + ip(a.v) + '-' + ip(b.v) + ' ' + f.nameif]); };
        DW.commitOnChange(s, save);
        DW.commitOnChange(en, save);
        return h('tr', null, h('td', null, f.nameif + ' (' + U.cidr(f.ip, f.mask) + ')'), h('td', null, h('div', { class: 'row' }, s, h('span', null, '–'), en)),
          h('td', null, UI.toggle('', d.enabled.includes(f.nameif), (on) => run([(on ? '' : 'no ') + 'dhcpd enable ' + f.nameif]))));
      }), 'Нет интерфейсов с nameif и адресом'));
      const b = h('div');
      box.append(h('div', { style: { fontWeight: 600, marginTop: '12px' } }, 'Выданные адреса'), b, hint('Шлюзом для клиентов ASA указывает свой адрес на этом интерфейсе.'));
      return () => {
        const x = app.net.getDevice(dev.id);
        UI.clear(b);
        b.append(tbl(['IP-адрес', 'MAC'], [...x.dhcpd.leases].map(([mac, l]) => h('tr', null, h('td', { class: 'mono' }, ip(l.ip)), h('td', { class: 'mono' }, mac))), 'Нет'));
      };
    });
  }

  DW.configBuilders.asa = asaConfig;

  /* ================= интерфейс маршрутизатора: зона ZBF ================= */

  const baseExtra = DW.routerIfaceExtra;
  DW.routerIfaceExtra = function (app, dev, f, run) {
    const rows = baseExtra ? baseExtra(app, dev, f, run) : [];
    const zones = dev.zbf ? Object.keys(dev.zbf.zones) : [];
    if (zones.length && f.kind !== 'loop') rows.push(lbl('Зона (ZBF)'), DW.select([['', 'нет']].concat(zones.map((k) => [k, k])), f.zone || '', (v) => run([v ? 'zone-member security ' + v : 'no zone-member security'])));
    return rows;
  };
})(globalThis.NetLab = globalThis.NetLab || {});
