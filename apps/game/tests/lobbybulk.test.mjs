// Bulk editing of lobby slots (js/lobby-bulk.js, js/lobby-bulkbar.js) in the
// skirmish lobby (js/lobby.js) and the online lobby (js/online.js), the
// start screen's main menu (js/startmenu.js) and unloading a map file.
// Synthetic slots and maps only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEvent, installDom, uninstallDom } from './dom-fixtures.mjs';
import { RowSelection, applyBulk, bulkActionIds, planBulk } from '../js/lobby-bulk.js';
import { addSlot, sanitizeState } from '../js/lobby-state.js';
import { createMap, mapFileText } from '../editor/js/mapformat.js';
import { defaultRegistry } from '../js/registry.js';

afterEach(() => {
  delete globalThis.requestAnimationFrame;
  uninstallDom();
});

const COLORS = Array.from({ length: 8 }, (_, k) => [k / 8, 0.5, 1 - k / 8]);
/** A seeded stand-in for Math.random. */
function rng(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}
const human = (extra = {}) => ({ type: 'human', team: 0, faction: 'england', color: 0, handicap: 0, ...extra });
const ai = (extra = {}) => ({ type: 'ai', team: 0, faction: 'random', color: 1, bot: 'normal', difficulty: 'normal', handicap: 0, ...extra });

// ---- Selection ---------------------------------------------------------------------------

test('selection: a click selects one row, Ctrl/Cmd toggles, Shift selects the range from the anchor top to bottom', () => {
  const sel = new RowSelection();
  sel.click(2);
  assert.deepEqual(sel.list(), [2]);
  sel.click(5, { range: true });
  assert.deepEqual(sel.list(), [2, 3, 4, 5], 'down from the anchor');
  sel.click(0, { range: true });
  assert.deepEqual(sel.list(), [0, 1, 2], 'up from the same anchor, the old range goes');
  sel.click(6, { additive: true });
  assert.deepEqual(sel.list(), [0, 1, 2, 6], 'Ctrl adds');
  sel.click(1, { additive: true });
  assert.deepEqual(sel.list(), [0, 2, 6], 'Ctrl removes, and is the new anchor');
  sel.click(3, { range: true, additive: true });
  assert.deepEqual(sel.list(), [0, 1, 2, 3, 6], 'Ctrl+Shift adds the range from the anchor (the clicked row was off, so the range goes on)');
});

test('selection: Shift on a checkbox sets the range to the clicked box; a plain click resets; prune and select all', () => {
  const sel = new RowSelection();
  sel.click(1, { additive: true });
  sel.click(4, { range: true, additive: true });
  assert.deepEqual(sel.list(), [1, 2, 3, 4], 'ticking with Shift ticks the range');
  sel.click(3, { range: true, additive: true });
  assert.deepEqual(sel.list(), [4], 'Shift on a ticked box unticks the range from the anchor');
  sel.click(7);
  assert.deepEqual(sel.list(), [7]);
  sel.prune(5);
  assert.deepEqual(sel.list(), []);
  assert.equal(sel.anchor, null);
  sel.click(2, { range: true });
  assert.deepEqual(sel.list(), [2], 'Shift without an anchor selects the row');
  sel.selectAll([0, 1, 2, 3]);
  assert.equal(sel.size, 4);
  sel.clear();
  assert.equal(sel.size, 0);
});

// ---- Planning -------------------------------------------------------------------------------

