// Загружает ядро NetLab в Node (тот же порядок, что и в index.html).
const path = require('path');

const FILES = ['util', 'packets', 'models', 'network', 'stp', 'devices-l2', 'l3', 'tcp', 'acl', 'nat', 'ios', 'switch', 'services', 'host', 'router', 'wireless', 'routing', 'apps', 'cli-host', 'cli-ios', 'cli'];
for (const f of FILES) require(path.join(__dirname, '..', 'js', 'core', f + '.js'));

module.exports = globalThis.NetLab;
