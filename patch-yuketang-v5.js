// 打 v5 补丁：给油猴脚本加上「本地答案中转站自动接入」
//   作用：脚本每题先探一下 127.0.0.1:8900 的本地中转站，
//         探到就自动改用它（零 API 额度消耗），探不到就完全按原配置走。
//         另外，主接口若返回 402（余额不足）也会自动降级到本地中转站重试。
//   幂等：重复运行不会重复打补丁。
// 用法：node patch-yuketang-v5.js
const fs = require('fs');
const path = require('path');

const LAB = path.join(__dirname, 'deliverables');
const FILE = path.join(LAB, '雨课堂刷课助手-修复版.user.js');

let src = fs.readFileSync(FILE, 'utf8');

if (src.includes('@version      3.0.6-fix5')) {
  console.log('[v5] 已经打过补丁，跳过。');
  process.exit(0);
}

function mustReplace(from, to, label) {
  if (!src.includes(from)) {
    console.error('[v5] 替换失败（找不到原文）：' + label);
    process.exit(1);
  }
  if (src.indexOf(from) !== src.lastIndexOf(from)) {
    console.error('[v5] 替换失败（原文不唯一）：' + label);
    process.exit(1);
  }
  src = src.replace(from, to);
  console.log('[v5] 已替换：' + label);
}

// ---- 1. 版本号 ----
mustReplace('// @version      3.0.6-fix4', '// @version      3.0.6-fix5', '版本号');

// ---- 2. 顶层纯函数：降级判定（独立成函数，方便单测直接 eval 成品代码） ----
mustReplace(
  '  // ---- 存储工具 ----',
  `  // ---- [v5] 本地答案中转站 ----
  // 本地中转站（127.0.0.1:8900）是一个 OpenAI 兼容的假服务端：
  // 脚本把题目截图发过去 -> 服务端落盘 -> 人工/Agent 读图出答案 -> 回填给脚本。
  // 命中它就不会消耗任何 API 额度。
  const LOCAL_BRIDGE_URL = 'http://127.0.0.1:8900/v1/chat/completions';
  const LOCAL_BRIDGE_HEALTH = 'http://127.0.0.1:8900/api/health';

  // 哪些失败响应值得降级到本地中转站？（余额不足 / 配额耗尽）
  const shouldFallbackToBridge = (status, text) =>
    status === 402 ||
    /insufficient_balance|insufficient balance|quota exceeded|exceeded your current quota/i.test(String(text || ''));

  // ---- 存储工具 ----`,
  '顶层降级判定函数'
);

// ---- 3. Solver 里加探测方法 ----
mustReplace(
  `  const Solver = {
    _lastImage: '',
    async recognize(element) {`,
  `  const Solver = {
    _lastImage: '',
    // [v5] 本地答案中转站探测（结果缓存 60 秒，避免每题都探）
    _bridge: { ok: false, checked: false, ts: 0, logged: null },
    async probeLocalBridge() {
      const now = Date.now();
      if (this._bridge.checked && now - this._bridge.ts < 60000) return this._bridge;
      this._bridge.checked = true;
      this._bridge.ts = now;
      let ok = false;
      try {
        ok = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: LOCAL_BRIDGE_HEALTH,
            timeout: 1500,
            onload: (r) => resolve(r.status === 200),
            onerror: () => resolve(false),
            ontimeout: () => resolve(false),
          });
        });
      } catch (e) {
        ok = false;
      }
      this._bridge.ok = ok;
      if (this._bridge.logged !== ok) {
        this._bridge.logged = ok;
        panel.log(ok
          ? '🔗 已接入本地答案中转站（不消耗 API 额度）'
          : 'ℹ️ 未检测到本地答案中转站，按 [AI配置] 中的接口请求');
      }
      return this._bridge;
    },
    async recognize(element) {`,
  'Solver.probeLocalBridge'
);

// ---- 4. askAI：自动改投本地中转站 ----
mustReplace(
  `    async askAI(ocrText, optionCount = 0) {
      const saved = Store.getAIConf();
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const MODEL_NAME = saved.model;
      const API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';
      return new Promise((resolve, reject) => {`,
  `    async askAI(ocrText, optionCount = 0) {
      const saved = Store.getAIConf();
      let API_URL = saved.url;
      let API_KEY = saved.key;
      let MODEL_NAME = saved.model;
      let API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';

      // [v5] 本地答案中转站自动接入：
      //   探到 127.0.0.1:8900 就在跑 -> 自动改用它，不需要在 [AI配置] 里手动改 URL/Key/Model；
      //   探不到 -> 完全按原配置走，行为和以前一模一样。
      const bridge = await Solver.probeLocalBridge();
      let useBridge = false;
      if (bridge && bridge.ok) {
        useBridge = true;
        API_URL = LOCAL_BRIDGE_URL;
        API_KEY = 'local';
        MODEL_NAME = 'minimax-local';
        API_FORMAT = 'openai';   // 本地中转站只支持 OpenAI 格式
      }

      return new Promise((resolve, reject) => {`,
  'askAI 自动接入本地中转站'
);

