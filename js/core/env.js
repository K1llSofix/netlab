/* NetLab — среда для IoT (как вкладка Environment в Packet Tracer):
 *  время суток (день и ночь), температура на улице, влажность, CO₂, пожар, люди в помещении;
 *  из них и из состояния умных устройств считаются условия в помещении:
 *    свет — солнце (жалюзи его приглушают) + лампы; температура — улица через окно, обогреватель, кондиционер, вентилятор;
 *    влажность — полив, обогреватель; CO₂ — люди и проветривание; дым — пожар.
 *  Датчики (температура, свет, влажность, CO₂, дым) сами получают значения и сообщают их IoT-серверу — правила «если… то…»
 *  срабатывают по-настоящему. Новые устройства: датчики освещённости, влажности и CO₂, обогреватель, кондиционер, жалюзи, полив. */
(function (NS) {
  'use strict';

  const IOT = NS.iot;
  const M = NS.models;
  const onOff = (a, b) => ({ type: 'bool', labels: [a, b] });

  const NEW = {
    light: { title: 'Датчик освещённости', model: 'Light Sensor', props: { value: { type: 'number', min: 0, max: 100, unit: '%', sensor: true, title: 'Освещённость' } }, init: { value: 50 } },
    humidity: { title: 'Датчик влажности', model: 'Humidity Monitor', props: { value: { type: 'number', min: 0, max: 100, unit: '%', sensor: true, title: 'Влажность' } }, init: { value: 45 } },
    co2: { title: 'Датчик CO₂', model: 'CO2 Detector', props: { value: { type: 'number', min: 300, max: 5000, unit: 'ppm', sensor: true, title: 'CO₂' } }, init: { value: 420 } },
    heater: { title: 'Обогреватель', model: 'Heater', props: { on: Object.assign(onOff('Выкл', 'Греет'), { control: true, title: 'Обогрев' }) }, init: { on: false } },
    ac: { title: 'Кондиционер', model: 'Air Conditioner', props: { on: Object.assign(onOff('Выкл', 'Охлаждает'), { control: true, title: 'Охлаждение' }) }, init: { on: false } },
    blinds: { title: 'Жалюзи', model: 'Smart Blinds', props: { open: Object.assign(onOff('Закрыты', 'Открыты'), { control: true, title: 'Жалюзи' }) }, init: { open: true } },
    sprinkler: { title: 'Полив газона', model: 'Lawn Sprinkler', props: { on: Object.assign(onOff('Выкл', 'Поливает'), { control: true, title: 'Полив' }) }, init: { on: false } },
  };
  for (const [kind, k] of Object.entries(NEW)) {
    IOT.KINDS[kind] = { title: k.title, model: k.model, props: k.props };
    IOT.INIT[kind] = k.init;
    M.MODELS[k.model] = { type: 'iot', thing: kind, title: k.title + ' (' + k.model + ')', ports: [], slots: IOT.HOST_NIC.map((s) => Object.assign({}, s)), attrs: { MTBF: 50000, cost: 90, 'power source': 0, 'rack units': 0, wattage: 5 } };
  }

  const STEP = 100; // 1 с модельного времени

  function def() {
    return { on: false, run: true, speed: 1, clock: 12 * 60, outTemp: 15, humidity: 45, co2: 420, fire: false, people: false, cur: null };
  }
  const envOf = (net) => net.env || (net.env = def());

  /** Солнечный свет, 0–100: восход 6:00, закат 18:00. */
  function daylight(clock) {
    const m = ((clock % 1440) + 1440) % 1440;
    if (m < 360 || m > 1080) return 0;
    return Math.round(Math.sin(((m - 360) / 720) * Math.PI) * 100);
  }

  /** Целевые условия в помещении по среде и устройствам. */
  function targets(net) {
    const e = envOf(net);
    const things = [...net.devices.values()].filter((d) => d.type === 'iot' && d.power && d.thing);
    const st = (kind) => things.filter((d) => d.thing.kind === kind).map((d) => d.thing.state);
    const any = (kind, prop) => st(kind).some((s) => !!s[prop]);
    const sun = daylight(e.clock);
    const blinds = st('blinds');
    const sunIn = blinds.length && blinds.every((s) => !s.open) ? sun * 0.15 : sun;
    const lamps = st('lamp').reduce((x, s) => x + (Number(s.level) || 0) * 25, 0);
    const window = any('window', 'open') || any('door', 'open');
    const fan = st('fan').reduce((x, s) => x + (Number(s.speed) || 0), 0);
    let temp = 21 + (e.outTemp - 21) * (window ? 0.6 : 0.2) + sun * 0.02;
    if (any('heater', 'on')) temp += 7;
    if (any('ac', 'on')) temp -= 7;
    temp -= fan * 0.6;
    if (e.fire) temp += 20;
    let hum = e.humidity + (any('sprinkler', 'on') ? 30 : 0) - (any('heater', 'on') ? 8 : 0);
    let co2 = e.co2 + (e.people ? 450 : 0) - (window ? 250 : 0) - fan * 80;
    return {
      light: Math.min(100, Math.round(sunIn + lamps)),
      temp: Math.round(temp * 10) / 10,
      humidity: Math.max(5, Math.min(100, Math.round(hum))),
      co2: Math.max(400, Math.round(co2)),
      smoke: e.fire ? 100 : 0,
      window,
      fan,
    };
  }

  /** Один шаг: плавно к целевым значениям, затем показания датчиков. */
  function step(net) {
    const e = envOf(net);
    if (!e.on) return;
    if (e.run) e.clock = (e.clock + Math.max(0, Number(e.speed) || 0)) % 1440;
    const t = targets(net);
    const c = e.cur || (e.cur = { temp: t.temp, humidity: t.humidity, co2: t.co2, smoke: t.smoke, light: t.light });
    const toward = (a, b, k) => Math.round((a + (b - a) * k) * 10) / 10;
    c.temp = toward(c.temp, t.temp, 0.12);
    c.humidity = toward(c.humidity, t.humidity, 0.15);
    c.co2 = Math.round(toward(c.co2, t.co2, 0.2));
    c.smoke = Math.round(t.smoke > c.smoke ? toward(c.smoke, t.smoke, 0.35) : toward(c.smoke, t.smoke, t.window || t.fan ? 0.3 : 0.1));
    c.light = t.light;
    for (const d of net.devices.values()) {
      if (d.type !== 'iot' || !d.power || !d.thing) continue;
      const k = d.thing.kind;
      const set = (prop, v, min) => { const old = Number(d.thing.state[prop]); if (!Number.isFinite(old) || Math.abs(old - v) >= min) d.thingSet(prop, v, 'env'); };
      if (k === 'temp') set('value', c.temp, 0.5);
      else if (k === 'light') set('value', c.light, 2);
      else if (k === 'humidity') set('value', c.humidity, 1);
      else if (k === 'co2') set('value', c.co2, 25);
      else if (k === 'smoke') set('level', c.smoke, 3);
    }
  }

  function schedule(net) {
    if (net.envTimer) { net.envTimer.cancel(); net.envTimer = null; }
    if (!envOf(net).on) return;
    const tick = () => { net.envTimer = net.timer(null, STEP, tick); step(net); };
    net.envTimer = net.timer(null, STEP, tick);
  }

  NS.netExt.push({
    key: 'env',
    save(net) {
      const e = net.env;
      if (!e || !e.on) return null;
      return { on: true, run: e.run, speed: e.speed, clock: e.clock, outTemp: e.outTemp, humidity: e.humidity, co2: e.co2, fire: e.fire, people: e.people };
    },
    load(net, c) {
      net.env = Object.assign(def(), c || {});
      net.env.cur = null;
      schedule(net);
    },
  });

  const clockText = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(Math.floor(m % 60)).padStart(2, '0');

  NS.env = {
    get: envOf,
    /** Изменить параметры среды (on, run, speed, clock, outTemp, humidity, co2, fire, people). */
    set(net, patch) {
      const e = envOf(net);
      const wasOn = e.on;
      for (const k of ['on', 'run', 'fire', 'people']) if (k in patch) e[k] = !!patch[k];
      if ('speed' in patch) e.speed = Math.max(0, Math.min(60, Number(patch.speed) || 0));
      if ('clock' in patch) e.clock = ((Math.round(Number(patch.clock)) % 1440) + 1440) % 1440;
      if ('outTemp' in patch) e.outTemp = Math.max(-40, Math.min(50, Number(patch.outTemp)));
      if ('humidity' in patch) e.humidity = Math.max(5, Math.min(100, Number(patch.humidity)));
      if ('co2' in patch) e.co2 = Math.max(400, Math.min(5000, Number(patch.co2)));
      if (e.on !== wasOn) { e.cur = null; schedule(net); if (e.on) step(net); }
    },
    targets,
    daylight,
    clockText,
    step,
    NEW,
  };
})(globalThis.NetLab = globalThis.NetLab || {});
