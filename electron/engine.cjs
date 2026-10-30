const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { runtimeConfig } = require('./profile.cjs');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); }); }
class Engine {
  constructor(dir, binary, onExit) { this.dir = dir; this.binary = binary; this.onExit = onExit; this.child = null; this.ready = false; this.tunRunning = false; this.logs = []; }
  async api(endpoint, method = 'GET', data) {
    if (this.serviceMode) return this.serviceRunner.api(endpoint, method, data);
    const res = await fetch(`http://127.0.0.1:${this.controller}${endpoint}`, { method, headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(endpoint.includes('/delay') ? Math.min(35000, Math.max(5000, Number(new URL(endpoint, 'http://localhost').searchParams.get('timeout')) + 2000 || 12000)) : 5000) });
    if (!res.ok) throw Error(`内核请求失败（${res.status}）`); return res.status === 204 ? null : res.json();
  }
  async start(text, mode, settings = {}, profileOverride = '') {
    await this.stop();
    if (!fs.existsSync(this.binary)) throw Error('找不到代理内核，请重新安装完整客户端');
    const deadline = Date.now() + 20000;
    this.port = settings.core?.mixedPort || await freePort(); this.controller = await freePort(); this.secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(this.dir, { recursive: true });
    const compiled = runtimeConfig(text, this.port, this.controller, this.secret, mode, settings, profileOverride);
    const expected = require('yaml').parse(compiled);
    const expectedNames = [...(expected.proxies || []), ...(expected['proxy-groups'] || [])].map(value => value.name);
    const verify = async () => { const version = await this.api('/version'); const current = await this.api('/configs'); if (current['mixed-port'] !== this.port || current.mode !== mode || !!current.tun?.enable !== !!settings.core?.tun?.enabled) throw Error('内核配置尚未就绪'); const proxies = await this.api('/proxies'); if (expectedNames.some(name => !proxies.proxies?.[name])) throw Error('策略组尚未就绪'); return version; };
    const config = path.join(this.dir, 'runtime.yaml'); fs.writeFileSync(config, compiled, { mode: 0o600 });
    if (this.service) {
      const result = await this.service.start({ config: fs.readFileSync(config, 'utf8'), ownerPid: process.pid, providers: settings.providerFiles || {} });
      this.serviceMode = true; this.serviceRunner = this.service; this.child = { pid: result.pid, exitCode: null };
      try {
        for (let i = 0; i < 100 && Date.now() < deadline; i++) { try { const v = await verify(); this.version = v.version; this.ready = true; this.tunRunning = !!settings.core?.tun?.enabled; this.startServiceMonitor(); return; } catch { await wait(150); } }
        throw Error('服务内核启动超时');
      } catch (error) { await this.stop(); throw error; }
    }
    const child = spawn(this.binary, ['-d', this.dir, '-f', config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); this.child = child;
    let failure;
    child.on('error', e => { failure = e; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { this.logs.push(...chunk.toString().split('\n').filter(Boolean).map(s => s.replace(/https?:\/\/[^\s"']+/g, '[URL]').replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, '[ID]').slice(0, 600))); this.logs = this.logs.slice(-150); });
    child.on('exit', () => { if (this.child === child) { this.child = null; this.ready = false; this.tunRunning = false; this.logAbort?.abort(); this.onExit?.(); } });
    try { await this.onSpawn?.(child.pid); } catch (error) { await this.stop(); throw error; }
    for (let i = 0; i < 100 && Date.now() < deadline; i++) {
      if (failure || child.exitCode !== null) { await this.stop(); throw Error('代理内核启动失败，请检查订阅配置或端口占用'); }
      try {
        const version = await verify();
        this.version = version.version; this.ready = true; this.tunRunning = !!settings.core?.tun?.enabled;
        this.startLogs(settings.core?.logLevel || 'info'); return;
      } catch { await wait(150); }
    }
    await this.stop(); throw Error('内核启动超时，请检查配置需要的规则资源是否可以下载');
  }
  async stop() {
    this.ready = false; this.tunRunning = false; this.logAbort?.abort(); clearInterval(this.serviceMonitor); const child = this.child; this.child = null;
    if (this.serviceMode) { try { await this.serviceRunner.stop(); } finally { this.serviceMode = false; await this.onStop?.(); } return; }
    if (child && child.exitCode === null) { try { await this.api('/configs', 'PATCH', { tun: { enable: false } }); } catch {} }
    if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); child.kill(); await Promise.race([done, wait(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
    await this.onStop?.();
  }
  startServiceMonitor() {
    clearInterval(this.serviceMonitor); let checking = false;
    this.serviceMonitor = setInterval(async () => { if (checking || !this.serviceMode || !this.ready) return; checking = true; try { const state = await this.serviceRunner.status(); if (!state.coreRunning || state.pid !== this.child?.pid) { clearInterval(this.serviceMonitor); this.child = null; this.ready = false; this.tunRunning = false; this.serviceMode = false; await this.onStop?.(); this.onExit?.(); } } catch {} finally { checking = false; } }, 1500); this.serviceMonitor.unref();
  }
  addLog(text) { this.logs.push(String(text).replace(/https?:\/\/[^\s"']+/g, '[URL]').replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, '[ID]').slice(0, 1200)); this.logs = this.logs.slice(-500); }
  startLogs(level) {
    this.logAbort = new AbortController();
    (async () => {
      const res = await fetch(`http://127.0.0.1:${this.controller}/logs?level=${encodeURIComponent(level === 'silent' ? 'error' : level)}`, { headers: { Authorization: `Bearer ${this.secret}` }, signal: this.logAbort.signal });
      if (!res.ok) return;
      let pending = '';
      for await (const chunk of res.body) { pending += Buffer.from(chunk).toString(); let index; while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1); if (line.trim()) { try { const log = JSON.parse(line); this.addLog(`[${log.type || 'info'}] ${log.payload || line}`); } catch { this.addLog(line); } } } if (pending.length > 16384) pending = ''; }
    })().catch(() => {});
  }
  async stats() {
    if (!this.ready) return { upload: 0, download: 0, connections: [], groups: [] };
    const [p, c] = await Promise.all([this.api('/proxies'), this.api('/connections')]);
    if (this.serviceMode) this.logs = (await this.serviceRunner.logs()).slice(-500);
    return { upload: c.uploadTotal, download: c.downloadTotal, connections: (c.connections || []).map(x => ({ id: x.id, host: x.metadata.host || x.metadata.destinationIP, process: x.metadata.process || '', rule: x.rule, rulePayload: x.rulePayload, start: x.start, metadata: x.metadata, chains: x.chains, upload: x.upload, download: x.download })), groups: Object.values(p.proxies).filter(x => Array.isArray(x.all)).map(x => ({ name: x.name, type: x.type, now: x.now, nodes: x.all.map(name => ({ name, type: p.proxies[name]?.type, delay: p.proxies[name]?.history?.at(-1)?.delay || 0 })) })) };
  }
}
module.exports = { Engine, freePort };
