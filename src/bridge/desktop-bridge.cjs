'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { writeJson } = require('../lib/state.cjs');
const { submissionText, imagesOf } = require('../core/message.cjs');

const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

// The worker runs in an authorized desktop task and calls the app's chat tools.
// Koishi never connects to the client's protected native pipe.
class DesktopBridge {
  constructor({ root, port = 5142, threadId, timeoutMs = 300000 }) {
    this.root = root; this.threadId = threadId; this.timeoutMs = timeoutMs;
    this.pending = null; this.lastSeen = 0; this.closed = false;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, 'desktop-bridge-token');
    this.token = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : randomBytes(32).toString('hex');
    fs.writeFileSync(file, this.token, { mode: 0o600 });
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        try {
          this.port = this.server.address().port;
          fs.writeFileSync(path.join(root, 'desktop-bridge-port'), String(this.port), { mode: 0o600 });
          resolve();
        } catch (err) { this.server.close(); reject(err); }
      });
    });
    this.ready.catch(() => {});
  }
  health() {
    return { version: 1, backend: 'desktop', threadId: this.threadId,
      online: !this.closed && this.lastSeen > 0 && Date.now() - this.lastSeen < 90000,
      busy: !!this.pending };
  }
  async handle(req, res) {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const token = Buffer.from(String(req.headers['x-bridge-token'] || ''));
    const expected = Buffer.from(this.token);
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) return send(401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, this.health());
      if (req.method === 'GET' && req.url === '/state') {
        this.lastSeen = Date.now();
        const p = this.pending;
        return send(200, { version: 1, job: p ? { id: p.job.id, threadId: this.threadId,
          text: submissionText(p.job.input), checkpoint: p.checkpoint } : null });
      }
      if (req.method !== 'POST' || !['/checkpoint', '/result', '/failure'].includes(req.url)) return send(404, { error: 'not found' });
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Error('请求体过大'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const p = this.pending;
      if (!p || body.id !== p.job.id) {
        if (req.url === '/result' && this.lastResult && JSON.stringify(body) === JSON.stringify(this.lastResult)) return send(200, { ok: true });
        return send(409, { error: '任务已结束或不匹配' });
      }
      if (body.threadId !== this.threadId) return send(409, { error: '客户端聊天不匹配' });
      if (req.url === '/checkpoint') {
        const c = body.checkpoint;
        if ((p.checkpoint?.phase || null) !== (body.expectedPhase || null)) return send(409, { error: '执行器提交阶段冲突，请重新读取状态，不能重发消息' });
        if (!c || !['prepared', 'dispatching', 'submitted'].includes(c.phase)
          || !Array.isArray(c.baseline) || !c.baseline.every(validId)
          || (c.phase === 'submitted' && !validId(c.userMessageId))) throw Error('提交凭据无效');
        const phases = ['prepared', 'dispatching', 'submitted'];
        if (p.checkpoint && (JSON.stringify(p.checkpoint.baseline) !== JSON.stringify(c.baseline)
          || phases.indexOf(c.phase) < phases.indexOf(p.checkpoint.phase)
          || (p.checkpoint.userMessageId && p.checkpoint.userMessageId !== c.userMessageId))) throw Error('提交凭据发生冲突');
        writeJson(path.join(p.job.dir, 'desktop-checkpoint.json'), c);
        p.checkpoint = c;
        try { p.onProgress(c.phase === 'submitted' ? '客户端已接收，正在等待回复' : '正在提交客户端文字消息'); } catch {}
        return send(200, { ok: true });
      }
      if (req.url === '/failure') {
        p.finish(fail('desktop_failed', String(body.message || '客户端执行失败').slice(0, 500)));
        return send(200, { ok: true });
      }
      if (p.checkpoint?.phase !== 'submitted' || body.userMessageId !== p.checkpoint.userMessageId
        || !Array.isArray(body.assistantMessageIds) || !body.assistantMessageIds.length
        || !body.assistantMessageIds.every(validId)
        || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000000) throw Error('本轮回复凭据无效');
      const segments = [{ type: 'text', text: body.text }];
      writeJson(path.join(p.job.dir, 'desktop-receipt.json'), body);
      writeJson(path.join(p.job.dir, 'result.json'), { id: p.job.id, threadId: this.threadId, segments });
      this.lastResult = body;
      p.finish(null, segments);
      return send(200, { ok: true });
    } catch (err) { return send(400, { error: err.message }); }
  }
  async run(job, { signal, onThread = () => {}, onProgress = () => {}, timeoutMs = this.timeoutMs } = {}) {
    await this.ready;
    if (this.closed) throw fail('interrupted', '客户端桥接已关闭');
    if (this.pending) throw fail('bridge_busy', '客户端单聊天仍在处理上一条消息');
    if (imagesOf(job.input).length || job.reasoningEffort) throw fail('desktop_unsupported', '客户端原型仅支持文字，推理程度请设为 default');
    if (signal?.aborted) throw fail('cancelled', '任务已取消');
    if (!this.health().online) throw fail('desktop_offline', '客户端执行器未连接，请在工作聊天启动文字桥接执行器');
    onThread(this.threadId);
    return new Promise((resolve, reject) => {
      let timer; let done = false;
      const abort = () => p.finish(fail('cancelled', '已停止等待；客户端消息可能已经提交，请在客户端确认，本任务不会自动重发'));
      const p = { job, checkpoint: null, onProgress, finish: (err, segments) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (this.pending === p) this.pending = null;
        if (err) reject(err); else resolve(segments);
      } };
      this.pending = p;
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => p.finish(fail('execution_stopped', '客户端回复超时；未自动重发，请在客户端确认')), timeoutMs);
      try { onProgress('等待客户端文字执行器接收任务'); } catch {}
    });
  }
  close() { this.closed = true; this.pending?.finish(fail('interrupted', '客户端桥接关闭；未自动重发')); this.server.close(); }
}
module.exports = { DesktopBridge };
