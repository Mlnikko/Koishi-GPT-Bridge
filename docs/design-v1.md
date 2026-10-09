# 通用 QQ ↔ ChatGPT 网页桥接器 · 第一版设计

> 本文保留第一版设计背景。2026-10-09 已将机器人命令精简为 8 个斜杠命令，当前用法以 [README 的管理命令](../README.md#管理命令) 为准。

状态：设计已定稿（三项关键决策已确认），未实施。

本文只描述第一版（V1）的范围与做法。现有代码为「QQ 生图插件」，V1 要把它改成
「把 QQ 消息原样送进已登录的 ChatGPT 网页，再把网页回复原样送回 QQ」的通用桥接器。

## 1. 目标与非目标

### 1.1 目标

1. QQ 私聊/群聊里的任意消息（文本、图片、图文混合）直接转发给 ChatGPT 网页会话。
2. 不总结、不改写、不二次加工，把 ChatGPT 的回复内容按结构送回 QQ。
3. 一个 QQ 会话绑定一个 ChatGPT 网页会话（thread），支持续聊。
4. 复用已经验证过的授权、队列、持久化、本机桥接与扩展基础设施。
5. 概念数量下降：删掉「生图意图」「语义分类」两套机制。

### 1.2 非目标（V1 明确不做）

- QQ 文件、语音、视频、合并转发、卡片、小程序消息。
- ChatGPT 的模型选择、系统提示词注入、联网/深度研究开关。
- 多浏览器账号、多标签页并行；V1 仍是单账号全局串行。
- 自动重试、断点续传、流式增量回传（只回传最终结果）。
- 承诺与 ChatGPT 服务端 Markdown 源文逐字节一致（见 3.4）。
- 图片在回复中的**精确插入位置**（见 3.4）。

## 2. 总体架构

分层规则不变（`lib` ← `core` ← `bridge` ← `index`），只替换领域模块。

| 模块 | V1 处置 |
| --- | --- |
| `src/lib/image.cjs` | 保留。下载安全、SSRF、嗅探、PNG 解析全部复用 |
| `src/lib/feedback.cjs` | 保留并瘦身。去掉生图专用文案与 `no_image` 判定 |
| `src/lib/reply.cjs` | **新增**。回复片段 → QQ 消息元素、分段、长度控制（纯函数） |
| `src/core/message.cjs` | **新增**。QQ 消息元素 → 有序片段（文本/图片） |
| `src/core/queue.cjs` | 改造。任务负载从 `prompt + inputImages` 改为 `segments` |
| `src/core/conversations.cjs` | 保留。`webThreadId` 语义不变 |
| `src/core/intent.cjs` | **删除** |
| `src/core/natural.cjs` | **删除** |
| `src/bridge/web-bridge.cjs` | 改造协议（见第 5 节），去掉 `kind: 'intent'` 分支 |
| `src/index.cjs` | 改造。一个兜底中间件 + 通用管理命令 |
| `browser-extension/` | 改造。去掉提示词包装，新增回复序列化 |

新增目录不需要，因此 `test/architecture.test.cjs` 的 `LAYERS` 表不用改；
但删除两个模块后，该测试的「无孤立模块」检查仍应通过。

## 3. 消息模型

### 3.1 入站片段（QQ → ChatGPT）

```js
// src/core/message.cjs
Segment =
  | { type: 'text',  text: string }
  | { type: 'image', file: string, mime: string, size: number }   // 落盘后的任务目录文件
```

由 `session.elements` **按原顺序**归一化。文本元素原样保留（不 trim 内部空白，仅去掉首尾空白）；
图片元素走现有的 `messageImages` + `downloadImage` 安全链路。

### 3.2 提交给网页的形式

ChatGPT 输入框把图片当作**附件**，不是正文的一部分。因此提交时：

- 正文 = 所有 `text` 片段按顺序用 `\n` 连接；
- 附件 = 所有 `image` 片段按顺序注入文件选择器。

**这是本设计最需要如实说明的损失**：图文混排中「图片在两句文字之间」这种位置关系，
在 ChatGPT 输入框里无法表达。V1 保证文字顺序与图片顺序各自不变，不保证二者交错的相对位置。

### 3.3 出站片段（ChatGPT → QQ）

```js
// 由扩展序列化，经桥接校验后落盘
Segment =
  | { type: 'text',  text: string }                       // Markdown 结构以纯文本保留
  | { type: 'code',  language: string, text: string }      // 单独成段，便于 QQ 侧加围栏
  | { type: 'image', asset: number, mime: string }         // 指向任务目录 result-<n>.png
```

`text` 片段保留 Markdown 结构（标题 `#`、列表 `-`、引用 `>`、表格用管道符、行内代码用反引号）。
`code` 单独成段，`language` 取自 `code` 元素的 `language-xxx` 类名，取不到则为空串。
`image` 片段在序列中的**位置**即图片在回复中的位置。

### 3.4 「原始回复」的准确含义

网页已经把 Markdown 渲染成 HTML，服务端原始字节流拿不到。V1 承诺的是：

- **内容等价**：不摘要、不改写、不丢弃段落、不改变代码内容。
- **结构可辨**：标题层级、列表、引用、代码语言、链接地址、图片顺序均保留。

V1 不承诺：与 ChatGPT 内部 Markdown 源文逐字节一致（HTML 反推必然有归一化差异，
例如空行数量、列表符号风格、表格对齐填充）。

### 3.5 长度与拆分

- 单条 QQ 文本消息长度上限用配置项 `maxTextChars` 控制，默认 1500（保守值，可按实测放宽）。
- 超出时**按段落边界**拆分，绝不切断代码块内部；代码块自身超限时按行拆分并重复围栏。
- 回复总量超过 `maxReplyChars`（默认 6000）时截断，并在末尾追加一行明确提示，
  同时把完整回复保留在任务目录 `reply.md`，可用管理命令重发。

## 4. 数据模型与落盘

### 4.1 任务

```json
{
  "version": 2,
  "id": "a1b2c3d4e5f6",
  "owner": "qq-openid",
  "conversation": "qq:channelId",
  "messageId": "…",
  "sessionId": "3f2a1b0c",
  "input": [{ "type": "text", "text": "帮我看看这段代码" },
            { "type": "image", "file": "input-0.png", "mime": "image/png", "size": 12345 }],
  "status": "queued",
  "delivery": "pending",
  "createdAt": 0, "dir": "…"
}
```

字段变化：

- 去掉 `prompt`、`kind`、`inputImages`。
- 新增 `input`（入站片段）与 `version`。
- 运行时写入 `output`（出站片段）与 `replyText`（拼接后的纯文本，供检索与重发）。

### 4.2 任务目录

| 文件 | 内容 |
| --- | --- |
| `job.json` | 任务状态与入站片段 |
| `input-<n>.<ext>` | 参考图片（不变） |
| `result-<n>.png` | 回复中的第 n 张图片（替代单个 `result.png`） |
| `reply.md` | 完整回复文本（含代码围栏），供重发与排查 |
| `failure.json` | 失败详情（不变） |
| `dom-probe.json` / `result-probe.json` | 页面结构快照（不变，保留可审计性） |

### 4.3 旧数据

启动加载时，`version !== 2` 的任务目录**不载入内存、不删除**，仅记录一条日志。
理由：旧任务是生图任务，语义已不适用，静默丢弃会造成困惑，自动清理则有丢失风险。
用户确认无用后可手动删除 `data/jobs/` 下的旧目录。

`data/conversations.json` 结构不变（`webThreadId` 语义相同），直接复用。
`data/intent-receipts.json` 不再写入，文件保留。

## 5. 桥接协议 v2

`GET /state`：

```json
{
  "version": 2,
  "job": {
    "id": "a1b2c3d4e5f6",
    "text": "帮我看看这段代码",
    "threadId": "",
    "cancelled": false,
    "images": [{ "index": 0, "mime": "image/png", "name": "input-0.png", "size": 12345 }]
  }
}
```

`GET /input?id=&i=`：不变，按令牌流式返回参考图片字节。

`POST /progress`：

```json
{ "id": "…", "threadId": "…", "phase": "opening|submitted|writing|reading" }
```

`POST /result-asset?id=<job>&i=<n>`：**新增**。请求体为图片原始字节，`Content-Type: image/png`。
桥接校验 PNG 文件头与大小后写入 `result-<n>.png`。必须在 `/result` 之前上传。

`POST /result`：

```json
{
  "id": "…",
  "threadId": "…",
  "segments": [
    { "type": "text", "text": "下面是两种写法：" },
    { "type": "code", "language": "js", "text": "console.log(1)" },
    { "type": "image", "asset": 0, "mime": "image/png" }
  ],
  "probe": {}
}
```

`POST /failure`：`{ id, message, probe? }`，不变。

### 5.1 桥接侧校验（新增，必须全部满足才接受）

- `segments` 是数组，长度 ≤ 200。
- 每项 `type` ∈ `{text, code, image}`，多余字段忽略。
- 文本总字节 ≤ 256 KB；单段 ≤ 64 KB。
- `image.asset` 必须是已通过 `/result-asset` 上传的序号，且 ≤ 10 张。
- `threadId` 必须匹配已绑定会话（现有逻辑不变）。
- 不满足则整条结果拒收，任务按失败处理，绝不落盘半截回复。

### 5.2 为什么图片单独上传

现有实现把单张图 base64 塞进 `/result` 的 JSON，请求体上限 29 MB。
通用回复可能包含多张图，base64 会膨胀 33%，很容易触顶。独立二进制端点可以流式落盘、
复用 `/input` 的既有模式，也让 JSON 保持小而可读。

## 6. 扩展侧改造

### 6.1 提交：去掉包装

删除 `buildMessage()` 的说明性前缀（`请使用 ChatGPT 图像生成功能…`）。提交内容 = 任务正文原文。

### 6.2 回合识别：去掉提示词标记

现状用 `QQ绘图任务 <id>` 标记行判断「这条消息是我发的」（`lastUser.innerText.includes(marker)`）。
通用桥接里这行字会永久留在用户的 ChatGPT 会话历史中，与「原样转发」冲突。

V1 改为**基线计数 + 文本比对**：

- 发送前记录 `userBaseline = user.length`。
- 提交后要求 `user.length > userBaseline`，且最新用户气泡的归一化文本等于本次发送的文本
  （超长文本用前缀比对，容忍页面折叠）。
- 只有附件、没有文本时，退化为「用户气泡数增加」即视为已提交。

这样提示词里不再出现任何连接器痕迹。

### 6.2.1 纯图片消息的提交（已定）

没有文本、只有附件时，**先按原文（空正文）提交**：

1. 注入附件后等待附件缩略图出现；
2. 检测发送按钮是否可用；
3. 若按钮持续不可用（例如 5 秒），才在正文补**一个空格**再提交。

不写入任何标记文本，也不写入说明性提示词 —— 用户的 ChatGPT 历史里最多留下一个空格。
附件本身仍只上传一次，与现有 `attachSent` 语义一致。

### 6.3 读回复：新增 `readReply()`

在最新 assistant 轮次内做 DOM → 片段序列化：

| DOM | 产出 |
| --- | --- |
| `p` | `text` 段（段间空行） |
| `h1`–`h6` | `text` 段，前置 `#`×n |
| `ul/ol > li` | `text` 段，前置 `- ` / `1. ` |
| `blockquote` | `text` 段，前置 `> ` |
| `table` | `text` 段，管道符行 |
| `pre > code` | `code` 段，语言取自 `language-*` 类名 |
| `a` | 折进所属 `text` 段，形如 `文字 (https://…)` |
| 行内 `code` | 折进所属 `text` 段，加反引号 |
| `img` | `image` 段（占位，随后上传字节） |

容器定位：从 `<h4 data-conversation-role="assistant">`（已知可用）向上找到同时包含
Markdown 内容根与 generated-image 画廊的祖先节点，再向下遍历。
`[data-testid^="conversation-turn"]` 已失效，只作为可选优先路径，不作为唯一依据。

### 6.4 图片提取：删掉全页回退

现状的「全页回退扫描」是两次真实事故的根源（返回账号头像、返回用户参考图）。
V1 **只接受 assistant 轮次内部的 generated-image 画廊图片**，彻底删除全页扫描。
标记消失时找不到图就继续等待 —— 失败方向仍然是「等」，而不是「返回错图」。

回复中的多张图按面积从大到小？不 —— **按 DOM 顺序**输出，保证与阅读顺序一致。

### 6.5 完成判定

回复完成 = 同时满足：

1. `assistants > baseline`（本轮 assistant 轮次已出现）；
2. 页面上没有停止按钮，且轮次内没有「生成中」类文案；
3. 轮次文本在 3 秒内没有变化；
4. 轮次内没有仍处于加载中的图片。

硬上限 `replyTimeoutMs` 默认 300 秒，超时按失败处理并附页面快照。

已知限制：ChatGPT 因长度截断而出现「继续生成」按钮时，V1 **不自动点击**（避免循环），
按已得到的内容回传，并在任务记录中标注 `truncated: true`。自动续写在 V2 评估。

### 6.6 取消

沿用现有做法：点击停止按钮 → `POST /failure`。V1 额外把已生成的部分内容一并带回，
避免用户取消后什么都拿不到。

## 7. QQ 输出渲染

`src/lib/reply.cjs`（纯函数，便于测试）：

1. 顺序遍历出站片段，把连续的 `text`/`code` 合并成一个文本批次（`code` 加 ``` 围栏），
   遇到 `image` 就切段 —— 这样图片在回复中的位置得以保留。
2. 每个文本批次按 `maxTextChars` 在段落边界拆成多条 QQ 消息。
3. 依次发送：文本批次 → 图片 → 下一个文本批次 → …

发送层仍复用现有的 `send()` 与 `delivery` 状态机；任一条失败即记 `delivery: 'failed'`，
并保留「重发」入口。所有文本经 `textMessage()` 转义，模型输出永远不会被解析成
`<img>`、`<at>` 等可执行消息元素。

## 8. 命令与授权

### 8.1 授权

完全不变。三条入口收敛为两条（命令 + 兜底转发），仍共用 `ctx.intersect(authorized)`：

| 场景 | 条件 |
| --- | --- |
| 私聊 | `allowedUsers` 命中（`["*"]` 表示全部） |
| 群聊 | `groupChat === true` 且 `session.stripped.appel` |

### 8.2 兜底转发中间件

注册在**所有命令之后**，沿用现有 `next(fallback)` 模式：

```js
scope.middleware((session, next) => next(() => forward(session)));
```

命令先匹配并产出结果，因此管理命令不会被转发；其余消息一律进入 `forward()`。

### 8.3 管理命令命名空间（已定：统一 `桥接` 前缀）

通用桥接下，`状态`、`取消` 这类词是普通聊天的高频词，直接做命令名会抢走用户消息。
V1 所有管理命令使用保留前缀 `桥接`：

| 命令 | 作用 |
| --- | --- |
| `桥接状态 [id]` | 查看当前或指定任务 |
| `桥接取消 [id]` | 停止当前或指定任务 |
| `桥接重发 [id]` | 重发上次回复 |
| `桥接新建会话 [name]` | 新建并切换网页会话（与当前并存） |
| `桥接重开会话 [name]` | 结束当前会话，下一条消息开新会话 |
| `桥接会话列表` | 列出会话与当前选择 |
| `桥接切换会话 <id>` | 切换会话 |
| `桥接重命名会话 <id> <name>` | 重命名 |
| `桥接关闭会话 [id]` | 关闭会话 |
| `桥接记录 [id]` | 最近十条任务 |

> 后续调整：会话默认持续。第一次发消息时自动建出「默认会话」，同一个用户的消息始终留在同一个网页会话里，
> 因此不再有「无会话模式」，`桥接退出会话` 已移除，改为 `桥接重开会话`。

旧命令 `画图*` / `独立画图` / `取图` 语义已失效，V1 直接移除，不做别名。

## 9. 状态机与超时

任务状态沿用 `queued → running → ready | failed | cancelled | interrupted`。

进度文案改为中性：`正在打开 ChatGPT 网页` → `已提交，正在等待回复` → `正在读取回复`。

超时预算：

| 环节 | 上限 |
| --- | --- |
| 参考图上传确认 | 45 秒（不变） |
| 提交确认 | 20 秒 |
| 回复等待 | `replyTimeoutMs`，默认 300 秒 |
| 桥接整体 | 与 `replyTimeoutMs` 同步（现为 600 秒） |

心跳提醒（当前 60 秒后提示「仍在处理中」）保留，文案改为通用措辞。

## 10. 失败分类

V1 的关键简化：**模型的内容拒绝不再是失败**。

「抱歉，我不能帮你做这个」是 ChatGPT 的正常回复，必须原样回传给用户，而不是被
`failureInfo()` 判成 `refused` 然后丢掉。因此：

- 删除 `refused`、`tool_unavailable`、`content_rejected`、`no_image` 判定。
- 保留纯技术失败：`authentication`、`rate_limit`、`browser_interaction`、
  `network`、`bridge_offline`、`bridge_busy`、`timeout`、`reply_unreadable`。

`reply_unreadable` 是新增的兜底：页面确实有 assistant 轮次，但序列化后没有任何片段。
这通常意味着 DOM 结构变了，必须带 `dom-probe.json` 一起报告。

## 11. 测试计划

沿用「测试是可执行规格」的定位，按层重写。

### 保留

- `test/lib/image.test.cjs`：SSRF、协议白名单、体积限制、嗅探（几乎不动）
- `test/core/conversations.test.cjs`：归属与 `webThreadId` 不可静默变更
- `test/core/queue.test.cjs`：去重、串行、取消、重启、保留期
- `test/index.test.cjs`：授权闸门、群聊 @、兜底转发不吞命令
- `test/architecture.test.cjs`：分层与「无子进程」哨兵
- `test/lib/feedback.test.cjs`：脱敏与转义

### 新增

- `test/core/message.test.cjs`：QQ 元素 → 片段，顺序、纯图、图文混合、超限
- `test/lib/reply.test.cjs`：片段 → QQ 元素，图片位置保留、段落边界拆分、
  代码块不被切断、总量截断、转义
- `test/bridge/web-bridge.test.cjs` 扩充：`/result-asset` 上传、片段校验拒收、
  未上传 asset 拒收、`/result` 与 `/result-asset` 顺序约束

### 重写

- `test/browser-worker.test.cjs`：改为验证 `readReply()` 的 DOM 序列化
  （标题、列表、引用、表格、代码语言、链接、多图顺序、完成判定、无标记回合识别）。
  现有「不返回头像/参考图/UI 文案」等回归断言全部保留 —— 它们对应的真实事故依然适用。

### 删除

- `test/core/intent.test.cjs`（模块删除）

### 补上现有缺口

- 插件成功回传 QQ 的完整闭环（现仅验证到队列 `ready`）。
- 多参考图（≥2 张）的正向链路。

## 12. 已确认决策

1. **管理命令命名空间**：统一使用 `桥接` 前缀。`状态`、`取消` 等短词不做命令，
   避免抢走用户消息。
2. **纯图片消息**：先按原文（空正文）提交，仅在发送按钮持续不可用时补一个空格，
   不写入任何标记或说明性文本。
3. **包名与插件键**：V1 保持 `codex-image-local` 不变，改名放到 V2。
   理由：改名需同步 `koishi.yml` 并重启实例，与功能重构混在一起会难以定位问题。
4. **旧任务目录**：`data/jobs/` 下的生图任务目录由用户手工清理，程序不自动删除。

## 13. 分阶段实施

| 阶段 | 内容 | 可独立验证 |
| --- | --- | --- |
| P0 | 打 tag 冻结当前生图版本，保留回滚点 | `git tag` |
| P1 | 新增 `core/message.cjs`、`lib/reply.cjs` 及其测试，不接线 | `npm test` 全绿 |
| P2 | 队列 v2 数据模型 + 桥接协议 v2 + 协议测试 | 桥接测试全绿 |
| P3 | 扩展：原文提交、无标记回合识别、`readReply()`、`/result-asset` | `browser-worker.test.cjs` |
| P4 | `index.cjs` 接线：兜底中间件、新命令、删除 intent/natural | `index.test.cjs` |
| P5 | 文档更新 + 真实 QQ 端到端验收 | `docs/history.md` 记录 |

每阶段结束都要求 `npm test` 全绿，且 P2 之后不再保留 `kind: 'intent'` 相关代码路径。

## 14. 与现有约定的一致性

- 分层规则不变，新增模块归属明确：`core/message.cjs` 属 core，`lib/reply.cjs` 属 lib。
- 不引入任何本地 CLI 或子进程，架构哨兵继续生效。
- 群聊 `@` 语义仍由 Koishi 提供，插件不自己解析。
- 授权仍是唯一闸门，不新增第二处判断。
- 文档同步：`README.md`、`docs/architecture.md`、`koishi.example.yml`、`docs/history.md`。
