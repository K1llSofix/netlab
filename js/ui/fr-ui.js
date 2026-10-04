/* NetLab UI — Frame Relay в облаке Cloud-PT: DLCI на портах Serial0–3 и таблица PVC (как в Packet Tracer). */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const DW = NS.dw;
  const h = UI.h;
  const F = NS.fr;

  DW.frCloudPage = function (app, dev, box) {
    const e = h('div', { class: 'err-text' });
    const C = F.cloud;
    const cloud = () => app.net.getDevice(dev.id);
    const act = (fn) => { if (DW.apply(app, fn, e)) draw(); };
    const fr = () => cloud().fr || { ports: {}, conns: [] };
    const portSel = () => DW.select(F.FR_PORTS.map((p) => [p, p + ' — ' + DW.peerText(app.net, cloud(), cloud().portIndex(p))]), F.FR_PORTS[0], null, { style: { width: 'auto' } });
    const pSel = portSel();
    const dlciI = h('input', { class: 'inp mono', placeholder: 'DLCI', style: { width: '90px' } });
    const nameI = h('input', { class: 'inp', placeholder: 'название (необязательно)', style: { width: '180px' } });
    const dlciList = h('div');
    const conns = h('div');
    const aSel = h('select', { class: 'inp', style: { width: 'auto' } });
    const bSel = h('select', { class: 'inp', style: { width: 'auto' } });
    const fillPairs = () => {
      const opts = [];
      for (const p of F.FR_PORTS) for (const d of ((fr().ports[p] || {}).dlcis || [])) opts.push([p + '|' + d.dlci, p + ' · DLCI ' + d.dlci + (d.name ? ' (' + d.name + ')' : '')]);
      for (const s of [aSel, bSel]) { UI.clear(s); s.append(...opts.map(([v, t]) => h('option', { value: v }, t))); }
      if (opts[1]) bSel.value = opts[1][0];
    };
    const draw = () => {
      UI.clear(dlciList);
      const rows = [];
      for (const p of F.FR_PORTS) for (const d of ((fr().ports[p] || {}).dlcis || [])) rows.push(h('tr', null, h('td', null, p), h('td', { class: 'mono' }, String(d.dlci)), h('td', null, d.name || ''),
        h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => act(() => C.removeDlci(cloud(), p, d.dlci)) }, UI.icon('delete')))));
      dlciList.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Порт'), h('th', null, 'DLCI'), h('th', null, 'Название'), h('th')), rows.length ? rows : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'DLCI не заданы'))));
      UI.clear(conns);
      const cl = fr().conns;
      conns.append(h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Откуда'), h('th'), h('th', null, 'Куда'), h('th')),
        cl.length ? cl.map((c, i) => h('tr', null, h('td', null, c.a.port + ' · DLCI ' + c.a.dlci), h('td', null, '↔'), h('td', null, c.b.port + ' · DLCI ' + c.b.dlci),
          h('td', null, h('button', { class: 'btn icon small danger', title: 'Удалить', onClick: () => act(() => C.disconnect(cloud(), i)) }, UI.icon('delete'))))) : h('tr', { class: 'empty' }, h('td', { colspan: 4 }, 'PVC нет'))));
      fillPairs();
    };
    box.append(DW.section('Frame Relay: DLCI на портах'), h('div', { class: 'row' }, pSel, dlciI, nameI,
      h('button', { class: 'btn primary small', onClick: () => act(() => { C.addDlci(cloud(), pSel.value, dlciI.value, nameI.value); dlciI.value = ''; nameI.value = ''; }) }, 'Добавить')), dlciList,
      DW.section('Frame Relay: PVC (соединения)'), h('div', { class: 'row' }, aSel, h('span', null, '↔'), bSel,
        h('button', { class: 'btn primary small', onClick: () => act(() => { const [ap, ad] = aSel.value.split('|'); const [bp, bd] = bSel.value.split('|'); C.connect(cloud(), ap, ad, bp, bd); }) }, 'Соединить')), conns, e,
      h('div', { class: 'hint-box', style: { marginTop: '10px' } }, 'Маршрутизаторы подключаются кабелем Serial к портам Serial0–Serial3 облака (облако — DCE, тактовая частота уже задана). На маршрутизаторе: interface s0/0/0 → encapsulation frame-relay; ' +
        'адреса узнаются по Inverse ARP или задаются: frame-relay map ip АДРЕС DLCI broadcast. Для подынтерфейсов: interface s0/0/0.102 point-to-point → frame-relay interface-dlci 102. Проверка: show frame-relay pvc | map.'));
    draw();
    return () => draw();
  };
})(globalThis.NetLab = globalThis.NetLab || {});
