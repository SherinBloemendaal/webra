// The game setup a map carries (map format version 2, protocol mapsetup.js)
// in the skirmish lobby (js/lobby-state.js: applied when the map is
// installed, locks checked before the start) and in the map editor's Setup
// tab and actor properties (editor/js/setup.js, on a fake DOM).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, check, textOf, FakeEvent, FakeNode } from './dom-fixtures.mjs';
import { applyMapSetup, keepLockedOptions, mapSetupProblem, optionLockedBy, sanitizeState, slotLockedBy, startProblem } from '../js/lobby-state.js';
import { applyMapOptions, canonicalSlot, lockedOptionProblem, lockedSlotProblem } from '../js/protocol.js';
import { MapDoc } from '../editor/js/doc.js';
import { createMap, validateMap } from '../editor/js/mapformat.js';
import { OPTION_ROWS, actorStateView, optionsView, parseTags, setSlot, slotsView } from '../editor/js/setup.js';
import { Controller } from '../editor/js/controller.js';

const COLORS = 8;
const fresh = () => sanitizeState(null, COLORS, () => 42);
const setup = (players = [], options = {}, lockedOptions = []) => ({ players: players.map(canonicalSlot), options, lockedOptions, tags: [] });

// ---- Protocol lock checks ---------------------------------------------------------------

test('lock checks: slot parts and options, random factions allow their countries', () => {
  const s = setup([{ faction: 'randomsoviet', team: 2, color: 3, type: 'open', lock: ['faction', 'team', 'color'] }, { type: 'ai', lock: ['type'] }], { startingCash: 10000, fog: false }, ['startingCash']);
  assert.equal(lockedSlotProblem({ type: 'human', faction: 'russia', team: 2, color: 3 }, s, 0), null, 'a resolved random faction is fine');
  assert.match(lockedSlotProblem({ type: 'human', faction: 'england', team: 2, color: 3 }, s, 0), /faction of slot 1/);
  assert.match(lockedSlotProblem({ type: 'human', faction: 'russia', team: 1, color: 3 }, s, 0), /team 2/);
  assert.match(lockedSlotProblem({ type: 'human', faction: 'russia', team: 2, color: 4 }, s, 0), /colour of slot 1/);
  assert.equal(lockedSlotProblem({ type: 'closed' }, s, 0), null, 'a closed slot has no faction to lock');
  assert.match(lockedSlotProblem({ type: 'human', faction: 'random', team: 0, color: 0 }, s, 1), /gives slot 2 to an AI/);
  assert.equal(lockedSlotProblem({ type: 'ai', faction: 'random', team: 0, color: 0 }, s, 1), null);
  assert.equal(lockedSlotProblem({ type: 'human', faction: 'random', team: 0, color: 0 }, s, 5), null, 'slots the map does not list are free');
  assert.equal(lockedOptionProblem({ startingCash: 10000, fog: true }, s), null, 'unlocked options may change');
  assert.match(lockedOptionProblem({ startingCash: 5000 }, s), /locks startingCash/);
  assert.deepEqual(applyMapOptions({ startingCash: 5000, fog: true, crates: true }, s), { startingCash: 10000, fog: false, crates: true });
});

// ---- Skirmish lobby -----------------------------------------------------------------------

test('installing a map applies its slots and options; you move to a slot it leaves to players', () => {
  const state = fresh();
  state.mapSource = 'file';
  const s = setup(
    [
      { type: 'ai', difficulty: 'hard', bot: 'turtle', faction: 'russia', team: 2, lock: ['type'] },
      { type: 'open', faction: 'england', team: 1, color: 4, lock: ['faction', 'color'] },
      { type: 'closed', lock: ['type'] },
    ],
    { startingCash: 20000, techLevel: 'low', crates: false },
    ['techLevel'],
  );
  applyMapSetup(state, s, COLORS, 4);
  assert.equal(state.startingCash, 20000);
  assert.equal(state.crates, false);
  assert.deepEqual(state.players.map((p) => p.type), ['ai', 'human', 'closed']);
  assert.deepEqual([state.players[0].difficulty, state.players[0].bot, state.players[0].faction, state.players[0].team], ['hard', 'turtle', 'russia', 2]);
  assert.deepEqual([state.players[1].faction, state.players[1].team, state.players[1].color], ['england', 1, 4]);
  assert.equal(new Set(state.players.map((p) => p.color)).size, 3, 'colours stay distinct');
  const status = { spawns: 4, accepted: true, setup: s };
  assert.equal(startProblem(state, status), null);
  assert.equal(mapSetupProblem(state, s), null);
  // The locks.
  assert.equal(slotLockedBy(state, s, 1, 'faction'), true);
  assert.equal(slotLockedBy(state, s, 1, 'team'), false);
  assert.equal(optionLockedBy(state, s, 'techLevel'), true);
  state.players[1].faction = 'france';
  assert.match(startProblem(state, status), /faction of slot 2/);
  state.players[1].faction = 'england';
  state.techLevel = 'high';
  assert.match(startProblem(state, status), /locks techLevel/);
  keepLockedOptions(state, s);
  assert.equal(state.techLevel, 'low', 'a game mode never changes a locked option');
  state.players[2].type = 'ai';
  assert.match(startProblem(state, status), /keeps slot 3 closed/);
  // A random map: the file's locks do not apply.
  state.mapSource = 'random';
  assert.equal(optionLockedBy(state, s, 'techLevel'), false);
});

