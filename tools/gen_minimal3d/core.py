"""Core of the 3D minimal texture pack generator: palette, model builder,
z-buffer rasterizer, PNG writer and sheet assembly.

Look: blocky and bright (think Crossy Road). Every shape is built from boxes,
octagonal prisms ("round" things are octagons), stepped domes, gables and
flat decals. Every face is ONE flat colour: three tones per material (light,
mid, dark) picked from the face's direction, no outlines, no dither, no
anti-aliasing. Nothing here is taken from Westwood's or OpenRA's art.

Projection: Red Alert's classic 3/4 camera, the same as tools/gen_pixel_art.py
and engine render.rs (CLASSIC_PITCH_SIN): screen x is world x, screen y is
world y shortened by PITCH minus the height. World: x east, y south, z up.
Light comes from the top left. Sprites are rendered at one sheet pixel per
world pixel (RES), a map cell is 24 pixels.

Coordinates of a model
- Building(w, d): arguments are in CELLS (24 px); x east, y south, z up; the
  origin is the corner (0, 0) of the footprint box (w x d cells, bib rows
  included). The renderer centres the sprite on the box.
- Unit(): arguments are in PIXELS; x to the right of the unit, y FORWARD
  (towards the nose; the model faces north at heading 0), z up; the origin is
  the unit's centre on the ground. Row f of a sheet is the unit turned
  f / facings of a turn clockwise from north.
- Colours are '#rrggbb' strings or 'T' (the owner's colour: rendered as grey
  into the sheet and set in the team mask; the game tints it).
"""
import math
import os
import struct
import zlib

# ---- Constants ---------------------------------------------------------------------------------

RES = 1  # sheet pixels per world pixel
CELL = 24  # world pixels per map cell
PITCH = 654 / 1024  # engine render.rs CLASSIC_PITCH_SIN
# Ground shear ("variant B"): verticals stay vertical and the ground plane is sheared, screen x = x + GSHEAR * y,
# so besides the front you see the east side and the roof. Facing straight at the camera every building showed only
# its facade and looked flat. The shear is linear and applied AFTER a unit's heading rotation, so it holds in all
# 32 facings, and a turret rendered with the same shear lines up with its body. Terrain tiles are not sheared.
# The shear is anchored (see Model.anchor): a structure keeps its front edge exactly on its cells and leans
# its back to the east; a unit keeps its centre.
GSHEAR = -0.35

# Flat tones: brightness multiplier of the light, mid and dark face of a material.
TONE_MUL = (1.08, 0.84, 0.62)
# Team faces are grey in the sheet (the shader multiplies the team colour by
# 0.35 + 1.05 * grey): mid grey 0.58 keeps the owner's colour true.
TEAM_GREY = 148
# Cast shadow: translucent black.
SHADOW_ALPHA = 64
# Toward the light: from the top left and above.
_L = (-0.55, 0.4, 0.75)
_LN = math.sqrt(sum(v * v for v in _L))
LIGHT = tuple(v / _LN for v in _L)

# Named colours: the palette of the design boards (project/buildings3d).
P = {
    'concrete': '#bdb7a6', 'wall': '#ddd6c4', 'roof': '#ece6d6', 'steel': '#7d8a96', 'steel2': '#aab7c3',
    'dark': '#4a5560', 'darker': '#2e3238', 'yellow': '#ffc93c', 'glass': '#6ec6e6', 'orange': '#f2b632',
    'gold': '#ffd34d', 'glow': '#fff0a0', 'molten': '#ff9a2a', 'copper': '#d07a3a', 'brick': '#c0573e',
    'wood': '#b0793f', 'paint': '#f4f1e8', 'steam': '#f2f6f8', 'grass': '#6abe4a', 'water': '#3aa0d8',
    'tiles': '#a8402e', 'asphalt': '#5a5d63', 'canvas': '#a3a55f', 'sand': '#d6c48a', 'red': '#e84a3a',
    'green': '#5ef08a', 'blue': '#6ab0ff', 'ice': '#7fe0ff', 'ice2': '#e0f8ff', 'dome': '#e4ebf0',
    'radar': '#4fd067', 'dirt': '#9a8458', 'camo': '#4f8a3a', 'camo2': '#7ab84e', 'field': '#ff5a3a',
    'shroud': '#1a2a3a', 'rust': '#9a5a3a', 'olive': '#6b7a3c', 'sandy': '#c9ad6a', 'black': '#141414',
    'skin': '#e8b98c',
}


