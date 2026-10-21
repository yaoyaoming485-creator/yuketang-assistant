"""
通用雨课堂加密字体解码器
------------------------
原理：加密字体是"思源黑体"的乱序子集 —— cmap[假码位] = 真字符的字形。
还原办法：
  1) 用 original_glyph_to_uni.json（思源黑体全量"字形轮廓哈希 -> 真 Unicode"表）
  2) 对加密字体每个 (假码位 -> 字形) 计算同样的轮廓哈希
  3) 哈希相同 => 字形相同 => 假码位 对应 真 Unicode
用法：
  python decode-with-font.py <font.ttf>            # 解码 shots/*.html 并打印
  python decode-with-font.py <font.ttf> --map out.json
"""
import sys, os, json, glob, hashlib, re
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass
from fontTools.ttLib import TTFont

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


def build_mapping(font_path, orig_map):
    font = TTFont(font_path)
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    m = {}
    unmatched = []
    for uni, gname in cmap.items():
        g = gs.get(gname)
        if not g or not hasattr(g, 'draw'):
            continue
        h = glyph_hash(g)
        true = orig_map.get(h)
        if true is None:
            unmatched.append(uni)
        else:
            m[chr(uni)] = chr(true)
    return m, unmatched, len(cmap)


def load_orig_map():
    with open(ORIG_MAP, 'r', encoding='utf-8') as f:
        return json.load(f)


SPAN_RE = re.compile(r'<span class="xuetangx-com-encrypted-font">(.*?)</span>', re.S)


def decode_html(html, mapping):
    def repl(m):
        inner = m.group(1)
        return ''.join(mapping.get(ch, ch) for ch in inner)
    return SPAN_RE.sub(repl, html)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    font_path = sys.argv[1]
    print('== 字体:', font_path)
    orig = load_orig_map()
    print('   思源黑体哈希表条目:', len(orig))
    mapping, unmatched, ncmap = build_mapping(font_path, orig)
    print('   字体 cmap 码位数:', ncmap, ' 成功还原:', len(mapping), ' 未匹配:', len(unmatched))
    if unmatched[:5]:
        print('   未匹配样例(unicode):', [hex(u) for u in unmatched[:5]])

    if '--map' in sys.argv:
        out = sys.argv[sys.argv.index('--map') + 1]
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(mapping, f, ensure_ascii=False, indent=1)
        print('   映射表已写出:', out, len(mapping), '条')

    # 解码 shots 下所有 html
    for hp in sorted(glob.glob(os.path.join(LAB, 'shots', '*.html'))):
        html = open(hp, encoding='utf-8', errors='replace').read()
        out = decode_html(html, mapping)
        base = os.path.basename(hp)
        outp = os.path.join(LAB, 'shots', base.replace('.html', '.decoded.html'))
        with open(outp, 'w', encoding='utf-8') as f:
            f.write(out)
        txt = re.sub(r'<[^>]+>', ' ', out)
        txt = re.sub(r'\s+', ' ', txt).strip()
        print(f'\n--- {base} -> {os.path.basename(outp)}')
        print('   ', txt[:400])


if __name__ == '__main__':
    main()
