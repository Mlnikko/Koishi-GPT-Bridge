# ChatGPT Bridge

把 **ChatGPT 网页和本机 LM Studio 接入 QQ**，支持连续聊天、看图、生图改图、原生技能和多话题管理。
网页模式复用已登录的 ChatGPT，无需 OpenAI API Key；能力和额度以账号为准。

[npm](https://www.npmjs.com/package/koishi-plugin-chatgpt-bridge) · [安装与迁移](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/installation.md) · [使用手册](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/user-guide.md) · [包内文件](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4)

## 三种模式

| 模式 | 命令 | 用途 |
| --- | --- | --- |
| 聊天 | `/mode 聊天` | 连续问答、图片理解，以及网页支持的生图、改图 |
| 工作 | `/mode 工作` | ChatGPT Work 任务与网页账号已安装的原生 @技能 |
| 本地 | `/mode 本地` | LM Studio 文字或视觉模型，支持角色预设与本机技能文本 |

三种模式各自保留历史和设置。直接发送文字、图片或引用消息即可，默认进入聊天模式。
网页会话失效时，确认消息尚未提交后会自动新建会话并重试一次。

## 安装

需要 **Koishi 4、Node.js 20+**，并先配置好 QQ 适配器。
网页模式还需要同机 **Chrome 120+**；本地模式需要启动 LM Studio 服务并加载模型。

1. 在 Koishi 插件市场搜索 `chatgpt-bridge` 安装。
2. 在插件配置中填写 `allowedUsers` 私聊白名单，启用插件。
3. 网页模式：在 **Koishi 实例目录（koishi.yml 所在目录）**运行：

   ```bash
   npx --no-install koishi-gpt-bridge-setup
   ```

4. 在 Chrome 打开 `chrome://extensions`，开启开发者模式，加载命令输出的扩展目录，并登录 ChatGPT。
5. 检查连接后，在 QQ 私聊机器人发送 `/help`：

   ```bash
   npx --no-install koishi-gpt-bridge-doctor
   ```

扩展与 Koishi 需要保持运行。更新后重新生成、重载扩展，并重启 Koishi。
旧版源码部署升级前，请按[迁移说明](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/installation.md)指定原数据目录。

## 使用示例

每行作为一条 QQ 消息发送，等待上一条完成后再发送下一条。

**聊天与改图**（需账号支持图像生成）：

```text
/mode 聊天
/new 插画
生成一张暖色水彩插画：窗边的白色陶瓷杯、绿植和一本书，无文字。
保留构图，把背景改成浅蓝色。
```

**网页原生技能**（需预先在网页安装同名技能）：

```text
/mode 工作
/skill summarize-text
请整理下面的讨论记录，列出结论和待办：……
```

**本地模型**：

```text
/model
/model 你的模型编号
你好，请介绍一下你自己。
```

本地模式返回文字；看图需要视觉模型。本机技能只加载 `SKILL.md` 文本，不执行附带脚本或工具。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/help`、`/help all` | 常用帮助、完整命令 |
| `/mode 模式` | 切换聊天、工作或本地 |
| `/new [名称]` | 新话题，沿用设置，旧话题保留 |
| `/chat [编号]` | 列出或切换话题 |
| `/status [任务编号]` | 查看连接和任务进度 |
| `/stop` | 停止当前任务 |
| `/retry [任务编号]` | 取回已有结果，不重新生成 |
| `/skill [名称]` | 查看或选择技能 |
| `/prompt`、`/draw 角色名` | 图片模板与生成 |
| `/preset` | 本地角色预设 |
| `/reasoning` | 网页推理设置；Work 支持按档位编号选择 |
| `/logs off` | 关闭过程通知，保留最终回复和失败原因 |

同一话题一次处理一条消息；用 `/new` 开始空白上下文，`/chat 编号` 切回旧话题。
技能、模板、预设的创建与管理参数见[使用手册](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/user-guide.md)。

## 配置与数据

- `allowedUsers`：私聊用户的 QQ openid 列表；`["*"]` 允许所有私聊用户。
- `groupChat`：默认关闭；启用后，群内任何成员 @ 机器人均可调用，结果在群内可见。
- `dataDir`：新安装默认 `<实例>/data/codex-image-local`，保存会话、任务和图片。
- `webBridgePort`：默认 `5141`，须与扩展一致；自定义配置参见[安装说明](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/installation.md)。

普通消息默认最多 1500 字、2 张参考图，每图 10 MB。更多选项见[配置示例](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/koishi.example.yml)。
消息按所选模式提交给 ChatGPT 或本机 LM Studio；数据保留在部署电脑的数据目录中。

## 更多文档

- [安装、扩展配对与旧版迁移](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/installation.md)
- [完整使用手册](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/user-guide.md)
- [重启、诊断与故障排查](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/operations.md)
- [架构与开发验证](https://app.unpkg.com/koishi-plugin-chatgpt-bridge@0.4.4/files/docs/architecture.md)

MIT License
