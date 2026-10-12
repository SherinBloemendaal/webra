#!/usr/bin/env python3
"""Generate apps/game/js/art/pixel-data.js: WebRA's own pixel art.

Some actors have no Red Alert art at all: OpenRA drew theirs itself (its own
files, data/source/bits.txt), and WebRA never ships those (data/CATALOG.md).
For some of them WebRA draws its own pixel art in Red Alert's style instead
of the vector art of apps/game/js/art: 8-bit frames at one pixel per world
pixel, the way Westwood drew its structures (a 3/4 view from the south,
volumes extruded straight up, light from the top left, cast shadows to the
bottom right, dark outlines on the shaded sides), painted here from simple
volumes so the art is reproducible and reviewable as code. Nothing here is
taken from Westwood's or OpenRA's files: the palette and every pixel are
WebRA's own.

The palette follows Red Alert's index conventions (content/palette.js):
index 0 is transparent, index 4 is the shadow (drawn as translucent black),
indices 80 to 95 are the remap range (the owner's colour: the atlas stores
them as grey levels with the team mask set). Every other colour is one of
the ramps below, darkest first.

Output: PIXEL_PALETTE (768 bytes of RGB, base64) and PIXEL_ART[actor id] =
{ width, height, offset: [x, y] (the frame centre relative to the
footprint centre, world pixels), poses: { pose: frame }, frames: [base64 of
width * height palette indices, row by row] }. apps/game/js/art/pixel.js
turns them into atlas slots (body poses idle and damaged) and the editor
and sidebar icons.

Art:
- OILB, the oil derrick (OpenRA civilian.yaml OILB: a 2x2 tech building
  that pays its owner while captured). OpenRA draws it from its own
  oilb.shp: idle (one frame) and damaged-idle (WithSpriteBody), no make,
  bib or death animation. Here: a concrete pad with a drilling tower over
  the wellhead at the back left, the drill floor's machinery house, a large
  storage tank in front (its band shows the owner's colour) and a smaller
  one behind, pipes and oil drums. The damaged frame has a broken tower top,
  scorched concrete, a holed tank and rubble, like Red Alert's damaged
  structures.

Run: python3 tools/gen_pixel_art.py (CI checks the output is up to date).
"""
import base64
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'apps', 'game', 'js', 'art', 'pixel-data.js')

TRANSPARENT = 0
SHADOW = 4
REMAP_START = 80
REMAP_END = 95

# ---- Palette ------------------------------------------------------------------------------

# WebRA's own ramps, darkest first (RGB, 8 bits per channel). Chosen by eye for
# a 1990s VGA look: few shades per material, slightly warm greys.
RAMPS = {
    # Concrete and painted steel.
    'grey': [(18, 18, 20), (38, 38, 40), (58, 57, 58), (78, 77, 76), (98, 97, 94), (120, 118, 114), (142, 140, 134),
             (164, 162, 154), (186, 184, 176), (206, 204, 196), (226, 224, 216), (244, 242, 234)],
    # Girders and machinery: blue-grey steel.
    'steel': [(20, 22, 28), (36, 40, 50), (54, 60, 72), (76, 84, 98), (100, 110, 124), (130, 140, 152), (166, 174, 184)],
    # Rust and oil-stained ground.
    'rust': [(44, 22, 12), (70, 36, 18), (98, 52, 26), (128, 70, 36), (158, 92, 50), (190, 120, 72)],
    # Hazard paint and the warning light.
    'yellow': [(96, 56, 0), (140, 88, 4), (184, 124, 12), (220, 164, 28), (248, 204, 56), (252, 236, 140)],
    # Crude oil.
    'oil': [(8, 6, 4), (22, 16, 10), (40, 30, 20)],
    # Bare earth around the pad.
    'dirt': [(52, 40, 26), (76, 60, 38), (102, 82, 54), (128, 106, 72), (152, 130, 92)],
    # Red oil drums.
    'red': [(60, 10, 8), (100, 20, 14), (142, 34, 22), (184, 56, 36), (220, 92, 60)],
}
# The remap range: a neutral ramp of WebRA's own; the game tints it with the
# owner's colour (content/palette.js paletteLookup).
REMAP = [(int(20 + k * 14.5), int(16 + k * 12.5), int(14 + k * 11.5)) for k in range(16)]


