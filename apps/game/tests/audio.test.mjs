// Game audio (js/audio): event mapping, throttling, the voice budget,
// settings, the content installer, synthesized sounds, and the engine's audio
// events through the WebAssembly API.
//   node --test apps/game/tests/audio.test.mjs   (after npm run build:wasm)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { Director, EV, STRIDE, spatial, MAX_EFFECTS_PER_FRAME, MAX_SAME_PER_FRAME, VOICE_GAP } from '../js/audio/director.js';
import { Announcer } from '../js/audio/announcer.js';
import { Prefs, sanitizePrefs, busGain, DEFAULT_PREFS } from '../js/audio/prefs.js';
import { createRegistry, REGISTRY_KEY } from '../js/registry.js';
import {
  WEAPON_SYNTH,
  fireSound,
  impactSound,
  deathSound,
  placeSound,
  transformSounds,
  deployBlocked,
  voiceLine,
  EVA,
  allOriginalNames,
  fileName,
  MUSIC,
  PLAYLIST,
  BACKGROUND_MUSIC,
  MUSIC_FILES,
  SOUND_SYNTH,
  notificationSound,
  speechKey,
  queueLine,
  lostLine,
  captureLines,
  infiltrationLines,
  repairLines,
  powerNotifications,
  damagedSound,
  crushSound,
  chuteSound,
  cloakSound,
  rearmSound,
  spokenText,
  QUEUE_NAMES,
} from '../js/audio/catalog.js';
import { WEAPON_SOUNDS, ACTOR_SOUNDS, SPEECH, SOUND_NOTIFICATIONS, MUSIC_TRACKS } from '../js/audio/catalog-data.js';
import { RECIPES, render } from '../js/audio/synth.js';
import { installFromFiles, installedSummary, categoryOf } from '../js/audio/install.js';
import { MemoryStore } from '../js/audio/store.js';
import { SoundBank } from '../js/audio/bank.js';
import { shuffle, Jukebox } from '../js/audio/music.js';
import { AudioSystem, FOG_VISIBLE, CLICKABLE } from '../js/audio/index.js';
import { sineSamples, imaAud, buildMix, buildEncryptedMix, testRsaKey } from './audio-fixtures.mjs';

const wasm = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));
initSync({ module: readFileSync(wasm) });
const engineRules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));

// ---- Helpers ----------------------------------------------------------------------

// Queue indices: engine/src/rules.rs QueueType (Building 0, Defense 1, Infantry 2, Vehicle 3, Aircraft 4, Ship 5).
const RULES = {
  actors: [
    { id: 'E1', kind: 'infantry', queue: 2 },
    { id: '1TNK', kind: 'vehicle', queue: 3 },
    { id: 'POWR', kind: 'building', queue: 0 },
    { id: 'DD', kind: 'ship', queue: 5 },
    { id: 'MSLO', kind: 'building', queue: 1, powers: ['NukePower'] },
    { id: 'AFLD', kind: 'building', queue: 0, powers: ['AirstrikePower@spyplane', 'ParatroopersPower@paratroopers', 'AirstrikePower@parabombs'] },
    { id: 'FIX', kind: 'building', queue: 0 },
    { id: 'MIG', kind: 'aircraft', queue: 4 },
    { id: 'SS', kind: 'ship', queue: 5 },
    { id: 'STNK', kind: 'vehicle', queue: 3 },
    { id: 'PROC', kind: 'building', queue: 0 },
    { id: 'THF', kind: 'infantry', queue: 2 },
    { id: 'BADR', kind: 'aircraft', queue: 4 },
    { id: 'MNLY', kind: 'vehicle', queue: 3 },
    { id: 'ATEK', kind: 'building', queue: 0, powers: ['GpsPower'] },
    { id: 'BRIK', kind: 'building', queue: 1 },
  ],
  weapons: ['M1Carbine', '25mm', 'Atomic', 'TorpTube'],
};
/** Actor indices of RULES. */
const T = Object.fromEntries(RULES.actors.map((a, i) => [a.id, i]));
/** sound_events.rs power_ref. */
const powerRef = (provider, index) => (T[provider] << 8) | index;
const VIEW = { x0: 0, y0: 0, x1: 1000, y1: 600 };

function harness({ player = 0, actors = {}, allied = (owner) => owner === player } = {}) {
  let t = 100;
  const calls = { effects: [], voices: [], announce: [], notify: [] };
  const sink = {
    effect: (sound, opts) => calls.effects.push({ sound, ...opts }),
    voice: (line) => calls.voices.push(line),
    announce: (key) => calls.announce.push(key),
    notify: (name) => calls.notify.push(name),
  };
  const d = new Director({
    rules: RULES,
    player,
    side: 'allies',
    pxPerWorld: 1,
    lookup: (id) => actors[id] ?? null,
    sink,
    now: () => t,
    allied,
  });
  return { d, calls, advance: (s) => (t += s) };
}

const ev = (...events) => events.flat();
const fire = (w, x, y, owner = 0) => [EV.FIRE, w, x, y, owner, 0];

// ---- Catalog ----------------------------------------------------------------------

test('every engine weapon has a sound class, and synthesized sounds exist for all of them', () => {
  for (const w of engineRules.weapons) assert.ok(WEAPON_SYNTH[w.name], `${w.name} has a sound class`);
  for (const [fireId, impactId] of Object.values(WEAPON_SYNTH)) {
    for (const id of [fireId, impactId]) if (id) assert.ok(RECIPES[id], `${id} is synthesized`);
  }
  for (const e of Object.values(EVA)) if (!e.textOnly) assert.ok(RECIPES[e.chime], `${e.chime} chime`);
  for (const [name, id] of Object.entries(SOUND_SYNTH)) if (id) assert.ok(RECIPES[id], `${name}: ${id} is synthesized`);
  for (const id of ['radio_ack', 'radio_select', 'radio_open', 'radio_close', 'place_building', 'sell', 'explosion_building', 'infantry_die']) {
    assert.ok(RECIPES[id], id);
  }
});

test('weapons map to their original OpenRA sound names', () => {
  assert.deepEqual(fireSound('90mm'), { synth: 'cannon', originals: ['cannon1.aud'] });
  assert.deepEqual(fireSound('M1Carbine').originals, ['gun11.aud']);
  assert.deepEqual(impactSound('90mm', false).originals, ['kaboom12.aud']);
  assert.deepEqual(impactSound('90mm', true), { synth: 'splash', originals: ['splash9.aud'] });
  assert.equal(impactSound('M1Carbine', true).synth, 'splash_small');
  assert.equal(fireSound('Atomic').synth, null, 'no fire sound for a warhead');
  assert.equal(impactSound('Atomic', false).synth, 'explosion_huge');
  assert.deepEqual(deathSound('POWR', 'building').originals, ['kaboom22.aud']);
  assert.equal(deathSound('E1', 'infantry').synth, 'infantry_die');
  assert.equal(WEAPON_SOUNDS.TeslaZap.report[0], 'tesla1', 'generated from data/weapons.json');
});

test('unit voices use per-side variants and spoken fallbacks', () => {
  const allied = voiceLine('E1', 'infantry', 'allies', 'action');
  assert.ok(allied.originals.includes('ackno.v01') && allied.originals.includes('roger.v03'));
  assert.ok(allied.originals.every((n) => /\.v0[13]$/.test(n)));
  const soviet = voiceLine('3TNK', 'vehicle', 'soviet', 'select');
  assert.ok(soviet.originals.includes('vehic1.r00'));
  assert.ok(soviet.originals.every((n) => /\.r0[02]$/.test(n)));
  assert.equal(soviet.synth, 'radio_select');
  assert.ok(allied.spoken.includes('Affirmative') && allied.spoken.includes('Moving out'));
  assert.ok(voiceLine('E1', 'infantry', 'allies', 'select').spoken.includes('Reporting'));
});

