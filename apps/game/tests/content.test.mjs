// Original graphics and texture packs (js/content). Every fixture is made up
// in content-fixtures.mjs: no Electronic Arts file, and nothing made from
// one, is in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lcwDecode, xorDeltaDecode, decodeShp, decodeTmp, decodeSprite, trimFrame, isShp, ContentError } from '../js/content/shp.js';
import { decodePalette, paletteLookup, REMAP_START, REMAP_END, SHADOW_ALPHA } from '../js/content/palette.js';
import {
  POSE,
  POSE_STRIDE,
  POSE_CODES,
  MODE,
  CLASSIC_RANGES,
  indexFacing,
  classicIndexFacing,
  interpolatedRotation,
  openraAngle,
  facingFrame,
  interpolatedRadians,
  resolveSequence,
  packSprite,
  unpackSprite,
} from '../js/content/sequences.js';
import { ACTOR_ART, SEQUENCES, GRAPHICS_FILES, TERRAIN, ACTOR_PALETTE, RESOURCES } from '../js/content/tables.js';
import { originalSlots, combineSlots, poseTable, compositeUnder, bibImage } from '../js/content/atlas.js';
import {
  originalTerrain,
  packTerrain,
  planTerrain,
  theaterPools,
  analyzeTile,
  beachWetness,
  waterDistance,
  terrainTileIndex,
  BEACH_REACH,
  LAND_CENTRE,
  ART_TILES,
  ART_ORE,
  ART_WATER_ROTATION,
  WATER_ALPHA,
  WATER_COLORS,
  TERRAIN_TILES,
  EXTRA_TILE_BASE,
  ORE_TILE_BASE,
  GEM_TILE_BASE,
  ORE_LEVELS,
  ORE_VARIANTS,
  GEM_LEVELS,
  GEM_VARIANTS,
} from '../js/content/terrain.js';
import { installContent, contentSummary, contentFromZip, QUICKINSTALL_LIMITS } from '../js/content/install.js';
import { MemoryStore, storageProblem, StorageError } from '../js/content/store.js';
import { ContentSystem, orderPacks, mergePackPrefs } from '../js/content/index.js';
import { createSettings } from '../js/settings.js';
import { validateManifest, readPack, PackError, packSlots, packSummary, pngSize, soundType, safePath, decodePackImages, PACK_LIMITS } from '../js/content/packs.js';
import { originalCameoPixels } from '../js/content/cameos.js';
import { downloadQuickInstall, QUICKINSTALL_BYTES, shouldShowNotice, dismissNotice, canAutoInstall } from '../js/content/download.js';
import { createRegistry } from '../js/registry.js';
import { buildAtlas, FRAME_FLOATS } from '../js/sprites.js';
import { SoundBank } from '../js/audio/bank.js';
import { buildMix, imaAud, sineSamples } from './audio-fixtures.mjs';
import { buildZip } from './oramap-fixtures.mjs';
import {
  rng,
  lcwEncode,
  xorDeltaEncode,
  buildShp,
  testFrame,
  buildPal,
  buildTmpRa,
  buildTmpTd,
  buildPng,
  sheetRgba,
  decodeTestPng,
  pixelDocument,
} from './content-fixtures.mjs';
import init, { Game, base_rules_json } from '../pkg/webra_sim.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SPRITE_WGSL = read('../shaders/sprite.wgsl');
const TERRAIN_WGSL = read('../shaders/terrain.wgsl');
const RENDER_RS = read('../../../engine/src/render.rs');

