// The Red Alert infantry (engine/src/infantry.rs) on the client side: their
// art, the order cursors through the wasm API, voices and death screams from
// the audio catalog, and the reusable engineers lobby option. Run after
// `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { INFANTRY_DRAW, INFANTRY_PRONE, INFANTRY_SPECIALS } from '../js/art/infantry.js';
import { spriteList, SPECIAL_SLOTS } from '../js/sprites.js';
import { ACTION, ACTION_CURSORS, CURSORS, CURSOR_NAMES } from '../js/cursors.js';
import { CURSOR_ART } from '../js/content/tables.js';
import { deathSound, orderVoice, producedVoice, killVoice, voiceLine, voiceSetFor, allOriginalNames } from '../js/audio/catalog.js';
import { Director, EV } from '../js/audio/director.js';
import { validateLobbyOptions } from '../../../packages/protocol/src/options.js';
import { DEFAULT_OPTIONS } from '../../../packages/protocol/src/constants.js';
import { poseTable } from '../js/content/atlas.js';
import { MODE, POSE, POSE_COUNT } from '../js/content/sequences.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));

/** The extent a drawing touches, through a recording 2D context. */
function extent(draw) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const see = (x, y) => {
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  };
  const ctx = {
    beginPath() {},
    closePath() {},
    moveTo: see,
    lineTo: see,
    fill() {},
    stroke() {},
    fillRect(x, y, w, h) {
      see(x, y);
      see(x + w, y + h);
    },
    roundRect(x, y, w, h) {
      see(x, y);
      see(x + w, y + h);
    },
    arc(x, y, r) {
      see(x - r, y - r);
      see(x + r, y + r);
    },
  };
  draw(ctx, { team: () => '#888', c: (c) => c });
  return box;
}

test('every new soldier has standing art, and those that take cover prone art, within their boxes', () => {
  for (const id of ['E2', 'E4', 'E6', 'E7', 'DOG', 'MEDI', 'MECH', 'SPY', 'THF', 'SHOK']) assert.ok(INFANTRY_DRAW[id], id);
  for (const id of ['E2', 'E4', 'E6', 'E7', 'MEDI', 'MECH', 'SPY', 'SHOK']) assert.ok(INFANTRY_PRONE[id], `${id} goes prone (TakeCover)`);
  const draws = [...Object.values(INFANTRY_DRAW).map((d) => d.body), ...Object.values(INFANTRY_PRONE), ...INFANTRY_SPECIALS];
  for (const [w, h, draw] of draws) {
    const b = extent(draw);
    assert.ok(b.minX >= -0.01 && b.minY >= -0.01 && b.maxX <= w + 0.01 && b.maxY <= h + 0.01, `art leaves its ${w}x${h} box`);
  }
  assert.ok(INFANTRY_SPECIALS.length <= SPECIAL_SLOTS);
});

test('the sprite list draws every infantry type, no proxies, and has the infantry specials', () => {
  const actors = rules.actors.map((a) => ({ ...a, width: a.building?.width, height: a.building?.height }));
  const list = spriteList(actors);
  actors.forEach((a, k) => {
    if (a.kind === 'infantry') assert.ok(list[2 * k], `${a.id} has a body`);
    if (a.kind === 'proxy') assert.deepEqual([list[2 * k], list[2 * k + 1]], [null, null], `${a.id} has no body`);
  });
  // engine/src/render.rs SpriteIds::infantry_base: 12 built-in specials, then the ninth module
  // (after decorations, effects and leftovers).
  const base = actors.length * 2 + 12 + 8 * SPECIAL_SLOTS;
  INFANTRY_SPECIALS.forEach((s, k) => assert.equal(list[base + k], s));
});