def build_palette():
    pal = [(0, 0, 0)] * 256
    index = {}
    nxt = 16
    for name, ramp in RAMPS.items():
        index[name] = []
        for rgb in ramp:
            if REMAP_START <= nxt <= REMAP_END:
                nxt = REMAP_END + 1
            pal[nxt] = rgb
            index[name].append(nxt)
            nxt += 1
    index['team'] = list(range(REMAP_START, REMAP_END + 1))
    for k, rgb in enumerate(REMAP):
        pal[REMAP_START + k] = rgb
    return pal, index


PALETTE, IDX = build_palette()


def c(ramp, shade):
    """Palette index of `shade` (0 darkest) of a ramp, clamped."""
    r = IDX[ramp]
    return r[max(0, min(len(r) - 1, shade))]


def valid_indices():
    """Every index the art may use: transparent, shadow, the remap range and the ramps."""
    out = {TRANSPARENT, SHADOW}
    for v in IDX.values():
        out.update(v)
    return out


# ---- Canvas -------------------------------------------------------------------------------


class Rng:
    """A small deterministic generator (LCG), so the art never changes between runs."""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF or 1

    def next(self):
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0

    def int(self, lo, hi):
        return lo + int(self.next() * (hi - lo + 1))


class Canvas:
    def __init__(self, w, h):
        self.w = w
        self.h = h
        self.px = [TRANSPARENT] * (w * h)

    def copy(self):
        o = Canvas(self.w, self.h)
        o.px = list(self.px)
        return o

    def get(self, x, y):
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.px[y * self.w + x]
        return TRANSPARENT

    def put(self, x, y, v):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y * self.w + x] = v

    def rect(self, x0, y0, x1, y1, v):
        """Fill the inclusive rectangle."""
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.put(x, y, v)

    def line(self, x0, y0, x1, y1, v):
        """Bresenham line, both ends included."""
        x0, y0, x1, y1 = int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.put(x0, y0, v)
            if x0 == x1 and y0 == y1:
                return
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def shadow(self, x, y):
        """Shadow where nothing solid is drawn yet (the ground or the pad)."""
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            v = self.px[y * self.w + x]
            if v in (TRANSPARENT,) or v in GROUND:
                self.px[y * self.w + x] = SHADOW


# Indices a cast shadow may fall on: the bare earth and the pad's surface.
GROUND = set(IDX['dirt']) | set(IDX['grey'][5:]) | set(IDX['oil'])

# ---- Volumes ------------------------------------------------------------------------------
# Ground coordinates: x to the east, y to the south, one world pixel each; a
# point at height h is drawn h pixels higher (straight up, like Westwood's
# structures). Cast shadows fall down and to the right, SHADOW_X and SHADOW_Y
# pixels per pixel of height.
SHADOW_X = 0.55
SHADOW_Y = 0.35


def shadow_box(cv, x0, y0, x1, y1, h):
    """The cast shadow of a box standing on the ground rectangle (inclusive)."""
    dx, dy = h * SHADOW_X, h * SHADOW_Y
    steps = max(1, int(h))
    for k in range(steps + 1):
        f = k / steps
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                cv.shadow(x + dx * f, y + dy * f)


def shadow_disc(cv, cx, cy, r, h, squash):
    steps = max(1, int(h))
    for k in range(steps + 1):
        f = k / steps
        for y in range(int(cy - r * squash) - 1, int(cy + r * squash) + 2):
            for x in range(int(cx - r) - 1, int(cx + r) + 2):
                if ((x - cx) / r) ** 2 + ((y - cy) / (r * squash)) ** 2 <= 1:
                    cv.shadow(x + h * SHADOW_X * f, y + h * SHADOW_Y * f)


def shadow_line(cv, x0, y0, h0, x1, y1, h1):
    """The shadow of a thin beam from (x0, y0) at height h0 to (x1, y1) at h1."""
    n = int(max(abs(x1 - x0), abs(y1 - y0), abs(h1 - h0))) + 1
    for k in range(n + 1):
        f = k / n
        h = h0 + (h1 - h0) * f
        cv.shadow(x0 + (x1 - x0) * f + h * SHADOW_X, y0 + (y1 - y0) * f + h * SHADOW_Y)


