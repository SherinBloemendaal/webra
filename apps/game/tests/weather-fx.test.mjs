// Weather on screen (js/weather-fx.js): HUD texts, ramps, lightning and the
// thunder hook, the particles' world grid, its level of detail and size
// clamps, the weather clock, reduced motion and low quality, and the
// uniforms the shaders read (js/renderer.js packGlobals, shaders/*.wgsl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CELL_OFFSET,
  CLOCK_LAG,
  KINDS,
  LAYERS,
  MAX_PARTICLES,
  NO_EFFECT,
  RAMP,
  REDUCED_SPEED,
  SIZE_ZOOM_MAX,
  SIZE_ZOOM_MIN,
  THUNDER_DELAY,
  THUNDER_TRAVEL,
  WeatherFx,
  heatText,
  particleScale,
  weatherGrid,
  weatherInfo,
} from '../js/weather-fx.js';
import { GLOBALS_BYTES, WEATHER_OFFSET, packGlobals } from '../js/renderer.js';

/** A 1920 x 1080 CSS px view at the default zoom (1.5 CSS px per world px), in world px. */
const VIEW = [1000, 1000, 1000 + 1920 / 1.5, 1000 + 1080 / 1.5];
const CSS_AREA = 1920 * 1080;
/** The view of that screen centred on the same spot at another zoom. */
const viewAt = (zoom, w = 1920, h = 1080) => {
  const cx = (VIEW[0] + VIEW[2]) / 2;
  const cy = (VIEW[1] + VIEW[3]) / 2;
  return [cx - w / zoom / 2, cy - h / zoom / 2, cx + w / zoom / 2, cy + h / zoom / 2];
};
/** The world rectangle a grid covers (ground spots of its particles). */
const covered = (kind, grid) => {
  const size = KINDS[kind].cell * grid.block;
  const off = CELL_OFFSET / grid.block;
  return [(grid.bx - off) * size, (grid.by - off) * size, (grid.bx - off + grid.cols) * size, (grid.by - off + grid.rows) * size];
};
/** Particles over the view, counting those the next level of detail is fading out by how much they still show. */
const shown = (kind, grid, view) => {
  const size = KINDS[kind].cell * grid.block;
  return ((LAYERS * (view[2] - view[0]) * (view[3] - view[1])) / (size * size)) * (0.25 + 0.75 * (1 - grid.fade));
};

const sky = (o = {}) => ({ biome: 'temperate', mode: 'full', weather: 'clear', since: 0, until: 5000, tick: 100, sightPct: 100, flash: null, ...o });

test('the badge names the sky and every effect in force', () => {
  assert.deepEqual(weatherInfo(sky()), { label: 'Temperate · Clear', detail: NO_EFFECT });
  assert.match(weatherInfo(sky({ weather: 'rain', sightPct: 90 })).detail, /Sight -10%/);
  assert.match(weatherInfo(sky({ biome: 'desert', weather: 'sandstorm', sightPct: 75 })).detail, /Sight -25%/);
  assert.match(weatherInfo(sky({ biome: 'desert', weather: 'heatwave' })).detail, /overheat/);
  assert.match(weatherInfo(sky({ biome: 'snow' })).detail, /slide/);
  assert.match(weatherInfo(sky({ weather: 'thunderstorm', sightPct: 85 })).detail, /Lightning Rods ground/);
  assert.match(weatherInfo(sky({ mode: 'cosmetic', weather: 'rain' })).detail, /only for show/);
  assert.deepEqual(weatherInfo(sky({ mode: 'off' })), { label: '', detail: '' });
  assert.equal(heatText({ heat: 20 }), '');
  assert.equal(heatText({ heat: 64 }), 'Hot 64%');
  assert.match(heatText({ heat: 100, overheated: true }), /Overheated/);
});

