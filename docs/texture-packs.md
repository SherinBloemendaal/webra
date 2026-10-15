# Texture packs

A texture pack changes how WebRA looks and sounds on the player's own
device: sprites of units, structures and effects, sidebar cameos, terrain
tiles and sounds. Players install packs in the **Original content** dialog
(main menu, **More**, **Original content**; the **Original content** button on the online and campaign screens; or **Original content** in the game menu); they are kept in
the browser (IndexedDB) and never uploaded.

Packs are **cosmetic only**. The format has no place for rules, maps,
settings or anything the simulation reads, and unknown keys are refused, so
two players with different packs still play the same game (safe in
multiplayer). Nothing in a pack is ever run: no scripts, no HTML, only PNG
images and OGG, WAV or MP3 sounds, decoded by the browser.

Priority, per sprite part, cameo, terrain and sound: **enabled texture packs
(first in the player's list wins) > original Red Alert content > WebRA's own
art and sounds**.

## Built-in pack: 3D minimal

WebRA ships one texture pack itself, **3D minimal**: every actor, cameo and the terrain redrawn in a blocky,
bright, low-poly style (boxes, octagons instead of circles, stepped domes, three flat tones per face, no outlines,
no dither) in the game's own 3/4 camera. The **Graphics** setting has three choices: **2D minimal** (WebRA's flat
art, the default; `webra` in older settings means this), **3D minimal** and **Red Alert original** (the player's own
installed files). With 3D minimal the built-in pack sits **below** the packs the player installed and above
WebRA's flat art; it is read from the game's own files (`apps/game/packs/minimal3d*.webrapack`, one archive per
biome set), nothing is downloaded.

