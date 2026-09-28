'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
class Conversations {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { items: [], current: {} };
  }
  key(owner, chat) { return JSON.stringify([owner, chat]); }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  list(owner, chat) { return this.data.items.filter(s => s.owner === owner && s.chat === chat && !s.closed); }
  get(id, owner, chat) { return this.list(owner, chat).find(s => s.id === id); }
  current(owner, chat) { return this.get(this.data.current[this.key(owner, chat)], owner, chat); }
  name(name) {
    name = name?.trim() || '未命名会话';
    if (name.length > 40) throw Error('会话名称最多 40 字');
    return name;
  }
  create(owner, chat, name) {
    if (this.list(owner, chat).length >= 20) throw Error('最多保留 20 个打开的会话，请先关闭不需要的会话');
    const s = { id: randomUUID().replaceAll('-', '').slice(0, 8), owner, chat, name: this.name(name), createdAt: Date.now() };
    this.data.items.push(s); this.data.current[this.key(owner, chat)] = s.id; this.save(); return s;
  }
  select(id, owner, chat) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的画图会话');
    this.data.current[this.key(owner, chat)] = s.id; this.save(); return s;
  }
  rename(id, owner, chat, name) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的画图会话');
    if (!name?.trim()) throw Error('请输入新名称');
    s.name = this.name(name); this.save(); return s;
  }
  close(id, owner, chat) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的画图会话');
    s.closed = true;
    if (this.current(owner, chat)?.id === id || this.data.current[this.key(owner, chat)] === id) delete this.data.current[this.key(owner, chat)];
    this.save(); return s;
  }
  leave(owner, chat) { delete this.data.current[this.key(owner, chat)]; this.save(); }
  bindWeb(s, threadId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(threadId)) throw Error('无效的 ChatGPT 会话编号');
    if (s.webThreadId && s.webThreadId !== threadId) throw Error('ChatGPT 会话编号发生变化');
    s.webThreadId = threadId; this.save();
  }
}
module.exports = { Conversations };
