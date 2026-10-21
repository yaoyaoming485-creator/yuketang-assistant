// ============================================================================
// 从 localStorage 快照里还原全部题目明文
// 难点：每次页面加载，雨课堂都会重新随机置换一次密文（9 份字体 = 9 种置换）
// 判别方法：用本地中文语料建二元组模型，统计「解密后相邻汉字对在语料中出现的比例」
//          正确置换 -> 真实句子，二元组命中率极高；错误置换 -> 随机字符，几乎为 0
// ============================================================================
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const OUT = path.join(LAB, '.test-runtime', 'ykt-api');
const FONTS = path.join(LAB, 'fonts');

// ---------- 1. 语料 -> 二元组集合 ----------
const CORPUS = [
  path.join(LAB, 'YuKeTang', 'answer', '2025秋-人工智能安全与伦理.txt'),
  path.join(LAB, 'deliverables', '作业一-答案与题面还原.md'),
  path.join(LAB, 'deliverables', '本地答题模式-使用说明.md'),
  path.join(LAB, 'README.md'),
  path.join(LAB, 'deliverables', '实测报告.md'),
];
const bigrams = new Set();
const unigrams = new Set();
for (const f of CORPUS) {
  if (!fs.existsSync(f)) continue;
  const t = fs.readFileSync(f, 'utf8');
  const han = t.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < han.length; i++) {
    unigrams.add(han[i]);
    if (i + 1 < han.length) bigrams.add(han[i] + han[i + 1]);
  }
}
console.log('语料：' + unigrams.size + ' 个汉字，' + bigrams.size + ' 个二元组');

// ---------- 2. 字体映射表 ----------
const fontMaps = {};
for (const f of fs.readdirSync(FONTS)) {
  if (!f.endsWith('.map.json')) continue;
  const name = f.replace(/\.map\.json$/, '');
  fontMaps[name] = JSON.parse(fs.readFileSync(path.join(FONTS, f), 'utf8'));
}
const fontNames = Object.keys(fontMaps);
console.log('字体映射：' + fontNames.length + ' 份\n');

