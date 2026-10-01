const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {el,img,createDocument}=require('./helpers/dom.cjs');

const WORKER=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
const THREAD='11111111-2222-3333-4444-555555555555';
// vm 里创建的对象属于另一个 realm，deepStrictEqual 会因为原型不同而失败，
// 所以断言前统一过一遍 JSON。
const plain=value=>JSON.parse(JSON.stringify(value));
const wait=()=>new Promise(resolve=>setImmediate(resolve));

function stubChrome(){
 return {
  alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},
  runtime:{onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
  storage:{local:{get:async()=>({}),set:async()=>{}}},
  tabs:{create:async()=>({id:1}),get:async()=>({url:'https://chatgpt.com/'}),remove:async()=>{}},
  scripting:{executeScript:async()=>[{result:{}}]},
 };
}
// 扩展的页面脚本只能注入，没法 require；这里在沙箱里跑整个 service worker，
// pageStep 与 tick 都是顶层函数，可以直接调用 —— 不再需要按函数名切源码。
function sandboxOf({document=createDocument(),location={href:'https://chatgpt.com/',pathname:'/'},chrome,fetch:fetchImpl}={}){
 const sandbox={console,AbortSignal,structuredClone,
  setInterval:()=>{},importScripts:()=>{},BRIDGE:{url:'http://local',token:'test'},
  atob:value=>Buffer.from(value,'base64').toString('binary'),
  btoa:value=>Buffer.from(value,'binary').toString('base64'),
  InputEvent:class{constructor(type,options){this.type=type;Object.assign(this,options);}},
  Event:class{constructor(type){this.type=type;}},
  fetch:fetchImpl||(async()=>({ok:true,json:async()=>({job:null})})),
  chrome:chrome||stubChrome(),location,document};
 vm.createContext(sandbox);
 vm.runInContext(WORKER,sandbox);
 return sandbox;
}
function worker({state=null,results={},storageSeed={}}={}){
 const storage={...storageSeed},calls=[];
 const sandbox=sandboxOf({
  document:createDocument(),
  chrome:{
   ...stubChrome(),
   storage:{local:{
    get:async key=>{const keys=Array.isArray(key)?key:[key];const out={};for(const k of keys)out[k]=storage[k];return out;},
    set:async values=>Object.assign(storage,plain(values)),
   }},
   tabs:{create:async()=>({id:1}),get:async()=>({url:'https://chatgpt.com/c/'+THREAD}),remove:async()=>{calls.push({route:'tabs.remove'});}},
   scripting:{executeScript:async({args:[op,job]})=>{calls.push({op,job:plain(job)});return [{result:typeof results==='function'?results(op,job):results[op]}];}},
  },
  fetch:async(url,options)=>{
   const route=String(url).replace('http://local','').split('?')[0];
   const body=options?.body;
   calls.push({route,body:body&&typeof body==='string'?JSON.parse(body):null,bytes:body&&typeof body!=='string'?body.length:0});
   return String(url).endsWith('/state')?{ok:true,json:async()=>({job:state})}:{ok:true,json:async()=>({})};
  },
 });
 return {sandbox,storage,calls};
}
const opsOf=(calls,op)=>calls.filter(call=>call.op===op);
const routeOf=(calls,route)=>calls.filter(call=>call.route===route);

// ---------------------------------------------------------------- 回复序列化

