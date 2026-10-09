// Building art tests: every structure in the rules has a drawing, the atlas builds,
// drawings stay inside their footprint box, use team colour and are deterministic.
// Canvas2D is replaced by a recording stub, so no browser or canvas package is needed.
// Run: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAtlas, animationPlan, spriteList, drawCameo, getCameo, clearCameoCache, FRAME_FLOATS } from '../js/sprites.js';
import { BUILDING_DRAW, BUILDING_TURRET, BUILDING_SIZE } from '../js/art/buildings.js';
import { BUILDING_ANIM } from '../js/art/animated.js';

const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));
// The wasm rules export flattens the building block into width/height.
const actors = rules.actors.map((a) => ({ ...a, width: a.building?.width, height: a.building?.height }));
const buildings = actors.filter((a) => a.kind === 'building');

const isShadow = (style) => typeof style === 'string' && style.startsWith('rgba(0,0,0,');
const WALLS = new Set(['SBAG', 'FENC', 'BRIK']); // neutral, no team colour
const ALIAS = { FPWR: 'POWR', TENF: 'TENT', SYRF: 'SYRD', SPEF: 'SPEN', WEAF: 'WEAP', DOMF: 'DOME', FIXF: 'FIX', FAPW: 'APWR', ATEF: 'ATEK', PDOF: 'PDOX', MSLF: 'MSLO', FACF: 'FACT', 'AFLD.UKRAINE': 'AFLD' };
const keyOf = (id) => ALIAS[id.toUpperCase()] ?? id.toUpperCase();

/** A recording Canvas2D stub that validates every number it is given. */
function fakeContext(log, bounds) {
  let depth = 0; // save() nesting
  let transforms = 0; // active translate/scale/rotate
  let clips = 0; // active clip regions (shapes inside are cut to the box)
  const stack = [];
  let path = [];
  const num = (name, ...vals) => {
    for (const v of vals) assert.ok(Number.isFinite(v), `${name} got a non-finite number: ${vals.join(',')}`);
    log.push(`${name}(${vals.map((v) => v.toFixed(3)).join(',')})`);
  };
  const addBox = (x0, y0, x1, y1) => {
    if (transforms === 0 && clips === 0 && bounds) bounds.push({ x0, y0, x1, y1, style: ctx.fillStyle });
  };
  const gradient = (kind, args) => {
    for (const v of args) assert.ok(Number.isFinite(v), `${kind} gradient got a non-finite number: ${args.join(',')}`);
    const stops = [];
    return {
      addColorStop(p, c) {
        assert.ok(p >= 0 && p <= 1, `gradient stop outside 0..1: ${p}`);
        assert.equal(typeof c, 'string', 'gradient stop colour must be a string');
        stops.push(`${p.toFixed(3)}=${c}`);
      },
      toString: () => `${kind}(${args.map((v) => v.toFixed(3)).join(',')};${stops.join(';')})`,
    };
  };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    createLinearGradient(...a) { return gradient('linear', a); },
    createRadialGradient(...a) { return gradient('radial', a); },
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    save() {
      depth++;
      stack.push([transforms, clips]);
      log.push('save');
    },
    restore() {
      depth--;
      assert.ok(depth >= 0, 'restore without save');
      [transforms, clips] = stack.pop();
      log.push('restore');
    },
    translate(...a) { num('translate', ...a); transforms++; },
    scale(...a) { num('scale', ...a); transforms++; },
    rotate(...a) { num('rotate', ...a); transforms++; },
    beginPath() { path = []; log.push('begin'); },
    closePath() { log.push('close'); },
    moveTo(x, y) { num('moveTo', x, y); path.push([x, y]); },
    lineTo(x, y) { num('lineTo', x, y); path.push([x, y]); },
    rect(x, y, w, h) { num('rect', x, y, w, h); path.push([x, y], [x + w, y + h]); },
    roundRect(x, y, w, h, r) { num('roundRect', x, y, w, h, r); path.push([x, y], [x + w, y + h]); },
    arc(x, y, r, a0, a1) { num('arc', x, y, r, a0, a1); assert.ok(r >= 0, 'negative radius'); path.push([x - r, y - r], [x + r, y + r]); },
    ellipse(x, y, rx, ry, rot, a0, a1) { num('ellipse', x, y, rx, ry, rot, a0, a1); assert.ok(rx >= 0 && ry >= 0, 'negative radius'); path.push([x - rx, y - ry], [x + rx, y + ry]); },
    fillRect(x, y, w, h) {
      num('fillRect', x, y, w, h);
      assert.ok(w >= 0 && h >= 0, `negative fillRect size ${w}x${h}`);
      addBox(x, y, x + w, y + h);
      log.push(`fill:${ctx.fillStyle}`);
    },
    fill() {
      log.push(`fill:${ctx.fillStyle}`);
      if (path.length) addBox(Math.min(...path.map((p) => p[0])), Math.min(...path.map((p) => p[1])), Math.max(...path.map((p) => p[0])), Math.max(...path.map((p) => p[1])));
    },
    stroke() { log.push(`stroke:${ctx.strokeStyle}:${ctx.lineWidth}`); },
    clip() { clips++; log.push('clip'); },
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    get depth() { return depth; },
  };
  return ctx;
}

