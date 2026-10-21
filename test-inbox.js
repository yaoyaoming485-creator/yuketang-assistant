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

  const html = '<div class="item-body"><div class="item-type">3.单选题 (1分)</div>' +
    '<div class="problem-body"><p>哈佛<span class="xuetangx-com-encrypted-font">甲乙丙丁戊己庚辛壬癸</span>？</p></div>' +
    '<ul><li><span class="radioInput">A</span><span class="radioText"><p><span class="xuetangx-com-encrypted-font">子丑寅卯辰巳</span></p></span></li>' +
    '<li><span class="radioInput">B</span><span class="radioText"><p><span class="xuetangx-com-encrypted-font">午未申酉戌</span></p></span></li>' +
    '<li><span class="radioInput">C</span><span class="radioText"><p><span class="xuetangx-com-encrypted-font">亥子丑寅卯辰</span></p></span></li>' +
    '<li><span class="radioInput">D</span><span class="radioText"><p>MLA<span class="xuetangx-com-encrypted-font">巳午未申酉</span></p></span></li></ul></div>';

  // I1：入队
  const r1 = await req(PORT, 'POST', '/api/inbox', { html, fontUrl: FONT_URL, text: 'OCR 文本占位' });
  check('I1 入队返回 ok + key', r1.json && r1.json.ok === true && !!r1.json.key, JSON.stringify(r1.json).slice(0, 150));
  const key = r1.json && r1.json.key;

  // I2：入队时就把明文还原好了（Agent 一取就能直接答）
  const q = String((r1.json && r1.json.question) || '').replace(/\s+/g, '');
  check('I2 队列里直接就是明文题面', q.indexOf('一道示例题目的题干') >= 0, q.slice(0, 100));
  check('I3 明文里含四个选项', q.indexOf('注释引证式') >= 0 && q.indexOf('插句式') >= 0 &&
    q.indexOf('循环数字编码式') >= 0 && q.indexOf('MLA') >= 0, q.slice(0, 200));

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
  check('I8 队列已落盘', fs.existsSync(inboxFile) && fs.readFileSync(inboxFile, 'utf8').indexOf('哈佛') >= 0);

  // I9：pending 过滤
  const r5 = await req(PORT, 'GET', '/api/inbox?pending=1');
  check('I9 pending=1 只返回未作答的（此时应为空）', r5.json && r5.json.count === 0, JSON.stringify(r5.json).slice(0, 120));

  iso.stop();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
