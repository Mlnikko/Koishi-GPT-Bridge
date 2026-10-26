const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {el,img,createDocument}=require('./helpers/dom.cjs');
const {animatedGif}=require('./helpers/media.cjs');

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
function sandboxOf({document=createDocument(),location={href:'https://chatgpt.com/',pathname:'/'},chrome,fetch:fetchImpl,
 importScripts:importImpl=()=>{},config={url:'http://127.0.0.1:5141',token:'test'}}={}){
 const sandbox={console,AbortSignal,structuredClone,URL,setTimeout,
  setInterval:()=>{},importScripts:(...files)=>{
   for(const file of files){
    if(file==='config.js')importImpl(file);
    else vm.runInContext(fs.readFileSync(path.join(__dirname,'../browser-extension',file),'utf8'),sandbox,{filename:file});
   }
  },BRIDGE:config,
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
   const route=new URL(url).pathname;
   const body=options?.body;
   calls.push({route,body:body&&typeof body==='string'?JSON.parse(body):null,bytes:body&&typeof body!=='string'?body.length:0});
   return String(url).endsWith('/state')?{ok:true,json:async()=>({job:state})}:{ok:true,json:async()=>({})};
  },
 });
 return {sandbox,storage,calls};
}
const opsOf=(calls,op)=>calls.filter(call=>call.op===op);
const routeOf=(calls,route)=>calls.filter(call=>call.route===route);

test('native Work tier proof survives worker suspension and is included in submission evidence',async()=>{
 const state={id:'work-tier-proof',mode:'work',reasoningEffort:'tier-4',text:'原文',images:[]};
 const selection={kind:'work-tier',tier:4,total:6,label:'轻度',model:'GPT Astra 轻度'};
 const first=worker({state,results:{inspect:{editor:true,assistants:0,users:0,workMode:true},
  reasoning:{pending:true,verify:true,selection}}});
 await wait();await first.sandbox.tick();
 assert.deepEqual(first.storage.current.reasoningSelection,selection);
 assert.equal(opsOf(first.calls,'submit').length,0);
 let sent=false;
 const resumed=worker({state,storageSeed:{current:first.storage.current},results:op=>{
  if(op==='reasoning')return {applied:true,level:'tier-4',selection:{model:selection.model,total:6,tier:4,label:'轻度',kind:'work-tier'}};
  if(op==='inspect')return {editor:true,assistants:0,users:sent?1:0,workMode:true,
   submitted:sent,threadId:sent?THREAD:'',stopping:sent,replyLength:0,images:0};
  if(op==='submit')return {filled:true};if(op==='send'){sent=true;return {clicked:true};}
 }});
 await wait();for(let i=0;i<5;i++)await resumed.sandbox.tick();
 assert.equal(opsOf(resumed.calls,'send').length,1);
 assert.deepEqual(routeOf(resumed.calls,'/progress').find(call=>call.body.evidence)?.body.evidence.reasoningSelection,selection);
});

test('a changed Work tier proof blocks submission after worker suspension',async()=>{
 const selection={kind:'work-tier',tier:4,total:6,label:'轻度',model:'GPT Astra 轻度'};
 const state={id:'work-tier-changed',mode:'work',reasoningEffort:'tier-4',text:'原文',images:[]};
 const current={...state,tabId:1,phase:'reasoning',openedAt:Date.now(),reasoningVerify:true,reasoningSelection:selection};
 const {calls}=worker({state,storageSeed:{current},results:{reasoning:{applied:true,level:'tier-4',selection:{...selection,model:'different model'}}}});
 await wait();
 assert.equal(opsOf(calls,'submit').length,0);assert.equal(opsOf(calls,'send').length,0);
 assert.match(routeOf(calls,'/failure')[0].body.message,/强度档位确认信息无效/);
});

test('explicit Work mode switches the page before filling even when no skill is selected',async()=>{
 const state={id:'plain-work',mode:'work',text:'普通工作任务',images:[]};let workMode=false;
 const {sandbox,storage,calls}=worker({state,results:(op)=>{
  if(op==='inspect')return {editor:true,assistants:0,users:0,needsWork:!workMode,workMode};
  if(op==='work'){workMode=true;return {};}
  if(op==='submit')return {filled:true};if(op==='send')return {clicked:true};
 }});
 await wait();for(let i=0;i<5;i++)await sandbox.tick();
 assert.equal(storage.current.mode,'work');assert.equal(opsOf(calls,'work').length,1);
 assert.equal(opsOf(calls,'skill').length,0);assert.equal(opsOf(calls,'chat').length,0);
 assert.equal(opsOf(calls,'send').length,1);assert.equal(opsOf(calls,'submit')[0].job.mode,'work');
 assert.ok(calls.findIndex(c=>c.op==='work')<calls.findIndex(c=>c.op==='submit'));
});

test('a restored Work thread waits for history before using mode controls and resumes after its shell mounts',async()=>{
 const state={id:'work-loading',mode:'work',text:'正文',threadId:THREAD,images:[]};
 const current={...state,tabId:1,phase:'opening',openedAt:Date.now()-16000};let workMode=false;
 const {sandbox,storage,calls}=worker({state,storageSeed:{current},results:op=>{
  if(op==='inspect')return {editor:true,threadId:THREAD,assistants:1,users:1,needsWork:!workMode,workMode};
  if(op==='work')return {pending:true,waitingFor:'work-mode-control'};
  if(op==='submit')return {filled:true};if(op==='send')return {clicked:true};
 }});
 await wait();assert.equal(opsOf(calls,'work').length,0,'a first empty shell observation cannot select the mode');
 await sandbox.tick();assert.equal(storage.current.phase,'opening');assert.ok(storage.current.modeWaitAt);
 assert.equal(opsOf(calls,'submit').length,0);assert.equal(routeOf(calls,'/failure').length,0);
 workMode=true;await sandbox.tick();await sandbox.tick();
 assert.equal(storage.current.modeWaitAt,undefined);assert.equal(opsOf(calls,'send').length,1);
});

test('native skill selection completes before filling and its evidence survives worker suspension',async()=>{
 const state={id:'native-skill',text:'只要手部特写提示词',skill:{name:'chatgpt-jp-portrait'},images:[]};
 let selected=false;
 const {sandbox,storage,calls}=worker({state,results:(op)=>{
  if(op==='inspect')return {editor:true,assistants:0,users:0};
  if(op==='skill'){
   if(!selected){selected=true;return {pending:true,query:'@chatgpt jp portrait'};}
   return {applied:true,id:'installed-skill-id',name:'chatgpt jp portrait'};
  }
  if(op==='submit')return {filled:true};
  if(op==='send')return {clicked:true};
 }});
 await wait();await sandbox.tick();
 assert.equal(storage.current.phase,'skill');
 assert.equal(opsOf(calls,'submit').length,0);
 await sandbox.tick();
 assert.equal(storage.current.skillApplied.id,'installed-skill-id');
 // A resumed worker reads the durable state rather than injecting SKILL.md or
 // treating the mention's display label as a foreign draft.
 await sandbox.tick();await sandbox.tick();
 const filled=opsOf(calls,'submit')[0];
 assert.equal(filled.job.message,state.text);
 assert.deepEqual(filled.job.skillApplied,{id:'installed-skill-id',name:'chatgpt jp portrait'});
 assert.equal(opsOf(calls,'send').length,1);
 assert.ok(calls.findIndex(c=>c.op==='skill')<calls.findIndex(c=>c.op==='submit'));
});

