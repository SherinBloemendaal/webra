"""Vehicles: tanks, trucks, APCs, artillery, engineers' vehicles and husks.

Finished example: 1TNK, a light tank with a turret (the pattern for the others). Units are drawn in pixels facing
north (nose towards +y), centred on the ground; footprints match WebRA's vector art (a 1TNK is about 22 px long).
The turret is its own sprite around its pivot (turret_offsets of engine/rules.json: 1TNK has [0, 0]); its model
uses ground-relative z, so it floats at the height of the hull."""
from specs import VehicleSpec
from kit import tracks, barrel, wheel


def tnk1_body():
    from core import Unit
    u = Unit()
    tracks(u, 5, 10, -9.5, 9.5, 5)
    u.box(-5, -8.5, 10, 17, 3, 'T', 3)  # hull
    u.box(-4, 4, 8, 4.5, 2, 'T', 6)  # glacis plate
    u.box(-3, -8.5, 6, 2, 1.2, 'dark', 6)  # engine deck
    return u


def tnk1_turret():
    from core import Unit
    u = Unit()
    u.cyl(0, -0.5, 5.2, 3.2, 'T', 6.4)
    u.box(-2.2, -3.6, 4.4, 3, 1.2, 'T', 9.6)
    barrel(u, 0, 4, 13, 8.4, r=1.0)
    u.box(1.2, -2.5, 1.8, 1.8, 0.8, 'darker', 9.6)  # hatch
    return u



# ---- Local helpers -------------------------------------------------------------------------------

CHAR = '#3b3835'
CHAR2 = '#2a2724'
ASH = '#575350'
RUSTY = '#6a4a38'


def _unit():
    from core import Unit
    return Unit()


def _hazard(u, x, y, w, d, z, stripes=4, c1='yellow', c2='black'):
    """A box striped across its length (y), yellow and black."""
    sd = d / stripes
    for i in range(stripes):
        u.box(x, y + i * sd, w, sd, 0.4, c1 if i % 2 == 0 else c2, z)


def _pod(u, x, y0, y1, z, w=2.6, h=3.0, c='dark'):
    """A missile pod: a box with three dark tube mouths on its nose."""
    u.box(x - w / 2, y0, w, y1 - y0, h, c, z)
    for k in (-1, 0, 1):
        u.box(x + k * w / 3.2 - 0.3, y1 - 0.1, 0.6, 0.5, 0.6, 'darker', z + h * 0.45)


def _smoke(u, x, y, z):
    """A puff of smoke: translucent stepped blocks, narrowing as it rises."""
    u.box(x - 3.5, y - 3.5, 7, 7, 3, ASH, z, 0.55)
    u.box(x - 2.6, y - 2.6, 5.2, 5.2, 3, ASH, z + 3, 0.45)
    u.box(x - 1.6, y - 1.6, 3.2, 3.2, 2.5, ASH, z + 6, 0.35)


def _truck(u, half_w, y_rear, y_cab, bed_c, cab_c='T', h_bed=3.0):
    """A wheeled truck: four wheels, chassis, a cab at the front (+y) and a bed behind it. Returns the bed's front y."""
    for y in (y_rear + 4, (y_rear + y_cab) / 2, y_cab - 4):
        for sgn in (-1, 1):
            wheel(u, sgn * (half_w + 0.2), y, 2.6, 2.2)
    u.box(-half_w + 0.5, y_rear, 2 * half_w - 1, y_cab - y_rear + 3, 2.2, 'dark', 2.4)  # chassis
    cab_y = y_cab - 1
    u.box(-half_w + 0.5, cab_y, 2 * half_w - 1, 5.2, 4.6, cab_c, 3.0)  # cab
    u.box(-half_w + 1.6, cab_y + 3.4, 2 * half_w - 3.2, 1.9, 1.8, 'glass', 5.2)  # windscreen
    u.box(-half_w + 1.4, y_cab + 3.5 + 1.8, 2 * half_w - 2.8, 0.8, 1.0, 'yellow', 3.4)  # grille light bar
    u.box(-half_w + 0.3, y_rear, 2 * half_w - 0.6, cab_y - y_rear - 0.3, h_bed, bed_c, 3.0)  # bed
    return cab_y


