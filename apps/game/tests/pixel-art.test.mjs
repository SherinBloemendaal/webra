// WebRA's own pixel art (tools/gen_pixel_art.py -> js/art/pixel-data.js, drawn by
// js/art/pixel.js): frame sizes and counts, palette indices, the pose tables the
// atlas gets (with and without original graphics), centring on the footprint and
// the vector-path icon. Synthetic actors only.
// Run: node --test apps/game/tests/pixel-art.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIXEL_ART, PIXEL_INDICES, PIXEL_PALETTE } from '../js/art/pixel-data.js';
import { PIXEL_RES, pixelBodyArt, pixelDraw, pixelFrame, pixelLookup, pixelSlots } from '../js/art/pixel.js';
import { worldDraw } from '../js/art/world.js';
import { buildAtlas, FRAME_FLOATS } from '../js/sprites.js';
import { POSE, POSE_COUNT } from '../js/content/sequences.js';
import { REMAP_END, REMAP_START, ACTOR_SHADOW } from '../js/content/palette.js';
import { pixelDocument } from './content-fixtures.mjs';

const OILB = { id: 'OILB', kind: 'building', width: 2, height: 2, centerOffset: [0, 0] };
const CELL = 24;

test('the oil derrick is two frames (idle, damaged) the size of its 2x2 footprint', () => {
  const art = PIXEL_ART.OILB;
  assert.ok(art, 'OILB has pixel art');
  assert.equal(art.width, 2 * CELL);
  assert.equal(art.height, 2 * CELL);
  assert.deepEqual(art.offset, [0, 0], 'centred on the footprint');
  assert.deepEqual(art.poses, { idle: 0, damaged: 1 });
  assert.equal(art.frames.length, 2);
  const [idle, damaged] = art.frames.map((_, k) => pixelFrame(art, k));
  for (const f of [idle, damaged]) assert.equal(f.data.length, art.width * art.height);
  assert.notDeepEqual(idle.data, damaged.data, 'the damaged frame differs');
});

test('the art uses only palette indices the palette defines, with Red Alert conventions', () => {
  const pal = Uint8Array.from(atob(PIXEL_PALETTE), (ch) => ch.charCodeAt(0));
  assert.equal(pal.length, 768);
  const allowed = new Set(PIXEL_INDICES);
  assert.ok(allowed.has(0) && allowed.has(ACTOR_SHADOW[0]), 'transparent and shadow');
  for (let i = REMAP_START; i <= REMAP_END; i++) assert.ok(allowed.has(i), `remap index ${i}`);
  // Every other allowed index is a colour of the palette; unused ones stay black.
  for (let i = 0; i < 256; i++) {
    const black = pal[i * 3] + pal[i * 3 + 1] + pal[i * 3 + 2] === 0;
    if (i === 0 || i === ACTOR_SHADOW[0]) continue;
    assert.equal(!black, allowed.has(i), `index ${i}`);
  }
  for (const [id, art] of Object.entries(PIXEL_ART)) {
    art.frames.forEach((_, k) => {
      const used = new Set(pixelFrame(art, k).data);
      for (const v of used) assert.ok(allowed.has(v), `${id} frame ${k}: index ${v}`);
      assert.ok(used.has(ACTOR_SHADOW[0]), `${id} frame ${k}: casts a shadow`);
      assert.ok([...used].some((v) => v >= REMAP_START && v <= REMAP_END), `${id} frame ${k}: shows the owner's colour`);
    });
  }
  // The remap range is the team mask, the shadow translucent black.
  const lookup = pixelLookup();
  assert.equal(lookup.mask[REMAP_START + 8], 255);
  assert.equal(lookup.color[ACTOR_SHADOW[0] * 4 + 3] < 255, true);
});

