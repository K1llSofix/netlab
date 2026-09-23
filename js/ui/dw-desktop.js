/* NetLab UI — вкладка «Рабочий стол» (Desktop) как в Packet Tracer: сетка программ, каждая открывается
 * внутри вкладки. Состояние программ (адрес в браузере, черновик письма, журнал генератора)
 * хранится в app.deskState(id) и переживает перерисовку окна. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const s = UI.s;
  const DW = NS.dw;
  const ipT = DW.ipText;

  const lbl = (t) => h('label', null, t);
  const err = () => h('div', { class: 'err-text' });

  /* ---------- значки программ ---------- */

  function glyph(kind) {
    const g = [];
    const W = '#fff';
    switch (kind) {
      case 'ipconfig':
        g.push(s('rect', { x: 8, y: 10, width: 32, height: 22, rx: 2, fill: 'none', stroke: W, 'stroke-width': 2.5 }), s('text', { x: 24, y: 26, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: W, 'font-family': 'Segoe UI, sans-serif' }, 'IP'), s('path', { d: 'M18 38h12M24 32v6', stroke: W, 'stroke-width': 2.5 }));
        break;
      case 'cmd':
        g.push(s('rect', { x: 6, y: 9, width: 36, height: 30, rx: 2, fill: '#111', stroke: W, 'stroke-width': 1.5 }), s('text', { x: 10, y: 28, 'font-size': 11, fill: W, 'font-family': 'Consolas, monospace' }, 'C:\\>'));
        break;
      case 'terminal':
        g.push(s('rect', { x: 6, y: 9, width: 36, height: 26, rx: 2, fill: 'none', stroke: W, 'stroke-width': 2.5 }), s('path', { d: 'M12 17l6 5-6 5M21 28h10', stroke: W, 'stroke-width': 2.5, fill: 'none' }), s('path', { d: 'M24 35v5', stroke: W, 'stroke-width': 2.5 }));
        break;
      case 'browser':
        g.push(s('circle', { cx: 24, cy: 24, r: 15, fill: 'none', stroke: W, 'stroke-width': 2.5 }), s('ellipse', { cx: 24, cy: 24, rx: 6.5, ry: 15, fill: 'none', stroke: W, 'stroke-width': 2 }), s('path', { d: 'M9 24h30M12 16h24M12 32h24', stroke: W, 'stroke-width': 2 }));
        break;
      case 'wireless':
        g.push(s('path', { d: 'M8 20a23 23 0 0 1 32 0M13 26a15 15 0 0 1 22 0M18 32a8 8 0 0 1 12 0', stroke: W, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }), s('circle', { cx: 24, cy: 37, r: 2.8, fill: W }));
        break;
      case 'traffic':
        g.push(s('path', { d: 'M8 18h26l-6-6M40 30H14l6 6', stroke: W, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        break;
      case 'email':
        g.push(s('rect', { x: 7, y: 12, width: 34, height: 24, rx: 2, fill: 'none', stroke: W, 'stroke-width': 2.5 }), s('path', { d: 'M8 13l16 13 16-13', stroke: W, 'stroke-width': 2.5, fill: 'none' }));
        break;
      case 'messages':
        g.push(s('path', { d: 'M8 11h32v20H22l-8 7v-7H8z', fill: 'none', stroke: W, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }), s('path', { d: 'M14 18h20M14 24h14', stroke: W, 'stroke-width': 2.2 }));
        break;
      case 'editor':
        g.push(s('path', { d: 'M12 7h17l8 8v26H12z', fill: 'none', stroke: W, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }), s('path', { d: 'M17 20h15M17 26h15M17 32h10', stroke: W, 'stroke-width': 2.2 }));
        break;
      case 'firewall':
        g.push(s('path', { d: 'M7 12h34v26H7zM7 20.5h34M7 29h34M17 12v8.5M31 12v8.5M24 20.5V29M12 29v9M36 29v9', fill: 'none', stroke: W, 'stroke-width': 2.2 }));
        break;
      case 'telnet':
        g.push(s('rect', { x: 5, y: 12, width: 18, height: 14, rx: 1.5, fill: 'none', stroke: W, 'stroke-width': 2.2 }), s('rect', { x: 25, y: 22, width: 18, height: 14, rx: 1.5, fill: 'none', stroke: W, 'stroke-width': 2.2 }), s('path', { d: 'M14 30v6h8M34 18v-6h-8', stroke: W, 'stroke-width': 2.2, fill: 'none' }));
        break;
      default:
        if (DW.appGlyphs && DW.appGlyphs[kind]) g.push(...DW.appGlyphs[kind](s, W));
        break;
    }
    return s('svg', { viewBox: '0 0 48 48', width: 44, height: 44 }, g);
  }

  /* ================= IP Configuration ================= */

  function ipconfigApp(app, id, box) {
    const dev = app.net.getDevice(id);
    const f = dev.iface;
    if (f.port < 0) { box.appendChild(h('div', { class: 'hint-box warn' }, 'Сетевая карта не установлена (вкладка «Физический вид»).')); return null; }
    const e = err();
    const ipI = DW.ipInput(ipT(f.ip));
    const maskI = DW.ipInput(ipT(f.mask));
    const gwI = DW.ipInput(ipT(dev.gateway));
    const dnsI = DW.ipInput(ipT(dev.dns));
    const status = h('div', { class: 'desk-status' });
    const fields = [ipI, maskI, gwI, dnsI];
    const setRo = (ro) => { for (const i of fields) i.readOnly = ro; };
    setRo(f.dhcp);
    const applyStatic = () => {
      const a = DW.readIp(ipI, false);
      if (!a.ok) { e.textContent = a.err; return; }
      let m = { ok: true, v: null };
      if (a.v != null) {
        if (!maskI.value.trim()) maskI.value = DW.classfulMask(a.v);
        m = DW.readMask(maskI);
        if (!m.ok) { e.textContent = m.err; return; }
      }
      const g = DW.readIp(gwI, false);
      if (!g.ok) { e.textContent = 'Шлюз: ' + g.err; return; }
      const d = DW.readIp(dnsI, false);
      if (!d.ok) { e.textContent = 'DNS: ' + d.err; return; }
      DW.apply(app, () => app.net.getDevice(id).setStatic(a.v, m.v, g.v, d.v), e);
    };
    for (const i of fields) DW.commitOnChange(i, () => { if (!i.readOnly) applyStatic(); });
    ipI.addEventListener('blur', () => { const v = U.parseIp(ipI.value); if (v != null && !maskI.value.trim()) maskI.value = DW.classfulMask(v); });
    box.append(
      h('div', { class: 'desk-subtitle' }, 'Интерфейс: ' + f.name),
      DW.section('IP-конфигурация'),
      DW.form(
        h('span'), DW.radio('ipcfg-' + id, [['dhcp', 'DHCP'], ['static', 'Статически']], f.dhcp ? 'dhcp' : 'static', (v) => {
          if (v === 'dhcp') { setRo(true); DW.apply(app, () => app.net.getDevice(id).setDhcp(), e); } else { setRo(false); ipI.focus(); }
        }),
        h('span'), status,
        lbl('IPv4-адрес'), ipI, lbl('Маска подсети'), maskI, lbl('Основной шлюз'), gwI, lbl('DNS-сервер'), dnsI,
        h('div', { class: 'full' }, e)),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn outline small', onClick: () => DW.apply(app, () => app.net.getDevice(id).setDhcp(), e) }, 'Обновить (ipconfig /renew)'),
        h('button', { class: 'btn outline small', onClick: () => DW.apply(app, () => app.net.getDevice(id).releaseDhcp(), e) }, 'Освободить (/release)')));
    const v6live = DW.hostIpv6Form ? DW.hostIpv6Form(app, dev, box) : null;
    return () => {
      const d = app.net.getDevice(id);
      if (!d) return;
      if (v6live) v6live();
      const x = d.iface;
      if (x.dhcp) {
        status.textContent = d.dhcpStatus || 'Запрос DHCP…';
        status.className = 'desk-status' + (x.ip != null && !(d.dhcpStatus || '').includes('APIPA') ? ' ok' : '');
        if (!fields.includes(document.activeElement)) { ipI.value = ipT(x.ip); maskI.value = ipT(x.mask); gwI.value = ipT(d.gateway); dnsI.value = ipT(d.dns); }
      } else status.textContent = '';
      if (d.conflict) { status.textContent = '⚠ Конфликт IP-адресов: ' + U.ipStr(d.conflict.ip) + ' уже использует ' + d.conflict.mac; status.className = 'desk-status warn'; }
    };
  }

  /* ================= терминалы ================= */

  function termApp(app, id, box, kind) {
    const t = app.terminal(id, kind);
    box.classList.add('flush');
    box.appendChild(t.el);
    t.renderPrompt();
    t.scroll();
    setTimeout(() => t.focus(), 0);
    return () => t.renderPrompt();
  }

  function terminalApp(app, id, box, st) {
    if (!st.termOk) {
      const sel = (opts, v) => DW.select(opts.map((o) => [String(o), String(o)]), v);
      const bps = sel([300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200], 9600);
      box.append(DW.section('Настройки терминала'), DW.form(
        lbl('Скорость (бит/с)'), bps, lbl('Биты данных'), sel([5, 6, 7, 8], 8), lbl('Чётность'), sel(['None', 'Odd', 'Even', 'Mark', 'Space'], 'None'),
        lbl('Стоповые биты'), sel([1, 1.5, 2], 1), lbl('Управление потоком'), sel(['None', 'RTS/CTS', 'Xon/Xoff'], 'None'),
        h('span'), h('button', { class: 'btn primary', style: { justifySelf: 'start', minWidth: '90px' }, onClick: () => {
          st.termOk = true;
          st.termBps = Number(bps.value);
          st.win.select('desktop');
        } }, 'OK')));
      box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Консоль Cisco по умолчанию: 9600 бит/с, 8 бит данных, без чётности, 1 стоповый бит, без управления потоком. Нужен консольный кабель от RS 232 компьютера к порту Console.'));
      return null;
    }
    if (st.termBps !== 9600) {
      box.appendChild(h('div', { class: 'hint-box warn', style: { margin: '8px' } }, 'Скорость ' + st.termBps + ' бит/с не совпадает со скоростью консоли (9600) — на настоящем оборудовании вместо текста были бы «кракозябры». ',
        h('button', { class: 'btn small outline', onClick: () => { st.termOk = false; st.win.select('desktop'); } }, 'Изменить настройки')));
    }
    return termApp(app, id, box, 'console');
  }

  /* ================= Web Browser ================= */

  const HTML_OK = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'B', 'I', 'U', 'EM', 'STRONG', 'BR', 'HR', 'UL', 'OL', 'LI', 'A', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DIV', 'SPAN', 'CENTER', 'SMALL', 'BIG', 'FONT', 'BLOCKQUOTE', 'DL', 'DT', 'DD', 'SUB', 'SUP']);
  const HTML_DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'LINK', 'META', 'TITLE', 'SVG', 'MATH', 'IMG', 'VIDEO', 'AUDIO']);

  /** Безопасный показ HTML: только разметка текста, никаких скриптов, стилей и внешних ресурсов. */
  function renderHtml(html, onLink) {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    const root = h('div', { class: 'web-page' });
    const walk = (node, into) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { into.appendChild(document.createTextNode(c.textContent)); continue; }
        if (c.nodeType !== 1) continue;
        const tag = c.tagName.toUpperCase();
        if (HTML_DROP.has(tag)) continue;
        if (!HTML_OK.has(tag)) { walk(c, into); continue; }
        const el = document.createElement(tag === 'CENTER' || tag === 'FONT' ? (tag === 'CENTER' ? 'div' : 'span') : tag.toLowerCase());
        if (tag === 'CENTER') el.style.textAlign = 'center';
        if (tag === 'FONT') {
          const col = c.getAttribute('color');
          if (col && /^#?[a-z0-9]{3,20}$/i.test(col)) el.style.color = col;
        }
        if (tag === 'A') {
          const href = c.getAttribute('href');
          if (href) {
            el.setAttribute('href', '#');
            el.title = href;
            el.addEventListener('click', (ev) => { ev.preventDefault(); onLink(href); });
          }
        }
        walk(c, el);
        into.appendChild(el);
      }
    };
    walk(doc.body, root);
    return { el: root, title: doc.title || '' };
  }

  function resolveUrl(base, href) {
    const t = String(href).trim();
    if (/^https?:\/\//i.test(t)) return t;
    if (/^[a-z]+:/i.test(t)) return null;
    const b = NS.IpNode.parseUrl(base);
    if (!b) return t;
    return 'http://' + b.host + (b.port ? ':' + b.port : '') + '/' + t.replace(/^\/+/, '');
  }

  function browserApp(app, id, box, st) {
    const b = (st.browser = st.browser || { url: 'http://', history: [], idx: -1, page: null, loading: false, job: null });
    const urlI = h('input', { class: 'inp mono', value: b.url, spellcheck: 'false' });
    const view = h('div', { class: 'web-view' });
    const back = h('button', { class: 'btn icon small', title: 'Назад' }, '◀');
    const fwd = h('button', { class: 'btn icon small', title: 'Вперёд' }, '▶');
    const go = (url, push) => {
      const dev = app.net.getDevice(id);
      if (!dev) return;
      if (!/^https?:\/\//i.test(url) && !/^[a-z]+:/i.test(url)) url = 'http://' + url;
      b.url = url;
      urlI.value = url;
      if (b.job && b.job.cancel) b.job.cancel();
      b.loading = true;
      b.page = null;
      if (push !== false) { b.history = b.history.slice(0, b.idx + 1); b.history.push(url); b.idx = b.history.length - 1; }
      draw();
      const job = dev.httpGet(url, (r) => {
        if (b.job !== job && job) return;
        b.job = null;
        b.loading = false;
        b.page = r;
        if (r.url) { b.url = r.url; if (b.history[b.idx]) b.history[b.idx] = r.url; }
        if (b.onUpdate) b.onUpdate();
      });
      b.job = job;
    };
    const draw = () => {
      back.disabled = b.idx <= 0;
      fwd.disabled = b.idx >= b.history.length - 1;
      if (document.activeElement !== urlI) urlI.value = b.url;
      UI.clear(view);
      if (b.loading) {
        view.appendChild(h('div', { class: 'web-msg' }, 'Загрузка ' + b.url + '…', app.mode === 'sim' ? h('div', { class: 'muted' }, 'Режим симуляции: нажмите «Пуск» или «Шаг», чтобы пакеты пошли по сети.') : null));
        return;
      }
      const p = b.page;
      if (!p) { view.appendChild(h('div', { class: 'web-msg muted' }, 'Введите адрес веб-сервера: http://192.168.1.10 или его DNS-имя.')); return; }
      if (!p.ok) { view.appendChild(h('div', { class: 'web-msg' }, h('b', null, 'Request Timeout'), h('div', null, p.error))); return; }
      const r = renderHtml(p.body, (href) => { const u = resolveUrl(b.url, href); if (u) go(u); else UI.toast('Ссылка «' + href + '» не поддерживается', 'warn'); });
      if (p.status !== 200) view.appendChild(h('div', { class: 'web-code' }, 'HTTP ' + p.status + ' ' + (p.reason || '')));
      view.appendChild(r.el);
    };
    back.addEventListener('click', () => { if (b.idx > 0) { b.idx--; go(b.history[b.idx], false); } });
    fwd.addEventListener('click', () => { if (b.idx < b.history.length - 1) { b.idx++; go(b.history[b.idx], false); } });
    DW.onEnter(urlI, () => go(urlI.value.trim()));
    box.classList.add('flush');
    box.append(h('div', { class: 'web-bar' }, back, fwd, h('span', { class: 'muted' }, 'URL'), urlI,
      h('button', { class: 'btn small primary', onClick: () => go(urlI.value.trim()) }, 'Go'),
      h('button', { class: 'btn small outline', onClick: () => { if (b.job && b.job.cancel) b.job.cancel('Остановлено'); b.loading = false; b.job = null; draw(); } }, 'Stop')), view);
    b.onUpdate = () => { if (view.isConnected) draw(); };
    draw();
    if (b.url === 'http://' || !b.url) setTimeout(() => { urlI.focus(); urlI.setSelectionRange(urlI.value.length, urlI.value.length); }, 0);
    return null;
  }

  /* ================= PC Wireless ================= */

  function wirelessApp(app, id, box, st) {
    const dev = app.net.getDevice(id);
    if (!dev.ports.some((p) => p.media === 'wireless')) {
      box.appendChild(h('div', { class: 'hint-box warn' }, 'Беспроводного адаптера нет. Выключите устройство и на вкладке «Физический вид» замените сетевую карту модулем ' + (dev.type === 'laptop' ? 'WPC300N' : 'WMP300N') + '.'));
      return null;
    }
    const sub = st.wifiTab || 'link';
    const tabs = h('div', { class: 'seg' }, [['link', 'Состояние'], ['connect', 'Подключение']].map(([k, t]) => h('button', { class: k === sub ? 'on' : '', onClick: () => { st.wifiTab = k; st.win.select('desktop'); } }, t)));
    box.appendChild(tabs);
    const content = h('div', { style: { marginTop: '10px' } });
    box.appendChild(content);
    if (sub === 'link') {
      const upd = () => {
        const d = app.net.getDevice(id);
        if (!d) return;
        const r = app.net.wirelessStatus(d);
        UI.clear(content);
        const ap = r && r.ap;
        const near = ap ? app.net.scanWifi(d).find((x) => x.ap === ap) : null;
        content.appendChild(h('div', { class: 'wifi-link' },
          h('div', { class: 'wifi-bars' }, [1, 2, 3, 4, 5].map((k) => h('span', { class: near && near.signal >= k * 20 - 10 ? 'on' : '', style: { height: (k * 6 + 4) + 'px' } }))),
          h('div', null, h('div', { class: 'big' }, ap ? 'Подключено' : 'Нет подключения'), h('div', { class: 'muted' }, ap ? 'Сила сигнала: ' + (near ? near.signal : 0) + '%' : r ? r.reason : ''))));
        content.appendChild(DW.form(
          lbl('SSID'), h('div', null, ap ? ap.wifi.ssid : d.wifi.ssid || '—'),
          lbl('Точка доступа'), h('div', null, ap ? ap.name : '—'),
          lbl('Канал'), h('div', null, ap ? String(ap.wifi.channel || 6) : '—'),
          lbl('Защита'), h('div', null, ap ? (ap.wifi.security === 'wpa2' ? 'WPA2-PSK' : 'Нет') : '—'),
          lbl('IP-адрес'), h('div', { class: 'mono' }, ipT(d.iface.ip) || '—'),
          lbl('MAC-адрес'), h('div', { class: 'mono' }, d.ifaceMac(d.iface))));
      };
      upd();
      return upd;
    }
    const list = app.net.scanWifi(dev);
    const e = err();
    const keyI = h('input', { class: 'inp', type: 'password', placeholder: 'пароль сети' });
    let chosen = list.find((x) => x.ssid === dev.wifi.ssid) || list[0] || null;
    const tbl = h('table', { class: 'tbl clickable' }, h('tr', null, h('th', null, 'Сеть (SSID)'), h('th', null, 'Канал'), h('th', null, 'Защита'), h('th', null, 'Сигнал')));
    const rows = [];
    for (const n of list) {
      const tr = h('tr', { class: n === chosen ? 'sel' : '' }, h('td', null, n.ssid), h('td', null, String(n.channel)), h('td', null, n.security === 'wpa2' ? 'WPA2-PSK' : 'Нет'), h('td', null, n.signal + '%'));
      tr.addEventListener('click', () => { chosen = n; for (const r of rows) r.classList.remove('sel'); tr.classList.add('sel'); keyRow.style.display = n.security === 'open' ? 'none' : ''; });
      rows.push(tr);
      tbl.appendChild(tr);
    }
    if (!list.length) tbl.appendChild(h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'Сетей не найдено. Поставьте точку доступа или WRT300N ближе (радиус действия виден пунктирным кругом при выделении точки).')));
    const keyRow = h('div', { class: 'row', style: { marginTop: '8px', display: chosen && chosen.security !== 'open' ? '' : 'none' } }, h('span', { class: 'muted' }, 'Ключ WPA2'), keyI);
    box.append(DW.section('Доступные сети'), tbl, keyRow,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn primary small', disabled: !chosen, onClick: () => {
          if (!chosen) return;
          if (DW.apply(app, () => app.net.getDevice(id).setWifi({ ssid: chosen.ssid, security: chosen.security, key: chosen.security === 'open' ? '' : keyI.value }), e)) {
            const r = app.net.wirelessStatus(app.net.getDevice(id));
            if (r && r.ap) UI.toast('Подключено к «' + chosen.ssid + '»', 'ok');
            else e.textContent = r ? r.reason : 'Не удалось подключиться';
          }
        } }, 'Подключить'),
        h('button', { class: 'btn outline small', onClick: () => st.win.select('desktop') }, 'Обновить'),
        h('button', { class: 'btn outline small', onClick: () => DW.apply(app, () => app.net.getDevice(id).setWifi({ ssid: '' })) }, 'Отключить'), e));
    return null;
  }

  /* ================= Email ================= */

  function emailApp(app, id, box, st) {
    const dev = app.net.getDevice(id);
    const m = (st.email = st.email || { view: 'inbox', sel: 0, draft: { to: '', subject: '', body: '' }, report: null, busy: null });
    const view = m.view;
    const nav = h('div', { class: 'row mail-bar' },
      h('button', { class: 'btn small' + (view === 'compose' ? ' primary' : ' outline'), onClick: () => { m.view = 'compose'; m.report = null; st.win.select('desktop'); } }, 'Написать'),
      h('button', { class: 'btn small outline', disabled: !dev.emailBox.length, onClick: () => {
        const cur = dev.emailBox[m.sel];
        if (!cur) return;
        m.draft = { to: cur.from, subject: /^re:/i.test(cur.subject) ? cur.subject : 'Re: ' + cur.subject, body: '\n\n----- ' + (cur.fromName || cur.from) + ' писал(а): -----\n' + cur.body };
        m.view = 'compose';
        m.report = null;
        st.win.select('desktop');
      } }, 'Ответить'),
      h('button', { class: 'btn small outline', onClick: () => receive() }, m.busy === 'recv' ? 'Получение…' : 'Получить'),
      h('button', { class: 'btn small outline', disabled: !dev.emailBox.length, onClick: () => DW.apply(app, () => { const d = app.net.getDevice(id); d.emailBox.splice(m.sel, 1); m.sel = Math.max(0, Math.min(m.sel, d.emailBox.length - 1)); }) }, 'Удалить'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small' + (view === 'config' ? ' primary' : ' outline'), onClick: () => { m.view = view === 'config' ? 'inbox' : 'config'; st.win.select('desktop'); } }, 'Настроить почту'));
    box.appendChild(nav);
    const status = h('div', { class: 'desk-status' });
    const receive = () => {
      const d = app.net.getDevice(id);
      if (!d.power) { UI.toast('Устройство выключено', 'err'); return; }
      m.busy = 'recv';
      m.status = 'Получение почты с ' + (d.email.incoming || '?') + '…';
      if (status.isConnected) status.textContent = m.status;
      d.emailReceive((r) => {
        m.busy = null;
        m.status = r.ok ? (r.count ? 'Получено писем: ' + r.count : 'Новых писем нет') : '✕ ' + r.error;
        m.statusOk = r.ok;
        m.view = 'inbox';
        m.sel = 0;
        app.needRender = true;
        const w = UI.windows.get('dev:' + id);
        if (w && w.active && w.active.id === 'desktop') w.select('desktop');
      });
    };
    if (m.status) { status.textContent = m.status; status.classList.toggle('warn', !m.statusOk); }
    box.appendChild(status);

    if (view === 'config') {
      const e = err();
      const c = dev.email;
      const fld = (k, ph, type) => { const i = h('input', { class: 'inp' + (type ? '' : ' mono'), value: c[k] || '', placeholder: ph || '', type: type || 'text', spellcheck: 'false' }); i.dataset.k = k; return i; };
      const fields = [fld('name', 'Иван'), fld('address', 'ivan@mail.lab'), fld('incoming', 'IP или имя сервера'), fld('outgoing', 'IP или имя сервера'), fld('user', 'ivan'), fld('password', '', 'password')];
      const labels = ['Ваше имя', 'Адрес e-mail', 'Сервер входящей почты (POP3)', 'Сервер исходящей почты (SMTP)', 'Имя пользователя', 'Пароль'];
      const rows = [];
      fields.forEach((f, i) => rows.push(lbl(labels[i]), f));
      box.append(DW.section('Сведения о пользователе и серверах'), DW.form(...rows,
        h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: () => {
          const v = {};
          for (const f of fields) v[f.dataset.k] = f.value.trim();
          if (v.address && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.address) && !/^[^@\s]+@[^@\s]+$/.test(v.address)) { e.textContent = 'Адрес: например ivan@mail.lab'; return; }
          if (!v.user && v.address) v.user = v.address.split('@')[0];
          if (DW.apply(app, () => Object.assign(app.net.getDevice(id).email, v), e, 'Настройки почты сохранены')) { m.view = 'inbox'; st.win.select('desktop'); }
        } }, 'Сохранить'), e)));
      box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Пользователей и домен создайте на сервере: «Службы» → EMAIL.'));
      return null;
    }

    if (view === 'compose') {
      const e = err();
      const toI = h('input', { class: 'inp mono', value: m.draft.to, placeholder: 'user1@mail.lab, user2@mail.lab', spellcheck: 'false' });
      const subI = h('input', { class: 'inp', value: m.draft.subject });
      const bodyI = h('textarea', { class: 'inp', rows: 8 });
      bodyI.value = m.draft.body;
      toI.addEventListener('input', () => { m.draft.to = toI.value; });
      subI.addEventListener('input', () => { m.draft.subject = subI.value; });
      bodyI.addEventListener('input', () => { m.draft.body = bodyI.value; });
      const repBox = h('div');
      const drawReport = () => {
        UI.clear(repBox);
        const r = m.report;
        if (!r) return;
        if (r.busy) { repBox.appendChild(h('div', { class: 'desk-status' }, 'Отправка через ' + dev.email.outgoing + '…')); return; }
        if (!r.ok) { repBox.appendChild(h('div', { class: 'hint-box warn' }, '✕ Письмо не отправлено: ' + r.error)); return; }
        const okN = r.results.filter((x) => x.ok).length;
        repBox.appendChild(h('div', { class: 'msg-card', style: { marginTop: '8px' } },
          h('div', { class: 'head' }, h('span', null, 'Отчёт о доставке'), h('span', { class: 'meta' }, 'доставлено ' + okN + ' из ' + r.results.length)),
          h('div', { class: 'dlv' }, r.results.map((x) => h('div', null, h('span', { class: x.ok ? 'st ok' : 'st fail' }, x.ok ? '✓' : '✕'), h('span', { class: 'tgt' }, x.to), h('span', { class: 'muted' }, x.text))))));
      };
      drawReport();
      box.append(DW.form(lbl('Кому'), toI, lbl('Тема'), subI), h('div', { style: { marginTop: '8px' } }, bodyI),
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn primary', onClick: () => {
          const d = app.net.getDevice(id);
          if (!d.power) { e.textContent = 'Устройство выключено'; return; }
          const to = toI.value.split(/[\s,;]+/).filter(Boolean);
          m.report = { busy: true };
          drawReport();
          d.emailSend(to, subI.value, bodyI.value, (r) => {
            m.report = r;
            if (r.ok && r.results.every((x) => x.ok)) m.draft = { to: '', subject: '', body: '' };
            if (repBox.isConnected) drawReport();
            app.needRender = true;
          });
        } }, 'Отправить'), e), repBox);
      box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Несколько получателей — через запятую. Сервер доставляет письмо каждому отдельно и сообщает результат по каждому адресу, так что «письмо нескольким ПК» не теряется молча.'));
      return null;
    }

    // входящие
    const list = h('div', { class: 'mail-list' });
    const read = h('div', { class: 'mail-read' });
    const drawList = () => {
      const d = app.net.getDevice(id);
      UI.clear(list);
      UI.clear(read);
      if (!d.email.address) list.appendChild(h('div', { class: 'hint-box warn' }, 'Почта не настроена — нажмите «Настроить почту».'));
      if (!d.emailBox.length) { list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, 'Писем нет. Нажмите «Получить», чтобы забрать почту с сервера.')); return; }
      d.emailBox.forEach((x, i) => {
        const row = h('div', { class: 'mail-row' + (i === m.sel ? ' sel' : '') + (x.read ? '' : ' unread') }, h('span', { class: 'from' }, x.fromName || x.from), h('span', { class: 'subj' }, x.subject || '(без темы)'));
        row.addEventListener('click', () => { m.sel = i; drawList(); });
        list.appendChild(row);
      });
      const cur = d.emailBox[m.sel];
      if (cur) {
        if (!cur.read) { cur.read = true; app.needRender = true; }
        read.append(h('div', { class: 'mail-head' }, h('div', null, h('b', null, cur.subject || '(без темы)')), h('div', { class: 'muted' }, 'От: ' + (cur.fromName ? cur.fromName + ' <' + cur.from + '>' : cur.from)), h('div', { class: 'muted' }, 'Кому: ' + cur.to)), h('pre', { class: 'mail-body' }, cur.body));
      }
    };
    box.append(h('div', { class: 'mail-split' }, list, read));
    drawList();
    return null;
  }

  /* ================= «Сообщения» — прямая доставка нескольким ПК ================= */

  function messagesApp(app, id, box, st, win) {
    const dev = app.net.getDevice(id);
    const draft = app.mailDraft(id);
    const chips = h('div', { class: 'recips' });
    const toInput = h('input', { placeholder: draft.to.length ? '' : 'IP-адрес или имя, Enter — добавить', spellcheck: 'false' });
    const renderChips = () => {
      const hadFocus = document.activeElement === toInput;
      UI.clear(chips);
      for (const t of draft.to) {
        chips.appendChild(h('span', { class: 'rchip' }, t === '*' ? 'Всем в моей подсети' : app.labelForTarget(t),
          h('button', { title: 'Убрать', onClick: () => { draft.to = draft.to.filter((x) => x !== t); renderChips(); } }, '×')));
      }
      chips.appendChild(toInput);
      toInput.placeholder = draft.to.length ? '' : 'IP-адрес или имя, Enter — добавить';
      if (hadFocus) toInput.focus();
    };
    const addTargets = (text) => {
      for (const part of String(text).split(/[\s,;]+/)) {
        const t = part.trim();
        if (t && !draft.to.includes(t)) draft.to.push(t);
      }
      renderChips();
    };
    toInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
        e.preventDefault();
        const v = toInput.value;
        toInput.value = '';
        addTargets(v);
      } else if (e.key === 'Backspace' && !toInput.value && draft.to.length) {
        draft.to.pop();
        renderChips();
      }
    });
    toInput.addEventListener('blur', () => {
      const v = toInput.value;
      if (!v.trim()) return;
      toInput.value = '';
      addTargets(v);
    });
    chips.addEventListener('click', () => toInput.focus());
    renderChips();

    const pickBtn = h('button', { class: 'btn outline small' }, UI.icon('list'), 'Выбрать из сети');
    const pickBox = h('div', { style: { display: 'none' } });
    pickBtn.addEventListener('click', () => {
      if (pickBox.style.display !== 'none') { pickBox.style.display = 'none'; return; }
      UI.clear(pickBox);
      const list = h('div', { class: 'pick-list' });
      const hosts = [...app.net.devices.values()].filter((d) => d.sendMail && d.id !== id).sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
      if (!hosts.length) list.appendChild(h('div', { class: 'muted', style: { padding: '6px' } }, 'В сети нет других компьютеров.'));
      for (const d of hosts) {
        const ip = d.iface && d.iface.ip;
        const t = ip != null ? U.ipStr(ip) : null;
        const cb = h('input', { type: 'checkbox', checked: t != null && draft.to.includes(t), disabled: t == null });
        cb.addEventListener('change', () => {
          if (cb.checked) { if (!draft.to.includes(t)) draft.to.push(t); } else draft.to = draft.to.filter((x) => x !== t);
          renderChips();
        });
        list.appendChild(h('label', { class: t == null ? 'disabled' : '' }, cb, h('span', null, d.name), h('span', { class: 'muted mono', style: { marginLeft: 'auto' } }, t || 'нет IP')));
      }
      const all = h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { class: 'btn small outline', onClick: () => { for (const d of hosts) if (d.iface && d.iface.ip != null) { const t = U.ipStr(d.iface.ip); if (!draft.to.includes(t)) draft.to.push(t); } renderChips(); pickBox.style.display = 'none'; } }, 'Выбрать всех'),
        h('button', { class: 'btn small outline', onClick: () => { if (!draft.to.includes('*')) draft.to.push('*'); renderChips(); pickBox.style.display = 'none'; } }, 'Всем в моей подсети (broadcast)'));
      pickBox.append(list, all);
      pickBox.style.display = '';
    });

    const subj = h('input', { class: 'inp', value: draft.subject, placeholder: 'Тема' });
    subj.addEventListener('input', () => { draft.subject = subj.value; });
    const text = h('textarea', { class: 'inp', rows: 4, placeholder: 'Текст сообщения' });
    text.value = draft.body;
    text.addEventListener('input', () => { draft.body = text.value; });
    const e = err();
    const send = h('button', { class: 'btn primary' }, UI.icon('pdu'), 'Отправить');
    const inboxBox = h('div');
    const outBox = h('div');
    let sig = null;
    const live = () => {
      const d = app.net.getDevice(id);
      if (!d || !inboxBox.isConnected) return;
      const s2 = d.inbox.length + ':' + d.outbox.map((mm) => mm.items.map((it) => it.status + it.text).join('|')).join('/');
      if (s2 === sig) return;
      sig = s2;
      UI.clear(inboxBox);
      if (!d.inbox.length) inboxBox.appendChild(h('div', { class: 'muted' }, 'Сообщений пока нет.'));
      for (const mm of d.inbox.slice(0, 30)) {
        inboxBox.appendChild(h('div', { class: 'msg-card' + (mm.read ? '' : ' unread') },
          h('div', { class: 'head' }, h('span', null, mm.subject || '(без темы)'), h('span', { class: 'meta' }, 'от ' + (mm.from || '?') + ' (' + U.ipStr(mm.fromIp) + ')' + (mm.bcast ? ' · всем' : '') + ' · t=' + mm.time)),
          mm.body ? h('div', { class: 'body' }, mm.body) : null));
      }
      if (d.inbox.some((mm) => !mm.read)) { d.markAllRead(); app.needRender = true; win.setBadge('desktop', d.unreadCount()); }
      UI.clear(outBox);
      if (!d.outbox.length) outBox.appendChild(h('div', { class: 'muted' }, 'Вы ещё ничего не отправляли.'));
      for (const mm of d.outbox.slice(0, 20)) {
        const okN = mm.items.filter((it) => it.status === 'ok').length;
        const dl = h('div', { class: 'dlv' });
        for (const it of mm.items) {
          const icon = it.status === 'ok' ? '✓' : it.status === 'fail' ? '✕' : '⏳';
          const cls = it.status === 'ok' ? 'st ok' : it.status === 'fail' ? 'st fail' : 'st run';
          dl.appendChild(h('div', null, h('span', { class: cls }, icon), h('span', { class: 'tgt' }, it.target === '*' ? 'всем в подсети' : app.labelForTarget(it.target)), h('span', { class: 'muted' }, it.text)));
        }
        outBox.appendChild(h('div', { class: 'msg-card' },
          h('div', { class: 'head' }, h('span', null, mm.subject || '(без темы)'), h('span', { class: 'meta' }, 'доставлено ' + okN + ' из ' + mm.items.length + ' · t=' + mm.time)), dl));
      }
    };
    send.addEventListener('click', () => {
      if (toInput.value.trim()) { addTargets(toInput.value); toInput.value = ''; }
      if (!draft.to.length) { e.textContent = 'Укажите хотя бы одного получателя'; return; }
      const d = app.net.getDevice(id);
      if (!d.power) { e.textContent = 'Устройство выключено'; return; }
      try {
        const msg = d.sendMail(draft.to, draft.subject, draft.body);
        app.trackMail(d, msg);
        e.textContent = '';
        draft.to = [];
        draft.subject = '';
        draft.body = '';
        subj.value = '';
        text.value = '';
        renderChips();
        live();
      } catch (ex) { e.textContent = ex.message; }
    });
    if (!dev.iface || dev.iface.ip == null) box.appendChild(h('div', { class: 'hint-box warn', style: { marginBottom: '10px' } }, 'У компьютера нет IP-адреса — настройте его в «IP Configuration».'));
    box.appendChild(h('div', { class: 'hint-box', style: { marginBottom: '10px' } }, '«Сообщения» доставляют текст напрямую на другие ПК (без почтового сервера): каждому получателю отдельно, с подтверждением и повторами. Для настоящей почты через сервер — программа Email.'));
    box.appendChild(h('div', { class: 'mail' },
      h('div', null, DW.section('Новое сообщение'),
        h('div', { class: 'form', style: { maxWidth: 'none', gridTemplateColumns: '70px 1fr' } },
          h('label', null, 'Кому'), h('div', null, chips, h('div', { class: 'row', style: { marginTop: '6px' } }, pickBtn), pickBox),
          h('label', null, 'Тема'), subj,
          h('label', null, 'Текст'), text,
          h('span'), h('div', { class: 'row' }, send, e))),
      h('div', null, DW.section('Входящие'), inboxBox),
      h('div', null, DW.section('Отправленные'), outBox)));
    live();
    return live;
  }

  /* ================= Text Editor ================= */

  function editorApp(app, id, box, st) {
    const dev = app.net.getDevice(id);
    const ed = (st.editor = st.editor || { name: '', text: '' });
    const nameI = h('input', { class: 'inp', value: ed.name, placeholder: 'имя файла, например notes.txt' });
    const ta = h('textarea', { class: 'inp mono editor-area', spellcheck: 'false' });
    ta.value = ed.text;
    nameI.addEventListener('input', () => { ed.name = nameI.value; });
    ta.addEventListener('input', () => { ed.text = ta.value; });
    const e = err();
    const files = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, dev.files.length ? dev.files.map((f) => h('span', { class: 'rchip file-chip' + (f.name === ed.name ? ' on' : ''), onClick: (ev) => { if (ev.target.tagName === 'BUTTON') return; ed.name = f.name; ed.text = f.text; st.win.select('desktop'); } }, f.name,
      h('button', { title: 'Удалить файл', onClick: () => DW.apply(app, () => app.net.getDevice(id).deleteFile(f.name)) }, '×'))) : h('span', { class: 'muted' }, 'Файлов нет.'));
    box.append(h('div', { class: 'row' },
      h('button', { class: 'btn small outline', onClick: () => { ed.name = ''; ed.text = ''; st.win.select('desktop'); } }, 'Новый'),
      nameI,
      h('button', { class: 'btn small primary', onClick: () => DW.apply(app, () => app.net.getDevice(id).saveFile(ed.name, ed.text), e, 'Файл сохранён') }, 'Сохранить'), e),
      h('div', { style: { margin: '8px 0' } }, files), ta);
    return null;
  }

  /* ================= Firewall ================= */

  function firewallApp(app, id, box) {
    const dev = app.net.getDevice(id);
    const fw = dev.firewall;
    const e = err();
    const act = DW.select([['allow', 'Allow (разрешить)'], ['deny', 'Deny (запретить)']], 'allow');
    const proto = DW.select([['ip', 'IP (любой)'], ['icmp', 'ICMP'], ['tcp', 'TCP'], ['udp', 'UDP']], 'ip');
    const rip = DW.ipInput('0.0.0.0');
    const wc = DW.ipInput('255.255.255.255');
    const port = h('input', { class: 'inp', type: 'number', min: 0, max: 65535, placeholder: 'любой' });
    box.append(h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'muted' }, 'Брандмауэр'),
      DW.radio('fw-' + id, [['on', 'Вкл'], ['off', 'Выкл']], fw.enabled ? 'on' : 'off', (v) => DW.apply(app, () => { app.net.getDevice(id).firewall.enabled = v === 'on'; }))),
    DW.section('Входящие правила'),
    DW.form(lbl('Действие'), act, lbl('Протокол'), proto, lbl('Удалённый IP'), rip, lbl('Wildcard-маска'), wc, lbl('Порт (TCP/UDP)'), port,
      h('span'), h('div', { class: 'row' }, h('button', { class: 'btn primary small', onClick: () => {
        const a = DW.readIp(rip, true);
        if (!a.ok) { e.textContent = a.err; return; }
        const w = DW.readIp(wc, true);
        if (!w.ok) { e.textContent = w.err; return; }
        DW.apply(app, () => app.net.getDevice(id).addFirewallRule({ action: act.value, proto: proto.value, remote: a.v, wc: w.v, port: port.value === '' ? null : Number(port.value) }), e);
      } }, 'Добавить'), e)),
    h('table', { class: 'tbl', style: { marginTop: '10px' } },
      h('tr', null, h('th', null, '№'), h('th', null, 'Действие'), h('th', null, 'Протокол'), h('th', null, 'Удалённый IP'), h('th', null, 'Wildcard'), h('th', null, 'Порт'), h('th')),
      fw.rules.length ? fw.rules.map((r, i) => h('tr', null, h('td', null, String(i + 1)), h('td', null, r.action === 'allow' ? h('span', { class: 'st ok' }, 'Allow') : h('span', { class: 'st fail' }, 'Deny')),
        h('td', null, r.proto.toUpperCase()), h('td', { class: 'mono' }, U.ipStr(r.remote)), h('td', { class: 'mono' }, U.ipStr(r.wc)), h('td', null, r.port == null ? 'любой' : String(r.port)),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => DW.apply(app, () => app.net.getDevice(id).firewall.rules.splice(i, 1)) }, UI.icon('delete')))))
        : h('tr', { class: 'empty' }, h('td', { colspan: 7 }, 'Правил нет.'))));
    box.appendChild(h('div', { class: 'hint-box', style: { marginTop: '10px' } },
      'Включённый брандмауэр блокирует весь входящий трафик, кроме разрешённого правилами (сверху вниз, первое совпадение). Ответы на ваши собственные запросы (ping, браузер, почта) пропускаются всегда. ' +
      'Wildcard 255.255.255.255 и адрес 0.0.0.0 — «любой узел».'));
    return null;
  }

  /* ================= Traffic Generator ================= */

  function trafficApp(app, id, box, st) {
    const t = (st.traffic = st.traffic || { dst: '', proto: 'icmp', dport: 80, sport: '', ttl: 32, size: 32, count: 5, interval: 50, log: [], job: null });
    const dst = h('input', { class: 'inp mono', value: t.dst, placeholder: 'IP или имя', spellcheck: 'false' });
    const proto = DW.select([['icmp', 'ICMP (ping)'], ['udp', 'UDP'], ['tcp', 'TCP']], t.proto);
    const num = (k, min, max) => { const i = h('input', { class: 'inp', type: 'number', min, max, value: t[k] }); i.addEventListener('input', () => { t[k] = i.value; }); return i; };
    const dport = num('dport', 1, 65535);
    const sport = num('sport', 0, 65535);
    sport.placeholder = 'авто';
    dst.addEventListener('input', () => { t.dst = dst.value; });
    proto.addEventListener('change', () => { t.proto = proto.value; portRow.style.display = t.proto === 'icmp' ? 'none' : ''; });
    const portRow = h('div', { class: 'form', style: { display: t.proto === 'icmp' ? 'none' : '' } }, lbl('Порт назначения'), dport, lbl('Порт источника'), sport);
    const logEl = h('div', { class: 'gen-log' });
    const drawLog = () => {
      UI.clear(logEl);
      for (const l of t.log.slice(-200)) logEl.appendChild(h('div', { class: l.type === 'ok' ? 'ok' : l.type === 'fail' ? 'fail' : l.type === 'done' ? 'done' : '' }, l.text));
      logEl.scrollTop = logEl.scrollHeight;
    };
    const e = err();
    const runBtn = h('button', { class: 'btn primary small' }, t.job ? 'Стоп' : 'Отправить');
    runBtn.addEventListener('click', () => {
      if (t.job) { t.job.cancel('Остановлено'); t.job = null; runBtn.textContent = 'Отправить'; return; }
      const d = app.net.getDevice(id);
      if (!d.power) { e.textContent = 'Устройство выключено'; return; }
      if (!t.dst.trim()) { e.textContent = 'Укажите адрес назначения'; return; }
      e.textContent = '';
      t.log.push({ type: 'info', text: '— ' + t.proto.toUpperCase() + ' → ' + t.dst + ', пакетов: ' + t.count + ' —' });
      drawLog();
      const job = d.trafficGen({
        dst: t.dst.trim(), proto: t.proto, dport: Number(t.dport), sport: t.sport === '' ? null : Number(t.sport), ttl: Number(t.ttl), size: Number(t.size), count: Number(t.count), interval: Number(t.interval),
        onEvent: (ev) => {
          t.log.push(ev);
          if (t.log.length > 500) t.log.splice(0, t.log.length - 500);
          if (ev.type === 'done') { t.job = null; if (runBtn.isConnected) runBtn.textContent = 'Отправить'; }
          if (logEl.isConnected) drawLog();
        },
      });
      t.job = job && !job.done ? job : null;
      runBtn.textContent = t.job ? 'Стоп' : 'Отправить';
    });
    box.append(DW.form(lbl('Назначение'), dst, lbl('Протокол'), proto), portRow,
      DW.form(lbl('TTL'), num('ttl', 1, 255), lbl('Размер (байт)'), num('size', 1, 1500), lbl('Количество'), num('count', 1, 1000), lbl('Интервал (тиков)'), num('interval', 1, 10000)),
      h('div', { class: 'row', style: { margin: '8px 0' } }, runBtn, h('button', { class: 'btn outline small', onClick: () => { t.log = []; drawLog(); } }, 'Очистить'), e), logEl);
    drawLog();
    return null;
  }

  /* ================= Telnet / SSH Client ================= */

  function telnetApp(app, id, box, st) {
    const c = (st.telnet = st.telnet || { proto: 'telnet', host: '', user: '', open: false });
    if (c.open) {
      const t = app.terminal(id, 'tel');
      box.classList.add('flush');
      box.append(h('div', { class: 'web-bar' }, h('span', null, (c.proto === 'ssh' ? 'SSH' : 'Telnet') + ' → ' + c.host), h('span', { class: 'grow' }),
        h('button', { class: 'btn small outline', onClick: () => { t.abort(); if (t.session) t.session.remote = null; t.renderPrompt(); c.open = false; st.win.select('desktop'); } }, 'Отключиться')), t.el);
      t.renderPrompt();
      setTimeout(() => t.focus(), 0);
      return () => t.renderPrompt();
    }
    const proto = DW.select([['telnet', 'Telnet'], ['ssh', 'SSH']], c.proto, (v) => { c.proto = v; userRow.style.display = v === 'ssh' ? '' : 'none'; });
    const host = h('input', { class: 'inp mono', value: c.host, placeholder: 'IP или имя', spellcheck: 'false' });
    const user = h('input', { class: 'inp mono', value: c.user, placeholder: 'имя пользователя', spellcheck: 'false' });
    const userRow = h('div', { class: 'form', style: { display: c.proto === 'ssh' ? '' : 'none' } }, lbl('Пользователь'), user);
    const e = err();
    const connect = () => {
      c.host = host.value.trim();
      c.user = user.value.trim();
      if (!c.host) { e.textContent = 'Укажите адрес'; return; }
      if (c.proto === 'ssh' && !c.user) { e.textContent = 'Для SSH нужно имя пользователя'; return; }
      c.open = true;
      st.win.select('desktop');
      const t = app.terminal(id, 'tel');
      t.runCommand(c.proto === 'ssh' ? 'ssh -l ' + c.user + ' ' + c.host : 'telnet ' + c.host);
    };
    DW.onEnter(host, connect);
    DW.onEnter(user, connect);
    box.append(DW.form(lbl('Тип подключения'), proto, lbl('Адрес'), host), userRow, h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn primary small', onClick: connect }, 'Подключиться'), e),
      h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'На маршрутизаторе/коммутаторе нужны: IP-адрес (у коммутатора — на SVI и шлюз по умолчанию), line vty 0 4 с паролем (login) или login local, enable secret. Для SSH ещё: hostname, ip domain-name, crypto key generate rsa, username … secret …, transport input ssh.'));
    return null;
  }

  /* ================= сетка программ ================= */

  const APPS = [
    { id: 'ipconfig', title: 'IP Configuration', color: '#2563eb', render: ipconfigApp },
    { id: 'cmd', title: 'Command Prompt', color: '#334155', term: true, render: (app, id, box) => termApp(app, id, box, 'cmd') },
    { id: 'terminal', title: 'Terminal', color: '#0f766e', term: (st) => !!st.termOk, render: terminalApp },
    { id: 'browser', title: 'Web Browser', color: '#0284c7', render: browserApp },
    { id: 'wireless', title: 'PC Wireless', color: '#7c3aed', render: wirelessApp },
    { id: 'email', title: 'Email', color: '#b45309', render: emailApp },
    { id: 'messages', title: 'Сообщения', color: '#16a34a', render: messagesApp },
    { id: 'telnet', title: 'Telnet / SSH Client', color: '#475569', term: (st) => !!(st.telnet && st.telnet.open), render: telnetApp },
    { id: 'traffic', title: 'Traffic Generator', color: '#dc2626', render: trafficApp },
    { id: 'editor', title: 'Text Editor', color: '#64748b', render: editorApp },
    { id: 'firewall', title: 'Firewall', color: '#ea580c', render: firewallApp },
  ];

  DW.desktopApps = APPS;
  DW.appGlyph = glyph;

  const isTerm = (a, st) => !!a && (typeof a.term === 'function' ? a.term(st) : !!a.term);

  DW.desktopTab = function (app, id) {
    const st = app.deskState(id);
    const tab = {
      id: 'desktop',
      label: 'Рабочий стол',
      flush: true,
      live: null,
      get keep() { const a = APPS.find((x) => x.id === st.app); return isTerm(a, st) || !!(a && a.keep); },
      render(body, win) {
        st.win = win;
        tab.live = null;
        const dev = app.net.getDevice(id);
        const A = APPS.find((a) => a.id === st.app);
        if (!A) {
          st.app = null;
          const grid = h('div', { class: 'desk-grid' });
          for (const a of APPS) {
            if (a.when && !a.when(dev)) continue;
            const badge = a.id === 'email' ? dev.emailBox.filter((m) => !m.read).length : a.id === 'messages' ? dev.inbox.filter((m) => !m.read).length : 0;
            grid.appendChild(h('button', { class: 'desk-icon', title: a.title, onClick: () => { st.app = a.id; win.select('desktop'); } },
              h('span', { class: 'tile', style: { background: a.color } }, glyph(a.id), badge ? h('span', { class: 'badge' }, String(badge)) : null), h('span', { class: 'cap' }, a.title)));
          }
          body.appendChild(h('div', { class: 'desk' }, grid, dev.power ? null : h('div', { class: 'hint-box warn', style: { margin: '12px' } }, 'Устройство выключено — включите его кнопкой питания на вкладке «Физический вид».')));
          return null;
        }
        const content = h('div', { class: 'desk-app-body' });
        body.appendChild(h('div', { class: 'desk-app' },
          h('div', { class: 'desk-app-title' }, h('span', { class: 'tile small', style: { background: A.color } }, glyph(A.id)), h('span', null, A.title), h('span', { class: 'grow' }),
            h('button', { class: 'btn icon small', title: 'Закрыть программу', onClick: () => { st.app = null; win.select('desktop'); } }, UI.icon('close'))),
          content));
        try {
          const live = A.render(app, id, content, st, win);
          tab.live = typeof live === 'function' ? live : null;
          if (tab.live) tab.live();
        } catch (e) {
          console.error(e);
          content.appendChild(h('div', { class: 'hint-box warn' }, 'Ошибка программы: ' + e.message));
        }
        return null;
      },
    };
    return tab;
  };

  DW.renderHtml = renderHtml;
})(globalThis.NetLab = globalThis.NetLab || {});