test('a map without a setup changes nothing; slots it lists are added', () => {
  const state = fresh();
  const before = structuredClone(state);
  applyMapSetup(state, setup(), COLORS, 2);
  assert.deepEqual(state, before);
  applyMapSetup(state, setup([{}, {}, { type: 'ai', difficulty: 'easy' }]), COLORS, 4);
  assert.equal(state.players.length, 3);
  assert.equal(state.players[2].difficulty, 'easy');
});

test('a map that gives every slot to an AI without locking one: you take an AI slot, never vanish', () => {
  const state = fresh();
  state.mapSource = 'file';
  const n = state.players.length;
  const s = setup(Array.from({ length: n }, (_, k) => ({ type: 'ai', ...(k > 0 ? { lock: ['type'] } : {}) })));
  applyMapSetup(state, s, COLORS, n);
  assert.equal(state.players.filter((p) => p.type === 'human').length, 1);
  assert.equal(state.players[0].type, 'human', 'the one slot the map does not lock to an AI');
  assert.equal(mapSetupProblem(state, s), null);
});

// ---- The map editor ----------------------------------------------------------------------

let doc;
beforeEach(() => {
  doc = installDom();
  globalThis.Node = FakeNode;
});
afterEach(() => {
  delete globalThis.Node;
  uninstallDom();
});

const newDoc = () => new MapDoc(createMap({ width: 40, height: 40, name: 'Setup', author: 'T' }));
/**
 * Choose the option labelled `label` in a select plate (js/ui/controls.js) as a
 * player does: open it, click the option. `plate` is its .ui-select-plate root;
 * the view it is in must be on the page (a list only opens there).
 */
const choose = (plate, label) => {
  if (!plate.isConnected) doc.body.append(plate.closest('.slots-view, .options-table, .actor-state') ?? plate);
  click(plate.querySelector('.ui-sp-button'));
  const option = plate.querySelectorAll('[role="option"]').find((o) => textOf(o.querySelector('.ui-sp-label')) === label);
  assert.ok(option, `option ${label}`);
  click(option);
};
const plates = (root) => root.querySelectorAll('.ui-select-plate');

test('Setup tab: slot rows per spawn, changes are undoable map edits, trailing default slots are dropped', () => {
  const m = newDoc();
  const view = slotsView(m, () => 'rgb(1,2,3)');
  const rows = view.querySelectorAll('.slot-row');
  assert.equal(rows.length, 2, 'one per spawn');
  // Named by their label and the slot, for the phone sheet and screen readers.
  assert.equal(rows[1].querySelector(`#${rows[1].querySelector('.ui-sp-button').getAttribute('aria-labelledby').split(' ')[0]}`).textContent, 'Player');
  choose(plates(rows[1])[0], 'AI');
  assert.deepEqual(m.toMap().players[1], { faction: 'random', team: 0, color: -1, type: 'ai', difficulty: 'normal', bot: 'normal', lock: [] });
  assert.deepEqual(m.toMap().players[0], canonicalSlot({}), 'earlier slots are filled with the defaults');
  const again = slotsView(m, () => '').querySelectorAll('.slot-row')[1];
  check(again.querySelectorAll('input')[0]);
  assert.deepEqual(m.toMap().players[1].lock, ['type']);
  assert.equal(m.undoStack.length, 2);
  m.undo();
  m.undo();
  assert.deepEqual(m.toMap().players, [], 'back to no slots');
  const meta = { players: [canonicalSlot({ team: 1 }), canonicalSlot({})] };
  setSlot(meta, 1, canonicalSlot({}));
  assert.equal(meta.players.length, 1);
  assert.ok(validateMap(m.toMap()).ok);
});

