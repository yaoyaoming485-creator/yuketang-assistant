# -*- coding: utf-8 -*-
"""
错误路径验证（自适应）：同一个脚本在两个 venv 里跑
  - 装了 brotli 的 venv  -> 期望 woff2 解析成功
  - 没装 brotli 的 venv  -> 期望修复版给可读 RuntimeError，原版给裸 ImportError

不依赖外网：mock 掉 requests.get。
"""
import builtins
import importlib.util
import os
import sys

LAB = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "fdpatched", os.path.join(LAB, "deliverables", "font_decode_utils_修复版.py")
)
fd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fd)

from fontTools.ttLib import TTFont
from fontTools import subset
from io import BytesIO

try:
    import brotli  # noqa: F401
    HAS_BROTLI = True
except ImportError:
    HAS_BROTLI = False

print(f"环境: brotli {'已安装' if HAS_BROTLI else '未安装'}  python={sys.executable}")

OBF = os.path.join(LAB, "fontlab", "obfuscated100.ttf")
CHARS = "问选题下列正确答社会空间经济"

# 子集字体（避免 28k 字 OCR）
f = TTFont(OBF)
opts = subset.Options()
opts.glyph_names = False
opts.notdef_outline = True
opts.drop_tables += ["DSIG"]
ss = subset.Subsetter(options=opts)
ss.populate(unicodes=[ord(c) for c in CHARS])
ss.subset(f)
small = os.path.join(LAB, "fontlab", "small.ttf")
f.save(small)

f2 = TTFont(small)
f2.flavor = "woff2"
woff2_path = os.path.join(LAB, "fontlab", "small.woff2")
if os.path.exists(woff2_path):
    # 复用已经编好的 woff2（没有 brotli 的环境无法自己编码）
    with open(woff2_path, "rb") as fh:
        WOFF2_BYTES = fh.read()
    print(f"复用已有 woff2: {woff2_path} ({len(WOFF2_BYTES)} 字节)")
else:
    buf = BytesIO()
    f2.save(buf)
    WOFF2_BYTES = buf.getvalue()
    with open(woff2_path, "wb") as fh:
        fh.write(WOFF2_BYTES)
    print(f"新生成 woff2: {woff2_path} ({len(WOFF2_BYTES)} 字节)")


class FakeResponse:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        pass


import requests
requests.get = lambda url, **kw: FakeResponse(WOFF2_BYTES)

print()
print("=" * 68)
print("用例 1：ttf_parse 读 woff2（修复版）")
print("=" * 68)
try:
    m = fd.ttf_parse("http://x/y.woff2", os.path.join(LAB, "fontlab", "t1.ttf"))
    print(f"  -> 成功，映射表 {len(m)} 条")
except Exception as e:
    print(f"  -> {type(e).__name__}: {e}")

print()
print("=" * 68)
print("用例 2：ttf_parse 读 woff2（原版，对比）")
print("=" * 68)
sys.path.insert(0, os.path.join(LAB, "YuKeTang"))
from src.utils.font_decode_utils import ttf_parse as old_ttf_parse
try:
    m = old_ttf_parse("http://x/y.woff2", os.path.join(LAB, "fontlab", "t2.ttf"))
    print(f"  -> 成功，映射表 {len(m)} 条")
except Exception as e:
    print(f"  -> {type(e).__name__}: {e}")

print()
print("=" * 68)
print("用例 3：ddddocr 不可用时，load_or_build_font_map 是否给出可读提示")
print("=" * 68)
real_import = builtins.__import__


def fake_import(name, *a, **kw):
    if name == "ddddocr":
        raise ImportError("No module named ddddocr")
    return real_import(name, *a, **kw)


builtins.__import__ = fake_import
try:
    # 直接把 ttf_parse 换成返回空表，模拟「字体解析了但一个字符都没认出来」
    fd.ttf_parse = lambda url, name: {}
    fd.load_or_build_font_map("http://x/nonexistent-font.woff2")
    print("  -> 没有抛异常（不符合预期）")
except RuntimeError as e:
    print(f"  -> RuntimeError: {e}")
except Exception as e:
    print(f"  -> {type(e).__name__}: {e}")
finally:
    builtins.__import__ = real_import

print()
print("=" * 68)
print("用例 4：原版在同样场景下会怎样（对比）")
print("=" * 68)
from src.utils import font_decode_utils as old_mod
old_mod.ttf_parse = lambda url, name: {}
try:
    old_mod.load_or_build_font_map("http://x/nonexistent-font-2.woff2")
    print("  -> 没有抛异常（原版会静默返回空表，交给大模型的就是乱码）")
except Exception as e:
    print(f"  -> {type(e).__name__}: {e}")

print()
print("验证完毕。")
