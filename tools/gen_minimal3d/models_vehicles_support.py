"""Support vehicles: ore truck, MCV, supply truck, jeep, APC, Mobile Flak, rocket launcher, artillery, demolition
truck, the husks (burnt wrecks) and the five crates.

Same pattern as models_vehicles.py: pixels, facing north (nose towards +y), centred on the ground. Sizes follow the
vector art (apps/game/js/sprites.js UNIT_DRAW). Turrets (their own sprite around the pivot of rules.json
turret_offsets, z up from the ground): JEEP (machine gun, pivot 0, 0) and FTRK (twin flak gun, pivot 7 px behind the
centre: -298 * 24 / 1024). The others are body only. Husks are the live body, charred (no team colour, no turret),
with translucent smoke blocks on top. Crates are a wooden box with a coloured marking on the lid."""
from core import Unit, resolve, dsin, dcos
from specs import VehicleSpec
from kit import tracks, wheel, barrel

ORE = '#e8a830'
WOOD = '#b0793f'
WOOD_DARK = '#7a4e26'
WOOD_LID = '#c99356'


# ---- Shared parts --------------------------------------------------------------------------------


def lorry(u, bw, y_back, y_cab, y_front, wheel_ys, wx, wr=3.0, ww=3.0):
    """A wheeled truck: chassis, wheels, cab with glazing and hood in the owner's colour, and a bed floor.
    bw: half width of the body, y_cab: where the cab starts. Returns the height of the bed floor."""
    u.box(-bw + 0.6, y_back, 2 * bw - 1.2, y_front - y_back, 2, 'darker', 2)
    for y in wheel_ys:
        for sgn in (-1, 1):
            wheel(u, sgn * wx, y, wr, ww)
    # bed floor
    u.box(-bw, y_back, 2 * bw, y_cab - y_back, 1, 'dark', 4)
    # cab, windscreen, hood, grille, headlights
    cab_f = y_cab + (y_front - y_cab) * 0.5
    u.box(-bw, y_cab, 2 * bw, cab_f - y_cab, 5.5, 'T', 4)
    u.box(-bw + 1, cab_f, 2 * bw - 2, 0.6, 2.4, 'glass', 6.2)
    u.box(-bw + 0.8, cab_f, 2 * bw - 1.6, y_front - cab_f, 3, 'T', 4)
    u.box(-bw + 1.6, y_front, 2 * bw - 3.2, 0.5, 1.8, 'dark', 4.6)
    for sgn in (-1, 1):
        u.box(sgn * (bw - 1.6) - 0.7, y_front, 1.4, 0.6, 1.0, 'yellow', 5.4)
    return 5.0


def bed_walls(u, bw, y_back, y_cab, h, z, c='T'):
    u.box(-bw, y_back, 1, y_cab - y_back, h, c, z)
    u.box(bw - 1, y_back, 1, y_cab - y_back, h, c, z)
    u.box(-bw + 1, y_back, 2 * bw - 2, 1, h, c, z)
    u.box(-bw + 1, y_cab - 1, 2 * bw - 2, 1, h * 1.2, c, z)


def charred(u, keep=(), smoke=None):
    """Turn a live unit into a burnt wreck: dark brown-black plating, no team colour, ore dimmed."""
    keep_rgb = [resolve(k) for k in keep]
    for f in u.faces:
        c = f.color
        if c in keep_rgb:
            f.color = (int(c[0] * 0.62), int(c[1] * 0.6), int(c[2] * 0.5))
        elif c == 'T':
            f.color = (74, 66, 58)
        else:
            lum = (c[0] + c[1] + c[2]) / 3.0
            v = 0.2 + lum / 255.0 * 0.28
            f.color = (int(52 * v / 0.3 + 8), int(46 * v / 0.3 + 6), int(42 * v / 0.3 + 5))
    if smoke:
        for (x, y, z, s, a) in smoke:
            u.box(x - s / 2, y - s / 2, s, s, s * 0.9, '#8d8a86', z, a)
    return u


def wreck_bits(u, pieces):
    """Torn plating and scorched patches: pieces are (x, y, w, d, h, z) of rusty or black boxes."""
    for i, (x, y, w, d, h, z) in enumerate(pieces):
        u.box(x, y, w, d, h, '#5a4636' if i % 2 else '#2a2622', z)


