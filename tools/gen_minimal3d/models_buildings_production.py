"""Production buildings: barracks, kennel, war factory, service depot, helipad, airstrip, naval yard, sub pen.

Ported from the Productie3D design board to the game's 3/4 camera. Coordinates are cells, see core.Building.
The camera sees the south faces and the roofs, so doors, ramps and signs face south (+y)."""
from core import dcos, dsin
from specs import BuildingSpec

# Wrench outline of the board (unit square, tip up), laid flat on the depot pad.
WRENCH = [(-0.2, -0.1), (-0.2, -0.28), (-0.08, -0.38), (-0.08, -0.22), (0.08, -0.22), (0.08, -0.38), (0.2, -0.28),
          (0.2, -0.1), (0.07, 0.02), (0.07, 0.42), (0.0, 0.48), (-0.07, 0.42), (-0.07, 0.02)]


def place(pts, cx, cy, s, rot_deg):
    c, n = dcos(rot_deg), dsin(rot_deg)
    return [(cx + s * (u * c - v * n), cy + s * (u * n + v * c)) for u, v in pts]


def tent(b):
    # Canvas tent with a team band over both roof halves, sandbags, a doorway and a flag.
    b.box(0, 2.5, 2, 0.5, 0.06, 'concrete')
    b.box(0.2, 0.2, 1.6, 2.1, 0.3, 'canvas')
    b.gable(0.2, 0.2, 1.6, 2.1, 0.6, 'canvas', 0.3, 'y')
    b.band(0.2, 0.2, 1.6, 2.1, 0.6, 0.3, 'y', 'a', 0.35, 0.55, 'T')
    b.band(0.2, 0.2, 1.6, 2.1, 0.6, 0.3, 'y', 'b', 0.35, 0.55, 'T')
    # Gable end of the roof (south) gets a team triangle too, so the owner is readable from the front.
    b.poly([(0.7, 2.3, 0.66), (1.3, 2.3, 0.66), (1.0, 2.3, 0.86)], 'T')
    b.box(0.8, 2.3, 0.4, 0.03, 0.38, 'darker')
    b.box(0.05, 2.3, 0.6, 0.25, 0.2, 'sand')
    b.box(1.35, 2.3, 0.6, 0.25, 0.2, 'sand')
    # Flag pole at the north-east corner: set back a little so the roof does not hide the flag.
    b.box(1.75, 0.15, 0.06, 0.06, 1.25, 'dark')
    b.box(1.81, 0.15, 0.35, 0.05, 0.24, 'T', 0.98)


def barr(b):
    # Brick barracks, tiled gable roof with team stripes, a chimney, team pennant over the door, sandbags.
    b.box(0, 2.45, 2, 0.55, 0.06, 'concrete')
    b.box(0.15, 0.25, 1.7, 2.0, 0.55, 'brick')
    b.gable(0.1, 0.2, 1.8, 2.1, 0.5, 'tiles', 0.55, 'y')
    for side in ('a', 'b'):
        b.band(0.1, 0.2, 1.8, 2.1, 0.5, 0.55, 'y', side, 0.2, 0.34, 'T')
        b.band(0.1, 0.2, 1.8, 2.1, 0.5, 0.55, 'y', side, 0.58, 0.72, 'T')
    b.box(0.4, 0.55, 0.2, 0.2, 0.75, 'brick', 0.55)
    b.box(0.38, 0.53, 0.24, 0.24, 0.05, 'dark', 1.3)
    b.poly([(0.86, 2.26, 0.6), (1.14, 2.26, 0.6), (1.14, 2.26, 0.86), (0.86, 2.26, 0.86)], 'T')
    b.box(0.78, 2.25, 0.44, 0.04, 0.42, '#6a4a2e')
    b.box(0.05, 2.5, 0.55, 0.25, 0.2, 'sand')
    b.box(1.4, 2.5, 0.55, 0.25, 0.2, 'sand')


