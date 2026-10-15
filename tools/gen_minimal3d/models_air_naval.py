"""Aircraft and ships. Finished examples: HELI (a helicopter with a rotor sprite) and PT (a gunboat with a turret).

Aircraft: the engine draws their shadow, so models have none; z 0 is the middle of the fuselage; a rotor is its own
'second' sprite (rotor(angle, fast) -> Unit around the actor's centre, hub at its z). Ships: hull on the water line
(z 0 is the water), a pale foam skirt, turrets like vehicles."""
from core import Unit, dsin, dcos
from specs import AircraftSpec, VehicleSpec
from kit import barrel

HUB_Z = 7.0
ROTOR_R = 15.0


def heli_body():
    u = Unit()
    # Fuselage: an octagonal pod, glass nose, tail boom to a fin with a small tail rotor, skids.
    u.cyl(0, 0, 4.6, 6, 'T', -3)
    u.box(-2.6, 3.2, 5.2, 4.6, 4.2, 'glass', -2.4)
    u.box(-1.2, -14, 2.4, 11, 2.2, 'T', -1.2)
    u.box(-0.5, -15.5, 1, 3, 5, 'T', -1.2)
    u.cyl(1.2, -15, 1.8, 0.6, 'steel2', 2, n=8)
    u.box(-4.2, -4, 1, 9, 0.8, 'dark', -4.4)
    u.box(3.2, -4, 1, 9, 0.8, 'dark', -4.4)
    u.box(-3.4, -2, 0.8, 0.8, 1.6, 'dark', -3.6)
    u.box(2.6, -2, 0.8, 0.8, 1.6, 'dark', -3.6)
    u.box(-0.6, 1, 1.2, 1.2, HUB_Z - 3 + 1, 'steel', 3)  # mast
    u.box(-4.8, 1.5, 1.2, 4.5, 1.2, 'dark', -1.2)  # stub wings
    u.box(3.6, 1.5, 1.2, 4.5, 1.2, 'dark', -1.2)
    return u


def heli_rotor(angle, fast):
    u = Unit()
    blades = 4
    for k in range(blades):
        a = angle + k * 360.0 / blades
        c, s = dcos(a), dsin(a)
        # A blade is a thin box along the angle: built as a beam so it turns freely.
        u.beam((c * 1.5, s * 1.5, HUB_Z), (c * ROTOR_R, s * ROTOR_R, HUB_Z), 1.4, 'steel2' if not fast else 'steel', a=0.55 if fast else 1.0)
    u.cyl(0, 0, 1.6, 1.4, 'dark', HUB_Z - 0.4)
    return u


def pt_body():
    from core import Unit
    u = Unit()
    hull = [(-4.8, -13), (4.8, -13), (5.4, 2), (3.2, 10), (0, 14), (-3.2, 10), (-5.4, 2)]
    u.prism(hull, 3.6, 'steel2', 0)
    u.prism([(x * 0.86, y * 0.9) for x, y in hull], 1.2, 'T', 3.6)
    u.box(-3, -9, 6, 8, 3.4, 'wall', 4.8)  # cabin
    u.box(-3.2, -2.4, 6.4, 1.2, 2, 'glass', 6.2)  # windows
    u.box(-1, -10, 2, 2, 4, 'dark', 8.2)  # mast
    # Foam at the bow and stern.
    u.prism([(-5.6, 6), (5.6, 6), (3.6, 11), (0, 15), (-3.6, 11)], 0.4, 'steam', 0, a=0.55)
    u.prism([(-5.6, -14), (5.6, -14), (4.8, -11), (-4.8, -11)], 0.4, 'steam', 0, a=0.55)
    return u


def pt_turret():
    from core import Unit
    u = Unit()
    u.cyl(0, 0, 3, 2.4, 'dark', 4.8)
    u.box(-1.8, -1.8, 3.6, 3, 1.4, 'T', 7.2)
    barrel(u, 0, 1, 9, 7.8, r=0.8)
    return u


