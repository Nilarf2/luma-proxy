import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
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
local.on('connect', (req, socket, head) => {
  // Mihomo's HTTP proxy adapter uses CONNECT even for HTTP destinations.
  // The reserved TUN destination is mapped to this local origin, never dialed.
  if (req.url !== '198.18.0.2:18123') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const origin = net.connect(local.address().port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) origin.write(head);
    socket.pipe(origin); origin.pipe(socket);
  });
  socket.on('error', () => origin.destroy()); origin.on('error', () => socket.destroy());
  socket.on('close', () => origin.destroy()); origin.on('close', () => socket.destroy());
});
local.listen(0, '127.0.0.1'); await once(local, 'listening');
const base = `mixed-port: 0\nmode: rule\nlog-level: warning\nipv6: false\ndns: {enable: false}\nproxies:\n  - {name: Local fixture, type: http, server: 127.0.0.1, port: ${local.address().port}}\nrules: ['MATCH,Local fixture']\n`;
const waitFor = async (fn, label) => { const until = Date.now() + 60000; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 250)); } throw Error(`${label}: ${JSON.stringify(last)}`); };
const ownerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-limited-owner-'));
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
  // SAFER Basic User retains the installing SID while stripping administrator privileges.
  // Assert the actual child token; never silently fall back to the elevated harness.
  const ownerScript = path.join(ownerDir, 'owner.cjs'), ownerState = path.join(ownerDir, 'state.json');
  const identityCommand = "$id=[Security.Principal.WindowsIdentity]::GetCurrent(); @{sid=$id.User.Value;admin=([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress";
  const code = `const fs=require('node:fs');const {execFileSync}=require('node:child_process');const {ServiceClient}=require(${JSON.stringify(path.resolve('electron/service.cjs'))});let state={pid:process.pid};const save=()=>{fs.writeFileSync(${JSON.stringify(ownerState)}+'.tmp',JSON.stringify(state));fs.renameSync(${JSON.stringify(ownerState)}+'.tmp',${JSON.stringify(ownerState)});};(async()=>{state={...state,...JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',${JSON.stringify(identityCommand)}],{encoding:'utf8',windowsHide:true,timeout:10000}))};save();if(state.sid!==${JSON.stringify(sid)}||state.admin!==false)throw Error('Basic User token identity/elevation assertion failed');const c=new ServiceClient({resourcesDir:${JSON.stringify(path.resolve('resources'))}});const started=await c.start({config:${JSON.stringify(tun)},ownerPid:process.pid});state.started=true;state.corePid=started.pid;save();setInterval(()=>{},1000);})().catch(e=>{state.error=e.message;save();process.exit(1);});`;
  fs.writeFileSync(ownerScript, code);
  const launcher = spawn('runas.exe', ['/trustlevel:0x20000', `"${process.execPath}" "${ownerScript}"`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let launcherOutput = '';
  launcher.stdout.on('data', bytes => launcherOutput += bytes.toString()); launcher.stderr.on('data', bytes => launcherOutput += bytes.toString());
  launcher.on('error', error => { launcherOutput += error.message; });
  const startedOwner = await waitFor(async () => {
    if (fs.existsSync(ownerState)) { const value = JSON.parse(fs.readFileSync(ownerState, 'utf8')); owner = { pid: value.pid, exitCode: null }; if (value.error) throw Error(value.error); assert.equal(value.sid, sid); assert.equal(value.admin, false); if (value.started) return value; }
    if (launcher.exitCode !== null && launcher.exitCode !== 0) throw Error(`Basic User launcher failed: ${launcherOutput}`);
    return false;
  }, 'same-SID non-administrator TUN owner');
  assert.equal((await client.status()).pid, startedOwner.corePid);
  console.log('Actual Basic User token verified: installing SID retained and Administrator role false');
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
  fs.rmSync(ownerDir, { recursive: true, force: true });
}
