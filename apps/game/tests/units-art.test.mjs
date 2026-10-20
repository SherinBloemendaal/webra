// Unit art of the 2D minimal pack (art/vehicles.js, infantry.js, naval.js,
// planes.js, helis.js and the prone soldiers in veterancy.js) and its block kit
// (art/unitkit.js): two to four flat shapes per unit in the shared 2D/3D colours,
// one team area, the ground shadow left to the renderer, every drawing finite, inside its
// box and deterministic, filling its box, and as big as the original sprite
// (the original sprites' decoration bounds, else bounds, render-facts.js ORIGINAL_BOUNDS).
// Canvas2D is replaced by a recording stub, so no browser or canvas package is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { M, TEAM, GROUND, SHADOW_OFFSET, SHADOW_ALPHA, box, disc, shape, blade, geomBounds, sprite } from '../js/art/unitkit.js';
import { SHARED_PALETTE } from '../js/art/shared-palette.js';
import { ORIGINAL_BOUNDS } from '../js/content/render-facts.js';
import { VEHICLE_DRAW } from '../js/art/vehicles.js';
import { INFANTRY_DRAW, INFANTRY_PRONE } from '../js/art/infantry.js';
import { PRONE_DRAW } from '../js/art/veterancy.js';
import { NAVAL_DRAW } from '../js/art/naval.js';
import { PLANE_DRAW } from '../js/art/planes.js';
import { HELI_DRAW } from '../js/art/helis.js';
import { actorSprites, spriteList, shadowSlots } from '../js/sprites.js';

const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));
const actorOf = Object.fromEntries(rules.actors.map((a) => [a.id, a]));

/** A recording Canvas2D stub: every number finite, the extent and style of each fill, save/restore depth. */
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
    moveTo(x, y) { num('moveTo', x, y); path.push([x, y]); },
    lineTo(x, y) { num('lineTo', x, y); path.push([x, y]); },
    rect(x, y, w, h) { num('rect', x, y, w, h); path.push([x, y], [x + w, y + h]); },
    roundRect(x, y, w, h, r) { num('roundRect', x, y, w, h, r); path.push([x, y], [x + w, y + h]); },
    arc(x, y, r, a0, a1) { num('arc', x, y, r, a0, a1); assert.ok(r >= 0, 'negative radius'); path.push([x - r, y - r], [x + r, y + r]); },
    ellipse(x, y, rx, ry, rot, a0, a1) { num('ellipse', x, y, rx, ry, rot, a0, a1); path.push([x - rx, y - ry], [x + rx, y + ry]); },
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
    stroke() { assert.fail('the minimal unit art fills shapes, it strokes no lines'); },
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

/** The painted boxes of a [w, h, draw] sprite (colour pass), moved by (dx, dy). */
function painted([, , draw], dx = 0, dy = 0) {
  const { ctx, boxes } = recorder();
  draw(ctx, passes({ team: 0 }).colour);
  return boxes.map((b) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy }));
}

/** The extent [x0, y0, x1, y1] of a list of painted boxes. */
function extent(boxes) {
  return [Math.min(...boxes.map((b) => b.x0)), Math.min(...boxes.map((b) => b.y0)), Math.max(...boxes.map((b) => b.x1)), Math.max(...boxes.map((b) => b.y1))];
}

// ---- The kit -----------------------------------------------------------------------------

test('the kit: geometry bounds, parts drawn in order, the ground shadow flag', () => {
  assert.deepEqual(geomBounds(box(1, 2, 3, 4)), [1, 2, 4, 6]);
  assert.deepEqual(geomBounds(disc(5, 5, 2)), [3, 3, 7, 7]);
  assert.deepEqual(geomBounds(shape(0, 4, 2, 0, 4, 4)), [0, 0, 4, 4]);
  const b = geomBounds(blade(10, 10, Math.PI / 2, 8, 2)); // pointing east
  assert.ok(Math.abs(b[0] - 10) < 1e-9 && Math.abs(b[2] - 18) < 1e-9 && Math.abs(b[1] - 9) < 1e-9 && Math.abs(b[3] - 11) < 1e-9);
  const s = sprite(10, 10, [[M.dark, box(0, 0, 4, 4)], [TEAM, disc(6, 6, 2)]], GROUND);
  assert.deepEqual(painted(s).map((x) => x.style), [M.dark, 'rgb(217,217,217)'], 'no shadow baked into the sprite');
  assert.equal(s[2].groundShadow, true);
  assert.equal(sprite(10, 10, [[M.dark, box(0, 0, 4, 4)]])[2].groundShadow, false);
});

