const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { el, img, createDocument } = require('./helpers/dom.cjs');
const source = fs.readFileSync(path.join(__dirname, '../browser-extension/page.js'), 'utf8');

function fixture({ names = ['chatgpt jp portrait'], plain = '', clipboard = false, sectionId = 'skills', tokenKind = 'skill' } = {}) {
  const document = createDocument(), clicks = [], edits = [];
  const editor = el('div', { contenteditable: 'true', role: 'textbox', 'aria-label': '使用 ChatGPT Work' }, [plain]);
  const send = el('button', { 'aria-label': '发送' }); send.click = () => clicks.push('send');
  document.body.appendChild(el('form', {}, [editor, send]));
  let selectedRange, focused;
  editor.focus = () => { focused = editor; };
  const chip = (name, id = 'installed-skill') => el('span', {
    'browser-skill-mention-name': name, 'browser-skill-mention-display-name': name,
    'browser-skill-mention-path': 'browser-skill:///' + id + '?accountId=private-test-account',
    'data-appearance': 'inline-mention', contenteditable: 'false',
  }, [img('https://chatgpt.com/skill-icon.svg', { alt: name, width: 24, height: 24 }), name]);
  const select = (name = names[0], id) => {
    const mention = chip(name, id);
    if(tokenKind!=='skill'){
      delete mention.attrs['browser-skill-mention-name'];
      delete mention.attrs['browser-skill-mention-path'];
      mention.attrs['browser-tool-mention-name']=name;
    }
    editor.childNodes = []; editor.appendChild(el('p', {}, [mention, ' ']));
    section.attrs.hidden = ''; return mention;
  };
  const choice = name => {
    const button = el('button', {}, [el('div', { 'data-menu-row-content': 'true' }, [el('span', {}, [name]), el('span', {}, ['摄影建议'])])]);
    button.click = () => { clicks.push(name); select(name); }; return button;
  };
  const section = el('div', { 'data-mention-section-id': sectionId, hidden: '' }, names.map(choice));
  const plugin = choice('chatgpt jp portrait'); plugin.click = () => clicks.push('wrong-plugin');
  document.body.appendChild(el('div', { 'data-mention-section-id': 'plugins' }, [plugin]));
  document.body.appendChild(section);
  document.createRange = () => ({ selectNodeContents: () => {}, setStartAfter: node => { selectedRange = node; } });
  document.execCommand = (operation, _, text) => {
    assert.equal(focused, editor); edits.push({ operation, text });
    if (operation === 'selectAll') selectedRange = null;
    if (operation === 'delete') editor.childNodes = [];
    if (operation === 'insertText') {
      if (selectedRange) {
        const parent = selectedRange.parentElement;
        parent.childNodes = parent.childNodes.slice(0, parent.childNodes.indexOf(selectedRange) + 1);
        parent.appendChild(text);
      } else { editor.childNodes = []; editor.appendChild(text); }
      if (text.startsWith('@')) delete section.attrs.hidden;
    }
  };
  editor.dispatchEvent = () => {};
  const sandbox = { document, location: { href: 'https://chatgpt.com/', pathname: '/' },
    window: { getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }) },
    InputEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } } };
  if(clipboard){
    sandbox.DataTransfer=class { setData(type,text){this.text=text;} getData(){return this.text;} };
    sandbox.ClipboardEvent=class { constructor(type,options){this.type=type;Object.assign(this,options);} };
    editor.dispatchEvent=event=>{
      if(event.type!=='paste')return true;
      // Model the editor's stale selection: selecting DOM text alone need not
      // replace its restored draft when a paste transaction arrives.
      const previous=editor.innerText;
      editor.childNodes=[];editor.appendChild(previous+event.clipboardData.getData('text/plain'));
      delete section.attrs.hidden;return false;
    };
  }
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const job = { skill: { name: 'chatgpt-jp-portrait' }, phase: 'skill', skillAttempts: 1 };
  const step = async (op, extra = {}) => {
    const result = await sandbox.pageStep(op, { ...job, ...extra });
    if(result.queryWritten)job.skillQueryWritten=true;
    return result;
  };
  return { document, editor, section, clicks, edits, job, select, step };
}

