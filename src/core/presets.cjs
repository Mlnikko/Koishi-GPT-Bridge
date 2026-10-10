'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeText } = require('../lib/state.cjs');

const MAX_PRESET_CHARS = 8000;
const OWNER_PREFIX = '<!-- koishi-preset ';
const validOwner = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const revisionOf = prompt => createHash('sha256').update(prompt).digest('hex');
function presetName(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 64
    || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || /^[.]/.test(value) || /[. ]$/.test(value)
    || /^(?:show|off|list|create|edit|delete|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.\s]|$)/i.test(value)
    || /^--page(?:\s|$)/i.test(value))
    throw Error('预设名称最多 64 字，不可包含路径或特殊字符；show、off、list、create、edit、delete 为保留名称');
  return value;
}
function presetPrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_PRESET_CHARS || /\x00/.test(value))
    throw Error(`预设正文必须是非空文本，最多 ${MAX_PRESET_CHARS} 字`);
  return value.trim();
}
function validatePresetSnapshot(value) {
  const name = presetName(value?.name);
  const prompt = value?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PRESET_CHARS || /\x00/.test(prompt))
    throw Error(`预设正文必须是非空文本，最多 ${MAX_PRESET_CHARS} 字`);
  const revision = revisionOf(prompt);
  if (value.revision !== revision) throw Error('预设任务快照校验失败，请重新发送消息');
  return { name, prompt, revision };
}

// Local Markdown is read anew for each message. Only its name belongs to the
// conversation; a complete immutable-by-convention snapshot belongs to the job.
class Presets {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  checkDirectory() {
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('预设目录必须是本地普通目录');
  }
  list() {
    this.checkDirectory();
    return fs.readdirSync(this.dir, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
      const name = entry.name.slice(0, -3);
      try { return [presetName(name)]; } catch { return []; }
    }).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  readFile(name) {
    name = presetName(name);
    this.checkDirectory();
    const file = path.join(this.dir, name + '.md');
    let prompt;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('预设必须是普通 Markdown 文件，不支持符号链接');
      if (stat.size > MAX_PRESET_CHARS * 4 + 2048) throw Error(`预设正文最多 ${MAX_PRESET_CHARS} 字`);
      try { prompt = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
      catch { throw Error('预设必须保存为 UTF-8 文本'); }
    } catch (err) {
      if (err.code === 'ENOENT') throw Error(`未找到预设「${name}」，用 /preset 查看公共列表，或用 /preset create 名称 后换行填写正文创建`);
      throw err;
    }
    let owner;
    if (prompt.startsWith(OWNER_PREFIX)) {
      const end = prompt.indexOf('\n');
      const header = (end < 0 ? prompt : prompt.slice(0, end)).replace(/\r$/, '');
      try {
        if (!header.endsWith(' -->')) throw Error('invalid header');
        const meta = JSON.parse(header.slice(OWNER_PREFIX.length, -4));
        if (meta.version !== 1 || !validOwner(meta.owner)) throw Error('invalid owner');
        owner = meta.owner; prompt = end < 0 ? '' : prompt.slice(end + 1);
      } catch { throw Error('预设创建者信息无效，请在本地修复文件头'); }
    }
    return { name, prompt: prompt.trim(), owner };
  }
  read(name) {
    const { prompt, owner } = this.readFile(name);
    return { ...validatePresetSnapshot({ name, prompt, revision: revisionOf(prompt) }), ...(owner ? { owner } : {}) };
  }
  document(prompt, owner) {
    if (!validOwner(owner)) throw Error('无法确认预设创建者身份');
    return OWNER_PREFIX + JSON.stringify({ version: 1, owner }) + ' -->\n' + presetPrompt(prompt) + '\n';
  }
  create(name, prompt, owner) {
    name = presetName(name); this.checkDirectory();
    const document = this.document(prompt, owner), file = path.join(this.dir, name + '.md');
    let descriptor;
    try {
      // Exclusive creation cannot overwrite a public preset or a symbolic link.
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, document);
    } catch (err) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor); descriptor = undefined;
        try { fs.unlinkSync(file); } catch {}
      }
      if (err.code === 'EEXIST') throw Error('已有同名公共预设，请使用其他名称；修改自己的预设请用 /preset edit');
      throw err;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    return this.read(name);
  }
  requireCreator(name, owner) {
    const preset = this.readFile(name);
    if (!preset.owner) throw Error('这是本地创建的公共模板，只能在本机编辑或删除；可以用新名称在 QQ 创建自己的预设');
    if (!validOwner(owner) || preset.owner !== owner) throw Error('只有创建者可以编辑或删除此公共预设；你仍可查看和选择');
    return preset;
  }
  edit(name, prompt, owner) {
    const preset = this.requireCreator(name, owner);
    writeText(path.join(this.dir, preset.name + '.md'), this.document(prompt, preset.owner));
    return this.read(preset.name);
  }
  delete(name, owner) {
    const preset = this.requireCreator(name, owner);
    fs.unlinkSync(path.join(this.dir, preset.name + '.md'));
  }
}

module.exports = { Presets, presetName, validatePresetSnapshot, MAX_PRESET_CHARS };
