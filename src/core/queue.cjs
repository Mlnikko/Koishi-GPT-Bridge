'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_INPUT_IMAGES } = require('../lib/image.cjs');
const { submissionText, imagesOf, isEmpty } = require('./message.cjs');
const { validateSegments } = require('../lib/reply.cjs');
const { writeJson } = require('../lib/state.cjs');
const { normalizeReasoning } = require('./reasoning.cjs');

// 任务负载的版本号。生图时代的任务没有这个字段，语义也已不适用，
// 载入时直接跳过（不删除），把目录留给用户自己处理。
const JOB_VERSION = 2;
const MAX_INPUT_CHARS = 1500;
const MAX_QUEUED = 5;

// The download staging directory and the job directory normally share a volume,
// but a configured temp path may not; fall back to copy + unlink in that case.
function moveFile(source, destination) {
  try { fs.renameSync(source, destination); }
  catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(source);
  }
}

class JobQueue {
  constructor(root, runner, onChange = async () => {}, { maxImages = MAX_INPUT_IMAGES, maxChars = MAX_INPUT_CHARS } = {}) {
    this.root = root; this.runner = runner; this.onChange = onChange;
    this.maxImages = maxImages; this.maxChars = maxChars;
    this.jobs = []; this.active = null; this.closed = false;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(root)) {
      if (!/^[a-f0-9]{12}$/.test(name)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(root, name, 'job.json'), 'utf8'));
        if (j.version !== JOB_VERSION) continue;
        j.dir = path.join(root, name);
        if (['queued', 'running'].includes(j.status)) {
          j.status = 'interrupted'; j.error = '服务重启，原任务状态待确认；未自动重试';
          try {
            const receipt = JSON.parse(fs.readFileSync(path.join(j.dir, 'result.json'), 'utf8'));
            if (receipt.id === j.id) {
              let uploaded = 0;
              while (fs.existsSync(path.join(j.dir, `result-${uploaded}.png`))) uploaded++;
              j.output = validateSegments(receipt.segments, { uploaded });
              j.threadId = receipt.threadId; j.status = 'ready'; delete j.error;
            }
          } catch {}
          j.finishedAt = Date.now(); this.save(j);
        }
        this.jobs.push(j);
      } catch {}
    }
    this.jobs.sort((a, b) => a.createdAt - b.createdAt);
  }
  save(j) {
    j.updatedAt = Date.now();
    const p = path.join(j.dir, 'job.json');
    writeJson(p, j);
  }
  // `segments` 是 core/message.cjs 产出的有序片段；图片片段此时还指向下载暂存目录，
  // 任务目录建好之后统一搬进来，这样重启也能解析出每一张参考图。
  enqueue({ owner, conversation, messageId, sessionId, reasoningEffort, segments = [] }) {
    const duplicate = messageId && this.jobs.find(j => j.owner === owner && j.conversation === conversation && j.messageId === messageId);
    if (duplicate) return { job: duplicate, duplicate: true };
    if (this.closed) throw new Error('桥接服务正在关闭');
    if (reasoningEffort !== undefined) reasoningEffort = normalizeReasoning(reasoningEffort);
    if (sessionId && this.jobs.some(j => j.sessionId === sessionId && j.owner === owner && j.conversation === conversation && ['queued', 'running'].includes(j.status))) {
      throw new Error('当前会话仍在处理上一条消息，请等待完成，或发送「/stop」停止后再试。');
    }
    const list = Array.isArray(segments) ? segments : [];
    const text = submissionText(list);
    if (text.length > this.maxChars) throw new Error(`文字最多 ${this.maxChars} 字，请缩短后重新发送`);
    if (isEmpty(list)) throw new Error('消息里既没有文字也没有图片');
    if (imagesOf(list).length > this.maxImages) throw new Error(`一次最多发送 ${this.maxImages} 张图片`);
    if (this.jobs.filter(j => ['queued', 'running'].includes(j.status)).length >= MAX_QUEUED) throw new Error('队列已满，请稍后再试');
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const dir = path.join(this.root, id);
    const input = [];
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      let index = 0;
      for (const segment of list) {
        if (segment.type !== 'image') { input.push({ type: 'text', text: segment.text }); continue; }
        const name = `input-${index}.${segment.ext}`;
        moveFile(segment.file, path.join(dir, name));
        input.push({ type: 'image', file: name, mime: segment.mime, size: segment.size });
        index++;
      }
    } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
    const j = { version: JOB_VERSION, id, owner, conversation, messageId, sessionId, input,
      ...(reasoningEffort && reasoningEffort !== 'default' ? { reasoningEffort } : {}),
      status: 'queued', delivery: 'pending', createdAt: Date.now(), dir };
    try { this.save(j); } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
    this.jobs.push(j);
    return { job: j, duplicate: false };
  }
  find(id, owner, conversation, sessionId) {
    return this.jobs.filter(j => j.owner === owner && j.conversation === conversation && (!id || j.id === id) && (id || !sessionId || j.sessionId === sessionId)).sort((a,b) => b.createdAt - a.createdAt)[0];
  }
  async pump() {
    if (this.active || this.closed) return;
    const job = this.jobs.find(j => j.status === 'queued'); if (!job) return;
    const controller = new AbortController(); this.active = { job, controller };
    try {
    job.status = 'running'; job.startedAt = Date.now(); this.save(job);
    try {
      try { await this.onChange(job); } catch {}
      const output = await this.runner(job, controller.signal, threadId => { job.threadId = threadId; this.save(job); });
      if (controller.signal.aborted) { job.status = 'cancelled'; }
      else { job.output = output; job.status = 'ready'; }
    } catch (err) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = String(err.message).slice(0,1000); job.errorCode = err.code || 'unknown'; }
    job.finishedAt = Date.now();
    this.save(job);
    try { await this.onChange(job); } catch {}
    } catch (err) {
      job.persistenceError = String(err.message || err).slice(0, 300);
      if (job.status === 'running') { job.status = 'failed'; job.error = '任务状态保存失败，未提交网页'; }
      try { this.save(job); } catch {}
    } finally {
      this.active = null;
      if (!this.closed) setImmediate(() => this.pump());
    }
  }
  cancel(j) {
    if (j.status === 'queued') { j.status = 'cancelled'; j.finishedAt = Date.now(); this.save(j); return '已取消排队任务'; }
    if (j.status === 'running' && this.active?.job.id === j.id) { this.active.controller.abort(); return '已请求停止生成，等待网页确认'; }
    return '任务已结束，无需取消';
  }
  // Reference images and replies are kept forever by default, because the
  // retention window is a policy decision rather than a technical one. Setting
  // retentionDays opts in: terminal jobs older than the window are removed whole.
  prune(retentionDays) {
    const days = Number(retentionDays) || 0;
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (const job of [...this.jobs]) {
      if (this.active?.job.id === job.id || job.delivery === 'sending') continue;
      // Never touch a job that could still be running or waiting to be retrieved.
      if (!['ready', 'failed', 'cancelled', 'interrupted'].includes(job.status)) continue;
      if ((job.finishedAt || job.updatedAt || job.createdAt) > cutoff) continue;
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch { continue; }
      this.jobs.splice(this.jobs.indexOf(job), 1);
      removed++;
    }
    return removed;
  }
  close() { this.closed = true; this.active?.controller.abort(); }
}
module.exports = { JobQueue, JOB_VERSION, MAX_INPUT_CHARS, MAX_QUEUED };
