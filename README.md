# Koishi 本机 ChatGPT 网页桥接

把 QQ 消息原样送进 Chrome 里**已登录的 ChatGPT 普通聊天页面**，再把网页的回复原样送回 QQ。
不调用 OpenAI 接口，不需要 API Key，也不调用任何本地 CLI。请保持 Chrome、扩展和 Koishi 运行；
网页额度以账号实际限制为准。

**只有一个后端：ChatGPT 网页。** 插件本身不启动任何外部进程，全部收发都通过本机 5141 端口的桥接
交给浏览器里的在线页面完成。

## 怎么用

直接发消息就行。**没有触发词，也没有「画图」这类前缀**：私聊里发什么，ChatGPT 就收到什么。

- 发一段文字 → 原样送进 ChatGPT，回复原样回来。
- 发一张图片 → 作为附件送进 ChatGPT（可以只发图片，不写字）。
- 发「图片 + 文字」→ 文字是正文，图片是附件。
- 想让它记住上下文 → 先 `桥接新建会话 名字`，之后的消息都留在同一个网页会话里。

群聊里需要 @ 机器人，见下面的「授权与群聊」。

### 管理命令

命令统一使用 `桥接` 前缀，这样它们不会和普通聊天抢消息 —— 你发「取消」两个字时，
它会被送去 ChatGPT，而不是被当成命令。

| 命令 | 作用 |
| --- | --- |
| `桥接状态 [任务编号]` | 查看最近或指定任务的进度 |
| `桥接取消 [任务编号]` | 停止排队，或请求网页停止正在进行的生成 |
| `桥接重发 [任务编号]` | 重新发送已取回的回复 |
| `桥接新建会话 [名称]` | 新建并切换到一个独立的网页会话 |
| `桥接会话列表` | 查看自己的会话及当前选择 |
| `桥接切换会话 会话编号` | 切换到自己的其他会话 |
| `桥接重命名会话 会话编号 新名称` | 修改名称，最多 40 字 |
| `桥接记录 [会话编号]` | 查看指定或当前会话最近 10 个任务 |
| `桥接关闭会话 [会话编号]` | 关闭会话，不删除历史记录 |
| `桥接退出会话` | 切回不绑定会话的模式，会话仍可切回 |

并发 1，待完成任务最多 5，单条消息文字最多 1500 字。
接收后立即确认，运行 60 秒后最多提醒一次；回复完成后自动发回。
实际发送仍受 QQ 平台额度和消息审核约束。

## 回复是怎么回传的

网页回复会被还原成**有序片段**：正文（保留标题、列表、引用、表格、链接与行内代码的结构）、
代码块（保留语言）和图片。发送时按这个顺序依次发出，**图片在回复里的位置不会丢**。

- 代码块用 ``` 围栏原样发出，QQ 不渲染 Markdown，看到的就是纯文本。
- 单条文本超过 1500 字会按段落边界拆成多条；代码块不会被从中间切断。
- 整条回复超过 6000 字会截断并明确提示，完整内容保留在本机任务记录里，可用「桥接重发」重取。
- **模型的内容拒绝是正常回复**。「抱歉，我不能帮你做这个」会原样发给你，不会被当成失败丢掉。
  只有真正的技术问题（登录失效、额度受限、网页操作失败、超时）才报告为失败。

## 参考图片输入

发送图片（`img` 元素）时，图片作为附件送进 ChatGPT，文字作为正文。

- 一次最多 2 张参考图（可用 `maxInputImages` 调整）；图片上限默认 10 MB，可用 `maxInputBytes` 调整。
- 只接受 `http(s)`、`data:` 与 OneBot `base64://` 地址。`file://` 等本地路径一律拒绝，不会读取本机任意文件。
- 下载前解析域名并拒绝回环、内网、链路本地与保留地址（SSRF 防护），重定向逐跳重新校验，避免公网链接跳到内网。
- 只接受 PNG/JPEG/GIF/WebP，按文件头嗅探而非 `Content-Type`；SVG/HTML 一律拒绝。
- 下载文件以 0600 写入临时目录，入队时移入任务目录并记录为 `input-<序号>.<扩展名>`，随任务一并持久化。
- 图片字节只在本机 5141 端口按任务令牌提供，不写入扩展的持久存储，也不出现在 QQ 消息里。

**一个诚实的限制**：ChatGPT 的输入框把图片当作附件，不是正文的一部分。
所以「图片夹在两句文字之间」这种位置关系无法表达 —— 文字顺序和图片顺序各自不变，但二者交错的相对位置会丢。

## 授权与群聊

默认仅允许 `allowedUsers` 中配置的 QQ openid 在私聊调用；将其设为 `["*"]` 可允许所有 QQ 私聊用户。

**群聊默认完全不响应**，必须显式设置 `groupChat: true` 才启用。启用后群里**任何成员** @ 机器人都可使用，
`allowedUsers` 不参与群聊判定（群里的 QQ openid 是群作用域 id，与私聊名单不是同一套），
回复直接发到群里，群成员均可见。群聊里 `@` 是硬性前提：Koishi 不会把未被 @ 的群消息交给本插件，
私聊则无需 @。每个成员在同一群里拥有各自独立的会话，互相看不到也切不进对方的会话。

> 注意：一旦开启群聊，群里任何人都能消耗你账号的 ChatGPT 网页额度。

## 安装与配置