await init({ module_or_path: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const BASE = JSON.parse(base_rules_json());
const GAME_RULES = JSON.parse(new Game(7, 'england', 'russia', 64).rules_json());
const ACTORS = GAME_RULES.actors;

// ---- Decoders -----------------------------------------------------------------------

test('LCW: encoded images decode to the same bytes (fills, literals, relative and absolute copies)', () => {
  const r = rng(3);
  for (let n = 0; n < 40; n++) {
    const len = 1 + Math.floor(r() * 3000);
    const src = new Uint8Array(len);
    // Runs, repeats and noise so every command shows up.
    for (let i = 0; i < len; ) {
      const kind = r();
      const k = 1 + Math.floor(r() * 40);
      for (let j = 0; j < k && i < len; j++, i++) {
        src[i] = kind < 0.3 ? 9 : kind < 0.6 ? src[Math.max(0, i - 17)] : Math.floor(r() * 256);
      }
    }
    const packed = lcwEncode(src);
    const out = new Uint8Array(len);
    assert.equal(lcwDecode(packed, 0, out), len);
    assert.deepEqual(out, src);
  }
  // Command 2 with distance 1 repeats the previous byte.
  const out = new Uint8Array(6);
  lcwDecode(Uint8Array.from([0x81, 5, 0x20, 1, 0x80]), 0, out);
  assert.deepEqual([...out], [5, 5, 5, 5, 5, 5].slice(0, 6));
});

test('LCW: hostile data throws instead of reading or writing out of bounds', () => {
  const out = new Uint8Array(8);
  for (const bad of [
    [0x8a, 1, 2], // literal runs past the input
    [0xc0, 9, 0], // absolute copy from ahead
    [0xfe, 0xff, 0x00, 1], // fill past the frame
    [0x00], // truncated relative copy
    [],
  ]) {
    assert.throws(() => lcwDecode(Uint8Array.from(bad), 0, out), ContentError, JSON.stringify(bad));
  }
});

test('XOR delta: frames rebuilt from their predecessors, every command form', () => {
  const r = rng(9);
  for (let n = 0; n < 30; n++) {
    const len = 1 + Math.floor(r() * 40000);
    const a = Uint8Array.from({ length: len }, () => Math.floor(r() * 4));
    const b = a.map((v, i) => (r() < 0.3 ? (i % 700 < 400 ? 77 : Math.floor(r() * 256)) : v));
    const out = a.slice();
    xorDeltaDecode(xorDeltaEncode(a, b), 0, out);
    assert.deepEqual(out, b);
  }
  assert.throws(() => xorDeltaDecode(Uint8Array.from([0x05, 1, 2]), 0, new Uint8Array(10)), ContentError);
  assert.throws(() => xorDeltaDecode(Uint8Array.from([0xff, 0x80, 0, 0]), 0, new Uint8Array(10)), ContentError);
});

test('SHP: LCW, XOR-previous and XOR-reference frames decode; detection; trims like OpenRA', () => {
  const w = 30;
  const h = 26;
  const frames = [testFrame(w, h, 1), testFrame(w, h, 2), testFrame(w, h, 3), testFrame(w, h, 4)];
  const bytes = buildShp(w, h, frames, ['lcw', 'prev', ['ref', 0], 'prev']);
  assert.ok(isShp(bytes));
  const shp = decodeShp(bytes);
  assert.equal(shp.frames.length, 4);
  shp.frames.forEach((f, i) => assert.deepEqual(f.data, frames[i], `frame ${i}`));
  // Trim: rectangle of non-zero pixels, widened to keep the centre on whole pixels.
  const f = new Uint8Array(10 * 8);
  f[2 * 10 + 3] = 1;
  f[4 * 10 + 5] = 1;
  const t = trimFrame({ width: 10, height: 8, data: f });
  assert.deepEqual([t.width, t.height], [4, 4]);
  assert.deepEqual(t.offset, [-1, -1]);
  const empty = trimFrame({ width: 4, height: 4, data: new Uint8Array(16) });
  assert.deepEqual([empty.width, empty.height], [0, 0]);
  // Offsets always whole pixels, data inside the rectangle.
  for (const fr of frames) {
    const tr = trimFrame({ width: w, height: h, data: fr });
    assert.ok(Number.isInteger(tr.offset[0]) && Number.isInteger(tr.offset[1]));
    assert.equal((w - tr.width) % 2, 0);
    assert.equal((h - tr.height) % 2, 0);
  }
});

test('SHP: hostile files fail with ContentError (loops, bad offsets, truncation, garbage)', () => {
  const w = 8;
  const h = 8;
  const good = buildShp(w, h, [testFrame(w, h, 1), testFrame(w, h, 2)], ['lcw', 'prev']);
  // A frame that refers to itself.
  const loop = good.slice();
  new DataView(loop.buffer).setUint32(14, (new DataView(good.buffer).getUint32(14, true) & 0xffffff) | (0x40 << 24), true);
  new DataView(loop.buffer).setUint16(18, new DataView(good.buffer).getUint32(14, true) & 0xffff, true);
  // The first frame as XOR-previous.
  const firstPrev = good.slice();
  firstPrev[17] = 0x20;
  // Frame data pointing past the end.
  const far = good.slice();
  new DataView(far.buffer).setUint32(22, (far.length + 100) | (0x20 << 24), true);
  for (const bad of [loop, firstPrev, far]) {
    assert.throws(() => decodeShp(bad), ContentError);
  }
  const r = rng(5);
  for (let n = 0; n < 300; n++) {
    const b = good.slice();
    for (let k = 0; k < 4; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    try {
      decodeSprite(b);
    } catch (err) {
      assert.ok(err instanceof ContentError, `mutation ${n}: ${err}`);
    }
  }
  assert.throws(() => decodeSprite(new Uint8Array(100)), ContentError);
});

test('TMP: Red Alert and Tiberian Dawn templates, empty slots, hostile index', () => {
  const tile = (v) => new Uint8Array(24 * 24).fill(v);
  for (const build of [buildTmpRa, buildTmpTd]) {
    const t = decodeTmp(build(24, 24, [tile(1), null, tile(3), tile(4)]));
    assert.equal(t.tiles.length, 4);
    assert.equal(t.tiles[1], null);
    assert.equal(t.tiles[2][0], 3);
    const s = decodeSprite(build(24, 24, [tile(7)]));
    assert.equal(s.frames[0].data[5], 7);
  }
  const bad = buildTmpRa(24, 24, [tile(1)]);
  bad[40] = 9; // tile slot past the data
  assert.throws(() => decodeTmp(bad), ContentError);
});

test('palette: 6-bit VGA to 8 bits, transparency, shadow and the 80..95 remap range', () => {
  const pal = decodePalette(buildPal((i) => [i % 64, 63, 0]));
  assert.deepEqual([...pal.subarray(63 * 3, 63 * 3 + 3)], [255, 255, 0]);
  assert.deepEqual([...pal.subarray(1 * 3, 1 * 3 + 3)], [4, 255, 0]);
  assert.throws(() => decodePalette(Uint8Array.from({ length: 768 }, () => 64)), ContentError);
  assert.throws(() => decodePalette(new Uint8Array(100)), ContentError);
  const lookup = paletteLookup(pal);
  assert.equal(lookup.color[3], 0, 'index 0 is transparent');
  assert.deepEqual([...lookup.color.subarray(16, 20)], [0, 0, 0, SHADOW_ALPHA], 'index 4 is the shadow');
  for (let i = REMAP_START; i <= REMAP_END; i++) {
    assert.equal(lookup.mask[i], 255, `remap ${i} is team coloured`);
    const [r, g, b] = lookup.color.subarray(i * 4, i * 4 + 3);
    assert.ok(r === g && g === b, 'remap pixels are grey levels for the shader');
  }
  assert.equal(lookup.mask[79] + lookup.mask[96], 0);
  const plain = paletteLookup(pal, { remap: false, shadow: [] });
  assert.equal(plain.mask[85], 0);
  assert.deepEqual([...plain.color.subarray(85 * 4, 85 * 4 + 4)], [pal[85 * 3], pal[85 * 3 + 1], pal[85 * 3 + 2], 255]);
});

// ---- Sequences and facings ---------------------------------------------------------------

test('sequences: OpenRA frame order for facings, stride, Length *, Frames, Reverses, Transpose, ShadowStart', () => {
  const run = resolveSequence(SEQUENCES.e1.run, 400);
  assert.equal(run.facings, 8);
  assert.equal(run.length, 6);
  for (let f = 0; f < 8; f++) for (let k = 0; k < 6; k++) assert.equal(run.fileFrames[f * 6 + k], 16 + f * 6 + k);
  assert.equal(run.fps, 10);
  const prone = resolveSequence(SEQUENCES.e1['prone-stand'], 400);
  assert.deepEqual(prone.fileFrames, [144, 148, 152, 156, 160, 164, 168, 172]);
  assert.deepEqual(resolveSequence({ file: 'x', start: 2, length: -1, facings: 1 }, 6).fileFrames, [2, 3, 4, 5]);
  assert.deepEqual(resolveSequence({ file: 'x', start: 0, length: 3, facings: 1, frames: [5, 1, 4] }, 6).fileFrames, [5, 1, 4]);
  assert.deepEqual(resolveSequence({ file: 'x', start: 0, length: 4, facings: 1, reverses: true }, 6).fileFrames, [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(resolveSequence({ file: 'x', start: 0, length: 2, facings: 2, transpose: true }, 6).fileFrames, [0, 2, 1, 3]);
  assert.deepEqual(resolveSequence({ file: 'x', start: 0, length: 1, facings: -4 }, 6).fileFrames, [0, 3, 2, 1], 'negative facings are stored clockwise');
  assert.deepEqual(resolveSequence({ file: 'x', start: 0, length: 2, facings: 1, shadowStart: 4 }, 6).shadowFrames, [4, 5]);
  assert.throws(() => resolveSequence(SEQUENCES.e1['prone-shoot'], 200), /file has 200/);
});

test('the sequences table covers the engine actors and names only files it lists', () => {
  const files = new Set(GRAPHICS_FILES);
  // OpenRA's own units (its Flak Truck and Black Hawk) have no Red Alert art: they keep WebRA's.
  const openraOnly = new Set(['FTRK', 'MH60']);
  for (const a of BASE.actors) {
    if (a.kind === 'mine') continue;
    assert.equal(!!ACTOR_ART[a.id], !openraOnly.has(a.id), `${a.id} has original art`);
  }
  for (const [id, entry] of Object.entries(ACTOR_ART)) {
    const seqs = SEQUENCES[entry.image];
    assert.ok(seqs, `${id}: image ${entry.image}`);
    for (const part of ['body', 'second']) {
      for (const [pose, name] of Object.entries(entry[part] ?? {})) {
        assert.ok(['idle', 'move', 'attack', 'damaged', 'make', 'harvest', 'dock'].includes(pose), `${id} pose ${pose}`);
        const def = seqs[name];
        assert.ok(def, `${id}.${part}.${pose} -> ${name}`);
        assert.ok(files.has(def.file) || def.tilesets, `${def.file} is installed`);
        const f = Math.abs(def.facings);
        assert.ok(f >= 1 && (f & (f - 1)) === 0);
        if (def.classic) assert.equal(f, 32, 'classic facings need 32 facings');
      }
    }
    assert.ok(entry.body.idle, `${id} has an idle sequence`);
  }
  assert.ok(files.has(ACTOR_PALETTE));
  for (const t of Object.values(TERRAIN)) assert.ok(files.has(t.palette));
  // Infantry walk, fire and lie down; harvesters harvest and dock; structures are made and damaged.
  assert.deepEqual(Object.keys(ACTOR_ART.E1.body).sort(), ['attack', 'idle', 'move']);
  assert.deepEqual(Object.keys(ACTOR_ART.E1.second).sort(), ['attack', 'idle', 'move']);
  assert.ok(ACTOR_ART.HARV.body.harvest && ACTOR_ART.HARV.body.dock);
  assert.ok(ACTOR_ART.POWR.body.make && ACTOR_ART.POWR.body.damaged);
  assert.ok(ACTOR_ART.SBAG.wall);
  assert.equal(ACTOR_ART.FPWR.image, 'powr');
  assert.equal(RESOURCES.ore.length, 4);
});

/** OpenRA's integer reference, written from the C# (Util.IndexFacing, ClassicIndexFacing, GetInterpolatedFacingRotation). */
const ref = {
  index: (a, n) => (((a + (1024 / n) / 2) & 1023) / (1024 / n)) | 0,
  classic: (a) => {
    const ranges = [20, 56, 88, 132, 156, 184, 212, 240, 268, 296, 324, 352, 384, 416, 452, 488, 532, 568, 604, 644, 668, 696, 724, 752, 780, 808, 836, 864, 896, 928, 964, 1000];
    const i = ranges.findIndex((r) => a < r);
    return i < 0 ? 0 : i;
  },
  rotation: (a, n, m) => {
    const step = 1024 / n;
    const diff = ((((a + step / 2) & 1023) % step) - step / 2) & 1023;
    return (((diff / (1024 / m)) | 0) * (1024 / m)) & 1023;
  },
};

test('facing frames: every WebRA facing picks the frame OpenRA picks, as the shader computes it', () => {
  const f32 = Math.fround;
  for (let raw = -1024; raw < 2048; raw++) {
    // What the engine puts in an instance: radians of the raw angle in f32 (instances.rs radians()).
    const radians = f32(f32(raw * f32(Math.PI * 2)) / 1024);
    const ora = (((1024 - raw) % 1024) + 1024) % 1024;
    assert.equal(openraAngle(radians), ora, `raw ${raw}`);
    for (const n of [1, 2, 4, 8, 16, 32, 64]) assert.equal(indexFacing(ora, n), ref.index(ora, n));
    assert.equal(classicIndexFacing(ora, 32), ref.classic(ora));
    assert.equal(facingFrame(radians, { facings: 32, classic: true }).facing, ref.classic(ora));
    assert.equal(facingFrame(radians, { facings: 8 }).facing, ref.index(ora, 8));
    for (const [n, m] of [[16, 64], [16, 32]]) assert.equal(interpolatedRotation(ora, n, m), ref.rotation(ora, n, m));
  }
  // Facing 0 (north) is frame 0; a quarter turn clockwise (east) is frame 24 of 32, three quarters (west) frame 8.
  assert.equal(facingFrame(0, { facings: 32 }).facing, 0);
  assert.equal(facingFrame(Math.PI / 2, { facings: 32 }).facing, 24);
  assert.equal(facingFrame((3 * Math.PI) / 2, { facings: 32 }).facing, 8);
  // Interpolated facings turn the nearest frame by the rest, clockwise in WebRA terms.
  const r = interpolatedRadians(openraAngle(f32((10 * Math.PI * 2) / 1024)), 16, 64);
  assert.ok(r > 0 && r < (Math.PI * 2) / 32);
  // Sprites with one facing never turn unless they ask to.
  assert.deepEqual(facingFrame(1.2, { facings: 1 }), { facing: 0, rotation: 0 });
  assert.deepEqual(facingFrame(1.2, { facings: 1, rotate: true }), { facing: 0, rotation: 1.2 });
});

test('the shader and the JavaScript mirror share their constants', () => {
  const ranges = SPRITE_WGSL.match(/CLASSIC_RANGES = array<u32, 32>\(([^)]*)\)/)[1].match(/\d+/g).map(Number);
  assert.deepEqual(ranges, [...CLASSIC_RANGES]);
  assert.match(SPRITE_WGSL, new RegExp(`POSE_STRIDE: u32 = ${POSE_STRIDE}u`));
  assert.match(SPRITE_WGSL, new RegExp(`POSE_CODES: u32 = ${POSE_CODES}u`));
  for (const [k, v] of Object.entries(MODE)) assert.match(SPRITE_WGSL, new RegExp(`MODE_${k}: u32 = ${v}u`));
  assert.match(TERRAIN_WGSL, new RegExp(`ORE_TILE_BASE: u32 = ${ORE_TILE_BASE}u`));
  assert.match(TERRAIN_WGSL, new RegExp(`GEM_TILE_BASE: u32 = ${GEM_TILE_BASE}u`));
  assert.match(TERRAIN_WGSL, new RegExp(`ORE_LEVELS: u32 = ${ORE_LEVELS}u`));
  assert.match(TERRAIN_WGSL, new RegExp(`ORE_VARIANTS: u32 = ${ORE_VARIANTS}u`));
  assert.match(TERRAIN_WGSL, new RegExp(`GEM_LEVELS: u32 = ${GEM_LEVELS}u`));
  assert.match(TERRAIN_WGSL, new RegExp(`GEM_VARIANTS: u32 = ${GEM_VARIANTS}u`));
  // Pose numbers match the engine's Pose enum.
  const names = { Idle: 'IDLE', Move: 'MOVE', Attack: 'ATTACK', Damaged: 'DAMAGED', Make: 'MAKE', Harvest: 'HARVEST', Dock: 'DOCK', Still: 'STILL', DamagedStill: 'DAMAGED_STILL' };
  for (const [rs, js] of Object.entries(names)) {
    const m = RENDER_RS.match(new RegExp(`\\n    ${rs} = (\\d+),`));
    assert.ok(m, rs);
    assert.equal(Number(m[1]), POSE[js], rs);
  }
  assert.match(RENDER_RS, new RegExp(`POSE_STRIDE: u32 = ${POSE_STRIDE};`));
  const id = packSprite(311, POSE.MAKE, 42);
  assert.deepEqual(unpackSprite(id), { slot: 311, pose: POSE.MAKE, age: 42 });
});

// ---- Original slots and the atlas -----------------------------------------------------------

/** Synthetic installed graphics for a few actors: palette, 1tnk.shp, e1.shp, powr.shp, powrmake.shp, sbag.shp. */
function syntheticGraphics() {
  const files = new Map();
  files.set(ACTOR_PALETTE, buildPal());
  const shp = (count, w, h, seed) => buildShp(w, h, Array.from({ length: count }, (_, i) => testFrame(w, h, seed + i)));
  files.set('1tnk.shp', shp(64, 24, 24, 10));
  files.set('e1.shp', shp(256, 12, 16, 500));
  files.set('powr.shp', shp(4, 48, 48, 900));
  files.set('powrmake.shp', shp(13, 48, 48, 950));
  files.set('sbag.shp', shp(32, 24, 24, 990));
  files.set('1tnkicon.shp', shp(1, 64, 48, 77));
  return files;
}

test('original slots: poses per actor, facings, fallbacks, walls, aliases and missing art', () => {
  const files = syntheticGraphics();
  const out = originalSlots(ACTORS, (n) => files.get(n) ?? null, 'TEMPERAT');
  const t = (id) => ACTORS.findIndex((a) => a.id === id);
  // Light tank: 32 classic facings for body and turret, no animation.
  const tank = out.slots.get(2 * t('1TNK'));
  assert.equal(tank.poses[POSE.IDLE].facings, 32);
  assert.equal(tank.poses[POSE.IDLE].classic, true);
  assert.equal(tank.poses[POSE.MOVE], tank.poses[POSE.IDLE], 'vehicles have no move animation');
  assert.equal(out.slots.get(2 * t('1TNK') + 1).poses[POSE.IDLE].frames.length, 32);
  // Remap pixels became team mask.
  assert.ok(tank.images.some((img) => img.mask), 'remap pixels mark the team colour');
  // Rifleman: stand, run (6 frames at 10 per second), shoot; prone set in the second slot.
  const e1 = out.slots.get(2 * t('E1'));
  assert.equal(e1.poses[POSE.MOVE].length, 6);
  assert.equal(e1.poses[POSE.MOVE].fps, 10);
  assert.equal(e1.poses[POSE.ATTACK].length, 8);
  assert.equal(out.slots.get(2 * t('E1') + 1).poses[POSE.MOVE].length, 4);
  assert.equal(out.slots.get(2 * t('E1R1')), e1, 'paratroopers share the rifleman art');
  // Power plant: make once, damaged, still frames; no second slot (no WebRA layer on top).
  const powr = out.slots.get(2 * t('POWR'));
  assert.equal(powr.poses[POSE.MAKE].mode, MODE.ONCE);
  assert.equal(powr.poses[POSE.MAKE].length, 13);
  assert.equal(powr.poses[POSE.STILL].mode, MODE.STILL);
  assert.equal(powr.poses[POSE.DAMAGED].frames[0], powr.poses[POSE.DAMAGED_STILL].frames[0]);
  assert.equal(out.slots.get(2 * t('POWR') + 1), null);
  assert.equal(out.slots.get(2 * t('FPWR')), powr, 'the fake power plant looks like the real one');
  // Buildings are offset like OpenRA's LocalCenterOffset (half a cell up for the power plant).
  const powrInfo = ACTORS[t('POWR')];
  assert.deepEqual(powrInfo.centerOffset, [0, -12]);
  // Walls index their connection frames.
  assert.equal(out.slots.get(2 * t('SBAG')).poses[POSE.IDLE].mode, MODE.INDEX);
  // Everything without files keeps WebRA art.
  assert.ok(out.missing.includes('3TNK'));
  assert.ok(!out.slots.has(2 * t('3TNK')));
  assert.ok(out.actors.includes('1TNK') && out.actors.includes('E1'));
});

test('original slots without the palette fall back to WebRA art entirely', () => {
  const files = syntheticGraphics();
  files.delete(ACTOR_PALETTE);
  const out = originalSlots(ACTORS, (n) => files.get(n) ?? null);
  assert.equal(out.slots.size, 0);
  assert.equal(out.missing.length, ACTORS.length);
});

test('the atlas holds pose tables: head, descriptors and facing frames where the shader looks', () => {
  const files = syntheticGraphics();
  const out = originalSlots(ACTORS, (n) => files.get(n) ?? null);
  globalThis.document = pixelDocument();
  try {
    const plain = buildAtlas(ACTORS);
    const atlas = buildAtlas(ACTORS, { slots: out.slots, filter: 'nearest' });
    assert.equal(atlas.filter, 'nearest');
    const entry = (i) => Array.from(atlas.frames.slice(i * FRAME_FLOATS, (i + 1) * FRAME_FLOATS));
    const t = ACTORS.findIndex((a) => a.id === 'E1');
    const head = entry(2 * t);
    const base = head[12];
    assert.ok(head[13] === 9, 'nine poses');
    // The shader's lookup: descriptor of the pose, then first + facing * length + frame.
    const desc = entry(base + POSE.MOVE);
    const [first, length, fps, mode, facings] = desc.slice(8, 13);
    assert.deepEqual([length, fps, mode, facings], [6, 10, MODE.LOOP, 8]);
    const runImages = out.slots.get(2 * t).poses[POSE.MOVE].frames;
    for (let f = 0; f < 8; f++) {
      for (let k = 0; k < 6; k++) {
        const e = entry(first + f * 6 + k);
        const img = out.slots.get(2 * t).images[runImages[f * 6 + k]];
        assert.deepEqual(e.slice(4, 8), [img.width, img.height, img.offset[0], img.offset[1]]);
        assert.ok(e[2] > e[0] && e[3] > e[1], 'has an atlas rectangle');
      }
    }
    // Slot heads stay below the pose stride; the WebRA building layers keep their still frames there too.
    for (const s of atlas.overlays) assert.ok(s < POSE_STRIDE);
    assert.equal(atlas.overlays[ACTORS.findIndex((a) => a.id === 'POWR')], 0, 'the original power plant has no WebRA layer');
    assert.ok(plain.overlays[ACTORS.findIndex((a) => a.id === 'POWR')] > 0);
    // Slots without original art are WebRA sprites as before.
    const t3 = ACTORS.findIndex((a) => a.id === '3TNK');
    assert.deepEqual(entry(2 * t3).slice(4, 6), Array.from(plain.frames.slice(2 * t3 * FRAME_FLOATS + 4, 2 * t3 * FRAME_FLOATS + 6)));
    assert.ok(atlas.width <= 8192 && atlas.height <= 8192);
  } finally {
    delete globalThis.document;
  }
});

// ---- Structures of several parts: bib under, layer over -------------------------------------

test('tables: the original files only, never the files OpenRA makes itself (unless the original has the same layout)', () => {
  const bits = new Set(
    read('../../../data/source/bits.txt')
      .split('\n')
      .filter((l) => l && !l.startsWith('#')),
  );
  const sameLayout = new Set(['fact.shp', 'factmake.shp', 'gap.shp', 'gapmake.shp', 'harv.shp', 'heli.shp', 'hind.shp', 'mgg.shp', 'silomake.shp', 'truk.shp', 'yak.shp', 'stnkicon.shp']);
  for (const f of GRAPHICS_FILES) assert.ok(!bits.has(f) || sameLayout.has(f), `${f} is made by OpenRA`);
  // The War Factory: its roof and door from weap2.shp (four frames, then four damaged), a layer over the body.
  assert.equal(ACTOR_ART.WEAP.overlay, 'door');
  assert.deepEqual(ACTOR_ART.WEAP.second, { idle: 'build-top', damaged: 'damaged-build-top' });
  assert.deepEqual([SEQUENCES.weap['build-top'].file, SEQUENCES.weap['build-top'].start, SEQUENCES.weap['build-top'].length], ['weap2.shp', 0, 4]);
  assert.equal(SEQUENCES.weap['damaged-build-top'].start, 4);
  assert.equal(ACTOR_ART.WEAF.overlay, 'door', 'the fake War Factory too');
  // OpenRA's own files mapped to the originals with the same frames.
  assert.equal(SEQUENCES.tent.idle.file, 'tent.shp');
  assert.equal(SEQUENCES.tent.idle.tilesets, undefined);
  assert.equal(SEQUENCES.sam.turret.file, 'sam.shp');
  assert.equal(SEQUENCES.silo.idle.file, 'silo.shp');
  assert.equal(SEQUENCES.tran.idle.file, 'tran.shp');
  // Bibs: the big ones (bib1-3) per theater; the small ones are OpenRA's and left out.
  assert.equal(ACTOR_ART.WEAP.bib, 'bib');
  assert.deepEqual(SEQUENCES.weap.bib.tilesets, { DESERT: 'bib2.des', SNOW: 'bib2.sno' });
  assert.equal(ACTOR_ART.SAM.bib, undefined);
  // Fakes without an original fake cameo show the real one.
  assert.equal(ACTOR_ART.TENF.cameo, 'icon');
  // OpenRA's own units have no original art: WebRA's stays.
  assert.equal(ACTOR_ART.FTRK, undefined);
  assert.equal(ACTOR_ART.MH60, undefined);
});

test('composite: the body over the bib, both in place, shadows blended, team mask kept', () => {
  const img = (w, h, offset, rgba, mask = null) => ({ width: w, height: h, offset, scale: 1, color: new Uint8ClampedArray(w * h * 4).map((_, i) => rgba[i % 4]), mask });
  const under = img(4, 2, [0, 1], [10, 20, 30, 255]);
  const top = img(2, 4, [1, 0], [0, 0, 0, 140], new Uint8Array(8).fill(255));
  top.color.set([200, 100, 50, 255], 0); // one opaque pixel at the top left
  const out = compositeUnder(top, under);
  // Union of x -2..2 and y -2..2.
  assert.deepEqual([out.width, out.height, ...out.offset], [4, 4, 0, 0]);
  const at = (x, y) => [...out.color.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  assert.deepEqual(at(2, 0), [200, 100, 50, 255], 'opaque body pixel wins');
  assert.deepEqual(at(0, 3), [10, 20, 30, 255], 'bib where the body is not');
  const blended = at(3, 3); // shadow (alpha 140) over the bib: darker, opaque
  assert.equal(blended[3], 255);
  assert.ok(blended[2] < 30 && blended[2] > 0);
  assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'nothing outside both');
  assert.equal(out.mask[0 * 4 + 2], 255, 'the body keeps its team mask');
  assert.equal(out.mask[3 * 4 + 0], 0);
  assert.equal(compositeUnder(top, null), top);
});

test('bib: tile i of the template under footprint column i % width, in the bottom two rows', () => {
  const lookup = paletteLookup(decodePalette(buildPal()), { remap: false });
  const tiles = Array.from({ length: 6 }, (_, k) => ({ width: 24, height: 24, data: new Uint8Array(576).fill(30 + k) }));
  tiles[1] = null;
  const bib = bibImage(tiles, lookup, 3, 3);
  assert.deepEqual([bib.width, bib.height], [72, 48]);
  // A 3 x 3 footprint centred at 0: the bottom two rows span y -12..36, centre 12.
  assert.deepEqual(bib.offset, [0, 12]);
  const colorOf = (x, y) => [...bib.color.slice((y * 72 + x) * 4, (y * 72 + x) * 4 + 4)];
  assert.deepEqual(colorOf(60, 30), [...lookup.color.slice(35 * 4, 35 * 4 + 4)], 'tile 5: column 2, second row');
  assert.equal(colorOf(30, 5)[3], 0, 'an empty template cell stays empty');
  assert.equal(bibImage([null], lookup, 2, 2), null);
});

test('door: a production door shows the frame the engine names and never loops on its own', () => {
  const desc = (mode, frames) => ({ frames, length: frames.length, facings: 1, fps: 25, mode, classic: false, interpolatedFacings: 0, rotate: false });
  const pose = (frames) => ({ loop: desc(MODE.LOOP, frames), once: desc(MODE.ONCE, frames), still: desc(MODE.STILL, frames), index: desc(MODE.INDEX, frames) });
  const have = { idle: pose([7, 8, 9, 10]), damaged: pose([11, 12, 13, 14]) };
  const door = poseTable(have, { door: true });
  // OpenRA WithProductionDoorOverlay plays the sequence with PlayFetchDirection: frame by frame
  // towards the engine's door frame (engine/src/doors.rs), shut (frame 0) while nothing comes out.
  for (const p of [POSE.IDLE, POSE.DAMAGED, POSE.MAKE, POSE.MOVE]) assert.equal(door[p].mode, MODE.INDEX, `pose ${p}`);
  assert.deepEqual(door[POSE.IDLE].frames, [7, 8, 9, 10]);
  assert.deepEqual(door[POSE.DAMAGED].frames, [11, 12, 13, 14]);
  assert.equal(door[POSE.STILL].mode, MODE.STILL);
  assert.deepEqual(door[POSE.DAMAGED_STILL].frames, [11, 12, 13, 14]);
  // Other layers and bodies keep looping their idle sequence (OpenRA PlayRepeating).
  assert.equal(poseTable(have)[POSE.IDLE].mode, MODE.LOOP);
});

/** Synthetic War Factory parts: body 72 x 48, roof and door 72 x 48 (4 + 4 damaged), make, bib 3 x 2. */
function syntheticFactory() {
  const files = new Map();
  files.set(ACTOR_PALETTE, buildPal());
  const shp = (count, w, h, seed) => buildShp(w, h, Array.from({ length: count }, (_, i) => testFrame(w, h, seed + i)));
  files.set('weap.shp', shp(2, 72, 48, 10));
  files.set('weap2.shp', shp(8, 72, 48, 40));
  files.set('weapmake.shp', shp(15, 72, 48, 70));
  files.set('bib2.tem', buildTmpRa(24, 24, Array.from({ length: 6 }, (_, k) => new Uint8Array(576).fill(20 + k))));
  return files;
}

test('original slots: the War Factory body sits on its bib, its roof and door are a layer showing the door frame', () => {
  const files = syntheticFactory();
  const out = originalSlots(ACTORS, (n) => files.get(n) ?? null, 'TEMPERAT');
  const t = ACTORS.findIndex((a) => a.id === 'WEAP');
  const body = out.slots.get(2 * t);
  const layer = out.slots.get(2 * t + 1);
  assert.ok(out.layers.has(2 * t + 1));
  // Body frames carry the bib: as wide as the footprint, reaching the bottom row.
  const idle = body.images[body.poses[POSE.IDLE].frames[0]];
  assert.ok(idle.width >= 72);
  assert.ok(idle.offset[1] + idle.height / 2 >= 36, `the bib reaches the footprint's bottom edge: ${idle.offset[1] + idle.height / 2}`);
  // The make animation stands on the bib too.
  const make = body.images[body.poses[POSE.MAKE].frames[0]];
  assert.ok(make.offset[1] + make.height / 2 >= 36);
  // The layer: idle, damaged (weap2.shp frames 4..7), each showing the door frame the engine names
  // (MODE.INDEX): shut while idle or building instead of opening and closing all the time.
  assert.equal(layer.poses[POSE.IDLE].length, 4);
  assert.notEqual(layer.poses[POSE.DAMAGED].frames[0], layer.poses[POSE.IDLE].frames[0]);
  for (const p of [POSE.IDLE, POSE.DAMAGED, POSE.MAKE]) assert.equal(layer.poses[p].mode, MODE.INDEX, `pose ${p}`);
  assert.equal(layer.poses[POSE.STILL].mode, MODE.STILL);
  // Centred like the body (LocalCenterOffset half a cell up), never under the bib.
  const roof = layer.images[layer.poses[POSE.IDLE].frames[0]];
  assert.ok(roof.offset[1] < idle.offset[1]);
  // The fake War Factory shares the art.
  assert.equal(out.slots.get(2 * ACTORS.findIndex((a) => a.id === 'WEAF') + 1), layer);
  const combined = combineSlots(ACTORS.length, { original: out });
  assert.ok(combined.layers.has(2 * t + 1));
  // The atlas marks it: the layer's still pose, at least POSE_STRIDE (the engine then poses it).
  globalThis.document = pixelDocument();
  try {
    const atlas = buildAtlas(ACTORS, { slots: combined.slots, layers: combined.layers, filter: 'nearest' });
    // Its age is the number of door frames: the engine walks the door over them (engine/src/doors.rs).
    assert.equal(atlas.overlays[t], packSprite(2 * t + 1, POSE.STILL, 4));
    assert.deepEqual(unpackSprite(atlas.overlays[t]), { slot: 2 * t + 1, pose: POSE.STILL, age: 4 });
    assert.ok(atlas.overlays[t] >= POSE_STRIDE);
  } finally {
    delete globalThis.document;
  }
  // A pack body over the original layer: the layer stays a layer only while it comes from the original.
  const pack = { slots: new Map([[2 * t + 1, null]]), name: 'p' };
  assert.ok(!combineSlots(ACTORS.length, { packs: [pack], original: out }).layers.has(2 * t + 1));
});

test('priority: pack, then original content, then WebRA, with the second slot rule', () => {
  const art = (name) => ({ name, images: [], poses: [] });
  const original = { slots: new Map([[0, art('o0')], [1, null], [2, art('o2')], [3, art('o3')]]) };
  const packA = { name: 'A', slots: new Map([[2, art('a2')], [9, art('a-special')]]) };
  const packB = { name: 'B', slots: new Map([[2, art('b2')], [4, art('b4')], [1, art('b1')]]) };
  const { slots, source } = combineSlots(4, { packs: [packA, packB], original });
  assert.equal(slots.get(0).name, 'o0');
  assert.equal(slots.get(1).name, 'b1', 'a pack part wins over the original');
  assert.equal(slots.get(2).name, 'a2', 'the first pack wins');
  assert.equal(slots.get(3).name, 'o3', 'pack body, original turret');
  assert.equal(slots.get(4).name, 'b4');
  assert.ok(!slots.has(5), 'pack body without a second part: WebRA turret');
  assert.ok(!slots.has(6) && !slots.has(7), 'nothing installed: WebRA');
  assert.equal(slots.get(9).name, 'a-special');
  assert.equal(source.get(0), 'original');
  assert.equal(source.get(2), 'A');
  // Body original with an empty second slot: stays empty (no WebRA turret on original art).
  const r = combineSlots(1, { original: { slots: new Map([[0, art('x')], [1, null]]) } });
  assert.equal(r.slots.get(1), null);
  assert.equal(poseTable({}), null, 'no idle, no pose table');
});

test('original cameos come from the icon sequence, opaque, without team remap', () => {
  const files = syntheticGraphics();
  const pic = originalCameoPixels('1TNK', (n) => files.get(n) ?? null);
  assert.deepEqual([pic.width, pic.height], [64, 48]);
  for (let i = 3; i < pic.rgba.length; i += 4) assert.equal(pic.rgba[i], 255);
  assert.equal(originalCameoPixels('3TNK', (n) => files.get(n) ?? null), null);
});

// ---- Terrain ------------------------------------------------------------------------------------

// Synthetic temperate theater. Indices: ground 20..27, sand 50..53, open
// water 96..102 (the rotating range), stones 60. Every template the table
// names exists; the beach templates are sand except sh04, which is drawn
// like a real beach: grass to sand in its top row, sand to water in the
// middle row, water in the bottom row.
const GROUND = (x, y) => 20 + ((x * 3 + y * 5) % 8);
const SAND = (x, y) => 50 + ((x + y) % 4);
const WATERPX = (x, y) => 96 + ((x + 2 * y) % 7);
const tilePx = (fn) => {
  const t = new Uint8Array(24 * 24);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) t[y * 24 + x] = fn(x, y);
  return t;
};
/** sh04 tile k (3 x 3): wetness by the pixel's distance from the template's water row. */
function beachTile(k) {
  const row = Math.floor(k / 3);
  return tilePx((x, y) => {
    const fromTop = row * 24 + y; // 0 .. 71; water from 48
    if (fromTop >= 48) return WATERPX(x, y);
    if (fromTop >= 40) return WATERPX(x, y);
    if (fromTop >= 14) return SAND(x, y);
    return GROUND(x, y);
  });
}

function syntheticTheater() {
  const files = new Map();
  const info = TERRAIN.TEMPERAT;
  files.set(info.palette, buildPal());
  for (const [img, width, height, role, cells] of info.templates) {
    const name = info.images[img];
    if (files.has(name)) continue;
    const count = Math.max(...cells) + 1;
    const tiles = Array.from({ length: count }, (_, k) => {
      if (!cells.includes(k)) return null;
      if (role === 'water') return tilePx(WATERPX);
      if (role === 'clear') return tilePx((x, y) => GROUND(x + k, y));
      if (role === 'rough' || role === 'rock') return tilePx((x, y) => ((x - 12) ** 2 + (y - 12) ** 2 < 30 ? 60 : GROUND(x, y)));
      if (role === 'water-rock') return tilePx((x, y) => ((x - 12) ** 2 + (y - 12) ** 2 < 30 ? 60 : WATERPX(x, y)));
      if (name === 'sh04.tem') return beachTile(k);
      return tilePx(SAND);
    });
    files.set(name, buildTmpRa(24, 24, tiles));
  }
  for (const def of [...RESOURCES.ore, ...RESOURCES.gems]) files.set(def.file, buildShp(24, 24, Array.from({ length: 12 }, (_, i) => testFrame(24, 24, 300 + i, { remap: false }))));
  files.set('t01.tem', buildShp(48, 48, [testFrame(48, 48, 5, { remap: false })]));
  return files;
}

/** Engine terrain bytes for a little map: land with a lake, a rock ridge and a few trees. */
function terrainBytes(w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      if (x >= 4 && x < 10 && y >= 4 && y < 9) v = 3;
      else if (y === 12 && x > 2 && x < 14) v = 2;
      else if ((x + y) % 11 === 0) v = 4;
      else if (x === 15) v = 1;
      out[(y * w + x) * 4] = v;
      out[(y * w + x) * 4 + 3] = 255;
    }
  }
  return out;
}

/** Terrain bytes from rows of characters: . clear, ~ water, r rough, # rock, T tree, f ford. */
function terrainFrom(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const code = { '.': 0, r: 1, '#': 2, '~': 3, T: 4, f: 5 };
  const out = new Uint8Array(w * h * 4);
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    out[(y * w + x) * 4] = code[ch];
    out[(y * w + x) * 4 + 3] = 255;
  }));
  return { terrain: out, w, h };
}

