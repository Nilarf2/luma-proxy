const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseProfile, parseOverride } = require('./profile.cjs');
const { normalizeSettings, validateSettingsPatch } = require('./settings.cjs');
const { validateScript } = require('./compose.cjs');
const { normalizeDownload } = require('./download.cjs');
const exec = promisify(execFile);
const MAX_BACKUP = 64 * 1024 * 1024;
const APP_REPO = 'Nilarf2/luma-proxy';
const CORE_REPO = 'MetaCubeX/mihomo';
function json(text) { return JSON.parse(text, (k, v) => { if (['__proto__', 'prototype', 'constructor'].includes(k)) throw Error('文件包含无效字段'); return v; }); }
function makeBackup(store) {
  const assets = {};
  const settings = structuredClone(store.data);
  if (settings.controller) { delete settings.controller.secret; settings.controller.enabled = false; }
  for (const p of store.data.profiles) for (const filename of Object.values(p.localProviders || {})) {
    if (!/^[a-f0-9]{64}\.yaml$/.test(filename)) throw Error('本地集合文件无效');
    const file = path.join(store.dir, 'provider-assets', filename); if (fs.statSync(file).size > 8 * 1024 * 1024) throw Error('集合文件不能超过 8 MB');
    assets[filename] = fs.readFileSync(file, 'utf8');
  }
  return { format: 'luma-backup', version: 1, createdAt: new Date().toISOString(), settings,
    files: Object.fromEntries(store.data.profiles.map(p => [p.id, fs.readFileSync(store.profilePath(p.id), 'utf8')])), assets };
}
function validateBackup(input) {
  if (typeof input === 'string' || Buffer.isBuffer(input)) { if (Buffer.byteLength(input) > MAX_BACKUP) throw Error('备份不能超过 64 MB'); input = json(String(input)); }
  if (input?.format !== 'luma-backup' || input.version !== 1 || !Array.isArray(input.settings?.profiles) || input.settings.profiles.length > 200 || !input.files || typeof input.files !== 'object') throw Error('备份格式无效');
  const ids = new Set();
  for (const p of input.settings.profiles) {
    if (!p || !/^[a-f0-9-]{36}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || p.name.length > 80) throw Error('备份订阅无效');
    ids.add(p.id); parseProfile(input.files[p.id]); parseOverride(p.override || '');
    if (p.url) { const u = new URL(p.url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('备份订阅地址无效'); }
    validateScript(p.script ?? ''); normalizeDownload(p.download);
    if (p.sourceIds !== undefined && (!Array.isArray(p.sourceIds) || p.sourceIds.length > 200 || new Set(p.sourceIds).size !== p.sourceIds.length || p.sourceIds.some(v => typeof v !== 'string'))) throw Error('合并来源无效');
    for (const [key, filename] of Object.entries(p.localProviders || {})) {
      if (!/^(proxy-providers|rule-providers):.{1,1024}$/.test(key) || !/^[a-f0-9]{64}\.yaml$/.test(filename) || typeof input.assets?.[filename] !== 'string' || Buffer.byteLength(input.assets[filename]) > 8 * 1024 * 1024) throw Error('本地集合文件无效');
      parseOverride(input.assets[filename]);
    }
  }
  const profiles = new Map(input.settings.profiles.map(p => [p.id, p]));
  const checked = new Set();
  function visit(id, path = new Set()) {
    if (!profiles.has(id)) throw Error('合并来源不存在');
    if (path.has(id)) throw Error('合并来源存在循环引用');
    if (checked.has(id)) return;
    const next = new Set(path); next.add(id);
    for (const source of profiles.get(id).sourceIds || []) visit(source, next);
    checked.add(id);
  }
  for (const id of ids) visit(id);
  if (input.settings.activeId !== null && !ids.has(input.settings.activeId)) throw Error('备份当前订阅无效');
  const normalized = normalizeSettings(input.settings);
  const settings = validateSettingsPatch(normalized, normalized);
  parseOverride(settings.globalOverride || '');
  return { settings, files: input.files, assets: input.assets || {} };
}
async function restoreBackup(store, input, disconnect) {
  const { settings, files, assets } = validateBackup(input);
  const previous = store.data;
  const originals = new Map(settings.profiles.map(p => [p.id, fs.existsSync(store.profilePath(p.id)) ? fs.readFileSync(store.profilePath(p.id)) : null]));
  const assetNames = new Set(settings.profiles.flatMap(p => Object.values(p.localProviders || {})));
  const assetDir = path.join(store.dir, 'provider-assets');
  const originalAssets = new Map([...assetNames].map(name => [name, fs.existsSync(path.join(assetDir, name)) ? fs.readFileSync(path.join(assetDir, name)) : null]));
  // Machine-local executable and login registration are never copied from another machine.
  settings.customCore = previous.customCore;
  settings.launchAtLogin = previous.launchAtLogin;
  settings.controller.secret = previous.controller?.secret || '';
  settings.controller.enabled = false;
  await disconnect();
  try {
    if (assetNames.size) fs.mkdirSync(assetDir, { recursive: true });
    for (const filename of assetNames) { fs.writeFileSync(path.join(assetDir, filename + '.restore'), assets[filename], { mode: 0o600 }); fs.renameSync(path.join(assetDir, filename + '.restore'), path.join(assetDir, filename)); }
    for (const p of settings.profiles) { const target = store.profilePath(p.id); fs.writeFileSync(target + '.restore', files[p.id], { mode: 0o600 }); fs.renameSync(target + '.restore', target); }
    store.data = settings; store.save();
  } catch (error) {
    store.data = previous;
    for (const [filename, original] of originalAssets) { try { const target = path.join(assetDir, filename); if (original) fs.writeFileSync(target, original, { mode: 0o600 }); else fs.rmSync(target, { force: true }); fs.rmSync(target + '.restore', { force: true }); } catch {} }
    for (const [id, original] of originals) { try { const target = store.profilePath(id); if (original) fs.writeFileSync(target, original, { mode: 0o600 }); else fs.rmSync(target, { force: true }); fs.rmSync(target + '.restore', { force: true }); } catch {} }
    try { store.save(); } catch {}
    throw error;
  }
  return { profiles: settings.profiles.length };
}
function davOptions(payload) {
  if (!payload || typeof payload.url !== 'string') throw Error('请输入 WebDAV 地址');
  const url = new URL(payload.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('WebDAV 需要 HTTPS 地址');
  if (typeof payload.username !== 'string' || typeof payload.password !== 'string' || payload.username.includes(':') || /[\r\n\0]/.test(payload.username + payload.password)) throw Error('WebDAV 账号无效');
  return { url: url.href, headers: { Authorization: 'Basic ' + Buffer.from(payload.username + ':' + payload.password).toString('base64'), 'Content-Type': 'application/json' } };
}
async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw Error('下载文件过大');
  let total = 0; const chunks = [];
  for await (const chunk of response.body) { total += chunk.length; if (total > limit) throw Error('下载文件过大'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function officialAsset(asset, repo) {
  const u = new URL(asset?.browser_download_url || 'https://invalid/');
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !u.pathname.startsWith('/' + repo + '/releases/download/') || u.username || u.password || !/^sha256:[0-9a-f]{64}$/.test(asset.digest || '')) throw Error('更新文件缺少官方校验信息');
  return asset;
}
function verifyDigest(bytes, digest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest || '') || crypto.createHash('sha256').update(bytes).digest('hex') !== digest.slice(7)) throw Error('更新文件校验失败');
}
function newerVersion(candidate, current) {
  const parse = value => /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value || '');
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) { if (+a[i] !== +b[i]) return +a[i] > +b[i]; }
  if (!a[4] || !b[4]) return !!b[4] && !a[4];
  const left = a[4].split('.'), right = b[4].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === undefined || right[i] === undefined) return left[i] !== undefined;
    const an = /^\d+$/.test(left[i]), bn = /^\d+$/.test(right[i]);
    return an && bn ? +left[i] > +right[i] : an !== bn ? !an : left[i] > right[i];
  }
  return false;
}
async function fetchRelease(repo, channel = 'stable', fetcher = fetch) {
  if (!['stable', 'alpha'].includes(channel)) throw Error('更新通道无效');
  const suffix = channel === 'alpha' ? '/tags/Prerelease-Alpha' : '/latest';
  let response = await fetcher(`https://api.github.com/repos/${repo}/releases${suffix}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Luma' }, signal: AbortSignal.timeout(30000) });
  let release;
  if (response.status === 404 && repo === APP_REPO && channel === 'stable') {
    response = await fetcher(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Luma' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`检查更新失败（${response.status}）`);
    const releases = json((await readLimited(response, 4 * 1024 * 1024)).toString());
    release = Array.isArray(releases) ? releases.find(r => !r.draft) : null;
  }
  if (!response.ok) throw Error(`检查更新失败（${response.status}）`);
  release ||= json((await readLimited(response, 4 * 1024 * 1024)).toString());
  if (typeof release?.tag_name !== 'string' || !Array.isArray(release.assets)) throw Error('更新信息无效');
  return release;
}
async function downloadAsset(asset, repo, fetcher = fetch, signal) {
  officialAsset(asset, repo);
  const res = await fetcher(asset.browser_download_url, { signal: signal || AbortSignal.timeout(300000), headers: { 'User-Agent': 'Luma' } });
  if (!res.ok) throw Error(`下载失败（${res.status}）`);
  const bytes = await readLimited(res, 350 * 1024 * 1024); verifyDigest(bytes, asset.digest); return bytes;
}
async function coreVersion(file) {
  const { stdout } = await exec(file, ['-v'], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const version = stdout.match(/Mihomo\s+([^\s]+)/i)?.[1];
  if (!version) throw Error('请选择兼容的 Mihomo 内核'); return version;
}
function coreAsset(release, platform = process.platform) {
  const name = platform === 'win32' ? /^mihomo-windows-amd64-compatible-.+\.zip$/ : /^mihomo-linux-amd64-compatible-.+\.gz$/;
  const asset = release.assets.find(x => name.test(x.name));
  if (!asset) throw Error('此版本没有适用的 x64 内核'); return officialAsset(asset, CORE_REPO);
}
function registerMaintenance(ctx) {
  const { handle, app, dialog, getWindow, store, engine, exclusive, disconnect, publish, asset } = ctx;
  const shell = ctx.shell || require('electron').shell;
  const fetcher = ctx.fetch || fetch;
  let coreUpdate = null, appUpdate = null, downloaded = null, controller = null, lastBackup = 0;
  const operation = fn => exclusive(async () => { try { return await fn(); } finally { publish(); } });
  const managed = () => path.join(store.dir, 'managed-core', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  async function installCore(source) {
    const version = await coreVersion(source); await disconnect();
    const priorBinary = engine.binary, priorCustom = store.data.customCore;
    const target = managed(); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target + '.new'); fs.chmodSync(target + '.new', 0o700);
    const previous = fs.existsSync(target) ? target + '.previous' : null;
    if (previous) { fs.rmSync(previous, { force: true }); fs.renameSync(target, previous); }
    try { fs.renameSync(target + '.new', target); engine.binary = target; store.data.customCore = true; store.save(); if (previous) fs.rmSync(previous, { force: true }); }
    catch (error) { fs.rmSync(target, { force: true }); if (previous) fs.renameSync(previous, target); engine.binary = priorBinary; store.data.customCore = priorCustom; try { store.save(); } catch {} throw error; }
    return { version };
  }
  handle('backup:export', () => operation(async () => {
    const result = await dialog.showSaveDialog(getWindow(), { title: '备份', defaultPath: 'Luma-backup.json', filters: [{ name: 'Luma', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, JSON.stringify(makeBackup(store)), { mode: 0o600 }); return { saved: true };
  }));
  async function confirmRestore(input) {
    const parsed = validateBackup(input);
    const choice = await dialog.showMessageBox(getWindow(), { type: 'question', message: '恢复备份？', buttons: ['取消', '恢复'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    const result = await restoreBackup(store, { format: 'luma-backup', version: 1, settings: parsed.settings, files: parsed.files, assets: parsed.assets }, disconnect);
    await ctx.applySettings?.(); return result;
  }
  handle('backup:import', () => operation(async () => {
    const result = await dialog.showOpenDialog(getWindow(), { title: '恢复备份', filters: [{ name: 'Luma', extensions: ['json'] }], properties: ['openFile'] });
    if (result.canceled) return null;
    if (fs.statSync(result.filePaths[0]).size > MAX_BACKUP) throw Error('备份不能超过 64 MB');
    return confirmRestore(fs.readFileSync(result.filePaths[0], 'utf8'));
  }));
  for (const direction of ['upload', 'download']) handle('backup:webdav:' + direction, payload => operation(async () => {
    const { url, headers } = davOptions(payload);
    if (payload.etag && direction === 'upload') headers['If-Match'] = String(payload.etag).slice(0, 1024);
    const response = await fetcher(url, { method: direction === 'upload' ? 'PUT' : 'GET', headers, redirect: 'error', body: direction === 'upload' ? JSON.stringify(makeBackup(store)) : undefined, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`WebDAV 请求失败（${response.status}）`);
    if (direction === 'upload') return { saved: true, etag: response.headers.get('etag') };
    const result = await confirmRestore((await readLimited(response, MAX_BACKUP)).toString());
    return result ? { ...result, etag: response.headers.get('etag') } : null;
  }));
  handle('core:import', () => operation(async () => {
    const result = await dialog.showOpenDialog(getWindow(), { title: '选择 Mihomo', filters: [{ name: 'Mihomo', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }], properties: ['openFile'] });
    return result.canceled ? null : installCore(result.filePaths[0]);
  }));
  handle('core:reset', () => operation(async () => {
    const target = path.join(asset('core'), process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
    const version = await coreVersion(target); await disconnect();
    const previous = { binary:engine.binary, custom:store.data.customCore };
    try { store.data.customCore = false; engine.binary = target; store.save(); }
    catch (error) { engine.binary = previous.binary; store.data.customCore = previous.custom; throw error; }
    return { version };
  }));
  async function checkCore(channel) {
    const release = await fetchRelease(CORE_REPO, channel, fetcher);
    const selected = coreAsset(release); const current = engine.version || await coreVersion(engine.binary).catch(() => '');
    coreUpdate = { version: release.tag_name, channel, current, available: channel === 'alpha' || newerVersion(release.tag_name, current) };
    return { release, selected };
  }
  handle('core:check-update', payload => operation(async () => { await checkCore(payload?.channel || 'stable'); return coreUpdate; }));
  handle('core:update', payload => operation(async () => {
    const { selected } = await checkCore(payload?.channel || 'stable'); controller = new AbortController();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-core-'));
    try {
      const bytes = await downloadAsset(selected, CORE_REPO, fetcher, controller.signal);
      const binary = path.join(temp, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
      if (process.platform === 'win32') {
        const archive = path.join(temp, 'core.zip'); fs.writeFileSync(archive, bytes);
        const data = Buffer.from(JSON.stringify({ archive, binary })).toString('base64');
        const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json; $z=[IO.Compression.ZipFile]::OpenRead($v.archive); try { $e=@($z.Entries|Where-Object {$_.Name -match '^mihomo.*\\.exe$'}); if($e.Count -ne 1){throw 'Invalid archive'}; [IO.Compression.ZipFileExtensions]::ExtractToFile($e[0],$v.binary,$true) } finally {$z.Dispose()}`;
        await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30000, windowsHide: true });
      } else { fs.writeFileSync(binary, zlib.gunzipSync(bytes, { maxOutputLength: 200 * 1024 * 1024 }), { mode: 0o700 }); }
      const result = await installCore(binary); coreUpdate.available = false; return result;
    } finally { controller = null; fs.rmSync(temp, { recursive: true, force: true }); }
  }));
  async function checkApp() {
    const release = await fetchRelease(APP_REPO, 'stable', fetcher); const current = app.getVersion();
    // Public prereleases are listed separately from GitHub's stable /latest endpoint.
    appUpdate = { current, version: release.tag_name, available: newerVersion(release.tag_name, current), url: `https://github.com/${APP_REPO}/releases/tag/${encodeURIComponent(release.tag_name)}` };
    return release;
  }
  handle('app:check-update', () => operation(async () => { await checkApp(); return appUpdate; }));
  handle('app:open-release', () => shell.openExternal(`https://github.com/${APP_REPO}/releases`));
  handle('app:download-update', () => operation(async () => {
    if (process.platform !== 'win32') throw Error('仅支持 Windows');
    const release = await checkApp();
    const selected = release.assets.find(x => /^Luma-[\w.+-]+-x64-Setup\.exe$/.test(x.name));
    if (!selected) throw Error('没有可用的安装程序');
    controller = new AbortController();
    try { const bytes = await downloadAsset(selected, APP_REPO, fetcher, controller.signal); if (bytes.subarray(0, 2).toString() !== 'MZ') throw Error('安装程序无效'); const file = path.join(app.getPath('temp'), 'Luma-update-' + crypto.randomUUID() + '.exe'); fs.writeFileSync(file, bytes, { mode: 0o700 }); downloaded = { path: file, digest: selected.digest, version: release.tag_name }; return { path: file, version: downloaded.version }; }
    finally { controller = null; }
  }));
  handle('update:cancel', () => { controller?.abort(); return null; });
  handle('app:install-update', () => operation(async () => {
    if (!downloaded) throw Error('请先下载安装程序');
    verifyDigest(fs.readFileSync(downloaded.path), downloaded.digest); await disconnect();
    const error = await shell.openPath(downloaded.path); if (error) throw Error('安装程序启动失败'); setImmediate(() => app.quit()); return { launched: true };
  }));
  handle('backup:open-folder', async () => { const dir = path.join(store.dir, 'backups'); fs.mkdirSync(dir, { recursive: true }); const error = await shell.openPath(dir); if (error) throw Error('无法打开备份文件夹'); });
  const timer = setInterval(() => {
    const hours = store.data.backupIntervalHours;
    if (!Number.isFinite(hours) || hours <= 0 || Date.now() - lastBackup < hours * 3600000 || ctx.isBusy?.() || ctx.isQuitting?.()) return;
    lastBackup = Date.now();
    try {
      const dir = path.join(store.dir, 'backups'); fs.mkdirSync(dir, { recursive: true });
      const filename = 'Luma-' + new Date().toISOString().replaceAll(':', '-') + '.json';
      fs.writeFileSync(path.join(dir, filename + '.tmp'), JSON.stringify(makeBackup(store)), { mode: 0o600 }); fs.renameSync(path.join(dir, filename + '.tmp'), path.join(dir, filename));
      const old = fs.readdirSync(dir).filter(name => /^Luma-\d{4}-.+\.json$/.test(name)).sort().reverse().slice(7); for (const name of old) fs.rmSync(path.join(dir, name));
    } catch (error) { engine.addLog?.('[warning] 自动备份失败'); }
  }, 30000); timer.unref();
  return { snapshot: () => ({ coreUpdate, appUpdate }), dispose: () => { clearInterval(timer); controller?.abort(); } };
}
module.exports = { registerMaintenance, makeBackup, validateBackup, restoreBackup, davOptions, readLimited, verifyDigest, officialAsset, fetchRelease, downloadAsset, coreAsset, newerVersion };
