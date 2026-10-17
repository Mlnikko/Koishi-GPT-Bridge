const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 把「项目架构」从文档里的约定变成可执行的约束。
// 这些规则本身没有运行时作用，但一旦被破坏，测试会立刻失败，
// 从而避免重构过程中悄悄出现反向依赖、孤立模块或子进程回归。
const projectRoot = path.join(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');

// 分层：数字越小越底层。只允许上层依赖下层或同层，禁止反向。
//   lib/    通用工具，不依赖项目内任何模块
//   core/   领域逻辑，可用 lib
//   bridge/ 本机 HTTP 桥接，可用 core 与 lib
//   app/    应用编排，注入会话、连接器与 QQ 回传
//   commands/ 命令及帮助，只调用应用和领域接口
//   index   插件装配入口
const LAYERS = { lib: 0, core: 1, bridge: 2, app: 3, commands: 4 };
const ENTRY = 'index.cjs';
const layerOf = rel => {
  const first = rel.split('/')[0];
  if (first === ENTRY) return 5;
  return LAYERS[first];
};

function listModules(dir = srcDir, base = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listModules(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.cjs')) found.push(rel);
  }
  return found.sort();
}

// 注释里出现的路径不算真实依赖，先去掉注释再解析 require。
// 只处理「行首或空白后的 //」，这样字符串里的 http:// 不会被误删。
const stripComments = code => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const requiresOf = code => [...stripComments(code).matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map(m => m[1]);

const modules = listModules();
const known = new Set(modules);
const graph = new Map();
for (const rel of modules) {
  const code = fs.readFileSync(path.join(srcDir, rel), 'utf8');
  const deps = requiresOf(code)
    .map(spec => path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)))
    .filter(dep => known.has(dep));
  graph.set(rel, [...new Set(deps)].sort());
}

test('每个运行时模块都归属已知分层', () => {
  // 新增目录时这里会失败，提醒把新分层补进 LAYERS，而不是让规则静默失效。
  const unknown = modules.filter(rel => layerOf(rel) === undefined);
  assert.deepEqual(unknown, [], `未识别的分层：${unknown.join(', ')}（请更新 LAYERS）`);
});

test('依赖方向只能自上而下', () => {
  const violations = [];
  for (const [rel, deps] of graph) {
    for (const dep of deps) {
      if (layerOf(dep) > layerOf(rel)) violations.push(`${rel}（层 ${layerOf(rel)}）→ ${dep}（层 ${layerOf(dep)}）`);
    }
  }
  assert.deepEqual(violations, [], `存在反向依赖：\n${violations.join('\n')}`);
});

test('命令模块不得直接依赖传输适配器', () => {
  const leaks = [...graph].flatMap(([module, deps]) => module.startsWith('commands/')
    ? deps.filter(dep => dep.startsWith('bridge/')).map(dep => module + ' → ' + dep) : []);
  assert.deepEqual(leaks, []);
});

test('运行时模块没有循环依赖', () => {
  const visited = new Set(), visiting = new Set();
  const visit = (module, chain = []) => {
    assert.ok(!visiting.has(module), '循环依赖：' + [...chain, module].join(' → '));
    if (visited.has(module)) return;
    visiting.add(module);
    for (const dependency of graph.get(module)) visit(dependency, [...chain, module]);
    visiting.delete(module); visited.add(module);
  };
  for (const module of modules) visit(module);
});

test('lib 层不依赖项目内任何其他分层', () => {
  const leaks = [];
  for (const [rel, deps] of graph) {
    if (layerOf(rel) !== LAYERS.lib) continue;
    for (const dep of deps) if (dep.startsWith('core/') || dep.startsWith('bridge/')) leaks.push(`${rel} → ${dep}`);
  }
  assert.deepEqual(leaks, [], `lib 层出现了向上依赖：\n${leaks.join('\n')}`);
});

test('没有从入口不可达的孤立模块', () => {
  const seen = new Set([ENTRY]);
  const queue = [ENTRY];
  while (queue.length) {
    for (const dep of graph.get(queue.pop()) || []) {
      if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
  }
  assert.deepEqual(modules.filter(rel => !seen.has(rel)), [], '以下模块没有任何路径能到达，疑似死代码');
});

test('运行时模块不得引入子进程或残留 Codex 依赖', () => {
  // 生图与语义分类全部经由浏览器内的在线页面完成。若这里失败，
  // 说明有人重新引入了本地 CLI 调用路径，需要重新评估环境继承与进程终止。
  const forbidden = ['child_process', 'execFile', 'codexPath', 'CODEX_HOME', 'runner.cjs'];
  const hits = [];
  for (const rel of modules) {
    const code = fs.readFileSync(path.join(srcDir, rel), 'utf8');
    for (const needle of forbidden) if (code.includes(needle)) hits.push(`${rel} 含有 ${needle}`);
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('package.json 的 main 指向真实存在的入口', () => {
  // 目录重构最容易踩的坑：main 忘了改，Koishi 侧静默加载失败。
  const pkg = require('../package.json');
  assert.equal(pkg.main, `src/${ENTRY}`);
  assert.ok(fs.existsSync(path.join(projectRoot, pkg.main)), `main 指向的文件不存在：${pkg.main}`);
});

test('入口导出 Koishi 需要的 name 与 apply', () => {
  const entry = require(`../src/${ENTRY}`);
  assert.equal(typeof entry.apply, 'function');
  assert.equal(typeof entry.name, 'string');
  assert.ok(entry.name.length > 0);
});
