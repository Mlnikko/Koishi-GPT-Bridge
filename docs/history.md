# 验证与变更记录

## 端到端验收记录

### 参考图片链路（2026-09-29）

**真实 QQ 端到端已验收通过**：任务 `8e6eb22e5257` 私聊发送一张 2.9 MB 参考图 + 文字要求，52 秒后
`status: ready`、`delivery: sent`，回传 2.47 MB `result.png`。参考图落盘为 `input-0.png`，
ChatGPT 会话编号与结果图均正常绑定。附件缩略图选择器在真实页面上有效。

`test/pipeline.test.cjs` 用真实模块串起整条链路：QQ 元素 → 安全下载 → 任务持久化 → 本机桥接取图 → 回传 PNG，
覆盖纯图片、图片+文字与下载失败三种情形。

### 网页接入（2026-09-27）

真实网页在同一会话先生成蓝色圆形、再改成橙色，均自动保存为 1254×1254 PNG。

## 尚未完成

- 真实页面上**多图参考**与**失败重试**场景的验收。
- 真实 QQ 私聊发图的失败重试路径（例如上传阶段超时后重新发送）。

## 变更记录

### 2026-09-29 · 修掉“网页已出图却报 no_image”

现象：任务 `ad385672762e` 报
`no_image / 生成已结束，但没有可用图片……模型回复：ChatGPT 说：\n编辑`，但用户确认网页上确实有图。

定位：

- `模型回复：ChatGPT 说：\n编辑` 是**纯图片回复的正常形态**，不是抓错了容器。图片回复的
  assistant 轮次本来就只有无障碍标题（“ChatGPT 说：”）和操作按钮（“编辑”），没有任何模型文本。
  旧代码把这个字符串直接当失败原因抛出，所以真正的问题被这句话掩盖了。
- 真正原因是**过早放弃**。`tick()` 的等待循环里，只要 assistant 文本稳定 10 秒且没检测到图片就抛错，
  即发送后约 25 秒。而 ChatGPT 会先渲染空的 assistant 轮次、图片往往要一分钟以上才出现。
  同一个提示词在 3 分钟后重试（任务 `0f5500b09719`）就成功了，可见并非稳定复现的选择器失效。
- 图片识别只认一个 `[data-testid="generated-image-preview"] img`，且要求**恰好 1 张**。
  该属性随时可能被改掉，命中条件也过严。

处理（`browser-extension/background.js`）：

- 等待策略：文本稳定不再等于“回答结束”。页面看起来还在忙（有停止按钮、出现生成中字样、
  图片存在但未加载完）就继续等；只有**真正的模型文本**才会在 45 秒后立刻上报，
  否则一直等到 240 秒硬上限。硬上限检查放在“忙”分支之前，避免永远忙的页面把桥接超时耗光。
- 图片识别改为按**特征**而非单一属性：任意 `blob:`/`data:`/`https` 来源、长宽都 ≥200 的位图，
  排除头像/图标/表情。按面积从大到小取第一张，不再要求恰好 1 张。
- 定位 assistant 轮次改用 `closest('[data-testid^="conversation-turn"]')`，比 `parentElement` 更稳。
- 兜底扫描整页时，排除用户气泡（参考图）**以及除最新轮次以外的所有历史轮次**——
  因为命名画图会话会复用同一个 `webThreadId`（见 `src/index.cjs` 的 `threadId: chat?.webThreadId`），
  否则同一会话里上一轮生成的图会被当成本轮结果回传。
- 新增 `modelReply()`：剥掉无障碍标题与按钮文案后过短的一律视为“没有回复”，
  不再把 UI 文案当模型回复。
- 失败时扩展会把页面结构快照（轮次数、角色节点、每张图的来源/尺寸/是否在用户气泡内、最新轮次
  截断 HTML）随 `/failure` 上报，桥接写入 `data/jobs/<id>/dom-probe.json`。
  下次再遇到识别不到图，可以直接看真实 DOM，不用再靠猜。

测试：新增 4 项（按特征识别图片且不误取参考图、UI 文案不算模型回复、忙状态要等到底而不是立刻失败、
真正的拒绝要立刻带模型原话上报），并在桥接侧新增 1 项（快照落盘且超大快照被丢弃不影响失败上报）。
全套 **67 项通过**。

### 2026-09-29 · 修掉图片消息后面的空行（问题在依赖侧）

现象：机器人回传图片时，消息里除图片外还多出一行空行。

定位结论：**不是本项目的问题**。`@satorijs/adapter-qq@4.12.0` 及更早版本在发送纯媒体消息时，
若文本为空会强行填 `content: " "`，QQ 把这个空格渲染成空行。上游在 **4.13.0** 删除了这一行。

处理：把实例的 `@satorijs/adapter-qq` 从 4.10.0 升到 **4.14.0**。本项目代码未做任何改动，
因为 `deliver()` 本来就只发一条 `<img/>`。

