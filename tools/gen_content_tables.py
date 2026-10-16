#!/usr/bin/env python3
"""Generate apps/game/js/content/tables.js: what the original graphics are made of.

WebRA never ships Red Alert graphics. When the player installs them from their
own copy (apps/game/js/content/install.js), these tables say which files to
keep and how to cut them into sprites, the way OpenRA does it.

Input (OpenRA mods/ra, GPL-3.0, copied into data/source, see data/CATALOG.md):
- data/source/sequences/*.yaml: sprite sequences per image (OpenRA
  ClassicTilesetSpecificSpriteSequence): file, start, length, facings, tick,
  offset, shadow start, tileset specific file names.
- data/source/rules/*.yaml: RenderSprites Image overrides (fakes and variants
  that borrow another actor's art).
- data/source/tilesets/*.yaml: the terrain type of every tile of every
  template, used to pick templates for WebRA's terrain types.
- data/source/bits.txt: the files OpenRA makes and ships itself (mods/ra/bits).
  Most are missing from a player's own copy of Red Alert, so every sequence
  that uses one is mapped to the original file it stands in for
  (ORIGINAL_FILES, ORIGINAL_SEQUENCES) or left out (NO_ORIGINAL). Some are
  OpenRA's copies of Red Alert files of the same name (IN_RED_ALERT_TOO):
  those are drawn from the player's file (SAME_LAYOUT) unless the layout
  differs (OTHER_LAYOUT). A bits file nobody decided about is an error, and
  so is an actor OpenRA draws from an original file without ACTOR_ART.
- engine/rules.json: the actors WebRA has (id, kind, turret, harvester).
- data/webra/rules.yaml: WebRA's own actors (no OpenRA or Red Alert art).

Output (apps/game/js/content/tables.js, render-facts.js and engine/render.json):
- SEQUENCES[image][sequence] = normalized sequence fields (see SequenceDef in
  apps/game/js/content/sequences.js).
- ACTOR_ART[actor id] = { image, body: {pose: sequence}, second: {pose:
  sequence} | null, wall?, overlay?, bib?, cameo, fakeMark?, muzzle? } (or only { image,
  muzzle } for an actor without an original body): which sequence each pose of
  (infantry: stand variants, idle animations and deaths too) of
  the engine's body slot (2t) and second slot (2t + 1: turret, prone for
  infantry, or the layer drawn over a structure: `overlay` names its kind,
  "door" for OpenRA WithProductionDoorOverlay) uses; `bib` is the
  WithBuildingBib sequence drawn under the structure. Bridges (OpenRA
  LegacyBridgeLayer: their art is terrain templates) have `bridge` instead:
  per tileset the template files of each state (healthy, damaged,
  destroyed, and the long bridge spans' destroyed_north, destroyed_south,
  destroyed_both) and the template size.
- TERRAIN[tileset] = { palette, rotation, images: [file], templates: [[image,
  width, height, role, cells, road cells]] }: the templates the tile terrain
  uses, by role (TERRAIN_ROLES), with the cells of the template that have a
  tile and, for road templates, those of them whose terrain is Road.
- TREES: tree images (decorations) composited onto tree cells.
- RESOURCES: ore and gem overlay sequences (misc.yaml "resources").
- SPECIAL_ART, EXPLOSIONS, EXPLOSION_ART, MUZZLE_ACTORS: the engine's special
  sprites, explosions and muzzle flashes with original art.
- FAKE_ACTORS: the fake structures, whose cameos carry a FAKE mark.
- CURSOR_ART: OpenRA's cursors (data/source/cursors.yaml) in mouse.shp.
- GRAPHICS_FILES: every file name the tables can use (what the installer keeps).
- render-facts.js RENDER_FACTS: what OpenRA draws per actor (the art audit);
  WEBRA_ACTORS: WebRA's own actors, which OpenRA does not draw at all.
- engine/render.json: effect warheads per weapon, muzzle flashes, damage
  smoke and working animations per actor (engine/src/fx.rs).

Run: python3 tools/gen_content_tables.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'source')
OUT = os.path.join(ROOT, 'apps', 'game', 'js', 'content', 'tables.js')
FACTS_OUT = os.path.join(ROOT, 'apps', 'game', 'js', 'content', 'render-facts.js')
RENDER_OUT = os.path.join(ROOT, 'engine', 'render.json')
RULES_JSON = os.path.join(ROOT, 'engine', 'rules.json')
OPENRA_COMMIT = 'b6fc03fcfaef1277592bbd4cbc7d44dd85219902'
SEQUENCE_FILES = ['ships', 'vehicles', 'structures', 'infantry', 'aircraft', 'misc', 'decorations']

# OpenRA tilesets WebRA biomes can use, and their palettes (mods/ra/rules/palettes.yaml).
TILESETS = {
    'TEMPERAT': {'file': 'temperat', 'palette': 'temperat.pal'},
    'SNOW': {'file': 'snow', 'palette': 'snow.pal'},
    'DESERT': {'file': 'desert', 'palette': 'desert.pal'},
}
# Actors are drawn with the "player" palette, which is temperat.pal on every tileset.
ACTOR_PALETTE = 'temperat.pal'

# Smudge images (world.yaml SmudgeLayer@SCORCH and @CRATER): one sequence per
# variant, a frame per depth (engine/src/smudges.rs).
SMUDGE_IMAGES = {'scorch': 'scorches', 'crater': 'craters'}

TREES = ['t01', 't02', 't03', 't05', 't06', 't07', 't08', 't10', 't11', 't12', 't13', 't14', 't15', 't16', 't17']

# OpenRA RotationPaletteEffect (mods/ra/rules/palettes.yaml): the terrain
# palette indices that cycle to animate water, per tileset.
WATER_ROTATION = {'TEMPERAT': [96, 7], 'SNOW': [96, 7], 'DESERT': [32, 7]}

# What the tile terrain (apps/game/js/content/terrain.js) draws WebRA's
# terrain classes with, per tileset: template image names by role. clear:
# plain ground variants; water: open water; shore: beaches (the runtime
# matches their tiles to the coastline by their pixels); rough: loose stones
# on open ground; rock: boulders on open ground (impassable); water-rock:
# rocks standing in water; road: every road template (the runtime fits their
# tiles along WebRA's roads by their pixels, the road cells' tiles on road
# cells and their verges on the clear ground beside). Templates made by
# OpenRA (bits.txt) are left out.
TERRAIN_ROLES = {
    'TEMPERAT': {
        'clear': ['clear1'],
        'water': ['w1', 'w2'],
        'shore': 'Beach',
        'rough': ['rf01', 'rf02', 'rf03', 'rf04', 'rf05', 'rf06', 'rf07', 'rf08', 'rf09', 'rf10', 'rf11'],
        'rock': ['b1', 'b2', 'b3'],
        'water-rock': ['sh55', 'sh56'],
        'road': 'Road',
    },
    'SNOW': {
        'clear': ['clear1'],
        'water': ['w1', 'w2'],
        'shore': 'Beach',
        'rough': ['rf01', 'rf02', 'rf03', 'rf04', 'rf05', 'rf06', 'rf07', 'rf08', 'rf09', 'rf10', 'rf11'],
        'rock': ['b1', 'b2', 'b3'],
        'water-rock': ['sh55', 'sh56'],
        'road': 'Road',
    },
    'DESERT': {
        'clear': ['clear1'],
        'water': ['sh17', 'sh18'],
        'shore': 'Beach',
        'rough': ['p01', 'p02', 'p03', 'p07'],
        'rock': ['p04'],
        'water-rock': [],
        'road': 'Road',
    },
}

# OpenRA's own files (bits.txt) -> the original Red Alert file with the same
# frame layout that a player's copy has (OpenRA added shadows, remap or
# theater variants to these).
ORIGINAL_FILES = {
    'tent.tem': 'tent.shp',
    'tent.sno': 'tent.shp',
    'tent.des': 'tent.shp',
    'tentmake.tem': 'tentmake.shp',
    'tentmake.sno': 'tentmake.shp',
    'tentmake.des': 'tentmake.shp',
    'hbox.des': 'hbox.tem',
    'hboxmake.des': 'hboxmake.tem',
    'mslo.des': 'mslo.tem',
    'mslomake.des': 'mslomake.tem',
    'sam2.shp': 'sam.shp',
    'silo2.shp': 'silo.shp',
    'afldidle.shp': 'afld.shp',
    'tran2.shp': 'tran.shp',
    'msloicon2.shp': 'msloicon.shp',
    # OpenRA's large rotor for the Hind; Red Alert draws the Hind with the
    # helicopter rotor (the same 4 fast and 8 slow frames).
    'lrotorlg.shp': 'lrotor.shp',
    # Husks of the ore truck and the MCV: Red Alert has none, OpenRA draws
    # them; the vehicles' own frames (32 facings first in both) stand in, and
    # the engine darkens them like OpenRA's husks (engine/src/husks.rs).
    'hhusk.shp': 'harv.shp',
    'hhusk2.shp': 'harv.shp',
    'mcvhusk.shp': 'mcv.shp',
}
# Sequences whose OpenRA file has another layout than the original one.
ORIGINAL_SEQUENCES = {
    # weap3.shp has ten door frames; the original weap2.shp has four, then four damaged ones.
    ('weap', 'build-top'): {'file': 'weap2.shp', 'start': 0, 'length': 4},
    # silo2.shp has nine fill stages, then nine damaged ones; the original
    # silo.shp has five, then five damaged ones.
    ('silo', 'idle'): {'file': 'silo.shp', 'start': 0, 'length': 1},
    ('silo', 'damaged-idle'): {'file': 'silo.shp', 'start': 5, 'length': 1},
    ('silo', 'stages'): {'file': 'silo.shp', 'start': 0, 'length': 5},
    ('silo', 'damaged-stages'): {'file': 'silo.shp', 'start': 5, 'length': 5},
    # Crates: OpenRA's scrate.shp and wcrate.shp hold idle, land and water
    # frames; Red Alert's overlays (SCRATE, WCRATE, WWCRATE in its source) are
    # a crate on land each and the crate in water.
    ('scrate', 'idle'): {'file': 'scrate.shp', 'start': 0, 'length': 1},
    ('scrate', 'land'): {'file': 'scrate.shp', 'start': 0, 'length': 1},
    ('scrate', 'water'): {'file': 'wwcrate.shp', 'start': 0, 'length': -1},
    ('wcrate', 'idle'): {'file': 'wcrate.shp', 'start': 0, 'length': 1},
    ('wcrate', 'land'): {'file': 'wcrate.shp', 'start': 0, 'length': 1},
}
# OpenRA's files that stand in for a shorter original: the sequence keeps at
# most that many frames of the original file.
ORIGINAL_SHORTER = {
    # OpenRA's five-frame cannon flash; Red Alert's gunfire.shp has three.
    'gunfire2.shp': ('gunfire.shp', 3),
}
# OpenRA's files with no original counterpart: sequences using them are left
# out (fake structures show the real cameo with WebRA's FAKE mark over it,
# ACTOR_ART fakeMark; OpenRA's own units, the Mobile
# Flak and the Black Hawk, are WebRA's own pixel art, tools/gen_pixel_art.py,
# small bibs and the refinery top are not drawn).
NO_ORIGINAL = {
    'ateficon.shp', 'fapwicon.shp', 'fixficon.shp', 'fpwricon.shp', 'mslficon.shp', 'pdoficon.shp', 'tenficon.shp',
    'ftrk.shp', 'ftrkicon.shp', 'mh60.shp', 'mh60icon.shp', 'proctop.shp', 'yrotorlg.shp',
    # The crate level up animation OpenRA drew (crate-effects levelup): WebRA art.
    'levelup.shp',
    # Veterancy ranks, the repair wrench and the power off sign exist in OpenRA only.
    'rank.shp', 'allyrepair.shp', 'poweroff.shp',
    # The mines' sidebar icon.
    'jmin.shp',
    # The neutral world's art OpenRA drew itself (it keeps WebRA art): ammo
    # boxes, huts, the hospital icon, make animations of tech buildings, the
    # oil derrick (WebRA's own pixel art, tools/gen_pixel_art.py), ore and gem
    # mines on some tilesets, poles, traps and more.
    'ammobox1.shp', 'ammobox2.shp', 'ammobox3.shp', 'asianhut.shp', 'c11.shp', 'ctflag.shp', 'fcommake.shp',
    'gmine.des', 'gmine.sno', 'gmine.tem', 'hospicon.shp', 'lhus.shp', 'mine.des', 'mine.int', 'missmake.shp', 'oilb.shp',
    'railmine.des', 'railmine.sno', 'railmine.tem', 'rushouse.shp', 'snowhut.shp', 'tanktrap1.shp', 'tanktrap2.shp',
    'rice.tem', 'tc01.des', 'utilpol1.shp', 'utilpol2.shp', 'v19.des', 'windmill.shp',
    # Campaign wrecks OpenRA drew itself (MISSION_ART) and its anti-ant cameo: WebRA art.
    'tran1husk.shp', 'tran2husk.shp', 'anticon.shp',
} | {f'mb{b}.{ext}' for b in ['agun', 'fix', 'ftur', 'gap', 'gun', 'hosp', 'iron', 'pbox', 'pdox', 'sam', 'silo', 'tsla'] for ext in ['tem', 'sno', 'int', 'des']}
# OpenRA's files that replace an original of the same name and frame layout
# (shadows or touch-ups): the player's original works with the same sequence.
SAME_LAYOUT = {
    'fact.shp', 'factmake.shp', 'gap.shp', 'gapmake.shp', 'harv.shp', 'heli.shp', 'hind.shp', 'mgg.shp',
    'silomake.shp', 'truk.shp', 'yak.shp', 'stnkicon.shp',
    # OpenRA's engineer only adds team colours to the original's frames.
    'e6.shp',
    # Einstein and Dr. Chan (hires.mix): the original's 165 frames, one touched up.
    'einstein.shp', 'chan.shp',
    # The crate heal animation (conquer.mix): the same file.
    'invun.shp',
    # The small napalm explosion (conquer.mix): Red Alert's own 14 frames,
    # which OpenRA redrew larger.
    'napalm1.shp',
    # Snow smudges (snow.mix): the original's frames, one touched up.
    'cr4.sno', 'cr5.sno', 'sc4.sno',
    # Desert water (Tiberian Dawn's desert.mix): the same file.
    'w1.des',
}
# OpenRA's files that a player's Red Alert has under the same name with
# another frame layout: the crates (ORIGINAL_SEQUENCES maps their sequences)
# and a desert debris template (Tiberian Dawn's has two tiles, OpenRA's four;
# the tile terrain leaves it out, it uses no debris).
OTHER_LAYOUT = {'scrate.shp', 'wcrate.shp', 'br10.des'}
# OpenRA's files (bits.txt) whose name the archives of a player's own Red
# Alert also have (conquer.mix, hires.mix, snow.mix, Aftermath's hires1.mix,
# Tiberian Dawn's desert.mix), found by the archives' name hashes. Each is
# decided in SAME_LAYOUT or OTHER_LAYOUT, never NO_ORIGINAL or a stand-in
# (check_bits_decisions). tools/art-audit.mjs reports any other bits file it
# finds in a player's files (render-facts.js OPENRA_MADE_FILES).
IN_RED_ALERT_TOO = {
    'br10.des', 'chan.shp', 'cr4.sno', 'cr5.sno', 'e6.shp', 'einstein.shp', 'fact.shp', 'factmake.shp', 'gap.shp',
    'gapmake.shp', 'harv.shp', 'heli.shp', 'hind.shp', 'invun.shp', 'mgg.shp', 'napalm1.shp', 'sc4.sno', 'scrate.shp',
    'silomake.shp', 'stnkicon.shp', 'truk.shp', 'w1.des', 'wcrate.shp', 'yak.shp',
}

# What the engine's special sprites (engine/src/render.rs SpriteIds, the
# SPECIALS of apps/game/js/sprites.js and the eight slots of each art module)
# show with the original graphics: [OpenRA image, sequence, mode] or None
# when Red Alert has no art for it (WebRA's own art stays). Modes: "loop"
# plays on the render clock (projectiles, flags, smoke), "effect" plays once
# from the moment the engine starts the effect and then shows nothing
# (explosions, splashes). WebRA's effects are generic where OpenRA picks one
# per warhead, so each takes the sequence most of its users have in OpenRA.
# Sequences may be a list: "effect" plays them one after the other, "lead"
# plays the first once and then loops the second; "index" shows the frame
# the engine names.
SPECIAL_ART = {
    # Cannon shells (OpenRA ^Cannon Image: 120mm) and other direct fire.
    'bullet': ['120mm', 'idle', 'loop'],
    # Cannon hits (90mm, 105mm, 120mm: Explosions small_explosion).
    'small_explosion': ['explosion', 'small_explosion', 'effect'],
    # Vehicles, ships and aircraft blowing up (UnitExplode: self_destruct).
    'large_explosion': ['explosion', 'self_destruct', 'effect'],
    # Small arms hits (piff).
    'piff': ['explosion', 'piff', 'effect'],
    # The rally point flag (RallyPoint: rallypoint flag).
    'rally': ['rallypoint', 'flag', 'loop'],
    # Reserved: mines are drawn as their actors (MINV, MINP: ACTOR_ART); a
    # texture pack's at_mine and ap_mine sprites replace those actors' bodies.
    'at_mine': None,
    'ap_mine': None,
    # WebRA's Tesla zap segment; with the original art the engine draws
    # OpenRA's TeslaZap from the fx.1 and fx.2 frames instead (fx.rs).
    'tesla_bolt': None,
    # Rockets (^AntiGroundMissile Image: DRAGON), 32 facings.
    'missile': ['dragon', 'idle', 'loop'],
    # Artillery shells (155mm, 8Inch: Image 120mm).
    'shell': ['120mm', 'idle', 'loop'],
    # The chronoshift shimmer has no sprite in Red Alert (OpenRA flashes the screen).
    'chrono': None,
    'nuke': ['explosion', 'nuke', 'effect'],
    # Naval: torpedo (TorpTube Image: torpedo, 32 facings), depth charge
    # (DepthCharge Image: BOMB), splash (med_splash), the submerged ripple and
    # the sinking wreck (WebRA only).
    'naval.0': ['torpedo', 'idle', 'loop'],
    'naval.1': ['bomb', 'idle', 'loop'],
    'naval.2': ['explosion', 'med_splash', 'effect'],
    'naval.3': None,
    'naval.4': None,
    # Planes: parachute (WithParachute: parach open once, then idle), parabomb, contrail
    # (OpenRA draws contrails as lines), wreck smoke (LeavesTrails smokey).
    'planes.0': ['parach', ['open', 'idle'], 'lead'],
    'planes.1': ['parabomb', 'idle', 'loop'],
    'planes.2': None,
    'planes.3': ['smokey', 'idle', 'loop'],
    # Helicopters: rotor disc and rotor wash are WebRA's (the original rotor
    # sequences replace both), smoke of a falling wreck.
    'helis.0': None,
    'helis.1': None,
    'helis.2': ['smokey', 'idle', 'loop'],
    # Ability markers (mine warning, MAD ring, chronoshift flash, iron curtain
    # glow, gap generator edge, atom bomb beacon): WebRA only.
    'abilities.0': None,
    'abilities.1': None,
    'abilities.2': None,
    'abilities.3': None,
    'abilities.4': None,
    'abilities.5': None,
    # Veterancy ranks (rank.shp is OpenRA's).
    'veterancy.0': None,
    'veterancy.1': None,
    'veterancy.2': None,
    'veterancy.3': None,
    # The repair wrench: OpenRA's WithBuildingRepairDecoration draws its own
    # allyrepair.shp in the colour of each repairing player in turn (Palette
    # player, IsPlayerPalette), so allied repairers are told apart; Red
    # Alert's select.shp wrench has no remap colours. WebRA's team coloured
    # wrench always. The power off sign: speed.shp disabled frame, OpenRA's
    # "powerdown" image.
    'decorations.0': None,
    'decorations.1': ['powerdown', 'disabled', 'loop'],
    # The neutral world (engine/src/neutral.rs): trees on fire (^Tree
    # WithDamageOverlay@SmallBurn, @MediumBurn, @LargeBurn: start, loop and
    # end in a row, the engine names the frame, MODE.INDEX) and the
    # hospital's red cross over healed infantry (WithDecoration@REDCROSS).
    'decorations.2': ['burn-s', ['start', 'loop', 'end'], 'index'],
    'decorations.3': ['pips', 'medic', 'loop'],
    'decorations.4': ['burn-m', ['start', 'loop', 'end'], 'index'],
    'decorations.5': ['burn-l', ['start', 'loop', 'end'], 'index'],
    # Effects of the engine (fx.rs): damage smoke (WithDamageOverlay: the
    # start, then the loop LoopCount times; the engine names the frame of the
    # start and loop frames in a row, MODE.INDEX), the bright and dim Tesla
    # zap frames (TeslaZap: the frame per step direction, MODE.INDEX).
    'fx.0': ['smoke_m', ['start', 'loop'], 'index'],
    'fx.1': ['litning', 'bright', 'index'],
    'fx.2': ['litning', 'dim', 'index'],
    # The anti-air missile of the SAM site, the rocket soldier's Redeye and
    # the missile sub (Nike, RedEye, SubMissileAA: Image MISSILE, 32
    # facings); every other missile is a DRAGON rocket ('missile' above).
    # engine/render.json `missiles` names the weapons drawn with it.
    'fx.3': ['missile', 'idle', 'loop'],
    # The atom bomb (NukePower MissileImage atomic, MissileUp up and
    # MissileDown down, PlayRepeating): rising, then falling (abilities.rs).
    'fx.4': ['atomic', 'up', 'loop'],
    'fx.5': ['atomic', 'down', 'loop'],
    # Leftovers (engine/src/husks.rs LEFTOVER_*): the fire on husks and
    # scorch marks (OpenRA Husk WithIdleOverlay@Burns: fire 1), crater smoke
    # (SmudgeLayer SmokeType: smoke_m, played once), the PRIMARY tag
    # (WithDecoration@primary: pips tag-primary) and the crate pickup
    # animations (crate-effects). Level up uses a file only OpenRA has
    # (levelup.shp): WebRA's art stays.
    'leftovers.0': ['fire', '1', 'loop'],
    'leftovers.1': ['smoke_m', 'idle', 'effect'],
    'leftovers.2': ['pips', 'tag-primary', 'loop'],
    'leftovers.3': None,
    'leftovers.4': ['crate-effects', 'heal', 'effect'],
    'leftovers.5': ['crate-effects', 'hide-map', 'effect'],
    'leftovers.6': ['crate-effects', 'reveal-map', 'effect'],
    'leftovers.7': ['crate-effects', 'invuln', 'effect'],
}

sys.path.insert(0, SRC)
import parse  # noqa: E402 (data/source/parse.py: MiniYaml parser and inheritance)

WEBRA_RULES = os.path.join(ROOT, 'data', 'webra', 'rules.yaml')


def webra_actor_ids():
    """WebRA's own actors (data/webra/rules.yaml, tools/gen_rules.py
    WEBRA_ACTORS): no OpenRA counterpart, so neither OpenRA nor Red Alert
    has art for them. They get no ACTOR_ART and no RENDER_FACTS; WebRA
    always draws them (its pixel art, apps/game/js/art/pixel.js), and the
    art audit lists them as webra-only."""
    if not os.path.exists(WEBRA_RULES):
        return set()
    with open(WEBRA_RULES) as f:
        return {k for k in parse.parse_miniyaml(f.read()) if not k.startswith('^')}

# Sequence fields this tool understands; anything else on a used sequence is an error.
KNOWN_FIELDS = {
    'Filename', 'TilesetFilenames', 'Start', 'Length', 'Stride', 'Facings', 'Tick', 'ZOffset', 'ShadowStart', 'Frames',
    'Reverses', 'Transpose', 'Offset', 'UseClassicFacings', 'InterpolatedFacings', 'ZRamp', 'BlendMode', 'IgnoreWorldTint', 'Scale',
    'Combine',
}
# Fields of one part of a Combine (OpenRA DefaultSpriteSequence.ParseCombineFilenames
# and the sub-fields Combine reads: Offset, FlipX, FlipY, Frames; Scale per part).
COMBINE_FIELDS = {'Filename', 'TilesetFilenames', 'Start', 'Length', 'Frames', 'Offset', 'FlipX', 'FlipY', 'Scale'}


def load_bits():
    with open(os.path.join(SRC, 'bits.txt')) as f:
        return {line.strip().lower() for line in f if line.strip() and not line.startswith('#')}


BITS = load_bits()


def check_bits_decisions():
    """OpenRA's files Red Alert has too are drawn from the player's copy (or
    knowingly left out for another layout); the lists agree with bits.txt."""
    for name, files in [('SAME_LAYOUT', SAME_LAYOUT), ('OTHER_LAYOUT', OTHER_LAYOUT), ('IN_RED_ALERT_TOO', IN_RED_ALERT_TOO),
                        ('NO_ORIGINAL', NO_ORIGINAL), ('ORIGINAL_FILES', set(ORIGINAL_FILES)), ('ORIGINAL_SHORTER', set(ORIGINAL_SHORTER))]:
        for fn in sorted(files - BITS):
            raise SystemExit(f'{name}: {fn} is not one of OpenRA\'s files (data/source/bits.txt)')
    for fn in sorted(IN_RED_ALERT_TOO):
        if fn in NO_ORIGINAL or fn in ORIGINAL_FILES or fn in ORIGINAL_SHORTER:
            raise SystemExit(f'{fn}: Red Alert has this file; draw the original (SAME_LAYOUT), not WebRA art or a stand-in')
        if (fn in SAME_LAYOUT) == (fn in OTHER_LAYOUT):
            raise SystemExit(f'{fn}: Red Alert has this file; list it in SAME_LAYOUT or OTHER_LAYOUT')
    for fn in sorted((SAME_LAYOUT | OTHER_LAYOUT) - IN_RED_ALERT_TOO):
        raise SystemExit(f'{fn}: listed as an original Red Alert file but not in IN_RED_ALERT_TOO')
    for fn in sorted(NO_ORIGINAL & (set(ORIGINAL_FILES) | set(ORIGINAL_SHORTER))):
        raise SystemExit(f'{fn}: both without an original and mapped to one')


def sequence_files(tree, name):
    """The files OpenRA's sequence `name` of an image reads (any tileset, Combine parts too)."""
    defaults = tree.get('Defaults', ['', {}])[1]
    data = tree[name][1]
    out = set()

    def add(fn, ts):
        if fn and fn[0]:
            out.add(fn[0].lower())
        if ts and ts[1]:
            out.update(v.lower() for v, _ in ts[1].values() if v)

    if 'Combine' in data:
        for _k, (_v, sub) in data['Combine'][1].items():
            add(sub.get('Filename'), sub.get('TilesetFilenames'))
    else:
        add(field(data, defaults, 'Filename'), field(data, defaults, 'TilesetFilenames'))
    return out


