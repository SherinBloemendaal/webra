#!/usr/bin/env python3
"""Generate engine/rules.json from the resolved OpenRA catalog in data/.

The simulation embeds this file at compile time. Only the actors in ACTORS are
exported, together with every weapon and locomotor they reference, so the game
data stays small while every number still comes from OpenRA's rules.

Usage: python3 tools/gen_rules.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
OUT = os.path.join(ROOT, 'engine', 'rules.json')

# Actors that are part of the current milestone.
ACTORS = [
    # Buildings and defences
    'FACT', 'POWR', 'APWR', 'PROC', 'SILO', 'TENT', 'BARR', 'KENN', 'WEAP', 'FIX', 'DOME', 'HPAD', 'AFLD', 'AFLD.Ukraine',
    'SYRD', 'SPEN', 'ATEK', 'STEK', 'GAP', 'PDOX', 'IRON', 'MSLO',
    'SBAG', 'FENC', 'BRIK', 'PBOX', 'HBOX', 'GUN', 'FTUR', 'TSLA', 'AGUN', 'SAM',
    # France: decoy structures
    'FPWR', 'TENF', 'SYRF', 'WEAF', 'DOMF', 'FIXF', 'FAPW', 'ATEF', 'PDOF', 'MSLF', 'FACF',
    # Infantry (more later)
    'E1', 'E3',
    # Ground vehicles
    'HARV', 'MCV', 'TRUK', 'JEEP', 'APC', 'FTRK', '1TNK', '2TNK', '3TNK', '4TNK', 'V2RL', 'ARTY', 'MNLY',
    'MRJ', 'MGG', 'TTNK', 'DTRK', 'CTNK', 'STNK', 'QTNK',
    # Ships
    'LST', 'PT', 'SS', 'DD', 'CA', 'MSUB',
    # Aircraft: helicopters, then planes
    'TRAN', 'HIND', 'MH60', 'HELI', 'YAK', 'MIG',
]
# Actors that are never built but take part in the game (support powers): they
# are not in data/actors.json, so they are resolved from the OpenRA YAML in
# data/source with its parser. They get the `~disabled` prerequisite, so the
# sidebar never offers them.
EXTRA_ACTORS = [
    'E1R1', 'E3R1',            # paratroopers (ParatroopersPower DropItems)
    'U2', 'BADR', 'BADR.Bomber',  # spy plane, paratrooper transport, parabomb bomber
    'MINV', 'MINP',            # Minelayer mines (data/source/rules/misc.yaml)
]
# Reveal range of OpenRA's support power camera actors. They live in
# mods/ra/rules/misc.yaml, of which data/source only has the mines; OpenRA's CAMERA
# actor reveals 10c0 and the power cameras inherit it.
CAMERA_RANGE = 10 * 1024
# OpenRA defaults of AirstrikePowerInfo / ParatroopersPowerInfo.
AIRSTRIKE_UNIT = 'badr.bomber'
PARATROOPERS_UNIT = 'badr'
POWER_SQUAD_OFFSET = [-1536, 1536]
POWER_CAMERA_REMOVE_DELAY = 25
FACTIONS = ['allies', 'england', 'france', 'germany', 'soviet', 'russia', 'ukraine']
ARMOR_TYPES = ['None', 'Wood', 'Light', 'Heavy', 'Concrete']
TERRAIN_TYPES = ['Clear', 'Rough', 'Ore', 'Water']
DEFAULT_FALLOFF = [100, 37, 14, 5]  # OpenRA SpreadDamageWarhead default
DEFAULT_BURST_DELAY = 5             # OpenRA WeaponInfo default
BUILD_DURATION_MODIFIER = 60        # OpenRA BuildableInfo default (percent)
BALE_LOAD_DELAY = 4                 # OpenRA HarvesterInfo default
HARVESTER_SEARCH_FROM_PROC = 15
HARVESTER_SEARCH_FROM_HARV = 8
AMMO_RELOAD_DELAY = 50              # OpenRA AmmoPoolInfo.ReloadDelay default
AMMO_RELOAD_COUNT = 1               # OpenRA AmmoPoolInfo.ReloadCount default
ALTITUDE_VELOCITY = '0c43'          # OpenRA AircraftInfo.AltitudeVelocity default
WAIT_DISTANCE_FROM_RESUPPLY = '3c0'  # OpenRA AircraftInfo.WaitDistanceFromResupplyBase default
FACING_TOLERANCE = 512              # OpenRA AttackBaseInfo.FacingTolerance default
# Veterancy and prone infantry. The values themselves come from the catalog
# (^GainsExperience, GivesExperience and TakeCover in mods/ra/rules); these are
# the OpenRA trait defaults for fields the RA rules leave out:
GIVES_EXPERIENCE = -1               # GivesExperienceInfo.Experience: -1 = the actor's Valued cost
ACTOR_EXPERIENCE_MODIFIER = 10000   # GivesExperienceInfo.ActorExperienceModifier (percent)
TAKE_COVER_DURATION = 100           # TakeCoverInfo.Duration (ticks prone after the last hit)
TAKE_COVER_SPEED = 50               # TakeCoverInfo.SpeedModifier (percent while prone)
CHANGES_HEALTH_DELAY = 5            # ChangesHealthInfo.Delay
CHANGES_HEALTH_START_IF_BELOW = 50  # ChangesHealthInfo.StartIfBelow (percent)

# Deliberate deviations from OpenRA's rules, applied to the exported actors
# after extraction (shallow: each key replaces the exported field). Every entry
# says why; docs/contracts.md section 5 lists them too.
OVERRIDES = {
    # OpenRA's RA mod gives only the Allies a helipad and disables the Hind
    # (`~disabled`). In classic Red Alert (1996) both sides build the helipad:
    # the Soviets fly the Hind from it, both sides the Chinook. Restore that.
    'HPAD': {'prerequisites': ['dome', '~techlevel.medium']},
    'HIND': {'prerequisites': ['~hpad', '~structures.soviet', '~techlevel.medium']},
    # The Black Hawk stays Allied, as in OpenRA where only the Allies have a helipad.
    'MH60': {'prerequisites': ['~hpad', '~structures.allies', '~techlevel.medium']},
}


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


AIR_LOCOMOTOR = 'air'


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


# Target classes, as bit flags shared with the simulation (rules.rs).
# 'Ground' is terrain (force-fire on the ground, engine TARGET_GROUND); no actor carries it.
TARGET_BITS = {'GroundActor': 1 | 2 | 4, 'Infantry': 1, 'Vehicle': 2, 'Structure': 4, 'AirborneActor': 8,
               'Air': 8, 'WaterActor': 16, 'Water': 16, 'Ground': 256, 'Trees': 0, 'Underwater': 64, 'Bridge': 0,
               # Submarine is its own class (surfaced and submerged subs): depth charge
               # warheads hit it, while Underwater only matches submerged subs.
               'Ship': 16, 'Submarine': 128,
               'DetonateAttack': 1 | 2 | 4, 'Wall': 4, 'Mine': 32, 'Husk': 0, 'Creep': 0}


def target_mask(v):
    m = 0
    for t in tokens(v):
        if t not in TARGET_BITS:
            # Special classes (e.g. MADTank) matter only for effects not modelled yet.
            if t not in UNKNOWN_TARGETS:
                UNKNOWN_TARGETS.add(t)
                print(f'note: target type {t} ignored')
            continue
        m |= TARGET_BITS[t]
    return m


UNKNOWN_TARGETS = set()


def opportunity_fire(t):
    """AttackTurreted fires at targets of opportunity while moving (OpportunityFire, default true)."""
    return any(not isinstance(v, dict) or str(v.get('OpportunityFire', 'true')).lower() == 'true'
               for v in trait(t, 'AttackTurreted').values())


def target_types(t):
    """Every target type of an actor's Targetable traits (any condition)."""
    return {x for v in trait(t, 'Targetable').values() if isinstance(v, dict) for x in tokens(v.get('TargetTypes'))}


