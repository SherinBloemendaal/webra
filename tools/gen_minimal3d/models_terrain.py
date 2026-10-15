"""Terrain tiles of the 3D minimal pack: flat blocky tiles in the pack's colours, one set per biome.

build(biome, archive) -> (files, manifest terrain object). Each class is a row of variant tiles; ore and gems are
grids (columns are density levels, rows are variants) with transparent ground. Features stay a few pixels inside
the tile, so neighbouring tiles never show a seam. Palettes per biome live in PALETTES: temperate is the finished
example; snow and desert follow the same recipe with their own colours."""
import core
from tiles import Rng, Tile, grid, strip

PALETTES = {
    'temperate': {
        'clear': ('#6abe4a', '#7ccf5a', '#5aae3c'),
        'rough': ('#8fae4e', '#a8c45e', '#7a9a40', '#b3a67a'),
        'rock': ('#8a8f96', '#a9aeb5', '#6c7178'),
        'water': ('#3aa0d8', '#6cc4ee', '#2a8cc4'),
        'tree': ('#4c9a3a', '#5fb04a', '#3b8530'),
        'ford': ('#7fc6d8', '#a6dbe8', '#d6c98f'),
    },
    # Snow: drifts in lighter blocks, ice on the water, rock with white caps.
    'snow': {
        'clear': ('#e6eef4', '#f7fbfd', '#d2e0ea'),
        'rough': ('#cfdbe4', '#e6eef4', '#b4c6d4', '#8d99a4'),
        'rock': ('#7f8a98', '#a3aebb', '#5f6a78', '#f7fbfd'),
        'water': ('#5aa6d0', '#a9dcf2', '#3d8ab8', '#d8f2fc'),
        'tree': ('#2f6a52', '#3f8566', '#235140', '#f7fbfd'),
        'ford': ('#a9d4e6', '#d8f2fc', '#c8d4dc'),
    },
    # Desert: dune ripples as lighter bars, dry rock, an oasis of green-blue water, a sandy ford.
    'desert': {
        'clear': ('#dcc48a', '#ead7a0', '#cdb072'),
        'rough': ('#c9a468', '#dcc088', '#b38c52', '#8f6f48'),
        'rock': ('#a07a52', '#c29a6c', '#7e5c3c'),
        'water': ('#28b8b0', '#6fe0d0', '#1a9a98'),
        'tree': ('#6f9a3c', '#8cb84e', '#587e30', '#dcc48a'),
        'ford': ('#7fd0c8', '#a6e6dc', '#e2cd96'),
    },
}


def _scatter(base, light, dark, seed, count, sizes=((2, 2), (3, 2), (3, 3), (4, 2))):
    t = Tile(base)
    r = Rng(seed)
    for i in range(count):
        w, h = sizes[r.int(0, len(sizes) - 1)]
        x, y = r.int(2, 24 - 2 - w), r.int(2, 24 - 2 - h)
        t.block(x, y, w, h, light if i % 2 else dark)
    return t


def _water(pal, seed):
    base, light, dark = pal
    t = Tile(base)
    r = Rng(seed)
    for _ in range(3):
        x, y = r.int(3, 14), r.int(3, 20)
        t.block(x, y, r.int(5, 8), 2, light)
    for _ in range(2):
        x, y = r.int(3, 14), r.int(3, 20)
        t.block(x, y, r.int(4, 6), 2, dark)
    return t


def _rough(pal, seed):
    base, light, dark, stone = pal
    t = _scatter(base, light, dark, seed, 7)
    r = Rng(seed * 7 + 1)
    for _ in range(2):
        t.block(r.int(3, 17), r.int(3, 17), 4, 3, stone)
    return t


def _rock(pal, seed):
    base, light, dark = pal[:3]
    cap = pal[3] if len(pal) > 3 else None
    t = Tile(base)
    r = Rng(seed)
    for _ in range(5):
        w, h = r.int(5, 9), r.int(4, 7)
        x, y = r.int(1, 24 - 1 - w), r.int(1, 24 - 1 - h)
        t.block(x, y, w, h, dark)
        t.block(x, y, w - 1, h - 1, light)
        t.block(x + 1, y + 1, w - 3, h - 3, base)
        if cap:  # a white cap on the lit top of the rock
            t.block(x, y, w - 1, 2, cap)
    return t


def _dunes(pal, seed):
    """Sand with lighter ripple bars (wind lines) and a few darker shadow bars, all inside the tile."""
    base, light, dark = pal
    t = Tile(base)
    r = Rng(seed)
    for i in range(5):
        w = r.int(5, 10)
        x, y = r.int(2, 24 - 2 - w), 2 + i * 4 + r.int(0, 1)
        t.block(x, y, w, 1, light)
        t.block(x + 1, y + 1, w - 2, 1, dark)
    return t


def _drifts(pal, seed):
    """Snow with drifts: lighter blocks with a cool shadow step below them."""
    base, light, dark = pal
    t = Tile(base)
    r = Rng(seed)
    for _ in range(4):
        w, h = r.int(5, 9), r.int(2, 3)
        x, y = r.int(2, 24 - 2 - w), r.int(2, 24 - 3 - h)
        t.block(x, y + h, w, 1, dark)
        t.block(x, y, w, h, light)
    return t


