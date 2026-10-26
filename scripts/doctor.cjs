#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolveDataDir } = require('../src/core/data-paths.cjs');

async function inspect({ dataDir, baseDir, packageRoot } = {}) {
  const root = resolveDataDir({ dataDir, baseDir, packageRoot }).dataDir;
  const port = Number(fs.readFileSync(path.join(root, 'web-bridge-port'), 'utf8').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('本机端口记录无效，请启动或重启 Koishi');
  const token = fs.readFileSync(path.join(root, 'web-bridge-token'), 'utf8').trim();
  if (!token) throw Error('本机令牌为空，请检查数据目录');
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { 'x-bridge-token': token }, signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401) throw Error('本机令牌不匹配，请检查实际 dataDir');
  if (response.status === 404) throw Error('运行中的插件尚未提供健康检查，请重启 Koishi 实例加载新代码');
  if (!response.ok) throw Error('健康检查失败（HTTP ' + response.status + '）');
  const health = await response.json();
  if (health?.version !== 2 || typeof health.pluginVersion !== 'string'
    || typeof health.online !== 'boolean' || typeof health.busy !== 'boolean')
    throw Error('健康检查协议不兼容，请核对插件版本');
  return { port, version: health.version, pluginVersion: health.pluginVersion,
    online: health.online === true, busy: health.busy === true };
}

if (require.main === module) {
  inspect({ dataDir: process.argv[2] }).then(health => {
    console.log(`插件 ${health.pluginVersion}，协议 ${health.version}，本机端口 ${health.port}`);
    console.log(`浏览器${health.online ? '已连接' : '未在线'}；${health.busy ? '正在处理任务' : '空闲'}。`);
    if (!health.online) process.exitCode = 2;
  }).catch(err => {
    console.error('检查失败：' + (err.code === 'ENOENT' ? '尚无运行记录，请启动 Koishi 或传入实际 dataDir' : err.message));
    process.exitCode = 1;
  });
}

module.exports = { inspect };
