// Unit art of the 2D minimal pack (art/vehicles.js, infantry.js, naval.js,
// planes.js, helis.js and the prone soldiers in veterancy.js) and its
// material helpers (art/unitkit.js): pattern geometry, team plating that keeps
// the mask whole, and every drawing finite, inside its box, team coloured and
// deterministic, at the sizes the selection boxes and the engine expect.
// Canvas2D is replaced by a recording stub, so no browser or canvas package is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { U, PANEL_SHADE, bands, clipToRect, diagonals, plate, steel, treads, glass, copper, tarp, stripes, deck, oreLoad, hullPlates } from '../js/art/unitkit.js';
import { VEHICLE_DRAW } from '../js/art/vehicles.js';
import { INFANTRY_DRAW, INFANTRY_PRONE } from '../js/art/infantry.js';
import { PRONE_DRAW } from '../js/art/veterancy.js';
import { NAVAL_DRAW } from '../js/art/naval.js';
import { PLANE_DRAW } from '../js/art/planes.js';
import { HELI_DRAW } from '../js/art/helis.js';
import { actorSprites } from '../js/sprites.js';

const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));

/** The shoelace area of a polygon [x0, y0, x1, y1, ...]. */
function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return Math.abs(a) / 2;
}

/** A recording Canvas2D stub: every number finite, the extent of each fill, save/restore depth. */
function recorder() {
  const log = [];
  const boxes = [];
  let path = [];
  let depth = 0;
  const num = (name, ...v) => {
    for (const x of v) assert.ok(Number.isFinite(x), `${name} got a non-finite number: ${v.join(',')}`);
    log.push(`${name}(${v.map((x) => x.toFixed(3)).join(',')})`);
  };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    save() { depth++; log.push('save'); },
    restore() { depth--; assert.ok(depth >= 0, 'restore without save'); log.push('restore'); },
    translate(...a) { num('translate', ...a); },
    scale(...a) { num('scale', ...a); },
    rotate(...a) { num('rotate', ...a); },
    clip() { log.push('clip'); },
    beginPath() { path = []; log.push('begin'); },
    closePath() { log.push('close'); },
    moveTo(x, y) { num('moveTo', x, y); path.push([x, y, 0]); },
    lineTo(x, y) { num('lineTo', x, y); path.push([x, y, 0]); },
    rect(x, y, w, h) { num('rect', x, y, w, h); path.push([x, y, 0], [x + w, y + h, 0]); },
    roundRect(x, y, w, h, r) { num('roundRect', x, y, w, h, r); path.push([x, y, 0], [x + w, y + h, 0]); },
    arc(x, y, r, a0, a1) { num('arc', x, y, r, a0, a1); assert.ok(r >= 0, 'negative radius'); path.push([x - r, y - r, 0], [x + r, y + r, 0]); },
    ellipse(x, y, rx, ry, rot, a0, a1) { num('ellipse', x, y, rx, ry, rot, a0, a1); path.push([x - rx, y - ry, 0], [x + rx, y + ry, 0]); },
    fillRect(x, y, w, h) {
      num('fillRect', x, y, w, h);
      assert.ok(w >= 0 && h >= 0, `negative fillRect size ${w}x${h}`);
      boxes.push({ x0: x, y0: y, x1: x + w, y1: y + h, style: ctx.fillStyle });
      log.push(`fill:${ctx.fillStyle}`);
    },
    fill() {
      log.push(`fill:${ctx.fillStyle}`);
      if (path.length) boxes.push({ x0: Math.min(...path.map((p) => p[0])), y0: Math.min(...path.map((p) => p[1])), x1: Math.max(...path.map((p) => p[0])), y1: Math.max(...path.map((p) => p[1])), style: ctx.fillStyle });
    },
    stroke() {
      log.push(`stroke:${ctx.strokeStyle}:${ctx.lineWidth}`);
      // The line itself; its round caps may reach half a width further (the atlas clips them).
      if (path.length) boxes.push({ x0: Math.min(...path.map((p) => p[0])), y0: Math.min(...path.map((p) => p[1])), x1: Math.max(...path.map((p) => p[0])), y1: Math.max(...path.map((p) => p[1])), style: ctx.strokeStyle });
    },
    get depth() { return depth; },
  };
  return { ctx, log, boxes };
}

/** The atlas passes (sprites.js COLOR_PASS and MASK_PASS), counting team colour calls. */
function passes(counter) {
  const grey = (s) => {
    counter.team++;
    const v = Math.round(Math.max(0, Math.min(1, s)) * 255);
    return `rgb(${v},${v},${v})`;
  };
  return {
    colour: { team: grey, c: (col) => col },
    mask: { team: () => { counter.team++; return '#fff'; }, c: (col) => (col.startsWith('rgba') ? 'rgba(0,0,0,1)' : '#000') },
  };
}