test("the renderer's ground shadow is the shared palette's (engine/src/render.rs)", () => {
  assert.equal(SHADOW_OFFSET, SHARED_PALETTE.shadow.offset * 24);
  assert.equal(SHADOW_ALPHA, SHARED_PALETTE.shadow.alpha);
  const src = readFileSync(fileURLToPath(new URL('../../../engine/src/render.rs', import.meta.url)), 'utf8');
  const offset = src.match(/pub const UNIT_SHADOW_OFFSET: f32 = ([\d.]+) \* 24\.0;/);
  const alpha = src.match(/pub const UNIT_SHADOW_ALPHA: f32 = ([\d.]+);/);
  assert.ok(offset && alpha, 'render.rs defines the unit shadow');
  assert.equal(Number(offset[1]), SHARED_PALETTE.shadow.offset);
  assert.equal(Number(alpha[1]), SHARED_PALETTE.shadow.alpha);
});

// ---- The unit art ------------------------------------------------------------------------

// [body, turret or null, prone or null]: the sprite sizes, as big as the original sprites (see the
// size test below). 0.21.0 grew the ones that were too small: 4TNK, HARV, TTNK, QTNK, MCV, the
// infantry (and their prone poses in proportion), the dog, the ants, PT and MIG, and shortened CA.
const SIZES = {
  '1TNK': [[22, 22], [22, 22]],
  '2TNK': [[24, 24], [24, 24]],
  '3TNK': [[26, 26], [26, 26]],
  '4TNK': [[36, 40], [36, 40]],
  HARV: [[32, 38]],
  JEEP: [[18, 22], [18, 22]],
  APC: [[22, 24]],
  V2RL: [[22, 28]],
  ARTY: [[22, 26]],
  MNLY: [[22, 24]],
  MRJ: [[20, 26]],
  MGG: [[20, 26]],
  TTNK: [[26, 26], [26, 26]],
  DTRK: [[20, 24]],
  CTNK: [[24, 26]],
  STNK: [[24, 26], [24, 26]],
  TRUK: [[20, 26]],
  QTNK: [[34, 38]],
  MCV: [[32, 38]],
  E1: [[12, 16], null, [10, 18]],
  E2: [[12, 16], null, [10, 18]],
  E3: [[12, 16], null, [10, 18]],
  E4: [[12, 16], null, [10, 18]],
  E6: [[12, 16], null, [10, 18]],
  E7: [[12, 16], null, [10, 18]],
  ANT: [[22, 28]],
  FIREANT: [[22, 28]],
  SCOUTANT: [[22, 28]],
  DOG: [[10, 16]],
  MEDI: [[12, 16], null, [10, 18]],
  MECH: [[12, 16], null, [10, 18]],
  SPY: [[12, 16], null, [10, 18]],
  THF: [[12, 16]],
  SHOK: [[12, 16], null, [10, 18]],
  PT: [[16, 34], [10, 10]],
  DD: [[18, 40], [12, 12]],
  CA: [[24, 50], [14, 14]],
  SS: [[12, 34]],
  MSUB: [[16, 42]],
  LST: [[24, 38]],
  YAK: [[26, 24]],
  MIG: [[34, 36]],
  U2: [[42, 28]],
  BADR: [[42, 40]],
  TRAN: [[20, 40], [24, 24]],
  HIND: [[28, 34], [34, 34]],
  HELI: [[26, 34], [32, 32]],
};
// WebRA's pixel art (art/pixel.js, tests/pixel-art.test.mjs) is not drawn here.
const PIXEL = new Set(['FTRK', 'MH60']);
const DRAW = { ...VEHICLE_DRAW, ...INFANTRY_DRAW, ...NAVAL_DRAW, ...PLANE_DRAW, ...HELI_DRAW };
const PRONE = { ...PRONE_DRAW, ...INFANTRY_PRONE };
const IDS = Object.keys(DRAW).filter((id) => !PIXEL.has(id));
const kindOf = (id) => actorOf[id]?.kind ?? 'infantry'; // the ants are mission actors (infantry)
const HELIS = new Set(Object.keys(HELI_DRAW));

