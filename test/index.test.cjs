const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const plugin = require('../src/index.cjs');
const { visionPng } = require('../scripts/vision-fixture.cjs');
const { animatedGif } = require('./helpers/media.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-test-'));
const wait = () => new Promise(resolve => setImmediate(resolve));
// A minimal but structurally valid PNG: the downloader only sniffs magic bytes,
// while the reply validator parses the IHDR header, so both need to be satisfied.
const pngBytes = (size = 300, width = 8, height = 8) => {
  const bytes = Buffer.alloc(size);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'latin1').copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};
const png = (size = 300) => `data:image/png;base64,${pngBytes(size).toString('base64')}`;
const THREAD = '11111111-2222-3333-4444-555555555555';

const apps = [];

// A minimal stand-in for the parts of the Koishi context this plugin uses. It
// models the two behaviours the wiring actually depends on: registration order
// (slash-command router first, then the catch-all forwarder) and Koishi's
// `next(fallback)` semantics, where the remaining stages run first and the
// fallback only fires when nothing downstream produced a result.
function harness() {
  const stages = [], intervals = [], disposes = [], timers = [];
  const scope = filter => ({
    command: definition => ({ action: handler => { stages.push({ kind: 'command', name: definition.split(' ')[0], handler, filter }); } }),
    middleware: callback => { stages.push({ kind: 'middleware', callback, filter }); },
  });
  const ctx = {
    intersect: filter => scope(filter),
    setInterval: (fn, ms) => { intervals.push(ms); timers.push({ fn, ms }); },
    on: (event, fn) => { if (event === 'dispose') disposes.push(fn); },
    logger: () => ({ info: () => {} }),
  };
  return { ctx, stages, intervals, disposes, timers };
}
function session({ userId = 'alice', isDirect = true, channelId = 'alice', messageId = 'm1', elements = [], sent = [], stripped } = {}) {
  return { platform: 'qq', userId, channelId, isDirect, messageId, elements, sent, timestamp: Date.now(), stripped,
    send: async content => { sent.push(content); return ['msg-id']; } };
}
async function dispatch({ stages }, s, text) {
  const previous = s.stripped;
  if (text !== undefined) s.stripped = { ...previous, content: text };
  const run = async index => {
    if (index >= stages.length) return { handled: false };
    const stage = stages[index];
    if (stage.filter && !stage.filter(s)) return run(index + 1);
    if (stage.kind === 'command') {
      if (!text || text.split(' ')[0] !== stage.name) return run(index + 1);
      return { handled: true, value: await stage.handler({ session: s }, ...text.split(' ').slice(1)) };
    }
    const next = async fallback => {
      const rest = await run(index + 1);
      if (rest.handled) return rest;
      return typeof fallback === 'function' ? { handled: true, value: await fallback() } : rest;
    };
    const raw = await stage.callback(s, next);
    return raw && typeof raw === 'object' && 'handled' in raw ? raw : { handled: true, value: raw };
  };
  try {
    const outcome = await run(0);
    return outcome.handled ? outcome.value : undefined;
  } finally { s.stripped = previous; }
}
const apply = (config = {}) => {
  const root = config.dataDir || temp();
  const built = harness();
  plugin.apply(built.ctx, { allowedUsers: ['*'], dataDir: root, webBridgePort: 0, ...config });
  apps.push(built);
  return { ...built, root };
};
// The bridge is a real HTTP server, so every harness it built has to be disposed
// or the test process would never exit.
after(() => { for (const app of apps) for (const dispose of app.disposes) { try { dispose(); } catch {} } });

const jobFiles = root => {
  const dir = path.join(root, 'jobs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(id => JSON.parse(fs.readFileSync(path.join(dir, id, 'job.json'), 'utf8')));
};
const settle = async (root, timeout = 4000) => {
  const started = Date.now();
  for (;;) {
    const jobs = jobFiles(root);
    // A terminal job is saved before its async QQ delivery hook completes.
    // Wait for the receipt too, rather than relying on router microtask count.
    if (jobs.length && jobs.every(j => !['queued', 'running'].includes(j.status)
      && (j.status !== 'failed' || j.feedbackDelivery)
      && (j.status !== 'ready' || ['sent', 'failed'].includes(j.delivery)))) return jobs;
    if (Date.now() - started > timeout) throw new Error('任务未在预期时间内结束');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
// The bridge picks its own port when asked for 0; it records the real one on disk.
const bridgeOf = async root => {
  const file = path.join(root, 'web-bridge-port');
  for (let attempt = 0; attempt < 300; attempt++) {
    if (fs.existsSync(file)) return {
      port: Number(fs.readFileSync(file, 'utf8')),
      token: fs.readFileSync(path.join(root, 'web-bridge-token'), 'utf8').trim(),
    };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('桥接端口未就绪');
};

test('all conversation creation routes default to the username', async () => {
  for (const command of ['/new', '/backend', '/reasoning high', '/prompt 角色海报', '/preset 测试角色', '/skill summarize-text', undefined]) {
    const app = apply();
    fs.writeFileSync(path.join(app.root, 'presets', '测试角色.md'), '角色设定');
    const s = Object.assign(session({ elements: [{ type: 'text', attrs: { content: '你好' } }] }), { username: ' 小明 ' });
    await dispatch(app, s, command);
    const data = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json')));
    assert.equal(data.items[0].name, '小明', command);
  }
});

test('default names fall back safely and explicit names take priority', async () => {
  const app = apply();
  for (const [fields, expected] of [
    [{ username: '   ', event: { user: { name: '平台昵称' } } }, '平台昵称'],
    [{}, 'alice'],
    [{ username: '长'.repeat(60) }, '长'.repeat(40)],
  ]) {
    const s = Object.assign(session(), fields);
    await dispatch(app, s, '/new');
    const data = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json')));
    assert.equal(data.items.at(-1).name, expected);
  }
  assert.match(await dispatch(app, Object.assign(session(), { username: '小明' }), '/new 自定义 名称'), /已开启：自定义 名称/);
});

test('rename persists without changing context and only changes the current owned conversation', async () => {
  const app = apply({ groupChat: true });
  const s = Object.assign(session(), { username: '小明' });
  assert.match(await dispatch(app, s, '/rename 新名称'), /暂无当前会话/);
  await dispatch(app, s, '/new');
  const file = path.join(app.root, 'conversations.json');
  const { Conversations } = require('../src/core/conversations.cjs');
  const c = new Conversations(file), first = c.current('alice', 'qq:alice');
  c.bindWeb(first, THREAD);
  // Reload to model an existing conversation with a bound web history.
  const restored = apply({ dataDir: app.root, groupChat: true });
  const before = JSON.parse(fs.readFileSync(file)).items[0];
  assert.match(await dispatch(restored, session({ userId: 'bob' }), '/rename 偷改'), /暂无当前会话/);
  assert.match(await dispatch(restored, session({ isDirect: false, channelId: 'group', stripped: { appel: true } }), '/rename 偷改'), /暂无当前会话/);
  assert.match(await dispatch(restored, s, '/rename'), /用法/);
  assert.match(await dispatch(restored, s, `/rename ${'长'.repeat(41)}`), /最多 40 字/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).items[0], before);
  assert.match(await dispatch(restored, s, '/rename 我的 绘图'), /已重命名：我的 绘图/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).items[0], { ...before, name: '我的 绘图' });
  await dispatch(restored, s, '/backend');
  assert.match(await dispatch(restored, s, '/chat'), /我的 绘图/);
  await dispatch(restored, s, '/new 第二个');
  await dispatch(restored, s, `/chat ${first.id}`);
  await dispatch(restored, s, '/rename 再次修改');
  const recovered = new Conversations(file);
  assert.equal(recovered.current('alice', 'qq:alice').name, '再次修改');
  assert.equal(recovered.list('alice', 'qq:alice')[1].name, '第二个');
  assert.deepEqual(jobFiles(app.root), []);
  assert.match(await dispatch(apply({ dataDir: app.root }), s, '/chat'), /再次修改/);
});

test('a private message is forwarded as-is and persisted as a job', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'img', attrs: { src: png() } }, { type: 'text', attrs: { content: '把背景改成夜晚' } }] });
  await dispatch(app, s, undefined);
  assert.match(s.sent[0], /已接收 \S+（含 1 张图片）/);
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].version, 2);
  assert.deepEqual(jobs[0].input, [
    { type: 'image', file: 'input-0.png', mime: 'image/png', size: 300 },
    { type: 'text', text: '把背景改成夜晚' },
  ]);
  assert.equal(fs.existsSync(path.join(app.root, 'jobs', jobs[0].id, 'input-0.png')), true);
});

test('a message that matches no command is forwarded, not dropped', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'text', attrs: { content: '帮我看看这段代码' } }] });
  await dispatch(app, s, '帮我看看这段代码');
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].input, [{ type: 'text', text: '帮我看看这段代码' }]);
});

test('a pure image message is accepted with no text at all', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'img', attrs: { src: png() } }] });
  await dispatch(app, s, undefined);
  await wait();
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].input, [{ type: 'image', file: 'input-0.png', mime: 'image/png', size: 300 }]);
});

test('a picture that cannot be downloaded is reported and never enqueued', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'img', attrs: { src: 'file:///etc/passwd' } }] });
  const reply = await dispatch(app, s, undefined);
  assert.match(reply, /仅支持下载 http/);
  assert.deepEqual(jobFiles(app.root), []);
  assert.equal(s.sent.length, 0);
});

test('management commands are answered locally and never forwarded', async () => {
  const app = apply();
  const s = session();
  const created = await dispatch(app, s, '/new 月夜');
  assert.match(created, /已开启：月夜/);
  assert.match(await dispatch(app, s, '/chat'), /月夜/);
  assert.match(await dispatch(app, s, '/status'), /当前会话暂无任务/);
  assert.deepEqual(jobFiles(app.root), [], '命令不该变成发给 ChatGPT 的消息');
});

test('every message from one user stays in the same persistent conversation', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'text', attrs: { content: '画一只猫' } }], messageId: 'm1' });
  await dispatch(app, s, undefined);
  assert.match(s.sent[0], /会话：alice（\S{8}）/, '第一次发消息就该自动进入alice，不需要任何命令');
  await settle(app.root);
  s.messageId = 'm2';
  s.elements = [{ type: 'text', attrs: { content: '把它改成橘色的' } }];
  await dispatch(app, s, undefined);
  await settle(app.root);
  const jobs = jobFiles(app.root).sort((a, b) => a.createdAt - b.createdAt);
  assert.equal(jobs.length, 2);
  assert.ok(jobs[0].sessionId, '任务必须绑定会话，否则续聊无从谈起');
  assert.equal(jobs[0].sessionId, jobs[1].sessionId, '两条消息必须落在同一个会话里');
  const list = await dispatch(app, s, '/chat');
  assert.match(list, /当前：alice（\S{8}）/);
  assert.match(list, /alice \[当前\]/);
  // 另一个用户不共享这个会话。
  const other = session({ userId: 'bob', channelId: 'bob', elements: [{ type: 'text', attrs: { content: '你好' } }] });
  assert.match(await dispatch(app, other, '/chat'), /当前：暂无/);
});

test('/new starts a fresh context and preserves the previous conversation for switching', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'text', attrs: { content: '第一句' } }] });
  await dispatch(app, s, undefined);
  await settle(app.root);
  const [first] = jobFiles(app.root);
  assert.match(await dispatch(app, s, '/new 新话题'), /已开启：新话题/);
  s.messageId = 'm2';
  s.elements = [{ type: 'text', attrs: { content: '第二句' } }];
  await dispatch(app, s, undefined);
  await settle(app.root);
  const second = jobFiles(app.root).find(job => job.id !== first.id);
  assert.notEqual(second.sessionId, first.sessionId, '重开会话之后必须换一个网页会话');
  const list = await dispatch(app, s, '/chat');
  assert.match(list, /当前：新话题（\S{8}）/);
  assert.match(list, /新话题 \[当前\]/);
  assert.match(list, /alice/, '旧会话保留，仍可切回');
  assert.match(await dispatch(app, s, `/chat ${first.sessionId}`), /已切换：alice/);
});

