// Weather on screen (js/weather-fx.js): HUD texts, ramps, lightning and the
// thunder hook, particle budgets and prefers-reduced-motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PARTICLES, NO_EFFECT, WeatherFx, heatText, weatherInfo } from '../js/weather-fx.js';

const sky = (o = {}) => ({ biome: 'temperate', mode: 'full', weather: 'clear', since: 0, until: 5000, tick: 100, sightPct: 100, flash: null, ...o });

test('the badge names the sky and every effect in force', () => {
  assert.deepEqual(weatherInfo(sky()), { label: 'Temperate · Clear', detail: NO_EFFECT });
  assert.match(weatherInfo(sky({ weather: 'rain', sightPct: 90 })).detail, /Sight -10%/);
  assert.match(weatherInfo(sky({ biome: 'desert', weather: 'sandstorm', sightPct: 75 })).detail, /Sight -25%/);
  assert.match(weatherInfo(sky({ biome: 'desert', weather: 'heatwave' })).detail, /overheat/);
  assert.match(weatherInfo(sky({ biome: 'snow' })).detail, /slide/);
  assert.match(weatherInfo(sky({ weather: 'thunderstorm', sightPct: 85 })).detail, /harmless/);
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
  assert.ok(fx.uniforms(0, 1920, 1080).env2[2] > 500);
  fx.update(sky({ weather: 'rain', since: 1000, until: 3000, tick: 2975 }), 0);
  assert.ok(fx.intensity() < 0.3, 'ramps down before it ends');
  fx.update(sky({ mode: 'off', weather: 'rain' }), 0);
  assert.deepEqual(fx.uniforms(0).env.slice(1), [0, 0, 0]);
  assert.equal(fx.uniforms(0).env2[2], 0);
});

test('particle budgets are capped and shrink with low quality and reduced motion', () => {
  const storm = sky({ weather: 'thunderstorm', since: 0, until: 9000, tick: 2000 });
  const full = new WeatherFx();
  full.update(storm, 0);
  assert.ok(full.particles(3840, 2160) <= MAX_PARTICLES);
  const low = new WeatherFx({ lowQuality: true });
  low.update(storm, 0);
  const calm = new WeatherFx({ reducedMotion: true });
  calm.update(storm, 0);
  assert.ok(low.particles(1920, 1080) < full.particles(1920, 1080) / 2);
  assert.ok(calm.particles(1920, 1080) < full.particles(1920, 1080));
  assert.equal(calm.uniforms(0).env2[3], 0, 'shaders slow down for reduced motion');
});

test('lightning flashes once per strike and thunder follows, quieter far away', () => {
  const heard = [];
  const fx = new WeatherFx({ onThunder: (g) => heard.push(g) });
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
  assert.equal(heard.length, 1);
  assert.ok(heard[0] > 0.9, 'close strike, loud thunder');
  fx.update(storm(900, [880, 6000, 6000]), 30, { x: 0, y: 0 });
  fx.update(storm(990, [880, 6000, 6000]), 34);
  assert.equal(heard.length, 2);
  assert.ok(heard[1] < 0.5, 'far strike, soft thunder');
  // Reduced motion: one soft pulse, never a bright flicker.
  const calm = new WeatherFx({ reducedMotion: true });
  calm.update(storm(700, [600, 0, 0]), 0);
  calm.update(storm(800, [790, 0, 0]), 1);
  let peak = 0;
  for (let t = 1; t < 2; t += 0.01) peak = Math.max(peak, calm.flash(t));
  assert.ok(peak > 0 && peak <= 0.2, `soft flash ${peak}`);
});