test('team presets: free for all, humans vs AI, OpenRA split in slot order, alternating, one team; locks are kept', () => {
  const slots = [human({ you: true }), ai({ color: 1 }), human({ color: 2 }), ai({ color: 3, locked: ['team'], team: 4 }), { type: 'closed', color: 4 }, ai({ color: 5 })];
  const teams = (id, selected = []) => {
    const plan = planBulk(slots, id, { context: 'online', selected, teamMax: 4 });
    const out = slots.map((s) => s.team);
    for (const c of plan.changes) out[c.slot] = c.team;
    return out;
  };
  assert.deepEqual(teams('teams:humans-vs-ai'), [1, 2, 1, 4, undefined, 2]);
  assert.deepEqual(teams('teams:split:2'), [1, 1, 2, 4, undefined, 2], 'OpenRA AssignTeams: assigned * teams / count + 1');
  assert.deepEqual(teams('teams:alternate:2'), [1, 2, 1, 4, undefined, 2]);
  assert.deepEqual(teams('teams:ffa'), [0, 0, 0, 4, undefined, 0]);
  assert.deepEqual(teams('team:3', [1, 2]), [0, 3, 3, 4, undefined, 0], 'only the selection');
  assert.equal(planBulk(slots, 'teams:ffa', { context: 'online' }).summary, 'Nothing to change.');
  assert.ok(planBulk(slots, 'teams:split:9', { context: 'online' }).error, 'no such split');
});

test('colors: shuffled colours stay unique, also against slots that keep theirs; factions shuffle to countries', () => {
  const slots = [human({ you: true, color: 0 }), ai({ color: 1 }), ai({ color: 2, locked: ['color'] }), { type: 'closed', color: 3 }, ai({ color: 4 })];
  for (let seed = 1; seed < 30; seed++) {
    const plan = planBulk(slots, 'colors:shuffle', { context: 'skirmish', colorCount: 8, rng: rng(seed) });
    const colors = slots.map((s) => s.color);
    for (const c of plan.changes) colors[c.slot] = c.color;
    assert.equal(new Set(colors).size, colors.length, `unique (seed ${seed})`);
    assert.equal(colors[2], 2, 'locked');
    assert.equal(colors[3], 3, 'a closed skirmish row keeps its colour');
  }
  const factions = planBulk(slots, 'faction:shuffle', { context: 'skirmish', rng: rng(3) });
  for (const c of factions.changes) assert.ok(['england', 'france', 'germany', 'russia', 'ukraine'].includes(c.faction));
  assert.ok(!factions.changes.some((c) => c.slot === 3), 'not the closed row');
  assert.deepEqual(planBulk(slots, 'faction:randomsoviet', { context: 'skirmish', selected: [1] }).changes, [{ slot: 1, faction: 'randomsoviet' }]);
  // Online the host sets faction and colour for its own slot and the AI slots only (OpenRA's lobby).
  const online = [human({ you: true, color: 0, faction: 'england' }), human({ color: 1, faction: 'england' }), ai({ color: 2 })];
  assert.deepEqual(planBulk(online, 'faction:russia', { context: 'online' }).changes.map((c) => c.slot), [0, 2]);
  for (let seed = 1; seed < 10; seed++) {
    const plan = planBulk(online, 'colors:shuffle', { context: 'online', colorCount: 8, rng: rng(seed) });
    assert.ok(plan.changes.every((c) => c.slot !== 1 && c.color !== 1), 'the other player keeps its colour, and nobody takes it');
  }
  assert.deepEqual(planBulk(online, 'team:2', { context: 'online' }).changes.map((c) => c.slot), [0, 1, 2], 'teams include the other player');
});

test('AI: bot and difficulty for AI slots only, fill and remove; online slot actions never touch your own slot', () => {
  const slots = [human({ you: true }), ai(), { type: 'open' }, human({ color: 2 }), { type: 'closed' }, { type: 'open', locked: ['type'] }];
  const opts = { context: 'online' };
  assert.deepEqual(planBulk(slots, 'bot:turtle', opts).changes, [{ slot: 1, bot: 'turtle' }]);
  assert.deepEqual(planBulk(slots, 'difficulty:hard', opts).changes, [{ slot: 1, difficulty: 'hard' }]);
  assert.deepEqual(planBulk(slots, 'fill:rush', opts).changes, [{ slot: 2, type: 'ai', bot: 'rush', difficulty: 'normal' }], 'open slots, not a locked one');
  assert.deepEqual(planBulk(slots, 'clear-ai', opts).changes, [{ slot: 1, type: 'open' }]);
  assert.deepEqual(planBulk(slots, 'slot:kick', opts).changes, [{ slot: 3, type: 'open' }], 'the other player, never you');
  assert.deepEqual(planBulk(slots, 'slot:closed', opts).changes, [{ slot: 1, type: 'closed' }, { slot: 2, type: 'closed' }]);
  assert.deepEqual(planBulk(slots, 'slot:open', opts).changes, [{ slot: 1, type: 'open' }, { slot: 4, type: 'open' }]);
  assert.deepEqual(planBulk(slots, 'slot:ai', { ...opts, selected: [2, 3, 4] }).changes, [
    { slot: 2, type: 'ai', bot: 'normal', difficulty: 'normal' },
    { slot: 4, type: 'ai', bot: 'normal', difficulty: 'normal' },
  ]);
  assert.deepEqual(planBulk([ai({ spawn: 2 }), human({ you: true })], 'spawn:auto', opts).changes, [{ slot: 0, spawn: null }]);
  // A co-op mission: only the slot actions, within its places.
  assert.deepEqual(bulkActionIds({ context: 'online', mission: true }), ['slot:kick', 'slot:open', 'slot:closed']);
  assert.ok(planBulk(slots, 'teams:ffa', { ...opts, mission: true }).error);
  assert.deepEqual(planBulk(slots, 'slot:kick', { ...opts, mission: true, missionPlaces: 2 }).changes, []);
});

