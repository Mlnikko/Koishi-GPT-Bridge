const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../../src/core/config.cjs');

test('configuration normalizes defaults and deduplicates user IDs', () => {
  const config = normalizeConfig({ allowedUsers: [' alice ', 'alice'], webBridgePort: '5142' }, '/tmp/bridge');
  assert.deepEqual(config.allowedUsers, ['alice']);
  assert.equal(config.webBridgePort, 5142);
  assert.equal(config.retentionDays, 0);
  assert.equal(config.replyTimeoutMs, 300000);
  assert.equal(config.sendTimeoutMs, 20000);
  assert.equal(config.mediaSendTimeoutMs, 60000);
});

test('media confirmation has a separate configurable budget and follows a longer text budget by default',()=>{
 assert.equal(normalizeConfig({allowedUsers:['*'],sendTimeoutMs:90000},'/tmp/bridge').mediaSendTimeoutMs,90000);
 assert.equal(normalizeConfig({allowedUsers:['*'],mediaSendTimeoutMs:100},'/tmp/bridge').mediaSendTimeoutMs,100);
});

test('malformed access, timing, port and retention settings fail immediately', () => {
  for (const bad of [{ allowedUsers: '*' }, { allowedUsers: [1] }, { allowedUsers: [''] },
    { groupChat: 'false' }, { notifyProgress: 'false' }, { dataDir: {} }, { dataDir: '' },
    { skillsDir: {} }, { skillsDir: '' }, { skillsDir: 'bad\x00path' },
    { webBridgePort: -1 }, { webBridgePort: 65536 }, { webBridgePort: 1.5 },
    { sendTimeoutMs: 2147483648 }, { mediaSendTimeoutMs: 0 }, { mediaSendTimeoutMs: NaN },
    { mediaSendTimeoutMs: 2147483648 }, { replyTimeoutMs: Infinity }, { retentionDays: -1 },
    { retentionDays: 'invalid' }, { maxInputImages: 11 }]) {
    assert.throws(() => normalizeConfig({ allowedUsers: ['*'], ...bad }, '/tmp/bridge'));
  }
});

test('LM Studio settings validate local endpoints, credentials and context limits', () => {
  const defaults = normalizeConfig({ allowedUsers: ['*'] }, '/tmp/bridge');
  assert.equal(defaults.lmStudioBaseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(defaults.lmStudioMaxTokens, 2048);
  assert.equal(defaults.lmStudioHistoryImages, 4);
  assert.equal(defaults.lmStudioHistoryImageBytes, 20 * 1024 * 1024);
  const large = normalizeConfig({ allowedUsers: ['*'], maxInputImages: 6 }, '/tmp/bridge');
  assert.equal(large.lmStudioHistoryImages, 6);
  assert.equal(large.lmStudioHistoryImageBytes, 60 * 1024 * 1024);
  assert.equal(normalizeConfig({ allowedUsers: ['*'], lmStudioBaseUrl: 'http://localhost:5678/v1/' }, '/tmp/bridge').lmStudioBaseUrl, 'http://localhost:5678/v1');
  for (const bad of [{ lmStudioBaseUrl: 'http://example.com/v1' }, { lmStudioBaseUrl: 'http://127.0.0.1:1234' },
    { lmStudioBaseUrl: 'http://user:secret@localhost:1234/v1' }, { lmStudioBaseUrl: 'http://localhost:1234/v1?key=secret' },
    { lmStudioApiKey: 'secret\nheader' }, { lmStudioModel: {} }, { lmStudioMaxTokens: 0 },
    { lmStudioHistoryTurns: 101 }, { lmStudioHistoryChars: -1 }, { lmStudioHistoryImages: 1 },
    { lmStudioHistoryImages: 101 }, { lmStudioHistoryImageBytes: 1 }])
    assert.throws(() => normalizeConfig({ allowedUsers: ['*'], ...bad }, '/tmp/bridge'));
});