test('announcer lines and the wanted file list', () => {
  assert.deepEqual(EVA.constructionComplete.originals, ['conscmp1.aud']);
  // Every speech notification of OpenRA's notifications.yaml is a line, keyed by its name.
  for (const [name, file] of Object.entries(SPEECH)) {
    const line = EVA[speechKey(name)];
    assert.ok(line?.text, name);
    assert.deepEqual(line.originals, file ? [`${file}.aud`] : [], name);
  }
  for (const key of ['building', 'training', 'onHold', 'cancelled', 'noBuild', 'buildingInProgress', 'unitReady', 'insufficientFunds', 'insufficientPower', 'lowPower', 'silosNeeded', 'baseAttack', 'unitLost', 'airUnitLost', 'navalUnitLost', 'structureSold', 'selectTarget', 'newOptions', 'reinforcementsArrived', 'satelliteLaunched', 'spyPlaneReady', 'sonarPulseReady', 'abombPrepping', 'abombReady', 'abombLaunchDetected', 'ironCurtainCharging', 'ironCurtainReady', 'chronosphereCharging', 'chronosphereReady', 'buildingCaptured', 'buildingInfiltrated', 'creditsStolen', 'unitStolen', 'unitRepaired', 'primaryBuildingSelected', 'startGame', 'leave', 'gameSaved', 'gameLoaded', 'win', 'lose']) {
    assert.ok(EVA[key]?.text && EVA[key].originals.length === 1, key);
  }
  assert.equal(EVA.insufficientPower.text, 'Insufficient power.', "OpenRA's text notification");
  assert.equal(EVA.leave.originals[0], 'bct1.aud');
  assert.equal(spokenText('AlliedForcesApproaching'), 'Allied forces approaching.', 'campaign lines get a text from their name');
  assert.equal(speechKey('HarvesterAttack'), 'harvesterAttack', 'an empty line still has a key (it stays silent)');
  assert.deepEqual(EVA.harvesterAttack.originals, []);
  assert.equal(speechKey(null), null);
  assert.ok(EVA.unitPromoted.textOnly && EVA.allyUnderAttack.textOnly, 'text notifications without speech');
  const names = allOriginalNames();
  for (const n of ['conscmp1.aud', 'cannon1.aud', 'ackno.v01', 'vehic1.r02', 'hell226m.aud', 'placbldg.aud', 'cashturn.aud', 'onhold1.aud', 'nobuild1.aud', 'radaron2.aud', 'radardn1.aud', 'hydrod1.aud', 'ramenu1.aud', 'rabeep1.aud', 'bleep17.aud', 'buzzy1.aud', 'squishy2.aud', 'chute1.aud', 'subshow1.aud', 'appear1.aud', 'minelay1.aud', 'kaboom1.aud', 'sandbag2.aud', 'crmble2.aud', 'araziod.aud', 'wastelnd.aud', 'score.aud', 'intro.aud', 'map.aud']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.equal(fileName('ACKNO.V01'), 'ackno.v01');
  assert.equal(categoryOf('conscmp1.aud'), 'announcer');
  assert.equal(categoryOf('ackno.r00'), 'voices');
  assert.equal(categoryOf(MUSIC[0].file), 'music');
  assert.equal(categoryOf('kaboom12.aud'), 'effects');
});

// ---- Positional sound and the voice budget ----------------------------------------------

test('sounds pan with position, fade at the edges and are culled far away', () => {
  assert.deepEqual(spatial(500, 300, VIEW), { gain: 1, pan: 0 });
  const left = spatial(0, 300, VIEW);
  assert.ok(left.pan < -0.7 && Math.abs(left.gain - 0.5) < 1e-9, 'half volume at the view edge, panned left');
  assert.ok(spatial(1000, 300, VIEW).pan > 0.7);
  assert.equal(spatial(-400, 300, VIEW), null, 'far offscreen is culled');
  assert.ok(spatial(-400, 300, VIEW, 6), 'a large reach (nukes) is heard further');
});

test('a battle of thousands of shots stays within the per-frame budget', () => {
  const { d, calls } = harness();
  const events = [];
  for (let i = 0; i < 3000; i++) events.push(...fire(i % 2, (i * 37) % 1000, (i * 53) % 600, i % 3));
  for (let i = 0; i < 500; i++) events.push(EV.IMPACT, 1, (i * 13) % 1000, (i * 7) % 600, 1, 0);
  d.onEvents(Int32Array.from(events), VIEW);
  assert.ok(calls.effects.length <= MAX_EFFECTS_PER_FRAME, `${calls.effects.length} effects`);
  const bySound = new Map();
  for (const e of calls.effects) bySound.set(e.sound.synth, (bySound.get(e.sound.synth) ?? 0) + 1);
  for (const [id, n] of bySound) assert.ok(n <= MAX_SAME_PER_FRAME, `${id} started ${n} times`);
  assert.ok(calls.effects.every((e) => e.gain > 0 && e.gain <= 1));
  assert.ok(calls.effects.some((e) => e.sound.synth === 'explosion_small'), 'explosions outrank rifles');
});

test('the same sound does not restart within a few milliseconds', () => {
  const { d, calls, advance } = harness();
  d.onEvents(ev(fire(0, 500, 300)), VIEW);
  d.onEvents(ev(fire(0, 500, 300)), VIEW);
  assert.equal(calls.effects.length, 1);
  advance(0.1);
  d.onEvents(ev(fire(0, 500, 300)), VIEW);
  assert.equal(calls.effects.length, 2);
});

test('offscreen and fogged enemy sounds are not heard; own ones in fog are', () => {
  const { d, calls } = harness();
  d.onEvents(ev(fire(0, 5000, 300, 1)), VIEW);
  assert.equal(calls.effects.length, 0, 'far away');
  const fog = () => false;
  d.onEvents(ev(fire(0, 500, 300, 1)), VIEW, fog);
  assert.equal(calls.effects.length, 0, 'enemy under fog');
  d.onEvents(ev(fire(1, 500, 300, 0)), VIEW, fog);
  assert.equal(calls.effects.length, 1, 'own unit');
});

// ---- Announcements and replies ---------------------------------------------------------

test('engine events become announcements for the local player only', () => {
  const { d, calls } = harness({ player: 0 });
  d.onEvents(
    ev(
      [EV.UNIT_PRODUCED, 1, 0, 0, 0, 0],
      [EV.UNIT_PRODUCED, 1, 0, 0, 1, 0],
      [EV.CONSTRUCTION_READY, 2, 0, 0, 0, 0],
      [EV.INSUFFICIENT_FUNDS, 1, 0, 0, 0, 0],
      [EV.SOLD, 2, 500, 300, 0, 0],
      [EV.BUILDING_DAMAGED, 2, 500, 300, 0, 1],
      [EV.BUILDING_DAMAGED, 2, 500, 300, 1, 0],
      [EV.DEATH, 1, 500, 300, 0, 2],
      [EV.DEATH, 2, 500, 300, 0, 0],
      [EV.DEATH, 0, 500, 300, 1, 1],
      [EV.POWER_ACTIVATED, 1, 500, 300, 1, powerRef('MSLO', 0)],
    ),
    VIEW,
  );
  assert.deepEqual(calls.announce, ['unitReady', 'constructionComplete', 'insufficientFunds', 'structureSold', 'baseAttack', 'unitLost', 'abombLaunchDetected']);
  const synths = calls.effects.map((e) => e.sound.synth);
  assert.ok(synths.includes('sell') && synths.includes('explosion_building') && synths.includes('infantry_die'));
});

test('announcements respect their cooldowns', () => {
  const { d, calls, advance } = harness();
  const attack = ev([EV.BUILDING_DAMAGED, 2, 0, 0, 0, 1]);
  d.onEvents(attack, VIEW);
  advance(5);
  d.onEvents(attack, VIEW);
  assert.equal(calls.announce.length, 1, 'base under attack is throttled');
  assert.equal(EVA.baseAttack.cooldown, 30, 'OpenRA DamageNotifier NotifyInterval');
  assert.equal(EVA.insufficientFunds.cooldown, 30, 'OpenRA InsufficientFundsNotificationInterval');
  advance(EVA.baseAttack.cooldown);
  d.onEvents(attack, VIEW);
  assert.equal(calls.announce.length, 2);
  d.onEvents(ev([EV.DEATH, 1, 0, 0, 0, 2]), VIEW);
  d.onEvents(ev([EV.DEATH, 1, 0, 0, 0, 2]), VIEW);
  assert.equal(calls.announce.filter((k) => k === 'unitLost').length, 1);
});

test('one reply per order, and a report on every selection the player makes (OpenRA)', () => {
  const actors = {
    11: { type: 'E1', owner: 0, building: false },
    12: { type: '1TNK', owner: 0, building: false },
    13: { type: '1TNK', owner: 1, building: false },
    14: { type: 'POWR', owner: 0, building: true },
  };
  const { d, calls, advance } = harness({ actors });
  d.onOrder([13, 11, 12]);
  assert.equal(calls.voices.length, 1);
  assert.ok(calls.voices[0].originals.includes('ackno.v01'), 'the first own unit (rifleman) answers');
  d.onOrder([11]);
  assert.equal(calls.voices.length, 1, 'throttled');
  advance(VOICE_GAP);
  d.onOrder([13, 14]);
  assert.equal(calls.voices.length, 1, 'enemies and structures do not answer');
  d.onSelection([12]);
  assert.equal(calls.voices.length, 2);
  assert.equal(calls.voices[1].synth, 'radio_select');
  advance(1);
  d.onSelection([12]);
  assert.equal(calls.voices.length, 3, 'selecting the same unit again reports again');
  advance(1);
  d.onSelection([12], { byPlayer: false });
  d.onSelection([], { byPlayer: true });
  assert.equal(calls.voices.length, 3, 'units dropping out and an empty selection are silent');
  d.onSelection([12, 11]);
  d.onSelection([11]);
  assert.equal(calls.voices.length, 4, 'quick clicks are throttled');
  advance(VOICE_GAP);
  d.onSelection([13, 14]);
  assert.equal(calls.voices.length, 4, 'enemy units and structures do not report');
});

test('production clicks say what OpenRA says, with the click sound', () => {
  const { d, calls, advance } = harness();
  const clicks = [
    ['E1', 'queued', 'training'],
    ['POWR', 'queued', 'building'],
    ['1TNK', 'queued', 'building'],
    ['E1', 'onHold', 'onHold'],
    ['E1', 'resumed', 'training'],
    ['E1', 'cancelled', 'cancelled'],
    ['MSLO', 'blocked', 'noBuild'],
    ['POWR', 'limited', 'buildingInProgress'],
  ];
  for (const [id, outcome, line] of clicks) {
    advance(5);
    calls.announce.length = 0;
    d.onProductionClick(id, outcome);
    assert.deepEqual(calls.announce, [line], `${id} ${outcome}`);
  }
  advance(5);
  calls.announce.length = 0;
  d.onProductionClick('E1', null);
  assert.deepEqual(calls.announce, [], 'a click on a busy queue only clicks');
  assert.equal(calls.notify.length, clicks.length + 1);
  assert.ok(calls.notify.every((n) => n === 'ClickSound'));
  for (const [q, name] of QUEUE_NAMES.entries()) assert.ok(queueLine(q, 'ready'), `${name} has a ready line`);
});

test('support powers: charging, ready, target and insufficient power lines per power', () => {
  const { d, calls, advance } = harness();
  d.onEvents(
    ev(
      [EV.POWER_CHARGING, T.MSLO, 0, 0, 0, 0],
      [EV.POWER_READY, T.MSLO, 0, 0, 0, 0],
      [EV.POWER_READY, T.AFLD, 0, 0, 0, 0],
      [EV.POWER_READY, T.AFLD, 0, 0, 0, 1],
      [EV.POWER_CHARGING, T.MSLO, 0, 0, 1, 0],
    ),
    VIEW,
  );
  assert.deepEqual(calls.announce, ['abombPrepping', 'abombReady', 'spyPlaneReady'], 'the paratroopers have no ready line; not the enemy');
  calls.announce.length = 0;
  d.onSelectTarget({ key: 'NukePower', kind: 'NukePower' });
  advance(2);
  d.onInsufficientPower({ key: 'NukePower' });
  assert.deepEqual(calls.announce, ['selectTarget', 'insufficientPower']);
  calls.announce.length = 0;
  // Launches: the GPS satellite to the owner and allies, the nuke's warning to everyone else.
  d.onEvents(ev([EV.POWER_ACTIVATED, 6, 0, 0, 0, powerRef('ATEK', 0)], [EV.POWER_ACTIVATED, 1, 0, 0, 0, powerRef('MSLO', 0)]), VIEW);
  assert.deepEqual(calls.announce, ['satelliteLaunched'], 'no speech for an own nuke');
  calls.announce.length = 0;
  d.onEvents(ev([EV.REINFORCEMENTS_ARRIVED, T.AFLD, 0, 0, 0, 1]), VIEW);
  assert.deepEqual(calls.announce, ['reinforcementsArrived']);
  assert.equal(powerNotifications('PDOX', 'ChronoshiftPower@chronoshift').beginChargeLine, 'chronosphereCharging');
  assert.equal(powerNotifications('IRON', 'GrantExternalConditionPower@IRONCURTAIN').endChargeLine, 'ironCurtainReady');
});

test('low power repeats every AdviceInterval, silos are checked every 20 seconds (OpenRA)', () => {
  const { d, calls, advance } = harness();
  d.onPlayerState({ lowPower: false, resources: 0, storage: 1000 });
  d.onPlayerState({ lowPower: true });
  assert.deepEqual(calls.announce, ['lowPower'], 'at once when power gets low');
  advance(5);
  d.onPlayerState({ lowPower: true });
  advance(5);
  d.onPlayerState({ lowPower: true });
  assert.deepEqual(calls.announce, ['lowPower', 'lowPower'], 'again after 10 seconds');
  d.onPlayerState({ lowPower: false });
  calls.announce.length = 0;
  advance(21);
  d.onPlayerState({ lowPower: false, resources: 900, storage: 1000 });
  assert.deepEqual(calls.announce, ['silosNeeded'], 'over 80 percent full');
  advance(21);
  d.onPlayerState({ lowPower: false, resources: 700, storage: 1000 });
  assert.equal(calls.announce.length, 1, 'enough room');
});

test('actor sounds and notifications of the rules play to the right player', () => {
  const { d, calls } = harness({ allied: (o) => o === 0 || o === 2 });
  const of = (synth) => calls.effects.filter((e) => e.sound.synth === synth);
  d.onEvents(
    ev(
      // A crushed rifleman: the crush, no death scream.
      [EV.CRUSHED, T.E1, 500, 300, 1, 0],
      [EV.DEATH, T.E1, 510, 300, 1, 1],
      [EV.DAMAGE_HEAVY, T.POWR, 500, 300, 0, 0],
      [EV.DAMAGE_HEAVY, T['1TNK'], 500, 300, 0, 0],
      [EV.CLOAK_CHANGED, T.STNK, 500, 300, 1, 1],
      [EV.PARA_DROP, T.BADR, 500, 300, 0, 0],
      [EV.PILOT_EJECTED, T.MIG, 500, 300, 0, 0],
      [EV.REARMED, T.MNLY, 500, 300, 1, 0],
    ),
    VIEW,
  );
  assert.equal(of('crush').length, 1);
  assert.equal(of('infantry_die').length, 0, 'crushing has no death scream');
  assert.deepEqual(of('damaged')[0].sound.originals, ['kaboom1.aud'], 'only actors with DamagedSounds');
  assert.equal(of('damaged').length, 1);
  assert.deepEqual(of('cloak')[0].sound.originals, ['appear1.aud']);
  assert.deepEqual(of('chute')[0].sound.originals, ['chute1.aud']);
  assert.equal(of('chute').length, 2, "the Badger's drop and the MiG pilot's EjectOnDeath.ChuteSound");
  assert.equal(of('rearm').length, 0, "an enemy's rearm is PlayToPlayer");
  d.onEvents(
    ev(
      [EV.LEVEL_UP, T.E1, 0, 0, 0, 0],
      [EV.DEATH, T.MIG, 0, 0, 0, 4],
      [EV.DEATH, T.SS, 0, 0, 0, 3],
      [EV.UNIT_REPAIR_STARTED, T['1TNK'], 0, 0, 0, T.FIX],
      [EV.UNIT_REPAIRED, T['1TNK'], 0, 0, 0, T.FIX],
      [EV.PRODUCTION_CANCELLED, T.E1, 0, 0, 0, 0],
      [EV.PRODUCTION_BLOCKED, T.DD, 0, 0, 0, 0],
      [EV.NEW_OPTIONS, 0, 0, 0, 0, 0],
      [EV.CAPTURED, T.POWR, 0, 0, 0, 1],
      [EV.CAPTURED, T['1TNK'], 0, 0, 1, 0],
      [EV.INFILTRATED, T.PROC, 0, 0, 1, (T.THF << 8) | 0],
      [EV.INFILTRATED, T.PROC, 0, 0, 0, (T.THF << 8) | 1],
      [EV.BUILDING_DAMAGED, T.POWR, 0, 0, 2, 1],
      [EV.TIME_LIMIT_WARNING, 10, 0, 0, 255, 0],
    ),
    VIEW,
  );
  assert.deepEqual(calls.notify, ['LevelUp']);
  assert.deepEqual(calls.announce, [
    'unitPromoted',
    'airUnitLost',
    'navalUnitLost',
    'repairing',
    'unitRepaired',
    'cancelled',
    'noBuild',
    'newOptions',
    'buildingCaptured',
    'unitLost',
    'buildingInfiltrated',
    'creditsStolen',
    'allyUnderAttack',
    'tenMinutesRemaining',
  ]);
});

test('a spectator hears world sounds and the timer, no player notifications', () => {
  const { d, calls } = harness({ player: -1, allied: () => false });
  d.onEvents(
    ev(
      [EV.UNIT_PRODUCED, T.E1, 0, 0, 0, 0],
      [EV.DEATH, T['1TNK'], 500, 300, 0, 2],
      [EV.POWER_ACTIVATED, 1, 500, 300, 0, powerRef('MSLO', 0)],
      [EV.BEACON_PLACED, 0, 0, 0, 0, 0],
      [EV.TIME_LIMIT_WARNING, 1, 0, 0, 255, 0],
    ),
    VIEW,
  );
  assert.deepEqual(calls.announce, ['warningOneMinuteRemaining']);
  assert.deepEqual(calls.notify, []);
  assert.ok(calls.effects.some((e) => e.sound.synth === 'explosion_large'), 'the explosion is heard');
});

test('rules data: lost lines, captures, infiltration, repairs and actor sound files (OpenRA mods/ra)', () => {
  assert.equal(lostLine('E1'), 'unitLost');
  assert.equal(lostLine('MIG'), 'airUnitLost');
  assert.equal(lostLine('HELI'), 'airUnitLost');
  assert.equal(lostLine('SS'), 'navalUnitLost');
  assert.equal(lostLine('POWR'), null, 'structures have no ActorLostNotification');
  assert.deepEqual(captureLines('POWR'), { gained: 'buildingCaptured', lost: null });
  assert.deepEqual(captureLines('2TNK'), { gained: 'unitStolen', lost: 'unitLost' });
  assert.deepEqual(infiltrationLines('PROC', 'SPY'), { infiltrator: ['buildingInfiltrated'], target: ['creditsStolen'] });
  assert.deepEqual(infiltrationLines('DOME', 'THF'), { infiltrator: ['buildingInfiltrated'], target: [] });
  assert.deepEqual(repairLines('FIX'), { start: 'repairing', finish: 'unitRepaired' });
  assert.deepEqual(repairLines('SYRD'), { start: 'repairing', finish: 'unitRepaired' });
  assert.deepEqual(damagedSound('BRIK').originals, ['crmble2.aud']);
  assert.deepEqual(damagedSound('SBAG').originals, ['sandbag2.aud']);
  assert.equal(damagedSound('1TNK'), null);
  assert.deepEqual(crushSound('E1').originals, ['squishy2.aud']);
  assert.deepEqual(chuteSound('BADR').originals, ['chute1.aud']);
  assert.deepEqual(cloakSound('SS', true).originals, ['subshow1.aud']);
  assert.deepEqual(cloakSound('STNK', false).originals, ['appear1.aud']);
  assert.equal(cloakSound('MINV', true), null, 'mines cloak silently');
  assert.deepEqual(rearmSound('MNLY').originals, ['minelay1.aud']);
  assert.equal(ACTOR_SOUNDS.DOME.powerToggle.off, 'DisablePower');
});

test('sound notifications follow notifications.yaml: files, volumes and interrupt types', () => {
  assert.deepEqual(notificationSound('ClickSound'), { synth: 'ui_click', originals: ['ramenu1.aud'], volume: 1, interrupt: 'Overlap' });
  assert.equal(notificationSound('ClickDisabledSound'), null, 'empty in RA: silent');
  assert.equal(notificationSound('CashTickUp').volume, 0.33);
  assert.equal(notificationSound('ChatLine').interrupt, 'Interrupt');
  assert.equal(notificationSound('RadarUp').interrupt, 'DoNotPlay');
  for (const name of Object.keys(SOUND_NOTIFICATIONS)) assert.ok(name in SOUND_SYNTH, `${name} has a synthesized sound or none`);
});

test('the announcer plays one line at a time, drops duplicates and stale lines', async () => {
  let t = 0;
  const played = [];
  const pending = [];
  const a = new Announcer({
    now: () => t,
    play: (key) =>
      new Promise((resolve) => {
        played.push(key);
        pending.push(resolve);
      }),
  });
  a.push('unitReady');
  a.push('lowPower');
  assert.equal(a.push('lowPower'), false, 'already queued');
  a.push('unitLost');
  a.push('insufficientFunds');
  a.push('structureSold'); // queue holds 3: the oldest waiting line goes
  assert.deepEqual(played, ['unitReady']);
  t = 10; // everything waiting is now stale
  pending.shift()();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(played, ['unitReady'], 'stale lines are skipped');
  a.push('baseUnderAttack');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(played, ['unitReady', 'baseUnderAttack']);
  assert.equal(a.push('baseUnderAttack'), false, 'the line playing now is not queued again');
});

// ---- Settings ------------------------------------------------------------------------------

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

test('settings are validated, saved and observed', () => {
  assert.deepEqual(sanitizePrefs({ master: 2, effects: -1, voices: '0.5', music: 'loud', speech: 'yes', original: false, extra: 1 }), {
    ...DEFAULT_PREFS,
    master: 1,
    effects: 0,
    original: false,
  });
  const storage = memoryStorage();
  storage.setItem('webra.audio.v1', '{broken');
  assert.deepEqual(new Prefs(createRegistry({ storage })).get(), DEFAULT_PREFS, 'corrupt settings fall back to defaults');
  storage.setItem('webra.audio.v1', JSON.stringify({ master: 0.3 }));
  storage.map.delete(REGISTRY_KEY);
  assert.equal(new Prefs(createRegistry({ storage })).get().master, 0.3, 'the old audio key migrates');
  const registry = createRegistry({ storage });
  const prefs = new Prefs(registry);
  const seen = [];
  prefs.subscribe((p) => seen.push(p.music));
  prefs.set({ music: 0.25, bogus: 1 });
  assert.equal(JSON.parse(storage.getItem(REGISTRY_KEY)).audio.music, 0.25);
  assert.deepEqual(seen, [0.25]);
  assert.equal(new Prefs(createRegistry({ storage })).get().music, 0.25, 'survives a reload');
  registry.applyDocument({ audio: { music: 0.6 } });
  assert.equal(prefs.get().music, 0.6, 'a synced change reaches the live prefs');
  assert.deepEqual(seen, [0.25, 0.6]);
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const p2 = new Prefs(createRegistry({ storage: throwing }));
  p2.set({ master: 0.1 });
  assert.equal(p2.get().master, 0.1, 'works without storage');
  assert.equal(busGain({ ...DEFAULT_PREFS, master: 0.5, effects: 0.5 }, 'effects'), 0.25);
  assert.equal(busGain({ ...DEFAULT_PREFS, enabled: false }, 'effects'), 0);
});

// ---- Installing original content ------------------------------------------------------------

const tone = (n = 400) => imaAud(sineSamples(n));

test('installs wanted sounds from nested and encrypted MIX archives and loose files', async () => {
  const key = testRsaKey(5);
  const speech = buildMix([{ name: 'conscmp1.aud', data: tone() }, { name: 'notwanted.aud', data: tone() }]);
  const allies = buildMix([{ name: 'ackno.v01', data: tone() }]);
  const main = buildEncryptedMix(
    [
      { name: 'speech.mix', data: speech },
      { name: 'allies.mix', data: allies },
      { name: 'cannon1.aud', data: tone() },
      { name: 'kaboom12.aud', data: Uint8Array.from([1, 2, 3]) }, // wanted name, but not a sound
    ],
    key,
  );
  const store = new MemoryStore();
  const progress = [];
  const files = [
    new File([main], 'MAIN.MIX'),
    new File([tone()], 'hell226m.aud'),
    new File([tone()], 'readme.txt'),
    new File([Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])], 'broken.mix'),
  ];
  const r = await installFromFiles(files, store, { publicKey: key, onProgress: (t) => progress.push(t) });
  assert.equal(r.added, 4);
  assert.deepEqual(r.byCategory, { effects: 1, voices: 1, announcer: 1, music: 1 });
  assert.deepEqual((await store.names()).sort(), ['ackno.v01', 'cannon1.aud', 'conscmp1.aud', 'hell226m.aud']);
  assert.deepEqual(r.archives, ['main.mix', 'main.mix/allies.mix', 'main.mix/speech.mix']);
  assert.deepEqual(r.skipped, ['readme.txt']);
  assert.ok(r.errors.some((e) => e.startsWith('broken.mix')));
  assert.ok(r.errors.some((e) => e.startsWith('kaboom12.aud') && /not an AUD/.test(e)));
  assert.ok(progress.length > 0);
  const rec = await store.get('cannon1.aud');
  assert.equal(rec.from, 'main.mix');
  assert.deepEqual(new Uint8Array(rec.bytes), tone());
  assert.deepEqual(await installedSummary(store), { total: 4, byCategory: { effects: 1, voices: 1, announcer: 1, music: 1 } });
});

