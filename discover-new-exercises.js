// ============================================================================
// 发现浏览器里「已打开过但答案库里还没有」的作业题目
// ----------------------------------------------------------------------------
// 原理：雨课堂把整份作业的题目 JSON（连密文）存在页面同源的 localStorage 里，
//       键名形如 iframe-exercise-<classroomId>-<exerciseId>?<query>-<userId>-<assignmentId>
//       打开一次作业页就会留下一份快照。
//
// 用法：
//   node discover-new-exercises.js            # 扫描 + 解密 + 报告缺口
//   node discover-new-exercises.js --dump     # 顺便把快照原始 JSON 落盘
//
// 之后：把解出的题目填进 answers-by-pid.json -> node build-answer-bank.js
// ============================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const LAB = __dirname;
const EDGE_USER_DATA = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WORK = path.join(LAB, '.test-runtime', 'discover');
const PROFILE = path.join(WORK, 'edgeprof');
const PORT = 9352;
const FONT_DIR = path.join(LAB, 'fonts');
const API_DIR = path.join(LAB, '.test-runtime', 'ykt-api');
const DUMP = process.argv.includes('--dump');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    // Singleton* 是运行期锁；LOCK 同理。MANIFEST/LOG/CURRENT 必须一起拷，
    // 否则 leveldb 恢复不出数据（这是踩过的坑）。
    if (e.name.startsWith('Singleton') || e.name === 'LOCK') continue;
    try {
      if (e.isDirectory()) copyDir(s, d);
      else fs.writeFileSync(d, fs.readFileSync(s));
    } catch (err) { /* 被锁就跳过 */ }
  }
}

function getJSON(url, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET', timeout: 20000 },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return { ws, ready, send };
}