def _tank_husk(w_half, track_in, track_out, y0, y1, hull_half, hull_y0, hull_y1):
    """The burnt wreck of a tracked vehicle: charred hull and tracks, a ring where the turret was, a smoke puff."""
    u = _unit()
    tracks(u, track_in, track_out, y0, y1, 4.2, c=CHAR2, cap=CHAR)
    u.box(-hull_half, hull_y0, 2 * hull_half, hull_y1 - hull_y0, 2.6, CHAR, 3)  # hull
    u.box(-hull_half + 1, hull_y0 + 1, 2 * hull_half - 2, 3.5, 1.2, RUSTY, 5.6)  # scorched deck plate
    u.box(-hull_half + 2.5, hull_y1 - 6.5, 3.2, 2.4, 1.0, CHAR2, 5.6)  # torn hatch
    u.cyl(0, 0.5, hull_half * 0.62, 1.2, CHAR2, 5.6)  # empty turret ring
    u.cyl(0, 0.5, hull_half * 0.36, 1.0, 'black', 6.8)
    u.box(hull_half - 3.2, hull_y0 + 2, 2.6, 1.8, 0.9, 'black', 5.6)  # scorch mark
    _smoke(u, 1.5, 0.5, 7.5)
    return u


# ---- 2TNK: medium tank --------------------------------------------------------------------------


def tnk2_body():
    u = _unit()
    tracks(u, 5.5, 11, -10.5, 10.5, 5)
    u.box(-5.5, -9.5, 11, 19, 3.2, 'T', 3)
    u.box(-4.5, 4.5, 9, 5, 2, 'T', 6.2)  # glacis plate
    u.box(-3.5, -9.5, 7, 2.2, 1.2, 'dark', 6.2)  # engine deck
    u.box(-4.5, -3, 9, 0.8, 0.6, 'dark', 6.2)  # turret ring seam
    return u


def tnk2_turret():
    u = _unit()
    u.cyl(0, -0.5, 5.8, 3.4, 'T', 6.4)
    u.box(-2.6, -4.4, 5.2, 3.2, 1.3, 'T', 9.8)  # bustle
    barrel(u, 0, 4.5, 14.5, 8.6, r=1.15)
    u.box(1.4, -2.8, 2.0, 2.0, 0.8, 'darker', 9.8)  # hatch
    return u


# ---- 3TNK: heavy tank, twin barrels --------------------------------------------------------------


def tnk3_body():
    u = _unit()
    tracks(u, 6, 12, -11.5, 11.5, 5.4)
    u.box(-6, -10.5, 12, 21, 3.4, 'T', 3.2)
    u.box(-5, 5, 10, 5.5, 2.2, 'T', 6.6)  # glacis
    u.box(-4, -10.5, 8, 2.4, 1.4, 'dark', 6.6)  # engine deck
    for sx in (-3.6, 2.2):
        u.box(sx, -10.8, 1.4, 1.2, 1.4, 'darker', 8)  # exhausts
    return u


def tnk3_turret():
    u = _unit()
    u.box(-6.4, -6, 12.8, 11.6, 3.8, 'dark', 6.6)  # turret base
    u.box(-5.6, -5.2, 11.2, 10, 1.4, 'T', 10.4)  # roof
    u.box(-4.4, -6.2, 8.8, 2.2, 1.6, 'T', 9.0)  # bustle
    barrel(u, -2.2, 5.4, 15.5, 9.0, r=1.0)
    barrel(u, 2.2, 5.4, 15.5, 9.0, r=1.0)
    u.box(-1.6, 5.0, 3.2, 1.6, 2.2, 'darker', 8.0)  # gun mantlet
    u.box(1.6, -3, 2.4, 2.4, 0.9, 'darker', 11.8)  # hatch
    return u


# ---- 4TNK: Mammoth, two big barrels and missile pods -----------------------------------------------


