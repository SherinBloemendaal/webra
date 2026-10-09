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
- data/source/bits.txt: the files OpenRA makes and ships itself (mods/ra/bits).
  A player's own copy of Red Alert never has them, so every sequence that uses
  one is mapped to the original file it stands in for (ORIGINAL_FILES,
  ORIGINAL_SEQUENCES), kept when the original has the same frame layout
  (SAME_LAYOUT), or left out. A bits file nobody decided about is an error.
- engine/rules.json: the actors WebRA has (id, kind, turret, harvester).

Output:
- SEQUENCES[image][sequence] = normalized sequence fields (see SequenceDef in
  apps/game/js/content/sequences.js).
- ACTOR_ART[actor id] = { image, body: {pose: sequence}, second: {pose:
  sequence} | null, wall?, overlay?, bib?, cameo }: which sequence each pose of
  the engine's body slot (2t) and second slot (2t + 1: turret, prone for
  infantry, or the layer drawn over a structure: `overlay` names its kind,
  "door" for OpenRA WithProductionDoorOverlay) uses; `bib` is the
  WithBuildingBib sequence drawn under the structure.
- TERRAIN[tileset] = { palette, rotation, images: [file], templates: [[image,
  width, height, role, cells]] }: the templates the tile terrain uses, by role
  (TERRAIN_ROLES), with the cells of the template that have a tile.
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

# Smudge images (world.yaml SmudgeLayer@SCORCH and @CRATER): one sequence per
# variant, a frame per depth (engine/src/smudges.rs).
SMUDGE_IMAGES = {'scorch': 'scorches', 'crater': 'craters'}
# The leftover specials (engine/src/husks.rs LEFTOVER_*, same order): husk and
# scorch fire, crater smoke, the PRIMARY tag and the crate pickup animations.
LEFTOVER_ART = [('fire', '1'), ('smoke_m', 'idle'), ('pips', 'tag-primary'), ('crate-effects', 'levelup'), ('crate-effects', 'heal'),
                ('crate-effects', 'hide-map'), ('crate-effects', 'reveal-map'), ('crate-effects', 'invuln')]

TREES = ['t01', 't02', 't03', 't05', 't06', 't07', 't08', 't10', 't11', 't12', 't13', 't14', 't15', 't16', 't17']

# OpenRA RotationPaletteEffect (mods/ra/rules/palettes.yaml): the terrain
# palette indices that cycle to animate water, per tileset.
WATER_ROTATION = {'TEMPERAT': [96, 7], 'SNOW': [96, 7], 'DESERT': [32, 7]}

# What the tile terrain (apps/game/js/content/terrain.js) draws WebRA's
# terrain classes with, per tileset: template image names by role. clear:
# plain ground variants; water: open water; shore: beaches (the runtime
# matches their tiles to the coastline by their pixels); rough: loose stones
# on open ground; rock: boulders on open ground (impassable); water-rock:
# rocks standing in water. Templates made by OpenRA (bits.txt) are left out.
TERRAIN_ROLES = {
    'TEMPERAT': {
        'clear': ['clear1'],
        'water': ['w1', 'w2'],
        'shore': 'Beach',
        'rough': ['rf01', 'rf02', 'rf03', 'rf04', 'rf05', 'rf06', 'rf07', 'rf08', 'rf09', 'rf10', 'rf11'],
        'rock': ['b1', 'b2', 'b3'],
        'water-rock': ['sh55', 'sh56'],
    },
    'SNOW': {
        'clear': ['clear1'],
        'water': ['w1', 'w2'],
        'shore': 'Beach',
        'rough': ['rf01', 'rf02', 'rf03', 'rf04', 'rf05', 'rf06', 'rf07', 'rf08', 'rf09', 'rf10', 'rf11'],
        'rock': ['b1', 'b2', 'b3'],
        'water-rock': ['sh55', 'sh56'],
    },
    'DESERT': {
        'clear': ['clear1'],
        'water': ['sh17', 'sh18'],
        'shore': 'Beach',
        'rough': ['p01', 'p02', 'p03', 'p07'],
        'rock': ['p04'],
        'water-rock': [],
    },
}

