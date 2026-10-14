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
{ offset: [x, y] (the frames' origin relative to the footprint centre,
world pixels), frames: [[left, top, width, height, base64 of width * height
palette indices, row by row]] (trimmed; left and top relative to the
origin), body and second: { pose: { start, length?, facings?, tick? } }
(OpenRA sequences over the frames: facings anticlockwise from north),
cameo?: [width, height, base64] }. apps/game/js/art/pixel.js turns them
into atlas slots (pose tables of the body and of the turret or rotor), the
editor and sidebar icons and the cameos.

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
- MH60, the Black Hawk, and FTRK, the Mobile Flak: OpenRA's own units,
  drawn from its own mh60.shp, yrotorlg.shp, ftrk.shp and their icons.
  Here: 3D models rendered facing by facing (see "Units" below), with the
  rotor and the turret as OpenRA's sequences have them, and cameos.
- LROD, the Lightning Rod: WebRA's own structure (data/webra/rules.yaml),
  so neither Red Alert nor OpenRA has art for it. A 1x1 building of
  OpenRA's ^Building: idle, damaged-idle and a make (build-up) sequence
  (WithMakeAnimation, played once when it is placed). Here: a concrete
  mini bib pad, a plinth with the owner's colour band, a tapered steel
  lattice mast about one cell high on it (some two cells high on screen,
  like its Selectable DecorationBounds), a porcelain insulator, a copper
  rod with a crown of points and a grounding cable down the mast to a clamp
  on the pad. Damaged: the mast's top bent over with the rod, the cable
  snapped, the plinth cracked and chipped, scorch marks and rubble. Make:
  twelve frames from bare earth through the poured pad, the plinth and the
  rising mast to the rod (the idle frame adds the cable). Its cameo shows
  it against a thunderstorm. The copper ramp is new; it comes after the
  others, so their indices (and the other actors' frames) never change.

Run: python3 tools/gen_pixel_art.py (CI checks the output is up to date).
"""
import base64
import json
import math
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
    # Cockpit and cab glass: dark blue-grey, a pale sky reflection at the top.
    'glass': [(10, 16, 24), (18, 30, 42), (30, 48, 64), (46, 72, 92), (72, 104, 124), (112, 148, 166), (176, 204, 216)],
    # Olive drab: the painted parts in the cameos, which keep their own colours
    # (Red Alert's cameos are not remapped to the owner's colour).
    'drab': [(22, 24, 12), (36, 40, 20), (52, 58, 30), (68, 76, 40), (86, 94, 52), (106, 114, 66), (128, 136, 84),
             (152, 158, 104)],
    # Copper and brass: the Lightning Rod's rod, crown and grounding clamp.
    # Last, so the indices of the ramps above (and every frame drawn with
    # them) never move; it skips the remap range like any ramp.
    'copper': [(42, 20, 10), (74, 38, 16), (110, 60, 24), (148, 86, 36), (186, 118, 54), (220, 156, 86),
               (248, 204, 140)],
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


# ---- The Lightning Rod ---------------------------------------------------------------------
# A 1x1 structure that stands about two cells high on screen (its
# Selectable DecorationBounds: 1024, 2048, 0, -512). The canvas holds the
# footprint cell at x 0..23, y 32..55 with room above for the mast and to
# the right and below for its cast shadow; the frames' origin is the cell's
# centre (LROD_ORIGIN), so they sit on the footprint like the derrick's.

LROD_W, LROD_H = 44, 64
LROD_ORIGIN = (12, 44)
# The plinth: ground rectangle x0, y0, x1, y1 (inclusive) and height.
PLINTH = (6, 40, 17, 48, 5)
# The mast: legs from the plinth's roof (NW, NE, SE, SW ground points) to a
# small square under the cap MAST_TOP pixels above the ground.
MAST_LEGS = [(8, 42), (15, 42), (15, 46), (8, 46)]
MAST_TOPS = [(10.5, 43), (12.5, 43), (12.5, 45), (10.5, 45)]
MAST_TOP = 27
MAST_CENTRE = (11.5, 44)
# Bracing levels up the mast (closer together towards the top).
MAST_LEVELS = [0, 0.2, 0.38, 0.54, 0.68, 0.8, 0.9, 1]
# The make (build-up) animation, OpenRA WithMakeAnimation: a stage per frame
# (pad: 0 bare earth, 1 half poured, 2 done; plinth height; mast height as a
# fraction; cap; rod: 0 none, 1 lower half, 2 all of it with the crown). The
# idle frame adds the grounding cable.
LROD_MAKE = [
    (0, 0, 0, False, 0),
    (1, 0, 0, False, 0),
    (2, 0, 0, False, 0),
    (2, 2, 0, False, 0),
    (2, 5, 0, False, 0),
    (2, 5, 0.2, False, 0),
    (2, 5, 0.38, False, 0),
    (2, 5, 0.54, False, 0),
    (2, 5, 0.76, False, 0),
    (2, 5, 1, True, 0),
    (2, 5, 1, True, 1),
    (2, 5, 1, True, 2),
]


def mast_point(i, f):
    """Leg i (NW, NE, SE, SW) f of the way up: ground x, y and height."""
    (lx, ly), (tx, ty) = MAST_LEGS[i], MAST_TOPS[i]
    return lx + (tx - lx) * f, ly + (ty - ly) * f, PLINTH[4] + (MAST_TOP - PLINTH[4]) * f


def lrod_pad(cv, stage):
    """The ground: a patch of earth (stage 0), half of the concrete pad
    poured (1, still wet and dark) or all of it with its kerb (2), a mini
    bib like Red Alert's small structures stand on. The random speckles are
    drawn the same in every stage, so the frames do not flicker."""
    rng = Rng(0x120D)
    x0, y0, x1, y1 = 2, 35, 21, 51
    for y in range(33, 56):
        for x in range(0, 24):
            edge = min(x, 23 - x, y - 33, 55 - y)
            skip = edge < 2 and rng.next() < 0.45 - edge * 0.2
            s = 2 + rng.int(-1, 1)
            speck = rng.next()
            slab = rng.next()
            if skip:
                continue
            on_slab = x0 <= x <= x1 and y0 <= y <= y1
            if stage == 2 and on_slab:
                cv.put(x, y, c('grey', 7 if slab < 0.45 else 8 if slab < 0.75 else 6 if slab < 0.92 else 9 if slab < 0.97 else 5))
            elif stage == 1 and on_slab and y <= 43:
                cv.put(x, y, c('grey', 5 if slab < 0.6 else 4))
            elif speck < 0.04:
                cv.put(x, y, c('oil', 2))
            else:
                cv.put(x, y, c('dirt', s))
    if stage == 1:
        # The edge of the wet concrete, and the formwork boards around the rest.
        for x in range(x0, x1 + 1):
            cv.put(x, 44, c('grey', 3))
            cv.put(x, y1 + 1, c('rust', 3))
        for y in range(y0, y1 + 2):
            cv.put(x0 - 1, y, c('rust', 4))
            cv.put(x1 + 1, y, c('rust', 1))
    if stage < 2:
        return
    # The kerb: lit on the north and west, a two pixel south face, dark outline (as the derrick's pad).
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


def lrod_frame(make=None, damaged=False):
    """A Lightning Rod canvas: idle (make None), damaged, or the make stage
    `make` (LROD_MAKE)."""
    pad_stage, plinth_h, mast_f, cap, rod = make if make else (2, PLINTH[4], 1, True, 2)
    cable = make is None
    rng = Rng(0x120D + (7 if damaged else 0))
    cv = Canvas(LROD_W, LROD_H)
    lrod_pad(cv, pad_stage)
    # A damaged mast stands straight to `top_f`; above it the top section is bent over.
    top_f = 0.68 if damaged else mast_f
    levels = [f for f in MAST_LEVELS if f < top_f] + [top_f] if top_f > 0 else []
    cxm, cym = MAST_CENTRE
    px0, py0, px1, py1, _ = PLINTH

    def P(i, f):
        x, y, h = mast_point(i, f)
        return at(x, y, h)

    # ---- cast shadows (before the volumes, so they only fall on the ground)
    if plinth_h:
        shadow_box(cv, px0, py0, px1, py1, plinth_h)
    if top_f > 0:
        for i in range(4):
            a, b = mast_point(i, 0), mast_point(i, top_f)
            shadow_line(cv, a[0], a[1], a[2], b[0], b[1], b[2])
        for f in levels[1:]:
            a, b = mast_point(3, f), mast_point(2, f)
            shadow_line(cv, a[0], a[1], a[2], b[0], b[1], b[2])
    if damaged:
        # The bent top section and rod, leaning east.
        shadow_line(cv, cxm + 1, cym, MAST_TOP * 0.7, cxm + 7, cym + 1, MAST_TOP * 0.8)
    elif rod:
        shadow_line(cv, cxm, cym, MAST_TOP, cxm, cym, MAST_TOP + (6 if rod == 1 else 12))
        shadow_line(cv, cxm + 0.5, cym, MAST_TOP, cxm + 0.5, cym, MAST_TOP + (6 if rod == 1 else 10))

    # ---- back to front
    if plinth_h:
        # The concrete plinth; its south face carries the owner's colour band once it is cast.
        box(cv, px0, py0, px1, py1, plinth_h, 'grey', 8, 5, rng, 0.12)
        if plinth_h == PLINTH[4]:
            for x in range(px0 + 1, px1):
                cv.put(x, py1 - 3, c('team', 11 if x < px1 - 1 else 6))
                cv.put(x, py1 - 2, c('team', 7 if x < px1 - 1 else 4))
            cv.put(px0, py1 - 3, c('team', 13))
            cv.put(px0, py1 - 2, c('team', 9))
            # Anchor bolts under the legs.
            for lx, ly in MAST_LEGS:
                cv.put(lx, ly - plinth_h, c('steel', 1))
                cv.put(lx + 1, ly - plinth_h, c('steel', 4))
    if top_f > 0:
        # The back legs and their rungs, in shade behind the front face.
        for i in (0, 1):
            cv.line(*P(i, 0), *P(i, top_f), c('steel', 2))
        for f in levels[1:]:
            cv.line(*P(0, f), *P(1, f), c('steel', 1))
        # The front face: an X in every bay, a rung at every level.
        for k in range(len(levels) - 1):
            f0, f1 = levels[k], levels[k + 1]
            cv.line(*P(3, f0), *P(2, f1), c('steel', 4))
            cv.line(*P(2, f0), *P(3, f1), c('steel', 3))
        for f in levels[1:]:
            cv.line(*P(3, f), *P(2, f), c('steel', 5))
        # The front legs: the west one lit, the east one in shade, outlined.
        sx, sy = P(3, 0)
        tx, ty = P(3, top_f)
        cv.line(sx - 1, sy, tx - 1, ty, c('steel', 1))
        cv.line(sx, sy, tx, ty, c('steel', 6))
        ex, ey = P(2, 0)
        fx, fy = P(2, top_f)
        cv.line(ex, ey, fx, fy, c('steel', 2))
        cv.line(ex + 1, ey, fx + 1, fy, c('steel', 0))
    # The cap on the mast, the porcelain insulator on it and the copper rod
    # with its crown of points (an air terminal).
    tx, ty = at(cxm, cym, MAST_TOP)
    tx, ty = int(tx), int(round(ty))
    if damaged:
        # Bent over: the top section of the mast and the rod hang to the east.
        (ax, ay), (bx, by) = P(3, top_f), P(2, top_f)
        cv.line(ax, ay, bx + 4, by - 3, c('steel', 4))
        cv.line(bx, by, bx + 6, by - 1, c('steel', 1))
        cv.line(ax, ay - 1, bx + 5, by - 4, c('steel', 6))
        cv.line(bx + 1, by, bx + 7, by - 1, c('steel', 0))
        hx, hy = int(bx) + 6, int(by) - 3
        cv.rect(hx, hy, hx + 2, hy + 1, c('steel', 3))
        cv.put(hx, hy, c('steel', 5))
        cv.put(hx + 2, hy + 1, c('steel', 0))
        # The rod, bent down, its tip blackened.
        cv.line(hx + 3, hy, hx + 6, hy + 2, c('copper', 4))
        cv.line(hx + 3, hy + 1, hx + 6, hy + 3, c('copper', 1))
        cv.put(hx + 7, hy + 3, c('oil', 1))
        cv.put(hx + 7, hy + 4, c('oil', 0))
        # A broken insulator shell on the plinth.
        cv.put(px1 - 2, py0 - plinth_h + 2, c('grey', 11))
        cv.put(px1 - 1, py0 - plinth_h + 2, c('grey', 7))
    elif cap:
        cv.rect(tx - 1, ty - 1, tx + 2, ty + 1, c('steel', 3))
        cv.rect(tx - 1, ty - 1, tx + 1, ty - 1, c('steel', 5))
        cv.put(tx + 2, ty, c('steel', 0))
        cv.put(tx + 2, ty + 1, c('steel', 0))
        cv.rect(tx - 1, ty + 1, tx + 1, ty + 1, c('steel', 1))
        # The insulator: two porcelain sheds.
        for x, s in zip(range(tx - 1, tx + 3), (10, 11, 8, 5)):
            cv.put(x, ty - 2, c('grey', s))
        cv.put(tx, ty - 3, c('grey', 11))
        cv.put(tx + 1, ty - 3, c('grey', 7))
        if rod:
            # The rod: two pixels wide, lit on the west.
            top = ty - 6 if rod == 1 else ty - 7
            for y in range(top, ty - 3):
                cv.put(tx, y, c('copper', 5))
                cv.put(tx + 1, y, c('copper', 2))
            cv.put(tx + 1, top, c('copper', 3))
        if rod == 2:
            # The crown: a ring with a point at each side, and the tip.
            ry = ty - 6
            for x in range(tx - 2, tx + 4):
                cv.put(x, ry, c('copper', 4 if x < tx + 2 else 1))
            for k, (x, s) in enumerate([(tx - 2, 5), (tx + 3, 2)]):
                cv.put(x, ry - 1, c('copper', s))
                cv.put(x, ry - 2, c('copper', s + 1))
            cv.put(tx, ty - 8, c('copper', 5))
            cv.put(tx, ty - 9, c('copper', 6))
            cv.put(tx + 1, ty - 8, c('copper', 1))
            cv.put(tx, ty - 10, c('yellow', 5))

    if cable:
        # The grounding cable: from the rod's foot down the east front leg,
        # over the plinth and into the ground at a clamp on the pad.
        n = 0
        stop = 0.4 if damaged else 1
        for k in range(0, 41):
            f = k / 40
            if damaged and f > stop:
                break
            x, y = P(2, f)
            n += 1
            cv.put(x + 2, y, c('copper', 3) if n % 5 == 0 else c('oil', 2))
        if not damaged:
            cv.line(tx + 2, ty - 2, P(2, 1)[0] + 2, P(2, 1)[1], c('oil', 2))
        else:
            # Snapped: the loose end hangs off the mast.
            x, y = P(2, stop)
            cv.line(x + 2, y, x + 4, y + 4, c('oil', 2))
            cv.put(x + 4, y + 5, c('copper', 4))
        cx0 = px1 - 1
        for y in range(py1 - PLINTH[4] - 1, py1 + 1):
            cv.put(cx0 + 1, y, c('oil', 2) if y % 4 else c('copper', 3))
        for x in range(cx0 + 1, cx0 + 4):
            cv.put(x, py1 + 1, c('oil', 2))
            cv.shadow(x + 1, py1 + 2)
        # The clamp on its earthing stake.
        cv.put(cx0 + 4, py1, c('copper', 5))
        cv.put(cx0 + 5, py1, c('copper', 2))
        cv.put(cx0 + 4, py1 + 1, c('copper', 3))
        cv.put(cx0 + 5, py1 + 1, c('copper', 1))
        cv.shadow(cx0 + 6, py1 + 1)
        cv.shadow(cx0 + 6, py1 + 2)

    if damaged:
        lrod_damage(cv, rng)
    return cv


def lrod_damage(cv, rng):
    """Scorch marks, cracks in the plinth, a chipped corner and rubble."""
    for sx, sy, r in [(5, 38, 3), (18, 50, 3), (12, 46, 3), (20, 39, 2), (4, 49, 2)]:
        for y in range(sy - r, sy + r + 1):
            for x in range(sx - r, sx + r + 1):
                v = cv.get(x, y)
                if v in (TRANSPARENT, SHADOW):
                    continue
                d = ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5 / r
                if d > 1 or rng.next() < d * 0.35:
                    continue
                cv.put(x, y, c('oil', rng.int(0, 1)) if d < 0.45 else c('grey', rng.int(1, 3)))
    # A crack down the plinth's south face and across its roof.
    for x, y in [(10, 36), (10, 37), (11, 38), (11, 39), (12, 40), (12, 41), (13, 42), (13, 43), (14, 44), (14, 45),
                 (13, 46), (13, 47), (14, 48)]:
        cv.put(x, y, c('grey', 1))
    # The north-east corner of the plinth knocked off.
    for x, y in [(16, 35), (17, 35), (17, 36), (17, 37)]:
        cv.put(x, y, c('dirt', 1))
    cv.put(16, 36, c('grey', 3))
    # Rubble on the pad.
    for _ in range(12):
        x, y = rng.int(2, 21), rng.int(36, 51)
        if cv.get(x, y) in IDX['grey'] or cv.get(x, y) in IDX['dirt']:
            cv.put(x, y, c('grey', rng.int(2, 9)))
            if rng.next() < 0.5:
                cv.put(x + 1, y, c('grey', 1))


def lrod_canvas_frame(cv):
    """A Lightning Rod canvas as a frame around the footprint centre."""
    ox, oy = LROD_ORIGIN
    return pixels_frame({(x - ox, y - oy): v for y in range(cv.h) for x in range(cv.w) if (v := cv.px[y * cv.w + x])})


def lrod_cameo():
    """The cameo: the rod against a thunderstorm sky, lightning striking the
    plain behind it, the tip glowing. Opaque, its own colours (the owner's
    band painted olive drab, like the units' cameos)."""
    rng = Rng(0xCA3E1)
    px = [0] * (CAMEO_W * CAMEO_H)
    horizon = 30
    for y in range(CAMEO_H):
        for x in range(CAMEO_W):
            if y < horizon:
                # Storm clouds: dark at the top, a paler band low over the horizon.
                f = y / horizon
                s = int(f * 2.4 + BAYER[y % 2][x % 2] * 0.9)
                if rng.next() < 0.1:
                    s += rng.int(-1, 1)
                px[y * CAMEO_W + x] = c('steel', max(0, min(3, s)))
            else:
                f = (y - horizon) / (CAMEO_H - horizon)
                s = 1 + int(f * 2.6 + BAYER[y % 2][x % 2] * 0.9)
                if rng.next() < 0.08:
                    s += rng.int(-1, 1)
                px[y * CAMEO_W + x] = c('dirt', max(0, min(3, s)))
    for x in range(CAMEO_W):
        px[horizon * CAMEO_W + x] = c('steel', 3)
    # The lightning bolt behind: a jagged white core with a pale glow, and a fork.
    def bolt(points, core, glow):
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            n = max(abs(x1 - x0), abs(y1 - y0))
            for k in range(n + 1):
                x = int(round(x0 + (x1 - x0) * k / n))
                y = int(round(y0 + (y1 - y0) * k / n))
                for gx in (x - 1, x + 1):
                    if 0 <= gx < CAMEO_W and px[y * CAMEO_W + gx] in IDX['steel']:
                        px[y * CAMEO_W + gx] = glow
                px[y * CAMEO_W + x] = core
    bolt([(12, 1), (9, 7), (13, 12), (10, 18), (14, 24), (12, 30)], c('grey', 11), c('steel', 5))
    bolt([(10, 18), (5, 22), (6, 27)], c('grey', 9), c('steel', 4))
    # The rod in front, standing on the plain.
    cv = lrod_frame()
    dx, dy = 25, -3
    drab_ramp = IDX['drab']
    for y in range(cv.h):
        for x in range(cv.w):
            v = cv.px[y * cv.w + x]
            X, Y = x + dx, y + dy
            if not v or not (0 <= X < CAMEO_W and 0 <= Y < CAMEO_H):
                continue
            if v == SHADOW:
                old = px[Y * CAMEO_W + X]
                for ramp, idx in IDX.items():
                    if old in idx:
                        px[Y * CAMEO_W + X] = c(ramp, idx.index(old) - 2)
                        break
            elif REMAP_START <= v <= REMAP_END:
                px[Y * CAMEO_W + X] = drab_ramp[(v - REMAP_START) * len(drab_ramp) // 16]
            else:
                px[Y * CAMEO_W + X] = v
    # The tip glows where the storm's charge gathers.
    tx, ty = at(*MAST_CENTRE, MAST_TOP)
    tx, ty = int(tx) + dx, int(round(ty)) + dy - 10
    for gx, gy, s in [(tx - 1, ty, 4), (tx + 1, ty, 4), (tx, ty - 1, 4), (tx - 1, ty - 1, 3), (tx + 1, ty - 1, 3)]:
        px[gy * CAMEO_W + gx] = c('yellow', s)
    px[ty * CAMEO_W + tx] = c('yellow', 5)
    # A dark rim around the picture, lit on the top and the left (as the units' cameos).
    for x in range(CAMEO_W):
        px[x] = c('steel', 4)
        px[(CAMEO_H - 1) * CAMEO_W + x] = c('steel', 0)
    for y in range(CAMEO_H):
        px[y * CAMEO_W] = c('steel', 4)
        px[y * CAMEO_W + CAMEO_W - 1] = c('steel', 0)
    return [CAMEO_W, CAMEO_H, base64.b64encode(bytes(px)).decode('ascii')]


def lrod_frames():
    """Idle, damaged, then the make sequence."""
    return [lrod_canvas_frame(lrod_frame()), lrod_canvas_frame(lrod_frame(damaged=True))] + [
        lrod_canvas_frame(lrod_frame(make=m)) for m in LROD_MAKE
    ]


# ---- Units: 3D models rendered facing by facing --------------------------------------------
# Westwood rendered its vehicles and aircraft from 3D models, one frame per
# facing, lit from the top left and anti-aliased against black (which leaves
# the dark rims of Red Alert's units). Here, too: each unit is a handful of
# convex solids (prisms cut from side, front and top views, ellipsoids and
# cylinders) that a small ray caster renders per facing with the same light,
# so the frames turn smoothly and every facing is drawn, none mirrored.
#
# Model space: x to the right of the unit, y forward, z up, one world pixel
# per unit. World space: x east, y south, z up. Frames are projected like
# OpenRA's classic perspective (engine render.rs classic_offset): screen x is
# world x, screen y is world y shortened by the sine of the 40 degree camera
# pitch minus the height, so parts OpenRA places by offset (the Mobile Flak's
# turret, the rotor hubs) land where the frames draw them.

PITCH = 654 / 1024  # engine render.rs CLASSIC_PITCH_SIN
PI = 3.141592653589793


def dsin(deg):
    """Sine of an angle in degrees, with + - * / only: the same bits on every platform."""
    d = deg % 360.0
    if d > 180.0:
        d -= 360.0
    x = d * PI / 180.0
    x2 = x * x
    term = x
    total = x
    for n in range(1, 15):
        term *= -x2 / ((2 * n) * (2 * n + 1))
        total += term
    return total


def dcos(deg):
    return dsin(deg + 90.0)


def vnorm(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return (v[0] / n, v[1] / n, v[2] / n)


def rot(yaw=0.0, pitch=0.0):
    """Rows of the rotation local -> model: `pitch` degrees nose up about x, then `yaw` degrees anticlockwise about z."""
    cp, sp = dcos(pitch), dsin(pitch)
    cy, sy = dcos(yaw), dsin(yaw)
    # Rz(yaw) * Rx(pitch)
    return ((cy, -sy * cp, sy * sp), (sy, cy * cp, -cy * sp), (0.0, sp, cp))


IDENTITY = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))


class Solid:
    """A convex solid in its own frame: half-spaces n . p <= d, optionally cut
    with an axis-aligned quadric sum w_k (p_k - c_k)^2 <= 1 (an ellipsoid, or
    a cylinder with one weight 0). `mat` is (ramp, brightness change) or
    mat(p, n) of the model-space point and normal; `frame` places it in the
    model (rotation rows local -> model, translation)."""

    def __init__(self, planes, box, quad=None, mat=('grey', 0.0), frame=(IDENTITY, (0.0, 0.0, 0.0)), shadow=True):
        self.planes = list(planes)
        self.box = box  # local bounds (x0, x1, y0, y1, z0, z1)
        self.quad = quad
        self.mat = mat
        self.frame = frame
        self.shadow = shadow

    def moved(self, yaw=0.0, pitch=0.0, t=(0.0, 0.0, 0.0)):
        """The solid turned (pitch, then yaw) about the model origin, then moved by t."""
        r = rot(yaw, pitch)
        (r0, t0) = self.frame
        rr = tuple(tuple(sum(r[i][k] * r0[k][j] for k in range(3)) for j in range(3)) for i in range(3))
        tt = tuple(sum(r[i][k] * t0[k] for k in range(3)) + t[i] for i in range(3))
        return Solid(self.planes, self.box, self.quad, self.mat, (rr, tt), self.shadow)

    def paint(self, mat):
        return Solid(self.planes, self.box, self.quad, mat, self.frame, self.shadow)

    def no_shadow(self):
        return Solid(self.planes, self.box, self.quad, self.mat, self.frame, False)

    def corners(self):
        """The model-space corners of its local bounds."""
        (r, t) = self.frame
        x0, x1, y0, y1, z0, z1 = self.box
        out = []
        for x in (x0, x1):
            for y in (y0, y1):
                for z in (z0, z1):
                    out.append(tuple(r[i][0] * x + r[i][1] * y + r[i][2] * z + t[i] for i in range(3)))
        return out

    def hit(self, o, d):
        """Entry distance and local normal of the model-space ray o + t d, or None."""
        (r, t) = self.frame
        p = (o[0] - t[0], o[1] - t[1], o[2] - t[2])
        # Into the local frame: the transpose of the rotation.
        lo = (r[0][0] * p[0] + r[1][0] * p[1] + r[2][0] * p[2], r[0][1] * p[0] + r[1][1] * p[1] + r[2][1] * p[2],
              r[0][2] * p[0] + r[1][2] * p[1] + r[2][2] * p[2])
        ld = (r[0][0] * d[0] + r[1][0] * d[1] + r[2][0] * d[2], r[0][1] * d[0] + r[1][1] * d[1] + r[2][1] * d[2],
              r[0][2] * d[0] + r[1][2] * d[1] + r[2][2] * d[2])
        t0, t1 = -1e9, 1e9
        normal = None
        if self.quad:
            cx, cy, cz, wx, wy, wz = self.quad
            ox, oy, oz = lo[0] - cx, lo[1] - cy, lo[2] - cz
            a = wx * ld[0] * ld[0] + wy * ld[1] * ld[1] + wz * ld[2] * ld[2]
            b = 2 * (wx * ld[0] * ox + wy * ld[1] * oy + wz * ld[2] * oz)
            cc = wx * ox * ox + wy * oy * oy + wz * oz * oz - 1
            if a == 0:
                if cc > 0:
                    return None
            else:
                disc = b * b - 4 * a * cc
                if disc < 0:
                    return None
                sq = math.sqrt(disc)
                t0, t1 = (-b - sq) / (2 * a), (-b + sq) / (2 * a)
                normal = 'quad'
        for nx, ny, nz, dd in self.planes:
            den = nx * ld[0] + ny * ld[1] + nz * ld[2]
            num = dd - (nx * lo[0] + ny * lo[1] + nz * lo[2])
            if den == 0:
                if num < 0:
                    return None
                continue
            tt = num / den
            if den < 0:
                if tt > t0:
                    t0 = tt
                    normal = (nx, ny, nz)
            elif tt < t1:
                t1 = tt
            if t0 > t1:
                return None
        if normal is None:
            return None
        if normal == 'quad':
            cx, cy, cz, wx, wy, wz = self.quad
            q = (lo[0] + t0 * ld[0] - cx, lo[1] + t0 * ld[1] - cy, lo[2] + t0 * ld[2] - cz)
            normal = vnorm((wx * q[0], wy * q[1], wz * q[2]))
        # Back to the model frame.
        n = tuple(r[i][0] * normal[0] + r[i][1] * normal[1] + r[i][2] * normal[2] for i in range(3))
        return t0, n


def box3(x0, x1, y0, y1, z0, z1, mat=('grey', 0.0)):
    planes = [(1, 0, 0, x1), (-1, 0, 0, -x0), (0, 1, 0, y1), (0, -1, 0, -y0), (0, 0, 1, z1), (0, 0, -1, -z0)]
    return Solid(planes, (x0, x1, y0, y1, z0, z1), mat=mat)


def prism(axis, poly, lo, hi, mat=('grey', 0.0)):
    """A convex polygon extruded along `axis` from lo to hi. The polygon's
    points are (y, z) for axis 'x' (a side view), (x, z) for 'y' (a front
    view) and (x, y) for 'z' (a top view)."""
    area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))
    pts = poly if area > 0 else list(reversed(poly))
    # The half-spaces of a concave polygon would cut away more than its outline: refuse it.
    for i in range(len(pts)):
        (u0, v0), (u1, v1), (u2, v2) = pts[i - 2], pts[i - 1], pts[i]
        if (u1 - u0) * (v2 - v1) - (v1 - v0) * (u2 - u1) < 0:
            raise SystemExit(f'prism: the polygon is not convex at {pts[i - 1]}')
    a, b = {'x': (1, 2), 'y': (0, 2), 'z': (0, 1)}[axis]
    k = 'xyz'.index(axis)
    planes = []
    for i in range(len(pts)):
        (u0, v0), (u1, v1) = pts[i], pts[(i + 1) % len(pts)]
        nu, nv = v1 - v0, -(u1 - u0)
        ln = math.sqrt(nu * nu + nv * nv)
        nu, nv = nu / ln, nv / ln
        n = [0.0, 0.0, 0.0]
        n[a], n[b] = nu, nv
        planes.append((n[0], n[1], n[2], nu * u0 + nv * v0))
    cap = [0.0, 0.0, 0.0]
    cap[k] = 1.0
    planes.append((cap[0], cap[1], cap[2], hi))
    planes.append((-cap[0], -cap[1], -cap[2], -lo))
    bounds = [0.0] * 6
    bounds[2 * a], bounds[2 * a + 1] = min(p[0] for p in pts), max(p[0] for p in pts)
    bounds[2 * b], bounds[2 * b + 1] = min(p[1] for p in pts), max(p[1] for p in pts)
    bounds[2 * k], bounds[2 * k + 1] = lo, hi
    return Solid(planes, tuple(bounds), mat=mat)


