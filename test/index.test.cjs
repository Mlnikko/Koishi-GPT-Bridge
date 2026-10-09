const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plugin = require('../src/index.cjs');

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
  const root = temp();
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
  assert.match(s.sent[0], /会话：默认会话（\S{8}）/, '第一次发消息就该自动进入默认会话，不需要任何命令');
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
  assert.match(list, /当前：默认会话（\S{8}）/);
  assert.match(list, /默认会话 \[当前\]/);
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
  assert.match(list, /默认会话/, '旧会话保留，仍可切回');
  assert.match(await dispatch(app, s, `/chat ${first.sessionId}`), /已切换：默认会话/);
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
  assert.equal(saved.items[0].webThreadId, undefined, '失效的网页会话必须解绑，否则这个用户会被永久卡死');
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

test('help lists exactly eight short commands and slash commands stay local and authorized', async () => {
  const app = apply({ allowedUsers: ['alice'], groupChat: true });
  const help = await slash(app, '/help');
  assert.deepEqual(help.match(/^\/[a-z]+/gm), ['/help', '/new', '/chat', '/close', '/status', '/stop', '/retry', '/logs']);
  assert.equal(app.stages.some(s => s.kind === 'command'), false, 'short commands must not register bare words in Koishi');
  assert.equal(await dispatch(app, session(), '/help'), help);
  assert.equal(await slash(app, '/help', { userId: 'bob' }), undefined);
  assert.equal(await slash(app, '/help', { isDirect: false }), undefined);
  assert.equal(await slash(app, '/help', { isDirect: false, stripped: { appel: true, content: '/help' } }), help);
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
  for (const text of ['/help', '/new', '/chat', '/close', '/status', '/stop', '/retry', '/logs off']) {
    assert.equal(await slash(app, text, { userId: 'mallory' }), undefined);
    assert.equal(await slash(app, text, { isDirect: false, channelId: 'group', stripped: { appel: false, content: text } }), undefined);
  }
  assert.deepEqual(jobFiles(app.root), []);
  assert.equal(fs.existsSync(path.join(app.root, 'conversations.json')), false);
  assert.equal(fs.existsSync(path.join(app.root, 'preferences.json')), false);
});

test('bare words, unknown slash text and command-looking image captions are forwarded as content', async () => {
  const app = apply({ notifyProgress: false });
  for (const text of ['new', 'stop', 'status', '/stopping', '桥接状态正常吗？']) {
    await slash(app, text, { messageId: text });
    await settle(app.root);
  }
  const s = session({ messageId: 'caption', elements: [
    { type: 'text', attrs: { content: '/stop' } }, { type: 'img', attrs: { src: png() } },
  ] });
  await dispatch(app, s, '/stop');
  await settle(app.root);
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 6);
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
