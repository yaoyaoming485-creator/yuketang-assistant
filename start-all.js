// 一键启动本地答题所需的服务，并打印油猴面板要填的配置。
//   node start-all.js
// 会做三件事：
//   1) 检查 8899（油猴脚本更新服务），没起就拉起
//   2) 检查 8900（本地答案中转站），没起就拉起
//   3) 打印油猴 [AI配置] 面板该填的三项
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const LAB = __dirname;

// 纯 TCP 端口探测：只判断"有人在听"，不发 HTTP 请求（避免误判与 TIME_WAIT 堆积）
function ping(port, timeout = 1500) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = v => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(v); } };
    s.setTimeout(timeout, () => finish(false));
    s.on('connect', () => finish(true));
    s.on('error', () => finish(false));
  });
}

function launch(script, args = []) {
  const out = fs.openSync(path.join(LAB, 'logs', path.basename(script) + '.log'), 'a');
  const p = spawn(process.execPath, [script, ...args], {
    cwd: LAB, detached: true, stdio: ['ignore', out, out],
  });
  p.unref();
  return p.pid;
}

(async () => {
  fs.mkdirSync(path.join(LAB, 'logs'), { recursive: true });

  const ok8899 = await ping(8899);
  if (ok8899) console.log('[start] 8899 油猴更新服务：已在运行');
  else console.log('[start] 8899 油猴更新服务：已拉起 (pid ' + launch('serve-userscript.js') + ')');

  const ok8900 = await ping(8900);
  if (ok8900) console.log('[start] 8900 本地答案中转站：已在运行');
  else console.log('[start] 8900 本地答案中转站：已拉起 (pid ' + launch('local-answer-server.js') + ')');

  await new Promise(r => setTimeout(r, 1200));

  console.log(`
================ 油猴 [AI配置] 面板要填的内容 ================

  API URL    : http://127.0.0.1:8900/v1/chat/completions
  API KEY    : local
  Model Name : minimax-local
  API Format : openai
  Auth Method: bearer

  填完点「保存设置」，然后点「开始刷课」。

  * Model Name 里必须有 "minimax" 三个字 —— 脚本靠它判断要不要走多模态分支，
    不含这四个字就只会把 OCR 文字发过来，中转站拿不到截图。
  * API KEY 不能为空、也不能含 sk-xxxx，否则脚本会在发请求前就报错。

=============================================================
`);
})();
