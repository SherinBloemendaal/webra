#!/usr/bin/env python3
"""Generate the playable Red Alert campaign missions (apps/game/missions).

OpenRA's missions (data/source/missions, vendored from OpenRA's mods/ra at the
commit in data/CATALOG.md) are a map (map.yaml, map.bin), Lua scripts, text
(Fluent .ftl) and rules that change the mod's rules: new actors
(`TRAN.Extraction: Inherits: TRAN`), production switched off (`Buildable:
Prerequisites: ~disabled`), power proxies, cameras and so on. For each
mission this tool

- merges, like OpenRA does, the RA rules (data/source/rules, plus OpenRA's full
  misc.yaml and husks.yaml from data/source/missions/rules), the campaign
  rules named in map.yaml's `Rules:` and the mission's rules.yaml (and
  weapons.yaml), runs tools/gen_rules.py on the result (so every value is
  extracted exactly as for the built-in rules) and keeps the difference to the
  built-in engine/rules.json: changed fields of built-in actors, weapons and
  locomotors, and whole new ones (applied by the engine's
  `Rules::load_mission`);
- converts the map with the game's .oramap importer (tools/mission-map.mjs):
  terrain, ore and gems, cropped to the map's bounds, decorations become
  terrain, every other map actor is kept with its name and inits;
- collects the players, the scripts in their load order, the text the scripts
  and the mission use, the briefing and videos, the lobby options
  (difficulty), starting cash, tech level, time limit texts and bot modules;

and writes apps/game/missions/<id>.json (docs/contracts.md section 9) and
apps/game/missions/index.json (the campaign menu).

Which new actors are exported: every type placed on the map, every string in
the mission's Lua scripts that names an actor, and what those refer to
(husks, cargo, paratroopers). Actors without a body (waypoints, cameras,
flares) become script props. Trees and other decorations stay terrain.

Usage: python3 tools/gen_missions.py
"""
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, 'tools')
DATA = os.path.join(ROOT, 'data')
SRC = os.path.join(DATA, 'source', 'missions')
OUT = os.path.join(ROOT, 'apps', 'game', 'missions')
COOP_OUT = os.path.join(ROOT, 'packages', 'protocol', 'src', 'coop-missions.js')
FORMAT = 1
OPENRA_COMMIT = 'b6fc03fcfaef1277592bbd4cbc7d44dd85219902'

sys.path.insert(0, TOOLS)
import gen_rules  # noqa: E402

parse = gen_rules.load_source_rules()

# The RA rule files (data/source/rules) OpenRA loads for the mod, in mod.yaml order.
BASE_RULE_FILES = ['defaults', 'player', 'world', 'infantry', 'vehicles', 'aircraft', 'ships', 'structures', 'fakes', 'misc', 'husks',
                   'civilian', 'decoration']
WEAPON_FILES = ['ballistics', 'explosions', 'missiles', 'other', 'smallcaliber', 'superweapons']
# Mod rule files data/source/rules has only an excerpt of: the full upstream files.
FULL_RULE_FILES = ['misc.yaml', 'husks.yaml']
# Campaign rule files map.yaml may name (ra|rules/...); palettes only change drawing.
CAMPAIGN_RULE_FILES = {'campaign-rules.yaml', 'campaign-tooltips.yaml', 'coop-missions-rules.yaml'}
IGNORED_RULE_FILES = {'campaign-palettes.yaml'}
# Map actor types that are engine markers, never actors with a body.
MARKERS = {'waypoint', 'mpspawn'}


def read_yaml(path):
    with open(path, encoding='utf-8') as fh:
        return parse.parse_miniyaml(fh.read())


def merge_node(base, over):
    """Merge trait nodes like OpenRA's MiniYaml merge: values override,
    children merge, and `-Key:` removes Key here and stays as a marker, so it
    also removes a Key the definition inherits (resolved by parse.py)."""
    out = copy.deepcopy(base)
    for k, (v, ch) in over.items():
        if k.startswith('-'):
            out.pop(k[1:], None)
            out[k] = [v, copy.deepcopy(ch)]
        elif k in out:
            ov, och = out[k]
            out[k] = [v if v != '' else ov, merge_node(och, ch)]
        else:
            out[k] = [v, copy.deepcopy(ch)]
    return out


