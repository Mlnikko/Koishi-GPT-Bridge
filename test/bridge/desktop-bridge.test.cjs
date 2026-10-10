const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopBridge } = require('../../src/bridge/desktop-bridge.cjs');
const { request } = require('../../scripts/desktop-transport.cjs');
const THREAD = '11111111-2222-3333-4444-555555555555';
const USER = 'aaaaaaaa-2222-3333-4444-555555555555';
const AGENT = 'bbbbbbbb-2222-3333-4444-555555555555';
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-test-'));
  const bridge = new DesktopBridge({ root, port: 0, threadId: THREAD });
  t.after(() => { bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await bridge.ready;
  const api = (endpoint, body) => request({ root, endpoint, body });
  const job = { id: '123456abcdef', dir: path.join(root, 'job'), input: [{ type: 'text', text: 'hello' }] };
  fs.mkdirSync(job.dir);
  return { root, bridge, api, job };
}
test('desktop health does not advertise an executor; authentication is mandatory', async t => {
  const { bridge, api } = await setup(t);
  assert.equal((await api('/health')).online, false);
  assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/state`)).status, 401);
  await api('/state'); assert.equal(bridge.health().online, true);
});
test('desktop dispatch is claimed once, replies require matching evidence, receipt precedes completion', async t => {
  const { api, bridge, job } = await setup(t);
  await api('/state'); const running = bridge.run(job); await new Promise(resolve => setImmediate(resolve));
  const base = { id: job.id, threadId: THREAD };
  await assert.rejects(api('/result', { ...base, text: 'old', userMessageId: USER, assistantMessageIds: [AGENT] }), /凭据/);
  await api('/checkpoint', { ...base, expectedPhase: null, checkpoint: { phase: 'prepared', baseline: [] } });
  await api('/checkpoint', { ...base, expectedPhase: 'prepared', checkpoint: { phase: 'dispatching', baseline: [] } });
  await assert.rejects(api('/checkpoint', { ...base, expectedPhase: 'prepared', checkpoint: { phase: 'dispatching', baseline: [] } }), /冲突/);
  await api('/checkpoint', { ...base, expectedPhase: 'dispatching', checkpoint: { phase: 'submitted', baseline: [], userMessageId: USER } });
  await assert.rejects(api('/result', { ...base, threadId: AGENT, text: 'wrong', userMessageId: USER, assistantMessageIds: [AGENT] }), /聊天不匹配/);
  const result = { ...base, text: 'hello back', userMessageId: USER, assistantMessageIds: [AGENT] };
  await api('/result', result);
  assert.deepEqual(await running, [{ type: 'text', text: 'hello back' }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir, 'result.json'))).segments[0].text, 'hello back');
  assert.deepEqual(await api('/result', result), { ok: true });
  await assert.rejects(api('/result', { ...result, text: 'changed retry' }), /不匹配/);
});
test('cancellation refuses a late result and never claims native generation stopped', async t => {
  const { api, bridge, job } = await setup(t); await api('/state');
  const controller = new AbortController(); const running = bridge.run(job, { signal: controller.signal });
  const rejected = assert.rejects(running, /可能已经提交/);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
  await assert.rejects(api('/result', { id: job.id, threadId: THREAD, text: 'late', userMessageId: USER, assistantMessageIds: [AGENT] }), /不匹配/);
});