def original_file(fn, where, strict=True):
    """The file a player's copy has for `fn` (None: there is none). Not
    strict: an OpenRA file nobody decided about has none either (the audit
    facts list sequences WebRA does not use)."""
    if fn not in BITS or fn in SAME_LAYOUT:
        return fn
    if fn in ORIGINAL_FILES:
        return ORIGINAL_FILES[fn]
    if fn in NO_ORIGINAL or not strict:
        return None
    raise SystemExit(f'{where}: {fn} is made by OpenRA (data/source/bits.txt); map it to an original file or list it in NO_ORIGINAL')


def wdist(text):
    """OpenRA WDist ("-1c511", "512", "1c0") in world units."""
    s = text.strip()
    neg = s.startswith('-')
    if neg:
        s = s[1:]
    if 'c' in s:
        cells, rest = s.split('c', 1)
        v = int(cells or 0) * 1024 + int(rest or 0)
    else:
        v = int(s)
    return -v if neg else v


def load_sequences():
    defs = parse.load('sequences', SEQUENCE_FILES)
    return parse.resolve_all(defs)


def field(data, defaults, key):
    if key in data:
        return data[key]
    if key in defaults:
        return defaults[key]
    return None


def normalize(image, name, tree, strict=True):
    """One sequence of an image as compact JSON-friendly fields."""
    defaults = tree.get('Defaults', ['', {}])[1]
    if name not in tree:
        return None
    data = tree[name][1]
    for key in list(data) + list(defaults):
        if key not in KNOWN_FIELDS:
            raise SystemExit(f'{image}.{name}: unsupported sequence field {key}')
    out = {}
    fn = field(data, defaults, 'Filename')
    out['file'] = ((fn or [''])[0] or '').lower()
    if 'Combine' in data:
        # A virtual file: the parts' frames one after the other; the sequence's
        # own Start, Length, Facings and Frames index into it.
        parts = combine_parts(image, name, data['Combine'][1])
        if parts is None:
            return None
        out['parts'] = parts
        out['file'] = parts[0]['file']
    ts = field(data, defaults, 'TilesetFilenames')
    if ts and ts[1]:
        out['tilesets'] = {k: v.lower() for k, (v, _) in ts[1].items() if v}

    def num(key, default):
        v = field(data, defaults, key)
        return int(v[0]) if v and v[0] != '' else default

    out['start'] = num('Start', 0)
    length = field(data, defaults, 'Length')
    if length and length[0] == '*':
        out['length'] = -1
    else:
        out['length'] = num('Length', 1)
    stride = field(data, defaults, 'Stride')
    if stride and stride[0] != '':
        out['stride'] = int(stride[0])
    out['facings'] = num('Facings', 1)
    out['tick'] = num('Tick', 40)
    z = field(data, defaults, 'ZOffset')
    if z and z[0]:
        out['zOffset'] = wdist(z[0])
    shadow = num('ShadowStart', -1)
    if shadow >= 0:
        out['shadowStart'] = shadow
    frames = field(data, defaults, 'Frames')
    if frames and frames[0]:
        out['frames'] = [int(x) for x in frames[0].split(',')]
    for key, flag in [('Reverses', 'reverses'), ('Transpose', 'transpose'), ('UseClassicFacings', 'classic')]:
        v = field(data, defaults, key)
        if v and v[0].lower() == 'true':
            out[flag] = True
    ifc = num('InterpolatedFacings', 0)
    if ifc:
        out['interpolatedFacings'] = ifc
    offset = field(data, defaults, 'Offset')
    if offset and offset[0]:
        parts = [int(float(x)) for x in offset[0].split(',')]
        if parts[:2] != [0, 0]:
            out['offset'] = parts[:2]
    sc = field(data, defaults, 'Scale')
    if sc and sc[0] and float(sc[0]) != 1:
        out['scale'] = float(sc[0])
    if out['facings'] == 0 or abs(out['facings']) & (abs(out['facings']) - 1):
        raise SystemExit(f'{image}.{name}: Facings must be a power of two')
    return to_original(image, name, out, strict)


