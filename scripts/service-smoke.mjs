import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { ServiceClient } = require('../electron/service.cjs');
if (process.platform !== 'win32') throw Error('Service acceptance requires Windows');
const ps = source => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${source}`], { encoding: 'utf8', timeout: 30000 }).trim();
assert.equal(ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"), 'True', 'CI service smoke requires an elevated isolated runner');
const helper = path.resolve('resources/service/Luma.Service.exe');
const client = new ServiceClient({ resourcesDir: path.resolve('resources') });
assert.equal((await client.status()).installed, false, 'Refuse to touch a pre-existing service');
assert.equal(ps("@(Get-NetAdapter -Name LumaServiceCI -ErrorAction SilentlyContinue).Count"), '0', 'Refuse to touch a pre-existing test adapter');
const sid = await client.ownerSid();
const local = http.createServer((_req, res) => res.end('luma-service-local-ok'));
local.listen(0, '127.0.0.1'); await once(local, 'listening');
const base = `mixed-port: 0\nmode: rule\nlog-level: warning\nipv6: false\ndns: {enable: false}\nproxies:\n  - {name: Local fixture, type: http, server: 127.0.0.1, port: ${local.address().port}}\nrules: ['MATCH,Local fixture']\n`;
const waitFor = async (fn, label) => { const until = Date.now() + 60000; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 250)); } throw Error(`${label}: ${JSON.stringify(last)}`); };
let installed = false, owner;
try {
  execFileSync(helper, ['--install', sid, String(process.pid)], { timeout: 60000 }); installed = true;
  await waitFor(async () => (await client.status()).running, 'service ready');
  const started = await client.start({ config: base, ownerPid: process.pid }); assert.ok(started.pid > 0);
  await waitFor(() => client.api('/version'), 'protected core version');
  const config = await client.api('/configs'); assert.equal(config.secret, undefined); assert.equal(config['external-controller'], undefined);
  await assert.rejects(client.api('/upgrade', 'POST'), /denied|Denied/);
  await assert.rejects(client.api('/configs', 'PUT', { path: 'C:\\Windows\\win.ini' }), /denied|Denied/);
  await client.stop(); assert.equal((await client.status()).coreRunning, false);
  console.log('Protected service install, normal start/stop, controller secret removal and denied reload/upgrade passed');

  const tun = base + "tun:\n  enable: true\n  device: LumaServiceCI\n  stack: gvisor\n  auto-route: true\n  auto-detect-interface: true\n  strict-route: false\n  route-address: [198.18.0.0/30]\n";
  // Separate real client owner permits actual process-death acceptance without terminating this harness.
  const code = `const {ServiceClient}=require(${JSON.stringify(path.resolve('electron/service.cjs'))});const c=new ServiceClient({resourcesDir:${JSON.stringify(path.resolve('resources'))}});c.start({config:${JSON.stringify(tun)},ownerPid:process.pid}).then(x=>{console.log(JSON.stringify(x));setInterval(()=>{},1000)}).catch(e=>{console.error(e);process.exit(1)});`;
  owner = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let stderr = ''; owner.stderr.on('data', b => stderr += b.toString());
  await waitFor(async () => { if (owner.exitCode !== null) throw Error(stderr || 'owner exited'); return (await client.status()).coreRunning; }, 'TUN owner start');
  await waitFor(() => ps("@(Get-NetAdapter -Name LumaServiceCI -ErrorAction SilentlyContinue).Count") === '1', 'real TUN adapter');
  await waitFor(() => ps("@(Get-NetRoute -DestinationPrefix '198.18.0.0/30' -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq LumaServiceCI).Count") !== '0', 'confined test TUN route');
  // Only the reserved test prefix enters TUN; its HTTP proxy target is the local fixture above.
  const body = await new Promise((resolve, reject) => { const req = http.get('http://198.18.0.2:18123/local-only', { timeout: 15000, agent: false }, res => { let text = ''; res.on('data', b => text += b); res.on('end', () => resolve(text)); }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('TUN local fixture timeout'))); });
  assert.equal(body, 'luma-service-local-ok');
  await assert.rejects(client.stop(), /denied|Denied/, 'Another process may not stop the active owner core');
  execFileSync('taskkill.exe', ['/PID', String(owner.pid), '/F'], { timeout: 10000 }); owner = null;
  await waitFor(async () => !(await client.status()).coreRunning, 'owner death stops privileged core');
  await waitFor(() => ps("@(Get-NetAdapter -Name LumaServiceCI -ErrorAction SilentlyContinue).Count") === '0', 'TUN adapter removed after owner death');
  console.log('Real Windows TUN adapter, confined route, local-only TUN HTTP forwarding, owner isolation and actual owner process-death cleanup passed');
} finally {
  if (owner?.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(owner.pid), '/F']); } catch {} }
  if (installed) { try { await client.stop(); } catch {} execFileSync(helper, ['--uninstall', sid, String(process.pid)], { timeout: 60000 }); assert.equal((await client.status()).installed, false); }
  local.close();
}
