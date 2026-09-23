/* NetLab UI — окно устройства: набор вкладок как в Packet Tracer.
 *  ПК, ноутбук, планшет: Физический вид · Настройка · Рабочий стол · Атрибуты
 *  Сервер: + Службы;  принтер: без рабочего стола
 *  Маршрутизатор, коммутатор: Физический вид · Настройка · CLI · Атрибуты
 *  Концентратор, точка доступа, WRT300N: Физический вид · Настройка · Атрибуты */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const DW = NS.dw;

  function cliTab(app, id) {
    return {
      id: 'cli',
      label: 'CLI',
      flush: true,
      keep: true,
      render(body) {
        const t = app.terminal(id, 'cli');
        body.appendChild(t.el);
        t.renderPrompt();
        t.scroll();
        setTimeout(() => t.focus(), 0);
      },
      live() { const t = app.terminals.get('cli:' + id); if (t) t.renderPrompt(); },
    };
  }

  function tabsFor(app, dev) {
    const id = dev.id;
    const phys = DW.physicalTab(app, id);
    const cfg = DW.configTab(app, id);
    const attr = DW.attributesTab(app, id);
    switch (dev.type) {
      case 'pc':
      case 'laptop':
      case 'tablet':
        return [phys, cfg, DW.desktopTab(app, id), attr];
      case 'server':
        return [phys, cfg, DW.servicesTab(app, id), DW.desktopTab(app, id), attr];
      case 'printer':
        return [phys, cfg, attr];
      case 'router':
      case 'switch':
        return [phys, cfg, cliTab(app, id), attr];
      default:
        return [phys, cfg, attr];
    }
  }

  const SIZES = { pc: [760, 600], laptop: [760, 600], tablet: [760, 600], server: [800, 640], printer: [700, 540], router: [860, 660], switch: [860, 660], hub: [680, 520], ap: [720, 560], wrouter: [780, 600] };

  /** Какую вкладку открыть по умолчанию (двойной щелчок): как в Packet Tracer — «Настройка»/«Рабочий стол»/CLI. */
  function defaultTab(dev) {
    if (dev.type === 'router' || dev.type === 'switch') return 'cli';
    if (dev.type === 'pc' || dev.type === 'laptop' || dev.type === 'tablet' || dev.type === 'server') return 'desktop';
    return 'config';
  }

  /**
   * Открыть окно устройства. tabId: вкладка; для совместимости 'mail' → «Рабочий стол» → «Сообщения».
   */
  UI.openDeviceWindow = function (app, id, tabId) {
    const dev = app.net.getDevice(id);
    if (!dev) return null;
    if (tabId === 'mail' || tabId === 'email') {
      app.deskState(id).app = tabId === 'mail' ? 'messages' : 'email';
      tabId = 'desktop';
    }
    const tabs = tabsFor(app, dev);
    const wantTab = tabId && tabs.find((t) => t.id === tabId) ? tabId : undefined;
    const size = SIZES[dev.type] || [720, 560];
    const existed = !!UI.windows.get('dev:' + id);
    const win = UI.windows.open({
      id: 'dev:' + id,
      title: dev.name,
      sub: UI.typeLabel(dev.type) + ' · ' + dev.model + (dev.power ? '' : ' · выключен'),
      icon: UI.deviceSvg(dev.type),
      width: size[0],
      height: size[1],
      tabs,
      initialTab: wantTab || (existed ? undefined : app.uiPref('tab:' + dev.type, defaultTab(dev))),
    });
    if (!win.tabWatch) {
      win.tabWatch = true;
      const sel = win.select.bind(win);
      win.select = (t) => { sel(t); if (win.active) app.setUiPref('tab:' + dev.type, win.active.id); };
    }
    if (dev.unreadCount) win.setBadge('desktop', dev.unreadCount());
    return win;
  };
})(globalThis.NetLab = globalThis.NetLab || {});
