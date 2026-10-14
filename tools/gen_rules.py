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
# WebRA's own actors (WEBRA_ACTORS); missions point DATA elsewhere, never this.
WEBRA_RULES = os.path.join(ROOT, 'data', 'webra', 'rules.yaml')

# Actors that are part of the current milestone.
ACTORS = [
    # Buildings and defences
    'FACT', 'POWR', 'APWR', 'PROC', 'SILO', 'TENT', 'BARR', 'KENN', 'WEAP', 'FIX', 'DOME', 'HPAD', 'AFLD', 'AFLD.Ukraine',
    'SYRD', 'SPEN', 'ATEK', 'STEK', 'GAP', 'PDOX', 'IRON', 'MSLO',
    'SBAG', 'FENC', 'BRIK', 'PBOX', 'HBOX', 'GUN', 'FTUR', 'TSLA', 'AGUN', 'SAM',
    # France: decoy structures
    'FPWR', 'TENF', 'SYRF', 'WEAF', 'DOMF', 'FIXF', 'FAPW', 'ATEF', 'PDOF', 'MSLF', 'FACF',
    # Infantry
    'E1', 'E2', 'E3', 'E4', 'E6', 'E7', 'DOG', 'MEDI', 'MECH', 'SPY', 'SPY.England', 'THF', 'SHOK',
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
    # Crates (misc.yaml): CRATE is what the CrateSpawner drops; the others are
    # for maps that place crates (OpenRA mission crates).
    'CRATE', 'MONEYCRATE', 'HEALCRATE', 'WCRATE', 'SCRATE',
    # Ground vehicle wrecks (data/source/rules/husks.yaml, SpawnActorOnDeath).
    '2TNK.Husk', '3TNK.Husk', '4TNK.Husk', 'HARV.EmptyHusk', 'HARV.FullHusk', 'MCV.Husk', 'MGG.Husk',
    # Proxies (OpenRA InfiltrateForSupportPower.Proxy, data/source/rules/misc.yaml):
    # player-level actors a spy grants by infiltrating a structure. They have
    # no body: the engine keeps them per player (infantry.rs) for their
    # prerequisites and support powers.
    'barracks.upgraded', 'vehicles.upgraded', 'aircraft.upgraded', 'powerproxy.sonarpulse',
    'SPEF',                    # France's fake Sub Pen: map-only (OpenRA Prerequisites ~disabled)
]
# WebRA's own actors (no OpenRA counterpart), defined in data/webra/rules.yaml
# in OpenRA's MiniYaml and resolved against OpenRA's templates (webra_actor).
# They come last, so adding one never moves the index of an OpenRA actor.
WEBRA_ACTORS = [
    'LROD',                    # Lightning Rod (engine/src/lightning.rs)
]
PROXIES = {'barracks.upgraded', 'vehicles.upgraded', 'aircraft.upgraded', 'powerproxy.sonarpulse'}
# The neutral world of OpenRA maps (data/source/rules/civilian.yaml,
# decoration.yaml, husks.yaml, misc.yaml and the map-only walls of
# structures.yaml): civilians, civilian and tech buildings, barrels, bridges,
# trees, rocks and ore mines. Never built (`~disabled`); maps place them, and
# the engine spawns some (tree husks, bridge huts). See engine/src/neutral.rs.
WORLD_ACTORS = [
    # Civilians
    'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'TECN', 'TECN2',
    # Tech buildings
    'FCOM', 'HOSP', 'BIO', 'MISS', 'OILB',
    # Civilian buildings, fields and huts
    'V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16',
    'V17', 'V18', 'V19', 'V19.Husk', 'V20', 'V21', 'V22', 'V23', 'V24', 'V25', 'V26', 'V27', 'V28', 'V29', 'V30',
    'V31', 'V32', 'V33', 'V34', 'V35', 'V36', 'V37', 'RICE', 'RUSHOUSE', 'ASIANHUT', 'SNOWHUT', 'LHUS', 'WINDMILL',
    'RAILMINE', 'CTFLAG',
    # Barrels and ammo boxes
    'BARL', 'BRL3', 'AMMOBOX1', 'AMMOBOX2', 'AMMOBOX3',
    # Bridges (OpenRA LegacyBridgeLayer) and their huts
    'BRIDGE1', 'BRIDGE2', 'BRIDGE3', 'BRIDGE4', 'SBRIDGE1', 'SBRIDGE2', 'SBRIDGE3', 'SBRIDGE4', 'BR1', 'BR2', 'BR3',
    'BRIDGEHUT', 'BRIDGEHUT.small',
    # Trees, their husks and other decorations
    'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16',
    'T17', 'TC01', 'TC02', 'TC03', 'TC04', 'TC05',
    'T01.Husk', 'T02.Husk', 'T03.Husk', 'T04.Husk', 'T05.Husk', 'T06.Husk', 'T07.Husk', 'T08.Husk', 'T09.Husk',
    'T10.Husk', 'T11.Husk', 'T12.Husk', 'T13.Husk', 'T14.Husk', 'T15.Husk', 'T16.Husk', 'T17.Husk', 'TC01.Husk',
    'TC02.Husk', 'TC03.Husk', 'TC04.Husk', 'TC05.Husk',
    'BOXES01', 'BOXES02', 'BOXES03', 'BOXES04', 'BOXES05', 'BOXES06', 'BOXES07', 'BOXES08', 'BOXES09',
    'ICE01', 'ICE02', 'ICE03', 'ICE04', 'ICE05', 'ROCK1', 'ROCK2', 'ROCK3', 'ROCK4', 'ROCK5', 'ROCK6', 'ROCK7',
    'UTILPOL1', 'UTILPOL2', 'TANKTRAP1', 'TANKTRAP2',
    # Ore and gem mines (SeedsResource)
    'MINE', 'GMINE',
    # Walls only maps place
    'CYCL', 'BARB', 'WOOD',
]
# Reveal range of OpenRA's support power camera actors: OpenRA's CAMERA actor
# (mods/ra/rules/misc.yaml) reveals 10c0 and the power cameras inherit it.
CAMERA_RANGE = 10 * 1024
# OpenRA defaults of AirstrikePowerInfo / ParatroopersPowerInfo.
AIRSTRIKE_UNIT = 'badr.bomber'
PARATROOPERS_UNIT = 'badr'
POWER_SQUAD_OFFSET = [-1536, 1536]
POWER_CAMERA_REMOVE_DELAY = 25
FACTIONS = ['allies', 'england', 'france', 'germany', 'soviet', 'russia', 'ukraine']
ARMOR_TYPES = ['None', 'Wood', 'Light', 'Heavy', 'Concrete', 'Tree']
# Locomotor speed columns (engine map.rs SPEED_*); Gems move like Ore. River,
# Rock, Tree and Wall cells are impassable for every locomotor.
TERRAIN_TYPES = ['Clear', 'Rough', 'Ore', 'Water', 'Road', 'Bridge', 'Beach']
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
PLAYER_EXPERIENCE_MODIFIER = 0      # GivesExperienceInfo.PlayerExperienceModifier (percent)
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


# Weapons and locomotors to number first (tools/gen_missions.py sets them).
WEAPON_ORDER = []
LOCOMOTOR_ORDER = []


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
        # Continuation lines of a multi-line value are indented (4 spaces or more).
        if line.startswith('    ') and line.strip() and attr:
            out[attr] = (out[attr] + ' ' + line.strip()).strip()
    return out


AIR_LOCOMOTOR = 'air'
# OpenRA LocomotorInfo.WaitAverage default: ticks a blocked move waits.
LOCOMOTOR_WAIT_AVERAGE = 40


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
        # Cell sharing (infantry: five sub-cells) and the ticks a blocked
        # move waits for its blocker (movement/cellmove.rs).
        m = re.match(r'^\t\t(SharesCell|WaitAverage): (\S+)', line)
        if cur and m:
            key = '_shares_cell' if m.group(1) == 'SharesCell' else '_wait_average'
            locos[cur][key] = m.group(2).lower() == 'true' if key == '_shares_cell' else int(m.group(2))
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
               'Air': 8, 'WaterActor': 16, 'Water': 16, 'Ground': 256, 'Underwater': 64, 'Bridge': 0,
               # Trees (and boxes, ice floes, utility poles: ^Tree) are only
               # hit by warheads that list Trees (fire, V2, nukes, barrels).
               'Trees': 1024,
               # Submarine is its own class (surfaced and submerged subs): depth charge
               # warheads hit it, while Underwater only matches submerged subs.
               'Ship': 16, 'Submarine': 128,
               'DetonateAttack': 1 | 2 | 4, 'Wall': 4, 'Mine': 32, 'Husk': 0, 'Creep': 0,
               # Damaged infantry (Targetable@HEAL) and damaged vehicles, ships and
               # landed aircraft (Targetable@REPAIR): what the Medic's Heal and the
               # Mechanic's Repair weapons fire at. The engine adds them to an
               # actor's classes while it is damaged (combat.rs target_class).
               'Heal': 2048, 'Repair': 4096}


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
        return {'name': name, 'domain': 'air', 'speeds': [100] * len(TERRAIN_TYPES), 'crushes': [],
                'shares_cell': False, 'wait_average': LOCOMOTOR_WAIT_AVERAGE}
    l = locos[name]
    speeds = [l.get(tt, 0) for tt in TERRAIN_TYPES]
    on_land = any(speeds[:3])
    on_water = speeds[3] > 0
    domain = 'water' if on_water and not on_land else 'ground'
    return {'name': name, 'domain': domain, 'speeds': speeds, 'crushes': l['_crushes'],
            'shares_cell': l.get('_shares_cell', False), 'wait_average': l.get('_wait_average', LOCOMOTOR_WAIT_AVERAGE)}


# Warheads that change no health (combat.rs `land_shot`, smudges.rs): smudges
# (presentation), resources destroyed or created (gameplay), screen shake and
# the nuke flash (presentation).
EFFECT_WARHEADS = {'LeaveSmudge': 'smudge', 'DestroyResource': 'destroy_resource', 'CreateResource': 'create_resource',
                   'ShakeScreen': 'shake', 'FlashEffect': 'flash'}


def spread_and_falloff(name, v):
    """SpreadDamage Spread and Falloff, or its explicit Range list (equally
    spaced from 0, e.g. CivPanicExplosion's `0, 128`) as the same spread."""
    falloff = ints(v['Falloff']) if 'Falloff' in v else DEFAULT_FALLOFF
    if 'Range' not in v:
        return wdist(v.get('Spread', 43)), falloff
    ranges = [wdist(x) for x in tokens(v['Range'])]
    step = ranges[1] - ranges[0] if len(ranges) > 1 else 0
    if ranges[0] != 0 or step <= 0 or any(b - a != step for a, b in zip(ranges, ranges[1:])) or len(ranges) != len(falloff):
        raise SystemExit(f'weapon {name}: Range {v["Range"]} is not equally spaced from 0 with one Falloff each')
    return step, falloff


def cluster_info(name, v, weapon_index):
    """OpenRA FireClusterWarhead: `Weapon` fired at the X cells of a
    footprint centred on the impact cell (as cell offsets); x cells are
    picked at random RandomClusterCount times (-1: once per x cell)."""
    dims = ints(v['Dimensions'])
    rows = v['Footprint'].split()
    if len(rows) != dims[1] or any(len(r) != dims[0] for r in rows):
        raise SystemExit(f'weapon {name}: cluster footprint does not match its dimensions')
    ox, oy = (dims[0] - 1) // 2, (dims[1] - 1) // 2
    cells = [[x - ox, y - oy] for y, r in enumerate(rows) for x, c in enumerate(r) if c == 'X']
    random_cells = [[x - ox, y - oy] for y, r in enumerate(rows) for x, c in enumerate(r) if c == 'x']
    count = int(v.get('RandomClusterCount', -1))
    return {'weapon': weapon_index(v['Weapon']), 'cells': cells, 'random_cells': random_cells,
            'random_count': len(random_cells) if count < 0 else count}