def trefoil(u, cx, cy, z, r, c='black'):
    """A radiation trefoil decal on a roof: three 60 degree wedges around a hub."""
    for k in range(3):
        a0 = 90 + 120 * k - 30
        pts = [(cx, cy)]
        for i in range(5):
            a = a0 + 60 * i / 4
            pts.append((cx + r * dcos(a), cy - r * dsin(a) * 0.999))
        u.flat(pts, z, c)
    u.flat([(cx - r * 0.3, cy - r * 0.3), (cx + r * 0.3, cy - r * 0.3), (cx + r * 0.3, cy + r * 0.3), (cx - r * 0.3, cy + r * 0.3)], z + 0.02, 'yellow')


# ---- HARV: the ore truck -------------------------------------------------------------------------


def harv_body(ore=True, hopper_ore=ORE):
    u = Unit()
    tracks(u, 7, 12, -12, 11.5, 5)
    u.box(-7, -13, 14, 26, 2.5, 'dark', 3)  # chassis
    # cab at the front
    u.box(-6, 5, 12, 8, 5, 'T', 5.5)
    u.box(-5, 13, 10, 0.6, 2.4, 'glass', 7.8)
    u.box(-6.4, 4.6, 12.8, 8.4, 1, 'T', 10.5)  # roof
    u.box(3.6, 6, 1.4, 1.4, 4, 'steel', 10.5)  # exhaust stack
    # ore hopper: open bin, steel walls and a team coloured rear plate
    z0 = 5.5
    u.box(-6.5, 3, 13, 1, 5, 'steel', z0)
    u.box(-6.5, -13, 1, 16, 5, 'steel', z0)
    u.box(5.5, -13, 1, 16, 5, 'steel', z0)
    u.box(-6.5, -13.6, 13, 1.6, 5.5, 'T', z0)
    u.box(-5.5, -12, 11, 15, 3, '#7a6428', z0)  # dark floor of ore
    if ore:
        u.box(-5.5, -12, 11, 15, 1.6, hopper_ore, z0 + 3)
        u.vdome(0, -4.5, 5.2, 3.4, hopper_ore, z0 + 4.2)
    return u


def harv_empty_husk():
    u = harv_body(ore=False)
    charred(u, smoke=[(-1, -4, 11, 5, 0.5), (1.5, -1, 14.5, 4, 0.4), (0, 1.5, 17.5, 3, 0.3)])
    wreck_bits(u, [(-5, -11, 4, 3, 1.4, 8), (1, -6, 3, 2, 1.0, 8), (-3, 6, 5, 3, 1.0, 11.5)])
    return u


def harv_full_husk():
    u = harv_body(ore=True)
    charred(u, keep=(ORE,), smoke=[(0, -4, 12.5, 5, 0.5), (-2, -1, 15.5, 4, 0.4), (1, 2, 18.5, 3, 0.3)])
    wreck_bits(u, [(-6, -12, 3, 2, 1.0, 8), (3, 4, 3, 2, 1.0, 11.5)])
    return u


# ---- MCV -----------------------------------------------------------------------------------------


def mcv_body():
    u = Unit()
    for y in (13, 5, -4, -10):
        for sgn in (-1, 1):
            wheel(u, sgn * 12.5, y, 4, 5)
    u.box(-11, -17, 22, 34, 2.5, 'darker', 2.5)  # chassis
    # cab at the front
    u.box(-10.5, 8.5, 21, 8.5, 6, 'T', 5)
    u.box(-9, 17, 18, 0.7, 3, 'glass', 7.6)
    u.box(-10.8, 8.5, 21.6, 7.5, 1.2, 'T', 11)
    u.box(-9, 17, 18, 1, 1.5, 'dark', 5.6)  # bumper
    # bed deck
    u.box(-10.5, -17, 21, 25.5, 2.4, 'T', 5)
    u.box(-10.5, -17.5, 21, 1, 3, 'dark', 5)
    # folded crane: turntable at the rear, lattice boom laid forward, hook at the nose
    u.cyl(0, -9.5, 5.6, 2.2, 'orange', 7.4)
    u.cyl(0, -9.5, 4.2, 1, 'yellow', 9.6)
    u.box(-2.4, -9, 4.8, 18, 3.4, 'yellow', 10.6)
    for i in range(6):
        u.box(-2.7, -7 + i * 3, 5.4, 1.2, 0.8, 'copper', 14)
    u.box(-0.8, 9, 1.6, 2.4, 2.4, 'dark', 11)  # hook
    u.box(-4, -16, 8, 3, 3, 'dark', 7.4)  # counterweight
    return u


