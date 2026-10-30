const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { normalizeDownload } = require('./download.cjs');
const { parseProfile, parseOverride, downloadSubscription } = require('./profile.cjs');
const { validateScript, composeProfile } = require('./compose.cjs');
const { selectCertificatePair } = require('./certificates.cjs');
function writeProfile(store, id, text) { const file = store.profilePath(id); fs.writeFileSync(file + '.tmp', text, { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
function registerProfiles(ctx) {
  const { handle, store, engine, dialog, getWindow, exclusive, disconnect, connect, publish } = ctx;
  const find = id => { const p = store.data.profiles.find(p => p.id === id); if (!p) throw Error('订阅不存在'); return p; };
  function affectsActive(id, active = store.data.activeId, seen = new Set()) { if (id === active) return true; if (seen.has(active)) return false; seen.add(active); return (store.data.profiles.find(p => p.id === active)?.sourceIds || []).some(source => affectsActive(id, source, seen)); }
  async function replace(p, text) {
    parseProfile(text);
    const previous = fs.readFileSync(store.profilePath(p.id), 'utf8');
    if (affectsActive(p.id)) validateActiveText(p.id, text);
    const running = engine.ready && affectsActive(p.id);
    if (running) await disconnect();
    writeProfile(store, p.id, text);
    try { if (running) await connect(); }
    catch (error) { writeProfile(store, p.id, previous); if (running) await connect().catch(() => {}); throw error; }
    p.updatedAt = new Date().toISOString(); store.save();
  }
  function validateActiveText(id, text) { const temporary = store.profilePath(id) + '.validate'; fs.writeFileSync(temporary, text, {mode:0o600}); try { composeProfile({data:store.data,profilePath:source=>source===id?temporary:store.profilePath(source)},store.data.activeId); } finally { fs.rmSync(temporary,{force:true}); } }
  async function update(p) {
    if (!p.url) throw Error('本地配置请直接编辑或重新导入');
    try { const result = await downloadSubscription(p.url, p.download, engine.ready ? engine.port : undefined); await replace(p, result.text); p.usage = result.usage; p.lastUpdateError = ''; p.lastAttemptAt = new Date().toISOString(); store.save(); }
    catch (error) { p.lastUpdateError = '更新失败，请稍后重试'; p.lastAttemptAt = new Date().toISOString(); store.save(); throw error; }
  }
  handle('profile:import', payload => exclusive(async () => {
    if (!payload || !['url', 'file', 'text'].includes(payload.type)) throw Error('导入方式无效');
    let text, url, name, usage = null, updateInterval = 0;
    if (payload.type === 'url') { if (typeof payload.url !== 'string') throw Error('请输入订阅地址'); url = payload.url.trim(); const result = await downloadSubscription(url, payload.download, engine.ready ? engine.port : undefined); ({ text, usage, updateInterval } = result); name = '我的订阅'; }
    else if (payload.type === 'text') { text = payload.text; name = '本地配置'; }
    else { const result = await dialog.showOpenDialog(getWindow(), { title: '导入配置', filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }], properties: ['openFile'] }); if (result.canceled) return; if (fs.statSync(result.filePaths[0]).size > 8 * 1024 * 1024) throw Error('配置不能超过 8 MB'); text = fs.readFileSync(result.filePaths[0], 'utf8'); name = path.basename(result.filePaths[0]).replace(/\.ya?ml$/i, ''); }
    parseProfile(text); const id = crypto.randomUUID();
    const profile = { id, name: String(payload.name || name).slice(0, 80), url, updatedAt: new Date().toISOString(), usage, updateInterval, download: normalizeDownload(payload.download), override: '' };
    writeProfile(store, id, text); store.data.profiles.push(profile); store.data.activeId ||= id; store.save();
  }));
  handle('profile:get', id => { const p = find(id); return { text: fs.readFileSync(store.profilePath(id), 'utf8'), override: p.override || '', script: p.script || '', sourceIds: p.sourceIds || [], download: normalizeDownload(p.download) }; });
  handle('profile:save', payload => exclusive(async () => { if (!payload || typeof payload.text !== 'string') throw Error('配置无效'); await edit(payload); }));
  handle('profile:update', id => exclusive(() => update(find(id))));
  handle('profile:update-all', () => exclusive(async () => { const failures = []; for (const p of store.data.profiles.filter(p => p.url)) try { await update(p); } catch { failures.push(p.name); } if (failures.length) throw Error(`${failures.length} 个订阅更新失败`); }));
  async function edit(payload) {
    const p = find(payload?.id); const previous = { ...p }, next = { ...p };
    if ('name' in payload) { if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 80) throw Error('名称长度为 1–80 个字符'); next.name = payload.name.trim(); }
    if ('updateInterval' in payload) { if (!Number.isInteger(payload.updateInterval) || payload.updateInterval < 0 || payload.updateInterval > 10080) throw Error('更新间隔范围为 0–10080 分钟'); next.updateInterval = payload.updateInterval; }
    if ('override' in payload) { if (typeof payload.override !== 'string') throw Error('覆写无效'); parseOverride(payload.override); next.override = payload.override; }
    if ('download' in payload) next.download = normalizeDownload(payload.download);
    if ('script' in payload) next.script = validateScript(payload.script);
    if ('sourceIds' in payload) { if (!Array.isArray(payload.sourceIds) || payload.sourceIds.length > 32 || new Set(payload.sourceIds).size !== payload.sourceIds.length || payload.sourceIds.some(id => id === p.id || typeof id !== 'string' || !store.data.profiles.some(source => source.id === id))) throw Error('合并来源无效'); next.sourceIds = payload.sourceIds; }
    if ('text' in payload) parseProfile(payload.text);
    const previousText = fs.readFileSync(store.profilePath(p.id), 'utf8');
    composeProfile({ data: { ...store.data, profiles: store.data.profiles.map(source => source.id === p.id ? next : source) }, profilePath: id => store.profilePath(id) }, p.id, new Set(), payload.text);
    if ('text' in payload && affectsActive(p.id)) validateActiveText(p.id, payload.text);
    const running = engine.ready && affectsActive(p.id) && (previous.override !== next.override || previous.script !== next.script || JSON.stringify(previous.sourceIds) !== JSON.stringify(next.sourceIds) || 'text' in payload);
    if (running) await disconnect();
    Object.assign(p, next);
    try { if ('text' in payload) { writeProfile(store, p.id, payload.text); p.updatedAt = new Date().toISOString(); } if (running) await connect(); store.save(); }
    catch (error) { Object.assign(p, previous); if ('text' in payload) writeProfile(store, p.id, previousText); if (running) await connect().catch(() => {}); throw error; }
  }
  handle('profile:structured:get', id => { const c = parseProfile(fs.readFileSync(store.profilePath(find(id).id), 'utf8')); return { rules: c.rules || [], proxies: c.proxies || [], groups: c['proxy-groups'] || [] }; });
  handle('profile:structured:apply', payload => exclusive(async () => { const p = find(payload?.id); if (!Array.isArray(payload.rules) || payload.rules.some(v => typeof v !== 'string') || !Array.isArray(payload.proxies) || !Array.isArray(payload.groups) || [...payload.proxies, ...payload.groups].some(v => !v || typeof v !== 'object' || Array.isArray(v) || typeof v.name !== 'string' || !v.name.trim())) throw Error('可视配置格式无效'); for (const values of [payload.proxies,payload.groups]) if (new Set(values.map(v=>v.name)).size !== values.length) throw Error('名称不能重复'); const c = parseProfile(fs.readFileSync(store.profilePath(p.id), 'utf8')); Object.assign(c, {rules:payload.rules, proxies:payload.proxies, 'proxy-groups':payload.groups}); await edit({id:p.id,text:YAML.stringify(c)}); }));
  handle('profile:edit', payload => exclusive(() => edit(payload)));
  handle('profile:certificate:import', payload => exclusive(async () => {
    const p = find(payload?.id), document = parseProfile(fs.readFileSync(store.profilePath(p.id), 'utf8'));
    if (typeof payload?.node !== 'string') throw Error('请选择此配置中的节点');
    const nodes = (document.proxies || []).filter(node => node?.name === payload.node);
    if (nodes.length !== 1) throw Error('请选择此配置中的唯一节点');
    const pair = await selectCertificatePair(dialog, getWindow()); if (!pair) return { canceled: true };
    Object.assign(nodes[0], pair);
    await edit({ id: p.id, text: YAML.stringify(document) }); return { imported: true };
  }));
  handle('profile:export', id => exclusive(async () => { const p = find(id); const result = await dialog.showSaveDialog(getWindow(), { title: '导出配置', defaultPath: p.name.replace(/[<>:"/\\|?*]/g, '_') + '.yaml', filters: [{ name: 'YAML', extensions: ['yaml'] }] }); if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, fs.readFileSync(store.profilePath(id)), { mode: 0o600 }); }));
  handle('profile:provider:import', payload => exclusive(async () => {
    const p = find(payload?.id); const section = payload?.type === 'proxies' ? 'proxy-providers' : payload?.type === 'rules' ? 'rule-providers' : null;
    const document = parseProfile(fs.readFileSync(store.profilePath(p.id), 'utf8'));
    if (!section || typeof payload.name !== 'string' || !document[section]?.[payload.name]) throw Error('Provider 不存在');
    const result = await dialog.showOpenDialog(getWindow(), { title: '导入本地 Provider', filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }], properties: ['openFile'] }); if (result.canceled) return;
    const file = result.filePaths[0]; if (fs.statSync(file).size > 8 * 1024 * 1024) throw Error('Provider 不能超过 8 MB');
    const text = fs.readFileSync(file, 'utf8'); let content; try { content = YAML.parse(text, { maxAliasCount: 50, uniqueKeys: true }); } catch { throw Error('Provider YAML 无效'); }
    if (section === 'proxy-providers' ? !Array.isArray(content?.proxies) || !content.proxies.length : !Array.isArray(content?.payload)) throw Error('Provider 内容无效');
    const key = section + ':' + payload.name; const name = crypto.createHash('sha256').update(p.id + key).digest('hex') + '.yaml';
    const assets = path.join(store.dir, 'provider-assets'); fs.mkdirSync(assets, { recursive: true }); fs.writeFileSync(path.join(assets, name), text, { mode: 0o600 });
    p.localProviders = { ...(p.localProviders || {}), [key]: name }; store.save();
  }));
  const timer = setInterval(() => {
    if (ctx.isBusy() || ctx.isQuitting()) return;
    const due = store.data.profiles.find(p => p.url && p.updateInterval > 0 && Date.now() - Date.parse(p.lastAttemptAt || p.updatedAt || 0) >= p.updateInterval * 60000);
    if (due) exclusive(() => update(due)).catch(() => {}).finally(publish);
  }, 30000); timer.unref();
  return { dispose: () => clearInterval(timer), importUrl: async (url, name) => { const result = await downloadSubscription(url); const id = crypto.randomUUID(); writeProfile(store, id, result.text); store.data.profiles.push({ id, name: String(name || '我的订阅').slice(0, 80), url, usage: result.usage, updateInterval: result.updateInterval, override: '', updatedAt: new Date().toISOString() }); store.data.activeId ||= id; store.save(); } };
}
module.exports = { registerProfiles, writeProfile };
