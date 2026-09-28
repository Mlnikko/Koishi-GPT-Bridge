'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const root=path.join(__dirname,'data');fs.mkdirSync(root,{recursive:true,mode:0o700});
const tokenFile=path.join(root,'web-bridge-token');
if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600});
fs.writeFileSync(path.join(__dirname,'browser-extension/config.js'),'const BRIDGE = '+JSON.stringify({url:'http://127.0.0.1:5141',token:fs.readFileSync(tokenFile,'utf8').trim()})+';\n',{mode:0o600});
console.log('浏览器连接器配置已生成；不含 ChatGPT 或 QQ 登录凭据。');
