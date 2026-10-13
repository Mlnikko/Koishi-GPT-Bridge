const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LMStudioBridge } = require('../../src/bridge/lmstudio-bridge.cjs');
const { JobQueue } = require('../../src/core/queue.cjs');
const { visionPng } = require('../../scripts/vision-fixture.cjs');

async function fixture(t, handler, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmstudio-test-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ url: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [{ key: 'local-chat',
      loaded_instances: [{ id: 'loaded-alias' }], capabilities: { vision: options.vision !== false } }] }));
    if (handler) return handler(req, res, body);
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'local-chat' }, { id: 'text-embedding-nomic' }] }));
    res.end(JSON.stringify({ choices: [{ message: { content: '本地回复' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const bridge = new LMStudioBridge({ root, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, ...options });
  const job = (id, overrides = {}) => {
    const dir = path.join(root, 'jobs', id); fs.mkdirSync(dir, { recursive: true });
    return { id, dir, owner: 'alice', conversation: 'qq:alice', sessionId: 'abcd1234', model: 'local-chat',
      input: [{ type: 'text', text: '记住暗号 8427' }], ...overrides };
  };
  return { root, requests, bridge, job };
}

test('model selection excludes embeddings, validates requested models and requires a choice when ambiguous', async t => {
  const { bridge } = await fixture(t);
  assert.equal(await bridge.resolveModel(), 'local-chat');
  await assert.rejects(bridge.resolveModel('missing'), /未提供聊天模型/);
  bridge.models = async () => ['a', 'b'];
  await assert.rejects(bridge.resolveModel(), /指定.*模型编号/);
  assert.equal(await bridge.resolveModel('b'), 'b');
  bridge.models = async () => [];
  await assert.rejects(bridge.resolveModel(), /尚无聊天模型/);
});

test('context persists across restart, isolates owners/chats/sessions/models, and stores recoverable replies', async t => {
  const { bridge, requests, job } = await fixture(t, null, { apiKey: 'local-secret' });
  const first = job('aaaaaaaaaaaa');
  assert.deepEqual(await bridge.run(first), [{ type: 'text', text: '本地回复' }]);
  const rebooted = new LMStudioBridge({ ...bridge });
  await rebooted.run(job('bbbbbbbbbbbb', { input: [{ type: 'text', text: '暗号是什么？' }] }));
  assert.deepEqual(requests[1].body.messages, [
    { role: 'user', content: '记住暗号 8427' }, { role: 'assistant', content: '本地回复' }, { role: 'user', content: '暗号是什么？' },
  ]);
  assert.equal(requests[0].headers.authorization, 'Bearer local-secret');
  assert.equal(requests[0].body.model, 'local-chat'); assert.equal(requests[0].body.stream, false);
  assert.equal(fs.readFileSync(path.join(first.dir, 'reply.md'), 'utf8'), '本地回复');
  for (const [index, overrides] of [{ owner: 'bob' }, { conversation: 'qq:group' }, { sessionId: 'new' }, { model: 'other-model' }].entries()) {
    await rebooted.run(job(`isolation-${index}`, overrides));
    assert.equal(requests.at(-1).body.messages.length, 1);
  }
  const before = requests.length;
  await rebooted.run(first); assert.equal(requests.length, before, 'committed jobs cannot generate twice');
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.dir, 'result.json'))).id, first.id);
});

test('history budget drops whole pairs and retention does not depend on task files', async t => {
  const { bridge, requests, job } = await fixture(t, null, { historyTurns: 1 });
  const first = job('aaaaaaaaaaaa'); await bridge.run(first);
  fs.rmSync(first.dir, { recursive: true });
  await bridge.run(job('bbbbbbbbbbbb', { input: [{ type: 'text', text: '第二轮' }] }));
  await bridge.run(job('cccccccccccc', { input: [{ type: 'text', text: '第三轮' }] }));
  assert.deepEqual(requests.at(-1).body.messages.map(m => m.content), ['第二轮', '本地回复', '第三轮']);
  bridge.historyChars = 1;
  await bridge.run(job('dddddddddddd'));
  assert.equal(requests.at(-1).body.messages.length, 1);
});

test('cancellation and timeout leave no successful history or receipt and never auto-retry', async t => {
  let reached; const started = new Promise(resolve => { reached = resolve; });
  const { bridge, job, requests } = await fixture(t, () => reached());
  const controller = new AbortController(), first = job('aaaaaaaaaaaa');
  const running = bridge.run(first, { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(running, err => err.code === 'cancelled');
  assert.equal(fs.existsSync(bridge.historyFile(first).file), false);
  assert.equal(fs.existsSync(path.join(first.dir, 'result.json')), false);
  const second = job('bbbbbbbbbbbb');
  await assert.rejects(bridge.run(second, { timeoutMs: 25 }), err => err.code === 'execution_stopped');
  // A short deadline can expire before the server receives the second request
  // on a loaded CI host. Either outcome must remain a single attempt.
  assert.ok(requests.length >= 1 && requests.length <= 2);
  assert.equal(fs.existsSync(bridge.historyFile(second).file), false);
  assert.equal(fs.existsSync(path.join(second.dir, 'result.json')), false);
});

test('HTTP/model failures and empty replies remain failures without committing context', async t => {
  let mode = 'auth';
  const { bridge, job } = await fixture(t, (req, res) => {
    if (mode === 'auth') { res.statusCode = 401; return res.end('{"error":{"message":"unauthorized"}}'); }
    if (mode === 'http') { res.statusCode = 400; return res.end('{"error":{"message":"context window exceeded"}}'); }
    res.end('{"choices":[{"message":{"content":""}}]}');
  });
  const first = job('aaaaaaaaaaaa');
  await assert.rejects(bridge.run(first), /lmStudioApiKey/);
  mode = 'http'; await assert.rejects(bridge.run(first), /context window exceeded/);
  mode = 'empty'; await assert.rejects(bridge.run(first), /未返回可用/);
  assert.equal(fs.existsSync(bridge.historyFile(first).file), false);
});

test('non-JSON authentication responses still identify the actionable authentication failure',async t=>{
 const {bridge,job}=await fixture(t,(_req,res)=>{res.statusCode=401;res.end('<html>authentication required</html>');});
 await assert.rejects(bridge.run(job('html-auth')),err=>err.code==='lmstudio_auth');
});

test('repeated historical images are read and encoded once per request but revalidated on the next message',async t=>{
 const {bridge,job,requests}=await fixture(t);
 const first=imageJob(job,'cache-first',[{type:'image',file:'input-0.png'}]);await bridge.run(first);
 await bridge.run(imageJob(job,'cache-second',[{type:'image',file:'input-0.png'}]));
 const original=bridge.readImage.bind(bridge);
 const read=t.mock.method(bridge,'readImage',(...args)=>original(...args));
 await bridge.run(job('cache-followup'));
 assert.equal(read.mock.calls.length,1);
 const images=chats(requests).at(-1).body.messages.filter(m=>m.role==='user'&&Array.isArray(m.content));
 assert.equal(images.length,2);assert.deepEqual(images[0].content,images[1].content);
 const history=bridge.history(first),asset=history.turns[0].input[0].asset;
 fs.writeFileSync(path.join(history.assets,asset),visionPng({width:64,height:40,variant:1}));
 await assert.rejects(bridge.run(job('cache-tampered')),/校验失败/);
 assert.equal(chats(requests).length,3);
});

test('length-limited responses disclose truncation and invalid image paths are never submitted', async t => {
  const { bridge, job, requests } = await fixture(t, (req, res) => res.end('{"choices":[{"message":{"content":"半段回复"},"finish_reason":"length"}]}'));
  assert.match((await bridge.run(job('aaaaaaaaaaaa')))[0].text, /生成上限/);
  await assert.rejects(bridge.run(job('bbbbbbbbbbbb', { input: [{ type: 'image', file: '../input-0.png' }] })), /文件名无效/);
  assert.equal(requests.length, 1);
});

function imageJob(job, id, input, overrides = {}) {
  const value = job(id, { input, ...overrides });
  let index = 0;
  for (const segment of input) if (segment.type === 'image')
    fs.writeFileSync(path.join(value.dir, segment.file), visionPng({ width: 64, height: 40, variant: index++ }));
  return value;
}
const chats = requests => requests.filter(r => r.url === '/v1/chat/completions');

test('preset system prompts survive history trimming, reserve budget and remain compatible with image turns', async t => {
  const { Presets } = require('../../src/core/presets.cjs');
  const { root, bridge, job, requests } = await fixture(t, null, { historyChars: 60 });
  const presets = new Presets(path.join(root, 'presets'));
  fs.writeFileSync(path.join(presets.dir, 'role.md'), 'r'.repeat(40));
  const preset = presets.read('role');
  const first = imageJob(job, 'preset-image', [{ type: 'image', file: 'input-0.png' }], { preset });
  await bridge.run(first);
  assert.deepEqual(chats(requests)[0].body.messages[0], { role: 'system', content: preset.prompt });
  assert.equal(chats(requests)[0].body.messages[1].content[0].type, 'image_url');
  await new LMStudioBridge({ ...bridge }).run(job('preset-next', { preset, input: [{ type: 'text', text: 'x'.repeat(20) }] }));
  const messages = chats(requests).at(-1).body.messages;
  assert.deepEqual(messages, [{ role: 'system', content: preset.prompt }, { role: 'user', content: 'x'.repeat(20) }]);
  const before = requests.length;
  await assert.rejects(bridge.run(job('preset-overflow', { preset, input: [{ type: 'text', text: 'x'.repeat(21) }] })), /上下文字数/);
  await assert.rejects(bridge.run(job('preset-invalid', { preset: { ...preset, revision: 'bad' } })), /快照/);
  assert.equal(requests.length, before, 'invalid presets must fail before any HTTP submission');
  await bridge.run(first); assert.equal(requests.length, before, 'replaying a committed result never regenerates');
});

test('mixed images preserve their order and exact pixels after restart and job-file pruning', async t => {
  const { bridge, job, requests } = await fixture(t);
  const first = imageJob(job, 'vision-first', [
    { type: 'text', text: '左图' }, { type: 'image', file: 'input-0.png' },
    { type: 'text', text: '右图' }, { type: 'image', file: 'input-1.png' }, { type: 'text', text: '比较它们' },
  ]);
  const pixels = ['input-0.png', 'input-1.png'].map(name => fs.readFileSync(path.join(first.dir, name)));
  await bridge.run(first);
  const payload = chats(requests)[0].body.messages[0].content;
  assert.deepEqual(payload.map(s => s.type), ['text', 'image_url', 'text', 'image_url', 'text']);
  assert.deepEqual(payload.filter(s => s.type === 'image_url').map(s => Buffer.from(s.image_url.url.split(',')[1], 'base64')), pixels);
  const saved = bridge.history(first); assert.equal(saved.turns[0].input.length, 5);
  assert.doesNotMatch(fs.readFileSync(saved.file, 'utf8'), /base64/);
  assert.equal(fs.readdirSync(saved.assets).length, 2);
  fs.rmSync(first.dir, { recursive: true });
  const rebooted = new LMStudioBridge({ ...bridge });
  await rebooted.run(job('vision-second', { input: [{ type: 'text', text: '刚才左图是什么颜色？' }] }));
  assert.deepEqual(chats(requests)[1].body.messages[0].content, payload);
  assert.equal(chats(requests)[1].body.messages.at(-1).content, '刚才左图是什么颜色？');
  for (const [index, overrides] of [{ owner: 'bob' }, { conversation: 'qq:group' }, { sessionId: 'new' }, { model: 'other-model' }].entries()) {
    await rebooted.run(job('vision-isolated-' + index, overrides));
    assert.equal(chats(requests).at(-1).body.messages.length, 1);
  }
});

test('image-only prompts and loaded model aliases are accepted without fabricated instructions', async t => {
  const { bridge, job, requests } = await fixture(t);
  await bridge.run(imageJob(job, 'only-image', [{ type: 'image', file: 'input-0.png' }], { model: 'loaded-alias' }));
  assert.deepEqual(chats(requests)[0].body.messages[0].content.map(s => s.type), ['image_url']);
  assert.equal(chats(requests)[0].body.model, 'loaded-alias');
});

test('vision capability is checked before inference, including text follow-ups with image history', async t => {
  const { bridge, job, requests } = await fixture(t, null, { vision: false });
  const first = imageJob(job, 'unsupported', [{ type: 'image', file: 'input-0.png' }]);
  await assert.rejects(bridge.run(first), /不支持图片/);
  assert.equal(chats(requests).length, 0);
  assert.equal(fs.existsSync(bridge.historyFile(first).file), false);
  const good = await fixture(t);
  await good.bridge.run(imageJob(good.job, 'supported', [{ type: 'image', file: 'input-0.png' }]));
  good.bridge.ensureVision = bridge.ensureVision.bind(bridge);
  await assert.rejects(good.bridge.run(good.job('followup')), /不支持图片/);
  assert.equal(chats(good.requests).length, 1);
});

test('legacy text history remains readable and acquires image context without migrating old records', async t => {
  const { bridge, job, requests } = await fixture(t);
  const first = job('legacy'); const history = bridge.historyFile(first);
  fs.mkdirSync(path.dirname(history.file), { recursive: true });
  fs.writeFileSync(history.file, JSON.stringify({ version: 1, identity: history.identity,
    turns: [{ id: 'old', user: '旧问题', assistant: '旧回答' }] }));
  await bridge.run(imageJob(job, 'new-image', [{ type: 'image', file: 'input-0.png' }]));
  assert.deepEqual(chats(requests)[0].body.messages.slice(0, 2), [
    { role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' },
  ]);
});

test('image count/byte budgets drop whole turns and remove only unreferenced assets', async t => {
  const { bridge, job, requests } = await fixture(t, null, { historyImages: 1 });
  const first = imageJob(job, 'first-image', [{ type: 'image', file: 'input-0.png' }]); await bridge.run(first);
  const saved = bridge.history(first), oldAsset = fs.readdirSync(saved.assets)[0];
  const second = imageJob(job, 'second-image', [{ type: 'text', text: '新图' }, { type: 'image', file: 'input-0.png' }]);
  fs.writeFileSync(path.join(second.dir, 'input-0.png'), visionPng({ width: 64, height: 40, variant: 1 }));
  await bridge.run(second);
  assert.equal(chats(requests)[1].body.messages.length, 1, 'old pair is removed before the new image is submitted');
  assert.equal(fs.readdirSync(saved.assets).length, 1); assert.equal(fs.existsSync(path.join(saved.assets, oldAsset)), false);
  const tooMany = imageJob(job, 'too-many', [{ type: 'image', file: 'input-0.png' }, { type: 'image', file: 'input-1.png' }]);
  await assert.rejects(bridge.run(tooMany), /图片超过/);
  bridge.historyImageBytes = 1;
  await bridge.run(job('text-after-budget'));
  assert.equal(chats(requests).at(-1).body.messages.length, 1);
  assert.deepEqual(fs.readdirSync(saved.assets), []);
  await assert.rejects(bridge.run(imageJob(job, 'too-large', [{ type: 'image', file: 'input-0.png' }])), /图片超过/);
});

test('tampered, missing and symlinked images fail without submitting or changing committed history', async t => {
  const { bridge, job, requests } = await fixture(t);
  const first = imageJob(job, 'valid-image', [{ type: 'image', file: 'input-0.png' }]); await bridge.run(first);
  const saved = bridge.history(first), asset = path.join(saved.assets, saved.turns[0].input[0].asset);
  const before = fs.readFileSync(saved.file, 'utf8');
  fs.writeFileSync(asset, visionPng({ width: 64, height: 40, variant: 1 }));
  await assert.rejects(bridge.run(job('tampered')), /校验失败/);
  fs.unlinkSync(asset);
  await assert.rejects(bridge.run(job('missing')), /文件缺失/);
  fs.symlinkSync(path.join(first.dir, 'input-0.png'), asset);
  await assert.rejects(bridge.run(job('symlink')), /文件无效/);
  assert.equal(chats(requests).length, 1); assert.equal(fs.readFileSync(saved.file, 'utf8'), before);
});

test('cancelled image inference saves neither a turn nor conversation images', async t => {
  let reached; const started = new Promise(resolve => { reached = resolve; });
  const { bridge, job, requests } = await fixture(t, () => reached());
  const first = imageJob(job, 'cancel-image', [{ type: 'image', file: 'input-0.png' }]);
  const controller = new AbortController(), running = bridge.run(first, { signal: controller.signal });
  await started; controller.abort(); await assert.rejects(running, err => err.code === 'cancelled');
  const history = bridge.historyFile(first);
  assert.equal(fs.existsSync(history.file), false); assert.equal(fs.existsSync(history.assets), false);
  assert.equal(chats(requests).length, 1);
});

test('queue recovers an LM Studio receipt after restart without re-generating', async t => {
  const { bridge, requests, root } = await fixture(t);
  const queue = new JobQueue(path.join(root, 'jobs'), (j, signal) => bridge.run(j, { signal }));
  const { job } = queue.enqueue({ owner: 'alice', conversation: 'qq:alice', sessionId: 'abcd1234', backend: 'lmstudio', model: 'local-chat', segments: [{ type: 'text', text: '你好' }] });
  await queue.pump();
  job.status = 'running'; queue.save(job);
  const rebooted = new JobQueue(path.join(root, 'jobs'), () => { throw Error('must never re-submit'); });
  assert.equal(rebooted.jobs[0].status, 'ready');
  assert.deepEqual(rebooted.jobs[0].output, [{ type: 'text', text: '本地回复' }]);
  assert.equal(rebooted.jobs[0].model, 'local-chat');
  assert.equal(requests.length, 1);
});
