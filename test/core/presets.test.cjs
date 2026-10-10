const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Presets, MAX_PRESET_CHARS, validatePresetSnapshot } = require('../../src/core/presets.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-presets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const presets = new Presets(path.join(root, 'presets'));
  const write = (name, text) => fs.writeFileSync(path.join(presets.dir, name + '.md'), text);
  return { root, presets, write };
}

test('UTF-8 Markdown presets are discovered and reread after local edits without mutating earlier snapshots', t => {
  const { presets, write } = fixture(t);
  assert.deepEqual(presets.list(), []);
  write('角色 A', '\ufeff  第一版\r\n保持角色口吻  ');
  write('off', 'reserved'); write('.hidden', 'hidden');
  fs.mkdirSync(path.join(presets.dir, 'directory.md'));
  assert.deepEqual(presets.list(), ['角色 A']);
  const before = presets.read('角色 A');
  assert.equal(before.prompt, '第一版\r\n保持角色口吻');
  write('角色 A', '第二版');
  const after = presets.read('角色 A');
  assert.equal(before.prompt, '第一版\r\n保持角色口吻');
  assert.equal(after.prompt, '第二版'); assert.notEqual(after.revision, before.revision);
});

test('missing, empty, oversized, invalid UTF-8 and unsafe names fail with actionable errors', t => {
  const { presets, write } = fixture(t);
  for (const name of ['../secret', 'a/b', 'a\\b', '.', 'off', 'SHOW', 'CON', 'NUL.txt', 'a\n', 'x'.repeat(65)])
    assert.throws(() => presets.read(name), /预设名称/);
  assert.throws(() => presets.read('missing'), /未找到预设/);
  write('empty', '\n  '); assert.throws(() => presets.read('empty'), /非空/);
  write('large', 'a'.repeat(MAX_PRESET_CHARS + 1)); assert.throws(() => presets.read('large'), /最多/);
  write('huge', '字'.repeat(MAX_PRESET_CHARS * 2)); assert.throws(() => presets.read('huge'), /最多/);
  write('invalid', Buffer.from([0xff, 0xfe])); assert.throws(() => presets.read('invalid'), /UTF-8/);
  write('binary', 'a\x00b'); assert.throws(() => presets.read('binary'), /非空文本/);
});

test('snapshot integrity rejects edits and returns a fresh value rather than retaining caller objects', t => {
  const { presets, write } = fixture(t);
  write('role', '保持角色口吻'); const original = presets.read('role');
  const snapshot = validatePresetSnapshot(original);
  original.prompt = 'changed';
  assert.equal(snapshot.prompt, '保持角色口吻');
  assert.throws(() => validatePresetSnapshot(original), /快照校验失败/);
});

test('symbolic links cannot expose files outside the local preset library', { skip: process.platform === 'win32' }, t => {
  const { root, presets } = fixture(t);
  const secret = path.join(root, 'secret.md'); fs.writeFileSync(secret, 'private');
  fs.symlinkSync(secret, path.join(presets.dir, 'linked.md'));
  assert.deepEqual(presets.list(), []);
  assert.throws(() => presets.read('linked'), /符号链接/);
  fs.rmSync(presets.dir, { recursive: true });
  fs.symlinkSync(root, presets.dir);
  assert.throws(() => presets.list(), /普通目录/);
});

test('QQ presets are shared files with persistent creator ownership that never enters the model snapshot', t => {
  const { presets, write } = fixture(t);
  const original = presets.create('公共角色', '  初始正文\n第二行  ', 'alice');
  assert.equal(original.prompt, '初始正文\n第二行'); assert.equal(original.owner, 'alice');
  assert.deepEqual(validatePresetSnapshot(original), { name: original.name, prompt: original.prompt, revision: original.revision });
  const file = path.join(presets.dir, '公共角色.md');
  const bytes = fs.readFileSync(file, 'utf8');
  assert.match(bytes, /^<!-- koishi-preset .*"owner":"alice"/);
  assert.throws(() => presets.create('公共角色', 'overwrite', 'bob'), /同名/);
  assert.throws(() => presets.edit('公共角色', 'overwrite', 'bob'), /只有创建者/);
  assert.throws(() => presets.delete('公共角色', 'bob'), /只有创建者/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const rebooted = new Presets(presets.dir);
  assert.equal(rebooted.read('公共角色').owner, 'alice');
  const changed = rebooted.edit('公共角色', '新的正文', 'alice');
  assert.equal(changed.prompt, '新的正文'); assert.notEqual(changed.revision, original.revision);
  assert.equal(changed.owner, 'alice');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('新的正文', '本地编辑'));
  assert.equal(rebooted.read('公共角色').owner, 'alice'); assert.equal(rebooted.read('公共角色').prompt, '本地编辑');
  rebooted.delete('公共角色', 'alice'); assert.equal(fs.existsSync(file), false);
  write('本地模板', 'public local');
  assert.throws(() => presets.edit('本地模板', 'overwrite', 'alice'), /本地创建/);
  assert.throws(() => presets.delete('本地模板', 'alice'), /本地创建/);
  assert.equal(presets.read('本地模板').prompt, 'public local');
});

test('failed writes, invalid bodies and malformed metadata preserve public presets and their creators', t => {
  const { presets, write } = fixture(t);
  for (const name of ['create', 'edit', 'delete', 'list', 'show name', 'create name', '--page 2 role', '../outside'])
    assert.throws(() => presets.create(name, 'body', 'alice'), /预设名称/);
  for (const body of ['', '\n ', 'a'.repeat(MAX_PRESET_CHARS + 1), 'a\x00b'])
    assert.throws(() => presets.create('invalid', body, 'alice'), /非空文本/);
  assert.deepEqual(presets.list(), []);
  presets.create('role', 'original', 'alice'); const file = path.join(presets.dir, 'role.md');
  const original = fs.readFileSync(file);
  assert.throws(() => presets.edit('role', '', 'alice'), /非空文本/);
  const rename = t.mock.method(fs, 'renameSync', () => { throw Error('disk full'); });
  assert.throws(() => presets.edit('role', 'new body', 'alice'), /disk full/);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(presets.dir), ['role.md']); rename.mock.restore();
  const writeFile = t.mock.method(fs, 'writeFileSync', () => { throw Error('disk full'); });
  assert.throws(() => presets.create('failed', 'new body', 'alice'), /disk full/);
  assert.equal(fs.existsSync(path.join(presets.dir, 'failed.md')), false); writeFile.mock.restore();
  write('invalid', '<!-- koishi-preset {"version":1,"owner":null} -->\nbody');
  assert.throws(() => presets.read('invalid'), /创建者信息无效/);
  assert.throws(() => presets.edit('invalid', 'claim', 'alice'), /创建者信息无效/);
  assert.throws(() => presets.delete('invalid', 'alice'), /创建者信息无效/);
});

test('creator can repair an empty locally edited body while forged body headers cannot transfer ownership', t => {
  const { presets } = fixture(t);
  presets.create('role', 'body', 'alice');
  const file = path.join(presets.dir, 'role.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n')[0] + '\n');
  assert.throws(() => presets.read('role'), /非空/);
  presets.edit('role', '<!-- koishi-preset {"version":1,"owner":"bob"} -->\nbody', 'alice');
  assert.equal(presets.read('role').owner, 'alice');
  assert.throws(() => presets.delete('role', 'bob'), /只有创建者/);
});