test('weather builds up and dies down; off and clear skies draw nothing', () => {
  const fx = new WeatherFx();
  fx.update(sky({ weather: 'rain', since: 1000, until: 3000, tick: 1000 }), 0);
  assert.equal(fx.intensity(), 0);
  fx.update(sky({ weather: 'rain', since: 1000, until: 3000, tick: 1050 }), 0);
  assert.ok(fx.intensity() > 0.4 && fx.intensity() < 0.6);
  fx.update(sky({ weather: 'rain', since: 1000, until: 3000, tick: 2000 }), 0);
  assert.equal(fx.intensity(), 1);
  assert.equal(fx.uniforms(0).env[1], 1);
  assert.ok(fx.uniforms(0, VIEW, 1.5).env2[2] > 500);
  fx.update(sky({ weather: 'rain', since: 1000, until: 3000, tick: 2975 }), 0);
  assert.ok(fx.intensity() < 0.3, 'ramps down before it ends');
  fx.update(sky({ mode: 'off', weather: 'rain' }), 0);
  assert.deepEqual(fx.uniforms(0).env.slice(1), [0, 0, 0]);
  assert.equal(fx.uniforms(0, VIEW, 1.5).env2[2], 0);
  fx.update(sky({ weather: 'clear' }), 0);
  assert.equal(fx.uniforms(0, VIEW, 1.5).env2[2], 0, 'clear skies draw no particles');
  fx.update(sky({ weather: 'heatwave', biome: 'desert' }), 0);
  assert.equal(fx.uniforms(0, VIEW, 1.5).env2[2], 0, 'nor does a heat wave (only its shimmer)');
});

test('particle budgets are capped and shrink with low quality and reduced motion', () => {
  const storm = sky({ weather: 'thunderstorm', since: 0, until: 9000, tick: 2000 });
  const full = new WeatherFx();
  full.update(storm, 0);
  // Zoomed far out on a big screen: the level of detail and the cap hold.
  for (const zoom of [0.25, 0.5, 0.75]) assert.ok(full.uniforms(0, viewAt(zoom, 3840, 2160), zoom, 3840 * 2160).env2[2] <= MAX_PARTICLES);
  const low = new WeatherFx({ lowQuality: true });
  low.update(storm, 0);
  const calm = new WeatherFx({ reducedMotion: true });
  calm.update(storm, 0);
  const far = viewAt(0.5);
  for (const view of [VIEW, far]) {
    const half = shown('thunderstorm', weatherGrid('thunderstorm', view, CSS_AREA, 0.5), view);
    const all = shown('thunderstorm', weatherGrid('thunderstorm', view, CSS_AREA), view);
    assert.ok(half < all * 0.6, `low quality shows about half as many: ${half} of ${all}`);
  }
  assert.ok(low.uniforms(0, far, 0.5).env2[2] <= full.uniforms(0, far, 0.5).env2[2]);
  assert.equal(low.uniforms(0, VIEW, 1.5).env2[1], 1, 'it thins the grid, not each cell');
  assert.ok(calm.uniforms(0, VIEW, 1.5).env2[1] < 1, 'reduced motion shows fewer particles');
  assert.equal(calm.uniforms(0, VIEW, 1.5).env2[3], 0, 'shaders slow down for reduced motion');
  assert.equal(full.uniforms(0, VIEW, 1.5).env2[3], 1);
  // Settings change while the game runs.
  full.reducedMotion = true;
  assert.equal(full.uniforms(0, VIEW, 1.5).env2[1], calm.uniforms(0, VIEW, 1.5).env2[1]);
  assert.equal(full.uniforms(0, VIEW, 1.5).env2[3], 0);
});

