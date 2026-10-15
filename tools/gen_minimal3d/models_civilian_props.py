"""Tech buildings and the civilian village: Forward Command, hospital, biological lab, communications center, oil
derrick, the village houses V01 to V11, haystacks, fields and the oil pump (with its burnt husk).

Coordinates are cells, see core.Building. Civilian structures are never team coloured (OpenRA draws them with fixed
palettes), the tech buildings carry a team stripe. Helpers at the top build the recurring pieces (house, window,
fence); the actors below are parameterised variants of them."""
from specs import BuildingSpec, Rng

# ---- Helpers -------------------------------------------------------------------------------------


def window(b, x, y, z, w=0.14, h=0.14, glass='glass', frame='paint'):
    """A framed window on a south face standing at the wall line y."""
    b.box(x - 0.025, y, w + 0.05, 0.03, h + 0.05, frame, z - 0.025)
    b.box(x, y + 0.03, w, 0.012, h, glass, z)


def door(b, x, y, w=0.2, h=0.3, c='wood', frame='darker'):
    b.box(x - 0.025, y, w + 0.05, 0.03, h + 0.025, frame, 0)
    b.box(x, y + 0.03, w, 0.012, h, c, 0)
    b.box(x + w * 0.75, y + 0.045, 0.03, 0.012, 0.03, 'gold', h * 0.45)


def south_gable(b, x, y, w, z, rise, c):
    """A wall coloured triangle in the south gable end of a roof whose ridge runs north to south (y)."""
    b.bill(x + w / 2, y + 0.002, z, [(-w / 2, 0), (w / 2, 0), (0, rise)], c)


def chimney(b, x, y, z, h=0.28, c='brick'):
    b.box(x, y, 0.1, 0.1, h, c, z)
    b.box(x - 0.015, y - 0.015, 0.13, 0.13, 0.03, 'darker', z + h)


def house(b, x, y, w, d, wh, wall, roof, axis='x', rise=0.28, ov=0.07, door_at=0.5, windows=2, stripe=None,
          chim=None, glass='glass', trim='paint', door_c='wood', floors=1, tile_band=True):
    """A cottage: walls wh high, a gable roof, windows and a door on the south face, an optional chimney (x fraction)."""
    b.box(x, y, w, d, wh, wall)
    if stripe:
        b.box(x - 0.01, y + d, w + 0.02, 0.03, 0.05, stripe, wh * 0.45)
    ys = y + d
    dw = 0.18
    dx = x + (w - dw) * door_at
    door(b, dx, ys, dw, min(0.28, wh * 0.6), door_c)
    # Windows fill the south face around the door, one row per floor.
    for fl in range(floors):
        zw = wh * (fl / floors) + wh / floors * 0.45
        if windows:
            slots = [x + w * (k + 0.5) / (windows + 1) - 0.07 for k in range(windows + 1)]
            for sx in slots:
                if fl == 0 and abs(sx + 0.07 - (dx + dw / 2)) < 0.17:
                    continue
                window(b, sx, ys, zw, 0.14, min(0.16, wh / floors * 0.4), glass, trim)
    rx, ry, rw, rd = x - ov, y - ov, w + 2 * ov, d + 2 * ov
    b.gable(rx, ry, rw, rd, rise, roof, wh, axis)
    if tile_band:
        side = 'a'
        b.band(rx, ry, rw, rd, rise, wh, axis, side, 0.0, 0.1, 'darker', 0.35)
        b.band(rx, ry, rw, rd, rise, wh, axis, side, 0.9, 1.0, 'darker', 0.3)
    if axis == 'y':
        south_gable(b, rx, ry + rd, rw, wh, rise, wall)
    if chim is not None:
        cx = x + w * chim
        if axis == 'x':
            chimney(b, cx, y + d * 0.2, wh + rise * 0.5)
        else:
            chimney(b, x + w * 0.12, y + d * chim, wh + rise * 0.5)


def fence(b, x0, y0, x1, y1, c='wood', h=0.12):
    """A low picket fence along a straight line (posts and a rail)."""
    n = max(2, int(max(abs(x1 - x0), abs(y1 - y0)) / 0.12))
    for i in range(n + 1):
        t = i / n
        b.box(x0 + (x1 - x0) * t - 0.012, y0 + (y1 - y0) * t - 0.012, 0.025, 0.025, h, c)
    b.box(min(x0, x1) - 0.01, min(y0, y1) - 0.01, abs(x1 - x0) + 0.025, abs(y1 - y0) + 0.025, 0.02, c, h * 0.55)


def bush(b, x, y, r=0.09):
    b.cyl(x, y, r, r * 1.1, 'camo', n=6)
    b.cyl(x - r * 0.1, y - r * 0.1, r * 0.6, r * 0.8, 'camo2', r * 1.1, n=6)


def flowerbed(b, x, y, w):
    b.box(x, y, w, 0.07, 0.04, 'dirt')
    for i in range(int(w / 0.06)):
        b.box(x + 0.01 + i * 0.06, y + 0.02, 0.03, 0.03, 0.07, 'red' if i % 2 else 'yellow')


