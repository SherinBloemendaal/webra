// OpenRA's other lobby options and what battles leave in the client: the
// battlefield effects (js/battlefx.js) and their event kinds, the art of crates, husks and leftover
// specials (js/art/leftovers.js, js/content) and the engine API through wasm.
// Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { ShakeState, FlashState, FloatingTexts, FLOAT_TICKS, formatClock, motionReduced, cashText, BattleFx, FX } from '../js/battlefx.js';
import { EV } from '../js/audio/director.js';
import { spriteList } from '../js/sprites.js';
import { CRATE_DRAW, LEFTOVER_SPECIALS, LEFTOVER_SPECIAL_OFFSET, huskBase } from '../js/art/leftovers.js';
import { ACTOR_ART, SEQUENCES, SMUDGES, SPECIAL_ART } from '../js/content/tables.js';
import { originalSlots, specialSlot } from '../js/content/atlas.js';
import { originalTerrain, SMUDGE_TILE_BASE, SMUDGE_VARIANTS, SMUDGE_DEPTHS, ART_SMUDGES, ATLAS_COLS, ORIGINAL_TILE } from '../js/content/terrain.js';
import { buildShp, buildPal, buildTmpRa, testFrame } from './content-fixtures.mjs';
import { TERRAIN } from '../js/content/tables.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const TERRAIN_WGSL = readFileSync(fileURLToPath(new URL('../shaders/terrain.wgsl', import.meta.url)), 'utf8');

const OPTIONS = {
  seed: 7,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'A', faction: 'england', color: 0, team: 0 },
    { slot: 1, type: 'ai', difficulty: 'easy', faction: 'russia', color: 1, team: 0 },
  ],
  startingCash: 5000,
  startingUnits: 'mcv',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: true,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
  cheats: false,
  crates: true,
  shortGame: true,
  bounty: true,
  separateTeamSpawns: true,
  allyBuildRadius: true,
  timeLimit: 10,
};

// ---- js/battlefx.js -------------------------------------------------------------------

test('screen shake follows OpenRA ScreenShaker: distance, multiplier, expiry', () => {
  const s = new ShakeState();
  assert.deepEqual(s.offset(0, 0, 0), [0, 0]);
  s.add(0, 10, 1024, 0, 5, [1, 1]);
  const [x1] = s.offset(1, 0, 0);
  const near = Math.abs(x1);
  assert.ok(near > 0 && near <= 10, 'capped at intensity 10');
  // Far away: weaker.
  const far = new ShakeState();
  far.add(0, 10, 100 * 1024, 0, 5, [1, 1]);
  assert.ok(Math.abs(far.offset(1, 0, 0)[0]) < near);
  // A [1, 0] multiplier (MAD tank thump) shakes sideways only.
  const side = new ShakeState();
  side.add(0, 10, 0, 0, 3, [1, 0]);
  assert.equal(Math.abs(side.offset(3, 0, 0)[1]), 0);
  // Gone after its duration.
  assert.deepEqual(s.offset(10, 0, 0), [0, 0]);
});

test('the flash fades out over its ticks, dimmer with reduced motion', () => {
  const f = new FlashState();
  f.add(100, 20);
  assert.equal(f.alpha(100), 1);
  assert.equal(f.alpha(110), 0.5);
  assert.equal(f.alpha(120), 0);
  assert.ok(f.alpha(100, true) < 0.5);
});

test('floating cash rises and fades; clocks and settings', () => {
  const t = new FloatingTexts();
  t.add(0, cashText(1000), 50, 80, 'red');
  const [a] = t.visible(0);
  assert.deepEqual([a.text, a.y, a.opacity], ['+$1,000', 80, 1]);
  assert.ok(t.visible(FLOAT_TICKS / 2)[0].y < 80);
  assert.equal(t.visible(FLOAT_TICKS).length, 0);
  assert.equal(cashText(-250), '-$250');
  assert.equal(formatClock(25 * 65, 25), '1:05');
  assert.equal(formatClock(28 * 3600 + 1, 28), '1:00:01');
  assert.equal(formatClock(-5, 25), '0:00');
  assert.equal(motionReduced('auto', true), true);
  assert.equal(motionReduced('auto', false), false);
  assert.equal(motionReduced('on', false), true);
  assert.equal(motionReduced('off', true), false);
});

