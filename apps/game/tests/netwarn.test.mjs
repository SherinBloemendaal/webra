// Connection quality in an online game's HUD (js/netwarn.js): the signal
// bars, the warning about the own connection and the "Waiting for X" panel,
// fed like NetQuality (js/netquality.js) feeds them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom } from './dom-fixtures.mjs';
import {
  BAR_COUNT,
  NetWarn,
  OPEN_NETWORK_EVENT,
  SELF_WARN_AFTER_MS,
  SelfWarning,
  selfWarningText,
  signalState,
  signalTip,
  WAIT_PANEL_AFTER_MS,
  WaitWatch,
  waitRows,
  waitText,
} from '../js/netwarn.js';
import { DROP_AFTER_MS } from '../js/protocol.js';

// What NetQuality says for a measurement (netquality.js netQuality and netBars:
// poor above 150 ms or more than 2% late, good below 80 ms with jitter up to
// 20 ms and no late pings, fair otherwise; 4 good, 3 fair, 1 poor, 0 unknown).
const GOOD = { rtt: 34, jitter: 4, late: 0, quality: 'good', bars: 4 };
const FAIR = { rtt: 118, jitter: 25, late: 0, quality: 'fair', bars: 3 };
const POOR = { rtt: 320, jitter: 60, late: 6, quality: 'poor', bars: 1 };
const NONE = { rtt: null, jitter: null, late: null, quality: null, bars: 0 };

test('signal bars: the lit bars, the level and its word follow the measured quality', () => {
  assert.deepEqual(signalState(GOOD), { bars: 4, level: 'good', word: 'good', label: 'Your connection: good, 34 ms' });
  assert.deepEqual(signalState(FAIR), { bars: 3, level: 'fair', word: 'fair', label: 'Your connection: fair, 118 ms' });
  assert.deepEqual(signalState(POOR), { bars: 1, level: 'poor', word: 'poor', label: 'Your connection: poor, 320 ms' });
  assert.deepEqual(signalState(NONE), { bars: 0, level: 'none', word: 'measuring', label: 'Your connection: measuring' });
  assert.equal(signalState(null).level, 'none', 'before the first measurement');
  assert.equal(signalState({ quality: 'good', bars: 9, rtt: 10 }).bars, BAR_COUNT, 'never more bars than drawn');
  // The tooltip: ping, jitter and late pings ("loss"), and what a click does.
  const tip = signalTip(POOR);
  assert.equal(tip.title, 'Your connection: poor');
  assert.match(tip.desc, /^Ping: 320 ms\nJitter: 60 ms\nLoss: 6% /);
  assert.match(tip.notes[0].text, /Network tab/);
  assert.match(signalTip(NONE).desc, /Ping: measuring/);
  assert.equal(selfWarningText({ rtt: 320, late: 6.04 }), '320 ms · 6% loss. Your orders may arrive late and others may wait for you.');
});

test('own warning: after 10 s of poor without a break; hidden, it returns only after a recovery and 10 s poor again', () => {
  const w = new SelfWarning();
  assert.equal(SELF_WARN_AFTER_MS, 10_000);
  assert.equal(w.update('poor', 0), false);
  assert.equal(w.update('poor', 9_999), false);
  assert.equal(w.update('fair', 9_999.5), false, 'a break starts the count over');
  assert.equal(w.update('poor', 10_000), false);
  assert.equal(w.update('poor', 19_999), false);
  assert.equal(w.update('poor', 20_000), true, '10 s poor');
  // Recovering hides it by itself.
  assert.equal(w.update('good', 21_000), false);
  w.update('poor', 22_000);
  assert.equal(w.update('poor', 32_000), true);
  // Hidden by the player: it stays away while the connection stays poor.
  w.dismiss();
  assert.equal(w.update('poor', 33_000), false);
  assert.equal(w.update('poor', 90_000), false, 'still the same poor stretch');
  // Recovery, then poor again: after another 10 s it comes back.
  assert.equal(w.update('good', 91_000), false);
  assert.equal(w.update('poor', 92_000), false);
  assert.equal(w.update('poor', 101_999), false);
  assert.equal(w.update('poor', 102_000), true);
  // No measurement counts as no warning; the setting off hides it.
  assert.equal(w.update('poor', 103_000, false), false, 'net.warnSelf off');
  assert.equal(w.update('poor', 103_100, true), true, 'on again: the stretch kept counting');
  assert.equal(w.update(null, 104_000), false);
  // A dismiss while nothing shows does nothing.
  const v = new SelfWarning({ afterMs: 100 });
  v.dismiss();
  v.update('poor', 0);
  assert.equal(v.update('poor', 100), true);
});