/** Colour passes as the atlas uses them, counting team calls. */
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

test('every building type in the rules has art, including fakes and variants', () => {
  assert.ok(buildings.length >= 40, `expected the full building roster, got ${buildings.length}`);
  for (const a of buildings) {
    assert.equal(typeof BUILDING_DRAW[keyOf(a.id)], 'function', `no art for building ${a.id}`);
    assert.ok(a.width >= 1 && a.height >= 1, `${a.id} has no footprint size`);
  }
});

test('the footprint table matches the rules for every building art key', () => {
  for (const a of buildings) {
    const key = keyOf(a.id);
    assert.deepEqual(BUILDING_SIZE[key], [a.width, a.height], `${a.id} footprint in BUILDING_SIZE`);
  }
  for (const key of Object.keys(BUILDING_DRAW)) assert.ok(BUILDING_SIZE[key], `${key} has art but no footprint`);
});

test('building turrets are declared for the defences that rotate', () => {
  for (const key of ['GUN', 'AGUN', 'SAM']) {
    const [w, h, draw] = BUILDING_TURRET[key];
    assert.equal(w, 24);
    assert.equal(h, 24);
    assert.equal(typeof draw, 'function');
  }
});

test('the atlas builds with every building and keeps footprint sizes', () => {
  globalThis.document = {
    createElement: () => {
      const canvas = { width: 0, height: 0 };
      const ctx = fakeContext([], null);
      canvas.getContext = () => ctx;
      return canvas;
    },
  };
  try {
    const { frames } = buildAtlas(actors);
    actors.forEach((a, i) => {
      if (a.kind !== 'building') return;
      assert.equal(frames[i * 2 * FRAME_FLOATS + 4], a.width * 24, `${a.id} sprite width`);
      assert.equal(frames[i * 2 * FRAME_FLOATS + 5], a.height * 24, `${a.id} sprite height`);
    });
  } finally {
    delete globalThis.document;
  }
});

for (const a of buildings) {
  test(`building art ${a.id}: finite, inside its box, team coloured, deterministic`, () => {
    const key = keyOf(a.id);
    const w = a.width * 24;
    const h = a.height * 24;
    const runs = [];
    for (let run = 0; run < 2; run++) {
      for (const pass of ['colour', 'mask']) {
        const log = [];
        const bounds = [];
        const counter = { team: 0 };
        const ctx = fakeContext(log, bounds);
        BUILDING_DRAW[key](ctx, passes(counter)[pass]);
        assert.equal(ctx.depth, 0, `${a.id} leaves save/restore unbalanced`);
        for (const b of bounds) {
          const margin = isShadow(b.style) ? 8 : 1.5;
          assert.ok(
            b.x0 >= -margin && b.y0 >= -margin && b.x1 <= w + margin && b.y1 <= h + margin,
            `${a.id} draws outside its ${w}x${h} box: ${JSON.stringify(b)}`,
          );
        }
        if (!WALLS.has(key)) assert.ok(counter.team > 0, `${a.id} has no team colour area`);
        if (run === 0) runs.push(log.join('|'));
        else assert.equal(log.join('|'), runs[pass === 'colour' ? 0 : 1], `${a.id} ${pass} pass is not deterministic`);
      }
    }
  });
}

// ---- Animated layers (art/animated.js) --------------------------------------------------

