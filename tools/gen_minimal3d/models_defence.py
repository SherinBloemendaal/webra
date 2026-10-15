"""Defence structures and walls: pillboxes, turrets, flame tower, tesla coil, AA gun, SAM site, lightning rod,
sandbags, fence and concrete wall.

Ported from the Verdediging3D board. Buildings are drawn in cells (see core.Building). The turning turrets
(GUN, AGUN, SAM) are core.Unit models in pixels around the building centre with z from the ground (turret_offsets are
all [0, 0] in rules.json); their bodies stay static. A wall actor is one 1x1 cell piece that must look right when
many sit side by side: the segment runs the full width of the cell east-west, with no visible end caps. The pack
format cannot select connection frames."""
import math

from core import Unit, dsin, dcos
from specs import BuildingSpec
from kit import barrel

WALL = '#d4cfc0'


def circ(cx, cy, r, n=12):
    return [(cx + r * dcos(360.0 * i / n), cy + r * dsin(360.0 * i / n)) for i in range(n)]


# ---- Pillboxes -----------------------------------------------------------------------------------


def pbox(b):
    # Squat concrete drum, a second thinner course, a dark firing slit facing south and a team hatch on the roof.
    b.cyl(0.5, 0.5, 0.42, 0.3, 'concrete')
    b.cyl(0.5, 0.5, 0.36, 0.08, 'wall', 0.3)
    b.box(0.38, 0.86, 0.24, 0.04, 0.1, 'black', 0.17)
    b.cyl(0.5, 0.5, 0.12, 0.03, 'T', 0.38)


def hbox(b):
    # Camouflaged: a low green drum with a lighter leafy cap; the slit is still there.
    b.cyl(0.5, 0.5, 0.42, 0.24, 'camo')
    b.cyl(0.5, 0.5, 0.31, 0.08, 'camo2', 0.24)
    b.box(0.4, 0.86, 0.2, 0.04, 0.07, 'black', 0.12)
    b.box(0.2, 0.3, 0.12, 0.1, 0.03, 'camo2', 0.32)
    b.box(0.64, 0.58, 0.1, 0.12, 0.03, 'camo', 0.32)
    b.cyl(0.5, 0.5, 0.07, 0.02, 'T', 0.32)


# ---- Turret (GUN) --------------------------------------------------------------------------------


def gun(b):
    # The concrete pad with a dark ring mount; the turning cannon is its own sprite.
    b.box(0.1, 0.1, 0.8, 0.8, 0.15, 'concrete')
    b.cyl(0.5, 0.5, 0.34, 0.05, 'dark', 0.15)


def gun_turret():
    u = Unit()
    u.cyl(0, 0, 7.2, 5.5, 'steel', 4.2)
    u.cyl(0, 0, 3.2, 0.8, 'T', 9.7)
    u.box(-2.4, -6.5, 4.8, 3.5, 2.2, 'dark', 5.2)  # rear counterweight
    barrel(u, 0, 2, 15, 7.6, r=1.7, c='dark', tip='darker')
    u.box(-1.6, 1.0, 3.2, 3.0, 1.8, 'steel2', 6.6)  # gun housing
    return u


# ---- Flame tower ---------------------------------------------------------------------------------


def ftur(b):
    # Fuel drums at the back, a brick tank with a team band, a nozzle pointing south and a tongue of fire.
    b.box(0.1, 0.1, 0.8, 0.8, 0.12, 'concrete')
    b.cyl(0.78, 0.2, 0.11, 0.38, 'red', 0.12)
    b.cyl(0.78, 0.45, 0.11, 0.38, 'red', 0.12)
    b.cyl(0.4, 0.3, 0.26, 0.55, 'brick', 0.12)
    b.cyl(0.4, 0.3, 0.275, 0.07, 'T', 0.44, 8, False)
    b.cyl(0.4, 0.3, 0.15, 0.05, 'dark', 0.67)
    b.box(0.34, 0.55, 0.12, 0.35, 0.1, 'dark', 0.3)  # nozzle
    b.box(0.32, 0.88, 0.16, 0.06, 0.14, 'darker', 0.28)
    # Scorch on the ground and the flame (translucent, a south-facing tongue with a hot core).
    b.flat(circ(0.4, 1.0, 0.2, 10), 0.121, 'darker', 0.5)
    b.bill(0.4, 0.97, 0.0, [(-0.14, 0.3), (-0.24, 0.48), (-0.1, 0.62), (-0.12, 0.9), (0.02, 0.76), (0.1, 1.0), (0.16, 0.66),
                            (0.26, 0.48), (0.14, 0.3)], 'orange', 0.92)
    b.bill(0.4, 0.97, 0.0, [(-0.07, 0.32), (-0.12, 0.46), (0.0, 0.62), (0.12, 0.46), (0.07, 0.32)], 'glow', 1.0, emit=True)


