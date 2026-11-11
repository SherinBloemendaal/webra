// js/renderer.js: a lost WebGPU device is noted (`lost`) and reported once
// (onLost) so js/main.js can tell the player; a device the page destroyed
// itself is not a loss. Fake GPU objects, no browser.
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
