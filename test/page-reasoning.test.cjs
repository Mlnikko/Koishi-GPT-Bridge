const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { el, createDocument } = require('./helpers/dom.cjs');
const source = fs.readFileSync(path.join(__dirname, '../browser-extension/page.js'), 'utf8');
const labels = { instant: 'Instant', medium: 'Medium', high: 'High', xhigh: 'Extra High', pro: 'Pro' };

function fixture({ levels = ['instant', 'medium', 'high', 'xhigh', 'pro'], selected = 'pro', labelNames = labels, modelNames, discardOnClose = false } = {}) {
  const document = createDocument(), events = [];
  const editor = el('div', { id: 'prompt-textarea', role: 'textbox', contenteditable: 'true' });
  const trigger = el('button', { id: 'model-trigger', 'aria-label': '选择 ChatGPT 模型',
    'aria-expanded': 'false', 'data-codex-intelligence-trigger': 'true', 'data-selected-reasoning-effort': 'medium' });
  const description = el('span', { id: 'selected-level' });
  const modelButton = el('button', { 'aria-label': '选择模型' });
  const thumb = el('span', { role: 'slider', 'aria-hidden': 'true', 'aria-valuemin': '0', 'aria-valuemax': String(levels.length - 1) });
  const control = el('div', { role: 'menuitem', 'data-reasoning-slider': 'true', 'aria-describedby': 'selected-level' }, [thumb]);
  const menu = el('div', { role: 'menu', 'aria-labelledby': 'model-trigger', hidden: '' }, [modelButton, description, control]);
  let index = levels.indexOf(selected), opened = 0, verifying = false, fallback, selection;
  const render = () => {
    description.childNodes = []; description.appendChild(`${labelNames[levels[index]]}，第 ${index + 1} 项，共 ${levels.length} 项。`);
    thumb.setAttribute('aria-valuenow', String(index));
    if (modelNames) { modelButton.childNodes = []; modelButton.appendChild(modelNames[levels[index]]); }
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
    const result = await sandbox.pageStep('reasoning', { reasoningEffort: target, reasoningVerify: verifying,
      reasoningFallback: fallback, reasoningSelection: selection, ...extra });
    verifying = !result.applied && (verifying || !!result.verify);
    fallback = result.applied ? undefined : result.fallback || fallback;
    selection = result.selection || selection;
    return result;
  };
  return { document, editor, trigger, menu, description, thumb, control, modelButton, events, step, selected: () => levels[index], opened: () => opened };
}

const workLevels = ['luna-high', 'sol-light', 'sol-medium', 'astra-light', 'astra-medium', 'astra-xhigh'];
const workLabels = { 'luna-high': '高', 'sol-light': '轻度', 'sol-medium': '中',
  'astra-light': '轻度', 'astra-medium': '中', 'astra-xhigh': '极高' };
const workModels = Object.fromEntries(workLevels.map(level => [level, level.split('-')[0] + ' ' + workLabels[level]]));
const workFixture = options => fixture({ levels: workLevels, selected: 'sol-light', labelNames: workLabels, modelNames: workModels, ...options });

for (const [target, tier] of [['instant', 1], ['pro', 6], ['tier-2', 2], ['tier-3', 3], ['tier-4', 4], ['tier-5', 5]])
test('Work selects and verifies native model tiers despite repeated labels: ' + target, async () => {
  const f = workFixture(); let result;
  for (let i = 0; i < 12; i++) { result = await f.step(target, { mode: 'work' }); if (!result.pending) break; }
  assert.equal(result.applied, true); assert.equal(result.level, target);
  assert.equal(result.selection.kind, 'work-tier'); assert.equal(result.selection.tier, tier);
  assert.equal(result.selection.total, 6); assert.equal(result.selection.label, workLabels[workLevels[tier - 1]]);
  assert.equal(result.selection.model, workModels[workLevels[tier - 1]]);
  assert.equal(f.opened(), 2); assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
});

for (const target of ['medium', 'high', 'xhigh']) test('ambiguous Work effort labels require a native tier instead of choosing another model: ' + target, async () => {
  const f = workFixture(); await f.step(target, { mode: 'work' });
  assert.match((await f.step(target, { mode: 'work' })).error, /跨模型强度档位.*1–6/);
  assert.equal(f.events.length, 0);
});

test('Work rejects out-of-range tiers and conflicting announced positions before changing the selection', async () => {
  const f = workFixture(); await f.step('tier-7', { mode: 'work' });
  assert.match((await f.step('tier-7', { mode: 'work' })).error, /当前只有 6 档/);
  f.description.childNodes = []; f.description.appendChild('轻度，第 4 项，共 6 项。');
  assert.match((await f.step('tier-3', { mode: 'work' })).error, /无法确认工作网页强度档位/);
  assert.equal(f.events.length, 0);
});

test('Work verifies the model as well as the tier after the menu closes', async () => {
  const f = workFixture({ selected: 'astra-medium' });
  await f.step('tier-5', { mode: 'work' });
  assert.equal((await f.step('tier-5', { mode: 'work' })).verify, true);
  await f.step('tier-5', { mode: 'work' });
  f.modelButton.childNodes = []; f.modelButton.appendChild('different model 中');
  assert.match((await f.step('tier-5', { mode: 'work' })).error, /关闭菜单后发生变化/);
});

