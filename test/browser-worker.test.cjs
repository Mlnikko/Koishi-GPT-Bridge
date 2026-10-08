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
   tabs:{create:async()=>({id:1}),reload:async id=>{calls.push({route:'tabs.reload',tabId:id});},get:async()=>({url:'https://chatgpt.com/c/'+THREAD}),remove:async()=>{calls.push({route:'tabs.remove'});}},
   scripting:{executeScript:async({args:[op,job]})=>{calls.push({op,job:plain(job)});return [{result:op==='prepare'?(results.prepare||{prepared:true}):typeof results==='function'?results(op,job):results[op]}];}},
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

test('a generated picture nested in a preview button is serialized', async()=>{
 // 任务 d4a2a235d1c0 的真实层级：画廊经过多个 DIV 后，图片放在 BUTTON 内，
 // 同级还有一个 DIV。旧 walk() 因为看到同级 DIV 而递归，却又直接跳过 BUTTON，
 // 导致探针 picked=true，serializeReply() 的 images 却仍然是 0。
 const document=createDocument();
 const turn=el('div',{class:'block-BQZwFn'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'},['ChatGPT 说：']));
 const search=el('div',{'data-chatgpt-search-message-ids':'message'});
 const wrapper=el('div');
 const gallery=el('div',{'data-testid':'generated-image-gallery'});
 const track=el('div');
 const preview=el('div');
 const button=el('button',{'data-testid':'generated-image-preview','aria-label':'已生成图像 1'});
 button.appendChild(img('blob:https://chatgpt.com/real',{width:1254,height:1254,alt:'已生成图像 1'}));
 preview.appendChild(button);
 preview.appendChild(el('div',{class:'preview-controls'}));
 track.appendChild(preview);
 gallery.appendChild(track);
 wrapper.appendChild(gallery);
 search.appendChild(wrapper);
 turn.appendChild(search);
 document.body.appendChild(turn);
 const sandbox=sandboxOf({document});
 const read=await sandbox.pageStep('read',{});
 assert.equal(read.imageCount,1);
 assert.deepEqual(plain(read.segments),[{type:'image',asset:0,mime:'image/png'}]);
 const info=await sandbox.pageStep('inspect',{id:'abcdef123456'});
 assert.equal(info.images,1);
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

test('a complete picture found at the hard cap is delivered instead of discarded', async()=>{
 const segments=[{type:'image',asset:0,mime:'image/png'}];
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'画一只猫',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:0,images:1,gallery:true,imageLoading:false,busyText:'',replySignature:'0/0/1'},
   read:{threadId:THREAD,segments,imageCount:1},
   image:{base64:Buffer.from('89504e470d0a1a0a','hex').toString('base64')}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-250000,stableAt:Date.now()-200000,
  lastSignature:'0/0/1',baseline:0,userBaseline:1,sentText:'画一只猫',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0);
 assert.equal(routeOf(calls,'/result-asset').length,1);
 assert.equal(routeOf(calls,'/result').length,1);
});

// ---------------------------------------------------------------- 复用网页会话

test('reusing a ChatGPT thread that no longer opens fails instead of waiting forever', async()=>{
 // 默认就是持续会话，所以用户不会自己去换会话。地址被重定向回首页（threadId 变空）
 // 说明这个会话已经打不开，必须立刻给出可分类的失败，而不是一路空耗到桥接超时。
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'再改一版',threadId:THREAD,cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:0,users:0,threadId:'',submitted:false,stopping:false,
   replyLength:0,images:0,gallery:false,imageLoading:false,replySignature:'0/0/0'}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'opening',openedAt:Date.now()-20000,hasImages:false,
  sentText:'再改一版',draft:null,padded:false,threadId:THREAD};
 await sandbox.tick();
 const failures=routeOf(calls,'/failure');
 assert.equal(failures.length,1);
 assert.match(failures[0].body.message,/会话已不存在或无法打开/);
 assert.match(storage.status,/任务失败/);
});

test('a thread that has just been opened is given time to settle before being declared gone', async()=>{
 // 反向验证：刚打开的标签页还没导航完时不能立刻判死，否则正常续聊会误报。
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'再改一版',threadId:THREAD,cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:0,users:0,threadId:'',submitted:false,stopping:false,
   replyLength:0,images:0,gallery:false,imageLoading:false,replySignature:'0/0/0'}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'opening',openedAt:Date.now(),hasImages:false,
  sentText:'再改一版',draft:null,padded:false,threadId:THREAD};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0,'刚打开的会话还没稳定，不能判死');
});

