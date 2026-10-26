'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const plugin = require('../src/index.cjs');
const { normalizeConfig } = require('../src/core/config.cjs');
const { install } = require('../scripts/install-browser-extension.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'package');
  fs.cpSync(path.join(__dirname, '..', 'browser-extension'), path.join(projectRoot, 'browser-extension'), {
    recursive: true, filter: file => path.basename(file) !== 'config.js',
  });
  // A local config must never be copied into another instance's extension.
  fs.writeFileSync(path.join(projectRoot, 'browser-extension', 'config.js'), 'LOCAL_SOURCE_SECRET');
  return { projectRoot, instanceDir: path.join(root, 'Koishi 实例 with spaces'), root };
}

test('Koishi schema requires a deliberate private allowlist and preserves dynamic limit defaults', () => {
  for (const allowedUsers of [undefined, [], [''], ['  ']]) assert.throws(() => plugin.Config({ allowedUsers }));
  const config = normalizeConfig(plugin.Config({ allowedUsers: ['alice'], maxInputImages: 6, sendTimeoutMs: 90000 }), '/tmp/bridge');
  assert.equal(config.groupChat, false);
  assert.equal(config.notifyProgress, true);
  assert.equal(config.lmStudioHistoryImages, 6);
  assert.equal(config.lmStudioHistoryImageBytes, 60 * 1024 * 1024);
  assert.equal(config.mediaSendTimeoutMs, 90000);
});

test('configured relative data and skill paths use the Koishi instance, independent of the shell cwd', () => {
  const base = path.resolve(os.tmpdir(), 'Koishi instance');
  const config = normalizeConfig({ allowedUsers: ['alice'], dataDir: 'custom-data', skillsDir: 'shared-skills' }, base, base);
  assert.equal(config.dataDir, path.join(base, 'custom-data'));
  assert.equal(config.skillsDir, path.join(base, 'shared-skills'));
});

test('extension export is complete, isolated from source credentials and repeatable with the same token', t => {
  const input = fixture(t);
  const first = install(input);
  const readConfig = () => JSON.parse(vm.runInNewContext(fs.readFileSync(path.join(first.outputDir, 'config.js'), 'utf8') + '\nJSON.stringify(BRIDGE)'));
  const config = readConfig();
  assert.match(config.token, /^[a-f0-9]{64}$/);
  assert.equal(config.token, fs.readFileSync(path.join(first.dataDir, 'web-bridge-token'), 'utf8'));
  assert.equal(first.dataDir, path.join(input.instanceDir, 'data', plugin.name));
  const manifest = JSON.parse(fs.readFileSync(path.join(first.outputDir, 'manifest.json')));
  for (const file of [manifest.background.service_worker, manifest.action.default_popup, 'bridge-client.js', 'page.js', 'popup.js'])
    assert.equal(fs.existsSync(path.join(first.outputDir, file)), true);
  fs.writeFileSync(path.join(first.dataDir, 'web-bridge-port'), '55123');
  install(input);
  assert.deepEqual(readConfig(), { token: config.token, url: 'http://127.0.0.1:55123' });
  assert.equal(fs.readFileSync(path.join(input.projectRoot, 'browser-extension', 'config.js'), 'utf8'), 'LOCAL_SOURCE_SECRET');
  assert.equal(fs.existsSync(path.join(input.projectRoot, 'data')), false);
});

test('export refuses invalid ports and existing unrelated output without creating tokens', t => {
  const input = fixture(t), outputDir = path.join(input.root, 'unrelated');
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'keep');
  assert.throws(() => install({ ...input, outputDir }), /不会覆盖/);
  assert.equal(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf8'), 'keep');
  assert.throws(() => install({ ...input, port: 0 }), /端口/);
  assert.throws(() => install({ ...input, outputDir: path.join(input.projectRoot, 'browser-extension') }), /插件包目录之外/);
  assert.equal(fs.existsSync(input.instanceDir), false);
});

test('a failed extension copy keeps the existing generated extension and token unchanged', t => {
  const input = fixture(t), first = install(input);
  const before = fs.readFileSync(path.join(first.outputDir, 'config.js'));
  fs.unlinkSync(path.join(input.projectRoot, 'browser-extension', 'page.js'));
  assert.throws(() => install(input), /ENOENT/);
  assert.deepEqual(fs.readFileSync(path.join(first.outputDir, 'config.js')), before);
  assert.equal(fs.readdirSync(path.dirname(first.outputDir)).some(name => name.startsWith('.bridge-extension-')), false);
});
