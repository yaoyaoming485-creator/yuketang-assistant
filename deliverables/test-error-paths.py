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

# 诊断脚本的输出要在 Windows 控制台上可读：强制 UTF-8，避免系统 ANSI 码页把中文写成 '?'
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# 本文件位于 lab/deliverables/ 下，但依赖的资源和第三方克隆都在 lab 根目录，
# 所以 LAB 必须是「本文件的上一级目录」，否则会拼出 deliverables/deliverables/... 的死路径。
LAB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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

# 产物目录：写进 .test-runtime，不落在仓库工作区（否则每次跑测试都会把
# fontlab/small.ttf 改成新的字节，git 永远是脏的）
ISO = os.path.join(LAB, ".test-runtime", "errorpaths")
os.makedirs(ISO, exist_ok=True)

# 子集字体（避免 28k 字 OCR）
f = TTFont(OBF)
opts = subset.Options()
opts.glyph_names = False
opts.notdef_outline = True
opts.drop_tables += ["DSIG"]
ss = subset.Subsetter(options=opts)
ss.populate(unicodes=[ord(c) for c in CHARS])
ss.subset(f)
small = os.path.join(ISO, "small.ttf")
f.save(small)

f2 = TTFont(small)
f2.flavor = "woff2"
repo_woff2 = os.path.join(LAB, "fontlab", "small.woff2")
woff2_path = os.path.join(ISO, "small.woff2")
if os.path.exists(repo_woff2):
    # 复用已经编好的 woff2（没有 brotli 的环境无法自己编码）
    with open(repo_woff2, "rb") as fh:
        WOFF2_BYTES = fh.read()
    print(f"复用已有 woff2: {repo_woff2} ({len(WOFF2_BYTES)} 字节)")
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
    m = fd.ttf_parse("http://x/y.woff2", os.path.join(ISO, "t1.ttf"))
    print(f"  -> 成功，映射表 {len(m)} 条")
except Exception as e:
    print(f"  -> {type(e).__name__}: {e}")

print()
print("=" * 68)
print("用例 2：ttf_parse 读 woff2（原版，对比）")
print("=" * 68)
sys.path.insert(0, os.path.join(LAB, "YuKeTang"))
# 第三方克隆（Zachary709/YuKeTang）不在本仓库里，缺失时跳过对比用例而不是直接崩
try:
    from src.utils import font_decode_utils as old_mod
    old_ttf_parse = old_mod.ttf_parse
except Exception as e:
    old_mod = None
    old_ttf_parse = None
    print(f"  [跳过] 未找到第三方克隆 YuKeTang/（{e}）")
if old_ttf_parse is not None:
    try:
        m = old_ttf_parse("http://x/y.woff2", os.path.join(ISO, "t2.ttf"))
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
if old_mod is None:
    print("  [跳过] 第三方克隆缺失")
else:
    old_mod.ttf_parse = lambda url, name: {}
    try:
        old_mod.load_or_build_font_map("http://x/nonexistent-font-2.woff2")
        print("  -> 没有抛异常（原版会静默返回空表，交给大模型的就是乱码）")
    except Exception as e:
        print(f"  -> {type(e).__name__}: {e}")

print()
print("验证完毕。")
