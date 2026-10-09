// Our own sounds, synthesized: every effect, radio blip and announcer chime is
// computed here from noise, oscillators, filters and envelopes, so the game
// ships no audio files. Recipes are plain functions producing mono float
// samples (testable without Web Audio); the mixer renders each one once per
// variant into an AudioBuffer and reuses it.

/** Seeded PRNG (mulberry32) so a recipe variant always sounds the same. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

/** One-pole low-pass state. */
function lowpass(sr, fc) {
  const coef = (hz) => 1 - Math.exp((-TAU * hz) / sr);
  let a = coef(fc);
  let y = 0;
  const f = (x) => (y += a * (x - y));
  f.set = (hz) => {
    a = coef(hz);
  };
  return f;
}

/** RBJ biquad band-pass (constant peak gain); `set` retunes it. */
function bandpass(sr, fc, q) {
  let b0, b1, b2, a1, a2;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const set = (hz) => {
    const w = (TAU * Math.min(hz, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    b0 = alpha / a0;
    b1 = 0;
    b2 = -alpha / a0;
    a1 = (-2 * Math.cos(w)) / a0;
    a2 = (1 - alpha) / a0;
  };
  set(fc);
  const f = (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
  f.set = set;
  return f;
}

/** One-pole high-pass. */
function highpass(sr, fc) {
  const lp = lowpass(sr, fc);
  return (x) => x - lp(x);
}

const decay = (t, tau) => Math.exp(-t / tau);
const attack = (t, a) => (t < a ? t / a : 1);

function buffer(sr, seconds) {
  return new Float32Array(Math.max(1, Math.round(sr * seconds)));
}

/** Scale to a peak of `peak` (silence stays silent). */
function normalize(out, peak) {
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]));
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < out.length; i++) out[i] *= k;
  }
  // Short fade-out against clicks.
  const fade = Math.min(out.length, 64);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}

/** Add `src` into `dst` at sample `at`, scaled by `gain`. */
function mix(dst, src, at, gain = 1) {
  for (let i = 0; i < src.length && at + i < dst.length; i++) if (at + i >= 0) dst[at + i] += src[i] * gain;
}

// ---- Building blocks ---------------------------------------------------------

/** A gunshot: a filtered noise crack plus a short low thump. */
function shot(sr, r, { seconds = 0.14, crack = 2600, q = 0.9, tau = 0.018, body = 140, bodyTau = 0.03, bodyGain = 0.6 }) {
  const out = buffer(sr, seconds);
  const bp = bandpass(sr, crack * (0.92 + r() * 0.16), q);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    phase += (TAU * body * (1 - t * 2)) / sr;
    out[i] = bp(r() * 2 - 1) * 3 * decay(t, tau) + Math.sin(phase) * bodyGain * decay(t, bodyTau);
  }
  return out;
}

/** A boom: low-passed noise with a falling sub tone. */
function boom(sr, r, { seconds, cutoff, tau, sub = 90, subEnd = 35, subTau = 0.15, subGain = 0.8, crackle = 0 }) {
  const out = buffer(sr, seconds);
  const lp = lowpass(sr, cutoff);
  const lp2 = lowpass(sr, cutoff * 0.6);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const env = attack(t, 0.004) * decay(t, tau);
    const freq = subEnd + (sub - subEnd) * decay(t, subTau * 0.7);
    phase += (TAU * freq) / sr;
    let s = lp2(lp(r() * 2 - 1)) * 4 * env + Math.sin(phase) * subGain * decay(t, subTau);
    if (crackle > 0 && r() < crackle * decay(t, tau * 1.5)) s += (r() * 2 - 1) * 0.5 * env;
    out[i] = s;
  }
  return out;
}

/** A pure tone with an attack/decay envelope (chimes and beeps). */
function tone(sr, freq, seconds, { tau = seconds / 3, a = 0.005, shape = 'sine', harmonics = 0 } = {}) {
  const out = buffer(sr, seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    phase += (TAU * freq) / sr;
    let s = shape === 'square' ? Math.sign(Math.sin(phase)) * 0.5 : Math.sin(phase);
    if (harmonics) s += Math.sin(phase * 2) * harmonics + Math.sin(phase * 3) * harmonics * 0.5;
    out[i] = s * attack(t, a) * decay(t, tau);
  }
  return out;
}

