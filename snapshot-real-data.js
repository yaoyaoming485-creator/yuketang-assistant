// 给「用户真实数据」算一个指纹，用来证明自检脚本没有污染生产数据
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LAB = __dirname;
const targets = ['answer-cache.json', 'inbox.json', 'shots'];

function walk(dir, base, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const p = path.join(dir, e.name);
    const rel = path.join(base, e.name);
    if (e.isDirectory()) walk(p, rel, out);
    else {
      const st = fs.statSync(p);
      const h = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
      out.push(`${rel}  ${st.size}B  ${h}`);
    }
  }
  return out;
}

const lines = [];
for (const t of targets) {
  const p = path.join(LAB, t);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) walk(p, t, lines);
  else if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    const h = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
    lines.push(`${t}  ${st.size}B  ${h}`);
  } else {
    lines.push(`${t}  (不存在)`);
  }
}

console.log(lines.join('\n'));
console.log('---');
console.log('FINGERPRINT ' + crypto.createHash('sha1').update(lines.join('\n')).digest('hex'));
