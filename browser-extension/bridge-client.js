// Local HTTP transport. Retryable I/O never repeats a page submission.
// Reference-image bytes are cached per task while the service worker lives, so a
// slow upload is never restarted and the data never touches persistent storage.
const inputs=new Map();
// Only bridge I/O is retryable. Never automatically repeat a DOM send click.
async function bridgeFetch(url,options){
 try{
  const response=await fetch(url,options);
  if(!response.ok){
   const detail=response.status===401?'：令牌不匹配，请用 Koishi 实际 dataDir 重新生成 config.js 并重载扩展':
    response.status===403?'：访问被拒绝，请检查扩展的网站访问权限和本机网络权限':'';
   throw Object.assign(Error('本机连接器返回 '+response.status+detail),{retryable:response.status>=500||response.status===429});
  }
  return response;
 }catch(err){
  if(err.retryable===undefined)err.retryable=true;
  throw err;
 }
}
function toBase64(bytes){
 let binary='';
 for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
 return btoa(binary);
}
async function loadInputs(task){
 if(inputs.has(task.id))return inputs.get(task.id);
 const list=[];
 for(const image of task.images||[]){
  const response=await bridgeFetch(bridgeConfig.url+'/input?id='+encodeURIComponent(task.id)+'&i='+image.index,
   {headers:{'x-bridge-token':bridgeConfig.token},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('无法读取本机参考图片（'+response.status+'）');
  list.push({name:image.name||('image-'+image.index+'.png'),mime:image.mime||'image/png',base64:toBase64(new Uint8Array(await response.arrayBuffer()))});
 }
 inputs.set(task.id,list);return list;
}
async function api(route,body){
 const response=await bridgeFetch(bridgeConfig.url+route,{method:body?'POST':'GET',headers:{'x-bridge-token':bridgeConfig.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('本机连接器返回 '+response.status);
 try{return await response.json();}catch(err){err.retryable=true;throw err;}
}
// Reply images travel as raw bytes: base64 inside the JSON result would inflate
// every picture by a third and blow the bridge body limit on a multi-image answer.
async function uploadAsset(id,index,base64){
 const binary=atob(base64);
 const bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 const response=await bridgeFetch(bridgeConfig.url+'/result-asset?id='+encodeURIComponent(id)+'&i='+index,
  {method:'POST',headers:{'x-bridge-token':bridgeConfig.token,'Content-Type':'image/png'},body:bytes,signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error('回复图片上传失败（'+response.status+'）');
}
