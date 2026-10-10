# 客户端 ChatGPT 单聊天文字原型

已完成两个真实客户端轮次的文字提交、连续上下文验证和回复回传。默认仍走原来的网页接入，
客户端后端需要显式配置并在指定用户的私聊中执行 `/desktop on`。

## 运行边界

本原型需要一个正在运行、具有 `codex-app-tools` 聊天工具的 Codex 工作聊天。
执行器通过 `send_message_to_thread` 向指定的普通 ChatGPT 聊天提交文字，通过 `read_thread` 读取本轮完整回复。
Node 插件只运行本机 HTTP 服务，不能单独调用这些客户端工具。

本机实验中，外部 Node 进程连接客户端工具入口因缺少代码签名身份而被拒绝；客户端界面自动化也被工具拒绝。
本实现采用工作聊天中已有的受授权工具，没有绕过这些限制。因此目前是受控原型，尚不是无人值守后台服务。
结束执行器所在的工作聊天后，新的客户端任务会提示执行器离线。

仅支持文字，沿用客户端聊天当前模型设置。图片、自动新建普通聊天、切换客户端推理程度、
停止客户端实际生成尚未接入。`/stop` 只停止本任务等待；已经提交的消息可能继续生成，需要在客户端确认。
超时、提交确认丢失或进程重启均不会自动重发未知是否已提交的消息。

## 配置与切换

在 Koishi 插件配置中追加以下字段，保留原来的网页配置：

```yaml
desktopThreadId: '6ac9ff70-0c00-83ec-997b-b61ed3668413'
desktopOwnerId: '你的 QQ openid'
desktopBridgePort: 5142
```

`desktopOwnerId` 必须是明确的单个用户，且已获 `allowedUsers` 授权；不能使用 `*`。
客户端端口必须与网页端口不同。客户端命令只对这个用户的私聊生效，群聊不会转到客户端。
缺省不配置这些字段时，不开启客户端服务，也不注册 `/desktop` 命令。

测试聊天标题为「客户端文字测试」，原始聊天 ID 如上。用户提供的分享链接
`https://chatgpt.com/share/6ac9ff8d-cb64-83ec-b99d-8e531cc020ec` 中的 ID 是分享 ID，不能作为目标聊天 ID。
使用其他目标时，操作者应先手动创建专用普通聊天，再通过客户端聊天工具核对原始 ID。

重启配置后的 Koishi 实例，启动执行器，然后在指定私聊执行：

- `/desktop on`：绑定当前本地会话，之后普通文字进入指定客户端聊天。
- `/status`：查看执行器是否在线，以及当前任务阶段。
- `/desktop off`：当前本地会话切回网页后端，原来的网页上下文保留。

单个客户端聊天只允许绑定一个本地会话，包括已经关闭或切回网页的历史绑定，避免不同话题混入同一客户端上下文。
客户端后端的 `/new` 默认创建网页会话；要更换客户端目标需由操作者调整配置并核对历史绑定。
已有明确推理程度的会话先执行 `/reasoning default`。

## 启动执行器

执行器不能通过 `node scripts/desktop-worker.cjs` 独立启动，因为它需要注入客户端工具。
在本项目的 Codex 工作聊天中，明确授权向指定普通聊天转发测试文字，并提供实际 `dataDir`。
工作聊天读取本文件和执行器代码后，可在 `functions.exec` 中按以下方式执行一轮。
`root` 应替换为配置实例实际的数据目录；独立验收使用自己的目录。

```js
const root = '/Users/mlnikko/Projects/Other/Koishi-GPT-Bridge/data';
const project = '/Users/mlnikko/Projects/Other/Koishi-GPT-Bridge';
const source = await tools.exec_command({
  cmd: 'cat scripts/desktop-worker.cjs', workdir: project, max_output_tokens: 7000,
});
if (source.exit_code !== 0) throw Error(source.output);
const mod = { exports: {} };
Function('module', source.output)(mod);
const api = async (endpoint, body) => {
  const input = JSON.stringify({ root, endpoint, ...(body === undefined ? {} : { body }) });
  const r = await tools.exec_command({
    cmd: "node scripts/desktop-transport.cjs <<'DESKTOP_REQUEST'\n" + input + '\nDESKTOP_REQUEST',
    workdir: project, max_output_tokens: 2200,
  });
  if (r.exit_code !== 0) throw Error(r.output);
  return JSON.parse(r.output);
};
const result = await mod.exports.workOne({
  api,
  readThread: args => tools.mcp__codex_app__read_thread(args),
  sendMessage: args => tools.mcp__codex_app__send_message_to_thread(args),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
});
text(result.id ? { id: result.id, received: true } : result);
```

`workOne` 在没有任务时返回 `{ idle: true }`；调用 `/state` 同时更新心跳，90 秒未更新视为离线。
接收多轮时，在同一个受授权执行器中串行调用，空闲时相隔约两秒；不要同时启动多个执行器。
运行范围和轮数由操作者授权，代码不会自行创建定时任务。
执行期间请勿在目标客户端聊天手工发送其他消息，以免本轮对应关系失效。

## 回复对应与恢复

每轮先读取历史轮次 ID，持久化 `prepared`，再持久化 `dispatching` 后调用发送工具一次。
阶段更新使用比较并交换校验，竞争的执行器无法重复领取发送阶段。
恢复到 `dispatching` 后只读取客户端，不再次发送。

