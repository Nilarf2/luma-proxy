const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { Store } = require('./store.cjs');
const { Engine } = require('./engine.cjs');
const { parseProfile, downloadProfile } = require('./profile.cjs');
const { WindowsProxy } = require('./windows-proxy.cjs');
let win, tray, store, engine, proxy, quitting = false, busy = false, lastError = '';
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { win?.show(); win?.focus(); });
const asset = name => app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, '..', 'resources', name);
const snapshot = () => ({ ...store.publicData(), running: engine.ready, systemProxy: proxy.enabled, busy, lastError, port: engine.ready ? engine.port : null, version: app.getVersion() });
function publish() { if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); updateTray(); }
async function exclusive(fn) { if (busy) throw Error('正在处理上一项操作，请稍候'); busy = true; publish(); try { lastError = ''; return await fn(); } catch(e) { lastError = e.message; throw e; } finally { busy = false; publish(); } }
async function disconnect() { await proxy.restore(); await engine.stop(); publish(); }
async function connect() { if (process.platform !== 'win32') throw Error('当前仅支持 Windows 客户端'); const profile = store.data.profiles.find(p => p.id === store.data.activeId); if (!profile) throw Error('请先添加并选择一个订阅'); await engine.start(fs.readFileSync(store.profilePath(profile.id), 'utf8'), store.data.mode); try { await proxy.enable(engine.port); } catch(e) { await engine.stop(); throw e; } publish(); }
function updateTray() { if (!tray) return; tray.setToolTip(`Luma · ${engine.ready ? (proxy.enabled ? '已连接' : '内核运行中') : '未连接'}`); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Luma', click: () => { win.show(); win.focus(); } }, { label: engine.ready ? '断开连接' : '连接', enabled: !busy && !!store.data.activeId, click: () => exclusive(() => engine.ready ? disconnect() : connect()).catch(() => publish()) }, { type: 'separator' }, { label: '退出 Luma', click: () => app.quit() }])); }
async function createWindow() {
  win = new BrowserWindow({ width: 1180, height: 800, minWidth: 940, minHeight: 690, title: 'Luma', backgroundColor: '#fafaf9', frame: false, show: false, icon: asset('icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  win.on('close', event => { if (!quitting && store.data.closeToTray && tray) { event.preventDefault(); win.hide(); } });
  win.once('ready-to-show', () => win.show());
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
function handle(name, fn) { ipcMain.handle(name, async (event, payload) => { if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: '请求来源无效' }; try { return { ok: true, data: await fn(payload) }; } catch(e) { return { ok: false, error: e.message }; } }); }
app.whenReady().then(async () => {
  store = new Store(app.getPath('userData')); proxy = new WindowsProxy(store.dir);
  if (process.platform === 'win32') { try { await proxy.restore(); } catch { lastError = '恢复系统代理失败，请检查 Windows 代理设置'; }
    const watchdog = spawn(process.execPath, [path.join(__dirname, 'watchdog.cjs'), String(process.pid), store.dir], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); watchdog.unref();
  }
  const coreDir = path.join(store.dir, 'core'); fs.mkdirSync(coreDir, { recursive: true });
  const bundled = asset('core'); if (fs.existsSync(bundled)) for (const f of fs.readdirSync(bundled)) if (/\.(dat|mmdb)$/.test(f) && !fs.existsSync(path.join(coreDir, f))) fs.copyFileSync(path.join(bundled, f), path.join(coreDir, f));
  engine = new Engine(coreDir, path.join(bundled, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'), () => { proxy.restore().catch(() => { lastError = '恢复系统代理失败'; }).finally(() => { lastError ||= '内核意外停止，请检查配置后重新连接'; publish(); }); });
  handle('state', snapshot);
  handle('toggle', () => exclusive(() => engine.ready ? disconnect() : connect()));
  handle('profile:import', payload => exclusive(async () => {
    if (!payload || !['url', 'file'].includes(payload.type)) throw Error('导入方式无效');
    let text, url, name;
    if (payload.type === 'url') { if (typeof payload.url !== 'string') throw Error('请输入订阅地址'); url = payload.url.trim(); text = await downloadProfile(url); name = '我的订阅'; }
    else { const result = await dialog.showOpenDialog(win, { title: '导入 Clash / Mihomo 配置', filters: [{ name: 'YAML 配置', extensions: ['yaml', 'yml'] }], properties: ['openFile'] }); if (result.canceled) return; if (fs.statSync(result.filePaths[0]).size > 8 * 1024 * 1024) throw Error('配置文件不能超过 8 MB'); text = fs.readFileSync(result.filePaths[0], 'utf8'); name = path.basename(result.filePaths[0]).replace(/\.ya?ml$/i, ''); }
    parseProfile(text); const id = crypto.randomUUID(); const profile = { id, name: String(payload.name || name).slice(0, 80), url, updatedAt: new Date().toISOString() }; fs.writeFileSync(store.profilePath(id), text, { mode: 0o600 }); store.data.profiles.push(profile); store.data.activeId ||= id; store.save();
  }));
  handle('profile:select', id => exclusive(async () => { if (!store.data.profiles.some(p => p.id === id)) throw Error('订阅不存在'); const running = engine.ready; const old = store.data.activeId; if (running) await disconnect(); store.data.activeId = id; store.save(); try { if (running) await connect(); } catch(e) { store.data.activeId = old; store.save(); throw e; } }));
  handle('profile:update', id => exclusive(async () => { const p = store.data.profiles.find(p => p.id === id); if (!p?.url) throw Error('本地配置请重新导入'); const text = await downloadProfile(p.url); const running = engine.ready && id === store.data.activeId; if (running) await disconnect(); fs.writeFileSync(store.profilePath(id), text, { mode: 0o600 }); p.updatedAt = new Date().toISOString(); store.save(); if (running) await connect(); }));
  handle('profile:delete', id => exclusive(async () => { const p = store.data.profiles.find(p => p.id === id); if (!p) throw Error('订阅不存在'); const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '移除'], defaultId: 0, cancelId: 0, message: `移除「${p.name}」？`, detail: '只移除本地配置，不影响订阅服务。' }); if (result.response !== 1) return; if (id === store.data.activeId) { await disconnect(); store.data.activeId = store.data.profiles.find(p => p.id !== id)?.id || null; } store.data.profiles = store.data.profiles.filter(p => p.id !== id); fs.rmSync(store.profilePath(id), { force: true }); store.save(); }));
  handle('mode', mode => exclusive(async () => { if (!['rule', 'global', 'direct'].includes(mode)) throw Error('模式无效'); if (engine.ready) await engine.api('/configs', 'PATCH', { mode }); store.data.mode = mode; store.save(); }));
  handle('systemProxy', enabled => exclusive(async () => { if (typeof enabled !== 'boolean') throw Error('参数无效'); if (enabled) { if (!engine.ready) throw Error('请先连接'); await proxy.enable(engine.port); } else await proxy.restore(); }));
  handle('stats', () => engine.stats());
  handle('node:select', async ({ group, name }) => { if (!engine.ready) throw Error('请先连接'); const data = await engine.api('/proxies'); if (data.proxies[group]?.type !== 'Selector' || !data.proxies[group].all.includes(name)) throw Error('此策略组不支持手动切换'); await engine.api(`/proxies/${encodeURIComponent(group)}`, 'PUT', { name }); });
  handle('node:delay', async name => { if (!engine.ready || typeof name !== 'string' || name.length > 1024) throw Error('请先连接'); return engine.api(`/proxies/${encodeURIComponent(name)}/delay?timeout=7000&url=${encodeURIComponent('https://www.gstatic.com/generate_204')}`); });
  handle('connections:clear', () => engine.ready ? engine.api('/connections', 'DELETE') : null);
  handle('logs', () => engine.logs);
  handle('settings', payload => exclusive(async () => { if (typeof payload?.closeToTray === 'boolean') store.data.closeToTray = payload.closeToTray; if (typeof payload?.launchAtLogin === 'boolean') { if (process.platform !== 'win32') throw Error('仅支持 Windows'); if (process.env.PORTABLE_EXECUTABLE_DIR) throw Error('便携版不支持开机启动，请使用安装版'); app.setLoginItemSettings({ openAtLogin: payload.launchAtLogin }); store.data.launchAtLogin = payload.launchAtLogin; } store.save(); }));
  handle('window', action => { if (action === 'minimize') win.minimize(); else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (action === 'close') win.close(); else if (action === 'quit') app.quit(); });
  tray = new Tray(nativeImage.createFromPath(asset('icon.png')).resize({ width: 24, height: 24 })); tray.on('double-click', () => { win.show(); win.focus(); }); updateTray(); await createWindow();
}).catch(err => { dialog.showErrorBox('Luma 启动失败', err.message); app.exit(1); });
app.on('before-quit', event => { if (quitting) return; event.preventDefault(); if (busy) { win?.show(); return; } quitting = true; (async () => { try { await proxy?.restore(); await engine?.stop(); } catch(e) { dialog.showErrorBox('请检查系统代理', '无法自动恢复 Windows 代理设置，请在系统设置中关闭代理后退出。'); } finally { app.quit(); } })(); });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
