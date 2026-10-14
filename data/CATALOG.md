# Red Alert unit and building catalog (OpenRA `ra` mod)

Source: [OpenRA/OpenRA `bleed` mods/ra/rules + weapons](https://github.com/OpenRA/OpenRA/tree/bleed/mods/ra), fetched 2026-10-07, inheritance (`Inherits`, `-Trait` removals) fully resolved.
Per-faction availability is computed by walking the tech tree (`ProvidesPrerequisite` / `Prerequisites`) for every subfaction.

**Units:** HP and damage are OpenRA values / 100 (OpenRA stores them x100; numbers follow current OpenRA multiplayer balance, which differs slightly from the 1996 game). Range and sight are in cells (1 cell = 1024 world units). Speed is world units per tick. Power: + produces, - consumes. Build time in OpenRA is derived from cost unless `BuildDuration` is set.

Hotkeys (`data/source/hotkeys/*.yaml` and `*.ftl`, OpenRA `mods/common/hotkeys`, `mods/ra/hotkeys.yaml` and their `fluent/hotkeys.ftl` descriptions at commit `b6fc03fcfaef1277592bbd4cbc7d44dd85219902`, GPL-3.0; `ra.yaml` and `ra-hotkeys.ftl` are the Red Alert ones): OpenRA's default keys, contexts and descriptions; `tools/gen_hotkeys.py` turns them into `apps/game/js/openra-hotkeys.js`, the defaults of the game's hotkeys.

Sprite sequences (`data/source/sequences/*.yaml`, OpenRA `mods/ra/sequences` at commit `b6fc03fcfaef1277592bbd4cbc7d44dd85219902`, GPL-3.0) describe how OpenRA cuts the original Red Alert sprites into facings and animations; `tools/gen_content_tables.py` turns them, the rules and the tilesets into `apps/game/js/content/tables.js` the audit facts `apps/game/js/content/render-facts.js` and the engine's effect data `engine/render.json` (file names and frame numbers only: the graphics come from the player's own copy of Red Alert). Mouse cursors (`data/source/cursors.yaml`, OpenRA `mods/ra/cursors.yaml` at the same commit, GPL-3.0) give each cursor's frames and hotspot in mouse.shp.