test('the particles live on a grid of world cells that covers the view and where they fall from', () => {
  for (const kind of Object.keys(KINDS)) {
    const k = KINDS[kind];
    for (const zoom of [0.5, 1, 1.5, 3, 4]) {
      const view = viewAt(zoom);
      const grid = weatherGrid(kind, view, CSS_AREA);
      const [x0, y0, x1, y1] = covered(kind, grid);
      const drift = k.wind * Math.max(...k.periods);
      assert.ok(x0 <= view[0] && y0 <= view[1], `${kind} at ${zoom}: the grid starts left of and above the view`);
      assert.ok(x1 >= view[2] + drift && y1 >= view[3] + k.height, `${kind} at ${zoom}: it reaches as far as the wind and the fall carry`);
      assert.equal(grid.count, grid.cols * grid.rows * LAYERS);
      assert.ok(grid.bx >= 0 && grid.by >= 0, 'block indices stay positive (CELL_OFFSET)');
      assert.ok(Number.isInteger(Math.log2(grid.block)), 'blocks are 1, 2, 4, ... cells');
    }
  }
  // Panning moves the grid in whole cells: a block keeps its world spot, so the particles stay with the ground.
  const a = weatherGrid('rain', VIEW, CSS_AREA);
  const pan = KINDS.rain.cell * 3;
  const b = weatherGrid('rain', [VIEW[0] + pan, VIEW[1] - pan, VIEW[2] + pan, VIEW[3] - pan], CSS_AREA);
  assert.deepEqual([b.bx - a.bx, b.by - a.by, b.cols, b.rows, b.block], [3, -3, a.cols, a.rows, a.block]);
  const c = weatherGrid('rain', [VIEW[0] + 5, VIEW[1] + 5, VIEW[2] + 5, VIEW[3] + 5], CSS_AREA);
  assert.deepEqual(covered('rain', c).slice(0, 2), covered('rain', a).slice(0, 2), 'a small pan keeps the same cells');
  assert.deepEqual(weatherGrid('clear', VIEW, CSS_AREA).count, 0);
  assert.deepEqual(weatherGrid('rain', null, CSS_AREA).count, 0);
});

test('zooming out drops particles smoothly: no level of detail at the default zoom, and about as many on screen however far out', () => {
  for (const kind of Object.keys(KINDS)) {
    const home = weatherGrid(kind, VIEW, CSS_AREA);
    assert.deepEqual([home.block, home.fade], [1, 0], `${kind}: every cell at the default zoom`);
    let before = null;
    let block = 1;
    let peak = 0;
    for (let zoom = 4; zoom >= 0.25; zoom *= 0.97) {
      const view = viewAt(zoom);
      const grid = weatherGrid(kind, view, CSS_AREA);
      assert.ok(grid.block >= block, 'zooming out never brings back a finer level');
      block = grid.block;
      assert.ok(grid.fade >= 0 && grid.fade < 1);
      const now = shown(kind, grid, view);
      peak = Math.max(peak, now);
      // One zoom step (3%) changes what shows by little more than the view's own growth (6%): no pops.
      if (before !== null) assert.ok(now < before * 1.15 && now > before * 0.85, `${kind} at ${zoom.toFixed(2)}: ${before} -> ${now}`);
      before = now;
    }
    assert.ok(block >= 4, `${kind}: zoomed far out the grid thins out`);
    assert.ok(peak < 4000, `${kind}: at most ${peak} particles show`);
  }
});

test('particles keep their world size between the zoom limits and stop growing or shrinking past them', () => {
  assert.equal(particleScale(1.5), 1);
  assert.equal(particleScale(SIZE_ZOOM_MIN), 1);
  assert.equal(particleScale(SIZE_ZOOM_MAX), 1);
  assert.ok(Math.abs(particleScale(4) * 4 - SIZE_ZOOM_MAX) < 1e-9, 'close in, no bigger than at SIZE_ZOOM_MAX');
  assert.ok(Math.abs(particleScale(0.25) * 0.25 - SIZE_ZOOM_MIN) < 1e-9, 'far out, no smaller than at SIZE_ZOOM_MIN');
  // The size on screen never goes down as the camera zooms in.
  let last = 0;
  for (let zoom = 0.2; zoom <= 6; zoom += 0.05) {
    const onScreen = zoom * particleScale(zoom);
    assert.ok(onScreen >= last - 1e-9);
    last = onScreen;
  }
  assert.equal(particleScale(0), 1);
  assert.equal(particleScale(NaN), 1);
  const fx = new WeatherFx();
  fx.update(sky({ weather: 'snowfall', biome: 'snow', since: 0, until: 9000, tick: 2000 }), 0);
  assert.equal(fx.uniforms(0, viewAt(4), 4).wcell[3], particleScale(4));
});