def merge_into(defs, over):
    """OpenRA's map rules merge: `-Name:` removes a definition, a known name
    merges into it (trait by trait), a new name is added as written."""
    for k, (v, ch) in over.items():
        if k.startswith('-'):
            defs.pop(k[1:], None)
        elif k in defs:
            ov, och = defs[k]
            defs[k] = [v if v != '' else ov, merge_node(och, ch)]
        else:
            defs[k] = [v, copy.deepcopy(ch)]


def base_rule_defs():
    defs = {}
    for f in BASE_RULE_FILES:
        defs.update(read_yaml(os.path.join(DATA, 'source', 'rules', f + '.yaml')))
    for f in FULL_RULE_FILES:
        defs.update(read_yaml(os.path.join(SRC, 'rules', f)))
    return defs


def base_weapon_defs():
    defs = {}
    for f in WEAPON_FILES:
        defs.update(read_yaml(os.path.join(DATA, 'source', 'weapons', f + '.yaml')))
    return defs


def map_yaml_list(text, key):
    m = re.search(rf'^{key}:\s*(.*)$', text, re.M)
    return [x.strip() for x in m.group(1).split(',') if x.strip()] if m else []


def lua_strings(folder):
    out = set()
    for name in sorted(os.listdir(folder)):
        if name.endswith('.lua'):
            with open(os.path.join(folder, name), encoding='utf-8') as fh:
                out |= set(re.findall(r'"([^"\\\n]*)"', fh.read()))
    return out


def map_actor_types(text):
    """Types of the actors placed on the map (lower case)."""
    sec = text.split('\nActors:', 1)
    if len(sec) < 2:
        return set()
    body = re.split(r'\n[^\t\n]', sec[1], maxsplit=1)[0]
    return {m.group(1).lower() for m in re.finditer(r'^\t[^\t:]+: (\S+)\s*$', body, re.M)}


def inherits_chain(raw, name):
    """The definitions `name` inherits from, nearest first (unresolved rules)."""
    out, todo = [], [name]
    while todo:
        n = todo.pop(0)
        node = raw.get(n)
        if not node:
            continue
        for k, (v, _) in node[1].items():
            if (k == 'Inherits' or k.startswith('Inherits@')) and v not in out:
                out.append(v)
                todo.append(v)
    return out


def is_prop(t):
    """Script-only actors without a body (no health, not a structure or a power proxy):
    waypoints, cameras (also allies-03b's movable camera.jeep) and flares. Crates are
    actors of the engine (crates.rs)."""
    return 'Health' not in t and 'Building' not in t and 'Crate' not in t and not support_power_proxy(t)


def support_power_proxy(t):
    return any(re.match(r'^[A-Za-z]+Power(@|$)', k) and k.split('@')[0] not in ('Power', 'ScalePowerWithHealth', 'InfiltrateForSupportPower')
               for k in t)


def prop_info(t):
    reveal = t.get('RevealsShroud')
    image = t.get('RenderSprites', {}).get('Image') if isinstance(t.get('RenderSprites'), dict) else None
    shown = 'RenderSprites' in t
    return {'reveal': gen_rules.wdist(reveal.get('Range')) if isinstance(reveal, dict) else 0,
            # Drawn in game (a flare), not only in the map editor (a camera).
            'image': (image or '').lower() if shown else None}


# Traits a condition can switch, and what the engine does with them (mission/conditions.rs).
CONDITION_TRAITS = {'Targetable': 'targetable', 'RevealsShroud': 'reveal', 'Demolishable': 'demolishable',
                    'KillsSelf': 'kills_self', 'SpawnActorsOnSell': 'sell_survivors'}


def condition_info(t):
    """The ExternalCondition conditions of an actor and the traits they switch."""
    external = sorted({v.get('Condition') for k, v in t.items() if k.split('@')[0] == 'ExternalCondition' and isinstance(v, dict) and v.get('Condition')})
    if not external:
        return None
    effects = []
    for k, v in t.items():
        if not isinstance(v, dict) or 'RequiresCondition' not in v:
            continue
        when = v['RequiresCondition'].replace(' ', '')
        if when.lstrip('!') not in external:
            continue
        base = k.split('@')[0]
        if base == 'DamageMultiplier' and str(v.get('Modifier')) == '0':
            effects.append({'when': when, 'effect': 'invulnerable'})
        elif base in CONDITION_TRAITS:
            e = {'when': when, 'effect': CONDITION_TRAITS[base]}
            if base == 'RevealsShroud':
                e['value'] = gen_rules.wdist(v.get('Range'))
            effects.append(e)
    return {'external': external, 'effects': effects}


