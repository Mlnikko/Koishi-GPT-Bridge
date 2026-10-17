const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobQueue, JOB_VERSION } = require('../../src/core/queue.cjs');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-queue-test-'));
const input = id => ({ owner: 'alice', conversation: 'qq:alice', messageId: id, segments: [{ type: 'text', text: 'a cat' }] });

test('web and local skill snapshots survive edits, deduplication and restart without touching user input', () => {
  const { parseSkill } = require('../../src/core/skills.cjs');
  const dir = root(), q = new JobQueue(dir, () => assert.fail('must not submit'));
  const skill = parseSkill('---\nname: summarize\ndescription: 整理\n---\n原始技能指令', 'summarize');
  assert.throws(() => q.enqueue({ ...input('bad'), skill: { ...skill, instructions: 'tampered' } }), /快照/);
  const first = q.enqueue({ ...input('web'), skill }).job;
  const second = q.enqueue({ ...input('local'), backend: 'lmstudio', model: 'local', skill }).job;
  skill.instructions = 'changed';
  assert.equal(first.skill.instructions, '原始技能指令');
  assert.equal(second.skill.instructions, '原始技能指令');
  assert.equal(q.enqueue({ ...input('web'), skill }).job, first);
  assert.equal(first.input[0].text, 'a cat');
  const restored = new JobQueue(dir, () => assert.fail('must not submit'));
  assert.equal(restored.jobs.length, 2);
  assert.ok(restored.jobs.every(j => j.skill.instructions === '原始技能指令' && j.status === 'interrupted'));
  q.close(); restored.close();
});
for (const [ext, bytes] of [
  ['png', require('../../scripts/vision-fixture.cjs').visionPng({ width: 32, height: 32 })],
  ['gif', require('../helpers/media.cjs').animatedGif()],
  ['jpg', Buffer.concat([Buffer.from('ffd8ff','hex'), Buffer.alloc(61)])],
  ['webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(52)])],
]) test('restart recovers committed ' + ext + ' bytes with the correct MIME and no regeneration', async () => {
  const dir=root(),q=new JobQueue(dir,()=>assert.fail('must not resubmit'));
  const j=q.enqueue(input('media-receipt')).job;j.status='running';q.save(j);
  fs.writeFileSync(path.join(j.dir,'result-0.'+ext),bytes);
  fs.writeFileSync(path.join(j.dir,'result.json'),JSON.stringify({id:j.id,segments:[{type:'image',asset:0}]}));
  const recovered=new JobQueue(dir,()=>assert.fail('must not resubmit'));
  assert.equal(recovered.jobs[0].status,'ready');
  assert.equal(recovered.jobs[0].output[0].mime,{'png':'image/png','gif':'image/gif','jpg':'image/jpeg','webp':'image/webp'}[ext]);
  assert.deepEqual(fs.readFileSync(path.join(j.dir,'result-0.'+ext)),bytes);
  await recovered.pump();recovered.close();
});

for (const fault of ['missing','wrong-format','ambiguous','symlink'])
test('an incomplete or ambiguous media receipt remains interrupted: ' + fault, () => {
  const dir=root(),q=new JobQueue(dir,()=>assert.fail('must not resubmit'));
  const j=q.enqueue(input('invalid-receipt')).job;j.status='running';q.save(j);
  const bytes=require('../helpers/media.cjs').animatedGif();
  if(fault==='wrong-format')fs.writeFileSync(path.join(j.dir,'result-0.png'),bytes);
  if(fault==='ambiguous'){
    fs.writeFileSync(path.join(j.dir,'result-0.gif'),bytes);
    fs.writeFileSync(path.join(j.dir,'result-0.png'),require('../../scripts/vision-fixture.cjs').visionPng());
  }
  if(fault==='symlink'){
    fs.writeFileSync(path.join(dir,'outside.gif'),bytes);
    fs.symlinkSync(path.join(dir,'outside.gif'),path.join(j.dir,'result-0.gif'));
  }
  fs.writeFileSync(path.join(j.dir,'result.json'),JSON.stringify({id:j.id,segments:[{type:'image',asset:0}]}));
  const recovered=new JobQueue(dir,()=>assert.fail('must not resubmit'));
  assert.equal(recovered.jobs[0].status,'interrupted');
});
test('local preset snapshots survive queueing, deduplication and restart; web tasks reject them', () => {
  const { Presets } = require('../../src/core/presets.cjs');
  const dir = root(), presets = new Presets(path.join(dir, 'presets'));
  fs.writeFileSync(path.join(presets.dir, 'role.md'), 'original');
  const preset = presets.read('role'), q = new JobQueue(path.join(dir, 'jobs'), () => assert.fail('must not submit'));
  assert.throws(() => q.enqueue({ ...input('web'), preset }), /只适用于本地/);
  assert.throws(() => q.enqueue({ ...input('invalid'), backend: 'lmstudio', preset: { ...preset, prompt: 'tampered' } }), /快照/);
  const first = q.enqueue({ ...input('m1'), backend: 'lmstudio', model: 'local', preset }).job;
  preset.prompt = 'mutated'; fs.writeFileSync(path.join(presets.dir, 'role.md'), 'edited');
  assert.equal(first.preset.prompt, 'original');
  assert.equal(q.enqueue({ ...input('m1'), backend: 'lmstudio', preset: presets.read('role') }).job.preset.prompt, 'original');
  const restored = new JobQueue(q.root, () => assert.fail('must not submit'));
  assert.equal(restored.jobs[0].preset.prompt, 'original');
  assert.equal(restored.jobs[0].status, 'interrupted');
});
test('queued reasoning is validated and retained across restarts and duplicate messages', () => {
  const dir = root(), q = new JobQueue(dir, async () => {});
  assert.throws(() => q.enqueue({ ...input('invalid'), reasoningEffort: 'unknown' }), /用法/);
  assert.equal(q.jobs.length, 0); assert.deepEqual(fs.readdirSync(dir), []);
  const first = q.enqueue({ ...input('m1'), reasoningEffort: '高' }).job;
  assert.equal(first.reasoningEffort, 'high');
  const duplicate = q.enqueue({ ...input('m1'), reasoningEffort: 'pro' });
  assert.equal(duplicate.job.reasoningEffort, 'high'); assert.equal(duplicate.duplicate, true);
  const recovered = new JobQueue(dir, () => assert.fail('must not resubmit'));
  assert.equal(recovered.jobs[0].reasoningEffort, 'high');
});

test('restart recovers an acknowledged structured result without resubmitting', () => {
  const dir = root(), q = new JobQueue(dir, async () => {});
  const j = q.enqueue(input('receipt')).job;
  j.status = 'running'; q.save(j);
  const segments = [{ type: 'text', text: 'already generated' }];
  fs.writeFileSync(path.join(j.dir, 'result.json'), JSON.stringify({ id: j.id, segments }));
  const recovered = new JobQueue(dir, () => assert.fail('must not resubmit'));
  assert.equal(recovered.jobs[0].status, 'ready');
  assert.deepEqual(recovered.jobs[0].output, segments);
});

test('a failing notification does not prevent submission or block the next task', async () => {
  let runs = 0;
  const q = new JobQueue(root(), async () => { runs++; return [{ type: 'text', text: 'ok' }]; }, async () => { throw Error('notification failed'); });
  q.enqueue(input('a')); q.enqueue(input('b'));
  await q.pump(); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(runs, 2); assert.equal(q.active, null); q.close();
});

test('slow final delivery releases the execution slot without allowing simultaneous generation',async()=>{
 let finishDelivery,finishSecond;
 const held=new Promise(resolve=>{finishDelivery=resolve;}),secondHeld=new Promise(resolve=>{finishSecond=resolve;});const runs=[];
 const q=new JobQueue(root(),async job=>{runs.push(job.messageId);if(job.messageId==='second')await secondHeld;return [{type:'text',text:'ok'}];},
  async job=>{if(job.messageId==='first'&&job.status==='ready')await held;});
 q.enqueue(input('first'));q.enqueue(input('second'));q.enqueue(input('third'));
 const first=q.pump();await new Promise(setImmediate);await new Promise(setImmediate);
 const whileDelivering=[...runs];finishDelivery();await first;await new Promise(setImmediate);
 const secondStillActive=q.active?.job.messageId;await q.pump();const beforeRelease=[...runs];
 finishSecond();await new Promise(setImmediate);await new Promise(setImmediate);q.close();
 assert.deepEqual(whileDelivering,['first','second']);
 assert.equal(secondStillActive,'second');assert.deepEqual(beforeRelease,['first','second']);
 assert.deepEqual(runs,['first','second','third']);
});

test('a save failure releases the active slot and does not submit untracked work', async () => {
  let runs = 0;
  const q = new JobQueue(root(), async () => { runs++; });
  const j = q.enqueue(input('a')).job;
  q.save = () => { throw Error('disk full'); };
  await q.pump(); q.close();
  assert.equal(runs, 0); assert.equal(q.active, null);
  assert.equal(j.status, 'failed'); assert.match(j.persistenceError, /disk full/);
});

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

test('enqueue atomically rejects a second pending message in the same session', () => {
  const q = new JobQueue(root(), async () => {});
  const first = q.enqueue({ ...input('m1'), sessionId: 'same' }).job;
  assert.throws(() => q.enqueue({ ...input('m2'), sessionId: 'same' }), /仍在处理上一条/);
  assert.equal(q.enqueue({ ...input('m1'), sessionId: 'same' }).duplicate, true);
  q.cancel(first);
  assert.ok(first.finishedAt);
  assert.ok(q.enqueue({ ...input('m2'), sessionId: 'same' }).job);
});

test('restart preserves terminal retention timestamps and chronological history', () => {
  const dir = root();
  const q = new JobQueue(dir, async () => {});
  for (let index = 0; index < 4; index++) {
    const job = q.enqueue(input(`old-${index}`)).job;
    job.status = 'failed';
    job.createdAt = Date.now() - (20 - index) * 86400000;
    job.updatedAt = job.createdAt;
    fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(job));
  }
  const restored = new JobQueue(dir, async () => {});
  assert.deepEqual(restored.jobs.map(j => j.messageId), ['old-0', 'old-1', 'old-2', 'old-3']);
  assert.equal(restored.prune(7), 4);
});

