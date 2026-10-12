const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSegments, splitText, toMessages, replyText, TRUNCATED_NOTICE } = require('../../src/lib/reply.cjs');

test('total truncation keeps surrogate pairs intact and never appends later text', () => {
  const { messages, truncated } = toMessages([
    { type: 'text', text: 'a😀z' }, { type: 'image', asset: 0 }, { type: 'text', text: 'later' },
  ], { maxChars: 100, maxTotal: 2 });
  assert.equal(truncated, true);
  assert.equal(messages[0].text, 'a');
  assert.equal(messages[1].type, 'image');
  assert.ok(!messages.some(message => message.text === 'later'));
});

test('structured code containing fences uses a longer outer fence and truncates with closure', () => {
  const body = 'before\n```\ninside\n```\nafter';
  const full = replyText([{ type: 'code', language: 'md', text: body }]);
  assert.equal(full, '````md\n' + body + '\n````');
  const { messages, truncated } = toMessages([{ type: 'code', language: 'js', text: 'x'.repeat(100) }],
    { maxChars: 50, maxTotal: 24 });
  assert.equal(truncated, true);
  assert.match(messages[0].text, /^```js\n[\s\S]*\n```$/);
  assert.ok(messages[0].text.length <= 24);
});

test('long single lines and emoji fit the message limit without lost characters', () => {
  const value = '长'.repeat(99) + '😀'.repeat(80);
  const chunks = splitText(value, 100);
  assert.equal(chunks.join(''), value);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
  }
});

test('code chunks include fences in their size budget, including oversized lines', () => {
  for (const marker of ['```', '~~~']) {
    const chunks = splitText(marker + 'js\n' + 'x'.repeat(500) + '\n' + marker, 100);
    assert.ok(chunks.every(chunk => chunk.length <= 100));
    assert.ok(chunks.every(chunk => chunk.startsWith(marker + 'js\n') && chunk.endsWith('\n' + marker)));
    assert.equal(chunks.map(chunk => chunk.slice(marker.length + 3, -marker.length - 1)).join(''), 'x'.repeat(500));
  }
});

test('small message limits keep code blocks valid when the language or marker cannot fit', () => {
  const chunks = splitText('```javascript\n' + 'x'.repeat(60) + '\n```', 16);
  assert.ok(chunks.every(chunk => chunk.length <= 16 && /^```\n[\s\S]*\n```$/.test(chunk)));
  assert.equal(chunks.map(chunk => chunk.slice(4, -4)).join(''), 'x'.repeat(60));
  const marker = '`'.repeat(20);
  const tiny = splitText(marker + '\n' + 'y'.repeat(30) + '\n' + marker, 16);
  assert.ok(tiny.every(chunk => chunk.length <= 16 && chunk.startsWith('    ')));
  assert.equal(tiny.map(chunk => chunk.slice(4)).join(''), 'y'.repeat(30));
});

test('only text, code and image segments are accepted', () => {
  const segments = validateSegments([
    { type: 'text', text: '看这个：' },
    { type: 'code', language: 'js', text: 'const a = 1;' },
    { type: 'image', asset: 0 },
  ], { uploaded: 1 });
  assert.deepEqual(segments, [
    { type: 'text', text: '看这个：' },
    { type: 'code', language: 'js', text: 'const a = 1;' },
    { type: 'image', asset: 0, mime: 'image/png' },
  ]);
  assert.throws(() => validateSegments([{ type: 'at', attrs: { id: 'x' } }]), err => err.code === 'reply_invalid');
  assert.throws(() => validateSegments([{ type: 'text', text: 'ok' }, { type: 'script', text: 'evil' }]),
    err => err.code === 'reply_invalid');
});

test('a reply that references an image the page never uploaded is refused whole', () => {
  assert.throws(() => validateSegments([{ type: 'image', asset: 0 }], { uploaded: 0 }), err => err.code === 'reply_invalid');
  assert.throws(() => validateSegments([{ type: 'text', text: 'x' }, { type: 'image', asset: 3 }], { uploaded: 2 }),
    err => err.code === 'reply_invalid');
});

