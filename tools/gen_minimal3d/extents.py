"""How big each actor's original sprite looks on screen, from numbers in the repo: OpenRA's DecorationBounds, else its
Bounds (apps/game/js/content/render-facts.js ORIGINAL_BOUNDS, 1/1024 cell around the actor's centre), else the
footprint less its bib rows (engine/rules.json). The same rule as apps/game/tests/minimal3d-size.test.mjs, which
measures the finished pack against it; the models use it to stand on exactly that box (core.Building).

The contract is the size on screen, not the size of the model: a unit's longer side on screen (union over its
facings, with its turret) is within 15% of the box's longer side, the same measure the 2D minimal units use. The
3D models are smaller in world pixels than the 2D art on purpose (the 3/4 camera adds the hull height, the diagonal
facings and the ground shear), so do not copy the 2D sizes into the models (docs/texture-packs.md)."""
import json
import os
import re

import core

FACTS = os.path.join(core.ROOT, 'apps', 'game', 'js', 'content', 'render-facts.js')
RULES = os.path.join(core.ROOT, 'engine', 'rules.json')
WEBRA_RULES = os.path.join(core.ROOT, 'data', 'webra', 'rules.yaml')
WD = core.CELL / 1024.0

_bounds = None
_rules = None
_webra = None


def webra_bounds():
    """WebRA's own actors (data/webra/rules.yaml) have no original sprite: their own rules' Selectable bounds stand
    in for it, read the same way: {actor id: {'bounds': [...], 'decoration': [...]}}."""
    global _webra
    if _webra is None:
        _webra = {}
        actor = None
        with open(WEBRA_RULES) as f:
            for line in f:
                m = re.match(r'^([A-Za-z0-9.]+):', line)
                if m:
                    actor = m.group(1)
                    continue
                m = re.match(r'^\t\t(Bounds|DecorationBounds): *([-\d, ]+)$', line.rstrip('\n'))
                if m and actor:
                    nums = [int(x) for x in m.group(2).replace(' ', '').split(',')]
                    key = 'bounds' if m.group(1) == 'Bounds' else 'decoration'
                    _webra.setdefault(actor, {})[key] = (nums + [0, 0])[:4]
    return _webra


def original_bounds():
    """ORIGINAL_BOUNDS of render-facts.js: {actor id: {'bounds': [w, h, x, y], 'decoration': [...]}}."""
    global _bounds
    if _bounds is None:
        with open(FACTS) as f:
            text = f.read()
        body = text[text.index('export const ORIGINAL_BOUNDS = {'):]
        body = body[:body.index('\n};')]
        _bounds = {}
        for m in re.finditer(r'^  ("[^"]+"): (\{.*\}),$', body, re.M):
            _bounds[json.loads(m.group(1))] = json.loads(m.group(2))
    return _bounds


def rules_by_id():
    global _rules
    if _rules is None:
        with open(RULES) as f:
            _rules = {a['id']: a for a in json.load(f)['actors']}
    return _rules


def base_id(aid):
    return re.sub(r'\.(Husk|EmptyHusk|FullHusk)$', '', aid)


class Box:
    """An original extent in screen pixels: width w, height h, centre (x, y) from the actor point; `bib` rows of
    the footprint the original draws as a separate bib under the structure; `source` says where it came from."""

    def __init__(self, w, h, x, y, source, bib=0):
        self.w, self.h, self.x, self.y, self.source, self.bib = w, h, x, y, source, bib

    @property
    def bottom(self):
        return self.y + self.h / 2

    @property
    def top(self):
        return self.y - self.h / 2


def box(aid):
    """The original extent of an actor (a Box), or None when the repo has no numbers for it."""
    rules = rules_by_id()
    base = base_id(aid)
    b = (rules.get(aid) or {}).get('building') or (rules.get(base) or {}).get('building')
    bib = len([r for r in (b or {}).get('footprint', []) if re.fullmatch('=+', r)])
    for key in (aid, base):
        ob = original_bounds().get(key) or webra_bounds().get(key) or {}
        v = ob.get('decoration') or ob.get('bounds') or None
        if v:
            return Box(v[0] * WD, v[1] * WD, v[2] * WD, v[3] * WD, 'bounds' if key == aid else f'bounds of {key}', bib)
    if not b:
        return None
    co = b.get('center_offset') or [0, 0]
    h = (b['height'] - bib) * core.CELL
    return Box(b['width'] * core.CELL, h, -co[0] * WD, -b['height'] * core.CELL / 2 + h / 2 - co[1] * WD, 'footprint', bib)


def centre_offset(aid):
    """The actor point of a structure from its footprint box centre, in pixels (rules center_offset)."""
    b = (rules_by_id().get(aid) or {}).get('building') or {}
    co = b.get('center_offset') or [0, 0]
    return co[0] * WD, co[1] * WD