/** Radio squelch: band-limited static burst. */
function squelch(sr, r, seconds, gain = 1) {
  const out = buffer(sr, seconds);
  const bp = bandpass(sr, 1900, 1.2);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] = bp(r() * 2 - 1) * 2.2 * gain * attack(t, 0.003) * decay(t, seconds / 2.5);
  }
  return out;
}

function sequence(sr, parts, seconds) {
  const out = buffer(sr, seconds);
  for (const [at, src, gain] of parts) mix(out, src, Math.round(at * sr), gain ?? 1);
  return out;
}

// ---- Recipes --------------------------------------------------------------------

/**
 * Sound id -> (sampleRate, random) => Float32Array. Peaks set relative
 * loudness between sounds (explosions louder than rifles, chimes moderate).
 */
export const RECIPES = {
  // Weapons
  rifle: (sr, r) => normalize(shot(sr, r, {}), 0.55),
  mg: (sr, r) => normalize(sequence(sr, [0, 0.075, 0.15].map((at) => [at, shot(sr, r, { crack: 2200, tau: 0.016 })]), 0.3), 0.55),
  chaingun: (sr, r) =>
    normalize(
      sequence(
        sr,
        [0, 0.05, 0.1, 0.15, 0.2].map((at) => [at, shot(sr, r, { crack: 1800, tau: 0.014, body: 110 })]),
        0.34,
      ),
      0.6,
    ),
  cannon_small: (sr, r) => normalize(boom(sr, r, { seconds: 0.4, cutoff: 1400, tau: 0.07, sub: 180, subEnd: 70, subTau: 0.08 }), 0.65),
  cannon: (sr, r) => normalize(boom(sr, r, { seconds: 0.55, cutoff: 1000, tau: 0.1, sub: 130, subEnd: 50, subTau: 0.12 }), 0.75),
  naval_gun: (sr, r) => normalize(boom(sr, r, { seconds: 0.9, cutoff: 700, tau: 0.18, sub: 100, subEnd: 38, subTau: 0.2 }), 0.85),
  artillery: (sr, r) => normalize(boom(sr, r, { seconds: 0.9, cutoff: 650, tau: 0.17, sub: 95, subEnd: 35, subTau: 0.22 }), 0.85),
  rocket: (sr, r) => normalize(whoosh(sr, r, { seconds: 0.6, from: 500, to: 2600, gain: 1 }), 0.6),
  rocket_heavy: (sr, r) => normalize(whoosh(sr, r, { seconds: 1.0, from: 300, to: 1800, gain: 1, rumble: 0.6 }), 0.75),
  missile: (sr, r) => normalize(whoosh(sr, r, { seconds: 0.45, from: 900, to: 3400, gain: 1 }), 0.55),
  tesla: (sr, r) => normalize(zap(sr, r, 0.45, 1), 0.7),
  flame: (sr, r) => normalize(roar(sr, r, 0.55), 0.6),
  flak: (sr, r) => normalize(sequence(sr, [[0, flakPop(sr, r)], [0.09, flakPop(sr, r), 0.8]], 0.3), 0.6),
  torpedo: (sr, r) => normalize(bubbles(sr, r, 0.6, 380), 0.55),
  depth_charge: (sr, r) => normalize(sweep(sr, 260, 90, 0.25, 0.08), 0.5),
  bomb: (sr, r) => normalize(whistle(sr, r, 1.0), 0.45),
  // Thunder after a lightning flash (weather, js/weather-fx.js): a crack, then a long low rumble.
  thunder: (sr, r) => normalize(boom(sr, r, { seconds: 2.6, cutoff: 240, tau: 0.85, sub: 52, subEnd: 28, subTau: 0.9, subGain: 1, crackle: 0.03 }), 0.8),
  thump: (sr, r) => normalize(boom(sr, r, { seconds: 0.5, cutoff: 200, tau: 0.08, sub: 60, subEnd: 40, subTau: 0.15, subGain: 1.2 }), 0.7),

  // Impacts and deaths
  hit: (sr, r) => normalize(shot(sr, r, { seconds: 0.07, crack: 4200, tau: 0.008, body: 300, bodyTau: 0.01, bodyGain: 0.2 }), 0.25),
  zap: (sr, r) => normalize(zap(sr, r, 0.2, 0.6), 0.45),
  burn: (sr, r) => normalize(roar(sr, r, 0.7, 0.4), 0.55),
  explosion_small: (sr, r) => normalize(boom(sr, r, { seconds: 0.6, cutoff: 1200, tau: 0.12, sub: 110, subEnd: 45, subTau: 0.1, crackle: 0.01 }), 0.7),
  explosion_medium: (sr, r) => normalize(boom(sr, r, { seconds: 1.0, cutoff: 800, tau: 0.22, sub: 85, subEnd: 32, subTau: 0.2, crackle: 0.015 }), 0.85),
  explosion_large: (sr, r) => normalize(boom(sr, r, { seconds: 1.6, cutoff: 600, tau: 0.38, sub: 70, subEnd: 28, subTau: 0.3, subGain: 1, crackle: 0.02 }), 0.95),
  explosion_building: (sr, r) =>
    normalize(
      sequence(
        sr,
        [
          [0, boom(sr, r, { seconds: 1.8, cutoff: 550, tau: 0.45, sub: 65, subEnd: 26, subTau: 0.35, subGain: 1, crackle: 0.025 })],
          [0.25, rubble(sr, r, 1.5), 0.5],
        ],
        2.0,
      ),
      0.95,
    ),
  explosion_ship: (sr, r) =>
    normalize(
      sequence(
        sr,
        [
          [0, boom(sr, r, { seconds: 1.5, cutoff: 600, tau: 0.35, sub: 70, subEnd: 28, subTau: 0.3, crackle: 0.02 })],
          [0.15, splashNoise(sr, r, 0.9), 0.6],
        ],
        1.6,
      ),
      0.95,
    ),
  explosion_huge: (sr, r) =>
    normalize(boom(sr, r, { seconds: 4.0, cutoff: 260, tau: 1.2, sub: 55, subEnd: 22, subTau: 1.0, subGain: 1.4, crackle: 0.03 }), 1),
  splash: (sr, r) => normalize(splashNoise(sr, r, 0.8), 0.6),
  splash_small: (sr, r) => normalize(splashNoise(sr, r, 0.35), 0.3),
  infantry_die: (sr, r) => normalize(sweep(sr, 320 + r() * 80, 140, 0.28, 0.1, 'grunt', r), 0.3),

  // Base and powers
  place_building: (sr, r) =>
    normalize(
      sequence(
        sr,
        [
          [0, boom(sr, r, { seconds: 0.5, cutoff: 300, tau: 0.08, sub: 75, subEnd: 45, subTau: 0.12, subGain: 1.2 })],
          [0.02, clank(sr, 0.45), 0.5],
        ],
        0.6,
      ),
      0.75,
    ),
  sell: (sr) => normalize(sequence(sr, [[0, tone(sr, 1320, 0.12, { tau: 0.04 })], [0.08, tone(sr, 1760, 0.3, { tau: 0.09 })]], 0.4), 0.5),
  // Power down button (OpenRA DisablePower bleep11, EnablePower bleep12) and beacons (Beacon beepslct).
  power_down: (sr) => normalize(sequence(sr, [[0, tone(sr, 880, 0.08, { tau: 0.03, shape: 'square' })], [0.09, tone(sr, 520, 0.12, { tau: 0.05, shape: 'square' })]], 0.24), 0.35),
  power_up: (sr) => normalize(sequence(sr, [[0, tone(sr, 520, 0.08, { tau: 0.03, shape: 'square' })], [0.09, tone(sr, 880, 0.12, { tau: 0.05, shape: 'square' })]], 0.24), 0.35),
  beacon: (sr) => normalize(sequence(sr, [[0, tone(sr, 1500, 0.06, { tau: 0.03 })], [0.08, tone(sr, 1500, 0.06, { tau: 0.03 })], [0.16, tone(sr, 2000, 0.1, { tau: 0.05 })]], 0.3), 0.4),
  chrono: (sr, r) => normalize(shimmer(sr, r, 1.4), 0.6),
  iron_curtain: (sr) => normalize(hum(sr, 1.3), 0.6),
  nuke_launch: (sr, r) => normalize(whoosh(sr, r, { seconds: 2.2, from: 120, to: 900, gain: 1, rumble: 1 }), 0.8),

  // Radio (unit replies; the speech, when enabled, plays between open and close)
  radio_ack: (sr, r) =>
    normalize(
      sequence(sr, [[0, squelch(sr, r, 0.05)], [0.05, tone(sr, 1250, 0.07, { tau: 0.05, shape: 'square' }), 0.5], [0.12, tone(sr, 1650, 0.09, { tau: 0.05, shape: 'square' }), 0.5], [0.21, squelch(sr, r, 0.06, 0.6)]], 0.3),
      0.4,
    ),
  radio_select: (sr, r) =>
    normalize(sequence(sr, [[0, squelch(sr, r, 0.04)], [0.04, tone(sr, 1100, 0.1, { tau: 0.05, shape: 'square' }), 0.5], [0.14, squelch(sr, r, 0.05, 0.5)]], 0.22), 0.35),
  radio_open: (sr, r) => normalize(squelch(sr, r, 0.07), 0.3),
  radio_close: (sr, r) => normalize(sequence(sr, [[0, squelch(sr, r, 0.08, 0.8)], [0.07, tone(sr, 900, 0.03, { tau: 0.01, shape: 'square' }), 0.4]], 0.11), 0.3),

  // Announcer cues (played instead of, or before, the spoken line)
  eva_info: (sr) => chime(sr, [660, 880], 0.11, 0.42),
  eva_good: (sr) => chime(sr, [523, 659, 784], 0.1, 0.45),
  eva_ready: (sr) => chime(sr, [784, 1175], 0.14, 0.45, 0.3),
  eva_warn: (sr) => chime(sr, [740, 523], 0.16, 0.45, 0.15, 'square'),
  eva_loss: (sr) => chime(sr, [587, 440, 330], 0.13, 0.42),
  eva_cash: (sr) => chime(sr, [1319, 1760], 0.08, 0.4, 0.35),
  eva_alarm: (sr) => chime(sr, [880, 622, 880, 622], 0.17, 0.5, 0.1, 'square'),
};

