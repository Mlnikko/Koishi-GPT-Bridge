# 运维

## 部署位置（当前为 Windows）

- 项目位于 `D:\Projects\Koishi\koishi-codex-image-bridge`。
- Koishi Desktop 主程序 `C:\Program Files\Koishi\Desktop\bin\koishi.exe`；实例目录
  `%APPDATA%\Koishi\Desktop\data\instances\default`，配置在其 `koishi.yml`。
- 插件通过 node_modules 中的符号链接加载，**不是** npm 依赖：
  `<实例>/node_modules/koishi-plugin-codex-image-local -> D:\Projects\Koishi\koishi-codex-image-bridge`。
  因此改代码后重启实例即生效，不需要重新链接，也不需要重装。
- QQ 适配器密钥仍保留在 Koishi 实例的 `.env`，不存放在开发项目内。

本工具目前只保证 Windows 可用。`package.json` 的 `engines` 要求 Node ≥ 20。

## 重启

**修改脚本或配置后必须重启 Koishi 实例，插件没有热重载**；重启前请确认没有正在生成的任务。

Windows 上没有 `koi` 命令（`C:\Program Files\Koishi\Desktop\koi.exe` 是 GUI 启动器，`bin/` 下只有 `koishi.exe`
和 `yarn.cjs`），重启只能在 Koishi Desktop 的托盘/界面里手动操作实例。
macOS 上的 `/Applications/Koishi.app/Contents/MacOS/koi restart default` 在这里不适用。

桥接令牌固定保存在 `data/web-bridge-token`，重启会复用同一个值，因此不必重跑 `setup-web-bridge.cjs`。

## 判断运行中的实例是否加载了新代码

用正确令牌请求：

```bash
curl -H "x-bridge-token: $(cat data/web-bridge-token)" \
     "http://127.0.0.1:5141/input?id=probe&i=0"
```

- 返回 `409 {"error":"job is no longer active"}` → 已加载含 `/input` 的新代码。
- 返回 `404 {"error":"not found"}` → 仍是旧代码，需重启。

注意：带正确令牌的请求会刷新在线时间戳，使桥接在 90 秒内认为扩展在线。

更直接的办法是看日志，每次加载都会留一行：

```bash
grep -n "loader apply plugin codex-image-local" "%APPDATA%\Koishi\Desktop\data\logs\"*.log
```

日志文件名按启动日期命名，可能不是当天，**取 mtime 最大的那个**再判断，不要按日期猜。
实测改 `koishi.yml` 不会新增该行——Koishi 不热重载本插件的配置，改配置和改代码一样都要重启实例。

## 连接器的安装与维护

安装：运行 `node scripts/setup-web-bridge.cjs`，在 Chrome 扩展管理页开启开发者模式，加载 `browser-extension` 文件夹。
扩展只申请 ChatGPT 页面、本机 5141 端口、脚本注入、扩展存储和定时任务权限。
`browser-extension/config.js` 与 `data/web-bridge-token` 保存随机本机连接令牌，均需私密保存；
两者都已 gitignore，不含 QQ 或 ChatGPT 登录凭据。

重启电脑后启动 Chrome（扩展须保持启用并保留 ChatGPT 登录）和 Koishi 即可。
扩展更新后在 Chrome 扩展管理页点击刷新。

若把 `webBridgePort` 改成非 5141，需要重跑并带上端口：
`node scripts/setup-web-bridge.cjs <端口>`。

## QQ 适配器版本要求（图片消息不能带空行）

图片发到 QQ 后多出一行空行，根因不在本项目，而在 `@satorijs/adapter-qq`：**4.12.0 及更早版本**
在发送纯媒体消息（`msg_type=7`）时，若文本内容为空会强行填一个空格：

```js
if (this.attachedFile) {
  if (!data.content.length) data.content = " ";   // 4.13.0 起已删除
  data.media = this.attachedFile;
  data.msg_type = Message.Type.MEDIA;
}
```

