"""Nature of the 3D minimal pack: trees, tree clusters, burnt husks, rocks, ice formations and crate stacks.

Everything stands on the terrain (no slab), casts a soft shadow and has no damage or build-up pose. Coordinates are
cells (see core.Building). A tree stands on every blocked cell of its footprint; the footprint strings are those of
engine/rules.json ('x' is a blocked cell, '_' a free one that the sprite may still cover). Models vary
deterministically through specs.Rng, seeded by the actor id."""
from specs import BuildingSpec, Rng

# ---- Footprints (rows of the footprint box, 'x' = blocked) ---------------------------------------

FOOT = {
    'T01': (2, ['__', 'x_']), 'T02': (2, ['__', 'x_']), 'T03': (2, ['__', 'x_']), 'T04': (2, ['__', 'x_']),
    'T05': (2, ['__', 'x_']), 'T06': (2, ['__', 'x_']), 'T07': (2, ['__', 'x_']), 'T08': (2, ['x_']),
    'T09': (1, ['x']), 'T10': (2, ['__', 'xx']), 'T11': (2, ['__', 'xx']), 'T12': (2, ['__', 'x_']),
    'T13': (2, ['__', 'x_']), 'T14': (3, ['___', 'xx_']), 'T15': (3, ['___', 'xx_']), 'T16': (2, ['__', 'x_']),
    'T17': (2, ['__', 'x_']),
    'TC01': (3, ['___', 'xx_']), 'TC02': (3, ['_x_', 'xx_']), 'TC03': (3, ['xx_', 'xx_']),
    'TC04': (4, ['____', 'xxx_', 'x___']), 'TC05': (4, ['__x_', 'xxx_', '_xx_']),
    'ROCK1': (3, ['___', 'xx_']), 'ROCK2': (3, ['xx_']), 'ROCK3': (3, ['___', 'xx_']), 'ROCK4': (2, ['x_']),
    'ROCK5': (2, ['x_']), 'ROCK6': (3, ['___', 'xxx']), 'ROCK7': (5, ['xxxx_']),
    'ICE01': (2, ['xx', 'xx']), 'ICE02': (1, ['x', 'x']), 'ICE03': (2, ['xx']), 'ICE04': (1, ['x']), 'ICE05': (1, ['x']),
}
for _i in range(1, 10):
    FOOT['BOXES%02d' % _i] = (1, ['x'])

# Kind of tree per actor (after the vector art's TREE_KIND, with snow and dead variants for variety).
KIND = {
    'T01': 'oak', 'T02': 'oak', 'T03': 'pine', 'T04': 'palm', 'T05': 'oak', 'T06': 'snowpine', 'T07': 'oak',
    'T08': 'bush', 'T09': 'cactus', 'T10': 'oak', 'T11': 'dead', 'T12': 'oak', 'T13': 'pine', 'T14': 'oak',
    'T15': 'snowpine', 'T16': 'oak', 'T17': 'pine',
    'TC01': 'oak', 'TC02': 'pine', 'TC03': 'oak', 'TC04': 'oak', 'TC05': 'pine',
}

# Canopy greens (light-ish base colours; the three flat tones come from the face direction).
GREENS = (('#4f9d3a', '#66b84a', '#3f8a32'), ('#4a9a52', '#5fb35c', '#3a8344'), ('#5aa83a', '#76c244', '#468f30'))
PINES = (('#2f7a4a', '#3f9358', '#256a3e'), ('#2a7048', '#3a8a52', '#205f38'))
TRUNK = '#7a5230'
CHAR = '#2e2a26'


def cells_of(actor):
    w, rows = FOOT[actor]
    return [(x, y) for y, row in enumerate(rows) for x, ch in enumerate(row) if ch == 'x']


# ---- Tree builders ---------------------------------------------------------------------------------


