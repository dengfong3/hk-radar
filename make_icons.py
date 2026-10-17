# -*- coding: utf-8 -*-
"""生成 PWA 图标（192 / 512 PNG）：深色底 + 荧光绿上升折线 + 网格点。"""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))

def make(size: int, path: str) -> None:
    S = size * 4  # 4x 超采样后缩回，边缘更干净
    img = Image.new("RGBA", (S, S), (10, 16, 24, 255))
    d = ImageDraw.Draw(img)
    # 背景圆角
    r = int(S * 0.22)
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bg)
    bd.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(17, 26, 43, 255))
    img = Image.alpha_composite(img, bg)
    d = ImageDraw.Draw(img)
    # 左上/右下微光
    d.ellipse([-S * 0.28, -S * 0.40, S * 0.52, S * 0.28], fill=(20, 40, 66, 90))
    # 网格（3 条水平线）
    for i, y in enumerate((0.66, 0.76, 0.86)):
        yy = int(S * y)
        d.line([(int(S * 0.12), yy), (int(S * 0.88), yy)], fill=(35, 50, 82, 255), width=max(1, S // 220))
    # 上升折线（荧光绿）
    pts = [(0.14, 0.74), (0.30, 0.60), (0.42, 0.66), (0.56, 0.46), (0.68, 0.52), (0.86, 0.28)]
    poly = [(int(S * x), int(S * y)) for x, y in pts]
    d.line(poly, fill=(74, 222, 128, 255), width=int(S * 0.055), joint="curve")
    # 末端箭头
    ex, ey = poly[-1]
    t = int(S * 0.075)
    d.polygon([(ex + t * 0.9, ey - t * 1.05), (ex - t * 0.55, ey - t * 1.0), (ex + t * 0.35, ey + t * 0.2)],
              fill=(74, 222, 128, 255))
    # 起点圆点
    d.ellipse([poly[0][0] - int(S * 0.028), poly[0][1] - int(S * 0.028),
               poly[0][0] + int(S * 0.028), poly[0][1] + int(S * 0.028)], fill=(56, 189, 248, 255))
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)
    print(f"  {os.path.basename(path)}  {size}x{size}  {os.path.getsize(path)} bytes")

make(192, os.path.join(HERE, "icon-192.png"))
make(512, os.path.join(HERE, "icon-512.png"))
