const { ps } = require('./windows-proxy.cjs');
const path = require('node:path');
const fs = require('node:fs');
// Start outside the Electron process job so recovery survives forced termination.
async function startWatchdog(pid, dir, binary) {
  const journal = Buffer.from(path.join(dir, 'proxy-recovery.json'), 'utf8').toString('base64');
  const exe = Buffer.from(binary, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference='Stop'
$file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${journal}'))
$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${exe}'))
$log=$file+'.watchdog.log'
Add-Content -LiteralPath $log -Value ('watching ${Number(pid)} at '+(Get-Date))
while($true) {
 try { if(-not (Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}')) { break } } catch { }
 Start-Sleep -Milliseconds 800
}
Add-Content -LiteralPath $log -Value 'parent exited'
try {
 if(Test-Path -LiteralPath $file) {
  $j=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  Add-Content -LiteralPath $log -Value ('journal owner '+$j.ownerPid)
  if($j.ownerPid -eq ${Number(pid)}) {
   $key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
   $current=Get-ItemProperty $key
   if($current.ProxyServer -eq $j.ours.ProxyServer -and $current.ProxyEnable -eq $j.ours.ProxyEnable) {
    foreach($p in $j.previous.PSObject.Properties) {
     if($null -eq $p.Value) { Remove-ItemProperty -Path $key -Name $p.Name -ErrorAction SilentlyContinue }
     else { $t='String'; if($p.Name -eq 'ProxyEnable'){$t='DWord'}; New-ItemProperty -Path $key -Name $p.Name -Value $p.Value -PropertyType $t -Force | Out-Null }
    }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LumaRecoveryInet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l); }'
    [LumaRecoveryInet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null
    [LumaRecoveryInet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null
   }
   if((Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).ownerPid -eq ${Number(pid)}) { Remove-Item -LiteralPath $file -Force }
  }
 }
} catch { Add-Content -LiteralPath $log -Value ($_ | Out-String) }
try { Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(pid)}' | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch { }
`;
  const scriptFile = path.join(dir, `recovery-watchdog-${pid}.ps1`);
  fs.writeFileSync(scriptFile, '\ufeff' + script, 'utf8');
  const file64 = Buffer.from(scriptFile, 'utf8').toString('base64');
  const watcherPid = await ps(`
$f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${file64}'))
$p=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$line='"'+$p+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$f+'"'
$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[UInt16]0}
$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line;ProcessStartupInformation=$startup}
if($r.ReturnValue -ne 0) { throw 'Recovery process could not start' }
$r.ProcessId
`);
  fs.writeFileSync(path.join(dir, 'watchdog-launch.json'), JSON.stringify({ pid: Number(watcherPid), owner: pid }));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (fs.readFileSync(path.join(dir, 'proxy-recovery.json.watchdog.log'), 'utf8').includes(`watching ${pid} at`)) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Windows recovery process did not become ready');
}
module.exports = { startWatchdog };