def box(cv, x0, y0, x1, y1, h, ramp, top, front, rng=None, grain=0):
    """A box on the ground rectangle x0..x1, y0..y1 (inclusive), h high:
    its roof (shade `top`) and its south face (shade `front`), lit edges on
    the north and west, dark outline on the east and south."""
    # South face: from the ground line y1 up h pixels.
    for y in range(y1 - h + 1, y1 + 1):
        for x in range(x0, x1 + 1):
            s = front
            if x == x0:
                s = front + 1
            if x == x1 or y == y1:
                s = front - 2
            cv.put(x, y, c(ramp, s))
    # Roof.
    for y in range(y0 - h, y1 - h + 1):
        for x in range(x0, x1 + 1):
            s = top
            if rng and grain and rng.next() < grain:
                s += rng.int(-1, 1)
            if y == y0 - h or x == x0:
                s = top + 1
            if x == x1:
                s = top - 2
            cv.put(x, y, c(ramp, s))
    # The roof's south edge catches the light, the outline below it does not.
    for x in range(x0 + 1, x1):
        cv.put(x, y1 - h, c(ramp, top + 1))
        if h > 1:
            cv.put(x, y1 - h + 1, c(ramp, front - 1))


# Shade of a cylinder's side across its width (u from -1 at the west edge
# to 1 at the east edge), as a fraction of the ramp: light from the top left.
SIDE_PROFILE = [(-0.7, 0.55), (-0.25, 0.68), (0.15, 0.6), (0.45, 0.46), (0.75, 0.33), (0.92, 0.2), (1.01, 0.05)]


def side_shade(u, n):
    for limit, f in SIDE_PROFILE:
        if u < limit:
            return int(round((n - 1) * f))
    return 0


def cylinder(cv, cx, cy, r, h, ramp, squash=0.5, bands=(), seams=(), rng=None):
    """An upright tank standing on the ground disc (cx, cy, r): its side
    lit from the left, its round top. `bands` are (from, to, ramp) heights
    painted around the side (`ramp` 'team': the owner's colour), `seams`
    heights of darker weld lines."""
    ry = r * squash
    n = len(IDX[ramp])
    for x in range(int(cx - r), int(cx + r) + 1):
        u = (x - cx + 0.5) / (r + 0.5)
        if abs(u) > 1:
            continue
        ground = cy + ry * max(0.0, 1 - u * u) ** 0.5
        top = cy - ry * max(0.0, 1 - u * u) ** 0.5 - h
        for y in range(int(round(top)), int(round(ground)) + 1):
            hgt = ground - y
            rp = ramp
            for b0, b1, br in bands:
                if b0 <= hgt < b1:
                    rp = br
            s = side_shade(u, len(IDX[rp]))
            if any(abs(hgt - k) < 0.5 for k in seams):
                s -= 2
            elif rng and rp == ramp and rng.next() < 0.1:
                s += rng.int(-1, 1)
            if y >= round(ground):
                s = 0
            cv.put(x, y, c(rp, s))
    # The top: the brightest face, its rim lit to the north west and in
    # shade to the south east, a hatch near the middle.
    for y in range(int(cy - ry - h) - 1, int(cy + ry - h) + 2):
        for x in range(int(cx - r), int(cx + r) + 1):
            dx, dy = (x - cx + 0.5) / (r + 0.5), (y - (cy - h) + 0.5) / (ry + 0.5)
            d = dx * dx + dy * dy
            if d <= 1:
                s = n - 4
                if d > 0.55:
                    s = n - 3 if dx + dy < -0.3 else (n - 7 if dx + dy > 0.3 else n - 5)
                elif rng and rng.next() < 0.08:
                    s -= 1
                cv.put(x, y, c(ramp, s))
    hx, hy = int(round(cx - r * 0.25)), int(round(cy - h))
    cv.put(hx, hy, c(ramp, n - 1))
    cv.put(hx + 1, hy, c(ramp, n - 6))
    cv.put(hx, hy + 1, c(ramp, n - 6))
    cv.put(hx + 1, hy + 1, c(ramp, n - 8))