test('Chrome storage key reordering does not invalidate an identical Work selection', async () => {
  const f = workFixture();
  await f.step('tier-2', { mode: 'work' });
  const preview = await f.step('tier-2', { mode: 'work' });
  assert.equal(preview.verify, true);
  await f.step('tier-2', { mode: 'work' });
  const stored = Object.fromEntries(Object.entries(preview.selection).sort(([a], [b]) => a.localeCompare(b)));
  const result = await f.step('tier-2', { mode: 'work', reasoningSelection: stored });
  assert.equal(result.applied, true); assert.equal(result.selection.tier, 2);
});

test('Chat cannot consume a Work tier setting', async () => {
  const f = fixture();
  assert.match((await f.step('tier-3')).error, /推理程度参数无效/);
  assert.equal(f.opened(), 0);
});

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

for (const highest of ['instant', 'medium', 'high', 'xhigh'])
test('missing Pro uses the actual highest available level after closed-menu readback: ' + highest, async () => {
  const levels = ['instant', 'medium', 'high', 'xhigh'].slice(0, ['instant', 'medium', 'high', 'xhigh'].indexOf(highest) + 1);
  const f = fixture({ levels, selected: 'instant', labelNames: { ...labels, xhigh: '极高' } });
  let result, verification;
  for (let i = 0; i < 12; i++) {
    result = await f.step('pro');
    if (result.verify) { verification = result; assert.equal(f.trigger.getAttribute('aria-expanded'), 'false'); }
    if (!result.pending) break;
  }
  assert.equal(verification.verify, true);
  assert.equal(result.applied, true); assert.equal(result.level, highest); assert.equal(f.selected(), highest);
  assert.deepEqual(JSON.parse(JSON.stringify(result.fallback)), { requested: 'pro', level: highest, reason: 'pro-unavailable' });
  assert.equal(f.opened(), 2); assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
});

test('a missing non-Pro level still fails at the actual slider limit', async () => {
  const f = fixture({ levels: ['instant', 'medium', 'high'], selected: 'medium' });
  await f.step('xhigh'); await f.step('xhigh');
  assert.match((await f.step('xhigh')).error, /不支持推理程度 xhigh/);
  assert.equal(f.selected(), 'high');
});

test('removing Pro does not prevent selecting the remaining four levels in either direction', async () => {
  const f = fixture({ levels: ['instant', 'medium', 'high', 'xhigh'], selected: 'xhigh',
    labelNames: { instant: '即时', medium: '中', high: '高', xhigh: '极高' } });
  for (const level of ['instant', 'high', 'medium', 'xhigh']) {
    let result;
    for (let i = 0; i < 12; i++) { result = await f.step(level); if (!result.pending) break; }
    assert.equal(result.applied, true); assert.equal(result.level, level); assert.equal(result.fallback, undefined);
  }
});

test('a fallback preview discarded when the menu closes cannot be submitted', async () => {
  const f = fixture({ levels: ['instant', 'medium', 'high', 'xhigh'], selected: 'medium', discardOnClose: true });
  let result;
  for (let i = 0; i < 12; i++) { result = await f.step('pro'); if (!result.pending) break; }
  assert.match(result.error, /关闭菜单后发生变化/);
  assert.equal(result.applied, undefined); assert.equal(f.selected(), 'medium');
});

test('each new Pro request checks availability again after the allowance recovers', async () => {
  const levels = ['instant', 'medium', 'high', 'xhigh'];
  const f = fixture({ levels, selected: 'xhigh' });
  let result;
  for (let i = 0; i < 12; i++) { result = await f.step('pro'); if (!result.pending) break; }
  assert.equal(result.level, 'xhigh');
  levels.push('pro'); f.thumb.setAttribute('aria-valuemax', '4');
  for (let i = 0; i < 12; i++) { result = await f.step('pro'); if (!result.pending) break; }
  assert.equal(result.applied, true); assert.equal(result.level, 'pro'); assert.equal(result.fallback, undefined);
});

test('a fallback must still be the highest level when the menu is reopened', async () => {
  const levels = ['instant', 'medium', 'high', 'xhigh'];
  const f = fixture({ levels, selected: 'xhigh' });
  await f.step('pro'); assert.equal((await f.step('pro')).verify, true);
  levels.push('pro'); f.thumb.setAttribute('aria-valuemax', '4');
  await f.step('pro');
  assert.match((await f.step('pro')).error, /关闭菜单后发生变化/);
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
test('a model picker mounted after the editor is retried before selecting and verifying', async () => {
  const f = fixture();
  f.trigger.setAttribute('hidden', '');
  for (let attempt = 1; attempt < 5; attempt++) {
    const result = await f.step('medium', { reasoningAttempts: attempt });
    assert.equal(result.pending, true); assert.equal(result.triggerCount, 0);
    assert.equal(f.opened(), 0); assert.equal(f.events.length, 0);
  }
  delete f.trigger.attrs.hidden;
  let result;
  for (let attempt = 5; attempt <= 12; attempt++) {
    result = await f.step('medium', { reasoningAttempts: attempt });
    if (!result.pending) break;
  }
  assert.equal(result.applied, true); assert.equal(result.level, 'medium');
});

for (const count of [0, 2]) test('persistent missing or ambiguous model pickers fail without clicks: '+count, async () => {
  const f = fixture();
  if (!count) f.trigger.setAttribute('hidden', '');
  else f.document.body.appendChild(el('button', { 'aria-label': '选择 ChatGPT 模型' }));
  assert.equal((await f.step('medium', { reasoningAttempts: 1 })).pending, true);
  assert.match((await f.step('medium', { reasoningAttempts: 5 })).error, new RegExp('匹配到 '+count+' 个候选'));
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
