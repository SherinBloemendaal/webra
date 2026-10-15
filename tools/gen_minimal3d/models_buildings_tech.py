"""Tech buildings and superweapons: Radar Dome, Allied and Soviet Tech Centers, Gap Generator, Chronosphere,
Iron Curtain, Missile Silo (and the fakes that share them).

Ported from the Tech3D design board to the game's 3/4 camera. Coordinates are cells, see core.Building. Effects are
translucent (alpha) and stay readable against the ground."""
import math

from specs import BuildingSpec


def circ(cx, cy, r, n=12):
    return [(cx + r * math.cos(i / n * math.pi * 2), cy + r * math.sin(i / n * math.pi * 2)) for i in range(n)]


def sector(cx, cy, r0, r1, a0, a1):
    pts = []
    for i in range(5):
        a = a0 + (a1 - a0) * i / 4
        pts.append((cx + r1 * math.cos(a), cy + r1 * math.sin(a)))
    for i in range(4, -1, -1):
        a = a0 + (a1 - a0) * i / 4
        pts.append((cx + r0 * math.cos(a), cy + r0 * math.sin(a)))
    return pts


def dome(b):
    # Low hall with team stripes, green scopes on the front, a stepped radar dome with a green sweep, a mast with a dish.
    b.box(0, 2.5, 2, 0.5, 0.06, 'concrete')
    b.box(0.1, 0.2, 1.8, 2.3, 0.35, 'wall')
    b.box(0.1, 0.2, 1.8, 0.08, 0.03, 'T', 0.35)
    b.box(0.1, 2.42, 1.8, 0.08, 0.03, 'T', 0.35)
    b.box(0.3, 2.5, 0.5, 0.02, 0.15, 'radar', 0.12)
    b.box(1.2, 2.5, 0.5, 0.02, 0.15, 'radar', 0.12)
    b.box(1.6, 0.4, 0.1, 0.1, 1.0, 'steel', 0.35)
    b.bill(1.65, 0.45, 1.35, [(-0.35, 0), (0.35, 0), (0.45, 0.16), (0.35, 0.32), (-0.35, 0.32), (-0.45, 0.16)], 'steel2')
    for h in (0.08, 0.16, 0.24):
        b.bill(1.65, 0.4, 1.35, [(-0.38, h), (0.38, h), (0.38, h + 0.025), (-0.38, h + 0.025)], 'dark')
    b.cyl(1.65, 0.45, 0.05, 0.06, 'T', 1.67)
    b.box(0.16, 0.76, 1.48, 1.48, 0.08, 'T', 0.35)
    b.vdome(0.9, 1.5, 0.72, 0.95, 'dome', 0.43)
    b.flat([(0.9, 1.5), (1.18, 1.26), (1.2, 1.64)], 1.381, 'radar', a=0.85)


def atek(b):
    # Hall with a glass roof and a ridge rib, a satellite dish on a post, a short antenna with a team cap.
    b.box(0, 2.5, 2, 0.5, 0.06, 'concrete')
    b.box(0.15, 0.2, 1.7, 2.1, 0.7, 'wall')
    b.box(0.15, 0.2, 1.7, 0.08, 0.04, 'T', 0.7)
    b.box(0.15, 2.22, 1.7, 0.08, 0.04, 'T', 0.7)
    b.box(0.3, 0.9, 1.4, 1.2, 0.14, 'glass', 0.7)
    b.box(0.98, 0.9, 0.04, 1.2, 0.16, 'steel2', 0.7)
    b.box(1.1, 0.35, 0.06, 0.06, 0.35, 'steel', 0.7)
    b.bill(1.13, 0.38, 1.0, [(u, h + 0.0) for u, h in circ(0, 0.25, 0.28)], 'dome')
    b.bill(1.13, 0.37, 1.0, circ(0, 0.25, 0.07), 'dark')
    b.box(0.35, 0.35, 0.05, 0.05, 0.75, 'dark', 0.7)
    b.cyl(0.375, 0.375, 0.07, 0.07, 'T', 1.45)
    b.box(0.75, 2.3, 0.5, 0.04, 0.42, 'yellow')


def stek(b):
    # Brick hall with a pale roof inset, team cross, a tall mast with a red lamp.
    b.box(0, 2.5, 3, 0.5, 0.06, 'concrete')
    b.box(0.1, 0.15, 2.8, 2.15, 0.8, 'brick')
    b.box(0.25, 0.3, 1.6, 1.8, 0.06, 'roof', 0.8)
    b.box(0.25, 0.3, 1.6, 0.1, 0.02, 'T', 0.86)
    b.box(0.25, 2.0, 1.6, 0.1, 0.02, 'T', 0.86)
    b.box(0.75, 0.9, 0.6, 0.6, 0.03, 'T', 0.86)
    b.box(2.15, 0.85, 0.3, 0.3, 1.0, 'steel', 0.8)
    b.box(2.22, 0.92, 0.16, 0.16, 0.5, 'steel2', 1.8)
    b.cyl(2.3, 1.0, 0.1, 0.12, 'red', 2.3)
    b.box(1.2, 2.3, 0.6, 0.04, 0.5, 'yellow')


