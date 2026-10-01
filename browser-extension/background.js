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
async function api(route,body){
 const response=await fetch(BRIDGE.url+route,{method:body?'POST':'GET',headers:{'x-bridge-token':BRIDGE.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('本机连接器返回 '+response.status);
 return response.json();
}
// Reply images travel as raw bytes: base64 inside the JSON result would inflate
// every picture by a third and blow the bridge body limit on a multi-image answer.
async function uploadAsset(id,index,base64){
 const binary=atob(base64);
 const bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 const response=await fetch(BRIDGE.url+'/result-asset?id='+encodeURIComponent(id)+'&i='+index,
  {method:'POST',headers:{'x-bridge-token':BRIDGE.token,'Content-Type':'image/png'},body:bytes,signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error('回复图片上传失败（'+response.status+'）');
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
 const match=location.pathname.match(/^\/c\/([a-f0-9-]{36})$/);
 const threadId=match?.[1]||'';
// ChatGPT has shipped several wrappers for a generated image, so identify one by
// what it is — a large bitmap — instead of a single data-testid that can be
// renamed without notice.
const source=img=>String(img?.currentSrc||img?.src||img?.getAttribute?.('src')||'');
// Size alone does not separate a generated picture from the signed-in account's
// avatar: that avatar is a 512×512 bitmap in the page chrome, it lives outside
// every conversation turn, and it is already loaded. Anything in the header or
// sidebar, or outside the conversation area, is chrome.
const conversationArea=document.querySelector('main');
const isChrome=img=>{
 if(typeof img.closest!=='function')return false;
 if(img.closest('header, nav, aside, [data-testid*="profile" i], [data-testid*="sidebar" i]'))return true;
 return !!conversationArea && typeof conversationArea.contains==='function' && !conversationArea.contains(img);
};
const looksGenerated=img=>{
 if(!img || typeof img.getAttribute!=='function')return false;
 if(!/^(?:blob:|data:image\/|https?:\/\/)/i.test(source(img)))return false;
 const label=String(img.getAttribute('alt')||'')+String(img.getAttribute('data-testid')||'');
 if(/avatar|profile|icon|emoji|头像/i.test(label))return false;
 // The picture the user attached is rendered in the conversation as well, and
 // its alt says so. Handing it back is the reference image coming out as the
 // result (job 02c2fa8e036a), so it is never a candidate.
 if(/附件|attachment/i.test(label))return false;
 if(isChrome(img))return false;
 const width=Number(img.naturalWidth)||0,height=Number(img.naturalHeight)||0;
 return width>=200 && height>=200;
};
const insideUser=img=>user.some(node=>{const scope=turn(node);return scope && typeof scope.contains==='function' && scope.contains(img);});
// The account avatar is also rendered inside the user's own turn. The newest
// assistant turn can resolve to a wrapper that covers that turn as well, so an
// image sitting in the user turn is never part of the reply.
const inUserTurn=img=>!!lastUser && typeof lastUser.contains==='function' && lastUser.contains(img);
// Only pictures inside the newest assistant turn count. The whole-page fallback
// scan was deleted on purpose: it is what handed back the account avatar
// (job f948b24235f4) and the user's own reference image (job 02c2fa8e036a). If a
// selector breaks the scan now finds nothing and we keep waiting, which fails
// safe instead of returning a wrong picture.
const replyImages=()=>{
 if(!lastAssistant || typeof lastAssistant.querySelectorAll!=='function')return [];
 return Array.from(lastAssistant.querySelectorAll('img')).filter(img=>looksGenerated(img)&&!inUserTurn(img)&&!insideUser(img));
};
// The reply body. The assistant role heading and the action buttons live beside
// the content, not inside it, so the markdown container is preferred whenever the
// page still exposes one.
const replyRoot=()=>{
 if(!lastAssistant)return null;
 const markdown=typeof lastAssistant.querySelector==='function'?lastAssistant.querySelector('[class*="markdown"]'):null;
 return markdown||lastAssistant;
};
const BLOCKS=new Set(['P','DIV','SECTION','ARTICLE','FIGURE','UL','OL','LI','BLOCKQUOTE','PRE','TABLE','H1','H2','H3','H4','H5','H6','HR']);
// Inline rendering keeps the structure a reader would see: links carry their
// target, inline code keeps its backticks, line breaks survive.
const inlineText=node=>{
 let out='';
 for(const child of node.childNodes||[]){
  if(child.nodeType===3){out+=child.nodeValue;continue;}
  if(child.nodeType!==1)continue;
  const tag=child.tagName;
  if(tag==='BR'){out+='\n';continue;}
  if(tag==='IMG'||tag==='BUTTON'||tag==='SVG'||tag==='STYLE'||tag==='SCRIPT')continue;
  if(tag==='CODE'){out+='`'+String(child.textContent||'')+'`';continue;}
  if(tag==='A'){
   const label=inlineText(child),href=String(child.href||child.getAttribute?.('href')||'');
   out+=href?label+' ('+href+')':label;continue;
  }
  out+=inlineText(child);
 }
 return out;
};
const tableText=table=>Array.from(table.querySelectorAll?.('tr')||[])
 .map(row=>'| '+Array.from(row.children||[]).map(cell=>inlineText(cell).trim().replace(/\n/g,' ')).join(' | ')+' |').join('\n');
// DOM → ordered segments. Images appear in document order, which is the order
// they are read in and therefore the order they must be sent back to QQ in.
const serializeReply=()=>{
 const segments=[],images=[];
 const pushImage=img=>{
  if(!looksGenerated(img)||images.includes(img))return;
  segments.push({type:'image',asset:images.length,mime:'image/png'});
  images.push(img);
 };
 const walk=node=>{
  for(const child of node.children||[]){
   const tag=child.tagName;
   if(tag==='BUTTON'||tag==='SVG'||tag==='STYLE'||tag==='SCRIPT')continue;
   if(tag==='IMG'){pushImage(child);continue;}
   if(tag==='PRE'){
    const code=(typeof child.querySelector==='function'&&child.querySelector('code'))||child;
    const language=(/language-([\w+#.-]+)/.exec(String(code.getAttribute?.('class')||''))||[])[1]||'';
    const text=String(code.innerText||code.textContent||'').replace(/\n+$/,'');
    if(text.trim())segments.push({type:'code',language,text});
    continue;
   }
   if(tag==='TABLE'){const text=tableText(child);if(text.trim())segments.push({type:'text',text});continue;}
   if(tag==='HR'){segments.push({type:'text',text:'---'});continue;}
   if(tag==='UL'||tag==='OL'){
    let index=1;
    for(const item of child.children||[]){
     if(item.tagName!=='LI')continue;
     const text=inlineText(item).trim();
     if(text)segments.push({type:'text',text:(tag==='OL'?(index++)+'. ':'- ')+text.replace(/\n/g,'\n  ')});
    }
    continue;
   }
   if(/^H[1-6]$/.test(tag)){const text=inlineText(child).trim();if(text)segments.push({type:'text',text:'#'.repeat(Number(tag[1]))+' '+text});continue;}
   if(tag==='BLOCKQUOTE'){const text=inlineText(child).trim();if(text)segments.push({type:'text',text:text.split('\n').map(line=>'> '+line).join('\n')});continue;}
   const hasBlock=Array.from(child.children||[]).some(node=>BLOCKS.has(node.tagName));
   if(!hasBlock){
    const text=inlineText(child).trim();
    if(text)segments.push({type:'text',text});
    for(const img of Array.from(child.querySelectorAll?.('img')||[]))pushImage(img);
    continue;
   }
   walk(child);
  }
 };
 const root=replyRoot();
 if(root){
  const rootHasBlock=Array.from(root.children||[]).some(node=>BLOCKS.has(node.tagName));
  if(rootHasBlock)walk(root);
  else{
   const text=inlineText(root).trim();
   if(text)segments.push({type:'text',text});
   for(const img of replyImages())pushImage(img);
  }
 }
 return {segments,images};
};
// The turn is identified by counting, not by a marker: nothing the connector needs
// may end up inside the user's own prompt, because that text is forwarded verbatim
// and stays in the ChatGPT history forever.
const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
const sameText=(sent,seen)=>{
 const a=normalize(sent),b=normalize(seen);
 if(!a)return true;
 if(a===b||b.includes(a))return true;
 return b.length>=20&&a.startsWith(b);
};
const userText=String(lastUser?.innerText||'');
// Counting is the primary signal: the rendered user bubble can differ from what
// was typed (markdown, collapsing), so a text mismatch alone must never be read
// as "our message never landed".
const submitted=user.length>(job.userBaseline||0);
const probeDom=()=>({
 turns:document.querySelectorAll('[data-testid^="conversation-turn"]').length,
 userNodes:user.length,assistantAnchor:!!lastAssistant,
 roleNodes:Array.from(document.querySelectorAll('[data-message-author-role],[data-conversation-role]')).slice(0,20)
  .map(el=>el.tagName.toLowerCase()+'@'+(el.getAttribute('data-message-author-role')||el.getAttribute('data-conversation-role')||'')),
 images:Array.from(document.querySelectorAll('img')).slice(0,20).map(img=>({
  src:source(img).replace(/^([a-z]+:)[\s\S]*/i,'$1').slice(0,12),
  alt:String(img.getAttribute?.('alt')||'').slice(0,40),
  testid:String(img.getAttribute?.('data-testid')||'').slice(0,40),
  w:Number(img.naturalWidth)||0,h:Number(img.naturalHeight)||0,complete:img.complete!==false,
  inUser:insideUser(img),inUserTurn:inUserTurn(img),chrome:isChrome(img),picked:replyImages().includes(img)})),
 assistantHtml:String(lastAssistant?.outerHTML||'').slice(0,2500)});
 // Attachments are counted inside the composer only, so conversation images are
 // never mistaken for a reference image that is still uploading.
 const composer=editor && typeof editor.closest==='function'
  ?(editor.closest('form')||editor.closest('[data-testid*="composer" i]')||editor.parentElement||null):null;
 const attachmentNodes=composer && typeof composer.querySelectorAll==='function'
  ?Array.from(composer.querySelectorAll('img[src^="blob:"], [data-testid*="attachment" i], [data-testid*="composer-file" i]')):[];
 const chatGroup=document.querySelector('[aria-label="撰写器模式"], [aria-label="Composer mode"]');
 const chatButton=chatGroup && Array.from(chatGroup.querySelectorAll('button')).find(b=>['聊天','Chat'].includes(b.innerText.trim()));
 const replyText=String(lastAssistant?.innerText||'');
 const snapshot={url:location.href,threadId,users:user.length,assistants:assistant.length,submitted,
  textMatched:sameText(job.sentText,userText),userText:userText.slice(0,120),
  editor:!!editor,stopping:!!stop,images:replyImages().length,attachments:new Set(attachmentNodes).size,
  replyText:replyText.slice(0,1800),replyStable:normalize(replyText).length,
  needsChat:!!chatButton && chatButton.getAttribute('aria-pressed')!=='true',
  login:!editor && !!byLabel(['登录','Log in','Sign in']),
  challenge:/verify you are human|确认您是真人|验证您是真人|checking your browser/i.test(document.body.innerText.slice(0,1500))};
 if(operation==='inspect'){
  // Ground truth for the next failure: when nothing readable shows up, keep the
  // page structure so the selectors can be corrected without guessing.
  if(!replyText.trim() && job.sentAt && Date.now()-job.sentAt>90000)snapshot.probe=probeDom();
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
  if(submitted)return {alreadySent:true};
  if(!editor || stop || snapshot.needsChat)throw Error('网页未就绪或不在普通 Chat 模式');
  if(job.threadId && job.threadId!==threadId)throw Error('网页会话与任务不一致');
  const current=editor.innerText.trim();
  const placeholder=['询问 ChatGPT','Ask ChatGPT'];
  // A previous run can leave its own unsent draft behind. The extension remembers
  // the last text it filled in, so the connector's leftovers are recognisable
  // without writing a marker into the user's prompt; anything else is the user's
  // own input and is never overwritten.
  const leftover=!!job.draft && normalize(current)===normalize(job.draft);
  if(current && !placeholder.includes(current) && !leftover)throw Error('专用标签页输入框已有内容，请清空后重新发送任务');
  editor.focus();
  if(leftover){document.execCommand('selectAll',false);document.execCommand('delete',false);}
  const message=String(job.message||'');
  document.execCommand('selectAll',false);document.execCommand('insertText',false,message);
  editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:message}));
  return {filled:normalize(editor.innerText)===normalize(message)};
 }
 if(operation==='send'){
  if(submitted)return {alreadySent:true};
  const message=normalize(job.message);
  // React may render the button before it has committed the editor value. This is
  // a safe retry point because no click has happened yet.
  const send=byLabel(['发送','Send','发送提示','Send prompt']);
  if(message && !normalize(editor?.innerText||'').includes(message.slice(0,60)))throw Error('输入内容已变化，未发送');
  if(!send || send.disabled)return {ready:false};
  send.click();return {clicked:true};
 }
 if(operation==='read'){
  const {segments,images}=serializeReply();
  return {threadId,segments,imageCount:images.length,probe:probeDom()};
 }
 if(operation==='image'){
  const {images}=serializeReply();
  const img=images[Number(job.imageIndex)||0];
  if(!img)throw Error('回复中的图片不存在');
  if(img.naturalWidth*img.naturalHeight>32*1024*1024)throw Error('图片尺寸超过上限');
  const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  canvas.getContext('2d').drawImage(img,0,0);
  return {base64:canvas.toDataURL('image/png').split(',')[1]};
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
// The draft record is what replaces the old in-prompt marker: it lets the worker
// recognise its own leftover text without putting anything into the user's prompt.
async function saveDraft(text){await chrome.storage.local.set({draft:text||null});}
async function tick(){
 if(ticking)return;ticking=true;
 let current;
 try{
  const remote=await api('/state');
  const stored=await chrome.storage.local.get(['current','draft']);
  current=stored.current;
  if(!remote.job){
   // A completed/orphaned task is never resubmitted, even after service restarts.
   await store(null,'已连接本机 Koishi，等待任务');return;
  }
  const task=remote.job;
  if(!current || current.id!==task.id){
   const tab=await chrome.tabs.create({url:task.threadId?'https://chatgpt.com/c/'+task.threadId:'https://chatgpt.com/',active:false});
   current={...task,tabId:tab.id,phase:'opening',openedAt:Date.now(),hasImages:!!(task.images&&task.images.length),
    sentText:task.text||'',draft:stored.draft||null,padded:false};
   await store(current,'正在打开 ChatGPT 标签页');await api('/progress',{id:task.id,phase:'opening'});return;
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
   // Count the user's turns before submitting: the new turn is what proves the
   // message actually landed, and it does so without a marker in the prompt.
   current.userBaseline=info.users;
   if(current.hasImages){current.phase='attaching';await store(current,'正在上传参考图片到 ChatGPT');return;}
   current.phase='filling';await store(current,'正在填写消息');
  }
  if(current.phase==='attaching'){
   if(info.attachments>=1){current.phase='filling';await store(current,'参考图片已上传，正在填写消息');}
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
   // A pure-image message is submitted with an empty body first. Only if the send
   // button refuses to unlock does one space get added — never a marker, and never
   // an instruction the user did not write.
   const message=current.padded?' ':(current.sentText||'');
   const filled=await page(current.tabId,'submit',{...current,message});
   if(!filled.filled && !filled.alreadySent)throw Error('无法填写 ChatGPT 输入框');
   await saveDraft(message);
   current.phase='filled';current.filledAt=Date.now();await store(current,'消息已填写，等待输入框完成更新');return;
  }
  if(current.phase==='filled'){
   // Wait a separate polling turn for the editor to commit React state.
   // Persist before clicking: crashes in this gap fail closed, never duplicate.
   current.phase='sending';current.sentAt=Date.now();await store(current,'正在提交 ChatGPT');
   const sent=await page(current.tabId,'send',{...current,message:current.padded?' ':(current.sentText||'')});
   if(!sent.clicked && !sent.alreadySent){
    const waited=Date.now()-(current.filledAt||Date.now());
    if(!current.sentText && !current.padded && waited>5000){
     current.padded=true;current.phase='filling';await store(current,'纯图片消息补一个空格以启用发送按钮');return;
    }
    if(waited>30000)throw Error('ChatGPT 发送按钮持续不可用，请重试；本次未重复提交');
    current.phase='filled';
    await store(current,'等待 ChatGPT 启用发送按钮');
    return;
   }
   await saveDraft(null);
   current.phase='waiting';await store(current,'ChatGPT 正在生成回复');return;
  }
  if(current.phase==='sending'){
   if(!info.submitted){if(Date.now()-current.sentAt>15000)throw Error('网页提交状态不明确，未自动重复发送，请检查专用标签页');return;}
   await saveDraft(null);
   current.phase='waiting';await store(current,'ChatGPT 正在生成回复');
  }
  if(!info.submitted){if(Date.now()-current.sentAt>20000)throw Error('消息未出现在专用标签页上，未取得本轮回复');return;}
  if(info.threadId)await api('/progress',{id:task.id,threadId:info.threadId,phase:'submitted'});
  if(info.assistants<=current.baseline || info.stopping)return;
  // ChatGPT renders the empty assistant turn long before the answer exists, and a
  // text answer can stream for minutes. Silence is not a finished answer: only a
  // stable reply on a page that is no longer busy counts as done.
  const waited=Date.now()-current.sentAt;
  if(waited<1500)return;
  // Checked before the busy branch below, otherwise a page that never stops
  // looking busy would wait out the bridge timeout instead of failing clearly.
  if(waited>240000)throw Object.assign(Error('等待网页回复超时，未读取到内容'),{probe:info.probe});
  const busy=info.stopping||/正在生成|生成中|正在创建|正在思考|Generating|Thinking|Creating image/i.test(info.replyText);
  if(busy||!info.replyStable){current.stableAt=Date.now();await store(current,'ChatGPT 正在生成回复');return;}
  if(current.lastText!==info.replyText){current.lastText=info.replyText;current.stableAt=Date.now();await store(current,'正在等待网页回复结束');return;}
  if(Date.now()-current.stableAt<3000)return;
  await api('/progress',{id:task.id,threadId:info.threadId,phase:'reading'});
  const reply=await page(current.tabId,'read',current);
  if(!reply.segments||!reply.segments.length)throw Object.assign(Error('网页已结束回答，但没有读取到可回传的内容'),{probe:reply.probe});
  for(let index=0;index<reply.imageCount;index++){
   const image=await page(current.tabId,'image',{...current,imageIndex:index});
   await uploadAsset(task.id,index,image.base64);
  }
  await api('/result',{id:task.id,threadId:reply.threadId||info.threadId,segments:reply.segments,probe:reply.probe});
  await store(null,'回复已交给 Koishi 回传 QQ');
  await chrome.tabs.remove(current.tabId).catch(()=>{});
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
