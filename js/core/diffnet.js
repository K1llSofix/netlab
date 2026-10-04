/* NetLab — сравнение двух схем: какие устройства и кабели добавлены или удалены и чем отличаются настройки
 * (у IOS-устройств — построчно running-config, у остальных — параметры конфигурации «ключ = значение»).
 * compare(эталон, текущая) → { added, removed, changed: [{ name, lines: [{ op: '-'|'+'|' ', text }] }], links: { added, removed }, same } */
(function (NS) {
  'use strict';

  const U = NS.util;
  const HEADER = /^(Building configuration|Current configuration|! Last configuration change|! NVRAM config last updated|version \d|no service timestamps)/;
  const VOLATILE = /^(inbox|outbox|emailBox|mailSeen|leases|log|logBuf|history|arp|macTable|dnsCache|x|y|id|rt|counters|stats|nvram|dhcpBound|clock|uptime|seq|epoch|pk|by)$/;

  function flatten(o, pre, out) {
    if (o === null || o === undefined) return out;
    if (Array.isArray(o)) { o.forEach((v, i) => flatten(v, pre + '[' + i + ']', out)); return out; }
    if (typeof o === 'object') {
      for (const k of Object.keys(o).sort()) if (!VOLATILE.test(k)) flatten(o[k], pre ? pre + '.' + k : k, out);
      return out;
    }
    out.push(pre + ' = ' + String(o));
    return out;
  }

  /** Строки для сравнения настроек устройства. */
  function configLines(d) {
    if (d.ios && d.type !== 'wrouter' && d.type !== 'asa' && NS.cliIos) {
      return NS.cliIos.runningConfig(d).map((l) => String(l).replace(/\s+$/, '')).filter((l) => l && l.trim() !== '!' && l !== 'end' && !HEADER.test(l));
    }
    const L = [];
    if (d.iface && typeof d.setStatic === 'function') {
      const f = d.iface;
      L.push('IP-адрес: ' + (f.dhcp ? 'DHCP' : f.ip != null ? U.cidr(f.ip, f.mask) : 'не задан'));
      L.push('Шлюз: ' + (d.gateway != null ? U.ipStr(d.gateway) : 'не задан'));
      L.push('DNS: ' + (d.dns != null ? U.ipStr(d.dns) : 'не задан'));
    }
    let c = null;
    try { c = d.serializeConfig ? d.serializeConfig() : null; } catch (e) { c = null; }
    if (c) {
      const skip = /^(ifaces|gateway|dns|ios)\b/;
      for (const l of flatten(c, '', [])) if (!skip.test(l)) L.push(l);
    }
    return L;
  }

  /** Построчная разница (LCS): [{ op: ' ' | '-' | '+', text }]. */
  function lineDiff(a, b) {
    const n = a.length;
    const m = b.length;
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { out.push({ op: '-', text: a[i] }); i++; } else { out.push({ op: '+', text: b[j] }); j++; }
    }
    while (i < n) out.push({ op: '-', text: a[i++] });
    while (j < m) out.push({ op: '+', text: b[j++] });
    return out;
  }

  /** Оставить изменения и по context строк вокруг них; пропуски — { op: '…', text: 'N строк без изменений' }. */
  function compact(lines, context) {
    const ctx = context == null ? 2 : context;
    const keep = new Array(lines.length).fill(false);
    lines.forEach((l, i) => { if (l.op !== ' ') for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true; });
    // строка режима (interface …, router …) над изменённой вложенной строкой
    lines.forEach((l, i) => {
      if (l.op === ' ' || !/^\s/.test(l.text)) return;
      for (let k = i - 1; k >= 0; k--) if (!/^\s/.test(lines[k].text)) { keep[k] = true; break; }
    });
    const out = [];
    let skipped = 0;
    lines.forEach((l, i) => {
      if (keep[i]) { if (skipped) out.push({ op: '…', text: skipped + ' строк без изменений' }); skipped = 0; out.push(l); } else skipped++;
    });
    if (skipped) out.push({ op: '…', text: skipped + ' строк без изменений' });
    return out;
  }

  function linkKeys(net) {
    const out = new Map();
    for (const l of net.links.values()) {
      const a = net.getDevice(l.a.dev);
      const b = net.getDevice(l.b.dev);
      if (!a || !b) continue;
      const ea = a.name + ' ' + a.ports[l.a.port].name;
      const eb = b.name + ' ' + b.ports[l.b.port].name;
      const [x, y] = [ea, eb].sort();
      out.set(x + ' ↔ ' + y, (l.wireless ? 'Wi-Fi' : l.cable));
    }
    return out;
  }

  function compare(ref, cur) {
    const byName = (net) => new Map([...net.devices.values()].map((d) => [d.name.toLowerCase(), d]));
    const A = byName(ref);
    const B = byName(cur);
    const added = [...B.values()].filter((d) => !A.has(d.name.toLowerCase())).map((d) => d.name + ' (' + d.model + ')');
    const removed = [...A.values()].filter((d) => !B.has(d.name.toLowerCase())).map((d) => d.name + ' (' + d.model + ')');
    const changed = [];
    for (const [k, a] of A) {
      const b = B.get(k);
      if (!b) continue;
      if (a.type !== b.type || a.model !== b.model) {
        changed.push({ name: b.name, note: 'другая модель: ' + a.model + ' → ' + b.model, lines: [] });
        continue;
      }
      const d = lineDiff(configLines(a), configLines(b));
      const n = d.filter((x) => x.op !== ' ').length;
      const power = a.power !== b.power ? (b.power ? 'питание включено' : 'питание выключено') : '';
      if (n || power) changed.push({ name: b.name, note: power, count: n, lines: compact(d) });
    }
    const la = linkKeys(ref);
    const lb = linkKeys(cur);
    const links = {
      added: [...lb.keys()].filter((k) => !la.has(k)).map((k) => k + ' (' + lb.get(k) + ')'),
      removed: [...la.keys()].filter((k) => !lb.has(k)).map((k) => k + ' (' + la.get(k) + ')'),
    };
    const same = !added.length && !removed.length && !changed.length && !links.added.length && !links.removed.length;
    return { added, removed, changed: changed.sort((x, y) => x.name.localeCompare(y.name, 'ru', { numeric: true })), links, same };
  }

  NS.diffnet = { compare, lineDiff, compact, configLines };
})(globalThis.NetLab = globalThis.NetLab || {});
