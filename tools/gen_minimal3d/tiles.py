"""Terrain tile helpers: flat blocky 24 x 24 tiles (no dither, no outlines) and strips of them."""
import core

TILE = 24


class Rng:
    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF or 1

    def next(self):
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0

    def int(self, lo, hi):
        return lo + int(self.next() * (hi - lo + 1))


class Tile:
    """A square RGBA tile. `fill` paints it; `block` paints a rectangle clipped to the tile."""

    def __init__(self, c=None, size=TILE):
        self.size = size
        self.px = bytearray(size * size * 4)
        if c:
            self.block(0, 0, size, size, c)

    def block(self, x, y, w, h, c, a=255):
        rgb = core.hex_rgb(core.P.get(c, c)) if isinstance(c, str) else c
        for yy in range(max(0, y), min(self.size, y + h)):
            for xx in range(max(0, x), min(self.size, x + w)):
                o = (yy * self.size + xx) * 4
                self.px[o:o + 4] = bytes(rgb + (a,))

    def bytes(self):
        return bytes(self.px)


def strip(tiles):
    """A row of tiles -> (width, height, rgba)."""
    n = len(tiles)
    s = tiles[0].size
    out = bytearray(n * s * s * 4)
    for k, t in enumerate(tiles):
        for y in range(s):
            out[(y * n * s + k * s) * 4:(y * n * s + (k + 1) * s) * 4] = t.px[y * s * 4:(y + 1) * s * 4]
    return n * s, s, bytes(out)


def grid(rows):
    """Rows of tiles (variants down, levels across) -> (width, height, rgba)."""
    s = rows[0][0].size
    cols = len(rows[0])
    w, h = cols * s, len(rows) * s
    out = bytearray(w * h * 4)
    for r, row in enumerate(rows):
        for k, t in enumerate(row):
            for y in range(s):
                o = ((r * s + y) * w + k * s) * 4
                out[o:o + s * 4] = t.px[y * s * 4:(y + 1) * s * 4]
    return w, h, bytes(out)