def combine_parts(image, name, combine):
    """The parts of an OpenRA Combine: file (original files only, see
    `original_file`), the frames it adds (`frames`, or all of the file when
    absent: Length *), offset, flips and scale. None when a part has no
    original file."""
    parts = []
    for key in sorted(combine, key=int):
        sub = combine[key][1]
        for k in sub:
            if k not in COMBINE_FIELDS:
                raise SystemExit(f'{image}.{name}: unsupported Combine field {k}')
        where = f'{image}.{name}.Combine.{key}'
        fn = original_file((sub.get('Filename', [''])[0] or '').lower(), where)
        if fn is None:
            return None
        part = {'file': fn}
        ts = sub.get('TilesetFilenames')
        if ts and ts[1]:
            tilesets = {}
            for tid, (v, _) in ts[1].items():
                o = original_file(v.lower(), where) if v else None
                if v and o is None:
                    return None
                if o and o != fn:
                    tilesets[tid] = o
            if tilesets:
                part['tilesets'] = tilesets
        frames = sub.get('Frames', [''])[0]
        length = sub.get('Length', ['1'])[0]
        if frames:
            part['frames'] = [int(x) for x in frames.split(',')]
        elif length != '*':
            start = int(sub.get('Start', ['0'])[0] or 0)
            part['frames'] = list(range(start, start + int(length or 1)))
        offset = sub.get('Offset', [''])[0]
        if offset:
            xy = [int(float(x)) for x in offset.split(',')][:2]
            if xy != [0, 0]:
                part['offset'] = xy
        for k, flag in [('FlipX', 'flipX'), ('FlipY', 'flipY')]:
            if sub.get(k, [''])[0].lower() == 'true':
                part[flag] = True
        scale = sub.get('Scale', [''])[0]
        if scale and float(scale) != 1:
            part['scale'] = float(scale)
        parts.append(part)
    return parts


