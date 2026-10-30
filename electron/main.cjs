const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, globalShortcut, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startWatchdog, checkWatchdog } = require('./watchdog.cjs');
const { Diagnostics } = require('./diagnostics.cjs');
const { Store } = require('./store.cjs');
const { Engine } = require('./engine.cjs');
const { parseOverride } = require('./profile.cjs');
const { validateSettingsPatch } = require('./settings.cjs');
const { registerProfiles } = require('./profiles.cjs');
const { registerMedia } = require('./media.cjs');
const { registerIcons } = require('./icons.cjs');
const { memorySampler } = require('./memory.cjs');
const { isAdministrator, elevate } = require('./privilege.cjs');
const { prepareProfile, providerFiles } = require('./compose.cjs');
const { ServiceClient } = require('./service.cjs');
const { PacServer, pacScript } = require('./pac.cjs');
const { registerMaintenance } = require('./maintenance.cjs');
const { registerIntegrations } = require('./integrations.cjs');
const { WindowsProxy, ps } = require('./windows-proxy.cjs');
let win, windowTask, sampleMemory, media, icons, trayImageKey, tray, store, engine, proxy, diagnostics, maintenance, integrations, profiles, pac, recoveryBinary, quitting = false, busy = false, lastError = '', recoveryHandle = null, recoveryTask = null, admin = false, privilegeReady, service = null, serviceStatus = { installed: false, running: false };
async function ensureRecovery() {
  if (quitting) throw Error('Luma 正在退出');
  if (recoveryTask) return recoveryTask;
  recoveryTask = (async () => {
    try {
      const binary = engine?.binary || path.join(asset('core'), 'mihomo.exe');
      if (recoveryHandle && recoveryBinary === binary && await checkWatchdog(recoveryHandle)) return;
      if (quitting) throw Error('Luma 正在退出');
      const previousHandle = recoveryHandle;
      recoveryHandle = await startWatchdog(process.pid, store.dir, engine?.binary || path.join(asset('core'), 'mihomo.exe'), () => quitting);
      recoveryBinary = binary;
      if (previousHandle && previousHandle !== recoveryHandle && await checkWatchdog(previousHandle)) await ps(`$p=Get-Process -Id ${previousHandle.pid} -ErrorAction Stop; if($p.StartTime.ToFileTimeUtc().ToString() -eq '${previousHandle.started}') { Stop-Process -Id $p.Id -Force -ErrorAction Stop }`, 5000);
      if (!await checkWatchdog(recoveryHandle)) throw Error('恢复进程未通过存活验证');
    } catch (error) { throw Error('异常退出保护未能启动，系统代理尚未启用。请重试连接。\n' + error.message); }
  })();
  try { await recoveryTask; } finally { recoveryTask = null; }
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (store) showWindow().catch(() => {}); });
app.on('activate', () => { if (store) showWindow().catch(() => {}); });
const asset = name => app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, '..', 'resources', name);
const snapshot = () => ({ ...store.publicData(), ...maintenance?.snapshot(), ...integrations?.snapshot(), ...icons?.snapshot(), running: engine.ready, systemProxy: proxy.enabled, busy, lastError, port: engine.ready ? engine.port : null, version: app.getVersion(), health: diagnostics.state, tunRunning: engine.tunRunning, privilege: { admin, platform: process.platform }, service: serviceStatus, coreVersion: engine.version || null });
function publish() { if (quitting) return; if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); updateTray(); }
async function exclusive(fn) { if (busy) throw Error('正在处理上一项操作，请稍候'); busy = true; publish(); try { lastError = ''; return await fn(); } catch(e) { lastError = e.message; throw e; } finally { busy = false; publish(); } }
async function disconnect() {
  media?.dispose();
  let failure;
  try { await proxy.restore(); } catch (error) { failure = error; }
  try { await pac?.stop(); } catch (error) { failure ||= error; }
  try { await engine.stop(); } catch (error) { failure ||= error; } finally { publish(); }
  if (failure) throw failure;
}
async function connect() {
  if (process.platform !== 'win32') throw Error('当前仅支持 Windows 客户端');
  await privilegeReady;
  const profile = store.data.profiles.find(p => p.id === store.data.activeId);
  if (!profile) throw Error('请先添加并选择一个订阅');
  if (store.data.core.tun.enabled) {
    if (service) serviceStatus = await service.status();
    if (!admin && !serviceStatus.running) throw Error('TUN 需要管理员权限，请安装服务或以管理员身份重启');
  }
  const useService = !!store.data.core.tun.enabled && !admin && serviceStatus.running;
  if (useService && store.data.customCore) throw Error('服务使用受保护的内置内核。请切回内置内核，或以管理员身份运行自定义内核');
  engine.service = useService ? service : null;
  await ensureRecovery();
  const compiled = await prepareProfile(store, profile.id);
  const imported = providerFiles(store, profile.id);
  fs.mkdirSync(path.join(engine.dir, 'providers'), { recursive: true });
  for (const [file, text] of Object.entries(imported.files)) fs.writeFileSync(path.join(engine.dir, file), text, { mode: 0o600 });
  await engine.start(compiled, store.data.mode, { ...store.data, globalOverride: '', localProviders: imported.allowed, providerFiles: imported.files });
  try {
    await ensureRecovery();
    if (store.data.systemProxyOnConnect) { const pacUrl = store.data.core.proxyMode === 'pac' ? await pac.start(engine.port, store.data.core.pacScript) : undefined; await proxy.enable(engine.port, useService ? undefined : engine.child?.pid, store.data.core.bypass, { pacUrl }); }
  } catch (error) { await pac.stop().catch(() => {}); await engine.stop(); throw error; }
  publish();
}
async function updateSettings(payload) {
  const previous = store.data;
  const next = validateSettingsPatch(previous, payload);
  parseOverride(next.globalOverride);
  pacScript(1, next.core.pacScript);
  if (typeof payload?.launchAtLogin === 'boolean') {
    if (process.platform !== 'win32') throw Error('仅支持 Windows');
    if (process.env.PORTABLE_EXECUTABLE_DIR) throw Error('便携版不支持开机启动，请使用安装版');
  }
  await privilegeReady;
  if (next.core.tun.enabled && !admin) { if (service) serviceStatus = await service.status(); if (!serviceStatus.running) throw Error('TUN 需要管理员权限，请安装服务或以管理员身份重启'); }
  const restart = engine.ready && (payload.core !== undefined || payload.globalOverride !== undefined || payload.globalScript !== undefined || payload.systemProxyOnConnect !== undefined);
  if (restart) await disconnect();
  store.data = next;
  try {
    await integrations?.applySettings(next);
    if (typeof payload?.launchAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: payload.launchAtLogin });
    if (restart) await connect();
    store.save();
  } catch (error) { store.data = previous; await integrations?.applySettings(previous).catch(() => {}); if (restart) await connect().catch(() => {}); throw error; }
}
function updateTray() {
  if (!tray) return;
  const imageKey = icons?.trayKey();
  if (trayImageKey !== imageKey) { const image = nativeImage.createFromPath(icons?.trayPath() || asset('icon.png')); if (!image.isEmpty()) tray.setImage(image.resize({width:24,height:24})); trayImageKey = imageKey; }
  const action = fn => () => exclusive(fn).catch(() => publish());
  const groups = (engine.lastGroups || []).filter(g => g.type === 'Selector').slice(0, 20).map(group => ({label: group.name, submenu: group.nodes.slice(0, 100).map(node => ({label: node.name, type:'radio',checked:group.now===node.name,enabled:engine.ready&&!busy,click:action(async()=>{await engine.api(`/proxies/${encodeURIComponent(group.name)}`,'PUT',{name:node.name});group.now=node.name;})}))}));
  tray.setToolTip(`Luma · ${engine.ready ? (proxy.enabled ? '已连接' : '内核运行中') : '未连接'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'打开 Luma',click:()=>showWindow().catch(()=>{})},
    {label:engine.ready?'断开连接':'连接',enabled:!busy&&!!store.data.activeId,click:action(()=>engine.ready?disconnect():connect())},
    {label:'TUN',type:'checkbox',checked:store.data.core.tun.enabled,enabled:!busy,click:item=>exclusive(()=>updateSettings({core:{tun:{enabled:item.checked}}})).catch(()=>publish())},
    {label:'代理模式',submenu:[['rule','规则'],['global','全局'],['direct','直连']].map(([mode,label])=>({label,type:'radio',checked:store.data.mode===mode,enabled:!busy,click:action(async()=>{if(engine.ready)await engine.api('/configs','PATCH',{mode});store.data.mode=mode;store.save();})}))},
    ...(groups.length?[{label:'策略组',submenu:groups}]:[]),
    {label:'测试延迟',enabled:engine.ready&&!busy,click:action(async()=>{for(const group of engine.lastGroups||[])await engine.api(`/proxies/${encodeURIComponent(group.name)}/delay?timeout=${store.data.latency.timeout}&url=${encodeURIComponent(store.data.latency.url)}`).catch(()=>{});})},
    {type:'separator'},{label:'退出 Luma',click:()=>app.quit()}
  ]));
}
async function ensureWindow(initial = false) {
  if (quitting) return null;
  if (windowTask) return windowTask;
  if (win && !win.isDestroyed()) return win;
  windowTask = (async () => { await createWindow(initial); return win; })();
  try { return await windowTask; } finally { windowTask = null; }
}
async function showWindow() {
  const window = await ensureWindow(); if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore(); window.show(); window.focus();
}
async function createWindow(initial = false) {
  const window = new BrowserWindow({ width: 1180, height: 800, minWidth: 940, minHeight: 690, title: 'Luma', backgroundColor: '#ffffff', frame: false, show: false, icon: asset('icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  win = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  window.on('close', event => { if (quitting) return; event.preventDefault(); if (store.data.closeToTray && tray) { if (store.data.lightweightMode) window.destroy(); else window.hide(); } else app.quit(); });
  window.on('closed', () => { if (win === window) win = null; });
  window.once('ready-to-show', () => { if (!initial || !store.data.startMinimized || !tray) window.show(); });
  await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
function handle(name, fn) { ipcMain.handle(name, async (event, payload) => { if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: '请求来源无效' }; try { return { ok: true, data: await fn(payload) }; } catch(e) { return { ok: false, error: e.message }; } }); }
app.whenReady().then(async () => {
  store = new Store(app.getPath('userData')); proxy = new WindowsProxy(store.dir); service = new ServiceClient({ resourcesDir: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources') });
  pac = new PacServer();
  if (process.platform === 'win32') { try { await proxy.restore(); } catch { lastError = '恢复系统代理失败，请检查 Windows 代理设置'; }
  }
  const coreDir = path.join(store.dir, 'core'); fs.mkdirSync(coreDir, { recursive: true });
  const bundled = asset('core'); if (fs.existsSync(bundled)) for (const f of fs.readdirSync(bundled)) if (/\.(dat|mmdb)$/.test(f) && !fs.existsSync(path.join(coreDir, f))) fs.copyFileSync(path.join(bundled, f), path.join(coreDir, f));
  engine = new Engine(coreDir, store.data.customCore ? path.join(store.dir, 'managed-core', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo') : path.join(bundled, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'), () => { proxy.restore().catch(() => { lastError = '恢复系统代理失败'; }).finally(() => { lastError ||= '内核意外停止，请检查配置后重新连接'; publish(); }); });
  const coreJournal = path.join(store.dir, 'core-recovery.json');
  engine.onSpawn = async pid => { if (process.platform !== 'win32') return; if (!Number.isInteger(pid) || pid <= 0) throw Error('无法取得内核进程'); const coreStarted = await ps(`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`, 5000); fs.writeFileSync(coreJournal, JSON.stringify({ ownerPid: process.pid, corePid: pid, coreStarted, binary: engine.binary }), { mode: 0o600 }); };
  engine.onStop = async () => { if (fs.existsSync(coreJournal)) { const record = JSON.parse(fs.readFileSync(coreJournal, 'utf8')); if (record.ownerPid === process.pid) fs.rmSync(coreJournal, { force: true }); } };
  media = registerMedia({handle,engine,asset});
  icons = registerIcons({handle,dialog,getWindow:()=>win,store,publish,nativeImage});
  sampleMemory = memorySampler({app,getWindow:()=>win,getCorePid:()=>engine.child?.pid});
  diagnostics = new Diagnostics({ platform: process.platform, binary: engine.binary, ensureRecovery, inspectProxy: () => proxy.inspect(), getLoginSettings: () => app.getLoginItemSettings(), launchAtLogin: () => store.data.launchAtLogin, portable: !!process.env.PORTABLE_EXECUTABLE_DIR, onChange: publish });
  handle('state', snapshot);
  handle('health:check', () => { diagnostics.options.binary = engine.binary; return diagnostics.run(); });
  handle('toggle', () => exclusive(() => engine.ready ? disconnect() : connect()));
  profiles = registerProfiles({ handle, store, engine, dialog, getWindow: () => win, exclusive, disconnect, connect, publish, isBusy: () => busy, isQuitting: () => quitting });
  handle('profile:select', id => exclusive(async () => { if (!store.data.profiles.some(p => p.id === id)) throw Error('订阅不存在'); const running = engine.ready; const old = store.data.activeId; if (running) await disconnect(); store.data.activeId = id; store.save(); try { if (running) await connect(); } catch(e) { store.data.activeId = old; store.save(); if (running) await connect().catch(() => {}); throw e; } }));
  handle('profile:delete', id => exclusive(async () => { const p = store.data.profiles.find(p => p.id === id); if (!p) throw Error('订阅不存在'); if (store.data.profiles.some(source => (source.sourceIds || []).includes(id))) throw Error('此配置被其他配置合并引用，请先移除引用'); const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '移除'], defaultId: 0, cancelId: 0, message: `移除「${p.name}」？`, detail: '只移除本地配置，不影响订阅服务。' }); if (result.response !== 1) return; if (id === store.data.activeId) { await disconnect(); store.data.activeId = store.data.profiles.find(p => p.id !== id)?.id || null; } store.data.profiles = store.data.profiles.filter(p => p.id !== id); fs.rmSync(store.profilePath(id), { force: true }); store.save(); }));
  handle('mode', mode => exclusive(async () => { if (!['rule', 'global', 'direct'].includes(mode)) throw Error('模式无效'); if (engine.ready) await engine.api('/configs', 'PATCH', { mode }); store.data.mode = mode; store.save(); }));
  handle('systemProxy', enabled => exclusive(async () => { if (typeof enabled !== 'boolean') throw Error('参数无效'); if (enabled) { await ensureRecovery(); if (!engine.ready) throw Error('请先连接'); const pacUrl = store.data.core.proxyMode === 'pac' ? await pac.start(engine.port, store.data.core.pacScript) : undefined; await proxy.enable(engine.port, engine.serviceMode ? undefined : engine.child?.pid, store.data.core.bypass, {pacUrl}); } else { await proxy.restore(); await pac.stop(); } }));
  handle('stats', async () => { const result = await engine.stats(); result.memory = await sampleMemory(); if (JSON.stringify(engine.lastGroups) !== JSON.stringify(result.groups)) { engine.lastGroups = result.groups; updateTray(); } return result; });
  handle('node:select', async ({ group, name }) => { if (!engine.ready) throw Error('请先连接'); const data = await engine.api('/proxies'); if (data.proxies[group]?.type !== 'Selector' || !data.proxies[group].all.includes(name)) throw Error('此策略组不支持手动切换'); await engine.api(`/proxies/${encodeURIComponent(group)}`, 'PUT', { name }); });
  async function delayNode(payload) { const value = typeof payload === 'string' ? { name: payload } : payload; if (!engine.ready || typeof value?.name !== 'string' || value.name.length > 1024) throw Error('请先连接'); const checked = validateSettingsPatch(store.data, {latency:{url:value.url ?? store.data.latency.url, timeout:value.timeout ?? store.data.latency.timeout}}).latency; return engine.api(`/proxies/${encodeURIComponent(value.name)}/delay?timeout=${checked.timeout}&url=${encodeURIComponent(checked.url)}`); }
  handle('node:delay', delayNode);
  let lastLatencyAt = Date.now(); const latencyTimer = setInterval(async () => { const interval = store.data.latency.intervalMinutes; if (quitting || busy || !engine.ready || interval <= 0 || Date.now() - lastLatencyAt < interval * 60000) return; lastLatencyAt = Date.now(); try { const values = await engine.api('/proxies'); for (const value of Object.values(values.proxies || {})) { if (!engine.ready || quitting) break; if (Array.isArray(value.all)) await delayNode(value.name).catch(() => {}); } } catch {} }, 30000); latencyTimer.unref(); app.once('will-quit',()=>clearInterval(latencyTimer));
  handle('connections:clear', () => engine.ready ? engine.api('/connections', 'DELETE') : null);
  handle('logs', () => engine.logs);
  handle('settings', payload => exclusive(() => updateSettings(payload)));
  handle('tun', enabled => exclusive(async () => { if (typeof enabled !== 'boolean') throw Error('TUN 参数无效'); await updateSettings({ core: { tun: { enabled } } }); }));
  handle('privilege:elevate', async () => { if (busy) throw Error('请等待当前操作完成'); await disconnect(); await elevate(app); app.quit(); });
  handle('rules', async () => engine.ready ? { ...(await engine.api('/rules')), providers: { rules: (await engine.api('/providers/rules')).providers || {}, proxies: (await engine.api('/providers/proxies')).providers || {} } } : { rules: [], providers: { rules: {}, proxies: {} } });
  handle('providers:update', payload => exclusive(async () => { if (!engine.ready || !['proxies', 'rules'].includes(payload?.type) || typeof payload?.name !== 'string' || payload.name.length > 1024) throw Error('Provider 参数无效'); await engine.api(`/providers/${payload.type}/${encodeURIComponent(payload.name)}`, 'PUT'); }));
  handle('providers:health', payload => { if (!engine.ready || typeof payload?.name !== 'string' || payload.name.length > 1024) throw Error('Provider 参数无效'); return engine.api(`/providers/proxies/${encodeURIComponent(payload.name)}/healthcheck`); });
  handle('logs:export', () => exclusive(async () => { const result = await dialog.showSaveDialog(win, { title:'导出日志',defaultPath:'luma.log',filters:[{name:'日志',extensions:['log']}] }); if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath,engine.logs.join('\n'),{mode:0o600}); }));
  handle('connections:close', id => { if (!engine.ready || typeof id !== 'string' || id.length > 128) throw Error('连接无效'); return engine.api(`/connections/${encodeURIComponent(id)}`, 'DELETE'); });
  handle('logs:clear', () => { engine.logs = []; });
  handle('cache:flush', kind => { if (!engine.ready || !['dns', 'fakeip'].includes(kind)) throw Error('请先连接'); return engine.api(`/cache/${kind}/flush`, 'POST'); });
  handle('service:status', async () => { if (service) serviceStatus = await service.status(); return serviceStatus; });
  handle('service:install', () => exclusive(async () => { if (!service) throw Error('当前平台不支持服务'); await service.install(); serviceStatus = await service.status(); }));
  handle('service:uninstall', () => exclusive(async () => { if (!service) throw Error('当前平台不支持服务'); await disconnect(); await service.uninstall(); serviceStatus = await service.status(); }));
  handle('window', action => { if (action === 'minimize') win.minimize(); else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (action === 'close') win.close(); else if (action === 'quit') app.quit(); });
  maintenance = registerMaintenance({ handle, app, dialog, shell, getWindow: () => win, store, engine, exclusive, disconnect, publish, asset, isBusy:()=>busy, isQuitting:()=>quitting, applySettings:()=>integrations?.applySettings(store.data) });
  integrations = registerIntegrations({ handle, app, dialog, shell, globalShortcut, Notification, getWindow: () => win, showWindow, store, engine, proxy, exclusive, connect, disconnect, publish, importUrl: (url, name) => profiles.importUrl(url, name), toggleTun: enabled => updateSettings({ core: { tun: { enabled } } }), isBusy: () => busy, isQuitting: () => quitting });
  await integrations.applySettings(store.data).catch(error => { lastError = error.message; });
  privilegeReady = isAdministrator().then(value => { admin = value; }).catch(() => { admin = false; });
  tray = new Tray(nativeImage.createFromPath(asset('icon.png')).resize({ width: 24, height: 24 })); tray.on('double-click', () => showWindow().catch(() => {})); updateTray(); await ensureWindow(true);
  await privilegeReady;
  if (service) serviceStatus = await service.status().catch(() => ({ installed: false, running: false }));
  publish();
  if (store.data.startupCheck) diagnostics.run().catch(() => {});
  if (store.data.autoConnect && store.data.activeId) exclusive(connect).catch(() => {});
}).catch(err => { dialog.showErrorBox('Luma 启动失败', err.message); app.exit(1); });
app.on('before-quit', event => { if (quitting) return; event.preventDefault(); if (busy) { showWindow().catch(() => {}); return; } quitting = true; media?.dispose(); profiles?.dispose(); maintenance?.dispose(); integrations?.dispose(); (async () => { try { await disconnect(); } catch(e) { dialog.showErrorBox('请检查系统代理', '无法自动恢复 Windows 代理设置，请在系统设置中关闭代理后退出。'); } finally { await recoveryTask?.catch(() => {}); app.quit(); } })(); });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
