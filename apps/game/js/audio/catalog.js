// What every sound event sounds like: the synthesized sound we ship (synth.js)
// and the original Red Alert file names it maps to when the player installed
// their own game files (install.js). Only names live here, never audio.
//
// Original names follow OpenRA's mods/ra (weapon Report/ImpactSounds and actor
// sounds come from the rules dump via catalog-data.js; voice sets, speech
// notifications and music follow mods/ra/audio). A name the player's files do
// not contain simply falls back to the synthesized sound.

import { WEAPON_SOUNDS, ACTOR_SOUNDS, CRATE_SOUNDS, SPEECH, SOUND_NOTIFICATIONS, MUSIC_TRACKS, PLAYER_NOTIFICATIONS, WORLD_NOTIFICATIONS } from './catalog-data.js';

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

/**
 * Placing a structure. OpenRA PlaceBuilding plays every Building.BuildSounds
 * entry at once (placbldg and build5 together), so the sound is `layered`:
 * the bank plays all of its originals instead of picking one. Our own
 * place_building sound already holds both the thud and the clank.
 */
export const placeSound = cached((actorId) => ({ synth: 'place_building', originals: (ACTOR_SOUNDS[actorId]?.build ?? ['placbldg']).map(fileName), layered: true }));

/**
 * What an actor that transforms (OpenRA Transforms: an MCV deploying, a
 * Construction Yard packing up) plays as it turns into its other form: a
 * structure's Building.UndeploySounds (Building.cs BeforeTransform) and its
 * TransformSounds (Activities/Transform.cs), every entry at once. Both are
 * empty for actors whose rules name no sounds, as in OpenRA.
 * @returns {{ synth: string, originals: string[], layered: true }[]}
 */
export const transformSounds = cached((actorId) => {
  const a = ACTOR_SOUNDS[actorId] ?? {};
  const out = [];
  if (a.undeploy?.length) out.push({ synth: 'sell', originals: a.undeploy.map(fileName), layered: true });
  if (a.transform?.length) out.push({ synth: 'place_building', originals: a.transform.map(fileName), layered: true });
  return out;
});

/**
 * A refused deploy (OpenRA Transforms.DeployTransform): the NoTransformSounds
 * and the EVA key of the NoTransformNotification, or null when the rules name neither.
 */
export const deployBlocked = cached((actorId) => {
  const a = ACTOR_SOUNDS[actorId] ?? {};
  const sound = a.noTransform?.length ? { synth: null, originals: a.noTransform.map(fileName), layered: true } : null;
  return { sound, announce: speechKey(a.noTransformNotification) };
});

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
 * Text, synthesized chime and minimum seconds between two of the same, per
 * OpenRA speech notification (notifications.yaml Speech) that a multiplayer
 * or skirmish game plays. Texts follow OpenRA's text notifications
 * (rules.ftl) where it has one. The campaign lines keep a text made from
 * their name and the plain chime.
 *
 * Cooldowns: OpenRA plays a line again only when the same one is not playing
 * (InterruptType DoNotPlay); our announcer never queues a line twice, and the
 * cooldowns add the intervals of the traits that repeat a line
 * (PlayerResources.InsufficientFundsNotificationInterval 30 s,
 * DamageNotifier.NotifyInterval 30 s; low power and silos repeat on their own
 * timers in director.js).
 */
