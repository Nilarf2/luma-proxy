const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { runtimeConfig } = require('./profile.cjs');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); }); }
class Engine {
  constructor(dir, binary, onExit) { this.dir = dir; this.binary = binary; this.onExit = onExit; this.child = null; this.ready = false; this.logs = []; }
  async api(endpoint, method = 'GET', data) {
    const res = await fetch(`http://127.0.0.1:${this.controller}${endpoint}`, { method, headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(endpoint.includes('/delay') ? 12000 : 5000) });
    if (!res.ok) throw Error(`内核请求失败（${res.status}）`); return res.status === 204 ? null : res.json();
  }
  async start(text, mode) {
    await this.stop();
    if (!fs.existsSync(this.binary)) throw Error('找不到代理内核，请重新安装完整客户端');
    this.port = await freePort(); this.controller = await freePort(); this.secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(this.dir, { recursive: true });
    const config = path.join(this.dir, 'runtime.yaml'); fs.writeFileSync(config, runtimeConfig(text, this.port, this.controller, this.secret, mode), { mode: 0o600 });
    const child = spawn(this.binary, ['-d', this.dir, '-f', config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); this.child = child;
    let failure;
    child.on('error', e => { failure = e; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { this.logs.push(...chunk.toString().split('\n').filter(Boolean).map(s => s.replace(/https?:\/\/[^\s"']+/g, '[URL]').replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, '[ID]').slice(0, 600))); this.logs = this.logs.slice(-150); });
    child.on('exit', () => { if (this.child === child) { this.child = null; this.ready = false; this.onExit?.(); } });
    for (let i = 0; i < 100; i++) {
      if (failure || child.exitCode !== null) { await this.stop(); throw Error('代理内核启动失败，请检查订阅配置或端口占用'); }
      try { await this.api('/version'); this.ready = true; return; } catch { await wait(150); }
    }
    await this.stop(); throw Error('内核启动超时，请检查配置需要的规则资源是否可以下载');
  }
  async stop() {
    this.ready = false; const child = this.child; this.child = null;
    if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); child.kill(); await Promise.race([done, wait(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  }
  async stats() {
    if (!this.ready) return { upload: 0, download: 0, connections: [], groups: [] };
    const [p, c] = await Promise.all([this.api('/proxies'), this.api('/connections')]);
    return { upload: c.uploadTotal, download: c.downloadTotal, connections: (c.connections || []).map(x => ({ id: x.id, host: x.metadata.host || x.metadata.destinationIP, process: x.metadata.process || '', rule: x.rule, chains: x.chains, upload: x.upload, download: x.download })), groups: Object.values(p.proxies).filter(x => Array.isArray(x.all)).map(x => ({ name: x.name, type: x.type, now: x.now, nodes: x.all.map(name => ({ name, type: p.proxies[name]?.type, delay: p.proxies[name]?.history?.at(-1)?.delay || 0 })) })) };
  }
}
module.exports = { Engine, freePort };