def mcv_husk():
    u = mcv_body()
    charred(u, smoke=[(0, -8, 16, 6, 0.5), (-2, -2, 20, 5, 0.4), (1, 4, 23, 4, 0.3)])
    wreck_bits(u, [(-8, -14, 5, 3, 1.4, 7.4), (2, -3, 4, 3, 1.0, 14), (-5, 10, 6, 4, 1.2, 12.2)])
    return u


# ---- TRUK: the supply truck ----------------------------------------------------------------------


def truk_body():
    u = Unit()
    lorry(u, 6.5, -13, 3, 13, (10, 2, -6), 8)
    bed_walls(u, 6.5, -13, 3, 2, 5, 'T')
    # cargo: three rows of wooden crates
    for i in range(3):
        u.box(-5.2, -11.8 + i * 4.8, 4.6, 4.2, 3.6, WOOD, 5)
        u.box(0.7, -11.8 + i * 4.8, 4.6, 4.2, 3.6, WOOD_LID if i % 2 else WOOD, 5)
    u.box(-5.2, -11.8, 10.5, 1, 4.4, 'steel2', 5)  # a strap
    return u


# ---- JEEP ----------------------------------------------------------------------------------------


def jeep_body():
    u = Unit()
    for y in (6.5, -6.5):
        for sgn in (-1, 1):
            wheel(u, sgn * 7.4, y, 3, 3)
    u.box(-5.5, -9.5, 11, 19, 2.2, 'darker', 2)  # frame
    u.box(-5.5, -9.5, 11, 19, 2.6, 'T', 3.5)  # tub
    u.box(-5.4, 3, 10.8, 6.5, 1.4, 'T', 6.1)  # hood
    u.box(-5, 2, 10, 0.9, 3, 'glass', 6.1)  # windscreen
    u.box(-4.4, -6, 3.4, 3.4, 2.2, 'dark', 6.1)  # seats
    u.box(1, -6, 3.4, 3.4, 2.2, 'dark', 6.1)
    u.box(-5.4, -10, 10.8, 0.7, 2.4, 'dark', 5.2)  # tailgate
    for sgn in (-1, 1):
        u.box(sgn * 3.6 - 0.8, 9.5, 1.6, 0.6, 1.2, 'yellow', 4.6)
        u.box(sgn * 5.5 - 0.3, 3, 0.6, 0.6, 1.0, 'darker', 7.5)  # mirrors
    return u


def jeep_turret():
    u = Unit()
    u.box(-0.7, -3.4, 1.4, 1.4, 3, 'dark', 6)  # pedestal
    u.box(-1.9, -7.2, 3.8, 2.6, 3.4, 'camo', 6.1)  # gunner
    u.cyl(0, -6, 1.5, 1.4, 'skin', 9.5)
    u.cyl(0, -6, 1.8, 1, 'camo', 10.3)
    u.box(-2.4, -1.8, 4.8, 0.8, 2.6, 'T', 7.2)  # gun shield
    barrel(u, 0, -3, 6.5, 9.2, r=0.8)
    return u


# ---- APC -----------------------------------------------------------------------------------------


def apc_body():
    u = Unit()
    tracks(u, 5.5, 10.5, -11.5, 11, 5)
    u.box(-5.5, -12, 11, 20, 3.8, 'T', 3.2)  # hull
    u.box(-5.5, 8, 11, 4.5, 2, 'T', 3.2)  # nose
    u.poly([(-5.5, 8, 7), (5.5, 8, 7), (5.5, 12.5, 5.2), (-5.5, 12.5, 5.2)], 'T')  # sloped glacis
    u.poly([(-5.5, 8, 7), (-5.5, 12.5, 5.2), (-5.5, 8, 5.2)], 'T')
    u.poly([(5.5, 8, 7), (5.5, 12.5, 5.2), (5.5, 8, 5.2)], 'T')
    u.box(-4.5, -9, 9, 9, 1.8, 'T', 7)  # troop compartment roof
    u.box(-3.8, -12.4, 7.6, 0.5, 3.2, 'dark', 3.6)  # rear door
    u.box(1.2, -5, 3, 3, 0.8, 'darker', 8.8)  # hatch
    u.box(-1, 5, 2, 2, 1.6, 'dark', 7)  # bow MG mount
    barrel(u, 0, 6, 13.5, 8.2, r=0.8)
    u.box(-3.6, 0.5, 7.2, 4, 0.6, 'dark', 7)  # engine grille
    return u


# ---- FTRK: the Mobile Flak -----------------------------------------------------------------------