test('BattleFx turns engine events into floats, lines, shake and flash', () => {
  installDom();
  try {
    const lines = [];
    const field = document.createElement('div');
    const rules = { actors: [{ id: 'CRATE', crateActions: [{ kind: 'GiveCash', amount: 1000 }] }] };
    const fx = new BattleFx({
      field,
      rules,
      pxPerWorld: 24 / 1024,
      allied: (o) => o === 0,
      colorOf: () => 'rgb(1, 2, 3)',
      nameOf: (o) => `P${o}`,
      line: (text) => lines.push(text),
      reduced: () => false,
    });
    const ev = (...e) => e;
    fx.onEvents(
      [
        ...ev(FX.CRATE_COLLECTED, 1, 1024, 1024, 0, 0),
        ...ev(FX.BOUNTY, 150, 2048, 0, 1, 0), // an enemy's bounty: not shown
        ...ev(FX.BOUNTY, 90, 2048, 0, 0, 0),
        ...ev(FX.TIME_LIMIT_EXPIRED, 0, 0, 0, 255, 0),
        ...ev(FX.PLAYER_LOST, 0, 0, 0, 1, 0),
        ...ev(FX.SCREEN_SHAKE, 20, 0, 0, 1 + 16, 5),
        ...ev(FX.FLASH, 20, 0, 0, 0, 1),
      ],
      0,
    );
    assert.deepEqual(fx.texts.visible(0).map((t) => t.text), ['+$1,000', '+$90']);
    assert.deepEqual(lines, ['Time limit has expired.', 'P1 is defeated.']);
    assert.notDeepEqual(fx.cameraOffset(1, 0, 0), [0, 0]);
    assert.ok(fx.flash.alpha(0) > 0.9);
    fx.timeLimit({ timeLimit: { left: 25 * 90, ticksPerSecond: 25 } });
    assert.equal(fx.clock.hidden, false);
    assert.equal(fx.clock.textContent, 'Time left 1:30');
    fx.timeLimit({ timeLimit: null });
    assert.equal(fx.clock.hidden, true);
    fx.reduced = () => true;
    assert.deepEqual(fx.cameraOffset(2, 0, 0), [0, 0], 'reduce motion: no shake');
  } finally {
    uninstallDom();
  }
});

// ---- Announcer and sounds ---------------------------------------------------------------

test('battlefield effect kinds follow the engine and stay apart from the announcer kinds', () => {
  assert.equal(FX.CRATE_COLLECTED, EV.CRATE_COLLECTED, 'one crate event for floats and sounds');
  const announcer = new Set(Object.values(EV));
  for (const [name, kind] of Object.entries(FX)) {
    if (name !== 'CRATE_COLLECTED') assert.ok(!announcer.has(kind), `${name} ${kind} is not an announcer kind`);
  }
  // The effect kinds are one block no announcer kind falls into (later kinds,
  // such as KillAnnounced 43, follow it).
  const effects = Object.values(FX).filter((k) => k !== FX.CRATE_COLLECTED);
  const [lo, hi] = [Math.min(...effects), Math.max(...effects)];
  for (const k of announcer) assert.ok(k < lo || k > hi, `announcer kind ${k} is outside the effect kinds ${lo}..${hi}`);
});

// ---- Art ---------------------------------------------------------------------------------

/** The bounding box of what `draw` paints. */
function bounds(draw) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  let tx = 0;
  let ty = 0;
  const see = (x, y) => {
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    minX = Math.min(minX, x + tx);
    minY = Math.min(minY, y + ty);
    maxX = Math.max(maxX, x + tx);
    maxY = Math.max(maxY, y + ty);
  };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    beginPath() {},
    closePath() {},
    moveTo: see,
    lineTo: see,
    fill() {},
    stroke() {},
    translate(x, y) {
      tx += x;
      ty += y;
    },
    roundRect(x, y, w, h) {
      see(x, y);
      see(x + w, y + h);
    },
    fillRect(x, y, w, h) {
      see(x, y);
      see(x + w, y + h);
    },
    arc(x, y, r) {
      see(x - r, y - r);
      see(x + r, y + r);
    },
  };
  draw(ctx, { team: () => '#888', c: (c) => c });
  return [minX, minY, maxX, maxY];
}