const theaterPoolsOf = (files) => theaterPools('TEMPERAT', (n) => (files.get(n) ? decodeSprite(files.get(n)) : null));

test('terrain: tiles are read for where their water, sand and ground are', () => {
  const water = new Uint8Array(256);
  const ground = new Uint8Array(256);
  for (let v = 96; v <= 102; v++) water[v] = 1;
  for (let v = 20; v <= 27; v++) ground[v] = 1;
  const middle = analyzeTile(beachTile(4), water, ground);
  // Sand on top, water along the bottom edge.
  assert.ok(middle.regions[1] > 0.45 && middle.regions[1] < 0.55, `north region is sand: ${middle.regions[1]}`);
  assert.equal(middle.regions[7], 1);
  assert.ok(middle.edges[2].every((v) => v === 1), 'south edge is water');
  assert.ok(middle.edges[0].every((v) => v === 0.5), 'north edge is sand');
  const top = analyzeTile(beachTile(1), water, ground);
  assert.equal(top.regions[1], 0, 'grass at the top of the beach');
  // The beach profile runs from water to grass within two cells.
  assert.equal(beachWetness(0), 1);
  assert.ok(beachWetness(0.5) > beachWetness(1) && beachWetness(1) > beachWetness(1.5));
  assert.equal(beachWetness(BEACH_REACH + 0.1), 0);
  // Distances reach water two cells away, no further.
  const wet = (x, y) => x >= 10;
  assert.equal(waterDistance(9.5, 0.5, wet), 0.5);
  assert.equal(waterDistance(5, 0.5, wet), Infinity);
});

