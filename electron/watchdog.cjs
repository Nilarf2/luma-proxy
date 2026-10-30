// Independent recovery even when Task Manager terminates the UI process.
const { WindowsProxy } = require('./windows-proxy.cjs');
const [pid, dir] = process.argv.slice(2);
const proxy = new WindowsProxy(dir);
const timer = setInterval(async () => {
  try { process.kill(Number(pid), 0); } catch {
    clearInterval(timer);
    try { await proxy.restore(); process.exit(0); } catch { process.exit(1); }
  }
}, 1500);
