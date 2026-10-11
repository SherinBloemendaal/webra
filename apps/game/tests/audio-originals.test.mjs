// Original sounds in use (js/audio/catalog.js `openra`, bank.js keepsOriginal):
// with the player's Red Alert files installed, every cue OpenRA defines plays
// the original or, where OpenRA plays nothing a Red Alert copy has, nothing;
// never WebRA's own sound. And the first sounds of a game wait for the
// installed sounds to load. Synthetic sound files only (audio-fixtures.mjs).
//   node --test apps/game/tests/audio-originals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fireSound,
  fireChargeSound,
  impactSound,
  deathSound,
  placeSound,
  sellSound,
  transformSounds,
  deployBlocked,
  madTankSounds,
  teleportSound,
  voiceLine,
  voiceSetFor,
  damagedSound,
  crushSound,
  chuteSound,
  ejectChuteSound,
  paraImpactSound,
  cloakSound,
  rearmSound,
  crateSounds,
  CRATE_ACTIONS,
  powerSound,
  powerNotifications,
  POWER_KINDS,
  notificationSound,
  EVA,
  VOICE_SETS,
  OPENRA_MADE,
  allOriginalNames,
  actorSounds,
} from '../js/audio/catalog.js';
import { WEAPON_SOUNDS, SOUND_NOTIFICATIONS, OPENRA_ACTORS } from '../js/audio/catalog-data.js';
import { SoundBank } from '../js/audio/bank.js';
import { Director, EV } from '../js/audio/director.js';
import { AudioSystem } from '../js/audio/index.js';
import { MemoryStore } from '../js/audio/store.js';
import { installFromFiles } from '../js/audio/install.js';
import { createRegistry } from '../js/registry.js';
import { sineSamples, imaAud } from './audio-fixtures.mjs';