# ---- Shared helpers ----------------------------------------------------------------------------------------------


def mirror(half):
    """A closed polygon from the right half outline (x >= 0, listed from the front to the back) and its left mirror."""
    return list(half) + [(-x, y) for x, y in reversed(half)]


def star(u, x, y, z, r=1.6):
    """A small red marking flat on a wing (a diamond: readable at one pixel per world pixel)."""
    u.flat([(x, y + r), (x + r, y), (x, y - r), (x - r, y)], z, 'red')


def foam(u, outline, z=0.0, grow=1.1):
    """A pale foam skirt: the outline pushed out a little, flat on the water."""
    u.prism([(x * grow + (0.6 if x > 0 else -0.6 if x < 0 else 0), y * 1.04) for x, y in outline], 0.4, 'steam', z, a=0.55)


def wake(u, y, w):
    """Two short white streaks off the stern."""
    for sgn in (-1, 1):
        u.prism([(sgn * w * 0.55, y + 1), (sgn * w * 0.95, y - 2.5), (sgn * w * 1.15, y - 2.5), (sgn * w * 0.8, y + 1)], 0.4, 'steam', 0, a=0.55)


def blade_ring(u, angle, fast, n, r, hub_z, hub_r, width):
    """n rotor blades around the origin at `angle`, as beams, and a hub cap."""
    for k in range(n):
        a = angle + k * 360.0 / n
        c, s = dcos(a), dsin(a)
        u.beam((c * 1.5, s * 1.5, hub_z), (c * r, s * r, hub_z), width, 'steel' if fast else 'steel2', a=0.55 if fast else 1.0)
    u.cyl(0, 0, hub_r, 1.4, 'dark', hub_z - 0.4)


# ---- Helicopters -------------------------------------------------------------------------------------------------

TRAN_HUB_Z = 8.0
TRAN_ROTOR_R = 11.0


def tran_body():
    u = Unit()
    # Chinook: a long boxy cabin with a glazed nose, a front pylon over the cockpit, a tall rear pylon with engine pods.
    u.prism([(-3, 18), (3, 18), (5, 15), (5, -15), (3, -19), (-3, -19), (-5, -15), (-5, 15)], 6, 'T', -3)
    u.box(-3.4, 14.6, 6.8, 3.8, 2.6, 'glass', -0.6)  # cockpit glazing
    u.box(-0.4, 14.6, 0.8, 3.8, 2.7, 'dark', -0.6)
    for sgn in (-1, 1):
        x = 4.6 if sgn > 0 else -5.6
        for y in (-6, -1.5, 3, 7.5):  # cabin windows
            u.box(x, y, 1, 2, 1.6, 'dark', 0)
    u.box(-1.6, 12.2, 3.2, 3.6, TRAN_HUB_Z - 3, 'T', 3)  # front pylon
    u.box(-2.4, -17.5, 4.8, 7, TRAN_HUB_Z - 3, 'T', 3)  # rear pylon
    for sgn in (-1, 1):
        x = 3.4 if sgn > 0 else -6.4
        u.box(x, -18, 3, 9, 3.2, 'steel', 0.4)  # engine pods
        u.box(x, -18.4, 3, 0.8, 3.2, 'darker', 0.4)
        u.box(sgn * 4.4 - 0.5, 9, 1, 3, 1.4, 'dark', -4.4)  # wheel pods
        u.box(sgn * 4.4 - 0.5, -9, 1, 3, 1.4, 'dark', -4.4)
    u.box(-2, -19.6, 4, 1.4, 1.2, 'steel', -1)  # rear ramp edge
    return u


def tran_rotor(angle, fast):
    # The engine places this sprite at every rotor offset (+14 and -14 px along the hull), so it holds ONE rotor, hub at its z.
    u = Unit()
    blade_ring(u, angle, fast, 3, TRAN_ROTOR_R, TRAN_HUB_Z, 1.5, 1.3)
    return u


