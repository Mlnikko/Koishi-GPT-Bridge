'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeAtomic } = require('../lib/state.cjs');

const MAX_PROMPT_CHARS = 8000;
const OWNER_PREFIX = '<!-- koishi-image-prompt ';
const validOwner = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const MAX_REQUEST_CHARS = 1000;
const FIELD_PATTERN = /\{\{([^{}]+)\}\}/g;
function promptName(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 64
    || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || /^[.]/.test(value) || /[. ]$/.test(value)
    || /^(?:list|show|preview|off|create|edit|delete|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.\s]|$)/i.test(value)
    || value.startsWith('--')) throw Error('模板名称最多 64 字，不可含路径、特殊字符或 list/show/preview/off/create/edit/delete 等保留名称');
  return value;
}
// Inline declarations keep ordinary Markdown templates editable without a parser dependency.
// {{name}} is required; {{name|default}} is optional (the default may be empty).
function parseTemplate(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PROMPT_CHARS || /\x00/.test(value))
    throw Error(`图片提示词必须是非空文本，最多 ${MAX_PROMPT_CHARS} 字`);
  const fields = new Map();
  const rest = value.replace(FIELD_PATTERN, (token, expression) => {
    const separator = expression.indexOf('|');
    const name = (separator < 0 ? expression : expression.slice(0, separator)).trim();
    if (!/^[\p{L}_][\p{L}\p{N}_]{0,31}$/u.test(name)
      || ['__proto__', 'constructor', 'prototype'].includes(name)) throw Error('占位符名称须为 1–32 字的中文、字母、数字或下划线，不能以数字开头');
    const fallback = separator < 0 ? undefined : expression.slice(separator + 1).trim();
    if (fallback !== undefined && (fallback.length > 1000 || /[\x00-\x1f\x7f]/.test(fallback)))
      throw Error(`占位符「${name}」的默认值须为不超过 1000 字的单行文本`);
    if (name === '角色名' && fallback !== undefined) throw Error('角色名须由用户输入，请使用 {{角色名}}，不要设置默认值');
    if (fields.has(name) && fields.get(name).fallback !== fallback)
      throw Error(`占位符「${name}」重复声明的默认值不一致，请保持相同写法`);
    fields.set(name, { name, fallback });
    return '';
  });
  if (/\{\{|\}\}/.test(rest)) throw Error('占位符格式无效，请使用 {{参数名}} 或 {{参数名|默认值}}');
  if (!fields.has('角色名')) throw Error('模板必须包含占位符 {{角色名}}');
  if (fields.size > 16) throw Error('每个模板最多支持 16 种占位符');
  return [...fields.values()];
}
function characterName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\x00-\x1f\x7f]/.test(value)
    || /\{\{|\}\}/.test(value)) throw Error('角色名须为 1–100 字的单行文本，不可含占位符；用法：/draw 角色名');
  return value.trim();
}
function parseRequest(value) {
  if (typeof value !== 'string' || !value.trim()) throw Error('角色名须填写；用法：/draw 角色名 | 参数名=内容');
  if (value.length > MAX_REQUEST_CHARS) throw Error(`角色名和参数合计最多 ${MAX_REQUEST_CHARS} 字`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw Error('角色名和参数须为单行文本');
  const parts = [''];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\' && ['|', '\\'].includes(value[i + 1])) parts[parts.length - 1] += value[++i];
    else if (char === '|') parts.push('');
    else parts[parts.length - 1] += char;
  }
  const character = characterName(parts.shift());
  const parameters = new Map([['角色名', character]]);
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator < 1) throw Error('参数格式：/draw 角色名 | 参数名=内容；内容中的竖线请写成 \\|');
    const name = part.slice(0, separator).trim(), content = part.slice(separator + 1).trim();
    if (parameters.has(name)) throw Error(`参数「${name}」重复填写；角色名只需写在命令开头`);
    if (/\{\{|\}\}/.test(content)) throw Error(`参数「${name}」不可包含占位符`);
    parameters.set(name, content);
  }
  return { character, parameters, request: value.trim() };
}
const revisionOf = template => createHash('sha256').update(template).digest('hex');
function validateImagePrompt(value) {
  const name = promptName(value?.name), template = value?.template, fields = parseTemplate(template);
  const revision = revisionOf(template);
  if (value.revision !== revision) throw Error('图片提示词快照校验失败，请重新发送');
  // Old persisted snapshots only have character. They retain their literal semantics.
  const legacy = value.request === undefined;
  const parsed = legacy ? { character: characterName(value.character), parameters: new Map([['角色名', value.character.trim()]]) }
    : parseRequest(value.request);
  const known = new Set([...fields.map(field => field.name), '补充要求']);
  for (const key of parsed.parameters.keys()) if (!known.has(key)) throw Error(`模板不支持参数「${key}」；可用参数：${[...known].join('、')}`);
  const resolved = new Map(), missing = [];
  for (const field of fields) {
    const content = parsed.parameters.has(field.name) ? parsed.parameters.get(field.name)
      : field.fallback ?? (field.name === '补充要求' ? '' : undefined);
    if (content === undefined || (content === '' && field.fallback === undefined && field.name !== '补充要求')) missing.push(field.name);
    else resolved.set(field.name, content);
  }
  if (missing.length) throw Error(`缺少必填参数：${missing.join('、')}。用法：/draw 角色名 | ${missing.map(key => key + '=内容').join(' | ')}`);
  if (parsed.parameters.has('补充要求')) resolved.set('补充要求', parsed.parameters.get('补充要求'));
  // Replace only template tokens, once. User text is never parsed again as a template.
  let text = template.replace(FIELD_PATTERN, (token, expression) => resolved.get(expression.split('|')[0].trim()));
  const overrides = [...parsed.parameters].filter(([key]) => key !== '角色名');
  if (overrides.length) {
    text += '\n\n【本次明确要求】\n' + overrides.map(([key, content]) => `${key}：${content || '（留空）'}`).join('\n')
      + '\n本次明确要求优先于模板默认描述及参考画面中的冲突细节；其余未要求修改的内容保持不变。';
  }
  // Empty optional fields at the edges must agree with submissionText's normalization.
  text = text.trim();
  if (text.length > MAX_PROMPT_CHARS) throw Error(`替换后的图片提示词最多 ${MAX_PROMPT_CHARS} 字，请缩短模板或参数`);
  return { name, template, character: parsed.character, revision, text,
    ...(legacy ? {} : { request: parsed.request }), parameters: Object.fromEntries(resolved),
    supplied: Object.fromEntries(parsed.parameters) };
}

