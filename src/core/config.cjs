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
  return {
    ...config,
    allowedUsers: [...new Set(config.allowedUsers.map(user => user.trim()))],
    dataDir: path.resolve(config.dataDir || defaultRoot),
    webBridgePort: integer('webBridgePort', 5141, 0, 65535),
    maxTextChars: integer('maxTextChars', 1500, 16),
    maxReplyChars: integer('maxReplyChars', 6000),
    maxInputImages: integer('maxInputImages', 2, 1, 10),
    maxInputBytes: integer('maxInputBytes', 10 * 1024 * 1024),
    replyTimeoutMs: integer('replyTimeoutMs', 300000, 1, 2147483647),
    sendTimeoutMs: integer('sendTimeoutMs', 20000, 1, 2147483647),
    retentionDays: integer('retentionDays', 0, 0),
  };
}

module.exports = { normalizeConfig };
