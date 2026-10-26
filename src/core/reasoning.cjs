'use strict';

const REASONING_LEVELS = ['default', 'instant', 'medium', 'high', 'xhigh', 'pro'];
const REASONING_USAGE = '/reasoning [default|instant|medium|high|xhigh|pro]';
const WORK_REASONING_USAGE = '/reasoning [default|instant|pro|1–9]（档数以工作网页实际菜单为准；instant 最低档，pro 最高档）';
const LABELS = { default: '跟随网页', instant: '即时', medium: '中', high: '高', xhigh: '超高', pro: 'Pro' };
const ALIASES = { '默认': 'default', '跟随网页': 'default', '即时': 'instant', '中': 'medium', '标准': 'medium',
  standard: 'medium', '高': 'high', '扩展': 'high', extended: 'high', '超高': 'xhigh', heavy: 'xhigh' };
const reasoningUsage = mode => mode === 'work' ? WORK_REASONING_USAGE : REASONING_USAGE;
function normalizeReasoning(value, mode = 'chat') {
  const text = String(value || '').trim().toLowerCase();
  const tier = /^(?:tier-)?([1-9])$/.exec(text);
  if (mode === 'work' && tier) return 'tier-' + tier[1];
  const level = ALIASES[text] || text;
  if (!REASONING_LEVELS.includes(level)) throw Error('用法：' + reasoningUsage(mode));
  return level;
}
const reasoningLabel = (level, mode = 'chat') => /^tier-[1-9]$/.test(level || '') ? '第 ' + level.slice(5) + ' 档'
  : mode === 'work' && level === 'instant' ? '网页最低档'
  : mode === 'work' && level === 'pro' ? '网页最高档' : LABELS[level || 'default'];
module.exports = { REASONING_LEVELS, REASONING_USAGE, WORK_REASONING_USAGE, reasoningUsage, normalizeReasoning, reasoningLabel };