test('a native skill that never becomes a confirmed token cannot fill or send a message',async()=>{
 const current={id:'native-timeout',tabId:1,phase:'skill',openedAt:Date.now(),skill:{name:'missing'},skillAttempts:15,text:'原文'};
 const {sandbox,calls}=worker({state:{id:current.id,text:'原文',skill:current.skill},storageSeed:{current},results:{probe:{}}});
 await wait();
 assert.equal(opsOf(calls,'submit').length,0);assert.equal(opsOf(calls,'send').length,0);
 assert.match(routeOf(calls,'/failure')[0].body.message,/@技能选择超时/);
});

for(const userSwitches of [false,true])
test('native skill focus restores the previous tab and respects a user tab switch: '+userSwitches,async()=>{
 const state={id:'native-focus',text:'正文',images:[],skill:{name:'chatgpt-jp-portrait'}};
 const updates=[];let active=99;
 const {sandbox,storage,calls}=worker({state,results:op=>op==='inspect'?{editor:true,assistants:0,users:0}:
  op==='skill'?{applied:true,id:'native-id',name:'chatgpt jp portrait'}:{}});
 sandbox.chrome.tabs.get=async()=>({url:'https://chatgpt.com/',windowId:2,active:active===1});
 sandbox.chrome.tabs.query=async()=>[{id:active}];
 sandbox.chrome.tabs.update=async id=>{updates.push(id);active=id;};
 await wait();await sandbox.tick();
 assert.deepEqual(updates,[1]);assert.equal(storage.current.skillPreviousTab,99);
 if(userSwitches)active=88;
 await sandbox.tick();
 if(userSwitches){
  assert.equal(active,88);assert.equal(opsOf(calls,'submit').length,0);
  assert.match(routeOf(calls,'/failure')[0].body.message,/焦点已变化/);
 }else{
  assert.equal(active,99);assert.deepEqual(updates,[1,99]);
  assert.equal(storage.current.skillApplied.id,'native-id');
 }
});

for(const userSwitches of [false,true])
test('native skill selection also focuses Chrome and restores the prior application: '+userSwitches,async()=>{
 const state={id:'native-window',text:'正文',images:[],skill:{name:'chatgpt-jp-portrait'}};
 const changes=[];let focused=false,active=99;
 const {sandbox,storage,calls}=worker({state,results:op=>op==='inspect'?{editor:true,assistants:0,users:0}:
  op==='skill'?{applied:true,id:'native-id',name:'chatgpt jp portrait'}:{}});
 sandbox.chrome.tabs.get=async()=>({url:'https://chatgpt.com/',windowId:2,active:active===1});
 sandbox.chrome.tabs.query=async()=>[{id:active}];
 sandbox.chrome.tabs.update=async id=>{active=id;};
 sandbox.chrome.windows={get:async()=>({id:2,focused}),getLastFocused:async()=>({id:2,focused:false}),
  update:async(id,options)=>{changes.push({id,focused:options.focused});focused=options.focused;}};
 await wait();await sandbox.tick();assert.equal(focused,true);assert.equal(active,1);
 if(userSwitches)focused=false;
 await sandbox.tick();
 assert.equal(focused,false);assert.equal(opsOf(calls,'submit').length,0);
 if(userSwitches){assert.equal(changes.length,1);assert.match(routeOf(calls,'/failure')[0].body.message,/窗口焦点已变化/);}
 else {assert.deepEqual(changes,[{id:2,focused:true},{id:2,focused:false}]);assert.equal(active,99);assert.ok(storage.current.skillApplied);}
});

test('idle polling keeps the heartbeat without repeating identical persistent storage writes',async()=>{
 const {sandbox,storage,calls}=worker();await wait();
 let writes=0;const set=sandbox.chrome.storage.local.set;
 sandbox.chrome.storage.local.set=async value=>{writes++;return set(value);};
 for(let i=0;i<3;i++)await sandbox.tick();
 assert.equal(writes,0);assert.equal(routeOf(calls,'/state').length,4);
 storage.status='等待本机连接';await sandbox.tick();assert.equal(writes,1);
 assert.equal(storage.status,'已连接本机 Koishi，等待任务');
});

function fileReplyFixture(){
 const document=createDocument();
 const user=el('div',{'data-message-author-role':'user','data-message-id':'file-user'},['create GIF']);
 const assistant=el('div',{'data-message-author-role':'assistant','data-message-id':'file-answer'});
 const link=el('span',{role:'link','aria-label':'Open 下载 motion.gif'},['下载 motion.gif']);
 const preview=el('button',{'aria-label':'打开 motion.gif 的预览'},['motion.gif']);
 const close=el('button',{'aria-label':'关闭查看器'});
 const viewer=el('div',{hidden:''},[img('data:image/gif;base64,'+animatedGif().toString('base64'),{width:1,height:1,alt:'图片预览'}),close]);
 const open=()=>{delete viewer.attrs.hidden;};link.click=open;preview.click=open;
 close.click=()=>{viewer.attrs.hidden='';};
 assistant.appendChild(el('p',{},['动画：',link,' 完成。']));
 assistant.appendChild(preview);
 document.body.appendChild(user);document.body.appendChild(assistant);document.body.appendChild(viewer);
 return {document,assistant,link,preview,viewer,user};
}

test('new renderer file links without href are ordered media and duplicate preview cards are ignored',async()=>{
 const {document,assistant}=fileReplyFixture();
 assistant.appendChild(img('blob:static'));
 const sandbox=sandboxOf({document});
 const reply=await sandbox.pageStep('read',{});
 assert.equal(reply.imageCount,2);
 assert.deepEqual(plain(reply.segments),[
  {type:'text',text:'动画：'},{type:'image',asset:0},{type:'text',text:'完成。'},{type:'image',asset:1,mime:'image/png'},
 ]);
 const info=await sandbox.pageStep('inspect',{});assert.equal(info.imageLoading,false);assert.equal(info.images,2);
});

test('preview-only GIF files are usable replies, including small animated images',async()=>{
 const {document,assistant,preview}=fileReplyFixture();
 assistant.childNodes=[];assistant.appendChild(preview);
 const sandbox=sandboxOf({document});
 const reply=await sandbox.pageStep('read',{}),info=await sandbox.pageStep('inspect',{});
 assert.deepEqual(plain(reply.segments),[{type:'image',asset:0}]);
 assert.equal(info.replyLength,0);assert.equal(info.images,1);assert.equal(info.imageLoading,false);
});
test('live resource rows return media without leaking filenames, type or download controls as prose',async()=>{
 const {document,assistant,preview}=fileReplyFixture();
 assistant.appendChild(el('span',{class:'group/resource-row relative'},[
  preview,el('span',{},['motion.gif',el('span',{},['图像']),el('span',{},['打开文件'])]),
  el('button',{'aria-label':'下载文件'}),
 ]));
 const reply=await sandboxOf({document}).pageStep('read',{});
 assert.deepEqual(plain(reply.segments),[
  {type:'text',text:'动画：'},{type:'image',asset:0},{type:'text',text:'完成。'},
 ]);
});