test('a deleted ChatGPT thread is unbound, so the next message starts a new one', async () => {
  const app = apply();
  const { port, token } = await bridgeOf(app.root);
  const beat = () => fetch(`http://127.0.0.1:${port}/state`, { headers: { 'x-bridge-token': token } });
  await beat();
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`,
    { method: 'POST', headers: { 'x-bridge-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const s = session({ elements: [{ type: 'text', attrs: { content: '再改一版' } }] });
  await dispatch(app, s, undefined);
  let job;
  for (let attempt = 0; attempt < 300 && !job; attempt++) {
    job = (await (await beat()).json()).job;
    if (!job) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(job, '桥接应当已经挂起这个任务');
  // 扩展先上报会话编号（绑定），再报告这个会话在网页侧已经打不开。
  await post('/progress', { id: job.id, threadId: THREAD, phase: 'submitted' });
  await post('/failure', { id: job.id, message: 'ChatGPT 网页会话已不存在或无法打开' });
  const [failed] = await settle(app.root);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'thread_gone');
  const saved = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json'), 'utf8'));
  assert.equal(saved.items[0].contexts.chat.webThreadId, undefined, '失效的网页会话必须解绑，否则这个用户会被永久卡死');
  assert.ok(saved.items[0].id);
});

test('while one message is still running, the same conversation refuses a second one', async () => {
  const app = apply();
  const { port, token } = await bridgeOf(app.root);
  const beat = () => fetch(`http://127.0.0.1:${port}/state`, { headers: { 'x-bridge-token': token } });
  await beat();
  const s = session({ elements: [{ type: 'text', attrs: { content: '第一条' } }] });
  await dispatch(app, s, undefined);
  let job;
  for (let attempt = 0; attempt < 300 && !job; attempt++) {
    job = (await (await beat()).json()).job;
    if (!job) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(job, '桥接应当已经挂起这个任务');
  s.messageId = 'm2';
  s.elements = [{ type: 'text', attrs: { content: '第二条' } }];
  assert.match(await dispatch(app, s, undefined), /仍在处理上一条消息/);
  // 收尾：让挂起的任务结束，否则测试进程会留着这个假上下文。
  await fetch(`http://127.0.0.1:${port}/result`, {
    method: 'POST', headers: { 'x-bridge-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: job.id, threadId: THREAD, segments: [{ type: 'text', text: '好' }] }),
  });
  await settle(app.root);
});

test('the open-conversation limit is reported to the user, not thrown into the middleware', async () => {
  // ensure() 在转发路径上运行，它抛错必须变成一条回复，否则会变成中间件里的未处理拒绝。
  const root = temp();
  const items = Array.from({ length: 20 }, (_, index) =>
    ({ id: `aaaaaaa${index}`, owner: 'alice', chat: 'qq:alice', name: `会话${index}`, createdAt: Date.now() }));
  fs.writeFileSync(path.join(root, 'conversations.json'), JSON.stringify({ items, current: {} }));
  const built = harness();
  plugin.apply(built.ctx, { allowedUsers: ['*'], dataDir: root, webBridgePort: 0 });
  apps.push(built);
  const s = session({ elements: [{ type: 'text', attrs: { content: '你好' } }] });
  assert.match(await dispatch(built, s, undefined), /最多保留 20 个打开的会话/);
  assert.deepEqual(jobFiles(root), []);
});

test('unauthorized sessions never reach the forwarder or the downloader', async () => {
  const app = apply({ allowedUsers: ['someone-else'] });
  const outsider = session({ userId: 'mallory', elements: [{ type: 'text', attrs: { content: '你好' } }] });
  assert.equal(await dispatch(app, outsider, '你好'), undefined);
  const withImage = session({ userId: 'mallory', elements: [{ type: 'img', attrs: { src: 'http://example.invalid/a.png' } }] });
  assert.equal(await dispatch(app, withImage, undefined), undefined);
  assert.deepEqual(jobFiles(app.root), []);
  // A mention alone is not enough: group chat stays off unless `groupChat` is set.
  const group = session({ isDirect: false, channelId: 'group-1', stripped: { appel: true, content: '你好' },
    elements: [{ type: 'text', attrs: { content: '你好' } }] });
  assert.equal(await dispatch(app, group, undefined), undefined);
  assert.deepEqual(jobFiles(app.root), []);
});

test('a group message is inert unless the bot is mentioned', async () => {
  const app = apply({ groupChat: true });
  const silent = session({ isDirect: false, channelId: 'group-1', stripped: { appel: false, content: '帮我写首诗' },
    elements: [{ type: 'text', attrs: { content: '帮我写首诗' } }] });
  assert.equal(await dispatch(app, silent, undefined), undefined);
  assert.deepEqual(jobFiles(app.root), []);
});

test('a mentioned group message lands in the group conversation', async () => {
  const app = apply({ groupChat: true });
  const s = session({ isDirect: false, channelId: 'group-1', stripped: { appel: true, content: '帮我写首诗' },
    elements: [{ type: 'at', attrs: { id: 'bot' } }, { type: 'text', attrs: { content: '帮我写首诗' } }] });
  await dispatch(app, s, undefined);
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].owner, 'alice');
  assert.equal(jobs[0].conversation, 'qq:group-1');
  // The bot mention is stripped, so no QQ openid is forwarded to the web page.
  assert.deepEqual(jobs[0].input, [{ type: 'text', text: '帮我写首诗' }]);
  assert.match(s.sent[0], /已接收/);
});

test('the reply is delivered in order, with images in their original position', async () => {
  const app = apply();
  const { port, token } = await bridgeOf(app.root);
  const beat = () => fetch(`http://127.0.0.1:${port}/state`, { headers: { 'x-bridge-token': token } });
  // The bridge refuses to hand a task to a browser it has not heard from, so the
  // extension heartbeat has to exist before the job is enqueued.
  await beat();
  const s = session({ elements: [{ type: 'text', attrs: { content: '给我两个方案' } }] });
  await dispatch(app, s, undefined);
  const running = settle(app.root);
  let job;
  for (let attempt = 0; attempt < 300 && !job; attempt++) {
    job = (await (await beat()).json()).job;
    if (!job) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(job, '桥接应当已经挂起这个任务');
  const asset = await fetch(`http://127.0.0.1:${port}/result-asset?id=${job.id}&i=0`,
    { method: 'POST', headers: { 'x-bridge-token': token, 'Content-Type': 'image/png' }, body: pngBytes(512) });
  assert.equal(asset.status, 200);
  const result = await fetch(`http://127.0.0.1:${port}/result`, {
    method: 'POST', headers: { 'x-bridge-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: job.id, threadId: '11111111-2222-3333-4444-555555555555', segments: [
      { type: 'text', text: '方案一：' },
      { type: 'image', asset: 0, mime: 'image/png' },
      { type: 'code', language: 'python', text: 'print(1)' },
    ] }),
  });
  assert.equal(result.status, 200);
  await running;
  const [finished] = await settle(app.root);
  assert.equal(finished.status, 'ready');
  assert.equal(finished.delivery, 'sent');
  const delivered = s.sent.slice(1);
  assert.equal(delivered[0], '方案一：');
  assert.match(delivered[1], /^<img src="data:image\/png;base64,/);
  assert.match(delivered[2], /```python\nprint\(1\)\n```/);
});

test('QQ receives original GIF and PNG bytes and retries unfinished delivery from persisted media',async()=>{
 const app=apply({notifyProgress:false});
 const {port,token}=await bridgeOf(app.root),headers={'x-bridge-token':token,'Content-Type':'application/json'};
 const beat=()=>fetch(`http://127.0.0.1:${port}/state`,{headers});await beat();
 const s=session({elements:[{type:'text',attrs:{content:'create animation'}}]});
 s.send=async content=>{if(content.includes('data:image/gif;'))throw Error('QQ temporarily unavailable');s.sent.push(content);return ['ok'];};
 await dispatch(app,s);
 let job;
 for(let attempt=0;attempt<300&&!job;attempt++){
  job=(await(await beat()).json()).job;if(!job)await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.ok(job);
 const gif=animatedGif(),png=pngBytes(128);
 for(const [index,bytes]of [gif,png].entries())assert.equal((await fetch(`http://127.0.0.1:${port}/result-asset?id=${job.id}&i=${index}`,
  {method:'POST',headers:{'x-bridge-token':token},body:bytes})).status,200);
 const segments=[{type:'text',text:'两种格式：'},{type:'image',asset:0},{type:'image',asset:1}];
 assert.equal((await fetch(`http://127.0.0.1:${port}/result`,{method:'POST',headers,
  body:JSON.stringify({id:job.id,threadId:THREAD,segments})})).status,200);
 const [failed]=await settle(app.root);assert.equal(failed.delivery,'failed');assert.equal(failed.deliveryCursor,1);
 // Dispose and recreate the plugin; /retry must use saved GIF data, with no model call.
 for(const dispose of app.disposes)dispose();
 const restarted=apply({dataDir:app.root,notifyProgress:false});
 const retry=session({messageId:'gif-retry'});await dispatch(restarted,retry,`/retry ${job.id}`);
 assert.deepEqual(retry.sent,[`<img src="data:image/gif;base64,${gif.toString('base64')}"/>`,
  `<img src="data:image/png;base64,${png.toString('base64')}"/>`]);
 assert.equal(jobFiles(app.root)[0].delivery,'sent');
});

test('a job handed to the bridge fails cleanly while no browser is connected', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'text', attrs: { content: '你好' } }] });
  await dispatch(app, s, undefined);
  const [job] = await settle(app.root);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'browser_offline');
  // The failure reason is user-facing QQ text and must not leak the old CLI story.
  assert.ok(!/codex/i.test(job.error), job.error);
  assert.ok(s.sent.some(message => /失败/.test(message)));
});

test('the plugin refuses to load without an allowedUsers list', () => {
  const built = harness();
  assert.throws(() => plugin.apply(built.ctx, { dataDir: temp(), webBridgePort: 0 }), /allowedUsers/);
  assert.throws(() => plugin.apply(built.ctx, { allowedUsers: [], dataDir: temp(), webBridgePort: 0 }), /allowedUsers/);
});

const slash = (app, text, options = {}) => dispatch(app, session({ ...options, elements: [{ type: 'text', attrs: { content: text } }] }), text);

test('daily help lists only common commands and stays local and authorized', async () => {
  const app = apply({ allowedUsers: ['alice'], groupChat: true });
  const help = await slash(app, '/help');
  assert.deepEqual(help.match(/^\/[a-z]+/gm), ['/help', '/mode', '/new', '/chat', '/status', '/stop']);
  assert.equal(app.stages.some(s => s.kind === 'command'), false, 'short commands must not register bare words in Koishi');
  assert.equal(await dispatch(app, session(), '/help'), help);
  assert.equal(await slash(app, '/help', { userId: 'bob' }), undefined);
  assert.equal(await slash(app, '/help', { isDirect: false }), undefined);
  assert.equal(await slash(app, '/help', { isDirect: false, stripped: { appel: true, content: '/help' } }), help);
  assert.deepEqual(jobFiles(app.root), []);
});

