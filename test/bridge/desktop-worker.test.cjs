const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workOne, findReply } = require('../../scripts/desktop-worker.cjs');
const THREAD = '11111111-2222-3333-4444-555555555555';
const previous = 'aaaaaaaa-2222-3333-4444-555555555555';
const current = 'bbbbbbbb-2222-3333-4444-555555555555';
const assistant = 'cccccccc-2222-3333-4444-555555555555';
const job = { id: 'abc123', threadId: THREAD, text: '记住口令 TEST' };
const snapshot = (active = false) => ({ thread: { id: THREAD, kind: 'chatgpt', status: { type: active ? 'active' : 'idle' } }, turns: [
  { id: current, status: 'completed', items: [{ type: 'userMessage', id: current, content: [{ type: 'text', text: job.text }] }, { type: 'agentMessage', id: assistant, text: '已记住' }] },
  { id: previous, status: 'completed', items: [] },
] });
function fixture(checkpoint = null) {
  const calls = []; let submitted = !!checkpoint; let now = 0;
  return { calls, options: {
    api: async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === '/state') return { job: { ...job, checkpoint } };
      if (endpoint === '/checkpoint') checkpoint = body.checkpoint;
      return { ok: true };
    },
    readThread: async () => submitted ? snapshot() : { thread: snapshot().thread, turns: [snapshot().turns[1]] },
    sendMessage: async value => { calls.push({ send: value }); submitted = true; return { content: [{ type: 'text', text: JSON.stringify({ threadId: THREAD }) }] }; },
    sleep: async ms => { now += ms; }, now: () => now,
  } };
}
test('desktop worker persists dispatch before one send and returns only this turn', async () => {
  const f = fixture(); const result = await workOne(f.options);
  assert.equal(result.text, '已记住'); assert.equal(result.userMessageId, current);
  const send = f.calls.findIndex(c => c.send);
  assert.equal(f.calls[send - 1].body.checkpoint.phase, 'dispatching');
  assert.equal(f.calls.filter(c => c.send).length, 1);
  assert.deepEqual(f.calls.at(-1).body.assistantMessageIds, [assistant]);
});
test('worker resumes an uncertain dispatch by reading without sending again', async () => {
  const f = fixture({ phase: 'dispatching', baseline: [previous] });
  assert.equal((await workOne(f.options)).text, '已记住');
  assert.equal(f.calls.some(c => c.send), false);
});
test('another user turn, wrong chat, or truncated response is never returned', () => {
  const checkpoint = { phase: 'dispatching', baseline: [previous] };
  for (const mutate of [s => { s.thread.id = previous; }, s => { s.turns[0].items[0].content[0].text = 'manual'; },
    s => { s.turns.unshift({ id: assistant }); }, s => { s.turns[0].items[1].truncated = true; }]) {
    const s = snapshot(); mutate(s); assert.throws(() => findReply(s, job, checkpoint));
  }
  assert.equal(findReply(snapshot(true), job, checkpoint).complete, false);
});
test('an unknown dispatch failure never triggers a second send', async () => {
  const f = fixture(); let sends = 0;
  f.options.sendMessage = async () => { sends++; throw Error('ack lost'); };
  await assert.rejects(workOne(f.options), /ack lost/);
  assert.equal(sends, 1); assert.equal(f.calls.at(-1).endpoint, '/failure');
});
