const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Conversations } = require('../../src/core/conversations.cjs');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-conversations-'));
test('conversation selection persists; foreign users/chats cannot select, rename or close', () => {
  const file = path.join(temp(), 'sessions.json'), c = new Conversations(file);
  const a = c.create('alice', 'qq:a', '猫咪');
  c.bindWeb(a, '11111111-2222-3333-4444-555555555555');
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
  recovered.leave('alice', 'qq:a'); assert.equal(recovered.current('alice', 'qq:a'), undefined);
  recovered.select(a.id, 'alice', 'qq:a'); recovered.close(a.id, 'alice', 'qq:a');
  assert.equal(recovered.current('alice', 'qq:a'), undefined);
  assert.throws(() => recovered.select(a.id, 'alice', 'qq:a'));
  assert.equal(recovered.list('alice', 'qq:a').length, 1);
});
test('a ChatGPT session id is validated and cannot silently change under a conversation', () => {
  const c = new Conversations(path.join(temp(), 'sessions.json'));
  const s = c.create('alice', 'qq:a', '猫咪');
  assert.throws(() => c.bindWeb(s, 'not-a-thread'));
  c.bindWeb(s, '11111111-2222-3333-4444-555555555555');
  assert.equal(s.webThreadId, '11111111-2222-3333-4444-555555555555');
  assert.doesNotThrow(() => c.bindWeb(s, '11111111-2222-3333-4444-555555555555'));
  assert.throws(() => c.bindWeb(s, '99999999-2222-3333-4444-555555555555'), /发生变化/);
});
