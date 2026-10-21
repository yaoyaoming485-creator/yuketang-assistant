#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
雨课堂「字体混淆」题面解码器
=====================================================================
背景：雨课堂会把题面里的汉字替换成「错字符」，再用一张动态注入的混淆字体
      (font-family: exam-data-decrypt-font) 把这些错字符画成正确的字形。
      如果该字体没生效（页面加载失败 / 截图工具不认 webfont），
      DOM 里拿到的、截图里看到的，就全是错字符，人和模型都读不懂。

原理：混淆字体的 cmap 里，unicode(错字符) -> glyph(正确字形)。
      所以只要拿到【字体文件】，把每个错字符用该字体渲染出来，
      渲染出的字形就是正确字 —— 认出来即得映射表。

用法：
  1) 渲染 + OCR 初版：
       python decode-font-mojibake.py <seq>
     产出：shots/<seq>-glyphs.png   （带编号的字形网格，供人/模型辨认）
           shots/<seq>-map-ocr.json （ddddocr 自动识别的初版映射）
           标准输出：编号 -> 错字符 的对照表

  2) 应用映射，输出解码后的题面：
       python decode-font-mojibake.py <seq> --map shots/01-map.json
     产出：标准输出为解码后的纯文本题面
"""
import sys
import os
import re
import io
import json
import argparse

from PIL import Image, ImageDraw, ImageFont

# 本脚本的 stdout 是**机器可读**的（父进程按 UTF-8 解码后做字符串比对）。
# Windows 上子进程 stdout 默认跟随系统 ANSI 代码页，中文会被写成 '?'，
# 导致「解码结果是否等于期望文本」永远比不过。强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

SELF_DIR = os.path.dirname(os.path.abspath(__file__))

# 数据目录可用环境变量覆盖，便于测试跑隔离实例而不碰用户的真实 shots/fonts/缓存
LAB = os.environ.get('YKT_LAB_DIR') or SELF_DIR
SHOTS_DIR = os.environ.get('YKT_SHOTS_DIR') or os.path.join(LAB, 'shots')
FONTS_DIR = os.environ.get('YKT_FONTS_DIR') or os.path.join(LAB, 'fonts')
CACHE_FILE = os.environ.get('YKT_CACHE_FILE') or os.path.join(LAB, 'answer-cache.json')

# 宽松匹配加密 span：属性顺序无关 / class 含子串 / 引号任意 / 大小写不敏感 / 可跨行
SPAN_RE = re.compile(
    r'<span\b[^>]*\bclass\s*=\s*["\'][^"\']*\bxuetangx-com-encrypted-font\b[^"\']*["\'][^>]*>'
    r'(.*?)'
    r'</span>',
    re.DOTALL | re.IGNORECASE,
)
TAG_RE = re.compile(r'<[^>]+>')
BR_RE = re.compile(r'<br\s*/?>|</p\s*>', re.IGNORECASE)

GRID_CELL = 96
GLYPH_SIZE = 66


def load_shot(seq):
    """读取某道题采集到的 html / 字体信息（从 answer-cache 或 shots 目录推断）。"""
    # 题目 html 文件：shots/NN-*.html
    candidates = [f for f in os.listdir(SHOTS_DIR) if f.endswith('.html') and f.startswith('%02d-' % seq)]
    if not candidates:
        candidates = [f for f in os.listdir(SHOTS_DIR) if f.endswith('.html') and re.match(r'^0*%d-' % seq, f)]
    if not candidates:
        raise SystemExit('找不到 seq=%s 的 html（目录 %s）' % (seq, SHOTS_DIR))
    html_path = os.path.join(SHOTS_DIR, sorted(candidates)[0])
    with open(html_path, 'r', encoding='utf-8') as f:
        html = f.read()

    # 字体文件：取该序号对应的缓存记录里记录的 fontFile；否则用目录里唯一那个
    font_path = None
    cache_file = CACHE_FILE
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                cache = json.load(f)
            for v in cache.values():
                if isinstance(v, dict) and v.get('seq') == seq and v.get('fontFile'):
                    font_path = v['fontFile']
                    break
        except Exception:
            pass
    if not font_path and os.path.isdir(FONTS_DIR):
        fonts = [os.path.join(FONTS_DIR, x) for x in os.listdir(FONTS_DIR)
                 if x.lower().endswith(('.ttf', '.otf'))]
        if len(fonts) == 1:
            font_path = fonts[0]
        elif fonts:
            font_path = sorted(fonts, key=lambda p: os.path.getmtime(p))[-1]
    if not font_path or not os.path.exists(font_path):
        raise SystemExit('找不到混淆字体文件（目录 %s）' % FONTS_DIR)
    return html, font_path, html_path


def extract_encrypted_text(html):
    """取出加密 span 里的纯文本（错字符），并保留 span 在文中的位置。"""
    spans = []
    out = []
    pos = 0
    for m in SPAN_RE.finditer(html):
        out.append(html[pos:m.start()])
        inner = BR_RE.sub('\n', m.group(1))
        inner = TAG_RE.sub('', inner)
        spans.append(inner)
        out.append('\x00%d\x00' % (len(spans) - 1))   # 占位符，稍后替换
        pos = m.end()
    out.append(html[pos:])
    return ''.join(out), spans


def unique_chars(spans):
    seen = []
    sset = set()
    for s in spans:
        for ch in s:
            if ch.strip() and ch not in sset:
                sset.add(ch)
                seen.append(ch)
    return seen


def render_glyphs(chars, font_path, out_path):
    """把每个错字符用混淆字体渲染成网格图（字形即正确字）。"""
    cols = 8
    rows = (len(chars) + cols - 1) // cols
    W = cols * GRID_CELL
    H = rows * GRID_CELL
    img = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(img)
    try:
        big = ImageFont.truetype(font_path, GLYPH_SIZE)
    except Exception as e:
        raise SystemExit('字体无法被 PIL 加载（只支持 ttf/otf，不能是 woff2）：%s' % e)
    label = ImageFont.truetype(os.path.join(os.environ.get('WINDIR', r'C:\Windows'),
                                             'Fonts', 'arial.ttf'), 13)

    for i, ch in enumerate(chars):
        cx = (i % cols) * GRID_CELL
        cy = (i // cols) * GRID_CELL
        d.rectangle([cx, cy, cx + GRID_CELL - 1, cy + GRID_CELL - 1], outline=(210, 210, 210))
        # 编号
        d.text((cx + 4, cy + 3), str(i), font=label, fill=(200, 60, 60))
        # 字形：用 bbox 居中
        try:
            bbox = d.textbbox((0, 0), ch, font=big)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            d.text((cx + (GRID_CELL - tw) / 2 - bbox[0], cy + (GRID_CELL - th) / 2 - bbox[1]),
                   ch, font=big, fill=(15, 15, 15))
        except Exception:
            d.text((cx + 10, cy + 20), ch, font=big, fill=(15, 15, 15))
    img.save(out_path)
    return out_path


def ocr_map(chars, font_path):
    """用 ddddocr 对每个字形做识别，给出初版映射（准确率约 93%）。"""
    mapping = {}
    try:
        import ddddocr
        ocr = ddddocr.DdddOcr(show_ad=False)
    except Exception as e:
        print('# ddddocr 不可用（%s），跳过 OCR 初版，请人工/模型辨认字形图' % e)
        return mapping
    try:
        big = ImageFont.truetype(font_path, 96)
    except Exception:
        return mapping
    for i, ch in enumerate(chars):
        try:
            img = Image.new('1', (128, 128), 255)
            dr = ImageDraw.Draw(img)
            bbox = dr.textbbox((0, 0), ch, font=big)
            dr.text(((128 - (bbox[2] - bbox[0])) / 2 - bbox[0],
                     (128 - (bbox[3] - bbox[1])) / 2 - bbox[1]), ch, font=big, fill=0)
            # ddddocr 需要带文件头的编码字节，不能直接喂 raw bytes
            buf = io.BytesIO()
            img.save(buf, format='JPEG')
            res = ocr.classification(buf.getvalue())
            if res:
                mapping[ch] = res
        except Exception:
            continue
    return mapping


def apply_map(spans, mapping):
    """把错字符按映射替换成正确字。"""
    def rep(m):
        inner = m.group(0)
        return ''.join(mapping.get(c, c) for c in inner)
    return [''.join(mapping.get(c, c) for c in s) for s in spans]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('seq', type=int, help='题目序号（对应 shots/NN-*.html）')
    ap.add_argument('--map', dest='mapfile', default='', help='人工/模型校正后的映射 json')
    ap.add_argument('--html', action='store_true', help='输出解码后的 html 而不是纯文本')
    args = ap.parse_args()

    html, font_path, html_path = load_shot(args.seq)
    template, spans = extract_encrypted_text(html)

    if not spans:
        print('# 该题目里没有加密 span，题面本就是明文')
        print(TAG_RE.sub('', BR_RE.sub('\n', html)).strip())
        return

    if args.mapfile:
        with open(args.mapfile, 'r', encoding='utf-8') as f:
            mapping = json.load(f)
        decoded_spans = apply_map(spans, mapping)
        out = []
        pos = 0
        for m in SPAN_RE.finditer(html):
            out.append(template[pos:m.start()]) if False else None
        # 重新拼：直接按 span 顺序替换占位符
        parts = re.split(r'\x00(\d+)\x00', template)
        res = []
        for i in range(0, len(parts) - 1, 2):
            res.append(parts[i])
            idx = int(parts[i + 1])
            res.append(decoded_spans[idx] if idx < len(decoded_spans) else '')
        res.append(parts[-1])
        joined = ''.join(res)
        if args.html:
            print(joined)
        else:
            print(TAG_RE.sub('', BR_RE.sub('\n', joined)).strip())
        return

    chars = unique_chars(spans)
    stem = '%02d' % args.seq
    grid = os.path.join(SHOTS_DIR, stem + '-glyphs.png')
    render_glyphs(chars, font_path, grid)
    mapping = ocr_map(chars, font_path)
    mapfile = os.path.join(SHOTS_DIR, stem + '-map-ocr.json')
    with open(mapfile, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    print('# 字体: %s' % font_path)
    print('# html: %s' % html_path)
    print('# 字形网格图: %s' % grid)
    print('# OCR 初版映射: %s' % mapfile)
    print('# 共 %d 个不同字符' % len(chars))
    print('')
    print('# 编号 -> 错字符 -> OCR猜测（需人工/模型核对字形图后修正）')
    for i, ch in enumerate(chars):
        print('%3d  %s  ->  %s' % (i, ch, mapping.get(ch, '?')))


if __name__ == '__main__':
    main()
