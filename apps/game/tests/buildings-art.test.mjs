// Building art tests: every structure in the rules has a drawing, the atlas builds,
// drawings stay inside their footprint box, use team colour and are deterministic.
// Canvas2D is replaced by a recording stub, so no browser or canvas package is needed.
// Run: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAtlas } from '../js/sprites.js';
import { BUILDING_DRAW, BUILDING_TURRET } from '../js/art/buildings.js';

const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));
// The wasm rules export flattens the building block into width/height.
const actors = rules.actors.map((a) => ({ ...a, width: a.building?.width, height: a.building?.height }));
const buildings = actors.filter((a) => a.kind === 'building');

const SHADOW = 'rgba(0,0,0,0.28)';
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
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
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
      assert.equal(frames[i * 16 + 4], a.width * 24, `${a.id} sprite width`);
      assert.equal(frames[i * 16 + 5], a.height * 24, `${a.id} sprite height`);
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
          const margin = b.style === SHADOW || b.style === 'rgba(0,0,0,1)' ? 8 : 1.5;
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
