const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebBridge,webFailure,PROTOCOL_VERSION}=require('../../src/bridge/web-bridge.cjs');
const {saveAsset}=require('../../src/lib/reply-assets.cjs');
const {animatedGif}=require('../helpers/media.cjs');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'web-bridge-test-'));
const id='11111111-2222-3333-4444-555555555555';
test('cancellation inside the initial progress callback is registered before notification',async t=>{
 const {b,job,call}=await setup(t);await call('/state');const controller=new AbortController();
 const result=b.run(job,{signal:controller.signal,onProgress:()=>controller.abort()}).catch(e=>e);
 await new Promise(setImmediate);
 const wasCancelled=!!b.pending?.cancelled;
 await call('/failure',{id:job.id,message:'结束验收'});
 assert.equal(wasCancelled,true);assert.equal((await result).code,'cancelled');
});

test('closing inside the thread callback cannot create a task on the closed connector',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const result=b.run(job,{threadId:id,onThread:()=>b.close()}).catch(e=>e);
 await new Promise(setImmediate);const late=b.pending;
 if(late)late.finish(Object.assign(Error('cleanup'),{code:'test_cleanup'}));
 assert.equal((await result).code,'interrupted');assert.equal(late,null);
});
test('explicit reasoning requires a capable extension and is advertised in the task', async t=>{
 const {b,job,call}=await setup(t);
 job.reasoningEffort='high';
 await call('/state');
 await assert.rejects(b.run(job),err=>err.code==='browser_upgrade');
 const request={method:'GET',url:'/state',headers:{'x-bridge-token':b.token,'x-bridge-capabilities':'reasoning'}};
 await b.handle(request,{writeHead:()=>{},end:()=>{}});
 const result=b.run(job).catch(err=>err);await new Promise(setImmediate);
 assert.equal(b.requestInfo().reasoningEffort,'high');
 // An older extension appearing during polling must never receive this job.
 const old=await(await call('/state')).json();
 assert.equal(old.job,null);
 assert.equal((await result).code,'browser_upgrade');
});
test('local doctor uses the actual port without changing browser availability or exposing its token', async t=>{
 const {b,root,call}=await setup(t);
 const {inspect}=require('../../scripts/doctor.cjs');
 const before=await inspect({dataDir:root});
 assert.equal(before.port,b.port);assert.equal(before.online,false);
 assert.equal(b.lastSeen,0);assert.ok(!JSON.stringify(before).includes(b.token));
 await call('/state');
 assert.equal((await inspect({dataDir:root})).online,true);
});
test('closing while a task awaits bridge readiness cannot create a pending task afterwards', async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 let release;b.ready=new Promise(resolve=>{release=resolve;});
 const result=b.run(job).catch(err=>err);await new Promise(setImmediate);
 b.close();release();await new Promise(setImmediate);
 if(b.pending)b.pending.finish(Object.assign(Error('late pending task'),{code:'test_cleanup'}));
 assert.equal((await result).code,'interrupted');
 assert.equal(b.pending,null);
});

