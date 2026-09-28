'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebBridge } = require('./bridge/web-bridge.cjs');
const { NaturalRouter } = require('./core/natural.cjs');
const { Conversations } = require('./core/conversations.cjs');
const { JobQueue } = require('./core/queue.cjs');
const { textMessage } = require('./lib/feedback.cjs');
const { downloadImage, messageImages, messageText, MAX_INPUT_IMAGES } = require('./lib/image.cjs');
exports.name = 'codex-image-local';
exports.apply = (ctx, config) => {
  if (!config?.allowedUsers?.length) throw new Error('必须配置 allowedUsers');
  // `dataDir` only exists so tests and relocated installs can point the state
  // somewhere else; production uses the project's own data directory. `src/` is
  // one level down from the project root, hence the `..`.
  const root = config.dataDir || path.join(__dirname, '..', 'data');
  // There is exactly one backend: the already-signed-in ChatGPT web page driven
  // by the local extension. Nothing here spawns an external CLI or needs API keys.
  const web = new WebBridge({ root, port: config.webBridgePort ?? 5141 });
  const sessions = new Map(), locks = new Set();
  const chats = new Conversations(path.join(root, 'conversations.json'));
  const busy = id => q.jobs.some(j => j.sessionId === id && ['queued', 'running'].includes(j.status));
  const labels = { queued: '排队中', running: 'ChatGPT 网页处理中', ready: '图片已生成', failed: '生成失败', cancelled: '已取消', interrupted: '服务重启，状态待确认' };
  const q = new JobQueue(path.join(root, 'jobs'), (j, signal, onThread) => {
    const chat = j.sessionId && chats.get(j.sessionId, j.owner, j.conversation);
    if (j.sessionId && !chat) throw Error('画图会话已关闭或不存在');
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
      try { await send(session, textMessage(`画图 ${j.id} 失败：${j.error}`)); j.feedbackDelivery = 'sent'; }
      catch { j.feedbackDelivery = 'failed'; }
      q.save(j);
    }
    if (j.status !== 'running') sessions.delete(j.id);
  });
  const fresh = s => Date.now() - s.timestamp < 255000;
  const send = async (s, content) => {
    const ids = await s.send(content);
    if (!ids?.length) throw new Error('QQ 未确认发送成功');
  };
  const allowedUsers = new Set(config.allowedUsers);
  const authorized = s => s.platform === 'qq' && (allowedUsers.has('*') || allowedUsers.has(s.userId)) && s.isDirect;
  const conversation = s => `${s.platform}:${s.channelId}`;
  const status = j => `任务 ${j.id}：${labels[j.status] || j.status}，已等待 ${Math.floor((Date.now()-j.createdAt)/1000)} 秒。`
    + (j.progress && j.status === 'running' ? `\n${j.progress}` : '')
    + (j.sessionId ? `\n画图会话：${j.sessionId}` : '\n独立绘图任务')
    + (j.kind === 'image' ? `\n参考图片：${(j.inputImages || []).length} 张` : '')
    + (j.status === 'ready' ? `\n图片发送：${j.delivery === 'sent' ? '成功' : '待取回'}。可发送“取图 ${j.id}”。` : '')
    + (j.error ? `\n${textMessage(j.error)}` : '');
  async function deliver(j, s) {
    if (locks.has(j.id)) return '正在发送，请稍候';
    if (j.status !== 'ready') return status(j);
    locks.add(j.id);
    try {
      // Image bytes are uploaded by the QQ adapter; local paths never leave the machine.
      const bytes = fs.readFileSync(path.join(j.dir, 'result.png'));
      await send(s, `<img src="data:image/png;base64,${bytes.toString('base64')}"/>`);
      j.delivery = 'sent'; j.deliveredAt = Date.now(); delete j.deliveryError; q.save(j);
    } catch {
      j.delivery = 'failed'; j.deliveryError = 'QQ 图片发送失败，可发送取图重试'; q.save(j);
      return `任务 ${j.id} 已出图，但 QQ 发送失败。请发送“取图 ${j.id}”重试。`;
    } finally { locks.delete(j.id); }
  }
  const scope = ctx.intersect(authorized);
  const handlers = new Map(); let natural;
  const command = (definition, description) => ({ action(handler) {
    const name = definition.split(' ')[0];
    const wrapped = (argv, ...args) => { natural?.touch(argv.session); return handler(argv, ...args); };
    handlers.set(name, wrapped); return scope.command(definition, description).action(wrapped);
  } });
  async function draw(session, prompt, independent = false, images = [], staging = null) {
    try {
      const chat = !independent && chats.current(session.userId, conversation(session));
      const duplicate = q.jobs.find(j => j.owner === session.userId && j.conversation === conversation(session) && j.messageId === session.messageId);
      if (!duplicate && chat && busy(chat.id)) return '当前会话仍有绘图任务，请等待完成或先取消画图；也可新建会话';
      const { job, duplicate: again } = q.enqueue({ owner: session.userId, conversation: conversation(session),
        messageId: session.messageId, prompt, sessionId: chat?.id, inputImages: images });
      sessions.set(job.id, session);
      if (again) return status(job);
      const reference = job.kind === 'image' ? `（参考 ${job.inputImages.length} 张图片）` : '';
      try { await send(session, `已接收画图任务 ${job.id}（ChatGPT 网页）${reference}。${job.sessionId ? `会话：${job.sessionId}` : '独立绘图'}\n发送“画图状态”查看进度，“取消画图”停止，“取图”取回结果。`); }
      catch { job.deliveryError = '接收确认未送达'; q.save(job); }
      void q.pump();
    }
    catch (err) { return err.message; }
    finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
  }
  // QQ delivers pictures as `img`/`image` elements whose URL may be an http(s)
  // link, a data: payload, or a OneBot base64:// payload. Every form is fetched
  // through the guarded downloader; no local path from the message is ever read.
  const imageSources = session => messageImages(session.elements);
  async function handleImages(session, sources) {
    if (sources.length > MAX_INPUT_IMAGES) return `一次最多参考 ${MAX_INPUT_IMAGES} 张图片，请合并后再发送。`;
    const prompt = messageText(session.elements);
    if (prompt.length > 1500) return '文字要求最多 1500 字，请缩短后重新发送。';
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-input-'));
    const images = [];
    try {
      for (const source of sources) images.push(await downloadImage(source, staging, config.maxInputBytes ? { maxBytes: config.maxInputBytes } : {}));
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      return textMessage(`图片处理失败：${err.message}`);
    }
    return draw(session, prompt, false, images, staging);
  }
  // Registered before the drawing commands so a message that carries a picture is
  // always treated as a reference-image request, even when it also contains text.
  scope.middleware((session, next) => {
    const sources = imageSources(session);
    return sources.length ? handleImages(session, sources) : next();
  });
  command('画图 <prompt:text>', '在当前会话续画；未选会话时独立绘图').action(({ session }, prompt) => draw(session, prompt));
  command('独立画图 <prompt:text>', '不使用会话上下文绘图').action(({ session }, prompt) => draw(session, prompt, true));
  const manage = fn => ({ session }, ...args) => {
    try { return textMessage(fn(session.userId, conversation(session), ...args)); }
    catch (err) { return textMessage(err.message); }
  };
  command('新建画图会话 [name:text]', '新建并切换到独立的绘图会话').action(manage((owner, chat, name) => {
    const s = chats.create(owner, chat, name);
    return `已新建并切换：${s.name}（${s.id}）。\n发送“画图 提示词”开始；后续画图会保留本会话上下文。`;
  }));
  command('画图会话', '列出自己的会话及当前选择').action(manage((owner, chat) => {
    const current = chats.current(owner, chat);
    const list = chats.list(owner, chat);
    return `当前：${current ? current.name + '（' + current.id + '）' : '独立绘图模式'}\n`
      + (list.map(s => `${s.id} ${s.name}${s.id === current?.id ? ' [当前]' : ''}${busy(s.id) ? ' [处理中]' : ''}`).join('\n') || '暂无会话，发送“新建画图会话 名称”创建');
  }));
  command('切换画图会话 <id:string>', '切换到自己的指定会话').action(manage((owner, chat, id) => {
    const s = chats.select(id, owner, chat); return `已切换：${s.name}（${s.id}）`;
  }));
  command('重命名画图会话 <id:string> <name:text>', '修改会话名称').action(manage((owner, chat, id, name) => {
    const s = chats.rename(id, owner, chat, name); return `已重命名：${s.name}（${s.id}）`;
  }));
  command('关闭画图会话 [id:string]', '关闭指定或当前会话，保留历史图片').action(manage((owner, chat, id) => {
    const s = chats.get(id || chats.current(owner, chat)?.id, owner, chat);
    if (!s) throw Error('未找到你的画图会话');
    if (busy(s.id)) throw Error('该会话仍有绘图任务，请等待完成或先取消画图');
    chats.close(s.id, owner, chat); return `已关闭会话 ${s.id}，历史图片仍可通过“取图 任务编号”获取。`;
  }));
  command('会话画图记录 [id:string]', '查看指定或当前会话最近十条任务').action(manage((owner, chat, id) => {
    const s = chats.get(id || chats.current(owner, chat)?.id, owner, chat);
    if (!s) throw Error('未找到你的画图会话');
    const jobs = q.jobs.filter(j => j.owner === owner && j.conversation === chat && j.sessionId === s.id).slice(-10).reverse();
    return `${s.name}（${s.id}）\n` + (jobs.map(j => `${j.id} ${labels[j.status]} ${j.kind === 'image' ? `[参考图 ${(j.inputImages || []).length} 张] ` : ''}${j.prompt ? j.prompt.slice(0, 60) : '（纯图片）'}`).join('\n') || '暂无绘图任务');
  }));
  command('退出画图会话', '切回独立绘图模式，不关闭会话').action(manage((owner, chat) => {
    chats.leave(owner, chat); return '已切回独立绘图模式，原会话仍可切换回来';
  }));
  command('画图状态 [id:string]', '查看最近或指定画图任务').action(({ session }, id) => {
    const j = q.find(id, session.userId, conversation(session), chats.current(session.userId, conversation(session))?.id); return j ? status(j) : '未找到你的画图任务';
  });
  command('取消画图 [id:string]', '停止最近或指定画图任务').action(({ session }, id) => {
    const j = q.find(id, session.userId, conversation(session), chats.current(session.userId, conversation(session))?.id); return j ? q.cancel(j) : '未找到你的画图任务';
  });
  command('取图 [id:string]', '取回最近或指定任务的图片').action(({ session }, id) => {
    const j = q.find(id, session.userId, conversation(session), chats.current(session.userId, conversation(session))?.id); return j ? deliver(j, session) : '未找到你的画图任务';
  });
  if (config.naturalLanguage !== false) {
    natural = new NaturalRouter({
      file: path.join(root, 'intent-receipts.json'), authorized,
      // Image requests go straight to ChatGPT, which understands the semantics
      // itself; only management and ambiguous text reaches the classifier, and
      // that classifier is the same signed-in web page rather than a local CLI.
      directImage: true,
      classifier: (input, context, options) => web.classify(input, context, options),
      context: session => {
        const chat = conversation(session), owner = session.userId;
        const current = chats.current(owner, chat);
        const ownJobs = q.jobs.filter(j => j.owner === owner && j.conversation === chat).sort((a,b) => b.createdAt-a.createdAt);
        return {
          current: current?.id || '',
          sessions: chats.list(owner, chat).map(s => ({ id: s.id, name: s.name })),
          jobs: ownJobs.slice(0, 20).map(j => ({ id: j.id, status: j.status, sessionId: j.sessionId || '' })),
          latestJob: q.find(undefined, owner, chat, current?.id)?.id || '',
          hasImage: !!current && ownJobs.some(j => j.sessionId === current.id && j.status === 'ready'),
        };
      },
      dispatch: (name, session, args) => {
        if (!authorized(session) || !handlers.has(name)) throw Error('不支持此操作');
        return handlers.get(name)({ session }, ...args);
      },
    });
    // Deferred fallback runs only after ordinary command handlers decline the message.
    scope.middleware((session, next) => next(() => natural.handle(session)));
  }
  const notified = new Set();
  // Optional retention: reference images and results are kept forever unless
  // retentionDays is set, because the window is a policy choice, not a technical one.
  const retentionDays = Number(config.retentionDays) || 0;
  if (retentionDays > 0) {
    const log = message => { try { ctx.logger('codex-image-local').info(message); } catch {} };
    const prune = () => { try { const removed = q.prune(retentionDays); if (removed) log(`已清理 ${removed} 个超过 ${retentionDays} 天的任务`); } catch {} };
    prune();
    ctx.setInterval(prune, 6 * 60 * 60 * 1000);
  }
  ctx.setInterval(async () => {
    const j = q.active?.job, s = j && sessions.get(j.id);
    if (!j || !s || notified.has(j.id) || Date.now()-j.startedAt < 60000 || !fresh(s)) return;
    notified.add(j.id);
    await send(s, `画图 ${j.id} 仍在 ChatGPT 网页处理中，已等待 ${Math.floor((Date.now()-j.startedAt)/1000)} 秒。\n若稍后未自动收到图片，请发送“取图”。`).catch(() => {});
  }, 10000);
  ctx.on('dispose', () => { natural?.close(); q.close(); web?.close(); });
};
