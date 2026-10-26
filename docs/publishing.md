# 发行包准备与发布

本项目是独立 npm 插件包，无需转换为 Koishi 模板工作区或编译 TypeScript。
入口为 `src/index.cjs`，当前版本为 0.4.3，插件市场标记为「开发中」。
遵循 [Koishi 发布规范](https://koishi.chat/zh-CN/guide/develop/publish) 和
[npm 包文件规范](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files)。

## 已配置的发布边界

- 包名 `koishi-plugin-chatgpt-bridge`，市场名称及新安装配置键为 `chatgpt-bridge`。
  旧版源码链接切换时改用新配置键，数据迁移见安装说明。
- Koishi peer 依赖 `^4.18.0`；开发验证依赖锁定于 4.18.11，Node 要求 20+。
- MIT 许可证、作者、GitHub 仓库、问题反馈地址和搜索关键词。
- 通过 `files` 白名单只分发运行代码、扩展静态文件、安装/诊断脚本、示例和用户文档。
  运行数据、令牌、扩展本机 `config.js`、测试、开发探针和打包产物不进入发行包。
- 使用 `Config`/Schema 提供配置表单，`usage` 在 Koishi 控制台展示安装指引。
- 新安装运行数据与生成的浏览器扩展位于实例数据目录；旧版迁移见 [安装说明](installation.md)。

## 本地验证

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

`check:package` 实际生成 tarball，将它安装到含中文和空格路径的临时实例，启动真实 Koishi，
验证 Schema、生命周期、实例数据位置、HTTP 健康检查、扩展 CLI 生成与令牌配对及 doctor。
结束后关闭临时服务；不会向真实 ChatGPT 或 QQ 发消息。

通过后生成：

- `dist/koishi-plugin-chatgpt-bridge-0.4.3.tgz`：已验收的发行包。
- `dist/package-validation.json`：版本、Koishi/Node 版本、文件数、大小、SHA-256 和验证范围。

可用 `KOISHI_VERSION` 环境变量指定打包验收所使用的 Koishi 版本。
CI 配置为 macOS/Windows、Node 20/22/24；Node 22 额外执行发行包验收。
本地成功不代表远端 CI 或真实浏览器、QQ 回传已通过。

## 发布新版本

仅在决定公开发布时执行这些步骤；准备发行包不会自动执行发布：

1. 在隔离测试实例完成 [安装后验收](installation.md#安装后验收)，复核 diff、MIT 及发行包清单。
2. 发布当天重新确认 npm 包名未占用，并确认当前 npm 账号有权发布。使用 npm 官方登录流程，凭据不写入仓库。
3. 检查 README、安装说明及插件/扩展版本与目标版本一致，再重新生成并验证发行包。
4. 发布已验证的同一 tarball：

   ```bash
   npm publish "./dist/koishi-plugin-chatgpt-bridge-0.4.3.tgz" --access public --registry=https://registry.npmjs.org
   ```

5. 查询 npm 的版本与 dist 信息，待 Koishi 插件市场收录后，再从市场安装至全新实例复验。

`prepublishOnly` 会在从源码目录执行 `npm publish` 时运行语法检查、测试和发行包验收；
直接发布已有 tarball 时，须先手动完成上述检查，不能依赖源码生命周期钩子。
README 的文档链接固定到同名版本标签，上传 npm 前应同步对应提交和标签。npm 凭据不进入仓库。