def to_original(image, name, out, strict=True):
    """The sequence on the original files (see ORIGINAL_FILES), or None when they cannot draw it."""
    if 'parts' in out:
        return out  # the parts are already original files
    if (image, name) in ORIGINAL_SEQUENCES:
        out.update(ORIGINAL_SEQUENCES[(image, name)])
        out.pop('tilesets', None)
        return out
    if out['file'] in ORIGINAL_SHORTER and 'tilesets' not in out:
        fn, frames = ORIGINAL_SHORTER[out['file']]
        out['file'] = fn
        if out['length'] > 0 and out['start'] < frames:
            out['length'] = min(out['length'], frames - out['start'])
            return out
        return None
    fn = original_file(out['file'], f'{image}.{name}', strict)
    if fn is None:
        return None
    out['file'] = fn
    if 'tilesets' in out:
        tilesets = {}
        for tid, tfn in out['tilesets'].items():
            o = original_file(tfn, f'{image}.{name}', strict)
            if o is None:
                # No original on this tileset (OpenRA drew it, like the ore
                # mine of the desert): no file there, the actor keeps WebRA art.
                tilesets[tid] = ''
                continue
            if o != fn:
                tilesets[tid] = o
        if tilesets:
            out['tilesets'] = tilesets
        else:
            del out['tilesets']
    return out


def actor_images():
    """WebRA actor id -> OpenRA image name (RenderSprites Image or the lowercased id)."""
    out = {}
    for name, tree in parse.rules.items():
        img = None
        for k, (_v, ch) in tree.items():
            if k == 'RenderSprites' or k.startswith('RenderSprites@'):
                img = ch.get('Image', [None])[0] or img
        out[name.upper()] = (img or name).lower()
    return out


def rules_of(aid):
    """The resolved OpenRA rules of an actor id (case-insensitive), or {}."""
    for name, tree in parse.rules.items():
        if name.upper() == aid.upper():
            return tree
    return {}


def is_fake(tree):
    """Whether an actor is a fake structure: its build palette icon is the
    fake-icon sequence (OpenRA fakes.yaml Buildable.Icon)."""
    buildable = trait(tree, 'Buildable') or {}
    return buildable.get('Icon', [''])[0] == 'fake-icon'


def trait(tree, name):
    """The children of a trait (first instance), or None."""
    for k, (_v, ch) in tree.items():
        if k == name or k.startswith(name + '@'):
            return ch
    return None


# The palettes an actor's RenderSprites may name (OpenRA mods/ra/rules/palettes.yaml)
# that the original art draws with (js/content/atlas.js ACTOR_PALETTES):
# "player" (temperat.pal with the team remap, shadow index 4) is the default;
# "effect" is temperat.pal without the remap (walls, crates); "terrain" is
# the theater's own palette with shadow indices 3 and 4 (the ore mine);
# "desert" is desert.pal without the remap (the desert village).
SPRITE_PALETTES = {'player', 'effect', 'terrain', 'desert'}


def sprite_palette(aid, tree):
    """The palette OpenRA draws an actor's sprites with (RenderSprites Palette, default player)."""
    rs = trait(tree, 'RenderSprites') or {}
    pal = rs.get('Palette', ['player'])[0] or 'player'
    if pal not in SPRITE_PALETTES:
        raise SystemExit(f'{aid}: RenderSprites palette {pal} is not one the original art draws with (SPRITE_PALETTES)')
    return pal


# Bridge states (OpenRA BridgeInfo template fields) as ACTOR_ART bridge keys.
BRIDGE_STATES = [('healthy', 'Template'), ('damaged', 'DamagedTemplate'), ('destroyed', 'DestroyedTemplate'),
                 ('destroyed_north', 'DestroyedPlusNorthTemplate'), ('destroyed_south', 'DestroyedPlusSouthTemplate'),
                 ('destroyed_both', 'DestroyedPlusBothTemplate')]


def template_files():
    """Template id -> (image file, [width, height]) per tileset id."""
    out = {}
    for tid, info in TILESETS.items():
        with open(os.path.join(SRC, 'tilesets', info['file'] + '.yaml')) as f:
            root = parse.parse_miniyaml(f.read())
        out[tid] = {}
        for _key, (_v, ch) in root['Templates'][1].items():
            img = ch['Images'][0].split(',')[0].strip().lower()
            out[tid][int(ch['Id'][0])] = (img, [int(x) for x in ch['Size'][0].split(',')])
    return out


def bridge_art(aid, templates):
    """The template files of a bridge's states per tileset (the bridge art is terrain tiles)."""
    b = trait(rules_of(aid), 'Bridge') or {}
    out = {}
    for tid in TILESETS:
        healthy = templates[tid].get(int(b.get('Template', ['0'])[0] or 0))
        if healthy is None:
            continue
        rec = {'size': healthy[1]}
        for state, key in BRIDGE_STATES:
            t = templates[tid].get(int(b.get(key, ['0'])[0] or 0))
            if t is None:
                continue
            rec[state] = t[0]
        # Templates OpenRA made (the desert and small bridges): WebRA art there.
        if any(v in BITS and v not in SAME_LAYOUT for k, v in rec.items() if k != 'size'):
            continue
        out[tid] = rec
    return out


def infantry_body(tree):
    """The infantry body trait the actor stands and walks with (WithInfantryBody,
    or the Spy's WithDisguisingInfantryBody), without @suffix (the parachute
    and the dog's run are other instances)."""
    for name in ('WithInfantryBody', 'WithDisguisingInfantryBody'):
        if name in tree:
            return tree[name][1]
    return {}


def infantry_poses(tree):
    """Pose -> sequence of an infantry body (engine/src/render.rs Pose): its
    StandSequences (stand, stand2), IdleSequences (idle1, idle2), MoveSequence,
    the primary armament's AttackSequences (attack, attack2: OpenRA picks one
    per shot) or else DefaultAttackSequence, and the WithDeathAnimation
    sequences die1..die6 (DeathSequence for all of them without the death
    type suffix) and CrushedSequence."""
    body = infantry_body(tree)
    val = lambda key, default: (body.get(key, [default])[0] or default)
    names = lambda key, default: [x.strip() for x in val(key, default).split(',') if x.strip()]
    stands = names('StandSequences', 'stand')
    idles = names('IdleSequences', '')
    seqs = body.get('AttackSequences', ['', {}])[1]
    attacks = tokens(seqs['primary'][0]) if 'primary' in seqs else []
    if not attacks and val('DefaultAttackSequence', ''):
        attacks = [val('DefaultAttackSequence', '')]
    out = {'idle': stands[0], 'move': val('MoveSequence', 'run')}
    for k, name in enumerate(attacks[:2]):
        out['attack' if k == 0 else 'attack2'] = name
    if len(stands) > 1:
        out['stand2'] = stands[1]
    for k, name in enumerate(idles[:2]):
        out[f'idle{k + 1}'] = name
    death = trait(tree, 'WithDeathAnimation')
    if death is not None:
        prefix = death.get('DeathSequence', ['die'])[0] or 'die'
        if death.get('UseDeathTypeSuffix', ['True'])[0].lower() == 'false':
            # One death for every damage type (the campaign's ants): OpenRA
            # plays DeathSequence itself, whatever the engine's death pose.
            for n in range(1, 7):
                out[f'die{n}'] = prefix
        else:
            for _type, (n, _ch) in death.get('DeathTypes', ['', {}])[1].items():
                out[f'die{n}'] = f'{prefix}{n}'
        crushed = death.get('CrushedSequence', [''])[0]
        if crushed:
            out['crushed'] = crushed
    return out


def tokens(text):
    """A MiniYaml list ("a, b, c") as names."""
    return [t.strip() for t in (text or '').split(',') if t.strip()]


def wvec(text):
    """A MiniYaml WVec ("597,0,213") as [forward, right, up] world units."""
    parts = [int(x) for x in tokens(text)] if text else []
    return (parts + [0, 0, 0])[:3]


def lift_px(up):
    """Screen pixels a WVec height raises a sprite (OpenRA's top-down projection: 1024 units per 24 px)."""
    return round(-up * 24 / 1024, 3)


def overlays_of(tree):
    """WithIdleOverlay traits in key order: (key, sequence, condition, offset)."""
    out = []
    for k, (_v, ch) in sorted(tree.items()):
        if k == 'WithIdleOverlay' or k.startswith('WithIdleOverlay@'):
            out.append((k, ch.get('Sequence', ['idle'])[0], ch.get('RequiresCondition', [''])[0], wvec(ch.get('Offset', [''])[0])))
    return out


# Characters and creatures only the campaign has (tools/gen_missions.py names
# them as a mission actor's `art` key): art key, OpenRA actor, kind. Drawn
# like that OpenRA actor; WebRA's own art is in apps/game/js/art/world.js
# (characters) and apps/game/js/sprites.js (ants, wrecks).
MISSION_ART = [
    ('EINSTEIN', 'EINSTEIN', 'infantry'),
    ('DELPHI', 'DELPHI', 'infantry'),
    ('CHAN', 'CHAN', 'infantry'),
    ('GNRL', 'GNRL', 'infantry'),
    ('ANT', 'WarriorAnt', 'infantry'),
    ('FIREANT', 'FireAnt', 'infantry'),
    ('SCOUTANT', 'ScoutAnt', 'infantry'),
    ('TRAN1HUSK', 'TRAN.Husk1', 'husk'),
    ('TRAN2HUSK', 'TRAN.Husk2', 'husk'),
]