def awning(b, x, y, w, z, c1, c2, depth=0.18, n=6):
    """A striped awning over a shop front, sloping out to the south."""
    sw = w / n
    for i in range(n):
        b.box(x + i * sw, y, sw, depth * 0.55, 0.03, c1 if i % 2 == 0 else c2, z)
        b.box(x + i * sw, y + depth * 0.55, sw, depth * 0.45, 0.03, c1 if i % 2 == 0 else c2, z - 0.05)


def crate(b, x, y, s=0.1, c='wood'):
    b.box(x, y, s, s, s, c)
    b.box(x + s * 0.1, y + s * 0.1, s * 0.8, s * 0.8, 0.012, 'brick', s)


# ---- Tech buildings --------------------------------------------------------------------------------


def hospital(b):
    # Two storey block in white with a glass band, a red cross on the roof and the south wall, an entrance canopy.
    b.box(0.1, 0.2, 1.8, 1.3, 0.62, 'paint')
    b.box(0.1, 0.2, 1.8, 0.07, 0.05, 'T', 0.62)
    b.box(0.1, 1.43, 1.8, 0.07, 0.05, 'T', 0.62)
    b.box(0.1, 0.2, 0.07, 1.3, 0.05, 'T', 0.62)
    b.box(1.83, 0.2, 0.07, 1.3, 0.05, 'T', 0.62)
    ys = 1.5
    for k in range(4):
        x = 0.22 + k * 0.28 if k < 2 else 1.1 + (k - 2) * 0.28
        window(b, x, ys, 0.38, 0.16, 0.18, 'glass', 'steel2')
    # Entrance with a canopy on two posts, and an ambulance bay beside it.
    b.box(0.7, ys, 0.6, 0.03, 0.3, 'darker')
    b.box(0.74, ys + 0.03, 0.52, 0.012, 0.26, 'glass')
    b.box(0.65, ys, 0.7, 0.35, 0.04, 'steel2', 0.36)
    for x in (0.67, 1.31):
        b.box(x, ys + 0.3, 0.03, 0.03, 0.36, 'steel')
    b.box(0.62, ys + 0.35, 0.76, 0.02, 0.04, 'red', 0.36)
    # The red cross: on the roof and on the south wall.
    b.flat([(0.9, 0.35), (1.1, 0.35), (1.1, 0.55), (1.3, 0.55), (1.3, 0.75), (1.1, 0.75), (1.1, 0.95), (0.9, 0.95), (0.9, 0.75), (0.7, 0.75), (0.7, 0.55), (0.9, 0.55)], 0.62 + 0.058, 'red')
    b.box(0.06, 1.5, 0.18, 0.012, 0.18, 'paint', 0.38)
    b.box(0.1, 1.51, 0.1, 0.012, 0.03, 'red', 0.45)
    b.box(0.135, 1.51, 0.03, 0.012, 0.1, 'red', 0.415)
    # Rooftop plant and the apron.
    b.box(1.45, 0.3, 0.3, 0.3, 0.16, 'steel2', 0.67)
    b.cyl(1.6, 0.45, 0.07, 0.1, 'steel', 0.83, n=6)
    b.box(0.0, 1.85, 2.0, 0.15, 0.03, 'dark')
    b.box(0.0, 1.9, 0.5, 0.03, 0.031, 'paint')


def biolab(b):
    # Grey lab hall with a hazard roof, three green culture tanks outside, pipes and a vent stack.
    b.box(0.1, 0.25, 1.1, 1.45, 0.5, 'steel2')
    b.box(0.1, 0.25, 1.1, 0.06, 0.05, 'T', 0.5)
    b.box(0.1, 1.64, 1.1, 0.06, 0.05, 'T', 0.5)
    b.flat([(0.2, 0.4), (1.1, 0.4), (1.1, 1.55), (0.2, 1.55)], 0.552, 'yellow')
    b.flat([(0.3, 0.5), (1.0, 0.5), (1.0, 1.45), (0.3, 1.45)], 0.554, 'dark')
    # Biohazard sign: a trefoil of three dots round a hub.
    b.flat([(0.65 + 0.07 * dx, 0.97 + 0.07 * dy) for dx, dy in ((1, 0), (0.7, 0.7), (0, 1), (-0.7, 0.7), (-1, 0), (-0.7, -0.7), (0, -1), (0.7, -0.7))], 0.556, 'yellow')
    for (dx, dy) in ((0, -0.22), (0.2, 0.12), (-0.2, 0.12)):
        b.cyl(0.65 + dx, 0.97 + dy, 0.12, 0.012, 'yellow', 0.556, n=6)
        b.cyl(0.65 + dx, 0.97 + dy, 0.06, 0.014, 'dark', 0.556, n=6)
    b.cyl(0.65, 0.97, 0.05, 0.016, 'yellow', 0.556, n=6)
    for k in range(3):
        window(b, 0.2 + k * 0.32, 1.7, 0.25, 0.18, 0.15, 'radar', 'dark')
    door(b, 0.55, 1.7, 0.22, 0.3, 'dark', 'yellow')
    # Culture tanks (translucent green) on a plinth, with a catwalk and pipes to the hall.
    b.box(1.3, 0.35, 0.6, 1.3, 0.07, 'concrete')
    for i, (cy, r, h) in enumerate(((0.65, 0.22, 0.55), (1.2, 0.2, 0.42), (1.7, 0.17, 0.3))):
        b.cyl(1.6, cy, r, h, 'steel', 0.07)
        b.cyl(1.6, cy, r * 0.8, h * 0.85, 'radar', 0.1, a=0.75, emit=True)
        b.cyl(1.6, cy, r * 0.55, 0.05, 'steel', 0.07 + h)
    b.tube((1.2, 0.65, 0.35), (1.4, 0.65, 0.35), 0.04, 'steel')
    b.tube((1.2, 1.2, 0.3), (1.43, 1.2, 0.3), 0.035, 'steel')
    b.tube((1.2, 1.7, 0.22), (1.45, 1.7, 0.22), 0.03, 'steel')
    # Vent stack with a warning light at the back of the hall, and a barrel row.
    b.cyl(0.95, 0.4, 0.07, 0.25, 'dark', 0.55)
    b.cyl(0.95, 0.4, 0.04, 0.02, 'red', 0.8, emit=True)
    b.cyl(1.25, 1.85, 0.06, 0.12, 'yellow', 0.0, n=6)
    b.cyl(1.25, 1.85, 0.03, 0.012, 'dark', 0.12, n=6)


