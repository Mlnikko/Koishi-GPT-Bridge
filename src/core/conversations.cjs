'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { writeJson } = require('../lib/state.cjs');
const { normalizeReasoning } = require('./reasoning.cjs');
const { presetName } = require('./presets.cjs');
const { promptName } = require('./image-prompts.cjs');
// 默认会话的名字。每条消息都自动落到一个持续会话里，所以「没有会话」不是一种
// 正常状态：`ensure` 会在第一次收到消息时就把这个会话建出来。
const DEFAULT_NAME = '默认会话';
class Conversations {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { items: [], current: {} };
  }
  key(owner, chat) { return JSON.stringify([owner, chat]); }
  save(data = this.data) { writeJson(this.file, data); }
  commit(mutate) {
    const next = structuredClone(this.data);
    const id = mutate(next);
    this.save(next);
    // Publish only after persistence succeeds. Preserve existing object identity
    // for active runners that hold a reference to their conversation.
    const existing = new Map(this.data.items.map(item => [item.id, item]));
    next.items = next.items.map(item => {
      const target = existing.get(item.id);
      if (!target) return item;
      for (const key of Object.keys(target)) if (!(key in item)) delete target[key];
      return Object.assign(target, item);
    });
    this.data = next;
    return next.items.find(item => item.id === id);
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
  create(owner, chat, name, { backend, model, preset, imagePrompt } = {}) {
    if (preset !== undefined) preset = presetName(preset);
    if (imagePrompt !== undefined) imagePrompt = promptName(imagePrompt);
    if (this.list(owner, chat).length >= 20) throw Error('最多保留 20 个打开的会话，请先用「/close 编号」关闭不需要的会话');
    const s = { id: randomUUID().replaceAll('-', '').slice(0, 8), owner, chat, name: this.name(name), createdAt: Date.now(),
      ...(backend === 'lmstudio' && model ? { backend, lmStudioModel: model } : {}),
      ...(preset ? { lmStudioPreset: preset } : {}),
      ...(imagePrompt ? { imagePrompt } : {}) };
    return this.commit(data => { data.items.push(s); data.current[this.key(owner, chat)] = s.id; return s.id; });
  }
  select(id, owner, chat) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的会话');
    return this.commit(data => { data.current[this.key(owner, chat)] = s.id; return s.id; });
  }
  rename(id, owner, chat, name) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的会话');
    if (!name?.trim()) throw Error('请输入新名称');
    name = this.name(name);
    return this.commit(data => { data.items.find(item => item.id === id).name = name; return id; });
  }
  setReasoning(id, owner, chat, value) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的会话');
    const level = normalizeReasoning(value);
    return this.commit(data => {
      const item = data.items.find(item => item.id === id);
      if (level === 'default') delete item.reasoningEffort;
      else item.reasoningEffort = level;
      return id;
    });
  }
  setPreset(id, owner, chat, value) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的会话');
    if (value !== undefined) value = presetName(value);
    return this.commit(data => {
      const item = data.items.find(item => item.id === id);
      if (value === undefined) delete item.lmStudioPreset;
      else item.lmStudioPreset = value;
      return id;
    });
  }
  setImagePrompt(id, owner, chat, value) {
    if (!this.get(id, owner, chat)) throw Error('未找到你的会话');
    if (value !== undefined) value = promptName(value);
    return this.commit(data => {
      const item = data.items.find(item => item.id === id);
      if (value === undefined) delete item.imagePrompt;
      else item.imagePrompt = value;
      return id;
    });
  }
  close(id, owner, chat) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的会话');
    const key = this.key(owner, chat);
    return this.commit(data => {
      data.items.find(item => item.id === id).closed = true;
      if (data.current[key] === id) delete data.current[key];
      return id;
    });
  }
  reopen(owner, chat, name) {
    name = this.name(name);
    const previous = this.current(owner, chat);
    if (!previous && this.list(owner, chat).length >= 20) throw Error('最多保留 20 个打开的会话，请先关闭不需要的会话');
    const s = { id: randomUUID().replaceAll('-', '').slice(0, 8), owner, chat, name, createdAt: Date.now() };
    return this.commit(data => {
      if (previous) data.items.find(item => item.id === previous.id).closed = true;
      data.items.push(s); data.current[this.key(owner, chat)] = s.id;
      return s.id;
    });
  }
  bindWeb(s, threadId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(threadId)) throw Error('无效的 ChatGPT 会话编号');
    if (s.webThreadId && s.webThreadId !== threadId) throw Error('ChatGPT 会话编号发生变化');
    if (s.webThreadId === threadId) return s;
    return this.commit(data => { data.items.find(item => item.id === s.id).webThreadId = threadId; return s.id; });
  }
  setBackend(s, backend, model) {
    if (!['web', 'lmstudio'].includes(backend)) throw Error('无效的对话后端');
    if (backend === 'lmstudio' && (typeof model !== 'string' || !model.trim())) throw Error('请选择本地聊天模型');
    return this.commit(data => {
      const item = data.items.find(item => item.id === s.id);
      if (backend === 'lmstudio') { item.backend = backend; item.lmStudioModel = model; }
      else delete item.backend;
      return s.id;
    });
  }
  // 网页侧的会话被删除或链接失效时解绑。持续会话意味着用户不会自己去换会话，
  // 所以这里必须能自愈，否则一个失效编号会把这个用户永久卡死。
  unbindWeb(s) {
    if (!s.webThreadId) return s;
    return this.commit(data => { delete data.items.find(item => item.id === s.id).webThreadId; return s.id; });
  }
}
module.exports = { Conversations, DEFAULT_NAME };
