// Cameo adapter (js/cameo.js): which picture paints the sidebar's build buttons.
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

test('types with cameo art get the cached picture, sized to the canvas, with the team colour', () => {
  const asked = [];
  const picture = { tag: 'cameo canvas' };
  const painter = createCameoPainter({
    art: (typeName, size, opts) => {
      asked.push([typeName, size, opts]);
      return picture;
    },
    fallback: () => assert.fail('no sprite fallback when there is art'),
  });
  const canvas = fakeCanvas(128, 128);
  assert.equal(painter.paint(canvas, actor, [0.2, 0.4, 0.9]), 'art');
  assert.deepEqual(asked, [['powr', 128, { team: [0.2, 0.4, 0.9], kind: 'building', height: 128 }]]);
  assert.deepEqual(
    canvas.calls.filter(([op]) => op === 'drawImage'),
    [['drawImage', picture, 0, 0, 128, 128]],
  );
});

test('a type without cameo art falls back to the sprite icon over the backdrop', () => {
  const seen = [];
  const painter = createCameoPainter({
    art: () => null,
    fallback: (canvas, a, rgb) => seen.push(['sprite', a.id, rgb]),
    backdrop: (ctx, w, h) => seen.push(['backdrop', ctx.globalCompositeOperation, w, h]),
  });
  assert.equal(painter.paint(fakeCanvas(96, 96), actor, [1, 0, 0]), 'sprite');
  assert.deepEqual(seen, [
    ['sprite', 'powr', [1, 0, 0]],
    // Painted after the sprite but underneath it.
    ['backdrop', 'destination-over', 96, 96],
  ]);
});

test('the shared painter uses the sprites.js cameo cache', () => {
  assert.equal(typeof cameoPainter.paint, 'function');
});

test('the backdrop fills the whole cameo', () => {
  const canvas = fakeCanvas(64, 64);
  paintBackdrop(canvas.getContext('2d'), 64, 64);
  assert.ok(canvas.calls.some(([op, x, y, w, h]) => op === 'fillRect' && x === 0 && y === 0 && w === 64 && h === 64));
});