test('skirmish: fill adds AI rows up to the map, remove AI keeps two players; applyBulk is all or nothing', () => {
  const state = sanitizeState({ players: [{ type: 'human', color: 0 }, { type: 'ai', color: 1 }, { type: 'closed', color: 2 }] }, 8, () => 5);
  const slots = state.players.map((p) => ({ ...p, you: p.type === 'human' }));
  const plan = planBulk(slots, 'fill:naval', { context: 'skirmish', maxActive: 5, maxRows: 8 });
  assert.deepEqual(plan.changes, [{ slot: 2, type: 'ai', bot: 'naval', difficulty: 'normal' }]);
  assert.equal(plan.add.length, 2, 'up to the 5 start positions');
  assert.equal(applyBulk(state, plan, { colorCount: 8, maxActive: 5, addRow: () => addSlot(state, 8, 5) }), null);
  assert.deepEqual(state.players.map((p) => [p.type, p.bot]), [['human', 'normal'], ['ai', 'normal'], ['ai', 'naval'], ['ai', 'naval'], ['ai', 'naval']]);
  assert.equal(new Set(state.players.map((p) => p.color)).size, 5);
  assert.equal(planBulk([human({ you: true }), ai()], 'clear-ai', { context: 'skirmish' }).error, 'A game needs at least two players.');
  // A refused plan leaves the state as it was.
  const before = structuredClone(state.players);
  assert.match(applyBulk(state, { changes: [{ slot: 1, team: 2 }, { slot: 2, color: state.players[3].color }] }, { colorCount: 8, addRow: () => -1 }), /share a color/);
  assert.deepEqual(state.players, before);
  assert.match(applyBulk(state, { changes: [{ slot: 0, type: 'closed' }] }, { colorCount: 8, addRow: () => -1 }), /own slot/);
  assert.deepEqual(state.players, before);
});

// ---- The skirmish lobby ------------------------------------------------------------------------

async function skirmish() {
  const doc = installDom();
  globalThis.requestAnimationFrame = () => 1;
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  const root = doc.createElement('section');
  doc.body.append(root);
  defaultRegistry().set('lobby', 'lastOptions', { seed: 1234, mapSize: 64, players: [{ type: 'human', color: 0 }, { type: 'ai', color: 1 }, { type: 'ai', color: 2 }, { type: 'ai', color: 3 }] });
  const { Lobby } = await import('../js/lobby.js');
  const stress = [];
  const lobby = new Lobby(root, {
    colors: COLORS,
    colorNames: [],
    maps: {
      preview: (seed, size) => new Uint8Array(size * size * 4),
      spawns: (seed, size, players) => [[4, 4], [40, 40], [40, 4], [4, 40], [20, 20], [30, 30], [10, 30], [30, 10]].slice(0, players),
      validate: () => ({ ok: true, errors: [], modded: false, hash: 'f'.repeat(64) }),
      filePreview: (json) => new Uint8Array(JSON.parse(json).width * JSON.parse(json).height * 4),
    },
    onStart: () => {},
    onStress: (o) => stress.push(o),
  });
  lobby.canvas.getContext = () => ({ putImageData() {}, clearRect() {} });
  lobby.ctx = lobby.canvas.getContext();
  return { doc, root, lobby, stress };
}