# ---- Tesla coil ----------------------------------------------------------------------------------


def tsla(b):
    # Concrete pad with a team stripe, a tall steel mast with two copper coil rings, a glowing cap, a faint
    # energy field and three translucent bolts.
    b.box(0.15, 0.15, 0.7, 0.7, 0.12, 'concrete')
    b.box(0.15, 0.85, 0.7, 0.03, 0.1, 'T', 0.02)
    b.cyl(0.5, 0.5, 0.15, 0.8, 'steel', 0.12)
    b.cyl(0.5, 0.5, 0.3, 0.08, 'copper', 0.35, 8, False)
    b.cyl(0.5, 0.5, 0.25, 0.08, 'copper', 0.6, 8, False)
    b.vdome(0.5, 0.5, 0.16, 0.22, 'glow', 0.92, emit=True)
    b.vdome(0.5, 0.5, 0.3, 0.4, 'ice', 0.82, a=0.25)
    b.bolt(0.5, 0.88, 0, [(0, 1.0), (-0.12, 0.95), (-0.08, 0.85), (-0.22, 0.78), (-0.18, 0.66), (-0.32, 0.58)], 0.022, 'ice2', 0.75, emit=True)
    b.bolt(0.5, 0.88, 0, [(0, 1.0), (0.1, 0.9), (0.06, 0.8), (0.2, 0.72), (0.16, 0.6), (0.3, 0.5)], 0.022, 'ice2', 0.75, emit=True)
    b.bolt(0.5, 0.88, 0, [(0, 1.12), (0.04, 1.25), (-0.03, 1.35), (0.02, 1.48)], 0.02, 'ice2', 0.75, emit=True)


# ---- AA gun --------------------------------------------------------------------------------------


def agun(b):
    # A round sand-bagged emplacement: a pale ring wall around a dirt floor; the twin cannon turns on top.
    b.cyl(0.5, 0.5, 0.45, 0.18, 'sand', 0, 12)
    b.cyl(0.5, 0.5, 0.32, 0.01, 'dirt', 0.18, 12)
    b.cyl(0.5, 0.5, 0.18, 0.1, 'steel', 0.18)


def agun_turret():
    u = Unit()
    u.cyl(0, 0, 4.4, 2.4, 'steel', 6.0)
    u.box(-4.8, -4.4, 9.6, 8.8, 3.2, 'dark', 8.4)  # gun cradle
    u.box(-3.6, -3.4, 7.2, 5.4, 0.8, 'T', 11.6)
    u.box(-1.6, -2.8, 3.2, 2.0, 1.2, 'glass', 11.6)
    for x in (-3.4, 3.4):
        u.tube((x, -2, 12.4), (x, 12, 19.6), 1.2, 'steel')
        u.tube((x, 10, 18.6), (x, 12.6, 19.9), 1.7, 'darker')
    return u


# ---- SAM site ------------------------------------------------------------------------------------


def sam(b):
    # A sand pad 2 x 1 with a team marker, the launcher ring in the middle and the radar dish on a mast to the east.
    b.box(0, 0.05, 2, 0.9, 0.2, 'sand')
    b.box(0.12, 0.17, 1.76, 0.66, 0.01, 'dirt', 0.2)
    b.box(0.15, 0.22, 0.18, 0.18, 0.02, 'T', 0.21)
    b.cyl(1.0, 0.5, 0.26, 0.1, 'steel', 0.21)
    b.box(1.58, 0.5, 0.07, 0.07, 0.5, 'steel', 0.21)
    b.cyl(1.615, 0.54, 0.1, 0.1, 'dark', 0.52)
    b.bill(1.615, 0.58, 0.62, circ(0, 0, 0.21, 8), 'dome')
    b.bill(1.615, 0.585, 0.62, circ(0, 0, 0.06, 8), 'dark')


def sam_turret():
    u = Unit()
    u.cyl(0, 0, 6, 2.4, 'steel', 7.4)
    u.box(-5, -5, 10, 10, 3.2, 'dark', 9.8)
    u.box(-3.4, -3.4, 6.8, 6.8, 0.8, 'T', 13.0)
    # Three missiles on rails, raised towards the front, with red noses.
    for x in (-3.6, 0, 3.6):
        u.tube((x, -4, 14.6), (x, 7, 20.4), 1.7, 'paint')
        u.tube((x, 6, 20.0), (x, 9, 21.6), 1.7, 'red')
    return u


