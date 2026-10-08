// The GPU instance pass, checked on the CPU: js/crowd.js runs the math and
// the stable compaction of shaders/instances.wgsl on tick-rate records from
// Game.build_render_records, and must draw what Game.build_render draws for
// the same alpha and view: the same instances in the same order, bit for bit
// (sprites whose arm turns with a hull or rotor: within 1/1000 px, since sin
// and cos differ between the engine's libm and JavaScript). WebGPU itself
// cannot run here; this covers the formula, the culling and the compaction.
// Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import {
  chooseInstancePath,
  evalFrame,
  INSTANCE_FLOATS,
  instanceLines,
  RECT_REC_FLOATS,
  recordBytes,
  runPass,
  spriteHasArm,
  SPRITE_EXTRA_FLOATS,
  SPRITE_REC_FLOATS,
  WORKGROUP,
} from '../js/crowd.js';

const wasm = initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const f32 = (ptr, len) => new Float32Array(wasm.memory.buffer, ptr, len).slice();

/** The records `game` sends for `view` (a copy). */
function records(game, view) {
  const n = game.build_render_records(view);
  return {
    gen: 1,
    sprites: f32(game.record_ptr(), n * SPRITE_REC_FLOATS),
    extras: f32(game.record_extra_ptr(), game.record_extra_count() * SPRITE_EXTRA_FLOATS),
    rects: f32(game.rect_record_ptr(), game.rect_record_count() * RECT_REC_FLOATS),
  };
}

/** What the CPU path draws (a copy). */
function cpuFrame(game, view, alpha, rect) {
  const n = game.build_render(view, alpha, ...rect);
  return { sprites: f32(game.sprite_ptr(), n * INSTANCE_FLOATS), rects: f32(game.rect_ptr(), game.rect_count() * INSTANCE_FLOATS) };
}

/** Indices of the sprite records the pass draws, in order (to know which ones turn an arm). */
function drawnSprites(recs, alpha, rect) {
  const marked = { sprites: recs.sprites.slice(), extras: recs.extras, rects: new Float32Array(0) };
  // Tag each record's sprite id with its index; the pass copies it through.
  for (let i = 0; i < marked.sprites.length / SPRITE_REC_FLOATS; i++) marked.sprites[i * SPRITE_REC_FLOATS + 7] = i;
  const out = evalFrame(marked, alpha, rect);
  return Array.from({ length: out.spriteCount }, (_, k) => out.sprites[k * INSTANCE_FLOATS + 3]);
}

const bits = (a) => new Uint32Array(a.buffer, a.byteOffset, a.length);

function assertSameFrame(game, view, rect, alpha, label) {
  const recs = records(game, view);
  const cpu = cpuFrame(game, view, alpha, rect);
  const gpu = evalFrame(recs, alpha, rect);
  assert.equal(gpu.spriteCount * INSTANCE_FLOATS, cpu.sprites.length, `${label}: sprite count`);
  assert.equal(gpu.rectCount * INSTANCE_FLOATS, cpu.rects.length, `${label}: rect count`);
  assert.deepEqual(bits(gpu.rects), bits(cpu.rects), `${label}: rects`);
  const a = bits(gpu.sprites);
  const b = bits(cpu.sprites);
  let source = null;
  let armed = 0;
  for (let k = 0; k < gpu.spriteCount; k++) {
    const o = k * INSTANCE_FLOATS;
    let same = true;
    for (let j = 0; j < INSTANCE_FLOATS; j++) same &&= a[o + j] === b[o + j];
    if (same) continue;
    source ??= drawnSprites(recs, alpha, rect);
    const i = source[k];
    assert.ok(spriteHasArm(recs.sprites, recs.extras, i), `${label}: sprite ${k} (record ${i}) differs: ${gpu.sprites.slice(o, o + 8)} vs ${cpu.sprites.slice(o, o + 8)}`);
    armed++;
    // Only the position moves with sin and cos; everything else is exact.
    assert.ok(Math.abs(gpu.sprites[o] - cpu.sprites[o]) < 1e-3 && Math.abs(gpu.sprites[o + 1] - cpu.sprites[o + 1]) < 1e-3, `${label}: arm sprite ${k}`);
    for (let j = 2; j < INSTANCE_FLOATS; j++) assert.equal(a[o + j], b[o + j], `${label}: arm sprite ${k} field ${j}`);
  }
  return { sprites: gpu.spriteCount, rects: gpu.rectCount, armed };
}

const ALPHAS = [0, 0.2, 0.5, 0.73, 1];

test('records of a stress battle evaluate to what build_render draws, at every alpha and view', () => {
  const size = 96;
  const game = Game.new_stress(5, 3000, size);
  const whole = [0, 0, size * 24, size * 24];
  const views = [whole, [600, 500, 1400, 1100], [-200, -100, 700, 520], [1900, 1800, 2400, 2400]];
  let drawn = 0;
  for (let t = 0; t < 120; t++) {
    game.tick();
    if (t % 30 !== 29) continue;
    for (const rect of views) for (const alpha of ALPHAS) drawn += assertSameFrame(game, 0, rect, alpha, `tick ${t} alpha ${alpha} view ${rect}`).sprites;
  }
  assert.ok(drawn > 10000, `${drawn} sprites compared`);
});

