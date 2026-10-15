"""Assemble the 3D minimal pack: render every spec, write the manifests, PNG sheets and the .webrapack archives
(and check that the committed archives are up to date)."""
import importlib
import io
import json
import os
import zipfile

import core
import specs

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(ROOT, 'apps', 'game', 'packs')

# One models file per category; each exports ACTORS, optionally SPECIALS and ALIASES (see specs.py), and the
# terrain module exports TERRAIN (see tiles.py).
MODULES = [
    'models_buildings_base', 'models_buildings_production', 'models_buildings_tech', 'models_defence',
    'models_vehicles', 'models_vehicles_support', 'models_infantry', 'models_air_naval', 'models_civilian_props',
    'models_nature', 'models_bridges_props', 'models_specials',
]
TERRAIN_MODULE = 'models_terrain'

NAME = '3D minimal'
AUTHOR = 'WebRA'
VERSION = '1.0.0'
LICENSE = 'GPL-3.0-or-later'
DESCRIPTION = ("WebRA's built-in 3D minimal look: blocky, bright, low-poly models with three flat tones per face, "
               'drawn from boxes and octagons in the classic 3/4 camera. Every shape is WebRA\'s own.')

# The built-in pack ships as three archives: the terrain row of one pack is one set of tiles, and a map's biome
# picks the first pack with tiles for it.
ARCHIVES = {
    'minimal3d': ('temperate',),
    'minimal3d-snow': ('snow',),
    'minimal3d-desert': ('desert',),
}

# Actors that never get art (rules.json kind 'proxy': production upgrade markers and power proxies).
NO_ART_KINDS = {'proxy'}


def collect(only=None):
    actors, specials, aliases = {}, {}, {}
    for name in MODULES:
        try:
            mod = importlib.import_module(name)
        except ModuleNotFoundError as e:
            if e.name == name:
                continue
            raise
        for k, v in getattr(mod, 'ACTORS', {}).items():
            if k in actors:
                raise SystemExit(f'{name}: actor {k} is already declared by another models file')
            actors[k] = v
        for k, v in getattr(mod, 'SPECIALS', {}).items():
            if k in specials:
                raise SystemExit(f'{name}: special {k} is declared twice')
            specials[k] = v
        for k, v in getattr(mod, 'ALIASES', {}).items():
            if k in aliases or k in actors:
                raise SystemExit(f'{name}: alias {k} is declared twice')
            aliases[k] = v
    if only:
        aliases = {k: v for k, v in aliases.items() if k in only or v in only}
        keep = set(only) | set(aliases.values())
        actors = {k: v for k, v in actors.items() if k in keep}
        specials = {k: v for k, v in specials.items() if k in only}
    return actors, specials, aliases


def rules_actors():
    with open(os.path.join(ROOT, 'engine', 'rules.json')) as f:
        return json.load(f)['actors']


def coverage(actors, aliases, specials=()):
    """Rules actors without art (list of ids), declared ids rules do not have, aliases pointing nowhere."""
    rules = rules_actors()
    need = [a['id'] for a in rules if a['kind'] not in NO_ART_KINDS]
    have = set(actors) | set(aliases)
    # The mines are actors that packs address with the specials at_mine and ap_mine.
    have |= {a for s, a in (('at_mine', 'MINV'), ('ap_mine', 'MINP')) if s in specials}
    ids = {a['id'] for a in rules}
    missing = [i for i in need if i not in have]
    unknown = sorted(i for i in have if i not in ids)
    bad = sorted(k for k, v in aliases.items() if v not in actors)
    return missing, unknown, bad


def slug(s):
    return s.lower()


def render_all(actors, specials, log=print):
    """-> (files {path: bytes}, sprites [manifest dicts], cameos {ID: path}). Sprites of aliases are added by `manifest`."""
    files, sprites, cameos = {}, {}, {}
    rules = {a['id']: a for a in rules_actors()}

    def centre_shift(actor):
        """A structure's actor point is its footprint box centre plus center_offset (1/1024 cell), and the engine
        draws a pack sprite around that point: a sprite modelled around the box centre moves by minus the offset."""
        b = rules.get(actor, {}).get('building')
        co = (b or {}).get('center_offset') or [0, 0]
        return (-co[0] * core.CELL / 1024.0, -co[1] * core.CELL / 1024.0)

    def put_sprite(key, spr, base, shift=(0.0, 0.0)):
        stem = f'{base}{"-second" if spr.part == "second" else ""}{"" if spr.pose == "idle" else "-" + spr.pose}'
        entry = {}
        if spr.hidden:
            entry.update(part='second', hidden=True)
        else:
            sh = spr.sheet
            fw, fh = sh['frame']
            if fw > 512 or fh > 512:
                raise SystemExit(f'{key}: frame {fw} x {fh} is larger than 512')
            path = f'sprites/{stem}.png'
            files[path] = core.png_bytes(sh['width'], sh['height'], sh['rgba'])
            entry.update(image=path, frameSize=[fw, fh], facings=spr.facings)
            if sh['has_team']:
                mpath = f'sprites/{stem}-team.png'
                files[mpath] = core.png_bytes(sh['width'], sh['height'], core.team_mask_rgba(sh['team']))
                entry['teamMask'] = mpath
            if spr.frames != 1:
                entry['frames'] = spr.frames
            if spr.fps:
                entry['fps'] = spr.fps
            off = [round(sh['offset'][0] + shift[0], 2), round(sh['offset'][1] + shift[1], 2)]
            if off != [0, 0]:
                entry['offset'] = off
            if spr.rotate:
                entry['rotate'] = True
            if spr.part == 'second':
                entry['part'] = 'second'
            if spr.pose != 'idle':
                entry['pose'] = spr.pose
        return entry

    for i, (aid, spec) in enumerate(sorted(actors.items())):
        base = slug(aid)
        sp = []
        for spr in spec.sprites():
            e = put_sprite(aid, spr, base, centre_shift(aid) if spec.kind == 'building' else (0.0, 0.0))
            e['actor'] = aid
            sp.append(e)
        sprites[aid] = sp
        if rules.get(aid, {}).get('cost', 0) > 0 or aid in CAMEO_EXTRA:
            rgba = spec.cameo()
            if rgba:
                path = f'cameos/{base}.png'
                files[path] = core.png_bytes(specs.CAMEO_W, specs.CAMEO_H, rgba)
                cameos[aid] = path
        if (i + 1) % 25 == 0:
            log(f'  {i + 1}/{len(actors)} actors')
    for name, spec in sorted(specials.items()):
        sp = []
        for spr in spec.sprites():
            e = put_sprite(name, spr, f'fx-{name}')
            e['special'] = name
            sp.append(e)
        sprites['*' + name] = sp
    return files, sprites, cameos


