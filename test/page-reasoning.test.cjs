const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { el, createDocument } = require('./helpers/dom.cjs');
const source = fs.readFileSync(path.join(__dirname, '../browser-extension/page.js'), 'utf8');
const labels = { instant: 'Instant', medium: 'Medium', high: 'High', xhigh: 'Extra High', pro: 'Pro' };

function fixture({ levels = ['instant', 'medium', 'high', 'xhigh', 'pro'], selected = 'pro', labelNames = labels, discardOnClose = false } = {}) {
  const document = createDocument(), events = [];
  const editor = el('div', { id: 'prompt-textarea', role: 'textbox', contenteditable: 'true' });
  const trigger = el('button', { id: 'model-trigger', 'aria-label': '选择 ChatGPT 模型',
    'aria-expanded': 'false', 'data-codex-intelligence-trigger': 'true', 'data-selected-reasoning-effort': 'medium' });
  const description = el('span', { id: 'selected-level' });
  const thumb = el('span', { role: 'slider', 'aria-hidden': 'true', 'aria-valuemin': '0', 'aria-valuemax': String(levels.length - 1) });
  const control = el('div', { role: 'menuitem', 'data-reasoning-slider': 'true', 'aria-describedby': 'selected-level' }, [thumb]);
  const menu = el('div', { role: 'menu', 'aria-labelledby': 'model-trigger', hidden: '' }, [description, control]);
  let index = levels.indexOf(selected), opened = 0, verifying = false;
  const render = () => {
    description.childNodes = []; description.appendChild(`${labelNames[levels[index]]}，第 ${index + 1} 项，共 ${levels.length} 项。`);
    thumb.setAttribute('aria-valuenow', String(index));
  };
  render();
  trigger.click = () => {
    const open = trigger.getAttribute('aria-expanded') !== 'true';
    trigger.setAttribute('aria-expanded', String(open));
    if (open) { delete menu.attrs.hidden; opened++; } else {
      menu.attrs.hidden = '';
      if (discardOnClose) { index = levels.indexOf(selected); render(); }
    }
  };
  control.focus = () => {};
  control.dispatchEvent = event => {
    events.push(event.key);
    if (event.type === 'keydown') {
      index = Math.max(0, Math.min(levels.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
      render();
    }
  };
  document.body.appendChild(el('form', {}, [editor, trigger, el('button', { 'aria-label': '发送' })]));
  document.body.appendChild(menu);
  const sandbox = { document, location: { pathname: '/', href: 'https://chatgpt.com/' },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } } };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const step = async (target, extra = {}) => {
    const result = await sandbox.pageStep('reasoning', { reasoningEffort: target, reasoningVerify: verifying, ...extra });
    verifying = !result.applied && (verifying || !!result.verify);
    return result;
  };
  return { document, editor, trigger, menu, description, thumb, control, events, step, selected: () => levels[index], opened: () => opened };
}

test('reasoning is read back from the actual slider and never from a misleading trigger attribute', async () => {
  const f = fixture();
  assert.equal((await f.step('pro')).pending, true);
  assert.equal((await f.step('pro')).verify, true);
  assert.equal((await f.step('pro')).pending, true);
  assert.equal((await f.step('pro')).applied, true);
  assert.equal(f.events.length, 0);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(f.selected(), 'pro');
});

test('all five levels can be selected in either direction and confirmed before closing the menu', async () => {
  const f = fixture();
  for (const level of ['instant', 'high', 'medium', 'xhigh', 'pro']) {
    let result;
    for (let i = 0; i < 8; i++) { result = await f.step(level); if (!result.pending) break; }
    assert.equal(result.applied, true); assert.equal(result.level, level); assert.equal(f.selected(), level);
  }
  assert.equal(f.opened(), 10);
  assert.ok(f.events.includes('ArrowLeft')); assert.ok(f.events.includes('ArrowRight'));
});

test('an unavailable level fails at the actual slider limit without guessing a numeric mapping', async () => {
  const f = fixture({ levels: ['instant', 'medium', 'high'], selected: 'medium' });
  await f.step('pro'); await f.step('pro');
  assert.match((await f.step('pro')).error, /不支持推理程度 pro/);
  assert.equal(f.selected(), 'high');
});

test('foreign menus and hidden history controls cannot be used to change reasoning', async () => {
  const f = fixture();
  f.document.body.appendChild(el('div', { 'data-testid': 'conversation-turn-1' }, [el('button', {
    'data-codex-intelligence-trigger': 'true', 'aria-expanded': 'true' })]));
  await f.step('high');
  f.menu.setAttribute('aria-labelledby', 'other-tool');
  assert.equal((await f.step('high')).pending, true);
  assert.equal(f.events.length, 0);
});

test('unknown drafts, thread mismatches and unreadable slider state block reasoning changes', async () => {
  const f = fixture();
  f.editor.appendChild('my unfinished draft');
  assert.match((await f.step('high')).error, /尚未就绪/);
  f.editor.childNodes = [];
  assert.match((await f.step('high', { threadId: '11111111-2222-3333-4444-555555555555' })).error, /会话与任务不一致/);
  await f.step('high');
  f.description.childNodes = []; f.description.appendChild('Unknown option');
  assert.match((await f.step('high')).error, /无法确认/);
  assert.equal(f.events.length, 0);
});

test('default reasoning leaves the page selection untouched', async () => {
  const f = fixture();
  assert.equal((await f.step('default')).applied, true);
  assert.equal(f.opened(), 0); assert.equal(f.events.length, 0);
});
test('the owned modal menu can be completed while it aria-hides the composer', async () => {
  const f = fixture();
  await f.step('xhigh');
  const form = f.editor.closest('form');
  form.setAttribute('aria-hidden', 'true');
  assert.equal((await f.step('xhigh')).pending, true);
  assert.equal((await f.step('xhigh')).verify, true);
  form.attrs['aria-hidden'] = 'false';
  assert.equal((await f.step('xhigh')).pending, true);
  form.setAttribute('aria-hidden', 'true');
  const result = await f.step('xhigh');
  assert.equal(result.applied, true); assert.equal(result.level, 'xhigh');
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
});

test('the live Chinese Extra High label is recognized while selecting a lower level', async () => {
  const f = fixture({ labelNames: { instant: '即时', medium: '中', high: '高', xhigh: '极高', pro: 'Pro' } });
  let result;
  for (let i = 0; i < 10; i++) { result = await f.step('medium'); if (!result.pending) break; }
  assert.equal(result.applied, true); assert.equal(f.selected(), 'medium');
});

test('a preview discarded when the menu closes is rejected before submission', async () => {
  const f = fixture({ discardOnClose: true });
  let result;
  for (let i = 0; i < 10; i++) { result = await f.step('high'); if (!result.pending) break; }
  assert.match(result.error, /关闭菜单后发生变化/);
  assert.equal(result.applied, undefined); assert.equal(f.selected(), 'pro');
});
