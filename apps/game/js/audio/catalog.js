// What every sound event sounds like: the synthesized sound we ship (synth.js)
// and the original Red Alert file names it maps to when the player installed
// their own game files (install.js). Only names live here, never audio.
//
// Original names follow OpenRA's mods/ra (weapon Report/ImpactSounds and actor
// sounds come from the rules dump via catalog-data.js; voice sets, speech
// notifications and music follow mods/ra/audio). A name the player's files do
// not contain simply falls back to the synthesized sound.

import { WEAPON_SOUNDS, ACTOR_SOUNDS } from './catalog-data.js';

/** "conscmp1" -> "conscmp1.aud"; names with an extension (voice variants like "ackno.v01") stay as they are. */
export const fileName = (base) => (/\.[a-z0-9]{3}$/i.test(base) ? base : `${base}.aud`).toLowerCase();

// ---- Weapons -------------------------------------------------------------------

/**
 * Synthesized fire and impact sound per weapon (engine rules names). Impact
 * classes: hit (small arms), zap, burn, small/medium/large/huge explosions.
 */
export const WEAPON_SYNTH = {
  M1Carbine: ['rifle', 'hit'],
  M60mg: ['mg', 'hit'],
  Vulcan: ['chaingun', 'hit'],
  ChainGun: ['chaingun', 'hit'],
  'ChainGun.Yak': ['chaingun', 'hit'],
  '25mm': ['cannon_small', 'explosion_small'],
  '90mm': ['cannon', 'explosion_small'],
  '105mm': ['cannon', 'explosion_small'],
  '120mm': ['cannon', 'explosion_medium'],
  TurretGun: ['cannon', 'explosion_medium'],
  '2Inch': ['cannon_small', 'explosion_small'],
  '8Inch': ['naval_gun', 'explosion_medium'],
  '155mm': ['artillery', 'explosion_large'],
  SubMissile: ['rocket', 'explosion_medium'],
  SCUD: ['rocket_heavy', 'explosion_large'],
  V2Explode: [null, 'explosion_large'],
  Nike: ['missile', 'explosion_small'],
  RedEye: ['missile', 'explosion_small'],
  Dragon: ['rocket', 'explosion_small'],
  Stinger: ['missile', 'explosion_small'],
  StingerAA: ['missile', 'explosion_small'],
  MammothTusk: ['rocket', 'explosion_small'],
  APTusk: ['rocket', 'explosion_small'],
  'APTusk.stnk': ['rocket', 'explosion_small'],
  HellfireAA: ['missile', 'explosion_small'],
  HellfireAG: ['missile', 'explosion_medium'],
  Maverick: ['missile', 'explosion_medium'],
  SubMissileAA: ['missile', 'explosion_small'],
  TeslaZap: ['tesla', 'zap'],
  TTankZap: ['tesla', 'zap'],
  FireballLauncher: ['flame', 'burn'],
  'ZSU-23': ['flak', 'hit'],
  'FLAK-23-AA': ['flak', 'hit'],
  'FLAK-23-AG': ['flak', 'explosion_small'],
  TorpTube: ['torpedo', 'explosion_medium'],
  DepthCharge: ['depth_charge', 'explosion_medium'],
  ParaBomb: ['bomb', 'explosion_large'],
  Atomic: [null, 'explosion_huge'],
  MiniNuke: [null, 'explosion_huge'],
  ATMine: [null, 'explosion_medium'],
  APMine: [null, 'explosion_small'],
  MADTankThump: ['thump', null],
  MADTankDetonate: [null, 'explosion_large'],
  DemoTruckTargeting: [null, null],
  OreExplosion: [null, 'explosion_small'],
  UnitExplodeSmall: [null, 'explosion_medium'],
  UnitExplode: [null, 'explosion_large'],
  UnitExplodeShip: [null, 'explosion_large'],
  UnitExplodeSubmarine: [null, 'splash'],
  UnitExplodePlane: [null, 'explosion_large'],
  ArtilleryExplode: [null, 'explosion_large'],
};