def missile_range_limit(w, proj):
    """OpenRA Missile: RangeLimit, else the weapon's Range. Out of fuel it
    explodes there (ExplodeWhenEmpty, default true); with ExplodeWhenEmpty
    false OpenRA lets it fall without homing, which the engine's flat
    projectiles approximate by the same burst where the fuel ran out."""
    limit = wdist(proj.get('RangeLimit'))
    return limit if limit > 0 else wdist(w.get('Range'))


def weapon_info(name, weapons, weapon_index):
    w = weapons[name]
    proj = w.get('Projectile', {})
    ptype = proj.get('_') if isinstance(proj, dict) else proj
    warheads = []
    clusters = []
    for k, v in w.items():
        if not (k.startswith('Warhead') and isinstance(v, dict)):
            continue
        kind = v.get('_')
        if kind == 'FireCluster':
            clusters.append(cluster_info(name, v, weapon_index))
            continue
        if kind not in ('SpreadDamage', 'TargetDamage', 'HealthPercentageDamage'):
            continue
        versus = v.get('Versus', {})
        spread, falloff = spread_and_falloff(name, v)
        warheads.append({
            'kind': {'SpreadDamage': 'spread', 'TargetDamage': 'target', 'HealthPercentageDamage': 'percent'}[kind],
            # WarheadInfo.ValidRelationships (default all): the Heal and Repair warheads only touch allies.
            'relationships': relationship_mask(v.get('ValidRelationships', 'Ally, Neutral, Enemy')),
            'damage': int(v.get('Damage', 0)),
            'spread': spread,
            'falloff': falloff,
            'versus': [int(versus.get(a, 100)) for a in ARMOR_TYPES],
            'delay': int(v.get('Delay', 0)),
            'valid': target_mask(v.get('ValidTargets', 'Ground, Water')) or (1 | 2 | 4 | 16),
            'invalid': target_mask(v.get('InvalidTargets', '')),
            # DamageTypes: TakeCover reacts to them (TriggerProne, Prone50Percent).
            'damage_types': tokens(v.get('DamageTypes')),
        })
    if not warheads:
        raise SystemExit(f'weapon {name} has no damage warhead')
    effects = []
    for k, v in w.items():
        if not (k.startswith('Warhead') and isinstance(v, dict)) or v.get('_') not in EFFECT_WARHEADS:
            continue
        kind = EFFECT_WARHEADS[v['_']]
        size = ints(v.get('Size', '0'))
        e = {'kind': kind, 'delay': int(v.get('Delay', 0)),
             # Warhead.ValidTargets / InvalidTargets defaults: Ground, Water / none.
             'valid': target_mask(v.get('ValidTargets', 'Ground, Water')), 'invalid': target_mask(v.get('InvalidTargets', '')),
             # Size: outer and inner radius in cells (FindTilesInAnnulus).
             'size': [size[0], size[1] if len(size) > 1 else 0]}
        if kind == 'smudge':
            e['smudge_types'] = tokens(v.get('SmudgeType'))
            e['chance'] = int(v.get('Chance', 100))
        elif kind == 'destroy_resource':
            e['amount'] = int(v.get('ResourceAmount', 0))
            e['resource_types'] = tokens(v.get('ResourceTypes'))
        elif kind == 'create_resource':
            e['resource_types'] = [v['AddsResourceType']]
        elif kind == 'shake':
            e['duration'] = int(v.get('Duration', 0))
            e['intensity'] = int(v.get('Intensity', 0))
            e['multiplier'] = ints(v.get('Multiplier', '0,0'))[:2]
        elif kind == 'flash':
            e['duration'] = int(v['Duration'])
            e['flash_type'] = v.get('FlashType') or ''
        effects.append(e)
    projectile = {'Bullet': 'bullet', 'Missile': 'missile', 'InstantHit': 'instant', 'TeslaZap': 'tesla', 'GravityBomb': 'bomb',
                  None: 'instant'}[ptype]
    speed = 0
    if isinstance(proj, dict) and projectile in ('bullet', 'missile'):
        speed = wdist(tokens(proj['Speed'])[0]) if proj.get('Speed') else (213 if projectile == 'bullet' else 384)
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
        # Missile RangeLimit (default: the weapon's Range): it explodes once it
        # has flown that far (combat.rs tick_projectiles). 0: no limit.
        'range_limit': missile_range_limit(w, proj) if projectile == 'missile' else 0,
        'arc': isinstance(proj, dict) and bool(proj.get('LaunchAngle')),
        'valid': target_mask(w.get('ValidTargets', 'Ground, Water')),
        'invalid': target_mask(w.get('InvalidTargets', '')),
        'warheads': warheads,
        'clusters': clusters,
        'effects': effects,
    }


# OpenRA PlayerRelationship as bits (rules.rs RELATION_*).
RELATIONSHIPS = {'None': 0, 'Ally': 1, 'Neutral': 2, 'Enemy': 4}


def relationship_mask(v):
    return sum(RELATIONSHIPS[x] for x in tokens(v))


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
            'actor_modifier': int(g.get('ActorExperienceModifier', ACTOR_EXPERIENCE_MODIFIER)),
            # PlayerExperienceModifier: percent of the value the killing player gains
            # (OpenRA PlayerExperience, the time limit's tie breaker).
            'player_modifier': int(g.get('PlayerExperienceModifier', PLAYER_EXPERIENCE_MODIFIER))}


def take_cover_info(t):
    """OpenRA TakeCover: infantry go prone when hit by a warhead with a trigger damage type."""
    if 'TakeCover' not in t:
        return None
    c = t['TakeCover'] if isinstance(t['TakeCover'], dict) else {}
    return {'duration': int(c.get('Duration', TAKE_COVER_DURATION)), 'speed_modifier': int(c.get('SpeedModifier', TAKE_COVER_SPEED)),
            'damage_triggers': tokens(c.get('DamageTriggers')),
            'damage_modifiers': [{'type': k, 'percent': int(v)} for k, v in (c.get('DamageModifiers') or {}).items()]}


def must_be_destroyed(t):
    """MustBeDestroyed: None without it, else its RequiredForShortGame (default false)."""
    if 'MustBeDestroyed' not in t:
        return None
    m = t['MustBeDestroyed'] if isinstance(t['MustBeDestroyed'], dict) else {}
    return str(m.get('RequiredForShortGame', 'false')).lower() == 'true'


def owner_lost(t):
    """OwnerLostAction.Action (default Kill) in snake case, or None without the trait."""
    if 'OwnerLostAction' not in t:
        return None
    o = t['OwnerLostAction'] if isinstance(t['OwnerLostAction'], dict) else {}
    return {'Kill': 'kill', 'Dispose': 'dispose', 'ChangeOwner': 'change_owner'}[o.get('Action', 'Kill')]


def gives_bounty(t):
    """GivesBounty.Percentage (default 10) of the actor's value, or None without the trait."""
    if 'GivesBounty' not in t:
        return None
    g = t['GivesBounty'] if isinstance(t['GivesBounty'], dict) else {}
    if g.get('RequiresCondition', 'global-bounty') != 'global-bounty':
        raise SystemExit(f'GivesBounty condition {g.get("RequiresCondition")!r} is not the lobby option')
    return int(g.get('Percentage', 10))


def spawn_on_death(t, kind, ids_lower):
    """SpawnActorOnDeath of a ground actor: the husk it leaves. Aircraft husks
    (RequiresCondition: airborne) fall and explode instead (plane.rs, helicopter.rs)."""
    s = first(t, 'SpawnActorOnDeath')
    if not s or kind == 'aircraft':
        return None
    return ids_lower[s['Actor'].lower()]


def full_husk(t, ids_lower):
    """HarvesterHuskModifier: [husk of a harvester at least FullnessThreshold percent full, threshold]."""
    h = t.get('HarvesterHuskModifier')
    if not isinstance(h, dict):
        return None
    return [ids_lower[h['FullHuskActor'].lower()], int(h.get('FullnessThreshold', 50))]


SELL_VALUE_PERCENT = 40             # SpawnActorsOnSellInfo.ValuePercent
SELL_MIN_HP_PERCENT = 30            # SpawnActorsOnSellInfo.MinHpPercent


def sell_survivors(t):
    """SpawnActorsOnSell: the crew that leaves a sold structure. Actor names are
    kept as OpenRA spells them (upper case); the engine skips types it does not
    have, so the list fills in as more infantry is added."""
    s = t.get('SpawnActorsOnSell')
    if not isinstance(s, dict):
        return None
    return {'actor_types': [x.upper() for x in tokens(s.get('ActorTypes'))],
            'guaranteed': [x.upper() for x in tokens(s.get('GuaranteedActorTypes'))],
            'value_percent': int(s.get('ValuePercent', SELL_VALUE_PERCENT)),
            'min_hp_percent': int(s.get('MinHpPercent', SELL_MIN_HP_PERCENT)),
            'factions': tokens(s.get('Factions'))}


def shake_on_death(t):
    """ShakeOnDeath [Duration, Intensity] (defaults 10, 1), or None."""
    if 'ShakeOnDeath' not in t:
        return None
    s = t['ShakeOnDeath'] if isinstance(t['ShakeOnDeath'], dict) else {}
    return [int(s.get('Duration', 10)), int(s.get('Intensity', 1))]


def unit_radius(aid, cost):
    """Hit radius of a unit (world units): the heuristic of the unit export below."""
    return 512 if cost >= 1500 and aid != 'DTRK' else 384


def husk_info(t, actors, ids_lower, locos):
    """^Husk: a wreck that blocks its cell and burns down (ChangesHealth with a
    negative step), only force-fire targets it, and it can be captured back
    (Capturable husk, TransformOnCapture, InfiltrateForTransform)."""
    h = t['Husk'] if isinstance(t['Husk'], dict) else {}
    burn = first(t, 'ChangesHealth')
    into = ids_lower[t['TransformOnCapture']['IntoActor'].lower()] if isinstance(t.get('TransformOnCapture'), dict) else None
    cap = first(t, 'Capturable') if has(t, 'Capturable') else None
    inf = t.get('InfiltrateForTransform') if isinstance(t.get('InfiltrateForTransform'), dict) else None
    loco = h.get('Locomotor')
    return {
        'allowed_terrain': tokens(h.get('AllowedTerrain')),
        'crushes': locos[loco]['_crushes'] if loco else [],
        # ChangesHealthInfo defaults: Delay 5, StartIfBelow 50.
        'burn_step': int(burn.get('Step', 5)),
        'burn_delay': int(burn.get('Delay', CHANGES_HEALTH_DELAY)),
        'burn_start_if_below': int(burn.get('StartIfBelow', CHANGES_HEALTH_START_IF_BELOW)),
        'force_fire_only': any(isinstance(v, dict) and str(v.get('RequiresForceFire', 'false')).lower() == 'true'
                               for v in trait(t, 'Targetable').values()),
        'radius': unit_radius(into, actors[into]['cost']) if into else 384,
        # For capturing (engineers, mechanics): Capturable.Types and what it becomes.
        'capturable': {'types': tokens(cap.get('Types')),
                       'transform_into': into,
                       # TransformOnCapture.ForceHealthPercentage (0: keep the health ratio).
                       'force_health_percent': int(t['TransformOnCapture'].get('ForceHealthPercentage', 0))} if cap is not None and into else None,
        'infiltrate': {'types': tokens(inf.get('Types')), 'transform_into': ids_lower[inf['IntoActor'].lower()],
                       'force_health_percent': int(inf.get('ForceHealthPercentage', 0))} if inf else None,
    }