function replyDocument(){
 const document=createDocument();
 const turn=el('div',{'data-testid':'conversation-turn-3'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'}));
 const markdown=el('div',{class:'markdown prose'});
 markdown.appendChild(el('h2',{},['标题']));
 markdown.appendChild(el('p',{},['普通段落，含 ',el('code',{},['inline']),' 和 ',el('a',{href:'https://example.com/x'},['链接']),'。']));
 markdown.appendChild(el('ul',{},[el('li',{},['第一项']),el('li',{},['第二项'])]));
 markdown.appendChild(el('ol',{},[el('li',{},['步骤一'])]));
 markdown.appendChild(el('blockquote',{},['引用内容']));
 markdown.appendChild(el('pre',{},[el('code',{class:'language-js'},['const a = 1;'])]));
 markdown.appendChild(el('table',{},[el('tr',{},[el('th',{},['列']),el('th',{},['值'])]),el('tr',{},[el('td',{},['a']),el('td',{},['1'])])]));
 markdown.appendChild(el('hr'));
 turn.appendChild(markdown);
 document.body.appendChild(turn);
 return {document,turn,markdown};
}

test('a reply is serialized into ordered segments that keep its structure', async()=>{
 const {document}=replyDocument();
 const sandbox=sandboxOf({document});
 const result=await sandbox.pageStep('read',{});
 assert.deepEqual(plain(result.segments),[
  {type:'text',text:'## 标题'},
  {type:'text',text:'普通段落，含 `inline` 和 链接 (https://example.com/x)。'},
  {type:'text',text:'- 第一项'},
  {type:'text',text:'- 第二项'},
  {type:'text',text:'1. 步骤一'},
  {type:'text',text:'> 引用内容'},
  {type:'code',language:'js',text:'const a = 1;'},
  {type:'text',text:'| 列 | 值 |\n| a | 1 |'},
  {type:'text',text:'---'},
 ]);
 assert.equal(result.imageCount,0);
});

test('a fenced code block without a language still comes back as code', async()=>{
 const document=createDocument();
 const turn=el('div',{'data-testid':'conversation-turn-1'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'}));
 const markdown=el('div',{class:'markdown'});
 markdown.appendChild(el('pre',{},[el('code',{},['plain()'])]));
 turn.appendChild(markdown);
 document.body.appendChild(turn);
 const result=await sandboxOf({document}).pageStep('read',{});
 assert.deepEqual(plain(result.segments),[{type:'code',language:'',text:'plain()'}]);
});

test('reply images come back in document order, never the avatar or the user attachment', async()=>{
 const document=createDocument();
 const header=el('header');
 const avatar=img('https://chatgpt.com/avatar/me',{width:512,height:512});
 header.appendChild(avatar);
 document.body.appendChild(header);
 const main=el('main');
 document.body.appendChild(main);
 // The user's own turn, with the picture they attached to the question.
 const userTurn=el('div',{'data-testid':'conversation-turn-2'});
 const bubble=el('div',{'data-user-message-bubble':''},['看看这两张']);
 const attachment=img('blob:https://chatgpt.com/ref',{width:1053,height:1920,alt:'用户附件'});
 bubble.appendChild(attachment);
 userTurn.appendChild(bubble);
 main.appendChild(userTurn);
 const turn=el('div',{'data-testid':'conversation-turn-3'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'}));
 const markdown=el('div',{class:'markdown'});
 const first=img('blob:https://chatgpt.com/first',{width:1024,height:768});
 const second=img('blob:https://chatgpt.com/second',{width:640,height:480});
 markdown.appendChild(el('p',{},['两张图：']));
 markdown.appendChild(first);
 markdown.appendChild(el('p',{},['以及：']));
 markdown.appendChild(second);
 turn.appendChild(markdown);
 main.appendChild(turn);
 const result=await sandboxOf({document}).pageStep('read',{});
 assert.deepEqual(plain(result.segments),[
  {type:'text',text:'两张图：'},
  {type:'image',asset:0,mime:'image/png'},
  {type:'text',text:'以及：'},
  {type:'image',asset:1,mime:'image/png'},
 ]);
 assert.equal(result.imageCount,2);
 assert.ok(!JSON.stringify(result.segments).includes('ref'),'参考图绝不能出现在回复里');
});

test('an assistant turn that wraps the user turn still never returns the attachment', async()=>{
 // 真实页面里 assistant 轮次容器有时会连用户消息一起包住（任务 02c2fa8e036a）。
 const document=createDocument();
 const main=el('main');
 document.body.appendChild(main);
 const wrapper=el('div',{'data-testid':'conversation-turn-4'});
 const bubble=el('div',{'data-user-message-bubble':''},['参考这个']);
 const attachment=img('blob:https://chatgpt.com/ref',{width:1053,height:1920,alt:'用户附件'});
 bubble.appendChild(attachment);
 wrapper.appendChild(bubble);
 wrapper.appendChild(el('h4',{'data-conversation-role':'assistant'}));
 const markdown=el('div',{class:'markdown'});
 markdown.appendChild(el('p',{},['还没出图。']));
 wrapper.appendChild(markdown);
 main.appendChild(wrapper);
 const result=await sandboxOf({document}).pageStep('read',{});
 assert.deepEqual(plain(result.segments),[{type:'text',text:'还没出图。'}]);
 assert.equal(result.imageCount,0);
});

test('an empty assistant turn is not a finished reply', async()=>{
 const document=createDocument();
 const turn=el('div',{'data-testid':'conversation-turn-1'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'}));
 turn.appendChild(el('div',{class:'markdown'}));
 document.body.appendChild(turn);
 const info=await sandboxOf({document}).pageStep('inspect',{id:'abcdef123456'});
 assert.equal(info.replyLength,0);
 assert.equal(info.images,0);
 assert.equal(info.stopping,false);
});

test('the assistant role heading is never part of the reply', async()=>{
 // 线上真实形状：轮次容器里只有角色标题和还没出图的画廊，
 // 没有 markdown 容器，所以 walk() 会退到整个轮次容器。
 const document=createDocument();
 const main=el('main');
 document.body.appendChild(main);
 const turn=el('div',{'data-testid':'conversation-turn-5'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'},['ChatGPT 说：']));
 turn.appendChild(el('div',{'data-testid':'generated-image-gallery'},[el('div',{class:'placeholder'})]));
 main.appendChild(turn);
 const sandbox=sandboxOf({document});
 const read=await sandbox.pageStep('read',{});
 assert.deepEqual(plain(read.segments),[],'「ChatGPT 说：」不是回复内容');
 const info=await sandbox.pageStep('inspect',{id:'abcdef123456'});
 assert.equal(info.replyLength,0);
 assert.equal(info.gallery,true,'画廊已出现说明图正在画');
 assert.equal(info.images,0);
});

test('a generated picture is still found when the conversation is not inside <main>', async()=>{
 // 任务 e1d8e9675311 的现场：图片确实存在（1367×1150、已加载、就在
 // generated-image-gallery 里），但会话不在 <main> 内，于是被「不在 main 内」
 // 这条判断整批判成页面框架，等满 240 秒后报「未检测到本轮图片」。
 const document=createDocument();
 const unrelatedMain=el('main');            // 页面上确实有 <main>，但与会话无关
 document.body.appendChild(unrelatedMain);
 const page=el('div',{class:'page'});
 document.body.appendChild(page);
 const turn=el('div',{'data-testid':'conversation-turn-7'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'},['ChatGPT 说：']));
 const gallery=el('div',{'data-testid':'generated-image-gallery'});
 const button=el('button',{'data-testid':'generated-image-preview','aria-label':'已生成图像 1'});
 button.appendChild(img('blob:https://chatgpt.com/12f867b7',{width:1367,height:1150,alt:'已生成图像 1'}));
 gallery.appendChild(button);
 turn.appendChild(gallery);
 page.appendChild(turn);
 const sandbox=sandboxOf({document});
 const read=await sandbox.pageStep('read',{});
 assert.equal(read.imageCount,1);
 assert.deepEqual(plain(read.segments),[{type:'image',asset:0,mime:'image/png'}]);
 const info=await sandbox.pageStep('inspect',{id:'abcdef123456'});
 assert.equal(info.images,1);
 assert.equal(info.gallery,true);
});

test('the account avatar is still excluded when the conversation sits outside <main>', async()=>{
 const document=createDocument();
 document.body.appendChild(el('main'));
 const page=el('div',{class:'page'});
 document.body.appendChild(page);
 const header=el('header');
 header.appendChild(img('https://chatgpt.com/avatar/me',{width:512,height:512}));
 page.appendChild(header);
 const turn=el('div',{'data-testid':'conversation-turn-8'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'},['ChatGPT 说：']));
 const gallery=el('div',{'data-testid':'generated-image-gallery'});
 gallery.appendChild(img('blob:https://chatgpt.com/real',{width:1024,height:1024,alt:'已生成图像 1'}));
 turn.appendChild(gallery);
 page.appendChild(turn);
 const sandbox=sandboxOf({document});
 const read=await sandbox.pageStep('read',{});
 // 头像在 header 里，仍然被排除；只有回复里那张图被选中。
 assert.equal(read.imageCount,1);
 const probe=await sandbox.pageStep('inspect',{id:'abcdef123456'});
 assert.equal(probe.images,1);
 assert.equal(probe.gallery,true);
});

// ---------------------------------------------------------------- 完成判定

test('a reply whose picture is still rendering is waited out, and the tab stays open', async()=>{
 // 这是线上事故的形状：空的 assistant 轮次 + 已出现的画廊占位符。
 // 提前收工会让后面的 chrome.tabs.remove 把还在生成的图片一起关掉。
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'画一只猫',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:0,images:0,gallery:true,imageLoading:false,busyText:'ChatGPT 说：',replySignature:'0/0/0'}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-30000,stableAt:Date.now()-20000,
  lastSignature:'0/0/0',baseline:0,userBaseline:1,sentText:'画一只猫',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/result').length,0);
 assert.equal(routeOf(calls,'/failure').length,0);
 assert.equal(calls.filter(call=>call.route==='tabs.remove').length,0,'图还没出来就不能关标签页');
 assert.match(storage.status,/正在生成/);
});

test('a picture that has not finished loading keeps the worker waiting', async()=>{
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'画一只猫',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:0,images:1,gallery:true,imageLoading:true,busyText:'',replySignature:'0/0/1'}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-30000,stableAt:Date.now()-20000,
  lastSignature:'0/0/1',baseline:0,userBaseline:1,sentText:'画一只猫',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/result').length,0);
 assert.equal(calls.filter(call=>call.route==='tabs.remove').length,0);
});

test('a turn that never produces anything fails at the hard cap instead of hanging', async()=>{
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'画一只猫',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:0,images:0,gallery:false,imageLoading:false,busyText:'',replySignature:'0/0/0'}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-250000,stableAt:Date.now()-200000,
  lastSignature:'0/0/0',baseline:0,userBaseline:1,sentText:'画一只猫',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,1);
 assert.match(storage.status,/任务失败/);
});

// ---------------------------------------------------------------- 回合识别

test('the prompt is forwarded verbatim, with no connector marker in it', async()=>{
 const editor={innerText:'',focus(){},dispatchEvent(){}};
 const document=createDocument();
 document.body.appendChild(el('main'));
 const sandbox=sandboxOf({document});
 sandbox.document.querySelector=selector=>selector.includes('textbox')?editor:null;
 sandbox.document.querySelectorAll=()=>[];
 sandbox.document.execCommand=(command,_ui,value)=>{if(command==='insertText')editor.innerText=value;return true;};
 const message='帮我写一个快排，用 Python';
 const result=await sandbox.pageStep('submit',{id:'abcdef123456',message,threadId:''});
 assert.equal(result.filled,true);
 assert.equal(editor.innerText,message);
 assert.doesNotMatch(editor.innerText,/QQ|连接器|任务编号/);
});

test('a stale connector draft is cleared, but the user\'s own text is never overwritten', async()=>{
 const commands=[];
 const editor={innerText:'旧的任务正文',focus(){},dispatchEvent(){}};
 const document=createDocument();
 document.body.appendChild(el('main'));
 const sandbox=sandboxOf({document});
 sandbox.document.querySelector=selector=>selector.includes('textbox')?editor:null;
 sandbox.document.querySelectorAll=()=>[];
 sandbox.document.execCommand=(command,_ui,value)=>{
  commands.push(command);
  if(command==='delete')editor.innerText='';
  if(command==='insertText')editor.innerText=value;
  return true;
 };
 // 上一次运行留下的草稿：扩展记得自己填过什么，所以能认出来并清掉。
 const cleared=await sandbox.pageStep('submit',{id:'abcdef123456',message:'新的问题',draft:'旧的任务正文',threadId:''});
 assert.equal(cleared.filled,true);
 assert.deepEqual(commands,['selectAll','delete','selectAll','insertText']);
 assert.equal(editor.innerText,'新的问题');
 // 不是自己填的内容：停下来，绝不覆盖。
 editor.innerText='用户自己打的字';
 await assert.rejects(async()=>{
  const result=await sandbox.pageStep('submit',{id:'abcdef123456',message:'新的问题',draft:'旧的任务正文',threadId:''});
  if(result.error)throw Error(result.error);
 },/已有内容/);
 assert.equal(editor.innerText,'用户自己打的字');
});

test('the new user turn is recognised by counting, not by matching a marker', async()=>{
 const document=createDocument();
 const main=el('main');
 document.body.appendChild(main);
 for(const [index,text] of ['第一问','第二问'].entries()){
  const turn=el('div',{'data-testid':'conversation-turn-'+index});
  turn.appendChild(el('div',{'data-user-message-bubble':''},[text]));
  main.appendChild(turn);
 }
 const sandbox=sandboxOf({document});
 const before=await sandbox.pageStep('inspect',{id:'abcdef123456',userBaseline:2,sentText:'第三问'});
 assert.equal(before.submitted,false);
 const third=el('div',{'data-testid':'conversation-turn-9'});
 third.appendChild(el('div',{'data-user-message-bubble':''},['第三问']));
 main.appendChild(third);
 const after=await sandbox.pageStep('inspect',{id:'abcdef123456',userBaseline:2,sentText:'第三问'});
 assert.equal(after.submitted,true);
 assert.equal(after.textMatched,true);
 // 页面把消息渲染成了别的样子（markdown、折叠）时，文本对不上，但计数仍然成立 ——
 // 计数是主信号，否则会把一次成功的提交判成失败。
 const rendered=await sandbox.pageStep('inspect',{id:'abcdef123456',userBaseline:2,sentText:'**第三问**'});
 assert.equal(rendered.submitted,true);
 assert.equal(rendered.textMatched,false);
});

test('reference images are attached once, before any submit', async()=>{
 const events=[],input={files:null,dispatchEvent:event=>events.push(event.type)};
 const editor={focus(){}};
 const document=createDocument();
 document.body.appendChild(el('main'));
 const sandbox=sandboxOf({document});
 sandbox.document.querySelector=selector=>selector==='input[type="file"]'?input:(selector.includes('textbox')?editor:null);
 sandbox.document.querySelectorAll=()=>[];
 sandbox.File=class{constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type;}};
 sandbox.DataTransfer=class{constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}};
 sandbox.Event=class{constructor(type){this.type=type;}};
 sandbox.ClipboardEvent=class{};
 const result=await sandbox.pageStep('attach',{id:'abcdef123456',images:[{name:'input-0.png',mime:'image/png',base64:'AQIDBA=='}]});
 assert.equal(result.attached,1);
 assert.deepEqual(events,['input','change']);
 assert.equal(input.files[0].type,'image/png');
 assert.deepEqual(Array.from(input.files[0].parts[0]),[1,2,3,4]);
 const none=await sandbox.pageStep('attach',{id:'abcdef123456',images:[]});
 assert.equal(none.attached,0);
});

// ---------------------------------------------------------------- 工作流程

test('the worker fills and sends in separate ticks and never resends an uncertain submission', async()=>{
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'一只猫',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:0,users:0,threadId:'',submitted:false,stopping:false,replyLength:0,images:0,gallery:false,imageLoading:false,replySignature:'0/0/0'},
   submit:{filled:true},send:{clicked:true}},
 });
 await wait(); // 自动的第一次 tick 会开标签页
 storage.current={id:'abcdef123456',tabId:1,phase:'opening',openedAt:Date.now(),sentText:'一只猫',hasImages:false,draft:null,padded:false};
 // 进入 filling 之后同一个 tick 里就填写，填写与点击发送仍然分属两个 tick。
 await sandbox.tick();
 assert.equal(storage.current.phase,'filled');
 assert.equal(opsOf(calls,'submit').length,1);
 assert.equal(opsOf(calls,'send').length,0);
 await sandbox.tick();
 assert.equal(opsOf(calls,'send').length,1);
 assert.equal(storage.current.phase,'waiting');
 // 已经点了发送就绝不再点一次。
 await sandbox.tick();
 await sandbox.tick();
 assert.equal(opsOf(calls,'send').length,1);
 assert.equal(opsOf(calls,'submit').length,1);
});

test('a pure image message only gains a single space once the send button refuses', async()=>{
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'',threadId:'',cancelled:false,images:[{index:0,mime:'image/png',name:'input-0.png',size:4}]},
  results:{inspect:{editor:true,assistants:0,users:0,threadId:'',submitted:false,stopping:false,replyLength:0,images:0,gallery:false,imageLoading:false,replySignature:'0/0/0'},
   submit:{filled:true},send:{ready:false}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'filled',filledAt:Date.now()-6000,sentText:'',hasImages:true,
  draft:'',padded:false,threadId:'',baseline:0,userBaseline:0};
 await sandbox.tick();
 assert.equal(storage.current.padded,true);
 assert.equal(storage.current.phase,'filling');
 await sandbox.tick();
 assert.equal(opsOf(calls,'submit').at(-1).job.message,' ');
});

test('a stable reply is read back and handed to the bridge', async()=>{
 const segments=[{type:'text',text:'下面是示例：'},{type:'code',language:'python',text:'print(1)'}];
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'写个例子',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:6,images:0,gallery:false,imageLoading:false,replySignature:'1/6/0'},
   read:{threadId:THREAD,segments,imageCount:0}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-20000,stableAt:Date.now()-10000,
  lastSignature:'1/6/0',baseline:0,userBaseline:1,sentText:'写个例子',threadId:'',draft:null};
 await sandbox.tick();
 const result=routeOf(calls,'/result');
 assert.equal(result.length,1);
 assert.deepEqual(result[0].body.segments,segments);
 assert.equal(result[0].body.threadId,THREAD);
 assert.equal(routeOf(calls,'/failure').length,0);
});

test('a reply that carries pictures uploads them as raw bytes before the result', async()=>{
 const segments=[{type:'image',asset:0,mime:'image/png'},{type:'text',text:'做好了。'}];
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'画个图',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:4,images:1,gallery:true,imageLoading:false,replySignature:'2/4/1'},
   read:{threadId:THREAD,segments,imageCount:1},
   image:{base64:Buffer.from('89504e470d0a1a0a','hex').toString('base64')}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-20000,stableAt:Date.now()-10000,
  lastSignature:'2/4/1',baseline:0,userBaseline:1,sentText:'画个图',threadId:'',draft:null};
 await sandbox.tick();
 const upload=routeOf(calls,'/result-asset');
 assert.equal(upload.length,1);
 assert.equal(upload[0].bytes,8);
 assert.equal(routeOf(calls,'/result').length,1);
});