test('history that renders late in a reused thread is never mistaken for this turn', async()=>{
 // 线上事故的形状（任务 0f24faeed208 / 988bca02fb9f）：复用已有会话时页面异步渲染历史，
 // 刚打开标签页时轮次计数还是 0。若此刻就采样基线，历史一渲染出来计数就从 0 变 1，
 // 于是上一轮的图被当成本轮回复 —— 14 秒就收工，回传的 PNG 与上一轮字节完全相同。
 let inspects=0;
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'去掉袖子',threadId:THREAD,cancelled:false,images:[]},
  results:(op)=>{
   if(op==='inspect'){
    inspects++;
    // 前两次：标签页刚打开，历史还没渲染出来。
    if(inspects<=2)return {editor:true,assistants:0,users:0,threadId:THREAD,submitted:false,stopping:false,
     replyLength:0,images:0,gallery:false,imageLoading:false,replySignature:'0/0/0',assistantId:''};
    // 之后：历史渲染出来了，但那是上一轮的消息，不是本轮。
    return {editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
     replyLength:0,images:1,gallery:true,imageLoading:false,replySignature:'1/0/1',assistantId:'previous-turn'};
   }
   if(op==='submit')return {filled:true};
   if(op==='send')return {clicked:true};
   if(op==='read')return {threadId:THREAD,segments:[{type:'image',asset:0,mime:'image/png'}],imageCount:1};
   if(op==='image')return {base64:Buffer.from('89504e470d0a1a0a','hex').toString('base64')};
   return {};
  },
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'opening',openedAt:Date.now(),hasImages:false,
  sentText:'去掉袖子',draft:null,padded:false,threadId:THREAD};
 await sandbox.tick();
 assert.equal(storage.current.phase,'opening','历史还没渲染出来时不能开始填字');
 await sandbox.tick();
 assert.equal(storage.current.phase,'opening','页面上一轮都还没有，不能急着采样基线');
 storage.current.openedAt=Date.now()-20000;   // 模拟标签页已经打开 20 秒
 await sandbox.tick();   // 历史刚渲染出来，计数变了，要重新计稳定
 assert.equal(storage.current.phase,'opening','计数刚变化时不能采样基线');
 await sandbox.tick();   // 连续两次相同，才允许采样
 assert.equal(storage.current.baseline,1,'轮次基线必须在历史渲染稳定之后采样');
 assert.equal(storage.current.userBaseline,1);
 assert.equal(routeOf(calls,'/result').length,0,'上一轮的图不能被当成本轮回复回传');
 assert.equal(calls.filter(call=>call.route==='tabs.remove').length,0);
});

test('this turn is only finished once a new assistant message actually exists', async()=>{
 // 计数只能说明「轮次变多了」，说明不了「多出来的是我这一轮」。最新 assistant 消息的
 // message id 没变，就说明本轮回复还没出现，此时收工就是把上一轮的图回传。
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'去掉袖子',threadId:THREAD,cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:2,users:2,threadId:THREAD,submitted:true,stopping:false,
   replyLength:0,images:1,gallery:true,imageLoading:false,replySignature:'1/0/1',assistantId:'previous-turn'},
   read:{threadId:THREAD,segments:[{type:'image',asset:0,mime:'image/png'}],imageCount:1},
   image:{base64:Buffer.from('89504e470d0a1a0a','hex').toString('base64')}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-30000,stableAt:Date.now()-20000,
  lastSignature:'1/0/1',baseline:1,userBaseline:1,assistantId:'previous-turn',
  sentText:'去掉袖子',draft:null,padded:false,threadId:THREAD};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0,'不该因为别的原因失败 —— 否则这条断言就是空转');
 assert.equal(routeOf(calls,'/result').length,0,'最新轮次还是提交前那一条，说明本轮回复还没出现');
 assert.equal(calls.filter(call=>call.route==='tabs.remove').length,0);
});

test('a draft is kept until the message is confirmed on the page', async()=>{
 // 点击发送不等于提交成功。提前清掉草稿，输入框里留下的文本就变成认不出来的残留，
 // 下一个任务只会报「输入框已有内容」——线上就是这么连环失败两次的。
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'去掉袖子',threadId:THREAD,cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:false,stopping:false,
   replyLength:0,images:0,gallery:false,imageLoading:false,replySignature:'0/0/0',assistantId:'previous-turn'},
   send:{clicked:true}},
  storageSeed:{draft:'去掉袖子'},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'filled',filledAt:Date.now()-10000,hasImages:false,
  sentText:'去掉袖子',draft:'去掉袖子',padded:false,threadId:THREAD,baseline:1,userBaseline:1};
 await sandbox.tick();
 assert.equal(storage.draft,'去掉袖子','没有确认消息落到页面上之前，草稿不能被清掉');
 assert.equal(routeOf(calls,'/result').length,0);
});

