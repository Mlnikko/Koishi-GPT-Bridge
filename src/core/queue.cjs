'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_INPUT_IMAGES } = require('../lib/image.cjs');

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
  constructor(root, runner, onChange = async () => {}) {
    this.root = root; this.runner = runner; this.onChange = onChange; this.jobs = []; this.active = null; this.closed = false;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(root)) {
      if (!/^[a-f0-9]{12}$/.test(name)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(root, name, 'job.json'), 'utf8'));
        j.dir = path.join(root, name);
        if (['queued', 'running'].includes(j.status)) { j.status = 'interrupted'; j.error = '服务重启，原任务状态待确认；未自动重试'; }
        this.jobs.push(j); this.save(j);
      } catch {}
    }
  }
  save(j) {
    j.updatedAt = Date.now();
    const p = path.join(j.dir, 'job.json');
    fs.writeFileSync(p + '.tmp', JSON.stringify(j, null, 2), { mode: 0o600 }); fs.renameSync(p + '.tmp', p);
  }
  enqueue({ owner, conversation, messageId, prompt, sessionId, inputImages = [] }) {
    const duplicate = this.jobs.find(j => j.owner === owner && j.conversation === conversation && j.messageId === messageId);
    if (duplicate) return { job: duplicate, duplicate: true };
    if (this.closed) throw new Error('生图服务正在关闭');
    const text = String(prompt || '').trim();
    if (text.length > 1500) throw new Error('图片描述最多 1500 字');
    // A pure-image message carries no text; a reference image is the request.
    if (!text && !inputImages.length) throw new Error('请输入 1–1500 字的图片描述，或直接发送一张图片');
    if (inputImages.length > MAX_INPUT_IMAGES) throw new Error(`一次最多参考 ${MAX_INPUT_IMAGES} 张图片`);
    if (this.jobs.filter(j => ['queued', 'running'].includes(j.status)).length >= 5) throw new Error('队列已满，请稍后再试');
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const dir = path.join(this.root, id);
    const files = [];
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      // Staged downloads move into the job directory before the job is saved, so
      // a restart can always resolve every recorded reference image.
      inputImages.forEach((image, index) => {
        const name = `input-${index}.${image.ext}`;
        moveFile(image.file, path.join(dir, name));
        files.push({ file: name, mime: image.mime, size: image.size });
      });
    } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
    const j = { id, owner, conversation, messageId, prompt: text, sessionId,
      kind: files.length ? 'image' : 'text', inputImages: files,
      status: 'queued', delivery: 'pending', createdAt: Date.now(), dir };
    this.jobs.push(j); this.save(j);
    return { job: j, duplicate: false };
  }
  find(id, owner, conversation, sessionId) {
    return this.jobs.filter(j => j.owner === owner && j.conversation === conversation && (!id || j.id === id) && (id || !sessionId || j.sessionId === sessionId)).sort((a,b) => b.createdAt - a.createdAt)[0];
  }
  async pump() {
    if (this.active || this.closed) return;
    const job = this.jobs.find(j => j.status === 'queued'); if (!job) return;
    const controller = new AbortController(); this.active = { job, controller };
    job.status = 'running'; job.startedAt = Date.now(); this.save(job);
    try {
      await this.onChange(job);
      const image = await this.runner(job, controller.signal, threadId => { job.threadId = threadId; this.save(job); });
      if (controller.signal.aborted) { job.status = 'cancelled'; }
      else { job.image = image; job.status = 'ready'; job.finishedAt = Date.now(); }
    } catch (err) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = String(err.message).slice(0,1000); job.errorCode = err.code || 'unknown'; }
    this.save(job);
    try { await this.onChange(job); } catch {}
    this.active = null;
    if (!this.closed) setImmediate(() => this.pump());
  }
  cancel(j) {
    if (j.status === 'queued') { j.status = 'cancelled'; this.save(j); return '已取消排队任务'; }
    if (this.active?.job.id === j.id) { this.active.controller.abort(); return '已请求停止任务，等待本机进程退出'; }
    return '任务已结束，无需取消';
  }
  // Reference images and results are kept forever by default, because the
  // retention window is a policy decision rather than a technical one. Setting
  // retentionDays opts in: terminal jobs older than the window are removed whole.
  prune(retentionDays) {
    const days = Number(retentionDays) || 0;
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (const job of [...this.jobs]) {
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
module.exports = { JobQueue };