/** Memoize a sound lookup: battles ask for the same few sounds thousands of times. */
function cached(fn) {
  const cache = new Map();
  return (...args) => {
    const key = args.join('|');
    let v = cache.get(key);
    if (!v) cache.set(key, (v = Object.freeze(fn(...args))));
    return v;
  };
}

/** Fire sound of a weapon: { synth, originals } (synth null: silent). */
export const fireSound = cached((weapon) => {
  const [synth] = WEAPON_SYNTH[weapon] ?? ['cannon', 'explosion_small'];
  return { synth, originals: (WEAPON_SOUNDS[weapon]?.report ?? []).map(fileName) };
});

/** Impact sound of a weapon; `water` when it landed in open water. */
export const impactSound = cached((weapon, water) => {
  const [, synth] = WEAPON_SYNTH[weapon] ?? ['cannon', 'explosion_small'];
  if (water) return { synth: synth === 'hit' ? 'splash_small' : 'splash', originals: (WEAPON_SOUNDS[weapon]?.water ?? []).map(fileName) };
  return { synth, originals: (WEAPON_SOUNDS[weapon]?.impact ?? []).map(fileName) };
});

// ---- Actors ----------------------------------------------------------------------

/** Kind codes of audio events (engine/src/sound_events.rs kind_code). */
export const KINDS = ['building', 'infantry', 'vehicle', 'ship', 'aircraft', 'mine'];

/** Infantry death screams (sounds.mix). */
const INFANTRY_DIE = ['dedman1', 'dedman2', 'dedman3', 'dedman4', 'dedman5', 'dedman6', 'dedman7', 'dedman8', 'dedman10'];

/** Death sound of an actor (id from rules, kind name). */
export const deathSound = cached((actorId, kind) => {
  if (kind === 'infantry') return { synth: 'infantry_die', originals: INFANTRY_DIE.map(fileName) };
  if (kind === 'mine') return { synth: null, originals: [] };
  const synth = kind === 'building' ? 'explosion_building' : kind === 'ship' ? 'explosion_ship' : 'explosion_large';
  return { synth, originals: (ACTOR_SOUNDS[actorId]?.death ?? []).map(fileName) };
});

export const placeSound = cached((actorId) => ({ synth: 'place_building', originals: (ACTOR_SOUNDS[actorId]?.build ?? ['placbldg']).map(fileName) }));

export const sellSound = cached((actorId) => ({ synth: 'sell', originals: (ACTOR_SOUNDS[actorId]?.sell ?? ['cashturn']).map(fileName) }));

// ---- Unit voices -------------------------------------------------------------------

/**
 * OpenRA voice sets of the units in this game. Unit lines live in allies.mix
 * and russian.mix with a per-side variant extension instead of ".aud".
 */
export const VOICE_SETS = {
  GenericVoice: {
    select: ['await1', 'ready', 'report1', 'yessir1'],
    action: ['ackno', 'affirm1', 'noprob', 'overout', 'ritaway', 'roger', 'ugotit'],
    variants: { allies: ['.v01', '.v03'], soviet: ['.r01', '.r03'] },
  },
  VehicleVoice: {
    select: ['vehic1', 'yessir1', 'report1', 'await1', 'unit1'],
    action: ['ackno', 'affirm1'],
    variants: { allies: ['.v00', '.v02'], soviet: ['.r00', '.r02'] },
  },
};

/** Spoken lines (speech synthesis) for units without original voices. */
export const SPOKEN = {
  select: ['Reporting', 'Yes sir', 'Awaiting orders', 'Ready'],
  action: ['Affirmative', 'Acknowledged', 'Moving out', 'Yes sir', 'On my way'],
};

