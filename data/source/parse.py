import re, json, sys, os, copy
D = os.path.dirname(os.path.abspath(__file__))

def parse_miniyaml(text):
    root = {}  # key -> [value, children(dict)]
    stack = [(-1, root)]
    for raw in text.splitlines():
        line = raw.split('#', 1)[0].rstrip() if not raw.lstrip().startswith('#') else ''
        if not line.strip():
            continue
        depth = len(line) - len(line.lstrip('\t'))
        s = line.strip()
        if ':' in s:
            k, v = s.split(':', 1)
        else:
            k, v = s, ''
        k, v = k.strip(), v.strip()
        while stack[-1][0] >= depth:
            stack.pop()
        parent = stack[-1][1]
        node = [v, {}]
        parent[k] = node
        stack.append((depth, node[1]))
    return root

def merge(base, over):
    out = copy.deepcopy(base)
    for k, (v, ch) in over.items():
        if k.startswith('-'):
            out.pop(k[1:], None); continue
        if k in out:
            ov, och = out[k]
            out[k] = [v if v != '' else ov, merge(och, ch)]
        else:
            out[k] = [v, merge({}, ch)]
    return out

def resolve_all(defs):
    cache = {}
    def resolve(name, seen=()):
        if name in cache: return cache[name]
        if name in seen: raise Exception('cycle ' + name)
        node = defs[name][1]
        result = {}
        own = {}
        for k, (v, ch) in node.items():
            if k == 'Inherits' or k.startswith('Inherits@'):
                result = merge(result, resolve(v, seen + (name,)))
            else:
                own[k] = [v, ch]
        result = merge(result, own)
        cache[name] = result
        return result
    return {n: resolve(n) for n in defs}

def to_json(tree):
    out = {}
    for k, (v, ch) in tree.items():
        if ch:
            j = to_json(ch)
            if v != '': j = {'_': v, **j}
            out[k] = j
        else:
            out[k] = v
    return out

def load(folder, files):
    defs = {}
    for f in files:
        defs.update(parse_miniyaml(open(os.path.join(D, folder, f + '.yaml')).read()))
    return defs

# Fluent strings
ftl = {}
cur = None; curattr = None
for line in open(os.path.join(D, 'rules.ftl')):
    line = line.rstrip('\n')
    m = re.match(r'^([a-z0-9-]+)\s*=\s*(.*)$', line)
    if m:
        cur = m.group(1); curattr = None
        if m.group(2): ftl[cur] = m.group(2)
        continue
    m = re.match(r'^\s+\.([a-z0-9-]+)\s*=\s*(.*)$', line)
    if m and cur:
        curattr = cur + '.' + m.group(1); ftl[curattr] = m.group(2); continue
    if line.startswith('        ') and curattr:
        ftl[curattr] = (ftl[curattr] + '\n' + line.strip()).strip()
def tr(key):
    return ftl.get(key, key) if key else key

rules = resolve_all(load('rules', ['defaults', 'infantry', 'vehicles', 'aircraft', 'ships', 'structures', 'fakes', 'misc', 'husks']))
weapons = resolve_all(load('weapons', ['ballistics', 'explosions', 'missiles', 'other', 'smallcaliber', 'superweapons']))
weapons_json = {k: to_json(v) for k, v in weapons.items() if not k.startswith('^')}

ALLIES = {'allies', 'england', 'france', 'germany'}
SOVIET = {'soviet', 'russia', 'ukraine'}
def factions(prereqs):
    toks = [t.strip() for t in prereqs.split(',') if t.strip()]
    fs = set()
    for t in toks:
        t2 = t.lstrip('~!')
        if '.' in t2:
            suffix = t2.split('.', 1)[1]
            if suffix in ALLIES | SOVIET and not t.startswith('~!') and not t.startswith('!'):
                fs.add(suffix)
    return sorted(fs)

def g(tree, path):
    node = tree
    parts = path.split('/')
    for i, p in enumerate(parts):
        if p not in node: return None
        v, ch = node[p]
        if i == len(parts) - 1: return v
        node = ch
    return None

def all_traits(tree, prefix):
    return {k: v for k, v in tree.items() if k == prefix or k.startswith(prefix + '@')}


FACTIONS = ['allies', 'england', 'france', 'germany', 'soviet', 'russia', 'ukraine']
GLOBAL = {'global-factundeploy'}
def prereq_list(t):
    return [x.strip() for x in (g(t, 'Buildable/Prerequisites') or '').split(',') if x.strip()]
def provides(name, t, faction, S):
    out = set()
    for k, (v, ch) in all_traits(t, 'ProvidesPrerequisite').items():
        fs = [x.strip() for x in ch.get('Factions', [''])[0].split(',') if x.strip()]
        if fs and faction not in fs: continue
        req = [x.strip() for x in ch.get('RequiresPrerequisites', [''])[0].split(',') if x.strip()]
        if not ok(req, S): continue
        out.add(ch.get('Prerequisite', [''])[0] or name.lower())
    return out