// ---- Pattern geometry --------------------------------------------------------------------

test('bands: stripes every period, cut to the range', () => {
  assert.deepEqual(bands(0, 10, 4, 1), [[0, 1], [4, 1], [8, 1]]);
  assert.deepEqual(bands(0, 10, 4, 1, 2), [[2, 1], [6, 1]]);
  // A stripe crossing the end is cut; one crossing the start (negative phase) too.
  assert.deepEqual(bands(0, 9, 4, 2, 2), [[2, 2], [6, 2]]);
  assert.deepEqual(bands(0, 7.5, 4, 2, 2), [[2, 2], [6, 1.5]]);
  assert.deepEqual(bands(0, 6, 4, 2, -1), [[0, 1], [3, 2]]);
  // Nothing for an empty range or a bad period or width.
  assert.deepEqual(bands(5, 5, 2, 1), []);
  assert.deepEqual(bands(0, 5, 0, 1), []);
  assert.deepEqual(bands(0, 5, 2, 0), []);
  for (const [s, w] of bands(1.3, 17.9, 2.5, 1, 0.5)) assert.ok(s >= 1.3 && s + w <= 17.9 + 1e-9 && w > 0);
});

test('clipToRect: keeps what lies inside, cuts what crosses, drops what is outside', () => {
  const square = [1, 1, 3, 1, 3, 3, 1, 3];
  assert.deepEqual(clipToRect(square, 0, 0, 10, 10), square);
  assert.deepEqual(clipToRect(square, 5, 5, 10, 10), []);
  const cut = clipToRect([-2, -2, 2, -2, 2, 2, -2, 2], 0, 0, 10, 10);
  assert.equal(area(cut), 4);
  for (let i = 0; i < cut.length; i += 2) assert.ok(cut[i] >= 0 && cut[i + 1] >= 0);
  // A triangle sticking out of two sides becomes a pentagon of the right area.
  const tri = clipToRect([0, 0, 8, 0, 0, 8], 0, 0, 6, 6);
  assert.equal(tri.length / 2, 5);
  assert.equal(area(tri), 32 - 2 * 2);
});

test('diagonals: stripes inside the rectangle cover their share of it', () => {
  for (const [w, h, width, gap] of [[12, 8, 2, 2], [4.5, 3, 1, 1], [20, 2.5, 1.5, 1.5], [6, 6, 0.8, 1.6]]) {
    const polys = diagonals(1, 2, w, h, width, gap);
    assert.ok(polys.length > 0);
    let total = 0;
    for (const p of polys) {
      for (let i = 0; i < p.length; i += 2) assert.ok(p[i] >= 1 - 1e-9 && p[i] <= 1 + w + 1e-9 && p[i + 1] >= 2 - 1e-9 && p[i + 1] <= 2 + h + 1e-9);
      total += area(p);
    }
    // 45 degree stripes: the share is width / (width + gap), up to the cut ends.
    const share = total / (w * h);
    assert.ok(Math.abs(share - width / (width + gap)) < 0.2, `${w}x${h}: share ${share.toFixed(3)}`);
  }
  assert.deepEqual(diagonals(0, 0, 0, 5, 1, 1), []);
});

// ---- Materials ---------------------------------------------------------------------------

test('team plating draws only in team greys, its panel lines darker, so the mask stays whole', () => {
  const { ctx, boxes } = recorder();
  const styles = [];
  plate(ctx, { team: (s) => { styles.push(s); return `t${s.toFixed(3)}`; }, c: () => assert.fail('a plate uses team colour only') }, 2, 3, 12, 20, 0.6, 2);
  assert.equal(styles[0], 0.6);
  assert.ok(styles.length > 3, 'panel lines across the plate');
  for (const s of styles.slice(1)) assert.equal(s, 0.6 * PANEL_SHADE);
  // Panel lines stay clear of the rounded corners.
  for (const b of boxes.slice(1)) assert.ok(b.y0 >= 3 + 2 && b.y1 <= 3 + 20 - 2 && b.x0 >= 2 && b.x1 <= 14);
});

