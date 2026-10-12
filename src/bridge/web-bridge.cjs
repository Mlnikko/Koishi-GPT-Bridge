'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { failureInfo, safeReason } = require('../lib/feedback.cjs');
const { pngSize, sniffImage } = require('../lib/image.cjs');
const { validateSegments, replyText } = require('../lib/reply.cjs');
const { submissionText, imagesOf } = require('../core/message.cjs');
const { writeJson } = require('../lib/state.cjs');

const PROTOCOL_VERSION = 2;
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const ASSET_LIMIT = 20 * 1024 * 1024;
const MAX_ASSETS = 10;
// A text answer can stream for a while; the extension stops waiting on its own
// long before this, so the bridge budget is a backstop rather than the main gate.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const PHASES = {
  opening: '正在打开 ChatGPT 网页',
  submitted: 'ChatGPT 已接收，正在生成回复',
  reading: '正在读取回复内容',
};

const validThread = id => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '');

function error(code, message) { return Object.assign(new Error(message), { code }); }

function bindThread(p, id) {
  if(!validThread(id) || (p.threadId && id!==p.threadId)) throw error('thread_mismatch','ChatGPT 会话不匹配，已停止');
  if(p.threadId)return;
  try { p.onThread(id); }
  catch { throw error('state_write_failed','网页会话绑定保存失败，请检查本机状态目录后重试'); }
  p.threadId=id;
}

// 网页侧报上来的原因。只做技术归类：模型的内容拒绝是正常回复，不是失败，
// 它走 /result 回传给用户，绝不会走到这里。
function webFailure(reply) {
  const text = String(reply || '');
  if (/登录|log in|sign in/i.test(text)) return error('authentication', 'ChatGPT 网页需要登录，请在 Chrome 中登录后重试');
  if (/上限|限额|额度|rate.limit|usage.limit|too many requests/i.test(text)) return error('rate_limit', 'ChatGPT 网页额度或速率受限：' + safeReason(text));
  // 会话被删除或链接失效。单独给一个码，因为调用方要靠它解绑 webThreadId —— 持续
  // 会话下用户不会自己去换会话，不解绑就等于把这个人永久卡在一个失效编号上。
  if (/会话已不存在|会话无法打开|会话已被删除|conversation not found|thread not found/i.test(text))
    return error('thread_gone', '原 ChatGPT 网页会话已不存在或无法打开，下一条消息会自动开启一个新的网页会话。');
  if (/会话不匹配|会话与任务不一致/.test(text))
    return error('thread_mismatch', 'ChatGPT 网页没有停在任务指定的会话上，本次未提交：' + safeReason(text));
  if (/推理程度/.test(text))return error('browser_interaction','ChatGPT 网页操作未完成：'+safeReason(text));
  if (/页面加载|标签页|输入框|发送按钮|无法填写|提交状态|页面脚本|人工验证|参考图片|图片上传|无法附加/.test(text))
    return error('browser_interaction', 'ChatGPT 网页操作未完成：' + safeReason(text));
  const info = failureInfo({ technical: text });
  return error(info.code, info.message);
}

function assetType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > ASSET_LIMIT)
    throw error('image_invalid', '网页返回的图片大小异常');
  const type = sniffImage(bytes);
  if (type.ext === 'png') {
    pngSize(bytes);
  }
  if (type.ext === 'gif' && (!/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))
    || !bytes.readUInt16LE(6) || !bytes.readUInt16LE(8) || bytes.at(-1) !== 0x3b))
    throw error('image_invalid', '网页返回的 GIF 数据不完整');
  return type;
}

