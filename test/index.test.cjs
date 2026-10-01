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

const apps = [];

// A minimal stand-in for the parts of the Koishi context this plugin uses. It
// models the two behaviours the wiring actually depends on: registration order
// (management commands first, then the catch-all forwarder) and Koishi's
// `next(fallback)` semantics, where the remaining stages run first and the
// fallback only fires when nothing downstream produced a result.
function harness() {
  const stages = [], intervals = [], disposes = [];
  const scope = filter => ({
    command: definition => ({ action: handler => { stages.push({ kind: 'command', name: definition.split(' ')[0], handler, filter }); } }),
    middleware: callback => { stages.push({ kind: 'middleware', callback, filter }); },
  });
  const ctx = {
    intersect: filter => scope(filter),
    setInterval: (fn, ms) => intervals.push(ms),
    on: (event, fn) => { if (event === 'dispose') disposes.push(fn); },
    logger: () => ({ info: () => {} }),
  };
  return { ctx, stages, intervals, disposes };
}
function session({ userId = 'alice', isDirect = true, channelId = 'alice', messageId = 'm1', elements = [], sent = [], stripped } = {}) {
  return { platform: 'qq', userId, channelId, isDirect, messageId, elements, sent, timestamp: Date.now(), stripped,
    send: async content => { sent.push(content); return ['msg-id']; } };
}
async function dispatch({ stages }, s, text) {
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
  const outcome = await run(0);
  return outcome.handled ? outcome.value : undefined;
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
    if (jobs.length && jobs.every(j => !['queued', 'running'].includes(j.status))) return jobs;
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
  const created = await dispatch(app, s, '桥接新建会话 月夜');
  assert.match(created, /已新建并切换：月夜/);
  assert.match(await dispatch(app, s, '桥接会话列表'), /月夜/);
  assert.equal(await dispatch(app, s, '桥接状态'), '未找到你的任务');
  assert.deepEqual(jobFiles(app.root), [], '命令不该变成发给 ChatGPT 的消息');
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
