const fs = require('node:fs');
const crypto = require('node:crypto');
const MAX_PEM = 64 * 1024;
function readPem(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 32 || stat.size > MAX_PEM) throw Error();
    const bytes = Buffer.alloc(stat.size + 1); const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== stat.size) throw Error();
    return bytes.subarray(0, size).toString('utf8').replace(/\r\n/g, '\n');
  } catch { throw Error('请选择不超过 64 KB 的 PEM 文件'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function blocks(text, pattern) {
  const matches = [...text.matchAll(pattern)];
  if (!matches.length || text.replace(pattern, '').trim()) throw Error();
  return matches.map(match => match[0]);
}
function validatePair(certificate, privateKey) {
  try {
    const certificates = blocks(certificate, /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g).map(value => new crypto.X509Certificate(value));
    const keys = blocks(privateKey, /-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----[\s\S]*?-----END \1-----/g);
    if (keys.length !== 1) throw Error();
    const key = crypto.createPrivateKey(keys[0]);
    if (!certificates[0].checkPrivateKey(key)) throw Error();
  } catch { throw Error('证书或私钥 PEM 无效，或两者不匹配'); }
}
async function selectCertificatePair(dialog, window) {
  const select = title => dialog.showOpenDialog(window, { title, filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key'] }], properties: ['openFile'] });
  const certificate = await select('选择客户端证书 PEM'); if (certificate.canceled || !certificate.filePaths?.[0]) return null;
  const privateKey = await select('选择对应私钥 PEM'); if (privateKey.canceled || !privateKey.filePaths?.[0]) return null;
  const pair = { certificate: readPem(certificate.filePaths[0]), 'private-key': readPem(privateKey.filePaths[0]) };
  validatePair(pair.certificate, pair['private-key']); return pair;
}
module.exports = { readPem, validatePair, selectCertificatePair };