def oil_drum(cv, x, y, ramp='red'):
    """A standing drum on the ground point (x, y): 3 wide, 4 high."""
    for k in range(4):
        cv.put(x - 1, y - k, c(ramp, 3))
        cv.put(x, y - k, c(ramp, 2))
        cv.put(x + 1, y - k, c(ramp, 0))
    cv.put(x - 1, y - 4, c(ramp, 4))
    cv.put(x, y - 4, c(ramp, 3))
    cv.put(x - 1, y - 2, c('oil', 2))
    cv.put(x, y - 2, c('oil', 1))
    cv.put(x + 1, y - 2, c('oil', 0))
    cv.shadow(x + 2, y)
    cv.shadow(x + 2, y - 1)
    cv.shadow(x + 3, y + 1)


# ---- The oil derrick ----------------------------------------------------------------------

W = H = 48

# The drilling tower: legs from the corners of its base to the crown.
TOWER_BASE = (4, 22, 23, 36)  # x0, y0, x1, y1 around the legs on the ground
TOWER_TOP = 29  # the crown's height above the ground
CROWN = 2  # half the crown's width
# Tanks: ground centre x, y, radius, height.
BIG_TANK = (35, 37, 7, 12)
SMALL_TANK = (39, 18, 5, 8)
# The pump house: ground rectangle x0, y0, x1, y1 (inclusive) and height.
HOUSE = (24, 17, 31, 24, 6)


def tower_points():
    x0, y0, x1, y1 = TOWER_BASE
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    legs = [(x0 + 2, y0 + 2), (x1 - 2, y0 + 2), (x1 - 2, y1 - 2), (x0 + 2, y1 - 2)]  # NW, NE, SE, SW
    tops = [(cx - CROWN, cy - CROWN), (cx + CROWN, cy - CROWN), (cx + CROWN, cy + CROWN), (cx - CROWN, cy + CROWN)]
    return legs, tops


def at(x, y, h):
    return x, y - h


def leg_point(leg, top, f):
    """A point f of the way up a leg (from the drill floor to the crown)."""
    h = TOWER_TOP * f
    return leg[0] + (top[0] - leg[0]) * f, leg[1] + (top[1] - leg[1]) * f, h


def pad(cv, rng):
    """The ground: oily earth around a concrete pad with a raised kerb."""
    for y in range(6, 47):
        for x in range(1, 47):
            # A rough blob of earth: ragged edges, inset at the corners.
            edge = min(x - 1, 46 - x, y - 6, 46 - y)
            if edge < 2 and rng.next() < 0.45 - edge * 0.2:
                continue
            s = 2 + rng.int(-1, 1)
            if rng.next() < 0.05:
                cv.put(x, y, c('oil', rng.int(0, 2)))
            else:
                cv.put(x, y, c('dirt', s))
    # The concrete slab, one pixel high, with speckles.
    x0, y0, x1, y1 = 3, 12, 44, 43
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            r = rng.next()
            s = 7 if r < 0.45 else 8 if r < 0.75 else 6 if r < 0.92 else 9 if r < 0.97 else 5
            cv.put(x, y, c('grey', s))
    # The kerb: lit on the north and west, a two pixel south face, dark outline.
    for x in range(x0, x1 + 1):
        cv.put(x, y0, c('grey', 10))
        cv.put(x, y1 - 1, c('grey', 9))
        cv.put(x, y1, c('grey', 5))
        cv.put(x, y1 + 1, c('grey', 4))
        cv.put(x, y1 + 2, c('grey', 1))
    for y in range(y0, y1 + 2):
        cv.put(x0, y, c('grey', 9))
        cv.put(x1, y, c('grey', 4))
        cv.put(x1 + 1, y, c('grey', 1))
    # Expansion joints.
    for x in range(x0 + 1, x1):
        if x % 2:
            cv.put(x, 28, c('grey', 5))
    for y in range(y0 + 1, y1):
        if y % 2:
            cv.put(24, y, c('grey', 5))
    # Oil stains on the concrete.
    for sx, sy, r in [(14, 38, 3), (31, 21, 2), (40, 41, 2)]:
        for y in range(sy - r, sy + r + 1):
            for x in range(sx - r - 1, sx + r + 2):
                if ((x - sx) / (r + 1)) ** 2 + ((y - sy) / r) ** 2 <= 1 and rng.next() < 0.7:
                    cv.put(x, y, c('grey', 5 + rng.int(0, 1)))


