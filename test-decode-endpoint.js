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

  // 造一段**自造**的加密原文。
  // 注意：不能用课程里的真实题目做夹具 —— 仓库要能公开，测试夹具里也不能留题库内容。
  // 做法：用字体的「假字 -> 真字」映射表建逆映射，把自造的题干/选项加密成密文，
  //       再断言服务端能原样还原回去（round-trip）。
  const mapFile = path.join(LAB, 'fonts', 'exam_font_9e8180041a384270bb2b2dd5deb08b89.ttf.map.json');
  const fmap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const inv = {};
  for (const [fake, real] of Object.entries(fmap)) inv[real] = fake;
  const reals = [...new Set(Object.values(fmap))];
  // 字体字符集里没有的字没法编码 -> 统一替换成集内字，保证「密文->明文」可逆
  const fallbackReal = reals[0];
  const fit = (s) => [...s].map(c => (inv[c] ? c : fallbackReal)).join('');
  const enc = (s) => [...s].map(c => inv[c]).join('');

  const STEM = fit('这是一个自造的测试题干用于验证解码链路');
  const OPTS = [
    fit('选项甲的具体内容'), fit('选项乙的具体内容'),
    fit('选项丙的具体内容'), fit('选项丁的具体内容'),
  ];
  const encStem = enc(STEM);
  const encOpts = OPTS.map(enc);
  const span = (t) => '<span class="xuetangx-com-encrypted-font">' + t + '</span>';
  const html = '<div class="item-body"><p>' + span(encStem) + '？</p>' +
    '<ul>' + encOpts.map(o => '<li><p>' + span(o) + '</p></li>').join('') + '</ul></div>';

  // D1：带字体 URL -> 能还原
  const t0 = Date.now();
  const r1 = await postJSON(PORT, '/api/decode', { html, fontUrl: FONT_URL });
  const dt = Date.now() - t0;
  console.log('  （首次解码耗时 ' + dt + 'ms，含下载字体 + 建映射）');
  check('D1 /api/decode 返回 ok', r1 && r1.ok === true, JSON.stringify(r1).slice(0, 200));
  check('D2 映射表非空', r1 && r1.mapSize > 800, 'mapSize=' + (r1 && r1.mapSize));
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  check('D3 明文还原出自造题干',
    !!(r1 && r1.text && norm(r1.text).indexOf(norm(STEM)) >= 0),
    r1 && r1.text ? r1.text.slice(0, 120) : '(空)');
  check('D4 四个选项都还原成真字',
    !!(r1 && r1.text && OPTS.every(o => norm(r1.text).indexOf(norm(o)) >= 0)),
    r1 && r1.text ? r1.text.slice(0, 200) : '(空)');

  // D5：第二次应该走缓存（很快）
  const t1 = Date.now();
  const r2 = await postJSON(PORT, '/api/decode', { html, fontUrl: FONT_URL });
  const dt2 = Date.now() - t1;
  check('D5 第二次解码命中缓存（< ' + Math.max(2000, dt) + 'ms）', dt2 < Math.max(2000, dt), dt2 + 'ms');
  check('D6 两次结果一致', r1 && r2 && r1.text === r2.text);

  // D7：没有 fontUrl 时，**绝不能返回错误的明文**。
  // [v13] 服务端新增了「兜底解码」：遍历本地映射表，用中文二元组连贯性挑出正确的那一份。
  // 所以现在有两种合法结果：① 没找到可用映射表 -> 明确失败返回空；② 找到了 -> 返回**正确**明文。
  // 不合法的是：返回一堆乱码当明文。
  const r3 = await postJSON(PORT, '/api/decode', { html, fontUrl: '' });
  const r3Text = String((r3 && r3.text) || '');
  const r3Correct = r3Text && norm(r3Text).indexOf(norm(STEM)) >= 0;
  check('D7 无 fontUrl 时不返回错误明文（要么明确失败，要么给出正确明文）',
    r3 && (r3.ok === false ? !r3Text : r3Correct),
    JSON.stringify(r3).slice(0, 160));

  // D8：字体文件已落盘
  const fontDir = path.join(iso.dir, 'fonts');
  const files = fs.existsSync(fontDir) ? fs.readdirSync(fontDir) : [];
  check('D8 字体已落盘到实例目录', files.some(f => /exam_font_.*\.ttf$/.test(f)), files.join(','));

  iso.stop();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
