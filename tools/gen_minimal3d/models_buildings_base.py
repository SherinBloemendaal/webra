"""Base and economy buildings: Construction Yard, power plants, refinery, silo (and the fakes that share them).

Finished example: POWR (the pattern for the others). Coordinates are cells, see core.Building; the colours are the
palette names of core.P (design boards project/buildings3d)."""
from specs import BuildingSpec


def powr(b):
    # Hall on a concrete apron, team stripes over the roof edges, a lightning sign, two cooling towers with steam.
    b.box(0, 2.2, 2, 0.8, 0.06, 'concrete')
    b.box(0.1, 0.2, 1.8, 1.6, 0.6, 'wall')
    b.box(0.1, 0.2, 1.8, 0.1, 0.04, 'T', 0.6)
    b.box(0.1, 1.7, 1.8, 0.1, 0.04, 'T', 0.6)
    b.flat([(0.66, 1.18), (0.4, 1.48), (0.57, 1.48), (0.46, 1.72), (0.76, 1.4), (0.59, 1.4), (0.72, 1.18)], 0.605, 'yellow')
    b.box(1.2, 1.8, 0.45, 0.04, 0.4, 'yellow')
    for x in (0.55, 1.45):
        b.cyl(x, 0.75, 0.36, 0.5, 'steel2', 0.6)
        b.cyl(x, 0.75, 0.29, 0.35, 'steel2', 1.1)
        b.cyl(x, 0.75, 0.33, 0.15, 'steel2', 1.45)
        b.cyl(x, 0.75, 0.24, 0.01, 'dark', 1.6)
        b.vdome(x, 0.75, 0.3, 0.45, 'steam', 1.66, 0.6)
    # Pylon with insulators and a transformer with two copper coils.
    b.box(0.2, 2.4, 0.06, 0.06, 0.95, 'steel', 0.06)
    b.box(0.02, 2.4, 0.42, 0.06, 0.05, 'steel', 0.95)
    b.box(0.04, 2.38, 0.06, 0.1, 0.08, 'paint', 1.0)
    b.box(0.36, 2.38, 0.06, 0.1, 0.08, 'paint', 1.0)
    b.box(1.1, 2.35, 0.75, 0.5, 0.35, 'dark', 0.06)
    for x in (1.3, 1.65):
        b.cyl(x, 2.5, 0.09, 0.2, 'copper', 0.41)
        b.cyl(x, 2.5, 0.06, 0.04, 'glow', 0.61, emit=True)


def fact(b):
    # Hall with a team-striped roof, an open construction site with scaffold and a half built block, tower crane.
    b.box(0, 3, 3, 1, 0.06, 'concrete')
    b.flat([(1.2, 3.3), (1.5, 3.6), (1.8, 3.3), (1.8, 3.48), (1.5, 3.78), (1.2, 3.48)], 0.061, 'paint')
    b.box(0.1, 0.2, 1.4, 2.7, 0.95, 'wall')
    b.box(0.1, 0.2, 1.4, 0.12, 0.05, 'T', 0.95)
    b.box(0.1, 2.78, 1.4, 0.12, 0.05, 'T', 0.95)
    b.box(0.25, 2.9, 0.9, 0.04, 0.55, 'yellow')
    b.box(1.6, 0.3, 1.3, 2.6, 0.06, 'concrete')
    b.box(1.6, 2.8, 1.3, 0.1, 0.01, 'yellow', 0.06)
    b.box(1.9, 1.0, 0.7, 1.1, 0.42, 'roof', 0.06)
    for x, y in ((1.92, 1.02), (2.55, 1.02), (1.92, 2.04), (2.55, 2.04)):
        b.box(x, y, 0.04, 0.04, 0.22, 'steel', 0.48)
    # Scaffold: four posts joined by rails at the top.
    for x, y in ((1.75, 0.45), (2.65, 0.45), (1.75, 2.55), (2.65, 2.55)):
        b.box(x, y, 0.08, 0.08, 1.0, 'yellow', 0.06)
    b.box(1.75, 0.45, 0.98, 0.08, 0.06, 'yellow', 1.06)
    b.box(1.75, 0.45, 0.08, 2.18, 0.06, 'yellow', 1.06)
    b.box(2.65, 0.45, 0.08, 2.18, 0.06, 'yellow', 1.06)
    b.box(1.75, 2.55, 0.98, 0.08, 0.06, 'yellow', 1.06)
    # Tower crane: mast, team cap, cab, jib, cable and hook.
    b.box(0.3, 0.5, 0.14, 0.14, 1.5, 'yellow', 0.95)
    b.box(0.27, 0.47, 0.2, 0.2, 0.16, 'T', 2.29)
    b.box(0.0, 0.47, 0.3, 0.2, 0.18, 'dark', 2.38)
    b.box(0.0, 0.52, 2.55, 0.1, 0.08, 'yellow', 2.45)
    b.box(2.25, 0.56, 0.02, 0.02, 0.85, 'darker', 1.6)
    b.box(2.14, 0.46, 0.24, 0.22, 0.16, 'wood', 1.44)


