'use strict';

function safeReason(value) {
  return String(value || '')
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[凭据已隐藏]')
    .replace(/((?:access_token|clientSecret|appSecret|password|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s<>]+/g, '[服务地址]')
    // Windows paths (drive, UNC and bare backslash runs) plus POSIX paths. The
    // negative lookbehind keeps `s://` inside an already-masked URL from matching
    // as a drive letter.
    .replace(/(?<![\w])(?:[A-Za-z]:[\\/]|\\\\)[^\s`"<>|]*/g, '[本机路径]')
    .replace(/(?:[A-Za-z0-9_.\-]+\\){1,}[A-Za-z0-9_.\-]*/g, '[本机路径]')
    .replace(/\/(?:Users|home|private|var|tmp)\/[^\s`"<>]+/g, '[本机路径]')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 700);
}

// 只归类技术失败。
//
// 模型的内容拒绝**不是**失败：在通用桥接里「抱歉，我不能帮你做这个」就是它该给的回复，
// 会原样回传给用户。把拒绝判成失败会把用户真正想看的内容丢掉，所以这里没有
// refused / tool_unavailable / content_rejected 这类判定，也没有「没有图片」这种推断。
function failureInfo({ technical = '' } = {}) {
  let code, title;
  if (/401|unauthorized|authentication|not logged in/i.test(technical)) {
    code = 'authentication'; title = 'ChatGPT 网页登录认证失败，请检查登录状态';
  } else if (/rate.limit|quota|usage.limit|429/i.test(technical)) {
    code = 'rate_limit'; title = 'ChatGPT 网页额度或速率受限，请稍后重试';
  } else if (/ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|connection.*(?:closed|reset)|stream disconnected/i.test(technical)) {
    code = 'network'; title = '网络连接失败，未自动重试';
  } else if (/页面加载|标签页|输入框|发送按钮|无法填写|提交状态|页面脚本|人工验证|参考图片|图片上传|无法附加/.test(technical)) {
    code = 'browser_interaction'; title = 'ChatGPT 网页操作未完成';
  } else if (/没有返回|内容为空|读取不到|无法读取回复|回复结构/.test(technical)) {
    code = 'reply_unreadable'; title = '网页已结束回答，但没有读到可回传的内容';
  } else {
    code = 'execution_failed'; title = '任务失败';
  }
  const reason = safeReason(technical);
  return { code, message: title + (reason ? `\n详情：${reason}` : '\n未返回明确原因，请检查本机任务记录。') };
}

function textMessage(value) {
  // Koishi parses strings as message elements. Never render model text as media,
  // mentions, or other executable message markup.
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

module.exports = { safeReason, failureInfo, textMessage };
