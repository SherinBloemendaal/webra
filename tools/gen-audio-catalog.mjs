// Generates apps/game/js/audio/catalog-data.js from OpenRA's Red Alert data in
// data/: which original sound file NAMES belong to each weapon (data/weapons.json:
// Report, ImpactSounds) and actor (data/source/rules, every actor with its
// inheritance resolved: BuildSounds, TransformSounds, DamagedSounds, CrushSound,
// ChuteSound, CloakSound, RearmSound, its speech notifications, its support
// powers' notifications, ...), the speech and sound notifications
// (data/source/audio/notifications.yaml), the soundtrack
// (data/source/audio/music.yaml), the player and world notification settings
// (data/source/rules/player.yaml, world.yaml) and the texts of the
// notifications (data/source/rules.ftl).
//
// Only file NAMES are extracted; no audio is involved. The installer
// (apps/game/js/audio/install.js) looks these names up in the player's own
// Red Alert files.
//
//   node tools/gen-audio-catalog.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = `${root}data/source/`;
const weapons = JSON.parse(readFileSync(`${root}data/weapons.json`, 'utf8'));

// ---- MiniYaml (the parser of data/source/parse.py) ----------------------------------

/** MiniYaml text -> { key: [value, children] } (tabs nest, `#` starts a comment). */
export function parseMiniYaml(text) {
  const top = {};
  const stack = [[-1, top]];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart().startsWith('#') ? '' : raw.split('#', 1)[0].trimEnd();
    if (!line.trim()) continue;
    const depth = line.length - line.replace(/^\t+/, '').length;
    const s = line.trim();
    const at = s.indexOf(':');
    const k = (at < 0 ? s : s.slice(0, at)).trim();
    const v = at < 0 ? '' : s.slice(at + 1).trim();
    while (stack[stack.length - 1][0] >= depth) stack.pop();
    const node = [v, {}];
    stack[stack.length - 1][1][k] = node;
    stack.push([depth, node[1]]);
  }
  return top;
}

function clone(tree) {
  const out = {};
  for (const [k, [v, ch]] of Object.entries(tree)) out[k] = [v, clone(ch)];
  return out;
}

/** OpenRA's merge: `-Trait` removes, later values win, children merge. */
function merge(base, over) {
  const out = clone(base);
  for (const [k, [v, ch]] of Object.entries(over)) {
    if (k.startsWith('-')) {
      delete out[k.slice(1)];
    } else if (out[k]) {
      out[k] = [v !== '' ? v : out[k][0], merge(out[k][1], ch)];
    } else {
      out[k] = [v, merge({}, ch)];
    }
  }
  return out;
}

/** Every definition with its `Inherits` resolved (OpenRA's inheritance, as data/source/parse.py resolves it). */
function resolveAll(defs) {
  const cache = new Map();
  const resolve = (name, seen = []) => {
    if (cache.has(name)) return cache.get(name);
    if (seen.includes(name)) throw new Error(`inheritance cycle at ${name}`);
    // A parent outside data/source (e.g. ^Palettes of OpenRA's palettes.yaml) adds nothing sound related.
    if (!defs[name]) return {};
    let result = {};
    const own = {};
    for (const [k, node] of Object.entries(defs[name][1])) {
      if (k === 'Inherits' || k.startsWith('Inherits@')) result = merge(result, resolve(node[0], [...seen, name]));
      else own[k] = node;
    }
    result = merge(result, own);
    cache.set(name, result);
    return result;
  };
  return Object.fromEntries(Object.keys(defs).map((n) => [n, resolve(n)]));
}

/** A resolved tree as plain values: `{ Trait: { Field: 'value' } }` (a trait with a value and fields keeps it as `_`). */
function toJson(tree) {
  const out = {};
  for (const [k, [v, ch]] of Object.entries(tree)) {
    if (Object.keys(ch).length) out[k] = v !== '' ? { _: v, ...toJson(ch) } : toJson(ch);
    else out[k] = v;
  }
  return out;
}

const loadYaml = (path) => parseMiniYaml(readFileSync(path, 'utf8'));

