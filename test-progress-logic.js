/**
 * 用模拟 DOM 验证打好的 .user.js 里的进度取值逻辑。
 * 做法：直接从补丁后的成品文件里正则抽出函数源码，在沙箱里 eval，
 *       配一个支持后代选择器的假 document，喂三种真实可能的 DOM 结构。
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '雨课堂刷课助手-修复版.user.js');
const src = fs.readFileSync(file, 'utf8');

// ---- 从成品里抽取函数（含签名） ----
function extract(name) {
  const re = new RegExp('\\n\\s{4}' + name + '\\([^)]*\\)\\s*\\{');
  const m = src.match(re);
  if (!m) throw new Error('未找到函数 ' + name);
  const declStart = src.indexOf(m[0]) + 1;
  const braceStart = src.indexOf('{', declStart);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(declStart, i);
}

const code = [
  'const document = globalThis.__doc;',
  'const Utils = {',
  extract('isProgressDone') + ',',
  extract('isProgressFullyDone') + ',',
  extract('getProgressText'),
  '};',
  'globalThis.__api = {',
  '  isProgressDone: Utils.isProgressDone,',
  '  isProgressFullyDone: Utils.isProgressFullyDone,',
  '  getProgressText: Utils.getProgressText,',
  '};',
].join('\n');

// ---- 假 DOM（支持后代选择器） ----
function mkEl(cls, text, parent) {
  return {
    _cls: cls, _text: text || '', _children: [], _parent: parent || null,
    get className() { return this._cls; },
    get innerText() { return this._text; },
    get textContent() { return this._text; },
    querySelector(sel) { return queryIn(this, sel); },
    querySelectorAll(sel) { return queryAllIn(this, sel); },
  };
}

// 单个简单选择器（只含 class，如 "progress-wrap"）是否匹配
function matchSimple(el, cls) {
  if (!cls || cls === '*') return true;
  return (el._cls || '').split(/\s+/).includes(cls);
}

// "A B C" 后代选择器：最后一个是最内层，其余必须是祖先
function matchFull(el, sel) {
  const parts = sel.trim().split(/\s+/).map(p => p.replace(/^\./, ''));
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let node = el._parent, need = parts.length - 2;
  while (node && need >= 0) {
    if (matchSimple(node, parts[need])) need--;
    node = node._parent;
  }
  return need < 0;
}

function queryIn(root, sel) {
  for (const one of String(sel).split(',')) {
    const s = one.trim();
    if (!s) continue;
    for (const c of root._children) {
      if (matchFull(c, s)) return c;
      const r = queryIn(c, s);
      if (r) return r;
    }
  }
  return null;
}

function queryAllIn(root, sel) {
  let out = [];
  for (const one of String(sel).split(',')) {
    const s = one.trim();
    if (!s) continue;
    for (const c of root._children) {
      if (matchFull(c, s)) out.push(c);
      out = out.concat(queryAllIn(c, s));
    }
  }
  return out;
}

function buildDom(variant) {
  const body = mkEl('body', '', null);
  if (variant === 'old') {
    // 旧结构：.progress-wrap > .text
    const wrap = mkEl('progress-wrap', '', body);
    wrap._children.push(mkEl('text', '98%', wrap));
    body._children.push(wrap);
  } else if (variant === 'new') {
    // 新结构（线上 pc.js 的 study-progress 组件）：百分比在 tooltip 的 content slot 里
    const wrap = mkEl('progress-wrap', '', body);
    const tip = mkEl('item', '', wrap);
    const content = mkEl('div', '', tip);
    content._children.push(mkEl('f16 font-weight500', '98', content));
    content._children.push(mkEl('f12', '%', content));
    tip._children.push(content);
    wrap._children.push(tip);
    body._children.push(wrap);
  } else if (variant === 'new-leaf') {
    // 新结构：数字与 % 分开，wrap 自身 innerText 为空
    const wrap = mkEl('progress-wrap', '', body);
    const num = mkEl('f16 font-weight500', '98', wrap);
    wrap._children.push(num);
    body._children.push(wrap);
  } else if (variant === 'done') {
    const wrap = mkEl('progress-wrap', '', body);
    wrap._children.push(mkEl('text', '已完成', wrap));
    body._children.push(wrap);
  }
  // none: 什么都没有
  return body;
}

function apiFor(variant) {
  globalThis.__doc = buildDom(variant);
  new Function('globalThis', code)(globalThis);
  return globalThis.__api;
}

const variants = [
  ['old', '旧结构 .progress-wrap > .text'],
  ['new', '新结构 tooltip content slot'],
  ['new-leaf', '新结构 数字/百分号分开'],
  ['done', '显示"已完成"'],
  ['none', '没有进度节点'],
];

console.log('='.repeat(76));
console.log('从成品 .user.js 抽取的进度取值逻辑 —— 模拟 DOM 测试');
console.log('='.repeat(76));

for (const [key, desc] of variants) {
  const api = apiFor(key);
  const txt = api.getProgressText();
  console.log('');
  console.log('[' + key + '] ' + desc);
  console.log('  getProgressText()     -> ' + JSON.stringify(txt));
  console.log('  isProgressDone(txt)   -> ' + api.isProgressDone(txt));
  console.log('  isProgressFullyDone   -> ' + api.isProgressFullyDone(txt));
  if (key === 'none') {
    console.log('  -> 取不到文本时 waitPlaybackComplete 降级（ended+5s 即视为完成），不会卡死');
  }
}

console.log('');
console.log('='.repeat(76));
console.log('判定语义复核');
console.log('='.repeat(76));
const api = apiFor('old');
const cases = [
  ['98%', true, false],
  ['99%', true, false],
  ['100%', true, true],
  ['已完成', true, true],
  ['50%', false, false],
  ['', false, false],
  [null, false, false],
  [undefined, false, false],
];
let allOk = true;
for (const [t, expDone, expFull] of cases) {
  const d = api.isProgressDone(t), f = api.isProgressFullyDone(t);
  const ok = (d === expDone && f === expFull);
  if (!ok) allOk = false;
  console.log(`  ${ok ? 'OK ' : 'FAIL'} isProgressDone(${JSON.stringify(t)})=${d}   isProgressFullyDone=${f}`);
}
console.log('');
console.log(allOk ? '语义复核全部通过' : '语义复核存在失败项');