const click = (el, init = {}) => el.dispatchEvent(new FakeEvent('click', init));

test('skirmish lobby: Bulk edit shows checkboxes; Shift-click selects a range, Ctrl-click a row; Apply changes the selection', async () => {
  const { root, lobby } = await skirmish();
  const toggle = root.querySelector('.bulk-toggle');
  const bar = root.querySelector('.bulk-bar');
  assert.equal(bar.hidden, true);
  assert.ok([...root.querySelectorAll('input.bulk-pick')].filter((b) => b.closest('.lobby-slot')).every((b) => b.hidden), 'no checkboxes until bulk edit is on');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(bar.hidden, false);
  const boxes = () => [...root.querySelectorAll('.lobby-slot input.bulk-pick')];
  assert.equal(boxes().length, 4);
  click(boxes()[1]);
  click(boxes()[3], { shiftKey: true });
  assert.deepEqual(lobby.bulk.selection.list(), [1, 2, 3]);
  assert.deepEqual(boxes().map((b) => b.checked), [false, true, true, true]);
  assert.equal(root.querySelector('.bulk-count').textContent, '3 of 4 selected');
  // A click on the row (not on a control) with Ctrl takes one row out.
  const rows = [...root.querySelectorAll('.lobby-slot')].filter((r) => !r.classList.contains('lobby-slot-head'));
  click(rows[2].querySelector('.lobby-badge'), { ctrlKey: true });
  assert.deepEqual(lobby.bulk.selection.list(), [1, 3]);
  assert.ok(rows[1].classList.contains('bulk-selected'));
  // A click on a control in the row does not change the selection.
  click(rows[3].querySelector('select'), { shiftKey: true });
  assert.deepEqual(lobby.bulk.selection.list(), [1, 3]);
  const select = root.querySelector('.bulk-action');
  select.value = 'team:2';
  select.dispatchEvent(new FakeEvent('change'));
  root.querySelector('.bulk-apply').click();
  assert.deepEqual(lobby.state.players.map((p) => p.team), [0, 2, 0, 2]);
  assert.equal(root.querySelector('.bulk-status').textContent, '2 slots put on Team 2.');
  // Nothing selected: the preset applies to every slot.
  root.querySelector('.bulk-bar button').click();
  assert.equal(lobby.bulk.selection.size, 0);
  select.value = 'teams:humans-vs-ai';
  root.querySelector('.bulk-apply').click();
  assert.deepEqual(lobby.state.players.map((p) => p.team), [1, 2, 2, 2]);
  // Enter in the action list applies and does not start the game.
  select.value = 'teams:ffa';
  const enter = new FakeEvent('keydown', { key: 'Enter', cancelable: true });
  select.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(lobby.state.players.map((p) => p.team), [0, 0, 0, 0]);
  // The All box selects every row; turning bulk edit off forgets the selection.
  root.querySelector('.bulk-all input').click();
  assert.equal(lobby.bulk.selection.size, 4);
  toggle.click();
  assert.equal(lobby.bulk.selection.size, 0);
  assert.equal(bar.hidden, true);
});

test('skirmish lobby: a refused action says why and changes nothing', async () => {
  const { root, lobby } = await skirmish();
  root.querySelector('.bulk-toggle').click();
  const before = structuredClone(lobby.state.players);
  const select = root.querySelector('.bulk-action');
  select.value = 'clear-ai';
  select.dispatchEvent(new FakeEvent('change'));
  root.querySelector('.bulk-apply').click();
  assert.equal(root.querySelector('.bulk-status').textContent, 'A game needs at least two players.');
  assert.ok(root.querySelector('.bulk-status').classList.contains('bulk-error'));
  assert.deepEqual(lobby.state.players, before);
});