def locomotor_info(name, locos):
    """Speeds per terrain class and the movement domain (ground, water or air)."""
    if name == AIR_LOCOMOTOR:
        return {'name': name, 'domain': 'air', 'speeds': [100] * len(TERRAIN_TYPES), 'crushes': []}
    l = locos[name]
    speeds = [l.get(tt, 0) for tt in TERRAIN_TYPES]
    on_land = any(speeds[:3])
    on_water = speeds[3] > 0
    domain = 'water' if on_water and not on_land else 'ground'
    return {'name': name, 'domain': domain, 'speeds': speeds, 'crushes': l['_crushes']}


def weapon_info(name, weapons):
    w = weapons[name]
    proj = w.get('Projectile', {})
    ptype = proj.get('_') if isinstance(proj, dict) else proj
    warheads = []
    for k, v in w.items():
        if not (k.startswith('Warhead') and isinstance(v, dict)):
            continue
        kind = v.get('_')
        if kind not in ('SpreadDamage', 'TargetDamage', 'HealthPercentageDamage'):
            continue
        versus = v.get('Versus', {})
        warheads.append({
            'kind': {'SpreadDamage': 'spread', 'TargetDamage': 'target', 'HealthPercentageDamage': 'percent'}[kind],
            'damage': int(v.get('Damage', 0)),
            'spread': wdist(v.get('Spread', 43)),
            'falloff': ints(v['Falloff']) if 'Falloff' in v else DEFAULT_FALLOFF,
            'versus': [int(versus.get(a, 100)) for a in ARMOR_TYPES],
            'delay': int(v.get('Delay', 0)),
            'valid': target_mask(v.get('ValidTargets', 'Ground, Water')) or (1 | 2 | 4 | 16),
            'invalid': target_mask(v.get('InvalidTargets', '')),
            # DamageTypes: TakeCover reacts to them (TriggerProne, Prone50Percent).
            'damage_types': tokens(v.get('DamageTypes')),
        })
    if not warheads:
        raise SystemExit(f'weapon {name} has no damage warhead')
    projectile = {'Bullet': 'bullet', 'Missile': 'missile', 'InstantHit': 'instant', 'TeslaZap': 'tesla', 'GravityBomb': 'bomb',
                  None: 'instant'}[ptype]
    speed = 0
    if isinstance(proj, dict) and projectile in ('bullet', 'missile'):
        speed = ints(proj.get('Speed', '213'))[0] if proj.get('Speed') else (213 if projectile == 'bullet' else 384)
    if projectile == 'bomb':
        # GravityBomb: falls straight down at Velocity (world units per tick, z component).
        speed = abs(ints(proj.get('Velocity', '0, 0, -50'))[2])
    return {
        'name': name,
        'range': wdist(w.get('Range')),
        'min_range': wdist(w.get('MinRange')),
        'reload': int(w.get('ReloadDelay', 1)),
        'burst': int(w.get('Burst', 1)),
        'burst_delays': ints(w['BurstDelays']) if 'BurstDelays' in w else [DEFAULT_BURST_DELAY],
        'projectile': projectile,
        'speed': speed,
        'inaccuracy': wdist(proj.get('Inaccuracy')) if isinstance(proj, dict) else 0,
        'arc': isinstance(proj, dict) and bool(proj.get('LaunchAngle')),
        'valid': target_mask(w.get('ValidTargets', 'Ground, Water')),
        'invalid': target_mask(w.get('InvalidTargets', '')),
        'warheads': warheads,
    }