# OpenRA's own files (bits.txt) -> the original Red Alert file with the same
# frame layout that a player's copy has (OpenRA added shadows, remap or
# theater variants to these).
ORIGINAL_FILES = {
    'tent.tem': 'tent.shp',
    'tent.sno': 'tent.shp',
    'tent.des': 'tent.shp',
    'tentmake.tem': 'tentmake.shp',
    'tentmake.sno': 'tentmake.shp',
    'tentmake.des': 'tentmake.shp',
    'hbox.des': 'hbox.tem',
    'hboxmake.des': 'hboxmake.tem',
    'mslo.des': 'mslo.tem',
    'mslomake.des': 'mslomake.tem',
    'sam2.shp': 'sam.shp',
    'silo2.shp': 'silo.shp',
    'afldidle.shp': 'afld.shp',
    'tran2.shp': 'tran.shp',
    'msloicon2.shp': 'msloicon.shp',
    # Husks of the ore truck and the MCV: Red Alert has none, OpenRA draws
    # them; the vehicles' own frames (32 facings first in both) stand in, and
    # the engine darkens them like OpenRA's husks (engine/src/husks.rs).
    'hhusk.shp': 'harv.shp',
    'hhusk2.shp': 'harv.shp',
    'mcvhusk.shp': 'mcv.shp',
    # Smudges OpenRA made a snow version of: the temperate original.
    'cr4.sno': 'cr4.tem',
    'cr5.sno': 'cr5.tem',
    'sc4.sno': 'sc4.tem',
}
# Sequences whose OpenRA file has another layout than the original one.
ORIGINAL_SEQUENCES = {
    # weap3.shp has ten door frames; the original weap2.shp has four, then four damaged ones.
    ('weap', 'build-top'): {'file': 'weap2.shp', 'start': 0, 'length': 4},
    # Crates: OpenRA's scrate.shp and wcrate.shp hold idle, land and water
    # frames; Red Alert's overlays (SCRATE, WCRATE, WWCRATE in its source) are
    # a crate on land each and the crate in water.
    ('scrate', 'idle'): {'file': 'scrate.shp', 'start': 0, 'length': 1},
    ('scrate', 'land'): {'file': 'scrate.shp', 'start': 0, 'length': 1},
    ('scrate', 'water'): {'file': 'wwcrate.shp', 'start': 0, 'length': -1},
    ('wcrate', 'idle'): {'file': 'wcrate.shp', 'start': 0, 'length': 1},
    ('wcrate', 'land'): {'file': 'wcrate.shp', 'start': 0, 'length': 1},
}
# OpenRA's files with no original counterpart: sequences using them are left
# out (fake structures show the real cameo, OpenRA's own units keep WebRA art,
# small bibs and the refinery top are not drawn).
NO_ORIGINAL = {
    'ateficon.shp', 'fapwicon.shp', 'fixficon.shp', 'fpwricon.shp', 'mslficon.shp', 'pdoficon.shp', 'tenficon.shp',
    'ftrk.shp', 'ftrkicon.shp', 'mh60.shp', 'mh60icon.shp', 'proctop.shp',
    # Crate pickup animations OpenRA drew (crate-effects levelup and heal): WebRA art.
    'levelup.shp', 'invun.shp',
} | {f'mb{b}.{ext}' for b in ['agun', 'fix', 'ftur', 'gap', 'gun', 'hosp', 'iron', 'pbox', 'pdox', 'sam', 'silo', 'tsla'] for ext in ['tem', 'sno', 'int', 'des']}
# OpenRA's files that replace an original of the same name and frame layout
# (shadows or touch-ups): the player's original works with the same sequence.
SAME_LAYOUT = {
    'fact.shp', 'factmake.shp', 'gap.shp', 'gapmake.shp', 'harv.shp', 'heli.shp', 'hind.shp', 'mgg.shp',
    'silomake.shp', 'truk.shp', 'yak.shp', 'stnkicon.shp',
}

sys.path.insert(0, SRC)
import parse  # noqa: E402 (data/source/parse.py: MiniYaml parser and inheritance)

# Sequence fields this tool understands; anything else on a used sequence is an error.
KNOWN_FIELDS = {
    'Filename', 'TilesetFilenames', 'Start', 'Length', 'Stride', 'Facings', 'Tick', 'ZOffset', 'ShadowStart', 'Frames',
    'Reverses', 'Transpose', 'Offset', 'UseClassicFacings', 'InterpolatedFacings', 'ZRamp', 'BlendMode', 'IgnoreWorldTint',
}


def load_bits():
    with open(os.path.join(SRC, 'bits.txt')) as f:
        return {line.strip().lower() for line in f if line.strip() and not line.startswith('#')}


BITS = load_bits()


def original_file(fn, where):
    """The file a player's copy has for `fn` (None: there is none)."""
    if fn not in BITS or fn in SAME_LAYOUT:
        return fn
    if fn in ORIGINAL_FILES:
        return ORIGINAL_FILES[fn]
    if fn in NO_ORIGINAL:
        return None
    raise SystemExit(f'{where}: {fn} is made by OpenRA (data/source/bits.txt); map it to an original file or list it in NO_ORIGINAL')


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
    return to_original(image, name, out)


def to_original(image, name, out):
    """The sequence on the original files (see ORIGINAL_FILES), or None when they cannot draw it."""
    if (image, name) in ORIGINAL_SEQUENCES:
        out.update(ORIGINAL_SEQUENCES[(image, name)])
        out.pop('tilesets', None)
        return out
    fn = original_file(out['file'], f'{image}.{name}')
    if fn is None:
        return None
    out['file'] = fn
    if 'tilesets' in out:
        tilesets = {}
        for tid, tfn in out['tilesets'].items():
            o = original_file(tfn, f'{image}.{name}')
            if o is None:
                return None
            if o != fn:
                tilesets[tid] = o
        if tilesets:
            out['tilesets'] = tilesets
        else:
            del out['tilesets']
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


