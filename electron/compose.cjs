const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const vm = require('node:vm');
const YAML = require('yaml');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseProfile, parseOverride, mergeConfig } = require('./profile.cjs');
function validateScript(script = '') {
  if (typeof script !== 'string' || Buffer.byteLength(script) > 256 * 1024) throw Error('脚本不能超过 256 KB');
  try { new vm.Script(script); } catch { throw Error('脚本语法无效'); }
  return script;
}
function runScript(config, script) {
  validateScript(script);
  if (!script.trim()) return Promise.resolve(config);
  const input = JSON.stringify(config);
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw Error('脚本输入过大');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'compose-worker.cjs'), { workerData: { input, script }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    const timer = setTimeout(() => { worker.terminate(); reject(Error('脚本执行超时')); }, 1500);
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    worker.once('message', message => { finish(); if (message.error) reject(Error('脚本执行失败，请检查 main(config)')); else { try { const result = JSON.parse(message.result); if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error(); resolve(result); } catch { reject(Error('脚本必须返回配置对象')); } } });
    worker.once('error', () => { finish(); reject(Error('脚本执行失败或超过资源限制')); });
    worker.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(Error('脚本执行失败或超过资源限制')); } });
  });
}
function composeProfile(store, id, visited = new Set(), textOverride) {
  if (visited.has(id)) throw Error('订阅合并存在循环引用');
  const profile = store.data.profiles.find(p => p.id === id); if (!profile) throw Error('合并来源订阅不存在');
  const next = new Set(visited); next.add(id);
  const base = parseProfile(textOverride === undefined ? fs.readFileSync(store.profilePath(id), 'utf8') : textOverride);
  for (const sourceId of profile.sourceIds || []) {
    const source = composeProfile(store, sourceId, next);
    for (const section of ['proxies', 'proxy-groups']) for (const value of source[section] || []) {
      base[section] ||= []; const old = base[section].find(p => p.name === value.name);
      if (old && JSON.stringify(old) !== JSON.stringify(value)) throw Error(`合并存在重复名称：${String(value.name).slice(0, 80)}`);
      if (!old) base[section].push(value);
    }
    for (const section of ['proxy-providers', 'rule-providers']) for (const [name, value] of Object.entries(source[section] || {})) { base[section] ||= {}; if (base[section][name] && JSON.stringify(base[section][name]) !== JSON.stringify(value)) throw Error('合并 Provider 名称重复'); base[section][name] = value; }
    base.rules = [...(source.rules || []).filter(rule => !/^MATCH,/i.test(rule)), ...(base.rules || [])];
  }
  return base;
}
async function prepareProfile(store, id) {
  const profile = store.data.profiles.find(p => p.id === id);
  let config = composeProfile(store, id);
  config = mergeConfig(mergeConfig(config, parseOverride(store.data.globalOverride)), parseOverride(profile.override || ''));
  config = await runScript(config, store.data.globalScript || '');
  config = await runScript(config, profile.script || '');
  return YAML.stringify(config);
}
function providerFiles(store, id, seen = new Set()) {
  if (seen.has(id)) throw Error('订阅合并存在循环引用'); seen.add(id);
  const p = store.data.profiles.find(p => p.id === id); if (!p) throw Error('订阅不存在');
  const files = {}, allowed = {};
  for (const source of p.sourceIds || []) { const found = providerFiles(store, source, new Set(seen)); Object.assign(files, found.files); Object.assign(allowed, found.allowed); }
  for (const [key, file] of Object.entries(p.localProviders || {})) {
    if (!/^[a-f0-9]{64}\.yaml$/.test(file) || !/^(proxy-providers|rule-providers):.+/.test(key)) throw Error('本地 Provider 记录无效');
    const input = path.join(store.dir, 'provider-assets', file); if (fs.statSync(input).size > 8 * 1024 * 1024) throw Error('Provider 过大');
    const colon = key.indexOf(':'); const hash = crypto.createHash('sha256').update(key.slice(0, colon) + key.slice(colon + 1)).digest('hex');
    files[`./providers/${hash}.yaml`] = fs.readFileSync(input, 'utf8'); allowed[key] = true;
  }
  return { files, allowed };
}
module.exports = { validateScript, runScript, composeProfile, prepareProfile, providerFiles };
