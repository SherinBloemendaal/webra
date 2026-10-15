"""Specials: projectiles, explosions, markers and the two mine bodies.

Sizes follow WebRA's vector art (apps/game/js/sprites.js SPECIALS, art/effects.js, art/abilities.js): bullet 6 px,
small explosion 18, large explosion 36, piff 8, rally flag 12 x 16, tesla bolt 16 x 4, missile 8 x 3, shell 5,
chrono 24, nuke 64, the mines 10 and 7 px. Projectiles are authored facing north and drawn pointing east
(SpecialSpec heading 90). Explosions are stepped translucent blocks that grow and then fade, flat and unshaded
(emit) so the flame colours stay bright. The mines replace the bodies of the actors MINV and MINP (one frame, in
the owner's colour like WebRA's own).
"""
from core import Unit, dsin, dcos
from specs import SpecialSpec

FLAME = '#f2761c'
MID = '#ffb52e'
HOT = '#fff0a8'
WHITE = '#ffffff'
SMOKE = '#3a2f2a'


def _fade(k, count, start=0.55):
    """Opacity of frame k: solid until `start` of the animation, then fading to a quarter."""
    p = k / max(1, count - 1)
    if p <= start:
        return 1.0
    return 1.0 - 0.75 * (p - start) / (1 - start)


def _stack(u, cx, cy, r, h, cols, a, z=0.0):
    """A stepped octagon pyramid: wide dark base, then ever smaller lighter slabs (cols: base to top)."""
    n = len(cols)
    for i, c in enumerate(cols):
        rr = r * (1 - 0.7 * i / max(1, n - 1)) if n > 1 else r
        u.cyl(cx, cy, rr, h / n, c, z + i * h / n, n=8, a=a, emit=True)


# ---- Bullet, piff ------------------------------------------------------------------------------


def bullet(_k):
    u = Unit()
    u.box(-1.5, -3, 3, 6, 3, '#ffe9a0', 0, emit=True)  # a short chunky tracer
    u.box(-0.8, -1, 1.6, 4, 1.2, WHITE, 3, emit=True)
    u.box(-1.0, -4.5, 2, 1.6, 2, FLAME, 0.5, a=0.8, emit=True)  # glow trail behind
    return u


def piff(k):
    """A small puff of smoke and dust: a few pale blocks rise and thin out."""
    u = Unit()
    a = (1.0, 0.85, 0.65, 0.4)[k]
    g = k * 0.6
    for dx, dy, s in ((-1.6, 0.6, 3), (1.4, -0.4, 3.6), (0, 1.6, 2.6)):
        u.box(dx - s / 2 - g * 0.4 * (1 if dx > 0 else -1) * -1, dy - s / 2, s + g * 0.5, s + g * 0.5, 2.4 + k * 0.8, '#efe3c8', k * 0.8, a=a * 0.8, emit=True)
    u.box(-1.2, -1.2, 2.4, 2.4, 1.6, WHITE, 0.6 + k * 0.6, a=a, emit=True)
    return u


# ---- Explosions ----------------------------------------------------------------------------------


def _blast(k, count, size, smoke_h, layers):
    """One frame: smoke ring and flame grow, the white core appears early and shrinks, everything fades at the end."""
    u = Unit()
    p = (k + 1) / count
    grow = 0.35 + 0.65 * min(1.0, p * 1.6)
    a = _fade(k, count)
    r = size / 2 * grow
    u.cyl(0, 0, r, 0.6, SMOKE, 0, n=8, a=0.55 * a, emit=True)  # scorch and smoke under the fire
    _stack(u, 0, 0, r * 0.95, smoke_h * grow, [FLAME] * 1 + [MID] * (layers - 1), a)
    hot = max(0.0, 1.0 - p * 1.1)
    if hot > 0.05:
        _stack(u, 0, 0, r * 0.55 * (0.4 + hot * 0.6), smoke_h * grow * 0.9 + 1.0, [HOT, WHITE], a)
    if p > 0.45:
        # Dark smoke blocks lifting off the fire in the late frames.
        s = r * 0.5
        u.cyl(0, -s * 0.2, s * 0.8, 2 + smoke_h * 0.3, '#4a4038', smoke_h * grow * 0.8, n=8, a=0.6 * a, emit=True)
    return u


def small_explosion(k):
    return _blast(k, 6, 18, 6, 2)


def large_explosion(k):
    return _blast(k, 8, 36, 12, 3)


# ---- Rally flag, mines ---------------------------------------------------------------------------


def rally(_k):
    u = Unit()
    u.box(-4.5, -2.5, 5, 5, 1.2, 'dark', 0)  # base plate
    u.box(-2.5, -0.5, 1.5, 1.5, 15, 'darker', 0)  # pole
    u.box(-1, -0.4, 9, 1.2, 6.5, 'T', 8.5)  # flag (a thin slab, owner colour)
    u.box(-1, -0.4, 4, 1.2, 1.2, 'T', 7.3)  # the flag's tail steps down
    u.box(-3, -1, 2.6, 2.6, 1.2, 'yellow', 15)  # finial
    return u


def at_mine(_k):
    """Anti-tank mine: a bigger dark octagon with a team ring and a red light."""
    u = Unit()
    u.cyl(0, 0, 5.2, 1.6, '#3a3a2a', 0)
    u.cyl(0, 0, 4.0, 0.8, 'T', 1.6)
    u.cyl(0, 0, 2.4, 0.9, '#2a2a20', 2.4)
    u.box(-0.7, -0.7, 1.4, 1.4, 0.8, 'red', 3.3, emit=True)
    return u


