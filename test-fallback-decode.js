// ============================================================================
// 验证 v13 兜底解码：脚本上报的 fontUrl 不可用（抓错字体 / 压根没上报）时，
// 服务端能自己遍历本地映射表、用中文二元组连贯性挑出正确的那一份。
// 用隔离实例，真实数据零污染。
// ============================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startIsolatedBridge } = require('./test-harness');

const LAB = __dirname;
const PORT = 8911;
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

const WRONG_FONTS = [
  ['抓错成 MathJax（v11~v12 的真实故障）',
    'https://fe-static-yuketang.yuketang.cn/fe/static/js/mathjax/fonts/HTML-CSS/TeX/woff/MathJax_Size1-Regular.woff?rev=2.4-beta-2'],
  ['上报另一份考试字体（置换不对）', null],
  ['干脆不报（空 URL）', ''],
];

(async () => {
  const iso = await startIsolatedBridge(PORT, 'fallback');
  for (const f of fs.readdirSync(path.join(LAB, 'fonts'))) {
    // .ttf 和 .map.json 都要拷：兜底解码靠遍历**本地映射表**，缺了就无从可选
    if (f.endsWith('.ttf') || f.endsWith('.map.json')) {
      fs.copyFileSync(path.join(LAB, 'fonts', f), path.join(iso.dir, 'fonts', f));
    }
  }
  console.log('隔离实例 ' + iso.base);

  // 取两道题的**原始密文 HTML**（class 完整）
  const ls = JSON.parse(fs.readFileSync(path.join(API_DIR, 'localstorage.json'), 'utf8'));
  const decoded = JSON.parse(fs.readFileSync(path.join(API_DIR, 'decoded-questions.json'), 'utf8'));
  const rawBySnap = {};
  for (const k of Object.keys(ls)) {
    if (!k.startsWith('iframe-exercise-')) continue;
    let j; try { j = JSON.parse(ls[k]); } catch (e) { continue; }
    rawBySnap[k] = {};
    for (const [pid, p] of Object.entries(j.problems || {})) {
      if (pid.endsWith('_group')) continue;
      const c = p.content || {};
      rawBySnap[k][pid] = { body: c.Body || '', options: c.Options || [], type: c.TypeText || '' };
    }
  }
  // 选两题：题干较长的（更能体现连贯度差异）
  const picks = [];
  for (const ex of Object.values(decoded)) {
    for (const q of Object.values(ex.questions)) {
      if (q.body.length > 25 && picks.length < 2) picks.push(q);
    }
  }

  const fontNames = fs.readdirSync(path.join(LAB, 'fonts')).filter(f => f.endsWith('.ttf'));
  const FONT_URL = (f) => 'https://fe-static-yuketang.yuketang.cn/fe_font/product/' + f;

  let pass = 0, fail = 0;
  for (const q of picks) {
    const raw = rawBySnap[q.snapKey][q.pid];
    const optHtml = raw.options.map(o =>
      `<li><span class="radioInput">${o.key}</span><span class="radioText">${o.value || ''}</span></li>`).join('');
    const html = `<div class="item-body"><div class="item-type">${raw.type}</div>` +
      `<div class="problem-body">${raw.body}</div><ul>${optHtml}</ul></div>`;
    const expect = q.body;
    // 比对时只留汉字：服务端 htmlToText 会在标签处插空格，逐字比对会误判
    const cjkOnly = (s) => String(s || '').replace(/[^一-鿿]/g, '');
    const expectCjk = cjkOnly(expect).slice(0, 20);
    console.log('\n' + '='.repeat(74));
    console.log('题目 PID=' + q.pid + '（正确字体 ' + q.font.replace('exam_font_', '').slice(0, 10) + '）');

    const otherFont = fontNames.find(f => f !== q.font && f.startsWith('exam_font_'));
    const cases = [
      WRONG_FONTS[0],
      ['上报另一份考试字体（置换不对）', FONT_URL(otherFont)],
      WRONG_FONTS[2],
    ];
    for (const [label, fontUrl] of cases) {
      const r = await req(PORT, 'POST', '/api/decode', { html, fontUrl });
      const got = String((r && r.text) || '');
      const ok = cjkOnly(got).indexOf(expectCjk) >= 0;
      if (ok) pass++; else fail++;
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label);
      console.log('        ' + got.slice(0, 100));
    }
  }

  try { iso.stop(); } catch (e) { }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('失败: ' + e.stack); process.exit(1); });
