// v9 补丁：去掉有害的 foreignObjectRendering，改用已实测正确的方案
// ---------------------------------------------------------------------------
// 离线实测结论（headless Edge + 真实混淆字体 + 真 html2canvas 1.4.1）：
//   ① 原生 DOM                                    -> 字形正确
//   ② html2canvas 默认（@font-face 在 <style> 文本里） -> 字形正确  ★
//   ③ html2canvas + onclone 注入 data:URL 字体       -> 字形正确  ★
//   ④ html2canvas + foreignObjectRendering          -> 字形错误（乱码）  ✘
// 所以 v6~v8 里"优先用 foreignObjectRendering"的逻辑是**反效果**，必须去掉；
// 而且 rainclass 混淆字体的 @font-face 是**通过 CSSOM 动态注入**的（<style> 文本为空），
// html2canvas 复制样式时只复制文本 -> 克隆文档里没有这条 @font-face -> 字体 fallback -> 乱码。
// v9 的正解：onclone 里把混淆字体以 data:URL 形式注入克隆文档（实测有效）。
const fs = require('fs');
const path = require('path');

const LAB = path.join(__dirname, 'deliverables');
const FILE = path.join(LAB, '雨课堂刷课助手-修复版.user.js');

let src = fs.readFileSync(FILE, 'utf8');

if (src.includes('@version      3.0.6-fix9')) {
  console.log('[v9] 已经打过补丁，跳过。');
  process.exit(0);
}

function mustReplace(from, to, label) {
  if (!src.includes(from)) { console.error('[v9] 替换失败（找不到原文）：' + label); process.exit(1); }
  if (src.indexOf(from) !== src.lastIndexOf(from)) { console.error('[v9] 替换失败（原文不唯一）：' + label); process.exit(1); }
  src = src.replace(from, to);
  console.log('[v9] 已替换：' + label);
}

mustReplace('// @version      3.0.6-fix8', '// @version      3.0.6-fix9', '@version');
mustReplace("version: '3.0.6-fix8',", "version: '3.0.6-fix9',", 'Config.version');

// 去掉 foreignObjectRendering 优先逻辑（实测它对 webfont 是反效果）
mustReplace(
  `        // [v6-3] 优先 foreignObjectRendering：浏览器原生渲染，webfont 才能正确显示；
        //         失败或渲染出空白图则回退默认渲染。
        const renderOpts = {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff',
          // [v7] 把内联混淆字体带进克隆文档 —— 保留混淆语义，只换字体来源，绕开跨域/加载时序
          onclone: (clonedDoc) => {
            try {
              if (Solver._fontData) {
                const st = clonedDoc.createElement('style');
                st.textContent = Solver._fontFaceCss();
                clonedDoc.head.appendChild(st);
              }
            } catch (e) { /* ignore */ }
          },
        };
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
        }`,
  `        // [v9] 渲染策略（经离线实测确定）：
        //   - 不用 foreignObjectRendering：实测它对 webfont 是反效果，会渲染出乱码
        //   - 默认渲染本身能正确呈现 webfont，前提是克隆文档里有那条 @font-face
        //   - 雨课堂的 @font-face 是 CSSOM 动态注入的（<style> 文本为空），
        //     html2canvas 复制样式时只复制文本 -> 克隆文档缺规则 -> 字体 fallback -> 乱码
        //   - 所以在 onclone 里把混淆字体以 data:URL 形式注入克隆文档（实测有效）
        const renderOpts = {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff',
          onclone: (clonedDoc) => {
            try {
              const css = Solver._fontFaceCss();
              if (css) {
                const st = clonedDoc.createElement('style');
                st.textContent = css;
                clonedDoc.head.appendChild(st);
              }
            } catch (e) { /* ignore */ }
          },
        };
        const canvas = await html2canvas(element, renderOpts);`,
  '去掉 foreignObjectRendering，保留 onclone 注入'
);

// 字体 CSS 生成：优先 data URL（实测有效），没有 data 才用原始 URL
mustReplace(
  `    _fontFaceCss() {
      if (!this._fontData) return '';
      return '@font-face{font-family:"ykt-obf";src:url(data:font/ttf;base64,' + this._fontData +
        ') format("truetype");font-weight:normal;font-style:normal;}' +
        '.xuetangx-com-encrypted-font{font-family:"ykt-obf",inherit !important;}';
    },`,
  `    _fontFaceCss() {
      let src = '';
      if (this._fontData) {
        src = 'url(data:font/ttf;base64,' + this._fontData + ') format("truetype")';
      } else if (this._fontUrl) {
        src = 'url("' + this._fontUrl + '") format("truetype")';
      }
      if (!src) return '';
      return '@font-face{font-family:"ykt-obf";src:' + src + ';font-weight:normal;font-style:normal;}' +
        '.xuetangx-com-encrypted-font{font-family:"ykt-obf",inherit !important;}';
    },`,
  '_fontFaceCss 支持 URL 兜底'
);

fs.writeFileSync(FILE, src, 'utf8');
console.log('[v9] 补丁完成：' + FILE + '  (' + Buffer.byteLength(src) + ' bytes)');
