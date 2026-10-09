'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Publish a complete JSON snapshot, or leave the previous snapshot intact.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

module.exports = { writeJson };