test('mode help stays concise, advanced commands remain available, and invalid switches do not generate', async t => {
  const provider = await localServer(t), app = apply({ allowedUsers: ['alice'], lmStudioBaseUrl: provider.url, groupChat: true });
  assert.match(await slash(app, '/mode'), /当前模式：聊天/);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.match(await slash(app, '/mode 工作'), /已切换到工作/);
  assert.deepEqual((await slash(app, '/help')).match(/^\/[a-z]+/gm), ['/help', '/mode', '/new', '/chat', '/status', '/stop', '/skill']);
  assert.match(await slash(app, '/help all'), /\/backend[\s\S]*\/reasoning|\/reasoning[\s\S]*\/backend/);
  assert.match(await slash(app, '/model'), /local-chat/);
  assert.match(await slash(app, '/mode 本地'), /已切换到本地模型：local-chat/);
  const help = await slash(app, '/help'); assert.match(help, /^\/model/gm); assert.match(help, /^\/preset/gm);
  assert.match(await slash(app, '/mode Chat'), /已切换到聊天/);
  for (const bad of ['/mode unknown', '/mode 聊天 model', '/mode 本地 a b', '/model a b'])
    assert.match(await slash(app, bad), /用法/);
  for (const command of ['/mode 工作', '/model local-chat']) {
    assert.equal(await slash(app, command, { userId: 'mallory' }), undefined);
    assert.equal(await slash(app, command, { isDirect: false, stripped: { appel: false, content: command } }), undefined);
  }
  assert.deepEqual(jobFiles(app.root), []);
});

test('notification preferences persist and remain isolated by user and chat', async () => {
  const app = apply({ groupChat: true });
  assert.match(await slash(app, '/logs off'), /已关闭/);
  assert.match(await slash(app, '/logs'), /已关闭/);
  assert.match(await slash(app, '/logs wat'), /用法/);
  assert.match(await slash(app, '/logs'), /已关闭/);
  assert.match(await slash(app, '/logs', { userId: 'bob' }), /已开启/);
  assert.match(await slash(app, '/logs', { isDirect: false, channelId: 'group', stripped: { appel: true, content: '/logs' } }), /已开启/);
  const { Preferences } = require('../src/core/preferences.cjs');
  assert.equal(new Preferences(path.join(app.root, 'preferences.json')).enabled('alice', 'qq:alice'), false);
  assert.match(await dispatch(app, session(), '/logs on'), /已开启/);
  assert.deepEqual(jobFiles(app.root), []);
});

test('slash routing preserves full names, accepts case and whitespace, and rejects extra arguments locally', async () => {
  const app = apply();
  assert.match(await slash(app, '  /NEW\t新 话题  '), /已开启：新 话题/);
  assert.match(await slash(app, '/chat'), /新 话题/);
  assert.match(await slash(app, '/help extra'), /用法：\/help/);
  assert.match(await slash(app, '/status one two'), /用法：\/status/);
  assert.match(await slash(app, '/close one two'), /用法：\/close/);
  assert.match(await slash(app, '/logs off extra'), /用法：\/logs/);
  assert.match(await slash(app, '/logs'), /已开启/);
  assert.deepEqual(jobFiles(app.root), []);
});

test('removed Chinese commands only show the migration notice and never create jobs or preferences', async () => {
  const app = apply();
  for (const text of ['桥接帮助', '桥接连接', '桥接日志 关闭', '桥接状态', '桥接取消', '桥接重发',
    '桥接新建会话 旧名称', '桥接重开会话', '桥接会话列表', '桥接切换会话 other',
    '桥接关闭会话', '桥接重命名会话 other 新名称', '桥接记录'])
    assert.match(await slash(app, text), /命令已精简.*\/help/);
  assert.deepEqual(jobFiles(app.root), []);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.equal(fs.existsSync(path.join(app.root, 'preferences.json')), false);
});

test('all short commands remain gated by private authorization and group mentions', async () => {
  const app = apply({ allowedUsers: ['alice'], groupChat: true });
  for (const text of ['/help', '/new', '/chat', '/backend lmstudio', '/skill', '/skill show summarize-text', '/skill summarize-text', '/skill off', '/preset', '/preset show', '/preset role',
    '/preset create role\n正文', '/preset edit role\n正文', '/preset delete role', '/prompt', '/prompt 角色海报', '/prompt preview 英雄', '/draw 英雄', '/close', '/status', '/stop', '/retry', '/logs off', '/reasoning high']) {
    assert.equal(await slash(app, text, { userId: 'mallory' }), undefined);
    assert.equal(await slash(app, text, { isDirect: false, channelId: 'group', stripped: { appel: false, content: text } }), undefined);
  }
  assert.deepEqual(jobFiles(app.root), []);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.equal(fs.existsSync(path.join(app.root, 'preferences.json')), false);
});
test('/reasoning stays local, validates input and follows the selected conversation', async () => {
  const app = apply({ groupChat: true });
  assert.match(await slash(app, '/reasoning'), /跟随网页/);
  assert.match(await slash(app, '/reasoning wat'), /用法/);
  assert.match(await slash(app, '/reasoning high extra'), /用法/);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.match(await slash(app, '/REASONING 高'), /已设为：高/);
  const first = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json'))).items[0];
  assert.equal(first.contexts.chat.reasoningEffort, 'high');
  assert.match(await slash(app, '/reasoning', { userId: 'bob' }), /跟随网页/);
  assert.match(await slash(app, '/reasoning', { isDirect: false, channelId: 'group', stripped: { appel: true } }), /跟随网页/);
  await slash(app, '/new second');
  assert.match(await slash(app, '/reasoning'), /当前会话推理程度：高/);
  await slash(app, `/chat ${first.id}`);
  assert.match(await slash(app, '/reasoning'), /当前会话推理程度：高/);
  assert.match(await slash(app, '/reasoning default'), /跟随网页/);
  assert.deepEqual(jobFiles(app.root), []);
});

test('/reasoning changes only future jobs and the snapshot reaches the browser bridge', async () => {
  const app = apply({ notifyProgress: false });
  const { port, token } = await bridgeOf(app.root);
  const headers = { 'x-bridge-token': token, 'x-bridge-capabilities': 'reasoning', 'Content-Type': 'application/json' };
  const state = async () => (await (await fetch(`http://127.0.0.1:${port}/state`, { headers })).json()).job;
  await state();
  await slash(app, '/reasoning medium');
  const s = session({ elements: [{ type: 'text', attrs: { content: 'hello' } }] });
  await dispatch(app, s); await wait();
  const first = await state();
  assert.equal(first.reasoningEffort, 'medium');
  await slash(app, '/reasoning xhigh');
  assert.equal((await state()).reasoningEffort, 'medium');
  assert.match(await slash(app, '/status'), /推理程度：中/);
  await fetch(`http://127.0.0.1:${port}/failure`, { method: 'POST', headers,
    body: JSON.stringify({ id: first.id, message: '网页推理程度测试结束' }) });
  await settle(app.root); await wait();
  s.messageId = 'm2';
  await dispatch(app, s); await wait();
  const second = await state();
  assert.equal(second.reasoningEffort, 'xhigh');
  assert.equal(jobFiles(app.root).find(j => j.id === second.id).reasoningEffort, 'xhigh');
  await fetch(`http://127.0.0.1:${port}/failure`, { method: 'POST', headers,
    body: JSON.stringify({ id: second.id, message: '网页推理程度测试结束' }) });
  await settle(app.root);
});

test('bare words and image captions are forwarded; unknown slash commands return local help', async () => {
  const app = apply({ notifyProgress: false });
  for (const text of ['new', 'stop', 'status', '桥接状态正常吗？']) {
    await slash(app, text, { messageId: text });
    await settle(app.root);
  }
  const s = session({ messageId: 'caption', elements: [
    { type: 'text', attrs: { content: '/stop' } }, { type: 'img', attrs: { src: png() } },
  ] });
  await dispatch(app, s, '/stop');
  await settle(app.root);
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 5);
  assert.match(await slash(app, '/stopping'), /没有这个命令.*\/help/);
  assert.equal(jobFiles(app.root).length, 5);
  assert.deepEqual(jobs.find(j => j.messageId === 'caption').input.map(s => s.type), ['text', 'image']);
  assert.equal(jobs.find(j => j.messageId === 'caption').input[0].text, '/stop');
});

test('silent mode suppresses receipts and progress but delivers results; live toggles take effect', async () => {
  const app = apply({ notifyProgress: false });
  const { port, token } = await bridgeOf(app.root);
  const beat = () => fetch(`http://127.0.0.1:${port}/state`, { headers: { 'x-bridge-token': token } });
  await beat();
  const s = session({ elements: [{ type: 'text', attrs: { content: '你好' } }] });
  await dispatch(app, s);
  assert.deepEqual(s.sent, []);
  let job;
  for (let attempt = 0; attempt < 300 && !job; attempt++) {
    job = (await (await beat()).json()).job;
    if (!job) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(job);
  // Move only Date.now forward: no real minute-long sleeps or timeout expiry.
  const now = Date.now;
  Date.now = () => now() + 61000;
  try {
    const tick = app.timers.find(t => t.ms === 10000).fn;
    await tick();
    assert.deepEqual(s.sent, []);
    assert.match(await dispatch(app, s, '/status'), /任务/);
    await slash(app, '/logs on');
    await tick();
    await tick();
    assert.equal(s.sent.length, 1);
    assert.match(s.sent[0], /仍在 ChatGPT/);
    await slash(app, '/logs off');
  } finally { Date.now = now; }
  const response = await fetch(`http://127.0.0.1:${port}/result`, {
    method: 'POST', headers: { 'x-bridge-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: job.id, threadId: THREAD, segments: [{ type: 'text', text: '最终结果' }] }),
  });
  assert.equal(response.status, 200);
  await settle(app.root);
  assert.equal(s.sent.at(-1), '最终结果');
  assert.equal(await dispatch(app, s), undefined, 'duplicate deliveries stay silent');
  assert.equal(jobFiles(app.root).length, 1);
});

test('silent mode still reports terminal failures', async () => {
  const app = apply({ notifyProgress: false });
  const s = session({ elements: [{ type: 'text', attrs: { content: '你好' } }] });
  await dispatch(app, s);
  await settle(app.root);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /失败/);
});

test('invalid new name leaves the current conversation unchanged', async () => {
  const app = apply();
  await dispatch(app, session(), '/new 原会话');
  assert.match(await dispatch(app, session(), `/new ${'长'.repeat(41)}`), /最多 40 字/);
  const data = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json'), 'utf8'));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].closed, undefined);
  assert.equal(Object.values(data.current)[0], data.items[0].id);
});

for (const age of [260000, 310000]) {
  test(`terminal failures are attempted even after ${age / 1000} seconds, including silent mode`, async () => {
    const app = apply({ notifyProgress: false });
    const s = session({ elements: [{ type: 'text', attrs: { content: '你好' } }] });
    s.timestamp = Date.now() - age;
    await dispatch(app, s);
    const [job] = await settle(app.root);
    assert.equal(job.feedbackDelivery, 'sent');
    assert.equal(s.sent.length, 1);
    assert.match(s.sent[0], /失败/);
  });
}

test('failed QQ feedback is persisted instead of silently skipped', async () => {
  const app = apply({ notifyProgress: false });
  const s = session({ elements: [{ type: 'text', attrs: { content: '你好' } }] });
  s.timestamp = Date.now() - 310000;
  s.send = async () => { throw Error('reply expired'); };
  await dispatch(app, s);
  const [job] = await settle(app.root);
  assert.equal(job.feedbackDelivery, 'failed');
  assert.equal(job.deliveryError, 'reply expired');
});

test('queue waiting consumes the QQ reply budget before browser timeout', async () => {
  const app = apply({ notifyProgress: false });
  const { port, token } = await bridgeOf(app.root);
  const headers = { 'x-bridge-token': token, 'Content-Type': 'application/json' };
  const beat = async () => (await fetch(`http://127.0.0.1:${port}/state`, { headers })).json();
  await beat();
  const s = session({ elements: [{ type: 'text', attrs: { content: '你好' } }] });
  s.timestamp = Date.now() - 270000;
  await dispatch(app, s);
  const [done] = await settle(app.root);
  assert.equal((await beat()).job, null, 'expired jobs must never reach the browser');
  assert.equal(done.status, 'failed');
  assert.equal(done.errorCode, 'reply_expired');
  assert.equal(done.feedbackDelivery, 'sent');
  assert.match(s.sent[0], /未提交网页/);
});

test('quote text and images enter the normal validated pipeline', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'text', attrs: { content: '把引用图片改成蓝色' } }] });
  s.quote = { elements: [{ type: 'text', attrs: { content: '原图说明' } }, { type: 'img', attrs: { src: png() } }] };
  await dispatch(app, s);
  const [job] = jobFiles(app.root);
  assert.match(job.input.filter(s => s.type === 'text').map(s => s.text).join('\n'), /原图说明[\s\S]*本次消息[\s\S]*改成蓝色/);
  const image = job.input.find(s => s.type === 'image');
  assert.ok(fs.existsSync(path.join(job.dir, image.file)));
});

