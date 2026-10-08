// Render clock and frame selection for sprite animations (js/anim.js), the
// formula shaders/sprite.wgsl uses per instance.
// Run: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnimClock, ANIM_WRAP, animFrame } from '../js/anim.js';

test('frame selection: steps at the frame rate and wraps around', () => {
  const frames = [0, 0.1, 0.24, 0.25, 0.5, 0.99, 1, 1.25, 2.1].map((t) => animFrame(t, true, 4, 4));
  assert.deepEqual(frames, [0, 0, 0, 1, 2, 3, 0, 1, 0]);
  // Single frame or no frames: always the still frame.
  assert.equal(animFrame(7.3, true, 8, 1), 0);
  assert.equal(animFrame(7.3, true, 8, 0), 0);
  // Every frame of an 8 frame loop shows once per second at 8 fps.
  const seen = new Set();
  for (let k = 0; k < 8; k++) seen.add(animFrame(k / 8 + 0.01, true, 8, 8));
  assert.equal(seen.size, 8);
});

test('frame selection: the per-instance phase shifts the loop, never out of range', () => {
  assert.equal(animFrame(0, true, 6, 8, 0), 0);
  assert.equal(animFrame(0, true, 6, 8, 0.5), 4);
  assert.equal(animFrame(0, true, 6, 8, 0.999), 7);
  for (let i = 0; i < 200; i++) {
    const f = animFrame(i * 0.37, true, 6, 6, (i * 0.618) % 1);
    assert.ok(Number.isInteger(f) && f >= 0 && f < 6, `frame ${f}`);
  }
  // Negative clocks (never produced, but the GPU clamps) stay in range.
  assert.equal(animFrame(-3, true, 6, 6, 0), 0);
});

test('reduced motion: the still frame whatever the clock and phase', () => {
  for (const t of [0, 0.5, 13.7, 1000]) {
    for (const phase of [0, 0.3, 0.9]) assert.equal(animFrame(t, false, 8, 8, phase), 0);
  }
  const clock = new AnimClock({ reducedMotion: true });
  assert.equal(clock.enabled, false);
  clock.advance(1000, false);
  assert.equal(clock.time, 0, 'the clock does not run');
  assert.deepEqual(clock.uniform(), { time: 0, enabled: false });
});

test('the clock follows wall time while the game runs and stops while paused', () => {
  const clock = new AnimClock();
  assert.deepEqual(clock.uniform(), { time: 0, enabled: true });
  clock.advance(250, false);
  clock.advance(250, false);
  assert.equal(clock.time, 0.5);
  const frame = animFrame(clock.time, true, 4, 4);
  clock.advance(5000, true);
  assert.equal(clock.time, 0.5, 'paused: no time passes');
  assert.equal(animFrame(clock.uniform().time, true, 4, 4), frame, 'paused: the same frame stays');
  clock.advance(Number.NaN, false);
  clock.advance(-20, false);
  assert.equal(clock.time, 0.5, 'bad or negative steps are ignored');
  clock.advance(500, false);
  assert.deepEqual(clock.uniform(), { time: 1, enabled: true });
  // The clock wraps so the GPU's f32 keeps its precision.
  clock.time = ANIM_WRAP - 0.25;
  clock.advance(500, false);
  assert.ok(Math.abs(clock.time - 0.25) < 1e-9);
});

test('prefers-reduced-motion is followed, also when it changes mid game', () => {
  const listeners = new Set();
  const query = {
    matches: true,
    addEventListener: (type, fn) => type === 'change' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const queried = [];
  const win = {
    matchMedia: (q) => {
      queried.push(q);
      return query;
    },
  };
  const clock = new AnimClock();
  const stop = clock.watchReducedMotion(win);
  assert.deepEqual(queried, ['(prefers-reduced-motion: reduce)']);
  assert.equal(clock.enabled, false);
  clock.advance(1000, false);
  assert.equal(clock.time, 0);
  for (const fn of listeners) fn({ matches: false });
  assert.equal(clock.enabled, true);
  clock.advance(1000, false);
  assert.equal(clock.time, 1);
  for (const fn of listeners) fn({ matches: true });
  assert.deepEqual(clock.uniform(), { time: 0, enabled: false }, 'back to the still frame');
  stop();
  assert.equal(listeners.size, 0);
  // No matchMedia (Node, old browsers): animations stay on, nothing throws.
  const plain = new AnimClock();
  assert.doesNotThrow(() => plain.watchReducedMotion({})());
  assert.doesNotThrow(() => plain.watchReducedMotion(undefined)());
  assert.equal(plain.enabled, true);
});

test('the shader picks frames with the same formula and reads the clock from the globals', () => {
  const dir = new URL('../shaders/', import.meta.url);
  const sprite = readFileSync(fileURLToPath(new URL('sprite.wgsl', dir)), 'utf8');
  const common = readFileSync(fileURLToPath(new URL('common.wgsl', dir)), 'utf8');
  assert.match(sprite, /fn anim_frame\(time: f32, enabled: f32, fps: f32, count: u32, phase: f32\) -> u32/);
  assert.match(sprite, /floor\(max\(time, 0\.0\) \* fps \+ phase \* f32\(count\)\)/);
  assert.match(sprite, /u32\(step\) % count/);
  assert.match(sprite, /anim_frame\(g\.anim\.x, g\.anim\.y,/);
  assert.match(common, /anim: vec4f,/);
});
