'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QQDelivery, isFresh } = require('../bridge/qq-delivery.cjs');
const { JobQueue } = require('../core/queue.cjs');
const { sessionSegments, submissionText, imagesOf } = require('../core/message.cjs');
const { skillContext } = require('../core/skills.cjs');
const { MAX_PROMPT_CHARS } = require('../core/image-prompts.cjs');
const { modeOf, contextOf, modeLabel, normalizeMode, executionLabel } = require('../core/modes.cjs');
const { reasoningLabel } = require('../core/reasoning.cjs');
const { textMessage, safeReason } = require('../lib/feedback.cjs');
const { downloadImage } = require('../lib/image.cjs');
const { createRunner } = require('./engines.cjs');
const { conversation, defaultChatName } = require('./session-scope.cjs');
const { version } = require('../../package.json');

function createBot(config, { chats, presets, skills, preferences, web, local, logger, imageLoader = downloadImage }) {
  const { dataDir: root, maxTextChars, maxReplyChars, maxInputImages, maxInputBytes,
    sendTimeoutMs, mediaSendTimeoutMs, replyTimeoutMs } = config;
  const sessions = new Map();
  const preparing = new Set();
  const busy = id => preparing.has(id) || q.busy(id);
  const labels = { queued: '排队中', running: 'ChatGPT 网页处理中', ready: '回复已取回', failed: '处理失败', cancelled: '已取消', interrupted: '服务重启，状态待确认' };
  const q = new JobQueue(path.join(root, 'jobs'), createRunner({
    chats, web, local, replyTimeoutMs, getSession: id => sessions.get(id),
    onProgress: (job, phase) => { if (job.progress !== phase) { job.progress = phase; q.save(job); } },
  }), async j => {
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
        try { logger.warn(`任务 ${j.id} 的失败反馈未送达，请使用「/status ${j.id}」查询。`); } catch {}
      }
      q.save(j);
    }
  }, { maxImages: maxInputImages, maxChars: maxTextChars });
  const fresh = isFresh;
  const send = (...args) => delivery.send(...args);
  const notifications = s => preferences.enabled(s.userId, conversation(s));
  const imagesIn = j => imagesOf(j.input);
  const status = j => `任务 ${j.id}：${j.status === 'running' ? executionLabel(j) + '处理中（' + modeLabel(j) + '）' : labels[j.status] || j.status}，已等待 ${Math.floor((Date.now()-j.createdAt)/1000)} 秒。`
    + (j.progress && j.status === 'running' ? `\n${j.progress}` : '')
    + (j.sessionId ? `\n会话：${j.sessionId}` : '\n独立任务（不绑定网页会话）')
    + (j.backend === 'lmstudio' ? `\n本地模型：${j.model}` : '')
    + (j.preset ? `\n本地预设：${j.preset.name}（版本 ${j.preset.revision.slice(0, 8)}）` : '')
    + (j.skill ? (j.backend === 'lmstudio' ? `\n技能：${j.skill.name}（版本 ${j.skill.revision.slice(0, 8)}）`
      : `\n网页技能：@${j.skill.name}`) : '')
    + (j.imagePrompt ? `\n图片模板：${j.imagePrompt.name}（版本 ${j.imagePrompt.revision.slice(0, 8)}）` : '')
    + (j.reasoningEffort ? `\n推理程度：${reasoningLabel(j.reasoningEffort, modeOf(j))}` : '')
    + (imagesIn(j).length ? `\n参考图片：${imagesIn(j).length} 张` : '')
    + (j.status === 'ready' ? `\n回复发送：${j.delivery === 'sent' ? '成功' : j.delivery === 'failed' ? '失败' : '待发送'}（已确认 ${j.deliveryCursor || 0} 段）。可发送「/retry ${j.id}」。` : '')
    + (j.deliveryError ? `\n发送详情：${textMessage(j.deliveryError)}` : '')
    + (j.error ? `\n${textMessage(j.error)}` : '');
  const delivery = new QQDelivery({ save: job => q.save(job), status, maxChars: maxTextChars,
    maxTotal: maxReplyChars, sendTimeoutMs, mediaSendTimeoutMs });
  const deliver = (job, session) => delivery.deliver(job, session);
  // 普通消息按原顺序转发；引用回复先附上有明确边界的引用内容，图片依次作为附件。
  async function forward(session, imagePrompt) {
    let segments;
    try { segments = imagePrompt ? [{ type: 'text', text: imagePrompt.text }] : sessionSegments(session); }
    catch (err) { return textMessage(safeReason(err.message)); }
    if (!segments.length) return;
    const text = submissionText(segments);
    const inputLimit = imagePrompt ? MAX_PROMPT_CHARS : maxTextChars;
    if (text.length > inputLimit) return `文字最多 ${inputLimit} 字，请缩短后重新发送。`;
    const sources = imagesOf(segments);
    if (sources.length > maxInputImages) return `一次最多发送 ${maxInputImages} 张图片，请减少后重新发送。`;
    // 默认就有一个持续会话：第一次发消息时自动建出来，之后所有消息都留在同一个
    // 网页会话里，所以「把刚才那张图改成蓝色」这类续聊不需要任何命令。
    // 会话数达到上限时 ensure 会抛错，必须在这里拦住 —— 它发生在下面那个 try 之外。
    let chat;
    try { chat = chats.ensure(session.userId, conversation(session), defaultChatName(session)); }
    catch (err) { return textMessage(safeReason(err.message)); }
    const mode = modeOf(chat), settings = structuredClone(contextOf(chat));
    if (imagePrompt && mode === 'local') return '图片模板通过 ChatGPT 网页生成图片，请先发送 /mode 工作，再用 /draw 角色名。';
    const duplicate = q.duplicate(session.userId, conversation(session), session.messageId);
    if (duplicate) return notifications(session) ? status(duplicate) : undefined;
    if (busy(chat.id)) return '当前会话仍在处理上一条消息，请等待完成，或发送「/stop」停止后再试。';
    preparing.add(chat.id);
    let staging;
    try {
      const preset = mode === 'local' && settings.preset ? presets.read(settings.preset) : undefined;
      const skill = mode !== 'chat' && settings.skill ? skills.read(settings.skill) : undefined;
      const system = [preset?.prompt, skillContext(skill)].filter(Boolean).join('\n\n');
      if (mode === 'local' && system && system.length + text.length > config.lmStudioHistoryChars)
        throw Error('预设、技能和本次消息超出本地上下文字数上限，请缩短内容或调整 lmStudioHistoryChars');
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-input-'));
      const prepared = [];
      for (const segment of segments) {
        if (segment.type === 'text') { prepared.push(segment); continue; }
        const image = await imageLoader(segment.source, staging, { maxBytes: maxInputBytes });
        prepared.push({ type: 'image', file: image.file, ext: image.ext, mime: image.mime, size: image.size });
      }
      if (!chats.get(chat.id, session.userId, conversation(session))) throw Error('会话已关闭，请重新发送消息');
      if (modeOf(chat) !== mode) throw Error('会话模式已变化，请重新发送消息');
      const { job, duplicate: again } = q.enqueue({ owner: session.userId, conversation: conversation(session),
        messageId: session.messageId, sessionId: chat.id, mode, reasoningEffort: mode === 'local' ? undefined : settings.reasoningEffort,
        backend: mode === 'local' ? 'lmstudio' : undefined, model: settings.model, preset, skill, imagePrompt, segments: prepared });
      if (again) return notifications(session) ? status(job) : undefined;
      sessions.set(job.id, session);
      const reference = imagesIn(job).length ? `（含 ${imagesIn(job).length} 张图片）` : '';
      try { if (notifications(session)) await send(session, textMessage(`已接收 ${job.id}${reference}，正在送往 ${modeLabel(job)}。\n会话：${chat.name}（${job.sessionId}）\n/status 查看进度，/stop 停止。`)); }
      catch { job.deliveryError = '接收确认未送达'; q.save(job); }
      void q.pump();
    }
    catch (err) { return textMessage(safeReason(err.message)); }
    finally { preparing.delete(chat.id); if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch {} } }
  }

  const currentChat = session => chats.current(session.userId, conversation(session));
  const ensureChat = session => chats.ensure(session.userId, conversation(session), defaultChatName(session));
  const currentJob = (session, id) => q.find(id, session.userId, conversation(session), currentChat(session)?.id);
  const modeChanges = new Map();
  async function switchMode(session, target, selectedModel) {
    const mode = normalizeMode(target);
    if (selectedModel && mode !== 'local') throw Error('仅本地模式可指定模型编号');
    const chat = chats.ensure(session.userId, conversation(session), defaultChatName(session));
    if (busy(chat.id)) throw Error('当前会话正在处理任务，请等待完成或用 /stop 停止后再切换模式');
    const request = (modeChanges.get(chat.id) || 0) + 1;
    modeChanges.set(chat.id, request);
    const before = JSON.stringify({ mode: modeOf(chat), contexts: chat.contexts });
    const model = mode === 'local'
      ? await local.resolveModel(selectedModel || contextOf(chat, 'local').model || config.lmStudioModel) : undefined;
    if (currentChat(session)?.id !== chat.id || busy(chat.id) || modeChanges.get(chat.id) !== request
      || before !== JSON.stringify({ mode: modeOf(chat), contexts: chat.contexts }))
      throw Error('当前会话或模式选择状态已变化，请重试切换模式');
    chats.setMode(chat, mode, model);
    return '已切换到' + modeLabel(chat) + (model ? '：' + model : '') + '。直接发消息即可。'
      + '\n聊天、工作、本地模型的上下文分别保留；/new 开启新话题。';
  }
  async function connectionStatus(session, id) {
    const job = currentJob(session, id);
    if (id) return job ? status(job) : '未找到你的任务';
    const chat = currentChat(session), mode = modeOf(chat), settings = contextOf(chat);
    let connection;
    if (mode === 'local') {
      try {
        await local.resolveModel(settings.model);
        connection = '桥接 ' + version + '；LM Studio 已连接；当前模型：' + settings.model
          + '\n当前本地预设：' + (settings.preset || '未启用');
      } catch (err) { connection = '桥接 ' + version + '；LM Studio：' + safeReason(err.message); }
    } else {
      try {
        await web.ready;
        const health = web.health();
        connection = '桥接 ' + health.pluginVersion + '；浏览器' + (health.online ? '已连接' : '未连接，请检查 Chrome 扩展');
      } catch { connection = '本机桥接未启动，请检查端口并重启实例'; }
    }
    return textMessage('当前模式：' + modeLabel(chat) + '\n' + connection
      + (mode === 'chat' ? '' : '\n当前技能：' + (settings.skill || '未启用')))
      + '\n' + (job ? status(job) : '当前会话暂无任务');
  }
  function logs(session, value) {
    const option = value?.trim().toLowerCase();
    if (option) {
      if (!['on', 'off', '开启', '关闭', '开', '关'].includes(option)) return '用法：/logs [on|off]';
      try { preferences.set(session.userId, conversation(session), ['on', '开启', '开'].includes(option)); }
      catch { return '通知设置保存失败，请稍后重试。'; }
    }
    return '过程通知已' + (notifications(session) ? '开启' : '关闭，仅接收最终回复或失败原因') + '。';
  }
  async function notifyProgress() {
    const j = q.active?.job, s = j && sessions.get(j.id);
    if (!j || j.status !== 'running' || !s || j.progressNotified || !notifications(s)
      || Date.now() - j.startedAt < 60000 || !fresh(s)) return;
    j.progressNotified = true;
    await send(s, '任务 ' + j.id + ' 仍在 ' + executionLabel(j) + '处理中（' + modeLabel(j) + '），已等待 '
      + Math.floor((Date.now() - j.startedAt) / 1000) + ' 秒。\n/status 查看进度，/stop 停止。').catch(() => {});
  }
  return {
    forward, busy, status, currentChat, ensureChat, currentJob, notifications, connectionStatus, switchMode, logs, notifyProgress,
    duplicateMessage: session => q.duplicate(session.userId, conversation(session), session.messageId),
    models: () => local.models(),
    stop(session, id) {
      const job = currentJob(session, id);
      if (!job) return '未找到你的任务';
      const result = q.cancel(job);
      if (job.status === 'cancelled') sessions.delete(job.id);
      return result;
    },
    retry(session, id) { const job = currentJob(session, id); return job ? deliver(job, session) : '未找到你的任务'; },
    prune() {
      if (!config.retentionDays) return;
      try { const removed = q.prune(config.retentionDays); if (removed) logger.info('已清理 ' + removed + ' 个过期任务'); }
      catch (err) { logger.warn('任务清理失败：' + safeReason(err.message)); }
    },
    close() { delivery.close(); q.close(); web.close(); },
  };
}
module.exports = { createBot };
