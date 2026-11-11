// js/renderer.js and the GPU device: a lost device is noted (`lost`) and
// reported once (onLost) so js/main.js can tell the player, a device the page
// destroyed itself is not a loss; the canvas stays within the device limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.navigator ??= {};
globalThis.navigator.gpu ??= { getPreferredCanvasFormat: () => 'bgra8unorm' };
globalThis.window ??= { devicePixelRatio: 1 };

const { Renderer } = await import('../js/renderer.js');

/** A renderer over a fake device whose `lost` promise resolves with `info`. */
function withLostDevice(info) {
  const canvas = { getContext: () => ({ configure() {} }) };
  const device = { limits: { maxTextureDimension2D: 8192 }, features: new Set(), lost: Promise.resolve(info) };
  return new Renderer(canvas, device);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a device lost by itself: lost says why and onLost is called once', async () => {
  const r = withLostDevice({ reason: 'unknown', message: 'GPU process crashed' });
  const calls = [];
  r.onLost = (info) => calls.push(info.reason);
  const errors = [];
  const error = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await settle();
  } finally {
    console.error = error;
  }
  assert.deepEqual(calls, ['unknown']);
  assert.equal(r.lost, 'GPU process crashed');
  assert.equal(errors.length, 1, 'still logged');
});

test('a lost device without a message names the reason', async () => {
  const r = withLostDevice({ reason: 'unknown', message: '' });
  const error = console.error;
  console.error = () => {};
  try {
    await settle();
  } finally {
    console.error = error;
  }
  assert.equal(r.lost, 'reason: unknown');
});

test('a destroyed device is no loss: no onLost, lost stays null', async () => {
  const r = withLostDevice({ reason: 'destroyed', message: 'Device was destroyed.' });
  let calls = 0;
  r.onLost = () => calls++;
  const error = console.error;
  console.error = () => {};
  try {
    await settle();
  } finally {
    console.error = error;
  }
  assert.equal(calls, 0);
  assert.equal(r.lost, null);
});

test('canvasSize: a side never exceeds the device limit, the aspect ratio stays, the ratio used drops with it', async () => {
  const { canvasSize } = await import('../js/renderer.js');
  // Several monitors at ratio 2: 10000 device px wanted, 8192 allowed.
  const wide = canvasSize(5000, 1200, 2, 8192);
  assert.ok(wide.width <= 8192 && wide.height <= 8192);
  assert.equal(wide.width, 8192);
  assert.ok(Math.abs(wide.width / wide.height - 5000 / 1200) < 0.01, 'same shape');
  assert.ok(Math.abs(wide.ratio - 8192 / 5000) < 1e-9);
  // A tall portrait screen is limited the same way.
  const tall = canvasSize(1000, 3000, 3, 8192);
  assert.equal(tall.height, 8192);
  assert.ok(tall.width <= 8192);
  // Within the limit nothing changes.
  assert.deepEqual(canvasSize(1280, 720, 2, 8192), { width: 2560, height: 1440, ratio: 2 });
  // A hidden canvas (0 x 0) is still one pixel.
  assert.deepEqual(canvasSize(0, 0, 2, 8192), { width: 1, height: 1, ratio: 2 });
});