def generate(mission, base_rules, base_defs, base_weapons, ids_lower_base, tmp):
    folder = os.path.join(SRC, 'maps', mission)
    with open(os.path.join(folder, 'map.yaml'), encoding='utf-8') as fh:
        map_text = fh.read()
    defs = copy.deepcopy(base_defs)
    notes = []
    # The World node of the campaign and mission rules alone (new locomotors).
    world = {}
    for ref in map_yaml_list(map_text, 'Rules'):
        name = ref.split('|', 1)[1].split('/')[-1] if '|' in ref else ref
        if name in IGNORED_RULE_FILES:
            continue
        if '|' in ref:
            if name not in CAMPAIGN_RULE_FILES:
                raise SystemExit(f'{mission}: unknown mod rules file {ref}')
            over = read_yaml(os.path.join(SRC, 'rules', name))
        else:
            over = read_yaml(os.path.join(folder, name))
        merge_into(defs, over)
        if 'World' in over:
            world = merge_node(world, over['World'][1])
    weapon_defs = copy.deepcopy(base_weapons)
    for ref in map_yaml_list(map_text, 'Weapons'):
        merge_into(weapon_defs, read_yaml(os.path.join(folder, ref)))
    # The World inherits the mod's palettes and map generators (palettes.yaml,
    # map-generators.yaml): drawing and the map editor, not part of data/source.
    for unused in ('^Palettes', '^MapGenerators'):
        defs.setdefault(unused, ['', {}])
    rules = parse.resolve_all(defs)
    weapons = parse.resolve_all(weapon_defs)
    names = {k.lower(): k for k in rules if not k.startswith('^') and k not in ('World', 'Player', 'EditorWorld', 'EditorPlayer')}

    # Actors this mission needs: placed on the map or named in its scripts.
    wanted = set()
    for t in map_actor_types(map_text) | {s.lower() for s in lua_strings(folder)}:
        if t in names and t not in MARKERS:
            wanted.add(names[t])

    # Trees, boxes, ice floes and poles (armor type Tree) stay terrain, as the
    # .oramap importer makes them: no mission script refers to one. Bridges
    # (Bridge, BridgeHut) come from the map's bridge templates, which only an
    # engine with bridge actors in its built-in rules turns into actors.
    def exportable(n):
        t = parse.to_json(rules[n])
        if (t.get('Armor') or {}).get('Type') == 'Tree':
            return False
        if ('Bridge' in t or 'BridgeHut' in t or 'GroundLevelBridge' in t) and n.lower() not in ids_lower_base:
            notes.append(f'{n.lower()}: no bridge actors in the built-in rules')
            return False
        return True
    wanted = {n for n in wanted if exportable(n)}
    props = {}
    for name in sorted(wanted):
        t = parse.to_json(rules[name])
        if is_prop(t):
            props[name.lower()] = prop_info(t)
    exported = [n for n in sorted(wanted) if n.lower() not in props and n.lower() not in ids_lower_base]

    # Run gen_rules on the merged rules: buildables come from actors.json (written
    # by parse.main), the rest from the YAML (EXTRA_ACTORS).
    parse.rules = rules
    parse.weapons_json = {k: parse.to_json(v) for k, v in weapons.items() if not k.startswith('^')}
    data = os.path.join(tmp, mission)
    os.makedirs(data, exist_ok=True)
    if not os.path.exists(os.path.join(data, 'source')):
        os.symlink(os.path.join(DATA, 'source'), os.path.join(data, 'source'))
    argv, sys.argv = sys.argv, [sys.argv[0], data]
    stdout, sys.stdout = sys.stdout, open(os.devnull, 'w')
    try:
        parse.main()
    finally:
        sys.stdout.close()
        sys.stdout, sys.argv = stdout, argv
    with open(os.path.join(data, 'actors.json'), encoding='utf-8') as fh:
        buildable = {a['id'] for a in json.load(fh)}

    base_actor_ids = [a['id'] for a in base_rules['actors']]
    out_path = os.path.join(data, 'rules.json')
    saved = (gen_rules.DATA, gen_rules.OUT, gen_rules.ACTORS, gen_rules.EXTRA_ACTORS, gen_rules.PROXIES,
             gen_rules.WEAPON_ORDER, gen_rules.LOCOMOTOR_ORDER, gen_rules.parse_locomotors, gen_rules.ARMOR_TYPES)
    base_locos = gen_rules.parse_locomotors

    def mission_locomotors():
        locos = base_locos()
        for k, (v, ch) in world.items():
            if k.startswith('Locomotor@'):
                node = parse.to_json(ch)
                name = node.get('Name')
                speeds = node.get('TerrainSpeeds') if isinstance(node.get('TerrainSpeeds'), dict) else {}
                entry = dict(locos.get(name, {'_crushes': []}))
                if 'Crushes' in node:
                    entry['_crushes'] = [x.strip() for x in node['Crushes'].split(',') if x.strip()]
                if 'TerrainSpeeds' in node:
                    entry = {'_crushes': entry['_crushes'], **{tt: int(sp) for tt, sp in speeds.items()}}
                locos[name] = entry
        return locos

    extra = list(exported)
    for attempt in range(20):
        gen_rules.DATA = data
        gen_rules.OUT = out_path
        gen_rules.ACTORS = saved[2] + [a for a in extra if a in buildable]
        gen_rules.EXTRA_ACTORS = saved[3] + [a for a in extra if a not in buildable]
        gen_rules.PROXIES = set(saved[4]) | {a for a in extra if support_power_proxy(parse.to_json(rules[a])) and 'Health' not in rules[a]}
        gen_rules.WEAPON_ORDER = [w['name'] for w in base_rules['weapons']]
        gen_rules.LOCOMOTOR_ORDER = [loc['name'] for loc in base_rules['locomotors']]
        gen_rules.parse_locomotors = mission_locomotors
        # Armor types a mission adds (allies-03b's Truk) come after the built-in ones.
        armors = list(saved[8])
        for a in saved[2] + saved[3] + extra:
            at = (parse.to_json(rules[a]).get('Armor') or {}).get('Type')
            if at and at not in armors:
                armors.append(at)
        gen_rules.ARMOR_TYPES = armors
        stdout, sys.stdout = sys.stdout, open(os.devnull, 'w')
        try:
            gen_rules.main()
            # Actors the exported ones refer to (paratroopers, husks, cargo)
            # must be exported too.
            with open(out_path, encoding='utf-8') as fh:
                produced = json.load(fh)
            have = {a['id'] for a in produced['actors']}
            refs = set()

            def walk(v):
                if isinstance(v, str):
                    if v in rules and v not in have and not v.startswith('^') and v not in ('World', 'Player'):
                        refs.add(v)
                elif isinstance(v, dict):
                    for x in v.values():
                        walk(x)
                elif isinstance(v, list):
                    for x in v:
                        walk(x)
            for a in produced['actors']:
                walk({k: x for k, x in a.items() if k not in ('id', 'name', 'description')})
            refs = {r for r in refs if exportable(r)}
            if not refs:
                break
            extra.extend(sorted(refs - set(extra)))
        except KeyError as e:
            # A new actor refers to one that is not exported yet (a husk, a passenger): add it.
            missing = str(e.args[0])
            name = names.get(missing.lower())
            if name is None or name in extra or name.lower() in ids_lower_base:
                raise SystemExit(f'{mission}: cannot resolve {missing!r}')
            extra.append(name)
        finally:
            sys.stdout.close()
            sys.stdout = stdout
            (gen_rules.DATA, gen_rules.OUT, gen_rules.ACTORS, gen_rules.EXTRA_ACTORS, gen_rules.PROXIES,
             gen_rules.WEAPON_ORDER, gen_rules.LOCOMOTOR_ORDER, gen_rules.parse_locomotors, gen_rules.ARMOR_TYPES) = saved
    else:
        raise SystemExit(f'{mission}: too many missing actors')
    with open(out_path, encoding='utf-8') as fh:
        mission_rules = json.load(fh)

    # SpawnActorOnDeath of something that is not a husk or a crate (an oil
    # derrick leaves its burning ruin, a building): the mission does it.
    kinds = {e['id']: e['kind'] for e in mission_rules['actors']}
    death_spawns = {}
    for e in mission_rules['actors']:
        target = e.get('spawn_on_death')
        if target and kinds.get(target) not in ('husk', 'crate'):
            death_spawns[e['id']] = target
            e['spawn_on_death'] = None
        # Structures that leave a structure (world.spawn_on_death, neutral.rs);
        # a church that leaves a crate is the mission's to do.
        w = e.get('world')
        if isinstance(w, dict) and w.get('spawn_on_death') and kinds.get(w['spawn_on_death']) != 'building':
            death_spawns[e['id']] = w['spawn_on_death']
            w['spawn_on_death'] = None
    # The difference to the built-in rules, in the generated order: entries
    # that patch a built-in one carry its key and the changed fields, new ones
    # are complete (appended in this order, so new weapon indices match).
    diff = {'actors': [], 'weapons': [], 'locomotors': []}
    for section, key in (('actors', 'id'), ('weapons', 'name'), ('locomotors', 'name')):
        base = {e[key]: e for e in base_rules[section]}
        for e in mission_rules[section]:
            old = base.get(e[key])
            if old is None:
                diff[section].append(e)
            elif old != e:
                diff[section].append({key: e[key], **{k: v for k, v in e.items() if old.get(k) != v}})
    if mission_rules['armor_types'] != base_rules['armor_types']:
        assert mission_rules['armor_types'][:len(base_rules['armor_types'])] == base_rules['armor_types']
        diff['armor_types'] = mission_rules['armor_types'][len(base_rules['armor_types']):]
    for section in ('player', 'world', 'factions', 'terrain_types'):
        if mission_rules[section] != base_rules[section]:
            notes.append(f'{section} differs from the built-in rules and is not used')
    for section in ('weapons', 'locomotors'):
        names_out = [e['name'] for e in mission_rules[section]]
        assert names_out[:len(base_rules[section])] == [e['name'] for e in base_rules[section]], (mission, section)
    order = [a['id'] for a in mission_rules['actors'] if a['id'] not in set(base_actor_ids)]

    # How the game draws the mission's own actors (`art`, a key of the game's
    # art tables, apps/game/js/sprites.js and content/tables.js): like the
    # built-in actor they inherit from, else the built-in actor with the same
    # OpenRA image, else the image itself (the campaign's characters and
    # creatures: tools/gen_content_tables.py MISSION_ART). Power proxies have no body.
    def image_of(name):
        rs = parse.to_json(rules[name]).get('RenderSprites')
        return ((rs.get('Image') if isinstance(rs, dict) else None) or name).lower()
    by_image = {}
    for b in base_actor_ids:
        if b in rules:
            img = image_of(b)
            if img not in by_image or b.lower() == img:
                by_image[img] = b
    kinds = {a['id']: a['kind'] for a in mission_rules['actors']}
    art = {}
    for aid in order:
        if kinds[aid] == 'proxy':
            continue
        image = image_of(aid)
        like = next((ids_lower_base[p.lower()] for p in inherits_chain(defs, aid) if p.lower() in ids_lower_base), None)
        art[aid] = {'image': image, 'art': like or by_image.get(image) or image.upper()}
    conditions = {}
    if any('GrantCondition' in open(os.path.join(folder, f), encoding='utf-8').read() for f in os.listdir(folder) if f.endswith('.lua')):
        mentioned = {names[t] for t in map_actor_types(map_text) | {x.lower() for x in lua_strings(folder)} if t in names}
        for aid in sorted(mentioned | set(order)):
            if aid not in rules:
                continue
            info = condition_info(parse.to_json(rules[aid]))
            if info:
                conditions[aid if aid not in ids_lower_base.values() else aid] = info
    return {
        'rules': {k: v for k, v in diff.items() if v},
        'death_spawns': death_spawns,
        'conditions': conditions,
        'props': props,
        'art': art,
        'notes': notes,
        # Script-only definitions: what the mission's World and Player say.
        'world': parse.to_json(rules['World']),
        'player': parse.to_json(rules['Player']),
        'actor_ids': [a['id'] for a in mission_rules['actors']],
        'map_text': map_text,
    }