test('waiting: a new wait gives one chat line, the panel after 2 s, a countdown to the drop', () => {
  const w = new WaitWatch();
  assert.equal(WAIT_PANEL_AFTER_MS, 2000);
  assert.equal(w.view(0), null);
  // The server says: client 7 holds the game for 1.2 s, dropped in 8.8 s.
  assert.equal(w.set({ client: 7, heldMs: 1200, dropInMs: 8800, at: 1000 }, 1000), 7, 'a new wait: the chat line');
  let v = w.view(1000);
  assert.deepEqual(v, { client: 7, panel: false, heldMs: 1200, dropLeftMs: 8800, fraction: 8800 / DROP_AFTER_MS });
  // The next messages of the same wait are no new line.
  assert.equal(w.set({ client: 7, heldMs: 2200, dropInMs: 7800, at: 2000 }, 2000), null);
  v = w.view(2999);
  assert.equal(v.panel, false, 'not before 2 s');
  v = w.view(3000);
  assert.equal(v.panel, true, '2 s after the wait began');
  assert.equal(v.heldMs, 3200, 'held: the server value plus the time since');
  assert.equal(v.dropLeftMs, 6800);
  assert.equal(Math.ceil(v.dropLeftMs / 1000), 7);
  // The countdown never goes below 0.
  v = w.view(20_000);
  assert.equal(v.dropLeftMs, 0);
  assert.equal(v.fraction, 0);
  // Another player: a new line, the panel waits again.
  assert.equal(w.set({ client: 9, heldMs: 1100, dropInMs: 9000, at: 21_000 }, 21_000), 9);
  assert.equal(w.view(22_000).panel, false);
  // The game runs again.
  assert.equal(w.set({ client: null }, 23_000), null);
  assert.equal(w.view(23_000), null);
  assert.equal(w.set(null, 23_500), null);
  // Without `at` (an adapter that does not stamp it): the arrival counts.
  w.set({ client: 3, heldMs: 1000, dropInMs: 5000 }, 30_000);
  assert.equal(w.view(31_000).dropLeftMs, 4000);
});

test('waiting rows: every person of the game in seat order, with a word and a lamp for the state', () => {
  const roster = [
    { client: 1, player: 0, name: 'Commander' },
    { client: null, player: 1, name: 'Normal AI' },
    { client: 2, player: 2, name: 'Kara' },
    { client: 3, player: 3, name: 'Ivan' },
    { client: 4, player: 4, name: 'Mo' },
    { client: 5, player: 5, name: 'Lin' },
    { client: 6, player: 6, name: 'Sam' },
  ];
  const players = new Map([
    [1, GOOD],
    [2, { ...GOOD, rtt: 28 }],
    [3, POOR],
    [4, FAIR],
    [5, { ...POOR, silent: 6200 }],
  ]);
  const rows = waitRows(roster, players, { client: 3, heldMs: 1840.4 });
  assert.deepEqual(
    rows.map((r) => [r.name, r.state, r.led, r.text]),
    [
      ['Commander', 'good', 'ok', 'ok · 34 ms'],
      ['Kara', 'good', 'ok', 'ok · 28 ms'],
      ['Ivan', 'behind', 'bad', 'behind · 1840 ms'],
      ['Mo', 'fair', 'warn', 'fair · 118 ms'],
      ['Lin', 'silent', 'bad', 'silent · 7 s'],
      ['Sam', 'unknown', 'off', 'measuring'],
    ],
    'bots are not listed',
  );
  assert.match(waitText('Ivan'), /as soon as Ivan catches up\. A player who holds the game up for 10 seconds is dropped and can rejoin within 2 minutes\./);
});

