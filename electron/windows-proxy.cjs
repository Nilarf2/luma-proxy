const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const exec = promisify(execFile);
function powershellError(error) {
  const stderr = String(error.stderr || '').replace(/^#< CLIXML\s*/, '');
  const fragments = [...stderr.matchAll(/<S\b[^>]*\bS="Error"[^>]*>([\s\S]*?)<\/S>/g)].map(match => match[1]);
  let detail = (fragments.length ? fragments.join('\n') : stderr)
    .replace(/<[^>]+>/g, ' ')
    .replace(/_x([0-9a-f]{4})_/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
  if (!detail) detail = error.killed ? 'Windows 命令响应超时，请稍后重试' : error.code === 'ENOENT' ? '找不到 Windows PowerShell' : String(error.message || 'Windows 命令执行失败');
  // Never expose Node's full command line or the encoded script to the UI.
  if (detail.includes('EncodedCommand') || detail.startsWith('Command failed:')) detail = 'Windows 命令执行失败，请检查 PowerShell 是否可用';
  return detail.slice(0, 1200);
}
async function ps(script, timeout = 30000) {
  if (process.platform !== 'win32') throw Error('系统代理仅支持 Windows');
  try {
    const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout });
    return stdout.trim();
  } catch (error) { throw new Error(powershellError(error), { cause: error }); }
}

const key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const notify = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LumaInet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l); }'; [LumaInet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null; [LumaInet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null;`;
async function read() { return JSON.parse(await ps(`$p=Get-ItemProperty '${key}'; @{ProxyEnable=$p.ProxyEnable;ProxyServer=$p.ProxyServer;ProxyOverride=$p.ProxyOverride} | ConvertTo-Json -Compress`)); }
async function write(values) {
  const encoded = Buffer.from(JSON.stringify(values), 'utf8').toString('base64');
  await ps(`$ErrorActionPreference='Stop'; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; foreach($p in $v.PSObject.Properties) { if($null -eq $p.Value) { Remove-ItemProperty -Path '${key}' -Name $p.Name -ErrorAction SilentlyContinue } else { $t='String'; if($p.Name -eq 'ProxyEnable'){$t='DWord'}; New-ItemProperty -Path '${key}' -Name $p.Name -Value $p.Value -PropertyType $t -Force | Out-Null } }; ${notify}`);
}
class WindowsProxy {
  constructor(dir) { this.file = path.join(dir, 'proxy-recovery.json'); this.enabled = false; }
  async inspect() {
    const current = await read();
    const journal = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
    const matches = !!journal && current.ProxyServer === journal.ours?.ProxyServer && current.ProxyEnable === journal.ours?.ProxyEnable;
    const ownership = matches ? (journal.ownerPid === process.pid ? 'ours' : 'stale') : current.ProxyEnable === 1 ? 'external' : 'disabled';
    return { ownership, recoveryPending: !!journal };
  }
  async enable(port, corePid) {
    if (this.enabled) return;
    // Preserve the original snapshot until recovery has completed successfully.
    if (fs.existsSync(this.file)) await this.restore();
    const previous = await read(); const ours = { ProxyEnable: 1, ProxyServer: `127.0.0.1:${port}`, ProxyOverride: '<local>;localhost;127.*;[::1]' };
    let coreStarted;
    if (Number.isInteger(corePid) && corePid > 0) coreStarted = await ps(`(Get-Process -Id ${corePid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`);
    fs.writeFileSync(this.file, JSON.stringify({ previous, ours, ownerPid: process.pid, corePid, coreStarted }), { mode: 0o600 });
    try { await write(ours); this.enabled = true; } catch (e) { await this.restore(); throw e; }
  }
  async restore(expectedOwner) {
    if (!fs.existsSync(this.file)) { this.enabled = false; return; }
    const { previous, ours, ownerPid } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (expectedOwner !== undefined && ownerPid !== expectedOwner) return;
    const current = await read();
    // Another app or the user may have taken ownership; never overwrite them.
    if (current.ProxyServer === ours.ProxyServer && current.ProxyEnable === ours.ProxyEnable) await write(previous);
    fs.unlinkSync(this.file); this.enabled = false;
  }
}
module.exports = { WindowsProxy, ps, powershellError };
