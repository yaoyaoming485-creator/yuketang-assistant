// v6 补丁：解决「题面乱码」——混淆字体未生效导致 DOM 里就是错字符
// 三条保险同时上：
//   1) 截图前等 document.fonts.ready，并优先用 html2canvas 的 foreignObjectRendering
//      （浏览器原生渲染，webfont 才会正确显示）；渲染出空白图会自动回退默认渲染。
//   2) 探测 document.fonts.check('exam-data-decrypt-font')，把结果报上来。
//   3) 把「加密原文 innerHTML + 混淆字体 URL」一起发给本地中转站，供本地建表解码。
// 幂等：重复运行不会重复打补丁。
const fs = require('fs');
const path = require('path');

const LAB = path.join(__dirname, 'deliverables');
const FILE = path.join(LAB, '雨课堂刷课助手-修复版.user.js');

let src = fs.readFileSync(FILE, 'utf8');

if (src.includes('@version      3.0.6-fix6')) {
  console.log('[v6] 已经打过补丁，跳过。');
  process.exit(0);
}

function mustReplace(from, to, label) {
  if (!src.includes(from)) { console.error('[v6] 替换失败（找不到原文）：' + label); process.exit(1); }
  if (src.indexOf(from) !== src.lastIndexOf(from)) { console.error('[v6] 替换失败（原文不唯一）：' + label); process.exit(1); }
  src = src.replace(from, to);
  console.log('[v6] 已替换：' + label);
}

// 1. 版本号（@version 元数据 + Config.version 内部显示）
mustReplace('// @version      3.0.6-fix5', '// @version      3.0.6-fix6', '@version');
mustReplace("version: '3.0.6-fix4',", "version: '3.0.6-fix6',", 'Config.version');

// 2. Solver 里加 _lastExtra
mustReplace(
  `  const Solver = {
    _lastImage: '',`,
  `  const Solver = {
    _lastImage: '',
    // [v6] 最近一次截图对应的「加密原文 + 混淆字体信息」，随请求发给本地中转站
    _lastExtra: '',`,
  'Solver._lastExtra'
);

// 3. recognize：字体就绪 + 采集 extra + foreignObject 渲染（含空白回退）
mustReplace(
  `    async recognize(element) {
      if (!element) return '无元素';
      try {
        panel.log('正在截图...');
        const canvas = await html2canvas(element, {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff'
        });
        // [v3] 记住题目截图，供多模态模型直接读图（绕开 OCR 误差）`,
  `    async recognize(element) {
      if (!element) return '无元素';
      try {
        panel.log('正在截图...');

        // [v6-1] 采集「加密原文 + 混淆字体信息」，供本地中转站建表还原题面
        try {
          const fontUrl = (() => {
            for (const st of document.querySelectorAll('style')) {
              const m = /@font-face\\s*\\{[^}]*?font-family:\\s*["']?exam-data-decrypt-font["']?[^}]*?src:\\s*url\\(([^)]+)\\)/i
                .exec(st.textContent || '');
              if (m) return m[1].replace(/["']/g, '');
            }
            return '';
          })();
          let fontLoaded = null;
          try {
            fontLoaded = !!(document.fonts && document.fonts.check('16px exam-data-decrypt-font'));
          } catch (e) { /* ignore */ }
          Solver._lastExtra = { html: element.innerHTML || '', fontUrl: fontUrl, fontLoaded: fontLoaded };
          if (fontLoaded === false) {
            panel.log('⚠️ 混淆字体未加载（题面可能是乱码），已上报原文供本地解码');
          }
        } catch (e) { Solver._lastExtra = ''; }

        // [v6-2] 等字体加载完成
        try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* ignore */ }

        // [v6-3] 优先 foreignObjectRendering：浏览器原生渲染，webfont 才能正确显示；
        //         失败或渲染出空白图则回退默认渲染。
        const renderOpts = { useCORS: true, logging: false, scale: 2, backgroundColor: '#ffffff' };
        let canvas = null;
        try {
          const c = await html2canvas(element, Object.assign({}, renderOpts, { foreignObjectRendering: true }));
          if (c && c.width > 10 && c.height > 10 && !Solver._canvasIsBlank(c)) {
            canvas = c;
            panel.log('（已用原生渲染截图，字体显示正常）');
          } else {
            console.warn('[v6] foreignObject 渲染结果为空白，回退默认渲染');
          }
        } catch (e) {
          console.warn('[v6] foreignObjectRendering 失败，回退默认渲染：', e);
        }
        if (!canvas) {
          canvas = await html2canvas(element, renderOpts);
        }

        // [v3] 记住题目截图，供多模态模型直接读图（绕开 OCR 误差）`,
  'recognize 字体就绪 + extra + foreignObject'
);

// 4. 加一个判断 canvas 是否空白的辅助方法
mustReplace(
  `    async recognize(element) {`,
  `    _canvasIsBlank(canvas) {
      try {
        const ctx = canvas.getContext('2d');
        const w = Math.min(canvas.width, 200), h = Math.min(canvas.height, 200);
        const d = ctx.getImageData(0, 0, w, h).data;
        let nonWhite = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) nonWhite++;
        }
        return nonWhite < 50;
      } catch (e) { return false; }
    },
    async recognize(element) {`,
  'Solver._canvasIsBlank'
);

// 5. thinking 参数改名，避免与 extra 字段混淆
mustReplace(
  `          const extra = /^minimax-m3$/i.test(MODEL_NAME) ? { thinking: { type: 'disabled' } } : {};`,
  `          const thinkingExtra = /^minimax-m3$/i.test(MODEL_NAME) ? { thinking: { type: 'disabled' } } : {};`,
  'thinkingExtra 改名'
);

mustReplace(
  `                temperature: 0.1,
                ...extra
              }),`,
  `                temperature: 0.1,
                ...thinkingExtra,
                // [v6] 附带加密原文与字体信息（仅多模态请求带），供本地中转站解码乱码题面
                ...(withImage && Solver._lastExtra ? { extra: Solver._lastExtra } : {})
              }),`,
  '请求体附带 extra'
);

fs.writeFileSync(FILE, src, 'utf8');
console.log('[v6] 补丁完成：' + FILE + '  (' + Buffer.byteLength(src) + ' bytes)');
