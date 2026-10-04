/* NetLab UI — программа «Программирование» на рабочем столе ПК, ноутбука и сервера (как в Packet Tracer):
 * Python или JavaScript, запуск в отдельном потоке; сеть — через модель: requests (REST, RESTCONF),
 * ConnectHandler (SSH / Telnet к CLI, как netmiko), ping, json. Готовые примеры. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const DW = NS.dw;

  const PY = {
    rest: ['REST API сетевого контроллера', `# Вход в контроллер и список устройств (REST API)
import requests
import json

base = "http://192.168.1.100/api/v1"
r = requests.post(base + "/ticket", json={"username": "admin", "password": "cisco123"})
ticket = r.json()["response"]["serviceTicket"]
print("Токен:", ticket)

r = requests.get(base + "/network-device", headers={"X-Auth-Token": ticket})
for dev in r.json()["response"]:
    print(dev["hostname"], dev["managementIpAddress"], dev["reachabilityStatus"])
`],
    restconf: ['RESTCONF на маршрутизаторе', `# RESTCONF: интерфейсы маршрутизатора и новый Loopback
# На маршрутизаторе: username admin privilege 15 secret cisco, ip http secure-server, restconf
import requests
import json

url = "https://192.168.1.1/restconf/data/ietf-interfaces:interfaces"
auth = ("admin", "cisco")
# verify=False: у маршрутизатора самоподписанный сертификат
r = requests.get(url, headers={"Accept": "application/yang-data+json"}, auth=auth, verify=False)
print("Код ответа:", r.status_code)
for i in r.json()["ietf-interfaces:interfaces"]["interface"]:
    print(i["name"], "включён" if i["enabled"] else "выключен")

body = {"ietf-interfaces:interface": {"name": "Loopback1", "enabled": True,
        "ietf-ip:ipv4": {"address": [{"ip": "1.1.1.1", "netmask": "255.255.255.255"}]}}}
r = requests.put(url + "/interface=Loopback1", json=body, auth=auth, verify=False)
print("Создание Loopback1:", r.status_code)
`],
    netmiko: ['SSH к маршрутизатору (как netmiko)', `# Команды на маршрутизаторе по SSH
# На маршрутизаторе: hostname, ip domain-name, crypto key generate rsa, username admin secret cisco,
# enable secret class, line vty 0 4 → login local, transport input ssh
from netmiko import ConnectHandler

r1 = ConnectHandler(device_type="cisco_ios", host="192.168.1.1", username="admin", password="cisco", secret="class")
print(r1.send_command("show ip interface brief"))
r1.enable()
print(r1.send_config_set(["interface loopback 2", "ip address 2.2.2.2 255.255.255.255"]))
print(r1.send_command("show running-config | include Loopback"))
r1.disconnect()
`],
    ping: ['Проверка узлов ping', `# Какие адреса в сети отвечают на ping
for i in range(1, 6):
    host = "192.168.1." + str(i)
    r = ping(host)
    if r["ok"]:
        print(host, "— отвечает")
    else:
        print(host, "— молчит")
`],
  };
  const JS = {
    rest: ['REST API сетевого контроллера', `// Вход в контроллер и список устройств (REST API)
const base = "http://192.168.1.100/api/v1";
let r = requests.post(base + "/ticket", { json: { username: "admin", password: "cisco123" } });
const ticket = r.json().response.serviceTicket;
print("Токен:", ticket);
r = requests.get(base + "/network-device", { headers: { "X-Auth-Token": ticket } });
for (const d of r.json().response) print(d.hostname, d.managementIpAddress);
`],
    ping: ['Проверка узлов ping', `// Какие адреса отвечают на ping
for (let i = 1; i <= 5; i++) {
  const host = "192.168.1." + i;
  const r = ping(host);
  print(host, r.ok ? "— отвечает" : "— молчит");
}
`],
  };

  const running = new Map();
  UI.pcPrograms = running;

  function stop(app, id, why) {
    const r = running.get(id);
    if (!r) return;
    running.delete(id);
    try { r.worker.terminate(); } catch (e) { /* поток уже завершён */ }
    NS.automation.closeAll(app.net.getDevice(id));
    r.log.push({ kind: 'info', text: '■ ' + (why || 'Программа остановлена') });
    r.onChange();
  }

  function start(app, id, prog, log, onChange) {
    stop(app, id);
    const dev = app.net.getDevice(id);
    if (!dev || !dev.power) { log.push({ kind: 'err', text: 'Устройство выключено' }); onChange(); return; }
    let worker;
    try { worker = new Worker('js/ui/script-worker.js'); } catch (e) { log.push({ kind: 'err', text: 'Не удалось запустить поток: ' + e.message }); onChange(); return; }
    const r = { worker, log, onChange };
    running.set(id, r);
    log.push({ kind: 'info', text: '▶ Запуск (' + (prog.lang === 'python' ? 'Python' : 'JavaScript') + ')' });
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      const d = app.net.getDevice(id);
      if (!d) { stop(app, id, 'устройство удалено'); return; }
      if (m.type === 'req') {
        NS.automation.handle(d, m.kind, m.args, (e, res) => {
          if (!running.has(id)) return;
          try { worker.postMessage(e ? { type: 'res', id: m.id, ok: false, error: e.message } : { type: 'res', id: m.id, ok: true, result: res }); } catch (x) { /* поток остановлен */ }
        });
        return;
      }
      if (m.type === 'log' || m.type === 'error') {
        log.push({ kind: m.type === 'error' ? 'err' : 'out', text: m.text });
        if (log.length > 600) log.splice(0, log.length - 600);
        onChange();
      } else if (m.type === 'done') stop(app, id, 'Программа завершилась');
    };
    worker.onerror = (e) => { log.push({ kind: 'err', text: 'Ошибка потока: ' + (e.message || e) }); stop(app, id); };
    worker.postMessage({ type: 'run', code: prog.code, lang: prog.lang, inputs: {}, net: true });
    onChange();
  }

  function progApp(app, id, box, st) {
    const dev = app.net.getDevice(id);
    const P0 = NS.automation.program(dev);
    st.progLog = st.progLog || [];
    const log = st.progLog;
    const ta = h('textarea', { class: 'code-editor mono', spellcheck: 'false', wrap: 'off' });
    ta.value = P0.code;
    const out = h('div', { class: 'gen-log prog-out' });
    const status = h('span', { class: 'muted small' });
    const save = () => { const d = app.net.getDevice(id); if (d) { NS.automation.setProgram(d, { lang: langSel.value, code: ta.value }); app.markDirty(); } };
    ta.addEventListener('input', save);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(ta.selectionEnd); ta.selectionStart = ta.selectionEnd = s + 4; }
    });
    const tplFor = () => (langSel.value === 'python' ? PY : JS);
    const tplSel = h('select', { class: 'inp', style: { width: 'auto', minWidth: '200px' } });
    const fillTpl = () => {
      UI.clear(tplSel);
      tplSel.append(h('option', { value: '' }, '— пример —'), ...Object.entries(tplFor()).map(([k, [t]]) => h('option', { value: k }, t)));
    };
    const langSel = DW.select([['python', 'Python'], ['js', 'JavaScript']], P0.lang, () => { fillTpl(); save(); }, { style: { width: 'auto' } });
    fillTpl();
    tplSel.addEventListener('change', () => {
      const t = tplFor()[tplSel.value];
      if (!t) return;
      ta.value = t[1];
      tplSel.value = '';
      save();
    });
    const onChange = () => { if (st.progDraw) st.progDraw(); };
    const runBtn = h('button', { class: 'btn primary small', onClick: () => { save(); start(app, id, { lang: langSel.value, code: ta.value }, log, onChange); } }, '▶ Запустить');
    const stopBtn = h('button', { class: 'btn outline small', onClick: () => stop(app, id) }, '■ Стоп');
    const clearBtn = h('button', { class: 'btn outline small', onClick: () => { log.length = 0; draw(); } }, 'Очистить вывод');
    const draw = () => {
      const on = running.has(id);
      runBtn.disabled = on;
      stopBtn.disabled = !on;
      status.textContent = on ? 'выполняется…' : '';
      UI.clear(out);
      for (const x of log.slice(-300)) out.append(h('div', { class: x.kind === 'err' ? 'err' : x.kind === 'info' ? 'muted' : '' }, x.text));
      if (!log.length) out.append(h('div', { class: 'muted' }, 'Здесь будет вывод print(). Сетевые запросы идут по модели сети от этого компьютера — смотрите их в режиме «Симуляция».'));
      out.scrollTop = out.scrollHeight;
    };
    box.append(h('div', { class: 'row' }, langSel, tplSel, h('div', { class: 'grow' }), status, runBtn, stopBtn, clearBtn), ta, out,
      h('div', { class: 'muted small', style: { marginTop: '4px' } }, 'Доступно: requests.get/post/put/patch/delete (json=, headers=, auth=, params=), ConnectHandler(host=, username=, password=, secret=) → send_command, send_config_set, enable, disconnect; ping(адрес); json.dumps/loads; sleep. Python — учебное подмножество.'));
    st.progDraw = () => { if (out.isConnected) draw(); };
    draw();
    return null;
  }

  DW.appGlyphs = Object.assign(DW.appGlyphs || {}, {
    prog: (s, W) => [s('path', { d: 'M17 14L8 24l9 10M31 14l9 10-9 10', stroke: W, 'stroke-width': 3.2, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }), s('path', { d: 'M27 11l-6 26', stroke: W, 'stroke-width': 2.6, 'stroke-linecap': 'round' })],
  });
  DW.desktopApps.push({ id: 'prog', title: 'Программирование', color: '#b45309', render: progApp, keep: true, when: (d) => !!d.sendMail && !['smartphone', 'printer', 'ipphone'].includes(d.type) });
})(globalThis.NetLab = globalThis.NetLab || {});