function mapText() {
  const map = createMap({ width: 32, height: 32, name: 'Twin Rivers', author: 'Tester' });
  map.spawns = [
    [4, 4],
    [26, 26],
    [4, 26],
    [26, 4],
  ];
  return mapFileText(map);
}

test('skirmish lobby: a loaded map hides the seed and the generator fields; Unload goes back to the generated map and its seed', async () => {
  const { root, lobby } = await skirmish();
  const seedField = lobby.seedField;
  assert.equal(seedField.hidden, false);
  assert.equal(lobby.unloadBtn.hidden, true);
  lobby.offerMapText(mapText(), 'file');
  assert.ok(lobby.mapFile, 'installed');
  assert.equal(lobby.state.mapSource, 'file');
  assert.equal(seedField.hidden, true, 'no seed (nor New seed) for a map file');
  assert.equal(lobby.sizeField.hidden, true);
  assert.equal(lobby.unloadBtn.hidden, false);
  assert.equal(lobby.loadBtn.textContent, 'Load another map');
  assert.doesNotMatch(lobby.caption.textContent, /seed/);
  // Each game on the map file gets a new seed; the lobby keeps the generator's.
  const starts = [];
  lobby.onStart = (o) => starts.push(o);
  lobby.start();
  lobby.start();
  assert.equal(starts.length, 2);
  assert.ok(starts.every((o) => Number.isInteger(o.seed) && o.seed !== 1234), 'not the hidden seed');
  assert.notEqual(starts[0].seed, starts[1].seed, 'a new one each start');
  assert.equal(lobby.state.seed, 1234);
  lobby.unloadBtn.click();
  assert.equal(lobby.mapFile, null);
  assert.equal(lobby.state.mapSource, 'random');
  assert.equal(lobby.state.seed, 1234, 'the seed from before the map');
  assert.equal(lobby.state.mapSize, 64);
  assert.equal(seedField.hidden, false);
  assert.equal(lobby.fileField.hidden, true);
  assert.match(lobby.caption.textContent, /seed 1234/);
  assert.equal(globalThis.localStorage?.getItem?.('webra.lobby.map.v1') ?? null, null, 'forgotten');
  // Map file again: no map loaded, so it asks for a file.
  let picked = 0;
  lobby.fileInput.click = () => picked++;
  root.querySelectorAll('.lobby-source-btn')[1].click();
  assert.equal(picked, 1);
});

test('skirmish lobby: the stress test hides until the main menu opens it', async () => {
  const { lobby, stress } = await skirmish();
  assert.equal(lobby.stressBox.hidden, true);
  lobby.openStress();
  assert.equal(lobby.stressBox.hidden, false);
  lobby.unitsInput.value = '300';
  lobby.unitsInput.dispatchEvent(new FakeEvent('input'));
  lobby.stressBtn.click();
  assert.deepEqual(stress, [{ seed: 1234, units: 300 }]);
  lobby.closeStress();
  assert.equal(lobby.stressBox.hidden, true);
});

// ---- The online lobby ----------------------------------------------------------------------------

async function onlineLobby({ you = 1, slots }) {
  installDom();
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  const { OnlineUI } = await import('../js/online.js');
  const sent = [];
  const ui = Object.create(OnlineUI.prototype);
  Object.assign(ui, {
    root: globalThis.document.createElement('div'),
    lens: null,
    ctx: { colors: COLORS, colorNames: [], Game: { map_preview_styled: (seed, size) => new Uint8Array(size * size * 4), generated_map_styled: () => JSON.stringify({ spawns: [] }) } },
    installed: new Map(),
    missionPreviews: new Map(),
    missionEntries: new Map(),
    mapStatus: { text: '', ok: true },
    mapNotice: null,
    mapOffer: null,
    send: (m) => sent.push(m),
    libraryMaps: [],
    serverMaps: [],
    state: {
      you,
      hostId: 1,
      session: { id: 'a'.repeat(64), name: 'Test', public: false },
      slots,
      options: { seed: 9, mapSize: 64, mapStyle: 'land', biome: 'snow', techBuildings: 'standard', separateTeamSpawns: true },
      map: null,
      mission: null,
      spectators: [],
      maxSpectators: 2,
      role: 'player',
    },
  });
  ui.buildLobby();
  ui.renderLobby();
  return { ui, sent };
}

