// 测试中转站的「页面标准答案自动提取」功能（v7）
// 做法：从成品 local-answer-server.js 里抽出 extractPageAnswer 真跑，再用真实中转站做端到端。
const fs = require('fs');
const path = require('path');
const http = require('http');

const LAB = __dirname;
const SERVER_JS = path.join(LAB, 'local-answer-server.js');
const IMG = path.join(LAB, 'deliverables', '示例题目截图.png');
const { startIsolatedBridge } = require('./test-harness');
let BRIDGE = 'http://127.0.0.1:8903';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`); }
}

// ---- 从成品服务端里抽出函数真跑 ----
const src = fs.readFileSync(SERVER_JS, 'utf8');
const m = /function extractPageAnswer\(text\) \{[\s\S]*?\n\}/.exec(src);
if (!m) { console.error('抽不出 extractPageAnswer'); process.exit(1); }
const extractPageAnswer = eval('(' + m[0].replace(/^function extractPageAnswer/, 'function') + ')');

// 真实的中转站收到的 text 结构（system + visionPrompt + 【OCR 文本】+ OCR结果）
const PROMPT = `你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。
下面是题目的截图（可能同时包含题干和选项）。请以【截图】为准读题；OCR 文本仅供参考，可能有识别错误。
强约束：
1) 本题只有 4 个选项，范围 A-D
2) 输出格式必须包含"正确答案："前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错`;
const MARK = '\n\n【OCR 文本（仅供参考，可能有误）】\n';

console.log('== 中转站「页面标准答案自动提取」测试 ==\n');

console.log('-- 单元：extractPageAnswer --');
check('U1 页面答案栏（OCR 插空格）能提取出 ABC',
  extractPageAnswer(PROMPT + MARK + '‖ 1. 多 选 题 (2 分 … 本 题 得 分 : 2 正 确 答 案 : ABC ( 少 选 不 得 分 )') === 'ABC',
  extractPageAnswer(PROMPT + MARK + '本 题 得 分 : 2 正 确 答 案 : ABC'));
check('U2 没有 OCR 分隔标记时不提取（避免误取 prompt 示例）',
  extractPageAnswer(PROMPT) === null, extractPageAnswer(PROMPT));
check('U3 只有 prompt 示例、OCR 里没答案栏 -> null',
  extractPageAnswer(PROMPT + MARK + '‖ 1. 多 选 题 (2 分 1. 绝 十 敏 叙') === null,
  extractPageAnswer(PROMPT + MARK + '‖ 1. 多 选 题 (2 分 1. 绝 十 敏 叙'));
check('U4 OCR 把 ABC 读成 A8C 时保守拒绝',
  extractPageAnswer(PROMPT + MARK + '正 确 答 案 : A8C') === null,
  extractPageAnswer(PROMPT + MARK + '正 确 答 案 : A8C'));
check('U5 多选答案 ABD 能提取',
  extractPageAnswer(PROMPT + MARK + '正 确 答 案 : ABD') === 'ABD');
check('U6 取最后一个匹配（OCR 在后，覆盖 prompt 的示例）',
  extractPageAnswer(PROMPT + MARK + '正 确 答 案 : A 正 确 答 案 : BCD') === 'BCD');
check('U7 判断题答案「对」不误判为字母',
  extractPageAnswer(PROMPT + MARK + '正 确 答 案 : 对') === null);
// U8：实测 OCR 把「正确答案」四个字认成「I 确 吉 栾」（真实数据）——
//     主锚点改用「本题得分：N」后面的字母才能提取到
check('U8 OCR 把「正确答案」认成「I 确 吉 栾」时仍能提取到 A',
  extractPageAnswer(PROMPT + MARK + '… 本 题 得 分 : 0 I 确 吉 栾 : A') === 'A',
  extractPageAnswer(PROMPT + MARK + '… 本 题 得 分 : 0 I 确 吉 栾 : A'));
check('U9 「本题得分：2 正确答案：ABC」能提取 ABC',
  extractPageAnswer(PROMPT + MARK + '本 题 得 分 : 2 正 确 答 案 : ABC ( 少 选 不 得 分 )') === 'ABC');
check('U10 得分后跟多选答案 BD 能提取',
  extractPageAnswer(PROMPT + MARK + '本 题 得 分 : 2 I 确 吉 栾 : BD') === 'BD');

// ---- 端到端：真实中转站 ----
console.log('\n-- 端到端：真实中转站 --');
function postJSON(url, obj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}
function getJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw }); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const iso = await startIsolatedBridge(8903, 'extract');
  BRIDGE = iso.base;
  console.log('  （隔离实例 ' + iso.base + '，不碰用户数据）');
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(IMG).toString('base64');

  // 备份答案缓存，测完恢复 —— 别把用户刷课积累的答案冲掉
  const CACHE_FILE = path.join(LAB, 'answer-cache.json');
  const backup = fs.existsSync(CACHE_FILE) ? fs.readFileSync(CACHE_FILE, 'utf8') : null;
  try {
    // E1：带答案栏的请求 -> 立即返回标准答案，不挂起
    const t0 = Date.now();
    const r1 = await postJSON(BRIDGE + '/v1/chat/completions?wait=60000', {
      model: 'minimax-local',
      messages: [{ role: 'system', content: '你是一个只输出答案的助手。' },
        { role: 'user', content: [
          { type: 'text', text: PROMPT + MARK + '‖ 1. 多 选 题 (2 分 … 本 题 得 分 : 2 正 确 答 案 : ABC ( 少 选 不 得 分 )' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] }],
    });
    const dt = Date.now() - t0;
    const c1 = r1.choices && r1.choices[0] && r1.choices[0].message.content;
    check('E1 带答案栏的请求直接返回 "正确答案：ABC"', c1 === '正确答案：ABC', `content=${c1}`);
    check('E2 立即返回（没有干等 60 秒）', dt < 5000, dt + 'ms');

    // E3：答案已写进缓存
    const shots = await getJSON(BRIDGE + '/api/shots');
    const answered = (shots.shots || []).filter(s => s.answer).length;
    check('E3 标准答案已写入缓存', answered >= 1, answered);

    // E4：没有答案栏的请求 -> 挂起/PENDING，不误返回
    const r4 = await postJSON(BRIDGE + '/v1/chat/completions?wait=0', {
      model: 'minimax-local',
      messages: [{ role: 'system', content: 'x' },
        { role: 'user', content: [
          { type: 'text', text: PROMPT + MARK + '‖ 1. 多 选 题 (2 分 1. 绝 十 敏 叙' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] }],
    });
    const c4 = r4.choices && r4.choices[0] && r4.choices[0].message.content;
    check('E4 无答案栏时返回 PENDING（不误判）', c4 === '__PENDING__', `content=${c4}`);
  } finally {
    try {
      if (backup !== null) fs.writeFileSync(CACHE_FILE, backup, 'utf8');
      else if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    } catch (e) { /* ignore */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  iso.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常：', e); process.exit(1); });
