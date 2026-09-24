/* NetLab — коммутация уровня CCNA:
 *  • PVST+ и Rapid PVST+: отдельное остовное дерево на каждый VLAN (свой корень, свои блокировки),
 *    spanning-tree vlan … priority / root primary|secondary, spanning-tree mode pvst|rapid-pvst;
 *  • PortFast (в т. ч. portfast default) и BPDU Guard (порт уходит в err-disabled при появлении коммутатора);
 *  • DTP: switchport mode dynamic auto|desirable, switchport nonegotiate — фактический режим по соседу;
 *  • VTP: server / client / transparent / off, домен, пароль, версия, номер ревизии, рассылка VLAN по транкам;
 *  • EtherChannel: channel-group N mode on|active|passive|desirable|auto, interface Port-channel,
 *    LACP и PAgP, проверка совпадения настроек; канал — один логический порт для STP и таблицы MAC.
 * Как и прежде, протоколы сходятся мгновенно, но по настоящим правилам. */
(function (NS) {
  'use strict';

  const U = NS.util;

  const isSw = (d) => d && d.type === 'switch';

  /* ================= DTP ================= */

  function dtpMode(p) { return p.cfgMode || p.mode; }

  function dtpResolve(net) {
    let changed = false;
    for (const d of net.devices.values()) {
      if (!isSw(d)) continue;
      d.ports.forEach((p, i) => {
        if (!NS.Network.isData(p) || p.routed || p.radio) return;
        const cfg = dtpMode(p);
        let op;
        if (cfg === 'trunk') op = 'trunk';
        else if (cfg === 'access') op = 'access';
        else {
          op = 'access';
          const pr = net.isPortOperational(d, i) ? net.peer(d, i) : null;
          const q = pr && isSw(pr.dev) && pr.dev.power ? pr.dev.ports[pr.port] : null;
          if (q && !q.routed && !q.nonegotiate && !p.nonegotiate) {
            const qc = dtpMode(q);
            if (qc === 'trunk' || qc === 'dynamic desirable' || (cfg === 'dynamic desirable' && qc === 'dynamic auto')) op = 'trunk';
          }
        }
        p.dtpNegotiated = cfg !== 'trunk' && cfg !== 'access';
        if (p.mode !== op) { p.mode = op; changed = true; }
      });
    }
    return changed;
  }

  /* ================= EtherChannel ================= */

  const PROTO = { on: 'on', active: 'LACP', passive: 'LACP', desirable: 'PAgP', auto: 'PAgP' };

  function chanCompatible(a, b) {
    if (PROTO[a] !== PROTO[b]) return false;
    if (a === 'on') return b === 'on';
    if (PROTO[a] === 'LACP') return a === 'active' || b === 'active';
    return a === 'desirable' || b === 'desirable';
  }

  const sameL2 = (p, q) => p.mode === q.mode && p.vlan === q.vlan && p.nativeVlan === q.nativeVlan && p.allowed === q.allowed && (NS.portSpeed ? NS.portSpeed(p) === NS.portSpeed(q) : true);

  function chanResolve(net) {
    let changed = false;
    for (const d of net.devices.values()) {
      if (!isSw(d)) continue;
      const old = JSON.stringify(d.ports.map((p) => (p.bundle ? p.bundle.primary : -1)));
      d.chanRt = {};
      for (const p of d.ports) { p.bundle = null; p.chanState = null; }
      if (!d.power) continue;
      const groups = new Map();
      d.ports.forEach((p, i) => { if (p.chan) { if (!groups.has(p.chan.group)) groups.set(p.chan.group, []); groups.get(p.chan.group).push(i); } });
      for (const [g, members] of groups) {
        const rt = { group: g, protocol: PROTO[d.ports[members[0]].chan.mode] || 'on', members: members.slice(), bundled: [], peer: null };
        d.chanRt[g] = rt;
        const ok = [];
        let peerKey = null;
        for (const i of members) {
          const p = d.ports[i];
          if (!net.isPortOperational(d, i)) { p.chanState = 'D'; continue; }
          const pr = net.peer(d, i);
          const q = pr && isSw(pr.dev) ? pr.dev.ports[pr.port] : null;
          if (!q || !q.chan || !chanCompatible(p.chan.mode, q.chan.mode)) { p.chanState = 'I'; continue; }
          const key = pr.dev.id + ':' + q.chan.group;
          if (peerKey && key !== peerKey) { p.chanState = 's'; continue; }
          peerKey = key;
          ok.push({ i, pr });
        }
        // настройки портов в канале должны совпадать
        const first = ok.length ? d.ports[ok[0].i] : null;
        const bundled = ok.filter((x) => sameL2(d.ports[x.i], first) && sameL2(x.pr.dev.ports[x.pr.port], x.pr.dev.ports[ok[0].pr.port]));
        for (const x of ok) if (!bundled.includes(x)) d.ports[x.i].chanState = 's';
        if (bundled.length) {
          const idx = bundled.map((x) => x.i).sort((a, b) => a - b);
          for (const i of idx) { d.ports[i].bundle = { group: g, primary: idx[0], members: idx }; d.ports[i].chanState = 'P'; }
          rt.bundled = idx;
          rt.peer = net.getDevice(peerKey.split(':')[0]);
        }
      }
      if (JSON.stringify(d.ports.map((p) => (p.bundle ? p.bundle.primary : -1))) !== old) changed = true;
    }
    return changed;
  }

  /* ================= VTP ================= */

  function vtpCfg(d) {
    if (!d.vtp) d.vtp = { mode: 'server', domain: '', password: '', version: 1, revision: 0, updater: null, updated: null };
    return d.vtp;
  }

  /** Соседи по транкам (VTP-объявления ходят только по транкам). */
  function trunkNeighbors(net, d) {
    const out = [];
    d.ports.forEach((p, i) => {
      if (p.mode !== 'trunk' || p.routed || !p.oper) return;
      if (p.bundle && p.bundle.primary !== i) return;
      const pr = net.peer(d, i);
      if (pr && isSw(pr.dev) && pr.dev.power && pr.dev.ports[pr.port].mode === 'trunk') out.push(pr.dev);
    });
    return out;
  }

  function vtpSync(net) {
    const sws = [...net.devices.values()].filter((d) => isSw(d) && d.power);
    let changed = false;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const S of sws) {
        const s = vtpCfg(S);
        if (s.mode !== 'server' && s.mode !== 'client') continue;
        if (!s.domain) continue;
        // обход: через transparent объявление проходит, через off — нет
        const seen = new Set([S.id]);
        const queue = [S];
        while (queue.length) {
          const u = queue.shift();
          for (const v of trunkNeighbors(net, u)) {
            if (seen.has(v.id)) continue;
            seen.add(v.id);
            const c = vtpCfg(v);
            if (c.mode === 'off') continue;
            if (c.mode === 'transparent') { queue.push(v); continue; }
            if (!c.domain) { c.domain = s.domain; moved = true; }
            if (c.domain !== s.domain) continue;
            if (c.password !== s.password) continue;
            if (s.revision > c.revision) {
              v.vlans = new Map([...S.vlans.entries()]);
              c.revision = s.revision;
              c.updater = s.updater;
              c.updated = s.updated;
              if (v.flushMacTable) v.flushMacTable();
              moved = true;
            }
            queue.push(v);
          }
        }
      }
      if (!moved) break;
      changed = true;
    }
    return changed;
  }

  // изменения VLAN: сервер увеличивает ревизию, клиенту менять VLAN нельзя
  const addVlan = NS.Switch.prototype.addVlan;
  NS.Switch.prototype.addVlan = function (v, name) {
    const c = this.type === 'switch' ? vtpCfg(this) : null;
    if (c && c.mode === 'client') throw new Error('VTP VLAN configuration not allowed when device is in CLIENT mode.');
    const before = this.vlans.get(Number(v));
    addVlan.call(this, v, name);
    if (c && c.mode === 'server' && before !== this.vlans.get(Number(v))) vtpBump(this);
  };
  const removeVlan = NS.Switch.prototype.removeVlan;
  NS.Switch.prototype.removeVlan = function (v) {
    const c = this.type === 'switch' ? vtpCfg(this) : null;
    if (c && c.mode === 'client') throw new Error('VTP VLAN configuration not allowed when device is in CLIENT mode.');
    const had = this.vlans.has(Number(v));
    removeVlan.call(this, v);
    if (c && c.mode === 'server' && had) vtpBump(this);
  };
  const ensureVlan = NS.Switch.prototype.ensureVlan;
  NS.Switch.prototype.ensureVlan = function (v) {
    const c = this.type === 'switch' ? vtpCfg(this) : null;
    if (c && c.mode === 'client') return; // клиент не создаёт VLAN сам — порт останется неактивным
    const had = this.vlans.has(v);
    ensureVlan.call(this, v);
    if (c && c.mode === 'server' && !had) vtpBump(this);
  };

  function vtpBump(d) {
    const c = vtpCfg(d);
    c.revision++;
    const svi = d.ifaces && d.ifaces.find((f) => f.kind === 'svi' && f.ip != null);
    c.updater = svi ? svi.ip : 0;
    c.updated = d.clock();
    d.net.refreshTopology();
  }

  /* ================= PVST+ ================= */

  function prio(d, v) {
    return d.stpPrio && d.stpPrio[v] != null ? d.stpPrio[v] : d.stpPriority;
  }

  function cmpBid(a, b, v) {
    const pa = prio(a, v);
    const pb = prio(b, v);
    if (pa !== pb) return pa - pb;
    return a.baseMac < b.baseMac ? -1 : a.baseMac > b.baseMac ? 1 : 0;
  }

  function bundleCost(d, i) {
    const p = d.ports[i];
    const one = (k) => (NS.portSpeed ? NS.portSpeed(d.ports[k]) : d.ports[k].speed || 100);
    const speed = p.bundle ? p.bundle.members.reduce((s, k) => s + one(k), 0) : one(i);
    if (p.stpCost) return p.stpCost;
    if (speed >= 10000) return 2;
    if (speed >= 2000) return 3;
    if (speed >= 1000) return 4;
    if (speed >= 400) return 9;
    if (speed >= 200) return 12;
    if (speed >= 100) return 19;
    return 100;
  }

  const isPortfast = (d, p) => !!p.portfast || (!!d.portfastDefault && p.mode === 'access');
  const guardOn = (d, p) => p.bpduguard === true || (p.bpduguard !== false && !!d.bpduguardDefault && isPortfast(d, p));

  /** BPDU Guard: на порту PortFast появился коммутатор (он шлёт BPDU) — порт в err-disabled. */
  function bpduGuard(net) {
    let hit = false;
    for (const d of net.devices.values()) {
      if (!isSw(d) || !d.power) continue;
      d.ports.forEach((p, i) => {
        if (p.routed || !NS.Network.isData(p) || p.errDisabled || !guardOn(d, p) || !net.isPortOperational(d, i)) return;
        const pr = net.peer(d, i);
        if (!pr || !(isSw(pr.dev) || pr.dev.type === 'wrouter' || pr.dev.type === 'homegw') || !pr.dev.power) return;
        p.errDisabled = true;
        p.errReason = 'bpduguard';
        p.oper = false;
        if (d.iosLog) {
          d.iosLog('SPANTREE', 2, 'BLOCK_BPDUGUARD', 'Received BPDU on port ' + p.name + ' with BPDU Guard enabled. Disabling port.');
          d.iosLog('PM', 4, 'ERR_DISABLE', 'bpduguard error detected on ' + NS.cliIos.ctx.shortIf(p.name) + ', putting ' + NS.cliIos.ctx.shortIf(p.name) + ' in err-disable state');
        }
        net.emit('warn', { dev: d, text: d.name + ' ' + p.name + ': BPDU Guard — на порт PortFast подключён коммутатор, порт выключен (err-disabled). Включите его командами shutdown / no shutdown.' });
        hit = true;
      });
    }
    if (hit) net.timer(null, 0, () => net.refreshTopology());
    return hit;
  }

  function computePvst(net) {
    const sw = [];
    for (const d of net.devices.values()) if (isSw(d)) sw.push(d);
    const prev = new Map();
    for (const b of sw) {
      b.ports.forEach((p, i) => {
        prev.set(b.id + ':' + i, JSON.stringify(p.stpV || null));
        p.stp = null;
        p.stpRole = null;
        p.stpV = null;
        p.stpRoleV = null;
      });
      b.stpInfo = null;
      b.stpInfoV = {};
    }

    // концентраторы, соединённые между собой, — один сегмент
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const d of net.devices.values()) if (d.type === 'hub' && d.power) parent.set(d.id, d.id);
    for (const l of net.links.values()) {
      if (parent.has(l.a.dev) && parent.has(l.b.dev)) {
        const a = net.devices.get(l.a.dev);
        if (net.isPortOperational(a, l.a.port)) parent.set(find(l.a.dev), find(l.b.dev));
      }
    }

    const vlans = new Set();
    for (const b of sw) if (b.power) for (const v of b.vlans.keys()) vlans.add(v);

    const carries = (b, p, v) => b.vlans.has(v) && b.portCarries(p, v);

    for (const v of [...vlans].sort((x, y) => x - y)) {
      const segs = new Map();
      const bports = new Map();
      for (const b of sw) {
        if (!b.power) continue;
        const list = [];
        bports.set(b.id, list);
        b.ports.forEach((p, i) => {
          if (p.routed || p.radio || !net.isPortOperational(b, i) || !carries(b, p, v)) return;
          if (p.bundle && p.bundle.primary !== i) return;
          const pr = net.peer(b, i);
          if (!pr) return;
          let seg;
          if (isSw(pr.dev)) {
            const q = pr.dev.ports[pr.port];
            const qi = q.bundle ? q.bundle.primary : pr.port;
            if (!pr.dev.power || !carries(pr.dev, pr.dev.ports[qi], v)) return;
            seg = 'L' + [b.id + ':' + (p.bundle ? 'po' + p.bundle.group : i), pr.dev.id + ':' + (q.bundle ? 'po' + q.bundle.group : pr.port)].sort().join('|');
          } else if (parent.has(pr.dev.id)) seg = 'H' + find(pr.dev.id);
          else seg = 'E' + b.id + ':' + i;
          if (!segs.has(seg)) segs.set(seg, []);
          segs.get(seg).push({ b, i });
          list.push({ i, seg });
        });
      }

      const visited = new Set();
      for (const start of sw) {
        if (!start.power || !bports.has(start.id) || visited.has(start.id) || !start.vlans.has(v)) continue;
        const comp = [];
        const stack = [start];
        visited.add(start.id);
        while (stack.length) {
          const u = stack.pop();
          comp.push(u);
          for (const { seg } of bports.get(u.id)) {
            for (const { b } of segs.get(seg)) if (!visited.has(b.id)) { visited.add(b.id); stack.push(b); }
          }
        }
        let root = comp[0];
        for (const b of comp) if (cmpBid(b, root, v) < 0) root = b;

        const dist = new Map(comp.map((b) => [b.id, Infinity]));
        dist.set(root.id, 0);
        const done = new Set();
        for (;;) {
          let u = null;
          for (const b of comp) {
            if (done.has(b.id) || dist.get(b.id) === Infinity) continue;
            if (!u || dist.get(b.id) < dist.get(u.id) || (dist.get(b.id) === dist.get(u.id) && cmpBid(b, u, v) < 0)) u = b;
          }
          if (!u) break;
          done.add(u.id);
          for (const { seg } of bports.get(u.id)) {
            for (const { b: w, i: j } of segs.get(seg)) {
              if (w === u) continue;
              const c = dist.get(u.id) + bundleCost(w, j);
              if (c < dist.get(w.id)) dist.set(w.id, c);
            }
          }
        }

        const better = (b, i, c, j) => {
          const db = dist.get(b.id);
          const dc = dist.get(c.id);
          if (db !== dc) return db < dc;
          const r = cmpBid(b, c, v);
          if (r !== 0) return r < 0;
          return i < j;
        };
        const desig = new Map();
        for (const b of comp) {
          for (const { i, seg } of bports.get(b.id)) {
            const cur = desig.get(seg);
            if (!cur || better(b, i, cur.b, cur.i)) desig.set(seg, { b, i });
          }
        }

        for (const b of comp) {
          let rp = -1;
          let rk = null;
          if (b !== root) {
            for (const { i, seg } of bports.get(b.id)) {
              const d0 = desig.get(seg);
              if (d0.b === b && d0.i === i) continue;
              const k = { cost: dist.get(d0.b.id) + bundleCost(b, i), bridge: d0.b, dport: d0.i, port: i };
              if (!rk || k.cost < rk.cost ||
                (k.cost === rk.cost && (cmpBid(k.bridge, rk.bridge, v) < 0 ||
                  (cmpBid(k.bridge, rk.bridge, v) === 0 && (k.dport < rk.dport || (k.dport === rk.dport && k.port < rk.port)))))) {
                rk = k;
                rp = i;
              }
            }
          }
          for (const { i, seg } of bports.get(b.id)) {
            const p = b.ports[i];
            const d0 = desig.get(seg);
            let role;
            let state;
            if (i === rp) { role = 'root'; state = 'forwarding'; } else if (d0.b === b && d0.i === i) { role = 'designated'; state = 'forwarding'; } else {
              role = d0.b === b ? 'backup' : 'alternate';
              state = 'blocking';
            }
            if (!p.stpV) { p.stpV = {}; p.stpRoleV = {}; }
            p.stpV[v] = state;
            p.stpRoleV[v] = role;
          }
          b.stpInfoV[v] = {
            isRoot: b === root, rootName: root.name, rootMac: root.baseMac, rootPriority: prio(root, v), cost: dist.get(b.id), rootPort: rp,
          };
        }
      }
    }

    // итог по порту: «blocking», только если он заблокирован во всех своих VLAN; роль — в VLAN доступа (или 1/native)
    let changed = false;
    for (const b of sw) {
      b.ports.forEach((p, i) => {
        if (p.bundle && p.bundle.primary !== i) {
          const pp = b.ports[p.bundle.primary];
          p.stpV = pp.stpV;
          p.stpRoleV = pp.stpRoleV;
        }
        if (p.stpV) {
          const states = Object.values(p.stpV);
          p.stp = states.length && states.every((x) => x === 'blocking') ? 'blocking' : 'forwarding';
          const key = p.mode === 'access' ? p.vlan : p.stpV[p.nativeVlan] ? p.nativeVlan : Number(Object.keys(p.stpV)[0]);
          p.stpRole = p.stpRoleV[key] || null;
        }
        if (prev.get(b.id + ':' + i) !== JSON.stringify(p.stpV || null)) changed = true;
      });
      b.stpInfo = b.stpInfoV[1] || b.stpInfoV[Object.keys(b.stpInfoV)[0]] || null;
    }
    return changed;
  }

  const legacyCompute = NS.stp.compute;
  NS.stp.compute = function (net) {
    bpduGuard(net);
    const a = dtpResolve(net);
    const b = chanResolve(net);
    const c = vtpSync(net);
    const d = computePvst(net);
    return a || b || c || d;
  };
  NS.stp.legacyCompute = legacyCompute;
  NS.stp.portCost = bundleCost;

  /* ================= сохранение ================= */

  NS.deviceExt.push({
    key: 'l2',
    applies: (d) => d.type === 'switch',
    save(d) {
      const o = {};
      if (d.stpMode && d.stpMode !== 'pvst') o.stpMode = d.stpMode;
      if (d.stpPrio && Object.keys(d.stpPrio).length) o.stpPrio = Object.assign({}, d.stpPrio);
      if (d.portfastDefault) o.portfastDefault = true;
      if (d.bpduguardDefault) o.bpduguardDefault = true;
      const v = d.vtp;
      if (v && (v.mode !== 'server' || v.domain || v.password || v.version !== 1 || v.revision)) o.vtp = { mode: v.mode, domain: v.domain, password: v.password, version: v.version, revision: v.revision };
      if (d.channels && Object.keys(d.channels).length) o.channels = Object.keys(d.channels).map(Number);
      return Object.keys(o).length ? o : null;
    },
    load(d, c) {
      d.stpMode = c && c.stpMode === 'rapid-pvst' ? 'rapid-pvst' : 'pvst';
      d.stpPrio = c && c.stpPrio ? Object.fromEntries(Object.entries(c.stpPrio).map(([k, x]) => [Number(k), Number(x)])) : {};
      d.portfastDefault = !!(c && c.portfastDefault);
      d.bpduguardDefault = !!(c && c.bpduguardDefault);
      d.vtp = null;
      if (c && c.vtp) d.vtp = { mode: ['server', 'client', 'transparent', 'off'].includes(c.vtp.mode) ? c.vtp.mode : 'server', domain: String(c.vtp.domain || ''), password: String(c.vtp.password || ''), version: Number(c.vtp.version) === 2 ? 2 : 1, revision: Number(c.vtp.revision) || 0, updater: null, updated: null };
      d.channels = {};
      for (const g of (c && c.channels) || []) d.channels[g] = true;
      for (const p of d.ports) if (p.chan) d.channels[p.chan.group] = true;
    },
  });

  /* ================= Cisco IOS ================= */

  const X = NS.cliIos.ext;

  // Port-channel N
  X.ifNames.push((dev, t) => {
    const m = /^(?:port-channel|port-ch\w*|po)(\d+)$/i.exec(t);
    if (!m || dev.type !== 'switch') return null;
    const g = Number(m[1]);
    if (!(g >= 1 && g <= 64)) return null;
    return {
      kind: 'named', name: 'Port-channel' + g, portChannel: g,
      create: (d) => { if (!d.channels) d.channels = {}; d.channels[g] = true; return { name: 'Port-channel' + g }; },
      remove: (d) => { if (d.channels) delete d.channels[g]; for (const p of d.ports) if (p.chan && p.chan.group === g) p.chan = null; d.net.refreshTopology(); },
    };
  });

  X.global.push((t) => /^vtp$/i.test(t[0] || '') || /^port-channel$/i.test(t[0] || '') || /^errdisable$/i.test(t[0] || ''));

  function vlanList(tok) {
    const set = U.parseVlanList(tok || '');
    return set ? [...set].sort((a, b) => a - b) : null;
  }

  X.config.push((dev, s, a, neg, io, C) => {
    if (dev.type !== 'switch') return false;
    if (C.kw(a[0], 'spanning-tree', 2)) {
      const w = a[1];
      if (C.kw(w, 'mode', 1)) {
        const m = neg ? 'pvst' : C.kw(a[2], 'rapid-pvst', 1) ? 'rapid-pvst' : C.kw(a[2], 'pvst', 1) ? 'pvst' : null;
        if (!m) { C.invalid(io, a[2]); return true; }
        C.withMutate(io, () => { dev.stpMode = m; });
        return true;
      }
      if (C.kw(w, 'portfast', 1)) {
        if (C.kw(a[2], 'default', 1)) { C.withMutate(io, () => { dev.portfastDefault = !neg; }); dev.net.refreshTopology(); return true; }
        if (C.kw(a[2], 'bpduguard', 1)) { C.withMutate(io, () => { dev.bpduguardDefault = !neg; }); dev.net.refreshTopology(); return true; }
        C.incomplete(io);
        return true;
      }
      if (C.kw(w, 'vlan', 1)) {
        const list = vlanList(a[2]);
        if (!list) { C.incomplete(io); return true; }
        if (!dev.stpPrio) dev.stpPrio = {};
        if (C.kw(a[3], 'priority', 1)) {
          const n = Number(a[4]);
          if (!neg && !(Number.isInteger(n) && n >= 0 && n <= 61440)) { C.incomplete(io); return true; }
          if (!neg && n % 4096 !== 0) {
            io.out('% Bridge Priority must be in increments of 4096.');
            io.out('% Allowed values are:');
            io.out('  0     4096  8192  12288 16384 20480 24576 28672');
            io.out('  32768 36864 40960 45056 49152 53248 57344 61440');
            return true;
          }
          C.withMutate(io, () => {
            if (list.length > 1000) { dev.stpPriority = neg ? 32768 : n; dev.stpPrio = {}; } else for (const v of list) { if (neg) delete dev.stpPrio[v]; else dev.stpPrio[v] = n; }
          });
          dev.net.refreshTopology();
          return true;
        }
        if (C.kw(a[3], 'root', 1)) {
          const primary = C.kw(a[4], 'primary', 1);
          if (!primary && !C.kw(a[4], 'secondary', 1)) { C.incomplete(io); return true; }
          C.withMutate(io, () => {
            for (const v of list) {
              if (neg) { delete dev.stpPrio[v]; continue; }
              if (!primary) { dev.stpPrio[v] = 28672; continue; }
              const info = dev.stpInfoV && dev.stpInfoV[v];
              const rootPrio = info && !info.isRoot ? info.rootPriority : 32768;
              dev.stpPrio[v] = rootPrio > 24576 ? 24576 : Math.max(0, rootPrio - 4096);
            }
          });
          dev.net.refreshTopology();
          return true;
        }
        if (C.kw(a[3], 'hello-time', 1) || C.kw(a[3], 'forward-time', 1) || C.kw(a[3], 'max-age', 1)) return true;
        C.invalid(io, a[3]);
        return true;
      }
      if (C.kw(w, 'loopguard', 1) || C.kw(w, 'uplinkfast', 1) || C.kw(w, 'backbonefast', 1) || C.kw(w, 'extend', 1)) return true;
      C.invalid(io, w);
      return true;
    }
    if (C.kw(a[0], 'vtp', 3)) {
      const c = vtpCfg(dev);
      const w = a[1];
      if (C.kw(w, 'mode', 1)) {
        const m = neg ? 'server' : ['server', 'client', 'transparent', 'off'].find((x) => C.kw(a[2], x, 1));
        if (!m) { C.invalid(io, a[2]); return true; }
        if (c.mode === m) { io.out('Device mode already VTP ' + m.toUpperCase() + '.'); return true; }
        C.withMutate(io, () => { c.mode = m; if (m === 'transparent' || m === 'off') c.revision = 0; });
        io.out('Setting device to VTP ' + m.toUpperCase() + ' mode.');
        dev.net.refreshTopology();
        return true;
      }
      if (C.kw(w, 'domain', 1)) {
        const name = neg ? '' : String(a[2] || '');
        if (!neg && !name) { C.incomplete(io); return true; }
        if (c.domain === name) { io.out('Domain name already set to ' + name + '.'); return true; }
        io.out('Changing VTP domain name from ' + (c.domain || 'NULL') + ' to ' + (name || 'NULL'));
        C.withMutate(io, () => { c.domain = name; c.revision = 0; });
        dev.net.refreshTopology();
        return true;
      }
      if (C.kw(w, 'password', 1)) {
        C.withMutate(io, () => { c.password = neg ? '' : String(a[2] || ''); });
        io.out(neg ? 'Clearing device VLAN database password.' : 'Setting device VLAN database password to ' + c.password);
        dev.net.refreshTopology();
        return true;
      }
      if (C.kw(w, 'version', 1)) {
        const n = Number(a[2]);
        if (!neg && n !== 1 && n !== 2) { C.invalid(io, a[2]); return true; }
        C.withMutate(io, () => { c.version = neg ? 1 : n; });
        return true;
      }
      if (C.kw(w, 'pruning', 1)) return true;
      C.invalid(io, w);
      return true;
    }
    if (C.kw(a[0], 'port-channel', 6) && C.kw(a[1], 'load-balance', 1)) return true;
    if (C.kw(a[0], 'errdisable', 3)) return true;
    return false;
  });

  X.iface.push((dev, s, a, neg, io, targets, C) => {
    if (dev.type !== 'switch') return false;
    // interface Port-channel: команды относятся ко всем портам канала
    const pcs = targets.filter((r) => r.portChannel != null || /^Port-channel\d+$/.test(r.name || ''));
    if (pcs.length) {
      for (const r of pcs) {
        const g = r.portChannel != null ? r.portChannel : Number(String(r.name).replace(/\D+/g, ''));
        const idx = targets.indexOf(r);
        const members = [];
        dev.ports.forEach((p, i) => { if (p.chan && p.chan.group === g) members.push({ kind: 'port', port: i, sub: null }); });
        targets.splice(idx, 1, ...members);
      }
      if (!targets.length) { io.out('% В Port-channel пока нет портов: добавьте их командой channel-group в режиме интерфейса.'); return true; }
    }
    const ports = targets.filter((r) => r.kind === 'port' && r.sub == null).map((r) => r.port);
    if (C.kw(a[0], 'channel-group', 3)) {
      if (neg) {
        C.withMutate(io, () => { for (const i of ports) dev.ports[i].chan = null; });
        dev.net.refreshTopology();
        return true;
      }
      const g = Number(a[1]);
      if (!(Number.isInteger(g) && g >= 1 && g <= 64)) { C.incomplete(io); return true; }
      const mi = a.findIndex((x) => C.kw(x, 'mode', 1));
      const mode = mi > 0 ? ['on', 'active', 'passive', 'desirable', 'auto'].find((x) => C.kw(a[mi + 1], x, 1)) : null;
      if (!mode) { C.incomplete(io); return true; }
      const existing = dev.ports.find((p) => p.chan && p.chan.group === g);
      if (existing && PROTO[existing.chan.mode] !== PROTO[mode]) { io.out('% Command rejected (Port-channel' + g + ', ' + ports.map((i) => C.shortIf(dev.ports[i].name)).join(',') + '): Invalid etherchnl mode of the interface'); return true; }
      const fresh = !dev.channels || !dev.channels[g];
      C.withMutate(io, () => {
        if (!dev.channels) dev.channels = {};
        dev.channels[g] = true;
        for (const i of ports) {
          const p = dev.ports[i];
          p.chan = { group: g, mode };
          // настройки порт-канала копируются на новый порт
          if (existing && existing !== p) Object.assign(p, { cfgMode: existing.cfgMode, mode: existing.mode, vlan: existing.vlan, nativeVlan: existing.nativeVlan, allowed: existing.allowed });
        }
      });
      if (fresh) io.out('Creating a port-channel interface Port-channel ' + g);
      dev.net.refreshTopology();
      return true;
    }
    if (C.kw(a[0], 'switchport', 2) && C.kw(a[1], 'nonegotiate', 2)) {
      C.withMutate(io, () => { for (const i of ports) dev.ports[i].nonegotiate = !neg; });
      dev.net.refreshTopology();
      return true;
    }
    if (C.kw(a[0], 'spanning-tree', 2)) {
      if (C.kw(a[1], 'bpduguard', 1)) {
        const v = neg ? null : C.kw(a[2], 'enable', 1) ? true : C.kw(a[2], 'disable', 1) ? false : null;
        if (!neg && v == null) { C.incomplete(io); return true; }
        C.withMutate(io, () => { for (const i of ports) dev.ports[i].bpduguard = v; });
        dev.net.refreshTopology();
        return true;
      }
      if (C.kw(a[1], 'portfast', 1)) {
        C.withMutate(io, () => { for (const i of ports) dev.ports[i].portfast = !neg && !C.kw(a[2], 'disable', 1); });
        if (!neg) {
          io.out('%Warning: portfast should only be enabled on ports connected to a single');
          io.out(' host. Connecting hubs, concentrators, switches, bridges, etc... to this');
          io.out(' interface  when portfast is enabled, can cause temporary bridging loops.');
          io.out(' Use with CAUTION');
        }
        dev.net.refreshTopology();
        return true;
      }
      if (C.kw(a[1], 'cost', 1)) {
        const n = Number(a[2]);
        C.withMutate(io, () => { for (const i of ports) dev.ports[i].stpCost = neg || !(n > 0) ? null : n; });
        dev.net.refreshTopology();
        return true;
      }
      if (C.kw(a[1], 'guard', 1) || C.kw(a[1], 'bpdufilter', 5) || C.kw(a[1], 'port-priority', 2) || C.kw(a[1], 'link-type', 1)) return true;
      return false;
    }
    if (C.kw(a[0], 'switchport', 2) && C.kw(a[1], 'trunk', 2) && C.kw(a[2], 'encapsulation', 2)) return false;
    return false;
  });

  X.running.global.push((dev) => {
    if (dev.type !== 'switch') return [];
    const L = [];
    const v = dev.vtp;
    if (v) {
      if (v.domain) L.push('vtp domain ' + v.domain);
      if (v.mode !== 'server') L.push('vtp mode ' + v.mode);
      if (v.version !== 1) L.push('vtp version ' + v.version);
      if (L.length) L.push('!');
    }
    // интерфейсы Port-channel — перед физическими, как в IOS
    for (const g of Object.keys(dev.channels || {}).map(Number).sort((x, y) => x - y)) {
      L.push('interface Port-channel' + g);
      const m = dev.ports.find((p) => p.chan && p.chan.group === g);
      if (m) {
        const lines = NS.cliIos.portLinesFor ? NS.cliIos.portLinesFor(dev, m) : [];
        L.push(...lines.filter((x) => !/channel-group|spanning-tree|nonegotiate/.test(x)));
      }
      L.push('!');
    }
    return L;
  });

  X.stpRunning = (dev) => {
    const L = [];
    L.push('spanning-tree mode ' + (dev.stpMode === 'rapid-pvst' ? 'rapid-pvst' : 'pvst'));
    if (dev.portfastDefault) L.push('spanning-tree portfast default');
    if (dev.bpduguardDefault) L.push('spanning-tree portfast bpduguard default');
    if (dev.stpPriority !== 32768) L.push('spanning-tree vlan 1-4094 priority ' + dev.stpPriority);
    const byPrio = new Map();
    for (const [vv, pr] of Object.entries(dev.stpPrio || {})) { if (!byPrio.has(pr)) byPrio.set(pr, []); byPrio.get(pr).push(Number(vv)); }
    for (const [pr, list] of byPrio) L.push('spanning-tree vlan ' + compress(list) + ' priority ' + pr);
    L.push('!');
    return L;
  };

  function compress(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const out = [];
    for (let i = 0; i < a.length; i++) {
      let j = i;
      while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
      out.push(j > i ? a[i] + '-' + a[j] : String(a[i]));
      i = j;
    }
    return out.join(',');
  }

  const ROLE = { root: 'Root', designated: 'Desg', alternate: 'Altn', backup: 'Back' };

  function showStpVlan(dev, v, io, C) {
    const info = dev.stpInfoV && dev.stpInfoV[v];
    if (!info) return false;
    const pv = prio(dev, v);
    io.out('VLAN' + String(v).padStart(4, '0'));
    io.out('  Spanning tree enabled protocol ' + (dev.stpMode === 'rapid-pvst' ? 'rstp' : 'ieee'));
    io.out('  Root ID    Priority    ' + (info.rootPriority + v));
    io.out('             Address     ' + U.ciscoMac(info.rootMac));
    if (info.isRoot) io.out('             This bridge is the root');
    else {
      io.out('             Cost        ' + info.cost);
      const rp = dev.ports[info.rootPort];
      io.out('             Port        ' + (info.rootPort + 1) + '(' + (rp.bundle ? 'Port-channel' + rp.bundle.group : rp.name) + ')');
    }
    io.out('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec');
    io.out('');
    io.out('  Bridge ID  Priority    ' + (pv + v) + '  (priority ' + pv + ' sys-id-ext ' + v + ')');
    io.out('             Address     ' + U.ciscoMac(dev.baseMac));
    io.out('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec');
    io.out('             Aging Time  20');
    io.out('');
    io.out(C.pad('Interface', 17) + C.pad('Role', 5) + C.pad('Sts', 4) + C.pad('Cost', 10) + C.pad('Prio.Nbr', 9) + 'Type');
    io.out(C.pad('----------------', 17) + C.pad('----', 5) + C.pad('---', 4) + C.pad('---------', 10) + C.pad('--------', 9) + '--------------------------------');
    dev.ports.forEach((p, i) => {
      if (!p.stpRoleV || !p.stpRoleV[v]) return;
      if (p.bundle && p.bundle.primary !== i) return;
      const name = p.bundle ? 'Po' + p.bundle.group : C.shortIf(p.name);
      const edge = isPortfast(dev, p) && p.mode === 'access';
      io.out(C.pad(name, 17) + C.pad(ROLE[p.stpRoleV[v]], 5) + C.pad(p.stpV[v] === 'blocking' ? 'BLK' : 'FWD', 4) + C.pad(String(bundleCost(dev, i)), 10) + C.pad('128.' + (i + 1), 9) + 'P2p' + (edge ? ' Edge' : ''));
    });
    io.out('');
    return true;
  }

  X.show.push((dev, s, a, io, C) => {
    if (dev.type !== 'switch') return false;
    if (C.kw(a[0], 'spanning-tree', 2)) {
      if (C.kw(a[1], 'summary', 2)) {
        io.out('Switch is in ' + (dev.stpMode === 'rapid-pvst' ? 'rapid-pvst' : 'pvst') + ' mode');
        const vl = Object.keys(dev.stpInfoV || {}).map(Number).sort((x, y) => x - y);
        io.out('Root bridge for: ' + (vl.filter((v) => dev.stpInfoV[v].isRoot).map((v) => 'VLAN' + String(v).padStart(4, '0')).join(', ') || 'none'));
        io.out('PortFast Default                       is ' + (dev.portfastDefault ? 'enabled' : 'disabled'));
        io.out('PortFast BPDU Guard Default            is ' + (dev.bpduguardDefault ? 'enabled' : 'disabled'));
        io.out('');
        io.out('Name                   Blocking Listening Learning Forwarding STP Active');
        io.out('---------------------- -------- --------- -------- ---------- ----------');
        for (const v of vl) {
          let blk = 0;
          let fwd = 0;
          dev.ports.forEach((p, i) => { if (p.stpV && p.stpV[v] && !(p.bundle && p.bundle.primary !== i)) { if (p.stpV[v] === 'blocking') blk++; else fwd++; } });
          io.out(C.pad('VLAN' + String(v).padStart(4, '0'), 23) + C.pad(String(blk), 9) + C.pad('0', 10) + C.pad('0', 9) + C.pad(String(fwd), 11) + (blk + fwd));
        }
        return true;
      }
      if (C.kw(a[1], 'vlan', 1)) {
        const list = vlanList(a[2]);
        if (!list) { C.incomplete(io); return true; }
        for (const v of list) if (!showStpVlan(dev, v, io, C)) io.out('Spanning tree instance(s) for vlan ' + v + ' does not exist.');
        return true;
      }
      const vl = Object.keys(dev.stpInfoV || {}).map(Number).sort((x, y) => x - y);
      if (!vl.length) { io.out('No spanning tree instance exists.'); return true; }
      for (const v of vl) showStpVlan(dev, v, io, C);
      return true;
    }
    if (C.kw(a[0], 'vtp', 3)) {
      const c = vtpCfg(dev);
      if (C.kw(a[1], 'password', 1)) { io.out(c.password ? 'VTP Password: ' + c.password : 'The VTP password is not configured.'); return true; }
      if (C.kw(a[1], 'counters', 1)) {
        io.out('VTP statistics:');
        io.out('Summary advertisements received    : 0');
        io.out('Subset advertisements received     : 0');
        return true;
      }
      io.out('VTP Version capable             : 1 to 2');
      io.out('VTP version running             : ' + c.version);
      io.out('VTP Domain Name                 : ' + c.domain);
      io.out('VTP Pruning Mode                : Disabled');
      io.out('VTP Traps Generation            : Disabled');
      io.out('Device ID                       : ' + U.ciscoMac(dev.baseMac));
      io.out('Configuration last modified by ' + U.ipStr(c.updater || 0) + ' at ' + (c.updated ? c.updated.replace(/ UTC.*$/, '') : '0-0-00 00:00:00'));
      io.out(c.mode === 'server' ? 'Local updater ID is ' + U.ipStr((dev.ifaces.find((f) => f.kind === 'svi' && f.ip != null) || {}).ip || 0) + ' on interface Vl1 (lowest numbered VLAN interface found)' : '');
      io.out('');
      io.out('Feature VLAN :');
      io.out('--------------');
      io.out('VTP Operating Mode                : ' + c.mode[0].toUpperCase() + c.mode.slice(1));
      io.out('Maximum VLANs supported locally   : 255');
      io.out('Number of existing VLANs          : ' + (dev.vlans.size + 4));
      io.out('Configuration Revision            : ' + c.revision);
      io.out('MD5 digest                        : 0x' + ((c.revision * 2654435761) >>> 0).toString(16).toUpperCase().padStart(8, '0'));
      return true;
    }
    if (C.kw(a[0], 'etherchannel', 3)) {
      const groups = Object.keys(dev.channels || {}).map(Number).sort((x, y) => x - y);
      if (C.kw(a[1], 'summary', 1) || !a[1]) {
        io.out('Flags:  D - down        P - bundled in port-channel');
        io.out('        I - stand-alone s - suspended');
        io.out('        H - Hot-standby (LACP only)');
        io.out('        R - Layer3      S - Layer2');
        io.out('        U - in use      f - failed to allocate aggregator');
        io.out('        u - unsuitable for bundling');
        io.out('        w - waiting to be aggregated');
        io.out('        d - default port');
        io.out('');
        io.out('');
        io.out('Number of channel-groups in use: ' + groups.length);
        io.out('Number of aggregators:           ' + groups.length);
        io.out('');
        io.out('Group  Port-channel  Protocol    Ports');
        io.out('------+-------------+-----------+----------------------------------------------');
        for (const g of groups) {
          const rt = (dev.chanRt || {})[g] || { members: [], bundled: [], protocol: '-' };
          const up = rt.bundled.length > 0;
          const members = dev.ports.map((p, i) => ({ p, i })).filter((x) => x.p.chan && x.p.chan.group === g);
          const proto = members.length ? PROTO[members[0].p.chan.mode] : '-';
          io.out(C.pad(String(g), 7) + C.pad('Po' + g + '(S' + (up ? 'U' : 'D') + ')', 14) + C.pad(proto === 'on' ? '-' : proto, 12) + members.map((x) => C.shortIf(x.p.name) + '(' + (x.p.chanState || 'D') + ')').join(' '));
        }
        return true;
      }
      if (C.kw(a[1], 'port-channel', 1)) {
        for (const g of groups) {
          const rt = (dev.chanRt || {})[g] || { bundled: [] };
          io.out('                Channel-group listing: ');
          io.out('                ----------------------');
          io.out('');
          io.out('Group: ' + g);
          io.out('----------');
          io.out('                Port-channels in the group: ');
          io.out('                ---------------------------');
          io.out('');
          io.out('Port-channel: Po' + g);
          io.out('------------');
          io.out('');
          io.out('Age of the Port-channel   = 00d:00h:00m:00s');
          io.out('Logical slot/port   = 2/' + g + '           Number of ports = ' + rt.bundled.length);
          io.out('Port state          = ' + (rt.bundled.length ? 'Port-channel Ag-Inuse' : 'Port-channel Ag-Not-Inuse'));
          io.out('Protocol            = ' + (rt.protocol === 'on' ? '-' : rt.protocol || '-'));
          io.out('');
          for (const i of rt.bundled) io.out('  0     00     ' + C.pad(C.shortIf(dev.ports[i].name), 9) + 'Active     0');
        }
        return true;
      }
      C.invalid(io, a[1]);
      return true;
    }
    if (C.kw(a[0], 'lacp', 3) || C.kw(a[0], 'pagp', 3)) {
      const want = C.kw(a[0], 'lacp', 3) ? 'LACP' : 'PAgP';
      for (const [g, rt] of Object.entries(dev.chanRt || {})) {
        if (rt.protocol !== want) continue;
        io.out('Channel group ' + g + ' neighbors');
        for (const i of rt.members) {
          const pr = dev.net.peer(dev, i);
          if (!pr) continue;
          io.out('  ' + C.pad(C.shortIf(dev.ports[i].name), 9) + C.pad(pr.dev.name, 18) + C.pad(U.ciscoMac(pr.dev.baseMac || ''), 16) + C.shortIf(pr.dev.ports[pr.port].name));
        }
      }
      return true;
    }
    if (C.kw(a[0], 'interfaces', 2) && C.kw(a[1], 'switchport', 2)) {
      dev.ports.forEach((p, i) => {
        if (!NS.Network.isData(p) || p.radio) return;
        io.out('Name: ' + C.shortIf(p.name));
        io.out('Switchport: ' + (p.routed ? 'Disabled' : 'Enabled'));
        if (p.routed) { io.out(''); return; }
        const cfg = p.cfgMode || p.mode;
        io.out('Administrative Mode: ' + (cfg === 'trunk' ? 'trunk' : cfg === 'access' ? 'static access' : cfg));
        io.out('Operational Mode: ' + (!p.oper ? 'down' : p.mode === 'trunk' ? 'trunk' : 'static access') + (p.bundle ? ' (member of bundle Po' + p.bundle.group + ')' : ''));
        io.out('Administrative Trunking Encapsulation: dot1q');
        io.out('Operational Trunking Encapsulation: ' + (p.mode === 'trunk' ? 'dot1q' : 'native'));
        io.out('Negotiation of Trunking: ' + (p.nonegotiate || cfg === 'access' ? 'Off' : 'On'));
        io.out('Access Mode VLAN: ' + p.vlan + ' (' + (dev.vlans.get(p.vlan) || 'Inactive') + ')');
        io.out('Trunking Native Mode VLAN: ' + p.nativeVlan + ' (' + (dev.vlans.get(p.nativeVlan) || 'Inactive') + ')');
        io.out('Voice VLAN: ' + (p.voiceVlan != null ? p.voiceVlan : 'none'));
        io.out('Trunking VLANs Enabled: ' + (p.allowed === 'all' ? 'ALL' : p.allowed));
        io.out('');
        void i;
      });
      return true;
    }
    return false;
  });

  X.tree.config = (X.tree.config || []).concat(['spanning-tree mode rapid-pvst', 'spanning-tree mode pvst', 'spanning-tree vlan WORD priority WORD', 'spanning-tree vlan WORD root primary', 'spanning-tree vlan WORD root secondary',
    'spanning-tree portfast default', 'spanning-tree portfast bpduguard default', 'vtp mode server', 'vtp mode client', 'vtp mode transparent', 'vtp domain WORD', 'vtp password WORD', 'vtp version 2', 'interface port-channel WORD']);
  X.tree.if = (X.tree.if || []).concat(['channel-group WORD mode active', 'channel-group WORD mode passive', 'channel-group WORD mode on', 'channel-group WORD mode desirable', 'channel-group WORD mode auto',
    'switchport mode dynamic auto', 'switchport mode dynamic desirable', 'switchport nonegotiate', 'spanning-tree bpduguard enable', 'spanning-tree cost WORD']);
  X.tree.exec = (X.tree.exec || []).concat(['show spanning-tree vlan WORD', 'show spanning-tree summary', 'show vtp status', 'show vtp password', 'show etherchannel summary', 'show etherchannel port-channel',
    'show lacp neighbor', 'show pagp neighbor', 'show interfaces switchport']);

  NS.l2 = { dtpResolve, chanResolve, vtpSync, computePvst, prio, vtpCfg, isPortfast };
})(globalThis.NetLab = globalThis.NetLab || {});