class ImagePrompts {
  constructor(dir, defaults) {
    this.dir = dir;
    const existed = fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.checkDirectory();
    // Seed only a newly created library. Local edits and deletions survive restarts.
    if (!existed && defaults) {
      for (const entry of fs.readdirSync(defaults, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md'))
          fs.copyFileSync(path.join(defaults, entry.name), path.join(dir, entry.name), fs.constants.COPYFILE_EXCL);
      }
    }
  }
  checkDirectory() {
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('图片提示词目录必须是本地普通目录');
  }
  list() {
    this.checkDirectory();
    return fs.readdirSync(this.dir, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
      try { return [promptName(entry.name.slice(0, -3))]; } catch { return []; }
    }).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  readFile(name) {
    name = promptName(name); this.checkDirectory();
    const file = path.join(this.dir, name + '.md');
    let template;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('模板必须是普通 Markdown 文件，不支持符号链接');
      if (stat.size > MAX_PROMPT_CHARS * 4 + 2048) throw Error(`图片提示词最多 ${MAX_PROMPT_CHARS} 字`);
      try { template = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
      catch { throw Error('模板必须保存为 UTF-8 文本'); }
    } catch (err) {
      if (err.code === 'ENOENT') throw Error('未找到模板「' + name + '」，用 /prompt 查看列表，或用 /prompt create 名称 后换行填写正文创建');
      throw err;
    }
    let owner;
    if (template.startsWith(OWNER_PREFIX)) {
      const end = template.indexOf('\n');
      const header = (end < 0 ? template : template.slice(0, end)).replace(/\r$/, '');
      try {
        if (!header.endsWith(' -->')) throw Error('invalid header');
        const meta = JSON.parse(header.slice(OWNER_PREFIX.length, -4));
        if (meta.version !== 1 || !validOwner(meta.owner)) throw Error('invalid owner');
        owner = meta.owner; template = end < 0 ? '' : template.slice(end + 1);
      } catch { throw Error('模板创建者信息无效，请在本地修复文件头'); }
    }
    return { name, template: template.trim(), owner };
  }
  read(name) {
    const { template, owner } = this.readFile(name);
    const fields = parseTemplate(template);
    return { name, template, revision: revisionOf(template), fields, ...(owner ? { owner } : {}) };
  }
  document(template, owner) {
    if (!validOwner(owner)) throw Error('无法确认模板创建者身份');
    if (typeof template === 'string') template = template.trim();
    parseTemplate(template);
    return OWNER_PREFIX + JSON.stringify({ version: 1, owner }) + ' -->\n' + template + '\n';
  }
  create(name, template, owner) {
    name = promptName(name); this.checkDirectory();
    const document = this.document(template, owner), file = path.join(this.dir, name + '.md');
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, document);
    } catch (err) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor); descriptor = undefined;
        try { fs.unlinkSync(file); } catch {}
      }
      if (err.code === 'EEXIST') throw Error('已有同名公共图片模板，请使用其他名称；修改自己的模板请用 /prompt edit');
      throw err;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    return this.read(name);
  }
  requireCreator(name, owner) {
    const template = this.readFile(name);
    if (!template.owner) throw Error('这是本地创建的公共模板，只能在本机编辑或删除；可以用新名称在 QQ 创建自己的模板');
    if (!validOwner(owner) || template.owner !== owner) throw Error('只有创建者可以编辑或删除此公共图片模板；你仍可查看和选择');
    return template;
  }
  edit(name, template, owner) {
    const original = this.requireCreator(name, owner);
    writeAtomic(path.join(this.dir, original.name + '.md'), this.document(template, original.owner));
    return this.read(original.name);
  }
  delete(name, owner) {
    const template = this.requireCreator(name, owner);
    fs.unlinkSync(path.join(this.dir, template.name + '.md'));
  }
  render(name, request) { return validateImagePrompt({ ...this.read(name), request }); }
}
module.exports = { ImagePrompts, promptName, validateImagePrompt, MAX_PROMPT_CHARS, parseTemplate, parseRequest };
