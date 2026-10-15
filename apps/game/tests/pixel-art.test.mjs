// WebRA's own pixel art (tools/gen_pixel_art.py -> js/art/pixel-data.js, drawn by
// js/art/pixel.js): frame counts per sequence, facings and their order, palette
// indices, the owner's colour and shadows, the pose tables the atlas gets (with
// and without original graphics, under a texture pack), the slots the engine
// draws as pre-rendered art, centring, icons and cameos. Synthetic actors only.
// Run: node --test apps/game/tests/pixel-art.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIXEL_ART, PIXEL_INDICES, PIXEL_PALETTE } from '../js/art/pixel-data.js';
import { PIXEL_RES, pixelBodyArt, pixelBox, pixelDraw, pixelFrame, pixelLookup, pixelPartArt, pixelSlots, pixelUnitDraw, drawPixelCameo } from '../js/art/pixel.js';
import { worldDraw } from '../js/art/world.js';
import { actorSprites, buildAtlas, drawCameo, FRAME_FLOATS } from '../js/sprites.js';
import { BUILDING_DRAW, BUILDING_SIZE } from '../js/art/buildings.js';
import { prerenderedSlots } from '../js/gameart.js';
import { MODE, POSE, POSE_COUNT, facingFrame } from '../js/content/sequences.js';
import { REMAP_END, REMAP_START, ACTOR_SHADOW } from '../js/content/palette.js';
import { pixelDocument } from './content-fixtures.mjs';

const OILB = { id: 'OILB', kind: 'building', width: 2, height: 2, centerOffset: [0, 0] };
const MH60 = { id: 'MH60', kind: 'aircraft', width: 1, height: 1 };
const FTRK = { id: 'FTRK', kind: 'vehicle', width: 1, height: 1 };
const LROD = { id: 'LROD', kind: 'building', width: 1, height: 1, centerOffset: [0, 0] };
const CELL = 24;
const SHADOW = ACTOR_SHADOW[0];
const isRemap = (v) => v >= REMAP_START && v <= REMAP_END;
const used = (art, k) => new Set(pixelFrame(art, k).data);
const range = (start, n) => Array.from({ length: n }, (_, k) => start + k);
const glass = (() => {
  // The glazing ramp: the palette's blue colours (green well over red, blue over green), not the steel.
  const pal = Uint8Array.from(atob(PIXEL_PALETTE), (ch) => ch.charCodeAt(0));
  return new Set(PIXEL_INDICES.filter((i) => !isRemap(i) && i > 4 && pal[i * 3 + 1] >= pal[i * 3] + 12 && pal[i * 3 + 2] > pal[i * 3 + 1]));
})();

test('the oil derrick is two frames (idle, damaged) within its 2x2 footprint', () => {
  const art = PIXEL_ART.OILB;
  assert.ok(art, 'OILB has pixel art');
  assert.deepEqual(art.offset, [0, 0], 'centred on the footprint');
  assert.deepEqual(art.body, { idle: { start: 0 }, damaged: { start: 1 } });
  assert.equal(art.second, undefined);
  assert.equal(art.frames.length, 2);
  const [idle, damaged] = art.frames.map((_, k) => pixelFrame(art, k));
  for (const f of [idle, damaged]) {
    assert.equal(f.data.length, f.width * f.height);
    assert.ok(f.left >= -CELL && f.top >= -CELL && f.left + f.width <= CELL && f.top + f.height <= CELL, 'inside the footprint');
  }
  assert.notDeepEqual(idle.data, damaged.data, 'the damaged frame differs');
});