test('pose tables give soldiers stand variants, idle animations and deaths that vanish', () => {
  const desc = (mode, n) => ({ frames: [n], length: 1, facings: 1, fps: 10, mode, classic: false, interpolatedFacings: 0, rotate: false });
  const have = (n) => ({ loop: desc(MODE.LOOP, n), once: desc(MODE.ONCE, n), still: desc(MODE.STILL, n), index: desc(MODE.INDEX, n), vanish: desc(MODE.VANISH, n) });
  const poses = poseTable({ idle: have(0), stand2: have(1), idle1: have(2), die1: have(3), die5: have(4), crushed: have(5) });
  assert.equal(poses.length, POSE_COUNT);
  assert.equal(poses[POSE.STAND2].frames[0], 1);
  assert.equal(poses[POSE.IDLE1].mode, MODE.ONCE);
  assert.equal(poses[POSE.IDLE2].frames[0], 2, 'idle2 falls back to idle1');
  assert.equal(poses[POSE.DIE5].frames[0], 4);
  assert.equal(poses[POSE.DIE6].frames[0], 3, 'a missing death falls back to die1');
  assert.equal(poses[POSE.CRUSHED].mode, MODE.VANISH);
});

test('infantry order cursors come through Game.cursor_action', () => {
  // Each infantry cursor has WebRA art and Red Alert art under its OpenRA name (mods/ra/cursors.yaml).
  for (const key of ['enter', 'enterBlocked', 'c4', 'heal', 'goldwrench', 'goldwrenchBlocked', 'ability']) {
    assert.ok(CURSORS[key], key);
    assert.ok(CURSOR_ART[CURSOR_NAMES[key]], `${key}: ${CURSOR_NAMES[key]}`);
  }
  const game = Game.from_options(JSON.stringify({ ...DEFAULT_OPTIONS, seed: 3, mapSize: 64, startingUnits: 'base', players: [{ type: 'human', faction: 'england' }, { type: 'human', faction: 'russia' }] }));
  // The engine's codes and the cursor table agree.
  assert.equal(ACTION_CURSORS[ACTION.CAPTURE], CURSORS.enter);
  assert.equal(ACTION_CURSORS[ACTION.CAPTURE_OUTSIDE], CURSORS.ability);
  assert.equal(ACTION_CURSORS[ACTION.ENTER_BLOCKED], CURSORS.enterBlocked);
  assert.equal(ACTION_CURSORS[ACTION.REPAIR_BLOCKED], CURSORS.goldwrenchBlocked);
  const json = JSON.parse(game.rules_json());
  const spy = json.actors.find((a) => a.id === 'SPY');
  assert.ok(spy.disguise && spy.infiltrates);
  assert.equal(json.actors.find((a) => a.id === 'E7').buildLimit, 1);
  assert.ok(json.actors.find((a) => a.id === 'MEDI').heals);
  game.free();
});

test('voice sets come from OpenRA: order lines, Tanya laughs and quips, screams follow the death', () => {
  assert.equal(voiceSetFor('E6', 'infantry'), 'EngineerVoice');
  assert.equal(voiceSetFor('DOG', 'infantry'), 'DogVoice');
  assert.equal(orderVoice('E7', 'demolish'), 'demolish');
  assert.equal(orderVoice('SHOK', 'attack'), 'attack');
  assert.equal(orderVoice('E1', 'move'), 'action');
  assert.deepEqual(voiceLine('E7', 'infantry', 'allies', 'demolish').originals, ['keepem1.aud', 'tuffguy1.aud']);
  assert.deepEqual(voiceLine('E1', 'infantry', 'soviet', 'select').originals.slice(0, 2), ['await1.r01', 'await1.r03']);
  assert.equal(voiceLine('E1', 'infantry', 'allies', 'demolish'), null, 'GenericVoice has no Demolish line');
  assert.equal(producedVoice('E7'), 'build');
  assert.equal(killVoice('E7'), 'kill');
  assert.equal(killVoice('E1'), null);
  assert.deepEqual(deathSound('E1', 'infantry', 5).originals, ['dedman10.aud'], 'FireDeath: Burned');
  assert.deepEqual(deathSound('E1', 'infantry', 6).originals, ['dedman6.aud'], 'ElectricityDeath: Zapped');
  assert.deepEqual(deathSound('DOG', 'infantry', 1).originals, ['dogw5.aud', 'dogw7.aud']);
  const names = new Set(allOriginalNames());
  for (const n of ['eengin1.aud', 'laugh1.aud', 'dogw3px.aud', 'jjuice1.aud', 'bldginf1.aud', 'sonpulse.aud']) assert.ok(names.has(n), n);
});

