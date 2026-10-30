import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw Error('Run on Windows');
const registry = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{ProxyEnable=$p.ProxyEnable;ProxyServer=$p.ProxyServer;ProxyOverride=$p.ProxyOverride} | ConvertTo-Json -Compress`], { encoding: 'utf8' }).trim());
const before = registry();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'luma-acceptance-'));
const dataDir = path.join(dir, 'data');
const profile = path.join(dir, 'fixture.yaml');
const executablePath = path.resolve('release/win-unpacked/Luma.exe');
const launch = env => electron.launch({ executablePath, args: [`--user-data-dir=${dataDir}`], env: { ...process.env, ...env }, timeout: 60000 });
const readState = page => page.evaluate(() => window.luma.invoke('state'));
const readWatcher = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'watchdog-launch.json'), 'utf8'));
const item = (health, id) => {
  const found = health.items.find(entry => entry.id === id);
  assert.ok(found, `Missing diagnostic: ${id}`);
  return found;
};
function completedHealth(health) {
  assert.equal(health.checking, false);
  assert.ok(Number.isFinite(Date.parse(health.checkedAt)), 'Diagnostic should record its completion time');
  assert.ok(['ok', 'warning', 'error'].includes(health.status));
  assert.deepEqual(health.items.map(entry => entry.id).sort(), ['kernel', 'launchAtLogin', 'recovery', 'systemProxy']);
  for (const entry of health.items) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.label.length > 0);
    assert.equal(typeof entry.detail, 'string');
    assert.ok(['ok', 'warning', 'error', 'skipped'].includes(entry.status));
  }
}
async function waitForHealth(page) {
  const deadline = Date.now() + 60000;
  let health;
  while (Date.now() < deadline) {
    ({ health } = await readState(page));
    if (health?.checking === false && health.checkedAt) {
      completedHealth(health);
      return health;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error(`Startup diagnostic did not finish within 60 seconds: ${JSON.stringify(health)}`);
}
async function healthyLocalChecks(page) {
  const health = await waitForHealth(page);
  assert.equal(item(health, 'kernel').status, 'ok');
  assert.equal(item(health, 'recovery').status, 'ok');
  assert.equal(item(health, 'systemProxy').status, before.ProxyEnable === 1 ? 'warning' : 'ok');
  assert.deepEqual(registry(), before, 'Diagnostics must leave the system proxy unchanged');
  const state = await readState(page);
  const login = await app.evaluate(({ app }) => ({ settings: app.getLoginItemSettings(), portable: !!process.env.PORTABLE_EXECUTABLE_DIR }));
  if (!login.portable) assert.equal(typeof login.settings.executableWillLaunchAtLogin, 'boolean');
  assert.equal(item(health, 'launchAtLogin').status, login.portable ? 'skipped' : login.settings.executableWillLaunchAtLogin === state.launchAtLogin ? 'ok' : 'warning');
  return health;
}
await fs.writeFile(profile, 'proxies:\n  - name: Local test\n    type: socks5\n    server: 127.0.0.1\n    port: 1\nproxy-groups:\n  - name: Proxy\n    type: select\n    proxies: [DIRECT, Local test]\nrules:\n  - MATCH,DIRECT\n');
const local = http.createServer((req, res) => res.end('luma-windows-proxy-ok'));
await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
let app;
let failed = false;
try {
  app = await launch();
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, profile);
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.luma?.invoke === 'function');
  assert.equal((await readState(page)).startupCheck, true);
  await healthyLocalChecks(page);

  // Concurrent retries should share one check and publish the same completed result.
  const retried = await page.evaluate(() => Promise.all([window.luma.invoke('health:check'), window.luma.invoke('health:check')]));
  retried.forEach(completedHealth);
  assert.deepEqual(retried[0], retried[1]);
  assert.deepEqual((await readState(page)).health, retried[0]);

  // No proxy or core is running: killing only the idle watcher is safe here.
  const oldWatcher = await readWatcher();
  execFileSync('taskkill.exe', ['/PID', String(oldWatcher.pid), '/F'], { encoding: 'utf8' });
  const repaired = await page.evaluate(() => window.luma.invoke('health:check'));
  completedHealth(repaired);
  assert.equal(item(repaired, 'recovery').status, 'ok');
  const replacement = await readWatcher();
  assert.notEqual(replacement.pid, oldWatcher.pid, 'Diagnostic should replace a stopped recovery watcher');
  assert.equal((await readState(page)).running, false);
  assert.deepEqual(registry(), before);

  await page.getByRole('button', { name: '开启连接' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '本地文件' }).click();
  await page.getByRole('button', { name: '选择配置文件' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '开启连接' }).click();
  await page.getByText('安全连接已开启').waitFor({ timeout: 60000 });
  const state = await readState(page);
  assert.equal(state.systemProxy, true);
  assert.equal(registry().ProxyServer, `127.0.0.1:${state.port}`);
  const body = await new Promise((resolve, reject) => http.get({ hostname: '127.0.0.1', port: state.port, path: `http://127.0.0.1:${local.address().port}/`, headers: { Host: `127.0.0.1:${local.address().port}` } }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(body)); }).on('error', reject));
  assert.equal(body, 'luma-windows-proxy-ok');
  await page.getByRole('button', { name: '断开连接' }).click();
  await page.getByText('当前未连接', { exact: true }).waitFor();
  assert.deepEqual(registry(), before);
  await page.getByRole('button', { name: '开启连接' }).click();
  await page.getByText('安全连接已开启').waitFor();
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.luma.invoke('settings', { closeToTray: false, startupCheck: false }));
  assert.equal((await readState(page)).startupCheck, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).startupCheck, false);
  const closed = app.waitForEvent('close');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await closed;
  app = null;
  assert.deepEqual(registry(), before);
  console.log('Startup diagnostics, single in-flight retry, watcher repair, and graceful exit restoration passed');

  app = await launch({ LUMA_TEST_WATCHDOG: 'native' });
  const crashPage = await app.firstWindow();
  crashPage.on('pageerror', error => errors.push(error.message));
  await crashPage.getByRole('button', { name: '开启连接' }).waitFor();
  // Let startup work settle, then prove the persisted setting skipped the diagnostic.
  await crashPage.waitForTimeout(1000);
  const disabled = await readState(crashPage);
  assert.equal(disabled.startupCheck, false);
  assert.deepEqual(disabled.health, { checking: false, checkedAt: null, status: 'idle', items: [] });
  const manual = await crashPage.evaluate(() => window.luma.invoke('health:check'));
  completedHealth(manual);
  assert.equal(item(manual, 'kernel').status, 'ok');
  assert.equal(item(manual, 'recovery').status, 'ok');
  await crashPage.evaluate(() => window.luma.invoke('settings', { startupCheck: true }));
  assert.equal((await readState(crashPage)).startupCheck, true);
  await crashPage.getByRole('button', { name: '开启连接' }).click();
  await crashPage.getByText('安全连接已开启').waitFor({ timeout: 60000 });
  assert.equal((await readWatcher()).method, 'native');
  const mainPid = await app.evaluate(() => process.pid);
  console.log('Forced termination: actual main PID', mainPid, 'launcher PID', app.process().pid);
  console.log(execFileSync('taskkill.exe', ['/PID', String(mainPid), '/F'], { encoding: 'utf8' }));
  app = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { assert.deepEqual(registry(), before); break; }
    catch { if (attempt === 19) throw Error('Watchdog did not restore system proxy'); await new Promise(resolve => setTimeout(resolve, 1000)); }
  }

  app = await launch({ LUMA_TEST_WATCHDOG: 'unavailable' });
  const degraded = await app.firstWindow();
  degraded.on('pageerror', error => errors.push(error.message));
  await degraded.getByRole('button', { name: '开启连接' }).waitFor();
  const unavailable = await waitForHealth(degraded);
  assert.equal(unavailable.status, 'error');
  assert.equal(item(unavailable, 'recovery').status, 'error');
  assert.equal(item(unavailable, 'kernel').status, 'ok');
  const blocked = await degraded.evaluate(async () => { try { await window.luma.invoke('toggle'); return ''; } catch (error) { return error.message; } });
  assert.match(blocked, /异常退出保护/);
  assert.deepEqual(registry(), before);
  assert.equal((await readState(degraded)).running, false);
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  console.log('Windows packaged EXE passed: automatic/local diagnostics, manual retry, persisted opt-out, native login readback, watchdog liveness repair, real import, bundled kernel, system proxy, local HTTP forwarding, disconnect/exit restoration, native fallback actual-main termination recovery, unavailable protection reporting and safe rejection, no renderer errors');
} catch (error) {
  failed = true;
  console.error('WINDOWS_ACCEPTANCE_FAILURE', error);
  for (const file of ['proxy-recovery.json', 'proxy-recovery.json.watchdog.log', 'watchdog-output.log', 'watchdog-launch.json']) {
    try { console.log(file, await fs.readFile(path.join(dataDir, file), 'utf8')); } catch {}
  }
  console.log('Current registry', registry());
} finally {
  if (app) await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
  local.close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 }).catch(error => console.warn('Temporary test data remains locked:', error.code));
}
process.exit(failed ? 1 : 0);
