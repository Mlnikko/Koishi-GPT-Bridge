'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_SKILL_CHARS = 24000;
const revisionOf = ({ name, description, instructions }) => createHash('sha256')
  .update(JSON.stringify([name, description, instructions])).digest('hex');
function skillName(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    || ['list', 'show', 'off', 'con', 'prn', 'aux', 'nul'].includes(value) || /^(com|lpt)[1-9]$/.test(value))
    throw Error('技能名称须为最多 64 字的小写字母、数字和连字符；list/show/off 等为保留名称');
  return value;
}
function validateSkillSnapshot(value) {
  const name = skillName(value?.name), { description, instructions } = value;
  if (typeof description !== 'string' || !description.trim() || description.length > 1000 || /[\x00-\x1f\x7f]/.test(description))
    throw Error('技能 description 须为非空文本，最多 1000 字');
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > MAX_SKILL_CHARS || /\x00/.test(instructions))
    throw Error(`技能正文须为非空文本，最多 ${MAX_SKILL_CHARS} 字`);
  const snapshot = { name, description, instructions }, revision = revisionOf(snapshot);
  if (value.revision !== revision) throw Error('技能任务快照校验失败，请重新发送');
  return { ...snapshot, revision };
}

// Read the two scalar discovery fields without adding a YAML runtime dependency.
// Other frontmatter (metadata, allowed-tools, etc.) grants no runtime capability.
function parseSkill(document, expectedName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(document.replace(/^\uFEFF/, ''));
  if (!match) throw Error('SKILL.md 须以 YAML 文件头开始，包含 name 和 description');
  const lines = match[1].split(/\r?\n/), fields = new Map();
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):[ \t]*(.*)$/.exec(lines[i]);
    if (!field) continue;
    const [, key, raw] = field;
    if (fields.has(key)) throw Error(`技能文件头重复声明 ${key}`);
    let value = raw.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const continued = [];
      while (i + 1 < lines.length && (!lines[i + 1].trim() || /^[ \t]/.test(lines[i + 1]))) continued.push(lines[++i].trim());
      value = continued.join(' ');
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw Error(`技能 ${key} 的双引号文本无效`); }
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) throw Error(`技能 ${key} 的单引号文本无效`);
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      if (/^[!&*\[{>|]/.test(value) || /:\s/.test(value)) throw Error(`技能 ${key} 请使用普通文本、引号文本或 > 多行文本`);
      value = value.replace(/[ \t]+#.*$/, '');
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) value += ' ' + lines[++i].trim();
    }
    fields.set(key, value);
  }
  const name = skillName(fields.get('name'));
  if (name !== expectedName) throw Error('技能文件头 name 须与技能目录名一致');
  const snapshot = { name, description: fields.get('description'), instructions: match[2].trim() };
  return validateSkillSnapshot({ ...snapshot, revision: revisionOf(snapshot) });
}

class Skills {
  constructor(dir, defaults) {
    this.dir = dir;
    // Explicit external libraries are read-only and must already exist. Seed the
    // private data library once, so restarts never restore deleted examples.
    if (defaults && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(defaults, { withFileTypes: true })) {
        if (entry.isDirectory()) fs.cpSync(path.join(defaults, entry.name), path.join(dir, entry.name), { recursive: true, errorOnExist: true, force: false });
      }
    }
    this.checkDirectory();
  }
  checkDirectory() {
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('技能库须为本地普通目录，不支持符号链接');
  }
  read(name) {
    name = skillName(name); this.checkDirectory();
    const dir = path.join(this.dir, name), file = path.join(dir, 'SKILL.md');
    try {
      const folder = fs.lstatSync(dir), stat = fs.lstatSync(file);
      if (!folder.isDirectory() || folder.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink())
        throw Error('技能目录和 SKILL.md 须为普通文件目录，不支持符号链接');
      if (stat.size > (MAX_SKILL_CHARS + 8000) * 4) throw Error('SKILL.md 文件过大');
      let document;
      try { document = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
      catch { throw Error('SKILL.md 须保存为 UTF-8 文本'); }
      if (/\x00/.test(document)) throw Error('SKILL.md 不可包含空字符');
      return parseSkill(document, name);
    } catch (err) {
      if (err.code === 'ENOENT') throw Error(`未找到技能「${name}」，请用 /skill 查看列表，或在本机补齐技能目录和 SKILL.md`);
      throw err;
    }
  }
  list() {
    this.checkDirectory();
    const skills = [], invalid = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try { skillName(entry.name); } catch { continue; }
      try {
        const { name, description } = this.read(entry.name);
        skills.push({ name, description });
      } catch { invalid.push(entry.name); }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { skills, invalid: invalid.sort() };
  }
}

function skillContext(value) {
  if (value === undefined) return '';
  const skill = validateSkillSnapshot(value);
  return `【当前技能：${skill.name}】\n${skill.description}\n`
    + '请按以下技能指令处理本次用户消息。此接入仅提供 SKILL.md 文本，没有本机文件、脚本、CLI 或 MCP 工具的访问和执行能力；需要这些能力时请明确说明，不能声称已经执行。\n\n'
    + skill.instructions + '\n【技能指令结束】';
}
module.exports = { Skills, skillName, parseSkill, validateSkillSnapshot, skillContext, MAX_SKILL_CHARS };