test('the Lightning Rod is idle, damaged and a 12 frame make animation on its 1x1 footprint, its mast two cells high', () => {
  const art = PIXEL_ART.LROD;
  assert.ok(art, 'LROD has pixel art');
  assert.deepEqual(art.offset, [0, 0], 'centred on the footprint');
  assert.deepEqual(art.body, { idle: { start: 0 }, damaged: { start: 1 }, make: { start: 2, length: 12 } });
  assert.equal(art.second, undefined);
  assert.equal(art.frames.length, 14);
  const frames = art.frames.map((_, k) => pixelFrame(art, k));
  for (const [k, f] of frames.entries()) {
    assert.equal(f.data.length, f.width * f.height, `frame ${k}`);
    // On the cell (its west and north edges), the cast shadow to the south east.
    assert.ok(f.left >= -CELL / 2 && f.top + f.height <= CELL, `frame ${k} on its cell`);
  }
  // Selectable DecorationBounds 1024, 2048, 0, -512: about 36 pixels above the cell's centre.
  const idle = frames[0];
  assert.ok(idle.top <= -34 && idle.top >= -40, `the rod's tip at ${idle.top}`);
  assert.ok(frames[1].top > idle.top + 6, 'the damaged mast is bent over');
  // The rod and its crown are copper, the damaged rod too.
  const pal = Uint8Array.from(atob(PIXEL_PALETTE), (ch) => ch.charCodeAt(0));
  const copper = (v) => v > 4 && !isRemap(v) && pal[v * 3] > pal[v * 3 + 2] + 60 && pal[v * 3 + 1] < pal[v * 3] * 0.75;
  for (const k of [0, 1]) assert.ok([...used(art, k)].some(copper), `frame ${k}: copper`);
  // The make animation builds up: the pad, the plinth, the mast rising, the rod last; the idle frame adds the cable.
  const tops = frames.slice(2).map((f) => f.top);
  for (let k = 1; k < tops.length; k++) assert.ok(tops[k] <= tops[k - 1], `make ${k} is no lower than make ${k - 1}`);
  assert.ok(tops[0] >= -CELL / 2, 'make 0: the ground only');
  assert.equal(tops[tops.length - 1], idle.top, 'the last make frame is the whole rod');
  assert.equal(new Set(frames.map((f) => f.data.join())).size, 14, 'every frame differs');
  assert.ok(![...used(art, 2)].some(isRemap), 'make 0: no plinth, no owner\'s colour yet');
});

test('structures are drawn in Westwood\'s structure view: their pads fill the footprint, cast shadows darken the pad', () => {
  // The ground is not shortened (Red Alert's cells are 24 x 24 on screen): the derrick's pad spans its two cells both ways.
  const oil = pixelFrame(PIXEL_ART.OILB, 0);
  assert.ok(oil.width >= 44 && oil.height >= 44, `derrick ${oil.width} x ${oil.height}`);
  // The Lightning Rod's finished pad (make 2) covers its cell the same way, square.
  const pad = pixelFrame(PIXEL_ART.LROD, 4);
  assert.ok(pad.width >= 22 && pad.width <= 24 && Math.abs(pad.height - pad.width) <= 2, `pad ${pad.width} x ${pad.height}`);
  // The plinth's cast shadow falls on the pad as a darker shade of the concrete (make 4 against the bare pad of make 2),
  // not as the shadow index, which could only darken the ground under the sprite.
  const plinth = pixelFrame(PIXEL_ART.LROD, 6);
  const pal = Uint8Array.from(atob(PIXEL_PALETTE), (ch) => ch.charCodeAt(0));
  const at = (f, x, y) => f.data[(y - f.top) * f.width + x - f.left];
  const lum = (v) => pal[v * 3] + pal[v * 3 + 1] + pal[v * 3 + 2];
  let darker = 0;
  for (let y = -2; y <= 2; y++) {
    for (let x = 6; x <= 6; x++) {
      const [before, after] = [at(pad, x, y), at(plinth, x, y)];
      assert.ok(before !== SHADOW && after !== SHADOW && after !== 0, `(${x}, ${y}) is concrete`);
      if (lum(after) < lum(before) - 60) darker++;
    }
  }
  assert.ok(darker >= 3, `${darker} pad pixels in the plinth's shadow`);
});