def actor_art(actors, seqs):
    images = actor_images()
    used = {}
    art = {}
    templates = template_files()

    def use(image, name):
        if image not in seqs or name not in seqs[image]:
            return None
        rec = normalize(image, name, seqs[image])
        if rec is None:
            return None
        used.setdefault(image, {})[name] = rec
        return name

    def poses(image, mapping):
        out = {}
        for pose, name in mapping.items():
            got = use(image, name)
            if got:
                out[pose] = got
        return out

    for a in actors:
        aid = a['id']
        kind = a['kind']
        if a.get('bridge'):
            bridge = bridge_art(aid, templates)
            if bridge:
                art[aid] = {'image': aid.lower(), 'bridge': bridge}
            continue
        src = a.get('source', aid)
        image = images.get(src.upper(), src.lower())
        if image not in seqs:
            continue
        tree = rules_of(src)
        entry = {'image': image}
        if kind == 'building':
            wall = a.get('_wall', False)
            level = trait(tree, 'WithResourceLevelSpriteBody')
            if level is not None:
                # OpenRA WithResourceLevelSpriteBody: the frame shows how full the player's storage is.
                seq = level.get('Sequence', ['stages'])[0]
                entry['body'] = poses(image, {'idle': seq, 'damaged': 'damaged-' + seq, 'make': 'make'})
                entry['level'] = True
            else:
                entry['body'] = poses(image, {'idle': 'idle', 'damaged': 'damaged-idle', **({} if wall else {'make': 'make'})})
            if wall:
                entry['wall'] = True
            entry['second'] = poses(image, {'idle': 'turret', 'damaged': 'damaged-turret'}) if a['turret'] else {}
            door = trait(tree, 'WithProductionDoorOverlay')
            if door is not None and not a['turret']:
                seq = door.get('Sequence', ['build-top'])[0]
                second = poses(image, {'idle': seq, 'damaged': 'damaged-' + seq})
                if 'idle' in second:
                    entry['second'] = second
                    entry['overlay'] = 'door'
            # Working animations (the engine's active pose, fx.rs): resupplying
            # (repeating), the Tesla charge, the silo launch and the yard's
            # placement animation (once each).
            for name, key, mode in [
                ('WithResupplyAnimation', 'Sequence', 'loop'),
                ('WithTeslaChargeAnimation', 'ChargeSequence', 'once'),
                ('WithSupportPowerActivationAnimation', 'Sequence', 'once'),
                ('WithBuildingPlacedAnimation', 'Sequence', 'once'),
            ]:
                t = trait(tree, name)
                if t is None:
                    continue
                default = 'build' if name == 'WithBuildingPlacedAnimation' else 'active'
                seq = t.get(key, [default])[0]
                got = poses(image, {'active': seq, 'damaged-active': 'damaged-' + seq})
                if got:
                    entry['body'].update(got)
                    entry['activeMode'] = mode
            recoil = trait(tree, 'WithTurretAttackAnimation')
            if recoil is not None and entry['second']:
                seq = recoil.get('Sequence', [''])[0]
                if seq:
                    # Turret recoil (OpenRA WithTurretAttackAnimation): once per shot.
                    entry['second'].update(poses(image, {'active': seq, 'damaged-active': 'damaged-' + seq}))
            bib = trait(tree, 'WithBuildingBib')
            if bib is not None and bib.get('HasMinibib', ['False'])[0].lower() != 'true':
                got = use(image, bib.get('Sequence', ['bib'])[0])
                if got:
                    entry['bib'] = got
            # The neutral world's structures that die with an animation (the
            # tech buildings: WithDeathAnimation DeathSequence dead, without
            # the damage type suffix): the engine plays it as a death (die1).
            death = trait(tree, 'WithDeathAnimation')
            dead = death.get('DeathSequence', ['die'])[0] if death is not None else None
            if dead and death.get('UseDeathTypeSuffix', ['True'])[0].lower() == 'false' and dead in seqs.get(image, {}) \
                    and normalize(image, dead, seqs[image], strict=False) is not None:
                # (OpenRA drew some itself, the construction yard's: WebRA keeps none there.)
                entry['body'].update(poses(image, {'die1': dead}))
            # An idle overlay over a structure without a turret or door (the
            # burning oil pump V19.Husk: WithIdleOverlay fire-loop).
            spinner = [o for o in overlays_of(tree) if not o[2]]
            if spinner and not entry['second']:
                entry['second'] = poses(image, {'idle': spinner[0][1]})
        elif kind == 'crate':
            # The crate on land (body) and in water (second slot), OpenRA WithCrateBody.
            entry['body'] = poses(image, {'idle': 'land'})
            entry['second'] = poses(image, {'idle': 'water'})
        elif kind == 'husk':
            entry['body'] = poses(image, {'idle': 'idle'})
            entry['second'] = {}
        elif kind == 'infantry':
            entry['body'] = poses(image, infantry_poses(tree))
            # Prone: OpenRA's TakeCover plays its ProneSequencePrefix ("prone-")
            # plus the standing sequence: stands, run and attacks.
            standing = infantry_poses(tree)
            prefix = (trait(tree, 'TakeCover') or {}).get('ProneSequencePrefix', ['prone-'])[0]
            prone = {'idle': standing['idle'], 'move': standing['move'], 'attack': standing.get('attack', 'shoot')}
            for pose in ('stand2', 'attack2'):
                if pose in standing:
                    prone[pose] = standing[pose]
            entry['second'] = poses(image, {pose: prefix + seq for pose, seq in prone.items()})
            for k, (_v, ch) in tree.items():
                cond = ch.get('RequiresCondition', [''])[0]
                if k.startswith('WithInfantryBody') and 'parachute' in cond and not cond.startswith('!'):
                    # Falling paratroopers (WithInfantryBody@PARACHUTE).
                    entry['body'].update(poses(image, {'parachute': tokens(ch.get('StandSequences', ['parachute'])[0])[0]}))
            # Civilians never lie down; their second slot is the panic of
            # ScaredyCat (IRenderInfantrySequenceModifier: PanicSequencePrefix).
            scared = trait(tree, 'ScaredyCat')
            if scared is not None:
                panic = scared.get('PanicSequencePrefix', ['panic-'])[0]
                entry['second'] = poses(image, {'idle': panic + 'stand', 'move': panic + 'run'})
        else:
            mapping = {'idle': 'idle'}
            if a.get('harvester'):
                mapping.update({'harvest': 'harvest', 'dock': 'dock-loop'})
            entry['body'] = poses(image, mapping)
            lead = {}
            dock = trait(tree, 'WithDockingAnimation')
            if dock is not None and 'dock' in entry['body']:
                # OpenRA WithDockingAnimation: the dock sequence once, then the
                # dock loop; leaving plays the dock sequence backwards.
                got = use(image, dock.get('DockSequence', ['dock'])[0])
                if got:
                    lead['dock'] = got
                    entry['body']['active-end'] = got
                    entry['reverseEnd'] = True
            for k, (_v, ch) in tree.items():
                cond = ch.get('RequiresCondition', [''])[0]
                if k.startswith('WithFacingSpriteBody@') and cond == 'reloading':
                    # The V2 launcher without its rocket while it reloads.
                    entry['body'].update(poses(image, {'active': ch.get('Sequence', ['idle'])[0]}))
                    entry['activeMode'] = 'loop'
            craft = trait(tree, 'WithLandingCraftAnimation')
            if craft is not None:
                # OpenRA WithLandingCraftAnimation: open, then unload repeating; close.
                opened = use(image, craft.get('OpenSequence', ['open'])[0])
                unload = use(image, craft.get('UnloadSequence', ['unload'])[0])
                closed = use(image, craft.get('CloseSequence', ['close'])[0])
                if opened and unload:
                    entry['body']['active'] = unload
                    lead['active'] = opened
                    entry['activeMode'] = 'loop'
                if closed:
                    entry['body']['active-end'] = closed
            if lead:
                entry['lead'] = lead
            entry['second'] = poses(image, {'idle': 'turret'}) if a['turret'] else {}
            overlays = overlays_of(tree)
            rotors = [o for o in overlays if o[2] == 'airborne']
            if kind == 'aircraft' and rotors:
                # Helicopter rotors (WithIdleOverlay@ROTOR*): the second slot plays
                # the ground sequence while landed (pose idle) and the airborne one
                # in flight (pose move); a second rotor (the Chinook's rear one)
                # uses the aux poses. Each pair shares its offset; the height is
                # drawn into the frames (`lift`), the forward offset is the
                # engine's (rules.json aircraft.rotors, same order).
                if len(rotors) > 2:
                    raise SystemExit(f'{aid}: more than two rotors')
                second = {}
                lift = {}
                for n, (_k, air_seq, _c, off) in enumerate(rotors):
                    ground = [o for o in overlays if o[2] == '!airborne' and o[3] == off]
                    if len(ground) != 1:
                        raise SystemExit(f'{aid}: rotor {air_seq} has no ground sequence at the same offset')
                    names = ('idle', 'move') if n == 0 else ('aux-idle', 'aux-move')
                    got = poses(image, {names[0]: ground[0][1], names[1]: air_seq})
                    second.update(got)
                    for pose in got:
                        lift[pose] = lift_px(off[2])
                entry['second'] = second
                if any(lift.values()):
                    entry['lift'] = lift
            else:
                spinner = [o for o in overlays if not o[2]]
                if spinner and not entry['second']:
                    # A spinning overlay (WithIdleOverlay@SPINNER: radar dishes,
                    # tesla coils): drawn over the body at its offset.
                    _k, seq, _c, off = spinner[0]
                    second = poses(image, {'idle': seq})
                    if second:
                        entry['second'] = second
                        if off[2]:
                            entry['lift'] = {'idle': lift_px(off[2])}
                        if not a['turret']:
                            # Not turreted: the engine draws it over the body at this forward and side offset.
                            entry['unitOverlay'] = off[:2]
                elif entry['second']:
                    lifts = {wvec(ch.get('Offset', [''])[0])[2] for k, (_v, ch) in tree.items() if k == 'Turreted' or k.startswith('Turreted@')}
                    if len(lifts) > 1:
                        raise SystemExit(f'{aid}: turrets at different heights')
                    up = lifts.pop() if lifts else 0
                    if up:
                        # Turreted.Offset height: the turret sits higher on the body.
                        entry['lift'] = {pose: lift_px(up) for pose in entry['second']}
        bodyless = 'idle' not in entry['body']
        if trait(tree, 'WithMuzzleOverlay') is not None:
            seqs_used = {ch.get('MuzzleSequence', [''])[0] for k, (_v, ch) in tree.items() if (k == 'Armament' or k.startswith('Armament@'))} - {''}
            if len(seqs_used) > 1:
                raise SystemExit(f'{aid}: armaments with different muzzle sequences')
            if seqs_used:
                # The muzzle flash (WithMuzzleOverlay): its own slot (fx.rs), played once per shot.
                got = use(image, seqs_used.pop())
                if got:
                    entry['muzzle'] = got
        if bodyless:
            # No original body (OpenRA's own units, the Black Hawk and the
            # Mobile Flak: WebRA's own pixel art, tools/gen_pixel_art.py): only
            # an original muzzle flash is kept (Red Alert's minigun and gunfire).
            if 'muzzle' in entry:
                art[aid] = {'image': image, 'muzzle': entry['muzzle']}
            continue
        # Fakes (Buildable.Icon fake-icon): Red Alert's own fake cameo where it
        # has one (dome, construction yard, naval yard, sub pen, war factory);
        # OpenRA drew the others itself (NO_ORIGINAL), so those show the real
        # cameo with WebRA's FAKE mark over it (`fakeMark`, js/content/cameos.js).
        # The palette of the body and second slot (RenderSprites Palette), when not the player's.
        pal = sprite_palette(aid, tree)
        if pal != 'player':
            entry['palette'] = pal
        fake = is_fake(tree)
        fake_icon = fake and use(image, 'fake-icon')
        cameo = 'fake-icon' if fake_icon else use(image, 'icon')
        if cameo:
            entry['cameo'] = cameo
            if fake and not fake_icon:
                entry['fakeMark'] = True
        art[aid] = entry
    return art, used