test('the director plays order lines, death screams and infantry notifications', () => {
  const voices = [];
  const effects = [];
  const announced = [];
  let t = 0;
  const actors = rules.actors.map((a) => ({ id: a.id, kind: a.kind }));
  const ty = (id) => actors.findIndex((a) => a.id === id);
  const d = new Director({
    rules: { actors, weapons: rules.weapons.map((w) => w.name) },
    player: 0,
    side: 'allies',
    pxPerWorld: 1,
    lookup: (id) => ({ type: id === 1 ? 'E7' : 'E1', owner: 0, building: false }),
    sink: { effect: (s) => effects.push(s), voice: (v) => voices.push(v), announce: (k) => announced.push(k) },
    now: () => t,
  });
  d.noteSmartAction(ACTION.DEMOLISH);
  d.onOrder([1], 'order_smart');
  assert.deepEqual(voices.pop().originals, ['keepem1.aud', 'tuffguy1.aud'], 'C4 order: Demolish');
  t += 1;
  d.onOrder([1], 'order_move');
  assert.ok(voices.pop().originals.includes('onit1.aud'), 'move: Move');
  t += 1;
  const view = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  d.onEvents([EV.DEATH, ty('E1'), 0, 0, 1, 1 | (5 << 8)], view);
  assert.ok(effects.some((s) => s.originals.includes('dedman10.aud')), 'burned scream');
  // A thief of player 1 in our refinery (sound_events.rs infiltrator_code).
  d.onEvents([EV.INFILTRATED, ty('PROC'), 0, 0, 0, (ty('THF') << 8) | 1], view);
  assert.ok(announced.includes('creditsStolen'));
  t += 1;
  d.onEvents([EV.KILL_ANNOUNCED, ty('E7'), 0, 0, 0, 0], view);
  assert.ok(voices.pop().originals.includes('gotit1.aud'), 'AnnounceOnKill');
});

test('the reusable engineers option is a lobby option, off by default', () => {
  assert.equal(DEFAULT_OPTIONS.reusableEngineers, false);
  const { reusableEngineers: _r, ...rest } = DEFAULT_OPTIONS;
  assert.throws(() => validateLobbyOptions(rest), /reusableEngineers/);
  assert.equal(validateLobbyOptions({ ...DEFAULT_OPTIONS, reusableEngineers: true }).reusableEngineers, true);
});

test('composed sequences (OpenRA Combine) index the parts one after the other, offsets and flips applied', async () => {
  const { sequenceFrames, flipFrame } = await import('../js/content/atlas.js');
  const { resolveSequence } = await import('../js/content/sequences.js');
  const { SEQUENCES, ACTOR_ART } = await import('../js/content/tables.js');
  // Tanya fires both pistols: her shoot-left is made of five parts of e7.shp.
  const def = SEQUENCES.e7['shoot-left'];
  assert.equal(ACTOR_ART.E7.body.attack, 'shoot-left');
  assert.equal(def.parts.length, 5);
  const frame = (n) => ({ width: 2, height: 1, data: Uint8Array.from([n, 0]) });
  const sprite = { frames: Array.from({ length: 240 }, (_, n) => frame(n)) };
  const files = { get: (name) => (name === 'e7.shp' ? { sprite } : { sprite: null, error: 'missing' }) };
  const src = sequenceFrames(def, files, 'TEMPERAT');
  assert.equal(src.frames.length, 16, '8 + 2 + 2 + 2 + 2 frames');
  const r = resolveSequence(def, src.frames.length);
  assert.equal(r.facings, 8);
  // Facing 0 is the first part's first two frames, facing 4 the second part (offset 1, 0).
  assert.deepEqual([0, 1].map((k) => src.frames[r.fileFrames[k]].frame.data[0]), [58, 56]);
  assert.deepEqual(src.frames[r.fileFrames[4 * 2]].frame.data[0], 85);
  assert.deepEqual(src.frames[r.fileFrames[4 * 2]].offset, [1, 0]);
  assert.deepEqual(Array.from(flipFrame(frame(7), true, false).data), [0, 7], 'FlipX mirrors');
  assert.ok(sequenceFrames(def, { get: () => ({ sprite: null, error: 'missing' }) }, 'TEMPERAT').error);
});
