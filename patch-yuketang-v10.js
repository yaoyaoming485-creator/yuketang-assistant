// v10 补丁：修 font-family 里的非法 inherit 关键字 + 字体加载兜底链
// ---------------------------------------------------------------------------
// 真 bug：_fontFaceCss() 之前写的是
//     .xuetangx-com-encrypted-font{font-family:"ykt-obf",inherit !important;}
//   但 CSS 规范里 font-family 的值列表**不接受 inherit 关键字**（inherit 只能作为
//   整个属性的值，不能混在列表里）-> 整条声明无效 -> 规则被浏览器丢弃 ->
//   onclone 注入的字体规则等于没加。
//
// 兜底链（按可靠性排序）：
//   1) URL 版 @font-face：@font-face 加载跨域字体**不需要 CORS**（CSS 规范特殊对待），
//      而用户场景里主文档的字体已确认加载成功（document.fonts.check === true），
//      所以把同一条规则以 <style> 文本形式注入主文档 + onclone 注入克隆文档即可。
//   2) data:URL 版：脚本用 GM_xmlhttpRequest 下载（不受 CORS 限制）后 base64 上报，
//      注入时完全不依赖任何跨域加载，作为兜底。
//   3) 两者都失败 -> 保持原样（题面会是乱码，但不影响流程，中转站还有答案栏兜底）。
const fs = require('fs');
const path = require('path');

const LAB = path.join(__dirname, 'deliverables');
const FILE = path.join(LAB, '雨课堂刷课助手-修复版.user.js');

let src = fs.readFileSync(FILE, 'utf8');

if (src.includes('@version      3.0.6-fix10')) {
  console.log('[v10] 已经打过补丁，跳过。');
  process.exit(0);
}

function mustReplace(from, to, label) {
  if (!src.includes(from)) { console.error('[v10] 替换失败（找不到原文）：' + label); process.exit(1); }
  if (src.indexOf(from) !== src.lastIndexOf(from)) { console.error('[v10] 替换失败（原文不唯一）：' + label); process.exit(1); }
  src = src.replace(from, to);
  console.log('[v10] 已替换：' + label);
}

mustReplace('// @version      3.0.6-fix9', '// @version      3.0.6-fix10', '@version');
mustReplace("version: '3.0.6-fix9',", "version: '3.0.6-fix10',", 'Config.version');

// 1) 修 fontFaceCss：去掉非法 inherit，URL 优先、data URL 兜底
mustReplace(
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
  `    // [v10] 优先用真实 URL（@font-face 加载跨域字体不需要 CORS），
    //        没有 URL 才用 data:URL（脚本下载后内联，完全不依赖跨域加载）。
    //        注意：font-family 的值列表里**不能**写 inherit —— 那会让整条声明失效。
    _fontFaceCss(preferDataUrl) {
      let src = '';
      if (preferDataUrl && this._fontData) {
        src = 'url(data:font/ttf;base64,' + this._fontData + ') format("truetype")';
      } else if (this._fontUrl) {
        src = 'url("' + this._fontUrl + '") format("truetype")';
      } else if (this._fontData) {
        src = 'url(data:font/ttf;base64,' + this._fontData + ') format("truetype")';
      }
      if (!src) return '';
      return '@font-face{font-family:"ykt-obf";src:' + src + ';font-weight:normal;font-style:normal;}' +
        '.xuetangx-com-encrypted-font{font-family:"ykt-obf" !important;}';
    },`,
  '_fontFaceCss 修 inherit + URL优先'
);

// 2) installFont：注入 URL 版 -> 等加载 -> 不生效再切 data URL 版
mustReplace(
  `    async installFont() {
      if (this._fontReady || !this._fontData) return;
      try {
        const st = document.createElement('style');
        st.id = 'ykt-obf-font';
        st.textContent = this._fontFaceCss();
        document.head.appendChild(st);
        if (document.fonts && document.fonts.load) {
          await document.fonts.load('16px "ykt-obf"');
        }
        this._fontReady = true;
        panel.log('✅ 混淆字体已内联注入（截图将按正确字形渲染）');
      } catch (e) { /* ignore */ }
    },`,
  `    async installFont() {
      if (this._fontReady) return;
      if (!this._fontUrl && !this._fontData) return;
      try {
        const inject = (css) => {
          let st = document.getElementById('ykt-obf-font');
          if (!st) {
            st = document.createElement('style');
            st.id = 'ykt-obf-font';
            document.head.appendChild(st);
          }
          st.textContent = css;
        };
        // 第一步：URL 版
        inject(this._fontFaceCss(false));
        if (document.fonts && document.fonts.load) {
          try { await document.fonts.load('16px "ykt-obf"'); } catch (e) { /* ignore */ }
        }
        let ok = false;
        try { ok = !!(document.fonts && document.fonts.check('16px "ykt-obf"')); } catch (e) { ok = false; }
        // 第二步：URL 版没生效 -> 换成 data:URL 版（完全不依赖跨域加载）
        this._fontUseDataUrl = false;
        if (!ok && this._fontData) {
          inject(this._fontFaceCss(true));
          this._fontUseDataUrl = true;
          if (document.fonts && document.fonts.load) {
            try { await document.fonts.load('16px "ykt-obf"'); } catch (e) { /* ignore */ }
          }
          try { ok = !!(document.fonts && document.fonts.check('16px "ykt-obf"')); } catch (e) { ok = false; }
          if (!ok) this._fontUseDataUrl = false;
        }
        this._fontReady = ok;
        if (ok) {
          panel.log('✅ 混淆字体已注入（截图将按正确字形渲染）');
        } else {
          panel.log('⚠️ 混淆字体注入后仍未生效，题面可能显示为乱码');
        }
      } catch (e) { /* ignore */ }
    },`,
  'installFont 兜底链'
);

// 3) onclone：注入与主文档**实际生效**的那一版（URL 或 data:URL）
mustReplace(
  `              const css = Solver._fontFaceCss();
              if (css) {`,
  `              const css = Solver._fontFaceCss(!!Solver._fontUseDataUrl);
              if (css) {`,
  'onclone 注入与主文档一致的规则'
);

fs.writeFileSync(FILE, src, 'utf8');
console.log('[v10] 补丁完成：' + FILE + '  (' + Buffer.byteLength(src) + ' bytes)');
