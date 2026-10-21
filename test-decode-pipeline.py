# -*- coding: utf-8 -*-
"""
端到端验证 decode-font-mojibake.py（v6 解码链路）

用 fontlab/obfuscated100.ttf（真实构造的混淆字体：fake 字符的 glyph 被换成 real 的字形）
造一份 html，走真实 CLI，验证：
  A. 能从 html 里提取加密 span 的错字符
  B. 能用混淆字体把错字符渲染成"正确字形"的网格图
  C. ddddocr 能给出初版映射
  D. 应用映射后能还原出正确的题面文本
"""
import copy
import json
import os
import random
import shutil
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from fontTools.ttLib import TTFont

LAB = os.path.dirname(os.path.abspath(__file__))
# [隔离] 跑在 .test-runtime/pipeline 下，绝不碰用户真实的 shots/ fonts/ answer-cache.json
# （2026-10-21 教训：自检脚本直连生产目录，曾把用户已采集的截图冲掉）
ISO = os.path.join(LAB, '.test-runtime', 'pipeline')
SHOTS = os.path.join(ISO, 'shots')
FONTS = os.path.join(ISO, 'fonts')
CACHE = os.path.join(ISO, 'answer-cache.json')
OBF = os.path.join(LAB, 'fontlab', 'obfuscated100.ttf')
CORPUS_FILE = os.path.join(LAB, 'YuKeTang', 'answer', '2025秋-人工智能安全与伦理.txt')
PY = os.path.join(LAB, '.venv', 'Scripts', 'python.exe')
DEC = os.path.join(LAB, 'decode-font-mojibake.py')


def child_env():
    """给子进程注入隔离目录（decode-font-mojibake.py 支持这几个环境变量）。"""
    env = dict(os.environ)
    env['YKT_LAB_DIR'] = ISO
    env['YKT_SHOTS_DIR'] = SHOTS
    env['YKT_FONTS_DIR'] = FONTS
    env['YKT_CACHE_FILE'] = CACHE
    env['PYTHONIOENCODING'] = 'utf-8'
    return env

SEQ = 99
pass_n = 0
fail_n = 0


