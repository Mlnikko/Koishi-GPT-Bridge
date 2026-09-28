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

## 实现注意

- 结果图与参考图校验使用纯 JavaScript 解析 PNG 文件头，不依赖 macOS 的 `sips`。
- 插件不 spawn 任何子进程，因此不存在子进程环境泄漏或跨平台进程终止问题；后续如需引入外部命令，
  必须重新处理「不继承 Koishi 密钥」与「Windows 无进程组信号」这两件事。
  `test/architecture.test.cjs` 会拦截子进程相关标识符的回归。
- 跨盘落盘已验证：`os.tmpdir()` 在 C 盘、项目在 D 盘时，`queue.moveFile()` 的 rename 由 Windows 的
  `MoveFileEx(MOVEFILE_COPY_ALLOWED)` 直接跨盘成功，暂存源会被清理。`EXDEV` 回退分支在本机不会触发，
  保留以防 Linux 上 tmp 与项目分属不同挂载点。
- 本仓库不含 `probe/` 目录（`.gitignore` 已忽略），文档中提到的探针脚本只存在于原 macOS 机器上，需另行重建。

## 排障

| 现象 | 排查方向 |
| --- | --- |
| 任务失败且原因为「连接器未在线」 | Chrome 未启动、扩展被禁用，或超过 90 秒没有轮询。检查 Chrome 与扩展状态。 |
| 任务失败且原因为认证 | ChatGPT 网页未登录，在 Chrome 中登录后重试。 |
| 任务失败且原因为额度 | 网页额度或速率受限，以账号实际限制为准。 |
| 参考图任务失败且提到附件 | 页面上的文件选择器或附件缩略图选择器可能已变化。连接器会明确失败，不会退化成纯文字请求。 |
| 改了代码但行为没变 | 实例未重启。用上面的 `/input` 探针或日志确认。 |
| 端口被占用 | 5141 已被其他进程监听，改 `webBridgePort` 并重跑 `scripts/setup-web-bridge.cjs`。 |
| 想回收磁盘 | 每个图片任务约占 5–12 MB。设置 `retentionDays` 后重启，终态任务会在启动时与每 6 小时被清理。 |

## 验证命令

```bash
npm test          # 等价于 node --test "test/**/*.test.cjs"
```

覆盖认证、错误分类、会话匹配、取消、自动提交防重、连接器旧草稿清理，以及参考图片的下载边界、落盘持久化、
`/input` 取图与「先附加后提交」的顺序，另含分层与依赖规则的守卫。
