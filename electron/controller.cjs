const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

function options(settings) {
  const value = settings?.controller || { enabled: false, port: 9097, secret: '', origins: [] };
  if (typeof value.enabled !== 'boolean' || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || typeof value.secret !== 'string' || value.secret.length > 128 || /[\x00-\x20\x7f-\x9f]/.test(value.secret) || value.enabled && value.secret.length < 24 || !Array.isArray(value.origins) || value.origins.length > 16) throw Error('外部控制器设置无效');
  const origins = value.origins.map(origin => { let url; try { url = new URL(origin); } catch {} if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== origin || origin.includes('*')) throw Error('控制器来源必须是完整 HTTP(S) 来源'); return origin; });
  return { ...value, origins: [...new Set(origins)] };
}
function configMutation(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) throw Error('接口操作不允许');
  const patch = {}, core = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'mode' && ['rule', 'global', 'direct'].includes(value)) patch.mode = value;
    else if (key === 'log-level' && ['silent', 'error', 'warning', 'info', 'debug'].includes(value)) core.logLevel = value;
    else if (key === 'tun' && value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.enable === 'boolean') core.tun = { enabled: value.enable };
    else throw Error('接口操作不允许');
  }
  if (Object.keys(core).length) patch.core = core;
  return patch;
}
function apiPolicy(endpoint, method, data) {
  if (endpoint.length > 8192 || !endpoint.startsWith('/') || /[#\\\x00-\x20]/.test(endpoint) || endpoint.includes('..')) throw Error('接口路径无效');
  const route = endpoint.split('?')[0]; let decoded; try { decoded = decodeURIComponent(route); } catch { throw Error('接口路径无效'); }
  if (decoded.includes('..') || /[\\\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').length !== route.split('/').length || decoded.includes('%')) throw Error('接口路径无效');
  if (method === 'GET' && /^\/providers\/proxies\/[^/]+\/[^/]+\/healthcheck$/.test(route)) return;
  if (method === 'GET' && (['/version', '/configs', '/proxies', '/connections', '/rules', '/providers/proxies', '/providers/rules'].includes(route) || /^\/(proxies|providers\/proxies|providers\/rules)\/[^/]+(\/(delay|healthcheck))?$/.test(route))) return;
  if (method === 'DELETE' && (route === '/connections' || /^\/connections\/[^/]+$/.test(route)) && data === undefined) return;
  if (method === 'PUT' && /^\/providers\/(proxies|rules)\/[^/]+$/.test(route) && data === undefined) return;
  if (method === 'POST' && ['/cache/fakeip/flush', '/cache/dns/flush'].includes(route) && data === undefined) return;
  if (method === 'PUT' && /^\/proxies\/[^/]+$/.test(route) && data && Object.keys(data).length === 1 && typeof data.name === 'string' && data.name.length > 0 && data.name.length < 2048) return;
  if (method === 'PATCH' && route === '/configs' && endpoint === route) return configMutation(data);
  throw Error('接口操作不允许');
}
function publicConfigs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'secret' && !key.startsWith('external-controller') && !key.startsWith('external-ui')));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw Error('请求过大'); chunks.push(chunk); }
  if (!size) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
async function copyWebUi(source, destination) {
  const resolved = await fsp.realpath(source);
  const relative = path.relative(resolved, path.resolve(destination));
  if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw Error('WebUI 来源不能包含目标目录');
  let count = 0, entries = 0, size = 0;
  async function copy(from, to) {
    if (++entries > 4000) throw Error('WebUI 目录过大');
    const stat = await fsp.lstat(from);
    if (stat.isSymbolicLink()) throw Error('WebUI 不能包含符号链接');
    if (stat.isDirectory()) { await fsp.mkdir(to, { recursive: true, mode: 0o700 }); for (const name of await fsp.readdir(from)) { if (name === '.' || name === '..' || /[\\\x00-\x1f]/.test(name)) throw Error('WebUI 文件名无效'); await copy(path.join(from, name), path.join(to, name)); } }
    else if (stat.isFile()) { if (++count > 2000 || (size += stat.size) > 80 * 1024 * 1024) throw Error('WebUI 不能超过 2000 个文件或 80 MB'); await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL); await fsp.chmod(to, 0o600); }
    else throw Error('WebUI 包含不支持的文件');
  }
  await copy(source, destination);
  if (!(await fsp.lstat(path.join(destination, 'index.html'))).isFile()) throw Error('WebUI 缺少 index.html');
}
function registerController(ctx) {
  let current = { enabled: false, port: 9097, secret: '', origins: [] }, server = null, error = '', task = Promise.resolve(), imported = false, disposed = false;
  const webRoot = path.join(ctx.store.dir, 'webui');
  const streams = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  let sampleTask, sampleAt = 0;
  const allowedOrigin = origin => !origin || origin === `http://127.0.0.1:${current.port}` || current.origins.includes(origin);
  const authenticated = value => { const expected = Buffer.from(`Bearer ${current.secret}`), supplied = Buffer.from(String(value || '')); return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected); };
  const stopStreams = () => { for (const client of streams.clients) client.terminate(); sampleTask = undefined; sampleAt = 0; };
  // Stream timers tick every second.  Keep the cache slightly shorter than
  // that interval so a tick that fires a few milliseconds early cannot reuse
  // the previous counter sample and report a false zero-rate update.
  const sampleStats = () => { if (!sampleTask || Date.now() - sampleAt >= 900) { sampleAt = Date.now(); sampleTask = Promise.resolve().then(() => ctx.engine.stats()); } return sampleTask; };
  streams.on('connection', (client, _req, route) => {
    let loading = false, previous = null, logTail = [];
    const send = value => { const text = JSON.stringify(value); if (client.bufferedAmount > 1024 * 1024 || Buffer.byteLength(text) > 4 * 1024 * 1024) return client.terminate(); if (client.readyState === WebSocket.OPEN) client.send(text); };
    const tick = async () => {
      if (loading || client.readyState !== WebSocket.OPEN) return;
      if (!ctx.engine.ready) return client.terminate();
      loading = true;
      try {
        if (route === '/logs') {
          const logs = (ctx.engine.logs || []).slice(-500); let start = Math.min(logTail.length, logs.length);
          while (start && !logTail.slice(-start).every((line, index) => line === logs[index])) start--;
          for (const line of logs.slice(start).slice(-100)) { let safe = String(line); for (const secret of [current.secret, ctx.engine.secret, ctx.engine.controller ? `127.0.0.1:${ctx.engine.controller}` : '']) if (secret) safe = safe.split(secret).join('[REDACTED]'); const match = safe.match(/^\[([^\]]+)\]\s*(.*)$/s); send({ type: match ? match[1].slice(0, 24) : 'info', payload: (match ? match[2] : safe).slice(0, 1200) }); }
          logTail = logs;
        } else if (route === '/memory') { const memory = await ctx.memory?.(); send({ inuse: typeof memory?.core === 'number' ? memory.core : null, oslimit: null }); }
        else {
          const stats = await sampleStats();
          if (route === '/connections') send({ uploadTotal: stats.upload, downloadTotal: stats.download, connections: (stats.connections || []).map(connection => ({ id: connection.id, metadata: connection.metadata || { host: connection.host, process: connection.process }, start: connection.start, chains: connection.chains, upload: connection.upload, download: connection.download, rule: connection.rule, rulePayload: connection.rulePayload })) });
          else { const now = Date.now(), elapsed = previous ? (now - previous.at) / 1000 : 1; send({ up: previous ? Math.max(0, (stats.upload - previous.upload) / elapsed) : 0, down: previous ? Math.max(0, (stats.download - previous.download) / elapsed) : 0 }); previous = { at: now, upload: stats.upload, download: stats.download }; }
        }
      } catch { client.terminate(); } finally { loading = false; }
    };
    const timer = setInterval(tick, 1000); timer.unref(); client.on('close', () => clearInterval(timer)); client.on('error', () => {}); client.on('message', () => client.terminate()); tick();
  });
  function upgrade(req, socket, head) {
    const deny = status => { socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`); };
    if (req.headers.host !== `127.0.0.1:${current.port}` || req.url.length > 8192 || !allowedOrigin(req.headers.origin) || !ctx.engine.ready || streams.clients.size >= 32) return deny(403);
    let url; try { url = new URL(req.url, `http://127.0.0.1:${current.port}`); } catch { return deny(403); }
    if (!['/traffic', '/memory', '/connections', '/logs'].includes(url.pathname) || !authenticated(req.headers.authorization || (url.searchParams.has('token') ? `Bearer ${url.searchParams.get('token')}` : ''))) return deny(401);
    streams.handleUpgrade(req, socket, head, client => streams.emit('connection', client, req, url.pathname));
  }
  try { imported = fs.lstatSync(path.join(webRoot, 'index.html')).isFile() && !fs.lstatSync(webRoot).isSymbolicLink(); } catch {}
  function snapshot() { return { controllerStatus: { listening: Boolean(server?.listening), error, webUiImported: imported } }; }
  function publish() { ctx.publish?.(); }
  async function staticFile(req, res, pathname) {
    if (!imported || !['GET', 'HEAD'].includes(req.method)) return false;
    let relative; try { relative = decodeURIComponent(pathname.slice('/ui/'.length)); } catch { return false; }
    if (!relative) relative = 'index.html';
    if (/[\\\x00-\x1f]/.test(relative) || relative.split('/').some(part => part === '..' || part === '.')) return false;
    const target = path.resolve(webRoot, relative);
    if (!target.startsWith(webRoot + path.sep)) return false;
    try {
      if ((await fsp.lstat(webRoot)).isSymbolicLink()) return false;
      let walk = webRoot;
      for (const part of relative.split('/').filter(Boolean)) { walk = path.join(walk, part); if ((await fsp.lstat(walk)).isSymbolicLink()) return false; }
      const stat = await fsp.stat(target); if (!stat.isFile() || stat.size > 80 * 1024 * 1024) return false;
      res.writeHead(200, { 'Content-Type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${current.port}; object-src 'none'; frame-ancestors 'none'; base-uri 'self'` });
      if (req.method === 'HEAD') res.end(); else { const stream = fs.createReadStream(target); stream.on('error', () => res.destroy()); stream.pipe(res); } return true;
    } catch { return false; }
  }
  async function request(req, res) {
    const send = (status, data) => { if (res.headersSent) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    if (req.headers.host !== `127.0.0.1:${current.port}` || req.url.length > 8192) return send(403, { message: '访问不允许' });
    if (req.url.startsWith('/ui/')) { if (await staticFile(req, res, req.url.split('?')[0])) return; return send(404, { message: '文件不存在' }); }
    const origin = req.headers.origin;
    if (!allowedOrigin(origin)) return send(403, { message: '来源不允许' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      if (!origin || !['GET', 'PUT', 'PATCH', 'POST', 'DELETE'].includes(req.headers['access-control-request-method']) || String(req.headers['access-control-request-headers'] || '').split(',').some(header => header.trim() && !['authorization', 'content-type'].includes(header.trim().toLowerCase()))) return send(403, { message: '访问不允许' });
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, DELETE'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.writeHead(204); return res.end();
    }
    if (!authenticated(req.headers.authorization)) return send(401, { message: '需要控制器令牌' });
    if (new URL(req.url, `http://127.0.0.1:${current.port}`).searchParams.has('token')) return send(403, { message: 'REST 请使用授权标头' });
    let data, mutation;
    try { data = await body(req); mutation = apiPolicy(req.url, req.method, data); } catch { return send(403, { message: '接口操作不允许' }); }
    if (!ctx.engine.ready) return send(503, { message: '请先连接内核' });
    try {
      if (mutation) { await ctx.mutate(mutation); return send(204, null); }
      const result = await ctx.engine.api(req.url, req.method, data);
      send(result === null || result === undefined ? 204 : 200, req.url.split('?')[0] === '/configs' ? publicConfigs(result) : result);
    } catch { send(502, { message: '内核操作未完成' }); }
  }
  async function close(value) { if (!value) return; await new Promise(resolve => { value.close(resolve); value.closeAllConnections?.(); }); }
  async function apply(settings) {
    if (disposed) throw Error('控制器已关闭');
    const next = options(settings);
    if (!next.enabled) { stopStreams(); const old = server; server = null; current = next; await close(old); error = ''; publish(); return; }
    if (server?.listening && next.port === current.port) { if (JSON.stringify(current) !== JSON.stringify(next)) stopStreams(); current = next; error = ''; publish(); return; }
    const candidate = http.createServer((req, res) => { request(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    candidate.requestTimeout = 10000; candidate.headersTimeout = 10000; candidate.keepAliveTimeout = 1000; candidate.maxConnections = 32;
    candidate.on('upgrade', upgrade);
    try { await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(next.port, '127.0.0.1', () => { candidate.removeListener('error', reject); resolve(); }); }); }
    catch { error = '控制器端口不可用'; publish(); throw Error(error); }
    candidate.on('error', () => { error = '控制器监听失败'; publish(); });
    stopStreams(); const old = server; server = candidate; current = next; error = ''; await close(old); publish();
  }
  const enqueue = fn => { const next = task.then(fn); task = next.catch(() => {}); return next; };
  ctx.handle('controller:webui:import', () => enqueue(async () => {
    const result = await ctx.dialog.showOpenDialog(ctx.getWindow(), { title: '导入 WebUI', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const staged = path.join(ctx.store.dir, 'webui-' + crypto.randomBytes(8).toString('hex'));
    const previous = webRoot + '-previous';
    try { await copyWebUi(result.filePaths[0], staged); await fsp.rm(previous, { recursive: true, force: true }); if (fs.existsSync(webRoot)) await fsp.rename(webRoot, previous); try { await fsp.rename(staged, webRoot); } catch (failure) { if (fs.existsSync(previous)) await fsp.rename(previous, webRoot); throw failure; } imported = true; await fsp.rm(previous, { recursive: true, force: true }); publish(); return snapshot().controllerStatus; }
    catch { throw Error('WebUI 导入失败：需要 index.html、普通文件，最多 2000 个文件 / 80 MB'); }
    finally { await fsp.rm(staged, { recursive: true, force: true }); }
  }));
  ctx.handle('controller:webui:reset', () => enqueue(async () => { await fsp.rm(webRoot, { recursive: true, force: true }); imported = false; publish(); }));
  ctx.handle('controller:webui:open', () => { if (!server?.listening || !imported) throw Error('请先启用控制器并导入 WebUI'); return ctx.shell.openExternal(`http://127.0.0.1:${current.port}/ui/`); });
  return { snapshot, applySettings: settings => enqueue(() => apply(settings)), dispose: () => enqueue(async () => { disposed = true; stopStreams(); streams.close(); const old = server; server = null; await close(old); }) };
}
module.exports = { registerController, apiPolicy, configMutation, publicConfigs, copyWebUi };
