// ============================================================================
// 构建离线答案库：把 answers-by-pid.json（人工作答）转成指纹索引
// 指纹 = 只保留汉字（滤掉标点/编号/空格/拉丁字母），跨字体置换、跨页面结构都稳定
//   fullFp = 题干汉字 + 全部选项汉字（唯一性最强）
//   optFp  = 仅选项汉字（题干重复时用于兜底，唯一时才入索引）
// ============================================================================
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const OUT = path.join(LAB, '.test-runtime', 'ykt-api');
const decoded = JSON.parse(fs.readFileSync(path.join(OUT, 'decoded-questions.json'), 'utf8'));
const answers = JSON.parse(fs.readFileSync(path.join(LAB, 'answers-by-pid.json'), 'utf8'));

const cjk = (s) => String(s || '').replace(/[^一-鿿]/g, '');

const entries = [];
let missing = 0;
for (const [exId, ex] of Object.entries(decoded)) {
  const ansMap = answers[exId] || {};
  for (const [pid, q] of Object.entries(ex.questions)) {
    const a = ansMap[pid];
    if (!a) { console.log('  ★ 缺答案: 作业' + exId + ' PID=' + pid); missing++; continue; }
    const bodyFp = cjk(q.body);
    const optFp = cjk(q.options.map(o => o.text).join(''));
    entries.push({
      exercise: exId, pid, type: q.type || '', answer: a.answer,
      confidence: a.confidence || 'mid', note: a.note || '',
      bodyFp, optFp, fullFp: bodyFp + optFp,
      stem: q.body.slice(0, 120),
    });
  }
}
console.log('答案条目: ' + entries.length + (missing ? '  (缺 ' + missing + ')' : ''));

// 唯一性检查
const fullCount = {}, optCount = {}, bodyCount = {};
for (const e of entries) {
  fullCount[e.fullFp] = (fullCount[e.fullFp] || 0) + 1;
  optCount[e.optFp] = (optCount[e.optFp] || 0) + 1;
  bodyCount[e.bodyFp] = (bodyCount[e.bodyFp] || 0) + 1;
}
const dupFull = Object.entries(fullCount).filter(([, n]) => n > 1);
const dupOpt = Object.entries(optCount).filter(([, n]) => n > 1);
const dupBody = Object.entries(bodyCount).filter(([, n]) => n > 1);
console.log('题干重复的组数: ' + dupBody.length + '  选项重复的组数: ' + dupOpt.length + '  整题指纹重复: ' + dupFull.length);
if (dupBody.length) {
  console.log('  重复题干示例:');
  for (const [fp, n] of dupBody.slice(0, 5)) console.log('    x' + n + '  ' + fp.slice(0, 40));
}

// 置信度分布
const conf = {};
for (const e of entries) conf[e.confidence] = (conf[e.confidence] || 0) + 1;
console.log('置信度分布: ' + JSON.stringify(conf));

const bank = {
  _generated: new Date().toISOString(),
  _fingerprint: '仅保留 CJK 汉字；fullFp=题干+选项，optFp=仅选项（唯一时入索引）',
  course: '科研伦理与学术规范',
  classroom_id: '<classroom_id>',
  entries,
};
fs.writeFileSync(path.join(LAB, 'answer-bank.json'), JSON.stringify(bank, null, 2), 'utf8');
console.log('\n已写 answer-bank.json  (' + fs.statSync(path.join(LAB, 'answer-bank.json')).size + ' 字节)');

// 导出可读清单
const lines = ['# 离线答案库：科研伦理与学术规范（' + entries.length + ' 题）', ''];
for (const [exId, ex] of Object.entries(decoded)) {
  lines.push('\n## 作业 ' + exId);
  for (const [pid, q] of Object.entries(ex.questions)) {
    const e = entries.find(x => x.pid === pid);
    if (!e) continue;
    lines.push('- PID=' + pid + '  ' + (q.type || '') + '  答案=' + e.answer + '  置信=' + e.confidence);
    lines.push('  题干: ' + q.body.slice(0, 110));
    for (const o of q.options) lines.push('      ' + o.key + '. ' + o.text.slice(0, 90));
  }
}
fs.writeFileSync(path.join(LAB, 'deliverables', '作业答案库-科研伦理与学术规范.md'), lines.join('\n'), 'utf8');
console.log('已写 deliverables/作业答案库-科研伦理与学术规范.md');
