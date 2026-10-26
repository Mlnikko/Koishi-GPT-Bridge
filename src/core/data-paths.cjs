'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA_NAME = 'codex-image-local';
const STATE_ENTRIES = ['web-bridge-token', 'conversations.json', 'preferences.json', 'jobs', 'lmstudio', 'presets', 'skills', 'prompts'];

function hasState(root) {
  return STATE_ENTRIES.some(entry => {
    try { fs.statSync(path.join(root, entry)); return true; }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  });
}

// Reading paths must not create a second token or switch an existing account
// silently. Actual migration is an offline copy followed by explicit dataDir.
function resolveDataDir({ dataDir, baseDir = process.cwd(), packageRoot = path.join(__dirname, '..', '..') } = {}) {
  if (dataDir != null) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) throw Error('dataDir 必须是非空路径');
    return { dataDir: path.resolve(baseDir, dataDir), legacy: false };
  }
  const current = path.resolve(baseDir, 'data', DATA_NAME);
  const legacy = path.resolve(packageRoot, 'data');
  if (legacy !== current && hasState(legacy)) {
    if (hasState(current)) throw Error('新旧数据目录均有记录，请显式配置 dataDir 选择使用哪一份；不会自动合并。');
    return { dataDir: legacy, legacy: true };
  }
  return { dataDir: current, legacy: false };
}

module.exports = { DATA_NAME, resolveDataDir };
