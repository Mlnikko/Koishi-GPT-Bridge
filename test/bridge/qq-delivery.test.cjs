const {test}=require('node:test');
const assert=require('node:assert/strict');
const {QQDelivery}=require('../../src/bridge/qq-delivery.cjs');

const job=(id,conversation='qq:alice')=>({id,conversation,status:'ready',delivery:'pending',output:[{type:'text',text:id}]});
const setup=()=>new QQDelivery({save:()=>{},status:()=>'',maxChars:16,maxTotal:1000,sendTimeoutMs:1000,mediaSendTimeoutMs:1000});
const wait=()=>new Promise(setImmediate);

test('unsupported MIME and invalid asset indices cannot resolve a result path',()=>{
 const {replyAssetPath}=require('../../src/lib/reply-assets.cjs');
 for(const mime of ['text/html','toString','constructor','__proto__',null])
  assert.throws(()=>replyAssetPath('/unused',0,mime),err=>err.code==='image_invalid');
 for(const index of [-1,10,NaN,0.5])
  assert.throws(()=>replyAssetPath('/unused',index,'image/png'),err=>err.code==='image_invalid');
});

test('reply segments keep channel order while another channel can send independently',async()=>{
 const delivery=setup(),events=[];let release;
 const blocked=new Promise(resolve=>{release=resolve;});
 const first=job('first');first.output=[{type:'text',text:'a'.repeat(16)+'b'.repeat(16)}];
 const session={timestamp:Date.now(),send:async text=>{events.push(text);if(text.startsWith('a'))await blocked;return ['ok'];}};
 const a=delivery.deliver(first,session);await wait();
 const second=job('second'),b=delivery.deliver(second,session);
 assert.match(await delivery.deliver(second,session),/正在发送/);
 await delivery.deliver(job('other','qq:bob'),session);await wait();
 assert.deepEqual(events,['a'.repeat(16),'other']);
 release();await Promise.all([a,b]);
 assert.deepEqual(events,['a'.repeat(16),'other','b'.repeat(16),'second']);
 assert.equal(delivery.locks.size,0);assert.equal(delivery.tails.size,0);
});

test('shutdown stops queued and later segments while preserving acknowledged delivery cursors',async()=>{
 const delivery=setup(),events=[];let release;
 const blocked=new Promise(resolve=>{release=resolve;});
 const first=job('first');first.output=[{type:'text',text:'a'.repeat(16)+'b'.repeat(16)}];
 const session={timestamp:Date.now(),send:async text=>{events.push(text);await blocked;return ['ok'];}};
 const second=job('second'),a=delivery.deliver(first,session);await wait();const b=delivery.deliver(second,session);
 delivery.close();release();await Promise.all([a,b]);
 assert.deepEqual(events,['a'.repeat(16)]);assert.equal(first.deliveryCursor,1);
 assert.equal(first.delivery,'failed');assert.equal(second.delivery,'failed');
 assert.equal(delivery.locks.size,0);assert.equal(delivery.tails.size,0);
});
