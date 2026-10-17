'use strict';
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { writeJson, writeAtomic } = require('../lib/state.cjs');
const { normalizeReasoning } = require('./reasoning.cjs');
const { presetName } = require('./presets.cjs');
const { promptName } = require('./image-prompts.cjs');
const { skillName } = require('./skills.cjs');
const { normalizeMode, modeOf, contextOf } = require('./modes.cjs');

const DEFAULT_NAME = '默认会话';
const FORMAT_VERSION = 2;
const validThread = id => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '');

function migrateConversation(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || (source.contexts != null && (typeof source.contexts !== 'object' || Array.isArray(source.contexts))))
    throw Error('会话上下文格式无效');
  const s = structuredClone(source);
  s.mode = modeOf(source);
  s.contexts = structuredClone(source.contexts || {});
  for (const mode of ['chat', 'work', 'local']) {
    if (s.contexts[mode] != null && (typeof s.contexts[mode] !== 'object' || Array.isArray(s.contexts[mode])))
      throw Error('会话上下文格式无效');
    s.contexts[mode] ||= {};
  }
  if (!source.contexts) {
    if (source.webThreadId) s.contexts[source.skill ? 'work' : 'chat'].webThreadId = source.webThreadId;
    if (source.reasoningEffort) {
      s.contexts.chat.reasoningEffort = source.reasoningEffort;
      s.contexts.work.reasoningEffort = source.reasoningEffort;
    }
    if (source.skill) {
      s.contexts.work.skill = source.skill;
      s.contexts.local.skill = source.skill;
    }
    if (source.lmStudioModel) s.contexts.local.model = source.lmStudioModel;
    if (source.lmStudioPreset) s.contexts.local.preset = source.lmStudioPreset;
  }
  for (const key of ['backend', 'webThreadId', 'reasoningEffort', 'skill', 'lmStudioModel', 'lmStudioPreset']) delete s[key];
  return s;
}
function inheritedSettings(source) {
  const contexts = structuredClone(source?.contexts || {});
  for (const context of Object.values(contexts)) delete context.webThreadId;
  return { mode: source ? modeOf(source) : 'chat', contexts, imagePrompt: source?.imagePrompt };
}