CRATE_DURATION = 0                   # CrateInfo.Duration (0: stays)
CRATE_SHARES = 10                    # CrateActionInfo.SelectionShares
CRATE_EFFECT_IMAGE = 'crate-effects'  # CrateActionInfo.Image
LEVEL_UP_RANGE = 3                   # LevelUpCrateActionInfo.Range (WDist 3: world units)
MAX_EXTRA_COLLECTORS = 4             # LevelUp / GrantExternalCondition MaxExtraCollectors
DUPLICATE_MAX_RADIUS = 4             # DuplicateUnitCrateActionInfo.MaxRadius (cells)
BASE_BUILDER_NO_BASE_SHARES = 1000   # GiveBaseBuilderCrateActionInfo.NoBaseSelectionShares
CRATE_ACTIONS = {
    'GiveCashCrateAction': 'give_cash', 'LevelUpCrateAction': 'level_up', 'ExplodeCrateAction': 'explode',
    'HideMapCrateAction': 'hide_map', 'HealActorsCrateAction': 'heal_actors', 'RevealMapCrateAction': 'reveal_map',
    'DuplicateUnitCrateAction': 'duplicate_unit', 'GiveBaseBuilderCrateAction': 'give_base_builder',
    'GiveUnitCrateAction': 'give_unit', 'GrantExternalConditionCrateAction': 'grant_external_condition',
}


CRATE_ACTION_FIELDS = {
    'give_cash': {'amount'},
    'level_up': {'levels', 'range', 'max_extra'},
    'explode': {'weapon'},
    'hide_map': {'include_allies'},
    'heal_actors': {'targets'},
    'reveal_map': {'include_allies'},
    'duplicate_unit': {'targets', 'min_amount', 'max_amount', 'max_duplicate_value', 'max_radius', 'factions'},
    'give_base_builder': {'units', 'factions', 'no_base_shares'},
    'give_unit': {'units', 'factions'},
    'grant_external_condition': {'condition', 'levels', 'duration', 'range', 'max_extra'},
}


def crate_info(t, ids_lower, weapon_index):
    """^Crate and its crate actions, in YAML order (Crate.OnCrushInner rolls over them in order)."""
    c = t['Crate'] if isinstance(t['Crate'], dict) else {}
    actions = []
    for k, v in t.items():
        base = k.split('@')[0]
        if base not in CRATE_ACTIONS:
            if base.endswith('CrateAction'):
                raise SystemExit(f'unsupported crate action {k}')
            continue
        v = v if isinstance(v, dict) else {}
        kind = CRATE_ACTIONS[base]
        a = {
            'key': k, 'kind': kind,
            'shares': int(v.get('SelectionShares', CRATE_SHARES)),
            'time_delay': int(v.get('TimeDelay', 0)),
            'prerequisites': tokens(v.get('Prerequisites')),
            'excluded': [ids_lower.get(x.lower(), x.upper()) for x in tokens(v.get('ExcludedActorTypes'))],
            # Presentation: crate-effects sequence and sound (audio catalog).
            'sequence': v.get('Sequence') or None,
            'sound': v.get('Sound') or None,
            'notification': v.get('Notification') or None,
            'amount': int(v.get('Amount', 2000)) if kind == 'give_cash' else 0,
            'levels': int(v.get('Levels', 1)),
            'range': wdist(v.get('Range', str(LEVEL_UP_RANGE))),
            'max_extra': int(v.get('MaxExtraCollectors', MAX_EXTRA_COLLECTORS)),
            'weapon': weapon_index(v['Weapon']) if kind == 'explode' else None,
            'include_allies': str(v.get('IncludeAllies', 'false')).lower() == 'true',
            # HealActorsCrateAction.TargetTypes / DuplicateUnitCrateAction.ValidTargets (target class bits; 0: any).
            'targets': target_mask(v.get('TargetTypes', '')) if kind == 'heal_actors'
            else target_mask(v.get('ValidTargets', 'Ground, Water')) if kind == 'duplicate_unit' else 0,
            'min_amount': int(v.get('MinAmount', 1)),
            'max_amount': int(v.get('MaxAmount', 2)),
            'max_duplicate_value': int(v.get('MaxDuplicateValue', -1)),
            'max_radius': int(v.get('MaxRadius', DUPLICATE_MAX_RADIUS)),
            'factions': tokens(v.get('ValidFactions')),
            # Unit names as OpenRA spells them; the engine skips types it does not have.
            'units': [x.upper() for x in tokens(v.get('Units'))],
            'no_base_shares': int(v.get('NoBaseSelectionShares', BASE_BUILDER_NO_BASE_SHARES)),
            'condition': v.get('Condition') or None,
            'duration': int(v.get('Duration', 0)),
        }
        # Only the fields of this kind of action (the engine defaults the rest).
        keep = {'key', 'kind', 'shares', 'time_delay', 'prerequisites', 'excluded', 'sequence', 'sound', 'notification'} | CRATE_ACTION_FIELDS[kind]
        actions.append({f: x for f, x in a.items() if f in keep and (x or f in ('shares', 'kind', 'key'))})
    return {'duration': int(c.get('Duration', CRATE_DURATION)), 'terrain': tokens(c.get('TerrainTypes')),
            'crush_class': c.get('CrushClass', 'crate'), 'actions': actions}


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


# Selectable.PriorityModifiers as bits (rules.rs SelectionInfo).
SELECTION_MODIFIERS = {'None': 0, 'Ctrl': 1, 'Alt': 2}


def selection_info(t, aid):
    """OpenRA Selectable (selection.rs): the selection priority, the modifier
    keys that raise it to the top (bits: 1 Ctrl, 2 Alt), the selection class
    (the actor's own name unless the trait names one: what double click and
    the select by type hotkey match) and Bounds [width, height, x, y offset]
    in world units ([]: the footprint, or one cell for a unit). None for
    actors without Selectable (walls, mines, husks, crates)."""
    sel = trait(t, 'Selectable')
    if not sel:
        return None
    v = next(iter(sel.values()))
    v = v if isinstance(v, dict) else {}
    bits = 0
    for m in tokens(v.get('PriorityModifiers')):
        if m not in SELECTION_MODIFIERS:
            raise SystemExit(f'{aid}: unknown Selectable.PriorityModifiers {m}')
        bits |= SELECTION_MODIFIERS[m]
    bounds = ints(v['Bounds']) if v.get('Bounds') else []
    if bounds and len(bounds) not in (2, 4):
        raise SystemExit(f'{aid}: Selectable.Bounds needs 2 or 4 values')
    return {
        'priority': int(v.get('Priority', 10)),
        'modifiers': bits,
        'class': v.get('Class') or aid.lower(),
        'bounds': (bounds + [0, 0])[:4] if bounds else [],
    }


# OpenRA UnitStance names as the engine spells them (rules.rs Stance).
STANCES = {'HoldFire': 'hold_fire', 'ReturnFire': 'return_fire', 'Defend': 'defend', 'AttackAnything': 'attack_anything'}


def stances(t):
    """AutoTarget [InitialStance, InitialStanceAI] (both default to AttackAnything), or None without AutoTarget."""
    if not has(t, 'AutoTarget'):
        return None
    at = first(t, 'AutoTarget')
    return [STANCES[str(at.get('InitialStance', 'AttackAnything'))], STANCES[str(at.get('InitialStanceAI', 'AttackAnything'))]]


# Target types that an Infiltrates trait can enter (Infiltrates.Types of the
# Spy, Thief and Mechanic), exported per actor from its Targetable traits.
INFILTRATE_TYPES = ['SpyInfiltrate', 'ThiefInfiltrate', 'Husk']
# InfiltrateFor* traits on the infiltrated structure (OpenRA.Mods.Cnc
# Traits/Infiltration) and the effect names the engine knows (infantry.rs).
INFILTRATE_EFFECTS = {'InfiltrateForCash': 'cash', 'InfiltrateForExploration': 'exploration',
                      'InfiltrateForPowerOutage': 'power_outage', 'InfiltrateForSupportPower': 'support_power',
                      'InfiltrateForSupportPowerReset': 'power_reset', 'InfiltrateForDecoration': 'decoration',
                      'InfiltrateForTransform': 'transform'}
# OpenRA trait defaults of the infantry abilities (infantry.rs).
INFILTRATE_CASH_PERCENT = 100       # InfiltrateForCashInfo.Percentage
POWER_OUTAGE_DURATION = 500         # InfiltrateForPowerOutageInfo.Duration
CAPTURE_DELAY = 0                   # CapturesInfo.CaptureDelay
DEMOLITION_DELAY = 45               # DemolitionInfo.DetonationDelay
DEMOLITION_FLASHES = 3              # DemolitionInfo.Flashes
DEMOLITION_FLASH_DELAY = 4          # DemolitionInfo.FlashesDelay
DEMOLITION_FLASH_INTERVAL = 4       # DemolitionInfo.FlashInterval
LEAP_SPEED = '426'                  # AttackLeapInfo.Speed
SPAWN_ACTOR_LIFETIME = 250          # SpawnActorPowerInfo.LifeTime
ANNOUNCE_ON_KILL_INTERVAL = 750     # AnnounceOnKillInfo.Interval
# The reusable engineers lobby option (player.yaml LobbyPrerequisiteCheckbox@REUSABLEENGINEERS)
# grants this prerequisite; Captures traits switch on it.
REUSABLE_ENGINEERS = 'global-reusable-engineers'


def armament_info(t):
    """Per weapon slot (the order of `weapons`): FireDelay; and whether the
    armaments only target allies (TargetRelationships: Ally, the Medic and
    Mechanic)."""
    delays, allies = [], False
    for arm in trait(t, 'Armament').values():
        if isinstance(arm, dict) and arm.get('Name') != 'garrisoned':
            delays.append(int(arm.get('FireDelay', 0)))
            allies |= relationship_mask(arm.get('TargetRelationships', 'Enemy')) == RELATIONSHIPS['Ally']
    return delays, allies


def death_info(t):
    """WithDeathAnimation: the death sequence number per damage type (die1..die6)
    and whether crushing has its own sequence; None without the trait."""
    d = t.get('WithDeathAnimation')
    if not isinstance(d, dict) or str(d.get('UseDeathTypeSuffix', 'true')).lower() != 'true':
        return None
    types = d.get('DeathTypes') or {}
    return {'types': [{'type': k, 'sequence': int(tokens(v)[0])} for k, v in types.items()],
            'crushed': bool(d.get('CrushedSequence'))}


def captures_info(t):
    """Captures traits: types, delay, consumed and which lobby setting enables them."""
    out = []
    for v in trait(t, 'Captures').values():
        v = v if isinstance(v, dict) else {}
        cond = v.get('RequiresCondition', '')
        if cond not in ('', REUSABLE_ENGINEERS, '!' + REUSABLE_ENGINEERS):
            raise SystemExit(f'unsupported Captures condition {cond!r}')
        out.append({'types': tokens(v.get('CaptureTypes')), 'delay': int(v.get('CaptureDelay', CAPTURE_DELAY)),
                    'consumed': str(v.get('ConsumedByCapture', 'True')).lower() == 'true',
                    'experience': int(v.get('PlayerExperience', 0)),
                    # 1: only with reusable engineers, -1: only without, 0: always.
                    'option': 1 if cond == REUSABLE_ENGINEERS else -1 if cond else 0})
    return out


def infiltrated_info(t, ids_lower):
    """InfiltrateFor* effects of an infiltratable actor (structures, husks)."""
    out = []
    for k, v in t.items():
        base = k.split('@')[0]
        if base not in INFILTRATE_EFFECTS:
            continue
        v = v if isinstance(v, dict) else {}
        e = {'kind': INFILTRATE_EFFECTS[base], 'types': tokens(v.get('Types')),
             'experience': int(v.get('PlayerExperience', 0))}
        if base == 'InfiltrateForCash':
            e['percentage'] = int(v.get('Percentage', INFILTRATE_CASH_PERCENT))
            e['minimum'] = int(v.get('Minimum', -1))
            e['maximum'] = int(v.get('Maximum', 2 ** 31 - 1))
            e['experience_percentage'] = int(v.get('PlayerExperiencePercentage', 0))
        if base == 'InfiltrateForPowerOutage':
            e['duration'] = int(v.get('Duration', POWER_OUTAGE_DURATION))
        if base == 'InfiltrateForSupportPower':
            e['proxy'] = ids_lower[v['Proxy'].lower()]
        if base == 'InfiltrateForTransform':
            e['into'] = ids_lower[v['IntoActor'].lower()]
            e['health'] = int(v.get('ForceHealthPercentage', 0))
        out.append(e)
    return out


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