HIND_HUB_Z = 6.5
HIND_ROTOR_R = 16.0


def hind_body():
    u = Unit()
    # Gunship: a pointed fuselage, tandem bubble cockpits (gunner low in front, pilot behind), stub wings with rocket pods.
    u.prism([(0, 14), (3.2, 10), (4, 4), (4, -8), (2.4, -12), (-2.4, -12), (-4, -8), (-4, 4), (-3.2, 10)], 5, 'T', -2.5)
    u.box(-1.8, 8.2, 3.6, 3.4, 2.2, 'glass', 2.5)  # gunner
    u.box(-2.1, 3.4, 4.2, 4, 3, 'glass', 2.5)  # pilot
    u.box(-0.3, 3.4, 0.6, 4, 3.1, 'dark', 2.5)
    u.box(-0.6, -26, 1.2, 15, 2, 'T', -0.4)  # tail boom
    u.box(-0.5, -27, 1, 5, 5.4, 'T', -0.4)  # fin
    u.cyl(1.4, -26, 1.8, 0.6, 'steel2', 1.2)  # tail rotor
    u.box(-4.4, -3.6, 1.6, 4.4, 2.4, 'dark', 1)  # engine intakes beside the mast
    u.box(2.8, -3.6, 1.6, 4.4, 2.4, 'dark', 1)
    u.box(-12, -1.4, 24, 3.4, 1, 'T', -0.6)  # stub wings
    for sgn in (-1, 1):
        x = sgn * 10
        u.tube((x, -3.5, -1.2), (x, 4.5, -1.2), 1.6, 'dark')  # rocket pods
        u.tube((x, 4, -1.2), (x, 4.8, -1.2), 1.7, 'red')
    u.tube((0, 12.5, -2.6), (0, 17, -2.6), 0.5, 'darker')  # chin gun
    u.box(-0.6, -0.8, 1.2, 1.2, HIND_HUB_Z - 2.5, 'steel', 2.5)  # mast
    return u


def hind_rotor(angle, fast):
    u = Unit()
    blade_ring(u, angle, fast, 5, HIND_ROTOR_R, HIND_HUB_Z, 1.7, 1.3)
    return u


MH60_HUB_Z = 6.5
MH60_ROTOR_R = 15.5


def mh60_body():
    u = Unit()
    # Black Hawk, dimensions of the pixel art model (tools/gen_pixel_art.py): a 20 px cabin with a rounded glazed nose,
    # two engines on the roof, a boom rising to a swept fin, door guns and wheels.
    u.prism([(-1.5, 11.6), (1.5, 11.6), (3.2, 9.4), (4, 5.4), (4, -9), (-4, -9), (-4, 5.4), (-3.2, 9.4)], 6, 'T', -2.6)
    u.box(-3.3, 5.6, 6.6, 4.2, 2.4, 'glass', 0.4)  # windscreen
    u.box(-0.4, 5.6, 0.8, 4.2, 2.5, 'dark', 0.4)
    for sgn in (-1, 1):
        x = 3.6 if sgn > 0 else -4.6
        u.box(x, 2, 1, 3.4, 1.8, 'glass', 0.6)  # side windows
        u.box(x, -3.8, 1, 3.4, 1.8, 'glass', 0.6)
        u.box(sgn * 2 - 0.9, -6, 1.8, 8, 1.8, 'steel2', 3.4)  # engines
        u.box(sgn * 2.6 - 0.5, -9.4, 1, 1.4, 1, 'darker', 3.6)  # exhausts
        u.tube((sgn * 4.5, 1, 0.8), (sgn * 4.5, 4.4, 0.8), 0.4, 'darker')  # door guns
        u.tube((sgn * 3.5 - 0.5, 4.4, -3.4), (sgn * 3.5 + 0.5, 4.4, -3.4), 1.05, 'darker')  # wheels
        u.box(sgn * 3.3 - 0.25, 4, 0.5, 0.8, 1.2, 'dark', -3)  # struts
    u.box(-1, -21, 2, 13, 2.8, 'T', -1.4)  # tail boom
    u.box(-0.5, -23.6, 1, 4.6, 5.4, 'T', 0.8)  # swept fin
    u.box(-4.4, -22.4, 8.8, 1.8, 0.6, 'T', 1.2)  # stabilator
    u.tube((0.9, -22.2, 4.4), (1.3, -22.2, 4.4), 2.2, 'steel2')  # tail rotor
    u.box(-0.6, -0.8, 1.2, 1.6, MH60_HUB_Z - 3, 'steel', 3.4)  # mast
    u.cyl(0, 0.4, 1.8, 1.4, 'T', 3.4)  # hub fairing
    return u


