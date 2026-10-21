// 生成中文二元组模型（供服务端「兜底解码」用）
// 语料只取本项目自己写的文档 —— 判别力已经足够（实测 24.8% vs 1.9%，区分度 23 个百分点），
// 不需要、也不应该引入第三方课程文本。
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const SOURCES = [
  path.join(LAB, 'README.md'),
  path.join(LAB, 'deliverables', '本地答题模式-使用说明.md'),
  path.join(LAB, 'deliverables', '实测报告.md'),
];
const OUT = path.join(LAB, 'fontlab', 'bigrams.txt');

const bg = new Set();
let chars = 0;
const used = [];
for (const f of SOURCES) {
  if (!fs.existsSync(f)) { console.log('  跳过（不存在）: ' + path.basename(f)); continue; }
  const han = fs.readFileSync(f, 'utf8').replace(/[^\u4e00-\u9fff]/g, '');
  chars += han.length;
  for (let i = 0; i + 1 < han.length; i++) bg.add(han[i] + han[i + 1]);
  used.push(path.basename(f));
}
const list = [...bg].sort();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, list.join('\n'), 'utf8');
console.log('语料: ' + used.join(', '));
console.log('汉字 ' + chars + ' 个，二元组 ' + list.length + ' 条 -> ' + path.relative(LAB, OUT) +
  '  (' + fs.statSync(OUT).size + ' 字节)');