def overlay_manager_types(src):
    """Types of the player's ProductionIconOverlayManager traits (player.yaml:
    Veterancy, the iconchevrons veteran chevron on cameos)."""
    defs = src.load('rules', ['player', 'world'])
    traits = src.to_json(defs['Player'][1])
    return {v['Type'] for k, v in traits.items() if k.split('@')[0] == 'ProductionIconOverlayManager' and isinstance(v, dict) and v.get('Type')}


def production_overlays(t, manager_types):
    """WithProductionIconOverlay traits: the overlay types of the cameo and the
    prerequisites that switch them on (ProductionIconOverlayManager watches
    them in the tech tree). Only types a manager draws (OpenRA rejects others)."""
    out = []
    for k, v in t.items():
        if k.split('@')[0] != 'WithProductionIconOverlay' or not isinstance(v, dict):
            continue
        types = [x for x in tokens(v.get('Types')) if x in manager_types]
        if types:
            out.append({'types': types, 'prerequisites': tokens(v.get('Prerequisites'))})
    return out


# OpenRA defaults of the world traits below (CrateSpawnerInfo, StartingUnitsInfo,
# TimeLimitManagerInfo) for fields RA's world.yaml leaves out.
CRATE_SPAWNER_DEFAULTS = {'Minimum': 1, 'Maximum': 255, 'SpawnInterval': 4500, 'InitialSpawnDelay': 0, 'WaterChance': 20,
                          'QuantizedFacings': 32, 'Cordon': '5120'}
CRATE_VALID_GROUND = 'Clear, Rough, Road, Ore, Beach'
CRATE_VALID_WATER = 'Water'
STARTING_INNER_RADIUS = 2
STARTING_OUTER_RADIUS = 4
STARTING_BASE_FACING = 512
UNREVEALED_TERRAIN = 'Unrevealed Terrain'
TOOLTIP_PREFIX = {'ally': 'Ally', 'enemy': 'Enemy'}
TIME_LIMIT_OPTIONS = [0, 10, 20, 30, 40, 60, 90]


def world_rules(src, ids_lower):
    """Lobby option traits of OpenRA's World actor (world.yaml): the CrateSpawner
    (crates.rs), the StartingUnits sets (gamerules.rs) and the TimeLimitManager."""
    w = src.to_json(src.load('rules', ['world'])['World'][1])
    cs = {**CRATE_SPAWNER_DEFAULTS, **w['CrateSpawner']}
    actors = tokens(cs.get('CrateActors', 'crate'))
    shares = ints(cs.get('CrateActorShares', '10'))
    crates = {
        'minimum': int(cs['Minimum']), 'maximum': int(cs['Maximum']),
        'spawn_interval': int(cs['SpawnInterval']), 'initial_delay': int(cs['InitialSpawnDelay']),
        'water_chance': int(cs['WaterChance']), 'quantized_facings': int(cs['QuantizedFacings']),
        'cordon': wdist(cs['Cordon']),
        'delivery_aircraft': ids_lower[cs['DeliveryAircraft'].lower()] if cs.get('DeliveryAircraft') else None,
        'actors': [ids_lower[a.lower()] for a in actors], 'shares': shares,
        'valid_ground': tokens(cs.get('ValidGround', CRATE_VALID_GROUND)),
        'valid_water': tokens(cs.get('ValidWater', CRATE_VALID_WATER)),
    }
    starting = []
    for k, v in w.items():
        if k.split('@')[0] != 'StartingUnits':
            continue
        starting.append({
            'class': v.get('Class', 'none'),
            'factions': tokens(v.get('Factions')),
            'base_actor': ids_lower[v['BaseActor'].lower()] if v.get('BaseActor') else None,
            # Names as OpenRA spells them; the engine skips types it does not have.
            'support_actors': [x.upper() for x in tokens(v.get('SupportActors'))],
            'inner_radius': int(v.get('InnerSupportRadius', STARTING_INNER_RADIUS)),
            'outer_radius': int(v.get('OuterSupportRadius', STARTING_OUTER_RADIUS)),
            'base_facing': int(v.get('BaseActorFacing', STARTING_BASE_FACING)),
        })
    tl = w['TimeLimitManager']
    warnings = sorted(((int(m), n) for m, n in tl.get('TimeLimitWarnings', {}).items()), reverse=True)
    time_limit = {'options': ints(tl['TimeLimitOptions']) if 'TimeLimitOptions' in tl else TIME_LIMIT_OPTIONS,
                  'default': int(tl.get('TimeLimitDefault', 0)),
                  'warnings': [m for m, _ in warnings],
                  'notifications': [n for _, n in warnings]}
    # The battlefield tooltip's texts (engine/src/tooltip.rs): the resource
    # names of the ResourceRenderer, and OpenRA's common strings
    # (mods/common/fluent/common.ftl label-unrevealed-terrain, rules.ftl
    # label-tooltip-prefix .ally and .enemy; TooltipInfo has no NeutralPrefix).
    base = src.to_json(src.load('rules', ['world'])['^BaseWorld'][1])
    rr = base['ResourceRenderer']['ResourceTypes']
    tooltips = {'unrevealed': UNREVEALED_TERRAIN, 'ally_prefix': TOOLTIP_PREFIX['ally'], 'enemy_prefix': TOOLTIP_PREFIX['enemy'],
                'ore': src.tr(rr['Ore']['Name']), 'gems': src.tr(rr['Gems']['Name'])}
    return {'crates': crates, 'starting_units': starting, 'time_limit': time_limit, 'tooltips': tooltips}


# OpenRA bot modules (mods/ra/rules/ai.yaml, data/source/rules/ai.yaml) with the
# defaults of their C# Info classes for the fields RA's ai.yaml leaves out
# (OpenRA.Mods.Common/Traits/BotModules). The engine's skirmish AI (ai*.rs)
# runs one bot per AI slot from these.
BOT_MODULES = {
    'BaseBuilderBotModule': ('base_builder', {
        'ConstructionYardTypes': [], 'RefineryTypes': [], 'PowerTypes': [], 'ProductionTypes': [], 'TechTypes': [],
        'NavalProductionTypes': [], 'SiloTypes': [], 'DefenseTypes': [],
        'MinBaseRadius': 2, 'MaxBaseRadius': 20, 'MinimumExcessPower': 0, 'MaximumExcessPower': 0, 'ExcessPowerIncrement': 0,
        'ExcessPowerIncreaseThreshold': 1, 'InititalMinimumRefineryCount': 1, 'AdditionalMinimumRefineryCount': 1,
        'StructureProductionInactiveDelay': 125, 'StructureProductionActiveDelay': 25, 'StructureProductionRandomBonusDelay': 10,
        'StructureProductionResumeDelay': 1500, 'MaximumFailedPlacementAttempts': 3, 'MaxResourceCellsToCheck': 3,
        'CheckForNewBasesDelay': 1500, 'PlaceDefenseTowardsEnemyChance': 100, 'TryMaintainDefenseRange': 5,
        'NewProductionCashThreshold': 5000, 'NewProductionChance': 50, 'RallyPointScanRadius': 8, 'CheckForWaterRadius': 8,
        'BuildingFractions': {}, 'BuildingLimits': {}, 'BuildingDelays': {}, 'ProductionMinCashRequirement': 500,
        'AssignRallyPointsInterval': 100, 'CheckBestResourceLocationInterval': 151, 'SellRefineryInterval': 5000,
        'SellRefineryTooCloseCellDistance': 6, 'SellRefineryNoResourceDistance': 12, 'MaxRefineryPerIndice': 2,
        'ExpansionTolerate': [0, 1], 'ForceExpansionTolerate': [2, 3], 'PerExpansionTolerateOnCash': 12000}),
    'UnitBuilderBotModule': ('unit_builder', {
        'IdleBaseUnitsMaximum': -1, 'UnitQueues': ['Vehicle', 'Infantry', 'Plane', 'Ship', 'Aircraft'],
        'UnitsToBuild': {}, 'UnitLimits': {}, 'UnitDelays': {}, 'ProductionMinCashRequirement': 500}),
    'SquadManagerBotModule': ('squads', {
        'NavalUnitsTypes': [], 'AirUnitsTypes': [], 'ExcludeFromSquadsTypes': [], 'ConstructionYardTypes': [],
        'NavalProductionTypes': [], 'ProtectionTypes': [], 'AircraftTargetType': ['Air'], 'SquadSize': 8,
        'SquadSizeRandomBonus': 30, 'AssignRolesInterval': 50, 'RushInterval': 600, 'AttackForceInterval': 75,
        'MinimumAttackForceDelay': 0, 'RushAttackScanRadius': 15, 'ProtectUnitScanRadius': 15, 'MaxBaseRadius': 20,
        'IdleScanRadius': 10, 'DangerScanRadius': 10, 'AttackScanRadius': 12, 'ProtectionScanRadius': 8,
        'IgnoredEnemyTargetTypes': []}),
    'HarvesterBotModule': ('harvester', {
        'HarvesterTypes': [], 'RefineryTypes': [], 'ScanForIdleHarvestersInterval': 50, 'ScanForLowEffectHarvestersInterval': 433,
        'ScanIntervalMultiplerWhenNoResources': 5, 'HarvesterEnemyAvoidanceRadius': '10c0', 'HarvesterEnemyAvoidanceCostMultipler': 20,
        'ResourceCellsPerHarvester': 4, 'InitialHarvesters': 4}),
    'ResourceMapBotModule': ('resource_map', {
        'ValuableResourceTypes': [], 'ResourceCreatorTypes': [], 'RefineryTypes': [], 'HarvesterTypes': [],
        'EnemyBaseBuildingTypes': [], 'UpdateResourceMapInverval': 67, 'ResourceMapStrideRadius': 12}),
    'McvExpansionManagerBotModule': ('mcv_expansion', {
        'McvTypes': [], 'ConstructionYardTypes': [], 'McvFactoryTypes': [], 'MinimumConstructionYardCount': 1,
        'AdditionalConstructionYardCount': 0, 'BuildAdditionalMCVCashAmount': 5000, 'ScanForNewMcvInterval': 20,
        'BuildMcvInterval': 101, 'MoveConyardTick': 5700, 'MoveOldConyardFirst': None, 'CRmodeMinDeployRadius': 2,
        'CRmodeMaxDeployRadius': 20, 'CRmodeTryMaintainRange': 8, 'CRmodeFriendlyConyardDislikeRange': 14,
        'CRmodeFriendlyRefineryDislikeRange': 14, 'CBmodeMinDeployRadius': 2, 'CBmodeMaxDeployRadius': 20}),
    'McvManagerBotModule': ('mcv_manager', {
        'McvTypes': [], 'ConstructionYardTypes': [], 'McvFactoryTypes': [], 'MinimumConstructionYardCount': 1,
        'ScanForNewMcvInterval': 20, 'MinBaseRadius': 2, 'MaxBaseRadius': 20, 'RestrictMCVDeploymentFallbackToBase': True}),
    'PowerDownBotModule': ('power_down', {'Interval': 150, 'PowerDownTypes': []}),
    'BuildingRepairBotModule': ('building_repair', {'RepairAllBuildingsCoolDown': 107}),
    'MinelayerBotModule': ('minelayer', {
        'IgnoredEnemyTargetTypes': [], 'UseEnemyLocationTargetTypes': [], 'MinelayingActorTypes': [], 'MaxPerAssign': 1,
        'ScanTick': 320, 'MineFieldRadius': 1, 'AwayFromAlliedTargetTypes': [], 'AwayFromEnemyTargetTypes': [],
        'AwayFromCellDistance': 9, 'FavoritePositionDistance': 6}),
    'SupportPowerBotModule': ('support_powers', {'Decisions': {}}),
}
# SupportPowerDecision and its Consideration defaults.
DECISION_DEFAULTS = {'MinimumAttractiveness': 1, 'OrderName': 'AirstrikePowerInfoOrder', 'CoarseScanRadius': 20,
                     'FineScanRadius': 2, 'MinimumScanTimeInterval': 250, 'MaximumScanTimeInterval': 262}