const engineRules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));
const tone = (n = 64) => imaAud(sineSamples(n));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** A sound bank with a synthetic file for every Red Alert file the game can use (none of OpenRA's own files). */
function installedBank({ original = true, skip = () => false } = {}) {
  const mixer = { ctx: { sampleRate: 22050 }, buffer: (samples, rate) => ({ samples, rate }) };
  const bank = new SoundBank(mixer, () => ({ original }));
  const bytes = tone();
  for (const name of allOriginalNames()) if (!OPENRA_MADE.has(name) && !skip(name)) bank.originals.set(name, bytes);
  return bank;
}

/** Every sound cue of the catalog for the engine's actors and weapons: [label, sound]. */
function everyCue() {
  const cues = [];
  const add = (label, sound) => sound && cues.push([label, sound]);
  for (const w of engineRules.weapons) {
    add(`fire ${w.name}`, fireSound(w.name));
    add(`impact ${w.name}`, impactSound(w.name, false));
    add(`water impact ${w.name}`, impactSound(w.name, true));
  }
  for (const a of engineRules.actors) {
    for (let seq = 0; seq < 7; seq++) add(`death ${a.id} ${seq}`, deathSound(a.id, a.kind, seq));
    if (a.kind === 'building') add(`place ${a.id}`, placeSound(a.id));
    add(`sell ${a.id}`, sellSound(a.id));
    transformSounds(a.id).forEach((s, i) => add(`transform ${a.id} ${i}`, s));
    add(`deploy blocked ${a.id}`, deployBlocked(a.id).sound);
    add(`charge ${a.id}`, fireChargeSound(a.id));
    madTankSounds(a.id, false).forEach((s) => add(`mad charge ${a.id}`, s));
    madTankSounds(a.id, true).forEach((s, i) => add(`mad detonate ${a.id} ${i}`, s));
    add(`teleport ${a.id}`, teleportSound(a.id, false));
    add(`chrono tank ${a.id}`, teleportSound(a.id, true));
    add(`damaged ${a.id}`, damagedSound(a.id));
    add(`crush ${a.id}`, crushSound(a.id));
    add(`chute ${a.id}`, chuteSound(a.id));
    add(`eject ${a.id}`, ejectChuteSound(a.id));
    add(`para ground ${a.id}`, paraImpactSound(a.id, false));
    add(`para water ${a.id}`, paraImpactSound(a.id, true));
    add(`cloak ${a.id}`, cloakSound(a.id, true));
    add(`uncloak ${a.id}`, cloakSound(a.id, false));
    add(`rearm ${a.id}`, rearmSound(a.id));
    if (['infantry', 'vehicle', 'ship', 'aircraft'].includes(a.kind)) {
      const set = VOICE_SETS[voiceSetFor(a.id, a.kind)];
      for (const side of ['allies', 'soviet']) for (const line of Object.keys(set.lines)) add(`voice ${a.id} ${side} ${line}`, voiceLine(a.id, a.kind, side, line));
    }
    for (const key of Object.keys(actorSounds(a.id).powers ?? {})) {
      const p = powerNotifications(a.id, key);
      add(`power ${a.id} ${key}`, powerSound(POWER_KINDS.indexOf(p.kind), p));
    }
  }
  for (let code = 1; code < POWER_KINDS.length; code++) add(`power ${POWER_KINDS[code]}`, powerSound(code, {}));
  for (let code = 1; code < CRATE_ACTIONS.length; code++) add(`crate ${CRATE_ACTIONS[code]}`, crateSounds(code).sound);
  for (const name of Object.keys(SOUND_NOTIFICATIONS)) add(`notification ${name}`, notificationSound(name));
  for (const [key, line] of Object.entries(EVA)) if (!line.textOnly) add(`speech ${key}`, line);
  return cues;
}

test('every cue OpenRA defines is marked as OpenRA\'s', () => {
  // Cues that are silent in both modes (a mine's or a husk's own death: their weapon or explosion sounds) need no mark.
  for (const [label, sound] of everyCue()) if (sound.synth || sound.originals.length) assert.equal(sound.openra, true, label);
  for (const a of engineRules.actors) assert.ok(OPENRA_ACTORS.includes(a.id) || /R\d+$/.test(a.id), `${a.id} is an OpenRA actor`);
});

test('with Red Alert installed, every cue with an original plays the original, the others stay silent', () => {
  const bank = installedBank();
  let originals = 0;
  let silent = 0;
  for (const [label, sound] of everyCue()) {
    const played = bank.resolveAll(sound, () => 0);
    assert.ok(
      played.every((r) => r.original),
      `${label}: ${JSON.stringify(sound)} plays WebRA's own sound`,
    );
    const hasOriginal = sound.originals.some((n) => !OPENRA_MADE.has(n));
    assert.equal(played.length > 0, hasOriginal, `${label}: ${hasOriginal ? 'original missing' : 'should be silent'}`);
    if (hasOriginal) originals++;
    else silent++;
  }
  assert.ok(originals > 1000 && silent > 50, `${originals} originals, ${silent} silent cues`);
});

test('OpenRA-only cues: small arms impacts, OpenRA-made lines and silent powers stay quiet with Red Alert installed', () => {
  const bank = installedBank();
  // OpenRA's weapons without ImpactSounds or Report.
  assert.equal(bank.resolve(impactSound('M1Carbine', false)), null, 'a rifle bullet lands without a sound');
  assert.equal(bank.resolve(fireSound('FireballLauncher')), null, 'no Report');
  assert.equal(bank.resolve(impactSound('FireballLauncher', false)).original, true, 'firebl3');
  // Speech OpenRA made itself (bits.txt): never in a Red Alert copy.
  for (const key of ['startGame', 'unitStolen', 'enemyDetected']) {
    assert.ok(EVA[key].originals.every((n) => OPENRA_MADE.has(n)), key);
    assert.equal(bank.keepsOriginal(EVA[key]), true, `${key}: shown as text, not spoken by WebRA`);
  }
  assert.equal(bank.keepsOriginal(EVA.harvesterAttack), true, 'empty in OpenRA RA');
  assert.equal(bank.resolve(powerSound(POWER_KINDS.indexOf('NukePower'))), null, 'no launch rumble at the silo');
  // An OpenRA actor without a VoiceSet (the Badger) says nothing.
  assert.equal(bank.resolve(voiceLine('BADR', 'aircraft', 'allies', 'select')), null);
  // The fix of the generator: warheads valid on water (Atomic: Ground, Water, Air) sound there too; subs sink with a splash.
  assert.deepEqual(WEAPON_SOUNDS.Atomic.water, WEAPON_SOUNDS.Atomic.impact);
  assert.deepEqual(deathSound('SS', 'ship').originals, ['splash9.aud']);
  assert.equal(impactSound('Heal', true).synth, null, 'a silent impact is silent on water as well');
});

test('OpenRA-made sounds from a player\'s own OpenRA install are kept by the installer', async () => {
  const store = new MemoryStore();
  const report = await installFromFiles([new File([tone()], 'bctrinit.aud'), new File([tone()], 'unitsto.aud')], store);
  assert.equal(report.added, 2);
  const bank = installedBank();
  await bank.loadInstalled(store);
  assert.equal(bank.resolve({ ...EVA.startGame, synth: null }).original, true, '"Battle control online" from OpenRA\'s bits');
});

test('C# default sounds: MAD tank, chronoshift, chrono tank and Tesla Coil charge', () => {
  assert.deepEqual(madTankSounds('QTNK', false)[0].originals, ['madchrg2.aud'], 'MadTank.ChargeSound');
  assert.deepEqual(madTankSounds('QTNK', true).map((s) => s.originals), [['madexplo.aud'], ['mineblo1.aud']], 'DetonationSound and MADTankDetonate');
  assert.deepEqual(teleportSound('2TNK', false).originals, ['chrono2.aud'], 'Chronoshiftable.ChronoshiftSound');
  assert.deepEqual(teleportSound('CTNK', true).originals, ['chrotnk1.aud'], 'PortableChrono.ChronoshiftSound');
  assert.deepEqual(fireChargeSound('TSLA').originals, ['tslachg2.aud'], 'AttackTesla.ChargeAudio');
  assert.equal(fireChargeSound('1TNK'), null);
  for (const n of ['madchrg2.aud', 'madexplo.aud', 'chrono2.aud', 'chrotnk1.aud', 'tslachg2.aud']) assert.ok(allOriginalNames().includes(n), n);
  // The director plays them where they happen.
  const rules = { actors: [{ id: 'QTNK', kind: 'vehicle' }, { id: 'CTNK', kind: 'vehicle' }, { id: 'TSLA', kind: 'building' }], weapons: ['TeslaZap'] };
  const effects = [];
  let t = 0;
  const d = new Director({ rules, player: 0, side: 'allies', pxPerWorld: 1, lookup: () => null, sink: { effect: (s) => effects.push(s.originals), voice() {}, announce() {} }, now: () => (t += 1) });
  const view = { x0: 0, y0: 0, x1: 1000, y1: 600 };
  d.onEvents([EV.MAD_TANK, 0, 500, 300, 0, 0], view);
  d.onEvents([EV.MAD_TANK, 0, 500, 300, 0, 1], view);
  d.onEvents([EV.TELEPORTED, 1, 100, 300, 0, 1, EV.TELEPORTED, 1, 600, 300, 0, 1], view);
  d.onEvents([EV.FIRE, 0, 500, 300, 0, 2], view);
  assert.deepEqual(effects.map((o) => o.join()).sort(), ['chrotnk1.aud', 'chrotnk1.aud', 'madchrg2.aud', 'madexplo.aud', 'mineblo1.aud', 'tesla1.aud', 'tslachg2.aud']);
});

test('without installed sounds, or with them switched off, WebRA plays its own sounds', () => {
  const none = installedBank({ skip: () => true });
  const off = installedBank({ original: false });
  for (const bank of [none, off]) {
    assert.equal(bank.usingOriginals, false);
    assert.equal(bank.resolve(impactSound('M1Carbine', false)).original, false, 'our hit');
    assert.equal(bank.keepsOriginal(EVA.startGame), false, 'our chime and voice say "Battle control online"');
  }
  // A partial install: a Red Alert file that is not installed falls back to ours.
  const partial = installedBank({ skip: (n) => n === 'cannon1.aud' });
  assert.equal(partial.resolve(fireSound('90mm')).original, false);
  assert.equal(partial.resolve(impactSound('90mm', false)).original, true, 'kaboom12 is installed');
});

// ---- The first sounds of a game -----------------------------------------------------------

/** An audio system whose installed sounds load when `release()` is called, with recording mixer and speech. */
async function slowAudio(names) {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  await audio.loaded;
  const store = new MemoryStore();
  await store.putAll(names.map((name) => ({ name, bytes: tone().buffer })));
  let release;
  const gate = new Promise((r) => (release = r));
  audio.store = async () => ({ getAll: async (f) => (await gate, store.getAll(f)), names: () => store.names() });
  const played = [];
  const spoken = [];
  audio.mixer.ctx = { state: 'running', sampleRate: 22050 };
  audio.mixer.buffer = (samples) => ({ length: samples.length });
  audio.mixer.apply = () => {};
  audio.mixer.play = (buffer, opts) => (played.push([buffer.length, opts.bus]), { ended: Promise.resolve(), stop() {} });
  audio.speech = { available: true, speaking: false, speak: async (text) => spoken.push(text), cancel() {} };
  const loading = audio.reloadInstalled();
  return { audio, played, spoken, release: async () => (release(), await loading) };
}

test('sounds and announcer lines asked for while the installed sounds load wait for them (game start)', async () => {
  const { audio, played, spoken, release } = await slowAudio(['cannon1.aud', 'unitrdy1.aud']);
  assert.equal(audio.bank.loading, true);
  audio.effect(fireSound('90mm'));
  assert.equal(audio.notify('RadarUp'), false, 'held, not played');
  const line = audio.playAnnouncement('unitReady');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(played, [], 'nothing of ours while loading');
  await release();
  await line;
  assert.equal(audio.bank.loading, false);
  // cannon1 (held effect), radaron2 is not installed: our radar sound, then the original "Unit ready".
  assert.deepEqual(
    played.map(([, bus]) => bus),
    ['effects', 'effects', 'voices'],
  );
  assert.equal(played[0][0], 64, 'the installed cannon1');
  assert.equal(played[2][0], 64, 'the installed unitrdy1');
  assert.deepEqual(spoken, [], 'the browser speaks nothing');
});

test('"Battle control online" (made by OpenRA) is shown, not spoken by WebRA, when original sounds are in use', async () => {
  const { audio, played, spoken, release } = await slowAudio(['unitrdy1.aud']);
  await release();
  const shown = [];
  audio.onAnnounce((key) => shown.push(key));
  await audio.playAnnouncement('startGame', 0);
  audio.startGame();
  assert.deepEqual(shown, ['startGame'], 'the on-screen notification');
  assert.deepEqual(played, []);
  assert.deepEqual(spoken, []);
  // A unit reply OpenRA has, installed but audio not started yet: no browser voice in its place.
  audio.mixer.ctx = null;
  audio.voice(voiceLine('E1', 'infantry', 'allies', 'select'));
  assert.deepEqual(spoken, []);
  // Original sounds switched off: WebRA's own announcer speaks it.
  audio.mixer.ctx = { state: 'running', sampleRate: 22050 };
  audio.prefs.set({ original: false });
  await audio.playAnnouncement('startGame', 0);
  assert.deepEqual(spoken, ['Battle control online.']);
});
