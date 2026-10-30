const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Diagnostics, kernelVersion } = require('../electron/diagnostics.cjs');
const { Store } = require('../electron/store.cjs');

function options(overrides = {}) {
  return { platform: 'win32', binary: 'unused', kernelVersion: async () => 'Mihomo v1.0', ensureRecovery: async () => {}, inspectProxy: async () => ({ ownership: 'disabled', recoveryPending: false }), getLoginSettings: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }), launchAtLogin: () => false, ...overrides };
}
test('local diagnostics deduplicate checks and publish checking and completion', async () => {
  let finish, runs = 0;
  const updates = [];
  const d = new Diagnostics(options({ ensureRecovery: () => { runs++; return runs === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(); }, onChange: state => updates.push(state) }));
  const first = d.run();
  const second = d.run();
  assert.equal(first, second);
  assert.equal(d.state.checking, true);
  await Promise.resolve();
  finish();
  const result = await first;
  assert.equal(runs, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.checking, false);
  assert.ok(Date.parse(result.checkedAt));
  assert.deepEqual(result.items.map(i => i.id), ['kernel', 'recovery', 'systemProxy', 'launchAtLogin']);
  assert.equal(updates.length, 2);
  await d.run();
});
test('diagnostics sanitize failures and preserve observations without changing settings', async () => {
  let reads = 0;
  const secret = 'EncodedCommand SECRET C:\\private\\settings';
  const d = new Diagnostics(options({ kernelVersion: async () => { throw Error(secret); }, ensureRecovery: async () => { throw Error(secret); }, inspectProxy: async () => { reads++; return { ownership: 'external', recoveryPending: false }; }, getLoginSettings: () => ({ openAtLogin: true, executableWillLaunchAtLogin: true }) }));
  const result = await d.run();
  assert.equal(result.status, 'error');
  assert.equal(result.items[2].status, 'warning');
  assert.equal(result.items[3].status, 'warning');
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|EncodedCommand|private/);
});
test('non-Windows and portable skips do not produce warnings or call Windows APIs', async () => {
  const fail = () => { throw Error('must not call'); };
  const d = new Diagnostics(options({ platform: 'linux', ensureRecovery: fail, inspectProxy: fail, getLoginSettings: fail }));
  assert.equal((await d.run()).status, 'ok');
  assert.ok(d.state.items.slice(1).every(i => i.status === 'skipped'));
  const p = new Diagnostics(options({ portable: true, getLoginSettings: fail }));
  assert.equal((await p.run()).items[3].status, 'skipped');
});
test('stale recovery journal produces an actionable warning', async () => {
  const d = new Diagnostics(options({ inspectProxy: async () => ({ ownership: 'stale', recoveryPending: true }) }));
  assert.equal((await d.run()).items[2].status, 'warning');
});
test('Windows StartupApproved disabled entry is not reported as enabled', async () => {
  const d = new Diagnostics(options({ launchAtLogin: () => true, getLoginSettings: () => ({ openAtLogin: true, executableWillLaunchAtLogin: false }) }));
  const result = await d.run();
  assert.equal(result.items[3].status, 'warning');
  assert.doesNotMatch(result.items[3].detail, /已启用/);
});
test('startup checks default on and preserve a saved disabled preference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-health-settings-'));
  try {
    const s = new Store(dir);
    assert.equal(s.publicData().startupCheck, true);
    s.data.startupCheck = false;
    s.save();
    assert.equal(new Store(dir).data.startupCheck, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('watchdog liveness requires the ready token and original process start identity', async () => {
  let ready = 'token', started = '987654321', calls = 0;
  const context = { module: { exports: {} }, Buffer, process, setTimeout, require: name => name === './windows-proxy.cjs' ? { ps: async script => { calls++; assert.match(script, /Get-Process -Id 123/); assert.doesNotMatch(script, /Cim|Wmi/); return started; } } : name === 'node:fs' ? { readFileSync: () => ready } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve('electron/watchdog.cjs'), 'utf8'), context);
  const { checkWatchdog } = context.module.exports;
  const handle = { pid: 123, readyFile: 'unused', token: 'token', started: '987654321' };
  assert.equal(await checkWatchdog(handle), true);
  started = '111';
  assert.equal(await checkWatchdog(handle), false);
  ready = 'wrong token';
  assert.equal(await checkWatchdog(handle), false);
  assert.equal(calls, 2);
  assert.equal(await checkWatchdog({ ...handle, pid: -1 }), false);
});
test('watchdog fallback clears a failed ready marker and verifies native process identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-watchdog-fallback-'));
  try {
    const launches = [], stopped = [];
    let readyFile;
    const ps = async script => {
      if (script.includes('Invoke-CimMethod') || script.includes('LumaDetachedProcess')) {
        const scriptFile = Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString();
        const contents = fs.readFileSync(scriptFile, 'utf8');
        readyFile = Buffer.from(contents.match(/\$ready=.*?FromBase64String\('([^']+)'\)/)[1], 'base64').toString();
        assert.equal(fs.existsSync(readyFile), false);
        const token = contents.match(/WriteAllText\(\$ready,'([^']+)'\)/)[1];
        fs.writeFileSync(readyFile, token);
        launches.push(script.includes('Invoke-CimMethod') ? 'cim' : 'native');
        return launches.length === 1 ? '101' : '202';
      }
      if (script.includes('Stop-Process')) { stopped.push(script); return ''; }
      if (script.includes('Get-Process -Id 101')) throw Error('first watcher disappeared');
      if (script.includes('Get-Process -Id 202')) return '44444';
      throw Error('Unexpected PowerShell call');
    };
    const context = { module: { exports: {} }, Buffer, process: { env: {} }, setTimeout, require: name => name === './windows-proxy.cjs' ? { ps } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.resolve('electron/watchdog.cjs'), 'utf8'), context);
    const result = await context.module.exports.startWatchdog(123, dir, 'unused');
    assert.deepEqual(launches, ['cim', 'native']);
    assert.equal(result.pid, 202);
    assert.equal(result.started, '44444');
    assert.equal(result.method, 'native');
    assert.equal(stopped.length, 1);
    assert.match(stopped[0], /Stop-Process -Id 101/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('quitting during watchdog launch stops its child and skips fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-watchdog-cancel-'));
  try {
    let cancelled = false, launches = 0, stopped = false;
    const ps = async script => {
      if (script.includes('Invoke-CimMethod')) { launches++; cancelled = true; return '101'; }
      if (script.includes('Stop-Process -Id 101')) { stopped = true; return ''; }
      throw Error('Unexpected PowerShell call');
    };
    const context = { module: { exports: {} }, Buffer, process: { env: {} }, setTimeout, require: name => name === './windows-proxy.cjs' ? { ps } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.resolve('electron/watchdog.cjs'), 'utf8'), context);
    await assert.rejects(context.module.exports.startWatchdog(123, dir, 'unused', () => cancelled), /取消/);
    assert.equal(launches, 1);
    assert.equal(stopped, true);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('bundled core version probe exits without loading a profile', { skip: process.platform === 'win32' || !fs.existsSync(path.resolve('resources/core/mihomo')) }, async () => {
  assert.match(await kernelVersion(path.resolve('resources/core/mihomo')), /^Mihomo v?[\w.+-]+$/);
});
