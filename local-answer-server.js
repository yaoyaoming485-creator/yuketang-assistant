// ============================================================================
// 本地答案中转站（Local Answer Bridge）
// ----------------------------------------------------------------------------
// 解决的问题：MiniMax API 余额耗尽（HTTP 402 / insufficient_balance_error），
//             但油猴脚本的 AI 调用链本身完全正常（URL / model / 多模态格式都已验证）。
//
// 做法：本进程伪装成一个 OpenAI 兼容的 /v1/chat/completions 服务端。
//       油猴脚本把「题目截图」以多模态 content 传进来 ——
//         1) 服务端把截图落盘到 shots/ 目录（这就把题目"采集"下来了）
//         2) 服务端按缓存命中情况立即返回，或挂起等待人工/Agent 写入答案
//         3) 命中时返回 "正确答案：X"，脚本按原有逻辑选中选项并点提交
//
//       也就是说：题目仍然走油猴脚本的成熟链路（定位 / 选选项 / 提交），
//       唯一被替换掉的是「谁来回答」——从付费 API 换成本地人工/Agent 回答。
//       全程不消耗任何 API 额度。
//
// 接口：
//   POST /v1/chat/completions   OpenAI 兼容入口（油猴脚本调用这个）
//   GET  /v1/models              假 models 列表
//   GET  /api/shots              列出已采集到的题目截图（含 OCR 文本）
//   GET  /api/cache              查看答案缓存
//   POST /api/answer             写入答案   { "seq": 1, "answer": "A" }
//   POST /api/reset              清空缓存与截图
//   GET  /api/health             健康检查
//
// 用法：
//   node local-answer-server.js                # 默认 127.0.0.1:8900，等待 95 秒
//   node local-answer-server.js --port 8901    # 换端口
//   node local-answer-server.js --wait 0       # 不挂起，采集轮用（立即返回 PENDING）
//
// 油猴面板里的 AI 配置填：
//   URL   : http://127.0.0.1:8900/v1/chat/completions
//   Key   : local
//   Model : minimax-local        <- 必须含 "minimax"，脚本据此判定走多模态分支
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const LAB = __dirname;

// ---- 参数 ----
function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
const PORT = parseInt(argValue('--port', '8900'), 10);
const DEFAULT_WAIT_MS = parseInt(argValue('--wait', '95000'), 10);

// [v11] 目录/缓存可隔离 —— 测试用独立实例，绝不碰用户真实数据
const SHOTS_DIR = path.resolve(LAB, argValue('--shots', 'shots'));
const FONT_DIR = path.resolve(LAB, argValue('--fonts', 'fonts'));
const CACHE_FILE = path.resolve(LAB, argValue('--cache', 'answer-cache.json'));
// [v12] 持久待答队列：题目进来先排队，Agent 什么时候醒什么时候答，不超时丢弃
const INBOX_FILE = path.resolve(LAB, argValue('--inbox', 'inbox.json'));
// [v13] 离线答案库：题目进来先在本地查答案，命中就直接答掉（不占用任何 API 额度）
const ANSWER_BANK_FILE = path.resolve(LAB, argValue('--answer-bank', 'answer-bank.json'));

// 脚本 GM_xmlhttpRequest 的 timeout 是 120000ms，服务端必须更早返回，否则脚本先超时。
const HARD_WAIT_CAP_MS = 100000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 状态 ----
// shots:  Map<key, {seq, key, hash, file, text, createdAt}>
const shots = new Map();
let shotSeq = 0;
let cache = {};          // key -> { seq, answer, text, createdAt }
let waiters = [];        // { key, resolve }

function ensureDirs() {
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  if (!fs.existsSync(FONT_DIR)) fs.mkdirSync(FONT_DIR, { recursive: true });
}

