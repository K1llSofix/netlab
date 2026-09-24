/* NetLab UI — вкладка «Службы» сервера (HTTP, DHCP, DNS, EMAIL, TFTP) и раздел DHCP маршрутизатора. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const ipT = DW.ipText;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });
  const onOff = (app, id, get, set, labels) => UI.toggle(get() ? labels[0] : labels[1], get(), (on) => DW.apply(app, () => set(app.net.getDevice(id), on)));

  /* ================= DHCP ================= */

  function leasesBox(app, id, box) {
    box.appendChild(DW.section('Выданные адреса'));
    const leases = h('div');
    box.appendChild(leases);
    let sig = null;
    return () => {
      const d = app.net.getDevice(id);
      if (!d) return;
      const list = d.dhcpd.leaseList();
      const s2 = list.map((l) => l.mac + l.ip).join();
      if (s2 === sig) return;
      sig = s2;
      UI.clear(leases);
      leases.appendChild(h('table', { class: 'tbl' },
        h('tr', null, h('th', null, 'IP-адрес'), h('th', null, 'MAC клиента'), h('th', null, 'Клиент'), h('th', null, 'Пул')),
        list.length ? list.map((l) => h('tr', null, h('td', { class: 'mono' }, U.ipStr(l.ip)), h('td', { class: 'mono' }, l.mac), h('td', null, app.nameForMac(l.mac)), h('td', null, l.pool || '')))
          : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Адреса ещё не выдавались.'))));
    };
  }

  function poolsTable(app, id, svc, onDelete) {
    return h('table', { class: 'tbl' },
      h('tr', null, h('th', null, 'Пул'), h('th', null, 'Сеть'), h('th', null, 'Выдаёт адреса'), h('th', null, 'Шлюз'), h('th', null, 'DNS'), h('th')),
      svc.pools.length ? svc.pools.map((p) => h('tr', null,
        h('td', null, p.name), h('td', { class: 'mono' }, U.cidr(p.network, p.mask)), h('td', { class: 'mono' }, U.ipStr(p.start) + ' – ' + U.ipStr(p.end)),
        h('td', { class: 'mono' }, ipT(p.gateway) || '—'), h('td', { class: 'mono' }, ipT(p.dns) || '—'),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить пул', onClick: () => onDelete(p) }, UI.icon('delete')))))
        : h('tr', { class: 'empty' }, h('td', { colspan: 6 }, 'Пулов нет — добавьте первый ниже.')));
  }

  /** DHCP: на маршрутизаторе — через команды IOS (ip dhcp pool), на сервере — как в Packet Tracer. */
  DW.dhcpSection = function (app, id, box, isRouter) {
    const dev = app.net.getDevice(id);
    const svc = dev.dhcpd;
    box.appendChild(DW.section('DHCP'));
    const e = err();
    if (isRouter) {
      box.appendChild(h('div', { class: 'row', style: { marginBottom: '10px' } },
        UI.toggle('Служба DHCP (service dhcp)', svc.enabled, (on) => DW.iosApply(app, app.net.getDevice(id), [on ? 'service dhcp' : 'no service dhcp'], e))));
      box.appendChild(h('div', { class: 'hint-box', style: { marginBottom: '10px' } },
        'Пул выбирается по сети интерфейса, на который пришёл запрос. Клиентам за другим маршрутизатором нужен DHCP relay (ip helper-address) на их шлюзе.'));
      box.appendChild(poolsTable(app, id, svc, (p) => DW.iosApply(app, app.net.getDevice(id), ['no ip dhcp pool ' + p.name], e)));
      const nameI = h('input', { class: 'inp', value: 'LAN' + (svc.pools.length + 1) });
      const netI = DW.ipInput('', 'сеть, напр. 192.168.1.0');
      const maskI = DW.ipInput('255.255.255.0');
      const gwI = DW.ipInput('', 'default-router');
      const dnsI = DW.ipInput('', 'необязательно');
      const tftpI = DW.ipInput('', 'для IP-телефонов (CME)');
      netI.addEventListener('blur', () => {
        const v = U.parseIp(netI.value);
        const m = U.parseMask(maskI.value);
        if (v != null && m != null && !gwI.value.trim()) gwI.value = U.ipStr(U.net(v, m) + 1);
      });
      const add = () => {
        const n = DW.readIp(netI, true);
        if (!n.ok) { e.textContent = 'Сеть: ' + n.err; return; }
        const m = DW.readMask(maskI);
        if (!m.ok) { e.textContent = m.err; return; }
        const g = DW.readIp(gwI, false);
        if (!g.ok) { e.textContent = 'Шлюз: ' + g.err; return; }
        const d = DW.readIp(dnsI, false);
        if (!d.ok) { e.textContent = 'DNS: ' + d.err; return; }
        const cmds = ['ip dhcp pool ' + nameI.value.trim(), 'network ' + U.ipStr(U.net(n.v, m.v)) + ' ' + U.ipStr(m.v)];
        if (g.v != null) cmds.push('default-router ' + U.ipStr(g.v));
        if (d.v != null) cmds.push('dns-server ' + U.ipStr(d.v));
        const t = DW.readIp(tftpI, false);
        if (!t.ok) { e.textContent = 'TFTP: ' + t.err; return; }
        if (t.v != null) cmds.push('option 150 ip ' + U.ipStr(t.v));
        DW.iosApply(app, app.net.getDevice(id), cmds, e);
      };
      box.appendChild(DW.section('Добавить пул'));
      box.appendChild(DW.form(lbl('Имя пула'), nameI, lbl('Сеть'), netI, lbl('Маска'), maskI, lbl('Шлюз (default-router)'), gwI, lbl('DNS-сервер'), dnsI, lbl('TFTP (option 150)'), tftpI,
        h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: add }, 'Добавить пул'), e)));
      const exFrom = DW.ipInput('', 'от');
      const exTo = DW.ipInput('', 'до (необязательно)');
      box.appendChild(DW.section('Исключённые адреса (ip dhcp excluded-address)'));
      box.appendChild(h('div', null,
        svc.excluded.length ? h('div', { class: 'row', style: { marginBottom: '6px' } }, svc.excluded.map((r) => h('span', { class: 'rchip' }, U.ipStr(r.from) + (r.to !== r.from ? ' – ' + U.ipStr(r.to) : ''),
          h('button', { title: 'Убрать', onClick: () => DW.iosApply(app, app.net.getDevice(id), ['no ip dhcp excluded-address ' + U.ipStr(r.from) + (r.to !== r.from ? ' ' + U.ipStr(r.to) : '')], e) }, '×')))) : h('div', { class: 'muted', style: { marginBottom: '6px' } }, 'Нет.'),
        h('div', { class: 'row' }, h('div', { style: { width: '150px' } }, exFrom), h('div', { style: { width: '150px' } }, exTo),
          h('button', { class: 'btn outline small', onClick: () => {
            const a = DW.readIp(exFrom, true);
            if (!a.ok) { e.textContent = a.err; return; }
            const b = DW.readIp(exTo, false);
            if (!b.ok) { e.textContent = b.err; return; }
            DW.iosApply(app, app.net.getDevice(id), ['ip dhcp excluded-address ' + U.ipStr(a.v) + (b.v != null ? ' ' + U.ipStr(b.v) : '')], e);
          } }, 'Исключить'))));
      return leasesBox(app, id, box);
    }

    box.appendChild(h('div', { class: 'row', style: { marginBottom: '10px' } },
      h('span', { class: 'muted' }, 'Служба'),
      DW.radio('dhcpsvc-' + id, [['on', 'Вкл'], ['off', 'Выкл']], svc.enabled ? 'on' : 'off', (v) => DW.apply(app, () => { app.net.getDevice(id).dhcpd.enabled = v === 'on'; app.nudgeDhcp(); }))));
    box.appendChild(h('div', { class: 'hint-box', style: { marginBottom: '10px' } },
      'Сервер выдаёт адреса клиентам своей сети, а также другим сетям через DHCP relay (ip helper-address на маршрутизаторе). Пул выбирается по сети запроса.'));
    const nameI = h('input', { class: 'inp', value: svc.pools.length ? 'serverPool' + (svc.pools.length + 1) : 'serverPool' });
    const gwI = DW.ipInput('', 'шлюз для клиентов');
    const dnsI = DW.ipInput('', 'необязательно');
    const tftpI = DW.ipInput('', 'необязательно (option 150)');
    const startI = DW.ipInput('', 'напр. 192.168.1.100');
    const maskI = DW.ipInput('255.255.255.0');
    const countI = h('input', { class: 'inp', type: 'number', min: 1, value: 50 });
    const read = () => {
      const st = DW.readIp(startI, true);
      if (!st.ok) { e.textContent = 'Начальный адрес: ' + st.err; return null; }
      const m = DW.readMask(maskI);
      if (!m.ok) { e.textContent = m.err; return null; }
      const g = DW.readIp(gwI, false);
      if (!g.ok) { e.textContent = 'Шлюз: ' + g.err; return null; }
      const d = DW.readIp(dnsI, false);
      if (!d.ok) { e.textContent = 'DNS: ' + d.err; return null; }
      const n = parseInt(countI.value, 10);
      if (!(n > 0)) { e.textContent = 'Максимальное число пользователей должно быть больше 0'; return null; }
      const t = DW.readIp(tftpI, false);
      if (!t.ok) { e.textContent = 'TFTP: ' + t.err; return null; }
      return { name: nameI.value, start: st.v, end: st.v + n - 1, mask: m.v, gateway: g.v, dns: d.v, tftp: t.v };
    };
    startI.addEventListener('blur', () => {
      const v = U.parseIp(startI.value);
      if (v != null && !gwI.value.trim()) gwI.value = U.ipStr(U.net(v, U.parseMask(maskI.value) || U.maskFromPrefix(24)) + 1);
    });
    const selectPool = (p) => {
      nameI.value = p.name;
      gwI.value = ipT(p.gateway);
      dnsI.value = ipT(p.dns);
      tftpI.value = ipT(p.tftp);
      startI.value = U.ipStr(p.start);
      maskI.value = U.ipStr(p.mask);
      countI.value = p.end - p.start + 1;
      nameI.dataset.edit = p.name;
    };
    box.appendChild(DW.form(lbl('Имя пула'), nameI, lbl('Шлюз по умолчанию'), gwI, lbl('DNS-сервер'), dnsI, lbl('TFTP (option 150)'), tftpI, lbl('Начальный IP'), startI, lbl('Маска подсети'), maskI, lbl('Максимум пользователей'), countI,
      h('span'), h('div', { class: 'row' },
        h('button', { class: 'btn primary small', onClick: () => { const p = read(); if (p) DW.apply(app, () => { app.net.getDevice(id).dhcpd.setPool(p); app.nudgeDhcp(); }, e); } }, 'Добавить'),
        h('button', { class: 'btn outline small', onClick: () => { const p = read(); if (p) DW.apply(app, () => { app.net.getDevice(id).dhcpd.setPool(p, nameI.dataset.edit || p.name); app.nudgeDhcp(); }, e); } }, 'Сохранить'),
        e)));
    const tbl = poolsTable(app, id, svc, (p) => DW.apply(app, () => app.net.getDevice(id).dhcpd.removePool(p.name)));
    tbl.classList.add('clickable');
    [...tbl.querySelectorAll('tr')].slice(1).forEach((tr, i) => { if (svc.pools[i]) tr.addEventListener('click', (ev) => { if (!ev.target.closest('button')) selectPool(svc.pools[i]); }); });
    box.appendChild(h('div', { style: { marginTop: '10px' } }, tbl));
    return leasesBox(app, id, box);
  };

  /* ================= DNS ================= */

  function dnsSection(app, id, box) {
    const dev = app.net.getDevice(id);
    const svc = dev.dnsd;
    const e = err();
    box.appendChild(DW.section('DNS'));
    box.appendChild(h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'muted' }, 'Служба DNS'),
      DW.radio('dnssvc-' + id, [['on', 'Вкл'], ['off', 'Выкл']], svc.enabled ? 'on' : 'off', (v) => DW.apply(app, () => { app.net.getDevice(id).dnsd.enabled = v === 'on'; }))));
    const nameI = h('input', { class: 'inp mono', placeholder: 'например www.lab', spellcheck: 'false' });
    const ipI = DW.ipInput('', 'IP-адрес');
    const add = () => {
      const a = DW.readIp(ipI, true);
      if (!a.ok) { e.textContent = a.err; return; }
      DW.apply(app, () => app.net.getDevice(id).dnsd.setRecord(nameI.value, a.v), e);
    };
    DW.onEnter(ipI, add);
    box.appendChild(DW.form(lbl('Имя'), nameI, lbl('Тип'), h('div', null, 'A Record'), lbl('Адрес'), ipI,
      h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: add }, 'Добавить'), e)));
    box.appendChild(h('table', { class: 'tbl', style: { marginTop: '10px' } },
      h('tr', null, h('th', null, '№'), h('th', null, 'Имя'), h('th', null, 'Тип'), h('th', null, 'Адрес'), h('th')),
      svc.records.length ? svc.records.map((r, i) => h('tr', null, h('td', null, String(i)), h('td', { class: 'mono' }, r.name), h('td', null, 'A Record'), h('td', { class: 'mono' }, U.ipStr(r.ip)),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.apply(app, () => app.net.getDevice(id).dnsd.removeRecord(r.name)) }, UI.icon('delete')))))
        : h('tr', { class: 'empty' }, h('td', { colspan: 5 }, 'Записей нет.'))));
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Чтобы компьютеры обращались по имени, укажите адрес этого сервера в поле «DNS-сервер» их настроек (или в пуле DHCP). Почтовый сервер другого домена тоже находится через DNS: запись с именем домена (например, mail.lab).'));
  }

  /* ================= HTTP ================= */

  function httpSection(app, id, box) {
    const dev = app.net.getDevice(id);
    const svc = dev.httpd;
    const e = err();
    box.appendChild(DW.section('HTTP'));
    box.appendChild(h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'muted' }, 'HTTP'),
      DW.radio('httpsvc-' + id, [['on', 'Вкл'], ['off', 'Выкл']], svc.enabled ? 'on' : 'off', (v) => DW.apply(app, () => { const d = app.net.getDevice(id); d.httpd.enabled = v === 'on'; d.rebindServices(); }))));
    const editor = h('div');
    const openEditor = (name) => {
      UI.clear(editor);
      const n = h('input', { class: 'inp mono', value: name || '', placeholder: 'page.html' });
      const t = h('textarea', { class: 'inp mono', rows: 12, spellcheck: 'false' });
      t.value = name ? app.net.getDevice(id).httpd.files.get(name) || '' : '<html>\n<h1>Новая страница</h1>\n<p>Текст</p>\n</html>';
      editor.append(DW.section(name ? 'Редактирование: ' + name : 'Новый файл'), DW.form(lbl('Имя файла'), n), h('div', { style: { marginTop: '8px' } }, t),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn primary small', onClick: () => DW.apply(app, () => { const d = app.net.getDevice(id); if (name && name !== n.value.trim().toLowerCase()) d.httpd.removeFile(name); d.httpd.setFile(n.value, t.value); }, e, 'Файл сохранён') }, 'Сохранить'),
          h('button', { class: 'btn outline small', onClick: () => UI.clear(editor) }, 'Закрыть'), e));
      t.focus();
    };
    const files = [...svc.files.keys()].sort();
    box.appendChild(h('table', { class: 'tbl' },
      h('tr', null, h('th', null, 'Файл'), h('th', null, 'Размер'), h('th'), h('th')),
      files.length ? files.map((f) => h('tr', null, h('td', { class: 'mono' }, f), h('td', { class: 'muted' }, svc.files.get(f).length + ' симв.'),
        h('td', null, h('button', { class: 'btn small outline', onClick: () => openEditor(f) }, 'Изменить')),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.apply(app, () => app.net.getDevice(id).httpd.removeFile(f)) }, UI.icon('delete')))))
        : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Файлов нет.'))));
    box.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn outline small', onClick: () => openEditor(null) }, '+ Новый файл')));
    box.appendChild(editor);
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Откройте «Web Browser» на рабочем столе ПК и введите http://<IP сервера> или его DNS-имя. Ссылки <a href="…"> между страницами работают.'));
  }

  /* ================= EMAIL ================= */

  function emailSection(app, id, box) {
    const dev = app.net.getDevice(id);
    const svc = dev.maild;
    const e = err();
    box.appendChild(DW.section('EMAIL'));
    box.appendChild(h('div', { class: 'row', style: { marginBottom: '10px', gap: '24px' } },
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'SMTP'), DW.radio('smtp-' + id, [['on', 'Вкл'], ['off', 'Выкл']], svc.smtp ? 'on' : 'off', (v) => DW.apply(app, () => { const d = app.net.getDevice(id); d.maild.smtp = v === 'on'; d.rebindServices(); }))),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'POP3'), DW.radio('pop3-' + id, [['on', 'Вкл'], ['off', 'Выкл']], svc.pop3 ? 'on' : 'off', (v) => DW.apply(app, () => { const d = app.net.getDevice(id); d.maild.pop3 = v === 'on'; d.rebindServices(); })))));
    const dom = h('input', { class: 'inp mono', value: svc.domain, placeholder: 'например mail.lab' });
    const user = h('input', { class: 'inp mono', placeholder: 'пользователь' });
    const pw = h('input', { class: 'inp', type: 'password', placeholder: 'пароль' });
    box.appendChild(DW.form(lbl('Домен'), h('div', { class: 'row' }, dom, h('button', { class: 'btn primary small', onClick: () => DW.apply(app, () => app.net.getDevice(id).maild.setDomain(dom.value), e, true) }, 'Задать'))));
    box.appendChild(DW.section('Пользователи'));
    box.appendChild(DW.form(lbl('Пользователь'), user, lbl('Пароль'), pw,
      h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: () => DW.apply(app, () => app.net.getDevice(id).maild.setUser(user.value, pw.value), e) }, 'Добавить / сменить пароль'), e)));
    box.appendChild(h('table', { class: 'tbl', style: { marginTop: '10px' } },
      h('tr', null, h('th', null, 'Пользователь'), h('th', null, 'Адрес'), h('th', null, 'Писем в ящике'), h('th')),
      svc.users.length ? svc.users.map((u) => h('tr', null, h('td', { class: 'mono' }, u.name), h('td', { class: 'mono' }, svc.domain ? u.name + '@' + svc.domain : '— задайте домен —'),
        h('td', null, String((svc.boxes.get(u.name) || []).length)),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.apply(app, () => app.net.getDevice(id).maild.removeUser(u.name)) }, UI.icon('delete')))))
        : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Пользователей нет.'))));
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } },
      'На ПК: «Рабочий стол» → Email → настройте имя, адрес (user@домен), серверы входящей и исходящей почты (IP или имя этого сервера), логин и пароль. ' +
      'Письмо нескольким получателям доставляется каждому отдельно — в отчёте видно, кому дошло, а кому нет и почему.'));
  }

  /* ================= TFTP ================= */

  function tftpSection(app, id, box) {
    const dev = app.net.getDevice(id);
    const svc = dev.tftpd;
    box.appendChild(DW.section('TFTP'));
    box.appendChild(h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'muted' }, 'Служба'),
      DW.radio('tftp-' + id, [['on', 'Вкл'], ['off', 'Выкл']], svc.enabled ? 'on' : 'off', (v) => DW.apply(app, () => { app.net.getDevice(id).tftpd.enabled = v === 'on'; }))));
    const files = [...svc.files.keys()].sort();
    box.appendChild(h('table', { class: 'tbl' },
      h('tr', null, h('th', null, 'Файл'), h('th', null, 'Размер'), h('th'), h('th')),
      files.length ? files.map((f) => h('tr', null, h('td', { class: 'mono' }, f), h('td', { class: 'muted' }, svc.files.get(f).length + ' байт'),
        h('td', null, h('button', { class: 'btn small outline', onClick: () => UI.modal({ title: f, body: h('pre', { class: 'code-view' }, svc.files.get(f)), actions: [{ label: 'Закрыть', primary: true }] }) }, 'Просмотр')),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.apply(app, () => app.net.getDevice(id).tftpd.files.delete(f)) }, UI.icon('delete')))))
        : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Файлов нет. Сохраните конфигурацию с маршрутизатора: copy running-config tftp:'))));
  }

  DW.servicesTab = function (app, id) {
    const st = {};
    const tab = {
      id: 'services',
      label: 'Службы',
      flush: true,
      live: null,
      render(body) {
        const items = [{ group: 'SERVICES' }, { id: 'http', label: 'HTTP' }, { id: 'dhcp', label: 'DHCP' }, { id: 'tftp', label: 'TFTP' }, { id: 'dns', label: 'DNS' }, { id: 'email', label: 'EMAIL' }, { id: 'ftp', label: 'FTP' }, { id: 'syslog', label: 'SYSLOG' }, { id: 'ntp', label: 'NTP' }, { id: 'aaa', label: 'AAA' }, { id: 'iot', label: 'IoT' }];
        tab.live = null;
        DW.sidebarLayout(body, items, st, 'sec', (sec, box) => {
          const dev = app.net.getDevice(id);
          tab.live = null;
          if (dev.iface.ip == null) box.appendChild(h('div', { class: 'hint-box warn', style: { marginBottom: '10px' } }, 'Серверу нужен IP-адрес (вкладка «Настройка»), иначе службы недоступны.'));
          if (sec === 'http') httpSection(app, id, box);
          else if (sec === 'dhcp') { tab.live = DW.dhcpSection(app, id, box, false); tab.live(); }
          else if (sec === 'dns') dnsSection(app, id, box);
          else if (sec === 'email') emailSection(app, id, box);
          else if (sec === 'iot') { tab.live = DW.iotServerSection(app, dev, box); tab.live(); }
          else if (sec === 'ftp') { tab.live = DW.ftpSection(app, dev, box); if (tab.live) tab.live(); }
          else if (sec === 'syslog') { tab.live = DW.syslogSection(app, dev, box); if (tab.live) tab.live(); }
          else if (sec === 'ntp') { tab.live = DW.ntpSection(app, dev, box); if (tab.live) tab.live(); }
          else if (sec === 'aaa') { tab.live = DW.aaaSection(app, dev, box); if (tab.live) tab.live(); }
          else tftpSection(app, id, box);
        });
      },
    };
    return tab;
  };
})(globalThis.NetLab = globalThis.NetLab || {});
