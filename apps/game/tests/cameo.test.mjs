// Cameo adapter (js/cameo.js): which art paints the sidebar's build buttons.
// A fake 2D context records the calls, so no canvas is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameoPainter, createCameoPainter, paintBackdrop } from '../js/cameo.js';

function fakeCanvas(width, height) {
  const calls = [];
  const ctx = new Proxy(
    { globalCompositeOperation: 'source-over' },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args) => {
          calls.push([prop, ...args]);
          if (prop === 'createLinearGradient') return { addColorStop: (...a) => calls.push(['addColorStop', ...a]) };
          return undefined;
        };
      },
      set(target, prop, value) {
        target[prop] = value;
        calls.push([`set ${String(prop)}`, value]);
        return true;
      },
    },
  );
  return { width, height, calls, getContext: (kind) => (kind === '2d' ? ctx : null) };
}

const actor = { id: 'powr', name: 'Power Plant', kind: 'building', width: 2, height: 2 };

test('without js/art cameos the sprite art is drawn, over the cameo backdrop', () => {
  const seen = [];
  const painter = createCameoPainter({
    art: null,
    fallback: (canvas, a, rgb) => seen.push(['sprite', a.id, rgb]),
    backdrop: (ctx, w, h) => seen.push(['backdrop', ctx.globalCompositeOperation, w, h]),
  });
  assert.equal(painter.source, 'sprite');
  painter.paint(fakeCanvas(128, 128), actor, [0.2, 0.4, 0.9]);
  assert.deepEqual(seen, [
    ['sprite', 'powr', [0.2, 0.4, 0.9]],
    // Painted after the sprite but underneath it.
    ['backdrop', 'destination-over', 128, 128],
  ]);
});

test('with js/art drawCameo(ctx, typeName, size) the art is used, centred and square', () => {
  const seen = [];
  const painter = createCameoPainter({
    art: (ctx, typeName, size) => seen.push(['art', typeof ctx.save, typeName, size]),
    fallback: () => seen.push(['sprite']),
  });
  assert.equal(painter.source, 'art');
  const canvas = fakeCanvas(192, 128);
  painter.paint(canvas, actor, [1, 0, 0]);
  assert.deepEqual(seen, [['art', 'function', 'powr', 128]]);
  // Square picture centred in the wider canvas, and the context restored.
  assert.ok(canvas.calls.some(([op, x, y]) => op === 'translate' && x === 32 && y === 0));
  const ops = canvas.calls.map((c) => c[0]);
  assert.ok(ops.indexOf('save') < ops.indexOf('translate') && ops.lastIndexOf('restore') > ops.indexOf('translate'));
});

test('the shared painter falls back to sprites until js/art has cameos', () => {
  assert.equal(cameoPainter.source, 'sprite');
});

test('the backdrop fills the whole cameo', () => {
  const canvas = fakeCanvas(64, 64);
  paintBackdrop(canvas.getContext('2d'), 64, 64);
  assert.ok(canvas.calls.some(([op, x, y, w, h]) => op === 'fillRect' && x === 0 && y === 0 && w === 64 && h === 64));
});
