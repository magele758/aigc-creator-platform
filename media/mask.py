"""Rasterize a director's normalized brush strokes or rectangle into a source-sized mask."""

import json
import math
import struct
import sys
import zlib
from pathlib import Path


def normalized(value):
    if type(value) not in (int, float) or not 0 <= value <= 1:
        raise ValueError("选区坐标须在 0 到 1 之间")
    return value


def raster(spec):
    w, h = spec["width"], spec["height"]
    if not all(type(n) is int and n > 0 for n in (w, h)) or w * h > 64_000_000:
        raise ValueError("原图尺寸无效")
    pixels = bytearray(w * h)

    def span(y, left, right):
        a = max(0, math.ceil(left - 0.5))
        b = min(w, math.floor(right - 0.5) + 1)
        if b > a:
            pixels[y*w + a:y*w + b] = b"\xff" * (b - a)

    def disk(x, y, r):
        for row in range(max(0, math.floor(y-r)), min(h, math.ceil(y+r))):
            dy = row + 0.5 - y
            if abs(dy) <= r:
                dx = math.sqrt(max(0, r*r - dy*dy))
                span(row, x-dx, x+dx)

    def segment(a, b, r):
        vx, vy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(vx, vy)
        if not length:
            return
        dx, dy = -vy*r/length, vx*r/length
        corners = [(a[0]+dx, a[1]+dy), (b[0]+dx, b[1]+dy),
                   (b[0]-dx, b[1]-dy), (a[0]-dx, a[1]-dy)]
        for row in range(max(0, math.floor(min(y for _, y in corners))),
                         min(h, math.ceil(max(y for _, y in corners)))):
            y = row + 0.5
            xs = []
            for (x1, y1), (x2, y2) in zip(corners, corners[1:]+corners[:1]):
                if min(y1, y2) <= y < max(y1, y2):
                    xs.append(x1 + (y-y1) * (x2-x1) / (y2-y1))
            if xs:
                span(row, min(xs), max(xs))

    rect = spec.get("rect")
    strokes = spec.get("strokes", [])
    if rect is not None:
        x0, y0, x1, y1 = map(normalized, rect)
        if x0 >= x1 or y0 >= y1:
            raise ValueError("矩形需要左上角和右下角")
        for row in range(math.ceil(y0*h - 0.5), math.ceil(y1*h - 0.5)):
            span(row, x0*w, x1*w)
    if len(strokes) > 64 or sum(len(s["xy"]) for s in strokes) > 512:
        raise ValueError("选区笔画过多")
    for stroke in strokes:
        diameter = normalized(stroke["w"])
        if not diameter or not stroke["xy"]:
            raise ValueError("请输入非空笔画和笔刷宽度")
        radius = max(1, min(w, h)*diameter) / 2
        previous = None
        for x, y in stroke["xy"]:
            point = (normalized(x)*w, normalized(y)*h)
            disk(*point, radius)
            if previous:
                segment(previous, point, radius)
            previous = point
    if not any(pixels):
        raise ValueError("选区没有覆盖任何像素")
    return pixels


def png(spec):
    pixels = raster(spec)
    w, h = spec["width"], spec["height"]

    def chunk(key, data):
        return struct.pack(">I", len(data)) + key + data + struct.pack(">I", zlib.crc32(key + data))

    raw = b"".join(b"\x00" + pixels[i:i+w] for i in range(0, len(pixels), w))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 3)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    try:
        Path(sys.argv[2]).write_bytes(png(json.loads(Path(sys.argv[1]).read_text())))
    except (ValueError, KeyError, TypeError) as exc:
        sys.exit(str(exc))
