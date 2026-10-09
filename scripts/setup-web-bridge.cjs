'use strict';
// 生成 Chrome 扩展需要的本机配置（桥接地址 + 令牌）。
// 令牌与 Koishi 插件共用 data/web-bridge-token，因此重启 Koishi 不会失效，
// 也不需要重跑本脚本；只有在令牌文件被删除后才需要重新执行。
//
// 用法：node scripts/setup-web-bridge.cjs [端口] [dataDir]
// 端口需与 koishi.yml 里的 webBridgePort 一致，默认 5141。
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

function setup({ projectRoot = path.join(__dirname, '..'), port = 5141, dataDir } = {}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('端口必须是 1–65535 的整数');
  // Use the same directory as the plugin; a relocated Koishi install must not
  // silently create a second token in the default project directory.
  const root = dataDir ? path.resolve(dataDir) : path.join(projectRoot, 'data');
  const target = path.join(projectRoot, 'browser-extension', 'config.js');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(root, 'web-bridge-token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw Error('桥接令牌文件为空，请检查 dataDir/web-bridge-token');
  const config = { url: `http://127.0.0.1:${port}`, token };
  fs.writeFileSync(target, `const BRIDGE = ${JSON.stringify(config)};\n`, { mode: 0o600 });
  return { target, tokenFile, url: config.url };
}

if (require.main === module) {
  try {
    if (process.argv.length > 4) throw Error('用法：node scripts/setup-web-bridge.cjs [端口] [dataDir]');
    const result = setup({ port: process.argv[2] ?? 5141, dataDir: process.argv[3] });
    console.log(`浏览器连接器配置已生成：${result.target}`);
    console.log(`桥接令牌文件：${result.tokenFile}`);
    console.log(`桥接地址 ${result.url}；请重新加载扩展。不含 ChatGPT 或 QQ 登录凭据。`);
  } catch (err) {
    console.error(`生成失败：${err.message}`);
    process.exitCode = 1;
  }
}
module.exports = { setup };
