"""Generate the menu-bar icons (the §14 app mark, inverse) as PNGs — no deps.

The glyph is app/electron/icon/icon.svg inverted: the solid rounded square with
the AW ligature (zigzag + crossbar) knocked out — monochrome, so the normal
state still works as a macOS template image.

Six variants (§13) — the mac pair at 18/36 px, the Windows pair at 16/32 px
(the notification area's 100 %/200 % DPI sizes), the Linux pair at 22/44 px
(the StatusNotifier panel convention):
- trayTemplate.png / @2x — black glyph, alpha only; used as a macOS template image.
- trayAlert.png / @2x — non-template: neutral mid-gray glyph (reads on light and
  dark menu bars) with a red alert dot over the top-right, knocked out of the
  glyph so the dot stays crisp.
- trayWin.png / @2x — non-template: light glyph, same geometry, legible on the
  dark Windows taskbar (the mac black template image disappears there).
- trayWinAlert.png / @2x — the light glyph plus the same red alert dot.
- trayLinux.png / @2x + trayLinuxAlert.png / @2x — the same light-glyph pair for
  Linux panels (colored, never template: StatusNotifier hosts don't recolor).
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

GRAY = (128, 128, 128)
LIGHT = (232, 234, 238)  # Windows taskbar glyph: near-white, reads on dark
RED = (255, 69, 58)  # systemRed-ish

# icon.svg geometry in its 1024-canvas coordinates (SPEC §14).
ZIGZAG = [(240, 690), (350, 360), (460, 690), (570, 360), (680, 690), (790, 360)]
CROSSBAR = [(277, 580), (423, 580)]
STROKE_W = 70.0
SEGMENTS = list(zip(ZIGZAG, ZIGZAG[1:])) + [tuple(CROSSBAR)]
SQ_C, SQ_HALF, SQ_R = 512.0, 412.0, 185.0  # rounded square: 100..924, rx 185


def seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    t = ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)
    t = max(0.0, min(1.0, t))
    qx, qy = ax + t * vx, ay + t * vy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5


def in_square(ux: float, uy: float) -> bool:
    dx = abs(ux - SQ_C) - (SQ_HALF - SQ_R)
    dy = abs(uy - SQ_C) - (SQ_HALF - SQ_R)
    mx, my = max(dx, 0.0), max(dy, 0.0)
    return (mx * mx + my * my) ** 0.5 - SQ_R <= 0


def make(size: int, glyph_rgb: tuple[int, int, int] = (0, 0, 0), dot: bool = False) -> bytes:
    # Fit the rounded square to ~82% of the canvas, centered (distance tests
    # in canvas coords give round caps/joins on the knockout for free).
    scale = (size * 0.82) / (2 * SQ_HALF)
    off_x = off_y = (size - 2 * SQ_HALF * scale) / 2
    # alert dot: top-right corner, in absolute pixel coords
    dot_cx, dot_cy, dot_r = size * 0.76, size * 0.24, size * 0.21
    knockout_r = dot_r + size * 0.07  # gap between glyph and dot

    rows = []
    ss = 3  # supersample
    for y in range(size):
        row = bytearray([0])  # filter byte
        for x in range(size):
            cov = 0
            dot_cov = 0
            for sy in range(ss):
                for sx in range(ss):
                    ax = x + (sx + 0.5) / ss
                    ay = y + (sy + 0.5) / ss
                    ux = (SQ_C - SQ_HALF) + (ax - off_x) / scale
                    uy = (SQ_C - SQ_HALF) + (ay - off_y) / scale
                    glyph_hit = in_square(ux, uy) and not any(
                        seg_dist(ux, uy, *a, *b) <= STROKE_W / 2 for a, b in SEGMENTS
                    )
                    if dot:
                        dd = ((ax - dot_cx) ** 2 + (ay - dot_cy) ** 2) ** 0.5
                        if dd <= dot_r:
                            dot_cov += 1
                            continue
                        if dd <= knockout_r:
                            continue  # knockout gap — neither glyph nor dot
                    if glyph_hit:
                        cov += 1
            n = ss * ss
            ga, da = cov / n, dot_cov / n
            # dot drawn over the (knocked-out) glyph; straight alpha
            out_a = da + ga * (1 - da)
            if out_a == 0:
                row += bytes([0, 0, 0, 0])
            else:
                rgb = tuple(
                    round((RED[i] * da + glyph_rgb[i] * ga * (1 - da)) / out_a) for i in range(3)
                )
                row += bytes([*rgb, round(255 * out_a)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "app/electron")
    (out / "trayTemplate.png").write_bytes(make(18))
    (out / "trayTemplate@2x.png").write_bytes(make(36))
    (out / "trayAlert.png").write_bytes(make(18, glyph_rgb=GRAY, dot=True))
    (out / "trayAlert@2x.png").write_bytes(make(36, glyph_rgb=GRAY, dot=True))
    (out / "trayWin.png").write_bytes(make(16, glyph_rgb=LIGHT))
    (out / "trayWin@2x.png").write_bytes(make(32, glyph_rgb=LIGHT))
    (out / "trayWinAlert.png").write_bytes(make(16, glyph_rgb=LIGHT, dot=True))
    (out / "trayWinAlert@2x.png").write_bytes(make(32, glyph_rgb=LIGHT, dot=True))
    (out / "trayLinux.png").write_bytes(make(22, glyph_rgb=LIGHT))
    (out / "trayLinux@2x.png").write_bytes(make(44, glyph_rgb=LIGHT))
    (out / "trayLinuxAlert.png").write_bytes(make(22, glyph_rgb=LIGHT, dot=True))
    (out / "trayLinuxAlert@2x.png").write_bytes(make(44, glyph_rgb=LIGHT, dot=True))
    print(f"wrote {out}/trayTemplate.png, trayAlert.png, trayWin.png, "
          "trayWinAlert.png, trayLinux.png, trayLinuxAlert.png and @2x variants")