test('the Black Hawk has 32 body facings, 8 ground and 4 air rotor frames and a cameo', () => {
  const art = PIXEL_ART.MH60;
  assert.deepEqual(art.body, { idle: { start: 0, facings: 32 } });
  assert.deepEqual(art.second, { idle: { start: 32, length: 8 }, move: { start: 40, length: 4 } });
  assert.equal(art.frames.length, 44);
  // Facing f looks f * 11.25 degrees anticlockwise from north: the glazed nose
  // is on top facing north, on the left facing west, at the bottom facing
  // south and on the right facing east.
  const glassCentre = (k) => {
    const f = pixelFrame(art, k);
    let [sx, sy, n] = [0, 0, 0];
    f.data.forEach((v, i) => {
      if (!glass.has(v)) return;
      sx += f.left + (i % f.width) + 0.5;
      sy += f.top + Math.floor(i / f.width) + 0.5;
      n++;
    });
    assert.ok(n > 0, `frame ${k} shows the cockpit`);
    return [sx / n, sy / n];
  };
  const centre = (k) => {
    const f = pixelFrame(art, k);
    return [f.left + f.width / 2, f.top + f.height / 2];
  };
  const along = (k) => [glassCentre(k)[0] - centre(k)[0], glassCentre(k)[1] - centre(k)[1]];
  assert.ok(along(0)[1] < -3, 'north: nose up');
  assert.ok(along(8)[0] < -6, 'west: nose left');
  assert.ok(along(16)[1] > 2, 'south: nose down');
  assert.ok(along(24)[0] > 6, 'east: nose right');
  // About the Longbow's and the Hind's size: some 32 pixels nose to tail facing west.
  const west = pixelFrame(art, 8);
  assert.ok(west.width >= 28 && west.width <= 38, `${west.width} wide`);
  // The stub wings with their rocket pods reach well past the cabin facing north (about 23 pixels tip to tip).
  const north = pixelFrame(art, 0);
  assert.ok(north.width >= 23 && north.width <= 28, `${north.width} wide facing north`);
  // Mirror images are not reused: east and west differ beyond a flip.
  const east = pixelFrame(art, 24);
  const flipped = new Uint8Array(west.data.length);
  for (let y = 0; y < west.height; y++) for (let x = 0; x < west.width; x++) flipped[y * west.width + x] = west.data[y * west.width + west.width - 1 - x];
  assert.ok(east.width !== west.width || east.height !== west.height || !east.data.every((v, i) => v === flipped[i]), 'east is drawn, not mirrored');
  // The rotor frames: round the hub over the body (no facings), every one different.
  const rotors = range(32, 12).map((k) => pixelFrame(art, k));
  for (const f of rotors) {
    assert.ok(f.top < -6 - 6 && f.top + f.height > -6, 'around the hub, above the body centre');
    assert.ok(Math.abs(f.left + f.width / 2) <= 1, 'centred on the mast');
  }
  assert.equal(new Set(rotors.map((f) => f.data.join())).size, 12, 'the blades turn from frame to frame');
  // The airborne frames blur over a translucent disc (shadow pixels); the ground ones are crisp blades.
  for (const k of range(40, 4)) assert.ok(used(art, k).has(SHADOW), `rotor ${k}: the disc`);
  for (const k of range(32, 8)) assert.ok(!used(art, k).has(SHADOW), `slow rotor ${k}: blades only`);
});

test('the Mobile Flak has 32 body and 32 turret facings and a cameo', () => {
  const art = PIXEL_ART.FTRK;
  assert.deepEqual(art.body, { idle: { start: 0, facings: 32 } });
  assert.deepEqual(art.second, { idle: { start: 32, facings: 32 } });
  assert.equal(art.frames.length, 64);
  for (const k of range(0, 32)) {
    const f = pixelFrame(art, k);
    // About the supply truck's and the APC's size.
    assert.ok(Math.max(f.width, f.height) >= 18 && Math.max(f.width, f.height) <= 34, `body ${k}: ${f.width} x ${f.height}`);
  }
  // Side on, the cab stands to its full height (about 9.6 pixels), over the hood and the bed.
  for (const k of [8, 24]) assert.ok(pixelFrame(art, k).top <= -11, `body ${k}: the cab's roof`);
  for (const k of range(32, 32)) {
    const f = pixelFrame(art, k);
    // Drawn around its pivot raised by the Turreted offset's height (298 units: 7 pixels).
    assert.ok(f.top < -7 && f.top + f.height > -9, `turret ${k} at its height`);
  }
  // The guns point the way the turret faces: north up, west left, south down, east right.
  const reach = (k) => {
    const f = pixelFrame(art, k);
    return [f.left, f.left + f.width, f.top, f.top + f.height];
  };
  assert.ok(reach(32)[2] < reach(48)[2] - 4, 'north reaches higher than south');
  assert.ok(reach(40)[0] < -7 && reach(56)[1] > 7, 'west reaches left, east right');
});