test('crates, husks and the leftover specials have WebRA art within their boxes', () => {
  const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));
  const actors = rules.actors.map((a) => ({ ...a, width: a.building?.width, height: a.building?.height }));
  const list = spriteList(actors);
  for (const [t, a] of actors.entries()) {
    if (a.kind === 'crate') {
      assert.ok(list[2 * t] && list[2 * t + 1], `${a.id}: land and water`);
      assert.equal(list[2 * t], (CRATE_DRAW[a.id] ?? CRATE_DRAW.CRATE).body);
    }
    if (a.kind === 'husk') {
      assert.ok(list[2 * t], `${a.id} has a wreck`);
      assert.equal(list[2 * t + 1], null, 'no turret on a husk');
      assert.ok(actors.some((b) => b.id === huskBase(a.id)), `${a.id} is the wreck of ${huskBase(a.id)}`);
    }
  }
  const base = actors.length * 2 + LEFTOVER_SPECIAL_OFFSET;
  LEFTOVER_SPECIALS.forEach((s, k) => assert.equal(list[base + k], s));
  for (const [w, h, draw] of [...LEFTOVER_SPECIALS, ...Object.values(CRATE_DRAW).flatMap((d) => [d.body, d.turret])]) {
    const [x0, y0, x1, y1] = bounds(draw);
    assert.ok(x0 >= -0.01 && y0 >= -0.01 && x1 <= w + 0.01 && y1 <= h + 0.01, `art leaves its ${w}x${h} box: ${x0},${y0} ${x1},${y1}`);
  }
});

test('original art: crates on land and water, husks, smudges and the leftover specials', () => {
  assert.deepEqual(ACTOR_ART.CRATE.body, { idle: 'land' });
  assert.deepEqual(ACTOR_ART.CRATE.second, { idle: 'water' });
  assert.equal(SEQUENCES.scrate.water.file, 'wwcrate.shp');
  assert.equal(ACTOR_ART.MONEYCRATE.image, 'wcrate');
  assert.equal(ACTOR_ART['2TNK.Husk'].image, '2tnk.destroyed');
  assert.equal(SEQUENCES.hhusk.idle.file, 'harv.shp', 'Red Alert has no ore truck husk: the truck stands in');
  assert.equal(SMUDGES.scorch.length, SMUDGE_VARIANTS);
  assert.equal(SMUDGES.crater.length, SMUDGE_VARIANTS);
  // The leftover specials are the art module "leftovers" of SPECIAL_ART.
  LEFTOVER_SPECIALS.forEach((_, k) => {
    assert.ok(`leftovers.${k}` in SPECIAL_ART, `leftovers.${k}`);
    assert.equal(specialSlot(`leftovers.${k}`, 5), 10 + LEFTOVER_SPECIAL_OFFSET + k);
  });
  assert.deepEqual(SPECIAL_ART['leftovers.0'], { image: 'fire', sequences: ['1'], mode: 'loop' });
  assert.equal(SEQUENCES.fire['1'].file, 'fire1.shp');
  assert.equal(SPECIAL_ART['leftovers.3'], null, 'OpenRA drew the level up animation: WebRA art');
  // Installed files: the specials come out after the actors.
  const files = new Map([['temperat.pal', buildPal()], ['fire1.shp', buildShp(12, 14, [testFrame(12, 14, 3), testFrame(12, 14, 4)])]]);
  const actors = [{ id: 'CRATE', kind: 'crate' }];
  const out = originalSlots(actors, (n) => files.get(n) ?? null);
  assert.ok(out.slots.get(2 + LEFTOVER_SPECIAL_OFFSET), 'the fire');
  assert.equal(out.slots.has(2 + LEFTOVER_SPECIAL_OFFSET + 3), false, 'no level up without its file');
});

