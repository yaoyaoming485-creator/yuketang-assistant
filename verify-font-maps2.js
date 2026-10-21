// 深度校验：1) 882 条是否全部落在合法 CJK 范围 2) 9 份字体的映射是否两两不同 3) 与原表 join 命中率
const fs = require('fs');
const path = require('path');

const LAB = __dirname;
const FONT_DIR = path.join(LAB, 'fonts');
const fonts = fs.readdirSync(FONT_DIR).filter(f => f.endsWith('.ttf')).sort();

function isCjkish(cp) {
  if (cp >= 0x4e00 && cp <= 0x9fff) return true;          // CJK Unified
  if (cp >= 0x3400 && cp <= 0x4dbf) return true;          // Ext A
  if (cp >= 0x2e80 && cp <= 0x2eff) return true;          // CJK Radicals Supplement
  if (cp >= 0x2f00 && cp <= 0x2fdf) return true;          // Kangxi Radicals
  if (cp >= 0x3000 && cp <= 0x303f) return true;          // CJK Symbols and Punctuation
  if (cp >= 0xff00 && cp <= 0xffef) return true;          // Halfwidth/Fullwidth
  if (cp >= 0xf900 && cp <= 0xfaff) return true;          // CJK Compatibility Ideographs
  return false;
}

const maps = {};
let allOk = true;
for (const f of fonts) {
  const m = JSON.parse(fs.readFileSync(path.join(FONT_DIR, f + '.map.json'), 'utf8'));
  maps[f] = m;
  const keys = Object.keys(m);
  const offRange = keys.filter(k => !isCjkish(m[k].codePointAt(0)));
  const uniqTargets = new Set(keys.map(k => m[k])).size;
  const radicalCnt = keys.filter(k => {
    const cp = m[k].codePointAt(0);
    return (cp >= 0x2e80 && cp <= 0x2eff) || (cp >= 0x2f00 && cp <= 0x2fdf);
  }).length;
  if (offRange.length) allOk = false;
  console.log(
    f.padEnd(46) +
    'entries=' + keys.length +
    '  offRange=' + offRange.length +
    '  radicals=' + radicalCnt +
    '  uniqTargets=' + uniqTargets
  );
}

console.log('\n全部落在合法 CJK 范围:', allOk);

// 两两比对：任意两份字体的映射必须不同
let dupPairs = [];
for (let i = 0; i < fonts.length; i++) {
  for (let j = i + 1; j < fonts.length; j++) {
    const a = maps[fonts[i]], b = maps[fonts[j]];
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    let same = ka.length === kb.length;
    if (same) for (let k = 0; k < ka.length; k++) if (a[ka[k]] !== b[kb[k]]) { same = false; break; }
    if (same) dupPairs.push([fonts[i], fonts[j]]);
  }
}
console.log('映射完全相同的字体对:', dupPairs.length === 0 ? '无（9 份各不相同，正确）' : dupPairs.map(p => p.join(' == ')).join('; '));

// 抽样：对某字体取 10 个映射，打印 "假码位->真字"，验证语义合理（随机性证明是置换）
const sampleFont = fonts.find(f => f.includes('9e818004'));
const sm = maps[sampleFont];
const sk = Object.keys(sm);
console.log('\n用户那份字体抽样 12 条:');
for (let i = 0; i < 12; i++) { const k = sk[Math.floor(i * sk.length / 12)]; console.log('  U+' + k.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ' -> ' + sm[k] + ' (U+' + sm[k].codePointAt(0).toString(16).toUpperCase() + ')'); }
