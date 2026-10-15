#!/usr/bin/env python3
"""Generate apps/game/js/art/pixel-data.js: WebRA's own pixel art.

Some actors have no Red Alert art at all: OpenRA drew theirs itself (its own
files, data/source/bits.txt), and WebRA never ships those (data/CATALOG.md).
For some of them WebRA draws its own pixel art in Red Alert's style instead
of the vector art of apps/game/js/art: 8-bit frames at one pixel per world
pixel, rendered from simple 3D models (convex solids) by a small ray caster
with one light from the top left, the way Westwood rendered its units, and
for structures in Westwood's structure view (a 3/4 view from the south,
volumes extruded straight up, the ground not shortened), with cast shadows
to the bottom right and dark rims on the shaded sides. The models are code,
so the art is reproducible and reviewable. Nothing here is taken from
Westwood's or OpenRA's files: the palette and every pixel are WebRA's own.

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

Art (the owner's "variant B" of the design canvas, page "Red Alert
original"):
- OILB, the oil derrick (OpenRA civilian.yaml OILB: a 2x2 tech building
  that pays its owner while captured), idle and damaged: a pumpjack and a
  storage tank in the owner's colour on a concrete pad. See "The oil
  derrick" below.
- MH60, the Black Hawk, and FTRK, the Mobile Flak: OpenRA's own units,
  drawn from its own mh60.shp, yrotorlg.shp, ftrk.shp and their icons.
  Here: 32 facings each, the rotor and the turret as OpenRA's sequences
  have them, and cameos. The Black Hawk has stub wings with rocket pods,
  the Mobile Flak an armoured quad-gun turret with a search radar.
- LROD, the Lightning Rod: WebRA's own structure (data/webra/rules.yaml),
  so neither Red Alert nor OpenRA has art for it: idle, damaged, a twelve
  frame make animation and a cameo. See "The Lightning Rod" below.

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


# ---- Randomness ---------------------------------------------------------------------------


class Rng:
    """A small deterministic generator (LCG), so the art never changes between runs."""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF or 1

    def next(self):
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0

    def int(self, lo, hi):
        return lo + int(self.next() * (hi - lo + 1))


# ---- 3D models rendered facing by facing ---------------------------------------------------
# Westwood rendered its vehicles and aircraft from 3D models, one frame per
# facing, lit from the top left and anti-aliased against black (which leaves
# the dark rims of Red Alert's units). Here, too: each piece is a handful of
# convex solids (prisms cut from side, front and top views, ellipsoids and
# cylinders) that a small ray caster renders per facing with the same light,
# so the frames turn smoothly and every facing is drawn, none mirrored. The
# structures are built and lit the same way (see "Structures" below).
#
# Model space: x to the right of the unit, y forward, z up, one world pixel
# per unit. World space: x east, y south, z up. Units are projected like
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

    def __init__(self, planes, box, quad=None, mat=('grey', 0.0), frame=(IDENTITY, (0.0, 0.0, 0.0)), shadow=True, receives=False):
        self.planes = list(planes)
        self.box = box  # local bounds (x0, x1, y0, y1, z0, z1)
        self.quad = quad
        self.mat = mat
        self.frame = frame
        self.shadow = shadow
        self.receives = receives  # other solids' cast shadows darken it (a structure's pad)

    def _with(self, mat=None, frame=None, shadow=None, receives=None):
        return Solid(self.planes, self.box, self.quad, self.mat if mat is None else mat, self.frame if frame is None else frame,
                     self.shadow if shadow is None else shadow, self.receives if receives is None else receives)

    def moved(self, yaw=0.0, pitch=0.0, t=(0.0, 0.0, 0.0)):
        """The solid turned (pitch, then yaw) about the model origin, then moved by t."""
        r = rot(yaw, pitch)
        (r0, t0) = self.frame
        rr = tuple(tuple(sum(r[i][k] * r0[k][j] for k in range(3)) for j in range(3)) for i in range(3))
        tt = tuple(sum(r[i][k] * t0[k] for k in range(3)) + t[i] for i in range(3))
        return self._with(frame=(rr, tt))

    def paint(self, mat):
        return self._with(mat=mat)

    def no_shadow(self):
        return self._with(shadow=False)

    def receiving(self):
        return self._with(receives=True)

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


def beam(p0, p1, r, mat=('grey', 0.0)):
    """A round bar of radius r from the model point p0 to p1 (any direction):
    a bar along local z placed by a rotation built from the direction alone
    (square roots, no trigonometry, so the same bits on every platform)."""
    d = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    length = math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
    z = (d[0] / length, d[1] / length, d[2] / length)
    # Local x: horizontal and square to the beam (east for a vertical one).
    h = math.sqrt(z[0] * z[0] + z[1] * z[1])
    x = (z[1] / h, -z[0] / h, 0.0) if h > 1e-9 else (1.0, 0.0, 0.0)
    y = (z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0])
    rows = ((x[0], y[0], z[0]), (x[1], y[1], z[1]), (x[2], y[2], z[2]))
    return bar('z', (0.0, 0.0, 0.0), r, 0.0, length, mat)._with(frame=(rows, tuple(p0)))


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

    def __init__(self, solids, heading, zoom=1.0, lift=0.0, ys=PITCH):
        self.solids = solids
        self.zoom = zoom
        self.lift = lift  # model z added (a turret's height on its body)
        self.ys = ys  # screen pixels per world pixel southwards: PITCH (units) or 1 (structures)
        self.c, self.s = dcos(heading), dsin(heading)
        # Cast shadows fall the same way on the screen in both projections.
        self.light = LIGHT if ys == PITCH else (LIGHT[0], LIGHT[1] * PITCH / ys, LIGHT[2])

    def to_model(self, v, point):
        """World -> model (an orthogonal mapping that is its own inverse)."""
        z = v[2] - self.lift if point else v[2]
        return (v[0] * self.c + v[1] * self.s, v[0] * self.s - v[1] * self.c, z)

    def to_world(self, v):
        return (v[0] * self.c + v[1] * self.s, v[0] * self.s - v[1] * self.c, v[2])

    def screen(self, p):
        w = self.to_world((p[0], p[1], p[2] + self.lift))
        return (w[0] * self.zoom, (w[1] * self.ys - w[2]) * self.zoom)

    def bounds(self, solid):
        pts = [self.screen(p) for p in solid.corners()]
        return (min(p[0] for p in pts), max(p[0] for p in pts), min(p[1] for p in pts), max(p[1] for p in pts))

    def ground_bounds(self, solid, ground):
        """Screen bounds of a solid's cast shadow on the ground (height `ground`)."""
        out = []
        for p in solid.corners():
            w = self.to_world((p[0], p[1], p[2] + self.lift))
            k = (w[2] - ground) / self.light[2]
            g = (w[0] - k * self.light[0], w[1] - k * self.light[1], ground)
            out.append((g[0] * self.zoom, (g[1] * self.ys - g[2]) * self.zoom))
        return (min(p[0] for p in out), max(p[0] for p in out), min(p[1] for p in out), max(p[1] for p in out))

    def trace(self, sx, sy, candidates):
        """The nearest solid under the screen point: (solid, model point, model normal, world normal) or None."""
        x = sx / self.zoom
        y = sy / self.zoom
        o = self.to_model((x, 60.0, self.ys * 60.0 - y), True)
        d = self.to_model((0.0, -1.0, -self.ys), False)
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
        y = (sy / self.zoom + ground) / self.ys
        o = self.to_model((x, y, ground), True)
        d = self.to_model(self.light, False)
        return any(s.hit(o, d) and s.hit(o, d)[0] > 1e-6 for s in candidates)

    def blocked(self, p, solid, candidates):
        """Whether another solid shades the model point p (on `solid`) from the light."""
        d = self.to_model(self.light, False)
        for s in candidates:
            if s is not solid:
                h = s.hit(p, d)
                if h and h[0] > 1e-6:
                    return True
        return False


