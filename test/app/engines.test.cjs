'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunner } = require('../../src/app/engines.cjs');
const { Conversations } = require('../../src/core/conversations.cjs');

const OLD = '11111111-2222-3333-4444-555555555555';
const NEW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = '99999999-2222-3333-4444-555555555555';
const gone = beforeSubmission => Object.assign(Error('网页会话已不存在'), { code: 'thread_gone', beforeSubmission });

function setup(t, { mode = 'chat', run, replyTimeoutMs = 300000, timestamp = Date.now() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engines-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chats = new Conversations(path.join(root, 'conversations.json'));
  const chat = chats.create('alice', 'qq:alice', '话题', { mode });
  chats.bindWeb(chat, OLD, mode);
  chats.bindWeb(chat, OTHER, mode === 'chat' ? 'work' : 'chat');
  const job = { id: 'abcdef123456', sessionId: chat.id, owner: chat.owner, conversation: chat.chat,
    mode, reasoningEffort: 'high', ...(mode === 'work' ? { skill: { name: 'summarize-text' } } : {}),
    input: [{ type: 'text', text: '继续处理这张图' }, { type: 'image', file: 'input-0.png' }] };
  const calls = [], bindings = [], progress = [];
  const controller = new AbortController();
  const runner = createRunner({ chats, replyTimeoutMs, getSession: () => ({ timestamp }),
    onProgress: (current, phase) => { assert.equal(current, job); progress.push(phase); },
    web: { run: async (current, options) => {
      calls.push({ job: current, options });
      if (options.threadId) options.onThread(options.threadId);
      return run({ current, options, calls, controller });
    } }, local: { run: () => assert.fail('不能提交到本地模型') } });
  return { chats, chat, job, calls, bindings, progress, controller,
    run: () => runner(job, controller.signal, id => bindings.push(id)) };
}

for (const mode of ['chat', 'work']) test(mode + ' recovers the same job once on a fresh webpage thread', async t => {
  const output = [{ type: 'text', text: '已完成' }];
  const f = setup(t, { mode, run: ({ options, calls }) => {
    if (calls.length === 1) throw gone(true);
    assert.equal(options.threadId, undefined);
    options.onThread(NEW);
    return output;
  } });
  assert.equal(await f.run(), output);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.job === f.job));
  assert.notEqual(f.calls[0].options.requestId, f.calls[1].options.requestId);
  assert.deepEqual(f.bindings, [OLD, undefined, NEW]);
  assert.equal(f.chat.contexts[mode].webThreadId, NEW);
  assert.equal(f.chat.contexts[mode === 'chat' ? 'work' : 'chat'].webThreadId, OTHER);
  assert.ok(f.progress.some(phase => /自动重试本条消息/.test(phase)));
});

for (const beforeSubmission of [false, undefined]) test('an unproven or submitted failure never retries: ' + beforeSubmission, async t => {
  const f = setup(t, { run: () => { throw gone(beforeSubmission); } });
  await assert.rejects(f.run(), err => err.code === 'thread_gone');
  assert.equal(f.calls.length, 1);
  assert.equal(f.chat.contexts.chat.webThreadId, undefined);
});

test('recovery stops after one attempt even if the replacement thread also disappears', async t => {
  const f = setup(t, { run: ({ options, calls }) => {
    if (calls.length === 2) options.onThread(NEW);
    throw gone(true);
  } });
  await assert.rejects(f.run(), err => err.code === 'thread_gone');
  assert.equal(f.calls.length, 2);
  assert.equal(f.chat.contexts.chat.webThreadId, undefined);
});

test('a task without an existing webpage binding cannot enter a recovery loop', async t => {
  const f = setup(t, { run: () => { throw gone(true); } });
  f.chats.unbindWeb(f.chat);
  await assert.rejects(f.run(), err => err.code === 'thread_gone');
  assert.equal(f.calls.length, 1);
});

for (const code of ['thread_mismatch', 'network', 'authentication', 'rate_limit'])
test(code + ' preserves the thread and never triggers a new conversation', async t => {
  const f = setup(t, { run: () => { throw Object.assign(Error('失败'), { code, beforeSubmission: true }); } });
  await assert.rejects(f.run(), err => err.code === code);
  assert.equal(f.calls.length, 1);
  assert.equal(f.chat.contexts.chat.webThreadId, OLD);
});

test('cancellation during a missing-thread failure prevents recovery', async t => {
  const f = setup(t, { run: ({ controller }) => { controller.abort(); throw gone(true); } });
  await assert.rejects(f.run(), err => err.code === 'thread_gone');
  assert.equal(f.calls.length, 1);
});

test('a failed unbind cannot start a replacement thread', async t => {
  const f = setup(t, { run: () => { throw gone(true); } });
  t.mock.method(f.chats, 'unbindWeb', () => { throw Error('保存失败'); });
  await assert.rejects(f.run(), /保存失败/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.chat.contexts.chat.webThreadId, OLD);
});

for (const elapsed of [16000, 280000]) test('recovery shares the original reply deadline: ' + elapsed, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = setup(t, { run: ({ calls }) => {
    if (calls.length === 1) { now += elapsed; throw gone(true); }
    return [{ type: 'text', text: '完成' }];
  } });
  if (elapsed >= 270000) {
    await assert.rejects(f.run(), err => err.code === 'reply_expired');
    assert.equal(f.calls.length, 1);
  } else {
    await f.run();
    assert.equal(f.calls[0].options.timeoutMs, 270000);
    assert.equal(f.calls[1].options.timeoutMs, 270000 - elapsed);
  }
});

test('recovery also respects a configured timeout shorter than the QQ reply window', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = setup(t, { replyTimeoutMs: 20000, run: ({ calls }) => {
    if (calls.length === 1) { now += 16000; throw gone(true); }
    return [{ type: 'text', text: '完成' }];
  } });
  await f.run();
  assert.equal(f.calls[0].options.timeoutMs, 20000);
  assert.equal(f.calls[1].options.timeoutMs, 4000);
});