// ---------------------------------------------------------------- 回合识别

test('the prompt is forwarded verbatim, with no connector marker in it', async()=>{
 const editor={innerText:'',getAttribute:key=>key==='role'?'textbox':null,focus(){},dispatchEvent(){}};
 const document=createDocument();
 document.body.appendChild(el('main'));
 const sandbox=sandboxOf({document});
 sandbox.document.querySelector=selector=>selector.includes('textbox')?editor:null;
 sandbox.document.querySelectorAll=selector=>selector==='[contenteditable="true"]'?[editor]:[];
 sandbox.document.execCommand=(command,_ui,value)=>{if(command==='insertText')editor.innerText=value;return true;};
 const message='帮我写一个快排，用 Python';
 const result=await sandbox.pageStep('submit',{id:'abcdef123456',message,threadId:''});
 assert.equal(result.filled,true);
 assert.equal(editor.innerText,message);
 assert.doesNotMatch(editor.innerText,/QQ|连接器|任务编号/);
});

test('a stale connector draft is cleared, but the user\'s own text is never overwritten', async()=>{
 const commands=[];
 const editor={innerText:'旧的任务正文',getAttribute:key=>key==='role'?'textbox':null,focus(){},dispatchEvent(){}};
 const document=createDocument();
 document.body.appendChild(el('main'));
 const sandbox=sandboxOf({document});
 sandbox.document.querySelector=selector=>selector.includes('textbox')?editor:null;
 sandbox.document.querySelectorAll=selector=>selector==='[contenteditable="true"]'?[editor]:[];
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

test('the real composer wins over another textbox and hidden composers are ignored', async()=>{
 const document=createDocument();
 const other=el('div',{role:'textbox',contenteditable:'true'},['x'.repeat(609)]);
 const hidden=el('div',{id:'prompt-textarea',contenteditable:'true',hidden:''},['hidden draft']);
 const editor=el('div',{id:'prompt-textarea',contenteditable:'true'});
 document.body.appendChild(other);document.body.appendChild(hidden);document.body.appendChild(editor);
 editor.focus=()=>{};editor.dispatchEvent=()=>{};
 document.execCommand=(command,_ui,text)=>{if(command==='insertText')editor.childNodes=[{nodeType:3,nodeValue:text}];};
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('submit',{message:'重新生成'})).filled,true);
 assert.equal(other.innerText,'x'.repeat(609));
 assert.equal(hidden.innerText,'hidden draft');
});

test('ambiguous textboxes are diagnosed without editing either one', async()=>{
 const document=createDocument();
 for(let i=0;i<2;i++)document.body.appendChild(el('div',{role:'textbox',contenteditable:'true'},['draft']));
 document.execCommand=()=>assert.fail('must not edit');
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('inspect',{})).editorAmbiguous,true);
 assert.match((await sandbox.pageStep('prepare',{})).error,/多个输入框/);
 const probe=await sandbox.pageStep('probe',{});
 assert.equal(probe.editorCandidates.length,2);
 assert.equal(probe.editorCandidates[0].chars,5);
});

test('prepare accepts a recorded older draft without editing and rejects unknown text', async()=>{
 const document=createDocument();
 const editor=el('div',{id:'prompt-textarea',contenteditable:'true'},['older draft']);
 document.body.appendChild(editor);
 document.execCommand=()=>assert.fail('prepare must not edit');
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('prepare',{draft:'latest draft',drafts:['older draft']})).prepared,true);
 assert.match((await sandbox.pageStep('prepare',{draft:'latest draft',drafts:['other thread']})).error,/已有内容/);
});

