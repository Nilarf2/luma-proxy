const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DelayTasks, delayStatus, normalizeDelayResult } = require('../electron/delay.cjs');
const { Engine } = require('../electron/engine.cjs');
const { defaults } = require('../electron/settings.cjs');
const { groupsWithSources } = require('../electron/nodes.cjs');

test('provider sources retain duplicate identity and do not label unrelated local nodes', () => {
  const proxies = {Group:{name:'Group',type:'Selector',now:'Same',all:['Same','DIRECT']},Local:{name:'Local',type:'Selector',all:['Same']},Same:{name:'Same',type:'Http'},DIRECT:{name:'DIRECT',type:'Direct'}};
  const providers = {A:{vehicleType:'HTTP',proxies:[{name:'Same',type:'Http',history:[{delay:11}]}]},B:{vehicleType:'File',proxies:[{name:'Same',type:'Socks5',history:[{delay:22}]}]},Group:{vehicleType:'Compatible',proxies:[{name:'Same'}]}};
  const groups = groupsWithSources(proxies,providers,[{name:'Group',use:['A','B'],proxies:['DIRECT']},{name:'Local',proxies:['Same']}]);
  const nodes = groups[0].nodes.filter(n=>n.name==='Same');
  assert.deepEqual(nodes.map(n=>[n.provider,n.delay]),[['A',11],['B',22]]);assert.notEqual(nodes[0].id,nodes[1].id);assert.deepEqual(nodes[0].providers,['A','B']);
  assert.equal(groups[1].nodes[0].provider,null);assert.deepEqual(groups[1].nodes[0].providers,[]);
  const included=groupsWithSources(proxies,providers,[{name:'Group','include-all':true},{name:'Local','include-all-proxies':true}],['Same']);
  assert.deepEqual(included[0].nodes.filter(n=>n.name==='Same').map(n=>n.provider),[null,'A','B']);
  assert.deepEqual(included[1].nodes.filter(n=>n.name==='Same').map(n=>n.provider),[null]);
});
test('delay results are normalized for renderer status and colour mapping', () => {
  assert.deepEqual(normalizeDelayResult({ delay: 131.4, extra: 'kept' }), { delay: 131, latency: 131, status: 'good', extra: 'kept' });
  assert.deepEqual(normalizeDelayResult({ latency: '420' }), { delay: 420, latency: 420, status: 'warning' });
  assert.deepEqual(normalizeDelayResult(801), { delay: 801, latency: 801, status: 'bad' });
  assert.deepEqual(normalizeDelayResult(null), { delay: -1, latency: null, status: 'timeout' });
  assert.equal(delayStatus(0), 'unknown');
  assert.equal(delayStatus(-1), 'timeout');
});
test('delay queue bounds requests, uses provider endpoint and rejects duplicate IDs', async () => {
  let running=0,maximum=0;const calls=[],releases=[];
  const engine={ready:true,api:async endpoint=>{calls.push(endpoint);running++;maximum=Math.max(maximum,running);await new Promise(r=>releases.push(r));running--;return {delay:12};}};
  const tasks=new DelayTasks({engine,settings:defaults,concurrency:2,limit:3});
  const a=tasks.run({name:'Same',provider:'A B',requestId:'a'}),b=tasks.run('Same'),c=tasks.run('Other');
  await assert.rejects(tasks.run({name:'Same',requestId:'a'}),/正在/);await assert.rejects(tasks.run('Full'),/已满/);
  await new Promise(r=>setImmediate(r));assert.equal(calls.length,2);assert.match(calls[0],/^\/providers\/proxies\/A%20B\/Same\/healthcheck\?/);
  releases.shift()();await a;await new Promise(r=>setImmediate(r));assert.equal(calls.length,3);releases.splice(0).forEach(r=>r());await Promise.all([b,c]);assert.equal(maximum,2);
});
test('cancel stops active loopback fetch and queued requests; disconnect prevents new work', async () => {
  let requests=0,arrived;const got=new Promise(r=>arrived=r);
  const server=http.createServer((_req,res)=>{requests++;arrived();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const engine=new Engine('', '');engine.ready=true;engine.controller=server.address().port;engine.secret='local-fixture';
  const tasks=new DelayTasks({engine,settings:defaults,concurrency:1});
  try {
    const first=tasks.run({name:'Local',requestId:'first'}),second=tasks.run({name:'Queued',requestId:'second'});
    const checked=[assert.rejects(first,/取消/),assert.rejects(second,/取消/)];await got;
    assert.deepEqual(tasks.cancel(),{canceled:2});await Promise.all(checked);await new Promise(r=>setTimeout(r,30));assert.equal(requests,1);assert.equal(tasks.active,0);assert.equal(tasks.tasks.size,0);
    engine.ready=false;await assert.rejects(tasks.run('Disconnected'),/请先连接/);
  } finally {tasks.cancel();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('real Mihomo keeps provider duplicate sources and tests its exact provider endpoint locally', {skip:process.platform==='win32'||!fs.existsSync(path.resolve('resources/core/mihomo'))}, async()=>{
  let forwarded=0;
  const fixture=http.createServer((req,res)=>{if(req.url==='/provider'){res.end(`proxies: [{name: Same node, type: http, server: 127.0.0.1, port: ${fixture.address().port}}]`);}else{forwarded++;res.writeHead(204);res.end();}});
  const sockets=new Set();fixture.on('connect',(req,socket)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));assert.equal(req.url,`127.0.0.1:${fixture.address().port}`);socket.write('HTTP/1.1 200 Connection established\r\n\r\n');socket.once('data',data=>{assert.match(data.toString(),/^HEAD \/generate_204 HTTP\/1\.1/);forwarded++;setTimeout(()=>socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'),15);});});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-provider-delay-')),engine=new Engine(dir,path.resolve('resources/core/mihomo'));
  const settings=defaults();settings.latency.url=`http://127.0.0.1:${fixture.address().port}/generate_204`;
  const tasks=new DelayTasks({engine,settings:()=>settings});
  try{
    await engine.start(`proxies: [{name: Same node, type: http, server: 127.0.0.1, port: ${fixture.address().port}}]\nproxy-providers:\n  Alpha provider: {type: http, url: "http://127.0.0.1:${fixture.address().port}/provider", health-check: {enable: false}}\n  Beta provider: {type: http, url: "http://127.0.0.1:${fixture.address().port}/provider", health-check: {enable: false}}\nproxy-groups: [{name: Combined, type: select, include-all: true}]\nrules: ["MATCH,DIRECT"]\n`,'rule');
    let group;for(let i=0;i<100;i++){group=(await engine.stats()).groups.find(g=>g.name==='Combined');if(group.nodes.filter(n=>n.name==='Same node').length===3)break;await new Promise(r=>setTimeout(r,10));}
    assert.deepEqual(group.nodes.filter(n=>n.name==='Same node').map(n=>n.provider),[null,'Alpha provider','Beta provider']);
    const result=await tasks.run({name:'Same node',provider:'Beta provider'});assert.equal(typeof result.delay,'number');assert.ok(result.delay>=0);assert.equal(forwarded,1);
    const providers=await engine.api('/providers/proxies');assert.equal(providers.providers['Alpha provider'].proxies[0].history.length,0);assert.equal(providers.providers['Beta provider'].proxies[0].history.length,1);
  }finally{tasks.cancel();await engine.stop();for(const socket of sockets)socket.destroy();fixture.closeAllConnections();await new Promise(r=>fixture.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