test('inline blob GIF images also retain animation instead of being flattened to PNG',async()=>{
 const document=createDocument();
 document.body.appendChild(el('div',{'data-message-author-role':'assistant'},[img('blob:https://chatgpt.com/animated')]));
 const sandbox=sandboxOf({document,fetch:async()=>new Response(animatedGif())});
 const reply=await sandbox.pageStep('read',{}),asset=await sandbox.pageStep('image',{reply});
 assert.equal(asset.mime,'image/gif');assert.deepEqual(Buffer.from(asset.base64,'base64'),animatedGif());
});

test('GIF viewer returns the original animation bytes and closes before the next media',async()=>{
 const {document,viewer}=fileReplyFixture();
 const sandbox=sandboxOf({document,fetch:async url=>{
  assert.ok(String(url).startsWith('data:image/gif;base64,'));return new Response(animatedGif());
 }});
 const reply=await sandbox.pageStep('read',{});
 const asset=await sandbox.pageStep('image',{imageIndex:0,reply});
 assert.equal(asset.mime,'image/gif');assert.deepEqual(Buffer.from(asset.base64,'base64'),animatedGif());
 assert.equal(viewer.getAttribute('hidden'),'');
 // A local transport retry can reopen the same viewer without changing bytes.
 const retried=await sandbox.pageStep('image',{imageIndex:0,reply});
 assert.equal(retried.base64,asset.base64);
});

test('Chinese download labels without a separating space resolve the owned preview and deduplicate the file',async()=>{
 const {document,link,preview,viewer}=fileReplyFixture();
 link.childNodes=[];link.appendChild('下载工程验收红蓝.gif');link.setAttribute('aria-label','Open 下载工程验收红蓝.gif');
 preview.childNodes=[];preview.setAttribute('aria-label','打开 工程验收红蓝.gif 的预览');
 link.click=()=>assert.fail('must use the matching preview button, not the download label');
 const sandbox=sandboxOf({document,fetch:async()=>new Response(animatedGif())});
 const reply=await sandbox.pageStep('read',{});assert.equal(reply.imageCount,1);
 const asset=await sandbox.pageStep('image',{imageIndex:0,reply});
 assert.equal(asset.mime,'image/gif');assert.deepEqual(Buffer.from(asset.base64,'base64'),animatedGif());
 assert.equal(viewer.getAttribute('hidden'),'');
});

test('a real filename beginning with 下载 is kept when its exact owned preview exists',async()=>{
 const {document,link,preview}=fileReplyFixture();
 link.childNodes=[];link.appendChild('下载工程.gif');link.setAttribute('aria-label','Open 下载工程.gif');
 preview.childNodes=[];preview.setAttribute('aria-label','打开 下载工程.gif 的预览');
 const reply=await sandboxOf({document}).pageStep('read',{});
 assert.equal(reply.imageCount,1);assert.match(reply.assetKeys[0],/\/下载工程\.gif$/);
});

test('a standalone sandbox path retrieves the exact historical assistant file, retaining GIF bytes',async()=>{
 const {document,assistant,user,preview,viewer}=fileReplyFixture();
 preview.attrs['aria-label']='打开 琪露诺_自然动态.gif 的预览';preview.childNodes=[];
 const user2=el('div',{'data-message-author-role':'user','data-message-id':'followup-user'},['再次发送']);
 const assistant2=el('div',{'data-message-author-role':'assistant','data-message-id':'followup-answer'},[
  el('p',{},[el('span',{},['/mnt/data/琪露诺_自然动态.gif'])]),
 ]);
 document.body.appendChild(user2);document.body.appendChild(assistant2);
 const sandbox=sandboxOf({document,fetch:async()=>new Response(animatedGif())});
 const reply=await sandbox.pageStep('read',{});
 assert.deepEqual(plain(reply.segments),[{type:'image',asset:0}]);
 assert.equal(reply.assetKeys[0],'file-answer/琪露诺_自然动态.gif');
 const asset=await sandbox.pageStep('image',{reply});
 assert.equal(asset.mime,'image/gif');assert.deepEqual(Buffer.from(asset.base64,'base64'),animatedGif());
 assert.equal(viewer.getAttribute('hidden'),'');
});

test('sandbox path references never read local files, user attachments or ambiguous historical versions',async()=>{
 for(const mode of ['missing','user','ambiguous']){
  const {document,assistant,user,preview}=fileReplyFixture();
  if(mode==='missing'){assistant.childNodes=[];}
  if(mode==='user'){assistant.childNodes=[];user.appendChild(preview);}
  if(mode==='ambiguous')document.body.appendChild(el('div',{'data-message-author-role':'assistant','data-message-id':'second-version'},[
   el('button',{'aria-label':'打开 motion.gif 的预览'}),
  ]));
  document.body.appendChild(el('div',{'data-message-author-role':'user'},['send']));
  document.body.appendChild(el('div',{'data-message-author-role':'assistant'},[el('p',{},['/mnt/data/motion.gif'])]));
  const sandbox=sandboxOf({document,fetch:()=>assert.fail('do not fetch an unbound path')});
  const reply=await sandbox.pageStep('read',{});assert.match(reply.error,mode==='ambiguous'?/同名版本/:/仅回复文件路径/);
 }
});
test('a current file card takes precedence over an older same-name file and a repeated path is deduplicated',async()=>{
 const {document}=fileReplyFixture();
 document.body.appendChild(el('div',{'data-message-author-role':'user'},['new version']));
 document.body.appendChild(el('div',{'data-message-author-role':'assistant','data-message-id':'new-version'},[
  el('p',{},['/mnt/data/motion.gif']),el('p',{},['/mnt/data/motion.gif']),
  el('button',{'aria-label':'打开 motion.gif 的预览'}),
 ]));
 const reply=await sandboxOf({document}).pageStep('read',{});
 assert.deepEqual(plain(reply.segments),[{type:'image',asset:0}]);
 assert.deepEqual(plain(reply.assetKeys),['new-version/motion.gif']);
});

test('raw generated GIF links and list entries are downloaded without canvas conversion',async()=>{
 const document=createDocument();
 document.body.appendChild(el('div',{'data-message-author-role':'assistant'},[
  el('ul',{},[el('li',{},[el('a',{href:'data:image/gif;base64,'+animatedGif().toString('base64'),download:'animation.gif'},['下载'])])]),
 ]));
 const sandbox=sandboxOf({document,fetch:async()=>new Response(animatedGif())});
 const reply=await sandbox.pageStep('read',{});assert.equal(reply.imageCount,1);
 const asset=await sandbox.pageStep('image',{reply});assert.equal(asset.mime,'image/gif');
 assert.deepEqual(Buffer.from(asset.base64,'base64'),animatedGif());
});

test('external links and files in other turns remain outside the reply media pipeline',async()=>{
 const {document,assistant,user}=fileReplyFixture();
 user.appendChild(el('a',{href:'sandbox:/mnt/data/user.gif'},['user.gif']));
 assistant.appendChild(el('p',{},[
  el('a',{href:'https://example.com/external.gif'},['external.gif']),
  el('a',{href:'http://127.0.0.1:9000/private.gif'},['private.gif']),
  el('a',{href:'sandbox:/mnt/data/document.pdf'},['document.pdf']),
 ]));
 const sandbox=sandboxOf({document});
 const reply=await sandbox.pageStep('read',{});
 assert.equal(reply.imageCount,1);
 assert.ok(reply.segments.some(s=>s.text?.includes('https://example.com/external.gif')));
 assert.ok(!reply.segments.some(s=>s.text?.includes('user.gif')));
});

