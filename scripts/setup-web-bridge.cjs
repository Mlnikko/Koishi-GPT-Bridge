'use strict';
// 生成 Chrome 扩展需要的本机配置（桥接地址 + 令牌）。
// 令牌与 Koishi 插件共用 data/web-bridge-token，因此重启 Koishi 不会失效，
// 也不需要重跑本脚本；只有在令牌文件被删除后才需要重新执行。
//
// 用法：node scripts/setup-web-bridge.cjs [端口]
// 端口需与 koishi.yml 里的 webBridgePort 一致，默认 5141。
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

// 本脚本位于 scripts/，项目根在上一层。
const projectRoot = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 5141;

const root = path.join(projectRoot, 'data');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });

const tokenFile = path.join(root, 'web-bridge-token');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });

const config = { url: `http://127.0.0.1:${port}`, token: fs.readFileSync(tokenFile, 'utf8').trim() };
const target = path.join(projectRoot, 'browser-extension', 'config.js');
fs.writeFileSync(target, `const BRIDGE = ${JSON.stringify(config)};\n`, { mode: 0o600 });

console.log(`浏览器连接器配置已生成：${target}`);
console.log(`桥接地址 ${config.url}；不含 ChatGPT 或 QQ 登录凭据。`);