def mh60_rotor(angle, fast):
    u = Unit()
    blade_ring(u, angle, fast, 4, MH60_ROTOR_R, MH60_HUB_Z, 1.4, 1.4)
    return u


# ---- Planes ------------------------------------------------------------------------------------------------------


def yak_body():
    u = Unit()
    # Propeller fighter: straight wings, a stubby fuselage, a canopy, a blurred propeller disc and spinner.
    u.tube((0, -3, 0), (0, 8, 0), 2.3, 'olive')
    u.tube((0, -11, 0.2), (0, -3, 0), 1.5, 'olive')
    u.tube((0, 7, 0), (0, 10, 0), 2.5, 'steel')  # cowling
    u.cyl(0, 10.4, 1.1, 1, 'steel2', -0.5)
    u.box(-13, -2.5, 26, 6, 1, 'T', -0.9)  # wings
    u.box(-13, -2.5, 26, 1, 1.05, 'dark', -0.9)  # trailing edge
    u.box(-6, -11.5, 12, 3.4, 0.8, 'T', -0.2)  # tailplane
    u.box(-0.5, -11.5, 1, 4, 4.6, 'dark', 0.4)  # fin
    u.box(-1.1, 0.2, 2.2, 3.8, 1.6, 'glass', 1.5)  # canopy
    star(u, -9, 0.5, 0.15)
    star(u, 9, 0.5, 0.15)
    u.tube((0, 10.8, 0), (0, 11.1, 0), 5.4, 'darker', a=0.4)  # propeller blur
    return u


def mig_body():
    u = Unit()
    s = 1.18  # a bigger plane than the Yak (selection bounds 1536 x 1194)
    # Swept-wing jet: a pointed nose, swept wings with missile pylons, a tailplane and one exhaust.
    u.prism([(0, 9 * s), (14 * s, -6 * s), (14 * s, -9.5 * s), (0, -4 * s), (-14 * s, -9.5 * s), (-14 * s, -6 * s)], 1.2, 'T', -1)
    u.prism([(0, -9 * s), (6 * s, -14 * s), (-6 * s, -14 * s)], 0.8, 'T', -0.4)  # tailplane
    u.tube((0, -14 * s, 0), (0, 10 * s, 0), 2.0 * s, 'steel2')
    u.tube((0, 10 * s, 0), (0, 14 * s, 0), 1.0 * s, 'steel')  # nose cone
    u.box(-0.8 * s, 3.5 * s, 1.6 * s, 4.6 * s, 1.3, 'glass', 1.4)  # canopy
    u.box(-0.5, -14 * s, 1, 8 * s, 4.8, 'dark', 0.4)  # fin
    u.tube((0, -14.6 * s, 0), (0, -13 * s, 0), 1.3 * s, 'darker')  # exhaust
    star(u, -9 * s, -7 * s, 0.25, 1.7)
    star(u, 9 * s, -7 * s, 0.25, 1.7)
    for sgn in (-1, 1):
        u.tube((sgn * 7.5 * s, -6.5 * s, -1.5), (sgn * 7.5 * s, -0.5 * s, -1.5), 0.7, 'paint')  # missiles
        u.tube((sgn * 7.5 * s, -0.8 * s, -1.5), (sgn * 7.5 * s, -0.2 * s, -1.5), 0.75, 'red')
    return u


