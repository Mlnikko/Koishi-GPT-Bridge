'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.(?:cjs|js)$/.test(entry.name) && entry.name !== 'config.js' ? [file] : [];
  });
}

const files = ['src', 'browser-extension', 'scripts', 'test'].flatMap(dir => sources(path.join(root, dir)));
for (const file of files) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: path.relative(root, file) });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'browser-extension/manifest.json')));
if (pkg.version !== manifest.version) throw Error('插件与扩展版本不一致');
for (const reference of [pkg.main, 'browser-extension/' + manifest.background.service_worker,
  'browser-extension/' + manifest.action.default_popup]) {
  if (!fs.existsSync(path.join(root, reference))) throw Error('入口文件缺失：' + reference);
}
for (const file of files.filter(file => file.includes('browser-extension' + path.sep))) {
  const source = fs.readFileSync(file, 'utf8');
  for (const call of source.matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const match of call[1].matchAll(/['"]([^'"]+)['"]/g)) {
      if (match[1] === 'config.js') continue;
      if (!fs.existsSync(path.join(path.dirname(file), match[1]))) throw Error('扩展脚本缺失：' + match[1]);
    }
  }
}
console.log(`检查通过：${files.length} 个脚本语法、插件/扩展版本 ${pkg.version}、入口和扩展导入。`);
