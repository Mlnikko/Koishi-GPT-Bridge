const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('browser worker fills and sends in separate ticks, persists sending before click, and never resends an uncertain submission',async()=>{
 const storage={},operations=[];const task={id:'abcdef123456',prompt:'a circle',threadId:'',cancelled:false};
 const sandbox={console,AbortSignal,Error,JSON,Date,setInterval:()=>{},importScripts:()=>{},BRIDGE:{url:'http://local',token:'test'},
  fetch:async()=>({ok:true,json:async()=>({job:task})}),
  chrome:{alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},runtime:{onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
   storage:{local:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values))}},
   tabs:{create:async()=>({id:1}),get:async()=>({url:'https://chatgpt.com/'})},
   scripting:{executeScript:async({args:[op]})=>{
    operations.push(op);
    if(op==='inspect')return[{result:{editor:true,assistants:0,threadId:'',matching:false}}];
    if(op==='submit')return[{result:{filled:true}}];
    if(op==='send'){assert.equal(storage.current.phase,'sending');return[{result:{clicked:true}}];}
    throw Error('unexpected operation');
   }}},};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8'),sandbox);
 await new Promise(setImmediate); // automatic first tick opens tab
 await vm.runInContext('tick()',sandbox);
 assert.deepEqual(operations,['inspect','submit']);assert.equal(storage.current.phase,'filled');
 await vm.runInContext('tick()',sandbox);
 assert.equal(operations.filter(x=>x==='send').length,1);
 await vm.runInContext('tick()',sandbox);
 assert.equal(operations.filter(x=>x==='send').length,1);
 storage.current.phase='sending';await vm.runInContext('tick()',sandbox);
 assert.equal(operations.filter(x=>x==='send').length,1);
});
test('web page reads user bubbles separately from assistant role headings',async()=>{
 const full=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
 const code=full.slice(full.indexOf('async function pageStep('),full.indexOf('async function page(tabId'));
 const user={parentElement:{innerText:'QQ绘图任务 abcdef123456\na circle'}};
 const generated={complete:true,naturalWidth:1254,naturalHeight:1254,currentSrc:'blob:https://chatgpt.com/2f3c',getAttribute:name=>({alt:'Generated image','data-testid':'generated-image-preview'}[name]??null)};
 const assistant={parentElement:{innerText:'ChatGPT 说：编辑',querySelectorAll:()=>[generated]}};
 const sandbox={location:{href:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',pathname:'/c/11111111-2222-3333-4444-555555555555'},
  document:{body:{innerText:''},querySelector:selector=>selector.includes('textbox')?{}:null,querySelectorAll:selector=>selector==='[data-user-message-bubble]'?[user]:selector==='[data-conversation-role="assistant"]'?[assistant]:[]}};
 vm.createContext(sandbox);vm.runInContext(code,sandbox);
 const info=await vm.runInContext("pageStep('inspect',{id:'abcdef123456'})",sandbox);
 assert.equal(info.matching,true);assert.equal(info.users,1);assert.equal(info.assistants,1);assert.equal(info.imageReady,true);
});
test('web page clears only a stale connector draft before filling a new task',async()=>{
 const full=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
 const code=full.slice(full.indexOf('async function pageStep('),full.indexOf('async function page(tabId'));
 const commands=[];
 const editor={innerText:'QQ绘图任务 abcdef123456\nold request',focus(){},dispatchEvent(){}};
 const sandbox={InputEvent:class{},location:{href:'https://chatgpt.com/',pathname:'/'},
  document:{body:{innerText:''},querySelector:selector=>selector.includes('textbox')?editor:null,
   querySelectorAll:selector=>selector==='button'?[]:[],execCommand:(command,_ui,value)=>{
    commands.push(command);if(command==='delete')editor.innerText='';
    if(command==='insertText')editor.innerText=value;return true;
   }}};
 vm.createContext(sandbox);vm.runInContext(code,sandbox);
 const result=await vm.runInContext("pageStep('submit',{id:'111111111111',message:'new request\\nQQ绘图任务 111111111111',threadId:''})",sandbox);
 assert.equal(result.filled,true);assert.deepEqual(commands,['selectAll','delete','selectAll','insertText']);
 assert.equal(editor.innerText,'new request\nQQ绘图任务 111111111111');
});
test('web page attaches a reference image to the composer file input before any submit',async()=>{
 const full=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
 const code=full.slice(full.indexOf('async function pageStep('),full.indexOf('async function page(tabId'));
 const events=[],input={files:null,dispatchEvent:event=>events.push(event.type)};
 const editor={focus(){}};
 const sandbox={InputEvent:class{},File:class{constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type;}},
  DataTransfer:class{constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}},
  Event:class{constructor(type){this.type=type;}},
  ClipboardEvent:class{},location:{href:'https://chatgpt.com/',pathname:'/'},
  atob:value=>Buffer.from(value,'base64').toString('binary'),
  document:{body:{innerText:''},querySelector:selector=>selector==='input[type="file"]'?input:(selector.includes('textbox')?editor:null),
   querySelectorAll:()=>[]}};
 vm.createContext(sandbox);vm.runInContext(code,sandbox);
 const result=await vm.runInContext("pageStep('attach',{id:'abcdef123456',images:[{name:'input-0.png',mime:'image/png',base64:'AQIDBA=='}]})",sandbox);
 assert.equal(result.attached,1);assert.deepEqual(events,['input','change']);
 assert.equal(input.files[0].type,'image/png');assert.equal(input.files[0].name,'input-0.png');
 assert.deepEqual(Array.from(input.files[0].parts[0]),[1,2,3,4]);
 const none=await vm.runInContext("pageStep('attach',{id:'abcdef123456',images:[]})",sandbox);
 assert.equal(none.attached,0);
});
test('browser worker uploads the reference image once, then fills and sends',async()=>{
 const storage={},operations=[];let attachments=0;
 const task={id:'abcdef123456',prompt:'把背景改成夜晚',kind:'image',images:[{index:0,mime:'image/png',name:'input-0.png',size:4}],threadId:'',cancelled:false};
 const sandbox={console,AbortSignal,Error,JSON,Date,setInterval:()=>{},importScripts:()=>{},BRIDGE:{url:'http://local',token:'test'},
  btoa:value=>Buffer.from(value,'binary').toString('base64'),
  fetch:async url=>String(url).includes('/input')
   ?{ok:true,arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer}
   :{ok:true,json:async()=>({job:task})},
  chrome:{alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},runtime:{onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
   storage:{local:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values))}},
   tabs:{create:async()=>({id:1}),get:async()=>({url:'https://chatgpt.com/'})},
   scripting:{executeScript:async({args:[op,payload]})=>{
    operations.push(op);
    if(op==='inspect')return[{result:{editor:true,assistants:0,threadId:'',matching:false,attachments}}];
    if(op==='attach'){assert.equal(payload.images[0].mime,'image/png');assert.equal(payload.images[0].base64,'AQIDBA==');attachments=1;return[{result:{attached:1}}];}
    if(op==='submit')return[{result:{filled:true}}];
    if(op==='send')return[{result:{clicked:true}}];
    throw Error('unexpected operation '+op);
   }}},};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8'),sandbox);
 await new Promise(setImmediate); // automatic first tick opens the tab
 assert.match(storage.current.message,/附加 1 张参考图片/);assert.equal(storage.current.hasImages,true);
 await vm.runInContext('tick()',sandbox);
 assert.equal(storage.current.phase,'attaching');
 await vm.runInContext('tick()',sandbox);
 assert.equal(operations.filter(x=>x==='attach').length,1);assert.equal(storage.current.phase,'attaching');
 await vm.runInContext('tick()',sandbox); // attachment confirmed -> fill and submit
 assert.equal(storage.current.phase,'filled');assert.equal(operations.filter(x=>x==='submit').length,1);
 await vm.runInContext('tick()',sandbox);
 assert.equal(operations.filter(x=>x==='send').length,1);
 await vm.runInContext('tick()',sandbox);
 assert.equal(operations.filter(x=>x==='attach').length,1);
});
test('a generated image is found by its shape, not by a single data-testid',async()=>{
 const full=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
 const code=full.slice(full.indexOf('async function pageStep('),full.indexOf('async function page(tabId'));
 const bitmap=overrides=>Object.assign({complete:true,naturalWidth:1024,naturalHeight:1024,currentSrc:'blob:https://chatgpt.com/2f3c',
  getAttribute:name=>({alt:'生成图片','data-testid':null}[name]??null)},overrides);
 const run=async(sandbox,job)=>{vm.createContext(sandbox);vm.runInContext(code,sandbox);
  return vm.runInContext("pageStep('inspect',"+JSON.stringify(job)+")",sandbox);};
 // The wrapper no longer carries the legacy testid; the bitmap itself is enough.
 const generated=bitmap();
 const assistantTurn={innerText:'ChatGPT 说：编辑',textContent:'ChatGPT 说：编辑',querySelectorAll:sel=>sel==='img'?[generated]:[]};
 const userTurn={innerText:'QQ绘图任务 abcdef123456\n一只猫',contains:()=>false};
 const documentFor=imgs=>({body:{innerText:''},querySelector:()=>null,
  querySelectorAll:sel=>sel==='[data-user-message-bubble]'?[{closest:()=>userTurn}]
   :sel==='[data-conversation-role="assistant"]'?[{closest:()=>assistantTurn}]
   :sel==='img'?imgs:[]});
 const scoped=await run({location:{href:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',pathname:'/c/11111111-2222-3333-4444-555555555555'},
  document:documentFor([])},{id:'abcdef123456',baseline:0});
 assert.equal(scoped.images,1);assert.equal(scoped.imageReady,true);assert.equal(scoped.generating,false);
 // A preview rendered outside the turn is still picked up when the page files it
 // under a generated-image gallery. The reference image the user attached is not,
 // and neither is a large bitmap the page does not mark as a generation.
 const reference=bitmap({currentSrc:'blob:https://chatgpt.com/ref',getAttribute:name=>({alt:'用户附件','data-testid':null}[name]??null)});
 const outside=bitmap({naturalWidth:1536,naturalHeight:1536,closest:selector=>/generated-image/.test(selector)?{tagName:'DIV'}:null});
 const stray=bitmap({naturalWidth:2048,naturalHeight:2048});
 const userEl={closest:()=>Object.assign(userTurn,{contains:img=>img===reference})};
 const fallback=await run({location:{href:'https://chatgpt.com/',pathname:'/'},
  document:{body:{innerText:''},querySelector:()=>null,
   querySelectorAll:sel=>sel==='[data-user-message-bubble]'?[userEl]
    :sel==='[data-conversation-role="assistant"]'?[{closest:()=>Object.assign(assistantTurn,{querySelectorAll:()=>[]})}]
    :sel==='img'?[reference,outside,stray]:[]}},{id:'abcdef123456',baseline:0});
 assert.equal(fallback.images,1);assert.equal(fallback.imageReady,true);
});
test('the signed-in avatar in the page chrome is never returned as a result',async()=>{
 const full=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
 const code=full.slice(full.indexOf('async function pageStep('),full.indexOf('async function page(tabId'));
 const bitmap=overrides=>Object.assign({complete:true,naturalWidth:1024,naturalHeight:1024,currentSrc:'blob:https://chatgpt.com/2f3c',
  getAttribute:name=>({alt:'生成图片','data-testid':null}[name]??null)},overrides);
 // The account avatar: a large, already-loaded bitmap sitting in the header.
 const avatar=bitmap({naturalWidth:512,naturalHeight:512,currentSrc:'https://chatgpt.com/avatar/me',
  closest:selector=>/header|profile/.test(selector)?{tagName:'HEADER'}:null});
 const generated=bitmap();
 const run=async(pageImages,turnImages)=>{
  const main={contains:img=>img!==avatar};
  const assistantTurn={innerText:'ChatGPT 说：',textContent:'ChatGPT 说：',querySelectorAll:sel=>sel==='img'?turnImages:[]};
  const userTurn={innerText:'QQ绘图任务 abcdef123456\n一只猫',contains:()=>false};
  const sandbox={location:{href:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',pathname:'/c/11111111-2222-3333-4444-555555555555'},
   document:{body:{innerText:''},
    querySelector:selector=>selector==='main'?main:null,
    querySelectorAll:sel=>sel==='[data-user-message-bubble]'?[{closest:()=>userTurn}]
     :sel==='[data-conversation-role="assistant"]'?[{closest:()=>assistantTurn}]
     :sel==='img'?pageImages:[]}};
  vm.createContext(sandbox);vm.runInContext(code,sandbox);
  return vm.runInContext("pageStep('inspect',{id:'abcdef123456',baseline:0})",sandbox);
 };
 // An empty assistant turn plus the avatar is not a finished answer. Returning
 // the account picture here is exactly the bug this guards.
 const empty=await run([avatar],[]);
 assert.equal(empty.images,0);
 assert.equal(empty.imageReady,false);
 // The real bitmap inside the turn is still found alongside the chrome avatar.
 const ready=await run([avatar,generated],[generated]);
 assert.equal(ready.images,1);
 assert.equal(ready.imageReady,true);
});
test('the attached reference image is never returned while the turn has no picture yet',async()=>{
 // Real DOM from job 02c2fa8e036a: `[data-testid^="conversation-turn"]` no longer
 // matches anything, the assistant turn is an <h4 data-conversation-role="assistant">
 // whose parent holds the generated-image gallery, and that gallery is still a
 // placeholder while the user's own attachment is already loaded on the page.
 const full=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
 const code=full.slice(full.indexOf('async function pageStep('),full.indexOf('async function page(tabId'));
 const bitmap=overrides=>Object.assign({complete:true,naturalWidth:1024,naturalHeight:1024,currentSrc:'blob:https://chatgpt.com/2f3c',
  getAttribute:name=>({alt:'','data-testid':null}[name]??null)},overrides);
 const attachment=bitmap({naturalWidth:1053,naturalHeight:1920,currentSrc:'blob:https://chatgpt.com/ref',
  getAttribute:name=>({alt:'用户附件','data-testid':null}[name]??null)});
 const avatar=bitmap({naturalWidth:512,naturalHeight:512,currentSrc:'https://chatgpt.com/avatar/me',
  closest:selector=>/header|profile/.test(selector)?{tagName:'HEADER'}:null});
 const generated=bitmap();
 const run=async(turnImages)=>{
  // The placeholder-only gallery: no <img> in the turn yet.
  const turnBlock={innerText:'ChatGPT 说：',textContent:'ChatGPT 说：',querySelectorAll:sel=>sel==='img'?turnImages:[]};
  const roleNode={closest:()=>null,parentElement:turnBlock};
  const userTurn={innerText:'QQ绘图任务 abcdef123456\n参考这个图片',contains:()=>false};
  const main={contains:img=>img!==avatar};
  const sandbox={location:{href:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',pathname:'/c/11111111-2222-3333-4444-555555555555'},
   document:{body:{innerText:''},querySelector:selector=>selector==='main'?main:null,
    querySelectorAll:sel=>sel==='[data-user-message-bubble]'?[{closest:()=>userTurn}]
     :sel==='[data-conversation-role="assistant"]'?[roleNode]
     :sel==='img'?[avatar,attachment]:[]}};
  vm.createContext(sandbox);vm.runInContext(code,sandbox);
  return vm.runInContext("pageStep('inspect',{id:'abcdef123456',baseline:0})",sandbox);
 };
 // The attachment and the chrome avatar are both on the page, but the turn has no
 // picture: nothing is ready, so the worker waits instead of sending the reference
 // image back to QQ.
 const waiting=await run([]);
 assert.equal(waiting.images,0);
 assert.equal(waiting.imageReady,false);
 // Once the real bitmap renders inside the turn it is the one that gets picked.
 const ready=await run([generated]);
 assert.equal(ready.images,1);
 assert.equal(ready.imageReady,true);
 // If the turn block ever covers the user's message too — the page's user-bubble
 // marker does not catch the attachment (the probe reported inUser=false) — the
 // alt text is the only thing keeping the reference image out of the result.
 const covered=await run([attachment]);
 assert.equal(covered.images,0);
 assert.equal(covered.imageReady,false);
});
test('ui chrome is never reported as a model reply',async()=>{
 const full=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
 const code=full.slice(full.indexOf('function modelReply('),full.indexOf('async function pageStep('));
 const sandbox={};vm.createContext(sandbox);vm.runInContext(code,sandbox);
 const reply=text=>vm.runInContext('modelReply('+JSON.stringify({assistantText:text})+')',sandbox);
 assert.equal(reply('ChatGPT 说：\n编辑'),'');
 assert.equal(reply('ChatGPT said:\nCopy\nRegenerate'),'');
 assert.equal(reply('抱歉，我不能生成这张图片。'),'抱歉，我不能生成这张图片。');
});
test('an image-only turn that is still rendering is waited out, not failed',async()=>{
 const storage={},calls=[];
 const task={id:'abcdef123456',prompt:'一只猫',kind:'image',threadId:'',cancelled:false};
 const inspect={editor:true,assistants:1,matching:true,threadId:'',imageReady:false,imageLoading:false,generating:true,assistantText:'ChatGPT 说：编辑'};
 const sandbox={console,AbortSignal,Error,JSON,Date,setInterval:()=>{},importScripts:()=>{},BRIDGE:{url:'http://local',token:'test'},
  fetch:async(url,options)=>{calls.push((options?.method||'GET')+' '+String(url).replace('http://local',''));
   return String(url).endsWith('/state')?{ok:true,json:async()=>({job:task})}:{ok:true,json:async()=>({})};},
  chrome:{alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},runtime:{onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
   storage:{local:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values))}},
   tabs:{create:async()=>({id:1}),get:async()=>({url:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555'})},
   scripting:{executeScript:async()=>[{result:inspect}]}},};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8'),sandbox);
 await new Promise(setImmediate); // the automatic first tick must finish before we seed state
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-60000,baseline:0,kind:'image',threadId:'',message:'x'};
 await vm.runInContext('tick()',sandbox);
 assert.equal(calls.some(call=>call.includes('/failure')),false);
 assert.equal(storage.status,'ChatGPT 正在生成图片');
 // A page that never stops looking busy must still give up at the hard cap
 // instead of waiting out the bridge timeout.
 storage.current.sentAt=Date.now()-250000;
 await vm.runInContext('tick()',sandbox);
 assert.equal(calls.filter(call=>call.includes('/failure')).length,1);
 assert.match(storage.status,/任务失败/);
});
test('a real refusal is reported straight away with the model wording',async()=>{
 const storage={},calls=[];
 const task={id:'abcdef123456',prompt:'一只猫',kind:'image',threadId:'',cancelled:false};
 const inspect={editor:true,assistants:1,matching:true,threadId:'',imageReady:false,imageLoading:false,generating:false,assistantText:'抱歉，我不能生成这张图片。'};
 const sandbox={console,AbortSignal,Error,JSON,Date,setInterval:()=>{},importScripts:()=>{},BRIDGE:{url:'http://local',token:'test'},
  fetch:async(url,options)=>{calls.push({route:String(url).replace('http://local',''),body:options?.body?JSON.parse(options.body):null});
   return String(url).endsWith('/state')?{ok:true,json:async()=>({job:task})}:{ok:true,json:async()=>({})};},
  chrome:{alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},runtime:{onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
   storage:{local:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values))}},
   tabs:{create:async()=>({id:1}),get:async()=>({url:'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555'})},
   scripting:{executeScript:async()=>[{result:inspect}]}},};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8'),sandbox);
 await new Promise(setImmediate); // the automatic first tick must finish before we seed state
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-60000,stableAt:Date.now()-30000,
  lastText:'抱歉，我不能生成这张图片。',baseline:0,kind:'image',threadId:'',message:'x'};
 await vm.runInContext('tick()',sandbox);
 const failure=calls.find(call=>call.route==='/failure');
 assert.ok(failure,'expected the worker to report a failure');
 assert.match(failure.body.message,/抱歉，我不能生成这张图片。/);
 assert.match(storage.status,/任务失败/);
});
test('a pure image message still carries an instruction marker so the send button unlocks',async()=>{
 const full=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
 const code=full.slice(full.indexOf('function buildMessage('),full.indexOf('async function api('));
 const sandbox={};vm.createContext(sandbox);vm.runInContext(code,sandbox);
 const text=vm.runInContext("buildMessage({id:'abcdef123456',prompt:'',kind:'image',images:[{index:0}]})",sandbox);
 assert.match(text,/QQ绘图任务 abcdef123456/);
 assert.match(text,/请参考我上传的图片生成一张新的图片/);
 const withText=vm.runInContext("buildMessage({id:'abcdef123456',prompt:'改成夜晚',kind:'image',images:[{index:0}]})",sandbox);
 assert.match(withText,/用户的要求：改成夜晚/);
 const plain=vm.runInContext("buildMessage({id:'abcdef123456',prompt:'一只猫',kind:'text'})",sandbox);
 assert.match(plain,/用户的图片请求：一只猫/);
 assert.doesNotMatch(plain,/参考图片/);
});
