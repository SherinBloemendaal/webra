"""Production buildings: barracks, kennel, war factory, service depot, helipad, airstrip, naval yard, sub pen.

Retexture of 0.21.0: three to six big blocks each, the defining feature kept (the factory's big door, the tent's
canvas roof, the depot's wrench pad, the helipad's H, the airstrip's runway and tower, the yard's crane over the
dock, the pen's dark water gate) and one team strip. Coordinates are cells, see core.Building and
models_buildings_base. The camera sees the south faces and the roofs, so doors, ramps and signs face south (+y)."""
from core import dcos, dsin
from specs import BuildingSpec

# Wrench outline (unit square, tip up), laid flat on the depot pad.
WRENCH = [(-0.2, -0.1), (-0.2, -0.28), (-0.08, -0.38), (-0.08, -0.22), (0.08, -0.22), (0.08, -0.38), (0.2, -0.28),
          (0.2, -0.1), (0.07, 0.02), (0.07, 0.42), (0.0, 0.48), (-0.07, 0.42), (-0.07, 0.02)]


def place(pts, cx, cy, s, rot_deg):
    c, n = dcos(rot_deg), dsin(rot_deg)
    return [(cx + s * (u * c - v * n), cy + s * (u * n + v * c)) for u, v in pts]


def _gable_house(b, wall, roof, depth, wall_h, door='darker'):
    """Walls the full width from the front back `depth` cells, a gable roof (ridge north-south) up to the top of the
    original sprite, a team band on the east slope and a door in the middle of the south face (4 shapes)."""
    f, x0, x1 = b.front, b.x0, b.x1
    y0 = f - depth
    b.box(x0, y0, x1 - x0, depth, wall_h, wall)
    rh = b.top(y0) - wall_h
    b.gable(x0, y0, x1 - x0, depth, rh, roof, wall_h, 'y')
    b.band(x0, y0, x1 - x0, depth, rh, wall_h, 'y', 'a', 0.25, 0.65, 'T')
    w = (x1 - x0) * 0.26
    b.box((x0 + x1 - w) / 2, f - 0.02, w, 0.03, wall_h * 0.85, door)


def tent(b):
    # The canvas tent: low walls and a steep canvas roof with a team band, a dark doorway.
    b.apron('sand')
    _gable_house(b, 'canvas', 'canvas', 2.0, 0.28)


def barr(b):
    # Brick barracks with a tiled roof and a team band, a door, and the chimney.
    f = b.front
    b.apron()
    _gable_house(b, 'brick', 'tiles', 1.8, 0.45, '#6a4a2e')
    b.box(0.3, f - 1.55, 0.24, 0.24, b.top(f - 1.55) - 0.1, 'brick')


def kenn(b):
    # The dog house: wooden walls, a roof with a team band, a dark doorway.
    _gable_house(b, 'wood', '#8a5a2e', 0.9, 0.22)


def weap(b):
    # Hangar with a gable roof whose eaves carry the team strip, and the big dark door framed in yellow.
    f, x0, x1 = b.front, b.x0, b.x1
    b.apron('asphalt')
    depth = 2.0
    wall_h = 0.8
    b.box(x0, f - depth, x1 - x0, depth, wall_h, 'wall')
    # The ridge (half way back) reaches the top of the original sprite.
    rh = b.top(f - depth / 2) - wall_h
    b.gable(x0, f - depth, x1 - x0, depth, rh, 'roof', wall_h, 'x')
    b.band(x0, f - depth, x1 - x0, depth, rh, wall_h, 'x', 'a', 0.72, 1.0, 'T')
    b.box(0.5, f - 0.02, 2.0, 0.03, 0.66, 'darker')
    b.box(0.4, f - 0.03, 2.2, 0.04, 0.1, 'yellow', 0.66)


def fix(b):
    # The service pad: a yellow octagon with a big wrench, and a workshop with a team strip at the back.
    f = b.front
    r = 1.3
    cy = f - 0.1 - 0.924 * r
    b.box(b.x0, f - 2.0, b.x1 - b.x0, 2.0, 0.05, 'concrete')
    b.cyl(1.5, cy, r, 0.04, 'yellow', 0.05)
    b.cyl(1.5, cy, r - 0.18, 0.02, 'asphalt', 0.09)
    b.flat(place(WRENCH, 1.5, cy + 0.15, 1.5, -45), 0.111, 'paint')
    hut = cy - 0.95
    b.block(0.9, hut, 1.2, 0.5, 'wall')
    b.box(0.9, hut + 0.42, 1.2, 0.08, 0.04, 'T', b.top(hut))