def cut(*solids, mat=None):
    """The intersection of solids in the same frame (one quadric at most)."""
    planes = []
    quad = None
    b = [-1e9, 1e9, -1e9, 1e9, -1e9, 1e9]
    for s in solids:
        planes += s.planes
        if s.quad:
            quad = s.quad
        for i in range(3):
            b[2 * i] = max(b[2 * i], s.box[2 * i])
            b[2 * i + 1] = min(b[2 * i + 1], s.box[2 * i + 1])
    return Solid(planes, tuple(b), quad, mat if mat is not None else solids[0].mat)


def ellipsoid(cx, cy, cz, rx, ry, rz, mat=('grey', 0.0)):
    return Solid([], (cx - rx, cx + rx, cy - ry, cy + ry, cz - rz, cz + rz), (cx, cy, cz, 1 / (rx * rx), 1 / (ry * ry), 1 / (rz * rz)), mat)


def bar(axis, c, r, lo, hi, mat=('grey', 0.0)):
    """A round bar along `axis` through the point c (its coordinate on the axis ignored), lo to hi."""
    k = 'xyz'.index(axis)
    w = [1 / (r * r)] * 3
    w[k] = 0.0
    cc = list(c)
    cc[k] = 0.0
    b = [cc[0] - r, cc[0] + r, cc[1] - r, cc[1] + r, cc[2] - r, cc[2] + r]
    b[2 * k], b[2 * k + 1] = lo, hi
    cap = [0.0, 0.0, 0.0]
    cap[k] = 1.0
    planes = [(cap[0], cap[1], cap[2], hi), (-cap[0], -cap[1], -cap[2], -lo)]
    return Solid(planes, tuple(b), (cc[0], cc[1], cc[2], w[0], w[1], w[2]), mat)