The archives are generated and committed: `python3 tools/gen_minimal3d/generate.py` writes them,
`--check` (CI) fails when they are out of date, `--preview ID ...` draws models enlarged. The generator is
plain Python (`tools/gen_minimal3d/`): `core.py` is the renderer (primitives, flat tones, z-buffer, PNG), one
`models_*.py` file per category declares the actors, `models_terrain.py` the tiles. Its archives are bigger than a
player's pack may be (`BUILTIN_LIMITS` in `content/packs.js`). Its manifest says `"perspective": "classic"` and
`"groundShear": -0.35` (the generator's `GSHEAR`): the game places the turrets, rotors and muzzle flashes on its
sheared hulls with the same shear, so the Cruiser's two turrets and the Chinook's two rotors sit on their mounts in
all 32 facings.

## Format version 1

A pack is a ZIP archive, named `*.webrapack` (or `*.zip`), with
`manifest.json` at its root (or in its only folder) and the files the
manifest names. `.txt` and `.md` files (a license, a readme) may ride along;
any other kind of file makes the pack invalid.

### Example manifest

```json
{
  "format": "webra-pack",
  "formatVersion": 1,
  "name": "Desert Camo Tanks",
  "author": "Jane Doe",
  "version": "1.0.0",
  "license": "CC-BY-4.0",
  "description": "Light and medium tanks in desert camouflage.",
  "sprites": [
    {
      "actor": "1TNK",
      "image": "units/1tnk.png",
      "teamMask": "units/1tnk-team.png",
      "frameSize": [24, 24],
      "facings": 32
    },
    {
      "actor": "1TNK",
      "part": "second",
      "image": "units/1tnk-turret.png",
      "frameSize": [24, 24],
      "facings": 32
    },
    {
      "actor": "E1",
      "pose": "move",
      "image": "infantry/e1-run.png",
      "frameSize": [16, 20],
      "facings": 8,
      "frames": 6,
      "fps": 10
    },
    {
      "actor": "E1",
      "image": "infantry/e1-stand.png",
      "frameSize": [16, 20],
      "facings": 8
    },
    {
      "actor": "PBOX",
      "part": "second",
      "hidden": true
    },
    {
      "special": "missile",
      "image": "effects/missile.png",
      "frameSize": [8, 4]
    }
  ],
  "cameos": {
    "1TNK": "cameos/1tnk.png"
  },
  "terrain": {
    "biomes": ["desert"],
    "tileSize": 24,
    "clear": "terrain/sand.png",
    "rough": "terrain/rubble.png",
    "water": "terrain/water.png",
    "ore": "terrain/ore.png"
  },
  "sounds": {
    "cannon": "sounds/cannon.ogg",
    "tank1": "sounds/tank-shot.ogg",
    "hell226m": "music/hell-march-remix.ogg"
  }
}
```

### Top level

| Key | Required | What |
|-----|----------|------|
| `format` | yes | `"webra-pack"` |
| `formatVersion` | yes | `1` |
| `name`, `author` | yes | 1 to 64 characters, no `<` or `>`; name and author identify the pack (installing again replaces it) |
| `version` | yes | up to 32 characters, for example `1.0.0` |
| `license` | yes | the license the pack is under (an SPDX id or a short text), up to 64 characters |
| `description` | no | up to 500 characters |
| `perspective` | no | `flat` (default): turrets and rotors are placed like WebRA's flat art. `classic`: the actor sprites are pre-rendered in Red Alert's 3/4 camera like the original graphics, so the game places turrets, rotors and muzzle flashes at OpenRA's offsets (the north-south part shortened by sin 40 degrees) and helicopter rotors play their `idle` (on the ground) and `move` (in the air) poses, without WebRA's rotor disc |
| `groundShear` | no | with `classic` only: the art leans sideways, screen x moving this many world pixels per world pixel south (-1 to 1, default 0); the game shears turret, rotor and muzzle offsets the same way, so parts ahead of or behind a unit's centre stay on their mounts. Draw each unit with its centre unsheared |
| `sprites`, `cameos`, `terrain`, `sounds` | at least one | see below |

### Sprites

Each entry replaces one part and pose of an actor, or a special effect:

| Key | What |
|-----|------|
| `actor` | WebRA actor id (`1TNK`, `E1`, `POWR`, ...; the ids of `engine/rules.json`) |
| `special` | instead of `actor`: `bullet`, `small_explosion`, `large_explosion`, `piff`, `rally`, `at_mine`, `ap_mine`, `tesla_bolt`, `missile`, `shell`, `chrono`, `nuke` (`at_mine` and `ap_mine` replace the bodies of the mine actors MINV and MINP: the game draws mines as actors) |
| `part` | `body` (default) or `second`: the turret, or for infantry the prone (lying) pose |
| `pose` | `idle` (default), `move`, `attack`, `damaged` (below half health), `make` (just placed, played once), `harvest`, `dock`; infantry also `stand2` (the second way of standing), `idle1` and `idle2` (idle animations, played once), `die1` to `die6` (deaths by bullets, bullets, small blasts, blasts, fire, electricity) and `crushed` (played once, then gone) |
| `image` | PNG sprite sheet |
| `teamMask` | optional PNG of the same size: pixels with red above 127 take the player's team colour, shaded by the sheet's brightness |
| `frameSize` | `[width, height]` of one frame in pixels, 1 to 512 |
| `facings` | 1, 2, 4, 8, 16, 32 or 64 (default 1); specials have 1 |
| `frames` | animation frames per facing, 1 to 256 (default 1) |
| `fps` | frames per second, 0 to 60 (default 0: the first frame) |
| `offset` | `[x, y]` world pixels from the actor's centre (default `[0, 0]`) |
| `scale` | world pixels per sheet pixel, 0.25 to 4 (default 1: a cell is 24 pixels) |
| `rotate` | `true` lets the game turn a one-facing sprite like WebRA's own art (specials always turn) |
| `hidden` | `true` hides a part (with `actor` and `part`, no image): for example a turret the body already shows |

Sheet layout: **one row per facing, one column per animation frame**, so the
image is `frameSize[0] * frames` wide and `frameSize[1] * facings` high.
Row 0 faces north (up); row `f` is turned `f / facings` of a full turn
**clockwise**. A sprite needs an `idle` pose; the other poses fall back to it.
Projectile specials (`missile`, `tesla_bolt`) are drawn pointing east, like
WebRA's own.

Without a pack part, a part comes from the original content when it is
installed and chosen, otherwise from WebRA's art. When a pack replaces a
structure's body but not its second part, WebRA's animated layer (radar
dish, smoke) still draws on top; hide it with a `hidden` second part.

### Cameos

`"cameos": { "ACTOR": "path.png" }`: the sidebar picture, scaled to fit the
button with its shape kept (64 x 48 pixels like the originals works well).

### Terrain

| Key | What |
|-----|------|
| `biomes` | which maps use the tiles: `temperate`, `snow`, `desert` (default all) |
| `tileSize` | tile size in pixels, 8 to 64 (default 24) |
| `clear`, `water` | required: a row of 1 to 16 square tiles, variants picked per cell |
| `rough`, `rock`, `tree`, `ford` | optional rows; missing ones fall back (rough and tree to clear, rock and ford to rough: a ford is a crossing units wade through, never drawn as open water) |
| `ore`, `gems` | optional overlays: columns are density levels (up to 12 for ore, 4 for gems), rows are variants (up to 4) |

The first enabled pack with terrain for the map's biome draws the whole map.
The map's other terrain types use these rows too: roads are drawn as
`clear`, bridges (the bridge actor draws the deck) and rivers as `water`,
beaches as `rough` and walls as `rock`.

### Sounds

`"sounds": { "key": "path.ogg" }` with OGG, WAV or MP3 files of at most 8 MB
and 10 minutes. A key is a WebRA sound event (`cannon`, `rifle`, `eva_info`,
... the recipes of `apps/game/js/audio/synth.js`) or an original Red Alert
sound name with or without `.aud` (`tank1`, `ackno.v01`, `conscmp1`), music
tracks included (`hell226m`). Pack sounds play even without the original
content, and before it.

## Limits

The archive is read with the hardened ZIP reader of the `.oramap` importer:
at most 64 MiB, 1024 files, 16 MiB per file and 128 MiB unpacked, a
compression ratio of at most 1000:1 for files over 64 KiB, stored or deflate
entries only, CRC-32 checked. Images: at most 4096 pixels a side (checked
from the PNG header before decoding) and 64 million pixels in all; sheets
must be exactly the size the manifest describes. At most 2048 sprites, 512
cameos and 1024 sounds. File names are relative, with forward slashes,
letters, digits, `_`, `-`, `.` and spaces; no `..`, no absolute paths.

## Making a pack

Put `manifest.json` and the files in a folder, then:

```sh
node tools/make-pack.mjs my-pack/ my-pack.webrapack
```

The tool checks the manifest with the game's validator, writes the archive
and reads it back the way the game does, so a pack it accepts installs.
Only publish art and sounds you have the right to share: the `license` field
tells players under which terms they may use the pack.
