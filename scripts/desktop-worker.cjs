'use strict';

// Dependency injection is intentional: only the authorized desktop executor
// provides read_thread / send_message_to_thread. No protected-pipe client lives here.
function decode(result) {
  if (result?.isError) throw Error(result.content?.find(item => item.type === 'text')?.text || '客户端工具失败');
  if (result?.thread && result?.turns) return result;
  for (const item of result?.content || []) {
    if (item.type !== 'text') continue;
    try { return JSON.parse(item.text); } catch {}
  }
  throw Error('客户端工具没有返回可识别的 JSON');
}
function checkSnapshot(snapshot, threadId) {
  if (snapshot.thread?.id !== threadId || snapshot.thread?.kind !== 'chatgpt' || !Array.isArray(snapshot.turns))
    throw Error('执行器必须绑定指定的 ChatGPT 普通聊天');
  if (!snapshot.thread.status?.type) throw Error('客户端没有提供生成状态');
}
function findReply(snapshot, job, checkpoint) {
  checkSnapshot(snapshot, job.threadId);
  const boundary = checkpoint.baseline.length ? snapshot.turns.findIndex(turn => turn.id === checkpoint.baseline[0]) : snapshot.turns.length;
  if (boundary < 0) throw Error('本轮历史边界已丢失，请在客户端检查，任务不会自动重发');
  const newer = snapshot.turns.slice(0, boundary);
  if (!newer.length) return null;
  if (newer.length !== 1) throw Error('客户端出现其他用户轮次，无法安全关联本轮回复');
  const turn = newer[0];
  const user = turn.items?.find(item => item.type === 'userMessage');
  if (!user || user.content?.some(item => item.truncated)) throw Error('客户端用户消息缺失或被截断');
  const text = user.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (text !== job.text.trim() || (checkpoint.userMessageId && user.id !== checkpoint.userMessageId))
    throw Error('客户端最新用户消息与本任务不匹配');
  const agents = turn.items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim());
  if (agents.some(item => item.truncated)) throw Error('客户端回复被工具截断，未回传不完整内容');
  if (snapshot.thread.status.type === 'systemError' || turn.error) throw Error('客户端本轮生成失败');
  return { userMessageId: user.id, complete: snapshot.thread.status.type === 'idle' && turn.status === 'completed' && agents.length > 0,
    text: agents.map(item => item.text).join('\n\n'), assistantMessageIds: agents.map(item => item.id) };
}

async function workOne({ api, readThread, sendMessage, sleep, now = () => Date.now(), timeoutMs = 240000 }) {
  const { job } = await api('/state');
  if (!job) return { idle: true };
  let checkpoint = job.checkpoint;
  const read = async () => {
    const snapshot = decode(await readThread({ threadId: job.threadId, turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 }));
    checkSnapshot(snapshot, job.threadId);
    return snapshot;
  };
  const save = async next => {
    await api('/checkpoint', { id: job.id, threadId: job.threadId, expectedPhase: checkpoint?.phase || null, checkpoint: next });
    checkpoint = next;
  };
  try {
    if (!checkpoint) {
      const snapshot = await read();
      if (snapshot.thread.status.type !== 'idle') throw Error('客户端聊天仍在生成，请等它完成后发送下一条');
      await save({ phase: 'prepared', baseline: snapshot.turns.map(turn => turn.id) });
    }
    if (checkpoint.phase === 'prepared') {
      // Persist before dispatch. A restart after this point only reads; it never
      // retries a send whose acknowledgement might have been lost.
      await save({ ...checkpoint, phase: 'dispatching' });
      const accepted = decode(await sendMessage({ threadId: job.threadId, prompt: job.text }));
      if (accepted.threadId !== job.threadId) throw Error('客户端提交确认的聊天 ID 不匹配');
    }
    const started = now(); let stable = null;
    while (now() - started < timeoutMs) {
      const state = await api('/state');
      if (state.job?.id !== job.id) return { id: job.id, abandoned: true };
      const reply = findReply(await read(), job, checkpoint);
      if (reply && checkpoint.phase !== 'submitted') await save({ ...checkpoint, phase: 'submitted', userMessageId: reply.userMessageId });
      if (reply?.complete) {
        const key = JSON.stringify(reply);
        if (key === stable) {
          const result = { id: job.id, threadId: job.threadId, userMessageId: reply.userMessageId,
            assistantMessageIds: reply.assistantMessageIds, text: reply.text };
          await api('/result', result);
          return result;
        }
        stable = key;
      } else stable = null;
      await sleep(2000);
    }
    throw Error('等待客户端本轮回复超时；消息可能已提交，本任务不会自动重发');
  } catch (err) {
    await api('/failure', { id: job.id, threadId: job.threadId, message: err.message }).catch(() => {});
    throw err;
  }
}
module.exports = { decode, findReply, workOne };
