// ============================================================================
// 端到端验证「离线答案库」整条链路：
//   原始密文 HTML（带 xuetangx-com-encrypted-font span）
//     -> 中转站按字体映射还原成明文
//     -> 指纹命中 answer-bank.json
//     -> 直接返回答案（脚本轮询即可拿到并提交）
// 用的是隔离实例，真实数据零污染。
// ============================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startIsolatedBridge } = require('./test-harness');

const LAB = __dirname;
const PORT = 8910;
const API_DIR = path.join(LAB, '.test-runtime', 'ykt-api');

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 60000,
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b, code: res.statusCode }); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('== 准备：拷贝字体 + 答案库到隔离实例 ==');
  const iso = await startIsolatedBridge(PORT, 'bank');
  const bankSrc = path.join(LAB, 'answer-bank.json');
  const bankDst = path.join(iso.dir, 'answer-bank.json');
  fs.copyFileSync(bankSrc, bankDst);
  for (const f of fs.readdirSync(path.join(LAB, 'fonts'))) {
    if (f.endsWith('.ttf') || f.endsWith('.map.json')) fs.copyFileSync(path.join(LAB, 'fonts', f), path.join(iso.dir, 'fonts', f));
  }
  console.log('  隔离实例 ' + iso.base + '  dir=' + iso.dir);

  // 关掉实例，用 --answer-bank 重启
  iso.stop();
  await new Promise(r => setTimeout(r, 1200));
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [
    path.join(LAB, 'local-answer-server.js'),
    '--port', String(PORT),
    '--cache', path.join(iso.dir, 'answer-cache.json'),
    '--shots', path.join(iso.dir, 'shots'),
    '--fonts', path.join(iso.dir, 'fonts'),
    '--inbox', path.join(iso.dir, 'inbox.json'),
    '--answer-bank', bankDst,
  ], { cwd: LAB, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { const h = await req(PORT, 'GET', '/api/health'); if (h && h.ok) break; } catch (e) { }
  }
  console.log('  ' + (log.match(/\[bridge\] 离线答案库已加载[^\n]*/) || ['(未看到答案库加载日志)'])[0]);

  // ---- 构造全部题目的原始密文 HTML ----
  // 快照来自两处：历史 dump（localstorage.json）与实时扫描（localstorage-live.json）
  const ls = JSON.parse(fs.readFileSync(path.join(API_DIR, 'localstorage.json'), 'utf8'));
  const livePath = path.join(API_DIR, 'localstorage-live.json');
  const live = fs.existsSync(livePath) ? JSON.parse(fs.readFileSync(livePath, 'utf8')) : {};
  const decoded = JSON.parse(fs.readFileSync(path.join(API_DIR, 'decoded-questions.json'), 'utf8'));
  const answers = JSON.parse(fs.readFileSync(path.join(LAB, 'answers-by-pid.json'), 'utf8'));

  // 快照 -> 原始题目 HTML（按 snapKey 索引）
  // 关键：密文 HTML 与字体必须来自**同一次页面加载**（同一次置换），
  // 否则服务端会用错误的映射表解出乱码。真实浏览器里两者天然同源。
  const rawBySnap = {};
  const scan = (obj, liveTag) => {
    for (const k of Object.keys(obj)) {
      if (!k.startsWith('iframe-exercise-')) continue;
      let j; try { j = JSON.parse(obj[k]); } catch (e) { continue; }
      const ex = (/^iframe-exercise-(\d+)-(\d+)/.exec(k) || [])[2] || '';
      const tag = liveTag ? ('live:' + ex) : k;
      rawBySnap[tag] = rawBySnap[tag] || {};
      for (const [pid, p] of Object.entries(j.problems || {})) {
        if (pid.endsWith('_group')) continue;
        const c = p.content || {};
        rawBySnap[tag][pid] = { body: c.Body || '', options: c.Options || [], type: c.TypeText || '' };
      }
    }
  }
  scan(ls, false);
  scan(live, true);
  // PID -> 字体 + 对应快照
  const fontOf = {};
  const snapOf = {};
  for (const ex of Object.values(decoded)) {
    for (const q of Object.values(ex.questions)) { fontOf[q.pid] = q.font; snapOf[q.pid] = q.snapKey; }
  }
  const FONT_URL = (file) => 'https://fe-static-yuketang.yuketang.cn/fe_font/product/' + file.replace(/\.map\.json$/, '');

  // ---- 逐题 POST ----
  let pass = 0, fail = 0;
  const failures = [];
  const pids = Object.keys(fontOf).sort();
  console.log('\n== 逐题投喂（' + pids.length + ' 道）==');
  for (const pid of pids) {
    const raw = (rawBySnap[snapOf[pid]] || {})[pid];
    if (!raw) { console.log('  ★ 找不到快照原始 HTML: ' + pid); fail++; continue; }
    const font = fontOf[pid];
    const exId = (Object.keys(decoded).find(e => decoded[e].questions[pid]) || '');
    const expect = (answers[exId] && answers[exId][pid] && answers[exId][pid].answer) || '';
    const optHtml = (raw.options || []).map(o =>
      `<li><span class="radioInput">${o.key}</span><span class="radioText">${o.value || ''}</span></li>`).join('');
    const html = `<div class="item-body"><div class="item-type">${raw.type}</div>` +
      `<div class="problem-body">${raw.body}</div><ul>${optHtml}</ul></div>`;
    const r = await req(PORT, 'POST', '/api/inbox', { html, fontUrl: FONT_URL(font), text: '' });
    const got = (r && r.answer) || '';
    if (r && r.fromBank && got === expect) { pass++; }
    else { fail++; failures.push({ pid, expect, got, fromBank: r && r.fromBank, q: (r && r.question || '').slice(0, 60) }); }
  }
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (failures.length) {
    console.log('\n  失败明细：');
    for (const f of failures.slice(0, 12)) {
      console.log('   PID=' + f.pid + ' 期望=' + f.expect + ' 实得=' + (f.got || '(空)') + ' fromBank=' + f.fromBank);
      console.log('        ' + f.q);
    }
  }

  // ---- 队列状态：应当全部 answered，没有待答 ----
  const pend = await req(PORT, 'GET', '/api/inbox?pending=1');
  const all = await req(PORT, 'GET', '/api/inbox');
  console.log('\n队列：共 ' + (all.count || 0) + ' 条，待答 ' + (pend.count || 0) + ' 条');

  try { child.kill(); } catch (e) { }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 && pend.count === 0 ? 0 : 1);
})().catch(e => { console.error('失败: ' + e.stack); process.exit(1); });
