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
import { WEAPON_SYNTH, fireSound, impactSound, deathSound, voiceLine, EVA, allOriginalNames, fileName, powerReadyLine, MUSIC } from '../js/audio/catalog.js';
import { WEAPON_SOUNDS } from '../js/audio/catalog-data.js';
import { RECIPES, render } from '../js/audio/synth.js';
import { installFromFiles, installedSummary, categoryOf } from '../js/audio/install.js';
import { MemoryStore } from '../js/audio/store.js';
import { SoundBank } from '../js/audio/bank.js';
import { shuffle, Jukebox } from '../js/audio/music.js';
import { AudioSystem, FOG_VISIBLE } from '../js/audio/index.js';
import { sineSamples, imaAud, buildMix, buildEncryptedMix, testRsaKey } from './audio-fixtures.mjs';

const wasm = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));
initSync({ module: readFileSync(wasm) });
const engineRules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));

// ---- Helpers ----------------------------------------------------------------------

const RULES = {
  actors: [
    { id: 'E1', kind: 'infantry' },
    { id: '1TNK', kind: 'vehicle' },
    { id: 'POWR', kind: 'building' },
    { id: 'DD', kind: 'ship' },
  ],
  weapons: ['M1Carbine', '25mm', 'Atomic', 'TorpTube'],
};
const VIEW = { x0: 0, y0: 0, x1: 1000, y1: 600 };

function harness({ player = 0, actors = {} } = {}) {
  let t = 100;
  const calls = { effects: [], voices: [], announce: [] };
  const sink = {
    effect: (sound, opts) => calls.effects.push({ sound, ...opts }),
    voice: (line) => calls.voices.push(line),
    announce: (key) => calls.announce.push(key),
  };
  const d = new Director({
    rules: RULES,
    player,
    side: 'allies',
    pxPerWorld: 1,
    lookup: (id) => actors[id] ?? null,
    sink,
    now: () => t,
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
  for (const e of Object.values(EVA)) assert.ok(RECIPES[e.chime], `${e.chime} chime`);
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
  for (const key of ['building', 'training', 'unitReady', 'insufficientFunds', 'lowPower', 'baseUnderAttack', 'unitLost', 'structureSold', 'selectTarget', 'powerReady']) {
    assert.ok(EVA[key]?.text, key);
  }
  assert.equal(powerReadyLine('NukePower'), 'nukeReady');
  assert.equal(powerReadyLine('ParatroopersPower'), 'powerReady');
  const names = allOriginalNames();
  for (const n of ['conscmp1.aud', 'cannon1.aud', 'ackno.v01', 'vehic1.r02', 'hell226m.aud', 'placbldg.aud', 'cashturn.aud']) assert.ok(names.includes(n), n);
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
      [EV.BUILDING_DAMAGED, 2, 500, 300, 0, 0],
      [EV.BUILDING_DAMAGED, 2, 500, 300, 1, 0],
      [EV.DEATH, 1, 500, 300, 0, 2],
      [EV.DEATH, 2, 500, 300, 0, 0],
      [EV.DEATH, 0, 500, 300, 1, 1],
      [EV.POWER_ACTIVATED, 1, 500, 300, 1, 0],
    ),
    VIEW,
  );
  assert.deepEqual(calls.announce, ['unitReady', 'constructionComplete', 'insufficientFunds', 'structureSold', 'baseUnderAttack', 'unitLost', 'nukeLaunched']);
  const synths = calls.effects.map((e) => e.sound.synth);
  assert.ok(synths.includes('sell') && synths.includes('explosion_building') && synths.includes('infantry_die'));
});

test('announcements respect their cooldowns', () => {
  const { d, calls, advance } = harness();
  const attack = ev([EV.BUILDING_DAMAGED, 2, 0, 0, 0, 0]);
  d.onEvents(attack, VIEW);
  advance(5);
  d.onEvents(attack, VIEW);
  assert.equal(calls.announce.length, 1, 'base under attack is throttled');
  advance(EVA.baseUnderAttack.cooldown);
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

test('production clicks, low power and ready powers', () => {
  const { d, calls, advance } = harness();
  d.onProductionStarted('E1');
  advance(1);
  d.onProductionStarted('POWR');
  d.onProductionCancelled();
  d.onSelectTarget();
  assert.deepEqual(calls.announce, ['training', 'building', 'cancelled', 'selectTarget']);
  calls.announce.length = 0;
  const power = (ready) => ({ key: 'nuke', kind: 'NukePower', ready });
  d.onPlayerState({ lowPower: true, powers: [power(true)] });
  assert.deepEqual(calls.announce, [], 'the first state only sets the baseline');
  d.onPlayerState({ lowPower: false, powers: [power(false)] });
  d.onPlayerState({ lowPower: true, powers: [power(true)] });
  assert.deepEqual(calls.announce, ['lowPower', 'nukeReady']);
  d.onPlayerState({ lowPower: true, powers: [power(true)] });
  assert.equal(calls.announce.length, 2, 'only on changes');
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
  audio.jukebox = { userStop: () => calls.push('stop'), togglePause: () => calls.push('pause'), prev: () => calls.push('prev'), next: () => calls.push('next') };
  for (const c of ['stop', 'pause', 'prev', 'next']) audio.music(c);
  assert.deepEqual(calls, ['stop', 'pause', 'prev', 'next']);
});

// ---- Wiring ----------------------------------------------------------------------------------------

test('local orders and production through the watched game get replies', () => {
  const calls = [];
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  audio.director = { onOrder: (ids) => calls.push(['order', ids]), onProductionStarted: (id) => calls.push(['build', id]), onProductionCancelled: () => calls.push(['cancel']) };
  const game = {
    n: 0,
    order_move(player, ids) {
      this.n++;
      return 'moved';
    },
    start_production() {},
    cancel_production() {},
    pick() {
      return this.n;
    },
  };
  const ui = audio.watch(game);
  assert.equal(ui.order_move(0, Uint32Array.from([5, 6]), 1, 2, false), 'moved');
  ui.start_production(0, 'E1', 1);
  ui.cancel_production(0, 'E1');
  assert.equal(ui.pick(), 1, 'other methods pass through with the right this');
  assert.equal(ui.order_move, ui.order_move, 'wrappers are cached');
  assert.deepEqual(calls, [['order', [5, 6]], ['build', 'E1'], ['cancel']]);
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