def kenn(b):
    # Wooden dog house with a team band on the roof, a dark doorway and a red bowl.
    b.box(0.2, 0.2, 0.6, 0.55, 0.3, 'wood')
    b.gable(0.15, 0.17, 0.7, 0.6, 0.3, '#8a5a2e', 0.3, 'y')
    b.band(0.15, 0.17, 0.7, 0.6, 0.3, 0.3, 'y', 'a', 0.0, 0.3, 'T')
    b.band(0.15, 0.17, 0.7, 0.6, 0.3, 0.3, 'y', 'b', 0.0, 0.3, 'T')
    b.box(0.4, 0.75, 0.2, 0.03, 0.22, 'darker')
    b.cyl(0.85, 0.88, 0.09, 0.05, 'red')


def weap(b):
    # Hall on an asphalt apron with a team-striped saw-tooth roof, an open door framed in yellow, and a tank on the ramp.
    b.box(0, 2.15, 3, 0.85, 0.04, 'asphalt')
    b.flat([(0.3, 2.5), (0.55, 2.7), (0.3, 2.9), (0.3, 2.8), (0.42, 2.7), (0.3, 2.6)], 0.041, 'paint')
    b.flat([(2.45, 2.5), (2.7, 2.7), (2.45, 2.9), (2.45, 2.8), (2.57, 2.7), (2.45, 2.6)], 0.041, 'paint')
    b.box(0.1, 0.15, 2.8, 2.0, 1.0, 'wall')
    b.box(0.1, 0.15, 2.8, 0.1, 0.04, 'T', 1.0)
    b.box(0.1, 2.05, 2.8, 0.1, 0.04, 'T', 1.0)
    b.gable(0.4, 0.35, 2.2, 1.5, 0.45, 'steel', 1.0, 'x')
    b.band(0.4, 0.35, 2.2, 1.5, 0.45, 1.0, 'x', 'a', 0.3, 0.5, 'T')
    b.band(0.4, 0.35, 2.2, 1.5, 0.45, 1.0, 'x', 'b', 0.3, 0.5, 'T')
    # Open door in the south wall, yellow frame.
    b.box(0.7, 2.15, 1.6, 0.02, 0.8, 'darker')
    b.box(0.6, 2.15, 0.1, 0.05, 0.86, 'yellow')
    b.box(2.3, 2.15, 0.1, 0.05, 0.86, 'yellow')
    b.box(0.6, 2.15, 1.8, 0.05, 0.08, 'yellow', 0.86)
    # A tank rolling out on the ramp: tracks, hull with a team stripe, turret and a barrel pointing south.
    b.box(1.05, 2.4, 0.2, 0.55, 0.16, 'dark', 0.04)
    b.box(1.75, 2.4, 0.2, 0.55, 0.16, 'dark', 0.04)
    b.box(1.15, 2.45, 0.7, 0.45, 0.14, 'steel', 0.1)
    b.box(1.15, 2.45, 0.7, 0.08, 0.02, 'T', 0.24)
    b.cyl(1.5, 2.63, 0.17, 0.11, 'steel2', 0.24)
    b.box(1.46, 2.7, 0.08, 0.42, 0.06, 'dark', 0.28)


def fix(b):
    # Hexagonal yellow pad with a big wrench, a gantry on the north side with a team lamp.
    b.box(0, 0, 3, 3, 0.05, 'concrete')
    b.cyl(1.5, 1.75, 1.1, 0.08, 'yellow', 0.05, 6)
    b.cyl(1.5, 1.75, 0.95, 0.01, 'asphalt', 0.13, 6)
    b.flat(place(WRENCH, 1.5, 1.75, 1.6, -45), 0.145, 'paint')
    b.box(0.9, 0.1, 1.2, 0.6, 0.6, 'wall', 0.05)
    b.box(0.9, 0.1, 1.2, 0.08, 0.04, 'T', 0.65)
    b.box(0.9, 0.62, 1.2, 0.08, 0.04, 'T', 0.65)
    b.box(0.2, 0.2, 0.15, 0.15, 0.9, 'steel', 0.05)
    b.box(2.65, 0.2, 0.15, 0.15, 0.9, 'steel', 0.05)
    b.box(0.2, 0.2, 2.6, 0.15, 0.12, 'yellow', 0.95)
    b.box(1.4, 0.18, 0.2, 0.2, 0.12, 'T', 0.83)


