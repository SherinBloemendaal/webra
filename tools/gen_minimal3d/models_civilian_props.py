"""Tech buildings and the civilian village: Forward Command, hospital, biological lab, communications center, oil
derrick, the village houses V01 to V11, haystacks, fields and the oil pump (with its burnt husk).

Retexture of 0.21.0: three to six big blocks, each piece fills its footprint like the original sprite (see
core.Building), the defining feature kept (the hospital's red cross, the lab's green tanks, the big dish, the derrick,
the church tower, the awning, the canopy over the pumps, the hay, the crop rows, the walking beam). Civilian
structures are never team coloured (the original art draws them with fixed palettes); the tech buildings carry one
team strip."""
from specs import BuildingSpec

WALLS = ('wall', '#e8c9a0', '#cfd8dc', '#d9c28a', '#c8d6b0')
BURNT = '#3b3835'


def house(b, wall, roof, axis='x', wall_h=0.3, x0=None, x1=None, depth=None, door=True):
    """Walls over the footprint (or x0..x1, `depth` cells back from the front) and a gable roof whose ridge reaches
    the top of the original sprite, a dark door in the south face (3 shapes). The roof rises at most about as much
    as half the span: what is left of the height goes to the walls (at least `wall_h`)."""
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
    if door:
        w = min(0.3, (x1 - x0) * 0.3)
        b.box((x0 + x1 - w) / 2, f - 0.02, w, 0.03, min(wall_h * 0.8, 0.3), 'darker')


# ---- Tech buildings ---------------------------------------------------------------------------------


def hospital(b):
    # A white two storey block with a team strip and the red cross on its roof.
    f = b.front
    b.block(b.x0, f - 1.45, b.x1 - b.x0, 1.45, 'paint')
    top = b.top(f - 1.45)
    b.box(b.x0, f - 0.18, b.x1 - b.x0, 0.18, 0.04, 'T', top)
    b.box(0.75, f - 1.25, 0.5, 1.1, 0.04, 'red', top)
    b.box(0.45, f - 0.95, 1.1, 0.5, 0.04, 'red', top)


def biolab(b):
    # A grey lab hall with a team strip and the two green culture tanks beside it.
    f = b.front
    b.box(b.x0, f - 1.5, 1.3, 1.5, 0.75, 'steel2')
    b.box(b.x0, f - 0.18, 1.3, 0.18, 0.04, 'T', 0.75)
    for y in (f - 1.45, f - 0.65):
        b.cyl(1.65, y + 0.32, 0.33, b.top(y), 'green')


def fcom(b):
    # The camouflaged bunker with a sandbag wall, the radar mast and the owner's flag.
    f = b.front
    b.apron()
    b.box(b.x0, f - 1.5, b.x1 - b.x0, 1.5, 0.6, 'camo')
    b.box(b.x0, f - 0.3, b.x1 - b.x0, 0.3, 0.3, 'sand')
    mast = f - 1.9
    top = b.top(mast)
    b.box(0.4, mast, 0.12, 0.12, top, 'steel')
    b.box(0.52, mast, 0.5, 0.06, 0.3, 'T', top - 0.3)


def miss(b):
    # The communications center: a long hall with a team strip and the big dish on its pedestal.
    f = b.front
    b.apron()
    b.box(b.x0, f - 1.2, b.x1 - b.x0, 1.2, 0.6, 'wall')
    b.box(b.x0, f - 0.18, b.x1 - b.x0, 0.18, 0.04, 'T', 0.6)
    post = f - 1.7
    top = b.top(post)
    b.box(1.85, post, 0.22, 0.22, top - 0.62, 'steel')
    b.bill(1.96, post + 0.24, top - 0.62, [(-0.4 + 0.8 * i / 7, 0.4 * (1 - ((i - 3.5) / 3.5) ** 2) * 2) for i in range(8)]
           + [(0.4, 0.0), (-0.4, 0.0)], 'dome')


def oilb(b):
    # The oil derrick: a pad, the derrick tower, the storage tank with a team band.
    f = b.front
    b.box(b.x0, f - 2.0, b.x1 - b.x0, 2.0, 0.08, 'concrete')
    b.pyramid(0.6, f - 1.35, 0.45, 0.45, b.top(f - 1.35) - 0.08, 'steel', 0.08)
    b.cyl(1.45, f - 0.6, 0.48, 0.65, 'steel2', 0.08)
    b.cyl(1.45, f - 0.6, 0.49, 0.12, 'T', 0.5, 8, False)


# ---- The village --------------------------------------------------------------------------------------


def church(b):
    # V01: the nave with its tiled roof, and the tower with its spire in front.
    f = b.front
    house(b, 'wall', 'tiles', 'y', 0.4, b.x0, b.x1, 1.6, door=False)
    b.box(0.72, f - 0.55, 0.56, 0.55, 0.9, 'concrete')
    b.pyramid(1.0, f - 0.27, 0.3, 0.27, b.top(f - 0.55) - 0.9, 'dark', 0.9)


def house_big(b):
    # V02: a farmhouse with a long red roof and a chimney.
    f = b.front
    house(b, WALLS[1], 'tiles', 'x', 0.4, depth=1.4)
    b.box(1.5, f - 1.15, 0.2, 0.2, b.top(f - 1.15), 'brick')


def house_two(b):
    # V03: a brick townhouse, two storeys under a steep roof.
    house(b, 'brick', 'dark', 'y', 0.7, depth=1.5)