const SPEECH_LINES = {
  AbombLaunchDetected: ['A-bomb launch detected.', 'eva_alarm', 5],
  AbombPrepping: ['A-bomb prepping.', 'eva_info', 1],
  AbombReady: ['A-bomb ready.', 'eva_ready', 0.5],
  AirUnitLost: ['Airborne Unit lost.', 'eva_loss', 1],
  BaseAttack: ['Base under attack.', 'eva_alarm', PLAYER_NOTIFICATIONS.baseAttack?.interval / 1000 || 30],
  Building: ['Building.', 'eva_info', 0.8],
  BuildingCannotPlaceAudio: ['Cannot deploy here.', 'eva_warn', 1],
  BuildingCaptured: ['Structure captured.', 'eva_good', 1],
  BuildingInfiltrated: ['Building infiltrated.', 'eva_good', 1],
  BuildingInProgress: ['Unable to comply. Building in progress.', 'eva_warn', 1],
  Cancelled: ['Cancelled.', 'eva_loss', 0.5],
  ChronosphereCharging: ['Chronosphere charging.', 'eva_info', 1],
  ChronosphereReady: ['Chronosphere ready.', 'eva_ready', 0.5],
  ConstructionComplete: ['Construction complete.', 'eva_good', 1],
  CreditsStolen: ['Credits stolen.', 'eva_loss', 1],
  GameLoaded: ['Game loaded.', 'eva_info', 1],
  GameSaved: ['Game saved.', 'eva_info', 1],
  InsufficientFunds: ['Insufficient funds.', 'eva_warn', PLAYER_NOTIFICATIONS.funds?.interval / 1000 || 30],
  InsufficientPower: ['Insufficient power.', 'eva_warn', 1],
  IronCurtainCharging: ['Iron curtain charging.', 'eva_info', 1],
  IronCurtainReady: ['Iron curtain ready.', 'eva_ready', 0.5],
  Leave: ['Battle control terminated.', 'eva_loss', 1],
  Lose: ['Mission failed.', 'eva_loss', 5],
  LowPower: ['Low power.', 'eva_warn', 1],
  MissionAccomplished: ['Mission accomplished.', 'eva_good', 5],
  MissionFailed: ['Mission failed.', 'eva_loss', 5],
  NavalUnitLost: ['Naval Unit lost.', 'eva_loss', 1],
  NewOptions: ['New construction options.', 'eva_info', 1],
  NoBuild: ['Unable to build more.', 'eva_warn', 1],
  OnHold: ['On hold.', 'eva_info', 0.5],
  PrimaryBuildingSelected: ['Primary building selected.', 'eva_info', 0.5],
  ReinforcementsArrived: ['Reinforcements have arrived.', 'eva_good', 1],
  Repairing: ['Repairing.', 'eva_info', 1],
  SatelliteLaunched: ['Satellite launched.', 'eva_info', 1],
  SelectTarget: ['Select target.', 'eva_info', 1],
  SilosNeeded: ['Silos needed.', 'eva_warn', 1],
  SonarPulseReady: ['Sonar pulse ready.', 'eva_ready', 0.5],
  SpyPlaneReady: ['Spy plane ready.', 'eva_ready', 0.5],
  StartGame: ['Battle control online.', 'eva_good', 1],
  StructureDestroyed: ['Structure destroyed.', 'eva_loss', 1],
  StructureSold: ['Structure sold.', 'eva_cash', 1],
  Training: ['Training.', 'eva_info', 0.8],
  UnitLost: ['Unit lost.', 'eva_loss', 1],
  UnitReady: ['Unit ready.', 'eva_good', 1],
  UnitRepaired: ['Unit repaired.', 'eva_good', 1],
  UnitSold: ['Unit sold.', 'eva_cash', 1],
  UnitStolen: ['Unit stolen.', 'eva_good', 1],
  Win: ['Mission accomplished.', 'eva_good', 5],
  // OpenRA TimeLimitManager.Notification: "{0} minute{1} remaining."
  FourtyMinutesRemaining: ['40 minutes remaining.', 'eva_warn', 1],
  ThirtyMinutesRemaining: ['30 minutes remaining.', 'eva_warn', 1],
  TwentyMinutesRemaining: ['20 minutes remaining.', 'eva_warn', 1],
  TenMinutesRemaining: ['10 minutes remaining.', 'eva_warn', 1],
  WarningFiveMinutesRemaining: ['5 minutes remaining.', 'eva_warn', 1],
  WarningFourMinutesRemaining: ['4 minutes remaining.', 'eva_warn', 1],
  WarningThreeMinutesRemaining: ['3 minutes remaining.', 'eva_warn', 1],
  WarningTwoMinutesRemaining: ['2 minutes remaining.', 'eva_warn', 1],
  WarningOneMinuteRemaining: ['1 minute remaining.', 'eva_warn', 1],
};

/** "UnitReady" -> "unitReady": the EVA key of an OpenRA speech notification. */
export const evaKey = (name) => (name ? name[0].toLowerCase() + name.slice(1) : null);

/** "AlliedForcesApproaching" -> "Allied forces approaching." (lines without their own text). */
export function spokenText(name) {
  const words = name
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/gi, '$1 $2')
    .toLowerCase();
  return `${words[0].toUpperCase()}${words.slice(1)}.`;
}

