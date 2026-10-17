"""Base and economy buildings: Construction Yard, power plants, refinery, silo (and the fakes that share them).

Retexture of 0.21.0 (design board buildings3d/Retexture): three to six big blocks per structure, its one or two
defining features, one team strip. Coordinates are cells, see core.Building: every model stands on its original
sprite's extent, its front edge on `b.front`, as wide as `b.x0` to `b.x1`, and `b.block` without a height rises to
the top of the original sprite (`b.top`). The bib rows in front are `b.apron`."""
from specs import BuildingSpec


def powr(b):
    # Hall with a team strip on its roof edge and two tapered cooling towers behind it.
    f = b.front
    b.apron()
    b.box(b.x0, f - 1.05, b.x1 - b.x0, 1.05, 0.55, 'wall')
    b.box(b.x0, f - 0.2, b.x1 - b.x0, 0.2, 0.06, 'T', 0.55)
    for x in (0.52, 1.48):
        b.cyl(x, f - 1.42, 0.42, 0.5, 'steel2')
        b.cyl(x, f - 1.42, 0.34, b.top(f - 1.76) - 0.5, 'steel2', 0.5)


def fact(b):
    # Hall with a team strip, an open pad with a half-built block, and the tower crane over both.
    f = b.front
    b.apron()
    b.box(b.x0, f - 1.9, 1.7, 1.9, 0.9, 'wall')
    b.box(b.x0, f - 0.25, 1.7, 0.25, 0.08, 'T', 0.9)
    b.box(1.7, f - 2.5, b.x1 - 1.7, 2.5, 0.08, 'concrete')
    b.box(2.0, f - 1.7, 0.75, 0.9, 0.55, 'yellow', 0.08)
    mast = f - 2.65
    jib_top = b.top(mast)
    b.box(0.3, mast, 0.24, 0.24, jib_top - 0.2, 'yellow')
    b.box(0.2, mast, 2.6, 0.24, 0.2, 'yellow', jib_top - 0.2)


def apwr(b):
    # Long hall with a team strip and two big reactor domes on it.
    f = b.front
    b.apron()
    b.box(b.x0, f - 1.3, b.x1 - b.x0, 1.3, 0.5, 'wall')
    b.box(b.x0, f - 0.2, b.x1 - b.x0, 0.2, 0.06, 'T', 0.5)
    for x in (0.78, 2.22):
        b.vdome(x, f - 1.25, 0.66, b.top(f - 1.25 - 0.27), 'dome')


def proc(b):
    # Smelter hall with a team strip and a chimney, a tall ore tank with gold on top, and ore on the dock in front.
    f = b.front
    b.apron('dirt')
    b.box(b.x0, f - 1.9, 1.95, 1.9, 0.75, 'wall')
    b.box(b.x0, f - 0.22, 1.95, 0.22, 0.06, 'T', 0.75)
    b.block(0.3, f - 2.45, 0.42, 0.42, 'brick')
    b.cyl(2.45, f - 1.05, 0.52, b.top(f - 1.57) - 0.1, 'steel2')
    b.cyl(2.45, f - 1.05, 0.36, 0.1, 'gold', b.top(f - 1.57) - 0.1)
    b.box(0.95, f + 0.25, 1.0, 0.7, 0.14, 'gold')


def silo(b):
    # A squat tank with a team band and a heap of ore on top.
    b.cyl(0.5, 0.5, 0.54, 0.26, 'steel2')
    b.cyl(0.5, 0.5, 0.55, 0.08, 'T', 0.12, 8, False)
    b.cyl(0.5, 0.5, 0.34, b.top(0.12) - 0.26, 'gold', 0.26)


ACTORS = {
    # WebRA animates the stack smoke on top of POWR today: the pack's body shows the towers itself, so hide that layer.
    'POWR': BuildingSpec(2, 3, powr, second_hidden=True),
    'APWR': BuildingSpec(3, 3, apwr, second_hidden=True),
    'PROC': BuildingSpec(3, 4, proc, second_hidden=True),
    'FACT': BuildingSpec(3, 4, fact, second_hidden=True),
    'SILO': BuildingSpec(1, 1, silo),
}

# The fakes look like the real thing.
ALIASES = {'FPWR': 'POWR', 'FAPW': 'APWR', 'FACF': 'FACT'}
