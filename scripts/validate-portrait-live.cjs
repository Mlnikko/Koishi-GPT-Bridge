'use strict';
// Real Chrome/ChatGPT generation with isolated conversations and simulated QQ
// acknowledgements. Stop the normal Koishi instance before reusing its port.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const plugin = require('../src/index.cjs');
const { Skills } = require('../src/core/skills.cjs');
const { inspect } = require('./doctor.cjs');
const { replyAssetPath } = require('../src/lib/reply-assets.cjs');
const { sniffImage, pngSize } = require('../src/lib/image.cjs');
const { safeReason } = require('../src/lib/feedback.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function validate({ port = 5141, productionData = path.resolve(__dirname, '..', 'data'), resumeRoot } = {}) {
  const library = path.join(productionData, 'skills'), skill = new Skills(library).read('chatgpt-jp-portrait');
  const acceptance = path.join(productionData, 'acceptance'); fs.mkdirSync(acceptance, { recursive: true, mode: 0o700 });
  const root = resumeRoot ? path.resolve(resumeRoot) : fs.mkdtempSync(path.join(acceptance, 'portrait-'));
  if (!root.startsWith(path.resolve(acceptance) + path.sep)) throw Error('只能恢复本项目 acceptance 中的隔离验收记录');
  // Reuse only the extension credential; no QQ credentials or user state enter
  // this fixture. The token is never included in the report or console output.
  if (!resumeRoot) {
    fs.copyFileSync(path.join(productionData, 'web-bridge-token'), path.join(root, 'web-bridge-token'));
    fs.chmodSync(path.join(root, 'web-bridge-token'), 0o600);
  }
  const stages = [], disposes = [];
  const evidence = resumeRoot ? JSON.parse(fs.readFileSync(path.join(root, 'validation.json'), 'utf8'))
    : { startedAt: new Date().toISOString(), root, backend: 'real-chatgpt-web',
      qqTransport: 'simulated', invocation: 'native-mention', skill: { name: skill.name, revision: skill.revision }, commands: [], turns: [], passed: false };
  if (resumeRoot) {
    assert.equal(evidence.backend, 'real-chatgpt-web'); assert.equal(evidence.qqTransport, 'simulated');
    assert.equal(evidence.skill.revision, skill.revision, '恢复时必须使用同一技能版本');
    assert.ok(evidence.turns.find(t => t.name === 'generate' && t.passed));
    assert.ok(!evidence.passed && !evidence.turns.some(t => t.name === 'edit-retry'), '只允许额外重试一次改图');
    evidence.previousErrors = [...(evidence.previousErrors || []), evidence.error];
    evidence.resumedAt = new Date().toISOString(); delete evidence.error; delete evidence.finishedAt;
  }
  const commands = evidence.commands;
  const report = path.join(root, 'validation.json');
  const save = () => fs.writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const session = text => ({ platform: 'qq', userId: 'portrait-live-validation', channelId: 'portrait-live-validation',
    isDirect: true, messageId: 'portrait-live-' + Date.now(), timestamp: Date.now(), sent: [],
    elements: text ? [{ type: 'text', attrs: { content: text } }] : [],
    send: async function (content) { this.sent.push(content); return ['simulated-qq-ack-' + this.sent.length]; } });
  const dispatch = async (s, text) => {
    s.stripped = { content: text };
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
  const command = async (text, expected) => {
    const reply = await dispatch(session(), text);
    assert.match(reply, expected);
    commands.push({ command: text, reply }); save();
    console.log('命令通过：' + text);
    return reply;
  };
  const turn = async (name, prompt, wantsImage) => {
    const s = session(prompt), started = Date.now();
    const row = { name, prompt, wantsImage, startedAt: new Date().toISOString() }; evidence.turns.push(row); save();
    const rejected = await dispatch(s, prompt);
    if (rejected) throw Error(rejected);
    console.log('已提交真实网页：' + name);
    let lastProgress;
    for (;;) {
      const jobs = fs.readdirSync(path.join(root, 'jobs')).map(id => JSON.parse(fs.readFileSync(path.join(root, 'jobs', id, 'job.json'))));
      const job = jobs.find(j => j.messageId === s.messageId);
      if (job) {
        row.jobId = job.id; row.status = job.status; row.progress = job.progress;
        if (lastProgress !== job.progress) { lastProgress = job.progress; console.log(name + '：' + (job.progress || job.status)); save(); }
        if (['failed', 'cancelled', 'interrupted'].includes(job.status)) throw Error(job.error || job.status);
        if (job.status === 'ready' && job.delivery === 'failed') throw Error(job.deliveryError || '模拟 QQ 回传失败');
        if (job.status === 'ready' && job.delivery === 'sent') {
          assert.equal(job.skill.revision, skill.revision);
          assert.equal(job.input[0].text, prompt);
          const submission = JSON.parse(fs.readFileSync(path.join(job.dir, 'submission.json'), 'utf8'));
          assert.equal(submission.skillRequested, skill.name);
          assert.ok(submission.skillApplied?.id, '发送前须确认原生技能标记');
          assert.equal(submission.skillApplied.name.toLowerCase().replace(/[\s_-]+/g, '-'), skill.name);
          assert.ok(submission.textMatched, '网页用户轮次须包含本次原文');
          assert.ok(!submission.userText.includes(skill.instructions), '网页不应携带本机技能正文');
          row.nativeSkill = submission.skillApplied; row.submittedText = submission.userText;
          const media = job.output.filter(segment => segment.type === 'image');
          row.sessionId = job.sessionId; row.threadId = job.threadId;
          row.reply = fs.readFileSync(path.join(job.dir, 'reply.md'), 'utf8');
          row.elapsedMs = Date.now() - started; row.delivery = job.delivery; row.qqAcknowledgements = s.sent.length;
          row.images = media.map(image => {
            const file = replyAssetPath(job.dir, image.asset, image.mime), bytes = fs.readFileSync(file), type = sniffImage(bytes);
            const wire = s.sent.flatMap(content => [...content.matchAll(/src="data:(image\/[a-z+]+);base64,([^"]+)"/g)])
              .find(match => match[1] === type.mime && Buffer.from(match[2], 'base64').equals(bytes));
            assert.ok(wire, 'QQ 图片回传须与网页保存的原始字节一致');
            return { file, mime: type.mime, bytes: bytes.length, sha256: sha256(bytes),
              ...(type.ext === 'png' ? pngSize(bytes) : {}), byteIdenticalSimulatedQQ: true };
          });
          save();
          assert.equal(media.length, wantsImage ? 1 : 0, name + ' 的实际图片数量不符');
          if (!wantsImage) {
            assert.match(row.reply, /手|杯/); assert.match(row.reply, /白色|陶瓷/);
            assert.match(row.reply, /特写|手腕/);
          }
          console.log(JSON.stringify({ name, elapsedMs: row.elapsedMs, images: row.images, reply: wantsImage ? undefined : row.reply }));
          row.passed = true; save(); return row;
        }
      }
      if (Date.now() - started > 290000) throw Error('网页验收超时；未自动重提请求');
      await pause(500);
    }
  };
  try {
    plugin.apply({ intersect: filter => ({ middleware: fn => stages.push({ filter, fn }) }),
      setInterval: () => {}, on: (event, fn) => { if (event === 'dispose') disposes.push(fn); },
      logger: () => ({ info: () => {}, warn: () => {} }),
    }, { allowedUsers: ['portrait-live-validation'], dataDir: root, skillsDir: library,
      webBridgePort: port, notifyProgress: false });
    console.log('验收记录：' + report); save();
    const connectedAt = Date.now();
    for (;;) {
      let health;
      try { health = await inspect({ dataDir: root }); } catch {}
      if (health?.online) break;
      if (Date.now() - connectedAt > 75000) throw Error('真实 Chrome 扩展未连接到验收桥接');
      await pause(1000);
    }
    console.log('真实 Chrome 扩展已连接');
    if (resumeRoot) {
      await command('/skill', /当前技能：chatgpt-jp-portrait/);
      const generated = evidence.turns.find(t => t.name === 'generate' && t.passed);
      const failed = evidence.turns.find(t => t.name === 'edit' && !t.passed);
      assert.ok(failed && failed.status === 'ready' && /Something went wrong while generating your image/i.test(failed.reply), '只恢复已确认结束的图像服务错误');
      const edited = await turn('edit-retry', failed.prompt, true);
      assert.equal(generated.sessionId, edited.sessionId); assert.equal(generated.threadId, edited.threadId);
      assert.notEqual(generated.images[0].sha256, edited.images[0].sha256);
      evidence.passed = true;
      console.log('同一会话改图重试通过；原出图、原错误和新图片均已保留。');
      return evidence;
    }
    await command('/skill', /chatgpt-jp-portrait/);
    await command('/skill show chatgpt-jp-portrait', /chatgpt-jp-portrait/);
    await command('/skill chatgpt-jp-portrait', /已选择技能/);
    await command('/new 人像技能实际验收', /沿用技能：chatgpt-jp-portrait/);
    await command('/skill', /当前技能：chatgpt-jp-portrait/);
    const promptOnly = await turn('prompt-only', 'P03 + C04，白色陶瓷杯、浅粉针织袖口，只要手部特写提示词，不要生成图片。', false);
    const generated = await turn('generate', 'J01，P02，F01，奶油色不透明针织衫，樱花街角。虚构的18岁成年女性，日系自然写实摄影，竖幅4:5，直接生成一张图片。', true);
    const edited = await turn('edit', '编辑上一张实际生成的图片：只把奶油色针织衫改成浅蓝色，保留同一人物的脸、发型、回头微笑姿势、腰部以上构图、樱花背景和光线，直接生成一张修改后的图片。', true);
    assert.equal(promptOnly.sessionId, generated.sessionId); assert.equal(generated.sessionId, edited.sessionId);
    assert.equal(generated.threadId, edited.threadId);
    assert.notEqual(generated.images[0].sha256, edited.images[0].sha256);
    evidence.passed = true;
    console.log('真实网页三轮验收通过；QQ 回传为隔离模拟接收，未向真实联系人发送。');
  } catch (err) {
    evidence.error = safeReason(err.message); throw err;
  } finally {
    disposes.forEach(fn => fn()); evidence.finishedAt = new Date().toISOString(); save();
    console.log('验证记录：' + report);
  }
  return evidence;
}

if (require.main === module) {
  const resume = process.argv.indexOf('--resume');
  if (resume >= 0 && !process.argv[resume + 1]) {
    console.error('用法：npm run validate:portrait -- --resume data/acceptance/portrait-目录'); process.exitCode = 1;
  } else validate({ port: Number(process.env.WEB_BRIDGE_PORT || 5141), resumeRoot: resume >= 0 ? process.argv[resume + 1] : undefined })
    .catch(err => { console.error(safeReason(err.message)); process.exitCode = 1; });
}

module.exports = { validate };