/**
 * Announcer lines by EVA key (evaKey of the OpenRA name): `name` is the
 * OpenRA notification, `text` is shown (and spoken when speech is on),
 * `chime` is the synthesized cue, `originals` the speech.mix file,
 * `cooldown` the minimum seconds between two of the same. Lines with
 * `textOnly` are shown without sound (OpenRA text notifications without
 * speech, like "Unit promoted." next to the LevelUp sound).
 */
export const EVA = {};
for (const [name, file] of Object.entries(SPEECH)) {
  const [text, chime, cooldown] = SPEECH_LINES[name] ?? [spokenText(name), 'eva_info', 1];
  EVA[evaKey(name)] = { name, text, chime, originals: file ? [fileName(file)] : [], cooldown };
}
for (const [key, text] of Object.entries({
  // DamageNotifier AllyTextNotification: an ally's structure is under attack (no speech in RA).
  allyUnderAttack: PLAYER_NOTIFICATIONS.baseAttack?.allyText ?? 'Our ally is under attack.',
  // GainsExperience LevelUpTextNotification, next to the LevelUp sound.
  unitPromoted: 'Unit promoted.',
})) {
  EVA[key] = { name: null, text, chime: null, originals: [], cooldown: key === 'allyUnderAttack' ? 30 : 0.2, textOnly: true };
}

/** The EVA key of an OpenRA speech notification name, or null when there is no such line. */
export function speechKey(name) {
  const key = evaKey(name);
  return key && EVA[key] && !EVA[key].textOnly ? key : null;
}

/** Production queue names in the engine's order (engine/src/rules.rs QueueType). */
export const QUEUE_NAMES = ['Building', 'Defense', 'Infantry', 'Vehicle', 'Aircraft', 'Ship'];

/**
 * The speech of production queue `queue` (index) for `what`: ready, blocked
 * (NoBuild), limited (BuildingInProgress), queued (Building or Training),
 * onHold, cancelled (OpenRA ProductionQueue ...Audio), as an EVA key.
 */
export function queueLine(queue, what) {
  return speechKey(PLAYER_NOTIFICATIONS.queues?.[QUEUE_NAMES[queue]]?.[what]);
}

/** Speech of the player traits (PLAYER_NOTIFICATIONS) as EVA keys and their intervals in seconds. */
export const PLAYER_LINES = Object.freeze({
  lowPower: speechKey(PLAYER_NOTIFICATIONS.lowPower?.speech),
  lowPowerInterval: (PLAYER_NOTIFICATIONS.lowPower?.interval ?? 10000) / 1000,
  funds: speechKey(PLAYER_NOTIFICATIONS.funds?.speech),
  silos: speechKey(PLAYER_NOTIFICATIONS.silos?.speech),
  silosInterval: (PLAYER_NOTIFICATIONS.silos?.interval ?? 20000) / 1000,
  silosThreshold: PLAYER_NOTIFICATIONS.silos?.threshold ?? 80,
  baseAttack: speechKey(PLAYER_NOTIFICATIONS.baseAttack?.speech),
  newOptions: speechKey(PLAYER_NOTIFICATIONS.placeBuilding?.newOptions),
  cannotPlace: speechKey(PLAYER_NOTIFICATIONS.placeBuilding?.cannotPlace),
  win: speechKey(PLAYER_NOTIFICATIONS.objectives?.win),
  lose: speechKey(PLAYER_NOTIFICATIONS.objectives?.lose),
  leave: speechKey(PLAYER_NOTIFICATIONS.objectives?.leave),
  startGame: speechKey(WORLD_NOTIFICATIONS.startGame?.speech),
  gameLoaded: speechKey(WORLD_NOTIFICATIONS.startGame?.loaded),
  gameSaved: speechKey(WORLD_NOTIFICATIONS.startGame?.saved),
});

/** Time limit warning speech for `minutes` left (OpenRA TimeLimitWarnings), or null. */
export function timeLimitLine(minutes) {
  return speechKey(WORLD_NOTIFICATIONS.timeLimitWarnings?.[minutes]);
}

// ---- Actor notifications and sounds -------------------------------------------------------

/** Sound data of an actor (catalog-data.js ACTOR_SOUNDS): by its rules id, also in another case. */
export function actorSounds(actorId) {
  if (!actorId) return {};
  return ACTOR_SOUNDS[actorId] ?? ACTOR_SOUNDS[actorId.toUpperCase()] ?? ACTOR_SOUNDS[actorId.toLowerCase()] ?? {};
}