test('the weather clock runs smoothly with the game, stands still with it and never runs backwards', () => {
  const fx = new WeatherFx();
  fx.update(sky({ weather: 'rain', since: 0, until: 90000, tick: 2000 }), 0);
  const dt = 1 / 60;
  let real = 0;
  fx.advance(10, dt);
  let last = fx.clock;
  // The simulated time steps with ticks and a jittery interpolation: the clock still moves the same every frame.
  for (let i = 0; i < 600; i++) {
    real += dt;
    const sim = 10 + Math.floor((real + 0.02 * Math.sin(i * 1.7)) / 0.04) * 0.04;
    fx.advance(sim, dt);
    const step = fx.clock - last;
    assert.ok(step >= 0, 'never backwards');
    if (i > 120) assert.ok(step > dt * 0.8 && step < dt * 1.2, `frame ${i}: ${step}`);
    last = fx.clock;
  }
  assert.ok(Math.abs(fx.clock - (10 + real - CLOCK_LAG)) < 0.06, 'and keeps up with the game, its lag behind');
  // Paused: it runs on into its lag and stops exactly at the simulated time, never past it.
  const paused = 10 + Math.floor(real / 0.04) * 0.04;
  for (let i = 0; i < 30; i++) {
    fx.advance(paused, dt);
    assert.ok(fx.clock <= paused, 'no overshoot');
  }
  assert.equal(fx.clock, paused, 'stopped at the simulated time');
  for (let i = 0; i < 60; i++) fx.advance(paused, dt);
  assert.equal(fx.clock, paused, 'and stands still while the game does');
  // Going on: the particles move again on the very next frame, never much slower than the game.
  let sim = paused;
  last = fx.clock;
  for (let i = 0; i < 60; i++) {
    sim += dt;
    fx.advance(sim, dt);
    const step = fx.clock - last;
    assert.ok(step > dt * 0.75 && step < dt * 1.25, `frame ${i} after the pause: ${step / dt}`);
    last = fx.clock;
  }
  // A replay seeking or catching up jumps.
  fx.advance(500, dt);
  assert.equal(fx.clock, 500);
  // Phases follow the clock, slower for reduced motion, and a change of the setting does not jump them.
  const p0 = fx.phases[0];
  fx.advance(500.1, 0.1);
  const moved = fx.clock - 500;
  const expect = (p0 + moved / KINDS.rain.periods[0]) % 1;
  assert.ok(Math.abs(fx.phases[0] - expect) < 1e-9);
  fx.reducedMotion = true;
  const p1 = fx.phases[0];
  fx.advance(fx.clock + 0.05, 0.05);
  const step = (fx.phases[0] - p1 + 1) % 1;
  assert.ok(Math.abs(step - (0.05 * REDUCED_SPEED) / KINDS.rain.periods[0]) < 0.01, `reduced motion falls slower: ${step}`);
  assert.ok(fx.phases.every((p) => p >= 0 && p < 1) && fx.sway >= 0 && fx.sway < 1, 'phases wrap, so no large time reaches the GPU');
  assert.doesNotThrow(() => fx.advance(NaN, dt));
});

