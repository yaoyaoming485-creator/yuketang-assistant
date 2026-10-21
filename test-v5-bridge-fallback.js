// v5 端到端测试：真跑成品 .user.js 里的 askAI 代码
// 场景：主接口返回 402（余额不足）-> 脚本应自动降级到本地答案中转站 -> 拿到正确答案
// 做法：用括号匹配器从成品脚本里抽出 Store / Solver / 顶层常量，
//      放进 new Function 沙箱，用 Node http 实现的假 GM_xmlhttpRequest 驱动。
const fs = require('fs');
const path = require('path');
const http = require('http');

const LAB = __dirname;
const USER_JS = path.join(LAB, 'deliverables', '雨课堂刷课助手-修复版.user.js');
const IMG = path.join(LAB, 'deliverables', '示例题目截图.png');
const { startIsolatedBridge } = require('./test-harness');
let BRIDGE = 'http://127.0.0.1:8904';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`); }
}

// ---- 从源码里按大括号配对抽出一个声明块 ----
// REGEX_KEYWORDS：这些关键字后面出现的 / 是正则字面量，不是除号
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'void',
  'delete', 'instanceof', 'do', 'else', 'yield', 'await', 'throw']);

function isRegexStart(prevSig, lastWord) {
  if (prevSig === '') return true;
  if ('(,=:[!&|?{};+-*%~^<>'.indexOf(prevSig) >= 0) return true;
  if (/[A-Za-z0-9_$]/.test(prevSig)) return REGEX_KEYWORDS.has(lastWord);
  return false;
}

function extractBlock(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('not found: ' + startMarker);
  const open = src.indexOf('{', i);
  let depth = 0, k = open, state = 'code';
  let prevSig = '', lastWord = '', word = '';
  while (k < src.length) {
    const c = src[k], n = src[k + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; k += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; k += 2; continue; }
      if (c === '/' && isRegexStart(prevSig, lastWord)) { state = 'regex'; k++; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
      if (/[A-Za-z0-9_$]/.test(c)) { word += c; }
      else if (word) { lastWord = word; word = ''; }
      if (!/\s/.test(c)) prevSig = c;
      k++;
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
      k++;
    } else if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; k += 2; continue; }
      k++;
    } else if (state === 'regex') {
      if (c === '\\') { k += 2; continue; }
      if (c === '[') { state = 'regexclass'; k++; continue; }
      if (c === '/') { state = 'code'; prevSig = '/'; lastWord = ''; k++; continue; }
      k++;
    } else if (state === 'regexclass') {
      if (c === '\\') { k += 2; continue; }
      if (c === ']') { state = 'regex'; k++; continue; }
      k++;
    } else {
      if (c === '\\') { k += 2; continue; }
      if (c === state) { state = 'code'; prevSig = c; }
      k++;
    }
  }
  throw new Error('unbalanced: ' + startMarker);
}
// ---- 假 GM_xmlhttpRequest（Node http 实现） ----
function makeGM(opts) {
  const u = new URL(opts.url);
  const payload = opts.data ? Buffer.from(opts.data) : null;
  const headers = Object.assign({}, opts.headers || {});
  if (payload) headers['Content-Length'] = payload.length;
  const req = http.request({
    hostname: u.hostname, port: u.port || 80,
    path: u.pathname + u.search, method: opts.method || 'GET', headers,
  }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const responseText = Buffer.concat(chunks).toString('utf8');
      if (opts.onload) opts.onload({ status: res.statusCode, responseText });
    });
  });
  req.on('error', () => { if (opts.onerror) opts.onerror({}); });
  if (opts.ontimeout) req.setTimeout(opts.timeout || 0, () => { req.destroy(); opts.ontimeout(); });
  if (payload) req.write(payload);
  req.end();
}

function postJSON(url, obj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw }); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const iso = await startIsolatedBridge(8904, 'v5');
  BRIDGE = iso.base;
  console.log('  （隔离实例 ' + iso.base + '，不碰用户数据）');
  console.log('== v5 本地中转站自动接入 端到端测试 ==\n');

  const src = fs.readFileSync(USER_JS, 'utf8');
  // 版本断言写成「>= fix12」而不是硬编码某个具体号：
  // 硬编码会在每次升版时变成一条误报噪声，而这里真正要守住的是
  // 「至少包含 v12 的『取题 + 本地中转站队列』能力」。
  const verMatch = /@version\s+(\d+\.\d+\.\d+-fix(\d+))/.exec(src);
  const fixNo = verMatch ? parseInt(verMatch[2], 10) : -1;
  check('S1 成品版本号 >= 3.0.6-fix12', fixNo >= 12, verMatch && verMatch[1]);

  // 顶层常量与判定函数
  const urlConst = /const LOCAL_BRIDGE_URL = '([^']*)';/.exec(src);
  const healthConst = /const LOCAL_BRIDGE_HEALTH = '([^']*)';/.exec(src);
  const fallbackDecl = /const shouldFallbackToBridge = [\s\S]*?;\n/.exec(src);
  check('S2 顶层含 LOCAL_BRIDGE_URL / HEALTH / shouldFallbackToBridge',
    !!(urlConst && healthConst && fallbackDecl));
  check('S3 LOCAL_BRIDGE_URL 指向 127.0.0.1:8900', !!(urlConst && urlConst[1].includes('127.0.0.1:8900')),
    urlConst && urlConst[1]);

  const storeCode = extractBlock(src, 'const Store = {');
  const solverCode = extractBlock(src, 'const Solver = {');
  check('S4 成功抽出 Store / Solver 代码块', storeCode.length > 100 && solverCode.length > 100);

  // 假的主接口（模拟 MiniMax 余额耗尽）
  let fakeHits = 0;
  const fake = http.createServer((req, res) => {
    fakeHits++;
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'insufficient_balance_error', message: 'insufficient balance (1008)', http_code: '402' },
    }));
  });
  await new Promise(r => fake.listen(8901, '127.0.0.1', r));
  console.log('  （假主接口已起在 127.0.0.1:8901，恒返回 402）');

  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(IMG).toString('base64');
  const OCR = 'OCR 文本';

  // 先把中转站清空，保证从干净状态开始
  await postJSON(BRIDGE + '/api/reset', {});

  // 轮询中转站，等新截图落盘（askAI 的请求是挂起等待的，靠外部写答案唤醒）
  async function waitForNewShot(baseline, timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await getJSON(BRIDGE + '/api/shots');
      const list = (r.shots || []).filter(s => s.seq > baseline);
      if (list.length) return list[list.length - 1];
      await new Promise(r2 => setTimeout(r2, 200));
    }
    return null;
  }
  async function currentMaxSeq() {
    const r = await getJSON(BRIDGE + '/api/shots');
    return (r.shots || []).reduce((m, s) => Math.max(m, s.seq), 0);
  }

  // 构造沙箱：把抽出的成品代码放进 new Function
  function buildSandbox(healthOverride) {
    const healthLine = healthConst
      ? healthConst[0]
      : "const LOCAL_BRIDGE_HEALTH = 'http://127.0.0.1:8900/api/health';";
    const code = [
      healthOverride ? `const LOCAL_BRIDGE_HEALTH = '${healthOverride}';` : healthLine,
      // [隔离] 成品里 LOCAL_BRIDGE_URL 是写死的 8900，沙箱里要改指向隔离实例，
      //        否则测试会往**用户正在用的**中转站发请求、往用户 shots 目录里丢图。
      `const LOCAL_BRIDGE_URL = '${iso.base}/v1/chat/completions';`,
      fallbackDecl ? fallbackDecl[0] : 'const shouldFallbackToBridge = (s, t) => s === 402;',
      storeCode,
      solverCode,
      'return { Store, Solver };',
    ].join('\n');
    return new Function('GM_xmlhttpRequest', 'panel', 'Config', 'Utils', code);
  }

  const panel = { log: (m) => console.log('    [面板] ' + m) };
  const Config = { storageKeys: { ai: 'ykt_ai', progress: 'ykt_progress' } };
  const Utils = { safeJSONParse: (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } } };

  // ---- T-A：探测到本地中转站 -> 直接用它，不打主接口 ----
  {
    const factory = buildSandbox(null);
    const { Store, Solver } = factory(makeGM, panel, Config, Utils);
    Store.getAIConf = () => ({
      url: 'http://127.0.0.1:8901/v1/chat/completions',
      key: 'sk-faketoken', model: 'MiniMax-M3', apiFormat: 'openai', authMethod: 'bearer',
    });
    Solver._lastImage = dataUrl;
    const before = fakeHits;
    const baseSeq = await currentMaxSeq();

    // 真实协作流程：askAI 发请求 -> 中转站挂起 -> 我们写答案 -> 它立刻返回
    const pending = Solver.askAI(OCR, 4);
    const shot = await waitForNewShot(baseSeq);
    check('T-A0 题目截图已进中转站并挂起等待', !!shot, shot ? `seq=${shot.seq}` : '未捕获到新截图');
    if (shot) await postJSON(BRIDGE + '/api/answer', { seq: shot.seq, answer: 'A' });

    let out = null, err = null;
    try { out = await pending; } catch (e) { err = String(e && e.message || e); }
    check('T-A1 探测路径返回 "正确答案：A"', out === '正确答案：A', `out=${out} err=${err}`);
    check('T-A2 探测路径完全不碰主接口（0 次 402）', fakeHits === before, `fakeHits=${fakeHits} before=${before}`);
  }

  // ---- T-B：探测失败 -> 打主接口 -> 402 -> 自动降级到本地中转站 ----
  {
    const factory = buildSandbox('http://127.0.0.1:9/api/health');   // 探不到
    const { Store, Solver } = factory(makeGM, panel, Config, Utils);
    Store.getAIConf = () => ({
      url: 'http://127.0.0.1:8901/v1/chat/completions',
      key: 'sk-faketoken', model: 'MiniMax-M3', apiFormat: 'openai', authMethod: 'bearer',
    });
    Solver._lastImage = dataUrl;
    const before = fakeHits;
    let out = null, err = null;
    try { out = await Solver.askAI(OCR, 4); } catch (e) { err = String(e && e.message || e); }
    check('T-B1 降级路径最终返回 "正确答案：A"', out === '正确答案：A', `out=${out} err=${err}`);
    check('T-B2 主接口确实被调用过（先撞 402 再降级）', fakeHits === before + 1, `fakeHits=${fakeHits} before=${before}`);
  }

  // ---- T-C：shouldFallbackToBridge 行为（真跑成品里的函数） ----
  {
    const decl = fallbackDecl[0].replace(/^const shouldFallbackToBridge =/, 'return');
    const fn = new Function(decl)();
    check('T-C1 402 判定为 true', fn(402, '') === true);
    check('T-C2 insufficient_balance 文本判定为 true', fn(500, 'insufficient balance (1008)') === true);
    check('T-C3 quota exceeded 判定为 true', fn(429, 'You exceeded your current quota') === true);
    check('T-C4 401 判定为 false', fn(401, 'unauthorized') === false);
    check('T-C5 500 普通错误判定为 false', fn(500, 'internal error') === false);
  }

  fake.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  iso.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