// ---------- 3. 解密 ----------
const SPAN_RE = /<span\b[^>]*class\s*=\s*["'][^"']*\bxuetangx-com-encrypted-font\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;

function decodeHtml(html, map) {
  if (!html) return '';
  let out = html.replace(SPAN_RE, (all, inner) => {
    let s = '';
    for (const ch of inner) s += (map[ch] !== undefined ? map[ch] : ch);
    return s;
  });
  // 去标签
  out = out.replace(/<!DOCTYPE[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ');
  out = out.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return out.replace(/\s+/g, ' ').trim();
}

function score(text) {
  let hit = 0, tot = 0;
  const han = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 1 < han.length; i++) {
    tot++;
    if (bigrams.has(han[i] + han[i + 1])) hit++;
  }
  return tot ? hit / tot : 0;
}

// ---------- 4. 快照 ----------
const ls = JSON.parse(fs.readFileSync(path.join(OUT, 'localstorage.json'), 'utf8'));
const snaps = [];
for (const k of Object.keys(ls)) {
  if (!k.startsWith('iframe-exercise-')) continue;
  const m = /^iframe-exercise-(\d+)-(\d+)/.exec(k);
  let j;
  try { j = JSON.parse(ls[k]); } catch (e) { continue; }
  const probs = {};
  for (const [pid, p] of Object.entries(j.problems || {})) {
    if (pid.endsWith('_group')) continue;
    const c = p.content || {};
    probs[pid] = { pid, type: c.TypeText || '', score: c.score, body: c.Body || '', options: c.Options || [], user: p._answer };
  }
  snaps.push({ key: k, exId: m[2], probs });
}
snaps.sort((a, b) => (a.key < b.key ? -1 : 1));

// ---------- 5. 给每个快照选字体 ----------
console.log('=== 快照 × 字体 二元组命中率矩阵 ===');
const hdr = '  快照'.padEnd(50) + fontNames.map(n => n.replace('exam_font_', '').slice(0, 6).padStart(8)).join('');
console.log(hdr);
const chosen = [];
for (const s of snaps) {
  const row = [];
  const best = { score: -1, font: null };
  for (const fn of fontNames) {
    let text = '';
    for (const p of Object.values(s.probs)) {
      text += decodeHtml(p.body, fontMaps[fn]);
      for (const o of p.options) text += decodeHtml(o.value || o, fontMaps[fn]);
    }
    const sc = score(text);
    row.push(sc);
    if (sc > best.score) { best.score = sc; best.font = fn; }
  }
  chosen.push({ snap: s, font: best.font, score: best.score });
  console.log('  ' + (s.exId + ' #' + (chosen.length)).padEnd(48) +
    row.map(v => (v * 100).toFixed(1).padStart(8)).join('') + '   -> ' + best.font.replace('exam_font_', '').slice(0, 8) +
    ' (' + (best.score * 100).toFixed(1) + '%)');
}

// ---------- 6. 导出明文：逐题选最优 (快照, 字体) 组合 ----------
const result = {};
const conf = {};
for (const snap of snaps) {
  for (const [pid, p] of Object.entries(snap.probs)) {
    let best = null;
    for (const fn of fontNames) {
      const map = fontMaps[fn];
      const body = decodeHtml(p.body, map);
      const opts = p.options.map(o => ({ key: o.key, text: decodeHtml(o.value || o, map) }));
      const all = body + ' ' + opts.map(o => o.text).join(' ');
      const sc = score(all);
      if (!best || sc > best.sc) best = { sc, font: fn, body, opts };
    }
    const exId = snap.exId;
    result[exId] = result[exId] || { exercise: exId, questions: {} };
    const cur = result[exId].questions[pid];
    if (!cur || best.sc > cur.sc) {
      result[exId].questions[pid] = {
        pid, type: p.type, score: p.score,
        body: best.body, options: best.opts,
        userAnswer: p.user, sc: best.sc, font: best.font, snapKey: snap.key,
      };
    }
  }
}
for (const ex of Object.values(result)) {
  for (const q of Object.values(ex.questions)) conf[q.pid] = q.sc;
}
fs.writeFileSync(path.join(OUT, 'decoded-questions.json'), JSON.stringify(result, null, 2), 'utf8');

// 可读版
const lines = [];
for (const [exId, ex] of Object.entries(result)) {
  lines.push('\n' + '='.repeat(78));
  lines.push('作业 ' + exId + '   共 ' + Object.keys(ex.questions).length + ' 题');
  lines.push('='.repeat(78));
  const pids = Object.keys(ex.questions).sort();
  pids.forEach((pid, i) => {
    const q = ex.questions[pid];
    const c = q.sc >= 0.15 ? 'OK ' : (q.sc >= 0.05 ? '低 ' : '★差');
    lines.push('\n[' + (i + 1) + '] ' + (q.type || '?') + '（' + q.score + '分）  PID=' + pid + '  置信度=' + (q.sc * 100).toFixed(0) + '% ' + c);
    lines.push('  题干: ' + q.body);
    for (const o of q.options) lines.push('    ' + o.key + '. ' + o.text);
    if (q.userAnswer !== undefined && q.userAnswer !== null && q.userAnswer !== '') {
      lines.push('  [用户已提交]: ' + JSON.stringify(q.userAnswer));
    }
  });
}
fs.writeFileSync(path.join(OUT, 'decoded-questions.txt'), lines.join('\n'), 'utf8');
console.log('\n已导出: ' + path.join(OUT, 'decoded-questions.txt'));
const bad = Object.entries(conf).filter(([, v]) => v < 0.15);
console.log('低置信度题目: ' + bad.length + (bad.length ? ' -> ' + bad.map(([k, v]) => k + '(' + (v * 100).toFixed(0) + '%)').join(', ') : ''));