test('terrain: water cells keep open water; the beach goes on the land next to them and fits it', () => {
  const files = syntheticTheater();
  const pools = theaterPoolsOf(files);
  const { terrain, w, h } = terrainFrom([
    '..........',
    '..........',
    '..........',
    '..........',
    '~~~~~~~~~~',
    '~~~~~~~~~~',
  ]);
  const { picks, coast } = planTerrain(terrain, w, h, pools);
  for (let x = 0; x < w; x++) {
    assert.equal(picks[4 * w + x].role, 'water', 'open water in the sea');
    assert.equal(picks[0 * w + x].role, 'clear', 'plain ground far from the water');
    // Right by the water: the sand-to-water row of the beach template.
    const shore = picks[3 * w + x];
    assert.equal(shore.image, 'sh04.tem', `x ${x}`);
    assert.ok([3, 4, 5].includes(shore.tile), `sand to water at x ${x}: tile ${shore.tile}`);
  }
  assert.ok(coast.cells >= w && coast.fitted >= w);
  // Same map, same tiles: the choice is a function of the map and the files.
  assert.deepEqual(planTerrain(terrain, w, h, pools).picks.map((p) => p.key), picks.map((p) => p.key));
});

test('terrain: no garbage: land never looks like water, rocks and stones stand on their own kind of ground', () => {
  const files = syntheticTheater();
  const pools = theaterPoolsOf(files);
  const { terrain, w, h } = terrainFrom([
    '~~~~~~~~',
    '~~~.~~~~',
    '~~~~~#~~',
    '~~~~~~#~',
    '........',
    '.###.r#.',
    '........',
  ]);
  const { picks } = planTerrain(terrain, w, h, pools);
  // A one-cell island stays land (its tile is not water in the middle).
  assert.ok(picks[1 * w + 3].info.regions[4] <= LAND_CENTRE);
  // Rocks with water on two sides stand in the water; rocks on land on ground.
  assert.equal(picks[2 * w + 5].role, 'water-rock');
  assert.equal(picks[5 * w + 6].role, 'rock');
  // A run of three rock cells takes a whole template when one fits (b3: three tiles in a row).
  const run = [1, 2, 3].map((x) => picks[5 * w + x]);
  assert.ok(run.every((t) => t.role === 'rock'));
  if (run[0].template.tiles.size === 3) assert.deepEqual(run.map((t) => t.tile), [0, 1, 2]);
  assert.equal(picks[5 * w + 5].role, 'rough');
  for (const p of picks) assert.ok(p, 'every cell has a tile');
});

