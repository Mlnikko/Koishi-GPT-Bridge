'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { classificationPrompt, validateIntent, schema } = require('../core/intent.cjs');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { failureInfo, safeReason } = require('../lib/feedback.cjs');
const { pngSize } = require('../lib/image.cjs');
const validThread = id => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '');
function error(code, message) { return Object.assign(new Error(message), { code }); }
function webFailure(reply) {
  if (/登录|log in|sign in/i.test(reply)) return error('authentication', 'ChatGPT 网页需要登录，请在 Chrome 中登录后重试');
  if (/上限|限额|额度|rate.limit|usage.limit|too many requests/i.test(reply)) return error('rate_limit', 'ChatGPT 网页额度或速率受限：' + safeReason(reply));
  if (/页面加载|标签页|输入框|发送按钮|无法填写|提交状态|页面脚本|人工验证|参考图片|图片上传|无法附加/.test(reply)) return error('browser_interaction', 'ChatGPT 网页操作未完成：' + safeReason(reply));
  const info = failureInfo({ noImage: true, reply });
  return error(info.code, info.message);
}
function saveImage(base64, destination) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw error('image_invalid', '网页返回的图片数据无效');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 100 || bytes.length > 20*1024*1024) throw error('image_invalid', '网页图片大小异常');
  try { pngSize(bytes); } catch (err) { throw error('image_invalid', '网页图片保存或校验失败：' + (err.code || 'decode')); }
  const tmp = destination + '.tmp';
  try { fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); fs.copyFileSync(tmp, destination, fs.constants.COPYFILE_EXCL); }
  catch (err) { throw error('image_invalid', '网页图片保存或校验失败：' + (err.code || 'decode')); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  return destination;
}
class WebBridge {
  constructor({ root, port = 5141, timeoutMs = 10*60*1000 }) {
    this.root=root; this.timeoutMs=timeoutMs; this.pending=null; this.lastSeen=0; this.lastResult=null; this.tail=Promise.resolve(); this.queued=0; this.closed=false;
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const tokenFile=path.join(root,'web-bridge-token');
    this.token=fs.existsSync(tokenFile)?fs.readFileSync(tokenFile,'utf8').trim():randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile,this.token,{mode:0o600});
    this.server=http.createServer((req,res)=>this.handle(req,res));
    this.ready=new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',()=>{this.port=this.server.address().port;resolve();});});
    this.ready.catch(()=>{});
  }
  requestInfo() {
    const p=this.pending;
    if(!p)return null;
    return {id:p.job.id,prompt:p.job.prompt,kind:p.job.kind || 'image',threadId:p.threadId||'',cancelled:!!p.cancelled,
      // Only metadata crosses to the extension here; the bytes are served on demand
      // by GET /input so a poll never carries megabytes of image data.
      images:(p.job.inputImages||[]).map((image,index)=>({index,mime:image.mime||'image/png',name:image.file,size:image.size||0}))};
  }
  async handle(req,res) {
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    const token=String(req.headers['x-bridge-token']||'');
    if(token.length!==this.token.length || !timingSafeEqual(Buffer.from(token),Buffer.from(this.token))) return send(401,{error:'unauthorized'});
    this.lastSeen=Date.now();
    try {
      if(req.method==='GET' && req.url==='/state') return send(200,{job:this.requestInfo(),version:1});
      if(req.method==='GET' && req.url.startsWith('/input')) {
        const url=new URL(req.url,'http://127.0.0.1'),p=this.pending;
        if(!p || url.searchParams.get('id')!==p.job.id) return send(409,{error:'job is no longer active'});
        const image=(p.job.inputImages||[])[Number(url.searchParams.get('i')||0)];
        if(!image) return send(404,{error:'no such input image'});
        let bytes;
        try { bytes=fs.readFileSync(path.join(p.job.dir,path.basename(image.file))); }
        catch { return send(404,{error:'input image missing'}); }
        res.writeHead(200,{'Content-Type':image.mime||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'});
        return res.end(bytes);
      }
      if(req.method!=='POST') return send(404,{error:'not found'});
      let raw='',size=0;
      for await(const chunk of req){size+=chunk.length;if(size>29*1024*1024) {send(413,{error:'too large'});return;}raw+=chunk.toString('utf8');}
      const body=JSON.parse(raw||'{}'),p=this.pending;
      if(!p || body.id!==p.job.id){
        if(req.url==='/result' && body.id===this.lastResult) return send(200,{ok:true});
        return send(409,{error:'job is no longer active'});
      }
      if(req.url==='/progress') {
        if(body.threadId){
          if(!validThread(body.threadId) || (p.threadId && body.threadId!==p.threadId)) throw error('thread_mismatch','ChatGPT 会话不匹配，已停止取图');
          if(!p.threadId){p.threadId=body.threadId;p.onThread(body.threadId);}
        }
        const phase=({opening:'正在打开 ChatGPT 网页',submitted:'ChatGPT 已接收，正在生成图片',saving:'正在取回 ChatGPT 图片'})[body.phase];
        if(phase)p.onProgress(phase);
        return send(200,{ok:true,cancelled:!!p.cancelled});
      }
      if(req.url==='/failure') {p.finish(p.cancelled || webFailure(String(body.message||'网页未返回明确原因')));return send(200,{ok:true});}
      if(req.url==='/result') {
        if(p.cancelled){p.finish(p.cancelled);return send(409,{error:'cancelled'});}
        if(!validThread(body.threadId) || (p.threadId && body.threadId!==p.threadId)) throw error('thread_mismatch','ChatGPT 返回的会话与任务不一致');
        if(!p.threadId){p.threadId=body.threadId;p.onThread(body.threadId);}
        if(p.job.kind==='intent') {
          let value;
          try {
            const raw=String(body.text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
            if(raw.length>8000)throw Error('too long');
            value=validateIntent(JSON.parse(raw));
          } catch {throw error('intent_invalid','ChatGPT 语义识别结果无法解析，请使用明确命令');}
          this.lastResult=p.job.id;p.finish(null,value);return send(200,{ok:true});
        }
        const file=saveImage(body.base64,path.join(p.job.dir,'result.png'));
        this.lastResult=p.job.id;p.finish(null,file);return send(200,{ok:true});
      }
      return send(404,{error:'not found'});
    }catch(err){
      if(this.pending && err.code)this.pending.finish(err);
      send(400,{error:safeReason(err.message)});
    }
  }
  async classify(input, context, {signal}={}) {
    if(this.queued || this.pending)throw error('bridge_busy','ChatGPT 网页正在处理其他任务，请稍后重试语义识别，或使用明确命令。');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-web-intent-'));
    try {return await this.run({id:randomBytes(6).toString('hex'),kind:'intent',dir,
      prompt:classificationPrompt(input,context)+'\n必须仅返回一个 JSON 对象，字段定义：'+JSON.stringify(schema)}, {signal,timeoutMs:60000});}
    finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  async run(job,options={}) {
    const previous=this.tail;
    let release;this.tail=new Promise(resolve=>{release=resolve;});this.queued++;
    try {await previous;if(this.closed)throw error('interrupted','网页连接器已关闭');return await this.runActive(job,options);}
    finally {this.queued--;release();}
  }
  async runActive(job,{threadId,onThread=()=>{},onProgress=()=>{},signal,timeoutMs=this.timeoutMs}={}) {
    try {await this.ready;}catch {throw error('bridge_unavailable','ChatGPT 网页连接器无法监听本机端口，请检查 5141 端口');}
    if(this.pending)throw error('bridge_busy','ChatGPT 网页连接器正在处理其他任务');
    if(threadId && !validThread(threadId))throw error('thread_invalid','ChatGPT 会话编号无效');
    if(signal?.aborted)throw error('cancelled','任务已取消');
    if(Date.now()-this.lastSeen>90000)throw error('browser_offline','ChatGPT 网页连接器未在线。请打开 Chrome 并启用“QQ ChatGPT 生图连接器”，等待连接后重试');
    return new Promise((resolve,reject)=>{
      let done=false,timer,grace;
      const cancel=reason=>{if(p.cancelled)return;p.cancelled=reason;onProgress('正在请求网页停止生成');grace=setTimeout(()=>p.finish(reason),15000);};
      const abort=()=>cancel(error('cancelled','任务已取消；网页生成是否停止取决于浏览器连接状态'));
      const p={job,threadId,onThread,onProgress,finish:(err,file)=>{
        if(done)return;done=true;clearTimeout(timer);clearTimeout(grace);signal?.removeEventListener('abort',abort);
        if(this.pending===p)this.pending=null;
        if(err){fs.writeFileSync(path.join(job.dir,'failure.json'),JSON.stringify({code:err.code||'web_failed',message:err.message,at:Date.now()}),{mode:0o600});reject(err);}else resolve(file);
      }};
      this.pending=p;onProgress('等待 ChatGPT 网页接收任务');
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>cancel(error('execution_stopped','ChatGPT 网页处理超时，请使用明确命令或稍后重试')),timeoutMs);
    });
  }
  close(){this.closed=true;this.pending?.finish(error('interrupted','网页连接器已关闭，任务未自动重试'));this.server.close();}
}
module.exports={WebBridge,saveImage,webFailure,validThread};