def _ice(pal, seed):
    """Water with ice floes: pale slabs with a bright edge, kept inside the tile."""
    base, light, dark, floe = pal
    t = _water((base, light, dark), seed)
    r = Rng(seed * 5 + 3)
    for _ in range(3):
        w, h = r.int(4, 7), r.int(3, 4)
        x, y = r.int(3, 24 - 3 - w), r.int(3, 24 - 3 - h)
        t.block(x, y + 1, w, h, light)
        t.block(x, y, w, h, floe)
    return t


def _oasis(pal, seed):
    """Bright green-blue water with sparkles and a darker deep patch."""
    base, light, dark = pal
    t = _water(pal, seed)
    r = Rng(seed * 3 + 1)
    t.block(r.int(6, 12), r.int(6, 12), 6, 4, dark)
    for _ in range(2):
        t.block(r.int(3, 19), r.int(3, 19), 2, 1, '#e6fff8')
    return t


def _pine(pal, seed):
    """Snow-dusted trees: dark green blocks with white tops."""
    base, light, dark, snow = pal
    t = _scatter(base, light, dark, seed, 9)
    r = Rng(seed * 11 + 5)
    for _ in range(4):
        t.block(r.int(2, 19), r.int(2, 19), 3, 1, snow)
    return t


def _scrub(pal, seed):
    base, light, dark, sand = pal
    t = Tile(sand)
    r = Rng(seed)
    for i in range(7):
        w, h = r.int(3, 5), r.int(2, 3)
        x, y = r.int(2, 24 - 2 - w), r.int(2, 24 - 2 - h)
        t.block(x, y + 1, w, h, dark)
        t.block(x, y, w, h, light if i % 2 else base)
    return t


def _ore(level, variant, seed=11):
    """Gold nuggets: more and bigger with the density level (0 sparse, 11 dense), on transparent ground."""
    t = Tile()
    r = Rng(seed + variant * 31)
    n = 2 + level
    for i in range(n):
        s = 2 + (1 if (level >= 4 and i % 2) else 0) + (1 if (level >= 9 and i % 3 == 0) else 0)
        x, y = r.int(2, 24 - 2 - s), r.int(2, 24 - 2 - s)
        t.block(x, y + 1, s, s, '#d9962a')
        t.block(x, y, s, s - 1 if s > 2 else s, '#ffd34d')
        if s >= 3:
            t.block(x, y, 1, 1, '#fff0a0')
    return t


def _gems(level, variant, seed=5):
    colours = ('#4a8cf0', '#e84ab0', '#3ad0b0', '#b58cf0')
    t = Tile()
    r = Rng(seed + variant * 13)
    for i in range(2 + level * 2):
        s = 3 if i % 3 else 4
        x, y = r.int(2, 24 - 2 - s), r.int(2, 24 - 2 - s)
        c = colours[(i + variant) % len(colours)]
        t.block(x, y, s, s, c)
        t.block(x, y, 1, 1, '#e0f8ff')
    return t


def tile_rows(biome):
    pal = PALETTES[biome]
    if biome == 'snow':
        return {
            'clear': [_drifts(pal['clear'], 100 + v) for v in range(4)],
            'rough': [_rough(pal['rough'], 200 + v) for v in range(4)],
            'rock': [_rock(pal['rock'], 300 + v) for v in range(4)],
            'water': [_ice(pal['water'], 400 + v) for v in range(4)],
            'tree': [_pine(pal['tree'], 500 + v) for v in range(4)],
            'ford': [_scatter(*pal['ford'], 600 + v, 6) for v in range(4)],
        }
    if biome == 'desert':
        return {
            'clear': [_dunes(pal['clear'], 100 + v) for v in range(4)],
            'rough': [_rough(pal['rough'], 200 + v) for v in range(4)],
            'rock': [_rock(pal['rock'], 300 + v) for v in range(4)],
            'water': [_oasis(pal['water'], 400 + v) for v in range(4)],
            'tree': [_scrub(pal['tree'], 500 + v) for v in range(4)],
            'ford': [_scatter(*pal['ford'], 600 + v, 6) for v in range(4)],
        }
    return {
        'clear': [_scatter(*pal['clear'], 100 + v, 6) for v in range(4)],
        'rough': [_rough(pal['rough'], 200 + v) for v in range(4)],
        'rock': [_rock(pal['rock'], 300 + v) for v in range(4)],
        'water': [_water(pal['water'], 400 + v) for v in range(4)],
        'tree': [_scatter(*pal['tree'], 500 + v, 9) for v in range(4)],
        'ford': [_scatter(*pal['ford'], 600 + v, 6) for v in range(4)],
    }


def build(biome, archive):
    if biome not in PALETTES:
        return {}, None
    files = {}
    terrain = {'biomes': [biome], 'tileSize': 24}
    for name, tiles in tile_rows(biome).items():
        w, h, rgba = strip(tiles)
        path = f'terrain/{biome}-{name}.png'
        files[path] = core.png_bytes(w, h, rgba)
        terrain[name] = path
    w, h, rgba = grid([[_ore(l, v) for l in range(12)] for v in range(4)])
    files[f'terrain/{biome}-ore.png'] = core.png_bytes(w, h, rgba)
    terrain['ore'] = f'terrain/{biome}-ore.png'
    w, h, rgba = grid([[_gems(l, v) for l in range(4)] for v in range(4)])
    files[f'terrain/{biome}-gems.png'] = core.png_bytes(w, h, rgba)
    terrain['gems'] = f'terrain/{biome}-gems.png'
    return files, terrain