只需三步：

1. 把本目录链接到 Koishi 实例的 `node_modules/koishi-plugin-codex-image-local`。
2. 生成扩展配置（写入 `browser-extension/config.js` 与 `data/web-bridge-token`）：

   ```bash
   node scripts/setup-web-bridge.cjs        # 端口需与 webBridgePort 一致，默认 5141
   ```

3. 在实例 `koishi.yml` 增加 `codex-image-local` 配置（可参考仓库根目录的 `koishi.example.yml`），**重启实例**；
   再在 Chrome 扩展管理页开启开发者模式，加载 `browser-extension` 目录。

插件名与包名沿用 `codex-image-local`（历史命名），与后端无关，重命名需要同步改 `koishi.yml` 的键。

必需配置只有一项：

- `allowedUsers`：允许在**私聊**调用本插件的 QQ openid 列表，`["*"]` 表示所有 QQ 私聊用户。

可选配置：

- `groupChat`：设为 `true` 才响应群聊。默认 `false`，即群聊完全不响应。启用后群里任何成员 @ 机器人即可使用，结果直接发到群里；`allowedUsers` 不参与群聊判定。
- `webBridgePort`：本机桥接端口，默认 5141。
- `maxTextChars`：单条消息的文字上限，也是单条回复的拆分长度，默认 1500。
- `maxReplyChars`：一条回复回传到 QQ 的总文字上限，默认 6000，超出会截断并提示。
- `maxInputImages`：单条消息可携带的参考图数量，默认 2。
- `maxInputBytes`：单张参考图体积上限，默认 10 MB。
- `replyTimeoutMs`：等待网页回复的超时，默认 5 分钟。
- `retentionDays`：默认不设置＝永久保留。设为大于 0 的天数后，已结束（完成/失败/取消/中断）的任务超过该天数会在启动时及每 6 小时整体删除，回收参考图与结果图占用的空间。排队中和运行中的任务永不会被清理。

停用插件后其正在执行的任务会被取消。

部署细节、重启方式与排障见 [docs/operations.md](docs/operations.md)。

## 项目结构

```
koishi-codex-image-bridge/
├── src/                        插件运行时，Koishi 从这里加载
│   ├── index.cjs               Koishi 入口：导出 name / apply，注册命令与兜底转发
│   ├── lib/                    通用工具层，不依赖项目内其他模块
│   │   ├── image.cjs           参考图安全下载、格式嗅探、PNG 尺寸解析
│   │   ├── reply.cjs           回复片段校验、Markdown 围栏还原、按段落拆分
│   │   └── feedback.cjs        用户可见文案、失败分类、本机路径脱敏
│   ├── core/                   领域层，可用 lib
│   │   ├── message.cjs         QQ 消息元素 → 有序片段
│   │   ├── conversations.cjs   网页会话持久化
│   │   └── queue.cjs           任务队列持久化与串行执行
│   └── bridge/                 传输层，可用 core 与 lib
│       └── web-bridge.cjs      与 Chrome 扩展的本机 HTTP 桥接（127.0.0.1:5141）
├── browser-extension/          Chrome MV3 扩展：驱动 ChatGPT 页面
├── scripts/
│   └── setup-web-bridge.cjs    生成扩展的本地配置与桥接令牌
├── test/                       镜像 src/ 的分层
│   ├── lib/ core/ bridge/      各模块单元测试
│   ├── helpers/dom.cjs         测试用的最小 DOM 桩（扩展页面脚本只能在沙箱里跑）
│   ├── index.test.cjs          装配层：假 Koishi 上下文驱动整个插件
│   ├── architecture.test.cjs   分层与依赖规则的守卫
│   ├── pipeline.test.cjs       端到端：QQ 元素 → 安全下载 → 落盘 → 桥接 → 回复回传
│   └── browser-worker.test.cjs 扩展后台脚本
├── docs/                       设计、架构、运维与历史记录
├── koishi.example.yml          配置示例
├── data/                       运行时状态（任务、会话、令牌），已 gitignore
└── package.json
```

分层规则是强制约束：`lib` 不得依赖 `core`/`bridge`，`core` 不得依赖 `bridge`，反向依赖与孤立模块都会被
`test/architecture.test.cjs` 拦下。新增目录时需要同步更新该测试里的分层表。详见 [docs/architecture.md](docs/architecture.md)。

## 验证

```bash
npm test          # 等价于 node --test "test/**/*.test.cjs"
```

覆盖消息片段化与顺序、回复序列化与拆分、去重、串行取消、重启、参考图下载边界、桥接鉴权与协议校验、
扩展提交顺序与回合识别，以及分层与依赖规则的守卫。
Node 22 自行展开 glob，Windows 下无需 shell 展开。

真实网页与真实 QQ 收发需要分别验证，单元测试不替代端到端验收；已完成的验收记录见 [docs/history.md](docs/history.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/design-v1.md](docs/design-v1.md) | 从生图插件转向通用桥接器的第一版设计 |
| [docs/architecture.md](docs/architecture.md) | 分层与依赖规则、各模块职责、数据流、授权与群聊、失败反馈、连接器工作原理 |
| [docs/operations.md](docs/operations.md) | Windows 部署位置、重启方式、判断运行中实例是否加载了新代码、实现注意与排障 |
| [docs/history.md](docs/history.md) | 端到端验收记录与变更记录 |