test('Setup tab: options set, locked and back to the lobby (which drops the lock)', () => {
  const m = newDoc();
  assert.equal(optionsView(m).querySelectorAll('tr').length, OPTION_ROWS.length);
  const row = () => optionsView(m).querySelector('[data-option="startingCash"]');
  assert.equal(row().querySelector('input').disabled, true, 'nothing to lock before a value is set');
  const cash = OPTION_ROWS.find((o) => o.key === 'startingCash').choices.find((c) => c.value === 10000).label;
  choose(row().querySelector('.ui-select-plate'), cash);
  assert.deepEqual(m.toMap().options, { startingCash: 10000 }, 'numbers stay numbers');
  check(row().querySelector('input'));
  assert.deepEqual(m.toMap().lockedOptions, ['startingCash']);
  const fog = optionsView(m).querySelector('[data-option="fog"] .ui-select-plate');
  choose(fog, 'Off');
  assert.equal(m.toMap().options.fog, false, 'booleans stay booleans');
  choose(row().querySelector('.ui-select-plate'), 'Lobby decides');
  assert.deepEqual(m.toMap().options, { fog: false });
  assert.deepEqual(m.toMap().lockedOptions, []);
  assert.ok(validateMap(m.toMap()).ok);
});

test('tags: comma separated, cleaned, at most 8', () => {
  assert.deepEqual(parseTags(' Naval, 2 Players ,,naval, Big!Map, -x-'), ['naval', '2 players', 'bigmap', 'x']);
  assert.equal(parseTags(Array.from({ length: 12 }, (_, i) => `t${i}`).join(',')).length, 8);
  assert.equal(parseTags('a'.repeat(40))[0].length, 24);
});

test('actor properties: health, stance, veterancy and passengers of the selection, one undo step each', () => {
  const m = newDoc();
  const catalog = {
    APC: { id: 'APC', name: 'APC', kind: 'vehicle', stance: true, levels: 4, cargo: { types: ['Infantry'], max: 5 }, footprint: null },
    E1: { id: 'E1', name: 'Rifle Infantry', kind: 'infantry', stance: true, levels: 4, passenger: { type: 'Infantry', weight: 1 }, footprint: null },
    POWR: { id: 'POWR', name: 'Power Plant', kind: 'building', stance: false, levels: 0, width: 2, height: 2, footprint: [[0, 0, 1]] },
  };
  m.begin('Place');
  m.touchObjects();
  m.actors.push({ type: 'APC', owner: 0, x: 10, y: 10, facing: 0 }, { type: 'POWR', owner: -1, x: 20, y: 20, facing: 0 });
  m.commit();
  const view = { camera: { zoom: 1 }, viewRect: () => ({ x0: 0, y0: 0, x1: 1, y1: 1 }) };
  const ctl = new Controller(m, view, catalog, {}, { status() {}, hover() {}, selectionChanged() {} });
  ctl.selection.add(m.actors[0]);
  let box = actorStateView([...ctl.selection], catalog, ctl);
  assert.equal(box.querySelectorAll('input[type="range"]').length, 2, 'health and veterancy');
  const [health, vet] = box.querySelectorAll('input[type="range"]');
  health.value = '40';
  health.dispatchEvent(new FakeEvent('input'));
  health.value = '35';
  health.dispatchEvent(new FakeEvent('input'));
  vet.value = '2';
  vet.dispatchEvent(new FakeEvent('input'));
  choose(box.querySelector('#actor-stance-root'), 'Hold fire');
  box = actorStateView([...ctl.selection], catalog, ctl);
  doc.body.replaceChildren(box);
  choose(box.querySelector('#cargo-pick-root'), 'Rifle Infantry (1)');
  click([...box.querySelectorAll('button')].find((b) => textOf(b) === 'Add'));
  const a = m.toMap().actors[0];
  assert.deepEqual([a.health, a.veterancy, a.stance, a.cargo], [35, 2, 'hold_fire', ['E1']]);
  assert.equal(m.undoStack.filter((e) => e.label === 'Change health').length, 1, 'dragging is one step');
  assert.ok(validateMap(m.toMap()).ok, validateMap(m.toMap()).errors.join('; '));
  // A structure has no stance or levels; full health is left out of the file.
  ctl.selection.clear();
  ctl.selection.add(m.actors[1]);
  box = actorStateView([...ctl.selection], catalog, ctl);
  assert.equal(box.querySelector('#actor-stance-root'), null);
  assert.equal(box.querySelectorAll('input[type="range"]').length, 1);
  assert.deepEqual(Object.keys(m.toMap().actors[1]), ['type', 'owner', 'x', 'y', 'facing']);
});
