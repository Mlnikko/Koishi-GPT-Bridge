const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ruleIntent, directImageIntent, routeIntent } = require('../intent.cjs');
const { NaturalRouter } = require('../natural.cjs');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'intent-test-'));
const context = { current: 'a1234567', hasImage: true, sessions: [{ id: 'a1234567', name: '橘猫' }], latestJob: 'abcdef123456', jobs: [{ id: 'abcdef123456', status: 'running' }] };
const intent = (action, text = '', target = '') => ({ action, text, target, confidence: 1 });
const session = (id='m1', userId='alice', content='让刚才的背景变得更暗些') => ({ platform:'qq', channelId:'alice', userId, isDirect:true, messageId:id, content });
function router(classifier, dispatch, extra={}) {
  return new NaturalRouter({ file: path.join(temp(),'receipts.json'), authorized:s=>s.userId==='alice' && s.isDirect,
    context:()=>context, dispatch, classifier, ...extra });
}
test('rules handle affirmative draw and exact cancellation; negatives, quotes and compound requests defer', () => {
  assert.equal(ruleIntent('我想画一个芙兰朵露。').action, 'draw');
  assert.equal(ruleIntent('不用画了').action, 'cancel');
  assert.equal(ruleIntent('画好了吗？').action, 'status');
  for (const text of ['我不想画芙兰朵露了','我想画一个不戴帽子的人','我想画猫，然后新建会话','我想画猫吗？','如果我说“帮我画猫”会怎样','我想画猫怎么画']) assert.equal(ruleIntent(text),null);
});
test('ChatGPT web backend sends natural image requests directly and keeps management text classified', () => {
  assert.equal(directImageIntent('我想画一个芙兰朵露。').action, 'draw');
  assert.equal(directImageIntent('把刚才那张图的背景改成夜晚。').action, 'edit');
  assert.equal(directImageIntent('独立生成一张蓝色圆形图标。').action, 'independent');
  assert.equal(directImageIntent('查看画图状态'), null);
  assert.equal(directImageIntent('我不想画了'), null);
});
test('intent routing rejects unknown operations, foreign targets, ambiguity and missing edit context', () => {
  assert.throws(()=>routeIntent(intent('shell'),context,'anything'));
  assert.match(routeIntent(intent('edit','','foreign'),context,'修改图片').reply,/不是当前会话/);
  assert.match(routeIntent(intent('switch','','foreign'),context,'anything').reply,/未找到/);
  assert.match(routeIntent(intent('cancel','','foreign'),context,'anything').reply,/未找到/);
  assert.match(routeIntent(intent('edit'),{...context,current:''},'修改图片').reply,/续画需要/);
  assert.ok(routeIntent({...intent('draw'),confidence:0.2},context,'猫').reply);
  assert.deepEqual(routeIntent(intent('draw','model rewrote prompt'),context,'我想画猫'),{command:'画图',args:['我想画猫']});
  assert.deepEqual(routeIntent(intent('switch','','橘猫'),context,'切到橘猫'),{command:'切换画图会话',args:['a1234567']});
});
test('router isolates users, handles duplicates across restart, and bypasses model for rules', async () => {
  let calls=0, dispatches=0;
  const r=router(async()=>{calls++;return intent('edit');}, async()=>{dispatches++;return 'ok';});
  await r.handle(session('m0','bob')); assert.equal(calls,0);
  assert.equal(await r.handle(session()),'ok'); assert.equal(calls,1);
  await r.handle(session()); assert.equal(dispatches,1);
  const second=router(async()=>{throw Error('duplicate must not classify');},()=>{throw Error('duplicate');},{file:r.file});
  await second.handle(session());
  await r.handle(session('m2','alice','我想画一个芙兰朵露。')); assert.equal(calls,1); assert.equal(dispatches,2);
});
test('web natural image route bypasses the classifier and preserves the original prompt', async () => {
  let calls=0, received;
  const r=router(async()=>{calls++;throw Error('web classifier must not run for image prompts');}, async(name,s,args)=>{received={name,args};return 'ok';},{directImage:true});
  assert.equal(await r.handle(session('web1','alice','我想画一个芙兰朵露。')),'ok');
  assert.equal(calls,0);assert.deepEqual(received,{name:'画图',args:['我想画一个芙兰朵露。']});
});
test('newer explicit command invalidates delayed classification; failures never dispatch', async () => {
  let complete, dispatched=0;
  const r=router(()=>new Promise(resolve=>complete=resolve),()=>dispatched++);
  const pending=r.handle(session()); r.touch(session('m2')); complete(intent('edit'));
  assert.match(await pending,/忽略/); assert.equal(dispatched,0);
  const bad=router(async()=>{throw Error('语义识别超时');},()=>dispatched++);
  assert.match(await bad.handle(session()),/超时/); assert.equal(dispatched,0);
});
test('busy classifier does not block a rule cancellation; shutdown aborts recognition', async () => {
  let complete, dispatched=0;
  const r=router((text,ctx,{signal})=>new Promise((resolve,reject)=>{complete=resolve;signal.addEventListener('abort',()=>reject(Error('abort')));}),()=>{dispatched++;return 'cancelled';});
  const pending=r.handle(session());
  assert.match(await r.handle(session('m2')),/仍在识别/);
  assert.equal(await r.handle(session('m3','alice','不用画了')),'cancelled');
  await pending; assert.equal(dispatched,1);
  const other=r.handle(session('m4')); r.close(); await other; assert.equal(dispatched,1);
});
test('the classifier is injected, so nothing here spawns a local process', () => {
  // Classification runs on the signed-in ChatGPT web page via the local bridge;
  // intent.cjs must stay a pure vocabulary/validation module.
  const source = fs.readFileSync(path.join(__dirname, '../intent.cjs'), 'utf8');
  for (const forbidden of ['child_process', 'spawn', 'execFile', 'codexPath', 'CODEX_HOME']) {
    assert.ok(!source.includes(forbidden), `intent.cjs 不应再出现 ${forbidden}`);
  }
  const naturalSource = fs.readFileSync(path.join(__dirname, '../natural.cjs'), 'utf8');
  assert.ok(!naturalSource.includes('codexPath'), 'natural.cjs 不应再依赖 codexPath');
});
