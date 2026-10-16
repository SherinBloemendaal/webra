// Quick tips: one short line on what each structure, defence, infantry,
// vehicle, ship and aircraft does, shown in the build menu's cameo tooltip
// (js/production.js `productionTip`) and in the battlefield tooltip
// (js/worldtooltip.js) while the `game.quickTips` setting is on (default on;
// the guide's finale (work/guideflow) asks whether to keep it). While it is
// on, the cameo tooltip shows the quick tip instead of OpenRA's description.
//
// Every actor type the build menu can list (engine/rules.json: a production
// queue and no `~disabled` prerequisite) has a tip, and nothing else does
// except QUICK_TIP_MAP_ONLY (tests/quicktips.test.mjs). Each claim is checked
// against WebRA's rules (abilities, weapons, support powers, cargo, crush
// classes): keep them true when the rules change. A new actor needs a tip
// here (docs/contracts.md, "Quick tips").
//
// No DOM in this module: Node tests import it.

/** The registry key of the setting (js/registry.js GROUPS.game). */
export const QUICK_TIPS_SETTING = Object.freeze(['game', 'quickTips']);

/** Longest tip, in characters (one line in the tooltips). */
export const QUICK_TIP_MAX = 80;

const fake = (name) => `Decoy that looks like ${name} to the enemy. Does nothing.`;

