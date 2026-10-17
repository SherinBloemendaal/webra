"""Village buildings (V20 to V37), farm and landmark structures, map props (barrels, crates, poles, fences, mines,
flag) and the bridges with their huts.

Retexture of 0.21.0: two to six big blocks each, the defining feature kept (the adobe's flat roof, the dome, the
tower, the awning, the pagoda roof, the lighthouse's red bands and lamp, the windmill's sails, the mine's crater
with its ore or crystals, the flag in the owner's colour), village buildings fill their footprint like the original
sprite (core.Building), props stand inside their cell. The bridges lie flat on their cells (BuildingSpec `flat`):
the engine draws the deck over water cells, so the deck floats on its own stone."""
from specs import BuildingSpec

ADOBE1, ADOBE2, ADOBE3 = '#d8c19a', '#c9a878', '#e2cfa8'
ADOBE_ROOF = '#a48a64'
TRIM = '#efe4cc'


# ---- Shared helpers ------------------------------------------------------------------------------


def flat_house(b, wall, x0=None, x1=None, depth=None, h=None, roof=ADOBE_ROOF, door=True):
    """An adobe block with a flat roof plate, up to the top of the original sprite (2 or 3 shapes)."""
    f = b.front
    x0 = b.x0 if x0 is None else x0
    x1 = b.x1 if x1 is None else x1
    depth = f if depth is None else depth
    y0 = f - depth
    h = b.top(y0) - 0.05 if h is None else h
    b.box(x0, y0, x1 - x0, depth, h, wall)
    b.box(x0 + 0.08, y0 + 0.08, x1 - x0 - 0.16, depth - 0.16, 0.05, roof, h)
    if door:
        b.box((x0 + x1) / 2 - 0.1, f - 0.02, 0.2, 0.03, min(0.3, h * 0.8), '#5a3a22')
    return h


def gable_house(b, wall, roof, axis='x', x0=None, x1=None, depth=None, wall_h=0.3):
    """Walls and a gable roof whose ridge reaches the top of the original sprite, a door (3 shapes)."""
    f = b.front
    x0 = b.x0 if x0 is None else x0
    x1 = b.x1 if x1 is None else x1
    depth = f if depth is None else depth
    y0 = f - depth
    span = depth if axis == 'x' else x1 - x0
    top = b.top(y0 + depth / 2 if axis == 'x' else y0)
    rh = min(0.42 * span, max(0.05, top - wall_h))
    wall_h = top - rh
    b.box(x0, y0, x1 - x0, depth, wall_h, wall)
    b.gable(x0, y0, x1 - x0, depth, rh, roof, wall_h, axis)
    b.box((x0 + x1) / 2 - 0.1, f - 0.02, 0.2, 0.03, min(0.3, wall_h * 0.8), '#5a3a22')


# ---- Village buildings (desert adobes and friends) -------------------------------------------------


def v20(b):
    # Courtyard house: the two-storey back block and the walled yard in front.
    f = b.front
    flat_house(b, ADOBE1, depth=1.1, door=False)
    b.box(b.x0, f - 0.9, b.x1 - b.x0, 0.9, 0.22, ADOBE2)
    b.box(0.8, f - 0.02, 0.4, 0.03, 0.2, '#5a3a22')


def v21(b):
    # Brick house with a tiled gable roof and a chimney.
    f = b.front
    gable_house(b, 'brick', 'tiles', 'x', depth=1.5)
    b.box(1.4, f - 1.3, 0.2, 0.2, b.top(f - 1.3), 'brick')


def v22(b):
    # A long house with a tiled roof.
    gable_house(b, 'wall', 'tiles', 'x')


def v23(b):
    # Tiny cube house with its water jar.
    f = b.front
    flat_house(b, ADOBE3, b.x0, 0.75)
    b.cyl(0.87, f - 0.15, 0.11, 0.22, '#a8542e')