# Toward the light (world space): from the north west and above, so the
# top and the left of every unit are lit, as in Red Alert. Toward the camera:
# from the south, along the classic perspective.
LIGHT = vnorm((-1.0, -1.0, 1.55))
EYE = vnorm((0.0, 1.0, PITCH))
HALF = vnorm((LIGHT[0] + EYE[0], LIGHT[1] + EYE[1], LIGHT[2] + EYE[2]))


def brightness(n):
    """0 (black) to about 1.1 (a highlight) for a world-space normal."""
    nl = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]
    ne = n[0] * EYE[0] + n[1] * EYE[1] + n[2] * EYE[2]
    nh = n[0] * HALF[0] + n[1] * HALF[1] + n[2] * HALF[2]
    v = 0.12 + 0.8 * max(0.0, nl) + 0.12 * max(0.0, ne)
    if nh > 0:
        h2 = nh * nh
        h4 = h2 * h2
        h8 = h4 * h4
        v += 0.32 * h8 * h8
    return v


# Ordered dither (2 x 2 Bayer), a fraction of a shade: the grain of
# Westwood's renders where a surface's shade changes.
BAYER = ((0.0, 0.5), (0.75, 0.25))


class Shot:
    """One frame being rendered: model solids seen at a heading (WebRA's
    clockwise degrees from north) and a zoom (cameos)."""

    def __init__(self, solids, heading, zoom=1.0, lift=0.0):
        self.solids = solids
        self.zoom = zoom
        self.lift = lift  # model z added (a turret's height on its body)
        self.c, self.s = dcos(heading), dsin(heading)

    def to_model(self, v, point):
        """World -> model (an orthogonal mapping that is its own inverse)."""
        z = v[2] - self.lift if point else v[2]
        return (v[0] * self.c + v[1] * self.s, v[0] * self.s - v[1] * self.c, z)

    def to_world(self, v):
        return (v[0] * self.c + v[1] * self.s, v[0] * self.s - v[1] * self.c, v[2])

    def screen(self, p):
        w = self.to_world((p[0], p[1], p[2] + self.lift))
        return (w[0] * self.zoom, (w[1] * PITCH - w[2]) * self.zoom)

    def bounds(self, solid):
        pts = [self.screen(p) for p in solid.corners()]
        return (min(p[0] for p in pts), max(p[0] for p in pts), min(p[1] for p in pts), max(p[1] for p in pts))

    def ground_bounds(self, solid, ground):
        """Screen bounds of a solid's cast shadow on the ground (height `ground`)."""
        out = []
        for p in solid.corners():
            w = self.to_world((p[0], p[1], p[2] + self.lift))
            k = (w[2] - ground) / LIGHT[2]
            g = (w[0] - k * LIGHT[0], w[1] - k * LIGHT[1], ground)
            out.append((g[0] * self.zoom, (g[1] * PITCH - g[2]) * self.zoom))
        return (min(p[0] for p in out), max(p[0] for p in out), min(p[1] for p in out), max(p[1] for p in out))

    def trace(self, sx, sy, candidates):
        """The nearest solid under the screen point: (solid, model point, model normal, world normal) or None."""
        x = sx / self.zoom
        y = sy / self.zoom
        o = self.to_model((x, 60.0, PITCH * 60.0 - y), True)
        d = self.to_model((0.0, -1.0, -PITCH), False)
        best = None
        for s in candidates:
            h = s.hit(o, d)
            if h and (best is None or h[0] < best[0]):
                best = (h[0], s, h[1])
        if not best:
            return None
        t, s, n = best
        return s, (o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]), n, self.to_world(n)

    def shaded(self, sx, sy, ground, candidates):
        """Whether the ground point under (sx, sy) lies in a cast shadow."""
        x = sx / self.zoom
        y = (sy / self.zoom + ground) / PITCH
        o = self.to_model((x, y, ground), True)
        d = self.to_model(LIGHT, False)
        return any(s.hit(o, d) and s.hit(o, d)[0] > 1e-6 for s in candidates)


