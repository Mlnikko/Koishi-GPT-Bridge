const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ImagePrompts, MAX_PROMPT_CHARS, validateImagePrompt } = require('../../src/core/image-prompts.cjs');
const { JobQueue } = require('../../src/core/queue.cjs');
const { Conversations } = require('../../src/core/conversations.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-prompts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompts = new ImagePrompts(path.join(root, 'prompts'));
  const write = (name, body) => fs.writeFileSync(path.join(prompts.dir, name + '.md'), body);
  return { root, prompts, write };
}

test('local UTF-8 templates replace every placeholder literally and reread edits', t => {
  const { prompts, write } = fixture(t);
  write('海报 A', '\ufeff画 {{角色名}}。\r\n{{角色名}} 站在雨中。');
  const first = prompts.render('海报 A', "$& $` $' <hero>");
  assert.equal(first.text, "画 $& $` $' <hero>。\r\n$& $` $' <hero> 站在雨中。");
  write('海报 A', '新版：{{角色名}}');
  assert.equal(prompts.render('海报 A', '新角色').text, '新版：新角色');
  assert.notEqual(prompts.read('海报 A').revision, first.revision);
  assert.match(first.template, /站在雨中/);
  assert.deepEqual(prompts.list(), ['海报 A']);
});

test('invalid templates, roles, paths and links fail before submission', t => {
  const { root, prompts, write } = fixture(t);
  for (const name of ['../outside', 'a/b', 'a\\b', 'show', '--page 2', 'a\n'])
    assert.throws(() => prompts.read(name), /模板名称/);
  assert.throws(() => prompts.read('不存在'), /未找到模板/);
  for (const body of ['', 'no placeholder', '{{角色}}', '{{角色名}} {{bad', '{{角色名}}\x00', 'a'.repeat(MAX_PROMPT_CHARS) + '{{角色名}}', Buffer.from([0xff])]) {
    write('坏模板', body);
    assert.throws(() => prompts.read('坏模板'), /非空|占位符|最多|UTF-8/);
  }
  write('好模板', '{{角色名}}');
  for (const character of [undefined, '', 'x'.repeat(101), 'a\nb', '{{角色名}}'])
    assert.throws(() => prompts.render('好模板', character), /角色名/);
  write('膨胀', '{{角色名}}'.repeat(100));
  assert.throws(() => prompts.render('膨胀', 'a'.repeat(100)), /替换后/);
});

test('symbolic links cannot expose files outside the template library', { skip: process.platform === 'win32' }, t => {
  const { root, prompts } = fixture(t);
  fs.writeFileSync(path.join(root, 'outside.md'), '{{角色名}} secret');
  fs.symlinkSync(path.join(root, 'outside.md'), path.join(prompts.dir, '链接.md'));
  assert.ok(!prompts.list().includes('链接'));
  assert.throws(() => prompts.read('链接'), /符号链接/);
  fs.rmSync(prompts.dir, { recursive: true }); fs.symlinkSync(root, prompts.dir);
  assert.throws(() => prompts.list(), /普通目录/);
});

test('bundled examples are installed only on first creation, preserving edits and deletions', t => {
  const { root } = fixture(t);
  const defaults = path.join(__dirname, '../../examples/prompts'), dir = path.join(root, 'new-library');
  const first = new ImagePrompts(dir, defaults);
  assert.ok(first.read('角色海报').template.includes('{{角色名}}'));
  fs.writeFileSync(path.join(dir, '角色海报.md'), '本地：{{角色名}}');
  assert.equal(new ImagePrompts(dir, defaults).read('角色海报').template, '本地：{{角色名}}');
  fs.unlinkSync(path.join(dir, '角色海报.md'));
  assert.ok(!new ImagePrompts(dir, defaults).list().includes('角色海报'));
});