def experience_info(t):
    """OpenRA GainsExperience with the rank bonuses its conditions switch on.

    RA's ^GainsExperience grants the stacking condition `rank-veteran` once per
    level (Conditions: experience thresholds as multiples of the actor's own
    value) and `rank-elite` from `rank-veteran >= 4` (GrantCondition@RANK-ELITE).
    Firepower, Damage, Speed and ReloadDelay multipliers and ChangesHealth@ELITE
    require those conditions; they are resolved here to one modifier per level
    (index 0 = level 1) and the first level that heals. Multipliers that require
    other conditions (Iron Curtain, the dog's run) are not part of veterancy.
    """
    g = t.get('GainsExperience')
    if g is None:
        return None
    g = g if isinstance(g, dict) else {}
    conds = g.get('Conditions') or {}
    names = set(conds.values())
    if len(names) != 1:
        raise SystemExit(f'GainsExperience conditions {conds} are not one stacking rank condition')
    rank = names.pop()
    thresholds = [int(k) for k in conds]  # YAML order: OpenRA grants them in this order
    granted = {}
    for v in trait(t, 'GrantCondition').values():
        m = re.fullmatch(rf'{re.escape(rank)} >= (\d+)', (v or {}).get('RequiresCondition', '')) if isinstance(v, dict) else None
        if m:
            granted[v['Condition']] = int(m.group(1))

    def level_test(cond):
        """A function level -> bool for a rank condition, or None when `cond` is not one."""
        m = re.fullmatch(rf'{re.escape(rank)} (==|>=) (\d+)', cond)
        if m:
            k = int(m.group(2))
            return (lambda n: n == k) if m.group(1) == '==' else (lambda n: n >= k)
        if cond in granted:
            return lambda n: n >= granted[cond]
        if rank in cond or any(c in cond for c in granted):
            raise SystemExit(f'unsupported rank condition {cond!r}')
        return None

    levels = range(1, len(thresholds) + 1)

    def modifiers(name):
        out = []
        for n in levels:
            value = 100
            for v in trait(t, name).values():
                test = level_test(v.get('RequiresCondition', '')) if isinstance(v, dict) else None
                if test and test(n):
                    value = value * int(v['Modifier']) // 100
            out.append(value)
        return out

    heal = None
    for v in trait(t, 'ChangesHealth').values():
        test = level_test(v.get('RequiresCondition', '')) if isinstance(v, dict) else None
        if not test:
            continue
        active = [n for n in levels if test(n)]
        if not active or active != list(range(active[0], len(thresholds) + 1)):
            raise SystemExit(f'rank heal condition {v.get("RequiresCondition")!r} is not "from a level up"')
        heal = {'rank': active[0], 'step': int(v.get('Step', 0)), 'percentage_step': int(v.get('PercentageStep', 0)),
                'delay': int(v.get('Delay', CHANGES_HEALTH_DELAY)),
                'start_if_below': int(v.get('StartIfBelow', CHANGES_HEALTH_START_IF_BELOW)),
                'damage_cooldown': int(v.get('DamageCooldown', 0))}
    return {'thresholds': thresholds, 'firepower': modifiers('FirepowerMultiplier'), 'damage': modifiers('DamageMultiplier'),
            'speed': modifiers('SpeedMultiplier'), 'reload': modifiers('ReloadDelayMultiplier'), 'heal': heal}


def gives_experience_info(t):
    """OpenRA GivesExperience: experience the killer of this actor gains (-1: its cost)."""
    if 'GivesExperience' not in t:
        return None
    g = t['GivesExperience'] if isinstance(t['GivesExperience'], dict) else {}
    return {'experience': int(g.get('Experience', GIVES_EXPERIENCE)),
            'actor_modifier': int(g.get('ActorExperienceModifier', ACTOR_EXPERIENCE_MODIFIER))}


def take_cover_info(t):
    """OpenRA TakeCover: infantry go prone when hit by a warhead with a trigger damage type."""
    if 'TakeCover' not in t:
        return None
    c = t['TakeCover'] if isinstance(t['TakeCover'], dict) else {}
    return {'duration': int(c.get('Duration', TAKE_COVER_DURATION)), 'speed_modifier': int(c.get('SpeedModifier', TAKE_COVER_SPEED)),
            'damage_triggers': tokens(c.get('DamageTriggers')),
            'damage_modifiers': [{'type': k, 'percent': int(v)} for k, v in (c.get('DamageModifiers') or {}).items()]}


def has_damage(w):
    return any(k.startswith('Warhead') and isinstance(v, dict) and v.get('_') in ('SpreadDamage', 'TargetDamage', 'HealthPercentageDamage')
               for k, v in w.items())


def footprint_rows(fp):
    return fp.split()


def first(t, name):
    """First trait instance named `name` (any @suffix) that has no RequiresCondition, or {}."""
    for k, v in trait(t, name).items():
        v = v if isinstance(v, dict) else {}
        if 'RequiresCondition' not in v:
            return v
    return {}


def has(t, name):
    return bool(trait(t, name))


# OpenRA UnitStance names as the engine spells them (rules.rs Stance).
STANCES = {'HoldFire': 'hold_fire', 'ReturnFire': 'return_fire', 'Defend': 'defend', 'AttackAnything': 'attack_anything'}


def stances(t):
    """AutoTarget [InitialStance, InitialStanceAI] (both default to AttackAnything), or None without AutoTarget."""
    if not has(t, 'AutoTarget'):
        return None
    at = first(t, 'AutoTarget')
    return [STANCES[str(at.get('InitialStance', 'AttackAnything'))], STANCES[str(at.get('InitialStanceAI', 'AttackAnything'))]]


def load_source_rules():
    """Resolved OpenRA actor rules from data/source (parse.py), keyed by actor name."""
    sys.path.insert(0, os.path.join(DATA, 'source'))
    import parse  # noqa: E402 (data/source/parse.py, only its parser is used)
    return parse


