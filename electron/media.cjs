const { spawn } = require('node:child_process');
const path = require('node:path');
class MediaChecks {
  constructor(binary, launch = spawn) { this.binary = binary; this.launch = launch; this.child = null; this.items = null; }
  async request(payload) {
    if (this.child) throw Error('检测正在进行');
    const limit = payload.action === 'list' ? 10000 : payload.check ? 25000 : 90000;
    return new Promise((resolve, reject) => {
      const child = this.launch(this.binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child;
      const chunks = []; let size = 0, settled = false;
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (this.child === child) this.child = null; child.kill(); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => finish(Error('检测超时')), limit); timer.unref();
      child.once('error', () => finish(Error('检测组件不可用，请重新安装完整客户端')));
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) return finish(Error('检测响应过大')); chunks.push(chunk); });
      child.stderr.resume();
      child.once('close', code => {
        if (settled) return;
        if (child.lumaCanceled) return finish(Error('检测已取消'));
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (code !== 0 || result.ok !== true || !Array.isArray(result.items) || result.items.length > 64) throw Error();
          const items = result.items.map(item => {
            if (!item || typeof item.name !== 'string' || item.name.length > 100 || typeof item.status !== 'string' || item.status.length > 100) throw Error();
            return { name: item.name, status: item.status, region: typeof item.region === 'string' ? item.region.slice(0, 128) : null, check_time: typeof item.check_time === 'string' ? item.check_time.slice(0, 128) : null };
          });
          finish(null, items);
        } catch { finish(Error('检测未完成，请检查当前连接')); }
      });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload) + '\n');
    });
  }
  async list() { if (!this.items) this.items = await this.request({ action: 'list' }); return this.items; }
  async check(port, name) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('请先连接内核');
    const previous = await this.list();
    if (name !== undefined && (typeof name !== 'string' || !previous.some(item => item.name === name))) throw Error('检测项目无效');
    const items = await this.request({ action: 'check', proxyPort: port, ...(name === undefined ? {} : { check: name }) });
    if (items.some(item => !previous.some(old => old.name === item.name))) throw Error('检测响应无效');
    this.items = previous.map(old => items.find(item => item.name === old.name) || old);
    return this.items;
  }
  cancel() { if (this.child) { this.child.lumaCanceled = true; this.child.kill(); } }
}
function registerMedia(ctx) {
  const checks = new MediaChecks(path.join(ctx.asset('media'), process.platform === 'win32' ? 'luma-media.exe' : 'luma-media'));
  ctx.handle('media:list', () => checks.list());
  ctx.handle('media:check', payload => { if (!ctx.engine.ready) throw Error('请先连接内核'); if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'check'))) throw Error('检测参数无效'); return checks.check(ctx.engine.port, payload?.check); });
  ctx.handle('media:cancel', () => checks.cancel());
  return { dispose: () => checks.cancel() };
}
module.exports = { MediaChecks, registerMedia };
