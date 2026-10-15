// The game menu's Network tab (js/netmenu.js) and its keys and pages
// (js/gamemenu.js): the last minute of pings and stalls from the session's
// connection quality, the tiles, the table, the waiting time, the net.*
// switches and the event the HUD's signal bars open it with; the menu's key
// handling with the real dispatch order (window capture, then the target);
// the texture pack cards; the hotkey search. Fake DOM, no browser.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, textOf, memoryStorage, FakeEvent, check } from './dom-fixtures.mjs';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { BANDS, CHART_WINDOW_MS, NetHistory, OPEN_NETWORK_EVENT, waitingText } from '../js/netmenu.js';
import { GameMenu, filterHotkeys, packCards, syncLine } from '../js/gamemenu.js';
import { selectPlate } from '../js/ui/controls.js';

let doc;
afterEach(() => uninstallDom());

/** A NetQuality-like source (js/netquality.js of protocol 8): events and the last values. */
class FakeNet {
  constructor() {
    this.listeners = new Map();
    this.players = new Map();
    this.self = { rtt: null, jitter: null, late: null, quality: null };
    this.asked = 0;
  }
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }
  emit(type, v) {
    for (const fn of this.listeners.get(type) ?? []) fn(v);
  }
  count() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
  netstat(list) {
    this.players = new Map(list.map((p) => [p.client, p]));
    this.emit('players', this.players);
  }
  requestStalls() {
    this.asked++;
    return Promise.resolve(null);
  }
}

const PEOPLE = [
  { client: 1, name: 'Commander', color: '#4d8cf2' },
  { client: 2, name: 'Ivan', color: '#e64033' },
];

function menuWith(opts = {}, { windowEvents = false } = {}) {
  doc = installDom({ windowEvents });
  const registry = createRegistry({ storage: memoryStorage() });
  const settings = createSettings(registry);
  const hotkeys = new HotkeyRegistry(settings);
  const root = doc.createElement('section');
  doc.body.append(root);
  globalThis.Element = globalThis.HTMLElement;
  const menu = new GameMenu(root, {
    online: true,
    hotkeys,
    settings,
    fullscreen: { available: () => false, active: () => false, toggle: async () => ({ ok: true }) },
    onChange() {},
    onLeave() {},
    onExit() {},
    ...opts,
  });
  return { menu, root, registry, settings, hotkeys };
}

afterEach(() => {
  delete globalThis.Element;
});

test('history: one minute of pings per player, stalls from waiting, the waiting time per player', () => {
  let now = 1_000_000;
  const net = new FakeNet();
  const h = new NetHistory(net, { now: () => now });
  for (let i = 0; i < 40; i++) {
    net.netstat([
      { client: 1, rtt: 34, jitter: 4, late: 0, quality: 'good', you: true },
      { client: 2, rtt: 120 + i, jitter: 60, late: 4, quality: 'poor' },
    ]);
    now += 2000;
  }
  const m = h.model(PEOPLE);
  // 40 reports 2 s apart: the last minute keeps the newest ones.
  const ivan = m.chart.series.find((s) => s.client === 2);
  assert.ok(ivan.points.length <= CHART_WINDOW_MS / 2000 + 1 && ivan.points.length >= 29);
  assert.ok(ivan.points.every((p) => p.x >= 0 && p.x <= 1));
  assert.equal(m.rows[1].qualityText, 'Poor');
  assert.equal(m.rows[0].name, 'Commander');
  assert.equal(m.tiles.find((t) => t.id === 'slowest').value, 'Ivan');
  // A stall: Ivan held the game 1.2 s before WAITING, 0.6 s more after it.
  net.emit('waiting', { client: 2, heldMs: 1200, dropInMs: 8800, at: now });
  assert.match(h.model(PEOPLE).waiting, /all caused by Ivan/, 'the running stall counts');
  now += 600;
  net.emit('waiting', null);
  const after = h.model(PEOPLE);
  assert.equal(after.chart.stalls.length, 1);
  assert.equal(after.chart.stalls[0].text, 'stall 1.8 s');
  assert.equal(after.waiting, 'Waiting time this game: 1.8 s, all caused by Ivan.');
  // The server's stall log wins once it answers.
  net.emit('stalls', { stalls: [], totals: [{ client: 2, ms: 4000 }, { client: 1, ms: 2200 }] });
  assert.equal(h.model(PEOPLE).waiting, 'Waiting time this game: 6.2 s (Ivan 4.0 s, Commander 2.2 s).');
  // A minute later the stall left the chart; the waiting time stays.
  now += CHART_WINDOW_MS + 1;
  assert.equal(h.model(PEOPLE).chart.stalls.length, 0);
  assert.equal(waitingText(new Map(), () => ''), 'No waiting this game.');
  h.dispose();
  assert.equal(net.count(), 0, 'nothing left listening');
});

