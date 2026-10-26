'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveDataDir } = require('../../src/core/data-paths.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, baseDir: path.join(root, 'instance'), packageRoot: path.join(root, 'package') };
}

test('fresh installs use the instance data directory without creating package state', t => {
  const input = fixture(t);
  assert.deepEqual(resolveDataDir(input), { dataDir: path.join(input.baseDir, 'data', 'codex-image-local'), legacy: false });
  assert.deepEqual(fs.readdirSync(input.root), []);
});

test('legacy state keeps its original path and token without copying or replacing files', t => {
  const input = fixture(t), legacy = path.join(input.packageRoot, 'data');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'web-bridge-token'), 'existing-machine-token');
  fs.writeFileSync(path.join(legacy, 'conversations.json'), '{"version":1}');
  const before = fs.readdirSync(legacy).map(file => [file, fs.readFileSync(path.join(legacy, file), 'utf8')]);
  assert.deepEqual(resolveDataDir(input), { dataDir: legacy, legacy: true });
  assert.deepEqual(fs.readdirSync(legacy).map(file => [file, fs.readFileSync(path.join(legacy, file), 'utf8')]), before);
  assert.equal(fs.existsSync(input.baseDir), false);
});

test('two populated roots require explicit selection and relative paths resolve from the instance', t => {
  const input = fixture(t), current = path.join(input.baseDir, 'data', 'codex-image-local'), legacy = path.join(input.packageRoot, 'data');
  for (const dir of [current, legacy]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'web-bridge-token'), dir);
  }
  assert.throws(() => resolveDataDir(input), /显式配置 dataDir/);
  assert.deepEqual(resolveDataDir({ ...input, dataDir: 'data/codex-image-local' }), { dataDir: current, legacy: false });
  assert.deepEqual(resolveDataDir({ ...input, dataDir: legacy }), { dataDir: legacy, legacy: false });
});

test('empty legacy folders and unrelated files do not redirect a new install', t => {
  const input = fixture(t), legacy = path.join(input.packageRoot, 'data');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, '.DS_Store'), 'unrelated');
  assert.equal(resolveDataDir(input).legacy, false);
  for (const dataDir of ['', '  ', {}, 'invalid\0path']) assert.throws(() => resolveDataDir({ ...input, dataDir }), /dataDir/);
});
