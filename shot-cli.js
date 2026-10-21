// 本地答案中转站的命令行助手
//   node shot-cli.js health
//   node shot-cli.js list
//   node shot-cli.js inbox                 列出「待答队列」里的题（明文题面）
//   node shot-cli.js answer <seq> <answer>      例：node shot-cli.js answer 3 AB
//   node shot-cli.js answer-key <key> <answer>  例：node shot-cli.js answer-key inbox:xxxx B
//   node shot-cli.js reset
const http = require('http');

const PORT = parseInt(process.env.BRIDGE_PORT || '8900', 10);
const HOST = '127.0.0.1';

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST, port: PORT, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const cmd = (process.argv[2] || 'list').toLowerCase();

  if (cmd === 'health') {
    console.log(JSON.stringify(await call('GET', '/api/health'), null, 2));
    return;
  }

  if (cmd === 'reset') {
    console.log(JSON.stringify(await call('POST', '/api/reset', {}), null, 2));
    return;
  }

  if (cmd === 'answer') {
    const seq = parseInt(process.argv[3], 10);
    const answer = process.argv[4];
    if (!Number.isFinite(seq) || !answer) {
      console.error('用法: node shot-cli.js answer <seq> <answer>');
      process.exit(1);
    }
    const r = await call('POST', '/api/answer', { seq, answer });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  // [v12] 待答队列：Agent 取题用
  if (cmd === 'inbox') {
    const pending = process.argv[3] === 'pending';
    const r = await call('GET', '/api/inbox' + (pending ? '?pending=1' : ''));
    if (!r.items || !r.items.length) {
      console.log(pending ? '（队列里没有待答题）' : '（队列是空的）');
      return;
    }
    console.log(`队列共 ${r.count} 条：\n`);
    for (const it of r.items) {
      console.log(`key: ${it.key}`);
      console.log(`  状态: ${it.answered ? '已作答 ' + (it.answer || '') : '待作答'}${it.note ? '  (' + it.note + ')' : ''}`);
      const q = String(it.question || '').replace(/\s+/g, ' ').trim();
      if (q) console.log(`  题面: ${q}`);
      if (!q && it.text) console.log(`  OCR : ${String(it.text).replace(/\s+/g, ' ').slice(0, 300)}`);
      console.log('');
    }
    return;
  }

  // [v12] 按 key 写答案（队列里的题）
  if (cmd === 'answer-key') {
    const key = process.argv[3];
    const answer = process.argv[4];
    if (!key || !answer) {
      console.error('用法: node shot-cli.js answer-key <key> <answer>');
      process.exit(1);
    }
    const r = await call('POST', '/api/answers', { items: [{ key, answer, note: 'Agent 作答' }] });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  // 默认 list
  const r = await call('GET', '/api/shots');
  if (!r.shots || !r.shots.length) {
    console.log('（还没有采集到任何题目截图）');
    return;
  }
  console.log(`共 ${r.count} 张题目截图：\n`);
  for (const s of r.shots) {
    const ans = s.answer ? s.answer : '（待作答）';
    console.log(`#${String(s.seq).padStart(2, '0')}  ${ans.padEnd(10, ' ')}  ${s.file}`);
    const t = (s.text || '').replace(/\s+/g, ' ').trim();
    if (t) console.log(`      OCR: ${t.slice(0, 300)}`);
  }
})().catch(e => {
  console.error('调用失败：', e.message);
  console.error('提示：先启动 node local-answer-server.js');
  process.exit(1);
});