test('every frame uses the palette with Red Alert conventions, the owner\'s colour and shadows', () => {
  const pal = Uint8Array.from(atob(PIXEL_PALETTE), (ch) => ch.charCodeAt(0));
  assert.equal(pal.length, 768);
  const allowed = new Set(PIXEL_INDICES);
  assert.ok(allowed.has(0) && allowed.has(SHADOW), 'transparent and shadow');
  for (let i = REMAP_START; i <= REMAP_END; i++) assert.ok(allowed.has(i), `remap index ${i}`);
  // Every other allowed index is a colour of the palette; unused ones stay black.
  for (let i = 0; i < 256; i++) {
    const black = pal[i * 3] + pal[i * 3 + 1] + pal[i * 3 + 2] === 0;
    if (i === 0 || i === SHADOW) continue;
    assert.equal(!black, allowed.has(i), `index ${i}`);
  }
  for (const [id, art] of Object.entries(PIXEL_ART)) {
    art.frames.forEach((_, k) => {
      for (const v of used(art, k)) assert.ok(allowed.has(v), `${id} frame ${k}: index ${v}`);
    });
  }
  // The owner's colour on every body and turret frame (not on the rotor blades).
  const owner = { OILB: [0, 1], LROD: [0, 1, ...range(6, 8)], MH60: range(0, 32), FTRK: range(0, 64) };
  for (const [id, frames] of Object.entries(owner)) {
    for (const k of frames) assert.ok([...used(PIXEL_ART[id], k)].some(isRemap), `${id} frame ${k}: the owner's colour`);
  }
  for (const k of range(32, 12)) assert.ok(![...used(PIXEL_ART.MH60, k)].some(isRemap), `rotor ${k}: no owner's colour`);
  // Cast shadows on the ground: the structure and the truck. The aircraft's
  // shadow is drawn by the engine (its sprite, dark, on the ground), and a
  // turret's would fall on its own body.
  for (const k of [0, 1]) assert.ok(used(PIXEL_ART.OILB, k).has(SHADOW), `OILB ${k}: casts a shadow`);
  for (const k of range(0, 14).filter((k) => k < 2 || k > 4)) assert.ok(used(PIXEL_ART.LROD, k).has(SHADOW), `LROD ${k}: casts a shadow`);
  for (const k of range(0, 32)) assert.ok(used(PIXEL_ART.FTRK, k).has(SHADOW), `FTRK body ${k}: casts a shadow`);
  for (const k of range(32, 32)) assert.ok(!used(PIXEL_ART.FTRK, k).has(SHADOW), `FTRK turret ${k}: no shadow`);
  for (const k of range(0, 32)) assert.ok(!used(PIXEL_ART.MH60, k).has(SHADOW), `MH60 body ${k}: no shadow`);
  // The remap range is the team mask, the shadow translucent black.
  const lookup = pixelLookup();
  assert.equal(lookup.mask[REMAP_START + 8], 255);
  assert.equal(lookup.color[SHADOW * 4 + 3] < 255, true);
});

test('cameos are opaque 64 x 48 pictures in their own colours', () => {
  for (const id of ['MH60', 'FTRK', 'LROD']) {
    const [w, h, b64] = PIXEL_ART[id].cameo;
    assert.deepEqual([w, h], [64, 48], id);
    const data = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    assert.equal(data.length, w * h);
    const allowed = new Set(PIXEL_INDICES);
    for (const v of data) {
      assert.ok(allowed.has(v), `${id}: index ${v}`);
      assert.ok(v !== 0 && v !== SHADOW && !isRemap(v), `${id}: opaque, not remapped (${v})`);
    }
  }
  assert.equal(PIXEL_ART.OILB.cameo, undefined, 'the derrick is not built: no cameo');
  // Painted into the sidebar button, scaled to its size; WebRA's drawing otherwise.
  const fills = [];
  const ctx = { set fillStyle(v) { fills.push(v); }, fillRect() {} };
  assert.equal(drawPixelCameo(ctx, 'MH60', 128, 96), true);
  assert.equal(fills.length, 64 * 48);
  assert.ok(fills.every((f) => f.startsWith('rgb(')));
  assert.equal(drawPixelCameo(ctx, 'HIND', 64, 48), false);
  fills.length = 0;
  assert.equal(drawCameo(ctx, 'ftrk', 64, { height: 48 }), true, 'the sidebar cameo is the pixel picture');
  assert.equal(fills.length, 64 * 48);
  fills.length = 0;
  assert.equal(drawCameo(ctx, 'LROD', 64, { height: 48 }), true, 'the Lightning Rod\'s cameo too');
  assert.equal(fills.length, 64 * 48);
});

