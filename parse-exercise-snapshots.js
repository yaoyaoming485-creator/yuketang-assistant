// 解析 localStorage 里的作业快照：结构 + 字段清单 + 是否含答案
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const ls = JSON.parse(fs.readFileSync(path.join(LAB, '.test-runtime', 'ykt-api', 'localstorage.json'), 'utf8'));

const exKeys = Object.keys(ls).filter(k => k.startsWith('iframe-exercise-'));
console.log('作业快照 key: ' + exKeys.length + ' 个\n');

// 汇总每个作业
const byEx = {};
for (const k of exKeys) {
  const m = /^iframe-exercise-(\d+)-(\d+)/.exec(k);
  if (!m) continue;
  const exId = m[2];
  const assignment = (k.split('-').pop());
  let j;
  try { j = JSON.parse(ls[k]); } catch (e) { console.log('  解析失败 ' + k); continue; }
  const probs = j.problems || {};
  const ids = Object.keys(probs);
  byEx[exId] = byEx[exId] || { assignment, snaps: 0, problems: {}, fields: new Set() };
  byEx[exId].snaps++;
  for (const pid of ids) {
    const p = probs[pid];
    byEx[exId].problems[pid] = p;
    Object.keys(p).forEach(k2 => byEx[exId].fields.add(k2));
    const c = p.content || {};
    Object.keys(c).forEach(k2 => byEx[exId].fields.add('content.' + k2));
  }
}

for (const [exId, v] of Object.entries(byEx)) {
  console.log('== 作业 ' + exId + '  assignment=' + v.assignment + '  快照数=' + v.snaps + '  题目数=' + Object.keys(v.problems).length);
  console.log('   字段: ' + [...v.fields].join(', '));
  for (const [pid, p] of Object.entries(v.problems)) {
    const c = p.content || {};
    console.log('   - ProblemID=' + pid + '  ' + (c.TypeText || '') + '  ' + c.score + '分  ' +
      (c.LibraryName || ''));
    console.log('       Body: ' + String(c.Body || '').replace(/\s+/g, ' ').slice(0, 110));
    const optKeys = Object.keys(c).filter(k => /option|answer|choice/i.test(k));
    console.log('       选项/答案字段: ' + (optKeys.join(', ') || '(无)'));
    for (const ok of optKeys) {
      const ov = JSON.stringify(c[ok]);
      console.log('         ' + ok + ' = ' + ov.slice(0, 400));
    }
  }
  console.log('');
}

// 找有没有 fontUrl 之类的线索
console.log('=== 全局搜 font 相关字段 ===');
const seen = new Set();
function walk(o, pathStr, depth) {
  if (depth > 6 || !o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (/font/i.test(k)) { if (!seen.has(pathStr + '.' + k)) { seen.add(pathStr + '.' + k); console.log('  ' + pathStr + '.' + k + ' = ' + JSON.stringify(v).slice(0, 200)); } }
    if (v && typeof v === 'object') walk(v, pathStr + '.' + k, depth + 1);
  }
}
for (const [exId, v] of Object.entries(byEx)) for (const [pid, p] of Object.entries(v.problems)) walk(p, exId + '.' + pid, 0);
