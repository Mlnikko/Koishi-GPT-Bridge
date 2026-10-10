'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const plugin = require('../src/index.cjs');
const { request } = require('./desktop-transport.cjs');
const { writeJson } = require('../src/lib/state.cjs');
const { textMessage } = require('../src/lib/feedback.cjs');

// A real desktop conversation with a stand-in QQ adapter. This script exercises
// the real plugin queue, result persistence and delivery callback, not QQ's network.
async function validate({ threadId, root }) {
  if (fs.existsSync(root)) throw Error('验收目录必须是新的，避免覆盖已有凭据');
  const stages = [], disposes = [], delivered = [];
  const scope = filter => ({ middleware: (callback, first) => first ? stages.unshift({ filter, callback }) : stages.push({ filter, callback }) });
  const ctx = { intersect: scope, setInterval: () => {}, on: (event, callback) => disposes.push(callback), logger: () => ({ info() {}, warn() {} }) };
  plugin.apply(ctx, { allowedUsers: ['prototype-owner'], dataDir: root, webBridgePort: 0, desktopBridgePort: 0,
    desktopThreadId: threadId, desktopOwnerId: 'prototype-owner', notifyProgress: false, replyTimeoutMs: 240000 });
  let index = 0;
  const dispatch = async text => {
    const session = { platform: 'qq', userId: 'prototype-owner', isDirect: true, channelId: 'prototype-private',
      messageId: `live-${++index}`, timestamp: Date.now(), elements: [{ type: 'text', attrs: { content: text } }],
      stripped: { content: text }, send: async content => { delivered.push({ messageId: session.messageId, text: content }); return ['fixture-delivery-id']; } };
    const next = async i => {
      const stage = stages[i];
      if (!stage) return;
      if (!stage.filter(session)) return next(i + 1);
      return stage.callback(session, async fallback => { const result = await next(i + 1); return result === undefined && fallback ? fallback() : result; });
    };
    return next(0);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    console.log(JSON.stringify({ stage: 'waiting_worker', root, threadId }));
    const waitStarted = Date.now();
    while (!(await request({ root, endpoint: '/health' }).catch(() => ({}))).online) {
      if (Date.now() - waitStarted > 240000) throw Error('执行器连接等待超时');
      await sleep(500);
    }
    const nonce = 'KOISHI-' + randomBytes(6).toString('hex');
    const cases = [
      { prompt: `这是文字桥接验收。请记住口令 ${nonce}，本轮只回复：已记住`, contains: '已记住' },
      { prompt: '上一轮我让你记住的口令是什么？只回复口令，不要添加其他文字。', contains: nonce },
    ];
    const enabled = await dispatch('/desktop on');
    if (!enabled?.includes('已绑定')) throw Error('客户端入口未启用：' + enabled);
    const results = [];
    for (const item of cases) {
      await dispatch(item.prompt);
      const messageId = `live-${index}`, started = Date.now();
      for (;;) {
        const jobs = fs.readdirSync(path.join(root, 'jobs')).map(id => JSON.parse(fs.readFileSync(path.join(root, 'jobs', id, 'job.json'))));
        const job = jobs.find(j => j.messageId === messageId);
        if (job?.status === 'failed') throw Error(job.error);
        if (job?.delivery === 'sent') {
          const reply = delivered.filter(entry => entry.messageId === messageId).map(entry => entry.text).join('');
          const receipt = JSON.parse(fs.readFileSync(path.join(job.dir, 'desktop-receipt.json')));
          if (!reply.includes(item.contains)) throw Error(`回复不符合验收预期：${reply}`);
          if (reply !== textMessage(receipt.text)) throw Error('客户端文字与适配器安全转义后的回传文字不一致');
          results.push({ prompt: item.prompt, reply: receipt.text, adapterPayload: reply, jobId: job.id, threadId: job.threadId, receipt });
          console.log(JSON.stringify({ stage: 'round_pass', round: results.length, reply, jobId: job.id }));
          break;
        }
        if (Date.now() - started > 250000) throw Error('任务验收超时');
        await sleep(500);
      }
    }
    const off = await dispatch('/desktop off');
    if (!off?.includes('切回网页')) throw Error('网页入口切回失败');
    const report = { at: new Date().toISOString(), scope: 'real ChatGPT ordinary chat; real Koishi plugin; simulated QQ transport',
      threadId, rounds: results, webSwitch: true, delivered };
    writeJson(path.join(root, 'validation.json'), report);
    console.log(JSON.stringify({ stage: 'complete', report: path.join(root, 'validation.json') }));
    return report;
  } finally { for (const dispose of disposes) dispose(); }
}
if (require.main === module) validate({ threadId: process.argv[2], root: path.resolve(process.argv[3]) }).catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { validate };
