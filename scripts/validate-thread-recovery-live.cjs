'use strict';
// Real Chrome/ChatGPT acceptance with isolated local state. QQ acknowledgements
// are simulated; no message is sent to a real QQ contact or group.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const plugin = require('../src/index.cjs');
const { Conversations } = require('../src/core/conversations.cjs');
const { inspect } = require('./doctor.cjs');
const { visionPng } = require('./vision-fixture.cjs');
const { safeReason } = require('../src/lib/feedback.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function validate({ port = 5141, productionData = path.resolve(__dirname, '..', 'data'), workOnly = false } = {}) {
  // Refuse a busy endpoint rather than stopping or replacing a running service.
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  const acceptance = path.join(productionData, 'acceptance');
  fs.mkdirSync(acceptance, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(acceptance, 'thread-recovery-'));
  fs.copyFileSync(path.join(productionData, 'web-bridge-token'), path.join(root, 'web-bridge-token'));
  fs.chmodSync(path.join(root, 'web-bridge-token'), 0o600);
  const token = fs.readFileSync(path.join(root, 'web-bridge-token'), 'utf8').trim();
  const owner = 'thread-recovery-live', marker = 'RECOVERY-' + randomUUID().slice(0, 8);
  const missing = { chat: randomUUID(), work: randomUUID() };
  const chats = new Conversations(path.join(root, 'conversations.json'));
  const chat = chats.create(owner, 'qq:' + owner, '网页会话失效实际验收');
  for (const mode of ['chat', 'work']) {
    chats.bindWeb(chat, missing[mode], mode);
    chats.setMode(chat, mode);
    chats.setReasoning(chat.id, owner, chat.chat, 'instant');
  }
  chats.setMode(chat, 'chat');
  const stages = [], disposes = [];
  const report = path.join(root, 'validation.json');
  const evidence = { startedAt: new Date().toISOString(), root, backend: 'real-chatgpt-web',
    qqTransport: 'simulated', workOnly, reasoningSettings: { chat: 'instant', work: 'instant', workFollowUp: 'tier-4' },
    missingThreads: missing, sessionId: chat.id, marker, turns: [], passed: false };
  const save = () => fs.writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const state = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/state`, { headers: { 'x-bridge-token': token,
      'x-bridge-capabilities': 'reasoning,native-skills,web-modes' }, signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200); return res.json();
  };
  const session = (text, image) => ({ platform: 'qq', userId: owner, channelId: owner, isDirect: true,
    messageId: randomUUID(), timestamp: Date.now(), sent: [], stripped: { content: text },
    elements: [{ type: 'text', attrs: { content: text } },
      ...(image ? [{ type: 'img', attrs: { src: 'data:image/png;base64,' + image.toString('base64') } }] : [])],
    send: async function (content) { this.sent.push(content); return ['simulated-' + this.sent.length]; } });
  const dispatch = async s => {
    const run = async index => {
      if (index >= stages.length) return;
      const stage = stages[index]; if (!stage.filter(s)) return run(index + 1);
      return stage.fn(s, async fallback => {
        const result = await run(index + 1);
        return result === undefined && typeof fallback === 'function' ? fallback() : result;
      });
    };
    return run(0);
  };
  const turn = async ({ name, mode, prompt, image, recover, expectedThread, reasoning = 'instant' }) => {
    const s = session(prompt, image), started = Date.now();
    const row = { name, mode, prompt, expectsRecovery: recover, startedAt: new Date().toISOString(),
      requestIds: [], progress: [], statuses: [], passed: false };
    evidence.turns.push(row); save();
    assert.equal(await dispatch(s), undefined);
    console.log('已向真实网页提交：' + name);
    for (;;) {
      const jobs = fs.readdirSync(path.join(root, 'jobs')).map(id => JSON.parse(fs.readFileSync(path.join(root, 'jobs', id, 'job.json'))));
      const job = jobs.find(item => item.messageId === s.messageId);
      if (job) {
        row.jobId = job.id;
        const active = (await state()).job;
        if (active && !row.requestIds.includes(active.id)) {
          row.requestIds.push(active.id); console.log(name + ' 网页请求：' + active.id + '，会话：' + (active.threadId || '新建'));
        }
        if (!row.statuses.includes(job.status)) row.statuses.push(job.status);
        if (job.progress && row.progress.at(-1)?.phase !== job.progress) {
          row.progress.push({ phase: job.progress, elapsedMs: Date.now() - started });
          console.log(name + '：' + job.progress);
        }
        const failureFile = path.join(job.dir, 'failure.json');
        if (fs.existsSync(failureFile)) row.observedFailure = JSON.parse(fs.readFileSync(failureFile, 'utf8'));
        save();
        if (['failed', 'cancelled', 'interrupted'].includes(job.status)) throw Error(job.error || job.status);
        if (job.status === 'ready' && job.delivery === 'failed') throw Error(job.deliveryError);
        if (job.status === 'ready' && job.delivery === 'sent') {
          assert.equal(job.sessionId, chat.id); assert.equal(job.mode, mode);
          assert.equal(job.input[0].text, prompt); assert.equal(job.reasoningEffort, reasoning);
          assert.ok(job.threadId && job.threadId !== missing[mode]);
          const receipt = JSON.parse(fs.readFileSync(path.join(job.dir, 'result.json'), 'utf8'));
          const submission = JSON.parse(fs.readFileSync(path.join(job.dir, 'submission.json'), 'utf8'));
          assert.equal(receipt.id, job.id); assert.equal(receipt.threadId, job.threadId);
          assert.equal(submission.requestedMode, mode); assert.equal(submission.observedMode, mode);
          assert.equal(submission.reasoningApplied, reasoning); assert.equal(submission.textMatched, true);
          if (mode === 'work') {
            assert.equal(submission.reasoningSelection?.kind, 'work-tier');
            assert.equal(submission.reasoningSelection.tier, reasoning === 'instant' ? 1 : Number(reasoning.slice(5)));
            assert.ok(submission.reasoningSelection.total >= submission.reasoningSelection.tier);
            row.workSelection = submission.reasoningSelection;
          }
          assert.ok(submission.userText.includes(prompt));
          assert.equal(fs.existsSync(failureFile), false);
          if (recover) {
            assert.equal(row.observedFailure?.code, 'thread_gone');
            assert.deepEqual(row.requestIds, [job.id, job.id + '-recovery']);
          } else {
            assert.equal(job.threadId, expectedThread); assert.deepEqual(row.requestIds, [job.id]);
          }
          if (image) {
            assert.equal(job.input.filter(input => input.type === 'image').length, 1);
            const storedImage = fs.readFileSync(path.join(job.dir, job.input.find(input => input.type === 'image').file));
            assert.deepEqual(storedImage, image); row.inputImageSha256 = digest(storedImage);
          }
          row.threadId = job.threadId; row.reply = fs.readFileSync(path.join(job.dir, 'reply.md'), 'utf8');
          row.elapsedMs = Date.now() - started; row.delivery = job.delivery;
          row.qqAcknowledgements = s.sent.length; row.submission = submission;
          assert.ok(s.sent.length > 0); assert.ok(s.sent.every(message => !/任务.*失败/.test(message)));
          assert.ok(row.reply.includes(marker));
          if (image) { assert.match(row.reply, /红/); assert.match(row.reply, /蓝/); assert.match(row.reply, /方/); assert.match(row.reply, /圆/); }
          row.passed = true; save();
          console.log(JSON.stringify({ name, passed: true, jobId: job.id, threadId: job.threadId, reply: row.reply, elapsedMs: row.elapsedMs }));
          return row;
        }
      }
      if (Date.now() - started > 290000) throw Error('实际网页验收超时，未重新提交验收消息');
      await pause(500);
    }
  };
  try {
    plugin.apply({ intersect: filter => ({ middleware: fn => stages.push({ filter, fn }) }),
      setInterval: () => {}, on: (event, fn) => { if (event === 'dispose') disposes.push(fn); },
      logger: () => ({ info: () => {}, warn: () => {} }),
    }, { allowedUsers: [owner], dataDir: root, webBridgePort: port, notifyProgress: false });
    console.log('验收记录：' + report); save();
    const waiting = Date.now();
    for (;;) {
      let health;
      try { health = await inspect({ dataDir: root }); } catch {}
      if (health?.online) { evidence.connectedAt = new Date().toISOString(); break; }
      if (Date.now() - waiting > 75000) throw Error('真实 Chrome 扩展未连接到隔离验收桥接');
      await pause(1000);
    }
    console.log('真实 Chrome 扩展已连接');
    const first = workOnly ? null : await turn({ name: 'chat-recovery', mode: 'chat', recover: true,
      prompt: '这是网页会话失效自动恢复验收。请记住标记 ' + marker + '，只回复这个标记。' });
    if (first) await turn({ name: 'chat-follow-up', mode: 'chat', expectedThread: first.threadId,
      prompt: '上一条消息让你记住的验收标记是什么？只回复标记。' });
    assert.match(await dispatch(session('/mode 工作')), /已切换到工作/);
    const work = await turn({ name: 'work-image-recovery', mode: 'work', recover: true, image: visionPng(),
      prompt: '这是网页会话恢复后的看图验收。描述参考图左侧和右侧的颜色、形状，用一行中文回答；记住并在末尾附上标记 ' + marker + '。' });
    assert.match(await dispatch(session('/reasoning 4')), /第 4 档/);
    await turn({ name: 'work-follow-up', mode: 'work', expectedThread: work.threadId, reasoning: 'tier-4',
      prompt: '上一条消息让你记住的验收标记是什么？只回复标记。' });
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'conversations.json'), 'utf8')).items.find(item => item.id === chat.id);
    assert.equal(saved.contexts.chat.webThreadId, first ? first.threadId : missing.chat);
    assert.equal(saved.contexts.work.webThreadId, work.threadId);
    assert.notEqual(saved.contexts.chat.webThreadId, work.threadId);
    assert.equal(fs.readdirSync(path.join(root, 'jobs')).length, workOnly ? 2 : 4);
    evidence.passed = true;
  } catch (err) {
    evidence.error = safeReason(err.message); throw err;
  } finally {
    disposes.forEach(fn => fn()); evidence.finishedAt = new Date().toISOString(); save();
    console.log('验收记录：' + report);
  }
  return evidence;
}

if (require.main === module) validate({ port: Number(process.env.WEB_BRIDGE_PORT || 5141), workOnly: process.argv.includes('--work-only') })
  .catch(err => { console.error(safeReason(err.message)); process.exitCode = 1; });

module.exports = { validate };