test('public image templates persist creator permissions without exposing metadata in rendered snapshots', t => {
  const { prompts, write } = fixture(t);
  const original = prompts.create('共享海报', '  画{{角色名}}\n{{画风|水彩}}  ', 'alice');
  assert.equal(original.owner, 'alice');
  assert.equal(original.template, '画{{角色名}}\n{{画风|水彩}}');
  const snapshot = prompts.render('共享海报', '英雄');
  assert.equal(snapshot.owner, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /koishi-image-prompt|alice/);
  const file = path.join(prompts.dir, '共享海报.md'), bytes = fs.readFileSync(file);
  assert.throws(() => prompts.create('共享海报', '{{角色名}}', 'bob'), /同名/);
  assert.throws(() => prompts.edit('共享海报', '{{角色名}}', 'bob'), /只有创建者/);
  assert.throws(() => prompts.delete('共享海报', 'bob'), /只有创建者/);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const rebooted = new ImagePrompts(prompts.dir);
  assert.equal(rebooted.read('共享海报').owner, 'alice');
  const changed = rebooted.edit('共享海报', '新版{{角色名}}', 'alice');
  assert.equal(changed.owner, 'alice');
  assert.notEqual(changed.revision, original.revision);
  assert.equal(rebooted.render('共享海报', '英雄').text, '新版英雄');
  assert.equal(snapshot.text, '画英雄\n水彩');
  rebooted.delete('共享海报', 'alice');
  assert.equal(fs.existsSync(file), false);
  write('本地模板', '{{角色名}}');
  assert.throws(() => prompts.edit('本地模板', '{{角色名}} 新版', 'alice'), /本地创建/);
  assert.throws(() => prompts.delete('本地模板', 'alice'), /本地创建/);
});

test('invalid image template writes and disk failures preserve existing files and ownership', t => {
  const { prompts, write } = fixture(t);
  for (const name of ['create', 'EDIT', 'delete name', '../outside'])
    assert.throws(() => prompts.create(name, '{{角色名}}', 'alice'), /模板名称/);
  for (const body of ['', 'no placeholder', '{{角色名}} {{bad', '{{角色名}}' + 'x'.repeat(MAX_PROMPT_CHARS)])
    assert.throws(() => prompts.create('无效', body, 'alice'), /非空|占位符|最多/);
  for (const owner of [undefined, '', 'a\nb', 'x'.repeat(257)])
    assert.throws(() => prompts.create('无效', '{{角色名}}', owner), /创建者身份/);
  assert.deepEqual(prompts.list(), []);
  prompts.create('海报', '{{角色名}}', 'alice');
  const file = path.join(prompts.dir, '海报.md'), bytes = fs.readFileSync(file);
  assert.throws(() => prompts.edit('海报', 'no placeholder', 'alice'), /占位符/);
  const rename = t.mock.method(fs, 'renameSync', () => { throw Error('disk full'); });
  assert.throws(() => prompts.edit('海报', '新{{角色名}}', 'alice'), /disk full/);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(prompts.dir), ['海报.md']); rename.mock.restore();
  const writeFile = t.mock.method(fs, 'writeFileSync', () => { throw Error('disk full'); });
  assert.throws(() => prompts.create('失败', '{{角色名}}', 'alice'), /disk full/);
  assert.equal(fs.existsSync(path.join(prompts.dir, '失败.md')), false); writeFile.mock.restore();
  write('无效', '<!-- koishi-image-prompt {"version":1,"owner":null} -->\n{{角色名}}');
  assert.throws(() => prompts.read('无效'), /创建者信息无效/);
  assert.throws(() => prompts.edit('无效', '{{角色名}}', 'alice'), /创建者信息无效/);
  assert.throws(() => prompts.delete('无效', 'alice'), /创建者信息无效/);
  // A creator can repair an invalid body; a second header in user text cannot transfer ownership.
  fs.writeFileSync(file, bytes.toString().split('\n')[0] + '\n');
  assert.throws(() => prompts.read('海报'), /非空/);
  prompts.edit('海报', '<!-- koishi-image-prompt {"version":1,"owner":"bob"} -->\n{{角色名}}', 'alice');
  assert.equal(prompts.read('海报').owner, 'alice');
  assert.throws(() => prompts.delete('海报', 'bob'), /只有创建者/);
});

test('image template mutations reject symbolic links and preserve their targets', { skip: process.platform === 'win32' }, t => {
  const { root, prompts } = fixture(t);
  const outside = path.join(root, 'outside.md'), body = '{{角色名}} secret';
  fs.writeFileSync(outside, body);
  fs.symlinkSync(outside, path.join(prompts.dir, '链接.md'));
  assert.throws(() => prompts.create('链接', '{{角色名}}', 'alice'), /同名/);
  assert.throws(() => prompts.edit('链接', '{{角色名}}', 'alice'), /符号链接/);
  assert.throws(() => prompts.delete('链接', 'alice'), /符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), body);
  fs.rmSync(prompts.dir, { recursive: true }); fs.symlinkSync(root, prompts.dir);
  assert.throws(() => prompts.create('新模板', '{{角色名}}', 'alice'), /普通目录/);
});

