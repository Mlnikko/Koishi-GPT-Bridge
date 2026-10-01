const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobQueue, JOB_VERSION } = require('../../src/core/queue.cjs');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-queue-test-'));
const input = id => ({ owner: 'alice', conversation: 'qq:alice', messageId: id, segments: [{ type: 'text', text: 'a cat' }] });

test('duplicate incoming message does not enqueue another job; owner and chat are isolated', () => {
  const q = new JobQueue(root(), async () => {});
  const a = q.enqueue(input('m1')); const b = q.enqueue(input('m1'));
  assert.equal(a.job.id, b.job.id); assert.equal(b.duplicate, true); assert.equal(q.jobs.length, 1);
  assert.equal(q.find(a.job.id, 'bob', 'qq:alice'), undefined);
  assert.equal(q.find(a.job.id, 'alice', 'qq:group'), undefined);
});
test('only one job runs at a time; cancellation waits for the current one to finish', async () => {
  let finish, starts = 0;
  const q = new JobQueue(root(), async () => { starts++; await new Promise(r => { finish = r; }); return [{ type: 'text', text: 'ok' }]; });
  const a = q.enqueue(input('m1')).job; const b = q.enqueue(input('m2')).job;
  const active = q.pump(); await new Promise(setImmediate);
  await q.pump(); assert.equal(starts, 1);
  q.cancel(a); assert.equal(starts, 1); assert.equal(b.status, 'queued');
  finish(); await active; await new Promise(setImmediate);
  assert.equal(a.status, 'cancelled'); assert.equal(starts, 2);
  finish(); await new Promise(setImmediate); q.close();
});
test('a finished job keeps its reply for replay', async () => {
  const q = new JobQueue(root(), async () => [{ type: 'text', text: '答复' }, { type: 'image', asset: 0 }]);
  const job = q.enqueue(input('m1')).job;
  await q.pump();
  assert.equal(job.status, 'ready');
  assert.deepEqual(job.output, [{ type: 'text', text: '答复' }, { type: 'image', asset: 0 }]);
  q.close();
});
test('restart marks uncertain tasks interrupted and preserves completed replies', () => {
  const dir = root(); const q = new JobQueue(dir, async () => {});
  const a = q.enqueue(input('m1')).job; a.status = 'running'; q.save(a);
  const b = q.enqueue(input('m2')).job; b.status = 'ready'; b.delivery = 'failed'; q.save(b);
  const recovered = new JobQueue(dir, async () => { throw Error('must not run'); });
  assert.equal(recovered.find(a.id,'alice','qq:alice').status, 'interrupted');
  assert.equal(recovered.find(b.id,'alice','qq:alice').status, 'ready');
});
test('job directories from the image-generation era are neither loaded nor deleted', () => {
  // 生图任务的负载（prompt + inputImages）与现在完全不同，语义也已经不适用。
  // 跳过而不是删除，是因为那是用户的数据，不该由程序替他决定。
  const dir = root();
  const legacy = path.join(dir, 'aaaaaaaaaaaa');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'job.json'), JSON.stringify({
    id: 'aaaaaaaaaaaa', owner: 'alice', conversation: 'qq:alice', status: 'ready', prompt: 'a cat', kind: 'image',
  }));
  const q = new JobQueue(dir, async () => {});
  assert.deepEqual(q.jobs, []);
  assert.equal(fs.existsSync(path.join(legacy, 'job.json')), true);
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
  const { job } = q.enqueue({ ...input('m1'), segments: [
    { type: 'text', text: '改成夜晚' },
    { type: 'image', file: staged, ext: 'png', mime: 'image/png', size: 200 },
  ] });
  assert.equal(job.version, JOB_VERSION);
  assert.deepEqual(job.input, [
    { type: 'text', text: '改成夜晚' },
    { type: 'image', file: 'input-0.png', mime: 'image/png', size: 200 },
  ]);
  assert.equal(fs.existsSync(path.join(job.dir, 'input-0.png')), true);
  // The staging copy is consumed, so nothing is left behind to leak or duplicate.
  assert.equal(fs.existsSync(staged), false);
  const recovered = new JobQueue(dir, async () => {});
  assert.deepEqual(recovered.find(job.id, 'alice', 'qq:alice').input, job.input);
});
test('an empty message or too many images is rejected without leaving a job directory', () => {
  const dir = root();
  const q = new JobQueue(dir, async () => {});
  assert.throws(() => q.enqueue({ ...input('m1'), segments: [] }), /既没有文字也没有图片/);
  assert.throws(() => q.enqueue({ ...input('m2'), segments: [{ type: 'text', text: '   ' }] }), /既没有文字也没有图片/);
  assert.throws(() => q.enqueue({ ...input('m3'), segments: [{ type: 'text', text: 'x'.repeat(1501) }] }), /文字最多 1500 字/);
  const many = Array.from({ length: 3 }, () => ({ type: 'image', file: '/nope/a.png', ext: 'png', mime: 'image/png', size: 1 }));
  assert.throws(() => q.enqueue({ ...input('m4'), segments: many }), /一次最多发送 2 张图片/);
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
