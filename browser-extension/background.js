importScripts('config.js');
let ticking=false;
// Reference-image bytes are cached per task while the service worker lives, so a
// slow upload is never restarted and the data never touches persistent storage.
const inputs=new Map();
function toBase64(bytes){
 let binary='';
 for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
 return btoa(binary);
}
async function loadInputs(task){
 if(inputs.has(task.id))return inputs.get(task.id);
 const list=[];
 for(const image of task.images||[]){
  const response=await fetch(BRIDGE.url+'/input?id='+encodeURIComponent(task.id)+'&i='+image.index,
   {headers:{'x-bridge-token':BRIDGE.token},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('无法读取本机参考图片（'+response.status+'）');
  list.push({name:image.name||('image-'+image.index+'.png'),mime:image.mime||'image/png',base64:toBase64(new Uint8Array(await response.arrayBuffer()))});
 }
 inputs.set(task.id,list);return list;
}
function buildMessage(task){
 const marker='QQ绘图任务 '+task.id;
 if(task.kind==='intent')return marker+'\n'+task.prompt;
 const header='请使用 ChatGPT 图像生成功能直接生成一张图片，不要只给出文字提示词。下面的任务编号仅用于追踪，不要画在图片里。';
 const images=(task.images||[]).length;
 if(images)return header+'\n我已在下方附加 '+images+' 张参考图片，请基于这些图片处理。\n'+marker+'\n用户的要求：'+(task.prompt||'请参考我上传的图片生成一张新的图片。');
 return header+'\n'+marker+'\n用户的图片请求：'+task.prompt;
}
async function api(route,body){
 const response=await fetch(BRIDGE.url+route,{method:body?'POST':'GET',headers:{'x-bridge-token':BRIDGE.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('本机连接器返回 '+response.status);
 return response.json();
}
// The assistant turn of an image-only answer contains no model text, only the
// screen-reader heading and the action buttons. Reporting that chrome as a model
// reply is how "ChatGPT 说：编辑" ended up in a failure message, so anything that
// is left after removing the chrome and is still tiny counts as no reply at all.
function modelReply(info){
 const text=String(info?.assistantText||'')
  .replace(/^ChatGPT\s*(?:说|said)\s*[:：]?\s*/i,'')
  .replace(/编辑|复制|重新生成|分享|朗读|点赞|点踩|Edit|Copy|Regenerate|Share|Read aloud/g,'')
  .replace(/\s+/g,' ').trim();
 return text.length>=6?text.slice(0,700):'';
}
async function pageStep(operation,job){
 try {
 const buttons=()=>Array.from(document.querySelectorAll('button'));
 const byLabel=labels=>buttons().find(b=>labels.includes(b.getAttribute('aria-label')||'') || labels.includes(b.innerText.trim()));
 const roles=role=>Array.from(document.querySelectorAll(role==='user'?'[data-user-message-bubble]':`[data-conversation-role="${role}"]`));
 const turn=node=>{
  if(!node)return null;
  if(typeof node.closest==='function'){const found=node.closest('[data-testid^="conversation-turn"]');if(found)return found;}
  return node.parentElement||node;
 };
 const user=roles('user'),assistant=roles('assistant'),lastUser=turn(user.at(-1)),lastAssistant=turn(assistant.at(-1));
 const editor=document.querySelector('[role="textbox"][contenteditable="true"]');
 const stop=byLabel(['停止','Stop','停止生成','Stop generating']);
 const marker='QQ绘图任务 '+job.id;
 const matching=lastUser?.innerText.includes(marker);
 const match=location.pathname.match(/^\/c\/([a-f0-9-]{36})$/);
 const threadId=match?.[1]||'';
 // ChatGPT has shipped several wrappers for a generated image, so identify one by
 // what it is — a large bitmap — instead of a single data-testid that can be
 // renamed without notice. Avatars, icons and emoji are small and are skipped.
 const source=img=>String(img?.currentSrc||img?.src||img?.getAttribute?.('src')||'');
 const area=img=>(Number(img.naturalWidth)||0)*(Number(img.naturalHeight)||0);
 const looksGenerated=img=>{
  if(!img || typeof img.getAttribute!=='function')return false;
  if(!/^(?:blob:|data:image\/|https?:\/\/)/i.test(source(img)))return false;
  if(/avatar|profile|icon|emoji|头像/i.test(String(img.getAttribute('alt')||'')+String(img.getAttribute('data-testid')||'')))return false;
  const width=Number(img.naturalWidth)||0,height=Number(img.naturalHeight)||0;
  return width>=200 && height>=200;
 };
 const insideUser=img=>user.some(node=>{const scope=turn(node);return scope && typeof scope.contains==='function' && scope.contains(img);});
 // The newest assistant turn is the only place a fresh generation can appear.
 // Scanning the page is a fallback for DOM variants that move the preview out of
 // the turn; it is restricted to images outside the user bubble (the reference
 // image) and outside every older turn, so an earlier picture in the same thread
 // can never be handed back as the result of the current request.
 const turnNodes=Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'));
 const newestTurn=turnNodes[turnNodes.length-1]||lastAssistant;
 const stale=img=>insideUser(img)||turnNodes.some(node=>node!==newestTurn && typeof node.contains==='function' && node.contains(img));
 const scoped=lastAssistant?Array.from(lastAssistant.querySelectorAll('img')).filter(looksGenerated):[];
 const images=(scoped.length?scoped
  :assistant.length>(job.baseline||0)?Array.from(document.querySelectorAll('img')).filter(img=>looksGenerated(img)&&!stale(img)):[]
 ).sort((a,b)=>area(b)-area(a));
 const best=images[0]||null;
 const imageReady=!!best && best.complete!==false && Number(best.naturalWidth)>0 && Number(best.naturalHeight)>0;
 const imageLoading=!imageReady && images.some(img=>img.complete===false || !(Number(img.naturalWidth)>0));
 // An image-only answer carries no model text at all, so an empty turn is not a
 // finished answer. Any progress wording is read from this turn only: the user's
 // own prompt often contains the word "生成" and must never look like activity.
 const turnText=String(lastAssistant?.innerText||'')+'\n'+String(lastAssistant?.textContent||'').slice(0,1500);
 const generating=!!stop || /正在生成|生成中|正在创建|正在绘制|Generating|Creating image/i.test(turnText);
 const probeDom=()=>({
  turns:document.querySelectorAll('[data-testid^="conversation-turn"]').length,
  roleNodes:Array.from(document.querySelectorAll('[data-message-author-role],[data-conversation-role]')).slice(0,20)
   .map(el=>el.tagName.toLowerCase()+'@'+(el.getAttribute('data-message-author-role')||el.getAttribute('data-conversation-role')||'')),
  images:Array.from(document.querySelectorAll('img')).slice(0,20).map(img=>({
   src:source(img).replace(/^([a-z]+:)[\s\S]*/i,'$1').slice(0,12),
   alt:String(img.getAttribute?.('alt')||'').slice(0,40),
   testid:String(img.getAttribute?.('data-testid')||'').slice(0,40),
   w:Number(img.naturalWidth)||0,h:Number(img.naturalHeight)||0,complete:img.complete!==false,inUser:insideUser(img)})),
  assistantHtml:String(lastAssistant?.outerHTML||'').slice(0,2500)});
 // Attachments are counted inside the composer only, so conversation images are
 // never mistaken for a reference image that is still uploading.
 const composer=editor && typeof editor.closest==='function'
  ?(editor.closest('form')||editor.closest('[data-testid*="composer" i]')||editor.parentElement||null):null;
 const attachmentNodes=composer && typeof composer.querySelectorAll==='function'
  ?Array.from(composer.querySelectorAll('img[src^="blob:"], [data-testid*="attachment" i], [data-testid*="composer-file" i]')):[];
 const chatGroup=document.querySelector('[aria-label="撰写器模式"], [aria-label="Composer mode"]');
 const chatButton=chatGroup && Array.from(chatGroup.querySelectorAll('button')).find(b=>['聊天','Chat'].includes(b.innerText.trim()));
 const snapshot={url:location.href,threadId,users:user.length,assistants:assistant.length,matching:!!matching,editor:!!editor,
  stopping:!!stop,generating,images:images.length,imageReady,imageLoading,
  attachments:new Set(attachmentNodes).size,
  assistantText:lastAssistant?.innerText.slice(0,1800)||'',needsChat:!!chatButton && chatButton.getAttribute('aria-pressed')!=='true',
  login:!editor && !!byLabel(['登录','Log in','Sign in']),
  challenge:/verify you are human|确认您是真人|验证您是真人|checking your browser/i.test(document.body.innerText.slice(0,1500))};
 if(operation==='inspect'){
  // Ground truth for the next failure: when no image ever shows up, keep the
  // page's structure so the selectors can be corrected without guessing.
  if(!images.length && job.sentAt && Date.now()-job.sentAt>90000)snapshot.probe=probeDom();
  return snapshot;
 }
 if(operation==='chat'){if(chatButton)chatButton.click();return snapshot;}
 if(operation==='stop'){if(stop)stop.click();return {stopped:!!stop};}
 if(operation==='attach'){
  const list=Array.isArray(job.images)?job.images:[];
  if(!list.length)return {attached:0};
  const transfer=new DataTransfer();
  for(const item of list){
   const binary=atob(item.base64);
   const bytes=new Uint8Array(binary.length);
   for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
   transfer.items.add(new File([bytes],item.name||'image.png',{type:item.mime||'image/png'}));
  }
  const input=document.querySelector('input[type="file"]');
  if(input){
   input.files=transfer.files;
   input.dispatchEvent(new Event('input',{bubbles:true}));
   input.dispatchEvent(new Event('change',{bubbles:true}));
  }else{
   if(!editor)throw Error('网页未就绪，无法附加参考图片');
   editor.focus();
   editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  }
  return {attached:transfer.files.length};
 }
 if(operation==='submit'){
  if(matching)return {alreadySent:true};
  if(!editor || stop || snapshot.needsChat)throw Error('网页未就绪或不在普通 Chat 模式');
  if(job.threadId && job.threadId!==threadId)throw Error('网页会话与任务不一致');
  const current=editor.innerText.trim();
  const placeholder=['询问 ChatGPT','Ask ChatGPT'];
  // A previous connector task can leave its unsent draft behind when the
  // browser or Koishi stops. It is safe to remove only drafts carrying our
  // own task marker; arbitrary user text is never overwritten.
  const staleConnectorDraft=/(?:^|\n)QQ绘图任务\s+[a-f0-9]{12}\b/i.test(current);
  if(current && !placeholder.includes(current) && !staleConnectorDraft)throw Error('专用标签页输入框已有内容，请清空后重新发送任务');
  editor.focus();
  if(staleConnectorDraft){document.execCommand('selectAll',false);document.execCommand('delete',false);}
  document.execCommand('selectAll',false);document.execCommand('insertText',false,job.message);
  editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:job.message}));
  return {filled:editor.innerText.includes(marker)};
 }
 if(operation==='send'){
  if(matching)return {alreadySent:true};
  if(!editor?.innerText.includes(marker))throw Error('输入内容已变化，未发送');
  const send=byLabel(['发送','Send','发送提示','Send prompt']);
  // React may render the button before it has committed the editor value.
  // This is a safe retry point because no click has happened yet.
  if(!send || send.disabled)return {ready:false};
  send.click();return {clicked:true};
 }
 if(operation==='image'){
  if(!matching || assistant.length<=job.baseline || !snapshot.imageReady || stop)throw Error('本轮图片尚未完成');
  const img=images[0];
  if(img.naturalWidth*img.naturalHeight>32*1024*1024)throw Error('图片尺寸超过上限');
  const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  canvas.getContext('2d').drawImage(img,0,0);
  const base64=canvas.toDataURL('image/png').split(',')[1];
  return {threadId,base64};
 }
 throw Error('unknown operation');
 }catch(err){return {error:String(err.message||err)};}
}
async function page(tabId,op,job){
 const tab=await chrome.tabs.get(tabId);
 // tabs.create() can briefly report about:blank/newtab while Chrome is
 // navigating to ChatGPT. Treat that short transition as loading; only fail
 // once the page has settled on a different origin.
 if(!tab.url || tab.url==='about:blank' || tab.url.startsWith('chrome://newtab')) {
  if(job.phase==='opening' && Date.now()-job.openedAt<60000) return {loading:true};
  throw Error('ChatGPT 专用标签页加载超时，请检查网络和登录状态');
 }
 if(!tab.url.startsWith('https://chatgpt.com/'))throw Error('专用标签页已离开 ChatGPT，任务停止');
 const results=await chrome.scripting.executeScript({target:{tabId},func:pageStep,args:[op,job]});
 if(!results[0]?.result)throw Error('ChatGPT 页面脚本未返回结果，请检查扩展错误');
 if(results[0].result.error)throw Error(results[0].result.error);
 return results[0].result;
}
async function store(current,status){if(!current)inputs.clear();await chrome.storage.local.set({current,status});}
async function tick(){
 if(ticking)return;ticking=true;
 let current;
 try{
  const remote=await api('/state');
  ({current}=await chrome.storage.local.get('current'));
  if(!remote.job){
   // A completed/orphaned task is never resubmitted, even after service restarts.
   await store(null,'已连接本机 Koishi，等待任务');return;
  }
  const task=remote.job;
  if(!current || current.id!==task.id){
   const tab=await chrome.tabs.create({url:task.threadId?'https://chatgpt.com/c/'+task.threadId:'https://chatgpt.com/',active:false});
   current={...task,tabId:tab.id,phase:'opening',openedAt:Date.now(),hasImages:!!(task.images&&task.images.length),message:buildMessage(task)};
   await store(current,'正在打开 ChatGPT 绘图标签页');await api('/progress',{id:task.id,phase:'opening'});return;
  }
  if(task.cancelled){await page(current.tabId,'stop',current).catch(()=>{});await api('/failure',{id:task.id,message:'任务已取消'});await store(null,'任务已取消');return;}
  const info=await page(current.tabId,'inspect',current);
  if(info.loading) return;
  if(info.login)throw Error('ChatGPT 网页需要登录，请在专用标签页登录');
  if(info.challenge)throw Error('ChatGPT 网页需要人工验证，请完成页面验证后重新发送任务');
  if(current.threadId && info.threadId && current.threadId!==info.threadId)throw Error('ChatGPT 会话不匹配，未执行操作');
  if(current.phase==='opening'){
   if(!info.editor){if(Date.now()-current.openedAt>60000)throw Error('ChatGPT 页面加载超时，请检查网络和登录');return;}
   if(info.needsChat){await page(current.tabId,'chat',current);return;}
   if(current.threadId && info.threadId!==current.threadId)return;
   if(info.stopping)throw Error('该 ChatGPT 会话正在处理其他请求，请稍后再试');
   current.baseline=info.assistants;
   if(current.hasImages){current.phase='attaching';await store(current,'正在上传参考图片到 ChatGPT');return;}
   current.phase='filling';await store(current,'正在填写图片请求');
  }
  if(current.phase==='attaching'){
   if(info.attachments>=1){current.phase='filling';await store(current,'参考图片已上传，正在填写要求');}
   else {
    // Upload exactly once. If it cannot be confirmed we fail closed rather than
    // submitting a text-only request that would silently drop the reference image.
    if(current.attachSent){
     if(Date.now()-current.attachAt>45000)throw Error('参考图片上传超时，未提交请求；请检查专用标签页');
     return;
    }
    if(Date.now()-current.openedAt>90000)throw Error('参考图片上传超时，未提交请求');
    const images=await loadInputs(task);
    await page(current.tabId,'attach',{...current,images});
    current.attachSent=true;current.attachAt=Date.now();
    await store(current,'参考图片已提交上传，等待 ChatGPT 处理');
    return;
   }
  }
  if(current.phase==='filling'){
   const filled=await page(current.tabId,'submit',current);
   if(!filled.filled && !filled.alreadySent)throw Error('无法填写 ChatGPT 提示词');
   current.phase='filled';current.filledAt=Date.now();await store(current,'图片请求已填写，等待输入框完成更新');return;
  }
  if(current.phase==='filled'){
   // Wait a separate polling turn for the editor to commit React state.
   // Persist before clicking: crashes in this gap fail closed, never duplicate generation.
   current.phase='sending';current.sentAt=Date.now();await store(current,'正在提交 ChatGPT');
   const sent=await page(current.tabId,'send',current);
   if(!sent.clicked && !sent.alreadySent){
    if(Date.now()-(current.filledAt||Date.now())>30000)throw Error('ChatGPT 发送按钮持续不可用，请重试；本次未重复提交');
    current.phase='filled';
    await store(current,'等待 ChatGPT 启用发送按钮');
    return;
   }
   current.phase='waiting';await store(current,'ChatGPT 正在生成图片');return;
  }
  if(current.phase==='sending'){
   if(!info.matching){if(Date.now()-current.sentAt>15000)throw Error('网页提交状态不明确，未自动重复发送，请检查专用标签页');return;}
   current.phase='waiting';await store(current,'ChatGPT 正在生成图片');
  }
  if(!info.matching){if(Date.now()-current.sentAt>20000)throw Error('专用标签页内容已变化，未取得本轮图片');return;}
  if(info.threadId)await api('/progress',{id:task.id,threadId:info.threadId,phase:'submitted'});
  if(info.assistants<=current.baseline || info.stopping)return;
  if(current.kind==='intent'){
   if(info.images)throw Error('语义识别返回了图片，未执行任何命令');
   if(current.lastText!==info.assistantText){current.lastText=info.assistantText;current.stableAt=Date.now();await store(current,'ChatGPT 正在识别语义');return;}
   if(info.assistantText && Date.now()-current.stableAt>=4000){
    await api('/result',{id:task.id,threadId:info.threadId,text:info.assistantText.replace(/^ChatGPT (?:说|said)：?\s*/,'').trim()});
    await store(null,'语义识别已交给 Koishi 校验');
    await chrome.tabs.remove(current.tabId).catch(()=>{});return;
   }
   return;
  }
  if(info.imageReady){
   await api('/progress',{id:task.id,phase:'saving'});
   const image=await page(current.tabId,'image',current);
   await api('/result',{id:task.id,...image});await store(null,'图片已交给 Koishi 回传 QQ');return;
  }
  // ChatGPT renders the empty assistant turn long before the picture exists, and
  // generation regularly needs a minute or more. Keep waiting while the page
  // still looks busy instead of treating a text-less turn as a finished answer.
  const fail=message=>{const error=Error(message);error.probe=info.probe;return error;};
  const waited=Date.now()-current.sentAt;
  if(waited<20000)return;
  // Checked before the busy branch below, otherwise a page that never stops
  // looking busy would wait out the bridge timeout instead of failing clearly.
  if(waited>240000)throw fail('等待网页出图超时，未检测到本轮图片');
  if(info.generating||info.imageLoading||info.stopping){current.stableAt=Date.now();await store(current,'ChatGPT 正在生成图片');return;}
  if(current.lastText!==info.assistantText){current.lastText=info.assistantText;current.stableAt=Date.now();await store(current,'正在等待网页返回图片');return;}
  // Only a real model reply is reported immediately (a refusal or a text answer).
  // Silence is not an answer, so it is given a much longer budget.
  const reply=modelReply(info);
  if(reply && waited>45000 && Date.now()-current.stableAt>20000)throw fail(reply);
 }catch(err){
  const message=String(err.message||err).slice(0,1800);
  if(current?.id){
   try{await api('/failure',{id:current.id,message,probe:err.probe});await store(null,'任务失败：'+message);}catch{await chrome.storage.local.set({status:'本机连接中断，未重发网页请求'});}
  }else await chrome.storage.local.set({status:'等待本机 Koishi 连接：'+message});
 }finally{ticking=false;}
}
chrome.alarms.create('poll',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>void tick());
chrome.runtime.onStartup.addListener(()=>void tick());
chrome.runtime.onInstalled.addListener(()=>void tick());
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message.type==='status'){tick().then(()=>chrome.storage.local.get('status')).then(data=>reply({status:data.status||'等待连接'}));return true;}
});
setInterval(()=>void tick(),2000);void tick();
