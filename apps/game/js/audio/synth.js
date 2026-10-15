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
//
// The effects aim at the feel of the mid 90s game samples: short, hard
// attacks, filtered noise, pitch drops under every shot and blast, a clipped
// front (drive) and the grain of 22 and 11 kHz samples (lofi). Envelopes
// decay by a per-sample factor and swept filters are retuned every
// RETUNE samples, which keeps rendering cheap.

/** Per-sample factor of an exponential decay with time constant `tau` seconds. */
const fall = (sr, tau) => Math.exp(-1 / (tau * sr));

/** Samples between two retunes of a swept filter. */
const RETUNE = 32;

/** Two one-pole low-passes in a row (12 dB per octave); `set` retunes both. */
function lowpass2(sr, fc) {
  const a = lowpass(sr, fc);
  const b = lowpass(sr, fc);
  const f = (x) => b(a(x));
  f.set = (hz) => {
    a.set(hz);
    b.set(hz);
  };
  return f;
}

/** Soft clip: a rational approximation of tanh (exact enough, and cheap), level at full scale beyond 3. */
const softClip = (x) => (x <= -3 ? -1 : x >= 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));

/** RMS of the loudest `window` seconds: how loud a short effect sounds. */
export function loudness(out, sr, window = 0.05) {
  const n = Math.max(1, Math.round(sr * window));
  let acc = 0;
  let best = 0;
  for (let i = 0; i < out.length; i++) {
    acc += out[i] * out[i];
    if (i >= n) acc -= out[i - n] * out[i - n];
    if (acc > best) best = acc;
  }
  return Math.sqrt(best / Math.min(n, out.length));
}

/**
 * The finish of every effect: scale to full range, soft-clip with `drive`
 * (0: none) for the hard front of the old samples, add the grain of a
 * sample rate of `hz` (sample and hold, 0: none) and of `bits` bit samples
 * (0: none), take out DC, then scale to the `level` of the sound (LEVEL: [peak,
 * loudness]) with the short fade-out of normalize().
 */
function finish(sr, out, [peak, loud], { drive = 0, hz = 0, bits = 0 } = {}) {
  // One pass does it all (the filters inlined), then one scales: every effect goes through here.
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]));
  if (!max) return out;
  const gain = 1 / max;
  const clip = drive > 0 ? 1 / softClip(drive) : 1;
  // Sample and hold: the steps alias like a low-rate sample; a gentle low-pass takes the edge off them.
  const hold = hz && hz < sr;
  const step = hz / sr;
  const cl = 1 - Math.exp((-TAU * hz * 0.45) / sr);
  const q = bits ? 2 ** (bits - 1) : 0;
  // A thud's falling sine leaves a little DC: a 15 Hz high-pass takes it out (no click as the sound starts or stops).
  const ch = 1 - Math.exp((-TAU * 15) / sr);
  const window = Math.max(1, Math.round(sr * 0.05));
  let acc = 1;
  let held = 0;
  let yl = 0;
  let yh = 0;
  let top = 0;
  let energy = 0;
  let loudest = 0;
  for (let i = 0; i < out.length; i++) {
    let x = out[i] * gain;
    if (drive > 0) x = softClip(x * drive) * clip;
    if (hold) {
      acc += step;
      if (acc >= 1) {
        acc -= 1;
        held = x;
      }
      x = yl += cl * (held - yl);
    }
    if (q) x = Math.round(x * q) / q;
    yh += ch * (x - yh);
    x -= yh;
    out[i] = x;
    top = Math.max(top, Math.abs(x));
    // The loudness (loudness()) of the result, before the final scale.
    energy += x * x;
    if (i >= window) energy -= out[i - window] * out[i - window];
    loudest = Math.max(loudest, energy);
  }
  const rms = Math.sqrt(loudest / Math.min(window, out.length));
  const k = Math.min(peak / top, loud / rms);
  const fade = Math.min(out.length, 64);
  for (let i = 0; i < out.length; i++) out[i] *= k;
  // Short fade-out against clicks, as normalize() does.
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}

/**
 * A pitched thud: a sine whose pitch drops from `from` to `to` Hz (time
 * constant `drop`) under an exponential decay (`tau`), the body of a shot or
 * a blast, like the kick of a drum machine.
 */
function thud(sr, { seconds, from, to, drop, tau, a = 0.0008 }) {
  const out = buffer(sr, seconds);
  const kDrop = fall(sr, drop);
  const kTau = fall(sr, tau);
  const rise = 1 / Math.max(1, a * sr);
  let up = 0;
  let d = 1;
  let env = 1;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    phase += (TAU * (to + (from - to) * d)) / sr;
    out[i] = Math.sin(phase) * env * up;
    up = Math.min(1, up + rise);
    d *= kDrop;
    env *= kTau;
  }
  return out;
}

/**
 * Filtered noise: a band-pass (`q`) whose centre glides from `from` to `to`
 * Hz (time constant `glide`), rising in `a` seconds and decaying with `tau`.
 * `grain` (0 to 1) roughens the level at `grainHz`, the crunch of a blast or
 * the flutter of a flame.
 */
function noise(sr, r, { seconds, from, to = from, glide = 0.05, q = 0.7, tau, a = 0.001, grain = 0, grainHz = 60 }) {
  // The band-pass (bandpass(), constant peak gain) and the grain's smoothing are inlined: this loop is hot.
  const out = buffer(sr, seconds);
  const kTau = fall(sr, tau);
  const kGlide = fall(sr, glide);
  const hold = Math.max(1, Math.round(sr / grainHz));
  const cs = 1 - Math.exp((-TAU * grainHz * 2) / sr);
  const rise = 1 / Math.max(1, a * sr);
  let b0 = 0;
  let a1 = 0;
  let a2 = 0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let up = 0;
  let g = 1;
  let gs = 1;
  let d = 1;
  let env = 1;
  for (let i = 0; i < out.length; i++) {
    if (i % RETUNE === 0) {
      const w = (TAU * Math.min(to + (from - to) * d, sr * 0.45)) / sr;
      const alpha = Math.sin(w) / (2 * q);
      b0 = alpha / (1 + alpha);
      a1 = (-2 * Math.cos(w)) / (1 + alpha);
      a2 = (1 - alpha) / (1 + alpha);
    }
    if (grain && i % hold === 0) g = 1 - grain + r() * grain * 2;
    gs += cs * (g - gs);
    const x = r() * 2 - 1;
    const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y * env * up * gs;
    up = Math.min(1, up + rise);
    env *= kTau;
    d *= kGlide;
  }
  return out;
}

/**
 * Low rumble: noise through a 12 dB low-pass whose cutoff falls from
 * `bright` to `dark` Hz (time constant `darken`), with a coarse grain at
 * `grainHz`: the roar of an explosion or a rocket motor.
 */
