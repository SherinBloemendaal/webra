// A paused game stands still: the battlefield's presentation runs on the
// simulation clock (js/simclock.js), so radar pings, lightning and thunder
// wait with the game while the page clock runs on (user report: sounds and
// events while paused). The director and the announcer are covered in
// tests/audio.test.mjs, the simulation itself in tests/sim.test.mjs.
//   node --test apps/game/tests/pause.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimClock } from '../js/simclock.js';
import { RadarPings, FROM_RADIUS, PING_TICKS, STRUCTURE_INTERVAL_MS } from '../js/radarpings.js';
import { WeatherFx } from '../js/weather-fx.js';
import { EV } from '../js/audio/director.js';

const TICK_MS = 40;

test('the simulation clock follows ticks and interpolation, and stands still with the game', () => {
  const clock = new SimClock(TICK_MS);
  assert.equal(clock.update(0, 0), 0);
  assert.equal(clock.update(10, 0.5), 420);
  assert.equal(clock.seconds, 0.42);
  // Paused: the same tick frame after frame (a paused local game draws alpha 1).
  for (let i = 0; i < 100; i++) clock.update(10, 1);
  assert.equal(clock.ms, 440);
  // Going on: alpha starts below 1 again, the clock does not run backwards.
  assert.equal(clock.update(10, 0.2), 440);
  assert.equal(clock.update(11, 0.2), 448);
  // A replay seeking back sets it back.
  assert.equal(clock.update(3, 0), 120);
  assert.equal(clock.update(4, Number.NaN), 160, 'no interpolation: the tick itself');
  // Faster game speed: shorter ticks, the same game seconds per tick count.
  assert.equal(new SimClock(20).update(50, 0), 1000);
});

test('radar pings stand still while the game is paused and go on after it', () => {
  const pings = new RadarPings({ visible: () => true, color: () => [1, 1, 1], pxPerWorld: 1, tickMs: TICK_MS });
  const clock = new SimClock(TICK_MS);
  let wall = 5000;
  pings.onEvents([EV.BUILDING_DAMAGED, 1, 100, 100, 0, 0], clock.update(100, 0), wall);
  assert.equal(pings.active(clock.ms)[0].radius, FROM_RADIUS);
  clock.update(110, 0);
  const before = pings.active(clock.ms)[0];
  // Ten minutes of pause: the page clock runs, the simulation clock does not.
  for (let i = 0; i < 600; i++) {
    wall += 1000;
    clock.update(110, 1);
  }
  const during = pings.active(clock.ms);
  assert.equal(during.length, 1, 'the ping did not run out during the pause');
  assert.ok(Math.abs(during[0].radius - before.radius) <= 4 && Math.abs(during[0].angle - before.angle) < 0.2, 'nor did it shrink or turn on (beyond the frame drawn at alpha 1)');
  // After the pause it runs out PING_TICKS after it started.
  clock.update(100 + PING_TICKS - 1, 0);
  assert.equal(pings.active(clock.ms).length, 1);
  clock.update(100 + PING_TICKS, 0);
  assert.equal(pings.active(clock.ms).length, 0);
  // The damage ping interval is OpenRA DamageNotifier's: the page clock (Game.RunTime).
  pings.onEvents([EV.BUILDING_DAMAGED, 1, 300, 300, 0, 0], clock.ms, wall);
  assert.deepEqual(pings.last(), { x: 300, y: 300 }, 'more than 30 seconds of page time since the last one');
  pings.onEvents([EV.BUILDING_DAMAGED, 1, 500, 500, 0, 0], clock.ms + 60000, wall + STRUCTURE_INTERVAL_MS - 1);
  assert.deepEqual(pings.last(), { x: 300, y: 300 });
});

test('no thunder while the game is paused: it follows the lightning in game time', () => {
  const heard = [];
  const fx = new WeatherFx({ onThunder: (g) => heard.push(g) });
  const clock = new SimClock(TICK_MS);
  const storm = (tick, flash) => ({ biome: 'temperate', mode: 'full', weather: 'thunderstorm', since: 0, until: 9000, tick, sightPct: 100, flash });
  fx.update(storm(500, [400, 0, 0]), clock.update(500, 0) / 1000); // an old strike: not replayed
  // A strike, then the player pauses before its thunder (0.3 s and more later).
  fx.update(storm(501, [501, 0, 0]), clock.update(501, 0) / 1000, { x: 0, y: 0 });
  const flashAtStrike = fx.flash(clock.seconds);
  assert.ok(flashAtStrike > 0);
  for (let i = 0; i < 1000; i++) fx.update(storm(501, [501, 0, 0]), clock.update(501, 1) / 1000, { x: 0, y: 0 });
  assert.equal(heard.length, 0, 'the thunder waits for the game');
  assert.ok(fx.flash(clock.seconds) > 0, 'the flash stands still too');
  // Going on: the thunder comes 0.3 s of game time after the strike.
  fx.update(storm(508, [501, 0, 0]), clock.update(508, 0) / 1000, { x: 0, y: 0 });
  assert.equal(heard.length, 0);
  fx.update(storm(510, [501, 0, 0]), clock.update(510, 0) / 1000, { x: 0, y: 0 });
  assert.equal(heard.length, 1);
});
