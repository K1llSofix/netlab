// Загружает ядро NetLab в Node (тот же порядок, что и в index.html).
const path = require('path');

const FILES = ['util', 'packets', 'models', 'network', 'stp', 'devices-l2', 'l3', 'tcp', 'acl', 'nat', 'ios', 'switch', 'services', 'host', 'router', 'wireless', 'ext', 'routing', 'routing2', 'apps', 'cli-host', 'cli-ios', 'cli', 'ipv6', 'snmp', 'netflow', 'vpn', 'pppoe', 'dialup', 'voip', 'voip2', 'bluetooth', 'script-rt', 'iot', 'iox', 'mgmt', 'l2ext', 'fhrp', 'routing2-cli', 'routing6', 'aaa', 'l2sec', 'zbf', 'asa', 'wlc', 'wan', 'pdu', 'physical', 'netctrl', 'multiuser', 'activity'];
for (const f of FILES) require(path.join(__dirname, '..', 'js', 'core', f + '.js'));

module.exports = globalThis.NetLab;