# ---- Text (Fluent) -------------------------------------------------------------


def parse_ftl(text):
    """Messages and attributes (`key`, `key.attr`) of a Fluent file. Multi-line
    values are joined with newlines after removing their common indentation,
    as Fluent does; placeables (`{ $time }`) stay for the engine to fill in."""
    out, cur, lines = {}, None, []

    def flush():
        if cur is None:
            return
        first, rest = lines[0], lines[1:]
        indents = [len(x) - len(x.lstrip(' ')) for x in rest if x.strip()]
        cut = min(indents) if indents else 0
        body = [first.strip()] + [x[cut:].rstrip() if x.strip() else '' for x in rest]
        while body and not body[0]:
            body.pop(0)
        while body and not body[-1]:
            body.pop()
        out[cur] = '\n'.join(body)

    for line in text.splitlines():
        if line.startswith('#'):
            continue
        m = re.match(r'^([A-Za-z][\w-]*)\s*=(.*)$', line)
        if m:
            flush()
            cur, lines = m.group(1), [m.group(2)]
            continue
        m = re.match(r'^\s+\.([\w-]+)\s*=(.*)$', line)
        if m and cur:
            flush()
            base = cur.split('.')[0]
            cur, lines = f'{base}.{m.group(1)}', [m.group(2)]
            continue
        if cur is not None and (line.startswith(' ') or not line.strip()):
            lines.append(line)
            continue
        flush()
        cur, lines = None, []
    flush()
    return {k: v for k, v in out.items() if v}


