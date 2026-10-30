const fs = require('node:fs');
const { ps } = require('./windows-proxy.cjs');
function memorySampler({ app, getWindow, getCorePid, platform = process.platform, read = fs.readFileSync, powershell = ps, rss = () => process.memoryUsage().rss, now = Date.now } = {}) {
  let cachedCore = null, cachedPid, checkedAt = -Infinity, task;
  async function coreMemory() {
    const pid = getCorePid();
    if (!Number.isInteger(pid) || pid <= 0) { cachedPid = undefined; cachedCore = null; return null; }
    if (pid === cachedPid && now() - checkedAt < 10000) return cachedCore;
    if (task) return task;
    cachedPid = pid; checkedAt = now();
    task = (async () => {
      try {
        let bytes;
        if (platform === 'win32') { const text = await powershell(`$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${pid} -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { exit 0 }; throw }; $p.WorkingSet64.ToString()`, 3000); bytes = /^\d+$/.test(text) ? Number(text) : null; }
        else if (platform === 'linux') { const match = String(read(`/proc/${pid}/status`, 'utf8')).match(/^VmRSS:\s+(\d+) kB$/m); bytes = match ? Number(match[1]) * 1024 : null; }
        else bytes = null;
        cachedCore = getCorePid() === pid && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
      } catch { cachedCore = null; }
      return cachedCore;
    })().finally(() => { task = null; });
    return task;
  }
  return async () => {
    const metrics = app.getAppMetrics(); const main = rss();
    const w = getWindow(); const rendererPid = w && !w.isDestroyed() ? w.webContents.getOSProcessId() : null;
    const renderer = metrics.find(value => value.pid === rendererPid)?.memory?.workingSetSize;
    const total = metrics.reduce((sum, value) => sum + (Number(value.memory?.workingSetSize) || 0) * 1024, 0);
    return { main, renderer: Number.isFinite(renderer) ? renderer * 1024 : 0, total: total || main, core: await coreMemory() };
  };
}
module.exports = { memorySampler };
