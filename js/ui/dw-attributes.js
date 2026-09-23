/* NetLab UI — вкладка «Атрибуты» (как Attributes в Packet Tracer): надёжность, стоимость, питание,
 * место в стойке; значения можно менять и добавлять свои. Общая стоимость сети — в строке состояния. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const DW = NS.dw;

  const NAMES = { MTBF: 'MTBF (часов наработки на отказ)', cost: 'Стоимость, $', 'power source': 'Источник питания (0 — сеть)', 'rack units': 'Высота в стойке (U)', wattage: 'Мощность, Вт' };

  DW.attributesTab = function (app, id) {
    return {
      id: 'attributes',
      label: 'Атрибуты',
      render(body) {
        const dev = app.net.getDevice(id);
        const e = h('div', { class: 'err-text' });
        const spec = NS.models.get(dev.model);
        const tbl = h('table', { class: 'tbl attr-tbl' }, h('tr', null, h('th', null, 'Атрибут'), h('th', null, 'Значение'), h('th')));
        const ro = (k, v) => tbl.appendChild(h('tr', { class: 'dim' }, h('td', { class: 'mono' }, k), h('td', { class: 'mono' }, v), h('td')));
        ro('PT_MODEL', dev.model);
        ro('PT_TYPE', UI.typeLabel(dev.type));
        ro('PT_VERSION', 'NetLab ' + (NS.VERSION || '2.0'));
        for (const [k, v] of Object.entries(dev.attrs)) {
          const inp = h('input', { class: 'inp mono', value: String(v), style: { width: '160px' } });
          DW.commitOnChange(inp, () => {
            const raw = inp.value.trim();
            const val = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
            DW.apply(app, () => { app.net.getDevice(id).attrs[k] = val; }, e);
          });
          const builtIn = spec && spec.attrs && k in spec.attrs;
          tbl.appendChild(h('tr', null, h('td', { title: NAMES[k] || '' }, h('span', { class: 'mono' }, k), NAMES[k] ? h('div', { class: 'muted', style: { fontSize: '11px' } }, NAMES[k]) : null), h('td', null, inp),
            h('td', null, builtIn ? null : h('button', { class: 'btn icon small danger', title: 'Удалить атрибут', onClick: () => DW.apply(app, () => { delete app.net.getDevice(id).attrs[k]; }, e) }, UI.icon('delete')))));
        }
        body.appendChild(tbl);
        const nk = h('input', { class: 'inp mono', placeholder: 'имя', style: { width: '160px' } });
        const nv = h('input', { class: 'inp mono', placeholder: 'значение', style: { width: '160px' } });
        const add = () => {
          const k = nk.value.trim();
          if (!/^[\p{L}\p{N} _.-]{1,32}$/u.test(k)) { e.textContent = 'Имя атрибута: буквы, цифры, пробел, «_», «-», «.»'; return; }
          const raw = nv.value.trim();
          DW.apply(app, () => { app.net.getDevice(id).attrs[k] = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw; }, e);
        };
        DW.onEnter(nv, add);
        body.appendChild(DW.section('Свой атрибут'));
        body.appendChild(h('div', { class: 'row' }, nk, nv, h('button', { class: 'btn outline small', onClick: add }, 'Добавить'), e));
        const total = [...app.net.devices.values()].reduce((sum, d) => sum + (Number(d.attrs && d.attrs.cost) || 0), 0);
        const watts = [...app.net.devices.values()].reduce((sum, d) => sum + (d.power ? Number(d.attrs && d.attrs.wattage) || 0 : 0), 0);
        body.appendChild(h('div', { class: 'hint-box', style: { marginTop: '12px' } }, 'Вся сеть: стоимость оборудования $' + total.toLocaleString('ru-RU') + ', потребляемая мощность включённых устройств ' + watts.toLocaleString('ru-RU') + ' Вт.'));
      },
    };
  };
})(globalThis.NetLab = globalThis.NetLab || {});
