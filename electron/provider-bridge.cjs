const http = require('node:http');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { parseProfile } = require('./profile.cjs');
const { normalizeDownload, requestSubscription, urlValue } = require('./download.cjs');

function providerDownload(header = {}) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw Error('Provider 请求头格式无效');
  const headers = {};
  for (const [key, value] of Object.entries(header)) {
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.length > 16 || values.some(v => typeof v !== 'string')) throw Error('Provider 请求头格式无效');
    headers[key] = values.join(key.toLowerCase() === 'cookie' ? '; ' : ', ');
  }
  return normalizeDownload({ headers });
}

// The privileged service sees only opaque loopback URLs, never subscription credentials.
class ProviderBridge {
  constructor({ request = requestSubscription } = {}) { this.request = request; this.server = null; this.entries = new Map(); this.closed = false; this.started = false; }
  async start(text) {
    if (this.started || this.closed) throw Error('Provider 桥接已启动或关闭');
    this.started = true;
    try {
      if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error('配置文件过大');
      const config = YAML.parse(text, { uniqueKeys: true, maxAliasCount: 50 });
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('配置格式无效');
      const pending = [];
      for (const provider of Object.values(config['proxy-providers'] || {})) {
        if (provider?.type !== 'http') continue;
        if (pending.length >= 128) throw Error('远程 Provider 数量不能超过 128');
        const url = urlValue(provider.url).href, download = providerDownload(provider.header);
        pending.push({ provider, url, download });
      }
      if (!pending.length) return { config: text };
      const token = crypto.randomBytes(32).toString('hex');
      this.server = http.createServer((req, res) => this.respond(req, res));
      this.server.requestTimeout = 30000; this.server.headersTimeout = 5000;
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
      this.host = `127.0.0.1:${this.server.address().port}`;
      for (const entry of pending) {
        const route = `/luma-provider/${token}/${crypto.randomBytes(32).toString('hex')}`;
        this.entries.set(route, entry);
        entry.provider.url = `http://${this.host}${route}`;
        delete entry.provider.header;
        // The service keeps the original interval for its protected refresh scheduler.
      }
      return { config: YAML.stringify(config) };
    } catch (error) { await this.dispose(); throw error; }
  }
  async respond(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.host !== this.host || !this.entries.has(req.url)) { res.writeHead(404); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    const entry = this.entries.get(req.url);
    try {
      if (!entry.pending) {
        entry.abort = new AbortController();
        entry.pending = (async () => {
          const result = await this.request(entry.url, entry.download, undefined, entry.abort.signal);
          const document = parseProfile(result.body.toString('utf8'));
          if (!Array.isArray(document.proxies) || !document.proxies.length) throw Error('Provider 中没有节点');
          const body = YAML.stringify({ proxies: document.proxies });
          if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw Error('Provider 文件过大');
          return body;
        })().finally(() => { entry.pending = null; entry.abort = null; });
      }
      const body = await entry.pending;
      if (!this.closed && !res.destroyed) { res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' }); res.end(body); }
    } catch { if (!res.destroyed) { res.writeHead(502); res.end('Provider download failed'); } }
  }
  async dispose() {
    this.closed = true;
    for (const entry of this.entries.values()) entry.abort?.abort();
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    this.entries.clear();
  }
}
module.exports = { ProviderBridge, providerDownload };