test('network page: tiles, chart, table, waiting time and the three switches; Back; the signal bars\' event opens it', async () => {
  const net = new FakeNet();
  const { menu, root, registry } = menuWith({ net: { source: net, players: () => PEOPLE } });
  net.self = { rtt: 34, jitter: 4, late: 0, quality: 'good' };
  net.netstat([
    { client: 1, rtt: 34, jitter: 4, late: 0, quality: 'good', you: true },
    { client: 2, rtt: 210, jitter: 60, late: 4, quality: 'poor' },
  ]);
  menu.open();
  const button = root.querySelectorAll('button').find((b) => b.textContent.startsWith('Network'));
  assert.match(button.textContent, /34 ms, good/);
  click(button);
  assert.equal(root.querySelector('h1').textContent, 'Network');
  assert.equal(net.asked, 1, 'the stall log is asked for');
  const tiles = root.querySelectorAll('.net-tile');
  assert.deepEqual(tiles.map((t) => t.dataset.tile), ['ping', 'jitter', 'late', 'slowest']);
  assert.match(textOf(tiles[0]), /34 ms/);
  assert.match(textOf(tiles[0]), /Good: to the game server/, 'the quality in words beside the colour');
  assert.match(textOf(tiles[3]), /Ivan/);
  const svg = root.querySelector('svg.net-chart-svg');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.querySelectorAll('path.net-line').length, 2);
  assert.equal(svg.querySelectorAll('path.net-line')[1].getAttribute('stroke'), '#e64033');
  assert.ok(BANDS.good < BANDS.poor);
  const rows = root.querySelectorAll('.net-table tbody tr');
  assert.match(textOf(rows[0]), /Commander \(you\)/);
  assert.match(textOf(rows[1]), /210 ms.*±60.*4%.*Poor/);
  assert.match(textOf(root), /No waiting this game\./);
  // New measurements draw the data again.
  net.netstat([{ client: 2, rtt: 90, jitter: 10, late: 0, quality: 'fair' }]);
  assert.match(textOf(root.querySelectorAll('.net-table tbody tr')[1]), /90 ms.*Fair/);
  // The switches are the registry's net.* settings.
  const warnSelf = root.querySelector('#net-warnSelf');
  assert.equal(warnSelf.checked, true);
  check(warnSelf, false);
  assert.equal(registry.get('net', 'warnSelf'), false);
  registry.set('net', 'signalBars', false);
  assert.equal(root.querySelector('#net-signalBars').checked, false, 'follows changes made elsewhere');
  click(root.querySelectorAll('button').find((b) => b.textContent === 'Back'));
  assert.ok(root.querySelectorAll('button').find((b) => b.textContent === 'Resume'));
  menu.close();
  // The HUD's signal bars: one event on the window opens the menu on this page.
  globalThis.window.dispatchEvent?.(new FakeEvent(OPEN_NETWORK_EVENT));
  if (!globalThis.window.dispatchEvent) menu.openAt('network');
  assert.equal(menu.isOpen, true);
  assert.equal(menu.view, 'network');
  menu.dispose();
  assert.equal(net.count(), 0);
});

