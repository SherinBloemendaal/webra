"""Village buildings (V20 to V37), farm and landmark structures, map props (barrels, crates, poles, fences, mines,
flag) and the bridges with their huts.

Coordinates are cells (see core.Building). Props have no slab (ground=None) and no damaged or make pose; the
bridges have no slab either: the engine draws the deck over water cells, so the deck floats on its own beams."""
from core import P
from specs import BuildingSpec, Rng

DOOR = '#5a3a22'
GLASS = '#3b4d5c'
SAND = 'sand'


# ---- Shared helpers ------------------------------------------------------------------------------


def door(b, cx, y, w=0.16, h=0.32, c=DOOR, z=0.0):
    """A door on the south face (y is the face)."""
    b.bill(cx, y + 0.004, z, [(-w / 2, 0), (w / 2, 0), (w / 2, h), (-w / 2, h)], c)


def window(b, cx, y, z, w=0.13, h=0.13, c=GLASS, frame='paint'):
    b.bill(cx, y + 0.004, z - 0.02, [(-w / 2 - 0.02, 0), (w / 2 + 0.02, 0), (w / 2 + 0.02, h + 0.04), (-w / 2 - 0.02, h + 0.04)], frame)
    b.bill(cx, y + 0.008, z, [(-w / 2, 0), (w / 2, 0), (w / 2, h), (-w / 2, h)], c)


def windows(b, x, y, w, h_wall, count, skip_centre=True, size=0.13):
    """Evenly spaced windows on the south face; the centre slot stays free for the door when asked."""
    for k in range(count):
        if skip_centre and count % 2 == 1 and k == count // 2:
            continue
        cx = x + w * (k + 0.5) / count
        window(b, cx, y, h_wall * 0.5, size, size)


def house(b, x, y, w, d, h, wall, roof, kind='flat', rh=0.3, axis=None, nwin=None, door_at=0.5, trim=None, z=0.0):
    """A house box with a roof: 'flat' (parapet), 'gable', 'pyramid' or 'dome'. Returns the roof height."""
    b.box(x, y, w, d, h, wall, z)
    top = z + h
    if kind == 'flat':
        rim = trim or wall
        b.box(x - 0.03, y - 0.03, w + 0.06, d + 0.06, 0.05, rim, top)
        b.flat([(x + 0.06, y + 0.06), (x + w - 0.06, y + 0.06), (x + w - 0.06, y + d - 0.06), (x + 0.06, y + d - 0.06)], top + 0.052, roof)
        top += 0.05
    elif kind == 'gable':
        ax = axis or ('x' if w >= d else 'y')
        b.gable(x - 0.06, y - 0.06, w + 0.12, d + 0.12, rh, roof, top, ax)
        top += rh
    elif kind == 'pyramid':
        b.pyramid(x + w / 2, y + d / 2, w / 2 + 0.06, d / 2 + 0.06, rh, roof, top)
        top += rh
    elif kind == 'dome':
        b.box(x - 0.03, y - 0.03, w + 0.06, d + 0.06, 0.05, wall, top)
        top += 0.05
        r = min(w, d) * 0.4
        b.vdome(x + w / 2, y + d / 2, r, r * 1.2, roof, top)
        top += r * 1.2
    door(b, x + w * door_at, y + d, 0.15, min(0.34, h * 0.7), z=z)
    n = nwin if nwin is not None else max(1, int(round(w / 0.5)))
    if h > 0.4 and w > 0.4:
        for k in range(n):
            cx = x + w * (k + 0.5) / n
            if abs(cx - (x + w * door_at)) < 0.2:
                continue
            window(b, cx, y + d, z + h * 0.45, 0.11, 0.12)
    return top


def stripes(b, x, y, w, d, rh, z, axis, side, n, c):
    """Tile rows on a gable roof: n thin bands from ridge to eaves."""
    for k in range(n):
        f0 = (k + 0.5) / n
        b.band(x, y, w, d, rh, z, axis, side, f0, f0 + 0.5 / n, c)


def crate(b, x, y, s, c='wood', z=0.0, h=None, lid='#c99a5a'):
    b.box(x, y, s, s, h or s, c, z)
    b.box(x + s * 0.12, y + s * 0.12, s * 0.76, s * 0.76, 0.012, lid, z + (h or s))


def jar(b, cx, cy, r, h, c='#a8542e', z=0.0):
    b.cyl(cx, cy, r, h, c, z)
    b.cyl(cx, cy, r * 0.6, 0.03, '#2e3238', z + h)


def pad(b, x, y, w, d, c='dirt', h=0.03):
    b.box(x, y, w, d, h, c)


def fence_posts(b, y, xs, h, c, depth=0.05):
    for x in xs:
        b.box(x - 0.03, y, 0.06, depth, h, c)


# ---- Village buildings (desert adobes and friends) -------------------------------------------------

ADOBE1, ADOBE2, ADOBE3 = '#d8c19a', '#c9a878', '#e2cfa8'