function whoosh(sr, r, { seconds, from, to, gain, rumble = 0 }) {
  const out = buffer(sr, seconds);
  const bp = bandpass(sr, from, 1.6);
  const lp = lowpass(sr, 160);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const k = t / seconds;
    bp.set(from + (to - from) * Math.min(1, k * 1.5));
    const env = attack(t, 0.03) * (1 - k) ** 1.5;
    out[i] = bp(r() * 2 - 1) * 3 * env * gain + lp(r() * 2 - 1) * rumble * 6 * env;
  }
  mix(out, shot(sr, r, { seconds: 0.08, crack: 1200, tau: 0.012, body: 90 }), 0, 0.6);
  return out;
}

function zap(sr, r, seconds, gain) {
  const out = buffer(sr, seconds);
  const bp = bandpass(sr, 2400, 2);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const freq = 70 + r() * 40;
    phase += (TAU * freq) / sr;
    const saw = ((phase / TAU) % 1) * 2 - 1;
    const crackle = r() < 0.15 ? bp(r() * 2 - 1) * 4 : bp(0);
    out[i] = (saw * 0.5 + crackle) * gain * attack(t, 0.004) * decay(t, seconds / 3);
  }
  return out;
}

function roar(sr, r, seconds, gain = 1) {
  const out = buffer(sr, seconds);
  const lp = lowpass(sr, 1500);
  let flutter = 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    if (i % 200 === 0) flutter = 0.6 + r() * 0.6;
    out[i] = lp(r() * 2 - 1) * 3 * flutter * gain * attack(t, 0.04) * decay(t, seconds / 2.5);
  }
  return out;
}

