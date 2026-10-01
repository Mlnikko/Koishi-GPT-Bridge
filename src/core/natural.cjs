'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ruleIntent, directImageIntent, routeIntent } = require('./intent.cjs');
const { textMessage } = require('../lib/feedback.cjs');
class NaturalRouter {
  // `classifier` is injected because classification runs on the ChatGPT web page,
  // not in this process; `directImage` sends image requests straight to ChatGPT.
  constructor({ file, authorized, context, dispatch, classifier, directImage = false }) {
    if (typeof classifier !== 'function') throw new Error('NaturalRouter 需要注入 classifier');
    Object.assign(this, { file, authorized, context, dispatch, classifier, directImage });
    this.pending = new Map(); this.versions = new Map(); this.closed = false;
    this.receipts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  key(s) { return JSON.stringify([s.platform, s.userId, s.channelId]); }
  touch(s) {
    const key = this.key(s); this.versions.set(key, (this.versions.get(key) || 0) + 1);
    this.pending.get(key)?.abort();
  }
  save() {
    const recent = Object.entries(this.receipts).filter(([, r]) => Date.now()-r.at < 86400000).slice(-1000);
    this.receipts = Object.fromEntries(recent);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file+'.tmp', JSON.stringify(this.receipts), { mode: 0o600 }); fs.renameSync(this.file+'.tmp', this.file);
  }
  // A guild message arrives with the bot mention as a leading `at` element. The
  // raw element list would reject it outright (and splice the mention into the
  // text), so guild sessions read Koishi's `stripped.content`, which has already
  // dropped the mention and the whitespace behind it. Private sessions keep the
  // element-level rules: anything that is not plain text is left to the
  // image/command paths.
  text(s) {
    if (!s.isDirect) return (s.stripped?.content || '').trim();
    if (s.elements?.some(e => e.type !== 'text')) return '';
    return (s.elements?.length ? s.elements.map(e => e.attrs?.content || '').join('') : s.content || '').trim();
  }
  async handle(s) {
    if (this.closed || !this.authorized(s) || !s.messageId) return;
    const input = this.text(s);
    if (!input || /^[/.]/.test(input)) return;
    if (input.length > 1500) return '自然语言消息最多 1500 字，请缩短描述。';
    const key = this.key(s), receiptKey = JSON.stringify([key, s.messageId]);
    if (this.receipts[receiptKey]) return;
    const quick = ruleIntent(input);
    const direct = !quick && this.directImage ? directImageIntent(input) : null;
    const needsClassifier = !quick && !direct;
    if (needsClassifier && this.pending.has(key)) return '上一条消息仍在识别中；也可以直接发送绘图或会话命令。';
    if (needsClassifier && this.pending.size >= 2) return '语义识别暂忙，请稍后重试，或直接发送“画图 提示词”。';
    this.touch(s);
    const version = this.versions.get(key), snapshot = this.context(s), controller = new AbortController();
    this.receipts[receiptKey] = { at: Date.now(), state: 'received' }; this.save();
    if (needsClassifier) this.pending.set(key, controller);
    try {
      const intent = quick || direct || await this.classifier(input, snapshot, { signal: controller.signal });
      if (this.closed) return;
      if (version !== this.versions.get(key)) return '你已发送新的操作，较早的语义识别结果已忽略。';
      const route = routeIntent(intent, snapshot, input);
      let response;
      if (route.reply) response = textMessage(route.reply);
      else if (route.command) response = await this.dispatch(route.command, s, route.args);
      this.receipts[receiptKey].state = 'done'; this.save();
      return response;
    } catch (err) {
      if (this.closed) return;
      this.receipts[receiptKey].state = 'failed'; this.save();
      if (version !== this.versions.get(key)) return '你已发送新的操作，较早的语义识别已停止。';
      return textMessage(err.message);
    } finally { if (this.pending.get(key) === controller) this.pending.delete(key); }
  }
  close() { this.closed = true; for (const controller of this.pending.values()) controller.abort(); }
}
module.exports = { NaturalRouter };
