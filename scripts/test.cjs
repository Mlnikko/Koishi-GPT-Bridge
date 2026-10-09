'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Pass concrete paths to Node so shell glob rules and Node versions do not
// determine which tests run. No shell and no project dependency are required.
function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.name.endsWith('.test.cjs') ? [file] : [];
  }).sort();
}

if (require.main === module) {
  const files = testFiles(path.join(__dirname, '..', 'test'));
  if (!files.length) throw Error('没有发现测试文件');
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

module.exports = { testFiles };
