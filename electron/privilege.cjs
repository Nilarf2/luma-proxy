const { ps } = require('./windows-proxy.cjs');
async function isAdministrator() {
  if (process.platform !== 'win32') return false;
  return (await ps(`$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`, 5000)).toLowerCase() === 'true';
}
const decode = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`;
function quoteArgument(value) { return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
async function elevate(app) {
  if (process.platform !== 'win32') throw Error('管理员模式仅支持 Windows');
  const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = (app.isPackaged ? [] : [app.getAppPath()]).concat([`--user-data-dir=${app.getPath('userData')}`, '--luma-elevated']);
  app.releaseSingleInstanceLock();
  try { await ps(`$ErrorActionPreference='Stop'; Start-Process -FilePath (${decode(executable)}) -ArgumentList (${decode(args.map(quoteArgument).join(' '))}) -Verb RunAs | Out-Null`, 60000); }
  catch { app.requestSingleInstanceLock(); throw Error('未获得管理员权限，TUN 尚未启用'); }
}
module.exports = { isAdministrator, elevate, quoteArgument };
