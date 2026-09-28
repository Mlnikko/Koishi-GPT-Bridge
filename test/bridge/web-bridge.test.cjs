const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebBridge,webFailure,saveImage}=require('../../src/bridge/web-bridge.cjs');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'web-bridge-test-'));
const id='11111111-2222-3333-4444-555555555555';
function png(width=8,height=8,size=256){const bytes=Buffer.alloc(size);Buffer.from('89504e470d0a1a0a','hex').copy(bytes,0);bytes.writeUInt32BE(13,8);Buffer.from('IHDR','latin1').copy(bytes,12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;}
async function setup(t){const root=temp(),b=new WebBridge({root,port:0});await b.ready;t.after(()=>b.close());return {b,job:{id:'abcdef123456',prompt:'a blue circle',dir:root},call:async(route,body,token=b.token)=>fetch(`http://127.0.0.1:${b.port}${route}`,{method:body?'POST':'GET',headers:{'x-bridge-token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})};}
test('web bridge requires local token and online extension before accepting a task',async t=>{
 const {b,job,call}=await setup(t);
 assert.equal((await call('/state',undefined,'wrong')).status,401);
 await assert.rejects(b.run(job),err=>err.code==='browser_offline');
 await call('/state');const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 assert.equal((await call('/state')).status,200);
 const state=await(await call('/state')).json();assert.equal(state.job.id,job.id);
 assert.equal((await call('/progress',{id:'foreign',phase:'submitted'})).status,409);
 await call('/failure',{id:job.id,message:'抱歉，我不能生成该图片。'});
 assert.equal((await p).code,'refused');
});
test('web result thread must match saved conversation; a mismatch cannot return an image',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job,{threadId:id}).catch(e=>e);await new Promise(setImmediate);
 const response=await call('/result',{id:job.id,threadId:'99999999-2222-3333-4444-555555555555',base64:'AAAA'});
 assert.equal(response.status,400);assert.equal((await p).code,'thread_mismatch');
 assert.equal(fs.existsSync(path.join(job.dir,'result.png')),false);
});
test('browser cancellation waits for acknowledgement and never accepts late image',async t=>{
 const {b,job,call}=await setup(t);await call('/state');const controller=new AbortController();
 const p=b.run(job,{signal:controller.signal}).catch(e=>e);await new Promise(setImmediate);controller.abort();
 assert.equal((await(await call('/state')).json()).job.cancelled,true);
 await call('/result',{id:job.id,threadId:id,base64:'AAAA'});
 assert.equal((await p).code,'cancelled');assert.equal(fs.existsSync(path.join(job.dir,'result.png')),false);
});
test('web errors report authentication and quota separately',()=>{
 assert.equal(webFailure('请登录 ChatGPT').code,'authentication');
 assert.equal(webFailure('已达到图片生成上限').code,'rate_limit');
 assert.equal(webFailure('图片已生成').code,'no_image');
 assert.equal(webFailure('等待网页出图超时，未检测到本轮图片').code,'no_image');
 assert.equal(webFailure('参考图片上传超时，未提交请求').code,'browser_interaction');
});
test('a page-structure probe from the extension is kept beside the job, never breaking the report',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 const probe={turns:3,roleNodes:['div@assistant'],images:[{src:'blob:',alt:'生成图片',w:1024,h:1024,complete:true,inUser:false}],assistantHtml:'<article></article>'};
 assert.equal((await call('/failure',{id:job.id,message:'等待网页出图超时，未检测到本轮图片',probe})).status,200);
 assert.equal((await p).code,'no_image');
 const file=path.join(job.dir,'dom-probe.json');
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(saved.turns,3);assert.equal(saved.images[0].w,1024);assert.ok(saved.at>0);
 // An oversized probe is dropped, and the failure is still reported normally.
 await call('/state');const q=b.run(job).catch(e=>e);await new Promise(setImmediate);
 await call('/failure',{id:job.id,message:'等待网页出图超时，未检测到本轮图片',probe:{blob:'x'.repeat(40000)}});
 assert.equal((await q).code,'no_image');
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).turns,3);
});
test('web result images are validated from their PNG header without external tools',()=>{
 const dir=temp(),destination=path.join(dir,'result.png');
 assert.throws(()=>saveImage(Buffer.from('not an image at all').toString('base64'),destination),err=>err.code==='image_invalid');
 assert.throws(()=>saveImage(png(8,8,64).toString('base64'),destination),err=>err.code==='image_invalid');
 assert.equal(saveImage(png(1254,1254).toString('base64'),destination),destination);
 assert.equal(fs.existsSync(destination),true);
 if(process.platform!=='win32')assert.equal(fs.statSync(destination).mode & 0o777,0o600);
});
test('reference images are advertised on /state and streamed from /input behind the token',async t=>{
 const {b,job,call}=await setup(t);
 fs.writeFileSync(path.join(job.dir,'input-0.png'),png(4,4));
 const task={...job,kind:'image',inputImages:[{file:'input-0.png',mime:'image/png',size:256}]};
 await call('/state');
 const p=b.run(task).catch(e=>e);await new Promise(setImmediate);
 const state=await(await call('/state')).json();
 assert.deepEqual(state.job.images,[{index:0,mime:'image/png',name:'input-0.png',size:256}]);
 assert.equal(state.job.kind,'image');
 const image=await call('/input?id='+job.id+'&i=0');
 assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
 assert.equal((await image.arrayBuffer()).byteLength,256);
 assert.equal((await call('/input?id=foreign&i=0')).status,409);
 assert.equal((await call('/input?id='+job.id+'&i=9')).status,404);
 assert.equal((await call('/input?id='+job.id+'&i=0',undefined,'wrong-token')).status,401);
 await call('/failure',{id:job.id,message:'抱歉，我不能生成该图片。'});
 assert.equal((await p).code,'refused');
});
test('a task without reference images advertises an empty list',async t=>{
 const {b,job,call}=await setup(t);await call('/state');
 const p=b.run(job).catch(e=>e);await new Promise(setImmediate);
 const state=await(await call('/state')).json();
 assert.deepEqual(state.job.images,[]);
 assert.equal((await call('/input?id='+job.id+'&i=0')).status,404);
 await call('/failure',{id:job.id,message:'图片已生成'});
 assert.equal((await p).code,'no_image');
});