test('the body pose table has the idle and damaged frames, centred on the footprint', () => {
  for (const centerOffset of [[0, 0], [3, -5]]) {
    const art = pixelBodyArt({ ...OILB, centerOffset });
    assert.equal(art.poses.length, POSE_COUNT);
    const imgOf = (pose) => art.images[art.poses[pose].frames[0]];
    const idle = imgOf(POSE.IDLE);
    const damaged = imgOf(POSE.DAMAGED);
    assert.notEqual(idle, damaged);
    assert.equal(imgOf(POSE.STILL), idle);
    assert.equal(imgOf(POSE.DAMAGED_STILL), damaged);
    assert.equal(imgOf(POSE.MAKE), idle, 'no make sequence: idle (OpenRA OILB has none)');
    for (const [img, k] of [[idle, 0], [damaged, 1]]) {
      // Stored at PIXEL_RES atlas pixels per world pixel, drawn at world size.
      assert.equal(img.scale, 1 / PIXEL_RES);
      assert.equal(img.width % PIXEL_RES, 0);
      // The image covers exactly the frame's painted pixels, placed where
      // they lie in the frame, the frame centred on the footprint centre
      // plus the building's centre offset.
      const f = pixelFrame(PIXEL_ART.OILB, k);
      let [l, t, r, b] = [f.width, f.height, -1, -1];
      for (let y = 0; y < f.height; y++) {
        for (let x = 0; x < f.width; x++) {
          if (!f.data[y * f.width + x]) continue;
          l = Math.min(l, x);
          t = Math.min(t, y);
          r = Math.max(r, x);
          b = Math.max(b, y);
        }
      }
      const w = img.width * img.scale;
      const h = img.height * img.scale;
      const left = img.offset[0] - w / 2 + CELL;
      const top = img.offset[1] - h / 2 + CELL;
      assert.ok(left <= l + centerOffset[0] && left + w >= r + 1 + centerOffset[0], `x ${left}..${left + w} covers ${l}..${r}`);
      assert.ok(top <= t + centerOffset[1] && top + h >= b + 1 + centerOffset[1], `y ${top}..${top + h} covers ${t}..${b}`);
      assert.ok(w - (r - l + 1) <= 1 && h - (b - t + 1) <= 1, 'trimmed to the painted pixels');
      // Within the footprint box (shifted by the centre offset).
      assert.ok(left >= centerOffset[0] && left + w <= 2 * CELL + centerOffset[0]);
      assert.ok(top >= centerOffset[1] && top + h <= 2 * CELL + centerOffset[1]);
    }
  }
});

test('the atlas draws the derrick from its pixel art without and with other art', () => {
  globalThis.document = pixelDocument();
  try {
    const other = { id: 'E1', kind: 'infantry', width: 1, height: 1 };
    const actors = [other, OILB];
    const slot = 2;
    const head = (atlas) => atlas.frames.slice(slot * FRAME_FLOATS, (slot + 1) * FRAME_FLOATS);
    // WebRA's own art only: the pose table is there, the engine's poses on, the sampler stays linear.
    const own = buildAtlas(actors, {});
    assert.equal(head(own)[13], POSE_COUNT, 'the body slot heads a pose table');
    assert.equal(own.poses, true);
    assert.equal(own.filter, 'linear');
    // With other installed art (no derrick in it): still the pixel art.
    const installed = buildAtlas(actors, { slots: new Map([[0, null]]), filter: 'nearest' });
    assert.equal(head(installed)[13], POSE_COUNT);
    assert.equal(installed.poses, true);
    // A texture pack's derrick wins over it.
    const blank = { width: 0, height: 0, color: new Uint8ClampedArray(0), mask: null, offset: [0, 0], scale: 1 };
    const still = { frames: [0], length: 1, facings: 1, fps: 1, mode: 0 };
    const pack = { images: [blank], poses: new Array(POSE_COUNT).fill(still) };
    const packed = buildAtlas(actors, { slots: new Map([[slot, pack]]), filter: 'nearest' });
    const first = packed.frames[head(packed)[12] * FRAME_FLOATS + 8];
    assert.equal(packed.frames[first * FRAME_FLOATS + 4], 0, 'the pack\'s empty image, not the derrick');
    const ownFirst = own.frames[head(own)[12] * FRAME_FLOATS + 8];
    assert.ok(own.frames[ownFirst * FRAME_FLOATS + 4] > 40, 'the derrick spans its footprint');
    // Actors without pixel art get no slot.
    assert.deepEqual([...pixelSlots(actors).keys()], [slot]);
    assert.equal(pixelSlots([other]).size, 0);
  } finally {
    delete globalThis.document;
  }
});

test('the derrick\'s icon paints the idle frame pixel by pixel into its footprint', () => {
  assert.equal(pixelDraw({ id: 'E1', kind: 'infantry' }), null);
  const draw = worldDraw(OILB);
  const fills = [];
  let style = null;
  const ctx = { set fillStyle(v) { style = v; }, fillRect: (x, y, w, h) => fills.push([x, y, w, h, style]) };
  const P = { c: (v) => v, team: (s) => `team(${s.toFixed(3)})` };
  draw(ctx, P);
  const f = pixelFrame(PIXEL_ART.OILB, 0);
  const painted = [...f.data].filter((v) => v !== 0).length;
  assert.equal(fills.length, painted);
  for (const [x, y, w, h] of fills) {
    assert.ok(x >= 0 && y >= 0 && x + w <= 48 && y + h <= 48 && w === 1 && h === 1);
  }
  assert.ok(fills.some((r) => r[4].startsWith('team(')), 'the owner\'s colour');
  assert.ok(fills.some((r) => r[4].startsWith('rgba(0,0,0,')), 'the shadow');
  // The same pixels in the same places as the frame.
  const team = fills.filter((r) => r[4].startsWith('team('));
  const remap = [...f.data].filter((v) => v >= REMAP_START && v <= REMAP_END).length;
  assert.equal(team.length, remap);
});
