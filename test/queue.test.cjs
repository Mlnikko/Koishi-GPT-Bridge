const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobQueue } = require('../queue.cjs');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'image-queue-test-'));
const input = id => ({ owner: 'alice', conversation: 'qq:alice', messageId: id, prompt: 'a cat' });
test('duplicate incoming message does not enqueue another generation; owner and chat are isolated', () => {
  const q = new JobQueue(root(), async () => {});
  const a = q.enqueue(input('m1')); const b = q.enqueue(input('m1'));
  assert.equal(a.job.id, b.job.id); assert.equal(b.duplicate, true); assert.equal(q.jobs.length, 1);
  assert.equal(q.find(a.job.id, 'bob', 'qq:alice'), undefined);
  assert.equal(q.find(a.job.id, 'alice', 'qq:group'), undefined);
});
test('only one process runs; cancellation waits for process completion before next job', async () => {
  let finish, starts = 0;
  const q = new JobQueue(root(), async () => { starts++; await new Promise(r => { finish = r; }); return 'image.png'; });
  const a = q.enqueue(input('m1')).job; const b = q.enqueue(input('m2')).job;
  const active = q.pump(); await new Promise(setImmediate);
  await q.pump(); assert.equal(starts, 1);
  q.cancel(a); assert.equal(starts, 1); assert.equal(b.status, 'queued');
  finish(); await active; await new Promise(setImmediate);
  assert.equal(a.status, 'cancelled'); assert.equal(starts, 2);
  finish(); await new Promise(setImmediate); q.close();
});
test('restart marks uncertain tasks interrupted and preserves completed image for retrieval', () => {
  const dir = root(); const q = new JobQueue(dir, async () => {});
  const a = q.enqueue(input('m1')).job; a.status = 'running'; q.save(a);
  const b = q.enqueue(input('m2')).job; b.status = 'ready'; b.delivery = 'failed'; q.save(b);
  const recovered = new JobQueue(dir, async () => { throw Error('must not run'); });
  assert.equal(recovered.find(a.id,'alice','qq:alice').status, 'interrupted');
  assert.equal(recovered.find(b.id,'alice','qq:alice').status, 'ready');
});
test('tasks remain bound to original conversation and default lookup follows selected conversation', () => {
  const q = new JobQueue(root(), async () => {});
  const a = q.enqueue({ ...input('m1'), sessionId: 'chat-a' }).job;
  q.enqueue({ ...input('m2'), sessionId: 'chat-b' });
  assert.equal(q.find(undefined, 'alice', 'qq:alice', 'chat-a').id, a.id);
  assert.equal(q.find(a.id, 'alice', 'qq:alice', 'chat-b').id, a.id);
  assert.equal(q.find(undefined, 'alice', 'qq:alice', 'empty'), undefined);
});
test('staged reference images move into the job directory and survive a restart', () => {
  const dir = root(), staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  const staged = path.join(staging, 'image-abcd1234.png');
  fs.writeFileSync(staged, Buffer.alloc(200));
  const q = new JobQueue(dir, async () => {});
  const { job } = q.enqueue({ ...input('m1'), prompt: '', inputImages: [{ file: staged, ext: 'png', mime: 'image/png', size: 200 }] });
  assert.equal(job.kind, 'image');
  assert.equal(job.prompt, '');
  assert.deepEqual(job.inputImages, [{ file: 'input-0.png', mime: 'image/png', size: 200 }]);
  assert.equal(fs.existsSync(path.join(job.dir, 'input-0.png')), true);
  // The staging copy is consumed, so nothing is left behind to leak or duplicate.
  assert.equal(fs.existsSync(staged), false);
  const recovered = new JobQueue(dir, async () => {});
  const restored = recovered.find(job.id, 'alice', 'qq:alice');
  assert.equal(restored.kind, 'image');
  assert.deepEqual(restored.inputImages, job.inputImages);
});
test('a message with neither text nor an image is rejected without leaving a job directory', () => {
  const dir = root();
  const q = new JobQueue(dir, async () => {});
  assert.throws(() => q.enqueue({ ...input('m1'), prompt: '' }), /或直接发送一张图片/);
  assert.throws(() => q.enqueue({ ...input('m2'), inputImages: [{ file: '/nope/a.png', ext: 'png', mime: 'image/png', size: 1 }, { file: '/nope/b.png', ext: 'png', mime: 'image/png', size: 1 }, { file: '/nope/c.png', ext: 'png', mime: 'image/png', size: 1 }] }), /最多参考 2 张图片/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('retention pruning is off by default and never touches fresh or pending jobs', () => {
  const dir = root();
  const q = new JobQueue(dir, async () => {});
  const stale = q.enqueue(input('m1')).job;
  stale.status = 'ready'; stale.finishedAt = Date.now() - 10 * 86400000; q.save(stale);
  const fresh = q.enqueue(input('m2')).job;
  fresh.status = 'ready'; fresh.finishedAt = Date.now(); q.save(fresh);
  const pending = q.enqueue(input('m3')).job;
  assert.equal(q.prune(0), 0, '未配置保留天数时不应删除任何东西');
  assert.equal(fs.existsSync(stale.dir), true);
  assert.equal(q.prune(7), 1);
  assert.equal(fs.existsSync(stale.dir), false);
  assert.equal(q.find(stale.id, 'alice', 'qq:alice'), undefined);
  assert.equal(fs.existsSync(fresh.dir), true);
  assert.equal(fs.existsSync(pending.dir), true, '排队中的任务即使很旧也不能删');
});