def u2_body():
    u = Unit()
    # Spy plane: very long glider wings, a slim dark fuselage, a canopy, wing tip skids.
    u.box(-21, -2, 42, 3.6, 0.9, 'T', -0.8)
    u.box(-21, -2, 42, 0.8, 0.95, 'dark', -0.8)
    u.tube((0, -12, 0), (0, 13, 0), 1.6, 'dark')
    u.tube((0, 13, 0), (0, 14.5, 0), 0.9, 'steel2')
    u.box(-7, -12.5, 14, 3, 0.7, 'T', -0.2)  # tailplane
    u.box(-0.5, -12.5, 1, 5.5, 4.2, 'steel2', 0.6)  # fin
    u.box(-0.9, 5.4, 1.8, 3, 1.4, 'glass', 1)  # canopy
    u.box(-1.6, -0.6, 3.2, 1.6, 0.5, 'T', 0.9)  # team band
    for sgn in (-1, 1):
        u.box(sgn * 20 - 0.5, -1.6, 1, 2.4, 1.2, 'steel2', -1.9)  # skids
    return u


def badr_body():
    u = Unit()
    # Twin-jet bomber: swept wings with nacelles, a glazed nose, a tall fin, a tail gun.
    u.prism([(0, 9), (20, -3), (20, -6.5), (0, -1), (-20, -6.5), (-20, -3)], 1.3, 'T', -1.2)
    u.prism([(0, -10), (10, -18), (-10, -18)], 0.9, 'T', -0.6)  # tailplane
    for sgn in (-1, 1):
        x = sgn * 7
        u.tube((x, -9, 0.6), (x, 3, 0.6), 2.3, 'T')  # engine nacelles
        u.tube((x, 3, 0.6), (x, 3.8, 0.6), 1.8, 'darker')
        star(u, sgn * 14.5, -4.8, 0.2, 1.8)
    u.tube((0, -19, 0), (0, 16, 0), 2.7, 'steel2')
    u.box(-1.4, 15, 2.8, 4.2, 2.4, 'glass', -1.2)  # glazed nose
    u.box(-1.2, 7, 2.4, 3, 1.4, 'glass', 1.8)  # cockpit
    u.box(-0.5, -19, 1, 10, 6.5, 'dark', 0.6)  # fin
    u.box(-1.2, -21, 2.4, 2.4, 1.6, 'darker', -0.6)  # tail gun
    return u


# ---- Ships -------------------------------------------------------------------------------------------------------

LST_OUT = [(-10, -17), (10, -17), (10, 15), (8, 18), (-8, 18), (-10, 15)]


def lst_body():
    u = Unit()
    # Landing craft: a boxy hull with an open well deck holding crates, a bow ramp, a stern house with the team colour.
    u.prism(LST_OUT, 3.6, 'steel2', 0)
    u.box(-8.4, -9, 16.8, 22, 0.6, 'sandy', 3.6)  # well deck floor
    for x in (-10, 8.4):
        u.box(x, -17, 1.6, 32, 2.2, 'steel', 3.6)  # well walls
    for i, y in enumerate((-6, 0, 6)):
        u.box(-6.4, y, 5.4, 4.6, 2.2, 'wood' if i % 2 == 0 else 'canvas', 4.2)
        u.box(0.8, y + 0.6, 5.4, 4.2, 2.2, 'canvas' if i % 2 == 0 else 'wood', 4.2)
    u.poly([(-8, 21, 1.2), (8, 21, 1.2), (8, 14, 4.2), (-8, 14, 4.2)], 'steel')  # bow ramp, lowered
    u.box(-8.4, 14, 16.8, 1.2, 1.4, 'dark', 3.6)  # ramp hinge
    u.box(-9, -17, 18, 8, 5, 'T', 3.6)  # stern house
    u.box(-6, -15, 12, 4, 2.6, 'wall', 8.6)  # wheelhouse
    u.box(-6.2, -11.4, 12.4, 1, 1.3, 'glass', 9.2)
    u.box(-0.5, -14, 1, 1, 3.4, 'dark', 11.2)  # mast
    foam(u, LST_OUT)
    wake(u, -17, 7)
    return u