function rumble(sr, r, { seconds, bright, dark, darken, tau, a = 0.003, grain = 0.5, grainHz = 50, env: shape = null }) {
  // The low-passes (lowpass2()) and the grain's smoothing are inlined: this loop is hot.
  const out = buffer(sr, seconds);
  const kTau = fall(sr, tau);
  const kDark = fall(sr, darken);
  const hold = Math.max(1, Math.round(sr / grainHz));
  const cs = 1 - Math.exp((-TAU * grainHz * 2) / sr);
  const rise = 1 / Math.max(1, a * sr);
  let c = 0;
  let ya = 0;
  let yb = 0;
  let up = 0;
  let g = 1;
  let gs = 1;
  let d = 1;
  let env = 1;
  for (let i = 0; i < out.length; i++) {
    if (i % RETUNE === 0) c = 1 - Math.exp((-TAU * (dark + (bright - dark) * d)) / sr);
    if (i % hold === 0) g = 1 - grain + r() * grain * 2;
    gs += cs * (g - gs);
    ya += c * (r() * 2 - 1 - ya);
    yb += c * (ya - yb);
    out[i] = yb * (shape ? shape(i / sr) : env * up) * gs;
    up = Math.min(1, up + rise);
    env *= kTau;
    d *= kDark;
  }
  return out;
}

/**
 * Crackle: random pops (sparks, debris, burning wood) about `rate` times a
 * second, thinning out with `tau`, each ringing briefly at `tone` Hz. The
 * pops are a Poisson process: each gap is drawn at the rate of its moment.
 */
function crackle(sr, r, { seconds, rate, tau, tone: hz, q = 1.4 }) {
  const out = buffer(sr, seconds);
  let last = 0;
  for (let t = 0; ; ) {
    const now = rate * Math.exp(-t / tau);
    if (now < 0.05) break;
    t -= Math.log(1 - r()) / now;
    const i = Math.round(t * sr);
    if (i >= out.length) break;
    out[i] = (r() * 2 - 1) * 8;
    last = i;
  }
  // After the last pop the band-pass rings out within 30 ms; the rest stays silent.
  const bp = bandpass(sr, hz, q);
  const end = Math.min(out.length, last + Math.round(sr * 0.03));
  for (let i = 0; i < end; i++) out[i] = bp(out[i]);
  return out;
}

/**
 * Metal: a struck object ringing in its modes, `partials` of [Hz, gain,
 * decay seconds]. Each mode is a damped resonator (two multiplies a sample),
 * struck by a short noise tick for the hit.
 */
function modes(sr, r, partials, seconds, tick = 0.3) {
  const out = buffer(sr, seconds);
  for (const [hz, gain, tau] of partials) {
    const w = (TAU * Math.min(hz, sr * 0.45)) / sr;
    const R = fall(sr, tau);
    const c = 2 * R * Math.cos(w);
    const R2 = R * R;
    let y1 = gain * Math.sin(w);
    let y2 = 0;
    for (let i = 0; i < out.length; i++) {
      out[i] += y1;
      const y = c * y1 - R2 * y2;
      y2 = y1;
      y1 = y;
    }
  }
  const hp = highpass(sr, 1500);
  const n = Math.min(out.length, Math.round(sr * 0.003));
  for (let i = 0; i < n; i++) out[i] += hp(r() * 2 - 1) * tick * (1 - i / n);
  return out;
}

/**
 * A bleep of the old sound cards: a pulse wave (`duty` of each cycle high)
 * starting at `from` Hz and gliding to `to` Hz with time constant `glide`.
 */
function bleep(sr, from, seconds, { to = from, glide = 0.01, duty = 0.5, tau = seconds / 3, a = 0.002, vibrato = 0, vibratoHz = 12 } = {}) {
  const out = buffer(sr, seconds);
  const kGlide = fall(sr, glide);
  const kTau = fall(sr, tau);
  // A pulse wave narrower than half a cycle is off centre: take its mean out.
  const dc = 2 * duty - 1;
  let d = 1;
  let env = 1;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = (to + (from - to) * d) * (vibrato ? 1 + vibrato * Math.sin(TAU * vibratoHz * t) : 1);
    phase = (phase + f / sr) % 1;
    out[i] = ((phase < duty ? 1 : -1) - dc) * env * attack(t, a);
    d *= kGlide;
    env *= kTau;
  }
  return out;
}

/** Bleeps one after another: `notes` of [Hz, seconds] every `step` seconds, as one bleep voice. */
function bleeps(sr, notes, step, opts = {}) {
  const seconds = step * (notes.length - 1) + Math.max(...notes.map(([, s]) => s)) + 0.01;
  return sequence(
    sr,
    notes.map(([hz, s], k) => [k * step, bleep(sr, hz, s, { glide: 0.006, to: hz * (opts.slide ?? 0.94), ...opts })]),
    seconds,
  );
}

/**
 * A gunshot: a click, a band-passed crack at `crack` Hz, a pitched thud
 * (`body` falling to `bodyTo` Hz) and a short low-passed tail (`tail`, the
 * report off the ground). Variants shift the crack and the thud a little.
 */
function gunshot(sr, r, { seconds = 0.16, crack = 1800, q = 0.8, tau = 0.018, body = 380, bodyTo = 110, bodyTau = 0.03, bodyGain = 0.5, tail = 0.35, tailTau = 0.06, tailHz = 1300 }) {
  const out = buffer(sr, seconds);
  const j = 0.92 + r() * 0.16;
  const bp = bandpass(sr, crack * j, q);
  const hp = highpass(sr, 1500);
  // The tail's two one-pole low-passes (lowpass2()) are inlined: this loop is hot.
  const c = 1 - Math.exp((-TAU * tailHz) / sr);
  const kTau = fall(sr, tau);
  const kBody = fall(sr, bodyTau);
  const kTail = fall(sr, tailTau);
  const kDrop = fall(sr, 0.012);
  const click = Math.round(sr * 0.0015);
  let e = 3;
  let eb = bodyGain;
  let et = tail * 4;
  let ya = 0;
  let yb = 0;
  let d = 1;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const n = r() * 2 - 1;
    phase += (TAU * (bodyTo + (body * j - bodyTo) * d)) / sr;
    ya += c * (n - ya);
    yb += c * (ya - yb);
    // The crack is over within a few time constants: past -100 dB its filter is skipped.
    out[i] = (e > 3e-5 ? bp(n) * e : 0) + (i < click ? hp(n) * 1.5 : 0) + Math.sin(phase) * eb + yb * et;
    e *= kTau;
    eb *= kBody;
    et *= kTail;
    d *= kDrop;
  }
  return out;
}

/** Rapid fire: `rounds` gunshots `gap` seconds apart, each a little different. */
function burst(sr, r, rounds, gap, shot, seconds) {
  const parts = [];
  for (let k = 0; k < rounds; k++) parts.push([k * gap * (0.95 + r() * 0.1), gunshot(sr, r, shot), 0.85 + r() * 0.15]);
  return sequence(sr, parts, seconds);
}

/**
 * An explosion: a broadband crack, a pitched thud underneath (`body` to
 * `bodyTo` Hz), a granular roar whose low-pass falls from `bright` to `dark`
 * Hz and debris crackling in the tail (`debris` pops a second).
 */
function blast(
  sr,
  r,
  { seconds, crack = 1, body, bodyTo, drop = 0.04, bodyTau, bodyGain = 1, roarTau, bright, dark, darken = 0.15, grain = 0.5, grainHz = 60, debris = 0, debrisTau = 0.3, debrisHz = 2200 },
) {
  const j = 0.94 + r() * 0.12;
  const parts = [
    [0, noise(sr, r, { seconds: 0.12, from: 3200 * j, to: 900, glide: 0.02, q: 0.5, tau: 0.014 }), crack],
    [0, thud(sr, { seconds, from: body * j, to: bodyTo, drop, tau: bodyTau }), bodyGain],
    [0.002, rumble(sr, r, { seconds, bright: bright * j, dark, darken, tau: roarTau, grain, grainHz }), 1.6],
  ];
  if (debris) parts.push([0.03, crackle(sr, r, { seconds: seconds - 0.03, rate: debris, tau: debrisTau, tone: debrisHz * j }), 0.35]);
  return sequence(sr, parts, seconds);
}