test('queue freezes rendered content across edits, deduplication and restart; longer limits apply only to matching web templates', t => {
  const { root, prompts, write } = fixture(t);
  write('海报', 'a'.repeat(1600) + '{{角色名}}');
  const snapshot = prompts.render('海报', '英雄');
  const q = new JobQueue(path.join(root, 'jobs'), () => assert.fail('must not submit'));
  const request = { owner: 'alice', conversation: 'qq:alice', messageId: 'draw1', imagePrompt: snapshot,
    segments: [{ type: 'text', text: snapshot.text }] };
  assert.throws(() => q.enqueue({ ...request, imagePrompt: undefined }), /文字最多 1500/);
  assert.throws(() => q.enqueue({ ...request, backend: 'lmstudio' }), /只适用于 ChatGPT/);
  assert.throws(() => q.enqueue({ ...request, segments: [{ type: 'text', text: 'other' }] }), /正文不一致/);
  assert.throws(() => q.enqueue({ ...request, imagePrompt: { ...snapshot, template: 'modified {{角色名}}' } }), /快照/);
  const first = q.enqueue(request).job;
  snapshot.template = 'mutated'; write('海报', '新：{{角色名}}');
  assert.equal(q.enqueue(request).job, first);
  assert.equal(first.input[0].text, 'a'.repeat(1600) + '英雄');
  const reboot = new JobQueue(q.root, () => assert.fail('must not submit'));
  assert.deepEqual(reboot.jobs[0].imagePrompt, first.imagePrompt);
  assert.deepEqual(reboot.jobs[0].input, first.input);
  assert.equal(reboot.jobs[0].status, 'interrupted');
});

test('template selection is scoped, persisted, inherited and published only after successful writes', t => {
  const { root } = fixture(t), file = path.join(root, 'conversations.json');
  const chats = new Conversations(file), a = chats.ensure('alice', 'qq:group');
  chats.setImagePrompt(a.id, 'alice', 'qq:group', '海报');
  assert.throws(() => chats.setImagePrompt(a.id, 'bob', 'qq:group', '其他'), /未找到/);
  assert.throws(() => chats.setImagePrompt(a.id, 'alice', 'qq:other', '其他'), /未找到/);
  const next = chats.create('alice', 'qq:group', 'new', { imagePrompt: a.imagePrompt });
  assert.equal(new Conversations(file).current('alice', 'qq:group').imagePrompt, '海报');
  t.mock.method(chats, 'save', () => { throw Error('disk full'); });
  assert.throws(() => chats.setImagePrompt(next.id, 'alice', 'qq:group', undefined), /disk full/);
  assert.equal(chats.current('alice', 'qq:group').imagePrompt, '海报');
});

test('arbitrary fields, defaults, required values and explicit overrides render deterministically', t => {
  const { prompts, write } = fixture(t);
  write('多变量', '{{角色名}}：{{动作}}，{{场景|花园}}。再次{{场景|花园}}。{{备注|}}');
  assert.throws(() => prompts.render('多变量', '孙悟空'), /缺少必填参数：动作/);
  const defaults = prompts.render('多变量', '孙悟空 | 动作=站立');
  assert.ok(defaults.text.startsWith('孙悟空：站立，花园。再次花园。'));
  assert.deepEqual(defaults.parameters, { 角色名: '孙悟空', 动作: '站立', 场景: '花园', 备注: '' });
  const rendered = prompts.render('多变量', '孙悟空 | 动作=扛棒 | 场景=雨夜天宫 | 补充要求=黑白画风');
  assert.ok(rendered.text.startsWith('孙悟空：扛棒，雨夜天宫。再次雨夜天宫。'));
  assert.match(rendered.text, /【本次明确要求】[\s\S]*黑白画风[\s\S]*优先/);
  assert.equal(rendered.parameters.补充要求, '黑白画风');
  assert.equal(rendered.supplied.场景, '雨夜天宫');
  assert.equal(defaults.supplied.场景, undefined);
  assert.equal(rendered.text.includes('{{'), false);
  assert.throws(() => prompts.render('多变量', '孙悟空 | 动作='), /缺少必填参数：动作/);
});

test('escaped pipes, backslashes, equals signs and dollar sequences remain literal', t => {
  const { prompts, write } = fixture(t);
  write('转义', '{{角色名}}：{{场景|花园}}；{{补充要求|无}}');
  const request = String.raw`A\|B | 场景=左\|右 | 补充要求=C:\\test，x=y $& $'`;
  const snapshot = prompts.render('转义', request);
  assert.equal(snapshot.character, 'A|B');
  assert.equal(snapshot.parameters.场景, '左|右');
  assert.equal(snapshot.parameters.补充要求, String.raw`C:\test，x=y $& $'`);
  assert.equal(snapshot.request, request);
  assert.deepEqual(validateImagePrompt(snapshot), snapshot);
});