test('the Counterstrike and Aftermath music install from the expansion discs and the expand folder (OpenRA ra-content)', async () => {
  // music.yaml: the base tracks, then 8 Counterstrike and 9 Aftermath tracks; intro, map and score are hidden.
  assert.equal(MUSIC.length, MUSIC_TRACKS.length);
  assert.equal(MUSIC.filter((m) => m.group === 'Counterstrike').length, 8);
  assert.equal(MUSIC.filter((m) => m.group === 'Aftermath').length, 9);
  assert.deepEqual(MUSIC.filter((m) => m.hidden).map((m) => m.file), ['intro.aud', 'map.aud', 'score.aud']);
  assert.equal(PLAYLIST.length, MUSIC.length - 3);
  assert.equal(MUSIC.find((m) => m.file === 'fac1226m.aud').volume, 0.85, 'VolumeModifier');
  assert.equal(categoryOf('araziod.aud'), 'music');
  // A Counterstrike disc's MAIN.MIX holds its own scores.mix (installer/counterstrike.yaml).
  const csScores = buildMix([{ name: 'araziod.aud', data: tone() }, { name: 'twinmix1.aud', data: tone() }]);
  const csMain = buildMix([{ name: 'scores.mix', data: csScores }]);
  const store = new MemoryStore();
  const loose = new File([tone()], 'wastelnd.aud');
  Object.defineProperty(loose, 'webkitRelativePath', { value: 'Content/ra/v2/expand/wastelnd.aud' });
  const r = await installFromFiles([new File([csMain], 'MAIN.MIX'), loose], store);
  assert.deepEqual((await store.names()).sort(), ['araziod.aud', 'twinmix1.aud', 'wastelnd.aud']);
  assert.deepEqual(r.byCategory.music, 3);
  for (const f of ['araziod.aud', 'wastelnd.aud', 'await.aud', 'await_r.aud']) assert.ok(MUSIC_FILES.has(f), f);
});