def ok(req, S, final=False):
    for r in req:
        r = r.lstrip('~')
        if r.startswith('!'):
            if final and r[1:] in S: return False
            continue
        if r not in S: return False
    return True
TECH = ['infonly', 'low', 'medium', 'high', 'unrestricted']
def available(faction):
    S = set(GLOBAL) | {'techlevel.' + x for x in TECH}
    owned = {'FACT'}
    changed = True
    while changed:
        changed = False
        for n, t in rules.items():
            if n.startswith('^'): continue
            if n not in owned:
                if 'Buildable' not in t or not g(t, 'Buildable/Queue'): continue
                if not ok(prereq_list(t), S): continue
                owned.add(n); changed = True
            new = provides(n, t, faction, S) - S
            if new: S |= new; changed = True
    return {n for n in owned if n == 'FACT' or ok(prereq_list(rules[n]), S, final=True)}

def main():
    """Write actors.json and weapons.json for every buildable actor into sys.argv[1]."""
    global AVAIL
    AVAIL = {f: available(f) for f in FACTIONS}

    units = []
    for name, t in rules.items():
        if name.startswith('^') or 'Buildable' not in t: continue
        queue = g(t, 'Buildable/Queue')
        if not queue: continue
        prereq = g(t, 'Buildable/Prerequisites') or ''
        if 'Valued' not in t: continue
        arms = []
        for k, (v, ch) in all_traits(t, 'Armament').items():
            w = ch.get('Weapon', [''])[0]
            if w and 'RequiresCondition' in ch and False: pass
            if w: arms.append({'slot': k, 'weapon': w, 'condition': ch.get('RequiresCondition', [''])[0] or None})
        power = sum(int(ch.get('Amount', ['0'])[0]) for k, (v, ch) in all_traits(t, 'Power').items())
        fs = [f for f in FACTIONS if name in AVAIL[f]]
        a, so = set(fs) & ALLIES, set(fs) & SOVIET
        side = 'Both' if a and so else 'Allies' if a else 'Soviet' if so else 'Unavailable'
        tech = next((x for x in TECH if '~techlevel.' + x in prereq), None)
        tk = g(t, 'Tooltip/Name') or g(t, 'DisguiseTooltip/Name')
        units.append({
            'id': name,
            'name': tr(tk),
            'description': tr(g(t, 'Buildable/Description')),
            'queue': queue,
            'side': side,
            'factions': fs,
            'fake': (tk or '').startswith('actor-fake') or 'Fake' in (tr(tk) or ''),
            'techLevel': tech,
            'cost': int(g(t, 'Valued/Cost') or 0),
            'buildDuration': g(t, 'Buildable/BuildDuration'),
            'buildDurationModifier': g(t, 'Buildable/BuildDurationModifier'),
            'buildPaletteOrder': int(g(t, 'Buildable/BuildPaletteOrder') or 0),
            'prerequisites': [p.strip() for p in prereq.split(',') if p.strip()],
            'hp': int(g(t, 'Health/HP') or 0) or None,
            'armor': g(t, 'Armor/Type'),
            'speed': int(g(t, 'Mobile/Speed') or g(t, 'Aircraft/Speed') or 0) or None,
            'locomotor': g(t, 'Mobile/Locomotor'),
            'sight': g(t, 'RevealsShroud/Range'),
            'power': power or None,
            'footprint': g(t, 'Building/Footprint'),
            'dimensions': g(t, 'Building/Dimensions'),
            'weapons': arms,
            'cargo': g(t, 'Cargo/MaxWeight'),
            'garrison': g(t, 'Cargo/InitialUnits') if 'AttackGarrisoned' in t else None,
            'supportPowers': [{'trait': k, 'name': tr(ch.get('Name', [''])[0]), 'chargeInterval': ch.get('ChargeInterval', [''])[0] or None,
                               'prerequisites': ch.get('Prerequisites', [''])[0] or None}
                              for k, (v, ch) in t.items() if re.match(r'^[A-Za-z]+Power(@|$)', k) and k.split('@')[0] not in ('Power', 'ScalePowerWithHealth', 'InfiltrateForSupportPower')],
            'traits': to_json(t),
        })

    order = {'Building': 0, 'Defense': 1, 'Infantry': 2, 'Vehicle': 3, 'Aircraft': 4, 'Ship': 5}
    units.sort(key=lambda u: (u['fake'], order.get(u['queue'], 9), u['queue'], u['buildPaletteOrder']))

    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    json.dump(units, open(os.path.join(out, 'actors.json'), 'w'), indent=2)
    json.dump(weapons_json, open(os.path.join(out, 'weapons.json'), 'w'), indent=2)
    print(len(units), 'buildables,', len(weapons_json), 'weapons')
    from collections import Counter
    print(Counter((u['queue'], u['side'], u['fake']) for u in units))


if __name__ == '__main__':
    main()