/**
 * A rocket leaving: an ignition pop and thud, then the exhaust: band-passed
 * hiss falling from `from` to `to` Hz as it flies off, with a fluttering
 * motor (`grain`) and an optional low roar (`roar`).
 */
function launch(sr, r, { seconds, from, to, glide, tau, pop = 0.6, roar = 0, grain = 0.35 }) {
  return sequence(
    sr,
    [
      [0, gunshot(sr, r, { seconds: 0.12, crack: 1100, tau: 0.012, body: 260, bodyTo: 80, bodyGain: 0.8, tail: 0.2 }), pop],
      [0.008, noise(sr, r, { seconds: seconds - 0.008, from, to, glide, q: 1.1, tau, a: 0.02, grain, grainHz: 45 }), 1.4],
      [0.008, rumble(sr, r, { seconds: seconds - 0.008, bright: 700, dark: 220, darken: tau, tau, a: 0.03, grain: 0.5, grainHz: 35 }), roar],
    ],
    seconds,
  );
}

/**
 * Electric discharge: a buzzing sawtooth (`buzz` Hz, jittered) and
 * band-passed crackle, chopped by random arcs, after a falling zap chirp.
 */
function discharge(sr, r, seconds, { buzz = 110, bright = 2600, chirp = 1, sustain = 0.6 } = {}) {
  const out = buffer(sr, seconds);
  const bp = bandpass(sr, bright, 1.2);
  const hold = Math.max(1, Math.round(sr * 0.006));
  const kChirp = fall(sr, 0.012);
  let gate = 1;
  let phase = 0;
  let saw = 0;
  let c = 1;
  let f = buzz;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const k = t / seconds;
    if (i % hold === 0) {
      gate = r() < 0.75 ? 0.5 + r() * 0.5 : 0.1;
      f = buzz * (0.85 + r() * 0.3);
    }
    saw = (saw + f / sr) % 1;
    phase += (TAU * (180 + 3200 * c)) / sr;
    const env = attack(t, 0.002) * (k < sustain ? 1 - 0.3 * (k / sustain) : 0.7 * (1 - (k - sustain) / (1 - sustain)));
    out[i] = ((saw * 2 - 1) * 0.6 + bp(r() * 2 - 1) * 2.5) * gate * env + Math.sin(phase) * c * chirp;
    c *= kChirp;
  }
  return out;
}

/** Fire: low-passed noise that opens in a whoosh and flutters, with crackle. */
function fire(sr, r, seconds, { open = 2200, rest = 900, a = 0.025, pops = 40 } = {}) {
  return sequence(
    sr,
    [
      [0, rumble(sr, r, { seconds, bright: open, dark: rest, darken: 0.12, tau: seconds / 2.5, a, grain: 0.6, grainHz: 32 }), 1],
      [0.02, crackle(sr, r, { seconds: seconds - 0.02, rate: pops, tau: seconds / 2, tone: 3200 }), 0.25],
    ],
    seconds,
  );
}

/** Water thrown up: a plop, a falling band of noise and droplets. */
function splash(sr, r, seconds) {
  return sequence(
    sr,
    [
      [0, thud(sr, { seconds: 0.15, from: 380, to: 140, drop: 0.02, tau: 0.035 }), 0.5],
      [0, noise(sr, r, { seconds, from: 2200, to: 900, glide: 0.1, q: 0.6, tau: seconds / 3.5, a: 0.01, grain: 0.45, grainHz: 40 }), 3],
      [0.03, crackle(sr, r, { seconds: seconds - 0.03, rate: 70, tau: seconds / 3, tone: 3600, q: 2 }), 0.3],
    ],
    seconds,
  );
}

/** Radio static: band-passed noise in the voice band with a fast, rough flutter. */
function squelch(sr, r, seconds, gain = 1) {
  const out = noise(sr, r, { seconds, from: 1900, q: 1.1, tau: seconds / 2.5, a: 0.003, grain: 0.7, grainHz: 400 });
  for (let i = 0; i < out.length; i++) out[i] *= 2.2 * gain;
  return out;
}

function sequence(sr, parts, seconds) {
  const out = buffer(sr, seconds);
  for (const [at, src, gain] of parts) mix(out, src, Math.round(at * sr), gain ?? 1);
  return out;
}

/** Chimes and beeps (the announcer cues): a pure or square tone with an attack/decay envelope. */
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

function chime(sr, notes, step, peak, tail = 0.12, shape = 'sine') {
  const seconds = step * notes.length + tail + 0.15;
  const parts = notes.map((f, k) => [k * step, tone(sr, f, step + tail, { tau: (step + tail) / 2.5, shape, harmonics: shape === 'sine' ? 0.15 : 0 })]);
  return normalize(sequence(sr, parts, seconds), peak);
}

// ---- Recipes --------------------------------------------------------------------

/** Finishes per family: how hard the front clips and how coarse the grain is. */
const GUN = { drive: 2.5, hz: 22050 };
const HEAVY = { drive: 3, hz: 16000 };
const BLAST = { drive: 3.5, hz: 11025 };
const ELECTRIC = { drive: 2.5, hz: 16000 };
const CHIP = { hz: 22050, bits: 8 };
const METAL = { drive: 2, hz: 22050 };

/** One explosion size per class (blast parameters). */
const BLASTS = {
  small: { seconds: 0.6, body: 170, bodyTo: 50, drop: 0.03, bodyTau: 0.09, roarTau: 0.11, bright: 3200, dark: 600, darken: 0.08, debris: 30, debrisTau: 0.15 },
  medium: { seconds: 1.0, body: 130, bodyTo: 40, drop: 0.05, bodyTau: 0.16, roarTau: 0.2, bright: 2600, dark: 400, darken: 0.12, debris: 40, debrisTau: 0.3 },
  large: { seconds: 1.6, body: 105, bodyTo: 32, drop: 0.07, bodyTau: 0.26, roarTau: 0.33, bright: 2200, dark: 300, darken: 0.18, debris: 50, debrisTau: 0.45 },
  huge: { seconds: 4.0, body: 80, bodyTo: 20, drop: 0.2, bodyTau: 0.9, bodyGain: 1.4, roarTau: 1.0, bright: 1600, dark: 160, darken: 0.5, grain: 0.6, grainHz: 25, debris: 30, debrisTau: 1.2, debrisHz: 1500 },
};

/**
 * Level of each effect: [peak, loudness], loudness being the RMS of its
 * loudest 50 ms. Both are those of the 0.16 sounds these replaced, so the mix
 * keeps its balance: finish() scales a sound to its peak, and further down
 * when its denser, clipped body would make it louder than that.
 */