test('file identity changes and existing viewers cannot hand back unrelated files',async()=>{
 const {document,viewer,link,preview}=fileReplyFixture();
 const sandbox=sandboxOf({document,fetch:()=>assert.fail('do not download unrelated files')});
 const reply=await sandbox.pageStep('read',{});
 delete viewer.attrs.hidden;
 assert.match((await sandbox.pageStep('image',{reply})).error,/已有文件预览/);
 viewer.attrs.hidden='';link.childNodes=[];link.appendChild('other.gif');preview.attrs['aria-label']='打开 other.gif 的预览';
 assert.match((await sandbox.pageStep('image',{reply})).error,/发生变化/);
});

test('file downloads reject HTTP errors, non-images and over-limit streams and always close the viewer',async()=>{
 for(const response of [new Response('expired',{status:403}),new Response('<html>expired</html>'.repeat(5)),
  new Response(new Uint8Array(21*1024*1024))]){
  const {document,viewer}=fileReplyFixture();
  const sandbox=sandboxOf({document,fetch:async()=>response});
  const reply=await sandbox.pageStep('read',{});
  assert.ok((await sandbox.pageStep('image',{reply})).error);
  assert.equal(viewer.getAttribute('hidden'),'');
 }
});

test('worker uploads GIF bytes with the real MIME and can resume an unacknowledged asset',async()=>{
 const task={id:'gif-return',text:'create GIF'};
 const {sandbox,storage,calls}=worker({state:task,results:{image:{base64:animatedGif().toString('base64'),mime:'image/gif'}}});
 await wait();
 storage.current={id:task.id,tabId:1,phase:'returning',reply:{threadId:THREAD,imageCount:1,segments:[{type:'image',asset:0}]}};
 const fetch=sandbox.fetch;let attempts=0;
 sandbox.fetch=async(url,options)=>{
  if(new URL(url).pathname==='/result-asset'){
   assert.equal(options.headers['Content-Type'],'image/gif');assert.deepEqual(Buffer.from(options.body),animatedGif());
   if(++attempts===1)throw Error('acknowledgement lost');
  }
  return fetch(url,options);
 };
 await sandbox.tick();assert.equal(storage.current.phase,'returning');assert.equal(storage.current.uploaded,undefined);
 await sandbox.tick();assert.equal(storage.current,null);assert.equal(attempts,2);
 assert.equal(routeOf(calls,'/result').length,1);assert.equal(opsOf(calls,'send').length,0);
});
test('preview-backed files activate their task tab and restore the original tab on a transport retry',async()=>{
 const task={id:'preview-focus',text:'send GIF'};
 const {sandbox,storage}=worker({state:task,results:{image:{base64:animatedGif().toString('base64'),mime:'image/gif'}}});
 await wait();
 storage.current={id:task.id,tabId:1,phase:'returning',reply:{threadId:THREAD,imageCount:1,requiresPreview:true,segments:[{type:'image',asset:0}]}};
 const updates=[];
 sandbox.chrome.tabs.get=async()=>({url:'https://chatgpt.com/c/'+THREAD,windowId:7,active:true});
 sandbox.chrome.tabs.query=async options=>{assert.equal(options.windowId,7);return [{id:42}];};
 sandbox.chrome.tabs.update=async id=>{updates.push(id);};
 const fetch=sandbox.fetch;
 sandbox.fetch=async(url,options)=>{if(new URL(url).pathname==='/result-asset')throw Error('network retry');return fetch(url,options);};
 await sandbox.tick();assert.deepEqual(updates,[1,42]);assert.equal(storage.current.phase,'returning');
});
for(const switched of [false,true])test('successful file retrieval restores the original selection unless the user switched tabs: '+switched,async()=>{
 const task={id:'preview-success',text:'send GIF'};
 const {sandbox,storage}=worker({state:task,results:{image:{base64:animatedGif().toString('base64'),mime:'image/gif'}}});
 await wait();
 storage.current={id:task.id,tabId:1,phase:'returning',reply:{threadId:THREAD,imageCount:1,requiresPreview:true,segments:[{type:'image',asset:0}]}};
 let active=true;const events=[];
 sandbox.chrome.tabs.get=async()=>({url:'https://chatgpt.com/c/'+THREAD,windowId:7,active});
 sandbox.chrome.tabs.query=async()=>[{id:42}];
 sandbox.chrome.tabs.update=async id=>{events.push(id);};
 sandbox.chrome.tabs.remove=async id=>{events.push('remove '+id);};
 const inject=sandbox.chrome.scripting.executeScript;
 sandbox.chrome.scripting.executeScript=async args=>{if(args.args[0]==='image'&&switched)active=false;return inject(args);};
 await sandbox.tick();assert.equal(storage.current,null);
 assert.deepEqual(events,switched?[1,'remove 1']:[1,42,'remove 1']);
});

for(const existing of [{unknownDrafts:true},{attachments:1},{uploading:true}])test('opening never appends input to existing composer content '+JSON.stringify(existing),async()=>{
 const task={id:'composer-owned',text:'new task',images:[{index:0}]};
 const {sandbox,storage,calls}=worker({state:task,results:{inspect:{editor:true,users:0,assistants:0,...existing},probe:{}}});
 await wait();
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,1);
 assert.equal(opsOf(calls,'attach').length,0);
 assert.equal(opsOf(calls,'submit').length,0);
});

test('a technical failure remains terminal while its acknowledgement is retried',async()=>{
 const task={id:'terminal',text:'hello'};
 const {sandbox,storage,calls}=worker({state:task,results:{inspect:{login:true},probe:{turns:0}}});
 await wait();
 const fetch=sandbox.fetch;let failures=0;
 sandbox.fetch=async(url,options)=>{
  if(url.endsWith('/failure')&&++failures===1)throw Error('connection reset');
  return fetch(url,options);
 };
 await sandbox.tick();
 assert.equal(storage.current.phase,'failing');
 assert.match(storage.current.failure.message,/需要登录/);
 calls.length=0;
 await sandbox.tick();
 assert.equal(storage.current,null);
 assert.equal(failures,2);
 assert.equal(opsOf(calls,'inspect').length,0);
 assert.equal(opsOf(calls,'send').length,0);
});

test('answer wording is not interpreted as a generation status',async()=>{
 const document=createDocument();
 const turn=el('div',{'data-testid':'conversation-turn-1'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'},['ChatGPT 说：']));
 turn.appendChild(el('div',{class:'markdown'},[el('p',{},['正在生成 means Generating. Thinking is another word.'])]));
 document.body.appendChild(turn);
 const info=await sandboxOf({document}).pageStep('inspect',{});
 assert.equal(info.busyText,'');
 assert.ok(info.replyLength>0);
});

test('hidden and unrelated Stop buttons cannot keep a finished reply generating',async()=>{
 const document=createDocument();
 const hidden=el('div',{'aria-hidden':'true'},[el('button',{'aria-label':'Stop generating'})]);
 const oldTurn=el('div',{'data-testid':'conversation-turn-0'},[el('button',{'aria-label':'停止生成'})]);
 const sidebar=el('aside',{},[el('button',{'aria-label':'Stop'})]);
 const composer=el('form',{},[el('div',{id:'prompt-textarea',contenteditable:'true'}),el('button',{'aria-label':'Send'})]);
 for(const node of [hidden,oldTurn,sidebar,composer])document.body.appendChild(node);
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('inspect',{})).stopping,false);
 assert.equal((await sandbox.pageStep('stop',{})).stopped,false);
});

