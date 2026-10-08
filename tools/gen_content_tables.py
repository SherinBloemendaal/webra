#!/usr/bin/env python3
"""Generate apps/game/js/content/tables.js: what the original graphics are made of.

WebRA never ships Red Alert graphics. When the player installs them from their
own copy (apps/game/js/content/install.js), these tables say which files to
keep and how to cut them into sprites, the way OpenRA does it.

Input (OpenRA mods/ra, GPL-3.0, copied into data/source, see data/CATALOG.md):
- data/source/sequences/*.yaml: sprite sequences per image (OpenRA
  ClassicTilesetSpecificSpriteSequence): file, start, length, facings, tick,
  offset, shadow start, tileset specific file names.
- data/source/rules/*.yaml: RenderSprites Image overrides (fakes and variants
  that borrow another actor's art).
- data/source/tilesets/*.yaml: the terrain type of every tile of every
  template, used to pick templates for WebRA's terrain types.
- engine/rules.json: the actors WebRA has (id, kind, turret, harvester).

Output:
- SEQUENCES[image][sequence] = normalized sequence fields (see SequenceDef in
  apps/game/js/content/sequences.js).
- ACTOR_ART[actor id] = { image, body: {pose: sequence}, second: {pose:
  sequence} | null, wall?, cameo }: which sequence each pose of the engine's
  body slot (2t) and second slot (2t + 1: turret, or prone for infantry) uses.
- TERRAIN[tileset] = { palette, images: [file], tiles: [[image, tile, class,
  n, e, s, w, pure]] }: single tiles of the RA templates with their terrain
  class and the classes of their neighbours inside the template.
- TREES: tree images (decorations) composited onto tree cells.
- RESOURCES: ore and gem overlay sequences (misc.yaml "resources").
- GRAPHICS_FILES: every file name the tables can use (what the installer keeps).

Run: python3 tools/gen_content_tables.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'source')
OUT = os.path.join(ROOT, 'apps', 'game', 'js', 'content', 'tables.js')
RULES_JSON = os.path.join(ROOT, 'engine', 'rules.json')
OPENRA_COMMIT = 'b6fc03fcfaef1277592bbd4cbc7d44dd85219902'
SEQUENCE_FILES = ['ships', 'vehicles', 'structures', 'infantry', 'aircraft', 'misc', 'decorations']

# OpenRA tilesets WebRA biomes can use, and their palettes (mods/ra/rules/palettes.yaml).
TILESETS = {
    'TEMPERAT': {'file': 'temperat', 'palette': 'temperat.pal'},
    'SNOW': {'file': 'snow', 'palette': 'snow.pal'},
    'DESERT': {'file': 'desert', 'palette': 'desert.pal'},
}
# Actors are drawn with the "player" palette, which is temperat.pal on every tileset.
ACTOR_PALETTE = 'temperat.pal'

# Template categories whose single tiles make sense on their own.
TILE_CATEGORIES = {'Terrain', 'Debris', 'Cliffs', 'Water Cliffs', 'Beach'}
# Terrain class per OpenRA terrain type: L land, R rough land, K rock, W water.
CLASS = {
    'Clear': 'L',
    'Beach': 'L',
    'Road': 'L',
    'Ore': 'L',
    'Gems': 'L',
    'Rough': 'R',
    'Rock': 'K',
    'Water': 'W',
    'River': 'W',
}
TREES = ['t01', 't02', 't03', 't05', 't06', 't07', 't08', 't10', 't11', 't12', 't13', 't14', 't15', 't16', 't17']

sys.path.insert(0, SRC)
import parse  # noqa: E402 (data/source/parse.py: MiniYaml parser and inheritance)

# Sequence fields this tool understands; anything else on a used sequence is an error.
KNOWN_FIELDS = {
    'Filename', 'TilesetFilenames', 'Start', 'Length', 'Stride', 'Facings', 'Tick', 'ZOffset', 'ShadowStart', 'Frames',
    'Reverses', 'Transpose', 'Offset', 'UseClassicFacings', 'InterpolatedFacings', 'ZRamp', 'BlendMode', 'IgnoreWorldTint',
}


def wdist(text):
    """OpenRA WDist ("-1c511", "512", "1c0") in world units."""
    s = text.strip()
    neg = s.startswith('-')
    if neg:
        s = s[1:]
    if 'c' in s:
        cells, rest = s.split('c', 1)
        v = int(cells or 0) * 1024 + int(rest or 0)
    else:
        v = int(s)
    return -v if neg else v


def load_sequences():
    defs = parse.load('sequences', SEQUENCE_FILES)
    return parse.resolve_all(defs)


def field(data, defaults, key):
    if key in data:
        return data[key]
    if key in defaults:
        return defaults[key]
    return None


def normalize(image, name, tree):
    """One sequence of an image as compact JSON-friendly fields."""
    defaults = tree.get('Defaults', ['', {}])[1]
    if name not in tree:
        return None
    data = tree[name][1]
    for key in list(data) + list(defaults):
        if key not in KNOWN_FIELDS:
            raise SystemExit(f'{image}.{name}: unsupported sequence field {key}')
    out = {}
    fn = field(data, defaults, 'Filename')
    out['file'] = (fn[0] or '').lower()
    ts = field(data, defaults, 'TilesetFilenames')
    if ts and ts[1]:
        out['tilesets'] = {k: v.lower() for k, (v, _) in ts[1].items() if v}

    def num(key, default):
        v = field(data, defaults, key)
        return int(v[0]) if v and v[0] != '' else default

    out['start'] = num('Start', 0)
    length = field(data, defaults, 'Length')
    if length and length[0] == '*':
        out['length'] = -1
    else:
        out['length'] = num('Length', 1)
    stride = field(data, defaults, 'Stride')
    if stride and stride[0] != '':
        out['stride'] = int(stride[0])
    out['facings'] = num('Facings', 1)
    out['tick'] = num('Tick', 40)
    z = field(data, defaults, 'ZOffset')
    if z and z[0]:
        out['zOffset'] = wdist(z[0])
    shadow = num('ShadowStart', -1)
    if shadow >= 0:
        out['shadowStart'] = shadow
    frames = field(data, defaults, 'Frames')
    if frames and frames[0]:
        out['frames'] = [int(x) for x in frames[0].split(',')]
    for key, flag in [('Reverses', 'reverses'), ('Transpose', 'transpose'), ('UseClassicFacings', 'classic')]:
        v = field(data, defaults, key)
        if v and v[0].lower() == 'true':
            out[flag] = True
    ifc = num('InterpolatedFacings', 0)
    if ifc:
        out['interpolatedFacings'] = ifc
    offset = field(data, defaults, 'Offset')
    if offset and offset[0]:
        parts = [int(float(x)) for x in offset[0].split(',')]
        if parts[:2] != [0, 0]:
            out['offset'] = parts[:2]
    if out['facings'] == 0 or abs(out['facings']) & (abs(out['facings']) - 1):
        raise SystemExit(f'{image}.{name}: Facings must be a power of two')
    return out


def actor_images():
    """WebRA actor id -> OpenRA image name (RenderSprites Image or the lowercased id)."""
    out = {}
    for name, tree in parse.rules.items():
        img = None
        for k, (_v, ch) in tree.items():
            if k == 'RenderSprites' or k.startswith('RenderSprites@'):
                img = ch.get('Image', [None])[0] or img
        out[name.upper()] = (img or name).lower()
    return out


def actor_art(actors, seqs):
    images = actor_images()
    used = {}
    art = {}

    def use(image, name):
        if image not in seqs or name not in seqs[image]:
            return None
        rec = normalize(image, name, seqs[image])
        used.setdefault(image, {})[name] = rec
        return name

    def poses(image, mapping):
        out = {}
        for pose, name in mapping.items():
            got = use(image, name)
            if got:
                out[pose] = got
        return out

    for a in actors:
        aid = a['id']
        kind = a['kind']
        if kind == 'mine':
            continue
        image = images.get(aid.upper(), aid.lower())
        if image not in seqs:
            continue
        entry = {'image': image}
        if kind == 'building':
            wall = a.get('_wall', False)
            entry['body'] = poses(image, {'idle': 'idle', 'damaged': 'damaged-idle', **({} if wall else {'make': 'make'})})
            if wall:
                entry['wall'] = True
            entry['second'] = poses(image, {'idle': 'turret', 'damaged': 'damaged-turret'}) if a['turret'] else {}
        elif kind == 'infantry':
            entry['body'] = poses(image, {'idle': 'stand', 'move': 'run', 'attack': 'shoot'})
            entry['second'] = poses(image, {'idle': 'prone-stand', 'move': 'prone-run', 'attack': 'prone-shoot'})
        else:
            mapping = {'idle': 'idle'}
            if a.get('harvester'):
                mapping.update({'harvest': 'harvest', 'dock': 'dock-loop'})
            entry['body'] = poses(image, mapping)
            entry['second'] = poses(image, {'idle': 'turret'}) if a['turret'] else {}
        if 'idle' not in entry['body']:
            continue
        fake = aid.upper() != image.upper() and kind == 'building' and use(image, 'fake-icon')
        cameo = 'fake-icon' if fake else use(image, 'icon')
        if cameo:
            entry['cameo'] = cameo
        art[aid] = entry
    return art, used


def terrain_tables():
    out = {}
    for tid, info in TILESETS.items():
        with open(os.path.join(SRC, 'tilesets', info['file'] + '.yaml')) as f:
            root = parse.parse_miniyaml(f.read())
        images = []
        index = {}
        tiles = []
        for _key, (_v, ch) in root['Templates'][1].items():
            cats = {c.strip() for c in ch.get('Categories', [''])[0].split(',')}
            if not cats & TILE_CATEGORIES:
                continue
            img = ch['Images'][0].split(',')[0].strip().lower()
            w, h = (int(x) for x in ch['Size'][0].split(','))
            types = {int(k): v for k, (v, _) in ch.get('Tiles', ['', {}])[1].items()}
            pick_any = ch.get('PickAny', ['False'])[0].lower() == 'true'
            if not types:
                continue
            classes = {i: CLASS.get(t) for i, t in types.items()}
            if pick_any:
                # Variants of one cell (clear1.tem): every tile stands alone.
                cells = [(i, classes[i], '????') for i in sorted(classes) if classes[i]]
                pure = True
            else:
                cells = []
                uniform = len(set(classes.values())) == 1 and None not in classes.values() and len(classes) == w * h
                pure = uniform and bool(cats & {'Terrain', 'Debris'})
                for i, cls in sorted(classes.items()):
                    if not cls:
                        continue
                    x, y = i % w, i // w
                    sig = ''
                    for dx, dy in [(0, -1), (1, 0), (0, 1), (-1, 0)]:
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and classes.get(ny * w + nx):
                            n = classes[ny * w + nx]
                            sig += 'L' if n == 'R' else n
                        else:
                            sig += '?'
                    cells.append((i, cls, sig))
            if img not in index:
                index[img] = len(images)
                images.append(img)
            for i, cls, sig in cells:
                tiles.append([index[img], i, cls, sig, 1 if pure else 0])
        out[tid] = {'palette': info['palette'], 'images': images, 'tiles': tiles}
    return out


def main():
    with open(RULES_JSON) as f:
        rules = json.load(f)
    seqs = load_sequences()
    walls = set()
    for name, tree in parse.rules.items():
        if any(k == 'LineBuild' or k.startswith('LineBuild@') for k in tree) and any(k.startswith('WithWallSpriteBody') for k in tree):
            walls.add(name.upper())
    actors = []
    for a in rules['actors']:
        actors.append({
            'id': a['id'],
            'kind': a['kind'],
            'turret': a.get('turret_turn_speed') is not None,
            'harvester': bool(a.get('unit') and a['unit'].get('harvester')),
            '_wall': a['id'].upper() in walls,
        })
    art, used = actor_art(actors, seqs)

    trees = {}
    for t in TREES:
        if t in seqs and 'idle' in seqs[t]:
            trees[t] = normalize(t, 'idle', seqs[t])
    resources = {'ore': [], 'gems': []}
    res = seqs.get('resources')
    if not res:
        raise SystemExit('misc.yaml has no resources image')
    for name in ['gold01', 'gold02', 'gold03', 'gold04']:
        resources['ore'].append(normalize('resources', name, res))
    for name in ['gem01', 'gem02', 'gem03', 'gem04']:
        if name in res:
            resources['gems'].append(normalize('resources', name, res))
    terrain = terrain_tables()

    files = {ACTOR_PALETTE}
    for info in terrain.values():
        files.add(info['palette'])
        files.update(info['images'])

    def add_seq(rec):
        files.add(rec['file'])
        for tid, fn in rec.get('tilesets', {}).items():
            if tid in TILESETS:
                files.add(fn)

    for image in used.values():
        for rec in image.values():
            add_seq(rec)
    for rec in trees.values():
        add_seq(rec)
    for rec in resources['ore'] + resources['gems']:
        add_seq(rec)
    files.discard('')

    def js(v):
        return json.dumps(v, separators=(',', ':'), sort_keys=True)

    lines = [
        '// GENERATED by tools/gen_content_tables.py, do not edit.',
        f'// Source: OpenRA mods/ra sequences, rules and tilesets at commit {OPENRA_COMMIT}',
        '// (GPL-3.0, copied into data/source) and engine/rules.json. Names only: the',
        "// graphics themselves come from the player's own copy of Red Alert.",
        '',
        f"export const OPENRA_COMMIT = '{OPENRA_COMMIT}';",
        '',
        '/** The palette actors are drawn with on every tileset (OpenRA "player"). */',
        f"export const ACTOR_PALETTE = '{ACTOR_PALETTE}';",
        '',
        '/** Sequences per OpenRA image, only those WebRA uses (content/sequences.js SequenceDef). */',
        'export const SEQUENCES = {',
    ]
    for image in sorted(used):
        lines.append(f'  {json.dumps(image)}: {js(used[image])},')
    lines += [
        '};',
        '',
        '/** Per WebRA actor: OpenRA image, sequence per pose of the body and second slot, wall, cameo. */',
        'export const ACTOR_ART = {',
    ]
    for aid in sorted(art):
        lines.append(f'  {json.dumps(aid)}: {js(art[aid])},')
    lines += [
        '};',
        '',
        '/**',
        ' * Single tiles of the RA templates per tileset: [image index, tile index,',
        ' * class, neighbours (north, east, south, west), pure]. Classes: L land,',
        ' * R rough, K rock, W water; neighbours "?" lie outside the template.',
        ' * Pure tiles come from a template of one class (plain ground, water, debris).',
        ' */',
        'export const TERRAIN = {',
    ]
    for tid in sorted(terrain):
        info = terrain[tid]
        lines.append(f'  {tid}: {{')
        lines.append(f"    palette: {json.dumps(info['palette'])},")
        lines.append(f"    images: {js(info['images'])},")
        lines.append(f"    tiles: {js(info['tiles'])},")
        lines.append('  },')
    lines += [
        '};',
        '',
        '/** Tree images (decorations.yaml) drawn onto WebRA tree cells. */',
        f'export const TREES = {js(trees)};',
        '',
        '/** Ore and gem overlays (misc.yaml resources): one sequence per variant, a frame per density. */',
        f'export const RESOURCES = {js(resources)};',
        '',
        '/** Every file name the tables refer to: what the installer keeps from the player\'s files. */',
        f'export const GRAPHICS_FILES = {js(sorted(files))};',
        '',
    ]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write('\n'.join(lines))
    print(f'wrote {os.path.relpath(OUT, ROOT)}: {len(art)} actors, {len(used)} images, {len(files)} files')


if __name__ == '__main__':
    main()