test('terrain: the original theater atlas, cells, ore and gem overlays, rotating water, nearest filtering', () => {
  const files = syntheticTheater();
  const w = 16;
  const h = 16;
  const r = originalTerrain((n) => files.get(n) ?? null, 'TEMPERAT', terrainBytes(w, h), w, h);
  assert.ok(r);
  assert.equal(r.atlas.filter, 'nearest');
  assert.equal(r.atlas.width, 16 * 24);
  assert.equal(r.atlas.flags & ART_TILES, ART_TILES);
  assert.equal(r.atlas.flags & ART_ORE, ART_ORE);
  assert.equal(r.atlas.flags & ART_WATER_ROTATION, ART_WATER_ROTATION);
  assert.ok(r.report.tiles > 3 && r.report.tiles <= TERRAIN_TILES);
  const tileOf = (i) => r.cells[i * 4] + 256 * r.cells[i * 4 + 1];
  for (let i = 0; i < w * h; i++) assert.ok(tileOf(i) < ORE_TILE_BASE || tileOf(i) >= EXTRA_TILE_BASE);
  // An ore tile is where the shader looks for it.
  const o = ((Math.floor(ORE_TILE_BASE / 16) * 24 + 5) * r.atlas.width + (ORE_TILE_BASE % 16) * 24 + 5) * 4;
  assert.ok(r.atlas.data[o + 3] > 0);
  // Water pixels carry their place in the rotation; the last row holds the colours in palette order.
  const lake = tileOf(6 * w + 7);
  const px = ((Math.floor(lake / 16) * 24 + 3) * r.atlas.width + (lake % 16) * 24 + 2) * 4;
  const index = WATERPX(2, 3);
  assert.equal(r.atlas.data[px + 3], WATER_ALPHA + index - 96);
  const pal = decodePalette(files.get('temperat.pal'));
  const row = (r.atlas.height - 1) * r.atlas.width * 4;
  for (let k = 0; k < WATER_COLORS; k++) assert.deepEqual([...r.atlas.data.slice(row + k * 4, row + k * 4 + 3)], [...pal.slice((96 + k) * 3, (96 + k) * 3 + 3)]);
  assert.equal(r.atlas.data[px], pal[index * 3], 'the pixel keeps its own colour too');
  // Not installed: null, the WebRA tiles stay.
  assert.equal(originalTerrain(() => null, 'TEMPERAT', terrainBytes(w, h), w, h), null);
});

