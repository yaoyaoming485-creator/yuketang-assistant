# -*- coding: utf-8 -*-
"""
实测 v2：把上一版的坑补上，并测三个实战风险点。

A. 修正上一版的测试 bug（span 包裹 + 控制组去重），确认解码链路端到端正确
B. decode_encrypted_spans 的正则健壮性：真实页面的 span 写法可能有很多种
C. WOFF / WOFF2 能不能解析 —— 仓库 requirements.txt 里没有 brotli
D. 100 样本统计级准确率 + 建表耗时外推
"""
import copy
import os
import random
import sys
import time

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

LAB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(LAB, "YuKeTang"))
from src.utils.font_decode_utils import font_to_img_ddddocr, decode_encrypted_spans  # noqa: E402

SRC_FONT = r"C:\Windows\Fonts\simhei.ttf"
WORK = os.path.join(LAB, "fontlab")
os.makedirs(WORK, exist_ok=True)
OBF = os.path.join(WORK, "obfuscated100.ttf")

# 用仓库里真实的课程答案文件当语料，字形更接近真实场景
CORPUS_FILE = os.path.join(LAB, "YuKeTang", "answer", "2025秋-人工智能安全与伦理.txt")
with open(CORPUS_FILE, encoding="utf-8") as f:
    corpus = f.read()
uniq = sorted({c for c in corpus if "\u4e00" <= c <= "\u9fff"})
print(f"语料来源: {os.path.basename(CORPUS_FILE)}，去重汉字 {len(uniq)} 个")

random.seed(20261020)
N = 100
fakes = random.sample(uniq, N)
reals = random.sample(uniq, N)
# 保证 fake != real
fixed = []
for f_, r_ in zip(fakes, reals):
    if f_ != r_:
        fixed.append((f_, r_))
PAIRS = fixed
controls = [c for c in uniq if c not in {f_ for f_, _ in PAIRS}][:100]

print()
print("=" * 70)
print("A. 构造混淆字体（%d 对）" % len(PAIRS))
print("=" * 70)
font = TTFont(SRC_FONT)
cmap = font.getBestCmap()
glyf = font["glyf"]
hmtx = font["hmtx"]
for fake, real in PAIRS:
    gf, gr = cmap.get(ord(fake)), cmap.get(ord(real))
    if not gf or not gr or gf == gr:
        continue
    g = copy.deepcopy(glyf[gr])
    g.name = gf
    glyf[gf] = g
    try:
        glyf[gf].recalcBounds(glyf)
    except Exception:
        pass
    hmtx[gf] = hmtx[gr]
font.save(OBF)
print(f"  已生成 {OBF}")

print()
print("=" * 70)
print("B. 调仓库 font_to_img_ddddocr() 做 %d 样本统计" % len(PAIRS))
print("=" * 70)
chars = [f_ for f_, _ in PAIRS] + controls
t0 = time.time()
normal_dict = font_to_img_ddddocr(chars, OBF)
dt = time.time() - t0
print(f"  {len(chars)} 字耗时 {dt:.1f}s，{dt/len(chars)*1000:.0f} ms/字")

hit = sum(1 for f_, r_ in PAIRS if normal_dict.get(f_) == r_)
wrong = [(f_, normal_dict.get(f_, ""), r_) for f_, r_ in PAIRS if normal_dict.get(f_) != r_]
print(f"  混淆字符还原率: {hit}/{len(PAIRS)}  ({hit/len(PAIRS)*100:.1f}%)")
if wrong:
    print("  错例(前8):", wrong[:8])

chit = sum(1 for c in controls if normal_dict.get(c) == c)
print(f"  正常字符准确率: {chit}/{len(controls)}  ({chit/len(controls)*100:.1f}%)")
print(f"  映射表条目数: {len(normal_dict)}")

print()
print("=" * 70)
print("C. decode_encrypted_spans 端到端（span 包裹）")
print("=" * 70)
inner = "".join(f_ for f_, _ in PAIRS)
expect = "".join(r_ for _, r_ in PAIRS)
html = f'<p>题干</p><span class="xuetangx-com-encrypted-font">{inner}</span><p>尾注</p>'
dec = decode_encrypted_spans(html, normal_dict)
# 注意：仓库的 decode_encrypted_spans 会把整个 <span>...</span> 连标签一起替换掉
print(f"  期望: <p>题干</p>{expect[:30]}...<p>尾注</p>")
print(f"  实得: {dec[:60]}...")
print(f"  完全一致: {dec == f'<p>题干</p>{expect}<p>尾注</p>'}")
print(f"  span 标签是否被一并去掉: {'xuetangx-com-encrypted-font' not in dec}")

