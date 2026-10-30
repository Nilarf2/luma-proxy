const net = require('node:net');
const defaults = () => ({ profiles: [], activeId: null, mode: 'rule', launchAtLogin: false, closeToTray: true, startupCheck: true, lightweightMode: false, autoConnect: false, startMinimized: false, systemProxyOnConnect: true, globalOverride: '', globalScript: '', customCore: false, notifications: true, proxyGuard: true, reconnectOnNetworkChange: true, backupIntervalHours: 0, latency: { url: 'https://www.gstatic.com/generate_204', timeout: 7000, intervalMinutes: 0 }, hotkeys: { toggle: '', show: '', tun: '' },
  appearance: { showTrafficHistory: false, mode: 'light', accent: '#2563eb', sidebar: null, customCss: '', navOrder: ['overview', 'proxies', 'profiles', 'connections', 'rules', 'logs', 'settings'], hiddenNav: [] },
  core: { mixedPort: 0, httpPort: 0, socksPort: 0, allowLan: false, ipv6: false, logLevel: 'info', bypass: '<local>;localhost;127.*;[::1]', proxyMode: 'manual', pacScript: '', tun: { enabled: false, stack: 'mixed', autoRoute: true, strictRoute: true, mtu: 1500, routeExcludeAddress: [] }, dns: { enabled: true, enhancedMode: 'fake-ip', nameserver: ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'], fallback: [], fakeIpFilter: ['*.lan', '*.local', 'localhost'] } } });
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
function normalizeSettings(saved = {}) {
  const d = defaults();
  return { ...d, ...saved, latency: { ...d.latency, ...(plain(saved.latency) ? saved.latency : {}) }, hotkeys: { ...d.hotkeys, ...(plain(saved.hotkeys) ? saved.hotkeys : {}) }, appearance: { ...d.appearance, ...(plain(saved.appearance) ? saved.appearance : {}) }, core: { ...d.core, ...(plain(saved.core) ? saved.core : {}), tun: { ...d.core.tun, ...(plain(saved.core?.tun) ? saved.core.tun : {}) }, dns: { ...d.core.dns, ...(plain(saved.core?.dns) ? saved.core.dns : {}) } } };
}
function strings(value, label, limit = 128) { if (!Array.isArray(value) || value.length > limit || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 2048 || /[\r\n\0]/.test(v))) throw Error(`${label}格式无效`); return value.map(v => v.trim()); }
function validateSettingsPatch(current, patch) {
  if (!plain(patch)) throw Error('设置格式无效');
  const next = normalizeSettings(current);
  for (const key of ['closeToTray', 'startupCheck', 'lightweightMode', 'launchAtLogin', 'autoConnect', 'startMinimized', 'systemProxyOnConnect', 'notifications', 'proxyGuard', 'reconnectOnNetworkChange']) if (key in patch) { if (typeof patch[key] !== 'boolean') throw Error('设置值无效'); next[key] = patch[key]; }
  if ('backupIntervalHours' in patch) { if (!Number.isInteger(patch.backupIntervalHours) || patch.backupIntervalHours < 0 || patch.backupIntervalHours > 720) throw Error('备份间隔范围为 0–720 小时'); next.backupIntervalHours = patch.backupIntervalHours; }
  if ('latency' in patch) { if (!plain(patch.latency)) throw Error('测速设置无效'); const v = patch.latency; if ('url' in v) { let u; try { u = new URL(v.url); } catch { throw Error('测速地址无效'); } if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || v.url.length > 2048) throw Error('测速地址需要 HTTP / HTTPS'); next.latency.url = u.href; } for (const [key,min,max] of [['timeout',500,30000],['intervalMinutes',0,1440]]) if (key in v) { if (!Number.isInteger(v[key]) || v[key] < min || v[key] > max) throw Error('测速设置范围无效'); next.latency[key] = v[key]; } }
  if ('hotkeys' in patch) { if (!plain(patch.hotkeys)) throw Error('快捷键格式无效'); for (const key of ['toggle', 'show', 'tun']) if (key in patch.hotkeys) { if (typeof patch.hotkeys[key] !== 'string' || patch.hotkeys[key].length > 100 || /[\r\n\0]/.test(patch.hotkeys[key])) throw Error('快捷键格式无效'); next.hotkeys[key] = patch.hotkeys[key].trim(); } }
  if ('globalOverride' in patch) { if (typeof patch.globalOverride !== 'string' || Buffer.byteLength(patch.globalOverride) > 1024 * 1024) throw Error('覆写配置过大'); next.globalOverride = patch.globalOverride; }
  if ('globalScript' in patch) { const { validateScript } = require('./compose.cjs'); next.globalScript = validateScript(patch.globalScript); }
  if (patch.appearance !== undefined) {
    if (!plain(patch.appearance)) throw Error('外观设置无效');
    if ('showTrafficHistory' in patch.appearance) { if (typeof patch.appearance.showTrafficHistory !== 'boolean') throw Error('历史图表设置无效'); next.appearance.showTrafficHistory = patch.appearance.showTrafficHistory; }
    if ('mode' in patch.appearance) { if (!['light', 'dark', 'system'].includes(patch.appearance.mode)) throw Error('主题无效'); next.appearance.mode = patch.appearance.mode; }
    for (const key of ['accent', 'sidebar']) if (key in patch.appearance) { const v = patch.appearance[key]; if (!(key === 'sidebar' && v === null) && !/^#[0-9a-f]{6}$/i.test(v)) throw Error('颜色格式无效'); next.appearance[key] = v; }
    if ('customCss' in patch.appearance) { const css = patch.appearance.customCss; if (typeof css !== 'string' || Buffer.byteLength(css) > 64 * 1024 || /@import|url\s*\(|expression\s*\(/i.test(css)) throw Error('自定义 CSS 不支持外部资源'); next.appearance.customCss = css; }
    for (const key of ['navOrder', 'hiddenNav']) if (key in patch.appearance) { const ids = defaults().appearance.navOrder, values = patch.appearance[key]; if (!Array.isArray(values) || new Set(values).size !== values.length || values.some(v => !ids.includes(v)) || key === 'navOrder' && values.length !== ids.length || key === 'hiddenNav' && values.includes('settings')) throw Error('导航设置无效'); next.appearance[key] = values; }
  }
  if (patch.core !== undefined) {
    if (!plain(patch.core)) throw Error('内核设置无效');
    const c = patch.core;
    for (const key of ['mixedPort', 'httpPort', 'socksPort']) if (key in c) { if (!Number.isInteger(c[key]) || c[key] < 0 || c[key] > 65535) throw Error('端口范围为 0–65535'); next.core[key] = c[key]; }
    const ports = [next.core.mixedPort, next.core.httpPort, next.core.socksPort].filter(Boolean); if (new Set(ports).size !== ports.length) throw Error('监听端口不能重复');
    for (const key of ['allowLan', 'ipv6']) if (key in c) { if (typeof c[key] !== 'boolean') throw Error('内核设置值无效'); next.core[key] = c[key]; }
    if ('logLevel' in c) { if (!['silent', 'error', 'warning', 'info', 'debug'].includes(c.logLevel)) throw Error('日志级别无效'); next.core.logLevel = c.logLevel; }
    if ('bypass' in c) { if (typeof c.bypass !== 'string' || c.bypass.length > 4096 || /[\r\n\0]/.test(c.bypass)) throw Error('代理绕过格式无效'); next.core.bypass = c.bypass; }
    if ('proxyMode' in c) { if (!['manual', 'pac'].includes(c.proxyMode)) throw Error('代理模式无效'); next.core.proxyMode = c.proxyMode; }
    if ('pacScript' in c) { if (typeof c.pacScript !== 'string' || Buffer.byteLength(c.pacScript) > 64 * 1024 || c.pacScript.trim() && !/function\s+FindProxyForURL\s*\(/.test(c.pacScript)) throw Error('PAC 需要 FindProxyForURL 函数'); next.core.pacScript = c.pacScript; }
    if ('tun' in c) {
      if (!plain(c.tun)) throw Error('TUN 设置无效');
      for (const key of ['enabled', 'autoRoute', 'strictRoute']) if (key in c.tun) { if (typeof c.tun[key] !== 'boolean') throw Error('TUN 设置值无效'); next.core.tun[key] = c.tun[key]; }
      if ('stack' in c.tun) { if (!['mixed', 'gvisor', 'system'].includes(c.tun.stack)) throw Error('TUN 协议栈无效'); next.core.tun.stack = c.tun.stack; }
      if ('mtu' in c.tun) { if (!Number.isInteger(c.tun.mtu) || c.tun.mtu < 1280 || c.tun.mtu > 9000) throw Error('MTU 范围为 1280–9000'); next.core.tun.mtu = c.tun.mtu; }
      if ('routeExcludeAddress' in c.tun) { const list = strings(c.tun.routeExcludeAddress, '排除网段'); for (const cidr of list) { const [ip, mask] = cidr.split('/'); const version = net.isIP(ip); if (!version || mask === undefined || !/^\d+$/.test(mask) || +mask > (version === 4 ? 32 : 128) || cidr.split('/').length !== 2) throw Error('排除网段需要 CIDR 格式'); } next.core.tun.routeExcludeAddress = list; }
    }
    if ('dns' in c) {
      if (!plain(c.dns)) throw Error('DNS 设置无效');
      if ('enabled' in c.dns) { if (typeof c.dns.enabled !== 'boolean') throw Error('DNS 设置无效'); next.core.dns.enabled = c.dns.enabled; }
      if ('enhancedMode' in c.dns) { if (!['fake-ip', 'redir-host'].includes(c.dns.enhancedMode)) throw Error('DNS 模式无效'); next.core.dns.enhancedMode = c.dns.enhancedMode; }
      for (const key of ['nameserver', 'fallback', 'fakeIpFilter']) if (key in c.dns) next.core.dns[key] = strings(c.dns[key], 'DNS');
    }
  }
  if (next.core.tun.enabled && !next.core.dns.enabled) throw Error('TUN 需要启用 DNS');
  if (next.core.dns.enabled && !next.core.dns.nameserver.length) throw Error('请至少设置一个 DNS 服务器');
  return next;
}
module.exports = { defaults, normalizeSettings, validateSettingsPatch };
