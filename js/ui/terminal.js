/* NetLab UI — терминал: консоль IOS (вкладка CLI), командная строка ПК и программа «Терминал»
 * (консоль маршрутизатора/коммутатора через консольный кабель). Пароли не отображаются,
 * «?» в IOS показывает подсказку сразу, Tab дописывает команду. */
(function (NS) {
  'use strict';

  const UI = NS.ui;
  const h = UI.h;
  const MAX_LINES = 3000;

  class Terminal {
    /**
     * opts.kind: 'cmd' — командная строка устройства, 'cli' — консоль IOS самого устройства,
     * 'console' — программа «Терминал» на ПК (сеанс на устройстве за консольным кабелем).
     */
    constructor(app, devId, opts) {
      this.app = app;
      this.devId = devId;
      this.kind = (opts && opts.kind) || 'cmd';
      this.session = null;
      this.targetId = null;
      this.history = [];
      this.hIdx = 0;
      this.busy = false;
      this.job = null;
      this.io = null;
      this.lastLine = null;

      this.out = h('div', { class: 'term-out' });
      this.promptEl = h('span', { class: 'prompt' });
      this.input = h('input', { spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Команда' });
      this.inRow = h('div', { class: 'term-in' }, this.promptEl, this.input);
      this.el = h('div', { class: 'term' }, this.out, this.inRow);

      this.el.addEventListener('mouseup', () => {
        if (!window.getSelection().toString()) this.focus();
      });
      this.input.addEventListener('keydown', (e) => this.onKey(e));
      this.attachGlobalKeys();
      this.intro();
      this.renderPrompt();
    }

    get host() { return this.app.net.getDevice(this.devId); }

    /** Устройство, на котором выполняются команды (для «Терминала» — то, что за консольным кабелем). */
    target() {
      const host = this.host;
      if (!host || this.kind !== 'console') return host;
      const peer = this.app.net.consolePeer(host);
      return peer && NS.cli.isIos(peer) ? peer : null;
    }

    /** Сеанс для текущего устройства; при смене устройства за кабелем — новый. */
    ensureSession() {
      const dev = this.target();
      if (!dev) return null;
      if (!this.session || this.targetId !== dev.id) {
        const first = this.targetId == null;
        this.targetId = dev.id;
        this.session = NS.cli.createSession(dev, { via: this.kind === 'cmd' ? 'local' : 'console' });
        if (this.kind === 'console' && !first) this.print('— Консольный кабель теперь ведёт к ' + dev.name + ' —', 'hint');
      }
      return dev;
    }

    intro() {
      const dev = this.ensureSession();
      const host = this.host;
      if (this.kind === 'console') {
        this.print('Терминал ' + (host ? host.name : '') + ' — COM1: 9600 бод, 8 бит, без чётности, 1 стоп-бит.', 'hint');
        if (!dev) {
          this.print('Нет консольного подключения. Соедините порт RS 232 этого компьютера с портом Console маршрутизатора или коммутатора консольным кабелем (голубой).', 'hint');
          return;
        }
        this.print('Подключено к ' + dev.name + '.', 'hint');
        this.print('');
        this.print('Press RETURN to get started.');
        return;
      }
      if (!dev) return;
      if (this.kind === 'cli' && dev.type === 'asa') {
        this.print(dev.name + ' — консоль Cisco ASA (NetLab).', 'hint');
        this.print('Справка: ?  Команды: en, conf t, interface g1/1, nameif, show nameif, show xlate, show conn.', 'hint');
        this.print('');
        this.print('Type help or \'?\' for a list of available commands.');
        return;
      }
      if (this.kind === 'cli') {
        this.print(dev.name + ' — консоль Cisco IOS (NetLab).', 'hint');
        this.print('Справка: ?  Дополнение: Tab.  Сокращения: en, conf t, int g0/0, sh ip int br.', 'hint');
        this.print('');
        this.print('Press RETURN to get started.');
        return;
      }
      this.print('NetLab: командная строка ' + dev.name);
      this.print('Введите help для списка команд.', 'hint');
      this.print('');
    }

    focus() { if (!this.busy) this.input.focus({ preventScroll: true }); }

    print(text, cls) {
      if (text === '' && this.lastLine && this.lastLine.dataset.inline === '1') {
        // пустой вывод после write() просто завершает строку (как «!!!!!» у ping в IOS)
        this.lastLine.dataset.inline = '0';
        return;
      }
      const line = h('div', { class: cls || null }, text === '' ? '​' : text);
      this.out.appendChild(line);
      this.lastLine = line;
      while (this.out.childNodes.length > MAX_LINES) this.out.removeChild(this.out.firstChild);
      this.scroll();
    }

    write(text) {
      if (!this.lastLine || this.lastLine.dataset.inline !== '1') {
        this.lastLine = h('div', { 'data-inline': '1' });
        this.out.appendChild(this.lastLine);
      }
      this.lastLine.textContent += text;
      this.scroll();
    }

    scroll() { this.out.scrollTop = this.out.scrollHeight; }

    clearScreen() { UI.clear(this.out); this.lastLine = null; }

    prompt() {
      const dev = this.target();
      if (!dev || !this.session) return this.kind === 'console' ? '' : '';
      return NS.cli.prompt(dev, this.session);
    }

    masked() { return !!this.session && NS.cli.isMasked(this.session); }

    renderPrompt() {
      this.promptEl.textContent = this.prompt();
      this.inRow.classList.toggle('busy', this.busy);
      const pw = this.masked();
      if ((this.input.type === 'password') !== pw) this.input.type = pw ? 'password' : 'text';
    }

    /** IOS: подсказка «?» выводится сразу, без Enter (как в настоящей консоли). */
    iosHelpNow() {
      const dev = this.target();
      const s = this.session;
      if (!dev || !s || !NS.cli.isIos(dev) || s.pending || s.remote || s.stage || !dev.power) return false;
      const v = this.input.value;
      this.print(this.prompt() + v + '?', 'cmd');
      const io = { out: (t, cls) => this.print(t, cls), write: (t) => this.write(t), done() {}, clear() {}, mutate: (fn) => fn() };
      if (dev.type === 'asa' && NS.cliAsa) NS.cliAsa.exec(dev, s, v + '?', io);
      else NS.cliIos.help(dev, s, v + '?', io);
      return true;
    }

    onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const line = this.input.value;
        this.input.value = '';
        this.run(line);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const dev = this.target();
        if (dev && this.session && !this.masked()) this.input.value = NS.cli.complete(dev, this.session, this.input.value);
      } else if (e.key === '?' && !this.masked()) {
        if (this.iosHelpNow()) e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.hIdx > 0) { this.hIdx--; this.input.value = this.history[this.hIdx] || ''; }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.hIdx < this.history.length) { this.hIdx++; this.input.value = this.history[this.hIdx] || ''; }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.input.value = '';
      } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        if (this.input.selectionStart !== this.input.selectionEnd) return; // копирование выделенного
        e.preventDefault();
        this.print(this.prompt() + (this.masked() ? '' : this.input.value) + '^C', 'cmd');
        this.input.value = '';
        if (this.session && this.session.pending) { this.session.pending = null; this.renderPrompt(); }
      } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        this.clearScreen();
      } else if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
        const s = this.session;
        const dev = this.target();
        if (!s || !dev || !NS.cli.isIos(dev) || s.remote || s.pending) return;
        e.preventDefault();
        e.stopPropagation();
        if (s.mode !== 'user' && s.mode !== 'exec') {
          this.print(this.prompt() + '^Z', 'cmd');
          NS.cli.exec(dev, s, 'end', this.simpleIo());
          this.renderPrompt();
        }
      }
    }

    simpleIo() {
      return { out: (t, cls) => this.print(t, cls), write: (t) => this.write(t), clear: () => this.clearScreen(), done: () => {}, mutate: (fn) => this.app.mutate(fn) };
    }

    /** Ctrl+C работает и когда поле ввода скрыто — слушаем на уровне терминала. */
    attachGlobalKeys() {
      this.el.addEventListener('keydown', (e) => {
        if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && this.busy) {
          e.preventDefault();
          this.abort();
        }
      });
      this.el.tabIndex = -1;
    }

    run(line) {
      const dev = this.ensureSession();
      if (!dev) {
        this.print(line, 'cmd');
        if (this.kind === 'console') this.print('Нет консольного подключения (нужен консольный кабель: RS 232 → Console).', 'hint');
        return;
      }
      const masked = this.masked();
      this.print(NS.cli.prompt(dev, this.session) + (masked ? '' : line), 'cmd');
      if (line.trim() && !masked) {
        if (this.history[this.history.length - 1] !== line) this.history.push(line);
        if (this.history.length > 100) this.history.shift();
      }
      this.hIdx = this.history.length;
      this.busy = true;
      this.renderPrompt();
      const io = {
        out: (t, cls) => { if (this.io === io) this.print(t, cls); },
        write: (t) => { if (this.io === io) this.write(t); },
        clear: () => { if (this.io === io) this.clearScreen(); },
        done: () => { if (this.io === io) this.finish(); },
        mutate: (fn) => this.app.mutate(fn),
      };
      this.io = io;
      const job = NS.cli.exec(dev, this.session, line, io);
      if (this.io !== io) return;
      if (!job || job.done) this.finish();
      else {
        this.job = job;
        this.el.focus({ preventScroll: true });
      }
    }

    /** Выполнить команду программно (например, «Telnet/SSH Client» запускает telnet). */
    runCommand(line) {
      if (this.busy) return;
      this.run(line);
    }

    finish() {
      if (!this.busy) return;
      this.busy = false;
      this.job = null;
      this.io = null;
      this.renderPrompt();
      const ae = document.activeElement;
      if (this.el.isConnected && (!ae || ae === document.body || this.el.contains(ae))) this.focus();
    }

    abort() {
      if (this.job && !this.job.done) this.job.cancel('Прервано пользователем');
      if (this.busy) {
        this.io = null;
        this.busy = false;
        this.job = null;
        this.renderPrompt();
        this.focus();
      }
    }

    /** Устройство выключили/включили или перезагрузили: сеанс начинается заново. */
    deviceRestarted(id) {
      if (this.targetId !== id && this.devId !== id) return;
      if (this.busy) {
        if (this.job && !this.job.done) this.job.cancel('Устройство перезапущено');
        this.io = null;
        this.busy = false;
        this.job = null;
      }
      this.session = null;
      this.targetId = null;
      const dev = this.ensureSession();
      if (dev && this.kind !== 'cmd') {
        this.print('');
        if (!dev.power) this.print('[' + dev.name + ': питание выключено]', 'hint');
        else {
          this.print('Загрузка ' + dev.model + '… ' + (dev.nvram ? 'startup-config загружен из NVRAM [OK]' : 'startup-config не найден — заводские настройки'), 'hint');
          this.print('');
          this.print('Press RETURN to get started.');
        }
      }
      this.renderPrompt();
    }

    /** Сеть заменена (отмена, загрузка файла): незавершённая команда прерывается. */
    networkReplaced() {
      if (this.busy) {
        this.print('^C  (сеть перезагружена)', 'hint');
        this.io = null;
        this.busy = false;
        this.job = null;
      }
      const s = this.session;
      if (s) {
        // режимы с привязкой к объектам старой сети (интерфейс, ACL, пул) — вернуться в config
        if (s.ifs || s.acl || s.pool || s.vlan != null || s.line) {
          if (s.mode !== 'user' && s.mode !== 'exec') s.mode = 'config';
          s.ifs = null; s.acl = null; s.pool = null; s.vlan = null; s.line = null;
        }
        s.remote = null;
        s.pending = null;
      }
      this.renderPrompt();
    }
  }

  UI.Terminal = Terminal;
})(globalThis.NetLab = globalThis.NetLab || {});