test('terrain: tile indexes skip the ore and gem tiles and go past 255 the way the shader reads them', () => {
  assert.equal(terrainTileIndex(0), 0);
  assert.equal(terrainTileIndex(TERRAIN_TILES - 1), TERRAIN_TILES - 1);
  assert.equal(terrainTileIndex(TERRAIN_TILES), EXTRA_TILE_BASE);
  assert.ok(EXTRA_TILE_BASE >= GEM_TILE_BASE + GEM_LEVELS * GEM_VARIANTS);
  assert.ok(TERRAIN_WGSL.includes('tile + 256u * u32(cell.g * 255.0 + 0.5)'));
  for (const [name, v] of [['WATER_ALPHA', WATER_ALPHA], ['WATER_COLORS', WATER_COLORS], ['ART_WATER_ROTATION', ART_WATER_ROTATION]]) {
    assert.ok(new RegExp(`const ${name}: u32 = ${v}u;`).test(TERRAIN_WGSL), name);
  }
  // Every theater's water rotation is one the shader knows.
  for (const info of Object.values(TERRAIN)) assert.equal(info.rotation[1], WATER_COLORS);
});

test('terrain: pack tiles per class with fallbacks', () => {
  const size = 24;
  const strip = (n, v) => ({ width: size * n, height: size, rgba: new Uint8ClampedArray(size * n * size * 4).fill(v) });
  const images = new Map([['c.png', strip(3, 10)], ['w.png', strip(2, 20)], ['ore.png', { width: size * 12, height: size, rgba: new Uint8ClampedArray(size * 12 * size * 4).fill(30) }]]);
  const t = { biomes: ['temperate'], tileSize: size, clear: 'c.png', water: 'w.png', ore: 'ore.png' };
  const w = 16;
  const h = 16;
  const r = packTerrain(t, images, terrainBytes(w, h), w, h);
  assert.equal(r.atlas.flags, ART_TILES | ART_ORE);
  // Classes in engine order, each its own run of tiles: clear 0..2, rough 3..5 and rock 6..8 (both from clear), water 9..10.
  const lake = r.cells[(6 * w + 7) * 4];
  assert.ok(lake >= 9 && lake < 11, `water tiles after the others: ${lake}`);
  const rock = r.cells[(12 * w + 5) * 4];
  assert.ok(rock >= 6 && rock < 9, `rock: ${rock}`);
  const px = (tile) => r.atlas.data[((Math.floor(tile / 16) * size + 3) * r.atlas.width + (tile % 16) * size + 3) * 4];
  assert.equal(px(rock), 10, 'rock falls back to rough, rough to clear');
  assert.equal(px(lake), 20);
});

// ---- Install: MIX, loose files and OpenRA's quick install ZIP ------------------------------------------

function contentMix() {
  const graphics = syntheticGraphics();
  const conquer = buildMix([...graphics].filter(([n]) => n !== ACTOR_PALETTE).map(([name, data]) => ({ name, data })));
  const theater = syntheticTheater();
  const temperat = buildMix([...theater].filter(([n]) => n.endsWith('.tem') || n.endsWith('.pal')).map(([name, data]) => ({ name, data })));
  const sounds = buildMix([{ name: 'cannon1.aud', data: imaAud(sineSamples(800)) }]);
  return { conquer, temperat, sounds };
}

test('install: sounds and graphics in one pass from nested MIX archives, with sizes and theaters', async () => {
  const { conquer, temperat, sounds } = contentMix();
  const main = buildMix([
    { name: 'conquer.mix', data: conquer },
    { name: 'temperat.mix', data: temperat },
    { name: 'sounds.mix', data: sounds },
  ]);
  const store = new MemoryStore();
  const progress = [];
  const r = await installContent([new File([main], 'MAIN.MIX'), new File([new Uint8Array(10)], 'readme.txt')], store, { onProgress: (t) => progress.push(t) });
  assert.ok(r.byCategory.graphics > 10);
  assert.equal(r.byCategory.effects, 1);
  assert.deepEqual(r.theaters, ['TEMPERAT']);
  assert.ok(r.bytes > 0);
  assert.ok(r.archives.includes('main.mix/conquer.mix'));
  assert.deepEqual(r.skipped, ['readme.txt']);
  const s = await contentSummary(store);
  assert.equal(s.total, r.added);
  assert.ok(s.bytes.graphics > 0 && s.bytes.sounds > 0);
  // Bad files are reported, not stored.
  const broken = buildMix([{ name: '1tnk.shp', data: new Uint8Array(64) }]);
  const store2 = new MemoryStore();
  const r2 = await installContent([new File([broken], 'conquer.mix')], store2);
  assert.equal(r2.added, 0);
  assert.match(r2.errors[0], /1tnk\.shp/);
});

test('install: OpenRA ra-quickinstall.zip (synthetic) unpacks its MIX files with raised but bounded limits', async () => {
  const { conquer, temperat, sounds } = contentMix();
  const zip = buildZip([
    { name: 'conquer.mix', data: conquer },
    { name: 'temperat.mix', data: temperat },
    { name: 'sounds.mix', data: sounds },
    { name: 'expand/readme.txt', data: 'hello' },
  ]);
  const store = new MemoryStore();
  const r = await installContent([new File([zip], 'ra-quickinstall.zip')], store);
  assert.ok(r.byCategory.graphics > 10 && r.byCategory.effects === 1, JSON.stringify(r));
  assert.ok(QUICKINSTALL_LIMITS.maxArchiveBytes >= 13_502_031);
  assert.equal(QUICKINSTALL_LIMITS.maxRatio, 1000, 'the zip bomb ratio check stays');
  // Other ZIP shapes are refused: a texture pack, a ZIP without Red Alert files, a bomb.
  await assert.rejects(contentFromZip(buildZip([{ name: 'manifest.json', data: '{}' }, { name: 'x.mix', data: conquer }])), /not a Red Alert content package/);
  await assert.rejects(contentFromZip(buildZip([{ name: 'a.txt', data: 'x' }])), /not a Red Alert content package/);
  const bomb = buildZip([{ name: 'conquer.mix', data: new Uint8Array(8 * 1024 * 1024) }]);
  await assert.rejects(contentFromZip(bomb), /compression ratio/);
  const r2 = await installContent([new File([new Uint8Array(100)], 'other.zip')], new MemoryStore());
  assert.match(r2.errors[0], /other\.zip/);
});

test('one-click download: progress, exact size, server errors; the notice remembers its dismissal; who may use it', async () => {
  const chunks = (n) =>
    new ReadableStream({
      start(c) {
        let left = n;
        while (left > 0) {
          const k = Math.min(1 << 20, left);
          c.enqueue(new Uint8Array(k));
          left -= k;
        }
        c.close();
      },
    });
  const seen = [];
  const file = await downloadQuickInstall({
    fetchImpl: async (url, init) => {
      assert.equal(url, '/api/content/ra-quickinstall');
      assert.equal(init.headers['X-WebRA-Content'], '1');
      return new Response(chunks(QUICKINSTALL_BYTES));
    },
    onProgress: (n) => seen.push(n),
  });
  assert.equal(file.size, QUICKINSTALL_BYTES);
  assert.equal(seen.at(-1), QUICKINSTALL_BYTES);
  await assert.rejects(downloadQuickInstall({ fetchImpl: async () => new Response(chunks(1000)) }), /stopped after 1000/);
  await assert.rejects(downloadQuickInstall({ fetchImpl: async () => new Response(chunks(QUICKINSTALL_BYTES + 1)) }), /larger/);
  await assert.rejects(downloadQuickInstall({ fetchImpl: async () => new Response('{}', { status: 429 }) }), /too many/);
  await assert.rejects(
    downloadQuickInstall({ fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'mirrors down' } }), { status: 502 }) }),
    /mirrors down/,
  );
  const refuse = (status, code) => async () => new Response(JSON.stringify({ error: { code, message: 'x' } }), { status });
  await assert.rejects(downloadQuickInstall({ fetchImpl: refuse(403, 'relay_forbidden') }), /selected accounts/);
  await assert.rejects(downloadQuickInstall({ fetchImpl: refuse(401, 'unauthenticated') }), /sign in first/);
  await assert.rejects(downloadQuickInstall({ fetchImpl: refuse(403, 'ip_banned') }), /blocked from your network/);
  const storage = new Map([['webra.content.prompt.v1', 'yes']]);
  const st = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const registry = createRegistry({ storage: st });
  assert.equal(shouldShowNotice({ installed: false, registry }), true);
  assert.equal(shouldShowNotice({ installed: true, registry }), false);
  dismissNotice(registry);
  assert.equal(shouldShowNotice({ installed: false, registry }), false);
  assert.equal(shouldShowNotice({ installed: false, registry: createRegistry({ storage: st }) }), false, 'remembered');
  // The old "don't ask again" migrates.
  const old = new Map([['webra.content.prompt.v1', 'no']]);
  const reg2 = createRegistry({ storage: { getItem: (k) => old.get(k) ?? null, setItem: (k, v) => old.set(k, v), removeItem: (k) => old.delete(k) } });
  assert.equal(shouldShowNotice({ installed: false, registry: reg2 }), false);
  // Only selected accounts and admins get the one-click download.
  assert.equal(canAutoInstall(null), false);
  assert.equal(canAutoInstall({ role: 'user', flags: [] }), false);
  assert.equal(canAutoInstall({ role: 'user', flags: ['content_autoinstall'] }), true);
  assert.equal(canAutoInstall({ role: 'moderator', flags: [] }), false);
  assert.equal(canAutoInstall({ role: 'admin', flags: [] }), true);
  assert.equal(canAutoInstall({ role: 'admin', flags: [], canUseContentRelay: false }), false, 'the server verdict wins (relay off)');
  assert.equal(canAutoInstall({ role: 'user', flags: [], canUseContentRelay: true }), true);
});

// ---- Texture packs ------------------------------------------------------------------------------

const KNOWN = { actors: new Set(ACTORS.map((a) => a.id.toUpperCase())), sounds: new Set(['cannon', 'cannon1.aud']) };