SS_OUT = [(-1.5, 17), (1.5, 17), (3.8, 14), (4.6, 8), (4.6, -10), (3.5, -14), (1.5, -16), (-1.5, -16), (-3.5, -14), (-4.6, -10), (-4.6, 8), (-3.8, 14)]


def ss_body():
    u = Unit()
    # Mostly under water: only the hull top breaks the surface, with the sail, a periscope, tail fins and foam.
    u.prism(SS_OUT, 1.4, 'dark', -0.2)
    u.prism([(x * 0.62, y * 0.9) for x, y in SS_OUT], 0.4, 'steel', 1.2)
    u.box(-2.2, -3, 4.4, 8.6, 4.2, 'T', 1.2)  # sail
    u.box(-1.4, 0.6, 2.8, 1.2, 0.9, 'glass', 4)  # sail window
    u.tube((0, 3.4, 5.4), (0, 3.4, 8), 0.45, 'darker')  # periscope
    u.tube((0, 3.4, 7.6), (0, 4.8, 7.6), 0.45, 'darker')
    u.poly([(-7, -14, 0.4), (7, -14, 0.4), (3, -10, 0.4), (-3, -10, 0.4)], 'dark', a=0.7)  # tail planes under the surface
    foam(u, SS_OUT, z=0.2, grow=1.35)
    wake(u, -16, 5)
    return u


MSUB_OUT = [(-2.2, 21), (2.2, 21), (5, 17), (6.4, 10), (6.4, -14), (5, -18), (2.4, -20.5), (-2.4, -20.5), (-5, -18), (-6.4, -14), (-6.4, 10), (-5, 17)]


def msub_body():
    u = Unit()
    # Missile submarine: a wider hull top with two rows of launch hatches and a sail forward of them.
    u.prism(MSUB_OUT, 1.6, 'dark', -0.2)
    u.prism([(x * 0.7, y * 0.92) for x, y in MSUB_OUT], 0.4, 'steel', 1.4)
    for k in range(4):
        for sgn in (-1, 1):
            u.cyl(sgn * 2.7, -15 + k * 4.2, 1.5, 0.6, 'darker', 1.8)
            u.cyl(sgn * 2.7, -15 + k * 4.2, 1.0, 0.5, 'T', 2.4)
    u.box(-2.6, 5, 5.2, 9, 4.4, 'T', 1.4)  # sail
    u.box(-1.8, 9, 3.6, 1.2, 0.9, 'glass', 4.4)
    u.tube((0, 9, 5.8), (0, 9, 8.4), 0.5, 'darker')  # periscope
    u.poly([(-9, -18, 0.4), (9, -18, 0.4), (3, -13, 0.4), (-3, -13, 0.4)], 'dark', a=0.7)
    foam(u, MSUB_OUT, z=0.2, grow=1.25)
    wake(u, -20.5, 6.5)
    return u


DD_OUT = [(0, 20), (4, 17), (7, 11), (9, 3), (9, -18), (8, -20), (-8, -20), (-9, -18), (-9, 3), (-7, 11), (-4, 17)]