function saveAsset(bytes, destination) {
  assetType(bytes);
  const tmp = destination + '.tmp';
  try { fs.writeFileSync(tmp, bytes, { mode: 0o600 }); fs.renameSync(tmp, destination); }
  catch (err) { throw error('image_invalid', '网页图片保存失败：' + (err.code || 'write')); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  return destination;
}

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw error('too_large', '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 诊断快照仅用于排查网页结构，保存失败不能影响任务结果。
function saveProbe(dir, filename, probe) {
  try {
    if (probe && JSON.stringify(probe).length < 20000)
      fs.writeFileSync(path.join(dir, filename), JSON.stringify({ at: Date.now(), ...probe }), { mode: 0o600 });
  } catch {}
}

class WebBridge {
  constructor({ root, port = 5141, timeoutMs = DEFAULT_TIMEOUT_MS, pluginVersion = 'development' }) {
    this.pluginVersion=pluginVersion; this.startedAt=Date.now();
    this.root=root; this.timeoutMs=timeoutMs; this.pending=null; this.lastSeen=0; this.lastResult=null; this.tail=Promise.resolve(); this.queued=0; this.closed=false;
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const tokenFile=path.join(root,'web-bridge-token');
    this.token=fs.existsSync(tokenFile)?fs.readFileSync(tokenFile,'utf8').trim():randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile,this.token,{mode:0o600});
    this.server=http.createServer((req,res)=>this.handle(req,res));
    this.ready=new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',()=>{
      this.port=this.server.address().port;
      // The listening port is recorded next to the token: with `port: 0` the OS
      // picks it, and even a fixed port is worth confirming from the outside.
      try{fs.writeFileSync(path.join(root,'web-bridge-port'),String(this.port),{mode:0o600});}catch{}
      resolve();
    });});
    this.ready.catch(()=>{});
  }
  health() {
    return { version:PROTOCOL_VERSION,pluginVersion:this.pluginVersion,
      online:!this.closed&&this.lastSeen>0&&Date.now()-this.lastSeen<=90000,
      lastSeen:this.lastSeen,busy:!!this.pending,uptimeMs:Date.now()-this.startedAt };
  }
  requestInfo() {
    const p=this.pending;
    if(!p)return null;
    return {id:p.job.id,text:submissionText(p.job.input),threadId:p.threadId||'',cancelled:!!p.cancelled,
      ...(p.job.reasoningEffort ? {reasoningEffort:p.job.reasoningEffort} : {}),
      // Only metadata crosses to the extension here; the bytes are served on demand
      // by GET /input so a poll never carries megabytes of image data.
      images:imagesOf(p.job.input)
        .map((image,index)=>({index,mime:image.mime||'image/png',name:image.file,size:image.size||0}))};
  }
  async handle(req,res) {
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    const token=String(req.headers['x-bridge-token']||'');
    if(Buffer.byteLength(token)!==Buffer.byteLength(this.token) || !timingSafeEqual(Buffer.from(token),Buffer.from(this.token))) return send(401,{error:'unauthorized'});
    let requestPending;
    try {
      if(req.method==='GET' && req.url==='/health') return send(200,this.health());
      if(req.method==='GET' && req.url==='/state') {
        this.lastSeen=Date.now();this.reasoningSupported=String(req.headers['x-bridge-capabilities']||'').split(',').includes('reasoning');
        // Older extensions ignore unknown task fields. Never let one submit a
        // request with an explicitly selected effort that it cannot apply.
        if(this.pending?.job.reasoningEffort&&!this.reasoningSupported)
          this.pending.finish(error('browser_upgrade','切换推理程度需要重新加载新版 Chrome 扩展；本次未提交网页'));
        return send(200,{job:this.requestInfo(),version:PROTOCOL_VERSION});
      }
      if(req.method==='GET' && new URL(req.url,'http://127.0.0.1').pathname==='/input') {
        const url=new URL(req.url,'http://127.0.0.1'),p=this.pending;
        if(!p || url.searchParams.get('id')!==p.job.id) return send(409,{error:'job is no longer active'});
        const images=imagesOf(p.job.input);
        const image=images[Number(url.searchParams.get('i')||0)];
        if(!image) return send(404,{error:'no such input image'});
        let bytes;
        try { bytes=fs.readFileSync(path.join(p.job.dir,path.basename(image.file))); }
        catch { return send(404,{error:'input image missing'}); }
        res.writeHead(200,{'Content-Type':image.mime||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'});
        return res.end(bytes);
      }
      if(req.method!=='POST') return send(404,{error:'not found'});
      const url=new URL(req.url,'http://127.0.0.1');
      // Reply images arrive as raw bytes on their own endpoint: base64 inside the
      // JSON result would inflate every picture by a third and blow the body limit
      // as soon as a reply carries more than one image.
      if(url.pathname==='/result-asset') {
        const p=this.pending, id=url.searchParams.get('id');
        if(!p || id!==p.job.id) return send(409,{error:'job is no longer active'});
        requestPending=p;
        const index=Number(url.searchParams.get('i'));
        // Assets are uploaded in order, so the running count is also the next index.
        if(!Number.isInteger(index) || index<0 || index>p.assets.size || index>=MAX_ASSETS)
          throw error('image_invalid',`回复图片序号无效（${String(url.searchParams.get('i')).slice(0,12)}）`);
        const bytes=await readBody(req,ASSET_LIMIT);
        if(this.pending!==p || p.cancelled) return send(409,{error:'job is no longer active'});
        // A lost HTTP acknowledgement must not turn a retry into task failure.
        if(p.assets.has(index)) {
          const type=p.assets.get(index);
          if(!fs.readFileSync(path.join(p.job.dir,`result-${index}.${type.ext}`)).equals(bytes))
            throw error('image_invalid','同一回复图片的重试内容发生变化');
          return send(200,{ok:true,index});
        }
        const type=assetType(bytes);
        saveAsset(bytes,path.join(p.job.dir,`result-${index}.${type.ext}`));
        p.assets.set(index,{mime:type.mime,ext:type.ext});
        return send(200,{ok:true,index});
      }
      const raw=await readBody(req,JSON_BODY_LIMIT);
      const body=JSON.parse(raw.toString('utf8')||'{}'),p=this.pending;
      if(!p || body.id!==p.job.id){
        if(url.pathname==='/result' && body.id===this.lastResult) return send(200,{ok:true});
        return send(409,{error:'job is no longer active'});
      }
      requestPending=p;
      if(url.pathname==='/progress') {
        if(body.threadId){
          bindThread(p,body.threadId);
        }
        if(body.phase==='submitted'&&body.evidence&&!p.submissionSaved){
          saveProbe(p.job.dir,'submission.json',body.evidence);p.submissionSaved=true;
        }
        // Overwrite a bounded timing snapshot, rather than appending one log
        // line per poll. It remains useful if the browser disappears or times out.
        saveProbe(p.job.dir,'timing.json',body.timing);
        const phase=PHASES[body.phase];
        if(phase)p.onProgress(phase);
        return send(200,{ok:true,cancelled:!!p.cancelled});
      }
      if(url.pathname==='/failure') {
        // The extension attaches a page-structure snapshot when it could not read
        // the reply. Keep it beside the job so the selectors can be corrected from
        // real markup instead of guesswork; never let it break the failure report.
        saveProbe(p.job.dir, 'dom-probe.json', body.probe);
        p.finish(p.cancelled || webFailure(String(body.message||'网页未返回明确原因')));return send(200,{ok:true});
      }
      if(url.pathname==='/result') {
        if(p.cancelled){p.finish(p.cancelled);return send(409,{error:'cancelled'});}
        bindThread(p,body.threadId);
        // The extension also snapshots the page when the reply came from a scan
        // rather than the assistant turn, which is how a wrong picture (e.g. the
        // signed-in account avatar) can be handed back. Keep that snapshot beside
        // the job so a bad result stays auditable; never let it break the result.
        saveProbe(p.job.dir, 'result-probe.json', body.probe);
        const segments=validateSegments(body.segments,{uploaded:p.assets.size,assets:p.assets});
        // Commit the structured reply before acknowledging receipt. Queue startup
        // can recover this if the process dies before job.json reaches ready.
        const receipt=path.join(p.job.dir,'result.json');
        writeJson(receipt,{id:p.job.id,threadId:body.threadId,segments});
        // Keep a plain-text copy so a truncated QQ delivery can be replayed and so
        // a bad reply can be inspected without re-reading the web page.
        try { fs.writeFileSync(path.join(p.job.dir,'reply.md'),replyText(segments),{mode:0o600}); } catch {}
        this.lastResult=p.job.id;p.finish(null,segments);return send(200,{ok:true});
      }
      return send(404,{error:'not found'});
    }catch(err){
      // 带错误码的请求都是本连接器自己的协议错误（线程不匹配、回复不合法、图片超限），
      // 让任务立刻失败，用户才能马上看到原因，而不是空等到超时。
      // JSON 解析失败这类没有错误码的畸形请求不会波及正在跑的任务。
      if(requestPending && this.pending===requestPending && err.code)requestPending.finish(err);
      send(err.code==='too_large'?413:400,{error:safeReason(err.message)});
    }
  }
  async run(job,options={}) {
    const previous=this.tail;
    let release;this.tail=new Promise(resolve=>{release=resolve;});this.queued++;
    try {await previous;if(this.closed)throw error('interrupted','网页连接器已关闭');return await this.runActive(job,options);}
    finally {this.queued--;release();}
  }
  async runActive(job,{threadId,onThread=()=>{},onProgress=()=>{},signal,timeoutMs=this.timeoutMs}={}) {
    try {await this.ready;}catch {throw error('bridge_unavailable','ChatGPT 网页连接器无法监听本机端口，请检查 5141 端口');}
    if(this.closed)throw error('interrupted','网页连接器已关闭，任务未提交');
    if(this.pending)throw error('bridge_busy','ChatGPT 网页连接器正在处理其他任务');
    if(threadId && !validThread(threadId))throw error('thread_invalid','ChatGPT 会话编号无效');
    if(signal?.aborted)throw error('cancelled','任务已取消');
    if(Date.now()-this.lastSeen>90000)throw error('browser_offline','ChatGPT 网页连接器未在线。请打开 Chrome 并启用扩展，等待连接后重试');
    if(job.reasoningEffort&&!this.reasoningSupported)throw error('browser_upgrade','切换推理程度需要重新加载新版 Chrome 扩展；本次未提交网页');
    if(threadId)bindThread({onThread},threadId);
    const report=onProgress;
    onProgress=phase=>{try{report(phase);}catch{}};
    return new Promise((resolve,reject)=>{
      let done=false,timer,grace;
      const cancel=reason=>{if(p.cancelled)return;p.cancelled=reason;onProgress('正在请求网页停止生成');grace=setTimeout(()=>p.finish(reason),15000);};
      const abort=()=>cancel(error('cancelled','任务已取消；网页生成是否停止取决于浏览器连接状态'));
      const p={job,threadId,onThread,onProgress,assets:new Map(),finish:(err,segments)=>{
        if(done)return;done=true;clearTimeout(timer);clearTimeout(grace);signal?.removeEventListener('abort',abort);
        if(this.pending===p)this.pending=null;
        if(err){
          try{fs.writeFileSync(path.join(job.dir,'failure.json'),JSON.stringify({code:err.code||'web_failed',message:err.message,at:Date.now()}),{mode:0o600});}catch{}
          reject(err);
        }else resolve(segments);
      }};
      this.pending=p;onProgress('等待 ChatGPT 网页接收任务');
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>cancel(error('execution_stopped','ChatGPT 网页处理超时，请稍后重试')),timeoutMs);
    });
  }
  close(){this.closed=true;this.pending?.finish(error('interrupted','网页连接器已关闭，任务未自动重试'));this.server.close();}
}
module.exports={WebBridge,saveAsset,webFailure,validThread,PROTOCOL_VERSION};
