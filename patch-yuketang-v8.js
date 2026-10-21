// v8 补丁：混淆字体 URL 提取改为遍历 CSSOM
// ---------------------------------------------------------------------------
// v7 实测：fontLoaded=true（字体在浏览器里是好的），但 fontUrl='' —— 说明
// 混淆字体的 @font-face 不是写在 <style> 文本里的，而是通过 CSSStyleSheet
// / FontFace API 动态注入的。这种情况下 <style>.textContent 里找不到，
// 但 document.styleSheets 的 cssRules 里能读到。
// v8：先遍历 styleSheets 的 cssRules（FONT_FACE_RULE，type === 5），
//     再兜底扫 <style> 文本。两处都找不到时，如实上报原因，便于诊断。
const fs = require('fs');
const path = require('path');

const LAB = path.join(__dirname, 'deliverables');
const FILE = path.join(LAB, '雨课堂刷课助手-修复版.user.js');

let src = fs.readFileSync(FILE, 'utf8');

if (src.includes('@version      3.0.6-fix8')) {
  console.log('[v8] 已经打过补丁，跳过。');
  process.exit(0);
}

function mustReplace(from, to, label) {
  if (!src.includes(from)) { console.error('[v8] 替换失败（找不到原文）：' + label); process.exit(1); }
  if (src.indexOf(from) !== src.lastIndexOf(from)) { console.error('[v8] 替换失败（原文不唯一）：' + label); process.exit(1); }
  src = src.replace(from, to);
  console.log('[v8] 已替换：' + label);
}

mustReplace('// @version      3.0.6-fix7', '// @version      3.0.6-fix8', '@version');
mustReplace("version: '3.0.6-fix7',", "version: '3.0.6-fix8',", 'Config.version');

mustReplace(
  `          const fontUrl = (() => {
            for (const st of document.querySelectorAll('style')) {
              const css = st.textContent || '';
              if (css.indexOf('exam-data-decrypt-font') < 0) continue;
              // 先截出所有 @font-face 块，再挑出含 exam-data-decrypt-font 的那个，
              // 最后从块里取 url —— 不能假设 font-family 与 src 的先后顺序。
              const blocks = css.match(/@font-face\\s*\\{[^}]*\\}/gi) || [];
              for (const b of blocks) {
                if (b.indexOf('exam-data-decrypt-font') < 0) continue;
                const m = /src\\s*:\\s*url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/i.exec(b);
                if (m) return m[1];
              }
            }
            return '';
          })();`,
  `          const fontUrl = (() => {
            // 方式一：遍历 CSSOM（字体常由 CSSStyleSheet.insertRule / FontFace API 动态注入，
            //         <style> 文本里看不到，但 cssRules 里能读到）
            try {
              for (const sheet of Array.from(document.styleSheets || [])) {
                let rules = null;
                try { rules = sheet.cssRules; } catch (e) { continue; }  // 跨域样式表读不到，跳过
                if (!rules) continue;
                for (const rule of Array.from(rules)) {
                  if (!rule || rule.type !== 5) continue;                 // 5 = CSSRule.FONT_FACE_RULE
                  const ff = rule.style && rule.style.getPropertyValue('font-family');
                  if (!ff || ff.indexOf('exam-data-decrypt-font') < 0) continue;
                  const srcText = rule.style.getPropertyValue('src') || '';
                  const m = /url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/i.exec(srcText);
                  if (m) return m[1];
                }
              }
            } catch (e) { /* ignore */ }
            // 方式二：兜底扫 <style> 文本
            for (const st of document.querySelectorAll('style')) {
              const css = st.textContent || '';
              if (css.indexOf('exam-data-decrypt-font') < 0) continue;
              const blocks = css.match(/@font-face\\s*\\{[^}]*\\}/gi) || [];
              for (const b of blocks) {
                if (b.indexOf('exam-data-decrypt-font') < 0) continue;
                const m = /src\\s*:\\s*url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/i.exec(b);
                if (m) return m[1];
              }
            }
            return '';
          })();`,
  'fontUrl 提取改为 CSSOM + 文本双通道'
);

fs.writeFileSync(FILE, src, 'utf8');
console.log('[v8] 补丁完成：' + FILE + '  (' + Buffer.byteLength(src) + ' bytes)');
