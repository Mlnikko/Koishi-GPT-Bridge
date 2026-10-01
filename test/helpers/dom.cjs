'use strict';

// 一个刚好够用的 DOM 桩。
//
// 浏览器扩展的页面脚本只能通过 chrome.scripting.executeScript 注入，没法直接 require，
// 所以测试要在沙箱里跑它。原来的测试用「按函数名切源码字符串」的办法取内部函数，
// 一旦函数改名或挪位置就会失败 —— 而且失败原因和真实行为无关。
// 这里改为提供一份真实形状的 DOM，让测试直接调用 pageStep，不再依赖源码布局。

function matchesSimple(node, part) {
  if (node.nodeType !== 1) return false;
  const tag = /^[a-zA-Z][\w-]*/.exec(part);
  if (tag && node.tagName !== tag[0].toUpperCase()) return false;
  const attrs = /\[\s*([\w-]+)\s*(?:([*^$~]?=)\s*"([^"]*)"\s*(i)?)?\s*\]/g;
  let match;
  while ((match = attrs.exec(part))) {
    const [, name, op, value, ci] = match;
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (!op) continue;
    const left = ci ? actual.toLowerCase() : actual;
    const right = ci ? String(value).toLowerCase() : String(value);
    if (op === '=' && left !== right) return false;
    if (op === '*=' && !left.includes(right)) return false;
    if (op === '^=' && !left.startsWith(right)) return false;
    if (op === '$=' && !left.endsWith(right)) return false;
    if (op === '~=' && !left.split(/\s+/).includes(right)) return false;
  }
  return true;
}

function matchesChain(node, chain) {
  if (!node || node.nodeType !== 1) return false;
  if (!matchesSimple(node, chain[chain.length - 1])) return false;
  let index = chain.length - 2;
  let cursor = node.parentElement;
  while (index >= 0) {
    let found = null;
    while (cursor) { if (matchesSimple(cursor, chain[index])) { found = cursor; break; } cursor = cursor.parentElement; }
    if (!found) return false;
    cursor = found.parentElement;
    index--;
  }
  return true;
}

const matches = (node, selector) =>
  String(selector).split(',').some(group => matchesChain(node, group.trim().split(/\s+/)));

function walk(node, visit) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    visit(child);
    walk(child, visit);
  }
}

function append(parent, child) {
  const node = typeof child === 'string' ? { nodeType: 3, nodeValue: child, parentElement: parent } : child;
  if (node.nodeType === 1) node.parentElement = parent;
  parent.childNodes.push(node);
  return node;
}

function el(tag, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    attrs: { ...attrs },
    childNodes: [],
    parentElement: null,
    get children() { return this.childNodes.filter(child => child.nodeType === 1); },
    getAttribute(name) { return name in this.attrs ? String(this.attrs[name]) : null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    get textContent() { return this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.textContent).join(''); },
    get innerText() { return this.textContent; },
    get href() { return this.attrs.href ?? null; },
    get outerHTML() { return `<${this.tagName.toLowerCase()}>`; },
    appendChild(child) { return append(this, child); },
    closest(selector) {
      let node = this;
      while (node) { if (node.nodeType === 1 && matches(node, selector)) return node; node = node.parentElement; }
      return null;
    },
    contains(other) {
      let node = other;
      while (node) { if (node === this) return true; node = node.parentElement; }
      return false;
    },
    querySelectorAll(selector) { const out = []; walk(this, node => { if (matches(node, selector)) out.push(node); }); return out; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
  for (const child of children) append(node, child);
  return node;
}

// 图片节点：只补齐扩展真正会读的那几个字段。
function img(source, { width = 1024, height = 1024, alt = '', testid = '', complete = true } = {}) {
  const node = el('img', { src: source, alt, ...(testid ? { 'data-testid': testid } : {}) });
  node.currentSrc = source;
  node.naturalWidth = width;
  node.naturalHeight = height;
  node.complete = complete;
  return node;
}

function createDocument() {
  const body = el('body');
  return {
    body,
    createElement: tag => el(tag),
    querySelector: selector => body.querySelector(selector),
    querySelectorAll: selector => body.querySelectorAll(selector),
  };
}

module.exports = { el, img, createDocument, matches };