def special_art(seqs, used, explosions):
    """SPECIAL_ART with the sequences checked and recorded (see the table),
    and EXPLOSION_ART: the "explosion" image sequence of every explosion
    of engine/render.json, played once."""
    def check(key, image, names, mode):
        if mode not in ('loop', 'effect', 'lead', 'index'):
            raise SystemExit(f'{key}: unknown mode {mode}')
        names = names if isinstance(names, list) else [names]
        if mode == 'lead' and len(names) != 2:
            raise SystemExit(f'{key}: a lead needs two sequences')
        for name in names:
            if image not in seqs or name not in seqs[image]:
                raise SystemExit(f'{key}: no sequence {image}.{name}')
            rec = normalize(image, name, seqs[image])
            if rec is None:
                raise SystemExit(f'{key}: {image}.{name} has no original file')
            used.setdefault(image, {})[name] = rec
        return {'image': image, 'sequences': names, 'mode': mode}

    out = {}
    for key, spec in SPECIAL_ART.items():
        out[key] = None if spec is None else check(key, *spec)
    boom = {}
    for name in explosions:
        if name in seqs.get('explosion', {}) and normalize('explosion', name, seqs['explosion'], strict=False) is not None:
            boom[name] = check(f'explosion {name}', 'explosion', name, 'effect')
        else:
            boom[name] = None
    return out, boom


# Render traits whose sequences the audit (apps/game/js/content/audit.js)
# checks, and the role each sequence plays. Decorations (selection, pips,
# control groups, tooltips) are the engine's own drawing and are left out.
# Burn overlays of the neutral world's trees by image: their audit roles.
FIRE_ROLES = {'burn-s': 'fire-small', 'burn-m': 'fire-medium', 'burn-l': 'fire-large'}


def render_facts(actors, seqs):
    """Per WebRA actor: [role, image, sequence, has original file] for every
    sequence OpenRA's render traits draw (OpenRA facts, not WebRA's choices)."""
    images = actor_images()
    facts = {}
    for a in actors:
        aid = a['id']
        src = a.get('source', aid)
        image = images.get(src.upper(), src.lower())
        tree = rules_of(src)
        out = []
        seen = set()

        def add(role, img, seq):
            img = img.lower()
            if img not in seqs or seq not in seqs[img] or (role, img, seq) in seen:
                return
            seen.add((role, img, seq))
            out.append([role, img, seq, normalize(img, seq, seqs[img], strict=False) is not None])

        def prefixed(img, prefix):
            return sorted(n for n in seqs.get(img.lower(), {}) if n.startswith(prefix) and n != 'Defaults')

        for k, (_v, ch) in tree.items():
            name = k.split('@')[0]

            def g(key, default):
                return (ch.get(key, [default])[0] or default)

            cond = g('RequiresCondition', '')
            if name in ('WithSpriteBody', 'WithFacingSpriteBody', 'WithWallSpriteBody', 'WithHarvesterSpriteBody'):
                seq = g('Sequence', 'idle')
                role = 'reloading' if 'reloading' in cond and not cond.startswith('!') else 'body'
                add(role, image, seq)
                add(role + '-damaged', image, 'damaged-' + seq)
            elif name == 'WithResourceLevelSpriteBody':
                seq = g('Sequence', 'stages')
                add('level', image, seq)
                add('level-damaged', image, 'damaged-' + seq)
            elif name == 'WithMakeAnimation':
                add('make', image, g('Sequence', 'make'))
            elif name == 'WithBuildingBib':
                if g('HasMinibib', 'False').lower() != 'true':
                    add('bib', image, g('Sequence', 'bib'))
            elif name == 'WithSpriteTurret':
                seq = g('Sequence', 'turret')
                add('turret', image, seq)
                add('turret-damaged', image, 'damaged-' + seq)
            elif name in ('WithInfantryBody', 'WithDisguisingInfantryBody'):
                if 'parachute' in cond and not cond.startswith('!'):
                    for st in tokens(g('StandSequences', 'parachute')):
                        add('parachute-body', image, st)
                    continue
                for st in tokens(g('StandSequences', 'stand')):
                    add('stand', image, st)
                add('run', image, g('MoveSequence', 'run'))
                # The primary armament's AttackSequences (one picked per shot), else DefaultAttackSequence.
                attacks = ch.get('AttackSequences', ['', {}])[1]
                shoots = tokens(attacks['primary'][0]) if 'primary' in attacks else [g('DefaultAttackSequence', 'shoot')]
                # Only an armed actor ever plays them (WithInfantryBody.Attacking:
                # unarmed civilians never shoot).
                if not any(k == 'Armament' or k.startswith('Armament@') for k in tree):
                    shoots = []
                for shoot in shoots:
                    add('shoot', image, shoot)
                for idle in tokens(g('IdleSequences', '')):
                    add('idle-anim', image, idle)
                if trait(tree, 'TakeCover') is not None:
                    prefix = trait(tree, 'TakeCover').get('ProneSequencePrefix', ['prone-'])[0]
                    for st in tokens(g('StandSequences', 'stand')):
                        add('prone-stand', image, prefix + st)
                    add('prone-run', image, prefix + g('MoveSequence', 'run'))
                    for shoot in shoots:
                        add('prone-shoot', image, prefix + shoot)
            elif name == 'WithDeathAnimation':
                for seq in prefixed(image, g('DeathSequence', 'die')):
                    add('death', image, seq)
                if 'CrushedSequence' in ch:
                    add('death', image, g('CrushedSequence', 'die-crushed'))
            elif name == 'WithIdleOverlay':
                role = 'rotor-air' if cond == 'airborne' else 'rotor-ground' if cond == '!airborne' else 'overlay'
                # The fire on husks (^Husk WithIdleOverlay@Burns).
                if k == 'WithIdleOverlay@Burns':
                    role = 'burns'
                add(role, g('Image', image), g('Sequence', 'idle'))
            elif name == 'WithCrateBody':
                add('crate-land', image, g('LandSequence', 'land'))
                add('crate-water', image, g('WaterSequence', 'water'))
            elif name == 'WithProductionDoorOverlay':
                seq = g('Sequence', 'build-top')
                add('door', image, seq)
                add('door-damaged', image, 'damaged-' + seq)
            elif name == 'WithHarvestAnimation':
                add('harvest', image, g('HarvestSequence', 'harvest'))
            elif name == 'WithDockingAnimation':
                add('dock', image, g('DockSequence', 'dock'))
                add('dock-loop', image, g('DockLoopSequence', 'dock-loop'))
            elif name == 'WithMuzzleOverlay':
                for seq in prefixed(image, 'muzzle'):
                    add('muzzle', image, seq)
            elif name == 'WithDamageOverlay':
                img = g('Image', 'smoke_m')
                # Fires that only incendiary hits light (^Tree @SmallBurn,
                # @MediumBurn, @LargeBurn: neutral.rs) are their own roles.
                role = FIRE_ROLES.get(img, 'damage-smoke') if 'Incendiary' in tokens(g('DamageTypes', '')) else 'damage-smoke'
                for key, default in [('StartSequence', 'start'), ('LoopSequence', 'loop'), ('EndSequence', 'end')]:
                    add(role, img, g(key, default))
            elif name in ('WithResupplyAnimation', 'WithSupportPowerActivationAnimation'):
                add('active', image, g('Sequence', 'active'))
                add('active', image, 'damaged-' + g('Sequence', 'active'))
            elif name == 'WithTeslaChargeAnimation':
                add('active', image, g('ChargeSequence', 'active'))
                add('active', image, 'damaged-' + g('ChargeSequence', 'active'))
            elif name == 'WithTurretAttackAnimation':
                add('recoil', image, g('Sequence', 'recoil'))
            elif name == 'WithBuildingPlacedAnimation':
                add('placed', image, g('Sequence', 'build'))
            elif name == 'WithParachute':
                img = g('Image', 'parach')
                add('parachute', img, g('OpeningSequence', 'open'))
                add('parachute', img, g('Sequence', 'idle'))
            elif name == 'WithLandingCraftAnimation':
                add('landing-open', image, g('OpenSequence', 'open'))
                add('landing-unload', image, g('UnloadSequence', 'unload'))
                add('landing-close', image, g('CloseSequence', 'close'))
            elif name == 'SpawnActorOnDeath':
                # Husks: the husk actor's own image (husks.yaml), or
                # OpenRA's "<unit>.destroyed" or "<unit>husk" naming.
                husk = g('Actor', '').lower()
                base = husk.split('.')[0]
                for himg in [images.get(husk.upper()), husk, base + '.destroyed', base + 'husk', base + '1husk']:
                    if himg and himg in seqs and 'idle' in seqs[himg]:
                        add('husk', himg, 'idle')
                        break
            elif name == 'LeavesTrails':
                img = g('Image', '')
                for seq in tokens(g('Sequences', 'idle')):
                    add('trail', img, seq)
        add('icon', image, 'icon')
        facts[aid] = {'image': image, 'parts': out}
        pal = sprite_palette(aid, tree) if tree else 'player'
        if pal != 'player':
            facts[aid]['palette'] = pal
    return facts


