'use strict';

// QQ 消息元素 → 有序片段。
//
// 只认识文本与图片两类元素，其余（at、quote、face、file、card、markdown…）一律跳过。
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

// QQ 适配器在群聊里会把「@机器人」补成首个 `at` 元素，Koishi 的 `stripped` 也会剥掉它。
// 这里做同样的事，否则 @ 会变成正文的一部分。
function trimLeadingMentions(elements) {
  const list = (elements || []).slice();
  while (list[0]?.type === 'at') list.shift();
  return list;
}

// 裁掉每段文字首尾多余的空白：先去掉行内的空格与制表符，再去掉整行空行。
// 刻意不跨越换行裁剪 —— 否则用户粘贴的代码第一行缩进会被吃掉。
const trimLead = value => value.replace(/^[ \t]+/, '').replace(/^\n+/, '');
const trimTail = value => value.replace(/[ \t]+$/, '').replace(/\n+$/, '');

function toSegments(elements) {
  const raw = [];
  for (const element of trimLeadingMentions(elements)) {
    if (element?.type === 'text') {
      const text = asText(element, TEXT_ATTRS);
      if (text) raw.push({ type: 'text', text });
      continue;
    }
    if (IMAGE_TYPES.has(element?.type)) {
      const source = asText(element, IMAGE_ATTRS);
      if (source) raw.push({ type: 'image', source });
    }
  }
  // 相邻文本元素合并，适配器把一条消息拆成多个 text 元素时不会多出分隔。
  const merged = [];
  for (const segment of raw) {
    const last = merged[merged.length - 1];
    if (segment.type === 'text' && last?.type === 'text') last.text += segment.text;
    else merged.push({ ...segment });
  }
  // 段内空格与换行原样保留 —— 用户贴的代码不能被动过。
  for (const segment of merged) if (segment.type === 'text') segment.text = trimTail(trimLead(segment.text));
  return merged.filter(segment => segment.type === 'image' || segment.text);
}

const isImage = segment => segment?.type === 'image';
const isText = segment => segment?.type === 'text';

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

module.exports = { toSegments, submissionText, imagesOf, textOf, textLength, isEmpty };
