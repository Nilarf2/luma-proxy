const { ps } = require('./windows-proxy.cjs');
const os = require('node:os');
const ACTIONS = ['toggle', 'show', 'tun'];
function importLink(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  let link; try { link = new URL(value); } catch { return null; }
  if (!['luma:', 'clash:'].includes(link.protocol) || !['install-config', 'import'].includes(link.hostname)) return null;
  const url = new URL(link.searchParams.get('url') || '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw Error('订阅地址无效');
  return { url: url.href, name: (link.searchParams.get('name') || '').slice(0, 80), host: url.host };
}
function validateHotkeys(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('快捷键无效');
  const result = {}, used = new Set();
  for (const key of ACTIONS) {
    const value = input[key] || '';
    if (typeof value !== 'string' || value.length > 80 || /[\r\n\0]/.test(value) || (value && (!value.includes('+') || !/(?:Ctrl|Control|CommandOrControl|Alt|Super|Meta)/i.test(value)))) throw Error('快捷键需要组合键');
    const canonical = value.toLowerCase(); if (value && used.has(canonical)) throw Error('快捷键不能重复');
    if (value) used.add(canonical); result[key] = value;
  }
  return result;
}
function networkSignature(interfaces = os.networkInterfaces()) {
  return JSON.stringify(Object.entries(interfaces).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, entries]) => entries.filter(x => !x.internal && !/luma|mihomo|clash|tun/i.test(name)).map(x => [name, x.family, x.address, x.netmask])));
}
function registerIntegrations(ctx) {
  const { app, dialog, shell, globalShortcut, Notification, getWindow, store, engine, proxy, exclusive, connect, disconnect, publish, handle } = ctx;
  let registered = {}, hotkeyStatus = [], disposed = false, checking = false, lastNetwork = networkSignature(), lastRunning = engine.ready, externalConflict = false;
  const show = async () => { if (ctx.showWindow) return ctx.showWindow(); const w = getWindow(); if (!w) return; if (w.isMinimized()) w.restore(); w.show(); w.focus(); };
  function notify(title, body = '') { if (store.data.notifications !== false && Notification.isSupported()) new Notification({ title, body }).show(); }
  const callbacks = {
    show: () => show().catch(error => notify('Luma',error.message)),
    toggle: () => exclusive(() => engine.ready ? disconnect() : connect()).catch(e => notify('Luma', e.message)),
    tun: () => ctx.toggleTun ? ctx.toggleTun(!store.data.core.tun.enabled).catch(e => notify('Luma', e.message)) : show()
  };
  async function applySettings(next) {
    const keys = validateHotkeys(next.hotkeys || { toggle: '', show: '', tun: '' });
    for (const value of Object.values(registered)) if (value) globalShortcut.unregister(value);
    const successful = {};
    try {
      for (const [action, value] of Object.entries(keys)) {
        if (!value) continue;
        if (!globalShortcut.register(value, callbacks[action])) throw Error('快捷键已被占用：' + value);
        successful[action] = value;
      }
      registered = successful; hotkeyStatus = [];
    } catch (error) {
      for (const value of Object.values(successful)) globalShortcut.unregister(value);
      for (const [action, value] of Object.entries(registered)) if (value) globalShortcut.register(value, callbacks[action]);
      throw error;
    }
  }
  async function acceptLink(value) {
    try {
      const parsed = importLink(value); if (!parsed || disposed) return;
      await show(); const result = await dialog.showMessageBox(getWindow(), { type: 'question', message: '导入订阅？', detail: parsed.host, buttons: ['取消', '导入'], defaultId: 0, cancelId: 0 });
      if (result.response === 1) { if (!ctx.importUrl) throw Error('订阅导入尚未就绪'); await ctx.importUrl(parsed.url, parsed.name); publish(); }
    } catch (error) { notify('导入失败', error.message); }
  }
  const onSecondInstance = (_event, argv) => { for (const arg of argv) if (/^(luma|clash):/i.test(arg)) acceptLink(arg); };
  const onOpenUrl = (event, url) => { event.preventDefault(); acceptLink(url); };
  app.on('second-instance', onSecondInstance); app.on('open-url', onOpenUrl);
  if (process.platform === 'win32' && app.isPackaged) app.setAsDefaultProtocolClient('luma');
  setImmediate(() => { for (const arg of process.argv) if (/^(luma|clash):/i.test(arg)) acceptLink(arg); applySettings(store.data).catch(e => { hotkeyStatus = [e.message]; publish(); }); });
  handle('os:proxy-settings', () => shell.openExternal('ms-settings:network-proxy'));
  handle('os:network-settings', () => shell.openExternal('ms-settings:network-status'));
  handle('os:uwp-list', async () => {
    const text = await ps(`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LumaAppSid { [DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid); [DllImport("advapi32.dll")] public static extern IntPtr FreeSid(IntPtr sid); public static string Get(string name) { IntPtr sid; if(DeriveAppContainerSidFromAppContainerName(name,out sid)!=0) return null; try { return new System.Security.Principal.SecurityIdentifier(sid).Value; } finally { FreeSid(sid); } } }'; $items=@(Get-AppxPackage | ForEach-Object { @{name=$_.Name;sid=[LumaAppSid]::Get($_.PackageFamilyName)} } | Where-Object {$_.sid}); ConvertTo-Json -InputObject $items -Compress`, 30000);
    const apps = JSON.parse(text || '[]');
    const exemptions = await ps(`$ErrorActionPreference='Stop'; & "$env:SystemRoot\\System32\\CheckNetIsolation.exe" LoopbackExempt -s; if($LASTEXITCODE -ne 0){throw '无法读取 UWP 设置'}`, 10000);
    const enabled = new Set(exemptions.match(/S-1-15-2-(?:\d+-){5,8}\d+/g) || []);
    return apps.map(item => ({ ...item, enabled: enabled.has(item.sid) }));
  });
  handle('os:uwp-set', async payload => {
    if (!/^S-1-15-2-(?:\d+-){5,8}\d+$/.test(payload?.sid || '') || typeof payload.enabled !== 'boolean') throw Error('应用标识无效');
    const script = `$ErrorActionPreference='Stop'; & "$env:SystemRoot\\System32\\CheckNetIsolation.exe" LoopbackExempt ${payload.enabled ? '-a' : '-d'} '-p=${payload.sid}'; if($LASTEXITCODE -ne 0){throw 'UWP 设置失败'}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    await ps(`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -Wait -PassThru; if($p.ExitCode -ne 0){throw 'UWP 设置失败'}`, 60000); return { changed: true };
  });
  handle('os:uwp-loopback', async () => {
    const choice = await dialog.showMessageBox(getWindow(), { type: 'question', message: '允许 UWP 应用使用本机代理？', buttons: ['取消', '允许'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    // This only changes loopback exemptions for app containers already installed by this user.
    const script = `$ErrorActionPreference='Stop'; Get-AppxPackage | ForEach-Object { & "$env:SystemRoot\\System32\\CheckNetIsolation.exe" LoopbackExempt -a ('-n='+$_.PackageFamilyName) | Out-Null; if($LASTEXITCODE -ne 0){throw 'UWP 设置失败'} }`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    await ps(`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -Wait -PassThru; if($p.ExitCode -ne 0){throw 'UWP 设置失败'}`, 60000); return { changed: true };
  });
  const timer = setInterval(async () => {
    if (checking || disposed || ctx.isBusy?.() || ctx.isQuitting?.()) return; checking = true;
    try {
      if (lastRunning !== engine.ready) { lastRunning = engine.ready; notify('Luma', engine.ready ? '已连接' : '已断开'); }
      if (process.platform === 'win32' && store.data.proxyGuard && proxy.enabled && engine.ready) {
        const state = await proxy.inspect();
        if (state.ownership === 'disabled' && proxy.reapply) await proxy.reapply();
        else if (state.ownership === 'external' && !externalConflict) { externalConflict = true; notify('系统代理已变更', '其他程序正在使用系统代理'); }
        else if (state.ownership === 'ours') externalConflict = false;
      }
      const current = networkSignature();
      if (current !== lastNetwork) { lastNetwork = current; if (store.data.reconnectOnNetworkChange && engine.ready) await exclusive(async () => { await disconnect(); await connect(); }); }
    } catch (error) { engine.addLog?.('[warning] ' + error.message); }
    finally { checking = false; }
  }, 5000); timer.unref();
  return { applySettings, snapshot: () => ({ hotkeyStatus }), notify, dispose: () => { disposed = true; clearInterval(timer); for (const key of Object.values(registered)) globalShortcut.unregister(key); app.removeListener('second-instance', onSecondInstance); app.removeListener('open-url', onOpenUrl); } };
}
module.exports = { registerIntegrations, importLink, validateHotkeys, networkSignature };
