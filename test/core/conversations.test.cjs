const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Conversations } = require('../../src/core/conversations.cjs');

test('skills are owned per conversation, inherited explicitly and published only after persistence succeeds', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  const s = c.ensure('alice', 'qq:a');
  c.setSkill(s.id, 'alice', 'qq:a', 'summarize-text');
  assert.equal(c.ensure('bob', 'qq:a').contexts.work.skill, undefined);
  assert.equal(c.ensure('alice', 'qq:b').contexts.work.skill, undefined);
  assert.throws(() => c.setSkill(s.id, 'bob', 'qq:a', 'other'), /未找到/);
  assert.throws(() => c.setSkill(s.id, 'alice', 'qq:b', 'other'), /未找到/);
  assert.equal(new Conversations(c.file).get(s.id, 'alice', 'qq:a').contexts.work.skill, 'summarize-text');
  const next = c.create('alice', 'qq:a', 'new', { skill: s.contexts.work.skill });
  assert.equal(next.contexts.work.skill, 'summarize-text');
  const save = c.save.bind(c); c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.setSkill(s.id, 'alice', 'qq:a', undefined), /disk full/);
  assert.equal(s.contexts.work.skill, 'summarize-text'); c.save = save;
  c.setSkill(s.id, 'alice', 'qq:a', undefined);
  assert.equal(s.contexts.work.skill, undefined); assert.equal(next.contexts.work.skill, 'summarize-text');
});
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
  assert.equal(a.contexts.chat.webThreadId, undefined);
  c.save = save;
  c.bindWeb(a, THREAD);
  c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.unbindWeb(a), /disk full/);
  assert.equal(a.contexts.chat.webThreadId, THREAD);
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
  assert.equal(recovered.current('alice', 'qq:a').contexts.chat.webThreadId, a.contexts.chat.webThreadId);
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
  assert.equal(s.contexts.chat.webThreadId, THREAD);
  assert.doesNotThrow(() => c.bindWeb(s, THREAD));
  assert.throws(() => c.bindWeb(s, '99999999-2222-3333-4444-555555555555'), /发生变化/);
});
test('an unusable ChatGPT session is unbound so the next message can start a new one', () => {
  const file = path.join(temp(), 'sessions.json'), c = new Conversations(file);
  const s = c.ensure('alice', 'qq:a');
  assert.doesNotThrow(() => c.unbindWeb(s), '没有绑定过时解绑不该报错');
  c.bindWeb(s, THREAD);
  c.unbindWeb(s);
  assert.equal(s.contexts.chat.webThreadId, undefined);
  assert.equal(new Conversations(file).current('alice', 'qq:a').contexts.chat.webThreadId, undefined);
  // 解绑之后可以绑定一个全新的会话编号，否则用户会被永久卡在失效编号上。
  assert.doesNotThrow(() => c.bindWeb(s, '99999999-2222-3333-4444-555555555555'));
});
test('reasoning settings persist per owned conversation and failed writes do not publish changes', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  const first = c.create('alice', 'qq:a', 'first');
  c.setReasoning(first.id, 'alice', 'qq:a', '超高');
  c.create('alice', 'qq:a', 'second');
  assert.equal(c.current('alice', 'qq:a').contexts.chat.reasoningEffort, undefined);
  c.select(first.id, 'alice', 'qq:a');
  assert.equal(new Conversations(c.file).current('alice', 'qq:a').contexts.chat.reasoningEffort, 'xhigh');
  for (const [owner, chat] of [['bob', 'qq:a'], ['alice', 'qq:b']])
    assert.throws(() => c.setReasoning(first.id, owner, chat, 'high'), /未找到/);
  assert.throws(() => c.setReasoning(first.id, 'alice', 'qq:a', 'unknown'), /用法/);
  const save = c.save.bind(c);
  c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.setReasoning(first.id, 'alice', 'qq:a', 'medium'), /disk full/);
  assert.equal(first.contexts.chat.reasoningEffort, 'xhigh');
  c.save = save;
  c.setReasoning(first.id, 'alice', 'qq:a', 'default');
  assert.equal(new Conversations(c.file).current('alice', 'qq:a').contexts.chat.reasoningEffort, undefined);
});

test('preset selection is owned, independent, inherited explicitly and persisted atomically', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  const first = c.create('alice', 'qq:a', 'first');
  c.setPreset(first.id, 'alice', 'qq:a', '角色 A');
  const next = c.create('alice', 'qq:a', 'next', { preset: first.contexts.local.preset });
  c.setPreset(next.id, 'alice', 'qq:a', '角色 B');
  assert.equal(first.contexts.local.preset, '角色 A');
  assert.equal(new Conversations(c.file).current('alice', 'qq:a').contexts.local.preset, '角色 B');
  assert.equal(c.create('bob', 'qq:a', 'other').contexts.local.preset, undefined);
  for (const [owner, chat] of [['bob', 'qq:a'], ['alice', 'qq:b']])
    assert.throws(() => c.setPreset(first.id, owner, chat, '角色 B'), /未找到/);
  assert.throws(() => c.setPreset(first.id, 'alice', 'qq:a', '../secret'), /预设名称/);
  const save = c.save.bind(c);
  c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.setPreset(first.id, 'alice', 'qq:a', undefined), /disk full/);
  assert.equal(first.contexts.local.preset, '角色 A');
  c.save = save; c.setPreset(first.id, 'alice', 'qq:a', undefined);
  assert.equal(new Conversations(c.file).get(first.id, 'alice', 'qq:a').contexts.local.preset, undefined);
  assert.equal(next.contexts.local.preset, '角色 B');
});