def hex_rgb(h):
    n = int(h[1:], 16)
    return ((n >> 16) & 255, (n >> 8) & 255, n & 255)


def resolve(c):
    """'T', a palette name or '#rrggbb' -> 'T' or (r, g, b)."""
    if c == 'T':
        return 'T'
    if isinstance(c, tuple):
        return c
    return hex_rgb(P.get(c, c))


# ---- Vector helpers ------------------------------------------------------------------------------


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def norm(v):
    n = math.sqrt(dot(v, v))
    return (v[0] / n, v[1] / n, v[2] / n) if n > 1e-12 else (0.0, 0.0, 1.0)


def dsin(deg):
    """Sine in degrees with + - * / only, so every platform draws the same bits."""
    d = deg % 360.0
    if d > 180.0:
        d -= 360.0
    x = d * math.pi / 180.0
    x2 = x * x
    term = x
    total = x
    for n in range(1, 15):
        term *= -x2 / ((2 * n) * (2 * n + 1))
        total += term
    return total


def dcos(deg):
    return dsin(deg + 90.0)


# ---- Models --------------------------------------------------------------------------------------


class Face:
    __slots__ = ('pts', 'color', 'alpha', 'emit', 'two_sided', 'inside', 'shadow')

    def __init__(self, pts, color, alpha, emit, two_sided, inside, shadow):
        self.pts = pts
        self.color = color
        self.alpha = alpha
        self.emit = emit
        self.two_sided = two_sided
        self.inside = inside
        self.shadow = shadow