def v24(b):
    # Large two-storey house with its corner tower and a striped awning.
    f = b.front
    flat_house(b, ADOBE1, b.x0, 1.4, depth=1.4, h=0.7)
    b.block(1.4, f - 1.9, 0.6, 0.6, ADOBE2)
    b.box(0.2, f - 0.25, 1.0, 0.25, 0.05, 'red', 0.45)


def v25(b):
    # Desert church: the nave with its dome and the bell tower.
    f = b.front
    flat_house(b, ADOBE3, b.x0, 1.4, depth=1.6, h=0.55, door=True)
    b.vdome(0.7, f - 0.8, 0.5, b.top(f - 1.3) - 0.55, '#d8e2ea', 0.55)
    b.block(1.45, f - 1.3, 0.5, 0.5, ADOBE2)


def v26(b):
    # Shop with a striped awning and its goods in front.
    f = b.front
    flat_house(b, ADOBE2, depth=0.75)
    b.box(b.x0 + 0.1, f - 0.25, b.x1 - b.x0 - 0.2, 0.25, 0.05, 'red', 0.36)
    b.box(0.3, f - 0.2, 0.35, 0.2, 0.15, 'wood')


def v27(b):
    # Round hut with a thatched pyramid roof.
    b.cyl(0.5, 0.5, 0.48, 0.3, ADOBE1)
    b.pyramid(0.5, 0.5, 0.5, 0.5, b.top(0.0) - 0.3, 'sand', 0.3)


def v28(b):
    # A small domed house.
    b.box(0.05, 0.1, 0.9, 0.9, 0.3, ADOBE3)
    b.vdome(0.5, 0.55, 0.38, b.top(0.17) - 0.3, ADOBE1, 0.3)


def v29(b):
    # A watch tower with its flat lookout.
    top = b.top(0.2)
    b.cyl(0.5, 0.55, 0.3, top - 0.12, ADOBE2)
    b.cyl(0.5, 0.55, 0.38, 0.12, ADOBE1, top - 0.12)


def v30(b):
    # Two joined houses, a taller one and a lower one.
    f = b.front
    flat_house(b, ADOBE1, b.x0, 1.0, door=True)
    flat_house(b, ADOBE3, 1.0, b.x1, h=0.3, door=False)


def v31(b):
    # Plank house with a tile roof.
    gable_house(b, 'wood', 'tiles', 'x')


def v32(b):
    # Barn: a wide red roof over a big double door.
    gable_house(b, '#a8402e', 'dark', 'x')


def v33(b):
    # Market: two stalls under canvas awnings with goods.
    f = b.front
    for x0, c in ((0.05, 'red'), (1.05, 'canvas')):
        b.box(x0, f - 0.8, 0.9, 0.6, 0.18, 'wood')
        b.box(x0 - 0.05, f - 0.9, 1.0, 0.9, 0.05, c, b.top(f - 0.9) - 0.05)


def v34(b):
    # Round tiled hut with a tall pointed roof.
    b.cyl(0.5, 0.5, 0.45, 0.25, ADOBE1)
    b.pyramid(0.5, 0.5, 0.48, 0.48, b.top(0.02) - 0.25, 'tiles', 0.25)


def v35(b):
    # A small brick house with a tiled roof.
    gable_house(b, 'brick', 'tiles', 'y')


def v36(b):
    # Stepped adobe: two levels.
    f = b.front
    b.box(b.x0, f - 1.0, 1.0, 1.0, 0.25, ADOBE1)
    b.block(b.x0, f - 1.0, 0.6, 0.6, ADOBE2, 0.25)


def v37(b):
    # Irregular 5x2 footprint: two adobe houses, one over cells (2,0) (3,0), the other over (3,1) (4,1).
    h = b.top(0.0)
    b.box(2.0, 0.0, 2.0, 1.0, h - 0.05, ADOBE1)
    b.box(2.08, 0.08, 1.84, 0.84, 0.05, ADOBE_ROOF, h - 0.05)
    b.box(3.0, 1.0, 2.0, 1.0, 0.4, ADOBE3)
    b.box(3.08, 1.08, 1.84, 0.84, 0.05, ADOBE_ROOF, 0.4)