def fcom(b):
    # Camouflaged field bunker with sandbags, a radar mast, a flag in the owner's colour, on a concrete apron.
    b.box(0.1, 0.2, 1.8, 1.55, 0.42, 'olive')
    b.box(0.1, 0.2, 1.8, 0.07, 0.05, 'T', 0.42)
    b.box(0.1, 1.68, 1.8, 0.07, 0.05, 'T', 0.42)
    b.box(0.3, 0.4, 0.7, 0.55, 0.07, 'camo', 0.47)
    b.box(1.1, 0.7, 0.6, 0.6, 0.06, 'camo2', 0.47)
    b.box(0.6, 1.0, 0.5, 0.45, 0.05, 'camo', 0.47)
    ys = 1.75
    door(b, 0.85, ys, 0.3, 0.3, 'darker', 'dark')
    for x in (0.25, 0.55, 1.35, 1.65):
        b.box(x, ys, 0.16, 0.03, 0.07, 'darker', 0.25)
    # Sandbag wall in front: two courses of small bags with a gap at the door.
    for row, z in enumerate((0.0, 0.07)):
        for k in range(14):
            x = 0.1 + k * 0.13 + (0.06 if row else 0)
            if 0.78 < x < 1.18:
                continue
            if x > 1.82:
                continue
            b.box(x, 2.05, 0.12, 0.08, 0.07, 'sandy' if (k + row) % 2 else 'sand', z)
    # Radar on a mast and a dish, a short antenna, the flag.
    b.box(1.5, 0.35, 0.05, 0.05, 0.55, 'steel', 0.47)
    b.cyl(1.52, 0.37, 0.16, 0.04, 'steel2', 1.02)
    b.bill(1.52, 0.42, 1.06, [(-0.14, 0), (0.14, 0), (0.14, 0.18), (-0.14, 0.18)], 'dome')
    b.box(1.5, 0.37, 0.04, 0.04, 0.05, 'red', 1.06, emit=True)
    b.box(0.25, 0.3, 0.03, 0.03, 0.7, 'steel', 0.47)
    b.bill(0.255, 0.31, 1.1, [(0.0, 0.0), (0.26, -0.03), (0.26, -0.16), (0.0, -0.16)], 'T')
    b.box(0.25, 0.3, 0.03, 0.03, 0.03, 'gold', 1.17)
    b.box(0.5, 1.85, 0.08, 0.08, 0.08, 'wood')
    b.box(1.6, 1.8, 0.2, 0.15, 0.1, 'olive')


