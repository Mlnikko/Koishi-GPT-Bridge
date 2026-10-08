let lastFailure;
async function refresh(){
 try{
  const s=await chrome.runtime.sendMessage({type:'status'});
  document.querySelector('#status').textContent=s.status;
  lastFailure=s.lastFailure;
  const detail=document.querySelector('#failure'),button=document.querySelector('#open-failure');
  detail.hidden=!lastFailure;button.hidden=!lastFailure?.tabId;
  detail.textContent=lastFailure?`最近失败任务：${lastFailure.id}\n${new Date(lastFailure.at).toLocaleString()}\n${lastFailure.message}`:'';
 }catch{document.querySelector('#status').textContent='无法连接扩展后台，请重新加载扩展后检查。';}
}
document.querySelector('#open-failure').onclick=async()=>{
 try{
  const tab=await chrome.tabs.get(lastFailure.tabId);
  if(!tab.url?.startsWith('https://chatgpt.com/'))throw Error('not a task tab');
  await chrome.tabs.update(tab.id,{active:true});
 }catch{document.querySelector('#status').textContent='故障标签页已关闭或已离开 ChatGPT，请查看本机任务记录。';}
};
document.querySelector('#check').onclick=refresh;refresh();