test('draft intent is durable before DOM filling and remains recoverable after a failed fill', async()=>{
 let instance;
 instance=worker({state:{id:'draft-task'},storageSeed:{drafts:[{threadId:THREAD,text:'old draft'}]},results:(op,job)=>{
  if(op==='inspect')return {editor:true,submitted:false};
  if(op==='submit'){
   assert.equal(instance.storage.draft,'new draft');
   assert.equal(instance.storage.current.phase,'filling');
   assert.ok(instance.storage.current.drafts.includes('new draft'));
   assert.deepEqual(instance.storage.drafts,[{threadId:THREAD,text:'old draft'},{threadId:THREAD,text:'new draft'}]);
   return {error:'模拟填写后脚本失败'};
  }
  return {};
 }});
 await wait();
 instance.storage.current={id:'draft-task',tabId:1,phase:'filling',threadId:THREAD,sentText:'new draft'};
 await instance.sandbox.tick();
 assert.equal(instance.storage.current,null);
 assert.equal(instance.storage.draft,'new draft');
 assert.equal(instance.storage.drafts.length,2);
 await instance.sandbox.tick();
 assert.deepEqual(instance.storage.current.drafts,[],'new chats must not inherit another thread history');
});

test('rejected preparation never records intent or fills the composer', async()=>{
 const {sandbox,storage,calls}=worker({state:{id:'draft-task'},storageSeed:{draft:'previous'},
  results:{inspect:{editor:true},prepare:{error:'专用标签页输入框已有内容'}}});
 await wait();
 storage.current={id:'draft-task',tabId:1,phase:'filling',sentText:'new draft'};
 await sandbox.tick();
 assert.equal(storage.draft,'previous');assert.equal(storage.drafts,undefined);
 assert.equal(opsOf(calls,'submit').length,0);
});

test('opening a task only loads the draft history of its conversation', async()=>{
 const {storage}=worker({state:{id:'draft-task',threadId:THREAD},storageSeed:{drafts:[
  {threadId:THREAD,text:'old draft'},{threadId:'another',text:'unrelated'},
 ]}});
 await wait();
 assert.deepEqual(storage.current.drafts,['old draft']);
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
 const editor=el('div',{role:'textbox',contenteditable:'true'});editor.focus=()=>{};
 const document=createDocument();
 document.body.appendChild(el('main'));
 const sandbox=sandboxOf({document});
 sandbox.document.querySelector=selector=>selector==='input[type="file"]'?input:(selector.includes('textbox')?editor:null);
 input.getAttribute=()=>null;
 sandbox.document.querySelectorAll=selector=>selector==='input[type="file"]'?[input]:selector==='[contenteditable="true"]'?[editor]:[];
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

test('a readable reply is recovered at the hard cap even if stale busy text remains', async()=>{
 const segments=[{type:'text',text:'完成了。'}];
 const {sandbox,storage,calls}=worker({
  state:{id:'abcdef123456',text:'一只猫',threadId:'',cancelled:false,images:[]},
  results:{inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
    replyLength:4,images:0,gallery:false,imageLoading:false,busyText:'正在生成',replySignature:'4/4/0'},
   read:{threadId:THREAD,segments,imageCount:0}},
 });
 await wait();
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now()-60000,stableAt:Date.now(),baseline:0,
  userBaseline:1,sentText:'一只猫',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0);
 assert.match(storage.status,/正在生成/);
 storage.current.sentAt=Date.now()-250000;
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0);
 storage.current.stableAt=Date.now()-4000;
 await sandbox.tick();
 assert.equal(routeOf(calls,'/result').length,1);
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
 calls.length=0; // Ignore the initial tick acknowledging an unstarted cancelled task.
 storage.current={id:'abcdef123456',tabId:1,phase:'waiting',sentAt:Date.now(),stableAt:Date.now(),baseline:0,
  userBaseline:0,sentText:'一只猫',threadId:'',draft:null};
 await sandbox.tick();
 assert.equal(opsOf(calls,'stop').length,1);
 assert.equal(opsOf(calls,'submit').length,0);
 assert.equal(routeOf(calls,'/failure').length,1);
});

for (const info of [
 { stopping: true, assistants: 1 },
 { stopping: false, assistants: 0 },
 { stopping: false, assistants: 1, assistantId: 'old' },
 { loading: true },
]) {
 test(`hard deadline also covers early waiting branches ${JSON.stringify(info)}`, async () => {
  const { sandbox, storage, calls } = worker({
   state: { id: 'abcdef123456', text: '你好', threadId: '', cancelled: false, images: [] },
   results: { inspect: { editor: true, submitted: true, threadId: THREAD, ...info } },
  });
  await wait();
  storage.current = { id: 'abcdef123456', tabId: 1, phase: 'waiting', sentAt: Date.now() - 245000,
   baseline: 0, assistantId: 'old', userBaseline: 0, threadId: '' };
  await sandbox.tick();
  assert.equal(routeOf(calls, '/failure').length, 1);
  assert.match(routeOf(calls, '/failure')[0].body.message, /超时/);
  assert.equal(routeOf(calls, '/result').length, 0);
 });
}