/** A canvas stub document for buildAtlas; records the atlas size. */
function stubDocument(sizes = []) {
  return {
    createElement: () => {
      const canvas = { width: 0, height: 0 };
      const ctx = fakeContext([], null);
      canvas.getContext = () => {
        sizes.push([canvas.width, canvas.height]);
        return ctx;
      };
      return canvas;
    },
  };
}

test('animated layers: radar, smoke, beacons, fans and the crane hook, a handful of frames each', () => {
  for (const key of ['DOME', 'POWR', 'APWR', 'PROC', 'BARR', 'HPAD', 'AFLD', 'ATEK', 'STEK', 'FACT']) {
    const anim = BUILDING_ANIM[key];
    assert.ok(anim, `${key} has an animated layer`);
    assert.ok(BUILDING_DRAW[key], `${key} is a building`);
    assert.ok(!BUILDING_TURRET[key], `${key} has no turret in the same sprite slot`);
    assert.ok(Number.isInteger(anim.frames) && anim.frames >= 2 && anim.frames <= 8, `${key} frame count ${anim.frames}`);
    assert.ok(anim.fps > 0 && anim.fps <= 12, `${key} rate ${anim.fps}`);
    const [x, y, w, h] = anim.box;
    const [fw, fh] = BUILDING_SIZE[key];
    assert.ok(w > 0 && h > 0 && x >= 0 && x + w <= fw * 24 && y + h <= fh * 24, `${key} layer box inside the footprint (smoke may rise above it)`);
  }
});

for (const [key, anim] of Object.entries(BUILDING_ANIM)) {
  test(`animated layer ${key}: every frame finite, inside its box, deterministic, frames differ`, () => {
    const [bx, by, bw, bh] = anim.box;
    const logs = [];
    for (let f = 0; f < anim.frames; f++) {
      const runs = [];
      for (let run = 0; run < 2; run++) {
        const log = [];
        const bounds = [];
        const ctx = fakeContext(log, bounds);
        anim.draw(ctx, passes({ team: 0 }).colour, f);
        assert.equal(ctx.depth, 0, `${key} frame ${f} leaves save/restore unbalanced`);
        for (const b of bounds) {
          assert.ok(
            b.x0 >= bx - 1.5 && b.y0 >= by - 1.5 && b.x1 <= bx + bw + 1.5 && b.y1 <= by + bh + 1.5,
            `${key} frame ${f} draws outside its box ${anim.box}: ${JSON.stringify(b)}`,
          );
        }
        runs.push(log.join('|'));
      }
      assert.equal(runs[0], runs[1], `${key} frame ${f} is not deterministic`);
      logs.push(runs[0]);
    }
    assert.ok(logs[0].length > 0, `${key} frame 0 draws nothing`);
    assert.ok(new Set(logs).size > 1, `${key} frames are all the same`);
  });
}

test('the atlas holds every animation once: head slots point at their frames, fogged buildings get the still frame', () => {
  const sizes = [];
  globalThis.document = stubDocument(sizes);
  try {
    const listLength = spriteList(actors).length;
    const { frames, overlays } = buildAtlas(actors);
    const plan = animationPlan(actors, listLength);
    const entry = (i) => Array.from(frames.slice(i * FRAME_FLOATS, (i + 1) * FRAME_FLOATS));
    const keys = new Set(plan.map((p) => p.key));
    const total = [...keys].reduce((n, k) => n + BUILDING_ANIM[k].frames, 0);
    assert.equal(frames.length, (listLength + total) * FRAME_FLOATS, 'one copy of each animation after the sprite list');
    assert.ok(plan.length > keys.size, 'fakes share the frames of their originals');
    for (const p of plan) {
      const a = actors[p.actor];
      const head = entry(p.head);
      assert.deepEqual(head.slice(8, 11), [p.start, p.frames, p.fps], `${a.id} head frame`);
      assert.equal(overlays[p.actor], p.start, `${a.id} still frame for the engine`);
      const [bx, by, bw, bh] = BUILDING_ANIM[p.key].box;
      const offset = [bx + bw / 2 - (a.width * 24) / 2, by + bh / 2 - (a.height * 24) / 2];
      for (let f = 0; f < p.frames; f++) {
        const e = entry(p.start + f);
        assert.deepEqual(e.slice(4, 8), [bw, bh, ...offset], `${a.id} frame ${f} size and offset`);
        assert.deepEqual(e.slice(8, 11), [0, 0, 0], `${a.id} frame ${f} is a still frame`);
      }
      assert.deepEqual(head.slice(4, 8), [bw, bh, ...offset]);
    }
    // Same frames for aliases (FPWR draws like POWR).
    const start = (id) => overlays[actors.findIndex((a) => a.id.toUpperCase() === id)];
    assert.ok(start('POWR') > 0);
    assert.equal(start('FPWR'), start('POWR'));
    // Everything else: no overlay, no animation.
    actors.forEach((a, i) => {
      if (!plan.some((p) => p.actor === i)) assert.equal(overlays[i], 0, a.id);
    });
    for (let i = 0; i < listLength; i++) {
      if (!plan.some((p) => p.head === i)) assert.equal(frames[i * FRAME_FLOATS + 9], 0, `sprite ${i} is not animated`);
    }
    // WebGPU's default texture limit.
    for (const [w, h] of sizes) assert.ok(w <= 8192 && h <= 8192, `atlas ${w}x${h} fits a texture`);
  } finally {
    delete globalThis.document;
  }
});

