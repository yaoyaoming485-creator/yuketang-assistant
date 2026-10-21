// 校验 fonts/ 下每份字体的 .map.json：存在性、条目数、抽样还原
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const FONT_DIR = path.join(LAB, 'fonts');

const fonts = fs.readdirSync(FONT_DIR).filter(f => f.endsWith('.ttf'));
const orig = JSON.parse(fs.readFileSync(path.join(LAB, 'fontlab', 'ykt_reverse', 'original_glyph_to_uni.json'), 'utf8'));
const origSet = new Set(Object.values(orig));

let rows = [];
for (const f of fonts.sort()) {
  const mapFile = path.join(FONT_DIR, f + '.map.json');
  if (!fs.existsSync(mapFile)) { rows.push([f, 'MISSING', '-', '-', '-']); continue; }
  let m;
  try { m = JSON.parse(fs.readFileSync(mapFile, 'utf8')); }
  catch (e) { rows.push([f, 'BAD-JSON', String(e.message).slice(0, 40), '-', '-']); continue; }
  const keys = Object.keys(m);
  // 抽样 5 个：假码位 -> 真字符，检查真字符是否是可打印的中日韩字符
  const sample = keys.slice(0, 5).map(k => k + '->' + m[k]).join(' ');
  const bad = keys.filter(k => {
    const v = m[k];
    if (typeof v !== 'string' || v.length === 0) return true;
    const cp = v.codePointAt(0);
    if (cp >= 0x4e00 && cp <= 0x9fff) return false;  // CJK
    if (cp >= 0x3000 && cp <= 0x303f) return false;  // CJK punct
    if (cp >= 0xff00 && cp <= 0xffef) return false;  // fullwidth
    return true;
  });
  rows.push([f, 'OK', keys.length, bad.length, sample]);
}

console.log('font'.padEnd(46) + 'status  entries  bad  sample');
for (const r of rows) {
  console.log(String(r[0]).padEnd(46) + String(r[1]).padEnd(8) + String(r[2]).padEnd(8) + String(r[3]).padEnd(5) + ' ' + r[4]);
}
console.log('\n原始表条目数:', Object.keys(orig).length, ' 字体数:', fonts.length, ' 已有映射:', rows.filter(r => r[1] === 'OK').length);
