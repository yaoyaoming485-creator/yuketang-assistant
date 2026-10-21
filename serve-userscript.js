// 本地 HTTP 服务：把 .user.js 以正确 MIME 提供出去，
// 这样 Tampermonkey 安装时不需要开"允许访问文件网址"。
const http = require('http');
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const FILE = path.join(LAB, 'deliverables', '雨课堂刷课助手-修复版.user.js');
const PORT = 8899;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/ykt.user.js') {
    const buf = fs.readFileSync(FILE);
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    console.log('[serve] 200 ' + p + '  (' + buf.length + ' bytes)');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    console.log('[serve] 404 ' + p);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[serve] http://127.0.0.1:' + PORT + '/ykt.user.js  (' + FILE + ')');
});