test('the weather uniforms reach the shaders in the layout of shaders/common.wgsl', () => {
  const common = readFileSync(fileURLToPath(new URL('../shaders/common.wgsl', import.meta.url)), 'utf8');
  const body = /struct Globals \{([\s\S]*?)\n\};/.exec(common)[1];
  // WGSL uniform layout: vec4 and arrays of vec4 align to 16, vec2 to 8, f32 to 4.
  const sizes = { f32: [4, 4], vec2f: [8, 8], vec4f: [16, 16] };
  let offset = 0;
  const at = {};
  for (const m of body.matchAll(/^\s*(\w+): ([\w<>, ]+),/gm)) {
    const arr = /array<(\w+), (\d+)>/.exec(m[2]);
    const [size, align] = arr ? [sizes[arr[1]][0] * Number(arr[2]), 16] : sizes[m[2]];
    offset = Math.ceil(offset / align) * align;
    at[m[1]] = offset / 4;
    offset += size;
  }
  assert.equal(Math.ceil(offset / 16) * 16, GLOBALS_BYTES, 'the buffer is as big as the struct');
  assert.equal(at.wgrid, WEATHER_OFFSET);
  assert.deepEqual([at.wcell, at.wphase, at.wfall], [WEATHER_OFFSET + 4, WEATHER_OFFSET + 8, WEATHER_OFFSET + 12]);
  const fx = new WeatherFx();
  fx.update(sky({ weather: 'rain', since: 0, until: 9000, tick: 2000 }), 0);
  fx.advance(3, 0);
  fx.advance(3.2, 0.2);
  const u = fx.uniforms(0, VIEW, 1.5);
  const g = packGlobals({ width: 2880, height: 1620, camera: { x: VIEW[0], y: VIEW[1] }, zoom: 2.25, time: 3.2, mapW: 64, mapH: 64, fx: u });
  assert.equal(g.length * 4, GLOBALS_BYTES);
  assert.deepEqual([...g.slice(0, 6)], [2880, 1620, VIEW[0], VIEW[1], 2.25, Math.fround(3.2)], 'view, camera and zoom');
  const vec = (name) => [...g.slice(at[name], at[name] + 4)];
  const f32 = (a) => a.map((x) => Math.fround(x));
  assert.deepEqual(vec('env'), f32(u.env));
  assert.deepEqual(vec('env2'), f32(u.env2));
  assert.deepEqual(vec('wgrid'), f32(u.wgrid));
  assert.deepEqual(vec('wcell'), f32(u.wcell));
  assert.deepEqual(vec('wphase'), f32(u.wphase));
  assert.deepEqual(vec('wfall'), f32(u.wfall));
  assert.deepEqual(u.wfall, [KINDS.rain.height, ...KINDS.rain.periods.map((p) => KINDS.rain.wind * p)]);
  assert.ok(u.wgrid.every(Number.isInteger), 'block indices are whole numbers, exact as f32');
  // Clear skies: the defaults.
  const clear = packGlobals({ width: 1, height: 1, camera: { x: 0, y: 0 }, zoom: 1, time: 0, mapW: 1, mapH: 1 });
  // wgrid none, wcell [cell 1, block 1, no fade, size 1], wphase and wfall zero, and no particles (env2.z).
  assert.deepEqual([...clear.slice(WEATHER_OFFSET, WEATHER_OFFSET + 16)], [0, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...clear.slice(at.env2, at.env2 + 4)], [0, 0, 0, 1]);
});

test('the particle shader works in the world from the grid and the phases, never from the screen or the raw clock', () => {
  const src = readFileSync(fileURLToPath(new URL('../shaders/weather.wgsl', import.meta.url)), 'utf8');
  const constant = (name) => Number(new RegExp(`const ${name}: \\w+ = ([\\d.]+)u?;`).exec(src)[1]);
  assert.equal(constant('CELL_OFFSET'), CELL_OFFSET);
  assert.equal(constant('LAYERS'), LAYERS);
  for (const name of ['g.wgrid', 'g.wcell', 'g.wphase', 'g.wfall', 'world_to_clip(']) assert.ok(src.includes(name), name);
  assert.ok(!src.includes('g.time'), 'the fall comes from the phases (WeatherFx.advance), not from a large time');
  assert.ok(!/fract\([^)]*view/.test(src), 'no field that wraps around the view');
});