export function voiceSetFor(actorId, kind) {
  const named = ACTOR_SOUNDS[actorId]?.voice ?? ACTOR_SOUNDS[actorId?.replace(/R\d+$/, '')]?.voice;
  if (named && VOICE_SETS[named]) return named;
  return kind === 'vehicle' || kind === 'ship' ? 'VehicleVoice' : 'GenericVoice';
}

/**
 * A unit's reply: `line` is 'select' or 'action', `side` 'allies' or 'soviet'.
 * @returns {{ synth: string, originals: string[], spoken: string[] }}
 */
export function voiceLine(actorId, kind, side, line) {
  const set = VOICE_SETS[voiceSetFor(actorId, kind)];
  const variants = set.variants[side] ?? set.variants.allies;
  const originals = [];
  for (const base of set[line]) for (const v of variants) originals.push(fileName(base + v));
  return { synth: line === 'select' ? 'radio_select' : 'radio_ack', originals, spoken: SPOKEN[line] };
}

// ---- Announcements (EVA) -------------------------------------------------------------

/**
 * Announcer lines: `text` is spoken when speech is on, `chime` is the
 * synthesized cue (always played with synthesized sounds), `originals` the
 * speech.mix files, `cooldown` the minimum seconds between two of the same.
 */
export const EVA = {
  building: { text: 'Building', chime: 'eva_info', originals: ['abldgin1'], cooldown: 0.8 },
  training: { text: 'Training', chime: 'eva_info', originals: ['train1'], cooldown: 0.8 },
  constructionComplete: { text: 'Construction complete', chime: 'eva_good', originals: ['conscmp1'], cooldown: 1 },
  unitReady: { text: 'Unit ready', chime: 'eva_good', originals: ['unitrdy1'], cooldown: 1.5 },
  insufficientFunds: { text: 'Insufficient funds', chime: 'eva_warn', originals: ['nofunds1'], cooldown: 10 },
  lowPower: { text: 'Low power', chime: 'eva_warn', originals: ['lopower1'], cooldown: 15 },
  baseUnderAttack: { text: 'Our base is under attack', chime: 'eva_alarm', originals: ['baseatk1'], cooldown: 20 },
  unitLost: { text: 'Unit lost', chime: 'eva_loss', originals: ['unitlst1'], cooldown: 6 },
  structureSold: { text: 'Structure sold', chime: 'eva_cash', originals: ['strusld1'], cooldown: 1 },
  // OpenRA RepairableBuilding RepairingNotification (the Repair button).
  repairing: { text: 'Repairing', chime: 'eva_info', originals: ['repair1'], cooldown: 1 },
  selectTarget: { text: 'Select target', chime: 'eva_info', originals: ['slcttgt1'], cooldown: 1 },
  cancelled: { text: 'Cancelled', chime: 'eva_loss', originals: ['cancld1'], cooldown: 1 },
  powerReady: { text: 'Ready', chime: 'eva_ready', originals: [], cooldown: 0.5 },
  nukeReady: { text: 'Nuclear weapon ready', chime: 'eva_ready', originals: ['aready1'], cooldown: 0.5 },
  chronoReady: { text: 'Chronosphere ready', chime: 'eva_ready', originals: ['chrordy1'], cooldown: 0.5 },
  ironCurtainReady: { text: 'Iron Curtain ready', chime: 'eva_ready', originals: ['ironrdy1'], cooldown: 0.5 },
  nukeLaunched: { text: 'Nuclear missile launched', chime: 'eva_alarm', originals: ['alaunch1'], cooldown: 5 },
  missionAccomplished: { text: 'Mission accomplished', chime: 'eva_good', originals: ['misnwon1'], cooldown: 5 },
  missionFailed: { text: 'Mission failed', chime: 'eva_loss', originals: ['misnlst1'], cooldown: 5 },
};

for (const e of Object.values(EVA)) e.originals = e.originals.map(fileName);

/** EVA line for a support power becoming ready (engine power kinds, powers.rs). */
export function powerReadyLine(kind) {
  return { NukePower: 'nukeReady', ChronoshiftPower: 'chronoReady', GrantExternalConditionPower: 'ironCurtainReady' }[kind] ?? 'powerReady';
}