CONSIDERATION_DEFAULTS = {'Against': 'Enemy', 'Types': 'Air, Ground, Water', 'Attractiveness': 100,
                          'TargetMetric': 'None', 'CheckRadius': '5c0'}
# Fields that name actor types: exported as engine actor ids.
BOT_ACTOR_LIST_FIELDS = {'ConstructionYardTypes', 'RefineryTypes', 'PowerTypes', 'ProductionTypes', 'TechTypes',
                         'NavalProductionTypes', 'SiloTypes', 'DefenseTypes', 'NavalUnitsTypes', 'AirUnitsTypes',
                         'ExcludeFromSquadsTypes', 'ProtectionTypes', 'HarvesterTypes', 'ResourceCreatorTypes',
                         'EnemyBaseBuildingTypes', 'McvTypes', 'McvFactoryTypes', 'PowerDownTypes', 'MinelayingActorTypes'}
BOT_ACTOR_MAP_FIELDS = {'BuildingFractions', 'BuildingLimits', 'BuildingDelays', 'UnitsToBuild', 'UnitLimits', 'UnitDelays'}


def snake(name):
    """OpenRA field name to the engine's snake case (CRmodeMinDeployRadius -> cr_mode_min_deploy_radius)."""
    name = name.replace('CRmode', 'CrMode').replace('CBmode', 'CbMode').replace('MCV', 'Mcv')
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


def bot_rules(src, ids_lower):
    """The bots of OpenRA's RA ai.yaml: per ModularBot type its name and the
    modules enabled for it (GrantConditionOnBotOwner + RequiresCondition), with
    every field resolved to a value. Actor names become engine ids; names the
    export does not have (e.g. resource creators 'mine') are left out."""
    player = src.load('rules', ['ai'])['Player'][1]
    conditions = {}
    bots = []
    for k, (v, ch) in player.items():
        base = k.split('@')[0]
        if base == 'ModularBot':
            bots.append({'type': ch['Type'][0], 'name': ftl.get(ch['Name'][0], ch['Name'][0])})
        elif base == 'GrantConditionOnBotOwner':
            for b in tokens(ch['Bots'][0]):
                conditions[ch['Condition'][0]] = b
    for bot in bots:
        enabled = {c for c, b in conditions.items() if b == bot['type']}
        bot_modules(bot, player, lambda requires, enabled=enabled: not requires or bool(set(re.findall(r'[a-z-]+', requires)) & enabled), ids_lower)
    return bots


# Modules every bot entry has (the engine's BotInfo); a bot without one gets its defaults.
REQUIRED_BOT_MODULES = ('BaseBuilderBotModule', 'UnitBuilderBotModule', 'SquadManagerBotModule', 'HarvesterBotModule')


def bot_modules(bot, player, active, ids_lower):
    """Fill `bot` with the bot modules of Player rules `player` that
    `active(requires)` (the module's RequiresCondition, '' without one) keeps.
    tools/gen_missions.py uses it for a mission's campaign bot."""
    def actor_ids(names):
        return [ids_lower[n.lower()] for n in names if n.lower() in ids_lower]

    def value(field, raw, default):
        if field in BOT_ACTOR_LIST_FIELDS:
            return actor_ids(tokens(raw))
        if isinstance(default, list):
            items = tokens(raw)
            return [int(x) for x in items] if default and isinstance(default[0], int) else items
        if isinstance(default, bool) or default is None:
            return str(raw).lower() == 'true'
        if field.endswith('Radius') and isinstance(default, str):
            return wdist(raw)
        return int(raw)

    def module(base, ch):
        key, defaults = BOT_MODULES[base]
        out = {}
        for field, default in defaults.items():
            if field == 'Decisions':
                out['decisions'] = [decision(n[1]) for n in ch.get('Decisions', ['', {}])[1].values()]
                continue
            if field not in ch:
                raw = [] if field in BOT_ACTOR_MAP_FIELDS else default
                if field == 'HarvesterEnemyAvoidanceRadius':
                    raw = wdist(default)
                out[snake(field)] = raw
                continue
            if field in BOT_ACTOR_MAP_FIELDS:
                out[snake(field)] = [[ids_lower[n.lower()], int(x[0])] for n, x in ch[field][1].items() if n.lower() in ids_lower]
                continue
            out[snake(field)] = value(field, ch[field][0], default)
        for field in ch:
            assert field == 'RequiresCondition' or field in defaults, f'{base}.{field} is not exported'
        return key, out

    for k, (v, ch) in player.items():
        base = k.split('@')[0]
        if base not in BOT_MODULES or not active(ch.get('RequiresCondition', [''])[0]):
            continue
        key, out = module(base, ch)
        assert key not in bot, f'bot {bot["type"]}: two {base}'
        bot[key] = out
    for base in REQUIRED_BOT_MODULES:
        key, _ = BOT_MODULES[base]
        if key not in bot:
            bot[key] = module(base, {})[1]
    return bot


def decision(ch):
    """A SupportPowerDecision of SupportPowerBotModule.Decisions."""
    get = lambda f: ch[f][0] if f in ch else DECISION_DEFAULTS[f]
    d = {'order_name': get('OrderName')}
    for f in ('MinimumAttractiveness', 'CoarseScanRadius', 'FineScanRadius', 'MinimumScanTimeInterval', 'MaximumScanTimeInterval'):
        d[snake(f)] = int(get(f))
    d['considerations'] = []
    for k, (v, c) in ch.items():
        if k.split('@')[0] != 'Consideration':
            continue
        cg = lambda f: c[f][0] if f in c else CONSIDERATION_DEFAULTS[f]
        d['considerations'].append({'against': cg('Against'), 'types': tokens(cg('Types')),
                                    'attractiveness': int(cg('Attractiveness')), 'target_metric': cg('TargetMetric'),
                                    'check_radius': wdist(cg('CheckRadius'))})
    return d


