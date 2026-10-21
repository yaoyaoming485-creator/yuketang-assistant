// v7 补丁：混淆字体「一定拿得到」+ 截图渲染对症修复
// ---------------------------------------------------------------------------
// 背景：题面乱码的根因是混淆字体 exam-data-decrypt-font 没被 html2canvas 正确渲染，
//       DOM 里存的就是被替换过的汉字。
// v7 三件事：
//   1) 脚本自己用 GM_xmlhttpRequest 把混淆字体抓下来（base64）随请求上报，
//      不再依赖中转站能否访问字体 CDN（v6 实测下载失败，fonts/ 一直空）。
//   2) 把字体以 data: URL 注入**主文档**并等它加载完成。
//   3) html2canvas 的 onclone 里把同样的 @font-face 注入**克隆文档**，
//      并把 .xuetangx-com-encrypted-font 的 font-family 指向它 ——
//      保留「混淆」语义（错字符仍画成正确字），只是把字体来源从跨域 URL 换成内联 data URL，
//      从而绕开 CORS / 加载时序问题。不用 allowTaint（那会让 toDataURL 抛错）。
// 幂等：重复运行不会重复打补丁。
const fs = require('fs');
const path = require('path');

const LAB = path.join(__dirname, 'deliverables');
const FILE = path.join(LAB, '雨课堂刷课助手-修复版.user.js');

let src = fs.readFileSync(FILE, 'utf8');

if (src.includes('@version      3.0.6-fix7')) {
  console.log('[v7] 已经打过补丁，跳过。');
  process.exit(0);
}

function mustReplace(from, to, label) {
  if (!src.includes(from)) { console.error('[v7] 替换失败（找不到原文）：' + label); process.exit(1); }
  if (src.indexOf(from) !== src.lastIndexOf(from)) { console.error('[v7] 替换失败（原文不唯一）：' + label); process.exit(1); }
  src = src.replace(from, to);
  console.log('[v7] 已替换：' + label);
}

// 1. 版本号
mustReplace('// @version      3.0.6-fix6', '// @version      3.0.6-fix7', '@version');
mustReplace("version: '3.0.6-fix6',", "version: '3.0.6-fix7',", 'Config.version');

// 2. Solver：字体抓取 + 注入
mustReplace(
  `    // [v6] 最近一次截图对应的「加密原文 + 混淆字体信息」，随请求发给本地中转站
    _lastExtra: '',`,
  `    // [v6] 最近一次截图对应的「加密原文 + 混淆字体信息」，随请求发给本地中转站
    _lastExtra: '',
    // [v7] 混淆字体文件（base64），只抓一次并缓存
    _fontData: '',
    _fontUrl: '',
    _fontReady: false,
    async grabFont(fontUrl) {
      if (this._fontData) return this._fontData;
      if (!fontUrl) return '';
      try {
        const b64 = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: fontUrl,
            responseType: 'arraybuffer',
            timeout: 20000,
            onload: (r) => {
              try {
                const bytes = new Uint8Array(r.response);
                let bin = '';
                const CH = 0x8000;
                for (let i = 0; i < bytes.length; i += CH) {
                  bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
                }
                resolve(btoa(bin));
              } catch (e) { resolve(''); }
            },
            onerror: () => resolve(''),
            ontimeout: () => resolve(''),
          });
        });
        if (b64 && b64.length > 1000) {
          this._fontData = b64;
          this._fontUrl = fontUrl;
          panel.log('✅ 已抓取混淆字体（' + Math.round(b64.length / 1024) + ' KB）');
        }
        return this._fontData;
      } catch (e) {
        return '';
      }
    },
    // [v7] 内联字体 CSS：data URL 字体 + 把加密 span 指向它
    _fontFaceCss() {
      if (!this._fontData) return '';
      return '@font-face{font-family:"ykt-obf";src:url(data:font/ttf;base64,' + this._fontData +
        ') format("truetype");font-weight:normal;font-style:normal;}' +
        '.xuetangx-com-encrypted-font{font-family:"ykt-obf",inherit !important;}';
    },
    // [v7] 注入主文档并等字体就绪
    async installFont() {
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
  'Solver 字体抓取与注入'
);

// 3. recognize：抓字体 + 注入 + onclone
mustReplace(
  `          Solver._lastExtra = { html: element.innerHTML || '', fontUrl: fontUrl, fontLoaded: fontLoaded };`,
  `          // [v7] 直接把字体文件抓下来随请求上报，不再依赖中转站去下载
          const fontData = fontUrl ? await Solver.grabFont(fontUrl) : '';
          if (fontData) await Solver.installFont();
          Solver._lastExtra = {
            html: element.innerHTML || '',
            fontUrl: fontUrl,
            fontData: fontData,
            fontLoaded: fontLoaded,
          };`,
  'recognize 抓取并注入字体'
);

mustReplace(
  `        const renderOpts = { useCORS: true, logging: false, scale: 2, backgroundColor: '#ffffff' };`,
  `        const renderOpts = {
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
        };`,
  'html2canvas onclone 注入字体'
);

fs.writeFileSync(FILE, src, 'utf8');
console.log('[v7] 补丁完成：' + FILE + '  (' + Buffer.byteLength(src) + ' bytes)');