// ---- 5. Anthropic 分支：接入本地时强制走 OpenAI 格式 ----
mustReplace(
  `        if (API_FORMAT === 'anthropic') {`,
  `        if (API_FORMAT === 'anthropic' && !useBridge) {`,
  'Anthropic 分支条件'
);

// ---- 6. OpenAI 分支：参数化 + 402 自动降级 ----
mustReplace(
  `          const buildMessages = (withImage) => {
            if (withImage && imageData) {`,
  `          const buildMessages = (withImage, imgOverride) => {
            const img = imgOverride !== undefined ? imgOverride : imageData;
            if (withImage && img) {`,
  'buildMessages 支持图片覆盖'
);

mustReplace(
  `                    { type: 'image_url', image_url: { url: imageData } }`,
  `                    { type: 'image_url', image_url: { url: img } }`,
  'buildMessages 使用覆盖后的图片'
);

mustReplace(
  `          const sendOpenAI = (withImage) => new Promise((res, rej) => {
            GM_xmlhttpRequest({
              method: 'POST',
              url: API_URL,
              headers: {
                'Content-Type': 'application/json',
                ...authHeader
            },
              data: JSON.stringify({
                model: MODEL_NAME,
                messages: buildMessages(withImage),
                temperature: 0.1,
                ...extra
              }),
              timeout: 120000, // 120秒，思考模型需要更长响应时间
              onload: r2 => {
                if (r2.status === 200) {
                  try {
                    const json = JSON.parse(r2.responseText);
                    const answerText = json.choices[0].message.content;
                    res(answerText);
                  } catch (e) {
                    rej('JSON 解析失败');
                  }
                } else {
                  const err = \`请求失败: HTTP \${r2.status} - \${(r2.responseText || '').slice(0, 200)}\`;
                  panel.log(err);
                  rej(err);
                }
              },
              onerror: () => rej('网络错误'),
              ontimeout: () => rej('请求超时')
            });
          });
          // 先试多模态；失败（模型不支持图片 / 参数不兼容）自动回退纯文本
          sendOpenAI(true).then(resolve).catch(err => {
            if (imageData) {
              console.warn('[AI] 多模态请求失败，回退纯文本：', err);
              panel.log('多模态请求失败，改用纯文本重试');
              sendOpenAI(false).then(resolve).catch(reject);
            } else {
              reject(err);
            }
          });`,
  `          // [v5] doOpenAI 可指定目标地址/密钥/模型/图片，
          //      便于主接口余额不足时自动降级到本地答案中转站。
          const doOpenAI = (url, key, model, withImage, imgOverride, headers) => new Promise((res, rej) => {
            GM_xmlhttpRequest({
              method: 'POST',
              url,
              headers: headers || { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${key}\` },
              data: JSON.stringify({
                model,
                messages: buildMessages(withImage, imgOverride),
                temperature: 0.1,
                ...extra
              }),
              timeout: 120000, // 120秒，思考模型需要更长响应时间
              onload: r2 => {
                if (r2.status === 200) {
                  try {
                    const json = JSON.parse(r2.responseText);
                    const answerText = json.choices[0].message.content;
                    res(answerText);
                  } catch (e) {
                    rej('JSON 解析失败');
                  }
                } else {
                  const err = \`请求失败: HTTP \${r2.status} - \${(r2.responseText || '').slice(0, 200)}\`;
                  panel.log(err);
                  // [v5] 余额不足/配额耗尽 -> 自动改投本地答案中转站重试一次（零额度消耗）
                  if (url !== LOCAL_BRIDGE_URL && shouldFallbackToBridge(r2.status, r2.responseText)) {
                    panel.log('💡 主接口额度不足，自动切换到本地答案中转站重试...');
                    doOpenAI(
                      LOCAL_BRIDGE_URL, 'local', 'minimax-local', true,
                      Solver._lastImage || '',
                      { 'Content-Type': 'application/json', 'Authorization': 'Bearer local' }
                    ).then(res).catch(rej);
                    return;
                  }
                  rej(err);
                }
              },
              onerror: () => rej('网络错误'),
              ontimeout: () => rej('请求超时')
            });
          });
          // 先试多模态；失败（模型不支持图片 / 参数不兼容）自动回退纯文本
          doOpenAI(API_URL, API_KEY, MODEL_NAME, true, undefined, authHeader).then(resolve).catch(err => {
            if (imageData) {
              console.warn('[AI] 多模态请求失败，回退纯文本：', err);
              panel.log('多模态请求失败，改用纯文本重试');
              doOpenAI(API_URL, API_KEY, MODEL_NAME, false, undefined, authHeader).then(resolve).catch(reject);
            } else {
              reject(err);
            }
          });`,
  'doOpenAI 参数化 + 402 自动降级'
);

fs.writeFileSync(FILE, src, 'utf8');
console.log('[v5] 补丁完成：' + FILE + '  (' + Buffer.byteLength(src) + ' bytes)');
