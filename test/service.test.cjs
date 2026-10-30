const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ServiceClient, validateRequest, psLiteral } = require('../electron/service.cjs');
const sid = 'S-1-5-21-100-200-300-1001';
function fixture(response) {
  const calls = []; const socket = new EventEmitter(); socket.setTimeout = () => {}; socket.destroy = () => {}; socket.end = ack => { socket.ack = ack; }; socket.write = message => { calls.push(JSON.parse(message)); queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify(response) + '\n'))); };
  const client = new ServiceClient({ platform: 'win32', run: async (file, args) => { calls.push({ file, args }); return { stdout: `"runner","${sid}"` }; }, connect: pipe => { calls.push({ pipe }); queueMicrotask(() => socket.emit('connect')); return socket; } });
  return { client, calls, socket };
}
test('service start binds owner PID and frames complete config without shell', async () => {
  const { client, calls } = fixture({ ok: true, data: { pid: 4321 } }); assert.deepEqual(await client.start({ config: 'proxies: []\n', ownerPid: 123 }), { pid: 4321 });
  assert.deepEqual(calls.at(-1), { action: 'start', config: 'proxies: []\n', ownerPid: 123 }); assert.equal(calls[1].pipe, `\\\\.\\pipe\\Luma.Proxy.${sid}`);
});
test('service API transports structured data without exposing secret', async () => { const { client, calls } = fixture({ ok: true, data: null }); await client.api('/configs', 'PATCH', { mode: 'rule' }); assert.deepEqual(calls.at(-1), { action: 'api', endpoint: '/configs', method: 'PATCH', data: { mode: 'rule' } }); });
test('service errors reject and acknowledge receipt instead of becoming successful state', async () => { const { client, socket } = fixture({ ok: false, error: 'denied' }); await assert.rejects(client.stop(), /denied/); assert.equal(socket.ack, '\n'); });
test('completed response acknowledges receipt before gracefully closing pipe', async () => { const { client, socket } = fixture({ ok: true, data: { running: true } }); await client.request({ action: 'status' }); assert.equal(socket.ack, '\n'); });
test('invalid owner and oversize configs rejected before connecting', () => { assert.throws(() => validateRequest({ action: 'start', ownerPid: -1, config: '' })); assert.throws(() => validateRequest({ action: 'start', ownerPid: 1, config: 'a'.repeat(8 * 1024 * 1024 + 1) })); assert.throws(() => validateRequest({ action: 'execute', command: 'cmd.exe' })); });
test('local provider paths and payload budgets validated before IPC', () => { assert.throws(() => validateRequest({ action: 'start', config: 'proxies: []', ownerPid: 1, providers: { '../../outside': 'proxies: []' } })); assert.throws(() => validateRequest({ action: 'start', config: 'proxies: []', ownerPid: 1, providers: { ['./providers/' + 'a'.repeat(64) + '.yaml']: 'x'.repeat(8 * 1024 * 1024 + 1) } })); });
test('unrecognized SID fails closed', async () => { const client = new ServiceClient({ platform: 'win32', run: async () => ({ stdout: 'not a user SID' }), connect: () => { throw Error('must not connect'); } }); await assert.rejects(client.ownerSid(), /用户标识/); });
test('service install UAC helper source is fixed and safely quoted', async () => {
  const calls = []; const client = new ServiceClient({ platform: 'win32', resourcesDir: "C:\\App O'Neil\\resources", run: async (file, args) => { calls.push({ file, args }); return { stdout: `"runner","${sid}"` }; } }); client.status = async () => ({ installed: true }); await client.install();
  const script = Buffer.from(calls[1].args.at(-1), 'base64').toString('utf16le'); assert.match(script, /-Verb RunAs -Wait -PassThru/); assert.match(script, /O''Neil/); assert.match(script, /Luma\.Service\.exe/); assert.match(script, /--install/); assert.equal(psLiteral("a'b"), "'a''b'");
});
test('UAC cancellation is an actionable error', async () => { const client = new ServiceClient({ platform: 'win32', run: async file => { if (file === 'whoami.exe') return { stdout: sid }; throw Error('cancelled'); } }); await assert.rejects(client.install(), /取消权限请求/); });
test('non-Windows reports unsupported service without invoking OS commands', async () => { const client = new ServiceClient({ platform: 'linux', run: async () => { throw Error('must not run'); } }); assert.equal((await client.status()).installed, false); await assert.rejects(client.install(), /仅支持 Windows/); });
test('selected service core sync passes encoded path and exact digest to fixed elevated helper', async () => {
  const calls = [], source = "C:\\User Space\\O'Neil\\mihomo.exe", digest = 'a'.repeat(64);
  const client = new ServiceClient({ platform: 'win32', resourcesDir: 'C:\\App\\resources', readCoreDigest: file => { assert.equal(file, source); return digest; }, run: async (file, args) => { calls.push({ file, args }); return { stdout: sid }; } });
  client.status = async () => ({ coreSha256: digest }); assert.equal((await client.syncCore(source)).coreSha256, digest);
  const script = Buffer.from(calls.at(-1).args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /--sync-core/); assert.ok(script.includes(Buffer.from(source).toString('base64'))); assert.ok(script.includes(digest)); assert.ok(!script.includes(source));
});
test('service core sync rejects network, alternate stream and relative paths before UAC', async () => {
  const client = new ServiceClient({ platform: 'win32', run: () => { throw Error('must not elevate'); } });
  for (const file of ['relative.exe', '\\\\host\\share\\mihomo.exe', 'C:\\core.exe:stream', 'C:\\bad\nname.exe']) await assert.rejects(client.syncCore(file), /本机 Windows/);
});
test('service sync rejects changed confirmation hash before requesting UAC', async () => {
  const client = new ServiceClient({ platform: 'win32', readCoreDigest: () => 'a'.repeat(64), run: () => { throw Error('must not elevate'); } });
  await assert.rejects(client.syncCore('C:\\selected.exe', 'b'.repeat(64)), /已更改/);
  await assert.rejects(client.syncCore('C:\\selected.exe', 'invalid'), /已更改/);
});
test('service provider bridge survives denied stop and is replaced only after successful core start', async () => {
  const events = []; let number = 0, fail = false;
  const client = new ServiceClient({ createProviderBridge: () => { const id = ++number; return { start: async () => { events.push(`prepare${id}`); return { config: `converted${id}` }; }, dispose: async () => events.push(`dispose${id}`) }; } });
  client.request = async request => { events.push(request.action + (request.config || '')); if (fail) throw Error('denied'); return { pid: 123 }; };
  await client.start({ config: 'proxies: []', ownerPid: 123 });
  fail = true; await assert.rejects(client.stop(), /denied/); assert.ok(!events.includes('dispose1'));
  await assert.rejects(client.start({ config: 'proxies: []', ownerPid: 123 }), /denied/); assert.ok(events.includes('dispose2')); assert.ok(!events.includes('dispose1'));
  fail = false; await client.start({ config: 'proxies: []', ownerPid: 123 }); assert.ok(events.indexOf('dispose1') > events.indexOf('startconverted3'));
  await client.stop(); assert.equal(events.at(-1), 'dispose3');
});
