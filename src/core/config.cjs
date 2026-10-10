'use strict';
const path = require('node:path');

// Validate the whole configuration before opening files, sockets or timers.
function normalizeConfig(config, defaultRoot) {
  if (!Array.isArray(config?.allowedUsers) || !config.allowedUsers.length
    || config.allowedUsers.some(user => typeof user !== 'string' || !user.trim())) {
    throw Error('必须配置 allowedUsers 为非空的用户编号数组');
  }
  const integer = (key, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const value = config[key] == null ? fallback : Number(config[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw Error(`${key} 必须是 ${min}–${max} 范围内的整数`);
    return value;
  };
  for (const key of ['groupChat', 'notifyProgress']) {
    if (config[key] != null && typeof config[key] !== 'boolean') throw Error(`${key} 必须是布尔值`);
  }
  if (config.dataDir != null && (typeof config.dataDir !== 'string' || !config.dataDir.trim()))
    throw Error('dataDir 必须是非空路径');
  let lmStudioUrl;
  try { lmStudioUrl = new URL(config.lmStudioBaseUrl ?? 'http://127.0.0.1:1234/v1'); }
  catch { throw Error('lmStudioBaseUrl 必须是本机 LM Studio 的 HTTP 地址'); }
  if (lmStudioUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(lmStudioUrl.hostname)
    || lmStudioUrl.username || lmStudioUrl.password || lmStudioUrl.search || lmStudioUrl.hash
    || lmStudioUrl.pathname.replace(/\/$/, '') !== '/v1')
    throw Error('lmStudioBaseUrl 必须使用本机回环地址和 /v1 路径，例如 http://127.0.0.1:1234/v1');
  for (const key of ['lmStudioModel', 'lmStudioApiKey']) {
    if (config[key] != null && (typeof config[key] !== 'string' || /[\r\n]/.test(config[key])))
      throw Error(`${key} 必须是单行字符串`);
  }
  const maxInputImages = integer('maxInputImages', 2, 1, 10);
  const maxInputBytes = integer('maxInputBytes', 10 * 1024 * 1024);
  return {
    ...config,
    allowedUsers: [...new Set(config.allowedUsers.map(user => user.trim()))],
    dataDir: path.resolve(config.dataDir || defaultRoot),
    webBridgePort: integer('webBridgePort', 5141, 0, 65535),
    lmStudioBaseUrl: lmStudioUrl.href.replace(/\/$/, ''),
    lmStudioModel: config.lmStudioModel?.trim() || '',
    lmStudioApiKey: config.lmStudioApiKey?.trim() || '',
    lmStudioMaxTokens: integer('lmStudioMaxTokens', 2048, 1, 32768),
    lmStudioHistoryTurns: integer('lmStudioHistoryTurns', 20, 1, 100),
    lmStudioHistoryChars: integer('lmStudioHistoryChars', 12000, 1500, 256000),
    lmStudioHistoryImages: integer('lmStudioHistoryImages', Math.max(4, maxInputImages), maxInputImages, 100),
    lmStudioHistoryImageBytes: integer('lmStudioHistoryImageBytes', Math.max(20 * 1024 * 1024, maxInputBytes * maxInputImages), maxInputBytes * maxInputImages),
    maxTextChars: integer('maxTextChars', 1500, 16),
    maxReplyChars: integer('maxReplyChars', 6000),
    maxInputImages,
    maxInputBytes,
    replyTimeoutMs: integer('replyTimeoutMs', 300000, 1, 2147483647),
    sendTimeoutMs: integer('sendTimeoutMs', 20000, 1, 2147483647),
    retentionDays: integer('retentionDays', 0, 0),
  };
}

module.exports = { normalizeConfig };