test('installed originals replace synthesized sounds unless switched off', async () => {
  const store = new MemoryStore();
  await installFromFiles([new File([tone()], 'cannon1.aud'), new File([tone(64)], 'hell226m.aud')], store);
  const made = [];
  const mixer = { ctx: { sampleRate: 22050 }, buffer: (samples, rate) => (made.push(rate), { samples, rate }) };
  let original = true;
  const bank = new SoundBank(mixer, () => ({ original }));
  assert.equal(await bank.loadInstalled(store), 1, 'music is not preloaded');
  const sound = fireSound('90mm');
  const a = bank.resolve(sound, () => 0);
  assert.equal(a.original, true);
  assert.equal(a.buffer.samples.length, 400);
  original = false;
  const b = bank.resolve(sound, () => 0);
  assert.equal(b.original, false, 'switched back to our own sounds');
  assert.ok(b.buffer.samples.length > 1000);
  assert.equal(bank.resolve(fireSound('M1Carbine'), () => 0).original, false, 'missing originals fall back');
  assert.equal(bank.resolve({ synth: null, originals: ['nothing.aud'] }), null);
});

// ---- Structures: placing, deploying, packing up ----------------------------------------------------

test('placing a structure plays every BuildSounds entry at once (OpenRA PlaceBuilding)', async () => {
  const sound = placeSound('POWR');
  assert.deepEqual(sound.originals, ['placbldg.aud', 'build5.aud'], 'defaults.yaml ^Building BuildSounds');
  assert.equal(sound.layered, true);
  assert.deepEqual(placeSound('SBAG').originals, ['placbldg.aud'], 'walls only thud');
  const store = new MemoryStore();
  await installFromFiles([new File([tone(100)], 'placbldg.aud'), new File([tone(200)], 'build5.aud')], store);
  const mixer = { ctx: { sampleRate: 22050 }, buffer: (samples, rate) => ({ samples, rate }) };
  let original = true;
  const bank = new SoundBank(mixer, () => ({ original }));
  await bank.loadInstalled(store);
  const both = bank.resolveAll(sound);
  assert.deepEqual(both.map((r) => [r.original, r.buffer.samples.length]), [[true, 100], [true, 200]], 'both layers, not one of them');
  assert.equal(bank.resolveAll(fireSound('90mm')).length, 1, 'other sounds still pick one');
  // A texture pack that replaces one part keeps the installed other part.
  bank.pack = new Map([['build5', 'pack-build5']]);
  assert.deepEqual(bank.resolveAll(sound).map((r) => [r.pack === true, r.buffer.samples?.length ?? r.buffer]), [[false, 100], [true, 'pack-build5']]);
  // A pack sound for the event replaces the installed files, like `resolve`.
  bank.pack = new Map([['place_building', 'pack-event']]);
  assert.deepEqual(bank.resolveAll(sound).map((r) => r.buffer), ['pack-event']);
  bank.pack = new Map();
  // Only one installed: that one. Originals off or none installed: our place_building sound (thud and clank in one).
  bank.originals.delete('build5.aud');
  assert.deepEqual(bank.resolveAll(sound).map((r) => r.buffer.samples.length), [100]);
  original = false;
  const synth = bank.resolveAll(sound, () => 0);
  assert.equal(synth.length, 1);
  assert.equal(synth[0].original, false);
  assert.ok(synth[0].buffer.samples.length > 1000);
});

