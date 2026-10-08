// Pseudo-3D volume helpers: one projection, one light, finite numbers, balanced state.
// Canvas2D is replaced by a tiny recording stub.
// Run: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KX, KY, T, K, at, col, tone, castShadows, box, cylinder, dome, prism, gable, vault, patch, clipRoof } from '../js/art/volume.js';

function stubContext() {
  const calls = [];
  let depth = 0;
  const grad = () => ({ addColorStop: (p, c) => { assert.ok(p >= 0 && p <= 1); assert.equal(typeof c, 'string'); } });
  const finite = (name, vals) => vals.forEach((v) => assert.ok(typeof v !== 'number' || Number.isFinite(v), `${name}: non-finite ${vals}`));
  const rec = (name) => (...a) => { finite(name, a); calls.push(name); };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    createLinearGradient: (...a) => { finite('linear', a); return grad(); },
    createRadialGradient: (...a) => { finite('radial', a); return grad(); },
    save() { depth++; },
    restore() { depth--; assert.ok(depth >= 0); },
    get depth() { return depth; },
    calls,
  };
  for (const n of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'arc', 'ellipse', 'fill', 'stroke', 'clip', 'translate', 'scale', 'rotate']) ctx[n] = rec(n);
  return ctx;
}

const P = { team: (s) => `rgb(${Math.round(s * 255)},0,0)`, c: (c) => c };

test('projection lifts points up and to the right by one fixed vector per unit of height', () => {
  assert.deepEqual(at(10, 20), [10, 20]);
  const [x, y] = at(10, 20, 10);
  assert.ok(Math.abs(x - (10 + KX * 10)) < 1e-9);
  assert.ok(Math.abs(y - (20 - KY * 10)) < 1e-9);
  assert.ok(KX > 0 && KY > 0, 'tops move up and right so the south and east walls show');
});

test('colour specs shade fixed colours and keep team levels clamped', () => {
  assert.equal(tone('#808080', 0), '#808080');
  assert.ok(tone('#808080', 0.5) > '#808080');
  assert.ok(tone('#808080', -0.5) < '#808080');
  assert.equal(col(P, T(0.5)), 'rgb(128,0,0)');
  assert.equal(col(P, T(0.9), 1), 'rgb(255,0,0)');
  assert.equal(col(P, T(0.1), -1), 'rgb(0,0,0)');
  assert.equal(col(P, K('#112233')), '#112233');
});

test('box returns face mappings that agree with the projection', () => {
  const ctx = stubContext();
  const V = box(ctx, P, 10, 20, 30, 16, 12, K('#808080'));
  assert.deepEqual(V.front(0, 0), at(10, 36, 0));
  assert.deepEqual(V.front(30, 12), at(40, 36, 12));
  assert.deepEqual(V.roof(0, 0), at(10, 20, 12));
  assert.deepEqual(V.roof(30, 16), at(40, 36, 12));
  assert.deepEqual(V.side(0, 0), at(40, 36, 0));
  assert.deepEqual(V.side(16, 12), at(40, 20, 12));
  assert.equal(ctx.depth, 0);
  // a box resting on a roof shifts by the roof height
  const W = box(ctx, P, 12, 22, 4, 4, 3, K('#808080'), K('#808080'), { z0: 12 });
  assert.deepEqual(W.front(0, 0), at(12, 26, 12));
  assert.deepEqual(W.roof(0, 0), at(12, 22, 15));
});

test('cast shadows are one fill that stretches down and to the right', () => {
  const ctx = stubContext();
  castShadows(ctx, P, [{ x: 0, y: 0, w: 10, d: 10, z: 10 }, { cx: 30, cy: 30, r: 4, z: 6, z0: 3 }]);
  assert.equal(ctx.calls.filter((c) => c === 'fill').length, 1);
  assert.equal(ctx.calls.filter((c) => c === 'closePath').length, 2);
});

test('cylinders, domes, prisms and roofs draw finite shapes and balance the state', () => {
  const ctx = stubContext();
  const bands = [[2, 4, T(0.6)]];
  cylinder(ctx, P, 20, 30, 6, 12, K('#909090'), K('#a0a0a0'), { bands, z0: 4 });
  dome(ctx, P, 20, 30, 8, T(0.7));
  dome(ctx, P, 20, 30, 8, T(0.7), { full: true, z0: 2 });
  for (const n of [3, 6, 8]) prism(ctx, P, 12, 14, 9, n, 4, K('#909090'));
  const V = box(ctx, P, 4, 10, 40, 20, 8, K('#909090'));
  gable(ctx, P, V, 6, K('#a06040'), { axis: 'x', seams: 5, overhang: 1 });
  gable(ctx, P, V, 6, K('#a06040'), { axis: 'y', seams: 5 });
  vault(ctx, P, V, 5, T(0.6), { bands: 6 });
  patch(ctx, '#fff', V, 'front', 1, 1, 5, 5);
  ctx.save();
  clipRoof(ctx, V);
  ctx.restore();
  assert.equal(ctx.depth, 0);
  assert.ok(ctx.calls.length > 100);
});

test('a prism shows only the walls that face the camera', () => {
  const count = (n) => {
    const ctx = stubContext();
    prism(ctx, P, 12, 14, 9, n, 4, K('#909090'));
    return ctx.calls.filter((c) => c === 'fill').length - 2; // minus lid and inner lid
  };
  assert.ok(count(8) >= 3 && count(8) <= 5, `octagon shows ${count(8)} walls`);
  assert.ok(count(6) >= 2 && count(6) <= 4, `hexagon shows ${count(6)} walls`);
});