test('unavailable quotes and unsafe quoted images are reported without enqueueing', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'text', attrs: { content: '解释一下' } }] });
  s.quote = { id: 'missing' };
  assert.match(await dispatch(app, s), /无法读取被引用消息/);
  s.quote = { elements: [{ type: 'img', attrs: { src: 'file:///secret.png' } }] };
  assert.match(await dispatch(app, s), /仅支持下载 http/);
  assert.deepEqual(jobFiles(app.root), []);
});

test('quoted content shares input limits and never becomes a management command', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'text', attrs: { content: '解释一下' } }] });
  s.quote = { elements: [{ type: 'text', attrs: { content: 'x'.repeat(1500) } }] };
  assert.match(await dispatch(app, s), /文字最多/);
  s.quote = { elements: Array.from({ length: 3 }, () => ({ type: 'img', attrs: { src: png() } })) };
  assert.match(await dispatch(app, s), /最多发送 2 张/);
  s.quote = { elements: [{ type: 'text', attrs: { content: '/logs off' } }] };
  await dispatch(app, s);
  assert.equal(jobFiles(app.root).length, 1);
  assert.equal(fs.existsSync(path.join(app.root, 'preferences.json')), false);
});


test('partial QQ delivery resumes at the first unconfirmed segment across repeated commands', async()=>{
 const app=apply({notifyProgress:false,maxTextChars:20});
 const {port,token}=await bridgeOf(app.root);
 const headers={'x-bridge-token':token,'Content-Type':'application/json'};
 await fetch(`http://127.0.0.1:${port}/state`,{headers});
 const s=session({elements:[{type:'text',attrs:{content:'hello'}}]});
 let sends=0;
 s.send=async content=>{if(++sends===2)throw Error('platform rejected');s.sent.push(content);return ['ok'];};
 await dispatch(app,s);
 const [job]=jobFiles(app.root);
 await fetch(`http://127.0.0.1:${port}/result`,{method:'POST',headers,body:JSON.stringify({id:job.id,threadId:THREAD,segments:[{type:'text',text:'a'.repeat(20)+'b'.repeat(20)+'c'.repeat(20)}]})});
 await settle(app.root);await wait();
 const [failed]=jobFiles(app.root);
 assert.equal(failed.delivery,'failed');assert.equal(failed.deliveryCursor,1);
 const retry=session({messageId:'retry'});
 await dispatch(app,retry,`/retry ${job.id}`);
 assert.deepEqual(retry.sent,['b'.repeat(20),'c'.repeat(20)]);
 assert.equal(jobFiles(app.root)[0].delivery,'sent');
 const replay=session({messageId:'replay'});
 await dispatch(app,replay,`/retry ${job.id}`);
 assert.deepEqual(replay.sent,['a'.repeat(20),'b'.repeat(20),'c'.repeat(20)]);
});

test('disposing the plugin stops after the in-flight QQ segment and retains the replay cursor',async()=>{
 const app=apply({notifyProgress:false,maxTextChars:20});
 const {port,token}=await bridgeOf(app.root),headers={'x-bridge-token':token,'Content-Type':'application/json'};
 await fetch(`http://127.0.0.1:${port}/state`,{headers});
 const s=session({elements:[{type:'text',attrs:{content:'hello'}}]});
 s.send=async content=>{s.sent.push(content);if(s.sent.length===1)for(const dispose of app.disposes)dispose();return ['ok'];};
 await dispatch(app,s);const [job]=jobFiles(app.root);
 await fetch(`http://127.0.0.1:${port}/result`,{method:'POST',headers,
  body:JSON.stringify({id:job.id,threadId:THREAD,segments:[{type:'text',text:'a'.repeat(20)+'b'.repeat(20)+'c'.repeat(20)}]})});
 await settle(app.root);await wait();
 assert.deepEqual(s.sent,['a'.repeat(20)]);
 const [done]=jobFiles(app.root);assert.equal(done.deliveryCursor,1);assert.equal(done.delivery,'failed');
});

test('a stuck QQ acknowledgement times out and the job still reaches the browser', async()=>{
 const app=apply({sendTimeoutMs:15});
 const {port,token}=await bridgeOf(app.root);
 const headers={'x-bridge-token':token,'Content-Type':'application/json'};
 await fetch(`http://127.0.0.1:${port}/state`,{headers});
 const s=session({elements:[{type:'text',attrs:{content:'hello'}}]});
 s.send=()=>new Promise(()=>{});
 await dispatch(app,s);
 await wait();
 const remote=await(await fetch(`http://127.0.0.1:${port}/state`,{headers})).json();
 assert.ok(remote.job);
 await fetch(`http://127.0.0.1:${port}/failure`,{method:'POST',headers,body:JSON.stringify({id:remote.job.id,message:'页面加载失败'})});
 await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal(jobFiles(app.root)[0].feedbackDelivery,'failed');
});

test('GIF upload confirmation can outlast the text budget without a false failed delivery',async()=>{
 const app=apply({notifyProgress:false,sendTimeoutMs:15,mediaSendTimeoutMs:100});
 const {port,token}=await bridgeOf(app.root),headers={'x-bridge-token':token,'Content-Type':'application/json'};
 await fetch(`http://127.0.0.1:${port}/state`,{headers});
 const s=session({elements:[{type:'text',attrs:{content:'send GIF'}}]});
 s.send=async content=>{
  if(content.includes('data:image/gif;'))await new Promise(resolve=>setTimeout(resolve,45));
  s.sent.push(content);return ['ok'];
 };
 await dispatch(app,s);const [job]=jobFiles(app.root);
 assert.equal((await fetch(`http://127.0.0.1:${port}/result-asset?id=${job.id}&i=0`,{
  method:'POST',headers,body:animatedGif(),
 })).status,200);
 assert.equal((await fetch(`http://127.0.0.1:${port}/result`,{method:'POST',headers,
  body:JSON.stringify({id:job.id,threadId:THREAD,segments:[{type:'image',asset:0}]}),
 })).status,200);
 const [done]=await settle(app.root);assert.equal(done.delivery,'sent');assert.equal(done.deliveryCursor,1);
 assert.ok(s.sent.some(content=>content.startsWith('<img src="data:image/gif;')));
 assert.ok(!s.sent.some(content=>content.includes('发送失败')));
});


test('invalid numeric limits fail before a server is started',()=>{
 for(const config of [{maxTextChars:-1},{maxTextChars:1},{replyTimeoutMs:Infinity},{sendTimeoutMs:NaN},{maxInputImages:1.5}])
  assert.throws(()=>apply(config),/必须是/);
});

test('/status reports the loaded version without creating a job or browser heartbeat', async()=>{
 const app=apply();
 const s=session();
 const message=await dispatch(app,s,'/status');
 assert.match(message,new RegExp(require('../package.json').version.replaceAll('.', '\\.')));
 assert.match(message,/浏览器未连接/);
 assert.deepEqual(jobFiles(app.root),[]);
 const {port,token}=await bridgeOf(app.root);
 const health=await(await fetch(`http://127.0.0.1:${port}/health`,{headers:{'x-bridge-token':token}})).json();
 assert.equal(health.online,false);
 assert.equal(health.busy,false);
});

test('session list, selection and closure stay local and enforce ownership', async () => {
  const app = apply({ notifyProgress: false });
  const s = session();
  await dispatch(app, s, '/new first');
  const first = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json'))).items[0].id;
  await dispatch(app, s, '/new second');
  assert.match(await dispatch(app, s, `/chat ${first}`), /已切换：first/);
  assert.match(await dispatch(app, s, '/chat'), new RegExp(first + ' first \\[当前\\]'));
  s.elements = [{ type: 'text', attrs: { content: 'history entry' } }];
  await dispatch(app, s);
  const [job] = await settle(app.root);
  assert.match(await dispatch(app, s, `/status ${job.id}`), /处理失败/);
  const other = session({ userId: 'bob', channelId: 'alice' });
  for (const command of [`/chat ${first}`, `/close ${first}`])
    assert.match(await dispatch(app, other, command), /未找到你的会话/);
  assert.equal(await dispatch(app, other, `/status ${job.id}`), '未找到你的任务');
  assert.match(await dispatch(app, s, `/close ${first}`), /已关闭：first/);
  assert.match(await dispatch(app, s, `/retry ${job.id}`), /处理失败/);
  assert.equal(jobFiles(app.root).length, 1, 'management commands must not reach ChatGPT');
});

test('status and cancellation commands operate on the owned running job and await browser acknowledgement', async()=>{
 const app=apply({notifyProgress:false});const {port,token}=await bridgeOf(app.root);
 const headers={'x-bridge-token':token,'Content-Type':'application/json'};
 const state=async()=> (await fetch(`http://127.0.0.1:${port}/state`,{headers})).json();
 await state();const s=session({elements:[{type:'text',attrs:{content:'running'}}]});
 await dispatch(app,s);await wait();
 const {job}=await state();
 assert.match(await dispatch(app,s,'/status'),/网页处理中/);
 assert.match(await dispatch(app,s,'/close'),/仍在处理消息/);
 assert.equal(await dispatch(app,session({userId:'bob'}),`/stop ${job.id}`),'未找到你的任务');
 assert.match(await dispatch(app,s,'/stop'),/已请求停止/);
 assert.equal((await state()).job.cancelled,true);
 await fetch(`http://127.0.0.1:${port}/failure`,{method:'POST',headers,body:JSON.stringify({id:job.id,message:'任务已取消'})});
 const [ended]=await settle(app.root);assert.equal(ended.status,'cancelled');
 assert.match(await dispatch(app,s,'/stop'),/已结束/);
});