def v20(b):
    # Courtyard house: two-storey back block, a walled yard with a well and a gate.
    pad(b, 0.1, 0.1, 1.8, 1.8, 'sandy', 0.02)
    house(b, 0.2, 0.2, 1.6, 0.9, 0.7, ADOBE1, '#a48a64', 'flat', trim='#e9dcc0', nwin=3)
    b.box(0.5, 0.4, 0.4, 0.4, 0.28, ADOBE2, 0.75)
    b.box(0.2, 1.7, 0.55, 0.08, 0.28, ADOBE2)
    b.box(1.25, 1.7, 0.55, 0.08, 0.28, ADOBE2)
    b.box(0.2, 1.2, 0.08, 0.58, 0.28, ADOBE2)
    b.box(1.72, 1.2, 0.08, 0.58, 0.28, ADOBE2)
    b.cyl(1.35, 1.4, 0.14, 0.2, 'concrete')
    b.cyl(1.35, 1.4, 0.09, 0.02, 'water', 0.2)
    b.box(0.35, 1.35, 0.3, 0.2, 0.14, 'wood')


def v21(b):
    # Brick house with a tiled gable roof, a chimney and a wooden porch.
    house(b, 0.2, 0.15, 1.6, 1.1, 0.6, P['brick'], P['tiles'], 'gable', rh=0.42, axis='x', door_at=0.3, nwin=3)
    stripes(b, 0.14, 0.09, 1.72, 1.22, 0.42, 0.6, 'x', 'a', 4, '#8c3424')
    b.box(1.35, 0.38, 0.16, 0.16, 0.5, 'concrete', 0.6)
    b.box(1.33, 0.36, 0.2, 0.2, 0.05, 'dark', 1.1)
    b.box(0.2, 1.35, 0.7, 0.4, 0.04, 'wood')
    for x in (0.22, 0.8):
        b.box(x, 1.68, 0.06, 0.06, 0.34, 'wood', 0.04)
    b.box(0.18, 1.62, 0.76, 0.16, 0.04, '#8a5a2a', 0.38)


def v22(b):
    house(b, 0.1, 0.15, 1.8, 0.65, 0.4, P['wall'], P['tiles'], 'gable', rh=0.3, axis='x', door_at=0.5, nwin=4)
    stripes(b, 0.04, 0.09, 1.92, 0.77, 0.3, 0.4, 'x', 'a', 3, '#8c3424')
    b.box(0.1, 0.84, 1.8, 0.1, 0.04, 'wood')


def v23(b):
    # Tiny cube house with a ladder to the roof and a water jar.
    house(b, 0.15, 0.2, 0.62, 0.55, 0.5, ADOBE3, '#a48a64', 'flat', trim='#efe4cc', nwin=1)
    b.box(0.78, 0.34, 0.05, 0.05, 0.62, 'wood')
    b.box(0.86, 0.34, 0.05, 0.05, 0.62, 'wood')
    for z in (0.15, 0.3, 0.45):
        b.box(0.78, 0.35, 0.13, 0.03, 0.03, 'wood', z)
    jar(b, 0.2, 0.85, 0.07, 0.16)


def v24(b):
    # Large two-storey house with a corner tower and a striped awning.
    house(b, 0.15, 0.2, 1.7, 1.2, 0.62, ADOBE2, '#a48a64', 'flat', trim='#e9dcc0', nwin=4)
    b.box(0.3, 0.4, 0.9, 0.55, 0.3, ADOBE1, 0.67)
    b.box(0.27, 0.37, 0.96, 0.61, 0.04, '#e9dcc0', 0.97)
    b.cyl(1.55, 0.5, 0.2, 1.15, ADOBE1)
    b.cyl(1.55, 0.5, 0.24, 0.07, '#e9dcc0', 1.15)
    b.box(1.5, 0.62, 0.1, 0.01, 0.18, GLASS, 0.7)
    for i in range(4):
        b.box(0.4 + i * 0.16, 1.4, 0.16, 0.3, 0.04, 'red' if i % 2 == 0 else 'paint', 0.34 + 0.0)
    for x in (0.4, 1.0):
        b.box(x, 1.66, 0.04, 0.04, 0.34, 'wood')


def v25(b):
    # Desert church: a nave with a dome and a bell tower with a gold cross.
    house(b, 0.25, 0.55, 1.5, 1.2, 0.5, '#dcc9a0', '#e9e2cf', 'dome')
    b.box(0.85, 1.76, 0.3, 0.01, 0.0, 'paint')
    b.bill(1.0, 1.766, 0.0, [(-0.13, 0), (0.13, 0), (0.13, 0.28), (0.0, 0.38), (-0.13, 0.28)], DOOR)
    b.box(1.3, 0.2, 0.34, 0.34, 0.95, '#d8c7a0')
    b.box(1.27, 0.17, 0.4, 0.4, 0.05, '#e9e2cf', 0.95)
    b.box(1.37, 0.27, 0.2, 0.2, 0.2, '#e9e2cf', 1.0)
    b.box(1.46, 0.36, 0.03, 0.03, 0.28, 'gold', 1.2)
    b.bill(1.475, 0.375, 1.38, [(-0.07, 0), (0.07, 0), (0.07, 0.03), (-0.07, 0.03)], 'gold')
    b.bill(1.47, 0.58, 0.55, [(-0.04, 0), (0.04, 0), (0.04, 0.2), (-0.04, 0.2)], '#3a2c20')
    for cx in (0.45, 1.55):
        window(b, cx, 1.75, 0.2, 0.1, 0.18, '#2e3d55')


