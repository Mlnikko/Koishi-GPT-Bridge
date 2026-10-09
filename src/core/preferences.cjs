'use strict';
const fs = require('node:fs');
const { writeJson } = require('../lib/state.cjs');

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
    writeJson(this.file, values);
    this.values = values;
  }
}
module.exports = { Preferences };
