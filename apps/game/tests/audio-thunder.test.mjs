// Thunder after a lightning flash: the synthesized cues (js/audio/synth.js
// thunder_close, thunder, thunder_distant), the cue, gain and pan by where the
// strike is (js/audio/director.js thunderCue) and the call through the audio
// system (js/audio/index.js thunder). No engine needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECIPES, render } from '../js/audio/synth.js';
import { THUNDER_MIN_GAIN, spatial, thunderCue } from '../js/audio/director.js';
import { AudioSystem } from '../js/audio/index.js';
import { createRegistry } from '../js/registry.js';

const CUES = { thunder_close: 1, thunder: 0.75, thunder_distant: 0.5 };
const SR = 22050;

/** Peak, loudest second (RMS) and a brightness measure (RMS of the slope against RMS: higher means more highs). */
function measure(s, sr = SR) {
  let peak = 0;
  let energy = 0;
  let slope = 0;
  let acc = 0;
  let loudest = 0;
  for (let i = 0; i < s.length; i++) {
    peak = Math.max(peak, Math.abs(s[i]));
    energy += s[i] * s[i];
    if (i) slope += (s[i] - s[i - 1]) ** 2;
    acc += s[i] * s[i];
    if (i >= sr) acc -= s[i - sr] * s[i - sr];
    loudest = Math.max(loudest, acc);
  }
  return { peak, loud: Math.sqrt(loudest / Math.min(sr, s.length)), bright: Math.sqrt(slope / energy) };
}

const mean = (id, key) => [0, 1, 2].reduce((sum, v) => sum + measure(render(id, SR, v))[key], 0) / 3;

test('the thunder cues are finite, last 4 to 5 s, peak where they should and render the same each time', () => {
  for (const [id, peak] of Object.entries(CUES)) {
    assert.ok(RECIPES[id], `${id} is synthesized`);
    for (const sr of [SR, 48000]) {
      const s = render(id, sr, 0);
      assert.ok(s.length >= sr * 4 && s.length < sr * 5, `${id} lasts ${s.length / sr} s`);
      assert.ok(s.every(Number.isFinite), `${id} is finite at ${sr} Hz`);
      assert.ok(Math.abs(measure(s, sr).peak - peak) < 1e-6, `${id} peaks at ${peak}`);
      assert.deepEqual(render(id, sr, 0), s, `${id} renders the same each time`);
      assert.equal(s[s.length - 1], 0, `${id} fades out`);
    }
    assert.notDeepEqual(render(id, SR, 0), render(id, SR, 1), `${id} variants differ`);
  }
});

test('close thunder cracks: louder and brighter than the distant rumble, which swells in', () => {
  assert.ok(mean('thunder_close', 'loud') > mean('thunder', 'loud'), 'close louder than medium');
  assert.ok(mean('thunder', 'loud') > mean('thunder_distant', 'loud'), 'medium louder than distant');
  assert.ok(mean('thunder_close', 'bright') > 2 * mean('thunder', 'bright'), 'the crack is bright');
  assert.ok(mean('thunder', 'bright') > mean('thunder_distant', 'bright'), 'distant is the darkest');
  for (const v of [0, 1, 2]) {
    const close = render('thunder_close', SR, v);
    const distant = render('thunder_distant', SR, v);
    const head = (s) => measure(s.subarray(0, SR * 0.05)).peak;
    assert.ok(head(close) > 0.5, 'the crack comes at once');
    assert.ok(head(distant) < 0.05, 'distant thunder has no crack and swells in slowly');
    // The rumble rolls on: still clearly there 2.5 s after the strike.
    assert.ok(measure(close.subarray(SR * 2.5, SR * 3.5)).loud > 0.03, 'close rumble rolls on');
    assert.ok(measure(distant.subarray(SR * 2.5, SR * 3.5)).loud > 0.02, 'distant rumble rolls on');
  }
});

test('thunder is about as loud as the big explosions', () => {
  const close = mean('thunder_close', 'loud');
  assert.ok(close > 0.8 * mean('explosion_large', 'loud'), 'not lost under the battle');
  assert.ok(close < mean('explosion_huge', 'loud'), 'never louder than a nuke');
  assert.ok(mean('thunder_distant', 'loud') > 0.5 * mean('explosion_large', 'loud'), 'distant rumble still heard');
});

