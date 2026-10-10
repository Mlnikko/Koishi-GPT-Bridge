'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJson } = require('../lib/state.cjs');
const { submissionText } = require('../core/message.cjs');
const { validatePresetSnapshot } = require('../core/presets.cjs');
const { validateSegments, replyText } = require('../lib/reply.cjs');
const { sniffImage, MAX_INPUT_BYTES } = require('../lib/image.cjs');

const fail = (code, message) => Object.assign(new Error(message), { code });
const cancelled = () => fail('cancelled', '本地模型任务已停止');
const assetName = value => typeof value === 'string' && /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(value);
const validInput = input => Array.isArray(input) && input.length > 0 && input.every(s =>
  s?.type === 'text' ? typeof s.text === 'string' : s?.type === 'image' && assetName(s.asset)
    && typeof s.mime === 'string' && Number.isSafeInteger(s.size) && s.size > 0);
const imageStats = input => (input || []).filter(s => s.type === 'image')
  .reduce((stats, s) => ({ images: stats.images + 1, bytes: stats.bytes + s.size }), { images: 0, bytes: 0 });

// Local inference uses HTTP directly. Each user/chat/session/model has its own
// atomic history; pruning task records does not remove conversation context.
class LMStudioBridge {
  constructor({ root, baseUrl = 'http://127.0.0.1:1234/v1', apiKey = '', model = '',
    maxTokens = 2048, historyTurns = 20, historyChars = 12000, historyImages = 4,
    historyImageBytes = 20 * 1024 * 1024, maxImageBytes = MAX_INPUT_BYTES, timeoutMs = 300000 }) {
    Object.assign(this, { root, baseUrl, apiKey, model, maxTokens, historyTurns, historyChars,
      historyImages, historyImageBytes, maxImageBytes, timeoutMs });
  }
  async request(endpoint, { body, signal, timeoutMs = 5000, native = false } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch((native ? this.baseUrl.replace(/\/v1$/, '') : this.baseUrl) + endpoint, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw fail('lmstudio_reply_large', 'LM Studio 返回内容过大');
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw fail('lmstudio_protocol', 'LM Studio 未返回有效 JSON，请检查服务地址'); }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw fail('lmstudio_auth', 'LM Studio 需要认证，请配置 lmStudioApiKey');
        const message = typeof value.error?.message === 'string' ? value.error.message.slice(0, 400) : '';
        throw fail('lmstudio_http', `LM Studio 请求失败（HTTP ${response.status}）${message ? '：' + message : ''}`);
      }
      return value;
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      if (timeout.aborted) throw fail('execution_stopped', 'LM Studio 回复超时；请检查模型加载和电脑性能，本任务未自动重发');
      if (err.code) throw err;
      throw fail('lmstudio_offline', '无法连接 LM Studio，请在本机启动 API 服务并检查端口');
    }
  }
  async models() {
    const value = await this.request('/models');
    if (!Array.isArray(value.data)) throw fail('lmstudio_protocol', 'LM Studio 模型列表格式无效');
    return value.data.filter(item => typeof item.id === 'string' && item.id.trim()
      && item.type !== 'embedding' && !/embed/i.test(item.id)).map(item => item.id);
  }
  async resolveModel(selected = this.model) {
    const models = await this.models();
    if (selected) {
      if (!models.includes(selected)) throw fail('lmstudio_model', `LM Studio 未提供聊天模型 ${selected}，请加载模型后重试`);
      return selected;
    }
    if (!models.length) throw fail('lmstudio_model', 'LM Studio 尚无聊天模型，请先下载或加载模型');
    if (models.length > 1) throw fail('lmstudio_model', '有多个本地聊天模型，请指定：/backend lmstudio 模型编号\n' + models.join('\n'));
    return models[0];
  }
  async ensureVision(model, options) {
    const value = await this.request('/api/v1/models', { ...options, native: true });
    if (!Array.isArray(value.models)) throw fail('lmstudio_protocol', '无法读取本地模型图片能力，请检查 LM Studio 版本');
    const info = value.models.find(item => item.key === model || item.loaded_instances?.some(instance => instance.id === model));
    if (info?.capabilities?.vision !== true)
      throw fail('lmstudio_unsupported', '当前本地模型不支持图片，请选择视觉模型或用 /backend web');
  }
  historyFile(job) {
    const identity = [this.baseUrl, job.owner, job.conversation, job.sessionId, job.model];
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    return { file: path.join(this.root, 'lmstudio', key + '.json'),
      assets: path.join(this.root, 'lmstudio', key + '-images'), identity };
  }
  history(job) {
    const { file, assets, identity } = this.historyFile(job);
    if (!fs.existsSync(file)) return { file, assets, identity, turns: [] };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || JSON.stringify(value.identity) !== JSON.stringify(identity) || !Array.isArray(value.turns)
      || value.turns.some(t => typeof t.id !== 'string' || typeof t.user !== 'string' || typeof t.assistant !== 'string'
        || (t.input !== undefined && !validInput(t.input))))
      throw fail('lmstudio_history', '本地会话记录损坏，请检查记录或用 /new 开启新会话');
    return { file, assets, identity, turns: value.turns };
  }
  trim(turns, reserve = {}) {
    const selected = turns.slice(-this.historyTurns);
    let chars = (reserve.chars || 0) + selected.reduce((sum, t) => sum + t.user.length + t.assistant.length, 0);
    let images = reserve.images || 0, bytes = reserve.bytes || 0;
    for (const turn of selected) { const stats = imageStats(turn.input); images += stats.images; bytes += stats.bytes; }
    while (selected.length && (chars > this.historyChars || images > this.historyImages || bytes > this.historyImageBytes)) {
      const first = selected.shift(), stats = imageStats(first.input);
      chars -= first.user.length + first.assistant.length; images -= stats.images; bytes -= stats.bytes;
    }
    return selected;
  }
  readImage(file, expected) {
    let bytes;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxImageBytes)
        throw fail('lmstudio_image', '本地图片文件无效或超过上限');
      bytes = fs.readFileSync(file);
    } catch (err) {
      if (err.code === 'ENOENT') throw fail('lmstudio_image', '会话图片文件缺失，请重新发送原图或用 /new 开启新话题');
      throw err;
    }
    const type = sniffImage(bytes), digest = createHash('sha256').update(bytes).digest('hex');
    const asset = digest + '.' + type.ext;
    if (expected && (expected.asset !== asset || expected.mime !== type.mime || expected.size !== bytes.length))
      throw fail('lmstudio_image', '会话图片校验失败，请重新发送原图或用 /new 开启新话题');
    return { segment: { type: 'image', asset, mime: type.mime, size: bytes.length }, bytes };
  }
  prepare(job) {
    const pending = new Map();
    const input = job.input.map(s => {
      if (s.type === 'text') return { type: 'text', text: s.text };
      if (s.type !== 'image' || !/^input-\d+\.(png|jpg|gif|webp)$/.test(s.file))
        throw fail('lmstudio_image', '输入图片文件名无效');
      const image = this.readImage(path.join(job.dir, s.file));
      pending.set(image.segment.asset, image.bytes); return image.segment;
    });
    const stats = imageStats(input);
    if (stats.images > this.historyImages || stats.bytes > this.historyImageBytes)
      throw fail('lmstudio_image', '本次图片超过本地会话图片上限，请减少图片或调整本地历史配置');
    return { input, pending, ...stats };
  }
  content(turn, history, pending = new Map()) {
    if (!turn.input?.some(s => s.type === 'image')) return turn.user;
    return turn.input.map(s => {
      if (s.type === 'text') return { type: 'text', text: s.text };
      const bytes = pending.get(s.asset) || this.readImage(path.join(history.assets, s.asset), s).bytes;
      return { type: 'image_url', image_url: { url: `data:${s.mime};base64,${bytes.toString('base64')}` } };
    });
  }
  saveHistory(history, retained, pending) {
    const referenced = new Set(retained.flatMap(t => (t.input || []).filter(s => s.type === 'image').map(s => s.asset)));
    for (const [asset, bytes] of pending) {
      if (!referenced.has(asset)) continue;
      fs.mkdirSync(history.assets, { recursive: true, mode: 0o700 });
      const file = path.join(history.assets, asset);
      // Each complete content-addressed file is published before the JSON
      // references it. Cancelled/failed inference never gets this far.
      fs.writeFileSync(file + '.tmp', bytes, { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    }
    writeJson(history.file, { version: 1, identity: history.identity, turns: retained });
    // Only remove assets after the replacement history has committed. A crash
    // may leave an unreferenced file, but cannot break the previous snapshot.
    try {
      for (const name of fs.readdirSync(history.assets)) {
        if (assetName(name) && !referenced.has(name)) {
          try { fs.unlinkSync(path.join(history.assets, name)); } catch {}
        }
      }
    } catch { /* Asset cleanup is best effort after the successful commit. */ }
  }
  async run(job, { signal, timeoutMs = this.timeoutMs, onProgress = () => {} } = {}) {
    if (!job.sessionId || !job.model) throw fail('lmstudio_session', '本地会话或模型未设置，请先用 /backend lmstudio');
    if (signal?.aborted) throw cancelled();
    const text = submissionText(job.input);
    const history = this.history(job);
    const previous = history.turns.find(t => t.id === job.id);
    // Recover a committed turn without submitting the same prompt twice.
    let turn = previous;
    if (!turn) {
      const preset = job.preset === undefined ? undefined : validatePresetSnapshot(job.preset);
      const promptChars = preset?.prompt.length || 0;
      if (preset && promptChars + text.length > this.historyChars)
        throw fail('lmstudio_context', '预设和本次消息超出本地上下文字数上限，请缩短预设或消息，或调整 lmStudioHistoryChars');
      const started = Date.now(), prepared = this.prepare(job);
      const turns = this.trim(history.turns, { chars: promptChars + text.length, images: prepared.images, bytes: prepared.bytes });
      if (prepared.images || turns.some(t => imageStats(t.input).images))
        await this.ensureVision(job.model, { signal, timeoutMs: Math.min(5000, timeoutMs) });
      const messages = turns.flatMap(t => [{ role: 'user', content: this.content(t, history) }, { role: 'assistant', content: t.assistant }]);
      if (preset) messages.unshift({ role: 'system', content: preset.prompt });
      messages.push({ role: 'user', content: this.content({ user: text, input: prepared.input }, history, prepared.pending) });
      onProgress(`本地模型 ${job.model} 正在生成回复`);
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw fail('execution_stopped', 'LM Studio 图片准备超时，本任务未自动重发');
      const result = await this.request('/chat/completions', { signal, timeoutMs: remaining,
        body: { model: job.model, messages, stream: false, max_tokens: this.maxTokens } });
      if (signal?.aborted) throw cancelled();
      const choice = result.choices?.[0], content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim())
        throw fail('empty_reply', 'LM Studio 未返回可用的正文回复，请检查模型或增加生成上限');
      validateSegments([{ type: 'text', text: content }]);
      turn = { id: job.id, user: text, input: prepared.input, assistant: content, truncated: choice.finish_reason === 'length' };
      // Keep at least the latest turn so it remains recoverable even when a
      // single long answer exceeds the history budget. It is trimmed at input.
      const retained = this.trim([...history.turns, turn]);
      if (!retained.length) retained.push(turn);
      this.saveHistory(history, retained, prepared.pending);
    }
    const output = validateSegments([{ type: 'text', text: turn.assistant
      + (turn.truncated ? '\n\n（本地模型回复达到生成上限；可继续提问或调整 lmStudioMaxTokens。）' : '') }]);
    fs.writeFileSync(path.join(job.dir, 'reply.md'), replyText(output), { mode: 0o600 });
    writeJson(path.join(job.dir, 'result.json'), { id: job.id, segments: output });
    return output;
  }
}

module.exports = { LMStudioBridge };