def miss(b):
    # Communications center: a long hall with a big satellite dish, antenna masts with red lamps and a missile pair.
    b.box(0.15, 0.2, 2.7, 1.5, 0.5, 'steel2')
    b.box(0.15, 0.2, 2.7, 0.07, 0.05, 'T', 0.5)
    b.box(0.15, 1.63, 2.7, 0.07, 0.05, 'T', 0.5)
    b.box(0.3, 0.45, 2.4, 1.0, 0.06, 'dark', 0.55)
    ys = 1.7
    for k in range(6):
        window(b, 0.3 + k * 0.28, ys, 0.28, 0.18, 0.14, 'glass', 'dark')
    door(b, 2.0, ys, 0.3, 0.3, 'dark', 'yellow')
    b.box(0.15, 1.7, 0.7, 0.012, 0.03, 'yellow', 0.05)
    # Big dish: stepped bowl on a pedestal, feed horn in front.
    b.cyl(0.85, 0.85, 0.12, 0.2, 'steel', 0.6)
    b.cyl(0.85, 0.85, 0.42, 0.06, 'steel2', 0.8)
    b.cyl(0.85, 0.85, 0.34, 0.05, 'dome', 0.86)
    b.cyl(0.85, 0.85, 0.2, 0.04, 'dome', 0.91)
    b.cyl(0.85, 0.85, 0.05, 0.1, 'dark', 0.95)
    b.tube((0.85, 0.85, 0.95), (0.85, 1.25, 1.02), 0.012, 'dark')
    b.box(0.82, 1.22, 0.06, 0.06, 0.06, 'red', 1.0, emit=True)
    # Masts with cross bars and warning lamps.
    for (mx, my, mh) in ((1.75, 0.45, 0.9), (2.25, 0.75, 0.7), (2.6, 0.4, 1.0)):
        b.box(mx, my, 0.04, 0.04, mh, 'dark', 0.55)
        for z in (0.4, 0.65, 0.85):
            if z < mh:
                b.box(mx - 0.1, my, 0.24, 0.025, 0.025, 'steel', 0.55 + z * 0.8)
        b.box(mx - 0.005, my - 0.005, 0.05, 0.05, 0.05, 'red', 0.55 + mh, emit=True)
    # A pair of missiles on a roof rack and a small generator.
    b.box(1.4, 1.0, 0.45, 0.25, 0.04, 'dark', 0.56)
    for dy in (1.06, 1.16):
        b.tube((1.45, dy + 0.02, 0.64), (1.8, dy + 0.02, 0.64), 0.04, 'paint')
        b.tube((1.8, dy + 0.02, 0.64), (1.84, dy + 0.02, 0.64), 0.04, 'red')
    b.box(2.4, 1.15, 0.3, 0.25, 0.18, 'dark', 0.56)
    # Bib: the concrete apron with a parked cable drum and fuel tank.
    b.cyl(0.5, 2.5, 0.16, 0.14, 'wood', 0.0, n=8)
    b.cyl(0.5, 2.5, 0.06, 0.16, 'steel', 0.0, n=6)
    b.cyl(2.3, 2.45, 0.18, 0.22, 'steel2', 0.0)
    b.box(1.2, 2.3, 0.3, 0.2, 0.1, 'olive')


def oilb(b):
    # Oil derrick on a concrete pad: lattice tower at the back left, pump house, storage tank with a team band, drums.
    # Tower: four legs leaning in to the crown, three levels of bracing, a crown block with a pulley.
    bx, by, tx, ty = 0.2, 0.2, 0.3, 0.3
    legs = [(bx, by), (bx + 0.5, by), (bx + 0.5, by + 0.5), (bx, by + 0.5)]
    cx, cy, ch = bx + 0.25, by + 0.25, 1.35
    tops = [(cx - 0.05, cy - 0.05), (cx + 0.05, cy - 0.05), (cx + 0.05, cy + 0.05), (cx - 0.05, cy + 0.05)]
    b.box(bx - 0.05, by - 0.05, 0.6, 0.6, 0.05, 'steel')
    for (lx, ly), (ux, uy) in zip(legs, tops):
        b.beam((lx, ly, 0.05), (ux, uy, ch), 0.04, 'steel')
    for f in (0.3, 0.55, 0.78):
        pts = []
        for (lx, ly), (ux, uy) in zip(legs, tops):
            pts.append((lx + (ux - lx) * f, ly + (uy - ly) * f, 0.05 + (ch - 0.05) * f))
        for i in range(4):
            p, q = pts[i], pts[(i + 1) % 4]
            b.beam(p, q, 0.025, 'darker')
        # X bracing on the south face between the front legs.
    for f0, f1 in ((0.0, 0.3), (0.3, 0.55), (0.55, 0.78)):
        def pt(i, f):
            (lx, ly), (ux, uy) = legs[i], tops[i]
            return (lx + (ux - lx) * f, ly + (uy - ly) * f, 0.05 + (ch - 0.05) * f)
        b.beam(pt(3, f0), pt(2, f1), 0.02, 'darker')
        b.beam(pt(2, f0), pt(3, f1), 0.02, 'darker')
    b.box(cx - 0.09, cy - 0.09, 0.18, 0.18, 0.08, 'red', ch)
    b.cyl(cx, cy, 0.04, 0.05, 'yellow', ch + 0.08, n=6)
    # Drill floor and wellhead.
    b.box(bx + 0.05, by + 0.05, 0.4, 0.4, 0.03, 'dark', 0.28)
    b.cyl(cx, cy, 0.05, 0.12, 'rust', 0.05, n=6)
    # Pump house with a pitched roof and a door.
    b.box(0.95, 0.3, 0.45, 0.4, 0.28, 'rust')
    b.box(0.92, 0.27, 0.51, 0.46, 0.04, 'dark', 0.28)
    b.box(1.1, 0.7, 0.14, 0.012, 0.18, 'darker')
    b.box(0.97, 0.7, 0.1, 0.012, 0.08, 'glass', 0.1)
    b.cyl(1.35, 0.4, 0.04, 0.12, 'dark', 0.32, n=6)
    # Large tank in front with a team band, a small tank behind, pipes between.
    b.cyl(1.45, 1.4, 0.38, 0.5, 'steel2')
    b.cyl(1.45, 1.4, 0.38, 0.1, 'T', 0.2)
    b.cyl(1.45, 1.4, 0.3, 0.06, 'steel', 0.5)
    b.cyl(1.45, 1.4, 0.06, 0.08, 'dark', 0.56, n=6)
    b.cyl(1.58, 0.8, 0.16, 0.3, 'steel', 0.0)
    b.cyl(1.58, 0.8, 0.12, 0.04, 'dark', 0.3, n=6)
    b.tube((0.62, 0.45, 0.1), (0.95, 0.45, 0.1), 0.035, 'dark')
    b.tube((1.4, 0.8, 0.12), (1.58, 0.8, 0.12), 0.03, 'dark')
    b.tube((1.45, 0.95, 0.12), (1.45, 1.1, 0.12), 0.03, 'dark')
    # Oil drums by the pad edge and a puddle.
    for (dx, dy, c) in ((0.2, 1.5, 'red'), (0.42, 1.55, 'orange'), (0.3, 1.78, 'red'), (0.62, 1.75, 'steel')):
        b.cyl(dx, dy, 0.09, 0.17, c, 0.0, n=6)
        b.cyl(dx, dy, 0.09, 0.012, 'dark', 0.1, n=6)
    b.flat([(0.7, 1.1), (1.0, 1.05), (1.05, 1.3), (0.75, 1.35)], 0.001, 'darker', 0.8)


