/* NetLab — общий вход в командную строку: консоль IOS (маршрутизатор, коммутатор) или
 * командная строка ПК. Здесь же — ожидание ответа (пароли, подтверждения) и удалённые сеансы. */
(function (NS) {
  'use strict';

  function isIos(dev) { return !!dev.ios && dev.type !== 'wrouter'; }

  NS.cli = {
    isIos,

    createSession(dev, opts) {
      if (isIos(dev)) return NS.cliIos.createSession(dev, opts);
      return { mode: 'host', pending: null, remote: null, history: [], stage: null };
    },

    prompt(dev, s) {
      if (isIos(dev)) return NS.cliIos.prompt(dev, s);
      if (s.remote) return s.remote.prompt || '';
      if (s.pending) return s.pending.prompt;
      return 'C:\\>';
    },

    /** Нужно ли скрывать вводимые символы (пароль). */
    isMasked(s) {
      if (s.remote) return !!s.remote.mask;
      return !!(s.pending && s.pending.mask);
    },

    /** Выполнить строку. Возвращает job (асинхронная команда — ждать io.done()) или null. */
    exec(dev, session, line, io) {
      const safeIo = {
        out: io.out,
        write: io.write || ((t) => io.out(t)),
        clear: io.clear || (() => {}),
        done: io.done || (() => {}),
        mutate: io.mutate || ((fn) => fn()),
      };
      if (!dev.power) { safeIo.out('Устройство выключено.'); return null; }
      try {
        if (session.remote) return NS.cliIos.remoteLine(dev, session, line, safeIo);
        if (session.pending) {
          const p = session.pending;
          session.pending = null;
          return p.handle(line) || null;
        }
        if (isIos(dev)) return NS.cliIos.exec(dev, session, line, safeIo);
        return NS.cliHost.exec(dev, session, line, safeIo);
      } catch (e) {
        console.error(e);
        safeIo.out('% Внутренняя ошибка: ' + e.message);
        return null;
      }
    },

    /** Tab — дописать команду. */
    complete(dev, s, line) {
      if (s.remote || s.pending) return line;
      return isIos(dev) ? NS.cliIos.complete(dev, s, line) : NS.cliHost.complete(line);
    },

    runningConfig(dev) { return NS.cliIos.runningConfig(dev); },
    parseIfName(dev, s) { return NS.cliIos.parseIfName(dev, s); },
  };
})(globalThis.NetLab = globalThis.NetLab || {});
