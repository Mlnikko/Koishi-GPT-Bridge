'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebBridge } = require('./bridge/web-bridge.cjs');
const { LMStudioBridge } = require('./bridge/lmstudio-bridge.cjs');
const { QQDelivery, isFresh } = require('./bridge/qq-delivery.cjs');
const { Conversations } = require('./core/conversations.cjs');
const { Preferences } = require('./core/preferences.cjs');
const { Presets } = require('./core/presets.cjs');
const { normalizeReasoning, reasoningLabel, REASONING_USAGE } = require('./core/reasoning.cjs');
const { JobQueue } = require('./core/queue.cjs');
const { normalizeConfig } = require('./core/config.cjs');
const { toSegments, sessionSegments, submissionText, imagesOf } = require('./core/message.cjs');
const { splitText } = require('./lib/reply.cjs');
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
    sendTimeoutMs, mediaSendTimeoutMs, maxInputBytes, replyTimeoutMs } = config;
  // The web backend remains the default; neither backend spawns a local CLI.
  const sessions = new Map();
  const chats = new Conversations(path.join(root, 'conversations.json'));
  const presets = new Presets(path.join(root, 'presets'));
  const preferences = new Preferences(path.join(root, 'preferences.json'), config.notifyProgress !== false);
  const web = new WebBridge({ root, port: config.webBridgePort ?? 5141,
    timeoutMs: replyTimeoutMs, pluginVersion: version });
  const local = new LMStudioBridge({ root, baseUrl: config.lmStudioBaseUrl, apiKey: config.lmStudioApiKey,
    model: config.lmStudioModel, maxTokens: config.lmStudioMaxTokens, historyTurns: config.lmStudioHistoryTurns,
    historyChars: config.lmStudioHistoryChars, historyImages: config.lmStudioHistoryImages,
    historyImageBytes: config.lmStudioHistoryImageBytes, maxImageBytes: maxInputBytes, timeoutMs: replyTimeoutMs });
  const backendLabel = backend => backend === 'lmstudio' ? 'LM Studio' : 'ChatGPT 网页';
  const busy = id => q.busy(id);
  const labels = { queued: '排队中', running: 'ChatGPT 网页处理中', ready: '回复已取回', failed: '处理失败', cancelled: '已取消', interrupted: '服务重启，状态待确认' };
  const q = new JobQueue(path.join(root, 'jobs'), (j, signal, onThread) => {
    const chat = j.sessionId && chats.get(j.sessionId, j.owner, j.conversation);
    if (j.sessionId && !chat) throw Error('会话已关闭或不存在');
    if (j.backend === 'lmstudio') {
      if (chat?.backend !== 'lmstudio' || chat.lmStudioModel !== j.model) throw Error('本地会话配置已变化，任务未提交');
      const session = sessions.get(j.id);
      const remaining = session ? session.timestamp + 270000 - Date.now() : replyTimeoutMs;
      if (remaining <= 0) throw Error('消息等待过久，本地模型任务未提交，请重新发送');
      return local.run(j, { signal, timeoutMs: Math.min(replyTimeoutMs, remaining),
        onProgress: phase => { if (j.progress !== phase) { j.progress = phase; q.save(j); } } });
    }
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
  const fresh = isFresh;
  const send = (...args) => delivery.send(...args);
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
  const status = j => `任务 ${j.id}：${j.status === 'running' ? backendLabel(j.backend) + '处理中' : labels[j.status] || j.status}，已等待 ${Math.floor((Date.now()-j.createdAt)/1000)} 秒。`
    + (j.progress && j.status === 'running' ? `\n${j.progress}` : '')
    + (j.sessionId ? `\n会话：${j.sessionId}` : '\n独立任务（不绑定网页会话）')
    + (j.backend === 'lmstudio' ? `\n本地模型：${j.model}` : '')
    + (j.preset ? `\n本地预设：${j.preset.name}（版本 ${j.preset.revision.slice(0, 8)}）` : '')
    + (j.reasoningEffort ? `\n推理程度：${reasoningLabel(j.reasoningEffort)}` : '')
    + (imagesIn(j).length ? `\n参考图片：${imagesIn(j).length} 张` : '')
    + (j.status === 'ready' ? `\n回复发送：${j.delivery === 'sent' ? '成功' : j.delivery === 'failed' ? '失败' : '待发送'}（已确认 ${j.deliveryCursor || 0} 段）。可发送「/retry ${j.id}」。` : '')
    + (j.deliveryError ? `\n发送详情：${textMessage(j.deliveryError)}` : '')
    + (j.error ? `\n${textMessage(j.error)}` : '');
  const delivery = new QQDelivery({ save: job => q.save(job), status, maxChars: maxTextChars,
    maxTotal: maxReplyChars, sendTimeoutMs, mediaSendTimeoutMs });
  const deliver = (job, session) => delivery.deliver(job, session);
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
    const duplicate = q.duplicate(session.userId, conversation(session), session.messageId);
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
      const preset = chat.backend === 'lmstudio' && chat.lmStudioPreset ? presets.read(chat.lmStudioPreset) : undefined;
      if (preset && preset.prompt.length + text.length > config.lmStudioHistoryChars)
        throw Error('预设和本次消息超出本地上下文字数上限，请缩短预设或消息，或调整 lmStudioHistoryChars');
      const { job, duplicate: again } = q.enqueue({ owner: session.userId, conversation: conversation(session),
        messageId: session.messageId, sessionId: chat.id, reasoningEffort: chat.backend === 'lmstudio' ? undefined : chat.reasoningEffort,
        backend: chat.backend, model: chat.lmStudioModel, preset, segments: prepared });
      if (again) return notifications(session) ? status(job) : undefined;
      sessions.set(job.id, session);
      const reference = imagesIn(job).length ? `（含 ${imagesIn(job).length} 张图片）` : '';
      try { if (notifications(session)) await send(session, textMessage(`已接收 ${job.id}${reference}，正在送往 ${backendLabel(job.backend)}。\n会话：${chat.name}（${job.sessionId}）\n/status 查看进度，/stop 停止。`)); }
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
    const previous = chats.current(owner, chat);
    const s = chats.create(owner, chat, name, { backend: previous?.backend, model: previous?.lmStudioModel, preset: previous?.lmStudioPreset });
    return `已开启：${s.name}（${s.id}）。旧会话保留，可用 /chat 切回。`
      + (s.lmStudioPreset ? `\n沿用本地预设：${s.lmStudioPreset}。` : '');
  }));
  command('/chat [id:string]', '会话列表；带编号切换').action(manage((owner, chat, id) => {
    if (id) {
      const s = chats.select(id, owner, chat); return `已切换：${s.name}（${s.id}）`;
    }
    const current = chats.current(owner, chat);
    const list = chats.list(owner, chat);
    return `当前：${current ? current.name + '（' + current.id + '）' : '暂无（发消息自动创建）'}\n`
      + (list.map(s => `${s.id} ${s.name}${s.id === current?.id ? ' [当前]' : ''}${busy(s.id) ? ' [处理中]' : ''}${s.backend === 'lmstudio' ? ' [LM Studio：' + s.lmStudioModel + ']' : ''}${s.lmStudioPreset ? ' [本地预设：' + s.lmStudioPreset + ']' : ''}${s.reasoningEffort && s.backend !== 'lmstudio' ? ' [推理：' + reasoningLabel(s.reasoningEffort) + ']' : ''}`).join('\n') || '暂无会话');
  }));
  command('/backend [target:text]', '查看或切换 web/lmstudio；可附模型编号').action(async ({ session }, target) => {
    try {
      const chat = chats.ensure(session.userId, conversation(session));
      if (!target) return textMessage(`当前后端：${backendLabel(chat.backend)}${chat.backend === 'lmstudio' ? '（' + chat.lmStudioModel + '）' : ''}。\n/backend lmstudio [模型编号] 切换本地；/backend web 切回网页。两边的上下文分别保留。`);
      const [backend, ...args] = target.trim().split(/\s+/);
      if (!['web', 'lmstudio'].includes(backend) || args.length > 1 || (backend === 'web' && args.length))
        return '用法：/backend web 或 /backend lmstudio [模型编号]';
      if (busy(chat.id)) return '当前会话正在处理任务，请等待完成或用 /stop 停止后再切换';
      const model = backend === 'lmstudio' ? await local.resolveModel(args[0] || chat.lmStudioModel || config.lmStudioModel) : undefined;
      // The model lookup is asynchronous: another message or command may have
      // changed the current conversation while it was in flight.
      if (chats.current(session.userId, conversation(session))?.id !== chat.id || busy(chat.id))
        return '当前会话或任务状态已变化，请重试切换后端';
      chats.setBackend(chat, backend, model);
      return textMessage(backend === 'lmstudio' ? `已切换到 LM Studio：${model}。直接发文字或图片即可连续对话；图片需视觉模型，/new 开启新话题。`
        : '当前会话已切回 ChatGPT 网页；本地模型的历史仍保留。');
    } catch (err) { return textMessage(safeReason(err.message)); }
  });
  command('/preset [name:text]', '公共预设；show/list 查看，create/edit/delete 管理，off 关闭').action(manage((owner, chat, value) => {
    const current = chats.current(owner, chat);
    const label = `当前本地预设：${current?.lmStudioPreset || '未启用'}。`;
    const lines = (value || '').split(/\r?\n/);
    const parsed = /^(list|show|create|edit|delete|off)(?:[ \t]+(.*))?$/i.exec(lines[0]);
    const action = parsed?.[1].toLowerCase(), argument = parsed?.[2]?.trim();
    if (!value || action === 'list') {
      if (lines.length > 1 || (argument && !/^[1-9]\d{0,3}$/.test(argument))) throw Error('用法：/preset list [页码]');
      const page = Number(argument || 1);
      const names = presets.list();
      const pages = Math.max(1, Math.ceil(names.length / 15));
      if (page > pages) throw Error(`公共预设列表只有 ${pages} 页`);
      const entries = names.slice((page - 1) * 15, page * 15).map(name => {
        try { const author = presets.readFile(name).owner; return name + (author === owner ? ' [我创建]' : author ? ' [公共]' : ' [本地模板]'); }
        catch { return name + ' [文件无效]'; }
      });
      return label + `\n公共预设：${names.length} 个，第 ${page}/${pages} 页。\n`
        + (entries.join('\n') || '暂无预设，发送 /preset create 名称 后换行填写正文创建。')
        + (page < pages ? `\n/preset list ${page + 1} 查看下一页。` : '')
        + '\n/preset 名称 选择；show 名称 查看；create/edit 名称 后换行填写正文；delete 名称 删除。仅创建者可修改、删除。';
    }
    if (action === 'create' || action === 'edit') {
      if (!argument || lines.length < 2 || !lines.slice(1).join('\n').trim())
        throw Error(`用法：/preset ${action} 名称\n下一行开始填写完整预设正文（最多 8000 字）`);
      const preset = presets[action](argument, lines.slice(1).join('\n'), owner);
      return `已${action === 'create' ? '创建' : '更新'}公共预设：${preset.name}。所有用户均可查看和选择，只有你能在 QQ 编辑或删除。`
        + (action === 'create' ? `\n/preset ${preset.name} 在当前会话选择。` : '\n下一条消息使用更新后的内容，已入队任务保持原版本。');
    }
    if (action === 'delete') {
      if (!argument || lines.length > 1) throw Error('用法：/preset delete 名称');
      presets.delete(argument, owner);
      return `已删除公共预设：${argument}。已有对话和任务保留；使用它的会话需重新选择预设或 /preset off。`;
    }
    if (action === 'show') {
      if (lines.length > 1) throw Error('用法：/preset show [名称]，翻页用 /preset show --page 页码 [名称]');
      let page = 1, name = argument;
      if (argument?.startsWith('--page')) {
        const paging = /^--page[ \t]+([1-9]\d{0,3})(?:[ \t]+(.+))?$/.exec(argument);
        if (!paging) throw Error('用法：/preset show --page 页码 [名称]');
        page = Number(paging[1]); name = paging[2];
      }
      name ||= current?.lmStudioPreset;
      if (!name) return label + '\n/preset show 名称 可查看任意公共预设。';
      const preset = presets.read(name);
      const heading = (current?.lmStudioPreset === preset.name ? label + '\n' : '')
        + `公共预设：${preset.name}。`
        + (preset.owner === owner ? ' [我创建]' : preset.owner ? ' [仅创建者可管理]' : ' [本地模板]');
      const navigation = `\n（预览已分页；/preset show --page 9999 ${preset.name} 查看下一页。）`;
      const content = splitText(preset.prompt, Math.max(16, maxTextChars - heading.length - navigation.length - 80));
      if (page > content.length) throw Error(`预设正文只有 ${content.length} 页`);
      return heading
        + `\n${preset.prompt.length} 字，版本 ${preset.revision.slice(0, 8)}，第 ${page}/${content.length} 页。\n`
        + content[page - 1]
        + (page < content.length ? `\n（预览已分页；/preset show --page ${page + 1} ${preset.name} 查看下一页。）` : '');
    }
    if (action === 'off' && (argument || lines.length > 1)) throw Error('用法：/preset off');
    if (current && busy(current.id)) throw Error('当前会话正在处理任务，请等待完成或用 /stop 停止后再切换预设');
    if (action === 'off') {
      if (current) chats.setPreset(current.id, owner, chat, undefined);
      return '当前会话已关闭本地预设。已有聊天记录保留，/new 开启空白上下文。';
    }
    const preset = presets.read(value);
    const s = current || chats.ensure(owner, chat);
    chats.setPreset(s.id, owner, chat, preset.name);
    return `会话「${s.name}」已选择本地预设：${preset.name}。下一条本地模型消息起生效。`
      + (s.backend === 'lmstudio' ? '' : '\n/backend lmstudio 切换到本地模型后使用。')
      + '\n已有聊天记录保留，/new 沿用预设开启新剧情。';
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
    const chat = chats.current(session.userId, conversation(session));
    if (chat?.backend === 'lmstudio') {
      try {
        await local.resolveModel(chat.lmStudioModel);
        connection = `桥接 ${version}；LM Studio 已连接；当前模型：${chat.lmStudioModel}\n当前本地预设：${chat.lmStudioPreset || '未启用'}`;
      } catch (err) { connection = `桥接 ${version}；LM Studio：${textMessage(safeReason(err.message))}`; }
      return connection + '\n' + (j ? status(j) : '当前会话暂无任务');
    }
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
  command('/reasoning [level:string]', '当前会话推理程度 default/instant/medium/high/xhigh/pro').action(manage((owner, chat, value) => {
    if (chats.current(owner, chat)?.backend === 'lmstudio') return 'LM Studio 使用本地模型设置；/reasoning 适用于 ChatGPT 网页。';
    if (!value) {
      const s = chats.current(owner, chat);
      return `当前会话推理程度：${reasoningLabel(s?.reasoningEffort)}。\n${REASONING_USAGE}\n即时 / 中 / 高 / 超高 / Pro；default 跟随网页。`;
    }
    const level = normalizeReasoning(value);
    const s = chats.ensure(owner, chat);
    chats.setReasoning(s.id, owner, chat, level);
    return `会话「${s.name}」推理程度已设为：${reasoningLabel(level)}。下一条消息起生效，已排队或运行中的任务保持原设置。`
      + (level === 'default' ? '' : level === 'pro' ? '\nPro 暂不可用时使用当前最高可用档，恢复后自动使用 Pro。'
        : '\n发送前会应用网页选项；账号不支持时会报错。');
  }));
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
    await send(s, `任务 ${j.id} 仍在 ${backendLabel(j.backend)}处理中，已等待 ${Math.floor((Date.now()-j.startedAt)/1000)} 秒。\n/status 查看进度，/retry 取回回复。`).catch(() => {});
  }, 10000);
  ctx.on('dispose', () => { delivery.close(); q.close(); web.close(); });
};