Audio (`data/source/audio/notifications.yaml` and `music.yaml`, OpenRA `mods/ra/audio` at commit `b6fc03fcfaef1277592bbd4cbc7d44dd85219902`, GPL-3.0): the speech and sound notifications with their file names, volumes and interrupt types, and the soundtrack with its titles, volumes and hidden tracks; `tools/gen-audio-catalog.mjs` turns them, the rules in `data/source/rules` (every actor with its inheritance resolved: sound traits, notifications, support powers) and `weapons.json` into `apps/game/js/audio/catalog-data.js` (file names only: the sounds come from the player's own copy of Red Alert).

OpenRA's own files (`data/source/bits.txt`, the names of the files in OpenRA `mods/ra/bits` and `mods/ra/bits/desert` at the same commit): file names only, the files themselves are not copied. OpenRA made and ships them; a player's copy of Red Alert (the freeware CDs, `ra-quickinstall.zip`) does not have them, so the content tables and the audio catalog map each use to an original file or leave it out (WebRA's own art or sound stays). A few are OpenRA's copies or touch-ups of Red Alert files of the same name (Einstein, Chan, the crate heal animation, the small napalm, snow smudges, ...): `IN_RED_ALERT_TOO` in `tools/gen_content_tables.py` lists them, and those are drawn from the player's own file; `node tools/art-audit.mjs` reports any other one it finds in a player's files. WebRA does not bundle them either, although they sit in OpenRA's GPL-3.0 repository: OpenRA's licence covers the repository without a per-file record of where its art came from, and several of these files are edits of Westwood's art or voice recordings, which OpenRA cannot relicense. The commit history says so for some: `bctrinit.aud` ("Battle control online", the StartGame line) was mixed together from Red Alert's announcer for OpenRA in 2013 (commit 0880c1241d); `mh60.shp` and its cameo `mh60icon.shp` (the Black Hawk, MH60) are a 2019 reskin of the Hind sprite (37325dbfc7) with `yrotorlg.shp` as its rotor; `ftrkicon.shp` (the Mobile Flak's cameo) was replaced in 2015 "with non-copyrighted art" (the earlier one was not), and `ftrk.shp` itself was added in 2010 as a new sprite (b8ed9d7da5) without a record of its source. Without a clear source and licence per file, WebRA treats them like Red Alert's own and never ships them. Two OpenRA actors, the Mobile Flak (FTRK) and the Black Hawk (MH60), exist only with this art: OpenRA builds neither from Red Alert's files, so with or without the original graphics both are drawn with WebRA's own pixel art in Red Alert's style (below), cameo included (the sidebar labels it, Red Alert's cameos carry their name in the picture); the content tables leave OpenRA's art out (`NO_ORIGINAL` in `tools/gen_content_tables.py`), also when a player has it, and keep only their muzzle flashes, which are Red Alert's (`minigun.shp`; `gunfire.shp` for OpenRA's `gunfire2.shp`). Their sounds are Red Alert's (their weapons' reports and impacts, the vehicle and generic voices). The OpenRA-made sounds (`bctrinit`, `unitsto`, `enmydet`, the thief's `scandy`, `sclean1`, `ssteal1`, the spy's `silppk`) play when the player drops them from their own OpenRA install (the installer keeps every file name the catalog uses); otherwise, with original sounds in use, their cues stay silent and the announcer shows the line as text (js/audio/catalog.js `OPENRA_MADE`).

Decorations and cameos OpenRA drew itself keep WebRA's own art, also with the original graphics: the repair wrench (`allyrepair.shp`, drawn in each repairing player's colour in turn; Red Alert's `select.shp` wrench has no team colours, so it is not used for it) and the fake structures' cameos OpenRA made (`ateficon.shp`, `fapwicon.shp`, `fixficon.shp`, `fpwricon.shp`, `mslficon.shp`, `pdoficon.shp`, `tenficon.shp`): those fakes show the real structure's original cameo with WebRA's FAKE mark across it (`fakeMark` in the content tables), the other fakes Red Alert's own fake cameos (`domficon.shp`, `facficon.shp`, `syrficon.shp`, `speficon.shp`, `weaficon.shp`). The atom bomb in flight is Red Alert's (`atomicup.shp` rising, `atomicdn.shp` falling: OpenRA's `atomic` image), with WebRA's own missile otherwise. How long a structure is being built (rules `building.make_ticks`, the `build-incomplete` time of OpenRA's WithMakeAnimation) is the frame count of its make sequence, which OpenRA reads from the file (`Length: *`): `tools/make-frames.mjs` read the counts once from Red Alert's `conquer.mix`, `temperat.mix` and `snow.mix` (and OpenRA's own `mods/ra/bits` files that override them); only those numbers are in the repository (`MAKE_FRAMES` in `tools/gen_rules.py`, with the source of each).

WebRA's own pixel art (`tools/gen_pixel_art.py`, which writes `apps/game/js/art/pixel-data.js`; drawn by `apps/game/js/art/pixel.js`): where Red Alert has no art and OpenRA drew its own, WebRA may draw its own 8-bit frames in Red Alert's style instead of its vector art, with or without the original graphics installed. The oil derrick (OILB, OpenRA's `oilb.shp`): a 48 x 48 frame on its 2x2 footprint, idle and damaged (the sequences OpenRA's OILB draws), with a cast shadow and the owner's colour on its storage tank. The Black Hawk (MH60, OpenRA's `mh60.shp`, `yrotorlg.shp` and `mh60icon.shp`): 32 body facings (also its falling husk), the rotor in 8 ground and 4 blurred airborne frames, and a 64 x 48 cameo, about the Longbow's and the Hind's size. The Mobile Flak (FTRK, OpenRA's `ftrk.shp` and `ftrkicon.shp`): 32 body facings with a cast shadow, 32 turret facings (a twin 23 mm gun drawn at the height of OpenRA's Turreted offset, placed by the engine at its forward part) and a cameo, about the supply truck's and the APC's size. The units are simple 3D models in the generator (prisms cut from side, front and top views, ellipsoids, cylinders), ray cast facing by facing with one light from the top left, the way Westwood rendered its units, so every facing is drawn and none is mirrored. The generator paints every pixel in code, on WebRA's own palette that follows Red Alert's index conventions (0 transparent, 4 shadow, 80 to 95 the owner's colour); nothing is copied, traced or recoloured from Westwood's or OpenRA's files. The art audit lists these rows as `webra-only` with a note naming WebRA's pixel art.

Missions (`data/source/missions`: `missions.yaml`, the campaign rules `rules/campaign-rules.yaml`, `campaign-tooltips.yaml` and `coop-missions-rules.yaml` with the `misc.yaml` and `husks.yaml` they build on, the shared scripts `scripts/campaign.lua` and `utils.lua`, the Fluent strings `fluent/lua.ftl` and `campaign.ftl`, and every mission map folder under `maps/` with its `map.yaml`, `map.bin`, Lua scripts, map rules, weapons, sequences and `map.ftl`; OpenRA `mods/ra` at commit `b6fc03fcfaef1277592bbd4cbc7d44dd85219902`, GPL-3.0, Copyright the OpenRA Developers; the maps' authors are named in each `map.yaml`): map previews, art, sounds and videos are left out. `tools/gen_missions.py` turns them into `apps/game/missions/*.json` and `index.json`, which the engine runs with its Lua interpreter (docs/contracts.md section 9).

Full trait-level data for every actor (every property OpenRA defines) is in `actors.json`; every weapon with projectile and warheads is in `weapons.json`.

## Buildings (17)

| ID | Name | Side | Cost | HP | Armor | Power | Size | Tech | Requires | Weapons |
|---|---|---|---|---|---|---|---|---|---|---|
| POWR | Power Plant | Both | 300 | 400 | Wood | 100 | 2x3 | infonly |  |  |
| TENT | Allied Barracks | Allies | 500 | 600 | Wood | -20 | 2x3 | infonly | anypower |  |
| BARR | Soviet Barracks | Soviet | 500 | 600 | Wood | -20 | 2x3 | infonly | anypower |  |
| SYRD | Naval Yard | Allies | 1000 | 1000 | Wood | -20 | 3x3 | low | anypower |  |
| SPEN | Sub Pen | Soviet | 800 | 1000 | Wood | -20 | 3x3 | low | anypower |  |
| PROC | Ore Refinery | Both | 1400 | 900 | Wood | -30 | 3x4 | infonly | anypower |  |
| WEAP | War Factory | Both | 2000 | 1500 | Wood | -30 | 3x3 | low | proc |  |
| DOME | Radar Dome | Both | 1500 | 1000 | Wood | -40 | 2x3 | medium | proc |  |
| FIX | Service Depot | Both | 1200 | 800 | Wood | -30 | 3x3 | medium | weap |  |
| APWR | Advanced Power Plant | Both | 500 | 700 | Wood | 200 | 3x3 | medium | dome |  |
| HPAD | Helipad | Allies | 500 | 800 | Wood | -10 | 2x3 | medium | dome |  |
| AFLD | Airfield | Soviet, not Ukraine | 500 | 1000 | Wood | -20 | 3x2 | medium | dome |  |
| AFLD.Ukraine | Airfield | Soviet: Ukraine only | 500 | 1000 | Wood | -20 | 3x2 | medium | dome |  |
| ATEK | Allied Tech Center | Allies | 1500 | 600 | Wood | -200 | 2x3 | high | weap, dome |  |
| STEK | Soviet Tech Center | Soviet | 1500 | 800 | Wood | -100 | 3x3 | high | weap, dome |  |
| KENN | Kennel | Soviet | 200 | 300 | Wood | -10 | 1x1 | infonly | anypower |  |
| FACT | Construction Yard | Both | 2000 | 1500 | Wood |  | 3x4 |  | ~disabled |  |

## Defenses and superweapons (15)

| ID | Name | Side | Cost | HP | Armor | Power | Size | Tech | Requires | Weapons |
|---|---|---|---|---|---|---|---|---|---|---|
| SBAG | Sandbag Wall | Allies | 30 | 150 | Wood |  | 1x1 | low | fact |  |
| FENC | Wire Fence | Soviet | 30 | 150 | Wood |  | 1x1 | low | fact |  |
| BRIK | Concrete Wall | Both | 200 | 400 | Concrete |  | 1x1 | medium | fact |  |
| SILO | Silo | Both | 150 | 300 | Wood | -10 | 1x1 | infonly | proc |  |
| PBOX | Pillbox | Allies | 600 | 400 | Heavy | -20 | 1x1 | low | tent | garrisoned by E1 |
| HBOX | Camo Pillbox | Allies | 750 | 400 | Heavy | -20 | 1x1 | medium | tent | garrisoned by E1 |
| FTUR | Flame Tower | Soviet | 600 | 400 | Heavy | -20 | 1x1 | low | barr | FireballLauncher |
| GUN | Turret | Allies | 800 | 400 | Heavy | -40 | 1x1 | medium | tent | TurretGun |
| TSLA | Tesla Coil | Soviet | 1200 | 400 | Heavy | -80 | 1x1 | medium | weap | TeslaZap |
| AGUN | AA Gun | Allies | 800 | 400 | Heavy | -50 | 1x1 | medium | dome | ZSU-23 |
| SAM | SAM Site | Soviet | 700 | 400 | Heavy | -40 | 2x1 | medium | dome | Nike |
| GAP | Gap Generator | Allies | 800 | 500 | Heavy | -60 | 1x1 | high | atek |  |
| PDOX | Chronosphere | Allies | 1500 | 1000 | Wood | -200 | 2x2 | unrestricted | atek |  |
| IRON | Iron Curtain | Soviet | 2000 | 1000 | Wood | -200 | 2x2 | unrestricted | stek |  |
| MSLO | Missile Silo | Both | 2500 | 1000 | Wood | -150 | 2x1 | unrestricted | techcenter |  |

## Infantry (13)

| ID | Name | Side | Cost | HP | Armor | Speed | Sight | Tech | Requires | Weapons | Cargo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 | Rifle Infantry | Both | 100 | 50 | None | 54 | 4 | infonly | ~barracks | M1Carbine, Vulcan |  |
| E3 | Rocket Soldier | Both | 300 | 45 | None | 54 | 4 | infonly | ~barracks | RedEye, Dragon |  |
| E2 | Grenadier | Soviet | 150 | 50 | None | 68 | 4 | infonly | ~barr | Grenade |  |
| MEDI | Medic | Allies | 200 | 60 | None | 49 | 3 | infonly | ~tent | Heal |  |
| DOG | Attack Dog | Soviet | 200 | 18 | None | 100 | 5.5 | infonly | ~kenn | DogJaw |  |
| E6 | Engineer | Both | 400 | 25 | None | 54 | 4 | infonly | ~barracks |  |  |
| E4 | Flame Infantry | Soviet | 300 | 40 | None | 54 | 4 | low | ~barr, ftur | Flamer |  |
| SPY | Spy | Allies, not England | 500 | 25 | None | 54 | 5 | medium | dome, ~tent | SilencedPPK |  |
| SPY.England | British Spy | Allies: England only | 250 | 25 | None | 54 | 5 | medium | dome, ~tent | SilencedPPK |  |
| MECH | Mechanic | Allies | 500 | 80 | None | 49 | 3 | medium | ~tent, fix | Repair |  |
| THF | Thief | Soviet | 500 | 80 | None | 72 | 5 | medium | ~barr, dome |  |  |
| E7 | Tanya | Allies | 1800 | 100 | None | 68 | 6 | high | ~tent, atek | Colt45 |  |
| SHOK | Shock Trooper | Soviet: Russia only | 350 | 50 | None | 54 | 5 | high | ~barr, stek, tsla | PortaTesla |  |

## Vehicles (20)

| ID | Name | Side | Cost | HP | Armor | Speed | Sight | Tech | Requires | Weapons | Cargo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| HARV | Ore Truck | Both | 1100 | 600 | Heavy | 72 | 4 | infonly | proc |  |  |
| 1TNK | Light Tank | Allies | 700 | 230 | Heavy | 113 | 5 | low |  | 25mm |  |
| APC | Armored Personnel Carrier | Soviet | 850 | 350 | Heavy | 128 | 5 | low |  | M60mg | 5 |
| JEEP | Ranger | Allies | 500 | 150 | Light | 164 | 7 | low |  | M60mg | 1 |
| FTRK | Mobile Flak | Soviet | 600 | 150 | Light | 113 | 6 | low |  | FLAK-23-AA, FLAK-23-AG |  |
| MCV | Mobile Construction Vehicle | Both | 2000 | 600 | Light | 60 | 4 | medium | fix |  |  |
| 2TNK | Medium Tank | Allies | 850 | 460 | Heavy | 72 | 6 | medium | fix | 90mm |  |
| 3TNK | Heavy Tank | Soviet | 1150 | 600 | Heavy | 64 | 6 | medium | fix | 105mm |  |
| V2RL | V2 Rocket Launcher | Soviet | 900 | 200 | Light | 72 | 5 | medium | dome | SCUD |  |
| ARTY | Artillery | Allies | 850 | 100 | Light | 72 | 5 | medium | dome | 155mm |  |
| MNLY | Minelayer | Both | 800 | 300 | Heavy | 113 | 5 | medium | fix |  |  |
| 4TNK | Mammoth Tank | Soviet | 2000 | 900 | Heavy | 43 | 6 | high | fix, stek | 120mm, MammothTusk |  |
| MRJ | Mobile Radar Jammer | Allies | 1000 | 220 | Heavy | 68 | 7 | high | atek |  |  |
| MGG | Mobile Gap Generator | Allies: England only | 1000 | 220 | Heavy | 72 | 6 | high | atek |  |  |
| TTNK | Tesla Tank | Soviet: Russia only | 1350 | 400 | Light | 92 | 7 | high | tsla, stek | TTankZap |  |
| DTRK | Demolition Truck | Soviet: Ukraine only | 2500 | 28 | Light | 67 | 4 | high | stek | DemoTruckTargeting |  |
| CTNK | Chrono Tank | Allies: Germany only | 1350 | 400 | Light | 86 | 6 | high | atek | APTusk |  |
| STNK | Phase Transport | Allies: France only | 1000 | 350 | Light | 128 | 7 | high | atek | APTusk.stnk | 5 |
| TRUK | Supply Truck | Both | 500 | 110 | Light | 113 | 4 | low |  |  |  |
| QTNK | MAD Tank | Soviet | 2000 | 900 | Heavy | 46 | 6 | high | fix, stek |  |  |

## Aircraft (5)

| ID | Name | Side | Cost | HP | Armor | Speed | Sight | Tech | Requires | Weapons | Cargo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| TRAN | Chinook | Allies | 900 | 140 | Light | 128 | 8 | medium | ~hpad |  | 8 |
| MH60 | Black Hawk | Allies | 1500 | 100 | Light | 112 | 10 | medium | ~hpad | ChainGun |  |
| YAK | Yak Attack Plane | Soviet | 1350 | 60 | Light | 178 | 11 | medium | ~afld | ChainGun.Yak |  |
| HELI | Longbow | Allies | 2000 | 120 | Light | 149 | 12 | high | ~hpad, atek | HellfireAA, HellfireAG |  |
| MIG | MiG Attack Plane | Soviet | 2000 | 80 | Light | 223 | 13 | high | ~afld, stek | Maverick |  |

## Ships (6)

| ID | Name | Side | Cost | HP | Armor | Speed | Sight | Tech | Requires | Weapons | Cargo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LST | Transport | Both | 500 | 400 | Heavy | 115 | 6 | low |  |  | 5 |
| PT | Gunboat | Allies | 500 | 200 | Heavy | 142 | 8 | low | ~syrd | 2Inch, DepthCharge |  |
| SS | Submarine | Soviet | 950 | 250 | Light | 78 | 8 | low | ~spen | TorpTube |  |
| DD | Destroyer | Allies | 1000 | 400 | Heavy | 92 | 5 | medium | ~syrd, dome | Stinger, DepthCharge, StingerAA |  |
| CA | Cruiser | Allies | 2400 | 800 | Heavy | 44 | 7 | high | ~syrd, atek | 8Inch |  |
| MSUB | Missile Submarine | Soviet | 2000 | 400 | Light | 44 | 8 | high | ~spen, stek | SubMissile, SubMissileAA |  |

## Support powers

| Building | Power | Recharge (s) | Extra requirement |
|---|---|---|---|
| Airfield (AFLD) | Spy Plane | 150 | aircraft.soviet |
| Airfield (AFLD) | Paratroopers | 300 | aircraft.soviet |
| Airfield (AFLD) | Parabombs | 300 | aircraft.ukraine |
| Allied Tech Center (ATEK) | GPS Satellite | 480 |  |
| Chronosphere (PDOX) | Chronoshift | 120 | !pdox.germany |
| Chronosphere (PDOX) | Advanced Chronoshift | 120 | pdox.germany |
| Iron Curtain (IRON) | Invulnerability | 120 |  |
| Missile Silo (MSLO) | Atom Bomb | 540 |  |

Recharge assumes 25 ticks per second (OpenRA "normal" speed).

## France decoy buildings (11)

Fake Power Plant (FPWR, $30), Fake Allied Barracks (TENF, $50), Fake Naval Yard (SYRF, $100), Fake War Factory (WEAF, $200), Fake Radar Dome (DOMF, $180), Fake Service Depot (FIXF, $120), Fake Advanced Power Plant (FAPW, $50), Fake Allied Tech Center (ATEF, $150), Fake Chronosphere (PDOF, $150), Fake Missile Silo (MSLF, $250), Fake Construction Yard (FACF, $200)

## Defined but not buildable in skirmish (7)

Zombie (Zombie), Giant Ant (Ant), Fire Ant (FireAnt), Scout Ant (ScoutAnt), Warrior Ant (WarriorAnt), Hind (HIND), Fake Sub Pen (SPEF). Ants/zombies are campaign/mission-only; the Hind is disabled in multiplayer balance.

## WebRA additions (1)

Actors with no OpenRA counterpart, defined in `data/webra/rules.yaml` (OpenRA MiniYaml resolved against the OpenRA templates above, `WEBRA_ACTORS` in `tools/gen_rules.py`); they are not part of OpenRA's catalog and are listed here by hand.

| ID | Name | Side | Cost | HP | Armor | Power | Size | Tech | Requires | Weapons | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LROD | Lightning Rod | Both | 300 | 300 | Heavy |  | 1x1 | low | anypower (outside missions: `~global-skirmish`) |  | Inherits `^Building` (sellable, repairable, capturable by engineers). WebRA trait `LightningRod` (Range 6c0): thunderstorm lightning that would land within range is grounded on it, and power plants within range are never picked as targets (`engine/src/lightning.rs`, docs/contracts.md "Biomes and weather"). `WithRangeCircle` Type LightningRod, 6c0, shown when selected and while placing. Needs no power. Build time 7.2 s. |

## Weapons used by buildable actors (48)

Damage is per warhead hit (HP / 100 scale as above). Versus = % damage against each armor type (unlisted = 100%).

| Weapon | Damage | Range | Reload (ticks) | Burst | Projectile | Spread | Versus |
|---|---|---|---|---|---|---|---|
| 105mm | 40 | 4.75 | 70 | 2 | Bullet | 0.12 | None:30 Wood:75 Light:75 Concrete:50 Heavy:115 |
| 120mm | 60 | 4.75 | 90 | 2 | Bullet | 0.12 | None:30 Wood:75 Light:75 Concrete:50 Heavy:115 |
| 155mm | 230 | 12 | 85 | 1 | Bullet | 0.42 | None:60 Wood:40 Light:60 Concrete:50 Heavy:25 |
| 25mm | 25 | 4.75 | 21 | 1 | Bullet | 0.12 | None:32 Wood:52 Light:116 Concrete:32 Heavy:48 |
| 2Inch | 25 | 5.5 | 60 | 1 | Bullet | 0.25 | None:28 Wood:72 Light:72 Concrete:48 |
| 8Inch | 25 | 20 | 250 | 2 | Bullet | 0.21 | None:60 Wood:35 Light:60 Concrete:100 Heavy:25 |
| 90mm | 40 | 4.75 | 50 | 1 | Bullet | 0.12 | None:30 Wood:75 Light:75 Concrete:50 Heavy:115 |
| AntFireball | 40 | 4 | 50 | 2 | Bullet | 0.21 | None:80 Wood:85 Tree:50 Light:45 Heavy:20 Concrete:15 |
| APTusk | 50 | 6 | 60 | 2 | Missile | 0.12 | None:10 Wood:74 Light:34 Heavy:100 Concrete:50 |
| APTusk.stnk | 50 | 6 | 100 | 1 | Missile | 0.12 | None:10 Wood:74 Light:34 Heavy:100 Concrete:50 |
| ChainGun | 25 | 5 | 10 | 2 | InstantHit | 0.12 | None:144 Wood:60 Light:72 Heavy:28 Concrete:28 |
| ChainGun.Yak | 40 | 5 | 3 | 2 | InstantHit | 0.12 | None:100 Wood:50 Light:60 Heavy:25 Concrete:25 |
| Claw | 30 | 1.5 | 30 | 1 | Bullet | 0.21 | None:97 Wood:10 Light:30 Heavy:10 Concrete:10 |
| Colt45 | 100 | 7 | 7 | 1 | InstantHit | 0.04 |  |
| DemoTruckTargeting |  | 2 |  | 1 | InstantHit |  |  |
| DepthCharge | 60 | 5 | 60 | 1 | Bullet | 0.12 | None:90 Wood:40 Light:100 Concrete:50 Heavy:25 |
| DogJaw | 1000 | 3 | 10 | 1 | InstantHit |  |  |
| Dragon | 50 | 5 | 50 | 1 | Missile | 0.12 | None:10 Wood:74 Light:34 Heavy:100 Concrete:50 |
| FireballLauncher | 150 | 5 | 70 | 2 | Bullet | 0.21 | None:90 Wood:50 Tree:50 Light:50 Heavy:25 Concrete:20 |
| FLAK-23-AA | 12 | 8 | 10 | 1 | InstantHit | 0.21 |  |
| FLAK-23-AG | 20 | 6 | 10 | 1 | InstantHit | 0.21 | None:40 Wood:10 Light:60 Heavy:10 Concrete:20 |
| Flamer | 10 | 5 | 50 | 15 | Bullet | 0.33 | None:70 Wood:80 Tree:80 Light:40 Heavy:20 Concrete:10 |
| Grenade | 60 | 4 | 60 | 1 | Bullet | 0.25 | None:60 Wood:100 Light:25 Concrete:100 Heavy:25 |
| Heal | -50 | 4 | 80 | 1 | Bullet | 0.21 |  |
| HellfireAA | 30 | 4 | 30 | 2 | Missile | 0.12 | None:10 Wood:74 Light:100 Heavy:100 Concrete:50 |
| HellfireAG | 60 | 5 | 34 | 2 | Missile | 0.12 | None:30 Wood:90 Light:90 Heavy:100 Concrete:100 |
| M1Carbine | 10 | 5 | 20 | 1 | InstantHit | 0.12 | None:150 Wood:30 Light:40 Heavy:10 Concrete:10 |
| M60mg | 10 | 4 | 30 | 5 | InstantHit | 0.12 | None:150 Wood:10 Light:30 Heavy:10 Concrete:10 |
| MammothTusk | 50 | 6.5 | 60 | 2 | Missile | 0.25 | None:100 Wood:74 Light:60 Heavy:24 Concrete:50 |
| Mandible | 60 | 1.5 | 10 | 2 | Bullet | 0.21 | None:90 Wood:10 Light:30 Heavy:10 Concrete:10 |
| MandibleHeavy | 100 | 1.5 | 15 | 2 | Bullet | 0.21 | None:100 Wood:10 Light:90 Heavy:35 Concrete:20 |
| Maverick | 70 | 9 | 50 | 2 | Missile | 0.12 | None:30 Wood:90 Light:90 Heavy:115 Concrete:100 |
| Nike | 45 | 7.5 | 15 | 1 | Missile | 0.12 | None:10 Wood:74 Light:100 Heavy:100 Concrete:50 |
| PortaTesla | 45 | 6 | 70 | 1 | TeslaZap | 0.04 | None:1000 Wood:73 Heavy:60 |
| RedEye | 24 | 7.5 | 50 | 1 | Missile | 0.12 | None:10 Wood:74 Light:100 Heavy:100 Concrete:50 |
| Repair | -20 | 4 | 80 | 1 | Bullet | 0.21 |  |
| SCUD | 45 | 10 | 215 | 1 | Bullet | 0.33 | None:90 Wood:75 Light:70 Heavy:40 Concrete:100 Tree:75 |
| SilencedPPK | 150 | 2.5 | 80 | 1 | InstantHit | 0.12 |  |
| Stinger | 25 | 7.5 | 60 | 2 | Missile | 0.12 | None:36 Wood:88 Light:66 Heavy:120 Concrete:60 |
| StingerAA | 16 | 7.5 | 60 | 2 | Missile | 0.12 | None:36 Wood:88 Light:100 Heavy:120 Concrete:60 |
| SubMissile | 25 | 20 | 300 | 2 | Bullet | 0.42 | None:80 Wood:50 Light:48 Heavy:30 Concrete:100 |
| SubMissileAA | 4 | 8 | 300 | 2 | Missile | 0.42 | None:80 Wood:50 Light:100 Heavy:30 Concrete:100 |
| TeslaZap | 100 | 7 | 3 | 1 | TeslaZap | 0.04 | None:1000 Wood:60 |
| TorpTube | 180 | 9 | 100 | 2 | Missile | 0.42 | Wood:75 Light:75 Heavy:100 Concrete:500 |
| TTankZap | 100 | 7 | 120 | 1 | TeslaZap | 0.04 | None:1000 |
| TurretGun | 60 | 6.5 | 30 | 1 | Bullet | 0.12 | None:20 Wood:50 Light:75 Concrete:50 |
| Vulcan | 10 | 6 | 35 | 1 | InstantHit | 0.12 | None:200 Wood:50 Light:50 Heavy:20 Concrete:20 |
| ZSU-23 | 9 | 10 | 6 | 2 | InstantHit | 0.21 |  |