QQ 会把这个空格渲染成一行空行。**4.13.0 起上游删掉了这一行**，所以要求
`@satorijs/adapter-qq >= 4.13.0`（当前实例为 4.14.0）。

- QQ 官方文档的 `msg_type=7` 示例请求体**根本不含 `content` 字段**，空格只是旧版的防御性补丁。
- 本项目侧无需任何改动：`deliver()` 只发一条 `<img/>`，成功时不返回额外文本，也不会二次发送。
- 编码器对 `img` 是「先 flush 再设 attachedFile、之后不再 flush」，所以纯图片消息只产生一条出站消息。

## 实例依赖由 market 插件自动升级（重要）

实例启用了 `market` 插件，它**在每次实例启动时用 yarn 升级一批依赖**；而每次升级都会让
Koishi Desktop 重启实例，于是形成「升级 → 重启 → 再升级」的级联，直到所有包都到最新为止。
实测一次重启后连续升级了 `@koishijs/plugin-market`、`koishi-plugin-adapter-onebot`、
`@koishijs/plugin-adapter-qq` 等，约 70 秒后自行稳定。

由此得到的规矩：

- **不要手动对实例跑 `yarn up` / `yarn up -R`**。它会改动 `node_modules`，触发 Desktop 重启，
  再触发 market 的升级级联。需要升级某个传递依赖时，等实例自己重启即可。
- 实例 `package.json` 的版本号由 market 维护，**手工写入的 `resolutions` 会被它删掉**。
- 升级期间实例会反复重启、QQ 连接短暂中断，属预期现象。判断是否稳定的办法是看
  `<data>/logs/*.log` 的 mtime 是否停止增长——静默 25 秒以上即可认为稳定。
- 升级某个包但不想动整个依赖树时，`yarn up` 只认直接依赖，`-R` 会连带升级依赖它的包
  （例如升级 `@satorijs/adapter-qq` 会顺带把 `@koishijs/plugin-adapter-qq` 和 `koishi` 一起抬上去）。

## 实现注意

- 结果图与参考图校验使用纯 JavaScript 解析 PNG 文件头，不依赖 macOS 的 `sips`。
- 插件不 spawn 任何子进程，因此不存在子进程环境泄漏或跨平台进程终止问题；后续如需引入外部命令，
  必须重新处理「不继承 Koishi 密钥」与「Windows 无进程组信号」这两件事。
  `test/architecture.test.cjs` 会拦截子进程相关标识符的回归。
- 跨盘落盘已验证：`os.tmpdir()` 在 C 盘、项目在 D 盘时，`queue.moveFile()` 的 rename 由 Windows 的
  `MoveFileEx(MOVEFILE_COPY_ALLOWED)` 直接跨盘成功，暂存源会被清理。`EXDEV` 回退分支在本机不会触发，
  保留以防 Linux 上 tmp 与项目分属不同挂载点。
- 生成等待策略：**文本稳定不等于回答结束**。ChatGPT 会先渲染空的 assistant 轮次，长回复还会持续流式输出，
  所以只有在页面不再「忙」（没有停止按钮、没有生成中字样）且文本稳定 3 秒后才读取回复；
  无论页面多忙，240 秒硬上限的判断都放在「看起来还在忙」分支之前，避免永远忙的页面把桥接超时耗光。
- 回复图片识别按特征（`blob:`/`data:`/`https` 来源且长宽 ≥200 的位图）而不是单一 `data-testid`，
  并且**只在最新 assistant 轮次内查找**。原来的全页兜底扫描已经删除 —— 它正是「返回账号头像」
  （任务 `f948b24235f4`）与「返回用户参考图」（任务 `02c2fa8e036a`）两次事故的根源。
  选择器失配时扩展找不到图会继续等待，失败方向是「等」而不是「返回错图」。