test('the audio system plays every layer of a layered sound on the effects bus', () => {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  const played = [];
  audio.mixer.play = (buffer, opts) => played.push([buffer, opts.bus, opts.gain]);
  audio.bank.resolveAll = (sound) => sound.originals.map((n) => ({ buffer: n, rate: 1 }));
  audio.effect(placeSound('POWR'), { gain: 0.7 });
  assert.deepEqual(played, [['placbldg.aud', 'effects', 0.7], ['build5.aud', 'effects', 0.7]]);
});

test('an MCV deploying plays its TransformSounds, a yard packing up its UndeploySounds (OpenRA Transforms)', () => {
  assert.deepEqual(ACTOR_SOUNDS.MCV.transform, ['placbldg', 'build5'], 'vehicles.yaml MCV Transforms TransformSounds');
  assert.deepEqual(ACTOR_SOUNDS.FACT.undeploy, ['cashturn'], 'defaults.yaml ^Building UndeploySounds');
  assert.equal(ACTOR_SOUNDS.FACT.transform, undefined, 'the yard names no TransformSounds');
  assert.deepEqual(transformSounds('MCV'), [{ synth: 'place_building', originals: ['placbldg.aud', 'build5.aud'], layered: true }]);
  assert.deepEqual(transformSounds('FACT'), [{ synth: 'sell', originals: ['cashturn.aud'], layered: true }]);
  assert.deepEqual(transformSounds('1TNK'), [], 'nothing named, nothing played');
  assert.deepEqual(deployBlocked('MCV'), { sound: null, announce: 'buildingCannotPlaceAudio' }, 'NoTransformNotification: BuildingCannotPlaceAudio');
  assert.deepEqual(EVA.buildingCannotPlaceAudio.originals, ['nodeply1.aud']);
  for (const n of ['placbldg.aud', 'build5.aud', 'cashturn.aud', 'nodeply1.aud']) assert.ok(allOriginalNames().includes(n), n);

  const rules = { actors: [{ id: 'MCV', kind: 'vehicle' }, { id: 'FACT', kind: 'building' }, { id: 'POWR', kind: 'building' }], weapons: [] };
  const effects = [];
  const announced = [];
  let t = 10;
  const d = new Director({
    rules,
    player: 0,
    side: 'allies',
    pxPerWorld: 1,
    lookup: () => null,
    sink: { effect: (sound, opts) => effects.push({ sound, ...opts }), voice() {}, announce: (k) => announced.push(k) },
    now: () => (t += 1),
  });
  // Own MCV into a yard, then an enemy one; OpenRA plays them to the owner only (PlayToPlayer).
  d.onEvents(ev([EV.TRANSFORMED, 0, 500, 300, 0, 1], [EV.TRANSFORMED, 0, 500, 300, 1, 1]), VIEW);
  assert.equal(effects.length, 1);
  assert.deepEqual(effects[0].sound.originals, ['placbldg.aud', 'build5.aud']);
  assert.ok(effects[0].gain > 0.9, 'at the MCV, in the middle of the view');
  effects.length = 0;
  d.onEvents(ev([EV.TRANSFORMED, 1, 500, 300, 0, 0]), VIEW);
  assert.deepEqual(effects.map((e) => e.sound.originals), [['cashturn.aud']]);
  // Placement: the owner only, too.
  effects.length = 0;
  d.onEvents(ev([EV.BUILDING_PLACED, 2, 500, 300, 1, 0]), VIEW);
  assert.equal(effects.length, 0, 'an enemy placing a structure is not heard');
  d.onEvents(ev([EV.BUILDING_PLACED, 2, 500, 300, 0, 0]), VIEW);
  assert.deepEqual(effects.map((e) => e.sound.layered), [true]);
  // A refused deploy: "Cannot deploy here", for the owner.
  d.onEvents(ev([EV.DEPLOY_BLOCKED, 0, 500, 300, 1, 0]), VIEW);
  assert.deepEqual(announced, []);
  d.onEvents(ev([EV.DEPLOY_BLOCKED, 0, 500, 300, 0, 0], [EV.DEPLOY_BLOCKED, 2, 500, 300, 0, 0]), VIEW);
  assert.deepEqual(announced, ['buildingCannotPlaceAudio']);
});

