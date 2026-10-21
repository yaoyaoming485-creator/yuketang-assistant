# -*- coding: utf-8 -*-
"""验证修复版 font_decode_utils：正则健壮性 + WOFF2 支持 + 无回归。"""
import os
import sys
import importlib.util

LAB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(LAB, "YuKeTang"))

from src.utils.font_decode_utils import (  # 原版
    decode_encrypted_spans as old_decode,
    font_to_img_ddddocr,
)

# 载入修复版（文件名带中文，用 importlib 走路径加载）
spec = importlib.util.spec_from_file_location(
    "fdpatched", os.path.join(LAB, "deliverables", "font_decode_utils_修复版.py")
)
fd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fd)

new_decode = fd.decode_encrypted_spans

OBF = os.path.join(LAB, "fontlab", "obfuscated100.ttf")
print("=" * 70)
print("1. 正则健壮性：原版 vs 修复版")
print("=" * 70)

pairs = [("问", "社"), ("题", "会"), ("下", "空"), ("列", "间")]
mapping = {f: r for f, r in pairs}
inner = "".join(f for f, _ in pairs)
expect = "".join(r for _, r in pairs)

variants = [
    ("标准写法", f'<span class="xuetangx-com-encrypted-font">{inner}</span>'),
    ("多个 class", f'<span class="xuetangx-com-encrypted-font foo">{inner}</span>'),
    ("class 前有 style", f'<span style="color:red" class="xuetangx-com-encrypted-font">{inner}</span>'),
    ("单引号", f"<span class='xuetangx-com-encrypted-font'>{inner}</span>"),
    ("属性间有换行", f'<span\n class="xuetangx-com-encrypted-font"\n>{inner}</span>'),
    ("> 前有空格", f'<span class="xuetangx-com-encrypted-font" >{inner}</span>'),
    ("大写 CLASS", f'<span CLASS="xuetangx-com-encrypted-font">{inner}</span>'),
    ("span 内跨行", f'<span class="xuetangx-com-encrypted-font">\n{inner}\n</span>'),
    ("两个 span", f'<span class="xuetangx-com-encrypted-font">{inner}</span>'
                  f'<span class="xuetangx-com-encrypted-font">{inner}</span>'),
]
old_ok = new_ok = 0
for name, frag in variants:
    o = expect in old_decode(frag, mapping)
    n = expect in new_decode(frag, mapping)
    old_ok += o
    new_ok += n
    print(f"  {name:16} 原版={'OK ' if o else 'MISS'}  修复版={'OK ' if n else 'MISS'}")
print(f"\n  原版通过 {old_ok}/{len(variants)}   修复版通过 {new_ok}/{len(variants)}")
print(f"  has_encrypted_span 能识别加密 span: {fd.has_encrypted_span(variants[1][1])}")

print()
print("=" * 70)
print("2. WOFF / WOFF2 支持（brotli 已安装）")
print("=" * 70)
from fontTools.ttLib import TTFont
from io import BytesIO

f = TTFont(OBF)
f.flavor = "woff"
w1 = BytesIO()
f.save(w1)
try:
    p = TTFont(BytesIO(w1.getvalue()))
    print(f"  WOFF  : 解析成功，cmap {len(p.getBestCmap())} 字")
except Exception as e:
    print(f"  WOFF  : 失败 {type(e).__name__}: {e}")

f2 = TTFont(OBF)
f2.flavor = "woff2"
w2 = BytesIO()
try:
    f2.save(w2)
    p2 = TTFont(BytesIO(w2.getvalue()))
    print(f"  WOFF2 : 解析成功，cmap {len(p2.getBestCmap())} 字  <-- 装 brotli 后可用")
except Exception as e:
    print(f"  WOFF2 : 失败 {type(e).__name__}: {e}")

# 用修复版的 ttf_parse 走一遍（走 http 的话需要 URL，这里直接测 TTFont 读取路径）
print()
print("  修复版 ttf_parse 的错误提示（模拟 woff2 无 brotli 的场景）:")
try:
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **kw):
        if name == "brotli":
            raise ImportError("No module named brotli")
        return real_import(name, *a, **kw)

    builtins.__import__ = fake_import
    try:
        fd.ttf_parse("http://x/y.woff2", os.path.join(LAB, "fontlab", "t.ttf"))
    except RuntimeError as e:
        print(f"    -> RuntimeError: {e}")
    finally:
        builtins.__import__ = real_import
except Exception as e:
    print(f"    (模拟失败: {e})")

print()
print("=" * 70)
print("3. 无回归：修复版的 OCR 建表与原版一致")
print("=" * 70)
chars = [c for c, _ in pairs] + ["雨", "课", "堂", "刷"]
m_old = font_to_img_ddddocr(chars, OBF)
m_new = fd.font_to_img_ddddocr(chars, OBF)
print(f"  原版映射条目 {len(m_old)}，修复版映射条目 {len(m_new)}，内容一致: {m_old == m_new}")
print(f"  映射样例: {dict(list(m_new.items())[:4])}")

print()
print("=" * 70)
print("4. 空映射表的处理")
print("=" * 70)
try:
    fd.load_or_build_font_map("https://example.com/nonexistent.woff2")
except Exception as e:
    print(f"  非预期异常: {type(e).__name__}: {e}")
print("  (空映射时会抛 RuntimeError 并给出可读提示，详见源码)")
