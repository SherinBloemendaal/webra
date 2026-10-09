// Red Alert's own mouse cursors (js/content/cursors.js, js/cursors.js
// setCursorArt) and the Dune 2 layout SHP they come in (mouse.shp,
// js/content/shp.js decodeShpD2). Every file is made up here: no Electronic
// Arts file, and nothing made from one, is in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeShpD2, isShpD2, decodeSprite, ContentError } from '../js/content/shp.js';
import { encodePng, pngDataUrl, originalCursorFrames, originalCursors, CURSOR_FPS } from '../js/content/cursors.js';
import { ACTOR_PALETTE, CURSOR_ART } from '../js/content/tables.js';
import { CURSORS, CURSOR_NAMES, COMMAND_CURSOR_NAMES, ACTION_CURSORS, ACTION, MODE_CURSORS, POWER_CURSORS, setCursorArt, tickCursors } from '../js/cursors.js';
import { COMMAND_CURSORS } from '../js/commandbar.js';
import { cursorArt } from '../js/mouselock.js';
import { decodePalette, paletteLookup } from '../js/content/palette.js';
import { buildPal, decodeTestPng, lcwEncode } from './content-fixtures.mjs';

const LOOKUP = paletteLookup(decodePalette(buildPal((i) => [i & 63, i >> 6, 0])), { remap: false, shadow: [] });

/**
 * A Dune 2 layout SHP (OpenRA ShpD2Loader): u16 count, u16 offsets (relative
 * to byte 2) and the end, frames of { u16 flags, u8, u16 width, u8 height,
 * u16 size, u16 decoded size, data }. `frames` are { width, height, data }
 * with zero runs RLE coded; `lcw` compresses them too; `table` uses a
 * 16 entry colour table (flag 1).
 */
function buildShpD2(frames, { lcw = false, table = null } = {}) {
  const blobs = frames.map((f) => {
    const rle = [];
    for (let i = 0; i < f.data.length; ) {
      if (f.data[i] === 0) {
        let n = 0;
        while (i < f.data.length && f.data[i] === 0 && n < 255) {
          n++;
          i++;
        }
        rle.push(0, n);
      } else rle.push(f.data[i++]);
    }
    const raw = Uint8Array.from(rle);
    const packed = lcw ? lcwEncode(raw) : raw;
    const flags = (lcw ? 0 : 2) | (table ? 1 : 0);
    const head = new Uint8Array(10);
    const dv = new DataView(head.buffer);
    dv.setUint16(0, flags, true);
    dv.setUint16(3, f.width, true);
    head[5] = f.height;
    const tbl = table ? Uint8Array.from(table) : new Uint8Array(0);
    dv.setUint16(6, 10 + tbl.length + packed.length, true);
    dv.setUint16(8, raw.length, true);
    const out = new Uint8Array(10 + tbl.length + packed.length);
    out.set(head);
    out.set(tbl, 10);
    out.set(packed, 10 + tbl.length);
    return out;
  });
  const count = frames.length;
  const header = 2 + 2 * (count + 1);
  const total = header + blobs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, count, true);
  let at = header;
  blobs.forEach((b, i) => {
    dv.setUint16(2 + i * 2, at - 2, true);
    out.set(b, at);
    at += b.length;
  });
  dv.setUint16(2 + count * 2, total - 2, true);
  return out;
}

const frame = (w, h, fill) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h }, (_, i) => fill(i % w, Math.floor(i / w))) });

test('Dune 2 SHP: RLE zero runs, LCW, colour tables and frames of their own sizes decode like OpenRA', () => {
  const a = frame(6, 4, (x, y) => (x + y) % 3 === 0 ? 0 : 10 + x + y * 6);
  const b = frame(3, 5, (x) => (x === 1 ? 0 : 50));
  for (const lcw of [false, true]) {
    const bytes = buildShpD2([a, b], { lcw });
    assert.ok(isShpD2(bytes));
    const s = decodeShpD2(bytes);
    assert.equal(s.frames.length, 2);
    assert.deepEqual(Array.from(s.frames[0].data), Array.from(a.data), `lcw ${lcw}`);
    assert.deepEqual([s.frames[1].width, s.frames[1].height], [3, 5]);
    assert.deepEqual(Array.from(decodeSprite(bytes).frames[1].data), Array.from(b.data));
  }
  // Without a table, values 1..4 are looked up as 0x7f..0x7c (OpenRA's default table).
  const low = decodeShpD2(buildShpD2([frame(2, 1, (x) => x + 1)]));
  assert.deepEqual(Array.from(low.frames[0].data), [0x7f, 0x7e]);
  // A colour table maps every value.
  const t = decodeShpD2(buildShpD2([frame(2, 1, (x) => x + 1)], { table: [0, 33, 44, 55, 66, 77, 88, 99, 1, 2, 3, 4, 5, 6, 7, 8] }));
  assert.deepEqual(Array.from(t.frames[0].data), [33, 44]);
});

test('Dune 2 SHP: hostile files fail with ContentError, never read or write out of bounds', () => {
  const good = buildShpD2([frame(4, 4, () => 9)]);
  assert.ok(!isShpD2(good.slice(0, good.length - 1)), 'the end offset must match the file size');
  const runs = good.slice();
  // A zero run longer than the frame.
  runs[good.length - 2] = 0;
  runs[good.length - 1] = 200;
  assert.throws(() => decodeShpD2(runs), ContentError);
  const big = good.slice();
  new DataView(big.buffer).setUint16(2 + 4 + 3, 2000, true);
  assert.throws(() => decodeShpD2(big), ContentError);
  for (let n = 0; n < 200; n++) {
    const bad = good.slice();
    bad[(n * 7) % bad.length] ^= 0x5a + n;
    try {
      decodeSprite(bad);
    } catch (err) {
      assert.ok(err instanceof ContentError, err.message);
    }
  }
});