const labelled = (root, label) => [...root.querySelectorAll('select')].find((x) => x.getAttribute('aria-label') === label);

const SLOTS = () => [
  { type: 'human', client: 1, name: 'Host', faction: 'random', color: 0, team: 0, ready: false },
  { type: 'human', client: 2, name: 'Guest', faction: 'random', color: 1, team: 0, ready: true },
  { type: 'ai', difficulty: 'normal', bot: 'normal', faction: 'random', color: 2, team: 0 },
  { type: 'open' },
];

test('online lobby: the host applies a bulk action with one slots message; another player has no bulk edit', async () => {
  const { ui, sent } = await onlineLobby({ slots: SLOTS() });
  const toggle = ui.root.querySelector('.bulk-toggle-box');
  assert.equal(toggle.hidden, false);
  ui.root.querySelector('.bulk-toggle').click();
  const boxes = [...ui.root.querySelectorAll('.online-slot input.bulk-pick')];
  assert.equal(boxes.length, 4);
  click(boxes[3]);
  click(boxes[0], { shiftKey: true });
  assert.deepEqual(ui.bulk.selection.list(), [0, 1, 2, 3], 'Shift from the bottom up');
  const select = ui.root.querySelector('.bulk-action');
  select.value = 'teams:humans-vs-ai';
  select.dispatchEvent(new FakeEvent('change'));
  ui.root.querySelector('.bulk-apply').click();
  assert.deepEqual(sent.at(-1), { t: 'slots', changes: [{ slot: 0, team: 1 }, { slot: 1, team: 1 }, { slot: 2, team: 2 }] });
  // The bar waits for the server: an update without the changes (another member's) keeps it waiting.
  const status = () => ui.root.querySelector('.bulk-status');
  assert.equal(status().textContent, 'Sent to the server...');
  ui.onLobby({ slots: SLOTS(), options: ui.state.options, map: null, hostId: 1, spectators: [], maxSpectators: 2 });
  assert.equal(status().textContent, 'Sent to the server...');
  const done = SLOTS();
  done[0].team = 1;
  done[1].team = 1;
  done[2].team = 2;
  ui.onLobby({ slots: done, options: ui.state.options, map: null, hostId: 1, spectators: [], maxSpectators: 2 });
  assert.equal(status().textContent, 'Teams set: 3 slots changed.');
  // A refusal shows in the bar instead.
  select.value = 'team:3';
  ui.root.querySelector('.bulk-apply').click();
  ui.onServerError({ code: 'forbidden', message: 'This map locks slot 2 to team 2.' });
  assert.equal(status().textContent, 'Refused: This map locks slot 2 to team 2.');
  assert.ok(status().classList.contains('bulk-error'));
  assert.match(ui.root.querySelector('.bulk-note').textContent, /own slot and the AI slots/);
  select.value = 'fill:turtle';
  ui.root.querySelector('.bulk-apply').click();
  assert.deepEqual(sent.at(-1), { t: 'slots', changes: [{ slot: 3, type: 'ai', bot: 'turtle', difficulty: 'normal' }] });
  // The selection survives a lobby update.
  ui.state.slots = SLOTS();
  ui.renderLobby();
  assert.deepEqual(ui.bulk.selection.list(), [0, 1, 2, 3]);
  // The host sets the other player's team, handicap and start in its row, not its faction or colour (OpenRA's lobby).
  const guestRow = ui.root.querySelectorAll('.online-slot')[2];
  assert.equal(labelled(guestRow, 'Player 2 team').disabled, false);
  assert.equal(labelled(guestRow, 'Player 2 handicap').disabled, false);
  assert.equal(labelled(guestRow, 'Player 2 faction').disabled, true);
  assert.equal(labelled(guestRow, 'Player 2 color').disabled, true);

  uninstallDom();
  const guest = await onlineLobby({ you: 2, slots: SLOTS() });
  assert.equal(guest.ui.root.querySelector('.bulk-toggle-box').hidden, true, 'only the host');
  assert.equal([...guest.ui.root.querySelectorAll('.online-slot input.bulk-pick')].every((b) => b.hidden), true);
  assert.equal(labelled(guest.ui.root.querySelectorAll('.online-slot')[1], 'Player 1 team').disabled, true);
});

