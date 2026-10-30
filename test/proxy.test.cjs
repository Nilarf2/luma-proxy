const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
function fixture(dir){let registry={ProxyEnable:0,ProxyServer:'previous:80',ProxyOverride:null};let fail=false;const code=fs.readFileSync(path.resolve('electron/windows-proxy.cjs'),'utf8');const ctx={module:{exports:{}},Buffer,process:{platform:'win32',pid:12345},require:n=>n==='node:child_process'?{execFile:(_exe,args,_opts,cb)=>{const script=Buffer.from(args.at(-1),'base64').toString('utf16le');if(script.includes('ConvertTo-Json'))cb(null,{stdout:JSON.stringify(registry)});else{if(fail){fail=false;cb(Error('write failed'));return;}const base=script.match(/FromBase64String\('([^']+)'\)/)?.[1];if(base)registry=JSON.parse(Buffer.from(base,'base64'));cb(null,{stdout:''});}}}:n==='node:util'?{promisify:fn=>(...a)=>new Promise((r,j)=>fn(...a,(e,v)=>e?j(e):r(v)))}:require(n)};vm.runInNewContext(code,ctx);return{proxy:new ctx.module.exports.WindowsProxy(dir),get:()=>registry,set:v=>registry=v,fail:()=>fail=true};}
test('proxy restores previous registry and respects changed ownership',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-proxy-'));try{const f=fixture(dir);await f.proxy.enable(12345);assert.equal(f.get().ProxyServer,'127.0.0.1:12345');assert.equal(f.proxy.enabled,true);await f.proxy.restore();assert.equal(f.get().ProxyServer,'previous:80');assert.equal(f.get().ProxyEnable,0);await f.proxy.enable(12346);f.set({ProxyEnable:1,ProxyServer:'other-app:90'});await f.proxy.restore();assert.equal(f.get().ProxyServer,'other-app:90');assert.equal(fs.existsSync(path.join(dir,'proxy-recovery.json')),false);}finally{fs.rmSync(dir,{force:true,recursive:true});}});
test('recovery journal survives process restart and failed enable',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-proxy-'));try{const f=fixture(dir);await f.proxy.enable(12345);const recovered=fixture(dir);recovered.set(f.get());await recovered.proxy.restore();assert.equal(recovered.get().ProxyServer,'previous:80');const failed=fixture(dir);failed.set({ProxyEnable:0,ProxyServer:'old:80'});failed.fail();await assert.rejects(failed.proxy.enable(12345));assert.equal(failed.get().ProxyServer,'old:80');assert.equal(failed.proxy.enabled,false);
}finally{fs.rmSync(dir,{force:true,recursive:true});}});

test('old watchdog cannot restore a new instance journal',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luma-owner-'));try{const f=fixture(dir);await f.proxy.enable(12346);await f.proxy.restore(9999);assert.equal(f.get().ProxyServer,'127.0.0.1:12346');assert.equal(fs.existsSync(path.join(dir,'proxy-recovery.json')),true);await f.proxy.restore(12345);assert.equal(f.get().ProxyServer,'previous:80');}finally{fs.rmSync(dir,{force:true,recursive:true});}});

test('enable recovers a stale journal before saving the next snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-stale-proxy-'));
  try {
    const old = fixture(dir);
    const original = { ...old.get() };
    await old.proxy.enable(12345);
    const restarted = fixture(dir);
    restarted.set(old.get());
    await restarted.proxy.enable(12346);
    assert.equal(restarted.get().ProxyServer, '127.0.0.1:12346');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'proxy-recovery.json'), 'utf8')).previous, original);
    await restarted.proxy.restore();
    assert.deepEqual(restarted.get(), original);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('enable preserves a stale journal when recovery fails and allows a retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-failed-recovery-'));
  try {
    const old = fixture(dir);
    const original = { ...old.get() };
    await old.proxy.enable(12345);
    const journal = path.join(dir, 'proxy-recovery.json');
    const saved = fs.readFileSync(journal, 'utf8');
    const restarted = fixture(dir);
    restarted.set(old.get());
    restarted.fail();
    await assert.rejects(restarted.proxy.enable(12346), /write failed/);
    assert.equal(fs.readFileSync(journal, 'utf8'), saved);
    assert.equal(restarted.get().ProxyServer, '127.0.0.1:12345');
    assert.equal(restarted.proxy.enabled, false);
    await restarted.proxy.enable(12346);
    await restarted.proxy.restore();
    assert.deepEqual(restarted.get(), original);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('PowerShell errors decode CLIXML without exposing encoded commands', () => {
  const { powershellError } = require('../electron/windows-proxy.cjs');
  const stderr = '#< CLIXML\n<Objs><S S="Error">Access denied_x000D__x000A_&lt;provider&gt;</S><S S="Verbose">hidden</S></Objs>';
  assert.equal(powershellError({ stderr, message: 'Command failed: powershell.exe -EncodedCommand SECRET' }), 'Access denied\r\n<provider>');
  assert.doesNotMatch(powershellError({ message: 'Command failed: powershell.exe -EncodedCommand SECRET' }), /SECRET|EncodedCommand/);
  assert.match(powershellError({ killed: true }), /超时/);
});

test('proxy inspection is read-only and distinguishes ownership without exposing registry values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-proxy-inspect-'));
  try {
    const f = fixture(dir);
    assert.equal((await f.proxy.inspect()).ownership, 'disabled');
    f.set({ ProxyEnable: 1, ProxyServer: 'other-app:90' });
    assert.equal((await f.proxy.inspect()).ownership, 'external');
    assert.equal(f.get().ProxyServer, 'other-app:90');
    assert.equal(f.proxy.enabled, false);
    await f.proxy.enable(12345);
    const file = path.join(dir, 'proxy-recovery.json');
    const saved = fs.readFileSync(file, 'utf8');
    const state = await f.proxy.inspect();
    assert.equal(state.ownership, 'ours');
    assert.equal(state.recoveryPending, true);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.doesNotMatch(JSON.stringify(state), /12345|other-app/);
    const journal = JSON.parse(saved); journal.ownerPid = 9999;
    fs.writeFileSync(file, JSON.stringify(journal));
    assert.equal((await f.proxy.inspect()).ownership, 'stale');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PAC ownership restores exact prior autoconfig and guard respects another app', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-pac-proxy-'));
  try {
    const f = fixture(dir); const original = { ProxyEnable: 0, ProxyServer: null, ProxyOverride: '*.example', AutoConfigURL: 'https://previous.example/proxy.pac' };
    f.set(original); const url = 'http://127.0.0.1:18555/' + 'a'.repeat(32) + '.pac';
    await f.proxy.enable(12345, undefined, '<local>', { pacUrl: url });
    assert.equal(f.get().AutoConfigURL, url); assert.equal(f.get().ProxyEnable, 0); assert.equal((await f.proxy.inspect()).ownership, 'ours');
    f.set({ ...f.get(), AutoConfigURL: null }); assert.equal((await f.proxy.inspect()).ownership, 'disabled');
    await f.proxy.reapply(); assert.equal(f.get().AutoConfigURL, url);
    await f.proxy.restore(); assert.deepEqual(f.get(), original);
    await f.proxy.enable(12345, undefined, '<local>', { pacUrl: url });
    f.set({ ...f.get(), AutoConfigURL: 'https://other.example/a.pac' });
    await f.proxy.reapply(); assert.equal(f.get().AutoConfigURL, 'https://other.example/a.pac');
    await f.proxy.restore(); assert.equal(f.get().AutoConfigURL, 'https://other.example/a.pac');
  } finally { fs.rmSync(dir, { force: true, recursive: true }); }
});