// ---- 二元组连贯性（与服务端同一套判据）----
const bigrams = new Set(fs.existsSync(path.join(LAB, 'fontlab', 'bigrams.txt'))
  ? fs.readFileSync(path.join(LAB, 'fontlab', 'bigrams.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : []);
function coherence(t) {
  if (!bigrams.size) return 0;
  const han = String(t).replace(/[^一-鿿]/g, '');
  let hit = 0, tot = 0;
  for (let i = 0; i + 1 < han.length; i++) { tot++; if (bigrams.has(han[i] + han[i + 1])) hit++; }
  return tot ? hit / tot : 0;
}
const ENC = /(<span[^>]*class="[^"]*xuetangx-com-encrypted-font[^"]*"[^>]*>)([\s\S]*?)(<\/span>)/g;
const decodeHtml = (html, map) => String(html || '').replace(ENC, (m, o, inner, c) =>
  o + inner.replace(/[^<>]+/g, t => t.split('').map(ch => (map[ch] || ch)).join('')) + c);
const toText = (html) => String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function loadMaps() {
  const out = [];
  if (!fs.existsSync(FONT_DIR)) return out;
  for (const f of fs.readdirSync(FONT_DIR)) {
    if (!f.endsWith('.map.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(FONT_DIR, f), 'utf8'));
      if (m && Object.keys(m).length > 100) out.push({ name: f.replace(/\.map\.json$/, ''), map: m });
    } catch (e) { }
  }
  return out;
}

(async () => {
  console.log('== 1. 复制浏览器 Local Storage 到临时配置档 ==');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  copyDir(path.join(EDGE_USER_DATA, 'Default', 'Local Storage'), path.join(PROFILE, 'Default', 'Local Storage'));
  for (const f of ['Local State']) {
    const s = path.join(EDGE_USER_DATA, f);
    if (fs.existsSync(s)) fs.writeFileSync(path.join(PROFILE, f), fs.readFileSync(s));
  }
  for (const f of ['Preferences', 'Secure Preferences']) {
    const s = path.join(EDGE_USER_DATA, 'Default', f);
    if (fs.existsSync(s)) fs.writeFileSync(path.join(PROFILE, 'Default', f), fs.readFileSync(s));
  }

  console.log('== 2. 用副本配置档启动 Edge（headless）==');
  const c = spawn(EDGE_EXE, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--headless=new',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  let bv = null;
  for (let i = 0; i < 50; i++) {
    await sleep(600);
    try { bv = JSON.parse((await getJSON('http://127.0.0.1:' + PORT + '/json/version')).body); break; } catch (e) { }
  }
  if (!bv) { console.log('  启动失败'); process.exit(1); }

  console.log('== 3. 读取 localStorage 里的作业快照 ==');
  const tab = await getJSON('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent('https://www.yuketang.cn/'), 'PUT');
  const ti = JSON.parse(tab.body);
  const ps = cdp(ti.webSocketDebuggerUrl);
  await ps.ready;
  await ps.send('Page.enable', {});
  await sleep(3000);
  await ps.send('Page.navigate', { url: 'https://www.yuketang.cn/' });
  await sleep(11000);
  const dump = await ps.send('Runtime.evaluate', {
    expression: `(() => { const o = {}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k.indexOf('iframe-exercise-')===0) o[k]=localStorage.getItem(k);} return JSON.stringify(o); })()`,
    returnByValue: true, awaitPromise: true,
  });
  const snaps = JSON.parse((dump.result && dump.result.result && dump.result.result.value) || '{}');
  console.log('  快照 ' + Object.keys(snaps).length + ' 份');
  try { execSync('taskkill /F /IM msedge.exe /T', { stdio: 'ignore' }); } catch (e) { }
  await sleep(1500);
  if (DUMP) {
    fs.mkdirSync(API_DIR, { recursive: true });
    fs.writeFileSync(path.join(API_DIR, 'localstorage-live.json'), JSON.stringify(snaps, null, 2), 'utf8');
    console.log('  已落盘 ' + path.join(API_DIR, 'localstorage-live.json'));
  }

  console.log('== 4. 解密 + 对比答案库 ==');
  const maps = loadMaps();
  const bankPath = path.join(LAB, 'answer-bank.json');
  const bank = fs.existsSync(bankPath) ? JSON.parse(fs.readFileSync(bankPath, 'utf8')) : { entries: [] };
  const known = new Set((bank.entries || []).map(e => e.pid));

  const perEx = {};
  for (const [k, v] of Object.entries(snaps)) {
    let j; try { j = JSON.parse(v); } catch (e) { continue; }
    const m = /^iframe-exercise-(\d+)-(\d+)/.exec(k);
    if (!m) continue;
    const ex = m[2];
    perEx[ex] = perEx[ex] || { ex, snaps: 0, pids: new Set(), missing: [] };
    perEx[ex].snaps++;
    for (const [pid, p] of Object.entries(j.problems || {})) {
      if (pid.endsWith('_group')) continue;
      perEx[ex].pids.add(pid);
      if (known.has(pid)) continue;
      const cc = p.content || {};
      let best = null;
      for (const mm of maps) {
        const t = toText(decodeHtml(cc.Body || '', mm.map)) + ' ' +
          (cc.Options || []).map(o => toText(decodeHtml(o.value || '', mm.map))).join(' ');
        const sc = coherence(t);
        if (!best || sc > best.sc) best = { sc, mm };
      }
      if (!best) continue;
      perEx[ex].missing.push({
        pid, type: cc.TypeText || '', score: cc.score, sc: best.sc, font: best.mm.name,
        body: toText(decodeHtml(cc.Body || '', best.mm.map)),
        options: (cc.Options || []).map(o => ({ key: o.key, text: toText(decodeHtml(o.value || '', best.mm.map)) })),
      });
    }
  }

  for (const [, v] of Object.entries(perEx)) {
    const total = v.pids.size, miss = v.missing.length;
    console.log('\n  作业 ' + v.ex + '   快照=' + v.snaps + '   题目=' + total + '   答案库缺=' + miss);
    for (const q of v.missing) {
      console.log('    - ' + q.pid + '  ' + q.type + '（' + q.score + '分）  连贯度 ' + (q.sc * 100).toFixed(0) + '%');
      console.log('      ' + q.body);
      for (const o of q.options) console.log('        ' + o.key + '. ' + o.text);
    }
  }
  const totalMissing = Object.values(perEx).reduce((a, v) => a + v.missing.length, 0);
  console.log('\n合计待作答: ' + totalMissing + ' 题');
  if (totalMissing) console.log('把答案填进 answers-by-pid.json，然后 node build-answer-bank.js');
})().catch(e => { console.error(e.stack); process.exit(1); });