test('each material stays inside its rectangle and uses its board colours', () => {
  const cases = [
    [steel, [U.steel, U.steelSeam]],
    [treads, [U.track, U.trackLight]],
    [glass, [U.glassDark, U.glass, U.glassLight]],
    [copper, [U.copper, U.copperDark, U.copperLight]],
    [tarp, [U.canvas, U.canvasDark]],
    [stripes, [U.yellow, U.track]],
    [deck, [U.deck, U.deckSeam]],
    [hullPlates, [U.hull, U.hullDark]],
    [oreLoad, [U.ore, U.oreLight]],
  ];
  const P = { team: () => assert.fail('materials are not team coloured'), c: (c) => c };
  for (const [fn, colours] of cases) {
    for (const [x, y, w, h] of [[1, 2, 10, 14], [0.5, 0.5, 3, 2.5], [4, 1, 18, 4]]) {
      const { ctx, boxes } = recorder();
      fn(ctx, P, x, y, w, h);
      for (const b of boxes) {
        assert.ok(b.x0 >= x - 1e-9 && b.y0 >= y - 1e-9 && b.x1 <= x + w + 1e-9 && b.y1 <= y + h + 1e-9, `${fn.name} leaves ${x},${y} ${w}x${h}: ${JSON.stringify(b)}`);
        assert.ok(colours.includes(b.style), `${fn.name} uses ${b.style}`);
      }
      assert.equal(boxes[0].style, colours[0], `${fn.name} starts with its base colour`);
    }
  }
});

// ---- The unit art ------------------------------------------------------------------------

// [body, turret or null, prone or null]: the sizes the renderer, the selection boxes and
// the hit areas are tuned to. Redrawing the art must keep them.
const SIZES = {
  '1TNK': [[22, 22], [22, 22]],
  '2TNK': [[24, 24], [24, 24]],
  '3TNK': [[26, 26], [26, 26]],
  '4TNK': [[30, 30], [30, 30]],
  HARV: [[24, 28]],
  JEEP: [[18, 22], [18, 22]],
  APC: [[22, 24]],
  V2RL: [[22, 28]],
  ARTY: [[22, 26]],
  MNLY: [[22, 24]],
  MRJ: [[20, 26]],
  MGG: [[20, 26]],
  TTNK: [[24, 24], [24, 24]],
  DTRK: [[20, 24]],
  CTNK: [[24, 26]],
  STNK: [[24, 26], [24, 26]],
  TRUK: [[20, 26]],
  QTNK: [[26, 26]],
  MCV: [[30, 34]],
  E1: [[10, 12], null, [8, 14]],
  E2: [[10, 12], null, [8, 14]],
  E3: [[10, 12], null, [8, 14]],
  E4: [[10, 12], null, [8, 14]],
  E6: [[10, 12], null, [8, 14]],
  E7: [[10, 12], null, [8, 14]],
  ANT: [[16, 22]],
  FIREANT: [[16, 22]],
  SCOUTANT: [[16, 22]],
  DOG: [[8, 14]],
  MEDI: [[10, 12], null, [8, 14]],
  MECH: [[10, 12], null, [8, 14]],
  SPY: [[10, 12], null, [8, 14]],
  THF: [[10, 12]],
  SHOK: [[10, 12], null, [8, 14]],
  PT: [[14, 30], [10, 10]],
  DD: [[18, 40], [12, 12]],
  CA: [[24, 54], [14, 14]],
  SS: [[12, 34]],
  MSUB: [[16, 42]],
  LST: [[24, 38]],
  YAK: [[26, 24]],
  MIG: [[28, 30]],
  U2: [[42, 28]],
  BADR: [[42, 40]],
  TRAN: [[20, 40], [24, 24]],
  HIND: [[28, 34], [34, 34]],
  HELI: [[26, 34], [32, 32]],
};
// WebRA's pixel art in Red Alert's style (art/pixel.js, tests/pixel-art.test.mjs) is not drawn here.
const PIXEL = new Set(['FTRK', 'MH60']);
const DRAW = { ...VEHICLE_DRAW, ...INFANTRY_DRAW, ...NAVAL_DRAW, ...PLANE_DRAW, ...HELI_DRAW };
const PRONE = { ...PRONE_DRAW, ...INFANTRY_PRONE };

test('every unit drawn here keeps its sprite sizes, turret and prone slots', () => {
  const ids = Object.keys(DRAW).filter((id) => !PIXEL.has(id));
  assert.deepEqual(ids.sort(), Object.keys(SIZES).sort());
  for (const id of ids) {
    const [body, turret = null, prone = null] = SIZES[id];
    const d = DRAW[id];
    assert.deepEqual(d.body.slice(0, 2), body, `${id} body`);
    assert.deepEqual(d.turret ? d.turret.slice(0, 2) : null, turret, `${id} turret`);
    assert.deepEqual(PRONE[id] ? PRONE[id].slice(0, 2) : null, prone, `${id} prone`);
  }
});