function exampleManifest(extra = {}) {
  return {
    format: 'webra-pack',
    formatVersion: 1,
    name: 'Test Tanks',
    author: 'Tester',
    version: '1.0.0',
    license: 'CC0-1.0',
    sprites: [
      { actor: '1TNK', image: 'tank.png', frameSize: [4, 4], facings: 8, frames: 2, fps: 5, teamMask: 'tank-team.png' },
      { actor: '1TNK', part: 'second', hidden: true },
      { special: 'missile', image: 'missile.png', frameSize: [4, 2] },
    ],
    cameos: { '1TNK': 'cameo.png' },
    terrain: { biomes: ['snow'], tileSize: 24, clear: 'clear.png', water: 'water.png' },
    sounds: { cannon: 'boom.wav' },
    ...extra,
  };
}

const wav = () => {
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode('RIFF'), 0);
  b.set(new TextEncoder().encode('WAVE'), 8);
  return b;
};

function examplePack(manifest = exampleManifest(), extraFiles = []) {
  const s = sheetRgba(4, 4, 2, 8);
  const mask = { ...s, rgba: new Uint8ClampedArray(s.rgba.length).fill(255) };
  return buildZip([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'tank.png', data: buildPng(s.width, s.height, s.rgba) },
    { name: 'tank-team.png', data: buildPng(mask.width, mask.height, mask.rgba) },
    { name: 'missile.png', data: buildPng(4, 2, new Uint8ClampedArray(32).fill(255)) },
    { name: 'cameo.png', data: buildPng(8, 6, new Uint8ClampedArray(8 * 6 * 4).fill(90)) },
    { name: 'clear.png', data: buildPng(48, 24, new Uint8ClampedArray(48 * 24 * 4).fill(40)) },
    { name: 'water.png', data: buildPng(24, 24, new Uint8ClampedArray(24 * 24 * 4).fill(60)) },
    { name: 'boom.wav', data: wav() },
    { name: 'LICENSE.txt', data: 'CC0' },
    ...extraFiles,
  ]);
}

test('pack manifest: a valid example; cosmetic only (unknown keys such as rules are refused)', () => {
  const ok = validateManifest(exampleManifest(), KNOWN);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.manifest.sprites[0].pose, 'idle');
  for (const [patch, pattern] of [
    [{ rules: { actors: {} } }, /unknown key "rules"/],
    [{ format: 'zip' }, /format/],
    [{ formatVersion: 2 }, /formatVersion/],
    [{ name: '' }, /"name" is required/],
    [{ author: '<script>' }, /without < or >/],
    [{ sprites: [{ actor: '1TNK', image: '../x.png', frameSize: [4, 4] }] }, /not a safe file name/],
    [{ sprites: [{ actor: '1TNK', image: '/abs.png', frameSize: [4, 4] }] }, /not a safe file name/],
    [{ sprites: [{ actor: '1TNK', image: 'a\\b.png', frameSize: [4, 4] }] }, /not a safe file name/],
    [{ sprites: [{ actor: '1TNK', image: 'x.svg', frameSize: [4, 4] }] }, /PNG/],
    [{ sprites: [{ actor: '1TNK', image: 'x.png', frameSize: [4, 4], facings: 12 }] }, /facings/],
    [{ sprites: [{ special: 'missile', image: 'x.png', frameSize: [4, 4], facings: 8 }] }, /one facing/],
    [{ sprites: [{ special: 'laser', image: 'x.png', frameSize: [4, 4] }] }, /special/],
    [{ sprites: [{ actor: '1TNK', pose: 'dance', image: 'x.png', frameSize: [4, 4] }] }, /pose/],
    [{ sprites: [{ actor: '1TNK', image: 'x.png', frameSize: [4, 4], script: 'x' }] }, /unknown key "script"/],
    [{ sprites: [{ actor: '1TNK', image: 'x.png', frameSize: [4, 4] }, { actor: '1TNK', image: 'y.png', frameSize: [4, 4] }] }, /twice/],
    [{ terrain: { clear: 'c.png' } }, /clear" and "water/],
    [{ sounds: { cannon: 'boom.exe' } }, /OGG, WAV or MP3/],
    [{ sprites: [], cameos: {}, terrain: undefined, sounds: {} }, /replaces nothing/],
  ]) {
    const r = validateManifest({ ...exampleManifest(), ...patch }, KNOWN);
    assert.ok(r.errors.some((e) => pattern.test(e)), `${JSON.stringify(patch)} -> ${r.errors.join('; ')}`);
    assert.equal(r.manifest, null);
  }
  const warn = validateManifest({ ...exampleManifest(), sounds: { kaboom: 'k.ogg' }, cameos: { ZZZZ: 'z.png' } }, KNOWN);
  assert.equal(warn.errors.length, 0);
  assert.equal(warn.warnings.length, 2);
  assert.equal(safePath('a/b.png'), 'a/b.png');
  for (const bad of ['', '../a', 'a/../b', '/a', 'a//b', 'a\\b', 'a/.', 'x'.repeat(300)]) assert.equal(safePath(bad), null, bad);
});

test('pack reading: the example pack installs; preview lists what it replaces', async () => {
  const pack = await readPack(examplePack(), KNOWN);
  assert.equal(pack.manifest.name, 'Test Tanks');
  assert.equal(pack.files.size, 7);
  const summary = packSummary(pack.manifest, new Map([['1TNK', 'Light Tank']]));
  assert.deepEqual(summary.sprites.map((s) => [s.target, s.part, s.hidden]), [['Light Tank', 'body', false], ['Light Tank', 'second', true], ['missile (effect)', null, false]]);
  assert.deepEqual(summary.terrain, ['snow']);
  assert.deepEqual(summary.sounds, ['cannon']);
  // In a folder inside the archive is fine too.
  const nested = buildZip([{ name: 'pack/manifest.json', data: JSON.stringify(exampleManifest({ sprites: undefined, cameos: undefined, terrain: undefined })) }, { name: 'pack/boom.wav', data: wav() }]);
  assert.equal((await readPack(nested, KNOWN)).manifest.name, 'Test Tanks');
});

test('pack reading: hostile packs are refused with PackError', async () => {
  const cases = [
    [examplePack(exampleManifest(), [{ name: 'evil.html', data: '<script>' }]), /packs hold only/],
    [examplePack(exampleManifest(), [{ name: 'run.js', data: 'x' }]), /packs hold only/],
    [buildZip([{ name: 'x.png', data: 'x' }]), /no manifest/],
    [buildZip([{ name: 'manifest.json', data: '{nope' }]), /not valid JSON/],
    [buildZip([{ name: 'manifest.json', data: ' '.repeat(PACK_LIMITS.maxManifestBytes + 1) }]), /larger than/],
    [buildZip([{ name: 'manifest.json', data: JSON.stringify(exampleManifest()) }]), /missing from the archive/],
    [examplePack(exampleManifest({ sprites: [{ actor: '1TNK', image: 'tank.png', frameSize: [5, 4], facings: 8, frames: 2 }] })), /need 10 x 32/],
    [buildZip([{ name: 'manifest.json', data: JSON.stringify(exampleManifest({ sprites: [], cameos: { '1TNK': 'c.png' }, terrain: undefined, sounds: {} })) }, { name: 'c.png', data: 'not a png at all, sorry' }]), /not a PNG/],
    [buildZip([{ name: 'manifest.json', data: JSON.stringify(exampleManifest({ sprites: [], cameos: {}, terrain: undefined })) }, { name: 'boom.wav', data: 'MZ executable' }]), /not an OGG, WAV or MP3/],
    [buildZip([{ name: '../manifest.json', data: '{}' }, { name: 'manifest.json', data: '{}' }]), /unsafe file name/],
    [new Uint8Array(200), /not a usable pack archive/],
    [
      buildZip([
        { name: 'manifest.json', data: JSON.stringify(exampleManifest({ sprites: [], cameos: { '1TNK': 'big.png' }, terrain: undefined, sounds: {} })) },
        { name: 'big.png', data: new Uint8Array(8 * 1024 * 1024) },
      ]),
      /compression ratio/,
    ],
  ];
  // A PNG header that claims a giant image.
  const huge = buildPng(1, 1, new Uint8ClampedArray(4));
  new DataView(huge.buffer).setUint32(16, 100000);
  cases.push([
    buildZip([{ name: 'manifest.json', data: JSON.stringify(exampleManifest({ sprites: [], cameos: { '1TNK': 'h.png' }, terrain: undefined, sounds: {} })) }, { name: 'h.png', data: huge }]),
    /at most 4096/,
  ]);
  for (const [bytes, pattern] of cases) {
    await assert.rejects(readPack(bytes, KNOWN), (e) => e instanceof PackError && pattern.test(e.message), String(pattern));
  }
});

