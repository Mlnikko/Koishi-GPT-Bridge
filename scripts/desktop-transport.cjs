'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A narrow local HTTP client for the authorized desktop executor. The token is
// read locally and never printed in tool output or passed as a command argument.
async function request({ root, endpoint, body }) {
  if (!['/health', '/state', '/checkpoint', '/result', '/failure'].includes(endpoint)) throw Error('未知客户端桥接操作');
  const port = Number(fs.readFileSync(path.join(root, 'desktop-bridge-port'), 'utf8'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('客户端桥接端口无效');
  const token = fs.readFileSync(path.join(root, 'desktop-bridge-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-bridge-token': token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok) throw Error(`客户端桥接 HTTP ${response.status}: ${data.error}`);
  return data;
}
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    Promise.resolve().then(() => request(JSON.parse(input))).then(data => console.log(JSON.stringify(data)))
      .catch(err => { console.error(err.message); process.exitCode = 1; });
  });
}
module.exports = { request };
