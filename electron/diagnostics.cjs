const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const labels = { kernel: '代理内核', recovery: '异常退出保护', systemProxy: 'Windows 系统代理', launchAtLogin: '开机启动' };
const item = (id, status, detail) => ({ id, label: labels[id], status, detail });
async function kernelVersion(binary) {
  // -v exits before loading any profile, provider, rules or network listeners.
  const { stdout } = await exec(binary, ['-v'], { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 });
  const version = String(stdout).match(/(?:Mihomo|Clash(?: Meta)?)\s+(v?[\w.+-]+)/i)?.[1];
  if (!version) throw Error('内核版本响应无效');
  return `Mihomo ${version}`;
}
class Diagnostics {
  constructor(options) {
    this.options = options;
    this.state = { checking: false, checkedAt: null, status: 'idle', items: [] };
    this.inFlight = null;
  }
  run() {
    if (this.inFlight) return this.inFlight;
    this.state = { ...this.state, checking: true };
    const task = Promise.resolve().then(() => this.check()).finally(() => { this.inFlight = null; });
    this.inFlight = task;
    this.options.onChange?.(this.state);
    return task;
  }
  async check() {
    const o = this.options;
    const safe = async (id, check, failure) => {
      try { return await check(); }
      catch { return item(id, 'error', failure); }
    };
    const windows = o.platform === 'win32';
    const items = await Promise.all([
      safe('kernel', async () => item('kernel', 'ok', await (o.kernelVersion || kernelVersion)(o.binary)), '内核不可用，请重新安装完整客户端后重试。'),
      windows ? safe('recovery', async () => { await o.ensureRecovery(); return item('recovery', 'ok', '恢复进程已就绪并通过存活验证。'); }, '异常退出保护不可用，连接前会再次检查；保护就绪前不会启用系统代理。') : item('recovery', 'skipped', '此项仅适用于 Windows。'),
      windows ? safe('systemProxy', async () => {
        const result = await o.inspectProxy();
        if (result.ownership === 'stale' || result.recoveryPending && result.ownership !== 'ours') return item('systemProxy', 'warning', '检测到待恢复的代理记录，请检查 Windows 代理设置。');
        if (result.ownership === 'external') return item('systemProxy', 'warning', '系统代理由其他应用或手动设置管理，检测不会改动它。');
        return item('systemProxy', 'ok', result.ownership === 'ours' ? '系统代理由 Luma 管理，恢复记录有效。' : '系统代理未启用。');
      }, '无法读取 Windows 代理设置，请稍后重试。') : item('systemProxy', 'skipped', '此项仅适用于 Windows。'),
      windows && !o.portable ? safe('launchAtLogin', async () => {
        const settings = await o.getLoginSettings();
        const enabled = settings.executableWillLaunchAtLogin;
        if (typeof enabled !== 'boolean') throw Error('开机启动状态响应无效');
        return item('launchAtLogin', enabled === !!o.launchAtLogin() ? 'ok' : 'warning', enabled === !!o.launchAtLogin() ? (enabled ? 'Windows 已启用 Luma 开机启动。' : 'Windows 未启用 Luma 开机启动。') : 'Windows 开机启动状态与偏好设置不同，请重新设置开机启动开关。');
      }, '无法读取 Windows 开机启动设置，请稍后重试。') : item('launchAtLogin', 'skipped', windows ? '便携版不支持开机启动。' : '此项仅适用于 Windows。'),
    ]);
    this.state = { checking: false, checkedAt: new Date().toISOString(), status: items.some(i => i.status === 'error') ? 'error' : items.some(i => i.status === 'warning') ? 'warning' : 'ok', items };
    this.options.onChange?.(this.state);
    return this.state;
  }
}
module.exports = { Diagnostics, kernelVersion };
