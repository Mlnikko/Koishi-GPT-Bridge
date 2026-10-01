'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebBridge } = require('./bridge/web-bridge.cjs');
const { Conversations } = require('./core/conversations.cjs');
const { JobQueue } = require('./core/queue.cjs');
const { toSegments, submissionText } = require('./core/message.cjs');
const { toMessages } = require('./lib/reply.cjs');
const { textMessage } = require('./lib/feedback.cjs');
const { downloadImage, MAX_INPUT_IMAGES } = require('./lib/image.cjs');

exports.name = 'codex-image-local';
exports.apply = (ctx, config) => {
  if (!config?.allowedUsers?.length) throw new Error('必须配置 allowedUsers');
  // `dataDir` only exists so tests and relocated installs can point the state
  // somewhere else; production uses the project's own data directory. `src/` is
  // one level down from the project root, hence the `..`.
  const root = config.dataDir || path.join(__dirname, '..', 'data');
  const maxTextChars = Number(config.maxTextChars) || 1500;
  const maxReplyChars = Number(config.maxReplyChars) || 6000;
  const maxInputImages = Number(config.maxInputImages) || MAX_INPUT_IMAGES;
  // There is exactly one backend: the already-signed-in ChatGPT web page driven
  // by the local extension. Nothing here spawns an external CLI or needs API keys.
  const web = new WebBridge({ root, port: config.webBridgePort ?? 5141,
    timeoutMs: Number(config.replyTimeoutMs) || undefined });
  const sessions = new Map(), locks = new Set();
  const chats = new Conversations(path.join(root, 'conversations.json'));
  const busy = id => q.jobs.some(j => j.sessionId === id && ['queued', 'running'].includes(j.status));
  const labels = { queued: '排队中', running: 'ChatGPT 网页处理中', ready: '回复已取回', failed: '处理失败', cancelled: '已取消', interrupted: '服务重启，状态待确认' };
  const q = new JobQueue(path.join(root, 'jobs'), (j, signal, onThread) => {
    const chat = j.sessionId && chats.get(j.sessionId, j.owner, j.conversation);
    if (j.sessionId && !chat) throw Error('会话已关闭或不存在');
    return web.run(j, {
      threadId: chat?.webThreadId, signal,
      onThread: id => { if (chat) chats.bindWeb(chat, id); onThread(id); },
      onProgress: phase => { if (j.progress !== phase) { j.progress = phase; q.save(j); } },
    });
  }, async j => {
    const session = sessions.get(j.id);
    if (!session || !fresh(session)) return;
    if (j.status === 'ready') {
      const message = await deliver(j, session);
      if (message && fresh(session)) await send(session, message).catch(() => {});
    }
    else if (j.status === 'failed') {
      try { await send(session, textMessage(`任务 ${j.id} 失败：${j.error}`)); j.feedbackDelivery = 'sent'; }
      catch { j.feedbackDelivery = 'failed'; }
      q.save(j);
    }
    if (j.status !== 'running') sessions.delete(j.id);
  }, { maxImages: maxInputImages, maxChars: maxTextChars });
  const fresh = s => Date.now() - s.timestamp < 255000;
  const send = async (s, content) => {
    const ids = await s.send(content);
    if (!ids?.length) throw new Error('QQ 未确认发送成功');
  };
  const allowedUsers = new Set(config.allowedUsers);
  // Group access is opt-in and, once enabled, open to every member of the group.
  // Koishi already refuses to route a guild message at all unless the bot was
  // mentioned (`stripped.appel`), so mentioning is the whole gate on this side;
  // `allowedUsers` stays a private-chat concept and is deliberately not applied
  // to guilds, where the QQ openid is a group-scoped id.
  const groupChat = config.groupChat === true;
  const authorized = s => {
    if (s.platform !== 'qq') return false;
    if (s.isDirect) return allowedUsers.has('*') || allowedUsers.has(s.userId);
    return groupChat && !!s.stripped?.appel;
  };
  const conversation = s => `${s.platform}:${s.channelId}`;
  const imagesIn = j => (j.input || []).filter(segment => segment.type === 'image');
  const status = j => `任务 ${j.id}：${labels[j.status] || j.status}，已等待 ${Math.floor((Date.now()-j.createdAt)/1000)} 秒。`
    + (j.progress && j.status === 'running' ? `\n${j.progress}` : '')
    + (j.sessionId ? `\n会话：${j.sessionId}` : '\n独立任务（不绑定网页会话）')
    + (imagesIn(j).length ? `\n参考图片：${imagesIn(j).length} 张` : '')
    + (j.status === 'ready' ? `\n回复发送：${j.delivery === 'sent' ? '成功' : '待发送'}。可发送「桥接重发 ${j.id}」。` : '')
    + (j.error ? `\n${textMessage(j.error)}` : '');
  // 回复按片段顺序发出：文本批次与图片交替，图片在回复里的位置不会丢。
  async function deliver(j, s) {
    if (locks.has(j.id)) return '正在发送，请稍候';
    if (j.status !== 'ready') return status(j);
    locks.add(j.id);
    try {
      const { messages } = toMessages(j.output || [], { maxChars: maxTextChars, maxTotal: maxReplyChars });
      if (!messages.length) throw new Error('回复内容为空');
      for (const item of messages) {
        // Image bytes are uploaded by the QQ adapter; local paths never leave the machine.
        if (item.type === 'image') {
          const bytes = fs.readFileSync(path.join(j.dir, `result-${item.asset}.png`));
          await send(s, `<img src="data:image/png;base64,${bytes.toString('base64')}"/>`);
        } else {
          await send(s, textMessage(item.text));
        }
      }
      j.delivery = 'sent'; j.deliveredAt = Date.now(); delete j.deliveryError; q.save(j);
    } catch (err) {
      j.delivery = 'failed'; j.deliveryError = String(err.message).slice(0, 300); q.save(j);
      return `任务 ${j.id} 的回复已取回，但 QQ 发送失败：${textMessage(err.message)}\n可发送「桥接重发 ${j.id}」重试。`;
    } finally { locks.delete(j.id); }
  }
  // QQ 消息原样转发：文本按原顺序拼接，图片按原顺序下载后作为附件送去。
  // 除了下载图片，这里不做任何改写、不分类、不判断「用户是不是想做什么」。
  async function forward(session) {
    const segments = toSegments(session.elements);
    if (!segments.length) return;
    const text = submissionText(segments);
    if (text.length > maxTextChars) return `文字最多 ${maxTextChars} 字，请缩短后重新发送。`;
    const sources = segments.filter(segment => segment.type === 'image');
    if (sources.length > maxInputImages) return `一次最多发送 ${maxInputImages} 张图片，请减少后重新发送。`;
    const chat = chats.current(session.userId, conversation(session));
    const duplicate = q.jobs.find(j => j.owner === session.userId && j.conversation === conversation(session) && j.messageId === session.messageId);
    if (!duplicate && chat && busy(chat.id)) return '当前会话仍在处理上一条消息，请等待完成或先取消；也可以新建会话';
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-input-'));
    try {
      const prepared = [];
      for (const segment of segments) {
        if (segment.type === 'text') { prepared.push(segment); continue; }
        const image = await downloadImage(segment.source, staging, config.maxInputBytes ? { maxBytes: config.maxInputBytes } : {});
        prepared.push({ type: 'image', file: image.file, ext: image.ext, mime: image.mime, size: image.size });
      }
      const { job, duplicate: again } = q.enqueue({ owner: session.userId, conversation: conversation(session),
        messageId: session.messageId, sessionId: chat?.id, segments: prepared });
      sessions.set(job.id, session);
      if (again) return status(job);
      const reference = imagesIn(job).length ? `（含 ${imagesIn(job).length} 张图片）` : '';
      try { await send(session, `已接收 ${job.id}${reference}，正在送往 ChatGPT。${job.sessionId ? `\n会话：${job.sessionId}` : ''}\n发送「桥接状态」查看进度，「桥接取消」停止。`); }
      catch { job.deliveryError = '接收确认未送达'; q.save(job); }
      void q.pump();
    }
    catch (err) { return textMessage(err.message); }
    finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  const scope = ctx.intersect(authorized);
  const command = (definition, description) => ({ action(handler) {
    return scope.command(definition, description).action(handler);
  } });
  const manage = fn => ({ session }, ...args) => {
    try { return textMessage(fn(session.userId, conversation(session), ...args)); }
    catch (err) { return textMessage(err.message); }
  };
  const currentJob = (session, id) => q.find(id, session.userId, conversation(session),
    chats.current(session.userId, conversation(session))?.id);
  command('桥接状态 [id:string]', '查看最近或指定任务的进度').action(({ session }, id) => {
    const j = currentJob(session, id); return j ? status(j) : '未找到你的任务';
  });
  command('桥接取消 [id:string]', '停止最近或指定任务').action(({ session }, id) => {
    const j = currentJob(session, id); return j ? q.cancel(j) : '未找到你的任务';
  });
  command('桥接重发 [id:string]', '重新发送最近或指定任务的回复').action(({ session }, id) => {
    const j = currentJob(session, id); return j ? deliver(j, session) : '未找到你的任务';
  });
  command('桥接新建会话 [name:text]', '新建并切换到一个独立的网页会话').action(manage((owner, chat, name) => {
    const s = chats.create(owner, chat, name);
    return `已新建并切换：${s.name}（${s.id}）。\n之后的消息会保留在本会话的上下文里。`;
  }));
  command('桥接会话列表', '列出自己的会话及当前选择').action(manage((owner, chat) => {
    const current = chats.current(owner, chat);
    const list = chats.list(owner, chat);
    return `当前：${current ? current.name + '（' + current.id + '）' : '未绑定会话（每条消息独立）'}\n`
      + (list.map(s => `${s.id} ${s.name}${s.id === current?.id ? ' [当前]' : ''}${busy(s.id) ? ' [处理中]' : ''}`).join('\n') || '暂无会话，发送「桥接新建会话 名称」创建');
  }));
  command('桥接切换会话 <id:string>', '切换到自己的指定会话').action(manage((owner, chat, id) => {
    const s = chats.select(id, owner, chat); return `已切换：${s.name}（${s.id}）`;
  }));
  command('桥接重命名会话 <id:string> <name:text>', '修改会话名称').action(manage((owner, chat, id, name) => {
    const s = chats.rename(id, owner, chat, name); return `已重命名：${s.name}（${s.id}）`;
  }));
  command('桥接关闭会话 [id:string]', '关闭指定或当前会话，保留历史记录').action(manage((owner, chat, id) => {
    const s = chats.get(id || chats.current(owner, chat)?.id, owner, chat);
    if (!s) throw Error('未找到你的会话');
    if (busy(s.id)) throw Error('该会话仍在处理消息，请等待完成或先取消');
    chats.close(s.id, owner, chat); return `已关闭会话 ${s.id}，历史记录仍可通过「桥接重发 任务编号」取回。`;
  }));
  command('桥接记录 [id:string]', '查看指定或当前会话最近十条任务').action(manage((owner, chat, id) => {
    const s = chats.get(id || chats.current(owner, chat)?.id, owner, chat);
    if (!s) throw Error('未找到你的会话');
    const jobs = q.jobs.filter(j => j.owner === owner && j.conversation === chat && j.sessionId === s.id).slice(-10).reverse();
    return `${s.name}（${s.id}）\n` + (jobs.map(j => `${j.id} ${labels[j.status]} ${imagesIn(j).length ? `[图片 ${imagesIn(j).length} 张] ` : ''}${submissionText(j.input).slice(0, 60) || '（纯图片）'}`).join('\n') || '暂无任务');
  }));
  command('桥接退出会话', '切回不绑定会话的模式，不关闭会话').action(manage((owner, chat) => {
    chats.leave(owner, chat); return '已切回独立模式，原会话仍可切换回来';
  }));
  // 兜底转发：注册在所有命令之后，所以命令优先，其余消息一律送去 ChatGPT。
  // 这就是「桥接」的全部：没有意图识别，也没有自然语言分类。
  scope.middleware((session, next) => next(() => forward(session)));
  // Optional retention: reference images and replies are kept forever unless
  // retentionDays is set, because the window is a policy choice, not a technical one.
  const retentionDays = Number(config.retentionDays) || 0;
  if (retentionDays > 0) {
    const log = message => { try { ctx.logger('codex-image-local').info(message); } catch {} };
    const prune = () => { try { const removed = q.prune(retentionDays); if (removed) log(`已清理 ${removed} 个超过 ${retentionDays} 天的任务`); } catch {} };
    prune();
    ctx.setInterval(prune, 6 * 60 * 60 * 1000);
  }
  const notified = new Set();
  ctx.setInterval(async () => {
    const j = q.active?.job, s = j && sessions.get(j.id);
    if (!j || !s || notified.has(j.id) || Date.now()-j.startedAt < 60000 || !fresh(s)) return;
    notified.add(j.id);
    await send(s, `任务 ${j.id} 仍在 ChatGPT 网页处理中，已等待 ${Math.floor((Date.now()-j.startedAt)/1000)} 秒。\n若稍后没有收到回复，请发送「桥接重发」。`).catch(() => {});
  }, 10000);
  ctx.on('dispose', () => { q.close(); web?.close(); });
};
