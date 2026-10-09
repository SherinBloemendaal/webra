// Generates apps/game/js/audio/catalog-data.js from the OpenRA rules dump in
// data/ (weapons.json, actors.json) and OpenRA's voice sets
// (data/source/audio/voices.yaml): which original sound file names (Report,
// ImpactSounds, BuildSounds, TransformSounds, voice lines, ...) belong to each
// weapon and actor, and which voice line each order and death plays.
// Only file NAMES are extracted; no audio is involved. The installer
// (apps/game/js/audio/install.js) looks these names up in the player's own
// Red Alert files.
//
//   node tools/gen-audio-catalog.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const weapons = JSON.parse(readFileSync(`${root}data/weapons.json`, 'utf8'));
const actors = JSON.parse(readFileSync(`${root}data/actors.json`, 'utf8'));

/** "a.aud, b.aud" -> ['a', 'b'] (lowercase, extension dropped). */
const names = (v) =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim().toLowerCase().replace(/\.aud$/, ''))
        .filter(Boolean)
    : [];

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

const actorSounds = {};
for (const a of actors) {
  const t = a.traits ?? {};
  const entry = {};
  if (t.Voiced?.VoiceSet) entry.voice = t.Voiced.VoiceSet;
  const build = names(t.Building?.BuildSounds ?? t.BuildSounds);
  if (build.length) entry.build = build;
  const sell = names(t.Sellable?.SellSounds ?? t.Building?.UndeploySounds);
  if (sell.length) entry.sell = sell;
  // OpenRA Transforms (MCV deploy, Construction Yard pack up): TransformSounds
  // play as it transforms, together with a structure's Building.UndeploySounds
  // (Building.cs BeforeTransform); a refused deploy plays NoTransformSounds and
  // the NoTransformNotification speech line.
  if (t.Transforms) {
    const transform = names(t.Transforms.TransformSounds);
    if (transform.length) entry.transform = transform;
    const undeploy = names(t.Building?.UndeploySounds);
    if (undeploy.length) entry.undeploy = undeploy;
    const blocked = names(t.Transforms.NoTransformSounds);
    if (blocked.length) entry.noTransform = blocked;
    if (t.Transforms.NoTransformNotification) entry.noTransformNotification = t.Transforms.NoTransformNotification;
  }
  const death = new Set(names(t.SoundOnDamageTransition?.DestroyedSounds));
  const dw = t.FireWarheadsOnDeath?.Weapon;
  for (const n of weaponSounds[dw]?.impact ?? []) death.add(n);
  if (death.size) entry.death = [...death];
  // Voice lines of orders (OpenRA IOrderVoice: the trait's Voice, default Action).
  const voiceOf = (trait, fallback = 'Action') => (t[trait] === undefined ? null : (t[trait]?.Voice ?? fallback));
  const orders = {
    move: voiceOf('Mobile'),
    attack: voiceOf('AttackFrontal') ?? voiceOf('AttackLeap') ?? voiceOf('AttackTurreted'),
    capture: voiceOf('Captures'),
    infiltrate: voiceOf('Infiltrates'),
    demolish: voiceOf('Demolition'),
    repair: voiceOf('InstantlyRepairs'),
    disguise: voiceOf('Disguise'),
  };
  for (const [k, v] of Object.entries(orders)) if (!v) delete orders[k];
  if (entry.voice && Object.keys(orders).length) entry.orders = orders;
  // VoiceAnnouncement (Tanya's laugh when she leaves the barracks) and AnnounceOnKill.
  if (t.VoiceAnnouncement) entry.produced = t.VoiceAnnouncement.Voice ?? 'Action';
  if (t.AnnounceOnKill !== undefined) entry.kill = t.AnnounceOnKill?.Voice ?? 'Kill';
  // DeathSounds per death sequence (WithDeathAnimation DeathTypes): which voice line screams.
  const deathTypes = t.WithDeathAnimation?.DeathTypes;
  if (deathTypes && entry.voice) {
    const screams = {};
    for (const [key, ds] of Object.entries(t)) {
      if (!key.startsWith('DeathSounds')) continue;
      const types = (ds?.DeathTypes ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      for (const type of types) if (deathTypes[type]) screams[deathTypes[type]] = ds?.Voice ?? 'Die';
    }
    if (Object.keys(screams).length) entry.screams = screams;
  }
  if (Object.keys(entry).length) actorSounds[a.id] = entry;
}

/** OpenRA MiniYaml (tabs) of voices.yaml as nested objects. */
function miniYaml(text) {
  const root = {};
  const stack = [{ depth: -1, node: root }];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const depth = line.length - line.replace(/^\t+/, '').length;
    const [k, ...rest] = line.trim().split(':');
    while (stack[stack.length - 1].depth >= depth) stack.pop();
    const node = { _: rest.join(':').trim() };
    stack[stack.length - 1].node[k.trim()] = node;
    stack.push({ depth, node });
  }
  return root;
}

const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const voiceSets = {};
for (const [name, set] of Object.entries(miniYaml(readFileSync(`${root}data/source/audio/voices.yaml`, 'utf8')))) {
  const lines = {};
  for (const [line, v] of Object.entries(set.Voices ?? {})) if (line !== '_') lines[line.toLowerCase()] = list(v._);
  const variants = {};
  for (const [faction, v] of Object.entries(set.Variants ?? {})) if (faction !== '_') variants[faction] = list(v._);
  voiceSets[name] = { lines, variants, plain: list(set.DisableVariants?._).map((x) => x.toLowerCase()) };
}

const out = `// Generated by tools/gen-audio-catalog.mjs from data/weapons.json and
// data/actors.json (OpenRA mods/ra rules). Do not edit by hand.
//
// Original Red Alert sound file NAMES per weapon and actor (no audio): used to
// find sounds in the player's own installed game files (install.js).

export const WEAPON_SOUNDS = ${JSON.stringify(weaponSounds, null, 2)};

export const ACTOR_SOUNDS = ${JSON.stringify(actorSounds, null, 2)};

// OpenRA voice sets (mods/ra/audio/voices.yaml): lines (lowercase) -> file
// bases, per-faction file extensions, and lines that never use them.
export const VOICE_SETS = ${JSON.stringify(voiceSets, null, 2)};
`;
writeFileSync(`${root}apps/game/js/audio/catalog-data.js`, out);
console.log(`wrote ${Object.keys(weaponSounds).length} weapons, ${Object.keys(actorSounds).length} actors, ${Object.keys(voiceSets).length} voice sets`);