/** Actor id -> what it does. */
export const QUICK_TIPS = Object.freeze({
  // Structures.
  POWR: 'Provides power for your base.',
  APWR: 'Provides twice the power of a Power Plant.',
  PROC: 'Turns ore and gems into credits. Comes with an Ore Truck.',
  SILO: 'Stores more refined ore and gems.',
  TENT: 'Trains infantry.',
  BARR: 'Trains infantry.',
  KENN: 'Trains Attack Dogs.',
  WEAP: 'Builds vehicles.',
  FIX: 'Repairs vehicles and aircraft for credits. Rearms Minelayers.',
  DOME: 'Shows the radar minimap. Needs power.',
  HPAD: 'Builds helicopters and rearms them.',
  AFLD: 'Builds planes and rearms them. Gives the Spy Plane and Paratroopers.',
  'AFLD.Ukraine': 'Builds and rearms planes. Gives Spy Plane, Paratroopers and Parabombs.',
  SYRD: 'Builds and repairs ships. Detects nearby submarines.',
  SPEN: 'Builds submarines and transports, repairs ships, detects submarines.',
  ATEK: 'Unlocks advanced Allied units. Gives the GPS Satellite.',
  STEK: 'Unlocks advanced Soviet units and structures.',
  LROD: 'Keeps storm lightning from striking near it.',
  // Defences.
  GAP: 'Hides the area around it from the enemy under shroud. Needs power.',
  PDOX: 'Teleports a group of units for a short time. Needs power.',
  IRON: 'Makes a group of units invulnerable for a short time. Needs power.',
  MSLO: 'Launches a nuclear missile. Needs power.',
  SBAG: 'Stops infantry and light vehicles. Tanks and heavy vehicles crush it.',
  FENC: 'Stops infantry and light vehicles. Tanks and heavy vehicles crush it.',
  BRIK: 'Blocks units and enemy fire. Only Mammoth Tanks crush it.',
  PBOX: 'Machine gun defence against infantry. Detects cloaked units.',
  HBOX: 'Camouflaged pillbox: hidden from the enemy until it fires.',
  GUN: 'Anti-tank defence. Detects cloaked units.',
  FTUR: 'Flame defence against infantry. Detects cloaked units.',
  TSLA: 'Tesla defence, strong against ground units. Needs power.',
  AGUN: 'Anti-aircraft defence. Needs power.',
  SAM: 'Anti-aircraft defence. Needs power.',
  FPWR: fake('a Power Plant'),
  TENF: fake('an Allied Barracks'),
  SYRF: fake('a Naval Yard'),
  WEAF: fake('a War Factory'),
  DOMF: fake('a Radar Dome'),
  FIXF: fake('a Service Depot'),
  FAPW: fake('an Advanced Power Plant'),
  ATEF: fake('an Allied Tech Center'),
  PDOF: fake('a Chronosphere'),
  MSLF: fake('a Missile Silo'),
  FACF: fake('a Construction Yard'),
  // Infantry.
  E1: 'General infantry, good against infantry.',
  E2: 'Throws grenades. Good against infantry and structures.',
  E3: 'Fires rockets at vehicles and aircraft.',
  E4: 'Flamethrower. Good against infantry and structures.',
  E6: 'Captures enemy structures, repairs your own and fixes bridges.',
  E7: 'Commando: kills infantry fast and blows up structures with C4.',
  DOG: 'Hunts infantry and sniffs out spies.',
  MEDI: 'Heals nearby infantry.',
  MECH: 'Repairs vehicles and turns husks back into working vehicles.',
  SPY: 'Disguises itself and sneaks into enemy structures to sabotage them.',
  'SPY.England': 'Cheaper spy: disguises itself and sabotages enemy structures.',
  THF: 'Steals credits from enemy refineries and silos.',
  SHOK: 'Fires Tesla bolts. Good against infantry and vehicles.',
  // Vehicles.
  HARV: 'Gathers ore and gems for your refineries.',
  MCV: 'Deploys into a Construction Yard.',
  TRUK: 'Drives into an allied structure to give its owner $500.',
  JEEP: 'Fast scout with a machine gun. Carries one soldier.',
  APC: 'Armoured transport for five soldiers, with a machine gun.',
  FTRK: 'Flak gun against aircraft and infantry.',
  '1TNK': 'Fast light tank, good for scouting.',
  '2TNK': 'Allied main battle tank.',
  '3TNK': 'Soviet battle tank with two cannons.',
  '4TNK': 'Slow, heavy tank. Its missiles hit aircraft too.',
  V2RL: 'Long-range rockets against infantry and structures.',
  ARTY: 'Long-range artillery against infantry and structures.',
  MNLY: 'Lays anti-tank mines and spots enemy mines.',
  MRJ: 'Jams enemy radar and deflects incoming missiles nearby.',
  MGG: 'Covers the area around it in shroud for the enemy.',
  TTNK: 'Tank with a Tesla coil. Strong against ground units.',
  DTRK: 'Drives into the enemy and explodes like a small nuke.',
  CTNK: 'Missile tank that can teleport up to 12 cells away.',
  STNK: 'Cloaked transport for five soldiers, with missiles.',
  QTNK: 'Deploy to shake apart nearby vehicles and structures. Destroys itself.',
  // Ships.
  LST: 'Carries infantry and vehicles over water.',
  PT: 'Fast gunboat. Hunts submarines with depth charges.',
  SS: 'Submerged torpedo boat against ships. Hidden until it attacks.',
  DD: 'Fights ships, submarines and aircraft. Detects submarines.',
  CA: 'Very long-range guns against targets on land.',
  MSUB: 'Submerged missile boat that hits targets on land and in the air.',
  // Aircraft.
  TRAN: 'Helicopter that carries eight soldiers.',
  HIND: 'Gunship with chain guns. Good against infantry.',
  MH60: 'Gunship with chain guns. Good against infantry.',
  HELI: 'Gunship with missiles against vehicles, structures and aircraft.',
  YAK: 'Attack plane with machine guns. Good against infantry.',
  MIG: 'Attack plane with missiles against vehicles and structures.',
  // On the map only (deployed from the MCV, never built): QUICK_TIP_MAP_ONLY.
  FACT: 'Builds structures and defences.',
});

/** Tips of actors the build menu never lists but the battlefield shows. */
export const QUICK_TIP_MAP_ONLY = Object.freeze(['FACT']);

/** The quick tip of actor type `id`, or null when it has none. */
export function quickTip(id) {
  return (id && Object.hasOwn(QUICK_TIPS, id) && QUICK_TIPS[id]) || null;
}

/** Turn the quick tips on or off (for the guide's finale on work/guideflow; js/registry.js). */
export function setQuickTips(registry, on) {
  registry.set(QUICK_TIPS_SETTING[0], QUICK_TIPS_SETTING[1], !!on);
}