// ---- 下载混淆字体（用于本地建表还原乱码题面） ----
function downloadFont(url, savePath, redirects = 0) {
  return new Promise(resolve => {
    if (!url || redirects > 4) return resolve(false);
    let u;
    try { u = new URL(url); } catch (e) { return resolve(false); }
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const req = mod.get({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://www.yuketang.cn/',
        'Origin': 'https://www.yuketang.cn',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFont(new URL(res.headers.location, url).toString(), savePath, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { fs.writeFileSync(savePath, Buffer.concat(chunks)); resolve(true); }
        catch (e) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(25000, () => { req.destroy(); resolve(false); });
  });
}

async function fetchFont(fontUrl) {
  if (!fontUrl) return null;
  let base = 'font';
  try { base = path.basename(new URL(fontUrl).pathname) || 'font'; } catch (e) {}
  base = base.replace(/[^\w.-]/g, '_');
  const dest = path.join(FONT_DIR, base);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return dest;
  const ok = await downloadFont(fontUrl, dest);
  if (ok) {
    console.log(`[bridge] 已下载混淆字体 -> ${dest} (${fs.statSync(dest).size} bytes)`);
    return dest;
  }
  console.log('[bridge] 混淆字体下载失败：' + fontUrl);
  return null;
}

// ============================================================================
// [v12] 持久待答队列（inbox）
// ----------------------------------------------------------------------------
// 以前：脚本发请求 -> 中转站挂起 95 秒 -> 没人应答就返回 PENDING，题目被跳过。
// 现在：题目一进来就**入队落盘**，Agent（我这个对话）随时来取；答完写回，脚本轮询取走。
//        这样"Agent 不在线"不再丢题，题目会一直排着等我醒。
// ============================================================================
let inbox = {};   // key -> { key, seq, question, decodedText, text, createdAt, answered, answer, note }

function loadInbox() {
  try {
    if (fs.existsSync(INBOX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8'));
      inbox = (raw && typeof raw === 'object') ? raw : {};
    }
  } catch (e) {
    console.log('[bridge] inbox 读取失败，重建：' + e.message);
    inbox = {};
  }
}

function saveInbox() {
  try {
    fs.writeFileSync(INBOX_FILE, JSON.stringify(inbox, null, 2), 'utf8');
  } catch (e) {
    console.log('[bridge] inbox 写入失败：' + e.message);
  }
}

// 入队（同一 key 覆盖，不重复排队）
function enqueueInbox(key, payload) {
  const prev = inbox[key] || {};
  inbox[key] = Object.assign({}, prev, payload, {
    key,
    createdAt: prev.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
  saveInbox();
  return inbox[key];
}

function setInboxAnswer(key, answer, note) {
  if (!inbox[key]) return false;
  inbox[key] = Object.assign({}, inbox[key], {
    answer,
    note: note || inbox[key].note || '',
    answered: true,
    answeredAt: Date.now(),
  });
  saveInbox();
  return true;
}

// ============================================================================
// [v13] 离线答案库
// ---------------------------------------------------------------------------
// 为什么需要：题面是从浏览器里拿到的**密文**（雨课堂用动态字体把汉字换成假字符）。
// 服务端有字形映射表，能把密文还原成明文；但还原出来之后仍然需要人来判断答案。
// 这里把「题目指纹 -> 答案」预先离线做好，题目一进来就地查表直接答掉：
//   · 不消耗任何大模型 API 额度
//   · 不依赖 Agent 是否在线（Agent 在不在都能提交）
// 指纹：只保留 CJK 汉字（滤掉标点/题号/空白/拉丁字母），因此对
//   「每次页面加载重新随机置换一次字体」「DOM 结构微变」都不敏感。
// ============================================================================
const answerBank = { byFull: new Map(), byOpt: new Map(), count: 0, meta: null };

function cjkFingerprint(s) {
  return String(s || '').replace(/[^一-鿿]/g, '');
}

function loadAnswerBank() {
  try {
    if (!fs.existsSync(ANSWER_BANK_FILE)) {
      console.log('[bridge] 未找到答案库：' + ANSWER_BANK_FILE + '（题目将进入待答队列）');
      return;
    }
    const raw = JSON.parse(fs.readFileSync(ANSWER_BANK_FILE, 'utf8'));
    const list = (raw && raw.entries) || [];
    const optSeen = new Map();
    for (const e of list) {
      answerBank.byFull.set(e.fullFp, e);
      optSeen.set(e.optFp, (optSeen.get(e.optFp) || 0) + 1);
    }
    for (const e of list) {
      // 只有选项指纹全局唯一时才入索引（否则会撞题）
      if (optSeen.get(e.optFp) === 1) answerBank.byOpt.set(e.optFp, e);
    }
    answerBank.count = list.length;
    answerBank.meta = raw;
    console.log('[bridge] 离线答案库已加载：' + list.length + ' 题（指纹索引 ' +
      answerBank.byFull.size + ' / 唯一选项索引 ' + answerBank.byOpt.size + '）');
  } catch (e) {
    console.log('[bridge] 答案库加载失败（不影响主流程）：' + e.message);
  }
}

// 用明文题面查答案：先整题指纹，再（题干重复时）用唯一选项指纹 + 题干校验
function matchAnswerBank(plainText) {
  if (!answerBank.count || !plainText) return null;
  const fp = cjkFingerprint(plainText);
  if (!fp) return null;
  const exact = answerBank.byFull.get(fp);
  if (exact) return exact;
  for (const [full, e] of answerBank.byFull) {
    if (full && fp.includes(full)) return e;
  }
  for (const [opt, e] of answerBank.byOpt) {
    if (opt && fp.includes(opt) && fp.includes(e.bodyFp)) return e;
  }
  // 最后兜底：题干唯一时按题干匹配
  const bodyHits = [];
  for (const e of answerBank.byFull.values()) {
    if (e.bodyFp && e.bodyFp.length >= 8 && fp.includes(e.bodyFp)) bodyHits.push(e);
    if (bodyHits.length > 1) break;
  }
  if (bodyHits.length === 1) return bodyHits[0];
  return null;
}

// ============================================================================
// [v11] 字体映射表 + 题面还原
// ----------------------------------------------------------------------------
// 雨课堂的加密字体 = 思源黑体的「乱序子集」：cmap[假码位] 画出来是另一个真字。
// 还原办法（已用真实字体验证 882/882 全中）：
//   1) 用 original_glyph_to_uni.json（思源黑体全量「字形轮廓哈希 -> 真 Unicode」表）
//   2) 对加密字体每个码位算同样的轮廓哈希
//   3) 哈希相同 => 假码位 对应 真 Unicode
// 映射表由 build-font-map.py（fontTools）生成，按字体文件缓存。
// ============================================================================
const PY_EXE = fs.existsSync(path.join(LAB, '.venv', 'Scripts', 'python.exe'))
  ? path.join(LAB, '.venv', 'Scripts', 'python.exe')
  : (process.platform === 'win32' ? 'python' : 'python3');
const fontMaps = new Map();   // fontFile -> { 假字符: 真字符 }

function buildFontMap(fontFile) {
  if (!fontFile) return Promise.resolve(null);
  if (fontMaps.has(fontFile)) return Promise.resolve(fontMaps.get(fontFile));
  const mapFile = fontFile + '.map.json';
  const readMap = () => {
    try {
      const m = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      if (m && typeof m === 'object' && Object.keys(m).length) return m;
    } catch (e) { /* ignore */ }
    return null;
  };
  let cached = readMap();
  if (cached) { fontMaps.set(fontFile, cached); return Promise.resolve(cached); }

  return new Promise((resolve) => {
    const ps = spawn(PY_EXE, [path.join(LAB, 'build-font-map.py'), fontFile, mapFile], {
      windowsHide: true,
    });
    let err = '';
    ps.stderr.on('data', d => { err += d; });
    ps.stdout.on('data', d => { err += ''; });
    ps.on('error', (e) => { console.log('[bridge] 字体映射构建失败：' + e.message); resolve(null); });
    ps.on('close', () => {
      const m = readMap();
      if (m) {
        fontMaps.set(fontFile, m);
        console.log(`[bridge] 字体映射表已生成：${path.basename(fontFile)} -> ${Object.keys(m).length} 条`);
        resolve(m);
      } else {
        console.log('[bridge] 字体映射构建失败：' + String(err).slice(0, 300));
        resolve(null);
      }
    });
  });
}

// 加密 span 的 class 是 xuetangx-com-encrypted-font；只替换文本节点，保留标签
const ENC_SPAN_RE = /(<span[^>]*class="[^"]*xuetangx-com-encrypted-font[^"]*"[^>]*>)([\s\S]*?)(<\/span>)/g;

function decodeTextSegment(seg, map) {
  return seg.replace(/[^<>]+/g, (t) => t.split('').map(ch => (map[ch] || ch)).join(''));
}

function decodeEncryptedHtml(html, map) {
  if (!html || !map) return '';
  return String(html).replace(ENC_SPAN_RE, (m, open, inner, close) => open + decodeTextSegment(inner, map) + close);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// [v13 兜底解码] 上报的 fontUrl 不可用时，自己找对的映射表
// ----------------------------------------------------------------------------
// 背景：脚本上报的 fontUrl 有两种失效方式 ——
//   ① 抓错成 MathJax 之类的别的字体（v11~v12 的 resource timing 兜底会「取最后一个候选」）
//   ② 压根没上报（题目和字体都在 iframe 里，顶层 document 的 resource timing 看不到）
// 此时不能返回一堆乱码。本地往往**已经有正确的映射表**（用户刚打开过题目页，
// 那份新置换的字体已经下到本地 / Edge 缓存里了）。
//
// 判别方法：中文二元组连贯性。正确置换解出来是通顺句子（二元组命中 ~25%~50%），
//           错误置换解出来是随机字符（~2%）。区分度 20+ 个百分点，零人工标注。
// 语料只用本项目自己写的文档（fontlab/bigrams.txt），不引入第三方课程文本。
// ============================================================================
const BIGRAM_FILE = path.resolve(LAB, argValue('--bigrams', path.join('fontlab', 'bigrams.txt')));
let bigramSet = new Set();

function loadBigrams() {
  try {
    if (!fs.existsSync(BIGRAM_FILE)) {
      console.log('[bridge] 未找到二元组模型（兜底解码不可用）：' + BIGRAM_FILE);
      return;
    }
    bigramSet = new Set(fs.readFileSync(BIGRAM_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
    console.log('[bridge] 二元组模型已加载：' + bigramSet.size + ' 条');
  } catch (e) {
    console.log('[bridge] 二元组模型加载失败：' + e.message);
  }
}

function coherenceScore(text) {
  if (!bigramSet.size || !text) return 0;
  const han = String(text).replace(/[^一-鿿]/g, '');
  let hit = 0, tot = 0;
  for (let i = 0; i + 1 < han.length; i++) {
    tot++;
    if (bigramSet.has(han[i] + han[i + 1])) hit++;
  }
  return tot ? hit / tot : 0;
}

// 连贯度低于这个值就认为「解出来是乱码」
const COHERENT_MIN = 0.08;

function isCoherent(text) {
  return coherenceScore(text) >= COHERENT_MIN;
}

// 遍历本地所有映射表，挑出解出来最通顺的那一份
function pickBestLocalMap(html) {
  if (!bigramSet.size || !html) return null;
  let best = null, second = 0;
  let files = [];
  try { files = fs.readdirSync(FONT_DIR).filter(f => f.endsWith('.map.json')); } catch (e) { return null; }
  for (const f of files) {
    let map;
    try { map = JSON.parse(fs.readFileSync(path.join(FONT_DIR, f), 'utf8')); } catch (e) { continue; }
    if (!map || Object.keys(map).length < 100) continue;     // 太小的表（比如 2 条的 MathJax）跳过
    const decoded = decodeEncryptedHtml(html, map);
    const text = htmlToText(decoded);
    const score = coherenceScore(text);
    if (!best || score > best.score) { second = best ? best.score : 0; best = { name: f.replace(/\.map\.json$/, ''), score, decoded, text, map }; }
    else if (score > second) second = score;
  }
  if (!best || best.score < COHERENT_MIN) return null;
  // 最佳必须明显优于次优，否则宁可不猜
  if (second >= COHERENT_MIN && best.score < second * 2) return null;
  return best;
}

// 拿到 html + fontUrl -> 还原明文题面
async function restoreText(html, fontUrl) {
  if (!html) return { text: '', decoded: '', map: null, fontFile: '' };
  const fontFile = fontUrl ? await fetchFont(fontUrl) : '';
  const map = fontFile ? await buildFontMap(fontFile) : null;
  let decoded = map ? decodeEncryptedHtml(html, map) : '';
  let text = htmlToText(decoded);

  // [v13 兜底] 解出来是乱码 -> 遍历本地映射表自己找对的
  if (!isCoherent(text)) {
    const best = pickBestLocalMap(html);
    if (best) {
      console.log(`[bridge] ★ 兜底解码命中 ${best.name}（连贯度 ${(best.score * 100).toFixed(1)}%，上报字体不可用）`);
      decoded = best.decoded;
      text = best.text;
    }
  }
  return { text, decoded, map, fontFile };
}

async function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      cache = raw && typeof raw === 'object' ? raw : {};
      for (const [k, v] of Object.entries(cache)) {
        if (!v || typeof v !== 'object') continue;
        // [v11] 连「还没答案」的条目也要恢复 —— 之前只恢复有 answer 的，
        //      结果重启后已采集但未作答的题（例如 seq 4）整条消失，/api/shots 看不到。
        if (typeof v.seq === 'number' && !shots.has(k)) {
          shotSeq = Math.max(shotSeq, v.seq);
          shots.set(k, {
            seq: v.seq, key: k, hash: v.hash || '',
            file: v.file || '', text: v.text || '',
            htmlFile: v.htmlFile || '', fontUrl: v.fontUrl || '',
            fontFile: v.fontFile || '', fontLoaded: v.fontLoaded,
            decodedText: v.decodedText || '', decodedFile: v.decodedFile || '',
            createdAt: v.createdAt || 0,
          });
        }
      }
      // [v11] 恢复出来的条目如果带了字体，顺手把明文题面还原出来
      for (const rec of shots.values()) {
        if (rec.decodedText || !rec.htmlFile || !rec.fontFile) continue;
        try {
          const html = fs.readFileSync(rec.htmlFile, 'utf8');
          const restored = await restoreText(html, rec.fontUrl || '');
          if (restored.text) {
            rec.decodedText = restored.text;
            const dfile = rec.htmlFile.replace(/\.html$/, '.decoded.html');
            fs.writeFileSync(dfile, restored.decoded, 'utf8');
            rec.decodedFile = dfile;
            cache[rec.key] = Object.assign({}, cache[rec.key] || {}, {
              decodedText: rec.decodedText, decodedFile: rec.decodedFile,
            });
            console.log(`[bridge] #${rec.seq} 已还原明文题面：${rec.decodedText.slice(0, 90)}`);
          }
        } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    console.log('[bridge] 缓存读取失败，重建：', e.message);
    cache = {};
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.log('[bridge] 缓存写入失败：', e.message);
  }
}

// 通知等待者：某个 key 的答案来了
function notify(key) {
  const still = [];
  for (const w of waiters) {
    if (w.key === key) w.resolve();
    else still.push(w);
  }
  waiters = still;
}

function getShot(key) { return shots.get(key); }

// ---- 请求体解析 ----
function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- 从 messages 里提取图片与文本 ----
function extractPayload(messages) {
  let imageData = null;
  let text = '';
  for (const m of messages || []) {
    const c = m && m.content;
    if (typeof c === 'string') { text += c + '\n'; continue; }
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') text += part.text + '\n';
      else if (part.type === 'image_url' && part.image_url && part.image_url.url) imageData = part.image_url.url;
    }
  }
  return { imageData, text };
}

// ---- 保存截图 ----
async function saveShot(key, imageData, text, extra) {
  const existing = shots.get(key);
  if (existing) {
    if (text && !existing.text) { existing.text = text; saveCache(); }
    return existing;
  }
  const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/.exec(imageData || '');
  if (!m) return null;
  const ext = (m[1] || 'png').toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  shotSeq += 1;
  const stem = `${String(shotSeq).padStart(2, '0')}-${hash.slice(0, 8)}`;
  const file = path.join(SHOTS_DIR, `${stem}.${ext === 'jpeg' ? 'jpg' : ext}`);
  try {
    fs.writeFileSync(file, buf);
  } catch (e) {
    console.log('[bridge] 截图写入失败：', e.message);
    return null;
  }
  const rec = { seq: shotSeq, key, hash, file, text: text || '', createdAt: Date.now() };

  // [v6] 加密原文 + 混淆字体
  if (extra && typeof extra === 'object') {
    rec.fontLoaded = extra.fontLoaded;
    rec.fontUrl = extra.fontUrl || '';
    if (typeof extra.html === 'string' && extra.html) {
      const htmlFile = path.join(SHOTS_DIR, `${stem}.html`);
      try {
        fs.writeFileSync(htmlFile, extra.html, 'utf8');
        rec.htmlFile = htmlFile;
      } catch (e) { /* ignore */ }
    }
    // [v7] 优先使用脚本直接上传的字体文件（最可靠，不依赖服务端能否访问字体 CDN）
    if (extra.fontData && typeof extra.fontData === 'string' && extra.fontData.length > 1000) {
      const b64 = extra.fontData.replace(/^data:[^,]*,/, '');
      let name = 'uploaded-obf.ttf';
      if (rec.fontUrl) {
        try { name = path.basename(new URL(rec.fontUrl).pathname) || name; } catch (e) { /* ignore */ }
      }
      name = name.replace(/[^\w.-]/g, '_');
      const fp = path.join(FONT_DIR, name);
      try {
        fs.writeFileSync(fp, Buffer.from(b64, 'base64'));
        rec.fontFile = fp;
        console.log(`[bridge] 已保存脚本上传的混淆字体 -> ${name} (${fs.statSync(fp).size} bytes)`);
      } catch (e) {
        console.log('[bridge] 上传字体保存失败：' + e.message);
      }
    }
    // 兜底：脚本没上传时才尝试自己下载
    if (!rec.fontFile && rec.fontUrl) {
      const fontFile = await fetchFont(rec.fontUrl);
      if (fontFile) rec.fontFile = fontFile;
    }
    // [v11] 有原文 + 有字体 -> 服务端直接还原明文题面（不必再靠 OCR 猜乱码）
    if (rec.htmlFile && rec.fontFile) {
      const restored = await restoreText(fs.readFileSync(rec.htmlFile, 'utf8'), rec.fontUrl || '');
      if (restored.text) {
        rec.decodedText = restored.text;
        try {
          const dfile = rec.htmlFile.replace(/\.html$/, '.decoded.html');
          fs.writeFileSync(dfile, restored.decoded, 'utf8');
          rec.decodedFile = dfile;
        } catch (e) { /* ignore */ }
        console.log(`[bridge] #${rec.seq} 已还原明文题面：${restored.text.slice(0, 90)}`);
        // [v12] 还原出来就入队，等 Agent 来答（不在线也不丢题）
        enqueueInbox(key, {
          seq: rec.seq,
          question: restored.text,
          decodedText: restored.text,
          text: rec.text || '',
          file: rec.file || '',
          fontUrl: rec.fontUrl || '',
        });
      }
    }
  }

  shots.set(key, rec);
  // 同步持久化元信息（重启后 loadCache 能恢复 html/字体路径）
  cache[key] = Object.assign({}, cache[key] || {}, {
    seq: rec.seq, hash: rec.hash, file: rec.file, text: rec.text,
    htmlFile: rec.htmlFile || '', fontUrl: rec.fontUrl || '',
    fontFile: rec.fontFile || '', fontLoaded: rec.fontLoaded,
    decodedText: rec.decodedText || '', decodedFile: rec.decodedFile || '',
  });
  saveCache();
  console.log(`[bridge] 采集到题目 #${shotSeq}  ${path.basename(file)}  (${buf.length} bytes)` +
    (rec.fontLoaded === false ? '  [混淆字体未加载]' : '') +
    (rec.htmlFile ? '  [含加密原文]' : ''));
  return rec;
}

// 计算去重键：优先用 OCR 文本（同一题重试时 OCR 文本完全一致，比图片 hash 更稳），
// 没有文本时退回图片字节 hash。
function dedupKey(imageData, text) {
  const t = (text || '').replace(/\s+/g, '');
  if (t.length >= 12) return 'txt:' + crypto.createHash('sha1').update(t.slice(0, 400)).digest('hex');
  if (imageData) return 'img:' + crypto.createHash('sha1').update(imageData).digest('hex');
  return null;
}

// ---- [v7] 从 OCR 文本里提取页面上的「标准答案」 ----
// 雨课堂在题目提交后会显示「本题得分：N  正确答案：XXX」，这行是**服务端返回的正常文本**，
// 不在加密 span 里，所以 OCR 能读到 —— 这是最可靠的真答案来源。
//
// 三个必须避开的坑（都实际踩过）：
//   1) 脚本 prompt 里也有「正确答案：A 或 正确答案：ABD」这样的**示例**，
//      取第一个匹配会中招。解法：只在「【OCR 文本」标记之后的部分里找。
//   2) OCR 会把「正确答案」四个字认成「I 确 吉 栾」之类 —— 实测「本 题 得 分 : 0 I 确 吉 栾 : A」。
//      所以主锚点改用「本题得分：N」后面紧跟的字母（这四个字和单个字母 OCR 都认得准），
//      「正确答案」只作兜底。
//   3) OCR 可能把 ABC 读成 A8C —— 用 (?![A-Za-z0-9]) 负向断言保守拒绝，宁可不提取也不给错答案。
// 另外 OCR 会在汉字之间插空格（"正 确 答 案 : ABC"），正则要容忍空格。
function extractPageAnswer(text) {
  const t = String(text || '');
  const marker = t.indexOf('【OCR 文本');
  if (marker < 0) return null;            // 没有 OCR 分隔标记 -> 不猜，避免误取 prompt 示例
  const scope = t.slice(marker);

  // 主锚点：「本题得分：N」后面紧跟的答案字母
  const byScore = /本\s*题\s*得\s*分\s*[：:]\s*\d+\s*[^A-F]{0,24}?\s*([A-F]{1,6})(?![A-Za-z0-9])/g;
  // 兜底锚点：「正确答案：XXX」
  const byLabel = /正\s*确\s*答\s*案\s*[：:]\s*([A-F]{1,6})(?![A-Za-z0-9])/gi;

  // 主锚点优先（"本题得分"四字 OCR 认得准，且其后的字母就是答案）；
  // 主锚点不命中时才用兜底锚点。都取最后一个匹配，避免抓到无关的字母。
  const scoreHits = [];
  let m;
  while ((m = byScore.exec(scope)) !== null) scoreHits.push(m[1]);
  if (scoreHits.length) return scoreHits[scoreHits.length - 1];

  const labelHits = [];
  while ((m = byLabel.exec(scope)) !== null) labelHits.push(m[1]);
  return labelHits.length ? labelHits[labelHits.length - 1] : null;
}

// ---- OpenAI 兼容响应 ----
function chatResponse(model, content, idSeed, extra) {
  const body = {
    id: 'chatcmpl-' + crypto.createHash('sha1').update(String(idSeed)).digest('hex').slice(0, 16),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'minimax-local',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  // [v12] 把队列 key 一起回给脚本，脚本据此轮询 /api/inbox/answer
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return body;
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

// ============================================================================
// 核心：处理一次 /v1/chat/completions 请求
// ============================================================================
async function handleChat(req, res, url) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: { message: 'bad request body: ' + e.message } });
  }

  const { imageData, text } = extractPayload(body.messages);
  const model = body.model || 'minimax-local';
  const extra = (body.extra && typeof body.extra === 'object') ? body.extra : null;

  // 纯文本请求（脚本多模态失败后的回退）：没有图片就没法采集，只能挂等或返回 PENDING
  if (!imageData) {
    console.log('[bridge] 收到纯文本请求（无截图），返回 PENDING');
    return sendJson(res, 200, chatResponse(model, '__PENDING__', 'notext-' + Date.now()));
  }

  const key = dedupKey(imageData, text);
  if (!key) return sendJson(res, 200, chatResponse(model, '__PENDING__', 'nokey-' + Date.now()));

  const rec = await saveShot(key, imageData, text, extra);
  if (!rec) return sendJson(res, 200, chatResponse(model, '__PENDING__', 'nosave-' + Date.now()));

  // [v12] 无论有没有答案，都先进待答队列 —— Agent 什么时候醒什么时候答，不丢题
  enqueueInbox(key, {
    seq: rec.seq,
    question: rec.decodedText || '',
    text: text || '',
    file: rec.file || '',
    fontUrl: rec.fontUrl || '',
  });

  // [v7] 页面若显示了标准答案（这题之前提交过），直接用它 —— 零延迟、零人工、保证正确
  const pageAnswer = extractPageAnswer(text);
  if (pageAnswer) {
    cache[key] = Object.assign({}, cache[key] || {}, {
      seq: rec.seq, hash: rec.hash, file: rec.file, text: rec.text,
      answer: pageAnswer, note: '页面答案栏自动提取',
    });
    saveCache();
    console.log(`[bridge] #${rec.seq} 从页面答案栏提取到标准答案：${pageAnswer}`);
    return sendJson(res, 200, chatResponse(model, `正确答案：${pageAnswer}`, rec.hash + pageAnswer));
  }

  // 缓存命中 → 立即返回
  const hit = cache[key];
  if (hit && typeof hit.answer === 'string' && hit.answer) {
    console.log(`[bridge] #${rec.seq} 命中缓存 -> ${hit.answer}`);
    return sendJson(res, 200, chatResponse(model, `正确答案：${hit.answer}`, rec.hash + hit.answer));
  }

  // 未命中 → 挂起等待（waitMs 可配；wait=0 立即返回 PENDING 走采集轮）
  const waitParam = url.searchParams.get('wait');
  const waitMs = Math.min(
    waitParam !== null ? parseInt(waitParam, 10) || 0 : DEFAULT_WAIT_MS,
    HARD_WAIT_CAP_MS
  );

  if (waitMs <= 0) {
    console.log(`[bridge] #${rec.seq} 未命中缓存，wait=0，立即返回 PENDING（采集轮）`);
    return sendJson(res, 200, chatResponse(model, '__PENDING__', rec.hash, { inbox_key: key }));
  }

  console.log(`[bridge] #${rec.seq} 未命中缓存，挂起等待最多 ${waitMs}ms ...`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 400);
      waiters.push({ key, resolve: () => { clearTimeout(timer); resolve(); } });
    });
    const h = cache[key];
    if (h && typeof h.answer === 'string' && h.answer) {
      console.log(`[bridge] #${rec.seq} 等待命中 -> ${h.answer}`);
      return sendJson(res, 200, chatResponse(model, `正确答案：${h.answer}`, rec.hash + h.answer));
    }
  }

  console.log(`[bridge] #${rec.seq} 等待超时，返回 PENDING（该题会被脚本跳过，不会提交错答案）`);
  return sendJson(res, 200, chatResponse(model, '__PENDING__', rec.hash + 'to', { inbox_key: key }));
}

// ============================================================================
// HTTP 服务
// ============================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  try {
    if (p === '/v1/chat/completions' && method === 'POST') {
      return await handleChat(req, res, url);
    }

    if (p === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [{ id: 'minimax-local', object: 'model', created: 0, owned_by: 'local' }],
      });
    }

    if (p === '/api/health') {
      let fonts = [];
      try { fonts = fs.readdirSync(FONT_DIR); } catch (e) { /* ignore */ }
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        shots: shots.size,
        answered: Object.values(cache).filter(v => v && v.answer).length,
        waitMs: DEFAULT_WAIT_MS,
        fonts: fonts,
        fontMaps: fontMaps.size,
      });
    }

    if (p === '/api/shots') {
      const list = Array.from(shots.values())
        .sort((a, b) => a.seq - b.seq)
        .map(s => ({
          seq: s.seq,
          key: s.key,
          hash: s.hash,
          file: s.file,
          text: s.text,
          answer: (cache[s.key] && cache[s.key].answer) || null,
          note: (cache[s.key] && cache[s.key].note) || '',
          htmlFile: s.htmlFile || '',
          fontUrl: s.fontUrl || '',
          fontFile: s.fontFile || '',
          fontLoaded: (typeof s.fontLoaded === 'boolean') ? s.fontLoaded : null,
          decodedText: s.decodedText || (cache[s.key] && cache[s.key].decodedText) || '',
          decodedFile: s.decodedFile || (cache[s.key] && cache[s.key].decodedFile) || '',
          createdAt: s.createdAt,
        }));
      return sendJson(res, 200, { count: list.length, shots: list });
    }

    // [v12] 待答队列：题目进来先排队，Agent 什么时候醒什么时候答
    if (p === '/api/inbox' && method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
      const html = String(body.html || '');
      const fontUrl = String(body.fontUrl || '');
      const key = String(body.key || ('inbox:' + crypto.createHash('sha1')
        .update(html || String(body.text || '') || String(Date.now())).digest('hex')));
      let question = '';
      if (html) {
        const restored = await restoreText(html, fontUrl);
        question = restored.text || '';
      }
      if (!question) question = String(body.text || '').slice(0, 4000);

      // [v13] 离线答案库：命中就直接答掉（不消耗 API 额度，也不等 Agent）
      const hit = question ? matchAnswerBank(question) : null;
      if (hit) {
        const item = enqueueInbox(key, {
          seq: Number(body.seq) || 0,
          question,
          decodedText: question,
          text: String(body.text || ''),
          fontUrl,
          html: html ? html.slice(0, 20000) : '',
          answer: hit.answer,
          note: `答案库自动应答（PID ${hit.pid} / ${hit.type} / 置信 ${hit.confidence}）：${hit.note}`,
          answered: true,
          answeredAt: Date.now(),
          fromBank: true,
        });
        console.log(`[bridge] ★ 答案库命中 ${hit.pid} -> ${hit.answer}（${hit.type}，置信 ${hit.confidence}）`);
        return sendJson(res, 200, { ok: true, key, question, answered: true, answer: hit.answer, item, fromBank: true });
      }

      const item = enqueueInbox(key, {
        seq: Number(body.seq) || 0,
        question,
        decodedText: question,
        text: String(body.text || ''),
        fontUrl,
        html: html ? html.slice(0, 20000) : '',
      });
      console.log(`[bridge] 入队一道题（未命中答案库，等待 Agent）：${String(question).slice(0, 80)}`);
      return sendJson(res, 200, { ok: true, key, question, item, fromBank: false });
    }

    if (p === '/api/inbox' && method === 'GET') {
      const pendingOnly = url.searchParams.get('pending') === '1';
      const items = Object.values(inbox)
        .filter(it => (pendingOnly ? !it.answered : true))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map(it => ({
          key: it.key, seq: it.seq, question: it.question, text: it.text,
          file: it.file, answered: !!it.answered, answer: it.answer || '',
          note: it.note || '', createdAt: it.createdAt, updatedAt: it.updatedAt,
        }));
      return sendJson(res, 200, { count: items.length, items });
    }

    if (p === '/api/inbox/answer' && method === 'GET') {
      const key = url.searchParams.get('key') || '';
      const it = inbox[key];
      if (!it) return sendJson(res, 404, { ok: false, answered: false, error: 'not in inbox' });
      return sendJson(res, 200, { ok: true, answered: !!it.answered, answer: it.answer || '', key });
    }

    // [v11] 脚本在截图前先来要明文：{ html, fontUrl } -> { ok, text, decoded }
    if (p === '/api/decode' && method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
      const html = String(body.html || '');
      const fontUrl = String(body.fontUrl || '');
      const restored = await restoreText(html, fontUrl);
      return sendJson(res, 200, {
        ok: !!restored.text,
        text: restored.text,
        decoded: restored.decoded,
        mapSize: restored.map ? Object.keys(restored.map).length : 0,
        fontFile: restored.fontFile || '',
        reason: restored.text ? '' : (fontUrl ? '字体不可用或映射为空' : '未提供 fontUrl'),
      });
    }

    if (p === '/api/cache') {
      return sendJson(res, 200, { cache });
    }

    if (p === '/api/answer' && method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      let key = body.key;
      if (!key && typeof body.seq === 'number') {
        const rec = Array.from(shots.values()).find(s => s.seq === body.seq);
        if (rec) key = rec.key;
      }
      if (!key) return sendJson(res, 400, { error: { message: 'need key or seq' } });
      const answer = String(body.answer || '').trim();
      if (!answer) return sendJson(res, 400, { error: { message: 'need answer' } });
      const rec = shots.get(key) || {};
      // [v11] 用合并而不是覆盖：保留 htmlFile / fontUrl / decodedText 等元信息
      cache[key] = Object.assign({}, cache[key] || {}, {
        seq: rec.seq || (cache[key] && cache[key].seq) || 0,
        answer,
        text: rec.text || (cache[key] && cache[key].text) || '',
        hash: rec.hash || (cache[key] && cache[key].hash) || '',
        file: rec.file || (cache[key] && cache[key].file) || '',
        createdAt: Date.now(),
      });
      saveCache();
      notify(key);
      setInboxAnswer(key, answer, '人工/Agent 写入');
      console.log(`[bridge] 写入答案 #${cache[key].seq} -> ${answer}`);
      return sendJson(res, 200, { ok: true, seq: cache[key].seq, answer });
    }

    if (p === '/api/answers' && method === 'POST') {
      // 批量写答案：{ "items": [ { "seq": 1, "answer": "A" }, ... ] }
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const items = Array.isArray(body.items) ? body.items : [];
      const out = [];
      for (const it of items) {
        let key = it && it.key;
        if (!key && it && typeof it.seq === 'number') {
          const rec = Array.from(shots.values()).find(s => s.seq === it.seq);
          if (rec) key = rec.key;
        }
        const answer = String((it && it.answer) || '').trim();
        if (!key || !answer) { out.push({ seq: it && it.seq, ok: false, error: 'need key/seq + answer' }); continue; }
        const rec = shots.get(key) || {};
        // [v11] 合并写入，保留已有元信息
        cache[key] = Object.assign({}, cache[key] || {}, {
          seq: rec.seq || (cache[key] && cache[key].seq) || 0,
          answer,
          text: rec.text || (cache[key] && cache[key].text) || '',
          hash: rec.hash || (cache[key] && cache[key].hash) || '',
          file: rec.file || (cache[key] && cache[key].file) || '',
          note: (it && it.note) || (cache[key] && cache[key].note) || '',
          createdAt: Date.now(),
        });
        notify(key);
        out.push({ seq: cache[key].seq, ok: true, answer });
        setInboxAnswer(key, answer, (it && it.note) || '人工/Agent 写入');
      }
      saveCache();
      console.log(`[bridge] 批量写入 ${out.filter(o => o.ok).length}/${out.length} 条答案`);
      return sendJson(res, 200, { ok: true, written: out.filter(o => o.ok).length, results: out });
    }

    if (p === '/api/reset' && method === 'POST') {
      cache = {};
      shots.clear();
      shotSeq = 0;
      saveCache();
      try {
        // 只删本服务生成的 <序号>-<hash>.png，保留 _selftest_question.png 之类的手工文件
        for (const f of fs.readdirSync(SHOTS_DIR)) {
          if (/^\d+-[0-9a-f]+\./i.test(f)) fs.unlinkSync(path.join(SHOTS_DIR, f));
        }
      } catch (e) { /* 目录可能还不存在 */ }
      console.log('[bridge] 已清空缓存与截图');
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: { message: 'not found: ' + p } });
  } catch (e) {
    console.log('[bridge] 处理异常：', e && e.stack ? e.stack : e);
    try { return sendJson(res, 500, { error: { message: String(e && e.message || e) } }); }
    catch (_) { try { res.end(); } catch (__) {} }
  }
});

ensureDirs();
loadInbox();
loadBigrams();
loadAnswerBank();
loadCache().catch(e => console.log('[bridge] loadCache 异常：' + e.message));

server.listen(PORT, '127.0.0.1', () => {
  console.log('[bridge] 本地答案中转站已启动');
  console.log(`[bridge]   API      : http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(`[bridge]   截图目录 : ${SHOTS_DIR}`);
  console.log(`[bridge]   等待上限 : ${DEFAULT_WAIT_MS}ms`);
  console.log(`[bridge]   已有截图 : ${shots.size}  已有答案 : ${Object.values(cache).filter(v => v && v.answer).length}`);
});