test('legacy snapshot roles containing pipes keep their exact text; new supplements also work with old templates', t => {
  const { prompts, write } = fixture(t);
  write('旧模板', '画{{角色名}}');
  const legacy = validateImagePrompt({ ...prompts.read('旧模板'), character: 'A | B' });
  assert.equal(legacy.text, '画A | B');
  assert.equal(validateImagePrompt(legacy).text, legacy.text);
  const supplemented = prompts.render('旧模板', '孙悟空 | 补充要求=水彩');
  assert.match(supplemented.text, /^画孙悟空[\s\S]*补充要求：水彩/);
  assert.equal(prompts.render('旧模板', '孙悟空').text, '画孙悟空');
});

test('invalid variable declarations and ambiguous or unknown arguments fail rather than silently disappear', t => {
  const { prompts, write } = fixture(t);
  for (const body of ['{{角色名|悟空}}', '{{角色名}} {{场景|雨}}{{场景|雪}}', '{{角色名}} {{场景|雨}}{{场景}}',
    '{{角色名}} {{__proto__}}', '{{角色名}} {{9name}}', '{{角色名}} {{场景|雨\n雪}}',
    '{{角色名}} {{场景|{{other}}}}', '{{角色名}}' + Array.from({ length: 16 }, (_, i) => '{{field' + i + '|}}').join('')]) {
    write('坏定义', body);
    assert.throws(() => prompts.read('坏定义'), /默认值|占位符|最多支持/);
  }
  write('海报', '{{角色名}} {{场景|花园}}');
  for (const request of ['孙悟空 | 未知=值', '孙悟空 | 场景=雨 | 场景=雪', '孙悟空 | 角色名=别人',
    '孙悟空 | 雨夜', '孙悟空 |', '孙悟空 | 场景={{角色名}}', '孙悟空 | 补充要求=' + 'x'.repeat(1000)])
    assert.throws(() => prompts.render('海报', request), /不支持参数|重复|参数格式|占位符|合计最多/);
});

test('new snapshots freeze the original request and resolved values across template edits and queue restarts', t => {
  const { root, prompts, write } = fixture(t);
  write('海报', '{{角色名}} {{画风|水彩}} {{场景|花园}}');
  const snapshot = prompts.render('海报', '孙悟空 | 场景=天宫');
  const q = new JobQueue(path.join(root, 'jobs'), () => assert.fail('must not submit'));
  const first = q.enqueue({ owner: 'alice', conversation: 'qq:a', messageId: 'v2', imagePrompt: snapshot,
    segments: [{ type: 'text', text: snapshot.text }] }).job;
  write('海报', '{{角色名}} {{画风|油画}}');
  snapshot.supplied.场景 = 'modified'; snapshot.parameters.画风 = 'modified';
  const restored = new JobQueue(q.root, () => assert.fail('must not submit')).jobs[0];
  assert.equal(restored.imagePrompt.parameters.画风, '水彩');
  assert.equal(restored.imagePrompt.supplied.场景, '天宫');
  assert.deepEqual(restored.input, first.input);
  const tampered = { ...restored.imagePrompt, request: '孙悟空 | 场景=别处' };
  assert.throws(() => q.enqueue({ owner: 'alice', conversation: 'qq:a', messageId: 'tampered', imagePrompt: tampered,
    segments: first.input }), /正文不一致/);
});

test('empty optional fields at the boundaries still pass queue validation and final limits include appended requirements', t => {
  const { root, prompts, write } = fixture(t);
  write('空参数', '{{备注|}}\n{{角色名}}\n{{补充要求|}}');
  const snapshot = prompts.render('空参数', '孙悟空');
  assert.equal(snapshot.text, '孙悟空');
  const q = new JobQueue(path.join(root, 'jobs'), () => assert.fail('must not submit'));
  assert.equal(q.enqueue({ owner: 'alice', conversation: 'qq:a', imagePrompt: snapshot,
    segments: [{ type: 'text', text: snapshot.text }] }).job.input[0].text, '孙悟空');
  write('上限', '{{角色名}}' + 'a'.repeat(7950));
  assert.throws(() => prompts.render('上限', '孙悟空 | 补充要求=' + 'x'.repeat(100)), /替换后/);
});
