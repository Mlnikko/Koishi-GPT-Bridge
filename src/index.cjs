'use strict';
const path = require('node:path');
const { normalizeConfig } = require('./core/config.cjs');
const { Config } = require('./core/config-schema.cjs');
const { DATA_NAME, resolveDataDir } = require('./core/data-paths.cjs');
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
exports.Config = Config;
exports.usage = `把 ChatGPT 网页和本机 LM Studio 接入 QQ，在手机或电脑 QQ 中连续提问、看图、创作图片和调用技能。

### 功能与使用场景

- **日常问答**：默认直接聊天，可翻译、润色、解释代码片段；用 /new 新建话题、/chat 切回旧话题。
- **看图与创作**：发送图片提问，或使用网页账号支持的生图、改图能力制作插画和海报；图片模板可复用提示词。
- **专项技能**：/mode 工作 使用 ChatGPT Work，/skill 名称 调用网页已安装的同名原生技能，适合固定规则的整理、写作和创作任务。
- **本地模型**：/mode 本地 使用 LM Studio，支持模型选择、角色预设和本机 SKILL.md 文字规则；视觉模型可看图，回复为文字。

三种模式分别保留上下文与设置。任务统一排队，可用 /status 查看、/stop 停止、/retry 取回已有结果。

### 开始使用

先填写私聊用户白名单，确认 QQ 适配器已连接。群聊默认关闭，开启后群内任何成员 @ 机器人均可使用。

网页模式需要同机 Chrome 120+、已登录的 ChatGPT 和配套扩展。在 Koishi 实例目录运行
\`npx --no-install koishi-gpt-bridge-setup\`，按输出路径在 Chrome 加载扩展。
自定义 dataDir 或端口时，安装命令也需传入相同的 --data-dir、--port。

保持 Koishi 与 Chrome 运行；网页功能和额度以账号实际支持为准。本地模式须另行启动 LM Studio 服务并加载模型。
本机技能仅加载文本，不执行附带脚本或工具，也不自动访问本机项目文件。

新安装的数据保存在实例的 data/codex-image-local；旧版数据会继续使用原路径。
完整功能、安装与迁移说明：https://www.npmjs.com/package/koishi-plugin-chatgpt-bridge#安装`;
exports.apply = (ctx, rawConfig) => {
  const baseDir = ctx.baseDir || process.cwd();
  const config = normalizeConfig(rawConfig, path.join(baseDir, 'data', DATA_NAME), baseDir);
  const storage = resolveDataDir({ dataDir: rawConfig.dataDir, baseDir });
  config.dataDir = storage.dataDir;
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
  if (storage.legacy) logger.warn('沿用旧版数据目录：' + root + '。迁移前请停止实例并完整复制数据，再显式配置 dataDir。');
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
