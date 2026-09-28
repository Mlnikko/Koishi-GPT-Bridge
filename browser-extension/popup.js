async function refresh(){const s=await chrome.runtime.sendMessage({type:'status'});document.querySelector('#status').textContent=s.status;}
document.querySelector('#check').onclick=refresh;refresh();