def apwr(b):
    # Hall, two reactor domes with glowing rings, coil transformers, lightning sign, steam stack.
    b.box(0, 2.4, 3, 0.6, 0.06, 'concrete')
    b.box(0.1, 0.2, 2.8, 2.1, 0.6, 'wall')
    b.box(0.1, 0.2, 2.8, 0.1, 0.04, 'T', 0.6)
    b.box(0.1, 2.2, 2.8, 0.1, 0.04, 'T', 0.6)
    b.flat([(1.62, 1.72), (1.36, 2.02), (1.54, 2.02), (1.44, 2.26), (1.74, 1.94), (1.56, 1.94), (1.68, 1.72)], 0.605, 'yellow')
    b.box(1.35, 0.45, 0.3, 1.2, 0.25, 'dark', 0.6)
    for y in (0.65, 1.05, 1.45):
        b.cyl(1.5, y, 0.08, 0.22, 'copper', 0.85)
        b.cyl(1.5, y, 0.05, 0.05, 'glow', 1.07, emit=True)
    for x in (0.75, 2.25):
        b.cyl(x, 1.1, 0.58, 0.12, 'glow', 0.6, emit=True)
        b.vdome(x, 1.1, 0.52, 0.85, '#d8e2ea', 0.72)
        b.box(x - 0.08, 1.02, 0.16, 0.16, 0.06, 'T', 1.57)
    b.box(2.6, 0.3, 0.2, 0.2, 0.9, 'steel2', 0.6)
    b.vdome(2.7, 0.4, 0.2, 0.35, 'steam', 1.52, 0.6)
    b.box(1.25, 2.3, 0.5, 0.04, 0.4, 'yellow')
    for x in (0.3, 2.25):
        b.box(x, 2.5, 0.45, 0.35, 0.28, 'dark', 0.06)
        b.cyl(x + 0.22, 2.67, 0.07, 0.18, 'copper', 0.34)
        b.cyl(x + 0.22, 2.67, 0.05, 0.04, 'glow', 0.52, emit=True)


def proc(b):
    # Smelter hall with glowing furnace and chimney, ore tanks, conveyor into a crucible of gold, bars and gems.
    b.box(0, 2.8, 3, 1.2, 0.06, 'concrete')
    b.box(1, 3, 1, 0.6, 0.02, 'dark', 0.06)
    b.vdome(1.5, 3.3, 0.28, 0.2, 'orange', 0.08)
    b.box(0.1, 0.2, 1.8, 2.4, 0.8, 'wall')
    b.box(0.1, 0.2, 1.8, 0.1, 0.04, 'T', 0.8)
    b.box(0.1, 2.5, 1.8, 0.1, 0.04, 'T', 0.8)
    b.gable(0.3, 0.4, 1.4, 1.0, 0.3, 'steel', 0.8, 'x')
    b.band(0.3, 0.4, 1.4, 1.0, 0.3, 0.8, 'x', 'a', 0.3, 0.5, 'T')
    b.box(1.45, 1.6, 0.3, 0.3, 0.75, 'brick', 0.8)
    b.box(1.5, 1.65, 0.2, 0.2, 0.01, 'molten', 1.55, emit=True)
    b.vdome(1.6, 1.75, 0.2, 0.3, '#8a8f96', 1.62, 0.55)
    b.box(0.3, 2.6, 0.6, 0.03, 0.28, 'molten', 0.2, emit=True)
    b.beam((1.5, 3.05, 0.12), (1.3, 2.62, 0.62), 0.24, 'dark')
    # Two ore tanks, lower and slimmer than the board's so the front one does not hide the back one in the 3/4 view.
    for y in (0.65, 1.95):
        b.cyl(2.45, y, 0.4, 0.8, 'steel2')
        b.cyl(2.45, y, 0.27, 0.02, 'orange', 0.8)
        b.cyl(2.45, y, 0.41, 0.1, 'T', 0.55, 8, False)
    for x, y, z in ((0.2, 3.1, 0.06), (0.48, 3.1, 0.06), (0.76, 3.1, 0.06), (0.34, 3.1, 0.16), (0.62, 3.1, 0.16)):
        b.box(x, y, 0.26, 0.15, 0.1, 'gold', z)
    for x, y, c in ((0.35, 3.62, '#4a8cf0'), (0.62, 3.7, '#e84ab0'), (0.88, 3.6, '#3ad0b0')):
        b.cyl(x, y, 0.1, 0.14, c, 0.06, 6)
        b.cyl(x, y, 0.05, 0.06, c, 0.2, 6)
    b.box(2.15, 3.1, 0.6, 0.6, 0.35, 'dark', 0.06)
    b.box(2.25, 3.2, 0.4, 0.4, 0.01, 'molten', 0.41, emit=True)
    b.box(2.0, 3.36, 0.2, 0.08, 0.02, 'molten', 0.06, emit=True)


def silo(b):
    # Octagonal ore tank with a team band and a heap of ore on top.
    b.cyl(0.5, 0.5, 0.4, 0.7, 'steel2')
    b.cyl(0.5, 0.5, 0.41, 0.1, 'T', 0.45, 8, False)
    b.vdome(0.5, 0.5, 0.26, 0.18, 'orange', 0.7)


ACTORS = {
    # WebRA animates the stack smoke on top of POWR today: the pack's body shows the steam itself, so hide that layer.
    'POWR': BuildingSpec(2, 3, powr, second_hidden=True),
    'APWR': BuildingSpec(3, 3, apwr, second_hidden=True),
    'PROC': BuildingSpec(3, 4, proc, second_hidden=True),
    'FACT': BuildingSpec(3, 4, fact, second_hidden=True),
    'SILO': BuildingSpec(1, 1, silo),
}

# The fakes look like the real thing.
ALIASES = {'FPWR': 'POWR', 'FAPW': 'APWR', 'FACF': 'FACT'}
