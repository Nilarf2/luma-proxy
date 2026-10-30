const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { registerController, apiPolicy } = require('../electron/controller.cjs');
const token = 'independent-controller-token-123456';
async function freePort() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-controller-')), handlers = {}, calls = [], mutations = [], opened = [];
  const port = await freePort(); let selection;
  const engine = { ready: true, api: async (...args) => { calls.push(args); return args[0].split('?')[0] === '/configs' ? { mode: 'rule', secret: 'privileged-secret', 'external-controller': 'private', 'external-controller-pipe': 'private', 'external-ui': 'private', tun: { enable: false } } : { version: 'fixture' }; } };
  const controller = registerController({ store: { dir }, handle: (name, fn) => handlers[name] = fn, dialog: { showOpenDialog: async () => ({ canceled: !selection, filePaths: selection ? [selection] : [] }) }, getWindow: () => null, engine, mutate: async patch => mutations.push(patch), memory: async () => ({core: 123456, main: 3000, total: 4000}), publish() {}, shell: { openExternal: async url => opened.push(url) } });
  t.after(async () => { await controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const settings = { controller: { enabled: true, port, secret: token, origins: ['https://allowed.example', `http://127.0.0.1:${port}`] } };
  const request = (route = '/version', config = {}) => new Promise((resolve, reject) => { const body = config.body === undefined ? undefined : JSON.stringify(config.body); const req = http.request({ host: '127.0.0.1', port, path: route, method: config.method || 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...config.headers } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text })); }); req.on('error', reject); req.end(body); });
  return { controller, settings, request, calls, mutations, engine, handlers, dir, opened, select: value => selection = value };
}
test('controller remains off by default and constrains bearer, Host and exact CORS origins', async t => {
  const f = await fixture(t); assert.equal(f.controller.snapshot().controllerStatus.listening, false);
  await f.controller.applySettings(f.settings);
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request('/version?token='+token, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.request('/version', { headers: { Origin: `http://127.0.0.1:${f.settings.controller.port}` } })).status,200);
  assert.equal((await f.request('/version', { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.request('/version', { headers: { Host: `evil.example:${f.settings.controller.port}` } })).status, 403);
  assert.equal((await f.request('/version', { headers: { Origin: 'https://allowed.example.evil' } })).status, 403);
  const allowed = await f.request('/version', { headers: { Origin: 'https://allowed.example' } }); assert.equal(allowed.headers['access-control-allow-origin'], 'https://allowed.example');
  const preflight = await f.request('/configs', { method: 'OPTIONS', headers: { Authorization: '', Origin: 'https://allowed.example', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' } }); assert.equal(preflight.status, 204);
  assert.equal((await f.request('/configs', { method: 'OPTIONS', headers: { Origin: 'https://allowed.example', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'x-private' } })).status, 403);
  await assert.rejects(f.controller.applySettings({ controller: { ...f.settings.controller, secret: 'short' } }), /无效/);
  await assert.rejects(f.controller.applySettings({ controller: { ...f.settings.controller, origins: ['*'] } }), /来源/);
  await assert.rejects(f.controller.applySettings({ controller: { ...f.settings.controller, origins: ['https://allowed.example/path'] } }), /来源/);
  assert.equal((await f.request()).status, 200);
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(token), false);
});
test('controller only forwards permitted REST and routes narrow config changes through transaction', async t => {
  const f = await fixture(t); await f.controller.applySettings(f.settings);
  const configs = await f.request('/configs'); assert.deepEqual(JSON.parse(configs.text), { mode: 'rule', tun: { enable: false } }); assert.equal(configs.text.includes('privileged'), false);
  for (const [route, method, body] of [['/upgrade','POST'],['/configs','PUT',{path:'C:/private'}],['/configs','PATCH',{secret:'x'}],['/configs','PATCH',{tun:{enable:true,stack:'system'}}],['/proxies/%2e%2e/version','GET'],['/proxies/a%2fb','GET'],['//evil.example','GET'],['/configs?reload=1','PATCH',{mode:'global'}]]) assert.equal((await f.request(route,{method,body})).status,403,route);
  const before = f.calls.length;
  assert.equal((await f.request('/configs',{method:'PATCH',body:{mode:'global','log-level':'debug',tun:{enable:true}}})).status,204);
  assert.deepEqual(f.mutations,[{mode:'global',core:{logLevel:'debug',tun:{enabled:true}}}]);assert.equal(f.calls.length,before);
  assert.equal((await f.request('/proxies/Group',{method:'PUT',body:{name:'Node'}})).status,200);
  assert.deepEqual(f.calls.at(-1),['/proxies/Group','PUT',{name:'Node'}]);
  assert.equal((await f.request('/proxies/Hong%20Kong',{method:'PUT',body:{name:'US 01'}})).status,200);
  assert.equal((await f.request('/providers/proxies/Test',{method:'PUT',body:{url:'http://evil'}})).status,403);
  const health='/providers/proxies/Alpha%20provider/Same%20node/healthcheck?url=http%3A%2F%2F127.0.0.1%2F204&timeout=1000';
  assert.equal((await f.request(health)).status,200);assert.deepEqual(f.calls.at(-1),[health,'GET',undefined]);
  for(const route of ['/providers/proxies/A%2FB/Node/healthcheck','/providers/proxies/A/N%255c/healthcheck']) assert.equal((await f.request(route)).status,403);
  assert.equal((await f.request(health,{method:'POST'})).status,403);
  f.engine.ready=false;assert.equal((await f.request()).status,503);
});
test('controller bind failure preserves old listener and token rotation revokes previous token', async t => {
  const f = await fixture(t);await f.controller.applySettings(f.settings);
  const blocker = net.createServer();await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>blocker.close(resolve)));
  await assert.rejects(f.controller.applySettings({controller:{...f.settings.controller,port:blocker.address().port}}),/端口/);assert.equal((await f.request()).status,200);
  await f.controller.applySettings({controller:{...f.settings.controller,secret:token+'-rotated'}});assert.equal((await f.request()).status,401);
  assert.equal((await f.request('/version',{headers:{Authorization:`Bearer ${token}-rotated`}})).status,200);
  await f.controller.applySettings({controller:{...f.settings.controller,enabled:false}});assert.equal(f.controller.snapshot().controllerStatus.listening,false);
});
test('local WebUI import serves controlled copy, rejects symlinks/traversal and keeps previous import', async t => {
  const f=await fixture(t);await f.controller.applySettings(f.settings);
  const source=path.join(f.dir,'selected');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'index.html'),'<h1>Local UI</h1>');fs.writeFileSync(path.join(source,'app.js'),'window.local=true');
  f.select(source);await f.handlers['controller:webui:import']();
  fs.writeFileSync(path.join(source,'index.html'),'Changed source');
  const index=await f.request('/ui/',{headers:{Authorization:''}});assert.equal(index.status,200);assert.equal(index.text,'<h1>Local UI</h1>');assert.match(index.headers['content-security-policy'],/connect-src 'self'/);
  assert.equal((await f.request('/ui/%2e%2e/settings.json')).status,404);
  await f.handlers['controller:webui:open']();assert.deepEqual(f.opened,[`http://127.0.0.1:${f.settings.controller.port}/ui/`]);assert.equal(f.opened[0].includes(token),false);
  const bad=path.join(f.dir,'bad');fs.mkdirSync(bad);fs.writeFileSync(path.join(bad,'index.html'),'bad');
  try { fs.symlinkSync(path.join(source,'app.js'),path.join(bad,'linked.js')); } catch(error) { if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)) { fs.mkdirSync(path.join(bad,'nested'));fs.writeFileSync(path.join(bad,'nested','excess'),Buffer.alloc(81*1024*1024)); } else throw error; }
  f.select(bad);await assert.rejects(f.handlers['controller:webui:import'](),/导入失败/);assert.equal((await f.request('/ui/')).text,'<h1>Local UI</h1>');
  await f.handlers['controller:webui:reset']();assert.equal((await f.request('/ui/')).status,404);await assert.rejects(async()=>f.handlers['controller:webui:open'](),/请先/);
});
test('REST policy does not admit raw config/file operations',()=>{assert.throws(()=>apiPolicy('/configs','PATCH',{}));assert.throws(()=>apiPolicy('/configs','PATCH',{tun:{enable:'true'}}));assert.throws(()=>apiPolicy('/restart','POST'));assert.throws(()=>apiPolicy('/proxies/%252e%252e','GET'));});