test('legacy conversations migrate lazily with exact backup and keep the original local history identity', () => {
  const file = path.join(temp(), 'sessions.json');
  const legacy = { items: [
    { id: 'legacy-a', owner: 'alice', chat: 'qq:a', name: 'old work', createdAt: 1,
      skill: 'summarize-text', webThreadId: THREAD, reasoningEffort: 'high', imagePrompt: '角色海报' },
    { id: 'legacy-b', owner: 'bob', chat: 'qq:b', name: 'old local', createdAt: 2,
      backend: 'lmstudio', lmStudioModel: 'local-model', lmStudioPreset: '角色 A', skill: 'summarize-text', webThreadId: THREAD },
  ], current: { '["alice","qq:a"]': 'legacy-a', '["bob","qq:b"]': 'legacy-b' } };
  const original = JSON.stringify(legacy); fs.writeFileSync(file, original);
  const c = new Conversations(file), a = c.current('alice', 'qq:a'), b = c.current('bob', 'qq:b');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(c.backupFile), false, 'a read must not write or migrate on disk');
  assert.equal(a.mode, 'work'); assert.equal(b.mode, 'local');
  assert.equal(a.contexts.work.webThreadId, THREAD); assert.equal(a.contexts.chat.webThreadId, undefined);
  assert.deepEqual(b.contexts.local, { model: 'local-model', preset: '角色 A', skill: 'summarize-text' });
  assert.equal(b.id, 'legacy-b'); assert.equal(a.contexts.chat.reasoningEffort, 'high');
  c.setMode(a, 'chat');
  assert.equal(fs.readFileSync(c.backupFile, 'utf8'), original);
  const saved = JSON.parse(fs.readFileSync(file)); assert.equal(saved.version, 2);
  assert.equal(saved.items[0].webThreadId, undefined); assert.equal(saved.items[0].skill, undefined);
  const restored = new Conversations(file);
  assert.equal(restored.current('alice', 'qq:a').contexts.work.webThreadId, THREAD);
  assert.equal(restored.current('bob', 'qq:b').id, 'legacy-b');
});

test('mode switches preserve independent settings and threads; new conversations inherit settings with empty histories', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json')), s = c.ensure('alice', 'qq:a');
  c.setReasoning(s.id, s.owner, s.chat, 'high'); c.bindWeb(s, THREAD);
  c.setMode(s, 'work'); c.setReasoning(s.id, s.owner, s.chat, 'medium');
  const workThread = '99999999-2222-3333-4444-555555555555';
  assert.throws(() => c.bindWeb(s, THREAD), /不能绑定同一个/);
  c.bindWeb(s, workThread); c.setSkill(s.id, s.owner, s.chat, 'summarize-text');
  c.setMode(s, 'local', 'model-a'); c.setPreset(s.id, s.owner, s.chat, '角色 A');
  c.setSkill(s.id, s.owner, s.chat, 'local-rules'); c.setMode(s, 'chat');
  assert.equal(s.contexts.chat.webThreadId, THREAD); assert.equal(s.contexts.chat.reasoningEffort, 'high');
  assert.equal(s.contexts.chat.skill, undefined);
  assert.deepEqual(s.contexts.work, { webThreadId: workThread, reasoningEffort: 'medium', skill: 'summarize-text' });
  assert.deepEqual(s.contexts.local, { model: 'model-a', preset: '角色 A', skill: 'local-rules' });
  const next = c.create('alice', 'qq:a', 'new', { from: s });
  assert.equal(next.mode, 'chat'); assert.equal(next.contexts.chat.webThreadId, undefined);
  assert.equal(next.contexts.work.webThreadId, undefined);
  assert.equal(next.contexts.work.skill, 'summarize-text'); assert.deepEqual(next.contexts.local, s.contexts.local);
  assert.notEqual(next.id, s.id); assert.notEqual(next.contexts.local, s.contexts.local);
  c.unbindWeb(s, 'work'); assert.equal(s.contexts.chat.webThreadId, THREAD);
  assert.equal(new Conversations(c.file).get(s.id, s.owner, s.chat).contexts.work.webThreadId, undefined);
});

test('failed mode persistence and malformed or future data cannot replace an existing state', () => {
  const file = path.join(temp(), 'sessions.json'), c = new Conversations(file), s = c.ensure('alice', 'qq:a');
  const original = fs.readFileSync(file, 'utf8'); c.save = () => { throw Error('disk full'); };
  assert.throws(() => c.setMode(s, 'local', 'model-a'), /disk full/);
  assert.equal(s.mode, 'chat'); assert.equal(s.contexts.local.model, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  for (const bad of [ { version: 3, items: [], current: {} }, { items: [], current: [] },
    { items: [{ mode: 'unknown' }], current: {} }, { items: [{ contexts: [] }], current: {} } ]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => new Conversations(file), /更新版本|格式无效|未知/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), bad);
  }
});
