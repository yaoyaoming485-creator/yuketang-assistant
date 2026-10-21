// ============================================================================
// 测试用「隔离中转站」实例
// ----------------------------------------------------------------------------
// 背景：这几个自检脚本会 POST /api/reset，而 /api/reset 会清空**缓存 + 删除截图**。
//       如果直接打 8900 上的用户实例，用户刷课积累的答案和已采集的截图就没了
//       （已经踩过一次，2026-10-21）。
// 现在中转站支持 --cache / --shots / --fonts 三个参数，
// 所以测试一律起自己的实例：独立端口 + 独立缓存 + 独立截图目录。
// ============================================================================
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const LAB = __dirname;

function getJSON(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function startIsolatedBridge(port, tag) {
  const dir = path.join(LAB, '.test-runtime', tag);
  // [关键] 每次启动前清空该 tag 的隔离目录。
  // 否则上一轮遗留的 inbox 条目/答案会被复用 —— 队列 key 是 html 的哈希（固定），
  // 上一轮已作答的条目会被 "enqueueInbox" 复用成 answered=true，
  // 导致 "队列项标记为未作答" 这类断言在第二次运行起必然失败。
  // 只删 .test-runtime 下的测试目录，绝不碰 lab 根目录下的真实数据。
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  const cacheFile = path.join(dir, 'answer-cache.json');

  const child = spawn(process.execPath, [
    path.join(LAB, 'local-answer-server.js'),
    '--port', String(port),
    '--cache', cacheFile,
    '--shots', path.join(dir, 'shots'),
    '--fonts', path.join(dir, 'fonts'),
    '--inbox', path.join(dir, 'inbox.json'),
    // 答案库也必须隔离：默认指向隔离目录（通常不存在），
    // 否则生产答案库会命中测试用的真实题目，让「未作答」断言莫名其妙失败。
    // 需要验证答案库的用例请自行拷贝并用 --answer-bank 指定（见 test-answer-bank.js）。
    '--answer-bank', path.join(dir, 'answer-bank.json'),
  ], { cwd: LAB, stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  // 等健康检查通过
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      const h = await getJSON(port, '/api/health');
      if (h && h.ok) {
        return {
          base: `http://127.0.0.1:${port}`,
          port,
          dir,
          cacheFile,
          log: () => log,
          stop: () => { try { child.kill(); } catch (e) { /* ignore */ } },
        };
      }
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  try { child.kill(); } catch (e) { /* ignore */ }
  throw new Error('隔离中转站启动失败:\n' + log);
}

module.exports = { startIsolatedBridge, getJSON };