const LEVEL = {
  rifle: [0.55, 0.1088],
  mg: [0.55, 0.0995],
  chaingun: [0.6, 0.0981],
  cannon_small: [0.65, 0.2267],
  cannon: [0.75, 0.2987],
  naval_gun: [0.85, 0.3284],
  artillery: [0.85, 0.4365],
  rocket: [0.6, 0.1636],
  rocket_heavy: [0.75, 0.2209],
  missile: [0.55, 0.1514],
  tesla: [0.7, 0.1778],
  flame: [0.6, 0.1741],
  flak: [0.6, 0.0993],
  torpedo: [0.55, 0.1578],
  depth_charge: [0.5, 0.2903],
  bomb: [0.45, 0.2989],
  thump: [0.7, 0.4203],
  hit: [0.25, 0.0329],
  zap: [0.45, 0.1048],
  burn: [0.55, 0.1368],
  explosion_small: [0.7, 0.2483],
  explosion_medium: [0.85, 0.3634],
  explosion_large: [0.95, 0.3822],
  explosion_building: [0.95, 0.4116],
  explosion_ship: [0.95, 0.3663],
  explosion_huge: [1, 0.5281],
  splash: [0.6, 0.1604],
  splash_small: [0.3, 0.0792],
  place_building: [0.75, 0.3176],
  sell: [0.5, 0.2525],
  cash_up: [0.3, 0.1278],
  cash_down: [0.3, 0.1278],
  power_down: [0.35, 0.2364],
  power_up: [0.35, 0.2364],
  beacon: [0.4, 0.1915],
  chrono: [0.6, 0.2747],
  iron_curtain: [0.6, 0.2832],
  nuke_launch: [0.8, 0.2784],
  sonar_pulse: [0.45, 0.2842],
  crush: [0.45, 0.201],
  chute: [0.35, 0.0568],
  cloak: [0.35, 0.2194],
  uncloak: [0.35, 0.2187],
  rearm: [0.4, 0.1201],
  damaged: [0.65, 0.2052],
  crate: [0.35, 0.1439],
  ui_click: [0.25, 0.0609],
  radar_up: [0.4, 0.2577],
  radar_down: [0.4, 0.2609],
  level_up: [0.4, 0.1661],
  chat_line: [0.3, 0.1702],
  player_joined: [0.3, 0.1702],
  player_left: [0.3, 0.1702],
  lobby_option: [0.28, 0.1589],
  alert_buzzer: [0.4, 0.3765],
  alert_bleep: [0.35, 0.1418],
  angry_bleep: [0.35, 0.2364],
  base_setup: [0.35, 0.1863],
  radio_ack: [0.4, 0.0732],
  radio_select: [0.35, 0.0711],
  radio_open: [0.3, 0.0624],
  radio_close: [0.3, 0.0655],
};

/**
 * Sound id -> (sampleRate, random) => Float32Array. Peaks set relative
 * loudness between sounds (explosions louder than rifles, chimes moderate).
 */