def material(solid, p, n):
    m = solid.mat
    return m(p, n) if callable(m) else m


# A receiving surface in another solid's shadow keeps this much of its light:
# about what Red Alert's shadow index leaves of the ground under it.
RECEIVED_SHADOW = 0.5


def render(solids, heading, zoom=1.0, lift=0.0, ground=None, samples=3, rim=True, ys=PITCH):
    """Pixels {(x, y): palette index} of `solids` at `heading` (pixel (x, y)
    covers screen x..x+1, y..y+1, the origin is the model's origin on the
    screen). `ground` is the height cast shadows fall on (None: no shadow);
    solids that `receives` are darkened where others shade them. `ys`: the
    projection (PITCH for units, 1 for structures)."""
    shot = Shot(solids, heading, zoom, lift, ys)
    casting = [s for s in solids if s.shadow]
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
                    light = brightness(nw)
                    if s.receives and shot.blocked(p, s, casting):
                        light *= RECEIVED_SHADOW
                    k[1] += light + change
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
# the stabilator low on the fin, door guns, wheels; stub wings in the
# owner's colour with a rocket pod (red nose) under each tip, the cabin
# doors slid open (dark) and a refuelling probe along the nose's right side.
# About 32 pixels from nose to tail like the Longbow and the Hind. Model z 0 is the middle of
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
    # The open cabin doors: dark openings just proud of the sides.
    doors = [box3(side_x - 0.08, side_x + 0.08, -3.8, -0.4, -1.8, 2.4, mat=('grey', -0.45)) for side_x in (-4.05, 4.05)]
    # Stub wings across the cabin's back, a rocket pod under each tip.
    wing = box3(-11.5, 11.5, -2.6, 0.8, 0.4, 1.2, mat=('team', -0.05))
    pods = [bar('y', (side_x, 0.0, 0.2), 1.35, -4.2, 2.2, mat=('drab', 0.1)) for side_x in (-10.8, 10.8)]
    pod_noses = [bar('y', (side_x, 0.0, 0.2), 0.6, 2.0, 2.8, mat=('red', 0.0)) for side_x in (-10.8, 10.8)]
    probe = bar('y', (1.6, 0.0, 1.0), 0.25, 11.0, 15.0, mat=('steel', 0.0))
    return ([cabin, boom, fin, stab, tail_rotor, tail_hub, mast, hub_fairing] + engines + exhausts + guns + gun_mounts + wheels + struts
            + [tail_wheel] + doors + [wing] + pods + pod_noses + [probe])


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
# supply truck and the APC in size, with an armoured quad-gun turret on a
# turntable on the bed: an angled housing in the owner's colour, four
# barrels raised 35 degrees, a search radar on a mast behind and a hatch. The turret frames draw the mount around its pivot, raised the 7
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
    """The gun turret around its pivot (z 0 is the turret's height on the body)."""
    base = bar('z', (0.0, 0.0, 0.0), 3.6, -1.8, -0.6, mat=('steel', 0.0))
    housing = prism('x', [(-3.4, -0.6), (2.6, -0.6), (3.4, 1.2), (1.8, 3.0), (-3.4, 2.8)], -3.0, 3.0, mat=('team', 0.02))
    barrels = []
    for side_x in (-1.7, -0.6, 0.6, 1.7):
        barrels.append(bar('y', (side_x, 0.0, 0.0), 0.38, 0.0, 8.8, mat=('steel', -0.1)).moved(pitch=35.0, t=(0.0, 2.2, 1.4)))
        barrels.append(bar('y', (side_x, 0.0, 0.0), 0.55, 7.8, 9.0, mat=('steel', 0.05)).moved(pitch=35.0, t=(0.0, 2.2, 1.4)))
    radar_mast = bar('z', (0.0, -3.0, 0.0), 0.35, 2.8, 4.2, mat=('steel', 0.0))
    dish = ellipsoid(0.0, -3.0, 4.8, 2.6, 0.55, 1.6, mat=('grey', 0.25))
    hatch = box3(-2.4, -0.8, -2.4, -0.8, 2.8, 3.2, mat=('drab', 0.0))
    return [base, housing] + barrels + [radar_mast, dish, hatch]