async function localServer(t, onChat) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"local-chat"},{"id":"text-embedding-nomic"}]}');
    if (req.url === '/api/v1/models') return res.end('{"models":[{"key":"local-chat","capabilities":{"vision":true}}]}');
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (onChat) return onChat(body, res);
    const content = body.messages.at(-1).content;
    res.end(JSON.stringify({ choices: [{ message: { content: Array.isArray(content) ? '本地图片回答' : '本地回答 ' + content }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test('three modes route through shared delivery, resume separate histories after restart and never send skills in Chat', async t => {
  const provider = await localServer(t);
  let app = apply({ lmStudioBaseUrl: provider.url, notifyProgress: false });
  const workThread = '99999999-2222-3333-4444-555555555555';
  const webTurn = async (text, mode, threadId, expectedThread, skill) => {
    const { port, token } = await bridgeOf(app.root);
    const call = async (route, body) => (await fetch(`http://127.0.0.1:${port}` + route, {
      method: body ? 'POST' : 'GET', headers: { 'x-bridge-token': token, 'x-bridge-capabilities': 'web-modes,native-skills,reasoning', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })).json();
    await call('/state');
    const s = session({ messageId: text, elements: [{ type: 'text', attrs: { content: text } }] });
    assert.equal(await dispatch(app, s), undefined);
    let job;
    for (let i = 0; i < 100 && !job; i++) { job = (await call('/state')).job; if (!job) await wait(); }
    assert.ok(job); assert.equal(job.mode, mode); assert.equal(job.threadId, expectedThread || '');
    assert.equal(job.text, text); assert.equal(job.skill?.name, skill);
    assert.match(await slash(app, '/mode 本地'), /正在处理任务/);
    assert.match(await slash(app, '/skill summarize-text'), /正在处理任务/);
    await call('/result', { id: job.id, threadId, segments: [{ type: 'text', text: mode + ' reply' }] });
    await settle(app.root); assert.deepEqual(s.sent, [mode + ' reply']); return job;
  };
  const first = await webTurn('Chat first', 'chat', THREAD, undefined);
  await slash(app, '/mode 工作'); await webTurn('Work first', 'work', workThread, undefined);
  await slash(app, '/skill summarize-text'); await slash(app, '/mode 本地');
  const localText = async text => {
    const s = session({ messageId: text, elements: [{ type: 'text', attrs: { content: text } }] });
    assert.equal(await dispatch(app, s), undefined); await settle(app.root);
    assert.deepEqual(s.sent, ['本地回答 ' + text]);
  };
  await localText('Local first'); assert.equal(provider.requests[0].messages.length, 1);
  await slash(app, '/mode 聊天');
  // Chat must not load a remembered Work skill or inject it as plain text.
  const skillFile = path.join(app.root, 'skills', 'summarize-text', 'SKILL.md');
  const content = fs.readFileSync(skillFile); fs.unlinkSync(skillFile);
  await webTurn('Chat second', 'chat', THREAD, THREAD); fs.writeFileSync(skillFile, content);
  const root = app.root; for (const dispose of app.disposes) dispose();
  // Port 0 chooses a new endpoint on restart; wait for its fresh port record.
  fs.rmSync(path.join(root, 'web-bridge-port'));
  app = apply({ dataDir: root, lmStudioBaseUrl: provider.url, notifyProgress: false });
  await slash(app, '/mode 工作'); await webTurn('Work second', 'work', workThread, workThread, 'summarize-text');
  await slash(app, '/mode 本地'); await localText('Local second');
  assert.deepEqual(provider.requests[1].messages.map(message => message.content), ['Local first', '本地回答 Local first', 'Local second']);
  const sessionId = jobFiles(root).find(job => job.id === first.id).sessionId;
  assert.ok(sessionId); assert.ok(jobFiles(root).every(job => job.sessionId === sessionId));
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'conversations.json'))).items[0];
  assert.equal(saved.contexts.chat.webThreadId, THREAD); assert.equal(saved.contexts.work.webThreadId, workThread);
  assert.equal(saved.contexts.local.skill, undefined); assert.equal(saved.contexts.work.skill, 'summarize-text');
});

test('mode switching is blocked while image preparation owns the conversation', async () => {
  const { createBot } = require('../src/app/bot.cjs');
  const { Conversations } = require('../src/core/conversations.cjs');
  const { normalizeConfig } = require('../src/core/config.cjs');
  const { downloadImage } = require('../src/lib/image.cjs');
  const root = temp(), chats = new Conversations(path.join(root, 'conversations.json'));
  const config = normalizeConfig({ allowedUsers: ['alice'], dataDir: root, notifyProgress: false }, root);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const bot = createBot(config, { chats, presets: {}, skills: {}, preferences: { enabled: () => false },
    web: { run: async () => { throw Error('offline'); }, close: () => {} }, local: {}, logger: { warn: () => {} },
    imageLoader: async (...args) => { await gate; return downloadImage(...args); } });
  const s = session({ messageId: 'preparing', elements: [{ type: 'img', attrs: { src: png() } }] });
  try {
    const pending = bot.forward(s);
    assert.equal(bot.busy(bot.currentChat(s).id), true);
    await assert.rejects(bot.switchMode(s, 'work'), /正在处理任务/);
    release(); await pending; await settle(root);
    assert.equal(jobFiles(root)[0].mode, 'chat');
  } finally { release(); bot.close(); }
});

test('skill commands browse without generation, isolate conversations and persist through new chats and restart', async () => {
  const app = apply({ groupChat: true });
  assert.match(await slash(app, '/skill'), /未启用[\s\S]*summarize-text/);
  assert.match(await slash(app, '/skill show summarize-text'), /主要结论|主要.*结论/);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.match(await slash(app, '/skill summarize-text'), /已选择技能/);
  assert.match(await slash(app, '/skill @chatgpt jp portrait'), /已选择技能：chatgpt-jp-portrait[\s\S]*原生 @技能/);
  assert.match(await slash(app, '/skill @summarize text'), /已选择技能：summarize-text/);
  assert.match(await slash(app, '/status'), /当前技能：summarize-text/);
  const first = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json'))).items[0];
  assert.match(await slash(app, '/skill', { userId: 'bob' }), /未启用/);
  assert.match(await slash(app, '/skill', { isDirect: false, channelId: 'group', stripped: { appel: true } }), /未启用/);
  assert.match(await slash(app, '/new 新话题'), /沿用技能：summarize-text/);
  await slash(app, '/skill off'); assert.match(await slash(app, '/skill'), /未启用/);
  await slash(app, `/chat ${first.id}`); assert.match(await slash(app, '/skill'), /当前技能：summarize-text/);
  for (const dispose of app.disposes) dispose();
  const rebooted = apply({ dataDir: app.root });
  assert.match(await slash(rebooted, '/skill'), /当前技能：summarize-text/);
  assert.deepEqual(jobFiles(app.root), []);
  const file = path.join(app.root, 'skills', 'summarize-text', 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n' + '😀'.repeat(2600) + '\n末尾<at id="bot"/> &内容');
  const show = await slash(rebooted, '/skill show');
  const pages = Number(/第 1\/(\d+) 页/.exec(show)[1]); assert.ok(pages > 1);
  const last = await slash(rebooted, `/skill show --page ${pages}`);
  assert.match(last, /末尾&lt;at id="bot"\/&gt; &amp;内容/); assert.ok(last.length <= 1500);
  for (const value of ['off extra', 'list zero', 'show --page 0', 'summarize-text\nbody', '../secret'])
    assert.match(await slash(rebooted, '/skill ' + value), /用法|名称/);
  assert.match(await slash(rebooted, '/skill list 9999'), /只有.*页/);
});

test('an @ skill command reaches the webpage as a native name with the original message only', async () => {
  const app = apply({ notifyProgress: false }), { port, token } = await bridgeOf(app.root);
  const call = async (route, body) => (await fetch(`http://127.0.0.1:${port}` + route, {
    method: body ? 'POST' : 'GET', headers: { 'x-bridge-token': token, 'x-bridge-capabilities': 'reasoning,native-skills,web-modes', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })).json();
  await call('/state');
  await slash(app, '/skill @chatgpt jp portrait');
  const text = 'P03 + C04，白色陶瓷杯，只要提示词。';
  await dispatch(app, session({ messageId: 'native-command', elements: [{ type: 'text', attrs: { content: text } }] }));
  await wait(); const { job } = await call('/state');
  assert.equal(job.text, text); assert.deepEqual(job.skill, { name: 'chatgpt-jp-portrait' });
  assert.ok(!JSON.stringify(job).includes('instructions'));
  await call('/result', { id: job.id, threadId: THREAD, segments: [{ type: 'text', text: '手部特写提示词' }] });
  const [saved] = await settle(app.root); assert.equal(saved.input[0].text, text);
  assert.equal(saved.delivery, 'sent');
});

test('LM Studio receives the selected skill with presets while user history stays original; invalid skills never submit', async t => {
  const provider = await localServer(t), app = apply({ lmStudioBaseUrl: provider.url, notifyProgress: false });
  await slash(app, '/backend lmstudio'); await slash(app, '/preset create role\n保持角色口吻。');
  await slash(app, '/preset role'); await slash(app, '/skill summarize-text');
  const s = session({ messageId: 'skill-first', elements: [{ type: 'text', attrs: { content: '我的原文材料' } }] });
  await dispatch(app, s); await settle(app.root);
  const messages = provider.requests[0].messages;
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /保持角色口吻[\s\S]*summarize-text/);
  assert.equal(messages[1].content, '我的原文材料');
  const first = jobFiles(app.root)[0];
  assert.match(await slash(app, `/status ${first.id}`), /技能：summarize-text（版本/);
  const file = path.join(app.root, 'skills', 'summarize-text', 'SKILL.md');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original + '\n编辑后的规则。');
  s.messageId = 'skill-edited'; await dispatch(app, s); await settle(app.root);
  assert.match(provider.requests[1].messages[0].content, /编辑后的规则/);
  assert.equal(provider.requests[1].messages[1].content, '我的原文材料');
  assert.doesNotMatch(jobFiles(app.root).find(j => j.id === first.id).skill.instructions, /编辑后的规则/);
  fs.writeFileSync(file, original + '\n' + '字'.repeat(12500));
  s.messageId = 'skill-overflow'; assert.match(await dispatch(app, s), /上下文字数/);
  fs.unlinkSync(file); s.messageId = 'skill-missing';
  assert.match(await dispatch(app, s), /未找到技能/); assert.equal(provider.requests.length, 2);
  assert.equal(jobFiles(app.root).length, 2);
  await slash(app, '/skill off'); s.messageId = 'skill-off';
  await dispatch(app, s); await settle(app.root);
  assert.equal(provider.requests.at(-1).messages[0].content, '保持角色口吻。');
});

test('queued messages retain their skill and busy conversations refuse skill switches', async t => {
  let reached, release;
  const started = new Promise(resolve => { reached = resolve; });
  const provider = await localServer(t, (body, res) => {
    if (!release) { release = () => res.end('{"choices":[{"message":{"content":"done"}}]}'); reached(); }
    else res.end('{"choices":[{"message":{"content":"done"}}]}');
  });
  const app = apply({ lmStudioBaseUrl: provider.url, notifyProgress: false });
  const a = session({ messageId: 'skill-running', elements: [{ type: 'text', attrs: { content: 'a' } }] });
  const b = session({ userId: 'bob', messageId: 'skill-queued', elements: [{ type: 'text', attrs: { content: 'b' } }] });
  for (const s of [a, b]) { await dispatch(app, s, '/backend lmstudio'); await dispatch(app, s, '/skill summarize-text'); }
  await dispatch(app, a); await started; await dispatch(app, b);
  assert.equal(jobFiles(app.root).find(j => j.messageId === b.messageId).status, 'queued');
  assert.match(await dispatch(app, a, '/skill off'), /正在处理任务/);
  assert.match(await dispatch(app, b, '/skill off'), /正在处理任务/);
  assert.match(await dispatch(app, b, '/skill show'), /summarize-text/);
  fs.unlinkSync(path.join(app.root, 'skills', 'summarize-text', 'SKILL.md'));
  release(); await settle(app.root);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0].messages[0].content, provider.requests[1].messages[0].content);
  assert.ok(jobFiles(app.root).every(j => j.skill.instructions.length > 0 && j.delivery === 'sent'));
});

test('explicit skill libraries are read-only and missing roots fail before starting the bridge', async () => {
  const root = temp(), library = path.join(root, 'curated'); fs.mkdirSync(library);
  const app = apply({ skillsDir: library });
  assert.match(await slash(app, '/skill'), /暂无可用技能/);
  assert.deepEqual(fs.readdirSync(library), []);
  assert.equal(fs.existsSync(path.join(app.root, 'skills')), false);
  const missing = path.join(root, 'missing'), built = harness();
  assert.throws(() => plugin.apply(built.ctx, { allowedUsers: ['*'], dataDir: path.join(root, 'data'), skillsDir: missing, webBridgePort: 0 }));
  assert.equal(fs.existsSync(path.join(root, 'data', 'web-bridge-port')), false);
  assert.equal(fs.existsSync(missing), false);
});

test('QQ-created presets are public, creator-managed and selected independently by each user and session', async t => {
  const provider = await localServer(t);
  const config = { lmStudioBaseUrl: provider.url, notifyProgress: false, groupChat: true };
  const app = apply(config);
  const alice = session({ elements: [{ type: 'text', attrs: { content: '只有甲知道的秘密' } }] });
  const bob = session({ userId: 'bob', messageId: 'bob-first', elements: [{ type: 'text', attrs: { content: '乙的对话' } }] });
  assert.match(await dispatch(app, alice, '/preset create 共享角色\n你扮演角色甲。'), /已创建公共预设/);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false, 'creating a preset does not create or change a conversation');
  assert.match(await dispatch(app, alice, '/preset'), /共享角色 \[我创建\]/);
  assert.match(await dispatch(app, bob, '/preset'), /共享角色 \[公共\]/);
  assert.match(await dispatch(app, bob, '/preset show 共享角色'), /你扮演角色甲/);
  const file = path.join(app.root, 'presets', '共享角色.md'), before = fs.readFileSync(file);
  assert.match(await dispatch(app, bob, '/preset edit 共享角色\n覆盖'), /只有创建者/);
  assert.match(await dispatch(app, bob, '/preset delete 共享角色'), /只有创建者/);
  assert.match(await dispatch(app, bob, '/preset create 共享角色\n覆盖'), /同名/);
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(jobFiles(app.root), []);
  for (const s of [alice, bob]) {
    await dispatch(app, s, '/backend lmstudio'); await dispatch(app, s, '/preset 共享角色');
    await dispatch(app, s); await settle(app.root);
  }
  assert.deepEqual(provider.requests.map(r => r.messages[0].content), ['你扮演角色甲。', '你扮演角色甲。']);
  assert.equal(provider.requests[1].messages.length, 2); assert.doesNotMatch(JSON.stringify(provider.requests[1]), /只有甲知道/);
  assert.doesNotMatch(provider.requests[1].messages[0].content, /koishi-preset|owner/);
  assert.match(await dispatch(app, alice, '/preset edit 共享角色\n你扮演角色乙。'), /已更新/);
  bob.messageId = 'bob-edited'; await dispatch(app, bob); await settle(app.root);
  assert.equal(provider.requests.at(-1).messages[0].content, '你扮演角色乙。');
  assert.doesNotMatch(JSON.stringify(provider.requests.at(-1)), /只有甲知道/);
  assert.match(await dispatch(app, bob, '/new 独立剧情'), /沿用本地预设：共享角色/);
  bob.messageId = 'bob-new'; await dispatch(app, bob); await settle(app.root);
  assert.equal(provider.requests.at(-1).messages.length, 2);
  await dispatch(app, bob, '/preset create 乙的角色\n乙自己的设定');
  await dispatch(app, bob, '/preset 乙的角色');
  assert.match(await dispatch(app, alice, '/preset'), /当前本地预设：共享角色/);
  for (const dispose of app.disposes) dispose();
  const rebooted = apply({ ...config, dataDir: app.root });
  assert.match(await dispatch(rebooted, bob, '/preset'), /当前本地预设：乙的角色/);
  assert.match(await dispatch(rebooted, bob, '/preset edit 共享角色\n覆盖'), /只有创建者/);
  assert.match(await dispatch(rebooted, alice, '/preset edit 共享角色\n重启后的设定'), /已更新/);
  await dispatch(rebooted, bob, '/preset 共享角色');
  assert.match(await dispatch(rebooted, alice, '/preset delete 共享角色'), /已删除公共预设/);
  const calls = provider.requests.length, jobs = jobFiles(app.root).length;
  bob.messageId = 'deleted-template'; assert.match(await dispatch(rebooted, bob), /未找到预设/);
  assert.equal(provider.requests.length, calls); assert.equal(jobFiles(app.root).length, jobs);
  assert.equal(fs.existsSync(path.join(app.root, 'presets', '乙的角色.md')), true);
});

