const decode64 = value => {
  const source = String(value || '').trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!source || source.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)) throw Error('Base64 内容无效');
  const decoded = Buffer.from(source, 'base64');
  if (!decoded.length) throw Error('Base64 内容无效');
  return decoded.toString('utf8');
};
function decodePart(value) { try { return decodeURIComponent(value || ''); } catch { throw Error('节点链接编码无效'); } }
function userInfo(u) {
  const raw = u.username || '';
  const password = u.password || '';
  return { username: decodePart(raw), password: decodePart(password) };
}
function queryBool(q, ...keys) { for (const key of keys) if (q.has(key)) return !['0','false','no','off'].includes(String(q.get(key)).toLowerCase()); return undefined; }
function queryList(q, key) { const value = q.get(key); return value ? value.split(',').map(v => v.trim()).filter(Boolean) : undefined; }
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
    const fragment = value.indexOf('#'); const name = fragment >= 0 ? decodePart(value.slice(fragment + 1)) : `SS ${index}`; if (fragment >= 0) value = value.slice(0, fragment);
    let body = value.slice(5); if (!body.includes('@')) body = decode64(body);
    const at = body.lastIndexOf('@'); if (at < 0) throw Error('SS 链接无效');
    let auth = body.slice(0, at); if (!auth.includes(':')) auth = decode64(auth);
    const colon = auth.indexOf(':'); if (colon < 0) throw Error('SS 链接无效');
    const u = new URL('ss://' + body.slice(at + 1));
    if (u.searchParams.has('plugin')) throw Error('请使用 YAML 配置导入带插件的 SS 节点');
    return validate({ name, type: 'ss', server: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port, cipher: auth.slice(0, colon), password: decodePart(auth.slice(colon + 1)), udp: true });
  }
  if (value.startsWith('ssr://')) return parseSsr(value.slice(6), index);
  let u; try { u = new URL(value); } catch { throw Error('节点链接无效'); }
  const q = u.searchParams, protocol = u.protocol.toLowerCase();
  if (['http:', 'socks:', 'socks5:'].includes(protocol)) {
    const auth = userInfo(u), type = protocol === 'http:' ? 'http' : 'socks5';
    const p = { name: decodePart(u.hash.slice(1)) || `${type.toUpperCase()} ${index}`, type, server: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port || 80, udp: type === 'socks5' };
    if (auth.username) p.username = auth.username; if (auth.password) p.password = auth.password;
    const tls = queryBool(q, 'tls', 'ssl'); if (tls !== undefined) p.tls = tls;
    if (q.get('sni')) p.servername = q.get('sni');
    if (q.get('insecure') || q.get('allowInsecure')) p['skip-cert-verify'] = queryBool(q, 'insecure', 'allowInsecure');
    if (q.get('udp')) p.udp = queryBool(q, 'udp');
    return validate(p);
  }
  if (protocol === 'hysteria2:' || protocol === 'hy2:') {
    const auth = userInfo(u); const p = { name: decodePart(u.hash.slice(1)) || `Hysteria2 ${index}`, type: 'hysteria2', server: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port || 443, password: auth.password || auth.username, udp: true };
    if (!p.password) throw Error('Hysteria2 链接缺少密码');
    if (q.get('sni')) p.sni = q.get('sni'); if (q.get('obfs')) p.obfs = q.get('obfs'); if (q.get('obfs-password')) p['obfs-password'] = q.get('obfs-password');
    if (q.get('insecure') || q.get('allowInsecure')) p['skip-cert-verify'] = queryBool(q, 'insecure', 'allowInsecure');
    const alpn = queryList(q, 'alpn'); if (alpn) p.alpn = alpn;
    return validate(p);
  }
  if (protocol === 'tuic:') {
    const auth = userInfo(u), p = { name: decodePart(u.hash.slice(1)) || `TUIC ${index}`, type: 'tuic', server: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port || 443, uuid: auth.username, password: auth.password, udp: true };
    if (!p.uuid || !p.password) throw Error('TUIC 链接缺少 UUID 或密码');
    if (q.get('sni')) p.sni = q.get('sni'); if (q.get('congestion_control')) p['congestion-controller'] = q.get('congestion_control'); if (q.get('udp_relay_mode')) p['udp-relay-mode'] = q.get('udp_relay_mode');
    if (q.get('heartbeat_interval')) p['heartbeat-interval'] = Number(q.get('heartbeat_interval')) || q.get('heartbeat_interval');
    if (q.get('reduce_rtt')) p['reduce-rtt'] = queryBool(q, 'reduce_rtt');
    if (q.get('insecure') || q.get('allowInsecure')) p['skip-cert-verify'] = queryBool(q, 'insecure', 'allowInsecure');
    const alpn = queryList(q, 'alpn'); if (alpn) p.alpn = alpn;
    return validate(p);
  }
  if (!['trojan:', 'vless:'].includes(protocol)) throw Error('不支持的节点链接，请导入 YAML 配置');
  const type = protocol.slice(0, -1);
  const p = { name: decodePart(u.hash.slice(1)) || `${type} ${index}`, type, server: u.hostname.replace(/^\[|\]$/g, ''), port: +u.port || 443, udp: true };
  p[type === 'trojan' ? 'password' : 'uuid'] = decodePart(u.username);
  p.tls = type === 'trojan' || ['tls', 'reality'].includes(q.get('security'));
  if (q.get('sni')) p.servername = q.get('sni'); if (q.get('fp')) p['client-fingerprint'] = q.get('fp'); if (q.get('flow')) p.flow = q.get('flow');
  if (q.get('security') === 'reality') p['reality-opts'] = { 'public-key': q.get('pbk') || '', 'short-id': q.get('sid') || '' };
  if (q.get('alpn')) p.alpn = q.get('alpn').split(',');
  if (q.get('type') === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: q.get('path') || '/', headers: q.get('host') ? { Host: q.get('host') } : {} }; }
  if (q.get('type') === 'grpc') p.network = 'grpc', p['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' };
  return validate(p);
}
function parseSsr(encoded, index) {
  let decoded; try { decoded = decode64(encoded); } catch { throw Error('SSR 链接无效'); }
  const [main, query = ''] = decoded.split('/?'); const parts = main.split(':'); if (parts.length < 6) throw Error('SSR 链接无效');
  const [server, portText, protocol, cipher, obfs, password64] = parts; const port = Number(portText); if (!server || !Number.isInteger(port)) throw Error('SSR 链接无效');
  const params = new URLSearchParams(query.replace(/&amp;/g, '&')); const password = decode64(password64); const p = { name: params.get('remarks') ? decode64(params.get('remarks')) : `SSR ${index}`, type: 'ssr', server, port, protocol, cipher, obfs, password, udp: true };
  if (params.get('obfsparam')) p['obfs-param'] = decode64(params.get('obfsparam')); if (params.get('protoparam')) p['protocol-param'] = decode64(params.get('protoparam')); return validate(p);
}
function validate(p) { if (!p.server || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535 || !p.name || p.name.length > 200 || /[\r\n\0]/.test(p.server)) throw Error('节点地址或端口无效'); if (['vmess', 'vless', 'tuic'].includes(p.type) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.uuid)) throw Error('节点 UUID 无效'); return p; }
function uriProfile(text) {
  let input = text.trim();
  const supported = /^(ss|ssr|vmess|trojan|vless|hysteria2|hy2|tuic|http|socks5|socks):\/\//im;
  if (!supported.test(input)) input = decode64(input);
  const lines = input.split(/\r?\n/).map(x => x.trim()).filter(Boolean); if (!lines.length || lines.length > 10000) throw Error('节点列表无效');
  const names = new Set(); const proxies = lines.map((line, index) => { const p = uriProxy(line, index + 1); const base = p.name; let suffix = 2; while (names.has(p.name)) p.name = `${base} ${suffix++}`; names.add(p.name); return p; });
  return { proxies, 'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: [...proxies.map(p => p.name), 'DIRECT'] }], rules: ['MATCH,Proxy'] };
}
module.exports = { uriProfile, uriProxy, decode64 };