test('the Skills menu creates a native token; filling preserves it and sends only the user body', async () => {
  const f = fixture(), message = 'P03 + C04，白色陶瓷杯\n只要手部特写提示词。';
  assert.equal((await f.step('skill')).query, '@chatgpt jp portrait');
  await f.step('skill'); const applied = await f.step('skill');
  assert.equal(applied.applied, true); assert.equal(applied.id, 'installed-skill');
  assert.deepEqual(f.clicks, ['chatgpt jp portrait']);
  f.job.skillApplied = { name: applied.name, id: applied.id }; f.job.phase = 'filling';
  const before = await f.step('inspect');
  assert.equal(before.unknownDrafts, false); assert.equal(before.attachments, 0); assert.equal(before.needsWork, false);
  assert.equal((await f.step('prepare', { message })).prepared, true);
  const marker = f.editor.querySelector('[browser-skill-mention-name]');
  assert.equal((await f.step('submit', { message, draft: message })).filled, true);
  assert.equal(f.editor.querySelector('[browser-skill-mention-name]'), marker);
  assert.equal((await f.step('send', { message, draft: message })).clicked, true);
  assert.equal(f.edits.at(-1).text, ' ' + message);
  assert.deepEqual(f.clicks, ['chatgpt jp portrait', 'send']);
});

test('missing or ambiguous skills never click a plugin or send plain @ text', async () => {
  for (const names of [[], ['chatgpt jp portrait', 'chatgpt-jp-portrait']]) {
    const f = fixture({ names }); await f.step('skill');
    const result = await f.step('skill', { skillAttempts: 8 });
    assert.match(result.error, names.length ? /多个同名技能/ : /未找到技能/);
    assert.deepEqual(f.clicks, []);
    assert.match((await f.step('send', { message: '@chatgpt jp portrait' })).error, /技能标记缺失/);
  }
});

test('foreign drafts, wrong skills, and a changed token stop before overwriting or sending', async () => {
  const f = fixture({ plain: '用户自己的草稿' });
  assert.match((await f.step('skill')).error, /草稿/); assert.equal(f.edits.length, 0);
  const g = fixture(); g.select('another skill');
  assert.match((await g.step('skill')).error, /技能标记/); assert.equal(g.edits.length, 0);
  g.select(); g.job.skillApplied = { name: 'chatgpt jp portrait', id: 'previous-skill-id' };
  assert.match((await g.step('prepare')).error, /技能标记缺失/);
  assert.match((await g.step('send')).error, /技能标记缺失/); assert.deepEqual(g.clicks, []);
});

test('a skill query can resume after worker suspension but a lost rich token fails closed', async () => {
  const f = fixture(); await f.step('skill'); await f.step('skill');
  const selected = await f.step('skill');
  f.job.skillApplied = { id: selected.id, name: selected.name };
  f.editor.querySelector('[browser-skill-mention-name]').attrs.contenteditable = 'true';
  assert.match((await f.step('send', { message: '' })).error, /技能标记缺失/);
  assert.ok(!JSON.stringify(selected).includes('private-test-account'));
});

test('an unfocused browser never mistakes an unavailable mention menu for a missing installed skill',async()=>{
  const f=fixture();f.document.hasFocus=()=>false;
  const result=await f.step('skill',{skillAttempts:8});
  assert.equal(result.waitingFor,'window-focus');assert.equal(result.pending,true);
  assert.equal(f.edits.length,0);assert.deepEqual(f.clicks,[]);
});

test('the native editor can open its skill picker through a handled paste transaction',async()=>{
  const f=fixture({clipboard:true});
  assert.equal((await f.step('skill')).inputMethod,'paste');
  assert.equal(f.edits.filter(edit=>edit.operation==='insertText').length,0);
  await f.step('skill');
  assert.equal((await f.step('skill')).applied,true);
  assert.deepEqual(f.clicks,['chatgpt jp portrait']);
});

