/* NetLab UI — вкладка «Настройка» (Config) в стиле Packet Tracer: слева GLOBAL / ROUTING / SWITCHING /
 * INTERFACE, справа форма. На маршрутизаторе и коммутаторе каждое действие выполняется IOS-командой,
 * которая показывается внизу в «Эквивалентных командах IOS». */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const ipT = DW.ipText;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });

  /* ================= общие поля ================= */

  function displayName(app, dev) {
    const inp = h('input', { class: 'inp', value: dev.name, spellcheck: 'false' });
    const e = err();
    DW.commitOnChange(inp, () => {
      if (inp.value.trim() === dev.name) return;
      if (!DW.apply(app, () => app.net.renameDevice(app.net.getDevice(dev.id), inp.value), e)) inp.classList.add('bad');
    });
    return [lbl('Отображаемое имя'), h('div', null, inp, e)];
  }

  function portPhysRows(app, dev, i, iosName) {
    const p = dev.ports[i];
    const rows = [];
    const e = err();
    const st = UI.toggle(p.adminUp ? 'Включён' : 'Выключен', p.adminUp && !p.errDisabled, (on) => {
      if (iosName) DW.iosApply(app, dev, [DW.ifCmd(iosName), on ? 'no shutdown' : 'shutdown'], e);
      else DW.apply(app, () => { const d = app.net.getDevice(dev.id); d.ports[i].adminUp = on; }, e);
    });
    rows.push(lbl('Состояние порта'), h('div', null, st, p.errDisabled ? h('span', { class: 'st', style: { color: 'var(--warn)', marginLeft: '8px' } }, 'err-disabled (port-security)') : null, e));
    if (p.media === 'copper' || p.media === 'fiber') {
      const bw = DW.select([['auto', 'Авто'], ['1000', '1000 Мбит/с'], ['100', '100 Мбит/с'], ['10', '10 Мбит/с']], String(p.bandwidth), (v) => {
        if (iosName) DW.iosApply(app, dev, [DW.ifCmd(iosName), v === 'auto' ? 'speed auto' : 'speed ' + v], e);
        else DW.apply(app, () => { app.net.getDevice(dev.id).ports[i].bandwidth = v === 'auto' ? 'auto' : Number(v); app.net.markRouting(); }, e);
      });
      const dx = DW.select([['auto', 'Авто'], ['full', 'Полный'], ['half', 'Полудуплекс']], p.duplex, (v) => {
        if (iosName) DW.iosApply(app, dev, [DW.ifCmd(iosName), 'duplex ' + v], e);
        else DW.apply(app, () => { app.net.getDevice(dev.id).ports[i].duplex = v; }, e);
      });
      rows.push(lbl('Пропускная способность'), bw, lbl('Дуплекс'), dx);
    }
    if (p.mac) {
      const mac = h('input', { class: 'inp mono', value: p.mac, spellcheck: 'false', readOnly: !!iosName });
      if (!iosName) {
        DW.commitOnChange(mac, () => {
          const v = mac.value.trim().toUpperCase().replace(/[.-]/g, '');
          const m = /^[0-9A-F]{12}$/.test(v.replace(/:/g, '')) ? v.replace(/:/g, '').match(/../g).join(':') : null;
          if (!m) { e.textContent = 'MAC-адрес: 12 шестнадцатеричных цифр, например 00:D0:12:34:56:78'; mac.classList.add('bad'); return; }
          const dup = [...app.net.devices.values()].some((d) => d.ports.some((pp) => pp !== p && pp.mac === m));
          DW.apply(app, () => { app.net.getDevice(dev.id).ports[i].mac = m; }, e);
          if (dup) UI.toast('Внимание: такой MAC-адрес уже есть в сети — возможны проблемы с коммутацией', 'warn', 5000);
        });
      }
      rows.push(lbl('MAC-адрес'), mac);
    }
    const link = p.link ? DW.peerText(app.net, dev, i) : p.radio ? DW.peerText(app.net, dev, i) : 'не подключён';
    const l = p.link && app.net.links.get(p.link);
    const issue = l ? app.net.linkIssue(l) : null;
    rows.push(lbl('Подключение'), h('div', null, DW.stateDot(app.net.portVisualState(dev, i) === 'up' ? 'up' : p.link ? 'down' : 'none'), link,
      l && !l.wireless ? h('span', { class: 'muted' }, ' · ' + (NS.Network.CABLES[l.cable] || l.cable)) : null,
      issue ? h('div', { class: 'err-text' }, issue) : null));
    return rows;
  }

  /* ================= ПК / сервер / ноутбук / планшет / принтер ================= */

  function hostGlobal(app, dev, box) {
    const f = dev.iface;
    const gwI = DW.ipInput(ipT(dev.gateway), 'необязательно');
    const dnsI = DW.ipInput(ipT(dev.dns), 'необязательно');
    const e = err();
    const mode = f.dhcp ? 'dhcp' : 'static';
    const applyStatic = () => {
      const g = DW.readIp(gwI, false);
      if (!g.ok) { e.textContent = 'Шлюз: ' + g.err; return; }
      const d = DW.readIp(dnsI, false);
      if (!d.ok) { e.textContent = 'DNS: ' + d.err; return; }
      DW.apply(app, () => { const x = app.net.getDevice(dev.id); x.setStatic(x.iface.ip, x.iface.mask, g.v, d.v); }, e);
    };
    for (const i of [gwI, dnsI]) { i.readOnly = mode === 'dhcp'; DW.commitOnChange(i, applyStatic); }
    const clock = h('div', { class: 'mono' }, dev.clock());
    box.appendChild(DW.section('Глобальные настройки'));
    box.appendChild(DW.form(
      ...displayName(app, dev),
      lbl('Интерфейс'), h('div', { class: 'mono' }, f.name),
      lbl('Шлюз и DNS (IPv4)'), DW.radio('gw-' + dev.id, [['dhcp', 'DHCP'], ['static', 'Статически']], mode, (v) => {
        if (v === 'dhcp') DW.apply(app, () => app.net.getDevice(dev.id).setDhcp(), e);
        else DW.apply(app, () => { const x = app.net.getDevice(dev.id); x.setStatic(null, null, null, null); }, e);
      }),
      lbl('Основной шлюз'), gwI,
      lbl('DNS-сервер'), dnsI,
      lbl('Часы устройства'), clock,
      h('div', { class: 'full' }, e)));
    return () => { clock.textContent = app.net.getDevice(dev.id).clock(); };
  }

  function hostIface(app, dev, box) {
    const f = dev.iface;
    box.appendChild(DW.section(f.name));
    if (f.port < 0) {
      box.appendChild(h('div', { class: 'hint-box warn' }, 'Сетевая карта не установлена. Выключите устройство и поставьте модуль на вкладке «Физический вид».'));
      return null;
    }
    const p = dev.ports[f.port];
    const rows = portPhysRows(app, dev, f.port, null);
    const e = err();
    const ipI = DW.ipInput(ipT(f.ip), 'например 192.168.1.10');
    const maskI = DW.ipInput(ipT(f.mask), '255.255.255.0');
    const mode = f.dhcp ? 'dhcp' : 'static';
    const applyIp = () => {
      const a = DW.readIp(ipI, false);
      if (!a.ok) { e.textContent = a.err; return; }
      let m = { ok: true, v: null };
      if (a.v != null) {
        if (!maskI.value.trim()) maskI.value = DW.classfulMask(a.v);
        m = DW.readMask(maskI);
        if (!m.ok) { e.textContent = m.err; return; }
      }
      DW.apply(app, () => { const x = app.net.getDevice(dev.id); x.setStatic(a.v, m.v, a.v == null ? null : x.gateway != null && U.sameNet(x.gateway, a.v, m.v) ? x.gateway : null, x.dns); }, e);
    };
    for (const i of [ipI, maskI]) { i.readOnly = mode === 'dhcp'; DW.commitOnChange(i, applyIp); }
    ipI.addEventListener('blur', () => { const v = U.parseIp(ipI.value); if (v != null && !maskI.value.trim()) maskI.value = DW.classfulMask(v); });
    rows.push(lbl('IP-конфигурация'), DW.radio('ipc-' + dev.id, [['dhcp', 'DHCP'], ['static', 'Статически']], mode, (v) => {
      if (v === 'dhcp') DW.apply(app, () => app.net.getDevice(dev.id).setDhcp(), e);
      else { ipI.readOnly = false; maskI.readOnly = false; ipI.focus(); }
    }));
    rows.push(lbl('IPv4-адрес'), ipI, lbl('Маска подсети'), maskI);
    const status = h('div', { class: 'hint-box' });
    rows.push(h('div', { class: 'full' }, e), h('div', { class: 'full' }, status));
    box.appendChild(DW.form(...rows));
    if (p.media === 'wireless') wifiClientForm(app, dev, box);
    return () => {
      const d = app.net.getDevice(dev.id);
      if (!d) return;
      status.style.display = d.iface.dhcp || d.conflict ? '' : 'none';
      status.textContent = (d.iface.dhcp ? (d.dhcpStatus || 'Запрос адреса…') : '') + (d.conflict ? ' ⚠ Конфликт IP-адресов с ' + d.conflict.mac : '');
      if (d.iface.dhcp && document.activeElement !== ipI) { ipI.value = ipT(d.iface.ip); maskI.value = ipT(d.iface.mask); }
    };
  }

  function wifiClientForm(app, dev, box) {
    const w = dev.wifi;
    const ssid = h('input', { class: 'inp', value: w.ssid || '', placeholder: 'имя сети' });
    const sec = DW.select([['open', 'Отключена (открытая сеть)'], ['wpa2', 'WPA2-PSK']], w.security || 'open');
    const key = h('input', { class: 'inp', type: 'password', value: w.key || '', placeholder: 'пароль сети (8–63 символа)' });
    const e = err();
    const st = h('div', { class: 'hint-box', style: { marginTop: '8px' } });
    const save = () => DW.apply(app, () => app.net.getDevice(dev.id).setWifi({ ssid: ssid.value.trim(), security: sec.value, key: key.value }), e, true);
    box.appendChild(DW.section('Беспроводная сеть'));
    box.appendChild(DW.form(lbl('SSID'), ssid, lbl('Аутентификация'), sec, lbl('Ключ WPA2'), key,
      h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: save }, 'Подключить'), e)));
    box.appendChild(st);
    const upd = () => {
      const r = app.net.wirelessStatus(app.net.getDevice(dev.id));
      st.textContent = r && r.ap ? '✓ Подключено к «' + r.ap.wifi.ssid + '» через ' + r.ap.name : '✕ Нет подключения: ' + (r ? r.reason : '—');
      st.className = 'hint-box' + (r && r.ap ? '' : ' warn');
    };
    upd();
    return upd;
  }

  function hostConfig(app, id, st) {
    return (body) => {
      const dev = app.net.getDevice(id);
      const items = [{ group: 'GLOBAL' }, { id: 'global', label: 'Настройки' }, { group: 'INTERFACE' }, { id: 'if', label: dev.iface.name }];
      let live = null;
      DW.sidebarLayout(body, items, st, 'sec', (sec, box) => {
        const d = app.net.getDevice(id);
        live = sec === 'global' ? hostGlobal(app, d, box) : hostIface(app, d, box);
      });
      return () => { if (live) live(); };
    };
  }

  /* ================= маршрутизатор и коммутатор: общее ================= */

  function iosGlobal(app, dev, box) {
    const e = err();
    const host = h('input', { class: 'inp', value: dev.ios.hostname, spellcheck: 'false' });
    DW.commitOnChange(host, () => DW.iosApply(app, app.net.getDevice(dev.id), ['hostname ' + host.value.trim()], e));
    const dirty = h('div');
    const save = () => {
      const d = app.net.getDevice(dev.id);
      DW.apply(app, () => d.saveNvram(), e, 'Конфигурация сохранена в NVRAM (startup-config)');
      app.iosLog(dev.id).push(d.ios.hostname + '#copy running-config startup-config', 'Building configuration...', '[OK]');
      app.emitIosLog(dev.id);
    };
    const erase = async () => {
      if (!(await UI.confirm('Стереть NVRAM', 'Startup-config будет удалён. После перезагрузки устройство загрузится с заводскими настройками.', 'Стереть', true))) return;
      const d = app.net.getDevice(dev.id);
      DW.apply(app, () => d.eraseNvram(), e, 'NVRAM очищена');
      app.iosLog(dev.id).push(d.ios.hostname + '#erase startup-config', '[OK]');
      app.emitIosLog(dev.id);
    };
    const exportText = (kind) => {
      const d = app.net.getDevice(dev.id);
      const lines = kind === 'run' ? NS.cli.runningConfig(d) : d.nvram ? d.nvram.text : null;
      if (!lines) { UI.toast('Startup-config отсутствует — сначала сохраните конфигурацию', 'err'); return; }
      UI.download(d.ios.hostname + '-' + (kind === 'run' ? 'running' : 'startup') + '-config.txt', lines.join('\n'), 'text/plain');
    };
    const mergeFile = async (toStartup) => {
      const f = await UI.pickFile('.txt,.cfg,text/plain');
      if (!f) return;
      const d = app.net.getDevice(dev.id);
      const lines = f.text.split(/\r?\n/);
      const errs = [];
      const io = { out: (l) => { if (/^%/.test(l)) errs.push(l); }, write: () => {}, done: () => {}, mutate: (fn) => app.mutate(fn) };
      if (toStartup) {
        const keep = d.configState();
        NS.cliIos.replayConfig(d, lines, io, true);
        app.mutate(() => { d.saveNvram(); d.applyConfigState(keep); });
      } else NS.cliIos.replayConfig(d, lines, io);
      UI.toast('Файл «' + f.name + '» применён' + (errs.length ? ', ошибок: ' + errs.length : ''), errs.length ? 'warn' : 'ok', 5000);
    };
    box.appendChild(DW.section('Глобальные настройки'));
    const rows = [
      ...displayName(app, dev),
      lbl('Hostname'), host,
      lbl('NVRAM'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: save }, 'Сохранить'), h('button', { class: 'btn outline small danger', onClick: erase }, 'Стереть'), dirty),
      lbl('Startup Config'), h('div', { class: 'row' }, h('button', { class: 'btn outline small', onClick: () => mergeFile(true) }, 'Загрузить…'), h('button', { class: 'btn outline small', onClick: () => exportText('start') }, 'Экспорт…')),
      lbl('Running Config'), h('div', { class: 'row' }, h('button', { class: 'btn outline small', onClick: () => exportText('run') }, 'Экспорт…'), h('button', { class: 'btn outline small', onClick: () => mergeFile(false) }, 'Объединить…')),
    ];
    if (dev.type === 'switch') {
      const gw = DW.ipInput(ipT(dev.defaultGateway), 'для управления коммутатором');
      DW.commitOnChange(gw, () => {
        const r = DW.readIp(gw, false);
        if (!r.ok) { e.textContent = r.err; return; }
        DW.iosApply(app, app.net.getDevice(dev.id), [r.v == null ? 'no ip default-gateway' : 'ip default-gateway ' + U.ipStr(r.v)], e);
      });
      rows.push(lbl('Шлюз по умолчанию'), gw);
      if (dev.l3) rows.push(lbl('IP-маршрутизация'), UI.toggle('ip routing', dev.ipRouting, (on) => DW.iosApply(app, app.net.getDevice(dev.id), [on ? 'ip routing' : 'no ip routing'], e)));
      const stp = DW.select(Array.from({ length: 16 }, (_, k) => [String(k * 4096), String(k * 4096) + (k === 8 ? ' (по умолчанию)' : '')]), String(dev.stpPriority),
        (v) => DW.iosApply(app, app.net.getDevice(dev.id), ['spanning-tree vlan 1 priority ' + v], e));
      rows.push(lbl('Приоритет STP'), stp);
    }
    rows.push(h('div', { class: 'full' }, e));
    box.appendChild(DW.form(...rows));
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } },
      'Как в настоящем IOS: изменения попадают в running-config и пропадут после перезагрузки, если не нажать «Сохранить» (copy running-config startup-config).'));
    return () => {
      const d = app.net.getDevice(dev.id);
      if (!d) return;
      const dirtyNow = d.nvramDirty();
      if (dirty.dataset.v !== String(dirtyNow)) {
        dirty.dataset.v = String(dirtyNow);
        UI.clear(dirty);
        dirty.appendChild(dirtyNow ? h('span', { class: 'st', style: { color: 'var(--warn)' } }, '● есть несохранённые изменения') : h('span', { class: 'st ok' }, '✓ сохранено'));
      }
    };
  }

  /* ================= маршрутизатор ================= */

  function routerIface(app, dev, f, box) {
    const e = err();
    const ifn = f.name;
    const run = (cmds) => DW.iosApply(app, app.net.getDevice(dev.id), [DW.ifCmd(ifn)].concat(cmds), e);
    box.appendChild(DW.section(f.name + (f.kind === 'sub' ? ' (подынтерфейс)' : f.kind === 'loop' ? ' (loopback)' : '')));
    const rows = [];
    if (f.kind === 'phys') rows.push(...portPhysRows(app, dev, f.port, ifn));
    else rows.push(lbl('Состояние'), UI.toggle(f.adminUp ? 'Включён' : 'Выключен', f.adminUp, (on) => run([on ? 'no shutdown' : 'shutdown'])));
    if (f.kind === 'sub') {
      const v = h('input', { class: 'inp', type: 'number', min: 1, max: 4094, value: f.vlan == null ? '' : f.vlan, style: { width: '120px' } });
      DW.commitOnChange(v, () => run(['encapsulation dot1Q ' + v.value]));
      rows.push(lbl('VLAN (802.1Q)'), v);
    }
    const ipI = DW.ipInput(ipT(f.ip), 'IP-адрес');
    const maskI = DW.ipInput(ipT(f.mask), 'маска');
    const applyIp = () => {
      const a = DW.readIp(ipI, false);
      if (!a.ok) { e.textContent = a.err; return; }
      if (a.v == null) { run(['no ip address']); return; }
      if (!maskI.value.trim()) maskI.value = DW.classfulMask(a.v);
      const m = DW.readMask(maskI);
      if (!m.ok) { e.textContent = m.err; return; }
      run(['ip address ' + U.ipStr(a.v) + ' ' + U.ipStr(m.v)]);
    };
    DW.commitOnChange(ipI, applyIp);
    DW.commitOnChange(maskI, applyIp);
    rows.push(lbl('IP-адрес'), ipI, lbl('Маска подсети'), maskI);
    if (f.kind === 'phys' && dev.ports[f.port].media === 'serial') {
      const p = dev.ports[f.port];
      const dce = dev.isDce(f.port);
      const cr = DW.select([['', 'не задана']].concat(NS.Router.CLOCK_RATES.map((r) => [String(r), String(r)])), p.clockRate ? String(p.clockRate) : '',
        (v) => run([v ? 'clock rate ' + v : 'no clock rate']));
      rows.push(lbl('Clock rate'), h('div', null, cr, h('div', { class: 'muted', style: { fontSize: '12px' } }, !p.link ? 'кабель не подключён' : dce ? 'этот конец кабеля — DCE: clock rate обязателен' : 'этот конец — DTE: clock rate задаётся на другой стороне')));
      rows.push(lbl('Инкапсуляция'), DW.select([['hdlc', 'HDLC'], ['ppp', 'PPP']], p.encap || 'hdlc', (v) => run(['encapsulation ' + v])));
    }
    if (f.kind !== 'loop') {
      const helper = DW.ipInput(ipT(f.helper), 'нет');
      DW.commitOnChange(helper, () => {
        const r = DW.readIp(helper, false);
        if (!r.ok) { e.textContent = r.err; return; }
        run([r.v == null ? 'no ip helper-address' : 'ip helper-address ' + U.ipStr(r.v)]);
      });
      rows.push(lbl('DHCP relay (helper)'), helper);
      rows.push(lbl('NAT'), DW.select([['', 'нет'], ['inside', 'inside (внутренний)'], ['outside', 'outside (внешний)']], f.nat || '',
        (v) => run([v ? 'ip nat ' + v : (f.nat ? 'no ip nat ' + f.nat : 'no ip nat inside')])));
      const acls = [['', 'нет']].concat([...dev.acls.keys()].map((k) => [k, k]));
      rows.push(lbl('ACL входящий'), DW.select(acls, f.aclIn || '', (v) => run([v ? 'ip access-group ' + v + ' in' : 'no ip access-group ' + (f.aclIn || '1') + ' in'])));
      rows.push(lbl('ACL исходящий'), DW.select(acls, f.aclOut || '', (v) => run([v ? 'ip access-group ' + v + ' out' : 'no ip access-group ' + (f.aclOut || '1') + ' out'])));
    }
    rows.push(h('div', { class: 'full' }, e));
    box.appendChild(DW.form(...rows));
    if (f.kind === 'sub' || f.kind === 'loop') {
      box.appendChild(h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn outline small danger', onClick: () => DW.iosApply(app, app.net.getDevice(dev.id), ['no interface ' + ifn], e) }, UI.icon('delete'), 'Удалить интерфейс')));
    }
    if (f.kind === 'phys' && dev.ports[f.port].media !== 'serial') {
      const num = h('input', { class: 'inp', type: 'number', min: 1, max: 4094, placeholder: 'VLAN', style: { width: '110px' } });
      box.appendChild(DW.section('Подынтерфейс для router-on-a-stick'));
      box.appendChild(h('div', { class: 'row' }, num, h('button', { class: 'btn outline small', onClick: () => {
        const v = parseInt(num.value, 10);
        if (!(v >= 1 && v <= 4094)) { e.textContent = 'VLAN: 1–4094'; return; }
        DW.iosApply(app, app.net.getDevice(dev.id), ['interface ' + ifn + '.' + v, 'encapsulation dot1Q ' + v], e);
      } }, 'Создать ' + UI.shortIf(ifn) + '.N')));
    }
  }

  function staticRoutes(app, dev, box) {
    const e = err();
    box.appendChild(DW.section('Статические маршруты'));
    const netI = DW.ipInput('', 'сеть');
    const maskI = DW.ipInput('255.255.255.0');
    const nhI = DW.ipInput('', 'следующий переход');
    const add = () => {
      const a = DW.readIp(netI, true);
      if (!a.ok) { e.textContent = 'Сеть: ' + a.err; return; }
      const m = DW.readMask(maskI);
      if (!m.ok) { e.textContent = m.err; return; }
      const n = DW.readIp(nhI, true);
      if (!n.ok) { e.textContent = 'Следующий переход: ' + n.err; return; }
      DW.iosApply(app, app.net.getDevice(dev.id), ['ip route ' + U.ipStr(a.v) + ' ' + U.ipStr(m.v) + ' ' + U.ipStr(n.v)], e);
    };
    for (const i of [netI, maskI, nhI]) DW.onEnter(i, add);
    box.appendChild(DW.form(lbl('Сеть'), netI, lbl('Маска'), maskI, lbl('Следующий переход'), nhI, h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: add }, 'Добавить'), e)));
    box.appendChild(h('table', { class: 'tbl', style: { marginTop: '10px' } },
      h('tr', null, h('th', null, 'Сеть'), h('th', null, 'Маска'), h('th', null, 'Через'), h('th', null, 'Состояние'), h('th')),
      dev.routes.length ? dev.routes.map((r) => h('tr', null, h('td', { class: 'mono' }, U.ipStr(r.net)), h('td', { class: 'mono' }, U.ipStr(r.mask)),
        h('td', { class: 'mono' }, (r.ifName || '') + (r.nextHop != null ? ' ' + U.ipStr(r.nextHop) : '') + (r.ad > 1 ? ' [AD ' + r.ad + ']' : '')),
        h('td', null, (r.ifName ? dev.ifaceUp(dev.ifaceByName(r.ifName)) : dev.resolveNextHop(r.nextHop, 0)) ? h('span', { class: 'st ok' }, 'активен') : h('span', { class: 'st fail' }, 'не активен')),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.iosApply(app, app.net.getDevice(dev.id), ['no ip route ' + U.ipStr(r.net) + ' ' + U.ipStr(r.mask) + (r.nextHop != null ? ' ' + U.ipStr(r.nextHop) : '')], e) }, UI.icon('delete'))))) :
        h('tr', { class: 'empty' }, h('td', { colspan: 5 }, 'Статических маршрутов нет'))));
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '8px' } }, 'Маршрут по умолчанию: сеть 0.0.0.0, маска 0.0.0.0.'));
    routingTableBox(app, dev, box);
  }

  function routingTableBox(app, dev, box) {
    box.appendChild(DW.section('Таблица маршрутизации'));
    const rows = dev.routingTable().filter((r) => r.type !== 'L');
    box.appendChild(h('table', { class: 'tbl' },
      h('tr', null, h('th', null, 'Тип'), h('th', null, 'Сеть'), h('th', null, 'Через'), h('th', null, 'Интерфейс'), h('th', null, 'AD/метрика')),
      rows.length ? rows.map((r) => h('tr', { class: r.active && !r.shadowed ? '' : 'dim' },
        h('td', null, { C: 'C подключена', S: 'S статический', O: 'O OSPF', R: 'R RIP' }[r.type] || r.type), h('td', { class: 'mono' }, U.cidr(r.net, r.mask)),
        h('td', { class: 'mono' }, r.nextHop != null ? U.ipStr(r.nextHop) : '—'), h('td', null, r.ifname || '—'), h('td', { class: 'mono' }, r.type === 'C' ? '0/0' : r.ad + '/' + (r.metric || 0))))
        : h('tr', { class: 'empty' }, h('td', { colspan: 5 }, 'Пусто: назначьте IP-адреса интерфейсам и подключите кабели.'))));
  }

  function ripSection(app, dev, box) {
    const e = err();
    box.appendChild(DW.section('RIP'));
    const netI = DW.ipInput('', 'сеть, например 192.168.1.0');
    const add = () => {
      const a = DW.readIp(netI, true);
      if (!a.ok) { e.textContent = a.err; return; }
      DW.iosApply(app, app.net.getDevice(dev.id), ['router rip', 'version 2', 'no auto-summary', 'network ' + U.ipStr(a.v)], e);
    };
    DW.onEnter(netI, add);
    box.appendChild(DW.form(lbl('Сеть'), h('div', { class: 'row' }, netI, h('button', { class: 'btn primary small', onClick: add }, 'Добавить')), h('div', { class: 'full' }, e)));
    box.appendChild(h('table', { class: 'tbl', style: { marginTop: '10px' } },
      h('tr', null, h('th', null, 'Объявляемые сети (классовые)'), h('th')),
      dev.rip.networks.length ? dev.rip.networks.map((n) => h('tr', null, h('td', { class: 'mono' }, U.ipStr(n)),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.iosApply(app, app.net.getDevice(dev.id), ['router rip', 'no network ' + U.ipStr(n)], e) }, UI.icon('delete'))))) :
        h('tr', { class: 'empty' }, h('td', { colspan: 2 }, 'RIP не настроен'))));
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '8px' } }, 'Из графического интерфейса RIP включается сразу в версии 2 без автосуммирования. passive-interface и default-information originate — в CLI (router rip).'));
  }

  function ospfSection(app, dev, box) {
    const e = err();
    box.appendChild(DW.section('OSPF'));
    const pid = h('input', { class: 'inp', type: 'number', min: 1, value: dev.ospf ? dev.ospf.pid : 1, style: { width: '100px' } });
    const netI = DW.ipInput('', 'сеть');
    const wcI = DW.ipInput('0.0.0.255');
    const areaI = h('input', { class: 'inp', type: 'number', min: 0, value: 0, style: { width: '100px' } });
    const add = () => {
      const a = DW.readIp(netI, true);
      if (!a.ok) { e.textContent = 'Сеть: ' + a.err; return; }
      const w = DW.readIp(wcI, true);
      if (!w.ok) { e.textContent = 'Wildcard: ' + w.err; return; }
      DW.iosApply(app, app.net.getDevice(dev.id), ['router ospf ' + pid.value, 'network ' + U.ipStr(a.v) + ' ' + U.ipStr(w.v) + ' area ' + areaI.value], e);
    };
    box.appendChild(DW.form(lbl('Номер процесса'), pid, lbl('Сеть'), netI, lbl('Wildcard-маска'), wcI, lbl('Область'), areaI,
      h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: add }, 'Добавить'), e)));
    if (dev.ospf) {
      box.appendChild(h('table', { class: 'tbl', style: { marginTop: '10px' } },
        h('tr', null, h('th', null, 'Сеть'), h('th', null, 'Wildcard'), h('th', null, 'Область'), h('th')),
        dev.ospf.networks.map((n) => h('tr', null, h('td', { class: 'mono' }, U.ipStr(n.net)), h('td', { class: 'mono' }, U.ipStr(n.wc)), h('td', null, String(n.area)),
          h('td', null, h('button', { class: 'btn icon small danger', onClick: () => DW.iosApply(app, app.net.getDevice(dev.id), ['router ospf ' + dev.ospf.pid, 'no network ' + U.ipStr(n.net) + ' ' + U.ipStr(n.wc) + ' area ' + n.area], e) }, UI.icon('delete')))))));
      app.net.ensureRouting();
      const nb = dev.ospfNeighbors || [];
      box.appendChild(DW.section('Соседи OSPF'));
      box.appendChild(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Router ID'), h('th', null, 'Состояние'), h('th', null, 'Адрес'), h('th', null, 'Интерфейс')),
        nb.length ? nb.map((n) => h('tr', null, h('td', { class: 'mono' }, U.ipStr(n.id)), h('td', null, n.state), h('td', { class: 'mono' }, U.ipStr(n.address)), h('td', null, n.ifname)))
          : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Соседей нет'))));
      box.appendChild(h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn outline small danger', onClick: () => DW.iosApply(app, app.net.getDevice(dev.id), ['no router ospf ' + dev.ospf.pid], e) }, 'Остановить OSPF')));
    }
  }

  function routerConfig(app, id, st) {
    return (body) => {
      const dev = app.net.getDevice(id);
      const items = [{ group: 'GLOBAL' }, { id: 'global', label: 'Настройки' }, { group: 'ROUTING' }, { id: 'static', label: 'Статические' }, { id: 'rip', label: 'RIP' }, { id: 'ospf', label: 'OSPF' },
        { group: 'СЛУЖБЫ' }, { id: 'dhcp', label: 'DHCP' }, { group: 'INTERFACE' }];
      for (const f of dev.ifaces) items.push({ id: 'if:' + f.name, label: UI.shortIf(f.name) === f.name ? f.name : f.name, title: f.name });
      items.push({ id: 'addif', label: '+ Loopback' });
      let live = null;
      DW.sidebarLayout(body, items, st, 'sec', (sec, box) => {
        const d = app.net.getDevice(id);
        live = null;
        if (sec === 'global') live = iosGlobal(app, d, box);
        else if (sec === 'static') staticRoutes(app, d, box);
        else if (sec === 'rip') ripSection(app, d, box);
        else if (sec === 'ospf') ospfSection(app, d, box);
        else if (sec === 'dhcp') live = DW.dhcpSection(app, id, box, true);
        else if (sec === 'addif') {
          const n = h('input', { class: 'inp', type: 'number', min: 0, value: d.ifaces.filter((f) => f.kind === 'loop').length, style: { width: '100px' } });
          const e = err();
          box.append(DW.section('Loopback-интерфейс'), h('div', { class: 'hint-box', style: { marginBottom: '8px' } }, 'Loopback всегда включён и не зависит от кабелей. Часто используется как Router ID в OSPF.'),
            h('div', { class: 'row' }, n, h('button', { class: 'btn primary small', onClick: () => { if (DW.iosApply(app, app.net.getDevice(id), ['interface loopback ' + n.value], e)) { st.sec = 'if:Loopback' + n.value; } } }, 'Создать'), e));
        } else if (sec.startsWith('if:')) {
          const f = d.ifaceByName(sec.slice(3));
          if (f) routerIface(app, d, f, box);
        }
      }, DW.iosLogPanel(app, dev));
      return () => { if (live) live(); };
    };
  }

  /* ================= коммутатор ================= */

  function switchPort(app, dev, i, box) {
    const p = dev.ports[i];
    const e = err();
    const run = (cmds) => DW.iosApply(app, app.net.getDevice(dev.id), [DW.ifCmd(p.name)].concat(cmds), e);
    box.appendChild(DW.section(p.name));
    const rows = portPhysRows(app, dev, i, p.name);
    if (p.routed) {
      const f = dev.ifaces.find((x) => x.kind === 'routed' && x.port === i);
      const ipI = DW.ipInput(ipT(f && f.ip), 'IP-адрес');
      const maskI = DW.ipInput(ipT(f && f.mask), 'маска');
      const applyIp = () => {
        const a = DW.readIp(ipI, false);
        if (!a.ok) { e.textContent = a.err; return; }
        if (a.v == null) { run(['no ip address']); return; }
        if (!maskI.value.trim()) maskI.value = DW.classfulMask(a.v);
        const m = DW.readMask(maskI);
        if (!m.ok) { e.textContent = m.err; return; }
        run(['ip address ' + U.ipStr(a.v) + ' ' + U.ipStr(m.v)]);
      };
      DW.commitOnChange(ipI, applyIp);
      DW.commitOnChange(maskI, applyIp);
      rows.push(lbl('Режим'), h('div', null, h('b', null, 'маршрутизируемый порт (no switchport)'), ' ', h('button', { class: 'btn small outline', onClick: () => run(['switchport']) }, 'Вернуть в коммутацию')));
      rows.push(lbl('IP-адрес'), ipI, lbl('Маска'), maskI);
    } else {
      rows.push(lbl('Режим'), DW.radio('pm-' + dev.id + '-' + i, [['access', 'Access'], ['trunk', 'Trunk']], p.mode, (v) => run(['switchport mode ' + v])));
      const vl = [...dev.vlans.entries()].sort((a, b) => a[0] - b[0]);
      if (p.mode === 'access') {
        rows.push(lbl('VLAN'), DW.select(vl.map(([v, n]) => [String(v), v + ' — ' + n]).concat(dev.vlans.has(p.vlan) ? [] : [[String(p.vlan), p.vlan + ' — (не создан!)']]), String(p.vlan), (v) => run(['switchport access vlan ' + v])));
      } else {
        rows.push(lbl('Native VLAN'), DW.select(vl.map(([v, n]) => [String(v), v + ' — ' + n]), String(p.nativeVlan), (v) => run(['switchport trunk native vlan ' + v])));
        const box2 = h('div', { class: 'vlan-checks' });
        const allCb = h('input', { type: 'checkbox', checked: p.allowed === 'all' });
        allCb.addEventListener('change', () => run([allCb.checked ? 'switchport trunk allowed vlan all' : 'switchport trunk allowed vlan ' + vl.map((x) => x[0]).join(',')]));
        box2.appendChild(h('label', null, allCb, ' все'));
        for (const [v] of vl) {
          const cb = h('input', { type: 'checkbox', checked: U.vlanInList(p.allowed, v), disabled: p.allowed === 'all' });
          cb.addEventListener('change', () => run(['switchport trunk allowed vlan ' + (cb.checked ? 'add ' : 'remove ') + v]));
          box2.appendChild(h('label', null, cb, ' ' + v));
        }
        rows.push(lbl('Разрешённые VLAN'), box2);
      }
      if (p.mode === 'access') {
        const ps = p.ps;
        rows.push(lbl('Port-security'), h('div', { class: 'row' },
          UI.toggle('вкл', ps.enabled, (on) => run([on ? 'switchport port-security' : 'no switchport port-security'])),
          h('span', { class: 'muted' }, 'макс.'), (() => { const m = h('input', { class: 'inp', type: 'number', min: 1, max: 132, value: ps.max, style: { width: '70px' } }); DW.commitOnChange(m, () => run(['switchport port-security maximum ' + m.value])); return m; })(),
          DW.select([['shutdown', 'shutdown'], ['restrict', 'restrict'], ['protect', 'protect']], ps.violation, (v) => run(['switchport port-security violation ' + v]), { style: { width: '120px' } }),
          UI.toggle('sticky', ps.sticky, (on) => run([on ? 'switchport port-security mac-address sticky' : 'no switchport port-security mac-address sticky']))));
        if (ps.enabled) rows.push(lbl('Безопасные MAC'), h('div', { class: 'mono', style: { fontSize: '12px' } }, ps.macs.length ? ps.macs.map((m) => m.mac + (m.sticky ? ' (sticky)' : '')).join(', ') : '—', ps.violations ? h('span', { style: { color: 'var(--warn)' } }, ' · нарушений: ' + ps.violations) : null));
      }
      if (dev.l3) rows.push(lbl('3-й уровень'), h('button', { class: 'btn small outline', onClick: () => run(['no switchport']) }, 'Сделать маршрутизируемым (no switchport)'));
      rows.push(lbl('STP'), h('div', { class: 'muted' }, p.stpRole ? ({ root: 'корневой порт', designated: 'назначенный', alternate: 'альтернативный — заблокирован' }[p.stpRole]) : 'нет (порт не активен)'));
    }
    rows.push(h('div', { class: 'full' }, e));
    box.appendChild(DW.form(...rows));
  }

  function switchSvi(app, dev, f, box) {
    const e = err();
    const run = (cmds) => DW.iosApply(app, app.net.getDevice(dev.id), ['interface vlan ' + f.vlan].concat(cmds), e);
    box.appendChild(DW.section(f.name + ' (SVI)'));
    const ipI = DW.ipInput(ipT(f.ip), 'IP-адрес');
    const maskI = DW.ipInput(ipT(f.mask), 'маска');
    const applyIp = () => {
      const a = DW.readIp(ipI, false);
      if (!a.ok) { e.textContent = a.err; return; }
      if (a.v == null) { run(['no ip address']); return; }
      if (!maskI.value.trim()) maskI.value = DW.classfulMask(a.v);
      const m = DW.readMask(maskI);
      if (!m.ok) { e.textContent = m.err; return; }
      run(['ip address ' + U.ipStr(a.v) + ' ' + U.ipStr(m.v)]);
    };
    DW.commitOnChange(ipI, applyIp);
    DW.commitOnChange(maskI, applyIp);
    box.appendChild(DW.form(
      lbl('Состояние'), h('div', null, UI.toggle(f.adminUp ? 'Включён' : 'Выключен (shutdown)', f.adminUp, (on) => run([on ? 'no shutdown' : 'shutdown'])), ' ', DW.stateDot(dev.ifaceUp(f) ? 'up' : 'down'), dev.ifaceUp(f) ? 'up' : 'down'),
      lbl('IP-адрес'), ipI, lbl('Маска подсети'), maskI, h('div', { class: 'full' }, e)));
    if (!f.adminUp) box.appendChild(h('div', { class: 'hint-box warn', style: { marginTop: '8px' } }, 'Интерфейс ' + f.name + ' выключен — как и в настоящем IOS, SVI нужно включить (no shutdown), иначе коммутатор не будет отвечать на ping и Telnet.'));
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '8px' } }, 'SVI — IP-адрес самого коммутатора в VLAN ' + f.vlan + ': для управления (ping, Telnet, SSH)' + (dev.l3 ? ' и для маршрутизации между VLAN (ip routing).' : '. Не забудьте шлюз по умолчанию в «Настройках».')));
    if (f.vlan !== 1) box.appendChild(h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn outline small danger', onClick: () => DW.iosApply(app, app.net.getDevice(dev.id), ['no interface vlan ' + f.vlan], e) }, 'Удалить SVI')));
  }

  function vlanDb(app, dev, box) {
    const e = err();
    box.appendChild(DW.section('База VLAN'));
    const num = h('input', { class: 'inp', type: 'number', min: 2, max: 4094, placeholder: 'номер', style: { width: '110px' } });
    const name = h('input', { class: 'inp', placeholder: 'имя (необязательно)' });
    const add = () => {
      const v = parseInt(num.value, 10);
      if (!(v >= 1 && v <= 4094)) { e.textContent = 'Номер VLAN: 1–4094'; return; }
      DW.iosApply(app, app.net.getDevice(dev.id), ['vlan ' + v].concat(name.value.trim() ? ['name ' + name.value.trim()] : []), e);
    };
    DW.onEnter(name, add);
    DW.onEnter(num, add);
    box.appendChild(DW.form(lbl('Номер VLAN'), num, lbl('Имя VLAN'), name, h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: add }, 'Добавить'), e)));
    const list = [...dev.vlans.entries()].sort((a, b) => a[0] - b[0]);
    box.appendChild(h('table', { class: 'tbl', style: { marginTop: '10px' } },
      h('tr', null, h('th', null, 'VLAN'), h('th', null, 'Имя'), h('th', null, 'Access-порты'), h('th')),
      list.map(([v, n]) => h('tr', null, h('td', null, h('b', null, v)), h('td', null, n),
        h('td', { class: 'muted', style: { fontSize: '12px' } }, dev.ports.filter((p) => p.mode === 'access' && !p.routed && p.vlan === v && NS.Network.isData(p)).map((p) => UI.shortIf(p.name)).join(', ') || '—'),
        h('td', null, v === 1 ? null : h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.iosApply(app, app.net.getDevice(dev.id), ['no vlan ' + v], e) }, UI.icon('delete')))))));
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '8px' } }, 'VLAN должен существовать на каждом коммутаторе, через который идёт его трафик. Порты между коммутаторами переводите в trunk.'));
  }

  function allPorts(app, dev, box) {
    box.appendChild(DW.section('Все порты'));
    const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Порт'), h('th', null, 'Подключён к'), h('th', null, 'Режим'), h('th', null, 'VLAN'), h('th', null, 'STP')));
    dev.ports.forEach((p, i) => {
      if (!NS.Network.isData(p)) return;
      const st = p.link ? app.net.portVisualState(dev, i) : 'none';
      tbl.appendChild(h('tr', { class: p.link ? '' : 'dim' },
        h('td', { style: { whiteSpace: 'nowrap' } }, DW.stateDot(st), UI.shortIf(p.name)),
        h('td', null, DW.peerText(app.net, dev, i)),
        h('td', null, p.routed ? 'routed' : p.mode),
        h('td', null, p.routed ? '—' : p.mode === 'trunk' ? 'native ' + p.nativeVlan + (p.allowed !== 'all' ? ', ' + p.allowed : '') : String(p.vlan)),
        h('td', null, p.stpRole ? ({ root: 'Root', designated: 'Desg', alternate: 'Altn (BLK)' }[p.stpRole]) : '')));
    });
    box.appendChild(tbl);
  }

  function switchConfig(app, id, st) {
    return (body) => {
      const dev = app.net.getDevice(id);
      const items = [{ group: 'GLOBAL' }, { id: 'global', label: 'Настройки' }, { id: 'ports', label: 'Все порты' }, { group: 'SWITCHING' }, { id: 'vlan', label: 'База VLAN' }];
      if (dev.l3) items.push({ group: 'ROUTING' }, { id: 'static', label: 'Статические' }, { id: 'rip', label: 'RIP' }, { id: 'ospf', label: 'OSPF' });
      items.push({ group: 'INTERFACE' });
      dev.ports.forEach((p, i) => { if (NS.Network.isData(p)) items.push({ id: 'p:' + i, label: UI.shortIf(p.name), title: p.name }); });
      for (const f of dev.ifaces.filter((x) => x.kind === 'svi').sort((a, b) => a.vlan - b.vlan)) items.push({ id: 'svi:' + f.vlan, label: f.name });
      items.push({ id: 'addsvi', label: '+ SVI (Vlan)' });
      let live = null;
      DW.sidebarLayout(body, items, st, 'sec', (sec, box) => {
        const d = app.net.getDevice(id);
        live = null;
        if (sec === 'global') live = iosGlobal(app, d, box);
        else if (sec === 'ports') allPorts(app, d, box);
        else if (sec === 'vlan') vlanDb(app, d, box);
        else if (sec === 'static') staticRoutes(app, d, box);
        else if (sec === 'rip') ripSection(app, d, box);
        else if (sec === 'ospf') ospfSection(app, d, box);
        else if (sec === 'addsvi') {
          const n = h('input', { class: 'inp', type: 'number', min: 1, max: 4094, placeholder: 'VLAN', style: { width: '110px' } });
          const e = err();
          box.append(DW.section('Новый интерфейс VLAN'), h('div', { class: 'row' }, n, h('button', { class: 'btn primary small', onClick: () => {
            if (DW.iosApply(app, app.net.getDevice(id), ['interface vlan ' + n.value, 'no shutdown'], e)) st.sec = 'svi:' + n.value;
          } }, 'Создать'), e));
        } else if (sec.startsWith('p:')) switchPort(app, d, Number(sec.slice(2)), box);
        else if (sec.startsWith('svi:')) {
          const f = d.ifaces.find((x) => x.kind === 'svi' && x.vlan === Number(sec.slice(4)));
          if (f) switchSvi(app, d, f, box);
        }
      }, DW.iosLogPanel(app, dev));
      return () => { if (live) live(); };
    };
  }

  /* ================= концентратор, точка доступа, WRT300N ================= */

  function hubConfig(app, id, st) {
    return (body) => {
      const items = [{ group: 'GLOBAL' }, { id: 'global', label: 'Настройки' }];
      DW.sidebarLayout(body, items, st, 'sec', (sec, box) => {
        const d = app.net.getDevice(id);
        box.appendChild(DW.section('Глобальные настройки'));
        box.appendChild(DW.form(...displayName(app, d), lbl('Часы устройства'), h('div', { class: 'mono' }, d.clock())));
        box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Концентратор — устройство физического уровня: всё, что приходит в один порт, повторяется во все остальные. Все подключённые узлы видят чужой трафик (в режиме симуляции это хорошо видно).'));
      });
    };
  }

  function wifiApForm(app, dev, box, rerender) {
    const w = dev.wifi;
    const e = err();
    const ssid = h('input', { class: 'inp', value: w.ssid });
    const ch = DW.select(Array.from({ length: 11 }, (_, k) => [String(k + 1), String(k + 1)]), String(w.channel || 6));
    const sec = DW.select([['open', 'Отключена (открытая сеть)'], ['wpa2', 'WPA2-PSK']], w.security || 'open');
    const key = h('input', { class: 'inp', type: 'password', value: w.key || '', placeholder: 'от 8 до 63 символов' });
    const save = () => DW.apply(app, () => app.net.getDevice(dev.id).setWifi({ ssid: ssid.value, channel: Number(ch.value), security: sec.value, key: key.value }), e, true);
    box.appendChild(DW.form(
      lbl('Радио'), UI.toggle(w.enabled !== false ? 'Включено' : 'Выключено', w.enabled !== false, (on) => DW.apply(app, () => app.net.getDevice(dev.id).setWifi({ enabled: on }), e)),
      lbl('SSID'), ssid, lbl('Канал 2,4 ГГц'), ch, lbl('Аутентификация'), sec, lbl('Пароль (PSK)'), key,
      h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: save }, 'Сохранить'), e)));
    const cl = dev.wirelessClients();
    box.appendChild(DW.section('Подключённые клиенты'));
    box.appendChild(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Устройство'), h('th', null, 'IP'), h('th', null, 'MAC')),
      cl.length ? cl.map((c) => h('tr', null, h('td', null, c.name), h('td', { class: 'mono' }, c.iface && c.iface.ip != null ? U.ipStr(c.iface.ip) : '—'), h('td', { class: 'mono' }, c.iface ? c.ifaceMac(c.iface) : '')))
        : h('tr', { class: 'empty' }, h('td', { colspan: 3 }, 'Нет клиентов. На ноутбуке поставьте модуль WPC300N и укажите SSID/пароль.'))));
  }

  function apConfig(app, id, st) {
    return (body) => {
      const items = [{ group: 'GLOBAL' }, { id: 'global', label: 'Настройки' }, { group: 'INTERFACE' }, { id: 'p0', label: 'Port 0' }, { id: 'p1', label: 'Port 1 (Wi-Fi)' }];
      DW.sidebarLayout(body, items, st, 'sec', (sec, box) => {
        const d = app.net.getDevice(id);
        if (sec === 'global') {
          box.appendChild(DW.section('Глобальные настройки'));
          box.appendChild(DW.form(...displayName(app, d)));
          box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Точка доступа соединяет беспроводных клиентов с проводной сетью, подключённой к Port 0, — как мост 2-го уровня.'));
        } else if (sec === 'p0') {
          box.appendChild(DW.section('Port 0'));
          box.appendChild(DW.form(...portPhysRows(app, d, 0, null)));
        } else {
          box.appendChild(DW.section('Port 1 — беспроводной'));
          wifiApForm(app, d, box);
        }
      });
    };
  }

  function wrouterConfig(app, id, st) {
    return (body) => {
      const items = [{ group: 'GLOBAL' }, { id: 'global', label: 'Настройки' }, { id: 'status', label: 'Состояние' }, { group: 'НАСТРОЙКА' }, { id: 'inet', label: 'Интернет (WAN)' }, { id: 'lan', label: 'Локальная сеть' }, { id: 'wifi', label: 'Wi-Fi' }];
      let live = null;
      DW.sidebarLayout(body, items, st, 'sec', (sec, box) => {
        const d = app.net.getDevice(id);
        live = null;
        const e = err();
        if (sec === 'global') {
          box.appendChild(DW.section('Глобальные настройки'));
          box.appendChild(DW.form(...displayName(app, d)));
          box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Домашний маршрутизатор: порт Internet подключается к провайдеру, Ethernet 1–4 и Wi-Fi — локальная сеть 192.168.0.0/24 с DHCP и NAT. Настройки сохраняются сразу (без NVRAM).'));
        } else if (sec === 'status') {
          const w = d.wanIface;
          const lan = d.lanIface;
          const stBox = h('div');
          box.append(DW.section('Состояние'), stBox);
          live = () => {
            const x = app.net.getDevice(id);
            UI.clear(stBox);
            stBox.appendChild(DW.form(
              lbl('WAN (Internet)'), h('div', { class: 'mono' }, w.ip != null ? U.cidr(w.ip, w.mask) : (x.wanMode === 'dhcp' ? (x.dhcpStatus || 'ожидание DHCP…') : '—')),
              lbl('Шлюз провайдера'), h('div', { class: 'mono' }, x.lookup(0x08080808) ? (x.lookup(0x08080808).nextHop != null ? U.ipStr(x.lookup(0x08080808).nextHop) : '—') : '—'),
              lbl('DNS провайдера'), h('div', { class: 'mono' }, ipT(x.wanDns) || '—'),
              lbl('LAN'), h('div', { class: 'mono' }, U.cidr(lan.ip, lan.mask)),
              lbl('Wi-Fi'), h('div', null, '«' + x.wifi.ssid + '», клиентов: ' + x.wirelessClients().length)));
            stBox.appendChild(DW.section('Выданные адреса (DHCP)'));
            const ls = x.dhcpd.leaseList();
            stBox.appendChild(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'IP'), h('th', null, 'Клиент')),
              ls.length ? ls.map((l) => h('tr', null, h('td', { class: 'mono' }, U.ipStr(l.ip)), h('td', null, app.nameForMac(l.mac)))) : h('tr', { class: 'empty' }, h('td', { colspan: 2 }, 'Пока никому'))));
          };
          live();
        } else if (sec === 'inet') {
          const w = d.wanIface;
          const ipI = DW.ipInput(d.wanMode === 'static' ? ipT(w.ip) : '', 'IP-адрес');
          const maskI = DW.ipInput(d.wanMode === 'static' ? ipT(w.mask) : '255.255.255.0');
          const gwI = DW.ipInput(d.wanMode === 'static' && d.routes[0] ? ipT(d.routes[0].nextHop) : '', 'шлюз провайдера');
          const dnsI = DW.ipInput(d.wanMode === 'static' ? ipT(d.wanDns) : '', 'DNS провайдера');
          const staticBox = h('div', { style: { display: d.wanMode === 'static' ? '' : 'none' } }, DW.form(lbl('IP-адрес'), ipI, lbl('Маска'), maskI, lbl('Шлюз'), gwI, lbl('DNS'), dnsI,
            h('span'), h('button', { class: 'btn primary small', onClick: () => {
              const a = DW.readIp(ipI, true); if (!a.ok) { e.textContent = a.err; return; }
              const m = DW.readMask(maskI); if (!m.ok) { e.textContent = m.err; return; }
              const g = DW.readIp(gwI, false); if (!g.ok) { e.textContent = g.err; return; }
              const n = DW.readIp(dnsI, false); if (!n.ok) { e.textContent = n.err; return; }
              DW.apply(app, () => app.net.getDevice(id).setWan({ mode: 'static', ip: a.v, mask: m.v, gateway: g.v, dns: n.v }), e, true);
            } }, 'Сохранить')));
          box.append(DW.section('Подключение к интернету'),
            DW.form(lbl('Тип подключения'), DW.radio('wan-' + id, [['dhcp', 'Автоматически (DHCP)'], ['static', 'Статический IP']], d.wanMode, (v) => {
              if (v === 'dhcp') DW.apply(app, () => app.net.getDevice(id).setWan({ mode: 'dhcp' }), e, true);
              else staticBox.style.display = '';
            })), staticBox, e);
        } else if (sec === 'lan') {
          const lan = d.lanIface;
          const pool = d.dhcpd.pools[0];
          const ipI = DW.ipInput(ipT(lan.ip));
          const maskI = DW.ipInput(ipT(lan.mask));
          const startI = h('input', { class: 'inp', type: 'number', min: 1, max: 254, value: pool ? pool.start & 255 : 100, style: { width: '100px' } });
          const cntI = h('input', { class: 'inp', type: 'number', min: 1, max: 253, value: pool ? pool.end - pool.start + 1 : 50, style: { width: '100px' } });
          box.append(DW.section('Локальная сеть'), DW.form(lbl('IP-адрес роутера'), ipI, lbl('Маска'), maskI,
            h('span'), h('button', { class: 'btn primary small', onClick: () => {
              const a = DW.readIp(ipI, true); if (!a.ok) { e.textContent = a.err; return; }
              const m = DW.readMask(maskI); if (!m.ok) { e.textContent = m.err; return; }
              DW.apply(app, () => app.net.getDevice(id).setLan(a.v, m.v), e, true);
            } }, 'Сохранить'),
            lbl('DHCP-сервер'), UI.toggle(d.dhcpd.enabled ? 'Включён' : 'Выключен', d.dhcpd.enabled, (on) => DW.apply(app, () => app.net.getDevice(id).setDhcpServer({ enabled: on }), e)),
            lbl('Начальный адрес'), h('div', { class: 'row' }, h('span', { class: 'mono muted' }, U.ipStr(U.net(lan.ip, lan.mask)).replace(/\d+$/, '')), startI),
            lbl('Максимум клиентов'), cntI,
            h('span'), h('button', { class: 'btn primary small', onClick: () => {
              const base = U.net(lan.ip, lan.mask) & 0xFFFFFF00;
              DW.apply(app, () => app.net.getDevice(id).setDhcpServer({ start: (base + Number(startI.value)) >>> 0, count: Number(cntI.value) }), e, true);
            } }, 'Сохранить DHCP'), h('div', { class: 'full' }, e)));
        } else {
          box.appendChild(DW.section('Беспроводная сеть'));
          wifiApForm(app, d, box);
        }
      });
      return () => { if (live) live(); };
    };
  }

  /* ================= вкладка ================= */

  DW.configTab = function (app, id) {
    const st = {};
    const tab = {
      id: 'config',
      label: 'Настройка',
      flush: true,
      render(body) {
        const dev = app.net.getDevice(id);
        let builder;
        if (dev.type === 'router') builder = routerConfig(app, id, st);
        else if (dev.type === 'switch') builder = switchConfig(app, id, st);
        else if (dev.type === 'hub') builder = hubConfig(app, id, st);
        else if (dev.type === 'ap') builder = apConfig(app, id, st);
        else if (dev.type === 'wrouter') builder = wrouterConfig(app, id, st);
        else builder = hostConfig(app, id, st);
        tab.live = builder(body) || null;
      },
      live: null,
    };
    return tab;
  };
})(globalThis.NetLab = globalThis.NetLab || {});
