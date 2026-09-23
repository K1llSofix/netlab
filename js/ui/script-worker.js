/* NetLab — Web Worker для программ плат MCU-PT / SBC-PT.
 * Отдельный поток без доступа к окну приложения; перед запуском кода пользователя
 * убираются сетевые API и загрузка сторонних скриптов. Плата общается с симулятором только сообщениями. */
/* global importScripts */
'use strict';

importScripts('../core/script-rt.js');

(function () {
  const RT = self.NetLab.scriptRt;
  const post = self.postMessage.bind(self);

  // сеть и загрузка кода недоступны программе платы
  const BLOCK = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts',
    'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'Request', 'Response', 'navigator'];
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    for (const k of BLOCK) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      try { delete o[k]; } catch (e) { /* ignore */ }
      try { if (k in o) Object.defineProperty(o, k, { value: undefined, configurable: false, writable: false }); } catch (e) { /* ignore */ }
    }
  }

  let inputs = {};
  const outputs = {};
  let prog = null;

  const io = {
    read(pin, mode) {
      if (pin in outputs) return mode === 'digital' ? (outputs[pin] > 0 ? 1 : 0) : outputs[pin];
      const v = inputs[pin];
      if (!v) return 0;
      return mode === 'digital' ? v.d : v.a;
    },
    write(pin, value) { outputs[pin] = value; post({ type: 'write', pin, value }); },
    mode(pin, m) {
      if (m !== 'OUTPUT') delete outputs[pin];
      post({ type: 'mode', pin, mode: m });
    },
    log(text) { post({ type: 'log', text: String(text).slice(0, 2000) }); },
    error(text) { post({ type: 'error', text: String(text).slice(0, 2000) }); },
    done() { post({ type: 'done' }); },
  };

  self.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'inputs') inputs = m.values || {};
    else if (m.type === 'run' && !prog) {
      inputs = m.inputs || {};
      prog = RT.run(String(m.code || ''), io);
    } else if (m.type === 'stop' && prog) {
      prog.stop();
    }
  };
})();
