"""Specials: projectiles, explosions, markers and the two mine bodies.

Sizes follow WebRA's vector art (apps/game/js/sprites.js SPECIALS, art/effects.js, art/abilities.js): bullet 6 px,
small explosion 18, large explosion 36, piff 8, rally flag 12 x 16, tesla bolt 16 x 4, missile 8 x 3, shell 5,
chrono 24, nuke 64, the mines 10 and 7 px. Projectiles are authored facing north and drawn pointing east
(SpecialSpec heading 90). Explosions are stepped translucent blocks that grow and then fade, flat and unshaded
(emit) so the flame colours stay bright. Retexture of 0.21.0: two to five blocks per frame. The mines replace the
bodies of the actors MINV and MINP (one frame, in
the owner's colour like WebRA's own).
"""
from core import Unit
from specs import SpecialSpec

FLAME = '#f2761c'
MID = '#ffb52e'
HOT = '#fff0a8'
WHITE = '#ffffff'


def _fade(k, count, start=0.55):
    """Opacity of frame k: solid until `start` of the animation, then fading to a quarter."""
    p = k / max(1, count - 1)
    if p <= start:
        return 1.0
    return 1.0 - 0.75 * (p - start) / (1 - start)


# ---- Bullet, piff ------------------------------------------------------------------------------


def bullet(_k):
    u = Unit()
    u.box(-1.5, -3, 3, 6, 3, '#ffe9a0', 0, emit=True)  # a short chunky tracer
    u.box(-1.0, -4.5, 2, 1.6, 2, FLAME, 0.5, a=0.8, emit=True)  # glow behind it
    return u


def piff(k):
    """A small puff of dust: two pale blocks that rise and thin out."""
    u = Unit()
    a = (1.0, 0.85, 0.65, 0.4)[k]
    s = 4.0 + k * 0.8
    u.box(-s / 2, -s / 2, s, s, 2.4 + k * 0.8, '#efe3c8', k * 0.8, a=a * 0.8, emit=True)
    u.box(-1.2, -1.2, 2.4, 2.4, 1.6, WHITE, 1.6 + k * 0.8, a=a, emit=True)
    return u


# ---- Explosions ----------------------------------------------------------------------------------


def _blast(k, count, size, height):
    """One frame: the flame grows, the white core appears early and shrinks, smoke lifts late, everything fades."""
    u = Unit()
    p = (k + 1) / count
    grow = 0.35 + 0.65 * min(1.0, p * 1.6)
    a = _fade(k, count)
    r = size / 2 * grow
    u.cyl(0, 0, r, height * grow * 0.5, FLAME, 0, n=8, a=a, emit=True)
    u.cyl(0, 0, r * 0.65, height * grow * 0.5, MID, height * grow * 0.5, n=8, a=a, emit=True)
    hot = max(0.0, 1.0 - p * 1.1)
    if hot > 0.05:
        u.cyl(0, 0, r * 0.4 * (0.4 + hot * 0.6), height * grow + 1.0, WHITE, 0, n=8, a=a, emit=True)
    if p > 0.45:
        u.cyl(0, -r * 0.1, r * 0.4, 2 + height * 0.3, '#4a4038', height * grow * 0.8, n=8, a=0.6 * a, emit=True)
    return u


def small_explosion(k):
    return _blast(k, 6, 18, 6)


def large_explosion(k):
    return _blast(k, 8, 36, 12)


# ---- Rally flag, mines ---------------------------------------------------------------------------


def rally(_k):
    u = Unit()
    u.box(-4.5, -2.5, 5, 5, 1.2, 'dark', 0)  # base plate
    u.box(-2.5, -0.5, 1.5, 1.5, 15, 'darker', 0)  # pole
    u.box(-1, -0.4, 9, 1.2, 6.5, 'T', 8.5)  # flag in the owner's colour
    return u


def at_mine(_k):
    """Anti-tank mine: a dark octagon with a team top and a red light."""
    u = Unit()
    u.cyl(0, 0, 5.2, 1.6, '#3a3a2a', 0)
    u.cyl(0, 0, 4.0, 0.8, 'T', 1.6)
    u.box(-0.8, -0.8, 1.6, 1.6, 0.9, 'red', 2.4, emit=True)
    return u


def ap_mine(_k):
    """Anti-personnel mine: small, a team top and a red trigger."""
    u = Unit()
    u.cyl(0, 0, 3.4, 1.2, '#3a3a2a', 0)
    u.cyl(0, 0, 2.4, 0.6, 'T', 1.2)
    u.box(-0.6, -0.6, 1.2, 1.2, 1.4, 'red', 1.8, emit=True)
    return u