# ---- Village --------------------------------------------------------------------------------------

WALLS = ('wall', '#e8c9a0', '#cfd8dc', '#d9c28a', '#c8d6b0')


def church(b):
    # Nave with a tiled gable roof, a front tower with a stepped spire and a gold cross, stained glass, a door.
    b.box(0.35, 0.15, 1.3, 1.45, 0.5, 'wall')
    for y in (0.4, 0.8, 1.2):
        b.box(0.3, y, 0.06, 0.12, 0.2, 'blue', 0.22)
        b.box(1.64, y, 0.06, 0.12, 0.2, 'blue', 0.22)
    b.gable(0.3, 0.1, 1.4, 1.55, 0.42, 'tiles', 0.5, 'y')
    b.band(0.3, 0.1, 1.4, 1.55, 0.42, 0.5, 'y', 'a', 0.0, 0.1, 'darker', 0.35)
    # Tower in front of the nave.
    b.box(0.7, 1.4, 0.6, 0.5, 0.95, 'concrete')
    b.box(0.66, 1.36, 0.68, 0.58, 0.06, 'dark', 0.95)
    b.box(0.82, 1.9, 0.36, 0.03, 0.35, 'darker')
    b.box(0.86, 1.93, 0.28, 0.012, 0.3, 'wood')
    b.box(0.92, 1.9, 0.16, 0.03, 0.2, 'blue', 0.5)
    b.box(0.97, 1.93, 0.06, 0.012, 0.2, 'paint', 0.5)
    window(b, 0.91, 1.9, 0.66, 0.18, 0.2, 'darker', 'paint')
    b.pyramid(1.0, 1.65, 0.31, 0.27, 0.5, 'dark', 1.01)
    b.box(0.98, 1.63, 0.04, 0.04, 0.22, 'gold', 1.51)
    b.box(0.93, 1.63, 0.14, 0.04, 0.04, 'gold', 1.62)
    # Path and a small lantern post.
    b.box(0.85, 1.93, 0.3, 0.1, 0.012, 'sand')


def house_big(b):
    # V02: a farmhouse, long gable along x, red tiles, chimney, a porch and a flowerbed.
    house(b, 0.15, 0.3, 1.7, 1.0, 0.5, 'wall', 'tiles', 'x', 0.34, windows=3, chim=0.75, door_at=0.3)
    b.box(0.1, 1.3, 0.55, 0.3, 0.05, 'wood')
    for x in (0.12, 0.6):
        b.box(x, 1.55, 0.04, 0.04, 0.32, 'paint')
    b.gable(0.08, 1.28, 0.6, 0.36, 0.16, 'brick', 0.37, 'x')
    flowerbed(b, 0.8, 1.45, 0.5)
    fence(b, 0.1, 1.9, 1.9, 1.9)
    bush(b, 1.65, 1.6)


def house_two(b):
    # V03: a two storey townhouse with a steep roof along y, brick wall, wooden shutters, chimney.
    house(b, 0.35, 0.2, 1.3, 1.2, 0.85, 'brick', 'dark', 'y', 0.3, windows=2, chim=0.5, floors=2, door_at=0.5, trim='paint')
    b.box(0.3, 1.4, 1.4, 0.06, 0.04, 'concrete')
    for x in (0.4, 1.2):
        b.box(x - 0.06, 1.4, 0.03, 0.03, 0.1, 'wood', 0.5)
    bush(b, 0.25, 1.65)
    bush(b, 1.75, 1.65)
    b.box(0.5, 1.46, 0.5, 0.35, 0.012, 'sand')


