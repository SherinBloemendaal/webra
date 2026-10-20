"""Terrain tiles of the 3D minimal pack: flat blocky tiles in the pack's colours, one set per biome.

Retexture of 0.21.0: flat tiles in the colours the 2D minimal art shares, water as one flat colour with a ripple,
ore and gems as two blocks per cell, trees as two blocks. A tile does not know its neighbours, so water cannot show
a bank one step lower: that needs neighbour-aware variants, a possible later extension of the pack format.

build(biome, archive) -> (files, manifest terrain object). Each class is a row of variant tiles; ore and gems are
grids (columns are density levels, rows are variants) with transparent ground. Features stay a few pixels inside
the tile, so neighbouring tiles never show a seam. The colours per biome are the shared palette's `terrain`."""
import core
from tiles import Rng, Tile, grid, strip

# The tile colours per biome come from the table the 2D minimal art shares (apps/game/js/art/shared-palette.js).
BIOMES = ('temperate', 'snow', 'desert')


def _shade(c, k):
    """A colour k times as bright (darker below 1), for the one-step-lower edges and the block sides."""
    r, g, b = core.hex_rgb(c)
    return tuple(max(0, min(255, int(v * k + 0.5))) for v in (r, g, b))


def _clear(t, v):
    """Flat ground: variants alternate the two ground tones."""
    return Tile(t['clear'] if v % 2 == 0 else t['clearAlt'])


def _rough(t, v):
    """Rough ground: flat ground with two stones."""
    tile = Tile(t['rough'])
    r = Rng(200 + v)
    for _ in range(2):
        x, y = r.int(3, 14), r.int(3, 14)
        tile.block(x, y + 2, 6, 5, _shade(t['roughStone'], 0.75))
        tile.block(x, y, 6, 5, t['roughStone'])
    return tile


def _rock(t, v):
    """Rock: two big blocks, lit on top, a darker side below."""
    tile = Tile(t['rockDark'])
    r = Rng(300 + v)
    for _ in range(2):
        w, h = r.int(8, 12), r.int(6, 9)
        x, y = r.int(1, 24 - 1 - w), r.int(1, 24 - 3 - h)
        tile.block(x, y + 2, w, h, t['rock'])
        tile.block(x, y, w, h, t['rockLight'])
    return tile


def _water(t, v):
    """Water: a flat colour with one lighter ripple block."""
    tile = Tile(t['water'])
    r = Rng(400 + v)
    tile.block(r.int(3, 12), r.int(4, 18), r.int(6, 9), 2, t['waterLight'])
    return tile


def _tree(t, v):
    """Trees seen from above: two blocks, the crown and its darker side."""
    tile = Tile(t['clear'])
    r = Rng(500 + v)
    x, y = r.int(3, 6), r.int(3, 6)
    tile.block(x + 3, y + 3, 14, 14, t['treeDark'])
    tile.block(x, y, 14, 14, t['tree'])
    return tile


def _ford(t, v):
    """A ford: shallow water with a sandy bank across it."""
    tile = Tile(t['ford'])
    r = Rng(600 + v)
    tile.block(0, r.int(6, 14), 24, 5, t['fordBank'])
    return tile


def tile_rows(biome):
    t = core.SHARED['terrain'][biome]
    return {name: [fn(t, v) for v in range(4)] for name, fn in
            (('clear', _clear), ('rough', _rough), ('rock', _rock), ('water', _water), ('tree', _tree), ('ford', _ford))}


def _ore(t, level, variant):
    """Ore: two blocks per cell that grow with the density level (0 sparse, 11 dense), on transparent ground."""
    tile = Tile()
    r = Rng(11 + variant * 31)
    s = 4 + level // 2
    for k in range(2):
        x = r.int(2, 24 - 2 - s) if k == 0 else min(24 - 2 - s, max(2, 12 + r.int(-3, 3)))
        y = r.int(2, 10 - min(6, s // 2)) if k == 0 else r.int(12, 24 - 2 - s)
        tile.block(x, y + 2, s, s, t['oreDark'])
        tile.block(x, y, s, s, t['ore'])
    return tile


def _gems(t, level, variant):
    """Gems: two blocks per cell in two of the gem colours, bigger with the density level."""
    tile = Tile()
    r = Rng(5 + variant * 13)
    s = 5 + level * 2
    cols = t['gems']
    for k in range(2):
        c = cols[(k + variant) % len(cols)]
        x = r.int(2, 24 - 2 - s)
        y = r.int(2, 10 - min(5, s // 2)) if k == 0 else r.int(12, 24 - 2 - s)
        tile.block(x, y + 2, s, s, _shade(c, 0.7))
        tile.block(x, y, s, s, c)
    return tile


def build(biome, archive):
    if biome not in BIOMES:
        return {}, None
    t = core.SHARED['terrain'][biome]
    files = {}
    terrain = {'biomes': [biome], 'tileSize': 24}
    for name, tiles in tile_rows(biome).items():
        w, h, rgba = strip(tiles)
        path = f'terrain/{biome}-{name}.png'
        files[path] = core.png_bytes(w, h, rgba)
        terrain[name] = path
    w, h, rgba = grid([[_ore(t, l, v) for l in range(12)] for v in range(4)])
    files[f'terrain/{biome}-ore.png'] = core.png_bytes(w, h, rgba)
    terrain['ore'] = f'terrain/{biome}-ore.png'
    w, h, rgba = grid([[_gems(t, l, v) for l in range(4)] for v in range(4)])
    files[f'terrain/{biome}-gems.png'] = core.png_bytes(w, h, rgba)
    terrain['gems'] = f'terrain/{biome}-gems.png'
    return files, terrain
