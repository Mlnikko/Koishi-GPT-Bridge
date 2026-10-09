const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../../src/core/config.cjs');

test('configuration normalizes defaults and deduplicates user IDs', () => {
  const config = normalizeConfig({ allowedUsers: [' alice ', 'alice'], webBridgePort: '5142' }, '/tmp/bridge');
  assert.deepEqual(config.allowedUsers, ['alice']);
  assert.equal(config.webBridgePort, 5142);
  assert.equal(config.retentionDays, 0);
  assert.equal(config.replyTimeoutMs, 300000);
});

test('malformed access, timing, port and retention settings fail immediately', () => {
  for (const bad of [{ allowedUsers: '*' }, { allowedUsers: [1] }, { allowedUsers: [''] },
    { groupChat: 'false' }, { notifyProgress: 'false' }, { dataDir: {} }, { dataDir: '' },
    { webBridgePort: -1 }, { webBridgePort: 65536 }, { webBridgePort: 1.5 },
    { sendTimeoutMs: 2147483648 }, { replyTimeoutMs: Infinity }, { retentionDays: -1 },
    { retentionDays: 'invalid' }, { maxInputImages: 11 }]) {
    assert.throws(() => normalizeConfig({ allowedUsers: ['*'], ...bad }, '/tmp/bridge'));
  }
});