FLAK_PIVOT = -298 * 24 / 1024  # -7 px behind the centre


def ftrk_body():
    u = Unit()
    for y in (7.6, -3.4, -8.0):
        for sgn in (-1, 1):
            wheel(u, sgn * 5.4, y, 2.5, 2.2)
    u.box(-3.6, -12, 7.2, 24, 2, 'darker', 2)
    u.box(-4.8, 4.2, 9.6, 5.4, 6, 'T', 4)  # cab
    u.box(-3.9, 9.6, 7.8, 0.6, 2.4, 'glass', 6.8)
    u.box(-4.2, 9.6, 8.4, 2.8, 3, 'T', 4)  # hood
    u.box(-3, 12.4, 6, 0.5, 1.8, 'dark', 4.6)
    for sgn in (-1, 1):
        u.box(sgn * 3.1 - 0.6, 12.4, 1.2, 0.6, 0.9, 'yellow', 5.4)
    u.box(-4.8, -12.4, 9.6, 16.2, 1, 'dark', 4)  # bed floor
    bed_walls(u, 4.8, -12.4, 3.8, 1.8, 5, 'T')
    u.cyl(0, FLAK_PIVOT, 3.2, 0.8, 'steel', 5)  # turntable ring
    return u


def ftrk_turret():
    u = Unit()
    u.cyl(0, 0, 2.6, 1.4, 'steel', 5.8)  # base
    u.box(-2.8, -2.2, 5.6, 5, 2.4, 'T', 7.2)  # cradle
    u.box(-3.9, -1.6, 1.3, 3, 1.8, 'camo', 7.2)  # ammo boxes
    u.box(2.6, -1.6, 1.3, 3, 1.8, 'camo', 7.2)
    for sgn in (-1, 1):
        barrel(u, sgn * 1.0, 1, 9.5, 8.8, r=0.55, pitch=2.2)
    u.box(-1.5, -4.4, 3, 2.2, 2.6, 'camo', 7.2)  # gunner
    u.cyl(0, -4.2, 1.2, 1, 'camo', 9.6)
    return u


# ---- V2RL: the rocket launcher -------------------------------------------------------------------


def v2rl_body():
    u = Unit()
    lorry(u, 7, -14, 3, 14, (11, 1, -6), 9)
    bed_walls(u, 7, -14, 3, 1.4, 5, 'T')
    u.box(-1.5, -13.5, 3, 18, 1.6, 'steel', 5)  # launch rail
    u.box(-3, -13, 6, 2, 1.2, 'dark', 5)  # cradle at the rear
    u.box(-3, -2, 6, 1.6, 1.2, 'dark', 5)
    # the V2 rocket on the rail: white body, red nose, dark fins
    u.tube((0, -12, 8.8), (0, 5.5, 8.8), 1.8, 'paint')
    u.tube((0, 5.5, 8.8), (0, 8.5, 8.8), 1.8, 'red')
    u.tube((0, 8.5, 8.8), (0, 10.5, 8.8), 0.9, 'red')
    u.box(-4, -12, 8, 1.8, 0.7, 'dark', 8.5)
    u.box(-0.35, -12, 0.7, 1.8, 7, 'dark', 5.8)
    u.box(-0.6, -12.2, 1.2, 0.8, 0.4, 'darker', 8.2)
    return u


# ---- ARTY: the artillery -------------------------------------------------------------------------


def arty_body():
    u = Unit()
    tracks(u, 5.5, 10.5, -12, 6, 5)
    u.box(-6, -11, 12, 15, 3, 'T', 3)  # hull
    u.box(-4, -12, 8, 2, 2.4, 'T', 3)  # rear ammo bin
    u.box(-3.5, -14, 7, 2.6, 2.6, 'dark', 0)  # recoil spade
    u.box(-5.5, -3.5, 11, 7.5, 3, 'dark', 6)  # mount
    u.box(-4.6, -2, 9, 5.5, 3.6, 'T', 6.4)  # gun shield
    u.cyl(0, 0, 3, 1.6, 'dark', 10)
    barrel(u, 0, 2, 14.5, 9, r=1.4, pitch=2.5)
    u.box(-4.6, 3.4, 9, 0.8, 2, 'T', 6.4)
    return u


# ---- DTRK: the demolition truck ------------------------------------------------------------------


