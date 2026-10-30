const fs = require('node:fs');
const path = require('node:path');
const { normalizeSettings } = require('./settings.cjs');
class Store {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'settings.json'); fs.mkdirSync(dir, { recursive: true }); this.data = normalizeSettings(fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}); }
  save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  profilePath(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('配置 ID 无效'); return path.join(this.dir, `${id}.yaml`); }
  publicData() { const { secret, ...controller } = this.data.controller; return { ...this.data, controller: { ...controller, hasSecret: !!secret }, profiles: this.data.profiles.map(({ url, ...p }) => ({ ...p, remote: !!url })) }; }
}
module.exports = { Store };
