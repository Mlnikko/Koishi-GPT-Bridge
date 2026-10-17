'use strict';

// Product modes are independent from transports. Chat and Work share the web
// bridge, but never a webpage conversation or a selected skill.
const MODES = Object.freeze({
  chat: Object.freeze({ id: 'chat', label: '聊天', backend: 'web', webMode: 'chat', skills: false }),
  work: Object.freeze({ id: 'work', label: '工作', backend: 'web', webMode: 'work', skills: 'native' }),
  local: Object.freeze({ id: 'local', label: '本地模型', backend: 'lmstudio', skills: 'local' }),
});
const aliases = new Map([
  ['chat', 'chat'], ['聊天', 'chat'], ['work', 'work'], ['工作', 'work'],
  ['local', 'local'], ['本地', 'local'], ['本地模型', 'local'], ['lmstudio', 'local'],
]);
function normalizeMode(value) {
  const mode = aliases.get(String(value || '').trim().toLowerCase());
  if (!mode) throw Error('用法：/mode 聊天、/mode 工作 或 /mode 本地 [模型编号]');
  return mode;
}
function modeOf(record) {
  if (record?.mode !== undefined) {
    if (!Object.hasOwn(MODES, record.mode)) throw Error('未知的会话模式，请检查保存的数据');
    return record.mode;
  }
  return record?.backend === 'lmstudio' ? 'local' : record?.skill ? 'work' : 'chat';
}
const EMPTY = Object.freeze({});
function contextOf(record, mode = modeOf(record)) { return record?.contexts?.[mode] || EMPTY; }
const definitionOf = record => MODES[modeOf(record)];
const modeLabel = record => definitionOf(record).label;
const executionLabel = record => definitionOf(record).backend === 'web' ? 'ChatGPT 网页' : 'LM Studio';

module.exports = { MODES, normalizeMode, modeOf, contextOf, definitionOf, modeLabel, executionLabel };