export const RECIPES = {
  // Weapons. Small arms: a crack, a thud and a short report; automatic weapons fire bursts.
  rifle: (sr, r) => finish(sr, gunshot(sr, r, { seconds: 0.16 }), LEVEL.rifle, GUN),
  mg: (sr, r) => finish(sr, burst(sr, r, 5, 0.058, { seconds: 0.12, crack: 2000, tau: 0.014, tail: 0.25, tailTau: 0.04 }, 0.36), LEVEL.mg, GUN),
  chaingun: (sr, r) =>
    finish(sr, burst(sr, r, 7, 0.042, { seconds: 0.11, crack: 1400, tau: 0.013, body: 300, bodyTo: 90, bodyGain: 0.7, tail: 0.3, tailTau: 0.04 }, 0.4), LEVEL.chaingun, GUN),
  // Guns: a cannon's clipped bang over a dropping thud and a dark report; bigger guns roll on longer.
  cannon_small: (sr, r) =>
    finish(sr, gunshot(sr, r, { seconds: 0.4, crack: 1200, q: 0.6, tau: 0.02, body: 220, bodyTo: 65, bodyTau: 0.07, bodyGain: 1.2, tail: 0.6, tailTau: 0.09, tailHz: 900 }), LEVEL.cannon_small, HEAVY),
  cannon: (sr, r) =>
    finish(sr, gunshot(sr, r, { seconds: 0.55, crack: 950, q: 0.6, tau: 0.024, body: 170, bodyTo: 48, bodyTau: 0.1, bodyGain: 1.5, tail: 0.7, tailTau: 0.13, tailHz: 750 }), LEVEL.cannon, HEAVY),
  naval_gun: (sr, r) => finish(sr, bigGun(sr, r, 0.9, 130, 0.18), LEVEL.naval_gun, HEAVY),
  artillery: (sr, r) => finish(sr, bigGun(sr, r, 0.9, 115, 0.22), LEVEL.artillery, HEAVY),
  // Rockets: ignition, then the exhaust falling away; AA missiles are brighter and quicker.
  rocket: (sr, r) => finish(sr, launch(sr, r, { seconds: 0.6, from: 2800, to: 800, glide: 0.18, tau: 0.2 }), LEVEL.rocket, HEAVY),
  rocket_heavy: (sr, r) => finish(sr, launch(sr, r, { seconds: 1.0, from: 1900, to: 500, glide: 0.35, tau: 0.35, pop: 0.9, roar: 1.2, grain: 0.5 }), LEVEL.rocket_heavy, HEAVY),
  missile: (sr, r) => finish(sr, launch(sr, r, { seconds: 0.45, from: 4200, to: 1500, glide: 0.1, tau: 0.13, pop: 0.4 }), LEVEL.missile, GUN),
  tesla: (sr, r) => finish(sr, discharge(sr, r, 0.5), LEVEL.tesla, ELECTRIC),
  flame: (sr, r) => finish(sr, fire(sr, r, 0.55), LEVEL.flame, HEAVY),
  // Anti-aircraft guns: deep, quick pom-pom pops.
  flak: (sr, r) => {
    const pop = () => gunshot(sr, r, { seconds: 0.13, crack: 900, q: 0.6, tau: 0.02, body: 240, bodyTo: 80, bodyTau: 0.04, bodyGain: 1, tail: 0.3, tailTau: 0.04, tailHz: 1000 });
    return finish(sr, sequence(sr, [[0, pop()], [0.085, pop(), 0.85], [0.17, pop(), 0.7]], 0.32), LEVEL.flak, { drive: 1.5, hz: 16000 });
  },
  // Torpedo: a muffled launch thunk and the gurgle of its run.
  torpedo: (sr, r) =>
    finish(
      sr,
      sequence(
        sr,
        [
          [0, thud(sr, { seconds: 0.2, from: 200, to: 60, drop: 0.03, tau: 0.05 }), 0.8],
          [0.02, rumble(sr, r, { seconds: 0.58, bright: 500, dark: 300, darken: 0.2, tau: 0.25, a: 0.04, grain: 0.9, grainHz: 14 }), 1.2],
          [0.04, crackle(sr, r, { seconds: 0.5, rate: 60, tau: 0.3, tone: 700, q: 3 }), 0.3],
        ],
        0.6,
      ),
      LEVEL.torpedo,
      { drive: 1.5, hz: 11025 },
    ),
  // Depth charge thrown: a mortar-like thoomp.
  depth_charge: (sr, r) =>
    finish(
      sr,
      sequence(sr, [[0, thud(sr, { seconds: 0.3, from: 240, to: 70, drop: 0.03, tau: 0.08 }), 1], [0, noise(sr, r, { seconds: 0.2, from: 1500, to: 600, glide: 0.04, q: 0.7, tau: 0.035 }), 2]], 0.3),
      LEVEL.depth_charge,
      HEAVY,
    ),
  // A falling bomb's whistle, as on the old sound cards: a triangle wave sliding down.
  bomb: (sr, r) => finish(sr, whistle(sr, r, 1.0), LEVEL.bomb, CHIP),
  // Weather: thunder after a lightning flash (js/weather-fx.js; the cue by distance is director.js
  // thunderCue): close, a tearing crack with echoes and then heavy rolls; medium, a dull clap and rolls;
  // distant, no crack, a soft rumble that swells and rolls.
  thunder_close: (sr, r) => normalize(thunderClap(sr, r, THUNDER.close), 1),
  thunder: (sr, r) => normalize(thunderClap(sr, r, THUNDER.medium), 0.75),
  thunder_distant: (sr, r) => normalize(thunderClap(sr, r, THUNDER.distant), 0.5),
  // MAD tank charging: a heavy low pulse with a ringing hull.
  thump: (sr, r) =>
    finish(
      sr,
      sequence(sr, [[0, thud(sr, { seconds: 0.5, from: 95, to: 36, drop: 0.06, tau: 0.16 }), 1.3], [0.005, modes(sr, r, [[180, 0.4, 0.09], [410, 0.25, 0.06], [905, 0.12, 0.04]], 0.3), 1]], 0.5),
      LEVEL.thump,
      HEAVY,
    ),

  // Impacts and deaths
  hit: (sr, r) =>
    finish(sr, gunshot(sr, r, { seconds: 0.08, crack: 3000, q: 1, tau: 0.006, body: 520, bodyTo: 200, bodyTau: 0.008, bodyGain: 0.3, tail: 0.15, tailTau: 0.015, tailHz: 2500 }), LEVEL.hit, GUN),
  zap: (sr, r) => finish(sr, discharge(sr, r, 0.22, { buzz: 140, bright: 3400, chirp: 0.6, sustain: 0.3 }), LEVEL.zap, ELECTRIC),
  burn: (sr, r) => finish(sr, fire(sr, r, 0.7, { open: 1600, rest: 700, a: 0.01, pops: 70 }), LEVEL.burn, HEAVY),
  explosion_small: (sr, r) => finish(sr, blast(sr, r, BLASTS.small), LEVEL.explosion_small, BLAST),
  explosion_medium: (sr, r) => finish(sr, blast(sr, r, BLASTS.medium), LEVEL.explosion_medium, BLAST),
  explosion_large: (sr, r) => finish(sr, blast(sr, r, BLASTS.large), LEVEL.explosion_large, BLAST),
  // A structure going up: the large blast, a second one as it caves in and falling rubble.
  explosion_building: (sr, r) =>
    finish(
      sr,
      sequence(
        sr,
        [
          [0, blast(sr, r, { ...BLASTS.large, seconds: 2.0, roarTau: 0.4 })],
          [0.32, blast(sr, r, BLASTS.small), 0.55],
          [0.25, rubble(sr, r, 1.7), 0.8],
        ],
        2.0,
      ),
      LEVEL.explosion_building,
      BLAST,
    ),
  explosion_ship: (sr, r) => finish(sr, sequence(sr, [[0, blast(sr, r, BLASTS.large)], [0.12, splash(sr, r, 1.0), 0.5]], 1.6), LEVEL.explosion_ship, BLAST),
  // A nuke: the largest blast, and the shock front rolling in after it.
  explosion_huge: (sr, r) =>
    finish(
      sr,
      sequence(
        sr,
        [
          [0, blast(sr, r, BLASTS.huge)],
          [0.45, rumble(sr, r, { seconds: 3.5, bright: 900, dark: 140, darken: 0.8, tau: 0.9, a: 0.25, grain: 0.7, grainHz: 18 }), 1.2],
        ],
        4.0,
      ),
      LEVEL.explosion_huge,
      BLAST,
    ),
  splash: (sr, r) => finish(sr, splash(sr, r, 0.8), LEVEL.splash, GUN),
  splash_small: (sr, r) => finish(sr, splash(sr, r, 0.35), LEVEL.splash_small, GUN),
  infantry_die: (sr, r) => normalize(sweep(sr, 320 + r() * 80, 140, 0.28, 0.1, 'grunt', r), 0.3),

  // Base and powers
  // A structure set down: a heavy thud and a steel clank, then the latch ("ka-chunk").
  place_building: (sr, r) =>
    finish(
      sr,
      sequence(
        sr,
        [
          [0, thud(sr, { seconds: 0.5, from: 125, to: 45, drop: 0.03, tau: 0.12 }), 1.3],
          [0, noise(sr, r, { seconds: 0.2, from: 900, to: 300, glide: 0.03, q: 0.6, tau: 0.03 }), 2],
          [0.004, modes(sr, r, [[310, 1, 0.12], [523, 0.7, 0.09], [1213, 0.5, 0.06], [1870, 0.35, 0.04], [2690, 0.25, 0.03]], 0.4), 0.45],
          [0.14, modes(sr, r, [[740, 0.6, 0.04], [1660, 0.4, 0.03], [2950, 0.3, 0.02]], 0.12, 0.6), 0.35],
        ],
        0.6,
      ),
      LEVEL.place_building,
      METAL,
    ),
  // Sold: two register ticks and a bright ka-ching.
  sell: (sr, r) =>
    finish(
      sr,
      sequence(
        sr,
        [
          [0, modes(sr, r, [[2400, 0.5, 0.008], [3900, 0.3, 0.006]], 0.03, 0.6)],
          [0.05, modes(sr, r, [[2100, 0.5, 0.008], [3500, 0.3, 0.006]], 0.03, 0.6)],
          [0.1, modes(sr, r, [[2093, 1, 0.16], [3136, 0.6, 0.12], [4186, 0.45, 0.09], [5274, 0.25, 0.07]], 0.33, 0.4)],
        ],
        0.45,
      ),
      LEVEL.sell,
      METAL,
    ),
  // Credits counter ticking up and down (OpenRA CashTickUp cashup1, CashTickDown cashdn1): short bright ticks.
  cash_up: (sr) => finish(sr, bleep(sr, 2600, 0.035, { to: 2200, glide: 0.006, duty: 0.5, tau: 0.014, a: 0.0005 }), LEVEL.cash_up, CHIP),
  cash_down: (sr) => finish(sr, bleep(sr, 1700, 0.035, { to: 1400, glide: 0.006, duty: 0.5, tau: 0.014, a: 0.0005 }), LEVEL.cash_down, CHIP),
  // Power down button (OpenRA DisablePower bleep11, EnablePower bleep12) and beacons (Beacon beepslct).
  power_down: (sr) => finish(sr, bleeps(sr, [[900, 0.08], [520, 0.13]], 0.09, { tau: 0.05 }), LEVEL.power_down, CHIP),
  power_up: (sr) => finish(sr, bleeps(sr, [[520, 0.08], [900, 0.13]], 0.09, { tau: 0.05, slide: 1.04 }), LEVEL.power_up, CHIP),
  beacon: (sr) => finish(sr, bleeps(sr, [[1500, 0.06], [1500, 0.06], [2000, 0.11]], 0.08, { tau: 0.03, slide: 1 }), LEVEL.beacon, CHIP),
  // Superweapons. Chronoshift: a warbling sweep up with sparks, and a zap as it jumps.
  chrono: (sr, r) =>
    finish(
      sr,
      sequence(
        sr,
        [
          [0, warp(sr, r, 1.4)],
          [0.05, crackle(sr, r, { seconds: 1.3, rate: 90, tau: 2, tone: 5200, q: 2 }), 0.5],
          [1.08, discharge(sr, r, 0.3, { buzz: 160, bright: 3800, chirp: 1, sustain: 0.2 }), 0.5],
        ],
        1.4,
      ),
      LEVEL.chrono,
      ELECTRIC,
    ),
  // Iron Curtain: a metal clang and a deep, beating hum swelling through a filter.
  iron_curtain: (sr, r) =>
    finish(sr, sequence(sr, [[0, drone(sr, 1.3)], [0, modes(sr, r, [[220, 1, 0.5], [331, 0.7, 0.4], [587, 0.5, 0.3], [943, 0.3, 0.2]], 1.0), 0.4]], 1.3), LEVEL.iron_curtain, { drive: 1.5, hz: 16000 }),
  // Nuke launch: ignition and a rocket motor that grows louder and rises as the missile climbs.
  nuke_launch: (sr, r) => {
    const k = (t) => Math.min(1, t / 0.25) * (t < 1.4 ? 1 : Math.max(0, 1 - (t - 1.4) / 0.8));
    return finish(
      sr,
      sequence(
        sr,
        [
          [0, blast(sr, r, { ...BLASTS.small, seconds: 0.5, debris: 0 }), 0.8],
          [0.05, rumble(sr, r, { seconds: 2.15, bright: 300, dark: 900, darken: 0.9, tau: 1, grain: 0.55, grainHz: 30, env: k }), 1.6],
          [0.1, noise(sr, r, { seconds: 2.1, from: 500, to: 1800, glide: 0.8, q: 1, tau: 0.9, a: 0.3, grain: 0.5, grainHz: 40 }), 0.9],
        ],
        2.2,
      ),
      LEVEL.nuke_launch,
      HEAVY,
    );
  },
  // Sonar pulse (SpawnActorPower DeploySound sonpulse): a ringing ping with an echo.
  sonar_pulse: (sr, r) => {
    const ping = (g) => modes(sr, r, [[1180, 1, 0.16], [3257, 0.12, 0.05]], 0.5, 0.05 * g);
    return finish(sr, sequence(sr, [[0, ping(1)], [0.38, ping(0.5), 0.35]], 0.9), LEVEL.sonar_pulse, { hz: 22050 });
  },

  // Actor sounds of the rules (OpenRA mods/ra rules; the originals are named in catalog-data.js)
  // Crushable.CrushSound and Parachutable.GroundImpactSound (squishy2): a short wet thud.
  crush: (sr, r) =>
    finish(
      sr,
      sequence(sr, [[0, thud(sr, { seconds: 0.2, from: 150, to: 60, drop: 0.02, tau: 0.04 }), 1], [0.01, rumble(sr, r, { seconds: 0.2, bright: 900, dark: 400, darken: 0.04, tau: 0.045, a: 0.002, grain: 0.9, grainHz: 90 }), 2.5]], 0.22),
      LEVEL.crush,
      HEAVY,
    ),
  // ParaDrop.ChuteSound (chute1): a canopy snapping open, then a soft flutter.
  chute: (sr, r) =>
    finish(
      sr,
      sequence(
        sr,
        [
          [0, gunshot(sr, r, { seconds: 0.08, crack: 900, tau: 0.012, body: 180, bodyTo: 120, bodyGain: 0.3, tail: 0.1 })],
          [0.05, noise(sr, r, { seconds: 0.5, from: 700, q: 0.8, tau: 0.16, a: 0.03, grain: 0.9, grainHz: 18 }), 0.5],
        ],
        0.55,
      ),
      LEVEL.chute,
      GUN,
    ),
  // Cloak CloakSound / UncloakSound (subshow1, appear1): a warbling chip sweep up or down.
  cloak: (sr) => finish(sr, bleep(sr, 420, 0.45, { to: 1700, glide: 0.18, duty: 0.5, tau: 0.25, a: 0.01, vibrato: 0.04, vibratoHz: 14 }), LEVEL.cloak, CHIP),
  uncloak: (sr) => finish(sr, bleep(sr, 1700, 0.45, { to: 420, glide: 0.18, duty: 0.5, tau: 0.25, a: 0.01, vibrato: 0.04, vibratoHz: 14 }), LEVEL.uncloak, CHIP),
  // AmmoPool.RearmSound (minelay1): a mechanical clunk and click.
  rearm: (sr, r) =>
    finish(
      sr,
      sequence(sr, [[0, thud(sr, { seconds: 0.15, from: 190, to: 90, drop: 0.02, tau: 0.035 }), 1], [0, modes(sr, r, [[900, 0.5, 0.04], [1450, 0.3, 0.03]], 0.12), 1], [0.12, modes(sr, r, [[2600, 0.4, 0.01], [4100, 0.2, 0.008]], 0.05, 0.5), 0.6]], 0.2),
      LEVEL.rearm,
      METAL,
    ),
  // SoundOnDamageTransition.DamagedSounds (kaboom1, sandbag2, crmble2): a structure cracking and crumbling.
  damaged: (sr, r) =>
    finish(sr, sequence(sr, [[0, blast(sr, r, { ...BLASTS.small, seconds: 0.4, crack: 1.4, debris: 0 })], [0.06, rubble(sr, r, 0.64), 0.7]], 0.7), LEVEL.damaged, BLAST),
  // CrateAction.Sound (heal2, ironcur9 for crates): a bright chip arpeggio.
  crate: (sr) => finish(sr, bleeps(sr, [[784, 0.08], [988, 0.08], [1319, 0.08], [1568, 0.16]], 0.055, { duty: 0.4, tau: 0.06, slide: 1 }), LEVEL.crate, CHIP),

  // Sound notifications (OpenRA notifications.yaml Sounds)
  // ClickSound (ramenu1): every interface button; a relay-like double click.
  ui_click: (sr, r) =>
    finish(sr, sequence(sr, [[0, modes(sr, r, [[2900, 1, 0.004], [4300, 0.6, 0.003]], 0.02, 0.5)], [0.011, modes(sr, r, [[2300, 0.6, 0.004]], 0.02, 0.3), 0.6]], 0.035), LEVEL.ui_click, GUN),
  // RadarUp (radaron2) and RadarDown (radardn1): a sweep with the chatter of a computer starting or stopping.
  radar_up: (sr, r) => finish(sr, radar(sr, r, true), LEVEL.radar_up, CHIP),
  radar_down: (sr, r) => finish(sr, radar(sr, r, false), LEVEL.radar_down, CHIP),
  // LevelUp (hydrod1): a promotion fanfare.
  level_up: (sr) => finish(sr, bleeps(sr, [[523, 0.12], [784, 0.12], [1047, 0.3]], 0.08, { duty: 0.25, tau: 0.1, slide: 1 }), LEVEL.level_up, CHIP),
  // ChatLine (rabeep1): a short beep for a chat line.
  chat_line: (sr) => finish(sr, bleep(sr, 1250, 0.07, { tau: 0.03, to: 1180 }), LEVEL.chat_line, CHIP),
  // PlayerJoined (bleep11), PlayerLeft (bleep12), LobbyOptionChanged (bleep17).
  player_joined: (sr) => finish(sr, bleeps(sr, [[700, 0.06], [1050, 0.08]], 0.07, { tau: 0.03 }), LEVEL.player_joined, CHIP),
  player_left: (sr) => finish(sr, bleeps(sr, [[1050, 0.06], [700, 0.08]], 0.07, { tau: 0.03 }), LEVEL.player_left, CHIP),
  lobby_option: (sr) => finish(sr, bleep(sr, 880, 0.08, { tau: 0.03, to: 830 }), LEVEL.lobby_option, CHIP),
  // AlertBuzzer (buzzy1), AlertBleep (bleep6), AngryBleep (bleep5), BaseSetup (bleep9): mission script cues.
  alert_buzzer: (sr) => finish(sr, bleep(sr, 140, 0.5, { tau: 0.4, duty: 0.45, vibrato: 0.03, vibratoHz: 30 }), LEVEL.alert_buzzer, CHIP),
  alert_bleep: (sr) => finish(sr, bleeps(sr, [[1600, 0.07], [1600, 0.07]], 0.1, { tau: 0.03, slide: 0.97 }), LEVEL.alert_bleep, CHIP),
  angry_bleep: (sr) => finish(sr, bleeps(sr, [[420, 0.08], [380, 0.12]], 0.09, { tau: 0.05 }), LEVEL.angry_bleep, CHIP),
  base_setup: (sr) => finish(sr, bleeps(sr, [[440, 0.14], [660, 0.14], [880, 0.17]], 0.07, { tau: 0.06, slide: 1 }), LEVEL.base_setup, CHIP),

  // Radio (unit replies; the speech, when enabled, plays between open and close)
  radio_ack: (sr, r) =>
    finish(
      sr,
      sequence(sr, [[0, squelch(sr, r, 0.05)], [0.05, bleep(sr, 1250, 0.07, { tau: 0.05 }), 0.5], [0.12, bleep(sr, 1650, 0.09, { tau: 0.05 }), 0.5], [0.21, squelch(sr, r, 0.06, 0.6)]], 0.3),
      LEVEL.radio_ack,
      CHIP,
    ),
  radio_select: (sr, r) => finish(sr, sequence(sr, [[0, squelch(sr, r, 0.04)], [0.04, bleep(sr, 1100, 0.1, { tau: 0.05 }), 0.5], [0.14, squelch(sr, r, 0.05, 0.5)]], 0.22), LEVEL.radio_select, CHIP),
  radio_open: (sr, r) => finish(sr, squelch(sr, r, 0.07), LEVEL.radio_open, CHIP),
  radio_close: (sr, r) => finish(sr, sequence(sr, [[0, squelch(sr, r, 0.08, 0.8)], [0.07, bleep(sr, 900, 0.03, { tau: 0.01 }), 0.4]], 0.11), LEVEL.radio_close, CHIP),

  // Announcer cues (played instead of, or before, the spoken line)
  eva_info: (sr) => chime(sr, [660, 880], 0.11, 0.42),
  eva_good: (sr) => chime(sr, [523, 659, 784], 0.1, 0.45),
  eva_ready: (sr) => chime(sr, [784, 1175], 0.14, 0.45, 0.3),
  eva_warn: (sr) => chime(sr, [740, 523], 0.16, 0.45, 0.15, 'square'),
  eva_loss: (sr) => chime(sr, [587, 440, 330], 0.13, 0.42),
  eva_cash: (sr) => chime(sr, [1319, 1760], 0.08, 0.4, 0.35),
  eva_alarm: (sr) => chime(sr, [880, 622, 880, 622], 0.17, 0.5, 0.1, 'square'),
};