def read_text(path):
    with open(path, encoding='utf-8') as fh:
        return fh.read()


# ---- Mission files ----------------------------------------------------------------


def split_list(v):
    return [x.strip() for x in str(v or '').split(',') if x.strip()]


def truthy(v):
    return str(v).strip().lower() == 'true'


def player_info(p):
    out = {
        'name': p['Name'],
        'faction': p.get('Faction', 'allies').lower(),
        'color': p.get('Color', 'FFFFFF').upper(),
        'playable': truthy(p.get('Playable')),
        'required': truthy(p.get('Required')),
        'owns_world': truthy(p.get('OwnsWorld')),
        'non_combatant': truthy(p.get('NonCombatant')),
        'bot': p.get('Bot') or None,
        'allies': split_list(p.get('Allies')),
        'enemies': split_list(p.get('Enemies')),
    }
    return out


def actor_info(a, world_owner):
    inits = a['inits']
    # Bridges of the map's templates belong to the world's owner.
    out = {'name': a['name'], 'type': a['type'], 'owner': inits.get('Owner') or world_owner}
    x, y = (int(v) for v in inits['Location'].split(','))
    out['x'], out['y'] = x, y
    if 'Facing' in inits:
        # MapFormat 12: WAngle, 0 north, counter-clockwise, 1024 a turn.
        out['facing'] = int(inits['Facing']) % 1024
    # Turreted actors with two turrets (cruisers) name them: the engine has one.
    turret = next((inits[k] for k in sorted(inits) if k.split('@')[0] == 'TurretFacing'), None)
    if turret is not None:
        out['turret_facing'] = int(turret) % 1024
    if 'SubCell' in inits:
        out['subcell'] = int(inits['SubCell'])
    if 'Health' in inits:
        out['health'] = int(inits['Health'])
    if 'Stance' in inits:
        out['stance'] = inits['Stance']
    if 'Faction' in inits:
        out['faction'] = inits['Faction'].lower()
    if 'FreeActor' in inits:
        out['free_actor'] = truthy(inits['FreeActor'])
    if 'ScriptTags' in inits:
        out['tags'] = split_list(inits['ScriptTags'])
    unknown = sorted({k.split('@')[0] for k in inits} - {'Location', 'Owner', 'Facing', 'TurretFacing', 'SubCell', 'Health', 'Stance', 'Faction', 'FreeActor',
                                    'ScriptTags'})
    if unknown:
        raise SystemExit(f'{a["name"]}: unknown actor inits {unknown}')
    return out


