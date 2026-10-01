const { test } = require('node:test');
const assert = require('node:assert/strict');
const { failureInfo, safeReason, textMessage } = require('../../src/lib/feedback.cjs');

test('a model refusal is never classified as a failure', () => {
  // 「抱歉，我不能…」在通用桥接里就是它该给的回复，会被原样回传给用户。
  // 归类成 refused / tool_unavailable 就等于把用户真正想看的内容丢掉。
  for (const reply of ['抱歉，我不能生成这类图片。', '图像生成工具不可用。', '我不能帮你做这个。'])
    assert.equal(failureInfo({ technical: reply }).code, 'execution_failed', reply);
  assert.equal(failureInfo({ reply: '抱歉，我不能生成这类图片。' }).code, 'execution_failed');
});
test('technical problems keep distinct codes', () => {
  assert.equal(failureInfo({ technical: 'network connection reset' }).code, 'network');
  assert.equal(failureInfo({ technical: '读取不到回复内容' }).code, 'reply_unreadable');
  assert.equal(failureInfo({ technical: '页面加载超时' }).code, 'browser_interaction');
  assert.equal(failureInfo({ technical: 'boom' }).code, 'execution_failed');
});
test('authentication errors are distinguished from rate limits', () => {
  assert.equal(failureInfo({ technical: 'unexpected status 401 Unauthorized: Missing bearer' }).code, 'authentication');
  assert.match(failureInfo({ technical: 'unexpected status 401 Unauthorized: Missing bearer' }).message, /登录认证失败/);
  assert.equal(failureInfo({ technical: '429 rate_limit_exceeded' }).code, 'rate_limit');
  assert.match(failureInfo({ technical: '429 rate_limit_exceeded' }).message, /额度或速率/);
});
test('diagnostics are backend neutral and never claim a local CLI', () => {
  // The only backend is the ChatGPT web page, so user-facing text must not
  // mention Codex or any other local executable.
  for (const info of [
    failureInfo({ technical: '抱歉，我不能生成这类图片。' }),
    failureInfo({ technical: '图像生成工具不可用。' }),
    failureInfo({ technical: '读取不到回复内容' }),
    failureInfo({ technical: 'network connection reset' }),
    failureInfo({ technical: 'unexpected status 401 Unauthorized' }),
    failureInfo({ technical: 'boom' }),
  ]) assert.ok(!/codex/i.test(info.message), info.message);
});
test('feedback removes credentials and paths and escapes QQ message elements', () => {
  const text = safeReason('Bearer abc123 /Users/person/private.png https://example.com/?token=123 access_token=SECRET sk-abc123');
  for (const secret of ['abc123', '/Users/person', 'https://example', 'SECRET']) assert.ok(!text.includes(secret));
  assert.equal(textMessage('<img src="file:///private/a"/> & <at id="all"/>'), '&lt;img src="file:///private/a"/&gt; &amp; &lt;at id="all"/&gt;');
});
test('local paths are masked on Windows hosts too, not only POSIX', () => {
  // A model reply or technical error can echo the job directory back to the
  // user; those messages are delivered to QQ.
  const drive = safeReason('无法读取 D:\\Projects\\Koishi\\koishi-codex-image-bridge\\data\\jobs\\8e6eb22e5257\\input-0.png');
  assert.ok(!drive.includes('Projects') && !drive.includes('8e6eb22e5257'), drive);
  assert.equal(drive, '无法读取 [本机路径]');
  const home = safeReason('C:\\Users\\Mlnik\\AppData\\Roaming\\Koishi\\koishi.yml 不存在');
  assert.ok(!home.includes('Mlnik') && !home.includes('koishi.yml'), home);
  const forward = safeReason('D:/Projects/Koishi/a.png 也不该出现');
  assert.ok(!forward.includes('Projects'), forward);
  const unc = safeReason('\\\\fileserver\\share\\secret\\a.txt 访问失败');
  assert.ok(!unc.includes('fileserver'), unc);
  assert.equal(safeReason('/Users/mlnikko/Projects/Other/a.png'), '[本机路径]');
  assert.equal(safeReason('/home/person/secret.png'), '[本机路径]');
  // Ordinary text and already-masked URLs must survive untouched.
  assert.equal(safeReason('图片生成失败，请稍后重试'), '图片生成失败，请稍后重试');
  assert.equal(safeReason('https://chatgpt.com/c/abc'), '[服务地址]');
});