/** A big gun: a cannon shot with a deeper thud and an echo off the land. */
function bigGun(sr, r, seconds, body, tailTau) {
  const shot = gunshot(sr, r, { seconds, crack: 800, q: 0.5, tau: 0.028, body, bodyTo: 38, bodyTau: 0.16, bodyGain: 1.8, tail: 0.8, tailTau, tailHz: 600 });
  const echo = rumble(sr, r, { seconds: seconds - 0.12, bright: 500, dark: 200, darken: 0.2, tau: tailTau, a: 0.02, grain: 0.6, grainHz: 30 });
  return sequence(sr, [[0, shot], [0.12, echo, 0.9]], seconds);
}

/** Falling rubble: low, dense crackle over a dark granular rumble. */
function rubble(sr, r, seconds) {
  return sequence(
    sr,
    [
      [0, crackle(sr, r, { seconds, rate: 140, tau: seconds / 2.5, tone: 650, q: 1.2 }), 1],
      [0, rumble(sr, r, { seconds, bright: 700, dark: 250, darken: seconds / 3, tau: seconds / 3, a: 0.05, grain: 0.9, grainHz: 25 }), 0.8],
    ],
    seconds,
  );
}

/** The bomb's whistle: a triangle wave falling from 1800 to 700 Hz, louder as it nears. */
function whistle(sr, r, seconds) {
  const out = buffer(sr, seconds);
  const wobble = 0.004 + r() * 0.004;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const k = t / seconds;
    phase = (phase + ((1800 - 1100 * k) * (1 + wobble * Math.sin(TAU * 7 * t))) / sr) % 1;
    const tri = 4 * Math.abs(phase - 0.5) - 1;
    out[i] = tri * (0.25 + 0.75 * k) * (k > 0.95 ? (1 - k) * 20 : 1);
  }
  return out;
}

