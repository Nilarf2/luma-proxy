const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { Store } = require('../electron/store.cjs');
const { registerProfiles } = require('../electron/profiles.cjs');
const { validatePair } = require('../electron/certificates.cjs');
const cert = path.join(__dirname, 'fixtures', 'localhost-cert.pem'), key = path.join(__dirname, 'fixtures', 'localhost-key.pem');
test('explicit certificate import validates PEM pair and keeps cancellation and failures atomic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-client-certificate-')), store = new Store(dir), handlers = {};
  const id = '12345678-1234-1234-1234-123456789012'; store.data.profiles.push({ id, name: 'Local' }); store.data.activeId = id;
  const initial = YAML.stringify({proxies:[{name:'Local TLS',type:'http',server:'127.0.0.1',port:1080,tls:true}],rules:['MATCH,DIRECT']});
  const expectedCert=fs.readFileSync(cert,'utf8').replace(/\r\n/g,'\n'), expectedKey=fs.readFileSync(key,'utf8').replace(/\r\n/g,'\n');
  const windowsCert=path.join(dir,'crlf-cert.pem'),windowsKey=path.join(dir,'crlf-key.pem');
  fs.writeFileSync(windowsCert,expectedCert.replace(/\n/g,'\r\n'));fs.writeFileSync(windowsKey,expectedKey.replace(/\n/g,'\r\n'));
  fs.writeFileSync(store.profilePath(id), initial);store.save();const choices=[];let running=false,connects=0;
  const reg = registerProfiles({ handle:(n,fn)=>handlers[n]=fn,store,engine:{get ready(){return running;}},dialog:{showOpenDialog:async()=>choices.shift()},getWindow:()=>null,exclusive:fn=>fn(),disconnect:async()=>{},connect:async()=>{if(++connects===1)throw Error('Injected restart failure');},publish(){},isBusy:()=>false,isQuitting:()=>false });
  const invoke=()=>handlers['profile:certificate:import']({id,node:'Local TLS'}),chosen=file=>({canceled:false,filePaths:[file]});
  try {
    choices.push(chosen(cert),{canceled:true,filePaths:[]});assert.deepEqual(await invoke(),{canceled:true});assert.equal(fs.readFileSync(store.profilePath(id),'utf8'),initial);
    const invalid=path.join(dir,'invalid.pem');fs.writeFileSync(invalid,'not a PEM file');choices.push(chosen(invalid),chosen(key));await assert.rejects(invoke(),/PEM/);
    const wrong=path.join(dir,'wrong-key.pem');fs.writeFileSync(wrong,crypto.generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}));choices.push(chosen(cert),chosen(wrong));await assert.rejects(invoke(),/匹配/);
    assert.equal(fs.readFileSync(store.profilePath(id),'utf8'),initial);
    running=true;choices.push(chosen(cert),chosen(key));await assert.rejects(invoke(),/Injected/);assert.equal(connects,2);assert.equal(fs.readFileSync(store.profilePath(id),'utf8'),initial);
    running=false;choices.push(chosen(windowsCert),chosen(windowsKey));assert.deepEqual(await invoke(),{imported:true});
    const node=YAML.parse(fs.readFileSync(store.profilePath(id),'utf8')).proxies[0];validatePair(node.certificate,node['private-key']);assert.equal(node.certificate,expectedCert);assert.equal(node['private-key'],expectedKey);assert.equal(JSON.stringify(store.publicData()).includes('PRIVATE KEY'),false);
    for(const text of [node.certificate+'trailing text','-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----'])assert.throws(()=>validatePair(text,node['private-key']),/PEM/);
    const huge=path.join(dir,'huge.pem');fs.writeFileSync(huge,Buffer.alloc(65537));choices.push(chosen(huge),chosen(key));await assert.rejects(invoke(),/64 KB/);
    await assert.rejects(handlers['profile:certificate:import']({id,node:'Unknown'}),/唯一/);
  } finally {reg.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
