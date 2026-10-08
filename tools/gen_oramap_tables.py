#!/usr/bin/env python3
"""Generate apps/game/js/oramap/tables.js: lookup tables for the .oramap importer.

Input (OpenRA mods/ra, copied into data/source, see data/CATALOG.md):
- data/source/tilesets/{temperat,snow,desert,interior}.yaml: the terrain type
  of every tile of every template, per tileset.
- data/source/rules/{decoration,civilian}.yaml (+ defaults.yaml for
  inheritance): footprints of trees, rocks and civilian buildings, which
  OpenRA maps place as actors and WebRA turns into terrain.

Output, compact:
- TILESETS[tileset id][template id] = tile terrain letters, one per tile index,
  run-length encoded ("c16" = 16 times "c"), "." for an index the template does
  not have. Letters: see ORA_TERRAIN_LETTERS.
- PICK_ANY[tileset id] = template ids with PickAny (index 255 = any tile).
- DECORATIONS[actor] = { kind: 'tree' | 'block', cells: [[dx, dy], ...] }:
  the occupied ('x') cells of the actor's footprint.

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


def decorations():
    defs = parse.load('rules', ['defaults', 'decoration', 'civilian'])
    resolved = parse.resolve_all(defs)

    def ancestors(name, seen=()):
        node = defs.get(name)
        if not node or name in seen:
            return set()
        out = set()
        for k, (v, _) in node[1].items():
            if k == 'Inherits' or k.startswith('Inherits@'):
                out.add(v)
                out |= ancestors(v, seen + (name,))
        return out

    table = {}
    with open(os.path.join(SRC, 'rules', 'decoration.yaml')) as f:
        names = list(parse.parse_miniyaml(f.read()))
    with open(os.path.join(SRC, 'rules', 'civilian.yaml')) as f:
        names += list(parse.parse_miniyaml(f.read()))
    for name in names:
        if name.startswith('^') or name not in resolved:
            continue
        building = resolved[name].get('Building')
        if not building:
            continue
        footprint = building[1].get('Footprint', ['x'])[0]
        cells = [[dx, dy] for dy, row in enumerate(footprint.split()) for dx, c in enumerate(row) if c == 'x']
        if not cells:
            continue
        parents = ancestors(name)
        # Trees become WebRA tree terrain; everything else that blocks (rocks,
        # boxes, ice floes, civilian buildings, tank traps) becomes rock.
        kind = 'tree' if '^Tree' in parents and '^Box' not in parents and not name.startswith('ICE') else 'block'
        table[name] = {'kind': kind, 'cells': cells}
    return dict(sorted(table.items()))


def main():
    tilesets = {}
    pick_any = {}
    for name in TILESETS:
        tid, templates, pa = tileset_table(name)
        tilesets[tid] = templates
        pick_any[tid] = pa
    deco = decorations()
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
    lines.append('/** Decoration actors WebRA turns into terrain: occupied footprint cells. */')
    lines.append(f'export const DECORATIONS = Object.freeze({json.dumps(deco, separators=(",", ":"))});')
    lines.append('')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write('\n'.join(lines))
    print(f'{OUT}: ' + ', '.join(f'{t} {len(v)} templates' for t, v in tilesets.items()) + f', {len(deco)} decorations')


if __name__ == '__main__':
    main()
