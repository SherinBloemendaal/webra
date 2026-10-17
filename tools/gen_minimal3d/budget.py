"""The shape budget of the retexture (0.21.0): how many big blocks (core.Model.shapes, one per primitive) a model may
have. Structures three to six (the bib not counted), units two to five with their turret, a soldier five; the
pieces built per cell (bridges, tree clusters, rocks, ice) two or three per cell, props six. pack.build fails on a
model over its budget; generate.py --budget prints the counts per class."""
import extents

# Structures whose original extent is not a building they fill: they stand inside their box (bridges lie on it).
PROPS = {'BARL', 'BRL3', 'AMMOBOX1', 'AMMOBOX2', 'AMMOBOX3', 'LHUS', 'WINDMILL', 'BRIDGEHUT', 'BRIDGEHUT.small', 'BARB'}
LIMITS = {'structure': 6, 'unit': 5, 'infantry': 5, 'prop': 6, 'per cell': 3, 'effect': 5}
PER_CELL = ('BRIDGE', 'SBRIDGE', 'BR1', 'BR2', 'BR3', 'TC', 'ROCK', 'ICE', 'T1', 'T0')


def classify(aid, spec):
    """-> (class, the number of cells it is built per or 1)."""
    if spec.kind == 'special':
        return 'effect', 1
    kind = (extents.rules_by_id().get(aid) or {}).get('kind')
    if spec.kind == 'building':
        b = (extents.rules_by_id().get(aid) or {}).get('building') or {}
        cells = max(1, sum(row.count('x') + row.count('-') for row in b.get('footprint', [])))
        if aid.startswith(PER_CELL) and cells > 1:
            return 'per cell', cells
        if aid in PROPS or not ((extents.rules_by_id().get(aid) or {}).get('selection') or {}).get('bounds'):
            return 'prop', 1
        return 'structure', 1
    if kind == 'infantry':
        return 'infantry', 1
    return 'unit', 1


def shapes(spec):
    """Blocks of the idle model: a structure with its turret, a unit with its turret (a rotor counts apart)."""
    if spec.kind == 'special':
        return max(spec.fn(k).shapes for k in range(spec.count))
    if spec.kind == 'building':
        return spec.model().shapes + (spec.turret().shapes if spec.turret else 0)
    if hasattr(spec, 'rotor'):
        return spec.body().shapes
    if hasattr(spec, 'turret'):
        return spec.body().shapes + (spec.turret().shapes if spec.turret else 0)
    return spec.body['idle'].fn(0).shapes


def over(actors, specials):
    """Models over their budget: a list of 'ID: n blocks (class, limit)'."""
    bad = []
    for aid, spec in sorted(list(actors.items()) + list(specials.items())):
        cls, cells = classify(aid, spec)
        n = shapes(spec)
        limit = LIMITS[cls] * cells
        if n > limit:
            bad.append(f'{aid}: {n} blocks ({cls}, at most {limit})')
    return bad


def report(actors, specials):
    """Per class: models, fewest, mean and most blocks."""
    by = {}
    for aid, spec in list(actors.items()) + list(specials.items()):
        cls, cells = classify(aid, spec)
        by.setdefault(cls, []).append(shapes(spec) / cells)
    return {cls: (len(v), min(v), sum(v) / len(v), max(v)) for cls, v in sorted(by.items())}
