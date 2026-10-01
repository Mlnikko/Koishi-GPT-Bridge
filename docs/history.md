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

- **真实网页上的回复序列化**：多图回复、长代码块、表格、引用在真实 DOM 上的还原效果。
- **真实 QQ 的转发与回传**：文本、纯图片、图文混合三条链路，以及长回复的拆分发送。
- **真实 QQ 群里 @ 机器人触发的端到端验收**（命令、图片、转发三条入口），以及群消息回复窗口是否与私聊一致。
- **多参考图**（≥2 张）在真实页面上的上传与顺序。
- ChatGPT 因长度截断出现「继续生成」按钮时的处理（V1 不自动点击，按已得到的内容回传）。
- 包名与插件键的重命名（`codex-image-local` → 中性名称），推迟到 V2。

## 生图时代的验收记录

以下记录对应改造前的生图插件，保留作为历史与回滚参考。

## 变更记录

### 2026-10-01 · 修掉「图片明明在页面上却报未检测到本轮图片」

现象：发图请求后一直收不到回复，任务等满 240 秒后失败：
`等待网页出图超时，未检测到本轮图片`。任务 `e1d8e9675311` 的 `dom-probe.json` 直接给出了现场：

```
images:
  {"alt":"",            chrome:true, complete:true, w:512,  h:512,  picked:false, src:"data:"}   ← 账号头像
  {"alt":"已生成图像 1","chrome:true", complete:true, w:1367, h:1150, picked:false, src:"blob:"} ← 生成结果
```

第二张就是生成结果，尺寸、加载状态、`generated-image-gallery` 位置全部正确 —— 但它被
`isChrome()` 判成了「页面框架图片」，于是 `replyImages()` 永远是空的。
上一轮刚加的 `gallery && !images → 继续等` 判定因此一直成立，直到硬上限。

定位：`isChrome()` 的第二条判断是「存在 `main` 但图片不在 `main` 内 → 判为页面框架」。
这是一条**对页面结构的假设**，而当前 ChatGPT 把会话渲染在 `<main>` 之外（页面上另有 `main`），
于是真正的生成图被整批判掉。

改动（`browser-extension/background.js`）：

- 抽出 `chromeReason()`，并把「已在最新回复轮次内部」放在 `outside-main` 之前直接放行 ——
  位置本身就是最强的证据。`header`/`nav`/`aside`/`profile`/`sidebar` 祖先判断保留在最前，
  账号头像仍然被排除。
- `probeDom()` 增加 `main`、每张图的 `inReplyTurn`、`chromeReason`、`gallery`，
  下次能直接看出是**哪条规则**把哪张图判掉的，不用再靠猜。

测试：新增「会话不在 `<main>` 内时仍能找到生成图」与「会话不在 `<main>` 内时头像仍被排除」，
并把 `inReplyTurn` 那道放行关掉做过反向验证（两项都失败），确认不是空转。全套 **110 项通过**。

未验证：真实页面上图片渲染完成后的正向路径（本次只验证了识别逻辑）。

### 2026-10-01 · 修掉「空回复：只回传了 `#### ChatGPT 说:`」

现象：群里发「参考图 + 画图」，QQ 收到一条内容为 `#### ChatGPT 说:` 的消息，
网页上的图片**还没渲染出来就被关掉了**。

定位（两处缺陷叠加）：

1. **角色标题被当成了正文。** 页面当时没有暴露 markdown 容器，`replyRoot()` 退到整个轮次容器，
   而 `<h4 data-conversation-role="assistant">` 里的「ChatGPT 说：」就在这个容器里，
   被 `walk()` 序列化成了一条 `#### ChatGPT 说：` 的标题段。
2. **完成判定用了「轮次里有字」这个错误的信号。** `replyStable` 取自 `lastAssistant.innerText`，
   而空轮次本来就有无障碍标题，长度不为 0 —— 于是这个「还没出图的空轮次」被判成已完成回复。
   扩展读完就 `chrome.tabs.remove()` 关掉专用标签页，**把还在生成的图片一起关掉了**。

