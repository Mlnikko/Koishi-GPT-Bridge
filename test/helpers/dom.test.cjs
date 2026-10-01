const { test } = require('node:test');
const assert = require('node:assert/strict');
const { el, img, createDocument, matches } = require('./dom.cjs');

// 这份 DOM 桩是所有扩展测试的地基。它一旦悄悄失配，用到它的断言就会全部变成
// 空转 —— 测试还是绿的，但什么都没验证。所以它自己也要被测。

test('attribute operators work, including the case-insensitive flag', () => {
  const node = el('div', { 'data-testid': 'generated-image-gallery', class: 'markdown prose' });
  assert.equal(matches(node, '[data-testid="generated-image-gallery"]'), true);
  assert.equal(matches(node, '[data-testid^="generated-image"]'), true);
  assert.equal(matches(node, '[data-testid*="image"]'), true);
  assert.equal(matches(node, '[data-testid$="gallery"]'), true);
  assert.equal(matches(node, '[data-testid*="IMAGE" i]'), true);
  assert.equal(matches(node, '[data-testid*="IMAGE"]'), false);
  assert.equal(matches(node, 'div[class*="markdown"]'), true);
  assert.equal(matches(node, 'span[class*="markdown"]'), false);
});

test('a space inside an attribute selector does not split the chain', () => {
  // 这正是 [data-testid*="profile" i] 与 [data-testid*="generated-image" i] 的形状。
  const node = el('img', { 'data-testid': 'profile-button' });
  assert.equal(matches(node, '[data-testid*="profile" i]'), true);
  assert.equal(matches(node, '[data-testid*="generated-image" i]'), false);
});

test('descendant chains and comma groups both work', () => {
  const document = createDocument();
  const header = el('header');
  const avatar = img('https://chatgpt.com/avatar/me', { width: 512, height: 512 });
  header.appendChild(avatar);
  document.body.appendChild(header);
  const main = el('main');
  const turn = el('div', { 'data-testid': 'conversation-turn-1' });
  main.appendChild(turn);
  document.body.appendChild(main);
  assert.equal(matches(avatar, 'header img'), true);
  assert.equal(matches(avatar, 'main img'), false);
  // 扩展用的是 closest()：逐级向上找，所以图片自身不匹配 header 也没关系。
  assert.equal(avatar.closest('header, nav, aside, [data-testid*="profile" i]'), header);
  assert.equal(avatar.closest('nav, aside'), null);
  assert.equal(el('img', { 'data-testid': 'profile-button' }).closest('[data-testid*="profile" i]').getAttribute('data-testid'), 'profile-button');
});

test('presence, closest, contains and text extraction behave like the real DOM', () => {
  const document = createDocument();
  const turn = el('div', { 'data-testid': 'conversation-turn-1' });
  const bubble = el('div', { 'data-user-message-bubble': '' }, ['看看这个']);
  turn.appendChild(bubble);
  document.body.appendChild(turn);
  assert.equal(matches(bubble, '[data-user-message-bubble]'), true);
  assert.equal(bubble.closest('[data-testid^="conversation-turn"]'), turn);
  assert.equal(turn.contains(bubble), true);
  assert.equal(bubble.contains(turn), false);
  const paragraph = el('p', {}, ['普通段落，含 ', el('code', {}, ['inline']), ' 结尾']);
  assert.equal(paragraph.textContent, '普通段落，含 inline 结尾');
  assert.equal(paragraph.querySelectorAll('code').length, 1);
});
