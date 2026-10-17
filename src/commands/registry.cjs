'use strict';
const { modeOf, modeLabel, normalizeMode } = require('../core/modes.cjs');
const { toSegments, submissionText } = require('../core/message.cjs');
const { textMessage, safeReason } = require('../lib/feedback.cjs');

class CommandRegistry {
  constructor() { this.items = new Map(); }
  command(definition, description, group = 'advanced') {
    const name = definition.split(' ')[0];
    if (this.items.has(name)) throw Error('重复命令：' + name);
    return { action: handler => this.items.set(name, { name, definition, description, group, handler }) };
  }
  help(session, chat, topic) {
    const all = topic?.toLowerCase() === 'all';
    let mode;
    try { mode = topic && !all ? normalizeMode(topic) : modeOf(chat); }
    catch { throw Error('用法：/help [聊天|工作|本地|all]'); }
    const items = [...this.items.values()].filter(item => all || item.group === 'common' || [item.group].flat().includes(mode));
    const common = ['/help', '/mode', '/new', '/chat', '/status', '/stop'];
    items.sort((a, b) => (common.includes(a.name) ? common.indexOf(a.name) : common.length)
      - (common.includes(b.name) ? common.indexOf(b.name) : common.length));
    return textMessage('当前模式：' + modeLabel(chat) + '。直接发文字、图片或引用即可对话；群聊需 @ 机器人。\n'
      + items.map(item => item.definition.replace(/:string|:text/g, '') + '：' + item.description).join('\n')
      + (all ? '\n旧版 /backend 仍可使用，日常请用 /mode。' : '\n发送 /help all 查看模板、推理设置、通知和其他命令。')
      + '\n三种模式分别保留上下文，切换不会混用聊天记录。');
  }
  async dispatch(session, next) {
    const segments = toSegments(session.elements);
    if (segments.some(segment => segment.type === 'image')) return next();
    const text = (session.stripped?.content ?? submissionText(segments)).trim();
    if (/^桥接(?:帮助|连接|日志|状态|取消|重发|新建会话|会话列表|切换会话|重命名会话|关闭会话|记录|重开会话)(?:\s|$)/.test(text))
      return '命令已精简，请发送 /help 查看。';
    const match = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/i.exec(text);
    if (!match) return next();
    const command = this.items.get(match[1].toLowerCase());
    if (!command) return '没有这个命令：' + match[1] + '。/help 查看常用命令。';
    const value = match[2]?.trim();
    if (value && (!command.definition.includes('[') || (command.definition.includes(':string') && /\s/.test(value))))
      return '用法：' + command.definition.replace(/:string|:text/g, '');
    try { return await command.handler({ session }, value); }
    catch (err) { return textMessage(safeReason(err.message)); }
  }
}
module.exports = { CommandRegistry };