def resource_types(src):
    """Credits per bale (PlayerResources.ResourceValues) and the most bales a
    cell holds (ResourceLayer.ResourceTypes.*.MaxDensity) of ore and gems."""
    defs = src.load('rules', ['player', 'world'])
    values = src.to_json(defs['^BasePlayer'][1])['PlayerResources']['ResourceValues']
    types = src.to_json(defs['World'][1])['ResourceLayer']['ResourceTypes']
    names = ['Ore', 'Gems']
    return {n: int(values[n]) for n in names}, {n: int(types[n]['MaxDensity']) for n in names}


def beacon_duration(src):
    """Ticks a placed beacon stays (PlaceBeacon.Duration, default 750)."""
    defs = src.load('rules', ['player', 'world'])
    pb = src.to_json(defs['^BasePlayer'][1]).get('PlaceBeacon')
    return int(pb.get('Duration', 750)) if isinstance(pb, dict) else 750


def extra_actor(src, aid):
    """An actors.json-style record for a non-buildable actor, from the OpenRA YAML."""
    tree = src.rules[aid]
    t = src.to_json(tree)
    name = src.tr(src.g(tree, 'Tooltip/Name')) or aid
    return {
        'id': aid,
        'name': name,
        'description': '',
        'queue': 'Aircraft' if 'Aircraft' in t else 'Infantry' if 'Infantry' in t or 'Parachutable' in t else 'Vehicle',
        'cost': int(src.g(tree, 'Valued/Cost') or 0),
        'buildDuration': None,
        'buildDurationModifier': None,
        'buildPaletteOrder': 0,
        'prerequisites': ['~disabled'],
        'hp': int(src.g(tree, 'Health/HP') or 0),
        'armor': src.g(tree, 'Armor/Type'),
        'sight': src.g(tree, 'RevealsShroud/Range'),
        'traits': t,
    }