def material(solid, p, n):
    m = solid.mat
    return m(p, n) if callable(m) else m


def render(solids, heading, zoom=1.0, lift=0.0, ground=None, samples=3, rim=True):
    """Pixels {(x, y): palette index} of `solids` at `heading` (pixel (x, y)
    covers screen x..x+1, y..y+1, the origin is the model's origin on the
    screen). `ground` is the height cast shadows fall on (None: no shadow)."""
    shot = Shot(solids, heading, zoom, lift)
    boxes = [(s, shot.bounds(s)) for s in solids]
    x0 = int(math.floor(min(b[0] for _, b in boxes))) - 1
    x1 = int(math.ceil(max(b[1] for _, b in boxes))) + 1
    y0 = int(math.floor(min(b[2] for _, b in boxes))) - 1
    y1 = int(math.ceil(max(b[3] for _, b in boxes))) + 1
    full = samples * samples
    cells = {}
    for py in range(y0, y1):
        for px in range(x0, x1):
            cand = [s for s, b in boxes if b[0] <= px + 1 and b[1] >= px and b[2] <= py + 1 and b[3] >= py]
            if not cand:
                continue
            got = {}
            hits = 0
            for j in range(samples):
                for i in range(samples):
                    h = shot.trace(px + (i + 0.5) / samples, py + (j + 0.5) / samples, cand)
                    if not h:
                        continue
                    s, p, n, nw = h
                    ramp, change = material(s, p, n)
                    hits += 1
                    k = got.setdefault(ramp, [0, 0.0])
                    k[0] += 1
                    k[1] += brightness(nw) + change
            if hits * 2 < full:
                continue
            ramp = max(got, key=lambda r: (got[r][0], r))
            cells[(px, py)] = (ramp, got[ramp][1] / got[ramp][0], hits / full)
    out = {}
    for (px, py), (ramp, v, cover) in cells.items():
        n = len(IDX[ramp])
        # Partly covered pixels darken towards the black the models were rendered on.
        v *= 0.55 + 0.45 * cover
        shade = v * (n - 1) + BAYER[py % 2][px % 2] * 0.7 - 0.25
        if rim:
            # Dark rims on the far (bottom and right) edges, as in Westwood's renders.
            if (px + 1, py) not in cells or (px, py + 1) not in cells:
                shade -= max(1.0, n / 6)
            elif (px - 1, py) not in cells or (px, py - 1) not in cells:
                shade -= max(0.5, n / 14)
        out[(px, py)] = c(ramp, int(math.floor(shade + 0.5)))
    if ground is not None:
        casting = [s for s in solids if s.shadow]
        gboxes = [(s, shot.ground_bounds(s, ground)) for s in casting]
        gx0 = int(math.floor(min(b[0] for _, b in gboxes))) - 1
        gx1 = int(math.ceil(max(b[1] for _, b in gboxes))) + 1
        gy0 = int(math.floor(min(b[2] for _, b in gboxes))) - 1
        gy1 = int(math.ceil(max(b[3] for _, b in gboxes))) + 1
        for py in range(gy0, gy1):
            for px in range(gx0, gx1):
                if (px, py) in out:
                    continue
                if shot.shaded(px + 0.5, py + 0.5, ground, casting):
                    out[(px, py)] = SHADOW
    return out


