// ============================================================================
// 一键跑全套自检 + 校验「用户真实数据未被污染」
// ----------------------------------------------------------------------------
// 为什么要有这个：
//   1) 这些自检脚本会 POST /api/reset、会在 fonts/ 和 shots/ 里落文件。
//      一旦有人图省事直接打生产实例，用户积累的答案和截图就没了
//      （2026-10-21 实际踩过，丢了 5 张已采集截图）。
//   2) 子进程 stdout 的编码在不同机器/终端下不一致，会让「解码结果比对」
//      这类断言随机失败 —— 所以生产脚本一律强制 UTF-8 输出。
//   3) 隔离实例的目录如果不每次清空，上一轮已作答的队列条目会被复用，
//      测试从第二轮起必然失败。
//
// 用法：node run-all-tests.js
// 退出码：0 = 全绿且真实数据未变；非 0 = 有失败
// ============================================================================
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const LAB = __dirname;
const PY = path.join(LAB, '.venv', 'Scripts', 'python.exe');

// [名字, 运行命令, 参数]
const SUITE = [
  ['中转站基础接口', process.execPath, ['test-local-answer-server.js']],
  ['页面答案栏提取', process.execPath, ['test-extract-page-answer.js']],
  ['v5 桥接回退', process.execPath, ['test-v5-bridge-fallback.js']],
  ['/api/decode 端点', process.execPath, ['test-decode-endpoint.js']],
  ['待答队列 inbox', process.execPath, ['test-inbox.js']],
  ['字体解码链路', PY, ['test-decode-pipeline.py']],
  ['离线答案库端到端', process.execPath, ['test-answer-bank.js']],
  ['兜底解码(错字体)', process.execPath, ['test-fallback-decode.js']],
  ['进度取值逻辑', process.execPath, [path.join('deliverables', 'test-progress-logic.js')]],
  ['错误路径对比', PY, [path.join('deliverables', 'test-error-paths.py')]],
];

// ---- 真实数据指纹 ----
function fingerprint() {
  const lines = [];
  const walk = (dir, base) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = path.join(dir, e.name);
      const rel = path.join(base, e.name);
      if (e.isDirectory()) walk(p, rel);
      else lines.push(`${rel}|${fs.statSync(p).size}|${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12)}`);
    }
  };
  walk(path.join(LAB, 'shots'), 'shots');
  for (const f of ['answer-cache.json', 'inbox.json']) {
    const p = path.join(LAB, f);
    lines.push(fs.existsSync(p)
      ? `${f}|${fs.statSync(p).size}|${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12)}`
      : `${f}|(不存在)`);
  }
  return { list: lines, hash: crypto.createHash('sha1').update(lines.join('\n')).digest('hex') };
}

const before = fingerprint();
console.log('真实数据指纹（跑测试前）: ' + before.hash);
console.log('='.repeat(68));

let failed = 0;
for (const [name, cmd, args] of SUITE) {
  const r = spawnSync(cmd, args, { cwd: LAB, encoding: 'utf8', env: process.env });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const m = /结果：(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(out);
  const ok = r.status === 0;
  if (!ok) failed += 1;
  const detail = m ? `${m[1]} 通过 / ${m[2]} 失败`
    : (out.split('\n').filter(l => l.trim() && !/^(meta NOT subset|警告|warning)/i.test(l.trim())).pop() || '').slice(0, 60);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${detail}`);
  if (!ok) {
    console.log('      ---- 失败输出 ----');
    console.log(out.split('\n').slice(-25).map(l => '      ' + l).join('\n'));
  }
}

console.log('='.repeat(68));
const after = fingerprint();
const same = before.hash === after.hash;
console.log('真实数据指纹（跑测试后）: ' + after.hash);
console.log(same
  ? '真实数据未变：PASS（answer-cache.json / inbox.json / shots 逐字节一致）'
  : '真实数据被改动：FAIL！差异如下：\n' +
    before.list.map((l, i) => (l === after.list[i] ? '  = ' : '  ! ') + l + (l === after.list[i] ? '' : '  ->  ' + after.list[i])).join('\n'));

if (failed || !same) process.exit(1);
console.log('\n全部通过，且真实数据零污染。');
