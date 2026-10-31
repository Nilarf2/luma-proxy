const YAML = require('yaml');
const crypto = require('node:crypto');
const { normalizeSettings } = require('./settings.cjs');
const { uriProfile, decode64 } = require('./uri.cjs');
const MAX_PROFILE = 8 * 1024 * 1024;
function parseProfile(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_PROFILE) throw Error('配置文件不能超过 8 MB');
  let doc;
  try { doc = YAML.parse(text, { maxAliasCount: 50, uniqueKeys: true }); } catch { doc = null; }
  // Some providers wrap a complete Clash/Mihomo YAML document in Base64.
  // Decode it before falling back to line-oriented URI subscriptions.
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    try {
      const decoded = decode64(text);
      const decodedDoc = YAML.parse(decoded, { maxAliasCount: 50, uniqueKeys: true });
      if (decodedDoc && typeof decodedDoc === 'object' && !Array.isArray(decodedDoc)) doc = decodedDoc;
    } catch { /* URI/Base64 URI parsing below provides the final error. */ }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    try { doc = uriProfile(text); } catch { throw Error('无法解析配置，请导入有效的 YAML、Base64 订阅或节点链接'); }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (!Array.isArray(doc.proxies) && !doc['proxy-providers'])) { try { doc = uriProfile(text); } catch { throw Error('需要 Clash / Mihomo YAML、Base64 订阅或节点链接'); } }
  const directOnly = Array.isArray(doc.proxies) && !doc.proxies.length && Array.isArray(doc.rules) && doc.rules.length > 0 && doc.rules.every(rule => typeof rule === 'string') && doc.rules.some(rule => /^MATCH\s*,\s*DIRECT\s*$/i.test(rule));
  if (!(doc.proxies?.length || Object.keys(doc['proxy-providers'] || {}).length || directOnly)) throw Error('配置中没有代理节点或直连规则');
  return doc;
}
function parseOverride(text = '') {
  if (!text.trim()) return {};
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error('覆写配置不能超过 1 MB');
  let doc; try { doc = YAML.parse(text, { maxAliasCount: 50, uniqueKeys: true }); } catch { throw Error('覆写 YAML 格式无效'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw Error('覆写需要 YAML 对象');
  return doc;
}
function mergeConfig(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('覆写字段无效');
    if (key.startsWith('prepend-') || key.startsWith('append-')) {
      const target = key.slice(key.indexOf('-') + 1); if (!Array.isArray(value) || !['rules', 'proxies', 'proxy-groups'].includes(target)) throw Error('覆写合并字段无效');
      base[target] = key.startsWith('prepend-') ? [...value, ...(base[target] || [])] : [...(base[target] || []), ...value];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) base[key] = mergeConfig(base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]) ? base[key] : {}, value);
    else base[key] = value;
  }
  return base;
}
function runtimeConfig(text, port, controller, secret, mode = 'rule', settings = {}, profileOverride = '') {
  const c = mergeConfig(mergeConfig(parseProfile(text), parseOverride(settings.globalOverride)), parseOverride(profileOverride));
  const options = normalizeSettings(settings).core;
  for (const key of ['external-ui', 'external-ui-url', 'external-ui-name', 'external-controller-unix', 'external-controller-tls', 'external-controller-pipe', 'listeners', 'tunnels', 'authentication']) delete c[key];
  // Only the user's validated settings control listeners, admin APIs and TUN.
  Object.assign(c, { 'mixed-port': port, port: options.httpPort, 'socks-port': options.socksPort, 'redir-port': 0, 'tproxy-port': 0, 'allow-lan': options.allowLan, 'bind-address': options.allowLan ? '*' : '127.0.0.1', 'external-controller': `127.0.0.1:${controller}`, secret, mode, ipv6: options.ipv6, 'log-level': options.logLevel, tun: { enable: options.tun.enabled, device: 'Luma', stack: options.tun.stack, 'auto-route': options.tun.autoRoute, 'auto-detect-interface': true, 'strict-route': options.tun.strictRoute, mtu: options.tun.mtu, 'dns-hijack': ['any:53', 'tcp://any:53'], 'route-exclude-address': options.tun.routeExcludeAddress }, profile: { 'store-selected': true, 'store-fake-ip': true } });
  c.dns = { ...(c.dns || {}), enable: options.dns.enabled, listen: '127.0.0.1:0', ipv6: options.ipv6, 'enhanced-mode': options.dns.enhancedMode, 'fake-ip-range': '198.18.0.1/16', 'fake-ip-filter': options.dns.fakeIpFilter, nameserver: options.dns.nameserver, fallback: options.dns.fallback };
  for (const section of ['proxy-providers', 'rule-providers']) {
    for (const [name, provider] of Object.entries(c[section] || {})) {
      if (provider && typeof provider === 'object') {
        provider.path = `./providers/${crypto.createHash('sha256').update(section + name).digest('hex')}.yaml`;
        if (provider.type === 'file' && !settings.localProviders?.[`${section}:${name}`]) throw Error('请先在配置编辑中导入此本地 Provider 文件');
      }
    }
  }
  return YAML.stringify(c);
}
function subscriptionUsage(header) {
  const usage = {};
  for (const part of String(header || '').split(';')) { const [key, value] = part.trim().split('='); if (['upload', 'download', 'total', 'expire'].includes(key) && /^\d+$/.test(value)) usage[key] = Number(value); }
  return Object.keys(usage).length ? usage : null;
}
async function downloadSubscription(url, options, proxyPort) {
  const { requestSubscription } = require('./download.cjs');
  const res = await requestSubscription(url, options, proxyPort);
  const text = res.body.toString('utf8'); parseProfile(text);
  return { text, usage: subscriptionUsage(res.headers['subscription-userinfo']), updateInterval: Math.max(0, Math.min(10080, Math.floor(Number(res.headers['profile-update-interval']) * 60 || 0))) };
}
async function downloadProfile(url) { return (await downloadSubscription(url)).text; }
module.exports = { parseProfile, runtimeConfig, downloadProfile, downloadSubscription, subscriptionUsage, parseOverride, mergeConfig };
