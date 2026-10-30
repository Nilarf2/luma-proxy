const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { importLink, validateHotkeys, networkSignature, registerIntegrations } = require('../electron/integrations.cjs');
test('deep links accept only explicit subscription imports without embedded credentials', () => {
  const link = importLink('luma://install-config?url=https%3A%2F%2Fexample.test%2Fsubscribe%3Ftoken%3Dprivate&name=Fixture'); assert.equal(link.host, 'example.test'); assert.equal(link.name, 'Fixture'); assert.match(link.url, /token=private/); assert.equal(importLink('https://example.test'), null); assert.equal(importLink('luma://unsupported'), null); assert.throws(() => importLink('clash://install-config?url=file%3A%2F%2F%2Fetc%2Fpasswd'), /订阅地址/); assert.throws(() => importLink('luma://import?url=https%3A%2F%2Fa%3Ab%40example.test'), /订阅地址/);
});
test('global hotkeys require modifiers and cannot conflict with each other', () => {
  assert.deepEqual(validateHotkeys({ toggle: 'Ctrl+Shift+L', show: '', tun: 'Alt+T' }), { toggle: 'Ctrl+Shift+L', show: '', tun: 'Alt+T' }); assert.throws(() => validateHotkeys({ toggle: 'L' }), /组合键/); assert.throws(() => validateHotkeys({ toggle: 'Ctrl+L', show: 'ctrl+l' }), /重复/); assert.throws(() => validateHotkeys({ show: 'Ctrl+L\n' }), /组合键/);
});
test('network change detection ignores loopback and own TUN adapters', () => {
  const interfaces = { Ethernet: [{ address: '10.0.0.2', netmask: '255.255.255.0', family: 'IPv4', internal: false }], Luma: [{ address: '198.18.0.1', family: 'IPv4', internal: false }], loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }; const signature = networkSignature(interfaces); interfaces.Luma[0].address = '198.18.0.9'; assert.equal(networkSignature(interfaces), signature); interfaces.Ethernet[0].address = '10.0.0.3'; assert.notEqual(networkSignature(interfaces), signature);
});
test('failed shortcut registration restores previous bindings and dispose removes them', async () => {
  const app = Object.assign(new EventEmitter(), { isPackaged: false }); const bound = new Map(); const handlers = new Map(); const globalShortcut = { register: (key, fn) => { if (key === 'Alt+X') return false; bound.set(key, fn); return true; }, unregister: key => bound.delete(key) }; const integration = registerIntegrations({ app, dialog: {}, shell: {}, globalShortcut, Notification: { isSupported: () => false }, getWindow: () => null, store: { data: { hotkeys: {} } }, engine: { ready: false }, proxy: {}, exclusive: fn => fn(), connect: () => {}, disconnect: () => {}, publish: () => {}, handle: (name, fn) => handlers.set(name, fn) }); try { await new Promise(resolve => setImmediate(resolve)); await integration.applySettings({ hotkeys: { show: 'Ctrl+Shift+M' } }); assert.equal(bound.has('Ctrl+Shift+M'), true); await assert.rejects(integration.applySettings({ hotkeys: { toggle: 'Ctrl+L', show: 'Alt+X' } }), /占用/); assert.equal(bound.has('Ctrl+L'), false); assert.equal(bound.has('Ctrl+Shift+M'), true); } finally { integration.dispose(); } assert.equal(bound.size, 0); assert.equal(app.listenerCount('second-instance'), 0);
});