test('image upload selects the compatible input instead of an unrelated document picker', async()=>{
 const document=createDocument(),events=[];
 const pdf=el('input',{type:'file',accept:'.pdf'}), image=el('input',{type:'file',accept:'image/*'});
 pdf.dispatchEvent=()=>events.push('pdf');image.dispatchEvent=e=>events.push(e.type);
 document.body.appendChild(pdf);document.body.appendChild(image);
 document.body.appendChild(el('div',{role:'textbox',contenteditable:'true'}));
 const sandbox=sandboxOf({document});
 sandbox.File=class{constructor(parts,name,options){this.name=name;this.type=options.type;}};
 sandbox.DataTransfer=class{constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}};
 const result=await sandbox.pageStep('attach',{images:[{name:'input.jpg',mime:'image/jpeg',base64:'AQID'}]});
 assert.equal(result.attached,1);assert.equal(pdf.files,undefined);assert.equal(image.files.length,1);
 assert.deepEqual(events,['input','change']);
});

test('composer counts remote thumbnails once per attachment and exposes uploading state', async()=>{
 const document=createDocument(),form=el('form');
 form.appendChild(el('div',{role:'textbox',contenteditable:'true'}));
 const card=el('div',{'data-testid':'attachment-1'});
 card.appendChild(img('https://example.com/reference.jpg'));form.appendChild(card);
 form.appendChild(img('data:image/png;base64,AQID'));
 form.appendChild(el('div',{role:'progressbar'}));document.body.appendChild(form);
 document.body.appendChild(img('https://example.com/history.jpg'));
 const sandbox=sandboxOf({document});
 const result=await sandbox.pageStep('inspect',{});
 assert.equal(result.attachments,2);assert.equal(result.uploading,true);
});

test('all reference attachments must settle before filling and upload is never repeated', async()=>{
 let info={editor:true,attachments:1,uploading:false};
 const task={id:'abcdef123456',images:[{name:'a.jpg'},{name:'b.jpg'}]};
 const {sandbox,storage,calls}=worker({state:task,results:op=>op==='inspect'?info:{filled:true}});
 await wait();
 storage.current={...task,tabId:1,phase:'attaching',attachSent:true,attachAt:Date.now(),openedAt:Date.now(),sentText:'describe'};
 await sandbox.tick();assert.equal(storage.current.phase,'attaching');
 info={...info,attachments:2,uploading:true};
 await sandbox.tick();assert.equal(storage.current.phase,'attaching');
 info={...info,uploading:false};await sandbox.tick();assert.equal(storage.current.phase,'filled');
 assert.equal(opsOf(calls,'attach').length,0);assert.equal(opsOf(calls,'submit').length,1);
});

for(const phase of ['attaching','waiting'])test(phase+' failure captures an early diagnostic probe',async()=>{
 const task={id:'abcdef123456',images:[{name:'a.jpg'}]};
 const {sandbox,storage,calls}=worker({state:task,results:{inspect:{editor:true,attachments:0,submitted:false},probe:{phase,attachments:0,userNodes:0}}});
 await wait();
 storage.current={...task,tabId:1,phase,attachSent:true,attachAt:Date.now()-50000,sentAt:Date.now()-25000};
 await sandbox.tick();
 const failure=routeOf(calls,'/failure')[0];assert.ok(failure);assert.equal(failure.body.probe.phase,phase);
 assert.equal(opsOf(calls,'send').length,0);assert.equal(opsOf(calls,'attach').length,0);
});


test('transient bridge failure retains the task and never reports a page failure', async()=>{
 const {sandbox,storage,calls}=worker({state:{id:'network',text:'hello'}});
 await wait();
 storage.current={id:'network',tabId:1,phase:'waiting',sentAt:Date.now()};
 sandbox.fetch=async()=>{throw Error('connection reset');};
 await sandbox.tick();
 assert.equal(storage.current.id,'network');
 assert.equal(routeOf(calls,'/failure').length,0);
 assert.equal(opsOf(calls,'send').length,0);
 assert.match(storage.status,/等待恢复/);
});

