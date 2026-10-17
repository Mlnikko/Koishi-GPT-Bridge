'use strict';
const path = require('node:path');
const { normalizeConfig } = require('./core/config.cjs');
const { Conversations } = require('./core/conversations.cjs');
const { Preferences } = require('./core/preferences.cjs');
const { Presets } = require('./core/presets.cjs');
const { Skills } = require('./core/skills.cjs');
const { ImagePrompts } = require('./core/image-prompts.cjs');
const { WebBridge } = require('./bridge/web-bridge.cjs');
const { LMStudioBridge } = require('./bridge/lmstudio-bridge.cjs');
const { createBot } = require('./app/bot.cjs');
const { accessFilter } = require('./app/session-scope.cjs');
const { createCommands } = require('./commands/index.cjs');
const { version } = require('../package.json');

exports.name = 'codex-image-local';
exports.apply = (ctx, rawConfig) => {
  const config = normalizeConfig(rawConfig, path.join(__dirname, '..', 'data'));
  const root = config.dataDir;
  const chats = new Conversations(path.join(root, 'conversations.json'));
  const presets = new Presets(path.join(root, 'presets'));
  const skills = new Skills(config.skillsDir || path.join(root, 'skills'),
    config.skillsDir ? undefined : path.join(__dirname, '..', 'examples', 'skills'));
  const imagePrompts = new ImagePrompts(path.join(root, 'prompts'), path.join(__dirname, '..', 'examples', 'prompts'));
  const preferences = new Preferences(path.join(root, 'preferences.json'), config.notifyProgress);
  const web = new WebBridge({ root, port: config.webBridgePort, timeoutMs: config.replyTimeoutMs, pluginVersion: version });
  const local = new LMStudioBridge({ root, baseUrl: config.lmStudioBaseUrl, apiKey: config.lmStudioApiKey,
    model: config.lmStudioModel, maxTokens: config.lmStudioMaxTokens, historyTurns: config.lmStudioHistoryTurns,
    historyChars: config.lmStudioHistoryChars, historyImages: config.lmStudioHistoryImages,
    historyImageBytes: config.lmStudioHistoryImageBytes, maxImageBytes: config.maxInputBytes, timeoutMs: config.replyTimeoutMs });
  const logger = Object.fromEntries(['info', 'warn'].map(level => [level, message => {
    try { ctx.logger('codex-image-local')[level](message); } catch {}
  }]));
  const bot = createBot(config, { chats, presets, skills, preferences, web, local, logger });
  const commands = createCommands({ bot, chats, skills, presets, imagePrompts, config });
  const scope = ctx.intersect(accessFilter(config));
  scope.middleware((session, next) => commands.dispatch(session, next), true);
  scope.middleware((session, next) => next(() => bot.forward(session)));
  if (config.retentionDays > 0) {
    bot.prune();
    ctx.setInterval(() => bot.prune(), 6 * 60 * 60 * 1000);
  }
  ctx.setInterval(() => bot.notifyProgress(), 10000);
  ctx.on('dispose', () => bot.close());
};