读取时核对聊天类型、聊天 ID、本轮用户正文与消息 ID；出现额外用户轮次、历史边界丢失或工具截断时明确失败。
只有本轮已完成、聊天空闲，并且连续两次完整回复一致，才回传文字。
`desktop-receipt.json` 保存用户消息和助手消息 ID；`result.json` 原子写入成功后才确认结果接收。
后续沿用已有拆分、文本转义、QQ 回传进度与 `/retry` 流程，重发回复不会重新调用模型。

任务记录保存在配置数据目录的 `jobs/<任务编号>/`。`desktop-bridge-token` 为本机随机令牌，
执行器只从本机文件读取，不在工具输出打印。文件与原有网页记录使用同样的权限约束。

## 验收记录

2026-10-10 17:18:51（北京时间）完成独立验收：真实普通 ChatGPT 聊天、真实插件入口和队列、模拟 QQ 适配器。
测试使用随机口令，第二轮问题没有再次携带口令，准确读回第一轮上下文。

| 轮次 | 输入 / 检查 | 实际回复 |
| --- | --- | --- |
| 1 | 记住 `KOISHI-954af543d74a`，检查回复包含「已记住」 | 已记住。若需跨对话保留，请在「设置 > 个性化 > 记忆」中启用记忆功能。 |
| 2 | 问上一轮口令，只返回口令 | `KOISHI-954af543d74a` |

两轮均核对回传适配器载荷与客户端回复一致（应用 Koishi 文本转义），队列发送状态均为 `sent`，
随后 `/desktop off` 成功切回网页。对应客户端消息 ID：

- 第 1 轮用户：`6fb54341-3294-4797-8a88-508b8fcbd774`；助手：`328bfef1-3e64-494f-ae8b-10f016367ac9`。
- 第 2 轮用户：`a8e779d5-ddb7-4bb3-97a9-4384cdccb282`；助手：`97589d6e-54ec-4822-b81f-21e60f5d4530`。

本机完整记录在 `data/desktop-live-20261010-04/validation.json`（数据目录被 Git 忽略）。
复验可启动以下独立插件夹具，然后在工作聊天执行器中轮询该数据目录，处理两轮：

```sh
node scripts/validate-desktop-live.cjs 6ac9ff70-0c00-83ec-997b-b61ed3668413 data/desktop-live-new
```

夹具要求数据目录尚不存在，临时端口由系统分配，完成后关闭自己的服务。
自动化测试另覆盖授权校验、发送阶段竞争、未知提交不重发、回复对应、取消后迟到结果、
插件入队和回复回调，以及切回网页继续执行。

上述独立夹具验收使用模拟 QQ 适配器。随后完成了下面的真实 QQ 验收；Windows 执行器仍未验证。

## 真实 QQ 验收

2026-10-10 17:34—17:42（北京时间），按用户授权在 QQ 机器人「苏打哒」私聊中完成验收。
实际 Koishi 配置仅追加客户端目标、单个私聊用户和端口，配置原文已在私有数据目录备份。
重启 `default` 实例后，使用独立本地会话「1010」（`272300d5`），没有改动原会话的网页上下文和推理程度。

| 检查 | 结果 / 凭据 |
| --- | --- |
| 真实 QQ → 插件 → 普通 ChatGPT 聊天 → QQ | 任务 `fb623ea81642`；QQ 收到「已记住」回复，客户端用户消息 `04b18e95-9083-4713-93f8-b5ba5b79f7f3` |
| 同一客户端聊天的连续上下文 | 任务 `485a8bd8cd62`；第二轮没有携带口令，QQ 收到 `QQCLIENT-8F3D27` |
| `/retry` 不重新调用模型 | QQ 再次收到同一口令，客户端没有新增用户轮次 |
| 执行器离线时明确失败 | 任务 `f6fc0a06a30d`；QQ 收到执行器未连接提示，未提交客户端消息 |
| 重连后沿用上下文 | 任务 `a8b965fbcdea`；QQ 再次收到 `QQCLIENT-8F3D27` |
| 结束验收后恢复原会话 | `/desktop off` 成功，再切回「功能验收1009」（`9827419a`） |

三个成功任务均为 `backend: desktop`、`status: ready`、`delivery: sent`，逐轮核对了客户端用户与助手消息 ID、
入站正文、客户端回复、持久化结果和 QQ 窗口文本。从入队到完整结果落盘耗时分别为 69.1、68.3、67.8 秒。
目前客户端读取链路仍有等待，不能把本次验收视为低延迟或长期稳定性证明。

完整本机记录为 `data/desktop-qq-20261010/validation.json`，配置备份为同目录的 `koishi-before-desktop.yml`。
备份含实例配置，保持本机私有；不要提交或分享。验收执行器已经结束，测试会话和绑定记录保留，原会话已恢复。
网页服务继续运行，客户端目标配置已保留。

替代网页前仍需解决工作聊天执行器的常驻入口，并验证长时间运行、应用重启、睡眠唤醒、
长回复和真实发送失败后的恢复。当前原型没有独立受支持的客户端工具访问入口，不能仅删除网页后端就成为常驻客户端服务。
