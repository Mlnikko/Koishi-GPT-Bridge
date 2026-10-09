'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebBridge } = require('./bridge/web-bridge.cjs');
const { Conversations } = require('./core/conversations.cjs');
const { Preferences } = require('./core/preferences.cjs');
const { JobQueue } = require('./core/queue.cjs');
const { normalizeConfig } = require('./core/config.cjs');
const { toSegments, sessionSegments, submissionText, imagesOf } = require('./core/message.cjs');
const { toMessages } = require('./lib/reply.cjs');
const { textMessage, safeReason } = require('./lib/feedback.cjs');
const { downloadImage } = require('./lib/image.cjs');
const { version } = require('../package.json');

exports.name = 'codex-image-local';
exports.apply = (ctx, config) => {
  config = normalizeConfig(config, path.join(__dirname, '..', 'data'));
  // `dataDir` only exists so tests and relocated installs can point the state
  // somewhere else; production uses the project's own data directory. `src/` is
  // one level down from the project root, hence the `..`.
  const { dataDir: root, maxTextChars, maxReplyChars, maxInputImages,
    sendTimeoutMs, maxInputBytes, replyTimeoutMs } = config;
  // There is exactly one backend: the already-signed-in ChatGPT web page driven
  // by the local extension. Nothing here spawns an external CLI or needs API keys.
  const sessions = new Map(), locks = new Set();
  const chats = new Conversations(path.join(root, 'conversations.json'));
  const preferences = new Preferences(path.join(root, 'preferences.json'), config.notifyProgress !== false);
  const web = new WebBridge({ root, port: config.webBridgePort ?? 5141,
    timeoutMs: replyTimeoutMs, pluginVersion: version });
  const busy = id => q.jobs.some(j => j.sessionId === id && ['queued', 'running'].includes(j.status));
  const labels = { queued: '排队中', running: 'ChatGPT 网页处理中', ready: '回复已取回', failed: '处理失败', cancelled: '已取消', interrupted: '服务重启，状态待确认' };
  const q = new JobQueue(path.join(root, 'jobs'), (j, signal, onThread) => {
    const chat = j.sessionId && chats.get(j.sessionId, j.owner, j.conversation);
    if (j.sessionId && !chat) throw Error('会话已关闭或不存在');
    // The QQ adapter keeps passive reply IDs for 298 seconds. Include queue and
    // download time, and reserve 15 seconds to stop the page plus time to reply.
    const session = sessions.get(j.id);
    const remaining = session ? session.timestamp + 270000 - Date.now() : web.timeoutMs;
    if (remaining <= 0) throw Object.assign(Error('消息等待过久，QQ 回复窗口即将到期；本次未提交网页，请重新发送。'), { code: 'reply_expired' });
    return web.run(j, {
      threadId: chat?.webThreadId, signal,
      timeoutMs: Math.max(1, Math.min(web.timeoutMs, remaining)),
      onThread: id => { if (chat) chats.bindWeb(chat, id); onThread(id); },
      onProgress: phase => { if (j.progress !== phase) { j.progress = phase; q.save(j); } },
    }).catch(err => {
      // 绑定的网页会话已经打不开（在 ChatGPT 里被删除、链接失效）时解绑：
      // 用户默认一直在同一个会话里，不会自己去换，所以必须能自愈 —— 否则一个
      // 失效编号会让他之后每一条消息都失败。下一条消息会因此开一个新的网页会话。
      if (err.code === 'thread_gone' && chat?.webThreadId) chats.unbindWeb(chat);
      throw err;
    });
  }, async j => {
    const session = sessions.get(j.id);
    if (j.status !== 'running') sessions.delete(j.id);
    if (!session) return;
    if (j.status === 'ready') {
      const message = await deliver(j, session);
      if (message) await send(session, message).catch(() => {});
    }
    else if (j.status === 'failed') {
      try { await send(session, textMessage(`任务 ${j.id} 失败：${safeReason(j.error)}`)); j.feedbackDelivery = 'sent'; }
      catch (err) {
        j.feedbackDelivery = 'failed'; j.deliveryError = String(err.message).slice(0, 300);
        try { ctx.logger('codex-image-local').warn(`任务 ${j.id} 的失败反馈未送达，请使用「/status ${j.id}」查询。`); } catch {}
      }
      q.save(j);
    }
  }, { maxImages: maxInputImages, maxChars: maxTextChars });
  const fresh = s => Date.now() - s.timestamp < 298000;
  const send = async (s, content) => {
    let timer;
    try {
      const ids = await Promise.race([
        Promise.resolve().then(() => s.send(content)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('QQ 发送确认超时，送达状态不确定')), sendTimeoutMs); }),
      ]);
      if (!ids?.length) throw new Error('QQ 未确认发送成功');
    } finally { clearTimeout(timer); }
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
  const notifications = s => preferences.enabled(s.userId, conversation(s));
  const imagesIn = j => imagesOf(j.input);
  const status = j => `任务 ${j.id}：${labels[j.status] || j.status}，已等待 ${Math.floor((Date.now()-j.createdAt)/1000)} 秒。`
    + (j.progress && j.status === 'running' ? `\n${j.progress}` : '')
    + (j.sessionId ? `\n会话：${j.sessionId}` : '\n独立任务（不绑定网页会话）')
    + (imagesIn(j).length ? `\n参考图片：${imagesIn(j).length} 张` : '')
    + (j.status === 'ready' ? `\n回复发送：${j.delivery === 'sent' ? '成功' : j.delivery === 'failed' ? '失败' : '待发送'}（已确认 ${j.deliveryCursor || 0} 段）。可发送「/retry ${j.id}」。` : '')
    + (j.deliveryError ? `\n发送详情：${textMessage(j.deliveryError)}` : '')
    + (j.error ? `\n${textMessage(j.error)}` : '');
  // 回复按片段顺序发出：文本批次与图片交替，图片在回复里的位置不会丢。
  async function deliver(j, s) {
    if (locks.has(j.id)) return '正在发送，请稍候';
    if (j.status !== 'ready') return status(j);
    locks.add(j.id);
    try {
      // Freeze the plan so a config change or restart cannot shift the cursor.
      const messages = j.deliveryPlan || toMessages(j.output || [], { maxChars: maxTextChars, maxTotal: maxReplyChars }).messages;
      if (!messages.length) throw new Error('回复内容为空');
      if (j.delivery === 'sent') j.deliveryCursor = 0;
      j.deliveryPlan = messages; j.delivery = 'sending'; q.save(j);
      for (let index = j.deliveryCursor || 0; index < messages.length; index++) {
        if (!fresh(s)) throw Error('QQ 回复窗口已过期，请用「/retry」取回回复');
        const item = messages[index];
        // Image bytes are uploaded by the QQ adapter; local paths never leave the machine.
        if (item.type === 'image') {
          const bytes = fs.readFileSync(path.join(j.dir, `result-${item.asset}.png`));
          await send(s, `<img src="data:image/png;base64,${bytes.toString('base64')}"/>`);
        } else {
          await send(s, textMessage(item.text));
        }
        j.deliveryCursor = index + 1; q.save(j);
      }
      j.delivery = 'sent'; j.deliveredAt = Date.now(); delete j.deliveryError; q.save(j);
    } catch (err) {
      j.delivery = 'failed'; j.deliveryError = safeReason(err.message).slice(0, 300); q.save(j);
      return `任务 ${j.id} 的回复已取回，但 QQ 发送失败：${textMessage(j.deliveryError)}\n已确认 ${j.deliveryCursor || 0} 段；可发送「/retry ${j.id}」继续，未确认的一段可能重复。`;
    } finally { locks.delete(j.id); }
  }
  // 普通消息按原顺序转发；引用回复先附上有明确边界的引用内容，图片依次作为附件。
  async function forward(session) {
    let segments;
    try { segments = sessionSegments(session); }
    catch (err) { return textMessage(safeReason(err.message)); }
    if (!segments.length) return;
    const text = submissionText(segments);
    if (text.length > maxTextChars) return `文字最多 ${maxTextChars} 字，请缩短后重新发送。`;
    const sources = imagesOf(segments);
    if (sources.length > maxInputImages) return `一次最多发送 ${maxInputImages} 张图片，请减少后重新发送。`;
    // 默认就有一个持续会话：第一次发消息时自动建出来，之后所有消息都留在同一个
    // 网页会话里，所以「把刚才那张图改成蓝色」这类续聊不需要任何命令。
    // 会话数达到上限时 ensure 会抛错，必须在这里拦住 —— 它发生在下面那个 try 之外。
    let chat;
    try { chat = chats.ensure(session.userId, conversation(session)); }
    catch (err) { return textMessage(safeReason(err.message)); }
    const duplicate = session.messageId && q.jobs.find(j => j.owner === session.userId && j.conversation === conversation(session) && j.messageId === session.messageId);
    if (duplicate) return notifications(session) ? status(duplicate) : undefined;
    if (busy(chat.id)) return '当前会话仍在处理上一条消息，请等待完成，或发送「/stop」停止后再试。';
    let staging;
    try {
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-input-'));
      const prepared = [];
      for (const segment of segments) {
        if (segment.type === 'text') { prepared.push(segment); continue; }
        const image = await downloadImage(segment.source, staging, { maxBytes: maxInputBytes });
        prepared.push({ type: 'image', file: image.file, ext: image.ext, mime: image.mime, size: image.size });
      }
      if (!chats.get(chat.id, session.userId, conversation(session))) throw Error('会话已关闭，请重新发送消息');
      const { job, duplicate: again } = q.enqueue({ owner: session.userId, conversation: conversation(session),
        messageId: session.messageId, sessionId: chat.id, segments: prepared });
      if (again) return notifications(session) ? status(job) : undefined;
      sessions.set(job.id, session);
      const reference = imagesIn(job).length ? `（含 ${imagesIn(job).length} 张图片）` : '';
      try { if (notifications(session)) await send(session, textMessage(`已接收 ${job.id}${reference}，正在送往 ChatGPT。\n会话：${chat.name}（${job.sessionId}）\n/status 查看进度，/stop 停止。`)); }
      catch { job.deliveryError = '接收确认未送达'; q.save(job); }
      void q.pump();
    }
    catch (err) { return textMessage(safeReason(err.message)); }
    finally { if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch {} } }
  }
  const scope = ctx.intersect(authorized);
  const commands = [];
  const command = (definition, description) => ({ action(handler) {
    commands.push({ definition, description, handler, name: definition.split(' ')[0] });
  } });
  const help = () => textMessage('直接发文字、图片或引用即可对话；群聊需 @ 机器人。\n'
    + commands.map(c => `${c.definition.replace(/:string|:text/g, '')}：${c.description}`).join('\n')
    + '\n方括号参数可省略；任务默认选当前会话最近一条。');
  const logs = (session, value) => {
    const option = value?.trim().toLowerCase();
    if (option) {
      if (!['on', 'off', '开启', '关闭', '开', '关'].includes(option)) return '用法：/logs [on|off]';
      try { preferences.set(session.userId, conversation(session), ['on', '开启', '开'].includes(option)); }
      catch { return '通知设置保存失败，请稍后重试。'; }
    }
    return `过程通知已${notifications(session) ? '开启' : '关闭，仅接收最终回复或失败原因'}。`;
  };
  const manage = fn => ({ session }, ...args) => {
    try { return textMessage(fn(session.userId, conversation(session), ...args)); }
    catch (err) { return textMessage(safeReason(err.message)); }
  };
  const currentJob = (session, id) => q.find(id, session.userId, conversation(session),
    chats.current(session.userId, conversation(session))?.id);
  command('/help', '帮助').action(help);
  command('/new [name:text]', '开启新对话').action(manage((owner, chat, name) => {
    const s = chats.create(owner, chat, name);
    return `已开启：${s.name}（${s.id}）。旧会话保留，可用 /chat 切回。`;
  }));
  command('/chat [id:string]', '会话列表；带编号切换').action(manage((owner, chat, id) => {
    if (id) {
      const s = chats.select(id, owner, chat); return `已切换：${s.name}（${s.id}）`;
    }
    const current = chats.current(owner, chat);
    const list = chats.list(owner, chat);
    return `当前：${current ? current.name + '（' + current.id + '）' : '暂无（发消息自动创建）'}\n`
      + (list.map(s => `${s.id} ${s.name}${s.id === current?.id ? ' [当前]' : ''}${busy(s.id) ? ' [处理中]' : ''}`).join('\n') || '暂无会话');
  }));
  command('/close [id:string]', '关闭当前或指定会话').action(manage((owner, chat, id) => {
    const s = chats.get(id || chats.current(owner, chat)?.id, owner, chat);
    if (!s) throw Error('未找到你的会话');
    if (busy(s.id)) throw Error('该会话仍在处理消息，请等待完成或先用 /stop 取消');
    chats.close(s.id, owner, chat); return `已关闭：${s.name}（${s.id}）。历史回复可用 /retry 任务编号取回。`;
  }));
  command('/status [id:string]', '连接与任务状态').action(async ({ session }, id) => {
    const j = currentJob(session, id);
    if (id) return j ? status(j) : '未找到你的任务';
    let connection;
    try {
      await web.ready;
      const health = web.health();
      connection = `桥接 ${health.pluginVersion}；浏览器${health.online ? '已连接' : '未连接，请检查 Chrome 扩展'}`;
    } catch { connection = '本机桥接未启动，请检查端口并重启实例'; }
    return connection + '\n' + (j ? status(j) : '当前会话暂无任务');
  });
  command('/stop [id:string]', '停止任务').action(({ session }, id) => {
    const j = currentJob(session, id);
    if (!j) return '未找到你的任务';
    const result = q.cancel(j);
    if (j.status === 'cancelled') sessions.delete(j.id);
    return result;
  });
  command('/retry [id:string]', '重发已取回的回复').action(({ session }, id) => {
    const j = currentJob(session, id); return j ? deliver(j, session) : '未找到你的任务';
  });
  command('/logs [mode:string]', '过程通知 on/off').action(({ session }, mode) => logs(session, mode));
  // Route exact slash commands ourselves: Koishi strips a leading slash from
  // command definitions, which would register bare words and collide with help.
  // Keep one authorized registry for routing and help, regardless of ctx prefix.
  scope.middleware((session, next) => {
    const segments = toSegments(session.elements);
    if (segments.some(s => s.type === 'image')) return next();
    const text = (session.stripped?.content ?? submissionText(segments)).trim();
    if (/^桥接(?:帮助|连接|日志|状态|取消|重发|新建会话|会话列表|切换会话|重命名会话|关闭会话|记录|重开会话)(?:\s|$)/.test(text))
      return '命令已精简，请发送 /help 查看。';
    const match = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/i.exec(text);
    const selected = match && commands.find(c => c.name === match[1].toLowerCase());
    if (!selected) return next();
    const value = match[2]?.trim();
    if (value && (!selected.definition.includes('[') || (selected.definition.includes(':string') && /\s/.test(value))))
      return `用法：${selected.definition.replace(/:string|:text/g, '')}`;
    return selected.handler({ session }, value);
  }, true);
  // 兜底转发：注册在所有命令之后，所以命令优先，其余消息一律送去 ChatGPT。
  // 这就是「桥接」的全部：没有意图识别，也没有自然语言分类。
  scope.middleware((session, next) => next(() => forward(session)));
  // Optional retention: reference images and replies are kept forever unless
  // retentionDays is set, because the window is a policy choice, not a technical one.
  const { retentionDays } = config;
  if (retentionDays > 0) {
    const log = message => { try { ctx.logger('codex-image-local').info(message); } catch {} };
    const prune = () => { try { const removed = q.prune(retentionDays); if (removed) log(`已清理 ${removed} 个超过 ${retentionDays} 天的任务`); } catch {} };
    prune();
    ctx.setInterval(prune, 6 * 60 * 60 * 1000);
  }
  ctx.setInterval(async () => {
    const j = q.active?.job, s = j && sessions.get(j.id);
    if (!j || j.status !== 'running' || !s || j.progressNotified || !notifications(s) || Date.now()-j.startedAt < 60000 || !fresh(s)) return;
    j.progressNotified = true;
    await send(s, `任务 ${j.id} 仍在 ChatGPT 网页处理中，已等待 ${Math.floor((Date.now()-j.startedAt)/1000)} 秒。\n/status 查看进度，/retry 取回回复。`).catch(() => {});
  }, 10000);
  ctx.on('dispose', () => { q.close(); web?.close(); });
};
