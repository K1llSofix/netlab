/* NetLab UI — инструмент «Инспектор» (лупа в Packet Tracer): таблицы ARP, MAC, маршрутизации,
 * NAT, DHCP, соседей CDP/OSPF и сводка портов. Таблицы обновляются в реальном времени. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const U = NS.util;
  const h = UI.h;

  const ip = (v) => (v == null ? '—' : U.ipStr(v));

  /** Какие таблицы есть у устройства. */
  UI.inspectTables = function (d) {
    const t = [];
    const isL3 = d.type === 'router' || d.type === 'wrouter' || (d.type === 'switch' && d.l3);
    if (d.ifaces) t.push({ id: 'arp', label: 'Таблица ARP', short: 'ARP' });
    if (d.macTable) t.push({ id: 'mac', label: 'Таблица MAC-адресов', short: 'MAC' });
    if (isL3) t.push({ id: 'route', label: 'Таблица маршрутизации', short: 'Маршруты' });
    if (d.nat) t.push({ id: 'nat', label: 'Таблица NAT', short: 'NAT' });
    if (d.dhcpd && (d.type === 'router' || d.type === 'wrouter' || d.type === 'server')) t.push({ id: 'dhcp', label: 'Выданные DHCP-адреса', short: 'DHCP' });
    if (d.ospf) t.push({ id: 'ospf', label: 'Соседи OSPF', short: 'OSPF' });
    if (d.ios && d.type !== 'wrouter') t.push({ id: 'cdp', label: 'Соседи CDP', short: 'CDP' });
    t.push({ id: 'ports', label: 'Сводка портов', short: 'Порты' });
    return t;
  };

  function table(head, rows, empty) {
    return h('table', { class: 'tbl' }, h('tr', null, head.map((x) => h('th', null, x))),
      rows.length ? rows.map((r) => h('tr', { class: r.dim ? 'dim' : '' }, r.cells.map((c, i) => h('td', { class: r.mono && r.mono.includes(i) ? 'mono' : '' }, c))))
        : h('tr', { class: 'empty' }, h('td', { colspan: head.length }, empty)));
  }

  function build(app, d, id) {
    switch (id) {
      case 'arp':
        return table(['IP-адрес', 'MAC-адрес', 'Интерфейс', 'Устройство'], d.arpEntries().map((r) => ({ cells: [U.ipStr(r.ip), r.mac, r.ifname, app.nameForMac(r.mac)], mono: [0, 1] })),
          'Таблица пуста. Выполните ping — узел выучит адреса по ARP.');
      case 'mac':
        return table(['VLAN', 'MAC-адрес', 'Тип', 'Порт', 'Устройство'], d.macEntries().map((e) => ({ cells: [String(e.vlan), e.mac, e.static ? 'STATIC' : 'DYNAMIC', UI.shortIf(d.ports[e.port].name), app.nameForMac(e.mac)], mono: [1] })),
          'Таблица пуста — коммутатор ещё не видел кадров.');
      case 'route': {
        app.net.ensureRouting();
        const rows = d.routingTable().filter((r) => r.type !== 'L');
        const T = { C: 'C — подключена', S: 'S — статический', O: 'O — OSPF', R: 'R — RIP' };
        return table(['Тип', 'Сеть', 'Следующий переход', 'Интерфейс', 'AD/метрика'], rows.map((r) => ({
          dim: !r.active || r.shadowed,
          cells: [T[r.type] || r.type, U.cidr(r.net, r.mask), r.nextHop != null ? U.ipStr(r.nextHop) : '—', r.ifname || '—', r.type === 'C' ? '0/0' : r.ad + '/' + (r.metric || 0)],
          mono: [1, 2],
        })), 'Маршрутов нет: назначьте интерфейсам IP-адреса и подключите кабели.');
      }
      case 'nat': {
        const n = d.nat;
        const rows = [];
        for (const s of n.statics) rows.push({ cells: ['static', U.ipStr(s.local), U.ipStr(s.global), '—'], mono: [1, 2] });
        for (const e of n.table) {
          if (e.type === 'dyn') rows.push({ cells: ['dynamic', U.ipStr(e.local), U.ipStr(e.global), '—'], mono: [1, 2] });
          else if (e.type === 'static') rows.push({ cells: [e.proto, U.ipStr(e.local), U.ipStr(e.global), U.ipStr(e.outside)], mono: [1, 2, 3] });
          else rows.push({ cells: ['PAT ' + e.proto, U.ipStr(e.local) + ':' + e.lport, U.ipStr(e.global) + ':' + e.gport, U.ipStr(e.outside)], mono: [1, 2, 3] });
        }
        return table(['Тип', 'Inside local', 'Inside global', 'Outside'], rows, n.isEmpty() ? 'NAT не настроен.' : 'Трансляций пока нет — отправьте трафик изнутри наружу.');
      }
      case 'dhcp':
        return table(['IP-адрес', 'MAC клиента', 'Клиент', 'Пул'], d.dhcpd.leaseList().map((l) => ({ cells: [U.ipStr(l.ip), l.mac, app.nameForMac(l.mac), l.pool || ''], mono: [0, 1] })),
          d.dhcpd.enabled ? 'Адреса ещё не выдавались.' : 'Служба DHCP выключена.');
      case 'ospf':
        app.net.ensureRouting();
        return h('div', null, h('div', { class: 'muted', style: { marginBottom: '6px' } }, 'Router ID: ' + ip(d.ospfRouterId)),
          table(['Router ID', 'Состояние', 'Адрес', 'Интерфейс'], (d.ospfNeighbors || []).map((n) => ({ cells: [U.ipStr(n.id), n.state, U.ipStr(n.address), n.ifname], mono: [0, 2] })), 'Соседей нет.'));
      case 'cdp':
        return table(['Устройство', 'Локальный порт', 'Порт соседа', 'Платформа', 'Адреса'], NS.cdpNeighbors(d).map((n) => ({ cells: [n.dev.ios ? n.dev.ios.hostname : n.dev.name, n.localPort, n.remotePort, n.platform, n.addrs.map(U.ipStr).join(', ')], mono: [4] })),
          'Соседей CDP нет (CDP видит только соседние устройства Cisco).');
      default: {
        const rows = [];
        d.ports.forEach((p, i) => {
          if (!NS.Network.isData(p) && !p.link) return;
          const f = d.ifaces && d.ifaces.find((x) => x.port === i && (x.kind === 'phys' || x.kind === 'routed'));
          const st = p.radio ? (d.radioEnabled && d.radioEnabled() ? 'up' : 'down') : p.link ? app.net.portVisualState(d, i) : 'none';
          rows.push({
            dim: !p.link && !p.radio,
            cells: [h('span', null, h('span', { class: 'state-dot ' + st }), p.name), { up: 'работает', down: p.adminUp ? (p.errDisabled ? 'err-disabled' : 'не активен') : 'выключен', blocking: 'заблокирован STP', none: 'не подключён' }[st], f && f.ip != null ? U.cidr(f.ip, f.mask) : '', p.mac || '', NS.dw.peerText(app.net, d, i)],
            mono: [2, 3],
          });
        });
        return table(['Порт', 'Состояние', 'IP-адрес', 'MAC-адрес', 'Подключён к'], rows, 'Портов нет.');
      }
    }
  }

  UI.openInspector = function (app, devId, tableId) {
    const d = app.net.getDevice(devId);
    if (!d) return null;
    const tabs = UI.inspectTables(d).map((t) => {
      let sig = null;
      const tab = {
        id: t.id,
        label: t.short,
        render(body) {
          sig = null;
          body.appendChild(h('div', { class: 'insp-box' }));
          tab.live(body);
        },
        live(body) {
          const dev = app.net.getDevice(devId);
          const box = body && body.querySelector('.insp-box');
          if (!dev || !box) return;
          const el = build(app, dev, t.id);
          const s2 = el.textContent;
          if (s2 === sig) return;
          sig = s2;
          UI.clear(box);
          box.appendChild(el);
          if (t.id === 'arp' || t.id === 'mac') {
            box.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn outline small', onClick: () => { const x = app.net.getDevice(devId); if (t.id === 'arp') x.clearArp(); else x.flushMacTable(); sig = null; tab.live(body); } }, UI.icon('clear'), 'Очистить')));
          }
        },
      };
      return tab;
    });
    return UI.windows.open({
      id: 'insp:' + devId,
      title: d.name,
      sub: 'Инспектор',
      icon: UI.icon('inspect'),
      width: 640,
      height: 420,
      tabs,
      initialTab: tableId,
    });
  };
})(globalThis.NetLab = globalThis.NetLab || {});
