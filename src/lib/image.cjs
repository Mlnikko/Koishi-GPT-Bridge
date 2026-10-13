'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { randomBytes } = require('node:crypto');

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_IMAGES = 2;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

// Only raster formats ChatGPT accepts as uploads. SVG is deliberately excluded:
// it is a scriptable document, not a picture, and must never be forwarded.
const TYPES = [
  { mime: 'image/png', ext: 'png', match: b => b.length > 8 && b.subarray(0, 8).equals(PNG_SIGNATURE) },
  { mime: 'image/jpeg', ext: 'jpg', match: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', match: b => b.length > 6 && b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  { mime: 'image/webp', ext: 'webp', match: b => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

function imageError(code, message) { return Object.assign(new Error(message), { code }); }
function limitText(maxBytes) { return `${Math.round(maxBytes / 1024 / 1024)} MB`; }

function sniffImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) throw imageError('image_invalid', '图片数据为空或过小，未下载');
  const type = TYPES.find(candidate => candidate.match(bytes));
  if (!type) throw imageError('image_invalid', '不支持的图片格式，请发送 PNG、JPEG、GIF 或 WebP 图片');
  return type;
}

// Pure-JS PNG header parse. The macOS `sips` binary is not available on every
// host, and the connector must still validate downloaded output there.
function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) throw imageError('image_invalid', '图片数据不完整');
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw imageError('image_invalid', '图片不是有效 PNG');
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') throw imageError('image_invalid', 'PNG 缺少 IHDR 数据块');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height) throw imageError('image_invalid', 'PNG 尺寸无效');
  return { width, height };
}

// Reject loopback, link-local, private and reserved ranges so a crafted message
// cannot make the host fetch its own services (SSRF).
function isPrivateAddress(address) {
  const value = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return true;
  if (net.isIPv4(value)) {
    const [a, b, c] = value.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return false;
  }
  if (net.isIPv6(value)) {
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
    if (mapped) {
      const n = parseInt(mapped[1], 16), m = parseInt(mapped[2], 16);
      return isPrivateAddress(`${n >> 8}.${n & 255}.${m >> 8}.${m & 255}`);
    }
    // Only global unicast; exclude documentation and transition mechanisms.
    return !/^[23]/.test(normalized) || /^2001:(?:db8|0):|^2001::|^2002:/.test(normalized);
  }
  return true;
}

function decodeDataUrl(value) {
  const match = /^data:([^,]*),(.*)$/is.exec(value);
  if (!match) throw imageError('image_invalid', '图片数据地址无效，未下载');
  const meta = match[1] || '', payload = match[2] || '';
  try {
    return /;base64/i.test(meta) ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'binary');
  } catch { throw imageError('image_invalid', '图片数据无法解码，未下载'); }
}

// 消息元素的归一化（文本与图片、顺序保留）由 core/message.cjs 负责：
// 它属于领域逻辑，而这里只管「怎么安全地把一张图拿下来」。
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    response.body?.destroy?.();
    await response.body?.cancel?.();
    throw imageError('image_too_large', `图片超过 ${limitText(maxBytes)} 上限，未下载`);
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw imageError('image_too_large', `图片超过 ${limitText(maxBytes)} 上限，未下载`);
    return buffer;
  }
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk); total += buffer.length;
    if (total > maxBytes) throw imageError('image_too_large', `图片超过 ${limitText(maxBytes)} 上限，未下载`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function assertPublicHost(url, { lookup, allowPrivate, timeoutMs }) {
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host }];
  else {
    let timer;
    try { addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DNS timeout')), timeoutMs); }),
    ]); }
    catch { throw imageError('image_download', '图片域名无法解析，未下载'); }
    finally { clearTimeout(timer); }
  }
  if (!addresses?.length) throw imageError('image_download', '图片域名无法解析，未下载');
  if (addresses.some(entry => isPrivateAddress(entry.address))) throw imageError('image_blocked', '图片地址指向本机或内网，已拒绝下载');
  return addresses;
}