test('the pose tables play the sequences: facings, rotor loops, idle fallbacks', () => {
  const body = pixelPartArt(MH60, 'body');
  assert.equal(body.poses.length, POSE_COUNT);
  const idle = body.poses[POSE.IDLE];
  assert.deepEqual([idle.facings, idle.length, idle.classic, idle.mode, idle.frames.length], [32, 1, false, MODE.LOOP, 32]);
  assert.equal(body.poses[POSE.MOVE], idle, 'no move sequence: idle');
  assert.equal(body.images.length, 32);
  const rotor = pixelPartArt(MH60, 'second');
  assert.deepEqual([rotor.poses[POSE.IDLE].length, rotor.poses[POSE.IDLE].facings, rotor.poses[POSE.IDLE].fps], [8, 1, 25]);
  assert.deepEqual([rotor.poses[POSE.MOVE].length, rotor.poses[POSE.MOVE].mode], [4, MODE.LOOP]);
  assert.equal(rotor.poses[POSE.AUX_IDLE].length, 8, 'one rotor: the aux poses repeat it');
  const turret = pixelPartArt(FTRK, 'second');
  assert.equal(turret.poses[POSE.IDLE].facings, 32);
  assert.equal(pixelPartArt(OILB, 'second'), null);
  // Facing frames as the sprite shader picks them (even steps, no classic ranges):
  // WebRA's facing a (clockwise) shows frame f anticlockwise from north.
  for (const [radians, frame] of [[0, 0], [Math.PI / 2, 24], [Math.PI, 16], [-Math.PI / 2, 8], [(Math.PI * 2) / 32, 31]]) {
    assert.equal(facingFrame(radians, idle).facing, frame, `${radians}`);
  }
  // Images at PIXEL_RES atlas pixels per world pixel, placed where the frame says.
  for (const k of [0, 8]) {
    const img = body.images[idle.frames[k]];
    const f = pixelFrame(PIXEL_ART.MH60, k);
    assert.equal(img.scale, 1 / PIXEL_RES);
    const w = img.width * img.scale;
    const h = img.height * img.scale;
    assert.ok(Math.abs(img.offset[0] - w / 2 - f.left) <= 1 && Math.abs(img.offset[1] - h / 2 - f.top) <= 1, `frame ${k} in place`);
  }
});

test('the derrick\'s pose table has the idle and damaged frames, centred on the footprint', () => {
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
      assert.equal(img.scale, 1 / PIXEL_RES);
      assert.equal(img.width % PIXEL_RES, 0);
      const f = pixelFrame(PIXEL_ART.OILB, k);
      let [l, t, r, b] = [f.width, f.height, -1, -1];
      for (let y = 0; y < f.height; y++) {
        for (let x = 0; x < f.width; x++) {
          if (!f.data[y * f.width + x]) continue;
          [l, t, r, b] = [Math.min(l, x), Math.min(t, y), Math.max(r, x), Math.max(b, y)];
        }
      }
      // Footprint coordinates (0..48) of the painted pixels and of the image.
      [l, r] = [l + f.left + CELL, r + f.left + CELL];
      [t, b] = [t + f.top + CELL, b + f.top + CELL];
      const w = img.width * img.scale;
      const h = img.height * img.scale;
      const left = img.offset[0] - w / 2 + CELL;
      const top = img.offset[1] - h / 2 + CELL;
      assert.ok(left <= l + centerOffset[0] && left + w >= r + 1 + centerOffset[0], `x ${left}..${left + w} covers ${l}..${r}`);
      assert.ok(top <= t + centerOffset[1] && top + h >= b + 1 + centerOffset[1], `y ${top}..${top + h} covers ${t}..${b}`);
      assert.ok(w - (r - l + 1) <= 1 && h - (b - t + 1) <= 1, 'trimmed to the painted pixels');
      assert.ok(left >= centerOffset[0] && left + w <= 2 * CELL + centerOffset[0]);
      assert.ok(top >= centerOffset[1] && top + h <= 2 * CELL + centerOffset[1]);
    }
  }
});