def tnk4_body():
    u = _unit()
    tracks(u, 7, 14.5, -13, 13, 6.2)
    u.box(-7, -12, 14, 24, 4, 'T', 3.6)
    u.box(-6, 6, 12, 6, 2.4, 'T', 7.6)  # glacis
    u.box(-5, -12, 10, 2.6, 1.6, 'dark', 7.6)
    for sx in (-4.6, 3.2):
        u.box(sx, -12.4, 1.6, 1.4, 1.6, 'darker', 9.4)  # exhausts
    u.box(-7.4, -10, 0.8, 18, 1.2, 'dark', 7.6)  # side skirts
    u.box(6.6, -10, 0.8, 18, 1.2, 'dark', 7.6)
    return u


def tnk4_turret():
    u = _unit()
    u.box(-7.4, -7.4, 14.8, 14.4, 4.2, 'dark', 7.6)
    u.box(-6.6, -6.6, 13.2, 12.8, 1.6, 'T', 11.8)  # roof
    u.box(-5.2, -7.8, 10.4, 2.6, 2.0, 'T', 10.0)  # bustle
    barrel(u, -3.1, 6.2, 18.5, 10.2, r=1.45)
    barrel(u, 3.1, 6.2, 18.5, 10.2, r=1.45)
    u.box(-4.6, 5.4, 9.2, 1.8, 2.8, 'darker', 8.8)  # mantlet
    for sx in (-9.4, 9.4):  # missile pods on the shoulders
        _pod(u, sx, -4, 5, 10.0, w=3.2, h=3.4)
        u.box(sx - 0.5 * (1 if sx > 0 else -1) - 0.4, -2, 0.8, 0.8, 0.8, 'dark', 9.4)
    u.box(2.2, -3.8, 3, 3, 1.0, 'darker', 13.4)  # hatch
    return u


# ---- TTNK: Tesla tank --------------------------------------------------------------------------


def ttnk_body():
    u = _unit()
    tracks(u, 5.5, 11, -10.5, 10.5, 5)
    u.box(-5.5, -9.5, 11, 19, 3.0, 'T', 3)
    u.box(-4.5, 5, 9, 4.5, 1.8, 'T', 6.0)
    u.box(-3.5, -9.5, 7, 2.2, 1.2, 'dark', 6.0)
    return u


def ttnk_turret():
    u = _unit()
    u.box(-6, -6.5, 12, 12, 3.2, 'dark', 6.2)  # housing
    u.box(-5.2, -5.7, 10.4, 10.4, 1.2, 'T', 9.4)  # team plate
    u.cyl(0, 0, 3.6, 2.4, 'steel', 10.6)  # coil base
    u.cyl(0, 0, 2.6, 2.0, 'steel2', 13.0)
    u.cyl(0, 0, 1.7, 1.8, 'ice', 15.0, emit=True)  # glowing coil head
    u.cyl(0, 0, 0.9, 1.2, 'ice2', 16.8, emit=True)
    u.box(-0.8, 3.6, 1.6, 4.4, 1.2, 'steel2', 9.6)  # emitter prong, forward
    u.box(-0.5, 7.6, 1.0, 1.0, 1.0, 'ice', 9.6, emit=True)
    for sx in (-4.4, 3.2):
        u.box(sx, -0.6, 1.2, 1.2, 4.0, 'steel', 10.6)  # side rods
    return u


# ---- CTNK: Chrono tank, one piece with a chrono core -----------------------------------------------


def ctnk_body():
    u = _unit()
    tracks(u, 6, 11, -9.5, 9.5, 5)
    u.prism([(-5.5, -9), (5.5, -9), (5.5, 4), (3.2, 10.5), (-3.2, 10.5), (-5.5, 4)], 3.2, 'T', 3)  # faceted hull
    u.box(-3.2, 4.5, 6.4, 5.5, 1.6, 'T', 6.2)  # nose plate
    u.box(-3.2, -9, 6.4, 2.4, 1.2, 'dark', 6.2)  # engine deck
    # chrono core: a steel collar with a glowing cyan heart
    u.cyl(0, -1, 4.4, 1.4, 'steel', 6.2)
    u.cyl(0, -1, 3.4, 3.2, 'ice', 7.6, a=0.9, emit=True)
    u.cyl(0, -1, 2.0, 1.4, 'ice2', 10.8, emit=True)
    # missile pods on the flanks
    for sx in (-8.2, 8.2):
        _pod(u, sx * 0.62 + (-0.5 if sx < 0 else 0.5), -2, 6.5, 6.2, w=2.6, h=2.8)
    return u


