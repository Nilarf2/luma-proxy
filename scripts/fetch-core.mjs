import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
const platform = process.argv[2] || process.platform;
const version='v1.19.33';
const names={win32:`mihomo-windows-amd64-compatible-${version}.zip`,linux:`mihomo-linux-amd64-compatible-${version}.gz`};
const hashes={win32:'7aaf636a4f2172dcd8ec34ac4f52797b059195e5afd6409508c963e545f8864d',linux:'386508bfb1c72c43b6a0eda73708ecdce82546581b0ebcb16366c53757c622b6'};
if(!names[platform])throw Error('Only Windows x64 and Linux test core supported');
const dir=path.resolve('resources/core');await fs.mkdir(dir,{recursive:true});
const url=`https://github.com/MetaCubeX/mihomo/releases/download/${version}/${names[platform]}`;
const res=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!res.ok)throw Error(`Core download failed ${res.status}`);
const data=Buffer.from(await res.arrayBuffer());if(crypto.createHash('sha256').update(data).digest('hex')!==hashes[platform])throw Error('Core checksum mismatch');
if(platform==='win32'){
 const archive=path.join(dir,'core.zip');await fs.writeFile(archive,data);
 if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${archive.replaceAll("'","''")}' -DestinationPath '${dir.replaceAll("'","''")}' -Force`]);else execFileSync('unzip',['-o',archive,'-d',dir]);
 const exe=(await fs.readdir(dir)).find(n=>n.endsWith('.exe'));if(!exe)throw Error('Missing core executable');if(exe!=='mihomo.exe')await fs.rename(path.join(dir,exe),path.join(dir,'mihomo.exe'));await fs.unlink(archive);
}else{await fs.writeFile(path.join(dir,'mihomo'),gunzipSync(data),{mode:0o755});}
await fs.writeFile(path.join(dir,'provenance.json'),JSON.stringify({version,url,sha256:hashes[platform]},null,2));
console.log(`Verified Mihomo ${version} for ${platform}`);
