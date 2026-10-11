// OpenRA's selection keys and double click in js/input.js: SelectAllUnits
// (Q) and SelectUnitsByType (W) select on screen first and across the map
// when pressed again, with OpenRA's feedback lines and click; double click
// adds the clicked actor's class on screen. Which actors match (priorities,
// classes, bounds) is the engine's (engine/src/selection.rs, its tests and
// tests/api.test.mjs); this fake engine models it with types and owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { createSettings as settingsOver } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';
import { selectedUnitsText } from '../js/input.js';

const NONE = 0xffffffff;
const createSettings = () => settingsOver(createRegistry({ storage: null }));

/** Actors by id: { owner, type, x, y, prio } (prio: selection priority, class = type). */
const WORLD = {
  1: { owner: 0, type: 'E1', x: 100, y: 100, prio: 10 },
  2: { owner: 0, type: 'E1', x: 140, y: 100, prio: 10 },
  3: { owner: 0, type: '1TNK', x: 200, y: 120, prio: 10 },
  4: { owner: 0, type: 'HARV', x: 260, y: 120, prio: 6 },
  5: { owner: 0, type: 'E1', x: 1400, y: 1400, prio: 10 },
  6: { owner: 0, type: 'POWR', x: 300, y: 300, prio: 2 },
  7: { owner: 1, type: 'E1', x: 120, y: 160, prio: 10 },
  8: { owner: 1, type: '3TNK', x: 1500, y: 1500, prio: 10 },
};

function fakeGame(world = WORLD) {
  let selection = [];
  const asks = [];
  const inRect = (a, x0, y0, x1, y1) => a.x >= x0 && a.x <= x1 && a.y >= y0 && a.y <= y1;
  const entries = () => Object.entries(world).map(([id, a]) => [Number(id), a]);
  return {
    asks,
    map_width: () => 64,
    map_height: () => 64,
    player_count: () => 2,
    pick: (_p, x, y) => entries().find(([, a]) => Math.hypot(a.x - x, a.y - y) < 12)?.[0] ?? NONE,
    select_at: (_p, x, y) => entries().find(([, a]) => Math.hypot(a.x - x, a.y - y) < 12)?.[0] ?? NONE,
    actor_json: (id) => (world[id] ? JSON.stringify({ id, type: world[id].type, owner: world[id].owner, building: world[id].type === 'POWR', carrier: NONE }) : 'null'),
    set_selection: (ids) => (selection = Array.from(ids)),
    selection: () => Uint32Array.from(selection),
    select_box: () => new Uint32Array(0),
    select_all: (owners, x0, y0, x1, y1) => {
      asks.push(['all', Array.from(owners), x1 > 1000 ? 'map' : 'screen']);
      const found = entries().filter(([, a]) => owners.includes(a.owner) && inRect(a, x0, y0, x1, y1));
      const best = Math.max(...found.map(([, a]) => a.prio));
      return Uint32Array.from(found.filter(([, a]) => a.prio === best).map(([id]) => id));
    },
    select_by_class: (owners, ids, x0, y0, x1, y1) => {
      asks.push(['class', Array.from(owners), x1 > 1000 ? 'map' : 'screen']);
      const classes = Array.from(ids).filter((id) => owners.includes(world[id]?.owner)).map((id) => world[id].type);
      return Uint32Array.from(entries().filter(([, a]) => owners.includes(a.owner) && classes.includes(a.type) && inRect(a, x0, y0, x1, y1)).map(([id]) => id));
    },
  };
}

