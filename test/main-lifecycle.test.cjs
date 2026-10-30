const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {Store}=require('../electron/store.cjs');
function load(extra=''){
  const handlers={},app={requestSingleInstanceLock:()=>true,on:(name,fn)=>handlers[name]=fn,whenReady:()=>({then:()=>({catch:()=>{}})}),quit:()=>{app.quits=(app.quits||0)+1;}};
  const context={module:{exports:{}},__dirname:path.resolve('electron'),process,require:name=>name==='electron'?{app,dialog:{showErrorBox:()=>{}}}:name.startsWith('./')?require(path.resolve('electron',name)):require(name)};
  vm.runInNewContext(fs.readFileSync('electron/main.cjs','utf8')+'\n'+extra,context);
  return {app,handlers,exports:context.module.exports};
}
test('quit still restores proxy and stops engine when controller disposal throws',async()=>{
  let restored=0,stopped=0;
  const f=load('module.exports.init=(p,e)=>{proxy=p;engine=e;controller={dispose:()=>{throw Error("controller close")}};};');
  f.exports.init({restore:async()=>restored++},{stop:async()=>stopped++});f.handlers['before-quit']({preventDefault(){}});
  for(let i=0;i<10&&!f.app.quits;i++)await new Promise(r=>setImmediate(r));
  assert.equal(restored,1);assert.equal(stopped,1);assert.equal(f.app.quits,1);
});
test('failed controller mutation restores mode in disk, memory and running core',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-main-mode-')),store=new Store(dir);store.save();let mode='rule';
  const f=load('module.exports={controllerMutation,init:(s,e)=>{store=s;engine=e;admin=true;quitting=true;controller={applySettings:async value=>{if(value.mode==="global")throw Error("Injected controller failure");}};}};');
  f.exports.init(store,{ready:true,api:async(_ep,_method,data)=>{mode=data.mode;}});
  try{await assert.rejects(f.exports.controllerMutation({mode:'global'}),/Injected/);assert.equal(store.data.mode,'rule');assert.equal(new Store(dir).data.mode,'rule');assert.equal(mode,'rule');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