def gap(b):
    # Emitter pole on a plinth, signal rings, jamming bolts, all under a translucent dark shroud.
    b.box(0.15, 0.15, 0.7, 0.7, 0.15, 'concrete')
    b.box(0.15, 0.83, 0.7, 0.02, 0.1, 'T', 0.03)
    b.cyl(0.5, 0.5, 0.15, 0.75, 'steel', 0.15)
    b.cyl(0.5, 0.5, 0.32, 0.06, 'dome', 0.9)
    b.cyl(0.5, 0.5, 0.08, 0.1, 'ice', 0.96)
    for r, z in ((0.4, 1.15), (0.52, 1.32), (0.64, 1.49)):
        b.cyl(0.5, 0.5, r, 0.03, 'ice', z, 12, False, 0.75)
    b.bolt(0.5, 0.5, 0, [(-0.62, 0.4), (-0.55, 0.55), (-0.66, 0.68), (-0.56, 0.84), (-0.64, 1.0)], 0.035, 'ice', 0.9)
    b.bolt(0.5, 0.5, 0, [(0.62, 0.45), (0.55, 0.6), (0.66, 0.74), (0.57, 0.9), (0.64, 1.05)], 0.035, 'ice', 0.9)
    b.vdome(0.5, 0.5, 0.7, 1.5, 'shroud', 0, 0.3)


def pdox(b):
    # Four team-capped pylons around a pad, a faint light column with floating rings and a ghost block appearing.
    b.box(0.05, 0.05, 1.9, 1.9, 0.12, 'concrete')
    for x, y in ((0.92, 0.1), (0.1, 0.92), (1.74, 0.92), (0.92, 1.74)):
        b.box(x, y, 0.16, 0.16, 0.85, 'steel', 0.12)
        b.box(x, y, 0.16, 0.16, 0.06, 'T', 0.97)
    b.cyl(1, 1, 0.65, 0.2, 'steel2', 0.12)
    b.cyl(1, 1, 0.48, 0.02, '#23363f', 0.32)
    b.cyl(1, 1, 0.26, 1.5, 'ice2', 0.34, 8, True, 0.4)
    for r, z in ((0.55, 0.62), (0.45, 0.95), (0.35, 1.28)):
        b.cyl(1, 1, r, 0.05, 'ice', z, 12, False, 0.85)
    b.box(0.82, 0.82, 0.36, 0.36, 0.26, 'ice', 1.45, 0.35)


def iron(b):
    # Corner pylons with team caps, a curtain of steel panels around a control console, a red translucent field.
    b.box(0.05, 0.05, 1.9, 1.9, 0.12, 'concrete')
    for x, y in ((0.1, 0.1), (1.68, 0.1), (0.1, 1.68), (1.68, 1.68)):
        b.box(x, y, 0.22, 0.22, 0.95, 'steel', 0.12)
        b.box(x, y, 0.22, 0.22, 0.06, 'T', 1.07)
    for deg in (200, 235, 270, 305, 340):
        a = deg * math.pi / 180
        b.box(1 + 0.62 * math.cos(a) - 0.09, 1 + 0.62 * math.sin(a) - 0.09, 0.18, 0.18, 0.8, 'steel2', 0.12)
    b.box(0.6, 0.75, 0.8, 0.65, 0.4, 'dark', 0.12)
    b.cyl(1, 1.07, 0.18, 0.1, 'darker', 0.52)
    b.cyl(1, 1.07, 0.1, 0.06, 'red', 0.62)
    b.vdome(1, 1, 0.88, 1.2, 'field', 0.12, 0.2)


def mslo(b):
    # Open silo: hazard-yellow pad, both hatch leaves folded back with a radiation sign, red-tipped missile in the shaft.
    b.box(0, 0, 2, 1, 0.1, 'concrete')
    b.box(0, 0.92, 2, 0.08, 0.02, 'T', 0.1)
    b.box(0.2, 0.1, 1.6, 0.8, 0.02, 'yellow', 0.1)
    b.box(0.55, 0.2, 0.9, 0.6, 0.005, '#0e0f10', 0.12)
    b.box(0.05, 0.15, 0.48, 0.7, 0.06, 'steel', 0.12)
    b.box(1.47, 0.15, 0.48, 0.7, 0.06, 'steel', 0.12)
    b.flat(circ(1.71, 0.5, 0.19, 16), 0.181, 'yellow')
    for a in (math.pi / 2, math.pi * 7 / 6, math.pi * 11 / 6):
        b.flat(sector(1.71, 0.5, 0.05, 0.16, a - 0.5, a + 0.5), 0.182, 'darker')
    b.flat(circ(1.71, 0.5, 0.035, 8), 0.183, 'darker')
    b.box(0.74, 0.46, 0.1, 0.08, 0.28, 'red', 0.12)
    b.cyl(1, 0.5, 0.17, 0.65, 'paint', 0.12)
    b.cyl(1, 0.5, 0.175, 0.08, 'yellow', 0.6, 8, False)
    b.cyl(1, 0.5, 0.12, 0.12, 'red', 0.77)
    b.cyl(1, 0.5, 0.06, 0.1, 'red', 0.89)
    b.box(1.16, 0.46, 0.1, 0.08, 0.28, 'red', 0.12)
    b.box(0.96, 0.66, 0.08, 0.1, 0.28, 'red', 0.12)
    b.cyl(0.1, 0.1, 0.05, 0.08, 'red', 0.1)


ACTORS = {
    'DOME': BuildingSpec(2, 3, dome, second_hidden=True),
    'ATEK': BuildingSpec(2, 3, atek, second_hidden=True),
    'STEK': BuildingSpec(3, 3, stek, second_hidden=True),
    'GAP': BuildingSpec(1, 1, gap),
    'PDOX': BuildingSpec(2, 2, pdox),
    'IRON': BuildingSpec(2, 2, iron),
    'MSLO': BuildingSpec(2, 1, mslo, second_hidden=True),
}

ALIASES = {'DOMF': 'DOME', 'ATEF': 'ATEK', 'PDOF': 'PDOX', 'MSLF': 'MSLO'}