class Conversations {
  constructor(file) {
    this.file = file;
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    const data = original === undefined ? { items: [], current: {} } : JSON.parse(original);
    if (!data || typeof data !== 'object') throw Error('会话数据格式无效');
    if (data.version != null && data.version > FORMAT_VERSION) throw Error('会话数据来自更新版本，未修改原文件');
    if (!Array.isArray(data.items) || !data.current || typeof data.current !== 'object' || Array.isArray(data.current)) throw Error('会话数据格式无效');
    if (original !== undefined && (data.version == null || data.version < FORMAT_VERSION)) {
      this.legacySource = original;
      this.backupFile = file + '.v1-' + createHash('sha256').update(original).digest('hex').slice(0, 12) + '.bak';
    }
    // Migrate in memory; only a successful atomic mutation writes the new format.
    this.data = { ...data, version: FORMAT_VERSION, items: data.items.map(migrateConversation) };
  }
  key(owner, chat) { return JSON.stringify([owner, chat]); }
  save(data = this.data) {
    if (this.legacySource !== undefined) {
      if (!fs.existsSync(this.backupFile)) writeAtomic(this.backupFile, this.legacySource);
      if (fs.readFileSync(this.backupFile, 'utf8') !== this.legacySource) throw Error('旧会话备份校验失败，未迁移原文件');
    }
    writeJson(this.file, data);
    this.legacySource = undefined;
  }
  commit(mutate) {
    const next = structuredClone(this.data);
    const id = mutate(next);
    this.save(next);
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
  ensure(owner, chat, name) { return this.current(owner, chat) || this.create(owner, chat, name); }
  create(owner, chat, name, options = {}) {
    if (this.list(owner, chat).length >= 20) throw Error('最多保留 20 个打开的会话，请先用「/close 编号」关闭不需要的会话');
    const settings = options.from ? inheritedSettings(options.from) : {
      mode: options.mode ? normalizeMode(options.mode) : modeOf(options), contexts: {}, imagePrompt: options.imagePrompt,
    };
    const contexts = settings.contexts;
    for (const mode of ['chat', 'work', 'local']) contexts[mode] ||= {};
    if (options.model) contexts.local.model = options.model;
    if (options.preset !== undefined) contexts.local.preset = presetName(options.preset);
    if (options.skill !== undefined) contexts[settings.mode === 'local' ? 'local' : 'work'].skill = skillName(options.skill);
    const imagePrompt = settings.imagePrompt === undefined ? undefined : promptName(settings.imagePrompt);
    const s = { id: randomUUID().replaceAll('-', '').slice(0, 8), owner, chat, name: this.name(name),
      createdAt: Date.now(), mode: settings.mode, contexts, ...(imagePrompt ? { imagePrompt } : {}) };
    return this.commit(data => { data.items.push(s); data.current[this.key(owner, chat)] = s.id; return s.id; });
  }
  select(id, owner, chat) {
    if (!this.get(id, owner, chat)) throw Error('未找到你的会话');
    return this.commit(data => { data.current[this.key(owner, chat)] = id; return id; });
  }
  rename(id, owner, chat, name) {
    if (!this.get(id, owner, chat)) throw Error('未找到你的会话');
    if (!name?.trim()) throw Error('请输入新名称');
    name = this.name(name);
    return this.commit(data => { data.items.find(item => item.id === id).name = name; return id; });
  }
  setMode(s, mode, model) {
    mode = normalizeMode(mode);
    if (mode === 'local' && !(model || contextOf(s, 'local').model)) throw Error('请选择本地聊天模型');
    return this.commit(data => {
      const item = data.items.find(item => item.id === s.id);
      if (!item || item.closed) throw Error('会话已关闭或不存在');
      item.mode = mode;
      if (mode === 'local' && model) item.contexts.local.model = model;
      return s.id;
    });
  }
  updateContext(id, owner, chat, mode, update) {
    if (!this.get(id, owner, chat)) throw Error('未找到你的会话');
    return this.commit(data => {
      const item = data.items.find(item => item.id === id);
      update(item.contexts[mode], item);
      return id;
    });
  }
  setReasoning(id, owner, chat, value) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的会话');
    if (modeOf(s) === 'local') throw Error('本地模型使用自己的推理设置');
    const level = normalizeReasoning(value);
    return this.updateContext(id, owner, chat, modeOf(s), context => {
      if (level === 'default') delete context.reasoningEffort;
      else context.reasoningEffort = level;
    });
  }
  setPreset(id, owner, chat, value) {
    if (value !== undefined) value = presetName(value);
    return this.updateContext(id, owner, chat, 'local', context => {
      if (value === undefined) delete context.preset; else context.preset = value;
    });
  }
  setImagePrompt(id, owner, chat, value) {
    if (!this.get(id, owner, chat)) throw Error('未找到你的会话');
    if (value !== undefined) value = promptName(value);
    return this.commit(data => {
      const item = data.items.find(item => item.id === id);
      if (value === undefined) delete item.imagePrompt; else item.imagePrompt = value;
      return id;
    });
  }
  setSkill(id, owner, chat, value) {
    const s = this.get(id, owner, chat); if (!s) throw Error('未找到你的会话');
    if (value !== undefined) value = skillName(value);
    const mode = modeOf(s) === 'local' ? 'local' : 'work';
    return this.updateContext(id, owner, chat, mode, (context, item) => {
      if (value === undefined) delete context.skill;
      else { context.skill = value; item.mode = mode; }
    });
  }
  close(id, owner, chat) {
    if (!this.get(id, owner, chat)) throw Error('未找到你的会话');
    const key = this.key(owner, chat);
    return this.commit(data => {
      data.items.find(item => item.id === id).closed = true;
      if (data.current[key] === id) delete data.current[key];
      return id;
    });
  }
  reopen(owner, chat, name) {
    const previous = this.current(owner, chat);
    name = this.name(name);
    if (!previous && this.list(owner, chat).length >= 20) throw Error('最多保留 20 个打开的会话，请先关闭不需要的会话');
    const s = { id: randomUUID().replaceAll('-', '').slice(0, 8), owner, chat, name, createdAt: Date.now(),
      mode: 'chat', contexts: { chat: {}, work: {}, local: {} } };
    return this.commit(data => {
      if (previous) data.items.find(item => item.id === previous.id).closed = true;
      data.items.push(s); data.current[this.key(owner, chat)] = s.id;
      return s.id;
    });
  }
  bindWeb(s, threadId, mode = modeOf(s)) {
    if (!['chat', 'work'].includes(mode) || !validThread(threadId)) throw Error('无效的 ChatGPT 会话编号');
    const current = contextOf(s, mode).webThreadId;
    if (contextOf(s, mode === 'chat' ? 'work' : 'chat').webThreadId === threadId) throw Error('聊天与工作不能绑定同一个网页会话');
    if (current && current !== threadId) throw Error('ChatGPT 会话编号发生变化');
    if (current === threadId) return s;
    return this.updateContext(s.id, s.owner, s.chat, mode, context => { context.webThreadId = threadId; });
  }
  unbindWeb(s, mode = modeOf(s)) {
    if (!contextOf(s, mode).webThreadId) return s;
    return this.updateContext(s.id, s.owner, s.chat, mode, context => { delete context.webThreadId; });
  }
  setBackend(s, backend, model) {
    if (!['web', 'lmstudio'].includes(backend)) throw Error('无效的对话后端');
    return this.setMode(s, backend === 'lmstudio' ? 'local' : contextOf(s, 'work').skill ? 'work' : 'chat', model);
  }
}
module.exports = { Conversations, DEFAULT_NAME, FORMAT_VERSION, migrateConversation, inheritedSettings };
