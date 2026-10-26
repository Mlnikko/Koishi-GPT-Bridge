'use strict';
const { MODES, normalizeMode, modeOf, contextOf, modeLabel } = require('../core/modes.cjs');
const { normalizeReasoning, reasoningLabel, reasoningUsage } = require('../core/reasoning.cjs');
const { textMessage } = require('../lib/feedback.cjs');

function registerModes({ command, bot, chats, manage }) {
  command('/mode [模式:text]', '切换聊天、工作、本地；各自保留上下文').action(async ({ session }, value) => {
    if (!value) {
      const chat = bot.currentChat(session), local = contextOf(chat, 'local');
      return textMessage('当前模式：' + modeLabel(chat) + (modeOf(chat) === 'local' ? '（' + (local.model || '未选择模型') + '）' : '')
        + '\n/mode 聊天：ChatGPT 聊天模式，直接对话。'
        + '\n/mode 工作：ChatGPT 工作模式，可调用已安装的原生技能。'
        + '\n/mode 本地 [模型编号]：使用本机 LM Studio 对话。'
        + '\n切换模式会恢复各自历史；/new 开启新话题。');
    }
    const [target, ...args] = value.split(/\s+/), mode = normalizeMode(target);
    if (args.length > 1 || (mode !== 'local' && args.length)) throw Error('用法：/mode 聊天、/mode 工作 或 /mode 本地 [模型编号]');
    return textMessage(await bot.switchMode(session, mode, args[0]));
  });
  command('/model [模型编号:text]', '查看本机模型；带编号选择并进入本地模式').action(async ({ session }, id) => {
    if (id) {
      if (/\s/.test(id)) throw Error('用法：/model [模型编号]');
      return textMessage(await bot.switchMode(session, 'local', id));
    }
    const models = await bot.models(), current = contextOf(bot.currentChat(session), 'local').model;
    return textMessage('当前本地模型：' + (current || '未选择') + '。\n'
      + (models.map(model => model + (model === current ? ' [当前]' : '')).join('\n') || '尚无聊天模型，请在 LM Studio 加载模型。')
      + '\n/model 模型编号 选择；/mode 本地 切回已有本地对话。');
  });
  command('/backend [target:text]', '兼容旧版 web/lmstudio；推荐使用 /mode').action(async ({ session }, target) => {
    const chat = bot.ensureChat(session);
    if (!target) return textMessage('当前后端：' + (MODES[modeOf(chat)].backend === 'web' ? 'ChatGPT 网页' : 'LM Studio')
      + '；当前模式：' + modeLabel(chat) + '。\n请使用 /mode 聊天、/mode 工作 或 /mode 本地。');
    const [backend, ...args] = target.split(/\s+/);
    if (!['web', 'lmstudio'].includes(backend) || args.length > 1 || (backend === 'web' && args.length))
      throw Error('用法：/backend web 或 /backend lmstudio [模型编号]');
    const mode = backend === 'lmstudio' ? 'local' : contextOf(chat, 'work').skill ? 'work' : 'chat';
    await bot.switchMode(session, mode, args[0]);
    const selected = bot.currentChat(session);
    return textMessage(mode === 'local'
      ? '已切换到 LM Studio：' + contextOf(selected, 'local').model + '。直接发消息即可。'
      : '当前会话已切回 ChatGPT 网页（' + modeLabel(selected) + '）。直接发消息即可。');
  });
  command('/reasoning [程度:string]', '网页推理程度；工作模式可按网页档位编号选择').action(manage((owner, chat, value, defaultName) => {
    const current = chats.current(owner, chat);
    if (modeOf(current) === 'local') return 'LM Studio 使用本地模型设置；/reasoning 适用于聊天、工作模式。';
    const mode = modeOf(current);
    if (!value) return '当前会话推理程度：' + reasoningLabel(contextOf(current).reasoningEffort, mode) + '（' + modeLabel(current) + '）。\n' + reasoningUsage(mode);
    const level = normalizeReasoning(value, mode), s = chats.ensure(owner, chat, defaultName);
    chats.setReasoning(s.id, owner, chat, level);
    return '会话「' + s.name + '」的' + modeLabel(s) + '推理程度已设为：' + reasoningLabel(level, mode)
      + '。下一条消息起生效，已排队或运行中的任务保持原设置。'
      + (level === 'default' ? '' : mode === 'work' ? '\n按工作网页的原生强度档位确认；该档位可能同时选择模型与推理强度。'
        : level === 'pro' ? '\nPro 暂不可用时使用当前最高可用档，恢复后自动使用 Pro。'
        : '\n发送前会应用网页选项；账号不支持时会报错。');
  }));
}
module.exports = { registerModes };
