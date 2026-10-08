'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// 默认会话的名字。每条消息都自动落到一个持续会话里，所以「没有会话」不是一种
// 正常状态：`ensure` 会在第一次收到消息时就把这个会话建出来。
const DEFAULT_NAME = '默认会话';
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
    name = name?.trim() || DEFAULT_NAME;
    if (name.length > 40) throw Error('会话名称最多 40 字');
    return name;
  }
  // 每个 (用户, 聊天) 默认就有一个持续会话：这是「同一个用户始终在同一个网页
  // 会话里」的落点。第一次收到消息时按需建出来，之后一直复用，所以改图这类
  // 「接着上一张继续说」的用法不需要任何命令。
  ensure(owner, chat, name) { return this.current(owner, chat) || this.create(owner, chat, name); }
  create(owner, chat, name) {
    if (this.list(owner, chat).length >= 20) throw Error('最多保留 20 个打开的会话，请先用「桥接关闭会话 <编号>」关闭不需要的会话');
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
    const key = this.key(owner, chat);
    if (this.data.current[key] === id) delete this.data.current[key];
    this.save(); return s;
  }
  bindWeb(s, threadId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(threadId)) throw Error('无效的 ChatGPT 会话编号');
    if (s.webThreadId && s.webThreadId !== threadId) throw Error('ChatGPT 会话编号发生变化');
    s.webThreadId = threadId; this.save();
  }
  // 网页侧的会话被删除或链接失效时解绑。持续会话意味着用户不会自己去换会话，
  // 所以这里必须能自愈，否则一个失效编号会把这个用户永久卡死。
  unbindWeb(s) {
    if (!s.webThreadId) return s;
    delete s.webThreadId; this.save(); return s;
  }
}
module.exports = { Conversations, DEFAULT_NAME };
