"""Sprite specs: what the models files declare, and how each spec is rendered into sprite sheets.

A models file exports dicts the generator collects (generate.py):

    ACTORS = {'POWR': BuildingSpec(...), '1TNK': VehicleSpec(...), 'E1': InfantrySpec(...), ...}
    SPECIALS = {'bullet': SpecialSpec(...), ...}      (optional)
    ALIASES = {'WEAF': 'WEAP', ...}                   (optional: actor id -> actor id whose art it shares)

Each spec renders into Sprite records (a core.Sheet result plus the manifest keys) and gives a cameo.
Nothing here writes files: pack.py does.
"""
import copy

import core
from core import Building, Unit, Model, Sheet, render

FACINGS = 32


class Sprite:
    """One manifest sprite entry: an actor part and pose (or a special) and its rendered sheet."""

    def __init__(self, sheet, part='body', pose='idle', facings=1, frames=1, fps=0, hidden=False, rotate=False):
        self.sheet = sheet  # core.Sheet.finish() result, or None when hidden
        self.part = part
        self.pose = pose
        self.facings = facings
        self.frames = frames
        self.fps = fps
        self.hidden = hidden
        self.rotate = rotate


def _sheet(images, facings=1, frames=1):
    """images[row][col] -> finished sheet."""
    s = Sheet(facings, frames)
    for r, row in enumerate(images):
        for c, im in enumerate(row):
            s.add(r, c, im)
    return s.finish()


class Rng:
    """A small deterministic generator (LCG)."""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF or 1

    def next(self):
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0


# ---- Damage and make -----------------------------------------------------------------------------


def damaged(model, seed=7):
    """A copy of a building model below half health: scorch decals on the biggest roofs, a few rubble blocks
    on the slab and three steps of dark smoke over the highest point."""
    out = copy.copy(model)
    out.faces = list(model.faces)
    rng = Rng(seed + len(model.faces))
    tops = []
    zmax = 0.0
    for f in model.faces:
        n = core._poly_normal(f.pts)
        zs = [q[2] for q in f.pts]
        zmax = max(zmax, max(zs))
        if n[2] > 0.9 and f.alpha >= 0.99 and min(zs) > 2:
            xs = [q[0] for q in f.pts]
            ys = [q[1] for q in f.pts]
            tops.append(((max(xs) - min(xs)) * (max(ys) - min(ys)), min(xs), max(xs), min(ys), max(ys), zs[0]))
    tops.sort(reverse=True)
    raw = Model(1, 1)
    for _, x0, x1, y0, y1, z in tops[:3]:
        w, h = x1 - x0, y1 - y0
        ax, ay = x0 + w * (0.15 + 0.3 * rng.next()), y0 + h * (0.15 + 0.3 * rng.next())
        raw.flat([(ax, ay), (ax + w * 0.5, ay + h * 0.1), (ax + w * 0.4, ay + h * 0.55), (ax + w * 0.05, ay + h * 0.45)], z + 0.2, '#2a2622', 0.7)
    xs = [q[0] for f in model.faces for q in f.pts]
    ys = [q[1] for f in model.faces for q in f.pts]
    x0, x1, y1 = min(xs), max(xs), max(ys)
    for i in range(3):
        bx = x0 + (x1 - x0) * (0.15 + 0.3 * i + 0.1 * rng.next())
        raw.box(bx, y1 - 6 - 3 * rng.next(), 4 + 3 * rng.next(), 3 + 2 * rng.next(), 2 + 2 * rng.next(), '#6b6862' if i % 2 else '#4a4743', 0)
    top = max(tops[:1], default=(0, x0, x1, 0, 0, zmax))
    cx, cy = (top[1] + top[2]) / 2, (top[3] + top[4]) / 2
    raw.vdome(cx, cy, 5, 12, '#43484d', top[5] + 1, 0.8)
    raw.vdome(cx + 2, cy - 1, 4, 9, '#5a6066', top[5] + 12, 0.6)
    out.faces += raw.faces
    return out


def height_of(model):
    return max((q[2] for f in model.faces for q in f.pts), default=1.0)


def make_frames(model, n, shear=True):
    """The build-up animation: the structure grows from the ground up in n steps."""
    h = height_of(model)
    return [render(model, zmax=h * (i + 1) / n + 0.01, shear=shear) for i in range(n)]


# ---- Cameos --------------------------------------------------------------------------------------

CAMEO_W, CAMEO_H = 64, 48
CAMEO_TEAM = (77, 140, 242)