test('cursor PNGs: valid files of the cursor pixels, as data URLs', async () => {
  const rgba = new Uint8ClampedArray(5 * 3 * 4).map((_, i) => (i * 37) % 256);
  const back = await decodeTestPng(encodePng(5, 3, rgba));
  assert.deepEqual([back.width, back.height], [5, 3]);
  assert.deepEqual(Array.from(back.rgba), Array.from(rgba));
  // Larger than one stored block.
  const wide = new Uint8ClampedArray(200 * 100 * 4).fill(7);
  assert.deepEqual(Array.from((await decodeTestPng(encodePng(200, 100, wide))).rgba.slice(0, 8)), [7, 7, 7, 7, 7, 7, 7, 7]);
  assert.match(pngDataUrl(1, 1, new Uint8ClampedArray([1, 2, 3, 4])), /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
});

/** A synthetic mouse.shp: every frame 8x6 filled with its own index + 16. */
function syntheticMouse() {
  const count = Math.max(...Object.values(CURSOR_ART).filter((c) => c.file === 'mouse.shp').map((c) => c.start + c.length));
  return buildShpD2(Array.from({ length: count }, (_, k) => frame(8, 6, () => 16 + (k % 200))));
}

test('original cursors: OpenRA frames and hotspots for every cursor of cursors.yaml Red Alert has', () => {
  const files = new Map([['mouse.shp', syntheticMouse()], [ACTOR_PALETTE, buildPal((i) => [i & 63, i >> 6, 0])]]);
  const cursors = originalCursorFrames((n) => files.get(n) ?? null);
  for (const [name, c] of Object.entries(CURSOR_ART)) {
    const got = cursors.get(name);
    assert.ok(got, name);
    assert.equal(got.frames.length, c.length, name);
    assert.equal(got.fps, CURSOR_FPS);
    // Hotspot: the frame centre plus OpenRA's X and Y, kept inside the frame.
    const f = got.frames[0];
    assert.deepEqual(f.hotspot, [Math.min(7, Math.max(0, 4 + c.hotspot[0])), Math.min(5, Math.max(0, 3 + c.hotspot[1]))], name);
    // Frame k of the cursor is file frame start + k (its colour says which).
    got.frames.forEach((g, k) => {
      const v = 16 + ((c.start + k) % 200);
      assert.deepEqual(Array.from(g.rgba.subarray(0, 4)), Array.from(LOOKUP.color.subarray(v * 4, v * 4 + 4)), `${name} frame ${k}`);
    });
  }
  // OpenRA's own cursors (nopower.shp, attackmove.shp) are not in Red Alert.
  assert.equal(CURSOR_ART.powerdown, undefined);
  assert.equal(CURSOR_ART.attackmove, undefined);
  // The scroll-tl typo of cursors.yaml ("y: 5") is ignored, as OpenRA does.
  assert.deepEqual(CURSOR_ART['scroll-tl'].hotspot, [-6, 0]);
  // No mouse.shp, no palette: no original cursors.
  assert.equal(originalCursorFrames(() => null).size, 0);
});

test('cursor kinds switch to the original cursors by OpenRA name, animate and switch back', () => {
  const files = new Map([['mouse.shp', syntheticMouse()], [ACTOR_PALETTE, buildPal()]]);
  const before = { ...CURSORS };
  const command = { ...COMMAND_CURSORS };
  try {
    setCursorArt(originalCursors((n) => files.get(n) ?? null));
    for (const [kind, name] of Object.entries(CURSOR_NAMES)) {
      if (CURSOR_ART[name]) assert.match(CURSORS[kind], /^url\("data:image\/png;base64,/, kind);
      else assert.equal(CURSORS[kind], before[kind], `${kind}: Red Alert has no ${name}`);
    }
    for (const kind of Object.keys(COMMAND_CURSOR_NAMES)) assert.match(COMMAND_CURSORS[kind], /^url\("data:image\/png/, kind);
    // Tables built from CURSORS read the new cursors too.
    assert.equal(ACTION_CURSORS[ACTION.ATTACK], CURSORS.attack);
    assert.deepEqual(MODE_CURSORS.sell, [CURSORS.sell, CURSORS.sellBlocked]);
    assert.equal(POWER_CURSORS.NukePower, CURSORS.nuke);
    // The virtual cursor of mouse capture draws them (first url, hotspot).
    const art = cursorArt(CURSORS.move);
    assert.match(art.src, /^data:image\/png/);
    assert.ok(Number.isFinite(art.x) && Number.isFinite(art.y));
    assert.equal(cursorArt('not-allowed').src, cursorArt(CURSORS.blocked).src);
    // The move cursor has 4 frames: they step at 12.5 per second.
    const first = CURSORS.move;
    assert.equal(tickCursors(0), false);
    assert.equal(tickCursors(1000 / CURSOR_FPS), true);
    assert.notEqual(CURSORS.move, first);
    tickCursors(4 * (1000 / CURSOR_FPS));
    assert.equal(CURSORS.move, first, 'four frames later it is the first again');
  } finally {
    setCursorArt(null);
  }
  assert.deepEqual({ ...CURSORS }, before, 'the built-in cursors are back');
  assert.deepEqual({ ...COMMAND_CURSORS }, command);
  assert.equal(tickCursors(5000), false);
});
