'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sniffImage, pngSize } = require('./image.cjs');
const { writeAtomic } = require('./state.cjs');

const ASSET_LIMIT = 20 * 1024 * 1024;
const MAX_ASSETS = 10;
const EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
const fail = message => Object.assign(Error(message), { code: 'image_invalid' });

function replyAssetPath(dir, index, mime = 'image/png') {
  const ext = EXTENSIONS[mime];
  if (typeof mime !== 'string' || !Object.hasOwn(EXTENSIONS, mime) || !Number.isInteger(index) || index < 0 || index >= MAX_ASSETS)
    throw fail('回复图片格式或序号无效');
  return path.join(dir, `result-${index}.${ext}`);
}

function assetType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > ASSET_LIMIT)
    throw fail('网页返回的图片大小异常');
  const { mime, ext } = sniffImage(bytes);
  if (ext === 'png') pngSize(bytes);
  if (ext === 'gif' && (!/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))
    || !bytes.readUInt16LE(6) || !bytes.readUInt16LE(8) || bytes.at(-1) !== 0x3b))
    throw fail('网页返回的 GIF 数据不完整');
  return { mime, ext };
}

function saveAsset(bytes, dir, index) {
  const type = assetType(bytes), destination = replyAssetPath(dir, index, type.mime);
  try { writeAtomic(destination, bytes); }
  catch (err) { throw fail('网页图片保存失败：' + (err.code || 'write')); }
  return type;
}

// A receipt may commit before job.json. Recover actual file types, including
// legacy PNG receipts without MIME, and reject missing/ambiguous/corrupt media.
function recoverAssets(dir) {
  const assets = new Map();
  for (const name of fs.readdirSync(dir)) {
    const match = /^result-(\d+)\.(png|gif|jpg|webp)$/.exec(name);
    if (!match) continue;
    const index = Number(match[1]), file = path.join(dir, name), stat = fs.lstatSync(file);
    if (index >= MAX_ASSETS || assets.has(index) || !stat.isFile() || stat.isSymbolicLink() || stat.size > ASSET_LIMIT)
      throw fail('回复图片文件无效或存在同序号的多个版本');
    const type = assetType(fs.readFileSync(file));
    if (type.ext !== match[2] || name !== path.basename(replyAssetPath(dir, index, type.mime)))
      throw fail('回复图片文件名与实际格式或序号不一致');
    assets.set(index, type);
  }
  for (let index = 0; index < assets.size; index++) {
    if (!assets.has(index)) throw fail('回复图片序号不连续');
  }
  return assets;
}

module.exports = { replyAssetPath, saveAsset, recoverAssets, ASSET_LIMIT, MAX_ASSETS };
