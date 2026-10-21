"""下载雨课堂混淆字体逆向所需的「思源黑体字形哈希表」。

来源：https://github.com/qingkong9579/yuketang_reverse
文件：original_glyph_to_uni.json  （约 2.3MB，44,260 条「字形哈希 -> 真 Unicode」）

用法：
    python tools/fetch-original-map.py
    python tools/fetch-original-map.py --dest fontlab/ykt_reverse/original_glyph_to_uni.json

为什么要单独下载而不是直接放进仓库：
    这份表是思源黑体（思源黑体 SIL 许可）的衍生数据，体积也不小；
    仓库只保留生成它的脚本，取用时按需拉取。
"""
import os
import sys
import json
import urllib.request

LAB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DEST = os.path.join(LAB, 'fontlab', 'ykt_reverse', 'original_glyph_to_uni.json')
RAW = 'https://raw.githubusercontent.com/qingkong9579/yuketang_reverse/main/original_glyph_to_uni.json'


def main():
    dest = DEFAULT_DEST
    if '--dest' in sys.argv:
        i = sys.argv.index('--dest')
        if i + 1 < len(sys.argv):
            dest = os.path.abspath(sys.argv[i + 1])
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        print('已存在，跳过：%s' % dest)
        return 0
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print('下载中：%s' % RAW)
    req = urllib.request.Request(RAW, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    with open(dest, 'wb') as f:
        f.write(data)
    try:
        n = len(json.loads(data.decode('utf-8')))
    except Exception:
        n = '?'
    print('已保存：%s（%d bytes，%s 条）' % (dest, len(data), n))
    return 0


if __name__ == '__main__':
    sys.exit(main())