def oak(b, x, y, s, rng):
    """A round tree: trunk and a stepped canopy of boxes and an octagon in three greens."""
    g = GREENS[int(rng.next() * len(GREENS))]
    t = 0.11 * s
    b.box(x - t, y - t, 2 * t, 2 * t, 0.36 * s, TRUNK)
    b.box(x - t - 0.02, y - t - 0.02, 2 * t + 0.04, 0.04, 0.05 * s, '#5e3e22')
    r = 0.34 * s
    b.cyl(x, y, r, 0.2 * s, g[2], 0.3 * s)
    b.cyl(x + 0.02 * s, y - 0.03 * s, r * 0.88, 0.2 * s, g[0], 0.48 * s)
    b.box(x - r * 0.45, y - r * 0.45 - 0.03 * s, r * 0.9, r * 0.9, 0.16 * s, g[1], 0.66 * s)
    # A few leaf clumps on the south face.
    for i in range(2):
        ox = (i * 2 - 1) * r * 0.55 + (rng.next() - 0.5) * 0.06
        b.box(x + ox - 0.05 * s, y + r * 0.62, 0.1 * s, 0.07 * s, 0.07 * s, g[1], (0.34 + 0.12 * i) * s)


def pine(b, x, y, s, rng, snow=False):
    """A stepped conifer: four octagon tiers that shrink to the tip (white caps when snowy)."""
    g = PINES[int(rng.next() * len(PINES))]
    b.box(x - 0.06 * s, y - 0.06 * s, 0.12 * s, 0.12 * s, 0.22 * s, TRUNK)
    z = 0.14 * s
    for k, r in enumerate((0.36, 0.29, 0.21, 0.12)):
        col = g[k % 2 * 2] if not snow else ('#e8f2f8' if k % 2 else g[0])
        b.cyl(x, y, r * s, 0.2 * s, col, z)
        if snow:
            b.cyl(x, y, r * s * 0.7, 0.04 * s, '#ffffff', z + 0.2 * s)
        elif k % 2 == 0:
            b.cyl(x, y, r * s * 0.8, 0.03 * s, g[1], z + 0.2 * s)
        z += 0.2 * s
    b.box(x - 0.025 * s, y - 0.025 * s, 0.05 * s, 0.05 * s, 0.1 * s, '#ffffff' if snow else g[1], z)


def palm(b, x, y, s, rng):
    """A boxy palm: a leaning trunk of stacked boxes and fronds of flat decals around the crown."""
    lean = (rng.next() - 0.5) * 0.06
    px = x
    for k in range(6):
        px = x + lean * k * 1.5
        b.box(px - 0.06 * s, y - 0.06 * s, 0.12 * s, 0.12 * s, 0.1 * s, '#9a6b3c' if k % 2 else '#7a5230', 0.1 * k * s)
    cz = 0.6 * s
    b.box(px - 0.08 * s, y - 0.08 * s, 0.16 * s, 0.16 * s, 0.08 * s, '#5e3e22', cz)
    zt = cz + 0.1 * s
    # Eight fronds: each a tapered flat strip, drooping at the tip.
    for k in range(8):
        a = k * 45.0
        dx, dy = _dir(a)
        nx, ny = -dy, dx
        L = 0.46 * s if k % 2 == 0 else 0.38 * s
        w0, w1 = 0.07 * s, 0.045 * s
        col = '#3f8a32' if k % 2 else '#66b84a'
        p0 = (px + nx * w0, y + ny * w0, zt)
        p1 = (px - nx * w0, y - ny * w0, zt)
        mx, my = px + dx * L * 0.55, y + dy * L * 0.55
        q1 = (mx - nx * w1, my - ny * w1, zt + 0.07 * s)
        q0 = (mx + nx * w1, my + ny * w1, zt + 0.07 * s)
        b.poly([p0, p1, q1, q0], col)
        tx, ty = px + dx * L, y + dy * L
        b.poly([q0, q1, (tx, ty, zt - 0.06 * s)], '#4f9d3a' if k % 2 else '#7acb52')
    b.box(px - 0.045 * s, y - 0.045 * s, 0.09 * s, 0.09 * s, 0.07 * s, '#9a6b3c', zt)


def _dir(a):
    from core import dsin, dcos
    return dsin(a), -dcos(a)