test('the engine reports an MCV deploy and a yard packing up to the client', () => {
  const opts = {
    seed: 5,
    mapSize: 64,
    players: [
      { slot: 0, type: 'human', faction: 'england', color: 0 },
      { slot: 1, type: 'ai', difficulty: 'easy', faction: 'russia', color: 1 },
    ],
    startingUnits: 'mcv',
    redeployableMcv: true,
  };
  const game = Game.from_options(JSON.stringify(opts));
  const rules = JSON.parse(game.rules_json());
  const id = (name) => rules.actors.findIndex((a) => a.id === name);
  const size = 1e7;
  const own = () => Array.from(game.select_box(0, 0, 0, size, size)).map((i) => [i, JSON.parse(game.actor_json(i))]);
  game.set_audio_events(true);
  const mcv = own().find(([, a]) => a.type === 'MCV');
  assert.ok(mcv, 'the player starts with an MCV');
  game.deploy(0, [mcv[0]]);
  const seen = [];
  for (let t = 0; t < 3; t++) {
    game.tick();
    const e = game.take_audio_events();
    for (let i = 0; i < e.length; i += STRIDE) if (e[i] === EV.TRANSFORMED) seen.push([e[i + 1], e[i + 4], e[i + 5]]);
  }
  assert.deepEqual(seen, [[id('MCV'), 0, id('FACT')]]);
});

// ---- Synthesized sounds ------------------------------------------------------------------------

test('every synthesized sound is audible, bounded and deterministic', () => {
  for (const id of Object.keys(RECIPES)) {
    const s = render(id, 22050, 0);
    assert.ok(s.length > 100 && s.length < 22050 * 5, `${id} length ${s.length}`);
    let peak = 0;
    for (const v of s) {
      assert.ok(Number.isFinite(v), `${id} is finite`);
      peak = Math.max(peak, Math.abs(v));
    }
    assert.ok(peak > 0.05 && peak <= 1, `${id} peak ${peak}`);
    assert.deepEqual(render(id, 22050, 0), s, `${id} renders the same each time`);
  }
  assert.notDeepEqual(render('rifle', 22050, 0), render('rifle', 22050, 1), 'variants differ');
  assert.equal(render('nope', 22050), null);
});