def ap_mine(_k):
    """Anti-personnel mine: small, team colour, spikes and a red trigger."""
    u = Unit()
    u.cyl(0, 0, 3.4, 1.2, '#3a3a2a', 0)
    u.cyl(0, 0, 2.4, 0.6, 'T', 1.2)
    for dx, dy in ((-2.8, 0), (2.8, 0), (0, -2.8), (0, 2.8)):
        u.box(dx - 0.5, dy - 0.5, 1, 1, 1.8, 'steel2', 0.4)
    u.box(-0.6, -0.6, 1.2, 1.2, 1.4, 'red', 1.8, emit=True)
    return u


# ---- Projectiles ---------------------------------------------------------------------------------


def tesla_bolt(_k):
    """A zigzag of lightning, 16 px long, translucent ice blue with a bright core (north here, drawn east)."""
    u = Unit()
    pts = [(-0.4, -8), (1.2, -5.5), (-1.2, -3), (1.4, 0), (-1.0, 3), (1.2, 5.5), (0, 8)]
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        lo, hi = min(x0, x1) - 0.9, max(x0, x1) + 0.9
        u.box(lo, y0, hi - lo, y1 - y0, 1.6, 'ice', 1.5, a=0.7, emit=True)
        u.box((lo + hi) / 2 - 0.4, y0, 0.8, y1 - y0, 0.8, 'ice2', 3.1, a=0.95, emit=True)
    return u


def missile(_k):
    """A small rocket: a white body, red nose, grey fins and a flame (nose north, drawn east)."""
    u = Unit()
    u.box(-0.8, -3, 1.6, 5.5, 1.6, '#f4f4ee', 0.2)
    u.box(-0.5, 2.5, 1.0, 1.4, 1.0, '#c8302a', 0.5)  # nose
    u.box(-1.9, -3, 3.8, 1.2, 0.5, 'steel', 0.6)  # fins
    u.box(-0.6, -4.8, 1.2, 1.8, 1.0, FLAME, 0.4, a=0.85, emit=True)  # exhaust
    u.box(-0.3, -4.0, 0.6, 1.0, 0.6, HOT, 0.6, emit=True)
    return u


def shell(_k):
    """An artillery shell: a short brass cylinder with a glowing base, a tiny trail."""
    u = Unit()
    u.cyl(0, 0, 1.3, 3.4, '#d9a03a', 0.2, n=8)
    u.box(-0.8, 1.6, 1.6, 1.4, 1.4, '#6a6a60', 0.9)
    u.box(-1.0, -3.4, 2.0, 1.6, 1.4, FLAME, 0.4, a=0.7, emit=True)
    return u


# ---- Chrono, nuke --------------------------------------------------------------------------------


def chrono(k, count=8):
    """A blue-white warp-in: octagon rings shrink inward over a shimmering column, a white flash at the end."""
    u = Unit()
    p = k / (count - 1)
    a = 1.0 - 0.7 * p
    # Two rings of boxes closing in, as bars (octagon ring outlines).
    for j, (base, col) in enumerate(((11.5, '#9ef0ff'), (8.5, '#e0fcff'))):
        r = max(2.0, base * (1.05 - 0.55 * p) - j * 1.2 * p)
        z = 0.5 + j * 1.5 + p * 4
        for i in range(8):
            ang = 360.0 * i / 8
            cx, cy = r * dcos(ang), r * dsin(ang)
            u.box(cx - 1.4, cy - 1.4, 2.8, 2.8, 1.4, col, z, a=a, emit=True)
    # Shimmer: a translucent stepped column that pulses taller toward the flash.
    h = 4 + 14 * p
    u.cyl(0, 0, 8, 0.5, '#5adcf0', 0, n=8, a=0.35 * a, emit=True)
    _stack(u, 0, 0, 5.5, h, ['#8aeaff', '#c8f6ff', '#f2feff'], 0.55 * a)
    if k >= count - 2:
        u.cyl(0, 0, 3.4, 3, WHITE, 0.5, n=8, emit=True)
    return u


def nuke(k, count=12):
    """A stepped mushroom cloud: stalk, wide stepped cap, shock ring on the ground, fading as it ends."""
    u = Unit()
    p = (k + 1) / count
    a = _fade(k, count, 0.6)
    grow = min(1.0, p * 1.5)
    ring_r = 8 + 24 * min(1.0, p * 1.3)
    # Shock ring: eight slabs around a dim scorch disc.
    u.cyl(0, 0, ring_r, 0.4, '#5a3a24', 0, n=8, a=0.5 * a, emit=True)
    for i in range(8):
        ang = 360.0 * i / 8 + 22.5
        cx, cy = ring_r * 0.92 * dcos(ang), ring_r * 0.92 * dsin(ang)
        u.box(cx - 3, cy - 3, 6, 6, 1.2, '#ffd280', 0.4, a=0.8 * a, emit=True)
    sh = 6 + 26 * grow  # stalk height
    u.cyl(0, 0, 3 + 4 * grow, sh, '#8a5a34', 0, n=8, a=a, emit=True)
    u.cyl(0, 0, 2 + 2.5 * grow, sh, '#d89040', 0, n=8, top=False, a=a, emit=True)
    # Stepped cap: three slabs, each wider than the one above, glowing orange to yellow to white.
    cr = 8 + 16 * grow
    z = sh * 0.8
    u.cyl(0, 0, cr * 0.7, 3 + 3 * grow, '#6a3a24', z, n=8, a=a, emit=True)
    u.cyl(0, 0, cr, 4 + 4 * grow, FLAME, z + 3 * grow + 3, n=8, a=a, emit=True)
    u.cyl(0, 0, cr * 0.78, 3 + 3 * grow, MID, z + 7 + 7 * grow, n=8, a=a, emit=True)
    u.cyl(0, 0, cr * 0.46, 2 + 2 * grow, HOT, z + 10 + 10 * grow, n=8, a=a, emit=True)
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