test('pack fuzzing: random damage to a pack never escapes as anything but PackError', async () => {
  const good = examplePack();
  const r = rng(77);
  let accepted = 0;
  for (let n = 0; n < 400; n++) {
    const b = good.slice();
    const hits = 1 + Math.floor(r() * 6);
    for (let k = 0; k < hits; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    if (r() < 0.2) b.copyWithin(Math.floor(r() * b.length), Math.floor(r() * b.length));
    try {
      const pack = await readPack(n % 5 === 0 ? b.subarray(0, Math.floor(r() * b.length)) : b, KNOWN);
      await decodePackImages(pack.files, decodeTestPng).catch((err) => {
        assert.ok(err instanceof PackError || /incorrect header|invalid|unexpected end|too far back/i.test(err.message), err.message);
      });
      accepted++;
    } catch (err) {
      assert.ok(err instanceof PackError, `mutation ${n}: ${err?.constructor?.name}: ${err?.message}`);
    }
  }
  assert.ok(accepted < 400, 'damage is noticed');
});

test('pack sprites: rows turn clockwise, frames become OpenRA order; team mask; hidden parts', async () => {
  const pack = await readPack(examplePack(), KNOWN);
  const images = await decodePackImages(pack.files, decodeTestPng);
  assert.deepEqual(pngSize(pack.files.get('tank.png')), { width: 8, height: 32 });
  const { slots, problems } = packSlots(pack.manifest, images, ACTORS);
  assert.deepEqual(problems, []);
  const t = ACTORS.findIndex((a) => a.id === '1TNK');
  const art = slots.get(2 * t);
  const idle = art.poses[POSE.IDLE];
  assert.deepEqual([idle.facings, idle.length, idle.fps], [8, 2, 5]);
  // Internal facing 2 (a quarter turn counter-clockwise: west) is sheet row 6 (three quarters clockwise).
  const img = art.images[idle.frames[2 * 2 + 1]];
  assert.ok(img.mask, 'team mask');
  assert.equal(img.color[0], img.color[1], 'team pixels are grey levels');
  const raw = sheetRgba(4, 4, 2, 8);
  const lum = Math.round(0.299 * 10 + 0.587 * 60 + 0.114 * 200);
  assert.equal(raw.rgba[(6 * 4 * 8 + 4) * 4 + 1], 60);
  assert.equal(img.color[0], lum);
  assert.equal(slots.get(2 * t + 1), null, 'the turret is hidden');
  const missile = slots.get(ACTORS.length * 2 + 8);
  assert.equal(missile.poses[0].rotate, true, 'specials turn like WebRA art');
});

test('sound priority: pack, then installed original, then synthesized', () => {
  const buf = (name) => ({ name });
  const mixer = { ctx: { sampleRate: 22050 }, buffer: () => buf('decoded') };
  const bank = new SoundBank(mixer, () => ({ original: true }));
  bank.decoded.set('cannon1.aud', buf('original'));
  bank.originals.set('cannon1.aud', new Uint8Array(1));
  bank.synth.set('cannon#0', buf('synth'));
  const sound = { synth: 'cannon', originals: ['cannon1.aud'] };
  const zero = () => 0;
  assert.equal(bank.resolve(sound, zero).buffer.name, 'original');
  bank.pack.set('cannon', buf('pack-event'));
  assert.equal(bank.resolve(sound, zero).buffer.name, 'pack-event');
  bank.pack.set('cannon1', buf('pack-original'));
  assert.equal(bank.resolve(sound, zero).buffer.name, 'pack-original', 'an original name wins over the event');
  bank.pack.clear();
  const off = new SoundBank(mixer, () => ({ original: false }));
  off.synth.set('cannon#0', buf('synth'));
  off.originals.set('cannon1.aud', new Uint8Array(1));
  assert.equal(off.resolve(sound, zero).buffer.name, 'synth');
  assert.equal(soundType(wav()), 'wav');
  assert.equal(soundType(new TextEncoder().encode('OggS........')), 'ogg');
  assert.equal(soundType(new TextEncoder().encode('ID3.........')), 'mp3');
  assert.equal(soundType(new TextEncoder().encode('<html>......')), null);
});

// ---- Determinism ---------------------------------------------------------------------------------

test('no content setting changes the simulation: state hashes match with poses, overlays and renders', () => {
  const a = new Game(4321, 'england', 'russia', 64);
  const b = new Game(4321, 'england', 'russia', 64);
  b.set_sprite_poses(true);
  b.set_building_overlays(new Uint32Array(ACTORS.length));
  for (let t = 0; t < 600; t++) {
    a.tick();
    b.tick();
    if (t % 7 === 0) b.set_sprite_poses(t % 2 === 0);
    b.build_render(0, 0.5, 0, 0, 64 * 24, 64 * 24);
    b.build_render_records(0);
    assert.equal(a.state_hash(), b.state_hash(), `tick ${t}`);
  }
});

// ---- The content system: state after installs, packs and settings ------------------------------

function contentSystem(store = new MemoryStore()) {
  const registry = createRegistry({ storage: null });
  const settings = createSettings(registry);
  const content = new ContentSystem({ settings, registry, open: async () => store, decodeImage: decodeTestPng, known: KNOWN });
  return { content, settings, registry, store };
}

function quickinstallZip() {
  const { conquer, temperat, sounds } = contentMix();
  return new File([buildZip([{ name: 'conquer.mix', data: conquer }, { name: 'temperat.mix', data: temperat }, { name: 'sounds.mix', data: sounds }])], 'ra-quickinstall.zip');
}

test('content system: the first graphics install switches to them at once; removal switches back', async () => {
  const { content, settings } = contentSystem();
  await content.load();
  let changes = 0;
  content.onChange(() => changes++);
  assert.equal(content.hasOriginalGraphics, false);
  const r = await content.install([quickinstallZip()]);
  assert.equal(r.switched, true);
  assert.equal(settings.get('graphics'), 'original');
  assert.equal(content.originalActive, true, 'no reload needed');
  assert.ok(changes >= 1, 'listeners (the running game, cameos) heard about it');
  // A reinstall does not override a choice the player made since.
  settings.set('graphics', 'webra');
  const again = await content.install([quickinstallZip()]);
  assert.equal(again.switched, false);
  assert.equal(settings.get('graphics'), 'webra');
  settings.set('graphics', 'original');
  await content.removeOriginal();
  assert.equal(content.hasOriginalGraphics, false);
  assert.equal(settings.get('graphics'), 'webra');
  // Sounds only: nothing to switch.
  const { sounds } = contentMix();
  const r3 = await content.install([new File([sounds], 'sounds.mix')]);
  assert.equal(r3.switched, false);
  assert.equal(r3.byCategory.effects, 1);
  const summary = await content.summary();
  assert.equal(summary.palette, false);
});

test('content system: reloads run in order, so a slow earlier read never overwrites a newer one', async () => {
  const store = new MemoryStore();
  let release;
  const gate = new Promise((r) => (release = r));
  const getAll = store.getAll.bind(store);
  let calls = 0;
  store.getAll = async (filter) => {
    calls++;
    const first = calls === 1;
    const out = await getAll(filter);
    if (first) await gate; // the first read hangs with the old (empty) state
    return out;
  };
  const { content } = contentSystem(store);
  const first = content.load();
  const { conquer, temperat } = contentMix();
  const done = content.install([new File([conquer], 'conquer.mix'), new File([temperat], 'temperat.mix')]);
  await new Promise((r) => setTimeout(r, 10));
  release();
  await Promise.all([first, done]);
  assert.equal(content.hasOriginalGraphics, true, 'the install\'s reload came last');
  assert.equal(content.load(), content.loaded, 'load() hands out the latest reload');
});

test('content system: storage problems become clear messages; nothing half installed', async () => {
  const quota = storageProblem(Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }));
  assert.ok(quota instanceof StorageError);
  assert.match(quota.message, /no room left/);
  assert.match(quota.message, /Nothing was installed/);
  assert.match(storageProblem(Object.assign(new Error(''), { name: 'NS_ERROR_DOM_QUOTA_REACHED' })).message, /no room left/);
  assert.match(storageProblem(new Error('aborted')).message, /could not save the files \(aborted\)/);
  const store = new MemoryStore();
  store.putAll = async () => {
    throw storageProblem(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
  };
  const { content, settings } = contentSystem(store);
  await assert.rejects(content.install([quickinstallZip()]), /no room left/);
  assert.equal((await content.summary()).total, 0);
  assert.equal(settings.get('graphics'), 'webra');
});

test('pack order: the settings order and choices win; unknown packs keep their stored order', () => {
  const records = [
    { id: 'a', order: 0, enabled: true },
    { id: 'b', order: 1, enabled: false },
    { id: 'c', order: 2, enabled: true },
  ];
  assert.deepEqual(
    orderPacks(records, []).map((p) => [p.record.id, p.enabled]),
    [['a', true], ['b', false], ['c', true]],
  );
  assert.deepEqual(
    orderPacks(records, [{ id: 'c', enabled: false }, { id: 'x', enabled: true }, { id: 'b', enabled: true }]).map((p) => [p.record.id, p.enabled]),
    [['c', false], ['b', true], ['a', true]],
  );
  // Packs of other devices stay in the list after this device's packs.
  assert.deepEqual(mergePackPrefs([{ id: 'x', enabled: true }, { id: 'a', enabled: true }], [{ id: 'b', enabled: true }, { id: 'a', enabled: false }]), [
    { id: 'b', enabled: true },
    { id: 'a', enabled: false },
    { id: 'x', enabled: true },
  ]);
});

test('content system: pack install, order and choice go to the synced settings and come back from them', async () => {
  const { content, registry } = contentSystem();
  await content.load();
  const one = await content.inspectPack(examplePack());
  await content.installPack(one);
  const two = await content.inspectPack(examplePack(exampleManifest({ name: 'Second Pack' })));
  await content.installPack(two);
  assert.deepEqual(registry.get('content', 'packs'), [
    { id: one.id, enabled: true },
    { id: two.id, enabled: true },
  ]);
  await content.movePack(two.id, -1);
  await content.setPackEnabled(one.id, false);
  assert.deepEqual(registry.get('content', 'packs'), [
    { id: two.id, enabled: true },
    { id: one.id, enabled: false },
  ]);
  assert.deepEqual(content.packs.map((p) => [p.record.id, p.enabled]), [[two.id, true], [one.id, false]]);
  // Another device changed the order: the content follows without a page reload.
  registry.applyDocument({ content: { packs: [{ id: 'elsewhere|x', enabled: true }, { id: one.id, enabled: true }, { id: two.id, enabled: false }] } });
  await content.loaded;
  assert.deepEqual(content.packs.map((p) => [p.record.id, p.enabled]), [[one.id, true], [two.id, false]]);
  // Packs stored by older builds kept the checked manifest (with defaults): they still load.
  assert.deepEqual(validateManifest(one.manifest, KNOWN).errors, []);
  // A reinstall keeps place and choice; removing drops the pack from the settings, others stay.
  await content.installPack(two);
  assert.deepEqual(content.packs.map((p) => [p.record.id, p.enabled]), [[one.id, true], [two.id, false]]);
  await content.removePack(one.id);
  assert.deepEqual(registry.get('content', 'packs').map((p) => p.id), [two.id, 'elsewhere|x']);
});
