// Подмножество Python для плат и программ ПК: классы, исключения, срезы, форматирование, методы строк, списков и словарей.
const test = require('node:test');
const { NL, assert } = require('./helpers');

const RT = NL.scriptRt;

async function runPy(code) {
  const logs = [];
  let err = null;
  await new Promise((resolve) => RT.run(code, { read: () => 0, write() {}, log: (t) => logs.push(t), error: (t) => { err = t; }, done: resolve }, 'python'));
  if (err) throw new Error(err + '\n--- JS ---\n' + RT.transform(RT.py2js(code)));
  return logs;
}

test('Python: классы — __init__, методы, наследование, super(), __str__, атрибуты класса, @staticmethod, isinstance', async () => {
  const logs = await runPy([
    'from time import *',
    'class Sensor:',
    '    """Датчик с историей значений."""',
    '    count = 0',
    '    def __init__(self, name, pin=0):',
    '        self.name = name',
    '        self.pin = pin',
    '        self.values = []',
    '        Sensor.count += 1',
    '    def add(self, v):',
    '        sleep(0.001)',
    '        self.values.append(v)',
    '        return len(self.values)',
    '    def avg(self):',
    '        return sum(self.values) / len(self.values) if self.values else 0',
    '    def __str__(self):',
    '        return f"{self.name}@{self.pin}: {self.avg():.1f}"',
    '    @staticmethod',
    '    def unit():',
    '        return "C"',
    '',
    'class Thermo(Sensor):',
    '    def __init__(self, name):',
    '        super().__init__(name, 3)',
    '        self.kind = "thermo"',
    '    def avg(self):',
    '        base = super().avg()',
    '        return base + 0.5',
    '',
    's = Sensor("light")',
    's.add(10)',
    'n = s.add(20)',
    't = Thermo("t1")',
    't.add(20)',
    'print(n, s.avg(), s)',
    'print(t, t.kind, isinstance(t, Sensor), isinstance(s, Thermo), isinstance(3, int), isinstance("x", str))',
    'print(str(t), Sensor.unit(), Sensor.count)',
  ].join('\n'));
  assert.deepEqual(logs, ['2 15 light@0: 15.0', 't1@3: 20.5 thermo true false true true', 't1@3: 20.5 C 2']);
});

test('Python: исключения — raise, несколько except, свои исключения, finally, assert', async () => {
  const logs = await runPy([
    'class NetError(Exception):',
    '    pass',
    '',
    'def check(x):',
    '    if x < 0:',
    '        raise ValueError("отрицательное: " + str(x))',
    '    if x == 0:',
    '        raise NetError("нет связи")',
    '    return x * 2',
    '',
    'for v in [5, -1, 0]:',
    '    try:',
    '        print("ok", check(v))',
    '    except ValueError as e:',
    '        print("value", e)',
    '    except (NetError, KeyError) as e:',
    '        print("net", e)',
    '    finally:',
    '        print("done", v)',
    '',
    'try:',
    '    assert 1 + 1 == 3, "математика"',
    'except AssertionError as e:',
    '    print("assert", e)',
    'try:',
    '    d = {}',
    '    d.pop("x")',
    'except:',
    '    print("пусто")',
  ].join('\n'));
  assert.deepEqual(logs, ['ok 10', 'done 5', 'value отрицательное: -1', 'done -1', 'net нет связи', 'done 0', 'assert математика', 'пусто']);
});

test('Python: срезы, форматирование (%, format, f-строки), строки, списки, словари, встроенные функции, lambda', async () => {
  const logs = await runPy([
    'a = [1, 2, 3, 4, 5]',
    's = "Hello, NetLab"',
    'print(a[1:3], a[:2], a[-2:], a[::-1], s[7:], s[::2])',
    'print("%s has %d ports, load %.1f%%" % ("R1", 4, 12.345))',
    'print("{} -> {name}: {0}".format("x", name="R2"), "{:>6}|{:<4}|{:^5}|{:05.1f}".format("ab", "c", "d", 3.14159))',
    'x = 7',
    'print(f"{x:03d} {x/3:.2f} {s!r}" if False else f"{x:03d} {x/3:.2f} {1234567:,}")',
    'print(s.split(", "), " a b  c ".split(), "-".join(["a", "b"]), s.startswith("Hell"), s.endswith(("x", "Lab")))',
    'print(s.replace("l", "L"), s.find("Net"), s.count("l"), "  pad ".strip(), "xxhixx".strip("x"), "42".isdigit(), "7".zfill(3), "hello world".title())',
    'b = [3, 1, 2]',
    'b.sort()',
    'b.extend([9, 8])',
    'b.insert(0, 0)',
    'b.remove(9)',
    'print(b, b.index(2), b.count(1), b.pop(), b.pop(0), b)',
    'd = {"a": 1}',
    'd.update({"b": 2})',
    'print(d.get("a"), d.get("z", "нет"), d.setdefault("c", 3), sorted(d.keys()), d.pop("a"), len(d))',
    'names = ["bb", "a", "ccc"]',
    'print(sorted(names, key=len), sorted(names, reverse=True), sum([1, 2, 3]), any([0, 1]), all([1, 0]), list(zip([1, 2], ["x", "y"])))',
    'sq = lambda v: v * v',
    'print(list(map(sq, [1, 2, 3])), list(filter(lambda v: v % 2, range(6))), max(a), min(3, 1), abs(-4), divmod(17, 5), hex(255), chr(65), ord("A"))',
    'print("-" * 5, [0] * 3, 2 * "ab")',
    'print(round(2.567, 2), int("12") + 1, float("1.5"), bool(0), str(10) + "!")',
  ].join('\n'));
  assert.deepEqual(logs, [
    '[2,3] [1,2] [4,5] [5,4,3,2,1] NetLab Hlo eLb',
    'R1 has 4 ports, load 12.3%',
    'x -> R2: x     ab|c   |  d  |003.1',
    '007 2.33 1,234,567',
    '["Hello","NetLab"] ["a","b","c"] a-b true true',
    'HeLLo, NetLab 7 2 pad hi true 007 Hello World',
    '[1,2,3] 2 1 8 0 [1,2,3]',
    '1 нет 3 ["a","b","c"] 1 2',
    '["a","bb","ccc"] ["ccc","bb","a"] 6 true false [[1,"x"],[2,"y"]]',
    '[1,4,9] [1,3,5] 5 1 4 [3,2] 0xff A 65',
    '----- [0,0,0] abab',
    '2.57 13 1.5 false 10!',
  ]);
});

test('Python: плата — класс-обёртка над пином и docstring в функции', async () => {
  const writes = [];
  await new Promise((resolve) => RT.run([
    'from gpio import *',
    'class Led:',
    '    def __init__(self, pin):',
    '        self.pin = pin',
    '        pinMode(pin, OUT)',
    '    def on(self):',
    '        """Включить."""',
    '        digitalWrite(self.pin, HIGH)',
    '',
    'def main():',
    "    '''Точка входа.'''",
    '    led = Led(2)',
    '    led.on()',
    '',
    'main()',
  ].join('\n'), { read: () => 0, write: (p, v) => writes.push([p, v]), log() {}, error: (t) => writes.push(['ERR', t]), done: resolve }, 'python'));
  assert.deepEqual(writes, [['D2', 1023]]);
});

test('Python: имена функций внутри строк не получают await', async () => {
  const logs = await runPy('def Led(p):\n    return p\nprint("Led(%d)" % Led(3), "ping(x)", "sleep(1)")\n');
  assert.deepEqual(logs, ['Led(3) ping(x) sleep(1)']);
});