def v26(b):
    # Shop with a striped awning and crates in front.
    house(b, 0.1, 0.1, 1.8, 0.6, 0.52, ADOBE1, '#a48a64', 'flat', trim='#efe4cc', door_at=0.75, nwin=2)
    for i in range(6):
        b.box(0.12 + i * 0.12, 0.7, 0.12, 0.2, 0.03, 'red' if i % 2 == 0 else 'paint', 0.34)
    crate(b, 0.25, 0.86, 0.1, 'wood')
    crate(b, 0.4, 0.88, 0.08, '#8a5a2a')


def v27(b):
    # Round hut with a thatched pyramid roof.
    b.cyl(0.5, 0.52, 0.32, 0.4, ADOBE2)
    b.pyramid(0.5, 0.52, 0.42, 0.42, 0.34, 'sandy', 0.4)
    door(b, 0.5, 0.83, 0.14, 0.26)


def v28(b):
    # A small domed house with a front step.
    house(b, 0.18, 0.2, 0.64, 0.6, 0.38, '#e9e2cf', '#7fbbd4', 'dome', door_at=0.5, nwin=0)
    b.box(0.38, 0.8, 0.24, 0.1, 0.05, 'concrete')


def v29(b):
    # A watch tower: round, tapered, with a flat lookout and a flag-less mast.
    b.cyl(0.5, 0.5, 0.3, 0.6, ADOBE2)
    b.cyl(0.5, 0.5, 0.26, 0.45, ADOBE1, 0.6)
    b.cyl(0.5, 0.5, 0.33, 0.07, '#e9dcc0', 1.05)
    b.box(0.35, 0.78, 0.3, 0.01, 0.0, ADOBE1)
    b.bill(0.5, 0.806, 0.0, [(-0.07, 0), (0.07, 0), (0.07, 0.22), (-0.07, 0.22)], DOOR)
    b.bill(0.5, 0.775, 0.7, [(-0.05, 0), (0.05, 0), (0.05, 0.12), (-0.05, 0.12)], GLASS)
    b.box(0.49, 0.49, 0.03, 0.03, 0.3, 'wood', 1.12)


def v30(b):
    # Two joined houses, a taller one and a lower one.
    house(b, 0.1, 0.12, 1.0, 0.7, 0.55, ADOBE1, '#a48a64', 'flat', trim='#efe4cc', door_at=0.6, nwin=2)
    house(b, 1.1, 0.25, 0.8, 0.57, 0.36, ADOBE3, '#a48a64', 'flat', trim='#efe4cc', door_at=0.5, nwin=1)
    b.box(0.2, 0.2, 0.28, 0.25, 0.2, ADOBE2, 0.6)


def v31(b):
    # Plank house with a tile roof.
    house(b, 0.12, 0.15, 1.76, 0.65, 0.4, P['wood'], P['tiles'], 'gable', rh=0.32, axis='x', door_at=0.25, nwin=3)
    stripes(b, 0.06, 0.09, 1.88, 0.77, 0.32, 0.4, 'x', 'a', 3, '#8c3424')
    for i in range(7):
        b.box(0.12 + i * 0.25, 0.8, 0.02, 0.005, 0.4, '#8d5f2e')
    b.box(1.55, 0.22, 0.14, 0.14, 0.42, 'concrete', 0.4)


def v32(b):
    # Barn: wide gable roof and a big double door.
    house(b, 0.1, 0.12, 1.8, 0.7, 0.42, P['brick'], '#7a5a3a', 'gable', rh=0.38, axis='x', door_at=0.5, nwin=0)
    b.bill(1.0, 0.824, 0.0, [(-0.25, 0), (0.25, 0), (0.25, 0.34), (-0.25, 0.34)], '#5a3a22')
    b.bill(1.0, 0.828, 0.0, [(-0.015, 0), (0.015, 0), (0.015, 0.34), (-0.015, 0.34)], 'paint')
    b.beam((0.75, 0.83, 0.0), (1.25, 0.83, 0.34), 0.02, 'paint')
    b.beam((1.25, 0.83, 0.0), (0.75, 0.83, 0.34), 0.02, 'paint')


