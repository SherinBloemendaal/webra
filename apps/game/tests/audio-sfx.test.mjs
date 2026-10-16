// WebRA's own effect sounds (js/audio/synth.js): every cue the catalog can
// ask for exists, the effects stay as loud as the set they replaced (so the
// mix keeps its balance), never clip, render the same every time and cost no
// more to render than before. Synthetic data only; no engine needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECIPES, VARIANTS, loudness, render } from '../js/audio/synth.js';
import {
  CRATE_ACTIONS,
  EVA,
  KINDS,
  POWER_KINDS,
  SOUND_SYNTH,
  WEAPON_SYNTH,
  chuteSound,
  cloakSound,
  crateSounds,
  crushSound,
  damagedSound,
  deathSound,
  ejectChuteSound,
  fireSound,
  impactSound,
  madTankSounds,
  paraImpactSound,
  placeSound,
  powerSound,
  rearmSound,
  sellSound,
  teleportSound,
  transformSounds,
  voiceLine,
} from '../js/audio/catalog.js';
import { ACTOR_SOUNDS } from '../js/audio/catalog-data.js';
import { thunderCue } from '../js/audio/director.js';

/**
 * The 0.16 effects these replaced, measured at 48 kHz (variant 0): [peak,
 * RMS of the loudest 50 ms]. The thunder (0.15), the announcer chimes and
 * the infantry death grunt were kept and are not listed.
 */
const BASELINE = {
  rifle: [0.55, 0.1088], mg: [0.55, 0.0995], chaingun: [0.6, 0.0981], cannon_small: [0.65, 0.2267], cannon: [0.75, 0.2987],
  naval_gun: [0.85, 0.3284], artillery: [0.85, 0.4365], rocket: [0.6, 0.1636], rocket_heavy: [0.75, 0.2209], missile: [0.55, 0.1514],
  tesla: [0.7, 0.1778], flame: [0.6, 0.1741], flak: [0.6, 0.0993], torpedo: [0.55, 0.1578], depth_charge: [0.5, 0.2903], bomb: [0.45, 0.2989],
  thump: [0.7, 0.4203], hit: [0.25, 0.0329], zap: [0.45, 0.1048], burn: [0.55, 0.1368], explosion_small: [0.7, 0.2483],
  explosion_medium: [0.85, 0.3634], explosion_large: [0.95, 0.3822], explosion_building: [0.95, 0.4116], explosion_ship: [0.95, 0.3663],
  explosion_huge: [1, 0.5281], splash: [0.6, 0.1604], splash_small: [0.3, 0.0792], place_building: [0.75, 0.3176], sell: [0.5, 0.2525],
  cash_up: [0.3, 0.1278], cash_down: [0.3, 0.1278], power_down: [0.35, 0.2364], power_up: [0.35, 0.2364], beacon: [0.4, 0.1915],
  chrono: [0.6, 0.2747], iron_curtain: [0.6, 0.2832], nuke_launch: [0.8, 0.2784], sonar_pulse: [0.45, 0.2842], crush: [0.45, 0.201],
  chute: [0.35, 0.0568], cloak: [0.35, 0.2194], uncloak: [0.35, 0.2187], rearm: [0.4, 0.1201], damaged: [0.65, 0.2052], crate: [0.35, 0.1439],
  ui_click: [0.25, 0.0609], radar_up: [0.4, 0.2577], radar_down: [0.4, 0.2609], level_up: [0.4, 0.1661], chat_line: [0.3, 0.1702],
  player_joined: [0.3, 0.1702], player_left: [0.3, 0.1702], lobby_option: [0.28, 0.1589], alert_buzzer: [0.4, 0.3765], alert_bleep: [0.35, 0.1418],
  angry_bleep: [0.35, 0.2364], base_setup: [0.35, 0.1863], radio_ack: [0.4, 0.0732], radio_select: [0.35, 0.0711], radio_open: [0.3, 0.0624],
  radio_close: [0.3, 0.0655],
};
/**
 * Seconds of sound in one variant of every 0.16 recipe (thunder and chimes
 * included): the render work of that set (55.5 s). Tight on purpose (the new
 * set has 55.39 s): the rule is "no more sound to render than before", so a
 * new or longer sound must give the time back elsewhere, or raise this
 * together with a measured render cost (BASELINE_COST still holds).
 */
const BASELINE_SECONDS = 55.5;
/**
 * CPU time of every effect (the BASELINE ids) against the thunder's in the
 * same run (0.62 to 0.66 measured on the current set, which renders the 0.16
 * set's sound budget; the wall time ratio this replaced was 0.89), and the margin the median of COST_RUNS runs
 * may exceed it by. CPU time (process.cpuUsage) rather than wall time, both
 * kinds rendered in every run in alternating order, and the median: other
 * work on the machine (parallel test suites, builds) moves the ratio by a
 * few percent at most, well within the margin, while a new sound that costs
 * as much as a tenth of the set still fails.
 */