test('a persisted returning reply retries result I/O without reading or sending again', async()=>{
 const {sandbox,storage,calls}=worker({state:{id:'return',text:'hello'}});
 await wait(); calls.length=0;
 storage.current={id:'return',tabId:1,phase:'returning',reply:{threadId:THREAD,imageCount:0,segments:[{type:'text',text:'answer'}]}};
 const fetch=sandbox.fetch; let attempts=0;
 sandbox.fetch=async(url,options)=>{
  if(url.endsWith('/result') && ++attempts===1)throw Error('connection reset');
  return fetch(url,options);
 };
 await sandbox.tick();
 assert.equal(storage.current.phase,'returning');
 assert.equal(routeOf(calls,'/failure').length,0);
 await sandbox.tick();
 assert.equal(storage.current,null);
 assert.equal(attempts,2);
 assert.equal(opsOf(calls,'read').length,0);
 assert.equal(opsOf(calls,'send').length,0);
 assert.equal(routeOf(calls,'/result')[0].body.segments[0].text,'answer');
});

test('a cancelled unstarted task never creates a browser tab', async()=>{
 const {storage,calls}=worker({state:{id:'cancelled',cancelled:true}});
 await wait();
 assert.equal(storage.current,undefined);
 assert.equal(routeOf(calls,'/progress').length,0);
 assert.equal(routeOf(calls,'/failure').length,1);
});

test('message-author-role is supported when the old role anchors are absent', async()=>{
 const document=createDocument();
 const turn=el('div',{'data-testid':'conversation-turn-1'});
 const assistant=el('div',{'data-message-author-role':'assistant','data-message-id':'new-answer'});
 assistant.appendChild(el('div',{class:'markdown'},[el('p',{},['fallback reply'])]));
 turn.appendChild(assistant);document.body.appendChild(turn);
 const sandbox=sandboxOf({document});
 const reply=await sandbox.pageStep('read',{});
 assert.ok(reply.segments.some(s=>s.text==='fallback reply'));
 const info=await sandbox.pageStep('inspect',{});
 assert.equal(info.assistants,1);assert.equal(info.assistantId,'new-answer');
});


test('navigation between preparation and sending cannot send into the wrong thread',async()=>{
 const sandbox=sandboxOf({location:{href:'https://chatgpt.com/',pathname:'/'}});
 for(const operation of ['attach','prepare','submit','send','read','image','stop']){
  const result=await sandbox.pageStep(operation,{threadId:THREAD,message:'hello'});
  assert.match(result.error,/会话与任务不一致/);
 }
});


// Regression shape from bb40e293ae7d: a generated writing-block textbox (523
// chars) and the real composer (1 char), neither with prompt-textarea id.
function composerFixture(){
 const document=createDocument();
 const history=el('div',{'data-content-search-unit-key':'turn:assistant'});
 const writing=el('div',{class:'group/writing-block-surface'});
 const artifact=el('div',{role:'textbox',contenteditable:'true'},['x'.repeat(523)]);
 writing.appendChild(artifact);history.appendChild(writing);document.body.appendChild(history);
 const form=el('form'),editor=el('div',{role:'textbox',contenteditable:'true'},[' ']);
 const send=el('button',{'aria-label':'发送'});send.click=()=>{send.clicks=(send.clicks||0)+1;};
 form.appendChild(editor);form.appendChild(send);document.body.appendChild(form);
 editor.focus=()=>{};editor.dispatchEvent=()=>{};
 document.execCommand=(command,_ui,value)=>{
  if(command==='insertText')editor.childNodes=[{nodeType:3,nodeValue:value,parentElement:editor}];
 };
 return {document,artifact,editor,form,send};
}

test('bb40e293ae7d writing-block editor does not compete with the message composer',async()=>{
 const {document,artifact,editor,send}=composerFixture();
 const sandbox=sandboxOf({document});
 const info=await sandbox.pageStep('inspect',{});
 assert.equal(info.editor,true);assert.equal(info.editorAmbiguous,false);
 assert.equal((await sandbox.pageStep('submit',{message:'new question'})).filled,true);
 assert.equal(editor.innerText,'new question');assert.equal(artifact.innerText,'x'.repeat(523));
 assert.equal((await sandbox.pageStep('send',{message:'new question'})).clicked,true);
 assert.equal(send.clicks,1);
 const probe=await sandbox.pageStep('probe',{});
 assert.equal(probe.editorCandidates[0].excluded,'reply-or-history');
 assert.equal(probe.editorCandidates[1].selected,true);
});

