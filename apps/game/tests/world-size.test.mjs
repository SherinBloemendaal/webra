// The 2D minimal art of the neutral world's structures (js/art/world.js)
// against the original sprites: every civilian and tech building, hut,
// field and mine fills the same extent as its original sprite, so they
// stand as far apart as in the original art. The original extent comes
// from numbers in the repo only: the original art's DecorationBounds or Bounds
// (content/render-facts.js ORIGINAL_BOUNDS, around the footprint's centre
// plus the rules' centerOffset), else the footprint; a bib row the original
// draws under the structure (a `bib` part in RENDER_FACTS) counts too.
// Run: node --test apps/game/tests/world-size.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { actorSprites, drawIcon } from '../js/sprites.js';
import { BUILDING_DRAW } from '../js/art/buildings.js';
import { CIVILIAN_DRAW, originalExtent, worldBox, worldDraw, worldIconCrop } from '../js/art/world.js';
import { ORIGINAL_BOUNDS, RENDER_FACTS } from '../js/content/render-facts.js';
import init, { Game } from '../pkg/webra_sim.js';

await init({ module_or_path: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const actors = JSON.parse(new Game(7, 'england', 'russia', 64).rules_json()).actors;

/** How far (world pixels) each edge of the drawing may lie from the original's: an eighth of a cell. */
const TOLERANCE = 3;
const BIOMES = ['temperate', 'snow', 'desert'];

/**
 * The world structures measured: buildings that fill their cells in the
 * original art. Props that stand on part of a cell (barrels, boxes, poles,
 * traps, the flag, ice, rocks, fences), trees, bridges and WebRA's pixel art
 * (the oil derrick, tests/pixel-art.test.mjs) are not.
 */
const MEASURED = /^(HOSP|BIO|MISS|FCOM|V\d\d|V19\.HUSK|RICE|RUSHOUSE|SNOWHUT|ASIANHUT|LHUS|WINDMILL|RAILMINE|MINE|GMINE)$/;
const measured = actors.filter((a) => a.kind === 'building' && !BUILDING_DRAW[a.id.toUpperCase()] && worldDraw(a) && MEASURED.test(a.id.toUpperCase()));

/** The union of what a drawing fills and strokes, shadows left out: [x0, y0, x1, y1] in its box. */
function drawnExtent(draw, biome) {
  let path = [];
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x0, y0, x1, y1, style) => {
    if (typeof style === 'string' && style.startsWith('rgba(0,0,0,')) return;
    box[0] = Math.min(box[0], x0);
    box[1] = Math.min(box[1], y0);
    box[2] = Math.max(box[2], x1);
    box[3] = Math.max(box[3], y1);
  };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    save() {},
    restore() {},
    translate() { throw new Error('world art draws without transforms'); },
    beginPath() { path = []; },
    closePath() {},
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    rect(x, y, w, h) { path.push([x, y], [x + w, y + h]); },
    roundRect(x, y, w, h) { path.push([x, y], [x + w, y + h]); },
    arc(x, y, r) { path.push([x - r, y - r], [x + r, y + r]); },
    ellipse(x, y, rx, ry) { path.push([x - rx, y - ry], [x + rx, y + ry]); },
    fillRect(x, y, w, h) { add(x, y, x + w, y + h, ctx.fillStyle); },
    fill() { if (path.length) add(Math.min(...path.map((p) => p[0])), Math.min(...path.map((p) => p[1])), Math.max(...path.map((p) => p[0])), Math.max(...path.map((p) => p[1])), ctx.fillStyle); },
    stroke() {
      const r = ctx.lineWidth / 2;
      if (path.length) add(Math.min(...path.map((p) => p[0])) - r, Math.min(...path.map((p) => p[1])) - r, Math.max(...path.map((p) => p[0])) + r, Math.max(...path.map((p) => p[1])) + r, ctx.strokeStyle);
    },
    clip() {},
  };
  draw(ctx, { c: (c) => c, team: () => '#4d8cf2', biome });
  return box;
}

/** The original extent of `a` in its sprite box: the bounds (or footprint), grown over a bib row. */
function originalInBox(a, w, h) {
  let [x0, y0, x1, y1] = originalExtent(a);
  if ((RENDER_FACTS[a.id]?.parts ?? []).some((p) => p[0] === 'bib')) {
    // The bib covers the footprint's passable rows ("=" cells, kind 2) under the structure.
    const rows = (a.footprint ?? []).filter((c) => c[2] === 2).map((c) => c[1]);
    if (rows.length) y1 = Math.max(y1, (Math.max(...rows) + 1) * 24 - a.height * 12);
  }
  return [x0 + w / 2, y0 + h / 2, x1 + w / 2, y1 + h / 2];
}

test('the measured set covers the civilian and tech buildings, huts, fields and mines', () => {
  const ids = new Set(measured.map((a) => a.id.toUpperCase()));
  for (const id of ['HOSP', 'BIO', 'MISS', 'FCOM', 'V01', 'V02', 'V12', 'V14', 'V19', 'V25', 'V37', 'RICE', 'LHUS', 'WINDMILL', 'RUSHOUSE', 'SNOWHUT', 'ASIANHUT', 'RAILMINE', 'MINE', 'GMINE']) {
    assert.ok(ids.has(id), `${id} is measured`);
  }
  assert.ok(measured.length >= 50, `${measured.length} structures`);
});