# ---- Farm, landmarks -------------------------------------------------------------------------------


def rice(b):
    # A flooded paddy with two rows of rice.
    b.box(0.0, 0.0, 1.0, 1.0, 0.03, '#6aa0b8')
    for y in (0.2, 0.62):
        b.box(0.1, y, 0.8, 0.18, 0.08, 'camo2', 0.03)


def rushouse(b):
    # A wooden house with a dark roof.
    gable_house(b, '#7a5a3a', '#4d4438', 'y')


def snowhut(b):
    # A wooden hut under a snowy roof.
    gable_house(b, '#8a6a4a', '#e8eef4', 'y')


def asianhut(b):
    # A two-step pagoda roof on a red-walled hut.
    top = b.top(0.0)
    b.box(0.15, 0.15, 0.7, 0.85, 0.3, '#a8402e')
    b.pyramid(0.5, 0.55, 0.5, 0.5, (top - 0.3) * 0.5, 'dark', 0.3)
    b.pyramid(0.5, 0.55, 0.32, 0.32, (top - 0.3) * 0.5, 'dark', 0.3 + (top - 0.3) * 0.5)


def lhus(b):
    # The lighthouse: a white tower with a red band, the glowing lamp and its red cap.
    f = b.front
    top = b.top(f - 0.75)
    b.cyl(0.5, f - 0.5, 0.3, top * 0.8, 'paint')
    b.cyl(0.5, f - 0.5, 0.31, top * 0.12, 'red', top * 0.4, top=False)
    b.cyl(0.5, f - 0.5, 0.18, top * 0.1, 'glow', top * 0.8, emit=True)
    b.cyl(0.5, f - 0.5, 0.25, top * 0.1, 'red', top * 0.9)


def windmill(b):
    # The windmill: a stone tower, its roof and the four sails in an X on the south face.
    f = b.front
    top = b.top(f - 0.8)
    b.cyl(0.5, f - 0.5, 0.3, top * 0.6, '#b8a888')
    b.pyramid(0.5, f - 0.5, 0.3, 0.3, top * 0.2, '#8a3a2a', top * 0.6)
    hz = top * 0.62
    for tx, tz in ((-0.6, 0.6), (0.6, -0.6)):
        b.beam((0.5 - tx, f - 0.15, hz - tz * 0.6), (0.5 + tx, f - 0.15, hz + tz * 0.6), 0.1, '#efe9d6')


def railmine(b):
    # Abandoned mine: the dirt yard with rails, and the shed with its dark mouth.
    f = b.front
    b.box(b.x0, f - 1.0, b.x1 - b.x0, 1.0, 0.03, '#5a4a3a')
    b.box(0.05, f - 0.45, 1.1, 0.25, 0.04, '#8a8e93', 0.03)
    b.block(1.1, f - 0.9, 0.85, 0.75, '#6b5a44')
    b.box(1.35, f - 0.16, 0.35, 0.02, 0.3, '#1a1410')


def ctflag(b):
    # The flag: a pole on a small plinth and the flag in the owner's colour.
    top = b.top(0.55)
    b.box(0.3, 0.45, 0.4, 0.3, 0.1, 'concrete')
    b.box(0.47, 0.57, 0.06, 0.06, top - 0.1, 'steel2', 0.1)
    b.box(0.53, 0.58, 0.38, 0.04, 0.25, 'T', top - 0.27)


# ---- Props -----------------------------------------------------------------------------------------


def barrel(b, cx, cy, c='#a8321e', top='#d9433a'):
    """An oil drum: the drum and its lid (2 shapes)."""
    b.cyl(cx, cy, 0.17, 0.42, c)
    b.cyl(cx, cy, 0.12, 0.02, top, 0.42)


def barl(b):
    barrel(b, 0.5, 0.55)


def brl3(b):
    barrel(b, 0.3, 0.38)
    barrel(b, 0.7, 0.38, '#8a6a2a', '#b89038')
    barrel(b, 0.5, 0.7)