def rules_of(aid):
    """The resolved OpenRA rules of an actor id (case-insensitive), or {}."""
    for name, tree in parse.rules.items():
        if name.upper() == aid.upper():
            return tree
    return {}


def trait(tree, name):
    """The children of a trait (first instance), or None."""
    for k, (_v, ch) in tree.items():
        if k == name or k.startswith(name + '@'):
            return ch
    return None


def actor_art(actors, seqs):
    images = actor_images()
    used = {}
    art = {}

    def use(image, name):
        if image not in seqs or name not in seqs[image]:
            return None
        rec = normalize(image, name, seqs[image])
        if rec is None:
            return None
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
            tree = rules_of(aid)
            door = trait(tree, 'WithProductionDoorOverlay')
            if door is not None and not a['turret']:
                seq = door.get('Sequence', ['build-top'])[0]
                second = poses(image, {'idle': seq, 'damaged': 'damaged-' + seq})
                if 'idle' in second:
                    entry['second'] = second
                    entry['overlay'] = 'door'
            bib = trait(tree, 'WithBuildingBib')
            if bib is not None and bib.get('HasMinibib', ['False'])[0].lower() != 'true':
                got = use(image, bib.get('Sequence', ['bib'])[0])
                if got:
                    entry['bib'] = got
        elif kind == 'crate':
            # The crate on land (body) and in water (second slot), OpenRA WithCrateBody.
            entry['body'] = poses(image, {'idle': 'land'})
            entry['second'] = poses(image, {'idle': 'water'})
        elif kind == 'husk':
            entry['body'] = poses(image, {'idle': 'idle'})
            entry['second'] = {}
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
    """Templates per tileset by role (TERRAIN_ROLES); OpenRA's own templates (bits.txt) left out."""
    out = {}
    for tid, info in TILESETS.items():
        with open(os.path.join(SRC, 'tilesets', info['file'] + '.yaml')) as f:
            root = parse.parse_miniyaml(f.read())
        roles = TERRAIN_ROLES[tid]
        by_name = {}
        beach = []
        for _key, (_v, ch) in root['Templates'][1].items():
            img = ch['Images'][0].split(',')[0].strip().lower()
            if img in BITS:
                continue
            w, h = (int(x) for x in ch['Size'][0].split(','))
            cells = sorted(int(k) for k in ch.get('Tiles', ['', {}])[1])
            if not cells:
                continue
            tpl = (img, w, h, cells)
            by_name.setdefault(img.rsplit('.', 1)[0], tpl)
            if 'Beach' in {c.strip() for c in ch.get('Categories', [''])[0].split(',')}:
                beach.append(tpl)
        images = []
        index = {}
        templates = []
        for role, names in roles.items():
            if names == 'Beach':
                chosen = beach
            else:
                chosen = []
                for n in names:
                    if n not in by_name:
                        raise SystemExit(f'TERRAIN_ROLES {tid} {role}: no template {n} (or it is made by OpenRA)')
                    chosen.append(by_name[n])
            for img, w, h, cells in chosen:
                if img not in index:
                    index[img] = len(images)
                    images.append(img)
                templates.append([index[img], w, h, role, cells])
        rot = WATER_ROTATION[tid]
        out[tid] = {'palette': info['palette'], 'rotation': rot, 'images': images, 'templates': templates}
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
    smudges = {}
    for kind, image in SMUDGE_IMAGES.items():
        names = [n for n in seqs[image] if n != 'Defaults']
        smudges[kind] = [normalize(image, n, seqs[image]) for n in names]
    leftovers = [normalize(image, name, seqs[image]) if image in seqs and name in seqs[image] else None for image, name in LEFTOVER_ART]

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
    for rec in [r for v in smudges.values() for r in v] + leftovers:
        if rec:
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
        ' * Terrain templates per tileset (tools/gen_content_tables.py TERRAIN_ROLES):',
        ' * [image index, width, height, role, tile indexes the template has]. Roles:',
        ' * clear, water, shore, rough, rock, water-rock. `rotation` is the first',
        ' * terrain palette index and count that cycle to animate water (OpenRA',
        ' * RotationPaletteEffect).',
        ' */',
        'export const TERRAIN = {',
    ]
    for tid in sorted(terrain):
        info = terrain[tid]
        lines.append(f'  {tid}: {{')
        lines.append(f"    palette: {json.dumps(info['palette'])},")
        lines.append(f"    rotation: {js(info['rotation'])},")
        lines.append(f"    images: {js(info['images'])},")
        lines.append(f"    templates: {js(info['templates'])},")
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
        '/** Scorch marks and craters (misc.yaml scorches, craters): a sequence per variant, a frame per depth; null: no original. */',
        f'export const SMUDGES = {js(smudges)};',
        '',
        '/** Leftover specials (engine husks.rs LEFTOVER_* order): fire, smoke, PRIMARY tag, crate animations; null: WebRA art. */',
        f'export const LEFTOVER_ART = {js(leftovers)};',
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
