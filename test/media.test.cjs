const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { MediaChecks } = require('../electron/media.cjs');
function fixture(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-media-'));
  const file = path.join(dir, 'fixture.cjs'); fs.writeFileSync(file, source);
  const checks = new MediaChecks(file, (binary, _args, options) => spawn(process.execPath, [binary], options));
  t.after(() => { checks.cancel(); fs.rmSync(dir, { recursive: true, force: true }); }); return checks;
}
const source = `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const p=JSON.parse(input);const items=[{name:'Local',status:'Pending',region:null,check_time:null},{name:'Hang',status:'Pending'}];if(p.action==='list')return console.log(JSON.stringify({ok:true,items}));if(p.proxyPort!==12345)process.exit(1);if(p.check==='Hang')return setInterval(()=>{},1000);console.log(JSON.stringify({ok:true,items:[{name:'Local',status:'Yes',region:'本地',check_time:'now'}]}));});`;
test('media checks enumerate locally, constrain proxy port and retain results', async t => {
  const checks = fixture(t, source); assert.equal((await checks.list()).length, 2); assert.equal(checks.child, null);
  await assert.rejects(checks.check(0), /连接/); await assert.rejects(checks.check(12345, 'Unknown'), /无效/);
  const result = await checks.check(12345, 'Local'); assert.equal(result[0].status, 'Yes'); assert.equal(result[0].region, '本地'); assert.equal(result[1].status, 'Pending');
  assert.equal((await checks.list())[0].status, 'Yes');
});
test('media cancellation terminates the operation and permits retry', async t => {
  const checks = fixture(t, source); await checks.list(); const pending = assert.rejects(checks.check(12345, 'Hang'), /取消/);
  while (!checks.child) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(checks.check(12345, 'Local'), /正在/); checks.cancel(); await pending;
  assert.equal(checks.child, null); assert.equal((await checks.check(12345, 'Local'))[0].status, 'Yes');
});
test('media CLI rejects malformed and excessive responses without exposing stderr', async t => {
  const malformed = fixture(t, `process.stderr.write('privateURL');process.stdout.write('invalid');`); await assert.rejects(malformed.list(), error => /未完成/.test(error.message) && !error.message.includes('privateURL'));
  const huge = fixture(t, `process.stdout.write('x'.repeat(300000));`); await assert.rejects(huge.list(), /过大/); assert.equal(huge.child, null);
});
