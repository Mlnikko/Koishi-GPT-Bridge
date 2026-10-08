importScripts('config.js');
let ticking=false;
// Reference-image bytes are cached per task while the service worker lives, so a
// slow upload is never restarted and the data never touches persistent storage.
const inputs=new Map();
// Only bridge I/O is retryable. Never automatically repeat a DOM send click.
async function bridgeFetch(url,options){
 try{
  const response=await fetch(url,options);
  if(!response.ok)throw Object.assign(Error('本机连接器返回 '+response.status),{retryable:response.status>=500||response.status===429});
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
  const response=await bridgeFetch(BRIDGE.url+'/input?id='+encodeURIComponent(task.id)+'&i='+image.index,
   {headers:{'x-bridge-token':BRIDGE.token},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('无法读取本机参考图片（'+response.status+'）');
  list.push({name:image.name||('image-'+image.index+'.png'),mime:image.mime||'image/png',base64:toBase64(new Uint8Array(await response.arrayBuffer()))});
 }
 inputs.set(task.id,list);return list;
}
async function api(route,body){
 const response=await bridgeFetch(BRIDGE.url+route,{method:body?'POST':'GET',headers:{'x-bridge-token':BRIDGE.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('本机连接器返回 '+response.status);
 try{return await response.json();}catch(err){err.retryable=true;throw err;}
}
// Reply images travel as raw bytes: base64 inside the JSON result would inflate
// every picture by a third and blow the bridge body limit on a multi-image answer.
async function uploadAsset(id,index,base64){
 const binary=atob(base64);
 const bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 const response=await bridgeFetch(BRIDGE.url+'/result-asset?id='+encodeURIComponent(id)+'&i='+index,
  {method:'POST',headers:{'x-bridge-token':BRIDGE.token,'Content-Type':'image/png'},body:bytes,signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error('回复图片上传失败（'+response.status+'）');
}
async function pageStep(operation,job){
 try {
 const buttons=()=>Array.from(document.querySelectorAll('button'));
 const byLabel=labels=>buttons().find(b=>labels.includes(b.getAttribute('aria-label')||'') || labels.includes(b.innerText.trim()));
 const roles=role=>{
  const primary=Array.from(document.querySelectorAll(role==='user'?'[data-user-message-bubble]':`[data-conversation-role="${role}"]`));
  return primary.length?primary:Array.from(document.querySelectorAll(`[data-message-author-role="${role}"]`));
 };
 const turn=node=>{
  if(!node)return null;
  if(typeof node.closest==='function'){const found=node.closest('[data-testid^="conversation-turn"], [data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-message-author-role]');if(found)return found;}
  return node.parentElement||node;
 };
 const user=roles('user'),assistant=roles('assistant'),lastUser=turn(user.at(-1)),lastAssistant=turn(assistant.at(-1));
 // DOM order, rather than the number of mounted history entries, bounds a
 // reply. Virtualized conversations can remove old bubbles while adding new ones.
 const order=new Map(),ends=new Map();let ordinal=0;
 const indexTree=node=>{order.set(node,ordinal++);for(const child of node.children||[])indexTree(child);ends.set(node,ordinal-1);};
 indexTree(document.body);
 const after=(node,boundary)=>order.has(node)&&order.has(boundary)&&order.get(node)>order.get(boundary);
 const userAnchor=user.at(-1);
 const messageId=node=>{
  const attrs=['data-message-id','data-chatgpt-selection-message-id','data-chatgpt-search-message-ids'];
  for(const attr of attrs){
   const carrier=node?.getAttribute?.(attr)?node:node?.closest?.('['+attr+']')||node?.querySelector?.('['+attr+']');
   const value=carrier?.getAttribute?.(attr);
   if(value)return [...new Set(value.trim().split(/\s+/))].join(' ');
  }
  return '';
 };
 // A reply may consist of a generated-image block plus a separate, empty final
 // assistant block. Keep all reply blocks after the latest user bubble.
 const roots=userAnchor?assistant.filter(node=>after(node,userAnchor)).map(turn):[lastAssistant].filter(Boolean);
 if(userAnchor){
  for(const gallery of Array.from(document.querySelectorAll('[data-testid*="generated-image-gallery" i]'))){
   if(after(gallery,userAnchor)&&!gallery.closest?.('form, nav, aside, header, [role="dialog"]')
    &&!user.some(node=>node.contains?.(gallery)))roots.push(gallery);
  }
 }
 const uniqueRoots=[...new Set(roots)].filter(Boolean);
 const replyRoots=uniqueRoots.filter(node=>!uniqueRoots.some(parent=>parent!==node&&parent.contains?.(node)))
  .sort((a,b)=>(order.get(a)||0)-(order.get(b)||0));
 // A generated writing block is editable too. Resolve by structure, never by
 // text length, document order, or whichever textbox happens to have focus.
 const visible=node=>{
  if(node.closest?.('[hidden], [aria-hidden="true"], [inert]'))return false;
  if(typeof node.getClientRects==='function'&&!node.getClientRects().length)return false;
  if(typeof getComputedStyle==='function'){
   const style=getComputedStyle(node);
   if(style.visibility==='hidden'||style.visibility==='collapse'||style.display==='none')return false;
  }
  return true;
 };
 const historySelector='[data-testid^="conversation-turn"], [data-message-author-role], [data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-chatgpt-selection-message-id], [data-dil-message-id], [class*="writing-block"], [data-testid*="canvas" i]';
 const exclusion=node=>!visible(node)?'hidden':node.closest?.(historySelector)?'reply-or-history':
  node.closest?.('nav, aside, [role="dialog"], [aria-modal="true"]')?'outside-chat':
  node.getAttribute('aria-disabled')==='true'||node.getAttribute('aria-readonly')==='true'?'disabled':'';
 const allEditors=Array.from(document.querySelectorAll('[contenteditable="true"]'));
 const editors=allEditors.filter(node=>!exclusion(node));
 const sendLabels=['发送','Send','发送提示','Send prompt'];
 const isSend=button=>visible(button)&&(sendLabels.includes(button.getAttribute('aria-label')||'')||sendLabels.includes(button.innerText.trim())||button.getAttribute('data-testid')==='send-button');
 const composerSelector='[data-testid*="composer" i], [id="composer-background"], [data-type="unified-composer"]';
 const scopeOf=node=>{
  const form=node.closest?.('form');
  if(form&&!form.querySelector?.(historySelector)&&editors.filter(candidate=>form.contains(candidate)).length===1
   &&Array.from(form.querySelectorAll?.('button')||[]).some(isSend))return form;
  const explicit=node.closest?.(composerSelector);
  if(explicit&&Array.from(explicit.querySelectorAll?.('button')||[]).some(isSend))return explicit;
  let parent=node.parentElement;
  for(let depth=0;parent&&depth<8;depth++,parent=parent.parentElement){
   if(['BODY','MAIN','HTML'].includes(parent.tagName))break;
   // Do not associate a button across a wrapper that also contains another
   // editor or message history; that recreates the original global-selector bug.
   if(parent.querySelector?.(historySelector))break;
   if(editors.filter(candidate=>parent.contains(candidate)).length!==1)break;
   if(Array.from(parent.querySelectorAll?.('button')||[]).some(isSend))return parent;
  }
  const fallback=explicit||form||node.parentElement;
  return fallback&&!['BODY','MAIN','HTML'].includes(fallback.tagName)?fallback:null;
 };
 const score=node=>node.getAttribute('id')==='prompt-textarea'?3:
  node.closest?.(composerSelector)?2:
  Array.from(scopeOf(node)?.querySelectorAll?.('button')||[]).some(isSend)?1:0;
 const eligible=editors.filter(node=>node.getAttribute('id')==='prompt-textarea'||node.getAttribute('role')==='textbox');
 const best=eligible.length?Math.max(...eligible.map(score)):-1;
 const candidates=eligible.filter(node=>score(node)===best);
 const editor=candidates.length===1?candidates[0]:null;
 const composer=editor?scopeOf(editor):null;
 const sendButtons=Array.from((composer||document).querySelectorAll?.('button')||[]).filter(isSend);
 const sendButton=sendButtons.length===1?sendButtons[0]:null;
 const normalized=value=>String(value||'').replace(/\s+/g,' ').trim();
 const ownedDraft=node=>[job.draft,...(job.drafts||[])].some(text=>text&&normalized(text)===normalized(node.innerText));
 const unknownDrafts=eligible.some(node=>normalized(node.innerText)&&!['询问 ChatGPT','Ask ChatGPT'].includes(normalized(node.innerText))&&!ownedDraft(node));
 const attachmentSelector='img[src^="blob:"], img[src^="data:image/"], img[src^="https://"], [data-testid*="attachment" i], [data-testid*="composer-file" i]';
 const recoverySafe=!unknownDrafts&&!eligible.some(node=>scopeOf(node)?.querySelector?.(attachmentSelector+', [role="progressbar"], [aria-busy="true"]'));
 const stop=byLabel(['停止','Stop','停止生成','Stop generating']);
 const match=location.pathname.match(/^\/c\/([a-f0-9-]{36})$/);
 const threadId=match?.[1]||'';
 if(['attach','prepare','submit','send','read','image','stop'].includes(operation) && job.threadId && job.threadId!==threadId)
  throw Error('网页会话与任务不一致');
// ChatGPT has shipped several wrappers for a generated image, so identify one by
// what it is — a large bitmap — instead of a single data-testid that can be
// renamed without notice.
const source=img=>String(img?.currentSrc||img?.src||img?.getAttribute?.('src')||'');
// Size alone does not separate a generated picture from the signed-in account's
// avatar: that avatar is a 512×512 bitmap in the page chrome, it lives outside
// every conversation turn, and it is already loaded.
const conversationArea=document.querySelector('main');
// 已经在最新回复轮次内部的图片直接放行：位置本身就是最强的证据。
// 「不在 <main> 内」是一条依赖页面结构的假设，ChatGPT 一旦把会话渲染到 <main> 之外，
// 它就会把真正的生成图整批判成页面框架 —— 任务 e1d8e9675311 就是这样等满 240 秒后
// 报「未检测到本轮图片」，而页面上那张 1367×1150 的图一直都在。
const inReplyTurn=img=>replyRoots.some(root=>root.contains?.(img));
const chromeReason=img=>{
 if(typeof img.closest!=='function')return '';
 const ancestor=img.closest('header, nav, aside, [data-testid*="profile" i], [data-testid*="sidebar" i]');
 if(ancestor)return 'ancestor:'+String(ancestor.tagName).toLowerCase();
 if(inReplyTurn(img))return '';
 if(conversationArea && typeof conversationArea.contains==='function' && !conversationArea.contains(img))return 'outside-main';
 return '';
};
const isChrome=img=>!!chromeReason(img);
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
const userScopes=user.map(node=>{
 const scope=turn(node);
 // A shared conversation wrapper is not a user-only boundary.
 return assistant.some(anchor=>scope?.contains?.(anchor))?node:scope;
});
const insideUser=img=>userScopes.some(scope=>scope?.contains?.(img));
// The account avatar is also rendered inside the user's own turn. The newest
// assistant turn can resolve to a wrapper that covers that turn as well, so an
// image sitting in the user turn is never part of the reply.
const inUserTurn=img=>!!userScopes.at(-1)?.contains?.(img);
// Never scan arbitrary page images: candidates must belong to bounded reply
// blocks or an explicit generated gallery after this turn's user message.
const replyImages=()=>[...new Set(replyRoots.flatMap(root=>Array.from(root.querySelectorAll?.('img')||[])))]
 .filter(img=>(!userAnchor||after(img,userAnchor))&&looksGenerated(img)&&!inUserTurn(img)&&!insideUser(img));
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
  if((userAnchor&&!after(img,userAnchor))||!looksGenerated(img)||inUserTurn(img)||insideUser(img)||images.includes(img))return;
  segments.push({type:'image',asset:images.length,mime:'image/png'});
  images.push(img);
 };
 const walk=node=>{
  for(const child of node.children||[]){
   const tag=child.tagName;
   if(userAnchor&&ends.has(child)&&ends.get(child)<order.get(userAnchor))continue;
   if(child.getAttribute?.('data-user-message-bubble')!==null&&child.getAttribute?.('data-user-message-bubble')!==undefined)continue;
   if(child.getAttribute?.('data-message-author-role')==='user')continue;
   if(child.closest?.('[hidden], [aria-hidden="true"], nav, aside, form'))continue;
   // Generated-image previews are interactive BUTTONs. Ignore their control text,
   // but keep any valid image nested inside; otherwise the real ChatGPT gallery
   // shape produces picked=true in the probe while serializeReply() returns zero.
   if(tag==='BUTTON'){
    for(const img of Array.from(child.querySelectorAll?.('img')||[]))pushImage(img);
    continue;
   }
   if(tag==='SVG'||tag==='STYLE'||tag==='SCRIPT')continue;
   // 「ChatGPT 说：」这类无障碍标题是页面框架，不是回复内容。轮次容器把标题和
   // 正文放在一起，少了这道过滤，一个还没出图的空轮次也会被读成一条回复。
   if(child.getAttribute?.('data-conversation-role')||(/^H[1-6]$/.test(tag)&&child.getAttribute?.('data-message-author-role')))continue;
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
 for(const root of replyRoots){
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
const userText=String(userAnchor?.innerText||'');
const userId=messageId(userAnchor);
const userChanged=!!((job.submittedUserId&&userId&&job.submittedUserId!==userId)||
 (!job.submittedUserId&&job.submittedUserText!==undefined&&normalize(job.submittedUserText)!==normalize(userText)));
const identityChanged=!!(job.userId&&userId&&job.userId!==userId);
// Without IDs, exact new text is additional evidence when history counts shrink.
// Repeated identical prompts or image-only prompts still require IDs or counts.
const newExactText=job.userText!==undefined&&normalize(job.sentText)&&normalize(userText)===normalize(job.sentText)
 &&normalize(userText)!==normalize(job.userText);
const submitted=job.submittedConfirmed?!userChanged:
 identityChanged||!!newExactText||user.length>(job.userBaseline||0);
const assistantId=replyRoots.map(messageId).filter(Boolean).join('|')||(!userAnchor?messageId(lastAssistant):'');
if(['read','image'].includes(operation)&&userChanged)throw Error('网页出现其他用户轮次，未读取不属于本任务的回复');
// 排查用：把一张图的祖先链记下来。只看 tag 名和 testid，
// 一旦某张图被判掉，就能直接看出是哪一层祖先触发的规则。
const ancestorChain=img=>{
 const out=[];
 let node=img?.parentElement,depth=0;
 while(node&&depth<14){
  const testid=node.getAttribute?.('data-testid');
  const role=node.getAttribute?.('data-conversation-role')||node.getAttribute?.('data-message-author-role');
  out.push(String(node.tagName||'').toLowerCase()+(testid?'['+String(testid).slice(0,40)+']':'')+(role?'@'+role:''));
  node=node.parentElement;depth++;
 }
 return out.join(' < ');
};
const probeDom=()=>({
 workerVersion:job.workerVersion||'unknown',stopping:!!stop,replyLength,readableImages:images.length,
 turns:document.querySelectorAll('[data-testid^="conversation-turn"]').length,
 userNodes:user.length,assistantAnchor:!!lastAssistant,main:!!conversationArea,
 userId,baselineUserId:job.userId||'',submitted,submittedConfirmed:!!job.submittedConfirmed,userChanged,
 baselineUsers:job.userBaseline,baselineAssistants:job.baseline,assistantId,baselineAssistantId:job.assistantId||'',
 replyRoots:replyRoots.map(root=>({tag:root.tagName,id:messageId(root),key:root.getAttribute?.('data-content-search-unit-key'),
  images:root.querySelectorAll?.('img').length||0,chars:String(root.innerText||'').length})),
 roleNodes:Array.from(document.querySelectorAll('[data-message-author-role],[data-conversation-role]')).slice(0,20)
  .map(el=>el.tagName.toLowerCase()+'@'+(el.getAttribute('data-message-author-role')||el.getAttribute('data-conversation-role')||'')),
 images:Array.from(document.querySelectorAll('img')).slice(0,20).map(img=>({
  src:source(img).replace(/^([a-z]+:)[\s\S]*/i,'$1').slice(0,12),
  alt:String(img.getAttribute?.('alt')||'').slice(0,40),
  testid:String(img.getAttribute?.('data-testid')||'').slice(0,40),
  w:Number(img.naturalWidth)||0,h:Number(img.naturalHeight)||0,complete:img.complete!==false,
  inUser:insideUser(img),inUserTurn:inUserTurn(img),inReplyTurn:inReplyTurn(img),
  chrome:isChrome(img),chromeReason:chromeReason(img),gallery:!!img.closest?.('[data-testid*="generated-image" i]'),
  picked:replyImages().includes(img),ancestors:ancestorChain(img)})),
 assistantHtml:String(lastAssistant?.outerHTML||'').slice(0,2500)});
 // Attachments are counted inside the composer only, so conversation images are
 // never mistaken for a reference image that is still uploading.
 const attachmentNodes=composer && typeof composer.querySelectorAll==='function'
  ?Array.from(composer.querySelectorAll(attachmentSelector)):[];
 // A card and its thumbnail describe one attachment, not two uploaded files.
 const attachments=attachmentNodes.filter(node=>!attachmentNodes.some(parent=>parent!==node&&parent.contains(node)));
 const uploading=!!composer?.querySelector?.('[role="progressbar"], [aria-busy="true"]')
  || attachmentNodes.some(node=>node.tagName==='IMG'&&node.complete===false);
 const chatGroup=document.querySelector('[aria-label="撰写器模式"], [aria-label="Composer mode"]');
 const chatButton=chatGroup && Array.from(chatGroup.querySelectorAll('button')).find(b=>['聊天','Chat'].includes(b.innerText.trim()));
 // 完成判定必须看**读出来的内容**，而不是整个轮次的文本：空轮次里也有
 // 「ChatGPT 说：」这类无障碍标题，把它当成回复就会在图片还没渲染出来时提前收工，
 // 而收工之后扩展会关掉标签页 —— 等于把还在生成的图一起关掉。
 const {segments,images}=serializeReply();
 const answerText=segments.filter(segment=>segment.type!=='image').map(segment=>segment.text).join('\n');
 const replyLength=answerText.replace(/\s+/g,'').length;
 const imageLoading=images.some(image=>image.complete===false||!(Number(image.naturalWidth)>0));
 // 画廊已经出现但还没有可用图片，说明图正在画。
 const galleries=[...new Set(replyRoots.flatMap(root=>[
  ...(root.getAttribute?.('data-testid')?.includes('generated-image-gallery')?[root]:[]),
  ...Array.from(root.querySelectorAll?.('[data-testid*="generated-image-gallery" i]')||[]),
 ]))].filter(visible);
 const gallery=galleries.length>0;
 const pendingGallery=galleries.some(root=>!Array.from(root.querySelectorAll('img')).some(img=>images.includes(img)&&img.complete!==false));
 const checksum=value=>{let hash=0;for(let i=0;i<value.length;i++)hash=(hash*31+value.charCodeAt(i))|0;return hash;};
 const snapshot={url:location.href,threadId,users:user.length,assistants:assistant.length,submitted,
  textMatched:sameText(job.sentText,userText),userText,userId,userChanged,replyBlocks:replyRoots.length,replyBounded:!!userAnchor,
  editor:!!editor,editorAmbiguous:candidates.length>1,editorSelection:best,unknownDrafts,recoverySafe,stopping:!!stop,images:images.length,imageLoading,gallery,pendingGallery,attachments:attachments.length,uploading,
  replyLength,assistantId,replySignature:checksum(answerText)+'/'+replyLength+'/'+images.length+'/'+checksum(images.map(source).join('|')),
  busyText:replyRoots.map(root=>String(root.innerText||'')).join('\n').slice(0,600),
  needsChat:!!chatButton && chatButton.getAttribute('aria-pressed')!=='true',
  login:!editor && !!byLabel(['登录','Log in','Sign in']),
  challenge:/verify you are human|确认您是真人|验证您是真人|checking your browser/i.test(document.body.innerText.slice(0,1500))};
 if(operation==='probe')return {...probeDom(),phase:job.phase,users:user.length,userBaseline:job.userBaseline,
  recoveryCount:job.recoveryCount||0,openingStartedAt:job.openingStartedAt||job.openedAt,threadId,expectedThreadId:job.threadId||'',
  attachments:attachments.length,expectedAttachments:job.images?.length||0,uploading,
  editorPresent:!!editor,editorChars:String(editor?.innerText||'').length,
  editorCandidates:allEditors.slice(0,20).map(node=>({id:node.getAttribute('id'),role:node.getAttribute('role'),
   chars:String(node.innerText||'').length,excluded:exclusion(node),selected:node===editor,score:exclusion(node)?-1:score(node),
   ancestors:ancestorChain(node),testid:node.getAttribute('data-testid'),label:node.getAttribute('aria-label')})),
  composerTag:composer?.tagName||null,sendCandidates:sendButtons.length,
  draftMatched:!!editor && [job.draft,...(job.drafts||[])].some(text=>text && normalize(text)===normalize(editor.innerText)),
  fileInputs:Array.from(document.querySelectorAll('input[type="file"]')).map(input=>({accept:input.getAttribute('accept'),disabled:!!input.disabled})),
  buttons:buttons().map(b=>({label:b.getAttribute('aria-label')||b.innerText.trim(),disabled:!!b.disabled})).filter(b=>/send|发送|upload|上传/i.test(b.label)).slice(0,10)};
 if(operation==='inspect'){
  // Ground truth for the next failure: when nothing readable shows up, keep the
  // page structure so the selectors can be corrected without guessing.
  if(!replyLength && !images.length && job.sentAt && Date.now()-job.sentAt>90000)snapshot.probe=probeDom();
  return snapshot;
 }
 if(operation==='chat'){if(chatButton)chatButton.click();return snapshot;}
 if(operation==='stop'){if(stop)stop.click();return {stopped:!!stop};}
 if(operation==='attach'){
  if(!editor||candidates.length>1)throw Error('无法确定 ChatGPT 消息输入框，未上传附件');
  const list=Array.isArray(job.images)?job.images:[];
  if(!list.length)return {attached:0};
  const transfer=new DataTransfer();
  for(const item of list){
   const binary=atob(item.base64);
   const bytes=new Uint8Array(binary.length);
   for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
   transfer.items.add(new File([bytes],item.name||'image.png',{type:item.mime||'image/png'}));
  }
  // The first file input may belong to another tool (e.g. document upload).
  const local=Array.from(composer?.querySelectorAll?.('input[type="file"]')||[]).filter(input=>!input.disabled);
  const fileCandidates=local.length?local:Array.from(document.querySelectorAll('input[type="file"]')).filter(input=>!input.disabled&&!input.closest?.(historySelector));
  const acceptsImages=input=>{
   const accept=String(input.getAttribute('accept')||'').toLowerCase().split(',').map(value=>value.trim());
   return list.every(item=>accept.includes('image/*')||accept.includes(item.mime)||accept.includes('.'+item.name.split('.').pop().toLowerCase()));
  };
  const compatible=fileCandidates.filter(acceptsImages);
  // A video/media picker can accept image/* but belong to another tool.
  const input=compatible.find(input=>!/(?:video|audio)\//i.test(input.getAttribute('accept')||''))
    ||compatible[0]||fileCandidates.find(input=>!input.getAttribute('accept'));
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
 if(operation==='prepare'||operation==='submit'){
  if(submitted)return {alreadySent:true};
  if(candidates.length>1)throw Error('检测到多个输入框，无法确定 ChatGPT 消息输入框');
  if(!editor || stop || snapshot.needsChat)throw Error('网页未就绪或不在普通 Chat 模式');
  if(job.threadId && job.threadId!==threadId)throw Error('网页会话与任务不一致');
  const current=editor.innerText.trim();
  const placeholder=['询问 ChatGPT','Ask ChatGPT'];
  // A previous run can leave its own unsent draft behind. The extension remembers
  // the last text it filled in, so the connector's leftovers are recognisable
  // without writing a marker into the user's prompt; anything else is the user's
  // own input and is never overwritten.
  const leftover=[job.draft,...(job.drafts||[])].some(text=>text && normalize(current)===normalize(text));
  if(current && !placeholder.includes(current) && !leftover)throw Error('专用标签页输入框已有内容，请清空后重新发送任务');
  if(operation==='prepare')return {prepared:true};
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
  if(!editor||candidates.length>1)throw Error('无法确定 ChatGPT 消息输入框，未发送');
  if(sendButtons.length>1)throw Error('消息输入框对应多个发送按钮，未发送');
  const send=sendButton;
  if(normalize(editor?.innerText||'')!==message)throw Error('输入内容已变化，未发送');
  if(!send || send.disabled)return {ready:false};
  send.click();return {clicked:true};
 }
 if(operation==='read'){
  return {threadId,segments,imageCount:images.length,probe:probeDom()};
 }
 if(operation==='image'){
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
 if(tab.status==='loading'&&job.phase==='opening')return {loading:true};
 const results=await chrome.scripting.executeScript({target:{tabId},func:pageStep,
  args:[op,{...job,workerVersion:chrome.runtime.getManifest?.().version||'development'}]});
 if(!results[0]?.result)throw Error('ChatGPT 页面脚本未返回结果，请检查扩展错误');
 if(results[0].result.error)throw Error(results[0].result.error);
 return results[0].result;
}
async function store(current,status){if(!current)inputs.clear();await chrome.storage.local.set({current,status});}
// The draft record is what replaces the old in-prompt marker: it lets the worker
// recognise its own leftover text without putting anything into the user's prompt.
async function saveDraft(text){await chrome.storage.local.set({draft:text||null});}
// Refresh only an untouched task tab, at most once, retaining the same thread.
// Recovery state is durable before reload, including across MV3 suspension.
async function waitForComposer(current,info){
 const now=Date.now();
 current.composerWaitAt=current.composerWaitAt||now;
 current.openingStartedAt=current.openingStartedAt||current.openedAt||now;
 if(now-current.openingStartedAt>90000)throw Error('ChatGPT 页面加载超时，输入框仍未就绪；本次未提交');
 if(now-current.composerWaitAt<15000){
  await store(current,'正在等待 ChatGPT 消息输入框稳定');return;
 }
 if(!current.recoveryCount&&!current.sentAt&&!current.attachSent&&info.recoverySafe===true&&!info.unknownDrafts&&!info.attachments&&!info.stopping){
  current.recoveryCount=1;current.openedAt=now;delete current.composerWaitAt;
  delete current.historySeen;delete current.historyStreak;
  await store(current,'输入框未就绪，正在重新加载原网页会话（仅一次）');
  await chrome.tabs.reload(current.tabId);return;
 }
 throw Error(info.editorAmbiguous?'检测到多个输入框，等待恢复后仍无法确定 ChatGPT 消息输入框；本次未提交，请检查专用标签页':
  'ChatGPT 页面加载超时，无法定位消息输入框；本次未提交，请检查专用标签页');
}
async function returnReply(current){
 const reply=current.reply;
 for(let index=current.uploaded||0;index<reply.imageCount;index++){
  const image=await page(current.tabId,'image',{...current,imageIndex:index});
  await uploadAsset(current.id,index,image.base64);
  current.uploaded=index+1;await store(current,'正在回传回复图片');
 }
 await api('/result',{id:current.id,threadId:reply.threadId,segments:reply.segments,probe:reply.probe});
 await store(null,'回复已交给 Koishi 回传 QQ');
 await chrome.tabs.remove(current.tabId).catch(()=>{});
}
async function tick(){
 if(ticking)return;ticking=true;
 let current;
 try{
  const remote=await api('/state');
  const stored=await chrome.storage.local.get(['current','draft','drafts']);
  current=stored.current;
  if(!remote.job){
   // A completed/orphaned task is never resubmitted, even after service restarts.
   if(current?.tabId&&current.sentAt)await page(current.tabId,'stop',current).catch(()=>{});
   await store(null,'已连接本机 Koishi，等待任务');return;
  }
  const task=remote.job;
  if(task.cancelled && (!current || current.id!==task.id)){
   await api('/failure',{id:task.id,message:'任务已取消，未提交网页'});return;
  }
  if(!current || current.id!==task.id){
   if(current?.tabId&&current.sentAt)await page(current.tabId,'stop',current).catch(()=>{});
   const tab=await chrome.tabs.create({url:task.threadId?'https://chatgpt.com/c/'+task.threadId:'https://chatgpt.com/',active:false});
   current={...task,tabId:tab.id,phase:'opening',openedAt:Date.now(),hasImages:!!(task.images&&task.images.length),
    sentText:task.text||'',draft:stored.draft||null,
    drafts:(stored.drafts||[]).filter(entry=>entry.threadId===(task.threadId||'')).map(entry=>entry.text),padded:false};
   await store(current,'正在打开 ChatGPT 标签页');await api('/progress',{id:task.id,phase:'opening'});return;
  }
  if(task.cancelled){
   if(!current.sentAt){await api('/failure',{id:task.id,message:'任务已取消，未提交网页'});await store(null,'任务已取消');return;}
   await page(current.tabId,'stop',current);
   const stopped=await page(current.tabId,'inspect',current);
   if(stopped.stopping){await store(current,'等待网页确认停止');return;}
   await api('/failure',{id:task.id,message:'任务已取消'});await store(null,'任务已取消');return;
  }
  if(current.phase==='returning'){await returnReply(current);return;}
  const info=await page(current.tabId,'inspect',current);
  if(info.loading){
   if(Date.now()-(current.sentAt||current.openedAt)> (current.sentAt?240000:60000))throw Error('ChatGPT 页面加载超时，请检查专用标签页');
   return;
  }
  if(info.login)throw Error('ChatGPT 网页需要登录，请在专用标签页登录');
  if(info.challenge)throw Error('ChatGPT 网页需要人工验证，请完成页面验证后重新发送任务');
  if(current.threadId && info.threadId && current.threadId!==info.threadId)throw Error('ChatGPT 会话不匹配，未执行操作');
  if(current.phase==='opening'){
   if(Date.now()-(current.openingStartedAt||current.openedAt)>90000)throw Error('ChatGPT 页面加载超时，会话未能准备就绪；本次未提交');
   // 续聊时页面必须落到同一个 thread 上。地址被重定向走（会话被删除、链接失效）时
   // info.threadId 会变空，继续等只会一路空耗到桥接超时，所以这里明确失败：桥接收到
   // 这个原因会解绑失效编号，下一条消息自动开一个新会话。
   if(current.threadId && info.threadId!==current.threadId){
    if(Date.now()-current.openedAt>15000)throw Error('ChatGPT 网页会话已不存在或无法打开');
    return;
   }
   if(info.stopping){
    current.busyWaitAt=current.busyWaitAt||Date.now();
    if(Date.now()-current.busyWaitAt>30000)throw Error('该 ChatGPT 会话仍在处理其他请求，本次未提交，请稍后再试');
    await store(current,'原网页会话仍在生成，正在等待空闲');return;
   }
   delete current.busyWaitAt;
   if(info.editorAmbiguous||!info.editor){await waitForComposer(current,info);return;}
   delete current.composerWaitAt;
   if(info.needsChat){await page(current.tabId,'chat',current);return;}
   // 复用已有会话时，历史轮次是页面异步渲染出来的：输入框先出现，历史要几秒后才补齐。
   // 轮次基线必须等历史渲染稳定之后再采样 —— 页面刚打开时计数还是 0，历史一渲染出来
   // 计数就从 0 变成 1，会被读成「本轮回复已经出现」，结果是十几秒就把上一轮的图当成
   // 本轮结果回传（任务 0f24faeed208 / 988bca02fb9f 就是这样，回传的 PNG 与上一轮字节完全相同）。
   // 全新会话页面上本来就没有历史，基线天然是 0，不必付这个等待。
   if(current.threadId){
    const seen=info.assistants+'/'+info.users+(info.userId||info.assistantId?'/'+(info.userId||'')+'/'+(info.assistantId||''):'');
    if(current.historySeen!==seen){
     current.historySeen=seen;current.historyStreak=1;
     await store(current,'正在等待 ChatGPT 载入会话历史');return;
    }
    current.historyStreak=(current.historyStreak||1)+1;
    // 计数连续两次不变才算稳；再叠一个时间下限。页面上一个 assistant 轮次都没有时
    // （可能是真没回复过，也可能只是还没渲染出来）给更长的耐心，宁可多等几秒，
    // 也不能把「历史还没出来」当成「这个会话本来就是空的」。
    if(current.historyStreak<2)return;
    if(Date.now()-current.openedAt<(info.assistants?8000:15000))return;
   }
   current.baseline=info.assistants;
   current.assistantId=info.assistantId;
   // Count the user's turns before submitting: the new turn is what proves the
   // message actually landed, and it does so without a marker in the prompt.
   current.userBaseline=info.users;current.userId=info.userId||'';current.userText=info.userText;
   if(current.hasImages){current.phase='attaching';await store(current,'正在上传参考图片到 ChatGPT');return;}
   current.phase='filling';await store(current,'正在填写消息');
  }
  if(['attaching','filling','filled'].includes(current.phase)&&(info.editorAmbiguous||!info.editor)){
   current.composerWaitAt=current.composerWaitAt||Date.now();
   if(Date.now()-current.composerWaitAt>15000)throw Error('消息输入框在准备过程中发生变化，未重复上传或提交；请检查专用标签页');
   await store(current,'正在等待原消息输入框恢复');return;
  }
  delete current.composerWaitAt;
  if(current.phase==='attaching'){
   if(current.attachSent && info.attachments>=current.images.length && !info.uploading){current.phase='filling';await store(current,'参考图片已上传，正在填写消息');}
   else {
    // Upload exactly once. If it cannot be confirmed we fail closed rather than
    // submitting a text-only request that would silently drop the reference image.
    if(current.attachSent){
     if(Date.now()-current.attachAt>45000)throw Error('参考图片上传超时，未提交请求；请检查专用标签页');
     return;
    }
    if(Date.now()-current.openedAt>90000)throw Error('参考图片上传超时，未提交请求');
    const images=await loadInputs(task);
    current.attachSent=true;current.attachAt=Date.now();
    await store(current,'参考图片已提交上传，等待 ChatGPT 处理');
    await page(current.tabId,'attach',{...current,images});
    return;
   }
  }
  if(current.phase==='filling'){
   // A pure-image message is submitted with an empty body first. Only if the send
   // button refuses to unlock does one space get added — never a marker, and never
   // an instruction the user did not write.
   const message=current.padded?' ':(current.sentText||'');
   // Check ownership before recording intent: recording arbitrary existing text
   // would incorrectly authorise overwriting a user's draft on the next retry.
   const prepared=await page(current.tabId,'prepare',{...current,message});
   if(!prepared.prepared && !prepared.alreadySent)throw Error('无法检查 ChatGPT 输入框');
   if(!prepared.alreadySent){
    const threadId=current.threadId||'';
    const drafts=(stored.drafts||[]).filter(entry=>entry.threadId!==threadId||entry.text!==message);
    if(message.trim())drafts.push({threadId,text:message});
    current.drafts=[...(current.drafts||[]),message].slice(-32);
    // Persist before touching the DOM, including current for worker restarts.
    // Keep a bounded history after successful sends: ChatGPT may restore an old
    // draft later, after a different conversation has replaced the legacy slot.
    await chrome.storage.local.set({current,draft:message||null,drafts:drafts.slice(-32)});
   }
   const filled=await page(current.tabId,'submit',{...current,message});
   if(!filled.filled && !filled.alreadySent)throw Error('无法填写 ChatGPT 输入框');
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
   // 草稿留到「确认消息真的落到页面上」之后再清（见下面的 sending 分支）：点击发送
   // 不等于提交成功。提前清掉，输入框里残留的文本就变成认不出的东西，下一个任务只会
   // 报「输入框已有内容」——线上就是这么连环失败两次的。
   current.phase='waiting';await store(current,'ChatGPT 正在生成回复');return;
  }
  if(current.phase==='sending'){
   if(!info.submitted){if(Date.now()-current.sentAt>15000)throw Error('网页提交状态不明确，未自动重复发送，请检查专用标签页');return;}
   await saveDraft(null);
   current.phase='waiting';await store(current,'ChatGPT 正在生成回复');
  }
  if(info.userChanged)throw Error('网页出现其他用户轮次，为避免回传错误回复，已停止读取本轮');
  if(!info.submitted){if(Date.now()-current.sentAt>20000)throw Error('消息未出现在专用标签页上，未取得本轮回复');return;}
  await saveDraft(null);
  if(!current.submittedConfirmed){
   current.submittedConfirmed=true;current.submittedUserId=info.userId||'';current.submittedUserText=info.userText;
   await store(current,'本轮消息已确认，正在等待回复');
  }
  if(info.threadId){
   await api('/progress',{id:task.id,threadId:info.threadId,phase:'submitted',evidence:{
    workerVersion:chrome.runtime.getManifest?.().version||'development',userId:info.userId||'',
    userBaseline:current.userBaseline,users:info.users,assistantBaseline:current.baseline,assistants:info.assistants,
    assistantId:info.assistantId||'',replyBlocks:info.replyBlocks,replyBounded:info.replyBounded,
   }});
   if(!current.threadId){current.threadId=info.threadId;await store(current,'已绑定本轮 ChatGPT 网页会话');}
  }
  const waited=Date.now()-current.sentAt;
  const newAssistant=current.assistantId && info.assistantId && current.assistantId!==info.assistantId;
  const boundedReply=current.submittedConfirmed&&info.replyBounded&&info.replyBlocks>0;
  if((info.assistants<=current.baseline && !newAssistant&&!boundedReply) || info.stopping){
   if(waited>240000)throw Object.assign(Error('等待网页回复超时，生成未结束或尚未出现本轮回复'),{probe:info.probe});
   return;
  }
  // 双重确认：最新 assistant 轮次必须不是提交前那一条。计数只说明「轮次变多了」，
  // 说明不了「多出来的是我这一轮」；message id 直接回答这个问题。读不到属性时
  // assistantId 是空串，这条自动跳过，退回纯计数判定。
  if(!boundedReply&&current.assistantId && info.assistantId===current.assistantId){
   if(waited>240000)throw Object.assign(Error('等待网页回复超时，尚未出现本轮回复'),{probe:info.probe});
   return;
  }
  // ChatGPT renders the empty assistant turn long before the answer exists, and a
  // text answer can stream for minutes. Silence is not a finished answer: only a
  // stable reply on a page that is no longer busy counts as done.
  if(waited<1500)return;
  const busy=info.stopping||/正在生成|生成中|正在创建|正在思考|正在调用|Generating|Thinking|Creating image/i.test(info.busyText);
  // 「没有任何可读内容」和「图还在画」都算没完成。ChatGPT 会先渲染一个空的
  // assistant 轮次（只有无障碍标题），图片要几十秒后才出现；在这里提前收工，
  // 后面的 chrome.tabs.remove 会把还在生成的图片一起关掉。
  const empty=!info.replyLength && !info.images;
  const pendingImage=info.imageLoading || info.pendingGallery || (info.gallery && !info.images);
  // The hard cap rejects only a reply that still has no usable content. A complete
  // image or text can become visible on the boundary tick; throwing before this
  // check discarded that valid result (job d4a2a235d1c0). At the cap, stale busy
  // wording is ignored and the normal signature-stability check decides instead.
  if(waited>240000 && (empty||pendingImage))throw Object.assign(
   Error(info.gallery&&!info.images?'等待网页出图超时，未检测到本轮图片':'等待网页回复超时，未读取到内容'),
   {probe:info.probe});
  if((busy&&waited<=240000)||empty||pendingImage){current.stableAt=Date.now();await store(current,'ChatGPT 正在生成回复');return;}
  if(current.lastSignature!==info.replySignature){current.lastSignature=info.replySignature;current.stableAt=Date.now();await store(current,'正在等待网页回复结束');return;}
  if(Date.now()-current.stableAt<3000)return;
  await api('/progress',{id:task.id,threadId:info.threadId,phase:'reading'});
  const reply=await page(current.tabId,'read',current);
  if(!reply.segments||!reply.segments.length)throw Object.assign(Error('网页已结束回答，但没有读取到可回传的内容'),{probe:reply.probe});
  current.phase='returning';current.reply={...reply,threadId:reply.threadId||info.threadId};
  await store(current,'回复已读取，正在回传');
  await returnReply(current);
 }catch(err){
  const message=String(err.message||err).slice(0,1800);
  if(err.retryable){
   await chrome.storage.local.set({status:'本机连接暂时中断，保留任务等待恢复：'+message});return;
  }
  if(current?.id){
   // Early upload/submission failures also need evidence; the 90-second reply
   // probe cannot capture these. A diagnostic failure must preserve the error.
   if(!err.probe)err.probe=await page(current.tabId,'probe',current).catch(()=>undefined);
   try{
    await chrome.storage.local.set({lastFailure:{id:current.id,tabId:current.tabId,threadId:current.threadId||'',phase:current.phase,
     recoveryCount:current.recoveryCount||0,message,at:Date.now()}});
    await api('/failure',{id:current.id,message,probe:err.probe});await store(null,'任务失败：'+message);
   }catch{await chrome.storage.local.set({status:'本机连接中断，未重发网页请求'});}
  }else await chrome.storage.local.set({status:'等待本机 Koishi 连接：'+message});
 }finally{ticking=false;}
}
chrome.alarms.create('poll',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>void tick());
chrome.runtime.onStartup.addListener(()=>void tick());
chrome.runtime.onInstalled.addListener(()=>void tick());
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message.type==='status'){tick().then(()=>chrome.storage.local.get(['status','lastFailure']))
  .then(data=>reply({status:data.status||'等待连接',lastFailure:data.lastFailure||null}))
  .catch(()=>reply({status:'无法读取连接状态，请检查扩展错误'}));return true;}
});
setInterval(()=>void tick(),2000);void tick();