def v33(b):
    # Market: two stalls under canvas awnings with goods.
    for k, (c1, c2) in enumerate((('red', 'paint'), ('#4a8cf0', 'paint'))):
        x0 = 0.12 + k * 0.95
        for dx, dy in ((0, 0), (0.7, 0), (0, 0.5), (0.7, 0.5)):
            b.box(x0 + dx, 0.18 + dy, 0.05, 0.05, 0.4, 'wood')
        for i in range(5):
            b.box(x0 - 0.05 + i * 0.16, 0.14, 0.16, 0.66, 0.04, c1 if i % 2 == 0 else c2, 0.4)
        b.box(x0 + 0.05, 0.35, 0.65, 0.22, 0.17, 'wood')
        crate(b, x0 + 0.1, 0.38, 0.1, '#8a5a2a', 0.17, 0.06)
        b.cyl(x0 + 0.45, 0.46, 0.06, 0.05, 'orange', 0.17)
        b.cyl(x0 + 0.58, 0.46, 0.06, 0.05, 'green', 0.17)


def v34(b):
    # Round tiled hut with a tall pointed roof.
    b.cyl(0.5, 0.5, 0.3, 0.36, '#e9e2cf')
    b.pyramid(0.5, 0.5, 0.4, 0.4, 0.42, P['tiles'], 0.36)
    door(b, 0.5, 0.8, 0.13, 0.24)


def v35(b):
    # A small brick house with a tiled roof.
    house(b, 0.14, 0.18, 0.72, 0.6, 0.38, P['brick'], P['tiles'], 'gable', rh=0.3, axis='x', nwin=1, door_at=0.35)
    stripes(b, 0.08, 0.12, 0.84, 0.72, 0.3, 0.38, 'x', 'a', 2, '#8c3424')


def v36(b):
    # Stepped adobe: two levels with a stair up the side.
    house(b, 0.14, 0.3, 0.72, 0.55, 0.36, ADOBE2, '#a48a64', 'flat', trim='#efe4cc', nwin=1)
    b.box(0.3, 0.35, 0.4, 0.3, 0.26, ADOBE1, 0.41)
    b.box(0.27, 0.32, 0.46, 0.36, 0.04, '#efe4cc', 0.67)
    for i in range(3):
        b.box(0.7, 0.62 - i * 0.07, 0.14, 0.07, 0.1 + i * 0.1, 'concrete')


def v37(b):
    # Irregular 5x2 footprint: two houses, one over cells (2,0) (3,0), the other over (3,1) (4,1).
    for x, y in ((2.0, 0.0), (3.0, 1.0)):
        b.box(x, y, 2, 1, 0.18, SAND, -0.18)
    house(b, 2.2, 0.15, 1.6, 0.7, 0.5, ADOBE1, '#a48a64', 'flat', trim='#efe4cc', nwin=3)
    b.cyl(3.55, 0.35, 0.18, 0.95, ADOBE1)
    b.cyl(3.55, 0.35, 0.22, 0.06, '#efe4cc', 0.95)
    house(b, 3.2, 1.15, 1.6, 0.7, 0.4, ADOBE3, '#a48a64', 'flat', trim='#efe4cc', door_at=0.3, nwin=2)
    b.box(4.4, 1.28, 0.3, 0.2, 0.22, ADOBE2, 0.45)
    crate(b, 3.05, 0.78, 0.1)


# ---- Farm, landmarks -------------------------------------------------------------------------------


def rice(b):
    b.box(0.08, 0.08, 0.84, 0.84, 0.05, 'dirt')
    b.box(0.14, 0.14, 0.72, 0.72, 0.03, 'water', 0.05)
    for i in range(5):
        for j in range(5):
            if (i + j) % 2 == 0 or j % 2 == 0:
                b.box(0.2 + i * 0.14, 0.2 + j * 0.14, 0.05, 0.05, 0.12 + 0.02 * ((i * 3 + j) % 3), '#7caa48' if (i + j) % 2 else '#5f8a36', 0.08)
    b.box(0.08, 0.08, 0.84, 0.03, 0.09, 'dirt')


def rushouse(b):
    house(b, 0.2, 0.2, 0.6, 1.5, 0.4, '#7a5a3a', '#4d4438', 'gable', rh=0.26, axis='y', door_at=0.5, nwin=1)
    for i in range(5):
        b.box(0.2, 0.26 + i * 0.28, 0.005, 0.02, 0.4, '#5a3e24')
    b.box(0.56, 1.0, 0.14, 0.14, 0.4, 'concrete', 0.4)
    b.box(0.54, 0.98, 0.18, 0.18, 0.04, 'dark', 0.8)


def snowhut(b):
    house(b, 0.2, 0.2, 0.6, 1.5, 0.38, '#8a6a4a', '#e8eef4', 'gable', rh=0.24, axis='y', door_at=0.5, nwin=1)
    b.box(0.5, 0.35, 0.16, 0.16, 0.38, 'concrete', 0.38)
    b.box(0.48, 0.33, 0.2, 0.2, 0.06, 'ice2', 0.76)
    b.box(0.05, 1.75, 0.2, 0.2, 0.05, 'ice2')
    b.box(0.75, 1.65, 0.2, 0.25, 0.07, 'ice2')