- 回合识别不写任何标记进提示词：扩展记录提交前的用户轮次数量，用计数判断消息是否已经落到页面上。
  页面把消息渲染成别的样子（markdown、折叠）只会让文本比对失配，不会影响「已提交」的判断 ——
  计数是主信号。连接器自己的残留草稿靠 `chrome.storage.local` 里的 `draft` 记录识别，不靠正文里的标记。
- 桥接监听成功后会把实际端口写入 `data/web-bridge-port`。用 `port: 0` 时端口由系统分配，
  这个文件是外部（运维脚本、测试）确认端口的唯一途径；固定端口时也可用它核对。
- 本仓库不含 `probe/` 目录（`.gitignore` 已忽略），文档中提到的探针脚本只存在于原 macOS 机器上，需另行重建。

## 排障

参考图上传优先使用接受对应图片格式的文件输入框，找不到时使用输入框粘贴事件。
扩展等待全部附件出现并且上传进度、图片加载结束后才填写正文；附件卡片与其缩略图只计一次。
上传或提交确认阶段失败也会尝试保存 `data/jobs/<id>/dom-probe.json`，其中包含阶段、附件数、
预期附件数、上传状态、文件输入框接受类型和发送按钮状态。若页面已无法访问，仍保留原始失败原因。
更新此逻辑后需在 Chrome 扩展管理页重载连接器；仅重启 Koishi 不会更新正在运行的扩展。

最终回复和失败原因不受 `/logs off` 影响。QQ 适配器的被动回复窗口约 298 秒，插件按原消息
时间计算剩余等待预算（包含下载和排队），最迟约 270 秒请求停止网页，再预留最多 15 秒等待停止确认。
最终反馈不会因为旧的 255 秒判断被静默跳过；发送失败会保存 `feedbackDelivery: failed` 和
`deliveryError`，可用「桥接状态 任务编号」查询，已取回的回复可用「桥接重发 任务编号」获取。
扩展的加载、生成中、新轮次未出现和旧轮次未更新分支也执行超时检查。

| 现象 | 排查方向 |
| --- | --- |
| 任务失败且原因为「连接器未在线」 | Chrome 未启动、扩展被禁用，或超过 90 秒没有轮询。检查 Chrome 与扩展状态。 |
| 任务失败且原因为认证 | ChatGPT 网页未登录，在 Chrome 中登录后重试。 |
| 任务失败且原因为额度 | 网页额度或速率受限，以账号实际限制为准。 |
| 参考图任务失败且提到附件 | 页面上的文件选择器或附件缩略图选择器可能已变化。连接器会明确失败，不会退化成纯文字请求。 |
| 改了代码但行为没变 | 实例未重启。用上面的 `/input` 探针或日志确认。 |
| 端口被占用 | 5141 已被其他进程监听，改 `webBridgePort` 并重跑 `scripts/setup-web-bridge.cjs`。 |
| 图片消息多出一行空行 | `@satorijs/adapter-qq` < 4.13.0 会给纯媒体消息填 `content: " "`。重启实例让 market 把它升到 4.13+ 即可，本项目无需改动。 |
| 网页已经结束回答，任务却报「没有读取到可回传的内容」 | 先看 `data/jobs/<id>/dom-probe.json`（扩展在失败时附带的页面结构快照：轮次数、角色节点、每张图的来源/尺寸/是否在用户气泡内/是否属于页面框架/是否被选中、最新轮次截断 HTML）。据此判断是回复还没渲染完、Markdown 容器选择器失配，还是 `h4[data-conversation-role="assistant"]` 已经改名。 |
| 回复里少了图片，或者图片不对 | 只在最新 assistant 轮次内找图，所以先确认图确实渲染在该轮次里。任务目录的 `result-probe.json` 记录了每张图的 `picked`/`chrome`/`chromeReason`/`inReplyTurn`/`alt`：`chromeReason` 直接说明是**哪条规则**把哪张图判掉的（`ancestor:header` 是页面框架，`outside-main` 是会话不在 `<main>` 内），`alt` 含 `用户附件` 说明是**你自己发出去的参考图**。`turns` 为 `0` 说明 `[data-testid^="conversation-turn"]` 已失效，`assistantAnchor`、`userNodes`、`main` 能进一步说明选择器是否还认得出来。改完扩展必须在 `chrome://extensions` 手动重载。 |
| 任务卡在「ChatGPT 已接收，正在生成回复」，最后报「未检测到本轮图片」 | 图片识别没找到图，扩展会一直等到 240 秒硬上限（这是刻意的：宁可等也不返回错图）。看 `dom-probe.json` 的 `images`：如果里面有一张尺寸正常的 `blob:` 图但 `picked:false`，问题在筛选规则，看同一行的 `chromeReason` 即可定位。 |
| 纯图片消息发不出去 | 空正文提交后如果发送按钮一直不解锁，扩展会在 5 秒后补**一个空格**再试一次。仍失败说明页面结构变了。 |
| 输入框里留着上一次的草稿 | 只有与扩展自己记录的 `draft` 完全一致的草稿才会被自动清掉，其余内容一律不动并提示你手动清空。 |
| 实例反复重启 | `market` 插件在逐个升级依赖，每次升级都会重启实例。等日志静默即可，不要在此期间手动改 `node_modules`。 |
| 想回收磁盘 | 每个带图任务约占 5–12 MB。设置 `retentionDays` 后重启，终态任务会在启动时与每 6 小时被清理。 |
| 想知道桥接实际用的端口 | 看 `data/web-bridge-port`，启动时由桥接写入。 |