过程中发现两件值得记住的事，已写进 `docs/operations.md`：

- 实例的 `market` 插件会在每次启动时自动升级一批依赖，每次升级都触发重启，形成级联，
  约 70 秒后自行稳定。手动对实例跑 `yarn up` 会人为制造这个级联。
- 手工写入实例 `package.json` 的 `resolutions` 会被 market 删除，无法用来锁定传递依赖版本。

### 2026-09-29 · 项目结构整理

- 根目录平铺的 8 个运行时模块按依赖方向分层到 `src/`：`lib/`（`image.cjs`、`feedback.cjs`）、
  `core/`（`conversations.cjs`、`queue.cjs`、`intent.cjs`、`natural.cjs`）、`bridge/`（`web-bridge.cjs`）。
- `plugin.cjs` 更名为 `src/index.cjs`，`package.json` 的 `main` 同步更新。
  注意：`src/` 比项目根低一层，因此入口里默认的 `data/` 路径改为 `path.join(__dirname, '..', 'data')`。
- `setup-web-bridge.cjs` 移到 `scripts/`（它是运维工具而非插件运行时），基准路径改为项目根，
  并支持 `node scripts/setup-web-bridge.cjs <端口>` 指定桥接端口。
- `test/` 改为镜像 `src/` 分层（`test/lib`、`test/core`、`test/bridge`），
  `test/plugin.test.cjs` 更名为 `test/index.test.cjs`；`npm test` 改用
  `node --test "test/**/*.test.cjs"` 以覆盖嵌套目录。
- 新增 `test/architecture.test.cjs`：把分层规则变成可执行约束（分层归属、依赖方向、无孤立模块、
  无子进程回归、`main` 指向真实入口、入口导出契约）。原先散落在 `test/core/intent.test.cjs` 里的
  源码级子进程扫描已收敛到这里，改为对全部运行时模块统一扫描。
- 新增 `koishi.example.yml`，让必需与可选配置可直接发现。
- 文档拆分：README 保留概览与快速开始，架构说明移到 `docs/architecture.md`，
  部署与排障移到 `docs/operations.md`，本文件承载验收与变更记录。
- 建立版本控制：项目此前没有 git 仓库，先提交重构前基线（26 个文件），
  再以 `git mv` 完成结构调整，使改动可审阅、可回滚。新增 `.gitattributes` 固定 LF。
  `.gitignore` 补充 `.workbuddy-ai/`（本机工具状态，含绝对路径）。

### 2026-09-29 · 移除 Codex 后端

- 删除 `runner.cjs`（`runCodex`/`collectImage`）与 `test/environment.test.cjs`；
  `intent.cjs` 的 `classify()`、`conversations.cjs` 的 `bind()`、`feedback.cjs` 的 `Outcome` 一并移除。
- 配置项 `codexPath`、`imageBackend`、`intentBackend`、`intentModel` 不再使用，
  已从线上 `koishi.yml` 删除（备份在同目录 `koishi.yml.bak-20260929-011716`）。
- 语义分类统一走 ChatGPT 网页；`directImage` 固定开启，绘图请求不再经过分类。
- `safeReason()` 补全 Windows 盘符、正斜杠盘符与 UNC 路径的脱敏。
- 新增可选 `retentionDays` 清理（默认关闭，行为不变）。
- 新增装配层测试（当时的 `test/plugin.test.cjs`，现为 `test/index.test.cjs`）：用假 Koishi 上下文直接覆盖
  插件的装配过程，验证图片中间件优先级、纯图片受理、下载失败不入队、文字命令入队、未授权隔离、
  浏览器离线时的失败原因，以及缺 `allowedUsers` 时拒绝加载。
  该假上下文刻意复刻了 Koishi 的 `next(fallback)` 语义（先跑完后续中间件，只有都没产出时才执行 fallback），
  否则延迟生效的自然语言路由会吞掉所有命令；同时它必须收集 `dispose` 回调并释放桥接，
  因为 `WebBridge` 构造函数里就 `listen()`，不释放会让测试进程永不退出。

### 2026-09-29 · 打通参考图片输入

- 新增 `image.cjs`（现 `src/lib/image.cjs`）：安全下载、SSRF 防护、文件头嗅探、PNG 尺寸解析。
- `queue.cjs` 支持输入图片持久化与 `kind: 'image' | 'text'`；允许空提示词（纯图片）。
- 新增图片中间件，注册在绘图命令之前，所以带图消息一律按参考图处理。
- `web-bridge.cjs` 的 `/state` 返回图片元数据，新增 `GET /input?id=&i=` 按令牌流式返回图片字节。
- 扩展新增 `attaching` 阶段：确认输入框内出现附件后才提交，超时即明确失败，绝不退化成纯文字请求。