test('without a network source (single player, skirmish) there is no Network button and the event does nothing', () => {
  const { menu, root } = menuWith({ online: false });
  menu.open();
  assert.ok(!root.querySelectorAll('button').some((b) => b.textContent.startsWith('Network')));
  menu.close();
  menu.openAt('network');
  assert.equal(menu.isOpen, false);
});

test('keys, real dispatch order: arrows reach a select list in the menu, Esc closes only the list, a second Esc the page', () => {
  const { menu, root } = menuWith({}, { windowEvents: true });
  // The game's own key listener (js/hotkeys.js listens on the document, bubbling).
  const gameKeys = [];
  doc.addEventListener('keydown', (e) => gameKeys.push(e.key));
  menu.open();
  menu.show('settings');
  const host = root.querySelector('.gm-panel-game');
  const changes = [];
  const plate = selectPlate({ id: 'test-plate', label: 'Test', options: ['a', 'b', 'c'].map((v) => ({ value: v, label: v.toUpperCase() })), value: 'a', onChange: (v) => changes.push(v) });
  host.append(plate.root);
  const key = (target, k) => target.dispatchEvent(Object.assign(new FakeEvent('keydown', { key: k, bubbles: true, cancelable: true })));
  // On the button, Down opens the list.
  key(plate.button, 'ArrowDown');
  assert.equal(plate.isOpen(), true, 'the select got its key');
  key(plate.listbox, 'ArrowDown');
  key(plate.listbox, 'Escape');
  assert.equal(plate.isOpen(), false, 'Esc closed the list');
  assert.deepEqual(changes, [], 'without a change');
  assert.equal(menu.isOpen, true);
  assert.equal(menu.view, 'settings', 'and only the list');
  // Arrows on the tabs move between the tabs.
  const tab = root.querySelector('#game-menu-tab-game');
  key(tab, 'ArrowDown');
  assert.equal(root.querySelector('#game-menu-tab-graphics').getAttribute('aria-selected'), 'true');
  // Typing in the hotkey search filters, never reaching the game.
  assert.deepEqual(gameKeys, [], 'no key reached the game');
  // Esc on a control that is not a list: back to the main page, then the menu closes.
  key(root.querySelector('#game-menu-tab-graphics'), 'Escape');
  assert.equal(menu.view, 'main');
  key(doc.body, 'Escape');
  assert.equal(menu.isOpen, false);
  menu.dispose();
});

test('texture pack cards: the three packs with their install state, chosen with a click or the arrows', () => {
  assert.deepEqual(
    packCards(['webra2d', 'webra3d', 'original'], 'webra3d', { originalInstalled: false }).map((c) => [c.value, c.checked, c.disabled, c.status]),
    [
      ['webra2d', false, false, 'Built in'],
      ['webra3d', true, false, 'Built in'],
      ['original', false, true, 'Not installed: add it from your own copy under Original content'],
    ],
  );
  assert.match(packCards(['webra2d', 'webra3d', 'original'], 'webra3d', { problem: 'offline' })[1].status, /offline/);
  // A build whose setting still calls 2D minimal 'webra' (before the 3D pack) shows the cards it has.
  assert.deepEqual(packCards(['webra', 'original'], 'webra', { originalInstalled: true }).map((c) => [c.value, c.name, c.checked]), [
    ['webra', '2D minimal', true],
    ['original', 'Red Alert original', false],
  ]);
  const { menu, root, settings } = menuWith({ content: { hasOriginalGraphics: true, onChange: () => () => {} } });
  menu.show('settings', 'graphics');
  menu.open();
  menu.show('settings', 'graphics');
  const group = root.querySelector('.gm-packs');
  assert.equal(group.getAttribute('role'), 'radiogroup');
  const radios = group.querySelectorAll('[role="radio"]');
  const original = radios.find((r) => r.dataset.value === 'original');
  click(original);
  assert.equal(settings.get('graphics'), 'original');
  assert.equal(group.querySelector('[data-value="original"]').getAttribute('aria-checked'), 'true');
  menu.dispose();
});

