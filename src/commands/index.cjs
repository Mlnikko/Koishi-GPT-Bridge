'use strict';
const { CommandRegistry } = require('./registry.cjs');
const { registerSessions } = require('./sessions.cjs');
const { registerModes } = require('./modes.cjs');
const { registerSkills } = require('./skills.cjs');
const { registerPresets } = require('./presets.cjs');
const { registerTemplates } = require('./templates.cjs');
const { conversation, defaultChatName } = require('../app/session-scope.cjs');
const { textMessage } = require('../lib/feedback.cjs');

// One command table serves routing, validation and help. Daily help stays short;
// library management and compatibility commands remain available via /help all.
const groups = {
  '/help': 'common', '/mode': 'common', '/new': 'common', '/chat': 'common', '/status': 'common', '/stop': 'common',
  '/skill': ['work', 'local'], '/model': 'local', '/preset': 'local', '/backend': 'legacy',
};
function createCommands({ bot, chats, skills, presets, imagePrompts, config }) {
  const registry = new CommandRegistry();
  const command = (definition, description) => registry.command(definition, description, groups[definition.split(' ')[0]] || 'advanced');
  const manage = fn => ({ session }, value) => textMessage(fn(session.userId, conversation(session), value, defaultChatName(session)));
  const context = { command, manage, bot, chats, skills, presets, imagePrompts, maxTextChars: config.maxTextChars,
    busy: bot.busy, currentJob: bot.currentJob, duplicateMessage: bot.duplicateMessage,
    notifications: bot.notifications, status: bot.status, forward: bot.forward };
  command('/help [板块:string]', '常用帮助；all 查看全部').action(({ session }, topic) => registry.help(session, bot.currentChat(session), topic));
  registerSessions(context);
  registerModes(context);
  registerSkills(context);
  registerPresets(context);
  registerTemplates(context);
  command('/status [任务编号:string]', '连接与任务状态').action(({ session }, id) => bot.connectionStatus(session, id));
  command('/stop [任务编号:string]', '停止当前或指定任务').action(({ session }, id) => bot.stop(session, id));
  command('/retry [任务编号:string]', '重发已取回的回复，不重新生成').action(({ session }, id) => bot.retry(session, id));
  command('/logs [on|off:string]', '过程通知 on/off').action(({ session }, mode) => bot.logs(session, mode));
  return registry;
}
module.exports = { createCommands };