/** Chronoshift warble: two detuned pulse waves sweeping up with a deepening vibrato. */
function warp(sr, r, seconds) {
  const out = buffer(sr, seconds);
  const detune = 1.01 + r() * 0.01;
  const lp = lowpass(sr, 3000);
  let a = 0;
  let b = 0;
  let f = 0;
  let env = 0;
  for (let i = 0; i < out.length; i++) {
    if (i % RETUNE === 0) {
      const t = i / sr;
      const k = t / seconds;
      f = (120 * 2 ** (3.2 * k ** 1.3) * (1 + 0.06 * k * Math.sin(TAU * 14 * t))) / sr;
      env = Math.sin(Math.PI * k) ** 0.7;
    }
    a = (a + f) % 1;
    b = (b + f * detune) % 1;
    out[i] = lp((a < 0.5 ? 1 : -1) + ((b < 0.3 ? 1 : -1) + 0.4) * 0.7) * env;
  }
  return out;
}

/** Iron Curtain drone: beating sawtooths at 55 and 110 Hz through a low-pass that swells open and closes. */
function drone(sr, seconds) {
  const out = buffer(sr, seconds);
  const lp = lowpass2(sr, 200);
  let a = 0;
  let b = 0;
  let c = 0;
  let env = 0;
  for (let i = 0; i < out.length; i++) {
    if (i % RETUNE === 0) {
      const t = i / sr;
      const swell = Math.sin((Math.PI * t) / seconds);
      lp.set(200 + 1400 * swell * swell);
      env = swell * (0.75 + 0.25 * Math.sin(TAU * 6 * t));
    }
    a = (a + 55 / sr) % 1;
    b = (b + 55.6 / sr) % 1;
    c = (c + 110.3 / sr) % 1;
    out[i] = lp(a + b + c * 0.6 - 1.3) * env;
  }
  return out;
}

