"""Vehicles: tanks, special tanks, the jammer, the gap generator, the minelayer and their husks.

Retexture of 0.21.0: two to four big blocks per unit (tracks, hull, turret, barrel), the team colour on the turret
(or on the one cargo or equipment block of a unit without one), and as big as the original sprite (the test
apps/game/tests/minimal3d-size.test.mjs). Units are drawn in pixels facing north (nose towards +y), centred on the
ground (core.Unit). A turret is its own sprite around its pivot (turret_offsets of engine/rules.json: every tank here
has [0, 0]); its model uses ground-relative z, so it floats at the height of the hull."""
from core import Unit
from specs import VehicleSpec

CHAR = '#3b3835'
CHAR2 = '#2a2724'


def chassis(u, length, width, track_h=3.0, hull_h=3.0, hull='steel2', inset=1.6):
    """Tracks as one dark slab and the hull on it, a little narrower and shorter (2 shapes). Returns the deck z."""
    u.box(-width / 2, -length / 2, width, length, track_h, 'darker')
    u.box(-width / 2 + inset, -length / 2 + 1, width - 2 * inset, length - 2, hull_h, hull, track_h)
    return track_h + hull_h


def gun_turret(z, size, length, r=1.1, h=3.6, twin=0.0):
    """A team turret block of `size` px and a barrel reaching `length` px ahead; with `twin` (px between the two
    barrels) the pair is one flat block, as wide as both barrels."""
    u = Unit()
    u.box(-size / 2, -size / 2 - 1, size, size, h, 'T', z)
    if twin:
        u.box(-twin / 2 - r, size / 2 - 1, twin + 2 * r, length - size / 2 + 1, 2 * r, 'dark', z + h / 2 - r)
    else:
        u.tube((0, size / 2 - 1, z + h / 2), (0, length, z + h / 2), r, 'dark')
    return u


# ---- Tanks ---------------------------------------------------------------------------------------


def tnk1_body():
    u = Unit()
    chassis(u, 19, 15)
    return u


def tnk1_turret():
    return gun_turret(6.0, 8, 12)


def tnk2_body():
    u = Unit()
    chassis(u, 22, 17)
    return u


def tnk2_turret():
    return gun_turret(6.0, 9.5, 14, r=1.25)


def tnk3_body():
    u = Unit()
    chassis(u, 22, 18, hull='olive')
    return u


def tnk3_turret():
    return gun_turret(6.0, 10.5, 14, r=1.0, twin=4.4)


def tnk4_body():
    # The Mammoth: a broad chassis with the missile pods (its tusks) on both flanks.
    u = Unit()
    z = chassis(u, 32, 26, track_h=4.0, hull_h=4.0, hull='olive', inset=4.4)
    u.box(-12.2, -6, 24.4, 13, 3.0, 'dark', z - 1.0)
    return u


def tnk4_turret():
    return gun_turret(8.0, 14, 20, r=1.4, h=4.6, twin=6.0)


def ttnk_body():
    u = Unit()
    chassis(u, 23, 18, hull='dark')
    return u


def ttnk_turret():
    # The tesla turret: a team housing with the glowing coil standing on it.
    u = Unit()
    u.box(-5.5, -5.5, 11, 11, 3.4, 'T', 6.0)
    u.cyl(0, 0, 2.6, 5.0, 'copper', 9.4)
    u.cyl(0, 0, 2.2, 2.0, 'ice', 14.4, emit=True)
    return u


def ctnk_body():
    # The chrono tank: the chassis, the team chrono core and the missile pods on its flanks.
    u = Unit()
    z = chassis(u, 24, 18, hull='steel')
    u.cyl(0, -1.5, 4.4, 5.2, 'T', z)
    for sx in (-1, 1):
        u.box(sx * 6.5 - 2, -7, 4, 10, 3.0, 'dark', z)
    return u


def stnk_body():
    u = Unit()
    chassis(u, 19, 14, hull='steel')
    return u


def stnk_turret():
    # The phase transport's rocket housing in the team colour with its launch tube.
    u = Unit()
    u.box(-4, -5, 8, 9, 3.4, 'T', 6.0)
    u.tube((0, -3, 9.4 + 1.2), (0, 8, 9.4 + 1.2), 1.4, 'steel2')
    return u


def qtnk_body():
    # The MAD tank: a broad chassis carrying the big team drum of the seismic hammer.
    u = Unit()
    z = chassis(u, 32, 26, track_h=4.0, hull_h=4.0, hull='olive', inset=3.0)
    u.cyl(0, -3, 9.0, 7.5, 'T', z)
    u.cyl(0, -3, 3.6, 3.6, 'steel2', z + 7.5)
    return u


def mrj_body():
    # The radar jammer: the chassis, a team equipment box and its big dish.
    u = Unit()
    z = chassis(u, 20, 15, hull='steel')
    u.box(-4.5, -9, 9, 7, 3.2, 'T', z)
    u.cyl(0, 2.5, 5.0, 1.6, 'dome', z + 0.8)
    return u


def mgg_body():
    # The mobile gap generator: the chassis, a team equipment box and the dark emitter orb on its pedestal.
    u = Unit()
    z = chassis(u, 20, 15, hull='steel')
    u.box(-4.5, -9, 9, 8, 3.2, 'T', z)
    u.vdome(0, 3, 4.2, 6.5, '#5a5680', z)
    return u


def mnly_body():
    # The minelayer: the chassis and the team mine bin on its back.
    u = Unit()
    z = chassis(u, 19, 14, hull='olive')
    u.box(-5, -8, 10, 9, 3.4, 'T', z)
    u.box(-3.5, -6.5, 7, 5, 1.0, 'darker', z + 3.4)
    return u


# ---- Husks: the burnt chassis and an empty turret ring, no team colour --------------------------------


def _husk(length, width, ring, track_h=3.0, hull_h=3.0, inset=1.6):
    u = Unit()
    u.box(-width / 2, -length / 2, width, length, track_h, CHAR2)
    u.box(-width / 2 + inset, -length / 2 + 1, width - 2 * inset, length - 2, hull_h + 1.5, CHAR, track_h)
    u.cyl(0, 0, ring, 3.0, 'black', track_h + hull_h + 1.5)
    return u


def husk_2tnk():
    return _husk(22, 17, 4.5)


def husk_3tnk():
    return _husk(22, 18, 5.0)


def husk_4tnk():
    return _husk(32, 26, 7.0, track_h=4.0, hull_h=4.0, inset=4.4)


def husk_mgg():
    return _husk(20, 15, 3.5)


ACTORS = {
    '1TNK': VehicleSpec(tnk1_body, tnk1_turret),
    '2TNK': VehicleSpec(tnk2_body, tnk2_turret),
    '3TNK': VehicleSpec(tnk3_body, tnk3_turret),
    '4TNK': VehicleSpec(tnk4_body, tnk4_turret),
    'TTNK': VehicleSpec(ttnk_body, ttnk_turret),
    'CTNK': VehicleSpec(ctnk_body),
    'STNK': VehicleSpec(stnk_body, stnk_turret),
    'QTNK': VehicleSpec(qtnk_body),
    'MRJ': VehicleSpec(mrj_body),
    'MGG': VehicleSpec(mgg_body),
    'MNLY': VehicleSpec(mnly_body),
    '2TNK.Husk': VehicleSpec(husk_2tnk),
    '3TNK.Husk': VehicleSpec(husk_3tnk),
    '4TNK.Husk': VehicleSpec(husk_4tnk),
    'MGG.Husk': VehicleSpec(husk_mgg),
}
