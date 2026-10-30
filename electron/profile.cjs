const YAML = require('yaml');
const crypto = require('node:crypto');
const MAX_PROFILE = 8 * 1024 * 1024;
function parseProfile(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_PROFILE) throw Error('配置文件不能超过 8 MB');
  let doc;
  try { doc = YAML.parse(text, { maxAliasCount: 50, uniqueKeys: true }); } catch { throw Error('无法解析配置，请导入有效的 Clash / Mihomo YAML'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (!Array.isArray(doc.proxies) && !doc['proxy-providers'])) throw Error('需要 Clash / Mihomo YAML 配置，暂不支持 Base64 或单个节点链接');
  if (!(doc.proxies?.length || Object.keys(doc['proxy-providers'] || {}).length)) throw Error('配置中没有代理节点');
  return doc;
}
function runtimeConfig(text, port, controller, secret, mode = 'rule') {
  const c = parseProfile(text);
  for (const key of ['external-ui', 'external-ui-url', 'external-ui-name', 'external-controller-unix', 'external-controller-tls', 'external-controller-pipe', 'listeners', 'tunnels', 'authentication']) delete c[key];
  // Subscription content never controls local listeners, admin APIs or TUN.
  Object.assign(c, { 'mixed-port': port, port: 0, 'socks-port': 0, 'redir-port': 0, 'tproxy-port': 0, 'allow-lan': false, 'bind-address': '127.0.0.1', 'external-controller': `127.0.0.1:${controller}`, secret, mode, ipv6: false, 'log-level': 'warning', tun: { enable: false }, profile: { 'store-selected': true, 'store-fake-ip': false } });
  if (c.dns?.enable) c.dns.listen = '127.0.0.1:0';
  for (const section of ['proxy-providers', 'rule-providers']) {
    for (const [name, provider] of Object.entries(c[section] || {})) {
      if (provider && typeof provider === 'object') {
        provider.path = `./providers/${crypto.createHash('sha256').update(section + name).digest('hex')}.yaml`;
        if (provider.type === 'file') throw Error('暂不支持依赖外部文件的 provider，请使用 HTTP 或内嵌节点配置');
      }
    }
  }
  return YAML.stringify(c);
}
async function downloadProfile(url) {
  let u;
  try { u = new URL(url); } catch { throw Error('请输入有效的订阅地址'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw Error('订阅地址必须为 HTTP / HTTPS');
  const res = await fetch(u, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'Luma/0.1.0 Mihomo', Accept: 'text/yaml,text/plain,*/*' } });
  if (!res.ok) throw Error(`订阅下载失败（HTTP ${res.status}）`);
  let size = 0; const chunks = [];
  for await (const chunk of res.body) { size += chunk.length; if (size > MAX_PROFILE) throw Error('订阅文件不能超过 8 MB'); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8'); parseProfile(text); return text;
}
module.exports = { parseProfile, runtimeConfig, downloadProfile };