/** A NetQuality stand-in: the same events and fields (js/netquality.js). */
function fakeQuality() {
  const listeners = new Map();
  return {
    self: NONE,
    players: new Map(),
    waiting: null,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit(type, value) {
      if (type === 'self') this.self = value;
      if (type === 'players') this.players = value;
      if (type === 'waiting') this.waiting = value;
      for (const fn of listeners.get(type) ?? []) fn(value);
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function fakeRegistry(values = { warnSelf: true, warnOthers: true, signalBars: true }) {
  const subs = new Set();
  return {
    values,
    get: (group, key) => {
      assert.equal(group, 'net');
      return values[key];
    },
    subscribe(group, fn) {
      assert.equal(group, 'net');
      subs.add(fn);
      return () => subs.delete(fn);
    },
    set(key, v) {
      values[key] = v;
      for (const fn of subs) fn({ ...values });
    },
    subs,
  };
}

function setup({ you = 1, slot = true, warnSelf = true } = {}) {
  const doc = installDom();
  const field = doc.createElement('main');
  const status = doc.createElement('span');
  doc.body.append(field, status);
  const quality = fakeQuality();
  const registry = fakeRegistry();
  const lines = [];
  const events = [];
  const clock = { t: 100_000 };
  const timers = { setInterval: () => 1, clearInterval: (id) => events.push(['cleared', id]) };
  const roster = [
    { client: 1, player: 0, name: 'Commander' },
    { client: 3, player: 3, name: 'Ivan' },
  ];
  const net = new NetWarn({
    quality,
    roster,
    you,
    field,
    slot: slot ? status : null,
    registry,
    line: (t) => lines.push(t),
    colorOf: (p) => `rgb(${p}, 0, 0)`,
    warnSelf,
    now: () => clock.t,
    events: { dispatchEvent: (e) => events.push(e.type) },
    timers,
  });
  return { doc, field, status, quality, registry, lines, events, clock, net };
}

test('NetWarn: the bars follow the own measurement, their label says it in words, a click asks for the Network tab', () => {
  const { status, quality, registry, events, net } = setup();
  try {
    const bars = status.querySelector('.net-bars');
    assert.ok(bars);
    assert.equal(bars.dataset.level, 'none');
    assert.equal(bars.getAttribute('aria-label'), 'Your connection: measuring');
    quality.emit('self', FAIR);
    assert.equal(bars.dataset.level, 'fair');
    assert.equal(bars.querySelectorAll('.net-bar.lit').length, 3);
    assert.equal(bars.getAttribute('aria-label'), 'Your connection: fair, 118 ms');
    bars.click();
    assert.deepEqual(events, [OPEN_NETWORK_EVENT]);
    // net.signalBars off: the bars go.
    registry.set('signalBars', false);
    assert.equal(bars.hidden, true);
    assert.equal(status.hidden, true, 'the place next to the clock goes too (no gap)');
    registry.set('signalBars', true);
    assert.equal(bars.hidden, false);
    assert.equal(status.hidden, false);
  } finally {
    net.dispose();
    uninstallDom();
  }
});

test('NetWarn: the own warning after 10 s poor, hidden by its button until a recovery', () => {
  const { field, quality, clock, net } = setup();
  try {
    const warn = field.querySelector('.net-warning');
    assert.equal(warn.getAttribute('role'), 'alert');
    quality.emit('self', POOR);
    assert.equal(warn.hidden, true);
    clock.t += SELF_WARN_AFTER_MS;
    net.render();
    assert.equal(warn.hidden, false);
    assert.equal(field.querySelector('.net-warning-detail').textContent, selfWarningText(POOR));
    field.querySelector('.net-warning-close').click();
    assert.equal(warn.hidden, true);
    clock.t += 60_000;
    net.render();
    assert.equal(warn.hidden, true, 'still the same poor stretch');
    quality.emit('self', GOOD);
    quality.emit('self', POOR);
    clock.t += SELF_WARN_AFTER_MS;
    net.render();
    assert.equal(warn.hidden, false, 'back after recovery and 10 s poor');
  } finally {
    net.dispose();
    uninstallDom();
  }
  // A spectator holds nobody up: no own warning, and no bars without a sidebar.
  const s = setup({ warnSelf: false, slot: false, you: 8 });
  try {
    s.quality.emit('self', POOR);
    s.clock.t += 60_000;
    s.net.render();
    assert.equal(s.field.querySelector('.net-warning').hidden, true);
    assert.equal(s.status.querySelector('.net-bars'), null);
  } finally {
    s.net.dispose();
    uninstallDom();
  }
});

test('NetWarn: a wait writes one chat line at once, the panel follows after 2 s with the countdown and the rows', () => {
  const { field, quality, registry, lines, clock, net } = setup();
  try {
    const panel = field.querySelector('.net-waiting');
    quality.emit('players', new Map([[1, GOOD], [3, POOR]]));
    quality.emit('waiting', { client: 3, heldMs: 1200, dropInMs: 8800, at: clock.t });
    assert.deepEqual(lines, ['Waiting for Ivan.']);
    assert.equal(panel.hidden, true);
    clock.t += 1000;
    quality.emit('waiting', { client: 3, heldMs: 2200, dropInMs: 7800, at: clock.t });
    assert.deepEqual(lines, ['Waiting for Ivan.'], 'one line per wait');
    clock.t += 1000;
    net.render();
    assert.equal(panel.hidden, false);
    assert.equal(field.querySelector('.net-waiting-dim').hidden, false);
    assert.equal(field.querySelector('.net-waiting-name').textContent, 'Ivan');
    assert.equal(field.querySelector('.net-waiting-left').textContent, '7 s');
    assert.equal(field.querySelector('.net-waiting-left').parentNode.parentNode.getAttribute('role'), 'timer');
    const rows = field.querySelectorAll('.net-waiting-player');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].dataset.state, 'behind');
    assert.equal(rows[1].querySelector('.net-waiting-state').textContent, 'behind · 3200 ms');
    assert.ok(rows[1].querySelector('.ui-led-bad'), 'a lamp besides the colour');
    // The game runs again: the panel goes.
    quality.emit('waiting', null);
    assert.equal(panel.hidden, true);
    // net.warnOthers off: neither the line nor the panel.
    registry.set('warnOthers', false);
    quality.emit('waiting', { client: 3, heldMs: 1200, dropInMs: 8800, at: clock.t });
    clock.t += 5000;
    net.render();
    assert.equal(panel.hidden, true);
    assert.equal(lines.length, 1);
  } finally {
    net.dispose();
    uninstallDom();
  }
});

test('NetWarn: never waits on oneself, and takes everything down on dispose', () => {
  const { field, status, quality, registry, lines, clock, events, net } = setup({ you: 3 });
  quality.emit('waiting', { client: 3, heldMs: 1200, dropInMs: 8800, at: clock.t });
  clock.t += 5000;
  net.render();
  assert.equal(field.querySelector('.net-waiting').hidden, true, 'the own warning covers the own connection');
  assert.deepEqual(lines, []);
  net.dispose();
  assert.equal(field.childNodes.length, 0);
  assert.equal(status.childNodes.length, 0);
  assert.equal(quality.count(), 0, 'no listeners left');
  assert.equal(registry.subs.size, 0);
  assert.deepEqual(events, [['cleared', 1]]);
  uninstallDom();
});