# ---- Projectiles ---------------------------------------------------------------------------------


def tesla_bolt(_k):
    """A zigzag of lightning, 16 px long, translucent ice blue (north here, drawn east)."""
    u = Unit()
    pts = [(-0.4, -8), (1.2, -4), (-1.2, 0), (1.2, 4), (0, 8)]
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        lo, hi = min(x0, x1) - 0.9, max(x0, x1) + 0.9
        u.box(lo, y0, hi - lo, y1 - y0, 1.6, 'ice', 1.5, a=0.8, emit=True)
    return u


def missile(_k):
    """A small rocket: a white body, a red nose and its flame (nose north, drawn east)."""
    u = Unit()
    u.box(-0.8, -3, 1.6, 5.5, 1.6, '#f4f4ee', 0.2)
    u.box(-0.5, 2.5, 1.0, 1.4, 1.0, '#c8302a', 0.5)
    u.box(-0.6, -4.8, 1.2, 1.8, 1.0, FLAME, 0.4, a=0.85, emit=True)
    return u


def shell(_k):
    """An artillery shell: a short brass cylinder and its glowing trail."""
    u = Unit()
    u.cyl(0, 0, 1.3, 3.4, '#d9a03a', 0.2, n=8)
    u.box(-1.0, -3.4, 2.0, 1.6, 1.4, FLAME, 0.4, a=0.7, emit=True)
    return u


# ---- Chrono, nuke --------------------------------------------------------------------------------


def chrono(k, count=8):
    """A blue-white warp-in: a ring closing in over a shimmering column, a white flash at the end."""
    u = Unit()
    p = k / (count - 1)
    a = 1.0 - 0.7 * p
    r = max(2.0, 11.5 * (1.05 - 0.55 * p))
    u.cyl(0, 0, r, 1.6, '#9ef0ff', 0.5 + p * 4, n=8, top=False, a=a, emit=True)
    u.cyl(0, 0, 5.5, 4 + 14 * p, '#c8f6ff', 0, n=8, a=0.55 * a, emit=True)
    if k >= count - 2:
        u.cyl(0, 0, 3.4, 3, WHITE, 0.5, n=8, emit=True)
    return u


def nuke(k, count=12):
    """A stepped mushroom cloud: shock ring on the ground, the stalk and a two-step cap, fading as it ends."""
    u = Unit()
    p = (k + 1) / count
    a = _fade(k, count, 0.6)
    grow = min(1.0, p * 1.5)
    ring_r = 8 + 24 * min(1.0, p * 1.3)
    u.cyl(0, 0, ring_r, 1.2, '#ffd280', 0, n=8, top=False, a=0.8 * a, emit=True)
    sh = 6 + 26 * grow
    u.cyl(0, 0, 3 + 4 * grow, sh, '#d89040', 0, n=8, a=a, emit=True)
    cr = 8 + 16 * grow
    z = sh * 0.8
    u.cyl(0, 0, cr, 5 + 5 * grow, FLAME, z, n=8, a=a, emit=True)
    u.cyl(0, 0, cr * 0.6, 3 + 4 * grow, HOT, z + 5 + 5 * grow, n=8, a=a, emit=True)
    if p < 0.5:
        u.cyl(0, 0, 6 * (1 - p), 4, WHITE, 0, n=8, emit=True)  # the first white flash at ground zero
    return u


SPECIALS = {
    'bullet': SpecialSpec(bullet, 1, 0),
    'piff': SpecialSpec(piff, 4, 16, heading=0.0),
    'small_explosion': SpecialSpec(small_explosion, 6, 20, heading=0.0),
    'large_explosion': SpecialSpec(large_explosion, 8, 20, heading=0.0),
    'rally': SpecialSpec(rally, 1, 0, heading=0.0),
    'at_mine': SpecialSpec(at_mine, 1, 0, heading=0.0),
    'ap_mine': SpecialSpec(ap_mine, 1, 0, heading=0.0),
    'tesla_bolt': SpecialSpec(tesla_bolt, 1, 0),
    'missile': SpecialSpec(missile, 1, 0),
    'shell': SpecialSpec(shell, 1, 0),
    'chrono': SpecialSpec(chrono, 8, 14, heading=0.0),
    'nuke': SpecialSpec(nuke, 12, 14, heading=0.0),
}