test('music shuffles every track once before repeating', () => {
  let x = 0.3;
  const random = () => (x = (x * 9301 + 0.49297) % 1);
  const order = shuffle(10, random);
  assert.deepEqual([...order].sort((a, b) => a - b), [...Array(10).keys()]);
  assert.notEqual(shuffle(5, random, 3)[0], 3, 'does not repeat the last track first');
});

test('music hotkeys: stop stays stopped, pause resumes where it was, previous goes back', async () => {
  const played = [];
  let now = 0;
  const mixer = {
    ready: true,
    play: (buffer, { offset = 0, onEnded }) => {
      const h = { buffer, offset, stopped: false, onEnded, stop: () => (h.stopped = true), position: () => offset + now };
      played.push(h);
      return h;
    },
  };
  const tracks = new Map(MUSIC.slice(0, 3).map((m, i) => [m.file, { id: i }]));
  const j = new Jukebox(mixer, async () => ({ names: async () => [] }), () => {}, () => tracks, () => false);
  await j.refresh();
  await j.next();
  const first = played.at(-1);
  now = 12;
  await j.togglePause();
  assert.equal(first.stopped, true, 'pause stops the track');
  assert.ok(j.paused && !j.handle);
  await j.togglePause();
  assert.equal(played.at(-1).buffer, first.buffer, 'the same track again');
  assert.equal(played.at(-1).offset, 12, 'from where it paused');
  await j.next();
  const second = played.at(-1).buffer;
  assert.notEqual(second, first.buffer);
  await j.prev();
  assert.equal(played.at(-1).buffer, first.buffer, 'previous: the track before');
  j.userStop();
  assert.equal(j.stoppedByUser, true);
  assert.equal(j.handle, null);
  await j.togglePause();
  assert.equal(j.stoppedByUser, false, 'pause after stop starts a track');
  assert.ok(j.handle);
});

test('mute and the music commands go through the audio system', () => {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  assert.equal(audio.prefs.get().enabled, true);
  assert.equal(audio.toggleMute(), true, 'muted');
  assert.equal(audio.prefs.get().enabled, false);
  assert.equal(audio.toggleMute(), false);
  const calls = [];
  audio.jukebox = {
    userStop: () => calls.push('stop'),
    togglePause: () => calls.push('pause'),
    prev: () => calls.push('prev'),
    next: () => calls.push('next'),
    // Settings changes sync the music too.
    start() {},
    stop() {},
  };
  for (const c of ['stop', 'pause', 'prev', 'next']) audio.music(c);
  assert.deepEqual(calls, ['stop'], 'out of a game only stop does something');
  audio.musicWanted = () => true;
  for (const c of ['pause', 'prev', 'next']) audio.music(c);
  assert.deepEqual(calls, ['stop', 'pause', 'prev', 'next']);
});

// ---- Wiring ----------------------------------------------------------------------------------------

test('local orders through the watched game get replies; production speaks through the sidebar', () => {
  const calls = [];
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  audio.director = { onOrder: (ids) => calls.push(['order', ids]), onProductionClick: (id, outcome) => calls.push(['click', id, outcome]) };
  const game = {
    n: 0,
    order_move(player, ids) {
      this.n++;
      return 'moved';
    },
    start_production() {},
    pick() {
      return this.n;
    },
  };
  const ui = audio.watch(game);
  assert.equal(ui.order_move(0, Uint32Array.from([5, 6]), 1, 2, false), 'moved');
  ui.start_production(0, 'E1', 1);
  audio.productionClick('E1', 'queued');
  assert.equal(ui.pick(), 1, 'other methods pass through with the right this');
  assert.equal(ui.order_move, ui.order_move, 'wrappers are cached');
  assert.deepEqual(calls, [['order', [5, 6]], ['click', 'E1', 'queued']]);
});

test('sound notifications honour DoNotPlay, Interrupt and Overlap, and the click setting', async () => {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  const handles = [];
  audio.mixer.play = (buffer, opts) => {
    let end;
    const h = { buffer, gain: opts.gain, stopped: false, ended: new Promise((r) => (end = r)), stop: () => ((h.stopped = true), end()) };
    h.end = end;
    handles.push(h);
    return h;
  };
  audio.bank.resolveAll = (sound) => [{ buffer: sound.originals[0], rate: 1 }];
  assert.equal(audio.notify('RadarUp'), true);
  assert.equal(audio.notify('RadarUp'), false, 'DoNotPlay while it plays');
  handles[0].end();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(audio.notify('RadarUp'), true, 'again once it ended');
  audio.notify('ChatLine');
  audio.notify('ChatLine');
  assert.equal(handles.filter((h) => h.buffer === 'rabeep1.aud').length, 2);
  assert.equal(handles.find((h) => h.buffer === 'rabeep1.aud').stopped, true, 'Interrupt stops the one playing');
  audio.cashTick('up');
  audio.cashTick('up');
  const ticks = handles.filter((h) => h.buffer === 'cashup1.aud');
  assert.equal(ticks.length, 2, 'Overlap');
  assert.equal(ticks[0].gain, 0.33, 'VolumeModifier');
  assert.equal(audio.notify('ClickDisabledSound'), false);
  audio.click();
  assert.equal(handles.at(-1).buffer, 'ramenu1.aud');
  audio.prefs.set({ clickSounds: false });
  const n = handles.length;
  audio.click();
  assert.equal(handles.length, n, 'interface clicks off');
  // Text-only lines are shown, never spoken.
  const pushed = [];
  audio.announcer.push = (key) => pushed.push(key);
  audio.announce('unitPromoted');
  audio.announce('unitReady');
  assert.deepEqual(pushed, ['unitReady']);
});

test('the interface click sound: buttons click, controls with their own sounds do not', () => {
  const listeners = [];
  const doc = { addEventListener: (type, fn) => listeners.push([type, fn]) };
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc });
  let clicks = 0;
  audio.click = () => clicks++;
  const click = listeners.find(([t]) => t === 'click')[1];
  const target = (el) => ({ target: { closest: (sel) => (sel === CLICKABLE ? el : el?.own ? el : null) } });
  click(target({ disabled: false, getAttribute: () => null, closest: () => null }));
  click(target({ disabled: true, getAttribute: () => null, closest: () => null }));
  click(target({ disabled: false, getAttribute: () => null, closest: () => ({}) }));
  click(target(null));
  assert.equal(clicks, 1, 'only the enabled button without its own sound');
});

