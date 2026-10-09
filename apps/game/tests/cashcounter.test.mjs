// The sidebar credits counter and its cash tick sounds (js/cashcounter.js),
// against OpenRA's IngameCashCounterLogic and PlayerResources.
//   node --test apps/game/tests/cashcounter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CashCounter, CASH_TICK_MS, CATCH_UP_MS, DISPLAY_DELTA_PER_TICK } from '../js/cashcounter.js';
import { CASH_TICK_SOUNDS, CASH_TICK_GAIN, allOriginalNames } from '../js/audio/catalog.js';
import { RECIPES } from '../js/audio/synth.js';
import { AudioSystem } from '../js/audio/index.js';
import { createRegistry } from '../js/registry.js';
import { installDom, uninstallDom, memoryStorage } from './dom-fixtures.mjs';

test('the counter moves 7% of the gap per UI tick, at least 37 credits, and never overshoots', () => {
  const c = new CashCounter(1000);
  assert.ok(c.settled);
  assert.equal(c.tick(), null, 'nothing to count');
  c.target = 11000;
  assert.equal(c.tick(), 'up');
  assert.equal(c.shown, 1000 + 700, '7% of 10000');
  c.target = c.shown + 50;
  c.tick();
  assert.equal(c.target - c.shown, 50 - DISPLAY_DELTA_PER_TICK, 'at least 37');
  assert.equal(c.tick(), 'up');
  assert.ok(c.settled, 'the last step stops on the value');
  assert.equal(c.tick(), null);
});

test('counting up ticks on every UI tick, counting down on every other one (OpenRA nextCashTickTime)', () => {
  const up = new CashCounter(0);
  up.target = 5000;
  const ups = Array.from({ length: 6 }, () => up.tick());
  assert.deepEqual(ups, ['up', 'up', 'up', 'up', 'up', 'up']);
  const down = new CashCounter(5000);
  down.target = 0;
  const downs = Array.from({ length: 7 }, () => down.tick());
  assert.deepEqual(downs, ['down', null, 'down', null, 'down', null, 'down']);
});

test('frames run the UI ticks due and carry the rest; a long pause is not caught up', () => {
  const c = new CashCounter(0);
  c.target = 100000;
  let r = c.advance(CASH_TICK_MS - 1);
  assert.deepEqual([r.ticks, r.up, r.rest], [0, false, CASH_TICK_MS - 1]);
  r = c.advance(r.rest + 1);
  assert.deepEqual([r.ticks, r.up, r.rest], [1, true, 0]);
  r = c.advance(10 * 1000);
  assert.equal(r.ticks, Math.floor(CATCH_UP_MS / CASH_TICK_MS), 'a hidden tab does not count ten seconds at once');
  assert.equal(r.rest, 0);
});

test('cash tick sounds: OpenRA notifications, our own clicks, gain and the Cash ticks setting', () => {
  assert.deepEqual(CASH_TICK_SOUNDS.up.originals, ['cashup1.aud']);
  assert.deepEqual(CASH_TICK_SOUNDS.down.originals, ['cashdn1.aud']);
  for (const s of Object.values(CASH_TICK_SOUNDS)) assert.ok(RECIPES[s.synth], `${s.synth} is synthesized when the originals are missing`);
  const wanted = allOriginalNames();
  assert.ok(wanted.includes('cashup1.aud') && wanted.includes('cashdn1.aud'), 'the installer picks them up');
  assert.equal(CASH_TICK_GAIN, 0.33);

  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  const played = [];
  // OpenRA notifications CashTickUp and CashTickDown (VolumeModifier 0.33, InterruptType Overlap).
  audio.bank.resolveAll = (sound) => [{ buffer: sound.synth, rate: 1 }];
  audio.mixer.play = (buffer, opts) => (played.push([buffer, opts.gain]), { stop() {}, ended: Promise.resolve() });
  audio.cashTick('up');
  audio.cashTick('down');
  audio.cashTick('sideways');
  assert.deepEqual(played, [['cash_up', 0.33], ['cash_down', 0.33]]);
  audio.prefs.set({ cashTicks: false });
  audio.cashTick('up');
  assert.equal(played.length, 2, 'Cash ticks off: silent');
});

test('the sidebar counter animates with the UI ticks and reports its tick sounds', async () => {
  const doc = installDom();
  const frames = [];
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  try {
    const { Sidebar } = await import('../js/sidebar.js');
    const ticks = [];
    const fake = {
      credits: null,
      creditsFrame: 0,
      creditsEl: doc.createElement('span'),
      oreEl: doc.createElement('span'),
      siloFill: { style: { vars: new Map(), getPropertyValue(k) { return this.vars.get(k) ?? ''; }, setProperty(k, v) { this.vars.set(k, v); } } },
      siloEl: doc.createElement('div'),
      moneyEl: doc.createElement('div'),
      callbacks: { onCashTick: (d) => ticks.push(d) },
      tickCredits: Sidebar.prototype.tickCredits,
    };
    const update = (funds) => Sidebar.prototype.updateCredits.call(fake, { funds, resources: 0, storage: 0 });
    update(1000);
    assert.equal(fake.creditsEl.textContent, '1000', 'the first value shows at once');
    assert.equal(frames.length, 0);
    update(500);
    assert.equal(frames.length, 1, 'counting starts');
    const t0 = fake.creditsLast;
    frames.shift()(t0 + CASH_TICK_MS);
    assert.equal(fake.creditsEl.textContent, String(1000 - DISPLAY_DELTA_PER_TICK));
    assert.ok(fake.creditsEl.classList.contains('down'));
    assert.deepEqual(ticks, ['down']);
    let now = t0 + CASH_TICK_MS;
    while (frames.length) frames.shift()((now += CASH_TICK_MS));
    assert.equal(fake.creditsEl.textContent, '500');
    assert.equal(fake.creditsEl.classList.contains('down'), false);
    assert.ok(ticks.length > 1 && ticks.every((d) => d === 'down'));
    const downs = ticks.length;
    update(2000);
    while (frames.length) frames.shift()((now += CASH_TICK_MS));
    assert.equal(fake.creditsEl.textContent, '2000');
    assert.ok(ticks.slice(downs).every((d) => d === 'up') && ticks.length > downs);
  } finally {
    globalThis.requestAnimationFrame = raf;
    uninstallDom();
  }
});