test('failed thread persistence fails the task immediately instead of losing its binding', async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const result=b.run(job,{onThread:()=>{throw Error('disk full at /private/secret');}}).catch(err=>err);
 await new Promise(setImmediate);
 const response=await call('/progress',{id:job.id,threadId:id,phase:'submitted'});
 assert.equal(response.status,400);
 if(b.pending)b.pending.finish(Object.assign(Error('binding remained pending'),{code:'test_cleanup'}));
 const err=await result;
 assert.equal(err.code,'state_write_failed');
 assert.ok(!err.message.includes('/private/secret'));
 assert.equal(b.pending,null);
});
test('health and rejected diagnostic routes never advertise a nonexistent browser', async t=>{
 const {b,job,call}=await setup(t);
 assert.equal((await call('/health',undefined,'wrong')).status,401);
 assert.equal((await(await call('/health')).json()).online,false);
 assert.equal((await call('/input?id=probe')).status,409);
 assert.equal((await call('/inputs')).status,404);
 assert.equal(b.lastSeen,0);
 await assert.rejects(b.run(job),err=>err.code==='browser_offline');
 await call('/state');
 const health=await(await call('/health')).json();
 assert.equal(health.online,true);
 assert.equal(health.version,PROTOCOL_VERSION);
 assert.ok(!JSON.stringify(health).includes(b.token));
});
test('a late upload from an ended task cannot write assets or fail the next task', async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const first=b.run(job).catch(e=>e);await new Promise(setImmediate);
 let release;
 const body=new Promise(resolve=>{release=resolve;});
 let status;
 const request={method:'POST',url:`/result-asset?id=${job.id}&i=0`,headers:{'x-bridge-token':b.token},
  async *[Symbol.asyncIterator](){yield await body;}};
 const upload=b.handle(request,{writeHead:code=>{status=code;},end:()=>{}});
 await call('/failure',{id:job.id,message:'页面加载失败'});await first;
 const next={...job,id:'123456abcdef'};
 const second=b.run(next).catch(e=>e);await new Promise(setImmediate);
 release(png());await upload;
 assert.equal(status,409);assert.equal(b.pending.job.id,next.id);
 assert.equal(fs.existsSync(path.join(job.dir,'result-0.png')),false);
 await call('/failure',{id:next.id,message:'页面加载失败'});await second;
});
test('an asset retry after a lost acknowledgement is idempotent', async t=>{
 const {b,job,call,asset}=await setup(t); await call('/state');
 const result=b.run(job); await new Promise(setImmediate);
 for(let attempt=0;attempt<2;attempt++)assert.equal((await asset(`/result-asset?id=${job.id}&i=0`,png())).status,200);
 assert.equal((await call('/result',{id:job.id,threadId:id,segments:[{type:'image',asset:0}]})).status,200);
 assert.equal((await result)[0].asset,0);
 assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir,'result.json'))).id,job.id);
});

test('failure diagnostics cannot strand a promise when the job directory disappears', async t=>{
 const {b,job,call}=await setup(t); await call('/state');
 job.dir=path.join(job.dir,'missing');
 const result=b.run(job).catch(e=>e); await new Promise(setImmediate);
 await call('/failure',{id:job.id,message:'ChatGPT 页面加载超时'});
 assert.equal((await result).code,'browser_interaction');
 assert.equal(b.pending,null);
});