def ammobox(b, n):
    # Olive ammunition boxes with a yellow lid mark.
    def one(x, y, w, d, h, z=0.0):
        b.box(x, y, w, d, h, '#5c6a3a', z)
    if n == 1:
        one(0.2, 0.35, 0.6, 0.45, 0.3)
        b.box(0.35, 0.45, 0.3, 0.25, 0.02, '#c9b02c', 0.3)
    elif n == 2:
        one(0.1, 0.5, 0.5, 0.4, 0.28)
        one(0.5, 0.3, 0.42, 0.38, 0.24)
    else:
        one(0.1, 0.55, 0.45, 0.35, 0.26)
        one(0.52, 0.5, 0.4, 0.35, 0.26)
        one(0.3, 0.35, 0.4, 0.35, 0.22, 0.26)


def utilpol(b, n):
    # A wooden pole with its cross arm (and a transformer box on the second kind).
    top = b.top(0.55)
    b.box(0.46, 0.56, 0.08, 0.08, top, '#6b4a2a')
    b.box(0.22, 0.57, 0.56, 0.06, 0.06, '#4a3420', top - 0.15)
    if n == 2:
        b.box(0.4, 0.5, 0.2, 0.17, 0.2, 'steel', top * 0.45)


def tanktrap(b, n):
    # Steel hedgehogs: two crossed beams each.
    def hedgehog(cx, cy, s=1.0):
        h = 0.34 * s
        b.beam((cx - h, cy, 0.05), (cx + h, cy, 0.55 * s), 0.08 * s, '#6a6e72')
        b.beam((cx + h, cy, 0.05), (cx - h, cy, 0.55 * s), 0.08 * s, '#8a8e93')
    if n == 1:
        hedgehog(0.5, 0.55)
    else:
        hedgehog(0.3, 0.45, 0.8)
        hedgehog(0.7, 0.62, 0.8)


# Mines (design canvas "Ertsmijn" and "Edelsteenmijn"; the 2D pack's art/world.js oreMine): ore and gem colours,
# the dark shaft, the rim's rock.
MINE_ORE = ('#c99a2e', '#e6c25a', '#7a6630')
MINE_GEMS = ('#4a7ac4', '#c84a9a', '#9fd8ff', '#38322a')
MINE_PIT = ('#14110d', '#3a3026')
MINE_ROCK = ('#6b6457', '#8f877a')


def mine(b, gems):
    # The crater: bare ground, the dark shaft, two blocks of rim rock at the back and the east side, open to the
    # south-west where the ore (two heaps) or the crystals (two) spill out of the shaft.
    b.cyl(0.5, 0.5, 0.5, 0.01, MINE_GEMS[3] if gems else MINE_ORE[2], 0.0, 12)
    b.cyl(0.48, 0.46, 0.24, 0.01, MINE_PIT[0], 0.01, 12)
    b.box(0.2, 0.08, 0.62, 0.16, 0.16, MINE_ROCK[0])
    b.box(0.74, 0.2, 0.18, 0.5, 0.11, MINE_ROCK[1])
    if gems:
        b.pyramid(0.45, 0.5, 0.08, 0.07, 0.42, MINE_GEMS[0], 0.01)
        b.pyramid(0.28, 0.72, 0.07, 0.06, 0.24, MINE_GEMS[1], 0.01)
    else:
        b.box(0.32, 0.42, 0.28, 0.22, 0.1, MINE_ORE[0], 0.01)
        b.box(0.14, 0.66, 0.3, 0.22, 0.08, MINE_ORE[1], 0.01)


def cycl(b):
    # Chain-link fence along the front of the cell: a see-through mesh between a post and a top rail.
    h = b.top(0.9)
    b.box(0, 0.92, 1, 0.08, 0.08, 'steel')
    b.box(0, 0.94, 1, 0.04, h - 0.14, 'steel2', 0.08, 0.45)
    b.box(0, 0.92, 1, 0.08, 0.06, 'steel', h - 0.06)
    b.box(0.0, 0.9, 0.1, 0.1, h, 'steel')