def cameo_rgba(model, heading=0.0, shadow=False, margin=3):
    """A 64 x 48 sidebar picture: the model turned `heading`, scaled to fit, on a flat two-tone backdrop in the pack's colours."""
    first = render(model, heading, shadow=shadow, team_rgb=CAMEO_TEAM)
    zoom = min((CAMEO_W - 2 * margin - 2) / max(1, first.w), (CAMEO_H - 2 * margin - 2) / max(1, first.h))
    # Whole-number scales keep the pixels square and blocky; fractions only when the model is too big for 1x.
    zoom = int(zoom) if zoom >= 1 else zoom
    im = render(model, heading, shadow=shadow, team_rgb=CAMEO_TEAM, zoom=zoom) if zoom != 1 else first
    sky, ground, horizon, edge = (58, 80, 104), (74, 106, 69), (92, 125, 82), (26, 31, 38)
    px = bytearray(CAMEO_W * CAMEO_H * 4)
    for y in range(CAMEO_H):
        for x in range(CAMEO_W):
            c = sky if y < 16 else (horizon if y == 16 else ground)
            if x in (0, CAMEO_W - 1) or y in (0, CAMEO_H - 1):
                c = edge
            o = (y * CAMEO_W + x) * 4
            px[o:o + 4] = bytes(c + (255,))
    # Place the picture's bottom centre near the bottom of the frame.
    ox = (CAMEO_W - im.w) // 2 - im.x0
    oy = CAMEO_H - 3 - (im.y0 + im.h)
    for y in range(im.h):
        for x in range(im.w):
            s = (y * im.w + x) * 4
            a = im.rgba[s + 3]
            if not a:
                continue
            tx, ty = im.x0 + x + ox, im.y0 + y + oy
            if 1 <= tx < CAMEO_W - 1 and 1 <= ty < CAMEO_H - 1:
                o = (ty * CAMEO_W + tx) * 4
                al = a / 255
                for k in range(3):
                    px[o + k] = int(px[o + k] * (1 - al) + im.rgba[s + k] * al + 0.5)
    return bytes(px)


# ---- Specs ---------------------------------------------------------------------------------------


class BuildingSpec:
    """A structure (or a tree, rock or prop) on a footprint of w x d cells.

    draw(b) paints into a core.Building (cells, see core.py). The generator renders the idle pose, a
    `damaged` pose (generic scorch, rubble and smoke) and a `make` build-up pose. `second_hidden`: WebRA
    draws an animated layer on top of this structure today (radar dish, smoke, turret, silo hatch): the
    pack hides it, so the body must show that part itself. `turret`: a function returning a core.Unit (pixels, z up
    from the GROUND, origin = the building's centre) for a turning turret (GUN, AGUN, SAM): it becomes the 'second'
    part with `turret_facings` rows, and the body must then leave the turret out."""

    kind = 'building'

    def __init__(self, w, d, draw, ground='grass', damage=True, make=True, make_frames=8, second_hidden=False,
                 shadow=False, cameo_heading=0.0, turret=None, turret_facings=FACINGS, shear=True):
        self.w, self.d, self.draw = w, d, draw
        self.ground = ground
        self.damage = damage
        self.make = make
        self.make_frames = make_frames
        self.second_hidden = second_hidden
        self.shadow = shadow
        self.cameo_heading = cameo_heading
        self.turret = turret
        self.turret_facings = turret_facings
        # False draws without the ground shear (bridges: their deck must meet the unsheared terrain).
        self.shear = shear

    def model(self):
        b = Building(self.w, self.d, self.ground)
        self.draw(b)
        return b

    def sprites(self):
        m = self.model()
        sh = self.shear
        out = [Sprite(_sheet([[render(m, shadow=self.shadow, shear=sh)]]))]
        if self.damage:
            out.append(Sprite(_sheet([[render(damaged(m), shadow=self.shadow, shear=sh)]]), pose='damaged'))
        if self.make:
            out.append(Sprite(_sheet([make_frames(m, self.make_frames, sh)], 1, self.make_frames), pose='make', frames=self.make_frames, fps=12))
        if self.turret:
            n = self.turret_facings
            t = self.turret()
            # The turret turns about the building's centre and is sheared like the body (same anchor).
            out.append(Sprite(_sheet([[render(t, 360.0 * f / n, anchor=m.anchor, shear=sh)] for f in range(n)], n), part='second', facings=n))
        elif self.second_hidden:
            out.append(Sprite(None, part='second', hidden=True))
        return out

    def cameo(self):
        m = self.model()
        if self.turret:
            m.extend(self.turret())
        return cameo_rgba(m, self.cameo_heading, self.shadow)


