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

/** A mouse event at view point (x, y): real and virtual ones carry `buttons` and the modifier flags. */
const mouse = (type, x, y, extra = {}) => ({ type, clientX: x, clientY: y, button: 0, buttons: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {}, ...extra });
/** js/touch.js's fake event: no type, no buttons. */
const touchFake = (x, y) => ({ button: 0, clientX: x, clientY: y, pointerType: 'touch', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });

test('a button that came up outside the page: a window blur or a move without it ends the box and the pan', async () => {
  const { input, fire } = await makeInput();
  // Box selection, then the focus leaves with the button down (alt-tab): no box follows the mouse afterwards.
  input.onMouseDown(mouse('mousedown', 100, 100, { buttons: 1 }));
  input.onMouseMove(mouse('mousemove', 200, 150, { buttons: 1 }));
  assert.ok(input.drag, 'a held button keeps the box');
  fire('blur', {});
  assert.equal(input.drag, null);
  // Middle button pan, released over another window: the next move has no middle button.
  input.onMouseDown(mouse('mousedown', 300, 300, { button: 1, buttons: 4 }));
  input.onMouseMove(mouse('mousemove', 310, 300, { buttons: 4 }));
  assert.ok(input.pan);
  const cam = { ...input.camera };
  input.onMouseMove(mouse('mousemove', 400, 300, { buttons: 0 }));
  assert.equal(input.pan, null);
  assert.equal(input.camera.x, cam.x, 'the camera no longer follows the mouse');
  // A box whose left button came up outside: dropped, no selection on the next mouseup.
  input.onMouseDown(mouse('mousedown', 100, 100, { buttons: 1 }));
  input.onMouseMove(mouse('mousemove', 300, 300, { buttons: 0 }));
  assert.equal(input.drag, null);
  // A pan with the left button still held in the move keeps the pan only while the middle one is down too.
  input.onMouseDown(mouse('mousedown', 300, 300, { button: 1, buttons: 4 }));
  input.onMouseMove(mouse('mousemove', 320, 300, { buttons: 5 }));
  assert.ok(input.pan);
  input.onMouseUp(mouse('mouseup', 320, 300, { button: 1 }));
  // A sell box: the mouseup itself (buttons 0) still commits it.
  input.setMode('sell');
  let boxes = 0;
  input.boxSell = () => boxes++;
  input.onMouseDown(mouse('mousedown', 100, 100, { buttons: 1 }));
  input.onMouseMove(mouse('mousemove', 200, 200, { buttons: 1 }));
  input.onMouseUp(mouse('mouseup', 200, 200));
  assert.equal(boxes, 1);
  input.setMode(null);
});

test("the touch controls' fake events carry no buttons: their box drag goes on", async () => {
  const { input } = await makeInput();
  input.onMouseMove(touchFake(100, 100));
  input.onMouseDown(touchFake(100, 100));
  input.onMouseMove(touchFake(250, 200));
  assert.ok(input.drag);
  assert.deepEqual([input.drag.ex, input.drag.ey], [250, 200]);
});

test('a missed modifier keyup: the next mouse event says the key is up, and the cursor follows', async () => {
  const { input, keydown } = await makeInput();
  keydown('Control', { ctrlKey: true });
  assert.equal(input.heldMods().ctrl, true);
  // The keyup went to an OS shortcut: the next move has ctrlKey false.
  input.onMouseMove(mouse('mousemove', 100, 100));
  assert.equal(input.heldMods().ctrl, false);
  keydown('Shift', { shiftKey: true });
  input.onMouseDown(mouse('mousedown', 100, 100, { button: 2, buttons: 2 }));
  assert.equal(input.heldMods().shift, false, 'a press syncs them too');
  // Held keys the event reports are added (Cmd counts as Ctrl).
  input.onMouseMove(mouse('mousemove', 100, 100, { metaKey: true, altKey: true }));
  assert.deepEqual(input.heldMods(), { ctrl: true, alt: true, shift: false });
  // A touch fake says nothing about the keyboard.
  input.onMouseMove(touchFake(100, 100));
  assert.deepEqual(input.heldMods(), { ctrl: true, alt: true, shift: false });
});

test('the wheel, zoom keys and jumps during a middle button pan: the pan goes on from the new view, no jump', async () => {
  const { input, key } = await makeInput();
  const wheel = (x, y, deltaY) => input.onWheel({ clientX: x, clientY: y, deltaY, preventDefault() {} });
  input.onMouseMove(mouse('mousemove', 400, 300));
  input.onMouseDown(mouse('mousedown', 400, 300, { button: 1, buttons: 4 }));
  wheel(400, 300, -200);
  const zoomedAt = input.toWorld(400, 300);
  // One pixel to the right: the world point under the cursor moves by one pixel's worth, not by the whole zoom step.
  input.onMouseMove(mouse('mousemove', 401, 300, { buttons: 4 }));
  const after = input.toWorld(401, 300);
  assert.ok(Math.abs(after.x - zoomedAt.x) < 1 && Math.abs(after.y - zoomedAt.y) < 1, `${JSON.stringify(zoomedAt)} -> ${JSON.stringify(after)}`);
  // The zoom key, then a move: the view stays where the key put it, plus the move.
  const zoom = input.camera.zoom;
  key('BracketRight', ']');
  assert.ok(input.camera.zoom > zoom, 'zoomed in');
  const camera = { x: input.camera.x, y: input.camera.y };
  input.onMouseMove(mouse('mousemove', 401, 300, { buttons: 4 }));
  assert.deepEqual({ x: input.camera.x, y: input.camera.y }, camera);
  // A jump to the map's left edge sticks too.
  input.jumpToEdge(-1, 0);
  const edge = input.camera.x;
  input.onMouseMove(mouse('mousemove', 401, 300, { buttons: 4 }));
  assert.equal(input.camera.x, edge);
  // The pan itself still drags the view.
  input.onMouseMove(mouse('mousemove', 381, 300, { buttons: 4 }));
  assert.ok(input.camera.x > edge);
});

test('Esc held down: the first press opens the menu (or cancels), its key repeats do nothing', async () => {
  const { input, log, keydown } = await makeInput();
  let prevented = 0;
  keydown('Escape');
  assert.equal(log.menu, 1);
  for (let i = 0; i < 5; i++) keydown('Escape', { repeat: true, preventDefault: () => prevented++ });
  assert.equal(log.menu, 1, 'no menu per repeat');
  assert.equal(prevented, 5, 'the repeats are still kept from the browser');
  // A mode: the first Esc ends it, the repeats do not go on to the menu.
  input.setMode('sell');
  keydown('Escape');
  keydown('Escape', { repeat: true });
  assert.equal(input.mode, null);
  assert.equal(log.menu, 1);
});
