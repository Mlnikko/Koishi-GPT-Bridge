// Task orchestration; DOM operations and HTTP transport are loaded separately.
importScripts('page.js', 'bridge-client.js');
// config.js contains a machine-local token and is absent from fresh checkouts.
// Keep the worker and popup usable so setup errors do not prevent registration.
let bridgeConfig,configurationError;
try{
 importScripts('config.js');
 bridgeConfig=BRIDGE;
}catch{
 configurationError='无法加载 config.js，请在项目目录运行 node scripts/setup-web-bridge.cjs，再重新加载扩展。';
}
if(!configurationError){
 const match=/^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(bridgeConfig?.url||'');
 if(!match || Number(match[1])<1 || Number(match[1])>65535 || typeof bridgeConfig?.token!=='string' || !bridgeConfig.token.trim())
  configurationError='config.js 的本机地址或令牌无效，请重新运行 node scripts/setup-web-bridge.cjs，再重新加载扩展。';
}
let ticking=false;
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
function timings(current){
 return current.timing||(current.timing={openedAt:current.openedAt,sentAt:current.sentAt});
}
// Keep one bounded snapshot, including across worker restarts. These timestamps
// distinguish a visible-but-still-streaming answer from polling/upload delays.
function observeReply(current,info,{ownsReply,busy,empty,pendingImage,waited}){
 const now=Date.now(),timing=timings(current);
 timing.sentAt=current.sentAt;timing.submittedAt=timing.submittedAt||now;
 timing.maxPollGapMs=Math.max(timing.maxPollGapMs||0,timing.lastObservedAt?now-timing.lastObservedAt:0);
 timing.lastObservedAt=now;
 if(ownsReply&&info.replyLength)timing.firstTextAt=timing.firstTextAt||now;
 if(ownsReply&&info.images&&!info.imageLoading)timing.firstImageAt=timing.firstImageAt||now;
 timing.waitReason=info.stopping?'generating':!ownsReply?'reply-missing':pendingImage?'image-loading':
  empty?'content-empty':busy&&waited<=240000?'busy-status':'settling';
 timing.state={stopping:!!info.stopping,busyStatus:busy,replyLength:info.replyLength||0,images:info.images||0,
  imageLoading:!!info.imageLoading,pendingGallery:!!info.pendingGallery};
 if(timing.waitReason==='settling')timing.firstIdleAt=timing.firstIdleAt||now;
}
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
  delete current.reasoningApplied;delete current.reasoningAttempts;delete current.reasoningVerify;
  delete current.reasoningFallback;
  delete current.skillApplied;delete current.skillAttempts;delete current.skillQuery;delete current.skillQueryWritten;
  delete current.skillInputMethod;
  await restoreSkillFocus(current);
  await store(current,'输入框未就绪，正在重新加载原网页会话（仅一次）');
  await chrome.tabs.reload(current.tabId);return;
 }
 throw Error(info.editorAmbiguous?'检测到多个输入框，等待恢复后仍无法确定 ChatGPT 消息输入框；本次未提交，请检查专用标签页':
  'ChatGPT 页面加载超时，无法定位消息输入框；本次未提交，请检查专用标签页');
}
async function returnReply(current){
 const reply=current.reply,timing=timings(current);
 let previousTab;
 // File viewers can defer loading in an inactive tab, and Chrome throttles
 // their timers. Activate only while retrieving preview-backed files.
 if(reply.requiresPreview&&(current.uploaded||0)<reply.imageCount){
  const tab=await chrome.tabs.get(current.tabId);
  [previousTab]=await chrome.tabs.query({active:true,windowId:tab.windowId});
  await chrome.tabs.update(current.tabId,{active:true});
 }
 try{
 timing.returnStartedAt=timing.returnStartedAt||Date.now();
 for(let index=current.uploaded||0;index<reply.imageCount;index++){
  const upload=(timing.uploads||(timing.uploads=[]))[index]||{index,startedAt:Date.now()};
  timing.uploads[index]=upload;timing.waitReason='image-upload';
  await store(current,'正在读取并回传回复图片');
  const image=await page(current.tabId,'image',{...current,imageIndex:index});
  upload.encodedAt=Date.now();
  await uploadAsset(current.id,index,image.base64,image.mime);
  upload.uploadedAt=Date.now();
  current.uploaded=index+1;await store(current,'正在回传回复图片');
 }
 timing.resultPostedAt=Date.now();timing.waitReason='result-post';
 await store(current,'正在将完整回复交给 Koishi');
 await api('/result',{id:current.id,threadId:reply.threadId,segments:reply.segments,probe:{...reply.probe,timing}});
 await store(null,'回复已交给 Koishi 回传 QQ');
 }finally{
  if(previousTab&&previousTab.id!==current.tabId){
   const tab=await chrome.tabs.get(current.tabId).catch(()=>null);
   // A user switching tabs during retrieval keeps their new selection.
   if(tab?.active)await chrome.tabs.update(previousTab.id,{active:true}).catch(()=>{});
  }
 }
 await chrome.tabs.remove(current.tabId).catch(()=>{});
}
async function returnFailure(current){
 await api('/failure',{id:current.id,...current.failure});
 await store(null,'任务失败：'+current.failure.message);
}
function validReasoningFallback(current,fallback){
 return current.reasoningEffort==='pro'&&fallback?.requested==='pro'&&fallback.reason==='pro-unavailable'
  &&['instant','medium','high','xhigh'].includes(fallback.level);
}
function reasoningConfirmed(current){
 return !current.reasoningEffort||current.reasoningApplied===current.reasoningEffort
  ||(current.reasoningVerify&&validReasoningFallback(current,current.reasoningFallback)
   &&current.reasoningApplied===current.reasoningFallback.level);
}
async function applyReasoning(current){
 current.phase='reasoning';current.reasoningAttempts=(current.reasoningAttempts||0)+1;
 if(current.reasoningAttempts>12)throw Error('网页推理程度切换超时，无法确认所选程度；本次未提交');
 await store(current,'正在切换网页推理程度：'+current.reasoningEffort);
 const verifying=current.reasoningVerify,fallback=current.reasoningFallback;
 const reasoning=await page(current.tabId,'reasoning',current);
 if(reasoning.verify){
  if(reasoning.fallback){
   if(!validReasoningFallback(current,reasoning.fallback))throw Error('网页推理程度降级信息无效；本次未提交');
   current.reasoningFallback=reasoning.fallback;
  }
  current.reasoningVerify=true;await store(current,'正在读回菜单关闭后的推理程度');
 }
 if(!reasoning.applied)return;
 if(reasoning.level!==current.reasoningEffort&&!(verifying&&validReasoningFallback(current,fallback)
  &&validReasoningFallback(current,reasoning.fallback)&&reasoning.fallback.level===fallback.level
  &&reasoning.level===fallback.level))throw Error('网页推理程度与任务不一致；本次未提交');
 if(reasoning.level===current.reasoningEffort)delete current.reasoningFallback;
 current.reasoningApplied=reasoning.level;current.phase='opening';
 await store(current,current.reasoningFallback?'网页 Pro 暂不可用，已确认使用当前最高推理程度：'+reasoning.level:
  '网页推理程度已确认：'+reasoning.level);
}
async function applySkill(current){
 current.phase='skill';current.skillAttempts=(current.skillAttempts||0)+1;
 if(current.skillAttempts>15)throw Error(current.skillWaitReason==='window-focus'?
  '网页 @技能需要 Chrome 窗口获得焦点，请保持 Mac 解锁；本次未提交':'网页 @技能选择超时，未确认技能标记；本次未提交');
 const tab=await chrome.tabs.get(current.tabId);
 if(current.skillFocusStarted&&tab.active===false)throw Error('选择 @技能时标签页焦点已变化；本次未提交，请重试');
 const canFocusWindow=chrome.windows?.get&&Number.isInteger(tab.windowId);
 const window=canFocusWindow?await chrome.windows.get(tab.windowId):null;
 if(current.skillFocusStarted&&window&&window.focused===false)
  throw Error('选择 @技能时 Chrome 窗口焦点已变化；本次未提交，请重试');
 // ChatGPT's mention menu is focus-dependent. Keep only this short selection
 // stage active, then return to the previous tab unless the user switched away.
 if(!current.skillFocusStarted&&(tab.active===false||window?.focused===false)){
  const [previous]=await chrome.tabs.query({active:true,windowId:tab.windowId});
  current.skillPreviousTab=previous?.id;current.skillFocusStarted=true;
  if(window?.focused===false){
   const last=await chrome.windows.getLastFocused();
   current.skillWindowFocus={id:tab.windowId,previousFocusedWindow:last.focused?last.id:null};
  }
  await store(current,'正在打开独立标签页的原生技能菜单');
  if(current.skillWindowFocus)await chrome.windows.update(tab.windowId,{focused:true});
  await chrome.tabs.update(current.tabId,{active:true});return;
 }
 await store(current,'正在选择网页 @技能：'+current.skill.name);
 if(!current.skillQuery){
  const query='@'+current.skill.name.replace(/-/g,' '),threadId=current.threadId||'';
  const stored=await chrome.storage.local.get('drafts');
  const drafts=(stored.drafts||[]).filter(entry=>entry.threadId!==threadId||entry.text!==query);
  drafts.push({threadId,text:query});current.skillQuery=query;
  current.drafts=[...(current.drafts||[]),query].slice(-32);
  await chrome.storage.local.set({current,draft:query,drafts:drafts.slice(-32)});
 }
 const selection=await page(current.tabId,'skill',current);
 current.skillWaitReason=selection.waitingFor||null;
 if(selection.queryWritten)current.skillQueryWritten=true;
 if(selection.inputMethod)current.skillInputMethod=selection.inputMethod;
 if(selection.query)await store(current,'正在等待网页技能菜单');
 if(!selection.applied)return;
 if(!selection.id||!selection.name)throw Error('网页技能标记信息不完整；本次未提交');
 current.skillApplied={id:selection.id,name:selection.name};current.phase='opening';
 await restoreSkillFocus(current);
 await store(current,'已确认网页 @技能：'+selection.name);
}
async function restoreSkillFocus(current){
 if(!current?.skillFocusStarted)return;
 const tab=await chrome.tabs.get(current.tabId).catch(()=>null);
 if(tab?.active&&current.skillPreviousTab&&current.skillPreviousTab!==current.tabId)
  await chrome.tabs.update(current.skillPreviousTab,{active:true}).catch(()=>{});
 if(tab?.active&&current.skillWindowFocus){
  const window=await chrome.windows.get(current.skillWindowFocus.id).catch(()=>null);
  if(window?.focused){
   const previous=current.skillWindowFocus.previousFocusedWindow;
   await chrome.windows.update(previous||window.id,{focused:!!previous}).catch(()=>{});
  }
 }
 delete current.skillFocusStarted;delete current.skillPreviousTab;
 delete current.skillWindowFocus;
}
async function tick(){
 if(ticking)return;ticking=true;
 let current;
 try{
  if(configurationError){await chrome.storage.local.set({status:configurationError});return;}
  const remote=await api('/state');
  const stored=await chrome.storage.local.get(['current','draft','drafts','status']);
  current=stored.current;
  if(!remote.job){
   await restoreSkillFocus(current);
   // A completed/orphaned task is never resubmitted, even after service restarts.
   if(current?.tabId&&current.sentAt)await page(current.tabId,'stop',current).catch(()=>{});
   const idleStatus='已连接本机 Koishi，等待任务';
   if(current||stored.status!==idleStatus)await store(null,idleStatus);
   else inputs.clear();
   return;
  }
  const task=remote.job;
  const requestedMode=task.mode||(task.skill?'work':'chat');
  if(!['chat','work'].includes(requestedMode)||requestedMode==='chat'&&task.skill)throw Error('网页任务模式无效；本次未提交');
  if(task.cancelled && (!current || current.id!==task.id)){
   await api('/failure',{id:task.id,message:'任务已取消，未提交网页'});return;
  }
  if(!current || current.id!==task.id){
   await restoreSkillFocus(current);
   if(current?.tabId&&current.sentAt)await page(current.tabId,'stop',current).catch(()=>{});
   const tab=await chrome.tabs.create({url:task.threadId?'https://chatgpt.com/c/'+task.threadId:'https://chatgpt.com/',active:false});
   current={...task,mode:requestedMode,tabId:tab.id,phase:'opening',openedAt:Date.now(),hasImages:!!(task.images&&task.images.length),
    sentText:task.text||'',draft:stored.draft||null,
    drafts:(stored.drafts||[]).filter(entry=>entry.threadId===(task.threadId||'')).map(entry=>entry.text),padded:false};
   await store(current,'正在打开 ChatGPT 标签页');await api('/progress',{id:task.id,phase:'opening'});return;
  }
  current.mode=current.mode||requestedMode;
  if(current.mode!==requestedMode)throw Error('网页任务模式已变化；本次未提交');
  if(current.phase==='failing'){await returnFailure(current);return;}
  if(task.cancelled){
   await restoreSkillFocus(current);
   if(!current.sentAt){await api('/failure',{id:task.id,message:'任务已取消，未提交网页'});await store(null,'任务已取消');return;}
   await page(current.tabId,'stop',current);
   const stopped=await page(current.tabId,'inspect',current);
   if(stopped.stopping){await store(current,'等待网页确认停止');return;}
   await api('/failure',{id:task.id,message:'任务已取消'});await store(null,'任务已取消');return;
  }
  if(current.phase==='returning'){await returnReply(current);return;}
  // A modal model menu may aria-hide the composer. Finish and close our menu
  // before inspecting the composer again, including after worker suspension.
  if(current.phase==='reasoning'){await applyReasoning(current);return;}
  if(current.phase==='skill'){await applySkill(current);return;}
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
   if(info.unknownDrafts || info.attachments || info.uploading)
    throw Error('专用标签页已有草稿或附件，请清空后重新发送任务；本次未填写或上传');
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
   if(current.mode==='work'?info.needsWork:info.needsChat){
    current.modeWaitAt=current.modeWaitAt||Date.now();
    if(Date.now()-current.modeWaitAt>30000)throw Error('当前网页会话无法确认'+(current.mode==='work'?'工作':'聊天')+'模式，请先 /new；本次未提交');
    await page(current.tabId,current.mode,current);
    await store(current,'正在等待网页'+(current.mode==='work'?'工作':'聊天')+'模式准备');return;
   }
   delete current.modeWaitAt;
   if(!reasoningConfirmed(current)){await applyReasoning(current);return;}
   if(current.skill&&!current.skillApplied){await applySkill(current);return;}
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
   if(!reasoningConfirmed(current))
    throw Error('网页推理程度未经确认；本次未提交，请重新发送');
   if(current.skill&&!current.skillApplied)throw Error('网页 @技能未经确认；本次未提交');
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
  const waited=Date.now()-current.sentAt;
  const newAssistant=current.assistantId && info.assistantId && current.assistantId!==info.assistantId;
  const boundedReply=current.submittedConfirmed&&info.replyBounded&&info.replyBlocks>0;
  const ownsReply=!!(boundedReply||((info.assistants>current.baseline||newAssistant)
   &&!(current.assistantId&&info.assistantId===current.assistantId)));
  const busy=!!info.stopping||/正在生成|生成中|正在创建|正在思考|正在调用|Generating|Thinking|Creating image/i.test(info.busyText);
  const empty=!info.replyLength && !info.images;
  const pendingImage=info.imageLoading || info.pendingGallery || (info.gallery && !info.images);
  observeReply(current,info,{ownsReply,busy,empty,pendingImage,waited});
  await store(current,info.stopping||busy||empty||pendingImage?'ChatGPT 正在生成回复':'正在等待网页回复结束');
  if(info.threadId){
   await api('/progress',{id:task.id,threadId:info.threadId,phase:'submitted',evidence:{
    workerVersion:chrome.runtime.getManifest?.().version||'development',userId:info.userId||'',
    requestedMode:current.mode,observedMode:info.workMode?'work':'chat',
    userText:info.userText||'',textMatched:!!info.textMatched,
    userBaseline:current.userBaseline,users:info.users,assistantBaseline:current.baseline,assistants:info.assistants,
    assistantId:info.assistantId||'',replyBlocks:info.replyBlocks,replyBounded:info.replyBounded,
    ...(current.reasoningEffort?{reasoningEffort:current.reasoningEffort,reasoningApplied:current.reasoningApplied}:{}),
    ...(current.reasoningFallback?{reasoningFallback:current.reasoningFallback}:{}),
    ...(current.skill?{skillRequested:current.skill.name,skillApplied:current.skillApplied}:{}),
   },timing:current.timing});
   if(!current.threadId){current.threadId=info.threadId;await store(current,'已绑定本轮 ChatGPT 网页会话');}
  }
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
  // 「没有任何可读内容」和「图还在画」都算没完成。ChatGPT 会先渲染一个空的
  // assistant 轮次（只有无障碍标题），图片要几十秒后才出现；在这里提前收工，
  // 后面的 chrome.tabs.remove 会把还在生成的图片一起关掉。
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
  current.timing.waitReason='reading';current.timing.readStartedAt=Date.now();
  await store(current,'正在读取网页完整回复');
  await api('/progress',{id:task.id,threadId:info.threadId,phase:'reading',timing:current.timing});
  const reply=await page(current.tabId,'read',current);
  current.timing.readFinishedAt=Date.now();
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
   try{
    if(!current.failure){
     if(!err.probe)err.probe=await page(current.tabId,'probe',current).catch(()=>undefined);
     await restoreSkillFocus(current);
     const phase=current.phase;
     current.failure={message,probe:{...err.probe,timing:timings(current)}};current.phase='failing';
     await chrome.storage.local.set({current,lastFailure:{id:current.id,tabId:current.tabId,threadId:current.threadId||'',phase,
      recoveryCount:current.recoveryCount||0,message,at:Date.now()}});
    }
    await returnFailure(current);
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
  .then(data=>reply({status:data.status||'等待连接',lastFailure:data.lastFailure||null,
   bridgeUrl:configurationError?'':bridgeConfig.url,version:chrome.runtime.getManifest?.().version||'development'}))
  .catch(()=>reply({status:'无法读取连接状态，请检查扩展错误'}));return true;}
});
setInterval(()=>void tick(),2000);void tick();
