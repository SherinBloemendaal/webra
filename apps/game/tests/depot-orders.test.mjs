// Ore trucks and the service depot through the real Input over a fake game:
// a damaged truck over the own depot gets the repair cursor and the click
// orders it there; an undamaged one gets the enter-blocked cursor and the
// click neither selects the depot nor gets a reply (OpenRA
// EnterAlliedActorTargeter, Repairable). No browser and no WebAssembly.
// Run with: node --test apps/game/tests/depot-orders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION, CURSORS } from '../js/cursors.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { createSettings as settingsOver } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';
import { Director } from '../js/audio/director.js';

const NONE = 0xffffffff;
const createSettings = () => settingsOver(createRegistry({ storage: null }));

/** The truck (1) and the own service depot (2). */
const WORLD = {
  1: { owner: 0, type: 'HARV', x: 100, y: 100 },
  2: { owner: 0, type: 'FIX', x: 300, y: 300, building: true },
};

/** A fake game whose smart order over the depot is `action` (engine smart_action). */
function fakeGame(action) {
  const near = (x, y) => Object.entries(WORLD).find(([, a]) => Math.hypot(a.x - x, a.y - y) < 30)?.[0];
  const orders = [];
  let selection = [];
  return {
    orders,
    map_width: () => 64,
    map_height: () => 64,
    player_count: () => 2,
    pick: (_p, x, y) => Number(near(x, y) ?? NONE),
    select_at: (_p, x, y) => Number(near(x, y) ?? NONE),
    actor_json: (id) => (WORLD[id] ? JSON.stringify({ id, type: WORLD[id].type, owner: WORLD[id].owner, building: !!WORLD[id].building, carrier: NONE }) : 'null'),
    deploy_state: () => 0,
    cursor_action: (_p, ids, x, y) => (near(x, y) === '2' ? action : ACTION.MOVE),
    order_smart: (_p, ids, x, y) => orders.push({ ids: Array.from(ids), x, y }),
    set_selection: (ids) => (selection = Array.from(ids)),
    selection: () => Uint32Array.from(selection),
  };
}

async function makeInput(action) {
  globalThis.window ??= { addEventListener() {} };
  const { Input } = await import('../js/input.js');
  const canvas = { clientWidth: 800, clientHeight: 600, style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const smart = [];
  const game = fakeGame(action);
  const hooks = { onSmartOrder: (a) => smart.push(a), onSelectionChanged() {} };
  const input = new Input(canvas, game, { actors: [] }, 0, hooks, { hotkeys: new HotkeyRegistry(createSettings()), settings: createSettings() });
  input.camera.zoom = 1;
  input.camera.x = 0;
  input.camera.y = 0;
  input.setSelection([1]);
  return { input, game, smart };
}

const DEPOT = { x: 300, y: 300 };

test('a damaged ore truck over the own service depot: the repair cursor, and the click orders it there', async () => {
  const { input, game, smart } = await makeInput(ACTION.REPAIR);
  assert.equal(input.cursorAt(DEPOT, {}), CURSORS.repair);
  assert.equal(await input.finishClick(DEPOT, {}), true);
  assert.deepEqual(game.orders, [{ ids: [1], x: DEPOT.x, y: DEPOT.y }]);
  assert.deepEqual(smart, [ACTION.REPAIR]);
  assert.deepEqual(input.selection, [1], 'the truck stays selected');
});

test('an undamaged ore truck over the own service depot: the blocked cursor, and the click does not select the depot', async () => {
  const { input, smart } = await makeInput(ACTION.ENTER_BLOCKED);
  assert.equal(input.cursorAt(DEPOT, {}), CURSORS.enterBlocked);
  await input.finishClick(DEPOT, {});
  assert.deepEqual(input.selection, [1], 'the truck stays selected, the depot is not');
  assert.deepEqual(smart, [ACTION.ENTER_BLOCKED], 'the ignored order goes to the engine, as OpenRA issues it');
});

test('units do not reply to an order they ignore (OpenRA IOrderVoice: no voice)', () => {
  const voices = [];
  let t = 0;
  const actors = [{ id: 'HARV', kind: 'vehicle' }];
  const d = new Director({
    rules: { actors, weapons: [] },
    player: 0,
    side: 'soviet',
    pxPerWorld: 1,
    lookup: () => ({ type: 'HARV', owner: 0, building: false }),
    sink: { effect() {}, voice: (v) => voices.push(v), announce() {} },
    now: () => t,
  });
  for (const blocked of [ACTION.ENTER_BLOCKED, ACTION.REPAIR_BLOCKED]) {
    d.noteSmartAction(blocked);
    d.onOrder([1], 'order_smart');
    t += 1;
  }
  assert.equal(voices.length, 0, 'no reply to blocked orders');
  d.noteSmartAction(ACTION.REPAIR);
  d.onOrder([1], 'order_smart');
  assert.equal(voices.length, 1, 'a repair order gets its reply');
});
