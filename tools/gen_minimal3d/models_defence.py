"""Defence structures and walls: pillboxes, turrets, flame tower, tesla coil, AA gun, SAM site, lightning rod,
sandbags, fence and concrete wall.

Retexture of 0.21.0: two to six big blocks each, each piece fills its cell like the original sprite and keeps its
defining feature (the slit, the turning cannon, the nozzle, the coil and ball, the twin barrels, the missiles, the
rod), with one team area: a hatch, band or strip, or the turret. Buildings are drawn in cells (see core.Building). The turning turrets
(GUN, AGUN, SAM) are core.Unit models in pixels around the building centre with z from the ground (turret_offsets are
all [0, 0] in rules.json); their bodies stay static. A wall actor is one 1x1 cell piece that must look right when
many sit side by side: the segment runs the full width of the cell east-west, with no visible end caps. The pack
format cannot select connection frames."""
from core import Unit
from specs import BuildingSpec
from kit import barrel

WALL = '#d4cfc0'


def drum(b, h, c, z=0.0, k=0.3):
    """A defence's base: square at the front so it stands on its whole cell like the original, its back corners cut
    (a rounded drum seen from the 3/4 camera)."""
    b.prism([(0, 1), (1, 1), (1, k), (1 - k, 0), (k, 0), (0, k)], h, c, z)


# ---- Pillboxes -----------------------------------------------------------------------------------


def pbox(b):
    # A squat concrete drum filling its cell, a dark firing slit facing south and a team hatch on the roof.
    h = b.top(0.04)
    drum(b, h - 0.06, 'concrete')
    b.box(0.3, 0.97, 0.4, 0.04, 0.08, 'black', 0.12)
    b.cyl(0.5, 0.5, 0.2, 0.06, 'T', h - 0.06)


def hbox(b):
    # The camouflaged pillbox: a green drum with a leafy cap; the slit and the team hatch are still there.
    h = b.top(0.04)
    drum(b, h - 0.1, 'camo')
    b.cyl(0.5, 0.5, 0.36, 0.1, 'camo2', h - 0.1)
    b.box(0.32, 0.97, 0.36, 0.04, 0.07, 'black', 0.1)
    b.cyl(0.5, 0.5, 0.12, 0.02, 'T', h)


# ---- Turret (GUN) --------------------------------------------------------------------------------


def gun(b):
    # The concrete drum the cannon turns on; the turning cannon is its own sprite.
    drum(b, 0.2, 'concrete')


def gun_turret():
    # A team-coloured turret and its long barrel.
    u = Unit()
    u.cyl(0, 0, 7.5, 5.2, 'T', 4.8)
    barrel(u, 0, 4, 15, 7.4, r=1.6, c='dark', tip='darker')
    return u


# ---- Flame tower ---------------------------------------------------------------------------------


def ftur(b):
    # A brick tower with a team band and its nozzle pointing south.
    h = b.top(0.04)
    drum(b, h, 'brick')
    b.box(0.0, 0.97, 1.0, 0.04, 0.1, 'T', h - 0.2)
    b.box(0.4, 0.9, 0.2, 0.22, 0.14, 'dark', h * 0.4)


# ---- Tesla coil ----------------------------------------------------------------------------------


def tsla(b):
    # A dark base with a team strip, the copper coil and the glowing ball on top.
    f = b.front
    b.box(b.x0, f - 1.0, b.x1 - b.x0, 1.0, 0.3, 'dark')
    b.box(b.x0, f - 0.1, b.x1 - b.x0, 0.1, 0.03, 'T', 0.3)
    top = b.top(f - 0.78)
    b.cyl(0.5, f - 0.5, 0.22, top - 0.3 - 0.36, 'copper', 0.3)
    b.vdome(0.5, f - 0.5, 0.28, 0.36, 'blue', top - 0.36, emit=True)


# ---- AA gun --------------------------------------------------------------------------------------


def agun(b):
    # A round emplacement filling its cell; the twin cannon turns on top.
    drum(b, 0.3, 'sand')


def agun_turret():
    # The gun cradle in the team colour and two barrels raised high.
    u = Unit()
    u.box(-5, -4.5, 10, 9, 4, 'T', 7.2)
    for x in (-3, 3):
        u.tube((x, -1, 10), (x, 9, 18), 1.3, 'dark')
    return u


# ---- SAM site ------------------------------------------------------------------------------------


def sam(b):
    # A sand pad over both cells; the launcher turns on it.
    f = b.front
    b.box(b.x0, f - 1.0, b.x1 - b.x0, 1.0, 0.2, 'sand')
    b.box(b.x0 + 0.1, f - 0.9, b.x1 - b.x0 - 0.2, 0.8, 0.01, 'dirt', 0.2)


def sam_turret():
    # The launcher in the team colour with two missiles with red noses.
    u = Unit()
    u.box(-6, -5, 12, 10, 4, 'T', 4.8)
    for x in (-3, 3):
        u.tube((x, -5, 9.5), (x, 9, 11.5), 1.9, 'paint')
    return u


# ---- Lightning rod -------------------------------------------------------------------------------


def lrod(b):
    # A pad with a team strip, the tall rod and its glowing copper tip.
    f = b.front
    b.box(b.x0, f - 1.0, b.x1 - b.x0, 1.0, 0.12, 'concrete')
    b.box(b.x0, f - 0.1, b.x1 - b.x0, 0.1, 0.03, 'T', 0.12)
    top = b.top(f - 0.62)
    b.box(0.44, f - 0.56, 0.12, 0.12, top - 0.3, 'steel', 0.12)
    b.cyl(0.5, f - 0.5, 0.12, 0.3 - 0.12 + 0.12, 'copper', top - 0.3, emit=True)


# ---- Walls: one segment per cell, full cell width so neighbours join --------------------------------


def sbag(b):
    # Two courses of sandbags the full width of the cell.
    h = b.top(0.15)
    b.box(0.0, 0.15, 1.0, 0.85, h * 0.55, 'sand')
    b.box(0.0, 0.3, 1.0, 0.55, h * 0.45 + 0.1, 'sandy', h * 0.55)


def fenc(b):
    # A chain-link fence along the front of its cell: a translucent mesh between a ground and a top rail, a post.
    h = b.top(0.9)
    b.box(0, 0.92, 1, 0.08, 0.08, 'steel')
    b.box(0, 0.94, 1, 0.04, h - 0.14, 'steel2', 0.08, 0.45)
    b.box(0, 0.92, 1, 0.08, 0.06, 'steel', h - 0.06)
    b.box(0.0, 0.9, 0.1, 0.1, h, 'steel')


def brik(b):
    # A concrete block filling its cell, with a slightly darker cap.
    h = b.top(0.0)
    b.box(0.0, 0.0, 1.0, 1.0, h - 0.06, WALL)
    b.box(0.0, 0.0, 1.0, 1.0, 0.06, 'concrete', h - 0.06)


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