def asianhut(b):
    # Two-step pagoda roof on red posts.
    b.box(0.15, 0.2, 0.7, 0.6, 0.36, '#b9a27a')
    for x in (0.15, 0.81):
        b.box(x, 0.78, 0.05, 0.05, 0.36, 'red')
    door(b, 0.5, 0.8, 0.14, 0.26, '#7a2a1a')
    b.box(0.08, 0.12, 0.84, 0.76, 0.04, '#8a6a1c', 0.36)
    b.pyramid(0.5, 0.5, 0.42, 0.38, 0.2, '#c9a83e', 0.4)
    b.box(0.3, 0.32, 0.4, 0.36, 0.1, '#b9a27a', 0.58)
    b.pyramid(0.5, 0.5, 0.3, 0.27, 0.16, '#c9a83e', 0.68)
    b.box(0.485, 0.485, 0.03, 0.03, 0.1, 'gold', 0.84)


def lhus(b):
    b.cyl(0.5, 0.5, 0.36, 0.06, 'concrete')
    b.cyl(0.5, 0.5, 0.28, 0.55, '#ece6d6', 0.06)
    b.cyl(0.5, 0.5, 0.285, 0.18, 'red', 0.61)
    b.cyl(0.5, 0.5, 0.24, 0.5, '#ece6d6', 0.79)
    b.cyl(0.5, 0.5, 0.245, 0.18, 'red', 1.12)
    b.cyl(0.5, 0.5, 0.2, 0.3, '#ece6d6', 1.29)
    b.cyl(0.5, 0.5, 0.34, 0.05, 'dark', 1.59)
    b.cyl(0.5, 0.5, 0.15, 0.2, 'glow', 1.64, emit=True)
    b.cyl(0.5, 0.5, 0.21, 0.05, 'dark', 1.84)
    b.cyl(0.5, 0.5, 0.13, 0.12, 'red', 1.89)
    b.cyl(0.5, 0.5, 0.05, 0.1, 'red', 2.01)
    door(b, 0.5, 0.78, 0.1, 0.18)


def windmill(b):
    b.cyl(0.5, 0.55, 0.34, 0.1, 'concrete')
    b.cyl(0.5, 0.55, 0.3, 0.55, '#b8a888', 0.1)
    b.cyl(0.5, 0.55, 0.25, 0.4, '#b8a888', 0.65)
    b.cyl(0.5, 0.55, 0.3, 0.06, '#8a3a2a', 1.05)
    b.pyramid(0.5, 0.55, 0.26, 0.26, 0.3, '#8a3a2a', 1.11)
    door(b, 0.5, 0.86, 0.12, 0.22)
    # Hub on the south face, four blades in an X, sails in canvas.
    hx, hy, hz = 0.5, 0.9, 0.95
    b.cyl(hx, hy, 0.05, 0.1, '#4a3420', hz - 0.05, top=True)
    tips = ((-0.42, 0.42), (0.42, 0.42), (0.42, -0.42), (-0.42, -0.42))
    for tx, tz in tips:
        b.beam((hx, hy + 0.05, hz), (hx + tx, hy + 0.05, hz + tz), 0.03, '#4a3420')
        nx, nz = tx * 0.22, tz * 0.22
        px, pz = -tz * 0.22, tx * 0.22
        b.poly([(hx + nx + px * 0.4, hy + 0.07, hz + nz + pz * 0.4), (hx + tx + px * 0.4, hy + 0.07, hz + tz + pz * 0.4),
                (hx + tx * 0.9 + px * 1.2, hy + 0.07, hz + tz * 0.9 + pz * 1.2), (hx + nx * 1.5 + px * 1.2, hy + 0.07, hz + nz * 1.5 + pz * 1.2)],
               '#efe9d6')


def railmine(b):
    # Abandoned mine: dirt yard, rails and sleepers, a ramshackle shed with a dark mouth, an ore cart.
    b.box(0.0, 0.05, 2.0, 0.9, 0.04, '#5a4a3a')
    for i in range(10):
        b.box(0.12 + i * 0.18, 0.5, 0.07, 0.34, 0.03, '#4a3420', 0.04)
    for y in (0.56, 0.76):
        b.box(0.05, y, 1.2, 0.03, 0.03, '#8a8e93', 0.07)
    b.box(1.15, 0.12, 0.7, 0.55, 0.42, '#6b5a44')
    b.box(1.1, 0.07, 0.8, 0.65, 0.05, '#4a3a2a', 0.42)
    b.gable(1.1, 0.07, 0.8, 0.65, 0.18, '#7a6850', 0.47, 'x')
    b.bill(1.5, 0.674, 0.0, [(-0.2, 0), (0.2, 0), (0.2, 0.3), (0.12, 0.38), (-0.12, 0.38), (-0.2, 0.3)], '#1a1410')
    for x in (1.28, 1.7):
        b.box(x, 0.66, 0.05, 0.03, 0.4, 'wood')
    b.box(0.35, 0.52, 0.32, 0.25, 0.13, 'rust', 0.1)
    b.box(0.37, 0.54, 0.28, 0.21, 0.02, '#3a2c20', 0.23)
    for k, (ox, oy) in enumerate(((0.4, 0.58), (0.52, 0.62), (0.46, 0.55))):
        b.box(0.37 + (ox - 0.37) * 0.8, oy - 0.02, 0.06, 0.06, 0.05, 'steel' if k % 2 else 'dark', 0.23)