def cactus(b, x, y, s, rng):
    """A saguaro: a tall column with two upturned arms."""
    g = ('#4f8a3a', '#6aa84a', '#3d7430')
    b.box(x - 0.09 * s, y - 0.09 * s, 0.18 * s, 0.18 * s, 0.75 * s, g[0])
    b.box(x - 0.06 * s, y - 0.06 * s, 0.12 * s, 0.12 * s, 0.08 * s, g[1], 0.75 * s)
    b.box(x - 0.09 * s, y + 0.092 * s, 0.18 * s, 0.01, 0.6 * s, g[2], 0.05 * s)
    b.box(x - 0.27 * s, y - 0.05 * s, 0.18 * s, 0.1 * s, 0.1 * s, g[0], 0.26 * s)
    b.box(x - 0.27 * s, y - 0.05 * s, 0.1 * s, 0.1 * s, 0.26 * s, g[1], 0.36 * s)
    b.box(x + 0.09 * s, y - 0.05 * s, 0.17 * s, 0.1 * s, 0.1 * s, g[0], 0.42 * s)
    b.box(x + 0.16 * s, y - 0.05 * s, 0.1 * s, 0.1 * s, 0.22 * s, g[1], 0.52 * s)


def bush(b, x, y, s, rng):
    g = GREENS[int(rng.next() * len(GREENS))]
    b.cyl(x, y, 0.26 * s, 0.16 * s, g[2], 0.0)
    b.cyl(x, y - 0.02, 0.2 * s, 0.14 * s, g[0], 0.14 * s)
    b.box(x - 0.08 * s, y - 0.1 * s, 0.16 * s, 0.16 * s, 0.08 * s, g[1], 0.26 * s)


def dead(b, x, y, s, rng):
    """A bare tree: grey trunk with a few stub branches."""
    b.box(x - 0.08 * s, y - 0.08 * s, 0.16 * s, 0.16 * s, 0.6 * s, '#8a7a68')
    b.box(x - 0.05 * s, y - 0.05 * s, 0.1 * s, 0.1 * s, 0.22 * s, '#6e5f50', 0.6 * s)
    b.beam((x, y, 0.38 * s), (x - 0.3 * s, y + 0.02, 0.62 * s), 0.07 * s, '#6e5f50')
    b.beam((x, y, 0.5 * s), (x + 0.28 * s, y - 0.04, 0.76 * s), 0.07 * s, '#8a7a68')
    b.beam((x, y, 0.7 * s), (x - 0.14 * s, y - 0.1, 0.9 * s), 0.06 * s, '#6e5f50')


BUILDERS = {'oak': oak, 'pine': pine, 'palm': palm, 'cactus': cactus, 'bush': bush, 'dead': dead}


def tree_at(b, kind, x, y, s, rng):
    if kind == 'snowpine':
        pine(b, x, y, s, rng, snow=True)
    else:
        BUILDERS[kind](b, x, y, s, rng)


def make_tree(actor):
    kind = KIND[actor]
    seed = sum(ord(c) * (i + 3) for i, c in enumerate(actor))

    def draw(b):
        rng = Rng(seed)
        cells = sorted(cells_of(actor), key=lambda c: (c[1], c[0]))
        multi = len(cells) > 1
        for i, (cx, cy) in enumerate(cells):
            x = cx + 0.5 + ((rng.next() - 0.5) * 0.16 if multi else 0)
            y = cy + 0.56 + ((rng.next() - 0.5) * 0.12 if multi else 0)
            s = (0.85 + 0.25 * rng.next()) if multi else 1.0
            tree_at(b, kind, x, y, s, rng)
    return draw


# ---- Husks -----------------------------------------------------------------------------------------


