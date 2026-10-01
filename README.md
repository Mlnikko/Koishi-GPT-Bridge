# Koishi 本机 ChatGPT 网页生图

使用 Chrome 中已登录的 ChatGPT 普通聊天页面生图，通过本机扩展返回图片；不调用 OpenAI 图片 API，也不需要 API Key 或任何本地 CLI。请保持 Chrome、扩展和 Koishi 运行。网页额度以账号实际限制为准。

**只有一个后端：ChatGPT 网页。** 插件本身不启动任何外部进程，全部生成与语义分类都通过本机 5141 端口的桥接交给浏览器里的在线页面完成。

## 指令

- `新建画图会话 橘猫系列`：创建并选中一个独立会话，可省略名称。
- `画图 一只穿宇航服的橘猫`：在当前绘图会话中生成；未选会话时独立生成。
- `画图 把背景改成月球`：在当前会话中继续，保留该 ChatGPT 会话的上下文。
- `画图会话`：查看自己的打开会话及当前选择。
- `切换画图会话 会话编号`：恢复自己的其他会话。
- `重命名画图会话 会话编号 新名称`：修改名称，最多 40 字。
- `会话画图记录 [会话编号]`：查看指定或当前会话最近 10 个任务及取图编号。
- `关闭画图会话 [会话编号]`：关闭指定或当前会话，不删除历史任务和图片。
- `退出画图会话`：退出当前会话，切回独立绘图模式，会话仍可重新切换。
- `独立画图 提示词`：本次独立生成，不改变当前选中会话。
- `画图状态 [任务编号]`：查看状态，省略编号则查当前绘图会话最近任务；未选会话时查该聊天（私聊或群聊）最近任务。
- `取消画图 [任务编号]`：停止排队，或请求网页停止正在进行的生成。
- `取图 [任务编号]`：发送已生成图片，发送失败只重试发送。
- 直接发送图片：发一张图片（可同时附文字）即可让 ChatGPT 参考它生成/修改；不附文字时按“参考这张图片生成一张图片”处理。群聊中需 @ 机器人。

默认仅允许 `allowedUsers` 中配置的 QQ openid 在私聊调用；将其设为 `["*"]` 可允许所有 QQ 私聊用户。

**群聊默认完全不响应**，必须显式设置 `groupChat: true` 才启用。启用后群里**任何成员** @ 机器人都可发起绘图，
`allowedUsers` 不参与群聊判定（群里的 QQ openid 是群作用域 id，与私聊名单不是同一套），生成的图片直接发到群里，
群成员均可见。群聊里 `@` 是硬性前提：Koishi 不会把未被 @ 的群消息交给本插件，私聊则无需 @。
每个成员在同一群里拥有各自独立的绘图会话，互相看不到也切不进对方的会话。
并发 1，待完成任务最多 5，描述最多 1500 字，网页处理超时 10 分钟。
接收后立即确认，运行 60 秒后最多提醒一次；完成后在原消息有效窗口内自动上传原图。
超过回复窗口则保存图片，用户发送“取图”提供新的消息上下文。
实际发送仍受 QQ 平台额度和消息审核约束。

## 参考图片输入

发送图片（`img` 元素）会走独立链路：从消息元素取图片地址 → 本机安全下载 → 任务落盘 → 本机桥接 → 扩展上传到 ChatGPT → 回传生成图。

- 支持“图片+文字”（文字作为要求）与“纯图片”（无文字时使用默认要求）。
- 一次最多 2 张参考图；图片上限默认 10 MB，可用 `maxInputBytes` 调整。
- 只接受 `http(s)`、`data:` 与 OneBot `base64://` 地址。`file://` 等本地路径一律拒绝，不会读取本机任意文件。
- 下载前解析域名并拒绝回环、内网、链路本地与保留地址（SSRF 防护），重定向逐跳重新校验，避免公网链接跳到内网。
- 只接受 PNG/JPEG/GIF/WebP，按文件头嗅探而非 `Content-Type`；SVG/HTML 一律拒绝。
- 下载文件以 0600 写入临时目录，入队时移入任务目录并记录为 `input-<序号>.<扩展名>`，随任务一并持久化。
- 图片字节只在本机 5141 端口按任务令牌提供，不写入扩展的持久存储，也不出现在 QQ 消息里。

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

- `groupChat`：设为 `true` 才响应群聊。默认 `false`，即群聊完全不响应。启用后群里任何成员 @ 机器人即可绘图，结果直接发到群里；`allowedUsers` 不参与群聊判定。
- `webBridgePort`：本机桥接端口，默认 5141。
- `naturalLanguage`：设为 `false` 关闭自然语言入口，只保留明确命令。
- `maxInputBytes`：单张参考图体积上限，默认 10 MB。
- `retentionDays`：默认不设置＝永久保留。设为大于 0 的天数后，已完成/失败/取消/中断的任务超过该天数会在启动时及每 6 小时整体删除，回收参考图与结果图占用的空间。排队中和运行中的任务永不会被清理；被删除的任务不再能“取图”。

停用插件后其正在执行的任务会被取消。

部署细节、重启方式与排障见 [docs/operations.md](docs/operations.md)。

## 项目结构

```
koishi-codex-image-bridge/
├── src/                        插件运行时，Koishi 从这里加载
│   ├── index.cjs               Koishi 入口：导出 name / apply，注册命令与中间件
│   ├── lib/                    通用工具层，不依赖项目内其他模块
│   │   ├── image.cjs           参考图安全下载、格式嗅探、PNG 尺寸解析
│   │   └── feedback.cjs        用户可见文案、失败分类、本机路径脱敏
│   ├── core/                   领域层，可用 lib
│   │   ├── conversations.cjs   画图会话持久化
│   │   ├── queue.cjs           任务队列持久化与串行执行
│   │   ├── intent.cjs          语义词表、分类提示词与结果校验
│   │   └── natural.cjs         自然语言路由
│   └── bridge/                 传输层，可用 core 与 lib
│       └── web-bridge.cjs      与 Chrome 扩展的本机 HTTP 桥接（127.0.0.1:5141）
├── browser-extension/          Chrome MV3 扩展：驱动 ChatGPT 页面
├── scripts/
│   └── setup-web-bridge.cjs    生成扩展的本地配置与桥接令牌
├── test/                       镜像 src/ 的分层
│   ├── lib/ core/ bridge/      各模块单元测试
│   ├── index.test.cjs          装配层：假 Koishi 上下文驱动整个插件
│   ├── architecture.test.cjs   分层与依赖规则的守卫
│   ├── pipeline.test.cjs       端到端：QQ 元素 → 安全下载 → 落盘 → 桥接 → 回传 PNG
│   └── browser-worker.test.cjs 扩展后台脚本
├── docs/                       架构、运维与历史记录
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

覆盖去重、串行取消、重启、参考图下载边界、桥接取图、扩展提交顺序，以及分层与依赖规则的守卫。
Node 22 自行展开 glob，Windows 下无需 shell 展开。

独立生图与真实 QQ 收发需要分别验证，单元测试不替代端到端验收；已完成的验收记录见 [docs/history.md](docs/history.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层与依赖规则、各模块职责、数据流、多会话与自然语言识别、失败反馈、连接器工作原理 |
| [docs/operations.md](docs/operations.md) | Windows 部署位置、重启方式、判断运行中实例是否加载了新代码、实现注意与排障 |
| [docs/history.md](docs/history.md) | 端到端验收记录与变更记录 |
