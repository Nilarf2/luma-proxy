const { spawn } = require('node:child_process');
const path = require('node:path');
// A native Windows process survives termination of the Electron process tree.
function startWatchdog(pid, dir, binary) {
  const journal = Buffer.from(path.join(dir, 'proxy-recovery.json'), 'utf8').toString('base64');
  const exe = Buffer.from(binary, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference='Stop'
$file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${journal}'))
$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${exe}'))
$log=$file+'.watchdog.log'
Add-Content -LiteralPath $log -Value ('watching ${Number(pid)} at '+(Get-Date))
Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue
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
  const watcher = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true });
  watcher.on('error', () => {}); watcher.unref();
}
module.exports = { startWatchdog };