test('a same-character-length non-ASCII token is rejected without crashing', async t=>{
 const {b,call}=await setup(t);
 assert.equal((await call('/state',undefined,'é'.repeat(b.token.length))).status,401);
 assert.equal((await call('/state')).status,200);
});
function png(width=8,height=8,size=256){const bytes=Buffer.alloc(size);Buffer.from('89504e470d0a1a0a','hex').copy(bytes,0);bytes.writeUInt32BE(13,8);Buffer.from('IHDR','latin1').copy(bytes,12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;}
async function setup(t){
 const root=temp(),b=new WebBridge({root,port:0});await b.ready;t.after(()=>b.close());
 const call=async(route,body,token=b.token)=>fetch(`http://127.0.0.1:${b.port}${route}`,{method:body?'POST':'GET',headers:{'x-bridge-token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const asset=(route,bytes,token=b.token)=>fetch(`http://127.0.0.1:${b.port}${route}`,{method:'POST',headers:{'x-bridge-token':token,'Content-Type':'image/png'},body:bytes});
 return {b,root,call,asset,job:{id:'abcdef123456',input:[{type:'text',text:'a blue circle'}],dir:root}};
}
test('web bridge requires local token and online extension before accepting a task',async t=>{
 const {b,job,call}=await setup(t);
 assert.equal((await call('/state',undefined,'wrong')).status,401);
 await assert.rejects(b.run(job),err=>err.code==='browser_offline');
 await call('/state');const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await call('/state')).status,200);
 const state=await(await call('/state')).json();
 assert.equal(state.version,PROTOCOL_VERSION);
 assert.equal(state.job.id,job.id);
 assert.equal(state.job.text,'a blue circle');
 assert.equal((await call('/progress',{id:'foreign',phase:'submitted'})).status,409);
 await call('/failure',{id:job.id,message:'ChatGPT 页面加载超时'});
 assert.equal((await p).code,'browser_interaction');
});
test('web result thread must match saved conversation; a mismatch cannot return a reply',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job,{threadId:id}).catch(e=>e);await new Promise(setImmediate);
 const response=await call('/result',{id:job.id,threadId:'99999999-2222-3333-4444-555555555555',segments:[{type:'text',text:'hi'}]});
 assert.equal(response.status,400);assert.equal((await p).code,'thread_mismatch');
 assert.equal(fs.existsSync(path.join(job.dir,'reply.md')),false);
});
test('browser cancellation waits for acknowledgement and never accepts a late reply',async t=>{
 const {b,job,call}=await setup(t);await call('/state');const controller=new AbortController();
 const p=b.run(job,{signal:controller.signal}).catch(e=>e);await new Promise(setImmediate);controller.abort();
 assert.equal((await(await call('/state')).json()).job.cancelled,true);
 await call('/result',{id:job.id,threadId:id,segments:[{type:'text',text:'late'}]});
 assert.equal((await p).code,'cancelled');assert.equal(fs.existsSync(path.join(job.dir,'reply.md')),false);
});
test('a text reply is stored whole and keeps its code fences on disk',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 const segments=[{type:'text',text:'两种写法：'},{type:'code',language:'js',text:'const a = 1;'},{type:'text',text:'第二种同理。'}];
 assert.equal((await call('/result',{id:job.id,threadId:id,segments})).status,200);
 assert.deepEqual(await p,[
  {type:'text',text:'两种写法：'},
  {type:'code',language:'js',text:'const a = 1;'},
  {type:'text',text:'第二种同理。'},
 ]);
 assert.equal(fs.readFileSync(path.join(job.dir,'reply.md'),'utf8'),'两种写法：\n\n```js\nconst a = 1;\n```\n\n第二种同理。');
});
test('a model refusal is an ordinary reply, not a failure',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await call('/result',{id:job.id,threadId:id,segments:[{type:'text',text:'抱歉，我不能帮你做这个。'}]})).status,200);
 // 关键：拒绝必须原样回传，而不是被归成某个失败码丢掉。
 assert.deepEqual(await p,[{type:'text',text:'抱歉，我不能帮你做这个。'}]);
});
test('only technical problems are classified as failures',()=>{
 assert.equal(webFailure('请登录 ChatGPT').code,'authentication');
 assert.equal(webFailure('429 rate_limit_exceeded').code,'rate_limit');
 assert.equal(webFailure('参考图片上传超时，未提交请求').code,'browser_interaction');
 assert.equal(webFailure('读取不到回复内容').code,'reply_unreadable');
 assert.equal(webFailure('ECONNRESET').code,'network');
 // 会话消失必须是独立的码：调用方靠它解绑 webThreadId，让下一条消息能自愈。
 assert.equal(webFailure('ChatGPT 网页会话已不存在或无法打开').code,'thread_gone');
 assert.equal(webFailure('ChatGPT 会话不匹配，未执行操作').code,'thread_mismatch');
 // 拒绝文案不再被当成失败分类。
 assert.equal(webFailure('抱歉，我不能生成该图片。').code,'execution_failed');
});
test('a page-structure probe from the extension is kept beside the job, never breaking the report',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 const probe={turns:3,roleNodes:['h4@assistant'],images:[{src:'blob:',alt:'',w:1024,h:1024,complete:true,inUser:false}],assistantHtml:'<article></article>'};
 assert.equal((await call('/failure',{id:job.id,message:'读取不到回复内容',probe})).status,200);
 assert.equal((await p).code,'reply_unreadable');
 const file=path.join(job.dir,'dom-probe.json');
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(saved.turns,3);assert.equal(saved.images[0].w,1024);assert.ok(saved.at>0);
 // An oversized probe is dropped, and the failure is still reported normally.
 await call('/state');const q=b.run(job).catch(e=>e);await new Promise(setImmediate);
 await call('/failure',{id:job.id,message:'读取不到回复内容',probe:{blob:'x'.repeat(40000)}});
 assert.equal((await q).code,'reply_unreadable');
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).turns,3);
});
test('a probe rides along with a result so a suspicious reply stays auditable',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 const probe={turns:2,images:[{src:'https:',alt:'',testid:'profile-button',w:512,h:512,complete:true,chrome:true,picked:true}],assistantHtml:'<article></article>'};
 assert.equal((await call('/result',{id:job.id,threadId:id,segments:[{type:'text',text:'hi'}],probe})).status,200);
 assert.deepEqual(await p,[{type:'text',text:'hi'}]);
 const saved=JSON.parse(fs.readFileSync(path.join(job.dir,'result-probe.json'),'utf8'));
 assert.equal(saved.images[0].chrome,true);assert.equal(saved.images[0].w,512);assert.ok(saved.at>0);
 // A result without a probe writes nothing extra and still lands normally.
 const second=await setup(t);await second.call('/state');
 const q=second.b.run(second.job).catch(e=>e);await new Promise(setImmediate);
 await second.call('/result',{id:second.job.id,threadId:id,segments:[{type:'text',text:'ok'}]});
 assert.deepEqual(await q,[{type:'text',text:'ok'}]);
 assert.equal(fs.existsSync(path.join(second.job.dir,'result-probe.json')),false);
});
test('reply images are uploaded as raw bytes and referenced by index',async t=>{
 const {b,job,call,asset}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await asset(`/result-asset?id=${job.id}&i=0`,png(1024,768))).status,200);
 assert.equal((await asset(`/result-asset?id=${job.id}&i=1`,png(512,512))).status,200);
 assert.equal((await call('/result',{id:job.id,threadId:id,segments:[
   {type:'text',text:'两个版本：'},
   {type:'image',asset:0,mime:'image/png'},
   {type:'text',text:'或者：'},
   {type:'image',asset:1,mime:'image/png'},
 ]})).status,200);
 assert.deepEqual(await p,[
  {type:'text',text:'两个版本：'},
  {type:'image',asset:0,mime:'image/png'},
  {type:'text',text:'或者：'},
  {type:'image',asset:1,mime:'image/png'},
 ]);
 assert.equal(fs.existsSync(path.join(job.dir,'result-0.png')),true);
 assert.equal(fs.existsSync(path.join(job.dir,'result-1.png')),true);
});
test('GIF and PNG files keep their bytes and order, including upload retries and a forged MIME',async t=>{
 const {b,job,call,asset}=await setup(t);await call('/state');
 const result=b.run(job).catch(e=>e);await new Promise(setImmediate);
 const gif=animatedGif();
 for(let attempt=0;attempt<2;attempt++)assert.equal((await asset(`/result-asset?id=${job.id}&i=0`,gif)).status,200);
 assert.equal((await asset(`/result-asset?id=${job.id}&i=1`,png())).status,200);
 assert.equal((await call('/result',{id:job.id,threadId:id,segments:[
  {type:'text',text:'动画：'},{type:'image',asset:0,mime:'image/png'},
  {type:'text',text:'静态图：'},{type:'image',asset:1,mime:'image/gif'},
 ]})).status,200);
 const segments=await result;
 assert.equal(segments[1].mime,'image/gif');assert.equal(segments[3].mime,'image/png');
 assert.deepEqual(fs.readFileSync(path.join(job.dir,'result-0.gif')),gif);
 assert.equal(fs.existsSync(path.join(job.dir,'result-0.png')),false);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(job.dir,'result.json'))).segments,segments);
});
test('GIF upload retries cannot replace the original animation with a different file',async t=>{
 const {b,job,call,asset}=await setup(t);await call('/state');
 const result=b.run(job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await asset(`/result-asset?id=${job.id}&i=0`,animatedGif())).status,200);
 assert.equal((await asset(`/result-asset?id=${job.id}&i=0`,png())).status,400);
 assert.equal((await result).code,'image_invalid');
 assert.deepEqual(fs.readFileSync(path.join(job.dir,'result-0.gif')),animatedGif());
});
test('truncated GIF and HTML error pages are refused without saving an asset',()=>{
 const dir=temp(),destination=path.join(dir,'result-0.gif');
 for(const bytes of [animatedGif().subarray(0,-1),Buffer.from('<html>'+ 'not a gif'.repeat(10)+'</html>')])
  assert.throws(()=>saveAsset(bytes,dir,0),err=>err.code==='image_invalid');
 assert.equal(fs.existsSync(destination),false);
});
test('a reply that references an image the page never uploaded is refused whole',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await call('/result',{id:job.id,threadId:id,segments:[{type:'image',asset:0}]})).status,400);
 assert.equal((await p).code,'reply_invalid');
 assert.equal(fs.existsSync(path.join(job.dir,'reply.md')),false);
});
test('an out-of-order asset upload is refused, so indices cannot be faked',async t=>{
 const {b,job,call,asset}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await asset(`/result-asset?id=${job.id}&i=1`,png(64,64))).status,400);
 assert.equal((await asset(`/result-asset?id=foreign&i=0`,png(64,64))).status,409);
 assert.equal(fs.existsSync(path.join(job.dir,'result-1.png')),false);
 await call('/failure',{id:job.id,message:'页面加载超时'});
 await p;
});
test('unknown or empty reply segments are refused',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await call('/result',{id:job.id,threadId:id,segments:[{type:'script',text:'evil'}]})).status,400);
 assert.equal((await p).code,'reply_invalid');
 const second=await setup(t);await second.call('/state');
 const q=second.b.run(second.job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await second.call('/result',{id:second.job.id,threadId:id,segments:[]})).status,400);
 assert.equal((await q).code,'empty_reply');
});
test('reply images are validated from their PNG header without external tools',()=>{
 const dir=temp(),destination=path.join(dir,'result-0.png');
 assert.throws(()=>saveAsset(Buffer.from('not an image at all, definitely not a png'),dir,0),err=>err.code==='image_invalid');
 assert.throws(()=>saveAsset(png(8,8).subarray(0,20),dir,0),err=>err.code==='image_invalid');
 assert.deepEqual(saveAsset(png(1254,1254),dir,0),{mime:'image/png',ext:'png'});
 assert.equal(fs.existsSync(destination),true);
 if(process.platform!=='win32')assert.equal(fs.statSync(destination).mode & 0o777,0o600);
});
test('reference images are advertised on /state and streamed from /input behind the token',async t=>{
 const {b,job,call}=await setup(t);
 fs.writeFileSync(path.join(job.dir,'input-0.png'),png(4,4));
 const task={...job,input:[{type:'text',text:'看看这个'},{type:'image',file:'input-0.png',mime:'image/png',size:256}]};
 await call('/state');
 const p=b.run(task).catch(e=>e);await new Promise(setImmediate);
 const state=await(await call('/state')).json();
 assert.deepEqual(state.job.images,[{index:0,mime:'image/png',name:'input-0.png',size:256}]);
 assert.equal(state.job.text,'看看这个');
 const image=await call('/input?id='+job.id+'&i=0');
 assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
 assert.equal((await image.arrayBuffer()).byteLength,256);
 assert.equal((await call('/input?id=foreign&i=0')).status,409);
 assert.equal((await call('/input?id='+job.id+'&i=9')).status,404);
 assert.equal((await call('/input?id='+job.id+'&i=0',undefined,'wrong-token')).status,401);
 await call('/failure',{id:job.id,message:'页面加载超时'});
 await p;
});
test('a task without reference images advertises an empty list',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 const state=await(await call('/state')).json();
 assert.deepEqual(state.job.images,[]);
 assert.equal((await call('/input?id='+job.id+'&i=0')).status,404);
 await call('/failure',{id:job.id,message:'页面加载超时'});
 await p;
});


