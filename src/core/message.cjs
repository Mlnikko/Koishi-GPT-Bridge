'use strict';

// QQ 消息元素 → 有序片段。
//
// toSegments 只认识文本与图片，其余元素跳过；sessionSegments 单独处理直接引用。
// 跳过是刻意的：
//   - `at` 元素带的是 QQ openid，转发到外部网页既无意义也是隐私泄漏；
//   - 表情、文件、卡片在 ChatGPT 网页里没有对应表达，硬转成文字只会失真。
//
// 顺序必须原样保留：片段序列就是「用户到底说了什么」的唯一真相。

const IMAGE_TYPES = new Set(['img', 'image']);
const IMAGE_ATTRS = ['src', 'url', 'file'];
const TEXT_ATTRS = ['content', 'text'];

const asText = (element, attrs) => {
  const bag = element?.attrs || {};
  for (const key of attrs) if (typeof bag[key] === 'string') return bag[key];
  return '';
};

// 裁掉每段文字首尾多余的空白：先去掉行内的空格与制表符，再去掉整行空行。
// 刻意不跨越换行裁剪 —— 否则用户粘贴的代码第一行缩进会被吃掉。
const trimLead = value => value.replace(/^[ \t]+/, '').replace(/^\n+/, '');
const trimTail = value => value.replace(/[ \t]+$/, '').replace(/\n+$/, '');

function toSegments(elements) {
  const merged = [];
  for (const element of elements || []) {
    if (element?.type === 'text') {
      const text = asText(element, TEXT_ATTRS);
      if (text) {
        // 适配器拆开的相邻文本直接合并；被跳过的元素不打断文本。
        const last = merged[merged.length - 1];
        if (last?.type === 'text') last.text += text;
        else merged.push({ type: 'text', text });
      }
      continue;
    }
    if (IMAGE_TYPES.has(element?.type)) {
      const source = asText(element, IMAGE_ATTRS);
      if (source) merged.push({ type: 'image', source });
    }
  }
  // 段内空格与换行原样保留 —— 用户贴的代码不能被动过。
  for (const segment of merged) if (segment.type === 'text') segment.text = trimTail(trimLead(segment.text));
  return merged.filter(segment => segment.type === 'image' || segment.text);
}

const isImage = segment => segment?.type === 'image';
const isText = segment => segment?.type === 'text';

// Read only the directly quoted message supplied by the adapter. Do not fetch
// arbitrary message IDs or recursively follow quotes into another conversation.
function sessionSegments(session) {
  const current = toSegments(session.elements);
  const inline = (session.elements || []).find(element => element?.type === 'quote');
  const quote = session.quote || session.event?.message?.quote || inline;
  if (!quote) return current;
  let quoted = toSegments(quote.elements || quote.children);
  if (!quoted.length && !quote.elements && !quote.children && typeof quote.content === 'string') {
    quoted = toSegments([{ type: 'text', attrs: { content: quote.content } }]);
  }
  if (!quoted.length) throw Error('无法读取被引用消息的文字或图片，请复制原文或重新发送原图后再试。');
  const imageCount = quoted.filter(isImage).length;
  return [
    { type: 'text', text: `【引用消息】${imageCount ? `（前 ${imageCount} 张附件图片属于引用消息）` : ''}` },
    ...quoted,
    { type: 'text', text: '【引用消息结束】' },
    ...(current.length ? [{ type: 'text', text: '【本次消息】' }, ...current] : []),
  ];
}

function textOf(segments) {
  return (segments || []).filter(isText).map(segment => segment.text).join('');
}

// 提交给网页的正文：文本片段按顺序用换行连接。
// ChatGPT 的输入框把图片当作附件，无法表达「图片夹在两句文字之间」，
// 所以这里只保证文字顺序与图片顺序各自不变。
function submissionText(segments) {
  return (segments || []).filter(isText).map(segment => segment.text).join('\n').trim();
}

function imagesOf(segments) {
  return (segments || []).filter(isImage);
}

// 文字长度上限按「用户实际输入的字符」计算，图片不计入。
function textLength(segments) {
  return textOf(segments).length;
}

function isEmpty(segments) {
  return !(segments || []).some(segment => isImage(segment) || (isText(segment) && segment.text.trim()));
}

module.exports = { toSegments, sessionSegments, submissionText, imagesOf, textOf, textLength, isEmpty };