# ---- STNK: Phase Transport --------------------------------------------------------------------


def stnk_body():
    u = _unit()
    tracks(u, 6.5, 11, -11, 11, 4.4)
    u.prism([(-6, -11), (6, -11), (6, 6), (3.6, 11.5), (-3.6, 11.5), (-6, 6)], 3.4, 'T', 3)  # wedge hull
    u.box(-4.4, 6.5, 8.8, 4.5, 1.2, 'T', 6.4)
    u.box(-5, -10, 10, 2.4, 1.0, 'dark', 6.4)  # rear deck
    for y in (-4.5, 2.5):
        u.box(-5.6, y, 11.2, 0.5, 0.5, 'dark', 6.4)  # panel seams
    return u


def stnk_turret():
    u = _unit()
    u.box(-3.8, -4.6, 7.6, 8.6, 2.8, 'dark', 6.4)  # housing
    u.box(-3.0, -3.8, 6.0, 7.0, 1.0, 'T', 9.2)
    u.tube((0, -3, 11.2), (0, 6.5, 11.2), 1.2, 'steel2')  # launch tube
    u.tube((0, 6.2, 11.2), (0, 8.0, 11.2), 1.3, 'darker')
    u.tube((0, 4.5, 12.6), (0, 8.5, 12.6), 0.8, 'paint')  # rocket tip showing
    u.box(-0.6, 8.0, 1.2, 0.5, 0.5, 'red', 12.2)
    return u


# ---- QTNK: MAD tank, a seismic hammer on its back --------------------------------------------------


def qtnk_body():
    u = _unit()
    tracks(u, 6.5, 12, -11.5, 11.5, 5.2)
    u.box(-6.5, -10.5, 13, 21, 3.4, 'T', 3.2)
    u.box(-5.5, 6, 11, 4.5, 1.6, 'T', 6.6)  # glacis
    u.box(-4.5, -10.5, 9, 2.2, 1.2, 'dark', 6.6)
    # the hammer: a dark housing, a striped drum and a steel pestle on top
    u.cyl(0, -0.5, 6.4, 3.4, 'dark', 6.6)
    u.cyl(0, -0.5, 5.4, 2.2, 'yellow', 7.0)
    for k in range(4):
        u.box(-5.2 + k * 2.65, -2.0, 1.3, 3.0, 0.5, 'black', 9.2)
    u.cyl(0, -0.5, 3.4, 2.4, 'steel', 10.0)
    u.cyl(0, -0.5, 2.2, 2.4, 'steel2', 12.4)
    u.cyl(0, -0.5, 1.0, 1.2, 'glow', 14.8, emit=True)
    u.box(-0.5, 6.6, 1.0, 2.0, 1.0, 'darker', 8)  # front vent
    return u


# ---- MRJ: Radar Jammer --------------------------------------------------------------------------


def mrj_body():
    u = _unit()
    cab = _truck(u, 6.2, -11.5, 4, 'steel', 'T')
    u.box(-5.2, -11.5, 10.4, 1.2, 1.0, 'T', 6.0)  # team rear rail
    # jammer array: two whip antennas and a tilted dish
    for sx in (-4.4, 4.4):
        u.tube((sx, -10, 6), (sx, -10, 16), 0.45, 'darker')
        u.cyl(sx, -10, 0.9, 0.8, 'red', 15.6)
    u.box(-1.4, -4.0, 2.8, 2.8, 2.0, 'dark', 6.0)  # dish mast base
    u.tube((0, -2.6, 8), (0, -2.6, 10.2), 0.8, 'steel2')
    u.cyl(0, -2.6, 4.6, 1.2, 'steel2', 10.2)  # dish
    u.cyl(0, -2.6, 3.4, 1.2, 'radar', 11.4)
    u.cyl(0, -2.6, 1.0, 1.4, 'dark', 12.6)
    return u