/** OpenRA ActorLostNotification of an actor, as an EVA key (null: it has none, e.g. structures). */
export function lostLine(actorId) {
  return speechKey(actorSounds(actorId).lost?.speech);
}

/**
 * OpenRA CaptureNotification of a captured actor: `gained` for the new
 * owner (BuildingCaptured, UnitStolen), `lost` for the old one (UnitLost).
 */
export function captureLines(actorId) {
  const c = actorSounds(actorId).capture;
  return { gained: speechKey(c?.speech), lost: speechKey(c?.lose) };
}

/**
 * An infiltration (OpenRA Infiltrates and the target's InfiltrateFor*):
 * `infiltrator` lines for the infiltrator's owner, `target` lines for the
 * target's owner. Only the target traits the infiltrator's types match count.
 */
export function infiltrationLines(targetId, infiltratorId) {
  const by = actorSounds(infiltratorId).infiltrates ?? [];
  const types = new Set(by.flatMap((i) => i.types ?? []));
  const matching = (actorSounds(targetId).infiltrated ?? []).filter((t) => !t.types || t.types.some((x) => types.has(x)));
  const keys = (list) => [...new Set(list.map(speechKey).filter(Boolean))];
  return {
    infiltrator: keys([...by.map((i) => i.speech), ...matching.map((t) => t.infiltration)]),
    target: keys(matching.map((t) => t.speech)),
  };
}

/** OpenRA RepairsUnits notifications of a repairing structure: start and finish, as EVA keys. */
export function repairLines(structureId) {
  const r = actorSounds(structureId).repairs;
  return { start: speechKey(r?.start), finish: speechKey(r?.finish) };
}

/** OpenRA PrimaryBuilding SelectionNotification of a structure, as an EVA key. */
export function primaryLine(structureId) {
  return speechKey(actorSounds(structureId).primary?.speech);
}

/** Support power notifications of power `key` provided by `providerId` (catalog-data.js powers). */
export function powerNotifications(providerId, key) {
  const p = actorSounds(providerId).powers?.[key] ?? Object.values(ACTOR_SOUNDS).find((a) => a.powers?.[key])?.powers[key] ?? {};
  return {
    ...p,
    beginChargeLine: speechKey(p.beginCharge),
    endChargeLine: speechKey(p.endCharge),
    selectTargetLine: speechKey(p.selectTarget),
    insufficientPowerLine: speechKey(p.insufficientPower),
    launchLine: speechKey(p.launch),
    incomingLine: speechKey(p.incoming),
    reinforcementsLine: speechKey(p.reinforcements),
  };
}

/** A one-off sound file of the rules as a sound: { synth, originals } (null synth: silent without originals). */
const fileSound = (file, synth) => ({ synth, originals: file ? [fileName(file)] : [] });

/** OpenRA SoundOnDamageTransition DamagedSounds (falling to Heavy), or null when the actor has none. */
export const damagedSound = cached((actorId) => {
  const list = actorSounds(actorId).damaged ?? [];
  return list.length ? { synth: 'damaged', originals: list.map(fileName) } : null;
});

/** OpenRA Crushable.CrushSound, or null. */
export const crushSound = cached((actorId) => {
  const f = actorSounds(actorId).crush;
  return f ? fileSound(f, 'crush') : null;
});

/** OpenRA ParaDrop.ChuteSound of a dropping aircraft, or null. */
export const chuteSound = cached((actorId) => {
  const f = actorSounds(actorId).chute;
  return f ? fileSound(f, 'chute') : null;
});

/** OpenRA EjectOnDeath.ChuteSound of an aircraft whose pilot bails out, or null. */
export const ejectChuteSound = cached((actorId) => {
  const f = actorSounds(actorId).ejectChute;
  return f ? fileSound(f, 'chute') : null;
});

/** OpenRA Parachutable Ground/WaterImpactSound of a parachuted actor dying on landing, or null. */
export const paraImpactSound = cached((actorId, water) => {
  const p = actorSounds(actorId).paraImpact;
  const f = water ? p?.water : p?.ground;
  return f ? fileSound(f, water ? 'splash_small' : 'crush') : null;
});

/** OpenRA Cloak CloakSound (`on`) or UncloakSound, or null. */
export const cloakSound = cached((actorId, on) => {
  const c = actorSounds(actorId).cloak;
  const f = on ? c?.on : c?.off;
  return f ? fileSound(f, on ? 'cloak' : 'uncloak') : null;
});

