// 导出：每个作业每道题的 用户已提交答案 / 是否正确 / 题型 / 完整字段样本
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const OUT = path.join(LAB, '.test-runtime', 'ykt-api');
const ls = JSON.parse(fs.readFileSync(path.join(OUT, 'localstorage.json'), 'utf8'));

const exKeys = Object.keys(ls).filter(k => k.startsWith('iframe-exercise-'));
const lines = [];
const P = (s) => { lines.push(s); };

P('=== 作业/题目/已提交状态 汇总 ===');
const perEx = {};
for (const k of exKeys) {
  const m = /^iframe-exercise-(\d+)-(\d+)/.exec(k);
  const exId = m[2];
  let j;
  try { j = JSON.parse(ls[k]); } catch (e) { continue; }
  const probs = j.problems || {};
  for (const [pid, p] of Object.entries(probs)) {
    if (pid.endsWith('_group')) continue;
    const c = p.content || {};
    const key = exId + '|' + pid;
    if (!perEx[key]) perEx[key] = { exId, pid, type: c.TypeText, score: c.score, body: c.Body, options: c.Options, ans: p._answer, isRight: p._isRight, status: p.submission_status, agent: p.agent_score, snaps: 0, sample: p };
    perEx[key].snaps++;
  }
}

const byEx = {};
for (const v of Object.values(perEx)) (byEx[v.exId] = byEx[v.exId] || []).push(v);
for (const [exId, arr] of Object.entries(byEx)) {
  arr.sort((a, b) => a.pid < b.pid ? -1 : 1);
  P('\n--- 作业 ' + exId + '  共 ' + arr.length + ' 道 ---');
  for (const v of arr) {
    P('  PID=' + v.pid + '  ' + (v.type || '?') + '  ' + v.score + '分   已答=' + JSON.stringify(v.ans) +
      '  对错=' + JSON.stringify(v.isRight) + '  状态=' + JSON.stringify(v.status) +
      '  agent=' + JSON.stringify(v.agent) + '  快照数=' + v.snaps);
  }
}

// 一个已提交题目的完整对象（找字段细节）
P('\n\n=== 完整样本：第一个含 _answer 的题目对象 ===');
for (const v of Object.values(perEx)) {
  if (v.ans !== undefined && v.ans !== null && JSON.stringify(v.ans) !== '[]' && JSON.stringify(v.ans) !== 'null') {
    P(JSON.stringify(v.sample, null, 2).slice(0, 6000));
    break;
  }
}

fs.writeFileSync(path.join(OUT, 'problem-summary.txt'), lines.join('\n'), 'utf8');
console.log(lines.slice(0, 80).join('\n'));
console.log('\n... 完整内容已写 ' + path.join(OUT, 'problem-summary.txt'));
