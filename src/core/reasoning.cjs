'use strict';

const REASONING_LEVELS = ['default', 'instant', 'medium', 'high', 'xhigh', 'pro'];
const REASONING_USAGE = '/reasoning [default|instant|medium|high|xhigh|pro]';
const LABELS = { default: '跟随网页', instant: '即时', medium: '中', high: '高', xhigh: '超高', pro: 'Pro' };
const ALIASES = { '默认': 'default', '跟随网页': 'default', '即时': 'instant', '中': 'medium', '标准': 'medium',
  standard: 'medium', '高': 'high', '扩展': 'high', extended: 'high', '超高': 'xhigh', heavy: 'xhigh' };
function normalizeReasoning(value) {
  const text = String(value || '').trim().toLowerCase();
  const level = ALIASES[text] || text;
  if (!REASONING_LEVELS.includes(level)) throw Error('用法：' + REASONING_USAGE);
  return level;
}
const reasoningLabel = level => LABELS[level || 'default'];
module.exports = { REASONING_LEVELS, REASONING_USAGE, normalizeReasoning, reasoningLabel };
