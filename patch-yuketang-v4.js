/**
 * 补丁 v4：修 2026 版雨课堂的作业题目索引 + 加失败诊断
 *
 * 依据（2026-10-21 实测）：
 *   线上主包 pc.3f25ca35.js 里作业页结构是
 *     div.container-problem            ← 题目正文区
 *       > el-scrollbar > div.subject-item > div.item-type(题号+题型)
 *     div.problems-aside              ← ★ 题目索引侧边栏（与 container-problem 平级！）
 *       > div.problems-aside-content > ul.list-inline > div.subject-item
 *           > span.problem-item-index ← ★ 新题号元素（旧的 problem-index-item 已不存在）
 *   原脚本 getExerciseQuestionTabs() 只在 root(=.container-problem) 内部找索引，
 *   而索引侧边栏在它外面 → 索引数组为空 → "所有题目处理完毕，共 0 题"。
 *
 * 改动：
 *   1) getExerciseQuestionTabs：优先用 .problem-item-index 反查 .subject-item，作用域放宽到整个作业文档
 *   2) 索引为空时打印真实 DOM 诊断（候选元素计数 + 片段），不用再猜
 *   3) autoCommentItem：讨论区评论选择器加新候选 + 失败时打印诊断
 */
const fs = require('fs');
const path = require('path');

const lab = __dirname;
const repo = path.join(lab, 'yuketang-jiaoben');
const src = path.join(repo, 'yuketang.js');
const out = path.join(lab, '雨课堂刷课助手-修复版.user.js');

let text = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');

const patches = [];
const add = (label, from, to) => patches.push({ label, from, to });

/* 1) 题目索引：新增线上结构 + 作用域放宽 + 诊断 */
add(
  'getExerciseQuestionTabs：修线上新结构（.problem-item-index / problems-aside）',
`    getExerciseQuestionTabs(root = this.getExerciseContainer()) {
      if (!root) return [];
      const selectors = [
        '.subject-item.J_order',
        '.subject-item',
        '.problem-index-item',
        '.question-index-item',
        '[class*="subject-item"]',
        '[class*="problem-index"]',
        '[class*="question-index"]'
      ].join(',');
      const all = [...root.querySelectorAll(selectors)];
      return all.filter((el, index, arr) => {
        if (!this.isVisibleElement(el)) return false;
        if (arr.indexOf(el) !== index) return false;
        const text = this.normalizeText(el.innerText);
        return text && text.length <= 20;
      });
    },`,
`    getExerciseQuestionTabs(root = this.getExerciseContainer()) {
      // [v4] 线上（2026）把题目索引挪到了 .problems-aside 侧边栏，与 .container-problem 平级，
      // 原来只在 root 内找 → 永远找不到 → "共 0 题"。这里把作用域放宽到整个作业文档。
      const scope = this.getExerciseDocument() || root || document;
      if (!scope) return [];

      // [v4] 线上新结构：span.problem-item-index（题号）→ 往上找 .subject-item（可点击的索引项）
      const idxSpans = [...scope.querySelectorAll('.problem-item-index')];
      if (idxSpans.length) {
        const tabs = idxSpans
          .map((el) => (el.closest && el.closest('.subject-item')) || el)
          .filter((el, i, arr) => arr.indexOf(el) === i)
          .filter((el) => this.isVisibleElement(el));
        if (tabs.length) return tabs;
      }

      // 旧结构兜底（保留原有选择器）
      const selectors = [
        '.problems-aside .subject-item',
        '.list-inline > .subject-item',
        '.subject-item.J_order',
        '.subject-item',
        '.problem-index-item',
        '.question-index-item',
        '[class*="subject-item"]',
        '[class*="problem-index"]',
        '[class*="question-index"]'
      ].join(',');
      const all = [...scope.querySelectorAll(selectors)];
      return all.filter((el, index, arr) => {
        if (!this.isVisibleElement(el)) return false;
        if (arr.indexOf(el) !== index) return false;
        const text = this.normalizeText(el.innerText);
        return text && text.length <= 20;
      });
    },
    // [v4] 题目索引找不到时，把真实 DOM 线索打到面板日志里（免得再猜）
    diagnoseExerciseTabs(root = this.getExerciseContainer()) {
      const scope = this.getExerciseDocument() || root || document;
      if (!scope) return;
      const counts = {};
      for (const sel of ['.container-problem', '.problems-aside', '.list-inline',
        '.subject-item', '.problem-item-index', '.problem-content', '.problem-body',
        '.item-type', '.item-line', '.container-body']) {
        counts[sel] = scope.querySelectorAll(sel).length;
      }
      try {
        console.log('[诊断] 作业页元素计数', counts);
        this.panel.log('诊断: ' + JSON.stringify(counts));
        const aside = scope.querySelector('.problems-aside, .problems-aside-content');
        if (aside) {
          const cls = [...new Set([...aside.querySelectorAll('*')]
            .map((e) => String(e.className || '').split(' ')[0])
            .filter((c) => c && c.length > 2))].slice(0, 25);
          console.log('[诊断] 侧边栏类名', cls);
          this.panel.log('诊断-侧边栏类名: ' + cls.join(','));
        }
      } catch (e) { /* 忽略 */ }
    },`
);

/* 2) 讨论区评论选择器：加新候选 + 诊断 */
add(
  'autoCommentItem：讨论评论选择器加候选并加诊断',
`      const commentSelectors = ['#new_discuss .new_discuss_list .cont_detail', '.new_discuss_list dd .cont_detail', '.cont_detail.word-break'];`,
`      // [v4] 旧类名（new_discuss / cont_detail）在 2026 版线上已完全消失，补一批候选
      const commentSelectors = [
        '#new_discuss .new_discuss_list .cont_detail',
        '.new_discuss_list dd .cont_detail',
        '.cont_detail.word-break',
        '.word-break',
        '.topic_describe',
        '.discuss-item .content',
        '.discuss-content',
        '.post-content',
        '.reply-content',
        '[class*="comment-content"]',
        '[class*="discuss-content"]',
        '[class*="reply-content"]',
        '[class*="post-content"]'
      ];`
);

add(
  'autoCommentItem：找不到评论时打印诊断',
`      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
      } else {`,
`      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
        // [v4] 诊断：把当前页可能的评论/讨论容器打出来，避免盲猜
        try {
          const cands = {};
          for (const sel of ['.cont_detail', '.word-break', '.topic_describe',
            '[class*="comment"]', '[class*="discuss"]', '[class*="reply"]', '[class*="post"]',
            '.el-textarea__inner', 'textarea']) {
            const n = document.querySelectorAll(sel).length;
            if (n) cands[sel] = n;
          }
          console.log('[诊断] 讨论页候选', cands);
          this.panel.log('诊断: ' + JSON.stringify(cands));
        } catch (e) { /* 忽略 */ }
      } else {`
);

/* 3) 版本号 */
add('版本号 v4', `// @version      3.0.6-fix3`, `// @version      3.0.6-fix4`);
add('Config.version v4', `    version: '3.0.6-fix3',`, `    version: '3.0.6-fix4',`);

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
