// 下载新字体 -> 建映射表 -> 重新解码队列里的题目
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const LAB = __dirname;
const FONTS = path.join(LAB, 'fonts');
const PY = path.join(LAB, '.venv', 'Scripts', 'python.exe');

const NEW = [
  'https://fe-static-yuketang.yuketang.cn/fe_font/product/exam_font_20022e72bd82453fbd2504d4202da2d8.ttf',
  'https://fe-static-yuketang.yuketang.cn/fe_font/product/exam_font_41eedd379c44458ea1c560c9216040e5.ttf',
];

function dl(url, dest, redirects = 0) {
  return new Promise(res => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://www.yuketang.cn/' }, timeout: 25000 }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 5) {
        r.resume();
        return res(dl(new URL(r.headers.location, url).toString(), dest, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return res(false); }
      const cs = [];
      r.on('data', c => cs.push(c));
      r.on('end', () => { fs.writeFileSync(dest, Buffer.concat(cs)); res(true); });
    });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end();
  });
}

(async () => {
  for (const url of NEW) {
    const name = path.basename(url);
    const dest = path.join(FONTS, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) { console.log(name + ' 已存在'); }
    else {
      const ok = await dl(url, dest);
      console.log(name + ' 下载: ' + (ok ? fs.statSync(dest).size + 'B' : '失败'));
      if (!ok) continue;
    }
    const map = dest + '.map.json';
    if (!fs.existsSync(map)) {
      try {
        execFileSync(PY, [path.join(LAB, 'build-font-map.py'), dest, map], { encoding: 'utf8', timeout: 300000 });
      } catch (e) { console.log('  建表失败: ' + String(e.stdout || e.stderr || e.message).slice(0, 200)); }
    }
    if (fs.existsSync(map)) {
      const m = JSON.parse(fs.readFileSync(map, 'utf8'));
      console.log('  映射表: ' + Object.keys(m).length + ' 条');
    }
  }
})();
