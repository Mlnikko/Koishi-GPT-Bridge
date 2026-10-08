'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Notification preferences belong to a user in a chat, not a web conversation.
class Preferences {
  constructor(file, defaultEnabled = true) {
    this.file = file;
    this.defaultEnabled = defaultEnabled;
    this.values = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  enabled(owner, chat) {
    const value = this.values[JSON.stringify([owner, chat])];
    return typeof value === 'boolean' ? value : this.defaultEnabled;
  }
  set(owner, chat, enabled) {
    const values = { ...this.values, [JSON.stringify([owner, chat])]: enabled };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(values, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.values = values;
  }
}
module.exports = { Preferences };
