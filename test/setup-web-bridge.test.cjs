'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { setup } = require('../scripts/setup-web-bridge.cjs');
const { WebBridge } = require('../src/bridge/web-bridge.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, '项目 with spaces');
  fs.mkdirSync(path.join(projectRoot, 'browser-extension'), { recursive: true });
  return { root, projectRoot };
}
function readConfig(target) {
  return vm.runInNewContext(fs.readFileSync(target, 'utf8') + '\nJSON.stringify(BRIDGE)');
}

test('setup reuses the default local token and writes loadable config in paths with spaces', t => {
  const { projectRoot } = fixture(t);
  const first = setup({ projectRoot });
  const config = JSON.parse(readConfig(first.target));
  assert.equal(config.url, 'http://127.0.0.1:5141');
  assert.match(config.token, /^[a-f0-9]{64}$/);
  assert.equal(config.token, fs.readFileSync(first.tokenFile, 'utf8'));
  setup({ projectRoot });
  assert.equal(readConfig(first.target), JSON.stringify(config));
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.target).mode & 0o777, 0o600);
});

test('setup uses the actual relocated bridge token and custom port to authenticate over HTTP', async t => {
  const { root, projectRoot } = fixture(t);
  const dataDir = path.join(root, 'Koishi 数据 with spaces');
  const bridge = new WebBridge({ root: dataDir, port: 0 });
  await bridge.ready;
  try {
    const result = setup({ projectRoot, dataDir, port: bridge.port });
    const config = JSON.parse(readConfig(result.target));
    assert.equal(config.token, bridge.token);
    assert.equal(fs.existsSync(path.join(projectRoot, 'data')), false);
    const response = await fetch(config.url + '/state', { headers: { 'x-bridge-token': config.token } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).job, null);
  } finally { await bridge.close(); }
});

test('invalid setup ports fail before creating files instead of silently reverting to 5141', t => {
  const { projectRoot } = fixture(t);
  for (const port of [0, -1, 65536, 5141.5, 'invalid', ''])
    assert.throws(() => setup({ projectRoot, port }), /端口/);
  assert.equal(fs.existsSync(path.join(projectRoot, 'data')), false);
  assert.equal(fs.existsSync(path.join(projectRoot, 'browser-extension', 'config.js')), false);
});
