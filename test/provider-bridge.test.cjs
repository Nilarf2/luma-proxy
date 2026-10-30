const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const YAML = require('yaml');
const { ProviderBridge, providerDownload } = require('../electron/provider-bridge.cjs');
async function listen(fn) { const s = http.createServer(fn); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s; }
async function close(s) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
const ss = 'ss://' + Buffer.from('aes-128-gcm:fixture').toString('base64') + '@127.0.0.1:1080#Local';
test('provider bridge converts fresh URI/base64 responses and forwards declared headers only', async () => {
  let calls = 0, seen;
  const origin = await listen((req, res) => { seen = req.headers; calls++; res.end(calls === 1 ? ss : Buffer.from(ss.replace('#Local', '#Refreshed')).toString('base64')); });
  const bridge = new ProviderBridge();
  try {
    const config = YAML.parse((await bridge.start(YAML.stringify({ 'proxy-providers': { remote: { type: 'http', url: `http://127.0.0.1:${origin.address().port}/subscription`, interval: 3600, header: { 'User-Agent': ['Fixture-UA'], Authorization: ['Bearer local'], 'X-Multi': ['one', 'two'] } } } }))).config);
    const p = config['proxy-providers'].remote;
    assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+\/luma-provider\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
    assert.equal(p.header, undefined); assert.equal(p.interval, 3600); assert.equal(calls, 0);
    assert.equal(YAML.parse(await (await fetch(p.url)).text()).proxies[0].name, 'Local');
    assert.equal(YAML.parse(await (await fetch(p.url)).text()).proxies[0].name, 'Refreshed');
    assert.equal(calls, 2); assert.equal(seen.authorization, 'Bearer local'); assert.equal(seen['user-agent'], 'Fixture-UA'); assert.equal(seen['x-multi'], 'one, two');
    for (const url of [p.url + '?x=1', p.url.replace(/.$/, 'z')]) assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(p.url, { method: 'POST' })).status, 405);
    const spoof = await new Promise((resolve, reject) => { const req = http.get(p.url, { headers: { Host: 'localhost' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
    assert.equal(spoof, 404); assert.equal(calls, 2);
  } finally { await bridge.dispose(); await close(origin); }
});
test('provider YAML returns only nodes and coalesces concurrent refresh requests', async () => {
  let release, calls = 0;
  const bridge = new ProviderBridge({ request: async () => { calls++; await new Promise(r => release = r); return { body: Buffer.from('proxies: [{name: Local, type: socks5, server: 127.0.0.1, port: 1080}]\nsecret: private\nrules: [MATCH,DIRECT]') }; } });
  try {
    const cfg = YAML.parse((await bridge.start('proxy-providers: {p: {type: http, url: "http://subscription.invalid/x"}}')).config);
    const url = cfg['proxy-providers'].p.url, a = fetch(url), b = fetch(url);
    while (!release) await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 20)); release();
    const values = await Promise.all([a, b]);
    for (const res of values) assert.deepEqual(Object.keys(YAML.parse(await res.text())), ['proxies']);
    assert.equal(calls, 1);
  } finally { await bridge.dispose(); }
});
test('bridge shutdown cancels real pending downloads and cannot leak upstream errors', async () => {
  let arrived; const got = new Promise(r => arrived = r);
  const origin = await listen(() => arrived()); const bridge = new ProviderBridge();
  try {
    const cfg = YAML.parse((await bridge.start(`proxy-providers: {p: {type: http, url: "http://127.0.0.1:${origin.address().port}/secret"}}`)).config);
    const response = fetch(cfg['proxy-providers'].p.url).catch(() => null); await got;
    await bridge.dispose(); await response;
    await bridge.dispose();
  } finally { await close(origin); }
});
test('bridge validates before serving and no-provider configs need no listener', async () => {
  for (const header of [{ Host: ['x'] }, { Authorization: [12] }, { Bad: [] }, { 'X-Header': ['x\r\ny'] }]) assert.throws(() => providerDownload(header));
  const bridge = new ProviderBridge(); await assert.rejects(bridge.start('proxy-providers: {p: {type: http, url: "file:///private"}}')); assert.equal(bridge.server, null);
  const noProviders = new ProviderBridge(); const text = 'proxies: []\nrules: ["MATCH,DIRECT"]'; assert.equal((await noProviders.start(text)).config, text); assert.equal(noProviders.server, null); await assert.rejects(noProviders.start(text)); await noProviders.dispose();
  const broken = new ProviderBridge({ request: async () => { throw Error('sensitive subscription address and token'); } });
  try { const c = YAML.parse((await broken.start('proxy-providers: {p: {type: http, url: "http://subscription.invalid"}}')).config); const res = await fetch(c['proxy-providers'].p.url); assert.equal(res.status, 502); assert.equal(await res.text(), 'Provider download failed'); } finally { await broken.dispose(); }
});
