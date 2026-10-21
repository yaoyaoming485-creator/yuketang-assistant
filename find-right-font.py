"""
find-right-font.py
-----------------
从 Edge 缓存里捞到的 9 个雨课堂加密字体 URL 里，找出**用户这份作业**用的字体，
并把所有已采集题面还原成明文。

思路：
  每个 exam_font_*.ttf 对应一份「假字符 -> 真字符」映射（不同字体排列不同）。
  逐个建映射，对已抓到的 shots/*.html 试解；
  用「常用字命中率」给每个字体打分，分数最高的即为用户所用字体。
"""
import sys, os, json, glob, hashlib, re, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from fontTools.ttLib import TTFont

LAB = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(LAB, 'fonts')
ORIG_MAP = os.path.join(LAB, 'fontlab', 'ykt_reverse', 'original_glyph_to_uni.json')
BASE = 'https://fe-static-yuketang.yuketang.cn/fe_font/product/'

HASHES = [
    '78fcc97dd91d4e0ab3e6084d162ee0f0',
    'b0ff80437f6f4c24bf9b940e1e33c89e',
    '2353b9e99dd84b4d984111d9ca2bdfa1',
    '7d43c8c57d5347aa93301a4b28161bbe',
    '4bdf2fbaceee4b098e767a8149a1b21b',
    '03ff4c23a84f4f5ab97b7ce858b8756e',
    '75f40cd3f2514aae89c62ff49d571f02',
    '9e8180041a384270bb2b2dd5deb08b89',
    '72452e4a912d44b095d30daa125d0a44',
]

# 常用汉字（用于打分：解出来的字越常见越像真的）
COMMON = set(
    '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感见明问力理尔点文几定本公特做内孩相因果往将还分真些至其便种再书最真些'
)

class PathCollector:
    def __init__(self): self.commands = []
    def moveTo(self, p): self.commands.append(('moveTo', p[0], p[1]))
    def lineTo(self, p): self.commands.append(('lineTo', p[0], p[1]))
    def curveTo(self, *points): self.commands.append(('curveTo', *[tuple(pt) for pt in points]))
    def qCurveTo(self, *points): self.commands.append(('qCurveTo', *[tuple(pt) for pt in points]))
    def closePath(self): self.commands.append(('closePath',))


def glyph_hash(glyph):
    pc = PathCollector(); glyph.draw(pc)
    return hashlib.sha1(str(pc.commands).encode('utf-8')).hexdigest()


def ensure_font(h):
    os.makedirs(FONT_DIR, exist_ok=True)
    dest = os.path.join(FONT_DIR, 'exam_font_%s.ttf' % h)
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return dest
    url = BASE + 'exam_font_%s.ttf' % h
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136.0.0.0 Safari/537.36',
        'Referer': 'https://www.yuketang.cn/',
    })
    with urllib.request.urlopen(req, timeout=40) as r:
        data = r.read()
    with open(dest, 'wb') as f:
        f.write(data)
    print('  下载 %s (%d bytes)' % (os.path.basename(dest), len(data)))
    return dest


def build_map(font_path, orig):
    font = TTFont(font_path)
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    m = {}
    for uni, gname in cmap.items():
        g = gs.get(gname)
        if not g or not hasattr(g, 'draw'):
            continue
        t = orig.get(glyph_hash(g))
        if t is not None:
            m[chr(uni)] = chr(t)
    return m


SPAN_RE = re.compile(r'<span[^>]*class="[^"]*xuetangx-com-encrypted-font[^"]*"[^>]*>(.*?)</span>', re.S)


def decode_html(html, m):
    def rep(mm):
        inner = mm.group(1)
        return re.sub(r'[^<>]+', lambda t: ''.join(m.get(c, c) for c in t.group(0)), inner)
    return SPAN_RE.sub(rep, html)


def to_text(html):
    t = re.sub(r'<[^>]+>', ' ', html)
    return re.sub(r'\s+', ' ', t).strip()


def score(text):
    chars = [c for c in text if '\u4e00' <= c <= '\u9fff']
    if not chars:
        return 0.0
    return sum(1 for c in chars if c in COMMON) / len(chars)


def main():
    with open(ORIG_MAP, 'r', encoding='utf-8') as f:
        orig = json.load(f)
    shots = sorted(p for p in glob.glob(os.path.join(LAB, 'shots', '*.html')) if '.decoded' not in p)
    results = []
    for h in HASHES:
        try:
            fp = ensure_font(h)
        except Exception as e:
            print('  下载失败 %s: %s' % (h, e)); continue
        try:
            m = build_map(fp, orig)
        except Exception as e:
            print('  建表失败 %s: %s' % (h, e)); continue
        total, cnt = 0.0, 0
        samples = []
        for sp in shots:
            html = open(sp, encoding='utf-8', errors='replace').read()
            dec = decode_html(html, m)
            txt = to_text(dec)
            s = score(txt)
            total += s; cnt += 1
            samples.append((os.path.basename(sp), s, txt[:120]))
        avg = total / max(cnt, 1)
        results.append((avg, h, len(m), samples))
        print('字体 %s  映射=%d  常用字命中率=%.3f' % (h[:12], len(m), avg))

    results.sort(reverse=True)
    print('\n===== 最佳匹配 =====')
    for avg, h, n, samples in results[:3]:
        print('\n--- %s  score=%.3f  映射=%d' % (h, avg, n))
        for name, s, txt in samples:
            print('   [%s %.2f] %s' % (name, s, txt))

    if results:
        best = results[0][1]
        print('\n>>> 用户字体 = exam_font_%s.ttf' % best)
        with open(os.path.join(FONT_DIR, 'best_font.txt'), 'w', encoding='utf-8') as f:
            f.write(best)


if __name__ == '__main__':
    main()
