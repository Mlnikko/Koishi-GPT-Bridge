'use strict';
const { Schema } = require('koishi');

const integer = (min, max = Number.MAX_SAFE_INTEGER) => Schema.number().min(min).max(max).step(1);

const Config = Schema.intersect([
  Schema.object({
    allowedUsers: Schema.array(Schema.string().pattern(/\S/)).min(1).required()
      .description('允许私聊调用的 QQ openid。填写 * 表示允许所有私聊用户。'),
    groupChat: Schema.boolean().default(false)
      .description('响应群成员 @ 机器人的消息。开启后群内任何成员均可使用，不受私聊白名单限制。'),
    notifyProgress: Schema.boolean().default(true).description('默认发送任务进度；用户可通过 /logs 单独设置。'),
  }).description('使用权限与通知'),
  Schema.object({
    dataDir: Schema.string().description('数据目录，可留空。新安装默认使用 Koishi 实例的 data/codex-image-local；相对路径从实例目录解析。'),
    skillsDir: Schema.string().description('外部技能库，可留空。指定时目录须已存在，仅读取 SKILL.md；相对路径从实例目录解析。'),
    retentionDays: integer(0).default(0).description('已结束任务保留天数；0 表示永久保留。会话历史另行保存。'),
  }).description('本机数据'),
  Schema.object({
    webBridgePort: integer(0, 65535).default(5141).description('浏览器桥接端口。只监听 127.0.0.1，须与扩展配置一致；0 为系统分配，先启动实例再生成扩展。'),
    replyTimeoutMs: integer(1, 2147483647).default(300000).description('模型回复超时（毫秒）；QQ 回复窗口仍会限制实际等待时间。'),
  }).description('ChatGPT 网页桥接'),
  Schema.object({
    lmStudioBaseUrl: Schema.string().default('http://127.0.0.1:1234/v1').description('LM Studio 本机 HTTP 服务，只接受回环地址和 /v1 路径。'),
    lmStudioApiKey: Schema.string().role('secret').description('LM Studio 认证令牌；未启用认证时留空。'),
    lmStudioModel: Schema.string().description('默认模型编号；留空时可在 QQ 使用 /model 选择。'),
    lmStudioMaxTokens: integer(1, 32768).default(2048).description('单次回复最大 token 数。'),
    lmStudioHistoryTurns: integer(1, 100).default(20).description('最多保留多少轮问答。'),
    lmStudioHistoryChars: integer(1500, 256000).default(12000).description('历史、预设、技能和本次消息的字符预算。'),
    lmStudioHistoryImages: integer(1, 100).description('历史图片数量上限；留空时为 max(4, 单次图片上限)，不可小于单次上限。'),
    lmStudioHistoryImageBytes: integer(1).description('历史图片总字节上限；留空时为 max(20 MB, 单次图片总上限)。'),
  }).description('LM Studio 本地模型'),
  Schema.object({
    maxTextChars: integer(16).default(1500).description('单条输入文字及单段回复的字符上限。'),
    maxReplyChars: integer(1).default(6000).description('回传到 QQ 的回复文字总字符上限。'),
    maxInputImages: integer(1, 10).default(2).description('单条消息最多输入的图片数量。'),
    maxInputBytes: integer(1).default(10485760).description('单张输入图片最大字节数。'),
    sendTimeoutMs: integer(1, 2147483647).default(20000).description('单次 QQ 文字发送确认超时（毫秒）。'),
    mediaSendTimeoutMs: integer(1, 2147483647).description('QQ 媒体发送确认超时（毫秒）；留空时为 max(60000, 文字发送超时)。'),
  }).description('消息与传输限制'),
]);

module.exports = { Config };