test('records of a skirmish with selection, hover, all health bars and the observer view match', () => {
  const options = {
    seed: 99,
    mapSize: 64,
    players: [
      { slot: 0, type: 'ai', difficulty: 'normal', faction: 'england', color: 0, team: 0 },
      { slot: 1, type: 'ai', difficulty: 'normal', faction: 'russia', color: 1, team: 0 },
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
    cheats: false,
  };
  const game = Game.from_options(JSON.stringify(options));
  game.set_health_bars(2);
  const whole = [0, 0, 64 * 24, 64 * 24];
  let rects = 0;
  let sprites = 0;
  for (let t = 0; t < 7500; t++) {
    game.tick();
    if (t % 1500 !== 1499) continue;
    const own = game.select_box(0, -1e9, -1e9, 1e9, 1e9);
    game.set_selection(own);
    if (own.length) game.set_hover(own[0]);
    for (const view of [0, 1, Game.observer_player()]) {
      for (const alpha of [0, 0.4, 1]) {
        const n = assertSameFrame(game, view, whole, alpha, `tick ${t} view ${view} alpha ${alpha}`);
        rects += n.rects;
        sprites += n.sprites;
        assertSameFrame(game, view, [300, 300, 900, 800], alpha, `tick ${t} view ${view} alpha ${alpha} window`);
      }
    }
  }
  assert.ok(rects > 500 && sprites > 300, `${rects} rects and ${sprites} sprites compared`);
});

test('the compaction keeps record order across workgroup blocks and counts the indirect draw', () => {
  for (const count of [0, 1, WORKGROUP - 1, WORKGROUP, WORKGROUP + 1, 3 * WORKGROUP + 17, 70000]) {
    // Records on a line; every third one off screen.
    const recs = new Float32Array(count * SPRITE_REC_FLOATS);
    for (let i = 0; i < count; i++) {
      const b = i * SPRITE_REC_FLOATS;
      const x = i % 3 === 0 ? -1000 : (i % 500) * 2;
      recs.set([x, 10, x, 10, 0, 0, 0, i, 0, 1, 1, 0, -1], b);
    }
    const { instances, count: drawn, args } = runPass('sprite', recs, new Float32Array(0), count, 0.5, [0, 0, 1000, 100]);
    const expected = [];
    for (let i = 0; i < count; i++) if (i % 3 !== 0) expected.push(i);
    assert.equal(drawn, expected.length, `${count} records`);
    assert.deepEqual(args, [6, expected.length, 0, 0]);
    const ids = Array.from({ length: drawn }, (_, k) => instances[k * INSTANCE_FLOATS + 3]);
    assert.deepEqual(ids, expected, `${count} records: order kept`);
  }
});

test('extras: offsets, arms along the hull, fixed angles and fades evaluate like the engine', () => {
  // One record with every extra: reference moving 0 -> 10, offset (2, -4) -> (2, -8),
  // an arm 10 forward and 4 right on a hull facing east (256) and not turning,
  // angle times 0.25 plus 1, scale 1 -> 2 and alpha 1 -> 0.
  const recs = Float32Array.from([0, 0, 10, 0, -1, 256, 0, 7, 1, 1, 1, 0, 0]);
  const extras = Float32Array.from([2, -4, 2, -8, 10, 4, 256, 0, 0.25, 1, 2, 0]);
  const { instances, count } = runPass('sprite', recs, extras, 1, 0.5, [0, 0, 1, 1]);
  assert.equal(count, 1, 'a negative margin is never culled');
  const [x, y, angle, sprite, team, scale, alpha] = instances;
  assert.ok(Math.abs(x - (5 + 2 + 10)) < 1e-4 && Math.abs(y - (-6 + 4)) < 1e-4, `${x}, ${y}`);
  assert.equal(angle, Math.fround(Math.fround(Math.fround(Math.fround(256 * Math.fround(Math.PI * 2)) / 1024) * 0.25) + 1));
  assert.deepEqual([sprite, team, scale, alpha], [7, 1, 1.5, 0.5]);
});

test('the shader and the CPU reference agree on layouts and constants', () => {
  const wgsl = readFileSync(fileURLToPath(new URL('../shaders/instances.wgsl', import.meta.url)), 'utf8');
  const constant = (name) => Number(wgsl.match(new RegExp(`const ${name}: u32 = (\\d+)u;`))[1]);
  assert.equal(constant('WG'), WORKGROUP);
  assert.equal(constant('SPRITE_REC'), SPRITE_REC_FLOATS);
  assert.equal(constant('SPRITE_EXTRA'), SPRITE_EXTRA_FLOATS);
  assert.equal(constant('RECT_REC'), RECT_REC_FLOATS);
  assert.equal(constant('OUT_FLOATS'), INSTANCE_FLOATS);
  assert.match(wgsl, /@workgroup_size\(256\)/);
  for (const entry of ['sprite_count', 'rect_count', 'scan', 'sprite_write', 'rect_write']) assert.match(wgsl, new RegExp(`fn ${entry}\\(`));
});

test('the instance path: GPU by default, the CPU path by request, toggle or when unavailable', () => {
  assert.equal(chooseInstancePath({ gpuReady: true }).path, 'gpu');
  assert.equal(chooseInstancePath({ gpuReady: true, requested: 'cpu' }).path, 'cpu');
  assert.equal(chooseInstancePath({ gpuReady: true, forceCpu: true }).path, 'cpu');
  const off = chooseInstancePath({ gpuReady: false, gpuReason: 'compute workgroups of 256 are not supported' });
  assert.deepEqual(off, { path: 'cpu', reason: 'the GPU pass is unavailable: compute workgroups of 256 are not supported' });
  assert.equal(chooseInstancePath({ gpuReady: false, requested: 'gpu' }).path, 'cpu', 'asking does not make it available');
  assert.match(instanceLines({ path: 'gpu', reason: 'x' })[0], /GPU pass/);
  assert.deepEqual(instanceLines(null), []);
  assert.equal(recordBytes({ sprites: new Float32Array(13), extras: new Float32Array(12), rects: new Float32Array(0) }), 100);
});