def traits(node, name):
    return {k: v for k, v in node.items() if k == name or k.startswith(name + '@')}


def mission_file(mission, campaign, gen, base_actor_ids):
    folder = os.path.join(SRC, 'maps', mission)
    world, player = gen['world'], gen['player']
    # Map, players and actors through the .oramap importer.
    actor_types = sorted({a.lower() for a in gen['actor_ids']} | set(gen['props']) | MARKERS)
    run = subprocess.run(['node', os.path.join(TOOLS, 'mission-map.mjs'), folder], input=json.dumps({'actors': actor_types}),
                         capture_output=True, text=True, check=False)
    if run.returncode != 0:
        raise SystemExit(f'{mission}: map conversion failed\n{run.stderr}')
    m = json.loads(run.stdout)
    # Text: the mod's Lua and campaign messages the scripts use, and the map's own.
    messages = {}
    for f in ('lua.ftl', 'campaign.ftl'):
        messages.update(parse_ftl(read_text(os.path.join(SRC, 'fluent', f))))
    map_messages = parse_ftl(read_text(os.path.join(folder, 'map.ftl'))) if os.path.exists(os.path.join(folder, 'map.ftl')) else {}
    lua = world.get('LuaScript') or {}
    scripts = []
    for name in split_list(lua.get('Scripts')):
        path = os.path.join(folder, name)
        if not os.path.exists(path):
            path = os.path.join(SRC, 'scripts', name)
        scripts.append({'name': name, 'source': read_text(path)})
    literals = set()
    for sc in scripts:
        literals |= set(re.findall(r'"([^"\\\n]*)"', sc['source']))
    used = {k: v for k, v in messages.items() if k in literals or k.split('.')[0] in literals}
    used.update(map_messages)
    data = world.get('MissionData') or {}
    resolve = lambda key: used.get(key, messages.get(key, key)) if key else ''
    options = {}
    for k, v in traits(world, 'ScriptLobbyDropdown').items():
        values = [[val, resolve(label)] for val, label in (v.get('Values') or {}).items()]
        options[v['ID']] = {'label': resolve(v.get('Label', '') + '.label' if v.get('Label') and '.' not in v.get('Label') else v.get('Label')),
                            'values': values, 'default': v.get('Default', values[0][0] if values else '')}
    tl = world.get('TimeLimitManager') or {}
    warnings = sorted(((int(k), v) for k, v in (tl.get('TimeLimitWarnings') or {}).items()), reverse=True)
    smudges = []
    for k, v in traits(world, 'SmudgeLayer').items():
        for cell, spec in (v.get('InitialSmudges') or {}).items():
            x, y = (int(c) for c in cell.split(','))
            kind, depth = (split_list(spec) + ['0'])[:2]
            smudges.append({'x': x, 'y': y, 'type': kind, 'depth': int(depth)})
    conditions = {v['Condition']: [] for v in traits(player, 'ExternalCondition').values() if isinstance(v, dict)}
    for k, v in player.items():
        if k.split('@')[0].endswith('BotModule') and isinstance(v, dict) and v.get('RequiresCondition') in conditions:
            conditions[v['RequiresCondition']].append(k.split('@')[0])
    players = [player_info(p) for p in m['players']]
    human = next(p for p in players if p['playable'])
    title = ' '.join(m['title'].split())
    out = {
        'format': FORMAT,
        'id': mission,
        'title': title,
        'campaign': campaign,
        'author': m['author'],
        # OpenRA offers it in the multiplayer lobby too (map.yaml Visibility: Lobby): a co-op mission.
        'lobby': 'Lobby' in m['visibility'],
        'source': f'OpenRA mods/ra/maps/{mission} at {OPENRA_COMMIT} (GPL-3.0), converted by tools/gen_missions.py',
        'briefing': resolve(data.get('Briefing')),
        'videos': {k: data[v].lower() for k, v in (('background', 'BackgroundVideo'), ('briefing', 'BriefingVideo'), ('start', 'StartVideo'),
                                                    ('win', 'WinVideo'), ('loss', 'LossVideo')) if data.get(v)},
        'tileset': m['tileset'],
        'origin': m['origin'],
        'map': {'format': 2 if 'gems' in m['map'] else 1, 'name': title[:64], 'author': (m['author'] or 'OpenRA')[:64], 'description': '',
                **m['map'], 'spawns': []},
        'players': players,
        'actors': [actor_info(a, next((p['name'] for p in players if p['owns_world']), 'Neutral')) for a in m['actors']],
        'rules': gen['rules'],
        'death_spawns': gen['death_spawns'],
        'conditions': gen['conditions'],
        'props': gen['props'],
        'art': gen['art'],
        'scripts': scripts,
        'messages': dict(sorted(used.items())),
        'options': options,
        'starting_cash': int((player.get('PlayerResources') or {}).get('DefaultCash', 0)),
        'tech_level': ((world.get('MapOptions') or {}).get('TechLevel') or 'unrestricted').lower(),
        'time_limit': {'countdown_text': tl.get('CountdownText') or None, 'notification': tl.get('Notification') or None,
                       'skip_expired_notification': truthy(tl.get('SkipTimerExpiredNotification')),
                       'warnings': [w for w, _ in warnings], 'warning_notifications': [n for _, n in warnings]},
        'start_notification': (world.get('StartGameNotification') or {}).get('Notification') or 'StartGame',
        'objectives': {'early_game_over': truthy((player.get('MissionObjectives') or {}).get('EarlyGameOver')),
                       'game_over_delay': int((player.get('MissionObjectives') or {}).get('GameOverDelay', 1500)),
                       'cooperative': truthy((player.get('MissionObjectives') or {}).get('Cooperative'))},
        'bot_conditions': {k: sorted(v) for k, v in conditions.items()},
        'smudges': smudges,
        'notes': gen['notes'] + ([f'unknown map actor types: {", ".join(f"{k} x{n}" for k, n in m["unknown"].items())}'] if m['unknown'] else []),
    }
    assert human, mission
    return out


