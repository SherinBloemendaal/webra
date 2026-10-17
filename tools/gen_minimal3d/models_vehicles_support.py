"""Support vehicles: ore truck, MCV, supply truck, jeep, APC, Mobile Flak, rocket launcher, artillery, demolition
truck, their husks (burnt wrecks) and the five crates.

Retexture of 0.21.0, the same pattern as models_vehicles.py: two to five big blocks, the team colour on the turret
or the cargo bed, the defining feature kept (the harvester's scoop and ore, the MCV's packed yard and crane, the
truck's cargo, the rocket on its rail, the long gun, the demolition truck's bomb), as big as the original sprite.
Wheels and tracks are one dark running-gear slab. Pixels, facing north (nose towards +y), centred on the ground.
Turrets (their own sprite around the pivot of rules.json turret_offsets, z up from the ground): JEEP (machine gun,
pivot 0, 0) and FTRK (flak gun, pivot 7 px behind the centre: -298 * 24 / 1024). Husks are the body, charred, with no
team colour. Crates are a wooden box with a coloured lid."""
from core import Unit
from specs import VehicleSpec
from models_vehicles import CHAR, CHAR2, chassis

WOOD = '#b0793f'
WOOD_LID = '#c99356'


def wheels(u, length, width, h=3.0):
    """The running gear of a wheeled vehicle: one dark slab."""
    u.box(-width / 2, -length / 2, width, length, h, 'darker')
    return h


# ---- Harvester -----------------------------------------------------------------------------------


def harv_body(ore='gold', hull='T', gear='darker', scoop='steel'):
    # Tracks, the team ore bed heaped with ore, and the wide scoop in front.
    u = Unit()
    u.box(-11.5, -15, 23, 27, 4.0, gear)
    u.box(-10, -14, 20, 24, 11.0, hull, 4.0)
    if ore:
        u.box(-7.5, -11, 15, 14, 4.0, ore, 15.0)
    u.box(-12, 11, 24, 6, 6.0, scoop, 1.0)
    return u


def harv_empty_husk():
    return harv_body(None, CHAR, CHAR2, CHAR2)


def harv_full_husk():
    return harv_body('#8a6a2a', CHAR, CHAR2, CHAR2)


# ---- MCV -----------------------------------------------------------------------------------------


def mcv_body(hull='steel2', pack='T', crane='yellow', gear='darker'):
    # Tracks, the hull, the packed team yard on its back and the folded crane over the cab.
    u = Unit()
    z = 4.0
    u.box(-12.5, -16, 25, 32, z, gear)
    u.box(-11, -15, 22, 30, 4.0, hull, z)
    u.box(-9, -13, 18, 16, 9.0, pack, z + 4.0)
    u.box(-2, 1, 4, 13, 4.0, crane, z + 4.0)
    return u


def mcv_husk():
    return mcv_body(CHAR, CHAR2, CHAR2, CHAR2)


# ---- Trucks --------------------------------------------------------------------------------------


def truk_body():
    # Running gear, the cab, and the team cargo bed with its load.
    u = Unit()
    z = wheels(u, 20, 13)
    u.box(-6, 4, 12, 6, 6.0, 'steel2', z)
    u.box(-6.5, -10, 13, 13.5, 3.0, 'T', z)
    u.box(-5, -8.5, 10, 10, 3.0, WOOD, z + 3.0)
    return u


def dtrk_body():
    # Running gear, the cab, and the team bed carrying the big bomb.
    u = Unit()
    z = wheels(u, 20, 13)
    u.box(-6, 4, 12, 6, 6.0, 'steel2', z)
    u.box(-6.5, -10, 13, 13.5, 2.0, 'T', z)
    u.tube((0, -8.5, z + 5.0), (0, 2.0, z + 5.0), 3.6, 'darker')
    return u


# ---- Jeep and APC --------------------------------------------------------------------------------


def jeep_body():
    # Running gear and the open body with its windscreen.
    u = Unit()
    z = wheels(u, 18, 13, 3.2)
    u.box(-5.5, -8, 11, 16, 3.2, 'olive', z)
    u.box(-5.5, 3, 11, 1.2, 3.0, 'glass', z + 3.2)
    return u


def jeep_turret():
    # The machine gun on its team mount.
    u = Unit()
    u.box(-3, -3, 6, 6, 2.4, 'T', 6.4)
    u.tube((0, 1, 8.0), (0, 9, 8.0), 0.9, 'dark')
    return u


def apc_body():
    # Tracks, the boxy hull, and the team troop roof with a sloped nose.
    u = Unit()
    z = chassis(u, 20, 15, hull='olive')
    u.box(-5.5, -8, 11, 12, 3.0, 'T', z)
    return u


# ---- Flak, rockets, artillery --------------------------------------------------------------------

FLAK_PIVOT = -298 * 24 / 1024  # -7 px behind the centre


def ftrk_body():
    # Running gear and the truck body with its cab in front of the gun mount.
    u = Unit()
    z = wheels(u, 22, 14)
    u.box(-6, -11, 12, 22, 3.0, 'olive', z)
    u.box(-5.5, 4, 11, 6, 4.0, 'steel2', z + 3.0)
    return u


def ftrk_turret():
    # The team flak mount and its twin barrels as one block, raised.
    u = Unit()
    u.box(-4.5, -4.5, 9, 9, 3.0, 'T', 6.0)
    u.beam((0, 2, 8.5), (0, 11, 13.5), 4.0, 'dark')
    return u


def v2rl_body():
    # Running gear, the cab, and the rocket on its team launch rail, raised.
    u = Unit()
    z = wheels(u, 23, 14)
    u.box(-6, 4.5, 12, 7, 6.0, 'steel2', z)
    u.box(-6.5, -11.5, 13, 16, 2.4, 'T', z)
    u.tube((0, -10, z + 3.5), (0, 3, z + 7.5), 2.4, 'paint')
    return u


def arty_body():
    # Tracks, the hull with its team gun shield, and the long gun.
    u = Unit()
    z = chassis(u, 18, 13, hull='olive')
    u.box(-4.5, -5, 9, 7, 3.0, 'T', z)
    u.tube((0, 1, z + 1.8), (0, 12, z + 3.0), 1.1, 'dark')
    return u


# ---- Crates --------------------------------------------------------------------------------------


def _crate(lid, mark=None):
    """A wooden crate with a coloured lid and, on it, a marking (3 shapes)."""
    u = Unit()
    u.box(-8, -8, 16, 16, 10, WOOD)
    u.box(-8.5, -8.5, 17, 17, 1.4, lid, 10)
    if mark:
        mark(u, 11.41)
    return u


def crate_plain():
    return _crate('#3d8a4a', lambda u, z: u.flat([(0, -4), (4, 0), (0, 4), (-4, 0)], z, 'paint'))


def crate_money():
    return _crate('orange', lambda u, z: u.cyl(0, 0, 4.0, 0.6, 'gold', z))


def crate_heal():
    def cross(u, z):
        u.box(-4.5, -1.5, 9, 3, 0.3, 'red', z)
        u.box(-1.5, -4.5, 3, 9, 0.3, 'red', z)
    return _crate('paint', cross)


def crate_w():
    return _crate('#2b5aa0', lambda u, z: u.box(-4.5, -1.5, 9, 3, 0.3, 'paint', z))


def crate_s():
    return _crate('#2e3238', lambda u, z: u.flat([(0, -4.5), (4.5, 0), (0, 4.5), (-4.5, 0)], z, 'yellow'))


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