def house_garden(b):
    # V04: a cottage with an L-shaped wing, a garden fence and a tree.
    house(b, 0.2, 0.25, 1.1, 0.8, 0.45, '#e8c9a0', 'tiles', 'x', 0.3, windows=2, chim=0.2, door_at=0.65)
    house(b, 1.25, 0.55, 0.65, 0.75, 0.4, '#e8c9a0', 'brick', 'y', 0.26, windows=1, chim=None, door_at=0.5)
    fence(b, 0.1, 1.85, 1.9, 1.85)
    fence(b, 0.1, 1.45, 0.1, 1.85)
    fence(b, 1.9, 1.45, 1.9, 1.85)
    b.box(0.3, 1.55, 0.5, 0.2, 0.03, 'dirt')
    for i in range(5):
        b.box(0.33 + i * 0.1, 1.6, 0.05, 0.1, 0.07, 'camo2')
    b.cyl(1.55, 1.7, 0.07, 0.25, 'wood')
    b.cyl(1.55, 1.7, 0.2, 0.18, 'camo', 0.25, n=6)
    b.cyl(1.55, 1.7, 0.12, 0.1, 'camo2', 0.43, n=6)


def shop(b):
    # V05: a corner shop 2x1 with a striped awning, a sign board, big display windows and crates.
    b.box(0.1, 0.1, 1.8, 0.7, 0.5, '#e8c9a0')
    b.box(0.07, 0.07, 1.86, 0.76, 0.05, 'dark', 0.5)
    b.box(0.2, 0.8, 1.6, 0.03, 0.1, 'red', 0.4)
    ys = 0.8
    window(b, 0.2, ys, 0.12, 0.55, 0.22, 'glass', 'paint')
    window(b, 1.25, ys, 0.12, 0.45, 0.22, 'glass', 'paint')
    door(b, 0.85, ys, 0.25, 0.3, 'wood', 'paint')
    awning(b, 0.15, ys + 0.03, 1.7, 0.42, 'red', 'paint')
    b.box(0.2, 0.0, 0.5, 0.06, 0.18, 'wood', 0.55)
    crate(b, 1.55, 0.9, 0.09)
    crate(b, 1.7, 0.88, 0.07, 'sandy')
    crate(b, 0.2, 0.9, 0.08, 'sandy')


def cottage_long(b):
    # V06: a long low cottage with a thatched (sand) roof, dormer and chimney.
    house(b, 0.1, 0.12, 1.8, 0.65, 0.4, 'wall', 'sandy', 'x', 0.3, windows=3, chim=0.8, door_at=0.2, tile_band=False)
    b.box(0.95, 0.5, 0.3, 0.2, 0.18, 'wall', 0.4)
    b.gable(0.92, 0.47, 0.36, 0.26, 0.1, 'sandy', 0.58, 'x')
    window(b, 1.03, 0.7, 0.45, 0.12, 0.1, 'glass', 'paint')
    flowerbed(b, 0.2, 0.9, 0.5)


def gas_station(b):
    # V07: a petrol station on asphalt: a small shop, a flat canopy on pillars over two pumps, a price sign.
    b.box(0.1, 0.12, 0.7, 0.55, 0.4, 'paint')
    b.box(0.07, 0.09, 0.76, 0.61, 0.05, 'red', 0.4)
    window(b, 0.15, 0.67, 0.14, 0.2, 0.14, 'glass', 'dark')
    door(b, 0.55, 0.67, 0.18, 0.28, 'dark', 'dark')
    # Canopy.
    b.box(1.0, 0.1, 0.9, 0.75, 0.05, 'paint', 0.52)
    b.box(1.0, 0.1, 0.9, 0.05, 0.05, 'red', 0.52)
    b.box(1.0, 0.8, 0.9, 0.05, 0.05, 'red', 0.52)
    for (px, py) in ((1.05, 0.15), (1.8, 0.15), (1.05, 0.7), (1.8, 0.7)):
        b.box(px, py, 0.05, 0.05, 0.52, 'steel2')
    for px in (1.25, 1.55):
        b.box(px, 0.35, 0.12, 0.1, 0.24, 'red')
        b.box(px + 0.02, 0.45, 0.08, 0.012, 0.06, 'glass', 0.15)
        b.box(px + 0.04, 0.3, 0.04, 0.05, 0.07, 'darker', 0.12)
    # Price sign pylon at the road side.
    b.box(0.9, 0.85, 0.04, 0.04, 0.45, 'steel')
    b.box(0.84, 0.84, 0.16, 0.06, 0.16, 'yellow', 0.45)
    b.box(0.86, 0.9, 0.12, 0.012, 0.04, 'red', 0.55)


def cottage_row(b):
    # V08: a single small hut 1x1 with a red roof.
    house(b, 0.15, 0.2, 0.7, 0.55, 0.38, 'wall', 'tiles', 'x', 0.26, windows=1, chim=0.7, door_at=0.3, ov=0.06)
    flowerbed(b, 0.2, 0.85, 0.4)