test('cancellation clicks only the visible Stop in the current composer',async()=>{
 const document=createDocument();let clicked=0;
 const hidden=el('button',{'aria-label':'Stop generating',hidden:''});
 hidden.click=()=>assert.fail('hidden Stop must never be clicked');
 const unrelated=el('button',{'aria-label':'Stop'});
 unrelated.click=()=>assert.fail('another tool must never be stopped');
 const stop=el('button',{'data-testid':'stop-button'});stop.click=()=>clicked++;
 const composer=el('div',{'data-testid':'composer'},[el('div',{id:'prompt-textarea',contenteditable:'true'}),stop]);
 for(const node of [hidden,unrelated,composer])document.body.appendChild(node);
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('inspect',{})).stopping,true);
 assert.equal((await sandbox.pageStep('stop',{})).stopped,true);
 assert.equal(clicked,1);
});

test('a nested busy composer is still resolved after Send is replaced by Stop',async()=>{
 const document=createDocument();let clicked=0;
 const stop=el('button',{'aria-label':'停止生成'});stop.click=()=>clicked++;
 document.body.appendChild(el('div',{},[el('div',{},[el('div',{role:'textbox',contenteditable:'true'})]),stop]));
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('inspect',{})).stopping,true);
 assert.equal((await sandbox.pageStep('stop',{})).stopped,true);
 assert.equal(clicked,1);
});

test('a ready image is returned promptly when a hidden historical Stop remains in the page',async()=>{
 const document=createDocument();
 document.body.appendChild(el('button',{'aria-label':'Stop generating',hidden:''}));
 document.body.appendChild(el('div',{'data-message-author-role':'user'},['画一个圆']));
 document.body.appendChild(el('div',{'data-message-author-role':'assistant'},[img('blob:ready')]));
 document.body.appendChild(el('form',{},[el('div',{id:'prompt-textarea',contenteditable:'true'}),el('button',{'aria-label':'Send'})]));
 const info=await sandboxOf({document}).pageStep('inspect',{});
 const {sandbox,storage,calls}=worker({state:{id:'ready-image',text:'画一个圆',images:[]},results:{inspect:info,
  read:{threadId:THREAD,segments:[{type:'image',asset:0}],imageCount:1},
  image:{base64:Buffer.from('89504e470d0a1a0a','hex').toString('base64')}}});
 await wait();
 storage.current={id:'ready-image',tabId:1,phase:'waiting',sentAt:Date.now()-30000,stableAt:Date.now()-5000,
  baseline:0,userBaseline:0,lastSignature:info.replySignature,submittedConfirmed:true};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/result').length,1);
 assert.equal(routeOf(calls,'/failure').length,0);
});