test('an unrelated empty editor never wins against a nonempty structural composer',async()=>{
 const {document,editor}=composerFixture();
 document.body.appendChild(el('div',{role:'textbox',contenteditable:'true'}));
 editor.childNodes=[{nodeType:3,nodeValue:'user-owned draft'}];
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('inspect',{})).editor,true);
 assert.match((await sandbox.pageStep('prepare',{message:'new'})).error,/已有内容/);
 assert.equal(editor.innerText,'user-owned draft');
});

test('send and attachment controls are scoped to the resolved composer',async()=>{
 const {document,form,send}=composerFixture();
 const wrongButton=el('button',{'aria-label':'发送'});wrongButton.click=()=>assert.fail('wrong send');
 document.body.childNodes.unshift(wrongButton);
 const foreign=el('input',{type:'file',accept:'image/*'});foreign.dispatchEvent=()=>assert.fail('wrong upload');
 document.body.childNodes.unshift(foreign);
 const local=el('input',{type:'file',accept:'image/*'});local.dispatchEvent=()=>{};form.appendChild(local);
 const sandbox=sandboxOf({document});
 sandbox.File=class{};sandbox.DataTransfer=class{constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}};
 assert.equal((await sandbox.pageStep('attach',{images:[{name:'a.png',mime:'image/png',base64:'AQID'}]})).attached,1);
 assert.equal(local.files.length,1);assert.equal(foreign.files,undefined);
 assert.equal((await sandbox.pageStep('send',{message:' '})).clicked,true);assert.equal(send.clicks,1);
});

test('two genuine composers remain ambiguous and neither can send or upload',async()=>{
 const document=createDocument();
 for(let i=0;i<2;i++){
  const form=el('form'),editor=el('div',{role:'textbox',contenteditable:'true'}),button=el('button',{'aria-label':'发送'});
  button.click=()=>assert.fail('must not click');form.appendChild(editor);form.appendChild(button);document.body.appendChild(form);
 }
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('inspect',{})).editorAmbiguous,true);
 assert.match((await sandbox.pageStep('send',{message:''})).error,/无法确定/);
 assert.match((await sandbox.pageStep('attach',{images:[]})).error,/无法确定/);
});

function openingJob(overrides={}){
 return {id:'session-management',tabId:1,threadId:THREAD,phase:'opening',openedAt:Date.now()-10000,
  sentText:'hello',historySeen:'1/1',historyStreak:2,...overrides};
}
function openingWorker(info){
 if(info.recoverySafe===undefined)info.recoverySafe=true;
 return worker({state:{id:'session-management',threadId:THREAD,text:'hello'},
  results:op=>op==='inspect'?info:op==='submit'?{filled:true}:op==='probe'?{phase:'opening'}:{}});
}

test('transient duplicate composers settle without reloading or dropping the task',async()=>{
 const info={editor:false,editorAmbiguous:true,threadId:THREAD,assistants:1,users:1};
 const {sandbox,storage,calls}=openingWorker(info);await wait();storage.current=openingJob();
 await sandbox.tick();assert.equal(storage.current.phase,'opening');assert.equal(routeOf(calls,'/failure').length,0);
 info.editor=true;info.editorAmbiguous=false;
 await sandbox.tick();assert.equal(storage.current.phase,'filled');
 assert.equal(routeOf(calls,'tabs.reload').length,0);assert.equal(opsOf(calls,'submit').length,1);
});

test('persistent duplicate composers allow only one durable reload of the same thread',async()=>{
 const info={editor:false,editorAmbiguous:true,threadId:THREAD,assistants:1,users:1};
 const {sandbox,storage,calls}=openingWorker(info);await wait();
 storage.current=openingJob({composerWaitAt:Date.now()-16000});
 await sandbox.tick();assert.equal(storage.current.recoveryCount,1);assert.equal(storage.current.threadId,THREAD);
 assert.equal(storage.current.historySeen,undefined);assert.equal(routeOf(calls,'tabs.reload').length,1);
 // Storage survives worker suspension: a second observation must not reload again.
 storage.current.composerWaitAt=Date.now()-16000;
 await sandbox.tick();assert.equal(routeOf(calls,'tabs.reload').length,1);
 assert.equal(routeOf(calls,'/failure').length,1);assert.equal(storage.current,null);
 assert.equal(storage.lastFailure.recoveryCount,1);assert.equal(storage.lastFailure.tabId,1);
 assert.equal(opsOf(calls,'submit').length,0);
});