def hpad(b):
    # Round pad with a team rim and an H, ring lights, an office hut with a beacon, a red fuel tank and a wind sock.
    b.box(0, 0, 2, 3, 0.05, 'concrete')
    b.cyl(1, 1.9, 0.86, 0.01, 'T', 0.05, 16)
    b.cyl(1, 1.9, 0.78, 0.02, 'asphalt', 0.06, 16)
    b.box(0.7, 1.55, 0.12, 0.7, 0.01, 'paint', 0.08)
    b.box(1.18, 1.55, 0.12, 0.7, 0.01, 'paint', 0.08)
    b.box(0.7, 1.84, 0.6, 0.12, 0.01, 'paint', 0.08)
    for i in range(8):
        a = 360.0 * i / 8
        x, y = 1 + 0.93 * dcos(a), 1.9 + 0.93 * dsin(a)
        b.cyl(x, y, 0.11, 0.005, 'glow', 0.05, 8, True, 0.35)
        b.box(x - 0.04, y - 0.04, 0.08, 0.08, 0.06, 'glow', 0.05, emit=True)
    b.box(0.15, 0.1, 0.9, 0.7, 0.5, 'wall', 0.05)
    b.box(0.25, 0.8, 0.7, 0.02, 0.15, 'glass', 0.3)
    b.box(0.15, 0.1, 0.9, 0.7, 0.04, 'T', 0.55)
    b.cyl(0.6, 0.45, 0.07, 0.1, 'red', 0.59)
    b.cyl(1.6, 0.45, 0.25, 0.4, 'red', 0.05)
    b.box(1.78, 2.83, 0.04, 0.04, 0.7, 'paint', 0.05)
    b.bill(1.8, 2.85, 0.6, [(0, 0.16), (0.42, 0.11), (0.42, 0.04), (0, 0)], '#ff7a1a')


def afld(b):
    # Asphalt strip with centre lines, threshold bars, edge lights (green start, red end), a hangar with a team roof band,
    # a wind sock, and a control tower with a glass cab and a beacon.
    b.box(0, 0, 3, 2, 0.04, 'asphalt')
    b.box(0.1, 0.98, 2.8, 0.04, 0.003, 'paint', 0.04)
    b.box(0.1, 1.86, 2.8, 0.04, 0.003, 'paint', 0.04)
    for x in (0.75, 1.25, 1.75, 2.25):
        b.box(x, 1.4, 0.3, 0.05, 0.003, 'paint', 0.04)
    for y in (1.1, 1.3, 1.5, 1.7):
        b.box(0.18, y - 0.04, 0.3, 0.08, 0.003, 'paint', 0.04)
    for i, y in enumerate((0.12, 1.22, 1.42, 1.62)):
        if i:
            b.box(-0.16, y, 0.07, 0.07, 0.05, 'blue', 0)
    for i, x in enumerate((0.1, 0.5, 0.9, 1.3, 1.7, 2.1, 2.5, 2.9)):
        c = 'green' if i == 0 else 'red' if i == 7 else 'glow'
        b.box(x - 0.035, 0.89, 0.07, 0.07, 0.05, c, 0.04, emit=True)
        b.box(x - 0.035, 1.92, 0.07, 0.07, 0.05, c, 0.04, emit=True)
    b.box(0.1, 0.1, 1.1, 0.65, 0.3, 'steel', 0.04)
    b.gable(0.1, 0.1, 1.1, 0.65, 0.28, 'steel2', 0.34, 'x')
    b.band(0.1, 0.1, 1.1, 0.65, 0.28, 0.34, 'x', 'a', 0.3, 0.6, 'T')
    b.box(0.3, 0.75, 0.7, 0.02, 0.24, 'darker', 0.04)
    b.box(1.55, 0.3, 0.04, 0.04, 0.6, 'paint', 0.04)
    b.bill(1.57, 0.32, 0.5, [(0, 0.14), (0.36, 0.1), (0.36, 0.04), (0, 0)], '#ff7a1a')
    b.box(2.35, 0.1, 0.5, 0.5, 0.95, 'wall', 0.04)
    b.box(2.3, 0.05, 0.6, 0.6, 0.22, 'glass', 0.99)
    b.box(2.28, 0.03, 0.64, 0.64, 0.05, 'T', 1.21)
    b.cyl(2.6, 0.35, 0.06, 0.08, 'glow', 1.26, emit=True)