def shed(b):
    # V09: a timber barn-like shed with a gambrel look (two stacked gables) and a hay door.
    b.box(0.1, 0.12, 0.8, 0.65, 0.45, 'wood')
    for x in (0.2, 0.4, 0.6, 0.8):
        b.box(x, 0.78, 0.015, 0.012, 0.45, '#8a5a2a')
    b.gable(0.06, 0.08, 0.88, 0.73, 0.3, 'rust', 0.45, 'x')
    b.band(0.06, 0.08, 0.88, 0.73, 0.3, 0.45, 'x', 'a', 0.0, 0.12, 'darker', 0.3)
    b.box(0.25, 0.78, 0.4, 0.03, 0.32, 'paint')
    b.box(0.28, 0.81, 0.34, 0.012, 0.28, 'wood')
    b.box(0.28, 0.82, 0.34, 0.012, 0.03, 'paint', 0.14)
    b.box(0.43, 0.82, 0.04, 0.012, 0.28, 'paint')


def kiosk(b):
    # V10: a small flat-roofed shop with a sign and a striped awning, plus a bench.
    b.box(0.15, 0.15, 0.7, 0.55, 0.4, '#cfd8dc')
    b.box(0.12, 0.12, 0.76, 0.61, 0.05, 'steel', 0.4)
    b.box(0.2, 0.7, 0.6, 0.03, 0.08, 'blue', 0.32)
    window(b, 0.2, 0.7, 0.1, 0.3, 0.18, 'glass', 'paint')
    door(b, 0.6, 0.7, 0.16, 0.26, 'blue', 'paint')
    awning(b, 0.17, 0.73, 0.66, 0.3, 'blue', 'paint', 0.14, 6)
    b.box(0.2, 0.9, 0.35, 0.08, 0.03, 'wood', 0.08)
    b.box(0.22, 0.92, 0.03, 0.04, 0.08, 'dark')
    b.box(0.5, 0.92, 0.03, 0.04, 0.08, 'dark')
    b.box(0.35, 0.0, 0.1, 0.1, 0.05, 'steel', 0.45)
    b.box(0.37, 0.02, 0.06, 0.06, 0.16, 'steel2', 0.5)


def house_tall(b):
    # V11: a narrow two storey house with a green roof, a balcony and a chimney.
    house(b, 0.2, 0.15, 0.6, 0.6, 0.7, '#d9c28a', 'camo', 'y', 0.22, windows=1, chim=0.5, floors=2, door_at=0.5, ov=0.06)
    b.box(0.25, 0.75, 0.5, 0.12, 0.03, 'wood', 0.38)
    b.box(0.25, 0.85, 0.5, 0.02, 0.07, 'wood', 0.41)
    bush(b, 0.15, 0.9, 0.07)
    bush(b, 0.85, 0.9, 0.07)


def haystack(b, golden=True):
    # V12: a hay rick: stepped dome with darker straw bands on a wooden base.
    c = 'gold' if golden else 'sandy'
    b.box(0.18, 0.28, 0.64, 0.55, 0.03, 'wood')
    b.vdome(0.5, 0.55, 0.3, 0.55, c, 0.03)
    b.flat([(0.28, 0.5), (0.72, 0.5), (0.7, 0.53), (0.3, 0.53)], 0.2, 'sandy')
    b.flat([(0.33, 0.62), (0.67, 0.62), (0.66, 0.65), (0.34, 0.65)], 0.32, 'sandy')
    b.box(0.82, 0.78, 0.08, 0.08, 0.04, 'wood')


def haybales(b):
    # V13: round bales stacked in a pyramid, tied with a darker band.
    for (x, y) in ((0.3, 0.6), (0.7, 0.6)):
        b.tube((x - 0.15, y, 0.16), (x + 0.15, y, 0.16), 0.16, 'gold')
        b.tube((x - 0.02, y, 0.16), (x + 0.02, y, 0.16), 0.17, 'sandy')
        b.tube((x + 0.1, y, 0.16), (x + 0.12, y, 0.16), 0.165, 'sandy')
    b.tube((0.35, 0.82, 0.16), (0.65, 0.82, 0.16), 0.16, 'gold')
    b.tube((0.5, 0.82, 0.16), (0.52, 0.82, 0.16), 0.17, 'sandy')
    b.tube((0.35, 0.65, 0.4), (0.65, 0.65, 0.4), 0.15, 'gold')
    b.tube((0.48, 0.65, 0.4), (0.5, 0.65, 0.4), 0.16, 'sandy')


def field(b, crop, seed):
    # Tilled soil in raised rows with a crop on top: wheat is gold, vegetables green with a colour dot, rice flooded.
    rng = Rng(seed)
    b.box(0.05, 0.05, 0.9, 0.9, 0.04, 'dirt')
    rows = 6
    for r in range(rows):
        y = 0.1 + r * 0.14
        b.box(0.08, y, 0.84, 0.07, 0.06, '#7a6240')
        if crop == 'wheat':
            for k in range(7):
                x = 0.1 + k * 0.115 + rng.next() * 0.01
                b.box(x, y, 0.07, 0.07, 0.07 + 0.04 * rng.next(), 'gold' if (k + r) % 2 else 'sand', 0.06)
        else:
            for k in range(6):
                x = 0.1 + k * 0.135
                b.box(x, y, 0.1, 0.07, 0.07 + 0.03 * rng.next(), 'camo2' if (k + r) % 2 else 'camo', 0.06)
                if (k * 3 + r * 5 + seed) % 7 == 0:
                    b.box(x + 0.03, y + 0.02, 0.04, 0.03, 0.03, 'red' if seed % 2 else 'orange', 0.13)
    b.box(0.0, 0.0, 0.04, 0.04, 0.2, 'wood')