def house_garden(b):
    # V04: a cottage at the back of its garden, with a hedge along the front.
    f = b.front
    house(b, WALLS[2], 'tiles', 'x', 0.35, depth=1.3, x0=b.x0, x1=b.x1)
    b.box(b.x0, f - 0.15, b.x1 - b.x0, 0.15, 0.15, 'camo')


def shop(b):
    # V05: a corner shop with a flat roof and a striped awning over the windows.
    f = b.front
    b.block(b.x0, f - 0.8, b.x1 - b.x0, 0.8, WALLS[3])
    b.box(b.x0 + 0.1, f - 0.25, b.x1 - b.x0 - 0.2, 0.25, 0.06, 'red', 0.36)
    b.box(b.x0 + 0.2, f - 0.21, b.x1 - b.x0 - 0.4, 0.02, 0.15, 'glass', 0.15)


def cottage_long(b):
    # V06: a long low cottage under a thatched roof.
    house(b, WALLS[4], 'sand', 'x', 0.22)


def gas_station(b):
    # V07: the petrol station: asphalt, the shop at the back, the flat canopy on its pillar over the pumps.
    f = b.front
    b.box(b.x0, f - 1.0, b.x1 - b.x0, 1.0, 0.03, 'asphalt')
    b.block(b.x0, f - 1.0, 0.8, 0.6, 'wall')
    b.box(1.25, f - 0.5, 0.12, 0.12, 0.35, 'steel')
    b.box(0.9, f - 0.85, 1.1, 0.75, 0.08, 'red', 0.35)


def cottage_row(b):
    # V08: a small hut with a red roof.
    house(b, WALLS[0], 'tiles', 'x', 0.22)


def shed(b):
    # V09: a timber shed with a dark roof and a hay door.
    house(b, 'wood', 'dark', 'y', 0.25)


def kiosk(b):
    # V10: a small flat-roofed shop with a striped awning.
    f = b.front
    b.block(b.x0, f - 0.75, 1.0, 0.75, WALLS[1])
    b.box(b.x0 + 0.05, f - 0.25, 0.9, 0.25, 0.05, 'red', 0.3)


def house_tall(b):
    # V11: a narrow two storey house with a green roof.
    house(b, WALLS[2], 'camo', 'y', 0.45)


def haystack(b):
    # V12: a hay rick on its base.
    b.box(b.x0 + 0.05, 0.05, 0.9, 0.9, 0.08, 'wood')
    b.vdome(0.5, 0.5, 0.42, b.top(0.25) - 0.08, 'gold', 0.08)


def haybales(b):
    # V13: round bales, two below and one on top.
    for x in (0.3, 0.7):
        b.cyl(x, 0.55, 0.2, 0.24, 'gold')
    b.cyl(0.5, 0.45, 0.2, 0.2, 'sand', 0.24)


def field(b, crop):
    # V14 to V18: tilled soil with three raised crop rows, wheat gold, vegetables green.
    b.box(0.0, 0.0, 1.0, 1.0, 0.03, 'dirt')
    c = 'gold' if crop == 'wheat' else 'camo2'
    for y in (0.1, 0.42, 0.74):
        b.box(0.08, y, 0.84, 0.18, 0.08, c, 0.03)


def pumpjack(b, burnt=False):
    # V19: the pumpjack on its pad: the motor box, the post and the walking beam with its horse head.
    pad, c, beam = ('#4a4743', BURNT, BURNT) if burnt else ('concrete', 'dark', 'steel')
    b.box(0.0, 0.0, 1.0, 1.0, 0.05, pad)
    b.box(0.1, 0.4, 0.3, 0.4, 0.25, c, 0.05)
    b.box(0.45, 0.45, 0.1, 0.1, 0.35, beam, 0.05)
    b.beam((0.15, 0.5, 0.45), (0.9, 0.5, 0.35), 0.1, beam)


def _civ(w, d, draw, flat=False):
    return BuildingSpec(w, d, draw, damage=True, make=False, flat=flat, shear=not flat)


ACTORS = {
    'FCOM': BuildingSpec(2, 3, fcom, make=False),
    'HOSP': BuildingSpec(2, 2, hospital, make=False),
    'BIO': BuildingSpec(2, 2, biolab, make=False),
    'MISS': BuildingSpec(3, 3, miss, make=False),
    'OILB': BuildingSpec(2, 2, oilb, damage=True, make=False),
    'V01': _civ(2, 2, church),
    'V02': _civ(2, 2, house_big),
    'V03': _civ(2, 2, house_two),
    'V04': _civ(2, 2, house_garden),
    'V05': _civ(2, 1, shop),
    'V06': _civ(2, 1, cottage_long),
    'V07': _civ(2, 1, gas_station),
    'V08': _civ(1, 1, cottage_row),
    'V09': _civ(1, 1, shed),
    'V10': _civ(1, 1, kiosk),
    'V11': _civ(1, 1, house_tall),
    'V12': _civ(1, 1, haystack),
    'V13': _civ(1, 1, haybales),
    'V14': _civ(1, 1, lambda b: field(b, 'veg'), flat=True),
    'V15': _civ(1, 1, lambda b: field(b, 'wheat'), flat=True),
    'V16': _civ(1, 1, lambda b: field(b, 'veg'), flat=True),
    'V17': _civ(1, 1, lambda b: field(b, 'wheat'), flat=True),
    'V18': _civ(1, 1, lambda b: field(b, 'veg'), flat=True),
    'V19': BuildingSpec(1, 1, pumpjack, damage=True, make=False),
    # The husk is already a ruin: no damaged pose of its own.
    'V19.Husk': BuildingSpec(1, 1, lambda b: pumpjack(b, True), damage=False, make=False),
}
