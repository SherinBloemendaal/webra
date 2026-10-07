import json, sys, os
src = sys.argv[1]
A = json.load(open(os.path.join(src, 'actors.json')))
W = json.load(open(os.path.join(src, 'weapons.json')))
WL = {k.lower(): k for k in W}

def cells(r):
    if not r: return ''
    if 'c' in r:
        c, l = r.split('c'); return f"{int(c) + int(l)/1024:.2f}".rstrip('0').rstrip('.')
    return f"{int(r)/1024:.2f}"
def hp(x): return '' if x is None else str(x // 100)
FN = {'allies': 'All', 'england': 'Eng', 'france': 'Fra', 'germany': 'Ger', 'soviet': 'All', 'russia': 'Rus', 'ukraine': 'Ukr'}
FULL = {'Allies': {'allies', 'england', 'france', 'germany'}, 'Soviet': {'soviet', 'russia', 'ukraine'}}
NICE = {'allies': 'Allies (random)', 'england': 'England', 'france': 'France', 'germany': 'Germany', 'soviet': 'Soviet (random)', 'russia': 'Russia', 'ukraine': 'Ukraine'}
def who(u):
    if u['side'] == 'Both': return 'Both'
    fs = set(u['factions'])
    if u['side'] in FULL:
        if fs >= FULL[u['side']]: return u['side']
        missing = FULL[u['side']] - fs
        if len(fs) == 1: return f"{u['side']}: {NICE[next(iter(fs))]} only"
        return f"{u['side']}, not {', '.join(NICE[x] for x in sorted(missing))}"
    return u['side']
def weps(u):
    seen = []
    for w in u['weapons']:
        if w['weapon'] not in seen: seen.append(w['weapon'])
    s = ', '.join(seen)
    if u.get('garrison'): s = (s + ', ' if s else '') + f"garrisoned by {u['garrison'].upper()}"
    return s
def prereq(u):
    return ', '.join(p for p in u['prerequisites'] if not p.startswith(('~techlevel', '~vehicles.', '~structures.', '~infantry.', '~!')))

L = []
L.append('# Red Alert unit and building catalog (OpenRA `ra` mod)\n')
L.append('Source: [OpenRA/OpenRA `bleed` mods/ra/rules + weapons](https://github.com/OpenRA/OpenRA/tree/bleed/mods/ra), fetched 2026-10-07, inheritance (`Inherits`, `-Trait` removals) fully resolved.')
L.append('Per-faction availability is computed by walking the tech tree (`ProvidesPrerequisite` / `Prerequisites`) for every subfaction.\n')
L.append('**Units:** HP and damage are OpenRA values / 100 (OpenRA stores them x100; numbers follow current OpenRA multiplayer balance, which differs slightly from the 1996 game). Range and sight are in cells (1 cell = 1024 world units). Speed is world units per tick. Power: + produces, - consumes. Build time in OpenRA is derived from cost unless `BuildDuration` is set.\n')
L.append('Full trait-level data for every actor (every property OpenRA defines) is in `actors.json`; every weapon with projectile and warheads is in `weapons.json`.\n')

def table(units, building):
    if building:
        L.append('| ID | Name | Side | Cost | HP | Armor | Power | Size | Tech | Requires | Weapons |')
        L.append('|---|---|---|---|---|---|---|---|---|---|---|')
        for u in units:
            L.append(f"| {u['id']} | {u['name']} | {who(u)} | {u['cost']} | {hp(u['hp'])} | {u['armor'] or ''} | {u['power'] or ''} | {(u['dimensions'] or '').replace(',', 'x')} | {u['techLevel'] or ''} | {prereq(u)} | {weps(u)} |")
    else:
        L.append('| ID | Name | Side | Cost | HP | Armor | Speed | Sight | Tech | Requires | Weapons | Cargo |')
        L.append('|---|---|---|---|---|---|---|---|---|---|---|---|')
        for u in units:
            L.append(f"| {u['id']} | {u['name']} | {who(u)} | {u['cost']} | {hp(u['hp'])} | {u['armor'] or ''} | {u['speed'] or ''} | {cells(u['sight'])} | {u['techLevel'] or ''} | {prereq(u)} | {weps(u)} | {u['cargo'] or ''} |")
    L.append('')

sections = [('Buildings', 'Building', True), ('Defenses and superweapons', 'Defense', True), ('Infantry', 'Infantry', False),
            ('Vehicles', 'Vehicle', False), ('Aircraft', 'Aircraft', False), ('Ships', 'Ship', False)]
for title, q, b in sections:
    real = [u for u in A if u['queue'] == q and not u['fake'] and u['side'] != 'Unavailable']
    L.append(f'## {title} ({len(real)})\n'); table(real, b)

L.append('## Support powers\n')
L.append('| Building | Power | Recharge (s) | Extra requirement |'); L.append('|---|---|---|---|')
for u in A:
    for p in u['supportPowers']:
        if u['id'] == 'AFLD.Ukraine': continue
        L.append(f"| {u['name']} ({u['id']}) | {p['name']} | {int(p['chargeInterval'])//25 if p['chargeInterval'] else ''} | {p['prerequisites'] or ''} |")
L.append('\nRecharge assumes 25 ticks per second (OpenRA "normal" speed).\n')

fakes = [u for u in A if u['fake'] and u['side'] != 'Unavailable']
L.append(f'## France decoy buildings ({len(fakes)})\n')
L.append(', '.join(f"{u['name']} ({u['id']}, ${u['cost']})" for u in fakes) + '\n')
un = [u for u in A if u['side'] == 'Unavailable']
L.append(f'## Defined but not buildable in skirmish ({len(un)})\n')
L.append(', '.join(f"{u['name']} ({u['id']})" for u in un) + '. Ants/zombies are campaign/mission-only; the Hind is disabled in multiplayer balance.\n')

used = sorted({WL.get(w['weapon'].lower(), w['weapon']) for u in A for w in u['weapons']}, key=str.lower)
L.append(f'## Weapons used by buildable actors ({len(used)})\n')
L.append('Damage is per warhead hit (HP / 100 scale as above). Versus = % damage against each armor type (unlisted = 100%).\n')
L.append('| Weapon | Damage | Range | Reload (ticks) | Burst | Projectile | Spread | Versus |'); L.append('|---|---|---|---|---|---|---|---|')
for n in used:
    w = W.get(WL.get(n.lower(), n))
    if not w: L.append(f'| {n} | (not found) |||||||'); continue
    dmg = next((v for k, v in w.items() if k.startswith('Warhead') and isinstance(v, dict) and v.get('_') in ('SpreadDamage', 'TargetDamage', 'HealthPercentageDamage')), {})
    proj = w.get('Projectile'); proj = proj.get('_') if isinstance(proj, dict) else proj
    vs = dmg.get('Versus', {})
    vs_s = ' '.join(f"{k}:{v}" for k, v in vs.items()) if isinstance(vs, dict) else ''
    d = dmg.get('Damage'); d = str(int(d)//100) if d and d.lstrip('-').isdigit() else (d or '')
    L.append(f"| {n} | {d} | {cells(w.get('Range'))} | {w.get('ReloadDelay','')} | {w.get('Burst','1')} | {proj or ''} | {cells(dmg.get('Spread')) if dmg.get('Spread') else ''} | {vs_s} |")
open(os.path.join(src, 'CATALOG.md'), 'w').write('\n'.join(L) + '\n')
print('ok')
