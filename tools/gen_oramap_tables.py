#!/usr/bin/env python3
"""Generate apps/game/js/oramap/tables.js: lookup tables for the .oramap importer.

Input (OpenRA mods/ra, copied into data/source, see data/CATALOG.md):
- data/source/tilesets/{temperat,snow,desert,interior}.yaml: the terrain type
  of every tile of every template, per tileset.
- data/source/rules/world.yaml and civilian.yaml: the bridges OpenRA's
  LegacyBridgeLayer makes from the map's bridge templates.

Output, compact:
- TILESETS[tileset id][template id] = tile terrain letters, one per tile index,
  run-length encoded ("c16" = 16 times "c"), "." for an index the template does
  not have. Letters: see ORA_TERRAIN_LETTERS.
- PICK_ANY[tileset id] = template ids with PickAny (index 255 = any tile).
- BRIDGES[tileset id][template id] = [bridge actor id, template width]: the
  templates of every state of every bridge (OpenRA LegacyBridgeLayer turns
  them into bridge actors at the template's top-left cell).
- INHERITS[actor id] = [parent actor id, own keys]: actors that inherit
  another actor (not a ^template), with the "Trait.Field" keys (or "Trait"
  for a trait without fields, "-Trait" for a removal) they set themselves.
  OpenRA resolves inheritance after a map's rules are merged, so a map that
  changes the parent changes these too, except where they set the key.

Run: python3 tools/gen_oramap_tables.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'source')
OUT = os.path.join(ROOT, 'apps', 'game', 'js', 'oramap', 'tables.js')
OPENRA_COMMIT = 'b6fc03fcfaef1277592bbd4cbc7d44dd85219902'
TILESETS = ['temperat', 'snow', 'desert', 'interior']

# One letter per OpenRA RA terrain type (TerrainType@... in the tilesets).
ORA_TERRAIN_LETTERS = {
    'Clear': 'c',
    'ClearNoSmudges': 'c',  # interior: clear floor that takes no craters
    'Rough': 'r',
    'Road': 'd',
    'Rock': 'k',
    'Water': 'w',
    'River': 'v',
    'Tree': 't',
    'Beach': 'b',
    'Bridge': 'g',
    'Wall': 'l',
    'Ore': 'o',
    'Gems': 'm',
}

sys.path.insert(0, SRC)
import parse  # noqa: E402 (data/source/parse.py: MiniYaml parser and inheritance)


def rle(s):
    out = []
    i = 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]:
            j += 1
        n = j - i
        out.append(s[i] + (str(n) if n > 1 else ''))
        i = j
    return ''.join(out)


def tileset_table(name):
    with open(os.path.join(SRC, 'tilesets', name + '.yaml')) as f:
        root = parse.parse_miniyaml(f.read())
    tid = root['General'][1]['Id'][0]
    declared = {ch['Type'][0] for _, ch in root['Terrain'][1].values()}
    unknown = declared - set(ORA_TERRAIN_LETTERS)
    if unknown:
        raise SystemExit(f'{name}: terrain types without a letter: {sorted(unknown)}')
    templates = {}
    pick_any = []
    for _key, (_v, ch) in root['Templates'][1].items():
        template_id = int(ch['Id'][0])
        tiles = {int(k): v for k, (v, _) in ch.get('Tiles', ['', {}])[1].items()}
        if not tiles:
            continue
        letters = ['.'] * (max(tiles) + 1)
        for idx, terrain in tiles.items():
            if terrain not in ORA_TERRAIN_LETTERS:
                raise SystemExit(f'{name}: template {template_id} uses unknown terrain {terrain}')
            letters[idx] = ORA_TERRAIN_LETTERS[terrain]
        templates[template_id] = rle(''.join(letters))
        if ch.get('PickAny', ['False'])[0].lower() == 'true':
            pick_any.append(template_id)
    return tid, dict(sorted(templates.items())), sorted(pick_any)


# OpenRA BridgeInfo template fields: every state's template becomes the bridge.
BRIDGE_TEMPLATE_FIELDS = ['Template', 'DamagedTemplate', 'DestroyedTemplate', 'DestroyedPlusNorthTemplate',
                          'DestroyedPlusSouthTemplate', 'DestroyedPlusBothTemplate']


def bridges():
    """Template id -> [bridge actor id, template width] per tileset id (OpenRA
    LegacyBridgeLayer: the bridges of World's LegacyBridgeLayer.Bridges)."""
    world = parse.load('rules', ['world'])['World'][1]
    names = [x.strip() for x in world['LegacyBridgeLayer'][1]['Bridges'][0].split(',')]
    resolved = parse.rules
    by_name = {k.lower(): k for k in resolved}
    out = {}
    for ts in TILESETS:
        with open(os.path.join(SRC, 'tilesets', ts + '.yaml')) as f:
            root = parse.parse_miniyaml(f.read())
        tid = root['General'][1]['Id'][0]
        widths = {int(ch['Id'][0]): int(ch['Size'][0].split(',')[0]) for _k, (_v, ch) in root['Templates'][1].items()}
        table = {}
        for name in names:
            actor = by_name[name.lower()]
            b = resolved[actor]['Bridge'][1]
            for field in BRIDGE_TEMPLATE_FIELDS:
                t = int(b.get(field, ['0'])[0] or 0)
                if t and t in widths:
                    table[str(t)] = [actor, widths[t]]
        out[tid] = dict(sorted(table.items(), key=lambda kv: int(kv[0])))
    return out


# The rules files data/source/parse.py resolves (its `rules`).
RULES_FILES = ['defaults', 'infantry', 'vehicles', 'aircraft', 'ships', 'structures', 'fakes', 'misc', 'civilian',
               'decoration', 'husks']


def inherits():
    """Actor id -> [parent actor id, sorted own keys] for actors inheriting a
    concrete actor (OpenRA Inherits of an actor that is not a ^template)."""
    defs = parse.load('rules', RULES_FILES)
    out = {}
    for name, (_v, node) in defs.items():
        if name.startswith('^'):
            continue
        parents = [v for k, (v, _ch) in node.items() if (k == 'Inherits' or k.startswith('Inherits@')) and not v.startswith('^')]
        if not parents:
            continue
        assert len(parents) == 1 and parents[0] in defs, (name, parents)
        own = []
        for k, (v, ch) in node.items():
            if k == 'Inherits' or k.startswith('Inherits@'):
                continue
            if k.startswith('-') or not ch:
                own.append(k)
            else:
                own.extend(f'{k}.{f}' for f in ch)
        out[name] = [parents[0], sorted(own)]
    return dict(sorted(out.items()))


def main():
    tilesets = {}
    pick_any = {}
    for name in TILESETS:
        tid, templates, pa = tileset_table(name)
        tilesets[tid] = templates
        pick_any[tid] = pa
    bridge_table = bridges()
    lines = [
        '// GENERATED by tools/gen_oramap_tables.py, do not edit.',
        f'// Source: OpenRA mods/ra tilesets and rules at commit {OPENRA_COMMIT}',
        '// (GPL-3.0, copied into data/source/tilesets and data/source/rules).',
        '',
        '/** One letter per OpenRA terrain type, as used in TILESETS. */',
        f'export const ORA_TERRAIN_LETTERS = Object.freeze({json.dumps(ORA_TERRAIN_LETTERS)});',
        '',
        '/** Tile terrain letters per tileset and template id, run-length encoded; "." = no such tile. */',
        'export const TILESETS = Object.freeze({',
    ]
    for tid, templates in tilesets.items():
        lines.append(f'  {tid}: Object.freeze({json.dumps({str(k): v for k, v in templates.items()}, separators=(",", ":"))}),')
    lines.append('});')
    lines.append('')
    lines.append('/** Templates whose tile index 255 means "any tile" (OpenRA PickAny). */')
    lines.append(f'export const PICK_ANY = Object.freeze({json.dumps(pick_any, separators=(",", ":"))});')
    lines.append('')
    lines.append('/** Bridge templates per tileset: template id -> [bridge actor id, template width] (OpenRA LegacyBridgeLayer). */')
    lines.append(f'export const BRIDGES = Object.freeze({json.dumps(bridge_table, separators=(",", ":"))});')
    lines.append('')
    lines.append('/** Actors inheriting another actor: id -> [parent id, keys it sets itself] (map rules on the parent reach them). */')
    lines.append(f'export const INHERITS = Object.freeze({json.dumps(inherits(), separators=(",", ":"))});')
    lines.append('')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write('\n'.join(lines))
    print(f'{OUT}: ' + ', '.join(f'{t} {len(v)} templates' for t, v in tilesets.items()) + f', {sum(len(v) for v in bridge_table.values())} bridge templates')


if __name__ == '__main__':
    main()
