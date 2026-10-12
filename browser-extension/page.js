// Standalone page function: Chrome serializes it for injection, so all DOM helpers stay inside.
async function pageStep(operation,job){
 try {
 const buttons=()=>Array.from(document.querySelectorAll('button'));
 const byLabel=labels=>buttons().find(b=>labels.includes(b.getAttribute('aria-label')||'') || labels.includes(b.innerText.trim()));
 const roles=role=>{
  // An image-only user message has no text bubble. Include its bounded search
  // unit in DOM order, deduplicating wrappers and nested text/role anchors.
  if(role==='user'){
   const nodes=Array.from(document.querySelectorAll('[data-user-message-bubble], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"], [data-message-author-role="user"], [data-conversation-role="user"]'));
   return nodes.filter(node=>!nodes.some(parent=>parent!==node&&parent.contains?.(node)));
  }
  const primary=Array.from(document.querySelectorAll(`[data-conversation-role="${role}"]`));
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
 const stopLabels=['停止','Stop','停止生成','Stop generating'];
 const isStop=button=>visible(button)&&(stopLabels.includes(button.getAttribute('aria-label')||'')||stopLabels.includes(button.innerText.trim())||button.getAttribute('data-testid')==='stop-button');
 const isControl=button=>isSend(button)||isStop(button);
 const composerSelector='[data-testid*="composer" i], [id="composer-background"], [data-type="unified-composer"]';
 const scopeOf=node=>{
  const form=node.closest?.('form');
  if(form&&!form.querySelector?.(historySelector)&&editors.filter(candidate=>form.contains(candidate)).length===1
   &&Array.from(form.querySelectorAll?.('button')||[]).some(isControl))return form;
  const explicit=node.closest?.(composerSelector);
  if(explicit&&Array.from(explicit.querySelectorAll?.('button')||[]).some(isControl))return explicit;
  let parent=node.parentElement;
  for(let depth=0;parent&&depth<8;depth++,parent=parent.parentElement){
   if(['BODY','MAIN','HTML'].includes(parent.tagName))break;
   // Do not associate a button across a wrapper that also contains another
   // editor or message history; that recreates the original global-selector bug.
   if(parent.querySelector?.(historySelector))break;
   if(editors.filter(candidate=>parent.contains(candidate)).length!==1)break;
   if(Array.from(parent.querySelectorAll?.('button')||[]).some(isControl))return parent;
  }
  const fallback=explicit||form||node.parentElement;
  return fallback&&!['BODY','MAIN','HTML'].includes(fallback.tagName)?fallback:null;
 };
 const score=node=>node.getAttribute('id')==='prompt-textarea'?3:
  node.closest?.(composerSelector)?2:
  Array.from(scopeOf(node)?.querySelectorAll?.('button')||[]).some(isControl)?1:0;
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
 // A hidden historical button (or another tool's Stop) is not evidence that
 // this reply is streaming. Use the same composer boundary as Send/cancel.
 const stopCandidates=buttons().filter(button=>isStop(button)
  &&!button.closest?.(historySelector+', nav, aside, header, [role="dialog"]'));
 const scopedStops=stopCandidates.filter(button=>composer?composer.contains(button):button.closest?.('form, '+composerSelector));
 const stop=scopedStops[0]||(!composer&&stopCandidates.length===1?stopCandidates[0]:null);
 const match=location.pathname.match(/^\/c\/([a-f0-9-]{36})$/);
 const threadId=match?.[1]||'';
 if(['reasoning','attach','prepare','submit','send','read','image','stop'].includes(operation) && job.threadId && job.threadId!==threadId)
  throw Error('网页会话与任务不一致');
 if(operation==='reasoning'){
  const levels=['instant','medium','high','xhigh','pro'];
  const target=job.reasoningEffort;
  if(!target||target==='default')return {applied:true};
  if(!levels.includes(target))throw Error('推理程度参数无效；本次未提交');
  const behindMenu=node=>node.getAttribute('aria-expanded')==='true'&&!node.closest?.('[hidden], [inert]')
   &&(typeof node.getClientRects!=='function'||node.getClientRects().length>0)
   &&(typeof getComputedStyle!=='function'||!['hidden','collapse'].includes(getComputedStyle(node).visibility)&&getComputedStyle(node).display!=='none');
  const triggers=buttons().filter(b=>(visible(b)||behindMenu(b))&&!b.closest?.(historySelector+', nav, aside')
   &&(b.getAttribute('data-codex-intelligence-trigger')==='true'
    ||b.getAttribute('data-composer-navigation-target')==='reasoning'
    ||['选择 ChatGPT 模型','Select ChatGPT model'].includes(b.getAttribute('aria-label'))));
  if(triggers.length!==1)throw Error('无法定位网页推理程度菜单，请检查 ChatGPT 模型选择器；本次未提交');
  const trigger=triggers[0];
  if(trigger.disabled||trigger.getAttribute('aria-disabled')==='true')throw Error('网页推理程度菜单不可用；本次未提交');
  if(trigger.getAttribute('aria-expanded')!=='true'){
   if(!editor||candidates.length>1||stop||unknownDrafts)throw Error('网页尚未就绪，无法切换推理程度；本次未提交');
   trigger.click();return {pending:true};
  }
  // The menu is portaled outside the composer. Associate it with this trigger,
  // never with a similarly named control in a reply, sidebar or another tool.
  const triggerId=trigger.getAttribute('id'),menuId=trigger.getAttribute('aria-controls');
  const menus=Array.from(document.querySelectorAll('[role="menu"]')).filter(n=>visible(n)
   &&((triggerId&&n.getAttribute('aria-labelledby')===triggerId)
    ||(menuId&&n.getAttribute('id')===menuId)));
  if(menus.length!==1)return {pending:true};
  const controls=Array.from(menus[0].querySelectorAll('[data-reasoning-slider]')).filter(visible);
  if(controls.length!==1)throw Error('网页未提供可识别的推理程度滑块；本次未提交');
  const control=controls[0],slider=control.querySelector('[role="slider"]');
  // The slider thumb is intentionally aria-hidden; its enclosing menuitem is
  // the keyboard target, and aria-describedby announces the selected level.
  const descriptions=(control.getAttribute('aria-describedby')||'').split(/\s+/)
   .map(id=>Array.from(document.querySelectorAll('[id]')).find(n=>n.getAttribute('id')===id)?.textContent||'');
  const aliases={instant:'instant','即时':'instant','立即':'instant',medium:'medium','中':'medium','中等':'medium',
   standard:'medium','标准':'medium',high:'high','高':'high',extended:'high','扩展':'high',
   'extra high':'xhigh',xhigh:'xhigh','超高':'xhigh','极高':'xhigh',heavy:'xhigh',pro:'pro'};
  const selected=descriptions.map(text=>aliases[text.split(/[,，。]/)[0].trim().toLowerCase()]).find(Boolean);
  const value=Number(slider?.getAttribute('aria-valuenow')),
   min=Number(slider?.getAttribute('aria-valuemin')),max=Number(slider?.getAttribute('aria-valuemax'));
  if(!slider||!selected||!['aria-valuenow','aria-valuemin','aria-valuemax'].every(attr=>/^\d+$/.test(slider.getAttribute(attr)||''))
   ||![value,min,max].every(Number.isInteger)||min>value||value>max||max-min>8)
   throw Error('无法确认网页当前推理程度；本次未提交');
  // Closing the menu can discard a preview or reveal a late account setting.
  // Reopen and read it back on later worker ticks before allowing a submission.
  if(job.reasoningVerify&&selected!==target)
   throw Error('网页推理程度在关闭菜单后发生变化；本次未提交');
  if(selected===target){
   trigger.click();
   return job.reasoningVerify?{applied:true,level:selected}:{pending:true,verify:true};
  }
  const direction=levels.indexOf(target)<levels.indexOf(selected)?-1:1;
  if((direction<0&&value===min)||(direction>0&&value===max))
   throw Error('当前账号或模型不支持推理程度 '+target+'；请用 /reasoning 选择其他程度；本次未提交');
  const key=direction<0?'ArrowLeft':'ArrowRight';
  control.focus();
  control.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,bubbles:true,cancelable:true}));
  control.dispatchEvent(new KeyboardEvent('keyup',{key,code:key,bubbles:true}));
  // Read back on the next polling turn, after React commits the selection.
  return {pending:true,selected};
 }
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
// Generated files can be anchors, or the new renderer's span[role=link]
// without an href. Only raster files inside this reply are eligible.
const referencedFiles=new Set();
const fileInfo=(node,allowHistory=false)=>{
 const historical=allowHistory===true,referenced=referencedFiles.has(node);
 if(!node||!visible(node)||insideUser(node))return null;
 if(!inReplyTurn(node)&&!referenced&&!historical)return null;
 if(historical&&!assistant.some(anchor=>turn(anchor)?.contains?.(node)))return null;
 if(userAnchor&&!after(node,userAnchor)&&!referenced&&!historical)return null;
 const tag=node.tagName,role=node.getAttribute?.('role');
 if(tag!=='A'&&role!=='link'&&tag!=='BUTTON')return null;
 const label=String(node.getAttribute?.('aria-label')||'');
 if(tag==='BUTTON'&&!/预览|preview/i.test(label))return null;
 const href=String(node.getAttribute?.('href')||'');
 const text=String(node.getAttribute?.('download')||node.textContent||label).trim();
 const name=(text.match(/[^\s/\\<>:"?*|]+\.(?:gif|png|jpe?g|webp)\b/i)||label.match(/[^\s/\\<>:"?*|]+\.(?:gif|png|jpe?g|webp)\b/i)||[])[0];
 let url;
 try{url=new URL(href,location.href);}catch{}
 const rasterPath=url&&/\.(gif|png|jpe?g|webp)$/i.test(url.pathname);
 const generated=href.startsWith('sandbox:/mnt/data/')||/^(?:blob:|data:image\/)/i.test(href)
  ||(url?.origin==='https://chatgpt.com'&&/^\/backend-api\/(?:files|estuary|conversation)\//.test(url.pathname));
 // External links stay prose. This also prevents fetching model-supplied URLs
 // to local services or handing a remote page the user's ChatGPT credentials.
 if(href&&!generated)return null;
 if(!name&&!rasterPath)return null;
 const filename=name||decodeURIComponent(url.pathname.split('/').at(-1));
 return {name:filename,href,key:(messageId(node)||assistantId||'')+'/'+filename};
};
// The live resource row has a transparent preview button and separate filename,
// type and Download labels. Treat that entire row as one media item.
const fileCard=node=>String(node.getAttribute?.('class')||'').split(/\s+/).includes('group/resource-row')
 &&Array.from(node.children||[]).find(child=>child.tagName==='BUTTON'&&fileInfo(child));
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
 .flatMap((row,index)=>{
  const cells=Array.from(row.children||[]);
  const line='| '+cells.map(cell=>inlineText(cell).trim().replace(/\n/g,' ').replace(/\|/g,'\\|')).join(' | ')+' |';
  return index===0&&cells.some(cell=>cell.tagName==='TH')?[line,'| '+cells.map(()=>'---').join(' | ')+' |']:[line];
 }).join('\n');
// DOM → ordered segments. Images appear in document order, which is the order
// they are read in and therefore the order they must be sent back to QQ in.
const serializeReply=()=>{
 const segments=[],images=[],fileKeys=new Set();
 const pushFile=node=>{
  const info=fileInfo(node);if(!info)return false;
  if(!fileKeys.has(info.key)){
   fileKeys.add(info.key);segments.push({type:'image',asset:images.length});images.push(node);
  }
  return true;
 };
 const pushImage=img=>{
  if((userAnchor&&!after(img,userAnchor))||!looksGenerated(img)||inUserTurn(img)||insideUser(img)||images.includes(img))return;
  segments.push({type:'image',asset:images.length,mime:'image/png'});
  images.push(img);
 };
 const pushCode=(pre,owner=pre.closest?.('[data-markdown-copy="code-block"]'))=>{
  const code=pre.querySelector?.('code')||pre;
  let language=(/language-([\w+#.-]+)/.exec(String(code.getAttribute?.('class')||''))||[])[1]
   ||code.getAttribute?.('data-language')||pre.getAttribute?.('data-language')||'';
  if(!language&&owner){
   const header=owner.querySelector?.('[data-markdown-copy="exclude"]');
   language=Array.from(header?.children||[]).filter(node=>node.tagName!=='SVG'&&node.tagName!=='BUTTON'&&!node.querySelector?.('button'))
    .map(node=>String(node.textContent||'').trim()).find(text=>/^[\w+#.-]{1,32}$/.test(text))?.toLowerCase()||'';
  }
  const text=String(code.innerText||code.textContent||'').replace(/\n+$/,'');
  if(text.trim())segments.push({type:'code',language,text});
 };
 const inlineSegments=(node,prefix='')=>{
  let text=prefix;
  const flush=()=>{if(text.trim())segments.push({type:'text',text:text.trim()});text='';};
  const visit=parent=>{
   for(const child of parent.childNodes||[]){
    if(child.nodeType===3){text+=child.nodeValue;continue;}
    if(child.nodeType!==1)continue;
    const card=fileCard(child);if(card){flush();pushFile(card);continue;}
    if(fileInfo(child)){flush();pushFile(child);continue;}
    if(child.tagName==='IMG'){flush();pushImage(child);continue;}
    if(child.tagName==='BUTTON'){
     flush();for(const img of Array.from(child.querySelectorAll?.('img')||[]))pushImage(img);continue;
    }
    if(['SVG','STYLE','SCRIPT'].includes(child.tagName)||child.closest?.('[hidden], [aria-hidden="true"], nav, aside, form'))continue;
    if(['A','CODE','BR'].includes(child.tagName))text+=inlineText({childNodes:[child]});
    else visit(child);
   }
  };
  visit(node);flush();
 };
 const walk=node=>{
  let direct='';
  const flush=()=>{if(direct.trim())segments.push({type:'text',text:direct.trim()});direct='';};
  for(const child of node.childNodes||[]){
   if(child.nodeType===3){direct+=child.nodeValue;continue;}
   if(child.nodeType!==1)continue;
   flush();
   const tag=child.tagName;
   if(userAnchor&&ends.has(child)&&ends.get(child)<order.get(userAnchor))continue;
   if(child.getAttribute?.('data-user-message-bubble')!==null&&child.getAttribute?.('data-user-message-bubble')!==undefined)continue;
   if(child.getAttribute?.('data-message-author-role')==='user')continue;
   if(child.closest?.('[hidden], [aria-hidden="true"], nav, aside, form'))continue;
   const card=fileCard(child);if(card){pushFile(card);continue;}
   if(pushFile(child))continue;
   // Generated-image previews are interactive BUTTONs. Ignore their control text,
   // but keep any valid image nested inside; otherwise the real ChatGPT gallery
   // shape produces picked=true in the probe while serializeReply() returns zero.
   if(tag==='BUTTON'){
    for(const img of Array.from(child.querySelectorAll?.('img')||[]))pushImage(img);
    continue;
   }
   if(tag==='SVG'||tag==='STYLE'||tag==='SCRIPT')continue;
   if(child.getAttribute?.('data-markdown-copy')==='exclude')continue;
   if(child.getAttribute?.('data-markdown-copy')==='code-block'){
    const pre=child.querySelector?.('pre');
    if(pre){pushCode(pre,child);continue;}
   }
   // 「ChatGPT 说：」这类无障碍标题是页面框架，不是回复内容。轮次容器把标题和
   // 正文放在一起，少了这道过滤，一个还没出图的空轮次也会被读成一条回复。
   if(child.getAttribute?.('data-conversation-role')||(/^H[1-6]$/.test(tag)&&child.getAttribute?.('data-message-author-role')))continue;
   if(tag==='IMG'){pushImage(child);continue;}
   if(tag==='PRE'){
    pushCode(child);
    continue;
   }
   if(tag==='TABLE'){const text=tableText(child);if(text.trim())segments.push({type:'text',text});continue;}
   if(tag==='HR'){segments.push({type:'text',text:'---'});continue;}
   if(tag==='UL'||tag==='OL'){
    let index=1;
    for(const item of child.children||[]){
     if(item.tagName!=='LI')continue;
     if(Array.from(item.querySelectorAll('a, [role="link"], button')).some(fileInfo)){
      inlineSegments(item,tag==='OL'?(index++)+'. ':'- ');continue;
     }
     const text=inlineText(item).trim();
     if(text)segments.push({type:'text',text:(tag==='OL'?(index++)+'. ':'- ')+text.replace(/\n/g,'\n  ')});
    }
    continue;
   }
   if(/^H[1-6]$/.test(tag)){const text=inlineText(child).trim();if(text)segments.push({type:'text',text:'#'.repeat(Number(tag[1]))+' '+text});continue;}
   if(tag==='BLOCKQUOTE'){const text=inlineText(child).trim();if(text)segments.push({type:'text',text:text.split('\n').map(line=>'> '+line).join('\n')});continue;}
   const hasBlock=Array.from(child.children||[]).some(node=>BLOCKS.has(node.tagName));
   if(!hasBlock){
    inlineSegments(child);
    continue;
   }
   walk(child);
  }
  flush();
 };
 for(const root of replyRoots){
  const rootHasBlock=Array.from(root.children||[]).some(node=>BLOCKS.has(node.tagName));
  if(rootHasBlock)walk(root);
  else{
   inlineSegments(root);
  }
 }
 // A follow-up can return only a sandbox path to an already generated file.
 // Resolve that explicit reference against assistant file controls in this
 // conversation, never arbitrary historical images or local filesystem paths.
 for(let i=0;i<segments.length;i++){
  const segment=segments[i];
  if(segment.type!=='text')continue;
  const match=/^(?:sandbox:)?\/mnt\/data\/([^/\\\r\n]+\.(?:gif|png|jpe?g|webp))$/i.exec(segment.text.trim());
  if(!match)continue;
  const historyMatches=new Map(),currentMatches=new Map();
  for(const node of Array.from(document.querySelectorAll('a, [role="link"], button'))){
   const info=fileInfo(node,true);
   if(!info||info.name!==match[1])continue;
   const matches=inReplyTurn(node)?currentMatches:historyMatches;
   const existing=matches.get(info.key);
   if(!existing||node.tagName==='BUTTON')matches.set(info.key,node);
  }
  const matches=currentMatches.size?currentMatches:historyMatches;
  if(matches.size!==1)throw Error(matches.size?'回复文件存在同名版本，无法确定本轮引用，请要求 ChatGPT 重新提供文件附件':
   '网页仅回复文件路径，未找到对应的文件附件，请要求 ChatGPT 重新提供下载链接或文件卡片');
  const node=[...matches.values()][0];referencedFiles.add(node);
  const key=fileInfo(node).key;
  let asset=images.findIndex(image=>fileInfo(image)?.key===key);
  if(asset>=0&&segments.some(s=>s.type==='image'&&s.asset===asset)){segments.splice(i--,1);continue;}
  if(asset<0){asset=images.length;images.push(node);}
  segments[i]={type:'image',asset};
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
 const imageLoading=images.some(image=>image.tagName==='IMG'&&(image.complete===false||!(Number(image.naturalWidth)>0)));
 const mediaKey=node=>fileInfo(node)?.key||source(node);
 // 画廊已经出现但还没有可用图片，说明图正在画。
 const galleries=[...new Set(replyRoots.flatMap(root=>[
  ...(root.getAttribute?.('data-testid')?.includes('generated-image-gallery')?[root]:[]),
  ...Array.from(root.querySelectorAll?.('[data-testid*="generated-image-gallery" i]')||[]),
 ]))].filter(visible);
 const gallery=galleries.length>0;
 const pendingGallery=galleries.some(root=>!Array.from(root.querySelectorAll('img')).some(img=>images.includes(img)&&img.complete!==false));
 const checksum=value=>{let hash=0;for(let i=0;i<value.length;i++)hash=(hash*31+value.charCodeAt(i))|0;return hash;};
 // Read status widgets, never answer prose: a completed explanation of
 // "Generating" must not hold the reply for four minutes.
 const busyText=replyRoots.flatMap(root=>Array.from(root.querySelectorAll?.('[role="status"], [role="progressbar"], [aria-busy="true"], [data-testid*="thinking" i], [data-testid*="loading" i]')||[]))
  .filter(node=>visible(node)&&!node.closest?.('.markdown, pre, code'))
  .map(node=>String(node.innerText||'').trim()).filter(text=>text.length<=120).join('\n');
 const snapshot={url:location.href,threadId,users:user.length,assistants:assistant.length,submitted,
  textMatched:sameText(job.sentText,userText),userText,userId,userChanged,replyBlocks:replyRoots.length,replyBounded:!!userAnchor,
  editor:!!editor,editorAmbiguous:candidates.length>1,editorSelection:best,unknownDrafts,recoverySafe,stopping:!!stop,images:images.length,imageLoading,gallery,pendingGallery,attachments:attachments.length,uploading,
  replyLength,assistantId,replySignature:checksum(answerText)+'/'+replyLength+'/'+images.length+'/'+checksum(images.map(mediaKey).join('|')),
  busyText,
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
  if(unknownDrafts||attachments.length||uploading)throw Error('专用标签页已有草稿或附件，未上传参考图片');
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
  const requiresPreview=images.some(node=>{const file=fileInfo(node);return file&&(!file.href||file.href.startsWith('sandbox:'));});
  return {threadId,segments,imageCount:images.length,requiresPreview,assetKeys:images.map(mediaKey),probe:probeDom()};
 }
 if(operation==='image'){
  const index=Number(job.imageIndex)||0;
  let img=images[index];
  if(!img)throw Error('回复中的图片不存在');
  if(job.reply?.assetKeys&&job.reply.assetKeys[index]!==mediaKey(img))throw Error('回复文件发生变化，未回传其他文件');
  const limit=20*1024*1024;
  const readImage=async url=>{
   let target;try{target=new URL(url,location.href);}catch{throw Error('回复文件地址无效');}
   if(!['https:','blob:','data:'].includes(target.protocol)
    ||(target.protocol==='https:'&&target.origin!=='https://chatgpt.com')
    ||(target.protocol==='blob:'&&!url.startsWith('blob:https://chatgpt.com/'))
    ||(target.protocol==='data:'&&!/^data:image\//i.test(url)))throw Error('回复文件地址不受支持');
   const response=await fetch(target.href,{credentials:target.origin==='https://chatgpt.com'?'same-origin':'omit',signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw Error('回复文件下载失败（HTTP '+response.status+'）');
   if(Number(response.headers?.get('Content-Length'))>limit)throw Error('回复文件超过 20 MB 上限');
   const chunks=[];let size=0;
   if(response.body?.getReader){
    const reader=response.body.getReader();
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('回复文件超过 20 MB 上限');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
   }else{const value=new Uint8Array(await response.arrayBuffer());size=value.length;chunks.push(value);}
   if(size<32||size>limit)throw Error('回复文件大小异常');
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const head=String.fromCharCode(...bytes.subarray(0,12));
   const mime=/^GIF8[79]a/.test(head)?'image/gif':bytes[0]===0x89&&head.slice(1,4)==='PNG'?'image/png':
    bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff?'image/jpeg':head.startsWith('RIFF')&&head.slice(8,12)==='WEBP'?'image/webp':'';
   if(!mime)throw Error('回复文件不是有效的 GIF、PNG、JPEG 或 WebP 图片');
   let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
   return {base64:btoa(binary),mime};
  };
  const file=fileInfo(img);
  if(file){
   // New file controls open the site's own viewer, whose img carries the raw
   // data/blob bytes. Do not flatten an animation through canvas.
   if(file.href&&!file.href.startsWith('sandbox:'))return await readImage(file.href);
   const previews=()=>Array.from(document.querySelectorAll('img[alt="图片预览"], img[alt="Image preview"]')).filter(visible);
   if(previews().length)throw Error('网页已有文件预览，未读取不属于本任务的文件');
   const previewButton=replyRoots.flatMap(root=>Array.from(root.querySelectorAll('button')))
    .find(node=>fileInfo(node)?.key===file.key);
   (previewButton||img).click();
   const started=Date.now();let preview;
   try{
    while(Date.now()-started<15000){
     preview=previews().find(node=>node.complete!==false&&source(node));
     if(preview)break;
     await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!preview)throw Error('回复文件预览未加载，无法读取原始文件');
    const latest=roles('user').at(-1);
    if(latest!==userAnchor&&messageId(latest)!==userId)throw Error('网页出现其他用户轮次，未读取不属于本任务的文件');
    return await readImage(source(preview));
   }finally{
    const close=buttons().find(node=>visible(node)&&['关闭查看器','Close viewer'].includes(node.getAttribute('aria-label')));
    if(close){
     close.click();
     const closedAt=Date.now();
     while(previews().length&&Date.now()-closedAt<2000)await new Promise(resolve=>setTimeout(resolve,100));
    }
   }
  }
  if(img.naturalWidth*img.naturalHeight>32*1024*1024)throw Error('图片尺寸超过上限');
  const explicitGif=/(?:\.gif(?:[?#]|$)|^data:image\/gif[;,])/i.test(source(img));
  try{return await readImage(source(img));}
  catch(err){
   // Keep the established canvas fallback for ordinary cross-origin previews.
   // Explicit GIFs and size-limit failures must not be flattened or bypassed.
   if(explicitGif||/20 MB|大小异常/.test(err.message))throw err;
  }
  const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  canvas.getContext('2d').drawImage(img,0,0);
  return {base64:canvas.toDataURL('image/png').split(',')[1]};
 }
 throw Error('unknown operation');
 }catch(err){return {error:String(err.message||err)};}
}