class VehicleSpec:
    """A vehicle or ship: body() -> core.Unit facing north, origin at the centre on the ground (pixels).
    turret() -> core.Unit around the turret's pivot (x, y relative to the pivot, z up from the GROUND, so
    include the turret's height); the engine places the turret sprite at the actor's turret offset
    (rules.json turret_offsets). Facings are rendered every 360 / facings degrees, row 0 north, clockwise."""

    kind = 'unit'

    def __init__(self, body, turret=None, facings=FACINGS, shadow=True, cameo_heading=215.0, cameo_with_turret_heading=-40.0,
                 turret_pivot=(0.0, 0.0), shear_pivot=None):
        self.body, self.turret, self.facings, self.shadow = body, turret, facings, shadow
        # Where the hull's ground shear is anchored (forward px): the mount, or the middle of several mounts.
        self.shear_pivot = shear_pivot if shear_pivot is not None else turret_pivot
        self.cameo_heading = cameo_heading
        self.cameo_turret_yaw = cameo_with_turret_heading
        self.turret_pivot = turret_pivot

    def sprites(self):
        n = self.facings
        body = self.body()
        # The engine puts the turret sprite at the pivot without shear: the hull is sheared about the pivot (its
        # world y after the heading), so the turret stays on its mount. Several mounts (CA): about their middle.
        rows = [[render(body, 360.0 * f / n, shadow=self.shadow, anchor=self.pivot_y(360.0 * f / n))] for f in range(n)]
        out = [Sprite(_sheet(rows, n), facings=n)]
        if self.turret:
            t = self.turret()
            trows = [[render(t, 360.0 * f / n)] for f in range(n)]
            out.append(Sprite(_sheet(trows, n), part='second', facings=n))
        return out

    def pivot_y(self, heading):
        """World y of the turret pivot (the shear anchor of the hull) at a heading; 0 without a turret."""
        if not self.turret:
            return 0.0
        x, f = self.shear_pivot
        return x * core.dsin(heading) - f * core.dcos(heading)

    def cameo(self):
        m = Unit()
        m.extend(self.body())
        if self.turret:
            m.extend(self.turret(), dx=self.turret_pivot[0], dy=self.turret_pivot[1], yaw=self.cameo_turret_yaw)
        return cameo_rgba(m, self.cameo_heading, self.shadow)


class Pose:
    """One pose of an infantry part: fn(frame) -> core.Unit, `frames` frames at `fps`, `facings` rows."""

    def __init__(self, fn, frames=1, fps=0, facings=8, shadow=True):
        self.fn, self.frames, self.fps, self.facings, self.shadow = fn, frames, fps, facings, shadow


class InfantrySpec:
    """A soldier or civilian. `body` maps pose names (idle, move, attack, attack2?, stand2, idle1, idle2, die1..die6,
    crushed) to a Pose; `prone` maps idle/move/attack to the lying pose (the 'second' part). `cameo_pose` is the
    pose whose first frame becomes the cameo."""

    kind = 'unit'

    def __init__(self, body, prone=None, cameo_heading=215.0):
        self.body, self.prone, self.cameo_heading = body, prone or {}, cameo_heading

    def sprites(self):
        out = []
        for part, poses in (('body', self.body), ('second', self.prone)):
            for name, p in poses.items():
                rows = [[render(p.fn(k), 360.0 * f / p.facings, shadow=p.shadow) for k in range(p.frames)] for f in range(p.facings)]
                out.append(Sprite(_sheet(rows, p.facings, p.frames), part=part, pose=name, facings=p.facings, frames=p.frames, fps=p.fps))
        return out

    def cameo(self):
        return cameo_rgba(self.body['idle'].fn(0), self.cameo_heading, True)


class AircraftSpec:
    """An aircraft: body() -> core.Unit (nose north); the shadow is drawn by the engine. A helicopter gives
    rotor(angle_degrees, fast) -> core.Unit around the actor's centre (hub at its z); it becomes the 'second'
    part: pose idle (slow, on the ground, `slow_frames`) and move (blurred, in the air, `fast_frames`)."""

    kind = 'unit'

    def __init__(self, body, rotor=None, facings=FACINGS, slow_frames=8, fast_frames=4, cameo_heading=215.0, shadow=False):
        self.body, self.rotor, self.facings = body, rotor, facings
        self.slow_frames, self.fast_frames = slow_frames, fast_frames
        self.cameo_heading = cameo_heading
        self.shadow = shadow

    def sprites(self):
        n = self.facings
        body = self.body()
        out = [Sprite(_sheet([[render(body, 360.0 * f / n, shadow=self.shadow)] for f in range(n)], n), facings=n)]
        if self.rotor:
            slow = [render(self.rotor(k * 90.0 / self.slow_frames, False)) for k in range(self.slow_frames)]
            fast = [render(self.rotor(k * 90.0 / self.fast_frames, True)) for k in range(self.fast_frames)]
            out.append(Sprite(_sheet([slow], 1, self.slow_frames), part='second', pose='idle', frames=self.slow_frames, fps=8))
            out.append(Sprite(_sheet([fast], 1, self.fast_frames), part='second', pose='move', frames=self.fast_frames, fps=16))
        return out

    def cameo(self):
        m = Unit()
        m.extend(self.body())
        if self.rotor:
            m.extend(self.rotor(20.0, False))
        return cameo_rgba(m, self.cameo_heading, False)


class SpecialSpec:
    """An effect or projectile: frames(k) -> core.Unit for k in range(count), at `fps`. One facing; projectiles are
    drawn pointing east (heading 90 here, authored facing north)."""

    kind = 'special'

    def __init__(self, fn, count=1, fps=0, heading=90.0):
        self.fn, self.count, self.fps, self.heading = fn, count, fps, heading

    def sprites(self):
        return [Sprite(_sheet([[render(self.fn(k), self.heading) for k in range(self.count)]], 1, self.count), frames=self.count, fps=self.fps)]

    def cameo(self):
        return None
