'use strict';
const fs = require('node:fs');
const { toMessages } = require('../lib/reply.cjs');
const { replyAssetPath } = require('../lib/reply-assets.cjs');
const { textMessage, safeReason } = require('../lib/feedback.cjs');

const isFresh = session => Date.now() - session.timestamp < 298000;

// QQ transport owns confirmation deadlines, media encoding, replay and locks.
// Queue persistence and presentation are injected; this layer does not own jobs.
class QQDelivery {
  constructor({ save, status, maxChars, maxTotal, sendTimeoutMs, mediaSendTimeoutMs }) {
    Object.assign(this, { save, status, maxChars, maxTotal, sendTimeoutMs, mediaSendTimeoutMs });
    this.locks = new Set(); this.tails = new Map(); this.closed = false;
  }
  async send(session, content, timeoutMs = this.sendTimeoutMs) {
    if (this.closed) throw Error('桥接服务正在关闭，未继续发送');
    let timer;
    try {
      const ids = await Promise.race([
        Promise.resolve().then(() => session.send(content)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('QQ 发送确认超时，送达状态不确定')), timeoutMs); }),
      ]);
      if (!ids?.length) throw Error('QQ 未确认发送成功');
    } finally { clearTimeout(timer); }
  }
  async deliver(job, session) {
    if (this.locks.has(job.id)) return '正在发送，请稍候';
    if (job.status !== 'ready') return this.status(job);
    this.locks.add(job.id);
    const channel = job.conversation, previous = this.tails.get(channel) || Promise.resolve();
    let release; const tail = new Promise(resolve => { release = resolve; });
    this.tails.set(channel, tail);
    try {
      await previous;
      const messages = job.deliveryPlan || toMessages(job.output || [], { maxChars: this.maxChars, maxTotal: this.maxTotal }).messages;
      if (!messages.length) throw Error('回复内容为空');
      if (job.delivery === 'sent') job.deliveryCursor = 0;
      job.deliveryPlan = messages; job.delivery = 'sending'; this.save(job);
      for (let index = job.deliveryCursor || 0; index < messages.length; index++) {
        if (this.closed) throw Error('桥接服务正在关闭，未继续发送');
        if (!isFresh(session)) throw Error('QQ 回复窗口已过期，请用「/retry」取回回复');
        const item = messages[index];
        if (item.type === 'image') {
          const mime = item.mime || 'image/png';
          const bytes = fs.readFileSync(replyAssetPath(job.dir, item.asset, mime));
          await this.send(session, `<img src="data:${mime};base64,${bytes.toString('base64')}"/>`, this.mediaSendTimeoutMs);
        } else await this.send(session, textMessage(item.text));
        job.deliveryCursor = index + 1; this.save(job);
      }
      job.delivery = 'sent'; job.deliveredAt = Date.now(); delete job.deliveryError; this.save(job);
    } catch (err) {
      job.delivery = 'failed'; job.deliveryError = safeReason(err.message).slice(0, 300); this.save(job);
      return `任务 ${job.id} 的回复已取回，但 QQ 发送失败：${textMessage(job.deliveryError)}\n已确认 ${job.deliveryCursor || 0} 段；可发送「/retry ${job.id}」继续，未确认的一段可能重复。`;
    } finally {
      this.locks.delete(job.id); release();
      if (this.tails.get(channel) === tail) this.tails.delete(channel);
    }
  }
  close() { this.closed = true; }
}

module.exports = { QQDelivery, isFresh };