改动（`browser-extension/background.js`）：

- `walk()` 跳过带 `data-conversation-role` / `data-message-author-role` 的元素，
  角色标题与操作按钮不再进入回复；`replyRoot()` 增加 `[data-message-author-role="assistant"]` 候选。
- 完成判定改为看**读出来的内容**：新增 `replyLength`（序列化后的正文长度）、`images`、
  `imageLoading`、`gallery`，替换掉 `replyStable`/`replyText`。以下任一成立就继续等：
  没有任何可读内容、画廊已出现但还没有可用图片、图片未加载完、页面还在忙。
  稳定信号也从整段 `innerText` 换成序列化结果的校验和。
- 硬上限超时会区分「一直在准备图片但没有产出」与「什么都没读到」。

顺带修掉一个**测试基础设施的 bug**：`test/helpers/dom.cjs` 的选择器解析按空白切分后代组合子，
把 `[data-testid*="generated-image" i]` 里的空格也切开了，导致带 `i` 标志的选择器永远匹配不上
（`isChrome` 就用了 `[data-testid*="profile" i]`）。这类选择器的断言此前全部是空转。
现在按引号与方括号深度切分，并新增 `test/helpers/dom.test.cjs` 把 DOM 桩本身也纳入测试 ——
地基失配时测试还是绿的，但什么都没验证。

测试：新增 5 项（角色标题不属于回复、空轮次不是完成、图还在画就继续等且**不关标签页**、
图片未加载完继续等、空轮次到硬上限才失败），并把 DOM 桩的 4 项自测加入。全套 **108 项通过**。

未验证：真实网页上图片渲染完成后的正向路径。

### 2026-10-01 · 从生图插件改造为通用 QQ ↔ ChatGPT 网页桥接器

方向变更，设计见 `docs/design-v1.md`。目标从「QQ 发提示词、取回生成的图片」变成
「把 QQ 消息原样送进 ChatGPT 网页、把回复原样送回 QQ」。

按 P0–P5 分阶段实施，每阶段结束 `npm test` 全绿：

- **P0** 打 tag `v0.1.0-image-baseline` 冻结生图版本作为回滚点。
- **P1** 新增两个纯函数模块：`core/message.cjs`（QQ 元素 → 有序片段）与
  `lib/reply.cjs`（片段校验、围栏还原、按段落拆分、总量截断）。
  裁剪空白时刻意不跨越换行 —— 否则用户粘贴的代码第一行缩进会被吃掉。
- **P2** 队列负载换成 `segments` 并带 `version: 2`；桥接升级到协议 v2。
  生图时代的任务目录载入时跳过但不删除（那是用户的数据）。
- **P3** 扩展改造：删掉提示词包装与 `QQ绘图任务 <id>` 标记、新增 `readReply` 序列化、
  回复图片走 `POST /result-asset` 二进制上传、**删除全页兜底扫描**。
- **P4** `index.cjs` 用兜底转发中间件取代自然语言路由；管理命令统一 `桥接` 前缀；
  删除 `core/intent.cjs`、`core/natural.cjs`。
- **P5** 同步 README、架构、运维、配置示例与扩展界面文案。

关键决策（用户 2026-10-01 拍板）：

1. 管理命令统一 `桥接` 前缀。通用桥接下每条消息都要转发，短命令名会抢走用户本来想聊天的那句话。
2. 纯图片消息先按空正文提交，仅在发送按钮持续不解锁时补**一个空格**，不写标记、不写说明性提示词。
3. 包名与插件键保持 `codex-image-local` 不变，改名放 V2，避免与功能重构混在一起难以定位问题。

行为上的重要变化：

- **模型的内容拒绝不再是失败。**「抱歉，我不能…」在通用桥接里就是它该给的回复，会原样回传。
  旧的 `failureInfo` 会把它判成 `refused` 然后丢掉，用户就看不到自己真正想要的内容。
- 回合识别不再往提示词里写标记。改用「提交前的用户轮次计数」，页面渲染差异只影响文本比对，
  不影响「已提交」的判断；连接器自己的残留草稿靠扩展存储里的 `draft` 记录识别。