CAMEO_EXTRA = set()


def manifest_for(archive, sprites, cameos, aliases, terrain_files):
    sprite_list = []
    for key in sorted(sprites):
        sprite_list += sprites[key]
    for alias, target in sorted(aliases.items()):
        for e in sprites[target]:
            c = dict(e)
            c['actor'] = alias
            sprite_list.append(c)
    cam = dict(cameos)
    for alias, target in aliases.items():
        if target in cameos:
            cam[alias] = cameos[target]
    m = {
        'format': 'webra-pack', 'formatVersion': 1, 'name': NAME if archive == 'minimal3d' else f'{NAME} ({archive.split("-")[-1]})',
        'author': AUTHOR, 'version': VERSION, 'license': LICENSE, 'description': DESCRIPTION,
    }
    if archive == 'minimal3d':
        m['sprites'] = sprite_list
        m['cameos'] = {k: cam[k] for k in sorted(cam)}
    if terrain_files:
        m['terrain'] = terrain_files
    return m


def zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in sorted(entries):
            zi = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, entries[name])
    return buf.getvalue()


def build(only=None, log=print):
    """-> {archive file name: {entry name: bytes}} for the three archives."""
    actors, specials, aliases = collect(only)
    if not only:
        missing, unknown, bad = coverage(actors, aliases, specials)
        if missing or unknown or bad:
            log(f'coverage: {len(missing)} actors without art, {len(unknown)} unknown ids, {len(bad)} bad aliases')
            if missing:
                log('  missing: ' + ' '.join(missing))
            if unknown:
                log('  unknown: ' + ' '.join(unknown))
            if bad:
                log('  bad aliases: ' + ' '.join(bad))
    log(f'rendering {len(actors)} actors and {len(specials)} specials ...')
    files, sprites, cameos = render_all(actors, specials, log)
    out = {}
    try:
        terrain_mod = importlib.import_module(TERRAIN_MODULE)
    except ModuleNotFoundError as e:
        if e.name != TERRAIN_MODULE:
            raise
        terrain_mod = None
    for archive, biomes in ARCHIVES.items():
        entries = {}
        terr = None
        if terrain_mod and not only:
            tfiles, terr = terrain_mod.build(biomes[0], archive)
            entries.update(tfiles)
        if archive == 'minimal3d':
            entries.update(files)
        if not entries and not terr:
            continue
        m = manifest_for(archive, sprites, cameos, aliases, terr)
        entries['manifest.json'] = (json.dumps(m, indent=1, sort_keys=False) + '\n').encode()
        out[archive + '.webrapack'] = entries
    return out


def write(archives, directory=OUT_DIR):
    os.makedirs(directory, exist_ok=True)
    for name, entries in archives.items():
        data = zip_bytes(entries)
        with open(os.path.join(directory, name), 'wb') as f:
            f.write(data)
        print(f'wrote {os.path.relpath(os.path.join(directory, name), ROOT)}: {len(entries)} files, {len(data) // 1024} KiB')


def same_entry(name, a, b):
    if a == b:
        return True
    if name.endswith('.png'):
        try:
            return core.png_decode(a) == core.png_decode(b)
        except (AssertionError, Exception):
            return False
    return False


def check(archives, directory=OUT_DIR):
    """Compare the freshly rendered archives with the committed ones, entry by entry (PNGs by their pixels, so a
    different zlib build does not matter). Returns a list of problems."""
    problems = []
    for name, entries in archives.items():
        path = os.path.join(directory, name)
        if not os.path.exists(path):
            problems.append(f'{name} is missing: run python3 tools/gen_minimal3d/generate.py')
            continue
        with zipfile.ZipFile(path) as z:
            have = {n: z.read(n) for n in z.namelist()}
        for n in sorted(set(entries) | set(have)):
            if n not in have:
                problems.append(f'{name}: {n} is not in the committed archive')
            elif n not in entries:
                problems.append(f'{name}: {n} is no longer generated')
            elif not same_entry(n, entries[n], have[n]):
                problems.append(f'{name}: {n} differs')
    for name in sorted(os.listdir(directory)) if os.path.isdir(directory) else []:
        if name.startswith('minimal3d') and name.endswith('.webrapack') and name not in archives:
            problems.append(f'{name} is no longer generated')
    return problems