class Model:
    """A list of flat-coloured faces. Use Building or Unit; the primitives are
    the vocabulary of the design boards: box, cyl, vdome, gable, band, beam,
    bill, flat (plus prism, pyramid, poly and bolt)."""

    def __init__(self, scale, ysign):
        self.faces = []
        self.s = scale
        self.ys = ysign
        self.mark_shadow = True
        # World y (model pixels, after the heading) that the shear leaves in place; see GSHEAR.
        self.anchor = 0.0

    # -- point conversion
    def p(self, x, y, z):
        return (x * self.s, y * self.s * self.ys, z * self.s)

    def _add(self, pts, c, a, emit, two_sided, inside=None, shadow=True):
        self.faces.append(Face([self.p(*q) for q in pts], resolve(c), a, emit, two_sided,
                               self.p(*inside) if inside else None, shadow and a >= 0.99))

    # -- solids
    def prism(self, xy, h, c, z=0.0, a=1.0, top=True, emit=False):
        """A convex polygon (list of (x, y), any winding) extruded up h from z."""
        n = len(xy)
        cx = sum(q[0] for q in xy) / n
        cy = sum(q[1] for q in xy) / n
        inside = (cx, cy, z + h / 2)
        if h > 0:
            for i in range(n):
                (x0, y0), (x1, y1) = xy[i], xy[(i + 1) % n]
                self._add([(x0, y0, z), (x1, y1, z), (x1, y1, z + h), (x0, y0, z + h)], c, a, emit, False, inside)
        if top:
            self._add([(x, y, z + h) for x, y in xy], c, a, emit, False, (cx, cy, z))

    def box(self, x, y, w, d, h, c, z=0.0, a=1.0, emit=False):
        """A box with its corner at (x, y), w east, d south, h up, from height z."""
        self.prism([(x, y), (x + w, y), (x + w, y + d), (x, y + d)], h, c, z, a, True, emit)

    def cyl(self, cx, cy, r, h, c, z=0.0, n=8, top=True, a=1.0, emit=False):
        """An upright n-sided prism (an octagon by default; round things are octagons)."""
        pts = [(cx + r * dcos(360.0 * (i / n) + 180.0 / n), cy + r * dsin(360.0 * (i / n) + 180.0 / n)) for i in range(n)]
        self.prism(pts, h, c, z, a, top, emit)

    def vdome(self, cx, cy, r, h, c, z=0.0, a=1.0, emit=False):
        """A stepped dome: three boxes, each smaller than the one below."""
        self.box(cx - r, cy - r, 2 * r, 2 * r, h * 0.4, c, z, a, emit)
        self.box(cx - r * 0.72, cy - r * 0.72, 1.44 * r, 1.44 * r, h * 0.3, c, z + h * 0.4, a, emit)
        self.box(cx - r * 0.4, cy - r * 0.4, 0.8 * r, 0.8 * r, h * 0.3, c, z + h * 0.7, a, emit)

    def pyramid(self, cx, cy, rx, ry, h, c, z=0.0, a=1.0, emit=False):
        """A four-sided pyramid on the rectangle centred (cx, cy), half sizes rx, ry."""
        t = (cx, cy, z + h)
        k = [(cx - rx, cy - ry, z), (cx + rx, cy - ry, z), (cx + rx, cy + ry, z), (cx - rx, cy + ry, z)]
        inside = (cx, cy, z + h * 0.3)
        for i in range(4):
            self._add([k[i], k[(i + 1) % 4], t], c, a, emit, False, inside)

    def gable(self, x, y, w, d, rh, c, z=0.0, axis='x', a=1.0, emit=False):
        """A gable roof on the rectangle (x, y, w, d) from height z, ridge rh higher; the ridge runs along `axis`."""
        t = z + rh
        inside = (x + w / 2, y + d / 2, z + rh * 0.3)
        if axis == 'x':
            m = y + d / 2
            self._add([(x, y, z), (x + w, y, z), (x + w, m, t), (x, m, t)], c, a, emit, False, inside)
            self._add([(x, m, t), (x + w, m, t), (x + w, y + d, z), (x, y + d, z)], c, a, emit, False, inside)
            self._add([(x + w, y, z), (x + w, y + d, z), (x + w, m, t)], c, a, emit, False, inside)
            self._add([(x, y, z), (x, y + d, z), (x, m, t)], c, a, emit, False, inside)
        else:
            m = x + w / 2
            self._add([(x, y, z), (m, y, t), (m, y + d, t), (x, y + d, z)], c, a, emit, False, inside)
            self._add([(m, y, t), (x + w, y, z), (x + w, y + d, z), (m, y + d, t)], c, a, emit, False, inside)
            self._add([(x, y + d, z), (x + w, y + d, z), (m, y + d, t)], c, a, emit, False, inside)
            self._add([(x, y, z), (x + w, y, z), (m, y, t)], c, a, emit, False, inside)

    def band(self, x, y, w, d, rh, z, axis, side, f0, f1, c, a=1.0, emit=False):
        """A strip on a gable roof (same arguments as gable): side 'a' is the south or east slope, 'b' the other;
        f0 to f1 run from the ridge (0) to the eaves (1)."""
        t = z + rh + 0.004
        zz = z + 0.004
        if axis == 'x':
            m = y + d / 2
            e = y + d if side == 'a' else y

            def Y(f):
                return m + (e - m) * f

            def Z(f):
                return t + (zz - t) * f
            pts = [(x, Y(f0), Z(f0)), (x + w, Y(f0), Z(f0)), (x + w, Y(f1), Z(f1)), (x, Y(f1), Z(f1))]
        else:
            m = x + w / 2
            e = x + w if side == 'a' else x

            def X(f):
                return m + (e - m) * f

            def Z(f):
                return t + (zz - t) * f
            pts = [(X(f0), y, Z(f0)), (X(f1), y, Z(f1)), (X(f1), y + d, Z(f1)), (X(f0), y + d, Z(f0))]
        self._add(pts, c, a, emit, True, None, shadow=False)

    def beam(self, p0, p1, wd, c, a=1.0, emit=False):
        """A square-section beam from p0 to p1 (x, y, z points), wd thick."""
        a0 = self.p(*p0)
        a1 = self.p(*p1)
        w = wd * self.s
        dv = sub(a1, a0)
        side = cross(dv, (0.0, 0.0, 1.0))
        if dot(side, side) < 1e-9:
            side = (1.0, 0.0, 0.0)
        side = norm(side)
        up = norm(cross(side, dv))
        if up[2] < 0:
            up = (-up[0], -up[1], -up[2])
        h = w / 2
        corners = []
        for q in (a0, a1):
            corners.append([(q[0] + side[0] * sx * h + up[0] * sy * h, q[1] + side[1] * sx * h + up[1] * sy * h,
                             q[2] + side[2] * sx * h + up[2] * sy * h) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        mid = tuple((a0[i] + a1[i]) / 2 for i in range(3))
        for i in range(4):
            j = (i + 1) % 4
            self.faces.append(Face([corners[0][i], corners[0][j], corners[1][j], corners[1][i]], resolve(c), a, emit, False, mid, a >= 0.99))
        self.faces.append(Face(list(corners[1]), resolve(c), a, emit, False, mid, a >= 0.99))
        self.faces.append(Face(list(corners[0]), resolve(c), a, emit, False, mid, a >= 0.99))

    def tube(self, p0, p1, r, c, n=8, a=1.0, emit=False, caps=True):
        """An n-sided round bar (an octagon by default) of radius r from p0 to p1 (x, y, z points): barrels, wheels
        (a short tube along x), rockets, poles. Any direction."""
        a0 = self.p(*p0)
        a1 = self.p(*p1)
        rr = r * self.s
        dv = sub(a1, a0)
        side = cross(dv, (0.0, 0.0, 1.0))
        if dot(side, side) < 1e-9:
            side = (1.0, 0.0, 0.0)
        side = norm(side)
        up = norm(cross(side, dv))
        ring = []
        for q in (a0, a1):
            pts = []
            for i in range(n):
                t = 360.0 * (i / n) + 180.0 / n
                ct, st = dcos(t), dsin(t)
                pts.append((q[0] + (side[0] * ct + up[0] * st) * rr, q[1] + (side[1] * ct + up[1] * st) * rr,
                            q[2] + (side[2] * ct + up[2] * st) * rr))
            ring.append(pts)
        mid = tuple((a0[i] + a1[i]) / 2 for i in range(3))
        col = resolve(c)
        for i in range(n):
            j = (i + 1) % n
            self.faces.append(Face([ring[0][i], ring[0][j], ring[1][j], ring[1][i]], col, a, emit, False, mid, a >= 0.99))
        if caps:
            self.faces.append(Face(list(ring[1]), col, a, emit, False, mid, a >= 0.99))
            self.faces.append(Face(list(ring[0]), col, a, emit, False, mid, a >= 0.99))

    # -- flat things
    def flat(self, xy, z, c, a=1.0, emit=False):
        """A horizontal polygon at height z (decals on roofs and the ground)."""
        self._add([(x, y, z) for x, y in xy], c, a, emit, True, None, shadow=False)

    def bill(self, cx, cy, z, uv, c, a=1.0, emit=False):
        """A vertical polygon facing south at (cx, cy): points (u east, h up) from the height z (stars, flames, dishes)."""
        self._add([(cx + u, cy, z + h) for u, h in uv], c, a, emit, True, None, shadow=False)

    def poly(self, pts, c, a=1.0, emit=False):
        """Any planar polygon of (x, y, z) points, visible from both sides."""
        self._add(pts, c, a, emit, True, None, shadow=False)

    def bolt(self, cx, cy, z, uv, wd, c, a=1.0, emit=False):
        """A zigzag of thin bills through the points (u, h): lightning, sparks."""
        for i in range(len(uv) - 1):
            (u0, h0), (u1, h1) = uv[i], uv[i + 1]
            if abs(h1 - h0) > abs(u1 - u0):
                q = [(u0 - wd, h0), (u1 - wd, h1), (u1 + wd, h1), (u0 + wd, h0)]
            else:
                q = [(u0, h0 - wd), (u1, h1 - wd), (u1, h1 + wd), (u0, h0 + wd)]
            self.bill(cx, cy, z, q, c, a, emit)

    def extend(self, other, dx=0.0, dy=0.0, dz=0.0, yaw=0.0):
        """Add another model's faces, moved by (dx, dy, dz) in this model's units and turned `yaw` degrees clockwise about z first."""
        cs, sn = dcos(yaw), dsin(yaw)
        for f in other.faces:
            pts = []
            for (x, y, z) in f.pts:
                pts.append((x * cs - y * sn + dx * self.s, x * sn + y * cs + dy * self.s * self.ys, z + dz * self.s))
            ins = None
            if f.inside:
                x, y, z = f.inside
                ins = (x * cs - y * sn + dx * self.s, x * sn + y * cs + dy * self.s * self.ys, z + dz * self.s)
            self.faces.append(Face(pts, f.color, f.alpha, f.emit, f.two_sided, ins, f.shadow))


class Building(Model):
    """A structure on its footprint box w x d cells. `ground` is the colour of the slab under it ('grass',
    'water', 'concrete', None for no slab)."""

    def __init__(self, w, d, ground='grass', slab=0.1):
        super().__init__(CELL, 1)
        self.w = w
        self.d = d
        self.kind = 'building'
        # The model origin is the centre of the footprint box: shift every point.
        self.cx = w / 2
        self.cy = d / 2
        self.anchor = d / 2 * CELL  # the front edge stays on its cells
        if ground:
            self.box(-slab, -slab, w + 2 * slab, d + 2 * slab, 0.18, ground, -0.18)
            for f in self.faces:
                f.shadow = False

    def p(self, x, y, z):
        return ((x - self.cx) * CELL, (y - self.cy) * CELL, z * CELL)


class Unit(Model):
    """A unit, tree or prop in pixels, facing north at heading 0: x right, y forward, z up, origin on the ground."""

    def __init__(self):
        super().__init__(1, -1)
        self.kind = 'unit'


# ---- Rasterizer ----------------------------------------------------------------------------------


class Image:
    """A rendered frame: pixels relative to the model origin. rgba and team are row-major;
    (x0, y0) is the sheet pixel of the first column and row (origin = pixel boundary 0, 0)."""

    def __init__(self, x0, y0, w, h):
        self.x0 = x0
        self.y0 = y0
        self.w = w
        self.h = h
        self.rgba = bytearray(w * h * 4)
        self.team = bytearray(w * h)

    def empty(self):
        return not any(self.rgba[3::4])

    def crop(self):
        """The image trimmed to its opaque pixels."""
        xs, ys = [], []
        for y in range(self.h):
            row = self.rgba[y * self.w * 4:(y + 1) * self.w * 4]
            nz = [x for x in range(self.w) if row[x * 4 + 3]]
            if nz:
                xs += [nz[0], nz[-1]]
                ys.append(y)
        if not ys:
            return Image(0, 0, 0, 0)
        l, r, t, b = min(xs), max(xs), min(ys), max(ys)
        o = Image(self.x0 + l, self.y0 + t, r - l + 1, b - t + 1)
        for y in range(o.h):
            s = ((t + y) * self.w + l) * 4
            o.rgba[y * o.w * 4:(y + 1) * o.w * 4] = self.rgba[s:s + o.w * 4]
            o.team[y * o.w:(y + 1) * o.w] = self.team[(t + y) * self.w + l:(t + y) * self.w + l + o.w]
        return o


def _tone(n):
    v = dot(n, LIGHT)
    if v >= 0.5:
        return 0
    if v >= 0.1:
        return 1
    return 2


def _rotate(pts, c, s):
    return [(x * c - y * s, x * s + y * c, z) for x, y, z in pts]


def _poly_normal(pts):
    """Newell's normal of a polygon."""
    nx = ny = nz = 0.0
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        nx += (a[1] - b[1]) * (a[2] + b[2])
        ny += (a[2] - b[2]) * (a[0] + b[0])
        nz += (a[0] - b[0]) * (a[1] + b[1])
    return norm((nx, ny, nz))


def _fill(poly, emit):
    """Pixel centres (px, py) covered by the convex screen polygon `poly` (pixel units): yields (py, x_from, x_to)."""
    ymin = min(q[1] for q in poly)
    ymax = max(q[1] for q in poly)
    n = len(poly)
    for py in range(int(math.ceil(ymin - 0.5)), int(math.floor(ymax - 0.5)) + 1):
        yc = py + 0.5
        xs = []
        for i in range(n):
            (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
            if (y0 <= yc < y1) or (y1 <= yc < y0):
                xs.append(x0 + (yc - y0) * (x1 - x0) / (y1 - y0))
        if len(xs) >= 2:
            lo, hi = min(xs), max(xs)
            a = int(math.ceil(lo - 0.5))
            b = int(math.floor(hi - 0.5))
            if a <= b:
                yield py, a, b


def render(model, heading=0.0, zmax=None, shadow=False, team_rgb=None, res=RES, zoom=1.0, anchor=None, shear=True):
    """Render `model` turned `heading` degrees clockwise from north. Returns an Image cropped to its pixels.
    shadow: also cast a translucent shadow on the ground (units, trees and props). team_rgb: paint 'T' faces
    in this colour (cameos) instead of grey with a mask. zmax: hide everything above this height (make
    animations). zoom: scale (cameos). anchor: world y the ground shear leaves in place (default model.anchor; a
    turreted unit anchors its hull at the turret pivot, where the engine places the turret sprite). shear=False
    draws without the ground shear (bridges, which must meet the unsheared terrain)."""
    cs, sn = dcos(heading), dsin(heading)
    ay = (model.anchor if anchor is None else anchor) if shear else 0.0
    G = GSHEAR if shear else 0.0
    k = res * zoom
    faces = []
    allx, ally = [], []
    for f in model.faces:
        pts = _rotate(f.pts, cs, sn) if heading else f.pts
        n = _poly_normal(pts)
        if f.two_sided:
            if n[1] + n[2] * PITCH - G * n[0] < 0:
                n = (-n[0], -n[1], -n[2])
        else:
            if f.inside is not None:
                ins = _rotate([f.inside], cs, sn)[0] if heading else f.inside
                c0 = tuple(sum(q[i] for q in pts) / len(pts) for i in range(3))
                if dot(n, sub(c0, ins)) < 0:
                    n = (-n[0], -n[1], -n[2])
        faces.append((f, pts, n))
        for (x, y, z) in pts:
            allx.append((x + G * (y - ay)) * k)
            ally.append((y * PITCH - z) * k)
    if not faces:
        return Image(0, 0, 0, 0)
    sh_pts = None
    if shadow:
        sh_pts = []
        for f, pts, n in faces:
            if not f.shadow:
                continue
            g = []
            for (x, y, z) in pts:
                # Shadows fall to the bottom right: light from the top left.
                g.append(((x + z * 0.5 + G * (y + z * 0.3 - ay)) * k, ((y + z * 0.3) * PITCH) * k))
            sh_pts.append(g)
            for q in g:
                allx.append(q[0])
                ally.append(q[1])
    x0 = int(math.floor(min(allx))) - 1
    x1 = int(math.ceil(max(allx))) + 1
    y0 = int(math.floor(min(ally))) - 1
    y1 = int(math.ceil(max(ally))) + 1
    w, h = x1 - x0, y1 - y0
    img = Image(x0, y0, w, h)
    zbuf = [-1e18] * (w * h)
    late = []
    for f, pts, n in faces:
        denom = n[1] + n[2] * PITCH - G * n[0]
        if abs(denom) < 1e-4:
            continue
        if not f.two_sided and denom <= 0:
            continue
        if f.alpha < 0.99:
            late.append((f, pts, n, denom))
            continue
        _draw(img, zbuf, f, pts, n, denom, k, zmax, team_rgb, True, G, ay)
    for f, pts, n, denom in late:
        _draw(img, zbuf, f, pts, n, denom, k, zmax, team_rgb, False, G, ay)
    if sh_pts:
        for g in sh_pts:
            poly = [q for q in g]
            # The projected face may have either winding: fill works on convex polygons of any winding.
            for py, a, b in _fill(poly, False):
                for px in range(a, b + 1):
                    ix, iy = px - x0, py - y0
                    if 0 <= ix < w and 0 <= iy < h:
                        o = (iy * w + ix) * 4
                        if img.rgba[o + 3] == 0:
                            img.rgba[o + 3] = SHADOW_ALPHA
        # Shadows are marked with alpha only: colour stays black (0, 0, 0).
    return img.crop()


def _draw(img, zbuf, f, pts, n, denom, k, zmax, team_rgb, update_z, G, ay):
    w, h, x0, y0 = img.w, img.h, img.x0, img.y0
    poly = [((x + G * (y - ay)) * k, (y * PITCH - z) * k) for x, y, z in pts]
    d = dot(n, pts[0])
    base = f.color
    team = base == 'T'
    if f.emit:
        mul = 1.0
    else:
        mul = TONE_MUL[_tone(n)]
    if team and team_rgb is None:
        col = (TEAM_GREY, TEAM_GREY, TEAM_GREY)
    elif team:
        col = team_rgb
    else:
        col = base
    r = min(255, int(col[0] * mul + 0.5))
    g = min(255, int(col[1] * mul + 0.5))
    b = min(255, int(col[2] * mul + 0.5))
    alpha = f.alpha
    nx, ny, nz = n
    team_mask = team and team_rgb is None
    for py, a, bb in _fill(poly, f.emit):
        iy = py - y0
        if not 0 <= iy < h:
            continue
        yc = (py + 0.5) / k
        for px in range(a, bb + 1):
            ix = px - x0
            if not 0 <= ix < w:
                continue
            # Screen x is X + G * (Y - ay): the pixel's ground x is xc - G * (Y - ay); solve the plane for Z.
            xc = (px + 0.5) / k + G * ay
            Z = (PITCH * d - PITCH * nx * xc + (nx * G - ny) * yc) / denom
            Y = (yc + Z) / PITCH
            if zmax is not None and Z > zmax:
                continue
            # Depth along the view direction (-G, 1, PITCH): nearer is larger.
            near = Y + PITCH * Z - G * (xc - G * Y)
            i = iy * w + ix
            if near < zbuf[i] - 1e-4:
                continue
            o = i * 4
            if alpha >= 0.99:
                zbuf[i] = near
                img.rgba[o] = r
                img.rgba[o + 1] = g
                img.rgba[o + 2] = b
                img.rgba[o + 3] = 255
                img.team[i] = 255 if team_mask else 0
            else:
                ea = img.rgba[o + 3]
                if ea == 0:
                    img.rgba[o] = r
                    img.rgba[o + 1] = g
                    img.rgba[o + 2] = b
                    img.rgba[o + 3] = int(alpha * 255)
                elif ea == 255:
                    img.rgba[o] = int(img.rgba[o] * (1 - alpha) + r * alpha + 0.5)
                    img.rgba[o + 1] = int(img.rgba[o + 1] * (1 - alpha) + g * alpha + 0.5)
                    img.rgba[o + 2] = int(img.rgba[o + 2] * (1 - alpha) + b * alpha + 0.5)
                else:
                    # Over another translucent pixel (or a shadow): the newer colour wins, alpha adds up.
                    na = 1 - (1 - ea / 255) * (1 - alpha)
                    img.rgba[o] = r
                    img.rgba[o + 1] = g
                    img.rgba[o + 2] = b
                    img.rgba[o + 3] = int(na * 255)
                img.team[i] = 0


# ---- Sheets, PNG ---------------------------------------------------------------------------------


def png_bytes(w, h, rgba):
    """An 8-bit RGBA PNG (filter 0), the same bytes for the same pixels on one zlib."""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')


def png_decode(data):
    """(w, h, rgba) of a PNG written by png_bytes (RGBA 8 bit, filter 0)."""
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos = 8
    idat = b''
    w = h = 0
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if tag == b'IHDR':
            w, h = struct.unpack('>II', body[:8])
        elif tag == b'IDAT':
            idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat)
    out = bytearray()
    stride = w * 4
    for y in range(h):
        assert raw[y * (stride + 1)] == 0, 'png_decode reads filter 0 only'
        out += raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)]
    return w, h, bytes(out)


