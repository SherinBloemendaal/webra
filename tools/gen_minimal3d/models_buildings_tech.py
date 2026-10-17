"""Tech buildings and superweapons: Radar Dome, Allied and Soviet Tech Centers, Gap Generator, Chronosphere,
Iron Curtain, Missile Silo (and the fakes that share them).

Retexture of 0.21.0: three to six big blocks each, the defining feature kept (the radar dome, the satellite dish, the
mast with its red lamp, the emitter with its dish, the chronosphere's light column between pylons, the curtain's red
field, the open silo with the missile's nose) and one team strip. Coordinates are cells, see core.Building and
models_buildings_base. Effects are translucent (alpha) and stay readable against the ground."""
from core import dcos, dsin
from specs import BuildingSpec


def circ(cx, cy, r, n=12):
    return [(cx + r * dcos(360.0 * i / n), cy + r * dsin(360.0 * i / n)) for i in range(n)]


def dome(b):
    # A low hall with a team strip and the big radar dome behind it, with a green sweep on top.
    f = b.front
    b.apron()
    b.box(b.x0, f - 0.75, b.x1 - b.x0, 0.75, 0.4, 'wall')
    b.box(b.x0, f - 0.18, b.x1 - b.x0, 0.18, 0.05, 'T', 0.4)
    r = 0.9
    cy = f - 0.75 - 0.05 - r * 0.6
    h = b.top(cy - 0.4 * r)
    b.vdome(1.0, cy, r, h, 'dome')
    b.flat([(1.0, cy), (1.0 + 0.3, cy - 0.12), (1.0 + 0.28, cy + 0.14)], h + 0.005, 'radar')


def atek(b):
    # Hall with a team strip and a glass roof, and the satellite dish on its post at the back.
    f = b.front
    b.apron()
    b.box(b.x0, f - 1.1, b.x1 - b.x0, 1.1, 0.5, 'wall')
    b.box(b.x0, f - 0.18, b.x1 - b.x0, 0.18, 0.05, 'T', 0.5)
    b.box(0.3, f - 0.95, 1.4, 0.65, 0.06, 'glass', 0.5)
    post = f - 1.5
    top = b.top(post)
    b.box(1.0, post, 0.14, 0.14, top - 0.72, 'steel')
    b.bill(1.07, post + 0.15, top - 0.72, [(u, h) for u, h in circ(0, 0.36, 0.36)], 'dome')


def stek(b):
    # Brick hall with a pale roof and a team strip, and the tall mast with its red lamp.
    f = b.front
    b.apron()
    b.box(b.x0, f - 1.6, b.x1 - b.x0, 1.6, 0.7, 'brick')
    b.box(0.2, f - 1.4, 1.7, 1.2, 0.05, 'roof', 0.7)
    b.box(b.x0, f - 0.18, b.x1 - b.x0, 0.18, 0.05, 'T', 0.7)
    mast = f - 1.5
    top = b.top(mast)
    b.box(2.2, mast, 0.32, 0.32, top - 0.16, 'steel')
    b.box(2.24, mast + 0.04, 0.24, 0.24, 0.16, 'red', top - 0.16)


def gap(b):
    # Plinth with a team strip, the emitter pole and its round dish with an ice-blue cap.
    f = b.front
    b.box(b.x0, f - 1.0, b.x1 - b.x0, 1.0, 0.18, 'concrete')
    b.box(b.x0, f - 0.12, b.x1 - b.x0, 0.12, 0.04, 'T', 0.18)
    cy = f - 0.5
    top = b.top(cy - 0.42)
    b.cyl(0.5, cy, 0.17, top - 0.38, 'steel', 0.18)
    b.cyl(0.5, cy, 0.42, 0.12, 'dome', top - 0.38 + 0.18 - 0.02)
    b.cyl(0.5, cy, 0.2, top - (top - 0.38 + 0.18 - 0.02 + 0.12), 'ice', top - 0.38 + 0.18 - 0.02 + 0.12)


def pdox(b):
    # Pad with a team strip, two pylons at the back and the ring with its light column between them.
    f = b.front
    b.box(b.x0, f - 2.0, b.x1 - b.x0, 2.0, 0.12, 'concrete')
    b.box(b.x0, f - 0.15, b.x1 - b.x0, 0.15, 0.03, 'T', 0.12)
    for x in (0.1, 1.68):
        b.block(x, f - 1.9, 0.22, 0.22, 'steel', 0.12)
    b.cyl(1.0, f - 1.0, 0.7, 0.24, 'steel2', 0.12)
    b.cyl(1.0, f - 1.0, 0.32, b.top(f - 1.32) - 0.36, 'ice2', 0.36, a=0.55)


def iron(b):
    # Pad with a team strip, two pylons at the back, the dark console and the red field over it.
    f = b.front
    b.box(b.x0, f - 1.9, b.x1 - b.x0, 1.9, 0.12, 'concrete')
    b.box(b.x0, f - 0.15, b.x1 - b.x0, 0.15, 0.03, 'T', 0.12)
    for x in (0.12, 1.66):
        b.block(x, f - 1.85, 0.22, 0.22, 'steel', 0.12)
    b.box(0.55, f - 1.25, 0.9, 0.75, 0.45, 'dark', 0.12)
    b.vdome(1.0, f - 0.95, 0.8, b.top(f - 1.75) - 0.12, 'field', 0.12, 0.3)


def mslo(b):
    # Pad with a team strip, the yellow hatch frame around the dark shaft, the missile's red nose rising out of it.
    f = b.front
    b.box(b.x0, f - 1.0, b.x1 - b.x0, 1.0, 0.1, 'concrete')
    b.box(b.x0, f - 0.12, b.x1 - b.x0, 0.12, 0.03, 'T', 0.1)
    b.box(0.35, f - 0.9, 1.3, 0.72, 0.03, 'yellow', 0.1)
    b.box(0.55, f - 0.8, 0.9, 0.52, 0.01, '#0e0f10', 0.13)
    b.cyl(1.0, f - 0.54, 0.2, b.top(f - 0.74) - 0.14, 'paint', 0.0)
    b.cyl(1.0, f - 0.54, 0.13, 0.14, 'red', b.top(f - 0.74) - 0.14)


ACTORS = {
    'DOME': BuildingSpec(2, 3, dome, second_hidden=True),
    'ATEK': BuildingSpec(2, 3, atek, second_hidden=True),
    'STEK': BuildingSpec(3, 3, stek, second_hidden=True),
    'GAP': BuildingSpec(1, 1, gap),
    'PDOX': BuildingSpec(2, 2, pdox),
    'IRON': BuildingSpec(2, 2, iron),
    'MSLO': BuildingSpec(2, 1, mslo, second_hidden=True),
}

ALIASES = {'DOMF': 'DOME', 'ATEF': 'ATEK', 'PDOF': 'PDOX', 'MSLF': 'MSLO'}
