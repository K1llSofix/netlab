/* NetLab UI — язык интерфейса. Русский — основной; English включается в меню «Вид» и применяется после перезапуска.
 * Английский работает словарём (i18n-en.js): наблюдатель за DOM переводит тексты, подсказки (title) и placeholder.
 * Консоль CLI, веб-страницы в браузере ПК и имена устройств на схеме не переводятся. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const KEY = 'netlab.lang';
  const CYR = /[А-Яа-яЁё]/;
  const SKIP = '.term, .web-page, pre, textarea, #stage, .no-i18n, .cm-editor, .code-edit';

  let lang = 'ru';
  try { lang = localStorage.getItem(KEY) === 'en' ? 'en' : 'ru'; } catch (e) { /* нет хранилища */ }

  UI.lang = lang;
  UI.setLang = function (l) {
    try { localStorage.setItem(KEY, l === 'en' ? 'en' : 'ru'); } catch (e) { /* нет хранилища */ }
  };

  let dict = null;
  let frag = null;

  function build() {
    dict = new Map(Object.entries(NS.i18nEn || {}));
    // фрагменты для составных строк («Устройств: 5 · кабелей: 3»): только достаточно длинные
    const keys = [...dict.keys()].filter((k) => CYR.test(k) && k.replace(/[^А-Яа-яЁё]/g, '').length >= 3).sort((a, b) => b.length - a.length);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    frag = keys.length ? new RegExp('(?<![А-Яа-яЁё])(?:' + keys.map(esc).join('|') + ')(?![А-Яа-яЁё])', 'g') : null;
  }

  /** Перевод строки или null, если переводить нечего. */
  function tr(text) {
    if (!text || !CYR.test(text)) return null;
    if (!dict) build();
    const t = text.trim();
    const v = dict.get(t);
    if (v != null) return text.replace(t, v);
    if (!frag) return null;
    const UNITS = { км: 'km', м: 'm', Вт: 'W', мс: 'ms', с: 's', МБ: 'MB', КБ: 'KB', ГБ: 'GB' };
    const r = text.replace(frag, (m) => dict.get(m)).replace(/(\d)(\s?)(км|мс|м|Вт|с|МБ|КБ|ГБ)(?![А-Яа-яЁё])/g, (m, d, sp, u) => d + sp + UNITS[u]);
    // только если строка переведена целиком — смесь языков хуже, чем русский текст
    return r !== text && !CYR.test(r) ? r : null;
  }
  UI.tr = (s) => (lang === 'en' ? tr(String(s)) || String(s) : String(s));
  /** Непереведённые строки (для пополнения словаря): NetLab.i18n.missing. */
  const missing = new Set();

  const skip = (el) => !!(el && el.closest && el.closest(SKIP));

  function walk(node) {
    if (node.nodeType === 3) {
      if (skip(node.parentElement)) return;
      const v = tr(node.nodeValue);
      if (v != null) node.nodeValue = v;
      else if (CYR.test(node.nodeValue) && missing.size < 5000) missing.add(node.nodeValue.trim());
      return;
    }
    if (node.nodeType !== 1 || skip(node)) return;
    attrs(node);
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  }

  function attrs(el) {
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v && CYR.test(v)) { const x = tr(v); if (x != null) el.setAttribute(a, x); }
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && CYR.test(el.value)) { const x = tr(el.value); if (x != null) el.value = x; }
  }

  function start() {
    document.documentElement.lang = 'en';
    walk(document.body);
    const title = () => { const x = tr(document.title); if (x != null && x !== document.title) document.title = x; };
    title();
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') for (const n of m.addedNodes) walk(n);
        else if (m.type === 'characterData') walk(m.target);
        else if (m.type === 'attributes' && !skip(m.target)) attrs(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'] });
    const t = document.querySelector('title');
    if (t) new MutationObserver(title).observe(t, { childList: true, characterData: true, subtree: true });
  }

  if (lang === 'en' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else setTimeout(start, 0);
  }

  NS.i18n = { tr: (s) => tr(String(s)) || String(s), build, missing };
})(globalThis.NetLab = globalThis.NetLab || {});