test('background music: the intro in the menu, the score track after a won game, until a track is picked', async () => {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  const started = [];
  audio.mixer = { ready: true, unlock() {}, apply() {}, play: (buffer, opts) => (started.push([buffer, opts.gain]), { stop() {}, ended: new Promise(() => {}), position: () => 0 }) };
  audio.jukebox.mixer = audio.mixer;
  const pack = new Map([...[BACKGROUND_MUSIC.menu, BACKGROUND_MUSIC.victory, BACKGROUND_MUSIC.defeat, PLAYLIST[0]].map((m) => [m.file, `buffer:${m.file}`])]);
  audio.bank.pack = pack;
  audio.jukebox.packTracks = () => pack;
  audio.storePromise = Promise.resolve({ names: async () => [] });
  await audio.jukebox.refresh();
  assert.ok(audio.jukebox.has(BACKGROUND_MUSIC.menu) && audio.jukebox.tracks.length === 1, 'hidden tracks stay out of the playlist');
  audio.syncMusic();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(started.at(-1), ['buffer:intro.aud', 0.9], 'the shellmap intro at its VolumeModifier');
  audio.prefs.set({ menuMusic: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(audio.jukebox.background, null, 'Main menu music off');
  audio.inGame = true;
  audio.syncMusic();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(started.at(-1)[0], `buffer:${PLAYLIST[0].file}`, 'the playlist in a game');
  audio.gameOver(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(started.at(-1), ['buffer:score.aud', 0.7], 'MusicPlaylist VictoryMusic');
  assert.equal(audio.jukebox.background, BACKGROUND_MUSIC.victory);
  audio.nextTrack();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(audio.jukebox.background, null, 'picking a track ends it');
  assert.equal(audio.gameOverTrack, null);
});

test('announcer lines reach the on-screen notifications, also with sound off', () => {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  const shown = [];
  const pushed = [];
  audio.announcer.push = (key) => pushed.push(key);
  const off = audio.onAnnounce((key) => shown.push(key));
  audio.announce('unitReady');
  audio.prefs.set({ enabled: false });
  audio.announce('insufficientFunds');
  assert.deepEqual(shown, ['unitReady', 'insufficientFunds']);
  assert.deepEqual(pushed, ['unitReady'], 'only spoken while sound is on');
  // With sound off the engine events still reach the director (for the text),
  // but effects stay silent.
  const events = [];
  audio.game = { take_audio_events: () => [5, 0, 0, 0, 0, 0] };
  audio.director = { onEvents: (ev) => events.push(Array.from(ev)) };
  let played = 0;
  audio.mixer.play = () => {
    played++;
    return null;
  };
  audio.frame({ x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.equal(events.length, 1);
  audio.effect({ synth: 'cannon', originals: [] });
  assert.equal(played, 0);
  off();
  audio.announce('unitLost');
  assert.equal(shown.length, 2, 'unsubscribed');
});

test('only cells the engine reports as visible count as seen for sounds', () => {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  audio.game = { take_audio_events: () => [5, 0, 0, 0, 0, 0] };
  audio.pxPerCell = 24;
  audio.mapWidth = 3;
  let visible;
  audio.director = { onEvents: (_ev, _view, fn) => (visible = fn) };
  // Game.fog_ptr bytes for a 3x1 map: shroud, fog, visible.
  const fog = Uint8Array.from([0, 128, FOG_VISIBLE]);
  audio.frame({ x0: 0, y0: 0, x1: 72, y1: 24 }, () => fog);
  assert.equal(visible(12, 12), false, 'shroud');
  assert.equal(visible(36, 12), false, 'fog');
  assert.equal(visible(60, 12), true, 'visible');
  assert.equal(visible(84, 12), false, 'outside the map');
});

// ---- Engine events through WebAssembly --------------------------------------------------------------

test('the engine reports fire, impact and death events to the client', () => {
  const opts = {
    seed: 77,
    mapSize: 64,
    players: [
      { slot: 0, type: 'ai', difficulty: 'hard', faction: 'england', color: 0 },
      { slot: 1, type: 'ai', difficulty: 'hard', faction: 'russia', color: 1 },
    ],
    startingCash: 10000,
    startingUnits: 'heavy',
    techLevel: 'unrestricted',
    gameSpeed: 'normal',
    fog: false,
    explored: true,
    buildRadius: true,
    redeployableMcv: true,
    oreRegrowth: true,
    techBuildings: 'standard',
    // OpenRA's other lobby options (protocol 6).
    crates: true,
    shortGame: true,
    bounty: false,
    separateTeamSpawns: true,
    allyBuildRadius: true,
    timeLimit: 0,
    reusableEngineers: false,
  };
  const game = Game.from_options(JSON.stringify(opts));
  const quiet = Game.from_options(JSON.stringify(opts));
  const rules = JSON.parse(game.rules_json());
  assert.equal(rules.weapons.length, engineRules.weapons.length, 'rules list weapon names for audio events');
  assert.equal(Game.audio_event_stride(), STRIDE);
  assert.equal(game.take_audio_events().length, 0, 'off by default');
  game.set_audio_events(true);
  const seen = new Set();
  let total = 0;
  for (let t = 0; t < 25 * 120; t++) {
    game.tick();
    quiet.tick();
    const e = game.take_audio_events();
    assert.equal(e.length % STRIDE, 0);
    total += e.length / STRIDE;
    for (let i = 0; i < e.length; i += STRIDE) {
      seen.add(e[i]);
      if (e[i] === EV.FIRE || e[i] === EV.IMPACT) assert.ok(rules.weapons[e[i + 1]], 'weapon index in range');
    }
  }
  assert.ok(total > 0);
  for (const k of [EV.FIRE, EV.IMPACT, EV.DEATH, EV.UNIT_PRODUCED]) assert.ok(seen.has(k), `saw event kind ${k}`);
  assert.equal(game.state_hash(), quiet.state_hash(), 'audio events never change the game');
  // The director accepts the engine's events as they come.
  const calls = [];
  const d = new Director({
    rules,
    player: 0,
    side: 'allies',
    pxPerWorld: rules.pxPerCell / Game.world_units_per_cell(),
    lookup: () => null,
    sink: { effect: (s) => calls.push(s), voice() {}, announce() {} },
    now: () => 0,
  });
  for (let t = 0; t < 25 * 10; t++) game.tick();
  d.onEvents(game.take_audio_events(), { x0: 0, y0: 0, x1: 64 * 24, y1: 64 * 24 });
  assert.ok(calls.length <= MAX_EFFECTS_PER_FRAME);
});

test('production holds, what was paid and build limits reach the sidebar through player_json', () => {
  const game = Game.from_options(
    JSON.stringify({
      seed: 5,
      mapSize: 64,
      players: [
        { slot: 0, type: 'human', faction: 'soviet', color: 0 },
        { slot: 1, type: 'ai', difficulty: 'easy', faction: 'allies', color: 1 },
      ],
      startingCash: 10000,
      startingUnits: 'base',
      techLevel: 'unrestricted',
      gameSpeed: 'normal',
      fog: true,
      explored: false,
      buildRadius: true,
      redeployableMcv: true,
      oreRegrowth: true,
    }),
  );
  game.start_production(0, 'POWR', 1);
  for (let t = 0; t < 30; t++) game.tick();
  const head = () => JSON.parse(game.player_json(0)).queues[0][0];
  assert.equal(head().started, true, 'something was paid');
  assert.equal(head().paused, false);
  game.pause_production(0, 'POWR', true);
  game.tick();
  const held = head().progress;
  assert.equal(head().paused, true);
  for (let t = 0; t < 20; t++) game.tick();
  assert.equal(head().progress, held, 'on hold');
  game.pause_production(0, 'POWR', false);
  for (let t = 0; t < 5; t++) game.tick();
  assert.ok(head().progress > held, 'resumed');
  const buildable = new Map(JSON.parse(game.player_json(0)).buildable.map((b) => [b.id, b]));
  assert.equal(buildable.get('MSLO').limitLeft, 1, 'BuildLimit 1, none owned');
  assert.equal(buildable.get('POWR').limitLeft, null, 'no limit');
  const rules = JSON.parse(game.rules_json());
  assert.deepEqual(rules.actors.find((a) => a.id === 'MSLO').powers, ['NukePower'], 'power keys name the power of an event');
  assert.equal(rules.actors.find((a) => a.id === 'MSLO').buildLimit, 1);
});

test('removing the installed content stops a removed music track at once', async () => {
  const { MemoryStore } = await import('../js/content/store.js');
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  const store = new MemoryStore();
  audio.store = async () => store;
  audio.jukebox.getStore = async () => store;
  await audio.reloadInstalled();
  let stopped = 0;
  audio.jukebox.playing = 'Hell March';
  audio.jukebox.handle = { stop: () => stopped++ };
  await audio.reloadInstalled();
  assert.equal(stopped, 1);
  assert.equal(audio.jukebox.playing, null);
});