def hpad(b):
    # The pad with a team rim and a big H, and the small office behind it.
    f = b.front
    b.apron()
    b.box(b.x0, f - 1.45, b.x1 - b.x0, 1.45, 0.06, 'asphalt')
    b.cyl(1.0, f - 0.72, 0.7, 0.02, 'T', 0.06, 16)
    b.box(0.68, f - 1.12, 0.14, 0.8, 0.02, 'paint', 0.08)
    b.box(1.18, f - 1.12, 0.14, 0.8, 0.02, 'paint', 0.08)
    b.box(0.68, f - 0.79, 0.64, 0.14, 0.02, 'paint', 0.08)
    b.block(b.x0, f - 2.0, b.x1 - b.x0, 0.55, 'wall')


def afld(b):
    # The runway with its centre line and a hangar with a team strip, and the control tower with its glass cab.
    f, x0, x1 = b.front, b.x0, b.x1
    b.box(x0, f - 1.3, x1 - x0, 1.3, 0.04, 'asphalt')
    b.box(x0 + 0.2, f - 0.68, x1 - x0 - 0.4, 0.08, 0.005, 'paint', 0.04)
    b.box(x0, f - 2.0, 1.7, 0.7, 0.42, 'steel')
    b.box(x0, f - 1.38, 1.7, 0.08, 0.04, 'T', 0.42)
    tower = f - 2.0
    b.box(2.2, tower, 0.6, 0.6, b.top(tower) - 0.2, 'wall')
    b.box(2.15, tower, 0.7, 0.7, 0.2, 'glass', b.top(tower) - 0.2)


def syrd(b):
    # The U-shaped dock on the water with a team edge, and the crane over the berth.
    f, x0, x1 = b.front, b.x0, b.x1
    back = f - 2.0
    b.box(x0, back, x1 - x0, 0.6, 0.2, 'concrete')
    b.box(x0, back + 0.6, 0.5, 1.4, 0.2, 'concrete')
    b.box(x1 - 0.5, back + 0.6, 0.5, 1.4, 0.2, 'concrete')
    b.box(x0 + 0.5, back + 0.5, x1 - x0 - 1.0, 0.1, 0.02, 'T', 0.2)
    top = b.top(back + 0.1)
    b.box(1.8, back + 0.1, 0.18, 0.18, top - 0.12, 'yellow', 0.2)
    b.box(1.78, back + 0.1, 0.22, 1.6, 0.12, 'yellow', top - 0.12)


def spen(b):
    # The concrete pen with a team band on its roof and the dark water gate in its south face.
    f, x0, x1 = b.front, b.x0, b.x1
    depth = 2.0
    wall_h = 0.7
    b.box(x0, f - depth, x1 - x0, depth, wall_h, 'concrete')
    rh = b.top(f - depth / 2) - wall_h
    b.gable(x0, f - depth, x1 - x0, depth, rh, 'roof', wall_h, 'x')
    b.band(x0, f - depth, x1 - x0, depth, rh, wall_h, 'x', 'a', 0.7, 1.0, 'T')
    b.box(0.6, f - 0.02, 1.8, 0.03, 0.58, '#0e1a22')


ACTORS = {
    'TENT': BuildingSpec(2, 3, tent),
    'BARR': BuildingSpec(2, 3, barr, second_hidden=True),
    'KENN': BuildingSpec(1, 1, kenn),
    'WEAP': BuildingSpec(3, 3, weap),
    'FIX': BuildingSpec(3, 3, fix),
    'HPAD': BuildingSpec(2, 3, hpad, second_hidden=True),
    'AFLD': BuildingSpec(3, 2, afld, second_hidden=True),
    'SYRD': BuildingSpec(3, 3, syrd),
    'SPEN': BuildingSpec(3, 3, spen),
}

ALIASES = {'AFLD.Ukraine': 'AFLD', 'TENF': 'TENT', 'WEAF': 'WEAP', 'FIXF': 'FIX', 'SYRF': 'SYRD', 'SPEF': 'SPEN'}
