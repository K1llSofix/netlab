/* NetLab UI — запись видео схемы (WebM): захват окна NetLab через getDisplayMedia и MediaRecorder.
 * В настольной версии окно выбирается само, в браузере — вкладка NetLab в стандартном окне выбора.
 * Удобно для отчётов и объяснений: запустите запись, затем режим «Симуляция» — пакеты видны на видео. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const rec = { mr: null, stream: null, chunks: [], t0: 0, timer: null, el: null };

  const pad2 = (n) => String(n).padStart(2, '0');

  function stopUi() {
    if (rec.timer) clearInterval(rec.timer);
    rec.timer = null;
    if (rec.el) rec.el.remove();
    rec.el = null;
  }

  UI.isRecording = () => !!rec.mr;

  UI.recordToggle = async function (app) {
    if (rec.mr) { rec.mr.stop(); return; }
    const md = navigator.mediaDevices;
    if (!md || !md.getDisplayMedia || typeof MediaRecorder === 'undefined') { UI.toast('Запись экрана не поддерживается в этом браузере', 'err', 5000); return; }
    let stream;
    try {
      stream = await md.getDisplayMedia({ video: { frameRate: 20 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude' });
    } catch (e) {
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') UI.toast('Не удалось начать запись: ' + e.message, 'err', 6000);
      return;
    }
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    let mr;
    try { mr = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 4000000 } : undefined); } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      UI.toast('Не удалось начать запись: ' + e.message, 'err', 6000);
      return;
    }
    rec.mr = mr;
    rec.stream = stream;
    rec.chunks = [];
    rec.t0 = Date.now();
    mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.onstop = () => {
      rec.stream.getTracks().forEach((t) => t.stop());
      rec.mr = null;
      stopUi();
      const blob = new Blob(rec.chunks, { type: 'video/webm' });
      rec.chunks = [];
      if (!blob.size) { UI.toast('Запись пустая — ничего не сохранено', 'warn'); return; }
      const d = new Date();
      const name = String(app.fileName || 'NetLab').replace(/\.netlab$/i, '') + ' ' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '.webm';
      UI.download(name, blob, 'video/webm');
      UI.toast('Видео сохранено: ' + name + ' (' + (blob.size / 1048576).toFixed(1) + ' МБ)', 'ok', 5000);
    };
    // пользователь остановил показ экрана средствами браузера
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); });
    mr.start(1000);
    const time = h('span', { class: 'mono' }, '00:00');
    rec.el = h('div', { class: 'rec-badge', title: 'Идёт запись видео схемы' }, h('span', { class: 'rec-dot' }), 'Запись', time,
      h('button', { class: 'btn small', onClick: () => UI.recordToggle(app) }, 'Стоп'));
    document.body.appendChild(rec.el);
    rec.timer = setInterval(() => { const s = Math.floor((Date.now() - rec.t0) / 1000); time.textContent = pad2(Math.floor(s / 60)) + ':' + pad2(s % 60); }, 500);
    UI.toast('Запись началась. Остановить — кнопкой «Стоп» вверху экрана.', 'ok', 3500);
  };
})(globalThis.NetLab = globalThis.NetLab || {});