def barb(b):
    # Barbed wire: two low coils the width of the cell.
    for y in (0.62, 0.84):
        b.tube((0.0, y, 0.12), (1.0, y, 0.12), 0.11, '#6a6e72', n=6)


def wood(b):
    # Wooden fence: two posts and a rail the width of the cell.
    h = b.top(0.9)
    b.box(0.0, 0.92, 1.0, 0.06, 0.12, 'wood', h * 0.6)
    for x in (0.05, 0.85):
        b.box(x, 0.9, 0.1, 0.1, h, '#7a5230')


# ---- Bridges ---------------------------------------------------------------------------------------

DECK_TOP = 0.2
STONE = '#8f897c'
PLANK_A, PLANK_B = '#a97c4f', '#8d6638'

BRIDGES = {
    'BRIDGE1': ['.kggk', 'kggkk', '..k..'],
    'BRIDGE2': ['kggk.', 'kkggk'],
    'BRIDGE3': ['kggk', 'ggkk'],
    'BRIDGE4': ['kggk', 'kkgg'],
    'SBRIDGE1': ['vgv', 'vgv'],
    'SBRIDGE2': ['vv', 'gg', 'kk'],
    'SBRIDGE3': ['.kgk', 'vgkv'],
    'SBRIDGE4': ['kgk.', 'vkgk'],
    'BR1': ['.kg.', 'kggk', '.gkk'],
    'BR2': ['.kg..', 'kggkk', '.gkk.'],
    'BR3': ['kg..', '.gkk'],
}


def _at(rows, x, y):
    return (rows[y] if 0 <= y < len(rows) else '')[x:x + 1] if x >= 0 else ''


def _bridge(b, rows, concrete):
    """Per span cell a deck block and a rail along each open side, per abutment cell a stone block, per pier a post."""
    def at(x, y):
        c = _at(rows, x, y)
        return c if c else '.'

    def span(c):
        return c in 'gk'
    deck = 'concrete' if concrete else PLANK_A
    rc = 'steel2' if concrete else '#3a2c1e'
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            if c == 'g':
                has_v = span(at(x, y - 1)) or span(at(x, y + 1))
                has_h = span(at(x - 1, y)) or span(at(x + 1, y))
                if has_v and has_h:
                    vertical = at(x, y - 1) == 'g' or at(x, y + 1) == 'g'
                else:
                    vertical = has_v or not has_h
                b.box(x, y, 1.0, 1.0, DECK_TOP, deck)
                if vertical:
                    for sx, nx in ((x, x - 1), (x + 0.92, x + 1)):
                        if not span(at(nx, y)):
                            b.box(sx, y, 0.08, 1.0, 0.18, rc, DECK_TOP)
                else:
                    for sy, ny in ((y, y - 1), (y + 0.92, y + 1)):
                        if not span(at(x, ny)):
                            b.box(x, sy, 1.0, 0.08, 0.18, rc, DECK_TOP)
            elif c == 'k':
                b.box(x, y, 1.0, 1.0, DECK_TOP, STONE)
            elif c == 'v':
                # A pier: a stone post standing in the water next to the deck.
                b.box(x + 0.3, y + 0.3, 0.4, 0.4, DECK_TOP, STONE)


def bridge(rows, concrete=False):
    h = len(rows)
    w = max(len(r) for r in rows)
    # Flat decks lie on their cells like the unsheared terrain: no ground shear, no foreshortening.
    return BuildingSpec(w, h, lambda b: _bridge(b, rows, concrete), damage=True, make=False, shear=False, flat=True)