def derrick_frame(damaged):
    rng = Rng(0x0111B + (7 if damaged else 0))
    cv = Canvas(W, H)
    pad(cv, Rng(0x0111B))
    legs, tops = tower_points()

    top_f = 1 if not damaged else 0.7
    # Bracing levels up the legs (closer together towards the top).
    levels = [0, 0.26, 0.48, 0.66, 0.82, 1]
    if damaged:
        levels = [f for f in levels if f < top_f] + [top_f]

    def P(i, f):
        x, y, h = leg_point(legs[i], tops[i], f)
        return at(x, y, h)

    # ---- cast shadows (before the volumes, so they only fall on the ground)
    for leg, top in zip(legs, tops):
        a, b = leg_point(leg, top, 0), leg_point(leg, top, top_f)
        shadow_line(cv, a[0], a[1], a[2], b[0], b[1], b[2])
        shadow_line(cv, a[0] + 1, a[1], a[2], b[0] + 1, b[1], b[2])
    for f in levels[1:]:
        p0, p1 = leg_point(legs[3], tops[3], f), leg_point(legs[2], tops[2], f)
        shadow_line(cv, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2])
    shadow_disc(cv, BIG_TANK[0], BIG_TANK[1], BIG_TANK[2], BIG_TANK[3], 0.5)
    shadow_disc(cv, SMALL_TANK[0], SMALL_TANK[1], SMALL_TANK[2], SMALL_TANK[3], 0.5)
    shadow_box(cv, *HOUSE[:4], HOUSE[4])

    # ---- back to front
    # The small tank behind, and the pump house beside the tower.
    cylinder(cv, *SMALL_TANK, 'grey', bands=[(5, 6, 'steel')], seams=[2], rng=rng)
    box(cv, *HOUSE[:4], HOUSE[4], 'grey', 8, 5, rng, 0.15)
    hx0, hy0, hx1, hy1, hh = HOUSE
    for x in range(hx0 + 1, hx1, 2):
        cv.put(x, hy1 - 2, c('oil', 1))  # louvres
    cv.put(hx1 - 2, hy0 - hh + 1, c('steel', 1))  # exhaust stack
    cv.put(hx1 - 2, hy0 - hh, c('steel', 3))
    cv.put(hx1 - 2, hy0 - hh - 1, c('steel', 2))
    # Pipes from the wellhead to the house and on to the tanks (on the ground).
    def pipe_h(xa, xb, y):
        for x in range(xa, xb + 1):
            cv.put(x, y - 1, c('steel', 5))
            cv.put(x, y, c('steel', 2))
            cv.shadow(x + 1, y + 1)
    def pipe_v(x, ya, yb):
        for y in range(ya, yb + 1):
            cv.put(x, y, c('steel', 5))
            cv.put(x + 1, y, c('steel', 2))
            cv.shadow(x + 2, y + 1)
    pipe_h(14, hx0 - 1, 28)
    pipe_h(hx1 + 1, 35, 22)
    pipe_v(29, hy1 + 1, 31)
    # The wellhead under the drill floor: valves on a short stem.
    wx, wy = int((legs[0][0] + legs[2][0]) / 2), int((legs[0][1] + legs[2][1]) / 2)
    cv.rect(wx - 1, wy - 3, wx + 1, wy, c('rust', 3))
    cv.put(wx - 1, wy - 3, c('rust', 5))
    cv.put(wx + 1, wy, c('rust', 0))
    cv.put(wx - 2, wy - 2, c('red', 3))
    cv.put(wx + 2, wy - 2, c('red', 1))
    # Concrete footings under the legs.
    for lx, ly in legs:
        box(cv, int(lx) - 1, int(ly) - 1, int(lx) + 1, int(ly), 2, 'grey', 9, 6)
    # The back legs and their rungs, in shade behind the front face.
    for i in (0, 1):
        cv.line(*P(i, 0), *P(i, top_f), c('steel', 2))
    # The drill floor: a platform between the legs a quarter of the way up,
    # its front edge in hazard stripes.
    fl = levels[1]
    (ax, ay), (bx, by) = P(3, fl), P(2, fl)
    (cx0, cy0), (dx0, dy0) = P(0, fl), P(1, fl)
    for y in range(int(cy0), int(ay)):
        xa = ax + (cx0 - ax) * (ay - y) / max(1, ay - cy0)
        xb = bx + (dx0 - bx) * (ay - y) / max(1, ay - cy0)
        for x in range(int(round(xa)) + 1, int(round(xb))):
            cv.put(x, y, c('steel', 4 if (x + y) % 3 else 3))
    for x in range(int(ax), int(bx) + 1):
        cv.put(x, ay, c('yellow', 4) if (x // 2) % 2 == 0 else c('oil', 1))
        cv.put(x, ay + 1, c('steel', 1))
    # The front face: an X in every bay, a rung at every level.
    for k in range(1, len(levels) - 1):
        f0, f1 = levels[k], levels[k + 1]
        cv.line(*P(3, f0), *P(2, f1), c('steel', 4))
        cv.line(*P(2, f0), *P(3, f1), c('steel', 3))
    for f in levels[2:]:
        cv.line(*P(3, f), *P(2, f), c('steel', 5))
    # The front legs: the west one lit, the east one in shade, outlined.
    sx, sy = P(3, 0)
    tx, ty = P(3, top_f)
    cv.line(sx - 1, sy, tx - 1, ty, c('steel', 1))
    cv.line(sx, sy, tx, ty, c('steel', 6))
    cv.line(sx + 1, sy, tx + 1, ty, c('steel', 4))
    ex, ey = P(2, 0)
    fx, fy = P(2, top_f)
    cv.line(ex - 1, ey, fx - 1, fy, c('steel', 3))
    cv.line(ex, ey, fx, fy, c('steel', 1))
    cv.line(ex + 1, ey, fx + 1, fy, c('steel', 0))
    mx = (tops[0][0] + tops[2][0]) / 2
    my = (tops[0][1] + tops[2][1]) / 2
    if not damaged:
        # The drill string from the crown down to the floor.
        for h in range(int(TOWER_TOP * fl) + 1, TOWER_TOP - 2):
            cv.put(mx, my - h, c('grey', 9 if h % 5 else 6))
        # The crown block and its warning light.
        cx, cy = at(mx, my, TOWER_TOP)
        cx, cy = int(round(cx)), int(round(cy))
        cv.rect(cx - 3, cy - 1, cx + 3, cy + 1, c('steel', 3))
        cv.rect(cx - 3, cy - 1, cx + 2, cy - 1, c('steel', 5))
        cv.rect(cx + 3, cy - 1, cx + 3, cy + 1, c('steel', 0))
        cv.rect(cx - 3, cy + 1, cx + 3, cy + 1, c('steel', 1))
        cv.put(cx, cy - 2, c('yellow', 5))
        cv.put(cx, cy - 3, c('red', 4))
        # The travelling block halfway up.
        bx2, by2 = at(mx, my, int(TOWER_TOP * 0.58))
        bx2, by2 = int(round(bx2)), int(round(by2))
        cv.rect(bx2 - 1, by2 - 1, bx2 + 1, by2 + 1, c('yellow', 3))
        cv.put(bx2 + 1, by2 + 1, c('yellow', 1))
        cv.put(bx2 - 1, by2 - 1, c('yellow', 5))
    else:
        # Snapped: the top section hangs off the east side, the string is gone.
        ex, ey = P(2, top_f)
        cv.line(ex, ey, ex + 5, ey + 4, c('steel', 3))
        cv.line(ex - 1, ey + 1, ex + 4, ey + 6, c('steel', 1))
        cv.line(ex + 5, ey + 4, ex + 4, ey + 6, c('steel', 2))
        cv.rect(int(ex) + 4, int(ey) + 6, int(ex) + 6, int(ey) + 7, c('steel', 2))
        cv.put(int(ex) + 6, int(ey) + 7, c('steel', 0))
    # The big storage tank in front, its band in the owner's colour, a ladder up its west side.
    cylinder(cv, *BIG_TANK, 'grey', bands=[(4, 7, 'team')], seams=[2, 9], rng=rng)
    lx = BIG_TANK[0] - BIG_TANK[2] + 2
    for y in range(BIG_TANK[1] - BIG_TANK[3] + 1, BIG_TANK[1] + 2):
        cv.put(lx, y, c('steel', 1) if y % 2 else c('steel', 4))
    # Oil drums at the pad's front edge.
    for x, y in [(5, 43), (8, 44), (11, 43)]:
        oil_drum(cv, x, y)
    oil_drum(cv, 15, 44, 'yellow')

    if damaged:
        damage(cv, rng)
    return cv


def damage(cv, rng):
    """Scorch marks, a holed tank, rubble on the pad and chipped edges."""
    # Scorch blobs: blackened in the middle, soot around.
    for sx, sy, r in [(9, 19, 4), (19, 39, 4), (27, 30, 3), (43, 27, 3), (12, 31, 3), (38, 33, 3), (30, 44, 3)]:
        for y in range(sy - r, sy + r + 1):
            for x in range(sx - r, sx + r + 1):
                v = cv.get(x, y)
                if v in (TRANSPARENT, SHADOW):
                    continue
                d = ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5 / r
                if d > 1 or rng.next() < d * 0.35:
                    continue
                if d < 0.45:
                    cv.put(x, y, c('oil', rng.int(0, 1)))
                else:
                    cv.put(x, y, c('grey', rng.int(1, 3)))
    # A hole torn in the big tank's roof, with the bent edge lit.
    hx, hy = 34, 23
    for y in range(hy - 2, hy + 2):
        for x in range(hx - 3, hx + 3):
            if ((x - hx + 0.5) / 3) ** 2 + ((y - hy + 0.5) / 2) ** 2 <= 1:
                cv.put(x, y, c('oil', 0))
    for x in range(hx - 3, hx + 2):
        cv.put(x, hy - 3, c('grey', 10))
    # Rubble: chunks of concrete and steel off the structures.
    for _ in range(26):
        x, y = rng.int(3, 45), rng.int(13, 46)
        if cv.get(x, y) in IDX['grey'] or cv.get(x, y) in IDX['dirt']:
            cv.put(x, y, c('grey', rng.int(2, 9)))
            if rng.next() < 0.5:
                cv.put(x + 1, y, c('grey', 1))
    # Dents in the tank's band.
    for x, y in [(31, 37), (32, 38), (38, 36)]:
        cv.put(x, y, c('grey', 2))
    # Chipped pad edge: some of the kerb is gone.
    for x in range(30, 44):
        if rng.next() < 0.35:
            cv.put(x, 45, c('dirt', 1))
            cv.put(x, 44, c('grey', 3))


def encode(cv):
    return base64.b64encode(bytes(cv.px)).decode('ascii')


def main():
    art = {}
    frames = [derrick_frame(False), derrick_frame(True)]
    allowed = valid_indices()
    for cv in frames:
        bad = set(cv.px) - allowed
        if bad:
            raise SystemExit(f'OILB: indices outside the palette: {sorted(bad)}')
    art['OILB'] = {
        'width': W,
        'height': H,
        # The frame is the 2x2 footprint, centred on it.
        'offset': [0, 0],
        'poses': {'idle': 0, 'damaged': 1},
        'frames': [encode(cv) for cv in frames],
    }
    pal = bytes(v for rgb in PALETTE for v in rgb)

    def js(v):
        return json.dumps(v, separators=(',', ':'), sort_keys=True)

    lines = [
        '// GENERATED by tools/gen_pixel_art.py, do not edit.',
        "// WebRA's own pixel art in Red Alert's style (no Westwood or OpenRA pixels):",
        '// see the generator for the palette, the conventions and each piece.',
        '',
        '/** 256 RGB colours (base64 of 768 bytes); 0 transparent, 4 shadow, 80 to 95 remap. */',
        f"export const PIXEL_PALETTE = '{base64.b64encode(pal).decode('ascii')}';",
        '',
        '/** Palette indices the art may use (the generator checks every frame). */',
        f'export const PIXEL_INDICES = {js(sorted(allowed))};',
        '',
        '/**',
        ' * Per actor id: { width, height, offset: [x, y] (frame centre relative to the',
        ' * footprint centre), poses: { pose: frame }, frames: [base64 palette indices] }.',
        ' */',
        'export const PIXEL_ART = {',
    ]
    for aid in sorted(art):
        lines.append(f'  {json.dumps(aid)}: {js(art[aid])},')
    lines += ['};', '']
    with open(OUT, 'w') as f:
        f.write('\n'.join(lines))
    print(f'wrote {os.path.relpath(OUT, ROOT)}: {len(art)} actors, {sum(len(a["frames"]) for a in art.values())} frames')


if __name__ == '__main__':
    main()
