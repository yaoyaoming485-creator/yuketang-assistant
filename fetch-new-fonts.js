// 扫描 Edge 缓存，找出所有本地还没有的 exam_font_<md5>.ttf，下载 + 建映射表
// 用户每开一次作业页就会换一次置换，所以这个要能增量跑。
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const LAB = __dirname;
const FONTS = path.join(LAB, 'fonts');
const PY = path.join(LAB, '.venv', 'Scripts', 'python.exe');
const CACHE = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'Cache_Data');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function scanCache() {
  const found = new Set();
  const re = /exam_font_[0-9a-f]{32}\.ttf/gi;
  for (const p of walk(CACHE)) {
    let buf;
    try { buf = fs.readFileSync(p); } catch (e) { continue; }
    const s = buf.toString('latin1');
    let m;
    while ((m = re.exec(s)) !== null) found.add(m[0]);
  }
  return [...found];
}

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
  const cached = scanCache();
  const local = new Set(fs.readdirSync(FONTS).filter(f => f.endsWith('.ttf')));
  const missing = cached.filter(n => !local.has(n));
  console.log('缓存里 ' + cached.length + ' 个 exam_font，本地已有 ' + local.size + '，缺 ' + missing.length);
  if (!missing.length) { console.log('无需更新'); return; }

  for (const name of missing) {
    const url = 'https://fe-static-yuketang.yuketang.cn/fe_font/product/' + name;
    const dest = path.join(FONTS, name);
    const ok = await dl(url, dest);
    if (!ok) { console.log('  ' + name + ' 下载失败'); continue; }
    console.log('  ' + name + ' 下载 ' + fs.statSync(dest).size + 'B');
    const map = dest + '.map.json';
    if (!fs.existsSync(map)) {
      try {
        execFileSync(PY, [path.join(LAB, 'build-font-map.py'), dest, map], { encoding: 'utf8', timeout: 300000 });
      } catch (e) { console.log('    建表失败: ' + String(e.stdout || e.stderr || e.message).slice(0, 160)); }
    }
    if (fs.existsSync(map)) {
      const m = JSON.parse(fs.readFileSync(map, 'utf8'));
      console.log('    映射表 ' + Object.keys(m).length + ' 条');
    }
  }
  console.log('\n本地 exam_font 总数: ' + fs.readdirSync(FONTS).filter(f => f.endsWith('.ttf')).length);
})();
