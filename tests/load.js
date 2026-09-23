// Загружает ядро NetLab в Node (тот же порядок, что и в index.html).
const path = require('path');

const FILES = ['util', 'packets', 'models', 'network', 'stp', 'devices-l2', 'l3', 'tcp', 'acl', 'nat', 'ios', 'switch', 'services', 'host', 'router', 'wireless', 'ext', 'routing', 'apps', 'cli-host', 'cli-ios', 'cli', 'ipv6', 'snmp', 'netflow', 'vpn', 'pppoe', 'dialup', 'voip', 'bluetooth', 'script-rt', 'iot', 'iox'];
for (const f of FILES) require(path.join(__dirname, '..', 'js', 'core', f + '.js'));

module.exports = globalThis.NetLab;