def bridgehut(b, n):
    """The control hut at a bridge end: a steel booth with a flat dark roof and its beacon (3 shapes).
    n is 2 for the 2x2 hut and 1 for the small one."""
    f = b.front
    d = 0.5 * n
    b.block(b.x0 + 0.15 * n, f - d - 0.1 * n, b.x1 - b.x0 - 0.3 * n, d, '#8a8e93', h=0.42 * n)
    b.box(b.x0 + 0.1 * n, f - d - 0.15 * n, b.x1 - b.x0 - 0.2 * n, d + 0.1 * n, 0.05 * n, 'dark', 0.42 * n)
    b.cyl(b.x1 - 0.3 * n, f - d, 0.06 * n, 0.1 * n, 'yellow', 0.47 * n)


# ---- Declaration -----------------------------------------------------------------------------------


def _village(fn, w, d):
    return BuildingSpec(w, d, fn, damage=True, make=False)


def _prop(fn):
    return BuildingSpec(1, 1, fn, damage=False, make=False, shadow=True)


ACTORS = {
    'V20': _village(v20, 2, 2), 'V21': _village(v21, 2, 2), 'V22': _village(v22, 2, 1), 'V23': _village(v23, 1, 1),
    'V24': _village(v24, 2, 2), 'V25': _village(v25, 2, 2), 'V26': _village(v26, 2, 1), 'V27': _village(v27, 1, 1),
    'V28': _village(v28, 1, 1), 'V29': _village(v29, 1, 1), 'V30': _village(v30, 2, 1), 'V31': _village(v31, 2, 1),
    'V32': _village(v32, 2, 1), 'V33': _village(v33, 2, 1), 'V34': _village(v34, 1, 1), 'V35': _village(v35, 1, 1),
    'V36': _village(v36, 1, 1), 'V37': _village(v37, 5, 2),
    'RICE': _village(rice, 1, 1),
    'RUSHOUSE': _village(rushouse, 1, 2),
    'ASIANHUT': _village(asianhut, 1, 1),
    'SNOWHUT': _village(snowhut, 1, 2),
    'LHUS': _village(lhus, 1, 1),
    'WINDMILL': _village(windmill, 1, 1),
    'RAILMINE': BuildingSpec(2, 1, railmine, damage=True, make=False),
    'CTFLAG': _prop(ctflag),
    'BARL': _prop(barl),
    'BRL3': _prop(brl3),
    'AMMOBOX1': _prop(lambda b: ammobox(b, 1)),
    'AMMOBOX2': _prop(lambda b: ammobox(b, 2)),
    'AMMOBOX3': _prop(lambda b: ammobox(b, 3)),
    'UTILPOL1': _prop(lambda b: utilpol(b, 1)),
    'UTILPOL2': _prop(lambda b: utilpol(b, 2)),
    'TANKTRAP1': _prop(lambda b: tanktrap(b, 1)),
    'TANKTRAP2': _prop(lambda b: tanktrap(b, 2)),
    'MINE': _prop(lambda b: mine(b, False)),
    'GMINE': _prop(lambda b: mine(b, True)),
    'CYCL': _prop(cycl),
    'BARB': _prop(barb),
    'WOOD': _prop(wood),
    'BRIDGE1': bridge(BRIDGES['BRIDGE1']),
    'BRIDGE2': bridge(BRIDGES['BRIDGE2']),
    'BRIDGE3': bridge(BRIDGES['BRIDGE3']),
    'BRIDGE4': bridge(BRIDGES['BRIDGE4']),
    'SBRIDGE1': bridge(BRIDGES['SBRIDGE1']),
    'SBRIDGE2': bridge(BRIDGES['SBRIDGE2']),
    'SBRIDGE3': bridge(BRIDGES['SBRIDGE3']),
    'SBRIDGE4': bridge(BRIDGES['SBRIDGE4']),
    'BR1': bridge(BRIDGES['BR1']),
    'BR2': bridge(BRIDGES['BR2']),
    'BR3': bridge(BRIDGES['BR3']),
    'BRIDGEHUT': BuildingSpec(2, 2, lambda b: bridgehut(b, 2), damage=False, make=False),
    'BRIDGEHUT.small': BuildingSpec(1, 1, lambda b: bridgehut(b, 1), damage=False, make=False),
}
