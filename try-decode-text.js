// 用 inbox 的 text 字段（原密文，无 class 标记）逐张映射表试解码
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const FONTS = path.join(LAB, 'fonts');
const INBOX = path.join(LAB, 'inbox.json');

const CORPUS = [
  path.join(LAB, 'YuKeTang', 'answer', '2025秋-人工智能安全与伦理.txt'),
  path.join(LAB, 'deliverables', '作业一-答案与题面还原.md'),
  path.join(LAB, 'deliverables', '本地答题模式-使用说明.md'),
  path.join(LAB, 'README.md'),
  path.join(LAB, 'deliverables', '实测报告.md'),
];
const bigrams = new Set();
for (const f of CORPUS) {
  if (!fs.existsSync(f)) continue;
  const han = fs.readFileSync(f, 'utf8').replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 1 < han.length; i++) bigrams.add(han[i] + han[i + 1]);
}
function score(t) {
  const han = t.replace(/[^\u4e00-\u9fff]/g, '');
  let hit = 0, tot = 0;
  for (let i = 0; i + 1 < han.length; i++) { tot++; if (bigrams.has(han[i] + han[i + 1])) hit++; }
  return tot ? hit / tot : 0;
}

const maps = [];
for (const f of fs.readdirSync(FONTS)) {
  if (!f.endsWith('.map.json')) continue;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(FONTS, f), 'utf8'));
    if (m && Object.keys(m).length > 10) maps.push({ name: f.replace(/\.map\.json$/, ''), map: m });
  } catch (e) { }
}

const inbox = JSON.parse(fs.readFileSync(INBOX, 'utf8'));
for (const [key, item] of Object.entries(inbox)) {
  console.log('='.repeat(78));
  console.log('key: ' + key);
  console.log('html 里还有没有 encrypted-font class: ' + (String(item.html || '').includes('xuetangx-com-encrypted-font') ? '有' : '★没有（已被脚本剥掉）'));
  const text = String(item.text || '');
  const ranked = maps.map(m => {
    const dec = text.split('').map(ch => (m.map[ch] !== undefined ? m.map[ch] : ch)).join('');
    return { name: m.name, sc: score(dec), dec };
  }).sort((a, b) => b.sc - a.sc);
  for (const r of ranked.slice(0, 5)) {
    console.log('  [' + r.name.replace('exam_font_', '').slice(0, 10) + '] ' + (r.sc * 100).toFixed(1) + '%');
  }
  const best = ranked[0];
  if (best.sc > 0.12) {
    console.log('\n  ★ 最佳: ' + best.name + ' (' + (best.sc * 100).toFixed(1) + '%)，次优 ' + (ranked[1].sc * 100).toFixed(1) + '%');
    console.log('\n' + best.dec + '\n');
  } else {
    console.log('\n  ★ 没有任何映射表解得通（最高 ' + (best.sc * 100).toFixed(1) + '%）—— 需要真正的字体文件');
    console.log('  原始 text: ' + text.slice(0, 200));
  }
}