def pixels_frame(px):
    """[left, top, width, height, base64] of a pixel dict (left and top
    relative to the model's origin on the screen)."""
    if not px:
        return [0, 0, 0, 0, '']
    l = min(x for x, _ in px)
    t = min(y for _, y in px)
    w = max(x for x, _ in px) - l + 1
    h = max(y for _, y in px) - t + 1
    data = bytearray(w * h)
    for (x, y), v in px.items():
        data[(y - t) * w + x - l] = v
    return [l, t, w, h, base64.b64encode(bytes(data)).decode('ascii')]


# Facings: frame f of a 32-facing sequence faces f * 11.25 degrees
# anticlockwise from north (OpenRA's order, content/sequences.js), rendered
# at exactly that heading, so OpenRA's plain IndexFacing picks it (Westwood's
# frames need the uneven classic ranges; these are even).
FACINGS = 32


def facing_heading(f):
    """WebRA's clockwise heading in degrees of frame f."""
    return -f * 360.0 / FACINGS


# ---- The Black Hawk (MH60) ------------------------------------------------------------------
# OpenRA aircraft.yaml MH60 (an Allied transport helicopter with a chain gun,
# Hind-sized: 1 cell radius) and sequences/aircraft.yaml mh60: idle (32
# classic facings, also its husk falling), rotor (4 frames, airborne) and
# slow-rotor (8 frames, on the ground) from OpenRA's own yrotorlg.shp, the
# muzzle (Red Alert's minigun.shp) and its cameo. Model: the UH-60's long
# cabin with a rounded nose and dark glazing, two engines on the roof, a
# slim tail boom rising to a swept fin with the tail rotor on the right and
# the stabilator low on the fin, door guns, wheels. About 32 pixels from
# nose to tail like the Longbow and the Hind. Model z 0 is the middle of
# the fuselage, which is centred on the actor like the other helicopters;
# the engine draws the aircraft's shadow itself (the same sprite, dark, on
# the ground), so the frames have no cast shadow.

