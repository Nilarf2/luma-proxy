const decode64 = value => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function uriProxy(line, index) {
  let value = line.trim();
  if (value.startsWith('vmess://')) {
    let v; try { v = JSON.parse(decode64(value.slice(8))); } catch { throw Error('VMess 链接无效'); }
    const p = { name: String(v.ps || `VMess ${index}`), type: 'vmess', server: String(v.add || ''), port: +v.port, uuid: String(v.id || ''), alterId: +v.aid || 0, cipher: v.scy || 'auto', udp: true };
    if (v.tls === 'tls') { p.tls = true; p.servername = v.sni || v.host || v.add; }
    if (v.net === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: v.path || '/', headers: v.host ? { Host: v.host } : {} }; }
    if (v.net === 'grpc') { p.network = 'grpc'; p['grpc-opts'] = { 'grpc-service-name': v.path || '' }; }
    return validate(p);
  }
  if (value.startsWith('ss://')) {
    const fragment = value.indexOf('#'); const name = fragment >= 0 ? decodeURIComponent(value.slice(fragment + 1)) : `SS ${index}`; if (fragment >= 0) value = value.slice(0, fragment);
    let body = value.slice(5); if (!body.includes('@')) body = decode64(body);
    const at = body.lastIndexOf('@'); if (at < 0) throw Error('SS 链接无效');
    let auth = body.slice(0, at); if (!auth.includes(':')) auth = decode64(auth);
    const colon = auth.indexOf(':'); if (colon < 0) throw Error('SS 链接无效');
    const u = new URL('ss://' + body.slice(at + 1));
    if (u.searchParams.has('plugin')) throw Error('请使用 YAML 配置导入带插件的 SS 节点');
    return validate({ name, type: 'ss', server: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port, cipher: auth.slice(0, colon), password: decodeURIComponent(auth.slice(colon + 1)), udp: true });
  }
  let u; try { u = new URL(value); } catch { throw Error('节点链接无效'); }
  if (!['trojan:', 'vless:'].includes(u.protocol)) throw Error('不支持的节点链接，请导入 YAML 配置');
  const q = u.searchParams, type = u.protocol.slice(0, -1);
  const p = { name: decodeURIComponent(u.hash.slice(1)) || `${type} ${index}`, type, server: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port || 443, udp: true };
  p[type === 'trojan' ? 'password' : 'uuid'] = decodeURIComponent(u.username);
  p.tls = type === 'trojan' || ['tls', 'reality'].includes(q.get('security'));
  if (q.get('sni')) p.servername = q.get('sni');
  if (q.get('fp')) p['client-fingerprint'] = q.get('fp');
  if (q.get('flow')) p.flow = q.get('flow');
  if (q.get('security') === 'reality') p['reality-opts'] = { 'public-key': q.get('pbk') || '', 'short-id': q.get('sid') || '' };
  if (q.get('alpn')) p.alpn = q.get('alpn').split(',');
  if (q.get('type') === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: q.get('path') || '/', headers: q.get('host') ? { Host: q.get('host') } : {} }; }
  if (q.get('type') === 'grpc') { p.network = 'grpc'; p['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' }; }
  return validate(p);
}
function validate(p) { if (!p.server || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535 || !p.name || p.name.length > 200 || /[\r\n\0]/.test(p.server)) throw Error('节点地址或端口无效'); if (['vmess', 'vless'].includes(p.type) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.uuid)) throw Error('节点 UUID 无效'); return p; }
function uriProfile(text) {
  let input = text.trim(); if (!/^(ss|vmess|trojan|vless):\/\//m.test(input)) input = decode64(input);
  const lines = input.split(/\r?\n/).map(x => x.trim()).filter(Boolean); if (!lines.length || lines.length > 10000) throw Error('节点列表无效');
  const names = new Set();
  const proxies = lines.map((line, index) => { const p = uriProxy(line, index + 1); const base = p.name; let suffix = 2; while (names.has(p.name)) p.name = `${base} ${suffix++}`; names.add(p.name); return p; });
  return { proxies, 'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: [...proxies.map(p => p.name), 'DIRECT'] }], rules: ['MATCH,Proxy'] };
}
module.exports = { uriProfile, uriProxy };