- 回复按片段顺序发送：文本批次与图片交替，**图片在回复里的位置不会丢**。
- 桥接把实际监听端口写入 `data/web-bridge-port`。

测试从 73 项增至 100 项。新增覆盖：片段顺序与裁剪、回复序列化（标题/列表/引用/表格/代码语言/链接）、
按段落拆分不切断代码块、回复图片的二进制上传与序号约束、未上传 asset 的整条拒收、
扩展的计数式回合识别与原文提交，以及此前缺失的**「回复按顺序发回 QQ」闭环**。
扩展测试不再按函数名切源码字符串取内部函数，改为提供真实形状的 DOM 桩
（`test/helpers/dom.cjs`）后在沙箱里直接调用 `pageStep`。

未验证：真实网页上的回复序列化（尤其多图与长代码块）、真实 QQ 的转发与回传、群聊 @ 的端到端。

### 2026-09-29 · 修掉「带参考图时返回原图」

现象：群聊里发「参考图 + 文字」请求绘图（任务 `02c2fa8e036a`），任务正常 ready，但回传到群里的是
**请求用的那张参考图**，不是生成的图。

这次 `result-probe.json` 直接给出了现场（该文件正是上一节为这类问题加的）：

```
turns: 0
roleNodes: ["h4@assistant"]
images:
  {alt:"",        chrome:true,  w:512,  h:512,  picked:false, src:"data:"}   ← 账号头像，已正确排除
  {alt:"用户附件", chrome:false, w:1053, h:1920, picked:true,  src:"blob:"}  ← 被选中：参考图
assistantHtml: …<h4 data-conversation-role="assistant">…<div data-testid="generated-image-gallery">
               <div class="Placeholder-M5Cmfu" …></div>…  ← 图还没加载，只有占位符，没有 <img>
```

定位（三条同时成立才会出错）：

1. **`[data-testid^="conversation-turn"]` 在当前 DOM 里已失效**（`turns: 0`），
   所以 `lastAssistant` 退到 `h4.parentElement`（即 assistant 的 `div.block-*`）。
2. assistant 轮次里此刻**只有占位符、没有 `<img>`**，于是 `scoped` 为空 → 走**全页回退扫描**。
3. 全页扫描当时只排除 `stale`（用户气泡内 + 除最新轮次外的其他轮次），
   而 `[data-user-message-bubble]` **也没有命中那张参考图**（probe 里 `inUser: false`），
   参考图 1053×1920 又满足尺寸门槛 —— 于是被当成本轮结果取回。

改动（`browser-extension/background.js`）：

- 全页回退扫描收窄为**只接受页面自己归入 generated-image 画廊的图**
  （`[data-testid*="generated-image" i]`）。标记一旦消失，扫描找不到图就继续等待 ——
  **失败方向是「等」而不是「返回错图」**。
- `looksGenerated` 增加一道：`alt`/`data-testid` 含 `附件`/`attachment` 的一律不算生成结果。
  这道在「轮次容器连用户消息一起包住」时是唯一的防线（probe 已证明用户气泡选择器靠不住）。
- `probeDom()` 增加 `userNodes`（`[data-user-message-bubble]` 命中数）与 `assistantAnchor`，
  下次能直接看出用户侧选择器是否还有效。

测试：新增「the attached reference image is never returned while the turn has no picture yet」，
并用真实 DOM 形状构造（`turns: 0`、`h4` 角色节点、占位符画廊、参考图已在页面上）。73 项全通过。
分别关掉两道防线做了反向验证：关 `附件` 判断该用例失败，关画廊判断
「a generated image is found by its shape」失败，确认都不是空转。

未验证：真实页面上图加载完成后的正向路径（本轮只验证了「未加载时不再返回错图」）。

### 2026-09-29 · 修掉「返回账号头像当生成结果」

现象：群聊里 @ 机器人画图（任务 `f948b24235f4`），返回的却是**账号头像**（512×512 的帕秋莉贴纸图）。
同一时段群里的「香蕉君」（`cbc54f70dda4`，1254×1254）与私聊的纯图任务（`43e197d5eaa9`，1672×940）都正常，
说明**与群聊无关**，是图片识别路径上的竞态。

