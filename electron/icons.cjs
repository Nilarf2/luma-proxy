const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function identity(payload) {
  if (!payload || !['tray', 'group'].includes(payload.kind) || payload.kind === 'group' && (typeof payload.name !== 'string' || !payload.name || payload.name.length > 1024)) throw Error('图标设置无效');
  return payload.kind === 'tray' ? 'tray' : 'group-' + crypto.createHash('sha256').update(payload.name).digest('hex');
}
function registerIcons(ctx) {
  const { handle, dialog, getWindow, store, publish, nativeImage } = ctx;
  const dir = path.join(store.dir, 'icons');
  const cache = new Map(); let generation = 0;
  const target = payload => path.join(dir, identity(payload) + '.png');
  function load(file) { if (cache.has(file)) return cache.get(file); let result = null; try { if (fs.statSync(file).size <= 2 * 1024 * 1024) { const image = nativeImage.createFromPath(file); if (!image.isEmpty()) result = image.toDataURL(); } } catch {} cache.set(file, result); return result; }
  function snapshot() {
    const groups = Object.fromEntries(Object.keys(store.data.groupIcons || {}).filter(name => name.length > 0 && name.length <= 1024).slice(0, 200).flatMap(name => { const image = load(target({kind:'group',name})); return image ? [[name, image]] : []; }));
    return { icons: { tray: load(target({kind:'tray'})), groups } };
  }
  handle('icons:list', () => snapshot().icons);
  handle('icons:import', async payload => {
    const file = target(payload);
    const result = await dialog.showOpenDialog(getWindow(), { title:'选择图标',filters:[{name:'图标',extensions:['png','ico']}],properties:['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = result.filePaths[0];
    if (!/\.(png|ico)$/i.test(source) || fs.statSync(source).size > 2 * 1024 * 1024) throw Error('请选择不超过 2 MB 的 PNG 或 ICO');
    const bytes = fs.readFileSync(source);
    if (!(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.subarray(0,4).equals(Buffer.from([0,0,1,0])))) throw Error('图标格式无效');
    const image = nativeImage.createFromBuffer(bytes); const size = image.getSize();
    if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) throw Error('图标尺寸无效');
    const scale = Math.min(1, 256 / Math.max(size.width, size.height));
    const normalized = image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'best'}).toPNG();
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file+'.tmp',normalized,{mode:0o600});fs.renameSync(file+'.tmp',file);
    cache.delete(file); generation++;
    if (payload.kind === 'group') { const entries=Object.entries(store.data.groupIcons || {}).filter(([name])=>name!==payload.name);store.data.groupIcons=Object.fromEntries([...entries.slice(-199),[payload.name,true]]);store.save(); }
    publish(); return snapshot().icons;
  });
  handle('icons:reset', payload => { const file = target(payload); fs.rmSync(file,{force:true}); cache.delete(file); generation++; if(payload.kind==='group'){store.data.groupIcons=Object.fromEntries(Object.entries(store.data.groupIcons||{}).filter(([name])=>name!==payload.name));store.save();}publish();return snapshot().icons; });
  return { snapshot, trayKey:()=>generation, trayPath:()=>load(target({kind:'tray'}))?target({kind:'tray'}):null };
}
module.exports = { registerIcons, identity };