def ctflag(b):
    b.box(0.3, 0.45, 0.4, 0.3, 0.1, 'concrete')
    b.cyl(0.5, 0.6, 0.025, 1.1, 'steel2', 0.1)
    b.cyl(0.5, 0.6, 0.05, 0.04, 'gold', 1.2)
    b.poly([(0.52, 0.6, 1.15), (0.9, 0.6, 1.0), (0.52, 0.6, 0.78)], 'T')
    b.poly([(0.52, 0.6, 1.15), (0.9, 0.6, 1.0), (0.52, 0.6, 1.0)], 'T')


# ---- Props -----------------------------------------------------------------------------------------


def barrel(b, cx, cy, c='#a8321e', top='#d9433a'):
    b.cyl(cx, cy, 0.15, 0.4, c)
    b.cyl(cx, cy, 0.158, 0.03, '#6c1c10', 0.08)
    b.cyl(cx, cy, 0.158, 0.03, '#6c1c10', 0.29)
    b.cyl(cx, cy, 0.1, 0.012, top, 0.4)


def barl(b):
    barrel(b, 0.5, 0.55)


def brl3(b):
    barrel(b, 0.3, 0.38)
    barrel(b, 0.7, 0.38, '#8a6a2a', '#b89038')
    barrel(b, 0.5, 0.7)


def ammobox(b, n):
    def one(x, y, w, d, h, z=0.0):
        b.box(x, y, w, d, h, '#5c6a3a', z)
        b.box(x - 0.01, y - 0.01, w + 0.02, 0.04, 0.03, '#3a4424', z + h * 0.45)
        b.box(x + w * 0.2, y + d * 0.2, w * 0.6, d * 0.6, 0.012, '#c9b02c', z + h)
        b.bill(x + w * 0.5, y + d + 0.003, z + h * 0.3, [(-0.06, 0), (0.06, 0), (0.06, 0.07), (-0.06, 0.07)], '#c9b02c')
    if n == 1:
        one(0.2, 0.35, 0.6, 0.4, 0.3)
    elif n == 2:
        one(0.12, 0.5, 0.5, 0.35, 0.28)
        one(0.5, 0.3, 0.42, 0.34, 0.24)
    else:
        one(0.1, 0.55, 0.45, 0.3, 0.26)
        one(0.52, 0.5, 0.4, 0.3, 0.26)
        one(0.28, 0.32, 0.42, 0.3, 0.26, 0.0)
        one(0.3, 0.38, 0.38, 0.26, 0.2, 0.26)


def utilpol(b, n):
    b.cyl(0.5, 0.6, 0.04, 1.55, '#6b4a2a')
    b.box(0.25, 0.575, 0.5, 0.05, 0.05, '#4a3420', 1.35)
    for dx in (-0.2, 0.0, 0.2):
        b.cyl(0.5 + dx, 0.6, 0.025, 0.07, 'paint', 1.4)
    b.box(0.35, 0.585, 0.3, 0.03, 0.03, '#4a3420', 1.1)
    b.box(0.46, 0.62, 0.08, 0.02, 0.04, 'dark', 0.85)
    if n == 2:
        b.box(0.4, 0.5, 0.2, 0.17, 0.2, 'steel', 0.65)
        b.box(0.4, 0.5, 0.2, 0.17, 0.02, 'dark', 0.85)


def tanktrap(b, n):
    def hedgehog(cx, cy, s=1.0):
        h = 0.34 * s
        b.beam((cx - h, cy, 0.05), (cx + h, cy, 0.05 + 2 * h * 0.0 + 0.5 * s), 0.07 * s, '#6a6e72')
        b.beam((cx + h, cy, 0.05), (cx - h, cy, 0.05 + 0.5 * s), 0.07 * s, '#6a6e72')
        b.beam((cx, cy - h * 0.9, 0.25 * s), (cx, cy + h * 0.9, 0.25 * s + 0.0), 0.07 * s, '#8a8e93')
        b.box(cx - 0.05, cy - 0.05, 0.1, 0.1, 0.04, '#4a4c50')
    if n == 1:
        hedgehog(0.5, 0.55)
    else:
        hedgehog(0.3, 0.45, 0.8)
        hedgehog(0.7, 0.62, 0.8)


