'use strict';
const { modeOf, contextOf } = require('../core/modes.cjs');

// The application owns the reply deadline and durable context binding. The
// transports know HTTP/browser protocols, never QQ commands or current mode.
function createRunner({ chats, web, local, replyTimeoutMs, getSession, onProgress }) {
  return async (job, signal, onThread) => {
    const chat = job.sessionId && chats.get(job.sessionId, job.owner, job.conversation);
    if (job.sessionId && !chat) throw Error('会话已关闭或不存在');
    const mode = modeOf(job), context = contextOf(chat, mode);
    if (chat && modeOf(chat) !== mode) throw Error('会话模式已变化，任务未提交');
    const session = getSession(job.id);
    const remaining = session ? session.timestamp + 270000 - Date.now() : replyTimeoutMs;
    if (remaining <= 0) throw Object.assign(Error('消息等待过久，QQ 回复窗口即将到期；本次未提交' + (mode === 'local' ? '本地模型' : '网页') + '，请重新发送。'), { code: 'reply_expired' });
    const options = { signal, timeoutMs: Math.max(1, Math.min(replyTimeoutMs, remaining)),
      onProgress: phase => onProgress(job, phase) };
    if (mode === 'local') {
      if (context.model !== job.model) throw Error('本地会话配置已变化，任务未提交');
      return local.run(job, options);
    }
    try {
      return await web.run(job, { ...options, threadId: context.webThreadId,
        onThread: id => { if (chat) chats.bindWeb(chat, id, mode); onThread(id); } });
    } catch (err) {
      if (err.code === 'thread_gone' && contextOf(chat, mode).webThreadId) chats.unbindWeb(chat, mode);
      throw err;
    }
  };
}
module.exports = { createRunner };
