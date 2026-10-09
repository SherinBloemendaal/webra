# Red Alert unit and building catalog (OpenRA `ra` mod)

Source: [OpenRA/OpenRA `bleed` mods/ra/rules + weapons](https://github.com/OpenRA/OpenRA/tree/bleed/mods/ra), fetched 2026-10-07, inheritance (`Inherits`, `-Trait` removals) fully resolved.
Per-faction availability is computed by walking the tech tree (`ProvidesPrerequisite` / `Prerequisites`) for every subfaction.

**Units:** HP and damage are OpenRA values / 100 (OpenRA stores them x100; numbers follow current OpenRA multiplayer balance, which differs slightly from the 1996 game). Range and sight are in cells (1 cell = 1024 world units). Speed is world units per tick. Power: + produces, - consumes. Build time in OpenRA is derived from cost unless `BuildDuration` is set.

Hotkeys (`data/source/hotkeys/*.yaml` and `*.ftl`, OpenRA `mods/common/hotkeys`, `mods/ra/hotkeys.yaml` and their `fluent/hotkeys.ftl` descriptions at commit `b6fc03fcfaef1277592bbd4cbc7d44dd85219902`, GPL-3.0; `ra.yaml` and `ra-hotkeys.ftl` are the Red Alert ones): OpenRA's default keys, contexts and descriptions; `tools/gen_hotkeys.py` turns them into `apps/game/js/openra-hotkeys.js`, the defaults of the game's hotkeys.

Sprite sequences (`data/source/sequences/*.yaml`, OpenRA `mods/ra/sequences` at commit `b6fc03fcfaef1277592bbd4cbc7d44dd85219902`, GPL-3.0) describe how OpenRA cuts the original Red Alert sprites into facings and animations; `tools/gen_content_tables.py` turns them, the rules and the tilesets into `apps/game/js/content/tables.js` (file names and frame numbers only: the graphics come from the player's own copy of Red Alert).

Audio (`data/source/audio/notifications.yaml` and `music.yaml`, OpenRA `mods/ra/audio` at commit `b6fc03fcfaef1277592bbd4cbc7d44dd85219902`, GPL-3.0): the speech and sound notifications with their file names, volumes and interrupt types, and the soundtrack with its titles, volumes and hidden tracks; `tools/gen-audio-catalog.mjs` turns them, the rules in `data/source/rules` (every actor with its inheritance resolved: sound traits, notifications, support powers) and `weapons.json` into `apps/game/js/audio/catalog-data.js` (file names only: the sounds come from the player's own copy of Red Alert).

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
