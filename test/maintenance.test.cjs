const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Store } = require('../electron/store.cjs');
const { registerMaintenance, makeBackup, validateBackup, restoreBackup, davOptions, readLimited, verifyDigest, officialAsset, fetchRelease, downloadAsset, coreAsset, newerVersion } = require('../electron/maintenance.cjs');
const text = 'proxies: [{name: Local, type: socks5, server: 127.0.0.1, port: 1}]\nproxy-groups: [{name: Proxy, type: select, proxies: [Local, DIRECT]}]\nrules: ["MATCH,DIRECT"]\n';
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-backup-')); const store = new Store(dir); const id = crypto.randomUUID(); store.data.profiles = [{ id, name: 'Fixture', url: 'https://example.test/private', override: '' }]; store.data.activeId = id; fs.writeFileSync(store.profilePath(id), text); store.save(); return { dir, store, id, close: () => fs.rmSync(dir, { recursive: true, force: true }) }; }
test('backup round trip restores profile text, themes and nested settings', async () => {
  const f = fixture(); try { f.store.data.appearance = { mode: 'dark', accent: '#123456', sidebar: '#ffffff' }; const b = makeBackup(f.store); f.store.data.appearance.mode = 'light'; let disconnected = false; await restoreBackup(f.store, JSON.stringify(b), async () => { disconnected = true; }); assert.equal(disconnected, true); assert.equal(f.store.data.appearance.mode, 'dark'); assert.equal(fs.readFileSync(f.store.profilePath(f.id), 'utf8'), text); assert.equal(new Store(f.dir).data.appearance.mode, 'dark'); } finally { f.close(); }
});
test('backup validation rejects traversal, duplicate IDs and invalid settings before disconnect', async () => {
  const f = fixture(); try { const backup = makeBackup(f.store); backup.settings.profiles[0].id = '../'.repeat(12); await assert.rejects(restoreBackup(f.store, backup, () => { throw Error('must not disconnect'); }), /订阅无效/); assert.equal(f.store.data.profiles[0].id, f.id); const duplicate = makeBackup(f.store); duplicate.settings.profiles = [duplicate.settings.profiles[0], { ...duplicate.settings.profiles[0] }]; assert.throws(() => validateBackup(duplicate), /订阅无效/); const invalid = structuredClone(makeBackup(f.store)); invalid.settings.core.mixedPort = 999999; assert.throws(() => validateBackup(invalid), /端口/); assert.equal(fs.readFileSync(f.store.profilePath(f.id), 'utf8'), text); } finally { f.close(); }
});
test('restore rolls files and settings back when persistence fails', async () => {
  const f = fixture(); try { const backup = structuredClone(makeBackup(f.store)); backup.files[f.id] = text.replace('Local', 'Changed'); const original = f.store.data; f.store.save = () => { throw Error('disk full'); }; await assert.rejects(restoreBackup(f.store, backup, async () => {}), /disk full/); assert.equal(f.store.data, original); assert.equal(fs.readFileSync(f.store.profilePath(f.id), 'utf8'), text); } finally { f.close(); }
});
test('restore does not transfer startup registration or custom executable selection', async () => {
  const f = fixture(); try { const b = structuredClone(makeBackup(f.store)); b.settings.customCore = true; b.settings.launchAtLogin = true; await restoreBackup(f.store, b, async () => {}); assert.equal(f.store.data.customCore, false); assert.equal(f.store.data.launchAtLogin, false); } finally { f.close(); }
});
test('WebDAV requires explicit HTTPS destination and keeps credentials in headers', () => {
  const result = davOptions({ url: 'https://dav.example.test/backups/luma.json', username: 'alice', password: 'secret' }); assert.equal(result.headers.Authorization, 'Basic YWxpY2U6c2VjcmV0'); assert.doesNotMatch(result.url, /alice|secret/); assert.throws(() => davOptions({ url: 'http://example.test', username: '', password: '' }), /HTTPS/); assert.throws(() => davOptions({ url: 'https://user:pw@example.test', username: '', password: '' }), /HTTPS/);
});
test('update verification rejects tampering and unofficial repositories', async () => {
  const bytes = Buffer.from('fixture'); const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'); verifyDigest(bytes, digest); assert.throws(() => verifyDigest(Buffer.from('tampered'), digest), /校验/); const asset = { name: 'fixture', digest, browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1/fixture' }; assert.equal(officialAsset(asset, 'MetaCubeX/mihomo'), asset); assert.throws(() => officialAsset({ ...asset, browser_download_url: 'https://evil.test/a' }, 'MetaCubeX/mihomo'), /官方/); assert.throws(() => officialAsset({ ...asset, digest: null }, 'MetaCubeX/mihomo'), /校验/); const result = await downloadAsset(asset, 'MetaCubeX/mihomo', async () => new Response(bytes)); assert.deepEqual(result, bytes); await assert.rejects(downloadAsset(asset, 'MetaCubeX/mihomo', async () => new Response('bad')), /校验/);
});
test('bounded downloads stop oversized bodies and select compatible Windows asset', async () => {
  await assert.rejects(readLimited(new Response('0123456789'), 4), /过大/); const asset = { name: 'mihomo-windows-amd64-compatible-v1.zip', digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1/a.zip' }; assert.equal(coreAsset({ assets: [asset] }, 'win32'), asset); assert.throws(() => coreAsset({ assets: [] }, 'win32'), /x64/);
});
test('app update finds public preview release when no stable release exists', async () => {
  const urls = []; const result = await fetchRelease('Nilarf2/luma-proxy', 'stable', async url => { urls.push(url); return urls.length === 1 ? new Response('', { status: 404 }) : new Response(JSON.stringify([{ tag_name: 'v0.2.0', assets: [], prerelease: true, draft: false }])); }); assert.equal(result.tag_name, 'v0.2.0'); assert.equal(urls.length, 2); assert.match(urls[1], /releases\?per_page/);
});
test('update comparison never offers a downgrade and orders prereleases', () => {
  assert.equal(newerVersion('v0.1.2', '0.2.0'), false);
  assert.equal(newerVersion('v0.2.0', '0.2.0'), false);
  assert.equal(newerVersion('v0.3.0', '0.2.0'), true);
  assert.equal(newerVersion('v1.2.0', '1.2.0-beta.3'), true);
  assert.equal(newerVersion('v1.2.0-beta.4', '1.2.0-beta.3'), true);
  assert.equal(newerVersion('v1.2.0-beta.3', '1.2.0'), false);
  assert.equal(newerVersion('v1.2.0-beta.2', '1.2.0-beta.11'), false);
});
test('backup includes local provider data and rejects missing sources or cycles', async () => {
  const f = fixture(); try {
    const filename = crypto.createHash('sha256').update('provider').digest('hex') + '.yaml';
    fs.mkdirSync(path.join(f.dir, 'provider-assets'));
    const body = 'payload: ["DOMAIN,localhost,DIRECT"]\n';
    fs.writeFileSync(path.join(f.dir, 'provider-assets', filename), body);
    f.store.data.profiles[0].localProviders = { 'rule-providers:Local': filename };
    const b = makeBackup(f.store); assert.equal(b.assets[filename], body);
    fs.writeFileSync(path.join(f.dir, 'provider-assets', filename), 'changed');
    await restoreBackup(f.store, JSON.stringify(b), async () => {});
    assert.equal(fs.readFileSync(path.join(f.dir, 'provider-assets', filename), 'utf8'), body);
    b.settings.profiles[0].sourceIds = [crypto.randomUUID()]; assert.throws(() => validateBackup(b), /来源不存在/);
    b.settings.profiles[0].sourceIds = [f.id]; assert.throws(() => validateBackup(b), /循环/);
    b.settings.profiles[0].sourceIds = []; b.settings.profiles[0].script = 'function main( {'; assert.throws(() => validateBackup(b), /语法/);
  } finally { f.close(); }
});
test('WebDAV round trip uses headers, handles conflicts and honors restore cancellation', async () => {
  const http = require('node:http'); const f = fixture(); const handlers = new Map(); let saved = '', etag = '"1"', confirmation = 1, applied = 0, disconnected = 0;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Basic YWxpY2U6c2VjcmV0') { res.writeHead(401).end(); return; }
    if (req.method === 'PUT') {
      if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk); saved = Buffer.concat(chunks).toString(); etag = '"2"'; res.writeHead(201, { etag }).end();
    } else res.writeHead(200, { etag, 'Content-Type': 'application/json' }).end(saved);
  }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const maintenance = registerMaintenance({ handle: (name, fn) => handlers.set(name, fn), app: {}, dialog: { showMessageBox: async () => ({ response: confirmation }) }, getWindow: () => null, shell: {}, store: f.store, engine: {}, exclusive: fn => fn(), disconnect: async () => { disconnected++; }, publish() {}, asset() {}, applySettings: async () => { applied++; },
    fetch: (url, options) => { assert.equal(url, 'https://dav.example.test/luma.json'); assert.equal(options.redirect, 'error'); return fetch(`http://127.0.0.1:${server.address().port}/luma.json`, options); } });
  const credentials = { url: 'https://dav.example.test/luma.json', username: 'alice', password: 'secret' };
  try {
    assert.equal((await handlers.get('backup:webdav:upload')(credentials)).etag, '"2"');
    assert.doesNotMatch(saved, /alice|secret/);
    await assert.rejects(handlers.get('backup:webdav:upload')({ ...credentials, etag: '"stale"' }), /412/);
    const result = await handlers.get('backup:webdav:download')(credentials); assert.equal(result.profiles, 1); assert.equal(applied, 1); assert.equal(disconnected, 1);
    confirmation = 0; assert.equal(await handlers.get('backup:webdav:download')(credentials), null); assert.equal(disconnected, 1);
  } finally { maintenance.dispose(); await new Promise(resolve => server.close(resolve)); f.close(); }
});
test('backup excludes controller token and restore preserves only the local token with listener disabled', async () => {
  const f = fixture();
  try {
    const local = 'local-controller-token-24-chars';
    f.store.data.controller = { enabled: true, port: 9097, secret: local, origins: ['https://local.test'] };
    const b = makeBackup(f.store);
    assert.equal(b.settings.controller.enabled, false);
    assert.equal(Object.hasOwn(b.settings.controller, 'secret'), false);
    assert.equal(JSON.stringify(b).includes(local), false);
    b.settings.controller.secret = 'foreign-controller-token-24-chars';
    b.settings.controller.enabled = true;
    await restoreBackup(f.store, b, async () => {});
    assert.equal(f.store.data.controller.secret, local);
    assert.equal(f.store.data.controller.enabled, false);
    assert.equal(new Store(f.dir).data.controller.secret, local);
  } finally { f.close(); }
});