def husk_at(b, x, y, s, rng, kind):
    """A burnt stump: charred trunk pieces, ash on the ground and a small ember."""
    b.flat([(x - 0.3, y), (x - 0.12, y - 0.2), (x + 0.2, y - 0.17), (x + 0.34, y + 0.04), (x + 0.15, y + 0.24),
            (x - 0.18, y + 0.2)], 0.004, '#24211e', 0.6)
    tall = {'pine': 0.5, 'snowpine': 0.5, 'palm': 0.55, 'cactus': 0.35, 'dead': 0.55, 'bush': 0.18}.get(kind, 0.4)
    h = tall * s * (0.8 + 0.4 * rng.next())
    b.box(x - 0.1 * s, y - 0.1 * s, 0.2 * s, 0.2 * s, h * 0.55, CHAR)
    b.box(x - 0.07 * s, y - 0.07 * s, 0.14 * s, 0.14 * s, h * 0.45, '#3b352f', h * 0.55)
    b.box(x - 0.03 * s, y - 0.1 * s, 0.1 * s, 0.1 * s, 0.1 * s, '#4a4036', h)
    # A broken piece lying on the ground and a splintered side stub.
    b.box(x + 0.14 * s, y + 0.08 * s, 0.26 * s, 0.09 * s, 0.07 * s, '#3b352f')
    b.box(x - 0.3 * s, y + 0.02 * s, 0.14 * s, 0.07 * s, 0.05 * s, CHAR)
    b.box(x - 0.12 * s, y + 0.1 * s, 0.05 * s, 0.01, h * 0.35, '#24211e', 0.04)
    # Ember and a thin curl of smoke.
    b.box(x - 0.02, y - 0.03, 0.05, 0.05, 0.03, '#ff9a2a', h + 0.1 * s, emit=True)
    b.box(x - 0.03, y - 0.04, 0.07, 0.07, 0.07, '#8a8d90', h + 0.14 * s, a=0.55)


def make_husk(actor):
    kind = KIND[actor]
    seed = sum(ord(c) * (i + 5) for i, c in enumerate(actor)) + 11

    def draw(b):
        rng = Rng(seed)
        cells = sorted(cells_of(actor), key=lambda c: (c[1], c[0]))
        multi = len(cells) > 1
        for cx, cy in cells:
            x = cx + 0.5 + ((rng.next() - 0.5) * 0.16 if multi else 0)
            y = cy + 0.56 + ((rng.next() - 0.5) * 0.12 if multi else 0)
            husk_at(b, x, y, (0.85 + 0.25 * rng.next()) if multi else 1.0, rng, kind)
    return draw


# ---- Rocks -----------------------------------------------------------------------------------------

ROCKS = (('#8a8f96', '#a9aeb5', '#6c7178'), ('#7f858c', '#9ea4ab', '#666b72'), ('#948f88', '#b3aea6', '#76716a'))


def boulder(b, x, y, r, rng, g):
    """One rock: a wide octagon base, a smaller block above, sometimes a chunk beside it."""
    h1 = r * (0.55 + 0.3 * rng.next())
    b.cyl(x, y, r, h1, g[0], 0.0, n=8)
    b.box(x - r * 0.55 + (rng.next() - 0.5) * 0.06, y - r * 0.5, r * 1.0, r * 0.9, r * 0.45, g[1], h1)
    if rng.next() > 0.45:
        b.box(x + r * 0.5, y + r * 0.2, r * 0.7, r * 0.55, r * 0.4, g[2], 0.0)


def make_rock(actor):
    seed = sum(ord(c) * (i + 7) for i, c in enumerate(actor))

    def draw(b):
        rng = Rng(seed)
        g = ROCKS[seed % len(ROCKS)]
        for cx, cy in sorted(cells_of(actor), key=lambda c: (c[1], c[0])):
            n = 2 if actor in ('ROCK4', 'ROCK5') else 3
            for k in range(n):
                x = cx + 0.3 + (k * 0.2) + (rng.next() - 0.5) * 0.12
                y = cy + 0.34 + 0.2 * ((k + int(rng.next() * 2)) % 2) + (rng.next() - 0.5) * 0.1
                boulder(b, x, y, 0.15 + 0.13 * rng.next(), rng, g)
    return draw


# ---- Ice -------------------------------------------------------------------------------------------


def make_ice(actor):
    seed = sum(ord(c) * (i + 9) for i, c in enumerate(actor))

    def draw(b):
        rng = Rng(seed)
        for cx, cy in sorted(cells_of(actor), key=lambda c: (c[1], c[0])):
            x, y = cx + 0.5, cy + 0.52
            # A pale base floe, then stepped blocks that taper like a floating berg.
            b.cyl(x, y, 0.44 + 0.04 * rng.next(), 0.12, 'ice2', 0.0, a=0.82)
            r = 0.36 + 0.06 * rng.next()
            h = 0.12 + 0.12 * rng.next()
            b.box(x - r + (rng.next() - 0.5) * 0.1, y - r * 0.8, 2 * r, 1.6 * r, h, 'ice', 0.12, a=0.72)
            r2 = r * 0.62
            b.box(x - r2 - 0.04, y - r2 * 0.8 - 0.03, 2 * r2, 1.5 * r2, h * 0.8, 'ice2', 0.12 + h, a=0.78)
            b.box(x + 0.1, y + 0.05, 0.12, 0.1, 0.1 + 0.12 * rng.next(), 'ice', 0.12, a=0.72)
    return draw


