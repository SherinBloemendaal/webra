#!/usr/bin/env python3
"""Generate sim/rules.json from the resolved OpenRA catalog in data/.

The simulation embeds this file at compile time. Only the actors in ACTORS are
exported, together with every weapon and locomotor they reference, so the game
data stays small while every number still comes from OpenRA's rules.

Usage: python3 tools/gen_rules.py
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
OUT = os.path.join(ROOT, 'sim', 'rules.json')

# Actors that are part of the current milestone.
ACTORS = ['FACT', 'POWR', 'PROC', 'TENT', 'BARR', 'WEAP', 'FIX', 'HARV', 'E1', '1TNK', '3TNK']
FACTIONS = ['allies', 'england', 'france', 'germany', 'soviet', 'russia', 'ukraine']
ARMOR_TYPES = ['None', 'Wood', 'Light', 'Heavy', 'Concrete']
TERRAIN_TYPES = ['Clear', 'Rough', 'Ore']
DEFAULT_FALLOFF = [100, 37, 14, 5]  # OpenRA SpreadDamageWarhead default
DEFAULT_BURST_DELAY = 5             # OpenRA WeaponInfo default
BUILD_DURATION_MODIFIER = 60        # OpenRA BuildableInfo default (percent)
BALE_LOAD_DELAY = 4                 # OpenRA HarvesterInfo default
HARVESTER_SEARCH_FROM_PROC = 15
HARVESTER_SEARCH_FROM_HARV = 8


def wdist(v):
    """Parse an OpenRA WDist ('4c768' or '512') into world units (1 cell = 1024)."""
    if v is None or v == '':
        return 0
    v = str(v).strip()
    if 'c' in v:
        c, l = v.split('c')
        return int(c or 0) * 1024 + int(l or 0)
    return int(v)


def ints(v):
    return [int(x) for x in re.split(r'[\s,]+', str(v).strip()) if x]


def trait(t, name):
    return {k: v for k, v in t.items() if k == name or k.startswith(name + '@')}


def tokens(v):
    return [x.strip() for x in (v or '').split(',') if x.strip()]


def load_ftl():
    path = os.path.join(DATA, 'source', 'rules.ftl')
    out, cur, attr = {}, None, None
    for line in open(path):
        line = line.rstrip('\n')
        m = re.match(r'^([a-z0-9-]+)\s*=\s*(.*)$', line)
        if m:
            cur, attr = m.group(1), None
            continue
        m = re.match(r'^\s+\.([a-z0-9-]+)\s*=\s*(.*)$', line)
        if m and cur:
            attr = cur + '.' + m.group(1)
            out[attr] = m.group(2)
            continue
        if line.startswith('        ') and attr:
            out[attr] = (out[attr] + ' ' + line.strip()).strip()
    return out


def parse_locomotors():
    """Read Locomotor terrain speeds from world.yaml (not part of actors.json)."""
    path = os.path.join(DATA, 'source', 'rules', 'world.yaml')
    locos, cur, in_speeds = {}, None, False
    for raw in open(path):
        line = raw.rstrip('\n')
        if re.match(r'^\tLocomotor@', line):
            cur, in_speeds = None, False
            continue
        m = re.match(r'^\t\tName: (\S+)', line)
        if m and cur is None and not in_speeds:
            cur = m.group(1)
            locos[cur] = {'_crushes': []}
            continue
        m = re.match(r'^\t\tCrushes: (.+)', line)
        if cur and m:
            locos[cur]['_crushes'] = [x.strip() for x in m.group(1).split(',')]
            in_speeds = False
            continue
        if cur and re.match(r'^\t\tTerrainSpeeds:', line):
            in_speeds = True
            continue
        m = re.match(r'^\t\t\t(\w+): (\d+)', line)
        if cur and in_speeds and m:
            locos[cur][m.group(1)] = int(m.group(2))
            continue
        if re.match(r'^\t\S', line) or re.match(r'^\S', line):
            cur, in_speeds = None, False
    return locos


def weapon_info(name, weapons):
    w = weapons[name]
    proj = w.get('Projectile', {})
    ptype = proj.get('_') if isinstance(proj, dict) else proj
    dmg = next((v for k, v in w.items() if k.startswith('Warhead') and isinstance(v, dict) and v.get('_') == 'SpreadDamage'), None)
    if dmg is None:
        raise SystemExit(f'weapon {name} has no SpreadDamage warhead')
    versus = dmg.get('Versus', {})
    burst = int(w.get('Burst', 1))
    delays = ints(w['BurstDelays']) if 'BurstDelays' in w else [DEFAULT_BURST_DELAY]
    return {
        'name': name,
        'range': wdist(w.get('Range')),
        'reload': int(w.get('ReloadDelay', 1)),
        'burst': burst,
        'burst_delays': delays,
        'projectile': {'Bullet': 'bullet', 'Missile': 'missile', 'InstantHit': 'instant'}[ptype],
        'speed': int(proj.get('Speed', '0').split(',')[0]) if isinstance(proj, dict) and ptype != 'InstantHit' else 0,
        'damage': int(dmg['Damage']),
        'spread': wdist(dmg.get('Spread', 43)),
        'falloff': ints(dmg['Falloff']) if 'Falloff' in dmg else DEFAULT_FALLOFF,
        'versus': [int(versus.get(a, 100)) for a in ARMOR_TYPES],
    }


def footprint_rows(fp):
    return fp.split()


def main():
    actors = {a['id']: a for a in json.load(open(os.path.join(DATA, 'actors.json')))}
    weapons = json.load(open(os.path.join(DATA, 'weapons.json')))
    wl = {k.lower(): k for k in weapons}
    ftl = load_ftl()
    locos = parse_locomotors()

    out_actors, used_weapons, used_locos = [], [], []
    for aid in ACTORS:
        a = actors[aid]
        t = a['traits']
        kind = 'building' if 'Building' in t else ('infantry' if a['queue'] == 'Infantry' else 'vehicle')
        e = {
            'id': aid,
            'name': a['name'],
            'description': (a['description'] or '').replace('\\n', ' '),
            'kind': kind,
            'queue': a['queue'],
            'cost': a['cost'],
            'build_ticks': a['cost'] * int(a['buildDurationModifier'] or BUILD_DURATION_MODIFIER) // 100
            if not a['buildDuration'] or int(a['buildDuration']) < 0 else int(a['buildDuration']),
            'palette_order': a['buildPaletteOrder'],
            'prerequisites': a['prerequisites'],
            'hp': a['hp'],
            'armor': ARMOR_TYPES.index(a['armor'] or 'None'),
            'sight': wdist(a['sight']),
            'weapons': [],
        }
        for slot, arm in trait(t, 'Armament').items():
            # Only the default (unconditioned) armament; garrison weapons are not modelled yet.
            if isinstance(arm, dict) and 'Name' not in arm:
                wn = wl[arm['Weapon'].lower()]
                if wn not in used_weapons:
                    used_weapons.append(wn)
                e['weapons'].append(used_weapons.index(wn))

        if kind == 'building':
            b = t['Building']
            w, h = ints(b['Dimensions'])
            rows = footprint_rows(b['Footprint'])
            assert len(rows) == h and all(len(r) == w for r in rows), aid
            e['building'] = {
                'width': w,
                'height': h,
                'footprint': rows,
                'power': sum(int(p.get('Amount', 0)) for p in trait(t, 'Power').values()),
                'power_scales_with_health': 'ScalePowerWithHealth' in t,
                'produces': tokens(t.get('Production', {}).get('Produces', '')) if 'Production' in t else [],
                'exits': [ints(x['ExitCell']) for k, x in sorted(trait(t, 'Exit').items())],
                'gives_buildable_area': 'GivesBuildableArea' in t,
                'base_provider_range': wdist(t['BaseProvider']['Range']) if 'BaseProvider' in t else 0,
                'adjacent': 2,  # OpenRA BuildingInfo.Adjacent default
                'provides': {},
            }
            # Static prerequisite resolution per faction. A provider with
            # RequiresPrerequisites only counts when those tokens come from a
            # Factions-filtered provider of the same faction.
            for f in FACTIONS:
                base = set()
                for k, p in trait(t, 'ProvidesPrerequisite').items():
                    p = p if isinstance(p, dict) else {}
                    fs = tokens(p.get('Factions'))
                    if fs and f not in fs:
                        continue
                    if p.get('RequiresPrerequisites'):
                        continue
                    base.add(p.get('Prerequisite') or aid.lower())
                faction_tokens = set()
                for other in ACTORS:
                    ot = actors[other]['traits']
                    for p in trait(ot, 'ProvidesPrerequisite').values():
                        if isinstance(p, dict) and f in tokens(p.get('Factions')):
                            faction_tokens.add(p.get('Prerequisite'))
                for k, p in trait(t, 'ProvidesPrerequisite').items():
                    if isinstance(p, dict) and p.get('RequiresPrerequisites'):
                        if all(r in faction_tokens for r in tokens(p['RequiresPrerequisites'])):
                            base.add(p.get('Prerequisite') or aid.lower())
                e['building']['provides'][f] = sorted(base)
            if 'Refinery' in t:
                d = t['DockHost']
                e['building']['refinery'] = {
                    'dock_offset': [wdist(x) for x in d['DockOffset'].split(',')][:2],
                    'storage': int(t['StoresPlayerResources']['Capacity']),
                    'free_actor': t['FreeActor']['Actor'],
                    'free_actor_offset': ints(t['FreeActor']['SpawnOffset']),
                }
            if 'RepairsUnits' in t:
                r = t['RepairsUnits']
                e['building']['repairs'] = {
                    'hp_per_step': int(r['HpPerStep']),
                    'interval': int(r['Interval']),
                    'value_percent': int(r.get('ValuePercent', 20)),
                }
            lco = t['Building'].get('LocalCenterOffset')
            e['building']['center_offset'] = ints(lco)[:2] if lco else [0, 0]
        else:
            m = t['Mobile']
            loco = m['Locomotor']
            if loco not in used_locos:
                used_locos.append(loco)
            e['unit'] = {
                'speed': int(m['Speed']),
                'turn_speed': int(m.get('TurnSpeed', 512)),
                'turn_in_place': m.get('AlwaysTurnInPlace', 'false').lower() == 'true' or kind == 'infantry',
                'locomotor': used_locos.index(loco),
                'turret_turn_speed': int(t['Turreted']['TurnSpeed']) if 'Turreted' in t else None,
                'radius': 128 if kind == 'infantry' else 384,
            }
            if 'Harvester' in t:
                hv = t['Harvester']
                e['unit']['harvester'] = {
                    'capacity': int(t['StoresResources']['Capacity']),
                    'bale_load_delay': int(hv.get('BaleLoadDelay', BALE_LOAD_DELAY)),
                    'bale_unload_delay': int(hv.get('BaleUnloadDelay', 1)),
                    'search_from_proc': int(hv.get('SearchFromProcRadius', HARVESTER_SEARCH_FROM_PROC)),
                    'search_from_harv': int(hv.get('SearchFromHarvesterRadius', HARVESTER_SEARCH_FROM_HARV)),
                }
        out_actors.append(e)

    player = {
        'starting_cash': 5000,           # OpenRA lobby default
        'ore_value': 25,                 # PlayerResources.ResourceValues.Ore
        'low_power_modifier': 300,       # ClassicProductionQueue.LowPowerModifier
        # ClassicProductionQueue.BuildTimeSpeedReduction default
        'speed_reduction': [100, 85, 75, 65, 60, 55, 50],
        'ore_max_density': 12,
    }
    rules = {
        'source': 'OpenRA mods/ra (bleed), generated by tools/gen_rules.py',
        'armor_types': ARMOR_TYPES,
        'terrain_types': TERRAIN_TYPES,
        'factions': FACTIONS,
        'player': player,
        'actors': out_actors,
        'weapons': [weapon_info(w, weapons) for w in used_weapons],
        'locomotors': [
            {'name': l, 'speeds': [locos[l].get(tt, 0) for tt in TERRAIN_TYPES], 'crushes': locos[l]['_crushes']}
            for l in used_locos
        ],
    }
    with open(OUT, 'w') as fh:
        json.dump(rules, fh, indent=1)
    print(f'wrote {OUT}: {len(out_actors)} actors, {len(used_weapons)} weapons, {len(used_locos)} locomotors')


if __name__ == '__main__':
    main()