const BASELINE_COST = 0.65;
const COST_MARGIN = 0.1;
const COST_RUNS = 5;

const SR = 48000;
const dB = (x) => 20 * Math.log10(x);

/** Every synthesized id the catalog, the director and the audio system can ask for. */
function cuedIds() {
  const ids = new Set();
  const add = (s) => {
    for (const x of [s].flat()) if (x?.synth) ids.add(x.synth);
  };
  for (const w of Object.keys(WEAPON_SYNTH)) {
    add(fireSound(w));
    add(impactSound(w, false));
    add(impactSound(w, true));
  }
  for (const actor of Object.keys(ACTOR_SOUNDS)) {
    for (const kind of KINDS) for (let seq = 0; seq < 6; seq++) add(deathSound(actor, kind, seq));
    add(placeSound(actor));
    add(sellSound(actor));
    add(transformSounds(actor));
    add(teleportSound(actor, false));
    add(teleportSound(actor, true));
    add(madTankSounds(actor, false));
    add(madTankSounds(actor, true));
    add(damagedSound(actor));
    add(crushSound(actor));
    add(chuteSound(actor));
    add(ejectChuteSound(actor));
    add(paraImpactSound(actor, false));
    add(paraImpactSound(actor, true));
    add(cloakSound(actor, true));
    add(cloakSound(actor, false));
    add(rearmSound(actor));
    for (const line of ['select', 'move']) add(voiceLine(actor, 'vehicle', 'allies', line));
  }
  for (let code = 0; code < CRATE_ACTIONS.length; code++) add(crateSounds(code).sound);
  for (const id of Object.values(SOUND_SYNTH)) if (id) ids.add(id);
  for (let code = 0; code < POWER_KINDS.length; code++) {
    add(powerSound(code));
    add(powerSound(code, { deploy: 'sonpulse' }));
  }
  for (const e of Object.values(EVA)) if (e.chime) ids.add(e.chime);
  const view = { x0: 0, y0: 0, x1: 1000, y1: 600 };
  for (const [x, y] of [[500, 300], [1500, 300], [500, 6000]]) ids.add(thunderCue(x, y, view).synth);
  // Played by the audio system itself (js/audio/index.js): the radio around a spoken reply and the volume test sound.
  for (const id of ['radio_open', 'radio_close', 'cannon']) ids.add(id);
  return ids;
}

test('every cue has a sound, and every sound has a cue', () => {
  const cued = cuedIds();
  for (const id of cued) assert.ok(RECIPES[id], `${id} is synthesized`);
  for (const id of Object.keys(RECIPES)) assert.ok(cued.has(id), `${id} is played by some cue`);
  for (const id of Object.keys(BASELINE)) assert.ok(RECIPES[id], `${id} still exists`);
});

