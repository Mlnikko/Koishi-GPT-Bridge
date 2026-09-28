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

function failureInfo({ technical = '', reply = '', noImage = false }) {
  // Technical errors and model replies have different meanings; do not infer quota
  // or policy from the absence of a file alone.
  let code, title;
  if (/401|unauthorized|authentication|not logged in/i.test(technical)) {
    code = 'authentication'; title = '生成服务登录认证失败，请检查登录状态';
  } else if (/rate.limit|quota|usage.limit|429/i.test(technical)) {
    code = 'rate_limit'; title = '生成服务额度或速率受限，请稍后重试';
  } else if (/content_policy|safety.*(?:reject|block)|moderation.*(?:reject|block)/i.test(technical)) {
    code = 'content_rejected'; title = '生成服务拒绝了本次内容';
  } else if (/ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|connection.*(?:closed|reset)|stream disconnected/i.test(technical)) {
    code = 'network'; title = '生成服务网络连接失败，未自动重新生成';
  } else if (noImage && /(?:工具|tool).{0,50}(?:不可用|未提供|unavailable|not available)|(?:没有|无法使用).{0,30}(?:生图|图像生成)工具/is.test(reply)) {
    code = 'tool_unavailable'; title = '生成服务的生图工具不可用';
  } else if (noImage && /(?:不能|无法|不允许|不支持).{0,70}(?:生成|绘制)|(?:cannot|can't|unable to).{0,50}(?:generate|create)|(?:抱歉|sorry).{0,60}(?:拒绝|不能|无法)/is.test(reply)) {
    code = 'refused'; title = '生成服务拒绝生成本次图片';
  } else {
    code = noImage ? 'no_image' : 'execution_failed';
    title = noImage ? '生成已结束，但没有可用图片；尚不能确定是内容限制' : '生成失败';
  }
  const reason = safeReason(reply || technical);
  return { code, message: title + (reason ? `\n${reply ? '模型回复' : '错误详情'}：${reason}` : '\n未返回明确原因，请检查本机任务记录。') };
}

function textMessage(value) {
  // Koishi parses strings as message elements. Never render model text as media,
  // mentions, or other executable message markup.
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

module.exports = { safeReason, failureInfo, textMessage };
