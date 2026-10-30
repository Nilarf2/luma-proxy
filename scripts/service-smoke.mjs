import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { ServiceClient } = require('../electron/service.cjs');
const { coreDigest } = require('../electron/service.cjs');
if (process.platform !== 'win32') throw Error('Service acceptance requires Windows');
const ps = source => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${source}`], { encoding: 'utf8', timeout: 30000 }).trim();
assert.equal(ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"), 'True', 'CI service smoke requires an elevated isolated runner');
const helper = path.resolve('resources/service/Luma.Service.exe');
const client = new ServiceClient({ resourcesDir: path.resolve('resources') });
assert.equal((await client.status()).installed, false, 'Refuse to touch a pre-existing service');
assert.equal(ps("@(Get-NetAdapter -Name LumaServiceCI -ErrorAction SilentlyContinue).Count"), '0', 'Refuse to touch a pre-existing test adapter');
const sid = await client.ownerSid();
let providerRequests = 0;
const local = http.createServer((req, res) => { if (req.url === '/provider') { assert.equal(req.headers['user-agent'], 'LumaProviderFixture'); providerRequests++; res.end(Buffer.from(`ss://${Buffer.from('aes-128-gcm:local-fixture-password').toString('base64')}@127.0.0.1:12345#Local-provider-node`).toString('base64')); } else res.end('luma-service-local-ok'); });
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
  const selectedCore = path.resolve('resources/core/mihomo.exe'), digest = coreDigest(selectedCore), encodedCore = Buffer.from(selectedCore).toString('base64');
  assert.equal((await client.status()).coreSha256, digest);
  assert.throws(() => execFileSync(helper, ['--sync-core', sid, String(process.pid), encodedCore, '0'.repeat(64)], { timeout: 60000 }), 'Changed image must not replace protected core');
  execFileSync(helper, ['--sync-core', sid, String(process.pid), encodedCore, digest], { timeout: 60000 });
  await waitFor(async () => { const state = await client.status(); return state.running && state.coreSha256 === digest; }, 'protected selected core sync');
  console.log('Protected core digest, rejected changed image, explicit fixed-target synchronization and service restart passed');

  const withProvider = base + `proxy-providers:\n  Fixture:\n    type: http\n    url: http://127.0.0.1:${local.address().port}/provider\n    interval: 1\n    header: {User-Agent: [LumaProviderFixture]}\n    health-check: {enable: false}\nproxy-groups: [{name: Provider group, type: select, use: [Fixture]}]\n`;
  await client.start({ config: withProvider, ownerPid: process.pid });
  await waitFor(async () => (await client.api('/providers/proxies/Fixture')).proxies?.some(p => p.name === 'Local-provider-node'), 'normalized service provider node');
  await waitFor(() => providerRequests >= 2, 'automatic provider refresh preserves interval and custom header');
  const beforeRefresh = providerRequests; await client.api('/providers/proxies/Fixture', 'PUT'); assert.ok(providerRequests > beforeRefresh);
  await client.stop(); console.log('Service URI/base64 provider, custom header, automatic interval and manual refresh passed using loopback fixture');

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
} catch (error) {
  // Ephemeral CI machine only: no configuration/controller credentials are printed.
  try { console.error('Service failure diagnostics:', ps("$service=Get-Service LumaProxyService -ErrorAction SilentlyContinue | Select-Object Name,Status; $processes=Get-Process -Name Luma.Service,mihomo -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,StartTime; $events=Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue | Where-Object {$_.ProviderName -in @('LumaProxyService','.NET Runtime','Application Error')} | Select-Object -First 5 TimeCreated,ProviderName,@{n='Message';e={$_.Message.Substring(0,[Math]::Min(2000,$_.Message.Length))}}; @{service=$service;processes=$processes;events=$events}|ConvertTo-Json -Depth 4")); } catch (diagnosticError) { console.error('OS diagnostics unavailable:', diagnosticError.message); }
  throw error;
} finally {
  if (owner?.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(owner.pid), '/F']); } catch {} }
  if (installed) { try { await client.stop(); } catch {} execFileSync(helper, ['--uninstall', sid, String(process.pid)], { timeout: 60000 }); assert.equal((await client.status()).installed, false); }
  local.close();
}