/** Render every variant of every sound `runs` times; the shortest run per group is its cost. */
/** CPU milliseconds (user and system) of `fn`. */
function cpuMs(fn) {
  const t0 = process.cpuUsage();
  const out = fn();
  const d = process.cpuUsage(t0);
  return { out, ms: (d.user + d.system) / 1000 };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Every recipe rendered `runs` times (the order reversed every other run, so
 * effects and thunder share whatever else the machine does): the sounds, and
 * per run the CPU time of the effects and of the thunder. `effects`,
 * `thunder` and `ratio` are the medians.
 */
function renderAll(runs) {
  const sounds = new Map();
  const ids = Object.keys(RECIPES);
  const fxRuns = [];
  const thRuns = [];
  const ratios = [];
  for (let k = 0; k < runs; k++) {
    let fx = 0;
    let th = 0;
    for (const id of k % 2 ? [...ids].reverse() : ids) {
      const { out: variants, ms } = cpuMs(() => Array.from({ length: VARIANTS }, (_, v) => render(id, SR, v)));
      if (id in BASELINE) fx += ms;
      if (id.startsWith('thunder')) th += ms;
      sounds.set(id, variants);
    }
    fxRuns.push(fx);
    thRuns.push(th);
    ratios.push(fx / th);
  }
  return { sounds, effects: median(fxRuns), thunder: median(thRuns), ratio: median(ratios), ratios };
}

/** The rendered set and its cost, made once on first use (it takes a second or two). */
let rendered = null;
const renderedSet = () => (rendered ??= renderAll(COST_RUNS));

/** RMS of the 5 ms before normalize()'s 64 sample fade, against the peak: what is left when the sound stops. */
function tailLevel(s, sr, peak) {
  const end = s.length - 64;
  const n = Math.round(sr * 0.005);
  let e = 0;
  for (let i = Math.max(0, end - n); i < end; i++) e += s[i] * s[i];
  return Math.sqrt(e / n) / peak;
}
/** At most this tail level (of the peak): louder, the 3 ms fade cuts the sound off with an audible tick. */
const MAX_TAIL = 0.1;

test('the effects never clip, end in silence, sit on zero and render the same every time', () => {
  const { sounds } = renderedSet();
  for (const [id, variants] of sounds) {
    for (const [v, s] of variants.entries()) {
      let peak = 0;
      let sum = 0;
      for (const x of s) {
        assert.ok(Number.isFinite(x), `${id}#${v} is finite`);
        peak = Math.max(peak, Math.abs(x));
        sum += x;
      }
      assert.ok(peak <= 1, `${id}#${v} peaks at ${peak}`);
      if (BASELINE[id]) assert.ok(peak <= BASELINE[id][0] + 1e-6, `${id}#${v} peaks at ${peak}, no higher than before (${BASELINE[id][0]})`);
      assert.ok(Math.abs(s[s.length - 1]) < 1e-6, `${id}#${v} fades out`);
      const tail = tailLevel(s, SR, peak);
      assert.ok(tail < MAX_TAIL, `${id}#${v} has died away before it ends (last 5 ms at ${tail.toFixed(3)} of the peak)`);
      assert.ok(Math.abs(sum / s.length) < 0.02 * peak + 1e-4, `${id}#${v} has no DC offset (${sum / s.length})`);
    }
    assert.deepEqual(render(id, SR, 0), variants[0], `${id} renders the same each time`);
    // Seeded recipes (those that take the random source) differ per variant; the others vary by playback rate only.
    if (RECIPES[id].length > 1) assert.notDeepEqual(variants[0], variants[1], `${id} variants differ`);
  }
});

test('each effect is as loud as the one it replaced (within 3 dB), and the mix as a whole within 1 dB', () => {
  const { sounds } = renderedSet();
  let before = 0;
  let after = 0;
  for (const [id, [, loud]] of Object.entries(BASELINE)) {
    for (const [v, s] of sounds.get(id).entries()) {
      const now = loudness(s, SR);
      assert.ok(Math.abs(dB(now / loud)) <= 3, `${id}#${v} loudness ${now.toFixed(4)} against ${loud} (${dB(now / loud).toFixed(1)} dB)`);
    }
    before += dB(loud);
    after += dB(loudness(sounds.get(id)[0], SR));
  }
  const n = Object.keys(BASELINE).length;
  assert.ok(Math.abs(after / n - before / n) <= 1, `mean loudness moved ${(after / n - before / n).toFixed(2)} dB`);
  // The order of the battle stays: a nuke over a building, a building over a tank shell, a shell over a rifle.
  const level = (id) => loudness(sounds.get(id)[0], SR);
  assert.ok(level('explosion_huge') > level('explosion_building'));
  assert.ok(level('explosion_large') > level('explosion_small'));
  assert.ok(level('cannon') > level('rifle'));
  assert.ok(level('rifle') > level('hit'));
  // The same at the other common output rates: 44.1 kHz, and 22050 Hz where the grain of the finish is off.
  for (const sr of [44100, 22050]) {
    const within = sr === 22050 ? 3.5 : 3;
    for (const id of Object.keys(BASELINE)) {
      const off = dB(loudness(render(id, sr, 0), sr) / BASELINE[id][1]);
      assert.ok(Math.abs(off) <= within, `${id} at ${sr} Hz: ${off.toFixed(1)} dB`);
    }
  }
});

test('rendering costs no more than the 0.16 set', (t) => {
  const { sounds, effects, thunder, ratio, ratios } = renderedSet();
  let seconds = 0;
  for (const variants of sounds.values()) seconds += variants[0].length / SR;
  assert.ok(seconds <= BASELINE_SECONDS, `${seconds.toFixed(2)} s of sound per variant, at most ${BASELINE_SECONDS}`);
  // CPU time depends on the machine: against the unchanged thunder, rendered in the same runs.
  const most = BASELINE_COST * (1 + COST_MARGIN);
  t.diagnostic(
    `${seconds.toFixed(2)} s of sound (budget ${BASELINE_SECONDS}); effects ${effects.toFixed(0)} ms CPU, thunder ${thunder.toFixed(0)} ms CPU, ratio ${ratio.toFixed(2)} (median of ${ratios.map((r) => r.toFixed(2)).join(', ')}; baseline ${BASELINE_COST}, at most ${most.toFixed(2)})`,
  );
  assert.ok(ratio <= most, `effects take ${effects.toFixed(0)} ms CPU, ${ratio.toFixed(2)} of the thunder's ${thunder.toFixed(0)} ms (median of ${COST_RUNS} runs; baseline ${BASELINE_COST}, at most ${most.toFixed(2)})`);
});
