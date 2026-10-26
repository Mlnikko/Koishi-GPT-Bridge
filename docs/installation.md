# 安装、扩展配对与数据迁移

需要 Koishi 4.18.x（声明兼容 `^4.18.0`）、Node 20+，以及已连接的 QQ 适配器。
网页模式还需要同机 Chrome 120+ 和已登录的 ChatGPT；工作模式的原生技能须先在网页账号安装。
LM Studio 模式直接访问同机模型服务，无需网页登录。插件不启动浏览器或模型进程。

## 从市场或 npm 安装

在 Koishi 插件市场搜索 `chatgpt-bridge`，包名为 `koishi-plugin-chatgpt-bridge`。
首次发布或新版本收录可能延迟。独立 npm 管理的 Koishi 实例也可在实例目录安装：

```bash
npm install koishi-plugin-chatgpt-bridge@0.4.3 --registry=https://registry.npmjs.org
```

Koishi Desktop 实例的依赖由其插件市场管理，等待市场收录后安装。
启用插件前，在配置表单中填写 `allowedUsers`：

- 填入允许私聊使用的 QQ openid；`*` 表示所有私聊用户。
- 群聊默认关闭。开启 `groupChat` 后，任何群成员 @ 机器人即可调用，不受私聊白名单限制。
- 数据目录、外部技能库、网页端口、模型连接、超时和消息大小均可在表单中配置。
- LM Studio 认证令牌使用隐藏输入；仍应妥善保管实例配置和运行数据。

QQ 适配器由实例单独安装、配置。本插件只接收 QQ 消息，不提供平台登录；图片消息要求底层
`@satorijs/adapter-qq >=4.13.0`，详见 [运维说明](operations.md#qq-适配器版本要求图片消息不能带空行)。

## 安装本地发行包进行验收

先在本仓库运行：

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

最后一条命令会生成 `dist/koishi-plugin-chatgpt-bridge-0.4.3.tgz` 和验证记录。
它在临时目录安装该 tarball 和真实 Koishi，验证加载、配置约束、HTTP 健康检查、扩展生成与配对。
不向网页或 QQ 提交消息。

手动验收时，在一个独立的 Koishi 测试实例目录安装发行包，路径换为本机实际位置：

```bash
npm install "/绝对路径/koishi-plugin-chatgpt-bridge-0.4.3.tgz"
```

此命令用于隔离的 npm 测试实例；已有 Koishi Desktop 实例的依赖应由其插件市场管理。
不要在运行中的正式实例混用包管理器来替换依赖。

## 生成并加载 Chrome 扩展

先启动 Koishi 插件，再在 **实例目录（koishi.yml 所在目录）**运行：

```bash
npx --no-install koishi-gpt-bridge-setup
```

默认生成目录为 `<实例>/data/codex-image-local/browser-extension/`。
命令只复制发行包中的扩展代码，再使用这台机器的数据目录生成 `config.js`。
已有令牌保持不变，终端不会输出令牌内容。生成的目录可重复更新；其他非空目录不会被覆盖。
该目录由工具管理，请将个人文件放到别处。

在 Chrome 的 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」，加载命令输出的目录。
更新后重复生成并点击重新加载。保持 Chrome 和 Koishi 运行，打开弹窗检查两端版本和连接。

从其他目录运行时，直接指定实例内的安装脚本和实例位置：

```bash
node "/实际路径/Koishi 实例/node_modules/koishi-plugin-chatgpt-bridge/scripts/install-browser-extension.cjs" --instance-dir "/实际路径/Koishi 实例"
```

自定义配置须与 Koishi 一致；相对 `dataDir`、`skillsDir` 均从实例目录解析：

```bash
npx --no-install koishi-gpt-bridge-setup --data-dir "data/my-gpt" --port 5142
npx --no-install koishi-gpt-bridge-doctor "data/my-gpt"
```

`--output` 可指定另一个空目录或由本工具生成的目录。扩展不得导出到 npm 管理的插件包目录。
端口默认读取实际数据目录里的 `web-bridge-port`，无记录时用 5141；若配置端口为 0，须先启动插件取得实际端口。

换电脑时重新生成本机扩展配置。扩展 `config.js` 和数据目录里的 `web-bridge-token` 均为私密文件，
不可放入公开发行包、截图或共享附件。

## 旧版源码链接部署升级

旧版默认把会话、原图、预设、技能和令牌保存在源码项目的 `data/`。
继续通过源码链接加载时，插件检测到这些记录会沿用原目录，并在实例日志中提示。
新旧目录都有记录且没有显式 `dataDir` 时会停止加载，要求选择目录，不会合并或静默切换会话。

**将源码链接切换成 npm 安装之前，先确定实际数据目录，并选择以下一种方式：**

1. 保留原数据位置：在 Koishi 配置中将 `dataDir` 设置为原目录的绝对路径，再切换包来源。
   保留该目录以及它所在的旧项目，后续版本继续使用同一份会话和令牌。
2. 迁至实例目录：停止实例，确认旧桥接进程已结束，完整备份并复制原 `data/` 到
   `<实例>/data/codex-image-local/`。目标须为空，不要与另一份数据合并。
   将 `dataDir` 显式设置为该新路径，然后启动新版插件。原目录保留作备份。

切换后将 `koishi.yml` 中的旧配置键 `codex-image-local` 改为 `chatgpt-bridge`，保留配置值和实例后缀。
不要同时启用新旧两个配置，否则会同时监听同一端口和处理消息。

必须复制整个数据目录，包括 `conversations.json`、`preferences.json`、`jobs/`、`lmstudio/`、
`prompts/`、`presets/`、`skills/` 和 `web-bridge-token`；仅复制会话 JSON 会缺失原图或任务结果。
外部 `skillsDir` 不属于这份目录，保持其原路径或单独调整配置。

重跑扩展生成命令，传入同一个 `dataDir`，加载或重载输出的扩展，再执行 doctor。
数据复制保留原令牌；不要另建空目录运行旧安装脚本来生成第二个令牌。
最后在 QQ 查看 `/chat`、`/status`，确认原会话、模型、技能和预设仍可恢复，再验证一条新消息。

本次发布适配不会自动移动或删除任何现有部署的数据，也不会重启正在运行的实例。

## 开发时使用源码链接

仍可将源码链接至实例的 `node_modules/koishi-plugin-chatgpt-bridge`，使用 `chatgpt-bridge` 配置键。
已有 `koishi-plugin-codex-image-local` 链接可继续使用旧配置键，切换时按上面的迁移步骤处理。首次安装需在源码目录运行
`npm ci --ignore-scripts`，安装用于配置表单的 Koishi 依赖。

在源码目录使用：

```bash
npm run setup:extension -- --instance-dir "/实际路径/Koishi 实例"
```

旧的 `node scripts/setup-web-bridge.cjs [端口] [dataDir]` 保留原行为：默认使用源码 `data/`，
把配置写入源码 `browser-extension/config.js`。已有部署可以继续使用；新安装优先使用实例目录导出方式。

## 安装后验收

1. doctor 显示插件为 0.4.3、浏览器在线且空闲；Chrome 弹窗确认扩展也为 0.4.3。
2. QQ 私聊验证普通文字、图片、同一会话续聊及 `/new`；群聊启用时验证 @ 门槛。
3. 工作模式验证网页原生技能；本地模式验证模型选择和上下文保存。
4. 重启后确认原会话及令牌保持，升级包后扩展目录仍可重新加载。

自动化打包验收覆盖隔离 Koishi、配置、文件和 HTTP 边界；真实 Chrome、QQ、模型及 Windows 现场需分别验收。