test('the frame table matches the Frame struct of the sprite shader', () => {
  const wgsl = readFileSync(fileURLToPath(new URL('../shaders/sprite.wgsl', import.meta.url)), 'utf8');
  const struct = wgsl.match(/struct Frame \{([^}]*)\}/)[1];
  const vec4s = struct.match(/: vec4f/g).length;
  assert.equal(vec4s * 4, FRAME_FLOATS);
});

// ---- Cameos ---------------------------------------------------------------------------

// Mines, crates and husks are never built: no cameo.
const cameoActors = actors.filter((a) => !['mine', 'crate', 'husk'].includes(a.kind));

/** One recorded cameo: [drawn, log]. */
function recordCameo(id, kind, size = 64, opts = {}) {
  const log = [];
  const ctx = fakeContext(log, null);
  const drawn = drawCameo(ctx, id, size, { kind, ...opts });
  assert.equal(ctx.depth, 0, `${id} cameo leaves save/restore unbalanced`);
  return [drawn, log.join('|')];
}

test('every building and unit in the rules has a cameo, unknown types do not', () => {
  assert.ok(cameoActors.length >= 70, `expected the full roster, got ${cameoActors.length}`);
  for (const a of cameoActors) {
    const [drawn, log] = recordCameo(a.id, a.kind);
    assert.ok(drawn, `no cameo for ${a.id}`);
    assert.ok(log.length > 200, `${a.id} cameo drew almost nothing`);
  }
  assert.equal(recordCameo('NOSUCH', undefined)[0], false);
});

test('cameos are deterministic and follow the requested size and team colour', () => {
  for (const a of cameoActors) {
    assert.equal(recordCameo(a.id, a.kind)[1], recordCameo(a.id, a.kind)[1], `${a.id} cameo is not deterministic`);
  }
  assert.notEqual(recordCameo('POWR', 'building', 64)[1], recordCameo('POWR', 'building', 96)[1]);
  assert.notEqual(recordCameo('2TNK', 'vehicle', 64, { team: [1, 0, 0] })[1], recordCameo('2TNK', 'vehicle', 64, { team: [0, 1, 0] })[1]);
  assert.notEqual(recordCameo('2TNK', 'vehicle', 64)[1], recordCameo('2TNK', 'vehicle', 64, { height: 48 })[1]);
});

test('cameo aliases reuse the base art and the cache hands out one canvas per key', () => {
  assert.equal(recordCameo('FPWR', 'building')[1], recordCameo('POWR', 'building')[1]);
  globalThis.document = {
    createElement: () => {
      const canvas = { width: 0, height: 0 };
      const ctx = fakeContext([], null);
      canvas.getContext = () => ctx;
      return canvas;
    },
  };
  try {
    clearCameoCache();
    const a = getCameo('POWR', 48);
    assert.ok(a);
    assert.equal(a.width, 48);
    assert.equal(a.height, 48);
    assert.equal(getCameo('powr', 48), a, 'case-insensitive and cached');
    assert.notEqual(getCameo('POWR', 48, { team: [1, 0, 0] }), a);
    assert.equal(getCameo('NOSUCH', 48), null);
    assert.equal(getCameo('POWR', 48, { height: 36 }).height, 36);
  } finally {
    delete globalThis.document;
  }
});