# ---- Crates ----------------------------------------------------------------------------------------

CRATES = (('#b0793f', '#c9955a'), ('#94744a', '#b08e62'), ('#6b7a3c', '#8a9a52'), ('#a8402e', '#c9604a'),
          ('#5a7aa8', '#7a9ac8'), ('#7d8a96', '#aab7c3'))


def crate(b, x, y, w, h, c, z, rng):
    """One crate: a box with a lighter lid plate, two slat strips on the lid and a side stripe."""
    base, light = c
    b.box(x, y, w, w, h, base, z)
    b.box(x + 0.02, y + 0.02, w - 0.04, w - 0.04, 0.02, light, z + h)
    b.box(x + w * 0.2, y + 0.01, w * 0.14, 0.012, h - 0.02, light, z + 0.01)
    b.box(x + w * 0.66, y + 0.01, w * 0.14, 0.012, h - 0.02, light, z + 0.01)
    b.flat([(x + w * 0.4, y + 0.02), (x + w * 0.6, y + 0.02), (x + w * 0.6, y + w - 0.02), (x + w * 0.4, y + w - 0.02)],
           z + h + 0.021, base)


def make_boxes(actor):
    seed = sum(ord(c) * (i + 13) for i, c in enumerate(actor))
    n = int(actor[-2:])

    def draw(b):
        rng = Rng(seed)
        pick = lambda: CRATES[int(rng.next() * len(CRATES))]
        # Layouts by number: a lone crate, a pair, a pyramid of three, a stack of four, a wall.
        w = 0.34
        style = n % 5
        if style == 0:
            crate(b, 0.3, 0.3, 0.4, 0.4, pick(), 0.0, rng)
        elif style == 1:
            crate(b, 0.1, 0.4, w, 0.32, pick(), 0.0, rng)
            crate(b, 0.52, 0.3, w, 0.36, pick(), 0.0, rng)
        elif style == 2:
            crate(b, 0.1, 0.45, w, 0.3, pick(), 0.0, rng)
            crate(b, 0.5, 0.45, w, 0.3, pick(), 0.0, rng)
            crate(b, 0.3, 0.3, w, 0.3, pick(), 0.3, rng)
        elif style == 3:
            crate(b, 0.12, 0.5, w, 0.3, pick(), 0.0, rng)
            crate(b, 0.5, 0.52, w, 0.3, pick(), 0.0, rng)
            crate(b, 0.14, 0.14, w, 0.3, pick(), 0.0, rng)
            crate(b, 0.3, 0.3, w, 0.28, pick(), 0.3, rng)
        else:
            crate(b, 0.08, 0.3, 0.4, 0.34, pick(), 0.0, rng)
            crate(b, 0.52, 0.34, 0.38, 0.28, pick(), 0.0, rng)
            crate(b, 0.2, 0.34, 0.3, 0.26, pick(), 0.34, rng)
    return draw


# ---- Actors ----------------------------------------------------------------------------------------

ACTORS = {}


def _spec(actor, draw, foot=None):
    w, rows = FOOT[foot or actor]
    ACTORS[actor] = BuildingSpec(w, len(rows), draw, ground=None, damage=False, make=False, shadow=True)


for _a in KIND:
    _spec(_a, make_tree(_a))
    _spec(_a + '.Husk', make_husk(_a), _a)
for _a in FOOT:
    if _a.startswith('ROCK'):
        _spec(_a, make_rock(_a))
    elif _a.startswith('ICE'):
        _spec(_a, make_ice(_a))
    elif _a.startswith('BOXES'):
        _spec(_a, make_boxes(_a))