/** The input on a 800 x 600 view of the top left of a 64 x 64 map (1536 x 1536 px). */
async function makeInput({ spectator = false, game = fakeGame(), over = false } = {}) {
  globalThis.window ??= { addEventListener() {} };
  const { Input } = await import('../js/input.js');
  const canvas = { clientWidth: 800, clientHeight: 600, style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const hotkeys = new HotkeyRegistry(createSettings());
  const log = { feedback: [], clicks: 0, selections: [] };
  const hooks = {
    onSelectionChanged: (ids) => log.selections.push(ids.slice()),
    feedback: (t) => log.feedback.push(t),
    selectionClick: () => log.clicks++,
    gameOver: () => over,
  };
  const input = new Input(canvas, game, { actors: [] }, 0, hooks, { hotkeys, settings: createSettings(), spectator });
  input.camera.zoom = 1;
  input.camera.x = 0;
  input.camera.y = 0;
  const key = (code, k) => hotkeys.handle({ code, key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {} });
  return { input, hotkeys, game, log, key };
}

const sorted = (ids) => ids.slice().sort((a, b) => a - b);
const settle = () => new Promise((r) => setTimeout(r, 0));

test("OpenRA's feedback lines", () => {
  assert.equal(selectedUnitsText(1, 'screen'), 'Selected one unit across screen.');
  assert.equal(selectedUnitsText(3, 'map'), 'Selected 3 units across map.');
  assert.equal(selectedUnitsText(0, 'map'), 'Selected 0 units across map.');
});

test('Q: the combat units on screen, then pressed again the whole map; own units only', async () => {
  const { input, game, log, key } = await makeInput();
  key('KeyQ', 'q');
  await settle();
  assert.deepEqual(sorted(input.selection), [1, 2, 3], 'not the harvester (lower priority), the enemy or the rifleman off screen');
  key('KeyQ', 'q');
  await settle();
  assert.deepEqual(sorted(input.selection), [1, 2, 3, 5], 'nothing new on screen: across the map');
  assert.deepEqual(log.feedback, ['Selected 3 units across screen.', 'Selected 4 units across map.']);
  assert.equal(log.clicks, 2, "OpenRA's ClickSound for each press");
  assert.deepEqual(
    game.asks.map(([kind, owners, where]) => `${kind} ${owners} ${where}`),
    ['all 0 screen', 'all 0 screen', 'all 0 map'],
    'the second press looks on screen first, like OpenRA',
  );
  // It replaces the selection (OpenRA Combine without isCombine).
  input.setSelection([4]);
  key('KeyQ', 'q');
  await settle();
  assert.deepEqual(sorted(input.selection), [1, 2, 3]);
});

test('W: the selected types on screen are added, then pressed again across the map', async () => {
  const { input, log, key } = await makeInput();
  input.setSelection([1, 4]);
  key('KeyW', 'w');
  await settle();
  assert.deepEqual(sorted(input.selection), [1, 2, 4], 'riflemen and the harvester on screen');
  key('KeyW', 'w');
  await settle();
  assert.deepEqual(sorted(input.selection), [1, 2, 4, 5], 'and the rifleman across the map');
  assert.deepEqual(log.feedback, ['Selected 3 units across screen.', 'Selected 4 units across map.']);
  assert.equal(log.clicks, 2);
});

test('W: nothing selected says so; an enemy selection selects nothing', async () => {
  const { input, game, log, key } = await makeInput();
  key('KeyW', 'w');
  await settle();
  assert.deepEqual(log.feedback, ['Nothing selected.']);
  assert.equal(log.clicks, 0, 'ClickDisabledSound is silent in Red Alert');
  input.setSelection([7]);
  key('KeyW', 'w');
  await settle();
  assert.deepEqual(input.selection, [7], 'not our rifleman: nothing happens (OpenRA: no owned actors)');
  assert.deepEqual(game.asks, []);
  assert.deepEqual(log.feedback, ['Nothing selected.']);
});

test('spectators select for the player they watch, or for every player', async () => {
  const { input, game, key } = await makeInput({ spectator: true });
  input.player = 1;
  input.watchAll = false;
  key('KeyQ', 'q');
  await settle();
  assert.deepEqual(input.selection, [7], "the watched player's units on screen");
  input.watchAll = true;
  input.setSelection([]);
  key('KeyQ', 'q');
  await settle();
  assert.deepEqual(sorted(input.selection), [1, 2, 3, 7], 'the whole map view: every player');
  assert.deepEqual(game.asks.at(-1).slice(0, 2), ['all', [0, 1]]);
});

test('after the game is over the keys do nothing (OpenRA World.IsGameOver)', async () => {
  const { input, game, log, key } = await makeInput({ over: true });
  input.setSelection([1]);
  key('KeyQ', 'q');
  key('KeyW', 'w');
  await settle();
  assert.deepEqual(input.selection, [1]);
  assert.deepEqual(game.asks, []);
  assert.deepEqual(log.feedback, []);
});

test('double click: the clicked actor and the others of its class on screen join the selection', async () => {
  const { input } = await makeInput();
  input.setSelection([3]);
  await input.clickSelect({ x: 100, y: 100 }, false, 1000);
  assert.deepEqual(input.selection, [1], 'the first click selects the rifleman');
  await input.clickSelect({ x: 100, y: 100 }, false, 1100);
  assert.deepEqual(sorted(input.selection), [1, 2], 'the second adds the riflemen on screen (not the one off screen, not the enemy)');
  // With Shift the first click adds, and the double click adds the class to that.
  input.setSelection([3]);
  await input.clickSelect({ x: 140, y: 100 }, true, 5000);
  await input.clickSelect({ x: 140, y: 100 }, true, 5100);
  assert.deepEqual(sorted(input.selection), [1, 2, 3]);
  // Too slow: two single clicks.
  await input.clickSelect({ x: 200, y: 120 }, false, 9000);
  await input.clickSelect({ x: 200, y: 120 }, false, 9500);
  assert.deepEqual(input.selection, [3]);
  // An enemy's double click selects only it (OpenRA: not an eligible owner).
  await input.clickSelect({ x: 120, y: 160 }, false, 12000);
  await input.clickSelect({ x: 120, y: 160 }, false, 12100);
  assert.deepEqual(input.selection, [7]);
});

test('a box selects what the engine ranks highest; Shift adds; modifiers and the viewer go along', async () => {
  const game = fakeGame();
  const boxes = [];
  game.select_box = (viewer, x0, y0, x1, y1, ctrl, alt) => {
    boxes.push([viewer, ctrl, alt]);
    return Uint32Array.from(x1 < 170 ? [1, 2] : [3]);
  };
  const { input } = await makeInput({ game });
  input.setSelection([4]);
  await input.boxSelect({ x: 90, y: 90 }, { x: 150, y: 110 });
  assert.deepEqual(input.selection, [1, 2], 'replaces the selection');
  await input.boxSelect({ x: 190, y: 110 }, { x: 210, y: 130 }, { shift: true });
  assert.deepEqual(input.selection, [1, 2, 3], 'Shift adds (OpenRA: a box never takes actors out)');
  await input.boxSelect({ x: 190, y: 110 }, { x: 210, y: 130 }, { ctrl: true });
  await input.boxSelect({ x: 190, y: 110 }, { x: 210, y: 130 }, { alt: true });
  assert.deepEqual(boxes, [[0, false, false], [0, false, false], [0, true, false], [0, false, true]]);
  // A spectator watching everyone has no viewer (255): every player alike.
  const spec = await makeInput({ spectator: true, game });
  spec.input.watchAll = true;
  await spec.input.boxSelect({ x: 0, y: 0 }, { x: 10, y: 10 });
  assert.equal(boxes.at(-1)[0], 255);
});

test("a click selects the engine's pick; Shift toggles it in or out, any owner's; nothing clears", async () => {
  const game = fakeGame();
  const clicks = [];
  const pickAt = game.select_at;
  game.select_at = (viewer, x, y, ctrl, alt) => (clicks.push([viewer, ctrl, alt]), pickAt(viewer, x, y));
  const { input } = await makeInput({ game });
  await input.clickSelect({ x: 200, y: 120 }, false, 1000);
  assert.deepEqual(input.selection, [3]);
  await input.clickSelect({ x: 120, y: 160 }, true, 2000);
  assert.deepEqual(input.selection, [3, 7], "Shift adds, an enemy's too (OpenRA Combine)");
  await input.clickSelect({ x: 200, y: 120 }, true, 3000);
  assert.deepEqual(input.selection, [7], 'Shift on a selected one takes it out');
  await input.clickSelect({ x: 600, y: 600 }, true, 4000);
  assert.deepEqual(input.selection, [7], 'Shift on nothing changes nothing');
  await input.clickSelect({ x: 600, y: 600 }, false, 5000);
  assert.deepEqual(input.selection, [], 'a click on nothing clears');
  await input.clickSelect({ x: 300, y: 300 }, false, 6000, { alt: true });
  assert.deepEqual(clicks.at(-1), [0, false, true], 'Alt goes along');
  assert.deepEqual(input.selection, [6]);
});
