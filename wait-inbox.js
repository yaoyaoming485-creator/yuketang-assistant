// 后台轮询待答队列：一旦有题，立即退出并打印明文题面
// 用法: node wait-inbox.js [超时秒数, 默认 600]
const http = require('http');

const PORT = parseInt(process.env.BRIDGE_PORT || '8900', 10);
const HOST = '127.0.0.1';
const limit = parseInt(process.argv[2] || '600', 10);

function get(path) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

(async () => {
  const deadline = Date.now() + limit * 1000;
  let ticks = 0;
  while (Date.now() < deadline) {
    const r = await get('/api/inbox?pending=1');
    if (r && r.items && r.items.length) {
      console.log('FOUND ' + r.count);
      console.log(JSON.stringify(r.items, null, 2));
      return;
    }
    ticks += 1;
    if (ticks % 10 === 0) {
      console.log('still waiting, ticks=' + ticks + ' elapsed=' + Math.round((limit * 1000 - (deadline - Date.now())) / 1000) + 's');
    }
    await new Promise((r2) => setTimeout(r2, 15000));
  }
  console.log('TIMEOUT no pending item after ' + limit + 's');
})();
