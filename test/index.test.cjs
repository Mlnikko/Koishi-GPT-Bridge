const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plugin = require('../src/index.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-test-'));
const wait = () => new Promise(resolve => setImmediate(resolve));
// A 1x1-ish PNG header is enough: the downloader sniffs magic bytes, it never
// decodes the picture.
const png = () => `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300)]).toString('base64')}`;

const apps = [];

// A minimal stand-in for the parts of the Koishi context this plugin uses. It
// models the two behaviours the wiring actually depends on: registration order
// (image middleware, then the drawing commands, then the deferred natural
// language router) and Koishi's `next(fallback)` semantics, where the remaining
// stages run first and the fallback only fires when nothing downstream produced
// a result. Getting this wrong is exactly how a router silently swallows every
// command, so it is worth asserting against.
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
function session({ userId = 'alice', isDirect = true, channelId = 'alice', messageId = 'm1', elements = [], sent = [] } = {}) {
  return { platform: 'qq', userId, channelId, isDirect, messageId, elements, sent, timestamp: Date.now(),
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
// Waits for the queue to reach a terminal state; the bridge's listen() callback
// is asynchronous, so a fixed number of ticks is not a reliable signal.
const settle = async (root, timeout = 4000) => {
  const started = Date.now();
  for (;;) {
    const jobs = jobFiles(root);
    if (jobs.length && jobs.every(j => !['queued', 'running'].includes(j.status))) return jobs;
    if (Date.now() - started > timeout) throw new Error('任务未在预期时间内结束');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test('a private image message becomes a persisted reference-image job', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'img', attrs: { src: png() } }, { type: 'text', attrs: { content: '把背景改成夜晚' } }] });
  await dispatch(app, s, undefined);
  assert.match(s.sent[0], /已接收画图任务 \S+（ChatGPT 网页）（参考 1 张图片）/);
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'image');
  assert.equal(jobs[0].prompt, '把背景改成夜晚');
  assert.deepEqual(jobs[0].inputImages.map(image => image.file), ['input-0.png']);
  assert.equal(fs.existsSync(path.join(app.root, 'jobs', jobs[0].id, 'input-0.png')), true);
  // No local process, no backend field: the job is handed to the local bridge.
  assert.equal(jobs[0].backend, undefined);
});

test('a pure image message is accepted with no text at all', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'img', attrs: { src: png() } }] });
  await dispatch(app, s, undefined);
  await wait();
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'image');
  assert.equal(jobs[0].prompt, '');
});

test('a picture that cannot be downloaded is reported and never enqueued', async () => {
  const app = apply();
  const s = session({ elements: [{ type: 'img', attrs: { src: 'file:///etc/passwd' } }] });
  const reply = await dispatch(app, s, undefined);
  assert.match(reply, /图片处理失败/);
  assert.deepEqual(jobFiles(app.root), []);
  assert.equal(s.sent.length, 0);
});

test('the drawing command still enqueues a plain text job', async () => {
  const app = apply();
  const s = session();
  await dispatch(app, s, '画图 一只穿宇航服的橘猫');
  const jobs = jobFiles(app.root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'text');
  assert.equal(jobs[0].prompt, '一只穿宇航服的橘猫');
  assert.deepEqual(jobs[0].inputImages, []);
});

test('unauthorized sessions never reach the handlers or the downloader', async () => {
  const app = apply({ allowedUsers: ['someone-else'] });
  const outsider = session({ userId: 'mallory', elements: [{ type: 'img', attrs: { src: 'http://example.invalid/a.png' } }] });
  assert.equal(await dispatch(app, outsider, undefined), undefined);
  assert.equal(await dispatch(app, outsider, '画图 猫'), undefined);
  assert.deepEqual(jobFiles(app.root), []);
  const group = session({ isDirect: false, elements: [{ type: 'img', attrs: { src: 'http://example.invalid/a.png' } }] });
  assert.equal(await dispatch(app, group, undefined), undefined);
  assert.deepEqual(jobFiles(app.root), []);
});

test('a job handed to the bridge fails cleanly while no browser is connected', async () => {
  const app = apply();
  const s = session();
  await dispatch(app, s, '画图 猫');
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