test('empty, whitespace-only and oversized replies are refused', () => {
  assert.throws(() => validateSegments([]), err => err.code === 'empty_reply');
  assert.throws(() => validateSegments([{ type: 'text', text: '   \n ' }]), err => err.code === 'empty_reply');
  assert.throws(() => validateSegments([{ type: 'text', text: 'x'.repeat(64 * 1024 + 1) }]), err => err.code === 'reply_too_large');
  assert.throws(() => validateSegments(Array.from({ length: 201 }, () => ({ type: 'text', text: 'a' }))),
    err => err.code === 'reply_too_large');
  assert.throws(() => validateSegments(Array.from({ length: 11 }, (_, i) => ({ type: 'image', asset: i })), { uploaded: 11 }),
    err => err.code === 'reply_too_large');
});

test('a short reply is left alone', () => {
  assert.deepEqual(splitText('只有一行', 100), ['只有一行']);
  assert.deepEqual(splitText('', 100), []);
  assert.deepEqual(splitText('不管多长都不拆', 0), ['不管多长都不拆']);
});

test('long text is split at paragraph boundaries', () => {
  const paragraph = '甲'.repeat(80);
  const chunks = splitText(`${paragraph}\n\n${paragraph}\n\n${paragraph}`, 100);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.equal(chunk, paragraph);
});

test('a code block is never cut in half', () => {
  const code = ['```js', ...Array.from({ length: 40 }, (_, i) => `const value${i} = ${i};`), '```'].join('\n');
  const chunks = splitText(code, 200);
  assert.ok(chunks.length > 1, '用例本身要足够长才会触发拆分');
  for (const chunk of chunks) {
    assert.match(chunk, /^```js\n/, '每一块都要重新打开围栏');
    assert.match(chunk, /\n```$/, '每一块都要闭合围栏');
  }
  // 拆开之后内容不丢：所有代码行都还在，且没有任何一行被截断。
  const lines = chunks.join('\n').split('\n').filter(line => line.startsWith('const value'));
  assert.equal(lines.length, 40);
});

test('text outside a code block is not given a fence', () => {
  const chunks = splitText(`${'乙'.repeat(90)}\n\n${'丙'.repeat(90)}`, 100);
  for (const chunk of chunks) assert.ok(!chunk.includes('```'));
});

test('image position in the reply is preserved', () => {
  const { messages } = toMessages([
    { type: 'text', text: '第一种写法：' },
    { type: 'code', language: 'js', text: 'const a = 1;' },
    { type: 'image', asset: 0 },
    { type: 'text', text: '第二种：' },
  ], { maxChars: 1000, maxTotal: 1000 });
  assert.deepEqual(messages, [
    { type: 'text', text: '第一种写法：\n\n```js\nconst a = 1;\n```' },
    { type: 'image', asset: 0 },
    { type: 'text', text: '第二种：' },
  ]);
});
test('animation MIME survives splitting and text truncation for QQ delivery',()=>{
 const {messages}=toMessages([
  {type:'text',text:'x'.repeat(30)},{type:'image',asset:0,mime:'image/gif'},
  {type:'image',asset:1,mime:'image/png'},
 ],{maxTotal:5});
 assert.deepEqual(messages.slice(1,3),[{type:'image',asset:0,mime:'image/gif'},{type:'image',asset:1}]);
});

test('a reply over the total budget is truncated with a visible notice', () => {
  const { messages, truncated } = toMessages([{ type: 'text', text: '丁'.repeat(100) }], { maxChars: 1000, maxTotal: 10 });
  assert.equal(truncated, true);
  assert.equal(messages[0].text, '丁'.repeat(10));
  assert.equal(messages.at(-1).text, TRUNCATED_NOTICE);
});

test('replyText keeps code fences for the on-disk copy', () => {
  const text = replyText([
    { type: 'text', text: '示例：' },
    { type: 'code', language: 'python', text: 'print(1)' },
    { type: 'image', asset: 0 },
  ]);
  assert.equal(text, '示例：\n\n```python\nprint(1)\n```');
});