async function stream(f, route, options = {}) {
  const client = new WebSocket(`ws://127.0.0.1:${f.settings.controller.port}${route}`, options), messages = [];
  client.on('message', value => messages.push(JSON.parse(value.toString())));client.on('error',()=>{});
  await once(client,'open');return {client,messages};
}
async function until(check) { for(let attempt=0;attempt<100;attempt++){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail('Stream condition not reached'); }
test('WebSocket streams require exact Host/origin plus independent header or query token',async t=>{
  const f=await fixture(t);f.engine.stats=async()=>({upload:1,download:2,connections:[]});await f.controller.applySettings(f.settings);
  for(const [route,options] of [['/connections',{}],[`/connections?token=${token}`,{origin:'https://evil.example'}],[`/connections?token=${token}`,{headers:{Host:'evil.example'}}],[`/configs?token=${token}`,{}]]) await assert.rejects(stream(f,route,options),/Unexpected server response/);
  const query=await stream(f,`/connections?token=${token}`,{origin:`http://127.0.0.1:${f.settings.controller.port}`});await until(()=>query.messages.length);assert.equal(query.messages[0].downloadTotal,2);
  const header=await stream(f,'/memory',{headers:{Authorization:`Bearer ${token}`},origin:'https://allowed.example'});await until(()=>header.messages.length);assert.deepEqual(header.messages[0],{inuse:123456,oslimit:null});
  const queryClosed=once(query.client,'close'),headerClosed=once(header.client,'close');
  await f.controller.applySettings({controller:{...f.settings.controller,secret:token+'-new'}});await Promise.all([queryClosed,headerClosed]);
});
test('WebSocket real counters/log additions stay bounded and stop sampling after disconnect/core exit',async t=>{
  const f=await fixture(t);let samples=0;
  f.engine.logs=['[info] initial'];f.engine.secret='private-core-token';
  f.engine.stats=async()=>{samples++;return {upload:samples*100,download:samples*200,connections:[{id:'actual-id',host:'example.com',metadata:{host:'example.com',network:'tcp'},upload:11,download:22,rule:'MATCH',chains:['DIRECT']}]};};
  await f.controller.applySettings(f.settings);
  const auth={headers:{Authorization:`Bearer ${token}`}}, traffic=await stream(f,'/traffic',auth),connections=await stream(f,'/connections',auth),logs=await stream(f,'/logs',auth);
  await until(()=>connections.messages.length&&logs.messages.length);assert.equal(connections.messages[0].connections[0].id,'actual-id');assert.equal(connections.messages[0].uploadTotal,100);
  f.engine.logs.push('[warning] added '+f.engine.secret+' '+token);
  await until(()=>traffic.messages.length>=2&&logs.messages.length>=2);
  assert.ok(traffic.messages[1].up>0);assert.ok(traffic.messages[1].down>traffic.messages[1].up);assert.ok(samples<=3);
  assert.deepEqual(logs.messages[1],{type:'warning',payload:'added [REDACTED] [REDACTED]'});
  const trafficClosed=once(traffic.client,'close'),connectionClosed=once(connections.client,'close'),logsClosed=once(logs.client,'close');
  traffic.client.close();connections.client.close();logs.client.close();await Promise.all([trafficClosed,connectionClosed,logsClosed]);
  const before=samples;await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(samples,before,'No client leaves sampling interval running');
  const stopped=await stream(f,'/connections',auth),closed=once(stopped.client,'close');f.engine.ready=false;await closed;
});