/** Radar: a square sweep up (or down) with random data chatter and, starting up, a closing bleep. */
function radar(sr, r, up) {
  const seconds = up ? 0.65 : 0.7;
  const out = buffer(sr, seconds);
  const hold = Math.round(sr * 0.025);
  let chatter = 0;
  let phase = 0;
  let cp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const k = t / seconds;
    const f = up ? 250 * 5.6 ** Math.min(1, k * 1.4) : 1400 * (1 / 7) ** k;
    if (i % hold === 0) chatter = r() < 0.6 ? 600 + Math.floor(r() * 8) * 220 : 0;
    phase = (phase + f / sr) % 1;
    cp = (cp + chatter / sr) % 1;
    const sweep = (phase < 0.5 ? 1 : -1) * 0.7;
    const data = chatter ? (cp < 0.5 ? 1 : -1) * 0.35 * (up ? k : 1 - k) : 0;
    out[i] = (sweep + data) * attack(t, 0.01) * (up ? 1 - 0.4 * k : 1 - k);
  }
  if (up) mix(out, bleep(sr, 1400, 0.15, { tau: 0.05 }), Math.round(sr * 0.48), 0.5);
  return out;
}

/**
 * Thunder shapes (thunderClap): `crack` is the opening snap's level against
 * the rumble (0: none), low-passed at `dull` Hz when set (heard from further
 * away, the snap loses its highs), `echoes` its reflections, `rolls` the overlapping swells of rumble spread over
 * `spread` seconds, each rising in `swell` seconds and dying away in about
 * `ring` seconds; the rumble's low-pass falls from `bright` to `dark` Hz and
 * a sub-bass tone (`sub`) gives it body.
 */
const THUNDER = {
  close: { seconds: 4.6, crack: 1.2, dull: 0, echoes: 3, rolls: 6, start: 0.06, spread: 2.4, swell: 0.08, ring: 0.9, bright: 900, dark: 160, sub: 0.3 },
  medium: { seconds: 4.4, crack: 0.45, dull: 1500, echoes: 2, rolls: 5, start: 0.1, spread: 2.2, swell: 0.25, ring: 0.85, bright: 500, dark: 140, sub: 0.28 },
  distant: { seconds: 4.2, crack: 0, dull: 0, echoes: 0, rolls: 5, start: 0.1, spread: 2.0, swell: 0.7, ring: 0.8, bright: 320, dark: 125, sub: 0.22 },
};

/**
 * Thunder: a crack (a broadband snap with a tearing chain of bursts,
 * high crackle and a few duller echoes off the land), then several rolls of
 * low-passed noise, each with its own swell, with a slow irregular flutter
 * on top and a falling sub-bass tone underneath. Crack and rumble are scaled
 * separately so `crack` sets their balance whatever the filters do.
 */
function thunderClap(sr, r, { seconds, crack, dull, echoes, rolls, start, spread, swell, ring, bright, dark, sub }) {
  const out = buffer(sr, seconds);
  // Rolls: the first right after the crack, then later and mostly weaker ones.
  const parts = [];
  for (let k = 0; k < rolls; k++) {
    const at = k === 0 ? start * (0.8 + r() * 0.4) : start + spread * (k / (rolls - 1)) ** 1.25 * (0.75 + r() * 0.4);
    const gain = (k === 0 ? 1 : 0.45 + r() * 0.55) * (1 - (0.45 * k) / rolls);
    parts.push({ at, gain, rise: swell * (0.6 + r() * 0.8), tau: ring * (0.6 + r() * 0.7) });
  }
  // Below the sub tone the noise only muddies it: the rumble starts at 50 Hz.
  const hp = highpass(sr, 50);
  const lpA = lowpass(sr, bright);
  const lpB = lowpass(sr, bright);
  const lpC = lowpass(sr, bright);
  const flutterLp = lowpass(sr, 5);
  const bodyLp = lowpass(sr, 3);
  const hold = Math.max(1, Math.round(sr / 22));
  let target = 1;
  let phase = 0;
  const rumble = new Float32Array(out.length);
  const body = new Float32Array(out.length);
  const end = Math.max(0.2, seconds * 0.15);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let env = 0;
    for (const p of parts) {
      const u = t - p.at;
      if (u <= 0) continue;
      // A smooth swell (raised cosine), then an exponential decay.
      const rise = u < p.rise ? 0.5 - 0.5 * Math.cos((Math.PI * u) / p.rise) : 1;
      env += p.gain * rise * decay(Math.max(0, u - p.rise), p.tau);
    }
    if (i % hold === 0) target = 0.35 + r() * 1.1;
    const flutter = flutterLp(target);
    // Darker as it rolls on; each loud moment opens the filter a little.
    const cutoff = dark + (bright - dark) * decay(t, 0.6) + 140 * Math.min(1, env) * (bright / 900);
    lpA.set(cutoff);
    lpB.set(cutoff);
    lpC.set(cutoff * 1.3);
    const fade = t > seconds - end ? (seconds - t) / end : 1;
    const freq = 30 + 22 * decay(t, 1.2) + 4 * Math.sin(TAU * 0.7 * t);
    phase += (TAU * freq) / sr;
    rumble[i] = lpC(lpB(lpA(hp(r() * 2 - 1)))) * env * flutter * fade;
    body[i] = Math.sin(phase) * bodyLp(env) * fade;
  }
  mix(out, normalize(rumble, 1), 0);
  mix(out, normalize(body, sub), 0);
  if (crack > 0) {
    const snap = thunderCrack(sr, r, echoes);
    if (dull) {
      const lpA = lowpass(sr, dull);
      const lpB = lowpass(sr, dull);
      for (let i = 0; i < snap.length; i++) snap[i] = lpB(lpA(snap[i]));
    }
    mix(out, normalize(snap, crack), 0);
  }
  return out;
}

/** The snap of a close strike: a broadband burst, a tearing chain, crackle and echoes. */
function thunderCrack(sr, r, echoes) {
  const dry = buffer(sr, 0.5);
  const hp = highpass(sr, 250);
  const tear = bandpass(sr, 2600 + r() * 1200, 0.7);
  const fizz = bandpass(sr, 5200 + r() * 1500, 1.4);
  const bursts = [];
  for (let k = 0, at = 0.008; k < 7; k++, at += 0.012 + r() * 0.03) bursts.push({ at, gain: (0.5 + r() * 0.5) * (1 - k / 9) });
  for (let i = 0; i < dry.length; i++) {
    const t = i / sr;
    let chain = 0;
    for (const b of bursts) if (t >= b.at) chain += b.gain * decay(t - b.at, 0.009);
    const snap = hp(r() * 2 - 1) * attack(t, 0.0012) * decay(t, 0.045);
    const pops = r() < 0.12 * decay(t, 0.18) ? (r() * 2 - 1) * 6 : 0;
    dry[i] = snap * 1.4 + tear(r() * 2 - 1) * 2.5 * chain + fizz(pops) * decay(t, 0.25);
  }
  normalize(dry, 1);
  const out = buffer(sr, 0.5 + 0.45);
  mix(out, dry, 0);
  // Echoes off the ground and hills: later, softer and duller.
  for (let k = 0; k < echoes; k++) {
    const at = 0.06 + k * 0.09 + r() * 0.07;
    const lp = lowpass(sr, 2200 - k * 500);
    const echo = new Float32Array(dry.length);
    for (let i = 0; i < dry.length; i++) echo[i] = lp(dry[i]);
    mix(out, echo, Math.round(at * sr), 0.5 * 0.6 ** k);
  }
  return out;
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
