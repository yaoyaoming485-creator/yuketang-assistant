// ============================================================================
// v11 端到端测试：中转站 /api/decode —— 用真字体把加密题面还原成明文
// 场景：脚本上传加密原文 + 混淆字体 URL -> 中转站下载字体 -> 建映射 -> 返回明文
// 全部跑在隔离实例上，不碰用户数据
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startIsolatedBridge } = require('./test-harness');

const LAB = __dirname;
const PORT = 8905;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`); }
}

function postJSON(port, p, obj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj));
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const iso = await startIsolatedBridge(PORT, 'decode');
  console.log('  （隔离实例 ' + iso.base + '）');

  const FONT_URL = 'https://fe-static-yuketang.yuketang.cn/fe_font/product/exam_font_9e8180041a384270bb2b2dd5deb08b89.ttf';

  // 造一段真实的加密原文（和线上抓到的同款结构）
  const html = '<div class="item-body"><p>哈佛<span class="xuetangx-com-encrypted-font">甲乙丙丁戊己庚辛壬癸</span>？</p>' +
    '<ul><li><p><span class="xuetangx-com-encrypted-font">子丑寅卯辰巳</span></p></li>' +
    '<li><p><span class="xuetangx-com-encrypted-font">午未申酉戌</span></p></li>' +
    '<li><p><span class="xuetangx-com-encrypted-font">亥子丑寅卯辰</span></p></li>' +
    '<li><p>MLA<span class="xuetangx-com-encrypted-font">巳午未申酉</span></p></li></ul></div>';

  // D1：带字体 URL -> 能还原
  const t0 = Date.now();
  const r1 = await postJSON(PORT, '/api/decode', { html, fontUrl: FONT_URL });
  const dt = Date.now() - t0;
  console.log('  （首次解码耗时 ' + dt + 'ms，含下载字体 + 建映射）');
  check('D1 /api/decode 返回 ok', r1 && r1.ok === true, JSON.stringify(r1).slice(0, 200));
  check('D2 映射表非空', r1 && r1.mapSize > 800, 'mapSize=' + (r1 && r1.mapSize));
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  check('D3 明文含「一道示例题目的题干」',
    !!(r1 && r1.text && norm(r1.text).indexOf('一道示例题目的题干') >= 0),
    r1 && r1.text ? r1.text.slice(0, 120) : '(空)');
  check('D4 四个选项都还原成真字',
    !!(r1 && r1.text && norm(r1.text).indexOf('注释引证式') >= 0 && norm(r1.text).indexOf('插句式') >= 0 &&
       norm(r1.text).indexOf('循环数字编码式') >= 0 && norm(r1.text).indexOf('MLA') >= 0),
    r1 && r1.text ? r1.text.slice(0, 200) : '(空)');

  // D5：第二次应该走缓存（很快）
  const t1 = Date.now();
  const r2 = await postJSON(PORT, '/api/decode', { html, fontUrl: FONT_URL });
  const dt2 = Date.now() - t1;
  check('D5 第二次解码命中缓存（< ' + Math.max(2000, dt) + 'ms）', dt2 < Math.max(2000, dt), dt2 + 'ms');
  check('D6 两次结果一致', r1 && r2 && r1.text === r2.text);

  // D7：没有字体时不能瞎猜，必须明确失败
  const r3 = await postJSON(PORT, '/api/decode', { html, fontUrl: '' });
  check('D7 无 fontUrl 时不编造明文', r3 && r3.ok === false && !r3.text, JSON.stringify(r3).slice(0, 160));

  // D8：字体文件已落盘
  const fontDir = path.join(iso.dir, 'fonts');
  const files = fs.existsSync(fontDir) ? fs.readdirSync(fontDir) : [];
  check('D8 字体已落盘到实例目录', files.some(f => /exam_font_.*\.ttf$/.test(f)), files.join(','));

  iso.stop();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