def ftrk_frames():
    body = ftrk_body()
    turret = ftrk_turret()
    frames = [render(body, facing_heading(f), ground=0.0) for f in range(FACINGS)]
    frames += [render(turret, facing_heading(f), lift=TURRET_UP) for f in range(FACINGS)]
    return frames


# ---- Structures ------------------------------------------------------------------------------
# Westwood drew its structures one pixel per world pixel with the ground not
# shortened (Red Alert's map cells are 24 x 24 pixels on screen) and the
# volumes extruded straight up: the same models and light as the units,
# rendered at heading 0 with ys = 1, so a footprint fills its cells. Cast
# shadows fall the same way on the screen as the units' (Shot.light). On
# the structure's own pad they darken the concrete (the pad `receives`
# them): Red Alert's shadow index can only darken what lies under a sprite,
# not the sprite's own pixels. Past the pad they are the shadow index.
# Heading 0: model x is east, model y north.

STRUCTURE_YS = 1.0


def structure_frame(solids, clip):
    """The pixels of a structure's solids, cut to the box `clip` (x0, x1,
    y0, y1, screen pixels around the footprint's centre, ends excluded)."""
    x0, x1, y0, y1 = clip
    px = render(solids, 0.0, ground=0.0, ys=STRUCTURE_YS)
    return {(x, y): v for (x, y), v in px.items() if x0 <= x < x1 and y0 <= y < y1}