HUB_Z = 6.5  # the rotor hub over the mast (the rotor frames are drawn around it)
ROTOR_R = 15.5


def mh60_cabin_mat(p, n):
    x, y, z = p
    # Cockpit glazing: the windscreen over the nose and the side windows.
    if y > 6.2 and z > -0.2:
        return ('glass', 0.05)
    if abs(n[0]) > 0.6 and z > 0.4 and z < 2.6 and (2.0 < y < 5.4 or -3.8 < y < -0.4):
        return ('glass', 0.0)
    # Door frames and panel lines.
    if abs(n[0]) > 0.6 and (abs(y - 0.4) < 0.35 or abs(y + 4.2) < 0.35):
        return ('team', -0.12)
    if n[2] < -0.5:
        return ('team', -0.08)
    return ('team', 0.0)


def mh60_model():
    side = [(-8.0, -2.4), (5.0, -2.6), (9.0, -1.8), (11.4, -0.2), (11.0, 1.2), (8.6, 2.8), (6.2, 3.4), (-6.4, 3.4), (-9.0, 1.6)]
    front = [(-4.0, -1.6), (-3.2, -2.6), (3.2, -2.6), (4.0, -1.6), (4.0, 2.0), (2.8, 3.4), (-2.8, 3.4), (-4.0, 2.0)]
    top = [(-4.0, -9.0), (4.0, -9.0), (4.0, 5.4), (3.0, 9.4), (1.2, 11.6), (-1.2, 11.6), (-3.0, 9.4), (-4.0, 5.4)]
    cabin = cut(prism('x', side, -4.0, 4.0), prism('y', front, -9.0, 11.6), prism('z', top, -2.6, 3.4), mat=mh60_cabin_mat)
    boom = cut(
        prism('x', [(-7.0, -1.8), (-21.0, 0.6), (-21.0, 2.0), (-7.0, 2.6)], -2.0, 2.0),
        prism('z', [(-2.0, -7.0), (2.0, -7.0), (0.8, -21.0), (-0.8, -21.0)], -2.0, 2.6),
        mat=('team', -0.02),
    )
    fin = prism('x', [(-19.0, 1.6), (-21.4, 1.4), (-23.6, 6.2), (-22.0, 6.4)], -0.45, 0.45, mat=('team', -0.04))
    stab = box3(-4.4, 4.4, -22.4, -20.6, 0.8, 1.3, mat=('team', -0.02))
    tail_rotor = bar('x', (0.0, -22.2, 4.4), 2.2, 0.5, 0.8, mat=('steel', 0.0))
    tail_hub = bar('x', (0.0, -22.2, 4.4), 0.5, 0.5, 1.1, mat=('steel', 0.05))
    engines = [ellipsoid(side_x, -2.0, 3.8, 1.5, 4.2, 1.4, mat=('team', 0.04)) for side_x in (-2.0, 2.0)]
    exhausts = [bar('y', (side_x, 0.0, 4.0), 0.7, -6.6, -5.4, mat=('steel', -0.2)) for side_x in (-2.6, 2.6)]
    mast = bar('z', (0.0, 0.0, 0.0), 1.0, 3.4, 5.8, mat=('steel', 0.0))
    hub_fairing = ellipsoid(0.0, 0.4, 4.0, 1.6, 2.6, 0.9, mat=('team', -0.03))
    guns = [bar('y', (side_x, 0.0, 0.8), 0.35, 1.0, 4.4, mat=('steel', -0.3)) for side_x in (-4.5, 4.5)]
    gun_mounts = [box3(side_x - 0.4, side_x + 0.4, 0.6, 1.8, 0.2, 1.2, mat=('steel', -0.2)) for side_x in (-4.3, 4.3)]
    wheels = [bar('x', (0.0, 4.4, -3.4), 1.05, side_x - 0.45, side_x + 0.45, mat=('grey', -0.45)) for side_x in (-3.5, 3.5)]
    struts = [box3(side_x - 0.25, side_x + 0.25, 4.0, 4.8, -3.0, -1.8, mat=('steel', -0.1)) for side_x in (-3.3, 3.3)]
    tail_wheel = bar('x', (0.0, -19.4, -0.6), 0.6, -0.3, 0.3, mat=('grey', -0.45))
    return [cabin, boom, fin, stab, tail_rotor, tail_hub, mast, hub_fairing] + engines + exhausts + guns + gun_mounts + wheels + struts + [tail_wheel]


def blade_mat(p, n):
    return ('steel', -0.22)