test('every unit drawn here keeps its sprite sizes, turret and prone slots', () => {
  assert.deepEqual([...IDS].sort(), Object.keys(SIZES).sort());
  for (const id of IDS) {
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

/** Every drawing of the modules: [name, [w, h, draw]]. */
function drawings() {
  const out = [];
  for (const id of IDS) {
    out.push([`${id} body`, DRAW[id].body]);
    if (DRAW[id].turret) out.push([`${id} turret`, DRAW[id].turret]);
  }
  for (const [id, p] of Object.entries(PRONE)) out.push([`${id} prone`, p]);
  return out;
}

const MATERIALS = new Set(Object.values(SHARED_PALETTE.materials));

for (const [name, [w, h, draw]] of drawings()) {
  test(`unit art ${name}: finite, inside its box, shared colours, deterministic`, () => {
    const runs = {};
    for (let run = 0; run < 2; run++) {
      for (const pass of ['colour', 'mask']) {
        const { ctx, log, boxes } = recorder();
        draw(ctx, passes({ team: 0 })[pass]);
        assert.equal(ctx.depth, 0, `${name} leaves save/restore unbalanced`);
        for (const b of boxes) assert.ok(b.x0 >= -0.01 && b.y0 >= -0.01 && b.x1 <= w + 0.01 && b.y1 <= h + 0.01, `${name} draws outside its ${w}x${h} box: ${JSON.stringify(b)}`);
        if (pass === 'colour') {
          for (const b of boxes) assert.ok(MATERIALS.has(b.style) || b.style.startsWith('rgb('), `${name} paints ${b.style}, not a shared colour`);
        }
        if (run === 0) runs[pass] = log.join('|');
        else assert.equal(log.join('|'), runs[pass], `${name} ${pass} pass is not deterministic`);
      }
    }
  });
}

/** The parts of a unit: body and turret together (a helicopter's rotor counts). */
const partsOf = (id) => [...DRAW[id].body[2].parts, ...(DRAW[id].turret ? DRAW[id].turret[2].parts : [])];

test('two to four flat shapes per unit and per prone pose, one of them the team area', () => {
  const check = (name, parts) => {
    assert.ok(parts.length >= 2 && parts.length <= 4, `${name} has ${parts.length} shapes`);
    for (const [fill, ...geoms] of parts) assert.ok(geoms.length >= 1 && geoms.length <= 8, `${name}: a ${fill} shape of ${geoms.length} pieces`);
    assert.equal(parts.filter(([fill]) => fill === TEAM).length, 1, `${name} has one team area`);
    // One fill per shape: two shapes of one colour would be one shape.
    assert.equal(new Set(parts.map(([fill]) => fill)).size, parts.length, `${name} repeats a colour`);
  };
  for (const id of IDS) check(id, partsOf(id));
  for (const [id, p] of Object.entries(PRONE)) check(`${id} prone`, p[2].parts);
  // Rotor blades are not team coloured (nor are the original rotor sequences).
  for (const id of HELIS) if (!PIXEL.has(id)) assert.ok(DRAW[id].turret[2].parts.every(([f]) => f !== TEAM), `${id} rotor`);
});

test('ground units cast the renderer\'s shadow, aircraft and rotors do not, and no sprite bakes one in', () => {
  for (const id of IDS) {
    const air = kindOf(id) === 'aircraft';
    for (const s of [DRAW[id].body, DRAW[id].turret, PRONE[id]].filter(Boolean)) {
      assert.equal(s[2].groundShadow, !air, `${id}: ${air ? 'the engine draws aircraft shadows' : 'a ground unit casts the ground shadow'}`);
      // A shadow baked into the sprite would turn with the unit: none is painted.
      assert.ok(painted(s).every((b) => !b.style.startsWith('rgba')), `${id} paints no shadow of its own`);
    }
  }
});

test('the atlas lists the slots of every ground unit for the renderer\'s shadow (Game.set_shadow_slots)', () => {
  const actors = rules.actors;
  const list = spriteList(actors);
  const index = (id) => actors.findIndex((a) => a.id === id);
  const slots = new Set(shadowSlots(list, actors.length));
  for (const id of ['1TNK', 'HARV', 'E1', 'CA', 'SS']) assert.ok(slots.has(2 * index(id)), `${id} body`);
  for (const id of ['1TNK', 'CA']) assert.ok(slots.has(2 * index(id) + 1), `${id} turret`);
  assert.ok(slots.has(2 * index('E1') + 1), 'the prone rifleman');
  for (const id of ['YAK', 'HIND', 'FTRK', 'POWR']) {
    assert.ok(!slots.has(2 * index(id)) && !slots.has(2 * index(id) + 1), `${id}: aircraft, pixel art and buildings have their own shadow`);
  }
  // Slots taken by installed art or a texture pack are left to that art.
  const taken = new Map([[2 * index('1TNK'), {}], [2 * index('1TNK') + 1, {}]]);
  const left = new Set(shadowSlots(list, actors.length, taken));
  assert.ok(!left.has(2 * index('1TNK')) && !left.has(2 * index('1TNK') + 1) && left.has(2 * index('2TNK')));
  for (const k of slots) assert.ok(k < actors.length * 2, 'only actor slots');
  // Wrecks keep their vehicle's shadow (art/leftovers.js huskOf).
  for (const id of ['2TNK.Husk', 'HARV.FullHusk']) assert.ok(index(id) >= 0 && slots.has(2 * index(id)), `${id} body`);
});

/** The union of a unit's body and its turret centred on it, as the engine draws a turret at [0, 0]. */
function unitBoxes(id) {
  const d = DRAW[id];
  const [w, h] = d.body;
  const out = painted(d.body);
  if (d.turret && kindOf(id) === 'vehicle') out.push(...painted(d.turret, (w - d.turret[0]) / 2, (h - d.turret[1]) / 2));
  return out;
}

test('every unit fills its whole sprite box, as the original sprites fill theirs (no margin)', () => {
  const tol = 0.5;
  const check = (name, [w, h], boxes) => {
    const [x0, y0, x1, y1] = extent(boxes);
    assert.ok(x0 <= tol && y0 <= tol && x1 >= w - tol && y1 >= h - tol, `${name} fills ${x0.toFixed(2)},${y0.toFixed(2)} to ${x1.toFixed(2)},${y1.toFixed(2)} of ${w}x${h}`);
  };
  for (const id of IDS) check(id, DRAW[id].body, unitBoxes(id));
  for (const [id, p] of Object.entries(PRONE)) check(`${id} prone`, p, painted(p));
});

// How big the original sprite looks: its decoration bounds, else its bounds (1/1024 cell, 24 px a cell).
const ORIGINAL_TOLERANCE = 0.15;

test('every unit is as big as its original sprite (DecorationBounds, else Bounds), within 15 %', () => {
  const rows = [];
  let measured = 0;
  for (const id of IDS) {
    const b = ORIGINAL_BOUNDS[id];
    if (!b) continue; // U2 and BADR have no bounds in the original rules
    const [ow, oh] = (b.decoration ?? b.bounds).map((v) => (v * 24) / 1024);
    const [x0, y0, x1, y1] = extent(unitBoxes(id));
    // A top-down sprite turns with the unit, so its longer side meets the original's longer side.
    const drawn = Math.max(x1 - x0, y1 - y0);
    const original = Math.max(ow, oh);
    const ratio = drawn / original;
    rows.push(`${id} ${drawn.toFixed(1)}/${original.toFixed(1)}=${ratio.toFixed(2)}`);
    assert.ok(Math.abs(ratio - 1) <= ORIGINAL_TOLERANCE, `${id} is ${drawn.toFixed(1)} px long, the original ${original.toFixed(1)} px (${ratio.toFixed(2)})`);
    measured++;
  }
  assert.ok(measured >= 40, `measured ${measured} units: ${rows.join(', ')}`);
  for (const id of ['U2', 'BADR']) assert.equal(ORIGINAL_BOUNDS[id], undefined, `${id} now has original bounds: measure it`);
});

test('ship turrets and the Chinook rotors sit on the hull at their original offsets', () => {
  const px = (v) => (v * 24) / 1024;
  const onHull = (id, fwd, side) => {
    const [w, h] = DRAW[id].body;
    const [x0, y0, x1, y1] = geomBounds(DRAW[id].body[2].parts[0][1]);
    const [x, y] = [w / 2 + px(side), h / 2 - px(fwd)];
    assert.ok(x >= x0 && x <= x1 && y >= y0 && y <= y1, `${id} pivot ${x},${y} off the hull ${x0},${y0}-${x1},${y1}`);
  };
  for (const id of ['PT', 'DD', 'CA']) for (const [fwd, side] of actorOf[id].turret_offsets) onHull(id, fwd, side);
  for (const fwd of actorOf.TRAN.unit.aircraft.rotors) onHull('TRAN', fwd, 0);
});

test('each unit keeps the feature that names it', () => {
  const uses = (id, colour) => partsOf(id).some(([fill]) => fill === colour) || (PRONE[id] && PRONE[id][2].parts.some(([fill]) => fill === colour));
  const want = {
    '1TNK': M.dark, // gun
    '3TNK': M.dark,
    '4TNK': M.dark,
    HARV: M.gold, // ore
    V2RL: M.paint, // the rocket
    ARTY: M.dark, // the howitzer
    MRJ: M.dome, // the dish
    MGG: M.blue, // the gap emitter
    TTNK: M.blue, // the tesla coil
    DTRK: M.yellow, // the bomb
    CTNK: M.glass, // the chrono core
    TRUK: M.canvas, // the tarp
    QTNK: M.yellow, // the seismic hammer
    MCV: M.yellow, // the crane
    E1: M.olive, // helmet
    E4: M.yellow, // fuel tanks
    E6: M.yellow, // hard hat
    MEDI: M.red, // red cross
    SHOK: M.blue, // coil pack
    FIREANT: M.yellow,
    SCOUTANT: M.glass,
    LST: M.yellow, // bow ramp
    DD: M.paint, // missiles
    YAK: M.dark, // propeller
    BADR: M.dark, // engines
  };
  for (const [id, colour] of Object.entries(want)) assert.ok(uses(id, colour), `${id} shows ${colour}`);
  // Two guns on the heavy tanks.
  for (const id of ['3TNK', '4TNK']) assert.equal(DRAW[id].turret[2].parts[1].length - 1, 2, `${id} twin guns`);
  // The board's harvester: a scoop narrower than the body leads, the ore in front of the glass cab.
  const [w] = VEHICLE_DRAW.HARV.body;
  const parts = VEHICLE_DRAW.HARV.body[2].parts;
  const scoop = parts.flatMap(([, ...g]) => g).map(geomBounds).find((b) => b[1] === 0);
  assert.ok(scoop && scoop[2] - scoop[0] < w * 0.7, 'a narrow scoop leads');
  const [ore] = parts.find(([f]) => f === M.gold).slice(1).map(geomBounds);
  const [cab] = parts.find(([f]) => f === M.glass).slice(1).map(geomBounds);
  assert.ok(ore[3] <= cab[1], 'the cab sits behind the ore');
});