def main():
    with open(os.path.join(ROOT, 'engine', 'rules.json'), encoding='utf-8') as fh:
        base_rules = json.load(fh)
    ids_lower_base = {a['id'].lower(): a['id'] for a in base_rules['actors']}
    base_actor_ids = [a['id'] for a in base_rules['actors']]
    campaigns, current = [], None
    with open(os.path.join(SRC, 'missions.yaml'), encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('\t') and line.strip():
                current['missions'].append(line.strip())
            elif line.strip():
                current = {'name': line.strip().rstrip(':'), 'missions': []}
                campaigns.append(current)
    base_defs = base_rule_defs()
    base_weapons = base_weapon_defs()
    os.makedirs(OUT, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='webra-missions-')
    index = []
    coop_actors = {}
    try:
        for c in campaigns:
            entries = []
            for mission in c['missions']:
                gen = generate(mission, base_rules, base_defs, base_weapons, ids_lower_base, tmp)
                out = mission_file(mission, c['name'], gen, base_actor_ids)
                text = json.dumps(out, separators=(',', ':'), ensure_ascii=False) + '\n'
                with open(os.path.join(OUT, mission + '.json'), 'w', encoding='utf-8') as fh:
                    fh.write(text)
                human = next(p for p in out['players'] if p['playable'])
                entry = {'id': mission, 'title': out['title'], 'file': mission + '.json',
                         'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                         'faction': human['faction'], 'briefing': out['briefing'],
                         'options': out['options'], 'videos': out['videos']}
                playable = [p['name'] for p in out['players'] if p['playable']]
                if out['lobby'] and len(playable) > 1:
                    # Co-op online: the playable players people take, in map order,
                    # and how many actor types the game has (the server checks orders against it).
                    entry['coop'] = playable
                    coop_actors[mission] = len(base_actor_ids) + len(set(gen['actor_ids']) - set(base_actor_ids))
                entries.append(entry)
                r = out['rules']
                print(f'{mission}: {len(out["actors"])} map actors, {len(r.get("actors", []))} rules actors, '
                      f'{len(out["scripts"])} scripts, {len(text) // 1024} KiB'
                      + (f' ({"; ".join(out["notes"])})' if out['notes'] else ''))
            index.append({'name': c['name'], 'missions': entries})
    finally:
        shutil.rmtree(tmp)
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump({'format': FORMAT, 'source': f'OpenRA mods/ra missions.yaml at {OPENRA_COMMIT}, generated by tools/gen_missions.py',
                   'campaigns': index}, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    # The co-op missions for the online lobby and the server (packages/protocol/src/coop-missions.js).
    coop = [{'id': e['id'], 'title': e['title'], 'hash': e['sha256'], 'players': e['coop'], 'actors': coop_actors[e['id']],
             'options': {k: {'values': [v for v, _ in o['values']], 'default': o['default']} for k, o in e['options'].items()}}
            for c in index for e in c['missions'] if 'coop' in e]
    with open(COOP_OUT, 'w', encoding='utf-8') as fh:
        fh.write('// Generated by tools/gen_missions.py from apps/game/missions: do not edit.\n'
                 '// The co-op missions (OpenRA map.yaml Visibility: Lobby) people play online\n'
                 '// together: id, title, the SHA-256 of the mission file, the playable\n'
                 '// players in slot order, the number of actor types its rules have and\n'
                 '// the values of each mission option\n'
                 '// (docs/contracts.md section 9, "Co-op online").\n\n'
                 'const deepFreeze = (v) => {\n'
                 '  if (v && typeof v === \'object\') for (const k of Object.keys(v)) deepFreeze(v[k]);\n'
                 '  return Object.freeze(v);\n'
                 '};\n\n'
                 'export const COOP_MISSIONS = deepFreeze(\n'
                 + json.dumps(coop, indent=2, ensure_ascii=False) + ',\n);\n')


if __name__ == '__main__':
    main()