test('the Lightning Rod\'s pose table: idle, damaged, the make animation once from placement', () => {
  const art = pixelBodyArt(LROD);
  assert.equal(art.poses.length, POSE_COUNT);
  assert.equal(art.images.length, 14);
  const imgOf = (pose) => art.images[art.poses[pose].frames[0]];
  const idle = imgOf(POSE.IDLE);
  assert.notEqual(imgOf(POSE.DAMAGED), idle);
  assert.equal(imgOf(POSE.STILL), idle);
  assert.equal(imgOf(POSE.DAMAGED_STILL), imgOf(POSE.DAMAGED));
  const make = art.poses[POSE.MAKE];
  // OpenRA WithMakeAnimation: the make sequence once (40 ms a frame), then idle; within the ages the engine reports.
  assert.deepEqual([make.mode, make.length, make.facings, make.fps], [MODE.ONCE, 12, 1, 25]);
  assert.ok(Math.ceil((make.length * 25) / make.fps) < 127, 'played within MAX_POSE_AGE ticks');
  assert.equal(new Set(make.frames).size, 12);
  assert.ok(!make.frames.includes(art.poses[POSE.IDLE].frames[0]), 'the make frames are their own');
  // Placed on the cell: the image's bottom at the cell's south edge, the mast above it.
  const h = idle.height * idle.scale;
  assert.ok(Math.abs(idle.offset[1] + h / 2 - pixelFrame(PIXEL_ART.LROD, 0).top - pixelFrame(PIXEL_ART.LROD, 0).height) <= 1);
  assert.ok(idle.offset[1] - h / 2 <= -34, 'the mast rises over the cell');
  // In the atlas: the body slot heads its pose table, the second slot stays empty.
  const other = { id: 'E1', kind: 'infantry', width: 1, height: 1 };
  assert.deepEqual([...pixelSlots([other, LROD]).keys()], [2]);
  globalThis.document = pixelDocument();
  try {
    const atlas = buildAtlas([other, LROD], {});
    assert.equal(atlas.frames[2 * FRAME_FLOATS + 13], POSE_COUNT, 'slot 2 heads a pose table');
    assert.deepEqual(atlas.pixel, [2]);
    assert.equal(atlas.poses, true, 'the engine reports poses: the make animation plays');
  } finally {
    delete globalThis.document;
  }
});

test('the atlas uses the pixel art where no pack or original art has the slot', () => {
  globalThis.document = pixelDocument();
  try {
    const other = { id: 'E1', kind: 'infantry', width: 1, height: 1 };
    const actors = [other, OILB, MH60, FTRK];
    const head = (atlas, slot) => atlas.frames.slice(slot * FRAME_FLOATS, (slot + 1) * FRAME_FLOATS);
    const ours = [2, 4, 5, 6, 7];
    assert.deepEqual([...pixelSlots(actors).keys()].sort((a, b) => a - b), ours, 'derrick body; Black Hawk and Mobile Flak body and second');
    assert.equal(pixelSlots([other]).size, 0);
    // WebRA's own art only: the pose tables are there, the engine's poses on, the sampler stays linear.
    const own = buildAtlas(actors, {});
    for (const slot of ours) assert.equal(head(own, slot)[13], POSE_COUNT, `slot ${slot} heads a pose table`);
    assert.equal(own.poses, true);
    assert.equal(own.filter, 'linear');
    assert.deepEqual(own.pixel, ours, 'the engine draws these as pre-rendered art');
    // With the original graphics (which have none of these actors): still the pixel art.
    const installed = buildAtlas(actors, { slots: new Map([[0, null]]), filter: 'nearest' });
    assert.deepEqual(installed.pixel, ours);
    // A texture pack's Mobile Flak body wins over it, the pixel turret stays on it;
    // a pack hiding the Black Hawk's rotor (null) hides it.
    const blank = { width: 0, height: 0, color: new Uint8ClampedArray(0), mask: null, offset: [0, 0], scale: 1 };
    const still = { frames: [0], length: 1, facings: 1, fps: 1, mode: 0 };
    const pack = { images: [blank], poses: new Array(POSE_COUNT).fill(still) };
    const packed = buildAtlas(actors, { slots: new Map([[6, pack], [5, null]]), filter: 'nearest' });
    assert.deepEqual(packed.pixel, [2, 4, 7]);
    const first = packed.frames[head(packed, 6)[12] * FRAME_FLOATS + 8];
    assert.equal(packed.frames[first * FRAME_FLOATS + 4], 0, 'the pack\'s empty image, not the truck');
    assert.equal(head(packed, 5)[13], 0, 'the hidden rotor has no pose table');
    // Pixel slots join the original ones the engine draws the OpenRA way (Game.set_original_slots).
    assert.deepEqual([...prerenderedSlots(Uint32Array.from([9, 3]), own.pixel)], [2, 3, 4, 5, 6, 7, 9]);
    assert.deepEqual([...prerenderedSlots(undefined, [7, 6])], [6, 7]);
    assert.deepEqual([...prerenderedSlots(Uint32Array.from([5]), [5])], [5], 'once each');
  } finally {
    delete globalThis.document;
  }
});