function flakPop(sr, r) {
  const hp = highpass(sr, 500);
  const out = shot(sr, r, { seconds: 0.12, crack: 1600, q: 0.6, tau: 0.02, body: 220, bodyTau: 0.02, bodyGain: 0.5 });
  for (let i = 0; i < out.length; i++) out[i] = hp(out[i]);
  return out;
}

function bubbles(sr, r, seconds, cutoff) {
  const out = buffer(sr, seconds);
  const lp = lowpass(sr, cutoff);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const lfo = 0.6 + 0.4 * Math.sin(TAU * 11 * t);
    out[i] = lp(r() * 2 - 1) * 5 * lfo * attack(t, 0.05) * decay(t, seconds / 2);
  }
  return out;
}

function sweep(sr, from, to, seconds, tau, kind = 'sine', r = null) {
  const out = buffer(sr, seconds);
  let phase = 0;
  const lp = lowpass(sr, 900);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = to + (from - to) * decay(t, tau);
    phase += (TAU * f) / sr;
    let s = Math.sin(phase);
    // A rough, voiced "grunt": a buzzy tone with breath noise.
    if (kind === 'grunt') s = lp(Math.sign(s) * 0.6 + s * 0.4 + (r() * 2 - 1) * 0.5);
    out[i] = s * attack(t, 0.01) * decay(t, seconds / 2.5);
  }
  return out;
}