print()
print("=" * 70)
print("D. 正则健壮性：真实页面 span 写法可能不同")
print("=" * 70)
one = PAIRS[0][0]
one_real = PAIRS[0][1]
variants = [
    ('标准写法', f'<span class="xuetangx-com-encrypted-font">{one}</span>'),
    ('多个 class', f'<span class="xuetangx-com-encrypted-font foo">{one}</span>'),
    ('class 在前有 style', f'<span style="color:red" class="xuetangx-com-encrypted-font">{one}</span>'),
    ('单引号', f"<span class='xuetangx-com-encrypted-font'>{one}</span>"),
    ('属性间有换行', f'<span\n  class="xuetangx-com-encrypted-font"\n>{one}</span>'),
    ('> 前有空格', f'<span class="xuetangx-com-encrypted-font" >{one}</span>'),
    ('大写 class', f'<span CLASS="xuetangx-com-encrypted-font">{one}</span>'),
]
for name, frag in variants:
    out = decode_encrypted_spans(frag, normal_dict)
    ok = one_real in out
    print(f"  [{'OK ' if ok else 'MISS'}] {name:22} -> {out}")

print()
print("=" * 70)
print("E. WOFF / WOFF2 解析能力")
print("=" * 70)
try:
    import brotli  # noqa: F401
    print("  brotli: 已安装")
except ImportError:
    print("  brotli: 未安装  <-- requirements.txt 里确实没有这一条")

f2 = TTFont(OBF)
f2.flavor = "woff"
woff_path = os.path.join(WORK, "obf.woff")
f2.save(woff_path)
try:
    with open(woff_path, "rb") as fh:
        woff = TTFont(fh)
    print(f"  WOFF  : 解析成功，cmap 字符数 {len(woff.getBestCmap())}")
except Exception as e:
    print(f"  WOFF  : 解析失败 -> {type(e).__name__}: {e}")

f3 = TTFont(OBF)
f3.flavor = "woff2"
woff2_path = os.path.join(WORK, "obf.woff2")
try:
    f3.save(woff2_path)
    with open(woff2_path, "rb") as fh:
        woff2 = TTFont(fh)
    print(f"  WOFF2 : 解析成功，cmap 字符数 {len(woff2.getBestCmap())}")
except Exception as e:
    print(f"  WOFF2 : 失败 -> {type(e).__name__}: {e}")

print()
print("=" * 70)
print("F. 渲染参数对比：能不能把 93% 再拉高")
print("=" * 70)
import ddddocr  # noqa: E402


def build_map_variant(char_list, font_path, canvas, ratio, mode, fmt, pad_ratio=0.5):
    """和仓库 font_to_img_ddddocr 同思路，但渲染参数可调。"""
    ocr = ddddocr.DdddOcr(show_ad=False)
    out = {}
    bg = 255 if mode == "L" else 1
    for ch in char_list:
        img = Image.new(mode, (canvas, canvas), bg)
        draw = ImageDraw.Draw(img)
        f = ImageFont.truetype(font_path, int(canvas * ratio))
        bbox = draw.textbbox((0, 0), ch, font=f)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text(
            ((canvas - w) // 2 - bbox[0], (canvas - h) // 2 - bbox[1]),
            ch, font=f, fill=0,
        )
        import io
        buf = io.BytesIO()
        img.save(buf, format=fmt)
        res = ocr.classification(buf.getvalue())
        if res:
            out[ch] = res
    return out


fake_chars = [f_ for f_, _ in PAIRS]
truth = {f_: r_ for f_, r_ in PAIRS}
variants = [
    ("仓库默认 1024px/0.7/1bit/JPEG", 1024, 0.7, "1", "JPEG"),
    ("512px/0.7/1bit/JPEG", 512, 0.7, "1", "JPEG"),
    ("256px/0.7/gray/PNG", 256, 0.7, "L", "PNG"),
    ("128px/0.8/gray/PNG", 128, 0.8, "L", "PNG"),
    ("64px/0.85/gray/PNG", 64, 0.85, "L", "PNG"),
]
for name, canvas, ratio, mode, fmt in variants:
    t = time.time()
    m = build_map_variant(fake_chars, OBF, canvas, ratio, mode, fmt)
    acc = sum(1 for c in fake_chars if m.get(c) == truth.get(c))
    print(f"  {name:32} 准确率 {acc:3d}/{len(fake_chars)}  ({acc/len(fake_chars)*100:5.1f}%)  用时 {time.time()-t:.1f}s")

print()
print("=" * 70)
print("G. 建表耗时外推（首次用某字体要跑多久）")
print("=" * 70)
per = dt / len(chars)
for n, label in [(100, "小型混淆字体（只含本题用字）"), (3000, "中型"), (20000, "完整中文字体（如 simhei）")]:
    print(f"  {n:>6} 字 : 约 {per*n/60:.1f} 分钟   <- {label}")
print(f"  （之后会缓存成 font_cache/*.json，只跑一次）")

print()
print("=" * 70)
print("H. 单字准确率 -> 整题可靠性的放大效应")
print("=" * 70)
acc_rate = hit / len(PAIRS)
print(f"  单字准确率 {acc_rate:.3f}，那么一道含 N 个字的题目，至少有一个字被认错的概率：")
for n in [20, 50, 100, 200]:
    p = 1 - acc_rate ** n
    print(f"    {n:>4} 字的题目 : {p*100:6.2f}%")
print("  => OCR 解码结果不能当唯一事实，必须用截图/多模态模型交叉核对")