test('icons paint the pixel art pixel by pixel', () => {
  assert.equal(pixelDraw({ id: 'E1', kind: 'infantry' }), null);
  assert.equal(pixelUnitDraw('E1'), null);
  const paint = (draw) => {
    const fills = [];
    let style = null;
    const ctx = { set fillStyle(v) { style = v; }, fillRect: (x, y, w, h) => fills.push([x, y, w, h, style]) };
    draw(ctx, { c: (v) => v, team: (s) => `team(${s.toFixed(3)})` });
    return fills;
  };
  // The derrick's idle frame in its footprint.
  const fills = paint(worldDraw(OILB));
  const f = pixelFrame(PIXEL_ART.OILB, 0);
  assert.equal(fills.length, [...f.data].filter((v) => v !== 0).length);
  for (const [x, y, w, h] of fills) assert.ok(x >= 0 && y >= 0 && x + w <= 48 && y + h <= 48 && w === 1 && h === 1);
  assert.ok(fills.some((r) => r[4].startsWith('team(')), 'the owner\'s colour');
  assert.ok(fills.some((r) => r[4].startsWith('rgba(0,0,0,')), 'the shadow');
  assert.equal(fills.filter((r) => r[4].startsWith('team(')).length, [...f.data].filter(isRemap).length);
  // The Lightning Rod's mast stands above its cell: its icon box grows evenly round the footprint, so all of it shows.
  const [bw, bh] = pixelBox(LROD);
  assert.deepEqual(pixelBox(OILB), [48, 48], 'the derrick fits its footprint');
  assert.ok(bw >= 24 && bh >= 72 && bw % 2 === 0 && bh % 2 === 0, `${bw} x ${bh}`);
  assert.deepEqual(actorSprites(LROD).body.slice(0, 2), [bw, bh], 'the building sprite uses that box');
  assert.equal(actorSprites(LROD).body[2], BUILDING_DRAW.LROD);
  assert.deepEqual(BUILDING_SIZE.LROD, [1, 1]);
  const rod = paint(BUILDING_DRAW.LROD);
  assert.equal(rod.length, [...pixelFrame(PIXEL_ART.LROD, 0).data].filter((v) => v !== 0).length);
  for (const [x, y] of rod) assert.ok(x >= 0 && y >= 0 && x < bw && y < bh, 'inside its box');
  assert.ok(rod.some((r) => r[4].startsWith('team(')), 'the owner\'s colour band');
  // Units face north in one box centred on them: the body, then the turret or the stopped rotor.
  for (const [id, second] of [['MH60', 32], ['FTRK', 32]]) {
    const d = pixelUnitDraw(id, id === 'FTRK' ? [-298, 0] : [0, 0]);
    const [w, h, body] = d.body;
    const [tw, th, turret] = d.turret;
    assert.deepEqual([tw, th], [w, h], `${id}: one box`);
    const b = paint(body);
    const t = paint(turret);
    assert.equal(b.length, [...pixelFrame(PIXEL_ART[id], 0).data].filter((v) => v !== 0).length);
    assert.equal(t.length, [...pixelFrame(PIXEL_ART[id], second).data].filter((v) => v !== 0).length);
    for (const [x, y] of [...b, ...t]) assert.ok(x >= 0 && y >= 0 && x < w && y < h, `${id} inside its box`);
  }
});