function whistle(sr, r, seconds) {
  const out = buffer(sr, seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const k = t / seconds;
    phase += (TAU * (1900 - 1300 * k)) / sr;
    out[i] = (Math.sin(phase) + (r() * 2 - 1) * 0.05) * (0.2 + 0.8 * k) * (k > 0.95 ? (1 - k) * 20 : 1);
  }
  return out;
}

function splashNoise(sr, r, seconds) {
  const out = buffer(sr, seconds);
  const bp = bandpass(sr, 1400, 0.7);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const env = attack(t, 0.015) * decay(t, seconds / 3.5);
    out[i] = bp(r() * 2 - 1) * 3 * env * (0.7 + 0.3 * Math.sin(TAU * 23 * t));
  }
  return out;
}

function rubble(sr, r, seconds) {
  const out = buffer(sr, seconds);
  const lp = lowpass(sr, 900);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const grain = r() < 0.02 ? 1 : 0.15;
    out[i] = lp((r() * 2 - 1) * grain) * 6 * decay(t, seconds / 3);
  }
  return out;
}

/** Metallic clank: inharmonic partials. */
function clank(sr, seconds) {
  const out = buffer(sr, seconds);
  const partials = [
    [523, 1],
    [1213, 0.6],
    [1870, 0.4],
    [2690, 0.25],
  ];
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let s = 0;
    for (const [f, g] of partials) s += Math.sin(TAU * f * t) * g * decay(t, seconds / (2 + f / 900));
    out[i] = s * attack(t, 0.002);
  }
  return out;
}

function shimmer(sr, r, seconds) {
  const out = buffer(sr, seconds);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const k = t / seconds;
    let s = 0;
    for (let h = 1; h <= 4; h++) s += Math.sin(TAU * (300 + 900 * k) * h * t + h) / h;
    out[i] = s * Math.sin(Math.PI * k) * (0.8 + 0.2 * Math.sin(TAU * 17 * t)) + (r() * 2 - 1) * 0.03;
  }
  return out;
}

function hum(sr, seconds) {
  const out = buffer(sr, seconds);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const k = t / seconds;
    const s = Math.sin(TAU * 55 * t) + 0.6 * Math.sin(TAU * 110.5 * t) + 0.3 * Math.sin(TAU * 221 * t);
    out[i] = s * Math.sin(Math.PI * k) * (0.7 + 0.3 * Math.sin(TAU * 6 * t));
  }
  return out;
}

function chime(sr, notes, step, peak, tail = 0.12, shape = 'sine') {
  const seconds = step * notes.length + tail + 0.15;
  const parts = notes.map((f, k) => [k * step, tone(sr, f, step + tail, { tau: (step + tail) / 2.5, shape, harmonics: shape === 'sine' ? 0.15 : 0 })]);
  return normalize(sequence(sr, parts, seconds), peak);
}

/** Variants rendered per sound id (different random seeds, slight pitch change). */
export const VARIANTS = 3;

/**
 * Render one variant of a sound.
 * @returns {Float32Array | null} null for unknown ids
 */
export function render(id, sampleRate, variant = 0) {
  const recipe = RECIPES[id];
  if (!recipe) return null;
  let seed = 0x9e3779b1;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 0x01000193);
  return recipe(sampleRate, rng(seed + variant * 7919));
}

/** Playback-rate jitter for a variant, so repeated shots do not sound identical. */
export function variantRate(variant) {
  return [1, 0.94, 1.06][variant % 3];
}