test('hidden composer indicators and the skill picker are not attachment uploads',async()=>{
  const f=fixture(),form=f.editor.parentElement;
  form.appendChild(el('div',{role:'progressbar',hidden:''}));
  const picker=el('div',{'data-mention-section-id':'skills'},[el('div',{role:'progressbar'})]);
  form.appendChild(picker);
  assert.equal((await f.step('inspect')).uploading,false);
  form.appendChild(el('div',{role:'progressbar'}));
  assert.equal((await f.step('inspect')).uploading,true);
});

test('a restored owned query is cleared in a separate turn before native paste',async()=>{
  const f=fixture({clipboard:true,plain:'@chatgpt jp portrait'});
  f.job.drafts=['@chatgpt jp portrait'];
  assert.equal((await f.step('skill')).queryCleared,true);
  assert.equal(f.editor.innerText,'');
  assert.equal((await f.step('skill')).inputMethod,'paste');
  assert.equal(f.editor.innerText,'@chatgpt jp portrait');
  await f.step('skill');
  assert.equal((await f.step('skill')).applied,true);
});

test('full-name searches select the installed skill from the real Exact matches group',async()=>{
  const f=fixture({clipboard:true,sectionId:'exact-matches'});
  await f.step('skill');await f.step('skill');
  assert.equal((await f.step('skill')).applied,true);
  assert.deepEqual(f.clicks,['chatgpt jp portrait']);
});

test('an exact-name plugin candidate cannot pass native skill confirmation or send',async()=>{
  const f=fixture({clipboard:true,sectionId:'exact-matches',tokenKind:'plugin'});
  await f.step('skill');await f.step('skill');
  assert.match((await f.step('skill')).error,/草稿|技能标记/);
  assert.match((await f.step('send',{message:'画图'})).error,/技能标记缺失/);
  assert.ok(!f.clicks.includes('send'));
});

test('explicit Work can prepare and send without a skill; Chat refuses a Work composer',async()=>{
  const f=fixture(),message='工作模式普通任务';
  const work={mode:'work',skill:undefined,message,draft:message};
  assert.equal((await f.step('prepare',work)).prepared,true);
  assert.equal((await f.step('submit',work)).filled,true);
  assert.equal((await f.step('send',work)).clicked,true);
  const g=fixture(),chat={...work,mode:'chat'};
  assert.equal((await g.step('inspect',chat)).needsChat,true);
  assert.match((await g.step('prepare',chat)).error,/所需模式/);
  assert.match((await g.step('send',chat)).error,/所需模式/);
  assert.deepEqual(g.clicks,[]);assert.equal(g.edits.length,0);
});

test('mode or thread changes after filling prevent the final send',async()=>{
  const f=fixture(),job={mode:'work',skill:undefined,message:'原文',draft:'原文'};
  assert.equal((await f.step('submit',job)).filled,true);
  f.editor.attrs['aria-label']='询问 ChatGPT';
  assert.match((await f.step('send',job)).error,/所需模式/);assert.deepEqual(f.clicks,[]);
  f.editor.attrs['aria-label']='使用 ChatGPT Work';
  assert.match((await f.step('send',{...job,threadId:'11111111-2222-3333-4444-555555555555'})).error,/会话与任务不一致/);
  assert.deepEqual(f.clicks,[]);
});

test('a Work loading shell waits for its native composer instead of failing as an incompatible chat',async()=>{
  const f=fixture();f.editor.attrs['aria-label']='询问 ChatGPT';
  const job={mode:'work',skill:undefined};
  assert.equal((await f.step('work',job)).waitingFor,'work-mode-control');
  assert.match((await f.step('send',{...job,message:''})).error,/所需模式/);
  f.editor.attrs['aria-label']='使用 ChatGPT Work';
  assert.equal((await f.step('inspect',job)).needsWork,false);
  assert.equal((await f.step('prepare',job)).prepared,true);assert.deepEqual(f.clicks,[]);
});