test('bound conversation ID and first submission evidence remain available for diagnosis',async t=>{
 const {b,job,call}=await setup(t);await call('/state');let bound;
 const result=b.run(job,{threadId:id,onThread:value=>{bound=value;}});await new Promise(setImmediate);
 assert.equal(bound,id);
 const evidence={workerVersion:'0.3.2',userId:'user-message',userBaseline:5,users:3,replyBlocks:2};
 await call('/progress',{id:job.id,threadId:id,phase:'submitted',evidence});
 await call('/progress',{id:job.id,threadId:id,phase:'submitted',evidence:{users:99}});
 const saved=JSON.parse(fs.readFileSync(path.join(job.dir,'submission.json')));
 assert.equal(saved.users,3);assert.equal(saved.userId,'user-message');
 await call('/result',{id:job.id,threadId:id,segments:[{type:'text',text:'done'}]});await result;
});

test('progress timing snapshots overwrite bounded state without breaking failure reports',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const result=b.run(job).catch(e=>e);await new Promise(setImmediate);
 const timing={sentAt:100,firstImageAt:200,waitReason:'generating'};
 await call('/progress',{id:job.id,phase:'submitted',timing});
 const updated={...timing,firstIdleAt:300,waitReason:'reading'};
 await call('/progress',{id:job.id,phase:'reading',timing:updated});
 const file=path.join(job.dir,'timing.json'),saved=JSON.parse(fs.readFileSync(file));
 assert.equal(saved.firstImageAt,200);assert.equal(saved.firstIdleAt,300);assert.equal(saved.waitReason,'reading');
 assert.ok(saved.at>0);
 assert.equal((await call('/progress',{id:'another-task',phase:'reading',timing:{sentAt:999}})).status,409);
 await call('/progress',{id:job.id,phase:'reading',timing:{oversize:'x'.repeat(20000)}});
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),saved);
 await call('/failure',{id:job.id,message:'ChatGPT 页面加载超时',probe:{timing:updated}});
 assert.equal((await result).code,'browser_interaction');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(job.dir,'dom-probe.json'))).timing,updated);
});
