# -*- coding: utf-8 -*-
"""统计 shots/*.html 里被加密的字符集合，评估解码工作量。"""
import os
import re
import json
from collections import defaultdict

LAB = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(LAB, 'shots')

SPAN_RE = re.compile(
    r'<span\b[^>]*\bclass\s*=\s*["\'][^"\']*\bxuetangx-com-encrypted-font\b[^"\']*["\'][^>]*>(.*?)</span>',
    re.DOTALL | re.IGNORECASE,
)
TAG_RE = re.compile(r'<[^>]+>')

rows = []
all_chars = {}
for fn in sorted(os.listdir(SHOTS)):
    if not fn.endswith('.html'):
        continue
    with open(os.path.join(SHOTS, fn), 'r', encoding='utf-8') as f:
        html = f.read()
    spans = SPAN_RE.findall(html)
    if not spans:
        rows.append((fn, 0, 0, '(无加密 span)'))
        continue
    chars = []
    seen = set()
    for s in spans:
        for c in TAG_RE.sub('', s):
            if c.strip() and c not in seen:
                seen.add(c)
                chars.append(c)
                all_chars.setdefault(c, 0)
                all_chars[c] += 1
    # 题号
    m = re.search(r'>\s*(\d+)\.\s*(\S+)', html)
    label = (m.group(1) + '.' + m.group(2)) if m else '?'
    rows.append((fn, len(spans), len(chars), label + '  ' + ''.join(chars[:30])))

print('%-26s %6s %6s  %s' % ('html 文件', 'span数', '不同字数', '题号 / 加密字符'))
print('-' * 110)
for fn, ns, nc, label in rows:
    print('%-26s %6d %6d  %s' % (fn, ns, nc, label))

print()
print('全部文件合计不同字符数: %d' % len(all_chars))
print('字符频次 top 30:')
for c, n in sorted(all_chars.items(), key=lambda kv: -kv[1])[:30]:
    print('   %s  x%d' % (c, n))

with open(os.path.join(SHOTS, '_all-encrypted-chars.json'), 'w', encoding='utf-8') as f:
    json.dump(sorted(all_chars.keys()), f, ensure_ascii=False, indent=2)
print()
print('字符清单已写入 shots/_all-encrypted-chars.json')
