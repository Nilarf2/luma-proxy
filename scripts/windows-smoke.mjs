import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
if(process.platform!=='win32')throw Error('Run on Windows');
const registry=()=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{ProxyEnable=$p.ProxyEnable;ProxyServer=$p.ProxyServer;ProxyOverride=$p.ProxyOverride} | ConvertTo-Json -Compress`],{encoding:'utf8'}).trim());
const before=registry();const dir=await fs.mkdtemp(path.join(os.tmpdir(),'luma-acceptance-'));const profile=path.join(dir,'fixture.yaml');
await fs.writeFile(profile,'proxies:\n  - name: Local test\n    type: socks5\n    server: 127.0.0.1\n    port: 1\nproxy-groups:\n  - name: Proxy\n    type: select\n    proxies: [DIRECT, Local test]\nrules:\n  - MATCH,DIRECT\n');
const local=http.createServer((req,res)=>res.end('luma-windows-proxy-ok'));await new Promise(r=>local.listen(0,'127.0.0.1',r));
let app;let failed=false;
try{
 app=await electron.launch({executablePath:path.resolve('release/win-unpacked/Luma.exe'),args:[`--user-data-dir=${path.join(dir,'data')}`],timeout:60000});
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},profile);
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('button',{name:'开启连接'}).click();await page.getByRole('dialog').getByRole('button',{name:'本地文件'}).click();await page.getByRole('button',{name:'选择配置文件'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'开启连接'}).click();await page.getByText('安全连接已开启').waitFor({timeout:60000});
 const state=await page.evaluate(()=>window.luma.invoke('state'));assert.equal(state.systemProxy,true);assert.equal(registry().ProxyServer,`127.0.0.1:${state.port}`);
 const body=await new Promise((resolve,reject)=>http.get({hostname:'127.0.0.1',port:state.port,path:`http://127.0.0.1:${local.address().port}/`,headers:{Host:`127.0.0.1:${local.address().port}`}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve(b));}).on('error',reject));assert.equal(body,'luma-windows-proxy-ok');
 await page.getByRole('button',{name:'断开连接'}).click();await page.getByText('当前未连接',{exact:true}).waitFor();assert.deepEqual(registry(),before);
 await page.getByRole('button',{name:'开启连接'}).click();await page.getByText('安全连接已开启').waitFor();assert.deepEqual(errors,[]);
 await page.evaluate(()=>window.luma.invoke('settings',{closeToTray:false}));const closed=app.waitForEvent('close');await page.getByRole('button',{name:'关闭',exact:true}).click();await closed;app=null;assert.deepEqual(registry(),before);console.log('Graceful exit proxy restoration passed');
 app=await electron.launch({executablePath:path.resolve('release/win-unpacked/Luma.exe'),args:[`--user-data-dir=${path.join(dir,'data')}`],timeout:60000});
 const crashPage=await app.firstWindow();await crashPage.getByRole('button',{name:'开启连接'}).click();await crashPage.getByText('安全连接已开启').waitFor({timeout:60000});
 console.log('Forced termination test connected');const processHandle=app.process();const exited=new Promise(r=>processHandle.once('exit',r));processHandle.kill('SIGKILL');await exited;app=null;
 for(let i=0;i<20;i++){try{assert.deepEqual(registry(),before);break;}catch{if(i===19)throw Error('Watchdog did not restore system proxy');await new Promise(r=>setTimeout(r,1000));}}
 console.log('Windows packaged EXE passed: real import, bundled kernel, system proxy, HTTP forwarding, disconnect restore, exit restore, forced termination recovery, no renderer errors');
}catch(error){failed=true;console.error('WINDOWS_ACCEPTANCE_FAILURE',error);}finally{if(app)await Promise.race([app.close().catch(()=>{}),new Promise(r=>setTimeout(r,5000))]);local.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:2,retryDelay:300}).catch(e=>console.warn('Temporary test data remains locked:',e.code));}

process.exit(failed?1:0);