def dtrk_body():
    u = Unit()
    lorry(u, 6, -12, 3, 12, (9, 2, -5), 7.5)
    bed_walls(u, 6, -12, 3, 1.2, 5, 'dark')
    # the bomb casing: yellow, hazard stripes at the rear, a black trefoil on the lid
    u.box(-4.8, -10.5, 9.6, 12.5, 4, 'yellow', 5)
    for i in range(3):
        u.box(-4.9, -10.5 + i * 4.4, 9.8, 1.2, 4.1, 'black', 5)
    u.box(-1, -12.5, 2, 2, 2, 'red', 5)  # fuse
    trefoil(u, 0, -4.3, 9.05, 3)
    return u


# ---- Crates --------------------------------------------------------------------------------------


GLYPH_W = ['10001', '10001', '10101', '10101', '01010']
GLYPH_S = ['01111', '10000', '01110', '00001', '11110']


def _glyph(u, rows, cx, cy, z, cell, c):
    n = len(rows)
    x0 = cx - 2.5 * cell
    y0 = cy - n * cell / 2
    for r, row in enumerate(rows):
        for k, ch in enumerate(row):
            if ch == '1':
                x, y = x0 + k * cell, y0 + r * cell
                u.flat([(x, y), (x + cell, y), (x + cell, y + cell), (x, y + cell)], z, c)


def _box_crate():
    u = Unit()
    u.box(-4.5, -4.5, 9, 9, 6, WOOD)
    for x in (-3, 1.7):
        u.box(x, -4.7, 1.3, 9.4, 6.1, WOOD_DARK)  # straps
    u.box(-5, -5, 10, 10, 1.2, WOOD_LID, 6)  # lid
    return u


LID_Z = 7.2


def _plate(u, c, r=4.2):
    u.flat([(-r, -r), (r, -r), (r, r), (-r, r)], LID_Z + 0.02, c)


def crate_plain():
    u = _box_crate()
    _plate(u, '#3d8a4a')
    u.flat([(0, -3), (3, 0), (0, 3), (-3, 0)], LID_Z + 0.04, 'paint')
    u.flat([(0, -1.4), (1.4, 0), (0, 1.4), (-1.4, 0)], LID_Z + 0.06, '#3d8a4a')
    return u


def crate_money():
    u = _box_crate()
    u.cyl(0, 0, 4, 0.1, 'orange', 7.3, top=True)
    u.cyl(0, 0, 3, 0.1, 'gold', 7.45)
    u.cyl(0, 0, 1.6, 0.1, 'orange', 7.6)
    u.cyl(0, 0, 0.7, 0.1, 'gold', 7.75)
    return u


def crate_heal():
    u = _box_crate()
    _plate(u, 'paint')
    u.flat([(-3.4, -1.1), (3.4, -1.1), (3.4, 1.1), (-3.4, 1.1)], LID_Z + 0.04, 'red')
    u.flat([(-1.1, -3.4), (1.1, -3.4), (1.1, 3.4), (-1.1, 3.4)], LID_Z + 0.04, 'red')
    return u


def crate_w():
    u = _box_crate()
    _plate(u, '#2b5aa0')
    _glyph(u, GLYPH_W, 0, 0, LID_Z + 0.04, 1.4, 'paint')
    return u


def crate_s():
    u = _box_crate()
    _plate(u, '#2e3238')
    _glyph(u, GLYPH_S, 0, 0, LID_Z + 0.04, 1.4, 'yellow')
    return u


ACTORS = {
    'HARV': VehicleSpec(harv_body),
    'MCV': VehicleSpec(mcv_body),
    'TRUK': VehicleSpec(truk_body),
    'JEEP': VehicleSpec(jeep_body, jeep_turret),
    'APC': VehicleSpec(apc_body),
    'FTRK': VehicleSpec(ftrk_body, ftrk_turret, turret_pivot=(0.0, FLAK_PIVOT)),
    'V2RL': VehicleSpec(v2rl_body),
    'ARTY': VehicleSpec(arty_body),
    'DTRK': VehicleSpec(dtrk_body),
    'MCV.Husk': VehicleSpec(mcv_husk),
    'HARV.EmptyHusk': VehicleSpec(harv_empty_husk),
    'HARV.FullHusk': VehicleSpec(harv_full_husk),
    'CRATE': VehicleSpec(crate_plain, facings=1, shadow=True),
    'MONEYCRATE': VehicleSpec(crate_money, facings=1, shadow=True),
    'HEALCRATE': VehicleSpec(crate_heal, facings=1, shadow=True),
    'WCRATE': VehicleSpec(crate_w, facings=1, shadow=True),
    'SCRATE': VehicleSpec(crate_s, facings=1, shadow=True),
}