# ---- MGG: Mobile Gap Generator -------------------------------------------------------------------


def mgg_body():
    u = _unit()
    _truck(u, 6.2, -11.5, 4, 'T', 'T')
    u.box(-5.2, -11.5, 10.4, 1.2, 1.0, 'dark', 6.0)  # rear rail
    # emitter: a cross-bar array on a pedestal under a dark orb with a pale glint
    u.box(-1.6, -4.6, 3.2, 3.2, 2.0, 'dark', 6.0)
    u.box(-7, -3.6, 14, 1.6, 1.6, 'darker', 8.0)
    u.box(-6.5, -3.2, 13, 0.8, 0.5, 'steel2', 9.6)
    u.cyl(-6.8, -2.8, 0.9, 3.4, 'steel', 8.0)
    u.cyl(6.8, -2.8, 0.9, 3.4, 'steel', 8.0)
    u.cyl(0, -2.8, 3.6, 3.6, 'shroud', 8.0)
    u.cyl(0, -2.8, 2.6, 1.6, '#5a5680', 11.6)
    u.box(-1.4, -4.2, 1.2, 1.2, 0.8, 'steel2', 13.2)  # glint
    return u


# ---- MNLY: Minelayer ------------------------------------------------------------------------------


def mnly_body():
    u = _unit()
    tracks(u, 5.5, 11, -10.5, 10.5, 5)
    u.box(-5.5, -9.5, 11, 19, 3.2, 'T', 3)
    u.box(-4.6, 4.5, 9.2, 4.5, 1.8, 'T', 6.2)  # glacis
    u.box(-2.6, 7.2, 5.2, 1.4, 0.8, 'glass', 8.0)  # visor slit
    # mine rack on the rear deck: a dark tray holding olive mines in two columns
    u.box(-5, -8.6, 10, 12.4, 1.2, 'dark', 6.2)
    for i in range(3):
        for sx in (-2.6, 2.6):
            y = -6.0 + i * 3.8
            u.cyl(sx, y, 1.7, 1.8, 'olive', 7.4)
            u.cyl(sx, y, 0.7, 0.6, 'darker', 9.2)
    u.box(-4.5, -9.4, 9, 1.0, 1.0, 'T', 6.2)  # tailgate bar
    return u


# ---- Husks ----------------------------------------------------------------------------------------


def husk_2tnk():
    return _tank_husk(0, 5.5, 11, -10.5, 10.5, 5.5, -9.5, 9.5)


def husk_3tnk():
    return _tank_husk(0, 6, 12, -11.5, 11.5, 6, -10.5, 10.5)


def husk_4tnk():
    return _tank_husk(0, 7, 14.5, -13, 13, 7, -12, 12)


def husk_mgg():
    """The wreck of the gap generator truck: charred cab and bed, flat tyres, a bent emitter bar, a smoke puff."""
    u = _unit()
    for y in (-7.5, 0, 7.5):
        for sgn in (-1, 1):
            wheel(u, sgn * 6.4, y, 2.4, 2.2, c=CHAR2, hub=CHAR)
    u.box(-5.7, -11.5, 11.4, 21, 2.0, CHAR2, 2.4)  # chassis
    u.box(-5.7, 3.6, 11.4, 5.2, 3.6, CHAR, 3.0)  # cab, windows gone
    u.box(-4.2, 6.2, 3, 1.8, 1.0, 'black', 5.4)
    u.box(-5.7, -11.5, 11.4, 14.5, 2.2, CHAR, 3.0)  # bed
    u.box(-3, -9.5, 6, 5, 1.0, RUSTY, 5.2)  # scorched bed plate
    u.box(-5.5, -3.6, 8, 1.2, 1.0, CHAR2, 5.2)  # bent bar on the bed
    u.box(2.4, -3.6, 3, 1.2, 1.0, CHAR2, 6.2)
    u.cyl(0, -3, 3.2, 1.0, 'black', 5.2)  # burnt orb socket
    _smoke(u, -1, -4, 6.4)
    return u


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
