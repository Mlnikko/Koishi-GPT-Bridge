'use strict';

// 网页回复片段 → QQ 消息。
//
// 纯函数，不碰文件系统、不发网络请求：片段校验、Markdown 结构还原、按长度拆分
// 都在这里完成，调用方只负责把结果换成 Koishi 消息元素并把图片字节读出来。
//
// 片段类型：
//   { type: 'text',  text }                正文，保留 Markdown 结构
//   { type: 'code',  language, text }      代码块，单独成段
//   { type: 'image', asset, mime }         回复中的第 asset 张图（先经 /result-asset 上传）

const LIMITS = {
  maxSegments: 200,
  maxSegmentChars: 64 * 1024,
  maxTotalChars: 256 * 1024,
  maxImages: 10,
};

const TRUNCATED_NOTICE = '（回复过长，以上为前一部分；完整内容保留在本机任务记录中，可用「桥接重发」重新获取。）';

function replyError(code, message) { return Object.assign(new Error(message), { code }); }

const FENCE = /^\s*(?:```|~~~)/;

// 网页侧只允许这三种片段；其余一律拒收，宁可整条失败也不落盘半截回复。
function validateSegments(input, { uploaded = 0 } = {}) {
  if (!Array.isArray(input) || !input.length) throw replyError('empty_reply', '网页没有返回可用的回复内容');
  if (input.length > LIMITS.maxSegments) throw replyError('reply_too_large', '网页回复的结构过于复杂，已拒绝');
  const segments = [];
  let total = 0, images = 0;
  for (const raw of input) {
    if (raw?.type === 'image') {
      const asset = Number(raw.asset);
      if (!Number.isInteger(asset) || asset < 0 || asset >= uploaded)
        throw replyError('reply_invalid', `网页回复引用了未上传的图片（${String(raw.asset).slice(0, 12)}）`);
      if (++images > LIMITS.maxImages) throw replyError('reply_too_large', `网页回复中的图片超过 ${LIMITS.maxImages} 张`);
      segments.push({ type: 'image', asset, mime: typeof raw.mime === 'string' ? raw.mime.slice(0, 64) : 'image/png' });
      continue;
    }
    if (raw?.type !== 'text' && raw?.type !== 'code')
      throw replyError('reply_invalid', `无法识别的回复片段：${String(raw?.type).slice(0, 20)}`);
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (text.length > LIMITS.maxSegmentChars) throw replyError('reply_too_large', '网页回复的单个片段过大，已拒绝');
    total += text.length;
    if (total > LIMITS.maxTotalChars) throw replyError('reply_too_large', '网页回复内容过大，已拒绝');
    segments.push(raw.type === 'code'
      ? { type: 'code', language: String(raw.language || '').slice(0, 32), text }
      : { type: 'text', text });
  }
  if (!segments.some(segment => segment.type === 'image' || segment.text.trim()))
    throw replyError('empty_reply', '网页返回的回复内容为空');
  return segments;
}

// 代码块还原成围栏文本；语言名只保留安全字符，避免把模型输出拼成畸形标记。
function fenceCode(segment) {
  const language = String(segment.language || '').replace(/[^\w+#.-]/g, '').slice(0, 32);
  const body = String(segment.text ?? '').replace(/\n+$/, '');
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

// 完整回复文本（含代码围栏），用于 reply.md 与「桥接重发」。
function replyText(segments) {
  return (segments || [])
    .map(segment => segment.type === 'image' ? '' : segment.type === 'code' ? fenceCode(segment) : String(segment.text ?? ''))
    .filter(text => text.trim())
    .join('\n\n');
}

// 按长度拆分，优先在段落边界断开，绝不在代码块内部切断。
// 代码块本身超过上限时按行拆开，并在每块重复围栏，保证每块都是合法 Markdown。
function splitText(text, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 0);
  const value = String(text ?? '');
  if (!value) return [];
  if (value.length <= limit) return [value];

  const chunks = [];
  let current = [];
  let fence = '';
  const size = () => current.length ? current.join('\n').length : 0;
  const close = () => {
    if (!current.length) return;
    chunks.push((fence ? [...current, '```'] : current).join('\n'));
    current = fence ? [fence] : [];
  };

  for (const line of value.split('\n')) {
    const isFence = FENCE.test(line);
    // 段落边界优先：只在围栏外、且当前块已过半时才提前换块，避免把短回复切碎。
    if (!fence && !line.trim() && size() >= limit / 2) { close(); continue; }
    if (current.length && size() + line.length + 1 > limit) close();
    if (isFence) fence = fence ? '' : line.trim();
    current.push(line);
  }
  close();
  return chunks.filter(chunk => chunk.trim());
}

// 片段序列 → 有序 QQ 消息。
// 图片在序列中的位置即它在回复中的位置：文本批次与图片交替出现，顺序不乱。
function toMessages(segments, { maxChars = 1500, maxTotal = 6000 } = {}) {
  const messages = [];
  let budget = Math.max(0, Number(maxTotal) || 0);
  let truncated = false;
  let pending = [];

  const flush = () => {
    if (!pending.length) return;
    for (const chunk of splitText(pending.join('\n\n'), maxChars)) messages.push({ type: 'text', text: chunk });
    pending = [];
  };

  for (const segment of segments || []) {
    if (segment.type === 'image') { flush(); messages.push({ type: 'image', asset: segment.asset }); continue; }
    const text = segment.type === 'code' ? fenceCode(segment) : String(segment.text ?? '');
    if (!text.trim()) continue;
    if (budget <= 0) { truncated = true; continue; }
    if (text.length > budget) { pending.push(text.slice(0, budget)); budget = 0; truncated = true; continue; }
    budget -= text.length;
    pending.push(text);
  }
  flush();
  if (truncated) messages.push({ type: 'text', text: TRUNCATED_NOTICE });
  return { messages, truncated };
}

module.exports = { validateSegments, splitText, toMessages, replyText, fenceCode, LIMITS, TRUNCATED_NOTICE };