def syrd(b):
    # U-shaped dock on the water with team quay edges, a crane with a team cab on the west quay, and buoys.
    b.box(0, 0, 3, 0.7, 0.2, 'concrete')
    b.box(0.5, 0.62, 2.0, 0.08, 0.02, 'T', 0.2)
    b.box(0, 0.7, 0.5, 2.3, 0.2, 'concrete')
    b.box(0.42, 0.7, 0.08, 2.3, 0.02, 'T', 0.2)
    b.box(0.2, 0.1, 0.9, 0.5, 0.4, 'wall', 0.2)
    b.box(0.2, 0.1, 0.9, 0.5, 0.04, 'T', 0.6)
    b.box(1.8, 0.25, 0.15, 0.15, 0.9, 'steel', 0.2)
    b.box(1.74, 0.2, 0.27, 0.25, 0.18, 'T', 0.95)
    b.box(1.82, 0.25, 0.12, 1.5, 0.1, 'yellow', 1.13)
    b.box(1.87, 1.7, 0.02, 0.02, 0.5, 'darker', 0.63)
    b.cyl(1.5, 2.6, 0.12, 0.14, 'T', -0.04)
    b.cyl(1.5, 2.6, 0.05, 0.05, 'glow', 0.1, emit=True)
    b.box(2.5, 0.7, 0.5, 2.3, 0.2, 'concrete')
    b.box(2.5, 0.7, 0.08, 2.3, 0.02, 'T', 0.2)
    b.box(0, 2.85, 0.5, 0.15, 0.01, 'yellow', 0.2)
    b.box(2.5, 2.85, 0.5, 0.15, 0.01, 'yellow', 0.2)


def spen(b):
    # Concrete bunker with team stripes over a gabled roof, a team-framed dark opening towards the water, buoys.
    b.box(0.1, 0.1, 2.8, 2.0, 0.5, 'concrete')
    b.gable(0.1, 0.1, 2.8, 2.0, 0.45, 'roof', 0.5, 'x')
    b.band(0.1, 0.1, 2.8, 2.0, 0.45, 0.5, 'x', 'a', 0.25, 0.45, 'T')
    b.band(0.1, 0.1, 2.8, 2.0, 0.45, 0.5, 'x', 'b', 0.25, 0.45, 'T')
    b.box(0.85, 2.1, 1.3, 0.05, 0.48, 'T')
    b.box(0.95, 2.15, 1.1, 0.05, 0.38, '#0e1a22')
    b.cyl(0.5, 2.6, 0.12, 0.14, 'T', -0.04)
    b.cyl(2.5, 2.6, 0.12, 0.14, 'T', -0.04)


ACTORS = {
    'TENT': BuildingSpec(2, 3, tent),
    'BARR': BuildingSpec(2, 3, barr, second_hidden=True),
    'KENN': BuildingSpec(1, 1, kenn),
    'WEAP': BuildingSpec(3, 3, weap),
    'FIX': BuildingSpec(3, 3, fix),
    'HPAD': BuildingSpec(2, 3, hpad, second_hidden=True),
    'AFLD': BuildingSpec(3, 2, afld, second_hidden=True),
    'SYRD': BuildingSpec(3, 3, syrd, ground='water'),
    'SPEN': BuildingSpec(3, 3, spen, ground='water'),
}

ALIASES = {'AFLD.Ukraine': 'AFLD', 'TENF': 'TENT', 'WEAF': 'WEAP', 'FIXF': 'FIX', 'SYRF': 'SYRD', 'SPEF': 'SPEN'}