定位：

- ChatGPT 会先渲染**空的 assistant 轮次**，图片要几十秒后才出现。此时
  `scoped = lastAssistant.querySelectorAll('img')` 为空，代码回退到全页扫描。
- 全页扫描只排除 `stale`（用户气泡内、以及除最新轮次外的其他轮次）。**账号头像在页面头部，
  不在任何会话轮次内**，所以既不在用户气泡里、也不在任何轮次里 —— `stale` 判不出来。
- 头像的 `alt`/`data-testid` 不含 avatar/profile 等字样，尺寸 512×512 又满足 `width>=200 && height>=200`，
  于是通过 `looksGenerated`。轮询一旦落在「assistant 轮次已出现、图片还没出现」的窗口内，
  头像就被当成本轮结果立即取回。

改动（`browser-extension/background.js`）：

- 新增 `isChrome(img)`：命中 `header`/`nav`/`aside`/`[data-testid*=profile|sidebar]`，或存在 `main`
  但不在 `main` 内的图片，一律不算生成结果。页面头部与侧栏的头像由此被排除。
- 新增 `inUserTurn(img)`：用户自己那一轮里的图片永不作为结果（用户气泡旁边的头像走这条），
  并同时用于 `scoped` 过滤与 `stale` 判定，防住「最新 assistant 轮次解析成包住用户轮次的容器」这种情形。
- `probeDom()` 的每张图片增加 `inUserTurn`、`chrome`、`picked` 三个字段，下次再出问题可以直接看
  是哪张图被选中、为什么。
- 顺带补上可审计性：只要结果来自全页回退扫描，扩展就把同一份快照随 `/result` 上报，桥接写入任务目录
  `result-probe.json`（`dom-probe.json` 仍只在失败时写）。之前这个 bug 会把任务标成 ready，
  失败快照永远不会产生，出问题时无从下手。

测试：新增「the signed-in avatar in the page chrome is never returned as a result」与
「a fallback-scan probe rides along with a result so a wrong picture stays auditable」（72 项全通过）。
把 `isChrome` 判断关掉后前者确实失败，确认断言不是空转。

未验证：真实页面上「空 assistant 轮次 + 头像已加载」这个窗口期是否已被完全覆盖（需要在真实环境再跑几次）。

### 2026-09-29 · 支持群聊（@ 机器人后绘图）

新增 `groupChat` 配置项，默认 `false` 保持历史行为。设为 `true` 后，群里任何成员 @ 机器人即可绘图，
生成结果直接发到群里；`allowedUsers` 不参与群聊判定（群里的 openid 是群作用域 id）。

改动：

- `src/index.cjs` 的 `authorized` 从「必须 `isDirect`」改为分场景：私聊查 `allowedUsers`，群聊查
  `groupChat && session.stripped.appel`。三条入口（图片中间件、命令、自然语言回退）共用这一个闸门，
  所以群聊里未被 @ 的图片消息也自动被挡，不需要额外判断。
- `src/core/natural.cjs` 拆出 `text(s)`：群聊读 `session.stripped.content`。原来的
  `if (s.elements?.some(e => e.type !== 'text')) return;` 会把群聊 @ 消息（以 `at` 元素开头）直接判死，
  且手工拼接 `elements` 会把 @ 混进提示词。
- 测试：`test/index.test.cjs` 的 `session()` 支持 `stripped`；原「群聊一律拒绝」断言改为「@ 也不够，
  还要 `groupChat` 打开」；新增群聊无 @ 拒绝、群聊 @ 后落库到 `qq:<群号>`、群聊 @ 后走自然语言路由三项。
  实测把闸门关回去后后两项会失败，确认断言不是空转。
- 文档：`README.md`、`koishi.example.yml`、`docs/architecture.md` 新增「授权与群聊」小节。

未验证：真实 QQ 群里的 @ 触发与图片回传尚未端到端验收。

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