test('smudge tiles go where the terrain shader reads them', () => {
  for (const [name, v] of [['SMUDGE_TILE_BASE', SMUDGE_TILE_BASE], ['SMUDGE_VARIANTS', SMUDGE_VARIANTS], ['SMUDGE_DEPTHS', SMUDGE_DEPTHS], ['ART_SMUDGES', ART_SMUDGES]]) {
    assert.ok(new RegExp(`const ${name}: u32 = ${v}u;`).test(TERRAIN_WGSL), name);
  }
  assert.ok(SMUDGE_TILE_BASE + 2 * SMUDGE_VARIANTS * SMUDGE_DEPTHS <= 1024, 'the atlas index stays readable (R + 256 G)');
  // A minimal temperate theater with every smudge image.
  const info = TERRAIN.TEMPERAT;
  const files = new Map([[info.palette, buildPal()]]);
  const tile = (v) => ({ width: 24, height: 24, data: new Uint8Array(24 * 24).fill(v) });
  for (const [img, , , role, cells] of info.templates) {
    const name = info.images[img];
    if (files.has(name) || (role !== 'clear' && role !== 'water')) continue;
    const count = Math.max(...cells) + 1;
    files.set(name, buildTmpRa(24, 24, Array.from({ length: count }, (_, k) => (cells.includes(k) ? tile(role === 'water' ? 100 : 20 + k) : null))));
  }
  for (const def of [...SMUDGES.scorch, ...SMUDGES.crater]) files.set(def.file, buildShp(24, 24, [testFrame(24, 24, 1, { remap: false }), testFrame(24, 24, 2, { remap: false })]));
  const w = 8;
  const terrain = new Uint8Array(w * w * 4);
  for (let i = 0; i < w * w; i++) terrain[i * 4 + 3] = 255;
  const r = originalTerrain((n) => files.get(n) ?? null, 'TEMPERAT', terrain, w, w);
  assert.ok(r);
  assert.equal(r.report.smudges, true);
  assert.equal(r.atlas.flags & ART_SMUDGES, ART_SMUDGES);
  // The last crater variant's deepest level has pixels.
  const k = SMUDGE_TILE_BASE + (1 * SMUDGE_VARIANTS + SMUDGE_VARIANTS - 1) * SMUDGE_DEPTHS + SMUDGE_DEPTHS - 1;
  const px = ((Math.floor(k / ATLAS_COLS) * ORIGINAL_TILE + 12) * r.atlas.width + (k % ATLAS_COLS) * ORIGINAL_TILE + 12) * 4;
  assert.ok(r.atlas.data[px + 3] > 0);
  // Without the smudge files the shader draws its own.
  for (const def of SMUDGES.crater) files.delete(def.file);
  assert.equal(originalTerrain((n) => files.get(n) ?? null, 'TEMPERAT', terrain, w, w).atlas.flags & ART_SMUDGES, 0);
});

// ---- Through the engine ----------------------------------------------------------------------

test('the engine takes the options: crates fly in, the time limit counts down, rules describe crates', () => {
  const game = Game.from_options(JSON.stringify(OPTIONS));
  const rules = JSON.parse(game.rules_json());
  const crate = rules.actors.find((a) => a.id === 'CRATE');
  assert.equal(crate.kind, 'crate');
  assert.ok(crate.crateActions.some((a) => a.kind === 'GiveCash' && a.amount === 1000));
  assert.equal(rules.actors.find((a) => a.id === '2TNK.Husk').kind, 'husk');
  assert.equal(rules.actors.find((a) => a.id === 'WEAP').primary, true);
  assert.equal(rules.timeLimit.notifications.length, rules.timeLimit.warnings.length);
  const state = JSON.parse(game.player_json(0));
  assert.deepEqual([state.timeLimit.left, state.timeLimit.ticksPerSecond], [10 * 60 * 25, 25]);
  assert.equal(game.player_count(), 2, 'the neutral owner of the crates is no player');
  for (let t = 0; t < 1800; t++) game.tick();
  assert.ok(JSON.parse(game.player_json(0)).timeLimit.left < 10 * 60 * 25);
});