def terrain_tables():
    """Templates per tileset by role (TERRAIN_ROLES); OpenRA's own templates (bits.txt) left out."""
    out = {}
    for tid, info in TILESETS.items():
        with open(os.path.join(SRC, 'tilesets', info['file'] + '.yaml')) as f:
            root = parse.parse_miniyaml(f.read())
        roles = TERRAIN_ROLES[tid]
        by_name = {}
        by_category = {'Beach': [], 'Road': []}
        for _key, (_v, ch) in root['Templates'][1].items():
            img = ch['Images'][0].split(',')[0].strip().lower()
            if img in BITS and img not in SAME_LAYOUT:
                continue
            w, h = (int(x) for x in ch['Size'][0].split(','))
            tiles = {int(k): v for k, (v, _ch) in ch.get('Tiles', ['', {}])[1].items()}
            cells = sorted(tiles)
            if not cells:
                continue
            # The cells of the template whose terrain is Road (the road runs there, Clear cells hold its verges).
            road = [c for c in cells if tiles[c] == 'Road']
            tpl = (img, w, h, cells, road)
            by_name.setdefault(img.rsplit('.', 1)[0], tpl)
            for cat in {c.strip() for c in ch.get('Categories', [''])[0].split(',')} & by_category.keys():
                by_category[cat].append(tpl)
        images = []
        index = {}
        templates = []
        for role, names in roles.items():
            if isinstance(names, str):
                chosen = by_category[names]
            else:
                chosen = []
                for n in names:
                    if n not in by_name:
                        raise SystemExit(f'TERRAIN_ROLES {tid} {role}: no template {n} (or it is made by OpenRA)')
                    chosen.append(by_name[n])
            for img, w, h, cells, road in chosen:
                if img not in index:
                    index[img] = len(images)
                    images.append(img)
                templates.append([index[img], w, h, role, cells] + ([road] if role == 'road' else []))
        rot = WATER_ROTATION[tid]
        out[tid] = {'palette': info['palette'], 'rotation': rot, 'images': images, 'templates': templates}
    return out


# What a CreateEffect warhead's ValidTargets mean for where an impact shows
# its explosion (engine/src/fx.rs IMPACT_*): ground, open water, an
# airborne target, a ship or submarine.
IMPACT_BITS = {
    'Ground': 1, 'GroundActor': 1, 'Trees': 1, 'Bridge': 1,
    'Water': 2, 'Underwater': 2,
    'Air': 4, 'AirborneActor': 4,
    'WaterActor': 8, 'Ship': 8, 'Submarine': 8,
}
# Warhead.ValidTargets when a warhead gives none (OpenRA Warhead.cs).
DEFAULT_WARHEAD_TARGETS = 'Ground, Water'


def impact_mask(valid, invalid):
    mask = 0
    for t in tokens(valid or DEFAULT_WARHEAD_TARGETS):
        mask |= IMPACT_BITS.get(t, 0)
    if 'Ship' in tokens(invalid) or 'WaterActor' in tokens(invalid):
        mask &= ~8
    return mask


def render_data(rules):
    """engine/render.json: presentation facts the engine draws with (fx.rs),
    from OpenRA's rules and weapons: per weapon its CreateEffect warheads
    (explosion sequences of the "explosion" image, where they show, delay),
    per actor its muzzle flashes (Armament MuzzleSequence, LocalOffset and
    the turret it sits on) and its damage smoke (WithDamageOverlay)."""
    explosions = []
    weapons = {}
    # Missiles drawn with OpenRA's MISSILE image (the fx.3 special) instead
    # of the DRAGON rocket every other missile flies as.
    missiles = []
    for w in rules['weapons']:
        tree = None
        for name, t in parse.weapons.items():
            if name == w['name']:
                tree = t
        if tree is None:
            raise SystemExit(f"render.json: weapon {w['name']} is not in data/source/weapons")
        proj = tree.get('Projectile')
        if w['projectile'] == 'missile' and proj and proj[1].get('Image', [''])[0].lower() == 'missile':
            missiles.append(w['name'])
        effects = []
        for k, (v, ch) in tree.items():
            if not k.startswith('Warhead') or v != 'CreateEffect':
                continue
            image = ch.get('Image', ['explosion'])[0]
            if image != 'explosion':
                raise SystemExit(f"render.json: {w['name']} {k} uses image {image}")
            names = tokens(ch.get('Explosions', [''])[0])
            if not names:
                continue
            idx = []
            for n in names:
                if n not in explosions:
                    explosions.append(n)
                idx.append(n)
            effects.append({
                'explosions': idx,
                'valid': impact_mask(ch.get('ValidTargets', [''])[0], ch.get('InvalidTargets', [''])[0]),
                'delay': int(ch.get('Delay', ['0'])[0] or 0),
            })
        if effects:
            weapons[w['name']] = effects
    explosions.sort()
    for effects in weapons.values():
        for e in effects:
            e['explosions'] = [explosions.index(n) for n in e['explosions']]
    actors = {}
    for a in rules['actors']:
        tree = rules_of(a['id'])
        entry = {}
        if trait(tree, 'WithMuzzleOverlay') is not None:
            turrets = {}
            for k, (_v, ch) in tree.items():
                if k == 'Turreted' or k.startswith('Turreted@'):
                    turrets[ch.get('Turret', ['primary'])[0]] = wvec(ch.get('Offset', [''])[0])
            muzzles = []
            for k, (_v, ch) in tree.items():
                if not (k == 'Armament' or k.startswith('Armament@')):
                    continue
                seq = ch.get('MuzzleSequence', [''])[0]
                if not seq:
                    continue
                flat = [int(x) for x in tokens(ch.get('LocalOffset', ['0,0,0'])[0])]
                offsets = [flat[i:i + 3] for i in range(0, len(flat), 3)] or [[0, 0, 0]]
                turret = ch.get('Turret', ['primary'])[0]
                muzzles.append({
                    'weapon': ch.get('Weapon', [''])[0],
                    'sequence': seq,
                    'offsets': offsets,
                    'turret': turret in turrets,
                    'turret_offset': turrets.get(turret, [0, 0, 0]),
                })
            if muzzles:
                entry['muzzles'] = muzzles
        smoke = trait(tree, 'WithDamageOverlay')
        if smoke is not None:
            entry['damage_smoke'] = smoke.get('MinimumDamageState', ['Heavy'])[0].lower()
            # WithDamageOverlay.LoopCount: how often the loop plays (a range, chosen per start).
            entry['smoke_loops'] = [int(x) for x in tokens(smoke.get('LoopCount', ['1, 3'])[0])]
        # Working animations the engine reports as the active pose (fx.rs).
        for name, kind in [
            ('WithResupplyAnimation', 'resupply'),
            ('WithTeslaChargeAnimation', 'charge'),
            ('WithSupportPowerActivationAnimation', 'launch'),
            ('WithBuildingPlacedAnimation', 'placed'),
        ]:
            if trait(tree, name) is not None:
                entry['active'] = kind
        if trait(tree, 'WithTurretAttackAnimation') is not None:
            entry['recoil'] = True
        if any(k.startswith('WithFacingSpriteBody@') and ch.get('RequiresCondition', [''])[0] == 'reloading' for k, (_v, ch) in tree.items()):
            entry['reload_body'] = True
        if trait(tree, 'WithLandingCraftAnimation') is not None:
            entry['landing_craft'] = True
        if trait(tree, 'WithDockingAnimation') is not None:
            entry['docking'] = True
        if entry:
            actors[a['id']] = entry
    return {'explosions': explosions, 'weapons': weapons, 'missiles': missiles, 'actors': actors}


def cursor_tables():
    """OpenRA's cursors (data/source/cursors.yaml, mods/ra/cursors.yaml):
    name -> { file, start, length, hotspot: [x, y] } for the cursors whose
    file a player's copy of Red Alert has (mouse.shp; OpenRA's own
    nopower.shp and attackmove.shp are left out: WebRA keeps its cursors
    there). Keys are matched exactly, as OpenRA's CursorSequence does (its
    scroll-tl has a lowercase "y" that OpenRA ignores, and so does this)."""
    with open(os.path.join(SRC, 'cursors.yaml')) as f:
        root = parse.parse_miniyaml(f.read())
    out = {}
    for src, (_pal, seqs) in root['Cursors'][1].items():
        fn = src.lower()
        if fn in BITS and fn not in SAME_LAYOUT:
            continue
        for name, (_v, ch) in seqs.items():
            start = int(ch.get('Start', ['0'])[0] or 0)
            length = ch.get('Length', ['1'])[0]
            if length == '*':
                raise SystemExit(f'cursor {name}: Length * is not supported')
            out[name] = {
                'file': fn,
                'start': start,
                'length': int(length) if 'Length' in ch else 1,
                'hotspot': [int(ch.get('X', ['0'])[0] or 0), int(ch.get('Y', ['0'])[0] or 0)],
            }
    return out


