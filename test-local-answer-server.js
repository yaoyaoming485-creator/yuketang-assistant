// 本地答案中转站 端到端自检
// 覆盖：健康检查 / 截图采集 / 同图去重 / 挂起等待命中 / 缓存命中 / 列表
const http = require('http');
const fs = require('fs');
const path = require('path');

const { startIsolatedBridge } = require('./test-harness');
const PORT = parseInt(process.env.BRIDGE_PORT || '8902', 10);
const HOST = '127.0.0.1';
const IMG = path.join(__dirname, 'deliverables', '示例题目截图.png');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`); }
}

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST, port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeRequest(imgDataUrl, text, wait) {
  return {
    model: 'minimax-local',
    temperature: 0.1,
    messages: [
      { role: 'system', content: '你是一个考试答题助手。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: (text || '自测') + '\n\n【OCR 文本（仅供参考，可能有误）】\n单选题 以下哪一项最准确地描述了机器学习中的过拟合现象' },
          { type: 'image_url', image_url: { url: imgDataUrl } },
        ],
      },
    ],
  };
}

(async () => {
  const iso = await startIsolatedBridge(PORT, 'local');
  console.log('  （隔离实例 ' + iso.base + '，不碰用户数据）');
  console.log('== 本地答案中转站 自检 ==\n');

  // T0 清场（保证测试不受上一轮缓存影响）—— 但要先备份，测完恢复，
  // 否则会把用户真实刷课过程中积累的答案一起清掉。
  const fs = require('fs');
  const path = require('path');
  const CACHE_FILE = path.join(__dirname, 'answer-cache.json');
  const backup = fs.existsSync(CACHE_FILE) ? fs.readFileSync(CACHE_FILE, 'utf8') : null;
  const t0 = await call('POST', '/api/reset', {});
  check('T0 POST /api/reset 清空缓存与截图', t0.status === 200 && t0.json && t0.json.ok === true, JSON.stringify(t0.json));

  // T1 健康检查
  const h = await call('GET', '/api/health');
  check('T1 GET /api/health 返回 200', h.status === 200 && h.json && h.json.ok === true, JSON.stringify(h.json));

  // 准备图片
  if (!fs.existsSync(IMG)) { console.log('缺少自测图片:', IMG); process.exit(1); }
  const buf = fs.readFileSync(IMG);
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');

  // T2 采集（wait=0，立即 PENDING）
  const t2 = await call('POST', '/v1/chat/completions?wait=0', makeRequest(dataUrl, '自测题目A'));
  const c2 = t2.json && t2.json.choices && t2.json.choices[0].message.content;
  check('T2 采集轮返回 PENDING', t2.status === 200 && c2 === '__PENDING__', `status=${t2.status} content=${c2}`);

  // T3 去重：同一张图再来一次，shots 不应增加
  const list3 = await call('GET', '/api/shots');
  const n3 = list3.json ? list3.json.count : -1;
  await call('POST', '/v1/chat/completions?wait=0', makeRequest(dataUrl, '自测题目A'));
  const list3b = await call('GET', '/api/shots');
  check('T3 相同图片+相同OCR文本被去重（数量不变）', n3 >= 1 && list3b.json.count === n3, `before=${n3} after=${list3b.json.count}`);

  // T4 挂起等待 + 外部写入答案 -> 应返回 "正确答案：A"
  const pending = call('POST', '/v1/chat/completions?wait=8000', makeRequest(dataUrl, '自测题目A'));
  await new Promise(r => setTimeout(r, 700));
  const seq = list3b.json.shots[list3b.json.shots.length - 1].seq;
  const w = await call('POST', '/api/answer', { seq, answer: 'A' });
  check('T4 POST /api/answer 写入成功', w.status === 200 && w.json && w.json.ok === true, JSON.stringify(w.json));
  const t4 = await pending;
  const c4 = t4.json && t4.json.choices && t4.json.choices[0].message.content;
  check('T4 挂起中的请求拿到 "正确答案：A"', c4 === '正确答案：A', `content=${c4}`);

  // T5 缓存命中
  const t5 = await call('POST', '/v1/chat/completions?wait=0', makeRequest(dataUrl, '自测题目A'));
  const c5 = t5.json && t5.json.choices && t5.json.choices[0].message.content;
  check('T5 缓存命中直接返回答案', c5 === '正确答案：A', `content=${c5}`);

  // T6 列表里带答案
  const list6 = await call('GET', '/api/shots');
  const answered = list6.json.shots.filter(s => s.answer).length;
  check('T6 /api/shots 含答案字段', answered >= 1, `answered=${answered}`);

  // T7 响应结构符合 OpenAI 兼容（脚本只读 choices[0].message.content）
  check('T7 响应含 choices[0].message.content', !!(t5.json.choices && t5.json.choices[0].message && typeof t5.json.choices[0].message.content === 'string'));

  // T8 纯文本请求（无图）不应崩
  const t8 = await call('POST', '/v1/chat/completions?wait=0', {
    model: 'minimax-local',
    messages: [{ role: 'user', content: '纯文本' }],
  });
  check('T8 纯文本请求返回 PENDING 而非报错', t8.status === 200, `status=${t8.status}`);

  // T9 /v1/models
  const t9 = await call('GET', '/v1/models');
  check('T9 /v1/models 可用', t9.status === 200 && t9.json && Array.isArray(t9.json.data));

  // T10 批量写答案
  const t10 = await call('POST', '/api/answers', { items: [{ seq: 1, answer: 'A' }] });
  check('T10 POST /api/answers 批量写入可用', t10.status === 200 && t10.json && t10.json.written >= 1, JSON.stringify(t10.json));

  // T11 批量写入后立即能命中
  const t11 = await call('POST', '/v1/chat/completions?wait=0', makeRequest(dataUrl, '自测题目A'));
  const c11 = t11.json && t11.json.choices && t11.json.choices[0].message.content;
  check('T11 批量写入的答案可被命中', c11 === '正确答案：A', `content=${c11}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);

  // 恢复测试前的缓存（别把用户刷课积累的答案清掉）
  try {
    if (backup !== null) fs.writeFileSync(CACHE_FILE, backup, 'utf8');
    else if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    console.log('已恢复测试前的答案缓存');
  } catch (e) {
    console.log('恢复缓存失败：' + e.message);
  }

  iso.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('自检异常：', e);
  process.exit(1);
});