class Sheet:
    """Frames of one sprite: rows = facings, columns = frames, all cropped to one common box.
    `add(row, col, image)`; `finish()` returns (width, height, rgba, team, frame_w, frame_h, offset)."""

    def __init__(self, facings=1, frames=1):
        self.facings = facings
        self.frames = frames
        self.cells = {}

    def add(self, row, col, image):
        self.cells[(row, col)] = image

    def finish(self, anchor=None, fixed=None):
        """anchor: (ax, ay) pixel the frame centre should map to (default: the union box centre).
        Returns dict(width, height, rgba, team, frame, offset, has_team)."""
        imgs = [i for i in self.cells.values() if i.w]
        if not imgs:
            raise ValueError('an empty sprite')
        l = min(i.x0 for i in imgs)
        t = min(i.y0 for i in imgs)
        r = max(i.x0 + i.w for i in imgs)
        b = max(i.y0 + i.h for i in imgs)
        if fixed:
            # A symmetric box about the origin keeps every row of a turning unit in place.
            l, t, r, b = fixed(l, t, r, b)
        fw, fh = r - l, b - t
        W, H = fw * self.frames, fh * self.facings
        rgba = bytearray(W * H * 4)
        team = bytearray(W * H)
        for (row, col), im in self.cells.items():
            for y in range(im.h):
                ty = row * fh + (im.y0 + y - t)
                tx = col * fw + (im.x0 - l)
                rgba[(ty * W + tx) * 4:(ty * W + tx + im.w) * 4] = im.rgba[y * im.w * 4:(y + 1) * im.w * 4]
                team[ty * W + tx:ty * W + tx + im.w] = im.team[y * im.w:(y + 1) * im.w]
        # Image centre relative to the origin, world pixels (the engine centres frames on actor + offset).
        offset = ((l + r) / 2 / RES, (t + b) / 2 / RES)
        return {'width': W, 'height': H, 'rgba': bytes(rgba), 'team': bytes(team), 'frame': (fw, fh), 'offset': offset,
                'has_team': any(team)}


def team_mask_rgba(team):
    out = bytearray(len(team) * 4)
    for i, v in enumerate(team):
        if v:
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255
        out[i * 4 + 3] = 255
    return bytes(out)


def symmetric(l, t, r, b):
    """Union box widened to be centred on the origin horizontally (a unit turning about its centre)."""
    m = max(-l, r)
    return -m, t, m, b


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