/** OpenRA AmmoPool.RearmSound, or null. */
export const rearmSound = cached((actorId) => {
  const f = actorSounds(actorId).rearm;
  return f ? fileSound(f, 'rearm') : null;
});

/** OpenRA GainsExperience: the LevelUp sound notification and its text, or null. */
export function levelUp(actorId) {
  const l = actorSounds(actorId).levelUp;
  return l?.sound ? { sound: l.sound, text: l.text ? 'unitPromoted' : null } : null;
}

/**
 * Crate actions in the order of the engine's CrateCollected codes
 * (sound_events.rs crate_action_code; index 0: unknown).
 */
export const CRATE_ACTIONS = [
  null,
  'GiveCashCrateAction',
  'LevelUpCrateAction',
  'ExplodeCrateAction',
  'HideMapCrateAction',
  'HealActorsCrateAction',
  'RevealMapCrateAction',
  'DuplicateUnitCrateAction',
  'GiveBaseBuilderCrateAction',
  'GiveUnitCrateAction',
  'GrantExternalConditionCrateAction',
];

/** OpenRA CrateAction Sound and Notification of a crate action code: { sound, line } (each may be null). */
export const crateSounds = cached((code) => {
  const action = CRATE_ACTIONS[code];
  const entry = action ? Object.entries(CRATE_SOUNDS).find(([k]) => k.split('@')[0] === action)?.[1] : null;
  return { sound: entry?.sound ? fileSound(entry.sound, 'crate') : null, line: speechKey(entry?.speech) };
});

// ---- Sound notifications (notifications.yaml Sounds) --------------------------------------------

/** Our synthesized sound per OpenRA sound notification (null: OpenRA's is empty, nothing plays). */
export const SOUND_SYNTH = {
  RadarUp: 'radar_up',
  RadarDown: 'radar_down',
  CashTickUp: 'cash_up',
  CashTickDown: 'cash_down',
  LevelUp: 'level_up',
  DisablePower: 'power_down',
  EnablePower: 'power_up',
  ChatLine: 'chat_line',
  PlayerJoined: 'player_joined',
  LobbyOptionChanged: 'lobby_option',
  PlayerLeft: 'player_left',
  ClickSound: 'ui_click',
  ClickDisabledSound: null,
  Beacon: 'beacon',
  AlertBuzzer: 'alert_buzzer',
  AlertBleep: 'alert_bleep',
  AngryBleep: 'angry_bleep',
  BaseSetup: 'base_setup',
};

/**
 * A sound notification: { synth, originals, volume, interrupt } (OpenRA
 * SoundPool VolumeModifier and InterruptType: DoNotPlay, Interrupt or Overlap),
 * or null for an unknown name or one without any sound.
 */
export const notificationSound = cached((name) => {
  const n = SOUND_NOTIFICATIONS[name];
  if (!n) return null;
  const synth = n.file || name in SOUND_SYNTH ? (SOUND_SYNTH[name] ?? null) : null;
  if (!n.file && !synth) return null;
  return { synth, originals: n.file ? [fileName(n.file)] : [], volume: n.volume, interrupt: n.interrupt };
});

/** Power kind codes of PowerActivated events (sound_events.rs power_code). */
export const POWER_KINDS = [
  null,
  'NukePower',
  'ChronoshiftPower',
  'GrantExternalConditionPower',
  'AirstrikePower',
  'ParatroopersPower',
  'GpsPower',
  'SpawnActorPower',
];

/** Sidebar button sounds (OpenRA notifications DisablePower, EnablePower and Beacon). */
export const BUTTON_SOUNDS = {
  powerDown: notificationSound('DisablePower'),
  powerUp: notificationSound('EnablePower'),
  beacon: notificationSound('Beacon'),
};

/**
 * The sidebar cash counter ticking up or down (OpenRA PlayerResources
 * CashTickUpNotification and CashTickDownNotification: notifications.yaml
 * CashTickUp cashup1 and CashTickDown cashdn1, VolumeModifier 0.33, overlapping).
 */
export const CASH_TICK_SOUNDS = {
  up: notificationSound(PLAYER_NOTIFICATIONS.funds?.cashUp ?? 'CashTickUp'),
  down: notificationSound(PLAYER_NOTIFICATIONS.funds?.cashDown ?? 'CashTickDown'),
};
/** OpenRA's VolumeModifier of both cash tick notifications. */
export const CASH_TICK_GAIN = CASH_TICK_SOUNDS.up.volume;