/** Power kind codes of PowerActivated events (sound_events.rs power_code). */
export const POWER_KINDS = [
  null,
  'NukePower',
  'ChronoshiftPower',
  'GrantExternalConditionPower',
  'AirstrikePower',
  'ParatroopersPower',
  'GpsPower',
];

/** Sidebar button sounds (OpenRA notifications): power down and up, a beacon placed. */
export const BUTTON_SOUNDS = {
  powerDown: { synth: 'power_down', originals: ['bleep11'].map(fileName) },
  powerUp: { synth: 'power_up', originals: ['bleep12'].map(fileName) },
  beacon: { synth: 'beacon', originals: ['beepslct'].map(fileName) },
};

/** Sound where a support power strikes. */
export function powerSound(code) {
  const kind = POWER_KINDS[code];
  if (kind === 'ChronoshiftPower') return { synth: 'chrono', originals: ['chrono2'].map(fileName) };
  if (kind === 'GrantExternalConditionPower') return { synth: 'iron_curtain', originals: ['ironcur9'].map(fileName) };
  if (kind === 'NukePower') return { synth: 'nuke_launch', originals: [] };
  return { synth: 'radio_select', originals: [] };
}

// ---- Music ------------------------------------------------------------------------------

/** Red Alert soundtrack (scores.mix), installed content only. */
export const MUSIC = [
  ['bigf226m', 'Bigfoot'],
  ['crus226m', 'Crush'],
  ['fac1226m', 'Face the Enemy 1'],
  ['fac2226m', 'Face the Enemy 2'],
  ['hell226m', 'Hell March'],
  ['run1226m', 'Run for Your Life'],
  ['smsh226m', 'Smash'],
  ['tren226m', 'Trenches'],
  ['work226m', 'Workmen'],
  ['await', 'Await'],
  ['dense_r', 'Dense'],
  ['fogger1a', 'Fogger'],
  ['mud1a', 'Mud'],
  ['radio2', 'Radio 2'],
  ['rollout', 'Roll Out'],
  ['snake', 'Snake'],
  ['terminat', 'Terminate'],
  ['twin', 'Twin'],
  ['vector1a', 'Vector'],
].map(([base, title]) => ({ file: fileName(base), title }));

/** MIX archives that may hold the files above, possibly nested in main.mix or redalert.mix. */
export const ARCHIVES = [
  'main.mix',
  'redalert.mix',
  'sounds.mix',
  'allies.mix',
  'russian.mix',
  'speech.mix',
  'scores.mix',
  'local.mix',
  'conquer.mix',
  'general.mix',
  'expand.mix',
  'expand2.mix',
  'hires.mix',
  'lores.mix',
];

/** Every original file name any sound event can use. */
export function allOriginalNames() {
  const names = new Set();
  const add = (list) => list.forEach((n) => names.add(fileName(n)));
  for (const w of Object.values(WEAPON_SOUNDS)) {
    add(w.report ?? []);
    add(w.impact ?? []);
    add(w.water ?? []);
  }
  for (const a of Object.values(ACTOR_SOUNDS)) {
    add(a.build ?? []);
    add(a.sell ?? []);
    add(a.death ?? []);
  }
  add(INFANTRY_DIE);
  add(['placbldg', 'cashturn', 'chrono2', 'ironcur9']);
  for (const s of Object.values(BUTTON_SOUNDS)) add(s.originals);
  for (const set of Object.values(VOICE_SETS)) {
    for (const line of ['select', 'action']) {
      for (const base of set[line]) for (const v of Object.values(set.variants).flat()) add([base + v]);
    }
  }
  for (const e of Object.values(EVA)) add(e.originals);
  for (const m of MUSIC) add([m.file]);
  return [...names];
}

export const MUSIC_FILES = new Set(MUSIC.map((m) => m.file));
