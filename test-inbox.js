// ============================================================================
// v12 端到端测试：待答队列 /api/inbox
// 场景：脚本「📋 取题」-> 题目入队（持久化）-> Agent 写答案 -> 脚本轮询取回
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startIsolatedBridge } = require('./test-harness');

const LAB = __dirname;
const PORT = 8906;
const FONT_URL = 'https://fe-static-yuketang.yuketang.cn/fe_font/product/exam_font_9e8180041a384270bb2b2dd5deb08b89.ttf';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`); }
}

function req(port, method, p, obj) {
  return new Promise((resolve, reject) => {
    const data = obj ? Buffer.from(JSON.stringify(obj)) : null;
    const r = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); } catch (e) { resolve({ status: res.statusCode, json: null, raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const iso = await startIsolatedBridge(PORT, 'inbox');
  console.log('  （隔离实例 ' + iso.base + '）');

  // 自造的加密题面（不依赖任何课程内容，仓库才能公开）
  // 用字体映射表的逆映射把自造文本加密，再验证服务端能还原
  const mapFile = path.join(LAB, 'fonts', 'exam_font_9e8180041a384270bb2b2dd5deb08b89.ttf.map.json');
  const fmap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const inv = {};
  for (const [fake, real] of Object.entries(fmap)) inv[real] = fake;
  const reals = [...new Set(Object.values(fmap))];
  const fallbackReal = reals[0];
  const fit = (s) => [...s].map(c => (inv[c] ? c : fallbackReal)).join('');
  const enc = (s) => [...s].map(c => inv[c]).join('');
  const span = (t) => '<span class="xuetangx-com-encrypted-font">' + t + '</span>';

  const STEM = fit('这是一个自造的待答队列测试题干');
  const OPTS = [
    fit('第一个自造选项的内容'), fit('第二个自造选项的内容'),
    fit('第三个自造选项的内容'), fit('第四个自造选项的内容'),
  ];
  const html = '<div class="item-body"><div class="item-type">1.单选题 (1分)</div>' +
    '<div class="problem-body"><p>' + span(enc(STEM)) + '？</p></div>' +
    '<ul>' + OPTS.map((o, i) => '<li><span class="radioInput">' + 'ABCD'[i] + '</span>' +
      '<span class="radioText"><p>' + span(enc(o)) + '</p></span></li>').join('') + '</ul></div>';

  // I1：入队
  const r1 = await req(PORT, 'POST', '/api/inbox', { html, fontUrl: FONT_URL, text: 'OCR 文本占位' });
  check('I1 入队返回 ok + key', r1.json && r1.json.ok === true && !!r1.json.key, JSON.stringify(r1.json).slice(0, 150));
  const key = r1.json && r1.json.key;

  // I2：入队时就把明文还原好了（Agent 一取就能直接答）
  const q = String((r1.json && r1.json.question) || '').replace(/\s+/g, '');
  check('I2 队列里直接就是明文题面', q.indexOf(STEM.replace(/\s+/g, '')) >= 0, q.slice(0, 100));
  check('I3 明文里含四个选项', OPTS.every(o => q.indexOf(o.replace(/\s+/g, '')) >= 0), q.slice(0, 200));

  // I4：队列列表
  const r2 = await req(PORT, 'GET', '/api/inbox');
  check('I4 GET /api/inbox 能列出待答题', r2.json && r2.json.count === 1, JSON.stringify(r2.json).slice(0, 120));
  check('I5 队列项标记为未作答', r2.json && r2.json.items[0] && r2.json.items[0].answered === false);

  // I6：Agent 写答案（按 key）
  const r3 = await req(PORT, 'POST', '/api/answers', { items: [{ key, answer: 'B', note: '测试写入' }] });
  check('I6 写入答案成功', r3.json && r3.json.written === 1, JSON.stringify(r3.json).slice(0, 120));

  // I7：脚本轮询能取到答案
  const r4 = await req(PORT, 'GET', '/api/inbox/answer?key=' + encodeURIComponent(key));
  check('I7 轮询取回答案 B', r4.json && r4.json.answered === true && r4.json.answer === 'B', JSON.stringify(r4.json));

  // I8：落盘（跨重启不丢）
  const inboxFile = path.join(iso.dir, 'inbox.json');
  check('I8 队列已落盘', fs.existsSync(inboxFile) && fs.readFileSync(inboxFile, 'utf8').indexOf(STEM) >= 0,
    fs.existsSync(inboxFile) ? fs.readFileSync(inboxFile, 'utf8').slice(0, 120) : '(文件不存在)');

  // I9：pending 过滤
  const r5 = await req(PORT, 'GET', '/api/inbox?pending=1');
  check('I9 pending=1 只返回未作答的（此时应为空）', r5.json && r5.json.count === 0, JSON.stringify(r5.json).slice(0, 120));

  iso.stop();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
