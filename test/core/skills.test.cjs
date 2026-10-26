const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Skills, parseSkill, validateSkillSnapshot, skillContext, MAX_SKILL_CHARS } = require('../../src/core/skills.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'skills'); fs.mkdirSync(dir);
  const write = (name, instructions = '保留材料里的结论和事实。', header = `name: ${name}\ndescription: 整理用户提供的材料`) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    const file = path.join(dir, name, 'SKILL.md');
    fs.writeFileSync(file, `---\n${header}\n---\n${instructions}`);
    return file;
  };
  return { root, dir, write, library: new Skills(dir) };
}

test('skill discovery supports UTF-8, quoted and folded descriptions and ignores optional tool metadata', t => {
  const { write, library } = fixture(t);
  const file = write('summarize', '## 整理\n保留事实。', "name: 'summarize'\ndescription: >-\n  整理讨论记录，\n  保留结论。\nmetadata:\n  short-description: 摘要\nallowed-tools: Bash");
  fs.writeFileSync(file, '\uFEFF' + fs.readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
  write('translate', '翻译原文。', 'name: "translate"\ndescription: "翻译材料"');
  assert.deepEqual(library.list(), { skills: [
    { name: 'summarize', description: '整理讨论记录， 保留结论。' }, { name: 'translate', description: '翻译材料' },
  ], invalid: [] });
  const skill = library.read('summarize');
  assert.match(skill.instructions, /保留事实/);
  assert.doesNotMatch(skillContext(skill), /allowed-tools|Bash|short-description/);
  assert.match(skillContext(skill), /没有本机文件、脚本、CLI 或 MCP/);
});

test('each read sees edits but earlier snapshots stay intact', t => {
  const { write, library } = fixture(t);
  write('summarize', '第一版'); const first = library.read('summarize');
  write('summarize', '第二版'); const second = library.read('summarize');
  assert.notEqual(first.revision, second.revision); assert.equal(first.instructions, '第一版');
  assert.throws(() => validateSkillSnapshot({ ...first, instructions: '篡改' }), /快照/);
  assert.throws(() => validateSkillSnapshot({ ...first, description: '篡改' }), /快照/);
});

test('invalid entries remain diagnosable without hiding valid skills or reading other resources', t => {
  const { root, write, library } = fixture(t);
  write('valid');
  write('mismatch', '正文', 'name: another\ndescription: 名称不符');
  write('duplicate', '正文', 'name: duplicate\ndescription: 甲\ndescription: 乙');
  write('empty', ''); write('large', '字'.repeat(MAX_SKILL_CHARS + 1));
  fs.writeFileSync(write('invalid-utf8'), Buffer.from([0xff, 0xfe, 0x00]));
  const resources = path.join(root, 'skills', 'valid', 'references'); fs.mkdirSync(resources);
  fs.symlinkSync('/a/nonexistent/private-file', path.join(resources, 'private.md'));
  assert.deepEqual(library.list().skills.map(s => s.name), ['valid']);
  assert.equal(library.list().invalid.length, 5);
  for (const name of ['mismatch', 'duplicate', 'empty', 'large', 'invalid-utf8', 'missing', '../private', 'off'])
    assert.throws(() => library.read(name));
  for (const header of ['name: valid', 'name: valid\ndescription: [text]', 'name: valid\ndescription: "bad', 'name: valid\ndescription: &alias text'])
    assert.throws(() => parseSkill(`---\n${header}\n---\n正文`, 'valid'));
});

test('symlinked libraries, skill directories and SKILL.md files cannot expose other files', t => {
  const { root, dir, write, library } = fixture(t);
  const original = write('original');
  fs.symlinkSync(path.join(dir, 'original'), path.join(dir, 'linked-dir'));
  fs.mkdirSync(path.join(dir, 'linked-file'));
  fs.symlinkSync(original, path.join(dir, 'linked-file', 'SKILL.md'));
  fs.symlinkSync(dir, path.join(root, 'linked-library'));
  assert.throws(() => new Skills(path.join(root, 'linked-library')), /符号链接/);
  assert.throws(() => library.read('linked-dir'), /符号链接/);
  assert.throws(() => library.read('linked-file'), /符号链接/);
  assert.deepEqual(library.list().skills.map(s => s.name), ['original']);
});

test('default examples seed only on first directory creation and explicit libraries are read-only', t => {
  const { root, dir, write } = fixture(t); write('example');
  const target = path.join(root, 'new-library');
  new Skills(target, dir);
  fs.rmSync(path.join(target, 'example'), { recursive: true });
  assert.deepEqual(new Skills(target, dir).list(), { skills: [], invalid: [] });
  const missing = path.join(root, 'external');
  assert.throws(() => new Skills(missing)); assert.equal(fs.existsSync(missing), false);
});

test('first-run seeding survives Windows Unicode and space paths and preserves nested files', t => {
  const { root, write } = fixture(t);
  const source = path.join(root, '中文 示例库'), target = path.join(root, '中文 实例', '技能库');
  fs.mkdirSync(path.join(source, 'example', 'assets'), { recursive: true });
  fs.copyFileSync(write('example', '中文技能正文'), path.join(source, 'example', 'SKILL.md'));
  const bytes = Buffer.from([0, 1, 127, 255]);
  fs.writeFileSync(path.join(source, 'example', 'assets', '参考文件.bin'), bytes);
  // Native cpSync regressions can abort the process without throwing. Keep the
  // reproduction in a child so that a failure is reported by the test runner.
  const script = `const assert=require('node:assert/strict');
    const {Skills}=require(${JSON.stringify(require.resolve('../../src/core/skills.cjs'))});
    const library=new Skills(process.argv[1],process.argv[2]);
    assert.equal(library.read('example').instructions,'中文技能正文');`;
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', script, target, source],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, String(child.error || child.signal || '') + child.stderr);
  assert.deepEqual(fs.readFileSync(path.join(target, 'example', 'assets', '参考文件.bin')), bytes);
});