def main():
    actors = {a['id']: a for a in json.load(open(os.path.join(DATA, 'actors.json')))}
    src = load_source_rules()
    for aid in EXTRA_ACTORS:
        actors[aid] = extra_actor(src, aid)
    weapons = json.load(open(os.path.join(DATA, 'weapons.json')))
    wl = {k.lower(): k for k in weapons}
    locos = parse_locomotors()
    ids_lower = {k.lower(): k for k in actors}

    out_actors, used_weapons, used_locos = [], [], []

    def weapon_index(wname):
        wn = wl[wname.lower()]
        if wn not in used_weapons:
            used_weapons.append(wn)
        return used_weapons.index(wn)

    for aid in ACTORS + EXTRA_ACTORS:
        a = actors[aid]
        t = a['traits']
        kind = 'building' if 'Building' in t else 'mine' if 'Mine' in t else {'Infantry': 'infantry', 'Ship': 'ship', 'Aircraft': 'aircraft'}.get(a['queue'], 'vehicle')
        attack = first(t, 'AttackTurreted') or first(t, 'AttackFrontal') or first(t, 'AttackTesla') or first(t, 'AttackOmni')
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
            'build_at': (t['Buildable'].get('BuildAtProductionType') if isinstance(t.get('Buildable'), dict) else None) or a['queue'],
            'hp': a['hp'],
            'armor': ARMOR_TYPES.index(a['armor'] or 'None'),
            'sight': wdist(a['sight']),
            'weapons': [],
            'turret_turn_speed': int(first(t, 'Turreted').get('TurnSpeed', 512)) if has(t, 'Turreted') else None,
            'reload_override': int(t['AttackTesla']['ReloadDelay']) if 'AttackTesla' in t and isinstance(t['AttackTesla'], dict) and 'ReloadDelay' in t['AttackTesla'] else None,
            'requires_power': has(t, 'GrantConditionOnPowerState'),
            # Targetable as Defense: auto-targeted under every stance (AutoTargetPriority@DEFAULT).
            'defense': 'Defense' in target_types(t),
            'opportunity_fire': opportunity_fire(t),
            # BaseBuilding (Construction Yard, MCV): what the base hotkey cycles through.
            'base_building': 'BaseBuilding' in t,
            'death_weapon': None,
            'self_heal': None,
            # Forward/lateral offsets of each Turreted trait (render: ship turrets).
            'turret_offsets': [ints(v.get('Offset', '0,0,0'))[:2] for k, v in sorted(trait(t, 'Turreted').items()) if isinstance(v, dict)],
            # AutoTarget: [InitialStance, InitialStanceAI]; null without AutoTarget (never picks targets itself).
            'stance': stances(t),
            'abilities': {},
            # Veterancy (GainsExperience, GivesExperience) and prone infantry (TakeCover).
            'experience': experience_info(t),
            'gives_experience': gives_experience_info(t),
            'take_cover': take_cover_info(t) if kind == 'infantry' else None,
        }
        for slot, arm in trait(t, 'Armament').items():
            # Garrison weapons belong to the soldier inside, not the vehicle or building.
            if isinstance(arm, dict) and arm.get('Name') != 'garrisoned':
                e['weapons'].append(weapon_index(arm['Weapon']))
        death = t.get('FireWarheadsOnDeath')
        # Death explosions that only make visual effects (BuildingExplode) deal no damage: skip them.
        if kind != 'building' and isinstance(death, dict) and death.get('Weapon') and has_damage(weapons[wl[death['Weapon'].lower()]]):
            e['death_weapon'] = weapon_index(death['Weapon'])
        heal = first(t, 'ChangesHealth')
        if heal and int(heal.get('Step', 0)) > 0:
            # OpenRA ChangesHealthInfo defaults: StartIfBelow 50 (%), DamageCooldown 0.
            e['self_heal'] = {'step': int(heal['Step']), 'delay': int(heal.get('Delay', 5)),
                              'start_if_below': int(heal.get('StartIfBelow', 50)),
                              'damage_cooldown': int(heal.get('DamageCooldown', 0))}
        # Garrisoned defences (pillboxes) come with soldiers inside (Cargo.InitialUnits);
        # they fire those soldiers' garrison weapon.
        cargo = first(t, 'Cargo')
        if 'AttackGarrisoned' in t and cargo.get('InitialUnits'):
            for unit_id in tokens(cargo['InitialUnits']):
                for arm in trait(actors[ids_lower[unit_id.lower()]]['traits'], 'Armament').values():
                    if isinstance(arm, dict) and arm.get('Name') == 'garrisoned':
                        e['weapons'].append(weapon_index(arm['Weapon']))

        ab = e['abilities']
        if has(t, 'Cargo'):
            c = first(t, 'Cargo')
            # OpenRA CargoInfo defaults: BeforeUnloadDelay 8, AfterUnloadDelay 25,
            # EjectOnSell true, EjectOnDeath false.
            ab['cargo'] = {'types': tokens(c.get('Types')), 'max': int(c.get('MaxWeight', 1)),
                           'garrison': 'AttackGarrisoned' in t,
                           'initial': [ids_lower[x.lower()] for x in tokens(c.get('InitialUnits'))],
                           'before_unload_delay': int(c.get('BeforeUnloadDelay', 8)),
                           'after_unload_delay': int(c.get('AfterUnloadDelay', 25)),
                           'eject_on_sell': str(c.get('EjectOnSell', 'true')).lower() == 'true',
                           'eject_on_death': str(c.get('EjectOnDeath', 'false')).lower() == 'true'}
        if 'Minelayer' in t:
            pool = t.get('AmmoPool', {}) if isinstance(t.get('AmmoPool'), dict) else {}
            rearm = t.get('Rearmable', {}) if isinstance(t.get('Rearmable'), dict) else {}
            # AmmoPoolInfo defaults: ReloadDelay 50 ticks per ReloadCount (1) at a rearm actor.
            ab['minelayer'] = {'mine': t['Minelayer']['Mine'].upper(), 'ammo': int(pool.get('Ammo', 5)),
                               'reload_delay': int(pool.get('ReloadDelay', 50)),
                               'terrain': tokens(t['Minelayer'].get('TerrainTypes', 'Clear, Road')),
                               'rearm_actors': [ids_lower[x.lower()] for x in tokens(rearm.get('RearmActors')) if x.lower() in ids_lower]}
        if 'MineImmune' in t:
            ab['mine_immune'] = {}
        if 'AcceptsDeliveredCash' in t:
            ab['accepts_cash'] = {}
        # Iron Curtain (ExternalCondition@INVULNERABILITY): the Demolition Truck's
        # KillsSelf fires on it instead. Chronosphere: Chronoshiftable.
        if 'ExternalCondition@INVULNERABILITY' in t:
            ks = t.get('KillsSelf', {}) if isinstance(t.get('KillsSelf'), dict) else {}
            ab['iron_curtainable'] = {'kills': 'invulnerability' in ks.get('RequiresCondition', '')}
        if 'Chronoshiftable' in t:
            cs = t['Chronoshiftable'] if isinstance(t['Chronoshiftable'], dict) else {}
            ab['chronoshiftable'] = {'explode_instead': str(cs.get('ExplodeInstead', 'False')).lower() == 'true',
                                     'not_deployed': 'deployed' in cs.get('RequiresCondition', '')}
        if 'JamsMissiles' in t:
            ab['jams_missiles'] = {'range': wdist(t['JamsMissiles'].get('Range'))}
        if has(t, 'CreatesShroud'):
            ab['creates_shroud'] = {'range': wdist(next(iter(trait(t, 'CreatesShroud').values())).get('Range'))}
        if has(t, 'Cloak'):
            c = next(iter(trait(t, 'Cloak').values()))
            # OpenRA CloakInfo defaults: UncloakOn Attack, Unload, Infiltrate, Demolish, Dock; DetectionTypes Cloak.
            critical = any(isinstance(g, dict) and g.get('Condition') == c.get('PauseOnCondition') and 'Critical' in tokens(g.get('ValidDamageStates'))
                           for g in trait(t, 'GrantConditionOnDamageState').values())
            ab['cloak'] = {'initial_delay': int(c.get('InitialDelay', 10)), 'cloak_delay': int(c.get('CloakDelay', 30)),
                           'uncloak_on': tokens(c.get('UncloakOn', 'Attack, Unload, Infiltrate, Demolish, Dock')),
                           'types': tokens(c.get('DetectionTypes', 'Cloak')), 'off_when_critical': critical}
        if has(t, 'DetectCloaked'):
            d = next(iter(trait(t, 'DetectCloaked').values()))
            d = d if isinstance(d, dict) else {}
            ab['detect_cloaked'] = {'range': wdist(d.get('Range', '5c0')), 'types': tokens(d.get('DetectionTypes', 'Cloak')),
                                    'needs_power': 'disabled' in d.get('RequiresCondition', '')}
        # Vision through gap generator shroud: RevealsShroud instances that keep
        # the default RevealGeneratedShroud: True (e.g. RevealsShroud@GAPGEN).
        gap = [wdist(r.get('Range')) for r in trait(t, 'RevealsShroud').values()
               if isinstance(r, dict) and str(r.get('RevealGeneratedShroud', 'True')).lower() == 'true']
        if gap:
            ab['gap_sight'] = {'range': max(gap)}
        if 'PortableChrono' in t:
            c = t['PortableChrono'] if isinstance(t['PortableChrono'], dict) else {}
            ab['portable_chrono'] = {'charge_delay': int(c.get('ChargeDelay', 500)), 'max_distance': int(c.get('MaxDistance', 12))}
        if 'MadTank' in t:
            m = t['MadTank'] if isinstance(t['MadTank'], dict) else {}
            # MadTankInfo defaults: DetonationDelay 42, DriverActor e1.
            ab['mad_tank'] = {'charge_delay': int(m.get('ChargeDelay', 96)), 'thump_interval': int(m.get('ThumpInterval', 8)),
                              'detonation_delay': int(m.get('DetonationDelay', 42)), 'driver': ids_lower[m.get('DriverActor', 'e1').lower()],
                              'thump_weapon': weapon_index(m.get('ThumpDamageWeapon', 'MADTankThump')),
                              'detonation_weapon': weapon_index(m.get('DetonationWeapon', 'MADTankDetonate'))}
        if a['id'] == 'DTRK':
            ab['demo_truck'] = {}
        if 'DeliversCash' in t:
            ab['delivers_cash'] = {'payload': int(t['DeliversCash'].get('Payload', 500))}
        if has(t, 'Transforms'):
            tr = next(iter(trait(t, 'Transforms').values()))
            ab['transforms'] = {'into': ids_lower[tr['IntoActor'].lower()], 'offset': ints(tr.get('Offset', '0,0')),
                                'facing': int(tr.get('Facing', 384)), 'needs_option': 'RequiresCondition' in tr}
        if 'LineBuild' in t:
            ab['line_build'] = {'range': int(t['LineBuild'].get('Range', 5))}
        # Radar (OpenRA ProvidesRadar): an enemy Mobile Radar Jammer's
        # ProximityExternalCondition@JAMMER grants `jammed` to structures in range,
        # which switches off radar that requires `!jammed`.
        if has(t, 'ProvidesRadar'):
            pr = next(iter(trait(t, 'ProvidesRadar').values()))
            pr = pr if isinstance(pr, dict) else {}
            ab['provides_radar'] = {'jammable': 'jammed' in pr.get('RequiresCondition', '')}
        jam = [v for v in trait(t, 'ProximityExternalCondition').values() if isinstance(v, dict) and v.get('Condition') == 'jammed']
        if jam:
            ab['jams_radar'] = {'range': wdist(jam[0].get('Range'))}
        if 'Crushable' in t and isinstance(t['Crushable'], dict) and a['queue'] != 'Infantry':
            ab['crushable'] = tokens(t['Crushable'].get('CrushClasses'))
        if kind == 'infantry':
            ab['crushable'] = ['infantry']
        powers = []
        for k, v in t.items():
            base = k.split('@')[0]
            if base in ('ChronoshiftPower', 'GrantExternalConditionPower', 'NukePower', 'GpsPower', 'AirstrikePower', 'ParatroopersPower'):
                v = v if isinstance(v, dict) else {}
                power = {'key': k, 'kind': base, 'name': ftl.get(v.get('Name', ''), v.get('Name', base)),
                         'description': ftl.get(v.get('Description', ''), ''),
                         'charge': int(v.get('ChargeInterval', 0)), 'prerequisites': tokens(v.get('Prerequisites')),
                         'duration': int(v.get('Duration', 0)), 'range': int(ints(v.get('Range', '1'))[0]) if v.get('Range') and 'c' not in v.get('Range') else wdist(v.get('Range')) // 1024 if v.get('Range') else 1,
                         'max_distance': int(v.get('MaxDistance', 0) or 0),
                         'palette_order': int(v.get('SupportPowerPaletteOrder', 0) or 0)}
                if base in ('AirstrikePower', 'ParatroopersPower'):
                    # Aircraft powers: which plane flies in, how many, and what they drop.
                    unit = v.get('UnitType') or (AIRSTRIKE_UNIT if base == 'AirstrikePower' else PARATROOPERS_UNIT)
                    power['unit_type'] = ids_lower[unit.lower()]
                    power['squad_size'] = int(v.get('SquadSize', 1))
                    power['squad_offset'] = ints(v['SquadOffset'])[:2] if 'SquadOffset' in v else POWER_SQUAD_OFFSET
                    power['drop_items'] = [ids_lower[x.lower()] for x in tokens(v.get('DropItems'))]
                    power['camera_range'] = CAMERA_RANGE if v.get('CameraActor') else 0
                    power['camera_remove_delay'] = int(v.get('CameraRemoveDelay', POWER_CAMERA_REMOVE_DELAY))
                # Superweapons (abilities.rs). Defaults from OpenRA's ChronoshiftPowerInfo,
                # GrantExternalConditionPowerInfo, NukePowerInfo and GpsPowerInfo.
                if 'Footprint' in v:
                    power['footprint'] = footprint_rows(v['Footprint'])
                if base == 'ChronoshiftPower':
                    power['kill_cargo'] = str(v.get('KillCargo', 'True')).lower() == 'true'
                if base == 'NukePower':
                    power['missile_weapon'] = weapon_index(v.get('MissileWeapon', 'atomic'))
                    power['missile_delay'] = int(v.get('MissileDelay', 0))
                    power['flight_delay'] = int(v.get('FlightDelay', 400))
                    power['camera_range'] = wdist(v.get('CameraRange', '0'))
                    power['camera_spawn_advance'] = int(v.get('CameraSpawnAdvance', 25))
                    power['camera_remove_delay'] = int(v.get('CameraRemoveDelay', 25))
                if base == 'GpsPower':
                    power['reveal_delay'] = int(v.get('RevealDelay', 0))
                power['one_shot'] = str(v.get('OneShot', 'False')).lower() == 'true'
                powers.append(power)
        if powers:
            ab['support_powers'] = powers

        if kind == 'building':
            b = t['Building']
            w, h = ints(b['Dimensions'])
            rows = footprint_rows(b['Footprint'])
            assert len(rows) == h and all(len(r) == w for r in rows), aid
            e['building'] = {
                'width': w,
                'height': h,
                'footprint': rows,
                'terrain': tokens(b.get('TerrainTypes', 'Clear,Road')),
                'requires_base_provider': str(b.get('RequiresBaseProvider', 'False')).lower() == 'true',
                'power': sum(int(p.get('Amount', 0)) for p in trait(t, 'Power').values()),
                'power_scales_with_health': 'ScalePowerWithHealth' in t,
                'produces': tokens(t.get('Production', {}).get('Produces', '')) if 'Production' in t else [],
                'exits': [ints(x['ExitCell']) for k, x in sorted(trait(t, 'Exit').items()) if isinstance(x, dict) and 'ExitCell' in x],
                'gives_buildable_area': 'GivesBuildableArea' in t,
                'base_provider_range': wdist(t['BaseProvider']['Range']) if 'BaseProvider' in t else 0,
                'adjacent': int(b.get('Adjacent', 2)),
                'storage': int(t['StoresPlayerResources']['Capacity']) if isinstance(t.get('StoresPlayerResources'), dict) else 0,
                'sell_refund': int(t['Sellable'].get('RefundPercent', 50)) if isinstance(t.get('Sellable'), dict) else (50 if 'Sellable' in t else 0),
                'provides': {},
            }
            # Static prerequisite resolution per faction. A provider with
            # RequiresPrerequisites only counts when those tokens come from a
            # Factions-filtered provider of the same faction.
            for f in FACTIONS:
                base = set()
                faction_tokens = set()
                for other in ACTORS:
                    for p in trait(actors[other]['traits'], 'ProvidesPrerequisite').values():
                        if isinstance(p, dict) and f in tokens(p.get('Factions')):
                            faction_tokens.add(p.get('Prerequisite'))
                for k, p in trait(t, 'ProvidesPrerequisite').items():
                    p = p if isinstance(p, dict) else {}
                    fs = tokens(p.get('Factions'))
                    if fs and f not in fs:
                        continue
                    req = tokens(p.get('RequiresPrerequisites'))
                    if req and not all(r in faction_tokens for r in req):
                        continue
                    base.add(p.get('Prerequisite') or aid.lower())
                e['building']['provides'][f] = sorted(base)
            if 'Refinery' in t:
                d = t['DockHost']
                e['building']['refinery'] = {
                    'dock_offset': [wdist(x) for x in d['DockOffset'].split(',')][:2],
                    'free_actor': t['FreeActor']['Actor'],
                    'free_actor_offset': ints(t['FreeActor']['SpawnOffset']),
                }
            if 'RepairsUnits' in t:
                r = t['RepairsUnits'] if isinstance(t['RepairsUnits'], dict) else {}
                # OpenRA RepairsUnitsInfo defaults.
                e['building']['repairs'] = {
                    'hp_per_step': int(r.get('HpPerStep', 1000)),
                    'interval': int(r.get('Interval', 24)),
                    'value_percent': int(r.get('ValuePercent', 20)),
                }
            # Repair button (OpenRA RepairableBuilding, repair.rs). RA sets
            # RepairStep 700 on ^Building; the rest are RepairableBuildingInfo defaults.
            rb = first(t, 'RepairableBuilding')
            if has(t, 'RepairableBuilding'):
                e['building']['repairable'] = {
                    'percent': int(rb.get('RepairPercent', 20)),
                    'interval': int(rb.get('RepairInterval', 24)),
                    'step': int(rb.get('RepairStep', 7)),
                    'bonuses': ints(rb.get('RepairBonuses', '100, 150, 175, 200, 220, 240, 260, 280, 300')),
                }
            # Power down button (OpenRA ToggleConditionOnOrder with OrderName
            # PowerDown, ^DisableOnLowPowerOrPowerDown): the `powerdown` condition
            # zeroes the power drain (PowerMultiplier@POWERDOWN) and disables the
            # building like low power does (repair.rs).
            e['building']['power_down'] = any(isinstance(v, dict) and v.get('OrderName') == 'PowerDown'
                                              for v in trait(t, 'ToggleConditionOnOrder').values())
            # OpenRA GetSellValue: CustomSellValue, else the cost (repair cost, repair.rs).
            csv = t.get('CustomSellValue')
            e['building']['value'] = int(csv.get('Value', a['cost'])) if isinstance(csv, dict) else a['cost']
            lco = t['Building'].get('LocalCenterOffset')
            e['building']['center_offset'] = ints(lco)[:2] if lco else [0, 0]
        elif kind == 'mine':
            pass  # Immobile: no unit info.
        else:
            if kind == 'aircraft':
                # Aircraft have no Mobile trait: they fly over everything.
                m = t['Aircraft']
                loco = AIR_LOCOMOTOR
            else:
                m = t['Mobile']
                loco = m['Locomotor']
            if loco not in used_locos:
                used_locos.append(loco)
            e['unit'] = {
                'speed': int(m['Speed']),
                'turn_speed': int(m.get('TurnSpeed', 512)),
                'turn_in_place': str(m.get('AlwaysTurnInPlace', 'false')).lower() == 'true' or kind == 'infantry',
                'locomotor': used_locos.index(loco),
                'radius': 128 if kind == 'infantry' else (512 if a['cost'] >= 1500 and aid != 'DTRK' else 384),
                'passenger': t.get('Passenger', {}).get('CargoType') if isinstance(t.get('Passenger'), dict) else None,
                # OpenRA PassengerInfo.Weight default 1.
                'passenger_weight': int(t['Passenger'].get('Weight', 1)) if isinstance(t.get('Passenger'), dict) else 1,
            }
            # Where the unit is repaired: Repairable (on the pad) or RepairableNear (ships, within range).
            rep = t.get('RepairableNear') if isinstance(t.get('RepairableNear'), dict) else t.get('Repairable') if isinstance(t.get('Repairable'), dict) else {}
            e['unit']['repair_at'] = [ids_lower[x.lower()] for x in tokens(rep.get('RepairActors')) if x.lower() in ids_lower]
            e['unit']['repair_near'] = isinstance(t.get('RepairableNear'), dict)
            if kind == 'aircraft':
                ammo = t.get('AmmoPool') if isinstance(t.get('AmmoPool'), dict) else {}
                rearm = t.get('Rearmable') if isinstance(t.get('Rearmable'), dict) else {}
                can_hover = str(m.get('CanHover', 'false')).lower() == 'true'
                repairable = t.get('Repairable') if isinstance(t.get('Repairable'), dict) else {}
                e['unit']['aircraft'] = {
                    'cruise_altitude': wdist(m.get('CruiseAltitude', '1c0')),
                    'can_hover': can_hover,
                    'vtol': str(m.get('VTOL', 'false')).lower() == 'true',
                    'landable': tokens(m.get('LandableTerrainTypes', '')),
                    'ammo': int(ammo.get('Ammo', 0) or 0),
                    'rearm_actors': [ids_lower[x.lower()] for x in tokens(rearm.get('RearmActors')) if x.lower() in ids_lower],
                    # AmmoPool: one reload step (ReloadCount rounds) every ReloadDelay ticks while resupplying.
                    'reload_delay': int(ammo.get('ReloadDelay', AMMO_RELOAD_DELAY)),
                    'reload_count': int(ammo.get('ReloadCount', AMMO_RELOAD_COUNT)),
                    'repair_actors': [ids_lower[x.lower()] for x in tokens(repairable.get('RepairActors')) if x.lower() in ids_lower],
                    'altitude_velocity': wdist(m.get('AltitudeVelocity', ALTITUDE_VELOCITY)),
                    'wait_distance': wdist(m.get('WaitDistanceFromResupplyBase', WAIT_DISTANCE_FROM_RESUPPLY)),
                    'take_off_on_resupply': str(m.get('TakeOffOnResupply', 'false')).lower() == 'true',
                    'facing_tolerance': int(first(t, 'AttackAircraft').get('FacingTolerance', FACING_TOLERANCE)),
                    # Forward offsets of the rotors shown while airborne (WithIdleOverlay@ROTOR*).
                    # WithAmmoPipsDecoration.PipCount (defaults to one pip per round).
                    'ammo_pips': int(first(t, 'WithAmmoPipsDecoration').get('PipCount', ammo.get('Ammo', 0) or 0)),
                    'rotors': [ints(v.get('Offset', '0'))[0] for k, v in sorted(trait(t, 'WithIdleOverlay').items())
                               if isinstance(v, dict) and v.get('RequiresCondition') == 'airborne'],
                    # ParaDrop.DropRange: paratroopers jump within this distance of the target.
                    'drop_range': wdist(t['ParaDrop'].get('DropRange', '4c0')) if isinstance(t.get('ParaDrop'), dict) else 0,
                    # Airborne planes leave a husk that falls (FallsToEarth of ^PlaneHusk) and explodes.
                    'crash_velocity': 0,
                    'crash_weapon': None,
                }
                if not can_hover and has(t, 'SpawnActorOnDeath'):
                    falls = src.to_json(src.rules['^PlaneHusk'])['FallsToEarth']
                    e['unit']['aircraft']['crash_velocity'] = int(falls['Velocity'])
                    e['unit']['aircraft']['crash_weapon'] = weapon_index(falls['Explosion'])
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

    for e in out_actors:
        for field, value in OVERRIDES.get(e['id'], {}).items():
            assert field in e, f'override of unknown field {e["id"]}.{field}'
            e[field] = value

    # Resolve refinery free actors to ids that exist in the export.
    for e in out_actors:
        r = e.get('building', {}).get('refinery')
        if r:
            r['free_actor'] = ids_lower[r['free_actor'].lower()]

    values, densities = resource_types(src)
    for l in used_locos:
        # Gems cells move like ore cells (the engine has one speed class for both).
        if l != AIR_LOCOMOTOR:
            assert locos[l].get('Gems', 0) == locos[l].get('Ore', 0), f'locomotor {l}: Gems and Ore speeds differ'
    player = {
        'starting_cash': 5000,           # OpenRA lobby default
        'ore_value': values['Ore'],      # PlayerResources.ResourceValues.Ore
        'low_power_modifier': 300,       # ClassicProductionQueue.LowPowerModifier
        # ClassicProductionQueue.BuildTimeSpeedReduction default
        'speed_reduction': [100, 85, 75, 65, 60, 55, 50],
        'ore_max_density': densities['Ore'],  # ResourceLayer.ResourceTypes.Ore.MaxDensity
        'gem_value': values['Gems'],     # PlayerResources.ResourceValues.Gems
        'gem_max_density': densities['Gems'],  # ResourceLayer.ResourceTypes.Gems.MaxDensity
        'beacon_duration': beacon_duration(src),  # PlaceBeacon.Duration (beacons.rs)
    }
    rules = {
        'source': 'OpenRA mods/ra (bleed), generated by tools/gen_rules.py',
        'armor_types': ARMOR_TYPES,
        'terrain_types': TERRAIN_TYPES,
        'factions': FACTIONS,
        'player': player,
        'actors': out_actors,
        'weapons': [weapon_info(w, weapons) for w in used_weapons],
        'locomotors': [locomotor_info(l, locos) for l in used_locos],
    }
    with open(OUT, 'w') as fh:
        json.dump(rules, fh, indent=1)
    print(f'wrote {OUT}: {len(out_actors)} actors, {len(used_weapons)} weapons, {len(used_locos)} locomotors')


ftl = load_ftl()

if __name__ == '__main__':
    main()
