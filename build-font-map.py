"""
build-font-map.py —— 从雨课堂「混淆字体」构建 假字符 -> 真字符 映射表

原理
----
雨课堂的加密字体是「思源黑体」的乱序子集：cmap[假码位] 指向的其实是**另一个字**的字形。
所以只要把每个字形的轮廓哈希算出来，跟原字体（思源黑体）的哈希表一比，
就知道「这个假码位画出来其实是哪个真字」。

输入：加密字体 .ttf
输出：JSON 映射表 {"假字符": "真字符", ...}（写到 argv[2]）

前置：同目录下 original_glyph_to_uni.json（思源黑体全量 字形哈希 -> 真 Unicode）
"""
import sys, os, json, hashlib
from fontTools.ttLib import TTFont

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

LAB = os.path.dirname(os.path.abspath(__file__))
ORIG_MAP = os.path.join(LAB, 'fontlab', 'ykt_reverse', 'original_glyph_to_uni.json')


class PathCollector:
    def __init__(self):
        self.commands = []

    def moveTo(self, p):
        self.commands.append(('moveTo', p[0], p[1]))

    def lineTo(self, p):
        self.commands.append(('lineTo', p[0], p[1]))

    def curveTo(self, *points):
        self.commands.append(('curveTo', *[tuple(pt) for pt in points]))

    def qCurveTo(self, *points):
        self.commands.append(('qCurveTo', *[tuple(pt) for pt in points]))

    def closePath(self):
        self.commands.append(('closePath',))


def glyph_hash(glyph):
    pc = PathCollector()
    glyph.draw(pc)
    return hashlib.sha1(str(pc.commands).encode('utf-8')).hexdigest()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    font_path = sys.argv[1]
    out_path = sys.argv[2]

    with open(ORIG_MAP, 'r', encoding='utf-8') as f:
        orig = json.load(f)

    font = TTFont(font_path)
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    mapping = {}
    unmatched = 0
    for uni, gname in cmap.items():
        g = gs.get(gname)
        if not g or not hasattr(g, 'draw'):
            continue
        true = orig.get(glyph_hash(g))
        if true is None:
            unmatched += 1
            continue
        mapping[chr(uni)] = chr(true)

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, ensure_ascii=False)

    print('font=%s cmap=%d mapped=%d unmatched=%d -> %s'
          % (os.path.basename(font_path), len(cmap), len(mapping), unmatched, out_path))
    return 0


if __name__ == '__main__':
    sys.exit(main())