## 验证命令

```bash
npm test          # 等价于 node --test "test/**/*.test.cjs"
```

覆盖消息元素 → 片段的顺序与裁剪、回复片段校验与按段落拆分、去重、串行取消、重启、
参考图下载边界、桥接鉴权与协议校验（含回复图片的二进制上传与序号约束）、
扩展的提交顺序与回合识别、回复序列化与图片选择，以及分层与依赖规则的守卫。


## 0.3.0 升级与故障恢复

升级包含插件和 Chrome 扩展两部分；只重启一边不能启用全部修复。等待当前任务结束后，重启 Koishi 实例，并在 Chrome 扩展管理页重新加载本项目扩展。令牌和端口不变时无需重跑 setup 脚本。package.json 和扩展清单版本应均为 0.3.0。

故障定位按实际阶段检查任务目录，避免把所有问题统称为“网页没回 QQ”：

1. 没有 job.json：检查授权、群聊 @、输入校验、下载错误和 Koishi 日志。
2. queued/running：查看 progress、扩展弹窗和专用标签页；关闭/刷新该页可能使提交状态不可判定。
3. failed：查看 errorCode、failure.json、dom-probe.json；不要仅凭画面有旧回复就认定本轮成功。
4. 存在 result.json：结构化结果已持久化。进程中断后重启会把对应未完成任务恢复为 ready；用“桥接重发 任务编号”从当前 QQ 消息建立新的回复窗口。
5. ready 且 delivery=failed/sending/pending：查看 deliveryCursor、deliveryError 和 deliveryPlan。显式重发从未确认片段继续；sent 任务显式重发会从头发。
6. QQ 收到截断提示：读取本机 reply.md；重发不会绕过长度上限。

sendTimeoutMs 默认 20000；它限制等待确认，不会取消适配器已经发出的网络请求。因此超时的一段可能稍后到达，不进行自动盲重试。状态命令显示已确认段数，便于与 QQ 实际消息对照。

建议真实验收覆盖：短文字、纯图片、图文混合、引用图文、连续两轮同会话、长单行/代码、多段回复、生成中取消、扩展短暂断线后恢复、QQ 发送拒绝后手动重发。分别核对网页新增用户轮次、回传内容、QQ 段数与任务记录。本轮自动化结果不能替代这一步真实验收。