test('public preset command syntax, pagination and text escaping work without generating or changing selection', async () => {
  const app = apply();
  const name = '带 空格的角色';
  const prompt = '😀'.repeat(3200) + '\n末尾<at id="bot"/> &内容';
  assert.match(await slash(app, `/preset create ${name}\n${prompt}`), /已创建/);
  const first = await slash(app, `/preset show ${name}`);
  const pages = Number(/第 1\/(\d+) 页/.exec(first)[1]); assert.ok(pages > 1);
  for (let page = 1; page <= pages; page++) {
    const result = await slash(app, `/preset show --page ${page} ${name}`);
    assert.ok(result.length <= 1500);
    assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    if (page === pages) assert.match(result, /末尾&lt;at id="bot"\/&gt; &amp;内容/);
  }
  assert.match(await slash(app, `/preset show --page ${pages + 1} ${name}`), /只有.*页/);
  for (let i = 0; i < 16; i++) await slash(app, `/preset create 角色${i}\n设定`);
  assert.match(await slash(app, '/preset list 2'), /第 2\/2 页/);
  for (const value of ['create 名称', 'edit 名称', 'delete', 'delete 名称\n正文', 'show 名称\n正文', 'show --page 0', 'list zero', 'off extra'])
    assert.match(await slash(app, '/preset ' + value), /用法/);
  assert.match(await slash(app, '/preset create 超长\n' + '字'.repeat(8001)), /最多 8000/);
  assert.equal(fs.existsSync(path.join(app.root, 'presets', '超长.md')), false);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.deepEqual(jobFiles(app.root), []);
});

test('group members can publish public presets only when mentioned; other users can view but cannot manage them', async () => {
  const app = apply({ allowedUsers: ['alice'], groupChat: true });
  const command = '/preset create 群角色\n群里创建的公共角色';
  const member = { userId: 'group-bob', isDirect: false, channelId: 'group', stripped: { appel: true } };
  assert.equal(await slash(app, command, { userId: 'group-bob' }), undefined);
  assert.equal(await slash(app, command, { ...member, stripped: { appel: false } }), undefined);
  assert.equal(fs.readdirSync(path.join(app.root, 'presets')).length, 0);
  assert.match(await slash(app, command, member), /已创建公共预设/);
  assert.match(await slash(app, '/preset show 群角色'), /群里创建的公共角色/);
  assert.match(await slash(app, '/preset edit 群角色\n覆盖'), /只有创建者/);
  assert.match(await slash(app, '/preset delete 群角色', member), /已删除公共预设/);
  assert.equal(fs.readdirSync(path.join(app.root, 'presets')).length, 0);
  assert.deepEqual(jobFiles(app.root), []);
});

test('preset commands bind per conversation, reread local edits, inherit on /new and survive plugin restart', async t => {
  const provider = await localServer(t);
  const config = { lmStudioBaseUrl: provider.url, notifyProgress: false, groupChat: true };
  const app = apply(config);
  const file = name => path.join(app.root, 'presets', name + '.md');
  fs.writeFileSync(file('角色 A'), '设定 A'); fs.writeFileSync(file('角色 B'), '设定 B');
  assert.match(await slash(app, '/preset'), /未启用[\s\S]*角色 A[\s\S]*角色 B/);
  assert.match(await slash(app, '/preset 角色 A'), /已选择本地预设：角色 A[\s\S]*\/mode 本地/);
  assert.match(await slash(app, '/preset show'), /设定 A/);
  assert.deepEqual(jobFiles(app.root), [], 'preset commands never invoke either backend');
  await slash(app, '/backend lmstudio');
  assert.match(await slash(app, '/status'), /当前本地预设：角色 A/);
  const s = session({ elements: [{ type: 'text', attrs: { content: '第一轮' } }] });
  await dispatch(app, s); await settle(app.root);
  const first = jobFiles(app.root)[0];
  assert.deepEqual(provider.requests[0].messages[0], { role: 'system', content: '设定 A' });
  assert.match(await slash(app, `/status ${first.id}`), /本地预设：角色 A（版本/);
  fs.writeFileSync(file('角色 A'), '编辑后的 A');
  s.messageId = 'preset-edited'; await dispatch(app, s); await settle(app.root);
  assert.equal(provider.requests[1].messages[0].content, '编辑后的 A');
  assert.equal(jobFiles(app.root).find(j => j.id === first.id).preset.prompt, '设定 A');
  assert.match(await slash(app, '/new 新剧情'), /沿用本地预设：角色 A/);
  s.messageId = 'preset-new'; await dispatch(app, s); await settle(app.root);
  assert.equal(provider.requests[2].messages.length, 2, '/new starts with system and current user only');
  assert.equal(provider.requests[2].messages[0].content, '编辑后的 A');
  assert.match(await slash(app, '/preset 角色 B'), /已选择本地预设：角色 B/);
  assert.match(await slash(app, '/preset', { userId: 'bob' }), /未启用/);
  assert.match(await slash(app, '/preset', { isDirect: false, channelId: 'group', stripped: { appel: true } }), /未启用/);
  assert.match(await slash(app, `/chat ${first.sessionId}`, { userId: 'bob' }), /未找到/);
  assert.match(await slash(app, '/chat'), /本地预设：角色 A[\s\S]*本地预设：角色 B/);
  await slash(app, `/chat ${first.sessionId}`);
  assert.match(await slash(app, '/preset'), /当前本地预设：角色 A/);
  await slash(app, '/preset off');
  s.messageId = 'preset-off'; await dispatch(app, s); await settle(app.root);
  assert.equal(provider.requests.at(-1).messages.some(m => m.role === 'system'), false);
  const conversations = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json')));
  const second = conversations.items.find(c => c.id !== first.sessionId && c.owner === 'alice' && c.chat === 'qq:alice');
  await slash(app, `/chat ${second.id}`);
  for (const dispose of app.disposes) dispose();
  const rebooted = apply({ ...config, dataDir: app.root });
  assert.match(await slash(rebooted, '/preset show'), /当前本地预设：角色 B[\s\S]*设定 B/);
  await slash(rebooted, '/backend web');
  s.messageId = 'preset-web'; await dispatch(rebooted, s); await settle(rebooted.root);
  assert.equal(jobFiles(app.root).find(j => j.messageId === 'preset-web').preset, undefined, 'saved local presets never enter web tasks');
  assert.match(await slash(rebooted, '/new 网页新会话'), /沿用本地预设：角色 B/);
});

