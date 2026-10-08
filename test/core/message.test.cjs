const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toSegments, submissionText, imagesOf, textOf, textLength, isEmpty } = require('../../src/core/message.cjs');

const text = value => ({ type: 'text', attrs: { content: value } });
const img = source => ({ type: 'img', attrs: { src: source } });
const at = id => ({ type: 'at', attrs: { id } });

test('text and images keep their original order', () => {
  const segments = toSegments([text('看看这张 '), img('http://a/1.png'), text('和这张'), img('http://a/2.png'), text(' 哪张更好')]);
  assert.deepEqual(segments, [
    { type: 'text', text: '看看这张' },
    { type: 'image', source: 'http://a/1.png' },
    { type: 'text', text: '和这张' },
    { type: 'image', source: 'http://a/2.png' },
    { type: 'text', text: '哪张更好' },
  ]);
  assert.equal(submissionText(segments), '看看这张\n和这张\n哪张更好');
  assert.deepEqual(imagesOf(segments).map(segment => segment.source), ['http://a/1.png', 'http://a/2.png']);
  assert.equal(textLength(segments), '看看这张和这张哪张更好'.length);
});

test('the leading bot mention is dropped so no QQ openid reaches the web page', () => {
  // The QQ adapter unshifts `at(selfId)` on every guild message; Koishi strips it the same way.
  const segments = toSegments([at('bot-openid'), text(' 帮我写一个快排 '), img('http://a/1.png')]);
  assert.deepEqual(segments, [
    { type: 'text', text: '帮我写一个快排' },
    { type: 'image', source: 'http://a/1.png' },
  ]);
  assert.ok(!JSON.stringify(segments).includes('bot-openid'));
});

test('mid-message mentions and non-text elements are skipped, not rendered as text', () => {
  const segments = toSegments([text('开头'), at('someone'), { type: 'face', attrs: { id: '1' } }, text('结尾')]);
  assert.deepEqual(segments, [{ type: 'text', text: '开头结尾' }]);
});

test('stray whitespace around each text run is trimmed', () => {
  const segments = toSegments([text('  开头 '), img('http://a/1.png'), text(' 结尾  ')]);
  assert.deepEqual(segments, [
    { type: 'text', text: '开头' },
    { type: 'image', source: 'http://a/1.png' },
    { type: 'text', text: '结尾' },
  ]);
});

test('pasted code keeps its indentation, including on the first line', () => {
  // Trimming across newlines would turn `    def f():` into `def f():` and break the snippet.
  const source = '\n    def f():\n        return 1\n';
  assert.deepEqual(toSegments([text(source)]), [{ type: 'text', text: '    def f():\n        return 1' }]);
});

test('adjacent text elements merge and inner whitespace survives untouched', () => {
  const code = 'def f():\n    return 1';
  const segments = toSegments([text('  '), text(code), text('  ')]);
  assert.deepEqual(segments, [{ type: 'text', text: code }]);
});

test('a pure image message has no text and is not empty', () => {
  const segments = toSegments([img('http://a/1.png')]);
  assert.deepEqual(segments, [{ type: 'image', source: 'http://a/1.png' }]);
  assert.equal(submissionText(segments), '');
  assert.equal(isEmpty(segments), false);
});

test('adapter spellings are accepted for both element kinds', () => {
  assert.deepEqual(toSegments([{ type: 'image', attrs: { url: 'http://a/2.png' } }]), [{ type: 'image', source: 'http://a/2.png' }]);
  assert.deepEqual(toSegments([{ type: 'img', attrs: { file: 'base64://AAA' } }]), [{ type: 'image', source: 'base64://AAA' }]);
});

test('an empty or unusable message produces no segments', () => {
  assert.deepEqual(toSegments([]), []);
  assert.deepEqual(toSegments(undefined), []);
  assert.deepEqual(toSegments([text('   ')]), []);
  assert.deepEqual(toSegments([at('bot')]), []);
  assert.deepEqual(toSegments([img('')]), []);
  assert.equal(isEmpty(toSegments([text('  ')])), true);
  assert.equal(textOf([]), '');
});

const { sessionSegments } = require('../../src/core/message.cjs');
test('quoted text is separated from the request without leaking sender identifiers or nested quotes', () => {
  const segments = sessionSegments({ elements: [text('解释这段')], quote: {
    id: 'secret-id', user: { id: 'secret-user' }, elements: [text('原文'), at('secret-user')],
    quote: { elements: [text('不应该读取的更早消息')] },
  } });
  assert.equal(submissionText(segments), '【引用消息】\n原文\n【引用消息结束】\n【本次消息】\n解释这段');
  assert.ok(!JSON.stringify(segments).includes('secret'));
});
test('quoted and current images keep attachment order with a visible boundary', () => {
  const segments = sessionSegments({ elements: [text('比较'), img('data:current')],
    event: { message: { quote: { elements: [img('data:quoted')] } } } });
  assert.deepEqual(imagesOf(segments).map(s => s.source), ['data:quoted', 'data:current']);
  assert.match(submissionText(segments), /前 1 张附件图片属于引用消息/);
});
test('inline quotes and plain quoted content are supported without recursive interpretation', () => {
  assert.match(submissionText(sessionSegments({ elements: [{ type: 'quote', children: [text('/logs off')] }, text('这是啥')] })), /\/logs off/);
  assert.match(submissionText(sessionSegments({ elements: [], quote: { content: '原文' } })), /原文/);
  assert.throws(() => sessionSegments({ elements: [text('解释')], quote: { id: 'only-id' } }), /无法读取被引用消息/);
  assert.throws(() => sessionSegments({ elements: [], quote: { elements: [{ type: 'file' }] } }), /无法读取被引用消息/);
  assert.deepEqual(sessionSegments({ elements: [text('普通消息')] }), toSegments([text('普通消息')]));
});