test('paragraph image order and direct text nodes survive reply serialization',async()=>{
 const document=createDocument();
 const turn=el('div',{'data-testid':'conversation-turn-1'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'}));
 turn.appendChild(el('div',{},['direct text',el('p',{},['before',img('blob:generated'),'after'])]));
 document.body.appendChild(turn);
 const reply=await sandboxOf({document}).pageStep('read',{});
 assert.deepEqual(plain(reply.segments),[
  {type:'text',text:'direct text'},{type:'text',text:'before'},
  {type:'image',asset:0,mime:'image/png'},{type:'text',text:'after'},
 ]);
});

test('live CodeSurface headers supply the code language without leaking control labels into prose',async()=>{
 const document=createDocument();
 const turn=el('div',{'data-testid':'conversation-turn-1'});
 turn.appendChild(el('h4',{'data-conversation-role':'assistant'}));
 const block=el('div',{'data-markdown-copy':'code-block'});
 block.appendChild(el('div',{'data-markdown-copy':'exclude'},[
  el('svg'),el('div',{},['JavaScript']),el('div',{},[el('button',{},['Copy'])]),
 ]));
 block.appendChild(el('div',{},[el('div',{},[el('pre',{},[el('code',{},['console.log("BRIDGE_OK_1009");'])])])]));
 turn.appendChild(block);document.body.appendChild(turn);
 const reply=await sandboxOf({document}).pageStep('read',{});
 assert.deepEqual(plain(reply.segments),[{type:'code',language:'javascript',text:'console.log("BRIDGE_OK_1009");'}]);
});

test('image-only live user turns are counted alongside text bubbles and bound only to the new reply',async()=>{
 const document=createDocument();
 const oldUser=el('div',{'data-chatgpt-search-unit-key':'fallback-turn-0:0:user','data-chatgpt-search-message-ids':'old-user'},[
  el('div',{'data-user-message-bubble':''},['old prompt']),
 ]);
 const oldReply=el('div',{'data-content-search-unit-key':'fallback-turn-0:1:assistant'},[
  el('h4',{'data-conversation-role':'assistant'}),el('p',{},['old reply']),
 ]);
 const photo=img('data:image/png;base64,input',{alt:'用户附件'});
 const newUser=el('div',{'data-chatgpt-search-unit-key':'fallback-turn-1:0:user','data-chatgpt-search-message-ids':'photo-user'},[photo]);
 const newReply=el('div',{'data-content-search-unit-key':'fallback-turn-1:1:assistant'},[
  el('h4',{'data-conversation-role':'assistant'}),el('p',{},['left red, right blue']),
 ]);
 for(const node of [oldUser,oldReply,newUser,newReply])document.body.appendChild(node);
 const sandbox=sandboxOf({document});
 const info=await sandbox.pageStep('inspect',{userBaseline:1,userId:'old-user',sentText:''});
 assert.equal(info.users,2);assert.equal(info.userId,'photo-user');assert.equal(info.submitted,true);
 assert.equal(info.replyBlocks,1);assert.equal(info.images,0);
 const reply=await sandbox.pageStep('read',{submittedConfirmed:true,submittedUserId:'photo-user'});
 assert.deepEqual(plain(reply.segments),[{type:'text',text:'left red, right blue'}]);
 newUser.appendChild(el('div',{'data-user-message-bubble':''},['describe the photo']));
 const mixed=await sandbox.pageStep('inspect',{});
 assert.equal(mixed.users,2,'attachment wrapper and its text bubble identify the same user turn');
 assert.equal(mixed.userText,'describe the photo');
});

test('missing config keeps the worker registered and reports setup steps without touching a pending task', async()=>{
 const storage={current:{id:'pending',phase:'sending'}};
 let listener,requests=0;
 const chrome=stubChrome();
 chrome.runtime.onMessage.addListener=callback=>{listener=callback;};
 chrome.storage.local={get:async()=>storage,set:async values=>Object.assign(storage,plain(values))};
 const sandbox=sandboxOf({chrome,importScripts:()=>{throw Error('NetworkError');},
  fetch:async()=>{requests++;throw Error('must not fetch');}});
 await wait();await sandbox.tick();
 assert.match(storage.status,/config.js.*setup-web-bridge/);
 assert.equal(storage.current.id,'pending');
 assert.equal(requests,0);
 const status=await new Promise(resolve=>assert.equal(listener({type:'status'},{},resolve),true));
 assert.match(status.status,/config.js/);
 assert.equal(status.bridgeUrl,'');
 assert.equal(JSON.stringify(status).includes('token'),false);
});

test('invalid extension config produces actionable status and never sends credentials elsewhere', async()=>{
 for(const config of [null,{url:'https://example.com',token:'test'},{url:'http://127.0.0.1:0',token:'test'},
  {url:'http://127.0.0.1:65536',token:'test'},{url:'http://127.0.0.1:5141',token:''}]){
  const storage={};let requests=0;
  const chrome=stubChrome();chrome.storage.local.set=async values=>Object.assign(storage,plain(values));
  const sandbox=sandboxOf({chrome,config,fetch:async()=>{requests++;}});
  await wait();await sandbox.tick();
  assert.match(storage.status,/本机地址或令牌无效/);
  assert.equal(requests,0);
 }
});

test('bridge authentication failure explains dataDir and preserves the current task', async()=>{
 const storage={current:{id:'pending',phase:'waiting'}};
 const chrome=stubChrome();chrome.storage.local.set=async values=>Object.assign(storage,plain(values));
 const sandbox=sandboxOf({chrome,fetch:async()=>({ok:false,status:401})});
 await wait();await sandbox.tick();
 assert.match(storage.status,/401.*令牌不匹配.*dataDir/);
 assert.equal(storage.current.id,'pending');
});

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
  {type:'text',text:'| 列 | 值 |\n| --- | --- |\n| a | 1 |'},
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

test('timing snapshots distinguish visible content from generation and persist across ticks',async()=>{
 const inspected={editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:true,
  replyLength:5,images:1,imageLoading:false,pendingGallery:true,replySignature:'partial'};
 const {sandbox,storage,calls}=worker({state:{id:'timing-test',text:'画两张图',images:[]},results:op=>op==='inspect'?inspected:{}});
 await wait();
 const previous=Date.now()-30000;
 storage.current={id:'timing-test',tabId:1,phase:'waiting',sentAt:previous-20000,baseline:0,userBaseline:0,
  timing:{lastObservedAt:previous,maxPollGapMs:2000}};
 await sandbox.tick();
 const first=plain(storage.current.timing);
 assert.equal(first.waitReason,'generating');
 assert.ok(first.firstTextAt>=previous);assert.ok(first.firstImageAt>=previous);
 assert.equal(first.firstIdleAt,undefined);assert.ok(first.maxPollGapMs>=30000);
 assert.deepEqual(routeOf(calls,'/progress').at(-1).body.timing,first);
 inspected.stopping=false;
 await sandbox.tick();
 assert.equal(storage.current.timing.waitReason,'image-loading');
 inspected.pendingGallery=false;inspected.replySignature='finished';
 await sandbox.tick();
 assert.equal(storage.current.timing.waitReason,'settling');
 assert.ok(storage.current.timing.firstIdleAt>=first.firstImageAt);
 assert.equal(storage.current.timing.firstImageAt,first.firstImageAt);
 assert.equal(routeOf(calls,'/result').length,0,'all pictures and a stable signature are still required');
});

test('completed reply diagnostics include reading and image encoding/upload times',async()=>{
 const {sandbox,storage,calls}=worker({state:{id:'upload-timing',text:'画一个圆',images:[]},results:{
  inspect:{editor:true,assistants:1,users:1,threadId:THREAD,submitted:true,stopping:false,
   replyLength:0,images:1,imageLoading:false,replySignature:'ready'},
  read:{threadId:THREAD,segments:[{type:'image',asset:0}],imageCount:1,probe:{readableImages:1}},
  image:{base64:Buffer.from('89504e470d0a1a0a','hex').toString('base64')},
 }});
 await wait();
 storage.current={id:'upload-timing',tabId:1,phase:'waiting',sentAt:Date.now()-30000,
  stableAt:Date.now()-5000,lastSignature:'ready',baseline:0,userBaseline:0,
  timing:{firstImageAt:Date.now()-5000}};
 await sandbox.tick();
 const probe=routeOf(calls,'/result')[0].body.probe,timing=probe.timing;
 assert.equal(probe.readableImages,1);
 assert.ok(timing.readStartedAt>=timing.firstImageAt);
 assert.ok(timing.readFinishedAt>=timing.readStartedAt);
 assert.ok(timing.returnStartedAt>=timing.readFinishedAt);
 assert.equal(timing.uploads.length,1);
 assert.ok(timing.uploads[0].encodedAt>=timing.uploads[0].startedAt);
 assert.ok(timing.uploads[0].uploadedAt>=timing.uploads[0].encodedAt);
 assert.ok(timing.resultPostedAt>=timing.uploads[0].uploadedAt);
 assert.equal(storage.current,null);
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

test('an unopened ChatGPT thread reports a pre-submission failure instead of waiting forever', async()=>{
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
 assert.equal(failures[0].body.beforeSubmission,true);
 assert.match(storage.status,/任务失败/);
});

test('a replacement request for the same message escapes a persisted old failure and submits only once',async()=>{
 const first={id:'abcdef123456',text:'再改一版',threadId:THREAD,images:[]};
 const current={...first,tabId:1,phase:'failing',failure:{message:'ChatGPT 网页会话已不存在或无法打开',beforeSubmission:true}};
 const state={...first,id:first.id+'-recovery',threadId:''};
 const {sandbox,storage,calls}=worker({state,storageSeed:{current},results:op=>{
  if(op==='inspect')return {editor:true,assistants:0,users:0};
  if(op==='submit')return {filled:true};
  if(op==='send')return {clicked:true};
 }});
 await wait();
 assert.equal(storage.current.id,state.id);assert.equal(storage.current.phase,'opening');
 assert.equal(storage.current.failure,undefined);assert.equal(storage.current.threadId,'');
 for(let i=0;i<3;i++)await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0);
 assert.equal(opsOf(calls,'send').length,1);
 assert.equal(opsOf(calls,'send')[0].job.message,first.text);
});

test('a failure after send intent is persisted never claims the message was unsubmitted',async()=>{
 const state={id:'abcdef123456',text:'再改一版',threadId:THREAD,images:[]};
 const current={...state,tabId:1,phase:'sending',openedAt:Date.now()-30000,sentAt:Date.now()-20000};
 const {sandbox,calls}=worker({state,storageSeed:{current},results:{inspect:{error:'conversation not found'},probe:{}}});
 await wait();
 assert.equal(routeOf(calls,'/failure')[0].body.beforeSubmission,false);
 assert.equal(opsOf(calls,'send').length,0);
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
for(const hasImages of [false,true])test('reasoning is confirmed before upload or fill and survives a worker restart; images='+hasImages,async()=>{
 const task={id:'session-management',threadId:THREAD,text:'hello',reasoningEffort:'high'};
 const info={editor:true,threadId:THREAD,assistants:1,users:1};
 const {sandbox,storage,calls}=worker({state:task,results:op=>op==='inspect'?info:
  op==='reasoning'?{pending:true}:op==='submit'?{filled:true}:op==='send'?{clicked:true}:op==='probe'?{}:{}});
 await wait();storage.current=openingJob({reasoningEffort:'high',hasImages,images:hasImages?[{index:0}]:[]});
 await sandbox.tick();
 assert.equal(storage.current.phase,'reasoning');assert.equal(storage.current.reasoningAttempts,1);
 assert.equal(opsOf(calls,'attach').length,0);assert.equal(opsOf(calls,'submit').length,0);
 // Recreate the worker with just its durable state, then confirm the selector.
 const next=worker({state:task,storageSeed:storage,results:op=>op==='inspect'?info:
  op==='reasoning'?{applied:true,level:'high'}:op==='submit'?{filled:true}:op==='probe'?{}:{}});
 await wait();
 assert.equal(next.storage.current.phase,'opening');
 await next.sandbox.tick();
 assert.equal(next.storage.current.reasoningApplied,'high');assert.equal(next.storage.current.phase,hasImages?'attaching':'filled');
 assert.equal(opsOf(next.calls,'submit').length,hasImages?0:1);
 if(!hasImages){
  assert.equal(opsOf(next.calls,'submit')[0].job.message,'hello');
  assert.equal(opsOf(next.calls,'submit')[0].job.reasoningEffort,'high');
 }
});

test('closed-menu reasoning verification is durable and cannot fill before readback',async()=>{
 const task={id:'session-management',threadId:THREAD,text:'hello',reasoningEffort:'high'};
 const {sandbox,storage,calls}=worker({state:task,results:{reasoning:{pending:true,verify:true}}});
 await wait();storage.current=openingJob({phase:'reasoning',reasoningEffort:'high'});
 await sandbox.tick();
 assert.equal(storage.current.reasoningVerify,true);assert.equal(storage.current.phase,'reasoning');
 assert.equal(opsOf(calls,'submit').length,0);assert.equal(opsOf(calls,'send').length,0);
 const next=worker({state:task,storageSeed:storage,results:(op,job)=>{
  if(op==='reasoning'){
   assert.equal(job.reasoningVerify,true);
   return {error:'网页推理程度在关闭菜单后发生变化；本次未提交'};
  }
  return {};
 }});
 await wait();
 assert.equal(routeOf(next.calls,'/failure').length,1);
 assert.equal(opsOf(next.calls,'submit').length,0);assert.equal(opsOf(next.calls,'send').length,0);
});

for(const hasImages of [false,true])test('verified Pro fallback survives a restart without retrying Pro or changing the requested effort; images='+hasImages,async()=>{
 const task={id:'session-management',threadId:THREAD,text:'hello',reasoningEffort:'pro'};
 const fallback={requested:'pro',level:'xhigh',reason:'pro-unavailable'};
 const info={editor:true,threadId:THREAD,assistants:1,users:1};
 const first=worker({state:task,results:{reasoning:{pending:true,verify:true,fallback}}});
 await wait();first.storage.current=openingJob({phase:'reasoning',reasoningEffort:'pro',hasImages,images:hasImages?[{index:0}]:[]});
 await first.sandbox.tick();
 assert.deepEqual(first.storage.current.reasoningFallback,fallback);assert.equal(first.storage.current.reasoningVerify,true);
 assert.equal(opsOf(first.calls,'submit').length,0);assert.equal(opsOf(first.calls,'attach').length,0);
 const next=worker({state:task,storageSeed:first.storage,results:(op,job)=>{
  if(op==='reasoning'){
   assert.equal(job.reasoningVerify,true);assert.deepEqual(plain(job.reasoningFallback),fallback);
   return {applied:true,level:'xhigh',fallback};
  }
  return op==='inspect'?info:op==='submit'?{filled:true}:op==='send'?{clicked:true}:{};
 }});
 await wait();assert.equal(next.storage.current.reasoningApplied,'xhigh');assert.equal(next.storage.current.reasoningEffort,'pro');
 assert.match(next.storage.status,/Pro 暂不可用/);
 await next.sandbox.tick();
 assert.equal(next.storage.current.phase,hasImages?'attaching':'filled');
 assert.equal(opsOf(next.calls,'reasoning').length,1);
 if(!hasImages){
  await next.sandbox.tick();assert.equal(opsOf(next.calls,'send').length,1);
  info.submitted=true;info.users=2;
  await next.sandbox.tick();
  const evidence=routeOf(next.calls,'/progress').find(call=>call.body.phase==='submitted').body.evidence;
  assert.equal(evidence.reasoningEffort,'pro');assert.equal(evidence.reasoningApplied,'xhigh');
  assert.deepEqual(evidence.reasoningFallback,fallback);
 }
});

for(const result of [{error:'当前账号不支持推理程度 pro；本次未提交'},{applied:true,level:'medium'},
 {applied:true,level:'xhigh',fallback:{requested:'pro',level:'xhigh',reason:'pro-unavailable'}}])
test('unsupported or mismatched reasoning cannot submit a prompt '+JSON.stringify(result),async()=>{
 const task={id:'session-management',threadId:THREAD,text:'hello',reasoningEffort:'pro'};
 const {sandbox,storage,calls}=worker({state:task,results:{inspect:{editor:true,threadId:THREAD,assistants:1,users:1},reasoning:result,probe:{}}});
 await wait();storage.current=openingJob({reasoningEffort:'pro'});
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,1);
 assert.match(routeOf(calls,'/failure')[0].body.message,/推理程度/);
 assert.equal(opsOf(calls,'submit').length,0);assert.equal(opsOf(calls,'send').length,0);
});

test('a changed fallback level cannot pass the durable closed-menu verification',async()=>{
 const task={id:'session-management',threadId:THREAD,text:'hello',reasoningEffort:'pro'};
 const {sandbox,storage,calls}=worker({state:task,results:{reasoning:{applied:true,level:'high',
  fallback:{requested:'pro',level:'high',reason:'pro-unavailable'}},probe:{}}});
 await wait();storage.current=openingJob({phase:'reasoning',reasoningEffort:'pro',reasoningVerify:true,
  reasoningFallback:{requested:'pro',level:'xhigh',reason:'pro-unavailable'}});
 await sandbox.tick();assert.equal(routeOf(calls,'/failure').length,1);
 assert.equal(opsOf(calls,'submit').length,0);assert.equal(opsOf(calls,'send').length,0);
});

test('unresponsive reasoning controls time out without filling, sending or refreshing',async()=>{
 const task={id:'session-management',threadId:THREAD,text:'hello',reasoningEffort:'high'};
 const {sandbox,storage,calls}=worker({state:task,results:{inspect:{editor:true,threadId:THREAD,assistants:1,users:1},reasoning:{pending:true},probe:{}}});
 await wait();storage.current=openingJob({reasoningEffort:'high',reasoningAttempts:12});
 await sandbox.tick();assert.equal(routeOf(calls,'/failure').length,1);
 assert.equal(opsOf(calls,'submit').length,0);assert.equal(opsOf(calls,'send').length,0);assert.equal(routeOf(calls,'tabs.reload').length,0);
});

test('an unverified effort in a restored filled task cannot be sent',async()=>{
 const task={id:'session-management',threadId:THREAD,text:'hello',reasoningEffort:'high'};
 const {sandbox,storage,calls}=worker({state:task,results:{inspect:{editor:true,threadId:THREAD},probe:{}}});
 await wait();storage.current=openingJob({phase:'filled',reasoningEffort:'high'});
 await sandbox.tick();assert.equal(routeOf(calls,'/failure').length,1);assert.equal(opsOf(calls,'send').length,0);
});

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


function splitReplyFixture(){
 const document=createDocument(),main=el('main');document.body.appendChild(main);
 const oldGallery=el('div',{'data-testid':'generated-image-gallery'},[img('blob:old',{alt:'已生成图像 1'})]);
 main.appendChild(oldGallery);
 const user=el('div',{'data-message-id':'new-user','data-user-message-bubble':''},['new prompt']);
 main.appendChild(el('div',{'data-content-search-unit-key':'fallback-turn-5:user'},[user]));
 const gallery=el('div',{'data-testid':'generated-image-gallery'},[
  el('button',{'data-testid':'generated-image-preview'},[img('blob:new',{alt:'已生成图像 1'})])]);
 main.appendChild(gallery);
 const empty=el('div',{'data-content-search-unit-key':'fallback-turn-5:2:assistant','data-chatgpt-search-message-ids':'new-assistant new-assistant'},[
  el('h4',{'data-conversation-role':'assistant'},['ChatGPT 说：']),el('div',{'data-dil-message-id':'new-assistant'})]);
 main.appendChild(empty);
 return {document,main,user,gallery,empty,oldGallery};
}

test('ad5024437133: a generated gallery before the empty final assistant block is returned',async()=>{
 const {document}=splitReplyFixture();const sandbox=sandboxOf({document});
 const job={userBaseline:6,userId:'previous-user',sentText:'new prompt'};
 const info=await sandbox.pageStep('inspect',job);
 assert.equal(info.submitted,true);assert.equal(info.users,1);assert.equal(info.images,1);
 assert.equal(info.assistantId,'new-assistant');
 const reply=await sandbox.pageStep('read',job);
 assert.deepEqual(plain(reply.segments),[{type:'image',asset:0,mime:'image/png'}]);
 const probe=await sandbox.pageStep('probe',job);
 assert.equal(probe.images.find(i=>i.picked).inReplyTurn,true);
 assert.equal(probe.images.filter(i=>i.picked).length,1);
 assert.equal(probe.images[0].picked,false,'previous gallery before the user boundary stays excluded');
});

test('all assistant blocks after the current user are serialized in order',async()=>{
 const {document,main,gallery,empty}=splitReplyFixture();
 const intro=el('div',{'data-content-search-unit-key':'fallback-turn-5:0:assistant'},[
  el('h4',{'data-conversation-role':'assistant'}),el('p',{},['first block'])]);
 main.childNodes.splice(main.childNodes.indexOf(gallery),0,intro);intro.parentElement=main;
 empty.appendChild(el('p',{},['last block']));
 const reply=await sandboxOf({document}).pageStep('read',{});
 assert.deepEqual(plain(reply.segments),[{type:'text',text:'first block'},{type:'image',asset:0,mime:'image/png'},{type:'text',text:'last block'}]);
});

test('3922523b3763: exact new user text confirms submission despite reduced history counts',async()=>{
 const {document,user}=splitReplyFixture();delete user.attrs['data-message-id'];
 const sandbox=sandboxOf({document});
 const info=await sandbox.pageStep('inspect',{userBaseline:5,userText:'previous question',sentText:'new prompt'});
 assert.equal(info.users,1);assert.equal(info.submitted,true);
 const repeated=await sandbox.pageStep('inspect',{userBaseline:5,userText:'new prompt',sentText:'new prompt'});
 assert.equal(repeated.submitted,false,'identical text alone cannot prove a repeated submission');
});

test('confirmed submission survives count changes but detects a foreign user turn',async()=>{
 const {document}=splitReplyFixture();const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('inspect',{submittedConfirmed:true,submittedUserId:'new-user',userBaseline:9})).submitted,true);
 const changed=await sandbox.pageStep('inspect',{submittedConfirmed:true,submittedUserId:'other-user'});
 assert.equal(changed.userChanged,true);assert.equal(changed.submitted,false);
});

test('20049f082c1d: bounded current reply bypasses decreasing assistant counts',async()=>{
 const task={id:'bounded',text:'new prompt',threadId:THREAD};
 const {sandbox,storage,calls}=worker({state:task,results:{
  inspect:{editor:true,submitted:true,users:1,userId:'new-user',assistants:1,threadId:THREAD,replyBounded:true,replyBlocks:2,
   replyLength:3,images:0,replySignature:'answer',stopping:false,busyText:''},
  read:{threadId:THREAD,segments:[{type:'text',text:'new answer'}],imageCount:0},
 }});
 await wait();storage.current={...task,tabId:1,phase:'waiting',sentAt:Date.now()-10000,baseline:5,
  userBaseline:6,assistantId:'old-assistant',lastSignature:'answer',stableAt:Date.now()-5000};
 await sandbox.tick();
 assert.equal(routeOf(calls,'/result').length,1);assert.equal(routeOf(calls,'/failure').length,0);
});

test('reply root identity reads attributes on the root itself and deduplicates IDs',async()=>{
 const {document}=splitReplyFixture();
 const info=await sandboxOf({document}).pageStep('inspect',{});
 assert.equal(info.assistantId,'new-assistant');assert.equal(info.userId,'new-user');
});


test('real page extraction feeds the worker image upload without waiting for count growth',async()=>{
 const fixture=splitReplyFixture(),task={id:'dom-pipeline',threadId:THREAD,text:'new prompt'};
 const {sandbox,storage,calls}=worker({state:task});await wait();
 sandbox.document=fixture.document;sandbox.location={href:'https://chatgpt.com/c/'+THREAD,pathname:'/c/'+THREAD};
 sandbox.chrome.scripting.executeScript=async({args:[op,job]})=>{
  calls.push({op});
  if(op==='image')return [{result:{base64:Buffer.from('fake-png').toString('base64')}}];
  return [{result:await sandbox.pageStep(op,job)}];
 };
 storage.current={...task,tabId:1,phase:'waiting',sentText:'new prompt',sentAt:Date.now()-10000,
  baseline:5,userBaseline:6,userId:'previous-user',assistantId:'previous-assistant'};
 await sandbox.tick();storage.current.stableAt=Date.now()-5000;
 await sandbox.tick();
 assert.equal(routeOf(calls,'/failure').length,0);
 assert.equal(routeOf(calls,'/result-asset').length,1);
 const result=routeOf(calls,'/result')[0];assert.ok(result);
 assert.deepEqual(result.body.segments,[{type:'image',asset:0,mime:'image/png'}]);
 assert.equal(opsOf(calls,'send').length,0);assert.equal(storage.current,null);
});

test('one completed gallery cannot hide a second gallery still generating',async()=>{
 const {document,main}=splitReplyFixture();
 main.appendChild(el('div',{'data-testid':'generated-image-gallery'},[el('div',{},['generating'])]));
 const sandbox=sandboxOf({document});const info=await sandbox.pageStep('inspect',{});
 assert.equal(info.images,1);assert.equal(info.pendingGallery,true);
});

test('late image reads refuse a reply after another user message replaced the owner',async()=>{
 const {document}=splitReplyFixture();const sandbox=sandboxOf({document});
 for(const op of ['read','image'])assert.match((await sandbox.pageStep(op,{submittedUserId:'older-user'})).error,/其他用户轮次/);
});


test('a wrapper shared by user and assistant excludes the reference but keeps the generated image',async()=>{
 const document=createDocument(),wrapper=el('div',{'data-testid':'conversation-turn-1'});
 const user=el('div',{'data-user-message-bubble':''},['question',img('blob:reference',{alt:'用户附件'})]);
 wrapper.appendChild(user);wrapper.appendChild(el('h4',{'data-conversation-role':'assistant'}));
 wrapper.appendChild(el('div',{'data-testid':'generated-image-gallery'},[img('blob:answer',{alt:'已生成图像 1'})]));
 document.body.appendChild(wrapper);
 const sandbox=sandboxOf({document});
 assert.equal((await sandbox.pageStep('read',{})).imageCount,1);
 const probe=await sandbox.pageStep('probe',{});assert.equal(probe.images[0].picked,false);assert.equal(probe.images[1].picked,true);
});