/**
 * Sound where a support power strikes: the power's own (OpenRA
 * GrantExternalConditionPower.OnFireSound, SpawnActorPower.DeploySound) when
 * the rules name one, else ours. The Chronosphere plays Chronoshiftable's
 * chrono2 where units vanish and appear.
 * @param {number} code power kind code (POWER_KINDS)
 * @param {{ onFire?: string, deploy?: string }} [rules] the power's notifications (powerNotifications)
 */
export function powerSound(code, rules = {}) {
  const kind = POWER_KINDS[code];
  if (kind === 'ChronoshiftPower') return { synth: 'chrono', originals: ['chrono2'].map(fileName) };
  if (kind === 'GrantExternalConditionPower') return { synth: 'iron_curtain', originals: [rules.onFire ?? 'ironcur9'].map(fileName) };
  if (kind === 'NukePower') return { synth: 'nuke_launch', originals: [] };
  if (rules.deploy || rules.onFire) return { synth: 'sonar_pulse', originals: [fileName(rules.deploy ?? rules.onFire)] };
  return { synth: 'radio_select', originals: [] };
}

// ---- Music ------------------------------------------------------------------------------

/**
 * The Red Alert soundtrack, installed content only, as OpenRA's
 * mods/ra/audio/music.yaml lists it: the base game (scores.mix), then the
 * Counterstrike and Aftermath tracks (the scores.mix inside each expansion
 * disc's MAIN.MIX; OpenRA installs them as loose files in its content's
 * expand folder). `hidden` tracks (intro, map, score) are left out of the
 * playlist and play only as background music: the intro behind the main
 * menu, the score and map tracks after a game (MusicPlaylist VictoryMusic
 * and DefeatMusic). `volume` is the track's VolumeModifier.
 */
export const MUSIC = MUSIC_TRACKS.map((m) => ({ file: fileName(m.file), title: m.title, volume: m.volume, hidden: m.hidden, group: m.group }));

/** The tracks of the music player and the playlist (not hidden), in OpenRA's order. */
export const PLAYLIST = MUSIC.filter((m) => !m.hidden);

/** A track by its name in music.yaml ("score", "map", "intro"), or null. */
export const musicTrack = (name) => (name ? (MUSIC.find((m) => m.file === fileName(name)) ?? null) : null);

/** Background tracks (OpenRA MusicPlaylist): after a won or a lost game, and behind the main menu (the shellmap's BackgroundMusic). */
export const BACKGROUND_MUSIC = Object.freeze({
  victory: musicTrack(WORLD_NOTIFICATIONS.music?.victory),
  defeat: musicTrack(WORLD_NOTIFICATIONS.music?.defeat),
  menu: musicTrack('intro'),
});

/**
 * Where music comes from, for the music player and the content dialog. The
 * OpenRA quick install package (ra-quickinstall.zip) has no music: OpenRA too
 * takes it from a Red Alert disc, the Steam or Origin release or C&C Remastered.
 */
export const MUSIC_SOURCE_HINT =
  'The OpenRA quick install package (ra-quickinstall.zip) has no music: OpenRA itself also needs a Red Alert disc, the Steam or Origin release, or C&C Remastered for it. Add scores.mix (or main.mix or redalert.mix, which contain it) from such a copy by dropping it on this page or in the Original content dialog. The Counterstrike and Aftermath tracks come from those expansion discs (their CD image or MAIN.MIX) or from the expand folder of an OpenRA content install.';

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
    add(a.transform ?? []);
    add(a.undeploy ?? []);
    add(a.noTransform ?? []);
    add(a.damaged ?? []);
    add([a.crush, a.chute, a.ejectChute, a.paraImpact?.ground, a.paraImpact?.water, a.cloak?.on, a.cloak?.off, a.rearm].filter(Boolean));
    for (const p of Object.values(a.powers ?? {})) {
      add(
        [p.onFire, p.deploy, p.launchSound, p.incomingSound, p.beginChargeSound, p.endChargeSound, p.selectTargetSound, p.insufficientPowerSound].filter(Boolean),
      );
    }
  }
  for (const c of Object.values(CRATE_SOUNDS)) if (c.sound) add([c.sound]);
  add(INFANTRY_DIE);
  add(['placbldg', 'cashturn', 'chrono2', 'ironcur9']);
  for (const n of Object.keys(SOUND_NOTIFICATIONS)) add(notificationSound(n)?.originals ?? []);
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