for (const a of measured) {
  test(`world size ${a.id}: fills the original sprite's extent within ${TOLERANCE} px`, (t) => {
    const [w, h, draw] = actorSprites(a).body;
    const want = originalInBox(a, w, h);
    for (const biome of BIOMES) {
      const got = drawnExtent(draw, biome);
      const off = got.map((v, k) => v - want[k]);
      t.diagnostic(`${biome}: drawn ${got.map((v) => v.toFixed(1)).join(',')} original ${want.map((v) => v.toFixed(1)).join(',')}`);
      assert.ok(off.every((d) => Math.abs(d) <= TOLERANCE), `${a.id} (${biome}) drawn ${got.map((v) => v.toFixed(1))} against the original ${want.map((v) => v.toFixed(1))} in its ${w}x${h} box`);
    }
  });
}

test('structures whose original stands taller than its footprint draw into a box that holds it, centred on the footprint', () => {
  const grown = [];
  for (const a of actors) {
    if (a.kind !== 'building' || BUILDING_DRAW[a.id.toUpperCase()] || !worldDraw(a)) continue;
    const box = worldBox(a);
    const [x0, y0, x1, y1] = originalExtent(a);
    const [w, h] = box ?? [a.width * 24, a.height * 24];
    if (!a.world?.bridge) {
      assert.ok(-x0 <= w / 2 + 0.01 && x1 <= w / 2 + 0.01 && -y0 <= h / 2 + 0.01 && y1 <= h / 2 + 0.01, `${a.id}: the original fits its ${w}x${h} box`);
    }
    assert.ok(w >= a.width * 24 && h >= a.height * 24, `${a.id}: the box covers the footprint`);
    if (box) grown.push(a.id);
  }
  assert.deepEqual(grown.sort(), ['LHUS', 'WINDMILL'], 'the lighthouse and the windmill stand taller than their cell');
  // From the repo's numbers: LHUS Bounds 1024,2048 at 0,-682; WINDMILL DecorationBounds 1536,1536 at 0,-597.
  assert.deepEqual(ORIGINAL_BOUNDS.LHUS.bounds, [1024, 2048, 0, -682]);
  assert.deepEqual(worldBox(actors.find((a) => a.id === 'LHUS')), [24, 80]);
  assert.deepEqual(worldBox(actors.find((a) => a.id === 'WINDMILL')), [36, 64]);
});

test('civilians are as big as the original infantry (the longer side within 15 %) and leave their shadow to the renderer', () => {
  const civilians = actors.filter((a) => CIVILIAN_DRAW[a.id]);
  assert.ok(civilians.length >= 13, `${civilians.length} civilians`);
  for (const a of civilians) {
    const rec = ORIGINAL_BOUNDS[a.id]?.decoration ?? ORIGINAL_BOUNDS[a.id]?.bounds;
    assert.ok(rec, `${a.id} has original bounds`);
    const original = (Math.max(rec[0], rec[1]) * 24) / 1024;
    for (const [w, h, draw] of [CIVILIAN_DRAW[a.id].body, CIVILIAN_DRAW[a.id].panic]) {
      const ratio = Math.max(w, h) / original;
      assert.ok(Math.abs(ratio - 1) <= 0.15, `${a.id}: ${w}x${h} against the original ${original} px (${ratio.toFixed(2)})`);
      // No shadow baked in: the renderer casts the ground shadow of slots marked groundShadow (js/sprites.js shadowSlots).
      const fills = [];
      const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { if (k === 'fillStyle') fills.push(v); o[k] = v; return true; } });
      draw(ctx, { c: (c) => c, team: () => '#4d8cf2', biome: 'temperate' });
      assert.ok(!fills.some((f) => String(f).startsWith('rgba(0,0,0,')), `${a.id} draws its own shadow`);
      assert.equal(draw.groundShadow, true, `${a.id} casts the renderer's ground shadow`);
    }
  }
});

test('editor icons of the tall world structures show their drawn extent, not the grown box', () => {
  const lhus = actors.find((a) => a.id === 'LHUS');
  const mill = actors.find((a) => a.id === 'WINDMILL');
  // The original bounds sit a fraction of a pixel off the box's grid (682 and 597 of 1024 per cell).
  const near = (got, want) => assert.ok(got.every((v, k) => Math.abs(v - want[k]) < 0.05), `${got} against ${want}`);
  near(worldIconCrop(lhus), [0, 0, 24, 48]);
  near(worldIconCrop(mill), [0, 0, 36, 36]);
  assert.equal(worldIconCrop(actors.find((a) => a.id === 'HOSP')), null, 'footprint-sized structures show their box');
  // drawIcon scales the crop to the canvas: the lighthouse's 48 px tower fills 92 % of a 64 px icon's height.
  const calls = [];
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (...args) => calls.push([k, ...args])), set: (o, k, v) => ((o[k] = v), true) });
  drawIcon({ width: 64, height: 64, getContext: () => ctx }, lhus, [0.3, 0.5, 0.9]);
  const scale = calls.find((c) => c[0] === 'scale');
  assert.ok(Math.abs(scale[1] - (64 / 48) * 0.92) < 1e-9, `icon scale ${scale[1]}`);
  const clip = calls.find((c) => c[0] === 'rect');
  near(clip.slice(1), [0, 0, 24, 48]);
});