def extra_actor(src, aid):
    """An actors.json-style record for a non-buildable actor, from the OpenRA YAML."""
    tree = src.rules[aid]
    t = src.to_json(tree)
    # Haystacks and igloos only have Tooltip@SUMMER and Tooltip@WINTER (on the
    # SNOW tileset): the one without a tileset condition (`!winter`) names them.
    conditional = [v for v in trait(t, 'Tooltip').values() if isinstance(v, dict)]
    tooltip = src.g(tree, 'Tooltip/Name') or next((v.get('Name') for v in conditional if v.get('RequiresCondition', '').startswith('!')),
                                                  conditional[0].get('Name') if conditional else None)
    name = src.tr(tooltip) or aid
    # TooltipDescription@ally / @other (tech buildings): what capturing gives.
    tips = {k.split('@')[-1]: src.tr(v['Description']) for k, v in trait(t, 'TooltipDescription').items()
            if isinstance(v, dict) and v.get('Description')}
    return {
        'id': aid,
        'name': name,
        'description': src.tr(src.g(tree, 'Buildable/Description')) or '',
        'tooltipDescriptions': tips,
        'queue': 'Building' if aid in PROXIES or 'Building' in t else 'Vehicle' if 'Crate' in t or 'Husk' in t
        else 'Aircraft' if 'Aircraft' in t else 'Infantry' if 'Infantry' in t or 'Parachutable' in t else 'Vehicle',
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


def webra_actor(src, aid):
    """An actors.json-style record for one of WEBRA_ACTORS: its definition in
    data/webra/rules.yaml, with `Inherits` resolved against OpenRA's rules
    (the same parser and merge rules as data/source/parse.py)."""
    defs = src.parse_miniyaml(open(WEBRA_RULES).read())
    if aid not in defs:
        raise SystemExit(f'{aid}: not in data/webra/rules.yaml')
    tree, own = {}, {}
    for k, (v, ch) in defs[aid][1].items():
        if k == 'Inherits' or k.startswith('Inherits@'):
            tree = src.merge(tree, src.rules[v])
        else:
            own[k] = [v, ch]
    tree = src.merge(tree, own)
    t = src.to_json(tree)
    return {
        'id': aid,
        'name': src.g(tree, 'Tooltip/Name') or aid,
        'description': src.g(tree, 'Buildable/Description') or '',
        'queue': src.g(tree, 'Buildable/Queue'),
        'cost': int(src.g(tree, 'Valued/Cost') or 0),
        'buildDuration': src.g(tree, 'Buildable/BuildDuration'),
        'buildDurationModifier': src.g(tree, 'Buildable/BuildDurationModifier'),
        'buildPaletteOrder': int(src.g(tree, 'Buildable/BuildPaletteOrder') or 0),
        'prerequisites': tokens(src.g(tree, 'Buildable/Prerequisites')),
        'hp': int(src.g(tree, 'Health/HP') or 0),
        'armor': src.g(tree, 'Armor/Type'),
        'sight': src.g(tree, 'RevealsShroud/Range'),
        'traits': t,
    }


def hurts(w):
    """Whether a weapon deals damage: a damage warhead with Damage, or cluster warheads (BarrelExplode)."""
    return any(k.startswith('Warhead') and isinstance(v, dict) and (
        (v.get('_') in ('SpreadDamage', 'TargetDamage', 'HealthPercentageDamage') and int(v.get('Damage', 0)) != 0)
        or v.get('_') == 'FireCluster') for k, v in w.items())


# OpenRA RA tilesets of the WebRA biomes (bridge templates differ per tileset).
BIOME_TILESETS = {'temperate': 'TEMPERAT', 'snow': 'SNOW', 'desert': 'DESERT'}
TILESET_FILES = {'TEMPERAT': 'temperat', 'SNOW': 'snow', 'DESERT': 'desert'}
# One letter per OpenRA terrain type, as in tools/gen_oramap_tables.py; the
# engine reads them in bridge templates (map.rs Terrain::from_letter).
TERRAIN_LETTERS = {'Clear': 'c', 'ClearNoSmudges': 'c', 'Rough': 'r', 'Road': 'd', 'Rock': 'k', 'Water': 'w', 'River': 'v',
                   'Tree': 't', 'Beach': 'b', 'Bridge': 'g', 'Wall': 'l', 'Ore': 'o', 'Gems': 'm'}
# OpenRA BridgeInfo defaults.
BRIDGE_REPAIR_PROPAGATION_DELAY = 20
BRIDGE_SHORE_PIECES = 'br1, br2'
BRIDGE_DEMOLISH_WEAPON = 'Demolish'
# OpenRA ScaredyCatInfo, WandersInfo, SeedsResourceInfo and CashTricklerInfo defaults.
PANIC_CHANCE, PANIC_DURATION, PANIC_SPEED, ATTACK_PANIC_CHANCE = 100, 250, 200, 20
WANDER_RADIUS, WANDER_REDUCE_DELAY = 1, 5
SEED_INTERVAL, SEED_MAX_RANGE = 75, 100
TRICKLE_INTERVAL, TRICKLE_AMOUNT = 50, 15


def load_tilesets(src):
    """Template id -> (size, terrain letter rows) per tileset id."""
    out = {}
    for tid, fn in TILESET_FILES.items():
        root = src.parse_miniyaml(open(os.path.join(DATA, 'source', 'tilesets', fn + '.yaml')).read())
        templates = {}
        for _k, (_v, ch) in root['Templates'][1].items():
            w, h = (int(x) for x in ch['Size'][0].split(','))
            tiles = {int(k): v for k, (v, _) in ch.get('Tiles', ['', {}])[1].items()}
            rows = [''.join(TERRAIN_LETTERS[tiles[y * w + x]] if y * w + x in tiles else '.' for x in range(w)) for y in range(h)]
            templates[int(ch['Id'][0])] = {'size': [w, h], 'rows': rows}
        out[tid] = templates
    return out


def tileset_conditions(t):
    """Conditions of GrantConditionOnTileSet traits -> the tilesets that grant them."""
    return {v['Condition']: set(tokens(v.get('TileSets'))) for v in trait(t, 'GrantConditionOnTileSet').values() if isinstance(v, dict)}


def biomes_of(cond, conds):
    """WebRA biomes where a RequiresCondition on tileset conditions holds (None: all)."""
    if not cond:
        return None
    neg = cond.startswith('!')
    name = cond.lstrip('!')
    if name not in conds:
        raise SystemExit(f'unsupported condition {cond!r} on a bridge')
    return [b for b, ts in BIOME_TILESETS.items() if (ts in conds[name]) != neg]


def bridge_info(t, ids_lower, tilesets, weapon_index):
    """OpenRA Bridge (LegacyBridgeLayer bridges): the template of every state
    per biome (terrain letter rows, '.' = not part of the bridge), long bridge
    links, the huts it spawns (FreeActor) and its demolition weapon."""
    b = t['Bridge'] if isinstance(t['Bridge'], dict) else {}
    states = [('healthy', 'Template'), ('damaged', 'DamagedTemplate'), ('destroyed', 'DestroyedTemplate'),
              ('destroyed_north', 'DestroyedPlusNorthTemplate'), ('destroyed_south', 'DestroyedPlusSouthTemplate'),
              ('destroyed_both', 'DestroyedPlusBothTemplate')]
    templates = {}
    for biome, ts in BIOME_TILESETS.items():
        known = tilesets[ts]
        healthy = known.get(int(b.get('Template', 0)))
        if healthy is None:
            continue
        rec = {'size': healthy['size']}
        for state, key in states:
            tpl = known.get(int(b.get(key, 0)))
            if tpl is None:
                continue
            if tpl['size'] != healthy['size']:
                raise SystemExit(f'bridge template {b.get(key)} on {ts} is not the size of {b.get("Template")}')
            rec[state] = tpl['rows']
        templates[biome] = rec
    if not templates:
        raise SystemExit(f'bridge template {b.get("Template")} is on no WebRA tileset')
    conds = tileset_conditions(t)
    huts = []
    for v in trait(t, 'FreeActor').values():
        if isinstance(v, dict):
            huts.append({'actor': ids_lower[v['Actor'].lower()], 'offset': ints(v.get('SpawnOffset', '0,0'))[:2],
                         'biomes': biomes_of(v.get('RequiresCondition'), conds)})
    off = lambda k: ints(b[k])[:2] if k in b else None  # noqa: E731
    return {
        'long': str(b.get('Long', 'false')).lower() == 'true',
        'repair_delay': int(b.get('RepairPropagationDelay', BRIDGE_REPAIR_PROPAGATION_DELAY)),
        'shore_pieces': [ids_lower[x.lower()] for x in tokens(b.get('ShorePieces', BRIDGE_SHORE_PIECES))],
        'north': off('NorthOffset'),
        'south': off('SouthOffset'),
        'templates': templates,
        'huts': huts,
        'demolish_weapon': weapon_index(b.get('DemolishWeapon', BRIDGE_DEMOLISH_WEAPON)),
    }


def stats_override(t, ids_lower):
    """UpdatesPlayerStatistics.OverrideActor (the paratroopers' E1R1 and E3R1
    count as E1 and E3 in the observer's army panel), or None."""
    u = t.get('UpdatesPlayerStatistics')
    override = u.get('OverrideActor') if isinstance(u, dict) else None
    return ids_lower[override.lower()] if override else None


def hospital_heal(t):
    """ChangesHealth switched on by a prerequisite (RA's ^Infantry: owning a
    Hospital, `hosp`, heals damaged infantry): GrantConditionOnPrerequisite ->
    GrantCondition (with `damaged`) -> ChangesHealth."""
    for g in trait(t, 'GrantConditionOnPrerequisite').values():
        if not isinstance(g, dict) or g.get('Condition') == 'global-bounty':
            continue
        cond, prereqs = g['Condition'], tokens(g.get('Prerequisites'))
        for gc in trait(t, 'GrantCondition').values():
            if not (isinstance(gc, dict) and cond in re.split(r'[\s&|!()]+', gc.get('RequiresCondition', ''))):
                continue
            for ch in trait(t, 'ChangesHealth').values():
                if isinstance(ch, dict) and ch.get('RequiresCondition') == gc['Condition'] and len(prereqs) == 1:
                    return {'prerequisite': prereqs[0], 'step': int(ch.get('Step', 0)), 'delay': int(ch.get('Delay', CHANGES_HEALTH_DELAY)),
                            'start_if_below': int(ch.get('StartIfBelow', CHANGES_HEALTH_START_IF_BELOW)),
                            'damage_cooldown': int(ch.get('DamageCooldown', 0))}
    return None


def editor_info(t):
    """MapEditorData: the editor category and the WebRA biomes allowed (None: all)."""
    m = t.get('MapEditorData') if isinstance(t.get('MapEditorData'), dict) else {}
    cats = tokens(m.get('Categories'))
    need = set(tokens(m.get('RequireTilesets')))
    skip = set(tokens(m.get('ExcludeTilesets')))
    biomes = [b for b, ts in BIOME_TILESETS.items() if (not need or ts in need) and ts not in skip]
    return (cats[0] if cats else None), (None if len(biomes) == len(BIOME_TILESETS) else biomes)


def world_info(t, kind, weapon_index, damaging, ids_lower, tilesets, neutral):
    """Traits of the neutral world (engine/src/neutral.rs), with OpenRA defaults.
    `neutral`: one of WORLD_ACTORS."""
    types = target_types(t)
    tg = first(t, 'Targetable')
    if not has(t, 'Targetable'):
        target = 0                        # husks, fields, rocks: nothing can aim at them
    elif 'Trees' in types and not types & {'GroundActor', 'WaterActor', 'AirborneActor'}:
        target = TARGET_BITS['Trees']     # ^Tree: only hit by warheads that list Trees
    elif 'Bridge' in types:
        target = TARGET_BITS['Structure'] | TARGET_BITS['WaterActor']
    elif 'BridgeHut' in types:
        target = 0                        # entered by engineers, never shot at
    else:
        target = None                     # the actor kind's target class
    death = [weapon_index(v['Weapon']) for k, v in sorted(trait(t, 'FireWarheadsOnDeath').items())
             if k != 'FireWarheadsOnDeath' and isinstance(v, dict) and v.get('Weapon')]
    spawn = t.get('SpawnActorOnDeath')
    # ExplosionOnDamageTransition: BridgeExplode only makes fire and a splash
    # (weapon null: the engine shows the explosion without damage).
    explosions = [{'weapon': damaging(v['Weapon']), 'state': v.get('DamageState', 'Heavy').lower()}
                  for k, v in sorted(trait(t, 'ExplosionOnDamageTransition').items()) if isinstance(v, dict)]
    trickle = None
    if has(t, 'CashTrickler'):
        c = next(iter(trait(t, 'CashTrickler').values()))
        c = c if isinstance(c, dict) else {}
        combatant = {g['Condition'] for g in trait(t, 'GrantConditionOnCombatantOwner').values() if isinstance(g, dict)}
        req = c.get('RequiresCondition', '')
        if req and req not in combatant:
            raise SystemExit(f'unsupported CashTrickler condition {req!r}')
        trickle = {'interval': int(c.get('Interval', TRICKLE_INTERVAL)), 'initial_delay': int(c.get('InitialDelay', 0)),
                   'amount': int(c.get('Amount', TRICKLE_AMOUNT)), 'combatant_only': bool(req)}
    scared = None
    if 'ScaredyCat' in t:
        c = t['ScaredyCat'] if isinstance(t['ScaredyCat'], dict) else {}
        scared = {'panic_chance': int(c.get('PanicChance', PANIC_CHANCE)), 'duration': int(c.get('PanicDuration', PANIC_DURATION)),
                  'speed_modifier': int(c.get('PanicSpeedModifier', PANIC_SPEED)),
                  'attack_panic_chance': int(c.get('AttackPanicChance', ATTACK_PANIC_CHANCE))}
    wanders = None
    if 'Wanders' in t:
        c = t['Wanders'] if isinstance(t['Wanders'], dict) else {}
        wanders = {'radius': int(c.get('WanderMoveRadius', WANDER_RADIUS)), 'reduce_delay': int(c.get('ReduceMoveRadiusDelay', WANDER_REDUCE_DELAY)),
                   'min_delay': int(c.get('MinMoveDelay', 0)), 'max_delay': int(c.get('MaxMoveDelay', 0))}
    seeds = None
    if 'SeedsResource' in t:
        c = t['SeedsResource'] if isinstance(t['SeedsResource'], dict) else {}
        seeds = {'resource': c.get('ResourceType', 'Ore').lower(), 'interval': int(c.get('Interval', SEED_INTERVAL)),
                 'max_range': int(c.get('MaxRange', SEED_MAX_RANGE))}
    category, biomes = editor_info(t)
    gives = first(t, 'GivesCashOnCapture') if has(t, 'GivesCashOnCapture') else {}
    return {
        'target': target,
        'no_auto_target': 'NoAutoTarget' in types,
        'force_fire': str(tg.get('RequiresForceFire', 'false')).lower() == 'true',
        # No Health trait: nothing damages it (rocks, fields, husks of trees).
        'indestructible': kind == 'building' and 'Health' not in t,
        # HiddenUnderShroud: seen once explored, also under the fog (trees, rocks, mines).
        'shroud_only': 'HiddenUnderShroud' in t,
        'death_weapons': death,
        # Husks of the neutral world (trees, V19); unit husks are not part of it.
        'spawn_on_death': ids_lower[spawn['Actor'].lower()] if isinstance(spawn, dict) and neutral else None,
        'damage_explosions': explosions,
        'cash_on_capture': int(gives.get('Amount', 0)),
        'cash_trickler': trickle,
        # UpdatesDerrickCount: counted in the observer's Derricks column (oil derricks).
        'derrick': 'UpdatesDerrickCount' in t,
        # UpdatesPlayerStatistics.OverrideActor: the observer's army panel counts it as that type.
        'stats_actor': stats_override(t, ids_lower),
        'hospital_heal': hospital_heal(t) if kind == 'infantry' else None,
        'scaredy_cat': scared,
        'wanders': wanders,
        'seeds': seeds,
        'bridge': bridge_info(t, ids_lower, tilesets, weapon_index) if 'Bridge' in t else None,
        'bridge_hut': 'LegacyBridgeHut' in t,
        'selectable': has(t, 'Selectable'),
        # WithDeathAnimation of a structure without the damage type suffix (the
        # tech buildings' "dead" sequence): one death animation where it stood.
        'death_animation': kind == 'building' and isinstance(t.get('WithDeathAnimation'), dict)
        and str(t['WithDeathAnimation'].get('UseDeathTypeSuffix', 'true')).lower() == 'false',
        # RadarColorFromTerrain: the radar shows it in a terrain colour (trees, mines, walls).
        'radar_terrain': (t['RadarColorFromTerrain'].get('Terrain') if isinstance(t.get('RadarColorFromTerrain'), dict) else None),
        'category': category,
        'biomes': biomes,
    }


# OpenRA PlayerRelationship flags (Ally 1, Neutral 2, Enemy 4), as the
# tooltip's GenericVisibility mask.
RELATIONSHIP_BITS = {'None': 0, 'Ally': 1, 'Neutral': 2, 'Enemy': 4}


def relationship_mask(v):
    """A PlayerRelationship list (FieldLoader parses enums ignoring case) as bits."""
    names = {k.lower(): bit for k, bit in RELATIONSHIP_BITS.items()}
    return sum(names[x.lower()] for x in tokens(v))


def tooltip_info(src, t):
    """OpenRA Tooltip (or the spy's DisguiseTooltip, a TooltipInfo) for the
    battlefield tooltip (engine/src/tooltip.rs): the generic name and who sees
    it (GenericVisibility, default None), whether a relationship prefix goes
    before it (GenericStancePrefix, default true) and whether the owner row
    shows (ShowOwnerRow, default true). The name is the actor's `name`. None
    for actors without one (EditorOnlyTooltip: mines, cameras, proxies)."""
    tips = [v if isinstance(v, dict) else {} for v in {**trait(t, 'Tooltip'), **trait(t, 'DisguiseTooltip')}.values()]
    if not tips:
        return None
    # Tooltip@SUMMER / @WINTER (haystacks, igloos): the one `name` comes from (extra_actor).
    tip = next((v for v in tips if not v.get('RequiresCondition', '').strip() or v['RequiresCondition'].startswith('!')), tips[0])
    return {'generic_name': src.tr(tip.get('GenericName')) or '',
            'generic_visibility': relationship_mask(tip.get('GenericVisibility', 'None')),
            'generic_prefix': str(tip.get('GenericStancePrefix', 'true')).lower() == 'true',
            'show_owner': str(tip.get('ShowOwnerRow', 'true')).lower() == 'true'}


# OpenRA's range circle traits (OpenRA.Mods.Common/Traits/Render: RenderRangeCircle,
# RenderDetectionCircle, RenderShroudCircle, RenderJammerCircle, WithRangeCircle):
# kind and default colour (Color.FromArgb(128, Yellow, LimeGreen, Cyan, Red,
# White)); all draw a Width 1 line over a BorderWidth 3 border of 96 alpha black.
RANGE_CIRCLES = {'RenderRangeCircle': ('range', [255, 255, 0, 128]),
                 'RenderDetectionCircle': ('detection', [50, 205, 50, 128]),
                 'RenderShroudCircle': ('shroud', [0, 255, 255, 128]),
                 'RenderJammerCircle': ('jammer', [255, 0, 0, 128]),
                 'WithRangeCircle': ('fixed', [255, 255, 255, 128])}
CIRCLE_BORDER = [0, 0, 0, 96]


def color_rgba(v):
    """An OpenRA colour (RRGGBB or RRGGBBAA hex) as [r, g, b, a]."""
    v = str(v).strip()
    if not re.fullmatch(r'[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?', v):
        raise SystemExit(f'unsupported colour {v!r}')
    return [int(v[i:i + 2], 16) for i in (0, 2, 4)] + [int(v[6:8], 16) if len(v) == 8 else 255]


def range_circles(t, aid, ids_lower):
    """The range circles of an actor (engine/src/range_circles.rs): drawn
    around the selected actor for its owner and allies, and while a structure
    with one is placed. `range` is the radius in world units (RenderRangeCircle:
    its FallbackRange, the engine takes the longest weapon); `group` the
    RangeCircleType or WithRangeCircle Type (the circles of other actors shown
    while placing); `placement` whether it shows while placing
    (IPlaceBuildingDecorationInfo, enabled by default); `passengers` the
    passenger types whose PassengerConditions enable it (WithRangeCircle with
    RequiresCondition)."""
    out = []
    for name, (kind, default) in RANGE_CIRCLES.items():
        for key, v in trait(t, name).items():
            v = v if isinstance(v, dict) else {}
            unknown = set(v) - {'Color', 'Width', 'BorderColor', 'BorderWidth', 'RangeCircleType', 'FallbackRange', 'Type', 'Range',
                                'RequiresCondition'}
            if unknown:
                raise SystemExit(f'{aid}.{key}: unsupported {sorted(unknown)}')
            c = {'kind': kind, 'group': v.get('RangeCircleType') or v.get('Type') or '', 'range': 0,
                 'color': color_rgba(v['Color']) if 'Color' in v else default,
                 'border': color_rgba(v['BorderColor']) if 'BorderColor' in v else CIRCLE_BORDER,
                 'width': float(v.get('Width', 1)), 'border_width': float(v.get('BorderWidth', 3)),
                 'placement': kind != 'detection', 'passengers': []}
            cond = v.get('RequiresCondition', '').strip()
            if cond:
                # PassengerConditions (Cargo): the passenger types that grant it.
                pc = first(t, 'Cargo').get('PassengerConditions') or {}
                c['passengers'] = sorted(ids_lower[p.lower()] for p, g in pc.items() if g == cond)
                if not c['passengers']:
                    raise SystemExit(f'{aid}.{key}: unsupported RequiresCondition {cond}')
                c['placement'] = False
            if kind == 'range':
                c['range'] = wdist(v.get('FallbackRange', 0))
            elif kind == 'fixed':
                c['range'] = wdist(v.get('Range', 0))
            else:
                src_trait = {'detection': 'DetectCloaked', 'shroud': 'CreatesShroud', 'jammer': 'JamsMissiles'}[kind]
                parts = [p if isinstance(p, dict) else {} for p in trait(t, src_trait).values()]
                if any(p.get('RequiresCondition', '!').strip()[:1] != '!' for p in parts):
                    raise SystemExit(f'{aid}.{key}: {src_trait} with a RequiresCondition that is off by default')
                # DetectCloakedInfo.Range defaults to 5c0; CreatesShroud and JamsMissiles need one.
                c['range'] = max((wdist(p.get('Range', '5c0' if kind == 'detection' else 0)) for p in parts), default=0)
            out.append(c)
    return out


def tooltip_descriptions(a):
    """OpenRA TooltipDescription@ally and @other of a world actor (tech
    buildings): the text owners and their allies see, and the text everyone
    else sees."""
    tips = a.get('tooltipDescriptions') or {}
    unknown = set(tips) - {'ally', 'other'}
    if unknown:
        raise SystemExit(f"{a['id']}: unsupported TooltipDescription {sorted(unknown)}")
    return {'ally_description': (tips.get('ally') or '').strip(), 'other_description': (tips.get('other') or '').strip()}


def custom_sell_value(t):
    """OpenRA CustomSellValue.Value of resolved traits `t` (0 when the node
    gives none: the field's default in CustomSellValue.cs), or None without
    the trait (GetSellValue then counts the cost)."""
    if 'CustomSellValue' not in t:
        return None
    node = t['CustomSellValue']
    value = node.get('Value', '') if isinstance(node, dict) else ''
    return int(value) if value != '' else 0


def main():
    actors = {a['id']: a for a in json.load(open(os.path.join(DATA, 'actors.json')))}
    src = load_source_rules()
    for aid in EXTRA_ACTORS + WORLD_ACTORS:
        if aid not in actors:
            actors[aid] = extra_actor(src, aid)
    for aid in WEBRA_ACTORS:
        actors[aid] = webra_actor(src, aid)
    weapons = json.load(open(os.path.join(DATA, 'weapons.json')))
    wl = {k.lower(): k for k in weapons}
    locos = parse_locomotors()
    ids_lower = {k.lower(): k for k in actors}

    # Weapons and locomotors are numbered in order of first use; tools/gen_missions.py
    # starts from the built-in order so mission rules keep the same indices.
    out_actors, used_weapons, used_locos = [], list(WEAPON_ORDER), list(LOCOMOTOR_ORDER)

    def weapon_index(wname):
        wn = wl[wname.lower()]
        if wn not in used_weapons:
            used_weapons.append(wn)
        return used_weapons.index(wn)

    def damaging(wname):
        """weapon_index of a weapon that deals damage, else None (visual only)."""
        return weapon_index(wname) if hurts(weapons[wl[wname.lower()]]) else None

    tilesets = load_tilesets(src)
    overlay_types = overlay_manager_types(src)
    for aid in ACTORS + EXTRA_ACTORS + WORLD_ACTORS + WEBRA_ACTORS:
        a = actors[aid]
        t = a['traits']
        kind = ('proxy' if aid in PROXIES else 'building' if 'Building' in t else 'mine' if 'Mine' in t else 'crate' if 'Crate' in t else 'husk' if 'Husk' in t
                else {'Infantry': 'infantry', 'Ship': 'ship', 'Aircraft': 'aircraft'}.get(a['queue'], 'vehicle'))
        attack = first(t, 'AttackTurreted') or first(t, 'AttackFrontal') or first(t, 'AttackTesla') or first(t, 'AttackOmni')
        e = {
            'id': aid,
            'name': a['name'],
            'description': (a['description'] or '').replace('\\n', ' '),
            'kind': kind,
            'queue': a['queue'],
            'cost': a['cost'],
            # OpenRA CustomSellValue (GetSellValue: this, else the cost): what selling,
            # repairing and kill bounties count instead of the cost (pillboxes, refineries, walls).
            **({'custom_sell_value': csv} if (csv := custom_sell_value(t)) is not None else {}),
            'build_ticks': a['cost'] * int(a['buildDurationModifier'] or BUILD_DURATION_MODIFIER) // 100
            if not a['buildDuration'] or int(a['buildDuration']) < 0 else int(a['buildDuration']),
            'palette_order': a['buildPaletteOrder'],
            # Buildable.BuildLimit: owned plus queued at most (production.rs; 0 = none).
            'build_limit': int(t['Buildable'].get('BuildLimit', 0) or 0) if isinstance(t.get('Buildable'), dict) else 0,
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
            # Selectable (selection.rs): the selection hotkeys and double click.
            'selection': selection_info(t, aid),
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
            # Game rules of the lobby options (gamerules.rs): MustBeDestroyed
            # (null: does not keep its owner in the game; else
            # RequiredForShortGame), OwnerLostAction, GivesBounty (percent of
            # the value; the trait requires the `global-bounty` lobby option)
            # and the ^PlayerHandicaps multipliers.
            'must_be_destroyed': must_be_destroyed(t),
            'owner_lost': owner_lost(t),
            'gives_bounty': gives_bounty(t),
            'handicaps': 'HandicapDamageMultiplier' in t,
            # SpawnActorOnDeath: the husk a ground vehicle leaves (husks.rs);
            # HarvesterHuskModifier: [full husk, fullness threshold percent].
            # (The neutral world's husks, trees and the oil pump, are its own: world.spawn_on_death.)
            'spawn_on_death': None if aid in WORLD_ACTORS else spawn_on_death(t, kind, ids_lower),
            'full_husk': full_husk(t, ids_lower),
            # SpawnActorsOnSell (sell.rs), PrimaryBuilding (primary.rs) and ShakeOnDeath
            # ([duration, intensity]: a camera shake when it dies, presentation only).
            'sell_survivors': sell_survivors(t),
            'primary_building': 'PrimaryBuilding' in t,
            'shake_on_death': shake_on_death(t),
            # FireWarheadsOnDeath RequiresCondition !no-ore: only an ore truck with ore explodes.
            'death_needs_resources': isinstance(t.get('FireWarheadsOnDeath'), dict)
            and t['FireWarheadsOnDeath'].get('RequiresCondition') == '!no-ore',
            'husk': husk_info(t, actors, ids_lower, locos) if kind == 'husk' else None,
            'crate': crate_info(t, ids_lower, weapon_index) if kind == 'crate' else None,
            # ProducibleWithLevel: produced with levels while the owner has the prerequisites.
            'producible_level': {'prerequisites': tokens(t['ProducibleWithLevel'].get('Prerequisites')),
                                 'levels': int(t['ProducibleWithLevel'].get('InitialLevels', 1))}
            if isinstance(t.get('ProducibleWithLevel'), dict) else None,
            # WithProductionIconOverlay: the cameo overlay (the veteran chevron) and its prerequisites.
            'production_overlays': production_overlays(t, overlay_types),
            'fire_delays': [],
            'targets_allies': False,
            # WithDeathAnimation (infantry deaths per damage type, infantry.rs).
            'death': death_info(t) if kind == 'infantry' else None,
            # Infiltrates.Types this actor can be entered with (its Targetable types).
            'infiltrate_types': [x for x in INFILTRATE_TYPES if x in target_types(t)],
            # Targetable type Disguise: a Spy can disguise as it.
            'disguisable': 'Disguise' in target_types(t),
            # The neutral world's traits (engine/src/neutral.rs).
            'world': {**world_info(t, kind, weapon_index, damaging, ids_lower, tilesets, aid in WORLD_ACTORS), **tooltip_descriptions(a)},
        }
        e['fire_delays'], e['targets_allies'] = armament_info(t)
        # The battlefield tooltip and the range circles (engine/src/tooltip.rs, range_circles.rs).
        e['tooltip'] = tooltip_info(src, t)
        e['range_circles'] = range_circles(t, aid, ids_lower)
        if e['world'].get('indestructible'):
            e['hp'] = 1  # no Health trait: never damaged (the engine needs a positive value)
        # Only what differs from the engine's defaults (neutral.rs WorldTraits):
        # most actors have none of these traits.
        e['world'] = {k: v for k, v in e['world'].items() if (k == 'target' and v is not None) or (k != 'target' and v not in (None, False, [], 0))}
        for slot, arm in trait(t, 'Armament').items():
            # Garrison weapons belong to the soldier inside, not the vehicle or building.
            if isinstance(arm, dict) and arm.get('Name') != 'garrisoned':
                e['weapons'].append(weapon_index(arm['Weapon']))
        death = t.get('FireWarheadsOnDeath')
        # Death explosions that only make visual effects (BuildingExplode) deal no damage: skip them.
        # Structures keep the ones that hurt (barrels and oil derricks: BarrelExplode).
        if isinstance(death, dict) and death.get('Weapon') and (has_damage(weapons[wl[death['Weapon'].lower()]]) if kind != 'building'
                                                                else hurts(weapons[wl[death['Weapon'].lower()]])):
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
        if 'EjectOnDeath' in t:
            ej = t['EjectOnDeath'] if isinstance(t['EjectOnDeath'], dict) else {}
            # OpenRA EjectOnDeathInfo defaults: PilotActor E1, SuccessRate 50,
            # EjectInAir false, EjectOnGround false, AllowUnsuitableCell false.
            truth = lambda k, d: str(ej.get(k, d)).lower() == 'true'
            ab['eject_on_death'] = {'pilot': ids_lower[str(ej.get('PilotActor', 'E1')).lower()],
                                    'success_rate': int(ej.get('SuccessRate', 50)),
                                    'in_air': truth('EjectInAir', 'false'),
                                    'on_ground': truth('EjectOnGround', 'false'),
                                    'allow_unsuitable_cell': truth('AllowUnsuitableCell', 'false')}
        if 'MineImmune' in t:
            ab['mine_immune'] = {}
        # Infantry abilities (infantry.rs): engineers, spies, thieves, Tanya, dogs.
        if has(t, 'Captures'):
            ab['captures'] = captures_info(t)
        if has(t, 'Capturable'):
            c = first(t, 'Capturable') or next(iter(trait(t, 'Capturable').values()))
            c = c if isinstance(c, dict) else {}
            ab['capturable'] = {'types': sorted({x for v in trait(t, 'Capturable').values() if isinstance(v, dict) for x in tokens(v.get('Types'))}),
                                'cancel_activity': str(c.get('CancelActivity', 'False')).lower() == 'true'}
            # TransformOnCapture of husks: `husk` (husks.rs restore_husk) has what they turn into.
        if 'InstantlyRepairs' in t:
            ab['instantly_repairs'] = {}
        if 'InstantlyRepairable' in t:
            ab['instantly_repairable'] = {}
        if 'RepairsBridges' in t:
            ab['repairs_bridges'] = {}
        if has(t, 'Infiltrates'):
            v = next(iter(trait(t, 'Infiltrates').values()))
            v = v if isinstance(v, dict) else {}
            ab['infiltrates'] = {'types': tokens(v.get('Types')),
                                 'relationships': relationship_mask(v.get('ValidRelationships', 'Neutral, Enemy'))}
        infiltrated = infiltrated_info(t, ids_lower)
        if infiltrated:
            ab['infiltrated'] = infiltrated
        if 'Disguise' in t:
            ab['disguise'] = {}
        if 'IgnoresDisguise' in t:
            ab['ignores_disguise'] = {}
        if 'AnnounceOnKill' in t:
            k = t['AnnounceOnKill'] if isinstance(t['AnnounceOnKill'], dict) else {}
            ab['announce_on_kill'] = {'interval': int(k.get('Interval', ANNOUNCE_ON_KILL_INTERVAL))}
        if 'Demolition' in t:
            d = t['Demolition'] if isinstance(t['Demolition'], dict) else {}
            ab['demolition'] = {'delay': int(d.get('DetonationDelay', DEMOLITION_DELAY)),
                                'flashes': int(d.get('Flashes', DEMOLITION_FLASHES)),
                                'flash_delay': int(d.get('FlashesDelay', DEMOLITION_FLASH_DELAY)),
                                'flash_interval': int(d.get('FlashInterval', DEMOLITION_FLASH_INTERVAL))}
        if has(t, 'Demolishable'):
            ab['demolishable'] = {}
        if 'AttackLeap' in t:
            lp = t['AttackLeap'] if isinstance(t['AttackLeap'], dict) else {}
            # GrantConditionWhileAiming `run` speeds the dog up (SpeedMultiplier
            # requiring run); GrantConditionOnAttack `eating` pauses it after a bite.
            run = [int(v['Modifier']) for v in trait(t, 'SpeedMultiplier').values()
                   if isinstance(v, dict) and v.get('RequiresCondition') == 'run']
            eat = t.get('GrantConditionOnAttack') if isinstance(t.get('GrantConditionOnAttack'), dict) else {}
            ab['attack_leap'] = {'speed': wdist(lp.get('Speed', LEAP_SPEED)), 'run_speed': run[0] if run else 100,
                                 'eat_ticks': int(eat.get('RevokeDelay', 0))}
        if aid in PROXIES:
            # ProvidesPrerequisite without a Prerequisite provides the actor's own name.
            ab['proxy'] = {'provides': [(p.get('Prerequisite') if isinstance(p, dict) else None) or aid.lower()
                                        for p in trait(t, 'ProvidesPrerequisite').values()]}
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
            if base in ('ChronoshiftPower', 'GrantExternalConditionPower', 'NukePower', 'GpsPower', 'AirstrikePower', 'ParatroopersPower',
                        'SpawnActorPower'):
                v = v if isinstance(v, dict) else {}
                power = {'key': k, 'kind': base, 'name': ftl.get(v.get('Name', ''), v.get('Name', base)),
                         'description': ftl.get(v.get('Description', ''), ''),
                         'charge': int(v.get('ChargeInterval', 0)), 'prerequisites': tokens(v.get('Prerequisites')),
                         'duration': int(v.get('Duration', 0)), 'range': int(ints(v.get('Range', '1'))[0]) if v.get('Range') and 'c' not in v.get('Range') else wdist(v.get('Range')) // 1024 if v.get('Range') else 1,
                         'max_distance': int(v.get('MaxDistance', 0) or 0),
                         'palette_order': int(v.get('SupportPowerPaletteOrder', 0) or 0),
                         # SupportPowerInfo.Icon: its sequence of the `icon` image (observer icons, installed content).
                         'icon': v.get('Icon', ''),
                         # SupportPowerInfo.OrderName (default: the Info class name + "Order"); the
                         # AI's SupportPowerBotModule decisions name powers by it (ai_support.rs).
                         'order_name': v.get('OrderName', base + 'InfoOrder')}
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
                if base == 'SpawnActorPower':
                    # The Sonar Pulse spawns SONAR for LifeTime ticks: a DetectCloaked
                    # detector without a body (infantry.rs).
                    spawned = src.to_json(src.rules[v['Actor'].upper()])
                    det = spawned.get('DetectCloaked') if isinstance(spawned.get('DetectCloaked'), dict) else {}
                    power['duration'] = int(v.get('LifeTime', SPAWN_ACTOR_LIFETIME))
                    power['terrain'] = tokens(v.get('Terrain'))
                    power['allow_under_shroud'] = str(v.get('AllowUnderShroud', 'True')).lower() == 'true'
                    power['detect_range'] = wdist(det.get('Range', '5c0'))
                    power['detect_types'] = tokens(det.get('DetectionTypes', 'Cloak'))
                power['one_shot'] = str(v.get('OneShot', 'False')).lower() == 'true'
                # SupportPowerInfo.DisplayTimerRelationships (default None): to whom the
                # top-left countdown shows, relative to the owner (powers.rs power_timers).
                shown = [r.lower() for r in tokens(v.get('DisplayTimerRelationships')) if r.lower() != 'none']
                assert all(r in ('ally', 'neutral', 'enemy') for r in shown), (aid, k, shown)
                if shown:
                    power['display_timer'] = shown
                powers.append(power)
        if powers:
            ab['support_powers'] = powers

        if kind == 'building':
            b = t['Building']
            w, h = ints(b['Dimensions'])
            rows = footprint_rows(b['Footprint'])
            assert len(rows) == h and all(len(r) == w for r in rows), aid
            bridge = e['world'].get('bridge')
            if bridge:
                # A bridge covers its template (the first tileset that has it);
                # OpenRA's Building footprint of a bridge is all `_`.
                w, h = next(iter(bridge['templates'].values()))['size']
                rows = ['-' * w] * h
            elif e['world'].get('bridge_hut'):
                # Bridge huts stand on the bridge's cells without occupying them.
                rows = [r.replace('_', '-') for r in rows]
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
                    # PlayerExperience: what an allied repairer gains when the repair completes.
                    'player_experience': int(rb.get('PlayerExperience', 0)),
                }
            # Power down button (OpenRA ToggleConditionOnOrder with OrderName
            # PowerDown, ^DisableOnLowPowerOrPowerDown): the `powerdown` condition
            # zeroes the power drain (PowerMultiplier@POWERDOWN) and disables the
            # building like low power does (repair.rs).
            e['building']['power_down'] = any(isinstance(v, dict) and v.get('OrderName') == 'PowerDown'
                                              for v in trait(t, 'ToggleConditionOnOrder').values())
            lco = t['Building'].get('LocalCenterOffset')
            e['building']['center_offset'] = ints(lco)[:2] if lco else [0, 0]
            # WebRA trait LightningRod (data/webra/rules.yaml): lightning that
            # would land within Range is grounded on it (engine/src/lightning.rs).
            if 'LightningRod' in t:
                e['building']['lightning_rod'] = wdist(t['LightningRod']['Range'])
        elif kind in ('mine', 'crate', 'husk', 'proxy'):
            pass  # Immobile mines, crates and husks, bodiless proxies: no unit info.
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
                # MobileInfo / AircraftInfo.Speed default 1.
                'speed': int(m.get('Speed', 1)),
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
                    # AttackFollow.AbortOnResupply: true ends the attack (and what was
                    # queued after it) while it rearms; false resumes it once rearmed.
                    # WebRA deviation by the owner's choice: OpenRA defaults to true and no
                    # Red Alert rule changes it, WebRA defaults to false so aircraft out of
                    # ammo always come back for their target (docs/contracts.md).
                    'abort_on_resupply': str(first(t, 'AttackAircraft').get('AbortOnResupply', 'false')).lower() == 'true',
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
        # Cluster warheads add the weapons they fire while this runs.
        'weapons': [weapon_info(w, weapons, weapon_index) for w in used_weapons],
        'locomotors': [locomotor_info(l, locos) for l in used_locos],
        'world': world_rules(src, ids_lower),
        'bots': bot_rules(src, ids_lower),
    }
    with open(OUT, 'w') as fh:
        json.dump(rules, fh, indent=1)
    print(f'wrote {OUT}: {len(out_actors)} actors, {len(used_weapons)} weapons, {len(used_locos)} locomotors')


ftl = load_ftl()

if __name__ == '__main__':
    main()
