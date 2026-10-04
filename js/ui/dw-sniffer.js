/* NetLab UI — анализатор трафика Sniffer-PT: значок, место в палитре, окно захвата (список кадров с фильтром
 * по протоколу, подробности по уровням, сохранение в .pcap для Wireshark); кнопка «.pcap» в панели симуляции. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;
  const DW = NS.dw;
  const P = NS.packets;

  const ICON = '<rect x="8" y="10" width="48" height="30" rx="3" fill="#1e293b"/>' +
    '<path d="M12 32l7-10 6 7 7-14 6 11 6-5 8 6" stroke="#22c55e" stroke-width="2.4" fill="none" stroke-linejoin="round"/>' +
    '<circle cx="46" cy="16" r="3" fill="#f59e0b"/><rect x="26" y="41" width="12" height="3" fill="#475569"/>';
  const baseIcon = UI.deviceIcon;
  UI.deviceIcon = function (type, model) { return type === 'sniffer' ? ICON : baseIcon(type, model); };
  UI.DEVICE_TYPES.push({ type: 'sniffer', label: 'Анализатор трафика', short: 'Sniffer' });
  const end = UI.DEVICE_CATEGORIES.find((c) => c.id === 'end');
  if (end) end.models.push('Sniffer-PT');

  const fname = (base) => base.replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.pcap';

  function savePcap(bytes, base) {
    UI.download(fname(base), bytes, 'application/vnd.tcpdump.pcap');
    UI.toast('Захват сохранён в ' + fname(base) + ' — откройте его в Wireshark', 'ok', 4000);
  }

  function capturePage(app, d, box) {
    const st = { filter: '', sel: null };
    const head = h('div', { class: 'row' });
    const table = h('div', { class: 'sniff-list' });
    const detail = h('div', { class: 'sniff-detail' });
    box.append(head, table, detail,
      h('div', { class: 'hint-box', style: { marginTop: '8px' } }, 'Sniffer видит только кадры, пришедшие на его порт. Чтобы смотреть трафик другого порта, настройте на коммутаторе зеркало: monitor session 1 source interface Fa0/1 и monitor session 1 destination interface <порт, куда подключён Sniffer>. Или подключите Sniffer к концентратору.'));
    let drawnN = -1;
    let drawnF = null;
    const draw = () => {
      const dev = app.net.getDevice(d.id);
      if (!dev) return;
      const cap = dev.capture;
      const lastN = cap.length ? cap[cap.length - 1].n : 0;
      if (lastN === drawnN && drawnF === st.filter && table.childNodes.length) return;
      drawnN = lastN;
      drawnF = st.filter;
      const protos = [...new Set(cap.map((x) => P.classify(x.frame)))].sort();
      UI.clear(head);
      head.append(
        UI.toggle(dev.capturing ? 'Захват идёт' : 'Захват остановлен', dev.capturing, (on) => { app.net.getDevice(d.id).setCapturing(on); drawnN = -1; draw(); }),
        DW.select([['', 'все протоколы']].concat(protos.map((p) => [p, (P.PROTOCOLS[p] && P.PROTOCOLS[p].label) || p])), st.filter, (v) => { st.filter = v; draw(); }),
        h('span', { class: 'muted small' }, 'кадров: ' + cap.length + (dev.total > cap.length ? ' (всего ' + dev.total + ')' : '')),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn outline small', onClick: () => { app.net.getDevice(d.id).clearCapture(); st.sel = null; drawnN = -1; draw(); UI.clear(detail); } }, 'Очистить'),
        h('button', { class: 'btn primary small', disabled: !cap.length, onClick: () => savePcap(app.net.getDevice(d.id).pcap(), dev.name) }, 'Сохранить .pcap'));
      UI.clear(table);
      const rows = cap.filter((x) => !st.filter || P.classify(x.frame) === st.filter).slice(-500);
      table.append(h('table', { class: 'tbl' }, h('tr', null, ['№', 'Время, с', 'Источник', 'Получатель', 'Протокол', 'Сведения'].map((x) => h('th', null, x))),
        rows.length ? rows.map((x) => {
          const f = x.frame;
          const ipL = f.payload && f.payload.src != null && (f.type === 'IPv4' || f.type === 'IPv6');
          const src = ipL ? (f.type === 'IPv6' ? NS.ip6.str(f.payload.src) : U.ipStr(f.payload.src)) : f.src || '—';
          const dst = ipL ? (f.type === 'IPv6' ? NS.ip6.str(f.payload.dst) : U.ipStr(f.payload.dst)) : f.dst || '—';
          const proto = P.classify(f);
          const color = P.PROTOCOLS[proto] ? P.PROTOCOLS[proto].color : '#64748b';
          const tr = h('tr', { class: 'sniff-row' + (st.sel === x.n ? ' sel' : ''), onClick: () => { st.sel = x.n; showDetail(x); for (const r of table.querySelectorAll('tr.sel')) r.classList.remove('sel'); tr.classList.add('sel'); } },
            h('td', null, String(x.n)), h('td', null, (x.time / 100).toFixed(2)), h('td', { class: 'mono' }, src), h('td', { class: 'mono' }, dst),
            h('td', null, h('span', { class: 'dot', style: { background: color } }), ' ' + proto), h('td', null, P.summary(f)));
          return tr;
        }) : h('tr', { class: 'empty' }, h('td', { colspan: 6 }, dev.capturing ? 'Кадров пока нет' : 'Захват остановлен'))));
      table.scrollTop = table.scrollHeight;
    };
    const showDetail = (x) => {
      UI.clear(detail);
      for (const L of P.layers(x.frame)) {
        detail.append(h('details', { open: true }, h('summary', null, L.title), h('table', { class: 'kv' }, L.fields.map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', { class: 'mono' }, String(v)))))));
      }
      const bytes = NS.pcap.encodeFrame(x.frame);
      const hex = [];
      for (let i = 0; i < Math.min(bytes.length, 512); i += 16) {
        const row = Array.from(bytes.slice(i, i + 16));
        hex.push(i.toString(16).padStart(4, '0') + '  ' + row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(48) + '  ' + row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''));
      }
      detail.append(h('details', null, h('summary', null, 'Байты кадра (как в Wireshark), ' + bytes.length), h('pre', { class: 'mono sniff-hex' }, hex.join('\n'))));
    };
    draw();
    return draw;
  }

  DW.configBuilders.sniffer = DW.simpleConfig({
    items: [{ group: 'SNIFFER' }, { id: 'cap', label: 'Захват' }],
    globalHint: () => 'Анализатор трафика записывает все кадры, пришедшие на его порт, и сохраняет их в файл .pcap для Wireshark.',
    render(sec, app, d, box) { return capturePage(app, d, box); },
  });

  /* ---------- экспорт журнала симуляции ---------- */

  UI.exportSimPcap = function (app) {
    const recs = NS.pcap.fromLog(app.net.log);
    if (!recs.length) { UI.toast('Журнал симуляции пуст — сначала отправьте пакеты в режиме «Симуляция»', 'warn'); return; }
    savePcap(NS.pcap.file(recs), (app.fileName || 'NetLab').replace(/\.netlab$/i, '') + ' — симуляция');
  };
})(globalThis.NetLab = globalThis.NetLab || {});
