// js/input.js order generators and the mouse and keyboard state around them:
// what ends what (placement, support powers, sidebar modes, attack move,
// teleport targeting), drags and pans whose button came up where the page
// did not see it, the middle button pan with the wheel, Esc held down, and
// modifiers whose keyup was missed. A fake game, no browser.
//   node --test apps/game/tests/input-orders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { createSettings as settingsOver } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';

const NONE = 0xffffffff;
const createSettings = () => settingsOver(createRegistry({ storage: null }));

/** Actors by id: { owner, type, building }. */
const WORLD = {
  1: { owner: 0, type: '1TNK' },
  2: { owner: 0, type: 'CTNK' },
  9: { owner: 1, type: 'E1' },
};

function fakeGame() {
  let selection = [];
  return {
    map_width: () => 128,
    map_height: () => 128,
    pick: () => NONE,
    select_at: () => NONE,
    select_box: () => new Uint32Array(0),
    actor_json: (id) => (WORLD[id] ? JSON.stringify({ id, type: WORLD[id].type, owner: WORLD[id].owner, building: !!WORLD[id].building, carrier: NONE }) : 'null'),
    set_selection: (ids) => (selection = Array.from(ids)),
    selection: () => Uint32Array.from(selection),
    deploy_state: () => 0,
    cursor_action: () => 0,
    // The chrono tank (2) teleports when deployed.
    deploy_targets: (_p, ids) => ({ teleport: Uint32Array.from(Array.from(ids).filter((id) => id === 2)), deploy: new Uint32Array(0) }),
  };
}

/** The input on an 800 x 600 view, camera at (1000, 1000), zoom 1. */
async function makeInput() {
  const listeners = new Map();
  globalThis.window ??= {};
  Object.assign(globalThis.window, {
    innerWidth: 1000,
    innerHeight: 600,
    addEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).concat(fn)),
    removeEventListener() {},
  });
  const { Input } = await import('../js/input.js');
  const canvas = { clientWidth: 800, clientHeight: 600, style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const settings = createSettings();
  const hotkeys = new HotkeyRegistry(settings);
  const log = { cancelPlace: 0, menu: 0, modes: [] };
  const hooks = {
    onSelectionChanged() {},
    onCancelPlace: () => log.cancelPlace++,
    onPlaced() {},
    onPowerTargeting() {},
    onMode: (m) => log.modes.push(m),
    onMenu: () => log.menu++,
  };
  const input = new Input(canvas, fakeGame(), { actors: [{ id: 50, width: 2, height: 2 }] }, 0, hooks, { hotkeys, settings });
  input.camera.zoom = 1;
  input.camera.x = 1000;
  input.camera.y = 1000;
  const fire = (type, e) => (listeners.get(type) ?? []).forEach((fn) => fn(e));
  const key = (code, k, extra = {}) =>
    hotkeys.handle({ type: 'keydown', code, key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {}, ...extra });
  const keydown = (k, extra = {}) => input.onKeyDown({ type: 'keydown', key: k, code: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {}, ...extra });
  return { input, hotkeys, log, fire, key, keydown };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('support power targeting while placing a structure ends the placement through cancelPlacing (sidebar, touch)', async () => {
  const { input, log } = await makeInput();
  input.startPlacing(50);
  input.startPowerTargeting({ key: 'spy', name: 'Spy plane', kind: 'SpyPlanePower' });
  assert.equal(input.placing, null);
  assert.equal(log.cancelPlace, 1, 'onCancelPlace once: the sidebar card and the build drawer leave placement');
  assert.deepEqual(input.power, { key: 'spy', name: 'Spy plane' });
  // Not placing: nothing to cancel.
  input.cancelPower();
  input.startPowerTargeting({ key: 'spy', name: 'Spy plane', kind: 'SpyPlanePower' });
  assert.equal(log.cancelPlace, 1);
});

test('attack move replaces placement, a support power, targeting and a sidebar mode', async () => {
  const { input, key, log } = await makeInput();
  input.setSelection([1]);
  input.startPlacing(50);
  key('KeyA', 'a');
  assert.equal(input.attackMove, true);
  assert.equal(input.placing, null, 'the next click is no placement');
  assert.equal(log.cancelPlace, 1);
  input.attackMove = false;
  input.startPowerTargeting({ key: 'spy', name: 'Spy plane', kind: 'SpyPlanePower' });
  key('KeyA', 'a');
  assert.equal(input.power, null);
  assert.equal(input.attackMove, true);
  input.attackMove = false;
  input.setMode('sell');
  key('KeyA', 'a');
  assert.equal(input.mode, null);
  assert.equal(input.attackMove, true);
  // Nothing selected: the key changes nothing.
  input.attackMove = false;
  input.setMode('sell');
  input.setSelection([]);
  key('KeyA', 'a');
  assert.equal(input.mode, 'sell');
  assert.equal(input.attackMove, false);
});

test('chrono tank teleport targeting replaces placement and a sidebar mode', async () => {
  const { input } = await makeInput();
  input.setSelection([2]);
  input.setMode('sell');
  await input.deploySelection();
  assert.equal(input.mode, null, 'sell mode ended');
  assert.deepEqual(input.targeting, { kind: 'teleport', ids: [2] });
  input.cancelTargeting();
  input.startPlacing(50);
  await input.deploySelection();
  assert.equal(input.placing, null);
  assert.equal(input.targeting.kind, 'teleport');
});
