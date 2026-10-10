'use strict';
// Explicitly invoked live validation: real LM Studio, temporary plugin state,
// simulated QQ transport. No QQ credentials or existing conversations are used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const plugin = require('../src/index.cjs');
const { visionPng } = require('./vision-fixture.cjs');

async function validate({ baseUrl = 'http://127.0.0.1:1234/v1', model = '', apiKey = '', vision = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koishi-lmstudio-live-'));
  const evidence = { version: require('../package.json').version, baseUrl, root, vision, startedAt: new Date().toISOString(), turns: [] };
  const boot = () => {
    const stages = [], disposes = [];
    plugin.apply({
      intersect: filter => ({ middleware: fn => stages.push({ filter, fn }) }),
      setInterval: () => {}, on: (event, fn) => { if (event === 'dispose') disposes.push(fn); },
      logger: () => ({ info: () => {}, warn: () => {} }),
    }, { allowedUsers: ['live-validation'], dataDir: root, webBridgePort: 0, notifyProgress: false,
      lmStudioBaseUrl: baseUrl, lmStudioModel: model, lmStudioApiKey: apiKey, lmStudioMaxTokens: 512 });
    return {
      close: () => disposes.forEach(fn => fn()),
      dispatch: async (s, text) => {
        s.stripped = { content: text };
        const run = async index => {
          if (index === stages.length) return;
          const stage = stages[index]; if (!stage.filter(s)) return run(index + 1);
          return stage.fn(s, async fallback => {
            const result = await run(index + 1);
            return result === undefined && typeof fallback === 'function' ? fallback() : result;
          });
        };
        return run(0);
      },
    };
  };
  let app = boot();
  const session = text => ({ platform: 'qq', userId: 'live-validation', channelId: 'live-validation', isDirect: true,
    messageId: 'live-' + evidence.turns.length, timestamp: Date.now(), sent: [],
    elements: text ? [{ type: 'text', attrs: { content: text } }] : [],
    send: async function(content) { this.sent.push(content); return ['simulated-qq-ack']; },
  });
  const turn = async (prompt, image) => {
    const s = session(prompt), started = Date.now();
    if (image) s.elements.unshift({ type: 'img', attrs: { src: 'data:image/png;base64,' + image.toString('base64') } });
    const reply = await app.dispatch(s, prompt);
    if (reply) throw Error(reply);
    console.log('已提交本地测试：' + prompt);
    for (;;) {
      const jobs = fs.readdirSync(path.join(root, 'jobs')).map(id => JSON.parse(fs.readFileSync(path.join(root, 'jobs', id, 'job.json'))));
      const job = jobs.find(j => j.messageId === s.messageId);
      if (job && ['failed', 'cancelled', 'interrupted'].includes(job.status)) throw Error(job.error || job.status);
      if (job?.status === 'ready' && job.delivery === 'sent') {
        const text = s.sent.join('\n');
        const result = { prompt, reply: text, image: !!image, elapsedMs: Date.now() - started, jobId: job.id, sessionId: job.sessionId, model: job.model };
        evidence.turns.push(result); console.log(JSON.stringify(result)); return result;
      }
      if (Date.now() - started > 275000) throw Error('本地测试超时');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  try {
    console.log(await app.dispatch(session(), '/backend lmstudio' + (model ? ' ' + model : '')));
    if (vision) {
      const image = visionPng(); fs.writeFileSync(path.join(root, 'vision-input.png'), image, { mode: 0o600 });
      const first = await turn('这张图片里有几个几何图形？只回答数量，不要描述颜色。', image);
      assert.match(first.reply, /2|两|二/); assert.doesNotMatch(first.reply, /红|蓝|red|blue/i);
      app.close();
      fs.rmSync(path.join(root, 'jobs', first.jobId), { recursive: true });
      evidence.prunedFirstJob = true; app = boot();
      const second = await turn('刚才图片左边的图形是什么颜色？只回答颜色。');
      assert.equal(first.sessionId, second.sessionId); assert.match(second.reply, /红|red/i);
      const historyFile = fs.readdirSync(path.join(root, 'lmstudio')).find(name => name.endsWith('.json'));
      const history = JSON.parse(fs.readFileSync(path.join(root, 'lmstudio', historyFile)));
      const reference = history.turns[0].input.find(s => s.type === 'image');
      const asset = path.join(root, 'lmstudio', historyFile.replace(/\.json$/, '-images'), reference.asset);
      assert.deepEqual(fs.readFileSync(asset), image);
      evidence.preservedImage = asset;
      console.log(await app.dispatch(session(), '/new 空白图片上下文测试'));
      const third = await turn('本次对话之前发过的图片左边是什么颜色？如果本次对话没有图片，只回复“不知道”。');
      assert.notEqual(third.sessionId, first.sessionId); assert.match(third.reply, /不知道/);
      evidence.passed = true;
      console.log('真实视觉模型验证通过：QQ 图片+文字、重启并清理旧任务后看原图续聊、新会话图片隔离。模拟 QQ 回传成功。');
      return evidence;
    }
    const first = await turn('请记住本次对话的暗号是青松8427，只回复“已记住”。');
    app.close(); app = boot();
    const second = await turn('本次对话的暗号是什么？只回复暗号。');
    assert.equal(first.sessionId, second.sessionId); assert.match(second.reply, /青松8427/);
    console.log(await app.dispatch(session(), '/new 空白上下文测试'));
    const third = await turn('本次对话的暗号是什么？如果没有告诉过你，只回复“不知道”。');
    assert.notEqual(third.sessionId, first.sessionId); assert.doesNotMatch(third.reply, /青松8427/);
    evidence.passed = true;
    console.log('真实本地模型验证通过：消息流、重启后续聊和新会话隔离。模拟 QQ 回传成功。');
    return evidence;
  } finally {
    app.close(); evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log('验证记录：' + path.join(root, 'validation.json'));
  }
}

if (require.main === module) validate({ baseUrl: process.env.LM_STUDIO_BASE_URL || undefined,
  model: process.env.LM_STUDIO_MODEL || '', apiKey: process.env.LM_STUDIO_API_KEY || '', vision: process.argv.includes('--vision') })
  .catch(err => { console.error(err.message); process.exitCode = 1; });

module.exports = { validate };