def mine(b, gems):
    # A low mound with ore nuggets or crystals sticking out.
    b.vdome(0.5, 0.52, 0.34, 0.22, '#6c5a44')
    rng = Rng(17 if gems else 5)
    cols = ('#5a8ae0', '#b03a9a', '#3ad0b0') if gems else ('#ffd34d', '#e2bd52')
    for k in range(7):
        x = 0.25 + rng.next() * 0.5
        y = 0.3 + rng.next() * 0.45
        z = 0.12 + rng.next() * 0.1
        s = 0.07 + rng.next() * 0.03
        if gems:
            b.box(x, y, s, s, s * 1.3, cols[k % 3], z)
        else:
            b.cyl(x, y, s * 0.6, s, cols[k % 2], z, n=6)


def cycl(b):
    # Chain-link fence across the cell: posts, a top rail and a see-through mesh.
    y = 0.5
    b.box(0.0, y - 0.02, 1.0, 0.04, 0.04, '#e4e8ea', 0.42)
    b.box(0.0, y - 0.01, 1.0, 0.02, 0.02, '#8a8e93', 0.04)
    b.box(0.0, y - 0.004, 1.0, 0.008, 0.38, '#c8d0d6', 0.04, a=0.3)
    for x in (0.0, 0.5, 0.94):
        b.box(x, y - 0.03, 0.06, 0.06, 0.46, '#55585c')
    for i in range(1, 6):
        b.beam((i / 6.0 - 0.1, y + 0.01, 0.06), (i / 6.0 + 0.1, y + 0.01, 0.4), 0.012, '#7d8a96', a=0.8)


def barb(b):
    # Barbed wire: low posts and two coils.
    y = 0.5
    for x in (0.05, 0.5, 0.92):
        b.box(x, y - 0.025, 0.05, 0.05, 0.3, '#55585c')
    for z, c in ((0.08, '#8a8e93'), (0.2, '#55585c')):
        for i in range(10):
            xx = i * 0.1
            b.box(xx, y - 0.03, 0.09, 0.06, 0.06, '#3c3f43' if (i + int(z * 10)) % 2 else '#7d8a96', z)
    for i in range(8):
        b.box(0.04 + i * 0.125, y - 0.04, 0.02, 0.08, 0.02, '#c8cdd0', 0.28)


def wood(b):
    # Wooden fence: posts and two rails.
    y = 0.5
    for z in (0.1, 0.25):
        b.box(0.0, y - 0.02, 1.0, 0.04, 0.06, '#a07448', z)
    for x in (0.02, 0.48, 0.94):
        b.box(x, y - 0.035, 0.06, 0.07, 0.38, '#6b4a2a')
        b.box(x - 0.005, y - 0.04, 0.07, 0.08, 0.03, '#a07448', 0.38)


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
    def at(x, y):
        c = _at(rows, x, y)
        return c if c else '.'

    def span(c):
        return c in 'gk'
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            if c == 'g':
                has_v = span(at(x, y - 1)) or span(at(x, y + 1))
                has_h = span(at(x - 1, y)) or span(at(x + 1, y))
                if has_v and has_h:
                    vertical = at(x, y - 1) == 'g' or at(x, y + 1) == 'g'
                else:
                    vertical = has_v or not has_h
                # Beams under the deck, then the deck itself.
                if vertical:
                    for dx in (0.08, 0.76):
                        b.box(x + dx, y, 0.16, 1.0, 0.1, 'dark')
                else:
                    for dy in (0.08, 0.76):
                        b.box(x, y + dy, 1.0, 0.16, 0.1, 'dark')
                if concrete:
                    b.box(x, y, 1.0, 1.0, DECK_TOP - 0.1, 'concrete', 0.1)
                    for k in range(1, 4):
                        if vertical:
                            b.flat([(x + 0.46, y + k * 0.25), (x + 0.54, y + k * 0.25), (x + 0.54, y + k * 0.25 + 0.1), (x + 0.46, y + k * 0.25 + 0.1)], DECK_TOP + 0.002, 'yellow')
                        else:
                            b.flat([(x + k * 0.25, y + 0.46), (x + k * 0.25 + 0.1, y + 0.46), (x + k * 0.25 + 0.1, y + 0.54), (x + k * 0.25, y + 0.54)], DECK_TOP + 0.002, 'yellow')
                else:
                    b.box(x, y, 1.0, 1.0, DECK_TOP - 0.1, PLANK_B, 0.1)
                    for k in range(5):
                        if vertical:
                            b.flat([(x + 0.02, y + k * 0.2 + 0.02), (x + 0.98, y + k * 0.2 + 0.02), (x + 0.98, y + k * 0.2 + 0.18), (x + 0.02, y + k * 0.2 + 0.18)],
                                   DECK_TOP + 0.002, PLANK_A if k % 2 else '#b88c5c')
                        else:
                            b.flat([(x + k * 0.2 + 0.02, y + 0.02), (x + k * 0.2 + 0.18, y + 0.02), (x + k * 0.2 + 0.18, y + 0.98), (x + k * 0.2 + 0.02, y + 0.98)],
                                   DECK_TOP + 0.002, PLANK_A if k % 2 else '#b88c5c')
                # Rails along the deck sides where the deck does not widen.
                rc = 'steel2' if concrete else '#3a2c1e'
                if vertical:
                    for sx, nx in ((x, x - 1), (x + 0.94, x + 1)):
                        if not span(at(nx, y)):
                            b.box(sx, y, 0.06, 1.0, 0.04, rc, DECK_TOP + 0.2)
                            for o in (0.0, 0.47, 0.94):
                                b.box(sx, y + o, 0.06, 0.06, 0.24, rc, DECK_TOP)
                else:
                    for sy, ny in ((y, y - 1), (y + 0.94, y + 1)):
                        if not span(at(x, ny)):
                            b.box(x, sy, 1.0, 0.06, 0.04, rc, DECK_TOP + 0.2)
                            for o in (0.0, 0.47, 0.94):
                                b.box(x + o, sy, 0.06, 0.06, 0.24, rc, DECK_TOP)
            elif c == 'k':
                b.box(x + 0.02, y + 0.02, 0.96, 0.96, DECK_TOP, STONE)
                b.box(x + 0.02, y + 0.02, 0.96, 0.96, 0.025, '#6b665c', DECK_TOP * 0.55)
                b.box(x + 0.1, y + 0.1, 0.8, 0.8, 0.02, 'concrete', DECK_TOP)
            elif c == 'v':
                # A pier: a stone post standing in the water next to the deck.
                b.box(x + 0.34, y + 0.34, 0.32, 0.32, DECK_TOP - 0.02, STONE)
                b.box(x + 0.3, y + 0.3, 0.4, 0.4, 0.04, 'concrete', DECK_TOP - 0.02)


