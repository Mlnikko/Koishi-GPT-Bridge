'use strict';
const { modeOf, contextOf, modeLabel } = require('../core/modes.cjs');
const { reasoningLabel } = require('../core/reasoning.cjs');
function registerSessions({ command, manage, chats, busy }) {
  command('/new [名称:text]', '开启新对话；名称默认使用用户名').action(manage((owner, chat, name, defaultName) => {
    const previous = chats.current(owner, chat);
    const s = chats.create(owner, chat, name || defaultName, { from: previous });
    return `已开启：${s.name}（${s.id}）。旧会话保留，可用 /chat 切回。`
      + `\n当前模式：${modeLabel(s)}。`
      + (contextOf(s, 'local').preset ? `\n沿用本地预设：${contextOf(s, 'local').preset}。` : '')
      + (contextOf(s).skill ? `\n沿用技能：${contextOf(s).skill}。` : '')
      + (s.imagePrompt ? `\n沿用图片模板：${s.imagePrompt}，/draw 角色名 生成图片。` : '');
  }));
  command('/chat [会话编号:string]', '会话列表；带编号切换').action(manage((owner, chat, id) => {
    if (id) {
      const s = chats.select(id, owner, chat); return `已切换：${s.name}（${s.id}）`;
    }
    const current = chats.current(owner, chat);
    const list = chats.list(owner, chat);
    return `当前：${current ? current.name + '（' + current.id + '）' : '暂无（发消息自动创建）'}\n`
      + (list.map(s => `${s.id} ${s.name}${s.id === current?.id ? ' [当前]' : ''} [${modeLabel(s)}]${busy(s.id) ? ' [处理中]' : ''}${modeOf(s) === 'local' ? ' [LM Studio：' + contextOf(s, 'local').model + ']' : ''}${contextOf(s, 'local').preset ? ' [本地预设：' + contextOf(s, 'local').preset + ']' : ''}${contextOf(s).skill ? ' [技能：' + contextOf(s).skill + ']' : ''}${contextOf(s).reasoningEffort && modeOf(s) !== 'local' ? ' [推理：' + reasoningLabel(contextOf(s).reasoningEffort) + ']' : ''}`).join('\n') || '暂无会话');
  }));
  command('/rename [名称:text]', '重命名当前会话；最多 40 字').action(manage((owner, chat, name) => {
    if (!name?.trim()) throw Error('用法：/rename 新名称');
    const current = chats.current(owner, chat);
    if (!current) throw Error('暂无当前会话，请先发消息或用 /new 创建');
    const s = chats.rename(current.id, owner, chat, name);
    return `已重命名：${s.name}（${s.id}）`;
  }));
  command('/close [会话编号:string]', '关闭当前或指定会话').action(manage((owner, chat, id) => {
    const s = chats.get(id || chats.current(owner, chat)?.id, owner, chat);
    if (!s) throw Error('未找到你的会话');
    if (busy(s.id)) throw Error('该会话仍在处理消息，请等待完成或先用 /stop 取消');
    chats.close(s.id, owner, chat); return `已关闭：${s.name}（${s.id}）。历史回复可用 /retry 任务编号取回。`;
  }));
}
module.exports = { registerSessions };
