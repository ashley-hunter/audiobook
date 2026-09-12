#!/usr/bin/env python3
"""Generate the app icon set (navy sky, cream crescent, a few stars).

Pure stdlib: a minimal PNG encoder plus 3x supersampled drawing, so the repo
needs no image tooling. Re-run after changing the artwork:  python3 scripts/make-icons.py
"""
import math
import os
import struct
import zlib

SS = 3  # supersample factor
SIZES = [120, 152, 167, 180, 192, 512]
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "icons")

SKY_TOP = (10, 15, 42)
SKY_BOTTOM = (43, 36, 80)
MOON = (242, 201, 124)
MOON_LIT = (255, 243, 214)
STAR = (244, 241, 234)

# star positions as fractions of the icon, with radius fractions
STARS = [
    (0.20, 0.22, 0.020), (0.33, 0.40, 0.013), (0.17, 0.56, 0.016),
    (0.28, 0.74, 0.012), (0.46, 0.84, 0.017), (0.66, 0.22, 0.012),
    (0.78, 0.70, 0.015), (0.44, 0.15, 0.011),
]


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def draw(size):
    n = size * SS
    px = bytearray(n * n * 3)

    # sky: vertical gradient
    for y in range(n):
        col = lerp(SKY_TOP, SKY_BOTTOM, y / max(1, n - 1))
        row = bytes(col) * n
        px[y * n * 3:(y + 1) * n * 3] = row

    def blend(x, y, col, alpha):
        if alpha <= 0 or x < 0 or y < 0 or x >= n or y >= n:
            return
        i = (y * n + x) * 3
        for k in range(3):
            px[i + k] = int(round(px[i + k] * (1 - alpha) + col[k] * alpha))

    # stars
    for fx, fy, fr in STARS:
        cx, cy, r = fx * n, fy * n, fr * n
        for y in range(int(cy - r - 2), int(cy + r + 3)):
            for x in range(int(cx - r - 2), int(cx + r + 3)):
                d = math.hypot(x - cx, y - cy)
                if d <= r:
                    blend(x, y, STAR, 0.85 * (1 - (d / r) ** 2) + 0.15)

    # crescent: big disc minus an offset disc
    cx, cy, r = n * 0.58, n * 0.47, n * 0.30
    ox, oy, orad = n * 0.70, n * 0.37, n * 0.28
    for y in range(int(cy - r - 2), int(cy + r + 3)):
        for x in range(int(cx - r - 2), int(cx + r + 3)):
            if math.hypot(x - cx, y - cy) > r:
                continue
            if math.hypot(x - ox, y - oy) <= orad:
                continue
            t = max(0.0, min(1.0, (math.hypot(x - cx, y - cy) / r)))
            blend(x, y, lerp(MOON_LIT, MOON, t), 1.0)

    # box-downsample back to the target size
    out = bytearray(size * size * 3)
    area = SS * SS
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0]
            for sy in range(SS):
                base = ((y * SS + sy) * n + x * SS) * 3
                for sx in range(SS):
                    i = base + sx * 3
                    acc[0] += px[i]
                    acc[1] += px[i + 1]
                    acc[2] += px[i + 2]
            o = (y * size + x) * 3
            out[o] = acc[0] // area
            out[o + 1] = acc[1] // area
            out[o + 2] = acc[2] // area
    return bytes(out)


def write_png(path, size, rgb):
    raw = b"".join(b"\x00" + rgb[y * size * 3:(y + 1) * size * 3] for y in range(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        write_png(os.path.join(OUT, "icon-%d.png" % size), size, draw(size))
        print("icon-%d.png" % size)


if __name__ == "__main__":
    main()