for(const unsafe of [{unknownDrafts:true},{attachments:1}])test('unknown draft or existing attachments prevent destructive page recovery '+JSON.stringify(unsafe),async()=>{
 const {sandbox,storage,calls}=openingWorker({editor:false,editorAmbiguous:true,threadId:THREAD,...unsafe});
 await wait();storage.current=openingJob({composerWaitAt:Date.now()-16000});
 await sandbox.tick();assert.equal(routeOf(calls,'tabs.reload').length,0);assert.equal(routeOf(calls,'/failure').length,1);
});

test('composer loss after upload waits but never refreshes or reattaches',async()=>{
 const {sandbox,storage,calls}=openingWorker({editor:false,editorAmbiguous:true,threadId:THREAD});await wait();
 storage.current=openingJob({phase:'attaching',attachSent:true,attachAt:Date.now()});
 await sandbox.tick();assert.equal(routeOf(calls,'/failure').length,0);
 storage.current.composerWaitAt=Date.now()-16000;await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,1);assert.equal(routeOf(calls,'tabs.reload').length,0);
 assert.equal(opsOf(calls,'attach').length,0);assert.equal(opsOf(calls,'send').length,0);
});

test('a busy bound conversation is waited for without stopping another generation',async()=>{
 const info={editor:true,stopping:true,threadId:THREAD,assistants:1,users:1};
 const {sandbox,storage,calls}=openingWorker(info);await wait();storage.current=openingJob();
 await sandbox.tick();assert.equal(routeOf(calls,'/failure').length,0);assert.equal(opsOf(calls,'stop').length,0);
 info.stopping=false;await sandbox.tick();assert.equal(storage.current.phase,'filled');
});


test('ambiguous composers with an attachment cannot be classified safe to refresh',async()=>{
 const document=createDocument();
 for(let i=0;i<2;i++){
  const form=el('form');form.appendChild(el('div',{role:'textbox',contenteditable:'true'}));
  form.appendChild(el('button',{'aria-label':'发送'}));
  if(i===0)form.appendChild(el('div',{'data-testid':'attachment-pending'}));
  document.body.appendChild(form);
 }
 const sandbox=sandboxOf({document});const info=await sandbox.pageStep('inspect',{});
 assert.equal(info.editorAmbiguous,true);assert.equal(info.recoverySafe,false);
});

test('cancel before submission does not stop existing generation in the conversation',async()=>{
 const {sandbox,storage,calls}=worker({state:{id:'session-management',cancelled:true},results:{stop:{stopped:true}}});
 await wait();calls.length=0;storage.current=openingJob();
 await sandbox.tick();assert.equal(opsOf(calls,'stop').length,0);assert.equal(routeOf(calls,'/failure').length,1);
});

test('a loading tab waits before injecting any page script',async()=>{
 const sandbox=sandboxOf();await wait();
 sandbox.chrome.tabs.get=async()=>({url:'https://chatgpt.com/c/'+THREAD,status:'loading'});
 sandbox.chrome.scripting.executeScript=async()=>assert.fail('do not inject during navigation');
 assert.equal((await sandbox.page(1,'inspect',openingJob())).loading,true);
});

test('new conversation ID is persisted after submission and guards subsequent navigation',async()=>{
 const info={editor:true,submitted:true,threadId:THREAD,assistants:0,users:1};
 const {sandbox,storage,calls}=openingWorker(info);await wait();
 storage.current=openingJob({threadId:'',phase:'waiting',sentAt:Date.now(),baseline:0});
 await sandbox.tick();assert.equal(storage.current.threadId,THREAD);
 info.threadId='99999999-2222-3333-4444-555555555555';await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,1);assert.equal(routeOf(calls,'/result').length,0);
});

test('opening has a global deadline even while Chat mode never settles',async()=>{
 const {sandbox,storage,calls}=openingWorker({editor:true,needsChat:true,threadId:THREAD});await wait();
 storage.current=openingJob({openedAt:Date.now()-91000});await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,1);assert.equal(opsOf(calls,'chat').length,0);
});


test('a nested composer textbox does not hide the form send button or attachment',async()=>{
 const document=createDocument(),form=el('form');
 form.appendChild(el('div',{'data-testid':'composer-input',role:'textbox',contenteditable:'true'},['hello']));
 const send=el('button',{'aria-label':'发送'});let clicked=0;send.click=()=>clicked++;
 form.appendChild(send);form.appendChild(img('blob:https://chatgpt.com/upload'));
 document.body.appendChild(form);
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('inspect',{})).attachments,1);
 assert.equal((await sandbox.pageStep('send',{message:'hello'})).clicked,true);assert.equal(clicked,1);
});
