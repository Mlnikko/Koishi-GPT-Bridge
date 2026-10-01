const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebBridge } = require('../src/bridge/web-bridge.cjs');
const { JobQueue } = require('../src/core/queue.cjs');
const { toSegments, submissionText } = require('../src/core/message.cjs');
const { toMessages } = require('../src/lib/reply.cjs');
const { downloadImage } = require('../src/lib/image.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
const thread = '11111111-2222-3333-4444-555555555555';
function png(width = 8, height = 8, size = 256) {
  const bytes = Buffer.alloc(size);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'latin1').copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

// Wires the real modules together the way index.cjs does, so the whole chain is
// exercised: QQ elements -> ordered segments -> guarded download -> persisted job
// -> local bridge -> extension fetch -> returned reply.
async function chain(t, elements) {
  const root = temp();
  const bridge = new WebBridge({ root, port: 0 });
  await bridge.ready; t.after(() => bridge.close());
  const queue = new JobQueue(path.join(root, 'jobs'), (job, signal, onThread) => bridge.run(job, { signal, onThread }));
  t.after(() => queue.close());

  const segments = toSegments(elements);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  const prepared = [];
  for (const segment of segments) {
    if (segment.type === 'text') { prepared.push(segment); continue; }
    const image = await downloadImage(segment.source, staging);
    prepared.push({ type: 'image', file: image.file, ext: image.ext, mime: image.mime, size: image.size });
  }
  const { job } = queue.enqueue({ owner: 'alice', conversation: 'qq:alice', messageId: 'm1', segments: prepared });

  const call = (route, body, token = bridge.token) => fetch(`http://127.0.0.1:${bridge.port}${route}`,
    { method: body ? 'POST' : 'GET', headers: { 'x-bridge-token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
  const asset = (route, bytes, token = bridge.token) => fetch(`http://127.0.0.1:${bridge.port}${route}`,
    { method: 'POST', headers: { 'x-bridge-token': token, 'Content-Type': 'image/png' }, body: bytes });
  await call('/state'); // the extension announces itself before the job starts
  const running = queue.pump();
  await new Promise(setImmediate);
  return { bridge, queue, job, call, asset, running };
}

test('a pure image QQ message reaches ChatGPT as an attachment with no text', async t => {
  const elements = [{ type: 'img', attrs: { src: `data:image/png;base64,${png(32, 32).toString('base64')}` } }];
  const { queue, job, call, running } = await chain(t, elements);

  assert.equal(job.version, 2);
  assert.equal(submissionText(job.input), '');
  assert.deepEqual(job.input, [{ type: 'image', file: 'input-0.png', mime: 'image/png', size: 256 }]);

  const state = await (await call('/state')).json();
  assert.equal(state.job.id, job.id);
  assert.equal(state.job.text, '');
  assert.deepEqual(state.job.images, [{ index: 0, mime: 'image/png', name: 'input-0.png', size: 256 }]);

  const bytes = Buffer.from(await (await call(`/input?id=${job.id}&i=0`)).arrayBuffer());
  assert.deepEqual(bytes, fs.readFileSync(path.join(job.dir, 'input-0.png')));

  assert.equal((await call('/result', { id: job.id, threadId: thread,
    segments: [{ type: 'text', text: '这是按你的图改好的版本。' }] })).status, 200);
  await running;
  const finished = queue.find(job.id, 'alice', 'qq:alice');
  assert.equal(finished.status, 'ready');
  assert.equal(finished.threadId, thread);
  assert.deepEqual(finished.output, [{ type: 'text', text: '这是按你的图改好的版本。' }]);
});

test('an image plus text message keeps the text as the instruction, in order', async t => {
  const elements = [
    { type: 'img', attrs: { src: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString('base64')}` } },
    { type: 'text', attrs: { content: ' 把背景改成夜晚 ' } },
  ];
  const { queue, job, call, running } = await chain(t, elements);

  assert.equal(submissionText(job.input), '把背景改成夜晚');
  assert.deepEqual(job.input.map(segment => segment.type), ['image', 'text']);
  assert.equal(job.input[0].mime, 'image/jpeg');

  const state = await (await call('/state')).json();
  assert.equal(state.job.text, '把背景改成夜晚');
  assert.equal(state.job.images[0].mime, 'image/jpeg');
  assert.equal((await call(`/input?id=${job.id}&i=0`)).status, 200);

  await call('/failure', { id: job.id, message: 'ChatGPT 页面加载超时' });
  await running;
  const finished = queue.find(job.id, 'alice', 'qq:alice');
  assert.equal(finished.status, 'failed');
  assert.equal(finished.errorCode, 'browser_interaction');
});

test('a failed download never creates a job and never reaches the bridge', async t => {
  const root = temp();
  const bridge = new WebBridge({ root, port: 0 });
  await bridge.ready; t.after(() => bridge.close());
  const queue = new JobQueue(path.join(root, 'jobs'), () => { throw Error('must not run'); });
  t.after(() => queue.close());

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  const segments = toSegments([{ type: 'img', attrs: { src: 'file:///etc/passwd' } }]);
  await assert.rejects(downloadImage(segments[0].source, staging), err => err.code === 'image_invalid');
  assert.deepEqual(fs.readdirSync(staging), []);
  assert.deepEqual(queue.jobs, []);
  const state = await (await fetch(`http://127.0.0.1:${bridge.port}/state`, { headers: { 'x-bridge-token': bridge.token } })).json();
  assert.equal(state.job, null);
});

test('a reply with text and pictures renders into ordered QQ messages', async t => {
  const { job, call, asset, running } = await chain(t, [{ type: 'text', attrs: { content: '给我两个方案' } }]);
  assert.equal((await asset(`/result-asset?id=${job.id}&i=0`, png(1024, 768))).status, 200);
  assert.equal((await asset(`/result-asset?id=${job.id}&i=1`, png(640, 480))).status, 200);
  assert.equal((await call('/result', { id: job.id, threadId: thread, segments: [
    { type: 'text', text: '方案一：' },
    { type: 'image', asset: 0, mime: 'image/png' },
    { type: 'text', text: '方案二：' },
    { type: 'image', asset: 1, mime: 'image/png' },
  ] })).status, 200);
  await running;
  const { messages } = toMessages(job.output, { maxChars: 1500, maxTotal: 6000 });
  assert.deepEqual(messages, [
    { type: 'text', text: '方案一：' },
    { type: 'image', asset: 0 },
    { type: 'text', text: '方案二：' },
    { type: 'image', asset: 1 },
  ]);
  for (const message of messages.filter(item => item.type === 'image'))
    assert.equal(fs.existsSync(path.join(job.dir, `result-${message.asset}.png`)), true);
  assert.equal(fs.readFileSync(path.join(job.dir, 'reply.md'), 'utf8'), '方案一：\n\n方案二：');
});
