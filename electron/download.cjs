const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const DEFAULT_DOWNLOAD = { timeout: 25000, userAgent: 'Luma Mihomo', viaProxy: false, headers: {} };
function normalizeDownload(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('订阅下载设置无效');
  const next = { ...DEFAULT_DOWNLOAD, ...value, headers: { ...(value.headers || {}) } };
  if (!Number.isInteger(next.timeout) || next.timeout < 1000 || next.timeout > 120000 || typeof next.viaProxy !== 'boolean' || typeof next.userAgent !== 'string' || !next.userAgent.trim() || Buffer.byteLength(next.userAgent) > 512 || /[\r\n\0]/.test(next.userAgent)) throw Error('订阅下载参数无效');
  if (!value.headers || typeof value.headers === 'object' && !Array.isArray(value.headers)) { /* default or explicit map */ } else throw Error('请求头格式无效');
  if (Object.keys(next.headers).length > 32 || Buffer.byteLength(JSON.stringify(next.headers)) > 16384) throw Error('请求头过大');
  for (const [key, val] of Object.entries(next.headers)) { if (typeof val !== 'string' || /^(host|connection|proxy-authorization|proxy-connection|content-length|transfer-encoding|upgrade|accept-encoding)$/i.test(key)) throw Error('不支持此请求头'); try { http.validateHeaderName(key); http.validateHeaderValue(key, val); } catch { throw Error('请求头格式无效'); } }
  return next;
}
function urlValue(value) { let u; try { u = new URL(value); } catch { throw Error('请输入有效的订阅地址'); } if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('订阅地址必须为 HTTP / HTTPS'); return u; }
async function requestSubscription(value, download, proxyPort, signal) {
  const options = normalizeDownload(download);
  if (options.viaProxy && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) throw Error('请先连接内核，再通过代理更新订阅');
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, options.timeout); timer.unref();
  let headers = { 'User-Agent': options.userAgent, Accept: 'text/yaml,text/plain,*/*', 'Accept-Encoding': 'identity', ...options.headers }, current = urlValue(value);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const result = await requestOnce(current, headers, options.viaProxy ? proxyPort : null, controller.signal);
      if ([301,302,303,307,308].includes(result.status) && result.headers.location) { if (redirects === 5) throw Error('订阅重定向次数过多'); const next = urlValue(new URL(result.headers.location, current).href); if (next.origin !== current.origin) headers = { 'User-Agent': options.userAgent, Accept: headers.Accept, 'Accept-Encoding':'identity' }; current = next; continue; }
      if (result.status < 200 || result.status >= 300) throw Error(`订阅下载失败（HTTP ${result.status}）`);
      return result;
    }
  } catch (error) { if (controller.signal.aborted) throw Error('订阅下载超时'); if (/^订阅|^请|^输入|^不支持/.test(error.message)) throw error; throw Error('订阅下载失败，请检查网络或下载设置'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function requestOnce(u, headers, proxyPort, signal) {
  return new Promise((resolve, reject) => {
    let request, tunnel, socket, agent, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); request?.destroy(); tunnel?.destroy(); socket?.destroy(); agent?.destroy(); error ? reject(error) : resolve(result); };
    const abort = () => finish(Error('aborted')); if (signal.aborted) return abort(); signal.addEventListener('abort', abort, { once:true });
    const response = res => { let size = 0; const chunks=[]; res.on('error', error=>finish(error)); res.on('data', bytes=>{ size += bytes.length; if (size > 8*1024*1024) return finish(Error('订阅文件不能超过 8 MB')); chunks.push(bytes); }); res.on('end',()=>finish(null,{status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)})); };
    const start = connectionAgent => { const transport = u.protocol === 'https:' ? https : http; request = transport.request({ hostname:u.hostname.replace(/^\[|\]$/g,''),port:u.port||undefined,path:u.pathname+u.search,method:'GET',headers,agent:connectionAgent,signal },response); request.on('error',error=>finish(error)); request.end(); };
    if (!proxyPort) return start(undefined);
    if (u.protocol === 'http:') { request = http.request({hostname:'127.0.0.1',port:proxyPort,path:u.href,method:'GET',headers:{...headers,Host:u.host},signal},response); request.on('error',error=>finish(error)); request.end(); return; }
    tunnel = http.request({hostname:'127.0.0.1',port:proxyPort,method:'CONNECT',path:u.hostname+':'+(u.port||443),headers:{Host:u.host},signal});
    tunnel.on('error',error=>finish(error)); tunnel.on('connect',(res, raw, head)=>{if(res.statusCode!==200){raw.destroy();return finish(Error('订阅代理连接失败'));} if(head.length)raw.unshift(head); const hostname=u.hostname.replace(/^\[|\]$/g,''); socket=tls.connect({socket:raw,servername:require('node:net').isIP(hostname)?undefined:hostname,rejectUnauthorized:true}); socket.on('error',error=>finish(error)); socket.once('secureConnect',()=>{agent=new https.Agent({keepAlive:false});agent.createConnection=()=>socket;start(agent);});}); tunnel.end();
  });
}
module.exports = { normalizeDownload, requestSubscription, urlValue };