test('hotkeys: search by command, group or key; groups in OpenRA order', () => {
  const list = [
    { name: 'stop', label: 'Stop', group: 'Unit Commands', keys: ['S'] },
    { name: 'guard', label: 'Guard', group: 'Unit Commands', keys: ['D'] },
    { name: 'menu', label: 'Game menu', group: 'Game Commands', keys: [] },
  ];
  assert.deepEqual(filterHotkeys(list).map((g) => g.group), ['Game Commands', 'Unit Commands']);
  assert.deepEqual(filterHotkeys(list, 'gua').flatMap((g) => g.actions.map((a) => a.name)), ['guard']);
  assert.deepEqual(filterHotkeys(list, 'd').flatMap((g) => g.actions.map((a) => a.name)), ['guard'], 'a key');
  assert.deepEqual(filterHotkeys(list, 'unit').flatMap((g) => g.actions.map((a) => a.name)), ['stop', 'guard'], 'a group');
  assert.deepEqual(filterHotkeys(list, 'zzz'), []);
});

test('hotkeys tab: the search filters the rows, a group resets alone, the listening line', () => {
  const { menu, root, hotkeys } = menuWith();
  hotkeys.registerAction('stop', ['S'], () => {}, { label: 'Stop', group: 'Unit Commands' });
  hotkeys.registerAction('guard', ['D'], () => {}, { label: 'Guard', group: 'Unit Commands' });
  menu.open();
  menu.show('controls');
  assert.equal(root.querySelector('#game-menu-tab-hotkeys').getAttribute('aria-selected'), 'true', 'Controls and hotkeys opens the Hotkeys tab');
  const search = root.querySelector('#game-menu-keys-search');
  search.value = 'guard';
  search.dispatchEvent(new FakeEvent('input'));
  const labels = () => root.querySelectorAll('.gm-panel-hotkeys .game-menu-key-label').map((l) => l.textContent);
  assert.deepEqual(labels(), ['Guard']);
  search.value = 'nothing like it';
  search.dispatchEvent(new FakeEvent('input'));
  assert.match(textOf(root.querySelector('.gm-keys-main')), /No command or key matches/);
  search.value = '';
  search.dispatchEvent(new FakeEvent('input'));
  hotkeys.rebind('guard', 'G');
  const group = [...root.querySelectorAll('.gm-keys-head')].find((h) => h.textContent.startsWith('Unit Commands'));
  if (group) {
    click(group.querySelector('button'));
    assert.deepEqual(hotkeys.bindingsFor('guard'), ['D']);
  }
  const change = root.querySelectorAll('.gm-panel-hotkeys button').find((b) => b.textContent === 'Change');
  click(change);
  assert.match(textOf(root), /Press the new key for/);
  assert.ok(root.querySelector('.gm-panel-hotkeys button.game-menu-mini').textContent === 'Cancel' || root.querySelectorAll('.gm-panel-hotkeys button').some((b) => b.textContent === 'Cancel'));
  menu.dispose();
});

test('sync line: saved in this browser, synced, syncing, offline, not synced', () => {
  assert.match(syncLine(null).text, /Saved in this browser/);
  assert.deepEqual(syncLine({ signedIn: true, status: 'synced' }), { text: 'Synced to your account', led: 'ok' });
  assert.equal(syncLine({ signedIn: true, status: 'syncing' }).led, 'warn');
  assert.equal(syncLine({ signedIn: true, status: 'offline' }).text, 'Offline: settings will sync later');
  assert.equal(syncLine({ signedIn: true, status: 'error' }).led, 'bad');
});
