// ============================================================================
// 看门狗：定期检查 8899 / 8900 是否还在监听，掉了就自动拉起
// ----------------------------------------------------------------------------
// 为什么需要：这两个服务是 detached 进程，但后台任务被清理时可能把整组进程带走，
// 表现为「刷着刷着服务突然没了」。
// 用法：node watchdog.js   （建议用 detached 方式启动）
// ============================================================================
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LAB = __dirname;
const LOG = path.join(LAB, 'logs', 'watchdog.log');
const INTERVAL = 15000;

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line, 'utf8');
  } catch (e) { /* ignore */ }
  console.log(line.trim());
}

function ping(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch (e) { } resolve(v); } };
    s.setTimeout(timeout, () => fin(false));
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
  });
}

function launch(script) {
  try {
    const out = fs.openSync(path.join(LAB, 'logs', path.basename(script) + '.log'), 'a');
    const p = spawn(process.execPath, [script], { cwd: LAB, detached: true, stdio: ['ignore', out, out] });
    p.unref();
    return p.pid;
  } catch (e) {
    log('拉起失败 ' + script + '：' + e.message);
    return 0;
  }
}

const TARGETS = [
  { port: 8899, script: 'serve-userscript.js' },
  { port: 8900, script: 'local-answer-server.js' },
];

(async () => {
  log('看门狗启动（每 ' + INTERVAL / 1000 + 's 检查一次）');
  for (;;) {
    for (const t of TARGETS) {
      const up = await ping(t.port);
      if (!up) {
        const pid = launch(t.script);
        log('★ ' + t.port + ' 不在监听，已拉起 ' + t.script + ' (pid ' + pid + ')');
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    await new Promise(r => setTimeout(r, INTERVAL));
  }
})();
