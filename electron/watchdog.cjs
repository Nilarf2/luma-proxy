const { ps } = require('./windows-proxy.cjs');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const b64 = value => Buffer.from(value, 'utf8').toString('base64');
const decoded = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(value)}'))`;

// Explicit breakaway avoids inheriting a launcher's kill-on-close Windows job.
// Unlike Win32_Process.Create, this path needs neither CIM nor the WMI service.
const nativeLauncher = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LumaDetachedProcess {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
  public int cb; public string reserved; public string desktop; public string title;
  public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedSize;
  public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int id,threadId; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool CreateProcessW(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int Start(string app, string command) {
  var startup = new STARTUPINFO(); startup.cb=Marshal.SizeOf(startup);
  PROCESS_INFORMATION info;
  if(!CreateProcessW(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x09000000,IntPtr.Zero,null,ref startup,out info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  CloseHandle(info.thread); CloseHandle(info.process); return info.id;
 }
}
'@
[LumaDetachedProcess]::Start($p,$line)
`;

async function startWatchdog(pid, dir, binary, isCancelled = () => false) {
  if (isCancelled()) throw Error('恢复进程启动已取消');
  if (process.env.LUMA_TEST_WATCHDOG === 'unavailable') throw Error('异常退出保护暂不可用');
  const token = crypto.randomBytes(12).toString('hex');
  const readyFile = path.join(dir, `recovery-ready-${pid}-${token}.json`);
  const scriptFile = path.join(dir, `recovery-watchdog-${pid}-${token}.ps1`);
  const script = `
$ErrorActionPreference='Stop'
$file=${decoded(path.join(dir, 'proxy-recovery.json'))}
$exe=${decoded(binary)}
$coreFile=${decoded(path.join(dir, 'core-recovery.json'))}
$ready=${decoded(readyFile)}
$log=$file+'.watchdog.log'
$owner=Get-Process -Id ${Number(pid)} -ErrorAction Stop
$started=$owner.StartTime.ToFileTimeUtc()
[IO.File]::WriteAllText($ready,'${token}')
try {
 while($true) {
  try {
   $owner=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue
   if($null -eq $owner -or $owner.StartTime.ToFileTimeUtc() -ne $started) { break }
  } catch { }
  Start-Sleep -Milliseconds 500
 }
 try { if(Test-Path -LiteralPath $file) {
  $j=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if($j.ownerPid -eq ${Number(pid)}) {
   $key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
   $current=Get-ItemProperty $key
   $matches=$true
   foreach($field in $j.ours.PSObject.Properties) { if($current.($field.Name) -ne $field.Value) { $matches=$false; break } }
   if($matches) {
    foreach($p in $j.previous.PSObject.Properties) {
     if($null -eq $p.Value) { Remove-ItemProperty -Path $key -Name $p.Name -ErrorAction SilentlyContinue }
     else { $t='String'; if($p.Name -eq 'ProxyEnable'){$t='DWord'}; New-ItemProperty -Path $key -Name $p.Name -Value $p.Value -PropertyType $t -Force | Out-Null }
    }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LumaRecoveryInet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l); }'
    [LumaRecoveryInet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null
    [LumaRecoveryInet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null
   }
   if((Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).ownerPid -eq ${Number(pid)}) { Remove-Item -LiteralPath $file -Force }
   if($j.corePid) {
    $core=Get-Process -Id $j.corePid -ErrorAction SilentlyContinue
    if($core -and $core.Path -eq $exe -and $core.StartTime.ToFileTimeUtc().ToString() -eq $j.coreStarted) { Stop-Process -Id $j.corePid -Force -ErrorAction SilentlyContinue }
   }
  }
 }
 } catch { Add-Content -LiteralPath $log -Value ('Proxy recovery: '+($_ | Out-String)) }
 if(Test-Path -LiteralPath $coreFile) {
  $k=Get-Content -LiteralPath $coreFile -Raw | ConvertFrom-Json
  if($k.ownerPid -eq ${Number(pid)}) {
   $core=Get-Process -Id $k.corePid -ErrorAction SilentlyContinue
   if($core -and $core.Path -eq $(if($k.binary){$k.binary}else{$exe}) -and $core.StartTime.ToFileTimeUtc().ToString() -eq $k.coreStarted) { Stop-Process -Id $k.corePid -Force -ErrorAction SilentlyContinue }
   Remove-Item -LiteralPath $coreFile -Force -ErrorAction SilentlyContinue
  }
 }
} catch { Add-Content -LiteralPath $log -Value ($_ | Out-String) }
finally { Remove-Item -LiteralPath $ready -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }
`;
  fs.writeFileSync(scriptFile, '\ufeff' + script, 'utf8');
  const common = `
$ErrorActionPreference='Stop'
$f=${decoded(scriptFile)}
$p=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$line='"'+$p+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$f+'"'
`;
  const cimLauncher = `
$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[UInt16]0}
$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line;ProcessStartupInformation=$startup}
if($r.ReturnValue -ne 0) { throw ('Windows recovery launch failed: '+$r.ReturnValue) }
$r.ProcessId
`;
  const failures = [];
  const methods = process.env.LUMA_TEST_WATCHDOG === 'native' ? [['native', nativeLauncher]] : [['cim', cimLauncher], ['native', nativeLauncher]];
  for (const [method, launcher] of methods) {
    let watcherPid;
    try {
      if (isCancelled()) throw Error('恢复进程启动已取消');
      fs.rmSync(readyFile, { force: true });
      watcherPid = Number(await ps(common + launcher, 12000));
      if (!Number.isInteger(watcherPid) || watcherPid <= 0) throw Error('未能取得恢复进程编号');
      for (let attempt = 0; attempt < 100; attempt++) {
        if (isCancelled()) throw Error('恢复进程启动已取消');
        let ready = false;
        try { ready = fs.readFileSync(readyFile, 'utf8') === token; } catch {}
        if (ready) {
          const started = await ps(`(Get-Process -Id ${watcherPid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`, 5000);
          if (!/^\d+$/.test(started)) throw Error('未能验证恢复进程');
          if (isCancelled()) throw Error('恢复进程启动已取消');
          fs.writeFileSync(path.join(dir, 'watchdog-launch.json'), JSON.stringify({ pid: watcherPid, owner: pid, method, started }));
          return { pid: watcherPid, method, started, readyFile, token };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('Windows 恢复进程未能就绪');
    } catch (error) {
      failures.push(`${method}: ${error.message}`);
      if (watcherPid) await ps(`Stop-Process -Id ${watcherPid} -Force -ErrorAction SilentlyContinue`, 5000).catch(() => {});
      fs.rmSync(readyFile, { force: true });
      if (isCancelled()) break;
    }
  }
  fs.rmSync(scriptFile, { force: true }); fs.rmSync(readyFile, { force: true });
  throw Error(failures.join('\n'));
}
async function checkWatchdog(handle) {
  if (!handle || !Number.isInteger(handle.pid) || handle.pid <= 0 || !/^\d+$/.test(handle.started)) return false;
  try { if (fs.readFileSync(handle.readyFile, 'utf8') !== handle.token) return false; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  // SilentlyContinue still leaves powershell.exe with exit code 1 for a missing
  // PID. Treat only that expected lookup failure as absence; access failures,
  // blocked PowerShell and timeouts must continue to prevent proxy activation.
  const started = await ps(`$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${handle.pid} -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { exit 0 }; throw }; $p.StartTime.ToFileTimeUtc().ToString()`, 5000);
  return started === handle.started;
}
module.exports = { startWatchdog, checkWatchdog };
