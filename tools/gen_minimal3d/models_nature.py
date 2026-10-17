"""Nature of the 3D minimal pack: trees, tree clusters, burnt husks, rocks, ice formations and crate stacks.

Retexture of 0.21.0: a tree is two blocks (trunk and crown) in the shared terrain colours, a rock or a floe two
blocks per cell, a crate one block; trees grow up to the top of the original sprite's footprint box.

Everything stands on the terrain (no slab), casts a soft shadow and has no damage or build-up pose. Coordinates are
cells (see core.Building). A tree stands on every blocked cell of its footprint; the footprint strings are those of
engine/rules.json ('x' is a blocked cell, '_' a free one that the sprite may still cover). Models vary
deterministically through specs.Rng, seeded by the actor id."""
import core
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

# Tree colours: the shared terrain table (apps/game/js/art/shared-palette.js), so 2D and 3D trees match.
TERRAIN = core.SHARED['terrain']['temperate']
SNOW = core.SHARED['terrain']['snow']
DESERT = core.SHARED['terrain']['desert']
# kind -> (crown colour, trunk colour, crown size, crown base as a share of the height, trunk width)
TREES = {
    'oak': (TERRAIN['tree'], TERRAIN['trunk'], 0.56, 0.3, 0.2),
    'pine': (TERRAIN['treeDark'], TERRAIN['trunk'], 0.42, 0.18, 0.18),
    'snowpine': (SNOW['tree'], SNOW['trunk'], 0.42, 0.18, 0.18),
    'palm': (DESERT['tree'], DESERT['trunk'], 0.5, 0.75, 0.14),
    'cactus': (DESERT['treeDark'], DESERT['treeDark'], 0.2, 0.35, 0.22),
    'bush': (TERRAIN['tree'], TERRAIN['trunk'], 0.42, 0.12, 0.16),
    'dead': ('#6b5a44', TERRAIN['trunk'], 0.35, 0.55, 0.14),
}
CHAR = '#2e2a26'


def cells_of(actor):
    w, rows = FOOT[actor]
    return [(x, y) for y, row in enumerate(rows) for x, ch in enumerate(row) if ch == 'x']


def seed_of(actor, k):
    return sum(ord(c) * (i + k) for i, c in enumerate(actor))


# ---- Trees: two blocks each, a trunk and a crown ------------------------------------------------------


def tree_at(b, kind, x, y, s, h):
    """One tree on (x, y): the trunk and the crown, `s` its size, `h` (cells) the top of its crown."""
    crown, trunk, r, base, t = TREES[kind]
    r *= s
    t *= s
    if kind == 'cactus':
        b.box(x - t / 2, y - t / 2, t, t, h, trunk)
        b.box(x - r * 1.3, y - t / 4, 2.6 * r, t / 2, h * 0.3, crown, h * 0.4)
        return
    # The crown is a little flatter than it is wide; the trunk shows below it.
    z = max(h * base, h - 1.5 * r)
    b.box(x - t / 2, y - t / 2, t, t, z + 0.02, trunk)
    b.box(x - r, y - r, 2 * r, 2 * r, h - z, crown, z)


def make_tree(actor):
    kind = KIND[actor]

    def draw(b):
        rng = Rng(seed_of(actor, 3))
        cells = sorted(cells_of(actor), key=lambda c: (c[1], c[0]))
        multi = len(cells) > 1
        for cx, cy in cells:
            s = (0.85 + 0.2 * rng.next()) if multi else 1.15
            x = cx + 0.5 + ((rng.next() - 0.5) * 0.16 if multi else 0.15)
            y = cy + 0.45
            r = TREES[kind][2] * s
            h = b.top(y - r) * (0.85 + 0.15 * rng.next())
            if kind == 'bush':
                h *= 0.45
            tree_at(b, kind, x, y, s, h)
    return draw


def make_husk(actor):
    kind = KIND[actor]

    def draw(b):
        rng = Rng(seed_of(actor, 5) + 11)
        for cx, cy in sorted(cells_of(actor), key=lambda c: (c[1], c[0])):
            x, y = cx + 0.5, cy + 0.5
            tall = {'pine': 0.5, 'snowpine': 0.5, 'palm': 0.55, 'cactus': 0.35, 'dead': 0.55, 'bush': 0.18}.get(kind, 0.4)
            b.box(x - 0.1, y - 0.1, 0.2, 0.2, tall * (0.8 + 0.4 * rng.next()), CHAR)
            b.box(x + 0.1, y + 0.05, 0.3, 0.1, 0.08, '#3b352f')
    return draw


# ---- Rocks, ice and crates ----------------------------------------------------------------------------

ROCKS = (TERRAIN['rock'], TERRAIN['rockLight'], TERRAIN['rockDark'])


def make_rock(actor):
    def draw(b):
        rng = Rng(seed_of(actor, 7))
        for cx, cy in sorted(cells_of(actor), key=lambda c: (c[1], c[0])):
            # One boulder per cell: a wide block and a smaller one on it.
            r = 0.36 + 0.08 * rng.next()
            h = 0.22 + 0.12 * rng.next()
            x, y = cx + 0.5 + (rng.next() - 0.5) * 0.1, cy + 0.5
            b.box(x - r, y - r * 0.8, 2 * r, 1.6 * r, h, ROCKS[0])
            b.box(x - r * 0.6, y - r * 0.6, 1.2 * r, 1.1 * r, h * 0.6, ROCKS[1], h)
    return draw


def make_ice(actor):
    def draw(b):
        rng = Rng(seed_of(actor, 9))
        for cx, cy in sorted(cells_of(actor), key=lambda c: (c[1], c[0])):
            x, y = cx + 0.5, cy + 0.5
            r = 0.36 + 0.06 * rng.next()
            h = 0.14 + 0.1 * rng.next()
            b.box(x - r, y - r * 0.85, 2 * r, 1.7 * r, h, 'ice', 0.0)
            b.box(x - r * 0.6, y - r * 0.5, 1.2 * r, r, h * 0.8, 'ice2', h)
    return draw


CRATES = ('#b0793f', '#94744a', '#6b7a3c', '#a8402e', '#5a7aa8', '#7d8a96')


def make_boxes(actor):
    n = int(actor[-2:])

    def draw(b):
        rng = Rng(seed_of(actor, 13))
        pick = lambda: CRATES[int(rng.next() * len(CRATES))]
        # Layouts by number: a lone crate, a pair, a pyramid of three (one crate is one block).
        style = n % 3
        if style == 0:
            b.box(0.2, 0.25, 0.6, 0.6, 0.45, pick())
        elif style == 1:
            b.box(0.05, 0.4, 0.45, 0.45, 0.4, pick())
            b.box(0.52, 0.3, 0.45, 0.45, 0.45, pick())
        else:
            b.box(0.05, 0.45, 0.42, 0.42, 0.34, pick())
            b.box(0.52, 0.45, 0.42, 0.42, 0.34, pick())
            b.box(0.28, 0.3, 0.42, 0.42, 0.32, pick(), 0.34)
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