test('queued local messages keep their original preset when files change; switching waits until the task ends', async t => {
  let reached, release;
  const started = new Promise(resolve => { reached = resolve; });
  const provider = await localServer(t, (body, res) => {
    if (!release) { release = () => res.end('{"choices":[{"message":{"content":"done"}}]}'); reached(); }
    else res.end('{"choices":[{"message":{"content":"done"}}]}');
  });
  const app = apply({ lmStudioBaseUrl: provider.url, notifyProgress: false });
  await slash(app, '/preset create role\noriginal');
  const a = session({ messageId: 'preset-running', elements: [{ type: 'text', attrs: { content: 'a' } }] });
  await dispatch(app, a, '/backend lmstudio'); await dispatch(app, a, '/preset role');
  await dispatch(app, a); await started;
  const b = session({ userId: 'bob', messageId: 'preset-queued', elements: [{ type: 'text', attrs: { content: 'b' } }] });
  await dispatch(app, b, '/backend lmstudio'); await dispatch(app, b, '/preset role'); await dispatch(app, b);
  assert.equal(jobFiles(app.root).find(j => j.messageId === b.messageId).status, 'queued');
  assert.match(await dispatch(app, a, '/preset off'), /正在处理任务/);
  assert.match(await dispatch(app, b, '/preset off'), /正在处理任务/);
  assert.match(await dispatch(app, a, '/preset edit role\nedited'), /已更新/);
  assert.match(await dispatch(app, a, '/preset delete role'), /已删除/);
  release(); await settle(app.root);
  assert.deepEqual(provider.requests.map(body => body.messages[0].content), ['original', 'original']);
  assert.equal(jobFiles(app.root).find(j => j.messageId === b.messageId).preset.prompt, 'original');
  assert.match(await dispatch(app, b, '/preset show'), /未找到预设/);
});

test('missing or invalid selected presets and preset budget overflow never submit an unconfigured message', async t => {
  const provider = await localServer(t);
  const app = apply({ lmStudioBaseUrl: provider.url, lmStudioHistoryChars: 1500 });
  const file = path.join(app.root, 'presets', 'role.md'); fs.writeFileSync(file, 'a'.repeat(1498));
  assert.match(await slash(app, '/preset ../secret'), /预设名称/);
  assert.match(await slash(app, '/preset missing'), /未找到预设/);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  await slash(app, '/preset role'); await slash(app, '/backend lmstudio');
  assert.match(await slash(app, '/preset show'), /预览已分页/);
  const s = session({ elements: [{ type: 'text', attrs: { content: 'too long' } }] });
  assert.match(await dispatch(app, s), /上下文字数/);
  fs.writeFileSync(file, ''); assert.match(await dispatch(app, s), /非空/);
  fs.unlinkSync(file); assert.match(await dispatch(app, s), /未找到预设/);
  assert.equal(provider.requests.length, 0); assert.deepEqual(jobFiles(app.root), []);
  await slash(app, '/preset off');
  await dispatch(app, s); await settle(app.root);
  assert.equal(provider.requests.length, 1); assert.equal(provider.requests[0].messages.length, 1);
});

test('LM Studio commands drive continuous chat, isolate users and inherit the local backend on /new', async t => {
  const provider = await localServer(t);
  const app = apply({ lmStudioBaseUrl: provider.url, notifyProgress: false });
  const s = session({ elements: [{ type: 'text', attrs: { content: '暗号 8427' } }] });
  await dispatch(app, s, '/reasoning high');
  assert.match(await dispatch(app, s, '/backend lmstudio'), /已切换到 LM Studio：local-chat/);
  assert.equal(jobFiles(app.root).length, 0);
  assert.match(await dispatch(app, s, '/reasoning medium'), /使用本地模型设置/);
  assert.match(await dispatch(app, s, '/status'), /LM Studio 已连接/);
  await dispatch(app, s); await settle(app.root);
  assert.equal(s.sent.at(-1), '本地回答 暗号 8427');
  assert.equal(s.sent.length, 1, '/logs off behavior applies to local inference');
  const first = jobFiles(app.root)[0]; assert.equal(first.backend, 'lmstudio'); assert.equal(first.reasoningEffort, undefined);
  assert.match(await dispatch(app, s, '/chat'), /\[LM Studio：local-chat\]/);
  s.messageId = 'local-2'; s.elements = [{ type: 'text', attrs: { content: '暗号是什么？' } }];
  await dispatch(app, s); await settle(app.root);
  assert.deepEqual(provider.requests[1].messages.map(m => m.content), ['暗号 8427', '本地回答 暗号 8427', '暗号是什么？']);
  const beforeRetry = provider.requests.length;
  assert.equal(await dispatch(app, s, '/retry'), undefined);
  assert.equal(provider.requests.length, beforeRetry, '/retry must deliver stored output without inference');
  const other = session({ userId: 'bob', channelId: 'bob', messageId: 'other-1', elements: [{ type: 'text', attrs: { content: '你好' } }] });
  await dispatch(app, other, '/backend lmstudio'); await dispatch(app, other); await settle(app.root);
  assert.equal(provider.requests.at(-1).messages.length, 1);
  assert.match(await dispatch(app, s, '/new 新话题'), /已开启/);
  assert.match(await dispatch(app, s, '/backend'), /当前后端：LM Studio/);
  s.messageId = 'local-new'; await dispatch(app, s); await settle(app.root);
  assert.equal(provider.requests.at(-1).messages.length, 1);
  await dispatch(app, s, `/chat ${first.sessionId}`);
  assert.match(await dispatch(app, s, '/backend web'), /切回 ChatGPT 网页/);
  assert.match(await dispatch(app, s, '/reasoning'), /推理程度：高/);
  await dispatch(app, s, '/backend lmstudio');
  s.messageId = 'local-return'; await dispatch(app, s); await settle(app.root);
  assert.equal(provider.requests.at(-1).messages.length, 5, 'returning to local restores its prior context');
});

test('QQ image/text messages reach local vision inference and text follow-ups retain the original images', async t => {
  const provider = await localServer(t);
  const app = apply({ lmStudioBaseUrl: provider.url, notifyProgress: false });
  const bytes = visionPng({ width: 64, height: 40 }), src = 'data:image/png;base64,' + bytes.toString('base64');
  const s = session({ messageId: 'vision-qq-1', elements: [
    { type: 'text', attrs: { content: '看左图' } }, { type: 'img', attrs: { src } },
    { type: 'text', attrs: { content: '再看右图' } }, { type: 'img', attrs: { src } },
  ] });
  assert.match(await dispatch(app, session(), '/backend lmstudio'), /已切换到 LM Studio/); await dispatch(app, s);
  const [first] = await settle(app.root);
  assert.equal(first.status, 'ready'); assert.equal(s.sent.at(-1), '本地图片回答');
  const content = provider.requests[0].messages[0].content;
  assert.deepEqual(content.map(p => p.type), ['text', 'image_url', 'text', 'image_url']);
  assert.equal(content[1].image_url.url, src);
  s.messageId = 'vision-qq-2'; s.elements = [{ type: 'text', attrs: { content: '左边是什么颜色？' } }];
  await dispatch(app, s); await settle(app.root);
  assert.deepEqual(provider.requests[1].messages[0].content, content);
  assert.equal(provider.requests[1].messages.at(-1).content, '左边是什么颜色？');
  const before = provider.requests.length; await dispatch(app, s, '/retry');
  assert.equal(provider.requests.length, before);
});

test('QQ image-only and quoted images keep their labels and pixels on the local backend', async t => {
  const provider = await localServer(t);
  const app = apply({ lmStudioBaseUrl: provider.url, notifyProgress: false });
  const src = 'data:image/png;base64,' + visionPng({ width: 64, height: 40 }).toString('base64');
  const s = session({ messageId: 'only-qq-image', elements: [{ type: 'img', attrs: { src } }] });
  assert.match(await dispatch(app, session(), '/backend lmstudio'), /已切换到 LM Studio/); await dispatch(app, s); await settle(app.root);
  assert.deepEqual(provider.requests[0].messages[0].content.map(p => p.type), ['image_url']);
  s.messageId = 'quoted-qq-image'; s.elements = [{ type: 'text', attrs: { content: '这是什么？' } }];
  s.quote = { elements: [{ type: 'img', attrs: { src } }] };
  await dispatch(app, s); await settle(app.root);
  const last = provider.requests[1].messages.at(-1).content;
  assert.match(last.filter(p => p.type === 'text').map(p => p.text).join('\n'), /引用消息[\s\S]*本次消息[\s\S]*这是什么/);
  assert.equal(last.find(p => p.type === 'image_url').image_url.url, src);
});

test('local cancellation aborts HTTP, prevents backend changes while busy and leaves history untouched', async t => {
  let reached; const started = new Promise(resolve => { reached = resolve; });
  const provider = await localServer(t, () => reached());
  const app = apply({ lmStudioBaseUrl: provider.url, notifyProgress: false });
  const s = session({ elements: [{ type: 'text', attrs: { content: '慢请求' } }] });
  await dispatch(app, s, '/backend lmstudio'); await dispatch(app, s); await started;
  assert.match(await dispatch(app, s, '/status'), /LM Studio处理中/);
  assert.match(await dispatch(app, s, '/backend web'), /正在处理任务/);
  assert.match(await dispatch(app, s, '/stop'), /停止本地模型/);
  const [cancelled] = await settle(app.root); assert.equal(cancelled.status, 'cancelled');
  assert.equal(fs.existsSync(path.join(app.root, 'lmstudio')), false);
  assert.match(await dispatch(app, s, '/backend web'), /切回 ChatGPT 网页/);
  assert.equal(provider.requests.length, 1);
});

test('a failed or racing model lookup never changes backend or submits a task', async t => {
  const provider = await localServer(t);
  const app = apply({ lmStudioBaseUrl: provider.url });
  const s = session();
  assert.match(await dispatch(app, s, '/backend lmstudio missing'), /未提供聊天模型/);
  assert.match(await dispatch(app, s, '/backend'), /当前后端：ChatGPT 网页/);
  assert.match(await dispatch(app, s, '/backend invalid'), /用法/);
  assert.equal(jobFiles(app.root).length, 0);
  const changing = dispatch(app, s, '/backend lmstudio');
  await dispatch(app, s, '/new other');
  assert.match(await changing, /状态已变化/);
  assert.match(await dispatch(app, s, '/backend'), /当前后端：ChatGPT 网页/);
});

test('image template selection, preview and paging are local and persist per conversation', async () => {
  const app = apply({ groupChat: true });
  assert.match(await slash(app, '/prompt'), /未选择[\s\S]*角色海报/);
  assert.match(await slash(app, '/draw 英雄'), /请先用 \/prompt/);
  assert.match(await slash(app, '/prompt 角色海报'), /已选择图片模板/);
  assert.match(await slash(app, '/prompt show'), /\{\{角色名\}\}/);
  const preview = await slash(app, '/prompt preview 黑衣剑士 $&');
  assert.match(preview, /黑衣剑士 \$&amp;/);
  assert.ok(!preview.includes('{{角色名}}'));
  assert.match(preview, /尚未发送/);
  assert.match(await slash(app, '/prompt', { userId: 'bob' }), /未选择/);
  assert.match(await slash(app, '/prompt', { isDirect: false, channelId: 'group', stripped: { appel: true } }), /未选择/);
  const first = JSON.parse(fs.readFileSync(path.join(app.root, 'conversations.json'))).items[0];
  await slash(app, '/new 新图');
  assert.match(await slash(app, '/prompt'), /当前图片模板：角色海报/);
  await slash(app, '/prompt off');
  assert.match(await slash(app, '/prompt'), /未选择/);
  await slash(app, `/chat ${first.id}`);
  fs.writeFileSync(path.join(app.root, 'prompts', '角色海报.md'), '{{角色名}}' + '长'.repeat(3000));
  assert.match(await slash(app, '/prompt show'), /第 1\/3 页/);
  assert.match(await slash(app, '/prompt preview --page 2 英雄'), /第 2\/3 页/);
  assert.match(await slash(app, '/prompt show --page 99'), /只有 3 页/);
  assert.deepEqual(jobFiles(app.root), []);
  for (const dispose of app.disposes) dispose();
  const restarted = apply({ dataDir: app.root });
  assert.match(await slash(restarted, '/prompt'), /当前图片模板：角色海报/);
  assert.match(await slash(restarted, '/prompt show'), /长/);
});