def pumpjack(b, burnt=False):
    # V19: a pumpjack on a concrete pad: motor box, crank, samson post with the walking beam and a horse head.
    steel, dark, body, accent, weight = ('#4a4743', '#2a2622', '#3a342c', '#2e2a26', '#2a2622') if burnt else ('steel', 'darker', 'dark', 'red', 'rust')
    b.box(0.08, 0.1, 0.84, 0.8, 0.05, '#3a342c' if burnt else 'concrete')
    # Motor house and crank.
    b.box(0.6, 0.55, 0.28, 0.25, 0.14, body, 0.05)
    b.tube((0.62, 0.52, 0.2), (0.8, 0.52, 0.2), 0.1, steel)
    b.tube((0.62, 0.52, 0.2), (0.8, 0.52, 0.2), 0.04, dark)
    b.box(0.74, 0.5, 0.03, 0.03, 0.2, dark, 0.2)
    # Samson post (A frame) with the walking beam on top.
    b.beam((0.28, 0.3, 0.05), (0.42, 0.45, 0.48), 0.05, steel)
    b.beam((0.56, 0.3, 0.05), (0.42, 0.45, 0.48), 0.05, steel)
    b.beam((0.28, 0.55, 0.05), (0.42, 0.45, 0.48), 0.05, steel)
    b.beam((0.56, 0.55, 0.05), (0.42, 0.45, 0.48), 0.05, steel)
    if burnt:
        # The beam has fallen at one end: tilted down to the pad.
        b.beam((0.42, 0.45, 0.48), (0.08, 0.45, 0.2), 0.06, dark)
        b.beam((0.42, 0.45, 0.48), (0.7, 0.45, 0.55), 0.06, dark)
        b.cyl(0.09, 0.45, 0.07, 0.07, dark, 0.2, n=6)
        b.flat([(0.15, 0.7), (0.5, 0.65), (0.55, 0.88), (0.2, 0.9)], 0.052, '#1c1a18', 0.8)
        b.box(0.3, 0.2, 0.06, 0.05, 0.03, '#6b6862', 0.05)
    else:
        b.beam((0.1, 0.45, 0.43), (0.78, 0.45, 0.58), 0.06, accent)
        b.box(0.02, 0.4, 0.14, 0.1, 0.16, 'rust', 0.38)
        b.box(0.76, 0.4, 0.14, 0.1, 0.12, weight, 0.5)
        b.tube((0.08, 0.45, 0.4), (0.08, 0.45, 0.08), 0.012, 'darker')
    # Wellhead, pipe and a small tank.
    b.cyl(0.12, 0.45, 0.04, 0.12, 'rust' if not burnt else dark, 0.05, n=6)
    b.cyl(0.8, 0.22, 0.1, 0.18, steel, 0.05)


# ---- Actors ----------------------------------------------------------------------------------------


def _civ(w, d, draw, ground='grass'):
    return BuildingSpec(w, d, draw, ground=ground, damage=True, make=False)


ACTORS = {
    'FCOM': BuildingSpec(2, 3, fcom, ground='concrete', make=False),
    'HOSP': BuildingSpec(2, 2, hospital, ground='concrete', make=False),
    'BIO': BuildingSpec(2, 2, biolab, ground='concrete', make=False),
    'MISS': BuildingSpec(3, 3, miss, ground='concrete', make=False),
    'OILB': BuildingSpec(2, 2, oilb, ground='concrete', damage=True, make=False),
    'V01': _civ(2, 2, church),
    'V02': _civ(2, 2, house_big),
    'V03': _civ(2, 2, house_two),
    'V04': _civ(2, 2, house_garden),
    'V05': _civ(2, 1, shop),
    'V06': _civ(2, 1, cottage_long),
    'V07': _civ(2, 1, gas_station, ground='asphalt'),
    'V08': _civ(1, 1, cottage_row),
    'V09': _civ(1, 1, shed),
    'V10': _civ(1, 1, kiosk),
    'V11': _civ(1, 1, house_tall),
    'V12': _civ(1, 1, lambda b: haystack(b, True)),
    'V13': _civ(1, 1, haybales),
    'V14': _civ(1, 1, lambda b: field(b, 'veg', 14)),
    'V15': _civ(1, 1, lambda b: field(b, 'wheat', 15)),
    'V16': _civ(1, 1, lambda b: field(b, 'veg', 16)),
    'V17': _civ(1, 1, lambda b: field(b, 'wheat', 17)),
    'V18': _civ(1, 1, lambda b: field(b, 'veg', 18)),
    'V19': BuildingSpec(1, 1, pumpjack, ground='concrete', damage=True, make=False),
    # The husk is already a ruin: no damaged pose of its own.
    'V19.Husk': BuildingSpec(1, 1, lambda b: pumpjack(b, True), ground='concrete', damage=False, make=False),
}
