"""Aircraft and ships.

Retexture of 0.21.0: two to five big blocks per unit, the defining feature kept (the helicopters' rotors and booms,
the Chinook's two pylons, the planes' wing shapes, the landing craft's ramp, the submarines' sails, the warships'
turrets), one team area (the tail of an aircraft, a ship's turret or its one team block), and as big as the
original sprite. Aircraft: the engine draws their shadow, so models have none; z 0 is the middle of the fuselage; a
rotor is its own 'second' sprite (rotor(angle, fast) -> Unit around the actor's centre, hub at its z). Ships: hull
on the water line (z 0 is the water), turrets like vehicles around their pivot (rules.json turret_offsets)."""
from core import Unit, dsin, dcos
from specs import AircraftSpec, VehicleSpec


def mirror(half):
    """A closed polygon from the right half outline (x >= 0, listed from the front to the back) and its left mirror."""
    return list(half) + [(-x, y) for x, y in reversed(half)]


def rotor_blades(u, angle, fast, n, r, hub_z, width):
    """n rotor blades through the hub at `angle`: n / 2 beams across it (translucent when spinning fast)."""
    for k in range(n // 2):
        a = angle + k * 360.0 / n
        c, s = dcos(a), dsin(a)
        u.beam((-c * r, -s * r, hub_z), (c * r, s * r, hub_z), width, 'steel' if fast else 'steel2', a=0.55 if fast else 1.0)


# ---- Helicopters -------------------------------------------------------------------------------------------------

HUB_Z = 7.0
ROTOR_R = 15.0


def heli_body():
    # Longbow: the pod, the glass nose, stub wings and the team tail boom up to the mast.
    u = Unit()
    u.box(-4.5, -5, 9, 11, 6, 'olive', -3)
    u.box(-3, 6, 6, 4.5, 4, 'glass', -2.4)
    u.box(-8.5, -1, 17, 3.5, 1.4, 'dark', -1.2)
    u.box(-1.3, -17, 2.6, 12, 3.0, 'T', -1)
    return u


def heli_rotor(angle, fast):
    u = Unit()
    rotor_blades(u, angle, fast, 4, ROTOR_R, HUB_Z, 1.6)
    return u


TRAN_HUB_Z = 8.0
TRAN_ROTOR_R = 11.0


def tran_body():
    # Chinook: the long cabin with its glazed nose and the two pylons, the rear one in the team colour.
    u = Unit()
    u.box(-5, -18, 10, 35, 6, 'olive', -3)
    u.box(-4, 14, 8, 4.5, 2.8, 'glass', -0.6)
    u.box(-2, 11, 4, 4.5, TRAN_HUB_Z - 3, 'steel', 3)
    u.box(-3, -19, 6, 8, TRAN_HUB_Z - 3, 'T', 3)
    return u


def tran_rotor(angle, fast):
    # The engine places this sprite at every rotor offset (+14 and -14 px along the hull), so it holds ONE rotor, hub at its z.
    u = Unit()
    rotor_blades(u, angle, fast, 2, TRAN_ROTOR_R, TRAN_HUB_Z, 1.6)
    return u


HIND_HUB_Z = 6.5
HIND_ROTOR_R = 16.0


def hind_body():
    # Hind: the pointed fuselage, the glazed cockpits, the stub wings with rocket pods and the team tail boom.
    u = Unit()
    u.prism(mirror([(0, 16), (3.5, 11), (4.5, 2), (4, -9)]), 8, 'olive', -4)
    u.box(-2.5, 4, 5, 9, 2.8, 'glass', 4.0)
    u.box(-9, -2, 18, 4, 2.4, 'dark', -1.4)
    u.box(-1.2, -18, 2.4, 11, 3, 'T', -0.8)
    return u


def hind_rotor(angle, fast):
    u = Unit()
    rotor_blades(u, angle, fast, 4, HIND_ROTOR_R, HIND_HUB_Z, 1.6)
    return u


MH60_HUB_Z = 6.5
MH60_ROTOR_R = 15.5


def mh60_body():
    # Black Hawk: the cabin with its windscreen, the engine block on the roof and the team tail boom with its fin.
    u = Unit()
    u.box(-4.5, -8, 9, 18, 8, 'dark', -4)
    u.box(-3.5, 6, 7, 4.2, 2.6, 'glass', 1.0)
    u.box(-3, -6, 6, 8, 3.4, 'steel2', 4.0)
    u.box(-1.2, -18, 2.4, 10, 5.0, 'T', -1.2)
    return u


def mh60_rotor(angle, fast):
    u = Unit()
    rotor_blades(u, angle, fast, 4, MH60_ROTOR_R, MH60_HUB_Z, 1.6)
    return u


# ---- Planes ------------------------------------------------------------------------------------------------------


def yak_body():
    # Yak: the propeller fighter: fuselage, straight wings, canopy, the team tail.
    u = Unit()
    u.box(-2.4, -12, 4.8, 25, 4.4, 'olive', -2.2)
    u.prism(mirror([(0, 5), (13, 4), (13, 0), (0, -1)]), 1.0, 'olive', -0.6)
    u.box(-1.6, 1, 3.2, 4.5, 2.4, 'glass', 2.2)
    u.box(-0.7, -12, 1.4, 5, 6.5, 'T', 2.2)
    return u


def mig_body():
    # MiG: the delta wing, the fuselage with its canopy and the team fin.
    u = Unit()
    u.prism(mirror([(0, 14), (2.2, 6), (15, -10), (15, -12), (0, -12)]), 1.2, 'steel2', -0.6)
    u.box(-2, -14, 4, 28, 3.0, 'steel', -1.4)
    u.box(-1.4, 4, 2.8, 4.5, 1.6, 'glass', 1.6)
    u.box(-0.6, -14, 1.2, 6, 6, 'T', 1.6)
    return u


def u2_body():
    # The spy plane: a slim fuselage, very long straight wings and the team fin.
    u = Unit()
    u.box(-1.6, -14, 3.2, 28, 2.8, 'darker', -1.4)
    u.prism(mirror([(0, 2), (24, 1), (24, -1.5), (0, -2)]), 0.8, 'dark', -0.4)
    u.box(-0.5, -14, 1, 4.5, 5, 'T', 1.4)
    return u


def badr_body():
    # The Badger: the long fuselage, swept wings with the engines as one block, the team tail.
    u = Unit()
    u.box(-2.6, -20, 5.2, 40, 4.4, 'steel2', -2.2)
    u.prism(mirror([(0, 6), (22, -6), (22, -9), (0, -4)]), 1.2, 'steel2', -0.6)
    u.box(-7, -3, 14, 8, 3.2, 'steel', -2.2)
    u.prism(mirror([(0, -14), (7, -19), (7, -21), (0, -20)]), 5, 'T', 0.4)
    return u


# ---- Ships -------------------------------------------------------------------------------------------------------

PT_OUT = [(-5.5, -15), (5.5, -15), (6, 2), (3.6, 11), (0, 16), (-3.6, 11), (-6, 2)]


def pt_body():
    # The gunboat: hull and cabin; the team gun sits 12 px ahead (rules.json 512/1024 cell).
    u = Unit()
    u.prism(PT_OUT, 4.0, 'steel2', 0)
    u.box(-4, -12, 8, 10, 4.6, 'wall', 4.0)
    return u


def pt_turret():
    u = Unit()
    u.box(-2.6, -2.6, 5.2, 5.2, 2.6, 'T', 4.0)
    u.tube((0, 1.5, 5.4), (0, 9, 5.4), 0.9, 'dark')
    return u


DD_OUT = [(0, 19), (4, 16), (7, 10), (8, 3), (8, -15), (7, -17), (-7, -17), (-8, -15), (-8, 3), (-7, 10), (-4, 16)]


def dd_body():
    # The destroyer: the long hull, the bridge with the funnel behind it; the team launcher sits 11 px ahead.
    u = Unit()
    u.prism(DD_OUT, 4.6, 'steel2', 0)
    u.box(-4.5, -9, 9, 12, 4.4, 'wall', 4.6)
    u.cyl(0, -13, 2.6, 5.4, 'darker', 4.6)
    return u


def dd_turret():
    u = Unit()
    u.box(-3.6, -3.6, 7.2, 7.2, 2.6, 'T', 4.6)
    u.box(-2.6, -2, 5.2, 8, 1.8, 'paint', 7.2)
    return u


CA_OUT = [(0, 20), (4, 16), (7, 10), (8, 3), (8, -20), (6, -23), (-6, -23), (-8, -20), (-8, 3), (-7, 10), (-4, 16)]


def ca_body():
    # The cruiser: the long hull, the bridge tower and the funnel; the two team gun houses stand at -21 and +18 px.
    u = Unit()
    u.prism(CA_OUT, 5.0, 'steel2', 0)
    u.box(-5.5, -6, 11, 13, 6.0, 'wall', 5.0)
    u.box(-3, -12, 6, 5, 6.0, 'darker', 5.0)
    return u


def ca_turret():
    # One twin gun house, placed twice by the engine, around its pivot, standing on the deck (z 5).
    u = Unit()
    u.box(-4, -4, 8, 8, 3.0, 'T', 5.0)
    u.box(-2.6, 3, 5.2, 7, 1.8, 'dark', 5.8)
    return u


LST_OUT = mirror([(7, 12), (9, 9), (9, -14)])


def lst_body():
    # The landing craft: the hull, the cargo in its well, the team stern house and the lowered bow ramp.
    u = Unit()
    u.prism(LST_OUT, 4.0, 'steel2', 0)
    u.box(-6, -6, 12, 14, 2.6, 'canvas', 4.0)
    u.box(-8, -14, 16, 7, 6.0, 'T', 4.0)
    u.poly([(-7, 17, 1.2), (7, 17, 1.2), (7, 12, 4.0), (-7, 12, 4.0)], 'steel')
    return u


SS_OUT = mirror([(1.5, 18), (4, 14), (5, 8), (5, -11), (3.5, -15), (1.5, -17)])


def ss_body():
    # The submarine: mostly under water: the dark hull top and the team sail.
    u = Unit()
    u.prism(SS_OUT, 2.2, 'dark', -0.2)
    u.box(-2.4, -3, 4.8, 9, 5.2, 'T', 2.0)
    return u


MSUB_OUT = mirror([(2.2, 22), (5.4, 17), (6.8, 10), (6.8, -15), (5, -19), (2.4, -21.5)])


def msub_body():
    # The missile submarine: the wide hull top, the row of launch hatches and the team sail forward of them.
    u = Unit()
    u.prism(MSUB_OUT, 2.4, 'dark', -0.2)
    u.box(-4, -17, 8, 16, 0.8, 'darker', 2.2)
    u.box(-2.8, 4, 5.6, 9.5, 5.4, 'T', 2.2)
    return u


ACTORS = {
    'HELI': AircraftSpec(heli_body, heli_rotor),
    # PT's turret sits 512/1024 cell (12 px) ahead of the centre: the body leaves the mount bare there.
    'PT': VehicleSpec(pt_body, pt_turret, shadow=False, turret_pivot=(0.0, 12.0)),
    'TRAN': AircraftSpec(tran_body, tran_rotor),
    'HIND': AircraftSpec(hind_body, hind_rotor),
    'MH60': AircraftSpec(mh60_body, mh60_rotor),
    'YAK': AircraftSpec(yak_body),
    'MIG': AircraftSpec(mig_body),
    'U2': AircraftSpec(u2_body),
    'BADR': AircraftSpec(badr_body),
    'LST': VehicleSpec(lst_body, shadow=False),
    'SS': VehicleSpec(ss_body, shadow=False),
    'MSUB': VehicleSpec(msub_body, shadow=False),
    # Turret mounts: DD 469/1024 cell = 11 px ahead; CA -896 and 768 /1024 cell = -21 and +18 px (the same turret twice).
    'DD': VehicleSpec(dd_body, dd_turret, shadow=False, turret_pivot=(0.0, 11.0)),
    # Two mounts (-21 and +18 px, rules.json): the game places the same turret on both.
    'CA': VehicleSpec(ca_body, ca_turret, shadow=False, turret_pivot=(0.0, 18.0)),
}
# The Badger bomber of the paradrop and parabomb raids is the same plane.
ALIASES = {'BADR.Bomber': 'BADR'}