def main():
    check_bits_decisions()
    with open(RULES_JSON) as f:
        rules = json.load(f)
    seqs = load_sequences()
    walls = set()
    for name, tree in parse.rules.items():
        if any(k == 'LineBuild' or k.startswith('LineBuild@') for k in tree) and any(k.startswith('WithWallSpriteBody') for k in tree):
            walls.add(name.upper())
    actors = []
    for a in rules['actors']:
        actors.append({
            'id': a['id'],
            'kind': a['kind'],
            'turret': a.get('turret_turn_speed') is not None,
            'harvester': bool(a.get('unit') and a['unit'].get('harvester')),
            '_wall': a['id'].upper() in walls,
            'bridge': bool(a.get('world', {}).get('bridge')),
        })
    for key, source, kind in MISSION_ART:
        actors.append({'id': key, 'source': source, 'kind': kind, 'turret': False, 'harvester': False, '_wall': False, 'bridge': False})
    render = render_data(rules)
    art, used = actor_art(actors, seqs)
    # Support power icons (SupportPowerInfo.Icon, sequences of the "icon"
    # image): the observer's support power panel (js/content/cameos.js
    # originalPowerIconPixels).
    for a in rules['actors']:
        for power in (a.get('abilities') or {}).get('support_powers') or []:
            name = power.get('icon')
            if not name:
                continue
            rec = normalize('icon', name, seqs.get('icon', {}))
            if rec is None:
                raise SystemExit(f"{a['id']} {power['key']}: no sequence icon.{name}")
            used.setdefault('icon', {})[name] = rec
    specials, explosion_art = special_art(seqs, used, render['explosions'])
    webra = webra_actor_ids()
    facts = render_facts([a for a in actors if a['id'] not in webra], seqs)
    for a in actors:
        if a['id'] in webra:
            if a['id'] in art:
                raise SystemExit(f"{a['id']}: WebRA's own actor (data/webra/rules.yaml) cannot have original art")
            continue
        # An actor OpenRA draws from an original file has original art: one
        # dropped here (no idle pose) would silently keep WebRA's.
        body = [p for p in facts[a['id']]['parts'] if p[0] in ('body', 'stand', 'crate-land')]
        if a['id'] not in art and not a.get('bridge') and any(p[3] for p in body):
            raise SystemExit(f"{a['id']}: OpenRA draws {body[0][1]}.{body[0][2]} from an original file, but ACTOR_ART has no entry")
    # OpenRA's files the tables treat as missing from Red Alert, with the
    # sequences of the actors that use them (the art audit reports any a
    # player's files have: then IN_RED_ALERT_TOO is incomplete).
    openra_made = {fn: set() for fn in BITS - IN_RED_ALERT_TOO}
    for f in facts.values():
        for _role, img, seq, original in f['parts']:
            if not original:
                for fn in sequence_files(seqs[img], seq):
                    if fn in openra_made:
                        openra_made[fn].add(f'{img}.{seq}')

    trees = {}
    for t in TREES:
        if t in seqs and 'idle' in seqs[t]:
            trees[t] = normalize(t, 'idle', seqs[t])
    resources = {'ore': [], 'gems': []}
    res = seqs.get('resources')
    if not res:
        raise SystemExit('misc.yaml has no resources image')
    for name in ['gold01', 'gold02', 'gold03', 'gold04']:
        resources['ore'].append(normalize('resources', name, res))
    for name in ['gem01', 'gem02', 'gem03', 'gem04']:
        if name in res:
            resources['gems'].append(normalize('resources', name, res))
    terrain = terrain_tables()
    smudges = {}
    for kind, image in SMUDGE_IMAGES.items():
        names = [n for n in seqs[image] if n != 'Defaults']
        smudges[kind] = [normalize(image, n, seqs[image]) for n in names]

    cursors = cursor_tables()
    files = {ACTOR_PALETTE}
    files.update(c['file'] for c in cursors.values())
    for info in terrain.values():
        files.add(info['palette'])
        files.update(info['images'])

    def add_seq(rec):
        files.add(rec['file'])
        for tid, fn in rec.get('tilesets', {}).items():
            if tid in TILESETS:
                files.add(fn)
        for part in rec.get('parts', []):
            add_seq(part)

    for image in used.values():
        for rec in image.values():
            add_seq(rec)
    for entry in art.values():
        for rec in entry.get('bridge', {}).values():
            files.update(v for k, v in rec.items() if k != 'size')
    for rec in trees.values():
        add_seq(rec)
    for rec in resources['ore'] + resources['gems']:
        add_seq(rec)
    for rec in [r for v in smudges.values() for r in v]:
        if rec:
            add_seq(rec)
    files.discard('')

    def js(v):
        return json.dumps(v, separators=(',', ':'), sort_keys=True)

    lines = [
        '// GENERATED by tools/gen_content_tables.py, do not edit.',
        f'// Source: OpenRA mods/ra sequences, rules and tilesets at commit {OPENRA_COMMIT}',
        '// (GPL-3.0, copied into data/source) and engine/rules.json. Names only: the',
        "// graphics themselves come from the player's own copy of Red Alert.",
        '',
        f"export const OPENRA_COMMIT = '{OPENRA_COMMIT}';",
        '',
        '/** The palette actors are drawn with on every tileset (OpenRA "player"). */',
        f"export const ACTOR_PALETTE = '{ACTOR_PALETTE}';",
        '',
        '/** Sequences per OpenRA image, only those WebRA uses (content/sequences.js SequenceDef). */',
        'export const SEQUENCES = {',
    ]
    for image in sorted(used):
        lines.append(f'  {json.dumps(image)}: {js(used[image])},')
    lines += [
        '};',
        '',
        '/**',
        ' * Per WebRA actor: OpenRA image, sequence per pose of the body and second',
        ' * slot (aux-idle and aux-move: a second rotor), wall, level (the frame',
        ' * shows the storage level), lift (screen y offset in pixels of the second',
        ' * slot per pose, negative is up), unitOverlay (forward and side offset of an overlay drawn',
        ' * over a unit without a turret), cameo, palette (OpenRA RenderSprites',
        ' * Palette when not "player": effect, terrain or desert; js/content/atlas.js',
        ' * ACTOR_PALETTES).',
        ' */',
        'export const ACTOR_ART = {',
    ]
    for aid in sorted(art):
        lines.append(f'  {json.dumps(aid)}: {js(art[aid])},')
    lines += [
        '};',
        '',
        '/**',
        ' * The engine\'s special sprites with original art (tools/gen_content_tables.py',
        ' * SPECIAL_ART): key (apps/game/js/content/packs.js SPECIALS name, or art',
        ' * module "naval", "planes", "helis", "abilities", "veterancy",',
        ' * "decorations", "fx", "leftovers" and the index in its specials) -> { image,',
        ' * sequences, mode } or null (WebRA art). Modes: loop, effect (the',
        ' * sequences once one after the other, then nothing), lead (the first once,',
        ' * then the second looping), index (the frame the engine names).',
        ' */',
        f'export const SPECIAL_ART = {{',
    ]
    for key in SPECIAL_ART:
        lines.append(f'  {json.dumps(key)}: {js(specials[key])},')
    lines += [
        '};',
        '',
        '/**',
        ' * The explosion names in slot order (engine/render.json `explosions`: the',
        ' * engine draws explosion k with the slot after the muzzle slots plus k).',
        ' */',
        f'export const EXPLOSIONS = {js(render["explosions"])};',
        '',
        '/**',
        ' * Fake structures (OpenRA fakes.yaml: Buildable.Icon fake-icon): their',
        ' * cameos carry a FAKE mark, Red Alert\'s own fake cameo or WebRA\'s mark',
        ' * over the real one (js/art/cameo.js paintFakeMark).',
        ' */',
        f'export const FAKE_ACTORS = {js(sorted(a["id"] for a in rules["actors"] if is_fake(rules_of(a["id"]))))};',
        '',
        '/** Actors with muzzle flashes (engine/render.json `actors[].muzzles`): WebRA draws its own flash for them. */',
        f'export const MUZZLE_ACTORS = {js(sorted(a for a, e in render["actors"].items() if e.get("muzzles")))};',
        '',
        '/**',
        ' * Explosions per name (engine/render.json `explosions`, the explosion slots',
        ' * after the muzzle slots): the OpenRA "explosion" image sequence, played',
        ' * once, or null when Red Alert has no file for it.',
        ' */',
        'export const EXPLOSION_ART = {',
    ]
    for key in sorted(explosion_art):
        lines.append(f'  {json.dumps(key)}: {js(explosion_art[key])},')
    lines += [
        '};',
        '',
        '/**',
        ' * Terrain templates per tileset (tools/gen_content_tables.py TERRAIN_ROLES):',
        ' * [image index, width, height, role, tile indexes the template has] and,',
        ' * for roads, the tile indexes whose terrain is Road (the others are its',
        ' * verges on clear ground). Roles: clear, water, shore, rough, rock,',
        ' * water-rock, road. `rotation` is the first',
        ' * terrain palette index and count that cycle to animate water (OpenRA',
        ' * RotationPaletteEffect).',
        ' */',
        'export const TERRAIN = {',
    ]
    for tid in sorted(terrain):
        info = terrain[tid]
        lines.append(f'  {tid}: {{')
        lines.append(f"    palette: {json.dumps(info['palette'])},")
        lines.append(f"    rotation: {js(info['rotation'])},")
        lines.append(f"    images: {js(info['images'])},")
        lines.append(f"    templates: {js(info['templates'])},")
        lines.append('  },')
    lines += [
        '};',
        '',
        '/**',
        ' * Mouse cursors (OpenRA mods/ra/cursors.yaml) by OpenRA cursor name: file,',
        ' * first frame, frame count and hotspot (relative to the frame centre, as',
        ' * OpenRA CursorSequence X and Y). Drawn with the actor palette, no remap.',
        ' */',
        f'export const CURSOR_ART = {js(cursors)};',
        '',
        '/** Tree images (decorations.yaml) drawn onto WebRA tree cells. */',
        f'export const TREES = {js(trees)};',
        '',
        '/** Ore and gem overlays (misc.yaml resources): one sequence per variant, a frame per density. */',
        f'export const RESOURCES = {js(resources)};',
        '',
        '/** Scorch marks and craters (misc.yaml scorches, craters): a sequence per variant, a frame per depth; null: no original. */',
        f'export const SMUDGES = {js(smudges)};',
        '',
        '/** Every file name the tables refer to: what the installer keeps from the player\'s files. */',
        f'export const GRAPHICS_FILES = {js(sorted(files))};',
        '',
    ]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write('\n'.join(lines))
    print(f'wrote {os.path.relpath(OUT, ROOT)}: {len(art)} actors, {len(used)} images, {len(files)} files')

    facts_lines = [
        '// GENERATED by tools/gen_content_tables.py, do not edit.',
        f'// Source: OpenRA mods/ra rules and sequences at commit {OPENRA_COMMIT}',
        '// (GPL-3.0, copied into data/source) and engine/rules.json. Names only.',
        '//',
        '// What OpenRA draws for every WebRA actor, for the original art audit',
        '// (apps/game/js/content/audit.js): per actor its image and one',
        '// [role, image, sequence, original] row per sequence its render traits',
        '// use; `original` is false when the file is made by OpenRA (bits.txt)',
        '// and a player\'s copy of Red Alert has nothing for it; `palette` is the',
        '// RenderSprites palette when not "player". These are OpenRA\'s',
        '// facts, not WebRA\'s choices (those are content/tables.js ACTOR_ART).',
        '',
        'export const RENDER_FACTS = {',
    ]
    for aid in sorted(facts):
        facts_lines.append(f'  {json.dumps(aid)}: {js(facts[aid])},')
    facts_lines += [
        '};',
        '',
        '/**',
        ' * The campaign\'s characters and wrecks (tools/gen_content_tables.py',
        ' * MISSION_ART): art key -> kind. Mission actors are drawn as them (their',
        ' * `art`), so the audit checks them like the rules actors.',
        ' */',
        f'export const MISSION_ACTORS = {js({key: kind for key, _source, kind in MISSION_ART})};',
        '',
        '/**',
        ' * WebRA\'s own actors (data/webra/rules.yaml): not OpenRA actors, so no',
        ' * RENDER_FACTS. Neither OpenRA nor Red Alert has art for them; WebRA',
        ' * always draws its own (art/pixel.js), the audit lists them as webra-only.',
        ' */',
        f'export const WEBRA_ACTORS = {js(sorted(a["id"] for a in actors if a["id"] in webra))};',
        '',
        '/**',
        ' * OpenRA\'s own files (data/source/bits.txt) the tables treat as missing',
        ' * from Red Alert -> the actor sequences (image.sequence) that use them.',
        ' * Found in a player\'s Red Alert files, one is a wrong decision',
        ' * (tools/gen_content_tables.py IN_RED_ALERT_TOO).',
        ' */',
        f'export const OPENRA_MADE_FILES = {js({fn: sorted(v) for fn, v in openra_made.items()})};',
        '',
    ]
    with open(FACTS_OUT, 'w') as f:
        f.write('\n'.join(facts_lines))
    print(f'wrote {os.path.relpath(FACTS_OUT, ROOT)}: {sum(len(f["parts"]) for f in facts.values())} sequences of {len(facts)} actors')

    with open(RENDER_OUT, 'w') as f:
        json.dump(render, f, indent=1, sort_keys=True)
        f.write('\n')
    print(f'wrote {os.path.relpath(RENDER_OUT, ROOT)}: {len(render["explosions"])} explosions, {len(render["weapons"])} weapons, {len(render["actors"])} actors')


if __name__ == '__main__':
    main()