test('online lobby: the host unloads a shared map or leaves a mission; the seed shows only for a generated map', async () => {
  const { ui, sent } = await onlineLobby({ slots: SLOTS() });
  const buttons = () => [...ui.mapBox.querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(buttons().includes('New seed'));
  assert.ok(!buttons().includes('Unload map'));
  ui.state.map = { id: '0123456789abcdef', hash: 'c'.repeat(64), name: 'Four', modded: false, players: 4, author: 'Tester', width: 64, height: 64, bytes: 900, shared: true };
  ui.renderMap();
  assert.ok(!buttons().includes('New seed'), 'no seed for a map file');
  const unload = [...ui.mapBox.querySelectorAll('button')].find((b) => b.textContent === 'Unload map');
  unload.click();
  assert.deepEqual(sent.at(-1), { t: 'map', map: null });
  ui.state.map = null;
  ui.state.mission = { id: 'evacuation', hash: 'h', options: {} };
  ui.renderMap();
  assert.ok(buttons().includes('Leave mission'));
  assert.ok(!buttons().includes('New seed'));
});

// ---- The main menu -----------------------------------------------------------------------------------

test('main menu: More opens and closes with the keyboard and a click outside; entries without a handler stay hidden', async () => {
  const doc = installDom();
  const { mountStartMenu } = await import('../js/startmenu.js');
  const nav = doc.createElement('nav');
  nav.id = 'start-nav';
  const more = doc.createElement('div');
  const button = doc.createElement('button');
  button.id = 'start-more-button';
  button.setAttribute('aria-expanded', 'false');
  const list = doc.createElement('div');
  list.id = 'start-more-list';
  list.hidden = true;
  const entry = (id) => {
    const b = doc.createElement('button');
    b.id = id;
    list.append(b);
    return b;
  };
  const sound = entry('start-sound');
  const notes = entry('start-notes');
  const stress = entry('start-stress');
  more.append(button, list);
  nav.append(more);
  doc.body.append(nav);
  const calls = [];
  const menu = mountStartMenu(nav, { onSound: () => calls.push('sound'), onStress: (entry) => calls.push(entry === stress ? 'stress' : 'other') });
  assert.equal(notes.hidden, true, 'no release notes handler');
  assert.equal(sound.hidden, false);
  button.click();
  assert.equal(menu.open, true);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  button.click();
  assert.equal(menu.open, false);
  button.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  assert.equal(menu.open, true);
  assert.equal(doc.activeElement, sound, 'ArrowDown opens at the first entry');
  list.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  assert.equal(doc.activeElement, stress, 'hidden entries are skipped');
  list.dispatchEvent(new FakeEvent('keydown', { key: 'Home', cancelable: true }));
  assert.equal(doc.activeElement, sound);
  stress.click();
  assert.deepEqual(calls, ['stress']);
  assert.equal(doc.activeElement, stress, 'the entry takes the focus (Safari leaves it on the page)');
  list.dispatchEvent(new FakeEvent('keydown', { key: 'Escape', cancelable: true }));
  assert.equal(menu.open, false);
  assert.equal(doc.activeElement, button, 'Escape returns to More');
  // Escape on the More button itself closes the list too.
  button.click();
  assert.equal(menu.open, true);
  button.focus();
  const esc = new FakeEvent('keydown', { key: 'Escape', cancelable: true });
  button.dispatchEvent(esc);
  assert.equal(menu.open, false);
  assert.equal(esc.defaultPrevented, true);
  button.dispatchEvent(new FakeEvent('keydown', { key: 'Escape', cancelable: true }));
  assert.equal(menu.open, false, 'a closed list stays closed');
  button.click();
  const outside = doc.createElement('div');
  doc.body.append(outside);
  outside.dispatchEvent(new FakeEvent('pointerdown'));
  assert.equal(menu.open, false, 'a click outside closes it');
});