# ---- Lightning rod -------------------------------------------------------------------------------


def lrod(b):
    # Pad with a team stripe, four copper earthing wires, a tall rod with copper rings and a glowing tip with a bolt.
    b.box(0.25, 0.25, 0.5, 0.5, 0.1, 'concrete')
    for x, y in ((-0.05, -0.05), (1.05, -0.05), (-0.05, 1.05), (1.05, 1.05)):
        dx, dy = x - 0.5, y - 0.5
        l = math.sqrt(dx * dx + dy * dy)
        px, py = -dy / l * 0.025, dx / l * 0.025
        b.flat([(0.5 + px, 0.5 + py), (x + px, y + py), (x - px, y - py), (0.5 - px, 0.5 - py)], 0.003, 'copper')
    b.box(0.25, 0.75, 0.5, 0.03, 0.08, 'T', 0.02)
    b.box(0.46, 0.46, 0.08, 0.08, 1.4, 'steel', 0.1)
    for z in (0.5, 0.9, 1.3):
        b.cyl(0.5, 0.5, 0.11, 0.04, 'copper', z, 8, False)
    b.cyl(0.5, 0.5, 0.06, 0.12, 'copper', 1.5)
    b.vdome(0.5, 0.5, 0.18, 0.25, 'glow', 1.5, a=0.4, emit=True)
    path = [(0, 1.62), (0.12, 1.85), (-0.04, 2.0), (0.1, 2.25), (-0.02, 2.45), (0.08, 2.65)]
    b.bolt(0.5, 0.54, 0, path, 0.06, 'glow', 0.35, emit=True)
    b.bolt(0.5, 0.54, 0, path, 0.025, 'ice2', 0.8, emit=True)
    b.bolt(0.5, 0.54, 0, [(0.1, 2.25), (0.26, 2.16), (0.3, 2.0)], 0.018, 'ice2', 0.8, emit=True)


# ---- Walls: one segment per cell, full cell width so neighbours join --------------------------------


def sbag(b):
    # Two courses of sandbags: three bags below, two above laid across the joints; gaps show as dark seams.
    for i in range(3):
        b.box(i / 3.0 + 0.01, 0.22, 1 / 3.0 - 0.02, 0.56, 0.17, 'sand' if i % 2 else 'sandy')
    for i in range(2):
        b.box(i * 0.5 + 0.01, 0.28, 0.48, 0.44, 0.15, 'sandy' if i % 2 else 'sand', 0.17)
    b.box(0.0, 0.3, 1.0, 0.4, 0.01, 'sand', 0.32)


def fenc(b):
    # A chain-link fence: translucent mesh between two rails, a post at the west edge of the cell.
    b.box(0, 0.48, 1, 0.03, 0.42, 'steel2', 0, 0.45)
    b.box(0, 0.47, 1, 0.05, 0.04, 'steel', 0.4)
    b.box(0, 0.47, 1, 0.05, 0.03, 'steel', 0.02)
    b.box(0.0, 0.44, 0.08, 0.1, 0.5, 'steel')


def brik(b):
    # A concrete block with a slightly wider cap and a seam in the middle of the south face.
    b.box(0.0, 0.2, 1.0, 0.6, 0.5, WALL)
    b.box(0.0, 0.17, 1.0, 0.66, 0.07, 'concrete', 0.5)
    b.box(0.48, 0.79, 0.04, 0.02, 0.46, 'darker', 0.02)


ACTORS = {
    'PBOX': BuildingSpec(1, 1, pbox),
    'HBOX': BuildingSpec(1, 1, hbox),
    'GUN': BuildingSpec(1, 1, gun, turret=gun_turret),
    'FTUR': BuildingSpec(1, 1, ftur),
    'TSLA': BuildingSpec(1, 1, tsla),
    'AGUN': BuildingSpec(1, 1, agun, turret=agun_turret),
    'SAM': BuildingSpec(2, 1, sam, turret=sam_turret),
    'LROD': BuildingSpec(1, 1, lrod),
    'SBAG': BuildingSpec(1, 1, sbag, make=False, damage=True),
    'FENC': BuildingSpec(1, 1, fenc, make=False, damage=True),
    'BRIK': BuildingSpec(1, 1, brik, make=False, damage=True),
}