// ---- Sources -----------------------------------------------------------------------------

const ruleFiles = readdirSync(`${SOURCE}rules`).filter((f) => f.endsWith('.yaml')).sort();
const defs = {};
for (const f of ruleFiles) Object.assign(defs, loadYaml(`${SOURCE}rules/${f}`));
const rules = resolveAll(defs);
const actorRules = Object.fromEntries(
  Object.entries(rules)
    .filter(([name]) => !name.startsWith('^'))
    .map(([name, tree]) => [name, toJson(tree)]),
);

/** Fluent strings of data/source/rules.ftl (only the notification texts are used). */
const ftl = {};
for (const line of readFileSync(`${SOURCE}rules.ftl`, 'utf8').split(/\r?\n/)) {
  const m = /^([a-z0-9-]+)\s*=\s*(.+)$/.exec(line);
  if (m) ftl[m[1]] = m[2].trim();
}
const text = (key) => (key ? (ftl[key] ?? null) : null);

/** "a.aud, b.aud" -> ['a', 'b'] (lowercase, extension dropped). */
const names = (v) =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim().toLowerCase().replace(/\.aud$/, ''))
        .filter(Boolean)
    : [];
const one = (v) => names(v)[0] ?? null;
const list = (v) =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
/** Traits named `name` or `name@suffix`, as [key, fields]. */
const traits = (t, name) => Object.entries(t).filter(([k, v]) => (k === name || k.startsWith(`${name}@`)) && v && typeof v === 'object');
const fields = (v) => (v && typeof v === 'object' ? v : {});
/** Drop null, empty strings, empty lists and empty objects. */
function compact(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const c = compact(v);
      if (Object.keys(c).length) out[k] = c;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---- Weapons --------------------------------------------------------------------------------

const isWater = (targets) => /\b(Water|Underwater)\b/.test(targets ?? '') && !/\bGround\b/.test(targets ?? '');

const weaponSounds = {};
for (const [name, w] of Object.entries(weapons)) {
  const impact = [];
  const water = [];
  for (const [key, h] of Object.entries(w)) {
    if (!key.startsWith('Warhead') || typeof h !== 'object' || !h.ImpactSounds) continue;
    (isWater(h.ValidTargets) ? water : impact).push(...names(h.ImpactSounds));
  }
  const entry = {};
  if (names(w.Report).length) entry.report = names(w.Report);
  if (impact.length) entry.impact = [...new Set(impact)];
  if (water.length) entry.water = [...new Set(water)];
  if (Object.keys(entry).length) weaponSounds[name] = entry;
}
const weaponByLower = Object.fromEntries(Object.keys(weapons).map((n) => [n.toLowerCase(), n]));

// ---- Support powers -----------------------------------------------------------------------

/** OpenRA's support power trait classes (the part of the key before `@`). */
const POWER_TRAITS = [
  'AirstrikePower',
  'ParatroopersPower',
  'NukePower',
  'ChronoshiftPower',
  'GrantExternalConditionPower',
  'GpsPower',
  'SpawnActorPower',
  'ProduceActorPower',
  'GrantPrerequisiteChargeDrainPower',
  'DropPodsPower',
  'AttackOrderPower',
  'IonCannonPower',
];

function powerSounds(t) {
  const out = {};
  for (const [key, raw] of Object.entries(t)) {
    if (!POWER_TRAITS.includes(key.split('@')[0])) continue;
    const p = fields(raw);
    out[key] = compact({
      kind: key.split('@')[0],
      // SupportPower.Charging / Charged (BeginCharge* and EndCharge*), to the owner.
      beginCharge: p.BeginChargeSpeechNotification,
      beginChargeText: text(p.BeginChargeTextNotification),
      beginChargeSound: one(p.BeginChargeSound),
      endCharge: p.EndChargeSpeechNotification,
      endChargeText: text(p.EndChargeTextNotification),
      endChargeSound: one(p.EndChargeSound),
      // SupportPowerInstance.Target and SupportPowersWidget.ClickIcon, to the owner.
      selectTarget: p.SelectTargetSpeechNotification,
      selectTargetText: text(p.SelectTargetTextNotification),
      selectTargetSound: one(p.SelectTargetSound),
      insufficientPower: p.InsufficientPowerSpeechNotification,
      insufficientPowerText: text(p.InsufficientPowerTextNotification),
      insufficientPowerSound: one(p.InsufficientPowerSound),
      // SupportPower.PlayLaunchSounds: allies of the owner hear Launch*, the others Incoming*.
      launch: p.LaunchSpeechNotification,
      launchText: text(p.LaunchTextNotification),
      launchSound: one(p.LaunchSound),
      incoming: p.IncomingSpeechNotification,
      incomingText: text(p.IncomingTextNotification),
      incomingSound: one(p.IncomingSound),
      // ParatroopersPower: when the first plane reaches the drop zone, to the owner.
      reinforcements: p.ReinforcementsArrivedSpeechNotification,
      reinforcementsText: text(p.ReinforcementsArrivedTextNotification),
      // GrantExternalConditionPower.OnFireSound, SpawnActorPower.DeploySound: at the target.
      onFire: one(p.OnFireSound),
      deploy: one(p.DeploySound),
    });
  }
  return out;
}

// ---- Actors ---------------------------------------------------------------------------------

const actorSounds = {};
for (const [id, t] of Object.entries(actorRules)) {
  const e = {};
  if (t.Voiced?.VoiceSet) e.voice = t.Voiced.VoiceSet;
  e.build = names(t.Building?.BuildSounds ?? t.BuildSounds);
  e.sell = names(t.Sellable?.SellSounds ?? t.Building?.UndeploySounds);
  if (t.Sellable) e.sellNotification = t.Sellable.Notification;
  // OpenRA Transforms (MCV deploy, Construction Yard pack up): TransformSounds
  // play as it transforms, together with a structure's Building.UndeploySounds
  // (Building.cs BeforeTransform); a refused deploy plays NoTransformSounds and
  // the NoTransformNotification speech line.
  if (t.Transforms) {
    e.transform = names(t.Transforms.TransformSounds);
    e.undeploy = names(t.Building?.UndeploySounds);
    e.noTransform = names(t.Transforms.NoTransformSounds);
    e.noTransformNotification = t.Transforms.NoTransformNotification;
  }
  // Death: SoundOnDamageTransition.DestroyedSounds and the death weapon's
  // explosion (FireWarheadsOnDeath); DamagedSounds play when it falls to Heavy.
  const sodt = traits(t, 'SoundOnDamageTransition').map(([, v]) => v);
  const death = new Set(sodt.flatMap((v) => names(v.DestroyedSounds)));
  const deathWeapon = weaponByLower[String(t.FireWarheadsOnDeath?.Weapon ?? '').toLowerCase()];
  for (const n of weaponSounds[deathWeapon]?.impact ?? []) death.add(n);
  e.death = [...death];
  e.damaged = [...new Set(sodt.flatMap((v) => names(v.DamagedSounds)))];
  // ActorLostNotification: its Notification (default UnitLost) to the owner.
  if (t.ActorLostNotification !== undefined) {
    const l = fields(t.ActorLostNotification);
    e.lost = { speech: l.Notification ?? 'UnitLost', text: text(l.TextNotification) };
  }
  if (t.Crushable) e.crush = one(t.Crushable.CrushSound);
  if (t.Parachutable) e.paraImpact = { ground: one(t.Parachutable.GroundImpactSound), water: one(t.Parachutable.WaterImpactSound) };
  e.chute = one(t.ParaDrop?.ChuteSound ?? t.ProductionParadrop?.ChuteSound);
  e.ejectChute = one(t.EjectOnDeath?.ChuteSound);
  const cloak = traits(t, 'Cloak')
    .map(([, v]) => v)
    .find((v) => v.CloakSound || v.UncloakSound);
  if (cloak) e.cloak = { on: one(cloak.CloakSound), off: one(cloak.UncloakSound) };
  e.rearm = one(
    traits(t, 'AmmoPool')
      .map(([, v]) => v.RearmSound)
      .find(Boolean),
  );
  if (t.GainsExperience) e.levelUp = { sound: t.GainsExperience.LevelUpNotification, text: text(t.GainsExperience.LevelUpTextNotification) };
  // CaptureNotification: Notification (default BuildingCaptured) to the new owner, LoseNotification to the old one.
  if (t.CaptureNotification !== undefined) {
    const c = fields(t.CaptureNotification);
    e.capture = {
      speech: c.Notification ?? 'BuildingCaptured',
      text: text(c.TextNotification),
      lose: c.LoseNotification,
      loseText: text(c.LoseTextNotification),
    };
  }
  // Infiltrates (the spy, the thief): Notification to the infiltrator's owner.
  e.infiltrates = traits(t, 'Infiltrates')
    .map(([, v]) => compact({ types: list(v.Types), speech: v.Notification, text: text(v.TextNotification) }))
    .filter((v) => v.speech || v.text);
  // InfiltrateFor*: InfiltratedNotification to the target's owner, InfiltrationNotification to the infiltrator's.
  e.infiltrated = Object.entries(t)
    .filter(([k]) => /^InfiltrateFor[A-Za-z]+(@|$)/.test(k))
    .map(([, raw]) => {
      const v = fields(raw);
      return compact({
        types: list(v.Types),
        speech: v.InfiltratedNotification,
        text: text(v.InfiltratedTextNotification),
        infiltration: v.InfiltrationNotification,
        infiltrationText: text(v.InfiltrationTextNotification),
      });
    })
    .filter((v) => v.speech || v.text || v.infiltration || v.infiltrationText);
  // RepairsUnits (Service Depot, naval yards): Start/FinishRepairingNotification to the unit's owner.
  const repairs = traits(t, 'RepairsUnits').map(([, v]) => v)[0];
  if (repairs) {
    e.repairs = {
      start: repairs.StartRepairingNotification,
      startText: text(repairs.StartRepairingTextNotification),
      finish: repairs.FinishRepairingNotification,
      finishText: text(repairs.FinishRepairingTextNotification),
    };
  }
  // RepairableBuilding: the Repair button's RepairingNotification.
  if (t.RepairableBuilding) e.repairing = t.RepairableBuilding.RepairingNotification;
  // PrimaryBuilding: SelectionNotification when the owner makes it primary.
  if (t.PrimaryBuilding) e.primary = { speech: t.PrimaryBuilding.SelectionNotification, text: text(t.PrimaryBuilding.SelectionTextNotification) };
  // ToggleConditionOnOrder (power down): the Sounds notifications of switching off and on.
  const toggle = traits(t, 'ToggleConditionOnOrder').map(([, v]) => v)[0];
  if (toggle) e.powerToggle = { off: toggle.EnabledSound, on: toggle.DisabledSound };
  e.powers = powerSounds(t);
  const c = compact(e);
  if (Object.keys(c).length) actorSounds[id] = c;
}

// ---- Crate actions (gameopts: crates) --------------------------------------------------------

/** CrateAction.Sound and Notification per crate action trait key, of every crate actor. */
const crateSounds = {};
for (const t of Object.values(actorRules)) {
  for (const [key, raw] of Object.entries(t)) {
    if (!/CrateAction(@|$)/.test(key)) continue;
    const v = fields(raw);
    const entry = compact({ sound: one(v.Sound), speech: v.Notification, text: text(v.TextNotification) });
    if (Object.keys(entry).length) crateSounds[key] = entry;
  }
}

// ---- Notifications ---------------------------------------------------------------------------

const notifications = loadYaml(`${SOURCE}audio/notifications.yaml`);
const speech = {};
for (const [name, [file]] of Object.entries(notifications.Speech[1].Notifications[1])) speech[name] = one(file) ?? '';
const soundNotifications = {};
for (const [name, [file, ch]] of Object.entries(notifications.Sounds[1].Notifications[1])) {
  const f = toJson(ch);
  soundNotifications[name] = {
    file: one(file) ?? '',
    volume: f.VolumeModifier !== undefined ? Number(f.VolumeModifier) : 1,
    // OpenRA SoundPool.InterruptType (default DoNotPlay).
    interrupt: f.InterruptType ?? 'DoNotPlay',
  };
}

// ---- Music --------------------------------------------------------------------------------------

/** music.yaml in order, with the group its `#` heading names (base game, Counterstrike, Aftermath). */
const musicTracks = [];
{
  let group = 'Red Alert';
  let current = null;
  for (const line of readFileSync(`${SOURCE}audio/music.yaml`, 'utf8').split(/\r?\n/)) {
    const heading = /^#\s*(\w+) tracks/.exec(line);
    if (heading) group = heading[1];
    const top = /^([^\s#][^:]*):\s*(.*)$/.exec(line);
    if (top) {
      current = { file: top[1].trim().toLowerCase(), title: top[2].trim(), volume: 1, hidden: false, group };
      musicTracks.push(current);
      continue;
    }
    const field = /^\t(\w+):\s*(.*)$/.exec(line);
    if (field && current) {
      if (field[1] === 'VolumeModifier') current.volume = Number(field[2]);
      if (field[1] === 'Hidden') current.hidden = field[2].trim().toLowerCase() === 'true';
    }
  }
}

// ---- Player and world -----------------------------------------------------------------------------

const player = toJson(rules.Player);
const world = toJson(rules.World);
const queues = {};
for (const [key, raw] of traits(player, 'ClassicProductionQueue').concat(traits(player, 'ProductionQueue'))) {
  const q = fields(raw);
  queues[q.Type ?? key.split('@')[1]] = compact({
    ready: q.ReadyAudio,
    readyText: text(q.ReadyTextNotification),
    blocked: q.BlockedAudio,
    blockedText: text(q.BlockedTextNotification),
    limited: q.LimitedAudio,
    limitedText: text(q.LimitedTextNotification),
    queued: q.QueuedAudio,
    queuedText: text(q.QueuedTextNotification),
    onHold: q.OnHoldAudio,
    onHoldText: text(q.OnHoldTextNotification),
    cancelled: q.CancelledAudio,
    cancelledText: text(q.CancelledTextNotification),
  });
}
const fieldOr = (v, d) => (v === undefined || v === '' ? d : v);
const damage = traits(player, 'DamageNotifier').map(([, v]) => v);
// C# defaults of the fields the yaml leaves out are written next to each value.
const playerNotifications = compact({
  queues,
  placeBuilding: {
    newOptions: player.PlaceBuilding?.NewOptionsNotification,
    newOptionsText: text(player.PlaceBuilding?.NewOptionsTextNotification),
    newOptionsDelay: Number(fieldOr(player.PlaceBuilding?.NewOptionsNotificationDelay, 10)),
    cannotPlace: player.PlaceBuilding?.CannotPlaceNotification,
    cannotPlaceText: text(player.PlaceBuilding?.CannotPlaceTextNotification),
  },
  objectives: {
    win: player.MissionObjectives?.WinNotification,
    winText: text(player.MissionObjectives?.WinTextNotification),
    lose: player.MissionObjectives?.LoseNotification,
    loseText: text(player.MissionObjectives?.LoseTextNotification),
    leave: player.MissionObjectives?.LeaveNotification,
    leaveText: text(player.MissionObjectives?.LeaveTextNotification),
  },
  // PowerManager.AdviceInterval (ms, default 10000).
  lowPower: { speech: player.PowerManager?.SpeechNotification, text: text(player.PowerManager?.TextNotification), interval: Number(fieldOr(player.PowerManager?.AdviceInterval, 10000)) },
  // PlayerResources.InsufficientFundsNotificationInterval (ms, default 30000).
  funds: {
    speech: player.PlayerResources?.InsufficientFundsNotification,
    text: text(player.PlayerResources?.InsufficientFundsTextNotification),
    interval: Number(fieldOr(player.PlayerResources?.InsufficientFundsNotificationInterval, 30000)),
    cashUp: player.PlayerResources?.CashTickUpNotification,
    cashDown: player.PlayerResources?.CashTickDownNotification,
  },
  // ResourceStorageWarning: AdviceInterval 20000 ms, Threshold 80 percent, Notification SilosNeeded.
  silos: player.ResourceStorageWarning !== undefined && {
    speech: fieldOr(fields(player.ResourceStorageWarning).Notification, 'SilosNeeded'),
    text: text(fields(player.ResourceStorageWarning).TextNotification),
    interval: Number(fieldOr(fields(player.ResourceStorageWarning).AdviceInterval, 20000)),
    threshold: Number(fieldOr(fields(player.ResourceStorageWarning).Threshold, 80)),
  },
  // DamageNotifier: the structures one speaks (NotifyInterval ms, default 30000).
  baseAttack: damage
    .filter((d) => d.Notification)
    .map((d) => ({ speech: d.Notification, text: text(d.TextNotification), allyText: text(d.AllyTextNotification), interval: Number(fieldOr(d.NotifyInterval, 30000)) }))[0],
});
const sgn = fields(world.StartGameNotification);
const tl = fields(world.TimeLimitManager);
const worldNotifications = compact({
  // StartGameNotification: Notification StartGame, LoadedNotification GameLoaded, SavedNotification GameSaved by default.
  startGame: world.StartGameNotification !== undefined && {
    speech: fieldOr(sgn.Notification, 'StartGame'),
    text: text(sgn.TextNotification),
    loaded: fieldOr(sgn.LoadedNotification, 'GameLoaded'),
    loadedText: text(sgn.LoadedTextNotification),
    saved: fieldOr(sgn.SavedNotification, 'GameSaved'),
    savedText: text(sgn.SavedTextNotification),
  },
  // MusicPlaylist: background music after the game ends (winner, everyone else).
  music: { victory: world.MusicPlaylist?.VictoryMusic, defeat: world.MusicPlaylist?.DefeatMusic, starting: world.MusicPlaylist?.StartingMusic, background: world.MusicPlaylist?.BackgroundMusic },
  // TimeLimitManager.TimeLimitWarnings: minutes remaining -> speech notification.
  timeLimitWarnings: tl.TimeLimitWarnings,
});

const json = (v) => JSON.stringify(v, null, 2);
const out = `// Generated by tools/gen-audio-catalog.mjs from data/weapons.json,
// data/source/rules, data/source/audio and data/source/rules.ftl (OpenRA
// mods/ra). Do not edit by hand.
//
// Original Red Alert sound file NAMES (no audio): used to find sounds in the
// player's own installed game files (install.js), and the notification names
// and texts OpenRA plays for each event.

export const WEAPON_SOUNDS = ${json(weaponSounds)};

export const ACTOR_SOUNDS = ${json(actorSounds)};

/** Crate action sounds (CrateAction Sound, Notification, TextNotification) by trait key. */
export const CRATE_SOUNDS = ${json(crateSounds)};

/** Speech notifications (notifications.yaml Speech): name -> speech.mix file ('' when it has none). */
export const SPEECH = ${json(speech)};

/** Sound notifications (notifications.yaml Sounds): name -> { file, volume, interrupt }. */
export const SOUND_NOTIFICATIONS = ${json(soundNotifications)};

/** The soundtrack (music.yaml) in its order: { file, title, volume, hidden, group }. */
export const MUSIC_TRACKS = ${json(musicTracks)};

/** Player notifications (player.yaml: production queues, power, funds, silos, objectives). */
export const PLAYER_NOTIFICATIONS = ${json(playerNotifications)};

/** World notifications (world.yaml: game start, saves, music playlist, time limit). */
export const WORLD_NOTIFICATIONS = ${json(worldNotifications)};
`;
writeFileSync(`${root}apps/game/js/audio/catalog-data.js`, out);
console.log(
  `wrote ${Object.keys(weaponSounds).length} weapons, ${Object.keys(actorSounds).length} actors, ${Object.keys(speech).length} speech and ${Object.keys(soundNotifications).length} sound notifications, ${musicTracks.length} music tracks`,
);
