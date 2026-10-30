// Independent recovery even when Task Manager terminates the UI process.
const { WindowsProxy, ps } = require('./windows-proxy.cjs');
const [pid, dir, binary] = process.argv.slice(2);
const proxy = new WindowsProxy(dir);
const timer = setInterval(async () => {
  try { process.kill(Number(pid), 0); } catch {
    clearInterval(timer);
    let failed = false;
    try { await proxy.restore(Number(pid)); } catch { failed = true; }
    // Only stop the exact bundled kernel whose recorded parent is this app.
    if (binary && /^\d+$/.test(pid)) {
      const encoded = Buffer.from(binary, 'utf8').toString('base64');
      try { await ps(`$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`); } catch { failed = true; }
    }
    process.exit(failed ? 1 : 0);
  }
}, 1500);