def rotor_model(angle, blades=4):
    """The main rotor at `angle` degrees: blades around the hub over the mast."""
    blade = box3(1.0, ROTOR_R, -0.85, 0.85, -0.12, 0.12, mat=blade_mat)
    out = [blade.moved(yaw=angle + k * 360.0 / blades, t=(0.0, 0.0, HUB_Z)) for k in range(blades)]
    out.append(bar('z', (0.0, 0.0, 0.0), 1.4, HUB_Z - 0.4, HUB_Z + 0.5, mat=('steel', 0.0)))
    out.append(ellipsoid(0.0, 0.0, HUB_Z + 0.5, 0.9, 0.9, 0.5, mat=('steel', 0.15)))
    return out


def merge(*layers):
    """Pixel dicts on top of each other, the last on top."""
    out = {}
    for layer in layers:
        out.update(layer)
    return out


def slow_rotor_frame(k):
    """Ground rotor frame k of 8: a quarter turn of the four blades (they idle round anticlockwise)."""
    return render(rotor_model(k * 90.0 / 8), 0.0)


def fast_rotor_frame(k):
    """Airborne rotor frame k of 4: blades blurred over their sweep, a faint
    disc (shadow pixels: drawn translucent dark) where they spin."""
    a = k * 90.0 / 4
    trail = [render(rotor_model(a - 7.0 * j)[:4], 0.0, rim=False) for j in (3, 2, 1)]
    out = {}
    # The disc: a sparse stipple turning with the frame.
    for y in range(-int(ROTOR_R * PITCH) - 2 - int(HUB_Z), int(ROTOR_R * PITCH) + 2 - int(HUB_Z)):
        for x in range(-int(ROTOR_R) - 1, int(ROTOR_R) + 2):
            dx = (x + 0.5) / ROTOR_R
            dy = (y + 0.5 + HUB_Z) / (ROTOR_R * PITCH)
            d = dx * dx + dy * dy
            if d <= 1.0 and d > 0.02 and (x + k) % 2 == 0 and (y + k // 2 + (x + k) // 2) % 2 == 0:
                out[(x, y)] = SHADOW
    for j, layer in enumerate(trail):
        for p, v in layer.items():
            if v == SHADOW:
                continue
            # Older positions of the blades fade into the disc.
            if j == 0 and (p[0] + p[1]) % 2:
                continue
            out[p] = c('steel', 1 + j)
    blades = render(rotor_model(a), 0.0)
    return merge(out, blades)


def mh60_frames():
    body = mh60_model()
    frames = [render(body, facing_heading(f)) for f in range(FACINGS)]
    frames += [slow_rotor_frame(k) for k in range(8)]
    frames += [fast_rotor_frame(k) for k in range(4)]
    return frames


# ---- The Mobile Flak (FTRK) -----------------------------------------------------------------
# OpenRA vehicles.yaml FTRK (a Soviet anti-air truck: Turreted Offset
# -298,0,298, its guns at LocalOffset 512,0,192) and sequences/vehicles.yaml
# ftrk: idle (32 classic facings), turret (32 classic facings), the muzzle
# (Red Alert's gunfire.shp) and its cameo. Model: a three-axle army truck
# (hood, cab with glazing, flatbed with drop sides, six wheels) like the
# supply truck and the APC in size, with a twin 23 mm gun on a turntable on
# the bed. The turret frames draw the mount around its pivot, raised the 7
# pixels of the offset's height; the engine places them 298 world units
# (7 pixels) behind the truck's centre, as OpenRA does. Model z 0 is the
# ground, where the cast shadow falls.

TURRET_FWD = -298 * 24 / 1024
TURRET_UP = 298 * 24 / 1024


def ftrk_cab_mat(p, n):
    x, y, z = p
    if y > 8.0 and z > 6.7 and n[1] > 0.2:
        return ('glass', 0.05)  # windscreen
    if abs(n[0]) > 0.6 and 5.0 < y < 8.0 and 6.6 < z < 8.8:
        return ('glass', 0.0)  # side windows
    if n[1] > 0.6 and y > 11.6:
        if abs(abs(x) - 3.1) < 0.8 and 4.3 < z < 5.5:
            return ('yellow', 0.1)  # headlights
        return ('steel', -0.25)  # grille
    return ('team', 0.0)


def wheel_mat(p, n):
    return ('grey', -0.42) if abs(n[0]) < 0.6 else ('grey', -0.2)


def ftrk_body():
    # The cab with its sloped windscreen, and the lower hood in front of it:
    # two solids, as each must be convex (one profile of both had a concave
    # corner at the windscreen's foot, which cut the cab down to the hood).
    cab_side = [(4.2, 3.0), (9.6, 3.0), (9.6, 6.8), (8.4, 9.4), (4.6, 9.6), (4.2, 9.2)]
    cab_front = [(-4.6, 3.0), (4.6, 3.0), (4.6, 8.6), (3.8, 9.6), (-3.8, 9.6), (-4.6, 8.6)]
    cab = cut(prism('x', cab_side, -4.6, 4.6), prism('y', cab_front, 4.2, 9.6), mat=ftrk_cab_mat)
    hood_side = [(9.4, 3.0), (12.4, 3.0), (12.4, 5.8), (11.6, 6.6), (9.4, 6.9)]
    hood_top = [(-4.6, 9.4), (4.6, 9.4), (3.6, 12.4), (-3.6, 12.4)]
    hood = cut(prism('x', hood_side, -4.6, 4.6), prism('z', hood_top, 3.0, 6.9), mat=ftrk_cab_mat)
    chassis = box3(-3.2, 3.2, -11.6, 11.8, 1.6, 3.4, mat=('steel', -0.2))
    bed = box3(-4.8, 4.8, -12.4, 3.8, 3.4, 4.8, mat=lambda p, n: ('grey', -0.45) if n[2] > 0.6 else ('team', -0.06))
    sides = [box3(-4.8, -4.2, -12.4, 3.8, 4.8, 6.0, mat=('team', -0.02)), box3(4.2, 4.8, -12.4, 3.8, 4.8, 6.0, mat=('team', -0.02)),
             box3(-4.8, 4.8, -12.4, -11.8, 4.8, 6.0, mat=('team', -0.04)), box3(-4.8, 4.8, 3.2, 3.8, 4.8, 6.6, mat=('team', -0.04))]
    guards = [box3(side_x - 1.0, side_x + 1.0, 5.2, 9.8, 4.4, 5.0, mat=('team', -0.1)) for side_x in (-3.9, 3.9)]
    wheels = []
    for wy in (7.6, -3.4, -8.0):
        for side_x in (-3.9, 3.9):
            wheels.append(bar('x', (0.0, wy, 2.2), 2.2, side_x - 0.9, side_x + 0.9, mat=wheel_mat))
    jacks = [box3(side_x - 0.4, side_x + 0.4, -6.0, -5.2, 0.4, 3.6, mat=('steel', -0.1)) for side_x in (-5.0, 5.0)]
    ring = bar('z', (0.0, TURRET_FWD, 0.0), 3.0, 4.8, 5.4, mat=('steel', -0.05))
    return [cab, hood, chassis, bed] + sides + guards + wheels + jacks + [ring]


def ftrk_turret():
    """The gun mount around its pivot (z 0 is the turret's height on the body)."""
    base = bar('z', (0.0, 0.0, 0.0), 3.4, -1.8, -0.6, mat=('steel', 0.0))
    cradle = cut(
        prism('x', [(-3.0, -0.6), (2.6, -0.6), (3.0, 0.6), (1.4, 2.2), (-3.0, 2.0)], -2.6, 2.6),
        prism('z', [(-2.6, -3.0), (2.6, -3.0), (2.6, 2.0), (1.6, 3.0), (-1.6, 3.0), (-2.6, 2.0)], -0.6, 2.2),
        mat=('team', 0.0),
    )
    boxes = [box3(side_x - 0.7, side_x + 0.7, -1.6, 1.2, -0.2, 1.6, mat=('drab', -0.05)) for side_x in (-3.2, 3.2)]
    barrels = []
    for side_x in (-0.9, 0.9):
        barrels.append(bar('y', (side_x, 0.0, 0.0), 0.45, 0.0, 9.4, mat=('steel', -0.1)).moved(pitch=20.0, t=(0.0, 2.0, 1.2)))
        barrels.append(bar('y', (side_x, 0.0, 0.0), 0.62, 8.2, 9.6, mat=('steel', 0.0)).moved(pitch=20.0, t=(0.0, 2.0, 1.2)))
    gunner = [box3(-2.2, -0.6, -2.9, -1.7, 0.6, 2.6, mat=('drab', 0.0)), ellipsoid(-1.4, -2.2, 3.3, 0.85, 0.85, 0.85, mat=('drab', 0.1))]
    sight = box3(0.9, 1.6, -0.4, 0.8, 2.0, 3.2, mat=('steel', -0.1))
    return [base, cradle] + boxes + barrels + gunner + [sight]


def ftrk_frames():
    body = ftrk_body()
    turret = ftrk_turret()
    frames = [render(body, facing_heading(f), ground=0.0) for f in range(FACINGS)]
    frames += [render(turret, facing_heading(f), lift=TURRET_UP) for f in range(FACINGS)]
    return frames


# ---- Cameos ---------------------------------------------------------------------------------
# Red Alert's sidebar pictures are 64 x 48 pixel renders of the unit, larger
# than in the field, turned to show its front and left side, lit from the
# top left over a dark ground, in their own colours (the owner's colour is
# not applied: the painted parts are olive drab here). The sidebar adds the
# name (they do not have it in the picture).

CAMEO_W, CAMEO_H = 64, 48


def drab(solids):
    """The solids with the owner's colour painted olive drab (cameos keep their colours)."""
    out = []
    for s in solids:
        m = s.mat

        def paint(p, n, m=m):
            ramp, change = m(p, n) if callable(m) else m
            return ('drab', change) if ramp == 'team' else (ramp, change)

        out.append(s.paint(paint))
    return out


def cameo(solids, heading, zoom, centre, ground, extra=()):
    """A cameo: the backdrop, the unit's cast shadow and the unit at `centre` (screen pixels)."""
    rng = Rng(0xCA3E0)
    px = [0] * (CAMEO_W * CAMEO_H)
    horizon = 15
    for y in range(CAMEO_H):
        for x in range(CAMEO_W):
            if y < horizon:
                # Haze over the horizon.
                s = 1 + (1 if (x + y) % 2 and y > horizon - 5 else 0)
                px[y * CAMEO_W + x] = c('steel', s)
            else:
                f = (y - horizon) / (CAMEO_H - horizon)
                s = 1 + int(f * 2.6 + BAYER[y % 2][x % 2] * 0.9)
                if rng.next() < 0.08:
                    s += rng.int(-1, 1)
                px[y * CAMEO_W + x] = c('dirt', max(0, min(3, s)))
    for x in range(CAMEO_W):
        px[horizon * CAMEO_W + x] = c('steel', 3)
    unit = render(solids, heading, zoom=zoom, ground=ground)
    for layer in (unit,) + tuple(extra):
        for (x, y), v in layer.items():
            x += centre[0]
            y += centre[1]
            if 0 <= x < CAMEO_W and 0 <= y < CAMEO_H:
                if v == SHADOW:
                    old = px[y * CAMEO_W + x]
                    # A shadow darkens the ground two shades (cameos are opaque).
                    for ramp, idx in IDX.items():
                        if old in idx:
                            px[y * CAMEO_W + x] = c(ramp, idx.index(old) - 2)
                            break
                else:
                    px[y * CAMEO_W + x] = v
    # A dark rim around the picture, lit on the top and the left.
    for x in range(CAMEO_W):
        px[x] = c('steel', 4)
        px[(CAMEO_H - 1) * CAMEO_W + x] = c('steel', 0)
    for y in range(CAMEO_H):
        px[y * CAMEO_W] = c('steel', 4)
        px[y * CAMEO_W + CAMEO_W - 1] = c('steel', 0)
    return [CAMEO_W, CAMEO_H, base64.b64encode(bytes(px)).decode('ascii')]


def mh60_cameo():
    zoom = 1.3
    heading = 232.0
    # Hovering a little over its shadow, the rotor stopped mid-turn.
    return cameo(drab(mh60_model()) + rotor_model(20.0), heading, zoom, (31, 26), ground=-7.5)


def ftrk_cameo():
    zoom = 1.6
    heading = 232.0
    body = drab(ftrk_body())
    # The guns turned to the left, raised to the sky, the mount on its pivot.
    turret = [s.moved(yaw=-50.0, t=(0.0, TURRET_FWD, TURRET_UP)) for s in drab(ftrk_turret())]
    return cameo(body + turret, heading, zoom, (34, 28), ground=0.0)


def canvas_frame(cv):
    """A derrick canvas as a frame centred on it."""
    px = {(x - cv.w // 2, y - cv.h // 2): v for y in range(cv.h) for x in range(cv.w) if (v := cv.px[y * cv.w + x])}
    return pixels_frame(px)


def checked(aid, frames, allowed):
    for k, f in enumerate(frames):
        bad = set(base64.b64decode(f[-1])) - allowed
        if bad:
            raise SystemExit(f'{aid} frame {k}: indices outside the palette: {sorted(bad)}')
    return frames


def main():
    allowed = valid_indices()
    art = {
        'OILB': {
            # The frames are the 2x2 footprint, centred on it.
            'offset': [0, 0],
            'body': {'idle': {'start': 0}, 'damaged': {'start': 1}},
            'frames': checked('OILB', [canvas_frame(derrick_frame(False)), canvas_frame(derrick_frame(True))], allowed),
        },
        'LROD': {
            # The frames sit on the 1x1 footprint, centred on it; the mast rises above it.
            'offset': [0, 0],
            # OpenRA's ^Building: idle, damaged-idle and the make sequence
            # (WithMakeAnimation, at the default 40 ms per frame).
            'body': {'idle': {'start': 0}, 'damaged': {'start': 1}, 'make': {'start': 2, 'length': len(LROD_MAKE)}},
            'frames': checked('LROD', lrod_frames(), allowed),
            'cameo': checked('LROD cameo', [lrod_cameo()], allowed)[0],
        },
        'MH60': {
            'offset': [0, 0],
            'body': {'idle': {'start': 0, 'facings': FACINGS}},
            # The rotor (the second slot): slow on the ground (idle), blurred in the air (move).
            'second': {'idle': {'start': FACINGS, 'length': 8}, 'move': {'start': FACINGS + 8, 'length': 4}},
            'frames': checked('MH60', [pixels_frame(px) for px in mh60_frames()], allowed),
            'cameo': checked('MH60 cameo', [mh60_cameo()], allowed)[0],
        },
        'FTRK': {
            'offset': [0, 0],
            'body': {'idle': {'start': 0, 'facings': FACINGS}},
            'second': {'idle': {'start': FACINGS, 'facings': FACINGS}},
            'frames': checked('FTRK', [pixels_frame(px) for px in ftrk_frames()], allowed),
            'cameo': checked('FTRK cameo', [ftrk_cameo()], allowed)[0],
        },
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
        ' * Per actor id: { offset: [x, y] (the frames\' origin relative to the footprint',
        ' * centre), frames: [[left, top, width, height, base64 palette indices]] (left and',
        ' * top relative to the origin), body and second: { pose: { start, length?,',
        ' * facings?, tick? } } (an OpenRA sequence over `frames`: facings anticlockwise',
        ' * from north, even steps), cameo?: [width, height, base64] (opaque) }.',
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