// Pin the checked DNS answers to the actual socket: a second DNS lookup by
// fetch would allow DNS rebinding between validation and connection.
function pinnedFetch(url, { signal, addresses }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal,
      lookup: addresses ? (_host, options, callback) => {
        const candidates = addresses.map(entry => ({ address: entry.address, family: net.isIP(entry.address) }))
          .filter(entry => !options.family || options.family === entry.family);
        if (!candidates.length) return callback(Error('No permitted address'));
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      } : undefined,
    }, response => resolve({
      status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
      headers: { get: name => response.headers[name.toLowerCase()] }, body: response,
    }));
    request.on('error', reject);
  });
}

// Download one QQ image into `dir` and return its validated local metadata.
// Supports http(s) URLs plus the inline forms some QQ adapters emit; anything
// else (file://, ftp://, ...) is refused so no local path can be read.
async function downloadImage(source, dir, options = {}) {
  const { maxBytes = MAX_INPUT_BYTES, timeoutMs = 30000, redirects = 3,
    lookup = dns.promises.lookup, fetchImpl, allowPrivate = false } = options;
  const value = String(source || '').trim();
  if (!value) throw imageError('image_invalid', '消息中没有可用的图片地址');
  // DNS, redirects, connection and body share one budget. Resetting it for
  // every hop can consume the QQ reply window before a job even enters the queue.
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw imageError('image_download', '图片下载超时，请稍后重试');
    return ms;
  };
  let bytes;
  // Reject oversized inline payloads before allocating their decoded buffer.
  if (/^(?:data:[^,]*;base64,|base64:\/\/)/i.test(value) && value.length > maxBytes * 4 / 3 + 1024)
    throw imageError('image_too_large', `图片超过 ${limitText(maxBytes)} 上限，未下载`);
  if (/^data:/i.test(value)) bytes = decodeDataUrl(value);
  else if (/^base64:\/\//i.test(value)) bytes = Buffer.from(value.slice('base64://'.length), 'base64');
  else {
    let url;
    try { url = new URL(value); } catch { throw imageError('image_invalid', '图片地址无效，未下载'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw imageError('image_invalid', '出于安全考虑，仅支持下载 http(s) 图片');
    for (let hop = 0; ; hop++) {
      const addresses = await assertPublicHost(url, { lookup, allowPrivate, timeoutMs: remaining() });
      let response;
      try {
        const signal = AbortSignal.timeout(remaining());
        response = fetchImpl ? await fetchImpl(url.href, { redirect: 'manual', signal })
          : await pinnedFetch(url, { addresses, signal });
      }
      catch { throw imageError('image_download', '图片下载失败，请稍后重试'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.body?.destroy?.();
        if (hop >= redirects) throw imageError('image_download', '图片重定向次数过多，未下载');
        const location = response.headers.get('location');
        if (!location) throw imageError('image_download', '图片重定向地址缺失，未下载');
        try { url = new URL(location, url.href); } catch { throw imageError('image_download', '图片重定向地址无效，未下载'); }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw imageError('image_invalid', '图片重定向到不支持的协议，未下载');
        continue;
      }
      if (!response.ok) { response.body?.destroy?.(); throw imageError('image_download', `图片下载失败（HTTP ${response.status}）`); }
      try { bytes = await readCapped(response, maxBytes); remaining(); }
      catch (err) {
        if (err.code?.startsWith('image_')) throw err;
        throw imageError('image_download', Date.now() >= deadline ? '图片下载超时，请稍后重试' : '图片下载失败，请稍后重试');
      }
      break;
    }
  }
  if (bytes.length > maxBytes) throw imageError('image_too_large', `图片超过 ${limitText(maxBytes)} 上限，未下载`);
  const type = sniffImage(bytes);
  const file = path.join(dir, `image-${randomBytes(4).toString('hex')}.${type.ext}`);
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  return { file, mime: type.mime, ext: type.ext, size: bytes.length };
}

module.exports = { downloadImage, sniffImage, pngSize, isPrivateAddress, decodeDataUrl,
  MAX_INPUT_BYTES, MAX_INPUT_IMAGES };