def bridge(rows, concrete=False):
    h = len(rows)
    w = max(len(r) for r in rows)
    return BuildingSpec(w, h, lambda b: _bridge(b, rows, concrete), ground=None, damage=True, make=False,
                        shear=False)  # flat decks meet the unsheared terrain: no ground shear


def bridgehut(b, n):
    """The control hut at a bridge end: a steel booth with a flat roof, a door, a window and a beacon.
    n is 2 for the 2x2 hut and 1 for the small one."""
    x0, y0, w, d = 0.5 * n - 0.3 * n, 0.5 * n - 0.28 * n, 0.6 * n, 0.5 * n
    b.box(x0, y0, w, d, 0.44, '#8a8e93')
    b.box(x0 - 0.04, y0 - 0.04, w + 0.08, d + 0.08, 0.05, 'dark', 0.44)
    door(b, x0 + w * 0.3, y0 + d, 0.14, 0.26, '#2e3238')
    window(b, x0 + w * 0.7, y0 + d, 0.22, 0.12, 0.12, '#6ec6e6')
    b.cyl(x0 + w * 0.8, y0 + d * 0.3, 0.06, 0.1, 'yellow', 0.49)


# ---- Declaration -----------------------------------------------------------------------------------


def _village(fn, w, d, ground=SAND):
    return BuildingSpec(w, d, fn, ground=ground, damage=True, make=False)


def _prop(fn, ground=None):
    return BuildingSpec(1, 1, fn, ground=ground, damage=False, make=False, shadow=True)


ACTORS = {
    'V20': _village(v20, 2, 2), 'V21': _village(v21, 2, 2), 'V22': _village(v22, 2, 1), 'V23': _village(v23, 1, 1),
    'V24': _village(v24, 2, 2), 'V25': _village(v25, 2, 2), 'V26': _village(v26, 2, 1), 'V27': _village(v27, 1, 1),
    'V28': _village(v28, 1, 1), 'V29': _village(v29, 1, 1), 'V30': _village(v30, 2, 1), 'V31': _village(v31, 2, 1),
    'V32': _village(v32, 2, 1), 'V33': _village(v33, 2, 1), 'V34': _village(v34, 1, 1), 'V35': _village(v35, 1, 1),
    'V36': _village(v36, 1, 1), 'V37': BuildingSpec(5, 2, v37, ground=None, damage=True, make=False),
    'RICE': _village(rice, 1, 1, 'grass'),
    'RUSHOUSE': _village(rushouse, 1, 2, 'grass'),
    'ASIANHUT': _village(asianhut, 1, 1, 'grass'),
    'SNOWHUT': _village(snowhut, 1, 2, 'ice2'),
    'LHUS': _village(lhus, 1, 1, 'grass'),
    'WINDMILL': _village(windmill, 1, 1, 'grass'),
    'RAILMINE': BuildingSpec(2, 1, railmine, ground='dirt', damage=True, make=False),
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
    'BRIDGEHUT': BuildingSpec(2, 2, lambda b: bridgehut(b, 2), ground=None, damage=False, make=False),
    'BRIDGEHUT.small': BuildingSpec(1, 1, lambda b: bridgehut(b, 1), ground=None, damage=False, make=False),
}