test('messages without platform IDs are not mistaken for duplicates', async () => {
  const q = new JobQueue(root(), async () => []);
  q.enqueue(input(undefined));
  q.enqueue(input(undefined));
  assert.equal(q.jobs.length, 2);
  q.close();
});

test('latest and duplicate indexes rebuild after retention pruning and preserve owner isolation',()=>{
 const q=new JobQueue(root(),()=>assert.fail('must not run'));
 const first=q.enqueue({...input('m1'),sessionId:'same'}).job;first.status='ready';q.save(first);
 const second=q.enqueue({...input('m2'),sessionId:'same'}).job;second.status='ready';q.save(second);
 assert.equal(q.find(undefined,'alice','qq:alice','same').id,second.id);
 assert.equal(q.duplicate('bob','qq:alice','m2'),undefined);
 second.finishedAt=Date.now()-10*86400000;q.save(second);
 assert.equal(q.prune(7),1);assert.equal(q.find(undefined,'alice','qq:alice','same').id,first.id);
 assert.equal(q.duplicate('alice','qq:alice','m2'),undefined);assert.equal(q.busy('same'),false);
 assert.ok(q.enqueue({...input('m2'),sessionId:'same'}).job);assert.equal(q.busy('same'),true);
});

test('failed state writes cannot leave a false full or busy slot after disk recovery',async()=>{
 const q=new JobQueue(root(),async()=>[]),save=q.save.bind(q);
 const first=q.enqueue({...input('m1'),sessionId:'same'}).job;
 q.save=()=>{throw Error('disk full');};await q.pump();q.save=save;
 assert.equal(first.status,'failed');assert.equal(q.busy('same'),false);
 assert.ok(q.enqueue({...input('m2'),sessionId:'same'}).job);q.close();
});