def scorch(px, spots, rng):
    """Scorch marks (screen x, y, radius): blackened in the middle, soot around."""
    for sx, sy, r in spots:
        for y in range(sy - r, sy + r + 1):
            for x in range(sx - r, sx + r + 1):
                v = px.get((x, y))
                if v is None or v == SHADOW:
                    continue
                d = math.sqrt((x - sx) * (x - sx) + (y - sy) * (y - sy)) / r
                if d > 1 or rng.next() < d * 0.35:
                    continue
                px[(x, y)] = c('oil', rng.int(0, 1)) if d < 0.45 else c('grey', rng.int(1, 3))


def rubble(px, count, area, rng):
    """Chunks of concrete and steel on the concrete in `area` (x0, x1, y0, y1, inclusive)."""
    concrete = set(IDX['grey'][4:])
    for _ in range(count):
        x, y = rng.int(area[0], area[1]), rng.int(area[2], area[3])
        if px.get((x, y)) in concrete:
            px[(x, y)] = c('grey', rng.int(2, 9))
            if rng.next() < 0.5 and px.get((x + 1, y), SHADOW) != SHADOW:
                px[(x + 1, y)] = c('grey', 1)


def checker(ramp, size, x0, y0, dark=-0.1):
    """A material of square slabs: every other one `dark` shades darker."""
    return lambda p, n: (ramp, dark) if (int(p[0] - x0) // size + int(p[1] - y0) // size) % 2 else (ramp, 0.0)


# ---- The Lightning Rod (LROD) ------------------------------------------------------------------
# WebRA's own 1x1 structure (data/webra/rules.yaml), about two cells high on
# screen (its Selectable DecorationBounds 1024, 2048, 0, -512: the top some
# 36 pixels above the cell's centre). OpenRA's ^Building sequences: idle,
# damaged-idle and make (WithMakeAnimation, played once when placed). Model:
# a concrete pad of large slabs with hazard markings at the front corners, a
# plinth with the owner's colour band, a tall tapered steel mast in
# alternating bands with two copper corona rings, a porcelain insulator, a
# copper rod with a copper ball and four points on top, and a copper down
# conductor from the rod's foot down the mast and the plinth to a clamp on
# the pad. Damaged: the mast bent over to the east above the lower ring, the
# points gone and the ball scorched, the conductor snapped, the plinth's
# corner knocked off and cracked, scorch marks and rubble. Make: twelve
# frames from bare earth through the poured pad, the plinth and the rising
# mast to the points (the idle frame adds the conductor).

LROD_PAD = 11.0  # half the pad's side
LROD_PAD_TOP = 1.2
PLINTH_TOP = 5.0
LROD_MAST_TOP = 25.0
LROD_BREAK = 17.0  # where the damaged mast bends
LROD_RINGS = [(11.6, 12.4, 3.4), (19.0, 19.6, 2.6)]  # corona rings: z0, z1, radius
# The frames' box around the cell's centre: the cell with room above for the
# mast and to the right and below for the cast shadow.
LROD_CLIP = (-12, 48, -44, 24)
# The make (build-up) animation, a stage per frame: pad (0 bare earth, 1
# formwork and half poured, 2 done), the plinth's height over the pad, the
# mast's top (0 none) and the top (0 none, 1 the insulator, 2 the rod and
# ball, 3 the points).
LROD_MAKE = [
    (0, 0.0, 0.0, 0),
    (1, 0.0, 0.0, 0),
    (2, 0.0, 0.0, 0),
    (2, 1.9, 0.0, 0),
    (2, PLINTH_TOP - LROD_PAD_TOP, 0.0, 0),
    (2, PLINTH_TOP - LROD_PAD_TOP, 9.0, 0),
    (2, PLINTH_TOP - LROD_PAD_TOP, 13.0, 0),
    (2, PLINTH_TOP - LROD_PAD_TOP, 17.0, 0),
    (2, PLINTH_TOP - LROD_PAD_TOP, 22.0, 0),
    (2, PLINTH_TOP - LROD_PAD_TOP, LROD_MAST_TOP, 1),
    (2, PLINTH_TOP - LROD_PAD_TOP, LROD_MAST_TOP, 2),
    (2, PLINTH_TOP - LROD_PAD_TOP, LROD_MAST_TOP, 3),
]


def lrod_taper(z):
    """The mast's half width at height z."""
    return 3.2 - 2.2 * (z - PLINTH_TOP) / (LROD_MAST_TOP - PLINTH_TOP)


def lattice_mat(p, n):
    return ('steel', -0.3 if int(p[2] / 2.4) % 2 else 0.05)


def lrod_mast(z0, z1, mat=lattice_mat):
    """The tapered mast from height z0 to z1."""
    poly = [(-lrod_taper(z0), z0), (lrod_taper(z0), z0), (lrod_taper(z1), z1), (-lrod_taper(z1), z1)]
    return cut(prism('x', poly, -3.2, 3.2), prism('y', poly, -3.2, 3.2), mat=mat)


def lrod_pad(stage):
    p = LROD_PAD
    earth = lambda q, n: ('dirt', -0.12 if (int(q[0] + p) * 7 + int(q[1] + p) * 3) % 5 == 0 else 0.0)
    if stage == 0:
        return [box3(-p, p, -p, p, 0.0, 0.3, mat=earth).receiving()]
    if stage == 1:
        # Formwork boards round the pad, the back half poured (wet and dark).
        w = 0.8
        return [
            box3(-p, p, -p, p, 0.0, 0.3, mat=earth).receiving(),
            box3(-p + w, p - w, 0.0, p - w, 0.0, 0.9, mat=('grey', -0.4)).receiving(),
            box3(-p, p, p - w, p, 0.0, LROD_PAD_TOP, mat=('rust', 0.05)),
            box3(-p, p, -p, -p + w, 0.0, LROD_PAD_TOP, mat=('rust', 0.0)),
            box3(-p, -p + w, -p + w, p - w, 0.0, LROD_PAD_TOP, mat=('rust', 0.05)),
            box3(p - w, p, -p + w, p - w, 0.0, LROD_PAD_TOP, mat=('rust', 0.0)),
        ]
    return [
        box3(-p, p, -p, p, 0.0, LROD_PAD_TOP, mat=checker('grey', 6, -p, -p)).receiving(),
        box3(-9.0, -6.5, -9.5, -7.0, LROD_PAD_TOP, 2.0, mat=('yellow', 0.0)),
        box3(6.5, 9.0, -9.5, -7.0, LROD_PAD_TOP, 2.0, mat=('yellow', 0.0)),
    ]


def lrod_plinth(height, chipped=False):
    """The plinth; its band in the owner's colour once it is cast to its full height."""
    top = LROD_PAD_TOP + height
    band = top >= PLINTH_TOP

    def mat(p, n):
        if band and 2.4 < p[2] < 3.8 and abs(n[2]) < 0.5:
            return ('team', 0.0)
        return ('grey', 0.05)

    if chipped:
        # The north east corner knocked off.
        return cut(box3(-5.0, 5.0, -5.0, 5.0, LROD_PAD_TOP, top), prism('z', [(-5.0, -5.0), (5.0, -5.0), (5.0, 2.6), (2.6, 5.0), (-5.0, 5.0)], LROD_PAD_TOP, top), mat=mat)
    return box3(-5.0, 5.0, -5.0, 5.0, LROD_PAD_TOP, top, mat=mat)


def lrod_top(stage, z, ball=('copper', 0.15)):
    """The insulator on the mast's top at height z and (stage 2) the rod and the ball, (3) the points."""
    out = [ellipsoid(0.0, 0.0, z + 1.0, 1.5, 1.5, 1.2, mat=('grey', 0.3))]
    if stage >= 2:
        out.append(bar('z', (0.0, 0.0, 0.0), 0.6, z + 1.0, z + 6.0, mat=('copper', 0.1)))
        out.append(ellipsoid(0.0, 0.0, z + 6.4, 1.5, 1.5, 1.5, mat=ball))
    if stage >= 3:
        # Four points round the ball, standing clear above it.
        for (px, py), r in [((1.9, 0.0), 0.5), ((-1.9, 0.0), 0.5), ((0.0, 1.6), 0.55), ((0.0, -1.6), 0.55)]:
            out.append(bar('z', (px, py, 0.0), r, z + 6.0, z + 9.6, mat=('copper', 0.2)))
    return out


def lrod_conductor(snapped=False):
    """The copper down conductor: from the rod's foot down the mast's south
    face, over and down the plinth to a clamp on the pad. Snapped: only its
    lower end, the loose end hanging off the mast."""
    r = 0.45
    mat = ('copper', -0.05)
    foot = (2.3, -3.7, PLINTH_TOP + r)
    corner = (3.4, -5.4, PLINTH_TOP + r)
    low = (3.4, -5.4, LROD_PAD_TOP + r)
    clamp = (4.2, -8.7, LROD_PAD_TOP + r)
    out = [beam(foot, corner, r, mat), beam(corner, low, r, mat), beam(low, clamp, r, mat),
           box3(3.4, 5.0, -9.4, -8.0, LROD_PAD_TOP, 2.3, mat=('copper', 0.1))]
    if snapped:
        stub = (1.7, -2.9, 12.0)
        out += [beam(foot, stub, r, mat), beam(stub, (3.6, -5.1, 8.4), r, ('copper', -0.2))]
    else:
        out.append(beam((0.6, -1.5, LROD_MAST_TOP + 0.6), foot, r, mat))
    return out


def lrod_model(make=None, damaged=False):
    """The Lightning Rod's solids: idle (make None), damaged, or the make stage `make` (LROD_MAKE)."""
    pad, plinth, mast, top = make if make else (2, PLINTH_TOP - LROD_PAD_TOP, LROD_MAST_TOP, 3)
    solids = lrod_pad(pad)
    if plinth:
        solids.append(lrod_plinth(plinth, chipped=damaged))
    if damaged:
        solids.append(lrod_mast(PLINTH_TOP, LROD_BREAK))
        solids += [bar('z', (0.0, 0.0, 0.0), r, z0, z1, mat=('copper', 0.0)) for z0, z1, r in LROD_RINGS if z1 <= LROD_BREAK]
        # The section above bent over to the east about its east edge, the points broken off, the ball scorched.
        bent = [lrod_mast(LROD_BREAK, LROD_MAST_TOP, mat=('steel', -0.1))]
        bent += [bar('z', (0.0, 0.0, 0.0), r, z0, z1, mat=('copper', -0.1)) for z0, z1, r in LROD_RINGS if z0 >= LROD_BREAK]
        bent += lrod_top(2, LROD_MAST_TOP, ball=('copper', -0.35))
        pivot = (lrod_taper(LROD_BREAK), 0.0, LROD_BREAK)
        solids += [s.moved(t=(-pivot[0], 0.0, -pivot[2])).moved(yaw=90.0, pitch=62.0, t=pivot) for s in bent]
        solids += lrod_conductor(snapped=True)
        return solids
    if mast:
        solids.append(lrod_mast(PLINTH_TOP, mast))
        solids += [bar('z', (0.0, 0.0, 0.0), r, z0, z1, mat=('copper', 0.0)) for z0, z1, r in LROD_RINGS if z1 <= mast]
    if top:
        solids += lrod_top(top, LROD_MAST_TOP)
    if make is None:
        solids += lrod_conductor()
    return solids


def lrod_frames():
    """Idle, damaged, then the make sequence."""
    idle = structure_frame(lrod_model(), LROD_CLIP)
    damaged = structure_frame(lrod_model(damaged=True), LROD_CLIP)
    rng = Rng(0x120D + 7)
    scorch(damaged, [(-7, -8, 3), (7, 8, 3), (0, 7, 3), (8, -7, 2), (-8, 6, 2)], rng)
    # A crack down the plinth's roof and south face.
    for x, y in [(-2, -9), (-2, -8), (-1, -7), (-1, -6), (0, -5), (0, -4), (1, -3), (1, -2), (0, -1), (0, 0), (1, 1), (1, 2), (2, 3)]:
        if damaged.get((x, y), SHADOW) != SHADOW:
            damaged[(x, y)] = c('grey', 1)
    rubble(damaged, 12, (-11, 11, -12, 11), rng)
    return [pixels_frame(idle), pixels_frame(damaged)] + [pixels_frame(structure_frame(lrod_model(make=m), LROD_CLIP)) for m in LROD_MAKE]


def lrod_cameo():
    """The cameo: the rod over its pad, seen from the front left (its own colours)."""
    return cameo(drab(lrod_model()), 200.0, 0.85, (32, 44), ground=0.0)


# ---- The oil derrick (OILB) ----------------------------------------------------------------------
# OpenRA civilian.yaml OILB: a 2x2 tech building that pays its owner while
# captured. OpenRA draws it from its own oilb.shp: idle (one frame) and
# damaged-idle (WithSpriteBody), no make, bib or death animation. Model: a
# concrete pad of large slabs, a pumpjack over the well at the back (a
# yellow walking beam on its samson post, the horse head over the polished
# rod, a rusty counterweight and motor at the far end), a pool of crude by
# the well, a large storage tank in front with a band in the owner's colour,
# a smaller tank behind it, a pipe and three red oil drums. Damaged: the
# beam broken off its post and tipped forward onto the well, the polished rod gone,
# a hole torn in the tank's roof, a drum knocked over, the pad's corner
# broken off, scorch marks and rubble.

OILB_CLIP = (-24, 24, -24, 24)  # the 2x2 footprint


def oilb_model(damaged):
    def pad_mat(p, n):
        if n[2] > 0.5 and (p[0] + 6.0) * (p[0] + 6.0) + (p[1] - 4.0) * (p[1] - 4.0) < 30.0:
            return ('oil', 1)
        return checker('grey', 8, -22.0, -22.0, -0.05)(p, n)

    def tank_mat(p, n):
        if damaged and n[2] > 0.5:
            d = (p[0] - 12.0) * (p[0] - 12.0) + (p[1] + 6.5) * (p[1] + 6.5)
            if d < 5.0:
                return ('oil', 0.0)  # the hole
            if d < 9.0:
                return ('grey', 0.45)  # its bent edge, catching the light
        if 8.0 < p[2] < 10.0 and abs(n[2]) < 0.5:
            return ('team', 0.0)
        return ('grey', 0.1)

    pad = box3(-22.0, 22.0, -22.0, 22.0, 0.0, 1.0, mat=pad_mat)
    if damaged:
        # The south east corner broken off.
        pad = cut(pad, prism('z', [(-22.0, -22.0), (16.0, -22.0), (22.0, -16.0), (22.0, 22.0), (-22.0, 22.0)], 0.0, 1.0))
    # The walking beam and the horse head, pivoting on the samson post's top.
    beam_parts = [
        box3(-20.0, 1.5, 3.0, 5.0, 14.0, 16.0, mat=('yellow', 0.0)),
        prism('x', [(2.4, 10.0), (5.6, 10.0), (5.6, 17.5), (2.4, 17.5)], 1.5, 4.5, mat=('yellow', 0.05)),
    ]
    if damaged:
        # Off its post: the rear end on the counterweight, the head down on the well.
        pivot = (-20.0, 0.0, 14.0)
        beam_parts = [s.moved(t=(-pivot[0], 0.0, -pivot[2])).moved(yaw=-90.0).moved(yaw=90.0, pitch=22.0, t=pivot) for s in beam_parts]
    solids = [
        pad.receiving(),
        box3(-19.0, -1.0, 1.5, 6.5, 1.0, 3.0, mat=('steel', -0.1)),  # the skid
        box3(-19.5, -14.0, 1.5, 6.5, 3.0, 9.0, mat=('rust', 0.0)),  # motor and counterweight
        prism('x', [(1.8, 3.0), (6.2, 3.0), (4.6, 14.5), (3.4, 14.5)], -11.5, -8.5, mat=('steel', 0.0)),  # samson post
        bar('z', (3.0, 4.0, 0.0), 1.4, 1.0, 3.5, mat=('steel', -0.1)),  # wellhead
        bar('x', (0.0, -2.0, 2.2), 0.8, 3.0, 12.0, mat=('steel', -0.05)),  # pipe to the tank
        bar('z', (14.0, 10.0, 0.0), 4.5, 1.0, 8.0, mat=('grey', 0.15)),  # small tank
        bar('z', (10.0, -9.0, 0.0), 8.5, 1.0, 13.0, mat=tank_mat),  # storage tank
        bar('z', (10.0, -9.0, 0.0), 1.5, 13.0, 14.2, mat=('steel', 0.0)),  # its roof vent
        bar('z', (-14.0, -13.0, 0.0), 1.7, 1.0, 5.4, mat=('red', 0.0)),
        bar('z', (-10.2, -15.0, 0.0), 1.7, 1.0, 5.4, mat=('red', -0.05)),
        box3(-20.0, -16.0, -20.0, -17.0, 1.0, 2.0, mat=('yellow', 0.0)),
    ] + beam_parts
    if damaged:
        solids.append(bar('x', (0.0, -9.4, 2.7), 1.7, -14.6, -10.2, mat=('red', 0.05)))  # the drum on its side
    else:
        solids.append(bar('z', (3.0, 4.0, 0.0), 0.4, 3.5, 11.0, mat=('steel', 0.1)))  # polished rod
        solids.append(bar('z', (-12.0, -9.6, 0.0), 1.7, 1.0, 5.4, mat=('red', 0.05)))
    return solids


def oilb_frames():
    idle = structure_frame(oilb_model(False), OILB_CLIP)
    damaged = structure_frame(oilb_model(True), OILB_CLIP)
    rng = Rng(0x0111B + 7)
    scorch(damaged, [(-13, -6, 4), (-5, 14, 4), (4, 5, 3), (19, -2, 3), (-12, 6, 3), (14, 11, 3), (6, 20, 3)], rng)
    rubble(damaged, 26, (-22, 22, -22, 22), rng)
    return [pixels_frame(idle), pixels_frame(damaged)]


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
            'frames': checked('OILB', oilb_frames(), allowed),
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
