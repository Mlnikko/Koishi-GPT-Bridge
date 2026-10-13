const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson, writeAtomic } = require('../../src/lib/state.cjs');

test('failed JSON publication preserves the target and cleans staging files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-'));
  const file = path.join(dir, 'state.json');
  writeJson(file, { old: true });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => writeJson(file, cyclic));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { old: true });
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const directory = path.join(dir, 'existing'); fs.mkdirSync(directory);
  assert.throws(() => writeJson(directory, {}));
  assert.equal(fs.statSync(directory).isDirectory(), true);
  assert.equal(fs.existsSync(directory + '.tmp'), false);
});

test('text and binary publication preserve the old bytes and remove all staging files on failure',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-atomic-')),file=path.join(dir,'media.gif');
 const bytes=require('../helpers/media.cjs').animatedGif();writeAtomic(file,bytes);
 t.mock.method(fs,'renameSync',()=>{throw Error('disk full');});
 assert.throws(()=>writeAtomic(file,'replacement'),/disk full/);
 assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(fs.readdirSync(dir),['media.gif']);
});