test('lightning flashes once per strike and thunder follows from where it struck, later far away', () => {
  const heard = [];
  const fx = new WeatherFx({ onThunder: (strike) => heard.push(strike) });
  const storm = (tick, flash) => sky({ weather: 'thunderstorm', since: 0, until: 9000, tick, flash });
  fx.update(storm(500, [400, 0, 0]), 10); // already there when we joined: not replayed
  assert.equal(fx.flash(10), 0);
  fx.update(storm(700, [690, 100, 100]), 20, { x: 100, y: 100 });
  assert.ok(fx.flash(20.01) > 0.7, "bright first flash");
  assert.ok(fx.flash(20.2) > 0.4, "and a second one");
  assert.equal(fx.flash(21), 0);
  fx.update(storm(701, [690, 100, 100]), 20.2);
  assert.equal(heard.length, 0, 'thunder waits a moment');
  fx.update(storm(720, [690, 100, 100]), 21);
  assert.deepEqual(heard, [{ x: 100, y: 100, kind: 0 }], 'a 3 element flash: a ground strike');
  // Far away the sound takes longer (the sound system makes it softer and darker: audio-thunder.test.mjs).
  fx.update(storm(900, [880, 6000, 6000, 2]), 30, { x: 0, y: 0 });
  fx.update(storm(950, [880, 6000, 6000, 2]), 32);
  assert.equal(heard.length, 1, 'still on its way');
  fx.update(storm(990, [880, 6000, 6000, 2]), 33);
  assert.deepEqual(heard[1], { x: 6000, y: 6000, kind: 2 }, 'the strike kind is passed on');
  // Reduced motion: one soft pulse, never a bright flicker.
  const calm = new WeatherFx({ reducedMotion: true });
  calm.update(storm(700, [600, 0, 0]), 0);
  calm.update(storm(800, [790, 0, 0]), 1);
  let peak = 0;
  for (let t = 1; t < 2; t += 0.01) peak = Math.max(peak, calm.flash(t));
  assert.ok(peak > 0 && peak <= 0.2, `soft flash ${peak}`);
});

test('no lightning or thunder while a thunderstorm dies down (engine STORM_CALM_SECONDS)', () => {
  const weather = readFileSync(fileURLToPath(new URL('../../../engine/src/weather.rs', import.meta.url)), 'utf8');
  const constant = (name) => Number(new RegExp(`pub const ${name}: u32 = (\\d+);`).exec(weather)[1]);
  assert.equal(constant('RAMP_SECONDS'), RAMP, 'the client ramps as the engine says');
  const calm = constant('STORM_CALM_SECONDS');
  assert.ok(calm >= RAMP + THUNDER_DELAY + THUNDER_TRAVEL, `calm ${calm} s covers the die-down and the thunder`);
  // The last possible strike, as far away as thunder gets: flash and thunder both come in full rain.
  const until = 9000;
  const last = until - calm * 25 - 1;
  const heard = [];
  const fx = new WeatherFx({ onThunder: (strike) => heard.push(strike) });
  const storm = (tick, flash) => sky({ weather: 'thunderstorm', since: 0, until, tick, flash });
  fx.update(storm(last - 200, [last - 300, 0, 0, 0]), -10); // an earlier strike, seen when joining
  fx.update(storm(last, [last, 1e6, 1e6, 0]), 0, { x: 0, y: 0 });
  assert.equal(fx.intensity(), 1);
  assert.ok(fx.flash(0.01) > 0.7);
  const delay = THUNDER_DELAY + THUNDER_TRAVEL;
  fx.update(storm(last + Math.ceil(delay * 25), [last, 1e6, 1e6, 0]), delay);
  assert.equal(heard.length, 1, 'the thunder came');
  assert.equal(fx.intensity(), 1, 'before the rain started to stop');
});

test('the browser\'s reduced motion is followed while the game runs, until the watch stops', () => {
  const listeners = new Set();
  const query = { matches: false, addEventListener: (t, fn) => listeners.add(fn), removeEventListener: (t, fn) => listeners.delete(fn) };
  const win = { matchMedia: (q) => (q === '(prefers-reduced-motion: reduce)' ? query : null) };
  const fx = new WeatherFx();
  let setting = 'auto';
  const off = fx.watchReducedMotion(win, (prefers) => setting === 'on' || (setting !== 'off' && prefers));
  assert.equal(fx.reducedMotion, false);
  for (const fn of listeners) fn({ matches: true });
  assert.equal(fx.reducedMotion, true, 'the OS setting changed: at once');
  setting = 'off';
  for (const fn of listeners) fn({ matches: true });
  assert.equal(fx.reducedMotion, false, 'the game setting Off wins');
  off();
  assert.equal(listeners.size, 0, 'teardown stops listening');
  assert.doesNotThrow(() => new WeatherFx().watchReducedMotion({})());
  assert.doesNotThrow(() => new WeatherFx().watchReducedMotion({ matchMedia() { throw new Error('no'); } })());
});
