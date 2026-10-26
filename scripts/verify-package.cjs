'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const npmCli = process.env.npm_execpath;
const koishiVersion = process.env.KOISHI_VERSION || pkg.devDependencies.koishi;
let currentStage = '准备发行包';
const stage = value => { currentStage = value; fs.writeSync(1, value + '\n'); };
process.on('exit', code => { if (code) fs.writeSync(2, '发行包验收退出阶段：' + currentStage + '\n'); });

function npm(args, cwd = root) {
  if (!npmCli) throw Error('请使用 npm run check:package 运行打包验收。');
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('npm ' + args[0] + ' 失败：\n' + result.stderr + result.stdout);
  return result.stdout;
}

async function verify() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'koishi-package-'));
  let app;
  try {
    assert.notEqual(pkg.private, true);
    assert.ok(pkg.peerDependencies.koishi);
    assert.equal(pkg.license, 'MIT');
    const [pack] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp]));
    const files = pack.files.map(file => file.path);
    for (const file of files) {
      assert.ok(!/(^|\/)(?:data|probe|node_modules|test|\.github|dist)(\/|$)/.test(file), '打包了开发或运行数据：' + file);
      assert.ok(!/(^|\/)(?:\.env(?:\..*)?|\.npmrc|config\.js|web-bridge-token)$/.test(file), '打包了本机配置：' + file);
    }
    for (const file of [pkg.main, 'LICENSE', 'docs/installation.md', ...Object.values(pkg.bin)])
      assert.ok(files.includes(file), '发行包缺少文件：' + file);
    const instance = path.join(temp, 'Koishi 实例 with spaces');
    fs.mkdirSync(instance);
    fs.writeFileSync(path.join(instance, 'package.json'), JSON.stringify({ name: 'bridge-package-smoke', version: '1.0.0', private: true }));
    stage(`已打包 ${files.length} 个文件；在隔离实例安装 Koishi ${koishiVersion}。`);
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--prefer-offline',
      '--registry=https://registry.npmjs.org', path.join(temp, pack.filename), 'koishi@' + koishiVersion], instance);
    stage('依赖安装完成，正在加载发行包');
    const local = createRequire(path.join(instance, 'package.json'));
    const plugin = local(pkg.name);
    const installedRoot = path.dirname(path.dirname(local.resolve(pkg.name)));
    assert.equal(typeof plugin.Config, 'function');
    assert.equal(typeof plugin.usage, 'string');
    assert.throws(() => plugin.Config({ allowedUsers: [] }));
    const { App } = local('koishi');
    stage('发行包已加载，正在启动隔离 Koishi');
    app = new App();
    stage('隔离 Koishi 上下文已创建');
    app.baseDir = instance;
    stage('正在注册发行包插件');
    app.plugin(plugin, { allowedUsers: ['package-smoke'], webBridgePort: 0 });
    stage('发行包插件已注册，正在等待启动完成');
    await app.start();
    stage('隔离 Koishi 已启动，正在检查桥接与扩展');
    const dataDir = path.join(instance, 'data', plugin.name);
    const portFile = path.join(dataDir, 'web-bridge-port');
    for (let attempt = 0; !fs.existsSync(portFile) && attempt < 200; attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const port = Number(fs.readFileSync(portFile, 'utf8'));
    const token = fs.readFileSync(path.join(dataDir, 'web-bridge-token'), 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-bridge-token': token }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.pluginVersion, pkg.version);
    assert.equal(health.online, false, '验收不应连接真实浏览器');
    const setupFile = path.join(installedRoot, pkg.bin['koishi-gpt-bridge-setup']);
    const generated = spawnSync(process.execPath, [setupFile, '--instance-dir', instance], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    assert.ok(!generated.stdout.includes(token), 'CLI 不应输出令牌');
    const extension = path.join(dataDir, 'browser-extension');
    const config = vm.runInNewContext(fs.readFileSync(path.join(extension, 'config.js'), 'utf8') + '\nJSON.stringify(BRIDGE)');
    assert.deepEqual(JSON.parse(config), { url: `http://127.0.0.1:${port}`, token });
    assert.equal(JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).version, pkg.version);
    assert.equal(fs.existsSync(path.join(installedRoot, 'data')), false);
    assert.equal(fs.existsSync(path.join(installedRoot, 'browser-extension', 'config.js')), false);
    const { inspect } = require(path.join(installedRoot, 'scripts/doctor.cjs'));
    assert.equal((await inspect({ baseDir: instance })).pluginVersion, pkg.version);
    const doctorFile = path.join(installedRoot, pkg.bin['koishi-gpt-bridge-doctor']);
    // Keep this event loop running: it also serves the HTTP health request
    // made by the diagnostic child process.
    const diagnosis = await new Promise((resolve, reject) => {
      execFile(process.execPath, [doctorFile], { cwd: instance, timeout: 10000 }, (err, stdout, stderr) => {
        if (err && !Number.isInteger(err.code)) return reject(err);
        resolve({ status: err?.code || 0, stdout, stderr });
      });
    });
    assert.equal(diagnosis.status, 2, diagnosis.stderr); // The isolated browser is intentionally offline.
    assert.ok(diagnosis.stdout.includes(pkg.version));
    assert.ok(!diagnosis.stdout.includes(token));
    stage('诊断通过，正在关闭隔离 Koishi');
    await app.stop(); app = undefined;
    const bytes = fs.readFileSync(path.join(temp, pack.filename));
    const report = { name: pkg.name, version: pkg.version, koishiVersion, node: process.version,
      files: files.length, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      checks: ['npm tarball install', 'Koishi schema and plugin lifecycle', 'instance data directory',
        'loopback health endpoint', 'extension CLI pairing and version', 'doctor', 'no local data in package'],
      liveBrowserOrQQTested: false };
    const destination = path.join(root, 'dist');
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(temp, pack.filename), path.join(destination, pack.filename));
    fs.writeFileSync(path.join(destination, 'package-validation.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`发行包验收通过：${path.join(destination, pack.filename)}（${bytes.length} 字节）。`);
    console.log('真实 Koishi 已加载打包产物，配置约束、数据路径、本机 HTTP、扩展生成与配对通过；未请求 ChatGPT 或发送 QQ。');
  } finally {
    if (app) await app.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

verify().catch(err => { fs.writeSync(2, String(err.stack || err) + '\n'); process.exitCode = 1; });
