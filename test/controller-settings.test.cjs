const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { defaults, normalizeSettings, validateSettingsPatch } = require('../electron/settings.cjs');
const { Store } = require('../electron/store.cjs');
const secret = 'local-test-secret-24-chars';
test('controller settings default disabled and preserve omitted secrets across edits', () => {
  assert.deepEqual(normalizeSettings({}).controller, { enabled: false, port: 9097, secret: '', origins: [] });
  const enabled = validateSettingsPatch(defaults(), { controller: { enabled: true, secret, origins: ['https://control.local/', 'http://127.0.0.1:3000'] } });
  assert.deepEqual(enabled.controller.origins, ['https://control.local', 'http://127.0.0.1:3000']);
  assert.equal(validateSettingsPatch(enabled, { controller: { port: 9098 } }).controller.secret, secret);
  assert.equal(validateSettingsPatch(enabled, { controller: { enabled: false, secret: '' } }).controller.secret, '');
});
test('controller rejects weak credentials, nonexact origins and conflicting listeners', () => {
  for (const controller of [{ enabled: true }, { enabled: 'yes' }, { port: 1023 }, { port: 65536 }, { secret: 'short' }, { secret: 'x'.repeat(129) }, { secret: secret + '\n' }, { secret: secret + '\0' }, { secret: secret + ' ' }, { origins: Array(17).fill('https://local.test') }, ...['*', 'https://*.test', 'file:///x', 'https://user:pass@local.test', 'https://local.test/path', 'https://local.test?x', 'https://local.test/#x', 'https://local.test\\path'].map(origin => ({ origins: [origin] })), { origins: ['https://local.test', 'https://local.test/'] }]) assert.throws(() => validateSettingsPatch(defaults(), { controller }));
  for (const key of ['mixedPort', 'httpPort', 'socksPort']) assert.throws(() => validateSettingsPatch(defaults(), { controller: { enabled: true, secret }, core: { [key]: 9097 } }));
  const current = validateSettingsPatch(defaults(), { controller: { enabled: true, secret } });
  assert.throws(() => validateSettingsPatch(current, { core: { mixedPort: 9097 } }));
  assert.throws(() => validateSettingsPatch(current, { controller: { secret: '' } }));
});
test('public snapshots redact saved controller secret without mutating persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-controller-settings-'));
  try { const store = new Store(dir); store.data = validateSettingsPatch(store.data, { controller: { enabled: true, secret } }); store.save(); const visible = store.publicData(); assert.equal(visible.controller.hasSecret, true); assert.equal(Object.hasOwn(visible.controller, 'secret'), false); assert.equal(JSON.stringify(visible).includes(secret), false); assert.equal(new Store(dir).data.controller.secret, secret); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
