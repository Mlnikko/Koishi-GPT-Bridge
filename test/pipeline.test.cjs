const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebBridge } = require('../src/bridge/web-bridge.cjs');
const { JobQueue } = require('../src/core/queue.cjs');
const { downloadImage, messageImages, messageText, pngSize } = require('../src/lib/image.cjs');

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

// Wires the real modules together the way plugin.cjs does, so the whole chain is
// exercised: QQ elements -> guarded download -> persisted job -> local bridge ->
// extension fetch -> returned PNG.
async function chain(t, elements, prompt) {
  const root = temp();
  const bridge = new WebBridge({ root, port: 0 });
  await bridge.ready; t.after(() => bridge.close());
  const queue = new JobQueue(path.join(root, 'jobs'), (job, signal, onThread) => bridge.run(job, { signal, onThread }));
  t.after(() => queue.close());

  const sources = messageImages(elements);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  const images = [];
  for (const source of sources) images.push(await downloadImage(source, staging));

  const { job } = queue.enqueue({ owner: 'alice', conversation: 'qq:alice', messageId: 'm1',
    prompt: prompt ?? messageText(elements), inputImages: images });

  const call = (route, body, token = bridge.token) => fetch(`http://127.0.0.1:${bridge.port}${route}`,
    { method: body ? 'POST' : 'GET', headers: { 'x-bridge-token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
  await call('/state'); // the extension announces itself before the job starts
  const running = queue.pump();
  await new Promise(setImmediate);
  return { bridge, queue, job, call, running };
}

test('a pure image QQ message reaches ChatGPT and returns a generated PNG', async t => {
  const elements = [{ type: 'img', attrs: { src: `data:image/png;base64,${png(32, 32).toString('base64')}` } }];
  const { queue, job, call, running } = await chain(t, elements);

  assert.equal(job.kind, 'image');
  assert.equal(job.prompt, '');
  assert.deepEqual(job.inputImages.map(image => image.file), ['input-0.png']);

  const state = await (await call('/state')).json();
  assert.equal(state.job.id, job.id);
  assert.deepEqual(state.job.images, [{ index: 0, mime: 'image/png', name: 'input-0.png', size: 256 }]);

  const bytes = Buffer.from(await (await call(`/input?id=${job.id}&i=0`)).arrayBuffer());
  assert.deepEqual(bytes, fs.readFileSync(path.join(job.dir, 'input-0.png')));
  assert.deepEqual(pngSize(bytes), { width: 32, height: 32 });

  assert.equal((await call('/result', { id: job.id, threadId: thread, base64: png(1254, 1254).toString('base64') })).status, 200);
  await running;
  const finished = queue.find(job.id, 'alice', 'qq:alice');
  assert.equal(finished.status, 'ready');
  assert.equal(finished.threadId, thread);
  assert.deepEqual(pngSize(fs.readFileSync(path.join(job.dir, 'result.png'))), { width: 1254, height: 1254 });
});

test('an image plus text message keeps the text as the instruction', async t => {
  const elements = [
    { type: 'img', attrs: { src: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString('base64')}` } },
    { type: 'text', attrs: { content: ' 把背景改成夜晚 ' } },
  ];
  const { queue, job, call, running } = await chain(t, elements);

  assert.equal(job.kind, 'image');
  assert.equal(job.prompt, '把背景改成夜晚');
  assert.deepEqual(job.inputImages.map(image => image.file), ['input-0.jpg']);
  assert.equal(job.inputImages[0].mime, 'image/jpeg');

  const state = await (await call('/state')).json();
  assert.equal(state.job.images[0].mime, 'image/jpeg');
  assert.equal((await call(`/input?id=${job.id}&i=0`)).status, 200);

  await call('/failure', { id: job.id, message: '抱歉，我不能生成该图片。' });
  await running;
  const finished = queue.find(job.id, 'alice', 'qq:alice');
  assert.equal(finished.status, 'failed');
  assert.equal(finished.errorCode, 'refused');
  assert.equal(fs.existsSync(path.join(job.dir, 'result.png')), false);
});

test('a failed download never creates a job and never reaches the bridge', async t => {
  const root = temp();
  const bridge = new WebBridge({ root, port: 0 });
  await bridge.ready; t.after(() => bridge.close());
  const queue = new JobQueue(path.join(root, 'jobs'), () => { throw Error('must not run'); });
  t.after(() => queue.close());

  const elements = [{ type: 'img', attrs: { src: 'file:///etc/passwd' } }];
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  await assert.rejects(downloadImage(messageImages(elements)[0], staging), err => err.code === 'image_invalid');
  assert.deepEqual(fs.readdirSync(staging), []);
  assert.deepEqual(queue.jobs, []);
  const state = await (await fetch(`http://127.0.0.1:${bridge.port}/state`, { headers: { 'x-bridge-token': bridge.token } })).json();
  assert.equal(state.job, null);
});
