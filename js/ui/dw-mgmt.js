/* NetLab UI — службы Server-PT для управления сетью: FTP (пользователи с правами, файлы),
 * SYSLOG (журнал сообщений от маршрутизаторов и коммутаторов), NTP (время, аутентификация). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const DW = NS.dw;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });
  const hint = (t) => h('div', { class: 'hint-box', style: { marginTop: '10px' } }, t);
  const onOff = (app, dev, svc, e) => DW.radio(svc + '-' + dev.id, [['on', 'Вкл'], ['off', 'Выкл']], dev[svc].enabled ? 'on' : 'off', (v) => DW.apply(app, () => {
    const s = app.net.getDevice(dev.id)[svc];
    s.enabled = v === 'on';
    if (s.bind) s.bind();
  }, e));

  DW.ftpSection = function (app, dev, box) {
    const e = err();
    const s = dev.ftpd;
    if (!s) return null;
    const user = h('input', { class: 'inp', placeholder: 'имя', spellcheck: 'false' });
    const pass = h('input', { class: 'inp', placeholder: 'пароль' });
    const perms = { w: h('input', { type: 'checkbox', checked: true }), r: h('input', { type: 'checkbox', checked: true }), d: h('input', { type: 'checkbox', checked: true }), n: h('input', { type: 'checkbox', checked: true }), l: h('input', { type: 'checkbox', checked: true }) };
    const PERM = [['w', 'Write'], ['r', 'Read'], ['d', 'Delete'], ['n', 'Rename'], ['l', 'List']];
    const files = h('div');
    box.append(DW.section('FTP'), h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, 'Служба'), onOff(app, dev, 'ftpd', e)),
      DW.section('Пользователи'),
      h('div', { class: 'row' }, user, pass, ...PERM.map(([k, t]) => h('label', { class: 'row', style: { gap: '3px' } }, perms[k], t)),
        h('button', { class: 'btn primary small', onClick: () => DW.apply(app, () => app.net.getDevice(dev.id).ftpd.addUser(user.value, pass.value, PERM.filter(([k]) => perms[k].checked).map(([k]) => k).join('')), e) }, 'Добавить')), e,
      h('table', { class: 'tbl', style: { marginTop: '8px' } }, h('tr', null, h('th', null, 'Пользователь'), h('th', null, 'Пароль'), h('th', null, 'Права'), h('th')),
        s.users.length ? s.users.map((u) => h('tr', null, h('td', null, u.user), h('td', { class: 'mono' }, u.pass), h('td', { class: 'mono' }, u.perms),
          h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.apply(app, () => { const x = app.net.getDevice(dev.id).ftpd; x.users = x.users.filter((y) => y.user !== u.user); }) }, UI.icon('delete')))))
          : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Нет пользователей'))),
      DW.section('Файлы'), files,
      hint('Компьютер подключается командой ftp <адрес> (Command Prompt): dir, get, put, delete, rename, quit. Маршрутизатор и коммутатор: ip ftp username …, ip ftp password …, затем copy running-config ftp:. Пользователь по умолчанию — cisco / cisco.'));
    return () => {
      const x = app.net.getDevice(dev.id).ftpd;
      UI.clear(files);
      files.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Файл'), h('th', null, 'Размер'), h('th')),
        x.files.size ? [...x.files.entries()].map(([n, v]) => h('tr', null, h('td', { class: 'mono' }, n), h('td', null, String(v.length)),
          h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.apply(app, () => app.net.getDevice(dev.id).ftpd.files.delete(n)) }, UI.icon('delete')))))
          : h('tr', { class: 'empty' }, h('td', { colspan: 3 }, 'Файлов нет'))));
    };
  };

  DW.syslogSection = function (app, dev, box) {
    const e = err();
    if (!dev.syslogd) return null;
    const list = h('div');
    box.append(DW.section('SYSLOG'), h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, 'Служба'), onOff(app, dev, 'syslogd', e),
      h('button', { class: 'btn outline small', onClick: () => DW.apply(app, () => { app.net.getDevice(dev.id).syslogd.msgs = []; }) }, 'Очистить журнал'), e), list,
    hint('На маршрутизаторе или коммутаторе: logging host <адрес этого сервера>; logging trap <уровень> — какие сообщения отправлять (по умолчанию informational). service timestamps log datetime msec добавляет время. Время удобно взять с NTP-сервера.'));
    return () => {
      const x = app.net.getDevice(dev.id).syslogd;
      UI.clear(list);
      list.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, '№'), h('th', null, 'Время'), h('th', null, 'Узел'), h('th', null, 'Сообщение')),
        x.msgs.length ? x.msgs.slice(-150).map((m, i) => h('tr', null, h('td', null, String(i + 1)), h('td', { class: 'mono small' }, m.time.replace(/ UTC.*$/, '')), h('td', { class: 'mono' }, m.host), h('td', { class: 'mono small' }, m.text)))
          : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Сообщений пока нет'))));
    };
  };

  DW.ntpSection = function (app, dev, box) {
    const e = err();
    const s = dev.ntpd;
    if (!s) return null;
    const keyId = h('input', { class: 'inp', type: 'number', min: 1, max: 65535, value: s.keyId, style: { width: '100px' } });
    const key = h('input', { class: 'inp', value: s.key, placeholder: 'пароль ключа' });
    const clock = h('div', { class: 'mono' });
    box.append(DW.section('NTP'), h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, 'Служба'), onOff(app, dev, 'ntpd', e)),
      DW.form(lbl('Время сервера'), clock,
        lbl('Аутентификация'), UI.toggle(s.auth ? 'Включена' : 'Выключена', s.auth, (on) => DW.apply(app, () => { app.net.getDevice(dev.id).ntpd.auth = on; }, e)),
        lbl('Номер ключа'), keyId, lbl('Пароль (MD5)'), key,
        h('span'), h('button', { class: 'btn primary small', onClick: () => DW.apply(app, () => { const x = app.net.getDevice(dev.id).ntpd; x.keyId = Number(keyId.value) || 1; x.key = key.value; }, e, true) }, 'Сохранить'),
        h('div', { class: 'full' }, e)),
      hint('На маршрутизаторе: ntp server <адрес этого сервера>; show ntp status. С аутентификацией: ntp authentication-key <номер> md5 <пароль>, ntp trusted-key <номер>, ntp authenticate, ntp server <адрес> key <номер>.'));
    return () => { const x = app.net.getDevice(dev.id); if (x) clock.textContent = x.clock(); };
  };
})(globalThis.NetLab = globalThis.NetLab || {});
