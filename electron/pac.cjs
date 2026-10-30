const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
function pacScript(port, source = '') {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('代理端口无效');
  if (typeof source !== 'string' || Buffer.byteLength(source) > 65536) throw Error('PAC 脚本不能超过 64 KB');
  const script = source.trim() || `function FindProxyForURL(url, host) { if (isPlainHostName(host) || host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'DIRECT'; return 'PROXY __PROXY__; SOCKS5 __PROXY__; DIRECT'; }`;
  const compiled = script.replaceAll('__PROXY__', '127.0.0.1:' + port);
  new vm.Script(compiled + '\n;if(typeof FindProxyForURL!=="function")throw Error("FindProxyForURL required");').runInNewContext(Object.create(null), { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } });
  return compiled;
}
class PacServer {
  async start(port, source = '') {
    await this.stop(); const script = pacScript(port, source); const token = crypto.randomBytes(16).toString('hex');
    this.server = http.createServer((req, res) => {
      if (req.url !== '/' + token + '.pac' || req.method !== 'GET') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(script);
    });
    this.server.maxConnections = 32; this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.url = `http://127.0.0.1:${this.server.address().port}/${token}.pac`; return this.url;
  }
  async stop() { const server = this.server; this.server = null; this.url = null; if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
}
module.exports = { PacServer, pacScript };