const VIEW = { x0: 0, y0: 0, x1: 1000, y1: 600 };

test('the cue, gain and pan follow where the strike is, as for the other sounds of the world', () => {
  // On screen: the close cue, placed like any positional sound.
  assert.deepEqual(thunderCue(500, 300, VIEW), { synth: 'thunder_close', gain: 1, pan: 0 });
  const left = thunderCue(50, 300, VIEW);
  assert.equal(left.synth, 'thunder_close');
  assert.equal(left.pan, spatial(50, 300, VIEW).pan, 'the same pan as spatial()');
  assert.ok(left.pan < -0.6);
  // Off screen (two half-views right): the medium cue, panned right.
  const right = thunderCue(1500, 300, VIEW);
  assert.equal(right.synth, 'thunder');
  assert.equal(right.pan, 0.75);
  // Far away (vertical distance counts too): the distant rumble, faded but never silent.
  const far = thunderCue(500, 300 + 300 * 10, VIEW);
  assert.equal(far.synth, 'thunder_distant');
  assert.equal(far.gain, THUNDER_MIN_GAIN);
  assert.equal(far.pan, 0);
  const between = thunderCue(500, 300 + 300 * 4, VIEW);
  assert.equal(between.synth, 'thunder_distant');
  assert.ok(between.gain > THUNDER_MIN_GAIN && between.gain < 1, `fades with distance (${between.gain})`);
  // Just off the edge: a strike on a lightning rod, unit or structure (4th flash element) still cracks.
  assert.equal(thunderCue(1100, 300, VIEW, 0).synth, 'thunder');
  assert.equal(thunderCue(1100, 300, VIEW, 1).synth, 'thunder_close');
  assert.equal(thunderCue(1100, 300, VIEW, 2).synth, 'thunder_close');
  assert.equal(thunderCue(1100, 300, VIEW, 3).synth, 'thunder_close');
  assert.equal(thunderCue(1500, 300, VIEW, 2).synth, 'thunder', 'further off it rumbles like any strike');
  // No view yet, or no position: the medium cue in the middle.
  assert.deepEqual(thunderCue(500, 300, null), { synth: 'thunder', gain: 1, pan: 0 });
  assert.deepEqual(thunderCue(undefined, undefined, VIEW), { synth: 'thunder', gain: 1, pan: 0 });
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('the audio system plays the thunder where it struck, on the effects bus, and not when muted', async () => {
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  await audio.loaded;
  const played = [];
  audio.bank.resolveAll = (sound) => [{ buffer: sound.synth, rate: 1 }];
  audio.mixer.play = (buffer, opts) => played.push({ buffer, ...opts });
  // Before the first frame there is no view: the medium cue, centred.
  audio.thunder({ x: 10, y: 10, kind: 0 });
  assert.deepEqual(played.pop(), { buffer: 'thunder', bus: 'effects', gain: 0.9, pan: 0, rate: 1 });
  // The view of the last frame places it (frame() keeps it even without a game attached).
  audio.frame(VIEW, null, []);
  audio.thunder({ x: 50, y: 300, kind: 0 });
  const close = played.pop();
  assert.equal(close.buffer, 'thunder_close');
  assert.equal(close.bus, 'effects');
  assert.ok(close.pan < -0.6, 'left of the view, left speaker');
  assert.equal(close.gain, 0.9);
  audio.thunder({ x: 500, y: 6000 });
  const far = played.pop();
  assert.equal(far.buffer, 'thunder_distant', 'a 3 element flash (no kind) works too');
  assert.ok(Math.abs(far.gain - THUNDER_MIN_GAIN * 0.9) < 1e-9);
  // A texture pack's `thunder` stands in for all three, unless it replaces the one asked for.
  const pack = new Set(['thunder']);
  audio.bank.packBuffer = (name) => (pack.has(name) ? name : null);
  audio.thunder({ x: 500, y: 300 });
  assert.equal(played.pop().buffer, 'thunder');
  pack.add('thunder_close');
  audio.thunder({ x: 500, y: 300 });
  assert.equal(played.pop().buffer, 'thunder_close');
  // Muted: nothing.
  audio.toggleMute();
  audio.thunder({ x: 500, y: 300 });
  assert.equal(played.length, 0);
});
