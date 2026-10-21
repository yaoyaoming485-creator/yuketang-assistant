/**
 * 补丁 v3：给雨课堂刷课助手加「多模态读图」能力（配合 MiniMax-M3 等支持图片输入的模型）
 *
 * 背景（2026-10-20 实测）：
 *   原脚本的答题链路是 html2canvas 截图 -> Tesseract OCR 认字 -> 把【文字】发给大模型。
 *   实测 OCR 单字还原率只有 93%，50 字题干几乎必有一个错字 → 大模型拿到的是被污染的题干，
 *   这正是那些仓库自评"纯文本模型得分率 75%~85%"的成因。
 *   而 MiniMax-M3 原生支持图片输入，**直接发截图就能绕开 OCR 这个最大误差源**。
 *
 * 改动：
 *   1) Solver 记住最近一次题目截图（canvas -> dataURL）
 *   2) OpenAI 分支：当模型/域名是 minimax 时，改为「文字 + 图片」多模态请求；
 *      请求失败自动回退纯文本（兼容所有不支持图片的模型/代理）
 *   3) MiniMax-M3 额外加 thinking:disabled（只答一个字母，没必要思考；M3.1-Flash-Preview 不支持该参数，故按模型名精确匹配）
 *   4) 答案提取：先剥掉 <thinking> 标签，再取【最后一个】"答案"匹配（思考内容里也可能出现"答案"字样）
 *
 * 其余 API 格式、@connect 通配符等一概不动 —— 换 MiniMax 只需在面板里填三项配置。
 */
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, 'yuketang-jiaoben');
const src = path.join(repo, 'yuketang.js');
const out = path.join(__dirname, '雨课堂刷课助手-修复版.user.js');

let text = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');

const patches = [];
const add = (label, from, to) => patches.push({ label, from, to });

/* 1) Solver 增加 _lastImage 字段 */
add(
  'Solver 记住最近一次题目截图',
  `  const Solver = {
    async recognize(element) {`,
  `  const Solver = {
    _lastImage: '',
    async recognize(element) {`
);

/* 2) html2canvas 之后保存截图 */
add(
  'html2canvas 之后保存截图 dataURL',
  `        });
        panel.log('正在 OCR 识别 (首轮较慢)...');`,
  `        });
        // [v3] 记住题目截图，供多模态模型直接读图（绕开 OCR 误差）
        try { Solver._lastImage = canvas.toDataURL('image/png'); } catch (e) { Solver._lastImage = ''; }
        panel.log('正在 OCR 识别 (首轮较慢)...');`
);

/* 3) OpenAI 分支支持多模态 + 失败回退 */
add(
  'OpenAI 分支：多模态读图 + 自动回退纯文本',
  `        } else {
          // OpenAI API 格式（默认）
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers: {
              'Content-Type': 'application/json',
              ...authHeader
            },
            data: JSON.stringify({
              model: MODEL_NAME,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
              ],
              temperature: 0.1
            }),
            timeout: 120000, // 120秒，思考模型需要更长响应时间
            onload: res => {
              if (res.status === 200) {
                try {
                  const json = JSON.parse(res.responseText);
                  const answerText = json.choices[0].message.content;
                  resolve(answerText);
                } catch (e) {
                  reject('JSON 解析失败');
                }
              } else {
                const err = \`请求失败: HTTP \${res.status}\`;
                panel.log(err);
                reject(err);
              }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时')
          });
        }`,
  `        } else {
          // OpenAI API 格式（默认）—— [v3] 支持多模态：直接把题目截图发给模型
          const isVision = /minimax/i.test(MODEL_NAME) || /minimax/i.test(API_URL);
          const imageData = isVision ? (Solver._lastImage || '') : '';
          const visionPrompt = imageData
            ? \`下面是题目的截图（可能同时包含题干和选项）。请以【截图】为准读题；OCR 文本仅供参考，可能有识别错误。
强约束：
1) 本题只有 \${optionCount || '若干'} 个选项，范围 \${rangeStr}
2) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错\`
            : '';
          const buildMessages = (withImage) => {
            if (withImage && imageData) {
              return [
                { role: 'system', content: systemPrompt },
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: visionPrompt + '\\n\\n【OCR 文本（仅供参考，可能有误）】\\n' + ocrText },
                    { type: 'image_url', image_url: { url: imageData } }
                  ]
                }
              ];
            }
            return [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt }
            ];
          };
          // MiniMax-M3 只答一个字母，没必要思考；M3.1-Flash-Preview 不支持该参数，故按模型名精确匹配
          const extra = /^minimax-m3$/i.test(MODEL_NAME) ? { thinking: { type: 'disabled' } } : {};
          const sendOpenAI = (withImage) => new Promise((res, rej) => {
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
          });
        }`
);

/* 4) 答案提取：剥 thinking 标签 + 取最后一个匹配 */
add(
  '答案提取：剥掉 thinking 标签并取最后一个匹配',
  `      const match = aiResponse.match(/(?:正确)?答案[：:]?\\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/i);`,
  `      // [v3] 剥掉思考标签，并取【最后一个】"答案"匹配（思考内容里也可能出现"答案"字样）
      const cleaned = String(aiResponse || '').replace(/<thinking>[\\s\\S]*?<\\/thinking>/gi, '');
      const reAns = /(?:正确)?答案[：:]?\\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/gi;
      let m2 = null, lastM = null;
      while ((m2 = reAns.exec(cleaned)) !== null) { lastM = m2; }
      const match = lastM;`
);

/* 5) 版本号 */
add(
  '版本号标记 v3',
  `// @version      3.0.6-fix2`,
  `// @version      3.0.6-fix3`
);
add(
  'Config.version 同步 v3',
  `    version: '3.0.6',`,
  `    version: '3.0.6-fix3',`
);

/* ---------- 应用 ---------- */
let failed = 0;
for (const p of patches) {
  const first = text.indexOf(p.from);
  const second = first === -1 ? -1 : text.indexOf(p.from, first + 1);
  if (first === -1) { console.error('✗ 未匹配: ' + p.label); failed++; continue; }
  if (second !== -1) { console.error('✗ 出现多次: ' + p.label); failed++; continue; }
  text = text.slice(0, first) + p.to + text.slice(first + p.from.length);
  console.log('✓ ' + p.label);
}
if (failed) {
  console.error('\n有 ' + failed + ' 处补丁未应用，已中止写出。');
  process.exit(1);
}
fs.writeFileSync(src, text, 'utf8');
fs.writeFileSync(out, text, 'utf8');
console.log('\n已写出: ' + out);
console.log('字节数: ' + Buffer.byteLength(text, 'utf8'));