test('QQ image templates are public, creator-managed and retain independent selection after restart', async () => {
  const app = apply();
  const bob = { userId: 'bob' };
  assert.match(await slash(app, '/prompt create 共享海报\n画{{角色名}}，{{画风|水彩}}'), /已创建公共图片模板/);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.match(await slash(app, '/prompt'), /共享海报 \[我创建\]/);
  assert.match(await slash(app, '/prompt', bob), /共享海报 \[公共\]/);
  const show = await slash(app, '/prompt show 共享海报', bob);
  assert.match(show, /仅创建者可管理[\s\S]*画\{\{角色名\}\}/);
  assert.doesNotMatch(show, /koishi-image-prompt|alice/);
  assert.match(await slash(app, '/prompt create 共享海报\n{{角色名}}', bob), /同名/);
  assert.match(await slash(app, '/prompt edit 共享海报\n{{角色名}}', bob), /只有创建者/);
  assert.match(await slash(app, '/prompt delete 共享海报', bob), /只有创建者/);
  assert.match(await slash(app, '/prompt edit 角色海报\n{{角色名}}'), /本地创建/);
  assert.match(await slash(app, '/prompt delete 角色海报'), /本地创建/);
  await slash(app, '/prompt 共享海报', bob);
  await slash(app, '/prompt 角色海报');
  await slash(app, '/new 新图', bob);
  assert.match(await slash(app, '/prompt', bob), /当前图片模板：共享海报/);
  assert.match(await slash(app, '/prompt'), /当前图片模板：角色海报/);
  for (const dispose of app.disposes) dispose();
  const rebooted = apply({ dataDir: app.root });
  assert.match(await slash(rebooted, '/prompt', bob), /当前图片模板：共享海报/);
  assert.match(await slash(rebooted, '/prompt edit 共享海报\n{{角色名}}', bob), /只有创建者/);
  assert.match(await slash(rebooted, '/prompt edit 共享海报\n新版{{角色名}}'), /已更新/);
  assert.match(await slash(rebooted, '/prompt preview 英雄', bob), /新版英雄/);
  assert.match(await slash(rebooted, '/prompt delete 共享海报'), /已删除/);
  assert.match(await slash(rebooted, '/draw 英雄', bob), /未找到模板/);
  assert.match(await slash(rebooted, '/prompt off', bob), /已取消/);
  assert.match(await slash(rebooted, '/prompt'), /当前图片模板：角色海报/);
  assert.deepEqual(jobFiles(app.root), []);
});

test('image template management validates multiline syntax, paginates safely and never generates', async () => {
  const app = apply();
  const name = '带 空格的模板';
  const body = '{{角色名}}\n' + '😀'.repeat(3200) + '\n末尾<at id="bot"/> &内容';
  assert.match(await slash(app, `/PROMPT CREATE ${name}\r\n${body}`), /已创建/);
  const first = await slash(app, `/prompt show ${name}`);
  const pages = Number(/第 1\/(\d+) 页/.exec(first)[1]); assert.ok(pages > 1);
  for (let page = 1; page <= pages; page++) {
    const result = await slash(app, `/prompt show --page ${page} ${name}`);
    assert.ok(result.length <= 1500);
    assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    if (page === pages) assert.match(result, /末尾&lt;at id="bot"\/&gt; &amp;内容/);
  }
  for (let i = 0; i < 16; i++) await slash(app, `/prompt create 模板${i}\n{{角色名}}`);
  assert.match(await slash(app, '/prompt list 2'), /第 2\//);
  for (const value of ['create 名称', 'create 名称\n', 'edit 名称', 'delete', 'delete 名称\n正文',
    'show 名称\n正文', 'preview 英雄\n正文', 'list\n正文', 'off\n正文', 'off extra'])
    assert.match(await slash(app, '/prompt ' + value), /用法/);
  assert.match(await slash(app, '/prompt create 无效\n没有角色占位符'), /占位符/);
  assert.match(await slash(app, '/prompt create 超长\n{{角色名}}' + '字'.repeat(8000)), /最多 8000/);
  assert.match(await slash(app, `/prompt edit ${name}\n没有角色占位符`), /占位符/);
  assert.match(await slash(app, `/prompt show ${name}`), /\{\{角色名\}\}/);
  assert.equal(fs.existsSync(path.join(app.root, 'prompts', '无效.md')), false);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.deepEqual(jobFiles(app.root), []);
});

test('image template management follows private access and group mention gates with creator-only mutations', async () => {
  const app = apply({ allowedUsers: ['alice'], groupChat: true });
  const member = { userId: 'group-bob', isDirect: false, channelId: 'group', stripped: { appel: true } };
  const command = '/prompt create 群模板\n画{{角色名}}';
  const file = path.join(app.root, 'prompts', '群模板.md');
  assert.equal(await slash(app, command, { userId: 'group-bob' }), undefined);
  assert.equal(await slash(app, command, { ...member, stripped: { appel: false } }), undefined);
  assert.equal(fs.existsSync(file), false);
  assert.match(await slash(app, command, member), /已创建/);
  assert.match(await slash(app, '/prompt show 群模板'), /画\{\{角色名\}\}/);
  assert.match(await slash(app, '/prompt edit 群模板\n新{{角色名}}'), /只有创建者/);
  assert.match(await slash(app, '/prompt delete 群模板'), /只有创建者/);
  assert.equal(await slash(app, '/prompt delete 群模板', { ...member, stripped: { appel: false } }), undefined);
  assert.match(await slash(app, '/prompt edit 群模板\n新{{角色名}}', member), /已更新/);
  assert.match(await slash(app, '/prompt delete 群模板', member), /已删除/);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(jobFiles(app.root), []);
});

test('QQ image template edits and deletion preserve the submitted web request and image delivery', async () => {
  const app = apply({ notifyProgress: false });
  const { port, token } = await bridgeOf(app.root);
  const headers = { 'x-bridge-token': token, 'Content-Type': 'application/json' };
  const beat = () => fetch(`http://127.0.0.1:${port}/state`, { headers });
  await beat();
  const body = '生成{{角色名}}的图片。' + '细节'.repeat(850) + '\n主角：{{角色名}}';
  assert.match(await slash(app, '/prompt create 测试海报\n' + body), /已创建公共图片模板/);
  await slash(app, '/prompt 测试海报');
  const s = session({ messageId: 'draw-test' });
  await dispatch(app, s, '/draw 黑衣剑士');
  let request;
  for (let attempt = 0; attempt < 300 && !request; attempt++) {
    request = (await (await beat()).json()).job;
    if (!request) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(request);
  assert.equal(request.text, body.replaceAll('{{角色名}}', '黑衣剑士'));
  assert.ok(!request.text.includes('/draw'));
  assert.equal(jobFiles(app.root)[0].imagePrompt.owner, undefined);
  assert.match(await slash(app, '/prompt edit 测试海报\n新版{{角色名}}'), /已更新/);
  assert.match(await slash(app, '/prompt preview 第二人'), /新版第二人/);
  assert.match(await slash(app, '/draw 第二人', { messageId: 'busy-draw' }), /当前会话仍在处理/);
  assert.match(await slash(app, '/prompt delete 测试海报'), /已删除公共图片模板/);
  assert.match(await slash(app, '/draw 第二人', { messageId: 'deleted-draw' }), /未找到模板/);
  await dispatch(app, s, '/draw 黑衣剑士');
  assert.equal(jobFiles(app.root).length, 1, 'duplicate draw never submits twice');
  assert.equal(jobFiles(app.root)[0].imagePrompt.template, body);
  const bytes = pngBytes(512);
  assert.equal((await fetch(`http://127.0.0.1:${port}/result-asset?id=${request.id}&i=0`,
    { method: 'POST', headers: { 'x-bridge-token': token }, body: bytes })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', headers,
    body: JSON.stringify({ id: request.id, threadId: THREAD, segments: [{ type: 'image', asset: 0 }] }) })).status, 200);
  const [finished] = await settle(app.root);
  assert.equal(finished.delivery, 'sent');
  assert.deepEqual(s.sent, [`<img src="data:image/png;base64,${bytes.toString('base64')}"/>`]);
  assert.equal(finished.input[0].text, request.text);
  await slash(app, `/retry ${request.id}`, { messageId: 'retry-draw' });
  assert.equal(jobFiles(app.root).length, 1);
});

test('draw validates missing files and roles and refuses local backend without submitting; ordinary chat stays unchanged', async t => {
  const provider = await localServer(t);
  const app = apply({ lmStudioBaseUrl: provider.url });
  await slash(app, '/prompt 角色海报');
  assert.match(await slash(app, '/draw'), /角色名须/);
  assert.match(await slash(app, '/draw a\nb'), /单行文本/);
  assert.match(await slash(app, '/prompt ../secret'), /模板名称/);
  const file = path.join(app.root, 'prompts', '角色海报.md');
  fs.unlinkSync(file);
  assert.match(await slash(app, '/draw 英雄'), /未找到模板/);
  fs.writeFileSync(file, '{{角色名}}'.repeat(100));
  assert.match(await slash(app, '/draw ' + '人'.repeat(100)), /替换后/);
  fs.writeFileSync(file, '生成{{角色名}}的图片');
  await slash(app, '/backend lmstudio');
  assert.match(await slash(app, '/draw 英雄'), /先发送 \/mode 工作/);
  assert.deepEqual(jobFiles(app.root), []);
  assert.equal(provider.requests.length, 0);
  await slash(app, '/backend web');
  const s = session({ messageId: 'ordinary-after-template', elements: [{ type: 'text', attrs: { content: '修改上一张图的背景' } }] });
  await dispatch(app, s); await settle(app.root);
  assert.deepEqual(jobFiles(app.root)[0].input, [{ type: 'text', text: '修改上一张图的背景' }]);
  assert.equal(jobFiles(app.root)[0].imagePrompt, undefined);
  assert.match(await dispatch(app, session({ messageId: 'long-ordinary', elements: [{ type: 'text', attrs: { content: '字'.repeat(1501) } }] })), /文字最多 1500/);
});

test('multi-variable previews preserve all parameters in page navigation and /draw sends the same expanded text', async () => {
  const app = apply({ notifyProgress: false });
  const body = '{{角色名}} {{场景|花园}} {{道具}}\n' + '细节'.repeat(1500);
  fs.writeFileSync(path.join(app.root, 'prompts', '参数测试.md'), body);
  assert.match(await slash(app, '/prompt 参数测试'), /必填参数：道具[\s\S]*可选参数：场景、补充要求/);
  assert.match(await slash(app, '/draw 孙悟空'), /缺少必填参数：道具/);
  const request = String.raw`孙悟空 | 场景=雨\|夜 | 道具=金箍棒 | 补充要求=水彩`;
  const preview = await slash(app, '/prompt preview ' + request);
  assert.match(preview, /孙悟空 雨\|夜 金箍棒/);
  const navigation = preview.match(/(\/prompt preview --page 2 [^\n]+) 查看下一页。/)[1];
  assert.equal(navigation, '/prompt preview --page 2 ' + request);
  assert.match(await slash(app, navigation), /第 2\//);
  assert.deepEqual(jobFiles(app.root), [], 'previews and validation failures never submit');
  await slash(app, '/draw ' + request, { messageId: 'multi-draw' }); await settle(app.root);
  const [job] = jobFiles(app.root);
  assert.equal(job.imagePrompt.request, request);
  assert.equal(job.imagePrompt.parameters.场景, '雨|夜');
  assert.equal(job.imagePrompt.parameters.道具, '金箍棒');
  assert.equal(job.input[0].text, job.imagePrompt.text);
  assert.match(job.input[0].text, /补充要求：水彩/);
  assert.ok(!job.input[0].text.includes('{{'));
});
