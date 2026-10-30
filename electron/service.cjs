const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ProviderBridge } = require('./provider-bridge.cjs');
const runFile = promisify(execFile);
const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
function psLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function coreDigest(binaryPath) {
  const fd = fs.openSync(binaryPath, 'r');
  try { const size = fs.fstatSync(fd).size; if (size < 256 || size > 200 * 1024 * 1024) throw Error('内核文件大小无效'); const hash = crypto.createHash('sha256'); const chunk = Buffer.allocUnsafe(1024 * 1024); let count; while ((count = fs.readSync(fd, chunk)) > 0) hash.update(chunk.subarray(0, count)); return hash.digest('hex'); } finally { fs.closeSync(fd); }
}
function validateRequest(request) {
  if (!request || !['status', 'start', 'stop', 'logs', 'api'].includes(request.action)) throw Error('服务命令无效');
  if (request.action === 'start' && (typeof request.config !== 'string' || Buffer.byteLength(request.config) > 8 * 1024 * 1024 || !Number.isSafeInteger(request.ownerPid) || request.ownerPid <= 0)) throw Error('服务配置无效');
  if (request.action === 'start' && request.providers !== undefined) { if (!request.providers || typeof request.providers !== 'object' || Array.isArray(request.providers) || Object.keys(request.providers).length > 128) throw Error('服务本地集合无效'); let total = 0; for (const [name, text] of Object.entries(request.providers)) { if (!/^\.\/providers\/[a-f0-9]{64}\.yaml$/.test(name) || typeof text !== 'string') throw Error('服务本地集合无效'); total += Buffer.byteLength(text); if (total > 8 * 1024 * 1024) throw Error('服务本地集合过大'); } }
  if (request.action === 'api' && (typeof request.endpoint !== 'string' || !request.endpoint.startsWith('/') || request.endpoint.length > 8192 || !['GET', 'PUT', 'PATCH', 'POST', 'DELETE'].includes(request.method))) throw Error('服务接口无效');
  return request;
}
class ServiceClient {
  constructor({ resourcesDir = process.resourcesPath || path.join(__dirname, '..', 'resources'), platform = process.platform, run = runFile, connect = net.createConnection, readCoreDigest = coreDigest, createProviderBridge = () => new ProviderBridge() } = {}) { this.resourcesDir = resourcesDir; this.platform = platform; this.run = run; this.connect = connect; this.readCoreDigest = readCoreDigest; this.createProviderBridge = createProviderBridge; }
  async ownerSid() {
    if (this.platform !== 'win32') throw Error('服务模式仅支持 Windows');
    if (!this.sid) { const { stdout } = await this.run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 }); const match = String(stdout).match(/S-1-5-21-\d+-\d+-\d+-\d+/); if (!match || !SID.test(match[0])) throw Error('无法读取 Windows 用户标识'); this.sid = match[0]; }
    return this.sid;
  }
  async request(request, { signal } = {}) {
    validateRequest(request); const cancelled = () => Object.assign(Error('操作已取消'), { name: 'AbortError' });
    if (signal?.aborted) throw cancelled(); const sid = await this.ownerSid(); if (signal?.aborted) throw cancelled(); const message = JSON.stringify(request) + '\n';
    return new Promise((resolve, reject) => {
      const socket = this.connect(`\\\\.\\pipe\\Luma.Proxy.${sid}`); const decoder = new StringDecoder('utf8'); let output = '', size = 0, settled = false;
      const abort = () => finish(cancelled());
      const finish = (error, result, received = false) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); if (received) { socket.end('\n'); socket.setTimeout(1000, () => socket.destroy()); } else socket.destroy(); error ? reject(error) : resolve(result); };
      signal?.addEventListener('abort', abort, { once: true });
      socket.setTimeout(35000, () => finish(Error('服务响应超时'))); socket.on('error', error => finish(error)); socket.on('connect', () => socket.write(message));
      socket.on('data', bytes => { size += bytes.length; output += decoder.write(bytes); if (size > 12 * 1024 * 1024) return finish(Error('服务响应过大')); const index = output.indexOf('\n'); if (index < 0) return; try { const result = JSON.parse(output.slice(0, index)); if (result.ok !== true) return finish(Error(result.error || '服务请求失败'), null, true); finish(null, result.data, true); } catch { finish(Error('服务响应无效')); } });
      socket.on('end', () => { if (!settled) finish(Error('服务连接意外关闭')); });
    });
  }
  async status() {
    if (this.platform !== 'win32') return { installed: false, running: false, coreRunning: false, pid: null, error: '服务模式仅支持 Windows' };
    try { const state = await this.request({ action: 'status' }); if (!state.coreRunning && this.providerBridge) { await this.providerBridge.dispose(); this.providerBridge = null; } return state; }
    catch (error) { let installed = false; try { const { stdout } = await this.run('sc.exe', ['query', 'LumaProxyService'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 }); installed = /LumaProxyService/i.test(stdout); } catch {} return { installed, running: false, coreRunning: false, pid: null, error: ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? '' : '无法连接当前用户的 Luma 服务' }; }
  }
  async elevate(action, extra = []) {
    if (!['install', 'uninstall', 'sync-core'].includes(action)) throw Error('服务操作无效'); const sid = await this.ownerSid();
    const helper = path.join(this.resourcesDir, 'service', 'Luma.Service.exe');
    const args = [`--${action}`, sid, String(process.pid), ...extra].map(psLiteral).join(',');
    const script = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath ${psLiteral(helper)} -ArgumentList @(${args}) -Verb RunAs -Wait -PassThru; if($p.ExitCode -ne 0){throw 'Luma 服务操作失败，请检查 Windows 权限及安全软件'};`;
    try { await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 180000, maxBuffer: 16384 }); } catch { throw Error('服务操作未完成；如已取消权限请求，可以继续使用系统代理模式'); }
    return this.status();
  }
  install() { return this.elevate('install'); }
  uninstall() { return this.elevate('uninstall'); }
  async syncCore(binaryPath, expectedHash) {
    if (this.platform !== 'win32') throw Error('服务模式仅支持 Windows');
    if (typeof binaryPath !== 'string' || !path.win32.isAbsolute(binaryPath) || !/^[a-z]:\\[^:\r\n]*$/i.test(binaryPath)) throw Error('请选择本机 Windows 内核文件');
    const digest = this.readCoreDigest(binaryPath); if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('内核校验无效');
    if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== digest)) throw Error('UAC 前内核已更改，请重新同步');
    return this.elevate('sync-core', [Buffer.from(binaryPath, 'utf8').toString('base64'), digest]);
  }
  async start({ config, ownerPid = process.pid, providers }) {
    const request = validateRequest({ action: 'start', config, ownerPid, ...(providers === undefined ? {} : { providers }) }); const bridge = this.createProviderBridge();
    try { const converted = await bridge.start(config); const result = await this.request({ ...request, config: converted.config }); const previous = this.providerBridge; this.providerBridge = bridge; await previous?.dispose(); return result; } catch (error) { await bridge.dispose(); throw error; }
  }
  async stop() { const result = await this.request({ action: 'stop' }); await this.providerBridge?.dispose(); this.providerBridge = null; return result; }
  logs() { return this.request({ action: 'logs' }); }
  api(endpoint, method = 'GET', data, options = {}) { return this.request({ action: 'api', endpoint, method, ...(data === undefined ? {} : { data }) }, options); }
}
module.exports = { ServiceClient, validateRequest, psLiteral, coreDigest };