test('a refusal is delivered as an ordinary reply, never as a failure', async()=>{
 const segments=[{type:'text',text:'抱歉，我不能帮你做这个。'}];
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'帮我做点坏事',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:12,images:0,gallery:false,imageLoading:false,replySignature:'3/12/0'},
   read:{threadId:THREAD,segments,imageCount:0}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-20000,stableAt:Date.now()-10000,
  lastSignature:'3/12/0',baseline:0,userBaseline:1,sentText:'帮我做点坏事',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0);
 assert.deepEqual(routeOf(calls,'/result')[0].body.segments,segments);
});

test('a page that never stops looking busy is waited out, then fails at the hard cap', async()=>{
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'一只猫',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:4,images:0,gallery:false,imageLoading:false,busyText:'正在生成',replySignature:'4/4/0'}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-60000,stableAt:Date.now(),baseline:0,
  userBaseline:1,sentText:'一只猫',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0);
 assert.match(storage.status,/正在生成/);
 storage.current.sentAt=Date.now()-250000;
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,1);
 assert.match(storage.status,/任务失败/);
});

test('a page with nothing readable fails once, with a page snapshot attached', async()=>{
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'一只猫',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:7,images:0,gallery:false,imageLoading:false,replySignature:'5/7/0'},
   read:{threadId:THREAD,segments:[],imageCount:0,probe:{turns:0,roleNodes:['h4@assistant']}}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-20000,stableAt:Date.now()-10000,
  lastSignature:'5/7/0',baseline:0,userBaseline:1,sentText:'一只猫',threadId:'',draft:null};
 await sandbox.tick();
 const failure=routeOf(calls,'/failure');
 assert.equal(failure.length,1);
 assert.match(failure[0].body.message,/没有读取到可回传的内容/);
 assert.equal(failure[0].body.probe.turns,0);
});

test('a task cancelled by the bridge is stopped and reported, never submitted', async()=>{
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'一只猫',threadId:'',cancelled:true,images:[]},
  results:{inspect:{editor:true,assistants:0,users:0,threadId:'',submitted:false,stopping:false,replyLength:0,images:0,gallery:false,imageLoading:false,replySignature:'0/0/0'},stop:{stopped:true}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now(),stableAt:Date.now(),baseline:0,
  userBaseline:0,sentText:'一只猫',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(opsOf(calls,'stop').length,1);
 assert.equal(opsOf(calls,'submit').length,0);
 assert.equal(routeOf(calls,'/failure').length,1);
});