test('the sprite list resolves every rules unit drawn here to this art', () => {
  const units = rules.actors.filter((a) => ['vehicle', 'infantry', 'ship', 'aircraft'].includes(a.kind) && DRAW[a.id] && !PIXEL.has(a.id));
  assert.ok(units.length >= 40, `expected the unit roster, got ${units.length}`);
  for (const a of units) {
    const s = actorSprites(a);
    assert.equal(s.body, DRAW[a.id].body, `${a.id} body`);
    if (DRAW[a.id].turret) assert.equal(s.second, DRAW[a.id].turret, `${a.id} turret`);
    else if (a.kind === 'infantry') assert.equal(s.second, PRONE[a.id] ?? DRAW[a.id].body, `${a.id} prone`);
  }
});

// Rotor blades are not team coloured (nor are OpenRA's rotor sequences).
const NEUTRAL = new Set(['TRAN turret', 'HIND turret', 'HELI turret']);

/** Every drawing of the modules: [name, [w, h, draw]]. */
function drawings() {
  const out = [];
  for (const [id, d] of Object.entries(DRAW)) {
    if (PIXEL.has(id)) continue;
    out.push([`${id} body`, d.body]);
    if (d.turret) out.push([`${id} turret`, d.turret]);
  }
  for (const [id, p] of Object.entries(PRONE)) out.push([`${id} prone`, p]);
  return out;
}

for (const [name, [w, h, draw]] of drawings()) {
  test(`unit art ${name}: finite, inside its box, team coloured, deterministic`, () => {
    const runs = {};
    for (let run = 0; run < 2; run++) {
      for (const pass of ['colour', 'mask']) {
        const counter = { team: 0 };
        const { ctx, log, boxes } = recorder();
        draw(ctx, passes(counter)[pass]);
        assert.equal(ctx.depth, 0, `${name} leaves save/restore unbalanced`);
        for (const b of boxes) {
          // Drop shadows may reach a little past the box (the atlas clips them); paint may not.
          const margin = b.style === 'rgba(0,0,0,0.28)' || b.style === 'rgba(0,0,0,1)' ? 1.6 : 0.01;
          assert.ok(b.x0 >= -margin && b.y0 >= -margin && b.x1 <= w + margin && b.y1 <= h + margin, `${name} draws outside its ${w}x${h} box: ${JSON.stringify(b)}`);
        }
        if (!NEUTRAL.has(name)) assert.ok(counter.team > 0, `${name} has no team colour`);
        if (run === 0) runs[pass] = log.join('|');
        else assert.equal(log.join('|'), runs[pass], `${name} ${pass} pass is not deterministic`);
      }
    }
  });
}

test('the board materials show on the units that carry them', () => {
  // The Units board's swatches: the second material layer of each unit is in its art.
  const uses = (draw, colour) => {
    const { ctx, boxes } = recorder();
    draw(ctx, passes({ team: 0 }).colour);
    return boxes.some((b) => b.style === colour);
  };
  const want = {
    TTNK: U.copper, // tm cu tr
    SHOK: U.copper, // he tm cu
    CTNK: U.glass, // tm gl tr
    HARV: U.oreLight, // tm or tr
    TRUK: U.canvas, // tm cv st
    DTRK: U.canvas, // tm hz cv
    V2RL: U.yellow, // tm st hz
    MNLY: U.yellow, // tm hz tr
    MCV: U.yellow, // tm hz tr
    E4: U.yellow, // he tm hz
    E6: U.yellow, // hz tm sk
    MECH: U.yellow, // hz tm st
    E1: U.skin, // he tm sk
    PT: U.deck, // tm hl dk
    DD: U.deck,
    CA: U.deck,
    SS: U.deck, // hl tm dk
    LST: U.yellow, // tm hz hl
    MIG: U.hull, // tm hl gl
    U2: U.hull, // hl tm gl
    YAK: U.glass, // tm st gl
    HIND: U.glass,
    HELI: U.glass,
    TRAN: U.glass,
    SCOUTANT: 'rgba(95,147,173,0.75)', // an gl an
    FIREANT: U.yellow, // an hz an
  };
  for (const [id, colour] of Object.entries(want)) {
    const d = DRAW[id];
    assert.ok(uses(d.body[2], colour) || (d.turret && uses(d.turret[2], colour)), `${id} shows ${colour}`);
  }
  // Every infantry helmet is the board's olive, every hull its hull greys.
  for (const id of ['E1', 'E2', 'E3', 'MEDI', 'SHOK']) assert.ok(uses(DRAW[id].body[2], U.helmet), `${id} helmet`);
  for (const id of ['PT', 'DD', 'CA', 'LST']) assert.ok(uses(DRAW[id].body[2], U.hullDark), `${id} hull`);
});
