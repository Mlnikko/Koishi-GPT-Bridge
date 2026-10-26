#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { randomBytes } = require('node:crypto');
const { setup, validatePort } = require('./setup-web-bridge.cjs');
const { resolveDataDir } = require('../src/core/data-paths.cjs');
const pkg = require('../package.json');

const FILES = ['manifest.json', 'background.js', 'bridge-client.js', 'page.js', 'popup.html', 'popup.js'];
const MARKER = '.koishi-gpt-bridge.json';
const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
};

function install({ instanceDir = process.cwd(), dataDir, outputDir, port, projectRoot = path.join(__dirname, '..') } = {}) {
  instanceDir = path.resolve(instanceDir);
  const storage = resolveDataDir({ dataDir, baseDir: instanceDir, packageRoot: projectRoot });
  const root = storage.dataDir;
  const output = outputDir == null ? path.join(root, 'browser-extension') : path.resolve(instanceDir, outputDir);
  if (within(output, root)) throw Error('扩展输出目录不能等于或包含数据目录，请使用独立子目录。');
  if (within(projectRoot, output) && !(storage.legacy && within(root, output)))
    throw Error('请将扩展导出到插件包目录之外，避免升级时覆盖本机配置。');
  if (port == null) {
    try { port = fs.readFileSync(path.join(root, 'web-bridge-port'), 'utf8').trim(); }
    catch (err) { if (err.code !== 'ENOENT') throw err; port = 5141; }
  }
  port = validatePort(port);
  let exists = false;
  try {
    const stat = fs.lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('扩展输出路径必须是普通目录。');
    exists = true;
    if (fs.readdirSync(output).length) {
      let marker;
      try { marker = JSON.parse(fs.readFileSync(path.join(output, MARKER), 'utf8')); } catch {}
      if (marker?.name !== pkg.name) throw Error('扩展输出目录已有其他文件；请选择空目录，不会覆盖。');
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  // Assemble before replacing the generated extension. A failed copy leaves
  // the old extension intact. Only this machine's data token is ever used.
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(parent, '.bridge-extension-'));
  const backup = output + '.previous-' + randomBytes(6).toString('hex');
  let backedUp = false;
  try {
    for (const file of FILES) fs.copyFileSync(path.join(projectRoot, 'browser-extension', file), path.join(stage, file));
    const result = setup({ projectRoot, dataDir: root, port, extensionDir: stage });
    fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ name: pkg.name, version: pkg.version }) + '\n', { mode: 0o600 });
    if (exists) { fs.renameSync(output, backup); backedUp = true; }
    try { fs.renameSync(stage, output); }
    catch (err) { if (backedUp) { fs.renameSync(backup, output); backedUp = false; } throw err; }
    if (backedUp) { fs.rmSync(backup, { recursive: true, force: true }); backedUp = false; }
    return { outputDir: output, dataDir: root, url: result.url, legacy: storage.legacy };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const { values } = parseArgs({ options: {
      'instance-dir': { type: 'string' }, 'data-dir': { type: 'string' },
      output: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
      console.log('用法：koishi-gpt-bridge-setup [--instance-dir <实例目录>] [--data-dir <数据目录>] [--port <端口>] [--output <扩展目录>]');
      console.log('默认从当前 Koishi 实例目录读取 data/codex-image-local，扩展导出到数据目录下的 browser-extension。');
      console.log('端口默认读取运行记录；无记录时使用 5141。相对数据/扩展路径从实例目录解析。');
    } else {
      const result = install({ instanceDir: values['instance-dir'], dataDir: values['data-dir'], port: values.port, outputDir: values.output });
      console.log('扩展已生成：' + result.outputDir);
      console.log('数据目录：' + result.dataDir);
      console.log('桥接地址：' + result.url);
      console.log('在 chrome://extensions 开启开发者模式，加载上述扩展目录；已加载时点击重新加载。');
      if (result.legacy) console.log('检测到旧版数据，已复用原令牌。切换 npm 安装前请按安装文档迁移数据。');
    }
  } catch (err) { console.error('生成失败：' + err.message); process.exitCode = 1; }
}

module.exports = { install };