def dd_body():
    u = Unit()
    # Destroyer: a long hull, bridge and funnel amidships, depth charges aft; the missile turret sits 11 px ahead.
    u.prism(DD_OUT, 4, 'steel2', 0)
    u.prism([(x * 0.84, y * 0.92) for x, y in DD_OUT], 1, 'T', 4)
    u.box(-4.4, -6, 8.8, 9, 3.6, 'wall', 5)  # bridge
    u.box(-4.6, 2, 9.2, 1, 1.3, 'glass', 6.4)
    u.box(-2.6, -4, 5.2, 4, 1.6, 'steel', 8.6)
    u.cyl(0, -10, 2.4, 3.4, 'darker', 5)  # funnel
    u.cyl(0, -10, 1.5, 0.3, 'black', 8.4)
    for x in (-4.5, 4.5):
        u.cyl(x, -16, 1.2, 2, 'yellow', 5)  # depth charges
    u.tube((0, -5, 8.6), (0, -5, 12), 0.4, 'darker')  # mast
    foam(u, DD_OUT)
    wake(u, -20, 7)
    return u


def dd_turret():
    u = Unit()
    # Twin Stinger launcher, around its pivot, standing on the deck (z 5).
    u.box(-3.6, -4, 7.2, 8, 2.2, 'dark', 5)
    u.box(-2.8, -3.2, 5.6, 6.4, 1.2, 'T', 7.2)
    for x in (-1.5, 1.5):
        u.tube((x, -1.5, 9.2), (x, 5.2, 9.2), 0.8, 'paint')
        u.tube((x, 4.6, 9.2), (x, 5.4, 9.2), 0.85, 'red')
    return u


CA_OUT = [(0, 27), (5, 22), (9, 14), (11, 4), (11, -22), (9, -27), (-9, -27), (-11, -22), (-11, 4), (-9, 14), (-5, 22)]


def ca_body():
    u = Unit()
    # Cruiser: a long deck with a bridge tower and two funnels amidships; the two gun turrets stand at -21 and +18 px.
    u.prism(CA_OUT, 4.6, 'steel2', 0)
    u.prism([(x * 0.86, y * 0.93) for x, y in CA_OUT], 0.8, 'sandy', 4.6)
    u.box(-7, -14, 14, 20, 0.5, 'T', 5.4)  # team deck
    u.box(-5, -2, 10, 9, 5, 'wall', 5.9)  # bridge tower
    u.box(-5.2, 5.2, 10.4, 1, 1.4, 'glass', 8.2)
    u.box(-3, 0, 6, 5, 1.6, 'steel', 10.9)
    for y in (-6, -10.5):
        u.cyl(0, y, 2.6, 4, 'darker', 5.9)  # funnels
        u.cyl(0, y, 1.6, 0.3, 'black', 9.8)
    u.tube((0, -14, 5.9), (0, -14, 14), 0.5, 'darker')  # mast
    u.beam((-4, -14, 12), (4, -14, 12), 0.7, 'darker')
    foam(u, CA_OUT)
    wake(u, -27, 9)
    return u


def ca_turret():
    u = Unit()
    # One twin 8 inch gun house, placed twice by the engine, around its pivot, standing on the deck (z 5.4).
    u.cyl(0, 0, 4.6, 2.6, 'dark', 5.4)
    u.box(-3.2, -3.4, 6.4, 6.4, 1.6, 'T', 8)
    for x in (-1.5, 1.5):
        u.tube((x, 1, 9), (x, 9, 9), 0.85, 'dark')
        u.tube((x, 7.8, 9), (x, 9.3, 9), 1.1, 'darker')
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
    # Two mounts (-21 and +18 px, rules.json): the hull's shear is anchored between them.
    'CA': VehicleSpec(ca_body, ca_turret, shadow=False, turret_pivot=(0.0, 18.0), shear_pivot=(0.0, -1.5)),
}
# The Badger bomber of the paradrop and parabomb raids is the same plane.
ALIASES = {'BADR.Bomber': 'BADR'}
