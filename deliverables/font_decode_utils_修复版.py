"""
字体混淆解码相关工具函数 —— 修复版（基于 YuKeTang/src/utils/font_decode_utils.py）

在原版基础上修了三个实测出来的问题：

1) 【正则太脆】原版正则只认这一种写法：
       <span class="xuetangx-com-encrypted-font">...</span>
   实测以下写法全部匹配失败（结果是题干不解密 -> 交给大模型的是乱码 -> 静默答错）：
       <span class="xuetangx-com-encrypted-font foo">      多个 class
       <span style="color:red" class="...">                class 前面有别的属性
       <span class='...'>                                  单引号
       <span CLASS="...">                                  大写
   改成：属性顺序无关、class 名子串匹配、引号类型任意、大小写不敏感、内容可跨行。

2) 【WOFF2 解析不了】原版 requirements.txt 里没有 brotli，但 load_or_build_font_map()
   明确会缓存 .woff2。实测：TTFont() 读 woff2 直接 ImportError: No module named brotli。
   现在会捕获并给出可读的提示（装上 brotli 即可）。

3) 【映射表为空时静默继续】原来 font_to_img_ddddocr() 在 ddddocr 没装时直接返回 {}，
   后面解码就变成「原样返回乱码」，看不出任何异常。现在会打印警告。

用法：直接把这个文件放到 src/utils/font_decode_utils.py 覆盖原文件即可，
      或者改名为 font_decode_utils_patched.py 后调整 exercise_solver.py 的 import。
      函数名和签名与原版完全一致，其余代码不用动。
"""
import re
from io import BytesIO
import os
import json
import logging
from typing import Dict, List, Optional

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)

# 修复点 1：宽松匹配加密 span
#   - <span\b[^>]*  : 允许 class 前有别的属性（style / data-* 等）
#   - class\s*=\s*["'] ... ["'] : 引号类型任意
#   - \bxuetangx-com-encrypted-font\b : class 列表里含这个名即可
#   - re.IGNORECASE : 容忍 CLASS / Encrypted-Font
#   - re.DOTALL : span 内容可跨行
_ENCRYPTED_SPAN_PATTERN = re.compile(
    r'<span\b[^>]*\bclass\s*=\s*["\'][^"\']*\bxuetangx-com-encrypted-font\b[^"\']*["\'][^>]*>'
    r'(.*?)'
    r'</span>',
    re.DOTALL | re.IGNORECASE,
)


def decode_encrypted_spans(html_text: str, char_map: Optional[Dict[str, str]] = None) -> str:
    """
    解码类似：
    <span class="xuetangx-com-encrypted-font">社会</span>空间经济...
    中 span 包裹部分的文本，并用 char_map 做字符映射。

    注意：整个 <span>...</span> 会被替换成解码后的纯文本（与原版行为一致）。
    """
    if char_map is None:
        char_map = {}
    if not html_text:
        return html_text

    def _decode_inner(m):
        raw = m.group(1)
        res = ''
        for c in raw:
            res += char_map.get(c, c)
        return res

    return _ENCRYPTED_SPAN_PATTERN.sub(_decode_inner, html_text)


def has_encrypted_span(html_text: str) -> bool:
    """页面是否含加密 span —— 用来判断映射表有没有建成功。"""
    if not html_text:
        return False
    return bool(_ENCRYPTED_SPAN_PATTERN.search(html_text))


def strip_html_tags(html: str) -> str:
    """移除 HTML 标签，只保留文本内容。"""
    html = re.sub(r"</p\s*>", "\n", html, flags=re.IGNORECASE)
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"<.*?>", "", html)
    return text.strip()


def font_to_img_ddddocr(code_list: List[str], filename: str) -> Dict[str, str]:
    """
    使用 ddddocr 识别字体中的字符映射。
    """
    try:
        import ddddocr
    except ImportError:
        # 修复点 3：原来这里静默返回空字典，外层无从判断失败
        logger.warning(
            "ddddocr 未安装，无法解析字体混淆；请执行 pip install ddddocr。"
            "若题目文本里仍有乱码，就是这个原因。"
        )
        return {}
    if not code_list:
        return {}
    normal_dict = {}
    ocr = ddddocr.DdddOcr(show_ad=False)
    for char_code in code_list:
        real_char = char_code.encode('utf-8').decode('utf-8')
        img_size = 1024
        img = Image.new('1', (img_size, img_size), 255)
        draw = ImageDraw.Draw(img)
        font = ImageFont.truetype(filename, int(img_size * 0.7))
        bbox = draw.textbbox((0, 0), real_char, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        draw.text(
            ((img_size - text_width) // 2, (img_size - text_height) // 2),
            real_char,
            font=font,
            fill=0,
        )
        img_byte_arr = BytesIO()
        img.save(img_byte_arr, format='JPEG')
        img_bytes = img_byte_arr.getvalue()
        res = ocr.classification(img_bytes)
        if res:
            normal_dict[real_char] = res
    return normal_dict


def ttf_parse(url: str, ttf_name: str) -> Dict[str, str]:
    """
    根据 URL 获取字体文件并解析字符映射。
    """
    import requests
    response = requests.get(url, proxies={"http": None, "https": None})
    response.raise_for_status()
    try:
        font_parse = TTFont(BytesIO(response.content))
    except ImportError as exc:
        # 修复点 2：woff2 需要 brotli，没装会抛这个
        raise RuntimeError(
            "解析字体失败：WOFF2 需要 brotli 支持，请执行 pip install brotli"
        ) from exc
    font_parse.save(ttf_name)
    m_dict = font_parse.getBestCmap()
    unicode_list = list(m_dict.keys())
    char_list = [chr(ch_unicode) for ch_unicode in unicode_list]
    normal_dict = font_to_img_ddddocr(char_list, ttf_name)
    if os.path.exists(ttf_name):
        os.remove(ttf_name)
    return normal_dict


def load_or_build_font_map(url: str) -> Dict[str, str]:
    """
    读取/构建字体映射关系：
    - 缓存文件名基于 font URL 生成，确保不同字体使用不同缓存
    - 缓存文件保存在 font_cache 子目录下
    - 若本地已存在 JSON 缓存文件，则直接读取；
    - 否则调用 ttf_parse 重新计算，并写入缓存。
    """
    import hashlib
    cache_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "font_cache")
    if not os.path.exists(cache_dir):
        os.makedirs(cache_dir)
    font_filename = url.split("/")[-1]
    cache_name = font_filename.replace(".ttf", ".json").replace(".woff", ".json").replace(".woff2", ".json")
    if not cache_name.endswith(".json"):
        cache_name = hashlib.md5(url.encode()).hexdigest() + ".json"
    cache_path = os.path.join(cache_dir, cache_name)
    ttf_name = os.path.join(cache_dir, "temp_font.ttf")
    if os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "normal_dict" in data:
            return data["normal_dict"]
        return data
    normal_dict = ttf_parse(url, ttf_name)
    if not normal_dict:
        raise RuntimeError(
            f"字体映射表为空（url={url}），可能是 ddddocr 未安装或字体格式不支持；"
            "本题将无法自动解密，请改用截图交给多模态模型。"
        )
    cache_data = {"normal_dict": normal_dict, "font_url": url}
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache_data, f, ensure_ascii=False, indent=2)
    return normal_dict