def check(name, cond, extra=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  PASS  ' + name)
    else:
        fail_n += 1
        print('  FAIL  ' + name + ('  -> ' + str(extra) if extra else ''))


def rebuild_pairs():
    """复刻 test-font-decode-v2.py 的随机种子，得到同一批 fake->real 配对。"""
    with open(CORPUS_FILE, encoding='utf-8') as f:
        corpus = f.read()
    uniq = sorted({c for c in corpus if '\u4e00' <= c <= '\u9fff'})
    random.seed(20261020)
    fakes = random.sample(uniq, 100)
    reals = random.sample(uniq, 100)
    return [(f_, r_) for f_, r_ in zip(fakes, reals) if f_ != r_]


def main():
    print('== v6 字体解码链路 端到端验证 ==\n')
    if not os.path.exists(OBF):
        print('缺少混淆字体:', OBF)
        return 1

    pairs = rebuild_pairs()
    truth = {f_: r_ for f_, r_ in pairs}
    fake_str = ''.join(f_ for f_, _ in pairs[:40])
    expect = ''.join(r_ for _, r_ in pairs[:40])
    print('  混淆字体: %s' % OBF)
    print('  加密串  : %s' % fake_str)
    print('  期望还原: %s\n' % expect)

    # 造 html + 就位字体 + 写一条 seq=99 的缓存元信息（模拟中转站采集到的样子）
    shutil.rmtree(ISO, ignore_errors=True)
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(FONTS, exist_ok=True)
    html_path = os.path.join(SHOTS, '%02d-selftest.html' % SEQ)
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write('<p>以下说法正确的是：</p>'
                '<span class="xuetangx-com-encrypted-font">%s</span>'
                '<p>选项在此</p>' % fake_str)
    font_dest = os.path.join(FONTS, 'selftest-obfuscated.ttf')
    shutil.copyfile(OBF, font_dest)

    cache = {}
    if os.path.exists(CACHE):
        try:
            with open(CACHE, 'r', encoding='utf-8') as f:
                cache = json.load(f)
        except Exception:
            cache = {}
    cache['selftest'] = {
        'seq': SEQ, 'fontFile': font_dest, 'htmlFile': html_path,
        'answer': '', 'text': '', 'hash': '', 'file': '',
    }
    with open(CACHE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)

    try:
        # ---- A/B/C：跑 render 模式 ----
        print('-' * 60)
        r = subprocess.run([PY, DEC, str(SEQ)], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=600,
                           env=child_env())
        out = (r.stdout or '').replace('\ufffd', '?')
        print(out[:1500])
        if r.returncode != 0:
            check('CLI render 退出码为 0', False, r.stderr[-400:])
        else:
            check('CLI render 退出码为 0', True)

        grid = os.path.join(SHOTS, '%02d-glyphs.png' % SEQ)
        check('生成了字形网格图', os.path.exists(grid), grid)

        mapfile = os.path.join(SHOTS, '%02d-map-ocr.json' % SEQ)
        check('生成了 OCR 初版映射', os.path.exists(mapfile), mapfile)

        if os.path.exists(mapfile):
            with open(mapfile, 'r', encoding='utf-8') as f:
                ocr = json.load(f)
            hit = sum(1 for k, v in ocr.items() if truth.get(k) == v)
            total = sum(1 for k in ocr if k in truth)
            print('  OCR 还原率: %d/%d (%.1f%%)' % (hit, total, hit / total * 100 if total else 0))
            check('OCR 初版映射覆盖了全部错字符', total >= 40, total)

        # ---- D：用"真值"映射应用，验证能还原文本 ----
        print('-' * 60)
        truth_map_file = os.path.join(SHOTS, '%02d-map-truth.json' % SEQ)
        with open(truth_map_file, 'w', encoding='utf-8') as f:
            json.dump(truth, f, ensure_ascii=False, indent=2)
        r2 = subprocess.run([PY, DEC, str(SEQ), '--map', truth_map_file],
                            capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=300, env=child_env())
        decoded = (r2.stdout or '').strip()
        print('  解码输出: %s' % decoded[:200])
        check('解码后包含正确的还原文本', expect in decoded, decoded[:120])
        check('解码后不含错字符串', fake_str not in decoded)

        # ---- E：乱映射时应当"错得明显"，证明映射确实生效 ----
        wrong_map = {k: 'X' for k in truth}
        wrong_file = os.path.join(SHOTS, '%02d-map-wrong.json' % SEQ)
        with open(wrong_file, 'w', encoding='utf-8') as f:
            json.dump(wrong_map, f, ensure_ascii=False, indent=2)
        r3 = subprocess.run([PY, DEC, str(SEQ), '--map', wrong_file],
                            capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=300, env=child_env())
        decoded3 = (r3.stdout or '').strip()
        check('错误映射时输出确实变了（说明映射真的被应用）', expect not in decoded3)

    finally:
        # 清理测试痕迹（字形网格图保留，方便人工/模型核对字形）
        for p in [html_path,
                  os.path.join(SHOTS, '%02d-map-ocr.json' % SEQ),
                  os.path.join(SHOTS, '%02d-map-truth.json' % SEQ),
                  os.path.join(SHOTS, '%02d-map-wrong.json' % SEQ),
                  font_dest]:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass
        try:
            if os.path.exists(CACHE):
                with open(CACHE, 'r', encoding='utf-8') as f:
                    c = json.load(f)
                c.pop('selftest', None)
                with open(CACHE, 'w', encoding='utf-8') as f:
                    json.dump(c, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    print('\n结果：%d 通过 / %d 失败' % (pass_n, fail_n))
    return 1 if fail_n else 0


if __name__ == '__main__':
    sys.exit(main())
