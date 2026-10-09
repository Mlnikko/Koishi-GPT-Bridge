const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Conversations } = require('../../src/core/conversations.cjs');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-conversations-'));
const THREAD = '11111111-2222-3333-4444-555555555555';
test('reopening commits closure and replacement together, including at the session limit', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  for (let i = 0; i < 20; i++) c.create('alice', 'qq:a', 'topic');
  const previous = c.current('alice', 'qq:a');
  const save = c.save.bind(c);
  c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.reopen('alice', 'qq:a', 'new'), /disk full/);
  assert.equal(c.current('alice', 'qq:a'), previous);
  assert.equal(c.list('alice', 'qq:a').length, 20);
  c.save = save;
  const next = c.reopen('alice', 'qq:a', 'new');
  assert.equal(previous.closed, true);
  assert.equal(c.list('alice', 'qq:a').length, 20);
  assert.equal(new Conversations(c.file).current('alice', 'qq:a').id, next.id);
});
test('failed state publication leaves selection, names, closure and thread binding unchanged', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  const a = c.create('alice', 'qq:a', 'original');
  const b = c.create('alice', 'qq:a', 'selected');
  const save = c.save.bind(c);
  c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.create('alice', 'qq:a', 'failed'), /disk full/);
  assert.equal(c.list('alice', 'qq:a').length, 2);
  assert.equal(c.current('alice', 'qq:a').id, b.id);
  assert.throws(() => c.select(a.id, 'alice', 'qq:a'), /disk full/);
  assert.equal(c.current('alice', 'qq:a').id, b.id);
  assert.throws(() => c.rename(a.id, 'alice', 'qq:a', 'failed'), /disk full/);
  assert.equal(a.name, 'original');
  assert.throws(() => c.close(b.id, 'alice', 'qq:a'), /disk full/);
  assert.equal(c.current('alice', 'qq:a').id, b.id);
  assert.throws(() => c.bindWeb(a, THREAD), /disk full/);
  assert.equal(a.webThreadId, undefined);
  c.save = save;
  c.bindWeb(a, THREAD);
  c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.unbindWeb(a), /disk full/);
  assert.equal(a.webThreadId, THREAD);
  const recovered = new Conversations(c.file);
  assert.equal(recovered.current('alice', 'qq:a').id, b.id);
});
test('conversation selection persists; foreign users/chats cannot select, rename or close', () => {
  const file = path.join(temp(), 'sessions.json'), c = new Conversations(file);
  const a = c.create('alice', 'qq:a', '猫咪');
  c.bindWeb(a, THREAD);
  const b = c.create('alice', 'qq:a', '花园');
  assert.equal(c.current('alice', 'qq:a').id, b.id);
  c.select(a.id, 'alice', 'qq:a');
  for (const [owner, chat] of [['bob', 'qq:a'], ['alice', 'qq:b']]) {
    assert.deepEqual(c.list(owner, chat), []);
    assert.throws(() => c.select(a.id, owner, chat));
    assert.throws(() => c.rename(a.id, owner, chat, 'bad'));
    assert.throws(() => c.close(a.id, owner, chat));
  }
  const recovered = new Conversations(file);
  assert.equal(recovered.current('alice', 'qq:a').webThreadId, a.webThreadId);
  recovered.rename(a.id, 'alice', 'qq:a', '橘猫');
  recovered.close(a.id, 'alice', 'qq:a');
  assert.equal(recovered.current('alice', 'qq:a'), undefined);
  assert.throws(() => recovered.select(a.id, 'alice', 'qq:a'));
  assert.equal(recovered.list('alice', 'qq:a').length, 1);
});
test('every (user, chat) keeps one persistent conversation, created on first use', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  assert.equal(c.current('alice', 'qq:a'), undefined);
  const first = c.ensure('alice', 'qq:a');
  assert.equal(first.name, '默认会话');
  // 同一个用户继续发消息：还是同一个会话，不会每条消息新建一个。
  assert.equal(c.ensure('alice', 'qq:a').id, first.id);
  assert.equal(c.list('alice', 'qq:a').length, 1);
  // 另一个用户、另一个聊天各自独立，互不共用网页会话。
  assert.notEqual(c.ensure('bob', 'qq:a').id, first.id);
  assert.notEqual(c.ensure('alice', 'qq:b').id, first.id);
  // 手动切到别的会话后，ensure 必须尊重这个选择，而不是抢回默认会话。
  const named = c.create('alice', 'qq:a', '猫咪');
  assert.equal(c.ensure('alice', 'qq:a').id, named.id);
  // 当前会话被关掉之后，下一条消息重新建一个，而不是永远停在「没有会话」。
  c.close(named.id, 'alice', 'qq:a');
  const again = c.ensure('alice', 'qq:a');
  assert.notEqual(again.id, named.id);
  assert.equal(c.ensure('alice', 'qq:a').id, again.id);
});
test('a ChatGPT session id is validated and cannot silently change under a conversation', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  const s = c.create('alice', 'qq:a', '猫咪');
  assert.throws(() => c.bindWeb(s, 'not-a-thread'));
  c.bindWeb(s, THREAD);
  assert.equal(s.webThreadId, THREAD);
  assert.doesNotThrow(() => c.bindWeb(s, THREAD));
  assert.throws(() => c.bindWeb(s, '99999999-2222-3333-4444-555555555555'), /发生变化/);
});
test('an unusable ChatGPT session is unbound so the next message can start a new one', () => {
  const file = path.join(temp(), 'sessions.json'), c = new Conversations(file);
  const s = c.ensure('alice', 'qq:a');
  assert.doesNotThrow(() => c.unbindWeb(s), '没有绑定过时解绑不该报错');
  c.bindWeb(s, THREAD);
  c.unbindWeb(s);
  assert.equal(s.webThreadId, undefined);
  assert.equal(new Conversations(file).current('alice', 'qq:a').webThreadId, undefined);
  // 解绑之后可以绑定一个全新的会话编号，否则用户会被永久卡在失效编号上。
  assert.doesNotThrow(() => c.bindWeb(s, '99999999-2222-3333-4444-555555555555'));
});
test('reasoning settings persist per owned conversation and failed writes do not publish changes', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  const first = c.create('alice', 'qq:a', 'first');
  c.setReasoning(first.id, 'alice', 'qq:a', '超高');
  c.create('alice', 'qq:a', 'second');
  assert.equal(c.current('alice', 'qq:a').reasoningEffort, undefined);
  c.select(first.id, 'alice', 'qq:a');
  assert.equal(new Conversations(c.file).current('alice', 'qq:a').reasoningEffort, 'xhigh');
  for (const [owner, chat] of [['bob', 'qq:a'], ['alice', 'qq:b']])
    assert.throws(() => c.setReasoning(first.id, owner, chat, 'high'), /未找到/);
  assert.throws(() => c.setReasoning(first.id, 'alice', 'qq:a', 'unknown'), /用法/);
  const save = c.save.bind(c);
  c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.setReasoning(first.id, 'alice', 'qq:a', 'medium'), /disk full/);
  assert.equal(first.reasoningEffort, 'xhigh');
  c.save = save;
  c.setReasoning(first.id, 'alice', 'qq:a', 'default');
  assert.equal(new Conversations(c.file).current('alice', 'qq:a').reasoningEffort, undefined);
});
